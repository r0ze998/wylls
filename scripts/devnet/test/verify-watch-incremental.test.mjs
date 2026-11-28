// verify-local-source: verify-watch.mjs hands `--incremental [--chunk N]` to the pull only when given (off = the pull's
// argv exactly as before). A stand-in pull binary records its argv and answers {"ok":false}; no RPC, no network (the
// loopback URL is never dialled).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WATCH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'verify-watch.mjs');

function pullArgv(extra) {
  const dir = mkdtempSync(path.join(tmpdir(), 'vw-inc-'));
  const bin = path.join(dir, 'pull.sh');
  const rec = path.join(dir, 'argv.txt');
  writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "$@" > '${rec}'\necho '{"ok":false,"error":"stand-in"}'\nexit 2\n`);
  chmodSync(bin, 0o755);
  // the judge stand-in only answers the start check (verify-bin-rebuild: `features` must report playable-lane)
  const judge = path.join(dir, 'judge.sh');
  writeFileSync(judge, `#!/bin/sh\n[ "$1" = features ] && { echo '{"bin":"frontier-verify","features":["playable-lane"],"mutated":null}'; exit 0; }\nexit 1\n`);
  chmodSync(judge, 0o755);
  const r = spawnSync(process.execPath, [WATCH, '--program', 'P', '--season', '3', '--data', path.join(dir, 'data'),
    '--verify-bin', judge, '--pull-bin', bin, '--program-so', bin, '--rpc', 'http://127.0.0.1:9', '--once', ...extra],
  { encoding: 'utf8' });
  return { status: r.status, stderr: r.stderr, argv: (() => { try { return readFileSync(rec, 'utf8').trim().split('\n'); } catch { return null; } })() };
}

test('default: the pull argv carries no --incremental / --chunk (unchanged)', () => {
  const r = pullArgv([]);
  assert.ok(r.argv, r.stderr);
  assert.deepEqual(r.argv.slice(0, 2), ['pull', '--program']);
  assert.ok(!r.argv.includes('--incremental') && !r.argv.includes('--chunk'));
});

test('--incremental and --incremental --chunk N are passed through', () => {
  const a = pullArgv(['--incremental']).argv;
  assert.ok(a.includes('--incremental') && !a.includes('--chunk'));
  const b = pullArgv(['--incremental', '--chunk', '50']).argv;
  assert.equal(b[b.indexOf('--chunk') + 1], '50');
});

test('--chunk without --incremental, or out of range, is refused before any pull', () => {
  for (const extra of [['--chunk', '5'], ['--incremental', '--chunk', '0'], ['--incremental', '--chunk', '1001']]) {
    const r = pullArgv(extra);
    assert.equal(r.status, 2);
    assert.equal(r.argv, null);
    assert.match(r.stderr, /--chunk N \(1\.\.1000\) needs --incremental/);
  }
});
