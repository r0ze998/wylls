// Owner Q-WW-1 (2026-11-24 23:56): the text a wallet signs to make the Frontier's
// in-game key says "World", not "Season". The key's seed is derived from these
// bytes, so any edit changes every derived key. web-frontier-session.test.mjs pins
// the built text too, but it is a key test (manual key-tests job only); this file
// pins the source lines in the default key-free CI. It reads fsession.mjs as text
// and imports nothing from the page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../../permutation-server/web/frontier/fsession.mjs', import.meta.url), 'utf8');
const body = name => {
  const i = src.indexOf(name);
  assert.ok(i >= 0, `${name} is in fsession.mjs`);
  return src.slice(i, src.indexOf('\n}\n', i));
};

test('Q-WW-1: the signed key text (fsession.mjs sessionText) says World, in these exact lines', () => {
  const b = body('export function sessionText(');
  const want = [
    "  const text = 'Wylls wants you to create an in-game key.\\n'",
    '    + `Site: ${origin}\\n`',
    '    + `Cluster: ${cluster}\\n`',
    '    + `Program: ${programId}\\n`',
    '    + `World: ${seasonId}\\n`',
    "    + 'Anyone holding this key can act as you in this world (build, train, march, explore). It cannot move tokens from your wallet.\\n'",
    '    + `Sign only on ${host}.`;',
  ];
  const lines = b.split('\n');
  const at = lines.indexOf(want[0]);
  assert.ok(at > 0, 'the text starts with the fixed first line');
  assert.deepEqual(lines.slice(at, at + want.length), want);
  assert.doesNotMatch(b, /Season:|in this season/);
});

test('Q-WW-1: the key backup text says World; the seed domain and storage key are unchanged', () => {
  assert.match(src, /backupText: \(\) => `Wylls key\\nWorld: \$\{scope\.seasonId\}\\n/);
  assert.match(src, /'Anyone holding this key can act as you in this world\. Keep it private\.\\n'/);
  assert.doesNotMatch(body('async function sessionOf('), /Season:|in this season/);
  assert.match(src, /export const SEED_DOMAIN = 'PS\/frontier-session\/v1';/);
});
