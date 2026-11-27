// test-gaps-4 (#268 provisional first village, #273 reachable camp): what verify-pr268 / verify-pr273 checked by hand or
// live, as properties. Tests only — no behaviour is changed here.
//   P1 villageConfirm = the program's own rule (prologue.rs finality_due / cohort_closed, ported line by line below) on
//      5,000 random records: due exactly when the rule holds; otherwise the time is final_ts once the cohort is closed,
//      else max(final_ts, the 24-turn bound) "at the latest"; past / unknown as documented
//   P2 the guide, the panel and the village card over the same random records: the guide never presses into the Muster
//      card (the program refuses NotFinal) unless the rule holds; the three say ONE wall-clock time (verify-pr268 saw
//      "02:31" on all three live), that time is wall now + left (never the chain's own clock, which sits ~56 years away
//      in these fixtures); the pill's screen-reader name never names the dead "Form a host" step
//   C1 campChoice over 3,000 random worlds (camps around a heartland or a rim village, random fog, 12-holding
//      provinces, random reach answers incl. throws): never an unseen camp, never one that sits out, never one outside
//      the planner's bounds, never one whose route question said false; the nearest winnable reachable camp first;
//      null exactly when no candidate is left (verify-pr273 B1–B7 as one property)
//   C2 the rim village guide over 600 random worlds with a planner stub: the practice battle exactly when no fighting
//      camp in sight is reachable; otherwise the named camp is reachable and the pill's press opens the card on it
//   C3 campInBounds against the REAL rules (frontier.wasm plan_path + path_cost): every route the kernel accepts within
//      3 provinces is in bounds (the 32-step half of the bound is sound)
//   C4 (todo, D-test-gaps-4-1; behaviour NOT changed) the province half: the program counts the provinces a route's
//      STEPS enter (travel.rs path_cost — the start's own province only if a step re-enters it), so a march reaches a
//      camp 4 provinces away; campInBounds drops every such camp (`> MAX_ROUTE_PROVINCES - 1`)
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { setLang } from '../../permutation-server/web/lang.mjs';
import { baseProduction } from '../../permutation-server/web/frontier/fland.mjs';
import { bellStart } from '../../permutation-server/web/frontier/clock.mjs';
import * as SH from '../../permutation-server/web/frontier/screens/shell.mjs';
import * as ST from '../../permutation-server/web/frontier/seasonterms.mjs';
import * as WP from '../../permutation-server/web/frontier/hud/waitpanel.mjs';
import * as PV from '../../permutation-server/web/frontier/hud/provisional.mjs';
import * as FB from '../../permutation-server/web/frontier/hud/firstbattle.mjs';
import { campArrival } from '../../permutation-server/web/frontier/hud/rulebook.mjs';
import { SCOUT } from '../../permutation-server/web/frontier/fland.mjs';
import * as W from '../../permutation-server/web/frontier/wasm.mjs';
import { conquestObjective, campReach } from '../../permutation-server/web/frontier/screens/conquestguide.mjs';
import { guideTarget } from '../../permutation-server/web/frontier/hud/guide.mjs';
import { nextThing } from '../../permutation-server/web/frontier/hud/hud.mjs';
import { hostId } from '../../permutation-server/web/frontier/faddr.mjs';
import { tileHex, ringOf } from '../../permutation-server/web/frontier/fgeo.mjs';
import { planRoute } from '../../permutation-server/web/frontier/fmarch.mjs';
import { MAX_PATH_STEPS } from '../../permutation-server/web/frontier/seal.mjs';
import { MAX_ROUTE_PROVINCES } from '../../permutation-server/web/frontier/fkeepreach.mjs';

