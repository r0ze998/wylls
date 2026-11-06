// Workstream 12: what the memory takes from workstreams 4 and 8, as they publish it — and nothing filled in by guess.
// Read on origin/integration/ws09-13-v16-d0949fd4 (ef63544c; 4 and 8 unchanged since d0949fd4).
//
//   4  the run executor's own SQLite store (workstreams/04-execution/src/store.rs): `receipts`, `runs.spec`, and the
//      store's world binding `meta('world')` (bind_world: "every run, key and seq in this store means something only
//      in its own world"). Read-only, raw JSON text kept so u64 values stay exact.
//   8  the herald (frontier-node/crates/herald): `GET /h/season` (programId, cluster, season, seasonAddress,
//      genesisTs, bellSecs, continuous, latestSlot, latestUnix), `GET /h/events` rows ({seq, slot, sig, kind, bell}:
//      the chain bell of each record's slot), `GET /h/me/{wallet}` ({wallet, citizen: {address, slot, bytes_b64}}).
//
// What is NOT published, and therefore stays an explicit input or unknown:
//   - finality: the herald's latestSlot is not a finality statement and receipts carry none. A finality attestation
//     {commitment: 'finalized', slot, source} must be handed in; without one nothing is believed (receipts held).
//   - which herald world a 4 store's opaque world string is: 4's real port names "program id and world account" but
//     the format is not pinned. The pairing is an explicit, sourced declaration; without it receipts are held.
//   - the bell of an arbitrary slot: only slots that the herald's event rows place in a bell are mapped; any other
//     slot is unknown (held), never interpolated.
// No key is generated, derived or signed here: the wallet <-> citizen tag pair is READ from the citizen account the
// herald returns (Citizen v2 layout: WALLET @ 64, CITIZEN_TAG @ 208, frontier-abi/src/v2/layout/player.rs) and
// cross-checked against the address it returned (the program's citizen_tag is the address's first 8 bytes).
import { DatabaseSync } from 'node:sqlite';
import { worldConfig } from './ws08-world.mjs';
import { parseJsonU64, ingestReceipts } from './ws04-receipts.mjs';
import { memoryLines } from '../src/view.mjs';

// ------------------------------------------------------------------ base58 (bitcoin alphabet; encoding only)
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function b58decode(s) {
  if (typeof s !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]+$/.test(s)) throw new TypeError('not base58');
  let n = 0n;
  for (const ch of s) n = n * 58n + BigInt(B58.indexOf(ch));
  const bytes = [];
  while (n > 0n) { bytes.unshift(Number(n & 0xffn)); n >>= 8n; }
  for (const ch of s) { if (ch === '1') bytes.unshift(0); else break; }
  return Uint8Array.from(bytes);
}
export function b58encode(bytes) {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = '';
  while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
  for (const b of bytes) { if (b === 0) out = `1${out}`; else break; }
  return out;
}
const u64le = (buf, off) => { let v = 0n; for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(buf[off + i]); return v; };
const hex16 = v => v.toString(16).padStart(16, '0');

// ------------------------------------------------------------------ 8: world and clock parameters
/**
 * `GET /h/season` -> the memory's world config plus the clock parameters, as published. Throws on a missing or
 * malformed field (the caller then has no world, not a guessed one).
 */
export function worldFromSeason(season) {
  const need = (k, ok) => { if (!ok(season?.[k])) throw new TypeError(`/h/season ${k} missing or malformed`); return season[k]; };
  const cluster = need('cluster', v => typeof v === 'string' && v.length > 0);
  const programId = need('programId', v => typeof v === 'string');
  const seasonAddress = need('seasonAddress', v => typeof v === 'string');
  const seasonId = Number(need('season', v => typeof v === 'string' && /^\d{1,15}$/.test(v)));
  const genesisTs = need('genesisTs', Number.isSafeInteger);
  const bellSecs = need('bellSecs', v => Number.isSafeInteger(v) && v > 0);
  const continuous = need('continuous', v => typeof v === 'boolean');
  const cfg = worldConfig({ cluster, program: programId, worldAccount: seasonAddress, seasonId, continuous });
  return { ...cfg, clock: { genesisTs, bellSecs, source: `herald:/h/season@slot:${season.slot ?? '?'}` } };
}

/** The current world bell from /h/season's latestUnix, or null. Informational: not a finality statement. */
export function currentBellFromSeason(season) {
  const { genesisTs, bellSecs, latestUnix } = season ?? {};
  if (![genesisTs, bellSecs, latestUnix].every(Number.isSafeInteger) || bellSecs <= 0 || latestUnix < genesisTs) return null;
  return Math.floor((latestUnix - genesisTs) / bellSecs);
}

/**
 * slot -> bell from the herald's `/h/events` rows: a slot is mapped only when rows place it in exactly one bell;
 * a slot with no row, a PRE_GENESIS row (0xffffffff) or rows that disagree is unknown (null).
 */
