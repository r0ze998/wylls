// A new operator resident's directory content, STOPPED from the start, from explicit public values only (2026-11-17).
// The live path (step.mjs, once.mjs) needs a resident directory; until now one could be made only by constructing a
// Resident, whose constructor may make a key, creates the ledger record, switches it to 'auto' and saves.
//
//   initialResident(…)       pure: the charter (resident.mjs charterOf, the same object createCharter writes) and the
//                            state (resident.mjs initialStateOf + the agent ledger's own record, made by AgentLedger
//                            create on an in-memory store: its saved format, mode 'manual', policy {allowed: [], budget,
//                            version 1}, no balance). Never setMode('auto'), never a key, never a file.
//   writeInitialResident(…)  the explicit save: a NEW directory (never an existing one, never through a link), the two
//                            files created exclusively, written whole, synced. A failure stops there and says where;
//                            nothing is removed (an incomplete directory reads as state-unknown, a stop).
// What it never does: read or make a private key, choose a wallet, owner or funder, fund, authorize, switch to auto,
// join, connect to a world, sign or send. Nothing runs at import.
//
// After it: readResidentState(dir, wallet) says `stopped-by-owner` (mode 'manual'), and runOnce({heraldUrl, wallet,
// residentDir}) gives `outcome: 'stopped'` with no submitted key. Leaving the stop is the owner's signed mode command
// (the agent wallet's owner commands), not offered here.
import { mkdirSync, openSync, writeSync, fsyncSync, closeSync, lstatSync } from 'node:fs';
import path from 'node:path';
import { AgentLedger } from '../../../../permutation-gateway/src/frontier/agent/ledger.mjs';
import { charterOf, initialStateOf, DEFAULT_LIMITS, DEFAULT_BUDGET } from '../resident.mjs';
import { GOALS } from '../goals.mjs';
import { AGENT_ID_MAX } from '../ports/ws04-acts.mjs';

const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const text = (v, n = 64) => typeof v === 'string' && v.trim().length > 0 && v.length <= n;
const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
const DECIMAL = /^(0|[1-9][0-9]*)$/;

/** (2026-11-17) The given limits, budget and siblings, in the charter's own forms; anything else is refused, never coerced. */
function overrideProblems(i) {
  const missing = [];
  if (i.limits !== undefined) {
    if (!isObj(i.limits)) missing.push({ field: 'limits', why: 'an object of the resident\'s limits, or absent' });
    else for (const [k, v] of Object.entries(i.limits)) {
      if (!Object.hasOwn(DEFAULT_LIMITS, k)) missing.push({ field: `limits.${k}`, why: 'not one of the resident\'s limits' });
      else if (!Number.isSafeInteger(v) || v <= 0) missing.push({ field: `limits.${k}`, why: 'a positive whole number' });
    }
  }
  if (i.budget !== undefined) {
    if (!isObj(i.budget)) missing.push({ field: 'budget', why: 'an object of the resident\'s budget, or absent' });
    else for (const [k, v] of Object.entries(i.budget)) {
      if (!Object.hasOwn(DEFAULT_BUDGET, k)) missing.push({ field: `budget.${k}`, why: 'not one of the resident\'s budget fields' });
      else if (k === 'callsPerDay' ? !(Number.isSafeInteger(v) && v >= 0) : !(typeof v === 'string' && DECIMAL.test(v))) missing.push({ field: `budget.${k}`, why: k === 'callsPerDay' ? 'a whole number' : 'a decimal string (base units)' });
    }
  }
  if (i.siblings !== undefined && (!Array.isArray(i.siblings) || i.siblings.length > 16 || !i.siblings.every(a => typeof a === 'string' && B58.test(a)))) missing.push({ field: 'siblings', why: 'up to 16 public addresses (base58), or absent' });
  for (const k of Object.keys(i)) if (!['dir', 'id', 'name', 'goal', 'owner', 'funder', 'wallet', 'createdAtMs', 'limits', 'budget', 'siblings'].includes(k)) missing.push({ field: k, why: 'not a setting of a new resident' });
  return missing;
}

/**
 * (2026-11-17) What a new, stopped resident's content must be, checked before anything is saved: the charter is
 * charterOf's for this dir (owner as given, halt file in it); the state is initialStateOf(charter) plus exactly one
 * ledger record for this id: mode manual, nothing allowed, policy version 1, zero balances, no holds, requests or
 * withdrawals, this wallet as agent key, the charter's owner. → [] or the problems.
 */
