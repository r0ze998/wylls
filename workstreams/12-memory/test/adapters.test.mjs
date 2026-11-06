// Workstream 12 adapters: contract tests against workstream 4's real receipt output (fixtures/ws04-receipts, produced
// by 4's runexec on its simulated world at integration d0949fd4), workstream 8's continuous-world identity, and
// workstream 13's MemoryPort contract. All data is synthetic: no player data, no chain, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, appendFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemory } from '../src/index.mjs';
import { canonical, sha256hex } from '../src/records.mjs';
import { clockFromGenesis, worldConfig } from '../adapters/ws08-world.mjs';
import { ingestReceipts, parseJsonU64, parseSubject, receiptToFacts, tagHexOf } from '../adapters/ws04-receipts.mjs';
import { counterpartyOf, mirrorMemoryPort } from '../adapters/ws13-resident.mjs';
import { dm, keysFor, signedAllocation } from '../fixtures/scenario.mjs';

// ---- the synthetic world: 8's shape (one continuous world account), wallet principals (13's naming)
const PROGRAM = 'FronT1erProgramXXXXXXXXXXXXXXXXXXXXXXXXXXXX'.replace(/[0OIl]/g, 'x');
const ACCOUNT = 'WorLdAccountSeasonPdaXXXXXXXXXXXXXXXXXXXXXX'.replace(/[0OIl]/g, 'x');
const CREDITOR = 'Acreditor111111111111111111111111111111111';
const DEBTOR = 'Bdebtor11111111111111111111111111111111111';
const KEYS = keysFor([CREDITOR, DEBTOR]);
const W = worldConfig({ cluster: 'localnet-fixture', program: PROGRAM, worldAccount: ACCOUNT, seasonId: 1, continuous: true });
const P = W.partition;
const OWNER_HEX = '0000000000000077'; // the runs' owner in 4's vectors (owner 119)
const newMem = (opts = {}) => createMemory({ world: W.world, partitions: W.partitions, keys: KEYS, ...opts });
const resolveOwner = hex => (hex === OWNER_HEX ? { principal: DEBTOR, source: 'fixture:with_seed(world, citizen_seed(wallet))' } : null);
const bellOfSlot = clockFromGenesis({ genesisTs: 1_000_000, bellSecs: 600, blockTimeOfSlot: slot => 1_000_000 + (100 + slot) * 600 }); // slot s -> bell 100 + s

const vectors = name => {
  const v = JSON.parse(readFileSync(new URL(`../fixtures/ws04-receipts/${name}.json`, import.meta.url), 'utf8'));
  const receipts = v.receipts.map(r => ({ run_id: r.run_id, kind: r.kind, subject: r.subject, source: r.source, slot: r.slot, body: parseJsonU64(r.body_json) }));
  const runSpecs = Object.fromEntries(Object.entries(v.run_specs_json).map(([k, s]) => [k, parseJsonU64(s)]));
  return { receipts, runSpecs, provenance: v.provenance };
};
const ctx = (runSpecs, over = {}) => ({ partition: P, observedBell: 200, bellOfSlot, finalizedSlot: 1_000, runSpecs, resolveOwner, ...over });
const DST = { partition: P, kind: 2, p: 1, q: 0, at: 5, gen: 1 }; // the vectors' destination (a vault)
const CV = { partition: P, sender: OWNER_HEX, seq: 0 };

/** A promise of 3 science (resource 6 in the vectors) to the vectors' vault, with the debtor's signed allocation. */
function promiseAndAllocate(m, { due = 130, alloc = true } = {}) {
  const req = m.say({ speaker: CREDITOR, bell: 100, visibility: dm(CREDITOR, DEBTOR), act: { type: 'request', to: DEBTOR, resource: 'science', qty: 3, by_bell: due, place: DST } });
  const acc = m.say({ speaker: DEBTOR, bell: 101, visibility: dm(CREDITOR, DEBTOR), act: { type: 'accept', ref: req.id, qty: 3, by_bell: due } });
  if (alloc) m.allocate(signedAllocation({ world: W.world, by: DEBTOR, commitment: acc.id, caravan: CV, qty: 3, nonce: 1, bell: 102, visibility: dm(CREDITOR, DEBTOR) }));
  return acc.id;
}
const viewer = { tag: CREDITOR, nation: 1 };
const one = (m, at = 300) => m.knowledge(viewer, at).commitments[0];
const stateHash = (m, at = 300) => { const k = m.knowledge(viewer, at); return sha256hex(canonical({ c: k.commitments, r: k.reliability, f: k.facts.map(f => f.id).sort(), u: k.unusable })); };

