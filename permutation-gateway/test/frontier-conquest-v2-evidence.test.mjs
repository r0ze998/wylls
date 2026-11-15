// The route's read AS THE ROUTE RUNS IT (no option: a 2,688-byte conquest table of layout version 2, nothing else)
// against PUBLIC ACCOUNT BYTES WRITTEN BY THE CURRENT SBF ARTEFACT (sha256 e6bfe8c2…) in two memory-only runs:
//
//   docs/integration/evidence-fable-conquest-v2/res-real-evidence-v2codec-e6bfe8c2-capture.json     pending → applied → CAPTURE_DUE → captured
//   docs/integration/evidence-fable-conquest-v2/res-real-evidence-v2codec-e6bfe8c2-notapplied.json  pending → NOT_APPLIED → returned
//
// These two are BYTE COPIES of the ABI owner's files (their sha256 is pinned below); nothing in them is edited, and no
// header of any older file is rewritten to stand for them. Public accounts only; each stage is one lock snapshot of
// four accounts (table, wide Province, Citizen, the city's wide Holding position).
//
// What this establishes: on bytes the current program wrote, the version-2 read accepts every stage and reports it
// as the PRESENT fact it is — and the two layouts are kept apart both ways (the saved version-1 runs of the earlier
// artefact 87b19e9e… are refused by the route's read; these version-2 bytes are refused by the historical option).
// What it does NOT establish: natural play (both chains start from a synthetic strong fixture, the capture run on a
// synthetic requirement), a relay process, a browser, or anything about opening the routes. The negatives alter the
// real bytes in memory. No chain, no network, no key; runs under the no-key guard.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import * as T from '../src/frontier/conquest-table-read.mjs';
import { createConquestOrdersRead, CONQUEST_ORDERS_REQUEST_SCHEMA, CONQUEST_ORDERS_SCHEMA } from '../src/frontier/local-play-conquest-orders.mjs';
import { CONQUEST_OPEN_CONDITIONS } from '../src/frontier/local-play-conquest.mjs';
import { LOCAL_PLAY_RULESET_HASH } from '../src/frontier/local-play-relay.mjs';
import { canonicalOriginalHostRef, canonicalWideProvinceKey } from '../../permutation-server/web/frontier/fexpedition-seal.mjs';
import { canonicalDeclareSiegeRoles } from '../../permutation-server/web/frontier/fconquest-identity.mjs';
import { siegeOrderRead } from '../../permutation-server/web/frontier/fconquest-order.mjs';

const raw = name => readFileSync(new URL(`../../docs/integration/${name}`, import.meta.url));
const FILES = {
  cap: ['evidence-fable-conquest-v2/res-real-evidence-v2codec-e6bfe8c2-capture.json', 'ed27b6002eb8b7d8fcfd8b1c6901deaf97261692a5515637aae8ad3491b6ff3c'],
  not: ['evidence-fable-conquest-v2/res-real-evidence-v2codec-e6bfe8c2-notapplied.json', '75d1454cf3cd8e56aa0c7a5fb7f4ed8ffb12e6c2a820248705a5612d6024d53f'],
};
const HISTORY = ['CLAUDE-CONQUEST-RESERVATION-REAL-EVIDENCE-20261112.json', 'CLAUDE-CONQUEST-RESERVATION-REAL-EVIDENCE-CAPTURE-STAGES-20261112.json', 'CLAUDE-CONQUEST-RESERVATION-REAL-EVIDENCE-NOTAPPLIED-STAGES-20261112.json'];
const CAP = JSON.parse(raw(FILES.cap[0])), NOT = JSON.parse(raw(FILES.not[0]));
const CITY = { p: '129', q: '0', site: 1, tile: 10 };
const stage = (E, name) => { const s = E.snapshots.find(x => x.stage === name); assert.ok(s, name); return s; };
const source = E => ({ schema: 'frontier-original-expedition-request-v1', operation: 'inspect', cluster: 'localnet', program: E.program, season: E.season,
  deployment: { program_version: '18436', ruleset_hash: LOCAL_PLAY_RULESET_HASH },
  host: canonicalOriginalHostRef({ world: E.world_hex, p: '128', q: '0', site: 1, gen: 2, seq: 0 }),
  original_owner: E.citizen, standing: { p: '129', q: '0' }, min_slot: '0', wallet: E.player_wallet_public_key, payer: E.player_wallet_public_key });
