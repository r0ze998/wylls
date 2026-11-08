// The relay code these tests run against, as the operator would state it to the autopilot (access-check.mjs: the probe
// is sent only to a relay tree whose gate order was verified).
//   LOCAL_RELAY_TREE is the tree of the permutation-gateway files actually on disk (diskRelayTree): this directory is
//   the same on workstream 5's branch (the base gateway) and on workstream 4's integration (the patched one), so a fixed
//   constant could be right for only one of them. RELAY_TREE, when set, must equal the tree on disk.
//   relay-tree.test.mjs fails unless that exact tree is in VERIFIED_RELAY_TREES (a reviewed attestation): the probe is
//   never enabled in these tests for code nobody reviewed.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProbeBudget } from '../src/access-check.mjs';

const root = fileURLToPath(new URL('../../../../', import.meta.url));

/** The git tree of permutation-gateway as on disk (tracked and untracked files; a node_modules link is left out). */
export function diskRelayTree() {
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

export const DISK_RELAY_TREE = diskRelayTree();
export const LOCAL_RELAY_TREE = process.env.RELAY_TREE ?? DISK_RELAY_TREE;
export const tokenCheck = (relayTree = LOCAL_RELAY_TREE, perDay) => ({ probe: { enabled: true, relayTree, budget: new ProbeBudget(perDay ? { perDay } : {}) } });
