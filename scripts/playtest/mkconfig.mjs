// Derives a rehearsal config from configs/playtest-1x.toml (PT-C): same stack, different clock, size and ports.
//
//   node scripts/playtest/mkconfig.mjs --out FILE [--run-id ID] [--scale N] [--bots N] [--port-shift K] [--days N]
//
// Only top-level keys (before the first [section]) are rewritten, plus the [ports] offsets (every offset
// moves by --port-shift, so two stacks can run side by side inside 41100-41139). Everything else (the pinned
// .so, the archive beacon, the invite gate, the G8 payer floors, the herald's tester flags) is copied.
// Use it with PLAYTEST_CONFIG=FILE PLAYTEST_DATA=DIR scripts/playtest-up.sh.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : d; };
const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = arg('src', path.join(here, '../../frontier-node/configs/playtest-1x.toml'));
const OUT = arg('out', '');
if (!OUT) { console.error('usage: mkconfig.mjs --out FILE [--run-id ID] [--scale N] [--bots N] [--port-shift K] [--days N]'); process.exit(2); }
const top = { run_id: arg('run-id', null), scale: arg('scale', null), bots: arg('bots', null), days: arg('days', null) };
const shift = Number(arg('port-shift', 0));
let section = '';
const lines = readFileSync(SRC, 'utf8').split('\n').map(line => {
  const sec = line.match(/^\[([^\]]+)\]/);
  if (sec) { section = sec[1]; return line; }
  const kv = line.match(/^([a-z_0-9]+)\s*=\s*(.*)$/);
  if (!kv) return line;
  if (section === '' && top[kv[1]] != null) return `${kv[1]} = ${kv[1] === 'run_id' ? JSON.stringify(top[kv[1]]) : Number(top[kv[1]])}`;
  if (section === 'ports' && shift) return `${kv[1]} = ${Number(kv[2]) + shift}`;
  return line;
});
for (const [i, l] of lines.entries()) if (/^base_port\s*=/.test(l) && Number(l.split('=')[1]) !== 41100) throw new Error(`unexpected base_port at line ${i + 1}`);
// every port must stay inside 41100-41139
const base = 41100;
let sec2 = '';
for (const l of lines) {
  const s = l.match(/^\[([^\]]+)\]/); if (s) { sec2 = s[1]; continue; }
  const kv = l.match(/^([a-z_0-9]+)\s*=\s*(\d+)\s*$/);
  if (sec2 === 'ports' && kv && !(base + Number(kv[2]) >= 41100 && base + Number(kv[2]) <= 41139)) throw new Error(`port ${kv[1]} = ${base + Number(kv[2])} is outside 41100-41139`);
}
writeFileSync(OUT, `${lines.join('\n')}`);
console.log(`wrote ${OUT}`);
