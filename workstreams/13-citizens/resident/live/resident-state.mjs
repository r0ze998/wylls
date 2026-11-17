// The resident's own stop and its already-submitted keys, READ ONLY from its files (2026-11-17), so the live step
// (step.mjs) gets them from the resident instead of from its caller's hands.
//
// It never constructs a Resident (the constructor may make a key, create the ledger record, switch the mode and save),
// never writes, never reads a private key (the resident's key file is not opened), and does nothing at import. Reads, through the
// injected `fs` = {readText(path) → string (throws when absent or unreadable), exists(path) → boolean}:
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
// Which world those keys were submitted to is NOT recorded in the resident's files (no world, clock or execution
// port identity is persisted; the test harness's MOCK_WORLD keys look the same). So they are returned as `held`, with
// that reason, and the live step reads none of them against the live execution port. Connecting them needs the
// resident to record its world at join (a change to resident.mjs, not made here).

export const STATE_VERSION = 2;   // resident.mjs STATE_VERSION (pinned by the regression)
const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);

function readJson(fs, p) {
  let t;
  try { t = fs.readText(p); } catch (e) { return { why: `${p.split('/').pop()}: not readable (${String(e?.code ?? e?.message ?? e).slice(0, 40)})` }; }
  try { return { json: JSON.parse(t) }; } catch { return { why: `${p.split('/').pop()}: not JSON` }; }
}

/**
 * → {stop: {why, keepPromises?} (never null when anything is unknown), submitted: {keys: [], held: [...], why}, unsent, facts}
 *   `wallet`: the live wallet the resident acts with; its ledger record's agentKey must be it.
 */
export function readResidentState({ dir, wallet, fs, join = (a, b) => `${a.replace(/\/+$/, '')}/${b}` }) {
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
  const charterOwner = ch.owner?.address ?? null;
  if (charterOwner !== null && rec.owner !== charterOwner) return unknown('the owner in the charter and in the ledger differ');
  let halted;
  try { halted = fs.exists(ch.haltFile) === true; } catch { return unknown('the halt file could not be checked'); }
  const facts = Object.freeze({ id: ch.id, turn: st.turn, maxTurns: ch.limits.maxTurns, mode: rec.mode ?? null, revoked: Boolean(rec.policy?.revoked), halted });
  const stop = facts.revoked ? { why: 'authority-revoked' }
    : facts.halted ? { why: 'halted-by-operator' }
    : facts.mode !== 'auto' ? { why: 'stopped-by-owner' }
    : facts.turn >= facts.maxTurns ? { why: 'max-turns', keepPromises: true }
    : null;
  const lines = Object.values(st.journal).filter(isObj);
  const action = lines.filter(j => j.port === 'action');
  const mayHaveLeft = action.filter(j => typeof j.sendKey === 'string' && j.sendKey && (['sent', 'unresolved'].includes(j.state) || (j.state === 'intended' && j.lastError === 'Transport')));
  const unsent = action.filter(j => j.state === 'intended' && !(j.lastError === 'Transport' && j.sendKey)).map(j => j.key);
  const held = mayHaveLeft.map(j => Object.freeze({ key: j.sendKey, line: j.key, state: j.state, submittedBell: Number.isInteger(j.submittedBell) ? j.submittedBell : null }));
  return {
    stop,
    submitted: { keys: [], held: Object.freeze(held), why: held.length ? "the resident's files do not record which world these keys were submitted to (no world, clock or execution port is persisted), so none is read against the live execution port" : 'no submitted key may still be open' },
    unsent: Object.freeze(unsent),
    facts,
  };
}
