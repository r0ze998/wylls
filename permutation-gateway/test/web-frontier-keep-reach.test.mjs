// The keeps a march can reach (conquest; web fkeepreach.mjs, screens/conquest.mjs):
//  - the list builder over a fixture kernel that answers `plan_path`: other nations'
//    keeps only, no heartland, no keep inside a known protection, the 4-province and
//    step limits of fmarch.planRoute, the fastest origin, sorted by travel time;
//  - the cache: one answer per origins, turn and control snapshot;
//  - the nation tab's section, the keep panel's note and the composer's way back;
//  - the controller fills it on request from the keeps it already holds (no read).
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { reachableKeeps, contestableKeeps, cachedReach, reachKey, MAX_ROUTE_PROVINCES } from '../../permutation-server/web/frontier/fkeepreach.mjs';
import { planRoute } from '../../permutation-server/web/frontier/fmarch.mjs';
import { MAX_PATH_STEPS } from '../../permutation-server/web/frontier/seal.mjs';
import { tileHex } from '../../permutation-server/web/frontier/fgeo.mjs';
import { hostId } from '../../permutation-server/web/frontier/faddr.mjs';
import { baseProduction } from '../../permutation-server/web/frontier/fland.mjs';
import { render as nationTab, renderReach, renderKeep, reachOrigins, keepUnreachable } from '../../permutation-server/web/frontier/screens/conquest.mjs';
import { render as composer } from '../../permutation-server/web/frontier/screens/march.mjs';
import { render as marchCard } from '../../permutation-server/web/frontier/hud/marchcard.mjs';
import * as C from '../../permutation-server/web/frontier/controller.mjs';
import { FS } from '../../permutation-server/web/frontier/fstate.mjs';
import { setLang } from '../../permutation-server/web/lang.mjs';

afterEach(() => setLang('ja'));

// ------------------------------------------------------------------ fixtures
const keep = (p, q, extra = {}) => ({ p, q, tile: 30, holder: 1, troops: 100, heartland: false, consolidatedUntil: null, contender: null, progress: 0, requiredBells: 72, asOfBell: 10, ...extra });
const KEEPS = new Map([
  ['0,4', keep(0, 4, { tile: 26, troops: 0 })],          // 19 steps, 4 provinces
  ['-1,4', keep(-1, 4, { tile: 11 })],                    // 23 steps, 4 provinces
  ['-2,4', keep(-2, 4)],                                  // no path
  ['4,-4', keep(4, -4)],                                  // the planner answers 5 provinces
  ['3,-4', keep(3, -4)],                                  // 33 steps
  ['2,2', keep(2, 2, { heartland: true })],
  ['1,2', keep(1, 2, { holder: 0 })],                     // the viewer's own
  ['0,3', keep(0, 3, { consolidatedUntil: 40 })],         // protected after a capture
  ['0,2', keep(0, 2, { holder: 6 })],                     // the Concord's
  ['1,3', keep(1, 3, { tile: 255 })],                     // no keep
]);
const provinces = n => Array.from({ length: n }, (_, i) => ({ p: i, q: 0 }));
const answer = (hexes, nProv, secs) => ({ dirs: new Array(hexes).fill(0), pathLen: hexes, path: [], secs, hexes, provinces: provinces(nProv) });
const at = (p, q, tile) => { const h = tileHex(p, q, tile); return `${h.q},${h.r}`; };
/** A kernel that answers plan_path from a table `start hex > dest hex → route | null` and counts the questions. */
function fixtureKernel(table) {
  const k = { calls: [], call(name, args) {
    k.calls.push({ name, args });
    if (name !== 'plan_path') return { ok: false, reason: 'no such export' };
    const key = `${args.start.q},${args.start.r}>${args.dest.q},${args.dest.r}`;
    return { ok: true, value: table[key] ?? null };
  } };
  return k;
}
const HOME = { p: 1, q: 1, tile: 38, unit: 0 };
const from = (o, k) => `${at(o.p, o.q, o.tile)}>${at(k.p, k.q, k.tile)}`;
const TABLE = {
  [from(HOME, KEEPS.get('0,4'))]: answer(19, 4, 2460),
  [from(HOME, KEEPS.get('-1,4'))]: answer(23, 4, 3000),
  [from(HOME, KEEPS.get('4,-4'))]: answer(20, 5, 2500),
  [from(HOME, KEEPS.get('3,-4'))]: answer(MAX_PATH_STEPS + 1, 4, 4000),
  // the planner would find these too, but none of them is a candidate
  [from(HOME, KEEPS.get('2,2'))]: answer(5, 2, 600), [from(HOME, KEEPS.get('1,2'))]: answer(4, 2, 500),
  [from(HOME, KEEPS.get('0,3'))]: answer(9, 3, 1100), [from(HOME, KEEPS.get('0,2'))]: answer(6, 2, 700),
};
const SEEDS = [{ ring: 0, seed: '00' }];
const ask = (extra = {}) => ({ kernel: fixtureKernel(TABLE), keeps: KEEPS, origins: [HOME], seeds: SEEDS, faction: 0, nowBell: 26, controlBell: 26, ...extra });

