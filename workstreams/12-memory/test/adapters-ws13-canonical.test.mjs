// Workstream 12 against workstream 13's own world/clock/evidence modules (13 de6df669: resident/frame.mjs,
// resident/ports/ws12-canonical.mjs, resident/ports/ws12-public-evidence.mjs), keyless. These modules import nothing
// of the gateway, so they run without 13's npm dependencies. Skipped when 13's code is not beside this tree
// (tools/check-integration.sh overlays 12 on 13). Synthetic herald responses as in adapters-canonical.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { createMemory } from '../src/index.mjs';
import { b58decode, b58encode, connectCanonical, identityFromHeraldMe, readWs04Store, resolverFromIdentity, worldFromSeason, ws12EvidencePort } from '../adapters/canonical.mjs';

const WS13 = new URL('../../13-citizens/resident/', import.meta.url);
const have = ['frame.mjs', 'ports/ws12-canonical.mjs', 'ports/ws12-public-evidence.mjs'].every(f => existsSync(fileURLToPath(new URL(f, WS13))));
const skip = have ? false : "workstream 13's frame.mjs / ws12-canonical.mjs are not beside this tree: run tools/check-integration.sh";
const ws13 = async () => ({
  ...(await import(new URL('frame.mjs', WS13))),
  ...(await import(new URL('ports/ws12-canonical.mjs', WS13))),
  ...(await import(new URL('ports/ws12-public-evidence.mjs', WS13))),
});

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

test("13 frame: 12's world is a workstream 8 world; 13's test world is not, and the two are never mixed", { skip }, async () => {
  const f = await ws13();
  assert.equal(f.worldMismatch(f.MOCK_WORLD, W.world), 'not_a_ws08_world');
  assert.equal(f.worldMismatch(W.world, { ...W.world }), null);
  assert.equal(f.worldMismatch(W.world, { cluster: W.world.cluster, world_id: `${PROGRAM}/${PROGRAM}` }), 'another_world');
});

test("13 clock: 12's clock (from /h/season) is 13's season-bell only with the same genesisTs and bellSecs; otherwise clock_unverified", { skip }, async () => {
  const f = await ws13();
  const m = createMemory({ world: W.world, partitions: W.partitions });
  connectCanonical(m, { season: SEASON, events: EVENTS, me: [ME], store: store(), binding: BINDING, finality: FINAL(100) });
  promise(m);
  const at = (residentClock) => f.ws12CanonicalEvidence({ ws12EvidencePort, memory: m, identity: ids, worldClock: W.clock, residentClock });
  assert.equal(at(f.MOCK_CLOCK).sameTime, false);
  assert.equal(at(f.MOCK_CLOCK).read({ counterparty: WALLET_B, worldBell: 300 }).status, 'clock_unverified');
  assert.equal(at(f.seasonClock({ ...W.clock, bellSecs: 300 })).read({ counterparty: WALLET_B, worldBell: 300 }).status, 'clock_unverified');
  assert.equal(at(f.seasonClock({ ...W.clock, genesisTs: W.clock.genesisTs + 1 })).sameTime, false);
  const same = at(f.seasonClock(W.clock));
  assert.equal(same.sameTime, true);
  assert.deepEqual(same.world, W.world);
  const r = same.read({ counterparty: WALLET_B, worldBell: 300 });
  assert.equal(r.status, 'ok');
  assert.ok(r.lines.length >= 1);
  assert.equal(same.read({ counterparty: WALLET_A, worldBell: 300 }).status, 'identity_unverified', 'no herald citizen pairing for A');
});

test('13 finality: without an attestation, or with receipts but no allocation, no line 13 shows is verified, and nothing reads as not sent', { skip }, async () => {
  const f = await ws13();
  for (const finality of [null, FINAL(4), FINAL(100)]) {
    const m = createMemory({ world: W.world, partitions: W.partitions });
    connectCanonical(m, { season: SEASON, events: EVENTS, me: [ME], store: store(), binding: BINDING, finality });
    promise(m);
    const port = f.ws12CanonicalEvidence({ ws12EvidencePort, memory: m, identity: ids, worldClock: W.clock, residentClock: f.seasonClock(W.clock) });
    const r = port.read({ counterparty: WALLET_B, worldBell: 300 });
    assert.equal(r.status, 'ok');
    assert.ok(r.lines.every(l => l.epistemic !== 'verified'), `finality ${finality?.slot ?? 'none'}: ${r.lines.map(l => l.epistemic)}`);
    assert.ok(r.lines.every(l => !/not sent|did not send/i.test(l.text)), r.lines.map(l => l.text).join(' | '));
  }
});

test("13 identity: 64-character principals pass 12 and 13's sidecar; 65 do not", { skip }, async () => {
  const f = await ws13();
  const id64 = 'a'.repeat(64), id65 = 'a'.repeat(65);
  const m = createMemory({ world: W.world, partitions: W.partitions });
  m.say({ speaker: id64, bell: 10, visibility: { scope: 'public' }, act: { type: 'request', to: WALLET_B, resource: 'science', qty: 1, by_bell: 20, place: { partition: W.partition, kind: 2, p: 1, q: 0, at: 5, gen: 1 } } });
  assert.throws(() => m.say({ speaker: id65, bell: 10, visibility: { scope: 'public' }, text: 'x' }));
  const side = f.ws12PublicEvidence(m, { resolvePrincipal: c => ({ principal: c, source: 'fixture' }) });
  assert.equal(side.read({ counterparty: id64, worldBell: 30 }).status, 'ok');
  assert.equal(side.read({ counterparty: id65, worldBell: 30 }).status, 'identity_unverified');
  // a herald-paired base58 wallet (32-44 characters) is within both limits
  assert.ok(WALLET_B.length >= 32 && WALLET_B.length <= 44);
});

test('13 delayed results and restart: a finality that arrives late is taken in once; reopening the journal answers the same', { skip }, async () => {
  const f = await ws13();
  const path = join(mkdtempSync(join(tmpdir(), 'ws12-13r-')), 'm.jsonl');
  const open = () => createMemory({ path, world: W.world, partitions: W.partitions });
  const read = m => f.ws12CanonicalEvidence({ ws12EvidencePort, memory: m, identity: ids, worldClock: W.clock, residentClock: f.seasonClock(W.clock) }).read({ counterparty: WALLET_B, worldBell: 300 });
  const s = store();
  const m1 = open();
  promise(m1);
  connectCanonical(m1, { season: SEASON, events: EVENTS, me: [ME], store: s, binding: BINDING, finality: FINAL(4) });
  const early = read(m1);
  const m2 = open(); // restart
  connectCanonical(m2, { season: SEASON, events: EVENTS, me: [ME], store: s, binding: BINDING, finality: FINAL(100) }); // the late result
  connectCanonical(m2, { season: SEASON, events: EVENTS, me: [ME], store: s, binding: BINDING, finality: FINAL(100) }); // read again
  const late = read(open());
  assert.deepEqual(read(m2), late, 'the reopened journal answers as the live one');
  const recs = open().journal.records();
  assert.equal(new Set(recs.map(r => r.id)).size, recs.length, 'no record kept twice');
  assert.equal(recs.filter(r => r.kind === 'caravan_settled').length, 1);
  assert.equal(recs.filter(r => r.kind === 'caravan_sent').length, 1, 'the send, taken in early, is not taken in again');
  assert.equal(early.status, 'ok');
  assert.ok(late.lines.every(l => l.epistemic !== 'verified'));
});
