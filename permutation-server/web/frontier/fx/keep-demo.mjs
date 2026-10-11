// Sample RECORDS of the keeps for the demo switch (fx/demo.mjs, `?fx=keep-…`):
// each sample lays records in the shapes the herald serves (the control
// record's `control`, `contender`, `progress`, `required` on a province, a
// `keep_taken` event of /h/conquest/{day}.json) over the page's own, at a real
// keep near the viewer's village, and gives them to the map's keep board
// (`map.setKeepSample`), so the board draws a sample through the same reader
// and the same painters as the chain's records (map/keeps.mjs). The demo's
// corner tag is on screen for as long as a sample shows. The numbers of a
// sample (a contest at 71 of 72 turns, the turn of a capture) follow the
// records of a finished season on the local test chain (keep 4,-1 of the
// run ux-check: contested from turn 12, taken at turn 83); nothing here is a
// rule, and nothing is shown on a page whose season is not a conquest season.
//
//   keep-reach      a fighting host in hand: the keeps it can reach are lit, the others dim
//   keep-contest    the viewer's nation holds a keep's tile: the dial fills turn by turn, then the hold is broken
//   keep-captured   the capture's record arrives: the standard is struck, the province floods, "+1 province"
//   keep-lost       the same, of a province of the viewer's nation taken by another
//
//   &fxkz=<zoom>    the camera's zoom on the sample's keep (default 1.0; 0.62 for keep-reach; `far`: the world chart)
import { project } from '../../map.mjs';
import { tileHex } from '../fgeo.mjs';
import { FS } from '../fstate.mjs';
import { keepRows, reachWhy } from '../map/keeps.mjs';
import { clock } from './clock.mjs';

const int = Number.isInteger;
const at = row => { const h = tileHex(row.p, row.q, row.tile); return h ? project(h.q, h.r) : { x: 0, y: 0 }; };
const near = (rows, pt) => rows.map(r => ({ r, d: Math.hypot(at(r).x - pt.x, at(r).y - pt.y) })).sort((a, b) => a.d - b.d).map(x => x.r);

/** The page's own records of the provinces, as the map reads them: Map "p,q" → province. */
function recsOf(map) {
  const out = new Map();
  let ovs = null;
  try { ovs = map?.source?.()?.overviews ?? null; } catch { ovs = null; }
  for (const ov of (ovs ?? FS.overviews ?? new Map()).values()) for (const r of ov.provinces ?? []) out.set(`${r.p},${r.q}`, r);
  return out;
}

/**
 * The sample scene `kind` at demo second `t` over the records `recs`: `{key, since, recs, events, viewer, bell,
 * reach?, target}`, or null where the records have no keep (not a conquest season). `viewer`: the viewer's nation
 * (0 without one); `home`: the world point the sample looks from (the viewer's village).
 */
