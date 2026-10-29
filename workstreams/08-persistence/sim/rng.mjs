// Keyed, stateless randomness. Every draw is a pure function of
// (seed, purpose, ...keys), so two proposals run on the same seed see the
// same dice for the same event (common random numbers): a change in one
// agent's choices does not shift anyone else's draws.

function mix32(h) {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

function hashString(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

const purposeCache = new Map();
function purposeHash(p) {
  let h = purposeCache.get(p);
  if (h === undefined) {
    h = hashString(p);
    purposeCache.set(p, h);
  }
  return h;
}

/** Uniform in [0, 1) from (seed, purpose, ...integer keys). */
export function draw(seed, purpose, ...keys) {
  let h = mix32((seed >>> 0) ^ 0x9e3779b9);
  h = mix32(h ^ purposeHash(purpose));
  for (const k of keys) h = mix32(h ^ (k >>> 0) ^ Math.imul(k | 0, 0x27d4eb2d));
  return h / 4294967296;
}

/** Integer in [0, n). */
export function drawInt(seed, purpose, n, ...keys) {
  return Math.floor(draw(seed, purpose, ...keys) * n);
}

/** Pick an index from non-negative weights (null if all zero). */
export function pickWeighted(weights, u) {
  let total = 0;
  for (const w of weights) total += w;
  if (total <= 0) return null;
  let x = u * total;
  for (let i = 0; i < weights.length; i++) {
    x -= weights[i];
    if (x < 0) return i;
  }
  return weights.length - 1;
}
