// Exact source-audited UI tests, public fixtures only. No app boot, renderer
// constructor, browser/server, keys, signing, sealer, transport or RPC calls.
// Run with BOTH scripts/ci/no-keys-guard.mjs and screens/codex/no-key-node.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { seasonAddresses, hostId } from '../../permutation-server/web/frontier/faddr.mjs';
import { encode, decode as fromB58 } from '../../permutation-server/web/sdk/base58.mjs';
import { encodeAccount } from '../../permutation-server/web/sdk/frontier/codec.mjs';
import { decode } from '../../permutation-server/web/frontier/fcodec.mjs';
import { FS as STORE, flush, registerRenderers } from '../../permutation-server/web/frontier/fstate.mjs';
import * as CTRL from '../../permutation-server/web/frontier/controller.mjs';
import * as io from '../../permutation-server/web/frontier/fchainio.mjs';
import { OUTBOUND_POP, OUTBOUND_CLOSED, openOutbound, editOutbound, clearOutbound, tapOutbound, readOutboundMap } from '../../permutation-server/web/frontier/fexpedition-compose.mjs';
import { outboundTileHit, outboundHitDirection, outboundMapGeometry, paintOutboundRoute } from '../../permutation-server/web/frontier/map/outboundroute.mjs';
import { FrontierMap, pick, paintRoute } from '../../permutation-server/web/frontier/map/fmap.mjs';
import { traceWideDirections, wideTileAt, unpackWidePlain } from '../../permutation-server/web/frontier/fexpedition-seal.mjs';
import { DIRECTIONS, tileHex } from '../../permutation-server/web/frontier/fgeo.mjs';
import { project } from '../../permutation-server/web/map.mjs';
import { EN } from '../../permutation-server/web/lang.mjs';

const source = file => readFileSync(new URL('../../permutation-server/web/frontier/' + file, import.meta.url), 'utf8');
const PROGRAM = encode(new Uint8Array(32).fill(94)), WALLET = encode(new Uint8Array(32).fill(65));
const A = seasonAddresses(PROGRAM, '1'), OWNER = A.of('Citizen', { wallet: WALLET });
const PIN = { programId: PROGRAM, cluster: 'localnet', seasonId: '1', addresses: A };
const HOST = hostId({ p: 128, q: 0, site: 3, gen: 1, seq: 0 }).toString();
const acct = (kind, values) => decode(kind, encodeAccount(kind, { SEASON_ID: 1n, ...values }));
const fixture = JSON.parse(readFileSync(new URL('fixtures/frontier/season.json', import.meta.url), 'utf8'));
const SEASON = decode('Season', Buffer.from(fixture.bytes_b64, 'base64'));
function world() {
  const h = acct('Holding', { P: 128, Q: 0, SITE: 3, GEN: 1, TILE: 60, STATE: 2, FACTION: 0, TIER: 1, HOST_SEQ: 1,
    OWNER_CITIZEN: fromB58(OWNER), RESERVE: [400, 0, 0, 0, 0, 0, 100, 0] });
  const province = acct('Province', { P: 128, Q: 0, RESOLVED_NEXT: 42,
    ENTRIES: [{ ID: BigInt(HOST), FACTION: 0, UNIT: 0, TILE: 60, STATE: 1, TROOPS: 600000, STAMINA_VALUE: 120, STAMINA_BELL: 42 }] });
  const fs = { mode: 'play', sample: null, proto: null, season: { ...SEASON, seasonId: 1n, programVersion: 16388, rulesetHash: new Uint8Array(32).fill(1) },
    wallet: { address: WALLET }, resident: null, session: null, meStatus: 'ready', meAnswered: true,
    citizen: acct('Citizen', { WALLET: fromB58(WALLET), FACTION: 0, FLAGS: 5, TICKET_BELL: 0xffffffff,
      HOLDING: [{ P: 128, Q: 0, SITE: 3, GEN: 1 }, { GEN: 255 }, { GEN: 255 }] }), holdings: [h], activeHolding: 0,
    selected: { kind: 'tile', p: 128, q: 0, idx: 60 }, hand: { host: HOST, pop: OUTBOUND_POP },
    nowBell: 42, chain: { now: () => 1000 }, provinces: new Map([['128,0', { province }]]),
    view: { lod: 'tile', fog: true }, land: { stage: 'final' }, marches: [], book: [], orders: [], compose: null };
  const ctx = { pin: PIN, relay: '/gw', source: {} };
  openOutbound(fs, ctx);
  return { fs, ctx, h, province };
}
const nextTile = (w, direction = 0) => traceWideDirections({ world: w.fs.expeditionCompose.source.world,
  origin: w.fs.expeditionCompose.source.origin, directions: [...w.fs.expeditionCompose.directions, direction] }).endpoint;
