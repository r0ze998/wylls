// The read-only family readers (conquest-table-read.mjs) and the relay's reservation read
// (local-play-conquest-orders.mjs) against PUBLIC ACCOUNT BYTES WRITTEN BY THE REAL SBF PROGRAM:
// docs/integration/CLAUDE-CONQUEST-RESERVATION-REAL-EVIDENCE-20261112.json (the ABI owner's file, read only; public
// accounts only, no secret key). Two lock snapshots of one memory-only test chain: the reservation PENDING (slot 658)
// and after it APPLIED (slot 835), each with the table, the wide Province and the Citizen.
//
// What this establishes: the readers accept accounts the real program wrote, at the canonical addresses this code
// derives, and the read says exactly "ordered" while the record is pending and NOTHING once it is gone.
// What it does NOT establish: natural play (the initial state is a synthetic strong fixture), a NOT_APPLIED record or
// a refund on SBF, or anything about opening the routes. Nothing is opened by this file. No chain, no network, no key;
// runs under the no-key guard.
//
// HISTORICAL: these bytes were written by the EARLIER artefact (87b19e9e…): a 2,688-byte table whose header says
// layout version 1. The current artefact (e6bfe8c2…) writes version 2 and the route reads version 2 only, so this
// file is kept as history and read with the explicit historical option, which no route can pass. The bytes are not
// rewritten. The current version on real bytes: frontier-conquest-v2-evidence.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as T from '../src/frontier/conquest-table-read.mjs';
import { createConquestOrdersRead, CONQUEST_ORDERS_REQUEST_SCHEMA } from '../src/frontier/local-play-conquest-orders.mjs';
import { CONQUEST_OPEN_CONDITIONS, CONQUEST_MARKERS, CONQUEST_WORLD_PRESET, createLocalPlayConquest } from '../src/frontier/local-play-conquest.mjs';
import { decodePrefix } from '../../permutation-server/web/frontier/fcodec.mjs';
import { RESERVATION_LAYOUT_CHECKED } from '../src/frontier/conquest-reservations.mjs';
import { LOCAL_PLAY_PROGRAM, LOCAL_PLAY_RULESET_HASH, LOCAL_PLAY_SEASON_ID } from '../src/frontier/local-play-relay.mjs';
import { seasonPda } from '../../permutation-server/web/frontier/faddr.mjs';
import { worldIdOf } from '../../permutation-server/web/frontier/map/wide.mjs';
import { canonicalOriginalHostRef, canonicalWideProvinceKey } from '../../permutation-server/web/frontier/fexpedition-seal.mjs';
import { canonicalDeclareSiegeRoles } from '../../permutation-server/web/frontier/fconquest-identity.mjs';
import { siegeOrderModel } from '../../permutation-server/web/frontier/fconquest-order.mjs';
import { decode } from '../../permutation-server/web/sdk/base58.mjs';

const E = JSON.parse(readFileSync(new URL('../../docs/integration/CLAUDE-CONQUEST-RESERVATION-REAL-EVIDENCE-20261112.json', import.meta.url), 'utf8'));
const bytes = a => new Uint8Array(Buffer.from(a.data_base64, 'base64'));
const [PENDING, APPLIED] = E.snapshots;
const STANDING = { p: String(E.province.p), q: String(E.province.q) };
const KEY = canonicalWideProvinceKey({ world: E.world_hex, ...STANDING });
const source = () => ({ schema: 'frontier-original-expedition-request-v1', operation: 'inspect', cluster: 'localnet', program: E.program, season: E.season,
  deployment: { program_version: '18436', ruleset_hash: LOCAL_PLAY_RULESET_HASH },
  host: canonicalOriginalHostRef({ world: E.world_hex, p: '128', q: '0', site: 1, gen: 2, seq: 0 }),
  original_owner: E.citizen, standing: STANDING, min_slot: '0', wallet: E.player_wallet_public_key, payer: E.player_wallet_public_key });

