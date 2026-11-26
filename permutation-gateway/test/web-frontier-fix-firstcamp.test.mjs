// fix-firstcamp (loop-play22 LP22-1, Q-LP22-1 rec (a), Grok 17:02/19:24): the guide's "nearest barbarian camp" is a
// camp that FIGHTS. The rule (frontier-abi clash_model.rs `camp.present() && garrisons.len() < MAX_GARRISONS`;
// permutation-frontier proc/clash.rs "12 holdings and a camp: the camp sits the bell out") lets a camp join a clash only
// while fewer than 12 holdings stand in its province; the `--demo` home province holds 12 villages, so the guide's
// first battle was a non-battle ("Held", 0 losses). Page only: these tests pin the pure parts.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { setLang } from '../../permutation-server/web/lang.mjs';
import { hostId } from '../../permutation-server/web/frontier/faddr.mjs';
import { baseProduction } from '../../permutation-server/web/frontier/fland.mjs';
import * as FB from '../../permutation-server/web/frontier/hud/firstbattle.mjs';
import { MAX_GARRISONS } from '../../permutation-server/web/frontier/screens/report.mjs';
import { conquestObjective, campWay } from '../../permutation-server/web/frontier/screens/conquestguide.mjs';
import { guideTarget } from '../../permutation-server/web/frontier/hud/guide.mjs';
import { defendersAt } from '../../permutation-server/web/frontier/hud/marchcard.mjs';
import { bellStart } from '../../permutation-server/web/frontier/clock.mjs';
import { setClockPace } from '../../permutation-server/web/frontier/screens/shell.mjs';
import { setTermsPace } from '../../permutation-server/web/frontier/seasonterms.mjs';

afterEach(() => { setLang('ja'); setClockPace(null); setTermsPace(null); });
const CJK = /[぀-ヿ㐀-鿿]/;

// ------------------------------------------------------------------ fixtures (the pt-first-battle shape)
const GEN = 1_000_000;
const CLOCK = { genesisTs: GEN, drand: { genesis: 0, period: 3 }, margin: 60, window: () => 600 };
const HOME = (extra = {}) => ({ p: 2, q: 0, site: 2, gen: 0, tile: 20, faction: 0, state: 2, order: 1, tier: 0, flags: 0, production: baseProduction(0), upkeep: Array(8).fill(0n), stores: [], reserve: Array(8).fill(0), queue: [],
  transit: [{ state: 0 }], explore: { state: 0 }, lastOwnerAction: 1000n, finalTs: 1n, shieldUntil: 0n, ...extra });
const HID = hostId({ p: 2, q: 0, site: 2, gen: 0, seq: 1 });
const entry = (extra = {}) => ({ id: HID, unit: 0, state: 1, tile: 20, troops: 300000, staminaValue: 120, staminaBell: 10, readyBell: 10, pendOp: 0, fromBell: 10, faction: 0, ...extra });
const SEASON = { programVersion: 3, layoutVersion: 2, endBell: 4294967295, bellSecs: 600, minLead: 2, maxLead: 72, conquestParams: { keepBells: 72 } };
const mirror = (n, state = 1) => Array.from({ length: 12 }, (_, i) => ({ state: i < n ? state : 0, faction: i % 6, gen: 0, garrison: 0 }));
// `held`: holdings standing in that province (12 = the --demo home province)
const camp = (p, q, troops, { tile = 33, held = 0, state = 1 } = {}) => ({ p, q, state, tile, troops, gen: 0, held });
const prov = (p, q, bell, c, entries = []) => ({ province: { p, q, resolvedNext: bell, entries, ticketCohorts: [], siteCount: 12, sites: [20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31], siteMirror: mirror(c?.held ?? 0), camp: c ? { state: c.state, tile: c.tile, troops: c.troops, gen: 0 } : null } });
const fs = ({ bell = 10, entries = [entry()], camps = [], extra = {} } = {}) => {
  const provinces = new Map([['2,0', prov(2, 0, bell, camps.find(c => c.p === 2 && c.q === 0) ?? null, entries)]]);
  for (const c of camps) if (!(c.p === 2 && c.q === 0)) provinces.set(`${c.p},${c.q}`, prov(c.p, c.q, bell, c));
  return { mode: 'play', season: SEASON, clock: CLOCK, citizen: { faction: 0, arrivals: 0 }, holdings: [HOME()], nowBell: bell, chain: { now: () => GEN + bell * 600 + 100 }, land: { stage: 'final' }, inFlight: 0,
    provinces, conquest: { status: 'ready', keeps: new Map(), events: [] }, marches: [], orders: [], ui: { dismissed: [] }, terrainOf: () => null, ...extra };
};
const host = { id: HID, unit: 0, troops: 300, p: 2, q: 0, tile: 20 };

// ------------------------------------------------------------------ the rule
test('the cap is the rule\'s MAX_GARRISONS (report.mjs, clash::MAX_GARRISONS = 12)', () => {
  assert.equal(FB.CAMP_GARRISON_CAP, 12);
  assert.equal(FB.CAMP_GARRISON_CAP, MAX_GARRISONS);
});

