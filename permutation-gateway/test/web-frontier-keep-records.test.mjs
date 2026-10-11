// A keep changing hands, in the records the player reads: the notification,
// the chronicle's lines, the keep panel's history, the clash report's line
// and the territory lens's province wash. Fixtures follow the herald's
// /h/conquest/{day}.json and /h/keep/{P},{Q}.json of a finished world
// (province -3,4: contested from bell 157, taken at bell 228).
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../../permutation-server/web/frontier/controller.mjs';
import { createHerald, parseConquestDay } from '../../permutation-server/web/frontier/herald.mjs';
import { FS } from '../../permutation-server/web/frontier/fstate.mjs';
import { mergeKeepEvents, keepEventSide } from '../../permutation-server/web/frontier/fconquest.mjs';
import * as FEED from '../../permutation-server/web/frontier/hud/feed.mjs';
import { chronicleRows, keepLineOf, render as renderChronicle } from '../../permutation-server/web/frontier/screens/chronicle.mjs';
import { keepHistory, renderKeep } from '../../permutation-server/web/frontier/screens/conquest.mjs';
import { keepStake, recordRows, clashesFrom, render as renderReport } from '../../permutation-server/web/frontier/screens/report.mjs';
import { battleScene, keepDefenders } from '../../permutation-server/web/frontier/people/battle.mjs';
import { render as renderInspect } from '../../permutation-server/web/frontier/hud/inspect.mjs';
import { readFileSync } from 'node:fs';
import { paintControlWash } from '../../permutation-server/web/frontier/map/sprites.mjs';
import { FACTION_COLORS, factionName } from '../../permutation-server/web/frontier/fi18n.mjs';
import { setLang } from '../../permutation-server/web/lang.mjs';

afterEach(() => setLang('ja'));

const SIG = '5rrLeMCbGbdZq5Lkzzp8RzppFqSWVECwPfXduRATYf8bXDuw3e5HQC2ehyPcyygmCZhSY33wy76m5o2fEM4M7xff';
const ev = (seq, bell, kind, from, to, detail = {}) => ({ seq: String(seq), bell, sig: SIG, kind, p: -3, q: 4, site: null, march: null, from, to, citizens: [], detail });
const DAY1 = { v: 1, day: 1, events: [
  ev(10162, 157, 'keep_contest', 1, 2, { progress: 1 }),
  ev(15263, 228, 'keep_taken', 1, 2, { donor: '446406015844352', troops: 494 }),
  ev(15263, 228, 'province_control', 1, 2),
] };
const KEEP = { v: 1, p: -3, q: 4, tile: 26, holder: 2, since: 229, troops: 494, gen: 1, heartland: false,
  holders: [{ holder: 1, since: 0 }, { holder: 2, since: 229 }],
  contests: [{ contender: 2, from: 157, to: 228, outcome: 'taken', progress: 72 }],
  captures: [{ bell: 228, from: 1, to: 2, troops: 494, donor: '446406015844352', seq: '15263', sig: SIG }] };
const events = () => mergeKeepEvents([], parseConquestDay(DAY1).events);
const [N1, N2] = [factionName(1), factionName(2)];

test('keep events of a conquest day: the contest and the capture, once each, with the viewer’s side', () => {
  const list = events();
  assert.deepEqual(list.map(e => [e.kind, e.bell, e.from, e.to, e.troops]), [['keep_contest', 157, 1, 2, null], ['keep_taken', 228, 1, 2, 494]]);
  assert.equal(mergeKeepEvents(list, parseConquestDay(DAY1).events).length, 2, 'a day read again adds nothing');
  assert.deepEqual(list.map(e => keepEventSide(e, 2)), ['attack', 'gain']);
  assert.deepEqual(list.map(e => keepEventSide(e, 1)), ['defend', 'loss']);
  assert.deepEqual(list.map(e => keepEventSide(e, 0)), [null, null]);
  assert.equal(keepEventSide({ kind: 'keep_broken', from: 2, to: 1 }, 1), 'defend', 'a broken contest is from the contender to the holder');
});

