// What the three directions share: the camera, the order things stand in, the shape of a route, the land of a
// village and the words. A direction is a painter over the same scene (scene.mjs); none of them owns a fact.
import { TILES, tileAt, key, project, hexCorners, VILLAGES, WORKED, dist, HOSTS, DECISION, RADIUS, FLATTEN, STRUCTURES, routeTo } from './scene.mjs';

/** The two frames every direction is shown in: the land at rest, and the selected host deciding. */
export const FRAMES = {
  rest: { cx: 40, cy: -20, zoom: 1.45 },
  select: { cx: 270, cy: -30, zoom: 1.22 },
  result: { cx: 270, cy: -30, zoom: 1.22 },
  // the previews of what the client cannot do yet (panels.mjs FEATURE_FRAMES): the board at rest behind them
  caravan: { cx: 200, cy: -20, zoom: 1.35 },
  raid: { cx: 200, cy: -20, zoom: 1.35 },
  ai: { cx: 200, cy: -20, zoom: 1.35 },
  season: { cx: 200, cy: -20, zoom: 1.35 },
};

/** A world → canvas transform for a frame on a canvas of `w × h` CSS px. */
export function cameraOf(frame, w, h) {
  const s = frame.zoom * Math.min(w / 1180, h / 760);
  return { s, ox: w / 2 - frame.cx * s, oy: h / 2 - frame.cy * s, w, h };
}
export const toScreen = (cam, x, y) => [cam.ox + x * cam.s, cam.oy + y * cam.s];

/** Tiles back to front. */
export const BACK_TO_FRONT = [...TILES].sort((a, b) => a.y - b.y || a.x - b.x);

/** The tiles a village works (its colour on the board), and the outline of a set of tiles (edges not shared). */
export function landOf(v) {
  return TILES.filter(t => dist(t, v) <= WORKED[v.tier]);
}
export function outlineOf(tiles) {
  const set = new Set(tiles.map(t => t.k)), edges = [];
  const N = [[1, 0], [0, 1], [-1, 1], [-1, 0], [0, -1], [1, -1]];
  for (const t of tiles) {
    const c = hexCorners(t.x, t.y);
    // corner i..i+1 faces the neighbour N[i] (map.mjs EDGE_NEIGHBOR)
    for (let i = 0; i < 6; i++) if (!set.has(key(t.q + N[i][0], t.r + N[i][1]))) edges.push([c[i], c[(i + 1) % 6]]);
  }
  return edges;
}
/** Stroke a set of edges as one path. */
export function strokeEdges(g, edges) {
  g.beginPath();
  for (const [a, b] of edges) { g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); }
  g.stroke();
}
export function hexPath(g, x, y, rad = RADIUS) {
  const c = hexCorners(x, y, rad);
  g.beginPath(); c.forEach(([px, py], i) => (i ? g.lineTo(px, py) : g.moveTo(px, py))); g.closePath();
}

/** The route of an option as world points, and its turn ticks (a march of n tiles over the turns it takes). */
export function routePoints(route) {
  return route.map(h => project(h.q, h.r));
}
/** A smooth line through points (Catmull-Rom as béziers). */
export function smooth(g, pts) {
  if (pts.length < 2) return;
  g.moveTo(pts[0].x, pts[0].y);
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(pts.length - 1, i + 2)];
    g.bezierCurveTo(p1.x + (p2.x - p0.x) / 6, p1.y + (p2.y - p0.y) / 6, p2.x - (p3.x - p1.x) / 6, p2.y - (p3.y - p1.y) / 6, p2.x, p2.y);
  }
}
/** Points spread evenly along a polyline (for ticks and travelling marks). */
export function along(pts, k) {
  const seg = []; let total = 0;
  for (let i = 0; i < pts.length - 1; i++) { const d = Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y); seg.push(d); total += d; }
  let rest = Math.max(0, Math.min(1, k)) * total;
  for (let i = 0; i < seg.length; i++) {
    if (rest <= seg[i] || i === seg.length - 1) { const t = seg[i] ? rest / seg[i] : 0; return { x: pts[i].x + (pts[i + 1].x - pts[i].x) * t, y: pts[i].y + (pts[i + 1].y - pts[i].y) * t, a: Math.atan2(pts[i + 1].y - pts[i].y, pts[i + 1].x - pts[i].x) }; }
    rest -= seg[i];
  }
  return { ...pts[pts.length - 1], a: 0 };
}