const hitOf = tile => ({ p: Number(tile.p), q: Number(tile.q), idx: tile.tile, tileQ: Number(tile.tileQ), tileR: Number(tile.tileR) });
const closed = s => { for (const [key, value] of Object.entries(OUTBOUND_CLOSED)) { assert.equal(value, false); assert.equal(s[key], false); } };

test('actual original canvas pick appends into ring 129 without changing selected host/world or legacy order state', () => {
  const w = world(), { fs, ctx } = w, before = Object.fromEntries(Object.entries(fs).filter(([k]) => k !== 'expeditionCompose'));
  const tile = nextTile(w), model = readOutboundMap(fs, ctx);
  assert.equal(model.hexes.length, 1); assert.equal(model.next.length, 6); assert.equal(model.endpoint.ring, '128');
  const hex = model.next.find(c => c.direction === 0).hex, px = project(hex.q, hex.r);
  const hit = pick({ ...px, zoom: 1 }, { width: 800, height: 600 }, 400, 300);
  assert.deepEqual(hit, hitOf(tile));
  assert.deepEqual(tapOutbound(fs, ctx, hit), { handled: true, changed: true, code: null });
  assert.deepEqual(fs.expeditionCompose.directions, [0]); assert.equal(fs.expeditionCompose.trace.endpoint.p, '129');
  for (const [key, value] of Object.entries(before)) assert.equal(fs[key], value, key);
  editOutbound(fs, ctx, 'arriveBell', '44');
  const review = fs.expeditionCompose.review, plain = unpackWidePlain(Buffer.from(review.plainHex, 'hex'));
  assert.equal(plain.dest, tile.key); assert.equal(plain.destTile, tile.tile); assert.equal(plain.host, review.host);
  assert.equal(readOutboundMap(fs, ctx).arriveBell, null); closed(fs.expeditionCompose); closed(review);
});

test('all six adjacent directions use canonical full identities; duplicate endpoint taps are no-ops', () => {
  for (let d = 0; d < 6; d++) {
    const w = world(), tile = nextTile(w, d);
    assert.equal(outboundHitDirection(w.fs.expeditionCompose.source, [], tile), d);
    assert.equal(tapOutbound(w.fs, w.ctx, tile).changed, true);
    const map = readOutboundMap(w.fs, w.ctx);
    for (let i = 0; i < 3; i++) assert.deepEqual(tapOutbound(w.fs, w.ctx, tile), { handled: true, changed: false, code: 'EndpointSelected' });
    assert.deepEqual(w.fs.expeditionCompose.directions, [d]); assert.equal(readOutboundMap(w.fs, w.ctx), map);
  }
});

test('malformed, mismatched, nonadjacent and unsafe numeric hits never change a sound route', () => {
  const w = world(), tile = nextTile(w), other = nextTile(w, 1), s = w.fs.expeditionCompose;
  tapOutbound(w.fs, w.ctx, tile); const map = s.map, directions = s.directions;
  const malformed = [null, { p: 129, q: 0 }, { ...tile, world: 'ab'.repeat(32) }, { ...tile, key: other.key + '00' },
    { ...tile, idx: tile.tile + 1 }, { ...tile, tileQ: '0' }, { ...tile, tileR: '-0' },
    { ...tile, p: '0129' }, { ...tile, q: 0.5 }, { ...tile, p: Number.MAX_SAFE_INTEGER + 1 },
    { ...tile, p: '9007199254740993' }, { ...tile, p: '99999999999999999999999' },
    wideTileAt({ world: tile.world, p: '128', q: '0', tile: 0 })];
  for (const hit of malformed) {
    const result = tapOutbound(w.fs, w.ctx, hit);
    assert.equal(result.handled, true); assert.equal(result.changed, false);
    assert.equal(s.map, map); assert.equal(s.directions, directions); closed(s);
  }
  const huge = wideTileAt({ world: tile.world, p: '9007199254740993', q: '-9007199254740992', tile: 60 });
  assert.deepEqual(outboundTileHit(tile.world, huge), huge);
  assert.throws(() => outboundHitDirection(s.source, s.directions, huge), { code: 'AdjacentTileRequired' });
});

