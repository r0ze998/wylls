// A new player's first battle on a conquest season (the UI check of 2026-10-26, local world ui-check-3, season 52):
// the guide sent the first 100 Spearmen at a keep of 100 defenders behind walls on a forest tile; the march was
// turned back (87 left against the keep's 88), the guide went on saying "hold the keep's tile for 72 turns", and the
// report said 「撤退」 with no word of why. These tests pin the three fixes:
//   1 the keep list and the guide say how the arrival would go (rulebook.mjs keepArrival) and what it takes;
//   2 a march whose turn is resolved with nothing left on the keep's tile sends the guide back to the march step;
//   3 the report says why the host did not stay: the strength left on each side, the walls, the terrain, and what
//     it would take next time.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { setLang } from '../../permutation-server/web/lang.mjs';
import { hostId } from '../../permutation-server/web/frontier/faddr.mjs';
import { baseProduction } from '../../permutation-server/web/frontier/fland.mjs';
import { keepArrival, CLASH_BPS } from '../../permutation-server/web/frontier/hud/rulebook.mjs';
import * as K from '../../permutation-server/web/frontier/hud/keephand.mjs';
import { KEEP_4_M1, STANDINGS_BEFORE, keepAt, recordAt } from '../../permutation-server/web/frontier/hud/handdemo-data.mjs';
import { conquestGuide, conquestObjective, keepTarget } from '../../permutation-server/web/frontier/screens/conquestguide.mjs';
import { fieldWhy, summaryOf, tileDetail } from '../../permutation-server/web/frontier/screens/report.mjs';

afterEach(() => setLang('ja'));
const CJK = /[぀-ヿ㐀-鿿]/;

// ------------------------------------------------------------------ fixtures (as in web-frontier-conquest-hand.test.mjs)
const HOME = (extra = {}) => ({ p: 2, q: 0, site: 2, gen: 0, tile: 20, faction: 0, state: 2, order: 1, tier: 0, flags: 0, production: baseProduction(0), upkeep: Array(8).fill(0n), stores: [], reserve: Array(8).fill(0), queue: [],
  transit: [{ state: 0 }], explore: { state: 0 }, lastOwnerAction: 1000n, finalTs: 1n, shieldUntil: 0n, ...extra });
const entry = (extra = {}) => ({ id: hostId({ p: 2, q: 0, site: 2, gen: 0, seq: 1 }), unit: 0, state: 1, tile: 20, troops: 100000, staminaValue: 120, staminaBell: 10, readyBell: 10, pendOp: 0, fromBell: 10, ...extra });
const SEASON = { programVersion: 3, layoutVersion: 2, endBell: 96, bellSecs: 600, dormantAfterSecs: 86400, releaseAfterSecs: 172800, minLead: 2, maxLead: 72, conquestParams: { keepBells: 72 } };
const fs = ({ bell = 10, entries = [entry()], extra = {} } = {}) => ({ mode: 'play', season: SEASON, citizen: { faction: 0 }, holdings: [HOME()], nowBell: bell, chain: { now: () => 1000 }, land: { stage: 'final' }, inFlight: 0,
  provinces: new Map([['2,0', { province: { p: 2, q: 0, resolvedNext: bell, entries, ticketCohorts: [] } }]]),
  conquest: { status: 'ready', keeps: new Map([['4,-1', keepAt(KEEP_4_M1, bell)]]), history: new Map([['4,-1', recordAt(KEEP_4_M1, bell)]]), standings: STANDINGS_BEFORE, final: null, events: [] }, ...extra });

// ------------------------------------------------------------------ 1: the arrival's odds
test('the arrival estimate brackets the turned-back march of the UI check (100 Spearmen on 100 defenders, forest)', () => {
  const o = keepArrival({ unit: 0, troops: 100, keepTroops: 100, rough: true });
  assert.equal(o.odds, 'even', 'it holds only with luck');
  // what the chain recorded: the host 87 left, the keep 88 — between the two ends of the roll
  assert.ok(o.worst.hostLeft <= 87 && 87 <= o.best.hostLeft, JSON.stringify(o));
  assert.ok(o.best.keepLeft <= 88 && 88 <= o.worst.keepLeft, JSON.stringify(o));
  assert.equal(o.worst.holds, false);
  assert.equal(o.best.holds, true);
  // what it takes to hold the tile at the worst roll, and that it does
  assert.ok(o.need > 100 && o.need % 100 === 0);
  assert.equal(keepArrival({ unit: 0, troops: o.need, keepTroops: 100, rough: true }).odds, 'good');
  assert.notEqual(keepArrival({ unit: 0, troops: o.need - 100, keepTroops: 100, rough: true }).odds, 'good');
  // open ground needs no more than a forest; a stronger unit needs fewer; a Scout cannot
  assert.ok(keepArrival({ unit: 0, troops: 100, keepTroops: 100, rough: false }).need <= o.need);
  assert.ok(keepArrival({ unit: 3, troops: 100, keepTroops: 100, rough: true }).need < o.need, 'Pikemen are 22 a troop');
  assert.deepEqual(keepArrival({ unit: 6, troops: 500, keepTroops: 100 }), { odds: 'poor', worst: null, best: null, need: null });
  assert.equal(keepArrival({ unit: 0, troops: 1000, keepTroops: 100 }).odds, 'good');
  assert.deepEqual({ ...CLASH_BPS }, { k: 5_500, walls: 6_667, cityRetaliation: 5_000, terrain: 8_000, rollLow: 9_000, rollHigh: 11_000 }, 'combat.rs / params.rs');
});

