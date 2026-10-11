// Before the take (2026-10-11): the two turns of a march on a keep.
//
// A march on a keep of 100 defenders is fought over TWO turns on chain. The records are those of run uxs1 on the
// local test chain (test/fixtures/uxs1-keep-two-turns.json: the herald's clash reports of province -4,0 at turns
// 619, 620 and 621; the board track's own player marched 500 there): the keep's troops 100 → 8 in the arrival
// turn's record, 8 → 0 in the next turn's, and no engagement in the third. The page staged only the first; the
// second passed unseen and a viewer could not tell who had won before the hold began.
//
//   people/battle.mjs   a keep's defenders stand in a scene of residents too (the second record has no arrival)
//   fx/battle.mjs       the verdict of that scene says plainly that the keep's defenders are beaten
//   map/ownclash.mjs    such a record is told and its scene given a place in the turn's order, once, from its report
//   fx/stage.mjs        a start of that scene ahead of its cue is called off
//   map/autopan.mjs     "move the map to a clash of mine" is on by default on a conquest season
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decode } from '../../permutation-server/web/frontier/fcodec.mjs';
import { fromBase64 } from '../../permutation-server/web/sdk/bytes.mjs';
import { setLang } from '../../permutation-server/web/lang.mjs';
import { battleScene, battleVerdict, battleLive, battleTime, startBattle, endBattle, PHASE } from '../../permutation-server/web/frontier/people/battle.mjs';
import { verdictTitle } from '../../permutation-server/web/frontier/fx/battle.mjs';
import { installStage } from '../../permutation-server/web/frontier/fx/stage.mjs';
import { createBus } from '../../permutation-server/web/frontier/fx/bus.mjs';
import { ownHost, feedTells, ownPart, ownClashItem, foughtClashes, ownHostIn, engagedIn, noFight, mountOwnClash } from '../../permutation-server/web/frontier/map/ownclash.mjs';
import { autoPanDefault, autoPanReset, AUTOPAN_GIVEN } from '../../permutation-server/web/frontier/map/autopan.mjs';
import { keepFeedOf } from '../../permutation-server/web/frontier/map/keepmount.mjs';
import { loadUi, saveUi, uiKey } from '../../permutation-server/web/frontier/fui.mjs';

const WEB = new URL('../../permutation-server/web/frontier/', import.meta.url);
const src = f => readFileSync(new URL(f, WEB), 'utf8');
const FIX = JSON.parse(readFileSync(new URL('./fixtures/uxs1-keep-two-turns.json', import.meta.url), 'utf8'));
const [P, Q] = FIX.province, HOST = FIX.viewer.host;
const rec = bell => { const r = FIX.records[bell]; return { report: r, inputs: decode('ClashInputs', fromBase64(r.inputs_b64)), before: decode('Province', fromBase64(r.province_before_b64)) }; };
/** The Province after turn `bell`: the next record's province before its own turn. */
const after = bell => (FIX.records[bell + 1] ? rec(bell + 1).before : null);
const sceneOf = bell => { const r = rec(bell); return battleScene({ p: P, q: Q, bell, inputs: r.inputs, before: r.before, after: after(bell) }); };
const pick = s => ({ id: s.id, faction: s.faction, before: s.before, after: s.after, fate: s.fate, kind: s.kind, keep: !!s.keep });

/** The page's state as it stood when the second record came: the viewer of the fixture, the keep's province as it was after turn `bell`. */
function viewer({ bell = 620, marches = [], holdings = [FIX.viewer.holding], autoPan = true, battleFx = 'normal', chronicle = [] } = {}) {
  return { mode: 'play', citizen: { faction: FIX.viewer.faction }, holdings, marches, nowBell: bell + 2, chronicle, feed: [],
    ui: { autoPan, battleFx }, provinces: new Map([[`${P},${Q}`, { province: after(bell) }]]) };
}
const clashRec = (bell, engagements = 1, p = P, q = Q) => ({ seq: `${p}${q}${bell}`, record: { name: 'CLASH', p, q, bell, engagements } });
const tick = () => new Promise(r => setTimeout(r, 0));

