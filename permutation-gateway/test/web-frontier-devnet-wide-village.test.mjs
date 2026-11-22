// devnet-p17 (devnet gap P17): a WIDE village's own acts — WideHarvest, WideBuild, WideTrain, WideMuster — on the devnet
// play path: the page's lane (flocalplay-act.mjs, flocalplay-wide-host.mjs, fdevnet-wide-village.mjs) joined, in this
// process, to the gateway's devnet flow (devnet-play-act.mjs): what the page builds and its wallet signs is what the
// gateway rebuilds for the ONE signer, reads the accounts of (the Citizen, the wide holding by its own bytes, its wide
// province) and forwards once. Local play never carries Harvest/Build of a wide village; the devnet lane never WideDepart.
// A KEY-USING test (scripts/ci/node-key-tests.txt): the wallet is the game's own memory-only test wallet, made here and
// never printed or stored. The RPC is a stand-in: no process, no chain, no network, no devnet.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { submitLocalAct, localActIntentOf, localActMessage as pageMessage, devnetLane, LOCAL_LANE, LOCAL_ACT_PRESEND_REFUSALS,
  DEVNET_ACT_CONTEXT_PATH, DEVNET_ACT_SUBMIT_PATH, DEVNET_ACT_STATUS_PATH, localActKey } from '../../permutation-server/web/frontier/flocalplay-act.mjs';
import { readDevnetPlay, devnetIdentityOf, devnetWideVillageOn } from '../../permutation-server/web/frontier/fdevnetplay.mjs';
import { WIDE_VILLAGE_ACTS, WIDE_HARVEST, WIDE_BUILD, WIDE_TRAIN, WIDE_MUSTER, WIDE_DEPART, WIDE_ROSTER_BYTES, wideVillageAccounts, wideHostIntent } from '../../permutation-server/web/frontier/flocalplay-wide-host.mjs';
import { wideVillageCost, wideVillageCheck, wideVillageResult, wideProvinceFacts, wideVillageOf, WIDE_VILLAGE_CONTEXT_SCHEMA } from '../../permutation-server/web/frontier/fdevnet-wide-village.mjs';
import { solText } from '../../permutation-server/web/frontier/fdevnet-outpost.mjs';
import { createEphemeralWallet } from '../../permutation-server/web/frontier/fephemeral-wallet.mjs';
import { seasonAddresses } from '../../permutation-server/web/frontier/faddr.mjs';
import { worldIdOf } from '../../permutation-server/web/frontier/map/wide.mjs';
import { decode, encode } from '../../permutation-server/web/sdk/base58.mjs';
import { parseTransaction } from '../../permutation-server/web/sdk/solana-tx.mjs';
import { rulesetFor } from '../../permutation-server/web/sdk/frontier/profile.mjs';
import { createDevnetPlayAct, DEVNET_ACT_COMMANDS, DEVNET_WIDE_VILLAGE_CONTEXT_SCHEMA, DEVNET_WIDE_HOLDING } from '../src/frontier/devnet-play-act.mjs';
import { LocalActError, LOCAL_ACT_PRESEND_REFUSALS as GW_PRESEND, localActSubmit } from '../src/frontier/local-play-act.mjs';

