// pt-first-battle (owner r0ze 2026-11-26 15:48, inbox 2026-11-26-1548-r0ze-playtest-answers.md): Q-PT-1 (c) — world 3
// does (b): a battle the newcomer checks in this browser within minutes, the own report at a stated time —, Q-PT-2 "march
// first", Q-PT-3 (a) only visible / own battles (practice when none), Q-PT-13 "While you wait" always shown, collapsible.
// Page only: these tests pin the pure parts and the page's wiring by source.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { setLang } from '../../permutation-server/web/lang.mjs';
import { hostId } from '../../permutation-server/web/frontier/faddr.mjs';
import { baseProduction } from '../../permutation-server/web/frontier/fland.mjs';
import { bellEnd, bellStart } from '../../permutation-server/web/frontier/clock.mjs';
import { keepArrival, campArrival } from '../../permutation-server/web/frontier/hud/rulebook.mjs';
import * as FB from '../../permutation-server/web/frontier/hud/firstbattle.mjs';
import * as WP from '../../permutation-server/web/frontier/hud/waitpanel.mjs';
import * as W from '../../permutation-server/web/frontier/wasm.mjs';
import * as pr from '../../permutation-server/web/frontier/screens/practice.mjs';
import { conquestGuide, conquestObjective, CONQUEST_STEPS } from '../../permutation-server/web/frontier/screens/conquestguide.mjs';
import { guideTarget } from '../../permutation-server/web/frontier/hud/guide.mjs';
import { FLAG } from '../../permutation-server/web/frontier/onboarding.mjs';
import * as fui from '../../permutation-server/web/frontier/fui.mjs';

afterEach(() => setLang('ja'));
const CJK = /[぀-ヿ㐀-鿿]/;
const plain = m => String(m).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
const WEB = new URL('../../permutation-server/web/frontier/', import.meta.url);
const src = f => readFileSync(new URL(f, WEB), 'utf8');

// ------------------------------------------------------------------ fixtures (the conquest-hand shape)
const GEN = 1_000_000;
const CLOCK = { genesisTs: GEN, drand: { genesis: 0, period: 3 }, margin: 60, window: () => 600 };
const HOME = (extra = {}) => ({ p: 2, q: 0, site: 2, gen: 0, tile: 20, faction: 0, state: 2, order: 1, tier: 0, flags: 0, production: baseProduction(0), upkeep: Array(8).fill(0n), stores: [], reserve: Array(8).fill(0), queue: [],
  transit: [{ state: 0 }], explore: { state: 0 }, lastOwnerAction: 1000n, finalTs: 1n, shieldUntil: 0n, ...extra });
const HID = hostId({ p: 2, q: 0, site: 2, gen: 0, seq: 1 });
const entry = (extra = {}) => ({ id: HID, unit: 0, state: 1, tile: 20, troops: 300000, staminaValue: 120, staminaBell: 10, readyBell: 10, pendOp: 0, fromBell: 10, faction: 0, ...extra });
// another nation's host in the same province: never in the viewer's panel
const OTHER = { id: hostId({ p: 2, q: 0, site: 5, gen: 0, seq: 1 }), unit: 0, state: 1, tile: 33, troops: 900000, staminaValue: 3, staminaBell: 10, readyBell: 40, pendOp: 0, fromBell: 10, faction: 3 };
const SEASON = { programVersion: 3, layoutVersion: 2, endBell: 4294967295, bellSecs: 600, minLead: 2, maxLead: 72, conquestParams: { keepBells: 72 } };
const fs = ({ bell = 10, entries = [entry()], camps = [], extra = {} } = {}) => {
  const provinces = new Map([['2,0', { province: { p: 2, q: 0, resolvedNext: bell, entries, ticketCohorts: [], camp: camps.find(c => c.p === 2 && c.q === 0) ?? null } }]]);
  for (const c of camps) if (!(c.p === 2 && c.q === 0)) provinces.set(`${c.p},${c.q}`, { province: { p: c.p, q: c.q, resolvedNext: bell, entries: [], ticketCohorts: [], camp: c } });
  return { mode: 'play', season: SEASON, clock: CLOCK, citizen: { faction: 0, arrivals: 0 }, holdings: [HOME()], nowBell: bell, chain: { now: () => GEN + bell * 600 + 100 }, land: { stage: 'final' }, inFlight: 0,
    provinces, conquest: { status: 'ready', keeps: new Map(), events: [] }, marches: [], orders: [], ui: { dismissed: [] }, terrainOf: () => null, ...extra };
};
const camp = (p, q, troops, tile = 33) => ({ p, q, state: 1, tile, troops, gen: 0 });

