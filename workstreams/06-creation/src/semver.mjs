/**
 * The version grammar of manifests: MAJOR.MINOR.PATCH, and ranges written
 * as an exact version, `^x.y.z` (same major, or same minor under 1.0.0) or
 * `~x.y.z` (same minor). Nothing else, so a range is easy to read on the
 * paper a user sees.
 */

const RE = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/;

export function parse(text) {
  const m = typeof text === "string" && RE.exec(text);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function compare(a, b) {
  const x = parse(a), y = parse(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

export function isRange(text) {
  if (typeof text !== "string") return false;
  const body = text[0] === "^" || text[0] === "~" ? text.slice(1) : text;
  return parse(body) !== null;
}

export function satisfies(version, range) {
  const v = parse(version);
  if (!v || !isRange(range)) return false;
  const op = range[0] === "^" || range[0] === "~" ? range[0] : "=";
  const r = parse(op === "=" ? range : range.slice(1));
  if (op === "=") return compare(version, range) === 0;
  if (compare(version, r.join(".")) < 0) return false;
  if (op === "~") return v[0] === r[0] && v[1] === r[1];
  if (r[0] > 0) return v[0] === r[0];
  if (r[1] > 0) return v[0] === 0 && v[1] === r[1];
  return v[0] === 0 && v[1] === 0 && v[2] === r[2];
}

/** Which part a step from `from` to `to` raised: "major", "minor", "patch", or null if not newer. */
export function bumpOf(from, to) {
  const a = parse(from), b = parse(to);
  if (compare(to, from) <= 0) return null;
  if (b[0] !== a[0]) return "major";
  if (b[1] !== a[1]) return "minor";
  return "patch";
}

export const BUMP_ORDER = Object.freeze({ patch: 0, minor: 1, major: 2 });

export function newest(versions) {
  return [...versions].sort(compare).at(-1) ?? null;
}