const W = await createEphemeralWallet({ cluster: 'localnet', hostname: '127.0.0.1', localPlay: true });   // (a test wallet; only its key signs)
const PROGRAM = encode(new Uint8Array(32).fill(0x61)), SEASON_ID = '1', A = seasonAddresses(PROGRAM, SEASON_ID);
const HASH = rulesetFor(3), BLOCKHASH = encode(new Uint8Array(32).fill(9)), ORIGIN = 'http://127.0.0.1:41515';
const CITIZEN_AT = A.of('Citizen', { wallet: W.address });
const WORLD = worldIdOf(A.season, PROGRAM);
const VILLAGE = Object.freeze({ p: '130', q: '-60', site: 2 });
const ACC = wideVillageAccounts({ programId: PROGRAM, seasonId: SEASON_ID, world: WORLD, village: VILLAGE });
const cfg = { cluster: 'devnet', rpc: 'https://rpc.devnet.example', programId: PROGRAM, seasonId: SEASON_ID, devnetPlay: true, devnetPlayRulesetHash: HASH };
const PIN = { cluster: 'devnet', programId: PROGRAM, seasonId: SEASON_ID, addresses: { season: A.season } };
const LANE = devnetLane(SEASON_ID, { extra: [...WIDE_VILLAGE_ACTS] });
const SIGNER = Object.freeze({ address: W.address, destroyed: false });
const IDENTITY = devnetIdentityOf({ programId: PROGRAM, seasonAddress: A.season }, W.address);
function citizenBytes() { const b = new Uint8Array(384), v = new DataView(b.buffer); b.set(Buffer.from('PSF1CITZ'), 0); v.setBigUint64(8, 1n, true); v.setUint16(16, 2, true); b.set(decode(W.address), 64); b.set(decode(CITIZEN_AT).subarray(0, 8), 208); return b; }
function wideHoldingBytes({ owner = CITIZEN_AT, season = 1n, magic = DEVNET_WIDE_HOLDING.MAGIC, size = DEVNET_WIDE_HOLDING.SIZE } = {}) {
  const b = new Uint8Array(size), v = new DataView(b.buffer); b.set(Buffer.from(magic), 0); v.setBigUint64(DEVNET_WIDE_HOLDING.SEASON_ID, season, true);
  b.set(decode(owner), DEVNET_WIDE_HOLDING.OWNER_CITIZEN); return b;
}
const row = (bytes, owner = PROGRAM) => (bytes === null ? null : { owner, executable: false, lamports: 1, data: [Buffer.from(bytes).toString('base64'), 'base64'] });
const sign = async wire => {
  const account = (await W.wallet.features['standard:connect'].connect()).accounts[0];
  const [out] = await W.wallet.features['solana:signTransaction'].signTransaction({ account, transaction: wire });
  return out.signedTransaction;
};
function joined({ holding = row(wideHoldingBytes()), province = row(new Uint8Array(64)), roster = null } = {}) {
  const rpc = [], sent = [], asked = [];
  const flow = createDevnetPlayAct({ cfg, rpc: async (method, params) => {
    rpc.push(method);
    if (method === 'getLatestBlockhash') return { result: { context: { slot: 90 }, value: { blockhash: BLOCKHASH, lastValidBlockHeight: 300 } } };
    if (method === 'getMinimumBalanceForRentExemption') return { result: (params[0] + 128) * 6960 };
    if (method === 'getMultipleAccounts') { asked.push(params[0]); return { result: { context: { slot: 91 }, value: params[0].map(a => (a === CITIZEN_AT ? row(citizenBytes()) : a === ACC.holding ? holding : a === ACC.province ? province : a === ACC.roster ? roster : null)) } }; }
    if (method === 'sendTransaction') { sent.push(params[0]); return { result: encode(Buffer.from(params[0], 'base64').subarray(1, 65)) }; }
    if (method === 'getSignatureStatuses') return { result: { context: { slot: 95 }, value: [{ slot: 93, confirmationStatus: 'confirmed', err: null }] } };
    return { error: { code: -1 } };
  } });
  const posts = [];
  const post = async (origin, path, body) => {
    posts.push([origin, path, body]);
    const step = { [DEVNET_ACT_CONTEXT_PATH]: 'context', [DEVNET_ACT_SUBMIT_PATH]: 'submit', [DEVNET_ACT_STATUS_PATH]: 'status' }[path];
    try { return JSON.parse(JSON.stringify(await flow[step](JSON.parse(JSON.stringify(body))))); }
    catch (e) { if (e instanceof LocalActError) throw Object.assign(new Error('refused'), { code: e.code, refused: true, status: e.status }); throw e; }
  };
  const deps = (over = {}) => ({ allowed: () => ({ ok: true, relay: ORIGIN }), identity: () => IDENTITY, rulesetHash: () => HASH, signer: () => SIGNER, post, lane: LANE, sign, ...over });
  return { flow, rpc, sent, posts, post, deps, asked };
}
// (the controller's order, as the card's 「署名して送る」 makes it: `v.wide` = the village with decimal p/q strings)
const order = (name, fields) => ({ name, v: { wide: VILLAGE }, fields });
const ORDERS = [
  [order(WIDE_HARVEST, {}), [0xda, 0xff, 0x01, 0x03, 0, 0, 0, 0, 0, 0], false],
  [order(WIDE_BUILD, { item: 0 }), [0xda, 0xff, 0x01, 0x03, 1, 0, 0, 0, 0, 0], false],
  [order(WIDE_BUILD, { item: 6 }), [0xda, 0xff, 0x01, 0x03, 1, 6, 0, 0, 0, 0], true],
  [order(WIDE_BUILD, { item: 7 }), [0xda, 0xff, 0x01, 0x03, 1, 7, 0, 0, 0, 0], true],
  [order(WIDE_TRAIN, { unit: 0, n: 300 }), [0xda, 0xff, 0x01, 0x03, 2, 0, 0x2c, 0x01, 0, 0], false],
  [order(WIDE_MUSTER, { unit: 0, troops: 100, tile: 17 }), [0xda, 0xff, 0x01, 0x01, 0, 100, 0, 0, 0, 17], true],
];

