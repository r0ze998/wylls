// The redesign's stage-1 things on the board, painted in the villages' hand (docs/design/uplift/01-ART-DIRECTION.ja.md).
//
// The first pictures of the S1 feeds (map/s1marks.mjs, 1f) were flat icons with an ink outline: a strongbox, a grey
// trapezoid, a row of stakes, a box with crenels, a cart. Beside the villages (map/village.mjs: timber, plaster and
// stone seen from above on a corner, light from the upper left, a thin ink line) and the code-drawn relief they read
// as stickers. Here each is drawn with the villages' own kit and palettes, at whatever size the screen asks for:
//
//   vault      a squat stone storehouse with a heavy timber door, iron bands, crates by its door and the owner's pennon
//   tower      a timber watchtower on a stone footing, an open platform under a roof in the nation's colour, a lantern
//   palisade   a line of sharpened stakes across the tile with a closed gate and the nation's cloth on the gate
//   fort       a low square redoubt: an earth bank faced with stone, a squat keep, the nation's banner
//   cart       an ox and a covered cart whose load says what it carries (ore, wood, food, arms; nothing when raided)
//
// The viewer's own things wear the gold "yours" ring at their foot (palette.mjs YOURS_MARK), never colour alone.
// Units: `u` is a hex's corner radius times the scale it is drawn at (paintVillage's); (x, y) the middle of the
// thing's ground. Pure drawing; context-tolerant; no asset files.
import { villageKit, VILLAGE_PALETTE } from './village.mjs';
import { YOURS_MARK } from '../palette.mjs';

const { WOOD, STONE, BRASS, F, roofOf } = VILLAGE_PALETTE;
const IRON = { lit: '#8e959a', mid: '#5f666b', dark: '#2f3437' };
const EARTH = { lit: '#b9a274', mid: '#93804f', shade: '#6f5f38', deep: '#4e4226' };

const poly = (g, pts, fill, stroke = null, lw = 0) => {
  g.beginPath();
  pts.forEach(([px, py], i) => (i ? g.lineTo(px, py) : g.moveTo(px, py)));
  g.closePath();
  if (fill) { g.fillStyle = fill; g.fill(); }
  if (stroke) { g.strokeStyle = stroke; g.lineWidth = lw; g.stroke(); }
};
const line = (g, pts, stroke, lw) => { g.beginPath(); pts.forEach(([px, py], i) => (i ? g.lineTo(px, py) : g.moveTo(px, py))); g.strokeStyle = stroke; g.lineWidth = lw; g.stroke(); };
const lwOf = u => Math.max(0.011 * u, 0.5);
/** Whether a context can paint these (the villages' kit needs real gradients; a recorder in a test has none). */
const paints = g => !!g?.save && !!g.createLinearGradient?.(0, 0, 1, 1)?.addColorStop;

/** The gold ring at the foot of something of the viewer's: a dark keyline, the gold, an ivory core (palette.mjs YOURS_MARK). */
export function paintYoursRing(g, x, y, r) {
  if (!g?.ellipse) return;
  g.save();
  for (const [w, c] of [[r * 0.16, YOURS_MARK.key], [r * 0.1, YOURS_MARK.gold], [r * 0.035, YOURS_MARK.core]]) {
    g.strokeStyle = c; g.lineWidth = w; g.globalAlpha = c === YOURS_MARK.key ? 0.7 : 1;
    g.beginPath(); g.ellipse(x, y, r, r * F, 0, 0, Math.PI * 2); g.stroke();
  }
  g.restore();
}

/** A soft contact shadow under a footprint (half sizes in units of u), cast a little to the lower right. */
function contact(g, x, y, u, w, d, alpha = 0.26) {
  const gr = g.createRadialGradient?.(0, 0, w * u * 0.2, 0, 0, w * u * 1.15);
  if (!gr?.addColorStop) return;
  g.save(); g.translate(x + w * 0.18 * u, y + d * 0.2 * u); g.scale(1, F * (d / w));
  gr.addColorStop(0, `rgba(30,24,12,${alpha})`); gr.addColorStop(1, 'rgba(30,24,12,0)');
  g.fillStyle = gr; g.beginPath(); g.arc(0, 0, w * u * 1.15, 0, Math.PI * 2); g.fill();
  g.restore();
}

