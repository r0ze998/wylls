// fix-camp-reach (pacing-measure-2 D-pacing-measure-2-4, Q-PM2-1 (c)): the march-first guide names only a barbarian camp
// the host can REACH — the planner's limits (≤ 4 provinces, ≤ 32 steps) and the march card's own route question (the rules'
// planner, the arrival window) —, never one whose march card says "No path there was found". With no fighting camp in
// sight and in reach: the practice battle (#261). The fog is unchanged (Q-PM2-1 (a) is r0ze's call): a camp under the fog
// is never named, even the one in the village's own province.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setLang } from '../../permutation-server/web/lang.mjs';
import { hostId } from '../../permutation-server/web/frontier/faddr.mjs';
import { baseProduction } from '../../permutation-server/web/frontier/fland.mjs';
import { ringOf, tileHex } from '../../permutation-server/web/frontier/fgeo.mjs';
import * as FB from '../../permutation-server/web/frontier/hud/firstbattle.mjs';
import { conquestObjective, campReach } from '../../permutation-server/web/frontier/screens/conquestguide.mjs';
import { guideTarget } from '../../permutation-server/web/frontier/hud/guide.mjs';
import { MAX_PATH_STEPS } from '../../permutation-server/web/frontier/seal.mjs';
import { MAX_ROUTE_PROVINCES } from '../../permutation-server/web/frontier/fkeepreach.mjs';

afterEach(() => setLang('ja'));
const CJK = /[぀-ヿ㐀-鿿]/;
const src = rel => readFileSync(new URL(`../../permutation-server/web/frontier/${rel}`, import.meta.url), 'utf8');

// ------------------------------------------------------------------ fixtures: a rim village (the pacing-measure-2 world)
const RIM = { p: -65, q: -63 };
const GEN = 1_000_000;
const CLOCK = { genesisTs: GEN, drand: { genesis: 0, period: 3 }, margin: 60, window: () => 600 };
const SEASON = { programVersion: 3, layoutVersion: 2, endBell: 4294967295, bellSecs: 600, minLead: 2, maxLead: 72, conquestParams: { keepBells: 72 } };
const HID = hostId({ p: RIM.p, q: RIM.q, site: 2, gen: 0, seq: 1 });
const HOME = { ...RIM, site: 2, gen: 0, tile: 20, faction: 0, state: 2, order: 1, tier: 0, flags: 0, production: baseProduction(0), upkeep: Array(8).fill(0n), stores: [], reserve: Array(8).fill(0), queue: [],
  transit: [{ state: 0 }], explore: { state: 0 }, lastOwnerAction: 1000n, finalTs: 1n, shieldUntil: 0n };
const entry = { id: HID, unit: 0, state: 1, tile: 20, troops: 300000, staminaValue: 120, staminaBell: 10, readyBell: 10, pendOp: 0, fromBell: 10, faction: 0 };
const mirror = () => Array.from({ length: 12 }, () => ({ state: 0, faction: 0, gen: 0, garrison: 0 }));
const prov = (p, q, c, entries = []) => ({ province: { p, q, resolvedNext: 10, entries, ticketCohorts: [], siteCount: 12, sites: [20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31], siteMirror: mirror(),
  camp: c ? { state: 1, tile: c.tile ?? 8, troops: c.troops, gen: 0 } : null } });
/** `camps`: [{p, q, troops, tile}] — the home province's camp included when listed. */
const world = ({ camps = [], extra = {} } = {}) => {
  const provinces = new Map([[`${RIM.p},${RIM.q}`, prov(RIM.p, RIM.q, camps.find(c => c.p === RIM.p && c.q === RIM.q) ?? null, [entry])]]);
  for (const c of camps) if (!(c.p === RIM.p && c.q === RIM.q)) provinces.set(`${c.p},${c.q}`, prov(c.p, c.q, c));
  return { mode: 'play', season: SEASON, clock: CLOCK, citizen: { faction: 0, arrivals: 0 }, holdings: [HOME], nowBell: 10, chain: { now: () => GEN + 10 * 600 + 100 }, land: { stage: 'final' }, inFlight: 0,
    provinces, conquest: { status: 'ready', keeps: new Map(), events: [] }, marches: [], orders: [], ui: { dismissed: [] }, terrainOf: () => null, ...extra };
};
const host = { id: HID, unit: 0, troops: 300, ...RIM, tile: 20 };
// the own province's camp (the one a march reaches, "5 tiles away") under the fog; a heartland ring-3 camp in sight
const OWN = { ...RIM, troops: 156, tile: 8 }, RING3 = { p: 3, q: 0, troops: 271, tile: 33 };
const fogOwn = (p, q) => !(p === RIM.p && q === RIM.q);

