// Direction A, 「卓上の箱庭」 (the living diorama on the surveyor's table): the client's own painted land, kept and
// put in order. The baked tiles, the code-drawn relief, villages and figures are the client's (imported from
// permutation-server/web/frontier); what this direction changes is the hierarchy:
//   - the grid is a breath at rest and a crisp lattice only where an order can go;
//   - the stage-1 things stand in the villages' hand (map/structures.mjs, new);
//   - one warm light from the upper left, one shadow direction, one ink;
//   - routes are flat ribbons of ink with a tick at every turn they take, sealed ones dashed;
//   - a tower's watch is a soft veil with a dashed rim, not a ring of hexes.
import { paintMountain, paintMountainShadow, paintTree, woodOf, paintWoodFloor } from '../../../../permutation-server/web/frontier/map/relief.mjs';
import { paintVillage } from '../../../../permutation-server/web/frontier/map/village.mjs';
import { paintVaultArt, paintTowerArt, paintPalisadeArt, paintFortArt, paintCartArt } from '../../../../permutation-server/web/frontier/map/structures.mjs';
import { paintMini } from '../../../../permutation-server/web/frontier/people/minis.mjs';
import { BACK_TO_FRONT, TILES, tileAt, project, hexCorners, VILLAGES, HOSTS, STRUCTURES, RADIUS, FLATTEN, cameraOf, landOf, outlineOf, strokeEdges, hexPath, smooth, along, routePoints, decision, NATION, sigil, image, dist, key } from './common.mjs';
import { CARAVANS, SEALED, reachOf, ROAD } from './scene.mjs';

const ART = new URL('../../../../permutation-server/web/frontier/art/', import.meta.url).href;
const NAME = { Grassland: 'grassland', Plains: 'plains', Forest: 'forest', Hills: 'hills', Mountain: 'mountain', Water: 'water' };
const TOP_LIFT = 0.24 * Math.sqrt(1 - FLATTEN * FLATTEN) * RADIUS;
const MINI = { Pikeman: 'pikeman', Scout: 'scout', Crossbowman: 'crossbowman', Spearman: 'spearman', Knight: 'knight' };

export const META = {
  id: 'A', title: '卓上の箱庭', sub: 'The living diorama',
  idea: '測量士の卓に広げた、描きこまれた箱庭。いまのクライアントの絵（焼き込みの地形、コードで描く山・森・村）を土台に、階層と光と線を整える。',
};

