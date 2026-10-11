// The hand, the panels and the words of a CONQUEST season (program version 3) on the merged submission build
// (2026-10-11): the host's card of reachable keeps, the waits that replace "no host is ready" (the submission
// session's fault 2), the keep's panel with each capture's signature and the caption that a capture is READ from its
// record, "Provinces held" from the standings record, the season-end card that waits for the records, the prize
// panel's words, the battle report's caption and slot, the seven-step guide, and the `?fx=hand-…` samples.
// The fixtures are records of finished runs on the local test chain (hud/handdemo-data.mjs).
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setLang, EN } from '../../permutation-server/web/lang.mjs';
import { hostId } from '../../permutation-server/web/frontier/faddr.mjs';
import { baseProduction } from '../../permutation-server/web/frontier/fland.mjs';
import * as K from '../../permutation-server/web/frontier/hud/keephand.mjs';
import * as P from '../../permutation-server/web/frontier/hud/provstrip.mjs';
import * as D from '../../permutation-server/web/frontier/hud/handdemo.mjs';
import { KEEP_4_M1, STANDINGS_BEFORE, STANDINGS_AFTER, POOL_FINAL, LEDGER, keepAt, recordAt } from '../../permutation-server/web/frontier/hud/handdemo-data.mjs';
import { handModel, renderPop, POPS, CONQUEST_POPS } from '../../permutation-server/web/frontier/hud/hand.mjs';
import { popOf } from '../../permutation-server/web/frontier/hud/subject.mjs';
import { render as marchCard } from '../../permutation-server/web/frontier/hud/marchcard.mjs';
import { keepHistory, renderKeep, renderReach } from '../../permutation-server/web/frontier/screens/conquest.mjs';
import { conquestGuide, conquestObjective, renderConquestGuide, CONQUEST_STEPS } from '../../permutation-server/web/frontier/screens/conquestguide.mjs';
import { objectiveModel } from '../../permutation-server/web/frontier/screens/onboarding.mjs';
import { render as prizePanel } from '../../permutation-server/web/frontier/screens/prize.mjs';
import { render as report } from '../../permutation-server/web/frontier/screens/report.mjs';
import { render as join } from '../../permutation-server/web/frontier/screens/join.mjs';

