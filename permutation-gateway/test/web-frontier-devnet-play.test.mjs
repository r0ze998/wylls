// Devnet gap P1 (B7 client side): the page's devnet play path (permutation-server/web/frontier/fdevnetplay.mjs and the
// devnet lane of flocalplay-act.mjs) joined, in this process, to the gateway's devnet play flow
// (src/frontier/devnet-play-act.mjs): what the page builds, its wallet signs and it posts is what the gateway rebuilds
// for the transaction's ONE signer and forwards once. A KEY-USING test (scripts/ci/node-key-tests.txt): the wallet is the
// game's own memory-only test wallet, made here and never printed or stored. The RPC is a stand-in: no process, no
// chain, no network, no devnet.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { submitLocalAct, localActIntentOf, localActMessage as pageMessage, localOrderRoute, devnetLane, LOCAL_LANE, LOCAL_ACT_NAMES,
  DEVNET_ACT_NAMES, DEVNET_ACT_OPTIONAL, DEVNET_ACT_CONTEXT_PATH, DEVNET_ACT_SUBMIT_PATH, DEVNET_ACT_STATUS_PATH, localActRead } from '../../permutation-server/web/frontier/flocalplay-act.mjs';
import { readDevnetPlay, devnetPlayOf, devnetWide, wideTargetsOf, devnetIdentityOf } from '../../permutation-server/web/frontier/fdevnetplay.mjs';
import { homePlaceOf, homeRingsOf, wideDevnet } from '../../permutation-server/web/frontier/home.mjs';
import { createEphemeralWallet } from '../../permutation-server/web/frontier/fephemeral-wallet.mjs';
import { seasonAddresses } from '../../permutation-server/web/frontier/faddr.mjs';
import { decode, encode } from '../../permutation-server/web/sdk/base58.mjs';
import { parseTransaction } from '../../permutation-server/web/sdk/solana-tx.mjs';
import { createDevnetPlayAct, devnetPlayConfigProblems, DEVNET_ACT_COMMANDS, DEVNET_ACT_ROUTES, DEVNET_ACT_INFO_SCHEMA } from '../src/frontier/devnet-play-act.mjs';
import { devnetPlayRoutes } from '../src/frontier/routes/devnet-play.mjs';
import { LocalActError } from '../src/frontier/local-play-act.mjs';
import { loadFrontierConfig } from '../src/frontier/config.mjs';

