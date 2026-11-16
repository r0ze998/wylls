// The conquest guide (the first-play guide of every programVersion ≥ 3 season, local play's S1 included) with a SECOND
// village open (2026-11-16). Its progress — built, trained, a host formed and stood, a host on a keep — was read from the
// open village only (screens/conquestguide.mjs conquestFacts: activeHolding, hostRows), so opening a new village (an
// outpost) sent the guide back to "build" although the first village had built, trained and formed a host. Now the
// steps already done are read over every village; what to do next (the forming host, its hint) stays the open one's.
// KEY-FREE, pure data: no key, nothing signed or sent, no request (a `fetch` stub, asserted unused), nothing stored.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { hostId } from '../../permutation-server/web/frontier/faddr.mjs';
import { baseProduction } from '../../permutation-server/web/frontier/fland.mjs';
import { conquestGuide, conquestObjective } from '../../permutation-server/web/frontier/screens/conquestguide.mjs';

const requests = [];
let oldFetch;
before(() => { oldFetch = globalThis.fetch; globalThis.fetch = async u => { requests.push(String(u)); return new Response('{}', { status: 503 }); }; });
after(() => { globalThis.fetch = oldFetch; });

const T0 = 1_794_539_760;
const CLOCK = { genesisTs: T0, drand: { genesis: T0 - 3000, period: 3 }, margin: 30, window: () => 600, endBell: 999, continuous: false };
const SEASON = { programVersion: 3, layoutVersion: 2, endBell: 96, bellSecs: 600, dormantAfterSecs: 86400, releaseAfterSecs: 172800, minLead: 2, maxLead: 72, conquestParams: { keepBells: 72 } };
const village = (p, q, site, tile, extra = {}) => ({ p, q, site, gen: 0, tile, faction: 0, state: 2, order: 1, tier: 0, flags: 0, production: baseProduction(0), upkeep: Array(8).fill(0n),
  stores: Array.from({ length: 8 }, () => ({ value: 0n, rate: 0n, cap: 1_000_000n, t0: 0n })), reserve: Array(8).fill(0), queue: [],
  transit: [{ state: 0 }], explore: { state: 0 }, lastOwnerAction: 1000n, finalTs: 1n, shieldUntil: 0n, ...extra });
const built = () => baseProduction(0).map((v, i) => (i === 0 ? v + 50_000n : v));   // a farm: more food than the Hamlet's base
const hostOf = (o, extra = {}) => ({ id: hostId({ p: o.p, q: o.q, site: o.site, gen: 0, seq: 1 }), unit: 0, state: 1, tile: o.tile, troops: 100000, staminaValue: 120, staminaBell: 0, readyBell: 0, pendOp: 0, fromBell: 1, ...extra });

function world({ a = {}, aEntries = [], active = 0 } = {}) {
  const A = village(2, 0, 2, 20, a), B = village(3, 0, 1, 10);   // B: a new village (an outpost), nothing done there
  return { mode: 'play', season: SEASON, citizen: { faction: 0 }, holdings: [A, B], activeHolding: active, nowBell: 2, clock: CLOCK, chain: { now: () => T0 + 1500 }, land: { stage: 'final' },
    provinces: new Map([['2,0', { province: { p: 2, q: 0, resolvedNext: 1, entries: aEntries.map(e => e(A)), ticketCohorts: [] } }], ['3,0', { province: { p: 3, q: 0, resolvedNext: 1, entries: [], ticketCohorts: [] } }]]),
    formingBells: [], marches: [], orders: [], ui: { dismissed: [] },
    conquest: { status: 'ready', keeps: new Map(), history: new Map(), standings: null, final: null, events: [] } };
}
const done = g => g.steps.filter(s => s.status === 'done').map(s => s.id);

test('a host formed in the first village: the guide is at the march with EITHER village open (it fell back to "build")', () => {
  const opts = { a: { production: built() }, aEntries: [o => hostOf(o)] };
  const first = conquestGuide(world({ ...opts, active: 0 })), second = conquestGuide(world({ ...opts, active: 1 }));
  assert.equal(first.current, 'march');
  assert.equal(second.current, 'march', 'the second village open');
  assert.deepEqual(done(second), done(first));
  assert.equal(second.n, first.n);
});

