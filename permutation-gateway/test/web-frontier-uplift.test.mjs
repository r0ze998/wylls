// The visual uplift's decision parts (docs/design/uplift/02-CORE-FLOW, 03-COMPONENTS):
//  - the order's outlook: four facts, the forecast tagged 予測, nothing about a tile out of sight;
//  - the stances compared from the rules' forecast, each row the stance's own button, and a stale comparison never shown;
//  - the forecast kept at departure and laid beside the record's number in the report, nothing made up;
//  - the stage-1 things painted in the villages' hand (and quiet on a context that cannot paint them); a cart's load.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setLang } from '../../permutation-server/web/lang.mjs';
import { outlook, stanceCompare } from '../../permutation-server/web/frontier/hud/marchcard.mjs';
import { compareKey, forecastKey } from '../../permutation-server/web/frontier/hud/forecast.mjs';
import { keepForecast, forecastFor } from '../../permutation-server/web/frontier/hud/forecastbook.mjs';
import { renderPrediction } from '../../permutation-server/web/frontier/screens/report.mjs';
import { buildingsOf } from '../../permutation-server/web/frontier/map/board.mjs';
import { waterBody, forgetShores } from '../../permutation-server/web/frontier/map/groundblend.mjs';
import { landUse } from '../../permutation-server/web/frontier/map/landuse.mjs';
import { setS1 } from '../../permutation-server/web/frontier/fs1.mjs';
import { loadOf, paintVaultArt, paintTowerArt, paintPalisadeArt, paintFortArt, paintCartArt } from '../../permutation-server/web/frontier/map/structures.mjs';

const memory = () => { const m = new Map(); return { get: k => m.get(k) ?? null, set: (k, v) => { m.set(k, v); return true; } }; };
const fc = (min, max, fates = { Stays: 12 }) => ({ ok: true, runs: 12, troops: { min, max, start: 600 }, fates, certain: true });
const text = h => String(h).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

