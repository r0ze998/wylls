// Workstream 07: the help's words on when this device opens its own seal follow the rule the page's march book carries.
// Workstream 18's change (b71b8197, as workstream 16 verified it: verification/16-independent/REPORT.ja.md §12.5) adds
// REVEAL_PUBLISH_MARGIN and `notBefore` to marchbook.mjs: the device opens only after the round that opens the seal is
// published. Without it (this base, cf517b55) the device may open the seal as the arrival turn begins. No key is used.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as mb from '../../permutation-server/web/frontier/marchbook.mjs';
import { TERMS, selfOpenLine } from '../../permutation-server/web/frontier/hud/glossary.mjs';
import { setLang } from '../../permutation-server/web/lang.mjs';

test('the help says the rule this page carries — and both rules have their words in both languages', () => {
  setLang('ja');
  const after = typeof mb.REVEAL_PUBLISH_MARGIN === 'number';
  assert.match(TERMS.seal.text(), after ? /封を開ける鍵が出たあと、あなたの端末が自分の封を開けます/ : /到着のターンが始まると、あなたの端末が先に封を開けることがあります/);
  assert.equal(TERMS.seal.text().endsWith(selfOpenLine()), true);
  const src = readFileSync(new URL('../../permutation-server/web/frontier/hud/glossary.mjs', import.meta.url), 'utf8');
  assert.match(src, /typeof marchbook\.REVEAL_PUBLISH_MARGIN === 'number'/, 'the switch is the march book\'s own export');
  const en = readFileSync(new URL('../../permutation-server/web/lang/en-frontier-play.mjs', import.meta.url), 'utf8');
  for (const k of ['到着のターンが始まると、あなたの端末が先に封を開けることがあります。', '到着のターンが終わって封を開ける鍵が出たあと、あなたの端末が自分の封を開けます。']) assert.ok(en.includes(`'${k}`), k);
  setLang('en');
  assert.doesNotMatch(TERMS.seal.text(), /[぀-ヿ一-鿿]/);
  setLang('ja');
});
