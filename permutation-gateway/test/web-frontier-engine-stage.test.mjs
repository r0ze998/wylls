// ⑭ central tower, step T1: "the Engine is at stage 0 in production" as a tested invariant, not something found by
// reading the code. No rule raises the Engine yet (T3 waits on the owner's decisions Q7/Q9), so the one way to another
// stage is the art preview, `?art=1&engine=N` (presentation only). What these tests hold:
//   (a) without `art=1` the stage is 0 whatever `engine=` says;
//   (b) in the preview `engine=N` is clamped to the art's range 0..5 (7 → 5; negative and garbage → 0);
//   (c) the map draws the bell's tower only at stage 0, and stage N draws the art's `engine_N`;
//   and that the page has no other source for the stage (app.mjs → fmap.mjs → sprites.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { ENGINE_STAGE_MAX, clampEngineStage, resolveEngineStage, engineLandmark } from '../../permutation-server/web/frontier/map/enginestage.mjs';
import { TOWER } from '../../permutation-server/web/frontier/map/belltower.mjs';
import { PROVINCE_TILES } from '../../permutation-server/web/frontier/fgeo.mjs';

const WEB = new URL('../../permutation-server/web/frontier/', import.meta.url);
const read = rel => readFileSync(new URL(rel, WEB), 'utf8');
/** Every .mjs under web/frontier, as [relative path, source]. */
function sources(dir = '') {
  const out = [];
  for (const d of readdirSync(new URL(dir || '.', WEB), { withFileTypes: true })) {
    if (d.isDirectory()) out.push(...sources(`${dir}${d.name}/`));
    else if (d.name.endsWith('.mjs')) out.push([`${dir}${d.name}`, read(`${dir}${d.name}`)]);
  }
  return out;
}

const ENGINE_VALUES = ['0', '1', '3', '5', '7', '99', '-1', '-7', '2.9', 'abc', '', ' 4 ', '1e3', 'NaN', 'Infinity', '0x3', '5;drop'];

// ------------------------------------------------------------------ (a) production: always stage 0
test('without ?art=1 the Engine is at stage 0 for any engine= value', () => {
  for (const v of ENGINE_VALUES) {
    const e = encodeURIComponent(v);
    for (const search of [`?engine=${e}`, `?art=0&engine=${e}`, `?art=2&engine=${e}`, `?art=&engine=${e}`, `?art=true&engine=${e}`, `?art=01&engine=${e}`, `?ART=1&engine=${e}`, `?engine=${e}&roads=1&relics=1`]) {
      assert.equal(resolveEngineStage(search), 0, search);
      assert.equal(resolveEngineStage(new URLSearchParams(search)), 0, `${search} (URLSearchParams)`);
    }
  }
  // no query at all, and a page without a location (the tests' own import of the modules)
  for (const none of ['', '?', undefined, null, new URLSearchParams()]) assert.equal(resolveEngineStage(none), 0);
  // (the first `art` decides, as URLSearchParams.get reads it: a second one does not turn the preview on)
  assert.equal(resolveEngineStage('?art=0&art=1&engine=3'), 0);
});

// ------------------------------------------------------------------ (b) the preview: clamped to the art's range
test('with ?art=1 engine=N is clamped to 0..5: 7 is 5, negative and garbage are 0', () => {
  assert.equal(ENGINE_STAGE_MAX, 5);
  assert.equal(resolveEngineStage('?art=1&engine=7'), 5);
  assert.equal(resolveEngineStage('?art=1&engine=99'), 5);
  assert.equal(resolveEngineStage('?art=1&engine=1e3'), 5);
  for (let n = 0; n <= 5; n++) assert.equal(resolveEngineStage(`?art=1&engine=${n}`), n);
  assert.equal(resolveEngineStage('?art=1'), 0, 'the preview alone raises nothing');
  assert.equal(resolveEngineStage('?art=1&engine=-1'), 0);
  assert.equal(resolveEngineStage('?art=1&engine=-7'), 0);
  assert.equal(resolveEngineStage('?art=1&engine=abc'), 0);
  assert.equal(resolveEngineStage('?art=1&engine='), 0);
  assert.equal(resolveEngineStage('?art=1&engine=NaN'), 0);
  assert.equal(resolveEngineStage('?art=1&engine=Infinity'), 0, 'not a 32-bit whole number: 0, as `| 0` reads it');
  assert.equal(resolveEngineStage('?art=1&engine=2.9'), 2, 'a fraction is cut, not rounded');
  assert.equal(resolveEngineStage('?art=1&engine=0x3'), 3);
  assert.equal(resolveEngineStage(new URLSearchParams({ art: '1', engine: '4' })), 4);
  // whatever is asked, the answer is a whole number the art has
  for (const v of ENGINE_VALUES) {
    const n = resolveEngineStage(`?art=1&engine=${encodeURIComponent(v)}`);
    assert.ok(Number.isInteger(n) && n >= 0 && n <= ENGINE_STAGE_MAX, `${JSON.stringify(v)} → ${n}`);
  }
  for (const v of [undefined, null, NaN, -3, 7, 2.5, '3', 'x', {}, [], true, 1e12, -1e12]) {
    const n = clampEngineStage(v);
    assert.ok(Number.isInteger(n) && n >= 0 && n <= ENGINE_STAGE_MAX, `${String(v)} → ${n}`);
  }
  assert.equal(clampEngineStage(7), 5);
  assert.equal(clampEngineStage(-3), 0);
});

