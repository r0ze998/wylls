// The walletless demo's late AI waves (Q-DGP-1 (c), owner r0ze 2026-11-28 21:05): from game turn `lateFromBells` the AI
// waves grow faster, so a game where the player keeps a thin guard on what it took still ends (the AI wins), while the
// judged rule (castles, hold, win/loss) is unchanged. Keyless: the keyless viewer, nothing is signed, no key is derived.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as W from '../screens/world.mjs';
import { createLive } from '../screens/liveworld.mjs';
import * as G from '../screens/demogoal.mjs';

const src = f => readFileSync(new URL(f, import.meta.url), 'utf8');
const world = async ({ wall, goal = true }) => createLive({ viewer: await W.viewer({ keyless: true }), keyless: true, stage: 'none', opening: true, territory: true, nations: true, landUpkeep: true, landClaim: true,
  turn: 12, delay: 3, landMs: 400, wall, goal });

test('the wave curve: every 10 turns ×1.12 until turn 120, then every 5 turns ×1.2, capped; the judged numbers are unchanged', () => {
  const R = G.DEMO_GOAL, L = G.lateWave();
  assert.equal(R.lateFromBells, 120); assert.equal(R.lateEvery, 5); assert.equal(R.lateGrowthBps, 2_000); assert.equal(R.waveCap, 30_000);
  assert.equal(L, Math.ceil((R.lateFromBells - R.graceBells) / R.waveEvery), 'the first wave at or after turn lateFromBells');
  assert.ok(R.graceBells + L * R.waveEvery >= R.lateFromBells && R.graceBells + (L - 1) * R.waveEvery < R.lateFromBells);
  // (the judged rule: one castle a nation, need from the real needOf; the hold and the guard are tuning, not this change's)
  assert.equal(R.perNation, 1); assert.equal(R.need, null);
  for (let k = 0; k <= L; k++) assert.equal(G.waveTroops(k), Math.round(100 * 1.12 ** k), `early wave ${k}`);
  for (let k = L + 1; k < L + 6; k++) {
    const r = G.waveTroops(k) / G.waveTroops(k - 1);
    assert.ok(r > 1.18 && r < 1.22, `late wave ${k}: ×${r.toFixed(3)}`);
  }
  // the schedule: waveAt and waveBell agree; 10 turns apart before the late phase, 5 after
  const at = [];
  for (let g = 0; g < 400; g++) { const k = G.waveAt(g); if (k !== null) { assert.equal(G.waveBell(k), g); at.push(g); } }
  assert.deepEqual(at.slice(0, L + 1), Array.from({ length: L + 1 }, (_, k) => R.graceBells + k * R.waveEvery));
  for (let i = L + 1; i < at.length; i++) assert.equal(at[i] - at[i - 1], R.lateEvery);
  assert.equal(at.length, L + 1 + Math.floor((399 - G.waveBell(L)) / R.lateEvery));
  assert.equal(G.waveTroops(L + 80), R.waveCap, 'capped');
  assert.ok(G.waveTroops(L + 80) * (10_000 + R.leaderBonusBps) / 10_000 >= R.waveCap, '(the leader\'s host is capped by the same cap: liveworld)');
  // ten turns into the late phase the leader sends twice the troops a 10-turn spacing sent (2 hosts × 1.2, then 1.44)
  assert.ok(G.waveTroops(L + 4) >= 2 * G.waveTroops(L), 'the wave doubles within 20 turns of the late phase (the inbox example: "after 120 turns ×2")');
  // without a late phase the old curve
  const old = { ...R, lateFromBells: null };
  assert.equal(G.lateWave(old), null);
  assert.equal(G.waveTroops(L + 5, old), Math.round(100 * 1.12 ** (L + 5)));
  assert.equal(G.waveAt(G.waveBell(L) + 5, old), null); assert.equal(G.waveAt(G.waveBell(L) + 10, old), L + 1);
});

