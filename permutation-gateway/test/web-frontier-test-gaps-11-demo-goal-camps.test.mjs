// test-gaps-11: the walletless demo's flag-castle goal (#316 demo-solo-goal) and bandit camps (#319 demo-npc-camps),
// played together in the world the page makes (demo/src/boot.mjs: landClaim, camps and goal all on), checked in Node
// on every pull request. Until now these were checked only by hand or in one headless browser run (verify-pr316 §3:
// the "R" judge recompute, the battle capture under landClaim; verify-pr319 §1/§2: the comeback, the loot of a camp,
// camps beside castles, the reload of both).
//
// KEY-FREE, NO SIGNATURE: every world is made with the keyless viewer (W.viewer({ keyless: true })); the player's
// orders go through the world's own test instructions (`testPlay.join`, `testPlay.march`, `order`), the same startOrder
// and march script the relay runs after its signature checks. No key is generated, derived, imported or used. The
// approved demo sample keys are not needed either. The key-free CI run also preloads scripts/ci/no-keys-guard.mjs.
//
// The save → reload check (test 8) therefore cannot replay signed POSTs. It checks what the save relies on (save.mjs:
// "the world is deterministic … whatever reads come between"): the same inputs at the same clock readings make the same
// goal and camps state, however often the page reads the world; and save.mjs's own replay() of the page world.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as W from '../screens/world.mjs';
import { createLive } from '../screens/liveworld.mjs';
import * as G from '../screens/demogoal.mjs';
import * as REAL from '../src/frontier/world-goals.mjs';
import * as DC from '../../permutation-server/web/frontier/democamps.mjs';
import { TILE_OFFSETS, hexDistance, tileHex } from '../../permutation-server/web/frontier/fgeo.mjs';
import { createClock, createRecorder, readSave, replay } from '../demo/src/save.mjs';

const src = f => readFileSync(new URL(f, import.meta.url), 'utf8');
const TURN = 12, MS = TURN * 1000;
// the page's world: boot.mjs's createLive options (test 1 pins them), build.mjs's defaults turn 12 s, delay 3 s, land 400 ms
const PAGE = { stage: 'none', opening: true, territory: true, nations: true, landUpkeep: true, landClaim: true, camps: true, goal: true, turn: TURN, delay: 3, landMs: 400 };
const pageWorld = async (wall, extra = {}) => createLive({ viewer: await W.viewer({ keyless: true }), keyless: true, ...PAGE, wall, ...extra });
const hexD = (a, b) => (Math.abs(a.q - b.q) + Math.abs(a.r - b.r) + Math.abs(a.q + a.r - b.q - b.r)) / 2;
/** JSON with BigInts and byte arrays as text (a state hash's input). */
const json = v => JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? `${x}n` : x instanceof Uint8Array ? Array.from(x) : x));

/** The page world joined by the keyless viewer as `nation` (its first village placed), the clock at mid-turn. */
async function joined(nation = 1, extra = {}) {
  let real = 1_000_000;
  const live = await pageWorld(() => real, extra);
  const step = ms => { real += ms; live.clock(); };
  live.seen(); step(4_000);
  const j = live.testPlay.join(nation);
  assert.equal(j.ok, true, JSON.stringify(j));
  step(6_000);
  const me = () => live.summary().me;
  const [p, q] = me().village;
  /** Train and muster `n` Spearmen at home; two turns later the host stands at the village: → the host, or null. */
  const form = n => {
    if (!live.order('Train', { unit: 0, n }, null).ok) return null;
    assert.equal(live.order('Muster', { unit: 0, troops: n, tile: me().tile }, { p, q }).ok, true);
    step(MS); step(MS);
    return me().hosts.find(h => h.troops === n && h.province[0] === p && h.province[1] === q && h.tile === me().tile) ?? null;
  };
  /** Dissolve the viewer's host standing on (p, q, tile), retrying while its march settles. */
  const dissolveOn = (x, tries = 10) => {
    const h = me().hosts.find(e => e.province[0] === x.p && e.province[1] === x.q && e.tile === x.tile);
    assert.ok(h, `a host of the viewer stands on ${x.p},${x.q}/${x.tile}`);
    for (let i = 0; i < tries; i++) { const r = live.order('Dissolve', { host_id: BigInt(h.id) }, { p: x.p, q: x.q }); if (r.ok) return; step(MS); }
    assert.fail('the host could not be dissolved');
  };
  return { live, step, turn: () => step(MS), me, home: { p, q }, form, dissolveOn };
}
const castleOf = (live, nation) => live.goal().castles.find(c => c.nation === nation);
const campAt = (live, p, q) => live.camps().camps.find(c => c.p === p && c.q === q);
/** The rival castle nearest the viewer's village (by tile hex distance; ties by nation). */
function nearestRival(live, me, player) {
  const home = tileHex(me.village[0], me.village[1], me.tile);
  const d = c => { const h = tileHex(c.p, c.q, c.tile); return hexDistance(h.q, h.r, home.q, home.r); };
  return live.goal().castles.filter(c => c.nation !== player).sort((a, b) => d(a) - d(b) || a.nation - b.nation)[0];
}

