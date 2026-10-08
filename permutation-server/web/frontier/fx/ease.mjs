// Easing for effects (UX-DESIGN §8.1). Every function maps k in [0, 1] to a
// value that is 0 at k = 0 and 1 at k = 1 (the overshooting ones pass 1 on
// the way). `phase` cuts an effect's life into named beats so an effect is
// written as anticipation, impact and decay instead of one linear fade.

export const clamp01 = k => (k < 0 ? 0 : k > 1 ? 1 : k);
export const lerp = (a, b, k) => a + (b - a) * k;
/** k of `t` between a and b, clamped (the progress of one beat). */
export const span = (t, a, b) => (b <= a ? (t >= b ? 1 : 0) : clamp01((t - a) / (b - a)));

export const linear = k => clamp01(k);
export const inQuad = k => { k = clamp01(k); return k * k; };
export const outQuad = k => { k = clamp01(k); return 1 - (1 - k) * (1 - k); };
export const inOutQuad = k => { k = clamp01(k); return k < 0.5 ? 2 * k * k : 1 - ((-2 * k + 2) ** 2) / 2; };
export const inCubic = k => { k = clamp01(k); return k * k * k; };
export const outCubic = k => { k = clamp01(k); return 1 - (1 - k) ** 3; };
export const inOutCubic = k => { k = clamp01(k); return k < 0.5 ? 4 * k * k * k : 1 - ((-2 * k + 2) ** 3) / 2; };
export const outQuart = k => { k = clamp01(k); return 1 - (1 - k) ** 4; };
export const outExpo = k => { k = clamp01(k); return k >= 1 ? 1 : 1 - 2 ** (-10 * k); };
/** Overshoots by about 10% (s = 1.70158) and settles: a stamp, a pop. */
export const outBack = (k, s = 1.70158) => { k = clamp01(k); return 1 + (s + 1) * (k - 1) ** 3 + s * (k - 1) ** 2; };
/** Pulls back below 0 first: the wind-up before a move. */
export const inBack = (k, s = 1.70158) => { k = clamp01(k); return (s + 1) * k * k * k - s * k * k; };
/** Rings past 1 a few times and settles: a struck thing. */
export const outElastic = k => {
  k = clamp01(k);
  if (k === 0 || k === 1) return k;
  return 2 ** (-10 * k) * Math.sin((k * 10 - 0.75) * ((2 * Math.PI) / 3)) + 1;
};
/** Drops and bounces three times. */
export const outBounce = k => {
  k = clamp01(k);
  const n = 7.5625, d = 2.75;
  if (k < 1 / d) return n * k * k;
  if (k < 2 / d) return n * (k -= 1.5 / d) * k + 0.75;
  if (k < 2.5 / d) return n * (k -= 2.25 / d) * k + 0.9375;
  return n * (k -= 2.625 / d) * k + 0.984375;
};

/**
 * A damped spring from 0 to 1 in closed form: `spring(k, {damping, freq})`.
 * damping below 1 overshoots (0.35 is lively, 0.6 is a firm settle), 1 is
 * critically damped; `freq` is how many times it would swing over k = 0..1.
 * Exactly 1 at k = 1 (the residue is blended out over the last tenth).
 */
export function spring(k, { damping = 0.45, freq = 2.2 } = {}) {
  k = clamp01(k);
  if (k === 0 || k === 1) return k;
  const w = 2 * Math.PI * freq;
  const z = Math.max(0.01, Math.min(1, damping));
  let v;
  if (z >= 1) v = 1 - Math.exp(-w * k) * (1 + w * k);
  else {
    const wd = w * Math.sqrt(1 - z * z);
    v = 1 - Math.exp(-z * w * k) * (Math.cos(wd * k) + ((z * w) / wd) * Math.sin(wd * k));
  }
  const tail = span(k, 0.9, 1);
  return v + (1 - v) * tail * tail;
}

/** 0 → 1 → 0 over k, peaking at `peak` (rise ease-out, fall ease-in-out): a pulse. */
export function pulse(k, peak = 0.2) {
  k = clamp01(k);
  return k < peak ? outCubic(k / peak) : 1 - inOutQuad((k - peak) / (1 - peak));
}

/**
 * An attack-hold-release envelope in seconds: 0 before 0, rises over `a`
 * (ease-out), holds until `d - r`, falls over `r` (ease-in), 0 after `d`.
 */
export function envelope(t, d, a = 0.08, r = 0.3) {
  if (t <= 0 || t >= d) return 0;
  if (t < a) return outCubic(t / a);
  if (t > d - r) return 1 - inQuad((t - (d - r)) / r);
  return 1;
}

/**
 * The beats of an effect: `phase(t, [['wind', 0.12], ['hit', 0.08], ['decay', 0.6]])`
 * → {name, k (progress of that beat), i, done}. Durations in the unit of t.
 */
export function phase(t, beats) {
  let at = 0;
  for (let i = 0; i < beats.length; i++) {
    const [name, d] = beats[i];
    if (t < at + d || i === beats.length - 1) return { name, i, k: clamp01(d > 0 ? (t - at) / d : 1), done: t >= at + d };
    at += d;
  }
  return { name: null, i: -1, k: 1, done: true };
}

/** Every easing by name (the demo and tests walk this). */
export const EASES = Object.freeze({ linear, inQuad, outQuad, inOutQuad, inCubic, outCubic, inOutCubic, outQuart, outExpo, outBack, inBack, outElastic, outBounce, spring });
