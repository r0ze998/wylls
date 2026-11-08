// Key-free. Per-record provenance (13's request on 7b75122f): a decided state rests on facts, and each fact says where
// it was read. A fixture coverage observed into a memory that also holds chain-read receipts must not make a breach
// look chain-grounded. Imports: 12's src and adapters only. No allocation is made (no signature): not_sent needs none.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemory } from '../src/index.mjs';
import { SEND_ROUTES } from '../src/records.mjs';
import { b58encode, worldFromSeason, ws12EvidencePort, resolverFromIdentity } from '../adapters/canonical.mjs';

const bytes = f => Buffer.alloc(32, f);
const PROGRAM = b58encode(bytes(0x21)), SEASON_PDA = b58encode(bytes(0x42)), A = b58encode(bytes(0x0a)), B = b58encode(bytes(0x0b));
const W = worldFromSeason({ programId: PROGRAM, cluster: 'localnet-fixture', season: '1', seasonAddress: SEASON_PDA, genesisTs: 0, bellSecs: 600, continuous: true, latestSlot: 1, latestUnix: 600 * 400, slot: 1 });
const TAG = '0000000000000077';
const PUB = { scope: 'public' };
const CHAIN = { kind: 'chain', source: 'herald /h/me @slot 30' };
const FIX = { kind: 'fixture', source: 'ws12 test coverage' };
const alias = basis => ({ kind: 'identity_alias', bell: 0, created_bell: 0, visibility: PUB, source: { chain: 'resolver', sig: `${W.partition}|${TAG}|${B}`, ix: 0 }, data: { partition: W.partition, tag: TAG, principal: B }, ...(basis ? { basis } : {}) });
const coverage = basis => ({ kind: 'coverage', bell: 20, created_bell: 20, visibility: PUB, source: { chain: 'index', sig: 'cov-B-0-20', ix: 0 }, ...(basis ? { basis } : {}),
  data: { world: W.world, partition: W.partition, sender: TAG, from_bell: 0, to_bell: 20, routes: [...SEND_ROUTES], finality: 'finalized', completeness: { gapless: true, from_slot: 0, to_slot: 99 }, caravans: [] } });
function promised(path) {
  const m = createMemory({ path, world: W.world, partitions: W.partitions });
  const place = { partition: W.partition, kind: 2, p: 1, q: 0, at: 5, gen: 1 };
  const req = m.say({ speaker: A, bell: 0, visibility: PUB, act: { type: 'request', to: B, resource: 'science', qty: 3, by_bell: 1, place } });
  m.say({ speaker: B, bell: 0, visibility: PUB, act: { type: 'accept', ref: req.id, qty: 3, by_bell: 1 } });
  return m;
}
const one = m => m.knowledge({ tag: A, nation: null }, 300).commitments[0];

test("a breach decided by a fixture coverage is fixture-grounded even when the alias is chain-read (13's hole)", () => {
  const m = promised(null);
  m.observe(alias(CHAIN));
  m.observe(coverage(FIX));
  const c = one(m);
  assert.equal(c.state, 'not_sent');
  assert.equal(c.evidence_basis.kind, 'fixture');
  assert.deepEqual(c.evidence_basis.records.map(r => r.kind).sort(), ['chain', 'fixture']);
  assert.ok(c.evidence_basis.records.some(r => r.source === CHAIN.source), 'the alias that tied the coverage to B is among the grounds');
});

test('only when every fact behind the breach is chain-read is it chain-grounded; a fact without a basis is unstated', () => {
  const m = promised(null);
  m.observe(alias(CHAIN));
  m.observe(coverage({ kind: 'chain', source: 'index /h/departures' }));
  assert.equal(one(m).evidence_basis.kind, 'chain');
  const m2 = promised(null);
  m2.observe(alias(null)); // legacy: no basis
  m2.observe(coverage({ kind: 'chain', source: 'index' }));
  assert.equal(one(m2).evidence_basis.kind, 'unstated');
  // an undecided promise rests on no fact: no basis to claim
  assert.equal(one(promised(null)).evidence_basis, null);
});

test('the same record read again with another basis is a collision; the first is kept, across a restart', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'ws12-basis-')), 'm.jsonl');
  const m = promised(path);
  m.observe(alias(CHAIN));
  assert.equal(m.observe(coverage(FIX)).status, 'added');
  assert.equal(m.observe(coverage({ kind: 'chain', source: 'index' })).status, 'collision', 'a chain reading cannot overwrite the fixture one');
  assert.equal(m.observe(coverage(FIX)).status, 'duplicate');
  const again = createMemory({ path, world: W.world, partitions: W.partitions });
  assert.equal(one(again).evidence_basis.kind, 'fixture');
  assert.throws(() => m.observe(coverage({ kind: 'onchain', source: 'x' })), /basis/);
  assert.throws(() => m.observe(coverage({ kind: 'chain', source: '' })), /basis/);
});

test("the evidence port carries each commitment line's evidence_basis to 13", () => {
  const m = promised(null);
  m.observe(alias(CHAIN));
  m.observe(coverage(FIX));
  const ids = { walletKnown: w => (w === B ? { tag: TAG, partition: W.partition, source: 'fixture pairing' } : null) };
  const r = ws12EvidencePort(m, { identity: ids, worldBellOf: b => b }).read({ counterparty: B, worldBell: 300 });
  assert.equal(r.status, 'ok');
  const line = r.lines.find(l => l.evidence_basis);
  assert.ok(line, 'the commitment line has its basis');
  assert.equal(line.evidence_basis.kind, 'fixture');
  void resolverFromIdentity;
});
