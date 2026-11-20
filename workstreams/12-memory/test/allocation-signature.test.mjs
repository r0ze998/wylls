// Workstream 12 contract tests v3, allocation authentication: the tests whose subject is the signature itself
// (a forged signer, an unknown signer, another world's signed bytes, a tampered field, an edited journal line). They
// sign with fixtures/scenario.mjs's deterministic TEST-ONLY keys, so they are key tests (scripts/ci/node-key-tests.txt)
// and stay out of the key-free runs. Moved from contract-v3.test.mjs unchanged.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { utterance, RecordError } from '../src/records.mjs';
import { A, C, PUBLIC, WORLD, allocate, allocateOp, caravanFacts, dm, newMemory, promise, signedAllocation, cv } from '../fixtures/scenario.mjs';

const one = (m, at = 300) => m.knowledge(A, at).commitments[0];

test('allocation: what a message says allocates nothing; only a valid signature of a party does', () => {
  assert.throws(() => utterance({ speaker: 'B', bell: 102, visibility: dm('A', 'B'), text: 'I allocate B#7 to you',
    act: { type: 'allocate', ref: 'x', caravan: cv(7, 'B'), qty: 100 } }), RecordError);
  const m = newMemory();
  const p = promise(m);
  caravanFacts(m);
  assert.equal(allocateOp(m, { ref: p.accept, by: 'B', signAs: 'C' }).reason, 'auth_bad_signature', 'C cannot sign as B');
  assert.equal(m.allocate(signedAllocation({ by: 'Z', commitment: p.accept, caravan: cv(7, 'B'), nonce: 1, bell: 102, visibility: dm('A', 'B') })).reason,
    'auth_unknown_signer');
  // a signed allocation for another world is refused by the signature (the world is part of the signed bytes)
  const other = signedAllocation({ by: 'B', commitment: p.accept, caravan: cv(7, 'B'), nonce: 9, bell: 102, visibility: dm('A', 'B'), world: { ...WORLD, world_id: 'another-world' } });
  assert.equal(m.allocate({ ...other, world: WORLD }).reason, 'auth_bad_signature');
  assert.equal(one(m).links.length, 0);
  assert.equal(one(m).reasons[0], 'no_record_found');
  // a third party with a valid key is not a party to the promise
  allocateOp(m, { ref: p.accept, by: 'C', vis: PUBLIC });
  assert.equal(one(m).links[0].state, 'not_a_party');
  // tampering a signed field breaks the signature
  const good = signedAllocation({ by: 'B', commitment: p.accept, caravan: cv(7, 'B'), qty: 100, nonce: 1, bell: 102, visibility: dm('A', 'B') });
  assert.equal(m.allocate({ ...good, qty: 90 }).reason, 'auth_bad_signature');
  assert.equal(m.allocate(good).status, 'added');
  assert.equal(one(m).state, 'fulfilled');
});

test('allocation: private to the parties, and an edited journal line fails verification on replay', () => {
  const dir = mkdtempSync(join(tmpdir(), 'm12v3-'));
  const path = join(dir, 'journal.jsonl');
  const m = newMemory({ path });
  const p = promise(m);
  const id = allocate(m, { ref: p.accept });
  assert.ok(!m.knowledge(C, 300).ids.has(id));
  const lines = readFileSync(path, 'utf8').split('\n');
  const i = lines.findIndex(l => l.includes(id));
  lines[i] = lines[i].replace('"qty":100', '"qty":999');
  writeFileSync(path, lines.join('\n'));
  assert.throws(() => newMemory({ path }), /fails verification/);
});