/** A storehouse of stone with a timber door, iron bands and crates; the owner's pennon on its gable. */
export function paintVaultArt(g, x, y, u, { faction = 0, own = false } = {}) {
  if (!paints(g)) return;
  const lw = lwOf(u), K = villageKit(g, x, y, u), roof = roofOf(faction);
  g.save(); g.lineJoin = 'round'; g.lineCap = 'round';
  contact(g, x, y, u, 0.42, 0.3);
  if (own) paintYoursRing(g, x, y + 0.02 * u, 0.46 * u);
  // the house: a squat stone body, a heavy roof in the owner's colour
  K.house({ gx: 0, gy: -0.02, ha: 0.24, hb: 0.17, h: 0.17, rh: 0.15, along: 'a', roof, wall: { lit: STONE.lit, mid: STONE.mid, shade: STONE.shade, dark: STONE.dark, line: STONE.line }, door: false });
  // the door: timber planks with two iron bands, on the lit wall
  const q = (a, b, z) => K.Q(0, -0.02, a, b, z);
  poly(g, [q(-0.08, 0.17, 0), q(0.08, 0.17, 0), q(0.08, 0.17, 0.13), q(-0.08, 0.17, 0.13)], WOOD.mid, 'rgba(46,30,14,.85)', lw);
  for (const z of [0.035, 0.095]) line(g, [q(-0.08, 0.17, z), q(0.08, 0.17, z)], IRON.mid, lw * 1.6);
  g.fillStyle = BRASS.mid; const [kx, ky] = q(0.05, 0.17, 0.065); g.beginPath(); g.arc(kx, ky, 0.012 * u, 0, Math.PI * 2); g.fill();
  // crates and a sack by the door
  for (const [gx, gy, s] of [[0.3, 0.2, 0.06], [0.38, 0.12, 0.05], [0.33, 0.14, 0.045]]) {
    const z0 = gx === 0.33 ? 0.06 : 0, P = (a, b, z) => K.Q(gx, gy, a, b, z + z0);
    poly(g, [P(-s, s, 0), P(s, s, 0), P(s, s, s * 1.4), P(-s, s, s * 1.4)], WOOD.lit, 'rgba(46,30,14,.8)', lw * 0.8);
    poly(g, [P(s, -s, 0), P(s, s, 0), P(s, s, s * 1.4), P(s, -s, s * 1.4)], WOOD.shade, 'rgba(46,30,14,.8)', lw * 0.8);
    poly(g, [P(-s, -s, s * 1.4), P(s, -s, s * 1.4), P(s, s, s * 1.4), P(-s, s, s * 1.4)], '#d2b47e', 'rgba(46,30,14,.8)', lw * 0.8);
  }
  K.banner(K.Q(0, -0.02, -0.24, 0, 0.31), roof, 0.75);
  g.restore();
}

