// Workstream 12: fixtures/presigned-signatures.json is what the fixture's deterministic TEST-ONLY keys make. Every
// public key is re-derived and every signature re-made with fixtures/scenario.mjs's keys, so the key-free tests
// (fixtures/presigned.mjs) verify the same signatures the live fixture would make. A key test: it signs, so it is in
// scripts/ci/node-key-tests.txt and never in a key-free run. Whether the table is complete and has no stale entry
// is tools/presign.mjs --check (it runs the key-free tests).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fixturePublicKey, fixtureSignature } from '../fixtures/scenario.mjs';

const table = JSON.parse(readFileSync(new URL('../fixtures/presigned-signatures.json', import.meta.url), 'utf8'));

test('presigned table: every public key and signature is the fixture keys\' own, sorted, without duplicates', () => {
  assert.equal(table.format, 'wylls.memory12.presigned/v1');
  const tags = Object.keys(table.public);
  assert.deepEqual(tags, [...tags].sort());
  for (const t of tags) assert.equal(table.public[t], fixturePublicKey(t), `public key of ${t}`);
  const seen = new Set();
  for (const e of table.signatures) {
    const k = `${e.tag}\n${e.bytes}`;
    assert.ok(!seen.has(k), `duplicate entry for ${e.tag}`);
    seen.add(k);
    assert.ok(e.tag in table.public, `a signature by ${e.tag} without its public key`);
    assert.equal(e.sig, fixtureSignature(e.tag, Buffer.from(e.bytes, 'utf8')), `signature by ${e.tag}`);
  }
  assert.ok(table.signatures.length > 0);
});
