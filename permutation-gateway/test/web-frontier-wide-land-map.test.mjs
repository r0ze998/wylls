// The wide land (rings 129+) on the ORDINARY map and its chart 「全体図」 (permutation-server/web/frontier/map/
// wideland.mjs): the terrain is read from the captured province bytes (Province v2 TERRAIN @128, SITES @250,
// SITE_COUNT @262, PASSABLE_MASK @264), never regenerated; a cell is coloured by its keep nation; borders are drawn
// where the keep nation changes and on the land's outer edge; only cells in view are painted; legacy rings (≤ 128)
// are left to the map's own painters; a province past MAP_LIMIT is counted `far`, not placed; the background reader
// follows the manifest's snapshot and is quiet when the herald serves no recorded world. The map paints the land
// over the cloud sea and lets the camera, the sheet and the far view reach it. Synthetic fixed bytes only (the
// committed wide_economy fixture rebound, as the 「記録」 sheet's tests do): no keys, no network, no rules.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { encode } from '../../permutation-server/web/sdk/base58.mjs';
import { parseWideManifest, worldIdOf, ringPosition, compareRingOrder, WORLD_DOMAIN, WideWalk, loadWide } from '../../permutation-server/web/frontier/map/wide.mjs';
import {
  terrainOfCapture, wideLandOf, cellsIn, paintWideLand, wideTags, paintWideTags, wideLevel, mountWideLand, holderFill, meanColour,
  MAP_LIMIT, POLL_S, RETRY_S, NEUTRAL_LAND, WIDE_WORDS, MIN_CELL_PX, cellGrow, PATH_CHUNK, villageNation, villagesOf, villageRec, WASH,
} from '../../permutation-server/web/frontier/map/wideland.mjs';
import { NATION_LAND } from '../../permutation-server/web/frontier/palette.mjs';
import { landBox, fitView } from '../../permutation-server/web/frontier/map/camera.mjs';
import { sheetOf } from '../../permutation-server/web/frontier/map/table.mjs';
import { PROVINCE_CIRCUMRADIUS } from '../../permutation-server/web/frontier/map/layers.mjs';
import { setLang } from '../../permutation-server/web/lang.mjs';
import { syntheticWideEntry } from './fixtures/wide-map-capture.mjs';

const program = encode(new Uint8Array(32).fill(0x5e)), seasonAddress = encode(new Uint8Array(32).fill(3));
const world = worldIdOf(seasonAddress, program);
const SNAP = { epoch: '1', stamp: 'ab'.repeat(32), lastSlot: '20', foldedThrough: '12' };
const manifestJSON = (recorded, snap = SNAP) => ({ v: 1, experimental: true, readOnly: true, completeness: 'captured', world, worldDomain: WORLD_DOMAIN,
  program, seasonAddress, season: '5', snapshot: { ...snap }, recorded, refused: 0, page: { max: 256 } });
const record = { season: '5', seasonAddress, programId: program, cluster: 'localnet' };

