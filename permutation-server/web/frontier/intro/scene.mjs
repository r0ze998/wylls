// The title's picture (UX brief §7.1, §11.9; the second review: "an emblem page,
// not a game title: no board, no village, no bell tower in the first five
// seconds"). The world stands behind the title: the surveyor's chart on its
// dark table at dusk, seen from a seat; the bell's tower large at the Concord
// with its warm light on the paper; the six nations' standards planted round
// it, each toward its own side of the frontier; the cloud sea along the far
// rim; and the bell's ring spreading slowly over the board.
//
// It is a picture drawn by code into one canvas (no asset files), an opaque
// scene of its own: nothing of the live game shows through it. The still part
// (table, sheet, lattice, cloud, light) is painted once per size; a frame adds
// the rings, the standards (their pennons move) and the tower. Under reduced
// motion it is one still picture. Pure drawing; context-tolerant.
import { paintBellTower, TOWER } from '../map/belltower.mjs';
import { paintStandard } from '../map/ownland.mjs';
import { paintHeap } from '../map/cloudsea.mjs';

const SQRT3 = Math.sqrt(3);
/** The board as the title sees it: the tower's foot at `foot` of the picture's height, the eye `eye` picture heights above the board, `far` plane px from the tower. */
// (the foot stands higher than it did: the six leaders now stand in a row over the picture's dark foot, under the wordmark)
export const TITLE_VIEW = Object.freeze({ foot: 0.385, eye: 1.25, far: 2100, hex: 46 });
/** The bell's ring leaves it every this many seconds and lives this long. */
export const TITLE_RING = Object.freeze({ every: 2.6, life: 7.8 });
/** Where the six standards stand round the tower (plane px from it) and the turn of the first (degrees; the first nation's side is to the right, as its wedge is). */
export const TITLE_STANDARDS = Object.freeze({ radius: 350, depth: 0.62, first: 0 });

const hash = (a, b = 0) => { let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1); h ^= h >>> 15; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; return (h >>> 0) / 4294967296; };
const spare = (w, h) => (typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : typeof document !== 'undefined' ? Object.assign(document.createElement('canvas'), { width: w, height: h }) : null);

/**
 * The picture's geometry for a canvas of `w` × `h` px (and, when the page knows it, the `top` of the words): `at(X, Z)` → `{x, y, k}`: where the board's point `X` to
 * the right of the tower and `Z` beyond it is seen, and how large things there are drawn (1 at the tower).
 */
export function titleView(w, h, top = null) {
  const V = TITLE_VIEW, phone = w < 760;
  // (`top`: where the words begin, px from the picture's top: on a low screen the tower's foot stands above them, and the tower is made to fit)
  const foot0 = h * (phone ? 0.31 : V.foot), footY = Number.isFinite(top) && top > 0 ? Math.max(h * 0.24, Math.min(foot0, top - h * 0.085)) : foot0;
  const cx = w / 2, eye = h * V.eye, L = V.far, hy = footY - eye;
  // (a narrow picture is the same picture made smaller about the tower's foot: the standards' ring fits its width)
  const unit = Math.max(0.5, Math.min(1, w / 1180)) * Math.min(1.1, h / 860);
  const at = (X, Z) => { const k0 = L / (L + Z); return { x: cx + X * unit * k0, y: footY + eye * (k0 - 1) * unit, k: k0 * unit }; };
  void hy;
  // (`near`: the nearest the board is drawn, plane px on the eye's side of the tower: past the picture's foot;
  // `ring`: how far from the tower the standards stand, never wider than the picture)
  return { w, h, cx, footY, unit, at, near: -0.64 * L, ring: Math.min(TITLE_STANDARDS.radius, (w * 0.37) / unit), tower: Math.min((phone ? 0.25 : 0.345) * h, footY - h * 0.03) / TOWER.height };
}

