// The four-account read (local-play-conquest-orders.mjs, v2: reservations + the city's PRESENT state) and the page's
// model of its answer, against PUBLIC ACCOUNT BYTES WRITTEN BY THE REAL SBF PROGRAM in two memory-only runs:
//
//   CLAUDE-CONQUEST-RESERVATION-REAL-EVIDENCE-CAPTURE-STAGES-20261112.json     pending → applied → CAPTURE_DUE → captured
//   CLAUDE-CONQUEST-RESERVATION-REAL-EVIDENCE-NOTAPPLIED-STAGES-20261112.json  pending → NOT_APPLIED → returned
//
// (the ABI owner's files in docs/integration, read only; public accounts only, each stage one lock snapshot
// of four accounts: table, wide Province, Citizen, the city's wide Holding position). The 2-snapshot file of the
// first run stays as it is and keeps its own test (frontier-conquest-real-evidence.test.mjs).
//
// What this establishes: on bytes the program wrote, the read reports each stage as the PRESENT fact it is — and
// nothing for what is gone. What it does NOT establish: natural play (both chains start from a synthetic strong
// fixture), or anything about opening the routes. The negatives below alter the real bytes in memory.
// No chain, no network, no key; runs under the no-key guard.
//
// HISTORICAL: both files were written by the EARLIER artefact (87b19e9e…): 2,688-byte tables whose header says layout
// version 1. The current artefact (e6bfe8c2…) writes version 2 and the route reads version 2 only; these runs are
// kept as history and read with the explicit historical option (`historicalTableV1: true`), which no route can pass.
// The bytes are not rewritten. The same stages on the current artefact's bytes: frontier-conquest-v2-evidence.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createConquestOrdersRead, CONQUEST_ORDERS_REQUEST_SCHEMA, CONQUEST_ORDERS_SCHEMA } from '../src/frontier/local-play-conquest-orders.mjs';
import { CONQUEST_OPEN_CONDITIONS } from '../src/frontier/local-play-conquest.mjs';
import { LOCAL_PLAY_RULESET_HASH } from '../src/frontier/local-play-relay.mjs';
import { canonicalOriginalHostRef } from '../../permutation-server/web/frontier/fexpedition-seal.mjs';
import { canonicalDeclareSiegeRoles } from '../../permutation-server/web/frontier/fconquest-identity.mjs';
import { siegeOrderRead } from '../../permutation-server/web/frontier/fconquest-order.mjs';
import * as hand from '../../permutation-server/web/frontier/hud/hand.mjs';
import { setLang } from '../../permutation-server/web/lang.mjs';

const load = name => JSON.parse(readFileSync(new URL(`../../docs/integration/${name}`, import.meta.url), 'utf8'));
const CAP = load('CLAUDE-CONQUEST-RESERVATION-REAL-EVIDENCE-CAPTURE-STAGES-20261112.json');
const NOT = load('CLAUDE-CONQUEST-RESERVATION-REAL-EVIDENCE-NOTAPPLIED-STAGES-20261112.json');
const CITY = { p: '129', q: '0', site: 1, tile: 10 };
const stage = (E, name) => { const s = E.snapshots.find(x => x.stage === name); assert.ok(s, name); return s; };
const source = E => ({ schema: 'frontier-original-expedition-request-v1', operation: 'inspect', cluster: 'localnet', program: E.program, season: E.season,
  deployment: { program_version: '18436', ruleset_hash: LOCAL_PLAY_RULESET_HASH },
  host: canonicalOriginalHostRef({ world: E.world_hex, p: '128', q: '0', site: 1, gen: 2, seq: 0 }),
  original_owner: E.citizen, standing: { p: '129', q: '0' }, min_slot: '0', wallet: E.player_wallet_public_key, payer: E.player_wallet_public_key });
const cfgOf = E => ({ localPlay: true, rpc: 'http://127.0.0.1:41964', program: E.program, season: E.season, wallet: E.player_wallet_public_key, rulesetHash: LOCAL_PLAY_RULESET_HASH,
  prepareBin: '/nonexistent/frontier-experimental-expedition-depart-prepare', cuLimit: '1000000', loadedLimit: '67108864' });
