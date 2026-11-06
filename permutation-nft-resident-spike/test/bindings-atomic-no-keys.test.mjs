// Storage behavior only: synthetic strings, no keys, signing, network or RPC.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ResidentBindings, ResidentGate } from '../src/resident-gate.mjs';

test('failed write or rename holds the gate instead of publishing an uncommitted binding', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ws20-bindings-'));
  try {
    const absentParent = new ResidentBindings({ file: join(dir, 'missing', 'bindings.json') });
    assert.throws(() => absentParent.bind('citizen-A', 'asset-A'));
    assert.equal(absentParent.map.has('citizen-A'), false);
    assert.throws(() => absentParent.assetOf('citizen-A'), /unavailable/);
    const gate = Object.assign(Object.create(ResidentGate.prototype), { bindings: absentParent, log: () => {}, requireBinding: false });
    assert.deepEqual(await gate.check({ citizen: 'citizen-A', actor: 'old-holder' }), { ok: false, code: 'ResidentUnverified', why: undefined });
    const file = join(dir, 'binding-target');
    const renameFails = new ResidentBindings({ file });
    mkdirSync(file); // the temporary file can be written, but cannot replace this directory
    assert.throws(() => renameFails.bind('citizen-B', 'asset-B'));
    assert.equal(renameFails.map.has('citizen-B'), false);
    assert.throws(() => renameFails.assetOf('citizen-B'), /unavailable/);
    assert.throws(() => renameFails.bind('citizen-C', 'asset-C'), /unavailable/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a committed binding survives restart and cannot be reassigned', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ws20-bindings-'));
  try {
    const file = join(dir, 'bindings.json');
    const first = new ResidentBindings({ file });
    first.bind('citizen-A', 'asset-A');
    assert.equal(first.assetOf('citizen-A'), 'asset-A');
    const after = new ResidentBindings({ file });
    assert.equal(after.assetOf('citizen-A'), 'asset-A');
    assert.throws(() => after.bind('citizen-A', 'asset-B'), /binding never moves/);
    assert.equal(after.assetOf('citizen-A'), 'asset-A');
    assert.equal(new ResidentBindings({ file }).assetOf('citizen-A'), 'asset-A');
    renameSync(file, `${file}.saved`);
    mkdirSync(file);
    assert.throws(() => after.bind('citizen-B', 'asset-B'));
    assert.throws(() => after.assetOf('citizen-A'), /unavailable/, 'a failed store makes all bindings unverified');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
