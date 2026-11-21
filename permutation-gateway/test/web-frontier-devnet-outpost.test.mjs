// devnet-page-outpost: the page's SECOND/THIRD village (FileOutpost) on the devnet play path — the page's lane
// (flocalplay-act.mjs, fdevnet-outpost.mjs) joined, in this process, to the gateway's devnet flow (devnet-play-act.mjs):
// what the page builds and its wallet signs is what the gateway rebuilds for the ONE signer, reads the accounts of
// (the Citizen, the anchor home by its own bytes, the target Province) and forwards once. Local play never carries it.
// A KEY-USING test (scripts/ci/node-key-tests.txt): the wallet is the game's own memory-only test wallet, made here and
// never printed or stored. The RPC is a stand-in: no process, no chain, no network, no devnet.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { submitLocalAct, localActIntentOf, localActMessage as pageMessage, devnetLane, LOCAL_LANE, LOCAL_ACT_PRESEND_REFUSALS,
  DEVNET_ACT_CONTEXT_PATH, DEVNET_ACT_SUBMIT_PATH, DEVNET_ACT_STATUS_PATH } from '../../permutation-server/web/frontier/flocalplay-act.mjs';
import { readDevnetPlay, devnetIdentityOf, devnetOutpostOn } from '../../permutation-server/web/frontier/fdevnetplay.mjs';
import { OUTPOST_ACT, OUTPOST_HOLDING_BYTES, outpostIntent, outpostCost, solText, anchorKeyOf } from '../../permutation-server/web/frontier/fdevnet-outpost.mjs';
import { createEphemeralWallet } from '../../permutation-server/web/frontier/fephemeral-wallet.mjs';
import { seasonAddresses, hostId } from '../../permutation-server/web/frontier/faddr.mjs';
import { decode, encode } from '../../permutation-server/web/sdk/base58.mjs';
import { parseTransaction } from '../../permutation-server/web/sdk/solana-tx.mjs';
import { decodeIxData, layoutOf } from '../../permutation-server/web/sdk/frontier/codec.mjs';
import { rulesetFor } from '../../permutation-server/web/sdk/frontier/profile.mjs';
import { createDevnetPlayAct, DEVNET_ACT_COMMANDS, DEVNET_OUTPOST_CONTEXT_SCHEMA } from '../src/frontier/devnet-play-act.mjs';
import { LocalActError, LOCAL_ACT_PRESEND_REFUSALS as GW_PRESEND, localActSubmit } from '../src/frontier/local-play-act.mjs';

