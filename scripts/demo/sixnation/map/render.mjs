// The six-nation map timelapse, one frame at a time (TEST evidence only; never part of the game client).
//
// The page draws ONE map of the whole world from a frontier-sim trace (`frontier-sim timelapse`): every opened
// province's 61 tiles in the client's strategic terrain colours, each province washed in its keep holder's nation
// colour, nation borders as dark lines, settlements as dots that grow with their tier, armies on the march, and a
// flash where a province changes hands. The colours and the sigils are the client's own (`frontier/palette.mjs`,
// `frontier/map/layers.mjs paintSigil`); the hex projection is the client's (`web/map.mjs`: pointy-top, y × 0.76).
// The driver (`sixmap.mjs`) calls `window.sixmap.draw(bell)` and screenshots the canvas.
import { NATION_FILL, NATION_INK, NATION_KEYS } from '/web/frontier/palette.mjs';
import { paintSigil } from '/web/frontier/map/layers.mjs';

const W = 1920, H = 1080, SQRT3 = Math.sqrt(3), FLATTEN = 0.76, R = 1; // tile radius in world units
/** web/frontier/map/sprites.mjs FLAT (the strategic view), first shade. */
const TERRAIN = { G: '#7d9651', P: '#bfae6c', F: '#4d6a3b', H: '#8e9a5c', M: '#8a847a', W: '#467f8c' };
const SEA = '#16202a', NEUTRAL = '#efe6cf', NO = 255;
const NAMES = NATION_KEYS.map(k => k[0].toUpperCase() + k.slice(1));
/** Bells a change of hands is shown for (the flash) and a new province takes to rise out of the sea. */
const FLASH_BELLS = 10, RISE_BELLS = 8, POP_BELLS = 4;
const project = (q, r) => ({ x: SQRT3 * R * (q + r / 2), y: R * 1.5 * r * FLATTEN });
const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = t => Math.max(0, Math.min(1, t));
const ease = t => t * t * (3 - 2 * t);
const hexA = (hex, a) => `rgba(${parseInt(hex.slice(1, 3), 16)},${parseInt(hex.slice(3, 5), 16)},${parseInt(hex.slice(5, 7), 16)},${a})`;
const mix = (h1, h2, t) => {
  const c = (h, i) => parseInt(h.slice(1 + 2 * i, 3 + 2 * i), 16);
  return `#${[0, 1, 2].map(i => Math.round(lerp(c(h1, i), c(h2, i), t)).toString(16).padStart(2, '0')).join('')}`;
};

/** geometry::TILE_OFFSETS (hexes_within(4) order: q ascending, then r ascending). */
const OFFSETS = (() => { const o = []; for (let q = -4; q <= 4; q++) for (let r = Math.max(-4, -q - 4); r <= Math.min(4, -q + 4); r++) o.push([q, r]); return o; })();
const DIRS = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];

let T, P, byIdx, frames, canvas, ctx, events, pathCache = new Map();

