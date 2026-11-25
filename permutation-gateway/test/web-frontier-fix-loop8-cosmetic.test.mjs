// fix-loop8 cosmetic fixes (loop-play8 LP8-9, LP8-10):
//   LP8-9   a --demo world showed seven 「ボレアリスの新しい村」 tags over one another: new villages of one nation in one
//           province, read at once, now share one caption with their count (people/moments.mjs mergeNewVillages,
//           fx/stage.mjs MOMENT_LABEL.village), counted only from the moments in sight.
//   LP8-10  (a) the title said 「10 分ごとにターンが変わり」 at ×60 while the fast clock's pace was not known yet;
//           (b) the join line flipped 「あと約 2 時間」 → 「約 69 分」 → 「約 3 時間」: the accelerated clock's rate was
//           estimated from the last two samples. It is now taken over about a minute of samples (clock.mjs ChainClock).
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setLang } from '../../permutation-server/web/lang.mjs';
import { mergeNewVillages } from '../../permutation-server/web/frontier/people/moments.mjs';
import { playMoment } from '../../permutation-server/web/frontier/fx/stage.mjs';
import { ChainClock, pollCap, RATE_SPAN_MS } from '../../permutation-server/web/frontier/clock.mjs';
import { setTermsPace, turnLine, deadlineLine } from '../../permutation-server/web/frontier/seasonterms.mjs';

afterEach(() => { setLang('ja'); setTermsPace(null); });

const WEB = new URL('../../permutation-server/web/frontier/', import.meta.url);

// ------------------------------------------------------------------ LP8-9
const vil = (site, extra = {}) => ({ kind: 'village', p: 1, q: 0, site, tile: 10 + site, from: null, to: 1, own: false, lost: false, taken: false, ...extra });

test('LP8-9: seven new villages of one nation in one province: one caption with ×7, the rest flag-only', () => {
  const out = mergeNewVillages([0, 1, 2, 3, 4, 5, 6].map(s => vil(s)));
  assert.equal(out.length, 7, 'every village still plays (its flag goes up)');
  assert.equal(out[0].count, 7);
  assert.equal(out[0].caption, undefined);
  for (const m of out.slice(1)) { assert.equal(m.caption, false); assert.equal(m.count, undefined); }
});

test('LP8-9: other provinces, other nations, own, lost/taken and changed hands are not merged', () => {
  const list = [vil(0), vil(1, { p: 2 }), vil(2, { to: 3 }), vil(3, { own: true }), vil(4, { lost: true }), vil(5, { from: 2 }), vil(6),
    { kind: 'built', p: 1, q: 0, site: 7, tile: 3 }];
  const out = mergeNewVillages(list);
  assert.equal(out[0].count, 2, 'the two plain new ones of nation 1 in (1,0)');
  assert.equal(out[6].caption, false);
  for (const i of [1, 2, 3, 4, 5, 7]) assert.deepEqual(out[i], list[i], `#${i} unchanged`);
  const one = [vil(0)];
  assert.deepEqual(mergeNewVillages(one), one, 'a lone new village keeps its plain caption');
});

test('LP8-9: fog — the count is only of what the page passes (the moments in sight); app.mjs merges after the fog cut', () => {
  // three in sight of seven: the page passed three, the caption says three
  assert.equal(mergeNewVillages([vil(0), vil(1), vil(2)])[0].count, 3);
  const app = readFileSync(new URL('app.mjs', WEB), 'utf8');
  const cut = app.indexOf("    if (!own && !taken && !viewTile(m.p, m.q, m.tile)) continue;\n    shown.push({ ...m, lost, taken, own });");
  const merge = app.indexOf("  for (const m of mergeNewVillages(shown)) fxEmit('moment', m);");
  assert.ok(cut > 0 && merge > cut, 'the fog cut, then the merge');
});

function fakeFx() {
  const plays = [], hushed = [];
  return { plays, hushed, fx: { play: (name, a) => { plays.push([name, a]); return []; }, hush: (at, s) => hushed.push(s), sound() {}, shake() {}, motionLevel: () => 'off', map: null } };
}

test('LP8-9: the stage says the count on the one caption and none on the others', () => {
  setLang('ja');
  const [first, second] = mergeNewVillages([vil(0), vil(1), vil(2), vil(3), vil(4), vil(5), vil(6)]);
  let f = fakeFx();
  playMoment(f.fx, first);
  const tags = f.plays.filter(([n]) => n === 'tag');
  assert.equal(tags.length, 1);
  assert.equal(tags[0][1].text, 'ボレアリスの新しい村 ×7');
  f = fakeFx();
  playMoment(f.fx, second);
  assert.equal(f.plays.filter(([n]) => n === 'tag').length, 0, 'no caption of its own');
  assert.ok(f.plays.some(([n]) => n === 'raise'), 'its flag still goes up');
  assert.ok(f.hushed.length > 0, 'its labels still make way');
  f = fakeFx();
  playMoment(f.fx, vil(0));
  assert.equal(f.plays.find(([n]) => n === 'tag')[1].text, 'ボレアリスの新しい村', 'a lone one: no count');
});