test('the gateway lists the four wide village acts; the page takes them into its devnet lane only all four together (never WideDepart)', async () => {
  for (const n of WIDE_VILLAGE_ACTS) assert.ok(DEVNET_ACT_COMMANDS.includes(n), n);
  assert.ok(!DEVNET_ACT_COMMANDS.includes(WIDE_DEPART), 'the devnet build keeps WideDepart closed');
  const h = joined(), info = h.flow.info();
  assert.deepEqual(info.wide_village, { commands: [...WIDE_VILLAGE_ACTS], roster_bytes: WIDE_ROSTER_BYTES, resolve: 'keeper' });
  const dp = await readDevnetPlay({ origin: ORIGIN, pin: PIN, rulesetHash: HASH, post: h.post });
  assert.equal(devnetWideVillageOn(dp), true);
  const old = await readDevnetPlay({ origin: ORIGIN, pin: PIN, rulesetHash: HASH, post: async () => ({ ...info, commands: info.commands.filter(n => !WIDE_VILLAGE_ACTS.includes(n)) }) });
  assert.ok(old, 'devnet play stays on'); assert.equal(devnetWideVillageOn(old), false);
  const half = await readDevnetPlay({ origin: ORIGIN, pin: PIN, rulesetHash: HASH, post: async () => ({ ...info, commands: info.commands.filter(n => n !== WIDE_MUSTER) }) });
  assert.equal(devnetWideVillageOn(half), false); for (const n of WIDE_VILLAGE_ACTS) assert.ok(!half.lane.names.includes(n), `${n}: not taken without all four`);
  assert.equal(WIDE_ROSTER_BYTES, 3248, 'frontier-abi wide_roster::SIZE');
});

