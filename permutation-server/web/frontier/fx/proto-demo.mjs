// Sample RECORDS of the banner rule's PROTOTYPE for the demo switch (fx/demo.mjs,
// `?fx=proto-…`): each sample lays records in the shapes of PROTOTYPE-SPEC.md
// section 6 round the viewer's own village and gives the map the model that
// proto/board-model.mjs reads from them, so the board draws a sample through
// the same function and the same painters as the sample world's records. The
// demo's corner tag and the prototype's own label are both on screen for as
// long as a sample shows. Nothing here is a rule: the tiles of a sample patch
// are chosen by hand for the picture.
import { L } from '../../lang.mjs';
import { locate, tileHex } from '../fgeo.mjs';
import { FS } from '../fstate.mjs';
import { hostId } from '../faddr.mjs';
import { protoBoardModel } from '../proto/board-model.mjs';
import { clock } from './clock.mjs';

const RING = [[0, 0], [1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];
/** The way each side lies on the board (screen x, y). */
const SIDES = Object.freeze({ east: [1, 0], west: [-1, 0], south: [0, 1], north: [0, -1] });
const homeOf = () => (FS.holdings ?? []).find(h => Number.isInteger(h?.tile)) ?? null;
/** The viewer's home as the samples need it: `{home, hex, idx(dq, dr) → tile index in the home province or null, passable(idx)}`, or null without a village. */
function ground() {
  const home = homeOf(), hex = home ? tileHex(home.p, home.q, home.tile) : null;
  if (!home || !hex) return null;
  const pv = FS.provinces?.get?.(`${home.p},${home.q}`)?.province ?? null;
  const idx = (dq, dr) => { const l = locate(hex.q + dq, hex.r + dr); return l.p === home.p && l.q === home.q ? l.idx : null; };
  const passable = i => { try { return pv ? ((BigInt(pv.passableMask ?? 0) >> BigInt(i)) & 1n) === 1n : true; } catch { return true; } };
  const sites = new Set(Array.from(pv?.sites ?? FS.terrainOf?.(home.p, home.q)?.sites ?? []));
  return { home, hex, idx, passable, sites };
}
/** The place of a sample banner on side `side`: the spot three to five tiles from the village that lies most nearly that way, whose flower lies in the home province on passable ground clear of `taken`: `[dq, dr]`. */
export function protoSpot(side = 'east', taken = []) {
  const G = ground(), [wx, wy] = SIDES[side] ?? SIDES.east;
  const far = (a, b) => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[0] + a[1] - b[0] - b[1]));
  const list = [];
  for (let dq = -5; dq <= 5; dq++) for (let dr = -5; dr <= 5; dr++) {
    const d = far([dq, dr], [0, 0]);
    if (d < 3 || d > 5) continue;
    const x = Math.sqrt(3) * (dq + dr / 2), y = 1.5 * dr, len = Math.hypot(x, y);
    list.push({ at: [dq, dr], score: (1 - (x * wx + y * wy) / len) * 3 + (d - 3) * 0.35 });
  }
  list.sort((a, b) => a.score - b.score);
  if (!G) return list[0].at;
  const ok = ([dq, dr], whole) => { const pole = G.idx(dq, dr); if (pole === null || !G.passable(pole) || G.sites.has(pole)) return false; if (taken.some(t => far(t, [dq, dr]) < 3)) return false; return !whole || RING.every(([a, b]) => { const i = G.idx(dq + a, dr + b); return i !== null && !G.sites.has(i); }); };
  return (list.find(s => ok(s.at, true)) ?? list.find(s => ok(s.at, false)) ?? list[0]).at;
}
/** The tiles a sample march from the village to `at` crosses last (its tail), nearest the village first: `n` offsets on the straight way, outside the flower. */
function tailOf(at, n = 2) {
  const [dq, dr] = at, d = Math.max(Math.abs(dq), Math.abs(dr), Math.abs(dq + dr)), out = [];
  for (let k = d - 1 - n; k < d - 1; k++) { if (k < 2) continue; const t = k / d; let q = dq * t, r = dr * t, s = -q - r; let rq = Math.round(q), rr = Math.round(r); const rs = Math.round(s); const a = Math.abs(rq - q), b = Math.abs(rr - r), c = Math.abs(rs - s); if (a > b && a > c) rq = -rr - rs; else if (b > c) rr = -rq - rs; out.push([rq, rr]); }
  return out.filter(([q, r]) => Math.max(Math.abs(q - dq), Math.abs(r - dr), Math.abs(q + r - dq - dr)) > 1);
}