test('the evidence is the one expected: this program and Season, two snapshots of public, non-executable, program-owned accounts', () => {
  assert.equal(E.schema, 'claude-conquest-reservation-real-evidence-v1');
  assert.equal(E.program, LOCAL_PLAY_PROGRAM); assert.equal(E.season, seasonPda(LOCAL_PLAY_PROGRAM, LOCAL_PLAY_SEASON_ID)[0]); assert.equal(E.season_id, LOCAL_PLAY_SEASON_ID);
  assert.equal(E.world_hex, worldIdOf(E.season, E.program), 'the world this page derives from the Season and program is the chain\'s');
  assert.deepEqual([PENDING.stage, APPLIED.stage], ['reservation_pending', 'reservation_applied']);
  for (const s of E.snapshots) for (const k of ['conquest_table', 'province', 'citizen']) {
    const a = s[k];
    assert.equal(a.owner, E.program, `${s.stage} ${k}`); assert.equal(a.executable, false); assert.equal(bytes(a).length, a.bytes);
  }
  assert.ok(!/secret|private_key|keypair/i.test(JSON.stringify(Object.keys(E)) + JSON.stringify(Object.keys(PENDING))), 'public accounts only');
});

test('the addresses this code derives from the wallet and the province are the ones the program wrote to', () => {
  const roles = canonicalDeclareSiegeRoles(source(), 0), at = n => roles.find(r => r.name === n).address;
  for (const s of E.snapshots) {
    assert.equal(at('citizen'), s.citizen.address, 'the Citizen of this wallet');
    assert.equal(at('target_province'), s.province.address, 'the wide Province of (129, 0)');
    assert.equal(at('conquest'), s.conquest_table.address, 'the conquest table of that province');
  }
  assert.equal(at('citizen'), E.citizen);
});

test('the three family readers accept the real program\'s accounts, in both snapshots', () => {
  for (const s of E.snapshots) {
    const province = bytes(s.province), table = bytes(s.conquest_table), citizen = bytes(s.citizen);
    assert.equal(province.length, T.WIDE_PROVINCE_SIZE); assert.equal(citizen.length, T.CITIZEN_SIZE);
    assert.deepEqual(T.wideProvinceIdentity(province, { seasonId: E.season_id, key: KEY }), { world: E.world_hex, ...STANDING }, s.stage);
    const c = T.citizenIdentity(citizen, { seasonId: E.season_id, wallet: decode(E.player_wallet_public_key), address: decode(E.citizen) });
    const { records } = T.conquestTable(table, province, { seasonId: E.season_id, key: KEY, historicalV1: true });
    // (as the ROUTE reads — version 2 only — these saved version-1 bytes are refused)
    assert.throws(() => T.conquestTable(table, province, { seasonId: E.season_id, key: KEY }), e => e.code === 'ConquestTableVersion');
    if (s === PENDING) {
      // one PENDING record of this Citizen for the reservation's bell, and the Citizen bears its slot out
      assert.equal(records.length, 1);
      const r = records[0];
      assert.deepEqual([r.status, r.bell, r.citizen, r.resourcesReturned, r.slotRentReleased], ['pending', s.reservation_bell, E.citizen, false, false]);
      const mark = (1 << (r.slot + 2)) | (1 << r.slot);
      assert.equal(c.slots & mark, mark, 'the Citizen carries the wide reservation mark of that slot');
    } else {
      // applied: the record is gone (it is a site entry now); the readers still accept the table and its pairing
      assert.deepEqual(records, []);
      const entries = Array.from({ length: 12 }, (_, i) => table.subarray(128 + i * 128, 256 + i * 128)).filter(e => e.some(x => x !== 0));
      assert.equal(entries.length, 1, 'one site entry: the siege the reservation became');
      assert.equal(entries[0][0], 1, 'kind SIEGE'); assert.equal(new DataView(entries[0].buffer, entries[0].byteOffset).getUint32(114, true), s.reservation_bell, 'declared at the reservation\'s bell');
    }
  }
  // a snapshot's accounts are not interchangeable: the pending table with the applied Province (or the reverse) is refused
  assert.throws(() => T.conquestTable(bytes(PENDING.conquest_table), bytes(APPLIED.province), { seasonId: E.season_id, key: KEY, historicalV1: true }), e => e.code === 'ConquestPairing');
  assert.throws(() => T.conquestTable(bytes(APPLIED.conquest_table), bytes(PENDING.province), { seasonId: E.season_id, key: KEY, historicalV1: true }), e => e.code === 'ConquestPairing');
});

