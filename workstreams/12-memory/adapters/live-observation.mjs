// Workstream 12: one read-only observation of the live canonical sources, fed through 12's existing connection
// (adapters/canonical.mjs connectCanonical) into a memory that lives only in this process. (2026-11-16)
//
// What it reads, and only this:
//   herald  GET /h/season, GET /h/events?after=… (paged, 500 a page: frontier-node/crates/herald/src/server.rs
//           `events`, {v, events[{seq, slot, bell, …}], next, full}), GET /h/me/{wallet} (views.rs me_json:
//           {wallet, citizen: {address, slot, seq, head, bytes_b64} | null}).
//   RPC     one JSON-RPC read: getSlot at commitment 'finalized'. No other method is sent (RPC_METHODS).
//   4       the run executor's SQLite store, read once, read-only, in one snapshot (readWs04Store).
// Nothing is written: no file, no store, no chain. No key is made, derived or used; nothing is signed or sent.
//
// I/O is handed in (`io.getJson`, `io.rpc`, `io.readStore`), so this module itself makes no request. The command
// that does is workstreams/13-citizens/bin/observe-canonical.mjs.
//
// Provenance is the caller's statement, never upgraded here:
//   - the herald's kind is what the caller states (`kinds.herald`); a Season the herald itself marks `sample`
//     (cluster "fixture") is a fixture whatever is stated;
//   - workstream 4's store is at most 'integration-output': its executor runs over a simulated chain, so a
//     receipt it wrote is never stated as 'chain' here, whatever the caller says;
//   - the finalized slot's kind is the caller's (`kinds.rpc`); which world it is for is an explicit declaration
//     {rpcUrl, cluster, source} (`rpcBinding`), because getSlot names no world: without it, or for another cluster,
//     there is no finality and every receipt is held (connectCanonical: no_finality_attestation).
// What is not decided here stays held, with its reason, as connectCanonical returns it: the store bound to another
// world or not bound, a slot the herald's events place in no bell, a slot not yet finalized, an owner tag no herald
// citizen pairs. No absence is concluded: no coverage record is built (coverageFromHistory is not called; workstream
// 19's `complete` is never true), so an unseen send stays unconfirmed, never "not sent". Arrived cargo stays the
// receipt's amount as 12 already records it; nothing here turns it into a credit for anyone.
import { createMemory } from '../src/index.mjs';
import {
  connectCanonical, currentBellFromSeason, identityFromHeraldMe, readWs04Store, resolverFromIdentity, worldFromSeason,
} from './canonical.mjs';

export const RPC_METHODS = Object.freeze(['getSlot']);
const KINDS = Object.freeze(['fixture', 'integration-output', 'chain']);
const RANK = Object.freeze({ fixture: 0, 'integration-output': 1, chain: 2 });
const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const DEFAULT_EVENT_PAGES = 64;

/** A kind no stronger than `max`; an unknown kind is no statement (null). Never raises a kind. */
export function capKind(kind, max = 'chain') {
  if (!KINDS.includes(kind)) return null;
  return RANK[kind] > RANK[max] ? max : kind;
}
const statement = (kind, source) => (kind && typeof source === 'string' && source ? { kind, source } : null);

/** `http(s)://host[:port][/path]` without a trailing slash, or null. */
export function baseUrl(u) {
  if (typeof u !== 'string') return null;
  let url;
  try { url = new URL(u); } catch { return null; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.search || url.hash || url.username || url.password) return null;
  return url.toString().replace(/\/+$/, '');
}

/**
 * The herald's public answers. Each failed or malformed read leaves that input absent with its reason; nothing is
 * filled in. `events` are the rows as the herald gives them; `eventsComplete` is false when the page limit stopped
 * the reading while the herald still said `full` (the slots after it are then placed in no bell: held).
 */