// ---------------------------------------------------------------- 8: world
test('ws08: a continuous world account gives one world and one partition; a non-continuous one gives no world', () => {
  assert.deepEqual(W.world, { cluster: 'localnet-fixture', world_id: `${PROGRAM}/${ACCOUNT}` });
  assert.deepEqual(W.partitions, { [ACCOUNT]: { program: PROGRAM, season: 1 } });
  const old = worldConfig({ cluster: 'localnet-fixture', program: PROGRAM, worldAccount: ACCOUNT, seasonId: 1, continuous: false });
  assert.equal(old.world, null);
  assert.deepEqual(old.reasons, ['world_not_continuous']);
  assert.throws(() => worldConfig({ cluster: 'x', program: 'not base58 0OIl', worldAccount: ACCOUNT, seasonId: 1, continuous: true }));
  // the Season bell, from block time (null when unknown or before genesis: the caller holds the record)
  const clk = clockFromGenesis({ genesisTs: 600, bellSecs: 600, blockTimeOfSlot: s => (s < 0 ? null : 600 + s * 10) });
  assert.deepEqual([clk(0), clk(59), clk(60), clk(-1)], [0, 0, 1, null]);
  const clk300 = clockFromGenesis({ genesisTs: 600, bellSecs: 300, blockTimeOfSlot: s => 600 + s * 10 });
  assert.deepEqual([clk300(29), clk300(30)], [0, 1], 'the bell length is the herald\'s bellSecs');
  assert.throws(() => clockFromGenesis({ genesisTs: 0, blockTimeOfSlot: () => 0 }), /bellSecs/);
});

// ---------------------------------------------------------------- 4: receipts (real vectors)
test('ws04: the vectors come from 4\'s runexec and parse exactly', () => {
  const { receipts, runSpecs, provenance } = vectors('happy');
  assert.equal(provenance.commit, 'd0949fd417180b11704de5690ab0dfb6e5ef3148');
  assert.deepEqual(receipts.map(r => r.kind), ['facility_used', 'caravan_sent', 'caravan_settled']);
  assert.deepEqual(parseSubject(receipts[1].subject), { ownerHex: OWNER_HEX, seq: 0 });
  assert.deepEqual(runSpecs['demo-happy'].ship.dst, { kind: 2, p: 1, q: 0, at: 5, gen: 1 });
});

test('ws04: a delivered run (happy) becomes a fulfilled promise only through its finalized receipts and the allocation', () => {
  const { receipts, runSpecs } = vectors('happy');
  const m = newMem();
  promiseAndAllocate(m);
  const r = ingestReceipts(m, receipts, ctx(runSpecs));
  assert.deepEqual(r.held.map(h => h.why), ['not_a_memory_input'], 'facility_used is not a memory input');
  assert.deepEqual(m.journal.records().filter(x => x.type === 'fact').map(x => x.kind).sort(),
    ['caravan_credited', 'caravan_sent', 'caravan_settled', 'identity_alias'].sort());
  const c = one(m);
  // 4's vectors have no place_owner attestation: the recipient is not verified, so it is not "fulfilled" yet
  assert.deepEqual([c.state, c.reasons], ['unconfirmed', ['recipient_unverified']]);
  m.observe({ kind: 'place_owner', bell: 124, source: { chain: 'index', sig: 'owner-fixture', ix: 0 }, data: { place: DST, owner: CREDITOR, from_bell: 0, to_bell: null } });
  assert.equal(one(m).state, 'fulfilled');
  assert.equal(one(m).links[0].credit.basis, 'exec_record', 'the settle record\'s credited (P1, simulated) is the basis');
  assert.ok(!m.journal.records().some(x => x.kind === 'coverage' || x.kind === 'lookup_failed'), 'nothing is inferred from absence');
});

test('ws04: a raided run is neutral; the raider is named exactly; no reputation moves', () => {
  const { receipts, runSpecs } = vectors('raid');
  const m = newMem();
  promiseAndAllocate(m);
  ingestReceipts(m, receipts, ctx(runSpecs));
  const raid = m.journal.records().find(x => x.kind === 'caravan_raided');
  assert.equal(raid.data.raider, '0000000000000055');
  const k = m.knowledge(viewer, 300);
  assert.equal(k.commitments[0].state, 'raided');
  assert.equal(k.reliability[DEBTOR].E, 0.5);
});