export function keepScene(kind, t, { recs, viewer = 0, home = { x: 0, y: 0 }, turn = 83 } = {}) {
  const rows = keepRows(recs);
  if (!rows.length) return null;
  const me = int(viewer) && viewer >= 0 && viewer < 6 ? viewer : 0;
  const foreign = near(rows.filter(r => r.holder !== null && r.holder !== me), home), own = near(rows.filter(r => r.holder === me), home);
  const open = foreign.filter(r => !r.heartland);
  const target = kind === 'lost' ? own.find(r => !r.heartland) ?? own[0] : open[0] ?? foreign[0];
  if (!target) return null;
  const lay = change => { const m = new Map(recs); m.set(target.key, { ...recs.get(target.key), contestRequired: 72, ...change }); return m; };
  const base = { viewer: me, bell: turn, target: { p: target.p, q: target.q, tile: target.tile } };
  if (kind === 'reach') {
    const lit = open.slice(0, 3), far = open.slice(3, 9), guarded = foreign.filter(r => r.heartland).slice(0, 4);
    return { ...base, key: 'reach', since: 0, recs, events: [],
      // (the first lit keep is the `hot` one: the row of the card 砦へ進軍 under the pointer, a wider ring)
      reach: [...lit.map((r, i) => ({ p: r.p, q: r.q, tile: r.tile, arriveTurn: turn + 4 + i * 2, holder: r.holder, defenders: r.troops, reachable: true, why: null, hot: i === 0 })),
        ...far.map(r => ({ p: r.p, q: r.q, tile: r.tile, arriveTurn: null, holder: r.holder, defenders: r.troops, reachable: false, why: reachWhy.far() })),
        ...guarded.map(r => ({ p: r.p, q: r.q, tile: r.tile, arriveTurn: null, holder: r.holder, defenders: r.troops, reachable: false, why: reachWhy.heartland() }))] };
  }
  if (kind === 'contest') {
    // a turn is added every 0.8 s; after five the hold is broken (the record says the contest ended)
    const n = Math.min(4, Math.floor(t / 0.8));
    if (t < 4.6) return { ...base, key: `contest${n}`, since: n * 0.8, recs: lay({ contender: me, contestProgress: 12 + n }), events: [] };
    return { ...base, key: 'contest-broken', since: 4.6, recs: lay({ contender: 7, contestProgress: 0 }), events: [{ seq: '900002', kind: 'keep_broken', bell: turn, p: target.p, q: target.q, from: me, to: target.holder }] };
  }
  // a capture: the last turn of the hold, then the capture's record and the control record's new holder
  const taker = kind === 'lost' ? (near(foreign, at(target))[0]?.holder ?? (me + 1) % 6) : me, from = target.holder;
  if (t < 1.4) return { ...base, key: `${kind}0`, since: 0, recs: lay({ contender: taker, contestProgress: 71 }), events: [] };
  return { ...base, key: `${kind}1`, since: 1.4, recs: lay({ control: taker, contender: 7, contestProgress: 0 }), events: [{ seq: '900001', kind: 'keep_taken', bell: turn, p: target.p, q: target.q, from, to: taker }] };
}

let run = null;
/** Start sample `kind` on `map` ('reach' | 'contest' | 'captured' | 'lost'), or take the sample away (null). */
export function keepStart(map, kind = null) {
  if (run?.map && (run.map !== map || !kind)) { try { run.map.setKeepSample?.(null); } catch { /* a map that is gone */ } }
  if (!kind) { run = null; return; }
  run = { map, kind, applied: null, flown: false };
  try { map?.setKeepSample?.(null); } catch { /* no map */ }
  keepApply();
}
/** Bring the keep board's sample to the demo clock's present second (every step of a sample is a change of records at a known second, so a frame can be sought). */
export function keepApply() {
  const map = run?.map;
  if (!map?.setKeepSample) return;
  const recs = recsOf(map);
  if (!recs.size) return;
  const home = (() => { const h = (FS.holdings ?? []).find(x => int(x?.tile)); const hx = h ? tileHex(h.p, h.q, h.tile) : null; if (hx) return project(hx.q, hx.r); const v = map.view ?? { x: 0, y: 0 }; return { x: v.x, y: v.y }; })();
  const opts = { recs, viewer: int(FS.citizen?.faction) ? FS.citizen.faction : 0, home, turn: int(FS.nowBell) ? FS.nowBell : 83 };
  const t = clock.now(), steps = [];
  for (let s = 0; ; s += 0.05) { const S = keepScene(run.kind, Math.min(t, s), opts); if (S && S.key !== steps[steps.length - 1]?.key) steps.push(S); if (s >= t) break; }
  if (!steps.length) return;
  const keys = steps.map(x => x.key), had = run.applied ?? [], grows = had.length <= keys.length && had.every((k, i) => k === keys[i]);
  if (grows && had.length === keys.length) return;
  // (the clock was taken back: the run begins again from its first records)
  if (!grows) map.setKeepSample(null);
  for (const S of steps.slice(grows ? had.length : 0)) map.setKeepSample(S, { at: S.since * 1000 });
  run.applied = keys;
  // the camera goes to the sample's keep once (`&fxkz=`: its zoom, or `far` for the world chart)
  if (!run.flown && steps[0].target) {
    run.flown = true;
    const want = new URLSearchParams(globalThis.location?.search ?? '').get('fxkz');
    try {
      if (want === 'far') map.worldChart?.();
      else map.flyTo?.({ ...steps[0].target, zoom: Number(want) > 0 ? Number(want) : run.kind === 'reach' ? 0.62 : 1.0 }, 0);
    } catch { /* a map without a camera */ }
  }
}