// ------------------------------------------------------------------ the builder
test('contestable keeps: another nation\'s, not a heartland, not inside a known protection', () => {
  const pq = ks => ks.map(k => `${k.p},${k.q}`);
  assert.deepEqual(pq(contestableKeeps(KEEPS, { faction: 0, nowBell: 26 })), ['0,4', '-1,4', '-2,4', '4,-4', '3,-4']);
  assert.ok(pq(contestableKeeps(KEEPS, { faction: 0, nowBell: 40 })).includes('0,3'), 'the protection ended');
  assert.ok(pq(contestableKeeps(KEEPS, { faction: 1, nowBell: 26 })).includes('1,2'));
  assert.deepEqual(pq(contestableKeeps(Object.fromEntries(KEEPS), { faction: 0, nowBell: 26 })).length, 5, 'a plain object of keeps reads the same');
});

test('the reachable list: the planner\'s routes within 4 provinces and the step limit, nearest first; the rest named unreachable', () => {
  const a = ask();
  const r = reachableKeeps(a);
  assert.equal(r.ok, true);
  assert.deepEqual(r.rows.map(x => [x.p, x.q, x.tile, x.holder, x.troops, x.route.hexes, x.route.provinces.length, x.route.secs]),
    [[0, 4, 26, 1, 0, 19, 4, 2460], [-1, 4, 11, 1, 100, 23, 4, 3000]]);
  assert.deepEqual(r.unreachable, ['-2,4', '4,-4', '3,-4']);
  assert.equal(MAX_ROUTE_PROVINCES, 4);
  // exactly the composer's planner: one plan_path per candidate keep and origin, with the season's seeds
  assert.equal(a.kernel.calls.length, 5);
  assert.ok(a.kernel.calls.every(c => c.name === 'plan_path' && c.args.unit === 0 && c.args.seeds === SEEDS && c.args.blocked.length === 0));
  for (const k of ['0,4', '4,-4', '3,-4', '-2,4']) {
    const p = planRoute(fixtureKernel(TABLE), { from: HOME, to: KEEPS.get(k), unit: 0, seeds: SEEDS });
    assert.equal(p.ok, r.rows.some(x => `${x.p},${x.q}` === k), k);
  }
  assert.deepEqual(reachableKeeps(ask({ kernel: null })), { ok: false, code: 'NoKernel' });
  assert.deepEqual(reachableKeeps(ask({ origins: [] })).rows, [], 'no origin, no route');
});

test('several hosts: each keep by its fastest host; a keep one host reaches is reachable', () => {
  const horse = { p: 1, q: 2, tile: 5, unit: 2, host: '77', troops: 300 };
  const foot = { ...HOME, host: '76', troops: 500 };
  const table = { ...TABLE, [from(horse, KEEPS.get('0,4'))]: answer(21, 4, 1500), [from(horse, KEEPS.get('-2,4'))]: answer(25, 4, 1900) };
  const r = reachableKeeps(ask({ kernel: fixtureKernel(table), origins: [foot, horse] }));
  assert.deepEqual(r.rows.map(x => [`${x.p},${x.q}`, x.route.secs, x.origin.host]), [['0,4', 1500, '77'], ['-2,4', 1900, '77'], ['-1,4', 3000, '76']]);
  assert.deepEqual(r.unreachable, ['4,-4', '3,-4']);
});

