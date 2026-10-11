// The sample world (liveworld.mjs; UX design 14.5) against the rule numbers:
// every order a village owner has is accepted where the program accepts it
// and refused where it refuses, with the program's error name; what a turn
// resolves (a march arriving and staying, a clash at the camp by the rules
// kernel, an exploration's result) is read back; the clock is one scaled
// clock; the same seed and orders give the same world. The numbers asserted
// here are the rules crate's own (m1-actions.json lists them with their
// sources; rules.mjs names the lines).
//
// Run with the fast set (fixtures.screen.mjs imports this file) or alone:
//   node --test screens/liveworld.screen.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLive, LIVE, SIMPLER } from './liveworld.mjs';
import * as W from './world.mjs';
import * as R from './rules.mjs';
import { kernel } from './kernel.mjs';
import { tileHex, TILE_OFFSETS, hexDistance } from '../../permutation-server/web/frontier/fgeo.mjs';
import { hostId } from '../../permutation-server/web/frontier/faddr.mjs';
import { pack, encodePath, commit as sealCommit, ctHash as sealCtHash } from '../../permutation-server/web/frontier/seal.mjs';
import { toHex } from '../../permutation-server/web/sdk/bytes.mjs';

const { HOME, HOSTS, CAMP_TILE, GENESIS_TS } = W;
const K = kernel();
const RINGS = W.seasonRecord().rings.map(r => ({ ring: r.d, seed: r.seed }));
const NAMES = { 16: 'HOLDING_FINAL', 20: 'HARVEST', 21: 'BUILD', 22: 'TRAIN', 23: 'MUSTER', 24: 'DISSOLVE', 25: 'GARRISON', 26: 'EXPLORE', 27: 'EXPLORE_RESULT', 30: 'DEPART', 31: 'REVEAL', 32: 'DEPARTURE_SETTLED', 34: 'TRANSIT_SETTLED', 41: 'CLASH', 43: 'CAMP' };

/** A world on a wall clock the test moves (`clock.t`, ms); the page's first /h/season has been asked. */
export async function sample(opts = {}) {
  const v = await W.viewer(), clock = { t: 1_700_000_000_000 };
  const w = createLive({ viewer: v, stage: 'holding', wall: () => clock.t, neighbours: false, ...opts });
  w.seen();
  let seen = w.records().at(-1)?.seq ?? -1;
  /** The records logged since the last call, by name. */
  const logged = () => { const r = w.records(seen); if (r.length) seen = r.at(-1).seq; return r.map(x => ({ name: NAMES[x.kind] ?? String(x.kind), bell: x.bell, ...x.fields })); };
  const me = () => w.summary().me;
  const host = id => me().hosts.find(h => h.id === String(id)) ?? null;
  return { w, clock, v, logged, me, host };
}
/** A sealed order as the page seals it (the plaintext, its commitment, a seal of filler bytes), for a march of `host` from `from` to `to`. */
export function sealed(host, from, to, { unit = 0, arrive, stance = 0, retreatBps = 0, dirs = null } = {}) {
  const plan = dirs ? { dirs } : K.call('plan_path', { start: tileHex(from.p, from.q, from.tile), dest: tileHex(to.p, to.q, to.tile), unit, blocked: [], seeds: RINGS }).value;
  const path = encodePath(plan.dirs);
  const plain = pack({ version: 1, hostId: host, arriveBell: arrive, destP: to.p, destQ: to.q, destTile: to.tile, stance, retreatBps, pathLen: path.pathLen, path: path.path });
  const salt = new Uint8Array(32).fill(0x5a), seal = Uint8Array.from({ length: 165 }, (_, i) => (i === 0 ? 0x83 : (i * 11 + 5) & 0xff));
  return { plain, salt, seal, commit: sealCommit(plain, salt), ctHash: sealCtHash(seal), secs: plan.secs ?? null };
}
const depart = (w, host, m, slot, extra = {}) => w.order('Depart', { host_id: host, commit: m.commit, seal: m.seal, arrive_bell: extra.arrive, tip: W.MIN_TIP, transit_slot: slot, ...extra.data }, extra.province ?? HOME);
const passable = (pv, t) => ((pv.passableMask >> BigInt(t)) & 1n) === 1n;
/** A passable tile of the home province that is no site and not the camp's, `d` hexes from `from` (the nearest such). */
function openTile(pv, from, d = 1, skip = []) {
  const o = TILE_OFFSETS[from];
  return [...Array(61).keys()].filter(t => passable(pv, t) && !pv.sites.includes(t) && t !== pv.camp.tile && !skip.includes(t) && hexDistance(o.q, o.r, TILE_OFFSETS[t].q, TILE_OFFSETS[t].r) === d)[0];
}

test('the sample world\'s clock: a turn every 20 s by default, the whole game clock scaled with it; `turn`, `advance()`, `pause()`; the season record says it is a sample', async () => {
  const { w, clock } = await sample();
  assert.deepEqual([LIVE.TURN, LIVE.TURN_SECS, w.rate, w.turnSecs], [42, 20, 30, 20]);
  assert.equal(w.tollAt, GENESIS_TS + 600 * 43);
  assert.equal(w.now(), w.tollAt - 8 * 30, 'eight wall seconds before the first toll, in game seconds');
  clock.t += 7_900;
  assert.equal(w.turn(), 42);
  clock.t += 100;
  assert.equal(w.turn(), 43, 'the toll');
  clock.t += 20_000;
  assert.equal(w.turn(), 44, 'a turn is twenty wall seconds');
  assert.equal(w.summary().into, 0);
  // stores follow the same clock: an hour of the game is two wall minutes
  const food = w.summary().me.stores[0];
  clock.t += 120_000;
  assert.equal(w.summary().me.stores[0] - food, 72, 'a town\'s 60 food an hour and its farm\'s 12');
  assert.equal(w.turn(), 50);
  // pause: the clock stands; again: it runs on from where it stood
  assert.equal(w.pause(true), true);
  const t = w.now();
  clock.t += 60_000;
  assert.equal(w.now(), t);
  assert.equal(w.summary().paused, true);
  assert.deepEqual([w.herald('/h/season').body.sample.paused, w.herald('/h/season').body.sample.rate], [true, 0], 'the season record says the clock stands');
  w.pause(false);
  clock.t += 1_000;
  assert.equal(w.now(), t + 30);
  // advance: the next turn at once, after its opening has resolved
  w.pause(true);
  const turn = w.turn();
  assert.equal(w.advance(), turn + 1);
  assert.deepEqual([w.summary().into, w.summary().resolvedNext], [LIVE.ADVANCE_INTO, turn], 'the turn before last is resolved a little into the turn (the window W and the seed margin after the bell before it ended)');
  assert.equal(w.advance({ into: 0 }), turn + 2);
  assert.equal(w.summary().into, 0);
  // another turn length
  const fast = await sample({ turn: 3, delay: 1 });
  assert.deepEqual([fast.w.rate, fast.w.now()], [200, fast.w.tollAt - 200]);
  fast.clock.t += 1_000 + 3_000;
  assert.equal(fast.w.turn(), 44);
  // the season record: the clock, and that this is a sample world on a scaled clock
  const s = fast.w.herald('/h/season').body;
  assert.equal(s.cluster, 'localnet');
  assert.equal(s.latestUnix, Math.floor(fast.w.now()));
  assert.deepEqual([s.sample.world, s.sample.turnSecs, s.sample.rate, s.sample.simpler], ['sample', 3, 200, SIMPLER]);
  assert.ok(SIMPLER.length >= 6 && SIMPLER.every(x => typeof x === 'string'));
});