test('a capture is a notification with “go there”, marked as the viewer’s nation’s gain or loss; the past is not news', () => {
  const at = (faction, bell, evs) => FEED.snapshot({ nowBell: bell, citizen: { faction }, conquest: evs === undefined ? null : { events: evs } }, 0);
  const [contest, taken] = events();
  assert.deepEqual(FEED.diffFeed(at(0, 229), at(0, 229, [contest, taken])), [], 'events first read with the page are the record’s, not news');
  // another nation's viewer: the capture only
  const watch = FEED.diffFeed(at(0, 229, [contest]), at(0, 229, [contest, taken]));
  assert.deepEqual(watch.map(x => [x.kind, x.p, x.q, x.side, x.text]), [['keep', -3, 4, null, `州 -3,4 の砦を ${N2} が ${N1} から奪った（第228ターン）`]]);
  // the two nations: the contest's start and the result
  const won = FEED.diffFeed(at(2, 158, []), at(2, 158, [contest]));
  assert.deepEqual(won.map(x => [x.side, x.text]), [['attack', `州 -3,4 の砦を ${N2} が攻めはじめた（第157ターン）`]]);
  assert.deepEqual(FEED.diffFeed(at(0, 158, []), at(0, 158, [contest])), [], 'a contest between other nations is not a notice');
  const lost = FEED.diffFeed(at(1, 229, [contest]), at(1, 229, [contest, taken]));
  assert.equal(lost[0].side, 'loss');
  assert.deepEqual(FEED.diffFeed(at(1, 400, [contest]), at(1, 400, [contest, taken])), [], 'a day read late is not news');
  const feed = FEED.pushFeed([], [...won, ...lost], 1000);
  const toasts = String(FEED.renderToasts(feed, { now: 1000 }));
  assert.match(toasts, /toast-keep/); assert.match(toasts, /data-act="feed-go"/);
  assert.match(toasts, /あなたの国が失った/); assert.match(toasts, /あなたの国が攻めている/);
  assert.match(String(FEED.renderCentre(feed, 'battle')), /から奪った（第228ターン）/);
  assert.doesNotMatch(String(FEED.renderCentre(feed, 'holding')), /砦/);
  assert.match(FEED.bellSummary(feed, 229).text, /砦 1/);
  setLang('en');
  assert.equal(FEED.diffFeed(at(0, 229, [contest]), at(0, 229, [contest, taken]))[0].text, 'Cinder took the keep of province -3,4 from Borealis (turn 228)');
});

test('the chronicle lists a contest’s start and the capture by bell, the viewer’s nation’s marked', () => {
  const records = [150, 200, 228, 300].map((bell, i) => ({ seq: String(i + 1), record: { name: 'CLASH', p: 1, q: 1, bell } }));
  const rows = chronicleRows(records, () => false, 60, null, events(), 2);
  assert.deepEqual(rows.map(r => [r.bell, r.mine, r.keep ?? null]), [[300, false, null], [228, true, 'keep_taken'], [228, false, null], [200, false, null], [157, true, 'keep_contest'], [150, false, null]]);
  assert.equal(rows[1].text, `州 -3,4 の砦が奪われた（${N1} → ${N2}）`);
  assert.equal(rows[4].text, `州 -3,4 の砦の争奪が始まった（${N1} → ${N2}）`);
  assert.equal(keepLineOf({ kind: 'keep_broken', p: 0, q: 0, from: 2, to: 1 }), null);
  assert.deepEqual(chronicleRows(records, () => false, 60, null, events(), 0).filter(r => r.mine), [], 'another nation’s keeps are not the viewer’s lines');
  assert.equal(chronicleRows(records, () => false, 1, null, events(), null).filter(r => r.keep).length, 2, 'keeps stay listed beyond the record limit');
  assert.equal(chronicleRows(records).length, 4, 'without conquest events the chronicle is as before');
  const out = String(renderChronicle({ chronicle: [], conquest: { events: events() }, citizen: { faction: 1 } }));
  assert.match(out, /ターン 228<\/h4>\s*<ol class="chron-lines"><li class="mine"><span class="chron-text">州 -3,4 の砦が奪われた/, 'under its turn\'s stamp, marked as the viewer\'s nation\'s');
  assert.match(out, /data-act="goto" data-p="-3" data-q="4"/, 'a keep line goes to its province');
});