test('all six original boundary corners project only original anchors plus bounded relative offsets', () => {
  const w = world(), base = w.fs.expeditionCompose.source;
  for (const [p, q] of [[128, 0], [0, 128], [-128, 128], [-128, 0], [0, -128], [128, -128]]) {
    for (const tile of [0, 4, 30, 56, 60]) for (let direction = 0; direction < 6; direction++) {
      const src = { ...base, origin: { p: String(p), q: String(q), tile } };
      const route = outboundMapGeometry(src, [direction]), origin = tileHex(p, q, tile), delta = DIRECTIONS[direction];
      assert.deepEqual(route.hexes, [origin, { q: origin.q + delta[0], r: origin.r + delta[1] }]);
      assert.equal(BigInt(route.endpoint.tileQ), BigInt(route.hexes[1].q));
      assert.equal(BigInt(route.endpoint.tileR), BigInt(route.hexes[1].r));
      assert.equal(route.world, base.world); assert.equal(route.host, base.host);
      for (const c of route.next) { assert.equal(BigInt(c.tile.tileQ), BigInt(c.hex.q)); assert.equal(BigInt(c.tile.tileR), BigInt(c.hex.r)); }
    }
  }
  assert.throws(() => outboundMapGeometry({ ...base, origin: { p: '9007199254740993', q: '0', tile: 30 } }, []), { code: 'OriginalOriginRequired' });
});

test('32-step and four-entered-province bounds constrain map candidates and edits without terrain assertions', () => {
  const w = world();
  for (let i = 0; i < 32; i++) assert.equal(tapOutbound(w.fs, w.ctx, nextTile(w, i % 2 ? 3 : 0)).changed, true);
  const model = readOutboundMap(w.fs, w.ctx); assert.equal(model.next.length, 0); assert.equal(model.hexes.length, 33);
  const end = model.endpoint, tile = wideTileAt({ world: end.world, p: '129', q: '0', tile: nextTile(world()).tile });
  assert.equal(tapOutbound(w.fs, w.ctx, tile).code, 'PathTooLong');
  assert.equal(w.fs.expeditionCompose.directions.length, 32);
  for (const key of ['terrainVerified', 'costVerified', 'arrivalVerified', 'executable', 'admitted']) assert.equal(model[key], false);
  const v = world(); let refused = false;
  for (let i = 0; i < 32; i++) {
    const s = v.fs.expeditionCompose, old = s.map;
    if (!old.next.some(c => c.direction === 0)) {
      assert.equal(editOutbound(v.fs, v.ctx, 'step', 0), false); assert.equal(s.error, 'PathProvinces');
      assert.equal(s.map, old); refused = true; break;
    }
    tapOutbound(v.fs, v.ctx, old.next.find(c => c.direction === 0).tile);
  }
  assert.equal(refused, true);
});

test('undo/reset updates real overlay and close/reopen cannot reuse a prior draft', () => {
  const w = world(), first = readOutboundMap(w.fs, w.ctx);
  tapOutbound(w.fs, w.ctx, nextTile(w)); const route = readOutboundMap(w.fs, w.ctx); assert.notEqual(route, first);
  editOutbound(w.fs, w.ctx, 'undo'); assert.equal(readOutboundMap(w.fs, w.ctx).hexes.length, 1);
  tapOutbound(w.fs, w.ctx, nextTile(w)); editOutbound(w.fs, w.ctx, 'reset');
  assert.equal(readOutboundMap(w.fs, w.ctx).hexes.length, 1); assert.equal(w.fs.expeditionCompose.review, null);
  clearOutbound(w.fs); w.fs.hand.pop = null;
  assert.equal(readOutboundMap(w.fs, w.ctx), null); assert.equal(tapOutbound(w.fs, w.ctx, route.endpoint).handled, false);
  w.fs.hand.pop = OUTBOUND_POP; openOutbound(w.fs, w.ctx);
  assert.equal(readOutboundMap(w.fs, w.ctx).hexes.length, 1); assert.notEqual(readOutboundMap(w.fs, w.ctx), first);
});