/**
 * The evidence's account → what an RPC gives: an ABSENT account is written `{address, absent: true}` in the files and
 * is `null` over RPC. The reader is not loosened for the file's shape: this adapter makes the file speak RPC.
 * `alter`: `{table?, province?, citizen?, holding?}` functions over a copy of the bytes (for the negatives).
 */
const rpcValue = (a, f = null) => {
  if (a === null || a === undefined || a.absent === true) return null;
  const b = Buffer.from(a.data_base64, 'base64'); assert.equal(b.length, a.bytes);
  if (f) f(b, new DataView(b.buffer, b.byteOffset, b.byteLength));
  return { owner: a.owner, executable: a.executable, lamports: a.lamports, data: [b.toString('base64'), 'base64'] };
};
async function read(E, s, { alter = {}, accounts = {}, city = CITY } = {}) {
  const calls = [], pick = k => accounts[k] ?? s[k];
  const r = createConquestOrdersRead({ cfg: cfgOf(E), city, historicalTableV1: true, rpc: async (method, params) => { calls.push({ method, at: params[0] });
    return { result: { context: { slot: s.slot }, value: [rpcValue(pick('conquest_table'), alter.table), rpcValue(pick('province'), alter.province), rpcValue(pick('citizen'), alter.citizen), rpcValue(pick('target_holding'), alter.holding)] } }; } });
  let got = null, code = null;
  try { got = await r.read({ schema: CONQUEST_ORDERS_REQUEST_SCHEMA, source_request: source(E) }); } catch (e) { code = e?.code ?? String(e); }
  return { got, code, calls };
}
const pageOf = (E, got) => siegeOrderRead(got, { program: E.program, season: E.season, wallet: E.player_wallet_public_key, standing: { p: '129', q: '0' } });
const NEVER = /started|returned|captured|won|lost|succeed|fail/;

test('the evidence files are the ones expected, and every address asked is the one the program wrote to (also for an absent Holding)', async () => {
  for (const E of [CAP, NOT]) {
    assert.equal(E.schema, 'claude-conquest-reservation-real-evidence-v1'); assert.equal(E.season_id, 11); assert.match(E.synthetic, /not natural play/);
    const roles = canonicalDeclareSiegeRoles(source(E), CITY.site), at = n => roles.find(r => r.name === n).address;
    for (const s of E.snapshots) {
      // the four PDAs this code derives are the evidence's own addresses — the Holding position too, present or absent
      assert.equal(at('conquest'), s.conquest_table.address, s.stage); assert.equal(at('target_province'), s.province.address); assert.equal(at('citizen'), s.citizen.address);
      assert.equal(at('target_holding_position'), s.target_holding.address, `${s.stage}: the city's Holding position`);
      const r = await read(E, s);
      assert.equal(r.calls.length, 1, 'ONE read'); assert.equal(r.calls[0].method, 'getMultipleAccounts');
      assert.deepEqual(r.calls[0].at, [s.conquest_table.address, s.province.address, s.citizen.address, s.target_holding.address]);
      for (const k of ['conquest_table', 'province', 'citizen']) { assert.equal(s[k].owner, E.program); assert.equal(s[k].executable, false); }
    }
  }
  assert.deepEqual(CAP.snapshots.map(s => s.stage), ['reservation_pending', 'reservation_applied', 'capture_due', 'captured']);
  assert.deepEqual(NOT.snapshots.map(s => s.stage), ['reservation_pending', 'not_applied', 'returned']);
  assert.deepEqual(CAP.snapshots.map(s => s.target_holding.absent === true), [true, true, true, false]);
  assert.ok(NOT.snapshots.every(s => s.target_holding.absent === true));
});

