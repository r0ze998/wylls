// The walletless demo's single-player goal (demo-solo-goal; owner r0ze 2026-11-28 14:32, Option A "本番の縮小版"): the
// compressed flag-keeps rule (screens/demogoal.mjs) against the real judge (src/frontier/world-goals.mjs), the sample
// world's castles, waves and result (liveworld `goal`), and the page's words. Keyless: the keyless viewer, nothing is
// signed, no key is derived (the player's orders go through the world's own instructions: `order`, `testPlay`).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as W from '../screens/world.mjs';
import { createLive } from '../screens/liveworld.mjs';
import * as G from '../screens/demogoal.mjs';
import * as REAL from '../src/frontier/world-goals.mjs';
import { ringOf, wedgeOf } from '../../permutation-server/web/frontier/fgeo.mjs';
import EN from '../../permutation-server/web/lang/en-frontier-play.mjs';
import { createClock } from '../demo/src/save.mjs';

const src = f => readFileSync(new URL(f, import.meta.url), 'utf8');
const world = async ({ wall, goal = true, ...opts } = {}) => createLive({ viewer: await W.viewer({ keyless: true }), keyless: true, stage: 'none', opening: true, territory: true, nations: true, landUpkeep: true,
  turn: 12, delay: 3, landMs: 400, wall, goal, ...opts });
const hand = () => { let real = 1_000_000; return { wall: () => real, move: ms => { real += ms; } }; };
/** A world joined by the keyless viewer as `nation`, its clock at mid-turn. */
async function joined(nation = 1, opts = {}) {
  const c = hand(), live = await world({ wall: c.wall, ...opts });
  live.seen(); c.move(4_000); live.clock();
  const j = live.testPlay.join(nation);
  assert.equal(j.ok, true, JSON.stringify(j));
  c.move(6_000); live.clock();   // (mid-turn from now on: after the turn's resolve, as a player acts)
  return { live, c, turns: n => { for (let i = 0; i < n; i++) { c.move(12_000); live.clock(); } } };
}
const lcg = seed => () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);

test('the rule is the real flag-keeps judge: need, counting, progress and achievement agree with world-goals.mjs', () => {
  for (let k = 0; k <= 14; k++) for (let own = 0; own <= 3; own++) assert.equal(G.needOf(k, { need: null }, own), REAL.needOf(k, { need: null }, own), `need of ${k} (own ${own})`);
  assert.equal(G.needOf(6, G.DEMO_GOAL, 1), 3, 'six castles, one a nation: need 3 ("half of all" = ceil(6/2))');
  assert.equal(Math.ceil(5 / 2), 3, '"half of the rivals\' castles" = ceil(5/2) = 3 too: the two readings agree at one castle a nation');
  const rnd = lcg(7);
  for (let i = 0; i < 400; i++) {
    const castles = Array.from({ length: 6 }, (_, n) => ({ nation: n, p: n, q: -n, tile: 30, holder: rnd() < 0.15 ? 255 : Math.floor(rnd() * 6), since: Math.floor(rnd() * 60) }));
    const posted = Math.floor(rnd() * 30), bell = posted + Math.floor(rnd() * 60), hold = 1 + Math.floor(rnd() * 25);
    const rules = { ...G.DEMO_GOAL, holdBells: hold };
    const mine = G.progressOf({ castles, bell, postedBell: posted, rules });
    const real = REAL.progressOf({ flags: castles.map(c => ({ p: c.p, q: c.q, nation: c.nation })), keeps: castles.map(c => ({ p: c.p, q: c.q, holder: c.holder, since: c.since })), bell, postedBell: posted, rules: { ...REAL.FLAG_KEEPS_DEFAULTS, holdBells: hold } });
    assert.deepEqual(mine.map(x => [x.nation, x.held, x.own, x.captured, x.capturedLong, x.need, x.reachAt]), real.map(x => [x.nation, x.held, x.own, x.captured, x.capturedLong, x.need, x.reachAt]), `case ${i}`);
    assert.deepEqual(G.achievementOf(mine, bell), REAL.achievementOf(real, bell), `achievement ${i}`);
  }
});