const cfgOf = E => ({ localPlay: true, rpc: 'http://127.0.0.1:41964', program: E.program, season: E.season, wallet: E.player_wallet_public_key, rulesetHash: LOCAL_PLAY_RULESET_HASH,
  prepareBin: '/nonexistent/frontier-experimental-expedition-depart-prepare', cuLimit: '1000000', loadedLimit: '67108864' });
/** The file's account → what an RPC gives (an ABSENT account is `{address, absent: true}` in the file and `null` over RPC). `f` alters a copy of the bytes. */
const rpcValue = (a, f = null) => {
  if (a === null || a === undefined || a.absent === true) return null;
  const b = Buffer.from(a.data_base64, 'base64'); assert.equal(b.length, a.bytes);
  if (f) f(b);
  return { owner: a.owner, executable: a.executable, lamports: a.lamports, data: [b.toString('base64'), 'base64'] };
};
/** One read of stage `s` of run `E`. `extra`: further factory arguments (none = exactly as the relay builds it). */
async function read(E, s, { alter = {}, accounts = {}, city = CITY, extra = {} } = {}) {
  const calls = [], pick = k => accounts[k] ?? s[k];
  const r = createConquestOrdersRead({ cfg: cfgOf(E), city, ...extra, rpc: async (method, params) => { calls.push({ method, at: params[0] });
    return { result: { context: { slot: s.slot }, value: [rpcValue(pick('conquest_table'), alter.table), rpcValue(pick('province'), alter.province), rpcValue(pick('citizen'), alter.citizen), rpcValue(pick('target_holding'), alter.holding)] } }; } });
  let got = null, code = null;
  try { got = await r.read({ schema: CONQUEST_ORDERS_REQUEST_SCHEMA, source_request: source(E) }); } catch (e) { code = e?.code ?? String(e); }
  return { got, code, calls };
}
const pageOf = (E, got) => siegeOrderRead(got, { program: E.program, season: E.season, wallet: E.player_wallet_public_key, standing: { p: '129', q: '0' } });
const bytes = a => new Uint8Array(Buffer.from(a.data_base64, 'base64'));
const version = a => { const b = bytes(a); return b[16] | (b[17] << 8); };
const NEVER = /started|returned|captured|won|lost|succeed|fail/;

test('the files are the pinned copies, written by the CURRENT artefact; every table in them is 2,688 bytes of layout version 2; the earlier runs are another artefact and version 1', async () => {
  for (const [name, sha] of Object.values(FILES)) assert.equal(createHash('sha256').update(raw(name)).digest('hex'), sha, name);
  assert.equal(T.CONQUEST_TABLE_VERSION, 2); assert.equal(T.CONQUEST_TABLE_VERSION_HISTORICAL, 1);
  assert.equal(T.CONQUEST_ARTIFACT_CURRENT, 'e6bfe8c206caeb840531a64e9df497a2e4fc2c1224521e474700d774f4d961de');
  assert.equal(T.CONQUEST_ARTIFACT_HISTORICAL, '87b19e9ed1073f0e18fcab274d22e8015c896afdd5cbab98b223475f60456db3');
  for (const E of [CAP, NOT]) {
    assert.equal(E.artifact_sha256, T.CONQUEST_ARTIFACT_CURRENT); assert.equal(E.season_id, 11); assert.match(E.synthetic, /not natural play/);
    const roles = canonicalDeclareSiegeRoles(source(E), CITY.site), at = n => roles.find(r => r.name === n).address;
    for (const s of E.snapshots) {
      assert.equal(s.conquest_table.bytes, 2688, s.stage); assert.equal(version(s.conquest_table), 2, s.stage);
      // the four addresses this code derives are the ones the program wrote to (the Holding position too, present or absent)
      assert.equal(at('conquest'), s.conquest_table.address); assert.equal(at('target_province'), s.province.address); assert.equal(at('citizen'), s.citizen.address);
      assert.equal(at('target_holding_position'), s.target_holding.address);
      for (const k of ['conquest_table', 'province', 'citizen']) { assert.equal(s[k].owner, E.program); assert.equal(s[k].executable, false); }
      const r = await read(E, s);
      assert.equal(r.code, null, `${s.stage}: accepted by the route's own read`); assert.equal(r.calls.length, 1); assert.equal(r.calls[0].method, 'getMultipleAccounts');
      assert.deepEqual(r.calls[0].at, [s.conquest_table.address, s.province.address, s.citizen.address, s.target_holding.address]);
    }
  }
  assert.deepEqual(CAP.snapshots.map(s => s.stage), ['reservation_pending', 'reservation_applied', 'capture_due', 'captured']);
  assert.deepEqual(NOT.snapshots.map(s => s.stage), ['reservation_pending', 'not_applied', 'returned']);
  assert.deepEqual(CAP.snapshots.map(s => s.target_holding.absent === true), [true, true, true, false]);
  assert.ok(NOT.snapshots.every(s => s.target_holding.absent === true));
  // the saved earlier runs: the other artefact, the same size, version 1 — history, not the route's layout
  for (const name of HISTORY) { const H = JSON.parse(raw(name)); assert.equal(H.artifact_sha256, T.CONQUEST_ARTIFACT_HISTORICAL, name);
    for (const s of H.snapshots) { assert.equal(s.conquest_table.bytes, 2688); assert.equal(version(s.conquest_table), 1, `${name} ${s.stage}`); } }
});