/** The still part: the table, the sheet with its lattice, the cloud along the far rim, the dusk and the bell's light. */
function paintStill(g, view) {
  const { w, h, cx, footY, at } = view;
  // ---- the table: dark boards in the dusk
  g.fillStyle = '#0b0806'; g.fillRect(0, 0, w, h);
  const boards = g.createLinearGradient(0, 0, 0, h);
  boards.addColorStop(0, '#1b130d'); boards.addColorStop(0.5, '#2a1d13'); boards.addColorStop(1, '#120c08');
  g.fillStyle = boards; g.fillRect(0, 0, w, h);
  g.save();
  g.strokeStyle = 'rgba(0,0,0,.42)'; g.lineWidth = 1.4;
  for (let i = -14; i <= 14; i++) { const a = at(i * 260, 2400), b = at(i * 260, view.near); g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke(); }
  g.restore();
  // ---- the sheet: a rectangle of the board, its far edge deckled, a shadow under it
  const X0 = -1500, X1 = 1500, Z0 = view.near, Z1 = 1050;
  const edge = [];
  for (let i = 0; i <= 60; i++) { const X = X0 + ((X1 - X0) * i) / 60, p = at(X, Z1 + (hash(i, 3) - 0.5) * 26); edge.push([p.x, p.y]); }
  const nl = at(X0, Z0), nr = at(X1, Z0);
  const sheet = () => { g.beginPath(); edge.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.lineTo(nr.x, nr.y); g.lineTo(nl.x, nl.y); g.closePath(); };
  g.save(); g.translate(0, 9); g.fillStyle = 'rgba(0,0,0,.5)'; g.filter = 'blur(7px)'; sheet(); g.fill(); g.restore();
  g.filter = 'none';
  const paper = g.createLinearGradient(0, edge[0][1], 0, h);
  paper.addColorStop(0, '#cdbf9c'); paper.addColorStop(0.4, '#e2d5b3'); paper.addColorStop(1, '#d8c9a4');
  g.fillStyle = paper; sheet(); g.fill();
  g.save();
  sheet(); g.clip();
  // paper's wear: soft blots, seeded
  for (let i = 0; i < 46; i++) {
    const p = at((hash(i, 11) - 0.5) * 2800, Z0 + hash(i, 12) * (Z1 - Z0)), r = (60 + hash(i, 13) * 150) * p.k;
    const gr = g.createRadialGradient(p.x, p.y, 0, p.x, p.y, r);
    const dark = hash(i, 14) < 0.55;
    gr.addColorStop(0, dark ? 'rgba(120,96,56,.13)' : 'rgba(255,248,226,.16)'); gr.addColorStop(1, dark ? 'rgba(120,96,56,0)' : 'rgba(255,248,226,0)');
    g.fillStyle = gr; g.save(); g.translate(p.x, p.y); g.scale(1, 0.5); g.translate(-p.x, -p.y); g.beginPath(); g.arc(p.x, p.y, r, 0, Math.PI * 2); g.fill(); g.restore();
  }
  // the lattice: every hexagon of the chart, in sepia ink, fainter with distance; a drawn glyph on some tiles
  const R = TITLE_VIEW.hex;
  g.lineJoin = 'round'; g.lineCap = 'round';
  for (let r = -22; r <= 16; r++) for (let q = -28 - Math.ceil(r / 2); q <= 28 - Math.floor(r / 2); q++) {
    const X = SQRT3 * R * (q + r / 2), Z = -1.5 * R * r;
    if (X < X0 - R || X > X1 + R || Z < Z0 || Z > Z1) continue;
    const c = at(X, Z);
    if (c.y > h + 60 || c.x < -90 || c.x > w + 90) continue;
    const pts = Array.from({ length: 6 }, (_, i) => { const a = Math.PI / 6 + (i * Math.PI) / 3; return at(X + Math.cos(a) * R, Z + Math.sin(a) * R); });
    const d = Math.hypot(X, Z), fade = Math.max(0.16, Math.min(1, c.k * c.k * 0.9));
    g.strokeStyle = `rgba(104,84,48,${(0.34 * fade).toFixed(3)})`; g.lineWidth = Math.max(0.6, 1.1 * c.k);
    g.beginPath(); g.moveTo(pts[0].x, pts[0].y); for (let i = 1; i <= 3; i++) g.lineTo(pts[i].x, pts[i].y); g.stroke();
    // (nothing is drawn on the Concord's own tiles: the tower stands there)
    const kind = hash(q, r), u = R * c.k;
    if (d < R * 3.4 || kind > 0.5) continue;
    g.strokeStyle = `rgba(92,72,40,${(0.5 * fade).toFixed(3)})`; g.lineWidth = Math.max(0.6, 1.2 * c.k);
    g.beginPath();
    if (kind < 0.16) { g.moveTo(c.x - u * 0.42, c.y + u * 0.14); g.lineTo(c.x - u * 0.12, c.y - u * 0.22); g.lineTo(c.x + u * 0.06, c.y - u * 0.02); g.lineTo(c.x + u * 0.2, c.y - u * 0.16); g.lineTo(c.x + u * 0.44, c.y + u * 0.14); }
    else if (kind < 0.34) { for (const dx of [-0.24, 0.2]) { g.moveTo(c.x + u * dx, c.y + u * 0.16); g.lineTo(c.x + u * dx, c.y - u * 0.02); g.moveTo(c.x + u * (dx + 0.13), c.y - u * 0.1); g.arc(c.x + u * dx, c.y - u * 0.1, u * 0.13, 0, Math.PI * 2); } }
    else if (kind < 0.42) { for (const dy of [-0.06, 0.08]) { g.moveTo(c.x - u * 0.34, c.y + u * dy); g.quadraticCurveTo(c.x - u * 0.17, c.y + u * (dy - 0.09), c.x, c.y + u * dy); g.quadraticCurveTo(c.x + u * 0.17, c.y + u * (dy + 0.09), c.x + u * 0.34, c.y + u * dy); } }
    else { for (const [dx, dy] of [[-0.2, 0.06], [0.04, -0.06], [0.24, 0.1]]) { g.moveTo(c.x + u * dx, c.y + u * (dy + 0.07)); g.lineTo(c.x + u * dx, c.y + u * (dy - 0.05)); } }
    g.stroke();
  }
  // the cloud sea along the far rim of the sheet, and a little of it at the sides
  for (let i = 0; i < 70; i++) {
    const X = (hash(i, 21) - 0.5) * 3000, Z = 600 + hash(i, 22) * 430, p = at(X, Z);
    g.save(); g.translate(p.x, p.y); g.scale(1, 0.62); paintHeap(g, 0, 0, (80 + hash(i, 23) * 130) * p.k, 900 + i, 1, hash(i, 24) < 0.3); g.restore();
  }
  g.restore();
  // ---- the dusk: the board darkens away from the bell's light, cool at the rim, warm at the tower
  const mid = { x: cx, y: footY - h * 0.05 }, far = Math.hypot(w, h) * 0.62;
  g.save();
  g.globalCompositeOperation = 'multiply';
  const dusk = g.createRadialGradient(mid.x, mid.y, h * 0.06, mid.x, mid.y, far);
  dusk.addColorStop(0, '#fff4d6'); dusk.addColorStop(0.22, '#e9d3a6'); dusk.addColorStop(0.5, '#8f8c8a'); dusk.addColorStop(0.78, '#3d4a55'); dusk.addColorStop(1, '#141c24');
  g.fillStyle = dusk; g.fillRect(0, 0, w, h);
  g.restore();
  // the bell's pool of light on the paper
  g.save();
  g.globalCompositeOperation = 'lighter';
  g.translate(mid.x, footY); g.scale(1, 0.46);
  const pool = g.createRadialGradient(0, 0, 0, 0, 0, h * 0.62);
  pool.addColorStop(0, 'rgba(255,214,128,.34)'); pool.addColorStop(0.4, 'rgba(255,196,104,.13)'); pool.addColorStop(1, 'rgba(255,196,104,0)');
  g.fillStyle = pool; g.beginPath(); g.arc(0, 0, h * 0.62, 0, Math.PI * 2); g.fill();
  g.restore();
  // the far haze, and the dark that the words stand on along the foot
  const haze = g.createLinearGradient(0, 0, 0, h * 0.3);
  haze.addColorStop(0, 'rgba(10,16,22,.5)'); haze.addColorStop(1, 'rgba(10,16,22,0)');
  g.fillStyle = haze; g.fillRect(0, 0, w, h * 0.3);
  const footDark = g.createLinearGradient(0, h * 0.5, 0, h);
  footDark.addColorStop(0, 'rgba(6,12,11,0)'); footDark.addColorStop(0.3, 'rgba(6,12,11,.55)'); footDark.addColorStop(0.62, 'rgba(6,12,11,.84)'); footDark.addColorStop(1, 'rgba(5,10,9,.96)');
  g.fillStyle = footDark; g.fillRect(0, h * 0.5, w, h * 0.5);
  const side = g.createRadialGradient(cx, h * 0.46, h * 0.36, cx, h * 0.46, Math.max(w, h) * 0.74);
  side.addColorStop(0, 'rgba(4,8,8,0)'); side.addColorStop(1, 'rgba(4,8,8,.82)');
  g.fillStyle = side; g.fillRect(0, 0, w, h);
}