export async function readHerald({ base, getJson, wallets = [], maxEventPages = DEFAULT_EVENT_PAGES }) {
  const out = { season: null, why: [], events: [], eventPages: 0, eventsComplete: false, me: [], meRefused: [] };
  const b = baseUrl(base);
  if (!b) return { ...out, why: ['herald_url_malformed'] };
  const get = async path => {
    try {
      const r = await getJson(`${b}${path}`);
      return r && r.ok === true ? { body: r.body } : { why: `http_${r?.status ?? 'error'}` };
    } catch (e) { return { why: `request_failed:${String(e?.message ?? e).slice(0, 60)}` }; }
  };
  const s = await get('/h/season');
  if (s.why) out.why.push(`season_${s.why}`);
  else if (s.body && typeof s.body === 'object' && s.body.v === 1) out.season = s.body;
  else out.why.push('season_malformed');
  let after = '0';
  for (let page = 0; page < maxEventPages; page++) {
    const e = await get(`/h/events?after=${encodeURIComponent(after)}`);
    if (e.why) { out.why.push(`events_${e.why}`); break; }
    const body = e.body;
    if (!body || body.v !== 1 || !Array.isArray(body.events) || typeof body.next !== 'string' || !/^\d+$/.test(body.next)) { out.why.push('events_malformed'); break; }
    out.eventPages++;
    // Rows as given: clockFromHeraldEvents maps a slot only when its rows agree on one bell; a row without numbers is skipped there.
    for (const row of body.events) if (row && typeof row === 'object') out.events.push(row);
    if (body.full !== true) { out.eventsComplete = true; break; }
    if (body.next === after) { out.why.push('events_next_did_not_advance'); break; }
    after = body.next;
  }
  if (!out.eventsComplete && !out.why.some(w => w.startsWith('events_'))) out.why.push('events_page_limit');
  for (const w of [...new Set(wallets)]) {
    if (typeof w !== 'string' || !ADDRESS.test(w)) { out.meRefused.push({ wallet: String(w).slice(0, 48), why: 'wallet_malformed' }); continue; }
    const m = await get(`/h/me/${encodeURIComponent(w)}`);
    if (m.why) out.meRefused.push({ wallet: w, why: m.why });
    else if (!m.body || m.body.v !== 1 || m.body.wallet !== w) out.meRefused.push({ wallet: w, why: 'me_malformed' });
    else out.me.push(m.body);
  }
  return out;
}

/**
 * The finality attestation 12's connectCanonical takes, from one getSlot('finalized') read, or the reason there is
 * none. The world is the herald's (from /h/season) only by the explicit `rpcBinding` {rpcUrl, cluster, source}.
 */
export async function readFinalizedSlot({ rpcUrl, rpc, rpcBinding, season, world }) {
  const u = baseUrl(rpcUrl);
  if (!u) return { attestation: null, why: 'rpc_url_malformed' };
  if (!rpcBinding || typeof rpcBinding.source !== 'string' || !rpcBinding.source) return { attestation: null, why: 'rpc_cluster_undeclared' };
  if (baseUrl(rpcBinding.rpcUrl) !== u) return { attestation: null, why: 'rpc_binding_names_another_endpoint' };
  if (typeof season?.cluster !== 'string' || rpcBinding.cluster !== season.cluster) return { attestation: null, why: 'rpc_binding_names_another_cluster' };
  if (!world || typeof world.world_id !== 'string') return { attestation: null, why: 'world_unverified' };
  let slot;
  try { slot = await rpc(u, 'getSlot', [{ commitment: 'finalized' }]); } catch (e) { return { attestation: null, why: `rpc_failed:${String(e?.message ?? e).slice(0, 60)}` }; }
  if (!Number.isSafeInteger(slot) || slot < 0) return { attestation: null, why: 'rpc_slot_malformed' };
  return { attestation: { commitment: 'finalized', slot, world_id: world.world_id, source: `rpc:${u} getSlot(finalized)` }, why: null };
}

