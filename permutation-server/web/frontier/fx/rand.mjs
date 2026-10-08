// Seeded randomness for effects. An effect is seeded by the id of the event
// that caused it (a clash's "2,0@39", a march id), so the same event paints
// the same sparks on every device and at every replay, and the demo switch
// can be captured frame by frame. Nothing in fx/ calls Math.random.

/** FNV-1a of a string or number → uint32. */
export function hashSeed(id) {
  const s = String(id);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

/** mulberry32: `rng()` in [0, 1); `rng.range(a, b)`, `rng.int(n)`, `rng.sign()`, `rng.pick(list)`. */
export function rng(seed) {
  let a = (typeof seed === 'number' ? seed : hashSeed(seed)) >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  next.range = (lo, hi) => lo + (hi - lo) * next();
  next.int = n => Math.floor(next() * n);
  next.sign = () => (next() < 0.5 ? -1 : 1);
  next.pick = list => list[Math.floor(next() * list.length)];
  return next;
}

/** A value in [0, 1) from integers (no state): jitter that must not depend on call order. */
export function hash01(a, b = 0) {
  let h = (Math.imul(a | 0, 0x9e3779b1) ^ Math.imul(b | 0, 0x85ebca6b)) >>> 0;
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12; h = Math.imul(h, 0x297a2d39); h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

/** Smooth 1-D value noise in [-1, 1] (for shake and flicker): continuous in t, repeatable by seed. */
export function noise1(t, seed = 0) {
  const i = Math.floor(t), f = t - i;
  const a = hash01(i, seed) * 2 - 1, b = hash01(i + 1, seed) * 2 - 1;
  const u = f * f * (3 - 2 * f);
  return a + (b - a) * u;
}