/**
 * The records of a sample scene, then the model. `S` = `{turn (resolvedNext, offset from now), banners: [{slot, at,
 * tail?, nation?, mine?, firm?, border?, frayed?, walkIn?, strikeIn?, contested?: {nation, host, since, at}}],
 * trails: [{host (seq), tiles: [[dq, dr]]}], rising: [{host (seq | text), nation?, at, since, canAt, n}], events}`.
 */
export function protoSampleModel(S) {
  const G = ground();
  if (!G) return null;
  const { home, idx } = G, me0 = Number.isInteger(FS.citizen?.faction) ? FS.citizen.faction : 0;
  const T = (FS.nowBell ?? 42) + (S.turn ?? 0);
  const hid = seq => String(hostId({ p: home.p, q: home.q, site: home.site, gen: home.gen ?? 0, seq }));
  const claim = new Array(61).fill(0xff);
  for (const [a, b] of RING) { const i = idx(a, b); if (i !== null && (i === home.tile || !G.sites.has(i))) claim[i] = home.site; }
  const banners = [], mine = [], counted = [0, 0, 0, 0, 0, 0];
  // (the tiles a sample banner at `at` with tail `tail` holds: its flower and tail on open ground of the home province)
  const patchOf = (at, tail = []) => [...RING.map(([a, c]) => [at[0] + a, at[1] + c]), ...(tail ?? [])].map(([q, r]) => idx(q, r)).filter((i, n, all) => i !== null && claim[i] === 0xff && !G.sites.has(i) && all.indexOf(i) === n);
  counted[me0] += claim.filter(v => v === home.site).length;
  for (const b of S.banners ?? []) {
    const tiles = patchOf(b.at, b.tail);
    const pole = idx(b.at[0], b.at[1]);
    if (pole === null || !tiles.includes(pole)) continue;
    for (const i of tiles) claim[i] = 16 + b.slot;
    const nation = b.mine ? me0 : b.nation ?? me0, c = b.contested ?? null;
    banners.push({ slot: b.slot, pole, nation, holder: b.mine ? 'sample-viewer' : `sample-${nation}-${b.slot}`, tiles, raisedTurn: T - 20, tendedTurn: T - 20, firm: b.firm ?? nation === me0, border: b.border ?? [], frayed: !!b.frayed,
      walkDue: T + (b.walkIn ?? 400), strikeAt: T + (b.strikeIn ?? (b.walkIn ?? 400) + 72), dressedToday: false, elbowLockedUntil: null,
      contested: c ? { nation: c.nation, host: typeof c.host === 'number' ? hid(c.host) : String(c.host), sinceTurn: T + c.since, canTakeAtTurn: T + c.at } : null });
    if (!b.frayed) counted[nation] += tiles.length;
    if (b.mine) mine.push({ p: home.p, q: home.q, slot: b.slot });
  }
  const land = { resolvedNext: T, claim, banners, holderNation: me0, counted, paid: counted,
    trails: (S.trails ?? []).map(t => ({ host: hid(t.host), nation: me0, tiles: t.tiles.map(([q, r]) => idx(q, r)).filter(i => i !== null) })),
    rising: (S.rising ?? []).map(r => ({ host: typeof r.host === 'number' ? hid(r.host) : String(r.host), nation: r.nation ?? me0, tile: idx(r.at[0], r.at[1]), sinceTurn: T + r.since, canRaiseAtTurn: T + r.canAt, tiles: patchOf(r.at, r.tail).length })).filter(r => r.tile !== null) };
  // (the label is the record's own in the sample world; here it is the demo's copy of the same words, in the page's language)
  const label = L`試作ルール：旗（設計のみ・プログラム未実装）`;
  const sample = { world: 'sample', turnSecs: 20, proto: { claims: { rule: 'standing-ground', version: 'demo', label: { ja: label, en: label }, numbers: null } } };
  const owns = new Set([7, 8, 9, 10].map(hid));
  const previews = new Map();
  for (const r of S.rising ?? []) if (typeof r.host === 'number' && r.flower) previews.set(hid(r.host), { ok: true, p: home.p, q: home.q, tile: idx(r.at[0], r.at[1]), tiles: patchOf(r.at), trail: patchOf(r.at, r.tail).filter(i => !patchOf(r.at).includes(i)) });
  return protoBoardModel({ sample, provinces: [{ p: home.p, q: home.q, land }], me: { banners: mine, cap: 5, perProvince: 2 }, events: (S.events ?? []).map((e, i) => ({ kind: 'PROTO_LAND', proto: true, seq: 1000 + i, p: home.p, q: home.q, turn: T, ...e })), previews,
    viewer: { nation: me0, villages: [{ p: home.p, q: home.q, site: home.site, tile: home.tile }], ownsHost: id => owns.has(String(id)), hostAt: id => { const r = (S.hosts ?? []).find(h => hid(h.seq) === String(id)); const i = r ? idx(r.at[0], r.at[1]) : null; return i !== null && i !== undefined ? { p: home.p, q: home.q, tile: i } : null; } },
    siteTiles: () => [...G.sites], levelAt: S.levelAt ?? null });
}

