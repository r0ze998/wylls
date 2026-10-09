// The bell at the Concord (UX brief §1, §3, §11.9): the one landmark of the
// chart. Everyone hears the bell, so it is drawn for everyone, at every zoom,
// whatever the viewer has surveyed; before joining the camera opens on it.
//
// The Engine's own art begins as a ring of markers on bare ground (stage 0,
// which is what a season shows until the Engine is raised). A ring of markers
// is no landmark, so the bell that tolls every turn is given its tower here:
// drawn by code in the map's painted manner (cream stone, slate, bell bronze,
// light from the upper left, a cast shadow to the lower right, a thin ink
// line so it also sits on the parchment of the chart). It stands inside the
// ring of markers and is drawn only while the Engine's art is at stage 0: a
// raised Engine has its own pictures.
//
// `paintBellTower(g, x, y, u)` draws it with its foot at (x, y) in the units
// of the context (`u`: a hex's corner radius); `towerSprite(px)` keeps it as a
// bitmap for a given size on screen. Pure drawing; context-tolerant.
import { FLATTEN } from '../../map.mjs';

/** The tower in units of a hex's corner radius: how wide its plinth is, how high it stands on screen, and the box its picture needs around its foot. */
export const TOWER = Object.freeze({ plinth: 1.22, height: 5.1, box: Object.freeze({ left: 2.5, right: 3.3, top: 5.5, bottom: 1.5 }) });

const STONE = { top: '#ece4cd', lit: '#f3ecd8', mid: '#d6ccb2', shade: '#a99f86', dark: '#857c66', line: 'rgba(58,48,32,.55)' };
const SLATE = { lit: '#4b7a72', shade: '#22423d', edge: '#12302b' };
const BRASS = { lit: '#f6dc8a', mid: '#d2a546', shade: '#8a6220', dark: '#573d12' };

const poly = (g, pts, fill, stroke = null, lw = 0) => {
  g.beginPath();
  pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
  g.closePath();
  if (fill) { g.fillStyle = fill; g.fill(); }
  if (stroke) { g.strokeStyle = stroke; g.lineWidth = lw; g.stroke(); }
};
/** The six corners of a flattened hexagon of radius r about (x, y), a pointy top. */
const hex = (x, y, r) => Array.from({ length: 6 }, (_, i) => { const a = -Math.PI / 2 + (i * Math.PI) / 3; return [x + Math.cos(a) * r, y + Math.sin(a) * r * FLATTEN]; });

/** A hexagonal step of radius r whose top lies `h` above its foot at (x, y): the three sides that face the eye, then the top. */
function step(g, x, y, r, h, lw) {
  const b = hex(x, y, r), t = hex(x, y - h, r);
  // corners: 0 top, 1 upper right, 2 lower right, 3 bottom, 4 lower left, 5 upper left
  poly(g, [t[4], t[3], b[3], b[4]], STONE.mid, STONE.line, lw);
  poly(g, [t[3], t[2], b[2], b[3]], STONE.shade, STONE.line, lw);
  poly(g, [t[5], t[4], b[4], b[5]], STONE.lit, STONE.line, lw);
  poly(g, [t[2], t[1], b[1], b[2]], STONE.dark, STONE.line, lw);
  poly(g, t, STONE.top, STONE.line, lw);
}

/**
 * The bell tower with its foot at (x, y): a cast shadow, two hexagonal steps,
 * a square shaft seen on its corner, an open belfry with the bell in it, a
 * slate spire with a brass finial, and the bell's warm light. `u`: a hex's
 * corner radius in the context's units. `light` 0..1: how strong the glow is.
 */
