// Workstream 07: the march card's forecast built by the program's own clash
// model instead of the page's copy of it.
//
// The page's forecast (hud/forecast.mjs) builds the clash with
// screens/report.mjs `buildClashArgs`, which reads the residents, the site
// garrisons and the camp only. The program builds it with
// frontier-abi clash_model `build_v2`, which also puts in the keep's
// garrison (conquest, S1), the manned forts (S1 1e) and the caravans
// standing there (S1), and it wears an arrival's troops by the towers its
// walk crossed (S1 1d, `WORN_BPS`). The WASM kernel exports that very
// builder as `resolve_from_inputs` (Province bytes, ClashInputs bytes,
// bell, seed). So the forecast here hands the kernel the destination's
// Province bytes as the herald served them and a ClashInputs account whose
// only arrival is the viewer's host, its troops worn as Reveal and the
// gather would wear them (s1walk.mjs, pinned against the rules crate). No
// clash formula is written here.
//
// What it still cannot know is what the page cannot know: other arrivals
// (sealed until their turn), the defenders at the turn rather than now, and
// the structures standing at the Reveal rather than now.
import { RECORDS } from '../../../permutation-server/web/frontier/abi.mjs';
import { LAYOUTS } from '../../../permutation-server/web/sdk/frontier/abi-v2-layouts.mjs';
import { decodeClashOut } from '../../../permutation-server/web/frontier/screens/report.mjs';
import { forecastInputs, FORECAST_RUNS } from '../../../permutation-server/web/frontier/hud/forecast.mjs';
import { sha256 } from '../../../permutation-server/web/sdk/sha256.mjs';
import { dayOf } from '../../../permutation-server/web/frontier/clock.mjs';
import { decode } from '../../../permutation-server/web/frontier/fcodec.mjs';
import { wear } from './s1walk.mjs';

const V2 = Object.fromEntries(LAYOUTS.accounts.map(x => [x.kind, x]));
const field = (layout, name) => {
  const f = (layout.fields ?? []).find(x => (Array.isArray(x) ? x[0] : x.name) === name);
  if (!f) throw new Error(`layout has no ${name}`);
  return Array.isArray(f) ? { off: f[1], len: f[2] } : { off: f.off, len: f.len };
};
const CI = V2.ClashInputs, AR = RECORDS.ArrivalRecord, PV = V2.Province, ENTRY = RECORDS.Entry;
const CI_ARRIVALS = field(CI, 'ARRIVALS').off, PV_ENTRIES = field(PV, 'ENTRIES').off;
const ENTRIES_N = field(PV, 'ENTRIES').len / ENTRY.size;
/** clash_model: an arrival's ClashInputs position is `faction × 4 + i` (gather_position). */
export const positionOf = (faction, i = 0) => faction * 4 + i;
/** host.rs DESTROYED_BELOW: an arrival worn under this many milli-troops is destroyed at the gather, not present (pinned by the test). */
export const DESTROYED_BELOW = 500;

function put(view, off, len, v) {
  if (len === 8) view.setBigUint64(off, BigInt(v), true);
  else if (len === 4) view.setUint32(off, Number(v) >>> 0, true);
  else if (len === 2) view.setUint16(off, Number(v) & 0xffff, true);
  else view.setUint8(off, Number(v) & 0xff);
}

/**
 * A ClashInputs account (layout v2, its fields from the generated table)
 * holding the one arrival `a`: `{hostId, faction, unit, troops (milli),
 * stamina, tile, stance, retreat, dealt}`. Only what `build_v2` reads is
 * written: the arrival records and their PRESENT flags.
 */
export function inputsBytes(a, { p = 0, q = 0, bell = 0 } = {}) {
  const b = new Uint8Array(CI.size), v = new DataView(b.buffer);
  put(v, field(CI, 'P').off, 2, p); put(v, field(CI, 'Q').off, 2, q); put(v, field(CI, 'BELL').off, 4, bell);
  const at = CI_ARRIVALS + positionOf(a.faction) * AR.size;
  const w = (name, val) => { const f = field(AR, name); put(v, at + f.off, f.len, val); };
  w('HOST_ID', a.hostId); w('TROOPS', a.troops); w('STAMINA', a.stamina); w('RETREAT', a.retreat ?? 0); w('DEALT', a.dealt ?? 0);
  w('FACTION', a.faction); w('UNIT', a.unit); w('TILE', a.tile); w('STANCE', a.stance ?? 0); w('PRESENT', 1);
  return b;
}