/** Build the static geometry once: tile centres, terrain sprites, province outlines and their neighbours. */
function setup(trace) {
  T = trace;
  canvas = document.getElementById('c'); ctx = canvas.getContext('2d');
  frames = T.frames;
  byIdx = new Map();
  const owner = new Map(); // "q,r" → province index
  P = T.provinces.map(p => {
    const tiles = OFFSETS.map(([dq, dr]) => [p.cq + dq, p.cr + dr]);
    tiles.forEach(([q, r]) => owner.set(`${q},${r}`, p.i));
    const c = project(p.cq, p.cr);
    const rec = { ...p, tiles, x: c.x, y: c.y };
    byIdx.set(p.i, rec);
    return rec;
  });
  // Edges on a province's rim, each with the province across it (−1: none). Pointy-top hexes in unflattened space:
  // the edge towards neighbour d is perpendicular to the centre-to-centre line, at its midpoint, of length R.
  for (const p of P) {
    p.edges = [];
    p.tiles.forEach(([q, r]) => {
      const a = project(q, r);
      for (const [dq, dr] of DIRS) {
        const nb = owner.get(`${q + dq},${r + dr}`) ?? -1;
        if (nb === p.i) continue;
        const b = project(q + dq, r + dr);
        const ux = (b.x - a.x), uy = (b.y - a.y) / FLATTEN, len = Math.hypot(ux, uy);
        const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2, px = -uy / len * R / 2, py = ux / len * R / 2;
        p.edges.push({ nb, x1: mx + px, y1: my + py * FLATTEN, x2: mx - px, y2: my - py * FLATTEN });
      }
    });
    p.tilePath = new Path2D();
    for (const [q, r] of p.tiles) {
      const c = project(q, r);
      for (let k = 0; k < 6; k++) {
        const a = Math.PI / 180 * (60 * k - 30), x = c.x + Math.cos(a) * R * 1.04, y = c.y + Math.sin(a) * R * 1.04 * FLATTEN;
        k ? p.tilePath.lineTo(x, y) : p.tilePath.moveTo(x, y);
      }
      p.tilePath.closePath();
    }
  }
  // Every change of hands, flat and in bell order.
  events = [];
  for (const f of frames) for (let i = 0; i < f.ev.length; i += 4) events.push({ b: f.ev[i], prov: f.ev[i + 1], from: f.ev[i + 2], to: f.ev[i + 3] });
  // The opening bell of each province is when its keep first shows a holder.
  const first = new Map();
  for (const f of frames) f.ctl.forEach((c, i) => { if (c !== NO && !first.has(i)) first.set(i, f.b); });
  for (const p of P) p.rise = first.get(p.i) ?? Infinity;
}

/** A per-zoom cache of each province's terrain, drawn at screen resolution (one bitmap per province). */
function terrainSprite(p, scale) {
  const key = `${p.i}@${scale.toFixed(3)}`;
  let s = pathCache.get(key);
  if (s) return s;
  const pad = 2, xs = p.tiles.map(([q, r]) => project(q, r));
  const minX = Math.min(...xs.map(c => c.x)) - R * 1.2, maxX = Math.max(...xs.map(c => c.x)) + R * 1.2;
  const minY = Math.min(...xs.map(c => c.y)) - R * 1.2, maxY = Math.max(...xs.map(c => c.y)) + R * 1.2;
  const w = Math.ceil((maxX - minX) * scale) + pad * 2, h = Math.ceil((maxY - minY) * scale) + pad * 2;
  const oc = new OffscreenCanvas(w, h), o = oc.getContext('2d');
  o.translate(pad - minX * scale, pad - minY * scale); o.scale(scale, scale);
  p.tiles.forEach(([q, r], k) => {
    const c = project(q, r);
    o.beginPath();
    for (let j = 0; j < 6; j++) { const a = Math.PI / 180 * (60 * j - 30); o.lineTo(c.x + Math.cos(a) * R * 1.03, c.y + Math.sin(a) * R * 1.03 * FLATTEN); }
    o.closePath(); o.fillStyle = TERRAIN[p.t[k]] ?? TERRAIN.P; o.fill();
  });
  s = { img: oc, x: minX - pad / scale, y: minY - pad / scale, w: w / scale, h: h / scale };
  if (pathCache.size > 4000) pathCache.clear();
  pathCache.set(key, s);
  return s;
}

/** The frame at or before bell b, and the next one. */
function frameAt(b) {
  let lo = 0, hi = frames.length - 1;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (frames[m].b <= b) lo = m; else hi = m - 1; }
  return frames[lo];
}

/** Camera: fit what is opened (smoothly; the driver passes bells in order, but any bell gives the same picture). */
function cameraAt(b) {
  const open = P.filter(p => p.rise <= b + RISE_BELLS);
  const pts = open.length ? open : P.slice(0, 6);
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of pts) { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y); }
  const padX = 7 * SQRT3 * R, padY = 7 * 1.5 * R;
  // Always keep the world centre (the empty middle of ⑭'s centreless map) in the middle of the screen.
  const ex = Math.max(Math.abs(minX), Math.abs(maxX)) + padX, ey = Math.max(Math.abs(minY), Math.abs(maxY)) + padY;
  const scale = Math.min((W * 0.94) / (2 * ex), (H * 0.86) / (2 * ey));
  return { scale, cx: W / 2, cy: H / 2 - 18 };
}
let camMemo = null;
function camera(b) {
  // A slow zoom: the scale follows the target with a lag of a few bells, computed without state (a moving average).
  const k = 24, n = 6;
  let s = 0;
  for (let i = 0; i < n; i++) s += cameraAt(Math.max(0, b - (i * k) / n)).scale;
  const c = cameraAt(b);
  camMemo = { ...c, scale: s / n };
  return camMemo;
}