const W = await createEphemeralWallet({ cluster: 'localnet', hostname: '127.0.0.1', localPlay: true });   // (a test wallet; only its key signs)
const PROGRAM = encode(new Uint8Array(32).fill(0x61)), SEASON_ID = '1', A = seasonAddresses(PROGRAM, SEASON_ID);
// (the S1 ruleset hash — profile 3, the v2 ABI that has FileOutpost — as the devnet playable season states it)
const HASH = rulesetFor(3), BLOCKHASH = encode(new Uint8Array(32).fill(9)), ORIGIN = 'http://127.0.0.1:41615';
const CITIZEN_AT = A.of('Citizen', { wallet: W.address });
const HOME = { p: 128, q: -60, site: 3 }, GEN = 1, TARGET = { p: 127, q: -60, site: 0 };
const cfg = { cluster: 'devnet', rpc: 'https://rpc.devnet.example', programId: PROGRAM, seasonId: SEASON_ID, devnetPlay: true, devnetPlayRulesetHash: HASH };
const PIN = { cluster: 'devnet', programId: PROGRAM, seasonId: SEASON_ID, addresses: { season: A.season } };
const LANE = devnetLane(SEASON_ID, { extra: [OUTPOST_ACT] });
const SIGNER = Object.freeze({ address: W.address, destroyed: false });
const IDENTITY = devnetIdentityOf({ programId: PROGRAM, seasonAddress: A.season }, W.address);
const H = Object.fromEntries(layoutOf('Holding', 2).fields.map(f => [f.name, f.off]));
function citizenBytes() { const b = new Uint8Array(384), v = new DataView(b.buffer); b.set(Buffer.from('PSF1CITZ'), 0); v.setBigUint64(8, 1n, true); v.setUint16(16, 2, true); b.set(decode(W.address), 64); b.set(decode(CITIZEN_AT).subarray(0, 8), 208); return b; }
function holdingBytes({ h = HOME, gen = GEN, order = 1, owner = CITIZEN_AT } = {}) {
  const b = new Uint8Array(1280), v = new DataView(b.buffer); b.set(Buffer.from('PSF1HOLD'), 0); v.setBigUint64(8, 1n, true);
  v.setInt16(H.P, h.p, true); v.setInt16(H.Q, h.q, true); b[H.SITE] = h.site; b[H.GEN] = gen; b[H.STATE] = 2; b.set(decode(owner), H.OWNER_CITIZEN); b[H.ORDER] = order; return b;
}
const row = bytes => (bytes === null ? null : { owner: PROGRAM, executable: false, lamports: 1, data: [Buffer.from(bytes).toString('base64'), 'base64'] });
const sign = async wire => {
  const account = (await W.wallet.features['standard:connect'].connect()).accounts[0];
  const [out] = await W.wallet.features['solana:signTransaction'].signTransaction({ account, transaction: wire });
  return out.signedTransaction;
};
const HOLDING_AT = A.of('Holding', HOME), PROVINCE_AT = A.of('Province', TARGET);
function joined({ holding = row(holdingBytes()), province = row(new Uint8Array(64)) } = {}) {
  const rpc = [], sent = [], asked = [];
  const flow = createDevnetPlayAct({ cfg, rpc: async (method, params) => {
    rpc.push(method);
    if (method === 'getLatestBlockhash') return { result: { context: { slot: 90 }, value: { blockhash: BLOCKHASH, lastValidBlockHeight: 300 } } };
    if (method === 'getMinimumBalanceForRentExemption') return { result: (params[0] + 128) * 5080 };
    if (method === 'getMultipleAccounts') { asked.push(params[0]); return { result: { context: { slot: 91 }, value: params[0].map(a => (a === CITIZEN_AT ? row(citizenBytes()) : a === HOLDING_AT ? holding : a === PROVINCE_AT ? province : null)) } }; }
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
// (the controller's order, as `cq-outpost` / the outpost card make it: the page's holding objects)
const order = (target = TARGET, anchor = { ...HOME, gen: GEN, order: 1, state: 2 }) => ({ name: OUTPOST_ACT, v: { sites: [target], anchor, slot2: anchor },
  fields: { sites: [target], anchor_site_key: hostId({ ...anchor, seq: 0 }) } });

test('the gateway lists FileOutpost; the page takes it into its devnet lane only when listed (an older gateway keeps devnet play on without it)', async () => {
  assert.ok(DEVNET_ACT_COMMANDS.includes(OUTPOST_ACT));
  const h = joined(), info = h.flow.info();
  assert.deepEqual(info.outpost, { commands: [OUTPOST_ACT], settle: 'keeper', holding_bytes: OUTPOST_HOLDING_BYTES });
  const dp = await readDevnetPlay({ origin: ORIGIN, pin: PIN, rulesetHash: HASH, post: h.post });
  assert.equal(devnetOutpostOn(dp), true); assert.ok(dp.lane.names.includes(OUTPOST_ACT));
  const old = await readDevnetPlay({ origin: ORIGIN, pin: PIN, rulesetHash: HASH, post: async () => ({ ...info, commands: info.commands.filter(n => n !== OUTPOST_ACT) }) });
  assert.ok(old, 'devnet play stays on'); assert.equal(devnetOutpostOn(old), false); assert.ok(!old.lane.names.includes(OUTPOST_ACT));
  assert.equal(OUTPOST_HOLDING_BYTES, layoutOf('Holding', 2).size, 'the escrowed account is the Holding');
});

test('FileOutpost: one wallet signature, wallet as fee payer, rebuilt byte for byte; the gateway reads the Citizen, the anchor home and the target Province; ONE send', async () => {
  const h = joined();
  const o = order();
  const r = await submitLocalAct(o, h.deps());
  assert.equal(r.ok, true, r.code); assert.equal(r.feePayer, W.address);
  assert.deepEqual(h.rpc, ['getLatestBlockhash', 'getMultipleAccounts', 'sendTransaction']); assert.equal(h.sent.length, 1);
  assert.deepEqual(h.asked[0], [CITIZEN_AT, HOLDING_AT, PROVINCE_AT]);
  const tx = parseTransaction(Buffer.from(h.sent[0], 'base64'));
  assert.deepEqual(tx.signers, [W.address]);
  const intent = localActIntentOf(o.name, o.v, o.fields, W.address);
  assert.deepEqual(intent.subject, { holding: HOME, gen: GEN, slot2: null, sites: [TARGET] });
  assert.equal(intent.fields.anchor_site_key, anchorKeyOf(HOME, GEN));
  assert.deepEqual([...tx.message], [...pageMessage(intent, IDENTITY, HASH, BLOCKHASH, LANE)]);
  const ix = tx.instructions.find(i => i.programId === PROGRAM);
  const d = decodeIxData(ix.data, 2);
  assert.equal(d.name, OUTPOST_ACT); assert.deepEqual(d.sites, [TARGET]); assert.equal(BigInt(d.anchor_site_key), hostId({ ...HOME, gen: GEN, seq: 0 }));
  for (const a of [A.season, CITIZEN_AT, HOLDING_AT, PROVINCE_AT, A.of('Province', HOME), A.of('Frontier')]) assert.ok(tx.accountKeys.includes(a), a);
  assert.ok(!tx.accountKeys.includes(seasonAddresses(PROGRAM, '11').season), 'the devnet Season, never local play\'s 11');
});

test('refused before any send: an absent Province (not opened yet), another generation, not the first home, another\'s village; the page says "not sent"', async () => {
  assert.ok(GW_PRESEND.includes('LocalActProvinceAbsent') && LOCAL_ACT_PRESEND_REFUSALS.includes('LocalActProvinceAbsent'), 'both sides: a pre-send refusal');
  for (const [over, code] of [[{ province: null }, 'LocalActProvinceAbsent'], [{ province: { ...row(new Uint8Array(8)), owner: encode(new Uint8Array(32).fill(7)) } }, 'LocalActProvinceAbsent'],
    [{ holding: row(holdingBytes({ gen: 2 })) }, 'LocalActHolding'], [{ holding: row(holdingBytes({ order: 2 })) }, 'LocalActHolding'],
    [{ holding: row(holdingBytes({ owner: encode(new Uint8Array(32).fill(5)) })) }, 'LocalActNotYourVillage'], [{ holding: null }, 'LocalActHolding']]) {
    const h = joined(over);
    const r = await submitLocalAct(order(), h.deps());
    assert.equal(r.ok, false, code); assert.equal(r.code, code, JSON.stringify(r) + h.rpc.join()); assert.equal(h.sent.length, 0, `${code}: nothing sent`);
  }
});

test('the page refuses to build a FileOutpost the rule cannot take: in the heartland, out of range, a wrong anchor key, a wide target; and local play never carries it', async () => {
  const h = joined();
  for (const [o, code] of [[order({ p: 3, q: 0, site: 0 }, { p: 2, q: 0, site: 1, gen: 1 }), 'LocalActShape'], [order({ p: 124, q: -60, site: 0 }), 'LocalActShape'],
    [{ ...order(), fields: { sites: [TARGET], anchor_site_key: hostId({ ...HOME, gen: 9, seq: 0 }) } }, 'LocalActShape'], [order({ p: 129, q: -60, site: 0 }), 'LocalActWideHolding'], [order({ p: 128, q: -60, site: 0 }), 'LocalActShape']]) {
    const r = await submitLocalAct(o, h.deps());
    assert.equal(r.ok, false); assert.equal(r.code, code, JSON.stringify(o.v.sites));
  }
  assert.equal(h.posts.length, 0, 'nothing asked, nothing sent');
  // an older devnet lane (the gateway did not list it), and local play's lane: not carried
  for (const lane of [devnetLane(SEASON_ID), LOCAL_LANE]) {
    const r = await submitLocalAct(order(), h.deps({ lane, identity: () => ({ ...IDENTITY, cluster: lane.cluster }) }));
    assert.equal(r.code, 'LocalActNotAllowed');
  }
  // the gateway's local-play core without the devnet flow's word: refused as a command local play does not send
  let body = null;
  const r = await submitLocalAct(order(), h.deps({ post: async (o2, p, b) => { if (p === DEVNET_ACT_SUBMIT_PATH) { body = b; throw Object.assign(new Error('x'), { code: 'LocalActBusy', refused: true, status: 429 }); } return h.post(o2, p, b); } }));
  assert.equal(r.code, 'LocalActBusy');
  const pins = { program: PROGRAM, season: A.season, seasonId: SEASON_ID, wallet: W.address, rulesetHash: HASH };
  assert.throws(() => localActSubmit({ ...body, schema: 'frontier-devnet-play-act-submit-v1' }, pins, { schema: 'frontier-devnet-play-act-submit-v1' }), e => e.code === 'LocalActNotAllowed');
  assert.ok(localActSubmit(body, pins, { schema: 'frontier-devnet-play-act-submit-v1', outpost: true }).intent.name === OUTPOST_ACT);
});

test('the outpost context names the cluster\'s Holding rent; the preview\'s cost is that deposit plus one signature\'s fee, said in SOL', async () => {
  const h = joined();
  const ctx = await h.flow.context({ schema: DEVNET_OUTPOST_CONTEXT_SCHEMA, wallet: W.address });
  assert.equal(ctx.wallet, W.address); assert.equal(ctx.holding_rent, String((1280 + 128) * 5080)); assert.equal(ctx.blockhash.hash, BLOCKHASH);
  assert.deepEqual(h.rpc, ['getLatestBlockhash', 'getMinimumBalanceForRentExemption']);
  const c = outpostCost({ holdingRent: ctx.holding_rent });
  assert.equal(c.deposit, 7152640n); assert.equal(c.fee, 5000n); assert.equal(c.total, 7157640n);
  assert.equal(solText(c.total), '0.00715764');
  assert.equal(outpostCost({ holdingRent: 7152640n, escrow: 7152640n }).total, 5000n, 'escrow already held: the fee only');
  // (verify-pr141: the program's escrow_need is one rent for the ticket PLUS one per capture reservation — slots bits 2, 3)
  assert.equal(outpostCost({ holdingRent: 7152640n, escrow: 7152640n, slots: 0x04 }).deposit, 7152640n, 'one reservation held: one more rent');
  assert.equal(outpostCost({ holdingRent: 100n, escrow: 0n, slots: 0x0c | 0x01 }).deposit, 300n, 'two reservations, the ticket bits ignored');
  assert.equal(solText(1_500_000_000n), '1.5'); assert.equal(solText(0n), '0');
  // the intent check itself: exact keys only
  assert.throws(() => outpostIntent({ holding: HOME, gen: 1, slot2: null, sites: [TARGET], extra: 1 }, { sites: [TARGET], anchor_site_key: anchorKeyOf(HOME, 1) }), /LocalActInvalid/);
});