export function paintBellTower(g, x, y, u, { light = 1 } = {}) {
  if (!g?.save) return;
  const lw = Math.max(0.012 * u, 0.6 * (u / 44) * 0.5);
  g.save();
  g.lineJoin = 'round'; g.lineCap = 'round';
  // ---- the light it stands in, and its shadow on the ground (to the lower right, as every prop's)
  if (light > 0 && g.createRadialGradient) {
    const pool = g.createRadialGradient(x, y - 0.1 * u, 0.2 * u, x, y - 0.1 * u, 2.3 * u);
    pool.addColorStop(0, `rgba(255,236,170,${0.34 * light})`); pool.addColorStop(0.55, `rgba(255,228,160,${0.12 * light})`); pool.addColorStop(1, 'rgba(255,228,160,0)');
    g.save(); g.translate(x, y); g.scale(1, FLATTEN); g.translate(-x, -y);
    g.fillStyle = pool; g.beginPath(); g.arc(x, y - 0.1 * u, 2.3 * u, 0, Math.PI * 2); g.fill();
    g.restore();
  }
  g.save();
  g.translate(x, y); g.rotate(0.3);
  g.fillStyle = 'rgba(30,26,18,.2)'; g.beginPath(); g.ellipse?.(1.3 * u, 0.02 * u, 2.0 * u, 0.5 * u, 0, 0, Math.PI * 2); g.fill();
  g.fillStyle = 'rgba(30,26,18,.26)'; g.beginPath(); g.ellipse?.(1.0 * u, 0.0 * u, 1.5 * u, 0.36 * u, 0, 0, Math.PI * 2); g.fill();
  g.restore();
  // ---- the steps
  step(g, x, y, TOWER.plinth * u, 0.16 * u, lw);
  step(g, x, y - 0.16 * u, 0.9 * u, 0.15 * u, lw);
  // ---- the shaft: a square on its corner, tapering; left face in the light, right face in shade
  const y0 = y - 0.31 * u, H = 2.0 * u, a0 = 0.56 * u, a1 = 0.43 * u, f = FLATTEN * 0.8;
  const base = { l: [x - a0, y0], f: [x, y0 + a0 * f], r: [x + a0, y0] }, top = { l: [x - a1, y0 - H], f: [x, y0 - H + a1 * f], r: [x + a1, y0 - H] };
  // (a moulding at its foot)
  poly(g, [[x - a0 * 1.14, y0], [x, y0 + a0 * f * 1.14], [x, y0 + a0 * f * 1.14 - 0.14 * u], [x - a0 * 1.14, y0 - 0.14 * u]], STONE.mid, STONE.line, lw);
  poly(g, [[x + a0 * 1.14, y0], [x, y0 + a0 * f * 1.14], [x, y0 + a0 * f * 1.14 - 0.14 * u], [x + a0 * 1.14, y0 - 0.14 * u]], STONE.dark, STONE.line, lw);
  const left = [base.l, base.f, top.f, top.l], right = [base.r, base.f, top.f, top.r];
  if (g.createLinearGradient) {
    const gl = g.createLinearGradient(x - a0, 0, x, 0); gl.addColorStop(0, '#fbf5e4'); gl.addColorStop(1, '#e3dac2');
    const gr = g.createLinearGradient(x, 0, x + a0, 0); gr.addColorStop(0, '#b7ad93'); gr.addColorStop(1, '#93896f');
    poly(g, left, gl, STONE.line, lw); poly(g, right, gr, STONE.line, lw);
  } else { poly(g, left, STONE.lit, STONE.line, lw); poly(g, right, STONE.shade, STONE.line, lw); }
  // the courses of the stone, and a slit of a window on each face
  g.save();
  g.strokeStyle = 'rgba(70,58,36,.2)'; g.lineWidth = lw * 0.8;
  for (let i = 1; i < 9; i++) {
    const k = i / 9, a = a0 + (a1 - a0) * k, yy = y0 - H * k;
    g.beginPath(); g.moveTo(x - a, yy); g.lineTo(x, yy + a * f); g.lineTo(x + a, yy); g.stroke();
  }
  g.restore();
  const slit = (cx, cy, skew, fill) => poly(g, [[cx - 0.05 * u, cy + 0.2 * u - skew], [cx + 0.05 * u, cy + 0.2 * u + skew], [cx + 0.05 * u, cy - 0.12 * u + skew], [cx, cy - 0.2 * u], [cx - 0.05 * u, cy - 0.12 * u - skew]], fill, STONE.line, lw * 0.8);
  slit(x + a0 * 0.46, y0 - H * 0.36, 0.03 * u, '#39321f');
  slit(x + a0 * 0.42, y0 - H * 0.72, 0.03 * u, '#39321f');
  // a door at its foot, on the face in the light (the faces lean back: each mark follows its face's slope)
  const lean = (a0 * f) / a0;
  const onLeft = (dx, up) => [x - a0 * 0.5 + dx, y0 + a0 * f * 0.5 + dx * lean - up];
  g.beginPath();
  g.moveTo(...onLeft(-0.12 * u, 0.02 * u)); g.lineTo(...onLeft(-0.12 * u, 0.34 * u));
  g.quadraticCurveTo(...onLeft(0, 0.52 * u), ...onLeft(0.12 * u, 0.34 * u));
  g.lineTo(...onLeft(0.12 * u, 0.02 * u)); g.closePath();
  g.fillStyle = '#5a4526'; g.fill(); g.strokeStyle = STONE.line; g.lineWidth = lw; g.stroke();
  // the turn's dial on the same face: a brass ring with one hand (the HUD's dial is this one, seen close)
  const dc = [x - a0 * 0.47, y0 - H * 0.66 + a0 * f * 0.5], dr = 0.19 * u;
  g.save();
  g.translate(dc[0], dc[1]); g.transform(1, lean * 0.9, 0, 1, 0, 0);
  g.fillStyle = '#17302b'; g.strokeStyle = BRASS.dark; g.lineWidth = lw * 1.2; g.beginPath(); g.arc(0, 0, dr, 0, Math.PI * 2); g.fill(); g.stroke();
  g.strokeStyle = BRASS.mid; g.lineWidth = 0.05 * u; g.beginPath(); g.arc(0, 0, dr * 0.86, 0, Math.PI * 2); g.stroke();
  g.strokeStyle = BRASS.lit; g.lineWidth = 0.022 * u; g.beginPath(); g.arc(0, 0, dr * 0.86, -Math.PI / 2, Math.PI * 0.2); g.stroke();
  g.strokeStyle = '#fff3cf'; g.lineWidth = 0.03 * u; g.beginPath(); g.moveTo(0, 0); g.lineTo(dr * 0.42, -dr * 0.5); g.stroke();
  g.restore();
  // ---- the cornice under the belfry, with a line of brass
  const yc = y0 - H, c = a1 * 1.3;
  poly(g, [[x - c, yc], [x, yc + c * f], [x, yc + c * f - 0.16 * u], [x - c, yc - 0.16 * u]], STONE.lit, STONE.line, lw);
  poly(g, [[x + c, yc], [x, yc + c * f], [x, yc + c * f - 0.16 * u], [x + c, yc - 0.16 * u]], STONE.shade, STONE.line, lw);
  g.strokeStyle = BRASS.mid; g.lineWidth = 0.035 * u; g.beginPath(); g.moveTo(x - c, yc - 0.08 * u); g.lineTo(x, yc + c * f - 0.08 * u); g.lineTo(x + c, yc - 0.08 * u); g.stroke();
  // ---- the belfry: an open room on four posts; the floor, the far posts, the bell, the near posts and their arches
  const yb = yc - 0.16 * u, hb = 1.02 * u, b = a1 * 1.16;
  poly(g, [[x - b, yb], [x, yb + b * f], [x + b, yb], [x, yb - b * f]], '#6f6752', STONE.line, lw);
  const post = (px, py, w, fill) => poly(g, [[px - w, py], [px + w, py], [px + w, py - hb], [px - w, py - hb]], fill, STONE.line, lw);
  post(x, yb - b * f, 0.07 * u, STONE.dark);
  // the dark of the room behind the bell
  poly(g, [[x - b, yb - 0.02 * u], [x, yb - b * f], [x + b, yb - 0.02 * u], [x + b, yb - hb], [x, yb - hb - b * f * 0.2], [x - b, yb - hb]], 'rgba(34,30,22,.82)');
  // the bell: bronze, hung from the beam, its lip flared, a light on its shoulder
  const by = yb - hb * 0.2, bw = 0.34 * u, bh = 0.6 * u;
  if (light > 0 && g.createRadialGradient) {
    const glow = g.createRadialGradient(x, by - bh * 0.4, 0, x, by - bh * 0.4, 1.5 * u);
    glow.addColorStop(0, `rgba(255,206,96,${0.62 * light})`); glow.addColorStop(0.35, `rgba(255,190,84,${0.26 * light})`); glow.addColorStop(1, 'rgba(255,190,84,0)');
    g.fillStyle = glow; g.beginPath(); g.arc(x, by - bh * 0.4, 1.5 * u, 0, Math.PI * 2); g.fill();
  }
  g.strokeStyle = BRASS.dark; g.lineWidth = 0.05 * u; g.beginPath(); g.moveTo(x, yb - hb); g.lineTo(x, by - bh); g.stroke();
  g.beginPath();
  g.moveTo(x - bw * 1.25, by);
  g.quadraticCurveTo(x - bw * 0.82, by - bh * 0.18, x - bw * 0.72, by - bh * 0.62);
  g.quadraticCurveTo(x - bw * 0.62, by - bh * 1.02, x, by - bh * 1.02);
  g.quadraticCurveTo(x + bw * 0.62, by - bh * 1.02, x + bw * 0.72, by - bh * 0.62);
  g.quadraticCurveTo(x + bw * 0.82, by - bh * 0.18, x + bw * 1.25, by);
  g.quadraticCurveTo(x, by + bh * 0.2, x - bw * 1.25, by);
  g.closePath();
  if (g.createLinearGradient) { const gb = g.createLinearGradient(x - bw * 1.2, 0, x + bw * 1.2, 0); gb.addColorStop(0, BRASS.lit); gb.addColorStop(0.38, BRASS.mid); gb.addColorStop(1, BRASS.shade); g.fillStyle = gb; } else g.fillStyle = BRASS.mid;
  g.fill(); g.strokeStyle = BRASS.dark; g.lineWidth = lw * 1.2; g.stroke();
  g.strokeStyle = 'rgba(255,248,214,.9)'; g.lineWidth = 0.035 * u; g.beginPath(); g.moveTo(x - bw * 0.5, by - bh * 0.78); g.quadraticCurveTo(x - bw * 0.62, by - bh * 0.5, x - bw * 0.7, by - bh * 0.22); g.stroke();
  g.fillStyle = BRASS.dark; g.beginPath(); g.arc(x, by + bh * 0.1, 0.055 * u, 0, Math.PI * 2); g.fill();
  // the near posts (left in the light, front and right in shade) and the arches between them
  post(x - b, yb, 0.075 * u, STONE.lit);
  post(x + b, yb, 0.075 * u, STONE.shade);
  post(x, yb + b * f, 0.085 * u, STONE.mid);
  const arch = (x0, yA, x1, yB, fill) => {
    const top0 = yA - hb, top1 = yB - hb, drop = 0.26 * u;
    g.beginPath(); g.moveTo(x0, top0); g.lineTo(x1, top1); g.lineTo(x1, top1 + drop);
    g.quadraticCurveTo((x0 + x1) / 2, (top0 + top1) / 2 - drop * 0.1, x0, top0 + drop);
    g.closePath(); g.fillStyle = fill; g.fill(); g.strokeStyle = STONE.line; g.lineWidth = lw; g.stroke();
  };
  arch(x - b - 0.075 * u, yb, x, yb + b * f, STONE.lit);
  arch(x, yb + b * f, x + b + 0.075 * u, yb, STONE.shade);
  // ---- the eaves and the spire: slate, a brass rib on its near edge, a finial that catches the light
  const ye = yb - hb, e = b * 1.3, sp = 1.55 * u;
  poly(g, [[x - e, ye], [x, ye + e * f], [x, ye + e * f - 0.1 * u], [x - e, ye - 0.1 * u]], '#35564f', SLATE.edge, lw);
  poly(g, [[x + e, ye], [x, ye + e * f], [x, ye + e * f - 0.1 * u], [x + e, ye - 0.1 * u]], '#1b3531', SLATE.edge, lw);
  const yr = ye - 0.1 * u, apex = [x, yr - sp];
  if (g.createLinearGradient) {
    const sl = g.createLinearGradient(x - e, yr, x, yr - sp * 0.4); sl.addColorStop(0, '#5a8c83'); sl.addColorStop(1, '#3a655e');
    poly(g, [[x - e, yr], [x, yr + e * f], apex], sl, SLATE.edge, lw);
  } else poly(g, [[x - e, yr], [x, yr + e * f], apex], SLATE.lit, SLATE.edge, lw);
  poly(g, [[x + e, yr], [x, yr + e * f], apex], SLATE.shade, SLATE.edge, lw);
  // (the slates' courses)
  g.save();
  g.strokeStyle = 'rgba(10,26,23,.3)'; g.lineWidth = lw * 0.8;
  for (let i = 1; i < 6; i++) { const k = i / 6, ex = e * (1 - k), yy = yr - sp * k; g.beginPath(); g.moveTo(x - ex, yy); g.lineTo(x, yy + ex * f); g.lineTo(x + ex, yy); g.stroke(); }
  g.restore();
  g.strokeStyle = BRASS.mid; g.lineWidth = 0.04 * u; g.beginPath(); g.moveTo(x, yr + e * f); g.lineTo(apex[0], apex[1]); g.stroke();
  g.strokeStyle = BRASS.lit; g.lineWidth = 0.015 * u; g.beginPath(); g.moveTo(x - 0.012 * u, yr + e * f); g.lineTo(apex[0] - 0.012 * u, apex[1]); g.stroke();
  // the finial: a ball and a spike
  g.strokeStyle = BRASS.dark; g.lineWidth = 0.05 * u; g.beginPath(); g.moveTo(apex[0], apex[1] + 0.02 * u); g.lineTo(apex[0], apex[1] - 0.34 * u); g.stroke();
  g.strokeStyle = BRASS.mid; g.lineWidth = 0.028 * u; g.beginPath(); g.moveTo(apex[0], apex[1] + 0.02 * u); g.lineTo(apex[0], apex[1] - 0.34 * u); g.stroke();
  g.fillStyle = BRASS.mid; g.strokeStyle = BRASS.dark; g.lineWidth = lw * 1.2; g.beginPath(); g.arc(apex[0], apex[1] - 0.1 * u, 0.1 * u, 0, Math.PI * 2); g.fill(); g.stroke();
  g.fillStyle = '#fffbe6'; g.beginPath(); g.arc(apex[0] - 0.035 * u, apex[1] - 0.135 * u, 0.032 * u, 0, Math.PI * 2); g.fill();
  g.restore();
}