test('the keep panel shows the previous holder and the history with turn numbers', () => {
  const h = keepHistory(KEEP);
  assert.deepEqual(h.rows.map(r => [r.bell, r.kind, r.holder, r.from ?? null, r.troops ?? null]), [[0, 'held', 1, null, null], [228, 'taken', 2, 1, 494], [229, 'held', 2, null, null]]);
  assert.deepEqual([h.last.bell, h.last.from, h.last.holder], [228, 1, 2]);
  assert.equal(keepHistory({ asOf: 230 }), null, 'a province without a keep record');
  assert.equal(keepHistory({ ...KEEP, holders: [{ holder: 1, since: 0 }], captures: [] }).last, null);
  const fs = { mode: 'spectate', season: { programVersion: 3, endBell: 432, bellSecs: 600 }, citizen: null, nowBell: 230, conquest: { history: new Map([['-3,4', { ...KEEP, asOf: 230 }]]) } };
  const keep = { p: -3, q: 4, tile: 26, holder: 2, troops: 494, heartland: false, consolidatedUntil: 240, contender: 255, progress: 0, requiredBells: 72, asOfBell: 229 };
  const out = String(renderKeep(fs, keep));
  assert.match(out, new RegExp(`<dt>支配国</dt><dd>${N2}</dd>`));
  assert.match(out, new RegExp(`<dt>前の支配国</dt><dd>${N1} · 第228ターンに交代</dd>`));
  assert.match(out, /砦の履歴/);
  assert.match(out, new RegExp(`第0ターンから：${N1}が保持`));
  assert.match(out, new RegExp(`第228ターン：${N2}が${N1}から奪取 <span class="muted">守備兵 494</span>`));
  assert.match(out, new RegExp(`第229ターンから：${N2}が保持`));
  const bare = String(renderKeep({ ...fs, conquest: {} }, keep));
  assert.doesNotMatch(bare, /砦の履歴|前の支配国/);
});

test('a clash on the keep tile says what it was for; the verification section is unchanged', () => {
  const rows = [{ tile: 26 }, { tile: 3 }];
  assert.equal(keepStake({ p: -3, q: 4, bell: 200 }, rows), null, 'no keep record');
  assert.equal(keepStake({ p: -3, q: 4, bell: 200, keep: KEEP }, [{ tile: 3 }]), null, 'not on the keep tile');
  const after = keepStake({ p: -3, q: 4, bell: 200, keep: KEEP }, rows);
  assert.deepEqual([after.holder, after.contender, after.taken.bell], [2, null, 228]);
  assert.equal(keepStake({ p: -3, q: 4, bell: 300, keep: KEEP }, rows).taken, null, 'a later clash is not that contest’s');
  const live = { holder: 1, contender: 2, progress: 44, requiredBells: 72 };
  const during = keepStake({ p: -3, q: 4, bell: 200, keep: { ...KEEP, holder: 1, contests: [{ contender: 2, from: 157, to: null, outcome: 'running', progress: 44 }], captures: [] } }, rows, live);
  assert.deepEqual(during, { holder: 1, contender: 2, progress: 44, required: 72, taken: null });
  const report = keep => ({ p: -3, q: 4, bell: 200, keep, clash: { report: {}, inputs: { arrivals: [{ present: 1, hostId: 1n, faction: 2, unit: 0, troops: 1000, stamina: 100, stance: 1, retreat: 0, fate: 1, troopsAfter: 900, tile: 26 }] } } });
  const fs = (keep, keeps = new Map()) => ({ report: report(keep), conquest: { keeps } });
  const done = String(renderReport(fs(KEEP)));
  assert.match(done, new RegExp(`この戦いは州 -3,4 の砦をめぐるものです：いまの保持者 ${N2} · 第228ターンに ${N2} が ${N1} から奪った`));
  assert.match(done, /data-act="goto" data-p="-3" data-q="4">砦を見る/);
  const running = String(renderReport(fs({ ...KEEP, holder: 1 }, new Map([['-3,4', live]]))));
  assert.match(running, new RegExp(`いまの保持者 ${N1}、奪取まで 44/72 ターン`));
  const plain = String(renderReport(fs(undefined)));
  assert.doesNotMatch(plain, /砦/);
  const strip = s => s.replace(/<p class="report-keep">[\s\S]*?<\/p>\s*/, '');
  assert.equal(strip(done).replace(/\s+/g, ' '), plain.replace(/\s+/g, ' '), 'the line is the only difference');
  assert.match(done, /data-act="report-verify"/);
});

test('the territory lens washes a province in its keep holder’s colour; a capture changes the colour', () => {
  const fills = [];
  const edges = [];
  const ctx = { save() {}, restore() {}, fill(path) { fills.push([path, this.fillStyle, this.globalAlpha]); }, stroke(path) { edges.push([path, this.strokeStyle]); } };
  const outlineOf = (p, q) => ({ fill: `${p},${q}` });
  const cells = control => [{ p: -3, q: 4, fog: 'clear', rec: { control } }, { p: 0, q: 0, fog: 'clear', rec: { control: 6 } }, { p: 5, q: 0, fog: 'unopened', rec: { control: 1 } }, { p: 1, q: 1, fog: 'clear', rec: {} }];
  paintControlWash(ctx, cells(1), outlineOf, 'world');
  paintControlWash(ctx, cells(2), outlineOf, 'province');
  assert.deepEqual(fills, [['-3,4', FACTION_COLORS[1], 0.46], ['5,0', FACTION_COLORS[1], 0.46], ['-3,4', FACTION_COLORS[2], 0.24], ['5,0', FACTION_COLORS[1], 0.24]]);
  // the edge takes the holder's colour too
  assert.deepEqual(edges, [['-3,4', FACTION_COLORS[1]], ['5,0', FACTION_COLORS[1]], ['-3,4', FACTION_COLORS[2]], ['5,0', FACTION_COLORS[1]]]);
});

