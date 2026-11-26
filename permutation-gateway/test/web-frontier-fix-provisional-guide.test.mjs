// fix-provisional-guide (reports/loop-play23.md BREAK-1; owner defaults Q-LP23-1 a + Q-LP23-2 a): page only, no rule,
// program or keeper change. While the first village is provisional the march-first guide's step 「軍勢を編成する」 pointed
// at a card the program refuses (Muster NotFinal) for up to ≈3 h 45 min on world-3 rules, and the "While you wait" panel
// said 「いま待っているものはありません」 beside 「控えの兵を軍勢にする」. After the "at the latest" time the village stays
// provisional until the player acts (the flip is lazy). The guide and the panel now say when (on the wall clock — fix-loop22
// screens/shell.mjs dueText / dueHtml), that any action after that time confirms it, offer Build meanwhile, and prompt the
// confirming action once the time has passed.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setLang } from '../../permutation-server/web/lang.mjs';
import { baseProduction, ticketTimes, isFinal } from '../../permutation-server/web/frontier/fland.mjs';
import { bellStart } from '../../permutation-server/web/frontier/clock.mjs';
import * as SH from '../../permutation-server/web/frontier/screens/shell.mjs';
import * as ST from '../../permutation-server/web/frontier/seasonterms.mjs';
import * as WP from '../../permutation-server/web/frontier/hud/waitpanel.mjs';
import * as PV from '../../permutation-server/web/frontier/hud/provisional.mjs';
import { conquestObjective, renderConquestGuide } from '../../permutation-server/web/frontier/screens/conquestguide.mjs';
import { guideTarget } from '../../permutation-server/web/frontier/hud/guide.mjs';
import { nextThing } from '../../permutation-server/web/frontier/hud/hud.mjs';

afterEach(() => { setLang('ja'); ST.setTermsPace(() => 1); SH.setChainNow(null); });
const CJK = /[぀-ヿ㐀-鿿]/;
const plain = m => String(m).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
const ROOT = new URL('../../', import.meta.url);
const src = f => readFileSync(new URL(f, ROOT), 'utf8');
const hhmm = (unix, loc = 'ja-JP') => new Date(unix * 1000).toLocaleTimeString(loc, { hour: '2-digit', minute: '2-digit' });

// ------------------------------------------------------------------ fixtures (the pt-first-battle shape, a provisional home)
// The chain clock is far from the wall's (a kept local world: ~116 days behind), so a chain clock printed as a time is caught.
const GEN = 1_000_000;
const CLOCK = { genesisTs: GEN, drand: { genesis: 0, period: 3 }, margin: 60, window: () => 600 };
const TICKET = 7;
const FINAL_TS = bellStart(GEN, TICKET + 3) + 60; // round_time(S) + 600, S ≈ two turns after the filing turn
const HOME = (extra = {}) => ({ p: 2, q: 0, site: 2, gen: 0, tile: 20, faction: 0, state: 1, order: 1, tier: 0, flags: 0, production: baseProduction(0), upkeep: Array(8).fill(0n), stores: [],
  reserve: [100, 0, 0, 0, 0, 0, 0, 0], queue: [], transit: [{ state: 0 }], explore: { state: 0 }, lastOwnerAction: 1000n, finalTs: BigInt(FINAL_TS), ticketBell: TICKET, shieldUntil: 0n, ...extra });
const SEASON = { programVersion: 3, layoutVersion: 2, endBell: 4294967295, bellSecs: 600, minLead: 2, maxLead: 72, conquestParams: { keepBells: 72 } };
const OPEN = [{ bell: TICKET, filed: 2, settled: 1 }], CLOSED = [{ bell: TICKET, filed: 2, settled: 2 }];
const fs = ({ bell = 8, at = 100, cohorts = OPEN, home = {}, province = true, extra = {} } = {}) => ({ mode: 'play', season: SEASON, clock: CLOCK, citizen: { faction: 0, arrivals: 0, flags: 0 }, holdings: [HOME(home)], nowBell: bell,
  chain: { now: () => GEN + bell * 600 + at }, land: { stage: 'provisional' }, inFlight: 0,
  provinces: province ? new Map([['2,0', { province: { p: 2, q: 0, resolvedNext: bell, entries: [], ticketCohorts: cohorts } }]]) : new Map(),
  conquest: { status: 'ready', keeps: new Map(), events: [] }, marches: [], orders: [], ui: { dismissed: [] }, terrainOf: () => null, ...extra });