test('the two real records: the arrival turn leaves 8 of the keep\'s 100 defenders, the next turn none, and each is a scene of its own', () => {
  // the arrival (turn 619): the host of 500 against the keep's 100; both still stand
  const a = sceneOf(619);
  assert.equal(a.residents, undefined);
  assert.deepEqual(a.tiles.map(t => [t.idx, t.attackers.map(pick), t.defenders.map(pick)]), [[60,
    [{ id: HOST, faction: 2, before: 500, after: 488, fate: 'Stays', kind: 'arrival', keep: false }],
    [{ id: 'keep', faction: 3, before: 100, after: 8, fate: 'Stays', kind: 'garrison', keep: true }]]]);
  assert.equal(battleVerdict(a).kind, 'standoff');
  // the next turn (620): no arrival in the record; the host stood there already, and the eight that were left fall
  assert.equal(rec(620).inputs.arrivals.filter(x => x.present).length, 0);
  assert.deepEqual(FIX.records[620].decoded.fighters.map(f => [f.id, f.arrival, f.engaged]), [[HOST, false, true]]);
  const b = sceneOf(620);
  assert.equal(b.residents, true);
  assert.deepEqual(b.tiles.map(t => [t.idx, t.attackers.map(pick), t.defenders.map(pick)]), [[60,
    [{ id: HOST, faction: 2, before: 488, after: 487, fate: 'Stays', kind: 'resident', keep: false }],
    [{ id: 'keep', faction: 3, before: 8, after: 0, fate: 'Destroyed', kind: 'garrison', keep: true }]]]);
  assert.deepEqual(battleVerdict(b), { kind: 'taken', winner: 2, side: 'attackers', camp: false, tile: 60 });
  // a scene of residents is the short one: nobody comes out of the mist
  const play = startBattle(b, 100, 1);
  assert.equal(battleTime(play, 100), PHASE.deploy);
  assert.equal(battleLive(play, 100 + (PHASE.end - PHASE.deploy) - 0.01), true);
  assert.equal(battleLive(play, 100 + (PHASE.end - PHASE.deploy) + 0.01), false);
  // the third record (621) has no engagement: the keep has no troops left, and there is no scene
  assert.equal(FIX.records[621].decoded.engagements, 0);
  assert.equal(battleScene({ p: P, q: Q, bell: 621, inputs: rec(621).inputs, before: rec(621).before, after: rec(621).before }), null);
  // a replay of the ARRIVAL's clash once later turns are resolved (見る on its notice, the page's province is the one of
  // now): what was left of the keep's defenders is read only from the province right after that turn. It showed all
  // 100 fallen in the arrival's turn and "Victory"; now what was left is not known and nothing more is said
  const replay = battleScene({ p: P, q: Q, bell: 619, inputs: rec(619).inputs, before: rec(619).before, after: rec(621).before });
  assert.deepEqual(replay.tiles[0].defenders.map(pick), [{ id: 'keep', faction: 3, before: 100, after: null, fate: null, kind: 'garrison', keep: true }]);
  assert.deepEqual([battleVerdict(replay).kind, replay.tiles[0].attackers.map(pick)[0].after], ['none', 488]);
  // without the province after the turn the second scene cannot be told (what was lost is not known): none
  assert.equal(battleScene({ p: P, q: Q, bell: 620, inputs: rec(620).inputs, before: rec(620).before, after: null }), null);
});

test('the second scene ends in a verdict that says the keep\'s defenders are beaten and who holds the tile; the first says nothing more than before', () => {
  setLang('en');
  try {
    assert.equal(verdictTitle(sceneOf(619), 2), null, 'both still stand: no title, as before');
    const t = verdictTitle(sceneOf(620), 2);
    assert.deepEqual([t.title, t.sub, t.key, t.won, t.tone], ['Victory', 'The keep\'s defenders are beaten. Cinder\'s host now holds the keep\'s tile', 'won', true, 'win']);
    // the nation that lost its defenders, and a nation that only watches: the words they had
    assert.deepEqual([verdictTitle(sceneOf(620), 3).key, verdictTitle(sceneOf(620), 3).sub], ['fell', 'Cinder vs Dunmar']);
    assert.deepEqual([verdictTitle(sceneOf(620), 0).title, verdictTitle(sceneOf(620), 0).sub], ['Cinder wins', 'Cinder vs Dunmar']);
  } finally { setLang('ja'); }
});

