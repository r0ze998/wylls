// fix-tg11-since (owner Q-TG11-1 (a), 2026-11-28 21:05; D-test-gaps-11-2): the walletless demo's land must not depend
// on when the page first reads it. A reloaded world (demo/src/save.mjs: its inputs replayed at their clock readings,
// nothing read between them) must be the played world exactly — every tile's `since` included.
//
// Before: liveworld.mjs `territoryFor` made a province's land record at its FIRST READ, and a read (`territoryOf`)
// granted a new village its tile at once. The page polls, so its player's province was made before the join and the
// village tile was stamped by the next resolve (41); the replay made it after the join (40). Now every record is made
// with the world and a read writes nothing: a village's tile is granted by the world's resolve, whoever reads.
//
// KEY-FREE, NO SIGNATURE: keyless viewer (W.viewer({ keyless: true })), the player's inputs through the world's own test
// instructions (`testPlay.join`, `testPlay.march`, `order`). The save → reload goes through save.mjs's real
// createRecorder / replay: those inputs are carried as test POSTs on a `/gw/test/…` path that a small wrapper below hands
// to the test instructions (the page's signed relay POSTs need keys; see test-gaps-11 "Key handling").
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as W from '../screens/world.mjs';
import { createLive } from '../screens/liveworld.mjs';
import { createTerritory, resolveTerritory } from '../screens/territory.mjs';
import { createClock, createRecorder, readSave, replay } from '../demo/src/save.mjs';

const TURN = 12, MS = TURN * 1000;
// the page's world (demo/src/boot.mjs createLive options; pinned by web-frontier-test-gaps-11-demo-goal-camps test 1)
const PAGE = { stage: 'none', opening: true, territory: true, nations: true, landUpkeep: true, landClaim: true, camps: true, goal: true, turn: TURN, delay: 3, landMs: 400 };
const json = v => JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? `${x}n` : x instanceof Uint8Array ? Array.from(x) : x instanceof Set ? [...x] : x));
const hash = v => createHash('sha256').update(json(v)).digest('hex');
const memory = () => { const m = new Map(); return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: k => { m.delete(k); } }; };

/** The world's state, as fully as it is readable: every read the page makes, the raw land records, every province's bytes. */
function worldState(live) {
  const s = live.summary();
  const provinces = (s.territory ?? []).map(t => live.province(t.p, t.q));
  return {
    summary: s, land: live.testPlay.land(), provinces,
    goal: live.goal?.() ?? null, goalLog: live.goalLog?.() ?? null, camps: live.camps?.() ?? null, campsLog: live.campsLog?.() ?? null,
    season: live.herald('/h/season', new URL('http://x/h/season')),
  };
}
/** `live` with the test POSTs a save can carry: `/gw/test/join`, `/gw/test/order`, `/gw/test/march` (anything else: the relay). */
const withTests = live => ({
  ...live,
  relay: (m, p, b) => {
    if (p === '/gw/test/join') return live.testPlay.join(b.nation);
    if (p === '/gw/test/order') return live.order(b.name, b.d, b.at);
    if (p === '/gw/test/march') return live.testPlay.march(b.host, b.dest);
    return live.relay(m, p, b);
  },
});

/**
 * One played session on a hand clock, recorded by save.mjs: the page's reads every 2–7 s, a village placed, a host
 * formed and marched to its province's camp (when camps are on) and to the nearest castle (goal on), then turns run on.
 * → `{live, ls, clock}`: the played world and the storage its save is in.
 */
async function play(options) {
  let real = 1_000_000;
  const clock = createClock(() => real);
  const live = withTests(createLive({ viewer: await W.viewer({ keyless: true }), keyless: true, ...PAGE, ...options, wall: clock.wall }));
  const ls = memory(), rec = createRecorder({ storage: ls, worldId: 'w', clock });
  const cadence = [2_000, 3_500, 7_000, 5_200, 2_100, 6_600, 4_400, 3_000];
  let i = 0, ms = 0;
  const reads = () => { live.goal?.(); live.camps?.(); live.summary(); live.herald('/h/season', new URL('http://x/h/season')); live.herald('/h/demo/goal', new URL('http://x/h/demo/goal')); live.province(0, 0); };
  const until = target => { while (ms < target) { const d = Math.min(cadence[i++ % cadence.length], target - ms); real += d; ms += d; reads(); rec.tick(live.turn()); } };
  const post = async (p, b) => rec.post('POST', p, JSON.stringify(b), () => live.relay('POST', p, b));
  const me = () => live.summary().me;
  until(900); rec.seen(live);
  until(4_000);
  const j = await post('/gw/test/join', { nation: options.nation });
  assert.equal(j.ok, true, json(j));
  until(10_000);
  const [p, q] = me().village;
  /** Train and muster n Spearmen at home (`must`: the first host; a later one may be refused by the stores — a refusal is an input too). */
  const form = async (n, must) => {
    const tr = await post('/gw/test/order', { name: 'Train', d: { unit: 0, n }, at: null });
    if (must) assert.equal(tr.ok, true, json(tr));
    if (!tr.ok) return false;
    const mu = await post('/gw/test/order', { name: 'Muster', d: { unit: 0, troops: n, tile: me().tile }, at: { p, q } });
    assert.equal(mu.ok, true, json(mu));
    return true;
  };
  await form(500, true);
  until(34_000);
  const camp = live.camps?.().camps.find(c => c.p === p && c.q === q);
  if (camp) await post('/gw/test/march', { host: me().hosts[0].id, dest: { p, q, tile: camp.tile } });
  until(120_000);
  if (live.goal) {
    await form(150, false);
    until(150_000);
    const c = live.goal().castles.find(k => k.nation !== options.nation), h = me().hosts.find(x => x.troops === 150);
    if (h) await post('/gw/test/march', { host: h.id, dest: { p: c.p, q: c.q, tile: c.tile } });
  }
  until(60 * MS);
  rec.write();
  return { live, ls, real: () => real, move: d => { real += d; } };
}
/** The reload: a new world made with a new clock, and save.mjs's replay of the save (nothing read between its inputs). */
async function reload(options, ls) {
  let real = 5_000_000;
  const clock = createClock(() => real);
  const live = withTests(createLive({ viewer: await W.viewer({ keyless: true }), keyless: true, ...PAGE, ...options, wall: clock.wall }));
  await replay(live, readSave(ls, 'w').save, clock);
  return { live, move: d => { real += d; } };
}

