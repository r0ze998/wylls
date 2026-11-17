// The resident's own stop and its already-submitted keys, READ ONLY from its files (2026-11-17), so the live step
// (step.mjs) gets them from the resident instead of from its caller's hands.
//
// It never constructs a Resident (the constructor may make a key, create the ledger record, switch the mode and save),
// never writes, never reads a private key (the resident's key file is not opened), and does nothing at import. Reads, through the
// injected `fs` = {readText(path) → string (throws when absent or unreadable), exists(path) → true (present), false
// (certainly absent), and throws when it cannot tell}; any other answer is taken as not known:
//   charter.json   resident.mjs createCharter: {v: 1, id, owner, limits.maxTurns, haltFile, …}
//   state.json     resident.mjs + the agent ledger in ONE file (createStateStore):
//                  {v: STATE_VERSION, turn, journal: {key: line}, …, agentWallet: {agents: {[id]: {mode, policy, agentKey, owner, …}}}}
//   the halt file  charter.haltFile (its existence only)
//
// The stop, in resident.mjs #stopReason's order and meaning:
//   1 the ledger's policy.revoked     'authority-revoked'   (strongest; nothing is sent again)
//   2 the halt file exists            'halted-by-operator'  (a pause; results are still read)
//   3 the ledger's mode is not 'auto' 'stopped-by-owner'    (a pause)
//   4 turn >= limits.maxTurns         'max-turns'           (no new decision; the resident keeps promises by code, which
//                                                            the live path cannot do: enacting is not connected)
// Anything that cannot be read or does not fit (a missing or unparsable file, another state version, no ledger record,
// an agent key that is not the live wallet, an owner that differs between charter and ledger, a relative halt path
// whose meaning depends on the working directory) is `state-unknown`: a stop, never taken as 'auto'.
//
// The submitted keys: journal lines on the `action` port that may have reached the execution port —
//   state 'sent' or 'unresolved' with a sendKey (#run sets sendKey with or after the submit; #reconcile reads them), and
//   state 'intended' with lastError 'Transport' and a sendKey (a lost reply: #applyRevocation treats it as sent).
// Board lines (posted records) are not sends; an 'intended' line without a sendKey was never submitted (counted apart,
// never as sent). Final lines (landed, failed, cancelled, revoked, …) need no reading.
//
// (2026-11-17) Which world, clock, execution port and identity a key belongs to: resident.mjs now records it on each
// NEW journal line at creation (`provenance` {v: 1, world: {cluster, world_id}, clock (frame.mjs clockId), execution:
// {registry, agentId, kind}|null, identity}). A key is returned for reading ONLY when its line's provenance matches the
// live frame on every point: a ws08 world (world_id not null: the test harness's MOCK_WORLD never matches), the same
// cluster and world_id, the same clock id, the same declared registry and agent id (a `kind` label alone is never
// taken as the same registry), and the live wallet. A line made before this record (no provenance), a malformed one,
// or one that differs anywhere is held, with why; nothing is inferred or upgraded after the fact.

export const STATE_VERSION = 2;   // resident.mjs STATE_VERSION (pinned by the regression)
const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);

const str = v => (typeof v === 'string' && v ? v : null);

/**
 * null when a journal line's provenance (resident.mjs #provenance) matches the live frame
 * `live` = {world: {cluster, world_id}, clock: clockId string, execution: {registry, agentId, kind?}} on every point,
 * else why it does not (never a guess).
 */
export function provenanceMismatch(p, live, wallet) {
  if (!p) return 'no provenance recorded (a line made before it was recorded)';
  if (p.v !== 1 || !isObj(p)) return 'the provenance is not one this reader knows';
  if (!live || !isObj(live.world) || !str(live.world.world_id) || !str(live.world.cluster)) return 'the live world is not known';
  if (!str(live.clock)) return 'the live clock is not known';
  if (!isObj(live.execution) || !str(live.execution.registry) || !str(live.execution.agentId)) return 'the live execution port declares no registry and agent id';
  if (!isObj(p.world) || !str(p.world.world_id)) return 'recorded in no ws08 world (the test world, or none)';
  if (p.world.cluster !== live.world.cluster || p.world.world_id !== live.world.world_id) return 'recorded in another world';
  if (!str(p.clock) || p.clock !== live.clock) return 'recorded on another clock (or none)';
  if (!isObj(p.execution) || !str(p.execution.registry) || !str(p.execution.agentId)) return 'recorded with no declared execution registry';
  if (p.execution.registry !== live.execution.registry || p.execution.agentId !== live.execution.agentId) return 'recorded for another execution registry or agent';
  if (str(p.execution.kind) && str(live.execution.kind) && p.execution.kind !== live.execution.kind) return 'recorded for another kind of execution port';
  if (typeof wallet !== 'string' || p.identity !== wallet) return 'recorded under another identity';
  return null;
}

/**
 * (2026-11-17) Whether a recorded provenance is complete enough that only the live frame could decide it: a ws08
 * world, a clock, a declared registry and agent, an identity. Such a key is worth one world read; any other is held
 * without one.
 */
export function provenanceComplete(p) {
  return isObj(p) && p.v === 1 && isObj(p.world) && !!str(p.world.world_id) && !!str(p.world.cluster) && !!str(p.clock)
    && isObj(p.execution) && !!str(p.execution.registry) && !!str(p.execution.agentId) && !!str(p.identity);
}