/** The selected host and its options, resolved against the scene. */
export function decision() {
  const host = HOSTS.find(h => h.id === DECISION.host);
  return { ...DECISION, host };
}
export const towers = () => STRUCTURES.filter(s => s.kind === 'tower');
export const inCover = (t) => towers().some(s => dist(s, t) <= s.cover);
export { routeTo };

/** Whether the visitor asked for less motion. */
export const still = () => globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches || document.documentElement.dataset.motion === 'off';

/** Nations, as palette.mjs has them (fill, dark, ink, on) and their sigils as small SVG-like paths drawn in canvas. */
export const NATION = {
  fill: ['#cc303b', '#31bedb', '#eac21b', '#a34cd8', '#edeee7', '#f19232'],
  dark: ['#81242c', '#237489', '#8c721c', '#69338c', '#5f6a68', '#9c581f'],
  ink: ['#5e1a20', '#17586a', '#6a5510', '#4e2470', '#434c4a', '#74400f'],
  on: ['#fffaf0', '#0e3a46', '#3b2f06', '#ffffff', '#333c3a', '#3d2206'],
  name: ['アステル', 'ボレアリス', 'シンダー', 'ダンマール', 'エンバー', 'フィヨルダル'],
};
/** A nation's sigil (palette.mjs FACTION_MARK shapes: circle, triangle, square, diamond, cross, hexagon) at (x, y), radius r. */
export function sigil(g, f, x, y, r) {
  g.beginPath();
  if (f === 0) g.arc(x, y, r * 0.62, 0, Math.PI * 2);
  else if (f === 1) { g.moveTo(x, y - r * 0.72); g.lineTo(x + r * 0.66, y + r * 0.5); g.lineTo(x - r * 0.66, y + r * 0.5); g.closePath(); }
  else if (f === 2) g.rect(x - r * 0.55, y - r * 0.55, r * 1.1, r * 1.1);
  else if (f === 3) { g.moveTo(x, y - r * 0.75); g.lineTo(x + r * 0.62, y); g.lineTo(x, y + r * 0.75); g.lineTo(x - r * 0.62, y); g.closePath(); }
  else if (f === 4) { const w = r * 0.24, l = r * 0.7; g.rect(x - w, y - l, w * 2, l * 2); g.rect(x - l, y - w, l * 2, w * 2); }
  else for (let i = 0; i < 6; i++) { const a = (i * 60 - 90) * Math.PI / 180; const px = x + Math.cos(a) * r * 0.66, py = y + Math.sin(a) * r * 0.66; i ? g.lineTo(px, py) : g.moveTo(px, py); }
  g.closePath?.();
}

/** Load an image once. */
const images = new Map();
export function image(src, onload) {
  if (images.has(src)) { const r = images.get(src); return r.ok ? r.img : null; }
  const img = new Image(), rec = { img, ok: false };
  images.set(src, rec);
  img.onload = () => { rec.ok = true; onload?.(); };
  img.src = src;
  return null;
}

/** The decision's words, the same in every direction (the panel is styled per direction, its content is one). */
export const WORDS = {
  sample: '見本の場面（数値は比較用）',
  forecastTag: '予測',
  confirmedTag: '確定',
  sealed: '封印中',
  irreversible: '送ったら取り消せません',
};
export { TILES, tileAt, project, hexCorners, VILLAGES, HOSTS, STRUCTURES, RADIUS, FLATTEN, dist, key };
