// The board's English: what the page shows in Japanese, said in English (display only).
//
// The board's code — this page, the modules it shares with the board server, and the server's answers — writes every
// text in Japanese, and nothing here changes that: reasons are compared, pinned and kept as Japanese. This module
// turns a Japanese text *as shown* into English with the table in lang/en.mjs, whose keys are the Japanese texts of
// the source, with {0}, {1}… where a value stands (the same shape as the game page's tables in
// permutation-server/web/lang/). A text is read in this order:
//   1. the whole text is a key;
//   2. it is a list (` / `, 。, 、, ・ outside brackets) whose every part can be said in English;
//   3. it fits a key with values (the key with the most fixed text first); each value is translated the same way;
//   4. it is wholly inside （ ） or 「 」: the inside is translated;
//   5. left to right: at each place the longest key that starts there (keys that start with fixed text), a bracket
//      and its inside, or one character (full-width punctuation becomes ASCII).
// What still holds Japanese after that is kept as it is and remembered in `missing()` (a test and the live check
// read it). No DOM here: lang.mjs applies it to the page.
import TABLE from './lang/en.mjs';

/** Kana or kanji (the middle dot ・ is punctuation here). */
export const JA = /[぀-ヺー-ヿ㐀-鿿]/;
const WIDE = /[　-〿・＀-￯]/;
/** Does this text need the table (Japanese words or full-width punctuation)? */
export const needsEnglish = s => JA.test(s) || WIDE.test(s);

const PUNCT = { '（': ' (', '）': ')', '：': ': ', '。': '. ', '、': ', ', '・': ' · ', '／': '/', '　': ' · ', '「': '“', '」': '”', '『': '“', '』': '”', '［': '[', '］': ']', '＋': '+', '〜': '–', '？': '?', '！': '!', '，': ', ', '＝': '=', '％': '%' };
const CLOSE = { '（': '）', '「': '」' };
const SEPS = [[' / ', ' / '], ['。', '. '], ['、', ', '], ['・', ' · ']];
const LEAD = { '、': /^,\s*/, '。': /^\.\s*/, '・': /^\s*·\s*/ };