// ------------------------------------------------------------------ the times
test('the report of a march arriving on turn b is expected after the turn, the seals\' window, the seed margin and the resolve', () => {
  assert.equal(FB.reportEtaAt(CLOCK, 20), bellEnd(GEN, 20) + 600 + 60 + FB.RESOLVE_SLACK_SECS);
  // sealed this turn: the earliest arrival is the Season's least lead (2) later
  assert.equal(FB.earliestReportAt(CLOCK, 10, SEASON), FB.reportEtaAt(CLOCK, 12));
  assert.equal(FB.earliestReportAt(CLOCK, 10, { minLead: 3 }), FB.reportEtaAt(CLOCK, 13));
  // turn 10, 100 s in: about 2 turns + the rest of this one + ~12 min ≈ 41 min (the design report's 31–41 min)
  const mins = (FB.earliestReportAt(CLOCK, 10, SEASON) - (GEN + 10 * 600 + 100)) / 60;
  assert.ok(mins > 30 && mins < 42, String(mins));
  assert.equal(FB.reportEtaAt(null, 20), null);
  assert.equal(FB.reportEtaAt(CLOCK, -1), null);
});

test('the viewer\'s own report due: its own unresolved marches only, soonest first; resolved ones are out', () => {
  const m = (bell, pipeline) => ({ entry: { arriveBell: bell }, facts: { pipeline }, dest: { p: 3, q: 0, tile: 4 } });
  const s = fs({ extra: { marches: [m(30, 'pending'), m(14, 'revealing'), m(12, 'resolved')] } });
  assert.deepEqual(FB.ownReportDue(s), { arriveBell: 14, at: FB.reportEtaAt(CLOCK, 14), pipeline: 'revealing', dest: { p: 3, q: 0, tile: 4 } });
  assert.equal(FB.ownReportOut(s), true);
  assert.equal(FB.ownReportDue(fs()), null);
});

// ------------------------------------------------------------------ march first: the camp
test('a camp is a keep-kind garrison without walls: the same host fares better against it', () => {
  const k = keepArrival({ unit: 0, troops: 200, keepTroops: 150, rough: false });
  const c = campArrival({ unit: 0, troops: 200, campTroops: 150, rough: false });
  assert.ok(c.worst.hostLeft >= k.worst.hostLeft && c.worst.keepLeft <= k.worst.keepLeft, JSON.stringify({ k, c }));
  assert.ok(c.need <= k.need);
  assert.equal(campArrival({ unit: 6, troops: 500, campTroops: 100 }).odds, 'poor', 'scouts do not fight');
});

test('campChoice: the nearest camp the host beats at the worst roll; only camps the fog lets the viewer see', () => {
  const host = { id: HID, unit: 0, troops: 300, p: 2, q: 0 };
  const s = fs({ camps: [camp(3, 0, 120), camp(2, 1, 380), camp(9, 0, 100)] });
  const c = FB.campChoice(s, host, { rough: () => false });
  assert.deepEqual(c.camp, { p: 3, q: 0, tile: 33, troops: 120 });
  assert.equal(c.winnable, true);
  // the near camp hidden by the fog: the next one in sight
  const seen = (p, q) => !(p === 3 && q === 0);
  const c2 = FB.campChoice(s, host, { seen, rough: () => false });
  assert.notDeepEqual(c2.camp, { p: 3, q: 0, tile: 33, troops: 120 });
  // a weak host: no camp it beats → the nearest, with what it would take
  const weak = FB.campChoice(fs({ camps: [camp(3, 0, 400)] }), { ...host, troops: 100 }, { rough: () => false });
  assert.equal(weak.winnable, false);
  assert.ok(weak.need > 100);
  assert.equal(FB.campChoice(fs(), host), null, 'no camp in sight');
  assert.equal(FB.campChoice(s, { ...host, unit: 6 }), null, 'a scout host is not sent');
});