test('ws04: the same caravan reported by several runs, or read from the feed and from history, is one fact', () => {
  const m = newMem();
  promiseAndAllocate(m);
  const all = ['happy', 'crash', 'lost-response'].map(vectors);
  for (const v of all) ingestReceipts(m, v.receipts, ctx(v.runSpecs));
  const facts = m.journal.records().filter(x => x.type === 'fact');
  assert.equal(facts.filter(f => f.kind === 'caravan_settled').length, 1);
  assert.equal(facts.filter(f => f.kind === 'caravan_sent').length, 1);
  assert.deepEqual(m.journal.rejected(), [], 'three runs restating one caravan (and its owner\'s identity) collide nowhere');
  // the entity history's copy of the settle: another `source`, same event
  const settle = all[0].receipts.find(r => r.kind === 'caravan_settled');
  const viaHistory = { ...settle, source: 'history:settle:cv:77:0', run_id: 'other-run' };
  const again = ingestReceipts(m, [viaHistory], ctx(all[0].runSpecs));
  assert.deepEqual([again.added, again.collision, again.held.length], [0, 0, 0]);
  assert.ok(again.duplicate >= 2, 'the settle and its credit are duplicates');
  // the same kind|subject with another body is a collision: kept apart, the first stands
  const forged = { ...settle, body: { ...settle.body, cargo: [0, 0, 0, 0, 0, 0, 9, 0] } };
  assert.equal(ingestReceipts(m, [forged], ctx(all[0].runSpecs)).collision, 1);
  assert.equal(m.journal.rejected().at(-1).reason, 'collision');
  assert.equal(one(m).links[0].qty, 3);
});

test('ws04: receipts in any order give the same memory', () => {
  const { receipts, runSpecs } = vectors('happy');
  const perms = [[0, 1, 2], [2, 1, 0], [1, 2, 0], [2, 0, 1]];
  const hashes = perms.map(order => {
    const m = newMem();
    promiseAndAllocate(m);
    ingestReceipts(m, order.map(i => receipts[i]), ctx(runSpecs));
    return stateHash(m);
  });
  assert.equal(new Set(hashes).size, 1);
});

test('ws04: unfinalized receipts are held, not believed; they enter once finalized, without doubling', () => {
  const { receipts, runSpecs } = vectors('happy');
  const m = newMem();
  promiseAndAllocate(m);
  const r1 = ingestReceipts(m, receipts, ctx(runSpecs, { finalizedSlot: 10 })); // settle is at slot 24
  assert.deepEqual(r1.held.map(h => h.why).sort(), ['not_a_memory_input', 'not_finalized']);
  assert.equal(one(m).state, 'unconfirmed', 'sent but not settled on record: unknown, not delivered');
  const r2 = ingestReceipts(m, receipts, ctx(runSpecs, { finalizedSlot: 30 }));
  assert.equal(r2.held.length, 1);
  assert.ok(r2.added >= 2 && r2.duplicate >= 2, 'what was in already is a duplicate');
  assert.equal(m.journal.records().filter(x => x.kind === 'caravan_settled').length, 1);
  // no finalized slot attested at all: nothing is believed
  const m2 = newMem();
  assert.equal(ingestReceipts(m2, receipts, ctx(runSpecs, { finalizedSlot: null })).added, 0);
});

test('ws04: missing pieces stay unknown: no run spec, no clock, no identity', () => {
  const { receipts, runSpecs } = vectors('happy');
  let m = newMem();
  promiseAndAllocate(m);
  const r = ingestReceipts(m, receipts, ctx({}));
  assert.ok(r.held.some(h => h.why === 'dst_unknown'), 'the sent receipt has no destination of its own');
  assert.deepEqual(one(m).reasons, ['caravan_unknown']);
  m = newMem();
  promiseAndAllocate(m);
  assert.ok(ingestReceipts(m, receipts, ctx(runSpecs, { bellOfSlot: () => null })).held.every(h => ['clock_unmapped', 'not_a_memory_input'].includes(h.why)));
  m = newMem();
  promiseAndAllocate(m);
  ingestReceipts(m, receipts, ctx(runSpecs, { resolveOwner: () => null }));
  assert.deepEqual(one(m).reasons, ['identity_unverified'], 'a tag without 4/8\'s resolution is nobody');
  // and past the due bell, with no receipts and no coverage, nothing is ever "not sent"
  m = newMem();
  promiseAndAllocate(m, { alloc: false });
  assert.equal(one(m).state, 'unconfirmed');
  assert.deepEqual(one(m).reasons, ['no_record_found']);
});

