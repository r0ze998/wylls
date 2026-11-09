// Pure public plaintext and lattice vectors only. Run this exact file with
// scripts/ci/no-keys-guard.mjs. No application boot, seal operation or network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { encode } from '../../permutation-server/web/sdk/base58.mjs';
import { worldIdOf, WIDE_BOUND } from '../../permutation-server/web/frontier/map/wide.mjs';
import { WIDE_PLAIN_LEN, WIDE_PLAIN_OFFSETS, TILE_COORD_BOUND, ExpeditionSealError,
  canonicalWideProvinceKey, decodeWideProvinceKey, canonicalOriginalHostRef, decodeWideHostRef,
  packWidePlain, unpackWidePlain, validateWidePlain, encodeWideDirections,
  wideTileAt, locateWideTile, traceWideDirections, prepareOriginalOutboundPlain,
} from '../../permutation-server/web/frontier/fexpedition-seal.mjs';

const WORLD = '77'.repeat(32), OTHER_WORLD = '78'.repeat(32);
const PROGRAM = encode(new Uint8Array(32).fill(0x12)), SEASON = encode(new Uint8Array(32).fill(0x34));
const SEASON_WORLD = worldIdOf(SEASON, PROGRAM);
const key = (p, q, world = WORLD) => canonicalWideProvinceKey({ world, p: String(p), q: String(q) });
const host = (world = WORLD, p = '128', q = '0') => canonicalOriginalHostRef({ world, p, q, site: 3, gen: 1, seq: 7 });
const error = (code, fn) => assert.throws(fn, e => e instanceof ExpeditionSealError && e.code === code);
const refused = fn => assert.throws(fn, ExpeditionSealError);
const hex = b => Buffer.from(b).toString('hex');
const mutate = (s, offset, value) => { const b = Buffer.from(s, 'hex'); b[offset] = value; return hex(b); };
const sample = () => ({ version: 2, host: host(), arriveBell: 500, dest: key(129, 0), destTile: 4,
  stance: 2, retreatBps: 0, ...encodeWideDirections([0]), reserved: '00'.repeat(8) });
const outbound = () => ({ program: PROGRAM, season: SEASON, host: host(SEASON_WORLD),
  origin: { p: '128', q: '0', tile: 60 }, directions: [0], arriveBell: 500, stance: 2, retreatBps: 60000 });

// Independent literal field bytes from seal.rs::sample(), not a sealer fixture.
const RUST_SAMPLE = {
  version: 2, host: '01' + '77'.repeat(32) + '0000000000000081000000000000000000' + '030107000000',
  arriveBell: 500, dest: '01' + '77'.repeat(32) + '0000000000000082050000000000000081',
  destTile: 60, stance: 2, retreatBps: 0, pathLen: 8, path: '88c6a2000000000000000000', reserved: '0000000000000000',
};
const RUST_SAMPLE_HEX = '02' + RUST_SAMPLE.host + 'f4010000' + RUST_SAMPLE.dest
  + '3c02000008' + '88c6a2000000000000000000' + '0000000000000000';

test('WidePlain packs the exact Rust sample and every fixed offset into 136 bytes', () => {
  assert.equal(WIDE_PLAIN_LEN, 136);
  assert.deepEqual(WIDE_PLAIN_OFFSETS, { version: 0, host: 1, arriveBell: 57, dest: 61,
    destTile: 111, stance: 112, retreatBps: 113, pathLen: 115, path: 116, reserved: 128 });
  const packed = packWidePlain(RUST_SAMPLE);
  assert.equal(packed.length, 136); assert.equal(hex(packed), RUST_SAMPLE_HEX);
  assert.deepEqual(unpackWidePlain(packed), RUST_SAMPLE);
  assert.equal(validateWidePlain(RUST_SAMPLE, { host: RUST_SAMPLE.host, arriveBell: 500 }), true);
  assert.deepEqual(encodeWideDirections([0, 1, 2, 3, 4, 5, 0, 5]), { pathLen: 8, path: RUST_SAMPLE.path });
});