test('source/owner/clock/session/mode/selected-host invalidation clears the overlay before read or tap', () => {
  const changes = [w => { w.fs.nowBell++; }, w => { w.fs.session = {}; }, w => { w.ctx.source = {}; },
    w => { w.ctx.relay = '/other'; }, w => { w.h.gen++; }, w => { w.province.entries[0].tile--; },
    w => { w.fs.wallet = { address: WALLET }; }, w => { w.fs.selected.idx--; }, w => { w.fs.hand.host = null; },
    w => { w.fs.mode = 'spectate'; }, w => { w.fs.sample = {}; }, w => { w.fs.proto = {}; }, w => { w.fs.wideSelect = {}; }];
  for (const change of changes) {
    const w = world(), hit = nextTile(w); tapOutbound(w.fs, w.ctx, hit); change(w);
    assert.equal(readOutboundMap(w.fs, w.ctx), null); assert.equal(w.fs.expeditionCompose.map, null);
    assert.deepEqual(tapOutbound(w.fs, w.ctx, hit), { handled: true, changed: false, code: 'SourceChanged' });
    assert.deepEqual(w.fs.expeditionCompose.directions, []); closed(w.fs.expeditionCompose);
  }
});

test('real controller map tap and existing button/bind routes share one draft and invalidate map/panel only', () => {
  const saved = { ...STORE }, fetchBefore = globalThis.fetch; let requests = 0, mapDraws = 0, panels = 0;
  try {
    globalThis.fetch = () => { requests++; throw new Error('Unexpected network'); };
    registerRenderers([['map', () => mapDraws++], ['panel', () => panels++]]);
    const w = world(); io.setPin({ programId: PROGRAM, cluster: 'localnet', seasonId: '1' }); CTRL.useHerald({});
    Object.assign(STORE, w.fs); CTRL.openOriginalOutbound(); flush();
    const first = CTRL.originalOutboundMap(), tile = first.next.find(c => c.direction === 0).tile;
    assert.equal(CTRL.tapOriginalOutbound(hitOf(tile)).changed, true); flush();
    CTRL.bind('outbound-arriveBell', '44'); flush();
    assert.equal(STORE.expeditionCompose.review.endpoint.key, tile.key);
    assert.equal(CTRL.originalOutboundMap().hexes.length, 2); assert.ok(mapDraws >= 3); assert.ok(panels >= 3);
    CTRL.editOriginalOutbound('undo'); assert.equal(CTRL.originalOutboundMap().hexes.length, 1);
    STORE.nowBell++; assert.equal(CTRL.originalOutboundMap(), null);
    assert.equal(CTRL.tapOriginalOutbound(tile).code, 'SourceChanged'); assert.equal(requests, 0);
  } finally {
    CTRL.useHerald(null); for (const k of Object.keys(STORE)) delete STORE[k]; Object.assign(STORE, saved);
    globalThis.fetch = fetchBefore; registerRenderers([['map', () => {}], ['panel', () => {}]]);
  }
});