test('the same seed and the same orders give the same world; another seed scripts the neighbours otherwise', async () => {
  const play = async seed => {
    const { w, clock } = await sample({ neighbours: true, seed });
    clock.t += 11_000;
    assert.equal(w.order('Train', { unit: 0, n: 200 }).ok, true);
    assert.equal(w.order('Muster', { unit: 0, troops: 200, tile: HOME.tile }).ok, true);
    for (let i = 0; i < 14; i++) { clock.t += 20_000; w.summary(); }
    return { log: JSON.stringify(w.records(), (k, v) => (typeof v === 'bigint' ? String(v) : v instanceof Uint8Array ? toHex(v) : v)), sum: JSON.stringify(w.summary()), npc: w.npcLog.map(x => [String(x.host), x.bell, x.dest.tile]) };
  };
  const a = await play(1), b = await play(1), c = await play(2);
  assert.equal(a.log, b.log);
  assert.equal(a.sum, b.sum);
  assert.ok(a.npc.length >= 3, `the neighbours marched (${a.npc.length})`);
  assert.notDeepEqual(a.npc, c.npc);
});

test('Harvest settles and nothing more: stores grow by the clock, a finished building raises its rate from the moment it was done', async () => {
  const { w, clock, logged, me } = await sample();
  const before = me();
  assert.deepEqual(before.perHour, [72, 45, 30, 22, 0, 22, 7, 0], 'a town\'s base production (hamlet 40/30/20/15/15/5 +50%, rounded down) and one farm');
  assert.deepEqual(before.queue.map(q => [q.kind, q.arg]), [[R.QK.PRODUCTION, R.RES.Wood]]);
  // to 400 game seconds after the woodcutter is done: wood grew at 45 an hour until then and at 55 after, touched or not
  const doneAt = w.tollAt + LIVE.BUILT_AFTER, t0 = w.now(), wood0 = before.stores[1];
  clock.t += ((doneAt + 400 - t0) / 30) * 1000;
  assert.deepEqual([me().perHour[1], me().queue.length], [45, 1], 'before a touch the account still carries the old rate and the finished item');
  assert.equal(w.order('Harvest').ok, true);
  assert.deepEqual(logged().filter(x => x.name === 'HARVEST').map(x => [x.name, x.p, x.q, x.site]), [['HARVEST', HOME.p, HOME.q, HOME.site]]);
  const after = me();
  assert.deepEqual([after.perHour[1], after.queue.length], [55, 0], 'the touch collects the finished building');
  // the amount is what settling at the building's own done time gives (path independent)
  const exact = wood0 + (45 * (doneAt - t0) + 55 * 400) / 3600;
  assert.ok(Math.abs(after.stores[1] - exact) <= 1, `wood ${after.stores[1]}, expected about ${exact.toFixed(1)}`);
  // a second harvest changes no amount
  const s1 = me().stores;
  assert.equal(w.order('Harvest').ok, true);
  assert.deepEqual(me().stores, s1);
});

test('Build: the cost of the n-th copy, the time of the n-th copy, a serial queue of the tier\'s slots, the production at completion', async () => {
  const { w, clock, logged, me } = await sample({ stores: [5_000, 5_000, 5_000, 1_000, 0, 5_000, 0, 0] });
  clock.t += 11_000; logged();   // turn 43, once the province has caught up (and the camp's clash of turn 41 is resolved)
  const t = () => Math.floor(w.now());
  // a town has one farm: the next is the second copy: base x (1 + 0.5 x 1) = wood 120, stone 60; 3,600 + 1,800 x 2 seconds
  let s = me().stores;
  let r = w.order('Build', { item: 0 });
  assert.equal(r.ok, true);
  assert.deepEqual([s[1] - me().stores[1], s[2] - me().stores[2]], [120, 60]);
  // the queue is serial: it starts when the woodcutter before it ends
  assert.equal(r.doneAt, w.tollAt + LIVE.BUILT_AFTER + 7_200);
  assert.deepEqual(logged().map(x => [x.name, x.item, Number(x.done_at)]), [['BUILD', 0, r.doneAt]]);
  // a first quarry: food 40, wood 80; 90 minutes after the farm
  s = me().stores;
  const q = w.order('Build', { item: 2 });
  assert.deepEqual([q.ok, q.doneAt - r.doneAt, s[0] - me().stores[0], s[1] - me().stores[1]], [true, 5_400, 40, 80]);
  // a town's queue holds three: the fourth is refused
  assert.deepEqual([w.order('Build', { item: 3 }).code, me().queue.length], ['QueueFull', 3]);
  assert.equal(w.order('Build', { item: 8 }).code, 'BadData');
  // when the woodcutter is done a slot is free again at the next order (the touch collects it): a second woodcutter is copy 2
  clock.t += ((w.tollAt + LIVE.BUILT_AFTER + 5 - w.now()) / 30) * 1000;
  s = me().stores;
  const wc = w.order('Build', { item: 1 });
  assert.deepEqual([wc.ok, s[0] - me().stores[0], s[2] - me().stores[2], wc.doneAt - q.doneAt], [true, 60, 60, 7_200], 'food 40 x 1.5, stone 40 x 1.5, two hours');
  // the third copy of a kind: base x (1 + 0.5 x 4) = x 3, and 3,600 + 1,800 x 3 seconds
  const k = { tier: 1, production: R.baseProduction(1).map((x, i) => (i === 0 ? x + 24_000 : x)), queue: [null, null, null, null] };
  assert.deepEqual([R.copyNumber(k, 0), R.buildOrder(k, 0, 0).cost.slice(0, 3), R.buildOrder(k, 0, 0).secs], [3, [0, 240_000, 120_000], 9_000]);
  // production rises at the item's done time
  clock.t += ((r.doneAt + 10 - w.now()) / 30) * 1000;
  assert.equal(w.order('Harvest').ok, true);
  assert.deepEqual(me().perHour.slice(0, 2), [84, 55]);
  assert.ok(t() > r.doneAt);
});

