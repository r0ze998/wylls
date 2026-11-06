// Workstream 12 <- 4 and 8 as they publish (adapters/canonical.mjs): the herald's /h/season, /h/events, /h/me and
// 4's own SQLite store. Synthetic only: herald responses built in the herald's shapes (views.rs, server.rs) around
// byte strings chosen here (no key is generated, derived or signed; a "wallet" is just 32 bytes in base58), and a
// store with 4's table definitions (store.rs) filled from 4's real receipt vectors (fixtures/ws04-receipts).
// With WS04_DB=<path to a runexec demo db> the reader is also run against 4's real store (tools/check-integration.sh).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createMemory } from '../src/index.mjs';
import {
  b58decode, b58encode, clockFromHeraldEvents, connectCanonical, currentBellFromSeason, finalizedSlotFrom,
  identityFromHeraldMe, readWs04Store, resolverFromIdentity, storeWorldMismatch, worldFromSeason, ws12EvidencePort,
} from '../adapters/canonical.mjs';
const dm = (...members) => ({ scope: 'parties', members });

const bytes = (fill, head = []) => { const b = Buffer.alloc(32, fill); Buffer.from(head).copy(b); return b; };
const PROGRAM = b58encode(bytes(0x21));
const SEASON_PDA = b58encode(bytes(0x42));
const WALLET_B = b58encode(bytes(0x0b));
const WALLET_A = b58encode(bytes(0x0a));
const CITIZEN_B = b58encode(bytes(0xab, [0x77, 0, 0, 0, 0, 0, 0, 0])); // tag 0x77 = owner 119 in 4's vectors
const SEASON = { programId: PROGRAM, cluster: 'localnet-fixture', season: '1', seasonAddress: SEASON_PDA, genesisTs: 1_000_000,
  bellSecs: 600, continuous: true, latestSlot: 40, latestUnix: 1_000_000 + 200 * 600, slot: 40 };
const FINAL = slot => ({ commitment: 'finalized', slot, world_id: `${PROGRAM}/${SEASON_PDA}`, source: 'fixture:getSlot(finalized)' });
const BINDING = { ws04World: 'sim-world-1', programId: PROGRAM, seasonAddress: SEASON_PDA, source: 'fixture:operator declaration' };
const EVENTS = [2, 4, 6, 24].map((slot, i) => ({ seq: i + 1, slot, sig: `s${slot}`, kind: 'x', bell: 100 + slot }));

/** A Citizen v2 account (384 bytes): WALLET @ 64, CITIZEN_TAG @ 208 (frontier-abi player.rs). */
function citizenBytes({ wallet, tag }) {
  const d = Buffer.alloc(384);
  b58decode(wallet).forEach((x, i) => { d[64 + i] = x; });
  d.writeBigUInt64LE(BigInt(tag), 208);
  return d.toString('base64');
}
const me = (wallet, { address = CITIZEN_B, tag = 0x77, accountWallet = wallet, len = 384 } = {}) =>
  ({ wallet, citizen: { address, slot: 30, seq: 9, head: 'h', bytes_b64: Buffer.from(citizenBytes({ wallet: accountWallet, tag }), 'base64').subarray(0, len).toString('base64') } });

const SCHEMA = `CREATE TABLE runs(run_id TEXT PRIMARY KEY, spec TEXT NOT NULL);
  CREATE TABLE receipts(id TEXT PRIMARY KEY, run_id TEXT NOT NULL, kind TEXT NOT NULL, subject TEXT NOT NULL, source TEXT NOT NULL, slot INTEGER NOT NULL, body TEXT NOT NULL);
  CREATE TABLE meta(name TEXT PRIMARY KEY, value TEXT NOT NULL);`;
function storeFrom(names, { world = 'sim-world-1' } = {}) {
  const path = join(mkdtempSync(join(tmpdir(), 'ws12-ws04-')), 'store.db');
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  if (world) db.prepare("INSERT INTO meta VALUES('world', ?)").run(world);
  let n = 0;
  for (const name of names) {
    const v = JSON.parse(readFileSync(new URL(`../fixtures/ws04-receipts/${name}.json`, import.meta.url), 'utf8'));
    for (const [id, spec] of Object.entries(v.run_specs_json)) db.prepare('INSERT INTO runs VALUES(?, ?)').run(id, spec);
    for (const r of v.receipts) db.prepare('INSERT INTO receipts VALUES(?,?,?,?,?,?,?)').run(`r${n++}`, r.run_id, r.kind, r.subject, r.source, r.slot, r.body_json);
  }
  db.close();
  return path;
}
const memFor = () => { const w = worldFromSeason(SEASON); return createMemory({ world: w.world, partitions: w.partitions }); };
const kinds = m => m.journal.records().filter(r => r.type === 'fact').map(r => r.kind).sort();

