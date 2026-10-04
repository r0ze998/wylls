// The producer of the social byte vectors (contract §6.1):
//
//   node permutation-gateway/citizens/social/vectors.mjs --write   (re-write test/fixtures/ai-social-v1.json)
//   node permutation-gateway/citizens/social/vectors.mjs --check   (exit 1 when the file is stale)
//
// One producer, one freshness checker (M1 §3.5): test/citizens-social-bytes.test.mjs
// calls `buildVectors()` and compares it with the committed file. The Rust
// mirror (bots/src/ai/aisign.rs, test ai_social_vectors.rs) checks byte
// conformance only: for every vector, encoding its `fields` gives `bytes_hex`.
//
// The keys here are seeds derived from fixed strings: local test keys, public
// by construction (§12.1 R9), used only to make deterministic signatures
// (ed25519 signatures are deterministic).
import { createPrivateKey, createPublicKey, sign as edSign } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  RESERVED_TAG, TAGS, decode, encodeBallot, encodeCallRead, encodeTalk, innerOf, leafOf, motionRef, seqOf, sha256, toBase58, toHex,
} from '../../../permutation-server/web/frontier/council/aisocial.mjs';
import { merkleRoot } from './merkle.mjs';

export const FIXTURE_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'test', 'fixtures', 'ai-social-v1.json');

const PKCS8 = Buffer.from('302e020100300506032b657004220420', 'hex');
export function keyFromSeed(seed) {
  const priv = createPrivateKey({ key: Buffer.concat([PKCS8, Buffer.from(seed)]), format: 'der', type: 'pkcs8' });
  const pub = Uint8Array.from(createPublicKey(priv).export({ format: 'der', type: 'spki' }).subarray(-32));
  return { priv, pub, seed: Uint8Array.from(seed), sign: bytes => Uint8Array.from(edSign(null, Buffer.from(bytes), priv)) };
}
/** A deterministic test key: sha256("wylls-ai-social-vector/key/<name>"). */
export const testKey = name => keyFromSeed(sha256(`wylls-ai-social-vector/key/${name}`));

const EMOJI_280 = '\u{1F600}'.repeat(280);
const decs = x => x.toString();

/** The JSON fields of a decoded record, u64 as decimal strings: what the Rust side encodes. */
function fieldsOf(r) {
  if (r.type === 'talk') {
    return {
      season: decs(r.season), bell: r.bell, wallet: toBase58(r.wallet), seq: r.seq, channel: r.channel,
      target: r.channel === 1 ? r.target : r.channel === 3 ? toBase58(r.target) : null,
      kind: r.kind, ref: decs(r.ref), origin: r.origin, lang: r.lang, text: r.text,
    };
  }
  if (r.type === 'ballot') {
    return { season: decs(r.season), period: r.period, wallet: toBase58(r.wallet), faction: r.faction, option: r.option, candidates_hash: toHex(r.candidates_hash), nonce: toHex(r.nonce), origin: r.origin };
  }
  return { season: decs(r.season), faction: r.faction, period: r.period, wallet: toBase58(r.wallet), unix: decs(r.unix) };
}