const PH = /\{(\d+)(?::([a-z]))?(\^)?\}/g;
const TYPES = { n: '(-?[\\d,.]+)', '': '([\\s\\S]*?)' };
const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** A key without the types of its values: `国{0:n}` → `国{0}` (the text of the source). */
export const plainKey = k => k.replace(/\{(\d+):[a-z]\}/g, '{$1}');
/** Fill {0}, {1}… ({0^}: with a capital first letter). */
export const format = (template, args) => template.replace(PH, (m, i, _t, up) => {
  if (+i >= args.length) return m;
  const v = String(args[+i]);
  return up ? v.charAt(0).toUpperCase() + v.slice(1) : v;
});
/** Spaces and punctuation after the parts are joined. */
export const tidy = s => s.replace(/[ \t]{2,}/g, ' ').replace(/ +([.,;:)\]”?!])/g, '$1').replace(/([(\[“]) +/g, '$1')
  .replace(/([.,;:])(?: ?[.,])+(?!\.)/g, (m, a) => (m.includes('.') ? '.' : a)).replace(/\. ([a-z])/g, (m, c) => `. ${c.toUpperCase()}`);

/** A translator over one table: `{tr, missing, keys}`. */
export function translator(table = TABLE) {
  const exact = new Map(), patterns = [];
  const add = (key, en) => {
    if (!/\{\d+(?::[a-z])?\}/.test(key)) { if (!exact.has(key)) exact.set(key, en); return; }
    const order = [];
    let src = '', lit = 0, last = 0, prevPh = false;
    for (const m of key.matchAll(/\{(\d+)(?::([a-z]))?\}/g)) {
      const text = key.slice(last, m.index);
      if (text) { src += escRe(text).replace(/ /g, '\\s+'); lit += text.length; prevPh = false; }
      src += prevPh ? '()' : TYPES[m[2] ?? ''];   // values side by side: the first takes both
      order.push(+m[1]); prevPh = true; last = m.index + m[0].length;
    }
    const tail = key.slice(last);
    if (tail) { src += escRe(tail).replace(/ /g, '\\s+'); lit += tail.length; }
    patterns.push({ key, en, order, lit, full: new RegExp(`^${src}$`), prefix: /^\{/.test(key) ? null : new RegExp(`^${src}`), first: key[0] });
  };
  for (const [key, en] of Object.entries(table)) {
    add(key, en);
    // a key that starts with a list mark also stands without it (the part of a list): 「、上限 {0} 未満」 → 「上限 {0} 未満」
    const lead = LEAD[key[0]];
    if (lead && key.length > 1 && typeof en === 'string') add(key.slice(1), en.replace(lead, ''));
  }
  patterns.sort((a, b) => b.lit - a.lit);
  const exactByLen = [...exact.keys()].sort((a, b) => b.length - a.length);
  const cache = new Map(), missed = new Set();

  const say = (en, args) => {
    const v = typeof en === 'function' ? en(...args) : en;
    return v === null || v === undefined ? null : format(String(v), args);
  };
  function apply(p, m) {
    const args = [];
    p.order.forEach((n, j) => { args[n] = tr(m[j + 1] ?? ''); });
    return say(p.en, args);
  }
  function whole(core) {
    if (exact.has(core)) { const v = say(exact.get(core), []); if (v !== null) return v; }
    for (const [sep, join] of SEPS) {
      const parts = splitTop(core, sep);
      if (parts.length < 2) continue;
      const out = parts.map(p => (p.trim() ? tr(p) : p));
      if (out.every(o => !JA.test(o))) return out.join(join);
    }
    for (const p of patterns) {
      const m = p.full.exec(core);
      if (!m) continue;
      const v = apply(p, m);
      if (v !== null) return v;
    }
    const close = CLOSE[core[0]];
    if (close && matching(core, 0) === core.length - 1) return `${PUNCT[core[0]]}${tr(core.slice(1, -1))}${PUNCT[close]}`;
    return walk(core);
  }
  /** Left to right (step 5). */
  function walk(s) {
    let out = '', i = 0;
    while (i < s.length) {
      const rest = s.slice(i);
      let hit = null;
      // a key starts and ends at a word's edge: never inside a run of Japanese (「依頼」 is not read out of 「依頼の板」)
      const edge = i === 0 || !JA.test(s[i - 1]);
      const e = edge ? exactByLen.find(k => rest.startsWith(k) && !(JA.test(k[k.length - 1]) && JA.test(rest[k.length] ?? ''))) : undefined;
      if (e) { const v = say(exact.get(e), []); if (v !== null) hit = { len: e.length, text: v, lit: e.length }; }
      for (const p of patterns) {
        if (!edge || !p.prefix || p.first !== rest[0] || (hit && p.lit <= hit.lit)) continue;
        const m = p.prefix.exec(rest);
        if (!m || !m[0].length) continue;
        const v = apply(p, m);
        if (v !== null) { hit = { len: m[0].length, text: v, lit: p.lit }; break; }
      }
      if (hit) { out += hit.text; i += hit.len; continue; }
      const c = s[i], close = CLOSE[c], end = close ? matching(s, i) : -1;
      if (end > i) { out += `${PUNCT[c]}${tr(s.slice(i + 1, end))}${PUNCT[close]}`; i = end + 1; continue; }
      out += PUNCT[c] ?? c; i++;
    }
    return out;
  }
  /** The English of a Japanese text as shown (white space around it kept). What still holds Japanese is remembered. */
  function shown(text) {
    const out = tr(text);
    if (JA.test(out)) missed.add(String(text));
    return out;
  }
  /** One text or one part of a text (the parts tried on the way are not remembered as missing). */
  function tr(text) {
    const s = String(text ?? '');
    if (!needsEnglish(s)) return s;
    const got = cache.get(s);
    if (got !== undefined) return got;
    const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(s);
    const core = m[2].replace(/[ \t\r\f]*\n[ \t\n\r\f]*/g, ' ');
    let en = tidy(whole(core));
    // a part that begins or ends a text keeps the space the punctuation asked for (" (" after a name, ": " before a value)
    if (/^[（]/.test(core) && !en.startsWith(' ') && !m[1]) en = ` ${en}`;
    if (/[：、]$/.test(core) && !en.endsWith(' ') && !m[3]) en = `${en} `;
    if (/[。]$/.test(core)) en = en.replace(/\s+$/, '');
    const out = m[1] + en + m[3];
    if (cache.size > 20000) cache.clear();
    cache.set(s, out);
    return out;
  }
  return { tr: shown, missing: () => [...missed], clearMissing: () => missed.clear(), keys: () => Object.keys(table) };
}

/** The place of the bracket that closes the one at `i` (-1: none). */
function matching(s, i) {
  const open = s[i], close = CLOSE[open];
  let depth = 0;
  for (let j = i; j < s.length; j++) {
    if (s[j] === open) depth++;
    else if (s[j] === close && --depth === 0) return j;
  }
  return -1;
}
/** Split at `sep` outside （ ） and 「 」. */
function splitTop(s, sep) {
  const out = [];
  let depth = 0, last = 0;
  for (let j = 0; j < s.length; j++) {
    const c = s[j];
    if (c === '（' || c === '「') depth++;
    else if (c === '）' || c === '」') depth = Math.max(0, depth - 1);
    else if (depth === 0 && s.startsWith(sep, j)) { out.push(s.slice(last, j)); last = j + sep.length; j = last - 1; }
  }
  out.push(s.slice(last));
  return out;
}

const shared = translator();
/** The English of a Japanese text as shown, with the board's table. */
export const toEnglish = shared.tr;
/** Texts that still held Japanese after translation (shown as they were). */
export const missing = shared.missing;