const nowOf = s => s.chain.now();

// ------------------------------------------------------------------ the rule, pinned to the program's source
test('the provisional rule the page mirrors is the program\'s: state 1, now ≥ final_ts, cohort closed; flipped lazily by the next action', () => {
  const pro = src('frontier-abi/src/prologue.rs');
  assert.ok(pro.includes('pub fn finality_due(h: &HoldingHdr, province: &[u8], now: i64, now_bell: u32) -> bool {\n    h.state == H::STATE_PROVISIONAL\n        && now >= h.final_ts\n        && cohort_closed(province, h.ticket_bell, now_bell)\n}'));
  assert.ok(pro.includes('if now_bell >= ticket_bell.saturating_add(P::COHORT_BELLS) {'));
  assert.ok(src('frontier-abi/src/layout/province.rs').includes('pub const COHORT_BELLS: u32 = 24;'));
  assert.ok(src('permutation-frontier/src/proc/citizen.rs').includes('let final_ts = c.round_time(s_round).checked_add(600).ok_or(OVERFLOW)?;'));
  // the flip runs inside Harvest / Build / Train (proc/holding.rs) and Muster (proc/host.rs, before its NotFinal check)
  const hold = src('permutation-frontier/src/proc/holding.rs');
  assert.ok(hold.includes('pub fn harvest(') && hold.includes('    finality(pl, &hh, holding, citizen, province)?;'));
  const host = src('permutation-frontier/src/proc/host.rs');
  const m = host.indexOf('pub(crate) fn muster_as(');
  assert.ok(m > 0 && host.indexOf('let state = finality(&pl, &hh, holding, citizen, province)?;', m) < host.indexOf('return Err(FrontierError::NotFinal.into());', m));
  // the page's mirror
  const fl = src('permutation-server/web/frontier/fland.mjs');
  assert.ok(fl.includes('return now >= Number(holding.finalTs) && cohortClosed(province, holding.ticketBell, nowBell);'));
  assert.ok(fl.includes('cohortEndsBy: bellStart(genesis, ticketBell + 24),'));
});

// ------------------------------------------------------------------ villageConfirm
test('villageConfirm: waiting (the 24-turn bound while the cohort is open; final_ts once closed), due, past, unknown, final', () => {
  const w = PV.villageConfirm(fs());
  assert.deepEqual(w, { state: 'waiting', at: ticketTimes(CLOCK, TICKET).cohortEndsBy, latest: true });
  assert.equal(w.at, bellStart(GEN, TICKET + 24));
  assert.deepEqual(PV.villageConfirm(fs({ cohorts: CLOSED })), { state: 'waiting', at: FINAL_TS, latest: false });
  // due: the rule holds on the page's records — the page lets Muster be pressed, and that press confirms it
  const due = fs({ bell: 11, cohorts: CLOSED });
  assert.equal(isFinal(due.holdings[0], due.provinces.get('2,0').province, nowOf(due), 11), true);
  assert.deepEqual(PV.villageConfirm(due), { state: 'due', at: null, latest: false });
  assert.equal(PV.villageConfirm(fs({ bell: TICKET + 24, cohorts: OPEN })).state, 'due', '24 turns close the cohort whatever it holds');
  // past: the time has come but the page holds no copy of the Province (it cannot see the rule hold)
  assert.equal(PV.villageConfirm(fs({ bell: TICKET + 25, province: false })).state, 'past');
  assert.equal(PV.villageConfirm(fs({ extra: { chain: null } })).state, 'unknown');
  assert.equal(PV.villageConfirm(fs({ home: { state: 2 } })), null, 'a final village');
  assert.equal(PV.villageConfirm({ ...fs(), holdings: [] }), null);
  assert.equal(PV.confirmPending(null), false);
  assert.equal(PV.confirmPending({ state: 'due' }), false);
  assert.equal(PV.confirmPending({ state: 'waiting' }), true);
});

