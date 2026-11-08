// Source-level UI boundary tests only, not browser layout QA. No DOM execution or network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const read = f => readFile(new URL('../screens/wide-economy-local/' + f, import.meta.url), 'utf8');
test('UI keeps static local/mock warnings and independent local controls', async () => {
  const html = await read('index.html'), js = await read('local.mjs');
  assert.match(html, /LOCAL SIMULATION/); assert.match(html, /MOCK AUTH/); assert.match(html, /NO WALLET/);
  for (const action of ['harvest', 'build', 'train', 'advance', 'reset', 'refresh']) assert.ok(html.includes(`data-lx="${action}"`));
  assert.match(js, /renderHolding\(FS\)/); assert.match(js, /makeInert\(pbody\)/);
  assert.match(js, /el\.disabled = true/); assert.match(js, /removeAttribute\('href'\)/);
  assert.match(js, /stopPropagation\(\)/); assert.match(js, /replaceChildren\(p\)/);
  assert.doesNotMatch(js, /setLang\(|localStorage|sessionStorage|setInterval\(/);
  assert.doesNotMatch(js, /from ['"][^'"]*(?:controller|session|wallet|app\.mjs)/);
});

 test('Build item 8 caption matches the production workshop label and ABI maximum', async () => {
  const js = await read('local.mjs');
  const source = path => readFile(new URL('../../' + path, import.meta.url), 'utf8');
  const [abi, arms, labels] = await Promise.all([
    source('frontier-abi/src/world_index/economy.rs'),
    source('permutation-rules/src/frontier/arms.rs'),
    source('permutation-server/web/frontier/fi18n.mjs'),
  ]);
  assert.match(abi, /pub const BUILD_ITEM_MAX: u8 = ITEM_WORKSHOP;/);
  assert.match(arms, /pub const ITEM_WORKSHOP: u8 = 8;/);
  assert.match(labels, /Horses: \(\) => L`工房`/);
  const captions = /const BUILD_LABEL = \[([^\]]+)\]/.exec(js)[1].match(/'([^']*)'/g).map(s => s.slice(1, -1));
  assert.equal(captions.length, 9); assert.equal(captions[8], '工房');
});
