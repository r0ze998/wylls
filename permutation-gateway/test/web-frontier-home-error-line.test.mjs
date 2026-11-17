// The plate's waiting line (hud/hud.mjs waitingLine) says a first village's failure in the wait view's own words: the
// planner's sentence when it gave one (no legal place → NoFreeHome; a read that failed → Unavailable), never a raw
// "Unknown error (NoFreeHome)" (seen in a local conquest-preset world, 2026-11-15). Pure; no network, no key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as hud from '../../permutation-server/web/frontier/hud/hud.mjs';
import { setLang, L } from '../../permutation-server/web/lang.mjs';

const fs = error => ({ season: { programVersion: 2 }, land: { stage: 'none' }, citizen: { flags: 0 }, homeChoice: { error } });

test('the planner\'s own sentence is the plate\'s line: no legal place and a failed read stay distinct; no "Unknown error"', () => {
  for (const lang of ['ja', 'en']) {
    setLang(lang);
    const none = L`入植できる土地がまだ見つかりません。候補を更新してください。`, failed = L`土地の情報を読み込めませんでした。もう一度お試しください。`;
    const a = String(hud.waitingLine(fs({ code: 'NoFreeHome', text: none })));
    const b = String(hud.waitingLine(fs({ code: 'Unavailable', text: failed })));
    assert.equal(a, none, `${lang}: NoFreeHome`); assert.equal(b, failed, `${lang}: Unavailable`);
    assert.notEqual(a, b);
    assert.doesNotMatch(a, /Unknown error|不明なエラー|NoFreeHome/, `${lang}: never the raw code`);
  }
  setLang('ja');
});

test('an error without a sentence still falls back to the common failure text', () => {
  setLang('ja');
  assert.match(String(hud.waitingLine(fs({ code: 'Unavailable' }))), /\S/);
  assert.equal(String(hud.waitingLine(fs({ code: 'SomeCode' }))), String(hud.waitingLine(fs({ code: 'SomeCode', text: undefined }))));
});
