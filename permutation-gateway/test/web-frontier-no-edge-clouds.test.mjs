// remove-edge-clouds (owner r0ze, 2026-11-25 13:58 「縁の雲いらんな」): the map lays no cloud sea round the opened land.
// Past the rim the sheet is bare paper at every zoom (the World chart never had cloud). The fog of war is another
// thing and is untouched: what the viewer has not seen is still the chart (map/survey.mjs levels, map/chart.mjs) and
// unlisted wide land is still not drawn (map/fog.mjs, map/wideland.mjs).
//
// Pure modules and source text only: no FrontierMap constructor, no page boot, no canvas, no network, no key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { CloudSea, SEA_DRAWN, seaField } from '../../permutation-server/web/frontier/map/cloudsea.mjs';
import { SURVEY_LEGEND } from '../../permutation-server/web/frontier/map/legend.mjs';
import { FOG_OF_LEVEL, L0, L1, L3, LEVELS, buildSurvey } from '../../permutation-server/web/frontier/map/survey.mjs';
import { tileHex } from '../../permutation-server/web/frontier/fgeo.mjs';

const web = new URL('../../permutation-server/web/', import.meta.url);
const read = rel => fs.readFileSync(new URL(rel, web), 'utf8');

test('the switch is off, and the sea itself is kept whole behind it', () => {
  assert.equal(SEA_DRAWN, false);
  // (the module still works: the field and the class are what a later decision would switch back on)
  assert.equal(typeof CloudSea.prototype.paint, 'function');
  const f = seaField(3);
  assert.equal(typeof f.inland, 'function');
});

test('the map asks the switch at both places it laid the sea, and the far picture lays no pale cloud cell', () => {
  const fmap = read('frontier/map/fmap.mjs');
  // the frame's own pass (tile view between the layers, far view over the far picture) and the travelling picture's (the apron)
  assert.ok(fmap.includes("if (coarse || !SEA_DRAWN) return { pending: 0, rough: 0, seen: false };"), 'the frame pass');
  assert.ok(fmap.includes('const r = SEA_DRAWN ? this.sea.paint(g, { box: a.box,'), 'the apron');
  // (no third call: every `this.sea.paint(` of the map is one of those two)
  assert.equal(fmap.split('this.sea.paint(').length - 1, 2);
  const frame = fmap.indexOf("if (coarse || !SEA_DRAWN) return"), call = fmap.indexOf('const r = this.sea.paint(g, { box: seen,');
  assert.ok(frame > 0 && call > frame && call - frame < 400, 'the frame pass returns before it paints');
  const sprites = read('frontier/map/sprites.mjs');
  assert.ok(sprites.includes("if (SEA_DRAWN && e.fog === 'unopened') {"), 'far bitmaps: no pale stand-in for cloud');
  // (the tile view still tells the sprite painter the caller owns the sea, so no per-hex cloud stamp comes back by the other door)
  assert.ok(/sea: true, up, seaPass: sea,/.test(fmap));
});

test('the fog of war does not read the switch: levels, the chart and the wide-land record are as they were', () => {
  for (const rel of ['frontier/map/survey.mjs', 'frontier/map/fog.mjs', 'frontier/map/chart.mjs', 'frontier/map/wideland.mjs', 'frontier/map/layers.mjs', 'frontier/hud/minimap.mjs'])
    assert.ok(!read(rel).includes('SEA_DRAWN'), rel);
  assert.deepEqual(LEVELS, ['cloud', 'chart', 'surveyed', 'sight']);
  assert.equal(FOG_OF_LEVEL.length, 4);
  // a viewer with one anchor: in sight on its tile, the chart (unseen, L1) elsewhere on open rings, level 0 past them
  const sv = buildSurvey({ ringsOpen: 3, anchors: [{ q: 0, r: 0, radius: 2, level: L3 }], memory: new Set() });
  assert.equal(sv.levelAt(0, 0), L3);
  const far = tileHex(2, 0, 30), out = tileHex(3, 0, 30);
  assert.equal(sv.levelAt(far.q, far.r), L1, 'unseen land on an open ring is still the chart');
  assert.equal(sv.province(2, 0).kind, 'chart');
  assert.equal(sv.levelAt(out.q, out.r), L0);
  assert.equal(sv.province(3, 0).kind, 'cloud', 'a ring that is not open keeps its level (drawn as bare paper now)');
});

test('the legend names the unopened ring without cloud, in Japanese and English', async () => {
  assert.deepEqual(SURVEY_LEGEND.map(x => x.id), ['sight', 'surveyed', 'chart', 'cloud']);
  const row = SURVEY_LEGEND.find(x => x.id === 'cloud');
  assert.equal(row.name(), '未開');
  assert.equal(row.text(), 'まだひらいていない輪です。土地そのものがまだありません。');
  const en = (await import('../../permutation-server/web/lang/en-frontier.mjs'));
  const table = Object.values(en).find(v => v && typeof v === 'object' && v['雲海'] === 'Cloud sea');
  assert.ok(table, 'the English table');
  assert.equal(table['未開'], 'Not open yet');
  // the swatch is paper, not a white cloud
  const css = read('frontier/frontier.css');
  assert.ok(css.includes('.survey-cloud { background: #e6d9b8;'));
  assert.ok(!css.includes('.survey-cloud { background: linear-gradient(160deg, #ffffff'));
});