/** A captured wide province at (p, q) whose keep `holder` holds (the summary and the raw byte agree). */
function wideAt(p, q, holder = 4) {
  const e = syntheticWideEntry({ seasonAddress, program, p: String(p), q: String(q), slot: '20' });
  const b = Buffer.from(e.wide.capture.bytes_b64, 'base64'); b[4481] = holder;
  e.wide.capture.bytes_b64 = b.toString('base64'); e.wide.keepHolder = holder;
  return e;
}
/** The same province with no village (the land's own colours alone). */
const bareAt = (p, q, holder = 4) => { const e = wideAt(p, q, holder); e.wide.holdings = []; return e; };
/** The same province whose one village (site 2) is of `nation` (Holding.FACTION @112 of its capture). */
function villageAt(p, q, holder, nation) {
  const e = wideAt(p, q, holder);
  const b = Buffer.from(e.wide.holdings[0].capture.bytes_b64, 'base64'); b[112] = nation;
  e.wide.holdings[0].capture.bytes_b64 = b.toString('base64');
  return e;
}
/** A legacy record (ring ≤ 128), as the herald lists the heartland. */
const legacyAt = (p, q) => {
  const rp = ringPosition(BigInt(p), BigInt(q));
  return { p: String(p), q: String(q), ring: String(rp.ring), wedge: rp.wedge, pos: String(rp.pos), state: 'open', revision: '1', observedAt: '0',
    legacy: { p, q, index: null, ring: Number(rp.ring), region: 3, openedBell: 0, slot: 10, address: seasonAddress } };
};
const sorted = es => es.map(e => ({ e, k: ringPosition(BigInt(e.p), BigInt(e.q)) })).sort((a, b) => compareRingOrder(a.k, b.k)).map(x => x.e);
const client = (entries, { snap = SNAP } = {}) => {
  const list = sorted(entries);
  const c = { manifests: 0, pages: 0, unavailable: false, snap };
  c.wideWorld = async () => { c.manifests++; return c.unavailable ? { ok: false, code: 'WideWorldUnavailable' } : { ok: true, manifest: parseWideManifest(manifestJSON(list.length, c.snap)) }; };
  c.wideWorldPage = async () => { c.pages++; return { ok: true, json: { v: 1, world, snapshot: { ...c.snap }, after: null, next: null, entries: list } }; };
  return c;
};
async function landOf(entries) {
  const r = await loadWide(client(entries), { walk: new WideWalk(), pins: {} });
  assert.equal(r.ok, true, r.code);
  return wideLandOf(r.walk);
}
const flush = () => new Promise(r => setTimeout(r, 0));

/** A 2D context that records what is filled and stroked. */
function fakeCtx() {
  const log = { fill: [], stroke: [], text: [], alpha: [], dash: [] };
  const ctx = { globalAlpha: 1, fillStyle: '', strokeStyle: '', lineWidth: 1, lineCap: '', font: '', textAlign: '', textBaseline: '',
    save() {}, restore() {}, beginPath() {}, closePath() {}, moveTo() {}, lineTo() {}, arc() {},
    fill() { log.fill.push({ style: this.fillStyle, alpha: this.globalAlpha }); }, stroke() { log.stroke.push({ style: this.strokeStyle, width: this.lineWidth }); },
    setLineDash(d) { log.dash.push(d); }, fillText(t) { log.text.push(t); }, strokeText() {} };
  return { ctx, log };
}

