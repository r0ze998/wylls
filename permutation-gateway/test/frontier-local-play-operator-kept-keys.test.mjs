// ⑧ P2 × ⑤ A (TEST-ONLY, not for production): in a persisted world the operator residents' TEST keys are kept in the
// world's private dir (`--keys-dir`, 0700 dir / 0600 files), so a resumed world has the same residents. A looser mode or
// a link is refused, never repaired. Test keys only, in a temporary directory; nothing is sent.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, chmodSync, statSync, symlinkSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { keptTestKey, memoryTestKey, parseArgs } from '../src/frontier/local-play-operator-residents.mjs';

const args = extra => ['--count', '1', '--relay-ports', '41370', '--herald', 'http://127.0.0.1:41357', '--homes', '[[2,0,0]]', ...extra];

test('a kept resident key: made once (0600), the same address again, refused when looser or a link', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'psf-opkeys-'));
  try {
    const dir = path.join(root, 'operator-keys'); mkdirSync(dir, { mode: 0o700 });
    const a = keptTestKey(dir, 0), b = keptTestKey(dir, 1);
    assert.notEqual(a.address, b.address);
    assert.deepEqual(readdirSync(dir).sort(), ['resident-0.pkcs8.pem', 'resident-1.pkcs8.pem']);
    for (const f of readdirSync(dir)) assert.equal(statSync(path.join(dir, f)).mode & 0o777, 0o600, f);
    const again = keptTestKey(dir, 0);
    assert.equal(again.address, a.address, 'a resumed world: the same resident');
    assert.deepEqual(Buffer.from(again.signMessage(Uint8Array.of(1))), Buffer.from(a.signMessage(Uint8Array.of(1))), 'the same key (ed25519 is deterministic)');
    assert.ok(!JSON.stringify(a).includes('PRIVATE'), 'the handle shows the address only');
    assert.notEqual(memoryTestKey().address, a.address);
    chmodSync(path.join(dir, 'resident-0.pkcs8.pem'), 0o644);
    assert.throws(() => keptTestKey(dir, 0), /not private/);
    chmodSync(path.join(dir, 'resident-0.pkcs8.pem'), 0o600);
    chmodSync(dir, 0o755);
    assert.throws(() => keptTestKey(dir, 0), /not private/);
    assert.throws(() => parseArgs(args(['--keys-dir', dir])), /not private/);
    chmodSync(dir, 0o700);
    const link = path.join(root, 'link'); symlinkSync(dir, link);
    assert.throws(() => keptTestKey(link, 0), /not private/);
    assert.equal(parseArgs(args(['--keys-dir', dir])).keysDir, dir);
    assert.equal(parseArgs(args([])).keysDir, undefined, 'without the option: memory-only, as before');
    assert.throws(() => parseArgs(args(['--keys-dir', 'rel/dir'])), /absolute/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the launcher passes --keys-dir only for a persisted world, in the wallet\'s private dir', () => {
  const src = readFileSync(new URL('../src/frontier/local-play-launcher.mjs', import.meta.url), 'utf8');
  assert.match(src, /const operatorKeys = persist && natural && c\.operatorResidents \? path\.join\(home, 'operator-keys'\) : null;/);
  assert.match(src, /if \(operatorKeys\) await ensurePrivateDir\(operatorKeys\);/);
  assert.match(src, /\.\.\.\(keysDir \? \['--keys-dir', keysDir\] : \[\]\)\]\);/);
});
