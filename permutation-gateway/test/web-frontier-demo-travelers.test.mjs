// The walletless demo's travelers (demo-npc-merchants; owner r0ze 2026-11-28 16:21, NPCs part 2: merchants / travelers
// that walk the map, the player trades with them or talks to them). screens/travelers.mjs (pure), the sample world's
// `travelers` option (liveworld.mjs: GET /h/demo/travelers, POST /gw/f/sample/trade), the save's sections
// (demo/src/save.mjs) and the page's panel model (demo/src/travelhud.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as W from '../screens/world.mjs';
import { createLive } from '../screens/liveworld.mjs';
import * as TV from '../screens/travelers.mjs';
import { createClock, createRecorder, readSave, replay, SAVE_KEY } from '../demo/src/save.mjs';
import { DIRECTIONS, ringOf, tileHex, hexDistance } from '../../permutation-server/web/frontier/fgeo.mjs';

const src = f => readFileSync(new URL(f, import.meta.url), 'utf8');
const memStorage = () => { const m = new Map(); return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k), get map() { return m; } }; };
const world = async (opts = {}) => createLive({ viewer: await W.viewer({ keyless: true }), keyless: true, territory: true, paused: true, nations: true, landClaim: true, stage: 'holding', travelers: true, ...opts });
const passableOf = live => (p, q, t) => { const pv = live.province(p, q); return !!pv && ((pv.passableMask >> BigInt(t)) & 1n) === 1n; };
const trade = (live, body) => live.relay('POST', '/gw/f/sample/trade', body).then(r => r?.body ?? null);
const adjacent = (a, b) => DIRECTIONS.some(([dq, dr]) => a.q + dq === b.q && a.r + dr === b.r);

test('the numbers: buying a lot always costs more food than selling one brings (no round-trip gain), at every step and bias', () => {
  const R = TV.TRAVELERS_V1;
  assert.deepEqual({ speed: R.speed, rest: R.rest, reach: R.reach, lot: R.lot, lotsPerVisit: R.lotsPerVisit, buy: R.buy, sell: R.sell, step: R.step }, { speed: 3, rest: 2, reach: 1, lot: 10, lotsPerVisit: 3, buy: 30, sell: 18, step: 4 });
  let minBuy = Infinity, maxSell = -Infinity;
  for (const t of TV.TRAVELERS) for (let v = 0; v < 400; v++) { const r = TV.ratesOf(t, v); minBuy = Math.min(minBuy, r.buy); maxSell = Math.max(maxSell, r.sell); assert.equal(r.lot, 10); }
  assert.ok(maxSell < minBuy, `sell ≤ ${maxSell} < buy ≥ ${minBuy}`);
  // the rates drift: more than one rate a traveler over its visits, the same visit always the same
  for (const t of TV.TRAVELERS) {
    assert.ok(new Set(Array.from({ length: 60 }, (_, v) => TV.ratesOf(t, v).buy)).size >= 2, `${t.id} drifts`);
    assert.deepEqual(TV.ratesOf(t, 77), TV.ratesOf(t, 77));
  }
});

test('the trade judge: lots, the visit limit, short stores, a full store, bad input', () => {
  const rates = { buy: 30, sell: 18, lot: 10 }, base = { food: 300, ore: 100, cap: 2000, rates, used: 0 };
  assert.deepEqual(TV.judgeTrade({ ...base, side: 'buy' }), { ok: true, food: -30, ore: 10 });
  assert.deepEqual(TV.judgeTrade({ ...base, side: 'sell' }), { ok: true, food: 18, ore: -10 });
  assert.deepEqual(TV.judgeTrade({ ...base, side: 'buy', lots: 3 }), { ok: true, food: -90, ore: 30 });
  assert.equal(TV.judgeTrade({ ...base, side: 'buy', used: 3 }).code, 'Limit');
  assert.equal(TV.judgeTrade({ ...base, side: 'buy', used: 2, lots: 2 }).code, 'Limit');
  assert.equal(TV.judgeTrade({ ...base, side: 'buy', food: 29 }).code, 'Insufficient');
  assert.equal(TV.judgeTrade({ ...base, side: 'sell', ore: 9 }).code, 'Insufficient');
  assert.equal(TV.judgeTrade({ ...base, side: 'buy', ore: 1995 }).code, 'StoreFull');
  assert.equal(TV.judgeTrade({ ...base, side: 'sell', food: 1990 }).code, 'StoreFull');
  for (const bad of [{ side: 'steal' }, { side: 'buy', lots: 0 }, { side: 'buy', lots: 1.5 }, { side: 'buy', lots: '1' }, { side: 'buy', lots: -1 }]) assert.equal(TV.judgeTrade({ ...base, ...bad }).code, 'BadData', JSON.stringify(bad));
});

