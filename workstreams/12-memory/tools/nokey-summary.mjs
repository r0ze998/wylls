// Reads node --test TAP on stdin and sorts each test into ran / needs-key / FAILED / skipped (see test-nokey.sh).
// With NOKEY_STRICT=1 (the audited list) any needs-key is a failure: a listed test must never reach a key operation.
import { readFileSync } from 'node:fs';
const lines = readFileSync(0, 'utf8').split('\n');
const out = { ran: [], 'needs-key': [], FAILED: [], skipped: [] };
let file = null;
for (let i = 0; i < lines.length; i++) {
  const l = lines[i];
  if (l.startsWith('@@file ')) { file = l.slice(7); continue; }
  const m = /^(\s*)(not ok|ok) \d+ - (.*?)(\s+# SKIP.*)?$/.exec(l);
  if (!m || m[1].length) continue; // top-level tests only
  const name = `${file ?? '?'}: ${m[3]}`;
  if (m[4]) { out.skipped.push(`${name}${m[4]}`); continue; }
  if (m[2] === 'ok') { out.ran.push(name); continue; }
  let j = i + 1, block = '';
  while (j < lines.length && !/^\s*(not ok|ok) \d+ - /.test(lines[j])) block += lines[j++] + '\n';
  (/nokey: /.test(block) ? out['needs-key'] : out.FAILED).push(name);
}
for (const k of ['ran', 'needs-key', 'skipped', 'FAILED']) console.log(`# ${k}: ${out[k].length}`);
for (const k of ['needs-key', 'skipped', 'FAILED']) for (const n of out[k]) console.log(`${k}\t${n}`);
if (process.env.NOKEY_LIST_RAN) for (const n of out.ran) console.log(`ran\t${n}`);
process.exit(out.FAILED.length || (process.env.NOKEY_STRICT && out['needs-key'].length) ? 1 : 0);
