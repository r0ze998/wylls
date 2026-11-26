// fix-loop22 (reports/loop-play22.md, verdict lines 3–5): page only, no rule or program change.
//   LP22-3  "While you wait" / guide times on the viewer's WALL clock (never the chain's: a kept 1× local world's Clock is
//           ~116 days behind; a ×60 world's runs 60× as fast), "any moment now" once past, and a forming host's
//           timer at its muster turn's resolution (kept 1×: said 9 min, it stood after 20.5).
//   LP22-4  the keep list, the march card and the forecast read the same sources and the chain's own stamina count; the
//           viewer's own clash outlives its march row (notification list, "Other → Recent clashes", the guide).
//   LP22-5  the devnet goals card: the goal line names no Free City while one cannot be taken (tests in
//           web-frontier-world-goals-devnet.test.mjs).
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setLang } from '../../permutation-server/web/lang.mjs';
import { hostId } from '../../permutation-server/web/frontier/faddr.mjs';
import { baseProduction } from '../../permutation-server/web/frontier/fland.mjs';
import { bellStart, bellAt } from '../../permutation-server/web/frontier/clock.mjs';
import * as SH from '../../permutation-server/web/frontier/screens/shell.mjs';
import * as ST from '../../permutation-server/web/frontier/seasonterms.mjs';
import * as FB from '../../permutation-server/web/frontier/hud/firstbattle.mjs';
import * as WP from '../../permutation-server/web/frontier/hud/waitpanel.mjs';
import * as FC from '../../permutation-server/web/frontier/hud/forecast.mjs';
import * as MC from '../../permutation-server/web/frontier/hud/marchcard.mjs';
import * as KH from '../../permutation-server/web/frontier/hud/keephand.mjs';
import * as FD from '../../permutation-server/web/frontier/hud/feed.mjs';
import { keepArrival } from '../../permutation-server/web/frontier/hud/rulebook.mjs';
import { arrivalStamina, DEPART_STAMINA, ENGAGE_STAMINA } from '../../permutation-server/web/frontier/fmarch.mjs';
import { conquestFacts } from '../../permutation-server/web/frontier/screens/conquestguide.mjs';

afterEach(() => { setLang('ja'); ST.setTermsPace(() => 1); SH.setChainNow(null); });
const plain = m => String(m).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
const WEB = new URL('../../permutation-server/web/frontier/', import.meta.url);
const src = f => readFileSync(new URL(f, WEB), 'utf8');
const hhmm = unix => new Date(unix * 1000).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
const hhmmEn = unix => new Date(unix * 1000).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

// ------------------------------------------------------------------ LP22-3: wall clock, never the chain's
// the kept 1× world of loop-play22: chain clock 116 days and 9 h 22 min behind the wall
const LAG = 116 * 86400 + 9 * 3600 + 22 * 60;
const WALL = Date.UTC(2026, 10, 26, 10, 44, 0); // 19:44 JST
const CHAIN = WALL / 1000 - LAG;

test('LP22-3 wallOf: a chain time is placed on the viewer\'s wall clock at the world\'s pace — never as the chain\'s own clock', () => {
  ST.setTermsPace(() => 1);
  assert.equal(SH.wallOf(CHAIN + 540, CHAIN, WALL), WALL / 1000 + 540, 'kept 1×: 9 min from now on the wall');
  ST.setTermsPace(() => 60);
  assert.equal(SH.wallOf(CHAIN + 3960, CHAIN, WALL), WALL / 1000 + 66, '×60: 66 game minutes are 66 real seconds');
  ST.setTermsPace(() => null);
  assert.equal(SH.wallOf(CHAIN + 600, CHAIN, WALL), null, 'a fast clock whose pace is not known: no clock time (LP8-10)');
  ST.setTermsPace(() => 1);
  assert.equal(SH.wallOf(CHAIN + 600, null, WALL), null, 'no chain "now": no clock time');
  SH.setChainNow(() => CHAIN);
  assert.equal(SH.wallOf(CHAIN + 600, null, WALL), WALL / 1000 + 600, 'the page\'s "now" (app.mjs setChainNow)');
});