test('the walk: three loops on passable tiles of rings 0-2, one step at a time, at most `speed` tiles a turn, the same every time', async () => {
  const live = await world({ stage: 'none' }), passable = passableOf(live);
  const villages = live.summary().neighbours.map(n => ({ p: n.village[0], q: n.village[1], tile: n.tile }));
  const list = TV.planTravelers({ passable, villages });
  assert.deepEqual(list.map(t => [t.id, t.route]), [['tamsin', 'outer'], ['odo', 'inner'], ['lio', 'villages']]);
  const open = TV.passableSet(passable);
  for (const t of list) {
    assert.ok(t.loop.stops.length >= 5, `${t.id}: ${t.loop.stops.length} stops`);
    for (const l of t.loop.legs) {
      assert.ok(l.path.every(h => open.has(`${h.q},${h.r}`)), `${t.id}: a path on passable tiles`);
      for (let i = 1; i < l.path.length; i++) assert.ok(adjacent(l.path[i - 1], l.path[i]), `${t.id}: a path of neighbouring tiles`);
      assert.equal(l.walk, Math.max(1, Math.ceil((l.path.length - 1) / TV.TRAVELERS_V1.speed)));
    }
    // a closed loop: each leg starts where the one before ended
    t.loop.legs.forEach((l, i) => { const prev = t.loop.legs[(i + t.loop.legs.length - 1) % t.loop.legs.length]; assert.deepEqual(l.path[0], prev.path[prev.path.length - 1]); });
    for (let b = 40; b < 40 + 2 * t.loop.length; b++) {
      const a = TV.placeAt(t.loop, t.offset, b), c = TV.placeAt(t.loop, t.offset, b + 1);
      assert.ok(passable(a.p, a.q, a.tile) && ringOf(a.p, a.q) <= 2, `${t.id} turn ${b} stands on the map`);
      assert.ok(hexDistance(a.hex.q, a.hex.r, c.hex.q, c.hex.r) <= TV.TRAVELERS_V1.speed, `${t.id} turn ${b}: ≤ speed`);
      assert.deepEqual(TV.placeAt(t.loop, t.offset, b + t.loop.length), a, 'periodic');
    }
  }
  // the same plan from a second world (what a replayed save makes)
  const again = TV.planTravelers({ passable: passableOf(await world({ stage: 'none' })), villages });
  assert.deepEqual(again.map(t => [t.offset, t.loop.length, t.loop.stops]), list.map(t => [t.offset, t.loop.length, t.loop.stops]));
});

test('visits: a run of in-reach turns, its first turn is in reach and the turn before is not; every ring-2 home is visited within 10 turns of turn 45', async () => {
  const live = await world({ stage: 'none' }), passable = passableOf(live);
  const villages = live.summary().neighbours.map(n => ({ p: n.village[0], q: n.village[1], tile: n.tile }));
  const list = TV.planTravelers({ passable, villages });
  for (let i = 0; i < 12; i++) {
    const home = (await import('../../permutation-server/web/frontier/fgeo.mjs')).ringProvinces(2)[i];
    let first = null;
    for (let b = 45; b < 145; b++) for (const t of list) {
      const v = TV.visitAt(t.loop, t.offset, b, home);
      if (v === null) { assert.equal(TV.inReach(TV.placeAt(t.loop, t.offset, b), home), false); continue; }
      first ??= b;
      assert.ok(v <= b && TV.inReach(TV.placeAt(t.loop, t.offset, v), home));
      assert.equal(TV.inReach(TV.placeAt(t.loop, t.offset, v - 1), home), false);
      for (let x = v; x <= b; x++) assert.equal(TV.visitAt(t.loop, t.offset, x, home), v, 'one visit, one first turn');
    }
    assert.ok(first !== null && first - 45 <= 10, `home ${home.p},${home.q}: first visit at +${first - 45}`);
  }
  assert.equal(TV.visitAt(list[0].loop, list[0].offset, 50, null), null, 'no village, no visit');
});

