// AC4: per-bell roots (contract §6.3): the tree rules are those of
// src/talk.mjs (copied into citizens/social/merkle.mjs so the service needs no
// read access to src/ under the permission model); only the leaf is
// redactable (leaf = sha256(0x00 ‖ sha256(bytes ‖ sig))).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { merkleProof as talkProof, merkleRoot as talkRoot, nextLevel as talkNext } from '../src/talk.mjs';
import { fromHex, innerOf, leafOf, sha256, toHex } from '../../permutation-server/web/frontier/council/aisocial.mjs';
import { ZERO_ROOT, leavesOf, merkleProof, merkleRoot, nextLevel, socialRoot, verifyProof } from '../citizens/social/merkle.mjs';
import { FIXTURE_PATH } from '../citizens/social/vectors.mjs';

const leavesN = n => Array.from({ length: n }, (_, i) => sha256(Uint8Array.of(0, i)));

test('the root and every proof equal talk.mjs on the same leaves, for 0..17 leaves', () => {
  for (let n = 0; n <= 17; n++) {
    const leaves = leavesN(n);
    assert.deepEqual(merkleRoot(leaves), talkRoot(leaves), `root of ${n}`);
    for (let i = 0; i < n; i++) {
      assert.deepEqual(merkleProof(leaves, i), talkProof(leaves, i), `proof ${i} of ${n}`);
      assert.ok(verifyProof(leaves[i], merkleProof(leaves, i), merkleRoot(leaves)), `${n}/${i}`);
    }
    if (n > 1) assert.ok(!verifyProof(leaves[1], merkleProof(leaves, 0), merkleRoot(leaves)), 'a proof belongs to its leaf');
  }
  const l = leavesN(5);
  assert.deepEqual(nextLevel(l), talkNext(l));
});

test('empty = 32 zero bytes; one leaf is the leaf; an odd node is carried up', () => {
  assert.deepEqual(merkleRoot([]), new Uint8Array(32));
  assert.deepEqual(ZERO_ROOT, new Uint8Array(32));
  const [a, b, c] = leavesN(3);
  assert.deepEqual(merkleRoot([a]), a);
  assert.deepEqual(nextLevel([a, b, c]).length, 2);
  assert.deepEqual(nextLevel([a, b, c])[1], c);
});

test('leaves are redactable: inner = sha256(bytes ‖ sig), leaf = sha256(0x00 ‖ inner); the root needs only inner', () => {
  const fx = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
  const recs = fx.talk.slice(0, 4);
  const inners = recs.map(v => innerOf(fromHex(v.bytes_hex), fromHex(v.sig_hex)));
  recs.forEach((v, i) => assert.equal(toHex(inners[i]), v.inner_hex));
  assert.equal(toHex(leafOf(inners[0])), toHex(sha256(Uint8Array.of(0), inners[0])));
  // A redacted record (bytes gone, inner kept) gives the same root.
  const full = socialRoot(recs.map(v => ({ inner: v.inner_hex })));
  const redacted = socialRoot([{ inner: inners[0] }, { inner: recs[1].inner_hex }, { inner: inners[2] }, { inner: recs[3].inner_hex }]);
  assert.deepEqual(full, redacted);
  assert.deepEqual(leavesOf([{ inner: recs[0].inner_hex }])[0], leafOf(inners[0]));
  // The vector file's merkle examples are reproduced.
  for (const m of fx.merkle) assert.equal(toHex(merkleRoot(m.leaves_hex.map(fromHex))), m.root_hex, `n=${m.n}`);
  // Changing one byte of a record changes the root.
  const flipped = fromHex(recs[0].bytes_hex);
  flipped[40] ^= 1;
  const other = socialRoot([{ inner: innerOf(flipped, fromHex(recs[0].sig_hex)) }, ...recs.slice(1).map(v => ({ inner: v.inner_hex }))]);
  assert.notDeepEqual(other, full);
});
