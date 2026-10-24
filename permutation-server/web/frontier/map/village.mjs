// A village, drawn by code (UX brief §11.6: the village is the hero).
//
// The baked village art is one tile's sprite: a town is some ninety pixels at
// its largest, so it could only be shown larger by stretching it, and a
// stretched sprite is soft beside the crisp plates around it. Here every tier
// is drawn at whatever size the screen asks for, in the manner of the bell's
// tower (map/belltower.mjs): light from the upper left, a shadow to the lower
// right, a thin ink line, roofs in the nation's colour. Each tier has a
// silhouette of its own that reads from afar:
//
//   hamlet       a long hall with its banner, three cottages, a well, a low palisade, strips of field
//   town         a hall on a square, a watchtower, a ring of houses, market stalls, a palisade with a gate
//   city         a stone wall with round towers and a gatehouse, a keep, close-built houses
//   stronghold   a thicker wall, a great keep with four turrets, barrack rows
//
// `paintVillage(g, x, y, u, opts)` draws one with the middle of its ground at
// (x, y); `u` is a hex's corner radius in the context's units times the scale
// it is drawn at. `villageSprite(px, opts)` keeps it as a bitmap for a size on
// screen, so a frame is one copy. Pure drawing; context-tolerant.
import { FLATTEN } from '../../map.mjs';
import { FACTION_FILL, FACTION_DARK } from '../people/avatar.mjs';

/** How flat the ground is drawn (the tower's own: a square seen on its corner). */
const F = FLATTEN * 0.8;
/** Per tier (hamlet, town, city, stronghold), in units of `u`: the ring's radius, and how high the tallest roof stands above the ground's middle. */
export const VILLAGE = Object.freeze({
  ring: Object.freeze([0.6, 0.78, 0.9, 0.96]),
  top: Object.freeze([0.62, 0.92, 1.12, 1.3]),
  /** The box a picture needs around the middle of its ground. */
  box: Object.freeze({ left: 2.2, right: 1.8, top: 2.0, bottom: 1.05 }),
  /** Where smoke rises (units of `u` from the ground's middle): the hall's chimney first. */
  chimneys: Object.freeze([
    Object.freeze([[-0.02, -0.36], [0.36, -0.06]]),
    Object.freeze([[-0.06, -0.52], [0.42, 0.0], [-0.5, 0.02]]),
    Object.freeze([[-0.3, -0.42], [0.4, -0.1], [-0.42, 0.14]]),
    Object.freeze([[-0.44, -0.2], [0.46, -0.16], [0.0, 0.2]]),
  ]),
});

const WALL = { lit: '#f4ead2', mid: '#dfd2b2', shade: '#b5a685', dark: '#8b7b5d', timber: '#6a4c30', line: 'rgba(58,44,28,.62)' };
const WOOD = { lit: '#b89260', mid: '#93703f', shade: '#6d4f2b', dark: '#48321a' };
const STONE = { top: '#efe7d1', lit: '#e9e0c9', mid: '#d0c6ac', shade: '#a59c84', dark: '#7d7560', line: 'rgba(58,48,32,.6)' };
const BRASS = { lit: '#f6dc8a', mid: '#d2a546', dark: '#573d12' };