export function buildVectors() {
  const names = ['alice', 'bob', 'carol'];
  const keys = Object.fromEntries(names.map(n => [n, testKey(n)]));
  const W = Object.fromEntries(names.map(n => [n, keys[n].pub]));
  const season = 31;
  const chash = toHex(sha256('wylls-ai-social-vector/candidates'));
  const nonce = toHex(sha256('wylls-ai-social-vector/nonce').subarray(0, 16));

  const talkSpecs = [
    ['say, world channel', 'alice', { bell: 402, seq: seqOf(402, 0), channel: 0, kind: 0, ref: 0, origin: 0, lang: 'en', text: 'Good morning, all nations.' }],
    ['say, nation channel, Japanese', 'bob', { bell: 402, seq: seqOf(402, 1), channel: 1, target: 2, kind: 0, ref: 0, origin: 0, lang: 'ja', text: 'こんにちは、皆さん。斜めの島で会いましょう。' }],
    ['direct to a wallet, AI-written (origin 1), a reply', 'carol', { bell: 403, seq: seqOf(403, 2), channel: 3, target: W.alice, kind: 0, ref: 77, origin: 1, lang: 'en', text: 'I remember the camp you cleared. Thank you.' }],
    ['motion for option 2 of period 5, nation 4', 'alice', { bell: 412, seq: seqOf(412, 0), channel: 1, target: 4, kind: 1, ref: motionRef(5, 2), origin: 1, lang: 'en', text: 'The riverside stack is weak; let us strike it together.' }],
    ['say, scripted seat (origin 2)', 'bob', { bell: 500, seq: seqOf(500, 3), channel: 0, kind: 0, ref: 0, origin: 2, lang: 'en', text: 'Seat script line 1.' }],
    ['280 four-byte code points (1,120 bytes)', 'carol', { bell: 9999, seq: seqOf(9999, 15), channel: 0, kind: 0, ref: 0, origin: 0, lang: 'en', text: EMOJI_280 }],
  ];
  const talk = talkSpecs.map(([name, who, f]) => {
    const bytes = encodeTalk({ season, wallet: W[who], ...f });
    const sig = keys[who].sign(bytes);
    return { name, signer: who, fields: fieldsOf(decode(bytes)), bytes_hex: toHex(bytes), sig_hex: toHex(sig), inner_hex: toHex(innerOf(bytes, sig)), leaf_hex: toHex(leafOf(innerOf(bytes, sig))) };
  });

  const ballotSpecs = [
    ['ballot for option 2', 'alice', { period: 5, faction: 4, option: 2, origin: 0 }],
    ['ballot for none, AI-written', 'bob', { period: 5, faction: 4, option: 0, origin: 1 }],
    ['ballot, scripted seat', 'carol', { period: 120, faction: 0, option: 3, origin: 2 }],
  ];
  const ballot = ballotSpecs.map(([name, who, f]) => {
    const bytes = encodeBallot({ season, wallet: W[who], candidates_hash: chash, nonce, ...f });
    const sig = keys[who].sign(bytes);
    return { name, signer: who, fields: fieldsOf(decode(bytes)), bytes_hex: toHex(bytes), sig_hex: toHex(sig), inner_hex: toHex(innerOf(bytes, sig)), leaf_hex: toHex(leafOf(innerOf(bytes, sig))) };
  });

  const callreadSpecs = [
    ['call read, nation 4 period 5', 'alice', { faction: 4, period: 5, unix: 1_800_000_000 }],
    ['call read, period 0 faction 255, unix 0', 'bob', { faction: 255, period: 0, unix: 0 }],
  ];
  const callread = callreadSpecs.map(([name, who, f]) => {
    const bytes = encodeCallRead({ season, wallet: W[who], ...f });
    const sig = keys[who].sign(bytes);
    return { name, signer: who, fields: fieldsOf(decode(bytes)), bytes_hex: toHex(bytes), sig_hex: toHex(sig) };
  });

  // Bytes every decoder must refuse, and every signer must refuse to sign when `signable` is false.
  const okTalk = encodeTalk({ season, wallet: W.alice, bell: 1, seq: seqOf(1, 0), channel: 0, kind: 0, ref: 0, origin: 0, lang: 'en', text: 'a'.repeat(280) });
  const lenAt = okTalk.length - 280 - 2;
  const tooLong = new Uint8Array(okTalk.length + 1);
  tooLong.set(okTalk);
  tooLong[tooLong.length - 1] = 0x61;
  new DataView(tooLong.buffer).setUint16(lenAt, 281, true);
  const motion = encodeTalk({ season, wallet: W.alice, bell: 1, seq: seqOf(1, 0), channel: 1, target: 0, kind: 1, ref: motionRef(1, 1), origin: 0, lang: 'en', text: 'x' });
  const motionOpt0 = Uint8Array.from(motion);
  // ref is the u64 after kind: TAG(22) + season 8 + bell 4 + wallet 32 + seq 4 + channel 1 + target 1 + kind 1 = 73; option is its low byte.
  motionOpt0[73] = 0;
  const reservedPrefixed = new Uint8Array([...new TextEncoder().encode(RESERVED_TAG), 1, 2, 3]);
  const refused = [
    { name: 'text of 281 code points', bytes_hex: toHex(tooLong), code: 'TextTooLong', signable: true },
    { name: 'a talk record with a trailing byte', bytes_hex: toHex(Uint8Array.from([...okTalk, 0])), code: 'BadBytes', signable: true },
    { name: 'a truncated talk record', bytes_hex: toHex(okTalk.subarray(0, okTalk.length - 5)), code: 'BadBytes', signable: true },
    { name: 'a motion for option 0', bytes_hex: toHex(motionOpt0), code: 'BadBytes', signable: true },
    { name: 'the reserved TAG (refused, never signed)', bytes_hex: toHex(reservedPrefixed), code: 'BadBytes', signable: false },
    { name: 'unknown TAG', bytes_hex: toHex(new TextEncoder().encode('wylls/frontier/other/v1\u0000\u0000')), code: 'BadBytes', signable: false },
    { name: 'empty', bytes_hex: '', code: 'BadBytes', signable: false },
  ];

  const inners = talk.map(t => Uint8Array.from(Buffer.from(t.inner_hex, 'hex')));
  const merkle = [0, 1, 2, 3, 4, 5, 6].map(n => ({ n, leaves_hex: inners.slice(0, n).map(i => toHex(leafOf(i))), root_hex: toHex(merkleRoot(inners.slice(0, n).map(leafOf))) }));
  const hashes = ['', 'abc', 'wylls'].map(s => ({ input_utf8: s, sha256_hex: toHex(sha256(s)) }));

  return {
    v: 1,
    producer: 'permutation-gateway/citizens/social/vectors.mjs',
    note: 'Deterministic local test keys (seeds derived from fixed strings); public by construction. Rust checks byte conformance only (contract 6.1).',
    season: String(season),
    tags: { ...TAGS, reserved: RESERVED_TAG },
    keys: names.map(n => ({ name: n, seed_hex: toHex(keys[n].seed), wallet_b58: toBase58(keys[n].pub), wallet_hex: toHex(keys[n].pub) })),
    candidates_hash_hex: chash,
    nonce_hex: nonce,
    talk, ballot, callread, refused, merkle, sha256: hashes,
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const text = `${JSON.stringify(buildVectors(), null, 2)}\n`;
  if (process.argv.includes('--write')) {
    writeFileSync(FIXTURE_PATH, text);
    console.log(`wrote ${FIXTURE_PATH}`);
  } else if (process.argv.includes('--check')) {
    let have = '';
    try { have = readFileSync(FIXTURE_PATH, 'utf8'); } catch { /* missing */ }
    if (have !== text) { console.error('ai-social-v1.json is stale: run vectors.mjs --write'); process.exit(1); }
    console.log('ai-social-v1.json is fresh');
  } else process.stdout.write(text);
}
