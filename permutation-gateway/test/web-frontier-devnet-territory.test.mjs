// devnet-territory-dev (owner NWP-2, 2026-11-24 19:28: the new world only once territory is playable on devnet — "the
// devnet page can send claims"): the single-tile claim (WideClaimTile 0xDA op 7, TERRITORY_CLAIM) on the devnet play
// path — the page's lane (flocalplay-act.mjs, flocalplay-territory.mjs, fdevnet-territory.mjs) joined, in this process,
// to the gateway's devnet flow (devnet-play-act.mjs): what the page builds and its wallet signs is what the gateway
// rebuilds for the ONE signer, reads the accounts of (the Citizen, the paying first home by its own bytes, the target's
// wide province) and forwards once. Its context names the cluster's rent of the two territory records the claim may create
// from the wallet (owner TQ-12 (a): the claimer pays) and the claimer's tiles (the ore price of the next tile).
// A KEY-USING test (scripts/ci/node-key-tests.txt): the wallet is the game's own memory-only test wallet, made here and
// never printed or stored. The RPC is a stand-in: no process, no chain, no network, no devnet.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { submitLocalAct, localActIntentOf, localActMessage as pageMessage, devnetLane, LOCAL_ACT_PRESEND_REFUSALS,
  DEVNET_ACT_CONTEXT_PATH, DEVNET_ACT_SUBMIT_PATH, DEVNET_ACT_STATUS_PATH, DEVNET_ACT_OPTIONAL } from '../../permutation-server/web/frontier/flocalplay-act.mjs';
import { readDevnetPlay, devnetIdentityOf, devnetTerritoryOn, devnetWideVillageOn } from '../../permutation-server/web/frontier/fdevnetplay.mjs';
import { TERRITORY_CLAIM, TERRITORY_PROVINCE_BYTES, TERRITORY_PLAYER_BYTES, territoryProvinceAddress, territoryPlayerAddress, claimCostV1 } from '../../permutation-server/web/frontier/flocalplay-territory.mjs';
import { TERRITORY_CONTEXT_SCHEMA, TILE_FEE, TILE_PREVIEW_MS, tileContextOk, tileClaimCost, tileContextRefusal, tilePreviewFresh } from '../../permutation-server/web/frontier/fdevnet-territory.mjs';
import { wideProvinceAddress } from '../../permutation-server/web/frontier/flocalplay-wide.mjs';
import { solText } from '../../permutation-server/web/frontier/fdevnet-outpost.mjs';
import { createEphemeralWallet } from '../../permutation-server/web/frontier/fephemeral-wallet.mjs';
import { seasonAddresses } from '../../permutation-server/web/frontier/faddr.mjs';
import { decode, encode } from '../../permutation-server/web/sdk/base58.mjs';
import { parseTransaction } from '../../permutation-server/web/sdk/solana-tx.mjs';
import { layoutOf } from '../../permutation-server/web/sdk/frontier/codec.mjs';
import { rulesetFor } from '../../permutation-server/web/sdk/frontier/profile.mjs';
import { createDevnetPlayAct, DEVNET_ACT_COMMANDS, DEVNET_TERRITORY_CONTEXT_SCHEMA } from '../src/frontier/devnet-play-act.mjs';
import { LocalActError, LOCAL_ACT_PRESEND_REFUSALS as GW_PRESEND } from '../src/frontier/local-play-act.mjs';