test('pack/unpack preserve typed invalid semantics; validation refuses every Rust constraint', () => {
  const p = sample(), expected = { host: p.host, arriveBell: p.arriveBell };
  for (const [code, change] of [
    ['Version', { version: 1 }], ['Reserved', { reserved: '0000000000000001' }],
    ['HostMismatch', { host: mutate(p.host, 55, 1) }], ['ArriveMismatch', { arriveBell: 501 }],
    ['WorldMismatch', { dest: key(129, 0, OTHER_WORLD) }], ['PathTooLong', { pathLen: 33 }],
    ['PathBits', { path: '000000000000000000000080' }], ['Direction', { path: '060000000000000000000000' }],
    ['Direction', { path: '070000000000000000000000' }], ['Tile', { destTile: 61 }],
    ['Stance', { stance: 4 }], ['Retreat', { retreatBps: 60001 }],
  ]) {
    const changed = { ...p, ...change }, decoded = unpackWidePlain(packWidePlain(changed));
    assert.deepEqual(decoded, changed); error(code, () => validateWidePlain(decoded, expected));
  }
  assert.equal(validateWidePlain({ ...p, retreatBps: 60000 }, expected), true);
  assert.equal(validateWidePlain({ ...p, dest: key(0, 0) }, expected), true, 'codec does not invent a boundary rule');
});

test('host and destination identity codecs refuse malformed, noncanonical and out-of-world bytes', () => {
  const p = sample();
  for (const bad of [p.host.slice(2), p.host + '00', host('ab'.repeat(32)).toUpperCase(), mutate(p.host, 0, 2),
    mutate(p.host, 50, 12), '01' + '00'.repeat(32) + p.host.slice(66)]) refused(() => decodeWideHostRef(bad));
  for (const bad of [p.dest.slice(2), p.dest + '00', mutate(p.dest, 0, 9), mutate(p.dest, 41, 6),
    '01' + '00'.repeat(32) + p.dest.slice(66), '01' + WORLD + '0000000000000000000000000000000001',
    '01' + WORLD + '0000000000000000010000000000000000',
    '01' + WORLD + '0000000000000081000000000000000081',
    '01' + WORLD + 'ffffffffffffffff000000000000000000']) refused(() => decodeWideProvinceKey(bad));
  for (const offset of [1, 61]) {
    const b = packWidePlain(p); b[offset] = 0; refused(() => unpackWidePlain(b));
  }
  for (const n of [0, 37, 135, 137, 264]) error('PlainLength', () => unpackWidePlain(new Uint8Array(n)));
  error('PlainLength', () => unpackWidePlain(Array.from(packWidePlain(p))));
});

test('canonical full identity roundtrips negative and huge coordinates without numeric aliases', () => {
  for (const [p, q] of [['0', '0'], ['128', '0'], ['129', '-1'], ['-129', '1'],
    ['9007199254740993', '-9007199254740992'], [String(WIDE_BOUND), String(WIDE_BOUND)],
    [String(-WIDE_BOUND), String(-WIDE_BOUND)]]) {
    const got = decodeWideProvinceKey(key(p, q)); assert.equal(got.p, p); assert.equal(got.q, q);
  }
  for (const p of [129, 129n, '-0', '00', '+1', '1e2', ' 1', String(WIDE_BOUND + 1n)]) refused(() => canonicalWideProvinceKey({ world: WORLD, p, q: '0' }));
  error('OriginalHostRequired', () => canonicalOriginalHostRef({ world: WORLD, p: '129', q: '0', site: 0, gen: 0, seq: 0 }));
  const h = decodeWideHostRef(host(WORLD, '-128', '0'));
  assert.deepEqual([h.p, h.q, h.site, h.gen, h.seq], ['-128', '0', 3, 1, 7]);
  for (const fields of [{ site: 12 }, { site: -1 }, { gen: 256 }, { gen: 1.5 }, { seq: 0x100000000 }, { seq: '7' }])
    refused(() => canonicalOriginalHostRef({ world: WORLD, p: '1', q: '0', site: 0, gen: 0, seq: 0, ...fields }));
});