export function paint(g, w, h, { frame, state, t = 0, redraw }) {
  const cam = cameraOf(frame, w, h);
  // ---- the table and the sheet
  g.fillStyle = '#16251f'; g.fillRect(0, 0, w, h);
  const lamp = g.createRadialGradient(w * 0.42, h * 0.38, 40, w * 0.5, h * 0.5, Math.max(w, h) * 0.75);
  lamp.addColorStop(0, 'rgba(255,226,170,.18)'); lamp.addColorStop(1, 'rgba(0,0,0,.35)');
  g.save(); g.translate(cam.ox, cam.oy); g.scale(cam.s, cam.s);
  // the sheet under the land (parchment), so the patch's edge is a map's edge
  g.fillStyle = '#e6d9b8';
  for (const t0 of TILES) { hexPath(g, t0.x, t0.y, RADIUS * 1.02); g.fill(); }
  // ---- ground: the baked tiles, back to front
  for (const tile of BACK_TO_FRONT) {
    const img = image(`${ART}terrain/@2x/${NAME[tile.terrain]}_${tile.v}.webp`, redraw);
    if (img) g.drawImage(img, tile.x - 44, tile.y + TOP_LIFT - 62, 88, 104);
    else { hexPath(g, tile.x, tile.y); g.fillStyle = '#b9b38a'; g.fill(); }
    if (tile.terrain === 'Hills' || tile.terrain === 'Water' || tile.terrain === 'Plains' || tile.terrain === 'Grassland') {
      const pr = image(`${ART}props/@2x/${NAME[tile.terrain]}_${tile.v}.webp`, redraw);
      if (pr) g.drawImage(pr, tile.x - 44, tile.y + TOP_LIFT - 62, 88, 104);
    }
  }
  // ---- roads (Province ROAD_MASK): a trodden way through the road tiles' middles
  const roadPts = (list) => list.map(k => tileAt.get(k)).filter(Boolean).map(t0 => ({ x: t0.x, y: t0.y }));
  for (const seg of [ROAD.slice(0, 6), ['-2,1', ...ROAD.slice(6)]]) {
    const p = roadPts(seg);
    for (const [lw, c] of [[11, 'rgba(96,74,40,.28)'], [7, 'rgba(214,190,136,.92)'], [2, 'rgba(240,224,182,.7)']]) { g.beginPath(); smooth(g, p); g.strokeStyle = c; g.lineWidth = lw; g.lineCap = 'round'; g.stroke(); }
  }
  // ---- the nations' land: a band of colour inside the border, a three-stroke border for the viewer's own
  for (const v of VILLAGES) {
    const land = landOf(v), edges = outlineOf(land);
    g.save();
    g.globalCompositeOperation = 'soft-light';
    for (const t0 of land) { hexPath(g, t0.x, t0.y); g.fillStyle = NATION.fill[v.faction] + (v.own ? '70' : '48'); g.fill(); }
    g.restore();
    g.lineJoin = 'round'; g.lineCap = 'round';
    if (v.own) {
      for (const [lw, c] of [[7, 'rgba(20,14,6,.55)'], [4.2, NATION.fill[v.faction]], [1.6, '#ffd24d']]) { g.strokeStyle = c; g.lineWidth = lw; strokeEdges(g, edges); }
    } else {
      for (const [lw, c] of [[4, 'rgba(20,14,6,.35)'], [2.4, NATION.fill[v.faction]]]) { g.strokeStyle = c; g.lineWidth = lw; strokeEdges(g, edges); }
    }
  }
  // ---- the grid: a breath at rest; the lattice of where an order can go when a host is in hand
  const d = decision(), reach = state !== 'rest' ? reachOf(d.host) : [];
  g.strokeStyle = 'rgba(40,36,20,.09)'; g.lineWidth = 0.8;
  for (const t0 of TILES) { hexPath(g, t0.x, t0.y); g.stroke(); }
  if (reach.length) {
    // outside the reach the land steps back a little; inside, a fine ivory lattice and one rim
    g.save(); g.fillStyle = 'rgba(14,20,18,.16)';
    const inReach = new Set(reach.map(r => r.k).concat(key(d.host.q, d.host.r)));
    for (const t0 of TILES) if (!inReach.has(t0.k)) { hexPath(g, t0.x, t0.y); g.fill(); }
    g.restore();
    g.strokeStyle = 'rgba(250,246,230,.5)'; g.lineWidth = 1;
    for (const r0 of reach) { hexPath(g, r0.x, r0.y, RADIUS * 0.97); g.stroke(); }
    const rim = outlineOf([...reach, tileAt.get(key(d.host.q, d.host.r))]);
    for (const [lw, c] of [[6, 'rgba(216,243,234,.25)'], [2.4, '#d8f3ea']]) { g.strokeStyle = c; g.lineWidth = lw; strokeEdges(g, rim); }
  }
  // ---- a tower's watch: a soft veil inside its range, a dashed rim (S1: it wears a march that passes)
  for (const s of STRUCTURES.filter(s0 => s0.kind === 'tower')) {
    const cover = TILES.filter(t0 => dist(t0, s) <= s.cover), c = project(s.q, s.r);
    const veil = g.createRadialGradient(c.x, c.y, 10, c.x, c.y, RADIUS * 3.2);
    veil.addColorStop(0, NATION.fill[s.faction] + '30'); veil.addColorStop(1, NATION.fill[s.faction] + '08');
    g.save(); g.beginPath(); for (const t0 of cover) { const p = hexCorners(t0.x, t0.y); p.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.closePath(); } g.fillStyle = veil; g.fill(); g.restore();
    g.setLineDash([6, 5]); g.strokeStyle = NATION.dark[s.faction]; g.lineWidth = 1.6; strokeEdges(g, outlineOf(cover)); g.setLineDash([]);
  }
  // ---- what stands: back to front (mountains, woods, villages, structures, carts, hosts)
  const stand = [];
  for (const t0 of TILES) {
    if (t0.terrain === 'Mountain') stand.push({ y: t0.y + 6, fn: () => { paintMountainShadow(g, t0.x, t0.y + 6, RADIUS * 0.85); paintMountain(g, t0.x, t0.y + 6, RADIUS * 0.85, { variant: t0.v - 1 }); } });
    if (t0.terrain === 'Forest') {
      const trees = woodOf(t0.q, t0.r, t0.v);
      stand.push({ y: t0.y - 30, fn: () => paintWoodFloor(g, t0.x, t0.y, RADIUS, trees) });
      for (const tr of trees) stand.push({ y: t0.y + tr.y * RADIUS, fn: () => paintTree(g, t0.x + tr.x * RADIUS, t0.y + tr.y * RADIUS, RADIUS * 0.5 * tr.s, { kind: tr.kind, variant: tr.variant }) });
    }
  }
  for (const v of VILLAGES) { const c = project(v.q, v.r); stand.push({ y: c.y, fn: () => paintVillage(g, c.x, c.y, RADIUS * (v.own ? 1.7 : 1.35), { tier: v.tier, faction: v.faction, annex: v.annex }) }); }
  const ART_OF = { vault: paintVaultArt, tower: paintTowerArt, palisade: paintPalisadeArt, fort: paintFortArt };
  for (const s of STRUCTURES) { const c = project(s.q, s.r); stand.push({ y: c.y + 8, fn: () => ART_OF[s.kind](g, c.x + 4, c.y + 8, RADIUS * (s.kind === "palisade" ? 1.15 : 1.25), s) }); }
  for (const cv of CARAVANS) {
    const pts = routePoints(cv.path.map(k => tileAt.get(k)));
    const k0 = state === 'result' ? 0.62 : cv.share, p = along(pts, k0);
    stand.push({ y: p.y + 4, fn: () => paintCartArt(g, p.x, p.y + 4, RADIUS * 1.5, { ...cv, load: 'ore', dir: Math.cos(p.a) >= 0 ? 1 : -1 }) });
  }
  for (const ho of HOSTS) {
    const at = state === 'result' && ho.id === 'h1' ? { q: 5, r: -1 } : ho;
    if (state === 'result' && ho.id === 'e1') continue;
    const c = project(at.q, at.r);
    stand.push({ y: c.y + 12, fn: () => {
      if (ho.own) { g.strokeStyle = '#ffd24d'; g.lineWidth = 2.4; g.beginPath(); g.ellipse(c.x + 10, c.y + 13, 20, 20 * FLATTEN, 0, 0, Math.PI * 2); g.stroke(); }
      for (const [dx, dy] of [[0, 0], [16, 4], [-10, 7]]) paintMini(g, c.x + 10 + dx, c.y + 12 + dy, 30, MINI[ho.unit] ?? 'spearman', { faction: ho.faction, face: ho.own ? 1 : -1 });
    } });
  }
  stand.sort((a, b) => a.y - b.y).forEach(s => s.fn());
  // ---- the sealed march of another nation: its origin only, a seal and its arrival turn; never a line or a heading
  for (const m of SEALED) {
    const c = project(m.fromQ, m.fromR);
    sealMark(g, c.x - 30, c.y - 52, NATION.fill[m.faction]);
  }
  // ---- the selected state: the host's ring, the three options' routes, the chosen one bold
  if (state === 'select' || state === 'result') {
    const opt = d.options[0], pts = routePoints(opt.route);
    if (state === 'select') {
      for (const o of d.options.slice(1)) ribbon(g, routePoints(o.route), { colour: 'rgba(250,246,230,.75)', width: 3, dash: [2, 6], ticks: 0 });
      ribbon(g, pts, { colour: '#c8402f', width: 5, ticks: opt.arrive - 42, sealed: true });
      // the target: an ember ring and a crossed-swords plate
      const tgt = project(d.target.q, d.target.r);
      g.strokeStyle = '#c8402f'; g.lineWidth = 2.6; hexPath(g, tgt.x, tgt.y, RADIUS * 0.94); g.stroke();
    }
  }
  g.restore();
  g.fillStyle = lamp; g.fillRect(0, 0, w, h);
  // ---- names and tags, flat over everything, at a size that does not scale with the board
  for (const v of VILLAGES) { const c = project(v.q, v.r); const [sx, sy] = [cam.ox + c.x * cam.s, cam.oy + (c.y - 64) * cam.s]; namePlate(g, sx, sy, v.name, v.faction, v.own, v.tier ? '町' : '集落'); }
  for (const cv of CARAVANS) {
    const pts = routePoints(cv.path.map(k => tileAt.get(k))), p = along(pts, state === 'result' ? 0.62 : cv.share);
    tag(g, cam.ox + p.x * cam.s, cam.oy + (p.y - 40) * cam.s, `隊商 鉱石 30 · ターン ${cv.arriveTurn} 着`, '#2b2416');
  }
  for (const m of SEALED) { const c = project(m.fromQ, m.fromR); tag(g, cam.ox + (c.x - 30) * cam.s, cam.oy + (c.y - 82) * cam.s, `${NATION.name[m.faction]}の軍 300 が出発 · ターン ${m.arriveTurn} に着く（行き先は封印中）`, '#3a1e4e'); }
  if (state === 'select') {
    const opt = d.options[0], end = project(opt.route[opt.route.length - 1].q, opt.route[opt.route.length - 1].r);
    tag(g, cam.ox + end.x * cam.s, cam.oy + (end.y - 48) * cam.s, `到着 ターン ${opt.arrive}`, '#5a1a12');
  }
}