test('each act: one wallet signature, wallet as fee payer, the 0xDA bytes of frontier-abi, rebuilt byte for byte; the gateway reads the Citizen, the wide holding and its province; ONE send', async () => {
  for (const [o, data, provinceWritable] of ORDERS) {
    const h = joined();
    const r = await submitLocalAct(o, h.deps());
    assert.equal(r.ok, true, `${o.name}: ${r.code}`); assert.equal(r.feePayer, W.address);
    assert.deepEqual(h.rpc, ['getLatestBlockhash', 'getMultipleAccounts', 'sendTransaction'], o.name); assert.equal(h.sent.length, 1);
    assert.deepEqual(h.asked[0], [CITIZEN_AT, ACC.holding, ACC.province], o.name);
    const tx = parseTransaction(Buffer.from(h.sent[0], 'base64'));
    assert.deepEqual(tx.signers, [W.address]);
    const intent = localActIntentOf(o.name, o.v, o.fields, W.address);
    assert.deepEqual([...tx.message], [...pageMessage(intent, IDENTITY, HASH, BLOCKHASH, LANE)], o.name);
    const ix = tx.instructions.find(i => i.programId === PROGRAM);
    assert.deepEqual([...ix.data], data, `${o.name} ${JSON.stringify(o.fields)}`);
    const keys = ix.keys.map(k => k.pubkey), writable = a => ix.keys.find(k => k.pubkey === a)?.isWritable;
    assert.equal(keys[0], W.address); assert.equal(keys[1], W.address); assert.equal(keys[2], A.season); assert.equal(keys[3], CITIZEN_AT);
    assert.equal(keys[4], ACC.holding); assert.equal(keys[5], ACC.province);
    if (o.name === WIDE_MUSTER) { assert.equal(keys[6], ACC.roster); assert.equal(keys[7], '11111111111111111111111111111111'); assert.equal(keys.length, 8); } else assert.equal(keys.length, 6);
    assert.equal(writable(ACC.province), provinceWritable, `${o.name}: the province ${provinceWritable ? 'writable (ECONOMY_MIRROR / MUSTER)' : 'read-only (ECONOMY)'}`);
    assert.equal(writable(ACC.holding), true);
    assert.ok(!tx.accountKeys.includes(seasonAddresses(PROGRAM, '11').season), 'the devnet Season, never local play\'s 11');
  }
});

test('refused before any send: no wide holding, another\'s, not a wide holding, another Season, an absent province; WideDepart; the page says "not sent"', async () => {
  for (const c of ['LocalActHolding', 'LocalActNotYourVillage', 'LocalActProvinceAbsent']) assert.ok(GW_PRESEND.includes(c) && LOCAL_ACT_PRESEND_REFUSALS.includes(c), `both sides: ${c} is a pre-send refusal`);
  for (const [over, code] of [[{ holding: null }, 'LocalActHolding'], [{ holding: row(wideHoldingBytes(), encode(new Uint8Array(32).fill(7))) }, 'LocalActHolding'],
    [{ holding: row(wideHoldingBytes({ magic: 'PSF1HOLD', size: 1280 })) }, 'LocalActHolding'], [{ holding: row(wideHoldingBytes({ season: 2n })) }, 'LocalActHolding'],
    [{ holding: row(wideHoldingBytes({ owner: encode(new Uint8Array(32).fill(5)) })) }, 'LocalActNotYourVillage'], [{ province: null }, 'LocalActProvinceAbsent']]) {
    for (const [o] of [ORDERS[0], ORDERS[5]]) {
      const h = joined(over);
      const r = await submitLocalAct(o, h.deps());
      assert.equal(r.ok, false, code); assert.equal(r.code, code, `${o.name}: ${JSON.stringify(r)}`); assert.equal(h.sent.length, 0, `${code}: nothing sent`);
    }
  }
  // WideDepart: not in the devnet lane (the page refuses it before asking anything)
  const h = joined();
  const d = await submitLocalAct({ name: WIDE_DEPART, v: { wide: VILLAGE, standing: { p: '130', q: '-60' } }, fields: {} }, h.deps());
  assert.equal(d.code, 'LocalActNotAllowed'); assert.equal(h.posts.length, 0);
});