test('whose clash it is: the viewer\'s own host, where it stood, in a province the page\'s own notifications do not tell', () => {
  const fs = viewer();
  assert.equal(ownHost(fs, HOST), true);
  assert.equal(ownHost(fs, 'keep'), false);
  assert.equal(ownHost({ holdings: [{ p: 0, q: 3, site: 2 }] }, HOST), false, 'another player\'s host');
  // the arrival turn is the march's own line (hud/feed.mjs `rs:`), a province of the viewer's villages is `cl:`
  const march = { dest: { p: P, q: Q, tile: 60 }, entry: { arriveBell: 619 } };
  assert.equal(feedTells(viewer({ marches: [march] }), P, Q, 619), true);
  assert.equal(feedTells(viewer({ marches: [march] }), P, Q, 620), false, 'the next turn is no march\'s arrival');
  assert.equal(feedTells(fs, -2, 1, 620), true);
  // the host as an ARRIVAL is left to its march's line, also when the march is no longer in the page's list
  assert.equal(ownPart(fs, sceneOf(619)), null);
  const part = ownPart(fs, sceneOf(620));
  assert.deepEqual([part.tile, part.attacking, part.me.map(s => s.id), part.keep.before, part.keep.after], [60, true, [HOST], 8, 0]);
  assert.equal(ownPart({ holdings: [{ p: 0, q: 3, site: 2 }] }, sceneOf(620)), null, 'another player\'s host: not the viewer\'s clash');
  assert.equal(ownHostIn(fs, P, Q), true);
  assert.equal(ownHostIn(fs, 0, 0), false);
  assert.deepEqual(foughtClashes([clashRec(619), clashRec(620), clashRec(621, 0), { record: { name: 'DEPART' } }]), [{ p: P, q: Q, bell: 619 }, { p: P, q: Q, bell: 620 }]);
});

test('the notice is that record\'s own: its id, its place, its turn, its 見る and 報告, and what its rows say', () => {
  setLang('en');
  try {
    const r = rec(620), item = ownClashItem(viewer(), { p: P, q: Q, bell: 620, inputs: r.inputs, before: r.before, after: after(620) });
    assert.deepEqual(item, { id: `cl:${P},${Q},620`, kind: 'battle', bell: 622, p: P, q: Q, tile: 60, battle: { p: P, q: Q, bell: 620 },
      text: 'Your host beat the last defenders of the keep of province -4,0 and now holds the keep\'s tile (turn 620)', residents: true });
    // the arrival's record and the record without an engagement make no notice here
    assert.equal(ownClashItem(viewer(), { p: P, q: Q, bell: 619, inputs: rec(619).inputs, before: rec(619).before, after: after(619) }), null);
    assert.equal(ownClashItem(viewer(), { p: P, q: Q, bell: 621, inputs: rec(621).inputs, before: rec(621).before, after: rec(621).before }), null);
  } finally { setLang('ja'); }
});

test('the second record is told once and staged in the turn\'s order, from its own report; nothing for a record without an engagement', async () => {
  const bus = createBus(), feeds = [], asked = [];
  bus.on('feed', p => feeds.push(p));
  // the arrival's march is still in the page's list when the first record comes, as it is on a real turn
  const fs = viewer({ chronicle: [clashRec(618, 1, 0, 3)], marches: [{ dest: { p: P, q: Q, tile: 60 }, entry: { arriveBell: 619 } }] });
  let draws = 0;
  const own = mountOwnClash({ state: () => fs, bus, clash: async (p, q, bell) => { asked.push([p, q, bell]); const r = rec(bell); return { ok: true, report: r.report, inputs: r.inputs }; }, redraw: () => { draws++; }, later: fn => setTimeout(fn, 0) });
  own.sync();                                       // the first reading of the log is not news
  fs.chronicle = [...fs.chronicle, clashRec(619)];  // the arrival: the march's own line tells it
  own.sync(); await tick();
  assert.deepEqual([asked, feeds], [[], []]);
  fs.marches = [];
  fs.chronicle = [...fs.chronicle, clashRec(620), clashRec(620, 1, 0, 3), clashRec(621, 0)];   // the next turn; another province's clash; a turn with no engagement
  own.sync(); await tick(); await tick();
  assert.deepEqual(asked, [[P, Q, 620]], 'only the record of the province the viewer\'s host stands in, and only one with an engagement');
  assert.equal(feeds.length, 1);
  const x = feeds[0].fresh[0];
  assert.deepEqual([feeds[0].turn, x.id, x.kind, x.battle, x.tile, x.faction, x.focus], [622, `cl:${P},${Q},620`, 'battle', { p: P, q: Q, bell: 620 }, 60, 2, true]);
  assert.ok(Math.abs(x.scene - (PHASE.end - PHASE.deploy)) < 1e-9, 'the short scene\'s own length');
  assert.deepEqual(fs.feed.map(f => [f.id, f.battle.bell]), [[`cl:${P},${Q},620`, 620]], 'in the notifications, with the record\'s own turn for 見る and 報告');
  assert.equal(draws, 1);
  // the same log read again, and the same record seen again: nothing twice
  own.sync(); fs.chronicle = [...fs.chronicle]; own.sync(); await tick();
  assert.equal(feeds.length, 1);
  own.off();
});