export function initialContentProblems(charter, state, { dir, wallet }) {
  const p = [];
  if (!isObj(charter) || charter.v !== 1 || charter.haltFile !== path.join(dir, 'HALT') || !isObj(charter.owner)) p.push('the charter is not a new charter for this directory');
  if (!isObj(state)) return [...p, 'no state'];
  const { agentWallet, ...rest } = state;
  if (isObj(charter) && JSON.stringify(rest) !== JSON.stringify(initialStateOf(charter))) p.push('the state is not a new resident\'s initial state (turn, journal, decisions, cursors …)');
  const agents = isObj(agentWallet?.agents) ? Object.keys(agentWallet.agents) : [];
  if (agents.length !== 1 || agents[0] !== charter?.id) p.push('the ledger holds another set of agents');
  const rec = agentWallet?.agents?.[charter?.id];
  if (!isObj(rec)) return [...p, 'no ledger record'];
  if (rec.mode !== 'manual') p.push('not stopped (mode is not manual)');
  if (!isObj(rec.policy) || rec.policy.version !== 1 || !Array.isArray(rec.policy.allowed) || rec.policy.allowed.length !== 0 || rec.policy.revoked !== undefined) p.push('the policy allows something, or is not the first one');
  if (rec.agentKey !== wallet || rec.owner !== charter.owner.address || rec.payout !== charter.owner.address) p.push('another wallet or owner');
  if (!isObj(rec.bal) || !Object.values(rec.bal).every(v => v === '0' || (isObj(v) && Object.values(v).every(x => x === '0')))) p.push('a balance that is not zero');
  for (const k of ['holds', 'withdrawals', 'requests']) if (!isObj(rec[k]) || Object.keys(rec[k]).length) p.push(`${k} not empty`);
  if (rec.modeEpoch !== 0 || rec.capabilityHash !== null) p.push('a mode or capability already set');
  if (Object.keys(agentWallet.deposits ?? {}).length || Object.keys(agentWallet.depositSends ?? {}).length || Object.keys(agentWallet.ownerNonces ?? {}).length || (agentWallet.operatorCosts ?? []).length) p.push('deposits, sends, nonces or costs already recorded');
  return p;
}

/**
 * Pure. `dir` absolute; `id` the resident's id (also its agent id: 1..64); `name`; `goal` one of GOALS; `owner`
 * {address (base58), name?}; `funder` (optional, as the charter: the owner when absent); `wallet` the resident's own
 * public address (base58), given by its owner; `createdAtMs` the time the record is made (given, never the clock).
 * Optional `limits`, `budget`, `siblings` as createCharter takes them. The test world's `pos` is null (not used here).
 * → {ok: true, charter, state} | {ok: false, missing: [{field, why}]}
 */
export function initialResident(input) {
  const i = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const missing = [];
  if (typeof i.dir !== 'string' || !path.isAbsolute(i.dir) || path.normalize(i.dir) !== i.dir || i.dir === path.parse(i.dir).root) missing.push({ field: 'dir', why: 'a new directory: an absolute, normalized path, not the root' });
  if (!text(i.id, AGENT_ID_MAX) || /\s/.test(i.id)) missing.push({ field: 'id', why: `the resident's id, also its agent id (1..${AGENT_ID_MAX} characters, no spaces)` });
  if (!text(i.name, 120)) missing.push({ field: 'name', why: "the resident's name" });
  if (typeof i.goal !== 'string' || !Object.hasOwn(GOALS, i.goal)) missing.push({ field: 'goal', why: `one of ${Object.keys(GOALS).join(', ')}` });
  if (!i.owner || typeof i.owner !== 'object' || typeof i.owner.address !== 'string' || !B58.test(i.owner.address)) missing.push({ field: 'owner.address', why: "the operator's public address (base58): who owns and can stop it" });
  if (i.funder !== undefined && (!i.funder || typeof i.funder !== 'object' || typeof i.funder.address !== 'string' || !B58.test(i.funder.address))) missing.push({ field: 'funder.address', why: 'a public address (base58), or absent (the owner)' });
  if (typeof i.wallet !== 'string' || !B58.test(i.wallet)) missing.push({ field: 'wallet', why: "the resident's own public address (base58), given by its owner; no key is read or made" });
  if (!Number.isSafeInteger(i.createdAtMs) || i.createdAtMs <= 0) missing.push({ field: 'createdAtMs', why: 'when the record is made (ms), given; the clock is not read' });
  missing.push(...overrideProblems(i));
  if (missing.length) return { ok: false, missing };
  const owner = { address: i.owner.address, ...(typeof i.owner.name === 'string' ? { name: i.owner.name } : {}) };
  const funder = i.funder ? { address: i.funder.address, ...(typeof i.funder.name === 'string' ? { name: i.funder.name } : {}) } : undefined;
  const charter = charterOf(i.dir, { id: i.id, name: i.name, goal: i.goal, pos: null, owner, funder, limits: i.limits, budget: i.budget, siblings: i.siblings });
  // the state as the resident makes it, with the ledger's own record (manual: never switched to auto here)
  const store = { state: initialStateOf(charter), save() {} };
  const ledger = new AgentLedger({ store, now: () => i.createdAtMs });
  const b = charter.budget;
  ledger.create({ agentId: charter.id, owner: charter.owner.address, agentKey: i.wallet, village: [0, 0, 0], policy: { allowed: [], budget: { total: b.total, perDay: b.perDay, callsPerDay: b.callsPerDay } } });
  const rec = store.state.agentWallet.agents[charter.id];
  const problems = initialContentProblems(charter, store.state, { dir: i.dir, wallet: i.wallet });
  if (problems.length) return { ok: false, missing: problems.map(why => ({ field: '*', why })) };
  return { ok: true, charter, state: store.state };
}

