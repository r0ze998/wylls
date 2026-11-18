// ⑭ abolished (owner decision 2026-11-18 14:41 JST): there is no central tower, and the map has no centre. This file
// replaces web-frontier-engine-stage.test.mjs (⑭ T1, PR #27), which pinned "the Engine is at stage 0 in production".
// There is no Engine stage now, no `?engine=` preview and no bell tower. What these tests hold:
//   (a) no module of the client draws or names a tower, an Engine stage, the Concord's paving or plaza, or the Concord;
//   (b) the painted map draws province (0, 0) like any other province: no specials art, no tower sprite;
//   (c) the page names no centre: province (0, 0) is called by its coordinates, the far view names nations only;
//   (d) before joining the camera frames the opened land (or the nation's home region), not a landmark;
//   (e) the minimap has no landmark mark and no special colour for province (0, 0).
// Design: ~/Projects/wylls-grok-state/reports/ws14-abolish-design.md. The on-chain ring geometry (ring = hex distance
// from (0, 0), ring 0 reserved, ring 1 the Seats) is unchanged: that part needs the owner's OK (design §5).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { PROVINCE_TILES } from '../../permutation-server/web/frontier/fgeo.mjs';
import { setLang } from '../../permutation-server/web/lang.mjs';

const ROOT = new URL('../../permutation-server/web/', import.meta.url);
const WEB = new URL('frontier/', ROOT);
const read = (rel, base = WEB) => readFileSync(new URL(rel, base), 'utf8');
/** Every .mjs under a directory of web/, as [relative path, source] (vendored code left out). */
function sources(base, dir = '') {
  const out = [];
  for (const d of readdirSync(new URL(dir || '.', base), { withFileTypes: true })) {
    if (d.isDirectory()) { if (d.name !== 'vendor' && d.name !== 'node_modules') out.push(...sources(base, `${dir}${d.name}/`)); }
    else if (d.name.endsWith('.mjs')) out.push([`${dir}${d.name}`, read(`${dir}${d.name}`, base)]);
  }
  return out;
}

