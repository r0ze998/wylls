// Arrival-control is server state, never the village's visual worked radius.
// Every surface must also respect current sight: historical survey is not live ownership.
import test from 'node:test';
import assert from 'node:assert/strict';
import { SpriteArt, buildRealms } from '../../permutation-server/web/frontier/map/sprites.mjs';
import { buildSurvey, openSurvey, L2, L3 } from '../../permutation-server/web/frontier/map/survey.mjs';
import { tileHex } from '../../permutation-server/web/frontier/fgeo.mjs';
import { inspectModel, render as renderInspect } from '../../permutation-server/web/frontier/hud/inspect.mjs';
import { snapshot, diffFeed } from '../../permutation-server/web/frontier/hud/feed.mjs';
import { setLang } from '../../permutation-server/web/lang.mjs';

const terrain = { terrain: Array(61).fill(0), names: ['Grassland'], sites: [30] };
const rec = { p: 2, q: 0, owners: [0], sites: [1], control: 5 };
const province = { p: 2, q: 0, sites: [30], entries: [], siteMirror: [{ state: 1, faction: 0, tier: 0, garrison: 0, shieldUntilBell: 0 }], relations: 0n };
const territory = (entries = [[30, 0], [31, 1]], history = []) => {
  const owners = Array(61).fill(255), since = Array(61).fill(null);
  for (const [i, f] of entries) { owners[i] = f; since[i] = 42; }
  return { v: 1, mode: 'arrival-control', bell: 44, owners, since, changes: [], history };
};
const entry = record => ({ p: 2, q: 0, ...terrain, rec, prov: province, fog: 'sight', territoryMode: true, territory: record });
const state = (record, extra = {}) => ({ sample: { territory: { mode: 'arrival-control' } }, mode: 'play', citizen: { faction: 0 }, holdings: [], nowBell: 44,
  overviews: new Map([[2, { provinces: [rec] }]]), provinces: new Map([['2,0', { province, sampleTerritory: record }]]), ...extra });
const sight = levels => buildSurvey({ ringsOpen: 3, anchors: levels.map(([i, level]) => ({ ...tileHex(2, 0, i), radius: 0, level })) });

test('near map uses server ownership, preserves the village, and neutral tiles do not inherit a worked radius', () => {
  const art = new SpriteArt(), record = territory(), e = entry(record), survey = openSurvey(3);
  const first = art.model([e], { ringsOpen: 3, survey });
  const tile = i => first.byId.get(`2,0,${i}`);
  assert.equal(tile(30).state, 1); assert.equal(tile(30).owner, 0, 'the village account remains unchanged');
  assert.equal(tile(30).wash.f, 0);
  assert.equal(tile(31).wash.f, 1, 'an opposing field within the village radius stays opposing');
  assert.equal(tile(29).wash, null, 'a neutral field does not inherit a nearby village colour');
  assert.equal(tile(31).wash.mine, false, 'claimed fields use the territory wash, not the worked-land suppression');
  assert.equal(art.model([e], { ringsOpen: 3, survey }), first, 'unchanged records retain the frame model');
  const changed = art.model([{ ...e, territory: territory([[30, 0], [31, 0]]) }], { ringsOpen: 3, survey });
  assert.notEqual(changed, first); assert.equal(changed.byId.get('2,0,31').wash.f, 0, 'a resolved battle refreshes the colour');
  const pending = art.model([{ ...e, territory: null }], { ringsOpen: 3, survey });
  assert.equal(pending.byId.get('2,0,31').wash, null, 'missing authority never falls back to inferred ownership');
  const legacy = art.model([{ ...e, territoryMode: false }], { ringsOpen: 3, survey });
  assert.equal(legacy.byId.get('2,0,31').wash.f, 0, 'the legacy visual model remains available outside arrival-control');
});

test('near and far maps hide current ownership outside sight and never smooth neutral pockets into a realm', () => {
  const e = entry(territory([[30, 0], [31, 1], [29, 2]]));
  const sv = sight([[30, L3], [31, L2]]);
  const m = new SpriteArt().model([e], { ringsOpen: 3, survey: sv });
  assert.equal(m.byId.get('2,0,30').wash.f, 0);
  assert.equal(m.byId.get('2,0,31').wash, null, 'previously surveyed is not current ownership');
  assert.equal(m.byId.get('2,0,29').wash, null, 'unsurveyed land exposes no owner');
  const old = globalThis.Path2D;
  globalThis.Path2D = class { polygons = 0; moveTo() {} lineTo() {} closePath() { this.polygons++; } };
  try {
    const far = buildRealms([e], { grow: 1, levelAt: sv.levelAt });
    assert.equal(far.fill[0].polygons, 1); assert.equal(far.fill[1], undefined); assert.equal(far.fill[2], undefined);
    const centre = tileHex(2, 0, 31);
    const neighbours = Array.from({ length: 61 }, (_, i) => ({ i, ...tileHex(2, 0, i) })).filter(h => Math.max(Math.abs(h.q - centre.q), Math.abs(h.r - centre.r), Math.abs(h.q + h.r - centre.q - centre.r)) === 1).slice(0, 4);
    const pocket = buildRealms([entry(territory(neighbours.map(h => [h.i, 2])))], { grow: 1 });
    assert.equal(pocket.fill[2].polygons, 4, 'four neighbouring owned cells cannot claim the neutral centre by visual smoothing');
    assert.equal(pocket.fill[0], undefined, 'village art does not invent field control');
  } finally { if (old === undefined) delete globalThis.Path2D; else globalThis.Path2D = old; }
});