afterEach(() => { setLang('ja'); ST.setTermsPace(() => 1); SH.setChainNow(null); });
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const pick = (r, n) => Math.floor(r() * n);
const plain = m => String(m).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
const ROOT = new URL('../../', import.meta.url);
const src = f => readFileSync(new URL(f, ROOT), 'utf8');
const hhmm = (unix, loc) => new Date(unix * 1000).toLocaleTimeString(loc, { hour: '2-digit', minute: '2-digit' });
const hexDist = (a, b) => (Math.abs(a.p - b.p) + Math.abs(a.q - b.q) + Math.abs(a.p + a.q - b.p - b.q)) / 2;
const tileDist = (a, b) => { const x = tileHex(a.p, a.q, a.tile), y = tileHex(b.p, b.q, b.tile); return (Math.abs(x.q - y.q) + Math.abs(x.r - y.r) + Math.abs(x.q + x.r - y.q - y.r)) / 2; };
/** What the rules allow at most (travel.rs path_cost: ≤ 4 provinces entered, ≤ 32 steps), independent of campInBounds. */
const withinRules = (from, to) => hexDist(from, to) <= 4 && tileDist(from, to) <= MAX_PATH_STEPS;

// ------------------------------------------------------------------ the program's rule, ported (not imported) from Rust
const COHORT_BELLS = 24;
test('the port below is the program\'s text (prologue.rs cohort_closed / finality_due, province.rs COHORT_BELLS)', () => {
  const pro = src('frontier-abi/src/prologue.rs');
  assert.ok(pro.includes('    if now_bell >= ticket_bell.saturating_add(P::COHORT_BELLS) {\n        return true;\n    }'));
  assert.ok(pro.includes('(Some(b), Some(f), Some(s)) => b != ticket_bell || f == 0 || s >= f,'));
  assert.ok(pro.includes('    h.state == H::STATE_PROVISIONAL\n        && now >= h.final_ts\n        && cohort_closed(province, h.ticket_bell, now_bell)'));
  assert.ok(src('frontier-abi/src/layout/province.rs').includes(`pub const COHORT_BELLS: u32 = ${COHORT_BELLS};`));
});
const ruleClosed = (cohorts, ticket, nowBell) => nowBell >= ticket + COHORT_BELLS || cohorts.every(c => c.bell !== ticket || c.filed === 0 || c.settled >= c.filed);
const ruleDue = (h, cohorts, now, nowBell) => h.state === 1 && now >= Number(h.finalTs) && ruleClosed(cohorts, h.ticketBell, nowBell);

// ------------------------------------------------------------------ fixtures (the fix-provisional-guide shape)
const GEN = 1_000_000;
const CLOCK = { genesisTs: GEN, drand: { genesis: 0, period: 3 }, margin: 60, window: () => 600 };
const SEASON = { programVersion: 3, layoutVersion: 2, endBell: 4294967295, bellSecs: 600, minLead: 2, maxLead: 72, conquestParams: { keepBells: 72 } };
function randomVillage(r) {
  const ticket = 5 + pick(r, 400);
  const finalTs = bellStart(GEN, ticket + 1 + pick(r, 5)) + 60 * pick(r, 10);
  const bell = ticket + (r() < 0.75 ? pick(r, 8) : pick(r, 32)), at = pick(r, 600);
  const cohorts = [];
  for (let k = pick(r, 4); k > 0; k--) {
    const filed = pick(r, 4), b = r() < 0.7 ? ticket : ticket + pick(r, 5) - 2;
    cohorts.push({ bell: b, filed, settled: r() < 0.5 ? filed : pick(r, filed + 2) });
  }
  const province = r() < 0.85;
  const home = { p: 2, q: 0, site: 2, gen: 0, tile: 20, faction: 0, state: 1, order: 1, tier: 0, flags: 0, production: baseProduction(0), upkeep: Array(8).fill(0n), stores: [],
    reserve: [100, 0, 0, 0, 0, 0, 0, 0], queue: [], transit: [{ state: 0 }], explore: { state: 0 }, lastOwnerAction: 1000n, finalTs: BigInt(finalTs), ticketBell: ticket, shieldUntil: 0n };
  const FS = { mode: 'play', season: SEASON, clock: CLOCK, citizen: { faction: 0, arrivals: 0, flags: 0 }, holdings: [home], nowBell: bell,
    chain: { now: () => GEN + bell * 600 + at }, land: { stage: 'provisional' }, inFlight: 0,
    provinces: province ? new Map([['2,0', { province: { p: 2, q: 0, resolvedNext: bell, entries: [], ticketCohorts: cohorts } }]]) : new Map(),
    conquest: { status: 'ready', keeps: new Map(), events: [] }, marches: [], orders: [], ui: { dismissed: [] }, terrainOf: () => null };
  return { FS, home, ticket, finalTs, bell, now: GEN + bell * 600 + at, cohorts, province };
}

