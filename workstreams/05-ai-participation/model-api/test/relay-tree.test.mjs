// The probe is enabled in these tests for LOCAL_RELAY_TREE only. This computes the tree of the permutation-gateway files
// actually on disk (through a temporary index: the repository's own index is not touched; the test-only node_modules
// link is left out) and checks it is the stated one, and one whose gate order was verified.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERIFIED_RELAY_TREES } from '../src/access-check.mjs';
import { LOCAL_RELAY_TREE } from './relay-tree.mjs';

const root = fileURLToPath(new URL('../../../../', import.meta.url));

function diskTree() {
  const dir = mkdtempSync(join(tmpdir(), 'relay-tree-'));
  const env = { ...process.env, GIT_INDEX_FILE: join(dir, 'index') };
  const git = (...a) => execFileSync('git', ['-C', root, ...a], { encoding: 'utf8', env }).trim();
  try {
    git('read-tree', 'HEAD');
    git('add', '-A', '--', 'permutation-gateway');
    // A node_modules link put there for a test run is not relay code (a real node_modules directory is ignored anyway).
    git('rm', '-r', '--cached', '--quiet', '--ignore-unmatch', '--', 'permutation-gateway/node_modules');
    return git('rev-parse', `${git('write-tree')}:permutation-gateway`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('the relay tree the tests state is the permutation-gateway on disk, and one whose gate order was verified', () => {
  assert.ok(Object.hasOwn(VERIFIED_RELAY_TREES, LOCAL_RELAY_TREE), `${LOCAL_RELAY_TREE} is not a verified relay tree`);
  assert.equal(diskTree(), LOCAL_RELAY_TREE);
});
