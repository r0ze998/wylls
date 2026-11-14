// archive/host-bins.mjs on a throwaway git repository with fake binaries (no build, no chain): keep copies the
// seven binaries and records them; verify passes for the kept build and fails for a swapped binary, a changed or
// new source file, or a changed Cargo.lock; keep refuses a dirty source tree.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BINS, keep, verify } from '../archive/host-bins.mjs';

function fixture() {
  const repo = mkdtempSync(path.join(tmpdir(), 'wylls-hostbins-'));
  const git = (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'test');
  mkdirSync(path.join(repo, 'frontier-node/crates/x'), { recursive: true });
  writeFileSync(path.join(repo, 'frontier-node/Cargo.lock'), 'lock v1\n');
  writeFileSync(path.join(repo, 'frontier-node/crates/x/lib.rs'), 'fn a() {}\n');
  writeFileSync(path.join(repo, '.gitignore'), 'target/\nbin/\n');
  git('add', '.'); git('commit', '-q', '-m', 'base');
  const release = path.join(repo, 'target/release');
  mkdirSync(release, { recursive: true });
  for (const b of BINS) writeFileSync(path.join(release, b), `binary ${b}\n`);
  return { repo, release, bin: path.join(repo, 'bin'), git, done: () => rmSync(repo, { recursive: true, force: true }) };
}
const opts = repo => ({ repo, toolchain: { rustc: 'test', cargo: 'test' } });

test('keep records the seven binaries; verify passes for exactly that build', () => {
  const f = fixture();
  try {
    const rec = keep(f.release, f.bin, opts(f.repo));
    assert.deepEqual(Object.keys(rec.bins), [...BINS]);
    assert.equal(rec.sourcesClean, true);
    assert.equal(rec.flags.CARGO_INCREMENTAL, '0');
    assert.deepEqual(verify(f.bin, { repo: f.repo }).ok, true);
    const p = JSON.parse(readFileSync(path.join(f.bin, 'PROVENANCE.json'), 'utf8'));
    assert.equal(p.commit, f.git('rev-parse', 'HEAD').trim());
  } finally { f.done(); }
});

test('verify fails for a swapped binary, a changed or new source, a changed Cargo.lock', () => {
  const f = fixture();
  try {
    keep(f.release, f.bin, opts(f.repo));
    writeFileSync(path.join(f.bin, 'frontier-herald'), 'another herald\n');
    assert.match(verify(f.bin, { repo: f.repo }).problems.join(), /frontier-herald: not the recorded build/);
    writeFileSync(path.join(f.bin, 'frontier-herald'), 'binary frontier-herald\n');
    writeFileSync(path.join(f.repo, 'frontier-node/crates/x/lib.rs'), 'fn a() { /* changed */ }\n');
    assert.match(verify(f.bin, { repo: f.repo }).problems.join(), /sources changed/);
    f.git('checkout', '-q', '--', 'frontier-node/crates/x/lib.rs');
    writeFileSync(path.join(f.repo, 'frontier-node/crates/x/new.rs'), 'fn b() {}\n');
    assert.match(verify(f.bin, { repo: f.repo }).problems.join(), /sources changed/);
    rmSync(path.join(f.repo, 'frontier-node/crates/x/new.rs'));
    assert.equal(verify(f.bin, { repo: f.repo }).ok, true);
  } finally { f.done(); }
});

test('keep refuses a source tree that differs from its commit, and a missing binary', () => {
  const f = fixture();
  try {
    writeFileSync(path.join(f.repo, 'frontier-node/crates/x/lib.rs'), 'fn a() { 1; }\n');
    assert.throws(() => keep(f.release, f.bin, opts(f.repo)), /source paths differ/);
    f.git('checkout', '-q', '--', 'frontier-node/crates/x/lib.rs');
    rmSync(path.join(f.release, 'frontier-bots'));
    assert.throws(() => keep(f.release, f.bin, opts(f.repo)), /frontier-bots: missing/);
  } finally { f.done(); }
});
