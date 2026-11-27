// fix-loop26 (loop-play26 BREAK-1 + BREAK-2; Q-LP26-1 rec (a), Grok): page only, no rule change.
//   BREAK-1: in a `--demo` world the camp the guide named filled to 12 villages while the host walked, so it sat the
//     battle out. The report read "Held: the enemy is still on the field too" (300→300 vs 196→196) with no reason,
//     the guide counted it as the first battle (4/8), and the 「一致」 attached to a fight that never happened.
//     Now: the report drops the sat-out camp from the sides and says why (JA + EN); the guide keeps the camp step open
//     (the CLASH record's `engagements` 0 — permutation-rules frontier/clash.rs: one per pairing) and names the next
//     camp that fights; a Match of such a turn is labelled as one and does not tick the "verified" flag.
//   BREAK-2: the guide's "should win even with bad luck" is rulebook.mjs campArrival `holds` at the worst roll, and
//     the kernel CLEARS a camp whose tile the attackers hold (frontier-abi clash_model.rs `whole == 0 ||
//     gr.attackers_hold`). The report read the kernel's garrison troops instead and stamped a cleared camp "Held"
//     (400 vs 271 → "Held: the enemy is still on the field too"). The promise matches the code; the report now reads
//     `attackersHold`: "Victory: the camp was cleared", and why it is gone with troops left (JA + EN).
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setLang } from '../../permutation-server/web/lang.mjs';
import { hostId } from '../../permutation-server/web/frontier/faddr.mjs';
import { baseProduction } from '../../permutation-server/web/frontier/fland.mjs';
import * as FB from '../../permutation-server/web/frontier/hud/firstbattle.mjs';
import * as REP from '../../permutation-server/web/frontier/screens/report.mjs';
import { conquestObjective, conquestGuide, conquestFacts, noFightLead } from '../../permutation-server/web/frontier/screens/conquestguide.mjs';
import { campArrival } from '../../permutation-server/web/frontier/hud/rulebook.mjs';
import { ownClashesFrom } from '../../permutation-server/web/frontier/hud/feed.mjs';