// ------------------------------------------------------------------ the guide
test('BREAK-1 the guide step 「軍勢を編成する」 while provisional: when (wall clock), that an action after it confirms, Build meanwhile — never the Muster card', () => {
  ST.setTermsPace(() => 1);
  const s = fs();
  const o = conquestObjective(s);
  assert.equal(o.id, 'muster');
  assert.equal(o.n, 2, 'guide 2/8, as loop-play23 saw it');
  // (deliberate-break check: the old step pressed into the Muster card, which the program refuses NotFinal)
  assert.notDeepEqual(o.go.data, { pop: 'muster' });
  assert.deepEqual(o.go, { act: 'cg-go', data: { pop: 'build' }, label: '建設をひらく', aside: true });
  assert.equal(o.wait, '村の確定を待つ', 'the pill says the wait, the press is 「待つ間に：建設をひらく」');
  const left = ticketTimes(CLOCK, TICKET).cohortEndsBy - nowOf(s);
  const chainClock = hhmm(ticketTimes(CLOCK, TICKET).cohortEndsBy);
  assert.match(o.text, /^あなたの村は、まだ仮の村です。確定できるのは遅くともあと約 3時間\d+分（\d\d:\d\d ごろ）からです。その時刻を過ぎたら、収穫などの行動をひとつすると確定します。それまでは、建設ができます。$/);
  const wall = o.text.match(/（(\d\d:\d\d) ごろ）/)[1];
  assert.ok([hhmm(Date.now() / 1000 + left), hhmm(Date.now() / 1000 + left + 60)].includes(wall), `${wall} on the wall clock`);
  assert.notEqual(wall, chainClock, 'never the chain clock (fix-loop22 wallOf)');
  // the pill: 「待つ間に：建設をひらく」, its tooltip the whole sentence as text (no markup)
  const nt = nextThing(s, { guide: o, items: [] });
  assert.equal(nt.label, '待つ間に：建設をひらく');
  assert.equal(nt.short, '村の確定を待つ');
  assert.ok(!nt.hint.includes('<'), nt.hint);
  // the map points at the village (the build), not at a muster tile
  assert.equal(guideTarget(s)?.kind, 'build');
  // the card: no button that opens the Muster card
  const card = String(renderConquestGuide(s));
  assert.ok(!card.includes('data-pop="muster"'));
  assert.ok(card.includes('data-pop="build"'));
  // EN
  setLang('en');
  const en = conquestObjective(s);
  assert.match(en.text, /^Your village is still provisional\. It can be confirmed in about 3 h \d+ min \(around \d\d:\d\d\) at the latest\. After that time, any action \(e\.g\. Harvest\) confirms it\. Until then, you can build\.$/);
  assert.equal(en.go.label, 'Open the build list');
  assert.equal(nextThing(s, { guide: en, items: [] }).label, 'Meanwhile: Open the build list');
  assert.ok(!CJK.test(en.text + en.wait), en.text + en.wait);
});

test('BREAK-1 the cohort closed: the time is final_ts, said without "at the latest"', () => {
  ST.setTermsPace(() => 1);
  const o = conquestObjective(fs({ cohorts: CLOSED }));
  assert.match(o.text, /^あなたの村は、まだ仮の村です。確定できるのはあと約 \d+ 分（\d\d:\d\d ごろ）からです。/);
  setLang('en');
  assert.match(conquestObjective(fs({ cohorts: CLOSED })).text, /^Your village is still provisional\. It can be confirmed in about \d+ min \(around \d\d:\d\d\)\. After/);
});

test('BREAK-1 a ×60 test world says the world\'s length and the real one (fix-loop22 dueText), never a chain clock', () => {
  ST.setTermsPace(() => 60);
  const o = conquestObjective(fs());
  assert.match(o.text, /確定できるのは遅くともあと約 3時間\d+分（実時間で約 \d+ 分?.*ごろ）からです。|確定できるのは遅くともあと約 3時間\d+分（実時間で約 [^）]+）からです。/);
  ST.setTermsPace(() => null);
  assert.match(conquestObjective(fs()).text, /確定できるのは遅くともあと約 3時間\d+分からです。/, 'pace not known: the length only');
});