test('Build: a hamlet\'s two slots, what the stores do not cover, the walls and their cap, the tier-up and what it changes', async () => {
  // ---- a hamlet (just landed): two slots; the starter kit pays for little
  const h = await sample({ stage: 'provisional' });
  assert.deepEqual(h.me().stores, [303, 302, 201, 101, 0, 101, 0, 0].map((x, i) => x - [0, 0, 0, 0, 0, 0, 0, 0][i]), 'the starter kit 300/300/200/100/100 and a few minutes of a hamlet\'s 40/30/20/15/15/5 an hour');
  assert.deepEqual(h.me().perHour, [40, 30, 20, 15, 0, 15, 5, 0]);
  assert.equal(h.w.order('Build', { item: 0 }).ok, true);
  const first = h.me().queue[0];
  assert.ok(Math.abs(first.doneIn - 5_400) <= 1, 'a first copy takes 90 minutes');
  assert.equal(h.w.order('Build', { item: 1 }).ok, true);
  assert.equal(h.w.order('Build', { item: 2 }).code, 'QueueFull', 'a hamlet builds two things at a time');
  assert.equal(h.w.order('Build', { item: R.ITEM_TIER_UP }).code, 'Insufficient', 'a town costs wood 1,000, stone 600, gold 300');
  // ---- a town with full stores: walls, then the tier-up
  const { w, clock, logged, me } = await sample({ stores: [6_000, 6_000, 6_000, 6_000, 0, 6_000, 0, 0] });
  clock.t += 11_000; logged();
  let s = me().stores;
  const wall = w.order('Build', { item: R.ITEM_WALLS });
  assert.equal(wall.ok, true);
  assert.equal(s[2] - me().stores[2], 285, 'stone 300, 5% less for the Wardens of Stone');
  assert.equal(wall.doneAt - (w.tollAt + LIVE.BUILT_AFTER), 4 * 3_600, 'four hours, after the woodcutter');
  const m = w.province(HOME.p, HOME.q).siteMirror[HOME.site];
  assert.deepEqual([m.wallItem0Delta, m.wallItem0Bell], [100, Math.floor((wall.doneAt - GENESIS_TS) / 600) + 1], 'the Province\'s site mirror carries the wall item, in force from the bell after it is done');
  logged();
  // the tier-up: 4,000 / 3,000 / 1,500 and twelve hours; one at a time
  s = me().stores;
  const up = w.order('Build', { item: R.ITEM_TIER_UP });
  assert.deepEqual([up.ok, s[1] - me().stores[1], s[2] - me().stores[2], s[5] - me().stores[5], up.doneAt - wall.doneAt], [true, 4_000, 3_000, 1_500, 12 * 3_600]);
  assert.equal(w.order('Build', { item: R.ITEM_TIER_UP }).code, 'QueueFull');
  assert.deepEqual(logged().map(x => [x.name, x.item]), [['BUILD', 7]]);
  // when it is done (and the village is touched): a city: base production x 2 of a hamlet's, stores of 15,000, four slots
  clock.t += ((up.doneAt + 5 - w.now()) / 30) * 1000;
  assert.equal(me().tier, 1, 'not before an owner action settles it (the program writes the tier at the touch)');
  assert.equal(w.order('Harvest').ok, true);
  const city = me();
  assert.deepEqual([city.tier, city.walls, city.perHour.slice(0, 4)], [2, 100, [92, 70, 40, 30]], 'city: 80/60/40/30 and the farm, the woodcutter');
  assert.deepEqual([R.WORKED_RADIUS, R.QUEUE_SLOTS, R.STORAGE_CAP.map(x => x / 1000)], [[1, 2, 2, 3], [2, 3, 4, 4], [2_000, 6_000, 15_000, 40_000]]);
  // two walls may be under way at a time: the Province's site mirror carries two wall items
  for (let i = 0; i < 2; i++) assert.equal(w.order('Build', { item: R.ITEM_WALLS }).ok, true, `wall ${i + 2}`);
  assert.equal(w.order('Build', { item: R.ITEM_WALLS }).code, 'QueueFull');
  assert.equal(me().queue.length, 2);
  // the cap of 1,200 wall points counts what is queued
  const k = { tier: 3, production: R.baseProduction(3), queue: [{ kind: R.QK.WALLS, arg: 0, delta: 100, doneAt: 9 }, null, null, null], walls: 1_100 };
  assert.deepEqual(R.enqueue(k, 0, 10, { kind: R.QK.WALLS, arg: 0, delta: 100 }), { error: 'AboveCap' });
});

test('Train: an instant purchase into the reserve, per started hundred, by the unit\'s cost; the Settler and nothing are refused', async () => {
  const { w, logged, me } = await sample({ stores: [6_000, 0, 0, 2_000, 0, 2_000, 0, 0] });
  // food 60 a hundred always; ore and gold by the unit (20 / 10 for a Spearman, x production cost / 6, rounded down)
  const table = [[20, 10], [23, 11], [30, 15], [40, 20], [46, 23], [53, 26], [33, 16]];
  table.forEach(([ore, gold], unit) => {
    const s = me().stores, r0 = me().reserve[unit];
    assert.equal(w.order('Train', { unit, n: 100 }).ok, true);
    assert.deepEqual([s[0] - me().stores[0], s[3] - me().stores[3], s[5] - me().stores[5], me().reserve[unit] - r0], [60, ore, gold, 100], `unit ${unit}`);
  });
  assert.deepEqual(logged().map(x => [x.name, x.unit, x.n]), table.map((_, unit) => ['TRAIN', unit, 100]));
  // a started hundred is paid in full
  const s = me().stores;
  assert.equal(w.order('Train', { unit: 0, n: 101 }).ok, true);
  assert.deepEqual([s[0] - me().stores[0], s[3] - me().stores[3], me().reserve[0]], [120, 40, 501]);
  assert.equal(w.order('Train', { unit: 7, n: 100 }).code, 'BadData', 'no Settlers in M1');
  assert.equal(w.order('Train', { unit: 0, n: 0 }).code, 'BadData');
  assert.equal(w.order('Train', { unit: 5, n: 10_000 }).code, 'Insufficient');
  // the starter kit buys five hundred Spearmen at most: ore is the limit
  const h = await sample({ stage: 'provisional' });
  assert.equal(h.w.order('Train', { unit: 0, n: 500 }).ok, true, 'allowed while the village is provisional');
  assert.equal(h.w.order('Train', { unit: 0, n: 100 }).code, 'Insufficient');
  assert.deepEqual(h.me().reserve[0], 500);
});

test('Muster: onto a chosen passable tile of the home province, in the roster from the next turn; such a host marches (it was refused)', async () => {
  const { w, clock, logged, me, host } = await sample();
  clock.t += 11_000; logged();   // turn 43, once the province has caught up (and the camp's clash of turn 41 is resolved)
  const pv = w.province(HOME.p, HOME.q), tile = openTile(pv, HOME.tile, 2);
  const blocked = [...Array(61).keys()].find(t => !passable(pv, t));
  assert.equal(w.order('Muster', { unit: 0, troops: 200, tile: blocked }).code, 'BadData', 'not on a mountain or on water');
  assert.equal(w.order('Muster', { unit: 0, troops: 99, tile }).code, 'Kernel', 'a host is at least 100 troops');
  assert.equal(w.order('Muster', { unit: 0, troops: 301, tile }).code, 'Insufficient');
  assert.equal(w.order('Muster', { unit: 7, troops: 100, tile }).code, 'BadData');
  const r = w.order('Muster', { unit: 0, troops: 200, tile });
  assert.equal(r.ok, true);
  assert.equal(r.host, hostId({ ...HOME, seq: 10 }));
  assert.deepEqual(logged().map(x => [x.name, x.host_id, x.unit, x.troops, x.tile]), [['MUSTER', r.host, 0, 200, tile]]);
  assert.deepEqual([me().reserve[0], host(r.host).state, host(r.host).tile, host(r.host).fromBell, host(r.host).stamina], [100, R.ES.MUSTER_PENDING, tile, 44, 120]);
  // muster-pending it cannot march; it stands in the roster once its turn is resolved (the turn after next has begun)
  const m = sealed(r.host, { ...HOME, tile }, { ...HOME, tile: openTile(pv, tile, 1, [tile]) }, { arrive: 47 });
  assert.equal(depart(w, r.host, m, 0, { arrive: 45 }).code, 'NotResident');
  w.pause(true);
  w.advance();
  assert.equal(host(r.host).state, R.ES.MUSTER_PENDING, 'turn 44: it fights from now on, its own turn is not resolved yet');
  w.advance();
  assert.equal(host(r.host).state, R.ES.ROSTER, 'turn 45');
  assert.equal(depart(w, r.host, m, 0, { arrive: 47 }).ok, true, 'a host formed by Muster marches');
  assert.deepEqual(logged().filter(x => x.name === 'DEPART').map(x => [x.host_id, x.origin_tile, x.arrive_bell]), [[r.host, tile, 47]]);
  // eight hosts of a nation in a province: the ninth is refused
  const full = await sample({ stores: [9_000, 0, 0, 9_000, 0, 9_000, 0, 0] });
  assert.equal(full.w.order('Train', { unit: 0, n: 1_000 }).ok, true);
  for (let i = 0; i < 6; i++) assert.equal(full.w.order('Muster', { unit: 0, troops: 100, tile: HOME.tile }).ok, true, `host ${i + 3}`);
  assert.equal(full.w.order('Muster', { unit: 0, troops: 100, tile: HOME.tile }).code, 'ProvinceFull');
});

