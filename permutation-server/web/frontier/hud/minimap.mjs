// The minimap and the lenses (UI plan C3, C4; Civ's minimap with its lens
// buttons): the whole open world in a corner of the map — each province a
// hex in the colour of the realm that holds most of it (land colour when
// nobody does), the Concord at the centre, clouds beyond the rim, clashes
// of this bell as red dots, the viewer's holdings ringed, and the part of
// the world the map shows as a frame. A press moves the map there.
//
// Lenses change what the main map stresses (one at a time, keys 1–4):
//   realm    the factions' lands (the default)
//   war      hosts and clashes: realm washes faint, host counts per province
//   land     the land itself: no washes
//   settle   free sites and crowding: where a new holding could go
// Drawn from the overviews only (no province loads): cheap for spectators.
import { L } from '../../lang.mjs';
import { provincePixel, PROVINCE_CIRCUMRADIUS } from '../map/layers.mjs';
import { project, RADIUS } from '../../map.mjs';
import { ringProvinces, tileHex, TILE_OFFSETS } from '../fgeo.mjs';
import { hexKey, keyHex } from '../map/survey.mjs';
import { landTiles } from '../map/ownland.mjs';
import { FACTION_FILL, FACTION_DARK } from '../people/avatar.mjs';

export const LENSES = Object.freeze(['realm', 'war', 'land', 'settle']);
export const LENS_TEXT = { realm: () => L`領土`, war: () => L`軍事`, land: () => L`地形`, settle: () => L`空き地` };
/** The lens chips' icons (hud/icons.mjs). */
export const LENS_ICON = { realm: 'banner', war: 'swords', land: 'mountain', settle: 'tent' };
export const MINIMAP_PX = 188;

const LAND = '#6f8f55', CLOUD = '#e8ecef';
/** The tile index of a province's centre. */
const CENTRE_TILE = TILE_OFFSETS.findIndex(o => o.q === 0 && o.r === 0);
/** The survey's materials at this size (map/survey.mjs): the chart, surveyed land out of sight, land in sight, the viewer's gold. */
export const MINI_SURVEY = Object.freeze({ chart: '#d8caa5', line: 'rgba(96,80,48,.45)', surveyed: '#7d8a70', sight: '#8fb866', you: '#f3d58a', engine: '#f4efe0', engineInk: '#17302b' });

/** The faction that holds most of a province's sites in an overview record, or null. */
export function majority(rec) {
  const n = Array(6).fill(0);
  rec.owners.forEach((f, j) => { if (rec.sites[j] === 1 && f < 6) n[f]++; });
  const m = Math.max(...n);
  return m > 0 ? n.indexOf(m) : null;
}

/** The minimap's world-to-pixel transform for `rings` open rings in a `px` square. */
export function frameOf(rings, px = MINIMAP_PX) {
  const d = Math.max(1, rings);
  const far = provincePixel(d, 0);
  const span = (Math.hypot(far.x, far.y) + PROVINCE_CIRCUMRADIUS * 1.2) * 2;
  const k = px / span;
  return { k, toPx: (x, y) => ({ x: px / 2 + x * k, y: px / 2 + y * k }), toWorld: (sx, sy) => ({ x: (sx - px / 2) / k, y: (sy - px / 2) / k }) };
}

/**
 * Paint the minimap into a 2D context of `px` × `px` (device pixels via
 * `dpr`): `{recs: Map "P,Q" → overview record, rings, own: [{p, q}], view,
 * size}` (`view` and `size` the main map's, for the frame).
 */
