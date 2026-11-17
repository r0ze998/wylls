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
import { charterOf, initialStateOf } from '../resident.mjs';
import { GOALS } from '../goals.mjs';
import { AGENT_ID_MAX } from '../ports/ws04-acts.mjs';

const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const text = (v, n = 64) => typeof v === 'string' && v.trim().length > 0 && v.length <= n;

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
  if (rec.mode !== 'manual' || rec.policy.allowed.length !== 0) return { ok: false, missing: [{ field: '*', why: 'the ledger did not make a stopped record with nothing allowed' }] };
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
 * The explicit save of initialResident's result into a NEW directory `dir`. Its parent must exist and be a real
 * directory (no link); `dir` is made non-recursively (an existing one is refused, never reused or overwritten), then
 * checked to be a real directory owned by this process's user; charter.json then state.json are created exclusively,
 * written whole and synced, then the directory is synced. → {ok: true, wrote: [...]} | {ok: false, step, why}
 * On a failure nothing is removed or cleaned up (what was made stays; an incomplete directory reads as state-unknown).
 */
export function writeInitialResident({ dir, charter, state }) {
  const fail = (step, e) => ({ ok: false, step, why: String(e?.code ?? e?.message ?? e).slice(0, 80) });
  if (typeof dir !== 'string' || !path.isAbsolute(dir) || charter?.haltFile !== path.join(dir, 'HALT') || state?.agentWallet?.agents?.[charter?.id]?.mode !== 'manual') return fail('input', 'not initialResident\'s result for this directory');
  const parent = path.dirname(dir);
  try { const p = lstatSync(parent); if (!p.isDirectory() || p.isSymbolicLink()) return fail('parent', 'not a real directory'); } catch (e) { return fail('parent', e); }
  try { mkdirSync(dir, { mode: 0o700 }); } catch (e) { return fail('mkdir', e); }   // EEXIST: an existing directory is never used
  try {
    const d = lstatSync(dir);
    if (!d.isDirectory() || d.isSymbolicLink() || (typeof process.getuid === 'function' && d.uid !== process.getuid())) return fail('owner', 'the new directory is not this user\'s own');
  } catch (e) { return fail('owner', e); }
  const wrote = [];
  for (const [name, obj] of [['charter.json', charter], ['state.json', state]]) {
    try { writeNew(path.join(dir, name), Buffer.from(JSON.stringify(obj, null, 2))); wrote.push(name); } catch (e) { return { ...fail(name, e), wrote }; }
  }
  try { const fd = openSync(dir, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } } catch (e) { return { ...fail('sync', e), wrote }; }
  return { ok: true, wrote };
}