test('Garrison and Dissolve take effect after the turn\'s clash; a withdrawal is refused; the troops of a dissolved host return to the reserve', async () => {
  const { w, clock, logged, me, host } = await sample();
  clock.t += 11_000; logged();   // turn 43, once the province has caught up (and the camp's clash of turn 41 is resolved)
  assert.equal(w.order('Garrison', { delta: 0n }).code, 'BadData');
  assert.equal(w.order('Garrison', { delta: -100n }).code, 'BadData', 'a garrison is only added to in M1');
  assert.equal(w.order('Garrison', { delta: 301n }).code, 'Insufficient', 'Spearmen of the reserve only');
  assert.equal(w.order('Garrison', { delta: 200n }).ok, true);
  assert.deepEqual([me().reserve[0], me().garrison], [100, 300], 'the reserve at once, the garrison after the turn\'s clash');
  assert.equal(w.order('Dissolve', { host_id: HOSTS.free }).ok, true);
  assert.equal(w.order('Dissolve', { host_id: HOSTS.free }).code, 'HostBusy');
  assert.equal(w.order('Dissolve', { host_id: hostId({ p: HOME.p, q: HOME.q, site: 7, gen: 0, seq: 3 }) }).code, 'NotOwner');
  assert.deepEqual(logged().map(x => [x.name, x.bell]), [['GARRISON', 43], ['DISSOLVE', 43]]);
  assert.equal(host(HOSTS.free).pending, R.OP.LEAVE);
  w.pause(true);
  w.advance(); w.advance();   // turn 45: turn 43 is resolved
  assert.deepEqual([me().garrison, host(HOSTS.free), me().reserve[0]], [500, null, 700]);
  assert.ok(logged().some(x => x.name === 'DEPARTURE_SETTLED' && x.host_id === HOSTS.free && x.destroyed === 2), 'the return settle');
});

test('Explore: a Scout host, up to two tiles within one hex, not yet explored, one exploration at a time; the result after the turn\'s seed, 4 Works a tile for the first three', async () => {
  const { w, clock, logged, me } = await sample();
  clock.t += 11_000; logged();   // turn 43, once the province has caught up (and the camp's clash of turn 41 is resolved)
  const pv = w.province(HOME.p, HOME.q), near = [...Array(61).keys()].filter(t => t !== HOME.tile && hexDistance(TILE_OFFSETS[t].q, TILE_OFFSETS[t].r, TILE_OFFSETS[HOME.tile].q, TILE_OFFSETS[HOME.tile].r) === 1);
  const far = [...Array(61).keys()].find(t => hexDistance(TILE_OFFSETS[t].q, TILE_OFFSETS[t].r, TILE_OFFSETS[HOME.tile].q, TILE_OFFSETS[HOME.tile].r) === 2);
  const ex = (host, tiles) => w.order('Explore', { host_id: host, n: tiles.length, tiles: Uint8Array.of(tiles[0], tiles[1] ?? 0) });
  assert.equal(ex(HOSTS.free, [near[0]]).code, 'BadData', 'Spearmen do not explore');
  assert.equal(ex(HOSTS.scout, [far]).code, 'BadData', 'two hexes away');
  assert.equal(ex(HOSTS.scout, [near[0], near[0]]).code, 'BadData');
  assert.equal(w.order('Explore', { host_id: HOSTS.scout, n: 3, tiles: Uint8Array.of(near[0], near[1]) }).code, 'BadData');
  assert.equal(ex(HOSTS.scout, [near[0], near[1]]).ok, true);
  assert.deepEqual(w.summary().explored, [near[0], near[1]].sort((a, b) => a - b));
  assert.deepEqual(me().explore, { bell: 43, tiles: [near[0], near[1]] });
  assert.equal(ex(HOSTS.scout, [near[2]]).code, 'HostBusy', 'one exploration pending per village');
  assert.deepEqual(logged().map(x => [x.name, x.host_id, x.n]), [['EXPLORE', HOSTS.scout, 2]]);
  assert.equal(w.settleExploreNow().code, 'SeedNotReady', 'not before the turn\'s seed');
  // the seed of turn 43 comes after the turn has ended, the reveal window and the margin: a little into turn 45
  w.pause(true);
  w.advance();
  assert.deepEqual([me().explore?.bell, me().works], [43, 10], 'turn 44: still waiting (the 10 Works are the camp\'s, with the march that settled)');
  w.advance();
  assert.deepEqual([me().explore, me().works, me().floorLeft], [null, 18, 1], 'turn 45: 4 Works a tile, two of the three certain finds used');
  assert.deepEqual(logged().filter(x => x.name === 'EXPLORE_RESULT').map(x => [x.host_id, x.works, x.floor_used]), [[HOSTS.scout, 8, 2]]);
  assert.equal(w.settleExploreNow().code, 'AlreadyDone');
  assert.equal(ex(HOSTS.scout, [near[0]]).code, 'Explored', 'a tile is explored once, by whoever claims it first');
  // the next two tiles: the last certain find, then a find with chance one half by the turn's seed (the rules' own draw)
  assert.equal(ex(HOSTS.scout, [near[2], near[3]]).ok, true);
  w.advance(); w.advance();
  const seed = w.herald('/h/bell/45/region/13').body.caches[0].seed;
  const roll = R.exploreRoll(Uint8Array.from(seed.match(/../g), x => parseInt(x, 16)), HOME.p, HOME.q, near[3], HOSTS.scout, false);
  assert.ok(roll === 0 || roll === 4);
  assert.deepEqual([me().works, me().floorLeft], [18 + 4 + roll, 0]);
  // (the draw itself: the first 8 bytes of sha256(seed, len, domain, id), below 2 of 2^64)
  assert.equal(R.below(0x7fffffffffffffffn, 2), 0);
  assert.equal(R.below(0x8000000000000000n, 2), 1);
  assert.ok(pv.passableMask > 0n);
});

test('Depart: the seal, stamina 74 of 120 after the turn\'s clash, arrival at least two turns later, four marches out, and what is refused', async () => {
  const { w, clock, logged, me, host } = await sample({ stores: [9_000, 0, 0, 9_000, 0, 9_000, 0, 0] });
  clock.t += 11_000; logged();   // turn 43, once the province has caught up (and the camp's clash of turn 41 is resolved)
  const pv = w.province(HOME.p, HOME.q), a = openTile(pv, HOME.tile, 1), b = openTile(pv, HOME.tile, 2);
  const m = sealed(HOSTS.free, HOME, { ...HOME, tile: a }, { arrive: 45 });
  assert.equal(depart(w, HOSTS.free, m, 0, { arrive: 44 }).code, 'ArrivalBell', 'never the next turn');
  assert.equal(depart(w, HOSTS.free, m, 0, { arrive: 43 + 73 }).code, 'ArrivalBell', '72 turns at most');
  assert.equal(depart(w, HOSTS.free, m, 1, { arrive: 45 }).code, 'TransitState', 'a transit record in use');
  assert.equal(depart(w, HOSTS.free, m, 4, { arrive: 45 }).code, 'BadData');
  assert.equal(depart(w, HOSTS.free, m, 0, { arrive: 45, data: { tip: 1n } }).code, 'TipTooLow');
  assert.equal(depart(w, HOSTS.free, { ...m, seal: new Uint8Array(165) }, 0, { arrive: 45 }).code, 'BadData', 'a seal begins as a compressed point');
  assert.equal(depart(w, hostId({ p: HOME.p, q: HOME.q, site: 7, gen: 0, seq: 3 }), m, 0, { arrive: 45 }).code, 'NotOwner');
  assert.equal(depart(w, HOSTS.marching, m, 0, { arrive: 45 }).code, 'HostInTransit', 'the host that stands at the camp: its march is not settled yet');
  assert.equal(depart(w, HOSTS.free, m, 0, { arrive: 45 }).ok, true);
  const rec = logged().find(x => x.name === 'DEPART');
  assert.deepEqual([rec.host_id, rec.origin_p, rec.origin_q, rec.origin_tile, rec.depart_bell, rec.arrive_bell, rec.dep_mass, rec.march_stamina, rec.seal.length, toHex(rec.commit)], [HOSTS.free, HOME.p, HOME.q, HOME.tile, 43, 45, 600_000, 74, 165, toHex(m.commit)]);
  assert.ok(!('tile' in rec) && !('dest' in rec), 'a departure names no destination');
  // it still stands (and fights) this turn; the stamina is charged after the turn's clash
  assert.deepEqual([host(HOSTS.free).state, host(HOSTS.free).pending, host(HOSTS.free).stamina], [R.ES.ROSTER, R.OP.SPEND, 113]);
  assert.equal(depart(w, HOSTS.free, m, 2, { arrive: 45 }).code, 'HostBusy');
  assert.deepEqual(me().marches.map(x => [x.slot, x.state]), [[0, R.TS.DEPARTED], [1, R.TS.SETTLED]]);
  // four marches of a village at most: two more leave, the fifth finds no record
  assert.equal(w.order('Train', { unit: 0, n: 300 }).ok, true);
  const ids = [10, 11, 12].map(seq => hostId({ ...HOME, seq }));
  for (let i = 0; i < 3; i++) assert.equal(w.order('Muster', { unit: 0, troops: 100, tile: HOME.tile }).ok, true);
  w.pause(true);
  w.advance(); w.advance();   // turn 45
  assert.equal(host(HOSTS.free), null, 'departed: its entry is settled into the transit record');
  const tr = me().marches.find(x => x.slot === 0);
  assert.equal(tr.state, R.TS.SETTLED);
  for (const [i, slot] of [[0, 2], [1, 3]]) assert.equal(depart(w, ids[i], sealed(ids[i], HOME, { ...HOME, tile: b }, { arrive: 47 }), slot, { arrive: 47 }).ok, true);
  assert.equal(me().marches.length, 3, 'the march to the camp is settled by now, three are out');
  assert.equal(depart(w, ids[2], sealed(ids[2], HOME, { ...HOME, tile: b }, { arrive: 47 }), 1, { arrive: 47 }).ok, true, 'the freed record takes the fourth');
  for (const slot of [0, 1, 2, 3]) assert.equal(depart(w, HOSTS.scout, sealed(HOSTS.scout, HOME, { ...HOME, tile: b }, { unit: 6, arrive: 47 }), slot, { arrive: 47 }).code, 'TransitState');
  // a host that marched has 46 of 120 and one more each turn: 28 turns until it marches again
  assert.equal(R.DEPART_STAMINA, 74);
  assert.equal(R.staminaAt(46, 44, 44 + 27), 73);
  assert.equal(R.staminaAt(46, 44, 44 + 28), 74);
});