export function clockFromHeraldEvents(rows) {
  const bySlot = new Map();
  for (const r of rows ?? []) {
    if (!Number.isSafeInteger(r?.slot) || !Number.isSafeInteger(r?.bell)) continue;
    const s = bySlot.get(r.slot) ?? new Set();
    s.add(r.bell === 0xffffffff ? null : r.bell);
    bySlot.set(r.slot, s);
  }
  return slot => { const s = bySlot.get(slot); if (!s || s.size !== 1) return null; const [b] = s; return b; };
}

/** A finality attestation as handed in by 4/8 (an RPC read at commitment 'finalized'); anything else is refused. */
export function finalizedSlotFrom(att, world) {
  if (!att || att.commitment !== 'finalized' || !Number.isSafeInteger(att.slot) || typeof att.source !== 'string' || !att.source) return { slot: null, why: 'no_finality_attestation' };
  if (world && att.world_id !== world.world_id) return { slot: null, why: 'finality_for_another_world' };
  return { slot: att.slot, why: null };
}

// ------------------------------------------------------------------ 8: wallet <-> citizen tag
/**
 * `GET /h/me/{wallet}` -> {entry} or {why}. The entry pairs the citizen's tag (read at CITIZEN_TAG @ 208) with the
 * wallet (read at WALLET @ 64, and equal to the queried wallet), as of the account's slot. Refused when the
 * account is absent, too short, names another wallet, or its address does not start with its tag.
 */
export function identityFromHeraldMe(me, { partition }) {
  const c = me?.citizen;
  if (!c || typeof c.bytes_b64 !== 'string') return { why: 'no_citizen' };
  const data = Buffer.from(c.bytes_b64, 'base64');
  if (data.length < 216) return { why: 'citizen_account_too_short' };
  const wallet = b58encode(data.subarray(64, 96));
  if (wallet !== me.wallet) return { why: 'citizen_names_another_wallet' };
  const tag = u64le(data, 208);
  let addr;
  try { addr = b58decode(c.address); } catch { return { why: 'bad_citizen_address' }; }
  if (addr.length !== 32 || u64le(addr, 0) !== tag) return { why: 'tag_not_the_address_prefix' };
  return { entry: { partition, tag: hex16(tag), principal: wallet, as_of_slot: c.slot ?? null, source: `herald:/h/me/${wallet}@slot:${c.slot ?? '?'}` } };
}

/** A resolver over entries from identityFromHeraldMe: a tag with exactly one wallet resolves; anything else does not. */
export function resolverFromIdentity(entries) {
  const byTag = new Map();
  for (const e of entries) { const l = byTag.get(e.tag) ?? []; l.push(e); byTag.set(e.tag, l); }
  const conflicts = [...byTag].filter(([, l]) => new Set(l.map(e => e.principal)).size > 1).map(([t]) => t);
  const resolve = tag => { const l = byTag.get(tag); return l && new Set(l.map(e => e.principal)).size === 1 ? { principal: l[0].principal, source: l[0].source } : null; };
  const wallets = new Map();
  for (const [, l] of byTag) if (new Set(l.map(e => e.principal)).size === 1) wallets.set(l[0].principal, { tag: l[0].tag, source: l[0].source });
  return { resolve, conflicts, walletKnown: w => wallets.get(w) ?? null };
}

// ------------------------------------------------------------------ 4: the run executor's store
/**
 * Read 4's store read-only: its world binding, receipts (raw bodies parsed u64-exact) and run specs. Nothing is
 * written. A store with no world binding gives `world: null` (its receipts cannot be placed in any world).
 */
export function readWs04Store(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const w = db.prepare("SELECT value FROM meta WHERE name = 'world'").get();
    const receipts = db.prepare('SELECT run_id, kind, subject, source, slot, body FROM receipts ORDER BY slot, kind, subject, source').all()
      .map(r => ({ run_id: r.run_id, kind: r.kind, subject: r.subject, source: r.source, slot: Number(r.slot), body: parseJsonU64(r.body) }));
    const runSpecs = Object.fromEntries(db.prepare('SELECT run_id, spec FROM runs').all().map(r => [r.run_id, parseJsonU64(r.spec)]));
    return { world: w?.value ?? null, receipts, runSpecs };
  } finally { db.close(); }
}

/**
 * Whether a 4 store's world is the herald's world: only by an explicit declaration
 * {ws04World, programId, seasonAddress, source} made by whoever runs both (the format of 4's real world string is
 * not pinned). Returns null when it holds, else the reason.
 */
export function storeWorldMismatch(storeWorld, decl, season) {
  if (!storeWorld) return 'ws04_store_world_unbound';
  if (!decl || typeof decl.source !== 'string' || !decl.source) return 'world_binding_undeclared';
  if (decl.ws04World !== storeWorld) return 'ws04_store_bound_to_another_world';
  if (decl.programId !== season.programId || decl.seasonAddress !== season.seasonAddress) return 'declaration_names_another_herald_world';
  return null;
}