// ------------------------------------------------------------------ (c) what the map draws at the Concord's centre
test('the landmark of a stage: the tower at stage 0 alone, engine_N at stage N, upright once raised', () => {
  assert.deepEqual(engineLandmark(0), { stage: 0, sprite: 'engine_0', raised: false, tower: true });
  for (let n = 1; n <= 5; n++) assert.deepEqual(engineLandmark(n), { stage: n, sprite: `engine_${n}`, raised: true, tower: false });
  assert.deepEqual(engineLandmark(9), engineLandmark(5));
  assert.deepEqual(engineLandmark(-2), engineLandmark(0));
  assert.deepEqual(engineLandmark(undefined), engineLandmark(0));
  // the art has a sprite for every stage, in every size
  const art = new URL('art/specials/', WEB);
  for (const size of readdirSync(art, { withFileTypes: true }).filter(d => d.isDirectory())) {
    const have = new Set(readdirSync(new URL(`${size.name}/`, art)));
    for (let n = 0; n <= ENGINE_STAGE_MAX; n++) assert.ok(have.has(`engine_${n}.webp`), `art/specials/${size.name}/engine_${n}.webp`);
  }
});

test('the painted map: the bell tower is drawn only at stage 0, and stage N draws engine_N', async () => {
  // a spare canvas for the tower's sprite (map/belltower.mjs towerSprite), so that the tower is one drawImage we can see
  class Spare {
    constructor(w, h) { this.width = w; this.height = h; }
    getContext() { const grad = { addColorStop() {} }; return new Proxy({ canvas: this, createLinearGradient: () => grad, createRadialGradient: () => grad, getTransform: () => null, measureText: () => ({ width: 10 }) }, { get: (o, k) => (k in o ? o[k] : () => {}), set: () => true }); }
  }
  const had = globalThis.OffscreenCanvas;
  globalThis.OffscreenCanvas = Spare;
  try {
    const { SpriteArt } = await import('../../permutation-server/web/frontier/map/sprites.mjs');
    // the Concord (province 0,0): grass everywhere, all of it seen
    const entry = { p: 0, q: 0, terrain: Array(PROVINCE_TILES).fill(0), sites: [], names: ['Grassland', 'Forest', 'Mountain', 'Hills', 'Plains', 'Water'], rec: null, fog: 'clear', prov: null };
    const B = TOWER.box, ratio = (B.left + B.right) / (B.top + B.bottom);
    const paint = (opts) => {
      const art = new SpriteArt();
      art.image = (set, size, name) => ({ set, name });
      const engines = [], towers = [], grad = { addColorStop() {} };
      const g = new Proxy({ createLinearGradient: () => grad, createRadialGradient: () => grad, getTransform: () => null, measureText: () => ({ width: 10 }) }, {
        get: (o, k) => (k in o ? o[k] : (...a) => {
          if (k !== 'drawImage') return;
          if (a[0]?.set === 'specials' && /^engine_/.test(a[0].name)) engines.push(a[0].name);
          // the tower's own sprite: a spare canvas of the tower's box (no other spare canvas has that shape)
          if (a[0] instanceof Spare && Math.abs(a[0].width / a[0].height - ratio) < 0.02 && Math.abs(a[3] / a[4] - ratio) < 1e-9) towers.push(a[0]);
        }),
        set: () => true,
      });
      art.paint(g, [entry], { zoom: 1, part: 'props', sea: true, ...opts });
      return { engines, towers: towers.length };
    };
    // production: the caller says nothing (sprites.mjs default) or 0 (fmap.mjs `src.engineStage ?? 0`)
    assert.deepEqual(paint({}), { engines: ['engine_0'], towers: 1 }, 'no stage given');
    assert.deepEqual(paint({ engineStage: 0 }), { engines: ['engine_0'], towers: 1 }, 'stage 0');
    // a raised Engine: its own sprite, and no tower
    for (let n = 1; n <= 5; n++) assert.deepEqual(paint({ engineStage: n }), { engines: [`engine_${n}`], towers: 0 }, `stage ${n}`);
    // out of range at the painter too: it never asks the art for a sprite it does not have
    assert.deepEqual(paint({ engineStage: 7 }), { engines: ['engine_5'], towers: 0 });
    assert.deepEqual(paint({ engineStage: -4 }), { engines: ['engine_0'], towers: 1 });
    assert.deepEqual(paint({ engineStage: 'x' }), { engines: ['engine_0'], towers: 1 });
    // and what the page's query would give is what is painted
    assert.deepEqual(paint({ engineStage: resolveEngineStage('?engine=4') }), { engines: ['engine_0'], towers: 1 }, 'production with engine=4');
    assert.deepEqual(paint({ engineStage: resolveEngineStage('?art=1&engine=4') }), { engines: ['engine_4'], towers: 0 }, 'the preview with engine=4');
  } finally {
    if (had === undefined) delete globalThis.OffscreenCanvas; else globalThis.OffscreenCanvas = had;
  }
});

