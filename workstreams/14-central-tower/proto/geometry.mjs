// Province geometry for the ⑭ central-tower prototype: a transcription of the
// few formulas it needs from permutation-server/web/frontier/fgeo.mjs (rings,
// wedges, province centres, hex distance). Copied, not imported, so the
// prototype stays a self-contained attachment; geometry.test in
// model.test.mjs pins it to fgeo.mjs at the base commit.
//
// The travel constants are the rules' own (permutation-rules/src/frontier/
// travel.rs, caravan.rs at 4cd901de). They are inputs here, switchable in the
// prototype like every other number.

export const PROVINCE_RADIUS = 4;

/** Rules constants at 4cd901de (travel.rs:28-36, caravan.rs:38). */
export const RULES = Object.freeze({
  bellSecs: 600,          // travel.rs BELL_SECS
  flatHexSecs: 120,       // travel.rs FLAT_HEX_SECS (a foot host on flat ground)
  roughHexSecs: 180,      // travel.rs ROUGH_HEX_SECS
  caravanSlowBps: 15_000, // caravan.rs CARAVAN_SLOW_BPS (carts ×1.5)
  maxPathSteps: 32,       // travel.rs MAX_PATH_STEPS (one send)
  maxPathProvinces: 4,    // travel.rs MAX_PATH_PROVINCES (one send)
});

export const hexDistance = (aq, ar, bq, br) => (Math.abs(aq - bq) + Math.abs(ar - br) + Math.abs(aq + ar - bq - br)) / 2;
/** Province-grid distance from the Concord (ring). */
export const ringOf = (p, q) => (Math.abs(p) + Math.abs(q) + Math.abs(p + q)) / 2;
const rotate = ([q, r]) => [0 - r, q + r];
const unrotate = ([q, r]) => [q + r, 0 - q];
const rotateBy = (h, k) => { let x = h; for (let i = 0; i < ((k % 6) + 6) % 6; i++) x = rotate(x); return x; };
export function sextant(q, r) {
  let w = [q, r];
  for (let k = 0; k < 6; k++) {
    if (w[0] > 0 && w[1] >= 0) return k;
    w = unrotate(w);
  }
  return 0;
}
/** Wedge (home nation) of a province, null for the Concord. */
export const wedgeOf = (p, q) => (p === 0 && q === 0 ? null : sextant(p, q));
/** Provinces of ring d in rules order, wedge by wedge: [{p, q}]. */
export function ringProvinces(d) {
  if (d === 0) return [{ p: 0, q: 0 }];
  const out = [];
  for (let k = 0; k < 6; k++) for (let r = 0; r < d; r++) { const [p, q] = rotateBy([d - r, r], k); out.push({ p, q }); }
  return out;
}
/** Centre tile of province (p, q). */
export const provinceCentre = (p, q, n = PROVINCE_RADIUS) => ({ q: (2 * n + 1) * p + n * q, r: -n * p + (n + 1) * q });
/** Hexes between two province centres. */
export const centreHexes = (a, b) => { const x = provinceCentre(a.p, a.q), y = provinceCentre(b.p, b.q); return hexDistance(x.q, x.r, y.q, y.r); };
/** Province steps between two provinces (the province grid is itself a hex grid). */
export const provinceSteps = (a, b) => hexDistance(a.p, a.q, b.p, b.q);

/**
 * A caravan trip in the prototype's terms: hexes centre to centre, the number of
 * sends the rules' per-send caps force (32 steps and 4 provinces per send; a
 * longer trip is resent from where it stopped), and the minutes it is on the
 * road at cart speed over `roughShare` rough ground. Straight-line distance is a
 * lower bound of the real path (the WASM kernel finds the real one).
 */
export function trip(a, b, { roughShare = 0.3, rules = RULES } = {}) {
  const hexes = centreHexes(a, b);
  const provs = provinceSteps(a, b) + 1;
  const sends = Math.max(1, Math.ceil(hexes / rules.maxPathSteps), Math.ceil(provs / rules.maxPathProvinces));
  const hexSecs = (rules.flatHexSecs * (1 - roughShare) + rules.roughHexSecs * roughShare) * rules.caravanSlowBps / 10_000;
  return { hexes, provinces: provs, sends, minutes: Math.round((hexes * hexSecs) / 60) };
}