const SEEDS = [1, 2, 3, 7, 42, 1009];
for (const seed of SEEDS) {
  test(`seed ${seed}: save → reload gives the same world, every tile's since included (and the same world 20 turns on)`, async () => {
    const options = { seed, nation: 1 + (seed % 5) };
    const A = await play(options), B = await reload(options, A.ls);
    const a = worldState(A.live), b = worldState(B.live);
    // the session is worth comparing: a village with its land, hosts that marched
    const home = a.land[`${a.summary.me.village[0]},${a.summary.me.village[1]}`];
    assert.equal(home.owners[a.summary.me.tile], a.summary.me.nation, 'the village holds its tile');
    assert.ok(Number.isInteger(home.since[a.summary.me.tile]), 'with a since');
    for (const k of Object.keys(a)) assert.equal(json(b[k]), json(a[k]), `seed ${seed}: the same ${k}`);
    assert.equal(hash(b), hash(a), `seed ${seed}: the same world hash`);
    // a later rule that reads since would see the same land: both worlds run on, unread, and stay the same
    A.move(20 * MS); B.move(20 * MS);
    assert.equal(hash(worldState(B.live)), hash(worldState(A.live)), `seed ${seed}: the same world 20 turns on`);
  });
}

test('goal and camps off: save → reload gives the same world, every tile\'s since included', async () => {
  for (const seed of [1, 5]) {
    const options = { seed, nation: 2, goal: false, camps: false };
    const A = await play(options), B = await reload(options, A.ls);
    assert.equal(hash(worldState(B.live)), hash(worldState(A.live)), `seed ${seed}`);
  }
});

test('the new village\'s tile is stamped by the resolve after its placement however the page reads (the played world\'s value: 41 in test-gaps-11)', async () => {
  // read every 500 ms, and not at all: the same since, and it is the first resolve at or after the placement
  const run = async reads => {
    let real = 1_000_000;
    const live = createLive({ viewer: await W.viewer({ keyless: true }), keyless: true, ...PAGE, wall: () => real });
    const step = (ms, look) => { for (let d = 0; d < ms; d += 500) { real += Math.min(500, ms - d); if (look) live.summary(); } };
    step(900, reads); live.seen(); step(3_100, reads);
    assert.equal(live.testPlay.join(1).ok, true);
    const at = live.summary().me, placed = live.testPlay.land()[`${at.village[0]},${at.village[1]}`].bell;   // the last resolved bell at the placement
    step(30_000, reads);
    const me = live.summary().me, t = live.testPlay.land()[`${me.village[0]},${me.village[1]}`];
    return { placed, since: t.since[me.tile], owner: t.owners[me.tile], nation: me.nation };
  };
  const polled = await run(true), unread = await run(false);
  assert.deepEqual(unread, polled);
  assert.equal(polled.owner, polled.nation);
  assert.equal(polled.since, polled.placed + 1, "the first resolve after the placement (as the polled page world stamped it before the fix)");
});

test('a read shows a home not yet resolved as the record will grant it, without writing the record', async () => {
  let real = 1_000_000;
  const live = createLive({ viewer: await W.viewer({ keyless: true }), keyless: true, ...PAGE, wall: () => real });
  real += 900; live.seen(); real += 3_100;
  assert.equal(live.testPlay.join(1).ok, true);
  const me = live.summary().me, k = `${me.village[0]},${me.village[1]}`;
  const raw = live.testPlay.land()[k], shown = live.summary().territory.find(t => `${t.p},${t.q}` === k);
  assert.equal(shown.owners[me.tile], me.nation, 'the summary shows the village\'s tile at once (as before)');
  if (raw.owners[me.tile] !== me.nation) {
    assert.equal(shown.since[me.tile], raw.bell, 'shown with the record\'s bell');
    assert.equal(json(live.testPlay.land()[k]), json(raw), 'the read wrote nothing');
  }
  // territory.mjs itself is unchanged: a record made with a home in it holds it from its bell
  const pv = live.province(me.village[0], me.village[1]), t = createTerritory(pv), b0 = t.bell;
  assert.equal(t.owners[me.tile], me.nation);
  assert.equal(resolveTerritory(t, pv, b0 + 1).since[me.tile], b0);
});
