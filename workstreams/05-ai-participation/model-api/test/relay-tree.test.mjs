// The probe is enabled in these tests for LOCAL_RELAY_TREE only (relay-tree.mjs): the tree of the permutation-gateway
// files actually on disk. This checks that tree is one whose gate order was reviewed (VERIFIED_RELAY_TREES), and that a
// stated RELAY_TREE is that tree; and that each attested entry is a full 40-hex tree id with its evidence named.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { VERIFIED_RELAY_TREES } from '../src/access-check.mjs';
import { DISK_RELAY_TREE, LOCAL_RELAY_TREE, diskRelayTree } from './relay-tree.mjs';

const root = fileURLToPath(new URL('../../../../', import.meta.url));

test('the relay tree the tests use is the permutation-gateway on disk, and one whose gate order was reviewed', () => {
  assert.equal(diskRelayTree(), DISK_RELAY_TREE, 'stable while the tests run');
  assert.equal(LOCAL_RELAY_TREE, DISK_RELAY_TREE, 'a stated RELAY_TREE must be the tree on disk');
  assert.ok(Object.hasOwn(VERIFIED_RELAY_TREES, DISK_RELAY_TREE), `${DISK_RELAY_TREE} (on disk) is not a reviewed relay tree: review it and attest it in access-check.mjs, or run on a reviewed tree`);
});

test('every attested entry is a full tree id with a description; known commits give the attested trees', () => {
  for (const [tree, why] of Object.entries(VERIFIED_RELAY_TREES)) {
    assert.match(tree, /^[0-9a-f]{40}$/);
    assert.ok(typeof why === 'string' && why.length > 10, tree);
  }
  // Where the commits are present in this clone, the attested trees are theirs (whole permutation-gateway subtree).
  const known = { '4cd901de9f8e0d6c0b2016851d30595c4a70aa46': '560f8659fdc091d6870c35539333acf59381acf8', 'e29ec011f99761594c59a6e4b0c4681c5938d443': '477c5685ad2390c2b8a627936187f8f546423a0e', '7535a17e135ff3b18f7ad1160599f1473b334794': '52ccd7fc13daba4d2e4af111a65b644b4f0e8ae2' };
  for (const [commit, tree] of Object.entries(known)) {
    let got = null;
    try { got = execFileSync('git', ['-C', root, 'rev-parse', '--verify', '--quiet', `${commit}:permutation-gateway`], { encoding: 'utf8' }).trim(); } catch { got = null; }
    if (got) assert.equal(got, tree, `${commit}:permutation-gateway`);
    assert.ok(Object.hasOwn(VERIFIED_RELAY_TREES, tree), tree);
  }
});