const sprites = new Map();
const spare = (w, h) => (typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : typeof document !== 'undefined' ? Object.assign(document.createElement('canvas'), { width: w, height: h }) : null);
/** The steps of resolution the tower is kept at (device px per unit of a hex's corner radius). */
const SIZES = Object.freeze([14, 28, 56, 88, 132]);

/**
 * The tower as a bitmap for a hex radius of `px` device px on screen:
 * `{cv, ox, oy, w, h}` in units of the radius (draw it at
 * `(x − ox·R, y − oy·R, w·R, h·R)` for a foot at (x, y)), or null where no
 * spare canvas can be made (the caller paints it straight).
 */
export function towerSprite(px) {
  const r = SIZES.find(s => s >= px * 0.9) ?? SIZES[SIZES.length - 1];
  if (sprites.has(r)) return sprites.get(r);
  const B = TOWER.box, w = Math.ceil((B.left + B.right) * r), h = Math.ceil((B.top + B.bottom) * r);
  const cv = spare(w, h), g = cv?.getContext?.('2d');
  if (!g) { sprites.set(r, null); return null; }
  paintBellTower(g, B.left * r, B.top * r, r);
  const v = { cv, ox: B.left, oy: B.top, w: B.left + B.right, h: B.top + B.bottom };
  sprites.set(r, v);
  return v;
}