test('the capture run on version-2 bytes, stage by stage: each is the present fact it is, and the page model accepts exactly that', async () => {
  const bell = String(stage(CAP, 'reservation_pending').reservation_bell);
  let { got, code } = await read(CAP, stage(CAP, 'reservation_pending')); assert.equal(code, null);
  assert.equal(got.schema, CONQUEST_ORDERS_SCHEMA); assert.equal(got.siege, null);
  assert.deepEqual(got.orders.map(o => [o.facts.phase, o.facts.site, o.facts.order_bell, o.facts.stake, o.facts.slot]), [['ordered', 1, bell, 'held', 'held']]);
  let page = pageOf(CAP, got); assert.deepEqual([page.ok, page.orders.length, page.city], [true, 1, null]);
  // APPLIED: the record is gone; this wallet's siege entry stands with its own progress of its own requirement
  ({ got, code } = await read(CAP, stage(CAP, 'reservation_applied'))); assert.equal(code, null);
  assert.deepEqual(got.orders, []); assert.deepEqual(Object.keys(got.siege), ['state', 'site', 'progress', 'required', 'declared_bell']);
  assert.deepEqual([got.siege.state, got.siege.site, got.siege.progress, got.siege.declared_bell], ['siege', 1, 0, bell]); assert.ok(got.siege.required > 0);
  page = pageOf(CAP, got); assert.deepEqual(page.city, { state: 'siege', site: 1, progress: 0, required: got.siege.required, declaredBell: bell });
  // CAPTURE_DUE: no progress figure; the Holding position is still absent — NOT owned
  ({ got, code } = await read(CAP, stage(CAP, 'capture_due'))); assert.equal(code, null);
  assert.deepEqual(got.orders, []); assert.deepEqual(Object.keys(got.siege), ['state', 'site', 'due_bell', 'declared_bell']);
  assert.deepEqual([got.siege.state, got.siege.site, got.siege.declared_bell], ['capture_due', 1, bell]); assert.ok(BigInt(got.siege.due_bell) > BigInt(bell));
  assert.equal(pageOf(CAP, got).city.state, 'capture_due');
  // CAPTURED (the file's stage name): the read states the present fact — this wallet's Citizen holds the Holding there now
  ({ got, code } = await read(CAP, stage(CAP, 'captured'))); assert.equal(code, null);
  assert.deepEqual(got.orders, []); assert.deepEqual(got.siege, { state: 'owned', site: 1, slot: 2, generation: 1 });
  assert.deepEqual(pageOf(CAP, got).city, { state: 'owned', site: 1, slot: 2, generation: 1 });
  assert.doesNotMatch(JSON.stringify(got), /captured|won|receipt/, '"owned" is about now; no past event is stated');
});