test('a march to an empty tile arrives and the host stays there: listed on that tile, in /h/me, ordered from there once its transit is settled', async () => {
  const { w, clock, v, logged, me, host } = await sample();
  clock.t += 11_000; logged();   // turn 43, once the province has caught up (and the camp's clash of turn 41 is resolved)
  const pv = w.province(HOME.p, HOME.q), tile = openTile(pv, HOME.tile, 3);
  const m = sealed(HOSTS.free, HOME, { ...HOME, tile }, { arrive: 45, stance: 2 });
  assert.equal(depart(w, HOSTS.free, m, 0, { arrive: 45 }).ok, true);
  logged();
  w.pause(true);
  w.advance(); w.advance();   // turn 45: the arrival turn; this device reveals its own order
  assert.equal(w.revealNow(0, m.plain, m.salt, m.ctHash).ok, true);
  assert.deepEqual(logged().filter(x => x.name === 'REVEAL').map(x => [x.p, x.q, x.arrive, x.host_id, x.tile, x.stance]), [[HOME.p, HOME.q, 45, HOSTS.free, tile, 2]]);
  assert.equal(w.revealNow(0, m.plain, m.salt, m.ctHash).code, 'AlreadyDone');
  const env = w.herald(`/h/province/${HOME.p},${HOME.q}/latest`).body;
  assert.deepEqual([env.bell, env.slots.map(s => s.key)], [45, [`ar:${HOME.p},${HOME.q},45,0,0`]], 'the arrival slot stands in the latest file of its turn');
  assert.equal(w.herald(`/h/province/${HOME.p},${HOME.q}/45`).body.v, 0, 'the turn\'s own file does not exist before the turn is resolved');
  w.advance();   // turn 46: the window
  assert.equal(host(HOSTS.free), null);
  w.advance();   // turn 47: turn 45 is resolved; the host stands on its tile
  const h = host(HOSTS.free);
  assert.deepEqual([h.province, h.tile, h.state, h.troops, h.fromBell, h.stamina], [[HOME.p, HOME.q], tile, R.ES.ROSTER, 600, 46, 43], 'all 600; stamina 110 at turn 40, one more each turn, less the march\'s 74 after turn 43');
  const mine = w.herald(`/h/me/${v.wallet}`).body;
  assert.deepEqual(mine.hosts.filter(x => x.id === String(HOSTS.free)).map(x => [x.province, x.tile, x.state, x.troops]), [[[HOME.p, HOME.q], tile, 1, 600_000]]);
  const closed = w.herald(`/h/province/${HOME.p},${HOME.q}/45`).body;
  assert.deepEqual([closed.v, closed.bell, closed.slots.length, closed.inputs.key], [1, 45, 1, `ci:${HOME.p},${HOME.q},45`]);
  const clash = logged().find(x => x.name === 'CLASH');
  assert.deepEqual([clash.bell, clash.engagements], [45, 0], 'an arrival with nobody to fight: the resolve records no engagement');
  // until SettleTransit has landed the host is still on its march in the Holding's record
  const again = sealed(HOSTS.free, { ...HOME, tile }, HOME, { arrive: 49 });
  assert.equal(depart(w, HOSTS.free, again, 2, { arrive: 49 }).code, 'HostInTransit');
  assert.equal(w.settleTransitNow(0).code, 'TooEarly');
  w.advance();   // turn 48: 600 s after the window closed
  assert.deepEqual(logged().filter(x => x.name === 'TRANSIT_SETTLED').map(x => [x.host_id, x.outcome, x.troops]), [[HOSTS.free, R.OUTCOME.STAYS, 600_000]]);
  assert.equal(me().marches.some(x => x.host === String(HOSTS.free)), false);
  // it cannot march again yet: 74 are needed
  assert.equal(depart(w, HOSTS.free, again, 0, { arrive: 50 }).code, 'Cooldown');
});

test('a march into the next province: the host stands there and /h/me lists it under that province', async () => {
  const { w, clock, v, host } = await sample();
  clock.t += 11_000;
  const to = { p: 1, q: 1, tile: 0 }, there = w.province(1, 1);
  const tile = [...Array(61).keys()].find(t => passable(there, t) && !there.sites.includes(t) && t !== there.camp.tile && K.call('plan_path', { start: tileHex(HOME.p, HOME.q, HOME.tile), dest: tileHex(1, 1, t), unit: 0, blocked: [], seeds: RINGS }).value);
  to.tile = tile;
  const m0 = sealed(HOSTS.free, HOME, to, { arrive: 0 });
  const early = K.call('earliest_arrival_bell', { genesis_ts: GENESIS_TS, depart_ts: Math.floor(w.now()), secs: m0.secs }).value;
  const arrive = Math.max(45, early), m = sealed(HOSTS.free, HOME, to, { arrive });
  assert.equal(depart(w, HOSTS.free, m, 0, { arrive }).ok, true);
  w.pause(true);
  while (w.turn() < arrive) w.advance();
  assert.equal(w.revealNow(0, m.plain, m.salt, m.ctHash).ok, true);
  w.advance(); w.advance();
  assert.deepEqual([host(HOSTS.free).province, host(HOSTS.free).tile, host(HOSTS.free).state], [[1, 1], tile, R.ES.ROSTER]);
  assert.deepEqual(w.herald(`/h/me/${v.wallet}`).body.hosts.filter(x => x.id === String(HOSTS.free)).map(x => x.province), [[1, 1]]);
  assert.ok(w.herald('/h/province/1,1/latest').body.bytes.length > 100);
});