test('campFights: a standing camp fights only while fewer than 12 holdings stand in its province', () => {
  const pv = (n, st = 1, extra = {}) => ({ siteCount: 12, siteMirror: mirror(n, st), camp: { state: 1, tile: 33, troops: 217 }, ...extra });
  assert.equal(FB.garrisonsIn(pv(12)), 12);
  assert.equal(FB.campFights(pv(12)), false, '12 holdings: the camp sits the bell out (LP22-1)');
  assert.equal(FB.campFights(pv(11)), true, '11 holdings: the camp joins');
  assert.equal(FB.campFights(pv(0)), true);
  // only holdings (state 1) are garrisons: reserved (4), released (3) and free sites are not
  assert.equal(FB.campFights(pv(12, 4)), true);
  assert.equal(FB.campFights(pv(12, 3)), true);
  // (verify-pr265) a v2 genesis Free City (state 5) is a garrison too (clash_model.rs v2_garrison_state, world_index
  // resolve.rs): 12 Free Cities, or 7 holdings + 5 Free Cities, keep the camp out; 6 + 5 = 11 lets it in
  assert.equal(FB.garrisonsIn(pv(12, 5)), 12);
  assert.equal(FB.campFights(pv(12, 5)), false);
  const mixed = k => ({ siteCount: 12, siteMirror: mirror(12).map((m, i) => ({ ...m, state: i < k ? 1 : i < k + 5 ? 5 : 0 })), camp: { state: 1, tile: 33, troops: 217 } });
  assert.equal(FB.campFights(mixed(7)), false);
  assert.equal(FB.campFights(mixed(6)), true);
  // sites past siteCount do not exist
  assert.equal(FB.garrisonsIn(pv(12, 1, { siteCount: 8 })), 8);
  // a beaten camp (state 0, until the daily check places a new one) never fights
  assert.equal(FB.campFights({ ...pv(0), camp: { state: 0, tile: 33, troops: 0 } }), false);
  assert.equal(FB.campFights({ siteCount: 12, camp: null }), false);
  // no site mirrors: no holdings the page knows of
  assert.equal(FB.campFights({ camp: { state: 1, tile: 33, troops: 5 } }), true);
});

// ------------------------------------------------------------------ the choice
test('campChoice skips the camp of a 12-village province (the --demo home) and names it as passed', () => {
  // the home province's camp is nearest (distance 0) and the weakest, but 12 villages stand there
  // (fix-camp-reach: the far camp is 2 provinces away — within a march's reach; 7 provinces away it never is)
  const s = fs({ camps: [camp(2, 0, 100, { held: 12 }), camp(3, 0, 150), camp(4, 0, 90)] });
  const c = FB.campChoice(s, host, { rough: () => false });
  assert.deepEqual(c.camp, { p: 3, q: 0, tile: 33, troops: 150 });
  assert.equal(c.winnable, true);
  assert.deepEqual(c.passed.map(x => [x.p, x.q, x.garrisons]), [[2, 0, 12]]);
  // with 11 villages the home camp fights again and is the pick
  const s11 = fs({ camps: [camp(2, 0, 100, { held: 11 }), camp(3, 0, 150)] });
  assert.deepEqual(FB.campChoice(s11, host, { rough: () => false }).camp, { p: 2, q: 0, tile: 33, troops: 100 });
  assert.deepEqual(FB.campChoice(s11, host, { rough: () => false }).passed, []);
  // only a sitting-out camp in sight: no choice, and campsSittingOut lists it
  const only = fs({ camps: [camp(2, 0, 100, { held: 12 })] });
  assert.equal(FB.campChoice(only, host, { rough: () => false }), null);
  assert.deepEqual(FB.campsSittingOut(only, host).map(x => [x.p, x.q, x.troops]), [[2, 0, 100]]);
  // a passed camp farther than the pick is not named
  const far = fs({ camps: [camp(3, 0, 150), camp(9, 0, 90, { held: 12 })] });
  assert.deepEqual(FB.campChoice(far, host, { rough: () => false }).passed, []);
  // the fog still rules: an unseen fighting camp is not chosen
  const seen = (p, q) => !(p === 3 && q === 0);
  assert.deepEqual(FB.campChoice(s, host, { seen, rough: () => false }).camp.p, 4);
});

