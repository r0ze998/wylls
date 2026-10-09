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
  box: Object.freeze({ left: 1.5, right: 1.75, top: 1.75, bottom: 1.05 }),
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
 */
export function paintVillage(g, x, y, u, { tier = 0, faction = 0, walls = false, variant = 0 } = {}) {
  if (!g?.save) return;
  const t = Math.max(0, Math.min(3, tier | 0)), lw = Math.max(0.011 * u, 0.5);
  const roof = roofOf(faction), r = VILLAGE.ring[t];
  g.save();
  g.lineJoin = 'round'; g.lineCap = 'round';
  if (variant) { g.translate(x, 0); g.scale(-1, 1); g.translate(-x, 0); }
  const K = kit(g, x, y, u, lw);
  const stone = walls || t >= 2;
  const things = [];
  const add = (gy, fn) => things.push({ gy, fn });
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

/**
 * A village as a bitmap for `px` device px of `u` on screen: `{cv, ox, oy, w, h}` in units of `u` (draw it at
 * `(x − ox·u, y − oy·u, w·u, h·u)` for the middle of its ground at (x, y)), or null where no spare canvas can
 * be made (the caller paints it straight). It is never made smaller than it is shown: no picture is stretched.
 */
export function villageSprite(px, { tier = 0, faction = 0, walls = false, variant = 0 } = {}) {
  const r = SIZES.find(s => s >= px * 0.97) ?? SIZES[SIZES.length - 1];
  const key = `${r}|${tier}|${faction}|${walls ? 1 : 0}|${variant ? 1 : 0}`;
  if (sprites.has(key)) return sprites.get(key);
  const B = VILLAGE.box, w = Math.ceil((B.left + B.right) * r), h = Math.ceil((B.top + B.bottom) * r);
  const cv = spare(w, h), g = cv?.getContext?.('2d');
  if (!g) { sprites.set(key, null); return null; }
  paintVillage(g, B.left * r, B.top * r, r, { tier, faction, walls, variant });
  const v = { cv, ox: B.left, oy: B.top, w: B.left + B.right, h: B.top + B.bottom };
  sprites.set(key, v);
  // (a few sizes of a few villages: the oldest go when there are many)
  if (sprites.size > 96) sprites.delete(sprites.keys().next().value);
  return v;
}
