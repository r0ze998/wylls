// S1 program records → evaluator events (contract v0). Input: the decoded
// records of an events page as `decodePage` of
// permutation-server/web/frontier/flog.mjs returns them
// (`[{seq, slot, sig, record}]`, `record` with the snake_case fields of
// frontier-abi v2 log.rs). The herald numbers its `/h/events` contiguously,
// so its `seq` is the stream position the gap check runs on; the herald is a
// copy of the chain, and ①'s arrival count re-reads the transactions
// themselves (its `coop/chain.mjs`), which this adapter does not do.
//
// What the records do not say, the caller's `resolve` supplies:
//   actorOfTag(tag)                 → actor id (Citizen tag → Citizen → wallet; null: unknown)
//   destination(place, ownerTag, seq) → {actor, project?, kind: 'village'|'storehouse'} or null
//                                     (①'s links say which request a caravan serves: ws01.mjs)
//   projectOfStructure(p, q, tile)  → project id or null (①'s board links a fort to a request)
//   nationOf(faction)               → nation id (default `n<faction>`)
//
// Mapped: CARAVAN_SENT, CARAVAN_SETTLED, CARAVAN_RAIDED, STRUCTURE_BUILT,
// STRUCTURE_SEIZED, FORT_GARRISONED, KEEP. Not mapped (no counterpart, or not
// needed by the goals): everything else, and NATION_DECIDED (no vote kind
// sets a nation goal today). A record kind the adapter does not map is
// still emitted, as a `position` event, so that it is not taken for a gap. A
// record the adapter could not resolve is NOT emitted at all: it shows as a
// gap, and the verdicts that might depend on it are left undecided.
/** S1 store slots in kernel order (holding.rs `Resource`); arms ride in the Horses slot. */
export const SLOT_RESOURCES = ['food', 'wood', 'stone', 'ore', 'arms', 'gold', null, null];
/** STRUCTURE kinds (permutation-rules frontier/structure.rs). */
export const STRUCTURE_KINDS = { 1: 'tower', 2: 'palisade', 3: 'fort' };
const DELIVERED = 0;
const RAID_TAKE = 0;
/** ①'s rule for what an arrival's quantity is worth (docs/17-coop-connect.ja.md of ①, as relayed). */
export const DEFAULT_TRUST = { village: 'chain_lower_bound', storehouse: 'unverified' };

// JSON numbers above 2^53-1 have already lost information. Never turn a
// rounded source position or packed place into an apparently exact fact.
function exactUnsigned(v, max, field) {
  if (typeof v === 'number') {
    if (!Number.isSafeInteger(v) || v < 0) throw new Error(`${field}: inexact integer`);
    v = BigInt(v);
  } else if (typeof v === 'string') {
    if (!/^(0|[1-9]\d{0,19})$/.test(v)) throw new Error(`${field}: invalid integer`);
    v = BigInt(v);
  } else if (typeof v !== 'bigint') throw new Error(`${field}: invalid integer`);
  if (v < 0n || v > max) throw new Error(`${field}: out of range`);
  return v;
}
const positionOf = (v, field) => Number(exactUnsigned(v, BigInt(Number.MAX_SAFE_INTEGER), field));

/** 8 u32 LE amounts (a log `cargo`). */
export function cargoOf(bytes) {
  if (!(bytes instanceof Uint8Array) && !(Array.isArray(bytes) && bytes.every(n => Number.isInteger(n) && n >= 0 && n <= 255))) throw new Error('cargo: invalid bytes');
  const b = Uint8Array.from(bytes);
  if (b.length !== 32) throw new Error('cargo: 32 bytes');
  const dv = new DataView(b.buffer);
  return Array.from({ length: 8 }, (_, i) => dv.getUint32(4 * i, true));
}

/** A logged place (8 B, read as a little-endian u64): `kind u8 ‖ p i16 ‖ q i16 ‖ site_or_tile u8 ‖ gen u8 ‖ tile u8`. */
export function placeOf(v) {
  let x = exactUnsigned(v, (1n << 64n) - 1n, 'place');
  const b = [];
  for (let i = 0; i < 8; i++) { b.push(Number(x & 0xffn)); x >>= 8n; }
  const i16 = (lo, hi) => { const n = lo | (hi << 8); return n >= 0x8000 ? n - 0x10000 : n; };
  return { kind: b[0], p: i16(b[1], b[2]), q: i16(b[3], b[4]), site: b[5], gen: b[6], tile: b[7] };
}

/**
 * `{events, skipped, unresolved}`: the evaluator events derived from the
 * page, the positions with nothing to derive, and the records whose actors or
 * places `resolve` did not know (left out, and listed, never guessed).
 */
/**
 * Across seasons (the program's Season is still its address context): every
 * account address, Citizen tag, caravan `seq` and bell number restarts with
 * a season. For one continuous world give `epoch` (the season id) and
 * `worldBell(bell)` (that season's bells on the world's clock); ids and the
 * stream are then namespaced by epoch, and `resolve.actorOfTag(tag, epoch)`
 * must map each season's tag to the same participant. Places (keeps,
 * structures) keep their map coordinates as identity.
 */