test('fields never silently wrap, coerce, truncate or reuse the legacy 37-byte codec', () => {
  const p = sample();
  for (const change of [{ arriveBell: -1 }, { arriveBell: 0x100000000 }, { arriveBell: '500' },
    { destTile: 256 }, { stance: NaN }, { retreatBps: 65536 }, { pathLen: -1 }, { version: 256 },
    { path: '00' }, { path: 'AA'.repeat(12) }, { reserved: '0'.repeat(15) }]) refused(() => packWidePlain({ ...p, ...change }));
  const high = { ...p, arriveBell: 0xffffffff }; assert.deepEqual(unpackWidePlain(packWidePlain(high)), high);
});

test('all 32 path slots use the deployed bit order including bytes split across steps', () => {
  for (let n = 0; n <= 32; n++) {
    const dirs = Array.from({ length: n }, (_, i) => i % 6), encoded = encodeWideDirections(dirs);
    const p = { ...sample(), ...encoded }; assert.equal(validateWidePlain(p, p), true);
    const b = Buffer.from(encoded.path, 'hex');
    const bits = [...b].reduce((acc, byte, i) => acc | (BigInt(byte) << BigInt(8 * i)), 0n);
    for (let i = 0; i < n; i++) assert.equal(Number((bits >> BigInt(3 * i)) & 7n), dirs[i]);
    assert.equal(bits >> BigInt(3 * n), 0n);
  }
  for (const bad of [[6], [7], [-1], ['0'], [0.5], new Array(1), Array(33).fill(0), '0', null]) refused(() => encodeWideDirections(bad));
  const p = { ...sample(), pathLen: 0, path: '010000000000000000000000' }; error('PathBits', () => validateWidePlain(p, p));
});

test('tile addresses roundtrip all 61 indices at the origin, negatives and far corners', () => {
  for (const [p, q] of [['0', '0'], ['128', '0'], ['129', '-1'], ['-130', '-71'],
    ['9007199254740993', '-9007199254740992'], [String(WIDE_BOUND), String(WIDE_BOUND)],
    [String(-WIDE_BOUND), String(-WIDE_BOUND)], [String(WIDE_BOUND), String(-WIDE_BOUND)]]) {
    for (let tile = 0; tile < 61; tile++) {
      const t = wideTileAt({ world: WORLD, p, q, tile });
      assert.deepEqual(locateWideTile(t), t);
      assert.equal(typeof t.tileQ, 'string'); assert.equal(typeof t.tileR, 'string');
    }
  }
  const t = wideTileAt({ world: WORLD, p: String(WIDE_BOUND), q: String(WIDE_BOUND), tile: 30 });
  assert.equal(t.tileQ, String(13n * WIDE_BOUND)); assert.equal(t.tileR, String(WIDE_BOUND));
  const neg = wideTileAt({ world: WORLD, p: String(-WIDE_BOUND), q: String(-WIDE_BOUND), tile: 0 });
  assert.equal(neg.tileQ, String(-TILE_COORD_BOUND)); assert.deepEqual(locateWideTile(neg), neg);
});

test('Rust tiles.rs boundary vector crosses ring128→129 exactly without assuming origin entered', () => {
  const route = traceWideDirections({ world: WORLD, origin: { p: '128', q: '0', tile: 60 }, directions: [0, 0] });
  assert.deepEqual([route.origin.tileQ, route.origin.tileR], ['1156', '-512']);
  assert.deepEqual(route.steps.map(t => [t.p, t.q, t.tile, t.tileQ, t.tileR]), [
    ['129', '0', 4, '1157', '-512'], ['129', '0', 10, '1158', '-512'],
  ]);
  assert.deepEqual(route.accountKeys, [key(129, 0)]);
  assert.equal(route.pathComplete, true); assert.equal(route.executable, false); assert.equal(route.admitted, false);
  assert.equal(route.verification, 'geometry-only');
});