test('ws04: u64 tags above 2^53 stay exact; a lossy parse is refused, not rounded', () => {
  // 2^63 + 12345: a plain JSON.parse rounds it to another value that is still a valid u64 (a wrong tag, not an error)
  const owner = 0xfedcba9876543210n, raider = 9223372036854788153n;
  const subject = `cv:${owner.toString(16)}:5`;
  const bodyText = `{"choice":1,"key":{"owner":${owner},"seq":5},"raider":${raider},"slot":40,"taken":[0,1,0,0,0,0,0,0]}`;
  const exact = { run_id: 'r', kind: 'caravan_raided', subject, source: 'event:x', slot: 40, body: parseJsonU64(bodyText) };
  const f = receiptToFacts(exact, ctx({})).facts.find(x => x.kind === 'caravan_raided');
  assert.equal(f.data.caravan.sender, 'fedcba9876543210');
  assert.equal(f.data.raider, raider.toString(16).padStart(16, '0'));
  const lossy = { ...exact, body: JSON.parse(bodyText) }; // raider rounded by a plain parse
  assert.match(receiptToFacts(lossy, ctx({})).held.why, /^malformed_body/);
  assert.equal(tagHexOf('119'), OWNER_HEX);
});

test('ws04: a restart replays to the same memory, and re-feeding everything adds nothing', () => {
  const { receipts, runSpecs } = vectors('happy');
  const dir = mkdtempSync(join(tmpdir(), 'm12ad-'));
  const path = join(dir, 'journal.jsonl');
  const live = newMem();
  promiseAndAllocate(live);
  ingestReceipts(live, receipts, ctx(runSpecs));
  const a = newMem({ path });
  promiseAndAllocate(a);
  ingestReceipts(a, receipts.slice(0, 2), ctx(runSpecs));
  const b = newMem({ path }); // restart
  const r = ingestReceipts(b, receipts, ctx(runSpecs)); // the feed is read again from the start
  assert.equal(r.added, 2, 'only the settle and its credit are new');
  assert.equal(stateHash(b), stateHash(live));
  assert.equal(b.journal.records().length, live.journal.records().length);
});

test('ws04/ws08: records on both sides of a war-period mark are one continuing memory (no reset, no second partition)', () => {
  const { receipts, runSpecs } = vectors('happy');
  const m = newMem();
  promiseAndAllocate(m, { due: 130 });
  // the same receipts mapped so that the settle falls after a period mark at bell 120: nothing in 12 marks periods
  const clk = clockFromGenesis({ genesisTs: 0, bellSecs: 600, blockTimeOfSlot: s => (s < 20 ? (100 + s) * 600 : (110 + s) * 600) });
  ingestReceipts(m, receipts, ctx(runSpecs, { bellOfSlot: clk }));
  m.observe({ kind: 'place_owner', bell: 134, source: { chain: 'index', sig: 'owner-fixture', ix: 0 }, data: { place: DST, owner: CREDITOR, from_bell: 0, to_bell: null } });
  assert.equal(one(m).state, 'fulfilled');
  assert.equal(Object.keys(W.partitions).length, 1);
  assert.deepEqual(m.knowledge(viewer, 300).unusable, []);
});

// ---------------------------------------------------------------- 13: residents (contract double of 13's MemoryPort)
/** 13's localMemory contract (resident/ports/memory.mjs): append-only JSONL, append(id twice) -> false. */
function memoryPortDouble(file) {
  const eps = new Map();
  if (file && existsSync(file)) for (const l of readFileSync(file, 'utf8').split('\n')) if (l.trim()) { const e = JSON.parse(l); if (!eps.has(e.id)) eps.set(e.id, e); }
  return {
    kind: 'local-jsonl (contract double)',
    append(ep) { if (eps.has(ep.id)) return false; const e = { v: 1, created_bell: ep.bell, facts: {}, text: { en: '', ja: '' }, ...ep }; eps.set(e.id, e); if (file) appendFileSync(file, `${JSON.stringify(e)}\n`); return true; },
    recall({ bell }) { return [...eps.values()].filter(e => e.bell <= bell); },
    all() { return [...eps.values()]; },
  };
}
const ep = (id, kind, bell, who = DEBTOR) => ({ id, bell, kind, importance: 6, entities: [who], text: { en: `${kind} by ${who}`, ja: '' } });