test('local play never carries a wide village\'s Harvest or Build; the shapes the builder refuses; two villages are two orders', async () => {
  const h = joined();
  for (const lane of [devnetLane(SEASON_ID), LOCAL_LANE]) {
    const r = await submitLocalAct(ORDERS[0][0], h.deps({ lane, identity: () => ({ ...IDENTITY, cluster: lane.cluster }) }));
    assert.equal(r.code, 'LocalActNotAllowed', lane.kind);
  }
  // the gateway's local-play core without the devnet flow's word: WideHarvest/WideBuild refused; WideTrain/WideMuster kept (local play's own)
  let body = null;
  await submitLocalAct(ORDERS[0][0], h.deps({ post: async (o2, p, b) => { if (p === DEVNET_ACT_SUBMIT_PATH) { body = b; throw Object.assign(new Error('x'), { code: 'LocalActBusy', refused: true, status: 429 }); } return h.post(o2, p, b); } }));
  const pins = { program: PROGRAM, season: A.season, seasonId: SEASON_ID, wallet: W.address, rulesetHash: HASH };
  assert.throws(() => localActSubmit(body, pins, { schema: 'frontier-devnet-play-act-submit-v1' }), e => e.code === 'LocalActNotAllowed');
  assert.equal(localActSubmit(body, pins, { schema: 'frontier-devnet-play-act-submit-v1', wideVillage: true }).intent.name, WIDE_HARVEST);
  // shapes
  for (const [name, fields] of [[WIDE_BUILD, { item: 8 }], [WIDE_BUILD, {}], [WIDE_HARVEST, { x: 1 }], [WIDE_TRAIN, { unit: 7, n: 1 }], [WIDE_TRAIN, { unit: 0, n: 0 }], [WIDE_MUSTER, { unit: 0, troops: 100, tile: 61 }]]) {
    assert.throws(() => wideHostIntent(name, { wide: VILLAGE }, fields), /LocalActShape/, `${name} ${JSON.stringify(fields)}`);
  }
  assert.throws(() => wideHostIntent(WIDE_HARVEST, { wide: { p: '100', q: '0', site: 0 } }, {}), /LocalActShape/, 'a legacy coordinate is not a wide village');
  const k1 = localActKey(WIDE_HARVEST, { wide: VILLAGE }, {}), k2 = localActKey(WIDE_HARVEST, { wide: { ...VILLAGE, site: 3 } }, {});
  assert.notEqual(k1, k2);
});

test('the wide village context names the cluster\'s roster rent and whether it is there; the preview\'s cost is the fee, plus that rent on a first muster', async () => {
  for (const [roster, present] of [[null, false], [row(new Uint8Array(WIDE_ROSTER_BYTES)), true], [row(new Uint8Array(8), encode(new Uint8Array(32).fill(3))), false]]) {
    const h = joined({ roster });
    const ctx = await h.flow.context({ schema: DEVNET_WIDE_VILLAGE_CONTEXT_SCHEMA, wallet: W.address, village: VILLAGE });
    assert.equal(ctx.wallet, W.address); assert.equal(ctx.blockhash.hash, BLOCKHASH);
    assert.equal(ctx.roster_rent, String((WIDE_ROSTER_BYTES + 128) * 6960)); assert.equal(ctx.roster_present, present);
    assert.deepEqual(h.rpc, ['getLatestBlockhash', 'getMinimumBalanceForRentExemption', 'getMultipleAccounts']); assert.deepEqual(h.asked[0], [ACC.roster]);
  }
  assert.equal(WIDE_VILLAGE_CONTEXT_SCHEMA, DEVNET_WIDE_VILLAGE_CONTEXT_SCHEMA, 'the page asks with the gateway\'s schema');
  const h = joined();
  for (const bad of [{ schema: DEVNET_WIDE_VILLAGE_CONTEXT_SCHEMA, wallet: W.address }, { schema: DEVNET_WIDE_VILLAGE_CONTEXT_SCHEMA, wallet: W.address, village: { p: '10', q: '0', site: 0 } },
    { schema: DEVNET_WIDE_VILLAGE_CONTEXT_SCHEMA, wallet: W.address, village: { p: 130, q: -60, site: 2 } }]) {
    await assert.rejects(h.flow.context(bad), e => e.code === 'LocalActInvalid', JSON.stringify(bad));
  }
  const rent = BigInt((WIDE_ROSTER_BYTES + 128) * 6960);
  assert.deepEqual({ ...wideVillageCost({ name: WIDE_MUSTER, rosterRent: rent, rosterPresent: false }) }, { deposit: rent, fee: 5000n, total: rent + 5000n });
  assert.equal(wideVillageCost({ name: WIDE_MUSTER, rosterRent: rent, rosterPresent: true }).total, 5000n, 'the roster is there: the fee only');
  for (const n of [WIDE_HARVEST, WIDE_BUILD, WIDE_TRAIN]) assert.equal(wideVillageCost({ name: n, rosterRent: rent, rosterPresent: false }).total, 5000n, `${n}: no lamport moves`);
  assert.equal(solText(rent + 5000n), '0.02350196');
});