function readJson(fs, p) {
  let t;
  try { t = fs.readText(p); } catch (e) { return { why: `${p.split('/').pop()}: not readable (${String(e?.code ?? e?.message ?? e).slice(0, 40)})` }; }
  try { return { json: JSON.parse(t) }; } catch { return { why: `${p.split('/').pop()}: not JSON` }; }
}

/**
 * → {stop: {why, keepPromises?} (never null when anything is unknown), submitted: {keys: [], held: [...], why}, unsent, facts}
 *   `wallet`: the live wallet the resident acts with; its ledger record's agentKey must be it.
 */
export function readResidentState({ dir, wallet, fs, live = null, join = (a, b) => `${a.replace(/\/+$/, '')}/${b}` }) {
  const unknown = why => ({ stop: { why: 'state-unknown', detail: why }, submitted: { keys: [], held: [], why: `the resident's state is not known: ${why}` }, unsent: null, facts: null });
  if (typeof dir !== 'string' || !dir.startsWith('/')) return unknown('the resident directory is not an absolute path');
  if (!fs || typeof fs.readText !== 'function' || typeof fs.exists !== 'function') return unknown('no file reader supplied');
  const c = readJson(fs, join(dir, 'charter.json'));
  if (c.why) return unknown(c.why);
  const ch = c.json;
  if (ch?.v !== 1 || typeof ch.id !== 'string' || !ch.id || !Number.isSafeInteger(ch.limits?.maxTurns) || typeof ch.haltFile !== 'string') return unknown('charter.json is not a resident charter (v, id, limits.maxTurns, haltFile)');
  if (!ch.haltFile.startsWith('/')) return unknown('the halt file path is relative: whether it exists depends on the working directory');
  const s = readJson(fs, join(dir, 'state.json'));
  if (s.why) return unknown(s.why);
  const st = s.json;
  if (st?.v !== STATE_VERSION) return unknown(`state.json version ${st?.v ?? '?'} is not ${STATE_VERSION} (an older state is migrated only by the resident itself)`);
  if (!Number.isSafeInteger(st.turn) || !isObj(st.journal)) return unknown('state.json has no turn or journal');
  const rec = st.agentWallet?.agents?.[ch.id];
  if (!isObj(rec)) return unknown('no ledger record for this resident in state.json');
  if (typeof wallet !== 'string' || rec.agentKey !== wallet) return unknown("the ledger's agent key is not the live wallet");
  // (2026-11-17) the owner must be known and the same in both: the resident makes its ledger record with
  // owner = charter.owner.address (resident.mjs). A missing or different owner is not known, not "no owner".
  const charterOwner = typeof ch.owner?.address === 'string' && ch.owner.address ? ch.owner.address : null;
  if (charterOwner === null) return unknown('the charter names no owner address');
  if (rec.owner !== charterOwner) return unknown('the owner in the charter and in the ledger differ');
  // (2026-11-17) the policy as the agent ledger keeps it (ledger.mjs create/setPolicy: {…, version ≥ 1}): `revoked`
  // is absent in a normal policy (not revoked) and a boolean when set; no policy, no version or a revoked that is not
  // a boolean is not known, never "not revoked"
  const pol = rec.policy;
  if (!isObj(pol) || !Number.isSafeInteger(pol.version) || pol.version < 1) return unknown('the ledger policy is missing or has no version');
  if (pol.revoked !== undefined && typeof pol.revoked !== 'boolean') return unknown('the ledger policy says revoked in a form that is not a yes or no');
  // (2026-11-17) the halt file: present (true), certainly absent (false), anything else not known
  let halted;
  try { halted = fs.exists(ch.haltFile); } catch { return unknown('the halt file could not be checked'); }
  if (halted !== true && halted !== false) return unknown('the halt file check gave no yes or no');
  const facts = Object.freeze({ id: ch.id, turn: st.turn, maxTurns: ch.limits.maxTurns, mode: typeof rec.mode === 'string' ? rec.mode : null, revoked: pol.revoked === true, halted });
  const stop = facts.revoked ? { why: 'authority-revoked' }
    : facts.halted ? { why: 'halted-by-operator' }
    : facts.mode !== 'auto' ? { why: 'stopped-by-owner' }
    : facts.turn >= facts.maxTurns ? { why: 'max-turns', keepPromises: true }
    : null;
  const lines = Object.values(st.journal).filter(isObj);
  const action = lines.filter(j => j.port === 'action');
  const mayHaveLeft = action.filter(j => typeof j.sendKey === 'string' && j.sendKey && (['sent', 'unresolved'].includes(j.state) || (j.state === 'intended' && j.lastError === 'Transport')));
  const unsent = action.filter(j => j.state === 'intended' && !(j.lastError === 'Transport' && j.sendKey)).map(j => j.key);
  const keys = [], held = [];
  for (const j of mayHaveLeft) {
    const why = provenanceMismatch(j.provenance, live, wallet);
    if (why) held.push(Object.freeze({ key: j.sendKey, line: j.key, state: j.state, submittedBell: Number.isInteger(j.submittedBell) ? j.submittedBell : null, why,
      needsLive: !live && provenanceComplete(j.provenance) && j.provenance.identity === wallet }));
    else keys.push(j.sendKey);
  }
  return {
    stop,
    submitted: { keys: Object.freeze(keys), held: Object.freeze(held), why: held.length ? 'keys whose recorded world, clock, execution port or identity does not match the live one (or is not recorded) are not read' : keys.length ? 'every key matches the live frame' : 'no submitted key may still be open' },
    unsent: Object.freeze(unsent),
    facts,
  };
}
