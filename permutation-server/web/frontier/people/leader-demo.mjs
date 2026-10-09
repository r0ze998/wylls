// The six leaders on the real board, for the owner to judge (the effects demo
// switch only: `?fx=leaders`, under the corner tag 「演出の見本」). The game has
// no leader that walks the map: nothing in normal play imports this file, and
// fx/demo.mjs, which does, is itself loaded only when the address asks for it.
//
// The picture: six tiles near the demo tile (the viewer's village), one leader
// on each at the size the motion package was approved at (LEADER_DRAW_SCALE
// 1.30 of a host's figure, as in the package's game-fit.png). Each walks one
// tile to its place, stands, strikes once, takes a hit and stands again:
//
//   0.0 – 2.6 s  walk (one tile, the walk clip looping once a second)
//   3.2 – 4.0 s  attack (the clip once, back to the stance)
//   4.6 – 5.15 s hit
//   else         idle
//
// It is a pure function of the demo clock (`leaderDemoPose`), so a frame can
// be frozen, stepped and captured. Figures stand upright on the tilted board
// (the caller's `stand`, fx/draw.mjs `stood`), feet on the tile, a soft shadow
// on the ground, the viewer's own nation's leader in the gold ring. Reduced
// motion: nobody travels; the six stand on their tiles as stills.
import { project, RADIUS, FLATTEN } from '../../map.mjs';
import { MOTION_LEADERS, LEADER_MOTIONS } from '../leader-motion-data.mjs';
import { paintLeaderMotion, onLeaderMotionLoad, leaderMotionSheet } from './leader-motion.mjs';
import { zoomBoost } from './crowds.mjs';

const clip = key => LEADER_MOTIONS.find(m => m.key === key);
/** The demo's beats in seconds. */
export const LEADER_DEMO = Object.freeze({ secs: 6.4, walk: Object.freeze([0, 2.6]), attack: Object.freeze([3.2, 3.2 + clip('attack').duration]), hit: Object.freeze([4.6, 4.6 + clip('hit').duration]), stagger: 0.07 });
/**
 * Where the six stand, in tiles from the demo tile (axial): two rows of three to the east of the village, as in
 * game-fit.png, clear of the village's own hosts (at its foot) and, in the fixture world, of the camp to the south-east.
 */
export const LEADER_DEMO_TILES = Object.freeze([[2, -1], [3, -1], [4, -1], [2, 0], [3, 0], [4, 0]].map(t => Object.freeze(t)));

/**
 * What leader `i` (0–5) does `t` seconds into the demo: `{motion, share, looping, walk}`: the clip, how far through
 * it (a share, as paintLeaderMotion takes it), and `walk` (1 → 0): how much of the last tile is still to be walked.
 */
export function leaderDemoPose(t, i = 0, { full = true } = {}) {
  if (!full) return { motion: 'idle', share: 0, looping: true, walk: 0 };
  const D = LEADER_DEMO, u = t - i * D.stagger;
  if (u < D.walk[1]) { const k = Math.max(0, Math.min(1, (u - D.walk[0]) / (D.walk[1] - D.walk[0]))); return { motion: 'walk', share: Math.max(0, u) / clip('walk').duration, looping: true, walk: 1 - k }; }
  if (u >= D.attack[0] && u < D.attack[1]) return { motion: 'attack', share: (u - D.attack[0]) / (D.attack[1] - D.attack[0]), looping: false, walk: 0 };
  if (u >= D.hit[0] && u < D.hit[1]) return { motion: 'hit', share: (u - D.hit[0]) / (D.hit[1] - D.hit[0]), looping: false, walk: 0 };
  return { motion: 'idle', share: u / clip('idle').duration, looping: true, walk: 0 };
}

/** The six figures of a frame: `[{leader, faction, x, y, motion, share, looping}]` in world px, the far ones first. */
export function leaderDemoFigures(at, t, { full = true } = {}) {
  return MOTION_LEADERS.map((l, i) => {
    const [dq, dr] = LEADER_DEMO_TILES[i], pose = leaderDemoPose(t, i, { full });
    const here = project(at.q + dq, at.r + dr), from = project(at.q + dq - 1, at.r + dr);
    // (the feet stand a little below the tile's middle, where a host's do)
    return { leader: l.key, faction: l.faction, x: here.x + (from.x - here.x) * pose.walk, y: here.y + (from.y - here.y) * pose.walk + RADIUS * FLATTEN * 0.26, motion: pose.motion, share: pose.share, looping: pose.looping };
  }).sort((a, b) => a.y - b.y || a.x - b.x);
}

/**
 * Paint the six at demo time `t` into `ctx` (world space, the map's own units). `zoom`: the map's; `stand(ctx, x,
 * y, draw)`: how a thing is stood upright on the tilted board (default: it simply draws); `own`: the faction whose
 * leader carries the gold ring; `alpha`. Returns how many figures a sheet was there for.
 */
export function paintLeaderDemo(ctx, { t = 0, zoom = 1, at = { q: 0, r: 0 }, stand = (g, x, y, draw) => draw(), own = null, full = true, alpha = 1 } = {}) {
  if (!ctx?.save) return 0;
  const size = RADIUS * 0.66 * zoomBoost(RADIUS * zoom);
  let n = 0;
  for (const f of leaderDemoFigures(at, t, { full })) {
    // the shadow lies on the ground (it is not stood upright); the figure stands on it
    ctx.save();
    ctx.globalAlpha *= 0.3 * alpha; ctx.fillStyle = '#0a120f';
    ctx.beginPath(); ctx.ellipse?.(f.x + size * 0.05, f.y + size * 0.02, size * 0.34, size * 0.12, 0, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
    stand(ctx, f.x, f.y, () => { if (paintLeaderMotion(ctx, f.x, f.y, size, { leader: f.leader, motion: f.motion, share: f.share, looping: f.looping, face: 1, alpha, own: own === f.faction })) n++; });
  }
  return n;
}

/** Fetch every sheet the demo uses (so that no clip begins on a still pose); returns how many are still to come. */
export function preloadLeaderDemo() {
  let pending = 0;
  for (const l of MOTION_LEADERS) for (const m of LEADER_MOTIONS) if (!leaderMotionSheet(l.key, m.key)) pending++;
  return pending;
}

/**
 * Play the demo on the effects engine `fx` at the demo's tile `c.at` (fx/demo.mjs SAMPLES `leaders`): one effect
 * on the top canvas for `LEADER_DEMO.secs`. `stand`: fx/draw.mjs `stood`. The viewer's own nation (the map's survey)
 * gets the gold ring.
 */
export function playLeaderDemo(fx, c, { stand = undefined } = {}) {
  onLeaderMotionLoad(() => { try { fx.kick?.(); } catch { /* the engine is gone */ } });
  preloadLeaderDemo();
  let own = null;
  try { const f = fx.map?.source?.()?.survey?.faction; own = Number.isInteger(f) ? f : null; } catch { own = null; }
  return fx.add({ name: 'leaders', layer: 'top', dur: LEADER_DEMO.secs, seed: 'demo|leaders', info: true,
    draw(ctx, s) { paintLeaderDemo(ctx, { t: s.t, zoom: s.zoom, at: c.at, stand, own, full: s.mode === 'full', alpha: Math.min(1, s.t / 0.25, (LEADER_DEMO.secs - s.t) / 0.3) }); } });
}
