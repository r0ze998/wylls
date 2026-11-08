// node workstreams/14-central-tower/proto/build.mjs
// Inlines the modules into one HTML file (tower-proto.html) that opens from
// disk without a server: imports are dropped, `export` is stripped, and a
// top-level name declared twice stops the build.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const ORDER = ['geometry.mjs', 'contract.mjs', 'adapters.mjs', 'model.mjs', 'compare.mjs', 'ui.mjs'];
const seen = new Map();
const parts = ORDER.map(name => {
  const src = readFileSync(join(here, name), 'utf8');
  const body = src.split('\n').filter(l => !/^(import|export) .* from '\.\/.*\.mjs';$/.test(l)).map(l => l.replace(/^export (?=(const|function|let|async function) )/, '')).join('\n');
  for (const m of body.matchAll(/^(?:const|let|function|async function) ([A-Za-z_$][\w$]*)/gm)) {
    if (seen.has(m[1])) throw new Error(`${m[1]} declared in ${seen.get(m[1])} and ${name}`);
    seen.set(m[1], name);
  }
  if (/^export /m.test(body)) throw new Error(`an export is left in ${name}`);
  return `// ---- ${name}\n${body}`;
});
const html = readFileSync(join(here, 'index.html'), 'utf8');
const tag = '<script type="module" src="./ui.mjs"></script>';
if (!html.includes(tag)) throw new Error('script tag not found');
writeFileSync(join(here, '..', 'tower-proto.html'), html.replace(tag, () => `<script type="module">\n${parts.join('\n')}\n</script>`));
console.log('wrote tower-proto.html');