test('the keep list says the odds and the troops it takes, in both languages', () => {
  const s = fs();
  s.conquest.hostReach = { key: 'k', host: String(entry().id), ok: true, unreachable: [], rows: [{ p: 4, q: -1, tile: 10, holder: 5, troops: 100, route: { hexes: 13, provinces: [0, 1, 2], secs: 1800 } }] };
  const r = { id: String(entry().id), unit: 0, troops: 100, p: 2, q: 0, tile: 20 };
  const km = K.keepsModel(s, r);
  assert.equal(km.rows[0].odds.odds, 'even');
  const t = K.oddsText(km.rows[0].odds, 0);
  assert.equal(t.word, '五分');
  assert.match(t.line, /^槍兵 [0-9,]+ 以上で十分$/);
  setLang('en');
  const en = K.oddsText(km.rows[0].odds, 0);
  assert.equal(en.word, 'Even');
  assert.match(en.line, /^[0-9,]+ Spearmen or more$/);
});

test('the guide checks the odds before the march, and says what a keep takes while training and forming', () => {
  const weak = fs();
  const o = conquestObjective(weak);
  assert.equal(o.id, 'march');
  assert.match(o.text, /いまの軍勢（槍兵 100）で届く砦（守備兵 100、城壁あり）を攻めると、勝ち目は(五分|低い)です。槍兵 [0-9,]+ ほどにしてから進軍すると/);
  assert.deepEqual(o.go.data, { pop: 'train' }, 'the press is "add troops", not the keep list');
  // a host that would hold the tile: the keep list, as before
  const strong = fs({ entries: [entry({ troops: 1000000 })] });
  assert.deepEqual(conquestObjective(strong).go.data, { pop: 'keeps', host: String(entry().id) });
  assert.match(conquestObjective(strong).text, /勝ち目の欄が「十分」の砦を選ぶと/);
  // one keep worn down elsewhere on the map (out of reach) does not change the advice: the usual keep is the measure
  const worn = fs();
  worn.conquest.keeps.set('9,-9', { p: 9, q: -9, tile: 3, holder: 2, troops: 12, heartland: false, consolidatedUntil: 0, contender: null, progress: 0, requiredBells: 72, asOfBell: 10 });
  worn.conquest.keeps.set('8,-8', { p: 8, q: -8, tile: 3, holder: 3, troops: 100, heartland: false, consolidatedUntil: 0, contender: null, progress: 0, requiredBells: 72, asOfBell: 10 });
  assert.equal(keepTarget(worn).troops, 100);
  assert.deepEqual(conquestObjective(worn).go.data, { pop: 'train' });
  // before the host is formed: what a keep takes (the usual keep of another nation, its tile counted rough)
  const t = keepTarget(fs());
  assert.equal(t.troops, 100);
  assert.equal(t.need, keepArrival({ unit: 0, troops: 100, keepTroops: 100, rough: true }).need);
  const built = fs({ entries: [] }); built.holdings[0].queue = [{ kind: 1, doneAt: 5000n, item: 0 }];
  const train = conquestObjective(built);
  assert.equal(train.id, 'train');
  assert.ok(train.text.includes(`砦を攻めるなら、槍兵 ${t.need.toLocaleString('en-US')} 以上を一つの軍勢にまとめると、守備兵 100 の砦に着いたターンに勝てる見込みです。`), train.text);
  setLang('en');
  assert.match(conquestObjective(built).text, /To attack a keep, gather [0-9,]+ Spearmen or more into one host/);
  const en = conquestObjective(weak);
  assert.doesNotMatch(en.text, CJK);
  assert.match(en.text, /If your host as it stands \(100 Spearmen\) attacks a keep in reach \(100 defenders, behind walls\), the odds are (even|poor)\./);
});

