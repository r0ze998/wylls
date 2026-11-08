// Independent world and identity boundary probes. Fixtures only; no keys or chain.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createMemory } from '../src/index.mjs';
import { b58decode, b58encode, connectCanonical, identityFromHeraldMe, readWs04Store, resolverFromIdentity, worldFromSeason, ws12EvidencePort } from '../adapters/canonical.mjs';

const bytes = (fill, head = []) => { const b = Buffer.alloc(32, fill); Buffer.from(head).copy(b); return b; };
const PROGRAM = b58encode(bytes(0x21)), SEASON_PDA = b58encode(bytes(0x42));
const WALLET_A = b58encode(bytes(0x0a)), WALLET_B = b58encode(bytes(0x0b));
const CITIZEN_B = b58encode(bytes(0xab, [0x77, 0, 0, 0, 0, 0, 0, 0]));
const SEASON = { programId: PROGRAM, cluster: 'localnet-fixture', season: '1', seasonAddress: SEASON_PDA, genesisTs: 1_000_000, bellSecs: 600, continuous: true, latestSlot: 40, latestUnix: 1_000_000 + 200 * 600, slot: 40 };
const FINAL = slot => ({ commitment: 'finalized', slot, world_id: `${PROGRAM}/${SEASON_PDA}`, source: 'fixture:getSlot(finalized)' });
const BINDING = { ws04World: 'sim-world-1', programId: PROGRAM, seasonAddress: SEASON_PDA, source: 'fixture:operator declaration' };
const EVENTS = [2, 4, 6, 24].map((slot, i) => ({ seq: i + 1, slot, sig: `s${slot}`, kind: 'x', bell: 100 + slot }));
const citizen = wallet => { const d = Buffer.alloc(384); b58decode(wallet).forEach((x, i) => { d[64 + i] = x; }); d.writeBigUInt64LE(0x77n, 208); return d.toString('base64'); };
const ME = { wallet: WALLET_B, citizen: { address: CITIZEN_B, slot: 30, seq: 9, head: 'h', bytes_b64: citizen(WALLET_B) } };
function store() {
  const path = join(mkdtempSync(join(tmpdir(), 'ws12-13-')), 'store.db');
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE runs(run_id TEXT PRIMARY KEY, spec TEXT NOT NULL);
    CREATE TABLE receipts(id TEXT PRIMARY KEY, run_id TEXT NOT NULL, kind TEXT NOT NULL, subject TEXT NOT NULL, source TEXT NOT NULL, slot INTEGER NOT NULL, body TEXT NOT NULL);
    CREATE TABLE meta(name TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO meta VALUES('world', 'sim-world-1');`);
  let n = 0;
  for (const name of ['happy', 'raid']) {
    const v = JSON.parse(readFileSync(new URL(`../fixtures/ws04-receipts/${name}.json`, import.meta.url), 'utf8'));
    for (const [id, spec] of Object.entries(v.run_specs_json)) db.prepare('INSERT INTO runs VALUES(?, ?)').run(id, spec);
    for (const r of v.receipts) db.prepare('INSERT INTO receipts VALUES(?,?,?,?,?,?,?)').run(`r${n++}`, r.run_id, r.kind, r.subject, r.source, r.slot, r.body_json);
  }
  db.close();
  return readWs04Store(path);
}
const W = worldFromSeason(SEASON);
const promise = m => {
  const place = { partition: W.partition, kind: 2, p: 1, q: 0, at: 5, gen: 1 };
  const req = m.say({ speaker: WALLET_A, bell: 100, visibility: { scope: 'public' }, act: { type: 'request', to: WALLET_B, resource: 'science', qty: 3, by_bell: 130, place } });
  m.say({ speaker: WALLET_B, bell: 101, visibility: { scope: 'public' }, act: { type: 'accept', ref: req.id, qty: 3, by_bell: 130 } });
};
const ids = resolverFromIdentity([identityFromHeraldMe(ME, { partition: W.partition }).entry]);


// Independent negative controls. No keys, signing, network or production modifications.
test('independent: canonical ingestion rejects a different cluster before appending facts', () => {
  const m = createMemory({world:{...W.world,cluster:'another-cluster'},partitions:W.partitions});
  const result=connectCanonical(m,{season:SEASON,events:EVENTS,me:[ME],store:store(),binding:BINDING,finality:FINAL(100)});
  assert.equal(m.journal.records().length,0, JSON.stringify({status:result.status,records:m.journal.records().map(r=>r.kind)}));
});
test('independent: evidence port refuses identity pairing from another partition', () => {
  const m=createMemory({world:W.world,partitions:W.partitions});
  promise(m);
  const foreign=resolverFromIdentity([identityFromHeraldMe(ME,{partition:PROGRAM}).entry]);
  const port=ws12EvidencePort(m,{identity:foreign,worldBellOf:b=>b});
  const result=port.read({counterparty:WALLET_B,worldBell:300});
  assert.equal(result.status,'identity_unverified',JSON.stringify(result));
});
test('independent: correct cluster and identity remain usable', () => {
  const m=createMemory({world:W.world,partitions:W.partitions});
  const result=connectCanonical(m,{season:SEASON,events:EVENTS,me:[ME],store:store(),binding:BINDING,finality:FINAL(100)});
  assert.equal(result.status,'ok');
  assert.ok(m.journal.records().length>0);
  promise(m);
  assert.equal(ws12EvidencePort(m,{identity:ids,worldBellOf:b=>b}).read({counterparty:WALLET_B,worldBell:300}).status,'ok');
});

for (const [label, options] of [
  ['different world id', { world: { ...W.world, world_id: 'another-world' }, partitions: W.partitions }],
  ['unregistered partition', { world: W.world, partitions: {} }],
  ['different registered program', { world: W.world, partitions: { [W.partition]: { ...W.partitions[W.partition], program: PROGRAM + 'x' } } }],
  ['different registered season', { world: W.world, partitions: { [W.partition]: { ...W.partitions[W.partition], season: 2 } } }],
]) test(`independent: canonical refuses ${label} without writes`, () => {
  const m = createMemory(options);
  const result = connectCanonical(m, { season: SEASON, events: EVENTS, me: [ME], store: store(), binding: BINDING, finality: FINAL(100) });
  assert.equal(result.status, 'held');
  assert.equal(result.ingest, null);
  assert.equal(m.journal.records().length, 0);
});