/**
 * The Province bytes with the entry of `hostId` cleared (a march inside its
 * own Province: the host leaves its place among the residents to arrive, as
 * hud/forecast.mjs does with the residents it builds).
 */
export function withoutEntry(provinceBytes, hostId) {
  const b = Uint8Array.from(provinceBytes), v = new DataView(b.buffer);
  const id = BigInt(hostId), idOff = field(ENTRY, 'ID').off, stOff = field(ENTRY, 'STATE').off;
  for (let i = 0; i < ENTRIES_N; i++) {
    const o = PV_ENTRIES + i * ENTRY.size;
    if (v.getBigUint64(o + idOff, true) === id && b[o + stOff] !== 0) b.fill(0, o, o + ENTRY.size);
  }
  return b;
}

/**
 * The forecast of hud/forecast.mjs (`{ok, runs, troops: {min, max,
 * start}, fates, certain}`), its clash built by the program's model:
 * `provinceBytes` the destination's Province as served; `wornBps` the tower
 * wear of the planned walk (s1walk.mjs `wearBps(marchWatch(…))`, 0 when it
 * meets none). Adds `worn: {bps, troops}` (whole troops before and after
 * the wear) and `destroyedOnWay` when the wear alone leaves under half a troop (DESTROYED_BELOW).
 */
export function modelForecast(kernel, c, provinceBytes, faction, { wornBps = 0, runs = FORECAST_RUNS } = {}) {
  if (!kernel || !c?.host || !c.dest || !provinceBytes || !Number.isInteger(c.arriveBell)) return { ok: false, why: 'NoInput' };
  const a0 = forecastInputs(c, faction).arrivals[0];
  const troops = wear(a0.troops, wornBps);
  const worn = { bps: wornBps, before: Math.floor(a0.troops / 1000), after: Math.floor(troops / 1000) };
  if (troops < DESTROYED_BELOW) return { ok: true, runs: 1, troops: { min: 0, max: 0, start: c.host.troops }, fates: { Destroyed: 1 }, certain: true, worn, destroyedOnWay: true };
  const arrival = { ...a0, troops };
  const ci = inputsBytes(arrival, { p: c.dest.p, q: c.dest.q, bell: c.arriveBell });
  const pv = withoutEntry(provinceBytes, c.host.id);
  const id = String(c.host.id);
  let min = Infinity, max = -Infinity;
  const fates = {};
  for (let i = 0; i < runs; i++) {
    const seed = sha256('PS-FRONTIER-FORECAST', new TextEncoder().encode(`${id}:${c.dest.p},${c.dest.q},${c.dest.tile}:${c.arriveBell}:${i}`));
    const r = kernel.call('resolve_from_inputs', { province: pv, inputs: ci, bell: c.arriveBell, seed });
    if (!r.ok) return { ok: false, why: 'Refused', reason: r.reason ?? r.value ?? null };
    const out = decodeClashOut(r.value).outcome;
    const me = out.fighters.find(f => f.arrival && String(f.id) === id);
    if (!me) return { ok: false, why: 'NoFighter' };
    const left = Math.floor(Number(me.troops) / 1000);
    min = Math.min(min, left); max = Math.max(max, left);
    fates[me.fate.kind] = (fates[me.fate.kind] ?? 0) + 1;
  }
  // (`certain` as hud/forecast.mjs means it: no daily review of the camp at that turn, which could change the defenders)
  let certain = true;
  try { certain = dayOf(c.arriveBell) < Number(decode('Province', provinceBytes).camp?.nextCheckDay ?? 0); } catch { certain = false; }
  return { ok: true, runs, troops: { min, max, start: c.host.troops }, fates, certain, worn };
}