test('the relay\'s read over those accounts: "ordered" while pending; NOTHING once the record is gone (no started, no returned)', async () => {
  const cfg = { localPlay: true, rpc: 'http://127.0.0.1:41964', program: E.program, season: E.season, wallet: E.player_wallet_public_key, rulesetHash: LOCAL_PLAY_RULESET_HASH,
    prepareBin: '/nonexistent/frontier-experimental-expedition-depart-prepare', cuLimit: '400000', loadedLimit: '1048576' };
  const serve = s => { const calls = []; const acct = a => ({ owner: a.owner, executable: a.executable, lamports: a.lamports, data: [a.data_base64, 'base64'] });
    return { calls, read: createConquestOrdersRead({ cfg, city: null, historicalTableV1: true, rpc: async (method, params) => { calls.push({ method, params });
      return { result: { context: { slot: s.slot }, value: [acct(s.conquest_table), acct(s.province), acct(s.citizen)] } }; } }) }; };
  const body = { schema: CONQUEST_ORDERS_REQUEST_SCHEMA, source_request: source() };
  let h = serve(PENDING), got = await h.read.read(body);
  assert.deepEqual(h.calls[0].params[0], [PENDING.conquest_table.address, PENDING.province.address, PENDING.citizen.address], 'asked at the program\'s own addresses');
  assert.deepEqual([got.context_slot, got.table, got.table_address, got.orders.length], [String(PENDING.slot), 'present', PENDING.conquest_table.address, 1]);
  const m = siegeOrderModel(got.orders[0].facts);
  assert.deepEqual([m.ok, m.phase, m.orderBell, m.decidedBell, m.stake, m.slot, m.settled, m.lapsed, m.source, m.standing], [true, 'ordered', String(PENDING.reservation_bell), null, 'held', 'held', false, null, null, STANDING]);
  h = serve(APPLIED); got = await h.read.read(body);
  assert.deepEqual([got.context_slot, got.table, got.orders], [String(APPLIED.slot), 'present', []], 'the record is gone: no order is reported, and nothing is inferred from that');
  assert.ok(!/started|returned|captured|applied/.test(JSON.stringify(got)));
  // mixing the two snapshots' accounts in one answer is refused whole
  const mixed = createConquestOrdersRead({ cfg, city: null, historicalTableV1: true, rpc: async () => ({ result: { context: { slot: 700 }, value: [PENDING.conquest_table, APPLIED.province, PENDING.citizen].map(a => ({ owner: a.owner, executable: a.executable, data: [a.data_base64, 'base64'] })) } }) });
  await assert.rejects(mixed.read(body), e => e.code === 'ConquestPrepareScopeMismatch');
});