// ------------------------------------------------------------------ the cache
test('the cache: one answer per origins, turn and control snapshot', () => {
  const a = ask();
  const first = cachedReach(null, a);
  assert.equal(first.key, reachKey(a));
  assert.equal(a.kernel.calls.length, 5);
  assert.equal(cachedReach(first, a), first, 'the same question: the same answer');
  assert.equal(a.kernel.calls.length, 5, 'and the kernel is not asked again');
  for (const patch of [{ nowBell: 27 }, { controlBell: 27 }, { origins: [{ ...HOME, tile: 39 }] }, { origins: [{ ...HOME, unit: 2 }] }, { origins: [HOME, { ...HOME, p: 2 }] }, { faction: 2 }]) {
    const b = { ...a, ...patch }, before = a.kernel.calls.length;
    const next = cachedReach(first, b);
    assert.notEqual(next, first, JSON.stringify(patch));
    assert.notEqual(next.key, first.key);
    assert.ok(a.kernel.calls.length > before, 'asked again');
  }
  // a missing kernel is not kept: the list is made once the kernel is there
  const none = cachedReach(null, { ...a, kernel: null });
  assert.equal(none.ok, false);
  assert.equal(cachedReach(none, a).ok, true);
});

// ------------------------------------------------------------------ the screens
const h = (extra = {}) => ({ p: 2, q: 0, site: 2, gen: 0, tile: 20, faction: 0, state: 2, tier: 0, flags: 0, production: baseProduction(0), upkeep: Array(8).fill(0n), stores: [], reserve: Array(8).fill(0), queue: [], transit: [], explore: { state: 0 }, lastOwnerAction: 1000n, finalTs: 1n, shieldUntil: 0n, ...extra });
const entry = (extra = {}) => ({ id: hostId({ p: 2, q: 0, site: 2, gen: 0, seq: 1 }), unit: 0, state: 1, tile: 20, troops: 100000, staminaValue: 120, staminaBell: 10, readyBell: 10, pendOp: 0, fromBell: 10, ...extra });
const fs = (extra = {}) => ({ mode: 'play', season: { programVersion: 3, layoutVersion: 2, endBell: 2016, bellSecs: 600, dormantAfterSecs: 86400, releaseAfterSecs: 172800, minLead: 2, maxLead: 72 }, citizen: { faction: 0 }, holdings: [h()], nowBell: 10,
  chain: { now: () => 1000 }, land: { stage: 'final' }, provinces: new Map([['2,0', { province: { p: 2, q: 0, resolvedNext: 10, entries: [entry()], ticketCohorts: [] } }]]), ...extra });
const text = markup => String(markup).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
const reachOf = (s, table, keeps) => { const { home, origins } = reachOrigins(s); return cachedReach(null, { kernel: fixtureKernel(table), keeps, origins, home, seeds: SEEDS, faction: 0, nowBell: s.nowBell, controlBell: 9 }); };

test('the origins: the ready combat hosts, or the village tile with unit 0 when none is ready', () => {
  assert.deepEqual(reachOrigins(fs()), { home: false, origins: [{ p: 2, q: 0, tile: 20, unit: 0, host: String(entry().id), troops: 100 }] });
  const tired = fs({ provinces: new Map([['2,0', { province: { p: 2, q: 0, resolvedNext: 10, entries: [entry({ staminaValue: 3 })], ticketCohorts: [] } }]]) });
  assert.deepEqual(reachOrigins(tired), { home: true, origins: [{ p: 2, q: 0, tile: 20, unit: 0 }] });
  assert.deepEqual(reachOrigins(fs({ holdings: [] })), { home: true, origins: [] });
});