test('empty preview transitions to first step, and original standing is included only when entered', () => {
  const origin = { p: '128', q: '0', tile: 60 };
  const zero = traceWideDirections({ world: WORLD, origin, directions: [] });
  assert.deepEqual(zero.origin, zero.endpoint); assert.deepEqual(zero.accountKeys, []); assert.deepEqual(zero.steps, []);
  assert.equal(zero.pathComplete, false);
  const one = traceWideDirections({ world: WORLD, origin, directions: [0] });
  assert.deepEqual(one.accountKeys, [key(129, 0)]);
  const reenter = traceWideDirections({ world: WORLD, origin, directions: [0, 3, 0] });
  assert.deepEqual(reenter.accountKeys, [key(129, 0), key(128, 0)]);
  const inside = traceWideDirections({ world: WORLD, origin: { p: '128', q: '0', tile: 30 }, directions: [0] });
  assert.deepEqual(inside.accountKeys, [key(128, 0)]);
});

test('account order is destination-first then first entered, with no fifth province or 33rd step', () => {
  const origin = { p: '0', q: '0', tile: 30 };
  const route = traceWideDirections({ world: WORLD, origin, directions: Array(23).fill(0) });
  assert.deepEqual(route.accountKeys, [key(2, 1), key(0, 0), key(1, 0), key(1, 1)]);
  error('PathProvinces', () => traceWideDirections({ world: WORLD, origin, directions: Array(24).fill(0) }));
  error('PathTooLong', () => traceWideDirections({ world: WORLD, origin, directions: Array(33).fill(0) }));
  const backAndForth = Array.from({ length: 32 }, (_, i) => i % 2 ? 3 : 0);
  assert.equal(traceWideDirections({ world: WORLD, origin, directions: backAndForth }).steps.length, 32);
});

test('trace enforces exact expected endpoint and world, with canonical decimal coordinates only', () => {
  const input = { world: WORLD, origin: { p: '128', q: '0', tile: 60 }, directions: [0] };
  assert.equal(traceWideDirections({ ...input, destination: { p: '129', q: '0', tile: 4 } }).endpoint.tile, 4);
  for (const destination of [{ p: '129', q: '0', tile: 5 }, { p: '128', q: '0', tile: 4 }])
    error('EndpointMismatch', () => traceWideDirections({ ...input, destination }));
  error('WorldMismatch', () => traceWideDirections({ ...input, origin: { ...input.origin, world: OTHER_WORLD } }));
  error('WorldMismatch', () => traceWideDirections({ ...input, destination: { world: OTHER_WORLD, p: '129', q: '0', tile: 4 } }));
  for (const tile of [-1, 61, '60', 1.5]) error('Tile', () => traceWideDirections({ ...input, origin: { ...input.origin, tile } }));
  for (const tileQ of [1, '01', '-0', '+1', '1e3']) error('TileCoord', () => locateWideTile({ world: WORLD, tileQ, tileR: '0' }));
});

test('world edge refuses outside tiles and crossing directions; it never wraps', () => {
  const corner = { p: String(WIDE_BOUND), q: String(WIDE_BOUND), tile: 60 };
  error('OutOfWorld', () => traceWideDirections({ world: WORLD, origin: corner, directions: [0] }));
  error('OutOfWorld', () => traceWideDirections({ world: WORLD,
    origin: { p: String(-WIDE_BOUND), q: String(-WIDE_BOUND), tile: 0 }, directions: [3] }));
  for (const tileQ of [String(TILE_COORD_BOUND + 1n), String(-TILE_COORD_BOUND - 1n)])
    error('OutOfWorld', () => locateWideTile({ world: WORLD, tileQ, tileR: '0' }));
  error('OutOfWorld', () => locateWideTile({ world: WORLD, tileQ: '0', tileR: String(TILE_COORD_BOUND) }));
});

