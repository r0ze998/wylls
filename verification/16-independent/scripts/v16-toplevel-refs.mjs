// ⑯ static audit: for every closure file, the bindings it imports from the KEY modules, and every reference to them
// that is NOT inside a function body (brace depth 0 outside function/class/arrow bodies is approximated by: the
// reference is on a line whose brace depth, counted from the file start ignoring strings/comments, is 0).
import { readFileSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
const [root, list, ...keyMods] = process.argv.slice(2);
const files = readFileSync(list, 'utf8').split('\n').filter(Boolean);
const KEY = new Set(keyMods.map(k => resolve(root, k)));
const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' ')).replace(/\/\/[^\n]*/g, '').replace(/`(?:\\.|[^`\\])*`|'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"/g, m => m.replace(/[^\n]/g, ' '));
const out = [];
for (const rel of files) {
  const f = resolve(root, rel), src = readFileSync(f, 'utf8');
  const names = [];
  for (const m of src.matchAll(/import\s+(\*\s+as\s+([\w$]+)|\{([^}]*)\}|([\w$]+))\s+from\s+['"](\.[^'"]+)['"]/g)) {
    if (!KEY.has(resolve(dirname(f), m[5]))) continue;
    if (m[2]) names.push(m[2]); if (m[4]) names.push(m[4]);
    if (m[3]) for (const p of m[3].split(',')) { const n = p.trim().split(/\s+as\s+/).pop(); if (n) names.push(n); }
  }
  if (KEY.has(f)) names.push('<self>');
  if (!names.length) continue;
  const code = strip(src).split('\n'); let depth = 0; const top = [];
  code.forEach((line, i) => { const d0 = depth; for (const c of line) { if (c === '{') depth++; else if (c === '}') depth--; }
    if (d0 === 0 && !/^\s*(import|export\s+\{|export\s+\*)/.test(line)) for (const n of names.filter(n => n !== '<self>')) if (new RegExp(`(^|[^\\w$.])${n.replace('$', '\\$')}\\b`).test(line)) top.push(`${i + 1}: ${src.split('\n')[i].slice(0, 140)}`);
    if (d0 === 0 && names.includes('<self>') && /\bawait\b|^[\w$.]+\(/.test(line.trim()) && !/^(export\s+)?(async\s+)?function|^(export\s+)?(const|let)\s+[\w$]+\s*=\s*(async\s*)?\(?[\w$, ]*\)?\s*=>/.test(line.trim())) top.push(`${i + 1} (self top-level call?): ${src.split('\n')[i].slice(0, 140)}`);
  });
  out.push({ file: rel, imports: names, topLevelRefs: top });
}
console.log(JSON.stringify(out, null, 1));
