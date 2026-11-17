// The key-test scan on a static fixture tree (workstream 04, 2026-11-08). Nothing here generates, derives or signs:
// the fixture files are written as text into a temporary directory and only read by the scan, never imported or run.
// The key API names are assembled from parts so that this file itself names none.
//   node --import scripts/ci/no-keys-guard.mjs --test scripts/ci/scan-node-key-tests.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scan = path.join(path.dirname(fileURLToPath(import.meta.url)), 'scan-node-key-tests.mjs');
const GEN = 'generate' + 'Key(';
const SIGNTX = 'sign' + 'Transaction';

function tree(files) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ws04-scan-fixture-'));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), body);
  }
  return dir;
}
const run = (dir, args = []) => spawnSync(process.execPath, [scan, ...args], { env: { ...process.env, WS04_SCAN_ROOT: dir }, encoding: 'utf8' });
const digest = (dir, ...files) => run(dir, ['--digest', ...files]).stdout.trim();
const listed = dir => readFileSync(path.join(dir, 'scripts/ci/node-key-tests.txt'), 'utf8').split('\n').filter(l => l && !l.startsWith('#'));

test('a workstream test that names a key API, directly or through a helper in its test directory, is listed', () => {
  const dir = tree({
    // the case that was missed: a workstream package outside the two original SETS
    'workstreams/06-creation/test/roles.test.mjs': `import { x } from '../src/keys.mjs';\nconst a = await ${GEN});\n`,
    'workstreams/06-creation/test/helpers.mjs': `export const k = () => ${SIGNTX};\n`,
    'workstreams/06-creation/test/via-helper.test.mjs': `import { k } from './helpers.mjs';\n`,
    'workstreams/03-composability/mcp/test/keyfree/deep.test.mjs': `import '../util/h.mjs';\n`,
    'workstreams/03-composability/mcp/test/util/h.mjs': `${GEN});\n`,
    // reached only through src/: a conservative exclusion (the closure names a key API; no call is proven)
    'workstreams/06-creation/test/via-src.test.mjs': `import '../src/keys.mjs';\n`,
    'workstreams/06-creation/src/keys.mjs': `export const g = () => ${GEN});\n`,
    'workstreams/06-creation/test/clean.test.mjs': `import assert from 'node:assert';\n`,
    'scripts/ci/node-key-tests.txt': '',
  });
  try {
    const r = run(dir);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(listed(dir).sort(), [
      'workstreams/03-composability/mcp/test/keyfree/deep.test.mjs',
      'workstreams/06-creation/test/roles.test.mjs',
      'workstreams/06-creation/test/via-helper.test.mjs',
      'workstreams/06-creation/test/via-src.test.mjs',
    ]);
    const text = readFileSync(path.join(dir, 'scripts/ci/node-key-tests.txt'), 'utf8');
    assert.ok(text.indexOf('via-src.test.mjs') > text.indexOf('through src/'), 'the src-only case is in the conservative section');
    // the list is now current; adding a key-using test makes --check fail until it is rewritten
    assert.equal(run(dir, ['--check']).status, 0);
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    throw e;
  }
  try {
    mkdirSync(path.join(dir, 'workstreams/15-coop-outcomes/test'), { recursive: true });
    writeFileSync(path.join(dir, 'workstreams/15-coop-outcomes/test/new.test.mjs'), `${GEN});\n`);
    const c = run(dir, ['--check']);
    assert.equal(c.status, 3, 'a new key-using test fails --check');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--covers refuses a file the scan does not examine', () => {
  const dir = tree({
    'workstreams/01-national-strategy/test/a.test.mjs': '\n',
    'workstreams/01-national-strategy/test/b.browser.nokey.mjs': '\n',
    'scripts/ci/node-key-tests.txt': '',
  });
  try {
    assert.equal(run(dir, ['--covers', 'workstreams/01-national-strategy/test/a.test.mjs']).status, 0);
    const r = run(dir, ['--covers', 'workstreams/01-national-strategy/test/a.test.mjs', 'workstreams/01-national-strategy/test/b.browser.nokey.mjs']);
    assert.equal(r.status, 4);
    assert.match(r.stderr, /b\.browser\.nokey\.mjs/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the repository list names workstream 06 roles.test.mjs and is current', () => {
  const repo = path.resolve(path.dirname(scan), '../..');
  const out = execFileSync(process.execPath, [scan, '--check'], { cwd: repo, encoding: 'utf8', env: { ...process.env, WS04_SCAN_ROOT: '' } });
  assert.match(out, /by the scan/);
  assert.ok(readFileSync(path.join(repo, 'scripts/ci/node-key-tests.txt'), 'utf8').split('\n').includes('workstreams/06-creation/test/roles.test.mjs'));
});

test('a reviewed named target with its reason stays runnable; a direct hit or a missing reason cannot be reviewed', () => {
  const files = {
    'workstreams/06-creation/test/reviewed.test.mjs': `import '../src/plan.mjs';\n`,
    'workstreams/06-creation/src/plan.mjs': `import './keys.mjs';\nexport const resolve = x => x;\n`,
    'workstreams/06-creation/src/keys.mjs': `export const g = () => ${GEN});\n`,
    'workstreams/06-creation/test/direct.test.mjs': `${GEN});\n`,
    'scripts/ci/node-key-tests.txt': '',
  };
  const dir = tree(files);
  try {
    const rev = `workstreams/06-creation/test/reviewed.test.mjs  ${digest(dir, 'workstreams/06-creation/test/reviewed.test.mjs')}  # calls resolve only\n`;
    writeFileSync(path.join(dir, 'scripts/ci/node-key-reviewed.txt'), rev);
    assert.equal(run(dir).status, 0);
    assert.deepEqual(listed(dir), ['workstreams/06-creation/test/direct.test.mjs']);
    writeFileSync(path.join(dir, 'scripts/ci/node-key-reviewed.txt'), 'workstreams/06-creation/test/reviewed.test.mjs\n');
    assert.equal(run(dir).status, 5, 'no reason');
    writeFileSync(path.join(dir, 'scripts/ci/node-key-reviewed.txt'), `workstreams/06-creation/test/direct.test.mjs  ${digest(dir, 'workstreams/06-creation/test/direct.test.mjs')}  # no\n`);
    assert.equal(run(dir).status, 5, 'a direct hit');
    // stale (⑯'s S1-S3): a review pinned to its closure fails once a file it read changes, even with no key-API name
    // in the changed text, until it is reviewed again
    writeFileSync(path.join(dir, 'scripts/ci/node-key-reviewed.txt'), rev);
    assert.equal(run(dir).status, 0);
    writeFileSync(path.join(dir, 'workstreams/06-creation/src/plan.mjs'), `import './keys.mjs';\nimport { g } from './keys.mjs';\nexport const resolve = x => g();\n`);
    const r = run(dir);
    assert.equal(r.status, 5, 'a dependency now calls the key code: stale');
    assert.match(r.stderr, /stale review/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a test that starts a child process or imports a computed path is unfollowed (conservative) until reviewed', () => {
  const dir = tree({
    'workstreams/05-ai-participation/model-api/test/spawns.test.mjs': `import { spawn } from 'node:child_process';\nspawn(process.execPath, ['x.mjs']);\n`,
    'workstreams/12-memory/test/computed.test.mjs': `const u = new URL('../x.mjs', import.meta.url);\nawait import(u);\n`,
    'workstreams/12-memory/test/literal.test.mjs': `await import('./ok.mjs');\n`,
    'workstreams/12-memory/test/ok.mjs': `export const a = 1;\n`,
    'scripts/ci/node-key-tests.txt': '',
  });
  try {
    assert.equal(run(dir).status, 0);
    const text = readFileSync(path.join(dir, 'scripts/ci/node-key-tests.txt'), 'utf8');
    assert.deepEqual(listed(dir).sort(), ['workstreams/05-ai-participation/model-api/test/spawns.test.mjs', 'workstreams/12-memory/test/computed.test.mjs']);
    assert.ok(text.indexOf('spawns.test.mjs') > text.indexOf('# unfollowed'), 'in the unfollowed section');
    writeFileSync(path.join(dir, 'workstreams/12-memory/x.mjs'), 'export const a = 1;\n');
    writeFileSync(path.join(dir, 'scripts/ci/node-key-reviewed.txt'), `workstreams/12-memory/test/computed.test.mjs  ${digest(dir, 'workstreams/12-memory/test/computed.test.mjs', 'workstreams/12-memory/x.mjs')}  # its target names no key API\n`);
    assert.equal(run(dir).status, 0);
    assert.deepEqual(listed(dir), ['workstreams/05-ai-participation/model-api/test/spawns.test.mjs']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a review without its closure digest, or with a target that changed, fails the scan', () => {
  const dir = tree({
    'workstreams/12-memory/test/computed.test.mjs': `await import(new URL('../t.mjs', import.meta.url));\n`,
    'workstreams/12-memory/t.mjs': 'export const a = 1;\n',
    'scripts/ci/node-key-tests.txt': '',
  });
  try {
    writeFileSync(path.join(dir, 'scripts/ci/node-key-reviewed.txt'), 'workstreams/12-memory/test/computed.test.mjs  # no digest\n');
    assert.equal(run(dir).status, 5, 'no digest');
    const d = digest(dir, 'workstreams/12-memory/test/computed.test.mjs', 'workstreams/12-memory/t.mjs');
    writeFileSync(path.join(dir, 'scripts/ci/node-key-reviewed.txt'), `workstreams/12-memory/test/computed.test.mjs  ${d}  # target read\n`);
    assert.equal(run(dir).status, 0);
    writeFileSync(path.join(dir, 'workstreams/12-memory/t.mjs'), 'export const a = 2; // changed\n');
    assert.equal(run(dir).status, 5, 'the target changed: stale');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