test('outbound review binds host, actual original standing and derived season world, without admission', () => {
  const input = outbound(), r = prepareOriginalOutboundPlain(input), plain = unpackWidePlain(Buffer.from(r.plainHex, 'hex'));
  assert.equal(r.kind, 'original-outbound-plaintext-review'); assert.equal(r.world, SEASON_WORLD);
  assert.equal(plain.host, input.host); assert.equal(plain.dest, r.endpoint.key); assert.equal(plain.destTile, 4);
  assert.equal(plain.arriveBell, 500); assert.equal(plain.stance, 2); assert.equal(plain.retreatBps, 60000);
  assert.equal(validateWidePlain(plain, input), true);
  for (const field of ['executable', 'admitted', 'terrainVerified', 'costVerified', 'arrivalVerified']) assert.equal(r[field], false);
  for (const field of ['instruction', 'transaction', 'seal', 'commit', 'salt', 'signature', 'cost', 'travelSecs']) assert.equal(field in r, false);
  const otherIssuer = prepareOriginalOutboundPlain({ ...input, host: host(SEASON_WORLD, '2', '-1') });
  assert.equal(decodeWideHostRef(otherIssuer.host).p, '2'); assert.equal(otherIssuer.origin.p, '128');
  const movedOrigin = prepareOriginalOutboundPlain({ ...input, origin: { ...input.origin, tile: 59 } });
  assert.equal(movedOrigin.origin.tile, 59); assert.notEqual(movedOrigin.plainHex, r.plainHex);
});

test('outbound refuses non-boundary, wrong-world, malformed and non-original inputs', () => {
  const input = outbound();
  for (const program of ['', 'bad', '1'.repeat(32), PROGRAM + '1']) error('PublicAddress', () => prepareOriginalOutboundPlain({ ...input, program }));
  error('PublicAddress', () => prepareOriginalOutboundPlain({ ...input, season: PROGRAM }));
  error('WorldMismatch', () => prepareOriginalOutboundPlain({ ...input, host: host(OTHER_WORLD) }));
  error('EmptyPath', () => prepareOriginalOutboundPlain({ ...input, directions: [] }));
  error('WideDestinationRequired', () => prepareOriginalOutboundPlain({ ...input, directions: [3] }));
  error('OriginalOriginRequired', () => prepareOriginalOutboundPlain({ ...input, origin: { p: '129', q: '0', tile: 30 } }));
  error('OriginalHostRequired', () => prepareOriginalOutboundPlain({ ...input, host: key(129, 0, SEASON_WORLD) + '030107000000' }));
  for (const change of [{ stance: 4 }, { retreatBps: 60001 }, { arriveBell: -1 }, { directions: [6] }]) refused(() => prepareOriginalOutboundPlain({ ...input, ...change }));
});

test('review output is detached and deeply immutable; mutable packed bytes never alias it', () => {
  const input = outbound(), r = prepareOriginalOutboundPlain(input);
  assert.ok(Object.isFrozen(r) && Object.isFrozen(r.steps) && Object.isFrozen(r.steps[0]) && Object.isFrozen(r.accountKeys));
  input.directions.push(3); input.origin.tile = 30;
  assert.equal(r.directions.length, 1); assert.equal(r.origin.tile, 60);
  assert.throws(() => { r.admitted = true; }, TypeError);
  assert.throws(() => { r.steps[0].tile = 0; }, TypeError);
  assert.throws(() => { r.accountKeys.push(key(0, 0)); }, TypeError);
  const plain = unpackWidePlain(Buffer.from(r.plainHex, 'hex')), b = packWidePlain(plain);
  b[0] = 99; assert.equal(plain.version, 2); assert.equal(r.plainHex.slice(0, 2), '02');
});