test('the late targets: a skirmisher leaves its castle to the leader; a stop-rival out of reach falls back to captures', () => {
  const castles = Array.from({ length: 6 }, (_, n) => ({ nation: n, p: n, q: 0, tile: 30, holder: n, since: 40 }));
  const prog = cs => G.progressOf({ castles: cs, bell: 100, postedBell: 50 });
  const dist = c => Math.abs(c.nation - 3), L = G.lateWave();
  const T = (cs, n, wave) => G.waveTarget({ castles: cs, progress: prog(cs), n, player: 1, leader: 3, dist, wave });
  const byLeader = castles.map(c => (c.nation === 5 ? { ...c, holder: 3, since: 90 } : c));
  assert.equal(T(byLeader, 5, L - 1).kind, 'retake', 'before the late phase a skirmisher takes its castle back from the leader');
  assert.equal(T(byLeader, 5, L).kind, 'raid', 'from the late phase it does not');
  const byPlayer = castles.map(c => (c.nation === 5 ? { ...c, holder: 1, since: 90 } : c));
  assert.equal(T(byPlayer, 5, L + 3).kind, 'retake', 'it still takes it back from the player');
  const near = castles.map(c => (c.nation === 0 || c.nation === 5 ? { ...c, holder: 1, since: c.nation === 0 ? 70 : 80 } : c));
  const t = T(near, 3, 2);
  assert.equal(t.kind, 'stop-rival');
  assert.equal(t.castles[0].nation, 0, 'the castle whose hold ends first, first');
  assert.deepEqual(t.castles.slice(1).map(c => c.nation).slice(0, 2), [2, 4], 'then the castles a capture tries, nearest first (D-demo-goal-polish-1-3: the world takes the first a march reaches)');
  assert.deepEqual(t.castles.slice(1).map(c => c.nation).sort(), [1, 2, 4, 5]);
});

test('the world: the leader\'s waves never pile up at home; the card\'s "next wave ≈ N" is the next wave\'s host; a reload\'s jump makes the same waves', async () => {
  // an idle player with an early late phase: the waves reach the late curve before the leader wins
  const set = { lateFromBells: 48 };
  let real = 1_000_000;
  const a = await world({ wall: () => real, goal: set });
  a.seen(); real += 4_000; a.clock();
  assert.equal(a.testPlay.join(2).ok, true);
  const seen = [];
  // (read twice a turn: before and after the turn's npc step, when a wave goes)
  for (let i = 0; i < 400 && !a.goal().result; i++) {
    real += 6_000; a.clock();
    const g = a.goal();
    if (g.nextWave !== null) seen.push({ at: g.nextWave, troops: g.waveTroops, late: g.late, sent: a.goalLog().some(x => x.kind === 'wave' && x.bell === g.nextWave), skipped: G.waveAt(g.turn - g.posted, { ...G.DEMO_GOAL, ...set }) !== null && !a.goalLog().some(x => x.kind === 'wave' && x.bell === g.turn) && g.nextWave !== g.turn });
  }
  const g = a.goal(), waves = a.goalLog().filter(x => x.kind === 'wave');
  assert.ok(g.result, 'the game ended');
  assert.equal(waves.filter(w => w.code === 'Full').length, 0, 'no wave was lost to a full home');
  assert.ok(waves.some(w => w.wave >= G.lateWave({ ...G.DEMO_GOAL, ...set })), 'late waves marched');
  // truthful card: every "next wave at turn X, about N troops" it showed is the troops of the non-leader hosts of that wave
  for (const s of seen) for (const w of waves.filter(x => x.bell === s.at && x.nation !== G.leaderOf(2) && x.troops)) assert.equal(w.troops, s.troops, `wave at ${s.at}`);
  assert.ok(seen.some(x => x.late) && seen.some(x => !x.late), 'the record says late from the first late-spaced wave');
  for (const x of seen) assert.equal(x.late, G.waveAt(x.at - g.posted, { ...G.DEMO_GOAL, ...set }) > G.lateWave({ ...G.DEMO_GOAL, ...set }));
  assert.equal(seen.filter(x => x.skipped).length, 0, 'a wave due this turn and not yet sent is the card\'s next wave');
  assert.equal(seen.filter(x => x.sent).length, 0, 'the card\'s next wave is never one already sent (a wave goes at its bell\'s npc step, before the bell)');
  // the leader's host is the same wave × the bonus (capped)
  for (const w of waves.filter(x => x.nation === G.leaderOf(2) && x.troops)) assert.equal(w.troops, Math.min(G.DEMO_GOAL.waveCap, Math.round(G.waveTroops(w.wave, { ...G.DEMO_GOAL, ...set }) * 1.2)));
  // a reload replays the inputs and then sets the clock at once (save.mjs replay): the same waves, the same result
  let real2 = 1_000_000;
  const b = await world({ wall: () => real2, goal: set });
  b.seen(); real2 += 4_000; b.clock();
  assert.equal(b.testPlay.join(2).ok, true);
  real2 = real; b.clock();
  assert.deepEqual(JSON.stringify(b.goalLog()), JSON.stringify(a.goalLog()));
  assert.deepEqual(b.goal().result, g.result);
});

