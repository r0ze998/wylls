// The public herald records the memory feature reads, normalised.
//
// Inputs are the JSON the herald serves (and AC6a's feed hands over):
//   /h/events rows      {seq, slot, sig, kind, bell, tx, body_b64, decoded:{name,key,payload}}
//   /h/province/p,q/b   the immutable envelope {v, key, bell, slot, bytes (b64 Province), slots, day, inputs, ...}
//   /h/clash/p,q/b      {bell, decoded:{engagements, fates, fighters[]}, province_before_b64, inputs_b64, ...}
// The binary parts are decoded with web/frontier/fcodec.mjs (a pure JS
// decoder, read-only import: allowed by contract §11.1; no wasm). Everything
// here accepts the raw JSON or an already decoded object (the shape
// herald.mjs parseEnvelope returns, or the normalised form this file makes),
// so tests can hand over small hand-made objects.
//
// Units: the clash report and the Province entries count troops in
// milli-troops (a MUSTER of 100 troops is an Entry of 100000); camps count
// whole troops (camp.rs). `toTroops` rounds milli down to whole troops.
import { decode } from '../../../permutation-server/web/frontier/fcodec.mjs';
import { tagFromDecimal } from '../persona/names.mjs';

const MILLI = 1000;
export const toTroops = milli => Math.floor(Math.max(0, milli) / MILLI);
export const NEUTRAL = 6;
export const NO_BELL = 0xffffffff;

const bytesOf = b => (b instanceof Uint8Array ? b : Buffer.from(String(b ?? ''), 'base64'));
const str = v => (typeof v === 'bigint' ? v.toString() : String(v));

/** A Province account or a herald envelope or parseEnvelope output -> {p,q,sites,siteCount,mirror,entries,camp}; null when absent. */
export function normProvince(x) {
  if (!x) return null;
  if (x.norm === 'province') return x;
  if (Array.isArray(x.hosts) && Array.isArray(x.sites)) return fromFeedProvince(x); // watcher/feed.mjs shapeProvince output
  let pv = null;
  if (x.province && x.province.entries) pv = x.province; // parseEnvelope output
  else if (x.entries && x.camp) pv = x; // a decoded account
  else if (x.bytes) pv = decode('Province', bytesOf(x.bytes)); // the raw envelope
  else if (x.sites && x.mirror) return { norm: 'province', ...x }; // hand-made normalised
  if (!pv) return null;
  const sites = Array.from(pv.sites ?? []);
  const siteCount = pv.siteCount ?? sites.length;
  return {
    norm: 'province',
    p: pv.p, q: pv.q,
    sites, siteCount,
    mirror: (pv.siteMirror ?? pv.mirror ?? []).map(m => ({ state: m.state, faction: m.faction, tier: m.tier, garrison: Number(m.garrison ?? 0), shieldUntilBell: m.shieldUntilBell ?? 0, gen: m.gen ?? 0 })),
    entries: (pv.entries ?? []).filter(e => (e.state ?? 0) !== 0 || BigInt(e.id ?? 0) !== 0n)
      .map(e => ({ id: str(e.id), faction: e.faction, unit: e.unit, tile: e.tile, state: e.state, troops: Number(e.troops) })),
    camp: pv.camp ? { tile: pv.camp.tile, state: pv.camp.state, troops: Number(pv.camp.troops), gen: Number(pv.camp.gen ?? 0) } : { tile: 0, state: 0, troops: 0, gen: 0 },
  };
}