/**
 * One observation, end to end: herald -> world and clock; RPC -> finality; 4's store -> receipts; connectCanonical
 * -> a memory of this process only. Returns what 13's live port takes (resident/ports/live-canonical.mjs), with
 * every held receipt and every input that was missing, each with its reason.
 *
 * `kinds` = {herald, rpc, store}: the caller's statement of each source's kind (see the header). Missing: unstated.
 */
export async function observeLive({ heraldUrl, rpcUrl, storePath, binding = null, rpcBinding = null, wallets = [], kinds = {}, maxEventPages, io }) {
  if (typeof io?.getJson !== 'function' || typeof io?.rpc !== 'function') throw new TypeError('io.getJson and io.rpc are required (this module makes no request itself)');
  const readStore = io.readStore ?? readWs04Store;
  const h = await readHerald({ base: heraldUrl, getJson: io.getJson, wallets, maxEventPages });
  const missing = [...h.why];
  const base = { status: 'held', reasons: missing, held: [], memory: null, world: null, clock: null, observedBell: null, identity: null, provenance: null,
    inputs: { eventPages: h.eventPages, eventsComplete: h.eventsComplete, meRefused: h.meRefused, finality: null } };
  if (!h.season) return Object.freeze({ ...base, status: 'world_unverified' });
  let W;
  try { W = worldFromSeason(h.season); } catch (e) { return Object.freeze({ ...base, status: 'world_unverified', reasons: [...missing, e.message] }); }
  const memory = createMemory({ world: W.world, partitions: W.partitions });   // no path: nothing is written
  // The world bell now, from /h/season's latestUnix (informational, as connectCanonical uses it; not finality).
  const observedBell = currentBellFromSeason(h.season);
  const fin = await readFinalizedSlot({ rpcUrl, rpc: io.rpc, rpcBinding, season: h.season, world: W.world });
  if (fin.why) missing.push(fin.why);
  let store = null;
  try { store = readStore(storePath); } catch (e) { missing.push(`ws04_store_unreadable:${String(e?.message ?? e).slice(0, 60)}`); }
  const hb = baseUrl(heraldUrl);
  const heraldKind = h.season.sample === true ? capKind(kinds.herald, 'fixture') ?? 'fixture' : capKind(kinds.herald);
  const sources = {
    season: statement(heraldKind, `herald:${hb}/h/season@slot:${h.season.slot ?? '?'}`),
    events: statement(heraldKind, `herald:${hb}/h/events pages:${h.eventPages}${h.eventsComplete ? '' : ' (incomplete)'}`),
    me: statement(heraldKind, `herald:${hb}/h/me`),
    store: statement(capKind(kinds.store, 'integration-output'), `ws04-store:${storePath}@readonly-snapshot`),
    finality: fin.attestation ? statement(capKind(kinds.rpc), fin.attestation.source) : null,
  };
  const inputs = { ...base.inputs, finality: fin.attestation ? { slot: fin.attestation.slot } : { slot: null, why: fin.why } };
  if (!store) return Object.freeze({ ...base, reasons: missing, memory, world: W.world, clock: W.clock, observedBell, inputs });
  const r = connectCanonical(memory, { season: h.season, events: h.events, me: h.me, store, binding, finality: fin.attestation, sources });
  // The same resolver connectCanonical used, rebuilt from the same answers (connectCanonical does not return it).
  const ids = resolverFromIdentity(h.me.map(m => identityFromHeraldMe(m, { partition: W.partition }).entry).filter(Boolean));
  return Object.freeze({
    status: r.status, reasons: [...missing, ...r.reasons], held: r.held, memory, world: W.world, clock: W.clock, observedBell, identity: ids,
    provenance: r.provenance, identitySummary: r.identity, ingest: r.ingest ? { added: r.ingest.added, duplicate: r.ingest.duplicate, refused: r.ingest.refused } : null,
    inputs,
  });
}