test('the card says when the late waves begin, in EN and JA, and never "season"', async () => {
  const { TEXT, cardModel } = await import('../demo/src/goalhud.mjs');
  assert.equal(TEXT.en.late(5), 'The AI waves now come every 5 turns and grow faster each time.');
  assert.equal(TEXT.ja.late(5), 'AI の波は 5 ターンごとになり、毎回より大きくなります。');
  for (const l of ['en', 'ja']) assert.doesNotMatch(TEXT[l].late(5), /season|シーズン/i);
  const g = { posted: 10, player: 2, leader: 4, need: 3, turn: 150, turnSecs: 12, rules: { ...G.DEMO_GOAL }, castles: [], progress: [{ nation: 2, captured: 0, capturedLong: 0, reachAt: null, castles: [] }], nextWave: 153, waveTroops: 500, result: null };
  assert.equal(cardModel({ ...g, late: true }).late, 5);
  assert.equal(cardModel({ ...g, late: false }).late, null);
  assert.equal(cardModel({ ...g, late: true, nextWave: null }).late, null, 'no line when no wave is coming (after the result)');
  assert.match(src('../demo/src/goalhud.mjs'), /\$\{m\.late \? `<p class="dg-muted">\$\{esc\(t\.late\(m\.late\)\)\}<\/p>` : ''\}/);
});

test('no game is left without a result: human-paced players who guard thinly, normally or carefully, fixed seeds, ≤ 200 turns', { timeout: 300_000 }, async () => {
  const { game } = await import('../demo/goal-playtest.mjs');
  const out = [];
  let full = 0, reused = 0;
  for (const strategy of ['thin', 'normal', 'careful']) for (const nation of [2, 3, 4]) for (const seed of [1, 2]) {
    const r = await game({ nation, strategy, turns: 200, seed, set: {} });
    out.push(`${strategy} ${r.nation} s${seed}: ${r.result} ${r.turns}`);
    full += r.waves.filter(w => w.code === 'Full').length; reused += r.waves.filter(w => w.reused).length;
    assert.notEqual(r.result, 'none', `${strategy} nation ${nation} seed ${seed}: no result in 200 turns`);
  }
  assert.equal(full, 0, 'no AI wave was lost to a full home');
  assert.ok(reused > 0, 'wave hosts left at home marched again');
  const won = s => out.filter(x => x.startsWith(s) && / won /.test(x)).length;
  assert.ok(won('careful') >= 4 && won('normal') >= 4, `careful and normal players still win: ${out.join('; ')}`);
});

test('source pins: the late phase is the AI\'s only; the judge reads no late number', () => {
  const goal = src('../screens/demogoal.mjs'), live = src('../screens/liveworld.mjs');
  for (const f of ['progressOf', 'achievementOf', 'resultOf', 'needOf']) {
    const body = goal.slice(goal.indexOf(`export function ${f}`) >= 0 ? goal.indexOf(`export function ${f}`) : goal.indexOf(`export const ${f}`)).split('\n/**')[0];
    assert.doesNotMatch(body, /late/i, `${f} reads no late number`);
  }
  assert.match(live, /G\.waveTarget\(\{[^}]*rules: GOAL\.rules \}\)/, 'the world passes its rules to the targets');
  assert.match(live, /GOAL\.waveIds\.has\(String\(e\.id\)\)/, 'only a wave host is reused');
});