test('the capture run, stage by stage: each is reported as the present fact it is, and the page model accepts exactly that', async () => {
  // PENDING: a reservation waiting; nothing stands at the city
  let { got, code } = await read(CAP, stage(CAP, 'reservation_pending')); assert.equal(code, null);
  assert.equal(got.schema, CONQUEST_ORDERS_SCHEMA); assert.equal(got.siege, null);
  assert.deepEqual(got.orders.map(o => [o.facts.phase, o.facts.site, o.facts.order_bell, o.facts.stake, o.facts.slot]), [['ordered', 1, '19', 'held', 'held']]);
  let page = pageOf(CAP, got); assert.deepEqual([page.ok, page.orders.length, page.city], [true, 1, null]);
  // APPLIED: the record is gone; the siege entry of this wallet stands, with ITS OWN progress of ITS OWN requirement
  ({ got, code } = await read(CAP, stage(CAP, 'reservation_applied'))); assert.equal(code, null);
  assert.deepEqual(got.orders, []); assert.deepEqual(got.siege, { state: 'siege', site: 1, progress: 0, required: 36, declared_bell: '19' });
  page = pageOf(CAP, got); assert.deepEqual(page.city, { state: 'siege', site: 1, progress: 0, required: 36, declaredBell: '19' });
  // CAPTURE_DUE: no progress figure; due from its own turn; the Holding position is still absent — NOT owned
  ({ got, code } = await read(CAP, stage(CAP, 'capture_due'))); assert.equal(code, null);
  assert.deepEqual(got.orders, []); assert.equal(got.siege.state, 'capture_due'); assert.equal(got.siege.site, 1); assert.equal(got.siege.declared_bell, '19');
  assert.ok(BigInt(got.siege.due_bell) > 19n); assert.deepEqual(Object.keys(got.siege), ['state', 'site', 'due_bell', 'declared_bell'], 'no progress, no requirement');
  page = pageOf(CAP, got); assert.equal(page.city.state, 'capture_due');
  // CAPTURED (the stage's name in the file): what the read says is the PRESENT fact — this wallet's Citizen holds the Holding there now
  ({ got, code } = await read(CAP, stage(CAP, 'captured'))); assert.equal(code, null);
  assert.deepEqual(got.orders, []); assert.deepEqual(got.siege, { state: 'owned', site: 1, slot: 2, generation: 1 });
  page = pageOf(CAP, got); assert.deepEqual(page.city, { state: 'owned', site: 1, slot: 2, generation: 1 });
  assert.doesNotMatch(JSON.stringify(got), /captured|won|receipt/, 'no past event is stated: "owned" is about now');
  // the card's words for the four, in order
  setLang('en');
  try {
    const line = async name => String(hand.cityStateView(pageOf(CAP, (await read(CAP, stage(CAP, name))).got).city));
    assert.equal(await line('reservation_pending'), '');
    assert.match(await line('reservation_applied'), /Your siege is under way: 0 of 36 turns \(declared at turn 19; site 1\)\. The city is not yours yet\./);
    assert.match(await line('capture_due'), /waiting to be settled \(due from turn \d+; declared at turn 19; site 1\)\. The city is not yours yet\./);
    const owned = await line('captured');
    assert.match(owned, /You hold this city now \(site 1; holding slot 2\)\. Only the fact that you hold it now is shown\./); assert.doesNotMatch(owned, /captured|won|victory/i);
  } finally { setLang('ja'); }
});

