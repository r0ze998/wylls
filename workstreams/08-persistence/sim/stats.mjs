// Small statistics helpers. Inputs are plain arrays of finite numbers;
// Infinity marks a censored "never happened in the run".

export function mean(xs) {
  if (xs.length === 0) return NaN;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

export function quantile(xs, q) {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const a = s[lo];
  const b = s[hi];
  if (lo === hi) return a;
  if (!Number.isFinite(b)) return Infinity; // interpolating into a censored tail
  return a + (b - a) * (pos - lo);
}

export function median(xs) {
  return quantile(xs, 0.5);
}

/** Gini coefficient of non-negative values (0 = equal, 1 = one holds all). */
export function gini(xs) {
  const v = xs.filter((x) => x >= 0).sort((a, b) => a - b);
  const n = v.length;
  if (n === 0) return NaN;
  let cum = 0;
  let weighted = 0;
  for (let i = 0; i < n; i++) {
    cum += v[i];
    weighted += (i + 1) * v[i];
  }
  if (cum === 0) return 0;
  return (2 * weighted) / (n * cum) - (n + 1) / n;
}

/** Herfindahl–Hirschman index of shares (1/n = even, 1 = monopoly). */
export function hhi(xs) {
  let total = 0;
  for (const x of xs) total += x;
  if (total <= 0) return NaN;
  let h = 0;
  for (const x of xs) h += (x / total) ** 2;
  return h;
}

/** Share of the largest value. */
export function topShare(xs) {
  let total = 0;
  let top = 0;
  for (const x of xs) {
    total += x;
    if (x > top) top = x;
  }
  return total > 0 ? top / total : NaN;
}

/** Fraction of xs that are <= limit (Infinity counts as never). */
export function shareWithin(xs, limit) {
  if (xs.length === 0) return NaN;
  return xs.filter((x) => x <= limit).length / xs.length;
}

/** Summary across seeds: mean, p10, p50, p90 of finite values, plus n. */
export function summarize(xs) {
  const f = xs.filter((x) => Number.isFinite(x));
  return {
    n: xs.length,
    finite: f.length,
    mean: mean(f),
    p10: quantile(f, 0.1),
    p50: quantile(f, 0.5),
    p90: quantile(f, 0.9),
  };
}