test('ws13: the mirror answers exactly what 13\'s port answers', () => {
  const inner = memoryPortDouble(null), plain = memoryPortDouble(null);
  const m = newMem();
  const port = mirrorMemoryPort(inner, m, { owner: CREDITOR });
  const seq = [ep('kept:r1', 'kept', 10), ep('broken:r2', 'broken', 20), ep('kept:r1', 'kept', 10), ep('returned:r3', 'returned', 30)];
  assert.deepEqual(seq.map(e => port.append(e)), seq.map(e => plain.append(e)));
  assert.deepEqual(port.all(), plain.all());
  assert.deepEqual(port.recall({ focus: [], bell: 25 }), plain.recall({ focus: [], bell: 25 }));
  assert.deepEqual(port.stats(), { mirrored: 3, duplicate: 0, errors: 0 }, 'a duplicate 13 refused is not mirrored at all');
});

test('ws13: a resident\'s "broken", late "returned" or "raided" is its private note, never evidence or reputation', () => {
  const m = newMem();
  const port = mirrorMemoryPort(memoryPortDouble(null), m, { owner: CREDITOR });
  port.append(ep('broken:r2', 'broken', 20));
  port.append({ ...ep('returned:r3', 'returned', 30), facts: { late: true } });
  port.append({ ...ep('raided:c1', 'raided', 31), entities: [DEBTOR, `route:${CREDITOR}>${DEBTOR}`] });
  const k = m.knowledge(viewer, 100);
  assert.equal(k.facts.length, 0);
  assert.equal(k.commitments.length, 0);
  assert.equal(k.reliability[DEBTOR], undefined, 'no reputation from a mock board outcome');
  assert.deepEqual(k.notes.map(n => [n.about, n.epistemic, n.visibility.members.join()]), Array(3).fill([DEBTOR, 'interpreted', CREDITOR]));
  // nobody else sees them (another resident, or the public view the 12->13 sidecar uses)
  assert.equal(m.knowledge({ tag: DEBTOR, nation: 1 }, 100).notes.length, 0);
  assert.equal(m.knowledge({ tag: null, nation: null }, 100).notes.length, 0);
});

test('ws13: after a restart of both sides, reconciling adds no second note; a lost mirror write is caught up once', () => {
  const dir = mkdtempSync(join(tmpdir(), 'm12r13-'));
  const epFile = join(dir, 'episodes.jsonl'), jFile = join(dir, 'journal.jsonl');
  let port = mirrorMemoryPort(memoryPortDouble(epFile), newMem({ path: jFile }), { owner: CREDITOR });
  port.append(ep('kept:r1', 'kept', 10));
  port.append(ep('broken:r2', 'broken', 20));
  // a crash after 13 kept an episode but before 12 noted it
  memoryPortDouble(epFile).append(ep('declined:r4', 'declined', 25));
  const m2 = newMem({ path: jFile });
  port = mirrorMemoryPort(memoryPortDouble(epFile), m2, { owner: CREDITOR });
  assert.deepEqual(port.reconcile(), { mirrored: 1, duplicate: 2, errors: 0 });
  assert.deepEqual(port.reconcile(), { mirrored: 1, duplicate: 5, errors: 0 }, 'cumulative: the second pass is all duplicates');
  assert.equal(m2.journal.records().filter(r => r.type === 'note').length, 3);
});

test('ws13: only a single wallet counterparty is named; a failing mirror never changes the resident\'s answer', () => {
  assert.equal(counterpartyOf({ entities: [DEBTOR, `route:${CREDITOR}>${DEBTOR}`] }, CREDITOR), DEBTOR);
  assert.equal(counterpartyOf({ entities: [CREDITOR] }, CREDITOR), null);
  assert.equal(counterpartyOf({ entities: [DEBTOR, 'Cother1111111111111111111111111111111111'] }, CREDITOR), null);
  const broken12 = { note() { throw new Error('disk full'); } };
  const port = mirrorMemoryPort(memoryPortDouble(null), broken12, { owner: CREDITOR });
  assert.equal(port.append(ep('kept:r1', 'kept', 10)), true);
  assert.equal(port.stats().errors, 1);
  assert.throws(() => mirrorMemoryPort(memoryPortDouble(null), newMem(), { owner: 'not-a-wallet' }));
});