test('V1 — the relay\'s CITY BINDING on the real wide Province bytes: the real Free City passes; another site, tile, province or a non-city is refused before the CLI', async () => {
  // What the binding reads (local-play-conquest.mjs `bound`): the Province at its canonical address, its site count,
  // SITES[site] and the site mirror's state. Here: the bytes the real program wrote, in both snapshots.
  for (const s of E.snapshots) {
    const p = decodePrefix('Province', Buffer.from(s.province.data_base64, 'base64'), { profile: 2 });
    assert.equal(Number(p.siteCount), 12, s.stage);
    const cities = p.siteMirror.slice(0, 12).map((m, i) => (Number(m.state) === 5 ? i : -1)).filter(i => i >= 0);
    assert.deepEqual(cities, [1], 'exactly one Free City, at site 1'); assert.equal(p.sites[1], 10, 'on tile 10');
  }
  const cfg = { localPlay: true, rpc: 'http://127.0.0.1:41964', program: E.program, season: E.season, wallet: E.player_wallet_public_key, rulesetHash: LOCAL_PLAY_RULESET_HASH,
    prepareBin: '/nonexistent/frontier-experimental-expedition-depart-prepare', cuLimit: '400000', loadedLimit: '1048576' };
  const capability = free_city => ({ schema: 'frontier-local-play-conquest-capability-v1', artifact_sha256: E.artifact_sha256, markers: [...CONQUEST_MARKERS], program: E.program, season: E.season,
    rpc: cfg.rpc, world_preset: CONQUEST_WORLD_PRESET, free_city });
  // a TEST build of the conquest object (an explicit stand-in adapter): the binding is the real one, the CLI is never run
  const run = async (free_city, target, snapshot = PENDING, over = {}) => {
    const reads = []; let reached = 0;
    const adapter = async () => { reached++; throw Object.assign(new Error('stand-in adapter reached'), { code: 'StandInAdapter' }); }; adapter.prepare = adapter;
    const conquest = createLocalPlayConquest({ cfg, conquestBin: '/operator/bin/frontier-experimental-conquest-prepare', capability: capability(free_city), prepare: adapter,
      rpc: async (method, params) => { reads.push({ method, at: params[0] }); const a = snapshot.province;
        return method === 'getAccountInfo' ? { result: { context: { slot: snapshot.slot }, value: { owner: a.owner, executable: a.executable, lamports: a.lamports, data: [a.data_base64, 'base64'], ...over } } } : { error: { code: -1 } }; } });
    const body = { schema: 'frontier-local-play-conquest-prepare-request-v1', request_id: 'cq_v1', action: 'DeclareSiege', source_request: source(), source_context_slot: '0', source_snapshot_digest: 'ab'.repeat(32), target };
    let code = null; try { await conquest.prepare(body, {}); } catch (e) { code = e?.code ?? String(e); }
    conquest.close?.();
    return { code, reads: reads.filter(r => r.method === 'getAccountInfo'), reached };
  };
  const CITY = { p: '129', q: '0', site: 1, tile: 10 };
  // the real city, in both snapshots: one read of the Province at the program's own address, and the binding lets the request through
  for (const snap of E.snapshots) {
    const r = await run(CITY, { site: 1, entry: 0 }, snap);
    assert.equal(r.reads.length, 1); assert.equal(r.reads[0].at, snap.province.address, 'read at the canonical address the program wrote to');
    // (exactly what follows the binding: the request reaches the CLI stand-in ONCE, and its own error is what comes back —
    //  not some other refusal on the way that would only look like "not a scope mismatch")
    assert.deepEqual([r.code, r.reached], ['StandInAdapter', 1], `${snap.stage}: the binding accepts the real city and hands the request on`);
  }
  // a capability whose tile is not that site's on the chain, or whose site is not a Free City there: refused after the one read, nothing prepared
  for (const free_city of [{ ...CITY, tile: 11 }, { ...CITY, tile: 38 }, { p: '129', q: '0', site: 0, tile: 38 }, { p: '129', q: '0', site: 2, tile: 25 }]) {
    const r = await run(free_city, { site: free_city.site, entry: 0 });
    assert.deepEqual([r.code, r.reads.length, r.reached], ['ConquestPrepareScopeMismatch', 1, 0], JSON.stringify(free_city));
  }
  // a request for another site than the capability's, or a capability of another province: refused with NO read at all
  for (const [free_city, target] of [[CITY, { site: 2, entry: 0 }], [{ ...CITY, p: '130' }, { site: 1, entry: 0 }], [{ ...CITY, p: '-129' }, { site: 1, entry: 0 }]]) {
    const r = await run(free_city, target);
    assert.deepEqual([r.code, r.reads.length, r.reached], ['ConquestPrepareScopeMismatch', 0, 0], JSON.stringify([free_city, target]));
  }
  // the same bytes under another owner are not this program's Province
  assert.deepEqual((({ code, reached }) => [code, reached])(await run(CITY, { site: 1, entry: 0 }, PENDING, { owner: E.season })), ['ConquestPrepareScopeMismatch', 0]);
});

test('this is evidence about the readers, not an opening: the gates and the chain-table flag are as they were', () => {
  assert.deepEqual(CONQUEST_OPEN_CONDITIONS, { dispatchPublished: true, addressVectorsVerified: true, heapConfirmed: false, pageBinding: false });
  assert.equal(typeof E.synthetic, 'string'); assert.match(E.synthetic, /not natural play/);
  assert.equal(RESERVATION_LAYOUT_CHECKED.abiCodecVector, true);
});
