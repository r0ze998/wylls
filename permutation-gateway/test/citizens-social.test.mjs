// AC4: the signed record bytes (contract §6.1): the byte vectors (producer +
// freshness checker), the codec's strictness, domain separation (the reserved
// TAG is refused, no TAG-prefixed bytes parse as a Solana message), and the
// self-contained helpers against node:crypto and the existing base58.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import bs58 from 'bs58';
import { VersionedMessage } from '@solana/web3.js';
import {
  CHANNEL, RESERVED_TAG, SocialError, TAGS, decode, decodeBallot, decodeCallRead, decodeTalk, encodeBallot, encodeCallRead, encodeTalk, fromBase58, fromBase64, fromHex,
  innerOf, isReserved, leafOf, motionRef, recordType, seqOf, sha256, signRecord, signable, splitMotionRef, toBase58, toBase64, toHex, view,
} from '../../permutation-server/web/frontier/council/aisocial.mjs';
import { FIXTURE_PATH, buildVectors, testKey } from '../citizens/social/vectors.mjs';

const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
const W = testKey('v').pub;
const base = { season: 31, bell: 7, wallet: W, seq: seqOf(7, 0), channel: 0, kind: 0, ref: 0, origin: 0, lang: 'en', text: 'hi' };

test('the committed vectors are exactly what the producer makes (freshness)', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(buildVectors())), fixture);
});

test('every vector: fields encode to bytes_hex and decode back; the TAG lengths are 22, 24, 26', () => {
  assert.equal(TAGS.talk.length, 22);
  assert.equal(TAGS.ballot.length, 24);
  assert.equal(TAGS.callread.length, 26);
  for (const v of fixture.talk) {
    const f = v.fields;
    const bytes = encodeTalk({ ...f, target: f.target });
    assert.equal(toHex(bytes), v.bytes_hex, v.name);
    assert.deepEqual(JSON.parse(JSON.stringify(view(decodeTalk(bytes)))).text, f.text);
    assert.equal(recordType(bytes), 'talk');
    // sha256 chain: inner, leaf
    const inner = innerOf(bytes, fromHex(v.sig_hex));
    assert.equal(toHex(inner), v.inner_hex);
    assert.equal(toHex(leafOf(inner)), v.leaf_hex);
  }
  for (const v of fixture.ballot) {
    const bytes = encodeBallot(v.fields);
    assert.equal(toHex(bytes), v.bytes_hex, v.name);
    assert.equal(decodeBallot(bytes).option, v.fields.option);
    assert.equal(bytes.length, 24 + 8 + 4 + 32 + 1 + 1 + 32 + 16 + 1);
  }
  for (const v of fixture.callread) {
    const bytes = encodeCallRead(v.fields);
    assert.equal(toHex(bytes), v.bytes_hex, v.name);
    assert.equal(decodeCallRead(bytes).unix.toString(), v.fields.unix);
    assert.equal(bytes.length, 26 + 8 + 1 + 4 + 32 + 8);
  }
});

test('the vector signatures verify under the vector keys (ed25519, deterministic)', async () => {
  const { createPublicKey, verify } = await import('node:crypto');
  const SPKI = Buffer.from('302a300506032b6570032100', 'hex');
  const keyOf = name => testKey(name).pub;
  // The signer's session key signs: vectors use `testKey(<name>)` as both wallet and key.
  for (const v of [...fixture.talk, ...fixture.ballot, ...fixture.callread]) {
    const pub = createPublicKey({ key: Buffer.concat([SPKI, Buffer.from(keyOf(v.signer))]), format: 'der', type: 'spki' });
    assert.ok(verify(null, Buffer.from(v.bytes_hex, 'hex'), pub, Buffer.from(v.sig_hex, 'hex')), v.name);
  }
});