test('built only in the first village: the second village open is at "train", not "build"', () => {
  const opts = { a: { production: built() } };
  assert.equal(conquestGuide(world({ ...opts, active: 0 })).current, 'train');
  assert.equal(conquestGuide(world({ ...opts, active: 1 })).current, 'train');
});

test('trained in the first village: the second village open is at "muster"', () => {
  const reserve = Array(8).fill(0); reserve[0] = 200;
  assert.equal(conquestGuide(world({ a: { reserve }, active: 1 })).current, 'muster');
});

test('nothing done anywhere: "build" with either village open (no progress made up)', () => {
  assert.equal(conquestGuide(world({ active: 0 })).current, 'build');
  assert.equal(conquestGuide(world({ active: 1 })).current, 'build');
});

test('a host forming in the first village, the second open: the guide says it forms and never asks for a second muster', () => {
  const FS = world({ aEntries: [o => hostOf(o, { state: 2, fromBell: 3 })], active: 1 });
  const g = conquestGuide(FS);
  assert.equal(g.current, 'muster', 'formed is not stood: the muster step stays');
  assert.equal(String(g.facts.forming?.id), String(hostOf(FS.holdings[0]).id), 'the forming host of the first village');
  assert.equal(g.facts.formingHere, false);
  const o = conquestObjective(FS);
  assert.match(o.text, /は編成中です/);
  assert.doesNotMatch(o.text, /「編成」で控えの兵を軍勢にします/, 'not "form a host" again');
  assert.notEqual(o.go?.data?.pop, 'muster');
  assert.notEqual(o.go?.act, 'cg-go', 'no while-waiting press: that hint reads the open village\'s stores, not the forming host\'s');
});

test('a host forming in the open village: its while-waiting hint as before', () => {
  const FS = world({ aEntries: [o => hostOf(o, { state: 2, fromBell: 3 })], active: 0 });
  assert.equal(conquestGuide(FS).facts.formingHere, true);
  assert.match(conquestObjective(FS).text, /は編成中です/);
});

// Not fixable inside the guide: its presses (app.mjs cg-go) act on the OPEN village — build/train/muster cards open on
// FS.activeHolding and the keeps press looks the host up in hand.ownHosts(FS), the open village's. With the progress in
// the first village and the second open, these presses lead nowhere until cg-go can be told which village (reported).
test('the march press reaches the first village\'s standing host with the second open', { todo: 'app.mjs cg-go acts on the open village only' }, () => {
  const o = conquestObjective(world({ a: { production: built() }, aEntries: [o2 => hostOf(o2)], active: 1 }));
  assert.notEqual(o.go?.act, 'tab', 'not the open village\'s empty Hosts tab');
});
test('the muster press reaches the first village\'s reserve with the second open', { todo: 'app.mjs cg-go acts on the open village only' }, () => {
  const reserve = Array(8).fill(0); reserve[0] = 200;
  const o = conquestObjective(world({ a: { reserve }, active: 1 }));
  assert.equal(o.go?.data?.i, 0, 'the press names the village that holds the trained troops');
});

test('the source: the progress facts read every village (pinned as text)', () => {
  const s = readFileSync(new URL('../../permutation-server/web/frontier/screens/conquestguide.mjs', import.meta.url), 'utf8');
  assert.match(s, /const villages = \(FS\.holdings \?\? \[\]\)\.map\(\(_, i\) => \(\{ \.\.\.FS, activeHolding: i \}\)\);/);
  assert.match(s, /const standing = allRows\.map\(r => keeps\.find\(/);
  assert.match(s, /stood: stoodHosts\(allRows\)\.length > 0 \|\| away, forming: formingHosts\(rows\)\[0\] \?\? formingHosts\(allRows\)\[0\] \?\? null, formingHere: formingHosts\(rows\)\.length > 0,/);
  assert.match(s, /const r = x\.forming, s = x\.formingHere \? waitingSuggestion\(FS, r, t\) : null;/);
});

test('isolation: no request', () => { assert.deepEqual(requests, []); assert.equal(globalThis.localStorage, undefined); });