// ---------------------------------------------------------------- 8
test('canonical 8: world and clock parameters come from /h/season; a missing field gives no world', () => {
  const w = worldFromSeason(SEASON);
  assert.deepEqual(w.world, { cluster: 'localnet-fixture', world_id: `${PROGRAM}/${SEASON_PDA}` });
  assert.deepEqual(w.clock, { genesisTs: 1_000_000, bellSecs: 600, source: 'herald:/h/season@slot:40' });
  assert.equal(currentBellFromSeason(SEASON), 200);
  assert.equal(currentBellFromSeason({ ...SEASON, bellSecs: 300 }), 400, 'bellSecs is read, not assumed');
  for (const k of ['cluster', 'programId', 'seasonAddress', 'genesisTs', 'bellSecs', 'continuous', 'season'])
    assert.throws(() => worldFromSeason({ ...SEASON, [k]: undefined }), new RegExp(k));
  assert.equal(worldFromSeason({ ...SEASON, continuous: false }).world, null);
});

test('canonical 8: slot -> bell only where the herald placed the slot; pre-genesis or disagreeing rows are unknown', () => {
  const clk = clockFromHeraldEvents([...EVENTS, { slot: 7, bell: 0xffffffff }, { slot: 9, bell: 1 }, { slot: 9, bell: 2 }, { slot: 'x', bell: 3 }]);
  assert.deepEqual([clk(4), clk(24), clk(5), clk(7), clk(9), clk(100)], [104, 124, null, null, null, null]);
});

test('canonical 8: finality only from an attestation at commitment finalized for this world', () => {
  const w = worldFromSeason(SEASON).world;
  assert.deepEqual(finalizedSlotFrom(FINAL(10), w), { slot: 10, why: null });
  assert.equal(finalizedSlotFrom({ ...FINAL(10), commitment: 'confirmed' }, w).why, 'no_finality_attestation');
  assert.equal(finalizedSlotFrom({ ...FINAL(10), source: '' }, w).why, 'no_finality_attestation');
  assert.equal(finalizedSlotFrom({ slot: SEASON.latestSlot }, w).why, 'no_finality_attestation', "the herald's latestSlot is not finality");
  assert.equal(finalizedSlotFrom({ ...FINAL(10), world_id: 'other' }, w).why, 'finality_for_another_world');
});

test('canonical 8: wallet <-> citizen tag read from the citizen account, cross-checked, never derived', () => {
  const r = identityFromHeraldMe(me(WALLET_B), { partition: SEASON_PDA });
  assert.deepEqual(r.entry, { partition: SEASON_PDA, tag: '0000000000000077', principal: WALLET_B, as_of_slot: 30, source: `herald:/h/me/${WALLET_B}@slot:30` });
  assert.equal(identityFromHeraldMe({ wallet: WALLET_B, citizen: null }, {}).why, 'no_citizen');
  assert.equal(identityFromHeraldMe(me(WALLET_B, { len: 200 }), {}).why, 'citizen_account_too_short');
  assert.equal(identityFromHeraldMe(me(WALLET_B, { accountWallet: WALLET_A }), {}).why, 'citizen_names_another_wallet');
  assert.equal(identityFromHeraldMe(me(WALLET_B, { tag: 0x78 }), {}).why, 'tag_not_the_address_prefix');
  assert.equal(identityFromHeraldMe(me(WALLET_B, { address: '0OIl' }), {}).why, 'bad_citizen_address');
  // a tag the herald pairs with two wallets resolves to neither
  const a = identityFromHeraldMe(me(WALLET_A, { address: CITIZEN_B }), { partition: SEASON_PDA }).entry;
  const ids = resolverFromIdentity([r.entry, a]);
  assert.deepEqual(ids.conflicts, ['0000000000000077']);
  assert.equal(ids.resolve('0000000000000077'), null);
  assert.equal(ids.walletKnown(WALLET_B), null);
  // base58 round trip including leading zero bytes
  for (const b of [bytes(0), bytes(0xff), bytes(1, [0, 0, 5])]) assert.deepEqual(Buffer.from(b58decode(b58encode(b))), b);
});

