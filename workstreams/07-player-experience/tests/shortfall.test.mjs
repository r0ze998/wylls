// Workstream 07, brief item 2: wait / grow / carry / ask, compared when the same
// needed amounts are all there, by the page's own projection of the village.
import test from 'node:test';
import assert from 'node:assert/strict';
import { compareRemedies, storesAt, readyAt } from '../src/shortfall.mjs';
import { promotionOffer, buildOffers, duplicateCost, buildSecs } from '../../../permutation-server/web/frontier/hud/rulebook.mjs';
import { accrualAt } from '../../../permutation-server/web/frontier/fland.mjs';

const H = 3600, NOW = 1_000_000;
/** A store of `v` whole units growing `perHour` (net) with cap `cap` (whole), settled at NOW. */
const store = (v, perHour = 0, cap = 6000) => ({ value: BigInt(v) * 1000n, rate: BigInt(Math.round(perHour * 1000)), cap: BigInt(cap) * 1000n, t0: BigInt(NOW), frac: 0n });
/** A town (tier 1, cap 6,000) with stone 700 at 8 an hour, wood 3,000, gold 2,000, food 1,000 at −5 an hour. */
const town = (over = {}) => ({ p: 0, q: 0, site: 0, tier: 1, state: 2, flags: 0,
  stores: [store(1000, -5), store(3000, 10), store(700, 8), store(0, 4), store(0), store(2000, 6), store(0, 5), store(0)],
  production: [10_000, 10_000, 8_000, 4_000, 0, 6_000, 5_000, 0].map(BigInt), upkeep: [15_000, 0, 0, 0, 0, 0, 0, 0].map(BigInt), queue: [], ...over });
const END = NOW + 14 * 24 * H;
const NEED = [0, 0, 1613, 0, 0, 0, 0, 0];

test('REPRO: the promotion card today says what is short and nothing of when or how it could be there', () => {
  const o = promotionOffer(town(), { now: NOW, have: [1000, 3000, 700, 0, 0, 2000, 0, 0] });
  assert.ok(o.short.length > 0);
  assert.deepEqual(Object.keys(o.short[0]).sort(), ['need', 'r'], 'an amount, no time, no way to fill it');
});

test('waiting: the moment the projection holds every needed amount, exactly', () => {
  const c = compareRemedies({ h: town(), need: NEED, now: NOW, endTs: END });
  const w = c.options.find(o => o.kind === 'wait');
  assert.deepEqual(c.short, [{ r: 2, missing: 913 }]);
  const t = Math.ceil((913 * H) / 8);
  assert.equal(w.ready, t + NOW);
  assert.ok(accrualAt(town().stores[2], w.ready) >= 1_613_000n && accrualAt(town().stores[2], w.ready - 1) < 1_613_000n);
});

test('growing: the next quarry is paid now from the same stores, makes 8 more an hour once built, and is compared at the same "all there"', () => {
  const c = compareRemedies({ h: town(), need: NEED, now: NOW, endTs: END });
  const g = c.options.find(o => o.kind === 'grow' && o.r === 2);
  const offer = buildOffers(town(), { now: NOW, have: [1000, 3000, 700, 0, 0, 2000, 0, 0] }).find(x => x.item === 2);
  assert.deepEqual(g.costs, offer.cost, 'the program\'s cost of that copy (duplicateCost)');
  assert.equal(g.gives.from, NOW + offer.doneIn);
  // by hand: 700 + 8/h until the quarry is done, then 16/h
  const built = offer.doneIn, at = 700 + (8 * built) / H, rest = 1613 - at;
  assert.ok(Math.abs(g.ready - (NOW + built + (rest * H) / 16)) <= 2, `${g.ready - NOW} s`);
  assert.ok(g.ready < c.options.find(o => o.kind === 'wait').ready, 'here the quarry is the quicker way');
  assert.equal(duplicateCost(80, 1), 80);
  assert.equal(buildSecs(1), H + 1800);
});

test('carrying: 900 that land in an hour do not make 1,613 ready; the rest still comes by waiting, and the time says so', () => {
  const preview = { ok: true, arrive: { ts: NOW + H, bell: 1, bellIfLate: 1 }, wear: { bps: 0 }, turns: [{ known: [], unknown: true }], unknown: true };
  const c = compareRemedies({ h: town(), need: NEED, now: NOW, endTs: END, sources: [{ id: 'v1', label: 'north storehouse', have: [0, 0, 900, 0, 0, 0, 0, 0], preview }] });
  const k = c.options.find(o => o.kind === 'carry');
  assert.equal(k.partial, true);
  assert.equal(k.arrives[2], 900);
  assert.notEqual(k.ready, NOW + H, 'not the caravan\'s arrival');
  const left = 1613 - 700 - 900; // 13 more by the village's own 8 an hour
  assert.equal(k.ready, NOW + Math.ceil((left * H) / 8));
  assert.deepEqual(k.risk, { knownTurns: 0, unknown: true, turns: 1 }, 'the raid risk is told beside the time, never taken from it');
});

test('carrying through a tower\'s coverage: the load is raised so that what arrives covers the need, within what is there', () => {
  const preview = { ok: true, arrive: { ts: NOW + H, bell: 1, bellIfLate: 1 }, wear: { bps: 2000 }, turns: [], unknown: false };
  const c = compareRemedies({ h: town(), need: NEED, now: NOW, endTs: END, sources: [{ id: 'v1', label: 's', have: [0, 0, 5000, 0, 0, 0, 0, 0], preview }] });
  const k = c.options.find(o => o.kind === 'carry');
  assert.ok(k.arrives[2] >= 913 && k.load[2] > k.arrives[2], `load ${k.load[2]}, arrives ${k.arrives[2]}`);
  assert.equal(k.ready, NOW + H);
  assert.equal(k.partial, false);
});

