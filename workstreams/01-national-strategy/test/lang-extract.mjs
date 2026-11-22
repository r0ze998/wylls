// The Japanese texts the board's code can put on the page, read from the source (no code is run).
//
// `literalsOf(js)` walks a module's text and gives every string and template literal outside comments and regular
// expressions: `{text, line}`, where a template's `${…}` is written `{0}`, `{1}`… (a template inside a `${…}` is a
// literal of its own). `segmentsOf(text)` cuts a literal at its HTML tags and renumbers the placeholders of each
// piece from {0}: these pieces are what a text node on the page is made of, and they are the keys of the board's
// English table (coop/lang/en.mjs). `htmlTexts(html)` gives a page's static texts, attributes and CSS `content`.

export const JA = /[぀-ヿ㐀-鿿]/;

const REGEX_BEFORE = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^', '']);
const REGEX_WORDS = /(?:^|[^\w$.])(?:return|typeof|case|in|of|delete|void|throw|new|else|do)$/;

export function literalsOf(src) {
  const out = [];
  let i = 0, line = 1;
  const n = src.length;
  const lineAt = () => line;
  /** Read code until `stop` ('}' of a `${`, or the end): literals found are pushed. */
  function code(stopAtBrace) {
    let depth = 0, prev = '', tail = '';
    while (i < n) {
      const c = src[i];
      if (c === '\n') { line++; i++; continue; }
      if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; continue; }
      if (c === '/' && src[i + 1] === '*') { i += 2; while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] === '\n') line++; i++; } i += 2; continue; }
      if (c === '/' && (REGEX_BEFORE.has(prev) || REGEX_WORDS.test(tail))) {
        i++; let cls = false;
        while (i < n) { const d = src[i]; if (d === '\\') { i += 2; continue; } if (d === '[') cls = true; else if (d === ']') cls = false; else if (d === '/' && !cls) break; else if (d === '\n') break; i++; }
        i++; while (i < n && /[a-z]/.test(src[i])) i++;
        prev = 'x'; tail = 'x'; continue;
      }
      if (c === "'" || c === '"') { const at = lineAt(); out.push({ text: quoted(c), line: at }); prev = 'x'; tail = 'x'; continue; }
      if (c === '`') { const at = lineAt(); const slot = out.push(null) - 1; out[slot] = { text: template(), line: at }; prev = 'x'; tail = 'x'; continue; }
      if (c === '{') depth++;
      if (c === '}') { if (stopAtBrace && depth === 0) { i++; return; } depth--; }
      if (!/\s/.test(c)) { prev = c; tail = (tail + c).slice(-12); } else tail += ' ';
      i++;
    }
  }
  function quoted(q) {
    let s = ''; i++;
    while (i < n && src[i] !== q) {
      if (src[i] === '\\') { const e = src[i + 1]; s += e === 'n' ? '\n' : e === 't' ? '\t' : e; i += 2; continue; }
      if (src[i] === '\n') line++;
      s += src[i++];
    }
    i++;
    return s;
  }
  function template() {
    let s = '', k = 0; i++;
    while (i < n && src[i] !== '`') {
      if (src[i] === '\\') { const e = src[i + 1]; s += e === 'n' ? '\n' : e === 't' ? '\t' : e; i += 2; continue; }
      if (src[i] === '$' && src[i + 1] === '{') { i += 2; code(true); s += `{${k++}}`; continue; }
      if (src[i] === '\n') line++;
      s += src[i++];
    }
    i++;
    return s;
  }
  code(false);
  return out.filter(Boolean);
}

/** The key of a piece of text: white space around a line break read as one space, trimmed, placeholders renumbered from {0}. */
export function keyOf(piece) {
  let k = 0; const seen = new Map();
  return piece.replace(/[ \t\r\f]*\n[ \t\n\r\f]*/g, ' ').trim()
    .replace(/\{(\d+)\}/g, (m, d) => { if (!seen.has(d)) seen.set(d, k++); return `{${seen.get(d)}}`; });
}

/** A literal cut at its HTML tags: the pieces that hold Japanese, as keys. */
export function segmentsOf(text) {
  return text.split(/<\/?[a-zA-Z][^<>]*>|<!--[\s\S]*?-->/).map(keyOf).filter(s => JA.test(s));
}

/** A page's static Japanese: text between tags (scripts left out; CSS `content: '…'` kept), and attribute values. */
export function htmlTexts(html) {
  const out = [];
  for (const m of html.matchAll(/content:\s*'([^']*)'/g)) if (JA.test(m[1])) out.push(m[1]);
  const body = html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '');
  for (const m of body.matchAll(/\s(?:aria-label|title|placeholder|alt)="([^"]*)"/g)) if (JA.test(m[1])) out.push(m[1]);
  for (const s of body.split(/<[^<>]*>/)) { const k = keyOf(s); if (JA.test(k)) out.push(k); }
  return out;
}
