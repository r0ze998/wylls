// Fixed PUBLIC vectors only. Exact-file execution requires the existing
// scripts/ci/no-keys-guard.mjs and screens/codex/no-key-node.mjs preloads.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { keyCalls } from '../screens/codex/no-key-node.mjs';
import * as outbound from '../../permutation-server/web/frontier/fexpedition-depart.mjs';
import { encode } from '../../permutation-server/web/sdk/base58.mjs';
import { fromHex, toHex } from '../../permutation-server/web/sdk/bytes.mjs';
import { withSeed, seedOf } from '../../permutation-server/web/frontier/faddr.mjs';
import { ringPosition, worldIdOf } from '../../permutation-server/web/frontier/map/wide.mjs';

const { canonicalOutboundRoles } = outbound;
const SYSTEM = '11111111111111111111111111111111';
const address = n => encode(new Uint8Array(32).fill(n));
const citizen = s => withSeed(s.season, seedOf('Citizen', { wallet: s.wallet }), s.program);
function hostHex(world, h) {
  const bytes = new Uint8Array(56), view = new DataView(bytes.buffer);
  const rp = ringPosition(BigInt(h.p), BigInt(h.q));
  bytes[0] = 1; bytes.set(fromHex(world), 1);
  view.setBigUint64(33, rp.ring, false); bytes[41] = rp.wedge; view.setBigUint64(42, rp.pos, false);
  bytes[50] = h.site; bytes[51] = h.gen; view.setUint32(52, h.seq, true);
  return toHex(bytes);
}
function source({ home = { p: '127', q: '0', site: 3, gen: 1, seq: 0 }, origin = { p: '128', q: '0', tile: 30 } } = {}) {
  const s = { program: address(94), season: address(95), wallet: address(65), payer: address(66), home, origin };
  s.world = worldIdOf(s.season, s.program); s.host = hostHex(s.world, home); s.original_owner = citizen(s);
  return s;
}
const roles = (s, transitSlot = 0) => canonicalOutboundRoles(s, { transitSlot });
const refused = f => assert.throws(f, { code: 'OutboundRoleContract' });
const mutateHost = (s, fn) => { const bytes = fromHex(s.host); fn(bytes, new DataView(bytes.buffer)); return { ...s, host: toHex(bytes) }; };
const roleNames = ['actor', 'payer', 'season', 'citizen', 'holding', 'province', 'system', 'holding_province', 'transit'];
// Required, never skipped: this file is shared with the Rust public codec
// test. A synthetic fixture is not native execution or proof of live state.
const golden = JSON.parse(readFileSync(new URL('../../frontier-node/crates/fclient/tests/fixtures/original_outbound_v1.json', import.meta.url), 'utf8'));

test('mandatory Rust-owned public fixture pins all nine addresses and effective privileges', () => {
  assert.equal(golden.schema, 1);
  assert.equal(golden.provenance, 'synthetic-public-codec-vectors-not-native-execution');
  assert.ok(Array.isArray(golden.depart) && golden.depart.length >= 3);
  let distinctHome = false, walletAlias = false, homeAlias = false;
  for (const v of golden.depart) {
    const s = { program: v.program, season: v.season, wallet: v.wallet, payer: v.payer,
      original_owner: v.roles.find(r => r.name === 'citizen').address,
      world: v.world, host: v.host, home: { p: String(v.hostFields.p), q: String(v.hostFields.q),
        site: v.hostFields.site, gen: v.hostFields.gen, seq: v.hostFields.seq },
      origin: { p: String(v.standing.p), q: String(v.standing.q) } };
    const actual = roles(s, v.transitSlot);
    assert.deepEqual(actual, v.roles.map(({ name, address, signer, writable }) => ({ name, address, signer, writable })), v.name);
    assert.deepEqual(actual.map(r => r.name), roleNames);
    distinctHome ||= actual[5].address !== actual[7].address;
    homeAlias ||= actual[5].address === actual[7].address;
    walletAlias ||= actual[0].address === actual[1].address;
  }
  assert.ok(distinctHome && homeAlias && walletAlias, 'fixture covers different issuer/standing and both allowed aliases');
});

test('issuer Holding and current standing Province stay distinct and use original accounts', () => {
  const s = source(), result = roles(s);
  const of = (kind, coord) => withSeed(s.season, seedOf(kind, coord), s.program);
  assert.deepEqual(result.map(r => r.name), roleNames);
  assert.equal(result[4].address, of('Holding', s.home));
  assert.equal(result[5].address, of('Province', s.origin));
  assert.equal(result[7].address, of('Province', s.home));
  assert.notEqual(result[5].address, result[7].address);
  assert.equal(result[0].writable, false); assert.equal(result[7].writable, false);
  assert.deepEqual(result[6], { name: 'system', address: SYSTEM, signer: false, writable: false });
  for (const r of result.filter(r => r.name !== 'system')) assert.notEqual(r.address, SYSTEM);
});

test('only actor/payer and standing/issuer aliases union effective privileges', () => {
  for (const walletAlias of [false, true]) for (const homeAlias of [false, true]) {
    const s = source();
    if (walletAlias) s.payer = s.wallet;
    if (homeAlias) s.origin = { p: s.home.p, q: s.home.q };
    const result = roles(s);
    assert.equal(result[0].writable, walletAlias); assert.equal(result[1].writable, true);
    assert.equal(result[0].signer, true); assert.equal(result[1].signer, true);
    assert.equal(result[7].writable, homeAlias); assert.equal(result[5].writable, true);
    for (const r of result.slice(2)) assert.equal(r.signer, false);
  }
});