test('Q-LP23-2 a: after the time, the guide prompts the confirming action — Muster itself when the page sees the rule hold, else Harvest', () => {
  const due = conquestObjective(fs({ bell: 11, cohorts: CLOSED }));
  assert.equal(due.id, 'muster');
  assert.deepEqual(due.go.data, { pop: 'muster' }, 'the press confirms the village and forms the host in one (host.rs muster_as)');
  assert.match(due.text, /^あなたの村は、いま確定できます。次の行動（収穫・建設・訓練・軍勢の編成など）をひとつすると確定します。「編成」で控えの兵を軍勢にします。/);
  const past = conquestObjective(fs({ bell: TICKET + 25, province: false }));
  assert.deepEqual(past.go, { act: 'harvest', data: {}, label: '収穫して村を確定する' });
  assert.equal(past.wait, null);
  assert.match(past.text, /^あなたの村は、確定できる時刻を過ぎました。収穫などの行動をひとつすると確定します。そのあとで軍勢を編成できます。$/);
  setLang('en');
  assert.equal(conquestObjective(fs({ bell: TICKET + 25, province: false })).go.label, 'Harvest to confirm your village');
  assert.match(conquestObjective(fs({ bell: 11, cohorts: CLOSED })).text, /^Your village can be confirmed now\. Your next action \(Harvest, Build, Train, Form a host…\) confirms it\./);
});

test('a final village keeps the old muster step; the train step is untouched while provisional (Train works)', () => {
  const o = conquestObjective(fs({ home: { state: 2 } }));
  assert.deepEqual(o.go, { act: 'cg-go', data: { pop: 'muster' }, label: '軍勢を編成する' });
  assert.ok(!o.text.includes('仮の村'));
  const t = conquestObjective(fs({ home: { reserve: Array(8).fill(0) } }));
  assert.equal(t.id, 'train');
  assert.deepEqual(t.go.data, { pop: 'train' });
});

// ------------------------------------------------------------------ the "While you wait" panel
test('BREAK-1 the panel: the confirm time as a timer, no "Form a host" until confirmed, never "nothing to wait for"', () => {
  ST.setTermsPace(() => 1);
  const s = fs();
  const m = WP.waitModel(s);
  const t = m.timers.find(x => x.id === 'village');
  assert.deepEqual(t, { id: 'village', kind: 'villageWait', at: ticketTimes(CLOCK, TICKET).cohortEndsBy, latest: true });
  assert.equal(m.soonest, t, 'shown beside the folded heading');
  // (deliberate-break check: the old panel suggested the muster the program refuses)
  assert.ok(!m.suggestions.some(x => x.id === 'muster'), JSON.stringify(m.suggestions));
  assert.ok(m.suggestions.some(x => x.id === 'build'));
  assert.ok(!m.suggestions.some(x => x.id === 'confirm'));
  const out = String(WP.renderWaitPanel(s, m, { open: true }));
  assert.ok(!out.includes('いま待っているものはありません'));
  assert.ok(out.includes('data-wait-timer="villageWait"'));
  assert.match(plain(WP.timerLine(s, t)), /^あなたの村は仮の村です。確定できるのは遅くとも あと約 3時間\d+分（ \d\d:\d\d ごろ） から。その時刻を過ぎたら、収穫などの行動をひとつすると確定し、軍勢を編成できます。$/);
  assert.ok(String(WP.timerLine(s, t)).includes('<time datetime='));
  assert.ok(!plain(WP.timerLine(s, t)).includes(hhmm(t.at)), 'never the chain clock');
  const folded = String(WP.renderWaitPanel(s, m, { open: false }));
  assert.match(plain(folded), /あと約 3時間\d+分/);
  setLang('en');
  assert.match(plain(WP.timerLine(s, t)), /^Your village is provisional\. It can be confirmed at the latest in about 3 h \d+ min \(around \d\d:\d\d \) \. After that time, any action \(e\.g\. Harvest\) confirms it and you can form a host\.$/);
  assert.ok(!CJK.test(plain(WP.renderWaitPanel(s, m, { open: true }))));
});

