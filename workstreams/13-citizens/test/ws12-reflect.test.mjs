// Workstream 12's memory changing a resident's decision (workstream 12 c6877a1a, keyless), and every way it must not.
//
// The memory holds, all PUBLIC and built without any key or signature:
//   - a promise in words: X asks Kou for 3 science by bell 1, Kou accepts (12's `say`);
//   - workstream 4's attestation that Kou's chain tag in this world's partition is Kou's wallet (`identity_alias`);
//   - an index attestation that Kou's departures over bells 0..9 are complete, gapless and finalized, with no caravan
//     (`coverage`). 12's fold then DECIDES the promise `not_sent` (verified).
// Later Kou asks the resident Ren for food. Without the evidence Ren accepts; with it, acted on, Ren does not send
// first (the accept is held as 'ws12-verified-breach') and the decision records the commitment and the basis.
//
// None of these records came from a chain: the herald answers, the finality and the coverage are FIXTURES. So the
// one success case runs under the explicit test switch `evidenceUse: 'fixture-for-tests-only'`, and records basis
// `fixture`; the same inputs without the switch change nothing. Each missing piece (clock, world, finality,
// identity, decision) is refused on its own.
// Set WS12_ROOT to a tree with workstream 12 at c6877a1a (or later); skipped otherwise.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { small, run } from './helpers.mjs';
import { ws12CanonicalEvidence, basisOf, basisCheck } from '../resident/ports/ws12-canonical.mjs';
import { seasonClock, MOCK_CLOCK } from '../resident/frame.mjs';
import { decisionsOf } from '../demo/report.mjs';

const ROOT = ws12('evidence-basis').root;
const skip = ROOT ? false : 'workstream 12 fa4baf14 or later, with evidence_basis (WS12_ROOT, or in this tree)';
const m12 = rel => import(pathToFileURL(path.join(ROOT, 'workstreams/12-memory', rel)).href);

import { PROGRAM, ALL_FIXTURE, FIXTURE, heraldMe, memoryFor as memoryFor12 } from './ws12-fixture.mjs';
import { ws12 } from './roots.mjs';
// Needs workstream 12 at fa4baf14 or later (per-fact basis, per-commitment evidence_basis).
const memoryFor = (kou, o) => memoryFor12(m12, kou, o);

/**
 * Ren and Kou; Kou asks Ren for food at bell 10. `setUp(env, ctx)` wires the evidence port; returns Ren's decisions and
 * whether Ren accepted Kou's request.
 */
async function play(setUp = null) {
  const env = await small({ residents: [{ id: 'ren', goal: 'surplus-use', pos: { q: 0, r: 0 } }], people: [{ name: 'Kou', pos: { q: 2, r: 0 },
    async script(bell, me) { if (bell === 10) await me.post({ kind: 'request', to: 'c1', want: { Food: 40 }, offer: { Ore: 40 }, deadlineBell: 60 }); } }] });
  if (setUp) await setUp(env);
  await run(env, 18);
  const ren = env.rs.ren;
  const ds = decisionsOf(ren);
  const accepted = Object.values(ren.state.journal).some(j => j.purpose?.type === 'accept');
  const onKou = ds.filter(d => d.evidence?.some(e => e.counterparty === env.ps.Kou.address));
  return { env, ren, ds, accepted, onKou, held: ds.flatMap(d => d.excluded).filter(x => x.reason === 'ws12-verified-breach') };
}

/** The canonical port and a resident observe port on 12's world and Season clock (both declared by this test). */
async function wire(env, { mem = {}, clock = 'season', world = 'same', known = true, provenance = ALL_FIXTURE, use = 'fixture-for-tests-only' } = {}) {
  const c = await m12('adapters/canonical.mjs');
  const { m, w } = await memoryFor(env.ps.Kou.address, mem);
  const residentClock = clock === 'season' ? seasonClock(w.clock) : clock === 'other-bellSecs' ? seasonClock({ ...w.clock, bellSecs: 300 }) : MOCK_CLOCK;
  const residentWorld = world === 'same' ? w.world : world === 'other' ? { cluster: w.world.cluster, world_id: `${PROGRAM}/Other1111111111111111111111111111111111111` } : env.rs.ren.ports.observe.world;
  const ids = c.resolverFromIdentity(known ? [c.identityFromHeraldMe(await heraldMe(m12, env.ps.Kou.address), { partition: w.partition }).entry] : []);
  const ren = env.rs.ren;
  ren.ports.observe = Object.assign(ren.ports.observe.bind(null), { world: residentWorld, clock: residentClock });
  ren.ports.evidence = ws12CanonicalEvidence({ ws12EvidencePort: c.ws12EvidencePort, memory: m, identity: ids, worldClock: w.clock, residentClock, provenance });
  if (use) ren.ports.evidenceUse = use;
  return { m, w };
}