test('refused vectors: the decoder refuses each with its code, signers refuse the non-signable ones', () => {
  for (const r of fixture.refused) {
    const bytes = fromHex(r.bytes_hex);
    assert.throws(() => decode(bytes), e => e instanceof SocialError && e.code === r.code, r.name);
    if (r.signable) assert.ok(signable(bytes) === 'talk', r.name);
    else assert.throws(() => signable(bytes), e => e instanceof SocialError && e.code === 'NotSignable', r.name);
  }
});

test('domain separation: only the three live TAGs sign; the reserved TAG is refused by name', async () => {
  const live = [encodeTalk(base), encodeBallot({ season: 31, period: 1, wallet: W, faction: 0, option: 1, candidates_hash: sha256('c'), nonce: new Uint8Array(16), origin: 0 }), encodeCallRead({ season: 31, faction: 0, period: 1, wallet: W, unix: 5 })];
  for (const b of live) {
    const signed = await signRecord(b, bytes => new Uint8Array(64).fill(bytes[0]));
    assert.equal(fromBase64(signed.bytes_b64).length, b.length);
    assert.equal(signed.inner, toHex(innerOf(b, new Uint8Array(64).fill(b[0]))));
  }
  const reserved = new TextEncoder().encode(`${RESERVED_TAG}\u0000rest`);
  assert.ok(isReserved(reserved));
  await assert.rejects(() => signRecord(reserved, () => new Uint8Array(64)), /reserved TAG/);
  await assert.rejects(() => signRecord(new Uint8Array([1, 2, 3]), () => new Uint8Array(64)), SocialError);
  // A signer that returns a short signature is an error, not a silent pass.
  await assert.rejects(() => signRecord(live[0], () => new Uint8Array(3)), SocialError);
  assert.equal(RESERVED_TAG, 'wylls/frontier/pact/v1');
  assert.throws(() => decode(reserved), /reserved/);
});

test('no TAG-prefixed byte string parses as a Solana message (legacy header 119 or a non-0x80 prefix)', () => {
  const samples = [...fixture.talk, ...fixture.ballot, ...fixture.callread].map(v => fromHex(v.bytes_hex));
  assert.ok(samples.length >= 10);
  for (const b of samples) {
    assert.equal(b[0], 0x77);
    assert.throws(() => VersionedMessage.deserialize(b), undefined, 'must not parse as a message');
  }
});

test('codec strictness: lengths, enumerations, unicode, trailing and missing bytes', () => {
  const good = encodeTalk(base);
  assert.deepEqual(decodeTalk(good).text, 'hi');
  assert.throws(() => decodeTalk(Uint8Array.from([...good, 0])), /trailing/);
  assert.throws(() => decodeTalk(good.subarray(0, good.length - 1)), SocialError);
  assert.throws(() => decodeTalk(encodeBallot({ season: 31, period: 1, wallet: W, faction: 0, option: 0, candidates_hash: sha256('c'), nonce: new Uint8Array(16), origin: 0 })), /wrong tag/);
  assert.throws(() => encodeTalk({ ...base, channel: 2 }), SocialError);
  assert.throws(() => encodeTalk({ ...base, origin: 3 }), SocialError);
  assert.throws(() => encodeTalk({ ...base, lang: 'EN' }), SocialError);
  assert.throws(() => encodeTalk({ ...base, text: '   ' }), SocialError);
  assert.throws(() => encodeTalk({ ...base, channel: 0, target: 1 }), SocialError, 'a world message has no target');
  assert.throws(() => encodeTalk({ ...base, kind: 1, channel: 0 }), SocialError, 'a motion goes to the nation channel');
  assert.throws(() => encodeTalk({ ...base, kind: 1, channel: 1, target: 0, ref: motionRef(1, 0) }), SocialError, 'motion option 0');
  assert.throws(() => encodeTalk({ ...base, text: '\ud800' }), SocialError, 'a lone surrogate');
  // text limits: 280 code points and 1,120 bytes
  assert.equal(decodeTalk(encodeTalk({ ...base, text: '\u{1F600}'.repeat(280) })).text.length, 560);
  assert.throws(() => encodeTalk({ ...base, text: '\u{1F600}'.repeat(281) }), e => e.code === 'TextTooLong');
  assert.throws(() => encodeTalk({ ...base, text: 'a'.repeat(281) }), e => e.code === 'TextTooLong');
  // a non-UTF-8 text on the wire
  const bad = Uint8Array.from(good);
  bad[bad.length - 1] = 0xff;
  assert.throws(() => decodeTalk(bad), /UTF-8/);
});