// ------------------------------------------------------------------ P1
test('P1 villageConfirm = the program\'s rule on 5,000 random provisional villages (due / waiting time / past)', () => {
  const r = rng(268);
  const seen = { due: 0, waiting: 0, past: 0, latest: 0, closed: 0 };
  for (let i = 0; i < 5000; i++) {
    const v = randomVillage(r);
    const c = PV.villageConfirm(v.FS);
    const due = v.province && ruleDue(v.home, v.cohorts, v.now, v.bell);
    if (due) { assert.deepEqual(c, { state: 'due', at: null, latest: false }, `#${i}`); seen.due++; continue; }
    const closed = v.province && ruleClosed(v.cohorts, v.ticket, v.bell);
    const at = closed ? v.finalTs : Math.max(v.finalTs, bellStart(GEN, v.ticket + COHORT_BELLS));
    assert.equal(c.at, at, `#${i}: the time (closed ${closed})`);
    assert.equal(c.latest, !closed, `#${i}: "at the latest" exactly while the cohort is open on the page's copy`);
    assert.equal(c.state, at <= v.now ? 'past' : 'waiting', `#${i}`);
    seen[c.state]++; seen.latest += c.latest; seen.closed += closed;
    // the rule never holds on a "waiting" answer (what blocks Muster blocks it for the program too)
    if (c.state === 'waiting') assert.equal(PV.confirmPending(c), true);
  }
  assert.ok(seen.due > 300 && seen.waiting > 1000 && seen.past > 30 && seen.latest > 500 && seen.closed > 200, JSON.stringify(seen));
});

// ------------------------------------------------------------------ P2
const TIME = /(\d\d:\d\d) ?ごろ|around (\d\d:\d\d)/g;
const timesIn = s => [...String(s).matchAll(TIME)].map(m => m[1] ?? m[2]);
test('P2 the guide, the panel and the village card: never the Muster press before the rule holds, one wall-clock time on all three (JA + EN, ×1)', async () => {
  const { provisionalNote } = await import('../../permutation-server/web/frontier/screens/holding.mjs');
  ST.setTermsPace(() => 1);
  const r = rng(2681);
  let timed = 0, due = 0;
  for (let i = 0; i < 600; i++) {
    const v = randomVillage(r);
    const lang = i % 2 ? 'en' : 'ja', loc = lang === 'en' ? 'en-GB' : 'ja-JP';
    setLang(lang);
    const c = PV.villageConfirm(v.FS);
    const t0 = Date.now() / 1000;
    const o = conquestObjective(v.FS);
    const m = WP.waitModel(v.FS), timer = m.timers.find(x => x.id === 'village');
    const panel = timer ? plain(WP.timerLine(v.FS, timer)) : '';
    const card = plain(provisionalNote(v.FS, v.home));
    const t1 = Date.now() / 1000;
    assert.equal(o.id, 'muster', `#${i}`);
    if (c.state === 'due') { due++; assert.deepEqual(o.go.data, { pop: 'muster' }, 'the rule holds: Muster confirms and forms in one press'); continue; }
    assert.notDeepEqual(o.go?.data, { pop: 'muster' }, `#${i} ${c.state}: never the card the program refuses NotFinal`);
    assert.ok(!m.suggestions.some(x => x.id === 'muster'), `#${i}: the panel offers no Form a host either`);
    const nt = nextThing(v.FS, { guide: o, items: [] });
    assert.ok(nt.text.includes(nt.label), `#${i}: the visible label is in the accessible name (WCAG 2.5.3)`);
    // ('past': the step is still "Form a host" and its press is the Harvest that confirms the village — a live press)
    if (c.state === 'past') { assert.deepEqual(o.go.act, 'harvest'); continue; }
    assert.doesNotMatch(nt.text + nt.hint, lang === 'en' ? /Form a host/ : /軍勢を編成する/, `#${i} ${c.state}: while waiting the pill never names the dead step: ${nt.text}`);
    if (c.state !== 'waiting') continue;
    // one time, said on the wall clock: guide = panel = card = wall now + time left (never the chain's own clock)
    const left = c.at - v.now;
    const want = new Set([hhmm(t0 + left, loc), hhmm(t1 + left, loc), hhmm(t0 + left - 30, loc), hhmm(t1 + left + 30, loc)]);
    const said = [...timesIn(o.text), ...timesIn(panel), ...timesIn(card)];
    assert.equal(said.length, 3, `#${i}: a time on each of guide / panel / card: ${o.text} | ${panel} | ${card}`);
    assert.equal(new Set(said).size, 1, `#${i}: one time on all three: ${said}`);
    assert.ok(want.has(said[0]), `#${i}: ${said[0]} is the wall clock (${[...want]})`);
    if (hhmm(c.at, loc) !== said[0]) timed++;
    // the pill's tooltip carries the same sentence (verify-pr268 V-2: it is redrawn when only the time changes)
    assert.ok(timesIn(nt.hint).every(x => x === said[0]), `#${i}: ${nt.hint}`);
  }
  assert.ok(timed > 100 && due > 30, `exercised: ${timed} timed, ${due} due`);
});