test('Q-LP23-2 a: once it can be confirmed the panel says so and offers the Harvest that confirms it; due → Form a host comes back', () => {
  const due = fs({ bell: 11, cohorts: CLOSED });
  const m = WP.waitModel(due);
  assert.deepEqual(m.timers.find(x => x.id === 'village'), { id: 'village', kind: 'villageNow', at: null, latest: false });
  assert.equal(m.suggestions[0].id, 'confirm');
  assert.equal(m.suggestions[0].act, 'harvest');
  assert.ok(m.suggestions.some(x => x.id === 'muster'), 'the page lets Muster be pressed: it confirms too');
  const out = String(WP.renderWaitPanel(due, m, { open: true }));
  assert.ok(out.includes('data-act="harvest"') && out.includes('data-wait-suggest="confirm"'));
  const past = WP.waitModel(fs({ bell: TICKET + 25, province: false }));
  assert.equal(past.timers.find(x => x.id === 'village').kind, 'villageNow');
  assert.equal(past.suggestions[0].id, 'confirm');
  assert.ok(!past.suggestions.some(x => x.id === 'muster'));
  setLang('en');
  assert.equal(plain(WP.timerLine(due, m.timers.find(x => x.id === 'village'))), 'Your village can be confirmed now: your next action (e.g. Harvest) confirms it');
  assert.deepEqual(WP.suggestionText({ id: 'confirm' }), { label: 'Harvest to confirm your village', note: 'The time has passed. A Harvest confirms your village, and then you can form a host.' });
  // a final village: no village timer
  assert.ok(!WP.waitModel(fs({ home: { state: 2 } })).timers.some(x => x.id === 'village'));
});

test('the page wiring: the guide and the panel read hud/provisional.mjs; the harvest press is a page send', () => {
  const web = 'permutation-server/web/frontier/';
  assert.ok(src(`${web}screens/conquestguide.mjs`).includes("const pend = id === 'muster' && !x.forming ? villageConfirm(FS) : null;"));
  assert.ok(src(`${web}hud/waitpanel.mjs`).includes("if (!rows.length && reserve >= 100) { if (!confirmPending(vc)) suggestions.push({ id: 'muster', act: 'cg-go', data: { pop: 'muster' } }); }"));
  assert.ok(src(`${web}app.mjs`).includes("export const SENDS = Object.freeze(new Set(['wide-claim', 'territory-tile', 'harvest',"));
  assert.ok(src(`${web}hud/provisional.mjs`).includes("import { dueText } from '../screens/shell.mjs';"), 'the wall clock of fix-loop22');
});

// ------------------------------------------------------------------ the village card (live pw3 run: two times on one screen)
test('the village card says the rule\'s time once the cohort is closed (it said "3 h 43 min at the latest" beside the panel\'s 16 min), and "now" past it', async () => {
  const { provisionalNote } = await import('../../permutation-server/web/frontier/screens/holding.mjs');
  ST.setTermsPace(() => 1);
  const closed = fs({ cohorts: CLOSED });
  const note = plain(provisionalNote(closed, closed.holdings[0]));
  // (deliberate-break check: the old card gave the 24-turn bound — about 3 h 4x min — here)
  assert.ok(!/3時間/.test(note), note);
  assert.match(note, /^同じターンの申し込みはすべて決まりました。 ?あと約 \d+ 分（ \d\d:\d\d ごろ） ?から確定できます。その時刻を過ぎたら、収穫などの行動をひとつすると確定します。$/);
  const open = fs();
  assert.match(plain(provisionalNote(open, open.holdings[0])), /^同じターンの申し込みがすべて決まると確定します。遅くとも ?あと約 3時間\d+分/, 'cohort open: the bound, as before');
  const due = fs({ bell: 11, cohorts: CLOSED });
  assert.equal(plain(provisionalNote(due, due.holdings[0])), 'いま確定できます。収穫などの行動をひとつすると確定します。');
  setLang('en');
  assert.match(plain(provisionalNote(closed, closed.holdings[0])), /^Every village requested in the same turn is placed\. It can be confirmed in about \d+ min \(around \d\d:\d\d ?\) ?\. After that time, any action \(e\.g\. Harvest\) confirms it\.$/);
  assert.equal(plain(provisionalNote(due, due.holdings[0])), 'It can be confirmed now: any action (e.g. Harvest) confirms it.');
});