test('baseline: without workstream 12, Ren accepts Kou\'s request', async () => {
  const r = await play();
  assert.equal(r.accepted, true);
  assert.deepEqual(r.held, []);
});

test('basis: chain only with every part chain and sourced and a finalized attestation; cross_checked counts as neither finality nor completeness', () => {
  const W = { cluster: 'c', world_id: 'P/S' };
  const chain = { kind: 'chain', source: 'rpc getAccountInfo (finalized)' };
  const fin = { ...chain, commitment: 'finalized', slot: 900, world_id: 'P/S' };
  const all = { world: chain, clock: chain, finality: fin, identity: chain, records: chain };
  assert.deepEqual(basisCheck(all, { world: W }), { basis: 'chain', why: [] });
  assert.equal(basisOf({ ...ALL_FIXTURE }), 'fixture');
  assert.equal(basisOf({ ...all, finality: FIXTURE }), 'fixture');
  assert.equal(basisOf({ ...all, finality: chain }, { world: W }), 'unstated', 'chain finality without commitment/slot/world_id');
  assert.equal(basisOf({ ...all, finality: { ...fin, world_id: 'P/OTHER' } }, { world: W }), 'unstated');
  assert.equal(basisOf({ ...all, world: { kind: 'chain' } }), 'unstated', 'a chain part needs its source');
  assert.equal(basisOf({ ...all, records: { kind: 'integration-output', source: 'runexec demo' } }, { world: W }), 'integration-output');
  assert.equal(basisOf(null), 'unstated');
  // workstream 19's cross_checked, offered as finality or as completeness of the history: refused, and said why
  const x = basisCheck({ ...all, finality: { kind: 'chain', source: 'ws19', cross_checked: true } }, { world: W });
  assert.equal(x.basis, 'unstated');
  assert.ok(x.why.includes('finality: cross_checked is not finality'));
  const y = basisCheck({ ...all, records: { kind: 'chain', source: 'ws19', cross_checked: true } }, { world: W });
  assert.ok(y.why.includes('records: cross_checked is not completeness'));
  // workstream 19's history words: never complete; not_fetched and gaps are not absence
  // workstream 19's real fields (cf517b55 docs/frontier/history-coverage.ja.md)
  for (const records of [{ ...chain, complete: null }, { ...chain, complete: false }, { ...chain, history_unproven: true },
    ...['not_fetched', 'gap', 'unverifiable', 'cross_checked'].map(state => ({ ...chain, coverage: { state, range: [0, 900], heldBack: 0 } })),
    { ...chain, coverage: { state: 'cross_checked', heldBack: 3 } },
    ...['as_given', 'ledger_feed', 'unproven'].map(basis => ({ ...chain, history: { basis, complete: basis === 'unproven' ? false : null, scope: 'observed_transactions' } })),
    { ...chain, findings: ['HistoryUnproven'] }]) {
    const z = basisCheck({ ...all, records }, { world: W });
    assert.equal(z.basis, 'unstated', JSON.stringify(records));
    assert.ok(z.why.some(w => /history|coverage|HistoryUnproven/.test(w)), JSON.stringify(z.why));
  }
});

test('success (fixture inputs, test switch on): world, clock, finality and identity line up; 12 decides not_sent; Ren does not send first', { skip }, async () => {
  const r = await play(env => wire(env));
  assert.equal(r.accepted, false, 'the accept was held');
  assert.ok(r.held.length > 0);
  assert.equal(r.held[0].basis, 'fixture', 'the decision records that the basis was a fixture');
  assert.equal(r.held[0].commitments.length, 1);
  const ev = r.onKou.flatMap(d => d.evidence).find(e => e.status === 'ok');
  assert.deepEqual([ev.basis, ev.acted, ev.verifiedBreaches.length], ['fixture', true, 1]);
  // Ren still answers Kou: it declines (with a reason) or waits; it never sends to Kou.
  assert.ok(r.ds.every(d => !(d.kind === 'accept')), 'no accept chosen');
  // Trust and scores are not raised or lowered by 12: only the hold.
  assert.equal(r.ren.trust(r.env.ps.Kou.address), 0);
});

const notActed = (r, status) => {
  assert.equal(r.accepted, true, `${status}: Ren decides as without workstream 12`);
  assert.deepEqual(r.held, []);
  const ev = r.onKou.flatMap(d => d.evidence);
  assert.ok(ev.length > 0, 'the withholding or the refusal is recorded');
  return ev;
};