test('P2b a ×60 world and an unknown pace: the three agree on the words, none prints a chain-clock time', async () => {
  const { provisionalNote } = await import('../../permutation-server/web/frontier/screens/holding.mjs');
  const r = rng(2682);
  let checked = 0;
  for (const pace of [60, null]) {
    ST.setTermsPace(() => pace);
    for (let i = 0; i < 200; i++) {
      const v = randomVillage(r);
      const c = PV.villageConfirm(v.FS);
      if (c?.state !== 'waiting') continue;
      const t0 = Date.now() / 1000;
      const texts = [conquestObjective(v.FS).text, plain(WP.timerLine(v.FS, WP.waitModel(v.FS).timers.find(x => x.id === 'village'))), plain(provisionalNote(v.FS, v.home))];
      const t1 = Date.now() / 1000, real = (c.at - v.now) / (pace ?? 1);
      // (×60: the time said is the wall's — now + the real wait —, never the chain's own clock; checked positively, as a
      //  chain-clock hh:mm may equal the wall's by chance)
      const wall = new Set([hhmm(t0 + real, 'ja-JP'), hhmm(t1 + real, 'ja-JP'), hhmm(t0 + real - 30, 'ja-JP'), hhmm(t1 + real + 30, 'ja-JP')]);
      if (pace) for (const s of texts) for (const x of timesIn(s)) assert.ok(wall.has(x), `pace ${pace}: ${x} is the wall clock (${[...wall]}): ${s}`);
      if (pace === null) for (const s of texts) assert.deepEqual(timesIn(s), [], `unknown pace: no clock time at all: ${s}`);
      const all = texts.flatMap(timesIn);
      assert.ok(new Set(all).size <= 1, `pace ${pace}: one time if any: ${all}`);
      checked++;
    }
  }
  assert.ok(checked > 100, `${checked} waiting villages`);
});