function control(b) {
  const f = frameAt(b);
  return f.ctl;
}

/** The colour a province is washed in at bell b (cross-fading over a change of hands). The wash is laid over painted
 * terrain, so it is each nation's cloth, NATION_FILL: palette.mjs keeps white for "the wash over painted land" and gives
 * Ember the slate NATION_LAND only on parchment (the chart), which this map has none of. */
const WASH = NATION_FILL;
function washOf(p, ctl, b) {
  const c = ctl[p.i];
  if (c === NO || c === undefined) return null;
  const ev = lastEvent(p.i, b);
  if (ev && b - ev.b < FLASH_BELLS && ev.from < 6) {
    const t = ease(clamp01((b - ev.b) / (FLASH_BELLS * 0.6)));
    return mix(WASH[ev.from], WASH[c], t);
  }
  return WASH[c];
}
const evByProv = new Map();
function lastEvent(prov, b) {
  if (!evByProv.size) for (const e of events) { if (!evByProv.has(e.prov)) evByProv.set(e.prov, []); evByProv.get(e.prov).push(e); }
  const list = evByProv.get(prov);
  if (!list) return null;
  let r = null;
  for (const e of list) { if (e.b <= b) r = e; else break; }
  return r;
}

function draw(b) {
  const cam = camera(b), s = cam.scale;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  // The sea of cloud beyond the opened land (the client's unopened world): a dark ground with a soft vignette.
  const g = ctx.createRadialGradient(W / 2, H / 2, 80, W / 2, H / 2, W * 0.62);
  g.addColorStop(0, '#22313c'); g.addColorStop(1, SEA);
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  ctx.setTransform(s, 0, 0, s, cam.cx, cam.cy);
  const ctl = control(b);
  const rise = p => ease(clamp01((b - p.rise) / RISE_BELLS));
  const live = P.filter(p => p.rise <= b);
  // 1. terrain
  for (const p of live) {
    const t = terrainSprite(p, s);
    ctx.globalAlpha = rise(p);
    ctx.drawImage(t.img, t.x, t.y, t.w, t.h);
  }
  ctx.globalAlpha = 1;
  // 2. each nation's wash
  for (const p of live) {
    const col = washOf(p, ctl, b);
    if (!col) continue;
    ctx.globalAlpha = 0.64 * rise(p);
    ctx.fillStyle = col; ctx.fill(p.tilePath);
  }
  ctx.globalAlpha = 1;
  // 3. borders: thin between provinces of one nation, strong between nations and at the coast of the opened world
  ctx.lineCap = 'round';
  const thin = new Path2D(), strong = [new Path2D(), new Path2D(), new Path2D(), new Path2D(), new Path2D(), new Path2D()], coast = new Path2D();
  for (const p of live) {
    const mine = ctl[p.i];
    for (const e of p.edges) {
      const nb = e.nb >= 0 ? byIdx.get(e.nb) : null;
      const other = nb && nb.rise <= b ? ctl[e.nb] : NO;
      if (other === NO) { coast.moveTo(e.x1, e.y1); coast.lineTo(e.x2, e.y2); continue; }
      if (e.nb < p.i && other !== NO) {
        if (other === mine) { thin.moveTo(e.x1, e.y1); thin.lineTo(e.x2, e.y2); }
      }
      if (other !== mine && mine < 6) { strong[mine].moveTo(e.x1, e.y1); strong[mine].lineTo(e.x2, e.y2); }
    }
  }
  ctx.strokeStyle = 'rgba(20,24,20,0.22)'; ctx.lineWidth = 0.9 / s; ctx.stroke(thin);
  ctx.strokeStyle = 'rgba(12,14,14,0.85)'; ctx.lineWidth = 3.4 / s; for (const sp of strong) ctx.stroke(sp);
  // each nation's own rim just inside its border (the client's two-tone boundary)
  ctx.lineWidth = 1.6 / s;
  strong.forEach((sp, f) => { ctx.strokeStyle = NATION_FILL[f]; ctx.stroke(sp); });
  ctx.strokeStyle = 'rgba(232,226,206,0.55)'; ctx.lineWidth = 1.4 / s; ctx.stroke(coast);
  // 4. settlements: one dot per live holding at its tile, larger with its tier; a Free City is an ivory square
  const f = frameAt(b), born = holdBirths();
  const tierR = [0.42, 0.62, 0.82, 1.0];
  for (let i = 0; i < f.hold.length; i += 4) {
    const p = byIdx.get(f.hold[i]); if (!p || p.rise > b) continue;
    const [q, r] = p.tiles[f.hold[i + 1]] ?? p.tiles[30];
    const c = project(q, r), side = f.hold[i + 2], tier = f.hold[i + 3];
    const age = b - (born.get(f.hold[i] * 61 + f.hold[i + 1]) ?? -99);
    const pop = age < POP_BELLS ? 1 + 0.9 * (1 - age / POP_BELLS) : 1;
    const rr = Math.max(tierR[tier] * R, 2.3 / s) * pop;
    ctx.beginPath();
    if (side === 6) ctx.rect(c.x - rr, c.y - rr * 0.85, rr * 2, rr * 1.7); else ctx.arc(c.x, c.y, rr, 0, Math.PI * 2);
    ctx.fillStyle = side === 6 ? NEUTRAL : NATION_FILL[side];
    ctx.fill();
    ctx.lineWidth = Math.max(0.9 / s, rr * 0.28); ctx.strokeStyle = side === 6 ? '#3b3428' : NATION_INK[side]; ctx.stroke();
    if (tier >= 2) { ctx.beginPath(); ctx.arc(c.x, c.y, rr * 1.55, 0, Math.PI * 2); ctx.lineWidth = 1.2 / s; ctx.strokeStyle = 'rgba(255,248,225,0.8)'; ctx.stroke(); }
  }
  // 5. armies on the march between provinces: a fading trail and a head in the nation's colour
  for (let i = 0; i < f.march.length; i += 7) {
    const from = byIdx.get(f.march[i + 1]), to = byIdx.get(f.march[i + 2]);
    if (!from || !to || from === to) continue;
    const n = f.march[i + 3], troops = f.march[i + 4], dep = f.march[i + 5], arr = f.march[i + 6];
    const t = clamp01((b - dep) / Math.max(1, arr - dep));
    const x = lerp(from.x, to.x, t), y = lerp(from.y, to.y, t);
    const grad = ctx.createLinearGradient(from.x, from.y, x, y);
    grad.addColorStop(0, hexA(NATION_FILL[n], 0)); grad.addColorStop(1, hexA(NATION_FILL[n], 0.95));
    ctx.strokeStyle = 'rgba(10,12,12,0.55)'; ctx.lineWidth = 4.2 / s; ctx.beginPath(); ctx.moveTo(from.x, from.y); ctx.lineTo(x, y); ctx.stroke();
    ctx.strokeStyle = grad; ctx.lineWidth = 2.4 / s; ctx.beginPath(); ctx.moveTo(from.x, from.y); ctx.lineTo(x, y); ctx.stroke();
    const hr = (3 + Math.min(4, Math.sqrt(troops) / 3)) / s;
    ctx.beginPath(); ctx.moveTo(x + hr, y); ctx.lineTo(x, y + hr); ctx.lineTo(x - hr, y); ctx.lineTo(x, y - hr); ctx.closePath();
    ctx.fillStyle = NATION_FILL[n]; ctx.fill(); ctx.lineWidth = 1.3 / s; ctx.strokeStyle = '#111'; ctx.stroke();
  }
  // 6. a change of hands: a ring that opens out from the province in the taker's colour, and its sigil
  for (const e of events) {
    if (e.b > b) break;
    const age = b - e.b;
    if (age >= FLASH_BELLS || e.to >= 6) continue;
    const p = byIdx.get(e.prov); if (!p) continue;
    const t = age / FLASH_BELLS;
    ctx.globalAlpha = 1 - t;
    ctx.beginPath(); ctx.ellipse(p.x, p.y, (8 + 26 * ease(t)) / s * 1.6, (8 + 26 * ease(t)) / s * 1.6 * FLATTEN, 0, 0, Math.PI * 2);
    ctx.lineWidth = 5 / s; ctx.strokeStyle = '#fff6d8'; ctx.stroke();
    ctx.lineWidth = 3 / s; ctx.strokeStyle = NATION_FILL[e.to]; ctx.stroke();
    ctx.globalAlpha = Math.min(1, 2 * (1 - t));
    paintSigil(ctx, { x: p.x, y: p.y, r: 11 / s, faction: e.to, scale: s });
    ctx.globalAlpha = 1;
  }
  // 7. the HUD: a day counter and the legend (nation, sigil, provinces held). Nothing else.
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  hud(b, ctl);
}