test('the outlook: arrival, cost, who is there, and the forecast tagged as one', () => {
  setLang('ja');
  const out = String(outlook({ w: { value: 45 }, awayLine: '約 19 分後', stam: 112, nowB: 42, def: { total: 420 }, odds: { text: '優勢' }, fc: fc(310, 470), sight: 3 }));
  assert.match(text(out), /到着 ターン 45 約 19 分後/);
  assert.match(text(out), /体力 −74/);
  assert.match(text(out), /守り 420 優勢/);
  assert.match(out, /state-tag state-forecast">予測</, 'the forecast says it is one');
  assert.match(text(out), /残る兵 310〜470/);
  // a tile out of sight: no defenders and no forecast are claimed
  const unseen = text(outlook({ w: { value: 45 }, stam: 112, nowB: 42, def: null, odds: null, fc: null, sight: 1 }));
  assert.match(unseen, /わからない 見えていない土地/);
  assert.doesNotMatch(unseen, /予測|残る兵/);
  // nobody there: no forecast cell (it would only say the host arrives whole)
  assert.doesNotMatch(text(outlook({ w: { value: 45 }, stam: 112, nowB: 42, def: { total: 0 }, fc: fc(600, 600), sight: 3 })), /予測/);
});

test('the stances compared: one button a stance, the chosen one pressed, the same range said once', () => {
  const rows = [0, 1, 2, 3].map(s => ({ stance: s, ...fc(300 + s * 10, 400 + s * 10, { Stays: 6, Withdrew: 2 }), runs: 8 }));
  const out = String(stanceCompare(1, { key: 'k', rows }));
  assert.equal((out.match(/data-act="mc-stance"/g) ?? []).length, 4);
  assert.match(out, /aria-checked="true" data-act="mc-stance" data-v="1"/);
  assert.match(text(out), /310〜410/);
  assert.doesNotMatch(out, /mcc-same/);
  const same = String(stanceCompare(0, { key: 'k', rows: rows.map(r => ({ ...r, troops: { min: 500, max: 520, start: 600 } })) }));
  assert.match(same, /mcc-same/);
  // without a comparison the plain pictures stay
  assert.match(String(stanceCompare(0, null)), /class="picks picks-4"/);
});

test('the card shows a forecast only for the order as it stands; a stale one is "being made", or nothing once the route failed', async () => {
  const { forecastNow } = await import('../../permutation-server/web/frontier/hud/marchcard.mjs');
  const c = { host: { id: '7' }, dest: { p: 2, q: 0, tile: 26 }, arriveBell: 44, stance: 0, retreat: 'r', ratio: null };
  const made = { key: forecastKey(c), ok: true, troops: { min: 584, max: 586, start: 600 }, runs: 8, fates: { Stays: 8 } };
  assert.equal(forecastNow({ ...c, forecast: made }), made);
  const moved = { ...c, dest: { p: 1, q: 1, tile: 9 }, forecast: made };
  assert.deepEqual(forecastNow(moved), { pending: true }, 'the last destination\'s forecast is not shown for the new one');
  assert.equal(forecastNow({ ...moved, routeError: 'NoRoute' }), null, 'no route: no forecast at all, not the old one');
  assert.equal(forecastNow({ ...c, forecast: null }), null);
  const { compareNow } = await import('../../permutation-server/web/frontier/hud/marchcard.mjs');
  const cmp = { key: compareKey(c), rows: [] };
  assert.equal(compareNow({ ...c, compare: cmp, forecast: { key: 'other', pending: true } }), cmp, 'a stance change (its forecast being made) keeps the table');
  assert.equal(compareNow({ ...c, stance: 3, compare: cmp }), cmp, 'the table is for every stance');
  assert.equal(compareNow({ ...c, dest: { p: 1, q: 1, tile: 9 }, compare: cmp }), null, 'never the last destination\'s');
});

test('the comparison key leaves the stance out, the forecast key does not', () => {
  const c = { host: { id: 7n }, dest: { p: 1, q: 2, tile: 3 }, arriveBell: 45, stance: 0, retreat: 'never', ratio: null };
  assert.equal(compareKey(c), compareKey({ ...c, stance: 2 }));
  assert.notEqual(forecastKey(c), forecastKey({ ...c, stance: 2 }));
  assert.notEqual(compareKey(c), compareKey({ ...c, dest: { p: 1, q: 2, tile: 4 } }));
});

test('the forecast kept at departure is laid beside the record; a row without one shows nothing', () => {
  const store = memory();
  keepForecast(store, 9, { hostId: 11n, bell: 50, stance: 1, fc: fc(584, 587) });
  keepForecast(store, 9, { hostId: 12n, bell: 50, stance: 0, fc: { ok: false } });
  assert.deepEqual([forecastFor(store, 9, '11', 50)?.min, forecastFor(store, 9, '12', 50), forecastFor(store, 8, '11', 50)], [584, null, null]);
  const of = (id, bell) => forecastFor(store, 9, id, bell);
  const rows = [{ id: '11', kind: 'arrival', mine: true, after: 586 }, { id: '99', kind: 'arrival', mine: false, after: 10 }];
  const out = text(renderPrediction(rows, 50, of));
  assert.match(out, /予測 出発時/);
  assert.match(out, /確定 ターン 50/);
  assert.match(out, /584〜587 586/);
  assert.doesNotMatch(out, /予測の幅の外/);
  assert.match(text(renderPrediction([{ ...rows[0], after: 400 }], 50, of)), /予測の幅の外/);
  assert.match(text(renderPrediction([{ ...rows[0], after: null }], 50, of)), /確かめると出ます/);
  assert.equal(String(renderPrediction([{ ...rows[0], id: '13' }], 50, of)), '', 'no kept forecast, no row');
  assert.equal(String(renderPrediction(rows, 50, null)), '');
});

test('an S1 village shows its workshops as the rules count them (arms production over one workshop\'s); other seasons have no seventh entry', () => {
  const production = [0, 0, 0, 0, 8000, 0, 0, 0].map(BigInt);
  setS1({ layoutVersion: 2, programVersion: 4 });
  try { assert.equal(buildingsOf({ tier: 0, production })[6], 2); } finally { setS1(null); }
  assert.equal(buildingsOf({ tier: 0, production }).length, 6);
});

test('a body of water has one coast whichever of its tiles asks; the coast is rounded and the same every time', () => {
  forgetShores();
  const water = new Set(['0,0', '1,0', '1,-1', '5,5']);
  const nameAt = (q, r) => (water.has(`${q},${r}`) ? 'water' : 'grassland');
  const a = waterBody(0, 0, nameAt), b = waterBody(1, -1, nameAt);
  assert.equal(a, b, 'the same body');
  assert.equal(a.set.size, 3, 'a lake of three, not the pond far away');
  assert.notEqual(waterBody(5, 5, nameAt), a);
  // (the loop may begin at another of its points; the coast, its points, is the same)
  const pts = b => b.loops.flat().map(([x, y]) => `${x.toFixed(3)},${y.toFixed(3)}`).sort();
  const again = (forgetShores(), waterBody(1, 0, nameAt));
  assert.deepEqual(pts(again), pts(a), 'the same coast after it was forgotten');
  // rounded: three rounds of a quarter's cut give 8 points for every corner of the outline
  assert.equal(a.loops[0].length % 8, 0);
  forgetShores();
});

test('worked land: 1 + tier fields for every village, the viewer\'s own buildings on fitting land, one picture a tile', () => {
  const kinds = { '0,0': 'grassland', '1,0': 'plains', '0,1': 'grassland', '-1,1': 'hills', '-1,0': 'forest', '0,-1': 'grassland', '1,-1': 'hills', '2,0': 'hills', '0,2': 'grassland' };
  const tileAt = (q, r) => (kinds[`${q},${r}`] ? { q, r, name: kinds[`${q},${r}`], x: 0, y: 0 } : null);
  const other = landUse([{ q: 0, r: 0, tier: 1, own: false, built: null }], tileAt);
  assert.deepEqual(other.map(u => u.kind), ['field', 'field']);
  const own = landUse([{ q: 0, r: 0, tier: 0, own: true, built: [1, 1, 1, 1, 0, 0] }], tileAt);
  assert.deepEqual(own.map(u => u.kind).sort(), ['field', 'field', 'mine', 'quarry', 'timber']);
  assert.equal(new Set(own.map(u => `${u.t.q},${u.t.r}`)).size, own.length, 'one picture a tile');
  assert.ok(own.filter(u => u.kind === 'quarry' || u.kind === 'mine').every(u => u.t.name === 'hills'));
  assert.deepEqual(landUse([{ q: 0, r: 0, tier: 0, own: true, built: [1, 1, 1, 1, 0, 0] }], tileAt), own, 'the same every time');
});

test('the lens\'s ore numbers are arms.rs\'s (ORE_RADIUS, the per-tile amounts, the cap)', async () => {
  const { readFileSync } = await import('node:fs');
  const rs = readFileSync(new URL('../../permutation-rules/src/frontier/arms.rs', import.meta.url), 'utf8');
  const c = n => Number(rs.match(new RegExp(`pub const ${n}: [^=]+= ([^;]+);`))?.[1]);
  const S = await import('../../permutation-server/web/frontier/map/sprites.mjs');
  assert.deepEqual([c('ORE_RADIUS'), c('ORE_PER_HILLS'), c('ORE_PER_MOUNTAIN'), c('ORE_PER_IRON'), c('ORE_TERRAIN_MAX')], [S.ORE_RADIUS, 2, 3, 4, S.ORE_TERRAIN_MAX]);
});

test('the stage-1 things: quiet on a context that cannot paint, drawn on one that can; a cart shows its largest load', () => {
  for (const f of [paintVaultArt, paintTowerArt, paintPalisadeArt, paintFortArt, paintCartArt]) {
    assert.doesNotThrow(() => f(null, 0, 0, 40));
    assert.doesNotThrow(() => f({ save() {}, restore() {} }, 0, 0, 40));
  }
  assert.equal(loadOf([0, 0, 0, 30000, 0, 0, 0, 0]), 'ore');
  assert.equal(loadOf([5, 80, 0, 30, 0, 0, 0, 0]), 'wood');
  assert.equal(loadOf([0, 0, 0, 0, 0, 0, 0, 9]), null, 'influence has no load picture');
  assert.equal(loadOf([['鉱石', 'Ore', 30]]), 'ore');
  assert.equal(loadOf(null), null);
});

test('an S1 season loads its own rules kernel; a conquest season and an M1 season keep theirs', async () => {
  const { kernelFile } = await import('../../permutation-server/web/frontier/fconquest.mjs');
  assert.equal(kernelFile({ layoutVersion: 2, programVersion: 4 }), 'frontier-v3.wasm');
  assert.equal(kernelFile({ layoutVersion: 2, programVersion: 3 }), 'frontier-v2.wasm');
  assert.equal(kernelFile({ layoutVersion: 1, programVersion: 1 }), 'frontier.wasm');
  assert.equal(kernelFile(null), 'frontier.wasm');
});

test('joining before the first turn: the button waits and says why; at the first turn it is the nation\'s', async () => {
  setLang('ja');
  const { renderNations } = await import('../../permutation-server/web/frontier/screens/join.mjs');
  const FS = t => ({ season: { programVersion: 3 }, clock: { genesisTs: 1000 }, chain: { now: () => t }, wallet: { address: 'w' }, joinDraft: { faction: 5 }, overviews: new Map() });
  const before = text(renderNations(FS(1000 - 290)));
  assert.match(before, /季節の始まりを待っています/);
  assert.match(before, /あと約 5 分/);
  assert.match(String(renderNations(FS(1000 - 290))), /data-act="home-confirm"\s+disabled/);
  const after = String(renderNations(FS(1000 + 5)));
  assert.doesNotMatch(after, /季節の始まりを待っています/);
  assert.doesNotMatch(after, /data-act="home-confirm"\s+disabled/);
});

test('the first village\'s stores are whole units, never more than there is', async () => {
  setLang('ja');
  const { renderGrant } = await import('../../permutation-server/web/frontier/screens/join.mjs');
  const out = text(renderGrant({ season: { programVersion: 3 }, citizen: { faction: 5 }, homeGrant: { p: 2, q: -2, site: 0, state: 2, stores: [306533, 104900, 3266, 103266, 0, 52450, 0, 0].map(v => ({ value: v })) } }));
  assert.match(out, /食料 306 木材 104 石材 3 鉱石 103 金 52/);
});

test('the tile card names an S1 thing on the tile and whose it is, as the map draws it', async () => {
  setLang('ja');
  const { inspectModel, render } = await import('../../permutation-server/web/frontier/hud/inspect.mjs');
  const s1 = { caravans: { v: 1, moving: [], vaults: [{ p: 2, q: -2, tile: 41, faction: 5, ownerTag: '7', gen: 1 }] }, structures: { v: 1, structures: [{ p: 2, q: -2, tile: 12, kind: 1, faction: 2, ownerTag: '9', gen: 1, notify: 1, cover: [] }], sightings: [] } };
  const FS = idx => ({ mode: 'play', s1, selected: { p: 2, q: -2, idx }, ownProfile: null, holdings: [] });
  assert.deepEqual(inspectModel(FS(41), null).tile.s1, [{ kind: 'vault', faction: 5, own: false }]);
  assert.match(text(render(FS(41), null)), /倉庫/);
  assert.match(text(render(FS(12), null)), /物見櫓/);
  const { renderBrief } = await import('../../permutation-server/web/frontier/hud/inspect.mjs');
  assert.match(text(renderBrief(FS(41), null)), /選択中: 倉庫/, 'the brief line names it as the card does');
  assert.equal(inspectModel(FS(13), null).tile.s1, undefined, 'nothing on another tile');
  assert.equal(inspectModel({ ...FS(41), s1: null }, null).tile.s1, undefined, 'no S1 season, nothing said');
});

test('a radio group of buttons: the arrows step and wrap, Home and End go to the ends, a disabled choice is passed over', async () => {
  const { radioStep } = await import('../../permutation-server/web/frontier/hud/radiokeys.mjs');
  const b = [0, 1, 2, 3].map(i => ({ i, disabled: i === 2 }));
  assert.equal(radioStep(b, b[0], 'ArrowDown').i, 1);
  assert.equal(radioStep(b, b[1], 'ArrowRight').i, 3, 'the disabled one is passed over');
  assert.equal(radioStep(b, b[3], 'ArrowDown').i, 0, 'wraps');
  assert.equal(radioStep(b, b[0], 'ArrowUp').i, 3);
  assert.equal(radioStep(b, b[3], 'Home').i, 0);
  assert.equal(radioStep(b, b[0], 'End').i, 3);
  assert.equal(radioStep(b, b[0], 'Enter'), null);
  assert.equal(radioStep(b, { i: 9 }, 'ArrowDown'), null, 'not one of the group');
});

test('S1 orders: a vault and a structure are built from the ABI v2 shapes, their addresses from the v2 seed tags', async () => {
  const { accountsFor, buildShape, SIGNED_BY } = await import('../../permutation-server/web/frontier/fplay.mjs');
  const { seasonAddresses, seedOf } = await import('../../permutation-server/web/frontier/faddr.mjs');
  const prog = '11111111111111111111111111111112', key = '4uQeVj5tqViQh7yWWGStvkEG1Zmhx6uasJtWCJziofM';
  const A = seasonAddresses(prog, 302);
  // seed = tag ‖ hex(le32 p ‖ le32 q ‖ u8 tile), as frontier-abi's vault_seed / structure_seed
  assert.equal(seedOf('Vault', { p: 1, q: -1, tile: 20 }), 'va01000000ffffffff14');
  assert.equal(seedOf('Structure', { p: 1, q: -1, tile: 20 }), 'tw01000000ffffffff14');
  for (const [name, fields, slot] of [['BuildVault', { tile: 20 }, 'vault'], ['BuildStructure', { kind: 1, tile: 20, notify: 0 }, 'structure']]) {
    assert.equal(SIGNED_BY[name], 'session');
    const acc = accountsFor(name, { addresses: A, wallet: key, actor: key, holding: { p: 0, q: 0, site: 3 }, at: { p: 1, q: -1, tile: 20 }, profile: 3 });
    assert.equal(acc[slot], A.of(name === 'BuildVault' ? 'Vault' : 'Structure', { p: 1, q: -1, tile: 20 }));
    assert.equal(acc.province, A.of('Province', { p: 1, q: -1 }));
    assert.equal(acc.holding_province, A.of('Province', { p: 0, q: 0 }));
    const b = buildShape({ programId: prog, name, accounts: acc, fields, feePayer: key, blockhash: prog, profile: 3 });
    assert.equal(b.expected.data[0], name === 'BuildVault' ? 0xB0 : 0xB7);
  }
});