test('the world: trade at the visit\'s rates from the first village\'s stores, three lots a visit; away / no village / bad input refused', async () => {
  const live = await world();
  let r = live.travelers();
  assert.equal(r.v, 1); assert.equal(r.kind, 'demo-travelers'); assert.ok(r.home);
  assert.deepEqual(live.herald('/h/demo/travelers', new URL('http://x/h/demo/travelers')).body, r, 'the herald route answers the same record');
  // the first turn a traveler visits
  let vis = null;
  for (let i = 0; i < 40 && !(vis = r.travelers.find(t => t.visiting)); i++) { live.advance(); r = live.travelers(); }
  assert.ok(vis, 'a traveler visits within 40 turns');
  const away = r.travelers.find(t => !t.visiting);
  if (away) assert.equal((await trade(live, { traveler: away.id, side: 'buy' })).code, 'Away');
  assert.equal((await trade(live, { traveler: 'nobody', side: 'buy' })).code, 'BadData');
  assert.equal((await trade(live, { traveler: vis.id, side: 'give' })).code, 'BadData');
  const s0 = live.summary().me.stores;
  const a = await trade(live, { traveler: vis.id, side: 'buy', lots: 1 });
  assert.equal(a.ok, true, JSON.stringify(a));
  assert.deepEqual([a.food, a.ore], [-vis.rates.buy, 10]);
  const s1 = live.summary().me.stores;
  assert.deepEqual([s1[0] - s0[0], s1[3] - s0[3]], [-vis.rates.buy, 10], 'whole units from the village (the world is paused: no accrual)');
  const b = await trade(live, { traveler: vis.id, side: 'sell', lots: 2 });
  assert.equal(b.ok, true); assert.deepEqual([b.food, b.ore, b.left], [2 * vis.rates.sell, -20, 0]);
  const c = await trade(live, { traveler: vis.id, side: 'buy' });
  assert.deepEqual([c.ok, c.code, c.left], [false, 'Limit', 0]);
  assert.equal(live.travelers().travelers.find(t => t.id === vis.id).left, 0);
  assert.deepEqual(live.travelLog().map(x => [x.traveler, x.side, x.lots]), [[vis.id, 'buy', 1], [vis.id, 'sell', 2]]);
  assert.deepEqual(live.orders.slice(-4).map(o => [o.name, o.ok, o.code]).slice(-3), [['TravelerTrade', true, null], ['TravelerTrade', true, null], ['TravelerTrade', false, 'Limit']]);
  // a world before anyone joined: nothing to trade from
  const none = await world({ stage: 'none' });
  assert.equal(none.travelers().home, null);
  assert.equal((await trade(none, { traveler: 'tamsin', side: 'buy' })).code, 'NoVillage');
  // off by default: no record, no route
  const off = await world({ travelers: false });
  assert.equal(off.travelers, null);
  assert.equal(off.herald('/h/demo/travelers', new URL('http://x/h/demo/travelers')), null);
  assert.equal((await off.relay('POST', '/gw/f/sample/trade', { traveler: 'tamsin', side: 'buy' })), null);
});