test('"move the map there" off, or battles switched off: the notice still comes; the scene follows the player\'s settings', async () => {
  for (const [ui, want] of [[{ autoPan: false, battleFx: 'normal' }, { focus: false, scene: true }], [{ autoPan: true, battleFx: 'off' }, { focus: undefined, scene: false }], [{ autoPan: true, battleFx: 'fast' }, { focus: true, scene: true }]]) {
    const bus = createBus(), feeds = [];
    bus.on('feed', p => feeds.push(p));
    const fs = viewer({ chronicle: [clashRec(619)], ...ui });
    const own = mountOwnClash({ state: () => fs, bus, clash: async (p, q, bell) => ({ ok: true, report: rec(bell).report, inputs: rec(bell).inputs }), redraw() {}, later: fn => setTimeout(fn, 0) });
    own.sync(); fs.chronicle = [...fs.chronicle, clashRec(620)]; own.sync(); await tick(); await tick();
    const x = feeds[0].fresh[0];
    assert.equal(x.focus, want.focus, JSON.stringify(ui));
    assert.equal(x.scene > 0, want.scene, JSON.stringify(ui));
    if (ui.battleFx === 'fast') assert.ok(Math.abs(x.scene - (PHASE.end - PHASE.deploy) / 2.5) < 1e-9);
    own.off();
  }
});

test('the report is asked again until the page has read the province after that turn; a record that is not the viewer\'s is dropped', async () => {
  const bus = createBus(), feeds = [];
  bus.on('feed', p => feeds.push(p));
  const fs = viewer({ chronicle: [clashRec(619)] });
  const now = fs.provinces.get(`${P},${Q}`);
  fs.provinces.set(`${P},${Q}`, { province: after(619) });   // the page still has the province as it was before turn 620
  let asks = 0;
  const waits = [];
  const own = mountOwnClash({ state: () => fs, bus, clash: async (p, q, bell) => { asks++; return { ok: true, report: rec(bell).report, inputs: rec(bell).inputs }; }, redraw() {}, later: fn => waits.push(fn) });
  own.sync(); fs.chronicle = [...fs.chronicle, clashRec(620)]; own.sync(); await tick();
  assert.deepEqual([asks, feeds.length, waits.length], [1, 0, 1], 'not told from a province that is not yet the one after the turn');
  fs.provinces.set(`${P},${Q}`, now);
  waits.shift()(); await tick(); await tick();
  assert.deepEqual([asks, feeds.length], [2, 1]);
  own.off();
  // another player's host in that record: read, and nothing told
  const bus2 = createBus(), feeds2 = [];
  bus2.on('feed', p => feeds2.push(p));
  const other = viewer({ chronicle: [clashRec(619)], holdings: [{ p: P, q: Q, site: 3, tile: 5 }] });
  other.holdings = [{ p: 0, q: 3, site: 2, tile: 9 }];
  const own2 = mountOwnClash({ state: () => other, bus: bus2, clash: async (p, q, bell) => ({ ok: true, report: rec(bell).report, inputs: rec(bell).inputs }), redraw() {}, later() {} });
  own2.sync(); other.chronicle = [...other.chronicle, clashRec(620)]; own2.sync(); await tick(); await tick();
  assert.equal(feeds2.length, 0);
  own2.off();
  // a host that fell: the page has read the province after that turn and no roster has the host any more, but it was
  // seen standing there at the poll before, and its last clash is asked for all the same
  const fell = viewer({ chronicle: [clashRec(619)] });
  let asks3 = 0;
  const own3 = mountOwnClash({ state: () => fell, bus: createBus(), clash: async () => { asks3++; return null; }, redraw() {}, later() {} });
  own3.sync();
  const gone = after(620); gone.entries.forEach(e => { e.state = 0; });
  fell.provinces.set(`${P},${Q}`, { province: gone });
  fell.chronicle = [...fell.chronicle, clashRec(620), clashRec(620, 1, 5, 5)]; own3.sync(); await tick();
  assert.equal(asks3, 1, 'the province its host stood in, and not a province it never stood in');
  own3.off();
});

