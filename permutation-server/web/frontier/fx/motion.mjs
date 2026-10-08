// How much may move (UX-DESIGN §8.5). One answer for the whole client:
//
//   motion() → 'full' | 'reduced' | 'off'
//
// It is the calmer of two things: the system's "reduce motion" setting (the
// media query) and the player's own choice "effects: full / reduced / off"
// (fui.mjs `effects`, shown under More → settings).
//
//   full     travel, particles, shake, camera moves.
//   reduced  nothing travels, shakes or scatters; a change of state shows at
//            once with a 200 ms opacity change. Numbers, verdicts and banners
//            still appear.
//   off      no decoration at all; numbers, verdicts and banners are shown
//            plainly (they are information, never only an animation).
//
// Sound is separate (fx/audio.mjs has its own mute).

export const MOTION_LEVELS = Object.freeze(['full', 'reduced', 'off']);
/** The opacity change that replaces movement in the reduced mode, in seconds. */
export const REDUCED_FADE = 0.2;

let prefSource = () => null;
let forced = null;

/** Where the player's setting is read from (`() => 'full' | 'reduced' | 'off' | null`); the app wires FS.ui.effects. */
export function setMotionSource(fn) { prefSource = typeof fn === 'function' ? fn : () => fn; }
/** Force a level (the demo switch's `&fxmotion=`); `null` lifts it. */
export function forceMotion(level) { forced = MOTION_LEVELS.includes(level) ? level : null; }

/** The system setting, read through a guarded matchMedia (false where there is none). */
export function systemReduced() {
  try { return !!globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches; } catch { return false; }
}

/** The calmer of the player's setting and the system's: pure, for tests and for callers that hold both. */
export function resolveMotion(pref, reduce) {
  const p = MOTION_LEVELS.includes(pref) ? pref : 'full';
  if (p === 'off') return 'off';
  return reduce || p === 'reduced' ? 'reduced' : 'full';
}

/** The level in force now. */
export function motion() {
  if (forced) return forced;
  let pref = null;
  try { pref = prefSource(); } catch { pref = null; }
  return resolveMotion(pref, systemReduced());
}

/** True when things may travel, scatter and shake. */
export const fullMotion = () => motion() === 'full';