// ------------------------------------------------------------------ C1 campChoice
// (site states as the rule counts them: 1 a holding, 5 a v2 Free City — 12 of them and the camp sits every battle out)
const mirror12 = full => Array.from({ length: 12 }, (_, i) => ({ state: full ? (i % 3 ? 1 : 5) : i < 3 ? 1 : 0, faction: 1, gen: 0, garrison: 0 }));
function campWorld(r, { home }) {
  const provinces = new Map();
  const camps = [];
  for (let k = pick(r, 9); k > 0; k--) {
    const p = home.p + pick(r, 11) - 5, q = home.q + pick(r, 11) - 5;
    if (provinces.has(`${p},${q}`)) continue;
    const full = r() < 0.15;
    const c = { p, q, tile: pick(r, 61), troops: oneOf(r, [0, 40, 120, 156, 249, 271, 600, 2000]), state: r() < 0.9 ? 1 : 2 };
    provinces.set(`${p},${q}`, { province: { p, q, resolvedNext: 10, entries: [], ticketCohorts: [], siteCount: 12, sites: Array.from({ length: 12 }, (_, i) => 20 + i), siteMirror: mirror12(full),
      holdingCount: full ? 12 : 3, camp: { state: c.state, tile: c.tile, troops: c.troops, gen: 0 } } });
    camps.push(c);
  }
  return { provinces, camps };
}
const oneOf = (r, a) => a[pick(r, a.length)];

test('C1 campChoice over 3,000 random worlds: never unseen / sitting out / out of bounds / unroutable; nearest winnable reachable first; null exactly when none is left', () => {
  const r = rng(273);
  const stats = { picks: 0, nulls: 0, throws: 0, good: 0, passedFalse: 0, sitOut: 0 };
  for (let i = 0; i < 3000; i++) {
    const home = r() < 0.5 ? { p: -65, q: -63 } : { p: pick(r, 7) - 3, q: pick(r, 7) - 3 };
    const host = { id: 1n, unit: oneOf(r, [0, 0, 0, 1, SCOUT]), troops: oneOf(r, [50, 150, 300, 500, 3000]), ...home, tile: pick(r, 61) };
    const { provinces } = campWorld(r, { home });
    const FS = { provinces, holdings: [], nowBell: 10 };
    const hidden = new Set([...provinces.keys()].filter(() => r() < 0.3));
    const seen = (p, q) => !hidden.has(`${p},${q}`);
    const answers = new Map();
    const reach = camp => {
      const k = `${camp.p},${camp.q}`;
      if (!answers.has(k)) answers.set(k, oneOf(r, [true, true, false, false, null, 'throw']));
      const a = answers.get(k);
      if (a === 'throw') { stats.throws++; throw new Error('planner'); }
      return a;
    };
    const rough = (p, q, t) => (p + q + t) % 2 === 0;
    const c = FB.campChoice(FS, host, { seen, rough, reach });
    if (host.unit === SCOUT) { assert.equal(c, null, 'a scout fights no camp'); continue; }
    const fighting = FB.fightingCampsInSight(FS, host, { seen });
    stats.sitOut += [...provinces.values()].some(e => e.province.camp.state === 1 && !FB.campFights(e.province));
    for (const x of fighting) assert.ok(seen(x.p, x.q) && FB.campFights(provinces.get(`${x.p},${x.q}`).province), `#${i}: fightingCampsInSight is the fog's and the rule's`);
    const left = x => FB.campInBounds(host, x) && answers.get(`${x.p},${x.q}`) !== false;
    const odds = x => campArrival({ unit: host.unit, troops: host.troops, campTroops: x.troops, rough: rough(x.p, x.q, x.tile) }).odds;
    if (!c) {
      stats.nulls++;
      for (const x of fighting) assert.ok(!FB.campInBounds(host, x) || answers.get(`${x.p},${x.q}`) === false, `#${i}: ${x.p},${x.q} in bounds and not refused, yet no pick`);
      continue;
    }
    stats.picks++;
    const pr = provinces.get(`${c.camp.p},${c.camp.q}`).province;
    assert.ok(seen(c.camp.p, c.camp.q), `#${i}: never a camp under the fog`);
    assert.equal(pr.camp.state, 1, `#${i}: a standing camp`);
    assert.ok(FB.campFights(pr), `#${i}: never a camp that sits the battle out`);
    assert.ok(FB.campInBounds(host, c.camp), `#${i}: never outside the planner's bounds`);
    assert.ok(withinRules(host, c.camp), `#${i}: never a camp beyond what any march can reach (${hexDist(host, c.camp)} provinces, ${tileDist(host, c.camp)} steps)`);
    assert.notEqual(answers.get(`${c.camp.p},${c.camp.q}`), false, `#${i}: never a camp whose route question said "no path"`);
    // the preference: a winnable camp nearer than the pick was passed only for its route; with an unwinnable pick, every
    // winnable camp in sight was out of reach
    const d = hexDist(c.camp, home);
    for (const x of fighting.filter(x => odds(x) === 'good')) {
      if (c.winnable && !(x.d < d)) continue;
      assert.ok(!left(x), `#${i}: the winnable camp ${x.p},${x.q} (d ${x.d}) was passed by for ${c.camp.p},${c.camp.q} (d ${d}, winnable ${c.winnable})`);
      stats.passedFalse++;
    }
    stats.good += c.winnable;
  }
  assert.ok(stats.picks > 600 && stats.nulls > 300 && stats.throws > 50 && stats.good > 200 && stats.passedFalse > 50 && stats.sitOut > 500, JSON.stringify(stats));
});