test('LP22-3 dueText / dueHtml: kept 1× says the wall time; ×60 the real length (and the wall time from a minute); past → "any moment now"', () => {
  ST.setTermsPace(() => 1);
  const t = CHAIN + 540;
  const wantWall = hhmm(Date.now() / 1000 + 540), chainClock = hhmm(t);
  const s = SH.dueText(t, CHAIN);
  // (deliberate-break check: the chain's own clock differs from the wall's by 9 h 22 min — the old code printed it)
  assert.notEqual(wantWall, chainClock);
  assert.ok(s === `あと約 9 分（${wantWall} ごろ）` || s === `あと約 9 分（${hhmm(Date.now() / 1000 + 541)} ごろ）`, s);
  assert.ok(!s.includes(chainClock), `never the chain clock ${chainClock}: ${s}`);
  assert.ok(!plain(SH.dueHtml(t, CHAIN)).includes(chainClock));
  assert.match(plain(SH.dueHtml(t, CHAIN)), /^あと約 9 分（ \d\d:\d\d ごろ）$/);
  // a measured pace that wanders around 1 is still the natural clock (no "real time" beside it)
  ST.setTermsPace(() => 1.04);
  assert.match(SH.dueText(t, CHAIN), /^あと約 9 分（\d\d:\d\d ごろ）$/);
  // ×60: the world's length with its real length; the wall clock only from a real minute on
  ST.setTermsPace(() => 60);
  assert.equal(SH.dueText(CHAIN + 300, CHAIN), 'あと約 5 分（実時間で約 5 秒）');
  assert.match(SH.dueText(CHAIN + 3960, CHAIN), /^あと約 1時間6分（実時間で約 66 秒・\d\d:\d\d ごろ）$/);
  // past: the old code printed the chain clock as a wall time ("around 19:53" at 19:37)
  for (const r of [1, 60]) { ST.setTermsPace(() => r); assert.equal(SH.dueText(CHAIN - 5, CHAIN), 'まもなく'); assert.equal(plain(SH.dueHtml(CHAIN - 5, CHAIN)), 'まもなく'); }
  ST.setTermsPace(() => 1);
  assert.equal(SH.dueText(CHAIN + 60), '時刻はまだ分かりません', 'no "now" anywhere: said, never a chain clock');
  setLang('en');
  assert.match(SH.dueText(t, CHAIN), /^in about 9 min \(around \d\d:\d\d\)$/);
  assert.ok(!SH.dueText(t, CHAIN).includes(hhmmEn(t)));
  assert.equal(SH.dueText(CHAIN - 5, CHAIN), 'Any moment now');
  ST.setTermsPace(() => 60);
  assert.match(SH.dueText(CHAIN + 3960, CHAIN), /^in about 1 h 6 min \(about 66 seconds? in real time, around \d\d:\d\d\)$/);
  assert.equal(SH.dueText(CHAIN + 60), 'time not known yet');
});

test('LP22-3 the page wires the chain\'s "now" into the wall clock; the ticket line and the turn sheet use it', () => {
  assert.ok(src('app.mjs').includes('setChainNow(() => FS.chain?.now?.());'));
  assert.ok(src('screens/onboarding.mjs').includes("const at = w.kind === 'ticket' && w.at ? timeHtml(w.at) : null;"));
  assert.ok(src('screens/bell.mjs').includes('timeHtml(r.until, now) ? Lh`次の段階まで'));
  // timeHtml is the wall time of a chain time (null when it cannot be placed), never `new Date(chainTime)`
  ST.setTermsPace(() => 1);
  assert.equal(SH.timeHtml(CHAIN + 600), null);
  SH.setChainNow(() => CHAIN);
  assert.ok(!plain(SH.timeHtml(CHAIN + 600)).includes(hhmm(CHAIN + 600)));
});

