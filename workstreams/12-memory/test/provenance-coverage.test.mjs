// Key-free. The provenance 12 hands to 13 (13 81a03cf5 ws12CanonicalEvidence({provenance}) / basisCheck), and the
// coverage contract (coverageFromHistory) against workstream 19's history words. Synthetic herald responses and 4's
// receipt vectors, labelled as fixtures; nothing here is chain evidence. Imports: 12's src and adapters only (and,
// when present beside this tree, 13's resident/ports/ws12-canonical.mjs and resident/frame.mjs, which import nothing).
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createMemory } from '../src/index.mjs';
import { SEND_ROUTES } from '../src/records.mjs';
import { b58decode, b58encode, connectCanonical, coverageFromHistory, finalizedSlotFrom, provenanceOf, readWs04Store, worldFromSeason } from '../adapters/canonical.mjs';

const bytes = (fill, head = []) => { const b = Buffer.alloc(32, fill); Buffer.from(head).copy(b); return b; };
const PROGRAM = b58encode(bytes(0x21)), SEASON_PDA = b58encode(bytes(0x42)), WALLET_B = b58encode(bytes(0x0b));
const CITIZEN_B = b58encode(bytes(0xab, [0x77, 0, 0, 0, 0, 0, 0, 0]));
const SEASON = { programId: PROGRAM, cluster: 'localnet-fixture', season: '1', seasonAddress: SEASON_PDA, genesisTs: 1_000_000, bellSecs: 600, continuous: true, latestSlot: 40, latestUnix: 1_000_000 + 200 * 600, slot: 40 };
const W = worldFromSeason(SEASON);
const FINAL = slot => ({ commitment: 'finalized', slot, world_id: W.world.world_id, source: 'fixture:getSlot(finalized)' });
const BINDING = { ws04World: 'sim-world-1', programId: PROGRAM, seasonAddress: SEASON_PDA, source: 'fixture:operator declaration' };
const EVENTS = [2, 4, 6, 24].map((slot, i) => ({ seq: i + 1, slot, sig: `s${slot}`, kind: 'x', bell: 100 + slot }));
const citizen = () => { const d = Buffer.alloc(384); b58decode(WALLET_B).forEach((x, i) => { d[64 + i] = x; }); d.writeBigUInt64LE(0x77n, 208); return d.toString('base64'); };
const ME = { wallet: WALLET_B, citizen: { address: CITIZEN_B, slot: 30, bytes_b64: citizen() } };
function store() {
  const path = join(mkdtempSync(join(tmpdir(), 'ws12-pc-')), 'store.db');
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE runs(run_id TEXT PRIMARY KEY, spec TEXT NOT NULL);
    CREATE TABLE receipts(id TEXT PRIMARY KEY, run_id TEXT NOT NULL, kind TEXT NOT NULL, subject TEXT NOT NULL, source TEXT NOT NULL, slot INTEGER NOT NULL, body TEXT NOT NULL);
    CREATE TABLE meta(name TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO meta VALUES('world', 'sim-world-1');`);
  const v = JSON.parse(readFileSync(new URL('../fixtures/ws04-receipts/happy.json', import.meta.url), 'utf8'));
  for (const [id, spec] of Object.entries(v.run_specs_json)) db.prepare('INSERT INTO runs VALUES(?, ?)').run(id, spec);
  v.receipts.forEach((r, i) => db.prepare('INSERT INTO receipts VALUES(?,?,?,?,?,?,?)').run(`r${i}`, r.run_id, r.kind, r.subject, r.source, r.slot, r.body_json));
  db.close();
  return readWs04Store(path);
}
const mem = () => createMemory({ world: W.world, partitions: W.partitions });
const base = over => ({ season: SEASON, events: EVENTS, me: [ME], store: store(), binding: BINDING, finality: FINAL(100), ...over });
const FX = s => ({ kind: 'fixture', source: `ws12 test: ${s}` });
const ALL_FX = { season: FX('season'), events: FX('events'), me: FX('me'), store: FX('ws04 vectors'), finality: FX('finality') };

// ---------------------------------------------------------------- provenance
test('provenance: carries the caller\'s statements in 13\'s five parts; unstated parts are null; nothing is upgraded', () => {
  const r = connectCanonical(mem(), base({ sources: ALL_FX }));
  assert.equal(r.status, 'ok');
  assert.deepEqual(Object.keys(r.provenance), ['world', 'clock', 'finality', 'identity', 'records']);
  assert.deepEqual(Object.values(r.provenance).map(p => p.kind), ['fixture', 'fixture', 'fixture', 'fixture', 'fixture']);
  assert.deepEqual([r.provenance.finality.commitment, r.provenance.finality.slot, r.provenance.finality.world_id], ['finalized', 100, W.world.world_id]);
  assert.ok(!('complete' in r.provenance.records), 'records claim no completeness');
  // no statements: every part null (13 calls that unstated)
  assert.deepEqual(Object.values(connectCanonical(mem(), base()).provenance), [null, null, null, null, null]);
  // a malformed statement is not a statement
  assert.equal(provenanceOf({ season: { kind: 'chain' } }).world, null, 'chain without a source');
  assert.equal(provenanceOf({ season: { kind: 'onchain', source: 'x' } }).world, null, 'not one of 13\'s kinds');
  // the clock is the weaker of /h/season and /h/events
  const p = provenanceOf({ season: { kind: 'chain', source: 'herald' }, events: { kind: 'integration-output', source: 'sim' } });
  assert.equal(p.clock.kind, 'integration-output');
  assert.equal(provenanceOf({ season: { kind: 'chain', source: 'herald' } }).clock, null, 'events unstated -> clock unstated');
});

test('provenance: a cross-check is never finality; an attestation that carries one is refused and nothing is taken in', () => {
  for (const att of [{ ...FINAL(100), cross_checked: true }, { ...FINAL(100), proof: 'cross_checked' }, { ...FINAL(100), state: 'cross_checked' }, { ...FINAL(100), complete: null }, { ...FINAL(100), complete: true }]) {
    assert.equal(finalizedSlotFrom(att, W.world).why, 'cross_check_is_not_finality');
    const m = mem();
    const r = connectCanonical(m, base({ finality: att, sources: ALL_FX }));
    assert.equal(r.status, 'held');
    assert.ok(r.reasons.includes('cross_check_is_not_finality'));
    assert.equal(m.journal.records().length, 0);
  }
});

const WS13 = new URL('../../13-citizens/resident/ports/ws12-canonical.mjs', import.meta.url);
const has13 = existsSync(fileURLToPath(WS13));
test("provenance -> 13's basisCheck: fixture inputs stay fixture; only all-chain inputs with a finalized attestation are chain", { skip: has13 ? false : "workstream 13's ws12-canonical.mjs is not beside this tree" }, async t => {
  const { basisCheck } = await import(WS13);
  if (typeof basisCheck !== 'function') { t.skip('this 13 has no basisCheck (before 81a03cf5)'); return; }
  const fx = connectCanonical(mem(), base({ sources: ALL_FX }));
  assert.equal(basisCheck(fx.provenance, { world: W.world }).basis, 'fixture');
  const mixed = connectCanonical(mem(), base({ sources: { ...ALL_FX, season: { kind: 'chain', source: 'herald' }, events: { kind: 'chain', source: 'herald' }, store: { kind: 'integration-output', source: 'runexec demo' } } }));
  assert.equal(basisCheck(mixed.provenance, { world: W.world }).basis, 'fixture');
  const CH = s => ({ kind: 'chain', source: s });
  const chain = connectCanonical(mem(), base({ sources: { season: CH('herald /h/season'), events: CH('herald /h/events'), me: CH('herald /h/me'), store: CH('ws04 store over chain'), finality: CH('rpc getSlot(finalized)') } }));
  assert.equal(basisCheck(chain.provenance, { world: W.world }).basis, 'chain', basisCheck(chain.provenance, { world: W.world }).why.join('; '));
  assert.equal(basisCheck({ ...chain.provenance, records: null }, { world: W.world }).basis, 'unstated');
  // the same statements with no finality attestation: 12 holds everything and 13 does not call it chain
  const noFin = connectCanonical(mem(), base({ finality: null, sources: { season: CH('h'), events: CH('h'), me: CH('h'), store: CH('s'), finality: CH('f') } }));
  assert.equal(noFin.status, 'held');
  assert.notEqual(basisCheck(noFin.provenance, { world: W.world }).basis, 'chain');
});

// ---------------------------------------------------------------- coverage contract
const bellOfSlot = s => (Number.isSafeInteger(s) && s >= 0 && s <= 40 ? 100 + s : null);
const H = over => ({ basis: 'ledger_feed', state: 'cross_checked', complete: true, heldBack: 0, range: { from_slot: 0, to_slot: 30 }, routes: [...SEND_ROUTES],
  finality: { commitment: 'finalized', slot: 30 }, sender: '0000000000000077', caravans: [{ seq: 0 }], source: 'hypothetical index', ...over });
const ctx = { world: W.world, partition: W.partition, bellOfSlot, observedBell: 200 };

test("coverage: every history workstream 19 publishes today is refused, with its reason; cross_checked alone is not completeness", () => {
  const today = [
    [{ basis: 'ledger_feed', complete: null }, /history_not_complete:null/],
    [{ basis: 'unproven', complete: false }, /basis_unproven_cannot_prove_absence/],
    [{ basis: 'as_given', complete: null }, /basis_as_given/],
    [{ state: 'not_fetched' }, /state_not_fetched_is_not_absence/],
    [{ state: 'gap' }, /state_gap_is_not_absence/],
    [{ state: 'unverifiable' }, /state_unverifiable/],
    [{ heldBack: 3 }, /held_back_3/],
    [{ complete: undefined }, /history_not_complete:unstated/],
    [{ routes: ['send_caravan/top_level'] }, /routes_missing:send_caravan\/cpi,settle_raid\/take/],
    [{ finality: { commitment: 'confirmed', slot: 30 } }, /range_not_finalized/],
    [{ finality: { commitment: 'finalized', slot: 29 } }, /range_not_finalized/],
    [{ range: { from_slot: 0, to_slot: 99 }, finality: { commitment: 'finalized', slot: 99 } }, /range_clock_unmapped/],
    [{ source: '' }, /no_source/],
  ];
  for (const [over, re] of today) {
    const r = coverageFromHistory(H(over), ctx);
    assert.equal(r.coverage, null, JSON.stringify(over));
    assert.ok(r.why.some(w => re.test(w)), `${JSON.stringify(over)} -> ${r.why}`);
  }
  // 19's exact shape today: ledger_feed, cross_checked, complete null -> refused
  assert.equal(coverageFromHistory({ basis: 'ledger_feed', state: 'cross_checked', complete: null, heldBack: 0, range: { from_slot: 0, to_slot: 30 } }, ctx).coverage, null);
});

test('coverage: only an index that states every condition gives a record, which the memory accepts once (restart: duplicate)', () => {
  const r = coverageFromHistory(H({}), ctx);
  assert.deepEqual(r.why, []);
  const dir = mkdtempSync(join(tmpdir(), 'ws12-cov-'));
  const path = join(dir, 'm.jsonl');
  const m = createMemory({ path, world: W.world, partitions: W.partitions });
  assert.equal(m.observe(r.coverage).status, 'added');
  assert.equal(createMemory({ path, world: W.world, partitions: W.partitions }).observe(r.coverage).status, 'duplicate');
  assert.deepEqual(r.coverage.data.routes, [...SEND_ROUTES]);
  assert.equal(r.coverage.data.finality, 'finalized');
});

// ---------------------------------------------------------------- 4's store: one snapshot
test("4's store: receipts and run specs are read from one snapshot, even while a writer commits between them", () => {
  const path = join(mkdtempSync(join(tmpdir(), 'ws12-snap-')), 'store.db');
  const w = new DatabaseSync(path);
  w.exec(`PRAGMA journal_mode=WAL; CREATE TABLE runs(run_id TEXT PRIMARY KEY, spec TEXT NOT NULL);
    CREATE TABLE receipts(id TEXT PRIMARY KEY, run_id TEXT NOT NULL, kind TEXT NOT NULL, subject TEXT NOT NULL, source TEXT NOT NULL, slot INTEGER NOT NULL, body TEXT NOT NULL);
    CREATE TABLE meta(name TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO meta VALUES('world', 'sim-world-1');`);
  const v = JSON.parse(readFileSync(new URL('../fixtures/ws04-receipts/happy.json', import.meta.url), 'utf8'));
  for (const [id, spec] of Object.entries(v.run_specs_json)) w.prepare('INSERT INTO runs VALUES(?, ?)').run(id, spec);
  v.receipts.forEach((r, i) => w.prepare('INSERT INTO receipts VALUES(?,?,?,?,?,?,?)').run(`r${i}`, r.run_id, r.kind, r.subject, r.source, r.slot, r.body_json));
  // a writer that commits a new run and its receipt whenever the reader prepares its second statement
  const { DatabaseSync: D } = { DatabaseSync };
  const orig = D.prototype.prepare;
  let n = 0;
  D.prototype.prepare = function (sql) {
    if (this !== w && /FROM runs/.test(sql) && n++ === 0) {
      w.prepare('INSERT INTO receipts VALUES(?,?,?,?,?,?,?)').run('late', 'late-run', 'caravan_sent', 'cv:88:0', 'sig:late', 30, '{"cargo":[0,0,0,0,0,0,1,0],"seq":0}');
      w.prepare('INSERT INTO runs VALUES(?, ?)').run('late-run', v.run_specs_json['demo-happy']);
    }
    return orig.call(this, sql);
  };
  try {
    const s = readWs04Store(path);
    assert.equal(n, 1, 'the writer committed during the read');
    assert.ok(!s.receipts.some(r => r.run_id === 'late-run'), 'receipt of the later moment not read');
    assert.ok(!('late-run' in s.runSpecs), 'spec of the later moment not read either: one snapshot');
  } finally { D.prototype.prepare = orig; w.close(); }
  // and the next read sees both, together
  const s2 = readWs04Store(path);
  assert.ok(s2.receipts.some(r => r.run_id === 'late-run') && 'late-run' in s2.runSpecs);
});

test('block-time clock: the bell length is the herald\'s bellSecs, never assumed', async () => {
  const { clockFromGenesis } = await import('../adapters/ws08-world.mjs');
  const c600 = clockFromGenesis({ genesisTs: 600, bellSecs: 600, blockTimeOfSlot: s => 600 + s * 10 });
  const c300 = clockFromGenesis({ genesisTs: 600, bellSecs: 300, blockTimeOfSlot: s => 600 + s * 10 });
  assert.deepEqual([c600(59), c600(60), c300(29), c300(30)], [0, 1, 0, 1]);
  assert.throws(() => clockFromGenesis({ genesisTs: 0, blockTimeOfSlot: () => 0 }), /bellSecs/);
  assert.equal(c600(-100), null, 'before genesis: unknown');
});