let run = null;
/**
 * Start a sample on `map`: `scene(t)` gives the scene at demo second `t` as `{key, since (the demo second its records
 * came), …S, preview?}`; the map is given the model again whenever the key changes (`protoApply`, called by the demo
 * switch on its clock). Null takes the sample away.
 */
export function protoStart(map, scene = null) {
  if (run?.map && run.map !== map) { try { run.map.setProto(null); run.map.showRaisePreview(null); } catch { /* a map that is gone */ } }
  if (!scene) { if (run) { try { map?.setProto?.(null); map?.showRaisePreview?.(null); } catch { /* no map */ } } run = null; return; }
  run = { map, scene, applied: null, word: null };
  try { map?.setProto?.(null); map?.showRaisePreview?.(null); } catch { /* no map */ }
  protoApply();
}
/** Bring the map's model to the demo clock's present second (every step of a sample is a change of records at a known second, so a frame can be sought). */
export function protoApply() {
  if (!run?.map?.setProto || !homeOf()) return;
  const t = clock.now(), steps = [];
  for (let s = 0; ; s += 0.05) { const S = run.scene(Math.min(t, s)); if (S && S.key !== steps[steps.length - 1]?.key) steps.push(S); if (s >= t) break; }
  const keys = steps.map(x => x.key), word = L`試作`;
  const had = run.applied ?? [], grows = run.word === word && had.length <= keys.length && had.every((k, i) => k === keys[i]);
  if (grows && had.length === keys.length) return;
  // (the clock was taken back, or the language changed: the run begins again from its first records)
  if (!grows) run.map.setProto(null);
  for (const S of steps.slice(grows ? had.length : 0)) {
    const sv = (() => { try { return run.map.sampled?.(run.map.source?.())?.survey ?? null; } catch { return null; } })();
    const model = protoSampleModel({ ...S, levelAt: sv && !sv.showAll && sv.levelAt ? sv.levelAt : null });
    if (model) run.map.setProto(model, { at: (S.since ?? 0) * 1000 });
    const G = ground(), P = S.preview ?? null;
    run.map.showRaisePreview(P && G ? { ...P.answer, tiles: (P.flower ? RING.map(([a, c]) => G.idx(P.at[0] + a, P.at[1] + c)) : []).filter(i => i !== null), trail: (P.tail ?? []).map(([q, r]) => G.idx(q, r)).filter(i => i !== null), p: G.home.p, q: G.home.q, tile: G.idx(P.at[0], P.at[1]) } : null);
  }
  run.applied = keys; run.word = word;
}
/** A sample scene's tail for a banner at `at` (the demo's own choice of tiles). */
export const protoTail = tailOf;
/** A sample answer of the preview route that refuses with `name` (the route's own refusal names: PROTOTYPE-SPEC section 5; the tile says them in map/protowords.mjs). */
export const protoRefusal = name => Object.fromEntries([['ok', false], ['code', String(name)]]);