const W = await createEphemeralWallet({ cluster: 'localnet', hostname: '127.0.0.1', localPlay: true });   // (a test wallet; only its key signs)
const PROGRAM = encode(new Uint8Array(32).fill(0x61)), SEASON_ID = '3', A = seasonAddresses(PROGRAM, SEASON_ID);
const HASH = rulesetFor(3), BLOCKHASH = encode(new Uint8Array(32).fill(9)), ORIGIN = 'http://127.0.0.1:41616';
const CITIZEN_AT = A.of('Citizen', { wallet: W.address });
const HOME = { p: 128, q: -60, site: 3 }, TARGET = { p: '130', q: '-60' }, TILE = 17;
const cfg = { cluster: 'devnet', rpc: 'https://rpc.devnet.example', programId: PROGRAM, seasonId: SEASON_ID, devnetPlay: true, devnetPlayRulesetHash: HASH };
const PIN = { cluster: 'devnet', programId: PROGRAM, seasonId: SEASON_ID, addresses: { season: A.season } };
const LANE = devnetLane(SEASON_ID, { extra: [TERRITORY_CLAIM] });
const SIGNER = Object.freeze({ address: W.address, destroyed: false });
const IDENTITY = devnetIdentityOf({ programId: PROGRAM, seasonAddress: A.season }, W.address);
const H = Object.fromEntries(layoutOf('Holding', 2).fields.map(f => [f.name, f.off]));
const HOLDING_AT = A.of('Holding', HOME), WIDE_AT = wideProvinceAddress(A.season, PROGRAM, TARGET.p, TARGET.q);
const TPROV_AT = territoryProvinceAddress(A.season, PROGRAM, TARGET.p, TARGET.q), TPLAYER_AT = territoryPlayerAddress(A.season, PROGRAM, CITIZEN_AT);
function citizenBytes() { const b = new Uint8Array(384), v = new DataView(b.buffer); b.set(Buffer.from('PSF1CITZ'), 0); v.setBigUint64(8, 3n, true); v.setUint16(16, 2, true); b.set(decode(W.address), 64); b.set(decode(CITIZEN_AT).subarray(0, 8), 208); return b; }
function holdingBytes({ h = HOME, owner = CITIZEN_AT } = {}) {
  const b = new Uint8Array(1280), v = new DataView(b.buffer); b.set(Buffer.from('PSF1HOLD'), 0); v.setBigUint64(8, 3n, true);
  v.setInt16(H.P, h.p, true); v.setInt16(H.Q, h.q, true); b[H.SITE] = h.site; b[H.GEN] = 1; b[H.STATE] = 2; b.set(decode(owner), H.OWNER_CITIZEN); b[H.ORDER] = 1; return b;
}
/** A territory summary (320 B, 'PSFXWTU1'): `tiles` at 92, unpaid flag at 19 (flocalplay-territory.mjs decodeTerritoryPlayer). */
function summaryBytes({ tiles = 0, unpaid = false } = {}) { const b = new Uint8Array(TERRITORY_PLAYER_BYTES), v = new DataView(b.buffer); b.set(Buffer.from('PSFXWTU1'), 0); b[19] = unpaid ? 1 : 0; v.setUint32(92, tiles, true); return b; }
const row = (bytes, owner = PROGRAM) => (bytes === null ? null : { owner, executable: false, lamports: 1, data: [Buffer.from(bytes).toString('base64'), 'base64'] });
const sign = async wire => {
  const account = (await W.wallet.features['standard:connect'].connect()).accounts[0];
  const [out] = await W.wallet.features['solana:signTransaction'].signTransaction({ account, transaction: wire });
  return out.signedTransaction;
};
function joined({ holding = row(holdingBytes()), wide = row(new Uint8Array(64)), tprov = null, tplayer = null } = {}) {
  const rpc = [], sent = [], asked = [];
  const flow = createDevnetPlayAct({ cfg, rpc: async (method, params) => {
    rpc.push(method);
    if (method === 'getLatestBlockhash') return { result: { context: { slot: 90 }, value: { blockhash: BLOCKHASH, lastValidBlockHeight: 300 } } };
    if (method === 'getMinimumBalanceForRentExemption') return { result: (params[0] + 128) * 5080 };
    if (method === 'getMultipleAccounts') {
      asked.push(params[0]);
      return { result: { context: { slot: 91 }, value: params[0].map(a => (a === CITIZEN_AT ? row(citizenBytes()) : a === HOLDING_AT ? holding : a === WIDE_AT ? wide : a === TPROV_AT ? tprov : a === TPLAYER_AT ? tplayer : null)) } };
    }
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
// (the controller's order, as the card's 「署名して取る」 makes it)
const order = (v = {}) => ({ name: TERRITORY_CLAIM, v: { holding: HOME, target: TARGET, ...v }, fields: { tile: TILE } });

test('the gateway lists the tile claim; the page takes it into its devnet lane only when listed (an older gateway: no tiles)', async () => {
  assert.ok(DEVNET_ACT_COMMANDS.includes(TERRITORY_CLAIM));
  assert.ok(DEVNET_ACT_OPTIONAL.includes(TERRITORY_CLAIM), 'optional on the page: a world without territory keeps its lane');
  const h = joined(), info = h.flow.info();
  assert.deepEqual(info.territory, { commands: [TERRITORY_CLAIM], province_bytes: 672, player_bytes: 320, upkeep: 'keeper' });
  const dp = await readDevnetPlay({ origin: ORIGIN, pin: PIN, rulesetHash: HASH, post: h.post });
  assert.equal(devnetTerritoryOn(dp), true); assert.equal(devnetWideVillageOn(dp), true);
  const old = await readDevnetPlay({ origin: ORIGIN, pin: PIN, rulesetHash: HASH, post: async () => ({ ...info, commands: info.commands.filter(n => n !== TERRITORY_CLAIM) }) });
  assert.ok(old, 'devnet play stays on'); assert.equal(devnetTerritoryOn(old), false); assert.ok(!old.lane.names.includes(TERRITORY_CLAIM));
  assert.equal(TERRITORY_PROVINCE_BYTES, 672, 'frontier-abi territory_province::SIZE');
  assert.equal(TERRITORY_PLAYER_BYTES, 320, 'frontier-abi territory_player::SIZE');
});

test('the claim: one wallet signature, wallet as fee payer, the 0xDA op 7 bytes, rebuilt byte for byte; the gateway reads the Citizen, the first home and the target\'s wide province; ONE send', async () => {
  for (const v of [{}, { witness: { kind: 'nation', p: '131', q: '-62' } }, { village: { p: '131', q: '-61', site: 2 } }]) {
    const h = joined();
    const o = order(v);
    const r = await submitLocalAct(o, h.deps());
    assert.equal(r.ok, true, `${JSON.stringify(v)}: ${r.code}`); assert.equal(r.feePayer, W.address);
    assert.deepEqual(h.rpc, ['getLatestBlockhash', 'getMultipleAccounts', 'sendTransaction']); assert.equal(h.sent.length, 1);
    assert.deepEqual(h.asked[0], [CITIZEN_AT, HOLDING_AT, WIDE_AT]);
    const tx = parseTransaction(Buffer.from(h.sent[0], 'base64'));
    assert.deepEqual(tx.signers, [W.address]);
    const intent = localActIntentOf(o.name, o.v, o.fields, W.address);
    assert.deepEqual([...tx.message], [...pageMessage(intent, IDENTITY, HASH, BLOCKHASH, LANE)]);
    const ix = tx.instructions.find(i => i.programId === PROGRAM);
    const d = Buffer.from(ix.data);
    assert.deepEqual([...d.subarray(0, 4)], [0xda, 0xff, 0x01, 0x07]);
    assert.equal(d.readBigInt64LE(4), 130n); assert.equal(d.readBigInt64LE(12), -60n); assert.equal(d[20], TILE);
    assert.equal(d[21], v.witness ? 1 : 0, 'witness byte'); assert.equal(d[22], v.village ? 1 : 0, 'village byte');
    const keys = ix.keys.map(k => k.pubkey);
    assert.deepEqual(keys.slice(0, 10), [W.address, W.address, A.season, CITIZEN_AT, WIDE_AT, TPROV_AT, TPLAYER_AT, HOLDING_AT, A.of('Province', HOME), '11111111111111111111111111111111']);
    assert.equal(keys.length, 10 + (v.witness ? 1 : 0) + (v.village ? 1 : 0));
    assert.ok(!tx.accountKeys.includes(seasonAddresses(PROGRAM, '11').season), 'the devnet Season, never local play\'s 11');
  }
});

test('refused before any send: no first home, another\'s, an absent wide province; replayed bytes; the page says "not sent"', async () => {
  for (const c of ['LocalActHolding', 'LocalActNotYourVillage', 'LocalActProvinceAbsent']) assert.ok(GW_PRESEND.includes(c) && LOCAL_ACT_PRESEND_REFUSALS.includes(c), `both sides: ${c} is a pre-send refusal`);
  for (const [over, code] of [[{ holding: null }, 'LocalActHolding'], [{ holding: row(holdingBytes({ owner: encode(new Uint8Array(32).fill(5)) })) }, 'LocalActNotYourVillage'],
    [{ wide: null }, 'LocalActProvinceAbsent'], [{ wide: row(new Uint8Array(64), encode(new Uint8Array(32).fill(7))) }, 'LocalActProvinceAbsent']]) {
    const h = joined(over);
    const r = await submitLocalAct(order(), h.deps());
    assert.equal(r.ok, false, code); assert.equal(r.code, code, JSON.stringify(r)); assert.equal(h.sent.length, 0, `${code}: nothing sent`);
  }
  // the same signed bytes twice: the replay barrier
  const h = joined();
  let body = null;
  const first = await submitLocalAct(order(), h.deps({ post: async (o2, p, b) => { if (p === DEVNET_ACT_SUBMIT_PATH) body = b; return h.post(o2, p, b); } }));
  assert.equal(first.ok, true);
  await assert.rejects(h.flow.submit(body), e => e.code === 'LocalActMessageUsed');
  assert.equal(h.sent.length, 1, 'never sent twice');
  // a gateway without the claim (an older one): the page does not send it at all
  const h2 = joined();
  const r = await submitLocalAct(order(), h2.deps({ lane: devnetLane(SEASON_ID) }));
  assert.equal(r.code, 'LocalActNotAllowed'); assert.equal(h2.posts.length, 0);
});

test('the territory context: the cluster\'s rent of both records, whether each is there, the tiles and unpaid flag; the preview\'s cost', async () => {
  const rentP = BigInt((TERRITORY_PROVINCE_BYTES + 128) * 5080), rentU = BigInt((TERRITORY_PLAYER_BYTES + 128) * 5080);
  for (const [over, provincePresent, playerPresent, tiles, unpaid] of [[{}, false, false, 0, false],
    [{ tprov: row(new Uint8Array(672)) }, true, false, 0, false],
    [{ tprov: row(new Uint8Array(672)), tplayer: row(summaryBytes({ tiles: 7 })) }, true, true, 7, false],
    [{ tplayer: row(summaryBytes({ tiles: 3, unpaid: true })) }, false, true, 3, true],
    [{ tplayer: row(summaryBytes({ tiles: 3 }), encode(new Uint8Array(32).fill(4))) }, false, false, 0, false]]) {
    const h = joined(over);
    const ctx = await h.flow.context({ schema: DEVNET_TERRITORY_CONTEXT_SCHEMA, wallet: W.address, target: TARGET });
    assert.equal(ctx.wallet, W.address); assert.equal(ctx.blockhash.hash, BLOCKHASH);
    assert.equal(ctx.province_rent, String(rentP)); assert.equal(ctx.player_rent, String(rentU));
    assert.equal(ctx.province_present, provincePresent); assert.equal(ctx.player_present, playerPresent);
    assert.equal(ctx.tiles, tiles); assert.equal(ctx.unpaid, unpaid); assert.equal(ctx.wide_province_present, true);
    assert.deepEqual(h.asked[0], [TPROV_AT, TPLAYER_AT, WIDE_AT]);
    assert.equal(tileContextOk(ctx, W.address), true);
    const c = tileClaimCost(ctx);
    assert.equal(c.ore, claimCostV1(tiles));
    assert.equal(c.total, (provincePresent ? 0n : rentP) + (playerPresent ? 0n : rentU) + TILE_FEE);
  }
  assert.equal(TERRITORY_CONTEXT_SCHEMA, DEVNET_TERRITORY_CONTEXT_SCHEMA, 'the page asks with the gateway\'s schema');
  // the first tile of a new province at devnet's 5,080: ≈ 0.0041 + 0.0023 SOL + the fee (owner TQ-12 (a), territory-impl §3)
  assert.equal(solText(rentP), '0.004064'); assert.equal(solText(rentU), '0.00227584');
  const h = joined();
  for (const bad of [{ schema: DEVNET_TERRITORY_CONTEXT_SCHEMA, wallet: W.address }, { schema: DEVNET_TERRITORY_CONTEXT_SCHEMA, wallet: W.address, target: { p: '10', q: '0' } },
    { schema: DEVNET_TERRITORY_CONTEXT_SCHEMA, wallet: W.address, target: { p: 130, q: -60 } }, { schema: DEVNET_TERRITORY_CONTEXT_SCHEMA, wallet: 'x', target: TARGET }]) {
    await assert.rejects(h.flow.context(bad), e => e.code === 'LocalActInvalid', JSON.stringify(bad));
  }
  assert.equal(tileContextOk({ wallet: W.address }, W.address), false);
});

test('the page refuses before signing: an absent province, unpaid upkeep, too little ore; a preview is sent only for the same wallet, tile and province, while fresh', () => {
  const base = { wallet: W.address, province_rent: '1', player_rent: '1', province_present: true, player_present: true, wide_province_present: true, tiles: 10, unpaid: false };
  assert.equal(tileContextRefusal(base), null);
  assert.equal(tileContextRefusal({ ...base, wide_province_present: false }), 'LocalActProvinceAbsent');
  assert.equal(tileContextRefusal({ ...base, unpaid: true }), 'TileUnpaid');
  assert.equal(tileContextRefusal(base, { ore: 11 }), 'TileOre', '10 tiles: 10 + 2 % × 10 = 12 ore');
  assert.equal(tileContextRefusal(base, { ore: 12 }), null);
  const pv = { step: 'preview', wallet: W.address, target: { p: '130', q: '-60' }, tile: 17, at: 1_000 };
  assert.equal(tilePreviewFresh(pv, { wallet: W.address, target: TARGET, tile: 17, now: 1_000 + TILE_PREVIEW_MS }), true);
  assert.equal(tilePreviewFresh(pv, { wallet: W.address, target: TARGET, tile: 17, now: 1_001 + TILE_PREVIEW_MS }), false, 'stale');
  assert.equal(tilePreviewFresh(pv, { wallet: W.address, target: TARGET, tile: 18, now: 1_000 }), false, 'another tile');
  assert.equal(tilePreviewFresh(pv, { wallet: W.address, target: { p: '131', q: '-60' }, tile: 17, now: 1_000 }), false, 'another province');
  assert.equal(tilePreviewFresh(pv, { wallet: encode(new Uint8Array(32).fill(2)), target: TARGET, tile: 17, now: 1_000 }), false, 'another wallet');
  assert.equal(tilePreviewFresh(null, { wallet: W.address, target: TARGET, tile: 17 }), false);
});