export function paintMinimap(ctx, { recs, rings, own = [], view = null, size = null, quad = null, px = MINIMAP_PX, dpr = 1, lens = 'realm', pins = [], survey = null, now = 0 }) {
  // with a survey (the play page): the open world is chart, the surveyed tiles are painted on it, and the
  // viewer is a gold pip that breathes; without one (the spectator) every province shows its realm, as before
  const limited = !!survey && !survey.showAll;
  const fr = frameOf(rings + 1, px);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, px, px);
  const g = ctx.createRadialGradient(px / 2, px / 2, px * 0.1, px / 2, px / 2, px * 0.72);
  g.addColorStop(0, '#24403b'); g.addColorStop(1, '#0f1f1c');
  ctx.fillStyle = g; ctx.beginPath(); ctx.arc(px / 2, px / 2, px / 2 - 1, 0, Math.PI * 2); ctx.fill();
  const r = PROVINCE_CIRCUMRADIUS * fr.k * 1.02;
  const hex = (cx, cy, rr) => { ctx.beginPath(); for (let i = 0; i < 6; i++) { const a = Math.PI / 6 + (i * Math.PI) / 3; const x = cx + Math.cos(a) * rr, y = cy + Math.sin(a) * rr; i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); } ctx.closePath(); };
  const all = [{ p: 0, q: 0, d: 0 }];
  for (let d = 1; d <= rings; d++) for (const pr of ringProvinces(d)) all.push({ ...pr, d });
  for (const pr of all) {
    const c = (pp => fr.toPx(pp.x, pp.y))(provincePixel(pr.p, pr.q));
    const rec = recs.get(`${pr.p},${pr.q}`);
    const owner = rec ? majority(rec) : null;
    hex(c.x, c.y, r);
    const sv = limited && rec ? survey.province(pr.p, pr.q) : null;
    ctx.fillStyle = !rec ? CLOUD : limited ? MINI_SURVEY.chart : pr.d === 0 ? '#e6dcc2' : owner !== null && lens !== 'land' ? FACTION_FILL[owner] : LAND;
    ctx.globalAlpha = !rec ? 0.55 : !limited && lens === 'war' && owner !== null ? 0.55 : 1;
    ctx.fill();
    ctx.globalAlpha = 1;
    if (limited && rec) { ctx.strokeStyle = MINI_SURVEY.line; ctx.lineWidth = 0.6; ctx.stroke(); }
    // (the lenses' marks: of provinces the viewer has surveyed; a clash only where the province's centre is in sight, as on the map)
    if (sv && (lens === 'settle' ? sv.max < 2 : survey.levelOf(pr.p, pr.q, CENTRE_TILE) < 3)) continue;
    if (lens === 'settle' && rec) {
      const free = rec.sites.filter(s => s === 0).length;
      if (free) { ctx.fillStyle = '#f3d58a'; ctx.beginPath(); ctx.arc(c.x, c.y, Math.min(r * 0.6, 1 + free * 0.5), 0, Math.PI * 2); ctx.fill(); }
    }
    if (rec?.clash && (lens === 'war' || lens === 'realm')) { ctx.fillStyle = '#ff5a3c'; ctx.beginPath(); ctx.arc(c.x, c.y, Math.max(1.6, r * 0.32), 0, Math.PI * 2); ctx.fill(); }
  }
  if (limited) {
    // the surveyed tiles, one small mark each: muted where out of sight, bright where in sight
    const w = Math.max(1.3, RADIUS * 1.74 * fr.k), h = Math.max(1.3, RADIUS * 1.2 * fr.k);
    for (const level of [2, 3]) {
      ctx.fillStyle = level === 3 ? MINI_SURVEY.sight : MINI_SURVEY.surveyed;
      for (const [k, lv] of survey.tiles) { if (lv !== level) continue; const t = keyHex(k), at = project(t.q, t.r), c = fr.toPx(at.x, at.y); ctx.fillRect(c.x - w / 2, c.y - h / 2, w, h); }
    }
    // the viewer's own land, in the nation's colour (the land a village works: map/ownland.mjs landTiles), under a hair of gold
    const nation = Number.isInteger(survey.faction) ? FACTION_FILL[survey.faction] : null;
    if (nation) for (const v of survey.villages ?? []) {
      const hx = Number.isInteger(v.tile) ? tileHex(v.p, v.q, v.tile) : null;
      if (!hx) continue;
      ctx.fillStyle = nation;
      for (const t of landTiles({ q: hx.q, r: hx.r, tier: v.tier ?? 0 })) { if ((survey.tiles.get(hexKey(t.q, t.r)) ?? 0) < 2) continue; const at = project(t.q, t.r), c = fr.toPx(at.x, at.y); ctx.fillRect(c.x - w / 2 - 0.3, c.y - h / 2 - 0.3, w + 0.6, h + 0.6); }
    }
    // the Engine: the one landmark everyone has. A small bell tower in ivory and slate, never gold (gold is the viewer's own mark)
    const ex = px / 2, ey = px / 2;
    ctx.fillStyle = MINI_SURVEY.engine; ctx.strokeStyle = MINI_SURVEY.engineInk; ctx.lineWidth = 1; ctx.lineJoin = 'round';
    ctx.beginPath(); ctx.moveTo(ex, ey - 6.5); ctx.lineTo(ex + 2.6, ey - 2.2); ctx.lineTo(ex + 1.9, ey - 2.2); ctx.lineTo(ex + 1.9, ey + 2.6); ctx.lineTo(ex - 1.9, ey + 2.6); ctx.lineTo(ex - 1.9, ey - 2.2); ctx.lineTo(ex - 2.6, ey - 2.2); ctx.closePath(); ctx.fill(); ctx.stroke();
  } else for (const o of own) {
    const c = (pp => fr.toPx(pp.x, pp.y))(provincePixel(o.p, o.q));
    ctx.strokeStyle = '#fffaf0'; ctx.lineWidth = 2; hex(c.x, c.y, r * 1.05); ctx.stroke();
  }
  // the viewer's pins: gold dots with a dark rim
  for (const pn of pins) {
    const c = (pp => fr.toPx(pp.x, pp.y))(provincePixel(pn.p, pn.q));
    ctx.fillStyle = '#f3d58a'; ctx.strokeStyle = '#3a2a08'; ctx.lineWidth = 1.2; ctx.beginPath(); ctx.arc(c.x, c.y, 3.2, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  }
  // the part of the world the map shows: under a tilted board a trapezoid (`quad`: its four corners in world px, map.viewQuad())
  if (quad?.length === 4) {
    const lim = v => Math.max(1, Math.min(px - 1, v));
    ctx.strokeStyle = '#f3d58a'; ctx.lineWidth = 1.6; ctx.lineJoin = 'round';
    ctx.beginPath();
    quad.forEach((w, i) => { const c = fr.toPx(w.x, w.y); i ? ctx.lineTo(lim(c.x), lim(c.y)) : ctx.moveTo(lim(c.x), lim(c.y)); });
    ctx.closePath(); ctx.stroke();
  } else if (view && size) {
    const a = fr.toPx(view.x - size.width / 2 / view.zoom, view.y - size.height / 2 / view.zoom);
    const b = fr.toPx(view.x + size.width / 2 / view.zoom, view.y + size.height / 2 / view.zoom);
    ctx.strokeStyle = '#f3d58a'; ctx.lineWidth = 1.6;
    ctx.strokeRect(Math.max(1, a.x), Math.max(1, a.y), Math.min(px - 2, b.x) - Math.max(1, a.x), Math.min(px - 2, b.y) - Math.max(1, a.y));
  }
  // where the viewer is: the active village, in gold, breathing
  const home = limited && survey.home ? tileHex(survey.home.p, survey.home.q, survey.home.tile) : null;
  if (home) {
    const at = project(home.q, home.r), c = fr.toPx(at.x, at.y), u = ((now / 1000) % 1.8) / 1.8;
    ctx.strokeStyle = `rgba(243,213,138,${0.85 * (1 - u)})`; ctx.lineWidth = 1.6; ctx.beginPath(); ctx.arc(c.x, c.y, 3.5 + u * 8, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = MINI_SURVEY.you; ctx.strokeStyle = '#2a1e06'; ctx.lineWidth = 1.4; ctx.beginPath(); ctx.arc(c.x, c.y, 3.4, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  }
  ctx.strokeStyle = 'rgba(217,180,74,.7)'; ctx.lineWidth = 1.2; ctx.beginPath(); ctx.arc(px / 2, px / 2, px / 2 - 1, 0, Math.PI * 2); ctx.stroke();
}

/** Faction colours for the dark border inks (used by the main map's war lens). */
export { FACTION_DARK };