test('the not-applied run on version-2 bytes: waiting → "did not take effect" with both parts still owed → NOTHING (a vanished record is not "returned")', async () => {
  const bell = String(stage(NOT, 'reservation_pending').reservation_bell);
  let { got, code } = await read(NOT, stage(NOT, 'reservation_pending')); assert.equal(code, null);
  assert.deepEqual(got.orders.map(o => [o.facts.phase, o.facts.order_bell]), [['ordered', bell]]); assert.equal(got.siege, null);
  ({ got, code } = await read(NOT, stage(NOT, 'not_applied'))); assert.equal(code, null);
  assert.equal(got.orders.length, 1); assert.equal(got.siege, null);
  const f = got.orders[0].facts;
  assert.deepEqual([f.phase, f.order_bell, f.decided_bell, f.lapsed, f.source, f.reason, f.stake, f.slot], ['not_applied', bell, null, null, null, null, 'held', 'held']);
  let page = pageOf(NOT, got); assert.deepEqual([page.ok, page.orders[0].model.phase, page.orders[0].model.settled], [true, 'not_applied', false]);
  // RETURNED (the file's stage name): the record is gone, nothing stands at the city → the read says nothing at all
  ({ got, code } = await read(NOT, stage(NOT, 'returned'))); assert.equal(code, null);
  assert.deepEqual([got.table, got.orders, got.siege], ['present', [], null]); assert.doesNotMatch(JSON.stringify(got), NEVER);
  page = pageOf(NOT, got); assert.deepEqual([page.ok, page.orders.length, page.city], [true, 0, null]);
  // what the RUN returned (deposit, slot marks, the day's count) is the ABI owner's observation of the chain; this read
  // does not and cannot state it. What the bytes here do show: the Citizen's slot marks are clear again at `returned`.
  assert.equal(bytes(stage(NOT, 'returned').citizen)[187], 0); assert.notEqual(bytes(stage(NOT, 'not_applied').citizen)[187], 0);
});

test('the two layouts never mix: the route reads version 2 only; the historical option reads version 1 only; 1,664 bytes and other versions are read by neither', async () => {
  const key = E => canonicalWideProvinceKey({ world: E.world_hex, p: '129', q: '0' });
  const direct = (s, opts) => { try { T.conquestTable(bytes(s.conquest_table), bytes(s.province), { seasonId: 11, ...opts }); return null; } catch (e) { return e.code; } };
  // (1) version-2 bytes: accepted plainly, refused under the historical option — by the reader and by the read built with it
  for (const E of [CAP, NOT]) for (const s of E.snapshots) {
    assert.equal(direct(s, { key: key(E) }), null, s.stage); assert.equal(direct(s, { key: key(E), historicalV1: true }), 'ConquestTableVersion', s.stage);
    const r = await read(E, s, { extra: { historicalTableV1: true } });
    assert.deepEqual([r.code, r.got], ['ConquestPrepareScopeMismatch', null], `${s.stage}: the whole read is refused, nothing partial`);
  }
  // (2) the saved version-1 runs of the earlier artefact: refused by the route's read whole; read only under the explicit option
  for (const name of HISTORY.slice(1)) { const H = JSON.parse(raw(name));
    for (const s of H.snapshots) {
      assert.equal(direct(s, { key: key(H) }), 'ConquestTableVersion', `${name} ${s.stage}`);
      assert.deepEqual([(await read(H, s)).code, (await read(H, s)).got], ['ConquestPrepareScopeMismatch', null]);
      assert.equal((await read(H, s, { extra: { historicalTableV1: true } })).code, null, `${name} ${s.stage}: history, by the explicit option only`);
    } }
  // (3) real version-2 bytes with the version field altered in memory: 1 (as the earlier artefact wrote), 0, 3, a high byte — refused whole
  const applied = stage(CAP, 'reservation_applied');
  for (const f of [b => { b[16] = 1; }, b => { b[16] = 0; }, b => { b[16] = 3; }, b => { b[17] = 1; }]) {
    assert.deepEqual([(await read(CAP, applied, { alter: { table: f } })).code], ['ConquestPrepareScopeMismatch']);
  }
  // (4) a table of 1,664 bytes (a program without the lane; its own version 1): never read, with either option
  for (const s of [applied, stage(NOT, 'not_applied')]) {
    const short = { ...s.conquest_table, bytes: 1664, data_base64: Buffer.from(bytes(s.conquest_table).subarray(0, 1664)).toString('base64') };
    for (const extra of [{}, { historicalTableV1: true }]) assert.equal((await read(s === applied ? CAP : NOT, s, { accounts: { conquest_table: short }, extra })).code, 'ConquestPrepareScopeMismatch');
    const v1short = { ...short, data_base64: (() => { const b = Buffer.from(short.data_base64, 'base64'); b[16] = 1; return b.toString('base64'); })() };
    for (const extra of [{}, { historicalTableV1: true }]) assert.equal((await read(s === applied ? CAP : NOT, s, { accounts: { conquest_table: v1short }, extra })).code, 'ConquestPrepareScopeMismatch');
  }
  // (5) the option is a boolean and nothing else; and no route can set it: the relay's sources never name it
  for (const v of [1, 0, 'true', null, {}]) assert.throws(() => createConquestOrdersRead({ cfg: cfgOf(CAP), city: CITY, rpc: async () => ({}), historicalTableV1: v }), /bad historicalTableV1/);
  for (const name of ['local-play-relay-server.mjs', 'local-play-conquest.mjs', 'local-play-relay.mjs', 'local-play-resident.mjs', 'server.mjs', 'app.mjs']) {
    assert.doesNotMatch(readFileSync(new URL(`../src/frontier/${name}`, import.meta.url), 'utf8'), /historical/i, `${name} never asks for the historical layout`);
  }
  // (the launcher is another owner's file and may be absent from a tree; where it is present it does not name the option either)
  for (const name of ['local-play-launcher.mjs'].filter(n => existsSync(new URL(`../src/frontier/${n}`, import.meta.url)))) {
    assert.doesNotMatch(readFileSync(new URL(`../src/frontier/${name}`, import.meta.url), 'utf8'), /historical/i, `${name} never asks for the historical layout`);
  }
  const route = readFileSync(new URL('../src/frontier/local-play-conquest-orders.mjs', import.meta.url), 'utf8');
  assert.equal([...route.matchAll(/historicalV1: historicalTableV1/g)].length, 1); assert.match(route, /historicalTableV1 = false \}\)/);
});

