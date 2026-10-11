// Source-scanning helpers for the council page's tests: blank out the comments of a JavaScript module (aware of
// strings, template literals and regex literals, so a "/*" inside a URL-like comment or a quote inside a regex does
// not fool it) and list a module's import specifiers. No parser dependency.
const REGEX_PREV = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^']);
const REGEX_KEYWORDS = /(?:^|[^\w$])(?:return|typeof|case|do|else|in|of|void|yield|await|delete|throw|new|instanceof)$/;

export function stripComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  let lastSig = '';
  const blank = s => s.replace(/[^\n]/g, ' ');
  function readTemplate() {
    // at the opening backtick; copies the literal, recursing into ${ }
    let j = i + 1;
    let s = '`';
    while (j < n) {
      const c = src[j];
      if (c === '\\') { s += src.slice(j, j + 2); j += 2; continue; }
      if (c === '`') { s += c; j++; break; }
      if (c === '$' && src[j + 1] === '{') {
        let depth = 1;
        s += '${';
        j += 2;
        const inner = j;
        while (j < n && depth > 0) {
          if (src[j] === '{') depth++;
          else if (src[j] === '}') depth--;
          else if (src[j] === '`') { const save = i; i = j; const t = readTemplate(); j = i; i = save; void t; continue; }
          else if (src[j] === '\'' || src[j] === '"') { const q = src[j]; j++; while (j < n && src[j] !== q) { if (src[j] === '\\') j++; j++; } }
          j++;
        }
        s += src.slice(inner, j);
        continue;
      }
      s += c;
      j++;
    }
    i = j;
    return s;
  }
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') { const e = src.indexOf('\n', i); const end = e < 0 ? n : e; out += blank(src.slice(i, end)); i = end; continue; }
    if (c === '/' && d === '*') { const e = src.indexOf('*/', i + 2); const end = e < 0 ? n : e + 2; out += blank(src.slice(i, end)); i = end; continue; }
    if (c === '\'' || c === '"') {
      let j = i + 1;
      while (j < n && src[j] !== c && src[j] !== '\n') { if (src[j] === '\\') j++; j++; }
      out += src.slice(i, j + 1);
      i = j + 1;
      lastSig = c;
      continue;
    }
    if (c === '`') { out += readTemplate(); lastSig = '`'; continue; }
    if (c === '/') {
      const prevWord = out.slice(-12);
      if (lastSig === '' || REGEX_PREV.has(lastSig) || REGEX_KEYWORDS.test(prevWord.trimEnd())) {
        let j = i + 1;
        let cls = false;
        while (j < n && src[j] !== '\n') {
          if (src[j] === '\\') { j += 2; continue; }
          if (src[j] === '[') cls = true;
          else if (src[j] === ']') cls = false;
          else if (src[j] === '/' && !cls) break;
          j++;
        }
        j++;
        while (/[a-z]/i.test(src[j] ?? '')) j++;
        out += src.slice(i, j);
        i = j;
        lastSig = ')';
        continue;
      }
    }
    out += c;
    if (!/\s/.test(c)) lastSig = c;
    i++;
  }
  return out;
}

/** Import specifiers of a module: static imports and re-exports, side-effect imports, and dynamic imports with a literal. */
export function specifiers(src) {
  const code = stripComments(src);
  const out = [];
  for (const m of code.matchAll(/\bimport\s+(?:[\w*{}\s,]+\sfrom\s*)?['"]([^'"]+)['"]/g)) out.push(m[1]);
  for (const m of code.matchAll(/\bexport\s*(?:\*|\{[^}]*\})\s*from\s*['"]([^'"]+)['"]/g)) out.push(m[1]);
  for (const m of code.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) out.push(m[1]);
  return out;
}