// ------------------------------------------------------------------ the connection, end to end
/**
 * One pass from the canonical sources into a memory. Inputs are what 4 and 8 publish, as read by the caller:
 *   season     the `/h/season` JSON          (world, partition, genesisTs, bellSecs, latestUnix)
 *   events     the `/h/events` rows           (slot -> bell; only slots the herald placed)
 *   me         `/h/me/{wallet}` JSONs         (wallet <-> citizen tag, read from the citizen account)
 *   store      readWs04Store(dbPath)          (receipts, run specs, the store's world)
 *   binding    {ws04World, programId, seasonAddress, source}: who says this store is this herald world
 *   finality   {commitment: 'finalized', slot, world_id, source}
 * Nothing missing is filled in: every receipt that cannot be placed is returned in `held` with its reason, and the
 * same call later (after a restart, or when finality, the clock or identity catches up) takes in only what is new.
 * The store is the pen: held receipts stay in 4's store and are read again; 12 keeps no second copy.
 */
export function connectCanonical(memory, { season, events, me = [], store, binding, finality }) {
  const out = { status: 'ok', reasons: [], identity: { known: 0, refused: [] }, ingest: null, held: [] };
  let world;
  try { world = worldFromSeason(season); } catch (e) { return { ...out, status: 'world_unverified', reasons: [e.message] }; }
  if (!world.world) out.reasons.push(...world.reasons);
  const mm = storeWorldMismatch(store?.world ?? null, binding, season);
  const fin = finalizedSlotFrom(finality, world.world);
  const observedBell = currentBellFromSeason(season);
  const holdAll = why => ({ ...out, status: 'held', reasons: [...out.reasons, why], held: (store?.receipts ?? []).map(r => ({ receipt: `${r.run_id}|${r.kind}|${r.subject}|${r.source}`, why })) });
  if (mm) return holdAll(mm);
  if (fin.why) return holdAll(fin.why);
  if (observedBell === null) return holdAll('observed_bell_unknown');
  const entries = [];
  for (const m of me) {
    const r = identityFromHeraldMe(m, { partition: world.partition });
    if (r.entry) entries.push(r.entry); else out.identity.refused.push({ wallet: m?.wallet ?? null, why: r.why });
  }
  const ids = resolverFromIdentity(entries);
  out.identity.known = entries.length;
  out.identity.conflicts = ids.conflicts;
  out.ingest = ingestReceipts(memory, store.receipts, {
    partition: world.partition, observedBell, bellOfSlot: clockFromHeraldEvents(events), finalizedSlot: fin.slot,
    runSpecs: store.runSpecs, resolveOwner: ids.resolve,
  });
  out.held = out.ingest.held;
  return out;
}

// ------------------------------------------------------------------ 12 -> 13: the evidence port
const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const PUBLIC_VIEWER = Object.freeze({ tag: null, nation: null });
/**
 * A read-only port with 13's `ports.evidence` contract (f40ac0d1, resident.mjs #publicEvidence:
 * `read({counterparty, worldBell}) -> {status, lines[{about, epistemic, text, sources}]}`), fed from the canonical
 * sources instead of fixtures:
 *   - `identity` is resolverFromIdentity(...) over herald citizen accounts: a counterparty wallet is answered only
 *     when the herald paired it with a citizen of this world; otherwise `identity_unverified`.
 *   - `worldBellOf(residentBell)` maps the bell 13 hands in to the world bell. 13's bell is its own; nobody has yet
 *     published that it is the world bell, so without this function the answer is `clock_unverified`.
 * Public records only (the viewer is no party and no nation); nothing is written to 12 or to 13.
 */
export function ws12EvidencePort(memory, { identity = null, worldBellOf = null } = {}) {
  if (typeof memory?.knowledge !== 'function') throw new TypeError('workstream 12 memory is required');
  return Object.freeze({
    kind: 'ws12-evidence-canonical-readonly',
    read({ counterparty, worldBell }) {
      if (typeof memory.world?.cluster !== 'string' || typeof memory.world?.world_id !== 'string') return { status: 'world_unverified', lines: [] };
      if (typeof counterparty !== 'string' || !ADDRESS.test(counterparty)) return { status: 'identity_unverified', lines: [] };
      const known = identity?.walletKnown?.(counterparty) ?? null;
      if (!known) return { status: 'identity_unverified', lines: [] };
      const bell = typeof worldBellOf === 'function' ? worldBellOf(worldBell) : null;
      if (!Number.isSafeInteger(bell) || bell < 0) return { status: 'clock_unverified', lines: [] };
      const k = memory.knowledge(PUBLIC_VIEWER, bell, { observedBy: bell });
      return { status: 'ok', lines: memoryLines(k, [counterparty]).map(l => ({ about: l.about, epistemic: l.epistemic, text: l.text, sources: [...l.sources], identitySource: known.source })) };
    },
  });
}
