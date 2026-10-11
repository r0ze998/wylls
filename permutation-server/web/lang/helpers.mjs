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

/**
 * A place's name inside an English sentence. A label keeps its capitals and takes no article ("Town of Ramar"); in a
 * sentence the same place reads "the town of Ramar" (UX design 12.6: "In Town of Ramar" and "at Town of Ramar" stood
 * on the play screen). Also "Barbarian camp" → "the barbarian camp", a terrain → "the hills", "Free City" → "the Free
 * City", "The Concord" → "the Concord", "Town of Ramar's province" → "the town of Ramar's province", "Aster side,
 * ring 2" → "the Aster side (ring 2)", "A province of ring 2" → "a province of ring 2". Any other text is unchanged.
 */
export const inText = s => {
  const t = String(s);
  let m;
  if ((m = /^(Hamlet|Town|City|Stronghold) of (.*)$/.exec(t))) return `the ${m[1].toLowerCase()} of ${m[2]}`;
  if (t === 'Mountain') return 'the mountains';
  if (/^(Barbarian camp|Grassland|Plains|Forest|Hills|Water|Land)$/.test(t)) return `the ${t.toLowerCase()}`;
  if (t === 'Free City') return 'the Free City';
  if (t === 'The Concord') return 'the Concord';
  if ((m = /^(.+) side, ring (\d+)$/.exec(t))) return `the ${m[1]} side (ring ${m[2]})`;
  if (/^A province of ring /.test(t)) return `a${t.slice(1)}`;
  return t;
};
/** The same place with the preposition that says something is there: "at the town of Ramar", "in the town of Ramar's province", "on the Aster side (ring 2)", "in the hills". */
export const atPlace = s => {
  const t = inText(s);
  if (/ side \(ring \d+\)$/.test(t)) return `on ${t}`;
  if (t === 'the land') return 'on the land';
  if (/province/i.test(t) || /^the (grassland|plains|forest|hills|mountains|water)$/.test(t)) return `in ${t}`;
  return `at ${t}`;
};