test('one start: the scene begun ahead of its cue, without the camera, is called off and takes its place in the turn\'s order', async () => {
  const bus = createBus(), feeds = [];
  bus.on('feed', p => feeds.push(p));
  const fs = viewer({ chronicle: [clashRec(619)] });
  let t = 100;
  const own = mountOwnClash({ state: () => fs, bus, now: () => t, clash: async (p, q, bell) => ({ ok: true, report: rec(bell).report, inputs: rec(bell).inputs }), redraw() {}, later: fn => setTimeout(fn, 0) });
  own.sync();
  const sc = sceneOf(620);
  const ask = (o = {}) => { const a = { play: startBattle(sc, 0, 1), focus: false, hold: false, ...o }; bus.emit('battle:ask', a); return a.hold; };
  // the page starts the clash of a loaded province by itself (app.mjs autoBattles), before the log's record is read
  assert.equal(ask(), true);
  await tick(); await tick();
  assert.equal(feeds.length, 1, 'and that start is what gives the scene its place');
  fs.chronicle = [...fs.chronicle, clashRec(620)]; own.sync(); await tick();
  assert.equal(feeds.length, 1, 'the log\'s record, read afterwards, does not tell it again');
  // its cue comes. The option sends the camera, so the cue's own start comes WITH it and is never called off; the
  // page's own start without the camera, 0.4 s later on the real chain, is called off although the cue has just come
  bus.emit('turn:scene', { id: `cl:${P},${Q},620`, battle: { p: P, q: Q, bell: 620 } });
  assert.equal(ask({ focus: true }), false);
  assert.equal(ask(), true);
  // long after, the same; one the player asked for (見る flies there) never is
  t += 60;
  assert.equal(ask(), true);
  assert.equal(ask({ focus: true }), false);
  assert.equal(feeds.length, 1);
  // "move the map there" switched off: the cue's own start has no camera, and that ONE start after the cue is let through
  {
    const busB = createBus(), fsB = viewer({ chronicle: [clashRec(619)], autoPan: false });
    const ownB = mountOwnClash({ state: () => fsB, bus: busB, now: () => t, clash: async (p, q, bell) => ({ ok: true, report: rec(bell).report, inputs: rec(bell).inputs }), redraw() {}, later: fn => setTimeout(fn, 0) });
    const askB = () => { const a = { play: startBattle(sc, 0, 1), focus: false, hold: false }; busB.emit('battle:ask', a); return a.hold; };
    ownB.sync();
    assert.equal(askB(), true, 'ahead of its cue: called off');
    await tick(); await tick();
    busB.emit('turn:scene', { id: `cl:${P},${Q},620`, battle: { p: P, q: Q, bell: 620 } });
    assert.deepEqual([askB(), askB()], [false, true], 'the cue\'s own start, once');
    ownB.off();
  }
  // the arrival's scene, a scene of other players' hosts, and a province of the viewer's villages are not this module's
  assert.equal(ask({ play: startBattle(sceneOf(619), 0, 1) }), false);
  const others = viewer(); others.holdings = [{ p: 0, q: 3, site: 2, tile: 9 }];
  const own2 = mountOwnClash({ state: () => others, bus: createBus(), clash: async () => null, redraw() {}, later() {} });
  own.off();
  const bus3 = createBus(), own3 = mountOwnClash({ state: () => others, bus: bus3, clash: async () => null, redraw() {}, later() {} });
  const a3 = { play: startBattle(sc, 0, 1), focus: false, hold: false }; bus3.emit('battle:ask', a3);
  assert.equal(a3.hold, false);
  own2.off(); own3.off();
});