// ------------------------------------------------------------------ C2 the rim village guide
const RIM = { p: -65, q: -63 };
const HID = hostId({ p: RIM.p, q: RIM.q, site: 2, gen: 0, seq: 1 });
const RHOME = { ...RIM, site: 2, gen: 0, tile: 20, faction: 0, state: 2, order: 1, tier: 0, flags: 0, production: baseProduction(0), upkeep: Array(8).fill(0n), stores: [], reserve: Array(8).fill(0), queue: [],
  transit: [{ state: 0 }], explore: { state: 0 }, lastOwnerAction: 1000n, finalTs: 1n, shieldUntil: 0n };
const RENTRY = { id: HID, unit: 0, state: 1, tile: 20, troops: 9_000_000, staminaValue: 120, staminaBell: 10, readyBell: 10, pendOp: 0, fromBell: 10, faction: 0 };
const mirror = () => Array.from({ length: 12 }, () => ({ state: 0, faction: 0, gen: 0, garrison: 0 }));
const rprov = (p, q, c, entries = []) => ({ province: { p, q, resolvedNext: 10, entries, ticketCohorts: [], siteCount: 12, sites: Array.from({ length: 12 }, (_, i) => 20 + i), siteMirror: mirror(),
  camp: c ? { state: 1, tile: c.tile, troops: c.troops, gen: 0 } : null } });
function locate(h) {
  for (let p = RIM.p - 6; p <= RIM.p + 6; p++) for (let q = RIM.q - 6; q <= RIM.q + 6; q++) for (let t = 0; t < 61; t++) {
    const x = tileHex(p, q, t);
    if (x && x.q === h.q && x.r === h.r) return { p, q, t };
  }
  return null;
}

