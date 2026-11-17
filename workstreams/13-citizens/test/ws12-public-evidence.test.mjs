import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ws12PublicEvidence } from '../resident/ports/ws12-public-evidence.mjs';
import { localMemory, trustOf } from '../resident/ports/memory.mjs';
import { createMemory } from '../../12-memory/src/index.mjs';
import { newMemory, promise, coverage, PUBLIC, dm } from '../../12-memory/fixtures/scenario.mjs';

const bindB = () => ({ principal: 'B', source: 'fixture-identity-alias-B' });
const readB = sidecar => sidecar.read({ counterparty: 'wallet-of-B', worldBell: 300 });

test('without a sourced identity mapping, the sidecar makes no claim about a wallet', () => {
  const m = newMemory();
  promise(m, { vis: PUBLIC });
  const sidecar = ws12PublicEvidence(m);
  assert.deepEqual(readB(sidecar), { status: 'identity_unverified', lines: [] });
  assert.equal(sidecar.append, undefined, 'the evidence sidecar cannot replace the resident MemoryPort');
  assert.equal(sidecar.recall, undefined);
  assert.equal(sidecar.all, undefined);
  assert.deepEqual(readB(ws12PublicEvidence(m, { resolvePrincipal: () => ({ principal: 'B' }) })),
    { status: 'identity_unverified', lines: [] });
});

test('without a pinned continuing world, public evidence is withheld', () => {
  const m = createMemory();
  promise(m, { vis: PUBLIC });
  assert.deepEqual(readB(ws12PublicEvidence(m, { resolvePrincipal: bindB })),
    { status: 'world_unverified', lines: [] });
});

test('a public promise with no execution evidence stays unknown and does not change 13 trust', () => {
  const m = newMemory();
  promise(m, { vis: PUBLIC });
  const sidecar = ws12PublicEvidence(m, { resolvePrincipal: bindB });
  const lines = readB(sidecar).lines;
  assert.equal(lines.length, 1);
  assert.equal(lines[0].epistemic, 'unknown');
  assert.match(lines[0].text, /not decided|no record found/i);
  assert.ok(lines[0].sources.length > 0);
  assert.equal(lines[0].identitySource, 'fixture-identity-alias-B');
  assert.equal(trustOf(localMemory(null), 'wallet-of-B'), 0);
});

test('even a verified public shortfall remains evidence, never an automatic broken episode', () => {
  const m = newMemory();
  promise(m, { vis: PUBLIC });
  coverage(m); // fixture of all send routes, gapless finalized index, and identity alias
  const sidecar = ws12PublicEvidence(m, { resolvePrincipal: bindB });
  const lines = readB(sidecar).lines;
  assert.equal(lines.length, 1);
  assert.equal(lines[0].epistemic, 'verified');
  assert.match(lines[0].text, /not sent/i);
  assert.equal(sidecar.append, undefined);
});

test('late index evidence is invisible before observation and never rewrites an earlier view', () => {
  const m = newMemory();
  promise(m, { vis: PUBLIC });
  coverage(m, { created: 310 });
  const sidecar = ws12PublicEvidence(m, { resolvePrincipal: bindB });
  assert.equal(sidecar.read({ counterparty: 'wallet-of-B', worldBell: 300 }).lines[0].epistemic, 'unknown');
  assert.equal(sidecar.read({ counterparty: 'wallet-of-B', worldBell: 300, observedBy: 320 }).lines[0].epistemic, 'verified');
  assert.equal(sidecar.read({ counterparty: 'wallet-of-B', worldBell: 320 }).lines[0].epistemic, 'verified');
});

test('the public sidecar does not reveal parties-only or nation evidence', () => {
  const m = newMemory();
  promise(m, { vis: dm('A', 'B') });
  promise(m, { bell: 110, vis: { scope: 'nation', nation: 1 } });
  const sidecar = ws12PublicEvidence(m, { resolvePrincipal: bindB });
  assert.deepEqual(readB(sidecar), { status: 'ok', lines: [] });
});