test('hold timers: a captured castle counts from max(since, posted), is held long holdBells later; a capture resets it; own castles never count', () => {
  const rules = { ...G.DEMO_GOAL, holdBells: 20 };
  const base = Array.from({ length: 6 }, (_, n) => ({ nation: n, p: n, q: 0, tile: 30, holder: n, since: 40 }));
  const at = (castles, bell) => G.progressOf({ castles, bell, postedBell: 50, rules }).find(x => x.nation === 1);
  // nation 1 took castles 0 and 2 at 60 and 65, and castle 3 at 70; its own castle 1 never counts
  const took = base.map(c => (c.nation === 0 ? { ...c, holder: 1, since: 60 } : c.nation === 2 ? { ...c, holder: 1, since: 65 } : c.nation === 3 ? { ...c, holder: 1, since: 70 } : c));
  let p = at(took, 79);
  assert.deepEqual([p.held, p.own, p.captured, p.capturedLong, p.reachAt], [4, 1, 3, 0, 90]);
  assert.equal(G.achievementOf(G.progressOf({ castles: took, bell: 89, postedBell: 50, rules }), 89), null, 'not before the third hold ends');
  assert.deepEqual(G.achievementOf(G.progressOf({ castles: took, bell: 90, postedBell: 50, rules }), 90), { bell: 90, nations: [1] });
  // a castle taken before the posting counts from the posting
  assert.equal(at(base.map(c => (c.nation === 0 ? { ...c, holder: 1, since: 10 } : c)), 55).castles[0].from, 50);
  // castle 2 lost at 80 and taken back at 84: its timer starts again
  const back = took.map(c => (c.nation === 2 ? { ...c, holder: 1, since: 84 } : c));
  p = at(back, 90);
  assert.equal(p.reachAt, 104, 'the retaken castle holds from 84: 84 + 20');
  assert.equal(G.achievementOf(G.progressOf({ castles: back, bell: 90, postedBell: 50, rules }), 90), null);
  // recapturing one's own castle does not count (flag-keeps-v2)
  assert.equal(at(base.map(c => (c.nation === 1 ? { ...c, since: 70 } : c)), 200).captured, 0);
});

test('win and loss: the player\'s nation reaching the goal is a win, another nation first a loss, the same turn a win (a tie)', () => {
  assert.deepEqual(G.resultOf({ bell: 90, nations: [1] }, 1), { state: 'won', bell: 90, nations: [1] });
  assert.deepEqual(G.resultOf({ bell: 88, nations: [3] }, 1), { state: 'lost', bell: 88, nations: [3] });
  assert.deepEqual(G.resultOf({ bell: 90, nations: [1, 3] }, 1), { state: 'won', bell: 90, nations: [1, 3] });
  assert.deepEqual(G.resultOf({ bell: 90, nations: [0, 1] }, 1), { state: 'won', bell: 90, nations: [0, 1] }, 'a tie with a nation before yours too');
  assert.equal(G.resultOf(null, 1), null);
});

test('the AI\'s targets: the leader races (retake, stop a rival one short, hold, capture); the others retake and raid the player', () => {
  const castles = Array.from({ length: 6 }, (_, n) => ({ nation: n, p: n, q: 0, tile: 30, holder: n, since: 40 }));
  const prog = cs => G.progressOf({ castles: cs, bell: 100, postedBell: 50 });
  const dist = c => Math.abs(c.nation - 3);
  const T = (cs, n, extra = {}) => G.waveTarget({ castles: cs, progress: prog(cs), n, player: 1, leader: 3, dist, ...extra });
  assert.deepEqual(T(castles, 3).castles.map(c => c.nation), [2, 4, 1, 5, 0], 'leader: the nearest castles not its own (the player\'s first on a tie)');
  assert.equal(T(castles, 3).kind, 'capture');
  const lost = castles.map(c => (c.nation === 3 ? { ...c, holder: 1, since: 90 } : c));
  assert.deepEqual([T(lost, 3).kind, T(lost, 3).castles[0].nation], ['retake', 3]);
  const near = castles.map(c => (c.nation === 0 || c.nation === 5 ? { ...c, holder: 1, since: c.nation === 0 ? 70 : 80 } : c));
  assert.deepEqual([T(near, 3).kind, T(near, 3).castles[0].nation], ['stop-rival', 0], 'the player one short: the castle whose hold ends first');
  const race = castles.map(c => (c.nation === 0 || c.nation === 2 || c.nation === 4 ? { ...c, holder: 3, since: 90 } : c));
  const t = G.waveTarget({ castles: race, progress: prog(race), n: 3, player: 1, leader: 3, dist, strength: c => (c.nation === 4 ? 100 : 500) });
  assert.deepEqual([t.kind, t.castles[0].nation], ['reinforce', 4], 'with the need in hand the leader strengthens its weakest castle');
  assert.deepEqual([T(castles, 5).kind, T(castles, 5).castles.map(c => c.nation)], ['raid', [1]], 'another AI raids the player\'s castles: its own nation\'s first (the world adds a tile of the player\'s land after them)');
  const none = castles.map(c => (c.nation === 1 ? { ...c, holder: 4, since: 90 } : c));
  assert.deepEqual([T(none, 5).kind, T(none, 5).castles.length], ['raid', 0], 'the player holds no castle: its land only');
  const mine = castles.map(c => (c.nation === 0 ? { ...c, holder: 1, since: 70 } : c));
  assert.deepEqual([T(mine, 5).kind, T(mine, 5).castles.map(c => c.nation)], ['raid', [1, 0]], 'another AI raids the player\'s castles, nearest first');
  assert.equal(G.leaderOf(1), 3); assert.notEqual(G.leaderOf(4), 4);
  assert.equal(G.waveAt(G.DEMO_GOAL.graceBells - 1), null); assert.equal(G.waveAt(G.DEMO_GOAL.graceBells), 0); assert.equal(G.waveAt(G.DEMO_GOAL.graceBells + G.DEMO_GOAL.waveEvery), 1);
  assert.ok(G.waveTroops(5) > G.waveTroops(0) && G.waveTroops(100) === G.DEMO_GOAL.waveCap, 'waves grow, capped');
});