test('travelers never block or meet a march: the world with them is the world without them (marches, clashes, land, records)', async () => {
  const on = await world(), off = await world({ travelers: false });
  const same = l => { const s = l.summary(); return JSON.stringify({ turn: s.turn, me: s.me, neighbours: s.neighbours, territory: s.territory, records: s.records, npc: l.npcLog.length }); };
  for (let i = 0; i < 40; i++) { on.advance(); off.advance(); }
  assert.equal(same(on), same(off));
  assert.ok(on.npcLog.length > 0, 'the AI nations marched meanwhile');
  // (a traveler is in no province's roster: every roster entry of the world with them is one of the world without them)
  for (const t of on.travelers().travelers) assert.deepEqual(on.province(t.p, t.q).entries, off.province(t.p, t.q).entries);
});

test('save → reload: the trades are world inputs (replayed), the places follow the clock, the talk rides in the save\'s own section (v 1)', async () => {
  let real = 5_000_000;
  const clockA = createClock(() => real), ls = memStorage();
  const A = await world({ paused: false, turn: 12, delay: 3, wall: clockA.wall });
  const rec = createRecorder({ storage: ls, worldId: 'w', clock: clockA });
  rec.seen(A);
  let vis = null;
  for (let i = 0; i < 400 && !(vis = A.travelers().travelers.find(t => t.visiting)); i++) real += 3_000;
  assert.ok(vis);
  for (const side of ['buy', 'sell']) await rec.post('POST', '/gw/f/sample/trade', JSON.stringify({ traveler: vis.id, side, lots: 1 }), () => A.relay('POST', '/gw/f/sample/trade', { traveler: vis.id, side, lots: 1 }));
  assert.equal(rec.setSection('travelers', { v: 1, talk: { [vis.id]: 2 } }), true);
  real += 7_000;
  rec.write();
  const before = A.travelers(), log = A.travelLog().length;
  // the next load
  const found = readSave(ls, 'w');
  assert.equal(found.status, 'resume');
  assert.deepEqual(found.save.sections, { travelers: { v: 1, talk: { [vis.id]: 2 } } });
  const clockB = createClock(() => real);
  const B = await world({ paused: false, turn: 12, delay: 3, wall: clockB.wall });
  await replay(B, found.save, clockB);
  assert.equal(B.travelLog().length, log);
  assert.deepEqual(B.travelers(), before, 'every traveler where it was, the same visit, rates and lots left');
  const rec2 = createRecorder({ storage: ls, worldId: 'w', clock: clockB, from: found.save });
  assert.deepEqual(rec2.section('travelers'), { v: 1, talk: { [vis.id]: 2 } });
  rec2.write();
  assert.deepEqual(JSON.parse(ls.getItem(SAVE_KEY)).sections.travelers, { v: 1, talk: { [vis.id]: 2 } }, 'written again with the next save');
});

test('the save\'s sections: versioned, optional, a damaged one dropped; a save without sections still resumes', () => {
  const ls = memStorage(), c = createClock(() => 1000);
  const rec = createRecorder({ storage: ls, worldId: 'w', clock: c });
  rec.write();
  assert.equal(JSON.parse(ls.getItem(SAVE_KEY)).sections, undefined, 'no sections: the record is what it was');
  assert.equal(readSave(ls, 'w').status, 'resume');
  for (const bad of [null, 3, [], { talk: {} }, { v: '1' }, { v: 1.5 }]) assert.equal(rec.setSection('travelers', bad), false, JSON.stringify(bad));
  assert.equal(rec.setSection('travelers', { v: 1, talk: { odo: 1 } }), true);
  assert.equal(readSave(ls, 'w').status, 'resume');
  const s = JSON.parse(ls.getItem(SAVE_KEY));
  s.sections.junk = 'x'; s.sections.other = { v: 2, x: 1 };
  ls.setItem(SAVE_KEY, JSON.stringify(s));
  const back = createRecorder({ storage: ls, worldId: 'w', clock: c, from: readSave(ls, 'w').save });
  assert.equal(back.section('junk'), null);
  assert.deepEqual(back.section('other'), { v: 2, x: 1 }, 'another section (another PR\'s) is kept as it is');
  assert.deepEqual(back.section('travelers'), { v: 1, talk: { odo: 1 } });
});