test('the conquest guide leads march first: train, host, the camp it beats (filled into the march card), then build', () => {
  assert.deepEqual(CONQUEST_STEPS.slice(0, 5), ['village', 'train', 'muster', 'camp', 'build']);
  const s = fs({ camps: [camp(3, 0, 120)] });
  assert.equal(conquestGuide(s).current, 'camp');
  const o = conquestObjective(s);
  assert.equal(o.go.act, 'ob-go');
  assert.match(o.text, /最初の戦いは、.+の蛮族の野営地（守り手 120）にしましょう。いまの軍勢（槍兵 300）なら、運が悪くても勝てる見込みです。封をして出発すると、最初の戦いの報告は早くて.+に出ます。/);
  // the press fills the camp into the march card (app.mjs guideGo's march path)
  assert.deepEqual(guideTarget(s), { step: 'camp', kind: 'march', p: 3, q: 0, tile: 33, host: String(HID) });
  // the turn has just changed and the home province is still settling the last one (×60: every turn): the formed host
  // still counts as ready — the march card holds the seal until the province catches up — so the press does not flip
  const settling = fs({ bell: 12, camps: [camp(3, 0, 120)] });
  settling.provinces.get('2,0').province.resolvedNext = 10;
  assert.equal(conquestObjective(settling).go.act, 'ob-go');
  assert.equal(guideTarget(settling)?.step, 'camp');
  // a camp it would likely lose to: add troops first, said with the number
  const weak = fs({ entries: [entry({ troops: 100000 })], camps: [camp(3, 0, 400)] });
  assert.deepEqual(conquestObjective(weak).go.data, { pop: 'train' });
  assert.match(conquestObjective(weak).text, /勝ち目は(五分|低い)です。槍兵 [0-9,]+ ほどにすると/);
  // a first march out (anywhere): the build step, with when its report is due
  const out = fs({ camps: [camp(3, 0, 120)], extra: { marches: [{ entry: { arriveBell: 13 }, facts: { pipeline: 'pending' }, dest: { p: 3, q: 0, tile: 33 } }] } });
  assert.equal(conquestGuide(out).current, 'build');
  assert.match(conquestObjective(out).text, /^最初の進軍が向かっています。報告は.+に出る見込みです。/);
  setLang('en');
  const en = conquestObjective(s).text;
  assert.doesNotMatch(en, CJK);
  assert.match(en, /^Make your first battle the barbarian camp of .+ \(120 defenders\)\. Your host \(300 Spearmen\) should win even with bad luck\. Seal and depart, and the first battle report comes .+ at the earliest\./);
  assert.doesNotMatch(en, /season/i);
});

// ------------------------------------------------------------------ a battle to check now
test('battleOffer: the viewer\'s own resolved clash, else a visible one, else a practice battle', () => {
  assert.deepEqual(FB.battleOffer({ own: [{ p: 1, q: 2, bell: 30 }], visible: [{ p: 5, q: 5, bell: 31 }] }), { kind: 'real', p: 1, q: 2, bell: 30, mine: true });
  assert.deepEqual(FB.battleOffer({ visible: [{ p: 5, q: 5, bell: 31 }] }), { kind: 'real', p: 5, q: 5, bell: 31, mine: false });
  assert.deepEqual(FB.battleOffer({}), { kind: 'practice' });
  assert.deepEqual(FB.battleOffer({ visible: [{ p: 5, q: 'x', bell: 31 }] }), { kind: 'practice' });
});