test('1 the world in these tests is the page\'s: boot.mjs makes it with landClaim, camps and goal; build.mjs defaults 12 s / 3 s / 400 ms', () => {
  const line = src('../demo/src/boot.mjs').split('\n').find(l => l.includes('const live = createLive({'));
  assert.ok(line, 'boot.mjs makes the world in one createLive line');
  const opts = Object.fromEntries([...line.matchAll(/(\w+): (true|false|'[^']*'|DEMO\.\w+)/g)].map(m => [m[1], m[2]]));
  // (every option these tests set, with the page's value; an option a later PR adds — e.g. #318's travelers — may join it)
  const want = { stage: "'none'", opening: 'true', territory: 'true', nations: 'true', landUpkeep: 'true', landClaim: 'true', camps: 'true', goal: 'true', turn: 'DEMO.turnSecs', delay: 'DEMO.delaySecs', landMs: 'DEMO.landMs' };
  for (const [k, v] of Object.entries(want)) assert.equal(opts[k], v, `boot.mjs createLive ${k}`);
  assert.deepEqual(Object.keys(PAGE).sort(), Object.keys(want).sort(), 'PAGE is these options');
  assert.match(src('../demo/build.mjs'), /turn: \{ type: 'string', default: '12' \}, delay: \{ type: 'string', default: '3' \}, 'land-ms': \{ type: 'string', default: '400' \}/);
});

test('2 #316 a castle taken by the PLAYER\'s battle changes owner with landClaim on (verify-pr316 D-1); no other tile of its province moves; the camp beside it stays out', async () => {
  const w = await joined(1);
  const { live } = w;
  const host = w.form(500);
  assert.ok(host, 'a 500 host formed');
  const c = nearestRival(live, w.me(), 1);
  assert.equal(c.holder, c.nation, 'the castle starts its own nation\'s');
  const campBefore = campAt(live, c.p, c.q);
  assert.ok(campBefore?.up, 'the castle\'s province has a camp (both features on one map)');
  const r = live.testPlay.march(host.id, { p: c.p, q: c.q, tile: c.tile });
  assert.equal(r.ok, true, JSON.stringify(r));
  while (live.turn() <= r.arrive + 2) w.turn();
  const now = castleOf(live, c.nation);
  assert.deepEqual([now.holder, now.since], [1, r.arrive], 'the player\'s nation holds it from the arrival bell');
  const ter = live.summary().territory.find(t => t.p === c.p && t.q === c.q);
  assert.equal(ter.owners[c.tile], 1);
  const moved = ter.history.filter(x => x.reason === 'arrival' || x.reason === 'battle');
  assert.deepEqual(moved.map(x => [x.tile, x.from, x.to, x.bell, x.reason, x.hostId]), [[c.tile, c.nation, 1, r.arrive, 'battle', host.id]], 'one change: the castle, by battle with its guard');
  const prog = live.goal().progress.find(x => x.nation === 1);
  assert.deepEqual([prog.captured, prog.capturedLong, prog.castles[0].from, prog.castles[0].longAt], [1, 0, r.arrive, r.arrive + G.DEMO_GOAL.holdBells]);
  const campAfter = campAt(live, c.p, c.q);
  assert.deepEqual([campAfter.up, campAfter.troops, campAfter.cleared], [true, campBefore.troops, 0], 'the camp in the castle\'s province never joined the castle\'s clash');
  assert.equal(live.campsLog().filter(x => x.kind === 'cleared').length, 0);
});

test('3 #316 the hold timer in the world: a castle lost resets it (captured 0), taken back it counts from the new arrival, not the first', async () => {
  const w = await joined(1);
  const { live } = w;
  const c = nearestRival(live, w.me(), 1);
  const at = { p: c.p, q: c.q, tile: c.tile };
  const r1 = live.testPlay.march(w.form(500).id, at);
  assert.equal(r1.ok, true);
  while (castleOf(live, c.nation).holder !== 1) { assert.ok(live.turn() < r1.arrive + 5, 'taken'); w.turn(); }
  const first = live.goal().progress.find(x => x.nation === 1).castles[0];
  assert.equal(first.longAt, r1.arrive + G.DEMO_GOAL.holdBells);
  // the host leaves: the castle's nation takes it back with a wave ('retake')
  w.turn(); w.dissolveOn(at);
  while (castleOf(live, c.nation).holder === 1) { assert.ok(live.turn() < 160, 'the castle is lost in time'); w.turn(); }
  const lost = castleOf(live, c.nation);
  assert.equal(lost.holder, c.nation, 'its own nation took it back');
  assert.ok(live.goalLog().some(x => x.kind === 'wave' && x.ok && x.nation === c.nation && x.target === 'retake' && x.dest.p === c.p && x.dest.q === c.q && x.arrive === lost.since), 'by a retake wave, at its arrival');
  const gone = live.goal().progress.find(x => x.nation === 1);
  assert.deepEqual([gone.captured, gone.capturedLong, gone.reachAt, gone.castles], [0, 0, null, []], 'lost: the timer is gone');
  // the player takes it again: the timer starts at the new arrival
  let h = null;
  for (const n of [500, 400, 300]) if ((h = w.form(n))) break;
  assert.ok(h, 'a second host formed');
  const r2 = live.testPlay.march(h.id, at);
  assert.equal(r2.ok, true, JSON.stringify(r2));
  while (castleOf(live, c.nation).holder !== 1) { assert.ok(live.turn() < r2.arrive + 5, 'taken again'); w.turn(); }
  const again = live.goal().progress.find(x => x.nation === 1).castles[0];
  assert.equal(castleOf(live, c.nation).since, r2.arrive);
  assert.deepEqual([again.since, again.from, again.longAt], [r2.arrive, r2.arrive, r2.arrive + G.DEMO_GOAL.holdBells], 'counted from the new arrival');
  assert.ok(again.longAt > first.longAt + G.DEMO_GOAL.holdBells, 'not from the first capture');
  const hist = live.summary().territory.find(t => t.p === c.p && t.q === c.q).history.filter(x => x.tile === c.tile).map(x => [x.from, x.to, x.bell]);
  assert.deepEqual(hist, [[c.nation, 1, r1.arrive], [1, c.nation, lost.since], [c.nation, 1, r2.arrive]]);
});

test('4 #316 an idle player of EVERY nation: the AI never takes a castle in the grace, never wins before posted + grace + hold; it loses to the leader; the record agrees with the real judge every turn', async () => {
  // X = grace + hold game turns (with the Q-DSG-5 defaults 28 + 15 = 43, 8.6 min at 12 s a turn; read from DEMO_GOAL,
  // so a tuning PR such as #321's hold 20 moves X with it)
  assert.ok(G.DEMO_GOAL.graceBells >= 1 && G.DEMO_GOAL.holdBells >= 1 && G.DEMO_GOAL.perNation === 1);
  const earliest = G.DEMO_GOAL.graceBells + G.DEMO_GOAL.holdBells;
  for (let n = 0; n < G.NATIONS; n++) {
    const w = await joined(n);
    const { live } = w;
    const posted = live.goal().posted;
    assert.equal(posted, live.turn(), 'posted when the village is placed');
    let res = null, k = 0, lagged = null;
    while (!res && k++ < 260) {
      w.turn();
      const g = live.goal(), b = g.turn;
      if (b - posted < G.DEMO_GOAL.graceBells) assert.ok(g.castles.every(c => c.holder === c.nation), `nation ${n}: no castle changes hands in the grace (turn ${b - posted})`);
      // the "R" check of verify-pr316, every turn: the record's progress is the real judge's (world-goals.mjs)
      const real = REAL.progressOf({ flags: g.castles.map(c => ({ p: c.p, q: c.q, nation: c.nation })), keeps: g.castles.map(c => ({ p: c.p, q: c.q, holder: c.holder ?? 255, since: c.since })), bell: b, postedBell: posted, rules: { ...REAL.FLAG_KEEPS_DEFAULTS, holdBells: G.DEMO_GOAL.holdBells } });
      assert.deepEqual(g.progress.map(x => [x.nation, x.captured, x.capturedLong, x.reachAt]), real.map(x => [x.nation, x.captured, x.capturedLong, x.reachAt]), `nation ${n} turn ${b}`);
      const ach = REAL.achievementOf(real, b);
      // (the world judges a bell at its resolve, which runs later than the bell's turn: the record's progress counts by the
      //  clock's turn, so it shows the reach up to 2 turns before the result — D-test-gaps-11-1; always the same bell)
      if (!g.result && ach) { lagged ??= ach.bell; assert.equal(ach.bell, lagged); assert.ok(b - lagged <= 2, `nation ${n}: the result lags the reach by ${b - lagged} turns`); }
      else if (!g.result) assert.equal(lagged, null);
      res = g.result;
      if (res && lagged !== null) assert.equal(res.bell, lagged, 'the lagged reach is the result');
      if (res) assert.deepEqual([res.bell, res.nations], [ach.bell, ach.nations], 'the result is the real judge\'s achievement');
    }
    assert.ok(res, `nation ${n}: an idle player loses`);
    assert.equal(res.state, 'lost');
    assert.deepEqual(res.nations, [G.leaderOf(n)], `nation ${n}: to the rival leader`);
    assert.ok(res.bell - posted >= earliest, `nation ${n}: not before game turn ${earliest} (came at ${res.bell - posted})`);
  }
});

test('5 #319 camps never stand within 3 tiles of a village site or a flag castle, nor on one — before the player, after its village, after 150 turns', async () => {
  const w = await joined(1);
  const { live } = w;
  const check = when => {
    const castles = live.goal().castles, camps = live.camps().camps;
    assert.equal(camps.length, 18, when);
    for (const c of camps) {
      const pv = live.province(c.p, c.q), sites = pv.sites.slice(0, pv.siteCount);
      assert.ok(Math.min(...sites.map(s => hexD(TILE_OFFSETS[c.tile], TILE_OFFSETS[s]))) >= DC.DEMO_CAMPS.centreGap, `${when} ${c.p},${c.q}: ≥ 3 from every site`);
      for (const k of castles.filter(k => k.p === c.p && k.q === c.q)) {
        assert.notEqual(k.tile, c.tile, `${when}: not on the castle`);
        assert.ok(hexD(TILE_OFFSETS[c.tile], TILE_OFFSETS[k.tile]) >= 3, `${when} ${c.p},${c.q}: ≥ 3 from the flag castle (${hexD(TILE_OFFSETS[c.tile], TILE_OFFSETS[k.tile])})`);
      }
    }
    assert.equal(new Set(castles.map(k => `${k.p},${k.q}`)).size, 6);
    assert.ok(castles.every(k => camps.some(c => c.p === k.p && c.q === k.q)), 'every castle province has a camp (ring 1)');
    // the player's village tile is a site: ≥ 3 from its province's camp too
    const me = live.summary().me, mine = camps.find(c => c.p === me.village[0] && c.q === me.village[1]);
    assert.ok(hexD(TILE_OFFSETS[mine.tile], TILE_OFFSETS[me.tile]) >= 3, `${when}: ≥ 3 from the player's village`);
    return camps.map(c => [c.p, c.q, c.tile]);
  };
  const a = check('after the village');
  for (let i = 0; i < 150; i++) w.turn();
  assert.deepEqual(check('150 turns later'), a, 'no camp moved');
  // the ring-1 centre gap never binds on the fixed demo map (every farthest-from-the-sites tile is already far from the
  // centre), so a map where it does: one site at (4,0), the tile farthest from it (-1,0) is next to the centre, (3,-3) is not
  const at = (q, r) => TILE_OFFSETS.findIndex(o => o.q === q && o.r === r);
  const site = at(4, 0), near = at(-1, 0), far = at(3, -3), centre = at(0, 0);
  const pv = ring => ({ p: 1, q: 0, ring, passableMask: ((1n << BigInt(site)) | (1n << BigInt(near)) | (1n << BigInt(far))).toString(), sites: [site], siteCount: 1 });
  assert.equal(DC.campTile(pv(2), TILE_OFFSETS), near, 'ring 2: the farthest from the site');
  assert.equal(DC.campTile(pv(1), TILE_OFFSETS), far, 'ring 1: ≥ 3 from the centre, where the flag castle goes');
  const castle = G.castleTile({ ...pv(1), camp: { state: 1, tile: far } }, TILE_OFFSETS);
  assert.equal(castle, near, 'the castle: the passable tile nearest the centre that is not the camp');
  assert.ok(hexD(TILE_OFFSETS[far], TILE_OFFSETS[castle]) >= 3 && hexD(TILE_OFFSETS[far], TILE_OFFSETS[centre]) >= 3);
});

test('6 #319 one camp\'s life: loot = the defenders at the clash × 0.3/0.1/0.05 (a weakened camp too), back at its backAt and not before, 300 → 360 → 432', async () => {
  const w = await joined(1);
  const { live, home } = w;
  const at = () => campAt(live, home.p, home.q);
  const c0 = at();
  assert.deepEqual([c0.up, c0.troops], [true, 300], 'the own province\'s camp: 300 + 200 × 0');
  const lootFor = d => ({ food: Math.floor(d * 300 / 1000), ore: Math.floor(d * 100 / 1000), gold: Math.floor(d * 50 / 1000) });   // (the report's rates, not democamps.mjs)
  const dest = { p: home.p, q: home.q, tile: c0.tile };
  // a host too small first: the camp survives, weakened
  const r0 = live.testPlay.march(w.form(100).id, dest);
  assert.equal(r0.ok, true);
  while (live.turn() <= r0.arrive + 3) w.turn();
  const weak = at();
  assert.ok(weak.up && weak.troops < 300 && weak.troops > 0, `weakened (${weak.troops})`);
  assert.deepEqual(weak.loot, lootFor(weak.troops), 'the card\'s loot follows the camp\'s troops now');
  const clear = (n, defenders) => {
    let h = null;
    for (const k of [n, n - 100, n - 200]) if ((h = w.form(k))) break;
    assert.ok(h, 'a host formed');
    const before = w.me().stores;
    const r = live.testPlay.march(h.id, dest);
    assert.equal(r.ok, true, JSON.stringify(r));
    const was = live.campsLog().filter(x => x.kind === 'cleared').length;
    while (live.campsLog().filter(x => x.kind === 'cleared').length === was) { assert.ok(live.turn() <= r.arrive + 3, 'cleared'); w.turn(); }
    const x = live.campsLog().filter(y => y.kind === 'cleared').at(-1);
    assert.equal(x.bell, r.arrive);
    assert.equal(x.defenders, defenders, 'the defenders the clash began with');
    assert.deepEqual(x.full, lootFor(defenders));
    assert.deepEqual(x.loot, x.full, 'nothing lost to a full store');
    const after = w.me().stores;
    for (const [k, i] of [['food', 0], ['ore', 3], ['gold', 5]]) assert.ok(after[i] >= before[i] + x.loot[k], `${k}: ${before[i]} → ${after[i]} (+${x.loot[k]})`);
    assert.equal(x.backAt, x.bell + DC.DEMO_CAMPS.regrowBells);
    return x;
  };
  const comeback = (x, troops, k) => {
    w.dissolveOn(dest);
    while (live.turn() <= x.backAt + 3) {
      const backs = live.campsLog().filter(y => y.kind === 'back');
      assert.ok(backs.length < k || backs[k - 1].bell >= x.backAt, 'never before its backAt');
      w.turn();
    }
    const b = live.campsLog().filter(y => y.kind === 'back');
    assert.equal(b.length, k);
    assert.deepEqual([b[k - 1].bell, b[k - 1].tile, b[k - 1].troops, b[k - 1].comeback], [x.backAt, c0.tile, troops, k], 'back at its backAt, on its tile, stronger');
    const now = at();
    assert.deepEqual([now.up, now.troops, now.comebacks, now.loot], [true, troops, k, lootFor(troops)]);
  };
  const x1 = clear(400, weak.troops);
  comeback(x1, Math.round(300 * 1.2), 1);
  const x2 = clear(600, 360);
  comeback(x2, Math.round(300 * 1.2 * 1.2), 2);
});

test('7 #319 + #316 a camp scaled by distance from the player\'s village: every camp 300 + 200·d with its loot, castle provinces included', async () => {
  const w = await joined(4);
  const { live, home } = w;
  const castles = new Set(live.goal().castles.map(k => `${k.p},${k.q}`));
  let inCastleProvince = 0;
  for (const c of live.camps().camps) {
    const d = hexDistance(c.p, c.q, home.p, home.q), want = Math.min(1_500, 300 + 200 * d);
    assert.equal(c.troops, want, `${c.p},${c.q} d ${d}`);
    assert.deepEqual(c.loot, { food: Math.floor(want * 0.3), ore: Math.floor(want * 0.1), gold: Math.floor(want * 0.05) });
    if (castles.has(`${c.p},${c.q}`)) inCastleProvince++;
  }
  assert.equal(inCastleProvince, 6);
});

/**
 * The scripted session of test 8 (a camp cleared, a castle taken, the AI's waves), on a hand clock from the world's
 * start. `poll`: read the world between the inputs like the page does (every 2–7 s: the goal card, the camps, the
 * summary, the world record GET /h/…), or read nothing between them (what save.mjs's replay does). → `{marks}`: four
 * checkpoints, each `{goal, goalLog, camps, campsLog, me}` as JSON and `territory` as read.
 */
const scripted = async (poll, extra = {}) => {
  let real = 1_000_000, ms = 0;
  const live = await pageWorld(() => real, extra);
  const reads = () => { live.goal?.(); live.camps?.(); live.summary(); live.herald('/h/season', new URL('http://x/h/season')); live.herald('/h/demo/goal', new URL('http://x/h/demo/goal')); };
  const cadence = [2_000, 3_500, 7_000, 5_200, 2_100, 6_600, 4_400, 3_000];
  let i = 0;
  const until = target => { while (ms < target) { const d = poll ? Math.min(cadence[i++ % cadence.length], target - ms) : target - ms; real += d; ms += d; if (poll) reads(); } };
  const me = () => live.summary().me;
  const marks = [];
  const mark = () => marks.push({ goal: json(live.goal?.()), goalLog: json(live.goalLog?.()), camps: json(live.camps?.()), campsLog: json(live.campsLog?.()), me: json(me()), territory: live.summary().territory });
  until(900); live.seen();
  // (every input mid-turn, after the turn's resolve, as the page's player acts: world start + 10 s + k × 12 s)
  until(4_000); assert.equal(live.testPlay.join(1).ok, true);
  until(10_000);
  const [p, q] = me().village;
  const form = n => { const tr = live.order('Train', { unit: 0, n }, null); assert.equal(tr.ok, true, json(tr) + ' at ' + ms); const mu = live.order('Muster', { unit: 0, troops: n, tile: me().tile }, { p, q }); assert.equal(mu.ok, true, json(mu) + ' at ' + ms); };
  form(500);
  until(34_000);
  if (live.camps) assert.equal(live.testPlay.march(me().hosts[0].id, { p, q, tile: campAt(live, p, q).tile }).ok, true);
  until(94_000); mark();
  until(178_000); if (live.goal) form(300);
  until(202_000);
  if (live.goal) { const c = nearestRival(live, me(), 1), h = me().hosts.find(x => x.troops === 300); assert.equal(live.testPlay.march(h.id, { p: c.p, q: c.q, tile: c.tile }).ok, true); }
  until(280_000); mark();
  until(70 * MS); mark();
  until(120 * MS); mark();
  return { marks, live };
};

test('8 goal + camps save → reload: the same inputs at the same clock readings give the same goal and camps state however often the page reads; save.mjs replay() of the page world too', async () => {
  // world A: read like the page (every 2–7 s: the goal card, the camps, the summary, the world record); world B: the
  // same inputs at the same clock readings and nothing read between them (what a replay does)
  const A = await scripted(true), B = await scripted(false);
  const a = A.marks.map(m => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, typeof v === 'string' ? JSON.parse(v) : v])));
  assert.ok(a[0].campsLog.some(x => x.kind === 'cleared' && x.winner?.viewer), 'a camp was cleared (state worth comparing)');
  assert.ok(a[1].goal.castles.some(k => k.holder === 1), 'a castle was taken');
  assert.ok(a[3].goalLog.some(x => x.kind === 'wave' && x.ok), 'the AI waves marched');
  for (let k = 0; k < A.marks.length; k++) {
    for (const f of ['goal', 'goalLog', 'camps', 'campsLog', 'me']) assert.equal(B.marks[k][f], A.marks[k][f], `checkpoint ${k}: the same ${f}`);
    // the land too, every tile's since included (D-test-gaps-11-2, fixed by fix-tg11-since: test 9)
    assert.equal(json(B.marks[k].territory), json(A.marks[k].territory), `checkpoint ${k}: the same land`);
  }
  // save.mjs's own replay of the page world (keyless: its POSTs are refused, deterministically): the goal and camps
  // records after a reload are the ones before it
  const memory = () => { const m = new Map(); return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: k => { m.delete(k); } }; };
  const hand = () => { let real = 1_000_000; return { c: createClock(() => real), move: ms => { real += ms; } }; };
  const ls = memory(), X = hand();
  const one = await pageWorld(X.c.wall);
  const rec = createRecorder({ storage: ls, worldId: 'w', clock: X.c });
  X.move(700); rec.seen(one);
  for (let k = 0; k < 40; k++) {
    X.move(3_000 + (k % 4) * 1_700);
    one.goal(); one.camps();
    if (k === 7) await rec.post('POST', '/gw/f/relay', JSON.stringify({ tx: 'AAAA' }), () => one.relay('POST', '/gw/f/relay', { tx: 'AAAA' }));
    rec.tick(one.turn());
  }
  rec.write();
  const state = live => json({ goal: live.goal(), goalLog: live.goalLog(), camps: live.camps(), campsLog: live.campsLog(), territory: live.summary().territory, neighbours: live.summary().neighbours });
  const want = state(one);
  const Y = hand(), two = await pageWorld(Y.c.wall);
  await replay(two, readSave(ls, 'w').save, Y.c);
  assert.equal(state(two), want, 'the reloaded page world has the same castles, guards, camps and logs');
});

// D-test-gaps-11-2 (found by test-gaps-11; fixed by fix-tg11-since, owner Q-TG11-1 (a) 2026-11-28 21:05): the world's
// land once depended on WHEN it was first read (liveworld.mjs `territoryFor` made a province's record at its first read,
// and a read granted a new village its tile). Every record is now made with the world and a read writes nothing, so the
// village tile's since is the same (41 here) whether the page polls or a replay reads nothing between its inputs.
// More seeds and a save.mjs reload: web-frontier-fix-tg11-since.test.mjs.
test('9 D-test-gaps-11-2: the village tile\'s since does not depend on how often the page reads the world', async () => {
  for (const extra of [{}, { goal: false, camps: false }]) {
    const A = await scripted(true, extra), B = await scripted(false, extra);
    for (let k = 0; k < A.marks.length; k++) assert.equal(json(B.marks[k].territory), json(A.marks[k].territory), `${json(extra)} checkpoint ${k}`);
  }
});
