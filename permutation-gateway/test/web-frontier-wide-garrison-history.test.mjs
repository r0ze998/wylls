// Literal wire fixtures only. Public hash, no key, network or transaction.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encode } from '../../permutation-server/web/sdk/base58.mjs';
import { worldIdOf } from '../../permutation-server/web/frontier/map/wide.mjs';
import { parseWideIndexPage } from '../../permutation-server/web/frontier/map/widehistory.mjs';

const pins = { programId: encode(new Uint8Array(32).fill(23)), seasonAddress: encode(new Uint8Array(32).fill(24)), seasonId: '11' };
const world = worldIdOf(pins.seasonAddress, pins.programId), snapshot = 'ab'.repeat(32);
function fixture() {
  const body = Buffer.alloc(227);
  body[0] = 0x82; body[1] = 17; body[6] = 1;
  Buffer.from(world, 'hex').copy(body, 7);
  body.writeBigUInt64BE(129n, 39); body[56] = 3; body[57] = 1;
  body[62] = 1; body.writeBigInt64LE(123n, 63); body.writeBigInt64LE(-9007199254740993n, 71);
  body[79] = 1; body.fill(0x12, 80, 112); body.fill(0x34, 112, 144);
  body[144] = 2; body[145] = 1; body[186] = 2;
  body.writeBigUInt64LE(0xffffffffffffffffn, 146); body.writeBigUInt64LE(2n, 187);
  const province = { world, p: '129', q: '0', keyHex: body.subarray(6,56).toString('hex') };
  const row = { event: '1', archiveSequence: '1', ordinal: '0', format: 'PSW1', kind: 17, name: 'WIDE_GARRISON', province,
    holding: { ...province, keyHex: body.subarray(6,62).toString('hex'), site: 3, generation: 1, hostSequence: 0 }, host: null };
  return { body, row };
}
function parse(edit = () => {}) {
  const f = fixture(); edit(f); f.row.body_b64 = f.body.toString('base64');
  return parseWideIndexPage({ v: 1, experimental: true, readOnly: true, program: pins.programId, seasonAddress: pins.seasonAddress,
    season: '11', world, snapshot, indexedThrough: '1', sourceCoverage: 'unknown', captureVerification: 'unverified',
    after: '0', next: '1', more: false, limit: 20, events: [f.row] }, { pins, through: 1n, snapshot });
}
test('Garrison is an exact holding-only, captured-unverified observation', () => {
  const p = parse(), r = p.rows[0];
  assert.equal(r.host, null); assert.equal(r.economy, null);
  assert.equal(r.garrison.delta, 123n); assert.equal(r.garrison.nowTs, -9007199254740993n);
  assert.equal(r.garrison.becameFinal, true); assert.equal(r.garrison.inputDigest, '12'.repeat(32));
  assert.equal(r.garrison.outputDigest, '34'.repeat(32));
  assert.equal(r.garrison.links[0].sequence, 0xffffffffffffffffn);
  assert.equal(p.captureVerification, 'unverified'); assert.equal(p.sourceCoverage, 'unknown');
  assert.deepEqual(Buffer.from(r.body), fixture().body);
  assert.equal(parse(({body}) => body.writeBigInt64LE(0xffffffffn,63)).rows[0].garrison.delta, 0xffffffffn);
});
test('Garrison rejects schema aliases, invalid receipts and altered attribution', () => {
  for (const edit of [
    f => { f.body = f.body.subarray(0,225); }, f => { f.body = Buffer.concat([f.body, Buffer.alloc(1)]); },
    ({body}) => { body[62] = 2; }, ({body}) => { body[79] = 2; },
    ...[0n,-1n,0x100000000n].map(n => ({body}) => body.writeBigInt64LE(n,63)),
    ({body}) => { body[144] = 1; }, ({body}) => { body[145] = 2; }, ({body}) => { body[186] = 1; },
    ({body}) => { body[58] = 1; }, ({row}) => { row.host = row.holding; },
    ({row}) => { row.holding = null; }, ({row}) => { row.name = 'WIDE_ECONOMY_MIRROR'; },
    ({body,row}) => { body[1] = 16; row.kind = 16; row.name = 'WIDE_ECONOMY_MIRROR'; },
  ]) assert.throws(() => parse(edit), e => e.code === 'BadWideHistory');
});
