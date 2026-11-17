// Paired comparisons across seeds. Two proposals run on the same seed see
// the same dice (rng.mjs), so the per-seed difference removes the variation
// that both share. The interval is a percentile bootstrap over seeds; it
// describes how stable the model's own answer is across its random draws,
// not how real players would behave.

import { draw } from './rng.mjs';
import { quantile } from './stats.mjs';

const BOOT = 4000;

/** Differences x_i - y_i over seeds where both are finite. */
export function diffs(xs, ys) {
  const out = [];
  for (let i = 0; i < Math.min(xs.length, ys.length); i++) {
    const x = Number(xs[i]);
    const y = Number(ys[i]);
    if (Number.isFinite(x) && Number.isFinite(y)) out.push(x - y);
  }
  return out;
}

/**
 * Summary of paired differences: mean, 95 % bootstrap interval of the mean,
 * the spread of the per-seed differences, and the sign counts.
 */
export function pairedSummary(xs, ys, key = 'k') {
  const d = diffs(xs, ys);
  const n = d.length;
  if (n === 0) return { n: 0 };
  const m = d.reduce((s, x) => s + x, 0) / n;
  const sd = Math.sqrt(d.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, n - 1));
  const means = [];
  for (let b = 0; b < BOOT; b++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += d[Math.floor(draw(n * 7919 + key.length, 'boot:' + key, b, i) * n)];
    means.push(s / n);
  }
  return {
    n,
    mean: m,
    sd,
    lo: quantile(means, 0.025),
    hi: quantile(means, 0.975),
    p10: quantile(d, 0.1),
    p50: quantile(d, 0.5),
    p90: quantile(d, 0.9),
    pos: d.filter((x) => x > 0).length,
    neg: d.filter((x) => x < 0).length,
    zero: d.filter((x) => x === 0).length,
  };
}