/** Where the six standards stand: `[{faction, x, y, k, z}]` on the picture, the far ones first. */
export function titleStandards(view) {
  const S = TITLE_STANDARDS, out = [];
  for (let f = 0; f < 6; f++) {
    const a = ((S.first + f * 60) * Math.PI) / 180, X = Math.cos(a) * view.ring, Z = -Math.sin(a) * view.ring * S.depth;
    out.push({ faction: f, z: Z, ...view.at(X, Z) });
  }
  return out.sort((p, q) => q.z - p.z);
}

/**
 * One frame of the title's picture into `g` (a canvas of `w` × `h` CSS px, already scaled for the device): the
 * still part from `still` (a canvas of the same picture, or null to paint it now), then the bell's rings, the far
 * standards, the tower, the near standards. `t` seconds; `calm`: nothing moves.
 */
export function paintTitleScene(g, w, h, t = 0, { calm = false, still = null, top = null } = {}) {
  if (!g?.save || !(w > 0) || !(h > 0)) return null;
  const view = titleView(w, h, top);
  if (still) g.drawImage(still, 0, 0, w, h); else paintStill(g, view);
  const { cx, footY, unit } = view;
  // the bell's rings over the board: ellipses that open and fade
  g.save();
  g.lineCap = 'round';
  const squash = (TITLE_VIEW.eye * h) / TITLE_VIEW.far;
  for (let i = 0; i < Math.ceil(TITLE_RING.life / TITLE_RING.every); i++) {
    const age = calm ? TITLE_RING.every * (i + 0.55) : ((t % TITLE_RING.every) + i * TITLE_RING.every), k = age / TITLE_RING.life;
    if (!(k > 0 && k < 1)) continue;
    const r = (70 + 980 * (1 - Math.pow(1 - k, 1.7))) * unit, a = Math.pow(1 - k, 1.4);
    g.strokeStyle = `rgba(255,222,150,${(0.5 * a).toFixed(3)})`; g.lineWidth = Math.max(1, 3.2 * a + 0.8);
    g.beginPath(); g.ellipse?.(cx, footY, r, r * squash * 0.92, 0, 0, Math.PI * 2); g.stroke();
    g.strokeStyle = `rgba(255,236,190,${(0.16 * a).toFixed(3)})`; g.lineWidth = Math.max(2, 9 * a);
    g.beginPath(); g.ellipse?.(cx, footY, r, r * squash * 0.92, 0, 0, Math.PI * 2); g.stroke();
  }
  g.restore();
  const stands = titleStandards(view), now = calm ? 800 : t * 1000;
  const stand = s => {
    // its shadow on the paper, then the standard itself
    g.save(); g.fillStyle = 'rgba(20,16,10,.3)'; g.beginPath(); g.ellipse?.(s.x + 16 * s.k, s.y + 3 * s.k, 30 * s.k, 7 * s.k, 0.2, 0, Math.PI * 2); g.fill(); g.restore();
    paintStandard(g, s.x, s.y, { u: 62 * s.k, zoom: 1, faction: s.faction, now: now + s.faction * 470, still: calm });
  };
  for (const s of stands) if (s.z >= 0) stand(s);
  paintBellTower(g, cx, footY, view.tower, { light: 1 });
  for (const s of stands) if (s.z < 0) stand(s);
  return view;
}