const rgb = hex => { const n = parseInt(String(hex).slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const mix = (a, b, k) => { const A = rgb(a), B = rgb(b); return `rgb(${A.map((v, i) => Math.round(v + (B[i] - v) * k)).join(',')})`; };
/** A roof's colours for nation `f`. */
function roofOf(f) {
  const base = FACTION_FILL[f] ?? '#9a7a52', dark = FACTION_DARK[f] ?? '#5a4026';
  return { lit: mix(base, '#fff2d8', 0.24), mid: base, shade: mix(base, dark, 0.62), deep: mix(dark, '#1a120a', 0.3), ridge: mix(base, '#fff6e0', 0.55), line: mix(dark, '#1a120a', 0.45) };
}

const poly = (g, pts, fill, stroke = null, lw = 0) => {
  g.beginPath();
  pts.forEach(([px, py], i) => (i ? g.lineTo(px, py) : g.moveTo(px, py)));
  g.closePath();
  if (fill) { g.fillStyle = fill; g.fill(); }
  if (stroke) { g.strokeStyle = stroke; g.lineWidth = lw; g.stroke(); }
};
const line = (g, pts, stroke, lw) => { g.beginPath(); pts.forEach(([px, py], i) => (i ? g.lineTo(px, py) : g.moveTo(px, py))); g.strokeStyle = stroke; g.lineWidth = lw; g.stroke(); };

/**
 * The drawing kit for one village: `P(gx, gy, z)` is the point `z` above ground point (gx, gy) (the ground seen from
 * above: x to the right, y toward the eye; units of `u`).
 */
function kit(g, x, y, u, lw) {
  const P = (gx, gy, z = 0) => [x + gx * u, y + gy * F * u - z * u];
  // a house's own axes run along the square's diagonals: `a` to the lower right, `b` to the lower left
  const Q = (cx, cy, a, b, z = 0) => P(cx + (a - b) * 0.5, cy + (a + b) * 0.5, z);
  const shadow = (cx, cy, ha, hb, h) => {
    const d = h * 1.25;
    poly(g, [Q(cx, cy, -ha, hb), Q(cx, cy, ha + d, hb), Q(cx, cy, ha + d, -hb), Q(cx, cy, ha, -hb)], 'rgba(34,26,14,.24)');
  };
  /** A house: half sizes (ha, hb), walls `h` high, a gabled roof `rh` high with its ridge along `along`. */
  const house = ({ gx, gy, ha = 0.13, hb = 0.1, h = 0.11, rh = 0.1, along = 'a', roof, wall = WALL, door = true, chimney = false, timber = false }) => {
    const q = (a, b, z) => Q(gx, gy, a, b, z), e = 0.028, ez = 0.012;
    shadow(gx, gy, ha, hb, h + rh * 0.5);
    const right = [q(ha, -hb, 0), q(ha, hb, 0), q(ha, hb, h), q(ha, -hb, h)], left = [q(-ha, hb, 0), q(ha, hb, 0), q(ha, hb, h), q(-ha, hb, h)];
    if (along === 'a') {
      poly(g, [q(-ha - e, -hb - e, h - ez), q(ha + e, -hb - e, h - ez), q(ha + e, 0, h + rh), q(-ha - e, 0, h + rh)], roof.deep, roof.line, lw);
      poly(g, [right[0], right[1], right[2], q(ha, 0, h + rh), right[3]], wall.shade, wall.line, lw);
      poly(g, left, wall.lit, wall.line, lw);
    } else {
      poly(g, [q(-ha - e, -hb - e, h - ez), q(-ha - e, hb + e, h - ez), q(0, hb + e, h + rh), q(0, -hb - e, h + rh)], roof.mid, roof.line, lw);
      poly(g, right, wall.shade, wall.line, lw);
      poly(g, [left[0], left[1], left[2], q(0, hb, h + rh), left[3]], wall.lit, wall.line, lw);
    }
    // timber framing on the lit wall, a door, a window on the shaded one
    if (timber) {
      g.strokeStyle = 'rgba(96,68,40,.55)'; g.lineWidth = lw * 1.1;
      for (const k of [-0.5, 0, 0.5]) { g.beginPath(); g.moveTo(...q(ha * k * 1.6, hb, 0)); g.lineTo(...q(ha * k * 1.6, hb, h)); g.stroke(); }
      g.beginPath(); g.moveTo(...q(-ha, hb, h * 0.55)); g.lineTo(...q(ha, hb, h * 0.55)); g.stroke();
    }
    if (door) {
      const d0 = along === 'a' ? ha * 0.3 : -ha * 0.1, dw = Math.min(0.03, ha * 0.24);
      poly(g, [q(d0 - dw, hb, 0), q(d0 + dw, hb, 0), q(d0 + dw, hb, h * 0.62), q(d0 - dw, hb, h * 0.62)], '#553c22', wall.line, lw * 0.8);
    }
    poly(g, [q(ha, -hb * 0.35, h * 0.38), q(ha, hb * 0.2, h * 0.38), q(ha, hb * 0.2, h * 0.74), q(ha, -hb * 0.35, h * 0.74)], 'rgba(40,30,18,.7)');
    // the roof's near side
    let near;
    if (along === 'a') near = [q(-ha - e, hb + e, h - ez), q(ha + e, hb + e, h - ez), q(ha + e, 0, h + rh), q(-ha - e, 0, h + rh)];
    else near = [q(ha + e, -hb - e, h - ez), q(ha + e, hb + e, h - ez), q(0, hb + e, h + rh), q(0, -hb - e, h + rh)];
    if (g.createLinearGradient) {
      const gr = g.createLinearGradient(near[3][0], near[3][1], near[0][0], near[0][1]);
      gr.addColorStop(0, along === 'a' ? roof.lit : roof.mid); gr.addColorStop(1, along === 'a' ? roof.mid : roof.shade);
      poly(g, near, gr, roof.line, lw);
    } else poly(g, near, along === 'a' ? roof.mid : roof.shade, roof.line, lw);
    // the courses of the roof, and the light along its ridge
    g.save();
    g.strokeStyle = 'rgba(30,16,8,.2)'; g.lineWidth = lw * 0.8;
    for (const k of [0.36, 0.7]) {
      const m = (p0, p1) => [p0[0] + (p1[0] - p0[0]) * k, p0[1] + (p1[1] - p0[1]) * k];
      g.beginPath(); g.moveTo(...m(near[3], near[0])); g.lineTo(...m(near[2], near[1])); g.stroke();
    }
    g.restore();
    line(g, [near[3], near[2]], roof.ridge, lw * 1.5);
    if (chimney) {
      const c = along === 'a' ? q(-ha * 0.4, -hb * 0.1, h + rh * 0.86) : q(-ha * 0.1, -hb * 0.4, h + rh * 0.86), w = 0.022 * u, hh = 0.085 * u;
      poly(g, [[c[0] - w, c[1]], [c[0] + w, c[1]], [c[0] + w, c[1] - hh], [c[0] - w, c[1] - hh]], STONE.mid, STONE.line, lw * 0.8);
      poly(g, [[c[0], c[1]], [c[0] + w, c[1]], [c[0] + w, c[1] - hh], [c[0], c[1] - hh]], STONE.shade);
    }
  };
  /** A round tower with a cone roof, its foot at ground point (gx, gy). */
  const tower = ({ gx, gy, r = 0.075, h = 0.3, roof, cone = 0.2 }) => {
    const [bx, by] = P(gx, gy), rr = r * u, ry = rr * F, top = by - h * u;
    g.fillStyle = 'rgba(34,26,14,.22)'; g.beginPath(); g.ellipse?.(bx + rr * 1.7, by + ry * 0.4, rr * 2.2, ry * 1.1, 0.25, 0, Math.PI * 2); g.fill();
    g.beginPath(); g.moveTo(bx - rr, top); g.lineTo(bx - rr, by); g.ellipse?.(bx, by, rr, ry, 0, Math.PI, 0, true); g.lineTo(bx + rr, top); g.closePath();
    if (g.createLinearGradient) { const gr = g.createLinearGradient(bx - rr, 0, bx + rr, 0); gr.addColorStop(0, STONE.lit); gr.addColorStop(0.45, STONE.mid); gr.addColorStop(1, STONE.dark); g.fillStyle = gr; } else g.fillStyle = STONE.mid;
    g.fill(); g.strokeStyle = STONE.line; g.lineWidth = lw; g.stroke();
    // a slit, the courses, the parapet
    g.fillStyle = 'rgba(40,32,20,.75)'; g.fillRect(bx - rr * 0.18, top + h * u * 0.3, rr * 0.2, h * u * 0.2);
    g.strokeStyle = 'rgba(70,58,36,.22)'; g.lineWidth = lw * 0.8;
    for (const k of [0.3, 0.6]) { g.beginPath(); g.ellipse?.(bx, by - h * u * k, rr, ry, 0, 0.1, Math.PI - 0.1); g.stroke(); }
    const er = rr * 1.22;
    g.beginPath(); g.moveTo(bx - er, top); g.ellipse?.(bx, top, er, er * F, 0, Math.PI, 0, true); g.lineTo(bx, top - cone * u); g.closePath();
    if (g.createLinearGradient) { const gr = g.createLinearGradient(bx - er, 0, bx + er, 0); gr.addColorStop(0, roof.lit); gr.addColorStop(0.5, roof.mid); gr.addColorStop(1, roof.deep); g.fillStyle = gr; } else g.fillStyle = roof.mid;
    g.fill(); g.strokeStyle = roof.line; g.lineWidth = lw; g.stroke();
    line(g, [[bx - er * 0.3, top - cone * u * 0.3], [bx, top - cone * u]], roof.ridge, lw * 1.3);
    g.fillStyle = BRASS.mid; g.beginPath(); g.arc(bx, top - cone * u - 0.012 * u, 0.016 * u, 0, Math.PI * 2); g.fill();
  };
  /** A square keep seen on its corner: half width `a`, `h` high, battlements, a pyramid roof (`cap` high) or none. */
  const keep = ({ gx, gy, a = 0.2, h = 0.42, roof, cap = 0.22, stone = STONE }) => {
    const q = (da, db, z) => Q(gx, gy, da, db, z);
    shadow(gx, gy, a, a, h * 0.9);
    const right = [q(a, -a, 0), q(a, a, 0), q(a, a, h), q(a, -a, h)], left = [q(-a, a, 0), q(a, a, 0), q(a, a, h), q(-a, a, h)];
    if (g.createLinearGradient) {
      const gl = g.createLinearGradient(left[0][0], 0, left[1][0], 0); gl.addColorStop(0, '#fbf5e4'); gl.addColorStop(1, stone.lit);
      const gr = g.createLinearGradient(right[1][0], 0, right[0][0], 0); gr.addColorStop(0, stone.shade); gr.addColorStop(1, stone.dark);
      poly(g, right, gr, stone.line, lw); poly(g, left, gl, stone.line, lw);
    } else { poly(g, right, stone.shade, stone.line, lw); poly(g, left, stone.lit, stone.line, lw); }
    // the courses, two slits, a door
    g.save(); g.strokeStyle = 'rgba(70,58,36,.2)'; g.lineWidth = lw * 0.8;
    for (let i = 1; i < 5; i++) { const z = (h * i) / 5; g.beginPath(); g.moveTo(...q(-a, a, z)); g.lineTo(...q(a, a, z)); g.lineTo(...q(a, -a, z)); g.stroke(); }
    g.restore();
    poly(g, [q(-a * 0.2, a, 0), q(a * 0.2, a, 0), q(a * 0.2, a, h * 0.26), q(0, a, h * 0.34), q(-a * 0.2, a, h * 0.26)], '#4d3720', stone.line, lw * 0.8);
    for (const z of [0.5, 0.74]) poly(g, [q(a, -a * 0.12, h * z), q(a, a * 0.12, h * z), q(a, a * 0.12, h * (z + 0.12)), q(a, -a * 0.12, h * (z + 0.12))], 'rgba(34,26,16,.8)');
    // the battlements: a band that stands out a little, with merlons
    const o = a * 1.12, hb = 0.05;
    poly(g, [q(o, -o, h), q(o, o, h), q(o, o, h + hb), q(o, -o, h + hb)], stone.shade, stone.line, lw);
    poly(g, [q(-o, o, h), q(o, o, h), q(o, o, h + hb), q(-o, o, h + hb)], stone.top, stone.line, lw);
    poly(g, [q(-o, -o, h + hb), q(o, -o, h + hb), q(o, o, h + hb), q(-o, o, h + hb)], stone.mid, stone.line, lw);
    for (let i = 0; i < 4; i++) {
      const k0 = -1 + i * 0.56, k1 = k0 + 0.3;
      poly(g, [q(o * k0, o, h + hb), q(o * k1, o, h + hb), q(o * k1, o, h + hb * 2), q(o * k0, o, h + hb * 2)], stone.top, stone.line, lw * 0.8);
      poly(g, [q(o, o * -k0, h + hb), q(o, o * -k1, h + hb), q(o, o * -k1, h + hb * 2), q(o, o * -k0, h + hb * 2)], stone.shade, stone.line, lw * 0.8);
    }
    if (cap > 0) {
      const r0 = a * 0.86, z0 = h + hb, apex = q(0, 0, z0 + cap);
      poly(g, [q(-r0, r0, z0), q(r0, r0, z0), apex], roof.lit, roof.line, lw);
      poly(g, [q(r0, -r0, z0), q(r0, r0, z0), apex], roof.shade, roof.line, lw);
      line(g, [q(r0, r0, z0), apex], roof.ridge, lw * 1.4);
    }
    return q(0, 0, h + 0.05 + cap);
  };
  /** A pole with a pennon in the nation's colour, its foot at screen point `at`. */
  const banner = (at, roof, s = 1) => {
    const [bx, by] = at, hh = 0.24 * u * s;
    line(g, [[bx, by], [bx, by - hh]], 'rgba(40,28,14,.9)', lw * 2.2);
    line(g, [[bx, by], [bx, by - hh]], WOOD.lit, lw * 1.1);
    poly(g, [[bx, by - hh], [bx + 0.15 * u * s, by - hh + 0.035 * u * s], [bx + 0.1 * u * s, by - hh + 0.065 * u * s], [bx + 0.15 * u * s, by - hh + 0.1 * u * s], [bx, by - hh + 0.12 * u * s]], roof.mid, roof.line, lw);
    g.fillStyle = BRASS.lit; g.beginPath(); g.arc(bx, by - hh - 0.012 * u, 0.018 * u * s, 0, Math.PI * 2); g.fill();
  };
  /** Half of a ring fence about the ground's middle: `back` the far half, else the near half with its gate. */
  const ring = ({ r, h, back, stone = false, gate = 0.22 }) => {
    const rx = r * u, ry = r * F * u, hh = h * u;
    const a0 = back ? Math.PI : 0, a1 = back ? Math.PI * 2 : Math.PI;
    const arcs = back ? [[a0, a1]] : [[a0, Math.PI / 2 - gate], [Math.PI / 2 + gate, a1]];
    for (const [s, e] of arcs) {
      g.beginPath();
      g.ellipse?.(x, y, rx, ry, 0, s, e);
      g.ellipse?.(x, y - hh, rx, ry, 0, e, s, true);
      g.closePath();
      if (g.createLinearGradient) {
        const gr = g.createLinearGradient(x - rx, 0, x + rx, 0);
        const c = stone ? [STONE.lit, STONE.mid, STONE.dark] : [WOOD.lit, WOOD.mid, WOOD.dark];
        gr.addColorStop(0, back ? c[1] : c[0]); gr.addColorStop(0.5, c[1]); gr.addColorStop(1, c[2]);
        g.fillStyle = gr;
      } else g.fillStyle = stone ? STONE.mid : WOOD.mid;
      g.fill(); g.strokeStyle = stone ? STONE.line : 'rgba(46,30,14,.7)'; g.lineWidth = lw; g.stroke();
      // the stakes of a palisade, or the merlons of a wall
      const n = Math.max(3, Math.round(((e - s) * r) / (stone ? 0.1 : 0.05)));
      g.save();
      if (stone) {
        g.fillStyle = back ? STONE.mid : STONE.top; g.strokeStyle = STONE.line; g.lineWidth = lw * 0.8;
        for (let i = 0; i < n; i++) {
          const t0 = s + ((e - s) * (i + 0.15)) / n, t1 = s + ((e - s) * (i + 0.62)) / n;
          g.beginPath(); g.moveTo(x + Math.cos(t0) * rx, y - hh + Math.sin(t0) * ry); g.lineTo(x + Math.cos(t1) * rx, y - hh + Math.sin(t1) * ry);
          g.lineTo(x + Math.cos(t1) * rx, y - hh * 1.3 + Math.sin(t1) * ry); g.lineTo(x + Math.cos(t0) * rx, y - hh * 1.3 + Math.sin(t0) * ry); g.closePath(); g.fill(); g.stroke();
        }
        g.strokeStyle = 'rgba(70,58,36,.2)'; g.beginPath(); g.ellipse?.(x, y - hh * 0.5, rx, ry, 0, s, e); g.stroke();
      } else {
        g.strokeStyle = 'rgba(46,30,14,.42)'; g.lineWidth = lw * 0.9;
        for (let i = 1; i < n; i++) { const t = s + ((e - s) * i) / n, px = x + Math.cos(t) * rx, py = y + Math.sin(t) * ry; g.beginPath(); g.moveTo(px, py); g.lineTo(px, py - hh * 1.08); g.stroke(); }
        g.strokeStyle = back ? WOOD.mid : WOOD.lit; g.lineWidth = lw * 1.3; g.beginPath(); g.ellipse?.(x, y - hh, rx, ry, 0, s, e); g.stroke();
      }
      g.restore();
    }
    if (!back) {
      // the gate's posts
      for (const sgn of [-1, 1]) {
        const t = Math.PI / 2 + sgn * gate, px = x + Math.cos(t) * rx, py = y + Math.sin(t) * ry, w = (stone ? 0.05 : 0.026) * u;
        poly(g, [[px - w, py + w * 0.3], [px + w, py + w * 0.3], [px + w, py - hh * 1.55], [px - w, py - hh * 1.55]], stone ? STONE.lit : WOOD.lit, stone ? STONE.line : 'rgba(46,30,14,.8)', lw);
        poly(g, [[px, py + w * 0.3], [px + w, py + w * 0.3], [px + w, py - hh * 1.55], [px, py - hh * 1.55]], stone ? STONE.shade : WOOD.shade);
      }
    }
  };
  const tree = (gx, gy, s = 1) => {
    const [tx, ty] = P(gx, gy), r = 0.075 * u * s;
    g.fillStyle = 'rgba(30,26,14,.24)'; g.beginPath(); g.ellipse?.(tx + r * 0.8, ty + r * 0.2, r * 1.3, r * 0.5, 0, 0, Math.PI * 2); g.fill();
    line(g, [[tx, ty], [tx, ty - r * 0.9]], WOOD.dark, lw * 2);
    for (const [dx, dy, rr, c] of [[0.1, -1.25, 1.0, '#2f5a2c'], [-0.42, -1.05, 0.72, '#3f7436'], [0.36, -1.0, 0.66, '#356a30'], [-0.14, -1.6, 0.7, '#57903f']]) { g.fillStyle = c; g.beginPath(); g.arc(tx + dx * r, ty + dy * r, rr * r, 0, Math.PI * 2); g.fill(); }
    g.strokeStyle = 'rgba(20,36,16,.5)'; g.lineWidth = lw * 0.8; g.beginPath(); g.arc(tx + 0.1 * r, ty - 1.25 * r, r * 1.02, 0.2, Math.PI * 0.9); g.stroke();
  };
  /** A strip field: ground parallelogram with furrows. */
  const field = (gx, gy, w, d, turn, colours) => {
    const c = Math.cos(turn), s = Math.sin(turn), at = (i, j) => P(gx + i * c - j * s, gy + i * s + j * c);
    poly(g, [at(-w, -d), at(w, -d), at(w, d), at(-w, d)], colours[0], 'rgba(70,54,24,.35)', lw * 0.8);
    g.save(); g.strokeStyle = colours[1]; g.lineWidth = Math.max(lw, 0.016 * u);
    for (let i = 1; i < 6; i++) { const j = -d + (2 * d * i) / 6; g.beginPath(); g.moveTo(...at(-w, j)); g.lineTo(...at(w, j)); g.stroke(); }
    g.restore();
  };
  const well = (gx, gy) => {
    const [wx, wy] = P(gx, gy), r = 0.05 * u;
    g.fillStyle = 'rgba(30,26,14,.22)'; g.beginPath(); g.ellipse?.(wx + r * 0.7, wy + r * 0.2, r * 1.5, r * 0.6, 0, 0, Math.PI * 2); g.fill();
    g.fillStyle = STONE.shade; g.strokeStyle = STONE.line; g.lineWidth = lw; g.beginPath(); g.ellipse?.(wx, wy, r, r * F, 0, 0, Math.PI * 2); g.fill(); g.stroke();
    g.fillStyle = STONE.lit; g.beginPath(); g.ellipse?.(wx, wy - r * 0.5, r, r * F, 0, 0, Math.PI * 2); g.fill(); g.stroke();
    g.fillStyle = '#2c4650'; g.beginPath(); g.ellipse?.(wx, wy - r * 0.5, r * 0.62, r * F * 0.62, 0, 0, Math.PI * 2); g.fill();
    line(g, [[wx - r * 0.9, wy - r * 0.4], [wx - r * 0.9, wy - r * 2.1]], WOOD.dark, lw * 1.6); line(g, [[wx + r * 0.9, wy - r * 0.4], [wx + r * 0.9, wy - r * 2.1]], WOOD.dark, lw * 1.6);
    poly(g, [[wx - r * 1.3, wy - r * 2.0], [wx, wy - r * 2.9], [wx + r * 1.3, wy - r * 2.0]], WOOD.mid, 'rgba(46,30,14,.8)', lw);
  };
  const stall = (gx, gy, colour) => {
    const [sx, sy] = P(gx, gy), w = 0.07 * u, h = 0.085 * u;
    g.fillStyle = 'rgba(30,26,14,.2)'; g.beginPath(); g.ellipse?.(sx + w * 0.5, sy + w * 0.15, w * 1.3, w * 0.4, 0, 0, Math.PI * 2); g.fill();
    poly(g, [[sx - w, sy], [sx + w, sy], [sx + w, sy - h * 0.5], [sx - w, sy - h * 0.5]], WOOD.mid, 'rgba(46,30,14,.7)', lw * 0.8);
    poly(g, [[sx - w * 1.2, sy - h * 0.72], [sx + w * 1.2, sy - h * 0.72], [sx + w * 0.86, sy - h * 1.22], [sx - w * 0.86, sy - h * 1.22]], '#f4ead2', 'rgba(46,30,14,.7)', lw * 0.8);
    g.fillStyle = colour;
    for (let i = 0; i < 3; i++) { const k0 = -1 + i * 0.8, k1 = k0 + 0.4; g.beginPath(); g.moveTo(sx + w * 1.2 * k0, sy - h * 0.72); g.lineTo(sx + w * 1.2 * k1, sy - h * 0.72); g.lineTo(sx + w * 0.86 * k1, sy - h * 1.22); g.lineTo(sx + w * 0.86 * k0, sy - h * 1.22); g.closePath(); g.fill(); }
  };
  const hay = (gx, gy) => {
    const [hx, hy] = P(gx, gy), r = 0.04 * u;
    g.fillStyle = 'rgba(30,26,14,.2)'; g.beginPath(); g.ellipse?.(hx + r * 0.6, hy + r * 0.1, r * 1.3, r * 0.5, 0, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#d9b860'; g.strokeStyle = 'rgba(96,70,22,.7)'; g.lineWidth = lw * 0.8;
    g.beginPath(); g.moveTo(hx - r, hy); g.quadraticCurveTo(hx - r * 0.9, hy - r * 1.8, hx, hy - r * 1.9); g.quadraticCurveTo(hx + r * 0.9, hy - r * 1.8, hx + r, hy); g.closePath(); g.fill(); g.stroke();
  };
  return { P, Q, house, tower, keep, banner, ring, tree, field, well, stall, hay };
}

/**
 * What a village has built, added to its picture (UX design 14.2: "when it completes the annex is added to the
 * village's picture"): a yard for each kind of building it has at least one of (fland.mjs BUILD_ITEMS: 0 farm,
 * 1 woodcutter, 2 quarry, 3 mine, 4 mint, 5 library), so a village with farms and a mine looks different from a new
 * one, and one with three mines from one with one. Each yard has a silhouette of its own that reads at the everyday
 * zoom (a barn among strip fields, a shed by stacked logs, a stepped pale cut with a hoist, a timbered adit with its
 * spoil heap, a brass-roofed counting house, a tower of books) on a patch of the ground its work leaves (furrows,
 * sawdust, stone dust, spoil, cobbles, a garden). How many it has shows in how far the yard has grown: `annexLevel`
 * (1, 2, 3 and more). They stand outside the palisade on the far side and to the left, where nothing of the board's
 * stands (the standard, the character and the hosts are to the right and in front; a building going up, further
 * left). Buildings have no tile in the rules (Build names an item, not a place): they are part of the village's own
 * picture, never on a hex of their own. `k` = r / 0.78: the ring's size against a town's.
 */
export const ANNEX_AT = Object.freeze([[-1.2, -0.62], [-0.78, -1.26], [-0.12, -1.6], [0.6, -1.42], [1.14, -0.94], [-1.5, -1.2]]);
/** How far a yard has grown for `n` copies of its building: 0 (none), 1, 2, or 3 (three or more). */
export const annexLevel = n => Math.max(0, Math.min(3, Math.floor(Number(n) || 0)));
const SOIL = Object.freeze({
  furrow: ['#cdb468', 'rgba(140,116,46,.6)'], green: ['#93ad5a', 'rgba(70,104,44,.55)'], fallow: ['#b99a63', 'rgba(110,84,44,.55)'],
  sawdust: 'rgba(206,170,112,.9)', dust: 'rgba(222,214,192,.7)', spoil: 'rgba(92,82,66,.9)', cobble: 'rgba(196,184,160,.95)', garden: 'rgba(132,158,92,.9)',
});
function annexes(g, K, u, lw, k, annex, roof, add) {
  const lv = i => annexLevel(annex?.[i]);
  const at = i => [ANNEX_AT[i][0] * k, ANNEX_AT[i][1] * k];
  const straw = { lit: '#ecd58c', mid: '#d9b860', shade: '#b08f3e', deep: '#8a6e2c', ridge: '#f6e6ad', line: 'rgba(96,70,22,.8)' };
  const slate = { lit: '#9aa7ad', mid: '#77868d', shade: '#56646b', deep: '#3d484e', ridge: '#c3cdd1', line: 'rgba(30,38,42,.8)' };
  const brass = { lit: BRASS.lit, mid: BRASS.mid, shade: '#a67c2c', deep: BRASS.dark, ridge: '#fff0b8', line: 'rgba(70,48,12,.8)' };
  const timber = { ...roof, mid: WOOD.mid, lit: WOOD.lit, shade: WOOD.shade, deep: WOOD.dark, ridge: '#d8b888' };
  // the ground a yard's work leaves: a soft patch, darker at its rim (painted at once: it lies under everything)
  const pad = (gx, gy, rx, ry, fill) => {
    const [px, py] = K.P(gx, gy);
    g.save(); g.translate(px, py); g.scale(1, F);
    if (g.createRadialGradient) {
      const gr = g.createRadialGradient(0, 0, rx * u * 0.15, 0, 0, rx * u);
      gr.addColorStop(0, fill); gr.addColorStop(0.78, fill); gr.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = gr;
    } else g.fillStyle = fill;
    g.beginPath(); g.ellipse?.(0, 0, rx * u, ry * u, 0, 0, Math.PI * 2); g.fill();
    g.strokeStyle = 'rgba(70,54,30,.28)'; g.lineWidth = lw; g.beginPath(); g.ellipse?.(0, 0, rx * u * 0.8, ry * u * 0.8, 0, 0.15, Math.PI - 0.15); g.stroke();
    g.restore();
  };
  const block = (px, py, s, lit = STONE.lit, shade = STONE.shade) => {
    poly(g, [[px - s, py], [px + s, py], [px + s, py - s * 1.1], [px - s, py - s * 1.1]], lit, STONE.line, lw * 0.8);
    poly(g, [[px, py], [px + s, py], [px + s, py - s * 1.1], [px, py - s * 1.1]], shade);
    poly(g, [[px - s, py - s * 1.1], [px + s, py - s * 1.1], [px + s * 0.7, py - s * 1.45], [px - s * 1.3, py - s * 1.45]], STONE.top, STONE.line, lw * 0.6);
  };
  const logs = (gx, gy, n) => {
    for (let i = 0; i < n; i++) for (let j = 0; j < n - i; j++) {
      const [lx, ly] = K.P(gx + (j + i * 0.5) * 0.05, gy, 0.022 + i * 0.04), r = 0.024 * u;
      g.fillStyle = '#8a5f34'; g.strokeStyle = 'rgba(46,30,14,.85)'; g.lineWidth = lw * 0.8; g.beginPath(); g.arc(lx, ly, r, 0, Math.PI * 2); g.fill(); g.stroke();
      g.fillStyle = '#e0bd82'; g.beginPath(); g.arc(lx, ly, r * 0.58, 0, Math.PI * 2); g.fill();
      g.strokeStyle = 'rgba(140,96,48,.6)'; g.lineWidth = lw * 0.5; g.beginPath(); g.arc(lx, ly, r * 0.3, 0, Math.PI * 2); g.stroke();
    }
  };
  const stump = (gx, gy) => {
    const [sx, sy] = K.P(gx, gy), r = 0.026 * u;
    g.fillStyle = WOOD.shade; g.strokeStyle = 'rgba(46,30,14,.8)'; g.lineWidth = lw * 0.8;
    g.beginPath(); g.ellipse?.(sx, sy, r, r * F, 0, 0, Math.PI); g.lineTo(sx - r, sy - r * 0.9); g.ellipse?.(sx, sy - r * 0.9, r, r * F, 0, Math.PI, 0, true); g.closePath(); g.fill(); g.stroke();
    g.fillStyle = '#e0bd82'; g.beginPath(); g.ellipse?.(sx, sy - r * 0.9, r, r * F, 0, 0, Math.PI * 2); g.fill(); g.stroke();
  };
  const heap = (px, py, w, h, c0, c1) => {
    g.fillStyle = 'rgba(34,26,14,.22)'; g.beginPath(); g.ellipse?.(px + w * 0.3, py + h * 0.1, w * 1.15, h * 0.32, 0, 0, Math.PI * 2); g.fill();
    g.fillStyle = c0; g.strokeStyle = 'rgba(36,30,20,.75)'; g.lineWidth = lw;
    g.beginPath(); g.moveTo(px - w, py); g.quadraticCurveTo(px - w * 0.35, py - h * 1.05, px + w * 0.05, py - h); g.quadraticCurveTo(px + w * 0.5, py - h * 0.95, px + w, py); g.closePath(); g.fill(); g.stroke();
    g.fillStyle = c1; g.beginPath(); g.moveTo(px - w * 0.72, py - h * 0.3); g.quadraticCurveTo(px - w * 0.3, py - h * 0.98, px + w * 0.05, py - h); g.quadraticCurveTo(px - w * 0.2, py - h * 0.6, px - w * 0.72, py - h * 0.3); g.fill();
  };
  if (lv(0)) {
    // a farm: strip fields that spread outward as the farms grow (one more strip a copy), a straw-roofed barn, stooks
    const n = lv(0), [gx, gy] = at(0);
    const strips = [[0.04, 0.26, 0.22, 0.12, -0.5, SOIL.furrow], [-0.22, 0.1, 0.2, 0.11, -0.5, SOIL.green], [-0.16, 0.42, 0.2, 0.1, -0.5, SOIL.fallow], [0.2, 0.5, 0.18, 0.1, -0.5, SOIL.furrow]];
    for (const [dx, dy, w, d, turn, c] of strips.slice(0, n + 1)) K.field(gx + dx, gy + dy, w, d, turn, c);
    add(gy - 0.02, () => K.house({ gx: gx + 0.1, gy: gy - 0.08, ha: 0.16, hb: 0.1, h: 0.1, rh: 0.13, along: 'a', roof: straw, wall: { ...WALL, lit: WOOD.lit, shade: WOOD.shade }, door: true }));
    if (n >= 3) add(gy - 0.12, () => K.house({ gx: gx - 0.18, gy: gy - 0.2, ha: 0.1, hb: 0.08, h: 0.08, rh: 0.1, along: 'b', roof: straw, wall: { ...WALL, lit: WOOD.lit, shade: WOOD.shade }, door: false }));
    add(gy + 0.24, () => { K.hay(gx - 0.12, gy + 0.22); K.hay(gx + 0.02, gy + 0.28); if (n >= 2) K.hay(gx - 0.3, gy + 0.12); });
  }
  if (lv(1)) {
    // a woodcutter's yard: sawdust, an open shed, a chopping block and stumps, log stacks (one a copy)
    const n = lv(1), [gx, gy] = at(1);
    pad(gx, gy + 0.06, 0.3, 0.22, SOIL.sawdust);
    add(gy - 0.04, () => K.house({ gx: gx + 0.04, gy: gy - 0.04, ha: 0.13, hb: 0.09, h: 0.08, rh: 0.08, along: 'b', roof: timber, wall: { ...WALL, lit: WOOD.mid, shade: WOOD.dark }, door: false }));
    add(gy + 0.14, () => { logs(gx - 0.22, gy + 0.12, 3); if (n >= 2) logs(gx - 0.06, gy + 0.2, 2); if (n >= 3) logs(gx + 0.12, gy + 0.18, 3); });
    add(gy + 0.08, () => { stump(gx + 0.2, gy + 0.08); stump(gx - 0.28, gy - 0.06); });
  }
  if (lv(2)) {
    // a quarry: a pale cut stepped into the ground (a step deeper a copy), squared blocks, a tripod hoist
    const n = lv(2), [gx, gy] = at(2);
    pad(gx, gy + 0.04, 0.32, 0.22, SOIL.dust);
    add(gy, () => {
      const [x0, y0] = K.P(gx, gy), w = 0.24 * u, h = (0.13 + 0.035 * n) * u;
      g.fillStyle = 'rgba(34,26,14,.22)'; g.beginPath(); g.ellipse?.(x0 + w * 0.2, y0 + h * 0.08, w * 1.1, h * 0.3, 0, 0, Math.PI * 2); g.fill();
      poly(g, [[x0 - w, y0], [x0 - w * 0.86, y0 - h * 0.7], [x0 - w * 0.3, y0 - h], [x0 + w * 0.4, y0 - h * 0.82], [x0 + w, y0 - h * 0.3], [x0 + w, y0]], STONE.mid, STONE.line, lw);
      poly(g, [[x0 - w * 0.86, y0 - h * 0.7], [x0 - w * 0.3, y0 - h], [x0 + w * 0.4, y0 - h * 0.82], [x0 + w * 0.1, y0 - h * 0.5], [x0 - w * 0.5, y0 - h * 0.46]], STONE.top);
      // the steps of the cut, one a copy
      for (let i = 0; i < n; i++) {
        const f = 0.24 + i * 0.22, a = x0 - w * (0.78 - i * 0.12), b = x0 + w * (0.86 - i * 0.1);
        poly(g, [[a, y0 - h * f], [b, y0 - h * (f - 0.08)], [b, y0 - h * (f - 0.18)], [a, y0 - h * (f - 0.1)]], STONE.shade, 'rgba(58,48,32,.5)', lw * 0.7);
      }
      for (const [bx, by] of [[0.52, 0.14], [0.86, 0.22], [0.68, 0.36], [0.3, 0.3], [1.02, 0.36], [0.5, 0.46]].slice(0, 1 + n * 2 - 1)) block(x0 + bx * w, y0 + by * h, 0.036 * u);
      line(g, [[x0 - w * 0.22, y0 - h * 0.92], [x0 - w * 0.05, y0 - h * 2.0], [x0 + w * 0.2, y0 - h * 0.86]], WOOD.dark, lw * 1.8);
      line(g, [[x0 - w * 0.05, y0 - h * 2.0], [x0 - w * 0.36, y0 - h * 0.7]], WOOD.dark, lw * 1.4);
      line(g, [[x0 - w * 0.05, y0 - h * 2.0], [x0 - w * 0.05, y0 - h * 1.2]], 'rgba(40,30,18,.85)', lw);
      block(x0 - w * 0.05, y0 - h * 1.08, 0.026 * u);
    });
  }
  if (lv(3)) {
    // a mine: a timbered adit in a mound, its spoil heap (larger a copy), a headframe from the second, an ore cart on its rail
    const n = lv(3), [gx, gy] = at(3);
    pad(gx + 0.06, gy + 0.08, 0.34, 0.24, SOIL.spoil);
    add(gy + 0.1, () => { const [hx, hy] = K.P(gx + 0.26, gy + 0.12); heap(hx, hy, (0.09 + 0.035 * n) * u, (0.06 + 0.03 * n) * u, '#5c5244', '#7c715f'); });
    add(gy, () => {
      const [x0, y0] = K.P(gx, gy), w = 0.2 * u, h = 0.2 * u;
      g.fillStyle = 'rgba(34,26,14,.24)'; g.beginPath(); g.ellipse?.(x0 + w * 0.3, y0 + h * 0.06, w * 1.2, h * 0.3, 0, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#7d7460'; g.strokeStyle = 'rgba(40,34,22,.85)'; g.lineWidth = lw;
      g.beginPath(); g.moveTo(x0 - w, y0); g.quadraticCurveTo(x0 - w * 0.8, y0 - h * 1.1, x0, y0 - h * 1.15); g.quadraticCurveTo(x0 + w * 0.9, y0 - h * 1.0, x0 + w, y0); g.closePath(); g.fill(); g.stroke();
      g.fillStyle = '#a39a82'; g.beginPath(); g.moveTo(x0 - w * 0.7, y0 - h * 0.5); g.quadraticCurveTo(x0 - w * 0.4, y0 - h * 1.05, x0 + w * 0.1, y0 - h * 1.08); g.quadraticCurveTo(x0 - w * 0.2, y0 - h * 0.7, x0 - w * 0.7, y0 - h * 0.5); g.fill();
      // tufts of grass on the mound: it is a hillside, not a heap
      g.strokeStyle = 'rgba(86,112,52,.8)'; g.lineWidth = lw;
      for (const [tx, ty] of [[-0.62, -0.62], [0.46, -0.78], [0.72, -0.42]]) { g.beginPath(); g.moveTo(x0 + tx * w, y0 + ty * h); g.lineTo(x0 + tx * w - 0.012 * u, y0 + ty * h - 0.03 * u); g.moveTo(x0 + tx * w, y0 + ty * h); g.lineTo(x0 + tx * w + 0.012 * u, y0 + ty * h - 0.032 * u); g.stroke(); }
      poly(g, [[x0 - w * 0.34, y0], [x0 - w * 0.34, y0 - h * 0.62], [x0 + w * 0.34, y0 - h * 0.62], [x0 + w * 0.34, y0]], '#1c1712');
      line(g, [[x0 - w * 0.4, y0], [x0 - w * 0.4, y0 - h * 0.7]], WOOD.lit, lw * 2.4); line(g, [[x0 + w * 0.4, y0], [x0 + w * 0.4, y0 - h * 0.7]], WOOD.mid, lw * 2.4); line(g, [[x0 - w * 0.52, y0 - h * 0.7], [x0 + w * 0.52, y0 - h * 0.7]], WOOD.lit, lw * 2.6);
      // a lantern at the adit
      g.fillStyle = '#ffd37a'; g.beginPath(); g.arc(x0 + w * 0.46, y0 - h * 0.52, 0.016 * u, 0, Math.PI * 2); g.fill();
      if (n >= 2) {
        // the headframe over a shaft: two legs, a strut, the wheel
        const hx = x0 - w * 0.62, hy = y0 - h * 0.86, hh = 0.26 * u;
        line(g, [[hx - 0.05 * u, hy], [hx, hy - hh], [hx + 0.05 * u, hy]], WOOD.dark, lw * 1.8);
        line(g, [[hx, hy - hh], [hx + 0.09 * u, hy + 0.01 * u]], WOOD.shade, lw * 1.4);
        g.strokeStyle = WOOD.dark; g.lineWidth = lw * 1.3; g.beginPath(); g.arc(hx, hy - hh, 0.034 * u, 0, Math.PI * 2); g.stroke();
        line(g, [[hx - 0.03 * u, hy - hh], [hx + 0.03 * u, hy - hh]], WOOD.dark, lw); line(g, [[hx, hy - hh - 0.03 * u], [hx, hy - hh + 0.03 * u]], WOOD.dark, lw);
      }
      // the rail out of the adit and a cart of ore on it
      line(g, [[x0 - w * 0.12, y0 + h * 0.04], [x0 + w * 1.2, y0 + h * 0.34]], 'rgba(40,34,22,.75)', lw);
      line(g, [[x0 + w * 0.12, y0 + h * 0.0], [x0 + w * 1.3, y0 + h * 0.26]], 'rgba(40,34,22,.75)', lw);
      const cx = x0 + w * 0.86, cy = y0 + h * 0.24, s = 0.058 * u;
      poly(g, [[cx - s, cy - s * 0.9], [cx + s, cy - s * 0.9], [cx + s * 0.8, cy], [cx - s * 0.8, cy]], '#5b4a36', 'rgba(30,22,12,.85)', lw * 0.8);
      g.fillStyle = '#9fb0b8'; g.beginPath(); g.ellipse?.(cx, cy - s * 0.95, s * 0.85, s * 0.38, 0, Math.PI, 0); g.fill();
      g.fillStyle = '#c9d6dc'; g.beginPath(); g.arc(cx - s * 0.25, cy - s * 1.08, s * 0.16, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#1c1712'; for (const d of [-0.5, 0.5]) { g.beginPath(); g.arc(cx + d * s, cy + s * 0.08, s * 0.22, 0, Math.PI * 2); g.fill(); }
    });
  }
  if (lv(4)) {
    // a mint: a stone counting house under a brass roof on a cobbled yard, strongboxes by its door (one a copy)
    const n = lv(4), [gx, gy] = at(4);
    pad(gx, gy + 0.04, 0.28, 0.2, SOIL.cobble);
    add(gy, () => K.house({ gx, gy, ha: 0.14, hb: 0.1, h: 0.14, rh: 0.11, along: 'a', roof: brass, wall: { ...WALL, lit: STONE.lit, mid: STONE.mid, shade: STONE.shade }, chimney: true }));
    add(gy + 0.16, () => {
      for (let i = 0; i < n; i++) {
        const [bx, by] = K.P(gx + 0.2 + i * 0.07, gy + 0.16 - i * 0.02), s = 0.03 * u;
        poly(g, [[bx - s, by], [bx + s, by], [bx + s, by - s * 0.9], [bx - s, by - s * 0.9]], '#6d4f2b', 'rgba(30,20,10,.9)', lw * 0.8);
        line(g, [[bx - s, by - s * 0.45], [bx + s, by - s * 0.45]], BRASS.mid, lw * 1.2);
        g.fillStyle = BRASS.lit; g.beginPath(); g.arc(bx, by - s * 0.45, s * 0.2, 0, Math.PI * 2); g.fill();
      }
    });
  }
  if (lv(5)) {
    // a library: a slender tower with a slate cap and a brass ball, a hall of books from the second, a second tower from the third
    const n = lv(5), [gx, gy] = at(5);
    pad(gx, gy + 0.04, 0.26, 0.18, SOIL.garden);
    if (n >= 2) add(gy + 0.02, () => K.house({ gx: gx + 0.16, gy: gy + 0.04, ha: 0.13, hb: 0.08, h: 0.11, rh: 0.09, along: 'a', roof: slate, wall: WALL, door: true }));
    if (n >= 3) add(gy - 0.06, () => K.tower({ gx: gx - 0.16, gy: gy - 0.06, r: 0.05, h: 0.3, cone: 0.14, roof: slate }));
    add(gy, () => { K.tower({ gx, gy, r: 0.068, h: 0.42, cone: 0.18, roof: slate }); const [px, py] = K.P(gx, gy, 0.42 + 0.2); g.fillStyle = BRASS.lit; g.strokeStyle = BRASS.dark; g.lineWidth = lw * 0.8; g.beginPath(); g.arc(px, py, 0.022 * u, 0, Math.PI * 2); g.fill(); g.stroke(); });
  }
}

/** The packed earth a village stands on, and the paths that leave it. */
function ground(g, x, y, u, r, { paths = [Math.PI / 2] } = {}) {
  if (g.createRadialGradient) {
    g.save();
    g.translate(x, y); g.scale(1, F);
    const gr = g.createRadialGradient(0, 0, r * u * 0.2, 0, 0, r * u * 1.18);
    gr.addColorStop(0, 'rgba(214,190,140,.92)'); gr.addColorStop(0.72, 'rgba(204,180,130,.8)'); gr.addColorStop(1, 'rgba(204,180,130,0)');
    g.fillStyle = gr; g.beginPath(); g.arc(0, 0, r * u * 1.18, 0, Math.PI * 2); g.fill();
    g.restore();
  }
  g.save();
  g.lineCap = 'round';
  for (const a of paths) {
    const x1 = x + Math.cos(a) * r * u * 1.5, y1 = y + Math.sin(a) * r * F * u * 1.5;
    for (const [w, c] of [[0.11, 'rgba(120,96,56,.3)'], [0.08, 'rgba(226,206,160,.9)']]) {
      g.strokeStyle = c; g.lineWidth = w * u;
      g.beginPath(); g.moveTo(x, y + 0.05 * u); g.quadraticCurveTo(x + Math.cos(a) * r * u * 0.7 + 0.06 * u, y + Math.sin(a) * r * F * u * 0.7, x1, y1); g.stroke();
    }
  }
  g.restore();
}

/**
 * A village with the middle of its ground at (x, y).
 *   tier      0 hamlet, 1 town, 2 city, 3 stronghold
 *   faction   the nation (its roofs and banners)
 *   walls     a hamlet or a town with walls built has a stone ring
 *   variant   0 or 1: the layout, or its mirror
 *   annex     `[n0, …, n5]`: how many of each building it has (map/board.mjs buildingsOf): one addition a kind
 */
export function paintVillage(g, x, y, u, { tier = 0, faction = 0, walls = false, variant = 0, annex = null } = {}) {
  if (!g?.save) return;
  const t = Math.max(0, Math.min(3, tier | 0)), lw = Math.max(0.011 * u, 0.5);
  const roof = roofOf(faction), r = VILLAGE.ring[t];
  g.save();
  g.lineJoin = 'round'; g.lineCap = 'round';
  // (the mirrored layout mirrors the village itself; its yards keep their side, clear of the standard and the hosts)
  const mirror = () => { if (variant) { g.translate(x, 0); g.scale(-1, 1); g.translate(-x, 0); } };
  const mirrored = fn => (variant ? () => { g.save(); mirror(); try { fn(); } finally { g.restore(); } } : fn);
  const K = kit(g, x, y, u, lw);
  const stone = walls || t >= 2;
  const things = [];
  const plain = (gy, fn) => things.push({ gy, fn });
  const add = (gy, fn) => things.push({ gy, fn: mirrored(fn) });
  g.save(); mirror();
  const H = (o) => add(o.gy, () => K.house({ roof, ...o }));
  if (t === 0) {
    ground(g, x, y, u, r, { paths: [Math.PI / 2, Math.PI * 1.08] });
    K.field(-0.86, 0.34, 0.26, 0.17, -0.5, ['#c9b66a', 'rgba(150,128,52,.55)']);
    K.field(0.9, -0.3, 0.24, 0.16, 0.42, ['#8fae58', 'rgba(74,110,48,.5)']);
    K.field(0.84, 0.44, 0.2, 0.13, 0.5, ['#d3bd6c', 'rgba(150,128,52,.55)']);
    K.ring({ r, h: stone ? 0.11 : 0.085, back: true, stone });
    H({ gx: -0.04, gy: -0.22, ha: 0.25, hb: 0.14, h: 0.14, rh: 0.15, along: 'a', chimney: true, timber: true });
    H({ gx: 0.36, gy: 0.04, ha: 0.12, hb: 0.1, h: 0.1, rh: 0.1, along: 'b', chimney: true });
    H({ gx: -0.36, gy: 0.06, ha: 0.12, hb: 0.095, h: 0.1, rh: 0.095, along: 'a' });
    H({ gx: 0.1, gy: 0.3, ha: 0.11, hb: 0.09, h: 0.09, rh: 0.09, along: 'b' });
    add(0.2, () => K.well(-0.14, 0.2));
    add(0.34, () => K.hay(-0.34, 0.34)); add(0.3, () => K.hay(-0.24, 0.38));
    add(-0.5, () => K.tree(-0.46, -0.34)); add(-0.4, () => K.tree(0.44, -0.3, 0.9));
    add(-0.2, () => K.banner(K.Q(-0.04, -0.22, 0, 0, 0.29), roof, 0.9));
  } else if (t === 1) {
    ground(g, x, y, u, r, { paths: [Math.PI / 2, Math.PI * 1.1, -0.1] });
    K.field(-1.06, 0.42, 0.24, 0.17, -0.5, ['#c9b66a', 'rgba(150,128,52,.55)']);
    K.field(1.1, 0.4, 0.22, 0.15, 0.5, ['#8fae58', 'rgba(74,110,48,.5)']);
    K.ring({ r, h: stone ? 0.13 : 0.1, back: true, stone });
    H({ gx: -0.08, gy: -0.36, ha: 0.3, hb: 0.16, h: 0.17, rh: 0.17, along: 'a', chimney: true, timber: true });
    add(-0.44, () => K.tower({ gx: 0.46, gy: -0.4, r: 0.085, h: 0.44, cone: 0.22, roof }));
    H({ gx: -0.52, gy: -0.14, ha: 0.12, hb: 0.1, h: 0.11, rh: 0.1, along: 'b' });
    H({ gx: 0.44, gy: -0.02, ha: 0.13, hb: 0.1, h: 0.11, rh: 0.1, along: 'b', chimney: true });
    H({ gx: -0.5, gy: 0.2, ha: 0.13, hb: 0.1, h: 0.1, rh: 0.1, along: 'a', chimney: true });
    H({ gx: 0.5, gy: 0.28, ha: 0.12, hb: 0.095, h: 0.1, rh: 0.095, along: 'a' });
    H({ gx: -0.24, gy: 0.44, ha: 0.12, hb: 0.095, h: 0.1, rh: 0.095, along: 'b' });
    H({ gx: 0.22, gy: 0.5, ha: 0.115, hb: 0.09, h: 0.095, rh: 0.09, along: 'b' });
    H({ gx: 0.16, gy: -0.02, ha: 0.1, hb: 0.085, h: 0.09, rh: 0.085, along: 'a' });
    add(0.16, () => K.well(-0.1, 0.14));
    add(0.2, () => K.stall(0.16, 0.22, roof.mid)); add(0.26, () => K.stall(-0.3, 0.12, '#c9a24a'));
    add(-0.62, () => K.tree(-0.36, -0.6)); add(-0.5, () => K.tree(0.66, -0.2, 0.9));
    add(-0.3, () => K.banner(K.Q(-0.08, -0.36, 0, 0, 0.34), roof));
  } else if (t === 2) {
    ground(g, x, y, u, r, { paths: [Math.PI / 2, Math.PI * 1.12, -0.12] });
    K.field(-1.2, 0.36, 0.2, 0.15, -0.5, ['#c9b66a', 'rgba(150,128,52,.55)']);
    K.ring({ r, h: 0.16, back: true, stone: true });
    for (const a of [1.22, 1.5, 1.78]) add(Math.sin(a * Math.PI) * r - 0.01, () => K.tower({ gx: Math.cos(a * Math.PI) * r, gy: Math.sin(a * Math.PI) * r, r: 0.08, h: 0.3, cone: 0.2, roof }));
    let top = null;
    add(-0.3, () => { top = K.keep({ gx: -0.1, gy: -0.34, a: 0.2, h: 0.46, cap: 0.26, roof }); });
    add(-0.29, () => { if (top) K.banner(top, roof); });
    H({ gx: 0.36, gy: -0.42, ha: 0.2, hb: 0.12, h: 0.15, rh: 0.15, along: 'a', chimney: true, timber: true });
    for (const [gx, gy, al, ch] of [[-0.58, -0.3, 'b', 0], [0.62, -0.1, 'b', 1], [-0.62, 0.06, 'a', 1], [0.3, -0.06, 'a', 0], [-0.3, 0.14, 'b', 0], [0.58, 0.26, 'a', 1], [-0.52, 0.38, 'a', 0], [0.06, 0.24, 'a', 1], [0.3, 0.52, 'b', 0], [-0.2, 0.56, 'b', 1], [0.02, -0.02, 'b', 0]]) H({ gx, gy, ha: 0.12, hb: 0.095, h: 0.11, rh: 0.1, along: al, chimney: !!ch });
    add(0.36, () => K.stall(-0.08, 0.4, roof.mid));
    for (const a of [0.14, 0.86]) add(Math.sin(a * Math.PI) * r + 0.02, () => K.tower({ gx: Math.cos(a * Math.PI) * r, gy: Math.sin(a * Math.PI) * r, r: 0.085, h: 0.32, cone: 0.21, roof }));
  } else {
    ground(g, x, y, u, r, { paths: [Math.PI / 2, Math.PI * 1.12, -0.12] });
    K.ring({ r, h: 0.2, back: true, stone: true });
    for (const a of [1.15, 1.38, 1.62, 1.85]) add(Math.sin(a * Math.PI) * r - 0.01, () => K.tower({ gx: Math.cos(a * Math.PI) * r, gy: Math.sin(a * Math.PI) * r, r: 0.09, h: 0.36, cone: 0.22, roof }));
    let top = null;
    for (const [dx, dy] of [[-0.3, -0.3], [0.3, -0.3]]) add(-0.2 + dy - 0.3, () => K.tower({ gx: dx, gy: -0.2 + dy * 0.6, r: 0.075, h: 0.5, cone: 0.2, roof }));
    add(-0.2, () => { top = K.keep({ gx: 0, gy: -0.2, a: 0.27, h: 0.56, cap: 0.3, roof }); });
    add(-0.19, () => { if (top) K.banner(top, roof, 1.15); });
    for (const [dx, dy] of [[-0.36, 0.12], [0.36, 0.12]]) add(-0.2 + dy + 0.02, () => K.tower({ gx: dx, gy: -0.2 + dy, r: 0.075, h: 0.46, cone: 0.2, roof }));
    for (const [gx, gy, al] of [[-0.6, -0.04, 'a'], [0.62, 0.0, 'a'], [-0.56, 0.3, 'a'], [0.56, 0.32, 'a'], [-0.24, 0.42, 'b'], [0.24, 0.44, 'b'], [0, 0.6, 'a'], [-0.68, -0.34, 'b'], [0.7, -0.34, 'b']]) H({ gx, gy, ha: 0.14, hb: 0.095, h: 0.11, rh: 0.1, along: al, chimney: gx > 0 });
    for (const a of [0.1, 0.3, 0.7, 0.9]) add(Math.sin(a * Math.PI) * r + 0.02, () => K.tower({ gx: Math.cos(a * Math.PI) * r, gy: Math.sin(a * Math.PI) * r, r: 0.095, h: 0.38, cone: 0.23, roof }));
  }
  g.restore();
  if (annex?.some?.(n => n > 0)) annexes(g, K, u, lw, r / 0.78, annex, roof, plain);
  things.sort((a, b) => a.gy - b.gy);
  // what stands behind the near half of the ring, then the ring's near half with its gate, then what stands on it
  const nearRing = r * 0.74;
  for (const th of things) if (th.gy <= nearRing) th.fn();
  K.ring({ r, h: t === 0 ? (stone ? 0.11 : 0.085) : t === 1 ? (stone ? 0.13 : 0.1) : t === 2 ? 0.16 : 0.2, back: false, stone, gate: t >= 2 ? 0.2 : 0.26 });
  for (const th of things) if (th.gy > nearRing) th.fn();
  g.restore();
}

const sprites = new Map();
const spare = (w, h) => (typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : typeof document !== 'undefined' ? Object.assign(document.createElement('canvas'), { width: w, height: h }) : null);
/** The steps of resolution a village is kept at (device px per unit `u`). */
const SIZES = Object.freeze([12, 18, 26, 36, 50, 68, 92, 124, 164, 216, 280]);

// ------------------------------------------------------------------ a province's keep (conquest)
/**
 * A keep's fortress, in units of `u` about the middle of its ground: the wall's ring, how high its tallest stone
 * stands, the box its picture needs, and where the standard's pole is planted (on the great tower's roof: `pole.up`
 * above the ground's middle).
 */
export const FORTRESS = Object.freeze({
  ring: 0.6, top: 0.98,
  box: Object.freeze({ left: 1.05, right: 1.25, top: 1.35, bottom: 0.8 }),
  pole: Object.freeze({ x: 0, up: 0.1 * F + 0.5 + 0.1 }),
});
const SLATE = { lit: '#b9b7a8', mid: '#8d8c80', shade: '#5f5f56', deep: '#3b3b35', ridge: '#d9d6c6', line: '#2e2e29' };
/**
 * A province's keep (conquest): a small fortress in the style of the towns, the middle of its ground at (x, y):
 * a stone ring with four round towers and a gate, and a square great tower in its middle. Its roofs are in the
 * colours of the nation that holds it (`faction` 0–5; slate when nobody is known to); `mine` (the viewer's own
 * nation holds it) gilds the gate and lays the gold line at its foot. The holder's standard is not part of this
 * picture: the board flies it from `FORTRESS.pole`, alive (map/keeps.mjs), and strikes it when the keep is taken.
 */
export function paintFortress(g, x, y, u, { faction = null, mine = false } = {}) {
  if (!g?.save) return;
  const lw = Math.max(0.013 * u, 0.5), roof = Number.isInteger(faction) && faction >= 0 && faction < 6 ? roofOf(faction) : SLATE, r = FORTRESS.ring;
  g.save();
  g.lineJoin = 'round'; g.lineCap = 'round';
  const K = kit(g, x, y, u, lw);
  // the ground it stands on: trodden earth, the road to its gate; under the viewer's own, the gold line (UX design 5: gold is "yours")
  ground(g, x, y, u, r * 1.06, { paths: [Math.PI / 2] });
  if (mine) {
    g.save(); g.translate(x, y); g.scale(1, F);
    g.strokeStyle = '#171006'; g.lineWidth = 0.085 * u; g.beginPath(); g.arc(0, 0, r * u * 1.2, 0, Math.PI * 2); g.stroke();
    g.strokeStyle = '#ffd24d'; g.lineWidth = 0.05 * u; g.stroke();
    g.restore();
  }
  const things = [];
  const add = (gy, fn) => things.push({ gy, fn });
  K.ring({ r, h: 0.2, back: true, stone: true });
  for (const a of [1.2, 1.8]) add(Math.sin(a * Math.PI) * r - 0.01, () => K.tower({ gx: Math.cos(a * Math.PI) * r, gy: Math.sin(a * Math.PI) * r, r: 0.1, h: 0.36, cone: 0.24, roof }));
  add(-0.1, () => K.keep({ gx: 0, gy: -0.1, a: 0.25, h: 0.5, cap: 0, roof }));
  things.sort((a, b) => a.gy - b.gy);
  for (const th of things) th.fn();
  K.ring({ r, h: 0.2, back: false, stone: true, gate: 0.22 });
  for (const a of [0.14, 0.86]) K.tower({ gx: Math.cos(a * Math.PI) * r, gy: Math.sin(a * Math.PI) * r, r: 0.105, h: 0.38, cone: 0.25, roof });
  // the gate's leaves: dark oak, bound in brass when it is the viewer's own
  const gx = x, gy = y + r * F * u, w = 0.11 * u, h = 0.2 * u;
  poly(g, [[gx - w, gy], [gx + w, gy], [gx + w, gy - h * 0.8], [gx, gy - h * 1.15], [gx - w, gy - h * 0.8]], '#3d2a16', mine ? '#ffd24d' : 'rgba(30,20,10,.9)', mine ? lw * 2.2 : lw * 1.2);
  line(g, [[gx, gy], [gx, gy - h * 1.1]], mine ? '#f6dc8a' : 'rgba(20,14,8,.8)', lw);
  g.restore();
}
const fortSprites = new Map();
/** A keep's fortress as a bitmap for `px` device px of `u` (as `villageSprite`): `{cv, ox, oy, w, h}` in units of `u`, or null. */
export function fortressSprite(px, { faction = null, mine = false } = {}) {
  const r = SIZES.find(s => s >= px * 0.97) ?? SIZES[SIZES.length - 1];
  const f = Number.isInteger(faction) && faction >= 0 && faction < 6 ? faction : 'x', key = `${r}|${f}|${mine ? 1 : 0}`;
  if (fortSprites.has(key)) return fortSprites.get(key);
  const B = FORTRESS.box, w = Math.ceil((B.left + B.right) * r), h = Math.ceil((B.top + B.bottom) * r);
  const cv = spare(w, h), g = cv?.getContext?.('2d');
  if (!g) { fortSprites.set(key, null); return null; }
  paintFortress(g, B.left * r, B.top * r, r, { faction, mine });
  const v = { cv, ox: B.left, oy: B.top, w: B.left + B.right, h: B.top + B.bottom };
  fortSprites.set(key, v);
  if (fortSprites.size > 120) fortSprites.delete(fortSprites.keys().next().value);
  return v;
}

/**
 * A village as a bitmap for `px` device px of `u` on screen: `{cv, ox, oy, w, h}` in units of `u` (draw it at
 * `(x − ox·u, y − oy·u, w·u, h·u)` for the middle of its ground at (x, y)), or null where no spare canvas can
 * be made (the caller paints it straight). It is never made smaller than it is shown: no picture is stretched.
 */
export function villageSprite(px, { tier = 0, faction = 0, walls = false, variant = 0, annex = null } = {}) {
  const r = SIZES.find(s => s >= px * 0.97) ?? SIZES[SIZES.length - 1];
  // (how far each yard has grown, one digit a kind: a village with three mines is a picture of its own)
  const mask = (annex ?? []).map(annexLevel).join('').replace(/^0+$/, '');
  const key = `${r}|${tier}|${faction}|${walls ? 1 : 0}|${variant ? 1 : 0}|${mask}`;
  if (sprites.has(key)) return sprites.get(key);
  const B = VILLAGE.box, w = Math.ceil((B.left + B.right) * r), h = Math.ceil((B.top + B.bottom) * r);
  const cv = spare(w, h), g = cv?.getContext?.('2d');
  if (!g) { sprites.set(key, null); return null; }
  paintVillage(g, B.left * r, B.top * r, r, { tier, faction, walls, variant, annex: mask ? annex : null });
  const v = { cv, ox: B.left, oy: B.top, w: B.left + B.right, h: B.top + B.bottom };
  sprites.set(key, v);
  // (a few sizes of a few villages: the oldest go when there are many)
  if (sprites.size > 96) sprites.delete(sprites.keys().next().value);
  return v;
}

/**
 * Paint every village picture of a card on the page (`canvas[data-vil="faction,tier,walls"]`, screens/parts.mjs
 * cardHead): the village as the map draws it, fitted to the canvas. A canvas is painted once for what it names.
 */
export function paintVillagePics(root = globalThis.document) {
  let n = 0;
  for (const cv of root?.querySelectorAll?.('canvas[data-vil]') ?? []) {
    const key = cv.dataset.vil;
    if (cv.dataset.done === key) continue;
    const g = cv.getContext?.('2d');
    if (!g) continue;
    const [faction, tier, walls] = key.split(',').map(Number), t = Math.max(0, Math.min(3, tier | 0));
    const W = cv.width, H = cv.height, r = VILLAGE.ring[t];
    // as large as the canvas holds: its ring across the width, its tallest roof and its gate inside the height
    const u = Math.min((W * 0.94) / (r * 2.25), (H * 0.96) / (VILLAGE.top[t] + r * F + 0.16));
    g.clearRect(0, 0, W, H);
    paintVillage(g, W / 2, H - (r * F + 0.1) * u, u, { tier: t, faction, walls: !!walls });
    cv.dataset.done = key;
    n++;
  }
  return n;
}
