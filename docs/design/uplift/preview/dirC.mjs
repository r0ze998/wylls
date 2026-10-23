// Direction C, 「夜の軍議卓」 (the lamplit war table): the frontier as a carved relief on a dark table under one lamp.
// The land is low blocks of pale clay whose height is its terrain; the nations are enamel light along their borders;
// villages, stores and forts are carved blocks with an enamel cap; hosts are tokens with a sigil and a number;
// routes and watches are drawn in light. The strongest reading of war; the least of daily life.
import { TILES, tileAt, project, hexCorners, VILLAGES, HOSTS, STRUCTURES, RADIUS, FLATTEN, cameraOf, landOf, outlineOf, strokeEdges, hexPath, smooth, along, routePoints, decision, NATION, sigil, dist, key } from './common.mjs';
import { CARAVANS, SEALED, reachOf } from './scene.mjs';
import { roundRect } from './dirA.mjs';

export const META = {
  id: 'C', title: '夜の軍議卓', sub: 'The lamplit war table',
  idea: '暗い卓の上の、粘土の浮き彫り。一つの灯りで照らす。地形は高さで、国は境の光で、軍は駒で。戦況は最も読みやすいが、暮らしの気配は最も薄い。',
};

const HEIGHT = { Water: 0, Plains: 6, Grassland: 6, Forest: 9, Hills: 14, Mountain: 26 };
const CLAY = { Water: '#2f4a52', Plains: '#c9bc9c', Grassland: '#b8b796', Forest: '#8f9a7c', Hills: '#b9a787', Mountain: '#a39a8a' };
const shadeHex = (hex, k) => { const n = parseInt(hex.slice(1), 16); const c = [n >> 16, (n >> 8) & 255, n & 255].map(v => Math.max(0, Math.min(255, Math.round(v * k)))); return `rgb(${c.join(',')})`; };

