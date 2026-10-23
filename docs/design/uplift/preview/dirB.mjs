// Direction B, 「彩色地誌」 (the illuminated atlas): the frontier as a hand-drawn map seen from straight above. Ink line
// and watercolour wash on paper; land by its colour and its marks (hachures for hills, drawn peaks, tree glyphs);
// settlements in plan (a wall's ring, the roofs as blocks); nations as a wash along the inside of their border and a
// dotted ink line; things as cartographic glyphs. Everything is drawn by code; nothing of the client's baked art.
import { TILES, tileAt, project, hexCorners, VILLAGES, HOSTS, STRUCTURES, RADIUS, FLATTEN, cameraOf, landOf, outlineOf, strokeEdges, hexPath, smooth, along, routePoints, decision, NATION, sigil, dist, key } from './common.mjs';
import { CARAVANS, SEALED, reachOf, ROAD, rng } from './scene.mjs';
import { roundRect } from './dirA.mjs';

export const META = {
  id: 'B', title: '彩色地誌', sub: 'The illuminated atlas',
  idea: '真上から見た、手描きの地図。墨の線と水彩。地形は色と記号で、村は平面図で、国は境の内側のにじみと点線で読ませる。全部コードで描く。',
};

const WASH = { Plains: '#e9d8a0', Grassland: '#cdd59c', Forest: '#a9bf8c', Hills: '#dcc595', Mountain: '#d6cbb3', Water: '#a3c8cc' };
const INK = '#3b2f22', SEPIA = 'rgba(92,66,36,.75)';
let grain = null;
function paper(w, h) {
  if (grain && grain.width === Math.round(w) && grain.height === Math.round(h)) return grain;
  grain = Object.assign(document.createElement('canvas'), { width: Math.round(w), height: Math.round(h) });
  const g = grain.getContext('2d'), R = rng(11);
  g.fillStyle = '#efe4c8'; g.fillRect(0, 0, w, h);
  for (let i = 0; i < w * h / 40; i++) { g.fillStyle = `rgba(${R() < 0.5 ? '120,90,40' : '255,250,235'},${R() * 0.07})`; g.fillRect(R() * w, R() * h, 1 + R() * 2, 1 + R() * 2); }
  const v = g.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.3, w / 2, h / 2, Math.max(w, h) * 0.75);
  v.addColorStop(0, 'rgba(120,80,30,0)'); v.addColorStop(1, 'rgba(120,80,30,.22)'); g.fillStyle = v; g.fillRect(0, 0, w, h);
  return grain;
}