// ------------------------------------------------------------------ LP22-3 / LP22-8: the forming host's timer
const GEN = 1_000_000;
const CLOCK = { genesisTs: GEN, drand: { genesis: 0, period: 3 }, margin: 60, window: () => 300 };
const HOME = (extra = {}) => ({ p: 2, q: 0, site: 2, gen: 0, tile: 20, faction: 0, state: 2, order: 1, tier: 0, flags: 0, production: baseProduction(0), upkeep: Array(8).fill(0n), stores: [], reserve: Array(8).fill(0), queue: [],
  transit: [{ state: 0 }], explore: { state: 0 }, lastOwnerAction: 1000n, finalTs: 1n, shieldUntil: 0n, ...extra });
const HID = hostId({ p: 2, q: 0, site: 2, gen: 0, seq: 1 });
const entry = (extra = {}) => ({ id: HID, unit: 0, state: 1, tile: 20, troops: 300000, staminaValue: 120, staminaBell: 10, readyBell: 10, pendOp: 0, fromBell: 10, faction: 0, ...extra });
const SEASON = { programVersion: 3, layoutVersion: 2, endBell: 4294967295, bellSecs: 600, minLead: 2, maxLead: 72, conquestParams: { keepBells: 72 } };
const fs = ({ bell = 10, at = 100, entries = [entry()], extra = {} } = {}) => ({ mode: 'play', season: SEASON, clock: CLOCK, citizen: { faction: 0, arrivals: 0 }, holdings: [HOME()], nowBell: bell,
  chain: { now: () => GEN + bell * 600 + at }, land: { stage: 'final' }, inFlight: 0,
  provinces: new Map([['2,0', { province: { p: 2, q: 0, resolvedNext: bell, entries, ticketCohorts: [] } }]]),
  conquest: { status: 'ready', keeps: new Map(), events: [] }, marches: [], orders: [], ui: { dismissed: [] }, terrainOf: () => null, ...extra });

test('LP22-8 a host formed on turn 0 stands when turn 0 is resolved (turn 2, ~20 min at 1×), not at turn 1\'s start (9 min)', () => {
  // the kept 1× world: Form 14 s into turn 0 (fromBell 1 = muster turn 0)
  const s = fs({ bell: 0, at: 14, entries: [entry({ state: 2, fromBell: 1, staminaBell: 0 })] });
  const m = WP.waitModel(s);
  const t = m.timers.find(x => x.kind === 'hostForms');
  assert.ok(t, JSON.stringify(m.timers));
  assert.equal(t.at, FB.reportEtaAt(CLOCK, 0), 'the muster turn\'s resolution: firstbattle.mjs reportEtaAt');
  const mins = (t.at - s.chain.now()) / 60;
  // (deliberate-break check: the old timer was bellStart(1) — 9.8 min away)
  assert.notEqual(t.at, bellStart(GEN, 1));
  assert.ok(mins > 15 && mins < 22, `forming wait ${mins} min (measured 20.5)`);
  assert.equal(t.turn, bellAt(GEN, t.at));
  assert.equal(t.turn, 1, 'with this clock the muster turn is resolved in turn 1 (window 5 min)');
  // on turn 1, while the row still says forming (state 2, fromBell 1 ≤ now): the panel still has the timer (it said "Nothing to wait for")
  const s1 = fs({ bell: 1, at: 30, entries: [entry({ state: 2, fromBell: 1, staminaBell: 0 })] });
  assert.ok(WP.waitModel(s1).timers.some(x => x.kind === 'hostForms'), 'turn 1: still a forming timer');
  assert.ok(src('hud/waitpanel.mjs').includes('const forming = formingAt(FS, w, rows);'));
});

test('LP22-3 a resting / tired host\'s timer: the turn the rules let it depart (+1 stamina a resolved turn), said on the wall clock', () => {
  const s = fs({ bell: 35, entries: [entry({ staminaValue: 62, staminaBell: 35, readyBell: 30 })] });
  const t = WP.waitModel(s).timers.find(x => x.kind === 'hostMarch');
  assert.equal(t.turn, 35 + DEPART_STAMINA - 62);
  assert.equal(t.at, bellStart(GEN, 47));
});