/** The shape watcher/feed.mjs (AC6a) hands over: sites[{site,tile,state,faction,garrison,...}], hosts[{id,faction,unit,tile,state,troops}], camp. */
function fromFeedProvince(x) {
  const sites = [...x.sites].sort((a, b) => a.site - b.site);
  return {
    norm: 'province', p: x.p, q: x.q, sites: sites.map(s => s.tile), siteCount: x.site_count ?? sites.length,
    mirror: sites.map(s => ({ state: s.state, faction: s.faction, tier: s.tier, garrison: Number(s.garrison ?? 0), shieldUntilBell: s.shield_until_bell ?? 0, gen: s.gen ?? 0 })),
    entries: x.hosts.filter(h => (h.state ?? 0) !== 0).map(h => ({ id: String(h.id), faction: h.faction, unit: h.unit, tile: h.tile, state: h.state, troops: Number(h.troops) })),
    camp: x.camp ? { tile: x.camp.tile, state: x.camp.state, troops: Number(x.camp.troops), gen: Number(x.camp.gen ?? 0) } : { tile: 0, state: 0, troops: 0, gen: 0 },
    inputs: x.inputs ? normInputs(x.inputs) : null,
  };
}

/** ClashInputs (decoded or raw) -> arrivals present: [{id, tag(decimal), faction, unit, tile, troops}]. */
export function normInputs(x) {
  if (!x) return null;
  if (x.norm === 'inputs') return x;
  let ci = x;
  if (typeof x === 'string') ci = decode('ClashInputs', bytesOf(x));
  else if (x.bytes) ci = decode('ClashInputs', bytesOf(x.bytes));
  else if (!x.arrivals) return null;
  return {
    norm: 'inputs',
    arrivals: (ci.arrivals ?? []).filter(a => a.present === 1 || a.present === true || a.present === undefined)
      .filter(a => str(a.hostId ?? a.host_id ?? a.id) !== '0')
      .map(a => ({
        id: str(a.hostId ?? a.host_id ?? a.id),
        // a raw ClashInputs record carries the tag as a decimal u64; the feed shape (AC6a) as 16 hex digits
        tag: a.citizenTag !== undefined ? tagFromDecimal(a.citizenTag) : (a.citizen ?? (a.tag ? tagFromDecimal(a.tag) : null)),
        faction: a.faction, unit: a.unit, tile: a.tile, troops: Number(a.troops), depMass: Number(a.depMass ?? a.dep_mass ?? 0),
      })),
  };
}

/** A /h/clash file -> {p,q,bell,fighters,engagements,before,inputs}. */
export function normClash(file) {
  if (!file) return null;
  const d = file.decoded ?? {};
  const fighters = (d.fighters ?? file.fighters ?? []).map(f => ({
    id: str(f.id), arrival: !!f.arrival, troops: Number(f.troops), fate: f.fate, engaged: !!f.engaged, tile: f.tile ?? null, stamina: f.stamina ?? 0,
    // present when the report comes through watcher/feed.mjs (owners resolved; clashDetail adds the exact troops before)
    owner: f.owner ?? null, faction: f.faction ?? null, before: f.troops_before ?? null,
  }));
  const pq = Array.isArray(file.province) ? file.province : (file.key ? /^ci:(-?\d+),(-?\d+),/.exec(file.key)?.slice(1).map(Number) : null) ?? [file.p ?? null, file.q ?? null];
  const before = file.province_before_b64 ? normProvince({ bytes: file.province_before_b64 }) : normProvince(file.province_before);
  const inputs = file.inputs_b64 ? normInputs(file.inputs_b64) : normInputs(file.inputs);
  return { p: pq[0], q: pq[1], bell: file.bell, fighters, engagements: d.engagements ?? file.engagements ?? 0, before, inputs };
}

/** Province-grid distance (axial coordinates, as fgeo.mjs ringOf of the difference). */
export const provDist = (p1, q1, p2, q2) => {
  const dp = p1 - p2, dq = q1 - q2;
  return (Math.abs(dp) + Math.abs(dq) + Math.abs(dp + dq)) / 2;
};

/** The site index inside a host id (host_id = province_index << 44 | site << 40 | gen << 32 | seq, M1-CONTRACT §4.1). */
export const siteOfHostId = id => Number((BigInt(id) >> 40n) & 0xfn);
export const siteOfTile = (prov, tile) => {
  for (let k = 0; k < prov.siteCount; k++) if (prov.sites[k] === tile) return k;
  return -1;
};