test('the world: six flag castles, one in each nation\'s ring-1 province, guarded; posted when the player places its village; off by default', async () => {
  const c = hand(), live = await world({ wall: c.wall });
  const g = live.goal();
  assert.equal(g.castles.length, 6);
  for (const k of g.castles) {
    assert.equal(ringOf(k.p, k.q), 1); assert.equal(wedgeOf(k.p, k.q), k.nation);
    assert.equal(k.holder, k.nation, 'each castle starts its own nation\'s');
    const guard = live.province(k.p, k.q).entries.filter(e => e.state === 1 && e.tile === k.tile);
    assert.deepEqual(guard.map(e => [e.faction, e.troops]), [[k.nation, G.DEMO_GOAL.guardTroops * 1000]], 'one guard of its nation');
  }
  assert.equal(g.need, 3); assert.equal(g.posted, null); assert.deepEqual(g.progress, []); assert.equal(g.result, null);
  assert.deepEqual(live.herald('/h/season', new URL('http://x/h/season')).body.sample.goal, { kind: 'flag-castles', perNation: 1, need: 3, holdBells: G.DEMO_GOAL.holdBells });
  assert.equal(live.herald('/h/demo/goal', new URL('http://x/h/demo/goal')).body.kind, 'demo-goal');
  const off = await world({ wall: hand().wall, goal: false });
  assert.equal(off.goal, null); assert.equal(off.summary().goal, undefined);
  assert.equal(off.herald('/h/season', new URL('http://x/h/season')).body.sample.goal, undefined);
  assert.equal(off.herald('/h/demo/goal', new URL('http://x/')), null);
  // (goal off: the castles' tiles have no guards: the world every other caller makes is unchanged)
  assert.ok(g.castles.every(k => !off.province(k.p, k.q).entries.some(e => e.state === 1 && e.tile === k.tile && e.troops === G.DEMO_GOAL.guardTroops * 1000)));
  const { live: j } = await joined(1);
  assert.equal(j.goal().player, 1); assert.equal(j.goal().posted, j.turn());
});

test('the AI cannot win at once: no wave before the grace ends, no result before grace + hold; an idle player loses later to the leader', async () => {
  const { live, turns } = await joined(2);
  const g0 = live.goal(), earliest = g0.posted + G.DEMO_GOAL.graceBells + G.DEMO_GOAL.holdBells;
  turns(G.DEMO_GOAL.graceBells - 1);
  assert.equal(live.goalLog().filter(x => x.kind === 'wave').length, 0, 'no wave in the grace');
  let res = null, n = 0;
  while (!res && n++ < 200) { turns(1); res = live.goal().result; if (!res) continue; }
  assert.ok(res, 'an idle player loses within 200 turns');
  assert.equal(res.state, 'lost');
  assert.ok(res.bell >= earliest, `no result before turn ${earliest} (it came at ${res.bell})`);
  assert.deepEqual(res.nations, [G.leaderOf(2)], 'the rival leader wins');
  const waves = live.goalLog().filter(x => x.kind === 'wave' && x.ok);
  assert.ok(waves.some(w => w.target === 'raid'), 'the AI marched on the player (a raid)');
  // the result stays, and the waves stop
  const at = live.goalLog().length; turns(15);
  assert.deepEqual(live.goal().result, res); assert.equal(live.goalLog().length, at);
});

