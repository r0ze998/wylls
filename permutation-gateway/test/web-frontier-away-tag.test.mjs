// Round 48 (reported from the land2 test world, 2026-11-15): the map's tag by a village whose host is away still said
// "Its host is on the march · arrives on turn 10" at turn 12. The herald's roster of that province had the host standing
// on its destination from turn 10 (state 1, tile 39); the page drew from an older reading of it. The tag no longer
// promises an arrival turn that has passed: from the turn after it, it says the host arrived and that where it stands
// is being read. Before and on the arrival turn it is as before.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setLang } from '../../permutation-server/web/lang.mjs';
import * as H from '../../permutation-server/web/frontier/map/hostmarks.mjs';

afterEach(() => setLang('ja'));

test('the away tag: an arrival turn that has passed is not promised again', () => {
  setLang('en');
  assert.equal(H.awayText(10, 9), 'Its host is on the march · arrives on turn 10');
  assert.equal(H.awayText(10, 10), 'Its host is on the march · arrives on turn 10', 'on the arrival turn itself: as before');
  assert.equal(H.awayText(10, 12), 'Host arrived on turn 10 · loading its position');
  assert.equal(H.awayText(10), 'Its host is on the march · arrives on turn 10', 'without the turn now: as before');
  assert.equal(H.awayText(null, 12), 'Its host is on the march');
  setLang('ja');
  assert.equal(H.awayText(10, 12), '軍勢はターン 10 に到着 · 位置を読み込んでいます');
  assert.equal(H.awayText(10, 10), '軍勢は進軍中 · ターン 10 に到着');
});

test('the passed-arrival words keep the board\'s rules: public (not "only you"), never territory, English without Japanese', () => {
  for (const lang of ['ja', 'en']) {
    setLang(lang);
    const w = H.awayText(10, 12);
    assert.ok(!/あなたにだけ|only you/i.test(w));
    assert.ok(!/領土|領有|territor/i.test(w));
    if (lang === 'en') assert.ok(!/[぀-ヿ一-鿿]/.test(w), w);
  }
});

test('the map passes the turn now to the away tag', () => {
  const src = readFileSync(new URL('../../permutation-server/web/frontier/map/fmap.mjs', import.meta.url), 'utf8');
  assert.match(src, /awayText\(B\.away\.arriveBell, Number\.isInteger\(F\.src\?\.bell\) \? F\.src\.bell : null\)/);
});
