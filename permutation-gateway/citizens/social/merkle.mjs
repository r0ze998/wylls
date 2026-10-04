// Per-bell social roots (contract §6.3). The tree rules are the ones of
// permutation-gateway/src/talk.mjs (`merkleRoot`, `merkleProof`, `nextLevel`:
// nodes sha256(0x01 ‖ left ‖ right), an odd node carried up, 32 zero bytes
// for no leaves); only the leaf differs, and it is redactable:
//
//   inner = sha256(bytes ‖ sig)        (what a redaction tombstone keeps)
//   leaf  = sha256(0x00 ‖ inner)
//
// The rules are copied here instead of imported so that the citizens
// service does not need read access to the gateway's `src/` under the Node
// permission model (§1.3 C1); test citizens-social-merkle.test.mjs asserts
// equality with talk.mjs on the same leaves, so the two cannot drift.
import { fromHex, innerOf, leafOf, nodeOf, toHex } from '../../../permutation-server/web/frontier/council/aisocial.mjs';

export { innerOf, leafOf };
export const ZERO_ROOT = new Uint8Array(32);

/** One level up: pairs hashed with the 0x01 prefix, an odd last node carried up as is. */
export function nextLevel(level) {
  const next = [];
  for (let i = 0; i < level.length; i += 2) next.push(i + 1 < level.length ? nodeOf(level[i], level[i + 1]) : level[i]);
  return next;
}

/** Merkle root of leaves (in order); 32 zero bytes for none. */
export function merkleRoot(leaves) {
  if (!leaves.length) return new Uint8Array(32);
  let level = leaves;
  while (level.length > 1) level = nextLevel(level);
  return level[0];
}

/** Proof of leaf `i`: sibling hashes from the bottom, each with its side (`left`: the sibling is on the left). */
export function merkleProof(leaves, i) {
  const proof = [];
  let level = leaves;
  let k = i;
  while (level.length > 1) {
    const sib = k ^ 1;
    if (sib < level.length) proof.push({ hash: toHex(level[sib]), left: sib < k });
    level = nextLevel(level);
    k >>= 1;
  }
  return proof;
}

/** Whether `proof` takes `leaf` (bytes) to `root` (bytes). */
export function verifyProof(leaf, proof, root) {
  let node = leaf;
  for (const { hash, left } of proof) node = left ? nodeOf(fromHex(hash), node) : nodeOf(node, fromHex(hash));
  return node.length === root.length && node.every((x, k) => x === root[k]);
}

/** The leaves of records `[{inner: Uint8Array | hex}]`, in order. */
export const leavesOf = records => records.map(r => leafOf(typeof r.inner === 'string' ? fromHex(r.inner) : r.inner));

/** social_root(b): the root over the bell's accepted records in acceptance order. */
export const socialRoot = records => merkleRoot(leavesOf(records));
