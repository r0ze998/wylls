// The play screen's build, training and march text in English: Lane D round 4 of
// docs/integration/CLAUDE-LANE-D-ENGLISH-AUDIT-20261116.md. Each fixed entry is checked through the real L`` lookup
// with values, the way its screen calls it, and the Japanese key is checked to be still in that screen's source
// (so a changed callsite fails here instead of leaving a dead entry):
//  - s1.mjs NoHostHere / NoFighterHere: 着いて落ち着いた is a host standing on the tile, never "settled" (banned);
//  - host.mjs PENDING_TEXT 5: 決着のあと is after the turn is resolved, not "after the clash" (there may be none);
//  - holding.mjs promotionRow: 建設 N つ is how many builds the tier runs at once, not "{2} under way", and
//    村のまわり N マス is the village's land N tiles around it.
// Pure: it imports lang.mjs and reads source text only.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { L, EN, setLang } from '../../permutation-server/web/lang.mjs';

afterEach(() => setLang('ja'));

const src = rel => readFileSync(new URL(`../../permutation-server/web/frontier/${rel}`, import.meta.url), 'utf8');
const en = fn => { setLang('en'); return fn(); };

test('round 4: the siege and structure blocks say the host is standing on the tile', () => {
  const s1 = src('screens/s1.mjs');
  assert.ok(s1.includes('このマスに、着いて落ち着いたあなたの軍勢がいません（進軍で送り、次のターンを待ってください）'));
  assert.ok(s1.includes('この村のマスに、着いて落ち着いたあなたの戦う軍勢（斥候以外）がいません。進軍で送り、守りに勝ってから包囲を宣言します'));
  assert.equal(en(() => L`このマスに、着いて落ち着いたあなたの軍勢がいません（進軍で送り、次のターンを待ってください）`),
    'No host of yours has arrived and is standing on this tile (march one here and wait for the next turn)');
  assert.equal(en(() => L`この村のマスに、着いて落ち着いたあなたの戦う軍勢（斥候以外）がいません。進軍で送り、守りに勝ってから包囲を宣言します`),
    'No fighting host of yours (not a scout) has arrived and is standing on this village\'s tile. March one here, win against its defence, then declare the siege');
});

test('round 4: a dissolving host returns after the turn is resolved', () => {
  assert.ok(src('screens/host.mjs').includes('解散待ち（決着のあと控えに戻る）'));
  assert.equal(en(() => L`解散待ち（決着のあと控えに戻る）`), 'Dissolving (back to the reserve after the turn is resolved)');
});

test('round 4: the promotion row names build slots and the village\'s land, with plurals', () => {
  assert.ok(src('screens/holding.mjs').includes('L`産出 +${p.gives.prodPct[1]}% · 蔵 ${fmtNum(p.gives.cap[1])} · 建設 ${p.gives.slots[1]} つ · 村のまわり ${p.gives.radius[1]} マス`'));
  const row = (pct, cap, slots, radius) => L`産出 +${pct}% · 蔵 ${cap} · 建設 ${slots} つ · 村のまわり ${radius} マス`;
  assert.equal(en(() => row(10, '1,200', 2, 3)), 'Production +10% · stores 1,200 · 2 builds at once · land 3 tiles around the village');
  assert.equal(en(() => row(5, '800', 1, 1)), 'Production +5% · stores 800 · 1 build at once · land 1 tile around the village');
  setLang('ja');
  assert.equal(row(10, '1,200', 2, 3), '産出 +10% · 蔵 1,200 · 建設 2 つ · 村のまわり 3 マス');
});

test('no English for 着いて落ち着いた says "settled", and 決着のあと never becomes "after the clash"', () => {
  const bad = [];
  for (const [ja, e] of Object.entries(EN)) {
    if (typeof e !== 'string') continue;
    if (/落ち着/.test(ja) && /\bsettle[ds]?\b/i.test(e)) bad.push(`${ja} → ${e}`);
    if (/決着のあと/.test(ja) && !/衝突|戦/.test(ja) && /after the clash/i.test(e)) bad.push(`${ja} → ${e}`);
  }
  assert.deepEqual(bad, []);
});