test('the controller reads the season’s conquest days and the selected keep’s history from the herald', async () => {
  const saved = { ...FS }, gets = [];
  const fetch = async url => {
    gets.push(url);
    const body = url === '/h/conquest/1.json' ? DAY1 : url === '/h/conquest/0.json' ? { v: 1, day: 0, events: [] } : url === '/h/keep/-3,4.json' ? KEEP : null;
    return body ? { ok: true, status: 200, json: async () => body } : { ok: false, status: 404 };
  };
  const h = createHerald({ fetch });
  try {
    Object.assign(FS, { season: { layoutVersion: 2, programVersion: 3, endBell: 432 }, clock: { genesisTs: 0 }, chain: { now: () => 230 * 600 }, nowBell: 230, overviewsBell: 230, selected: { p: -3, q: 4 }, conquest: null, provinces: new Map(), overviews: new Map() });
    C.useHerald({ control: async () => ({ ok: false }), standings: async () => ({ ok: false }), province: async () => ({ ok: false }), conquestDay: h.conquestDay, keep: h.keep });
    await C.refreshConquest();
    await new Promise(r => setTimeout(r, 0));
    assert.deepEqual(FS.conquest.events.map(e => [e.kind, e.bell]), [['keep_contest', 157], ['keep_taken', 228]]);
    assert.equal(FS.conquest.history.get('-3,4').captures[0].bell, 228);
    assert.equal(C.wantKeepHistory(-3, 4), false, 'read once a bell');
    assert.deepEqual(gets.sort(), ['/h/conquest/0.json', '/h/conquest/1.json', '/h/keep/-3,4.json']);
    assert.equal((await h.conquestDay(7)).code, 'NotFound');
  } finally { C.useHerald(null); Object.assign(FS, saved); }
});

// ------------------------------------------------------------------ the new board over the conquest records
// (the real-chain play of 2026-10-11: a host of 500 arrived on the keep of province 4,-1, 100 defenders; the battle
// scene and the report's rows knew residents, village garrisons and camps only, so the fight had one side)
const province = (keep, entries = []) => ({ layoutVersion: 2, p: 4, q: -1, resolvedNext: 14, entries, sites: [], siteMirror: [], camp: { state: 0 },
  keep: { tile: 10, holder: 5, contender: 255, progress: 0, required: 72, flags: 0, troops: 100, consolidatedUntilBell: 0, ...keep } });
const arrival = (o = {}) => ({ present: 1, hostId: 77n, tile: 10, faction: 0, unit: 0, stance: 1, troops: 500000, fate: 2, troopsAfter: 487000, ...o });

test('a fight on a keep: the keep\'s defenders are the other side of the battle scene and a row of the report', () => {
  const before = province(), after = province({ troops: 0, contender: 0, progress: 2 });
  const kd = keepDefenders(before, after, [arrival()]);
  assert.deepEqual([kd.tile, kd.side.faction, kd.side.before, kd.side.after, kd.side.fate, kd.side.kind], [10, 5, 100, 0, 'Destroyed', 'garrison']);
  const scene = battleScene({ p: 4, q: -1, bell: 12, inputs: { arrivals: [arrival()] }, before, after });
  assert.deepEqual(scene.tiles.map(t => [t.idx, t.attackers.map(a => [a.faction, a.before, a.after]), t.defenders.map(d => [d.id, d.faction, d.before, d.after])]),
    [[10, [[0, 500, 487]], [['keep', 5, 100, 0]]]]);
  // the same nation's host is a reinforcement, an arrival on another tile does not meet the keep, an empty keep has nobody
  assert.equal(keepDefenders(before, after, [arrival({ faction: 5 })]), null);
  assert.equal(keepDefenders(before, after, [arrival({ tile: 11 })]), null);
  assert.equal(keepDefenders(province({ troops: 0 }), after, [arrival()]), null);
  assert.equal(keepDefenders({ ...before, layoutVersion: 1 }, after, [arrival()]), null, 'not a conquest province');
  // the province after is not known: who stood, not what was lost; a keep that changed hands lost them all
  assert.equal(keepDefenders(before, null, [arrival()]).side.after, null);
  assert.equal(keepDefenders(before, province({ holder: 0, troops: 241 }), [arrival()]).side.after, 0);
  assert.equal(keepDefenders(before, province({ troops: 60 }), [arrival()]).side.after, 60);
  const rows = recordRows({ inputs: { arrivals: [arrival()] }, before, after });
  assert.deepEqual(rows.map(r => [r.kind, r.faction, r.before, r.after, r.tile]), [['arrival', 0, 500, 487, 10], ['garrison', 5, 100, 0, 10]]);
});

