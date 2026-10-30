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
// still emitted, as a `position` event, so that it is not taken for a gap.
/** S1 store slots in kernel order (holding.rs `Resource`); arms ride in the Horses slot. */
export const SLOT_RESOURCES = ['food', 'wood', 'stone', 'ore', 'arms', 'gold', null, null];
/** STRUCTURE kinds (permutation-rules frontier/structure.rs). */
export const STRUCTURE_KINDS = { 1: 'tower', 2: 'palisade', 3: 'fort' };
const DELIVERED = 0;
const RAID_TAKE = 0;
/** ①'s rule for what an arrival's quantity is worth (docs/17-coop-connect.ja.md of ①, as relayed). */
export const DEFAULT_TRUST = { village: 'chain_lower_bound', storehouse: 'unverified' };

/** 8 u32 LE amounts (a log `cargo`). */
export function cargoOf(bytes) {
  const b = Uint8Array.from(bytes);
  if (b.length !== 32) throw new Error('cargo: 32 bytes');
  const dv = new DataView(b.buffer);
  return Array.from({ length: 8 }, (_, i) => dv.getUint32(4 * i, true));
}

/** A logged place (8 B, read as a little-endian u64): `kind u8 ‖ p i16 ‖ q i16 ‖ site_or_tile u8 ‖ gen u8 ‖ tile u8`. */
export function placeOf(v) {
  let x = BigInt(v);
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
export function fromS1Records(page, resolve, { stream = 'chain', trust = DEFAULT_TRUST } = {}) {
  const events = [];
  const skipped = [];
  const unresolved = [];
  const nationOf = resolve.nationOf ?? (f => `n${f}`);
  for (const { seq, sig, record: r } of page) {
    const base = { stream, seq: Number(seq), at: Number(r.bell ?? r.logBell) };
    let sub = 0;
    const emit = (kind, fields, verified = 'chain') => events.push({ id: `${stream}:${seq}:${sub}`, ...base, sub: sub++, kind, verified, ...fields, src: { sig, kind: r.name } });
    const ship = (tag, s, res) => `cv:${tag}:${s}:${res}`;
    switch (r.name) {
      case 'CARAVAN_SENT': {
        const from = resolve.actorOfTag(r.owner_tag);
        const dst = resolve.destination(placeOf(r.dst), r.owner_tag, r.seq);
        if (!from || !dst) { unresolved.push({ seq, name: r.name, missing: !from ? 'owner' : 'destination' }); break; }
        cargoOf(r.cargo).forEach((q, i) => {
          const res = SLOT_RESOURCES[i];
          if (q && res) emit('ship.send', { ship: ship(r.owner_tag, r.seq, res), from, to: dst.project ? `project:${dst.project}` : dst.actor, resource: res, qty: q, place: dst.kind });
        });
        break;
      }
      case 'CARAVAN_SETTLED': {
        const dst = resolve.destination(placeOf(r.dst), r.owner_tag, r.seq);
        const v = (dst && trust[dst.kind]) ?? 'unverified';
        cargoOf(r.cargo).forEach((q, i) => {
          const res = SLOT_RESOURCES[i];
          if (!q || !res) return;
          if (Number(r.outcome) === DELIVERED) emit('ship.arrive', { ship: ship(r.owner_tag, r.seq, res), qty: q }, v);
          else emit('ship.lost', { ship: ship(r.owner_tag, r.seq, res) });
        });
        break;
      }
      case 'CARAVAN_RAIDED': {
        const raider = resolve.actorOfTag(r.raider_tag);
        if (!raider) { unresolved.push({ seq, name: r.name, missing: 'raider' }); break; }
        const taken = cargoOf(r.taken);
        const sent = resolve.cargoSent?.(r.owner_tag, r.seq) ?? null;
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
        emit('build.complete', { project, structure: `st:${r.p},${r.q},${r.tile}`, structureKind: kind, by: resolve.actorOfTag(r.owner_tag) ?? undefined });
        break;
      }
      case 'STRUCTURE_SEIZED': {
        const by = resolve.actorOfTag(r.captor_tag);
        emit('structure.seized', { structure: `st:${r.p},${r.q},${r.tile}`, by: by ?? `tag:${r.captor_tag}` });
        break;
      }
      case 'FORT_GARRISONED': {
        const actor = resolve.actorOfTag(r.owner_tag);
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
    if (!sub) events.push({ id: `${stream}:${seq}:0`, ...base, sub: 0, kind: 'position', verified: 'chain', src: { sig, kind: r.name } });
  }
  return { events, skipped, unresolved };
}