test('refused: the same fixture inputs without the test switch are shown and recorded, never acted on', { skip }, async () => {
  const r = await play(env => wire(env, { use: null }));
  const ev = notActed(r, 'fixture basis').find(e => e.status === 'ok');
  assert.deepEqual([ev.basis, ev.acted, ev.notActedBecause], ['fixture', false, 'basis fixture: not chain evidence']);
  assert.equal(ev.verifiedBreaches.length, 1, '12 decided it; 13 did not take a fixture for chain evidence');
});

test('refused: provenance not stated', { skip }, async () => {
  const r = await play(env => wire(env, { provenance: null }));
  const ev = notActed(r, 'unstated').find(e => e.status === 'ok');
  assert.equal(ev.basis, 'unstated');
});

test("refused: the resident's clock is not the world's (test world clock; and a Season clock with another bellSecs)", { skip }, async () => {
  for (const clock of ['mock', 'other-bellSecs']) {
    const r = await play(env => wire(env, { clock }));
    const ev = notActed(r, clock);
    assert.ok(ev.every(e => e.status === 'clock_mismatch'), `${clock}: ${ev.map(e => e.status)}`);
  }
});

test('refused: another world, or a memory without a world', { skip }, async () => {
  const other = await play(env => wire(env, { world: 'other' }));
  assert.ok(notActed(other, 'other world').every(e => e.status === 'world_mismatch'));
  const none = await play(env => wire(env, { mem: { withWorld: false } }));
  assert.ok(notActed(none, 'no world').every(e => e.status === 'world_unverified'));
});

test('refused: no finality (the index attestation is only confirmed): 12 does not decide, nothing is acted on', { skip }, async () => {
  const r = await play(env => wire(env, { mem: { finality: 'confirmed' } }));
  const ev = notActed(r, 'confirmed').find(e => e.status === 'ok');
  assert.deepEqual(ev.verifiedBreaches, []);
  assert.ok(!ev.epistemic.includes('verified'));
});

test('refused: no index attestation at all: the promise stays unknown, never read as not sent', { skip }, async () => {
  const r = await play(env => wire(env, { mem: { coverage: false } }));
  const ev = notActed(r, 'no coverage').find(e => e.status === 'ok');
  assert.deepEqual(ev.verifiedBreaches, []);
});

test('refused: Kou is not paired with a citizen of this world (identity)', { skip }, async () => {
  const r = await play(env => wire(env, { known: false }));
  assert.ok(notActed(r, 'identity').every(e => e.status === 'identity_unverified'));
});

// ---- workstream 12's per-commitment evidence basis (fa4baf14) ------------------------------------------------------
const CHAIN_DECLARED = (() => { const c = { kind: 'chain', source: 'test: DECLARED chain over fixture records (the hole 12 closed)' }; return { world: c, clock: c, finality: { ...c, commitment: 'finalized', slot: 900, world_id: null }, identity: c, records: c }; })();

test("per record: the facts behind the breach must be chain-read too; a port declared chain over fixture records does not act", { skip }, async () => {
  // the port-level provenance claims chain (as a careless caller could); 12's evidence_basis says the coverage and
  // the alias are fixtures: nothing is acted on, and the decision says why.
  const r = await play(async env => {
    const ctx = await wire(env, { use: null, provenance: null });
    const prov = { ...CHAIN_DECLARED, finality: { ...CHAIN_DECLARED.finality, world_id: ctx.w.world.world_id } };
    const c = await m12('adapters/canonical.mjs');
    const ren = env.rs.ren;
    const ids = c.resolverFromIdentity([c.identityFromHeraldMe(await heraldMe(m12, env.ps.Kou.address), { partition: ctx.w.partition }).entry]);
    ren.ports.evidence = ws12CanonicalEvidence({ ws12EvidencePort: c.ws12EvidencePort, memory: ctx.m, identity: ids, worldClock: ctx.w.clock, residentClock: ren.ports.observe.clock, provenance: prov });
    assert.equal(ren.ports.evidence.basis, 'chain', 'the port-level check alone would have said chain');
  });
  const ev = notActed(r, 'per-record fixture').find(e => e.status === 'ok');
  assert.deepEqual(ev.evidenceBases, ['fixture']);
  assert.match(ev.notActedBecause, /facts behind the breach are fixture/);
});

test('per record: records without a basis are unstated and never act, even under the test switch', { skip }, async () => {
  const r = await play(env => wire(env, { mem: { basis: null } }));
  const ev = notActed(r, 'unstated records').find(e => e.status === 'ok');
  assert.deepEqual(ev.evidenceBases, ['unstated']);
});
