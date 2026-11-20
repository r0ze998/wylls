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

// (the loop-play report B5, 2026-11-18: the turn handed to the tag is the turn of the herald's own latest sample
//  (`seenBell`), not the page's extrapolated turn — a world stopped on turn 8 said "arrived on turn 10")
test('the map passes the turn the herald last reported to the away tag, never the extrapolated turn', () => {
  const src = readFileSync(new URL('../../permutation-server/web/frontier/map/fmap.mjs', import.meta.url), 'utf8');
  assert.match(src, /awayText\(B\.away\.arriveBell, Number\.isInteger\(F\.src\?\.seenBell\) \? F\.src\.seenBell : null\)/);
  assert.doesNotMatch(src, /awayText\([^)]*F\.src\.bell/);
  const app = readFileSync(new URL('../../permutation-server/web/frontier/app.mjs', import.meta.url), 'utf8');
  assert.match(app, /seenBell: seenBell\(\),/);
  assert.match(app, /function seenBell\(\) \{\n  const t = FS\.chain\?\.seen\?\.\(\) \?\? null;\n  return FS\.clock && t !== null \? bellAt\(FS\.clock\.genesisTs, t\) : null;\n\}/);
});

// reveal-under-load (verify-pr98 BREAK-2): a march whose result was not settled kept the host 'away' for 200+ turns and
// the tag said "loading its position" all along. Past the grace it says how long ago the arrival turn was, and that the
// result is not settled yet — never "loading" forever.
test('the away tag: past the grace the tag says the result is not settled yet, with the turns since the arrival', () => {
  setLang('en');
  assert.equal(H.AWAY_SETTLE_GRACE, 2);
  assert.equal(H.awayText(10, 12), 'Host arrived on turn 10 · loading its position', 'inside the grace: as before');
  assert.equal(H.awayText(10, 13), 'Host\'s arrival turn 10 was 3 turns ago · waiting for its result');
  assert.equal(H.awayText(285, 485), 'Host\'s arrival turn 285 was 200 turns ago · waiting for its result');
  setLang('ja');
  assert.equal(H.awayText(10, 13), '軍勢の到着ターン 10 から 3 ターン · 結果の確定を待っています');
  assert.equal(H.awayText(285, 485), '軍勢の到着ターン 285 から 200 ターン · 結果の確定を待っています');
  for (const lang of ['ja', 'en']) {
    setLang(lang);
    const w = H.awayText(10, 40);
    assert.ok(!/読み込んでいます|loading/i.test(w), w);
    assert.ok(!/あなたにだけ|only you/i.test(w));
    assert.ok(!/領土|領有|territor/i.test(w));
    if (lang === 'en') assert.ok(!/[぀-ヿ一-鿿]/.test(w), w);
  }
});