/** A timber watchtower on a stone footing: an open platform, a roof in the nation's colour, a lantern. */
export function paintTowerArt(g, x, y, u, { faction = 0, own = false } = {}) {
  if (!paints(g)) return;
  const lw = lwOf(u), K = villageKit(g, x, y, u), roof = roofOf(faction);
  g.save(); g.lineJoin = 'round'; g.lineCap = 'round';
  contact(g, x, y, u, 0.3, 0.24, 0.3);
  if (own) paintYoursRing(g, x, y + 0.02 * u, 0.34 * u);
  const P = K.P, a = 0.11, top = 0.78;
  // the footing: a short stone drum
  K.tower({ gx: 0, gy: 0, r: 0.13, h: 0.1, cone: 0, roof: { ...roof, lit: STONE.lit, mid: STONE.mid, deep: STONE.dark, line: STONE.line, ridge: STONE.top } });
  // four legs that lean in, cross-braced
  const leg = (gx, gy, k) => [P(gx * 1.18, gy * 1.18, 0.1), P(gx * 0.86, gy * 0.86, top)];
  const legs = [[-a, -a], [a, -a], [a, a], [-a, a]].map(([gx, gy]) => leg(gx, gy));
  for (const [i, [b, t]] of legs.entries()) line(g, [b, t], i === 1 || i === 2 ? WOOD.shade : WOOD.lit, lw * 2.6);
  for (const z of [0.32, 0.56]) {
    const k = z / top;
    const at = i => [legs[i][0][0] + (legs[i][1][0] - legs[i][0][0]) * k, legs[i][0][1] + (legs[i][1][1] - legs[i][0][1]) * k];
    line(g, [at(3), at(2), at(1)], WOOD.mid, lw * 1.4);
    line(g, [legs[3][0], at(2)], 'rgba(72,50,26,.7)', lw);
  }
  // the platform, its rail, the roof
  const s = 0.15, Pz = (gx, gy) => P(gx, gy, top);
  poly(g, [Pz(-s, -s), Pz(s, -s), Pz(s, s), Pz(-s, s)], WOOD.lit, 'rgba(46,30,14,.85)', lw);
  for (const [gx, gy] of [[-s, s], [s, s], [s, -s]]) line(g, [Pz(gx, gy), P(gx, gy, top + 0.1)], WOOD.mid, lw * 1.4);
  line(g, [P(-s, s, top + 0.1), P(s, s, top + 0.1), P(s, -s, top + 0.1)], WOOD.lit, lw * 1.4);
  const r0 = 0.2, z0 = top + 0.16, apex = P(0, 0, z0 + 0.16);
  poly(g, [P(-r0, r0, z0), P(r0, r0, z0), apex], roof.lit, roof.line, lw);
  poly(g, [P(r0, -r0, z0), P(r0, r0, z0), apex], roof.shade, roof.line, lw);
  line(g, [P(r0, r0, z0), apex], roof.ridge, lw * 1.4);
  // the lantern under the roof: a warm point
  const [lx, ly] = P(0.02, 0.02, top + 0.08);
  const lamp = g.createRadialGradient?.(lx, ly, 0, lx, ly, 0.1 * u);
  if (lamp?.addColorStop) { const gr = lamp; gr.addColorStop(0, 'rgba(255,214,128,.9)'); gr.addColorStop(1, 'rgba(255,214,128,0)'); g.fillStyle = gr; g.beginPath(); g.arc(lx, ly, 0.1 * u, 0, Math.PI * 2); g.fill(); }
  g.fillStyle = '#ffe2a0'; g.beginPath(); g.arc(lx, ly, 0.022 * u, 0, Math.PI * 2); g.fill();
  g.restore();
}

/** A line of sharpened stakes across the tile, a closed gate in its middle with the nation's cloth on it. */
export function paintPalisadeArt(g, x, y, u, { faction = 0, own = false } = {}) {
  if (!paints(g)) return;
  const lw = lwOf(u), K = villageKit(g, x, y, u), roof = roofOf(faction);
  g.save(); g.lineJoin = 'round'; g.lineCap = 'round';
  if (own) paintYoursRing(g, x, y + 0.04 * u, 0.62 * u);
  // the line runs from the far left to the near right, so it is seen along its length
  const n = 15, from = [-0.62, -0.2], to = [0.62, 0.26];
  const at = k => [from[0] + (to[0] - from[0]) * k, from[1] + (to[1] - from[1]) * k];
  // the earth thrown up along its foot
  const [ax, ay] = K.P(...at(0)), [bx, by] = K.P(...at(1));
  g.strokeStyle = 'rgba(110,88,50,.5)'; g.lineWidth = 0.12 * u; g.beginPath(); g.moveTo(ax, ay + 0.02 * u); g.lineTo(bx, by + 0.02 * u); g.stroke();
  for (let i = 0; i < n; i++) {
    const k = i / (n - 1);
    if (Math.abs(k - 0.5) < 0.08) continue;
    const [gx, gy] = at(k), [px, py] = K.P(gx, gy), h = (0.3 + ((i * 7) % 3) * 0.025) * u, w = 0.032 * u;
    poly(g, [[px - w, py], [px - w, py - h], [px, py - h - w * 1.6], [px + w, py - h], [px + w, py]], WOOD.lit, 'rgba(46,30,14,.85)', lw);
    poly(g, [[px, py], [px, py - h - w * 1.6], [px + w, py - h], [px + w, py]], WOOD.shade);
  }
  // two rails tying the stakes
  for (const z of [0.1, 0.22]) line(g, [K.P(...at(0), z), K.P(...at(0.42), z)], WOOD.dark, lw * 1.6), line(g, [K.P(...at(0.58), z), K.P(...at(1), z)], WOOD.dark, lw * 1.6);
  // the gate: two posts, closed leaves, the cloth
  const [g0x, g0y] = K.P(...at(0.43)), [g1x, g1y] = K.P(...at(0.57)), gh = 0.36 * u;
  for (const [px, py] of [[g0x, g0y], [g1x, g1y]]) poly(g, [[px - 0.03 * u, py], [px + 0.03 * u, py], [px + 0.03 * u, py - gh * 1.15], [px - 0.03 * u, py - gh * 1.15]], WOOD.mid, 'rgba(46,30,14,.85)', lw);
  poly(g, [[g0x, g0y], [g1x, g1y], [g1x, g1y - gh], [g0x, g0y - gh]], WOOD.shade, 'rgba(46,30,14,.85)', lw);
  line(g, [[g0x, g0y - gh * 0.5], [g1x, g1y - gh * 0.5]], IRON.mid, lw * 1.6);
  const mx = (g0x + g1x) / 2, my = (g0y + g1y) / 2 - gh * 0.95;
  poly(g, [[mx - 0.07 * u, my], [mx + 0.07 * u, my + 0.03 * u], [mx + 0.07 * u, my + 0.17 * u], [mx, my + 0.22 * u], [mx - 0.07 * u, my + 0.14 * u]], roof.mid, roof.line, lw);
  g.restore();
}

