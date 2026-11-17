#!/usr/bin/env node
// The package manifest: the SHA-256 of every file of the spike (this
// manifest excluded), written as `archive/MANIFEST.sha256` in `sha256sum`
// format, and verified the same way. Restore steps: archive/RESTORE.ja.md.
//
//   node archive/manifest.mjs write    → rewrites MANIFEST.sha256 (and prints the manifest's own hash)
//   node archive/manifest.mjs verify   → exit 0 when every listed file matches and no file is unlisted
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = path.join(root, 'archive', 'MANIFEST.sha256');
const SKIP = new Set(['node_modules', '.local']);

function* walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (SKIP.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.isFile() && p !== MANIFEST) yield path.relative(root, p);
  }
}
const sha = f => createHash('sha256').update(readFileSync(path.join(root, f))).digest('hex');
const lines = () => [...walk(root)].map(f => `${sha(f)}  ${f}`);

const mode = process.argv[2];
if (mode === 'write') {
  const text = `${lines().join('\n')}\n`;
  writeFileSync(MANIFEST, text);
  console.log(`${lines().length} files; manifest sha256 ${createHash('sha256').update(text).digest('hex')}`);
} else if (mode === 'verify') {
  const want = new Map(readFileSync(MANIFEST, 'utf8').split('\n').filter(Boolean).map(l => [l.slice(66), l.slice(0, 64)]));
  const have = new Map(lines().map(l => [l.slice(66), l.slice(0, 64)]));
  let bad = 0;
  for (const [f, h] of want) { if (!have.has(f)) { console.log(`MISSING  ${f}`); bad++; } else if (have.get(f) !== h) { console.log(`CHANGED  ${f}`); bad++; } }
  for (const f of have.keys()) if (!want.has(f)) { console.log(`UNLISTED ${f}`); bad++; }
  console.log(bad ? `${bad} problem(s)` : `${want.size} files verified`);
  process.exit(bad ? 1 : 0);
} else {
  console.error('usage: manifest.mjs write|verify');
  process.exit(2);
}