// ------------------------------------------------------------------ (a) nothing of the tower is left
test('no tower, no Engine stage, no Concord: the modules and the art are gone and nothing names them', () => {
  for (const gone of ['map/belltower.mjs', 'map/enginestage.mjs']) assert.ok(!existsSync(new URL(gone, WEB)), `${gone} is removed`);
  const art = new URL('art/specials/', WEB);
  for (const size of readdirSync(art, { withFileTypes: true }).filter(d => d.isDirectory())) {
    const left = readdirSync(new URL(`${size.name}/`, art)).filter(f => /^(engine_\d|concord_)/.test(f));
    assert.deepEqual(left, [], `art/specials/${size.name}: no Engine or Concord art`);
  }
  const banned = /belltower|paintBellTower|towerSprite|enginestage|engineStage|engineLandmark|resolveEngineStage|ART_ENGINE|ENGINE_VIEW|BELL_HAZE|concord_paving|concord_plaza|engine_\$\{|'engine_|ORIGIN_CONCORD|wide-concord|大協約/;
  const hits = sources(WEB).filter(([, s]) => banned.test(s)).map(([f, s]) => `${f}: ${s.match(banned)[0]}`);
  assert.deepEqual(hits, [], 'no client module names the tower, the Engine stage or the Concord');
  // the page reads no `engine=` from its query any more
  assert.doesNotMatch(read('app.mjs'), /get\('engine'\)|[?&]engine=/);
  // the language tables: the Concord as a place is gone (協調, the milestone path called "Concord", is another thing)
  for (const [f, s] of sources(new URL('lang/', ROOT))) {
    assert.doesNotMatch(s, /大協約|'The Concord'|the Concord|Concord as origin/, `lang/${f}`);
  }
});

// ------------------------------------------------------------------ (b) the painted map
test('the painted map draws province (0, 0) as land like any other: no specials art, no tower, its own props', async () => {
  // (what is painted into a spare canvas, a province's ground bitmap among them, is recorded too: `log`)
  let log = null;
  const record = (k, a) => { if (k === 'drawImage' && log && a[0]?.set) log.push(`${a[0].set}/${a[0].name}`); };
  class Spare {
    constructor(w, h) { this.width = w; this.height = h; }
    getContext() { const grad = { addColorStop() {} }; return new Proxy({ canvas: this, createLinearGradient: () => grad, createRadialGradient: () => grad, getTransform: () => null, measureText: () => ({ width: 10 }) }, { get: (o, k) => (k in o ? o[k] : (...a) => record(k, a)), set: () => true }); }
  }
  const had = globalThis.OffscreenCanvas;
  globalThis.OffscreenCanvas = Spare;
  try {
    const { SpriteArt } = await import('../../permutation-server/web/frontier/map/sprites.mjs');
    const entryAt = (p, q) => ({ p, q, terrain: Array(PROVINCE_TILES).fill(0), sites: [], names: ['Grassland', 'Forest', 'Mountain', 'Hills', 'Plains', 'Water'], rec: null, fog: 'clear', prov: null });
    const paint = (entry, opts) => {
      const art = new SpriteArt();
      art.image = (set, size, name) => ({ set, name });
      const drawn = [], spare = [], grad = { addColorStop() {} };
      log = drawn;
      const g = new Proxy({ createLinearGradient: () => grad, createRadialGradient: () => grad, getTransform: () => null, measureText: () => ({ width: 10 }) }, {
        get: (o, k) => (k in o ? o[k] : (...a) => {
          if (k !== 'drawImage') return;
          if (a[0] instanceof Spare) spare.push(a[0]); else if (a[0]?.set) drawn.push(`${a[0].set}/${a[0].name}`);
        }),
        set: () => true,
      });
      art.paint(g, [entry], { zoom: 1, sea: true, ...opts });
      return { drawn, spare: spare.length };
    };
    for (const part of ['ground', 'props']) {
      // province (0, 0) and an ordinary province of ring 2 with the same land: drawn with the same kinds of art
      const centre = paint(entryAt(0, 0), { part }), other = paint(entryAt(2, 0), { part });
      assert.deepEqual(centre.drawn.filter(d => d.startsWith('specials/')), [], `${part}: no specials art on province (0, 0)`);
      // (a spare canvas is what the bell tower's sprite was drawn from; the ground's own bitmaps use one too, alike everywhere)
      assert.equal(centre.spare, other.spare, `${part}: no tower sprite: no more spare bitmaps than any province`);
      const kinds = list => [...new Set(list.map(d => d.split('/')[0]))].sort();
      assert.deepEqual(kinds(centre.drawn), kinds(other.drawn), `${part}: the same kinds of art as any province`);
      assert.equal(centre.drawn.length, other.drawn.length, `${part}: as many pieces as any province of the same land`);
    }
    // a stray engineStage from an old caller changes nothing
    assert.deepEqual(paint(entryAt(0, 0), { part: 'props', engineStage: 3 }), paint(entryAt(0, 0), { part: 'props' }));
  } finally {
    if (had === undefined) delete globalThis.OffscreenCanvas; else globalThis.OffscreenCanvas = had;
  }
});

// ------------------------------------------------------------------ (c) words
test('no centre is named: province (0, 0) by its coordinates, the far view names nations only', async () => {
  setLang('ja');
  const place = await import('../../permutation-server/web/frontier/hud/place.mjs');
  const names = await import('../../permutation-server/web/frontier/map/names.mjs');
  assert.equal(place.provinceName(null, 0, 0), '州 0,0');
  assert.equal(place.provinceName({ holdings: [] }, 0, 0, { own: false }), '州 0,0');
  assert.equal(names.placeName({ p: 0, q: 0, ring: 0, opened: true }), '州 0,0');
  // other provinces are as before
  assert.equal(place.provinceName(null, 1, 1), 'アステル方面・第2輪の州');
  const { paintRealmLabels } = await import('../../permutation-server/web/frontier/map/fmap.mjs');
  const asked = [], said = [];
  const g = new Proxy({ measureText: t => ({ width: t.length * 8 }) }, { get: (o, k) => (k in o ? o[k] : (...a) => { if (k === 'fillText') said.push(a[0]); }), set: () => true });
  const recs = new Map([['2,0', { p: 2, q: 0, owners: [0, 0, 0, 7, 7, 7, 7, 7, 7, 7, 7, 7], sites: [1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0] }]]);
  paintRealmLabels(g, recs, 0.1, f => { asked.push(f); return `N${f}`; });
  assert.ok(asked.every(f => Number.isInteger(f)), `only nations are named (asked ${JSON.stringify(asked)})`);
  assert.deepEqual(said, ['N0']);
  // the glossary's ring and the nation choice say nothing of a centre, in either language
  const glossary = read('hud/glossary.mjs'), join = read('screens/join.mjs');
  assert.match(glossary, /ring: \{ name: \(\) => L`輪`, text: \(\) => L`ひらいた土地をとりまく州の輪です。/);
  assert.match(join, /六つの国が、果てのない辺境を分け合っています。/);
  assert.doesNotMatch(glossary + join, /中心|大協約/);
  const en = read('en-frontier-play.mjs', new URL('lang/', ROOT));
  assert.match(en, /'Six nations share a frontier without end\./);
  assert.match(en, /'The rings of provinces around the opened land\./);
});

// ------------------------------------------------------------------ (d) the camera before joining
test('before joining the camera frames the opened land, or the looked-at nation\'s home region: never a landmark', async () => {
  const opening = await import('../../permutation-server/web/frontier/map/opening.mjs');
  const cam = await import('../../permutation-server/web/frontier/map/camera.mjs');
  const size = { width: 1440, height: 900 }, inset = { top: 48, bottom: 450 }, src = { ringsOpen: 4, own: [] };
  const none = opening.openHint({ mode: 'play', land: { stage: 'none' } });
  const all = opening.openingPlan({ ...none, frame: {} }, src, size, { inset });
  assert.deepEqual(all.view, cam.fitView(4, size, { inset, cap: cam.FAR_CAP, floor: 0.02 }));
  for (let f = 0; f < 6; f++) {
    const p = opening.openingPlan({ ...none, frame: { nation: f } }, src, size, { inset });
    const b = opening.wedgeBox(f, 4);
    assert.equal(p.view.x, b.x, `nation ${f}: the camera is over its home region`);
  }
  assert.ok(!('ENGINE_VIEW' in opening));
});

// ------------------------------------------------------------------ (e) the minimap
test('the minimap draws no landmark and gives province (0, 0) no colour of its own', async () => {
  const mm = await import('../../permutation-server/web/frontier/hud/minimap.mjs');
  assert.ok(!('engine' in mm.MINI_SURVEY) && !('engineInk' in mm.MINI_SURVEY));
  const src = read('hud/minimap.mjs');
  assert.doesNotMatch(src, /'#e6dcc2'|the Engine|bell tower/);
});
