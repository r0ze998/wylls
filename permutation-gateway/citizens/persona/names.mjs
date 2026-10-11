// Names (contract §2.3): `nameOf(tag)` is `identityOf(tag)` with an explicit
// language, never `withProfile` and never `profile.mjs` (a signed profile is
// player text, up to 24 free characters, and must not reach an episode or a
// prompt). Nation names come from the committed table memory/names.json
// (a test compares it with i18n.mjs CIV_NAMES), not from lang.mjs or
// fi18n.mjs, whose answers follow the process-global language.
//
// Read-only web imports of this file: permutation-server/web/frontier/people/
// identity.mjs and, through it, permutation-server/web/lang.mjs (and the
// dictionaries lang.mjs imports). AC1 pins them in the permission-model list.
import { identityOf, displayName, IDENTITY_VERSION } from '../../../permutation-server/web/frontier/people/identity.mjs';
import { readJson } from '../memory/config.mjs';

export { IDENTITY_VERSION };
const NAMES = readJson(new URL('../memory/names.json', import.meta.url));

/** A citizen tag as 16 lowercase hex digits (the PUB/ledger key). Accepts a bigint, a number, "0x…" or 16 hex digits; a decimal string needs `tagFromDecimal`. */
export function tagHex(x) {
  let v;
  if (typeof x === 'bigint') v = x;
  else if (typeof x === 'number' && Number.isSafeInteger(x) && x >= 0) v = BigInt(x);
  else if (typeof x === 'string' && /^0x[0-9a-f]{1,16}$/i.test(x)) v = BigInt(x);
  else if (typeof x === 'string' && /^[0-9a-f]{16}$/i.test(x)) return x.toLowerCase();
  else throw new TypeError(`not a citizen tag: ${String(x).slice(0, 40)}`);
  return BigInt.asUintN(64, v).toString(16).padStart(16, '0');
}
/** The decoded herald rows write u64 values as decimal strings. */
export function tagFromDecimal(s) {
  if (typeof s === 'bigint') return tagHex(s);
  if (typeof s === 'number') return tagHex(BigInt(s));
  if (typeof s !== 'string' || !/^\d{1,20}$/.test(s)) throw new TypeError(`not a decimal u64: ${String(s).slice(0, 40)}`);
  return tagHex(BigInt(s));
}

/** `{en, ja}` given name of a citizen (derived from the tag only). */
export function nameOf(tag) {
  const id = identityOf(tagHex(tag));
  return { en: displayName(id, { language: 'en' }), ja: displayName(id, { language: 'ja' }) };
}

/** `{en, ja}` of nation f (0..5), else the "nation f" fallback. */
export function nationName(f) {
  const n = NATION_TABLE[f];
  if (n) return { en: n.en, ja: n.ja };
  const s = Number.isInteger(f) ? String(f) : '?';
  return { en: NAMES.fallback.en.replace('{f}', s), ja: NAMES.fallback.ja.replace('{f}', s) };
}
const NATION_TABLE = NAMES.nations;
export const NATION_COUNT = NATION_TABLE.length;
