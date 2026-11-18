// The six-nation recording tool's command line, end to end BEFORE it starts anything: refusals (exit 3 / 64) and
// --dry-run. It spawns only the tool itself; no world, no port, no key.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOOL = path.join(HERE, '..', 'sixnation.mjs');
const run = args => spawnSync(process.execPath, [TOOL, ...args], { encoding: 'utf8', timeout: 20000 });
const need = ['--bins', '/tmp/bins', '--out', '/tmp/out'];

test('the tool itself refuses a public cluster before it starts anything (exit 3), and a bad line (exit 64)', () => {
  const r = run([...need, '--cluster', 'devnet']);
  assert.equal(r.status, 3); assert.match(r.stderr, /NonTestCluster/);
  assert.equal(run([...need, '--rpc', 'https://api.devnet.solana.com']).status, 3);
  assert.equal(run([...need, '--minutes', 'x']).status, 64);
});

test('--dry-run prints the plan and starts nothing', () => {
  const r = run(['--dry-run', '--seed', '7']);
  assert.equal(r.status, 0, r.stderr);
  const p = JSON.parse(r.stdout);
  assert.deepEqual(p.residents.map(x => x.nation), [4, 1, 2, 3, 5, 0]);
  assert.equal(p.cluster, 'localnet');
  assert.equal(p.secondsPerTurn, 30);
});