// ------------------------------------------------------------------ the planner's limits (pure)
test('campInBounds: a march crosses at most 4 provinces and 32 steps — a ring-3 camp is out of a rim village\'s reach', () => {
  assert.equal(MAX_ROUTE_PROVINCES, 4);
  assert.equal(MAX_PATH_STEPS, 32);
  assert.equal(ringOf(RIM.p, RIM.q), 128, 'the fixture is a rim village (ring 128)');
  assert.equal(FB.campInBounds(host, RING3), false, '125+ provinces away');
  assert.equal(FB.campInBounds(host, OWN), true, 'its own province');
  // province distance 4 may be in reach (the route ENTERS at most 4 provinces, the start not counted: fix-campreach-4,
  // Q-TG4-1 — it said 3); 5 never is
  assert.equal(FB.campInBounds({ p: 0, q: 0 }, { p: 3, q: 0 }), true);
  assert.equal(FB.campInBounds({ p: 0, q: 0 }, { p: 4, q: 0 }), true);
  assert.equal(FB.campInBounds({ p: 0, q: 0 }, { p: 5, q: 0 }), false);
  // with tiles: 3 provinces apart but the far edges are more than 32 hexes apart
  assert.equal(FB.campInBounds({ p: 0, q: 0, tile: 0 }, { p: 3, q: 0, tile: 60 }), false);
  assert.equal(FB.campInBounds({ p: 0, q: 0, tile: 60 }, { p: 1, q: 0, tile: 0 }), true);
});

