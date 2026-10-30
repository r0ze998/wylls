// Canonical JSON and its hash: the evaluator's inputs, rulesets and verdicts
// are hashed in this form so that a replay can be compared byte for byte.
// Keys are sorted, `undefined` dropped, BigInt written as a decimal string;
// NaN and Infinity are refused (they have no JSON form).
import { sha256 } from '../../../permutation-gateway/client/src/sha256.mjs';

/** `v` as canonical JSON text. */
export function canonical(v) {
  if (v === null) return 'null';
  switch (typeof v) {
    case 'number':
      if (!Number.isFinite(v)) throw new TypeError('canonical: non-finite number');
      return JSON.stringify(v);
    case 'bigint': return JSON.stringify(v.toString());
    case 'string': case 'boolean': return JSON.stringify(v);
    case 'object':
      if (Array.isArray(v)) return `[${v.map(x => (x === undefined ? 'null' : canonical(x))).join(',')}]`;
      return `{${Object.keys(v).filter(k => v[k] !== undefined).sort()
        .map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
    default: throw new TypeError(`canonical: cannot encode ${typeof v}`);
  }
}

const hex = b => Array.from(b, x => x.toString(16).padStart(2, '0')).join('');

/** sha256 of the canonical JSON of `v`, as lowercase hex. */
export const hashOf = v => hex(sha256(canonical(v)));

/** A deep copy through canonical JSON (drops undefined, sorts nothing visible). */
export const clone = v => JSON.parse(canonical(v));