// ------------------------------------------------------------------ 2: a march that was turned back
test('a march turned back on its arrival turn sends the guide back to the march, and says so', () => {
  const k = keepAt(KEEP_4_M1, 10);
  const back = { entry: { arriveBell: 17, host: String(entry().id) }, transit: null, facts: { pipeline: 'resolved' }, dest: { p: 4, q: -1, tile: k.tile } };
  const s = fs({ bell: 19, extra: { marches: [back] } });
  // the keep's record names no contender of the viewer's nation, and the host is home: turned back
  s.conquest.keeps.set('4,-1', { ...k, contender: null, progress: 0 });
  const g = conquestGuide(s);
  assert.equal(g.current, 'march', 'not "hold the keep\'s tile for 72 turns"');
  assert.deepEqual(g.facts.repelled, { p: 4, q: -1, bell: 17 });
  assert.match(conquestObjective(s).text, /^前の進軍は.+の砦のマスに残れず、村へ押し戻されました。/);
  // the same march before its turn is resolved: still on its way, the guide waits on it
  const going = fs({ bell: 15, extra: { marches: [{ ...back, facts: { pipeline: 'pending' } }] } });
  going.conquest.keeps.set('4,-1', { ...k, contender: null, progress: 0 });
  assert.equal(conquestGuide(going).current, 'hold');
  // resolved and the nation's contest runs there: it stayed, the count goes on
  const stayed = fs({ bell: 19, extra: { marches: [back] } });
  stayed.conquest.keeps.set('4,-1', { ...k, contender: 0, progress: 2 });
  assert.equal(conquestGuide(stayed).current, 'hold');
  assert.equal(conquestGuide(stayed).facts.repelled, null);
  setLang('en');
  assert.match(conquestObjective(s).text, /^Your last march could not stay on the tile of the keep at .+ and was pushed back to the village\. /);
});

// ------------------------------------------------------------------ 3: the report says why
test('the report of a turned-back march says why, in its own numbers', () => {
  // the record of the UI check: the host 100 → 87, pushed home; the keep 100 → 88, behind walls
  const rows = [
    { id: 'keep', kind: 'garrison', faction: 5, before: 100, after: 88, posture: 3, tile: 30, fate: null, mine: false, keep: true },
    { id: '1', kind: 'arrival', faction: 0, unit: 0, before: 100, after: 87, posture: 1, tile: 30, fate: 'Bounced', mine: true },
  ];
  const sum = summaryOf(rows);
  assert.equal(sum.result, 'turned');
  const w = fieldWhy(rows, sum);
  assert.deepEqual(w, { tile: 30, retreated: false, own: { troops: 87, strength: 870, unit: 0 }, foe: { faction: 5, camp: false, troops: 88, strength: 880 }, close: true, walls: true, keepLeft: 88 });
  assert.equal(tileDetail(rows)[0].walls, true, 'a keep fights behind walls: the tile detail says so');
  // a host that stayed, and a spectator, get no "why"
  assert.equal(fieldWhy([{ ...rows[0], after: 0, fate: 'Destroyed' }, { ...rows[1], fate: 'Stays' }], summaryOf([{ ...rows[0], after: 0, fate: 'Destroyed' }, { ...rows[1], fate: 'Stays' }])), null);
  assert.equal(fieldWhy(rows.map(r => ({ ...r, mine: false })), summaryOf(rows.map(r => ({ ...r, mine: false })))), null);
  // a host that already stood on the keep's tile and lost it on a later turn of the contest (the live check: 60 → 52
  // against the keep's 60 → 53): the same explanation
  const later = [{ ...rows[0], before: 60, after: 53 }, { id: '2', kind: 'resident', faction: 4, unit: 0, before: 60, after: 52, posture: 0, tile: 30, fate: 'Withdrew', mine: true }];
  assert.equal(summaryOf(later).result, 'turned');
  assert.deepEqual(fieldWhy(later, summaryOf(later)), { tile: 30, retreated: false, own: { troops: 52, strength: 520, unit: 0 }, foe: { faction: 5, camp: false, troops: 53, strength: 530 }, close: true, walls: true, keepLeft: 53 });
  // a retreat order: said as such, no comparison
  const retreated = [rows[0], { ...rows[1], after: 100, fate: 'Retreated' }];
  assert.equal(fieldWhy(retreated, summaryOf(retreated))?.retreated, true);
});