/** A flat ribbon of ink with a tick at every turn boundary; dashed when sealed (the viewer's own seal). */
function ribbon(g, pts, { colour, width, dash = null, ticks = 0, sealed = false }) {
  g.save(); g.lineCap = 'round'; g.lineJoin = 'round';
  g.beginPath(); smooth(g, pts); g.strokeStyle = 'rgba(20,12,6,.45)'; g.lineWidth = width + 3; if (dash) g.setLineDash(dash); g.stroke();
  g.beginPath(); smooth(g, pts); g.strokeStyle = colour; g.lineWidth = width; if (sealed) g.setLineDash([10, 5]); g.stroke(); g.setLineDash([]);
  for (let i = 1; i <= ticks; i++) {
    const p = along(pts, i / (ticks + 0.0001) * 0.999), nx = -Math.sin(p.a), ny = Math.cos(p.a);
    g.strokeStyle = '#fff4dc'; g.lineWidth = 2; g.beginPath(); g.moveTo(p.x - nx * 7, p.y - ny * 7); g.lineTo(p.x + nx * 7, p.y + ny * 7); g.stroke();
  }
  const e = along(pts, 1);
  g.fillStyle = colour; g.beginPath(); g.moveTo(e.x + Math.cos(e.a) * 9, e.y + Math.sin(e.a) * 9); g.lineTo(e.x + Math.cos(e.a + 2.5) * 9, e.y + Math.sin(e.a + 2.5) * 9); g.lineTo(e.x + Math.cos(e.a - 2.5) * 9, e.y + Math.sin(e.a - 2.5) * 9); g.closePath(); g.fill();
  g.restore();
}