let births = null;
function holdBirths() {
  if (births) return births;
  births = new Map();
  for (const f of frames) for (let i = 0; i < f.hold.length; i += 4) { const k = f.hold[i] * 61 + f.hold[i + 1]; if (!births.has(k)) births.set(k, f.b); }
  return births;
}

function hud(b, ctl) {
  const day = Math.min(T.days, Math.floor(b / T.bellsPerDay) + 1);
  ctx.font = '600 30px "Avenir Next", "Helvetica Neue", Arial, sans-serif';
  ctx.fillStyle = 'rgba(244,236,214,0.95)'; ctx.textBaseline = 'top';
  ctx.fillText(`Day ${day}`, 44, 36);
  // a thin bar of the season so far
  ctx.fillStyle = 'rgba(244,236,214,0.18)'; ctx.fillRect(44, 78, 180, 4);
  ctx.fillStyle = 'rgba(244,236,214,0.85)'; ctx.fillRect(44, 78, 180 * clamp01(b / T.endBell), 4);
  // legend along the bottom
  const counts = Array(6).fill(0);
  ctl.forEach((c, i) => { const p = byIdx.get(i); if (c < 6 && p && p.rise <= b) counts[c]++; });
  const cellW = 190, x0 = W / 2 - (cellW * 6) / 2, y = H - 50;
  ctx.fillStyle = 'rgba(14,18,22,0.62)';
  roundRect(x0 - 16, y - 22, cellW * 6 + 20, 44, 12); ctx.fill();
  ctx.font = '600 21px "Avenir Next", "Helvetica Neue", Arial, sans-serif'; ctx.textBaseline = 'middle';
  for (let n = 0; n < 6; n++) {
    const x = x0 + n * cellW;
    ctx.fillStyle = WASH[n]; roundRect(x, y - 9, 22, 18, 4); ctx.fill(); ctx.lineWidth = 1.5; ctx.strokeStyle = NATION_INK[n]; ctx.stroke();
    paintSigil(ctx, { x: x + 11, y, r: 6.5, faction: n, scale: 1 });
    ctx.fillStyle = 'rgba(244,236,214,0.95)'; ctx.fillText(NAMES[n], x + 30, y + 1);
    const w = ctx.measureText(NAMES[n]).width;
    ctx.fillStyle = 'rgba(244,236,214,0.6)'; ctx.fillText(String(counts[n]), x + 38 + w, y + 1);
  }
  ctx.font = '400 13px "Avenir Next", "Helvetica Neue", Arial, sans-serif'; ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = 'rgba(244,236,214,0.38)';
  const note = `TEST simulation · frontier-sim ${T.preset} · seed ${T.seed}`;
  ctx.fillText(note, W - 28 - ctx.measureText(note).width, H - 14);
}
function roundRect(x, y, w, h, r) { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); }

window.sixmap = {
  async load(url) { const t = await (await fetch(url)).json(); setup(t); return { provinces: P.length, frames: frames.length, events: events.length, endBell: T.endBell, days: T.days }; },
  draw(b) { draw(b); return true; },
  stats(b) { const ctl = control(b); const c = Array(6).fill(0); ctl.forEach(x => { if (x < 6) c[x]++; }); const f = frameAt(b); return { bell: f.b, provinces: c, holdings: f.hold.length / 4, marching: f.march.length / 7, changes: events.filter(e => e.b <= b).length }; },
};