test('the page offers only what the fog lets through: app.mjs feeds battleOffer from clashHere and the viewer\'s own reports', () => {
  const app = src('app.mjs');
  const at = app.indexOf('function waitMarkup(');
  const body = app.slice(at, app.indexOf('\n}', at));
  assert.match(body, /reportScreen\.clashesFrom\(shownChronicle\(\) \?\? \[\], 12\)\.filter\(c => clashHere\(c\.p, c\.q, c\.bell\)\)/);
  // (fix-loop26: an own arrival nobody fought — CLASH engagements 0 — is no battle to offer)
  assert.match(body, /battleOffer\(\{ own: myReports\(F\)\.filter\(c => ownEngagements\(F, c\.p, c\.q, c\.bell\) !== 0\), visible \}\)/);
  // a 「一致」 is kept once, and stops the offer
  assert.match(app, /if \(v\?\.result === 'match' && FS\.mode === 'play' && !noFight && !\(FS\.ui\?\.dismissed \?\? \[\]\)\.includes\(FLAG\.verified\)\) \{ setFlag\(FLAG\.verified\);/);
  assert.match(app, /'practice-first': \(\) => \{ const st = practiceScreen\.practiceState\(\{ faction: FS\.citizen\?\.faction, scenario: 'camp' \}\); st\.firstBattle = true;/);
});

// ------------------------------------------------------------------ "While you wait"
test('waitModel: the viewer\'s own timers and suggestions; another nation\'s host in the same province is never in it', () => {
  const s = fs({ bell: 10, entries: [entry(), OTHER], extra: { ownLand: { player: { tiles: 3, upkeepMilliPerHour: 100, unpaid: false } } } });
  const m = WP.waitModel(s, { offer: { kind: 'real', p: 2, q: 0, bell: 9, mine: false } });
  const kinds = m.timers.map(t => t.kind);
  assert.deepEqual(kinds, ['nextReport', 'hostReady', 'upkeep']);
  assert.ok(!JSON.stringify(m, (k, v) => (typeof v === 'bigint' ? String(v) : v)).includes(String(OTHER.id)), 'no other player\'s host');
  assert.deepEqual(m.suggestions.map(x => x.id), ['verify', 'march', 'build']);
  // a march out: its report, and the host's stamina wait (the march card's own rule: +1 a turn up to 74)
  const tired = fs({ bell: 20, entries: [entry({ staminaValue: 46, staminaBell: 20, readyBell: 12 })], extra: { marches: [{ entry: { arriveBell: 22 }, facts: { pipeline: 'pending' }, dest: { p: 3, q: 0, tile: 33 } }] } });
  const t = WP.waitModel(tired, { offer: { kind: 'practice' } });
  assert.deepEqual(t.timers.map(x => x.kind), ['report', 'hostMarch']);
  assert.equal(t.timers[1].turn, 48);
  assert.equal(t.timers[1].at, bellStart(GEN, 48));
  assert.equal(t.soonest.kind, 'report');
  assert.deepEqual(t.suggestions.map(x => x.id), ['practice', 'build']);
  // once a battle was verified (or the practice matched), no offer
  assert.ok(!WP.waitModel({ ...s, ui: { dismissed: [FLAG.verified] } }, { offer: { kind: 'real', p: 2, q: 0, bell: 9 } }).suggestions.some(x => x.id === 'verify'));
  assert.ok(!WP.waitModel({ ...tired, ui: { dismissed: [FLAG.practiceMatch] } }, { offer: { kind: 'practice' } }).suggestions.some(x => x.id === 'practice'));
  // no village: no panel
  assert.equal(WP.waitModel({ ...s, holdings: [] }), null);
  assert.equal(WP.waitModel({ ...s, mode: 'spectate' }), null);
});

test('the panel: always there, folded by a real button (aria-expanded / aria-controls), the soonest time beside it while folded', () => {
  const s = fs({ extra: { marches: [{ entry: { arriveBell: 13 }, facts: { pipeline: 'pending' }, dest: { p: 3, q: 0, tile: 33 } }] } });
  const m = WP.waitModel(s, { offer: { kind: 'practice' } });
  const open = String(WP.renderWaitPanel(s, m));
  assert.match(open, /<section class="waitp" aria-labelledby="waitp-h" data-wait-panel="open"><h2 class="waitp-h" id="waitp-h"><button type="button" class="waitp-tab" data-act="wait-toggle" aria-expanded="true" aria-controls="waitp-body">/);
  assert.match(open, /<div class="waitp-body" id="waitp-body" ?>/);
  assert.match(open, /data-wait-timer="report"/);
  assert.match(open, /data-act="practice-first"[^>]*data-wait-suggest="practice"/);
  assert.doesNotMatch(open, /aria-live|role="status"/, 'not a live region: polls do not interrupt a screen reader');
  const closed = String(WP.renderWaitPanel({ ...s, ui: { dismissed: [], waitPanel: 'closed' } }, m));
  assert.match(closed, /aria-expanded="false"/);
  assert.match(closed, /<div class="waitp-body" id="waitp-body" hidden>/, 'folded: hidden, still the element aria-controls names');
  assert.match(closed, /class="waitp-soon"/);
  assert.equal(String(WP.renderWaitPanel(s, null)), '');
  setLang('en');
  const en = plain(WP.renderWaitPanel(s, m));
  assert.doesNotMatch(en, CJK);
  assert.doesNotMatch(en, /season/i);
  assert.match(en, /While you wait/);
  assert.match(en, /Your battle report \(arrival on turn 13\):/);
  assert.match(en, /Try (&quot;|")Recompute(&quot;|") on a practice battle/);
  assert.match(en, /Built from your own records only\. Times are estimates\./);
  // the fold is a stored preference
  assert.equal(fui.DEFAULTS.waitPanel, 'open');
  assert.equal(WP.waitOpen({ ui: { waitPanel: 'closed' } }), false);
  assert.equal(WP.waitOpen({ ui: {} }), true);
});

test('the rail and the phone sheet carry the panel; the toggle keeps focus on its button', () => {
  const app = src('app.mjs');
  assert.match(app, /hud\.renderRail\(FS, \{ todoOpen: !!FS\.todoOpen, wait: waitMarkup\(FS\) \}\)/);
  assert.match(app, /hud\.renderRest\(FS, \{ next: holdsLand\(FS\) \? hud\.renderNextRow\(nextNow\(\)\) : '', todoMax: 8, wait: waitMarkup\(FS\) \}\)/);
  assert.match(app, /'wait-toggle': \(\) => \{[^\n]*saveUiOver\(sc, \{ waitPanel: v \}\)[^\n]*waitRefocus = true;/);
  // (every redraw of the rail keeps a keyboard user's focus on the same control of the panel: its times change as turns pass)
  assert.match(app, /const focusSel = waitFocusSel\(\) \?\? \(waitRefocus \? '\.waitp-tab' : null\);/);
  assert.match(app, /waitRefocusTo\(focusSel\);/);
});

// ------------------------------------------------------------------ the practice battle's recompute
const WASM = new URL('../../permutation-server/web/frontier/wasm/frontier.wasm', import.meta.url);
let kernelPromise = null;
async function realKernel(t) {
  if (!existsSync(WASM)) { t.skip('frontier.wasm is not built'); return null; }
  const bytes = readFileSync(WASM);
  const sha = readFileSync(new URL('frontier.wasm.sha256', WASM), 'utf8').trim().split(/\s+/)[0];
  kernelPromise ??= W.loadKernel({ url: 'x/frontier.wasm', sha256Hex: sha, fetch: async () => ({ ok: true, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length) }) });
  return kernelPromise;
}

test('the practice battle: recomputed in this browser it matches its own record, and it always says it is not a chain record', async t => {
  const k = await realKernel(t);
  if (!k) return;
  const st = pr.practiceState({ faction: 0, scenario: 'camp' });
  st.firstBattle = true;
  st.result = pr.runScenario(k, st, pr.practiceSeed(new Uint8Array(32).fill(7)));
  assert.equal(st.result.ok, true);
  st.recheck = pr.recheckPractice(k, st.result);
  assert.equal(st.recheck.result, 'match');
  assert.equal(st.recheck.digest, st.result.digest);
  // a record whose digest was changed: the recompute says so
  assert.equal(pr.recheckPractice(k, { ...st.result, digest: '00'.repeat(32) }).result, 'mismatch');
  assert.equal(pr.recheckPractice(k, null).result, 'unchecked');
  const ja = String(pr.render(st, { closable: true }));
  assert.match(ja, /data-first-battle="1"/);
  assert.match(ja, /data-act="practice-recheck"/);
  assert.match(ja, /data-practice-recheck="match"><span class="rep-match">一致（練習）<\/span>/);
  assert.match(plain(ja), /練習の戦いです。チェーンの記録ではありません。/);
  setLang('en');
  const en = plain(pr.render(st, { closable: true }));
  assert.doesNotMatch(en, CJK);
  assert.match(en, /Match \(practice\)/);
  assert.match(en, /This is a practice battle, not a chain record\./);
});