test('the Reveal is judged as the program judges it: the path, the arrival bell, a shielded village; a march nobody revealed is routed', async () => {
  const { w, clock, logged, me, host } = await sample({ stores: [9_000, 0, 0, 9_000, 0, 9_000, 0, 0] });
  clock.t += 11_000; logged();   // turn 43, once the province has caught up (and the camp's clash of turn 41 is resolved)
  assert.equal(w.order('Train', { unit: 0, n: 300 }).ok, true);
  for (let i = 0; i < 3; i++) assert.equal(w.order('Muster', { unit: 0, troops: 100, tile: HOME.tile }).ok, true);
  const ids = [10, 11, 12].map(seq => hostId({ ...HOME, seq }));
  w.pause(true);
  w.advance(); w.advance();   // turn 45
  const pv = w.province(HOME.p, HOME.q), cinder = { ...HOME, tile: pv.sites[7] }, open = openTile(pv, HOME.tile, 2);
  // (a) to the village of another nation: its founding shield (48 hours) stands, and so does the viewer's own
  const a = sealed(ids[0], HOME, cinder, { arrive: 47 });
  // (b) a path that does not end on the destination; (c) nobody reveals; (d) too early for the road it takes
  const b = sealed(ids[1], HOME, { ...HOME, tile: open }, { arrive: 47, dirs: [0] });
  const far = [...Array(61).keys()].filter(t => passable(pv, t) && !pv.sites.includes(t) && t !== pv.camp.tile).map(t => ({ t, plan: K.call('plan_path', { start: tileHex(HOME.p, HOME.q, HOME.tile), dest: tileHex(HOME.p, HOME.q, t), unit: 0, blocked: [], seeds: RINGS }).value })).filter(x => x.plan).sort((x, y) => y.plan.secs - x.plan.secs)[0];
  const c = sealed(ids[2], HOME, { ...HOME, tile: far.t }, { arrive: 47 });
  assert.equal(depart(w, ids[0], a, 0, { arrive: 47 }).ok, true);
  assert.equal(depart(w, ids[1], b, 2, { arrive: 47 }).ok, true, 'Depart cannot see the sealed order: the Reveal judges it');
  assert.equal(depart(w, ids[2], c, 3, { arrive: 47 }).ok, true);
  w.advance(); w.advance();   // turn 47
  assert.equal(w.revealNow(0, a.plain, a.salt, a.ctHash).code, 'Shielded');
  assert.equal(w.revealNow(2, b.plain, b.salt, b.ctHash).code, 'Path');
  assert.equal(w.revealNow(2, a.plain, a.salt, a.ctHash).code, 'BadPlaintext', 'another march\'s order');
  assert.equal(w.revealNow(3, c.plain, new Uint8Array(32), c.ctHash).code, 'CommitMismatch');
  assert.deepEqual(logged().filter(x => x.name === 'REVEAL'), [], 'a refused reveal writes nothing');
  assert.deepEqual(me().marches.map(x => x.revealed), [false, false, false]);
  // the shield of a village founded on day 0 lasts 48 hours of the game: 288 turns
  assert.equal(me().shieldUntilBell, Math.ceil((1_300 + 48 * 3_600) / 600));
  assert.equal(pv.siteMirror[7].shieldUntilBell, me().shieldUntilBell);
  // the window closes 600 s (and the anchor's two) after the arrival turn ended: a late reveal is refused
  w.advance(); w.advance();   // turn 49
  assert.equal(w.revealNow(3, c.plain, c.salt, c.ctHash).code, 'WindowClosed');
  // routed: home, with half the troops and no stamina, forming up again at the village
  w.advance();   // turn 50: the transits of turn 47 are settled
  assert.deepEqual(logged().filter(x => x.name === 'TRANSIT_SETTLED').map(x => [x.host_id, x.outcome, x.troops]).sort(), ids.map(id => [id, R.OUTCOME.ROUTED, 50_000]).sort());
  assert.deepEqual(ids.map(id => { const h = host(id); return [h.troops, h.tile, h.state, h.stamina]; }), ids.map(() => [50, HOME.tile, R.ES.MUSTER_PENDING, 0]));
  assert.equal(me().marches.length, 0);
  // the arrival bell against the road: a march sealed for a turn its road cannot make is refused at the Reveal
  const d = await sample();
  d.clock.t += 11_000;
  const from = tileHex(HOME.p, HOME.q, HOME.tile);
  const long = [[1, 1], [2, -1]].flatMap(([p, q]) => [...Array(61).keys()].map(t => ({ p, q, tile: t, plan: K.call('plan_path', { start: from, dest: tileHex(p, q, t), unit: 0, blocked: [], seeds: RINGS }).value })))
    .filter(x => x.plan && x.plan.dirs.length <= 32 && x.plan.secs > 1_300).sort((x, y) => x.plan.secs - y.plan.secs)[0];
  assert.ok(long, 'a road of more than two turns exists');
  const slow = sealed(HOSTS.free, HOME, long, { arrive: 45 });
  assert.equal(depart(d.w, HOSTS.free, slow, 0, { arrive: 45 }).ok, true, 'Depart only asks for two turns');
  d.w.pause(true); d.w.advance(); d.w.advance();
  assert.equal(d.w.revealNow(0, slow.plain, slow.salt, slow.ctHash).code, 'ArrivalBell');
});

test('the first minute of a turn: the province has not caught up, and a resident order is refused as the program refuses it; then it is taken', async () => {
  const { w, clock } = await sample();
  // a turn is resolved W (600 s) and the seed margin (60 s) after the turn before it ended: about 65 s into each turn
  clock.t += 8_000 + 1_000;   // 30 game seconds into turn 43: turn 41 is not resolved yet
  assert.deepEqual([w.turn(), w.summary().resolvedNext], [43, 41]);
  assert.equal(R.residentOk(41, 43), false);
  assert.equal(w.order('Muster', { unit: 0, troops: 100, tile: HOME.tile }).code, 'NotResident');
  assert.equal(w.order('Garrison', { delta: 100n }).code, 'NotResident');
  assert.equal(w.order('Dissolve', { host_id: HOSTS.free }).code, 'NotResident');
  assert.equal(w.order('Harvest').ok, true, 'what is not a resident action is taken at once');
  assert.equal(w.order('Train', { unit: 0, n: 100 }).ok, true);
  clock.t += 1_500;   // 75 game seconds in
  assert.equal(w.summary().resolvedNext, 42);
  assert.equal(w.order('Muster', { unit: 0, troops: 100, tile: HOME.tile }).ok, true);
});

