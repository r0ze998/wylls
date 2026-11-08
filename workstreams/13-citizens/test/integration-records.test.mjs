// Records the integrated build actually produced, read the way workstream 12 reads them, up to the resident:
//   workstream 4's runexec (RUNEXEC_BIN, built from the integration candidate) runs its own demo scenarios over its
//   simulated chain and writes its run store (SQLite: receipts, run specs, the store's world). Nothing here writes
//   those records: they are runexec's output. Workstream 12 (WS12_ROOT) reads the store read-only (readWs04Store) and
//   takes it in (connectCanonical); the resident reads 12 through resident/ports/ws12-canonical.mjs.
// What is NOT the integrated build's output, and is labelled so: the herald answers (/h/season, /h/events, /h/me),
// the store-to-world declaration, the finality attestation, and the promise words. They are fixtures.
// The point: with such records, 12 keeps receipts without a finality attestation (a cross-check is not one), takes
// each in once across a restart, and decides no breach without an allocation or a complete index; the resident acts
// on nothing.
// The simulated chain's "signatures" are sha256 labels (runexec src/sim.rs `prepare`), not key signatures; runexec has
// no key or PDA code (src/*.rs). Needs RUNEXEC_BIN and WS12_ROOT; skipped otherwise.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ws12CanonicalEvidence } from '../resident/ports/ws12-canonical.mjs';
import { seasonClock } from '../resident/frame.mjs';
import { ws12 } from './roots.mjs';

const BIN = process.env.RUNEXEC_BIN, ROOT = ws12('canonical').root;
const skip = BIN && ROOT ? false : `${BIN ? '' : 'set RUNEXEC_BIN (workstream 4 runexec: no tree carries the binary)'}${BIN || ROOT ? '' : ' and '}${ROOT ? '' : 'workstream 12 (WS12_ROOT, or in this tree)'}`;
const m12 = rel => import(pathToFileURL(path.join(ROOT, 'workstreams/12-memory', rel)).href);
const SCENARIOS = ['happy', 'crash', 'raid', 'lost-response'];
const FIXTURE = src => ({ kind: 'fixture', source: `ws13 test: ${src}` });

/** runexec's own demo: a fresh store written by the integrated build. */
function runexecDemo(scenario) {
  const db = path.join(mkdtempSync(path.join(os.tmpdir(), 'ws13-runexec-')), `${scenario}.db`);
  execFileSync(BIN, ['demo', '--scenario', scenario, '--db', db], { stdio: 'ignore' });
  return db;
}

/** The synthetic herald and declarations around a store (fixtures), built like workstream 12's own tests do. */
async function around(store) {
  const c = await m12('adapters/canonical.mjs');
  const bytes = (fill, head = []) => { const b = Buffer.alloc(32, fill); Buffer.from(head).copy(b); return b; };
  const PROGRAM = c.b58encode(bytes(0x21)), SEASON_PDA = c.b58encode(bytes(0x42));
  const WALLET = c.b58encode(bytes(0x0b));
  const owner = 0x77; // the demo's owner tag (runexec main.rs demo: RunSpec.owner)
  const citizen = (() => { const d = Buffer.alloc(384); c.b58decode(WALLET).forEach((x, i) => { d[64 + i] = x; }); d.writeBigUInt64LE(BigInt(owner), 208); return d.toString('base64'); })();
  const season = { programId: PROGRAM, cluster: 'localnet-fixture', season: '1', seasonAddress: SEASON_PDA, genesisTs: 1_000_000, bellSecs: 600, continuous: true, latestSlot: 400, latestUnix: 1_000_000 + 600 * 600, slot: 400 };
  const slots = [...new Set(store.receipts.map(r => r.slot))];
  const events = slots.map((slot, i) => ({ seq: i + 1, slot, sig: `s${slot}`, kind: 'x', bell: 100 + slot }));
  const me = [{ wallet: WALLET, citizen: { address: c.b58encode(bytes(0xab, [owner, 0, 0, 0, 0, 0, 0, 0])), slot: 30, seq: 9, head: 'h', bytes_b64: citizen } }];
  const binding = { ws04World: store.world, programId: PROGRAM, seasonAddress: SEASON_PDA, source: 'fixture: operator declaration' };
  const W = c.worldFromSeason(season);
  return { c, season, events, me, binding, W, WALLET, finalized: slot => ({ commitment: 'finalized', slot, world_id: W.world.world_id, source: 'fixture: getSlot(finalized)' }) };
}

for (const scenario of SCENARIOS) {
  test(`runexec ${scenario}: without a finality attestation, or with a cross-check offered as one, every receipt is held`, { skip }, async () => {
    const db = runexecDemo(scenario);
    const { createMemory } = await m12('src/index.mjs');
    const c = await m12('adapters/canonical.mjs');
    const store = c.readWs04Store(db);
    assert.ok(store.receipts.length > 0, 'runexec wrote receipts');
    const a = await around(store);
    for (const finality of [null, { cross_checked: true, slot: 400, world_id: a.W.world.world_id, source: 'ws19 cross_checked (two readings agree)' }]) {
      const m = createMemory({ world: a.W.world, partitions: a.W.partitions });
      const r = c.connectCanonical(m, { season: a.season, events: a.events, me: a.me, store, binding: a.binding, finality });
      assert.equal(r.status, 'held', `${finality ? 'cross_checked' : 'none'}: ${r.reasons}`);
      // 12 up to c6877a1a: no_finality_attestation for both; from fa4baf14 a cross-check gets its own reason
      assert.ok(finality ? r.reasons.some(x => ['no_finality_attestation', 'cross_check_is_not_finality'].includes(x)) : r.reasons.includes('no_finality_attestation'), `${r.reasons}`);
      assert.equal(r.held.length, store.receipts.length, 'all held');
      assert.equal(m.journal.records().filter(x => x.kind?.startsWith?.('caravan_')).length, 0, 'nothing taken in');
    }
  });
}