test('no scene and no notice without an engagement: an ally that arrives where the viewer\'s host holds, a turn of standing', async () => {
  // the record's own word: the log's CLASH record where the page has read it, else the report's count; null while neither says
  assert.equal(engagedIn([clashRec(620)], { p: P, q: Q, bell: 620 }), true);
  assert.equal(engagedIn([clashRec(620, 0)], { p: P, q: Q, bell: 620 }, FIX.records[620]), false, 'the log\'s record before the report\'s count');
  assert.deepEqual([engagedIn([], { p: P, q: Q, bell: 620 }, FIX.records[620]), engagedIn([], { p: P, q: Q, bell: 621 }, FIX.records[621]), engagedIn([], { p: P, q: Q, bell: 620 }, {})], [true, false, null]);
  // an ally's host arrives on the keep's tile the viewer's host holds (the film's second wallet): the page's scene of
  // that turn has the two on opposite sides, and it is no clash of the viewer's
  const ally = { p: P, q: Q, bell: 623, tiles: [{ idx: 60, attackers: [{ id: '193518341455872', faction: 2, before: 300, after: 300, fate: 'Stays', kind: 'arrival' }], defenders: [{ id: HOST, faction: 2, before: 487, after: 487, fate: 'Stays', kind: 'resident' }] }] };
  assert.equal(ownPart(viewer(), ally), null);
  assert.deepEqual([noFight(ally), noFight(sceneOf(619)), noFight(sceneOf(620)), noFight({ tiles: [{ idx: 3, attackers: [{ id: 'x', faction: 1 }], defenders: [] }] })], [true, false, false, false]);
  {
    // the page's own start of that turn's "clash" (app.mjs autoBattles, without the camera) is called off: on the page of
    // the player who holds the keep, and on any other page of a conquest season; one the player asked for is not
    const busA = createBus(), ownA = mountOwnClash({ state: () => viewer(), bus: busA, clash: async () => null, redraw() {}, later() {} });
    const askA = (scene, focus = false) => { const x = { play: startBattle(scene, 0, 1), focus, hold: false }; busA.emit('battle:ask', x); return x.hold; };
    assert.deepEqual([askA(ally), askA(ally, true), askA({ p: 5, q: 5, bell: 9, tiles: [{ idx: 3, attackers: [{ id: 'x', faction: 1, kind: 'arrival' }], defenders: [] }] })], [true, false, false]);
    ownA.off();
  }
  // a record the log says had no engagement: the page's own start of its scene is still called off, and nothing is told
  const bus = createBus(), feeds = [];
  bus.on('feed', p => feeds.push(p));
  const fs = viewer({ chronicle: [clashRec(619), clashRec(620, 0)] });
  const own = mountOwnClash({ state: () => fs, bus, clash: async (p, q, bell) => ({ ok: true, report: rec(bell).report, inputs: rec(bell).inputs }), redraw() {}, later: fn => setTimeout(fn, 0) });
  own.sync();
  const a = { play: startBattle(sceneOf(620), 0, 1), focus: false, hold: false }; bus.emit('battle:ask', a);
  await tick(); await tick();
  assert.deepEqual([a.hold, feeds.length], [true, 0]);
  own.off();
});