export function paint(g, w, h, { frame, state }) {
  const cam = cameraOf(frame, w, h), d = decision();
  g.fillStyle = '#0f1214'; g.fillRect(0, 0, w, h);
  const lampX = w * 0.38, lampY = h * 0.3;
  g.save(); g.translate(cam.ox, cam.oy); g.scale(cam.s, cam.s);
  const lamp = (x, y) => { const sx = cam.ox + x * cam.s, sy = cam.oy + y * cam.s; return Math.max(0.45, 1.15 - Math.hypot(sx - lampX, sy - lampY) / (Math.max(w, h) * 0.85)); };
  // ---- the relief: back to front, each tile a block (its side faces, then its top)
  for (const t of [...TILES].sort((a, b) => a.y - b.y)) {
    const z = HEIGHT[t.terrain], c = hexCorners(t.x, t.y, RADIUS * 0.985), L = lamp(t.x, t.y);
    for (const i of [0, 1, 2]) {
      const a = c[i], b = c[(i + 1) % 6];
      g.fillStyle = shadeHex(CLAY[t.terrain], L * (i === 1 ? 0.55 : 0.7));
      g.beginPath(); g.moveTo(a[0], a[1] - z); g.lineTo(b[0], b[1] - z); g.lineTo(b[0], b[1] + 4); g.lineTo(a[0], a[1] + 4); g.closePath(); g.fill();
    }
    g.fillStyle = shadeHex(CLAY[t.terrain], L);
    g.beginPath(); c.forEach(([x, y], i) => (i ? g.lineTo(x, y - z) : g.moveTo(x, y - z))); g.closePath(); g.fill();
    g.strokeStyle = 'rgba(255,240,210,.12)'; g.lineWidth = 0.8; g.stroke();
    if (t.terrain === 'Mountain') { g.fillStyle = shadeHex('#c9c0ae', L); g.beginPath(); g.moveTo(t.x - 22, t.y - z + 6); g.lineTo(t.x - 2, t.y - z - 22); g.lineTo(t.x + 22, t.y - z + 6); g.closePath(); g.fill(); g.fillStyle = 'rgba(0,0,0,.25)'; g.beginPath(); g.moveTo(t.x - 2, t.y - z - 22); g.lineTo(t.x + 22, t.y - z + 6); g.lineTo(t.x + 4, t.y - z + 6); g.closePath(); g.fill(); }
    if (t.terrain === 'Forest') { g.fillStyle = shadeHex('#6f7d5f', L); for (const [dx, dy] of [[-14, -4], [0, -8], [14, -2], [-6, 8], [10, 8]]) { g.beginPath(); g.arc(t.x + dx, t.y - z + dy - 4, 7, 0, Math.PI * 2); g.fill(); } }
    if (t.terrain === 'Hills') { g.fillStyle = shadeHex('#cbb898', L); g.beginPath(); g.ellipse(t.x - 6, t.y - z - 2, 18, 8, 0, Math.PI, 0); g.fill(); if (t.ore) { g.fillStyle = '#e0c06a'; g.beginPath(); g.arc(t.x + 12, t.y - z + 4, 2.5, 0, Math.PI * 2); g.fill(); } }
    if (t.road) { g.fillStyle = 'rgba(255,236,190,.22)'; g.beginPath(); g.arc(t.x, t.y - z, 6, 0, Math.PI * 2); g.fill(); }
  }
  const top = t => t.y - HEIGHT[t.terrain];
  // ---- nations: enamel light along the border
  g.save(); g.globalCompositeOperation = 'lighter';
  for (const v of VILLAGES) {
    const edges = outlineOf(landOf(v)).map(([a, b]) => [[a[0], a[1] - 7], [b[0], b[1] - 7]]);
    g.shadowColor = NATION.fill[v.faction]; g.shadowBlur = 12; g.strokeStyle = NATION.fill[v.faction] + (v.own ? 'ff' : 'aa'); g.lineWidth = v.own ? 3 : 2; strokeEdges(g, edges);
  }
  g.restore();
  // ---- the tower's watch: a cone of light on the land
  for (const s of STRUCTURES.filter(s0 => s0.kind === 'tower')) {
    const c = project(s.q, s.r), gr = g.createRadialGradient(c.x, c.y, 10, c.x, c.y, RADIUS * 3.4);
    gr.addColorStop(0, NATION.fill[s.faction] + '55'); gr.addColorStop(1, NATION.fill[s.faction] + '00');
    g.save(); g.globalCompositeOperation = 'lighter'; g.fillStyle = gr; g.beginPath(); g.ellipse(c.x, c.y - 10, RADIUS * 3.4, RADIUS * 3.4 * FLATTEN, 0, 0, Math.PI * 2); g.fill(); g.restore();
  }
  // ---- reach: a chalk lattice and a lit rim
  if (state !== 'rest') {
    const reach = reachOf(d.host);
    g.strokeStyle = 'rgba(230,245,240,.35)'; g.lineWidth = 1;
    for (const t of reach) { g.beginPath(); hexCorners(t.x, t.y - HEIGHT[t.terrain], RADIUS * 0.92).forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.closePath(); g.stroke(); }
  }
  // ---- blocks: villages, structures (carved wood, an enamel cap)
  const block = (x, y, bw, bh, colour, capH = 4) => {
    g.fillStyle = '#6e5233'; g.fillRect(x - bw / 2, y - bh, bw, bh);
    g.fillStyle = '#8a6a44'; g.beginPath(); g.moveTo(x - bw / 2, y - bh); g.lineTo(x - bw / 2 + 6, y - bh - 5); g.lineTo(x + bw / 2 + 6, y - bh - 5); g.lineTo(x + bw / 2, y - bh); g.closePath(); g.fill();
    g.fillStyle = '#4f3a24'; g.beginPath(); g.moveTo(x + bw / 2, y); g.lineTo(x + bw / 2 + 6, y - 5); g.lineTo(x + bw / 2 + 6, y - bh - 5); g.lineTo(x + bw / 2, y - bh); g.closePath(); g.fill();
    g.fillStyle = colour; g.fillRect(x - bw / 2, y - bh, bw, capH);
  };
  const stand = [];
  for (const v of VILLAGES) { const c = project(v.q, v.r), t = tileAt.get(key(v.q, v.r)); stand.push({ y: c.y, fn: () => { block(c.x - 10, top(t) + 4, 16, 18, NATION.fill[v.faction]); block(c.x + 8, top(t) + 8, 20, v.tier ? 28 : 20, NATION.fill[v.faction]); block(c.x - 2, top(t) + 14, 12, 12, NATION.fill[v.faction]); } }); }
  for (const s of STRUCTURES) { const c = project(s.q, s.r), t = tileAt.get(key(s.q, s.r)); stand.push({ y: c.y, fn: () => { if (s.kind === 'palisade') { for (let k = -3; k <= 3; k++) block(c.x + k * 6, top(t) + 6 + k * 2, 4, 14, NATION.fill[s.faction], 2); } else block(c.x, top(t) + 6, s.kind === 'tower' ? 10 : 22, s.kind === 'tower' ? 34 : s.kind === 'fort' ? 18 : 12, NATION.fill[s.faction]); } }); }
  // ---- tokens: hosts and the caravan
  const token = (x, y, f, label, own, small = false) => {
    const r = small ? 10 : 14;
    g.fillStyle = 'rgba(0,0,0,.45)'; g.beginPath(); g.ellipse(x + 3, y + 4, r, r * 0.55, 0, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#2a2420'; g.beginPath(); g.ellipse(x, y + 2, r, r * 0.55, 0, 0, Math.PI * 2); g.fill();
    g.fillStyle = NATION.fill[f]; g.beginPath(); g.ellipse(x, y - 2, r, r * 0.55, 0, 0, Math.PI * 2); g.fill();
    if (own) { g.strokeStyle = '#ffd24d'; g.lineWidth = 2; g.stroke(); }
    g.fillStyle = NATION.on[f]; g.save(); g.translate(x, y - 2); g.scale(1, 0.6); sigil(g, f, 0, 0, r * 0.7); g.fill(); g.restore();
    if (label) { g.font = '700 11px ui-monospace, Menlo, monospace'; const tw = g.measureText(label).width + 8; g.fillStyle = 'rgba(10,12,14,.85)'; g.fillRect(x - tw / 2, y + 8, tw, 14); g.fillStyle = '#f2ead8'; g.textAlign = 'center'; g.fillText(label, x, y + 19); g.textAlign = 'left'; }
  };
  for (const ho of HOSTS) { if (state === 'result' && ho.id === 'e1') continue; const at = state === 'result' && ho.id === 'h1' ? { q: 5, r: -1 } : ho, c = project(at.q, at.r), t = tileAt.get(key(at.q, at.r)); stand.push({ y: c.y + 1, fn: () => token(c.x + 18, top(t) + 4, ho.faction, String(ho.troops), ho.own) }); }
  for (const cv of CARAVANS) { const pts = routePoints(cv.path.map(k => tileAt.get(k))), p = along(pts, state === 'result' ? 0.62 : cv.share); stand.push({ y: p.y, fn: () => token(p.x, p.y - 8, cv.faction, '鉱 30', cv.own, true) }); }
  stand.sort((a, b) => a.y - b.y).forEach(s => s.fn());
  for (const m of SEALED) { const c = project(m.fromQ, m.fromR); g.fillStyle = 'rgba(20,20,24,.7)'; g.strokeStyle = 'rgba(255,255,255,.35)'; g.setLineDash([3, 3]); g.beginPath(); g.arc(c.x - 26, c.y - 18, 13, 0, Math.PI * 2); g.fill(); g.stroke(); g.setLineDash([]); g.fillStyle = '#f2ead8'; g.font = '700 13px ui-monospace, monospace'; g.textAlign = 'center'; g.fillText('?', c.x - 26, c.y - 13); g.textAlign = 'left'; }
  // ---- routes in light
  if (state === 'select') {
    g.save(); g.globalCompositeOperation = 'lighter'; g.lineCap = 'round';
    for (const o of d.options.slice(1)) { g.strokeStyle = 'rgba(200,230,255,.35)'; g.lineWidth = 2; g.setLineDash([3, 6]); g.beginPath(); smooth(g, routePoints(o.route).map(p => ({ x: p.x, y: p.y - 8 }))); g.stroke(); }
    g.setLineDash([]); g.shadowColor = '#ff6a4a'; g.shadowBlur = 14; g.strokeStyle = '#ff8a6a'; g.lineWidth = 3;
    g.beginPath(); smooth(g, routePoints(d.options[0].route).map(p => ({ x: p.x, y: p.y - 8 }))); g.stroke();
    g.restore();
  }
  if (state === 'select' || state === 'result') { const t0 = tileAt.get(key(d.target.q, d.target.r)); g.strokeStyle = state === 'result' ? '#ffd24d' : '#ff8a6a'; g.lineWidth = 2; g.beginPath(); g.ellipse(t0.x, top(t0), 30, 30 * FLATTEN, 0, 0, Math.PI * 2); g.stroke(); }
  g.restore();
  // ---- the lamp
  const lg = g.createRadialGradient(lampX, lampY, 20, lampX, lampY, Math.max(w, h) * 0.9);
  lg.addColorStop(0, 'rgba(255,214,150,.10)'); lg.addColorStop(0.5, 'rgba(0,0,0,0)'); lg.addColorStop(1, 'rgba(0,0,0,.55)'); g.fillStyle = lg; g.fillRect(0, 0, w, h);
  // ---- labels: condensed, bright, small
  const label = (text, wx, wy, colour = '#f2ead8') => { const x = cam.ox + wx * cam.s, y = cam.oy + wy * cam.s; g.font = '600 12px system-ui, "Hiragino Sans", sans-serif'; g.letterSpacing = '1px'; const tw = g.measureText(text).width + 12; g.fillStyle = 'rgba(8,10,12,.8)'; roundRect(g, x - tw / 2, y - 10, tw, 20, 3); g.fill(); g.fillStyle = colour; g.textAlign = 'center'; g.fillText(text, x, y + 4); g.textAlign = 'left'; g.letterSpacing = '0px'; };
  for (const v of VILLAGES) { const c = project(v.q, v.r); label(v.name, c.x, c.y - 58, v.own ? '#ffd24d' : '#f2ead8'); }
  for (const m of SEALED) { const c = project(m.fromQ, m.fromR); label(`300 出発 · T${m.arriveTurn} 着 · 行き先不明`, c.x - 26, c.y - 44, '#d9c8ff'); }
  for (const cv of CARAVANS) { const pts = routePoints(cv.path.map(k => tileAt.get(k))), p = along(pts, state === 'result' ? 0.62 : cv.share); label(`隊商 T${cv.arriveTurn} 着`, p.x, p.y - 36); }
}