test('runexec stores taken in under a finality attestation: each receipt once, also after a restart and a second pass', { skip }, async t => {
  const { createMemory } = await m12('src/index.mjs');
  const c = await m12('adapters/canonical.mjs');
  for (const scenario of SCENARIOS) {
    const store = c.readWs04Store(runexecDemo(scenario));
    const a = await around(store);
    const journal = path.join(mkdtempSync(path.join(os.tmpdir(), 'ws13-m12-')), 'm.jsonl');
    const open = () => createMemory({ path: journal, world: a.W.world, partitions: a.W.partitions });
    const args = { season: a.season, events: a.events, me: a.me, store, binding: a.binding, finality: a.finalized(400) };
    const first = c.connectCanonical(open(), args);
    c.connectCanonical(open(), args); // a restart, then the same store read again
    const recs = open().journal.records();
    assert.equal(new Set(recs.map(r => r.id)).size, recs.length, `${scenario}: no record twice`);
    const sent = recs.filter(r => r.kind === 'caravan_sent').length;
    const sentReceipts = store.receipts.filter(r => r.kind === 'caravan_sent').length;
    assert.ok(sent >= 1 && sent <= sentReceipts, `${scenario}: taken in, and no more sends than runexec recorded (${sent} of ${sentReceipts})`);
    assert.equal(first.status, 'ok', `${scenario}: ${first.reasons}`);
    t.diagnostic(`${scenario}: ${store.receipts.length} receipts, ${sent} send facts, held ${first.held.length}${first.held.length ? ` (${[...new Set(first.held.map(h => h.why))]})` : ''}`);
    assert.equal(open().journal.rejected().length, 0);
  }
});

test('the resident reads 12 over runexec\'s records: no allocation and no complete index, so no breach is decided and nothing is acted on', { skip }, async t => {
  const { createMemory } = await m12('src/index.mjs');
  const c = await m12('adapters/canonical.mjs');
  const store = c.readWs04Store(runexecDemo('happy'));
  const a = await around(store);
  const m = createMemory({ world: a.W.world, partitions: a.W.partitions });
  const r = c.connectCanonical(m, { season: a.season, events: a.events, me: a.me, store, binding: a.binding, finality: a.finalized(400) });
  assert.equal(r.status, 'ok');
  // Promise words (fixture): someone asks the demo's owner for 3 units to the demo's destination, the owner accepts;
  // one promise the caravan matches in place, one at a place no caravan went to. Both are due long before bell 400.
  const place = (p, q) => ({ partition: a.W.partition, kind: 2, p, q, at: 5, gen: 1 });
  const asker = c.b58encode(Buffer.alloc(32, 0x0a));
  for (const [i, pl] of [[0, place(1, 0)], [1, place(9, 9)]]) {
    const req = m.say({ speaker: asker, bell: 100 + i, visibility: { scope: 'public' }, act: { type: 'request', to: a.WALLET, resource: 'science', qty: 3, by_bell: 130, place: pl } });
    m.say({ speaker: a.WALLET, bell: 101 + i, visibility: { scope: 'public' }, act: { type: 'accept', ref: req.id, qty: 3, by_bell: 130 } });
  }
  const provenance = { world: FIXTURE('synthetic /h/season'), clock: FIXTURE('synthetic /h/season'), finality: FIXTURE('synthetic finalized attestation'),
    identity: FIXTURE('synthetic /h/me'), records: { kind: 'integration-output', source: 'runexec demo happy (workstream 4, simulated chain)' } };
  const ids = c.resolverFromIdentity(a.me.map(x => c.identityFromHeraldMe(x, { partition: a.W.partition }).entry));
  const port = ws12CanonicalEvidence({ ws12EvidencePort: c.ws12EvidencePort, memory: m, identity: ids, worldClock: a.W.clock, residentClock: seasonClock(a.W.clock), provenance });
  const read = port.read({ counterparty: a.WALLET, worldBell: 300 });
  assert.equal(read.status, 'ok');
  assert.equal(read.facts.length, 2);
  assert.ok(read.facts.every(f => !f.verified && !f.breach), `undecided: ${read.facts.map(f => f.state)}`);
  t.diagnostic(`12 on runexec happy: ${read.facts.map(f => f.state).join(', ')}; lines: ${read.lines.map(l => l.epistemic).join(', ')}`);
  assert.ok(read.lines.every(l => !/not sent/i.test(l.text)), 'never read as "not sent"');
  assert.equal(port.basis, 'fixture');
  assert.ok(port.basisWhy.includes('records: integration-output'));
});