test('the guide step names the fighting camp and why the nearer one is passed (JA + EN, no "season")', () => {
  const s = fs({ camps: [camp(2, 0, 100, { held: 12 }), camp(3, 0, 150)] });
  const o = conquestObjective(s);
  assert.equal(o.go.act, 'ob-go');
  assert.match(o.text, /^.+の野営地は近くにありますが、その州には村が 12 立っているため、戦いに加わりません（野営地が戦うのは、州の村が 12 未満のときだけです）。最初の戦いは、.+の蛮族の野営地（守り手 150）にしましょう。/);
  // the camp passed by is in the viewer's own (home) province: named by the viewer's village, not as another side's land
  assert.match(o.text, /^.+のある州の野営地は近くにあります/);
  assert.deepEqual(guideTarget(s), { step: 'camp', kind: 'march', p: 3, q: 0, tile: 33, host: String(HID) });
  setLang('en');
  const en = conquestObjective(s).text;
  assert.doesNotMatch(en, CJK);
  assert.doesNotMatch(en, /season/i);
  assert.match(en, /^The camp of .+ is nearer, but 12 villages stand in its province, so it does not join battles \(a camp fights only while fewer than 12 villages stand in its province\)\. Make your first battle the barbarian camp of .+ \(150 defenders\)\./);
});

test('no fighting camp in sight: the practice battle (#261), said as practice, with a way to look further', () => {
  const s = fs({ camps: [camp(2, 0, 100, { held: 12 })] });
  const o = conquestObjective(s);
  assert.equal(o.go.act, 'practice-open');
  assert.match(o.text, /どれも村が 12 立つ州にあり、戦いに加わりません/);
  assert.match(o.text, /練習の戦い（チェーンの記録ではありません）/);
  assert.equal(guideTarget(s)?.p === 2 && guideTarget(s)?.q === 0, false, 'the map label never points at the sitting-out camp');
  setLang('en');
  const en = conquestObjective(s);
  assert.doesNotMatch(en.text, CJK);
  assert.match(en.text, /^Every barbarian camp in sight stands in a province of 12 villages, so none of them joins a battle .+ practice battle \(not a chain record\)/);
  assert.equal(en.go.label, 'Fight a practice clash');
});

// ------------------------------------------------------------------ the march card's outlook
test('the march card does not count a camp that sits the battle out', () => {
  const full = fs({ camps: [camp(2, 0, 217, { held: 12 })] });
  const d = defendersAt(full, { p: 2, q: 0, tile: 33 });
  assert.equal(d.camp, 0);
  assert.equal(d.campOut, 217);
  assert.equal(d.total, 0);
  const open = fs({ camps: [camp(2, 0, 217, { held: 11 })] });
  const d2 = defendersAt(open, { p: 2, q: 0, tile: 33 });
  assert.equal(d2.camp, 217);
  assert.equal(d2.campOut, 0);
  assert.equal(d2.total, 217);
});

// ------------------------------------------------------------------ the travel time
test('campWay: the rules\' route to the camp, the arrival turn, and the report after that turn', () => {
  const calls = [];
  const kernel = { call: (name, a) => {
    calls.push(name);
    if (name === 'plan_path') return { ok: true, value: { dirs: [0, 0, 0], pathLen: 3, path: new Uint8Array(12), secs: 1500, hexes: 3, provinces: [{ p: 2, q: 0 }, { p: 3, q: 0 }] } };
    if (name === 'earliest_arrival_bell') return { ok: true, value: 14 };
    return { ok: false };
  } };
  const s = fs({ camps: [camp(2, 0, 100, { held: 12 }), camp(3, 0, 150)], extra: { kernel, record: { rings: [] } } });
  const w = campWay(s, host, { p: 3, q: 0, tile: 33 });
  assert.equal(w.arrive.bell, 14);
  assert.equal(w.arrive.inSecs, bellStart(GEN, 14) - (GEN + 10 * 600 + 100));
  assert.match(w.line, /3 マス · 2 州 · 到着はターン 14/);
  // drawn again in the same turn: the route is not asked for again
  const n = calls.filter(x => x === 'plan_path').length;
  campWay(s, host, { p: 3, q: 0, tile: 33 });
  assert.equal(calls.filter(x => x === 'plan_path').length, n);
  // the guide step says the way and the report time of THAT arrival
  const o = conquestObjective(s);
  assert.match(o.text, /道のり：3 マス · 2 州 · 到着はターン 14（.+）。封をして出発すると、最初の戦いの報告は.+に出る見込みです。/);
  setLang('en');
  const en = conquestObjective(s).text;
  assert.doesNotMatch(en, CJK);
  assert.match(en, /The way there: 3 tiles · 2 provinces · arrives turn 14 \(.+\)\. Seal and depart, and the first battle report is expected .+\./);
  // a TEST clock (×60, e.g. a --wide world, where FS.localPlay.clockScale is not set): the wait names the real time —
  // the keep list's waitWords said "about 13 min" there for 13 real seconds
  setClockPace(() => 60); setTermsPace(() => 60);
  const fast = campWay({ ...s, nowBell: 11 }, host, { p: 3, q: 0, tile: 33 });
  assert.match(fast.line, /arrives turn 14 \(in about \d+ min.*real time\)/);
  setClockPace(null); setTermsPace(null);
  // no rules module: no route line, the earliest-report line as before
  assert.equal(campWay({ ...s, kernel: null }, host, { p: 3, q: 0, tile: 33 }), null);
});