/** A low square redoubt: an earth bank faced with stone, a squat keep, the nation's banner. */
export function paintFortArt(g, x, y, u, { faction = 0, own = false } = {}) {
  if (!paints(g)) return;
  const lw = lwOf(u), K = villageKit(g, x, y, u), roof = roofOf(faction);
  g.save(); g.lineJoin = 'round'; g.lineCap = 'round';
  contact(g, x, y, u, 0.62, 0.46, 0.3);
  if (own) paintYoursRing(g, x, y + 0.04 * u, 0.66 * u);
  // the bank: a square of earth seen on its corner, its faces stone-clad
  const Q = (a, b, z) => K.Q(0, 0.02, a, b, z), o = 0.4, h = 0.1;
  poly(g, [Q(-o, -o, h), Q(o, -o, h), Q(o, o, h), Q(-o, o, h)], EARTH.lit, 'rgba(58,44,24,.6)', lw);
  poly(g, [Q(o, -o, 0), Q(o, o, 0), Q(o, o, h), Q(o, -o, h)], STONE.shade, STONE.line, lw);
  poly(g, [Q(-o, o, 0), Q(o, o, 0), Q(o, o, h), Q(-o, o, h)], STONE.lit, STONE.line, lw);
  // the courses of the facing
  g.strokeStyle = 'rgba(70,58,36,.25)'; g.lineWidth = lw * 0.8;
  for (const z of [0.035, 0.07]) { g.beginPath(); g.moveTo(...Q(-o, o, z)); g.lineTo(...Q(o, o, z)); g.lineTo(...Q(o, -o, z)); g.stroke(); }
  // the yard inside, trodden
  poly(g, [Q(-o * 0.78, -o * 0.78, h), Q(o * 0.78, -o * 0.78, h), Q(o * 0.78, o * 0.78, h), Q(-o * 0.78, o * 0.78, h)], EARTH.mid);
  // the keep: lower than a city's, no cap; the banner on it
  g.save(); g.translate(0, -h * u);
  const top = K.keep({ gx: -0.04, gy: -0.04, a: 0.15, h: 0.26, cap: 0, roof });
  g.restore();
  K.banner([top[0], top[1] - h * u], roof, 1.05);
  // two sheds against the bank
  g.save(); g.translate(0, -h * u);
  K.house({ gx: 0.22, gy: 0.18, ha: 0.08, hb: 0.06, h: 0.06, rh: 0.06, along: 'b', roof, door: false });
  g.restore();
  g.restore();
}

/** What a cart's load looks like by its resource key (the cargo's first item): ore, wood, food, stone, arms, gold. */
const LOAD = {
  ore: { lumps: ['#7d8990', '#a7b3ba', '#5d676d'] },
  wood: { logs: true },
  food: { sacks: ['#d9c08a', '#c8ad73'] },
  stone: { lumps: ['#d8cfb8', '#efe7d1', '#b5ab92'] },
  arms: { bundle: true },
  gold: { lumps: ['#e6c35a', '#f6dc8a', '#b08a2a'] },
};