/** Writes `buf` whole to a new file (exclusive, 0600) and syncs it; throws on anything short or failed. */
function writeNew(file, buf) {
  const fd = openSync(file, 'wx', 0o600);
  try {
    let off = 0;
    while (off < buf.length) {
      const n = writeSync(fd, buf, off, buf.length - off);
      if (!Number.isInteger(n) || n <= 0) throw Object.assign(new Error('a short write'), { code: 'ShortWrite' });
      off += n;
    }
    fsyncSync(fd);
  } finally { closeSync(fd); }
}

/**
 * The explicit save of a new, stopped resident, from the SAME input as initialResident (2026-11-17: it builds and
 * checks the content itself; a charter or state from elsewhere, changed after it was built, or for another directory,
 * is never taken). The two files' bytes are fixed before anything is made. Its parent must exist and be a real
 * directory (no link at that last step; links further up the path are not checked); `dir` is made non-recursively (an
 * existing one, or a link there, is refused, never reused or overwritten), then checked to be a real directory owned
 * by this process's user; charter.json then state.json are created exclusively (0600), written whole and synced, then
 * the directory is synced. The checks and the making are separate system calls: a change by someone else between them
 * is not excluded beyond what the non-recursive mkdir and the exclusive creates refuse.
 * → {ok: true, wrote: [...]} | {ok: false, step, why, missing?, wrote?}
 * On a failure nothing is removed or cleaned up (what was made stays; an incomplete directory reads as state-unknown).
 */
export function writeInitialResident(input) {
  const fail = (step, e) => ({ ok: false, step, why: String(e?.code ?? e?.message ?? e).slice(0, 80) });
  const built = initialResident(input);
  if (!built.ok) return { ok: false, step: 'input', why: 'the settings of a new resident are missing or malformed', missing: built.missing };
  const dir = input.dir;
  const problems = initialContentProblems(built.charter, built.state, { dir, wallet: input.wallet });
  if (problems.length) return { ok: false, step: 'content', why: problems.join('; ').slice(0, 200) };
  const bytes = [['charter.json', Buffer.from(JSON.stringify(built.charter, null, 2))], ['state.json', Buffer.from(JSON.stringify(built.state, null, 2))]];
  const parent = path.dirname(dir);
  try { const p = lstatSync(parent); if (!p.isDirectory() || p.isSymbolicLink()) return fail('parent', 'not a real directory'); } catch (e) { return fail('parent', e); }
  try { mkdirSync(dir, { mode: 0o700 }); } catch (e) { return fail('mkdir', e); }   // EEXIST: an existing directory is never used
  try {
    const d = lstatSync(dir);
    if (!d.isDirectory() || d.isSymbolicLink() || (typeof process.getuid === 'function' && d.uid !== process.getuid())) return fail('owner', 'the new directory is not this user\'s own');
  } catch (e) { return fail('owner', e); }
  const wrote = [];
  for (const [name, buf] of bytes) {
    try { writeNew(path.join(dir, name), buf); wrote.push(name); } catch (e) { return { ...fail(name, e), wrote }; }
  }
  try { const fd = openSync(dir, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } } catch (e) { return { ...fail('sync', e), wrote }; }
  return { ok: true, wrote };
}