test('a turn nobody fought in is not a clash in the chronicle or among the reports; a keep\'s panel and its colour do not wait for the survey', () => {
  const quiet = { seq: '9', record: { name: 'CLASH', bell: 15, p: 4, q: -1, engagements: 0 } }, fought = { seq: '8', record: { name: 'CLASH', bell: 12, p: 4, q: -1, engagements: 1 } };
  assert.deepEqual(chronicleRows([fought, quiet]).map(r => r.bell), [12]);
  assert.deepEqual(clashesFrom([fought, quiet]), [{ p: 4, q: -1, bell: 12 }]);
  assert.deepEqual(clashesFrom([{ seq: '1', record: { name: 'CLASH', bell: 3, p: 0, q: 1 } }]), [{ p: 0, q: 1, bell: 3 }], 'a record without the count is a clash, as before');
  // an unsurveyed province still shows its keep (holder, defenders, the march button's place): the reach list's "go there" leads here
  const keeps = new Map([['4,-1', { p: 4, q: -1, tile: 10, holder: 5, troops: 100, heartland: false, consolidatedUntil: 0, contender: 255, progress: 0, requiredBells: 72, asOfBell: 5 }]]);
  const fs = { mode: 'play', season: { programVersion: 3, endBell: 2016 }, nowBell: 6, citizen: { faction: 0 }, holdings: [], provinces: new Map(), overviews: new Map([[4, { provinces: [{ p: 4, q: -1, owners: [], sites: [] }] }]]),
    selected: { kind: 'province', p: 4, q: -1 }, conquest: { keeps }, survey: { showAll: false, levelOf: () => 1, province: () => ({ max: 1 }) } };
  const panel = String(renderInspect(fs, null));
  assert.match(panel, /conquest-keep/);
  assert.match(panel, new RegExp(factionName(5)));
  // the territory wash takes the shared control of a cell that has no surveyed record
  const calls = [];
  const ctx = { save() {}, restore() {}, fill() { calls.push(['fill', this.fillStyle]); }, stroke() { calls.push(['stroke', this.strokeStyle]); } };
  paintControlWash(ctx, [{ p: 4, q: -1, rec: null, control: 0 }, { p: 3, q: -1, rec: null, control: null }], () => ({ fill: {} }), 'world');
  assert.deepEqual(calls, [['fill', FACTION_COLORS[0]], ['stroke', FACTION_COLORS[0]]]);
  const fmap = readFileSync(new URL('../../permutation-server/web/frontier/map/fmap.mjs', import.meta.url), 'utf8');
  assert.match(fmap, /const held = src\.territoryEnabled \? null : recs\.get\(key\)\?\.control;/, 'never in the arrival-control sample world');
});

test('the first village\'s card gives the drawer back: its close button and a dock tab note it as read; the paid-join terms stand inside the confirm plate', () => {
  const saved = { ...FS };
  try {
    Object.assign(FS, { homeGrant: { p: 2, q: 0, site: 11, gen: 1, tile: 20, state: 2 }, homeFocus: null, record: null, wallet: null });
    const h = C.ackHomeGrant();
    assert.deepEqual([h.site, FS.homeGrant, FS.homeFocus?.site], [11, null, 11]);
    assert.equal(C.ackHomeGrant(), null, 'nothing to note twice');
  } finally { for (const k of Object.keys(FS)) delete FS[k]; Object.assign(FS, saved); }
  const read = f => readFileSync(new URL(`../../permutation-server/web/frontier/${f}`, import.meta.url), 'utf8');
  const app = read('app.mjs');
  assert.match(app, /endPick\(\);\n  ackHomeGrant\(\);\n  closeDrawer\(FS\);/, 'the drawer\'s close');
  assert.match(app, /ackHomeGrant\(\);\n    ACTIONS\.tab\(d\);/, 'a dock tab');
  assert.match(read('screens/join.mjs'), /\$\{FS\.prize && !FS\.citizen \? renderJoinTerms\(FS\) : ''\}\n  <\/div>`;/, 'inside .nation-confirm');
  assert.match(read('frontier.css'), /\.nation-confirm \.prize-terms \{ grid-column: 1 \/ -1;/);
});