// ---------------------------------------------------------------- 4
test("canonical 4: the store is read read-only, u64-exact, with its world binding", () => {
  const path = storeFrom(['happy']);
  const s = readWs04Store(path);
  assert.equal(s.world, 'sim-world-1');
  assert.deepEqual(s.receipts.map(r => `${r.kind}@${r.slot}`), ['facility_used@2', 'caravan_sent@4', 'caravan_settled@24']);
  assert.equal(s.receipts[2].body.key.owner, '119', 'u64 kept exact as text');
  assert.ok(s.runSpecs['demo-happy'].ship.dst);
  assert.throws(() => new DatabaseSync(path, { readOnly: true }).exec("INSERT INTO meta VALUES('x','y')"), /readonly/i);
  assert.equal(readWs04Store(storeFrom(['happy'], { world: null })).world, null);
});

test('canonical 4: the store is this herald world only by a sourced declaration', () => {
  assert.equal(storeWorldMismatch('sim-world-1', BINDING, SEASON), null);
  assert.equal(storeWorldMismatch(null, BINDING, SEASON), 'ws04_store_world_unbound');
  assert.equal(storeWorldMismatch('sim-world-1', null, SEASON), 'world_binding_undeclared');
  assert.equal(storeWorldMismatch('sim-world-1', { ...BINDING, source: '' }, SEASON), 'world_binding_undeclared');
  assert.equal(storeWorldMismatch('sim-world-2', BINDING, SEASON), 'ws04_store_bound_to_another_world');
  assert.equal(storeWorldMismatch('sim-world-1', { ...BINDING, seasonAddress: PROGRAM }, SEASON), 'declaration_names_another_herald_world');
});

// ---------------------------------------------------------------- end to end
const full = (over = {}) => ({ season: SEASON, events: EVENTS, me: [me(WALLET_B)], store: readWs04Store(storeFrom(['happy', 'raid'])), binding: BINDING, finality: FINAL(100), ...over });

test('canonical: every gap holds every receipt, with its reason, and adds nothing', () => {
  for (const [over, why] of [[{ binding: null }, 'world_binding_undeclared'], [{ finality: null }, 'no_finality_attestation'],
    [{ store: readWs04Store(storeFrom(['happy'], { world: null })) }, 'ws04_store_world_unbound'],
    [{ season: { ...SEASON, latestUnix: null } }, 'observed_bell_unknown']]) {
    const m = memFor();
    const r = connectCanonical(m, full(over));
    assert.equal(r.status, 'held', why);
    assert.ok(r.reasons.includes(why), why);
    assert.ok(r.held.length >= 3 && r.held.every(h => h.why === why), why);
    assert.equal(m.journal.records().length, 0, why);
  }
  assert.equal(connectCanonical(memFor(), full({ season: { ...SEASON, bellSecs: 0 } })).status, 'world_unverified');
});

test('canonical: receipts become facts once world, finality, clock and identity are published; unknowns stay listed', () => {
  const m = memFor();
  const r = connectCanonical(m, full());
  assert.equal(r.status, 'ok');
  assert.equal(r.identity.known, 1);
  assert.deepEqual(kinds(m), ['caravan_credited', 'caravan_raided', 'caravan_sent', 'caravan_settled', 'identity_alias']);
  assert.ok(r.held.every(h => h.why === 'not_a_memory_input'), 'only facility_used is left aside');
  // the clock: facts carry the herald's bells
  assert.deepEqual([...new Set(m.journal.records().filter(x => x.kind === 'caravan_sent').map(x => x.bell))], [104]);

  // no identity -> no alias (the caravan stays a tag); unknown slot -> held clock_unmapped; partial finality -> held
  const m2 = memFor();
  const r2 = connectCanonical(m2, full({ me: [me(WALLET_B, { tag: 0x78 })], events: EVENTS.filter(e => e.slot !== 24), finality: FINAL(10) }));
  assert.deepEqual(r2.identity.refused, [{ wallet: WALLET_B, why: 'tag_not_the_address_prefix' }]);
  assert.ok(!kinds(m2).includes('identity_alias'));
  const why = Object.fromEntries(r2.held.filter(h => h.why !== 'not_a_memory_input').map(h => [h.receipt.split('|')[1] + '@' + h.receipt.split('|')[0], h.why]));
  assert.deepEqual(why, { 'caravan_settled@demo-happy': 'not_finalized' });
  const m3 = memFor();
  const r3 = connectCanonical(m3, full({ events: EVENTS.filter(e => e.slot !== 24) }));
  assert.deepEqual(r3.held.filter(h => h.why === 'clock_unmapped').map(h => h.receipt.split('|')[1]), ['caravan_settled']);
});