function boundMap(w) {
  const handlers = new Map(), size = { width: 800, height: 600 }, tile = nextTile(w), h = hitOf(tile), at = project(h.tileQ, h.tileR);
  const results = [], view = { ...at, zoom: 1 };
  const map = Object.create(FrontierMap.prototype);
  Object.assign(map, { canvas: { addEventListener: (name, fn) => handlers.set(name, fn), setPointerCapture() {} },
    opened: {}, cam: { userMoved: false, halt: () => false, view, drawn: view }, pointers: new Map(),
    geo: () => ({ toStage: (x, y) => ({ x, y }) }), size: () => size,
    source: () => ({ outboundRoute: readOutboundMap(w.fs, w.ctx), outboundInput: w.fs.hand?.pop === OUTBOUND_POP ? w.fs.expeditionCompose.map ?? w.fs.expeditionCompose : null }),
    hostAt: () => { throw new Error('Legacy host hit must not run'); }, keeps: { on: false },
    onSelect: hit => results.push(tapOutbound(w.fs, w.ctx, hit)), lod: 'tile',
    pick: { stale: true }, pickTap: () => { throw new Error('Legacy picker must not run'); }, pickKey: () => { throw new Error('Legacy picker key must not run'); } });
  map.bind();
  const fire = (name, data = {}) => handlers.get(name)({ type: name, pointerId: 1, offsetX: 400, offsetY: 300, timeStamp: 10, preventDefault() {}, ...data });
  return { map, fire, results, hit: h };
}

test('real canvas pointer handlers append ground tiles once, bypass figure/keep/picker remapping', () => {
  const w = world(), b = boundMap(w);
  b.fire('pointerdown'); b.fire('pointerup'); assert.equal(b.results.length, 1); assert.equal(b.results[0].changed, true);
  b.fire('pointerup'); assert.equal(b.results.length, 1, 'duplicate up has no active press');
  b.fire('pointerdown'); b.fire('pointerup'); assert.equal(b.results.at(-1).code, 'EndpointSelected');
  assert.deepEqual(w.fs.expeditionCompose.directions, [0]);
});

test('real canvas keyboard Enter uses the same single-step path and cannot invoke a stale picker', () => {
  const w = world(), b = boundMap(w);
  b.fire('keydown', { key: 'Enter' }); b.fire('keydown', { key: 'Enter', repeat: true });
  assert.equal(b.results[0].changed, true); assert.equal(b.results[1].code, 'EndpointSelected');
  assert.deepEqual(w.fs.expeditionCompose.directions, [0]);
});

test('pointer-down followed by cancel/close/reopen/edit/source change never reinterprets the old press', () => {
  const changes = [w => { clearOutbound(w.fs); w.fs.hand.pop = null; },
    w => { clearOutbound(w.fs); w.fs.hand.pop = null; w.fs.hand.pop = OUTBOUND_POP; openOutbound(w.fs, w.ctx); },
    w => { editOutbound(w.fs, w.ctx, 'step', 1); }, w => { w.fs.nowBell++; }, w => { w.ctx.source = {}; }];
  for (const change of changes) {
    const w = world(), b = boundMap(w); b.fire('pointerdown'); change(w); b.fire('pointerup');
    assert.equal(b.results.length, 0);
  }
  const w = world(), b = boundMap(w); b.fire('pointerdown'); b.fire('pointercancel'); b.fire('pointerup');
  assert.equal(b.results.length, 0); assert.deepEqual(w.fs.expeditionCompose.directions, []);
});

test('normal canvas host and picker behavior is unchanged after the boundary composer closes', () => {
  const w = world(), b = boundMap(w); clearOutbound(w.fs); w.fs.hand.pop = null;
  let picked = 0, hosts = 0; b.map.pickTap = () => picked++; b.map.tap(b.hit);
  assert.equal(picked, 1); b.map.pick = null;
  b.map.hostAt = () => { hosts++; return { id: HOST, p: 128, q: 0, tile: 60 }; };
  b.map.onSelect = hit => { assert.equal(hit.host.id, HOST); assert.equal(hit.idx, 60); };
  b.map.tap(b.hit, { clientX: 10, clientY: 20 }); assert.equal(hosts, 1);
});

test('an open boundary draft keeps the camera from automatic arrival moves, then releases it on close', () => {
  const w = world(), b = boundMap(w); b.map.pick = null;
  assert.equal(b.map.busy(100000), true);
  for (const moment of [true, false]) { b.map.arrivalWant = { moment }; b.map.arrivalEase(100000); assert.equal(b.map.arrivalWant, null); }
  clearOutbound(w.fs); w.fs.hand.pop = null;
  assert.equal(b.map.busy(100000), false);
});