export function fromS1Records(page, resolve, { stream: streamName = 'chain', trust = DEFAULT_TRUST, epoch = null, worldBell = b => b } = {}) {
  const stream = epoch === null ? streamName : `${streamName}:${epoch}`;
  const ns = epoch === null ? '' : `${epoch}:`;
  const actorOfTag = t => resolve.actorOfTag(t, epoch);
  const events = [];
  const skipped = [];
  const unresolved = [];
  const nationOf = resolve.nationOf ?? (f => `n${f}`);
  for (const { seq, sig, record: r } of page) {
    if (!r || typeof r !== 'object' || typeof r.name !== 'string') throw new Error('invalid S1 record');
    const before = unresolved.length;
    const position = positionOf(seq, 'source position');
    const bell = Number(exactUnsigned(r.bell ?? r.logBell, (1n << 32n) - 1n, 'bell'));
    const at = worldBell(bell);
    if (!Number.isSafeInteger(at) || at < 0) throw new Error('invalid world bell');
    const base = { stream, seq: position, at };
    let sub = 0;
    const emit = (kind, fields, verified = 'chain') => events.push({ id: `${stream}:${seq}:${sub}`, ...base, sub: sub++, kind, verified, ...fields, src: { sig, kind: r.name } });
    const ship = (tag, s, res) => `cv:${ns}${tag}:${s}:${res}`;
    // Cargo bytes that are not exactly 32 bytes of u32 amounts are no evidence of an amount: the record
    // is left unresolved (a gap), never read as zero or as a guess. (The candidate patch 15-separate
    // expects this of its base 32ad894d, which was not received; written here to that test.)
    const exactCargo = (bytes, missing = 'verified exact cargo evidence') => {
      try { return cargoOf(bytes); } catch { unresolved.push({ seq, name: r.name, missing }); return null; }
    };
    switch (r.name) {
      case 'CARAVAN_SENT': {
        const from = actorOfTag(r.owner_tag);
        const dst = resolve.destination(placeOf(r.dst), r.owner_tag, r.seq);
        if (!from || !dst) { unresolved.push({ seq, name: r.name, missing: !from ? 'owner' : 'destination' }); break; }
        const cargo = exactCargo(r.cargo);
        if (!cargo) break;
        cargo.forEach((q, i) => {
          const res = SLOT_RESOURCES[i];
          if (q && res) emit('ship.send', { ship: ship(r.owner_tag, r.seq, res), from, to: dst.project ? `project:${dst.project}` : dst.actor, resource: res, qty: q, place: dst.kind });
        });
        break;
      }
      case 'CARAVAN_SETTLED': {
        const dst = resolve.destination(placeOf(r.dst), r.owner_tag, r.seq);
        const v = (dst && trust[dst.kind]) ?? 'unverified';
        const cargo = exactCargo(r.cargo);
        if (!cargo) break;
        // ④'s quantity contract §3: a village keeps at least the logged cargo (lower bound); a storehouse's
        // kept amount is unknown without `credited`.
        const qtyKind = v === 'chain_lower_bound' ? 'lower_bound' : v === 'unverified' ? 'unknown' : undefined;
        cargo.forEach((q, i) => {
          const res = SLOT_RESOURCES[i];
          if (!q || !res) return;
          if (Number(r.outcome) === DELIVERED) emit('ship.arrive', { ship: ship(r.owner_tag, r.seq, res), qty: q, ...(qtyKind ? { qtyKind } : {}) }, v);
          else emit('ship.lost', { ship: ship(r.owner_tag, r.seq, res) });
        });
        break;
      }
      case 'CARAVAN_RAIDED': {
        const raider = actorOfTag(r.raider_tag);
        if (!raider) { unresolved.push({ seq, name: r.name, missing: 'raider' }); break; }
        const taken = exactCargo(r.taken);
        if (!taken) break;
        const sent = resolve.cargoSent?.(r.owner_tag, r.seq) ?? null;
        // A burn logs nothing taken: without the sent cargo the burned amounts are unknown.
        if (!sent && Number(r.choice) !== RAID_TAKE) { unresolved.push({ seq, name: r.name, missing: 'cargo sent' }); break; }
        taken.forEach((q, i) => {
          const res = SLOT_RESOURCES[i];
          if (!res) return;
          const all = sent ? sent[i] : q;
          if (!all) return;
          // A take moves what the raider could carry; a burn destroys the cargo (decision: take or burn).
          const take = Number(r.choice) === RAID_TAKE ? q : 0;
          emit('ship.raid', { ship: ship(r.owner_tag, r.seq, res), raider, taken: take, burned: all - take, domestic: !!r.domestic });
        });
        break;
      }
      case 'STRUCTURE_BUILT': {
        const kind = STRUCTURE_KINDS[Number(r.kind)];
        const project = resolve.projectOfStructure(r.p, r.q, r.tile);
        if (!kind || !project) { skipped.push({ seq, name: r.name, why: project ? 'kind' : 'no project links this structure' }); break; }
        emit('build.complete', { project, structure: `st:${r.p},${r.q},${r.tile}`, structureKind: kind, by: actorOfTag(r.owner_tag) ?? `tag:${r.owner_tag}` });
        break;
      }
      case 'STRUCTURE_SEIZED': {
        const by = actorOfTag(r.captor_tag);
        emit('structure.seized', { structure: `st:${r.p},${r.q},${r.tile}`, by: by ?? `tag:${r.captor_tag}` });
        break;
      }
      case 'FORT_GARRISONED': {
        const actor = actorOfTag(r.owner_tag);
        if (!actor) { unresolved.push({ seq, name: r.name, missing: 'owner' }); break; }
        emit('use', { structure: `st:${r.p},${r.q},${r.tile}`, actor, how: 'garrison', qty: Number(r.troops) });
        break;
      }
      case 'KEEP': {
        emit('keep.set', { keep: `keep:${r.p},${r.q}`, nation: Number(r.holder) < 6 ? nationOf(Number(r.holder)) : '' });
        break;
      }
      default: skipped.push({ seq, name: r.name, why: 'not mapped' });
    }
    if (!sub && unresolved.length === before) events.push({ id: `${stream}:${seq}:0`, ...base, sub: 0, kind: 'position', verified: 'chain', src: { sig, kind: r.name } });
  }
  return { events, skipped, unresolved };
}