/**
 * An ox and a covered cart going right (`dir` 1) or left (−1). `load` a key of LOAD (what it carries; null for an
 * unknown load), `raided` an empty bed with a broken pennon. (x, y) is the middle of the cart's ground.
 */
export function paintCartArt(g, x, y, u, { faction = 0, own = false, raided = false, load = null, dir = 1 } = {}) {
  if (!paints(g)) return;
  const lw = lwOf(u), roof = roofOf(faction);
  g.save(); g.lineJoin = 'round'; g.lineCap = 'round';
  if (dir < 0) { g.translate(x, 0); g.scale(-1, 1); g.translate(-x, 0); }
  contact(g, x + 0.06 * u, y, u, 0.46, 0.18, 0.3);
  if (own) paintYoursRing(g, x + 0.06 * u, y + 0.02 * u, 0.5 * u);
  // the ox, ahead on the right
  const ox = x + 0.32 * u, oy = y - 0.02 * u;
  g.fillStyle = '#8a6a48'; g.strokeStyle = 'rgba(40,28,14,.85)'; g.lineWidth = lw;
  g.beginPath(); g.ellipse?.(ox, oy - 0.1 * u, 0.13 * u, 0.07 * u, 0, 0, Math.PI * 2); g.fill(); g.stroke();
  for (const dx of [-0.08, -0.03, 0.05, 0.09]) line(g, [[ox + dx * u, oy - 0.06 * u], [ox + dx * u, oy]], '#5a4228', lw * 1.6);
  g.beginPath(); g.ellipse?.(ox + 0.14 * u, oy - 0.13 * u, 0.05 * u, 0.04 * u, -0.3, 0, Math.PI * 2); g.fillStyle = '#7a5c3c'; g.fill(); g.stroke();
  line(g, [[ox + 0.13 * u, oy - 0.17 * u], [ox + 0.1 * u, oy - 0.21 * u]], '#efe4c8', lw * 1.2);
  line(g, [[ox - 0.1 * u, oy - 0.12 * u], [x + 0.14 * u, y - 0.12 * u]], WOOD.dark, lw * 1.6);
  // the bed and its sides
  const bx = x - 0.04 * u, by = y - 0.1 * u, bw = 0.2 * u, bh = 0.07 * u;
  poly(g, [[bx - bw, by], [bx + bw, by], [bx + bw, by - bh], [bx - bw, by - bh]], WOOD.mid, 'rgba(46,30,14,.85)', lw);
  line(g, [[bx - bw, by - bh * 0.5], [bx + bw, by - bh * 0.5]], 'rgba(46,30,14,.4)', lw * 0.8);
  // the load
  const L = raided ? null : LOAD[load] ?? null, ly = by - bh;
  if (L?.lumps) for (const [i, [dx, r]] of [[-0.12, 0.05], [-0.03, 0.06], [0.07, 0.05], [0.13, 0.04], [0.02, 0.04]].entries()) { g.fillStyle = L.lumps[i % 3]; g.beginPath(); g.ellipse?.(bx + dx * u, ly - (i === 4 ? 0.05 : 0.015) * u, r * u, r * 0.75 * u, 0, 0, Math.PI * 2); g.fill(); g.strokeStyle = 'rgba(30,30,30,.4)'; g.lineWidth = lw * 0.7; g.stroke(); }
  else if (L?.logs) for (const [i, dy] of [0.02, 0.06, 0.1].entries()) for (let j = 0; j < 3 - i; j++) { const lx = bx + (-0.1 + j * 0.1 + i * 0.05) * u, yy = ly - dy * u; g.fillStyle = '#8a5f34'; g.beginPath(); g.ellipse?.(lx, yy, 0.05 * u, 0.025 * u, 0, 0, Math.PI * 2); g.fill(); g.strokeStyle = 'rgba(46,30,14,.8)'; g.lineWidth = lw * 0.8; g.stroke(); }
  else if (L?.sacks) for (const [i, dx] of [-0.1, 0.0, 0.1, -0.05, 0.05].entries()) { g.fillStyle = L.sacks[i % 2]; g.beginPath(); g.ellipse?.(bx + dx * u, ly - (i > 2 ? 0.07 : 0.025) * u, 0.055 * u, 0.04 * u, 0, 0, Math.PI * 2); g.fill(); g.strokeStyle = 'rgba(70,54,24,.7)'; g.lineWidth = lw * 0.8; g.stroke(); }
  else if (L?.bundle) { for (const dx of [-0.1, -0.05, 0, 0.05, 0.1]) line(g, [[bx + dx * u, ly], [bx + (dx + 0.03) * u, ly - 0.15 * u]], '#6f7a80', lw * 1.4); line(g, [[bx - 0.12 * u, ly - 0.06 * u], [bx + 0.13 * u, ly - 0.06 * u]], WOOD.dark, lw * 1.8); }
  else if (!raided) { g.fillStyle = '#e8dcbc'; g.beginPath(); g.moveTo(bx - bw * 0.95, ly); g.bezierCurveTo(bx - bw * 0.9, ly - 0.16 * u, bx + bw * 0.9, ly - 0.16 * u, bx + bw * 0.95, ly); g.closePath(); g.fill(); g.strokeStyle = 'rgba(80,64,36,.7)'; g.lineWidth = lw; g.stroke(); }
  // the wheels
  for (const dx of [-0.12, 0.12]) {
    const wx = bx + dx * u, wy = by + 0.015 * u, r = 0.055 * u;
    g.fillStyle = '#4a3420'; g.beginPath(); g.ellipse?.(wx, wy, r * 0.55, r, 0, 0, Math.PI * 2); g.fill(); g.strokeStyle = 'rgba(30,20,10,.9)'; g.lineWidth = lw; g.stroke();
    g.fillStyle = WOOD.lit; g.beginPath(); g.ellipse?.(wx, wy, r * 0.18, r * 0.32, 0, 0, Math.PI * 2); g.fill();
  }
  // the pennon on a staff at the back: the owner's nation; torn when raided
  const sx = bx - bw * 0.92, sy = by - bh;
  line(g, [[sx, sy], [sx, sy - 0.3 * u]], WOOD.dark, lw * 1.6);
  if (raided) poly(g, [[sx, sy - 0.3 * u], [sx + 0.1 * u, sy - 0.26 * u], [sx + 0.05 * u, sy - 0.22 * u], [sx + 0.08 * u, sy - 0.18 * u], [sx, sy - 0.17 * u]], roof.shade, roof.line, lw);
  else poly(g, [[sx, sy - 0.3 * u], [sx + 0.17 * u, sy - 0.26 * u], [sx + 0.12 * u, sy - 0.22 * u], [sx + 0.17 * u, sy - 0.18 * u], [sx, sy - 0.15 * u]], roof.mid, roof.line, lw);
  g.restore();
}