// ------------------------------------------------------------------ LP22-4: the chain's stamina, one source for the keep
test('LP22-4 arrivalStamina is the chain\'s: −74 on the departure turn + 1, refilled on the road (the keep march of loop-play22)', () => {
  // the host had 75 on turn 49, departed in 49 for turn 53 (18 tiles)
  const h = { staminaValue: 75, staminaBell: 49 };
  assert.equal(arrivalStamina(h, 49, 53), 76 - 74 + 3);
  assert.ok(arrivalStamina(h, 49, 53) < ENGAGE_STAMINA, 'it arrived exhausted');
  // (deliberate-break check: the old forecast — stamina at the arrival turn less the planned route's cost)
  assert.notEqual(arrivalStamina(h, 49, 53), 79 - (10 + 2 * 18));
  // a full host: 120 → 46 at the departure turn + 1
  assert.equal(arrivalStamina({ staminaValue: 120, staminaBell: 0 }, 10, 12), 46 + 1);
  const c = { host: { id: '9', unit: 0, troops: 300, ...h }, dest: { p: 1, q: 0, tile: 30 }, arriveBell: 53, departBell: 49, stance: 0, retreat: 'never', ratio: null, route: { dirs: Array(18).fill(0) } };
  assert.equal(FC.forecastInputs(c, 0).arrivals[0].stamina, 5, 'the forecast\'s arrival');
  assert.match(FC.forecastKey(c), /\|d49$/, 'a new turn is a new forecast (the arrival stamina moves with it)');
  assert.ok(src('app.mjs').includes('if (c && Number.isInteger(FS.nowBell)) c.departBell = FS.nowBell;'));
});

test('LP22-4 the hand estimate counts an exhausted arrival as the rules do (×0.85 on the attack)', () => {
  const fresh = keepArrival({ unit: 0, troops: 300, keepTroops: 120, rough: false });
  const tired = keepArrival({ unit: 0, troops: 300, keepTroops: 120, rough: false, tired: true });
  assert.ok(tired.worst.keepLeft > fresh.worst.keepLeft, 'weaker blows');
  assert.ok((tired.need ?? Infinity) >= (fresh.need ?? Infinity));
});

test('LP22-4 the card\'s outlook word is the forecast\'s once it is there (never "Even" beside "holds 8 of 8")', () => {
  assert.equal(MC.forecastOdds(null), null);
  assert.equal(MC.forecastOdds({ ok: false }), null);
  const fc = fates => ({ ok: true, runs: 12, troops: { min: 1, max: 2, start: 3 }, fates });
  assert.equal(MC.forecastOdds(fc({ Stays: 12 })).id, 'strong');
  assert.equal(MC.forecastOdds(fc({ Stays: 10, Retreated: 2 })).id, 'even', 'the list\'s "Even" for the same march (×60 check)');
  assert.equal(MC.forecastOdds(fc({ Stays: 2, Retreated: 10 })).id, 'even');
  assert.equal(MC.forecastOdds(fc({ Bounced: 12 })).id, 'bad');
  assert.ok(src('hud/marchcard.mjs').includes('(def.total ? forecastOdds(forecastNow(c)) : null) ?? oddsWord(c.host.troops, def.total)'));
  assert.ok(src('hud/marchcard.mjs').includes('odds.forecast ? L`ルールで ${fmtNum(odds.runs)} 回試し、${fmtNum(odds.stays)} 回マスに残った目安です` : L`兵数を比べた目安です`'));
  setLang('en');
  assert.equal(MC.forecastOdds(fc({ Bounced: 12 })).text, 'Outmatched');
});