// ------------------------------------------------------------------ the captured bytes
test('the terrain is the captured Province v2 terrain block, read as it lies (never regenerated)', () => {
  const raw = readFileSync(new URL('../../frontier-node/crates/verify/tests/fixtures/wide_economy/harvest/province_post.bin', import.meta.url));
  const t = terrainOfCapture(wideAt(129, 0).wide.capture.bytes_b64);
  assert.ok(t);
  assert.deepEqual(t.terrain, [...raw.subarray(128, 189)]);
  assert.equal(t.sites.length, Math.min(12, raw[262]));
  assert.deepEqual(t.sites, [...raw.subarray(250, 250 + t.sites.length)]);
  assert.equal(t.passable, raw.readBigUInt64LE(264));
  assert.equal(t.names.length, 6);
  // a wrong length, a terrain index past the six kinds, base64 that is not: no terrain (the cell keeps a plain fill)
  assert.equal(terrainOfCapture(Buffer.alloc(100).toString('base64')), null);
  const bad = Buffer.from(raw); bad[130] = 9;
  assert.equal(terrainOfCapture(bad.toString('base64')), null);
  assert.equal(terrainOfCapture(undefined), null);
  assert.match(meanColour(t.terrain), /^#[0-9a-f]{6}$/);
});

// ------------------------------------------------------------------ the model
test('the land is the open captured wide provinces, placed exactly; legacy and far ones are not placed', async () => {
  const land = await landOf([wideAt(129, 0, 0), wideAt(129, -1, 0), wideAt(130, -1, 3), wideAt(-131, 0, 6), legacyAt(2, 0), wideAt('9007199254740993', 0, 1)]);
  assert.equal(land.count, 4);
  assert.equal(land.far, 1);
  assert.deepEqual(land.rings, { min: 129, max: 131 });
  assert.equal(land.reach, 132);
  assert.ok(!land.byKey.has('2,0'), 'a legacy ring is the ordinary map\'s own');
  const c = land.byKey.get('130,-1');
  assert.equal(c.ring, 130); assert.equal(c.holder, 3); assert.equal(c.holdings, 1);
  assert.ok(c.terrain && c.terrain.terrain.length === 61);
  assert.equal(land.byKey.get('-131,0').wedge, 3);
  assert.ok(MAP_LIMIT >= 32767);
});

test('borders: between keep nations once, and the outer edge where nothing is recorded beyond', async () => {
  const land = await landOf([wideAt(129, 0, 0), wideAt(129, -1, 0), wideAt(130, -1, 3)]);
  const all = land.cells.flatMap(c => c.edges.map(e => ({ ...e, from: c.key })));
  const inner = all.filter(e => e.inner);
  // (129,0) and (130,-1) touch and differ: one border; (129,0) and (129,-1) are one nation: none between them
  assert.equal(inner.length, 2, JSON.stringify(inner.map(e => e.from)));
  assert.ok(inner.every(e => [0, 3].includes(e.other)));
  // three cells of a hexagonal lattice in a triangle have 3·6 − 2·3 = 12 edges, of which 2 shared between the two nations
  assert.equal(all.filter(e => !e.inner).length, 12);
  for (const e of all) assert.ok(Math.hypot(e.a[0] - e.b[0], e.a[1] - e.b[1]) > 10, 'an edge is a real side of the cell');
});

test('only the cells in view are visited, at every level of detail', async () => {
  const land = await landOf([wideAt(129, 0, 0), wideAt(-129, 0, 2)]);
  const a = land.byKey.get('129,0');
  const seen = { x0: a.x - 10, y0: a.y - 10, x1: a.x + 10, y1: a.y + 10 };
  assert.deepEqual(cellsIn(land, seen).map(c => c.key), ['129,0']);
  assert.equal(cellsIn(land, { x0: 0, y0: 0, x1: 1, y1: 1 }).length, 0);
  assert.equal(cellsIn(null, seen).length, 0);
  for (const level of ['chart', 'world', 'province', 'tile']) {
    const { ctx } = fakeCtx();
    assert.equal(paintWideLand(ctx, land, { seen, zoom: 0.1, level }).cells, 1);
  }
  const { ctx, log } = fakeCtx();
  assert.deepEqual(paintWideLand(ctx, land, { seen: { x0: 0, y0: 0, x1: 1, y1: 1 } }), { cells: 0, fills: 0 });
  assert.equal(log.fill.length, 0);
});

test('thousands of wide provinces: no canvas path holds more than PATH_CHUNK of them (one huge path is not linear in the browser)', () => {
  // rings 129–135 whole (5,544 provinces) as a walk would hold them; no capture bytes (plain fills), holders 0–6
  const entries = new Map();
  for (let p = -135; p <= 135; p++) for (let q = -135; q <= 135; q++) {
    const r = Math.max(Math.abs(p), Math.abs(q), Math.abs(p + q));
    if (r >= 129 && r <= 135) entries.set(`${p},${q}`, { state: 'open', ring: BigInt(r), p: BigInt(p), q: BigInt(q), wedge: 0, wide: { capture: { bytes_b64: '' }, keepHolder: (p * 7 + q * 3 + 700) % 7, holdings: [] } });
  }
  const land = wideLandOf({ entries, world: 'w', snapshot: { epoch: '1', stamp: 'x' } });
  assert.equal(land.count, 5544);
  const seen = { x0: -1e9, y0: -1e9, x1: 1e9, y1: 1e9 };
  for (const [level, zoom] of [['chart', 0.006], ['world', 0.06], ['province', 0.25]]) {
    let open = 0, most = 0, paths = 0;
    const { ctx } = fakeCtx();
    ctx.beginPath = () => { open = 0; paths++; };
    ctx.moveTo = () => { open++; most = Math.max(most, open); };
    const r = paintWideLand(ctx, land, { seen, zoom, level });
    assert.equal(r.cells, 5544);
    assert.ok(most <= PATH_CHUNK, `${level}: ${most} sub-paths in one path`);
    assert.ok(paths >= Math.ceil(5544 / PATH_CHUNK), `${level}: ${paths} paths`);
  }
});

test('far: the terrain\'s own colour; nearer: the terrain, no keep-nation wash (territory-map OQ-3); tile view: the 61 tiles', async () => {
  const land = await landOf([bareAt(129, 0, 0), bareAt(129, -1, 0), bareAt(130, -1, 3), bareAt(131, -1, 6)]);
  const seen = { x0: -1e9, y0: -1e9, x1: 1e9, y1: 1e9 };
  const chart = fakeCtx();
  paintWideLand(chart.ctx, land, { seen, zoom: 0.05, level: 'chart' });
  // (territory-map, owner 2026-11-25 OQ-3: "colour only the tiles actually owned; show province control with the keep
  //  icon" — the land is its terrain's colour at every level, one path per colour; no nation's colour, no wash)
  const terrainColours = [...new Set(land.cells.map(c => c.colour))].sort();
  assert.deepEqual(chart.log.fill.map(f => f.style).sort(), terrainColours);
  assert.ok(!chart.log.fill.some(f => [NATION_LAND[0], NATION_LAND[3], NEUTRAL_LAND].includes(f.style)), 'no keep nation\'s colour');
  assert.ok(chart.log.fill.every(f => f.alpha === 1));
  assert.ok(chart.log.stroke.length >= 1, 'the outer edge');
  const prov = fakeCtx();
  paintWideLand(prov.ctx, land, { seen, zoom: 0.4, level: 'province' });
  assert.deepEqual(prov.log.fill.filter(f => f.alpha === WASH.province), [], 'no keep-nation wash');
  assert.ok(!prov.log.fill.some(f => [NATION_LAND[0], NATION_LAND[3]].includes(f.style)));
  const tile = fakeCtx();
  paintWideLand(tile.ctx, land, { seen, zoom: 1.2, level: 'tile' });
  // 4 provinces × 61 tiles, then the washes
  assert.ok(tile.log.fill.length >= 4 * 61, `${tile.log.fill.length} fills`);
  assert.equal(holderFill(7), NEUTRAL_LAND);
  assert.equal(wideLevel('world', true), 'chart');
  assert.equal(wideLevel('world', false), 'world');
  assert.equal(wideLevel('province', false), 'province');
  assert.equal(wideLevel('tile', false), 'tile');
});

test('the land is named once a direction, in the page\'s language', async () => {
  const land = await landOf([wideAt(129, 0, 0), wideAt(130, 0, 3), wideAt(-129, 0, 2)]);
  const seen = { x0: -1e9, y0: -1e9, x1: 1e9, y1: 1e9 };
  const tags = wideTags(land, seen);
  assert.equal(tags.length, 2);
  try {
    setLang('ja');
    assert.equal(WIDE_WORDS.name(), '広い土地');
    assert.deepEqual(wideTags(land, seen).map(t => t.sub).sort(), ['第129–130輪・記録', '第129輪・記録']);
    setLang('en');
    assert.equal(WIDE_WORDS.name(), 'Wide land');
    assert.deepEqual(wideTags(land, seen).map(t => t.sub).sort(), ['Ring 129 · recorded', 'Rings 129–130 · recorded']);
    // a tag stands beside its land, outward, never on it
    for (const z of [0.003, 0.05, 0.3]) for (const t of wideTags(land, seen, z)) {
      const out = Math.hypot(t.x, t.y), mid = Math.hypot(t.at.x, t.at.y);
      assert.ok(out > mid, 'outward');
      for (const c of land.cells) if (Math.hypot(c.x - t.at.x, c.y - t.at.y) < 4 * PROVINCE_CIRCUMRADIUS) assert.ok(Math.hypot(t.x - c.x, t.y - c.y) > PROVINCE_CIRCUMRADIUS * cellGrow(z), 'off the land');
    }
    const { ctx, log } = fakeCtx();
    assert.equal(paintWideTags(ctx, land, { seen, zoom: 0.05 }), 2);
    assert.ok(log.text.includes('Wide land'));
  } finally { setLang('ja'); }
});

test('from far a province is never less than MIN_CELL_PX on screen: a mosaic ringed in ink', async () => {
  const land = await landOf([bareAt(129, 0, 0), bareAt(129, -1, 0), bareAt(130, -1, 3)]);
  const seen = { x0: -1e9, y0: -1e9, x1: 1e9, y1: 1e9 };
  const z = 0.003;
  assert.ok(2 * PROVINCE_CIRCUMRADIUS * z < MIN_CELL_PX, 'the chart of a grown map draws a province under a few px');
  assert.ok(Math.abs(cellGrow(z) * 2 * PROVINCE_CIRCUMRADIUS * z - MIN_CELL_PX) < 1e-9);
  assert.equal(cellGrow(1), 1);
  for (const level of ['chart', 'world']) {
    const { ctx, log } = fakeCtx();
    const r = paintWideLand(ctx, land, { seen, zoom: z, level });
    assert.ok(r.grow > 1);
    // the ink ring first, then one fill per terrain colour (territory-map OQ-3: not the keep nations')
    assert.equal(log.fill[0].style, 'rgba(27,46,40,.9)');
    assert.deepEqual(log.fill.slice(1).map(f => f.style).sort(), [...new Set(land.cells.map(c => c.colour))].sort());
  }
  // nearer levels never enlarge
  const { ctx } = fakeCtx();
  assert.equal(paintWideLand(ctx, land, { seen, zoom: z, level: 'province' }).grow, 1);
});

test('the camera, the sheet and the far view measure rings past 128 (the wide land\'s reach) without a province list', () => {
  const b128 = landBox(129), b132 = landBox(132);
  assert.ok(b132.x > b128.x && b132.y > b128.y);
  // the vertex rule: the box grows by the same step every ring
  const b131 = landBox(131);
  assert.ok(Math.abs((b132.x - b131.x) - (b131.x - landBox(130).x)) < 1e-6);
  assert.ok(sheetOf(132));
  assert.ok(fitView(132, { width: 1920, height: 1200 }).zoom < fitView(129, { width: 1920, height: 1200 }).zoom);
});

// ------------------------------------------------------------------ the background reader
test('the reader loads the land, keeps it while the snapshot stands, reloads on a new one, and is quiet without one', async () => {
  const timers = [];
  const c = client([wideAt(129, 0, 0), wideAt(130, -1, 3)]);
  let changes = 0;
  const r = mountWideLand({ herald: c, recordOf: () => record, onChange: () => changes++, setTimer: (f, ms) => { timers.push({ f, ms }); return timers.length; }, clearTimer: () => {} });
  const run = async () => { const t = timers.shift(); await t.f(); await flush(); return t; };
  try {
    assert.equal(r.land(), null);
    assert.equal((await run()).ms, 0);
    assert.equal(r.land().count, 2); assert.equal(changes, 1);
    assert.equal(timers.at(-1).ms, POLL_S * 1000);
    // the same snapshot: one manifest, no page
    const pages = c.pages;
    await run();
    assert.equal(c.pages, pages); assert.equal(changes, 1);
    // a new snapshot: the land is read again
    c.snap = { ...SNAP, epoch: '2' };
    await run();
    assert.ok(c.pages > pages); assert.equal(changes, 2);
    // the herald stops serving it: the land goes, asked again after RETRY_S
    c.unavailable = true;
    await run();
    assert.equal(r.land(), null);
    assert.equal(timers.at(-1).ms, RETRY_S * 1000);
  } finally { r.stop(); }
});

test('a sample world, or a page with no season yet, never asks the herald', async () => {
  const timers = [];
  const c = client([wideAt(129, 0, 0)]);
  const opts = { herald: c, setTimer: (f, ms) => { timers.push({ f, ms }); return 1; }, clearTimer: () => {} };
  const a = mountWideLand({ ...opts, isSample: () => true, recordOf: () => record });
  await timers.shift().f(); a.stop();
  const b = mountWideLand({ ...opts, recordOf: () => null });
  await timers.shift().f(); b.stop();
  const s = mountWideLand({ ...opts, recordOf: () => ({ ...record, sample: true }) });
  await timers.shift().f(); s.stop();
  assert.equal(c.manifests, 0); assert.equal(c.pages, 0);
});

// ------------------------------------------------------------------ the map and the page (source pins)
test('the map paints the land over the cloud sea and lets the camera, sheet and far view reach it', () => {
  const read = p => readFileSync(new URL(`../../permutation-server/web/frontier/${p}`, import.meta.url), 'utf8');
  const fmap = read('map/fmap.mjs'), app = read('app.mjs'), en = readFileSync(new URL('../../permutation-server/web/lang/en-frontier.mjs', import.meta.url), 'utf8');
  const sea = fmap.indexOf("if (lod !== 'tile' || !tileOpts) { ctx.setTransform(...world); sea(ctx, null); }");
  const wide = fmap.indexOf('paintWideLand(ctx, wideLand, { seen, zoom: z, level: wideLevel(lod, coarse), overLand })');
  assert.ok(sea > 0 && wide > sea, 'the wide land is painted after (over) the cloud sea');
  assert.match(fmap, /ringsNow\(\) \{ return Math\.max\(1, this\.rings \?\? this\.source\?\.\(\)\?\.ringsOpen \?\? 1, this\.wideReach \?\? 0\); \}/);
  assert.match(fmap, /sheetRings\(\) \{ return Math\.max\(1, this\.rings \?\? 1, this\.wideReach \?\? 0\); \}/);
  assert.match(fmap, /this\.wideReach = src\.wideLand\?\.reach \?\? 0;/);
  assert.equal(fmap.split('sheetOf(this.sheetRings())').length - 1, 4, 'every sheet of the board is cut for the same reach');
  assert.match(fmap, /fitView\(Math\.max\(1, src\?\.ringsOpen \?\? 1, src\?\.wideLand\?\.reach \?\? 0\)/);
  assert.match(fmap, /const sheet = sheetOf\(Math\.max\(ringsOpen, src\.wideLand\?\.reach \?\? 0\)\)/);
  assert.match(app, /wideLand: wideLandRef\?\.land\(\) \?\? null/);
  assert.match(app, /mountWideLand\(\{ herald, isSample: \(\) => !!FS\.sample, recordOf: \(\) => FS\.record \?\? null/);
  for (const k of ["'広い土地'", "'第{0}輪・記録'", "'第{0}–{1}輪・記録'"]) assert.ok(en.includes(k), k);
  // (rendering only: that the module reaches no key API is the CI key scan's own check, scripts/ci/scan-node-key-tests.mjs)
});

// ------------------------------------------------------------------ villages (verify-pr88)
test('a wide village is drawn: its nation\'s sigil on its own site at the tile view, one mark per province from farther', async () => {
  const land = await landOf([villageAt(129, 0, 3, 0), villageAt(129, -1, 3, 5), bareAt(130, -1, 3)]);
  const c = land.byKey.get('129,0');
  assert.deepEqual(c.villages, [{ site: 2, nation: 0 }], 'the nation is the village\'s own (Holding.FACTION), not the keep\'s');
  assert.deepEqual(land.byKey.get('130,-1').villages, []);
  const rec = villageRec(c.villages);
  assert.equal(rec.sites[2], 1); assert.equal(rec.owners[2], 0);
  assert.equal(rec.sites.filter(x => x === 1).length, 1); assert.ok(rec.owners.every((o, i) => i === 2 || o === 7));
  const seen = { x0: -1e9, y0: -1e9, x1: 1e9, y1: 1e9 };
  for (const [level, zoom] of [['chart', 0.003], ['world', 0.05], ['province', 0.4], ['tile', 1.2]]) {
    const { ctx } = fakeCtx();
    assert.equal(paintWideLand(ctx, land, { seen, zoom, level }).villages, 2, level);
  }
  // (a province with no village draws exactly what it drew before: no mark)
  const bare = await landOf([bareAt(129, 0, 3)]);
  const { ctx } = fakeCtx();
  assert.equal(paintWideLand(ctx, bare, { seen, zoom: 0.003, level: 'chart' }).villages, 0);
});

test('a village\'s nation is read only from a whole wide holding capture; anything else names none and is not drawn', () => {
  const b = Buffer.alloc(1344); b[112] = 4;
  assert.equal(villageNation({ capture: { bytes_b64: b.toString('base64') } }), 4);
  b[112] = 6; assert.equal(villageNation({ capture: { bytes_b64: b.toString('base64') } }), null);
  assert.equal(villageNation({ capture: { bytes_b64: Buffer.alloc(1280).toString('base64') } }), null);
  assert.equal(villageNation({ capture: { bytes_b64: '%%' } }), null);
  assert.equal(villageNation(null), null);
  assert.deepEqual(villagesOf([{ site: 13 }, { site: 1, capture: { bytes_b64: '' } }]), [{ site: 1, nation: null }]);
  assert.deepEqual(villageRec([{ site: 1, nation: null }]).sites, Array(12).fill(0));
});
