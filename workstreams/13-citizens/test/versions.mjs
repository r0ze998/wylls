// Which version of another workstream a test ran against, so that a pass is never read as a pass of another version.
// `commitOf(root)` asks git for the checked-out commit of a restored tree (read-only); `expectCommit(name, root)`
// fails when $<NAME>_EXPECT names a different commit (a prefix is enough), and returns the full SHA for the record.
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';

export function commitOf(root) {
  try { return execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; }
}

export function expectCommit(name, root) {
  const sha = commitOf(root);
  const want = process.env[`${name}_EXPECT`];
  if (want) assert.ok(sha && sha.startsWith(want), `${name}: the tree at ${root} is ${sha ?? 'not a git checkout'}, not ${want}`);
  return sha ?? 'unknown (not a git checkout)';
}
