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
import { keepStake, render as renderReport } from '../../permutation-server/web/frontier/screens/report.mjs';
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
  assert.deepEqual(watch.map(x => [x.kind, x.p, x.q, x.side, x.text]), [['keep', -3, 4, null, `州 -3,4 の砦を ${N2} が ${N1} から奪った（第228鐘）`]]);
  // the two nations: the contest's start and the result
  const won = FEED.diffFeed(at(2, 158, []), at(2, 158, [contest]));
  assert.deepEqual(won.map(x => [x.side, x.text]), [['attack', `州 -3,4 の砦を ${N2} が攻めはじめた（第157鐘）`]]);
  assert.deepEqual(FEED.diffFeed(at(0, 158, []), at(0, 158, [contest])), [], 'a contest between other nations is not a notice');
  const lost = FEED.diffFeed(at(1, 229, [contest]), at(1, 229, [contest, taken]));
  assert.equal(lost[0].side, 'loss');
  assert.deepEqual(FEED.diffFeed(at(1, 400, [contest]), at(1, 400, [contest, taken])), [], 'a day read late is not news');
  const feed = FEED.pushFeed([], [...won, ...lost], 1000);
  const toasts = String(FEED.renderToasts(feed, { now: 1000 }));
  assert.match(toasts, /toast-keep/); assert.match(toasts, /data-act="feed-go"/);
  assert.match(toasts, /あなたの国が失った/); assert.match(toasts, /あなたの国が攻めている/);
  assert.match(String(FEED.renderCentre(feed, 'battle')), /から奪った（第228鐘）/);
  assert.doesNotMatch(String(FEED.renderCentre(feed, 'holding')), /砦/);
  assert.match(FEED.bellSummary(feed, 229).text, /砦 1/);
  setLang('en');
  assert.equal(FEED.diffFeed(at(0, 229, [contest]), at(0, 229, [contest, taken]))[0].text, 'Cinder took the keep of province -3,4 from Borealis (bell 228)');
});

test('the chronicle lists a contest’s start and the capture by bell, the viewer’s nation’s marked', () => {
  const records = [150, 200, 228, 300].map((bell, i) => ({ seq: String(i + 1), record: { name: 'CLASH', p: 1, q: 1, bell } }));
  const rows = chronicleRows(records, () => false, 60, events(), 2);
  assert.deepEqual(rows.map(r => [r.bell, r.mine, r.keep ?? null]), [[300, false, null], [228, true, 'keep_taken'], [228, false, null], [200, false, null], [157, true, 'keep_contest'], [150, false, null]]);
  assert.equal(rows[1].text, `州 -3,4 の砦が奪われた（${N1} → ${N2}）`);
  assert.equal(rows[4].text, `州 -3,4 の砦の争奪が始まった（${N1} → ${N2}）`);
  assert.equal(keepLineOf({ kind: 'keep_broken', p: 0, q: 0, from: 2, to: 1 }), null);
  assert.deepEqual(chronicleRows(records, () => false, 60, events(), 0).filter(r => r.mine), [], 'another nation’s keeps are not the viewer’s lines');
  assert.equal(chronicleRows(records, () => false, 1, events(), null).filter(r => r.keep).length, 2, 'keeps stay listed beyond the record limit');
  assert.equal(chronicleRows(records).length, 4, 'without conquest events the chronicle is as before');
  const out = String(renderChronicle({ chronicle: [], conquest: { events: events() }, citizen: { faction: 1 } }));
  assert.match(out, /<li class="mine"><span class="muted">第228鐘<\/span> 州 -3,4 の砦が奪われた/);
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
  assert.match(done, new RegExp(`この戦いは州 -3,4 の砦をめぐるものです：いまの保持者 ${N2} · 第228鐘に ${N2} が ${N1} から奪った`));
  assert.match(done, /data-act="goto" data-p="-3" data-q="4">砦を見る/);
  const running = String(renderReport(fs({ ...KEEP, holder: 1 }, new Map([['-3,4', live]]))));
  assert.match(running, new RegExp(`いまの保持者 ${N1}、奪取まで 44/72 鐘`));
  const plain = String(renderReport(fs(undefined)));
  assert.doesNotMatch(plain, /砦/);
  const strip = s => s.replace(/<p class="report-keep">[\s\S]*?<\/p>\s*/, '');
  assert.equal(strip(done).replace(/\s+/g, ' '), plain.replace(/\s+/g, ' '), 'the line is the only difference');
  assert.match(done, /data-act="report-verify"/);
});

test('the territory lens washes a province in its keep holder’s colour; a capture changes the colour', () => {
  const fills = [];
  const ctx = { save() {}, restore() {}, fill(path) { fills.push([path, this.fillStyle, this.globalAlpha]); } };
  const outlineOf = (p, q) => ({ fill: `${p},${q}` });
  const cells = control => [{ p: -3, q: 4, fog: 'clear', rec: { control } }, { p: 0, q: 0, fog: 'clear', rec: { control: 6 } }, { p: 5, q: 0, fog: 'unopened', rec: { control: 1 } }, { p: 1, q: 1, fog: 'clear', rec: {} }];
  paintControlWash(ctx, cells(1), outlineOf, 'world');
  paintControlWash(ctx, cells(2), outlineOf, 'province');
  assert.deepEqual(fills, [['-3,4', FACTION_COLORS[1], 0.34], ['5,0', FACTION_COLORS[1], 0.34], ['-3,4', FACTION_COLORS[2], 0.2], ['5,0', FACTION_COLORS[1], 0.2]]);
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