// ------------------------------------------------------------------ the one path from the query to the painter
test('the page has one source for the stage: the query, through resolveEngineStage', () => {
  const app = read('app.mjs'), fmapSrc = read('map/fmap.mjs'), sprites = read('map/sprites.mjs');
  // app.mjs: the stage is resolveEngineStage of the page's own query, and that is what the map's source hands on
  assert.match(app, /import \{ resolveEngineStage \} from '\.\/map\/enginestage\.mjs';/);
  assert.match(app, /const ART_Q = new URLSearchParams\(globalThis\.location\?\.search \?\? ''\);/);
  assert.match(app, /const ART_ENGINE = resolveEngineStage\(ART_Q\);/);
  assert.deepEqual(app.match(/\bART_ENGINE\b\s*=[^=]/g), ['ART_ENGINE = '], 'assigned once');
  assert.deepEqual(app.match(/engineStage\s*:[^,\n]*/g), ['engineStage: ART_ENGINE'], 'the map\'s source carries that and nothing else');
  assert.match(app, /Production is always stage 0: no rule raises it yet \(⑭ central tower T3 is blocked on the owner's\n\/\/ decisions Q7\/Q9\)/, 'and the site says why');
  // fmap.mjs hands the source's stage to the painter (0 when the source has none)
  assert.deepEqual(fmapSrc.match(/engineStage\s*:[^,\n]*/g), ['engineStage: src.engineStage ?? 0']);
  // sprites.mjs: 0 by default, and the landmark is read from the shared helper (no clamp or tower rule of its own)
  assert.match(sprites, /replayEvery = 6000, engineStage = 0,/);
  assert.match(sprites, /const mark = engineLandmark\(engineStage\);/);
  assert.match(sprites, /this\.image\('specials', es\.key, mark\.sprite\)/);
  assert.match(sprites, /if \(mark\.tower\) \{\s*const tw = towerSprite\(/);
  assert.doesNotMatch(sprites, /engine_\$\{|`engine_|'engine_/, 'no engine sprite named past the helper');
  // nothing else in the client names the stage: no other module reads, sets or computes it
  const users = sources().filter(([, s]) => /engineStage|resolveEngineStage|engineLandmark|ART_ENGINE/.test(s)).map(([f]) => f).sort();
  assert.deepEqual(users, ['app.mjs', 'map/enginestage.mjs', 'map/fmap.mjs', 'map/sprites.mjs']);
  // and no account or herald field feeds it yet (T2/T3): the word appears in these files only as counted here
  const count = (s, re) => (s.match(re) ?? []).length;
  assert.equal(count(app, /engineStage/g), 1);
  assert.equal(count(fmapSrc, /engineStage/g), 2);
  assert.equal(count(sprites, /engineStage/g), 2);
});