export function paint(g, w, h, { frame, state }) {
  const cam = cameraOf(frame, w, h), d = decision();
  g.drawImage(paper(w, h), 0, 0, w, h);
  g.save(); g.translate(cam.ox, cam.oy); g.scale(cam.s, cam.s);
  const R = rng(5);
  // ---- the washes: each tile laid three times a little larger and shifted, so neighbours bleed into each other
  for (let pass = 0; pass < 3; pass++) for (const t of TILES) {
    g.fillStyle = WASH[t.terrain] + (pass === 0 ? 'b0' : '50');
    g.beginPath();
    hexCorners(t.x + (R() - 0.5) * 6, t.y + (R() - 0.5) * 5, RADIUS * (1.04 + pass * 0.05)).forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
    g.closePath(); g.fill();
  }
  // ---- water: an ink shore and ripple lines inside it
  const water = TILES.filter(t => t.terrain === 'Water');
  g.strokeStyle = 'rgba(40,80,90,.75)'; g.lineWidth = 1.4; strokeEdges(g, outlineOf(water));
  g.strokeStyle = 'rgba(40,80,90,.3)'; g.lineWidth = 0.8;
  for (const t of water) for (const dy of [-8, 2, 12]) { g.beginPath(); g.moveTo(t.x - 16, t.y + dy); g.quadraticCurveTo(t.x - 6, t.y + dy - 3, t.x + 4, t.y + dy); g.quadraticCurveTo(t.x + 12, t.y + dy + 3, t.x + 18, t.y + dy); g.stroke(); }
  // ---- roads: a double dotted line
  const roadPts = list => list.map(k => tileAt.get(k)).filter(Boolean).map(t => ({ x: t.x, y: t.y }));
  for (const seg of [ROAD.slice(0, 6), ['-2,1', ...ROAD.slice(6)]]) {
    g.setLineDash([3, 3]); g.strokeStyle = SEPIA; g.lineWidth = 1.2;
    for (const o of [-2.5, 2.5]) { g.save(); g.translate(0, o); g.beginPath(); smooth(g, roadPts(seg)); g.stroke(); g.restore(); }
    g.setLineDash([]);
  }
  // ---- the nations: a wash along the inside of the border, a dotted ink line (the viewer's own gilded)
  for (const v of VILLAGES) {
    const land = landOf(v), edges = outlineOf(land);
    g.save(); g.lineCap = 'round';
    g.strokeStyle = NATION.fill[v.faction] + '55'; g.lineWidth = 14; g.beginPath(); for (const t of land) { hexCorners(t.x, t.y).forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.closePath(); } g.clip(); strokeEdges(g, edges); g.restore();
    g.setLineDash([2, 4]); g.strokeStyle = NATION.ink[v.faction]; g.lineWidth = 1.6; strokeEdges(g, edges); g.setLineDash([]);
    if (v.own) { g.strokeStyle = '#b8902a'; g.lineWidth = 0.9; g.save(); g.translate(0, 2.5); strokeEdges(g, edges); g.restore(); }
  }
  // ---- relief and woods as marks
  for (const t of [...TILES].sort((a, b) => a.y - b.y)) {
    const Rt = rng(t.q * 991 + t.r * 7);
    if (t.terrain === 'Hills') {
      g.strokeStyle = SEPIA; g.lineWidth = 1.1;
      for (const [dx, dy] of [[-16, -6], [6, -10], [-4, 8], [16, 6]]) { g.beginPath(); g.arc(t.x + dx, t.y + dy + 6, 8, Math.PI * 1.1, Math.PI * 1.9); g.stroke(); for (let k = 0; k < 3; k++) { const a = Math.PI * (1.25 + k * 0.25); g.beginPath(); g.moveTo(t.x + dx + Math.cos(a) * 8, t.y + dy + 6 + Math.sin(a) * 8); g.lineTo(t.x + dx + Math.cos(a) * 11, t.y + dy + 6 + Math.sin(a) * 11 + 2); g.stroke(); } }
      if (t.ore) { g.fillStyle = '#5c6870'; for (const [dx, dy] of [[10, -2], [13, 2], [8, 3]]) { g.beginPath(); g.moveTo(t.x + dx, t.y + dy - 3); g.lineTo(t.x + dx + 2.5, t.y + dy); g.lineTo(t.x + dx, t.y + dy + 3); g.lineTo(t.x + dx - 2.5, t.y + dy); g.closePath(); g.fill(); } }
    } else if (t.terrain === 'Mountain') {
      for (const [dx, dy, s] of [[-12, 4, 0.8], [8, -2, 1], [0, 10, 0.7]]) {
        const top = t.y + dy - 26 * s, bx = t.x + dx;
        g.fillStyle = '#f3ead6'; g.strokeStyle = INK; g.lineWidth = 1.2; g.beginPath(); g.moveTo(bx - 18 * s, t.y + dy); g.lineTo(bx - 2 * s, top); g.lineTo(bx + 18 * s, t.y + dy); g.closePath(); g.fill(); g.stroke();
        g.strokeStyle = 'rgba(59,47,34,.55)'; g.lineWidth = 0.8; for (let k = 1; k < 6; k++) { g.beginPath(); g.moveTo(bx - 2 * s + k * 3 * s, top + k * 4.6 * s); g.lineTo(bx - 2 * s + k * 3 * s - 4 * s, t.y + dy); g.stroke(); }
      }
    } else if (t.terrain === 'Forest') {
      for (let i = 0; i < 9; i++) { const x = t.x + (Rt() - 0.5) * 52, y = t.y + (Rt() - 0.5) * 36, r = 4 + Rt() * 2.2; g.strokeStyle = INK; g.lineWidth = 0.9; g.beginPath(); g.moveTo(x, y + r); g.lineTo(x, y + r + 4); g.stroke(); g.fillStyle = Rt() < 0.5 ? '#7f9c62' : '#93ad6c'; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill(); g.stroke(); }
    } else if (t.terrain === 'Grassland' && Rt() < 0.5) {
      g.strokeStyle = 'rgba(80,100,40,.45)'; g.lineWidth = 0.8; for (let i = 0; i < 4; i++) { const x = t.x + (Rt() - 0.5) * 40, y = t.y + (Rt() - 0.5) * 26; g.beginPath(); g.moveTo(x - 3, y); g.lineTo(x - 1, y - 4); g.moveTo(x + 1, y); g.lineTo(x + 3, y - 4); g.stroke(); }
    }
  }
  // ---- the tower's watch: a hatched ring
  for (const s of STRUCTURES.filter(s0 => s0.kind === 'tower')) {
    const cover = TILES.filter(t => dist(t, s) <= s.cover);
    g.save(); g.beginPath(); for (const t of cover) hexCorners(t.x, t.y).forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.clip();
    g.strokeStyle = NATION.fill[s.faction] + '50'; g.lineWidth = 1; const c = project(s.q, s.r);
    for (let k = -300; k < 300; k += 7) { g.beginPath(); g.moveTo(c.x + k, c.y - 200); g.lineTo(c.x + k + 200, c.y + 200); g.stroke(); }
    g.restore(); g.setLineDash([5, 4]); g.strokeStyle = NATION.ink[s.faction]; g.lineWidth = 1.3; strokeEdges(g, outlineOf(cover)); g.setLineDash([]);
  }
  // ---- the selected state: a fine lattice where the host can go, the routes in ink
  if (state !== 'rest') {
    const reach = reachOf(d.host);
    g.strokeStyle = 'rgba(59,47,34,.55)'; g.lineWidth = 0.7; for (const t of reach) { hexPath(g, t.x, t.y); g.stroke(); }
    g.strokeStyle = '#8f2d22'; g.lineWidth = 1.6; strokeEdges(g, outlineOf([...reach, tileAt.get(key(d.host.q, d.host.r))]));
  }
  // ---- settlements in plan
  for (const v of VILLAGES) {
    const c = project(v.q, v.r), r = v.tier ? 26 : 19, Rv = rng(v.q * 31 + v.r);
    g.fillStyle = '#f6eedb'; g.strokeStyle = INK; g.lineWidth = 1.6; g.beginPath(); g.ellipse(c.x, c.y, r, r * 0.9, 0, 0, Math.PI * 2); g.fill(); g.stroke();
    g.lineWidth = 0.8; g.beginPath(); g.ellipse(c.x, c.y, r - 3, r * 0.9 - 3, 0, 0, Math.PI * 2); g.stroke();
    for (let i = 0; i < (v.tier ? 14 : 8); i++) { const a = Rv() * Math.PI * 2, rr = Rv() * (r - 7); const x = c.x + Math.cos(a) * rr, y = c.y + Math.sin(a) * rr * 0.85; g.fillStyle = NATION.fill[v.faction] === '#edeee7' ? '#9aa5ad' : NATION.fill[v.faction]; g.save(); g.translate(x, y); g.rotate(Rv() * 0.8); g.fillRect(-3.5, -2.2, 7, 4.4); g.strokeRect(-3.5, -2.2, 7, 4.4); g.restore(); }
    g.fillStyle = INK; g.fillRect(c.x - 4, c.y - 4, 8, 8);
    // what it has built, as a small glyph each on the rim: field, axe, quarry, workshop
    if (v.annex) { const marks = []; if (v.annex[0]) marks.push('field'); if (v.annex[1]) marks.push('axe'); if (v.annex[2]) marks.push('stone'); if (v.workshop) marks.push('anvil'); marks.forEach((m, i) => glyph(g, m, c.x - r - 10 + i * 13, c.y + r + 10)); }
  }
  // ---- structures as glyphs
  for (const s of STRUCTURES) {
    const c = project(s.q, s.r), col = NATION.ink[s.faction];
    g.strokeStyle = col; g.fillStyle = '#f6eedb'; g.lineWidth = 1.6;
    if (s.kind === 'vault') { g.fillRect(c.x - 8, c.y - 8, 16, 16); g.strokeRect(c.x - 8, c.y - 8, 16, 16); g.beginPath(); g.moveTo(c.x - 8, c.y - 8); g.lineTo(c.x + 8, c.y + 8); g.moveTo(c.x + 8, c.y - 8); g.lineTo(c.x - 8, c.y + 8); g.stroke(); }
    if (s.kind === 'fort') { g.beginPath(); for (let i = 0; i < 10; i++) { const a = i / 10 * Math.PI * 2 - Math.PI / 2, r = i % 2 ? 9 : 17; g.lineTo(c.x + Math.cos(a) * r, c.y + Math.sin(a) * r); } g.closePath(); g.fill(); g.stroke(); g.fillStyle = NATION.fill[s.faction]; g.beginPath(); g.arc(c.x, c.y, 5, 0, Math.PI * 2); g.fill(); }
    if (s.kind === 'tower') { g.beginPath(); g.arc(c.x, c.y, 8, 0, Math.PI * 2); g.fill(); g.stroke(); g.beginPath(); g.moveTo(c.x, c.y - 8); g.lineTo(c.x, c.y - 26); g.stroke(); g.fillStyle = NATION.fill[s.faction]; g.beginPath(); g.moveTo(c.x, c.y - 26); g.lineTo(c.x + 12, c.y - 22); g.lineTo(c.x, c.y - 18); g.fill(); }
    if (s.kind === 'palisade') { g.beginPath(); g.moveTo(c.x - 24, c.y - 10); g.lineTo(c.x + 24, c.y + 10); g.stroke(); for (let k = -4; k <= 4; k++) { const x = c.x + k * 5.5, y = c.y + k * 2.3; g.beginPath(); g.moveTo(x, y); g.lineTo(x - 3, y - 6); g.stroke(); } }
  }
  // ---- the caravan: a dotted track with arrows, a cart glyph where it is
  for (const cv of CARAVANS) {
    const pts = routePoints(cv.path.map(k => tileAt.get(k))), k0 = state === 'result' ? 0.62 : cv.share, p = along(pts, k0);
    g.setLineDash([1, 5]); g.lineCap = 'round'; g.strokeStyle = NATION.ink[cv.faction]; g.lineWidth = 2.2; g.beginPath(); smooth(g, pts); g.stroke(); g.setLineDash([]);
    glyph(g, 'cart', p.x, p.y - 10, NATION.fill[cv.faction]);
  }
  // ---- hosts as heraldic tokens: a pennant and the troops; a sealed march as a seal at its origin
  for (const ho of HOSTS) {
    if (state === 'result' && ho.id === 'e1') continue;
    const at = state === 'result' && ho.id === 'h1' ? { q: 5, r: -1 } : ho, c = project(at.q, at.r);
    const x = c.x + 18, y = c.y + 4;
    g.strokeStyle = INK; g.lineWidth = 1.2; g.beginPath(); g.moveTo(x, y + 10); g.lineTo(x, y - 18); g.stroke();
    g.fillStyle = NATION.fill[ho.faction]; g.beginPath(); g.moveTo(x, y - 18); g.lineTo(x + 18, y - 13); g.lineTo(x + 12, y - 9); g.lineTo(x + 18, y - 5); g.lineTo(x, y - 4); g.closePath(); g.fill(); g.stroke();
    g.font = 'italic 700 11px "Hiragino Mincho ProN", serif'; g.fillStyle = INK; g.fillText(`${ho.troops}`, x + 3, y + 10);
    if (ho.own && ho.id === d.host.id && state === 'select') { g.strokeStyle = '#8f2d22'; g.lineWidth = 1.4; g.beginPath(); g.arc(x + 6, y - 4, 20, 0, Math.PI * 2); g.stroke(); }
  }
  for (const m of SEALED) { const c = project(m.fromQ, m.fromR); g.fillStyle = '#8f2d22'; g.beginPath(); g.arc(c.x - 28, c.y - 10, 9, 0, Math.PI * 2); g.fill(); g.fillStyle = '#f6eedb'; sigil(g, m.faction, c.x - 28, c.y - 10, 6); g.fill(); }
  if (state === 'select') {
    for (const o of d.options.slice(1)) { g.setLineDash([2, 5]); g.strokeStyle = 'rgba(59,47,34,.7)'; g.lineWidth = 1.4; g.beginPath(); smooth(g, routePoints(o.route)); g.stroke(); g.setLineDash([]); }
    const pts = routePoints(d.options[0].route);
    g.strokeStyle = '#8f2d22'; g.lineWidth = 2.4; g.setLineDash([8, 4]); g.beginPath(); smooth(g, pts); g.stroke(); g.setLineDash([]);
    const n = d.options[0].arrive - 42;
    g.font = '700 10px system-ui'; g.fillStyle = '#8f2d22';
    for (let i = 1; i <= n; i++) { const p = along(pts, i / n * 0.999); g.beginPath(); g.arc(p.x, p.y, 3, 0, Math.PI * 2); g.fill(); g.fillText(`${42 + i}`, p.x + 5, p.y - 5); }
    const t = project(d.target.q, d.target.r); g.strokeStyle = '#8f2d22'; g.lineWidth = 1.8; g.beginPath(); g.arc(t.x, t.y, 22, 0, Math.PI * 2); g.stroke();
  }
  g.restore();
  // ---- the lettering
  const write = (text, wx, wy, { size = 15, colour = INK, italic = false, spacing = 2 } = {}) => {
    const [x, y] = [cam.ox + wx * cam.s, cam.oy + wy * cam.s];
    g.save(); g.font = `${italic ? 'italic ' : ''}700 ${size}px "Hiragino Mincho ProN", "Yu Mincho", serif`; g.letterSpacing = `${spacing}px`; g.textAlign = 'center';
    g.lineWidth = 4; g.strokeStyle = 'rgba(239,228,200,.9)'; g.strokeText(text, x, y); g.fillStyle = colour; g.fillText(text, x, y); g.restore();
  };
  for (const v of VILLAGES) { const c = project(v.q, v.r); write(v.name, c.x, c.y - 34, { size: v.own ? 18 : 15, colour: v.own ? '#7a1c14' : INK }); }
  for (const s of STRUCTURES.filter(s0 => s0.name)) { const c = project(s.q, s.r); write(s.name, c.x, c.y + 28, { size: 12, italic: true }); }
  { const c = project(7, -5); write('ダ ン マ ー ル', c.x, c.y, { size: 13, colour: NATION.ink[3], spacing: 4 }); }
  for (const cv of CARAVANS) { const pts = routePoints(cv.path.map(k => tileAt.get(k))), p = along(pts, state === 'result' ? 0.62 : cv.share); write(`鉱石 30 · ターン ${cv.arriveTurn} 着`, p.x, p.y - 28, { size: 11, italic: true, colour: NATION.ink[0], spacing: 0 }); }
  for (const m of SEALED) { const c = project(m.fromQ, m.fromR); write(`軍 300 出発 · ターン ${m.arriveTurn} 着 · 行き先 封印中`, c.x - 28, c.y + 14, { size: 11, italic: true, colour: '#7a1c14', spacing: 0 }); }
}