test('the nation tab lists the reachable keeps with the composer\'s route wording and a way there', () => {
  const s = fs();
  const o = reachOrigins(s).origins[0];
  const keeps = new Map([['0,4', keep(0, 4, { tile: 26, troops: 0 })], ['-1,4', keep(-1, 4, { tile: 11 })], ['-2,4', keep(-2, 4)]]);
  s.conquest = { keeps, reach: reachOf(s, { [from(o, keeps.get('0,4'))]: answer(19, 4, 2460), [from(o, keeps.get('-1,4'))]: answer(23, 4, 3000) }, keeps) };
  const tab = String(nationTab(s)), words = text(renderReach(s));
  assert.match(tab, /class="conquest-reach hpanel"/);
  assert.match(words, /あなたの軍が届く他国の砦/);
  assert.match(words, /州 0,4 .*守備兵 0 · 19 マス · 4 州 · 約 41 分.*そこへ移動.*州 -1,4 .*守備兵 100 · 23 マス · 4 州 · 約 50 分/);
  assert.doesNotMatch(words, /州 -2,4/);
  assert.match(tab, /data-act="goto" data-p="0" data-q="4"/);
  assert.match(tab, /data-act="goto" data-p="-1" data-q="4"/);
  assert.doesNotMatch(words, /村からの道のり/);
  // before the answer, with no kernel, and outside play
  assert.match(text(renderReach(fs({ conquest: { keeps } }))), /届く砦を調べています…/);
  assert.match(text(renderReach(fs({ conquest: { keeps, reach: { key: 'k', ok: false, code: 'NoKernel' } } }))), /ルールのモジュールがまだ読み込まれていません/);
  assert.equal(String(renderReach(fs({ mode: 'spectate', conquest: s.conquest }))), '');
  assert.equal(String(renderReach(fs({ holdings: [], conquest: s.conquest }))), '');
  assert.equal(String(renderReach(fs({ nowBell: 2016, conquest: s.conquest }))), '', 'a finished season has no marches');
});

test('nothing in reach: said plainly with the reason; from the village when no host is ready', () => {
  const tired = fs({ provinces: new Map([['2,0', { province: { p: 2, q: 0, resolvedNext: 10, entries: [entry({ staminaValue: 3 })], ticketCohorts: [] } }]]) });
  const keeps = new Map([['-2,4', keep(-2, 4)]]);
  tired.conquest = { keeps, reach: reachOf(tired, {}, keeps) };
  const words = text(renderReach(tired));
  assert.match(words, /いま届く他国の砦はありません。進軍が越えられるのは4州までです。/);
  assert.match(words, /出発できる戦闘部隊がいないため、村からの道のりで調べています。/);
  assert.doesNotMatch(String(renderReach(tired)), /data-act="goto"/);
  setLang('en');
  assert.doesNotMatch(text(renderReach(tired)), /[぀-ヿ㐀-鿿]/);
  assert.match(text(renderReach(tired)), /at most 4 provinces/);
});

test('the keep panel says when no ready host has a route, and keeps its buttons', () => {
  const s = fs();
  const o = reachOrigins(s).origins[0];
  const far = keep(4, 0, { consolidatedUntil: 0 }), near = keep(3, 0, { consolidatedUntil: 0 });
  const keeps = new Map([['4,0', far], ['3,0', near]]);
  s.conquest = { keeps, reach: reachOf(s, { [from(o, near)]: answer(8, 2, 900) }, keeps) };
  assert.equal(keepUnreachable(s, far), true);
  assert.equal(keepUnreachable(s, near), false);
  const panel = String(renderKeep(s, far));
  assert.match(panel, /この砦へは届く道がありません（進軍は4州まで）/);
  assert.match(panel, /data-act="cq-march" data-host="[0-9]+" data-p="4" data-q="0" data-tile="30" >/, 'the button stays usable');
  assert.match(panel, /data-act="tab" data-tab="nation"[^>]*>届く砦の一覧を見る/);
  assert.doesNotMatch(String(renderKeep(s, near)), /届く道がありません/);
  // no note before the list exists, for the viewer's own keep, or for a list made from the village (no host is ready)
  assert.doesNotMatch(String(renderKeep(fs({ conquest: { keeps } }), far)), /届く道がありません/);
  assert.doesNotMatch(String(renderKeep(s, keep(4, 0, { holder: 0, consolidatedUntil: 0 }))), /届く道がありません/);
  assert.equal(keepUnreachable({ conquest: { reach: { ...s.conquest.reach, home: true } } }, far), false);
  setLang('en');
  assert.doesNotMatch(text(renderKeep(s, far)), /[぀-ヿ㐀-鿿]/);
});