// ------------------------------------------------------------------ LP8-10 (a)
test('LP8-10a: a fast clock whose pace is not known yet says game time only, and is read every 2 s until known', () => {
  setLang('ja');
  setTermsPace(() => null);
  assert.equal(turnLine(), 'ゲーム内の 10 分');
  setTermsPace(() => 60);
  assert.equal(turnLine(), 'ゲーム内の 10 分（この世界では実時間で約 10 秒）');
  setTermsPace(() => 1);
  assert.equal(turnLine(), '10 分');
  let wall = 1_000_000;
  const c = new ChainClock({ wall: () => wall });
  assert.equal(c.rateKnown, true, 'a real cluster: rate 1 is known');
  c.setAccelerated(true);
  assert.equal(c.rateKnown, false);
  assert.equal(pollCap(c), 2, 'unknown pace: fast poll');
  c.observe(5000, 1);
  wall += 2500;
  c.observe(5150, 2);
  assert.equal(c.rateKnown, true);
  assert.equal(c.rate, 60);
  assert.equal(pollCap(c), 2.5, 'then a quarter of a turn as before');
  const d = new ChainClock({ accelerated: true });
  d.declare(30);
  assert.equal(d.rateKnown, true, 'a declared rate is known at once');
});

test('LP8-10a: the title and the deadline line do not claim a real time before the pace is known', () => {
  setLang('ja');
  setTermsPace(() => null);
  const FS = { season: { genesisTs: 0, endBell: 2016, joinCloseBell: 1512 }, clock: { genesisTs: 0 }, chain: { now: () => 100 * 600 + 30 } };
  assert.equal(deadlineLine(FS), '', 'no 「あと約」 from an unknown pace');
  const closed = { ...FS, chain: { now: () => 1600 * 600 } };
  assert.match(deadlineLine(closed), /^参加の受付は第1,512ターンで締め切られました。/, 'a closed join is still said');
  setTermsPace(() => 60);
  assert.match(deadlineLine(FS), /あと約 4 時間/);
});

// ------------------------------------------------------------------ LP8-10 (b)
// A herald at ×60 answering every 2.5 s, its samples 0–2 s stale and sometimes the same sample again: the pace the
// page reads settles near 60, and the join line stops flipping once the first minute has been read.
test('LP8-10b: a jittery herald no longer swings the pace; the join line holds', () => {
  setLang('ja');
  let wall = 1_000_000;
  const RATE = 60, GEN = 0, startChain = 143 * 600;
  const trueChain = () => startChain + (wall - 1_000_000) / 1000 * RATE;
  const c = new ChainClock({ wall: () => wall, accelerated: true });
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  let slot = 1, held = null, repeats = 0;
  const rates = [], lines = [];
  setTermsPace(() => (c.rateKnown === false ? null : c.rate));
  const FS = { season: { genesisTs: GEN, endBell: 1008, joinCloseBell: 756 }, clock: { genesisTs: GEN }, chain: c };
  for (let i = 0; i < 160; i++) {
    wall += 2500;
    // the herald reads the chain every few seconds; between its reads it answers the same sample again (at most twice)
    const fresh = held === null || repeats >= 2 || rnd() < 0.6;
    repeats = fresh ? 0 : repeats + 1;
    if (fresh) held = Math.floor(trueChain() - rnd() * 2 * RATE);
    c.observe(held, slot++);
    if (wall - 1_000_000 >= RATE_SPAN_MS + 5000) { rates.push(c.rate); lines.push(deadlineLine(FS).match(/参加の受付は第756ターンまで（あと約 ([^）]+)）/)?.[1]); }
  }
  const lo = Math.min(...rates), hi = Math.max(...rates);
  assert.ok(lo > RATE * 0.9 && hi < RATE * 1.1, `pace stays within 10 % of ×60 (${lo.toFixed(1)}–${hi.toFixed(1)})`);
  // (the time left shrinks as the world goes on; it never jumps to another scale: 「約 69 分」 or 「約 3 時間」 between hours)
  // (fix-loop17 LP17-7: between an hour and a half and two days the time left is said to ten minutes — 「1 時間 40 分」)
  for (const l of lines) assert.match(l, /^[12] 時間( [1-5]0 分)?$|^\d+ 分$/);
  const hours = lines.map(l => { const m = /^(\d+) 時間(?: (\d+) 分)?$/.exec(l); return m ? Number(m[1]) * 60 + Number(m[2] ?? 0) : Number(l.split(' ')[0]); });
  for (let i = 1; i < hours.length; i++) assert.ok(hours[i] <= hours[i - 1], `never goes back up: ${lines[i - 1]} → ${lines[i]}`);
});

test('LP8-10b: a world paused (chain stands) and resumed is not read as slow', () => {
  let wall = 1_000_000;
  const c = new ChainClock({ wall: () => wall, accelerated: true });
  let chain = 5000, slot = 1;
  for (let i = 0; i < 20; i++) { c.observe(chain, slot++); wall += 2500; chain += 150; }
  assert.equal(c.rate, 60);
  for (let i = 0; i < 16; i++) { c.observe(chain, slot++); wall += 2500; }   // 40 s standing
  assert.equal(c.rate, 60, 'a standing chain does not drive the rate down');
  for (let i = 0; i < 4; i++) { chain += 150; c.observe(chain, slot++); wall += 2500; }
  assert.ok(Math.abs(c.rate - 60) < 1e-9, `resumed at ×60: ${c.rate}`);
});