function ink() {
  const lines = [], polygons = [], circles = [], dashes = []; let points = [];
  return { lines, polygons, circles, dashes, ctx: { save() {}, restore() {}, setLineDash: x => dashes.push(x),
    beginPath: () => { points = []; }, moveTo: (x, y) => points.push([x, y]), lineTo: (x, y) => points.push([x, y]),
    closePath: () => polygons.push([...points]), fill() {}, stroke: () => lines.push([...points]), arc: (...x) => circles.push(x) } };
}
test('canvas painter centers candidates at real projected pixels, draws a distinct dashed route, never an arrival', () => {
  const w = world(); tapOutbound(w.fs, w.ctx, nextTile(w)); const model = readOutboundMap(w.fs, w.ctx), out = ink();
  paintOutboundRoute(out.ctx, model, 1);
  assert.equal(out.polygons.length, model.next.length);
  for (let i = 0; i < model.next.length; i++) {
    const x = out.polygons[i].reduce((sum, p) => sum + p[0], 0) / 6, y = out.polygons[i].reduce((sum, p) => sum + p[1], 0) / 6;
    const p = project(model.next[i].hex.q, model.next[i].hex.r);
    assert.ok(Math.abs(x - p.x) < 1e-8); assert.ok(Math.abs(y - p.y) < 1e-8);
  }
  assert.deepEqual(out.lines[0], model.hexes.map(h => { const p = project(h.q, h.r); return [p.x, p.y]; }));
  assert.deepEqual(out.dashes[0], [5, 5]); assert.equal(out.circles.length, 1);
  const far = ink(); paintOutboundRoute(far.ctx, model, 0.1, { tiles: false }); assert.equal(far.polygons.length, 0);
  assert.equal(typeof paintRoute, 'function'); // Ordinary painter remains a separate export.
});

test('app connects one early handler and overlay without widening legacy selection or exposing dispatch', () => {
  const app = source('app.mjs'), control = source('controller.mjs'), renderer = source('map/fmap.mjs'), adapter = source('map/outboundroute.mjs');
  const selection = app.slice(app.indexOf('onSelect: hit0 => {'), app.indexOf('onView: (_, lod)'));
  assert.equal((selection.match(/tapOriginalOutbound\(hit\)/g) ?? []).length, 1);
  assert.ok(selection.indexOf('tapOriginalOutbound(hit)') < selection.indexOf('hostUnderPress()'));
  assert.ok(selection.indexOf('if (outbound.handled)') < selection.indexOf('mapTap(hit)'));
  assert.match(app, /outboundRoute: originalOutboundMap\(\)/); assert.match(app, /outboundInput: FS\.hand\?\.pop === OUTBOUND_POP/);
  assert.match(control, /tapOriginalOutbound = hit => [^\n]*outbound\.tapOutbound/);
  assert.match(renderer, /d\.outbound !== \(this\.source\?\.\(\)\?\.outboundInput \?\? null\)/);
  assert.match(renderer, /paintOutboundRoute\(ctx, src\.outboundRoute/);
  assert.doesNotMatch(adapter, /(?:planRoute\(|plan_path|sealMarch|randomBytes|randomUUID|fetch\(|new Worker|\.sign\(|sendMarch|provinceIndex\()/);
  assert.doesNotMatch(adapter, /Number\((?:at|trace\.endpoint|source\.host|hit)\./);
  assert.match(renderer, /if \(src\.route\?\.hexes\?\.length > 1\) \{ paintRoute/);
});

test('new boundary-map guidance and unverified labels have exact English translations', () => {
  const app = source('app.mjs'), renderer = source('map/fmap.mjs');
  const keys = ['地図の破線のマスを押すと一歩追加します。「地形・時間を確認」で道の記録を読み取れます。',
    '拡大した地図で、終点に隣り合う破線のマスを押してください。', '道に一歩追加しました。地形・移動時間は未検証です。',
    '出発点の情報が変わりました。境界への道を開き直してください。', '道の形は 32 マス・4 州までです。',
    '終点に隣り合う破線のマスを押してください。軍勢の選択は変わりません。', '道の形だけ · 地形・移動時間は未検証'];
  for (const key of keys) { assert.ok(app.includes(key) || renderer.includes(key)); assert.equal(typeof EN[key], 'string'); assert.notEqual(EN[key], key); }
});