test('only on a conquest season: elsewhere nothing is told, asked for or called off', async () => {
  const bus = createBus(), feeds = [];
  bus.on('feed', p => feeds.push(p));
  const fs = viewer({ chronicle: [clashRec(619)] });
  let asks = 0;
  const own = mountOwnClash({ state: () => fs, enabled: s => keepFeedOf(s).enabled, bus, clash: async () => { asks++; return null; }, redraw() {}, later() {} });
  own.sync(); fs.chronicle = [...fs.chronicle, clashRec(620)]; own.sync(); await tick();
  const a = { play: startBattle(sceneOf(620), 0, 1), focus: false, hold: false }; bus.emit('battle:ask', a);
  assert.deepEqual([asks, feeds.length, a.hold], [0, 0, false], 'the basic game');
  // the same page on a conquest season
  fs.season = { programVersion: 3, layoutVersion: 2, conquestParams: { keepBells: 72 } };
  assert.equal(keepFeedOf(fs).enabled, true);
  bus.emit('battle:ask', a);
  assert.equal(a.hold, true);
  own.off();
  const mount = src('map/keepmount.mjs');
  assert.match(mount, /const own = mountOwnClash\(\{ state, enabled: fs => keepFeedOf\(fs\)\.enabled \}\);/);
  assert.match(mount, /if \(feed\.enabled\) \{ try \{ autoPanDefault\(fs\); own\.sync\(\); \}/);
});

test('the stage asks before it stages, and a start that is called off is over at once', () => {
  const play = startBattle(sceneOf(620), 5, 1);
  assert.equal(battleLive(play, 5.1), true);
  assert.equal(endBattle(play), play);
  assert.deepEqual([play.off, battleLive(play, 5.1), battleLive(play, 1e9)], [true, false, false]);
  assert.equal(endBattle(null), null);
  // on the stage: nothing is added for a start somebody holds
  const bus = createBus(), added = [];
  const fx = { mounted: true, clock: { now: () => 10 }, map: { project: () => null }, play: (n) => { added.push(n); return []; }, add: (e) => { added.push(e?.name); return null; }, later() { return this; }, sound: () => false, shake: () => false,
    piece: (n) => { added.push(n); return null; }, drop() {}, trim() {}, onStage: () => true, view: () => ({ x: 0, y: 0, zoom: 1 }) };
  let stage = null;
  try { stage = installStage(fx, { bus }); } catch { stage = null; }
  if (stage) {
    const asks = [];
    bus.on('battle:ask', a => { asks.push([a.play.scene.bell, a.focus]); a.hold = true; });
    const p2 = startBattle(sceneOf(620), 5, 1);
    bus.emit('battle', { play: p2, focus: false });
    assert.deepEqual([asks, p2.off, added], [[[620, false]], true, []]);
    if (typeof stage === 'function') stage(); else stage.off?.();
  }
  const s = src('fx/stage.mjs');
  assert.match(s, /const ask = \{ play: p\.play, focus: !!p\.focus, hold: false \};\s+bus\.emit\('battle:ask', ask\);\s+if \(ask\.hold\) \{ endBattle\(p\.play\); return; \}\s+const h = stageBattle\(fx, p\.play, p\)/);
  assert.match(src('fx/sheetfx.mjs'), /Promise\.resolve\(\)\.then\(\(\) => \{ if \(p\.play\.off\) return;/, 'the art pack\'s sprites of a scene are not played for it either');
});

test('"move the map to a clash of mine": on by default on a conquest season, given once, and the player\'s own from then on', () => {
  const mem = new Map(), storage = { get: k => mem.get(k) ?? null, set: (k, v) => { mem.set(k, v); return true; } };
  const sc = { cluster: 'localnet', programId: 'PROG', seasonId: '98' }, key = uiKey(sc);
  let draws = 0;
  const opt = { storage, scope: () => sc, redraw: () => { draws++; } };
  autoPanReset();
  // nothing is loaded yet, or the season is not known yet: later
  assert.equal(autoPanDefault({}, opt), null);
  assert.equal(autoPanDefault({ ui: loadUi(storage, key) }, { ...opt, scope: () => null }), null);
  // a device that has other preferences saved (the stored record carries autoPan: false although nobody chose it)
  saveUi(storage, key, { tab: 'hosts' });
  const fs = { ui: loadUi(storage, key) };
  assert.equal(fs.ui.autoPan, false);
  assert.equal(autoPanDefault(fs, opt), 'given');
  assert.deepEqual([fs.ui.autoPan, fs.ui.tab, loadUi(storage, key).autoPan, mem.get(key + AUTOPAN_GIVEN), draws], [true, 'hosts', true, '1', 1]);
  assert.equal(autoPanDefault(fs, opt), null, 'settled: one comparison a frame');
  // the player switches it off (app.mjs `autopan`: the same stored field): it stays off, on this page and after a reload
  fs.ui = saveUi(storage, key, { autoPan: false });
  assert.equal(autoPanDefault(fs, opt), null);
  autoPanReset();
  const again = { ui: loadUi(storage, key) };
  assert.equal(autoPanDefault(again, opt), 'kept');
  assert.equal(again.ui.autoPan, false);
  // another season on this device is asked once of its own
  autoPanReset();
  const sc2 = { ...sc, seasonId: '99' }, fs2 = { ui: loadUi(storage, uiKey(sc2)) };
  assert.equal(autoPanDefault(fs2, { ...opt, scope: () => sc2 }), 'given');
  assert.equal(fs2.ui.autoPan, true);
  autoPanReset();
  // the page reads the option where it always did, and the default is asked for only with the keeps (a conquest season)
  const app = src('app.mjs');
  assert.match(app, /data-act="autopan" \$\{FS\.ui\?\.autoPan \? 'checked' : ''\}/);
  assert.match(app, /focus: !!FS\.ui\?\.autoPan/);
  assert.match(src('fui.mjs'), /autoPan: false/, 'the stored default is unchanged: the basic game keeps it off');
});