test('transit derives from the owned original Holding and slot, not host generation or a wide Holding', () => {
  const s = source(), variants = [0, 1, 2, 3].map(slot => roles(s, slot));
  assert.equal(new Set(variants.map(r => r[8].address)).size, 4);
  assert.equal(new Set(variants.map(r => r[4].address)).size, 1);
  const changed = source({ home: { ...s.home, gen: 255, seq: 0xffffffff } });
  for (let slot = 0; slot < 4; slot++) assert.deepEqual(roles(changed, slot), variants[slot]);
  for (const slot of [undefined, null, -1, 4, 255, 1.5, '0', NaN, Infinity, 0n]) refused(() => canonicalOutboundRoles(s, { transitSlot: slot }));
  refused(() => canonicalOutboundRoles(s));
});

test('canonical full host is authoritative; forged supplied home/holding never chooses accounts', () => {
  const s = source(), expected = roles(s), minimal = { ...s };
  delete minimal.home;
  assert.deepEqual(roles(minimal), expected);
  for (const patch of [{ p: '126' }, { q: '1' }, { site: 4 }, { gen: 2 }, { seq: 1 }, { world: 'ab'.repeat(32) }]) {
    refused(() => roles({ ...s, home: { ...s.home, ...patch } }));
  }
  refused(() => roles({ ...s, home: null }));
  refused(() => roles({ ...s, holding: address(12) }));
  assert.deepEqual(roles({ ...s, holding: expected[4].address }), expected);
});

test('all six original wedges and Concord use lossless canonical full references', () => {
  for (const [p, q] of [['0', '0'], ['128', '0'], ['0', '128'], ['-128', '128'], ['-128', '0'], ['0', '-128'], ['128', '-128'], ['-63', '128']]) {
    const s = source({ home: { p, q, site: 11, gen: 0, seq: 0xffffffff }, origin: { p, q } });
    const result = roles(s);
    assert.equal(result[5].address, result[7].address);
    assert.equal(result[7].writable, true);
  }
});

test('wrong world, noncanonical host, wide issuer and wide origin are refused', () => {
  const s = source();
  for (const fn of [
    b => { b[0] = 0; }, b => { b[1] ^= 1; }, b => { b.fill(0, 1, 33); },
    b => { b[41] = 6; }, (b, v) => { v.setBigUint64(42, 127n, false); },
    (b, v) => { v.setBigUint64(33, 0n, false); b[41] = 1; },
    (b, v) => { v.setBigUint64(33, 0n, false); v.setBigUint64(42, 1n, false); },
    (b, v) => { v.setBigUint64(33, 129n, false); }, b => { b[50] = 12; },
  ]) refused(() => roles(mutateHost(s, fn)));
  for (const host of [s.host.toUpperCase(), s.host.slice(2), s.host + '00', 'gg'.repeat(56), 0, null]) refused(() => roles({ ...s, host }));
  refused(() => roles({ ...s, world: 'ab'.repeat(32) }));
  refused(() => roles({ ...s, origin: { ...s.origin, world: 'ab'.repeat(32) } }));
  for (const p of ['129', '-129', '9007199254740993', '4611686018427387905', '0128', '+128', '-0', '1e2', ' 128', 128, null]) {
    refused(() => roles({ ...s, origin: { p, q: '0' } }));
  }
  refused(() => roles({ ...s, origin: { p: '128', q: '1' } }));
});

test('zero, malformed and non-string public addresses plus forged owner are refused', () => {
  const s = source();
  for (const key of ['program', 'season', 'wallet', 'payer', 'original_owner']) {
    for (const value of [SYSTEM, '', '0'.repeat(32), s[key] + '1', null, new Uint8Array(32)]) {
      refused(() => roles({ ...s, [key]: value }));
    }
  }
  refused(() => roles({ ...s, original_owner: citizen({ ...s, wallet: address(67) }) }));
  refused(() => roles({ ...s, program: s.season }));
  let conversions = 0;
  const notPublicText = { toBytes() { conversions++; throw new Error('not public text'); }, toString() { conversions++; return s.wallet; } };
  refused(() => roles({ ...s, wallet: notPublicText }));
  assert.equal(conversions, 0, 'no key object conversion or material is read');
});

test('all other recipient aliases, including program and derived accounts, are refused', () => {
  const s = source(), expected = roles(s);
  for (const payer of [s.program, ...expected.slice(2).map(r => r.address)]) refused(() => roles({ ...s, payer }));
  for (const wallet of [s.program, s.season, expected[4].address, expected[5].address, expected[7].address, expected[8].address]) {
    const changed = { ...s, wallet }; changed.original_owner = citizen(changed);
    refused(() => roles(changed));
  }
});

test('proposal is immutable, leaves input untouched, and exposes no executable or transport API', () => {
  const s = source(), before = JSON.stringify(s);
  Object.freeze(s.home); Object.freeze(s.origin); Object.freeze(s);
  const result = roles(s);
  assert.equal(JSON.stringify(s), before);
  assert.ok(Object.isFrozen(result) && result.every(Object.isFrozen));
  assert.deepEqual(Object.keys(outbound), ['canonicalOutboundRoles']);
  for (const r of result) assert.deepEqual(Object.keys(r), ['name', 'address', 'signer', 'writable']);
  assert.deepEqual(keyCalls, []);
});