test('LP22-4 the keep list reads the keep the card reads (not the cached reach copy) and leaves hosts on the tile to the forecast', () => {
  const keep = { p: 1, q: 0, tile: 30, holder: 1, troops: 0, heartland: false, contender: 4, progress: 2 };
  const row = { p: 1, q: 0, tile: 30, holder: 1, troops: 50, route: { hexes: 18, provinces: [[1, 0]], secs: 1800 }, origin: null };
  const host = { id: HID, unit: 0, troops: 300, p: 2, q: 0, tile: 20, state: 1, stamina: 120, readyBell: 0 };
  const ember = { id: hostId({ p: 1, q: 0, site: 7, gen: 0, seq: 1 }), unit: 0, state: 1, tile: 30, troops: 289000, faction: 4, staminaValue: 100, staminaBell: 40 };
  const base = fs({ bell: 49 });
  const FS = { ...base, conquest: { ...base.conquest, keeps: new Map([['1,0', keep]]), hostReach: { host: String(HID), ok: true, rows: [row], unreachable: [] } } };
  FS.provinces.set('1,0', { province: { p: 1, q: 0, resolvedNext: 49, entries: [ember], ticketCohorts: [] } });
  const km = KH.keepsModel(FS, host);
  assert.equal(km.rows[0].troops, 0, 'the keep as the page knows it now (the card said "0 recorded defenders", the list 50)');
  assert.equal(km.rows[0].odds.odds, 'hosts', 'Ember\'s 289 on the tile: the hand estimate cannot weigh them');
  assert.match(KH.oddsText(km.rows[0].odds, 0).line, /289/);
  // nobody on the tile, a host that would arrive exhausted: the estimate says so
  FS.provinces.set('1,0', { province: { p: 1, q: 0, resolvedNext: 49, entries: [], ticketCohorts: [] } });
  const tiredHost = { ...host, stamina: 75, entry: { staminaValue: 75, staminaBell: 49 } };
  const o = KH.arrivalOdds(FS, tiredHost, { p: 1, q: 0, tile: 30, troops: 50, arrive: 53 });
  assert.equal(o.tired, true);
  assert.equal(o.stamina, 5);
  assert.match(KH.oddsText(o, 0).line, /疲れて着く（体力 5）/);
  setLang('en');
  assert.match(KH.oddsText(o, 0).line, /^arrives tired \(stamina 5\); (should still hold|rest it first)$/);
  assert.equal(KH.oddsText({ odds: 'hosts', hosts: [{ faction: 4, troops: 289 }] }, 0).word, 'Hosts there');
});

// ------------------------------------------------------------------ LP22-4: the own clash stays told
const snap = (bell, marches) => ({ bell, now: 0, keeps: null, returns: null, territory: new Map(), territoryKnown: new Set(), territorySeen: new Set(), marches: new Map(marches), builds: new Set(), pendingBuilds: new Set(),
  holdings: new Map(), clashes: new Set(), fights: new Map(), still: new Set(), explored: new Map(), incoming: new Set() });
const keepMarch = (pipeline, bell = 55) => ({ pipeline, revealed: true, settle: false, dest: { p: 1, q: 0, tile: 30 }, destName: 'Dunmar side, ring 1', destNames: null, bell, outcome: null });

test('LP22-4 a march whose row left the list as its turn was resolved is still told, once, with its report', () => {
  const prev = snap(56, [['h1', keepMarch('awaitingSeed')]]);
  const next = snap(57, []);
  const items = FD.diffFeed(prev, next);
  const it = items.find(x => x.id === 'rs:h1');
  assert.ok(it, JSON.stringify(items));
  assert.equal(it.kind, 'battle');
  assert.deepEqual(it.battle, { p: 1, q: 0, bell: 55 });
  // (deliberate-break: told once — the same id as the "resolved" line, so pushFeed keeps one)
  assert.equal(FD.pushFeed(FD.pushFeed([], items), items).filter(x => x.id === 'rs:h1').length, 1);
  // not before its arrival turn has ended, and not when it was already told resolved
  assert.ok(!FD.diffFeed(snap(55, [['h1', keepMarch('open')]]), snap(55, [])).some(x => x.id === 'rs:h1'));
  assert.ok(!FD.diffFeed(snap(57, [['h1', keepMarch('resolved')]]), snap(58, [])).some(x => x.id === 'rs:h1'));
});