test('C2 the rim village (ring 128): the practice battle exactly when no fighting camp in sight is reachable; else the named camp is, and the press opens it (600 worlds)', () => {
  assert.equal(ringOf(RIM.p, RIM.q), 128);
  const r = rng(2731);
  let practice = 0, named = 0, none = 0;
  for (let i = 0; i < 600; i++) {
    setLang(i % 2 ? 'en' : 'ja');
    const camps = [];
    const provinces = new Map([[`${RIM.p},${RIM.q}`, rprov(RIM.p, RIM.q, null, [RENTRY])]]);
    for (let k = pick(r, 5); k > 0; k--) {
      const p = RIM.p + pick(r, 9) - 4, q = RIM.q + pick(r, 9) - 4;
      if (camps.some(c => c.p === p && c.q === q)) continue;
      const c = { p, q, tile: pick(r, 61), troops: oneOf(r, [41, 123, 156, 271]) + 1000 * (camps.length + 1) };  // (each camp's own number: what the text names)
      camps.push(c);
      provinces.set(`${p},${q}`, rprov(p, q, c, p === RIM.p && q === RIM.q ? [RENTRY] : []));
    }
    // the planner: a route exactly to the camps marked open (any other destination: none); in time
    const open = new Set(camps.filter(() => r() < 0.5).map(c => `${c.p},${c.q},${c.tile}`));
    const kernel = { call: (name, a) => {
      if (name === 'plan_path') {
        const d = locate(a.dest);
        return d && open.has(`${d.p},${d.q},${d.t}`) ? { ok: true, value: { dirs: [0, 0], pathLen: 2, path: new Uint8Array(8), secs: 1200, hexes: 2, provinces: [{ ...RIM }] } } : { ok: false, reason: 'no route' };
      }
      if (name === 'earliest_arrival_bell') return { ok: true, value: 14 };
      return { ok: false };
    } };
    const FS = { mode: 'play', season: SEASON, clock: CLOCK, citizen: { faction: 0, arrivals: 0 }, holdings: [RHOME], nowBell: 10, chain: { now: () => GEN + 10 * 600 + 100 }, land: { stage: 'final' }, inFlight: 0,
      provinces, conquest: { status: 'ready', keeps: new Map(), events: [] }, marches: [], orders: [], ui: { dismissed: [] }, terrainOf: () => null, kernel, record: { rings: [] } };
    const host = { id: HID, unit: 0, troops: 300, ...RIM, tile: 20 };
    const reachable = camps.filter(c => FB.campInBounds(host, c) && open.has(`${c.p},${c.q},${c.tile}`));
    const o = conquestObjective(FS);
    const target = guideTarget(FS);
    const digits = o.text.replace(/[,\s]/g, '');
    const namedTroops = camps.filter(c => new RegExp(`(?<!\\d)${c.troops}(?!\\d)`).test(digits));
    for (const c of namedTroops) assert.ok(reachable.includes(c), `#${i}: an unreachable camp is never named (${c.p},${c.q} ${c.troops}): ${o.text}`);
    if (!camps.length) { none++; assert.deepEqual(o.go.data?.pop, 'march', `#${i}: no camp in sight → look on the map`); continue; }
    if (!reachable.length) {
      practice++;
      assert.equal(o.go.act, 'practice-open', `#${i}: camps in sight, none reachable → the practice battle (${JSON.stringify(camps)})`);
      assert.equal(target, null, `#${i}: the press opens no march card`);
      assert.deepEqual(namedTroops, []);
      continue;
    }
    named++;
    assert.equal(namedTroops.length, 1, `#${i}: one camp named: ${o.text}`);
    if (o.go.act === 'ob-go') {
      assert.equal(target?.kind, 'march');
      assert.ok(reachable.some(c => c.p === target.p && c.q === target.q && c.tile === target.tile), `#${i}: the press opens the card on a reachable camp (${JSON.stringify(target)})`);
    } else assert.deepEqual(o.go.data, { pop: 'train' }, `#${i}: a reachable camp the host cannot beat yet: train first`);
  }
  assert.ok(practice > 100 && named > 100 && none > 20, `exercised: ${practice} practice, ${named} named, ${none} none in sight`);
});