const W = await createEphemeralWallet({ cluster: 'localnet', hostname: '127.0.0.1', localPlay: true });   // (a test wallet; its cluster word is local play's — here only its key signs)
const PROGRAM = encode(new Uint8Array(32).fill(0x61)), SEASON_ID = '1', A = seasonAddresses(PROGRAM, SEASON_ID);
const HASH = 'c3'.repeat(32), BLOCKHASH = encode(new Uint8Array(32).fill(9)), ORIGIN = 'http://127.0.0.1:41705';
const CITIZEN_AT = A.of('Citizen', { wallet: W.address });
const RIM = { p: 128, q: -60, site: 3 }, TARGET = { p: '129', q: '-60' };
const cfg = { cluster: 'devnet', rpc: 'https://rpc.devnet.example', programId: PROGRAM, seasonId: SEASON_ID, devnetPlay: true, devnetPlayRulesetHash: HASH };
const PIN = { cluster: 'devnet', programId: PROGRAM, seasonId: SEASON_ID, addresses: { season: A.season } };
const LANE = devnetLane(SEASON_ID);
const SIGNER = Object.freeze({ address: W.address, destroyed: false });   // (one handle per wallet, as the controller keeps it)
const IDENTITY = devnetIdentityOf({ programId: PROGRAM, seasonAddress: A.season }, W.address);
function citizenBytes() { const b = new Uint8Array(384), v = new DataView(b.buffer); b.set(Buffer.from('PSF1CITZ'), 0); v.setBigUint64(8, 1n, true); v.setUint16(16, 2, true); b.set(decode(W.address), 64); b.set(decode(CITIZEN_AT).subarray(0, 8), 208); return b; }
function holdingBytes(h = RIM) { const b = new Uint8Array(1280), v = new DataView(b.buffer); b.set(Buffer.from('PSF1HOLD'), 0); v.setBigUint64(8, 1n, true); v.setInt16(64, h.p, true); v.setInt16(66, h.q, true); b[68] = h.site; b.set(decode(CITIZEN_AT), 72); return b; }
const row = bytes => (bytes === null ? null : { owner: PROGRAM, executable: false, lamports: 1, data: [Buffer.from(bytes).toString('base64'), 'base64'] });
const sign = async wire => {
  const account = (await W.wallet.features['standard:connect'].connect()).accounts[0];
  const [out] = await W.wallet.features['solana:signTransaction'].signTransaction({ account, transaction: wire });
  return out.signedTransaction;
};
/** The gateway's flow over a stand-in RPC, and the page's `post` handing it each request (its refusals as HTTP ones). */
function joined({ citizen = row(citizenBytes()), holding = row(holdingBytes()) } = {}) {
  const rpc = [], sent = [];
  const flow = createDevnetPlayAct({ cfg, rpc: async (method, params) => {
    rpc.push(method);
    if (method === 'getLatestBlockhash') return { result: { context: { slot: 90 }, value: { blockhash: BLOCKHASH, lastValidBlockHeight: 300 } } };
    if (method === 'getMultipleAccounts') return { result: { context: { slot: 91 }, value: params[0].map(a => (a === CITIZEN_AT ? citizen : holding)) } };
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
  return { flow, rpc, sent, posts, post, deps };
}

test('the configuration: off by default; on only for a devnet season over an https RPC (never mainnet or testnet), or the offline TEST form on loopback', () => {
  assert.deepEqual(devnetPlayConfigProblems({ ...cfg, devnetPlay: false }), []);
  assert.deepEqual(devnetPlayConfigProblems(cfg), []);
  const bad = over => devnetPlayConfigProblems({ ...cfg, ...over });
  for (const over of [{ cluster: 'localnet' }, { cluster: 'mainnet-beta' }, { rpc: 'http://rpc.devnet.example' }, { rpc: 'https://api.mainnet-beta.solana.com' }, { rpc: 'https://api.testnet.solana.com' },
    { rpc: 'https://user:pw@rpc.devnet.example' }, { rpc: 'not a url' }, { programId: encode(new Uint8Array(32).fill(0x45)) }, { programId: 'x' }, { seasonId: null }, { devnetPlayRulesetHash: null }, { devnetPlayRulesetHash: 'AB'.repeat(32) },
    { devnetPlayOfflineRpc: true, rpc: 'https://rpc.devnet.example' }, { devnetPlayOfflineRpc: true, rpc: 'http://127.0.0.1:41970' }, { devnetPlayOfflineRpc: true, rpc: 'http://127.0.0.1:8899' }, { devnetPlayOfflineRpc: true, rpc: 'http://10.0.0.1:41700' }]) {
    assert.ok(bad(over).length > 0, JSON.stringify(over));
  }
  assert.deepEqual(bad({ devnetPlayOfflineRpc: true, rpc: 'http://127.0.0.1:41700' }), [], 'the offline TEST form: the in-process localnet on loopback');
  assert.throws(() => createDevnetPlayAct({ cfg: { ...cfg, rpc: 'http://rpc.devnet.example' } }), /https RPC only/);
  // the gateway's flags
  const base = ['--program', PROGRAM, '--season', '1', '--port', '41706', '--public-port', '41707', '--dev', '--pool-size', '1'];
  assert.equal(loadFrontierConfig(base).devnetPlay, false, 'off unless asked');
  const on = loadFrontierConfig([...base, '--cluster', 'devnet', '--rpc', 'https://rpc.devnet.example', '--devnet-play', '--devnet-play-ruleset-hash', HASH]);
  assert.equal(on.devnetPlay, true); assert.equal(on.devnetPlayOfflineRpc, false);
  assert.throws(() => loadFrontierConfig([...base, '--devnet-play', '--devnet-play-ruleset-hash', HASH]), /devnet season only/, 'the default cluster (localnet) is refused');
  assert.throws(() => loadFrontierConfig([...base, '--cluster', 'devnet', '--rpc', 'https://rpc.devnet.example', '--devnet-play-offline-rpc']), /needs --devnet-play/);
});

test('one list and one set of routes on both sides; the wide -> wide host acts are not carried on devnet', () => {
  // (devnet-page-outpost: the gateway also carries the optional FileOutpost; the page takes it only when listed)
  assert.deepEqual([...DEVNET_ACT_NAMES, ...DEVNET_ACT_OPTIONAL], [...DEVNET_ACT_COMMANDS]);
  assert.deepEqual([DEVNET_ACT_CONTEXT_PATH, DEVNET_ACT_SUBMIT_PATH, DEVNET_ACT_STATUS_PATH].map(p => `POST ${p.slice(3)}`), Object.values(DEVNET_ACT_ROUTES));
  for (const n of ['WideTrain', 'WideMuster', 'WideDepart']) { assert.ok(LOCAL_ACT_NAMES.includes(n)); assert.ok(!DEVNET_ACT_NAMES.includes(n), n); }
  // where an order goes on devnet: the lane's commands in their plain form; anything else keeps the ORDINARY path (never refused here)
  const v = { holding: RIM };
  for (const name of DEVNET_ACT_NAMES) assert.equal(localOrderRoute({ localPlay: IDENTITY, name, v, signer: undefined, requester: null, names: LANE.names, otherwise: 'general' }), 'local-act', name);
  for (const name of ['Depart', 'Explore', 'SetSession', 'WideDepart', 'WideTrain']) assert.equal(localOrderRoute({ localPlay: IDENTITY, name, v, signer: undefined, requester: null, names: LANE.names, otherwise: 'general' }), 'general', name);
  assert.equal(localOrderRoute({ localPlay: IDENTITY, name: 'Harvest', v, signer: null, requester: null, names: LANE.names, otherwise: 'general' }), 'general', 'a settle shape keeps the ordinary path');
  // local play is unchanged: its own lane, refusing everything else
  assert.equal(LOCAL_LANE.seasonId, '11'); assert.equal(LOCAL_LANE.cluster, 'localnet');
  assert.equal(localOrderRoute({ localPlay: IDENTITY, name: 'Depart', v, signer: undefined, requester: null }), 'refuse');
  assert.throws(() => devnetLane('01'), /DevnetPlaySeason/); assert.throws(() => devnetLane(1), /DevnetPlaySeason/);
});

test('the page turns devnet play on only for exactly the pinned devnet world the gateway states', async () => {
  const h = joined(), info = h.flow.info();
  assert.equal(info.schema, DEVNET_ACT_INFO_SCHEMA);
  const dp = await readDevnetPlay({ origin: ORIGIN, pin: PIN, rulesetHash: HASH, post: h.post });
  assert.equal(dp.relay, ORIGIN); assert.equal(dp.seasonAddress, A.season); assert.equal(dp.lane.seasonId, SEASON_ID);
  const hashBytes = Uint8Array.from(Buffer.from(HASH, 'hex'));
  assert.ok(await readDevnetPlay({ origin: ORIGIN, pin: PIN, rulesetHash: hashBytes, post: h.post }), 'the Season\'s hash as bytes');
  const asked = h.posts.length;
  for (const pin of [{ ...PIN, cluster: 'localnet' }, { ...PIN, cluster: 'mainnet-beta' }, null]) assert.equal(await readDevnetPlay({ origin: ORIGIN, pin, rulesetHash: HASH, post: h.post }), null);
  assert.equal(await readDevnetPlay({ origin: ORIGIN, pin: PIN, rulesetHash: HASH, localPlay: { address: W.address }, post: h.post }), null, 'never in local play');
  assert.equal(h.posts.length, asked, 'nothing is asked for another cluster or in local play');
  const of = (over, pin = {}) => devnetPlayOf({ ...info, ...over }, { origin: ORIGIN, programId: PROGRAM, season: A.season, seasonId: SEASON_ID, rulesetHash: HASH, ...pin });
  assert.ok(of({}));
  for (const over of [{ cluster: 'localnet' }, { program: encode(new Uint8Array(32).fill(2)) }, { season: PROGRAM }, { season_id: '2' }, { ruleset_hash: 'ab'.repeat(32) }, { commands: ['Join'] }, { schema: 'x' }]) assert.equal(of(over), null, JSON.stringify(over));
  // a gateway without the routes (404) or no answer: off, the ordinary path stays
  assert.equal(await readDevnetPlay({ origin: ORIGIN, pin: PIN, rulesetHash: HASH, post: async () => { throw Object.assign(new Error('refused'), { code: 'NotFound', refused: true, status: 404 }); } }), null);
});

test('a wide devnet season (rMaxCeiling 128, opened past ring 128) — and only it — offers rim first villages without the local settled-province filter', () => {
  const dp = { relay: ORIGIN };
  assert.equal(devnetWide({ devnetPlay: dp, record: { rMaxCeiling: 128 }, world: { ringsOpen: 129, ringsOpened: 129 } }), true);
  assert.equal(devnetWide({ devnetPlay: dp, record: { rMaxCeiling: 128, ringsOpened: 132 }, world: { ringsOpen: 4 } }), true, 'a sparse record (declared growth) counts its opened rings');
  for (const [d, rec, w] of [[null, { rMaxCeiling: 128 }, { ringsOpen: 129 }], [dp, { rMaxCeiling: 0 }, { ringsOpen: 129 }], [dp, { rMaxCeiling: 128 }, { ringsOpen: 128, ringsOpened: 128 }], [dp, {}, { ringsOpen: 200 }]]) {
    assert.equal(devnetWide({ devnetPlay: d, record: rec, world: w }), false);
  }
  const season = { conquestParams: { placement: 2, heartlandMaxRing: 3, genesisSeed: new Uint8Array(32).fill(1) } };
  const FSd = { season, devnetWide: true };
  assert.equal(wideDevnet(FSd), true);
  assert.deepEqual(homePlaceOf(FSd), { placement: 2, heartlandMaxRing: 3, genesisSeed: season.conquestParams.genesisSeed, outward: true, anyOpen: true });
  assert.equal(homeRingsOf(FSd, 4), 129, 'up to the rim, never the wide land');
  // local play keeps its own rule (settled provinces only, every open ring); an ordinary page keeps the heartland
  assert.equal(wideDevnet({ ...FSd, localPlay: { wideLand: { targets: [] } } }), false);
  assert.equal(homePlaceOf({ season, localPlay: { wideLand: { targets: [] } } }).anyOpen, undefined);
  assert.equal(homeRingsOf({ season }, 129), 4);
  // the wide claim's targets: the herald's opened wide provinces (rings 129+), as decimal strings
  assert.deepEqual(wideTargetsOf({ cells: [{ p: 129, q: -60, ring: 129 }, { p: 5, q: 0, ring: 5 }, { p: 'x', q: 0, ring: 130 }] }), [{ p: '129', q: '-60' }]);
  assert.deepEqual(wideTargetsOf(null), []);
});

test('Join, the rim FileTicket, Harvest and the wide claim: one wallet signature, wallet as fee payer, rebuilt byte for byte by the gateway, ONE send each', async () => {
  const orders = [
    ['Join', { faction: 2 }, { faction: 2, session_expiry: 1785600000n }, null],
    ['FileTicket', { sites: [RIM] }, { sites: [RIM] }, null],
    ['Harvest', { holding: { ...RIM, gen: 1, state: 1 } }, {}, row(holdingBytes())],
    ['WideClaim', { holding: { p: RIM.p, q: RIM.q, site: RIM.site }, target: TARGET }, { site: 0, slot: 2 }, row(holdingBytes())],
  ];
  for (const [name, v, fields, holding] of orders) {
    const h = joined({ citizen: name === 'Join' ? null : row(citizenBytes()), holding });
    const r = await submitLocalAct({ name, v, fields }, h.deps());
    assert.equal(r.ok, true, `${name}: ${r.code}`); assert.equal(r.feePayer, W.address);
    assert.deepEqual(h.posts.map(p => p[1]), [DEVNET_ACT_CONTEXT_PATH, DEVNET_ACT_SUBMIT_PATH]); assert.ok(h.posts.every(p => p[0] === ORIGIN));
    assert.deepEqual(h.posts[0][2], { schema: 'frontier-devnet-play-act-context-v1', wallet: W.address });
    assert.deepEqual(h.rpc, ['getLatestBlockhash', 'getMultipleAccounts', 'sendTransaction'], name); assert.equal(h.sent.length, 1);
    const tx = parseTransaction(Buffer.from(h.sent[0], 'base64'));
    assert.deepEqual(tx.signers, [W.address], `${name}: the wallet alone signs (fee payer and actor)`);
    const intent = localActIntentOf(name, v, fields, W.address);
    assert.deepEqual([...tx.message], [...pageMessage(intent, IDENTITY, HASH, BLOCKHASH, LANE)], `${name}: the message the page built`);
    // built for THIS Season (id 1), not local play's season 11
    assert.ok(tx.accountKeys.includes(A.season), `${name}: the devnet Season`); assert.ok(!tx.accountKeys.includes(seasonAddresses(PROGRAM, '11').season));
    if (name === 'Join') assert.equal(intent.fields.session, W.address, 'the session key registered is the wallet itself');
    // followed by its signature at the gateway it was sent through
    const s = await localActRead({ allowed: () => ({ ok: true, relay: ORIGIN }), post: h.post, lane: LANE })(r.signature);
    assert.deepEqual(s, { ok: true, state: 'landed', slot: 93 });
  }
});

test('the gateway refuses, before any send: another command, another schema, two signers, a message that is not the stated command, bytes sent before, a village not this wallet\'s', async () => {
  const h = joined();
  const okBody = async (name = 'Harvest', v = { holding: RIM }, fields = {}) => {
    let body; await submitLocalAct({ name, v, fields }, h.deps({ post: async (o, p, b) => { if (p === DEVNET_ACT_SUBMIT_PATH) { body = b; throw Object.assign(new Error('x'), { code: 'LocalActBusy', refused: true, status: 429 }); } return h.post(o, p, b); } }));
    return body;
  };
  const body = await okBody();
  const refused = async (b, code) => { await assert.rejects(h.flow.submit(b), e => e instanceof LocalActError && e.code === code, code); };
  await refused({ ...body, name: 'WideTrain' }, 'LocalActNotAllowed');
  await refused({ ...body, name: 'Depart' }, 'LocalActNotAllowed');
  await refused({ ...body, schema: 'frontier-local-play-act-submit-v1' }, 'LocalActInvalid');
  await refused({ ...body, subject: { holding: { ...RIM, site: 4 } } }, 'LocalActMessageMismatch');
  await refused({ ...body, name: 'Build', fields: { item: 1 } }, 'LocalActMessageMismatch');
  // a second signer (the fee payer is someone else): refused
  const tx = parseTransaction(Buffer.from(body.transaction_b64, 'base64'));
  const two = Buffer.concat([Buffer.from([2]), Buffer.from(tx.signatures[0]), Buffer.alloc(64), Buffer.from(tx.message)]).toString('base64');
  // (a malformed count is refused as unreadable; a well-formed second signer as not this wallet's alone)
  await assert.rejects(h.flow.submit({ ...body, transaction_b64: two }), e => ['LocalActSigner', 'LocalActInvalid'].includes(e.code));
  // another wallet's village: the chain's own bytes say whose it is
  const other = joined({ holding: row((() => { const b = holdingBytes(); b.set(new Uint8Array(32).fill(5), 72); return b; })()) });
  await assert.rejects(other.flow.submit(body), e => e.code === 'LocalActNotYourVillage');
  // a Join for a wallet that already has a Citizen
  const jb = await okBody('Join', { faction: 1 }, { faction: 1, session_expiry: 1785600000n });
  await refused(jb, 'LocalActAlreadyJoined');
  assert.equal(h.sent.length, 0, 'nothing was sent');
  // sent once; the same bytes again: refused (never sent twice); an unknown signature: not answered
  await h.flow.submit(body); await refused(body, 'LocalActMessageUsed'); assert.equal(h.sent.length, 1);
  await assert.rejects(h.flow.status({ schema: 'frontier-devnet-play-act-status-v1', signature: encode(new Uint8Array(64).fill(3)) }), e => e.code === 'LocalActUnknownSignature');
});

test('the gateway\'s routes: 404 unless it runs with --devnet-play; refusals carry their code', async () => {
  const req = body => ({ json: async () => body });
  await assert.rejects(devnetPlayRoutes[DEVNET_ACT_ROUTES.context]({ devnetPlay: null }, req({ schema: DEVNET_ACT_INFO_SCHEMA })), e => e.status === 404 && e.code === 'NotFound');
  const h = joined();
  const out = await devnetPlayRoutes[DEVNET_ACT_ROUTES.context]({ devnetPlay: h.flow }, req({ schema: DEVNET_ACT_INFO_SCHEMA }));
  assert.equal(out.status, 200); assert.equal(out.body.cluster, 'devnet');
  await assert.rejects(devnetPlayRoutes[DEVNET_ACT_ROUTES.submit]({ devnetPlay: h.flow }, req({ schema: 'nope' })), e => e.status === 400 && e.code === 'LocalActInvalid');
});