test('new leaf has only pure public imports and no admission, dispatch or legacy seal dependency', () => {
  const source = readFileSync(new URL('../../permutation-server/web/frontier/fexpedition-seal.mjs', import.meta.url), 'utf8');
  const imports = [...source.matchAll(/from '([^']+)'/g)].map(m => m[1]);
  assert.deepEqual(imports, ['../sdk/bytes.mjs', '../sdk/base58.mjs', './map/wide.mjs']);
  assert.doesNotMatch(source, /\b(?:fetch|WebSocket|Worker|Transaction|randomBytes|getRandomValues)\s*\(/);
  assert.doesNotMatch(source, /\b(?:executable|admitted|terrainVerified|costVerified|arrivalVerified)\s*:\s*true/);
});

// Required, immutable public output of the Rust contract test. Missing or altered
// vectors fail; they are never replaced by JS-generated expected values or skipped.
const RUST_VECTORS = JSON.parse(readFileSync(new URL(
  '../../frontier-node/crates/fclient/tests/fixtures/original_outbound_v1.json', import.meta.url), 'utf8'));

test('required Rust original-outbound fixtures match all136 bytes, identity and trace rows', () => {
  assert.equal(RUST_VECTORS.schema, 1);
  assert.equal(RUST_VECTORS.provenance, 'synthetic-public-codec-vectors-not-native-execution');
  assert.deepEqual(RUST_VECTORS.plain.map(x => x.name), [
    'boundary-128-to-129', 'different-issuer-and-current-origin', 'negative-original-boundary',
  ]);
  for (const v of RUST_VECTORS.plain) {
    const got = prepareOriginalOutboundPlain(v);
    assert.equal(canonicalOriginalHostRef(v.hostFields), v.hostHex, v.name);
    assert.equal(got.host, v.hostHex, v.name); assert.equal(got.world, v.world, v.name);
    for (const field of ['plainHex', 'pathHex', 'pathLen', 'endpoint', 'steps', 'accountKeys'])
      assert.deepEqual(got[field], v[field], `${v.name}: ${field}`);
    const plain = unpackWidePlain(Buffer.from(v.plainHex, 'hex'));
    assert.equal(validateWidePlain(plain, v), true); assert.equal(hex(packWidePlain(plain)), v.plainHex);
    assert.equal(plain.dest, v.endpoint.key); assert.equal(plain.destTile, v.endpoint.tile);
    assert.equal(plain.path, v.pathHex); assert.equal(plain.arriveBell, v.arriveBell);
  }
});

test('required Rust huge and negative geometry fixtures match endpoint, ordered keys and every step', () => {
  assert.deepEqual(RUST_VECTORS.geometry.map(x => x.name), [
    'positive-past-js-safe-integer', 'negative-past-js-safe-integer', 'empty-path-is-geometry-only',
  ]);
  for (const v of RUST_VECTORS.geometry) {
    const got = traceWideDirections(v);
    for (const field of ['endpoint', 'steps', 'accountKeys']) assert.deepEqual(got[field], v[field], `${v.name}: ${field}`);
    assert.equal(got.pathComplete, v.directions.length > 0);
    assert.equal(got.admitted, false); assert.equal(got.executable, false);
  }
});

test('required Rust generic full-width host plaintext remains lossless but cannot become original outbound', () => {
  assert.deepEqual(RUST_VECTORS.genericPlain.map(x => x.name), ['generic-wide-host-full-width']);
  for (const v of RUST_VECTORS.genericPlain) {
    const plain = { version: 2, host: v.host, arriveBell: v.arriveBell, dest: v.endpoint.key,
      destTile: v.endpoint.tile, stance: v.stance, retreatBps: v.retreatBps,
      pathLen: v.pathLen, path: v.pathHex, reserved: '00'.repeat(8) };
    assert.equal(hex(packWidePlain(plain)), v.plainHex);
    assert.deepEqual(unpackWidePlain(Buffer.from(v.plainHex, 'hex')), plain);
    assert.equal(validateWidePlain(plain, v), true);
    const decoded = decodeWideHostRef(v.host);
    assert.equal(decoded.p, v.hostFields.p); assert.equal(decoded.q, v.hostFields.q);
    error('OriginalHostRequired', () => prepareOriginalOutboundPlain(v));
    error('OriginalHostRequired', () => canonicalOriginalHostRef(v.hostFields));
  }
});