afterEach(() => setLang('ja'));
const CJK = /[぀-ヿ㐀-鿿]/;
const REPO = new URL('../../', import.meta.url);
const src = f => readFileSync(new URL(`permutation-server/web/frontier/${f}`, REPO), 'utf8');
const plain = s => String(s).replace(/<[^>]*>/g, ' ').replace(/&#39;/g, '\'').replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();

// ------------------------------------------------------------------ fixtures (the fix-firstcamp shape)
const GEN = 1_000_000;
const CLOCK = { genesisTs: GEN, drand: { genesis: 0, period: 3 }, margin: 60, window: () => 600 };
const HOME = () => ({ p: 2, q: 0, site: 2, gen: 0, tile: 20, faction: 0, state: 2, order: 1, tier: 0, flags: 0, production: baseProduction(0), upkeep: Array(8).fill(0n), stores: [], reserve: Array(8).fill(0), queue: [],
  transit: [{ state: 0 }], explore: { state: 0 }, lastOwnerAction: 1000n, finalTs: 1n, shieldUntil: 0n });
const HID = hostId({ p: 2, q: 0, site: 2, gen: 0, seq: 1 });
const entry = (extra = {}) => ({ id: HID, unit: 0, state: 1, tile: 20, troops: 300000, staminaValue: 120, staminaBell: 10, readyBell: 10, pendOp: 0, fromBell: 10, faction: 0, ...extra });
const SEASON = { programVersion: 3, layoutVersion: 2, endBell: 4294967295, bellSecs: 600, minLead: 2, maxLead: 72, conquestParams: { keepBells: 72 } };
const mirror = (n, state = 1) => Array.from({ length: 12 }, (_, i) => ({ state: i < n ? state : 0, faction: i % 6, gen: 0, garrison: 0 }));
const camp = (p, q, troops, { tile = 33, held = 0, state = 1 } = {}) => ({ p, q, state, tile, troops, gen: 0, held });
const prov = (p, q, bell, c, entries = []) => ({ province: { p, q, resolvedNext: bell, entries, ticketCohorts: [], siteCount: 12, sites: [20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31], siteMirror: mirror(c?.held ?? 0), camp: c ? { state: c.state, tile: c.tile, troops: c.troops, gen: 0 } : null } });
const fs = ({ bell = 10, entries = [entry()], camps = [], extra = {} } = {}) => {
  const provinces = new Map([['2,0', prov(2, 0, bell, camps.find(c => c.p === 2 && c.q === 0) ?? null, entries)]]);
  for (const c of camps) if (!(c.p === 2 && c.q === 0)) provinces.set(`${c.p},${c.q}`, prov(c.p, c.q, bell, c));
  return { mode: 'play', season: SEASON, clock: CLOCK, citizen: { faction: 0, arrivals: 0 }, holdings: [HOME()], nowBell: bell, chain: { now: () => GEN + bell * 600 + 100 }, land: { stage: 'final' }, inFlight: 0,
    provinces, conquest: { status: 'ready', keeps: new Map(), events: [] }, marches: [], orders: [], ui: { dismissed: [] }, terrainOf: () => null, ...extra };
};
const clashRec = (p, q, bell, engagements) => ({ record: { name: 'CLASH', p, q, bell, engagements, fates: { 0: 1 } } });
// the loop-play26 BREAK-1 world: the march to the camp of (3,0) arrived on turn 8, and by then 12 villages stood there.
// The host is home again (the guide asks from where it stands), another camp of (4,0) fights.
const afterSitOut = ({ engagements = 0, arrivals = 1, more = {} } = {}) => fs({
  camps: [camp(3, 0, 196, { held: 12 }), camp(4, 0, 150)],
  extra: {
    citizen: { faction: 0, arrivals },
    marches: [{ dest: { p: 3, q: 0, tile: 33 }, entry: { arriveBell: 8 }, facts: { pipeline: 'resolved' } }],
    orders: [{ kind: 'march', state: 'accepted', dest: { p: 3, q: 0, tile: 33 }, arriveBell: 8 }],
    chronicle: [clashRec(3, 0, 8, engagements)],
    ...more,
  },
});

// ------------------------------------------------------------------ the records: what was a fight
test('clashEngagements reads the CLASH record of (p, q, bell), newest first; null when none is read', () => {
  const s = { chronicle: [clashRec(3, 0, 8, 2), { record: { name: 'MARCH', p: 3, q: 0, bell: 8 } }, clashRec(3, 0, 8, 0), clashRec(3, 0, 9, 5)] };
  assert.equal(FB.clashEngagements(s, 3, 0, 8), 0, 'the newest record of that turn');
  assert.equal(FB.clashEngagements(s, 3, 0, 9), 5);
  assert.equal(FB.clashEngagements(s, 3, 0, 7), null);
  assert.equal(FB.clashEngagements({}, 3, 0, 8), null);
  assert.equal(FB.clashEngagements({ chronicle: [{ name: 'CLASH', p: 1, q: 1, bell: 1, engagements: 0 }] }, 1, 1, 1), 0, 'a bare record');
});

test('campSatOutOn: only a standing camp ON the arrival tile of a 12-garrison province sat out', () => {
  const pr = (held, extra = {}) => ({ siteCount: 12, siteMirror: mirror(held), camp: { state: 1, tile: 33, troops: 196 }, ...extra });
  assert.equal(FB.campSatOutOn(pr(12), 33), 'garrisons');
  assert.equal(FB.campSatOutOn(pr(11), 33), null, '11 villages: it fights');
  assert.equal(FB.campSatOutOn(pr(12), 34), null, 'another tile');
  assert.equal(FB.campSatOutOn(pr(12, { camp: { state: 0, tile: 33, troops: 0 } }), 33), null, 'no camp standing');
  assert.equal(FB.campSatOutOn(null, 33), null);
});

test('firstBattleStillAhead: every known own arrival was resolved with no engagement, and nothing else is out', () => {
  const s = afterSitOut();
  const a = FB.firstBattleStillAhead(s);
  assert.deepEqual({ p: a.p, q: a.q, tile: a.tile, bell: a.bell, engagements: a.engagements, why: a.why }, { p: 3, q: 0, tile: 33, bell: 8, engagements: 0, why: 'garrisons' });
  // a fight (engagements > 0): the first battle happened
  assert.equal(FB.firstBattleStillAhead(afterSitOut({ engagements: 1 })), null);
  // the record not read yet: unknown counts as the first battle (as before)
  assert.equal(FB.firstBattleStillAhead(afterSitOut({ more: { chronicle: [] } })), null);
  // another march still out, or a sealed order for another arrival: not yet
  assert.equal(FB.firstBattleStillAhead(afterSitOut({ more: { marches: [{ dest: { p: 3, q: 0, tile: 33 }, entry: { arriveBell: 8 }, facts: { pipeline: 'resolved' } }, { dest: { p: 4, q: 0, tile: 33 }, entry: { arriveBell: 12 }, facts: { pipeline: 'sealed' } }] } })), null);
  assert.equal(FB.firstBattleStillAhead(afterSitOut({ more: { orders: [{ kind: 'march', state: 'accepted', dest: { p: 4, q: 0, tile: 33 }, arriveBell: 12 }] } })), null);
  // a refused order or a march home does not count
  assert.ok(FB.firstBattleStillAhead(afterSitOut({ more: { orders: [{ kind: 'march', state: 'refused', dest: { p: 4, q: 0, tile: 33 }, arriveBell: 12 }, { kind: 'march', state: 'accepted', home: true, dest: { p: 2, q: 0, tile: 20 }, arriveBell: 11 }] } })));
  // the Citizen counts more arrivals than the page knows of: one of them may have fought
  assert.equal(FB.firstBattleStillAhead(afterSitOut({ arrivals: 2 })), null);
  // no arrival at all: nothing to say
  assert.equal(FB.firstBattleStillAhead(fs()), null);
  // the march row gone, the page's own clash list keeps it (hud/feed.mjs ownClashesFrom)
  const kept = afterSitOut({ more: { marches: [], ownClashes: [{ p: 3, q: 0, tile: 33, bell: 8 }] } });
  assert.equal(FB.firstBattleStillAhead(kept)?.why, 'garrisons');
  // nobody fought, but not because of the 12 villages (the camp was already gone): 'none'
  const gone = afterSitOut({ more: { ownClashes: [] } });
  gone.provinces.get('3,0').province.camp = { state: 0, tile: 33, troops: 0, gen: 0 };
  assert.equal(FB.firstBattleStillAhead(gone)?.why, 'none');
});

test('the no-battle fact outlives the chronicle: ownClashesFrom keeps the engagements once read, ownEngagements falls back to it (live: the record was gone by turn 69)', () => {
  const resolved = (bell, fights) => ({ bell, marches: new Map([['m1', { pipeline: 'resolved', dest: { p: 3, q: 0, tile: 33 }, bell: 8 }]]), fights });
  // the march resolves before its CLASH record is read: kept without a number
  let list = ownClashesFrom([], resolved(9, new Map()), resolved(9, new Map()));
  assert.deepEqual(list, [{ p: 3, q: 0, tile: 33, bell: 8 }]);
  // the record is read: the number is kept
  list = ownClashesFrom(list, resolved(10, new Map()), resolved(10, new Map([['3,0,8', 0]])));
  assert.equal(list[0].engagements, 0);
  // the record has left the chronicle (no `fights` entry, march row gone): the number stays
  list = ownClashesFrom(list, resolved(11, new Map()), { bell: 70, marches: new Map(), fights: new Map() });
  assert.deepEqual(list, [{ p: 3, q: 0, tile: 33, bell: 8, engagements: 0 }]);
  // a number once read is not overwritten by a later snapshot
  assert.equal(ownClashesFrom(list, null, { bell: 71, marches: new Map(), fights: new Map([['3,0,8', 4]]) })[0].engagements, 0);
  // the guide: no chronicle record, only the page's own list
  const s = afterSitOut({ more: { chronicle: [], marches: [], orders: [], ownClashes: list } });
  assert.equal(FB.ownEngagements(s, 3, 0, 8), 0);
  assert.equal(FB.ownEngagements(s, 3, 0, 9), null);
  assert.equal(FB.firstBattleStillAhead(s)?.why, 'garrisons');
  assert.equal(conquestGuide(s).current, 'camp');
  // the chronicle's record wins while it is held
  assert.equal(FB.ownEngagements({ ...s, chronicle: [clashRec(3, 0, 8, 2)] }, 3, 0, 8), 2);
});

// ------------------------------------------------------------------ the guide (BREAK-1)
test('BREAK-1: the guide does not count a sat-out arrival as the first battle — the camp step stays open, says why, names the next fighting camp (JA + EN)', () => {
  const s = afterSitOut();
  assert.equal(conquestFacts(s).raided, false);
  const g = conquestGuide(s);
  assert.equal(g.current, 'camp', 'not 4/8 build');
  assert.equal(g.steps.find(x => x.id === 'camp').status, 'current');
  const o = conquestObjective(s);
  assert.match(o.text, /^軍勢は.+の野営地に着きましたが、戦いはありませんでした。その州には村が 12 立っているため、野営地は戦いに加わりませんでした（野営地が戦うのは、州の村が 12 未満のときだけです）。最初の戦いはまだこれからです。/);
  assert.match(o.text, /最初の戦いは、.+の蛮族の野営地（守り手 150）にしましょう。/, 'the next camp that fights');
  assert.doesNotMatch(o.text, /守り手 196/, 'never the sat-out camp');
  // the sat-out camp's province by the viewer's village where it has one (the --demo home province fills first)
  const home = afterSitOut({ more: { holdings: [{ ...HOME(), p: 3, q: 0 }], marches: [{ dest: { p: 3, q: 0, tile: 33 }, entry: { arriveBell: 8 }, facts: { pipeline: 'resolved' } }] } });
  assert.match(noFightLead(home, FB.firstBattleStillAhead(home)), /^軍勢は.+のある州の野営地に着きましたが/);
  assert.equal(o.go.act, 'ob-go');
  setLang('en');
  const en = conquestObjective(s).text;
  assert.doesNotMatch(en, CJK);
  assert.doesNotMatch(en, /season/i);
  assert.match(en, /^Your host reached the camp of .+, but there was no battle: 12 villages stand in that province, so the camp did not join it \(a camp fights only while fewer than 12 villages stand in its province\)\. Your first battle is still ahead\. Make your first battle the barbarian camp of .+ \(150 defenders\)\./);
  // a real fight on the same march: the step is done, as before
  setLang('ja');
  const fought = afterSitOut({ engagements: 3 });
  assert.equal(conquestFacts(fought).raided, true);
  assert.notEqual(conquestGuide(fought).current, 'camp');
  // skipping the step still moves on
  const skipped = afterSitOut({ more: { ui: { dismissed: ['ob:skip:camp'] } } });
  assert.equal(conquestFacts(skipped).raided, true);
});

test('the no-battle lead for a turn nobody fought for another reason (JA + EN)', () => {
  const a = { p: 3, q: 0, tile: 33, bell: 8, why: 'none' };
  const s = fs({ camps: [camp(4, 0, 150)] });
  assert.match(noFightLead(s, a), /^軍勢は.+に着きましたが、戦いはありませんでした（そのマスで向かってくる相手はいませんでした）。最初の戦いはまだこれからです。$/);
  setLang('en');
  assert.match(noFightLead(s, a), /^Your host reached .+, but there was no battle \(nobody stood against it on that tile\)\. Your first battle is still ahead\. $/);
  assert.doesNotMatch(noFightLead(s, a), CJK);
  assert.equal(noFightLead(s, null), '');
});

// ------------------------------------------------------------------ the report (BREAK-1)
const ARR = { hostId: String(HID), faction: 0, unit: 0, troops: 300000, troopsAfter: 300000, fate: 1, tile: 33, stance: 1, retreat: 0, present: 1 };
const before = held => ({ p: 3, q: 0, siteCount: 12, sites: [20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31], siteMirror: mirror(held), entries: [], camp: { state: 1, tile: 33, troops: 196, gen: 0 } });
const mineHost = id => String(id) === String(HID);

test('recordRows: a camp in a 12-holding province is no side of the clash (the rule: camp only below MAX_GARRISONS)', () => {
  const rows12 = REP.recordRows({ inputs: { arrivals: [ARR] }, before: before(12), after: before(12) }, mineHost);
  assert.deepEqual(rows12.map(r => r.kind), ['arrival'], 'no "Barbarian camp 196→196"');
  assert.notEqual(REP.verdictOf(REP.summaryOf(rows12)).text, '持ちこたえた：相手も戦場に残っている');
  const rows11 = REP.recordRows({ inputs: { arrivals: [ARR] }, before: before(11), after: before(11) }, mineHost);
  assert.deepEqual(rows11.map(r => r.kind).sort(), ['arrival', 'camp'], '11 villages: the camp fights and is listed');
});

test('noFightOf: the sat-out camp, a turn with no engagement, and a real fight', () => {
  const r = (held, eng = 0, extra = {}) => ({ p: 3, q: 0, bell: 8, before: before(held), clash: { inputs: { arrivals: [ARR] }, report: { decoded: { engagements: eng } } }, ...extra });
  const rows = x => REP.reportRows(x, mineHost);
  const a = r(12);
  assert.deepEqual(REP.noFightOf(a, rows(a)), { noFight: true, cause: 'garrisons', garrisons: 12, campTroops: 196 });
  // 11 villages and a fight on the tile: nothing to say
  const b = r(11, 1);
  assert.equal(REP.noFightOf(b, rows(b)), null);
  // no camp, no engagement, nobody on the tile: 'none'
  const c = r(0, 0); c.before.camp = { state: 0, tile: 33, troops: 0, gen: 0 };
  assert.deepEqual(REP.noFightOf(c, rows(c)), { noFight: true, cause: 'none', garrisons: null, campTroops: null });
  // not the viewer's arrival: nothing
  assert.equal(REP.noFightOf(a, REP.reportRows(a, () => false)), null);
  // the recomputation's count wins over the herald's decoded copy
  const d = r(0, 0, { verify: { result: 'match', outcome: { engagements: 2, fighters: [], garrisons: [] } } }); d.before.camp = { state: 0, tile: 33, troops: 0, gen: 0 };
  assert.equal(REP.noFightOf(d, rows(d)), null);
});

test('the report says why, and a Match of such a turn is labelled as no battle (JA + EN)', () => {
  const FS = { season: SEASON, report: { p: 3, q: 0, bell: 8, before: before(12), after: before(12), clash: { inputs: { arrivals: [ARR] }, report: { decoded: { engagements: 0 } } } }, provinces: new Map(), holdings: [HOME()] };
  let out = plain(REP.render(FS, mineHost));
  assert.match(out, /野営地は戦いに加わりませんでした。この州には村が 12 立っていて、野営地が戦うのは州の村が 12 未満のときだけです。このターン、あなたの軍勢が着いたマスでは戦いがありませんでした。兵は失っていません。/);
  assert.doesNotMatch(out, /持ちこたえた：相手も戦場に残っている/);
  assert.doesNotMatch(String(REP.render(FS, mineHost)), /data-match-nofight/);
  FS.report.verify = { result: 'match', outcome: { engagements: 0, fighters: [], garrisons: [] }, steps: Object.fromEntries(REP.VERIFY_STEPS.map(id => [id, { ok: true }])) };
  out = String(REP.render(FS, mineHost));
  assert.match(out, /data-match-nofight="1"/);
  assert.match(plain(out), /この「一致」は、戦いのなかったターンの記録を計算し直したものです。戦いの確かめではありません。/);
  setLang('en');
  const en = plain(REP.render(FS, mineHost));
  assert.match(en, /The camp did not join the battle: 12 villages stand in this province, and a camp fights only while fewer than 12 villages stand there\. There was no battle this turn on the tile your host reached\. It lost no troops\./);
  assert.match(en, /This Match recomputes the record of a turn with no battle in it: it does not check a battle\./);
  assert.doesNotMatch(en, /Held: the enemy is still on the field too/);
  assert.doesNotMatch(en, /season/i);
  // a real fight: no such line, no such label
  setLang('ja');
  const fought = { ...FS, report: { ...FS.report, before: before(3), clash: { ...FS.report.clash, report: { decoded: { engagements: 1 } } } } };
  const f = String(REP.render(fought, mineHost));
  assert.doesNotMatch(f, /data-report-nofight|data-match-nofight/);
});

test('app.mjs: a no-battle Match does not tick the verified flag, and the wait panel offers no no-battle report', () => {
  const app = src('app.mjs');
  const v = app.slice(app.indexOf('async function verifyReport('), app.indexOf('const retreatChoiceOf'));
  assert.match(v, /noFight = FS\.report === rep && !!reportScreen\.noFightOf\(rep, reportScreen\.reportRows\(rep, mineOf\(FS\.holdings\)\)\)\?\.noFight;/);
  assert.match(v, /if \(v\?\.result === 'match' && FS\.mode === 'play' && !noFight && /);
  const w = app.slice(app.indexOf('function waitMarkup('), app.indexOf('\n}', app.indexOf('function waitMarkup(')));
  assert.match(w, /myReports\(F\)\.filter\(c => ownEngagements\(F, c\.p, c\.q, c\.bell\) !== 0\)/);
});

// ------------------------------------------------------------------ BREAK-2: the report reads the clear the kernel makes
// The guide's "should win even with bad luck" is rulebook.mjs campArrival `holds` at the worst roll: the host is left
// stronger on the camp's tile after the arrival turn. The kernel then CLEARS the camp — frontier-abi clash_model.rs
// `if whole == 0 || gr.attackers_hold { camp.state = STATE_NONE; camp.troops = 0 }` —, whatever troops it had left. The
// report read the kernel's garrison troops instead (271→199) and stamped "Held: the enemy is still on the field too"
// (loop-play26 world C; this run's world C: 400→367 vs 271→194, the camp gone the next turn). The promise was right;
// the report now says what the chain did.
const CAMP_ID = REP.campId(0);
const clashOf = (hold, left = 194000) => ({
  args: { province: { p: -3, q: 2 }, bell: 8, residents: [], garrisons: [{ id: CAMP_ID, faction: REP.NEUTRAL, tile: 50, troops: 271000, walls: false, posture: 0 }],
    arrivals: [{ id: BigInt(HID), faction: 3, unit: 0, troops: 400000, stamina: 100, tile: 50, posture: 1, retreatBps: null }] },
  outcome: { province: { p: -3, q: 2 }, bell: 8, engagements: 1, fighters: [{ id: BigInt(HID), arrival: true, troops: 367000, stamina: 60, fate: { kind: 'Stays', tile: 50 }, engaged: true }],
    garrisons: [{ id: CAMP_ID, troops: left, attackersHold: hold, holders: hold ? 8 : 0, defenderPresent: true }] },
});

test('BREAK-2: a camp whose tile the attackers hold is cleared — outcomeRows reads attackersHold; the verdict is Victory', () => {
  const { args, outcome } = clashOf(true);
  const rows = REP.outcomeRows(args, outcome, mineHost);
  const camp = rows.find(r => r.kind === 'camp');
  assert.deepEqual({ after: camp.after, fate: camp.fate, cleared: camp.cleared, left: camp.left }, { after: 0, fate: 'Destroyed', cleared: true, left: 194 });
  const sum = REP.summaryOf(rows);
  assert.equal(sum.result, 'won');
  assert.equal(sum.foe, 'camp');
  assert.equal(REP.verdictOf(sum).text, '勝利：野営地を制圧した');
  // the camp kept its tile (the attackers did not hold it): its troops, and "Held" as before
  const held = REP.outcomeRows(clashOf(false).args, clashOf(false).outcome, mineHost);
  assert.equal(held.find(r => r.kind === 'camp').after, 194);
  assert.equal(held.find(r => r.kind === 'camp').cleared, undefined);
  assert.equal(REP.verdictOf(REP.summaryOf(held)).text, '持ちこたえた：相手も戦場に残っている');
  // the record's rows with a matching recomputation laid over them (rowsWithOutcome): the same clear
  const rec = [{ id: String(HID), kind: 'arrival', faction: 3, unit: 0, before: 400, after: null, fate: null, tile: 50, mine: true },
    { id: 'camp', kind: 'camp', faction: REP.NEUTRAL, before: 271, after: null, posture: 0, tile: 50, fate: null, mine: false }];
  const over = REP.rowsWithOutcome(rec, outcome, { camp: { gen: 0 } });
  assert.deepEqual({ after: over[1].after, fate: over[1].fate, cleared: over[1].cleared, left: over[1].left }, { after: 0, fate: 'Destroyed', cleared: true, left: 194 });
  assert.equal(REP.rowsWithOutcome(rec, clashOf(false).outcome, { camp: { gen: 0 } })[1].after, 194);
  // the Province after the turn already gave 0 (the live case: a conquest world, `args` null): the clear and what was left are still said
  const known = [rec[0], { ...rec[1], after: 0, fate: 'Destroyed' }];
  const k = REP.rowsWithOutcome(known, clashOf(true, 197659).outcome, { camp: { gen: 0 } })[1];
  assert.deepEqual({ after: k.after, cleared: k.cleared, left: k.left }, { after: 0, cleared: true, left: 197 });
});

test('BREAK-2: the verified report says Victory and why the camp is gone with troops left (JA + EN); the guide keeps its promise', () => {
  const { args, outcome } = clashOf(true);
  const FS = { season: SEASON, report: { p: -3, q: 2, bell: 8, before: null, after: null, clash: { inputs: { arrivals: [] }, report: { decoded: { engagements: 1 } } },
    verify: { result: 'match', args, outcome, steps: Object.fromEntries(REP.VERIFY_STEPS.map(id => [id, { ok: true }])) } }, provinces: new Map(), holdings: [HOME()] };
  const ja = plain(REP.render(FS, mineHost));
  assert.match(ja, /勝利：野営地を制圧した/);
  assert.match(ja, /野営地は制圧されました。戦いの後も野営地の兵は 194 残っていましたが、攻め手がそのマスを押さえたため、野営地は消えました（攻め手にマスを押さえられた野営地は、兵が残っていても制圧されます）。/);
  assert.doesNotMatch(ja, /持ちこたえた：相手も戦場に残っている/);
  setLang('en');
  const en = plain(REP.render(FS, mineHost));
  assert.match(en, /Victory: the camp was cleared/);
  assert.match(en, /The camp was cleared: 194 of its troops were still standing after the fight, but the attackers held its tile, and a camp whose tile the attackers hold is cleared even with troops left\./);
  assert.doesNotMatch(en, /Held: the enemy is still on the field too/);
  assert.doesNotMatch(en, CJK);
  // a camp destroyed to the last troop needs no such line
  const gone = { ...FS, report: { ...FS.report, verify: { ...FS.report.verify, outcome: clashOf(true, 0).outcome } } };
  assert.doesNotMatch(String(REP.render(gone, mineHost)), /data-report-cleared/);
  // the guide's promise is the kernel's clear: 400 Spearmen hold a 271 camp's tile even at the worst roll
  setLang('ja');
  assert.equal(campArrival({ unit: 0, troops: 400, campTroops: 271 }).worst.holds, true);
  assert.equal(campArrival({ unit: 0, troops: 400, campTroops: 271 }).odds, 'good');
  const s = fs({ camps: [camp(4, 0, 150)] });
  assert.match(conquestObjective(s).text, /いまの軍勢（槍兵 300）なら、運が悪くても勝てる見込みです。/);
  setLang('en');
  assert.match(conquestObjective(s).text, /Your host \(300 Spearmen\) should win even with bad luck\./);
});