test('canonical: restart and a later pass add only what became known; the store is the pen', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ws12-canon-'));
  const path = join(dir, 'memory.jsonl');
  const w = worldFromSeason(SEASON);
  const open = () => createMemory({ path, world: w.world, partitions: w.partitions });
  const first = connectCanonical(open(), full({ finality: FINAL(10) }));
  assert.ok(first.held.some(h => h.why === 'not_finalized'));
  const m = open(); // restart
  const before = m.journal.records().length;
  const again = connectCanonical(m, full({ finality: FINAL(10) }));
  assert.equal(again.ingest.added, 0);
  assert.equal(m.journal.records().length, before);
  const later = connectCanonical(open(), full());
  assert.ok(later.ingest.added > 0);
  assert.ok(!later.held.some(h => h.why === 'not_finalized'));
  const once = memFor(); connectCanonical(once, full());
  assert.deepEqual(kinds(open()), kinds(once));
});

// ---------------------------------------------------------------- 12 -> 13
test('canonical -> 13: the evidence port answers 13\'s read() only for herald-paired wallets and a declared clock', () => {
  const m = memFor();
  connectCanonical(m, full());
  const w = worldFromSeason(SEASON);
  // a public promise by the paired wallet, so the public viewer has a line about it (no allocation: nothing signed)
  const req = m.say({ speaker: WALLET_A, bell: 100, visibility: { scope: 'public' }, act: { type: 'request', to: WALLET_B, resource: 'science', qty: 3, by_bell: 130, place: { partition: w.partition, kind: 2, p: 1, q: 0, at: 5, gen: 1 } } });
  m.say({ speaker: WALLET_B, bell: 101, visibility: { scope: 'public' }, act: { type: 'accept', ref: req.id, qty: 3, by_bell: 130 } });
  m.say({ speaker: WALLET_B, bell: 101, visibility: dm(WALLET_A, WALLET_B), text: 'private aside' });
  const ids = resolverFromIdentity([identityFromHeraldMe(me(WALLET_B), { partition: w.partition }).entry]);
  const port = ws12EvidencePort(m, { identity: ids, worldBellOf: b => b });
  const r = port.read({ counterparty: WALLET_B, worldBell: 300 });
  assert.equal(r.status, 'ok');
  assert.ok(r.lines.length >= 1);
  for (const l of r.lines) {
    assert.deepEqual(Object.keys(l).sort(), ['about', 'epistemic', 'identitySource', 'sources', 'text']);
    assert.equal(l.identitySource, `herald:/h/me/${WALLET_B}@slot:30`);
    assert.ok(!l.text.includes('private aside'));
  }
  assert.equal(port.read({ counterparty: WALLET_A, worldBell: 300 }).status, 'identity_unverified', 'not paired by the herald');
  assert.equal(port.read({ counterparty: 'not a wallet', worldBell: 300 }).status, 'identity_unverified');
  assert.equal(ws12EvidencePort(m, { identity: ids }).read({ counterparty: WALLET_B, worldBell: 300 }).status, 'clock_unverified', "13's bell is not the world bell until someone says so");
  assert.equal(ws12EvidencePort(createMemory({}), { identity: ids, worldBellOf: b => b }).read({ counterparty: WALLET_B, worldBell: 1 }).status, 'world_unverified');
  const n = m.journal.records().length;
  port.read({ counterparty: WALLET_B, worldBell: 300 });
  assert.equal(m.journal.records().length, n, 'read-only');
});

// ---------------------------------------------------------------- 4's real store (opt-in)
const REAL = process.env.WS04_DB;
test("canonical 4 (real store): runexec's own SQLite reads to the same receipts as the vectors", { skip: !REAL || !existsSync(REAL) ? 'set WS04_DB to a runexec demo db (tools/check-integration.sh --regen-ws04)' : false }, () => {
  const s = readWs04Store(REAL);
  assert.equal(typeof s.world, 'string');
  const name = process.env.WS04_SCENARIO ?? 'happy';
  const v = JSON.parse(readFileSync(new URL(`../fixtures/ws04-receipts/${name}.json`, import.meta.url), 'utf8'));
  const key = r => `${r.run_id}|${r.kind}|${r.subject}|${r.source}|${r.slot}`;
  assert.deepEqual(s.receipts.map(key).sort(), v.receipts.map(key).sort());
  // and the whole connection over it, with the store's own world string declared
  const m = memFor();
  const r = connectCanonical(m, full({ store: s, binding: { ...BINDING, ws04World: s.world } }));
  assert.equal(r.status, 'ok');
  assert.ok(r.ingest.added > 0 && r.ingest.collision === 0 && r.ingest.refused === 0);
});