test('the not-applied run: a waiting reservation, then "did not take effect" with what is owed, then NOTHING — a vanished record is not "returned"', async () => {
  let { got, code } = await read(NOT, stage(NOT, 'reservation_pending')); assert.equal(code, null);
  assert.deepEqual(got.orders.map(o => [o.facts.phase, o.facts.order_bell]), [['ordered', '20']]); assert.equal(got.siege, null);
  // NOT_APPLIED: the record says so, with its two owed parts; how it ended is not said (null), nothing is "returned" yet
  ({ got, code } = await read(NOT, stage(NOT, 'not_applied'))); assert.equal(code, null);
  assert.equal(got.orders.length, 1); assert.equal(got.siege, null);
  const f = got.orders[0].facts;
  assert.deepEqual([f.phase, f.order_bell, f.decided_bell, f.lapsed, f.source, f.reason, f.stake, f.slot], ['not_applied', '20', null, null, null, null, 'held', 'held']);
  let page = pageOf(NOT, got); assert.deepEqual([page.ok, page.orders[0].model.phase, page.orders[0].model.settled], [true, 'not_applied', false]);
  // RETURNED (the stage's name): the record is gone and nothing stands at the city → the read says NOTHING. Not "returned", not "settled".
  ({ got, code } = await read(NOT, stage(NOT, 'returned'))); assert.equal(code, null);
  assert.deepEqual([got.table, got.orders, got.siege], ['present', [], null]);
  assert.doesNotMatch(JSON.stringify(got), NEVER);
  page = pageOf(NOT, got); assert.deepEqual([page.ok, page.orders.length, page.city], [true, 0, null]);
  // the card for that answer: the "no record" sentence, which says it proves nothing
  setLang('en');
  try {
    const view = String(hand.localConquestView({ localPlay: { conquestWorld: { free_city: CITY } } }, { phase: 'resident' },
      { state: { status: 'idle', busy: false }, spent: false, other: false, order: null, city: page.city, read: { status: 'read', busy: false, error: null, contextSlot: page.contextSlot, table: page.table, standing: { p: '129', q: '0' }, orders: page.orders, city: page.city } }));
    assert.match(view, /hold no reservation of yours for this city right now/); assert.match(view, /does not tell whether a siege started, a return completed, or nothing was reserved/);
    assert.doesNotMatch(view, /Deposit: returned|released\.|data-siege-city|data-siege-order/);
  } finally { setLang('ja'); }
});