// ------------------------------------------------------------------ C3 / C4 the real rules
const WASM = new URL('../../permutation-server/web/frontier/wasm/frontier.wasm', import.meta.url);
let kernelPromise = null;
async function realKernel(t) {
  if (!existsSync(WASM)) { t.skip('frontier.wasm is not built'); return null; }
  const bytes = readFileSync(WASM);
  const sha = readFileSync(new URL('frontier.wasm.sha256', WASM), 'utf8').trim().split(/\s+/)[0];
  kernelPromise ??= W.loadKernel({ url: 'x/frontier.wasm', sha256Hex: sha, fetch: async () => ({ ok: true, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length) }) });
  return kernelPromise;
}
// a seed for every ring the pairs touch (a ring without a seed has no terrain and no route)
const SEEDS = Array.from({ length: 12 }, (_, d) => ({ ring: d, seed: d.toString(16).padStart(2, '0').repeat(32) }));
/** Random (from, to) tile pairs around the heartland, and the routes the kernel accepts (path_cost re-checks plan_path). */
function acceptedRoutes(k, seed, n, maxD) {
  const r = rng(seed), out = [];
  for (let i = 0; i < n; i++) {
    const from = { p: pick(r, 7) - 3, q: pick(r, 7) - 3, tile: pick(r, 61) };
    const to = { p: from.p + pick(r, 2 * maxD + 1) - maxD, q: from.q + pick(r, 2 * maxD + 1) - maxD, tile: pick(r, 61) };
    if (hexDist(from, to) > maxD) continue;
    const x = planRoute(k, { from, to, unit: 0, seeds: SEEDS, blocked: [] });
    if (!x.ok) continue;
    const c = k.call('path_cost', { start: tileHex(from.p, from.q, from.tile), dirs: x.route.dirs, unit: 0, seeds: SEEDS });
    assert.ok(c.ok && c.value.end.q === tileHex(to.p, to.q, to.tile).q && c.value.end.r === tileHex(to.p, to.q, to.tile).r, 'the program\'s check accepts the route');
    assert.ok(c.value.provinces.length <= 4 && x.route.dirs.length <= MAX_PATH_STEPS);
    out.push({ from, to, provinces: c.value.provinces, steps: x.route.dirs.length });
  }
  return out;
}

test('C3 campInBounds vs the real rules: every route the kernel accepts within 3 provinces is in bounds (the step half is sound)', async t => {
  const k = await realKernel(t);
  if (!k) return;
  const routes = acceptedRoutes(k, 2732, 500, 3);
  assert.ok(routes.length > 200, `${routes.length} accepted routes`);
  for (const x of routes) assert.equal(FB.campInBounds(x.from, x.to), true, `a route of ${x.steps} steps over ${JSON.stringify(x.provinces)} from ${JSON.stringify(x.from)} to ${JSON.stringify(x.to)}`);
  // the facts the bound rests on, in the rules' text: ≤ 32 steps, ≤ 4 provinces ENTERED by the steps
  const tr = src('permutation-rules/src/frontier/travel.rs');
  assert.ok(tr.includes('pub const MAX_PATH_STEPS: usize = 32;') && tr.includes('pub const MAX_PATH_PROVINCES: usize = 4;'));
  assert.ok(tr.includes('        let p = province_of(s.hex);\n        if !provinces.contains(&p) {\n            if provinces.len() == MAX_PATH_PROVINCES {'), 'the provinces counted are those the steps enter');
  assert.equal(MAX_ROUTE_PROVINCES, 4);
});

test('C4 (todo D-test-gaps-4-1) campInBounds keeps a camp 4 provinces away that the program lets a march reach', { todo: 'D-test-gaps-4-1: hud/firstbattle.mjs campInBounds drops province distance > MAX_ROUTE_PROVINCES - 1 (3), but travel.rs path_cost counts only the provinces the steps ENTER (4 besides the start). Not changed by test-gaps-4: Q-TG4-1' }, async t => {
  const k = await realKernel(t);
  if (!k) return;
  // the case found here: (0,0) tile 59 → (4,-2) tile 47, 27 steps over (1,0) (2,-1) (3,-1) (4,-2), accepted by path_cost
  const from = { p: 0, q: 0, tile: 59 }, to = { p: 4, q: -2, tile: 47 };
  const x = planRoute(k, { from, to, unit: 0, seeds: SEEDS, blocked: [] });
  assert.ok(x.ok, 'the rules route it');
  assert.equal(hexDist(from, to), 4);
  assert.equal(FB.campInBounds(from, to), true, 'a camp the march card routes is not dropped by the bound');
  for (const y of acceptedRoutes(k, 2733, 400, 4)) assert.equal(FB.campInBounds(y.from, y.to), true, JSON.stringify(y));
});
