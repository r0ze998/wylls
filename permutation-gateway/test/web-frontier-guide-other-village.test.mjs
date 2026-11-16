// The conquest guide (the first-play guide of every programVersion ≥ 3 season, local play's S1 included) with a SECOND
// village open (2026-11-16). Its progress — built, trained, a host formed and stood, a host on a keep — was read from the
// open village only (screens/conquestguide.mjs conquestFacts: activeHolding, hostRows), so opening a new village (an
// outpost) sent the guide back to "build" although the first village had built, trained and formed a host. Now the
// steps already done are read over every village; what to do next (the forming host, its hint) stays the open one's.
// The presses then name the host or village the step can be done with, and app.mjs cg-go acts on it (pinned as text).
// KEY-FREE, pure data: no key, nothing signed or sent, no request (a `fetch` stub, asserted unused), nothing stored.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { hostId } from '../../permutation-server/web/frontier/faddr.mjs';
import { baseProduction } from '../../permutation-server/web/frontier/fland.mjs';
import { conquestGuide, conquestObjective } from '../../permutation-server/web/frontier/screens/conquestguide.mjs';
import { guideTarget } from '../../permutation-server/web/frontier/hud/guide.mjs';

const requests = [];
let oldFetch;
before(() => { oldFetch = globalThis.fetch; globalThis.fetch = async u => { requests.push(String(u)); return new Response('{}', { status: 503 }); }; });
after(() => { globalThis.fetch = oldFetch; });

const T0 = 1_794_539_760;
const NOW = T0 + 1500;
const CLOCK = { genesisTs: T0, drand: { genesis: T0 - 3000, period: 3 }, margin: 30, window: () => 600, endBell: 999, continuous: false };
const SEASON = { programVersion: 3, layoutVersion: 2, endBell: 96, bellSecs: 600, dormantAfterSecs: 86400, releaseAfterSecs: 172800, minLead: 2, maxLead: 72, conquestParams: { keepBells: 72 } };
const village = (p, q, site, tile, extra = {}) => ({ p, q, site, gen: 0, tile, faction: 0, state: 2, order: 1, tier: 0, flags: 0, production: baseProduction(0), upkeep: Array(8).fill(0n),
  stores: Array.from({ length: 8 }, () => ({ value: 0n, rate: 0n, cap: 1_000_000n, t0: BigInt(NOW) })), reserve: Array(8).fill(0), queue: [],   // (empty now: nothing accrues before the test's clock)
  transit: [{ state: 0 }], explore: { state: 0 }, lastOwnerAction: 1000n, finalTs: 1n, shieldUntil: 0n, ...extra });
const built = () => baseProduction(0).map((v, i) => (i === 0 ? v + 50_000n : v));   // a farm: more food than the Hamlet's base
const hostOf = (o, extra = {}) => ({ id: hostId({ p: o.p, q: o.q, site: o.site, gen: 0, seq: 1 }), unit: 0, state: 1, tile: o.tile, troops: 100000, staminaValue: 120, staminaBell: 0, readyBell: 0, pendOp: 0, fromBell: 1, ...extra });

const rich = () => Array.from({ length: 8 }, () => ({ value: 1_000_000_000n, rate: 0n, cap: 2_000_000_000_000n, t0: BigInt(NOW) }));   // stores that pay for training
function world({ a = {}, b = {}, aEntries = [], active = 0, only = false } = {}) {
  const A = village(2, 0, 2, 20, a), B = village(3, 0, 1, 10, b);   // B: a new village (an outpost), nothing done there
  return { mode: 'play', season: SEASON, citizen: { faction: 0 }, holdings: only ? [A] : [A, B], activeHolding: active, nowBell: 2, clock: CLOCK, chain: { now: () => NOW }, land: { stage: 'final' },
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
  assert.ok(!['train', 'build'].includes(o.go?.data?.pop), 'no while-waiting press: that hint reads the open village\'s stores, not the forming host\'s');
});

test('a host forming in the open village: its while-waiting hint as before', () => {
  const FS = world({ aEntries: [o => hostOf(o, { state: 2, fromBell: 3 })], active: 0 });
  assert.equal(conquestGuide(FS).facts.formingHere, true);
  assert.match(conquestObjective(FS).text, /は編成中です/);
});