afterEach(() => setLang('ja'));
const plain = s => String(s).replace(/<[^>]*>/g, ' ').replace(/&#39;/g, '\'').replace(/\s+/g, ' ');
const CJK = /[぀-ヿ㐀-鿿]/;
const WEB = new URL('../../permutation-server/web/frontier/', import.meta.url);

// ------------------------------------------------------------------ fixtures
const HOME = (extra = {}) => ({ p: 2, q: 0, site: 2, gen: 0, tile: 20, faction: 0, state: 2, order: 1, tier: 0, flags: 0, production: baseProduction(0), upkeep: Array(8).fill(0n), stores: [], reserve: Array(8).fill(0), queue: [],
  transit: [{ state: 0 }], explore: { state: 0 }, lastOwnerAction: 1000n, finalTs: 1n, shieldUntil: 0n, ...extra });
const entry = (extra = {}) => ({ id: hostId({ p: 2, q: 0, site: 2, gen: 0, seq: 1 }), unit: 0, state: 1, tile: 20, troops: 500000, staminaValue: 120, staminaBell: 10, readyBell: 10, pendOp: 0, fromBell: 10, ...extra });
const SEASON = { programVersion: 3, layoutVersion: 2, endBell: 96, bellSecs: 600, dormantAfterSecs: 86400, releaseAfterSecs: 172800, minLead: 2, maxLead: 72, conquestParams: { keepBells: 72 } };
const fs = ({ bell = 10, entries = [entry()], resolvedNext = bell, extra = {} } = {}) => ({ mode: 'play', season: SEASON, citizen: { faction: 0 }, holdings: [HOME()], nowBell: bell, chain: { now: () => 1000 }, land: { stage: 'final' }, inFlight: 0,
  provinces: new Map([['2,0', { province: { p: 2, q: 0, resolvedNext, entries, ticketCohorts: [] } }]]),
  conquest: { status: 'ready', keeps: new Map([['4,-1', keepAt(KEEP_4_M1, bell)]]), history: new Map([['4,-1', recordAt(KEEP_4_M1, bell)]]), standings: STANDINGS_BEFORE, final: null, events: [] }, ...extra });
const row = (s, i = 0) => { const pv = s.provinces.get('2,0').province, e = pv.entries[i]; return { ...e, id: String(e.id), troops: e.troops / 1000, stamina: 120, pending: e.pendOp, inTransit: false, p: 2, q: 0, province: pv, holding: s.holdings[0], holdingIndex: 0, home: true }; };
const route = (hexes, provinces, secs) => ({ hexes, provinces: Array.from({ length: provinces }, (_, i) => i), secs });

// ------------------------------------------------------------------ fault 2: the truth of the moment after a Muster
test('a host that cannot depart yet says why and from which turn: forming, the province catching up, resting, stamina', () => {
  assert.equal(K.waitOf(fs(), row(fs())), null, 'a ready host has no wait');
  const forming = fs({ bell: 9, entries: [entry({ state: 2, fromBell: 11 })] });
  assert.deepEqual(K.waitOf(forming, row(forming)), { why: 'forming', turn: 11 });
  // the turn has changed and the province's record is still the last turn's: the host was offered a moment before
  const late = fs({ bell: 12, resolvedNext: 10 });
  assert.deepEqual(K.waitOf(late, row(late)), { why: 'settling', turn: 12, nudge: true });
  const formedLate = fs({ bell: 11, resolvedNext: 10, entries: [entry({ state: 2, fromBell: 11 })] });
  assert.equal(K.waitOf(formedLate, row(formedLate)).why, 'settling', 'the turn it stands from has come: only the province\'s record is behind');
  const resting = fs({ entries: [entry({ readyBell: 14 })] });
  assert.deepEqual(K.waitOf(resting, { ...row(resting), readyBell: 14 }), { why: 'resting', turn: 14 });
  assert.equal(K.hostWaits(forming).length, 1);
  assert.equal(K.hostWaits(fs({ entries: [entry({ unit: 6 })] })).length, 0, 'a Scout host is not a combat host');
  setLang('en');
  assert.match(K.waitText(K.hostWaits(forming)[0]), /^500 Spearmen: forming up\. This host can depart from turn 11\.$/);
  assert.match(K.waitText(K.hostWaits(late)[0]), /can depart from this turn \(turn 12\) as soon as it has caught up/);
});

test('the keep panel and the reach list never end in "no host is ready" while a host is on its way to being ready', () => {
  const forming = fs({ bell: 9, entries: [entry({ state: 2, fromBell: 11 })] });
  const k = forming.conquest.keeps.get('4,-1');
  const panel = plain(renderKeep(forming, k));
  assert.match(panel, /槍兵 500 は編成中です。ターン 11 から出発できます。/);
  assert.doesNotMatch(panel, /出発できる戦闘部隊がいません/);
  assert.match(String(renderKeep(forming, k)), /data-act="tab" data-tab="hosts"/, 'the way to the host: not a dead end');
  const late = fs({ bell: 12, resolvedNext: 10 });
  const latePanel = String(renderKeep(late, late.conquest.keeps.get('4,-1')));
  assert.match(latePanel, /data-act="nudge" data-p="2" data-q="0"/, 'a province that is behind offers the press that brings it up');
  assert.doesNotMatch(plain(latePanel), /出発できる戦闘部隊がいません/);
  // a ready host AND one that was mustered a moment ago: the button, and the other host's turn beside it
  const both = fs({ bell: 9, resolvedNext: 9, entries: [entry({ readyBell: 0, fromBell: 3 }), entry({ id: hostId({ p: 2, q: 0, site: 2, gen: 0, seq: 2 }), state: 2, fromBell: 11, troops: 700000 })] });
  const bothPanel = String(renderKeep(both, both.conquest.keeps.get('4,-1')));
  assert.match(bothPanel, /data-act="cq-march"/);
  assert.match(plain(bothPanel), /槍兵 700 は編成中です。ターン 11 から出発できます。/);
  // nobody at all: the old sentence, and the way to the village
  const none = fs({ entries: [] });
  assert.match(plain(renderKeep(none, none.conquest.keeps.get('4,-1'))), /出発できる戦闘部隊がいません。兵を訓練し、軍勢を編成してください。/);
  // the reach list measured from the village names the waiting host too
  forming.conquest.reach = { key: 'k', ok: true, home: true, rows: [], unreachable: [] };
  assert.match(plain(renderReach(forming)), /槍兵 500 は編成中です。ターン 11 から出発できます。 そのあいだは、村からの道のりで調べています。/);
});

// ------------------------------------------------------------------ the keep's panel from a real record
test('the keep\'s history prints each capture\'s signature with a copy key, counts the contest, and says the capture is read, not recomputed', () => {
  const h = keepHistory(recordAt(KEEP_4_M1, 92));
  assert.equal(h.last.sig, KEEP_4_M1.captures[0].sig);
  assert.deepEqual(h.all.map(r => [r.bell, r.kind]), [[0, 'held'], [12, 'contest'], [83, 'taken'], [84, 'held']]);
  const after = fs({ bell: 92 });
  const out = String(renderKeep(after, after.conquest.keeps.get('4,-1')));
  assert.match(out, new RegExp(`<code title="${KEEP_4_M1.captures[0].sig}">4WwZktjF…idVBMK</code>`), 'shortened on screen, whole in the title');
  assert.match(out, new RegExp(`data-act="kh-copy" data-copy="${KEEP_4_M1.captures[0].sig}"`));
  assert.match(plain(out), /第12〜83ターン：アステルが砦のマスを占拠 72 ターン/);
  assert.match(plain(out), /占領：チェーンの記録を読んだものです（このブラウザでは計算し直していません）/);
  // while the contest runs: its count, no capture, no caption
  const during = fs({ bell: 52 });
  const mid = plain(renderKeep(during, during.conquest.keeps.get('4,-1')));
  assert.match(mid, /アステルが争奪中 41 \/ 72ターン/);
  assert.doesNotMatch(mid, /占領：チェーンの記録/);
  // a record without a signature prints none (nothing is made up)
  const bare = fs({ bell: 92 });
  bare.conquest.history.set('4,-1', { ...recordAt(KEEP_4_M1, 92), captures: [{ ...KEEP_4_M1.captures[0], sig: undefined }] });
  assert.doesNotMatch(String(renderKeep(bare, bare.conquest.keeps.get('4,-1'))), /kh-sig|kh-copy/);
  assert.equal(String(K.sigChip('not a signature!')), '');
  setLang('en');
  const en = plain(renderKeep(after, after.conquest.keeps.get('4,-1')));
  assert.match(en, /Capture: read from its chain record \(not recomputed here\)/);
  assert.match(en, /Turn 83: Aster took it from Fjordal/);
  assert.doesNotMatch(en, CJK);
  assert.doesNotMatch(en, /\bbell/i);
});

// ------------------------------------------------------------------ the host's card
test('"March on a keep" on the host\'s bar: only on a conquest season; the list names province, holder, defenders, arrival and the turns to hold', () => {
  const s = fs();
  s.selected = { p: 2, q: 0, idx: 20 }; s.hand = { host: String(entry().id), pop: 'keeps' };
  const m = handModel(s);
  assert.equal(m.kind, 'host');
  assert.ok(m.buttons.some(b => b.id === 'keeps' && b.data.pop === 'keeps'));
  assert.equal(m.pop, 'keeps');
  assert.ok(!POPS.includes('keeps') && CONQUEST_POPS.includes('keeps'));
  // the basic game (program version 2) has neither the button nor the card
  const basic = { ...s, season: { ...SEASON, programVersion: 2 } };
  assert.ok(!handModel(basic).buttons.some(b => b.id === 'keeps'));
  assert.equal(popOf(basic), null);
  // before the controller's answer, then with it
  assert.match(plain(renderPop(s, m)), /届く砦を調べています…/);
  s.conquest.keeps.set('0,4', { p: 0, q: 4, tile: 26, holder: 1, troops: 0, heartland: false, consolidatedUntil: 0, contender: 0, progress: 33, requiredBells: 72, asOfBell: 10 });
  s.conquest.hostReach = { key: 'k', host: String(entry().id), ok: true, unreachable: ['3,-4'], rows: [{ p: 4, q: -1, tile: 10, holder: 5, troops: 100, route: route(13, 3, 1800) }, { p: 0, q: 4, tile: 26, holder: 1, troops: 0, route: route(19, 4, 2460) }] };
  const km = K.keepsModel(s, m.host);
  assert.deepEqual(km.rows.map(r => [r.key, r.holder, r.troops, r.hexes, r.arrive, r.hold, r.contender, r.progress]), [['4,-1', 5, 100, 13, 12, 72, null, null], ['0,4', 1, 0, 19, 12, 72, 0, 33]]);
  const out = String(renderPop(s, m));
  assert.match(out, /data-act="cq-march" data-host="[0-9]+" data-p="4" data-q="-1" data-tile="10" data-keep-row="4,-1"/, 'a row is the page\'s own order: the composer with the keep as its destination');
  assert.deepEqual(K.keepLights(km, '0,4').map(x => [x.p, x.q, x.tile, x.hot]), [[4, -1, 10, false], [0, 4, 26, true]], 'what the board is told to light');
  setLang('en');
  const en = plain(renderPop(s, m));
  assert.match(en, /March on a keep 2 keeps in reach/);
  assert.match(en, /Held by Fjordal · Province 4,-1 100 defenders Turn 12 arrival \(13 tiles\) 72 turns to hold/);
  assert.match(en, /33\/72 Aster holds the tile/);
  assert.doesNotMatch(en, CJK);
  // a host that cannot depart yet: the list stands, its rows wait, and the card says from which turn
  const forming = fs({ bell: 9, entries: [entry({ state: 2, fromBell: 11 })] });
  forming.selected = { p: 2, q: 0, idx: 20 }; forming.hand = { host: String(entry().id), pop: 'keeps' };
  forming.conquest.hostReach = { ...s.conquest.hostReach };
  const fm = handModel(forming);
  assert.match(String(renderPop(forming, fm)), /class="kh-row kh-n5 off"[^>]*aria-disabled="true"/);
  assert.match(plain(renderPop(forming, fm)), /forming up\. This host can depart from turn 11\./);
});

test('the order card names the keep, its recorded defenders and what holding its tile brings', () => {
  // (the composer's own checks read the season's fee fields: a round set of them)
  const s = fs({ extra: { season: { ...SEASON, minRevealPriorityMilli: 1000, revealCuLimit: 200000, revealLoadedLimit: 64000, marchFee: 0n, sealBond: 0n } } });
  const k = s.conquest.keeps.get('4,-1');
  s.compose = { holding: s.holdings[0], host: { ...entry(), troops: 500, tile: 20, unit: 0 }, origin: { p: 2, q: 0 }, stance: 1, retreat: 'never', ratio: null, tip: '0', quick: [], dest: { p: 4, q: -1, tile: k.tile }, route: { ...route(13, 3, 1800), dirs: [] }, arriveBell: 12 };
  const card = plain(marchCard(s));
  assert.match(card, /州 4,-1の砦 · 記録の守備兵 100 · マスを 72 ターン保てば州を奪取/);
  assert.match(card, /封をして出発する/);
  setLang('en');
  assert.match(plain(marchCard(s)), /Keep of Province 4,-1 · 100 recorded defenders · hold its tile for 72 turns to take the province/);
  assert.match(plain(marchCard(s)), /Seal and depart/);
});

// ------------------------------------------------------------------ provinces held, and the season's end
test('"Provinces held" is the standings record: six nations, the viewer\'s marked, and the figures that changed', () => {
  const before = P.stripModel(fs()), after = P.stripModel(fs({ bell: 92, extra: {} }));
  assert.deepEqual(before.rows.map(r => r.provinces), [9, 9, 9, 9, 9, 9]);
  assert.equal(before.rows[0].mine, true);
  const later = fs({ bell: 92 }); later.conquest.standings = STANDINGS_AFTER;
  const m = P.stripModel(later);
  assert.deepEqual(m.rows.map(r => [r.faction, r.provinces, r.lead]), [[0, 10, true], [1, 9, false], [2, 9, false], [3, 9, false], [4, 9, false], [5, 8, false]]);
  assert.deepEqual(P.changedCounts(before, m), [{ faction: 0, from: 9, to: 10 }, { faction: 5, from: 9, to: 8 }]);
  assert.deepEqual(P.changedCounts(null, m), []);
  assert.equal(after.bell, 82);
  const out = String(P.renderStrip(m));
  assert.match(out, /data-act="tab" data-tab="territory"/, 'a press opens the full standings');
  assert.match(out, /class="ps-n kh-n0 ps-mine ps-lead" data-f="0" data-v="10"/);
  // no record, an old Dominion table, or the basic game: nothing
  assert.equal(P.stripModel({ ...fs(), conquest: { standings: null } }), null);
  assert.equal(P.stripModel({ ...fs(), conquest: { standings: { ...STANDINGS_BEFORE, metric: 'dominion' } } }), null);
  assert.equal(P.stripModel({ ...fs(), season: { ...SEASON, programVersion: 2 } }), null);
  setLang('en');
  assert.match(plain(P.renderStrip(m)), /Provinces held Aster 10 You Borealis 9 Cinder 9 Dunmar 9 Ember 9 Fjordal 8/);
  assert.doesNotMatch(plain(P.renderStrip(m)), /prototype|sample/i);
});

test('the season-end card stands only when the records say so: the pool final after Tally and Finalize, or the final standings', () => {
  const over = extra => ({ ...fs({ bell: 96 }), ...extra });
  assert.equal(P.seasonEndModel(fs({ bell: 95, extra: { prize: POOL_FINAL } })), null, 'not before the season\'s end');
  assert.equal(P.seasonEndModel(over({ prize: { ...POOL_FINAL, state: 'open', counted: 0, area: null, winners: null } })), null, 'ended, nothing counted');
  assert.equal(P.seasonEndModel(over({ prize: { ...POOL_FINAL, state: 'open', counted: 32, winners: null } })), null, 'Tally under way: no winner yet');
  const end = P.seasonEndModel(over({ prize: POOL_FINAL }));
  assert.deepEqual([end.winners, end.provinces, end.area, end.source, end.mine], [[0], 11, [11, 8, 9, 9, 9, 8], 'pool', true]);
  // a season without a pool: the herald's final standings, and only those
  assert.equal(P.seasonEndModel(over({})), null, 'the live standings are not the final record');
  const noPool = over({}); noPool.conquest.final = STANDINGS_AFTER;
  assert.deepEqual([P.seasonEndModel(noPool).winners, P.seasonEndModel(noPool).source], [[0], 'final']);
  const tie = P.seasonEndModel(over({ prize: { ...POOL_FINAL, area: [10, 10, 9, 9, 8, 8], winners: [0, 1] } }));
  setLang('en');
  assert.equal(P.seasonEndLine(end), 'Aster holds the most provinces (11)');
  assert.equal(P.seasonEndLine(tie), 'Tied for first: Aster / Borealis (10 each)');
  const card = plain(P.renderSeasonEnd(end));
  assert.match(card, /The season is over Aster holds the most provinces \(11\)/);
  assert.match(card, /confirmed on the local test chain/);
  assert.doesNotMatch(card, CJK);
});

// ------------------------------------------------------------------ the prize panel
test('the prize panel in English: pool and fee in test USDC, the chain\'s count, Attackers and Supporters with signatures, the split as an estimate', () => {
  setLang('en');
  const done = { ...fs({ bell: 96 }), prize: POOL_FINAL, prizeLedger: LEDGER, wallet: { address: LEDGER.lines[0].wallet } };
  const out = String(prizePanel(done)), text = plain(out);
  assert.match(text, /Prize \(test USDC\) 60 prize pool · test USDC/);
  assert.match(text, /local test chain/);
  assert.match(text, /Entry fee 25 Entry fees collected 75 Entrants 3/);
  assert.match(text, /Provinces per nation \(counted on chain\) Aster 11 Winner Borealis 8/);
  assert.match(text, /Tally and Finalize are records on the local test chain\./);
  assert.match(text, /Attackers Aster 4yWQ2b…xUZF \(you\) Province 0,4 1 keep Turn 85 Record signature 4GLCK5hP…Lsf888 Copy/);
  assert.match(text, /Supporters Aster 6oWvAm…yDeq Province 4,-1 483 troops Turn 16/);
  assert.match(text, /Contribution lines are derived from the public chain records by an operator's script\./);
  assert.match(text, /Estimated split · no transfer made/);
  assert.match(text, /estimate 25 test USDC/i);
  assert.match(out, new RegExp(`data-copy="${LEDGER.lines[1].signatures[0]}"`));
  assert.doesNotMatch(text, CJK);
  assert.doesNotMatch(text, /\bbell/i);
  assert.equal(String(prizePanel({ ...fs(), prize: null })), '', 'no pool: no panel');
});

// ------------------------------------------------------------------ scene 5: the battle report
test('the battle report says what is recomputed here, prints the record\'s slot, and a signature only when the record carries one', () => {
  const rep = (season, clash, verify = null) => ({ mode: 'play', season, citizen: { faction: 0 }, holdings: [], provinces: new Map(), nowBell: 40, report: { p: 0, q: 4, bell: 38, clash: { report: clash, inputs: null }, verify } });
  const clash = { bell: 38, slot: 3024, anchor: { key: 'an:38,1' }, cache: { key: 'sd:38,1,14' }, inputDigest: 'b5800376a9aa9db9', outcomeDigest: '83e7df3016adc418', decoded: { engagements: 1 } };
  setLang('en');
  const text = plain(report(rep(SEASON, clash)));
  // (one word for one thing in English since the merge of frontier/ux: the report is a clash report, and says clash here too)
  assert.match(text, /Clash: recomputed in this browser from the public record \(record slot 3,024\)/);
  assert.match(text, /Record slot 3,024/);
  assert.match(text, /Verify in this browser/);
  assert.doesNotMatch(String(report(rep(SEASON, clash))), /kh-sig/, 'the herald\'s clash view carries no signature today: none is printed');
  const sig = '4WwZktjF2KUobqepbfLWNhCPWXAWGcbYLBSAQfwYKkPGge7feRf6SwdcsLX17pee8xmDgXHL6wtM25HuAvidVBMK';
  assert.match(plain(report(rep(SEASON, { ...clash, sig }))), /Clash record signature 4WwZktjF…idVBMK Copy/, 'printed as soon as the view carries one');
  const steps = Object.fromEntries(['kernel', 'seed', 'inputs', 'recompute', 'digest', 'fates'].map(k => [k, { ok: true }]));
  const matched = String(report(rep(SEASON, clash, { result: 'match', steps })));
  assert.match(matched, /data-verify-result="match"><span class="rep-match">Match<\/span>/);
  // the basic game's report is as it was
  const basic = String(report(rep({ ...SEASON, programVersion: 2 }, clash, { result: 'match', steps })));
  assert.doesNotMatch(basic, /rep-recheck|rep-match|rep-ref/);
  assert.doesNotMatch(plain(basic), /Record slot/);
});

// ------------------------------------------------------------------ the guide
test('the guide on a conquest season: seven steps to a province, each from the records', () => {
  assert.deepEqual([...CONQUEST_STEPS], ['village', 'build', 'train', 'muster', 'march', 'hold', 'capture']);
  const status = s => conquestGuide(s).steps.map(x => x.status[0]).join('');
  const fresh = fs({ entries: [] });
  assert.equal(status(fresh), 'dcttttt');
  assert.equal(conquestObjective(fresh).go.act, 'cg-go');
  assert.equal(conquestObjective(fresh).go.data.pop, 'build');
  const withHost = fs();
  assert.equal(conquestGuide(withHost).current, 'march');
  assert.deepEqual(conquestObjective(withHost).go, { act: 'cg-go', data: { pop: 'keeps', host: String(entry().id) }, label: conquestObjective(withHost).go.label });
  // a host that is forming: the step says the truth of the moment, and leads to the hosts
  const forming = fs({ bell: 9, entries: [entry({ state: 2, fromBell: 11 })] });
  assert.match(conquestObjective(forming).text, /編成中です。ターン 11 から出発できます。/);
  // the nation's host holds the keep's tile: the count is the keep's record
  const holding = fs({ bell: 52 });
  assert.equal(conquestGuide(holding).current, 'hold');
  assert.match(conquestObjective(holding).text, /41 \/ 72 ターン保っています/);
  assert.deepEqual(conquestObjective(holding).go.data, { p: 4, q: -1 });
  // the capture record: every step is done
  const taken = fs({ bell: 92 }); taken.conquest.events = [{ seq: '10696', kind: 'keep_taken', bell: 83, p: 4, q: -1, from: 5, to: 0, troops: 241 }];
  assert.equal(conquestGuide(taken).current, 'done');
  assert.equal(conquestObjective(taken), null);
  assert.match(plain(renderConquestGuide(taken)), /第83ターンに、あなたの国（アステル）が州 4,-1 を奪いました。/);
  // the page's one "next thing" follows it on a conquest season, and not on the basic game
  assert.equal(objectiveModel({ ...withHost, ui: {} }).id, 'march');
  assert.notEqual(objectiveModel({ ...withHost, ui: {}, season: { ...SEASON, programVersion: 2 } })?.id, 'march');
  setLang('en');
  const en = plain(renderConquestGuide(holding));
  assert.match(en, /Guide 5\/7: Hold the keep's tile for 72 turns/);
  assert.match(en, /First village .* Build .* Train troops .* March on a keep .* Hold the keep's tile for 72 turns .* Take the province/);
  assert.doesNotMatch(en, CJK);
});

// ------------------------------------------------------------------ the samples, the paid join's proof, and the page
test('every `?fx=hand-…` sample renders from the real records, in English with no Japanese left and no "bell" for the step', () => {
  setLang('en');
  for (const name of D.HAND_SAMPLES) {
    const s = D.sampleOf(name);
    assert.ok(s && ['sheet', 'pop', 'strip', 'end'].includes(s.place), name);
    const text = plain(s.markup);
    assert.ok(text.trim().length > 20, name);
    assert.doesNotMatch(text, CJK, name);
    assert.doesNotMatch(text, /\bbells?\b/i, name);
    assert.doesNotMatch(text, /prototype/i, name);
  }
  assert.match(plain(D.sampleOf('hand-keep-taken').markup), /Record signature 4WwZktjF…idVBMK/);
  assert.deepEqual(D.sampleOf('hand-strip').after.changed, [{ faction: 0, from: 9, to: 10 }, { faction: 5, from: 9, to: 8 }]);
  assert.equal(D.sampleOf('hand-nothing'), null);
});

test('the first-village card keeps the proof of the paid join: the fee and the balance before and after (fault 5)', () => {
  const src = readFileSync(new URL('screens/join.mjs', WEB), 'utf8');
  assert.match(src, /参加費 \$\{tokenUnits\(FS\.prizePayment\.fee\)\} テストUSDC を支払いました（支払い前 \$\{tokenUnits\(FS\.prizePayment\.before\)\} → 支払い後 \$\{tokenUnits\(FS\.prizePayment\.after \?\? 0\)\}）。/);
  assert.equal(EN['参加費 {0} テストUSDC を支払いました（支払い前 {1} → 支払い後 {2}）。'], 'Paid the entry fee of {0} test USDC (before {1} → after {2}).');
  assert.equal(typeof join, 'function');
});

test('the page: the stylesheet is linked, nothing inline, and the conquest wiring is asked of the board only if the board has it', () => {
  const index = readFileSync(new URL('index.html', WEB), 'utf8');
  assert.match(index, /<link rel="stylesheet" href="conquest-hand\.css">/);
  const css = readFileSync(new URL('conquest-hand.css', WEB), 'utf8');
  assert.doesNotMatch(css, /url\(\s*["']?https?:/, 'no remote asset');
  for (const f of ['hud/keephand.mjs', 'hud/provstrip.mjs', 'hud/handdemo.mjs', 'screens/conquestguide.mjs']) assert.doesNotMatch(readFileSync(new URL(f, WEB), 'utf8'), /style="/, `${f}: no inline style (CSP)`);
  const app = readFileSync(new URL('app.mjs', WEB), 'utf8');
  assert.match(app, /mapRef\?\.setKeepReach\?\.\(/);
  assert.match(app, /!mapRef\?\.keepAt\)/);
  assert.match(app, /mapRef\.flyToKeep\) mapRef\.flyToKeep\(/);
  assert.match(app, /for \(const ev of \['keep:captured', 'keep:contest'\]\)/);
  assert.match(app, /keephand\.conquestOn\(FS\) && !territoryEnabled\(FS\) && !FS\.sample/, 'the strip and the season-end card: a conquest season outside the sample world');
});

test('the sample world draws what it drew: no keeps card, no strip, no report caption, whatever its season says', () => {
  const s = fs({ extra: { sample: { name: 'sample' } } });
  s.selected = { p: 2, q: 0, idx: 20 }; s.hand = { host: String(entry().id), pop: 'keeps' };
  assert.equal(K.conquestOn(s), false);
  assert.ok(!handModel(s).buttons.some(b => b.id === 'keeps'));
  assert.equal(handModel(s).pop, null);
  assert.equal(P.stripModel(s), null);
  assert.equal(P.seasonEndModel({ ...s, nowBell: 96, prize: POOL_FINAL }), null);
  assert.equal(conquestGuide(s), null);
});