test('a clash at the camp is the rules kernel\'s: the report, the fates, the camp cleared, 10 Works to the host that stays', async () => {
  const { w, clock, logged, me, host } = await sample();
  // the march that reached the camp last turn (400 Spearmen, revealed): resolved a little into turn 43
  assert.deepEqual(me().marches.map(x => [x.host, x.arriveBell, x.revealed]), [[String(HOSTS.marching), 41, true]]);
  assert.equal(w.herald(`/h/clash/${HOME.p},${HOME.q}/41`), null);
  clock.t += 8_000 + 3_000;   // three wall seconds into turn 43
  const s = w.summary();
  assert.deepEqual([s.turn, s.resolvedNext, s.camp.state, s.camp.troops], [43, 42, 0, 0]);
  const rec = logged();
  assert.deepEqual(rec.map(x => x.name), ['CAMP', 'CLASH']);
  assert.deepEqual([rec[0].tile, rec[0].troops, rec[1].bell, rec[1].p, rec[1].q, rec[1].engagements], [CAMP_TILE, 0, 41, HOME.p, HOME.q, 1]);
  const report = w.herald(`/h/clash/${HOME.p},${HOME.q}/41`).body;
  assert.deepEqual([report.bell, report.province, report.outcomeDigest, report.builder], [41, [HOME.p, HOME.q], toHex(rec[1].outcome_digest), 'kernel']);
  // the same clash asked of the kernel here, from the report's own bytes: the digest the world logged
  const { decodeClashOut, outcomeDigest } = await import('../../permutation-server/web/frontier/screens/report.mjs');
  const { fromBase64 } = await import('../../permutation-server/web/sdk/bytes.mjs');
  const { decode } = await import('../../permutation-server/web/frontier/fcodec.mjs');
  const inputs = decode('ClashInputs', fromBase64(report.inputs_b64));
  const arr = inputs.arrivals[0];
  assert.deepEqual([inputs.flags & 2, inputs.nPresent, arr.present, arr.hostId, arr.troops, arr.tile, arr.stance, arr.fate, inputs.campMask], [2, 1, 1, HOSTS.marching, 400_000, CAMP_TILE, 1, R.FATE.STAYS, 1]);
  const again = K.call('resolve_from_inputs', { province: fromBase64(report.province_before_b64), inputs: fromBase64(report.inputs_b64), bell: 41, seed: report.seed });
  const out = decodeClashOut(again.value);
  assert.equal(out.digest, report.outcomeDigest);
  assert.equal(outcomeDigest(out.outcome), report.outcomeDigest);
  const f = out.outcome.fighters.find(x => x.arrival);
  assert.deepEqual([f.fate.kind, f.fate.tile, f.engaged, f.troops], ['Stays', CAMP_TILE, true, arr.troopsAfter]);
  assert.ok(f.troops < 400_000 && f.troops > 300_000, `400 Spearmen beat a camp of 250 and lose some (${f.troops})`);
  assert.equal(out.outcome.garrisons.find(g => g.faction === undefined && g.troops === 0)?.troops ?? 0, 0);
  // the host stands on the camp's tile with what the kernel left it, tired by the fight
  const h = host(HOSTS.marching);
  assert.deepEqual([h.province, h.tile, h.state, h.troops, h.fromBell, h.readyBell], [[HOME.p, HOME.q], CAMP_TILE, R.ES.ROSTER, Math.floor(f.troops / 1000), 42, 43]);
  assert.equal(h.stamina, f.stamina + 2, 'two turns of rest since');
  assert.equal(me().works, 0);
  // SettleTransit, 600 s after the window closed: the camp's Works to the host that stays
  clock.t += 20_000;
  assert.deepEqual(logged().filter(x => x.name === 'TRANSIT_SETTLED').map(x => [x.host_id, x.outcome]), [[HOSTS.marching, R.OUTCOME.STAYS]]);
  assert.deepEqual([me().works, me().marches.length], [10, 0]);
  // a camp is fought by whoever comes: 100 Spearmen against 250 do not take it
  const weak = await sample({ stores: [1_200, 800, 650, 300, 0, 120, 40, 0] });
  const lone = await sample({ stage: 'provisional' });
  assert.equal(lone.w.order('Train', { unit: 0, n: 100 }).ok, true);
  lone.clock.t += 8_000 + 3_000;
  assert.equal(lone.w.order('Muster', { unit: 0, troops: 100, tile: HOME.tile }).ok, true);
  lone.w.pause(true);
  lone.w.advance(); lone.w.advance();
  const id = hostId({ ...HOME, seq: 0 }), m = sealed(id, HOME, { ...HOME, tile: CAMP_TILE }, { arrive: 47, stance: 1 });
  assert.equal(depart(lone.w, id, m, 0, { arrive: 47 }).ok, true);
  lone.w.advance(); lone.w.advance();
  assert.equal(lone.w.revealNow(0, m.plain, m.salt, m.ctHash).ok, true);
  lone.w.advance(); lone.w.advance();
  const camp = lone.w.summary().camp;
  assert.equal(camp.state, 1, 'the camp stands');
  assert.ok(camp.troops < 250 && camp.troops > 100, `it lost some (${camp.troops})`);
  assert.equal(lone.host(id), null, 'the host is not on the tile');
  lone.w.advance();
  const settled = lone.logged().filter(x => x.name === 'TRANSIT_SETTLED');
  assert.equal(settled.length, 1);
  assert.ok([R.OUTCOME.DESTROYED, R.OUTCOME.BOUNCED, R.OUTCOME.RETREATED, R.OUTCOME.WITHDREW].includes(settled[0].outcome), `outcome ${settled[0].outcome}`);
  assert.ok(weak);
});

test('a village just landed is provisional: Harvest, Build and Train only; final at its time, written at the first resident action', async () => {
  const { w, clock, logged, me } = await sample({ stage: 'provisional' });
  assert.deepEqual([me().state, me().tier, me().hosts.length, me().reserve[0]], [1, 0, 0, 0]);
  assert.equal(w.order('Harvest').ok, true);
  assert.equal(w.order('Build', { item: 0 }).ok, true);
  assert.equal(w.order('Train', { unit: 0, n: 200 }).ok, true);
  assert.equal(w.order('Train', { unit: 6, n: 100 }).ok, true);
  assert.equal(w.order('Muster', { unit: 0, troops: 100, tile: HOME.tile }).code, 'NotFinal');
  assert.equal(w.order('Garrison', { delta: 100n }).code, 'NotFinal');
  assert.deepEqual(logged().map(x => x.name), ['HARVEST', 'BUILD', 'TRAIN', 'TRAIN']);
  // final 600 s after its ticket's seed round: a little into turn 43
  assert.ok(me().finalAt > w.tollAt && me().finalAt < w.tollAt + 120);
  clock.t += ((me().finalAt - 5 - w.now()) / 30) * 1000;
  assert.equal(w.order('Muster', { unit: 0, troops: 100, tile: HOME.tile }).code, 'NotFinal');
  clock.t += 500;
  assert.equal(me().state, 1, 'no instruction writes it before a resident action');
  assert.equal(w.order('Garrison', { delta: 0n }).code, 'BadData', 'a refused action does not make it final either');
  assert.equal(me().state, 1);
  const r = w.order('Muster', { unit: 0, troops: 100, tile: HOME.tile });
  assert.equal(r.ok, true);
  assert.deepEqual(logged().map(x => x.name), ['HOLDING_FINAL', 'MUSTER']);
  assert.equal(me().state, 2);
  const s = w.records();
  assert.deepEqual(s.map(x => x.seq), s.map((_, i) => 800 + i), 'the log\'s numbers run on');
  // a scout host of the new village explores, a host marches: nothing is held back any more
  assert.equal(w.order('Muster', { unit: 6, troops: 100, tile: HOME.tile }).ok, true);
});

test('the action bucket: 60 stored, 30 an hour of the game; an empty bucket refuses, and a refused order costs nothing', async () => {
  const { w, clock } = await sample();
  w.pause(true);
  assert.equal(w.summary().me.bucket, 60);
  assert.equal(w.order('Train', { unit: 7, n: 1 }).code, 'BadData');
  assert.equal(w.summary().me.bucket, 60, 'a refused order is not debited');
  for (let i = 0; i < 60; i++) assert.equal(w.order('Harvest').ok, true, `order ${i + 1}`);
  assert.equal(w.order('Harvest').code, 'Bucket');
  w.pause(false);
  clock.t += 4_000;   // 120 game seconds: one token
  assert.equal(w.order('Harvest').ok, true);
  assert.equal(w.order('Harvest').code, 'Bucket');
});

