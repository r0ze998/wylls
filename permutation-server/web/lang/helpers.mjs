// Helpers for English dictionary entries (lang/en-*.mjs). No imports, so a
// dictionary file can use them at load time.

/**
 * One of two English templates by the count `n` (a number or a numeric
 * string such as "1,234"): plural(n, '{0} member', '{0} members').
 */
export const plural = (n, one, many) => (Number(String(n).replace(/,/g, '')) === 1 ? one : many);

/**
 * A text with its first letter in upper case, for an entry whose value leads a line ("the province of …" → "The
 * province of …"): cap(a).
 */
export const cap = s => { const t = String(s); return t.charAt(0).toUpperCase() + t.slice(1); };