/**
 * Keep the title's picture on `canvas` while the title stands: sized to its box, repainted about 30 times a second
 * (once when `calm()`), stopped by the function it returns. The page calls it when the title opens.
 */
export function mountTitleScene(canvas, { calm = () => false, now = () => (globalThis.performance?.now?.() ?? Date.now()) / 1000 } = {}) {
  const g = canvas?.getContext?.('2d');
  if (!g) return () => {};
  let raf = null, timer = null, still = null, key = '', stopped = false, last = 0;
  const frame = () => {
    raf = null;
    if (stopped || !canvas.isConnected) return;
    const w = canvas.clientWidth, h = canvas.clientHeight, dpr = Math.min(globalThis.devicePixelRatio || 1, 2);
    if (w > 0 && h > 0) {
      const W = Math.round(w * dpr), H = Math.round(h * dpr);
      if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
      // where the words begin (their box in the layout, whatever their entrance is doing): the tower stands above them
      const card = canvas.parentElement?.querySelector?.('.intro-card'), top = card ? Math.round(card.offsetTop / 8) * 8 : null;
      if (key !== `${W}x${H}:${top}`) {
        key = `${W}x${H}:${top}`;
        still = spare(W, H);
        const sg = still?.getContext?.('2d');
        if (sg) { sg.setTransform(dpr, 0, 0, dpr, 0, 0); paintStill(sg, titleView(w, h, top)); } else still = null;
      }
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      paintTitleScene(g, w, h, now(), { calm: calm(), still, top });
      last = now();
    }
    if (calm()) return;
    timer = setTimeout(() => { timer = null; raf = globalThis.requestAnimationFrame?.(frame) ?? null; }, 33);
  };
  const kick = () => { if (!raf && !timer && !stopped) raf = globalThis.requestAnimationFrame?.(frame) ?? null; };
  const onResize = () => { key = ''; kick(); if (calm()) frame(); };
  globalThis.addEventListener?.('resize', onResize);
  // (the first picture now: a canvas that has just come onto the page is never seen empty)
  frame();
  return () => { stopped = true; if (raf) globalThis.cancelAnimationFrame?.(raf); if (timer) clearTimeout(timer); globalThis.removeEventListener?.('resize', onResize); void last; };
}