// ---------------------------------------------------------------- nothing unfounded becomes a verdict (no keys)
test('canonical: a promise is never judged from missing, unfinalized or unallocated records, across a restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ws12-verdict-'));
  const path = join(dir, 'memory.jsonl');
  const w = worldFromSeason(SEASON);
  const open = () => createMemory({ path, world: w.world, partitions: w.partitions });
  const m0 = open();
  const req = m0.say({ speaker: WALLET_A, bell: 100, visibility: { scope: 'public' }, act: { type: 'request', to: WALLET_B, resource: 'science', qty: 3, by_bell: 130, place: { partition: w.partition, kind: 2, p: 1, q: 0, at: 5, gen: 1 } } });
  m0.say({ speaker: WALLET_B, bell: 101, visibility: { scope: 'public' }, act: { type: 'accept', ref: req.id, qty: 3, by_bell: 130 } });
  const VERDICTS = ['fulfilled', 'late', 'partial', 'not_sent'];
  const look = m => { const k = m.knowledge({ tag: WALLET_A, nation: null }, 300); return { c: k.commitments[0], rel: k.reliability }; };
  const stages = [
    ['nothing published', null],
    ['finality missing', { finality: null }],
    ['events missing (clock unknown)', { events: [] }],
    ['identity missing', { me: [] }],
    ['finalized only up to the send', { finality: FINAL(4) }],
    ['everything published, no allocation', {}],
  ];
  const seen = [];
  for (const [label, over] of stages) {
    const m = open(); // a restart before each stage
    if (over) connectCanonical(m, full(over));
    const { c, rel } = look(m);
    assert.ok(!VERDICTS.includes(c.state), `${label}: ${c.state}`);
    assert.equal(c.state, 'unconfirmed', label);
    assert.equal(c.delivered_max, 0, label);
    const rb = rel[WALLET_B];
    assert.deepEqual([rb.r, rb.s, rb.evidence.length], [0, 0, 0], `${label}: reliability moved`);
    assert.equal(rb.unresolved.length, 1, `${label}: the open promise is listed as unknown, beside the score`);
    seen.push(c.reasons.join(','));
  }
  assert.ok(seen.every(r => r.length > 0), 'each stage says why it is unconfirmed');
  // restart after all stages: the journal holds each fact once
  const ids = open().journal.records().map(r => r.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('canonical: one event reported by several runs and read paths is one fact; a later re-read is a duplicate; another body collides', () => {
  const m = memFor();
  const r = connectCanonical(m, full({ store: readWs04Store(storeFrom(['happy', 'crash', 'lost-response'])) }));
  assert.deepEqual([r.ingest.collision, r.ingest.refused], [0, 0]);
  const count = k => m.journal.records().filter(x => x.kind === k).length;
  assert.deepEqual(['caravan_sent', 'caravan_settled', 'caravan_credited', 'identity_alias'].map(count), [1, 1, 1, 1]);
  // observed again, later (the herald's clock moved on): nothing new, nothing colliding
  const n = m.journal.records().length;
  const again = connectCanonical(m, full({ store: readWs04Store(storeFrom(['happy', 'crash'])), season: { ...SEASON, latestUnix: SEASON.latestUnix + 50 * 600 } }));
  assert.deepEqual([again.ingest.added, again.ingest.collision], [0, 0]);
  assert.equal(m.journal.records().length, n);
  // the same kind|subject with another body: a collision, the first kept
  const path = storeFrom(['happy']);
  const db = new DatabaseSync(path);
  const row = db.prepare("SELECT body FROM receipts WHERE kind = 'caravan_settled'").get();
  assert.ok(row.body.includes('"cargo":[0,0,0,0,0,0,3,0]'));
  db.prepare('INSERT INTO receipts VALUES(?,?,?,?,?,?,?)').run('forged', 'demo-happy', 'caravan_settled', 'cv:77:0', 'history:x', 24, row.body.replace('"cargo":[0,0,0,0,0,0,3,0]', '"cargo":[0,0,0,0,0,0,2,0]'));
  db.close();
  const m2 = memFor();
  const r2 = connectCanonical(m2, full({ store: readWs04Store(path) }));
  assert.ok(r2.ingest.collision >= 1);
  assert.equal(m2.journal.records().filter(x => x.kind === 'caravan_settled').length, 1);
});

test('canonical: a send whose run spec is missing is held (dst_unknown), never dropped or guessed', () => {
  const path = storeFrom(['happy']);
  const db = new DatabaseSync(path);
  db.exec('DELETE FROM runs');
  db.close();
  const m = memFor();
  const r = connectCanonical(m, full({ store: readWs04Store(path) }));
  assert.deepEqual(r.held.filter(h => h.why === 'dst_unknown').map(h => h.receipt.split('|')[1]), ['caravan_sent']);
  assert.equal(m.journal.records().filter(x => x.kind === 'caravan_sent').length, 0);
});