// The presses name the host or the village the step can be done with (app.mjs cg-go acts on it): the open village when
// it can, else another — by identity (p, q, site); nothing named when none can.
const A_AT = { p: 2, q: 0, site: 2 };
test('march, the second village open: the press is the first village\'s standing host (it was the empty Hosts tab)', () => {
  const FS = world({ a: { production: built() }, aEntries: [o => hostOf(o)], active: 1 });
  assert.deepEqual(conquestObjective(FS).go.data, { pop: 'keeps', host: String(hostOf(FS.holdings[0]).id) });
});
test('muster, the second village open: the press names the village that holds the trained troops', () => {
  const reserve = Array(8).fill(0); reserve[0] = 200;
  assert.deepEqual(conquestObjective(world({ a: { reserve }, active: 1 })).go.data, { pop: 'muster', ...A_AT });
});
test('train, the second village open with empty stores: the press names the village whose stores pay', () => {
  assert.deepEqual(conquestObjective(world({ a: { production: built(), stores: rich() }, active: 1 })).go.data, { pop: 'train', ...A_AT });
});
test('no village can: nothing is named, the press stays on the open village (its card says why)', () => {
  assert.deepEqual(conquestObjective(world({ a: { production: built() }, active: 1 })).go.data, { pop: 'train' });
});
test('the open village can: it is the one, unnamed — as before', () => {
  const reserve = Array(8).fill(0); reserve[0] = 200;
  assert.deepEqual(conquestObjective(world({ a: { reserve }, b: { reserve }, active: 1 })).go.data, { pop: 'muster' });
});
test('a host forming in the first village, the second open: the press is that host\'s own forts card', () => {
  const FS = world({ aEntries: [o => hostOf(o, { state: 2, fromBell: 3 })], active: 1 });
  assert.deepEqual(conquestObjective(FS).go.data, { pop: 'keeps', host: String(hostOf(FS.holdings[0]).id) });
});
test('one village: the presses are exactly as before (no village named)', () => {
  const reserve = Array(8).fill(0); reserve[0] = 200;
  assert.deepEqual(conquestObjective(world({ a: { reserve }, only: true })).go.data, { pop: 'muster' });
  assert.deepEqual(conquestObjective(world({ a: { production: built(), stores: rich() }, only: true })).go.data, { pop: 'train' });
  const FS = world({ a: { production: built() }, aEntries: [o => hostOf(o)], only: true });
  assert.deepEqual(conquestObjective(FS).go.data, { pop: 'keeps', host: String(hostOf(FS.holdings[0]).id) });
});
test('the map\'s guide points at the village the press names (hud/guide.mjs guideTarget; app.mjs guideGo opens it)', () => {
  const reserve = Array(8).fill(0); reserve[0] = 200;
  const t = guideTarget(world({ a: { reserve }, active: 1 }));
  assert.deepEqual(t && { kind: t.kind, p: t.p, q: t.q, tile: t.tile }, { kind: 'muster', p: 2, q: 0, tile: 20 });
  const one = guideTarget(world({ a: { reserve }, only: true }));
  assert.deepEqual(one && { kind: one.kind, p: one.p, q: one.q, tile: one.tile }, { kind: 'muster', p: 2, q: 0, tile: 20 }, 'one village: as before');
});
test('app.mjs cg-go: the host looked up in every village and taken with selectHost; a named village only while it is the viewer\'s (pinned as text)', () => {
  const a = readFileSync(new URL('../../permutation-server/web/frontier/app.mjs', import.meta.url), 'utf8');
  const at = a.indexOf("'cg-go': d => {"), g = a.slice(at, a.indexOf('\n  },\n', at));
  assert.ok(g.indexOf("if (FS.compose) ACTIONS['compose-close']();") > 0 && g.indexOf("if (FS.compose) ACTIONS['compose-close']();") < g.indexOf("if (d.pop === 'keeps')"), 'the draft is still put away first (waiting send cancelled)');
  assert.match(g, /for \(let i = 0; i < \(FS\.holdings \?\? \[\]\)\.length && !r; i\+\+\) r = hand\.ownHosts\(\{ \.\.\.FS, activeHolding: i \}\)\.find\(x => x\.id === String\(d\.host\)\) \?\? null;/);
  assert.match(g, /if \(selectHost\(r\)\) setPop\('keeps'\);/);
  assert.match(g, /const named = d\.p !== undefined \? \(FS\.holdings \?\? \[\]\)\.findIndex\(h => String\(h\.p\) === String\(d\.p\) && String\(h\.q\) === String\(d\.q\) && String\(h\.site\) === String\(d\.site\)\) : -1;/);
  assert.match(g, /const hi = named >= 0 \? named : Math\.max\(0, Math\.min\(\(FS\.holdings \?\? \[\]\)\.length - 1, FS\.activeHolding \?\? 0\)\);/, 'a stale or foreign name: the open village');
});

test('the source: the progress facts read every village (pinned as text)', () => {
  const s = readFileSync(new URL('../../permutation-server/web/frontier/screens/conquestguide.mjs', import.meta.url), 'utf8');
  assert.match(s, /const villages = \(FS\.holdings \?\? \[\]\)\.map\(\(_, i\) => \(\{ \.\.\.FS, activeHolding: i \}\)\);/);
  assert.match(s, /const standing = allRows\.map\(r => keeps\.find\(/);
  assert.match(s, /stood: stoodHosts\(allRows\)\.length > 0 \|\| away, forming: formingHosts\(rows\)\[0\] \?\? formingHosts\(allRows\)\[0\] \?\? null, formingHere: formingHosts\(rows\)\.length > 0,/);
  assert.match(s, /const r = x\.forming, s = x\.formingHere \? waitingSuggestion\(FS, r, t\) : null;/);
});

test('isolation: no request', () => { assert.deepEqual(requests, []); assert.equal(globalThis.localStorage, undefined); });