test('inspector names authoritative own, opposing, and neutral fields only in sight', () => {
  setLang('ja');
  const FS = state(territory(), { selected: { p: 2, q: 0, idx: 31 } });
  assert.equal(inspectModel(FS, () => terrain).tile.territory.owner, 1);
  assert.match(String(renderInspect(FS, () => terrain)), /の領地/);
  FS.selected.idx = 30;
  assert.equal(inspectModel(FS, () => terrain).tile.site.faction, 0);
  assert.match(String(renderInspect(FS, () => terrain)), /あなたの国の領地/);
  FS.selected.idx = 29;
  assert.equal(inspectModel(FS, () => terrain).tile.territory.owner, null);
  assert.match(String(renderInspect(FS, () => terrain)), /どの国の領地でもありません/);
  FS.survey = sight([[29, L2]]);
  assert.equal(inspectModel(FS, () => terrain).tile.territory, undefined);
  assert.doesNotMatch(String(renderInspect(FS, () => terrain)), /どの国の領地でもありません|の領地/);
  FS.survey = null; FS.sample = {};
  assert.equal(inspectModel(FS, () => terrain).tile.territory, undefined, 'a payload alone cannot enable the mode');
});

test('feed reports resolved arrivals, won battles, and losses once, including late resolution history', () => {
  setLang('ja');
  const before = snapshot(state(territory()));
  const events = [
    { tile: 29, from: 255, to: 0, bell: 42, reason: 'arrival' },
    { tile: 31, from: 1, to: 0, bell: 42, reason: 'battle' },
    { tile: 30, from: 0, to: 1, bell: 43, reason: 'battle' },
    { tile: 28, from: 2, to: 3, bell: 43, reason: 'battle' },
  ];
  const after = snapshot(state(territory([[29, 0], [31, 0], [30, 1]], events), { nowBell: 45 }));
  const notices = diffFeed(before, after).filter(x => x.kind === 'territory');
  assert.equal(notices.length, 3, 'only this player’s nation, even when the resolution arrived several turns late');
  assert.match(notices[0].text, /到着し、領地を獲得/);
  assert.match(notices[1].text, /戦いに勝ち、領地を獲得/);
  assert.match(notices[2].text, /領地を失い/);
  assert.deepEqual(notices.map(x => x.tile), [29, 31, 30]);
  assert.deepEqual(diffFeed(after, after), [], 'history is not announced twice');
  assert.deepEqual(diffFeed(null, after), [], 'opening a page is not a new conquest');
  assert.deepEqual(diffFeed(snapshot(state(null)), after), [], 'first loading a province’s history is not news');
});

test('feed does not reveal hidden ownership events or replay them when sight returns', () => {
  const event = { tile: 31, from: 1, to: 0, bell: 44, reason: 'battle' };
  const before = snapshot(state(territory()));
  const hidden = snapshot(state(territory([[31, 0]], [event]), { survey: sight([[31, L2]]) }));
  assert.deepEqual(diffFeed(before, hidden), []);
  const visible = snapshot(state(territory([[31, 0]], [event]), { survey: sight([[31, L3]]) }));
  assert.deepEqual(diffFeed(hidden, visible), [], 'seeing the result later is not a new conquest');
  assert.deepEqual(diffFeed(before, snapshot(state(territory([[31, 0]], [event]), { sample: {} }))), [], 'disabled mode emits no territory notification');
});

test('arrival-control help distinguishes an army marker from lasting land ownership and declares the sample', async () => {
  const { renderSurveyHelp } = await import('../../permutation-server/web/frontier/map/legend.mjs');
  setLang('ja');
  const FS = state(territory()); FS.sample.world = 'sample';
  const help = String(renderSurveyHelp(FS));
  assert.match(help, /軍勢が移動しても、獲得した領地は残ります/);
  assert.match(help, /無主地は軍勢の到着後に獲得/);
  assert.match(help, /敵の領地は戦いの結果で所有が変わります/);
  assert.match(help, /いま視界にないマスの所有は表示しません/);
  assert.match(help, /チェーンには接続していません/);
  assert.doesNotMatch(help, /いるあいだだけ押さえています|チェーンの記録はすべて公開/);
  const legacy = String(renderSurveyHelp());
  assert.match(legacy, /いるあいだだけ押さえています/);
  assert.match(legacy, /チェーンの記録はすべて公開/);
});

test('a newly final home focuses once through the current tilted camera, including after a player pan', async () => {
  const { focusHome } = await import('../../permutation-server/web/frontier/app.mjs');
  const h = { p: 2, q: 0, site: 0, tile: 30, gen: 0, state: 2 };
  const calls = [], map = { cam: { userMoved: true }, dpr: () => 2, flyTo: (...args) => calls.push(args) };
  const FS = { homeGrant: h, homeFocus: h, selected: null };
  assert.equal(focusHome(FS, null), false); assert.equal(FS.homeFocus, h, 'wait until the map exists');
  assert.equal(focusHome(FS, map), true);
  assert.deepEqual(calls[0], [{ p: 2, q: 0, tile: 30, zoom: 1.1 }, null, { auto: false, seat: true }]);
  assert.deepEqual(FS.selected, { kind: 'tile', p: 2, q: 0, idx: 30 });
  assert.equal(FS.homeFocus, null);
  assert.equal(focusHome(FS, map), false); assert.equal(calls.length, 1, 'a subsequent render cannot pull the camera back');
  FS.homeFocus = h; map.cam.userMoved = false;
  assert.equal(focusHome(FS, map), true);
  assert.equal(calls[1][2].auto, true, 'an untouched camera keeps responsive opening framing');
  const candidate = { homeChoice: { candidates: [h] }, holdings: [], homeFocus: null };
  assert.equal(focusHome(candidate, map), false, 'home candidates alone do not move the camera');
});
