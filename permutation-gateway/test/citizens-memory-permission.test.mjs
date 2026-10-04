// The memory and persona modules load under the Node permission model with exactly the read list below (the list the
// citizens service pins, contract §1.3 C1) and nothing else; a read outside it is refused.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const READ = [
  'permutation-gateway/citizens/memory', 'permutation-gateway/citizens/persona',
  'permutation-server/web/frontier/fcodec.mjs', 'permutation-server/web/frontier/abi.mjs',
  'permutation-server/web/frontier/people/identity.mjs', 'permutation-server/web/lang.mjs', 'permutation-server/web/lang', 'permutation-server/web/util.mjs',
];
const run = code => spawnSync(process.execPath, ['--experimental-permission', ...READ.map(p => `--allow-fs-read=${ROOT}${p}`), '--input-type=module', '-e', code], { encoding: 'utf8' });

test('permission model: store, render, cards, goals, deal load with the pinned read list only', () => {
  const r = run(`
    const base = ${JSON.stringify(ROOT)} + 'permutation-gateway/citizens/';
    for (const f of ['memory/store.mjs', 'memory/render.mjs', 'memory/cards.mjs', 'memory/episodes.mjs', 'persona/goals.mjs', 'persona/deal.mjs', 'persona/render.mjs']) await import(base + f);
    const { nameOf } = await import(base + 'persona/names.mjs');
    console.log(JSON.stringify(nameOf(1000n)));
  `);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout.trim()), { en: 'Misaya', ja: 'ミサヤ' });
});

test('permission model: a read outside the list (a key-like config file) is refused with ERR_ACCESS_DENIED', () => {
  const r = run(`
    const fs = await import('node:fs');
    try { fs.readFileSync(${JSON.stringify(`${ROOT}permutation-gateway/package.json`)}); console.log('READ'); } catch (e) { console.log(e.code); }
  `);
  assert.equal(r.stdout.trim(), 'ERR_ACCESS_DENIED', r.stderr);
});