test('integers are little-endian and wide enough: u64 season and ref, i64 unix, u32 seq', () => {
  const b = encodeTalk({ ...base, season: 2n ** 63n + 5n, ref: 2n ** 64n - 1n, seq: 0xffffffff });
  const d = decodeTalk(b);
  assert.equal(d.season, 2n ** 63n + 5n);
  assert.equal(d.ref, 2n ** 64n - 1n);
  assert.equal(d.seq, 0xffffffff);
  assert.equal(b[22], 5, 'season u64 is little-endian after the TAG');
  assert.throws(() => encodeTalk({ ...base, season: 2n ** 64n }), SocialError);
  assert.throws(() => encodeTalk({ ...base, seq: -1 }), SocialError);
  const r = decodeCallRead(encodeCallRead({ season: 1, faction: 2, period: 3, wallet: W, unix: -1 }));
  assert.equal(r.unix, -1n);
  assert.deepEqual(splitMotionRef(motionRef(5, 2)), { period: 5, option: 2 });
  assert.equal(motionRef(5, 2), 5n * 256n + 2n);
  assert.equal(seqOf(402, 3), 402 * 16 + 3);
  assert.throws(() => seqOf(402, 16), SocialError);
});

test('the direct channel carries a 32-byte target, the nation channel one byte, the world none', () => {
  const w = encodeTalk(base).length;
  assert.equal(encodeTalk({ ...base, channel: CHANNEL.nation, target: 3 }).length, w + 1);
  assert.equal(encodeTalk({ ...base, channel: CHANNEL.direct, target: W }).length, w + 32);
  assert.throws(() => encodeTalk({ ...base, channel: CHANNEL.direct, target: new Uint8Array(31) }), SocialError);
  const d = decodeTalk(encodeTalk({ ...base, channel: CHANNEL.direct, target: W }));
  assert.equal(view(d).target, toBase58(W));
});

test('self-contained helpers equal node:crypto and bs58', () => {
  for (const s of ['', 'abc', 'x'.repeat(55), 'x'.repeat(56), 'x'.repeat(64), 'x'.repeat(1000), 'café']) {
    assert.equal(toHex(sha256(s)), createHash('sha256').update(s).digest('hex'));
  }
  assert.equal(toHex(sha256(new Uint8Array([1, 2]), new Uint8Array([3]))), createHash('sha256').update(Buffer.from([1, 2, 3])).digest('hex'));
  for (const bytes of [new Uint8Array(32), new Uint8Array(32).fill(255), Uint8Array.from({ length: 32 }, (_, i) => i * 7), Uint8Array.from([0, 0, 5, 9]), new Uint8Array(0)]) {
    assert.equal(toBase58(bytes), bs58.encode(Buffer.from(bytes)));
    assert.deepEqual(fromBase58(toBase58(bytes)), bytes);
  }
  assert.throws(() => fromBase58('0OIl'), SocialError);
  const data = Uint8Array.from({ length: 100 }, (_, i) => (i * 37) & 255);
  assert.equal(toBase64(data), Buffer.from(data).toString('base64'));
  assert.deepEqual(fromBase64(toBase64(data)), data);
  assert.deepEqual(fromBase64(Buffer.from(data).toString('base64url')), data, 'url-safe, unpadded');
  assert.throws(() => fromBase64('a*b'), SocialError);
  assert.throws(() => fromHex('abc'), SocialError);
  assert.deepEqual(fixture.sha256.map(x => x.sha256_hex), fixture.sha256.map(x => createHash('sha256').update(x.input_utf8).digest('hex')));
});