test('capacity: waiting and building stop at the cap; a caravan may bring more (holding.rs add "may exceed the cap")', () => {
  const need = [0, 0, 7000, 0, 0, 0, 0, 0];
  const preview = { ok: true, arrive: { ts: NOW + 2 * H, bell: 1, bellIfLate: 1 }, wear: { bps: 0 }, turns: [], unknown: false };
  const c = compareRemedies({ h: town(), need, now: NOW, endTs: END, sources: [{ id: 'v1', label: 's', have: [0, 0, 7000, 0, 0, 0, 0, 0], preview }] });
  const w = c.options.find(o => o.kind === 'wait'), g = c.options.find(o => o.kind === 'grow'), k = c.options.find(o => o.kind === 'carry');
  assert.deepEqual([w.ready, w.blocked[0].why, w.blocked[0].cap], [null, 'AboveCap', 6000]);
  assert.equal(g.ready, null);
  assert.equal(k.ready, NOW + 2 * H);
  assert.equal(c.options[0].kind, 'carry', 'the options are sorted by when all is there; none-ever last');
});

test('a resource whose upkeep is above its production never fills by waiting, and the season\'s end is a limit', () => {
  const c = compareRemedies({ h: town(), need: [1500, 0, 0, 0, 0, 0, 0, 0], now: NOW, endTs: END });
  assert.deepEqual(c.options.find(o => o.kind === 'wait').blocked, [{ r: 0, why: 'NoRate', perHour: -5 }]);
  const late = compareRemedies({ h: town(), need: NEED, now: NOW, endTs: NOW + H });
  assert.equal(late.options.find(o => o.kind === 'wait').ready, null);
  assert.deepEqual(late.options.find(o => o.kind === 'wait').notes, ['AfterSeasonEnd']);
});

test('a building whose own cost is short is said so; asking has no time, ever', () => {
  const poor = town({ stores: [store(10, 1), store(10, 1), store(700, 8), store(0), store(0), store(0), store(0), store(0)] });
  const c = compareRemedies({ h: poor, need: NEED, now: NOW, endTs: END });
  const g = c.options.find(o => o.kind === 'grow');
  assert.equal(g.ready, null);
  assert.equal(g.blocked[0].why, 'Insufficient');
  const a = c.options.find(o => o.kind === 'ask');
  assert.deepEqual([a.ready, a.mock, a.notes], [null, true, ['DependsOnOthers']]);
});

test('readyAt is the first second the stores hold the need', () => {
  const h = town();
  const t = readyAt(h, [0n, 0n, 800_000n, 0n, 0n, 0n, 0n, 0n], NOW, END);
  assert.ok(storesAt(h, t)[2] >= 800_000n && storesAt(h, t - 1)[2] < 800_000n);
});

test('a caravan that leaves some short is also compared with one more building for the rest, at the same "all there"', () => {
  const preview = { ok: true, arrive: { ts: NOW + H, bell: 1, bellIfLate: 1 }, wear: { bps: 0 }, turns: [], unknown: false };
  const c = compareRemedies({ h: town(), need: [0, 0, 3000, 0, 0, 0, 0, 0], now: NOW, endTs: END, sources: [{ id: 'v1', label: 's', have: [0, 0, 900, 0, 0, 0, 0, 0], preview }] });
  const carry = c.options.find(o => o.kind === 'carry'), grow = c.options.find(o => o.kind === 'grow'), both = c.options.find(o => o.kind === 'both');
  assert.ok(both && both.ready < carry.ready && both.ready < grow.ready, `${both?.ready - NOW} < ${carry.ready - NOW}, ${grow.ready - NOW}`);
  assert.deepEqual(both.costs, grow.costs, 'the same building, paid now');
  assert.ok(c.options.every(o => !('village' in o)), 'no internal state leaks into the result');
});

test('a caravan over the cap: the store stops growing once at or over it, so a need above the cap waits on the cargo alone', () => {
  // cap 1,000 stone; 400 now at 100 an hour; a caravan of 500 lands in 1 hour; need 1,200
  const h = town({ tier: 0, stores: [store(1000, 1, 1000), store(1000, 1, 1000), store(400, 100, 1000), store(0, 0, 1000), store(0, 0, 1000), store(0, 0, 1000), store(0, 0, 1000), store(0, 0, 1000)] });
  const preview = { ok: true, arrive: { ts: NOW + H, bell: 1, bellIfLate: 1 }, wear: { bps: 0 }, turns: [], unknown: false };
  const c = compareRemedies({ h, need: [0, 0, 1200, 0, 0, 0, 0, 0], now: NOW, endTs: END, sources: [{ id: 'v', label: 's', have: [0, 0, 500, 0, 0, 0, 0, 0], preview }] });
  const k = c.options.find(o => o.kind === 'carry');
  // at the arrival 500 + 500 = 1,000: at the cap, it grows no more; 1,200 never comes (the old sum said it would)
  assert.equal(k.ready, null);
  assert.deepEqual(k.blocked, [{ r: 2, why: 'AboveCap', cap: 1000 }], 'said as the cap');
  const more = compareRemedies({ h, need: [0, 0, 1200, 0, 0, 0, 0, 0], now: NOW, endTs: END, sources: [{ id: 'v', label: 's', have: [0, 0, 800, 0, 0, 0, 0, 0], preview }] });
  assert.equal(more.options.find(o => o.kind === 'carry').ready, NOW + H, '500 + 800 lands over the cap at once');
});