/** Small cartographic glyphs. */
function glyph(g, kind, x, y, colour = INK) {
  g.save(); g.strokeStyle = INK; g.lineWidth = 1; g.fillStyle = '#f6eedb';
  if (kind === 'field') { g.strokeRect(x - 5, y - 4, 10, 8); for (let i = -3; i <= 3; i += 2) { g.beginPath(); g.moveTo(x + i, y - 4); g.lineTo(x + i, y + 4); g.stroke(); } }
  if (kind === 'axe') { g.beginPath(); g.moveTo(x - 4, y + 5); g.lineTo(x + 3, y - 4); g.stroke(); g.beginPath(); g.moveTo(x + 1, y - 6); g.quadraticCurveTo(x + 7, y - 4, x + 5, y + 1); g.lineTo(x + 2, y - 3); g.closePath(); g.fillStyle = INK; g.fill(); }
  if (kind === 'stone') { g.beginPath(); g.moveTo(x - 5, y + 4); g.lineTo(x - 3, y - 3); g.lineTo(x + 2, y - 5); g.lineTo(x + 5, y + 4); g.closePath(); g.fill(); g.stroke(); }
  if (kind === 'anvil') { g.fillStyle = INK; g.beginPath(); g.moveTo(x - 6, y - 3); g.lineTo(x + 6, y - 3); g.lineTo(x + 3, y); g.lineTo(x + 3, y + 3); g.lineTo(x - 3, y + 3); g.lineTo(x - 3, y); g.closePath(); g.fill(); }
  if (kind === 'cart') { g.fillStyle = colour; g.fillRect(x - 9, y - 6, 18, 8); g.strokeRect(x - 9, y - 6, 18, 8); g.fillStyle = '#f6eedb'; for (const dx of [-5, 5]) { g.beginPath(); g.arc(x + dx, y + 4, 3.4, 0, Math.PI * 2); g.fill(); g.stroke(); } }
  g.restore();
}