test('the composer without a route offers the reachable list (the Marches tab and the march card)', () => {
  const compose = { host: { ...entry(), troops: 100 }, origin: { p: 2, q: 0 }, dest: { p: 4, q: 0, tile: 30 }, route: null, routeError: 'NoPath', stance: 1, retreat: 'never', tip: '14671', arriveBell: 12 };
  const season = { ...fs().season, minRevealPriorityMilli: 1000n, revealCuLimit: 1000, revealLoadedLimit: 1000, marchFee: 1n, sealBond: 1n };
  for (const render of [composer, marchCard]) {
    const none = String(render(fs({ season, compose })));
    assert.match(none, /そこまでの道が見つかりません/);
    assert.match(none, /data-act="tab" data-tab="nation"[^>]*>届く砦の一覧を見る/);
    assert.match(String(render(fs({ season, compose: { ...compose, routeError: 'Path' } }))), /届く砦の一覧を見る/);
    assert.doesNotMatch(String(render(fs({ season, compose: { ...compose, routeError: 'NoKernel' } }))), /届く砦の一覧を見る/);
    assert.doesNotMatch(String(render(fs({ season, compose: { ...compose, routeError: null, route: answer(3, 1, 360) } }))), /届く砦の一覧を見る/);
    assert.doesNotMatch(String(render(fs({ season: { ...season, programVersion: 2 }, compose }))), /届く砦の一覧を見る/, 'not a conquest season: no list to go to');
  }
});

// ------------------------------------------------------------------ the controller
test('the controller fills the list on request from the keeps it holds: no read, once per turn and control snapshot', () => {
  const saved = { ...FS };
  let reads = 0;
  const count = () => { reads++; return Promise.resolve({ ok: false }); };
  try {
    const s = fs();
    const o = reachOrigins(s).origins[0];
    const keeps = new Map([['0,4', keep(0, 4, { tile: 26 })], ['-2,4', keep(-2, 4)]]);
    const kernel = fixtureKernel({ [from(o, keeps.get('0,4'))]: answer(19, 4, 2460) });
    Object.assign(FS, s, { kernel, record: { rings: [{ d: 0, seed: '00' }] }, conquest: { keeps } });
    C.useHerald({ control: count, standings: count, province: count, keep: count, overview2: count, season: count, me: count });
    assert.equal(C.wantKeepReach(), false, 'no control snapshot yet: nothing to ask about');
    assert.equal(kernel.calls.length, 0);
    FS.conquest.control = { bell: 9, provinces: [] };
    assert.equal(C.wantKeepReach(), true);
    assert.deepEqual(FS.conquest.reach.rows.map(x => `${x.p},${x.q}`), ['0,4']);
    assert.deepEqual(FS.conquest.reach.unreachable, ['-2,4']);
    assert.equal(FS.conquest.reach.home, false);
    assert.deepEqual(kernel.calls[0].args.seeds, [{ ring: 0, seed: '00' }]);
    const asked = kernel.calls.length;
    assert.equal(C.wantKeepReach(), false);
    assert.equal(C.wantKeepReach(), false);
    assert.equal(kernel.calls.length, asked, 'the same turn and snapshot: the kernel is not asked again');
    FS.nowBell = 11;
    assert.equal(C.wantKeepReach(), true, 'a new turn');
    FS.conquest.control = { bell: 10, provinces: [] };
    assert.equal(C.wantKeepReach(), true, 'a new control snapshot');
    assert.equal(kernel.calls.length, asked * 3);
    assert.equal(reads, 0, 'no request at all');
    FS.citizen = null;
    assert.equal(C.wantKeepReach(), false, 'a spectator has no marches');
  } finally { C.useHerald(null); for (const k of Object.keys(FS)) if (!(k in saved)) delete FS[k]; Object.assign(FS, saved); }
});