test('the talk: 2-4 lines a traveler, English and Japanese, never "season", never says it is (or is not) a person or a program', async () => {
  for (const t of TV.TRAVELERS) {
    const lines = TV.LINES[t.id];
    assert.ok(lines.length >= 2 && lines.length <= 4, t.id);
    for (const l of lines) {
      assert.ok(l.en.length > 10 && l.en.length <= 140 && l.ja.length > 5 && l.ja.length <= 80, `${t.id}: short lines`);
      assert.match(l.ja, /[ぁ-んァ-ン一-龯]/);
      assert.doesNotMatch(`${l.en} ${l.ja}`, /season|シーズン/i);
      assert.doesNotMatch(l.en, /\b(human|person|people|AI|bot|robot|program|machine|real)\b/i);
      assert.doesNotMatch(l.ja, /人間|ロボット|AI|プログラム|機械|本物/);
    }
    assert.ok(t.name.en && t.name.ja);
  }
  // the rules they teach are the demo's (code wins): troops cost food, ore and gold; a claim costs ore; a turn is 600 s
  const R = await import('../screens/rules.mjs');
  for (let u = 0; u <= R.SCOUT; u++) { const c = R.trainCost(u, 100); if (c) assert.ok(c[R.RES.Food] > 0 && c[R.RES.Ore] > 0 && c[R.RES.Gold] > 0, `unit ${u}: food, ore and gold`); }
  assert.equal(R.BELL_SECS, 600);
  const { TERRITORY_V1 } = await import('../../permutation-server/web/frontier/flocalplay-territory.mjs');
  assert.equal(TERRITORY_V1.costResource, R.RES.Ore);
});

test('the page: the panel model, the talk section read back, words EN/JA without "season"; bundled into the page, the world option on', async () => {
  const H = await import('../demo/src/travelhud.mjs');
  assert.deepEqual(H.readTalk({ v: 1, talk: { tamsin: 4, odo: -1, nobody: 1, lio: 'x' } }), { tamsin: 1 });
  assert.deepEqual(H.readTalk({ v: 2, talk: { tamsin: 1 } }), {}, 'another version reads as fresh');
  assert.deepEqual(H.readTalk(null), {});
  const rec = { turn: 50, home: { p: 2, q: 0 }, rules: TV.TRAVELERS_V1, travelers: [{ id: 'odo', name: TV.TRAVELERS[1].name, route: 'inner', walking: true, visiting: false, next: 53, rates: null, left: 0 }] };
  const m = H.panelModel(rec, 'odo', { odo: 2 }, 'en');
  assert.equal(m.status, 'On the road. Near your village in about 3 turns.');
  assert.equal(m.line, TV.LINES.odo[2].en);
  assert.equal(H.panelModel({ ...rec, home: null }, 'odo', {}, 'ja').status, '取り引きするには、国を選んで村を作ってください。');
  const words = l => Object.values(H.TEXT[l]).flatMap(v => (typeof v === 'function' ? [v(2, 3), v(null)] : typeof v === 'object' ? Object.values(v) : [v])).join(' ');
  for (const l of ['en', 'ja']) assert.doesNotMatch(words(l), /season|シーズン/i);
  assert.deepEqual(Object.keys(H.TEXT.en).sort(), Object.keys(H.TEXT.ja).sort());
  assert.deepEqual(Object.keys(H.TEXT.en.refused).sort(), Object.keys(H.TEXT.ja.refused).sort());
  assert.match(src('../demo/src/page-app.mjs'), /import \{ startTravelHud \} from '\.\/travelhud\.mjs';/);
  assert.match(src('../demo/src/boot.mjs'), /landClaim: true, travelers: true,/);
  // the trade goes through the world's route (a world input the save keeps), never straight into the world
  assert.match(src('../demo/src/travelhud.mjs'), /fetch\('\/gw\/f\/sample\/trade', \{ method: 'POST'/);
  assert.doesNotMatch(src('../demo/src/travelhud.mjs'), /\.relay\(/);
});