test('negatives on the real bytes: "owned" needs every tie the program makes; a mismatch refuses the whole read, never a weaker claim', async () => {
  const cap = stage(CAP, 'captured'), due = stage(CAP, 'capture_due'), applied = stage(CAP, 'reservation_applied'), pending = stage(CAP, 'reservation_pending');
  const refused = async (opts, s = cap) => { const r = await read(CAP, s, opts); assert.deepEqual([r.code, r.got], ['ConquestPrepareScopeMismatch', null], JSON.stringify(Object.keys(opts.alter ?? opts.accounts ?? {}))); };
  const SITE = 296 + 1 * 64, SLOT2 = 168 + 6;   // (Province SITE_MIRROR of site 1; Citizen HOLDING ref of inventory slot 2)
  // the Province's mirror of the site: not a Holding (still the Free City), another generation, another slot order, another faction
  await refused({ alter: { province: b => { b[SITE] = 5; } } });
  await refused({ alter: { province: b => { b[SITE] = 0; } } });
  await refused({ alter: { province: b => { b[SITE + 4] = 2; } } });
  await refused({ alter: { province: b => { b[SITE + 2] = 3; } } });
  await refused({ alter: { province: b => { b[SITE + 1] = 1; } } });
  // the Citizen: slot 2 not bound wide (empty / a legacy holding), the wide mark or its base bit still set, a ticket naming slot 2, another faction
  await refused({ alter: { citizen: b => { b[SLOT2 + 5] = 255; } } });
  await refused({ alter: { citizen: b => { b[SLOT2 + 4] = 3; b[SLOT2 + 5] = 1; } } });
  for (const bits of [0x10, 0x04, 0x14, 0x02]) await refused({ alter: { citizen: b => { b[187] = bits; } } });
  await refused({ alter: { citizen: b => { b[136] = 1; } } });
  // the Holding: another faction than the mirror's; another place written in its bytes; a foreign owner program; an executable account
  await refused({ alter: { holding: b => { b[112] = 1; } } });
  await refused({ alter: { holding: b => { b[68] = 2; } } });
  await refused({ accounts: { target_holding: { ...cap.target_holding, owner: CAP.season } } });
  await refused({ accounts: { target_holding: { ...cap.target_holding, executable: true } } });
  // a Holding account AND an entry at the site at once (the Holding of `captured` with the table of `capture_due`): refused, in whatever state the Holding is
  await refused({ accounts: { target_holding: cap.target_holding } }, due);
  await refused({ accounts: { target_holding: cap.target_holding }, alter: { holding: b => { b[71] = 3; } } }, due);
  // an entry of this wallet that its own Citizen does not bear out: no reservation mark, the slot not empty, a ticket naming the slot
  for (const s of [applied, due]) {
    await refused({ alter: { citizen: b => { b[187] = 0; } } }, s); await refused({ alter: { citizen: b => { b[187] = 0x10; } } }, s);
    await refused({ alter: { citizen: b => { b[187] = 0x14 | 0x02; } } }, s);
    await refused({ accounts: { citizen: cap.citizen } }, s);                                   // (the Citizen as it is AFTER the capture: slot bound wide, marks gone)
  }
  // a record of this wallet still holding its slot: the same invariant
  await refused({ alter: { citizen: b => { b[187] = 0; } } }, pending); await refused({ alter: { citizen: b => { b[187] = 0x14 | 0x02; } } }, pending);
  // stages mixed in one answer are refused: the applied table with the pending Province, the captured Citizen with the pending table
  await refused({ accounts: { province: pending.province } }, applied); await refused({ accounts: { citizen: cap.citizen } }, pending);
  // NOT refusals, and NOT "owned": a RELEASED Holding is not held → nothing is said; a Holding of another Citizen → "another player's", never "yours"
  let r = await read(CAP, cap, { alter: { holding: b => { b[71] = 3; } } });
  assert.deepEqual([r.code, r.got.siege], [null, null], 'a released Holding: neither owned nor lost — nothing');
  r = await read(CAP, cap, { alter: { holding: b => { b[72] ^= 1; } } });
  assert.deepEqual([r.code, r.got.siege], [null, { state: 'other', site: 1, what: 'holding' }]);
  // an entry of another Citizen: said by its kind, with none of its numbers; this wallet's Citizen is not even asked to bear it out
  for (const [s, what] of [[applied, 'siege'], [due, 'capture_due']]) {
    const E0 = 128 + 1 * 128;
    // (another Citizen's entry, consistently: its Citizen bytes, its actor tag, and the Province's record of the site, which carries that tag)
    r = await read(CAP, s, { alter: { table: b => { b[E0 + 16] ^= 1; b[E0 + 104] ^= 1; }, province: b => { b[4096 + 32 * 1 + 16] ^= 1; }, citizen: b => { b[187] = 0; } } });
    assert.deepEqual([r.code, r.got.siege], [null, { state: 'other', site: 1, what }], what);
  }
  // the city asked about is the capability's: with another site as the city, this wallet's siege at site 1 is not that city's state
  // (the Holding position asked is site 2's, another address; no entry stands at site 2, so nothing is said — the siege at site 1 is not shown as site 2's)
  r = await read(CAP, applied, { city: { p: '129', q: '0', site: 2, tile: 25 } });
  assert.deepEqual([r.code, r.got.siege], [null, null]); assert.notEqual(r.calls[0].at[3], applied.target_holding.address); assert.deepEqual(r.calls[0].at.slice(0, 3), [applied.conquest_table.address, applied.province.address, applied.citizen.address]);
  // without a city (no capability): three accounts, no city state at all
  const three = createConquestOrdersRead({ cfg: cfgOf(CAP), city: null, historicalTableV1: true, rpc: async (m, p) => { assert.equal(p[0].length, 3); return { result: { context: { slot: applied.slot }, value: [rpcValue(applied.conquest_table), rpcValue(applied.province), rpcValue(applied.citizen)] } }; } });
  assert.equal((await three.read({ schema: CONQUEST_ORDERS_REQUEST_SCHEMA, source_request: source(CAP) })).siege, null);
});

test('this is evidence about the read, not an opening', () => {
  assert.deepEqual(CONQUEST_OPEN_CONDITIONS, { dispatchPublished: true, addressVectorsVerified: true, heapConfirmed: false, pageBinding: false });
});