test('negatives on the version-2 bytes: a mismatch refuses the whole read; stages are not mixed; "owned" needs every tie', async () => {
  const cap = stage(CAP, 'captured'), due = stage(CAP, 'capture_due'), applied = stage(CAP, 'reservation_applied'), pending = stage(CAP, 'reservation_pending');
  const refused = async (opts, s = cap, E = CAP) => { const r = await read(E, s, opts); assert.deepEqual([r.code, r.got], ['ConquestPrepareScopeMismatch', null], JSON.stringify(Object.keys(opts.alter ?? opts.accounts ?? {}))); };
  const SITE = 296 + 1 * 64, SLOT2 = 168 + 6;
  // the Province's mirror of the site, the Citizen's slot and marks, the Holding's own bytes and account
  for (const f of [b => { b[SITE] = 5; }, b => { b[SITE + 4] = 2; }, b => { b[SITE + 2] = 3; }, b => { b[SITE + 1] ^= 1; }]) await refused({ alter: { province: f } });
  for (const f of [b => { b[SLOT2 + 5] = 255; }, b => { b[187] = 0x14; }, b => { b[187] = 0x02; }, b => { b[136] ^= 1; }]) await refused({ alter: { citizen: f } });
  for (const f of [b => { b[112] ^= 1; }, b => { b[68] = 2; }]) await refused({ alter: { holding: f } });
  await refused({ accounts: { target_holding: { ...cap.target_holding, owner: CAP.season } } });
  // a Holding account AND an entry at the site at once; an entry or a record the Citizen does not bear out
  await refused({ accounts: { target_holding: cap.target_holding } }, due);
  for (const s of [applied, due, pending]) await refused({ alter: { citizen: b => { b[187] = 0; } } }, s);
  // stages mixed in one answer; the other run's Citizen
  await refused({ accounts: { province: pending.province } }, applied); await refused({ accounts: { citizen: cap.citizen } }, pending);
  await refused({ accounts: { citizen: stage(NOT, 'not_applied').citizen } }, pending);
  // the reservation region of the real table: an unknown status, a record of a site out of range
  await refused({ alter: { table: b => { b[1664] = 3; } } }, pending); await refused({ alter: { table: b => { b[1664 + 1] = 12; } } }, pending);
  await refused({ alter: { table: b => { b[1664] = 3; } } }, stage(NOT, 'not_applied'), NOT);
  // NOT refusals, and not "owned": a RELEASED Holding → nothing; another Citizen's Holding → "another player's"
  let r = await read(CAP, cap, { alter: { holding: b => { b[71] = 3; } } }); assert.deepEqual([r.code, r.got.siege], [null, null]);
  r = await read(CAP, cap, { alter: { holding: b => { b[72] ^= 1; } } }); assert.deepEqual([r.code, r.got.siege], [null, { state: 'other', site: 1, what: 'holding' }]);
});

test('this is evidence about the read, not an opening', () => {
  assert.deepEqual(CONQUEST_OPEN_CONDITIONS, { dispatchPublished: true, addressVectorsVerified: true, heapConfirmed: false, pageBinding: false });
});
