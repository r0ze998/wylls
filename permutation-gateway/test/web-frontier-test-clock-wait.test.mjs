// The march card's wait in a TEST-ONLY capture-demo world (synthetic clock ×30): in trial 2 (2026-11-14) the order card said
// 「到着 ターン 25 / 約 37 分後」 in game minutes while the arrival came about a minute later on the wall. With the launcher's
// checked scale on `FS.localPlay.clockScale` (flocalplay.mjs, only for a capture-demo start) the wait is said in the wall's
// time and named the test clock. Every other world keeps its game minutes, word for word.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setLang } from '../../permutation-server/web/lang.mjs';
import { waitWords } from '../../permutation-server/web/frontier/hud/marchcard.mjs';

afterEach(() => setLang('ja'));
const CJK = /[぀-ヿ㐀-鿿]/;
const BANNED_EN = /\bbell \d|\bsecret|beacon|\bsettle[ds]?\b|settlement|\bseed\b|site ticket|keeper|lamport/i;
const WEB = new URL('../../permutation-server/web/frontier/', import.meta.url);

test('a natural world (no scale) says the game minutes exactly as before', () => {
  for (const lp of [undefined, null, {}, { clockScale: 1 }, { clockScale: '30' }, { clockScale: 2.5 }]) {
    const FS = { localPlay: lp };
    assert.equal(waitWords(FS, 2220), '約 37 分後');
    assert.equal(waitWords(FS, 10), '約 1 分後', 'at least one minute, as before');
  }
  assert.equal(waitWords(undefined, 600), '約 10 分後');
});

test('a ×30 test world says the wall time on the test clock', () => {
  const FS = { localPlay: { clockScale: 30 } };
  assert.equal(waitWords(FS, 2220), '試験の時計で約 74 秒後', '37 game minutes are 74 wall seconds');
  assert.equal(waitWords(FS, 2400 * 3), '試験の時計で約 4 分後', '120 game minutes are 4 wall minutes');
  assert.equal(waitWords(FS, 0), '試験の時計で約 1 秒後');
  assert.equal(waitWords({ localPlay: { clockScale: 10 } }, 600), '試験の時計で約 60 秒後');
});

test('English: no Japanese, no banned word', () => {
  setLang('en');
  assert.equal(waitWords({ localPlay: { clockScale: 30 } }, 2220), 'in about 74 s on the test clock');
  assert.equal(waitWords({ localPlay: { clockScale: 30 } }, 7200), 'in about 4 min on the test clock');
  assert.equal(waitWords({}, 2220), 'in about 37 min');
  for (const s of [waitWords({ localPlay: { clockScale: 30 } }, 2220), waitWords({ localPlay: { clockScale: 30 } }, 7200)]) { assert.doesNotMatch(s, CJK, s); assert.doesNotMatch(s, BANNED_EN, s); }
});

test('the scale reaches the page only from a capture-demo start, and both card waits use it', () => {
  const gate = readFileSync(new URL('flocalplay.mjs', WEB), 'utf8');
  assert.match(gate, /const playedAs = launcher && claimedDemo !== null \? Object\.freeze\(\{ \.\.\.played, clockScale: claimedDemo, \.\.\.\(endAt !== null \? \{ worldEndsAt: endAt \} : \{\}\) \}\) : played;/);
  assert.match(gate, /localPlay: playedAs \}/);
  assert.match(gate, /claimedDemo = launcherCaptureDemo\(body\?\.captureDemo\);/, 'the scale is the checked start answer (10..60)');
  const card = readFileSync(new URL('hud/marchcard.mjs', WEB), 'utf8');
  assert.match(card, /const awayLine = !FS\.proto \? \(awaySecs !== null \? waitWords\(FS, awaySecs\) : ''\)/);
  assert.match(card, /: !FS\.proto \? waitWords\(FS, timing\.resultIn\)/);
  assert.doesNotMatch(card, /L`約 \$\{fmtNum\(away\)\} 分後`/, 'no second copy of the old wording');
});