test('LP22-4 ownClashesFrom keeps the viewer\'s resolved marches after their rows go; the report list, Other and the guide read it', () => {
  let own = FD.ownClashesFrom([], snap(54, [['h1', keepMarch('open')]]), snap(55, [['h1', keepMarch('open')]]));
  assert.deepEqual(own, []);
  own = FD.ownClashesFrom(own, snap(56, [['h1', keepMarch('resolving')]]), snap(57, []));
  assert.deepEqual(own, [{ p: 1, q: 0, tile: 30, bell: 55 }]);
  own = FD.ownClashesFrom(own, snap(57, [['h2', keepMarch('resolved', 60)]]), snap(61, [['h2', keepMarch('resolved', 60)]]));
  assert.deepEqual(own.map(x => x.bell), [60, 55], 'newest first, no duplicates');
  const app = src('app.mjs');
  assert.ok(app.includes('if (feedPrev) FS.ownClashes = feed.ownClashesFrom(FS.ownClashes, feedPrev, snap);'));
  assert.ok(app.includes('for (const c of FS.ownClashes ?? []) add({ p: c.p, q: c.q, bell: c.bell });'), 'myReports');
  assert.ok(app.includes('reportScreen.renderLinks(recentClashes(FS), L`最近の衝突`, { FS }),'), 'Other → Recent clashes');
  assert.ok(src('controller.mjs').includes('FS.ownClashes = [];'), 'cleared with the viewer\'s orders');
});

test('LP22-4 the guide acknowledges the lost keep march after its row is gone (not "hold the keep\'s tile")', () => {
  const keep = { p: 1, q: 0, tile: 30, holder: 1, troops: 0, heartland: false, contender: 4, progress: 30 };
  const base = fs({ bell: 74, entries: [entry({ troops: 227000, staminaValue: 1, staminaBell: 56, readyBell: 57 })] });
  const order = { kind: 'march', state: 'accepted', dest: { p: 1, q: 0, tile: 30 }, arriveBell: 55 };
  const FS = { ...base, conquest: { ...base.conquest, keeps: new Map([['1,0', keep]]) }, orders: [order], ownClashes: [{ p: 1, q: 0, tile: 30, bell: 55 }] };
  const x = conquestFacts(FS);
  assert.deepEqual(x.repelled, { p: 1, q: 0, bell: 55 });
  assert.equal(x.marched, false, 'the march step comes back');
  // (deliberate-break: without the kept clash the order alone still counts as "marched" — the loop-play22 guide)
  assert.equal(conquestFacts({ ...FS, ownClashes: [] }).marched, true);
  // a new march sealed to the same keep is a new try
  assert.equal(conquestFacts({ ...FS, orders: [order, { ...order, arriveBell: 130 }] }).repelled, null);
});

test('fix-loop22 a --wide TEST world\'s order card says its waits on the test clock too (it said "in about 15 min" for 15 s)', async () => {
  const { waitWords } = await import('../../permutation-server/web/frontier/screens/march.mjs');
  assert.equal(waitWords({ localPlay: { wideLand: { scale: 60 } } }, 900), '試験の時計で約 15 秒後');
  assert.equal(waitWords({ localPlay: { clockScale: 30, wideLand: { scale: 60 } } }, 900), '試験の時計で約 30 秒後', 'the demo\'s own word first');
  assert.equal(waitWords({ localPlay: {} }, 900), '約 15 分後');
});

test('fix-loop22 the forecast follows the destination\'s record: made again (old figures kept) when the envelope changes', () => {
  const app = src('app.mjs');
  assert.ok(app.includes("export const envRev = env => (env ? `${env.seq ?? ''}|${env.slot ?? ''}|${env.bell ?? ''}` : null);"));
  assert.ok(app.includes('const stale = !!c.forecast?.ok && c.forecast.key === key && !c.forecast.pending && c.forecast.rev !== undefined && rev !== null && c.forecast.rev !== rev;'));
  assert.ok(app.includes("if (!stale) { c.forecast = { key, pending: true }; invalidate('panel'); }"), 'no "calculating…" flash at a re-read');
  assert.ok(app.includes('...(made !== null ? { rev: made } : {})'));
});