test('a player who takes three castles and holds them wins; the same inputs make the same game (what the save replays)', async () => {
  // the headless playtest's scripted player (demo/goal-playtest.mjs): a farm and an ore mine, Spearmen, hosts marched on
  // the rival castles it outnumbers, a guard kept on what it took, at most the relay's quota of orders
  const { game } = await import('../demo/goal-playtest.mjs');
  const a = await game({ nation: 1, strategy: 'active', turns: 160, set: {} }), b = await game({ nation: 1, strategy: 'active', turns: 160, set: {} });
  assert.equal(a.result, 'won', `the player won (${a.result}, ${a.by})`);
  assert.ok(a.turns >= G.DEMO_GOAL.holdBells + 3 && a.turns <= 120, `in ${a.turns} turns`);
  assert.ok(a.orders <= 38, `within the relay's quota (${a.orders} orders)`);
  assert.ok(a.waves.some(w => w.ok), 'the AI marched meanwhile');
  assert.deepEqual(JSON.stringify(b), JSON.stringify(a), 'deterministic: the same world, the same waves, the same result');
});

test('the page: the guide points at the goal in a demo world only; the card and result say it in EN and JA, never "season"', async () => {
  const ob = src('../../permutation-server/web/frontier/screens/onboarding.mjs');
  assert.match(ob, /export function demoGoal\(FS\) \{\n  const g = FS\.sample\?\.demo \? FS\.sample\?\.goal : null;/);
  for (const ja of ['次は目標：旗の城', 'ほかの国の旗の城を{0}つ取り、それぞれ{1}ターン守り続けると勝ちです。ほかの国も同じ城を狙い、あなたの城と土地を攻めてきます。左上の目標カードに、城と保持の時間が出ています。',
    '軍勢を選び、届く範囲の空き地か、ほかの国の旗の城（左上の目標カードの「ここへ進軍」）を選んで出発しましょう。城を取ると、勝利までの保持の時間が数え始めます。']) {
    assert.ok(EN[ja], `EN for ${ja}`);
    assert.doesNotMatch(String(typeof EN[ja] === 'function' ? EN[ja](3, 20) : EN[ja]), /season/i);
  }
  const { demoGoal } = await import('../../permutation-server/web/frontier/screens/onboarding.mjs');
  assert.deepEqual(demoGoal({ sample: { demo: {}, goal: { kind: 'flag-castles', need: 3, holdBells: 20 } } }), { need: 3, holdBells: 20 });
  assert.equal(demoGoal({ sample: { goal: { kind: 'flag-castles', need: 3, holdBells: 20 } } }), null, 'not outside the demo');
  assert.equal(demoGoal({ sample: { demo: {} } }), null);
  const hud = src('../demo/src/goalhud.mjs');
  const text = hud.slice(hud.indexOf('export const TEXT'), hud.indexOf('const T = () =>'));
  assert.doesNotMatch(text, /season|シーズン/i, 'the goal card and the result never say "season"');
  for (const k of ['won', 'lost', 'again', 'time', 'rule', 'pick', 'march']) assert.ok(/\ben: \{/.test(text) && text.split(`${k}:`).length >= 3, `EN and JA for ${k}`);
  assert.match(src('../demo/src/boot.mjs'), /if \(b\.getAttribute\('data-demo-reset'\) === 'now' \|\| globalThis\.confirm\(/, 'Play again starts over without the question');
  assert.match(src('../demo/src/boot.mjs'), /goal: true, turn: DEMO\.turnSecs/, 'the demo world plays the goal');
});

test('the demo clock\'s skip (a test\'s fast-forward): moves the clock the save reads; never while a POST holds it', () => {
  let real = 0;
  const c = createClock(() => real);
  real = 500; c.skip(12_000);
  assert.equal(c.wall(), 12_500);
  c.freeze(); c.skip(9_999); assert.equal(c.wall(), 12_500, 'held: no skip'); c.thaw();
  c.skip(-5); c.skip(NaN); assert.equal(c.wall(), 12_500);
  assert.match(src('../demo/src/boot.mjs'), /skip: ms => CLOCK\.skip\(ms\),/);
});