// ------------------------------------------------------------------ the rim village of pacing-measure-2
test('rim village, own camp under the fog, only a ring-3 camp in sight: no camp is named, the practice battle is offered (JA + EN)', () => {
  const s = world({ camps: [OWN, RING3] });
  // the old pick: the ring-3 camp (the host beats 271 at the worst roll)
  assert.equal(FB.campChoice(s, host, { seen: fogOwn, rough: () => false }), null);
  // it is still a fighting camp in sight (so the guide can say "none in reach", not "none in sight")
  assert.deepEqual(FB.fightingCampsInSight(s, host, { seen: fogOwn }).map(x => [x.p, x.q]), [[3, 0]]);
  // the fog is unchanged: the own province's camp is not a candidate while unseen
  assert.equal(FB.fightingCampsInSight(s, host, { seen: fogOwn }).some(x => x.p === RIM.p && x.q === RIM.q), false);
  // the page's own fog (viewTile) without a fog snapshot sees everything: give the guide a world whose only seen camp is ring 3
  const sg = world({ camps: [RING3] });
  const o = conquestObjective(sg);
  assert.equal(o.go.act, 'practice-open');
  assert.match(o.text, /^見えている蛮族の野営地には、まだこの軍勢が届きません（1 回の進軍で行けるのは 4 州・32 マスまでです）。/);
  assert.match(o.text, /練習の戦い（チェーンの記録ではありません）/);
  assert.doesNotMatch(o.text, /守り手 271/, 'the unreachable camp is never named');
  assert.equal(guideTarget(sg), null, 'the guide\'s press never opens the march card on the unreachable camp');
  setLang('en');
  const en = conquestObjective(sg);
  assert.doesNotMatch(en.text, CJK);
  assert.doesNotMatch(en.text, /season/i);
  assert.match(en.text, /^No camp in reach yet: no barbarian camp in sight is within this host's reach \(one march goes at most 4 provinces and 32 tiles\)\. Meanwhile, try a practice battle \(not a chain record\)/);
  assert.equal(en.go.label, 'Fight a practice clash');
});

test('rim village with its own province\'s camp in sight: that camp is the first battle (and the ring-3 one is not)', () => {
  const s = world({ camps: [OWN, RING3] });
  const c = FB.campChoice(s, host, { rough: () => false });
  assert.deepEqual(c.camp, { p: RIM.p, q: RIM.q, tile: 8, troops: 156 });
  assert.equal(c.winnable, true);
  const o = conquestObjective(s);
  assert.equal(o.go.act, 'ob-go');
  assert.match(o.text, /守り手 156/);
  assert.deepEqual(guideTarget(s), { step: 'camp', kind: 'march', p: RIM.p, q: RIM.q, tile: 8, host: String(HID) });
});

// ------------------------------------------------------------------ the march card's own route question
test('campReach: the rules\' planner and the arrival window, as the march card asks them', () => {
  const near = { p: RIM.p + 1, q: RIM.q, tile: 8 };
  // no rules module: not known (kept; the card asks again)
  assert.equal(campReach(world(), host, near), null);
  // the planner finds no route: false — the card would say "No path there was found"
  const none = world({ extra: { kernel: { call: name => name === 'plan_path' ? { ok: false, reason: 'no route' } : { ok: false } }, record: { rings: [] } } });
  assert.equal(campReach(none, host, near), false);
  // a route whose earliest turn is past the arrival window (now 10 + maxLead 72): false — the card refuses the turn
  const anyRoute = { call: (name) => name === 'plan_path' ? { ok: true, value: { dirs: [0], pathLen: 1, path: new Uint8Array(4), secs: 600, hexes: 1, provinces: [{ ...RIM }] } }
    : name === 'earliest_arrival_bell' ? { ok: true, value: 10 + 72 + 1 } : { ok: false } };
  assert.equal(campReach(world({ extra: { kernel: anyRoute, record: { rings: [] } } }), host, near), false);
  // inside the window: true
  const inTime = { call: (name) => name === 'plan_path' ? { ok: true, value: { dirs: [0], pathLen: 1, path: new Uint8Array(4), secs: 600, hexes: 1, provinces: [{ ...RIM }] } }
    : name === 'earliest_arrival_bell' ? { ok: true, value: 14 } : { ok: false } };
  assert.equal(campReach(world({ extra: { kernel: inTime, record: { rings: [] } } }), host, near), true);
});

test('the guide names the nearest camp the planner reaches, routing lazily (an in-bounds camp without a route is passed by)', () => {
  // two camps in bounds: the nearer has no route (a sea, a palisade), the farther has one
  const A = { p: RIM.p + 1, q: RIM.q, troops: 120, tile: 8 }, B = { p: RIM.p + 2, q: RIM.q, troops: 130, tile: 8 };
  const calls = [];
  const only = new Set([`${B.p},${B.q}`]);
  const kernel = { call: (name, a) => {
    calls.push(name);
    if (name === 'plan_path') {
      // the destination hex → province: the planner answers only for B's tile
      const ok = a.dest && only.has(provOfHex(a.dest));
      return ok ? { ok: true, value: { dirs: [0, 0], pathLen: 2, path: new Uint8Array(8), secs: 1200, hexes: 2, provinces: [{ ...RIM }, { p: B.p, q: B.q }] } } : { ok: false, reason: 'no route' };
    }
    if (name === 'earliest_arrival_bell') return { ok: true, value: 14 };
    return { ok: false };
  } };
  const s = world({ camps: [A, B, RING3], extra: { kernel, record: { rings: [] } } });
  const c = FB.campChoice(s, host, { rough: () => false, reach: camp => campReach(s, host, camp) });
  assert.deepEqual([c.camp.p, c.camp.q], [B.p, B.q]);
  // the ring-3 camp was never routed (out of the planner's limits); A and B once each
  assert.equal(calls.filter(x => x === 'plan_path').length, 2);
  // drawn again: no new route questions
  FB.campChoice(s, host, { rough: () => false, reach: camp => campReach(s, host, camp) });
  assert.equal(calls.filter(x => x === 'plan_path').length, 2);
  // the guide step and its press name B
  assert.match(conquestObjective(s).text, /守り手 130/);
  assert.deepEqual(guideTarget(s)?.p, B.p);
  // nothing in reach at all: practice
  only.clear();
  const s2 = world({ camps: [A, RING3], extra: { kernel: { call: kernel.call }, record: { rings: [] } } });
  assert.equal(conquestObjective(s2).go.act, 'practice-open');
});

// the province a hex lies in (fgeo's own inverse, through tileHex)
function provOfHex(h) {
  for (let p = RIM.p - 3; p <= RIM.p + 3; p++) for (let q = RIM.q - 3; q <= RIM.q + 3; q++) for (let t = 0; t < 61; t++) {
    const x = tileHex(p, q, t);
    if (x.q === h.q && x.r === h.r) return `${p},${q}`;
  }
  return null;
}

// ------------------------------------------------------------------ the page's wiring (source pins)
test('every caller of campChoice passes the march card\'s route question; the fog test is unchanged', () => {
  const cg = src('screens/conquestguide.mjs'), gd = src('hud/guide.mjs');
  assert.match(cg, /campChoice\(FS, ready, \{ seen, rough: \(p, q, t\) => roughAt\(FS, p, q, t\), reach: camp => campReach\(FS, ready, camp\) \}\)/);
  assert.match(cg, /campChoice\(FS, fr, \{ seen: \(p, q, tl\) => viewTile\(p, q, tl, 2\), rough: \(p, q, tl\) => roughAt\(FS, p, q, tl\), reach: camp => campReach\(FS, fr, camp\) \}\)/);
  assert.match(gd, /campChoice\(FS, host, \{ seen: \(p, q, t\) => viewTile\(p, q, t, 2\), rough: \(p, q, t\) => roughAt\(FS, p, q, t\), reach: camp => campReach\(FS, host, camp\) \}\)/);
  const lines = [...cg.split('\n'), ...gd.split('\n')].filter(l => /campChoice\(FS/.test(l));
  assert.equal(lines.length, 3);
  for (const l of lines) assert.match(l, /reach: camp => campReach\(FS, /, 'every call carries reach');
  // the march card's planner, the same call as controller.mjs's draft route
  assert.match(cg, /export function campReach\(FS, r, camp\)[\s\S]{0,1200}planRoute\(FS\.kernel, \{ from: \{ p: r\.p, q: r\.q, tile: r\.tile \}/);
  // the fog's own test, unchanged: the step still asks viewTile(.., 2)
  assert.match(cg, /const seen = \(p, q, t\) => viewTile\(p, q, t, 2\);/);
});

test('the march card\'s "Nearby destinations" offers no camp beyond the planner\'s limits (the fog cut first, unchanged)', () => {
  const ctl = src('controller.mjs');
  const fn = ctl.slice(ctl.indexOf('function quickDestinations(from = null) {'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  // the fog cut (verify-pr117), byte for byte, before the reach filter
  const fog = body.indexOf("if (camp?.state === 1 && viewTile(env.province.p, env.province.q, camp.tile, 2)) out.push({ kind: 'camp'");
  const cut = body.indexOf("if (from) return out.filter(d => d.kind !== 'camp' || campInBounds(from, d));");
  assert.ok(fog > 0 && cut > fog);
  assert.match(ctl, /quick: quickDestinations\(\{ p: r\.p, q: r\.q, tile: r\.tile \}\)/);
  assert.match(ctl, /import \{ campInBounds \} from '\.\/hud\/firstbattle\.mjs';/);
  // the rule it applies, on the rim village's list: its own camp stays, the far camps (ring 3, the opposite rim) go
  const list = [{ kind: 'camp', ...OWN }, { kind: 'camp', ...RING3 }, { kind: 'camp', p: 65, q: 63, tile: 22 }, { kind: 'holding', ...RIM, tile: 20 }];
  assert.deepEqual(list.filter(d => d.kind !== 'camp' || FB.campInBounds(host, d)).map(d => [d.kind, d.p, d.q]), [['camp', RIM.p, RIM.q], ['holding', RIM.p, RIM.q]]);
});