test('the neighbours: other nations\' hosts march by a seeded script through the same Depart and Reveal; a sealed march shows no destination until its arrival turn has ended', async () => {
  const { w, clock } = await sample({ neighbours: true });
  const nb = w.summary().neighbours;
  assert.equal(nb.length, 3);
  assert.deepEqual(nb.map(n => n.nation), [2, 4, 5]);
  assert.ok(nb.every(n => n.nation !== 0), 'other nations');
  // one is on its way when the world starts: its departure is in the log, with its origin and arrival turn and no destination
  const dep = w.records().filter(x => x.kind === 30 && x.fields.origin_tile !== HOME.tile);
  assert.equal(dep.length, 1);
  const d = dep[0].fields;
  assert.deepEqual(Object.keys(d).sort(), ['arrive_bell', 'commit', 'dep_mass', 'depart_bell', 'host_id', 'march_stamina', 'origin_p', 'origin_q', 'origin_tile', 'seal', 'seal_root', 'tip'].sort());
  assert.deepEqual([d.origin_p, d.origin_q, d.origin_tile, d.depart_bell], [HOME.p, HOME.q, w.province(HOME.p, HOME.q).sites[7], 41]);
  const arrive = d.arrive_bell;
  assert.ok(arrive >= 43);
  // nothing of it is revealed while its arrival turn runs; the keeper opens it when the turn has ended
  w.pause(true);
  while (w.turn() < arrive + 1) w.advance({ into: 0 });
  const revealed = () => w.records().filter(x => x.kind === 31 && x.fields.host_id === d.host_id);
  assert.deepEqual(revealed(), [], 'its arrival turn has just ended: still sealed');
  assert.equal(w.herald(`/h/province/${HOME.p},${HOME.q}/latest`).body.slots.length, 0);
  w.pause(false);
  clock.t += 200;   // six game seconds: the anchor of the turn that ended is posted
  const rv = revealed();
  assert.equal(rv.length, 1);
  assert.ok(rv[0].bell > arrive, 'revealed after its arrival turn ended');
  const tile = rv[0].fields.tile, pv = w.province(HOME.p, HOME.q);
  assert.ok(passable(pv, tile) && !pv.sites.includes(tile) && tile !== CAMP_TILE, 'an open tile of the viewer\'s province');
  // two turns on it stands there: a host of another nation in the viewer's province
  w.advance(); w.advance();
  const there = w.province(HOME.p, HOME.q).entries.find(e => e.id === d.host_id);
  assert.deepEqual([there.tile, there.state, there.faction, there.troops], [tile, R.ES.ROSTER, 2, 200_000]);
  assert.ok(w.reveals.every(x => x.by === 'keeper' && x.ok), JSON.stringify(w.reveals, (k, v) => (typeof v === 'bigint' ? String(v) : v)));
  assert.ok(w.npcLog.every(x => x.ok), 'the script orders nothing the program refuses');
  // a world without neighbours has none
  const alone = await sample();
  assert.deepEqual(alone.w.summary().neighbours, []);
  assert.ok(clock.t > 0);
});

test('the world keeps going: 160 turns of orders, marches, fights between nations and camps that come back, and it never leaves the rules', async () => {
  const { decodeRecord } = await import('../../permutation-server/web/frontier/flog.mjs');
  const { w, me } = await sample({ neighbours: true, stores: [9_000, 9_000, 9_000, 9_000, 0, 9_000, 0, 0] });
  w.pause(true);
  const marches = new Map(), codes = {};
  const tally = r => { const k = r.ok ? 'ok' : r.code; codes[k] = (codes[k] ?? 0) + 1; return r; };
  for (let i = 0; i < 160; i++) {
    w.advance();
    const m = me(), turn = w.turn();
    assert.equal(w.summary().resolvedNext, turn - 1, 'every turn the turn before last is resolved');
    if (i % 7 === 0) tally(w.order('Train', { unit: i % 3 === 0 ? 2 : 0, n: 200 }));
    if (i % 7 === 1) tally(w.order('Muster', { unit: i % 3 === 1 ? 2 : 0, troops: 200, tile: HOME.tile }));
    if (i % 11 === 0) tally(w.order('Build', { item: i % 6 }));
    if (i % 13 === 0) tally(w.order('Harvest'));
    if (i % 17 === 0) tally(w.order('Garrison', { delta: 50n }));
    for (const [slot, x] of marches) if (x.arrive === turn) { tally(w.revealNow(slot, x.m.plain, x.m.salt, x.m.ctHash)); marches.delete(slot); }
    // a ready host marches: onto another nation's host when one stands in the province, else onto some tile
    const ready = m.hosts.find(h => h.state === 1 && h.stamina >= 74 && !h.pending && !m.marches.some(z => z.host === h.id) && h.unit !== 6 && h.readyBell <= turn);
    const slot = [0, 1, 2, 3].find(x => !m.marches.some(z => z.slot === x));
    if (ready && slot !== undefined && i % 3 === 0) {
      const foes = w.province(HOME.p, HOME.q).entries.filter(e => e.state === 1 && e.faction !== 0);
      const tile = foes.length && i % 2 ? foes[i % foes.length].tile : (7 + i * 5) % 61, arrive = turn + 2 + (i % 2);
      const from = { p: ready.province[0], q: ready.province[1], tile: ready.tile };
      if (K.call('plan_path', { start: tileHex(from.p, from.q, from.tile), dest: tileHex(HOME.p, HOME.q, tile), unit: ready.unit, blocked: [], seeds: RINGS }).value) {
        const sm = sealed(BigInt(ready.id), from, { ...HOME, tile }, { unit: ready.unit, arrive, stance: i % 4 });
        if (tally(depart(w, BigInt(ready.id), sm, slot, { arrive, province: from })).ok) marches.set(slot, { arrive, m: sm });
      }
    }
    // no host is left with a change of a resolved turn; nothing below zero; no more hosts than the caps
    for (const [p, q] of [[HOME.p, HOME.q], [1, 1], [2, -2]]) {
      const pv = w.province(p, q), live = pv.entries.filter(e => e.state !== 0);
      assert.ok(live.every(e => e.pendOp === 0 || e.pendBell >= pv.resolvedNext || e.state === 3), `a pending change outlived its turn in ${p},${q} at turn ${turn}`);
      assert.ok(live.every(e => e.troops >= 0 && e.troops <= R.MAX_HOST_TROOPS && e.staminaValue <= 120));
      assert.ok(live.filter(e => e.state === 1 || e.state === 2).length <= R.PROVINCE_HOST_CAP);
      for (let f = 0; f < 6; f++) assert.ok(live.filter(e => (e.state === 1 || e.state === 2) && e.faction === f).length <= R.FACTION_RESIDENT_CAP + 4, 'the nation\'s cap (arrivals are admitted by the kernel\'s own room)');
    }
    assert.ok(m.stores.every(v => v >= 0 && v <= 9_000), 'no store falls below nothing or grows past what it began with above its cap');
  }
  // what was refused is what the rules refuse (a full province, a full queue, a village behind its shield), nothing else
  assert.deepEqual(Object.keys(codes).filter(k => !['ok', 'ProvinceFull', 'QueueFull', 'Shielded', 'Insufficient', 'Path', 'Cooldown'].includes(k)), [], JSON.stringify(codes));
  assert.ok(codes.ok > 100, JSON.stringify(codes));
  assert.ok(w.npcLog.length >= 6 && w.npcLog.every(x => x.ok), `the neighbours marched ${w.npcLog.length} times and were never refused`);
  assert.ok(w.reveals.filter(x => x.by === 'keeper').every(x => x.ok));
  // every record is one the page's log reader decodes, or one of the two kinds it does not read
  const kinds = {};
  for (const r of w.records()) { kinds[NAMES[r.kind] ?? r.kind] = (kinds[NAMES[r.kind] ?? r.kind] ?? 0) + 1; const d = decodeRecord(W.record(r.kind, r.bell, r.fields)); assert.ok(d || [24, 25].includes(r.kind)); }
  assert.ok(kinds.CLASH >= 20 && kinds.TRANSIT_SETTLED >= 20 && kinds.CAMP >= 2, JSON.stringify(kinds));
  // a camp comes back with the day's check (one half a day, in a province with a village): the second day has begun
  assert.ok(w.turn() >= 144 && w.summary().camp.nextCheckDay >= 2);
});