test('the page\'s own checks from the captured record, the province\'s passable tiles, and the result read back', () => {
  const economy = (o = {}) => ({ state: 2, tier: 0, walls: '0', lastOwnerAction: '10', reserve: [0, 0, 0, 0, 0, 0, 0, 0], queue: [{ inUse: false }, { inUse: false }],
    stores: [{ resource: 'Food', value: '1000' }, { resource: 'Wood', value: '2000' }], ...o });
  const entry = (o = {}) => ({ status: 'captured-unverified', holding: { p: 130n, q: -60n, site: 2, economy: economy(o) } });
  const pv = new Uint8Array(4736), dv = new DataView(pv.buffer); dv.setUint32(72, 41, true); dv.setBigUint64(264, (1n << 17n) | (1n << 3n), true);
  const province = wideProvinceFacts(pv);
  assert.deepEqual({ ...province, passable: [...province.passable] }, { resolvedNext: 41, passable: [3, 17] });
  assert.equal(wideProvinceFacts(new Uint8Array(10)), null);
  assert.deepEqual({ ...wideVillageOf(entry().holding) }, VILLAGE, 'BigInt coordinates go out as decimal strings');
  const ok = (e, a) => wideVillageCheck(e, a);
  assert.equal(ok(entry(), { name: WIDE_HARVEST }).ok, true);
  assert.equal(ok(entry({ state: 1 }), { name: WIDE_HARVEST }).ok, true, 'a provisional village harvests');
  assert.equal(ok(entry({ state: 3 }), { name: WIDE_HARVEST }).code, 'WideVillageNotLive');
  assert.equal(ok({ status: 'not-captured', holding: null }, { name: WIDE_HARVEST }).code, 'WideVillageUnread');
  assert.equal(ok(entry({ queue: [{ inUse: true }, { inUse: true }] }), { name: WIDE_BUILD, fields: { item: 0 } }).code, 'QueueFull');
  assert.equal(ok(entry(), { name: WIDE_TRAIN, fields: { unit: 0, n: 100 } }).ok, true);
  const muster = { name: WIDE_MUSTER, fields: { unit: 0, troops: 100, tile: 17 }, province, nowBell: 42 };
  assert.equal(ok(entry(), muster).code, 'Insufficient');
  assert.equal(ok(entry({ state: 1, reserve: [500] }), muster).code, 'NotFinal');
  assert.deepEqual([...ok(entry({ reserve: [500] }), muster).warn], []);
  assert.deepEqual([...ok(entry({ reserve: [500] }), { ...muster, nowBell: 50 }).warn], ['WideProvinceLag'], 'a lag is a warning, not a refusal');
  assert.equal(ok(entry({ reserve: [500] }), { ...muster, fields: { unit: 0, troops: 99, tile: 17 } }).code, 'WideVillageTroops');
  assert.equal(ok(entry({ reserve: [500] }), { ...muster, fields: { unit: 0, troops: 100, tile: 4 } }).code, 'WideVillageTile');
  assert.equal(ok(entry({ reserve: [500] }), { ...muster, province: null }).code, 'WideProvinceUnread');
  // the result: the record's own figures, before → after
  const res = wideVillageResult(economy(), economy({ reserve: [100, 0, 0, 0, 0, 0, 0, 0], lastOwnerAction: '20', stores: [{ resource: 'Food', value: '400' }, { resource: 'Wood', value: '2000' }] }));
  assert.equal(res.changed, true); assert.deepEqual(res.reserve, [{ unit: 0, from: 0, to: 100 }]); assert.deepEqual(res.stores, [{ resource: 'Food', from: '1000', to: '400' }]); assert.equal(res.touched, true);
  const b = wideVillageResult(economy(), economy({ queue: [{ inUse: true }, { inUse: false }], walls: '1' }));
  assert.deepEqual(b.queue, { from: 0, to: 1 }); assert.deepEqual(b.walls, { from: 0, to: 1 });
  assert.equal(wideVillageResult(economy(), economy()).changed, false);
});