/** A wax seal: what is known of a sealed march at its origin. */
function sealMark(g, x, y, colour) {
  g.save();
  g.fillStyle = 'rgba(20,10,6,.35)'; g.beginPath(); g.ellipse(x + 2, y + 3, 15, 15, 0, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#8f2d22'; g.beginPath();
  for (let i = 0; i < 14; i++) { const a = i / 14 * Math.PI * 2, r = i % 2 ? 13 : 15; g.lineTo(x + Math.cos(a) * r, y + Math.sin(a) * r); }
  g.closePath(); g.fill();
  g.fillStyle = colour; sigil(g, 3, x, y, 8); g.fill();
  g.restore();
}

/** The villages' name plate (map/plates.mjs's look: serif name, tier chip, sigil). */
function namePlate(g, x, y, name, faction, own, tierWord) {
  g.save();
  g.font = '700 15px "Hiragino Mincho ProN", "Yu Mincho", serif';
  const tw = g.measureText(name).width, cw = 26, w = tw + cw + 34, h = 26;
  g.fillStyle = 'rgba(12,24,21,.9)'; roundRect(g, x - w / 2, y - h / 2, w, h, 6); g.fill();
  g.strokeStyle = own ? '#ffd24d' : 'rgba(201,162,74,.7)'; g.lineWidth = own ? 2 : 1; g.stroke();
  g.fillStyle = NATION.fill[faction]; g.beginPath(); g.arc(x - w / 2 + 14, y, 7.5, 0, Math.PI * 2); g.fill();
  g.fillStyle = NATION.on[faction]; sigil(g, faction, x - w / 2 + 14, y, 6); g.fill();
  g.fillStyle = '#f4efe0'; g.textBaseline = 'middle'; g.fillText(name, x - w / 2 + 26, y + 1);
  g.font = '700 11px system-ui, sans-serif'; g.fillStyle = 'rgba(244,239,224,.16)'; roundRect(g, x + w / 2 - cw - 6, y - 8, cw, 16, 3); g.fill();
  g.fillStyle = '#e9d9a8'; g.textAlign = 'center'; g.fillText(tierWord, x + w / 2 - cw / 2 - 6, y + 1);
  g.restore();
}
function tag(g, x, y, text, bg) {
  g.save(); g.font = '600 12px system-ui, "Hiragino Sans", sans-serif';
  const w = g.measureText(text).width + 16, h = 22;
  g.fillStyle = 'rgba(12,24,21,.88)'; roundRect(g, x - w / 2, y - h / 2, w, h, 11); g.fill();
  g.strokeStyle = 'rgba(201,162,74,.55)'; g.lineWidth = 1; g.stroke();
  g.fillStyle = '#f4efe0'; g.textBaseline = 'middle'; g.textAlign = 'center'; g.fillText(text, x, y + 1);
  g.restore();
}
export function roundRect(g, x, y, w, h, r) { g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); }