/** The cargo slots of the herald's feed in kernel order (fi18n.mjs RESOURCE_ORDER; on an S1 season Horses holds arms). */
const SLOT_LOAD = Object.freeze(['food', 'wood', 'stone', 'ore', 'arms', 'gold', null, null]);
/**
 * The resource key a caravan's cargo is drawn as (its largest item): one of LOAD's keys, or null. `cargo` is the
 * feed's eight amounts (herald.mjs parseCaravans) or a list of `{resource, amount}` / `[name, key, amount]`.
 */
export function loadOf(cargo) {
  if (Array.isArray(cargo) && cargo.length === 8 && cargo.every(n => typeof n === 'number')) {
    let best = -1;
    cargo.forEach((n, i) => { if (n > 0 && SLOT_LOAD[i] && (best < 0 || n > cargo[best])) best = i; });
    return best >= 0 ? SLOT_LOAD[best] : null;
  }
  const KEY = { Ore: 'ore', Wood: 'wood', Food: 'food', Stone: 'stone', Horses: 'arms', Arms: 'arms', Gold: 'gold' };
  let best = null;
  for (const c of cargo ?? []) if (!best || Number(c.amount ?? c[2] ?? 0) > Number(best.amount ?? best[2] ?? 0)) best = c;
  if (!best) return null;
  const name = best.resource ?? best.name ?? best[1];
  return KEY[name] ?? (LOAD[name] ? name : null);
}
