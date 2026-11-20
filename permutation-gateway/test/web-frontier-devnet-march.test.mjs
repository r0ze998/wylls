// devnet-page-war: the page's ORDINARY sealed march on a devnet season (permutation-server/web/frontier
// flocalplay-march.mjs over `devnetMarchLane`, the connected wallet signing) joined, in this process, to the gateway's
// devnet march flow (src/frontier/devnet-play-act.mjs `marchSubmit` / `marchStatus`): the Depart the page builds and
// its wallet signs is what the gateway rebuilds for the transaction's ONE signer and the Season's real id, and forwards
// ONCE; and the page's march book on devnet is the encrypted kept-world book (fdevnetbook.mjs). A KEY-USING test
// (scripts/ci/node-key-tests.txt): the wallet is the game's own memory-only test wallet, made here and never printed or
// stored. The RPC is a stand-in, the IndexedDB a fake: no process, no chain, no network, no devnet.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as P from '../../permutation-server/web/frontier/flocalplay-march.mjs';
import { devnetPlayOf, devnetIdentityOf } from '../../permutation-server/web/frontier/fdevnetplay.mjs';
import { openDevnetBook, devnetBookScope, DEVNET_BOOK_DB } from '../../permutation-server/web/frontier/fdevnetbook.mjs';
import * as KS from '../../permutation-server/web/frontier/flocalplay-keystore.mjs';
import { createEphemeralWallet } from '../../permutation-server/web/frontier/fephemeral-wallet.mjs';
import { seasonAddresses, hostId } from '../../permutation-server/web/frontier/faddr.mjs';
import { decode, encode } from '../../permutation-server/web/sdk/base58.mjs';
import { parseTransaction } from '../../permutation-server/web/sdk/solana-tx.mjs';
import { createDevnetPlayAct, DEVNET_MARCH_ROUTES, DEVNET_MARCH_COMMANDS, DEVNET_MARCH_SUBMIT_SCHEMA, DEVNET_ACT_INFO_SCHEMA } from '../src/frontier/devnet-play-act.mjs';
import { devnetPlayRoutes, DEVNET_PLAY_PUBLIC_ROUTES } from '../src/frontier/routes/devnet-play.mjs';
import { FRONTIER_PUBLIC_ROUTES } from '../src/frontier/app.mjs';
import { LocalMarchError, localMarchMessage, localMarchIntent, LOCAL_MARCH_SUBMIT_SCHEMA } from '../src/frontier/local-play-march.mjs';
import { LocalActError } from '../src/frontier/local-play-act.mjs';

const W = await createEphemeralWallet({ cluster: 'localnet', hostname: '127.0.0.1', localPlay: true });   // (a test wallet; only its key signs here)
const PROGRAM = encode(new Uint8Array(32).fill(0x61)), SEASON_ID = '1', A = seasonAddresses(PROGRAM, SEASON_ID);
const HASH = 'c3'.repeat(32), BLOCKHASH = encode(new Uint8Array(32).fill(9)), ORIGIN = 'http://127.0.0.1:41965';
const CITIZEN_AT = A.of('Citizen', { wallet: W.address });
const RIM = { p: 128, q: -60, site: 3 }, PROVINCE = { p: 128, q: -60 };
const HOST = hostId({ p: 128, q: -60, site: 3, gen: 1, seq: 0 });
const cfg = { cluster: 'devnet', rpc: 'https://rpc.devnet.example', programId: PROGRAM, seasonId: SEASON_ID, devnetPlay: true, devnetPlayRulesetHash: HASH };
const SIGNER = Object.freeze({ address: W.address, destroyed: false });
const IDENTITY = devnetIdentityOf({ programId: PROGRAM, seasonAddress: A.season }, W.address);
const SEAL = Uint8Array.from([0x80, ...new Array(164).fill(0xab)]), COMMIT = new Uint8Array(32).fill(0xcd);
const FIELDS = Object.freeze({ host_id: HOST, commit: COMMIT, seal: SEAL, arrive_bell: 21, tip: 1000n, transit_slot: 0 });
function citizenBytes() { const b = new Uint8Array(384), v = new DataView(b.buffer); b.set(Buffer.from('PSF1CITZ'), 0); v.setBigUint64(8, 1n, true); v.setUint16(16, 2, true); b.set(decode(W.address), 64); b.set(decode(CITIZEN_AT).subarray(0, 8), 208); return b; }
function holdingBytes(h = RIM) { const b = new Uint8Array(1280), v = new DataView(b.buffer); b.set(Buffer.from('PSF1HOLD'), 0); v.setBigUint64(8, 1n, true); v.setInt16(64, h.p, true); v.setInt16(66, h.q, true); b[68] = h.site; b.set(decode(CITIZEN_AT), 72); return b; }
function provinceBytes(pv = PROVINCE, season = 1n) { const b = new Uint8Array(4096), v = new DataView(b.buffer); b.set(Buffer.from('PSF1PROV'), 0); v.setBigUint64(8, season, true); v.setInt16(64, pv.p, true); v.setInt16(66, pv.q, true); return b; }
const row = bytes => (bytes === null ? null : { owner: PROGRAM, executable: false, lamports: 1, data: [Buffer.from(bytes).toString('base64'), 'base64'] });
const signTx = async wire => {
  const account = (await W.wallet.features['standard:connect'].connect()).accounts[0];
  const [out] = await W.wallet.features['solana:signTransaction'].signTransaction({ account, transaction: wire });
  return out.signedTransaction;
};
const LANE = P.devnetMarchLane(SEASON_ID);
const HOLDING_AT = A.of('Holding', RIM), PROVINCE_AT = A.of('Province', PROVINCE);

/** The gateway's flow over a stand-in RPC, and the page's sender posting to it (refusals as HTTP ones). */
function joined({ province = row(provinceBytes()), blockhashValid = true, statusValue = { slot: 93, confirmationStatus: 'confirmed', err: null } } = {}) {
  const rpc = [], sent = [];
  const flow = createDevnetPlayAct({ cfg, rpc: async (method, params) => {
    rpc.push(method);
    if (method === 'getLatestBlockhash') return { result: { context: { slot: 90 }, value: { blockhash: BLOCKHASH, lastValidBlockHeight: 300 } } };
    if (method === 'getMultipleAccounts') return { result: { context: { slot: 91 }, value: params[0].map(a => (a === CITIZEN_AT ? row(citizenBytes()) : a === HOLDING_AT ? row(holdingBytes()) : a === PROVINCE_AT ? province : null)) } };
    if (method === 'sendTransaction') { sent.push(params[0]); return { result: encode(Buffer.from(params[0], 'base64').subarray(1, 65)) }; }
    if (method === 'isBlockhashValid') return { result: { context: { slot: 94 }, value: blockhashValid } };
    if (method === 'getSignatureStatuses') return { result: { context: { slot: 95 }, value: [statusValue] } };
    return { error: { code: -1 } };
  } });
  const routeOf = { [P.DEVNET_MARCH_SUBMIT_PATH]: 'marchSubmit', [P.DEVNET_MARCH_STATUS_PATH]: 'marchStatus', '/gw/f/devnet-play/act/context': 'context' };
  const posts = [];
  const post = async (origin, path, body) => {
    posts.push([origin, path, body]);
    try { return JSON.parse(JSON.stringify(await flow[routeOf[path]](JSON.parse(JSON.stringify(body))))); }
    catch (e) { if (e instanceof LocalActError || e instanceof LocalMarchError) throw Object.assign(new Error('refused'), { code: e.code, refused: true, status: e.status }); throw e; }
  };
  const book = P.memoryStorage();
  const sender = P.createLocalMarchSender({ allowed: () => ({ ok: true, relay: ORIGIN }), open: () => true, identity: () => IDENTITY, rulesetHash: () => HASH, signer: () => SIGNER,
    post, sign: P.connectedWalletSigner(signTx), lane: LANE, storage: book, bookKey: 'devnet-test-key', wait: async () => {}, tries: 2, every: 0 });
  return { flow, rpc, sent, posts, sender, book, deps: sender.depsFor({ holding: RIM, province: PROVINCE }) };
}

test('the gateway states the march it serves; the page still verifies the same devnet play; the routes are public', () => {
  const { flow } = joined();
  const info = flow.info();
  assert.deepEqual(info.march, { commands: ['Depart'], reveal: 'keeper' });
  assert.deepEqual([...DEVNET_MARCH_COMMANDS], ['Depart']);
  const dp = devnetPlayOf(info, { origin: ORIGIN, programId: PROGRAM, season: A.season, seasonId: SEASON_ID, rulesetHash: HASH });
  assert.ok(dp && dp.seasonId === SEASON_ID, 'devnet play is still verified with the march listed');
  for (const r of Object.values(DEVNET_MARCH_ROUTES)) {
    assert.ok(DEVNET_PLAY_PUBLIC_ROUTES.includes(r) && FRONTIER_PUBLIC_ROUTES.includes(r), r);
    assert.equal(typeof devnetPlayRoutes[r], 'function', r);
  }
  assert.ok(FRONTIER_PUBLIC_ROUTES.includes('POST /f/reveal'), 'the page\'s self-reveal reaches the keeper link');
});

test('the page\'s devnet Depart is the gateway\'s own rebuild for the ONE signer and the Season\'s real id (not local play\'s 11)', () => {
  const intent = P.localMarchIntentOf(FIELDS, RIM, PROVINCE);
  const page = P.localMarchMessageOf(intent, IDENTITY, HASH, BLOCKHASH, LANE.seasonId);
  const pins = { program: PROGRAM, season: A.season, seasonId: SEASON_ID, wallet: W.address, rulesetHash: HASH };
  assert.deepEqual(Buffer.from(page), Buffer.from(localMarchMessage(localMarchIntent(JSON.parse(JSON.stringify(intent))), pins, BLOCKHASH)));
  // local play's Season id (11) does not name this identity's Season: refused before anything is built
  assert.throws(() => P.localMarchMessageOf(intent, IDENTITY, HASH, BLOCKHASH), e => e.code === 'LocalMarchIdentity');
  assert.equal(P.LOCAL_MARCH_LANE.seasonId, '11');
  assert.throws(() => P.devnetMarchLane('x'), e => e.code === 'DevnetPlaySeason');
});

test('ONE wallet-signed Depart: built, signed by the wallet alone (fee payer and actor), checked, sent once; its status; a replay refused', async () => {
  const h = joined();
  const r = await h.deps.submit({ name: 'Depart', fields: FIELDS });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(h.sent.length, 1, 'one sendTransaction');
  const t = parseTransaction(Buffer.from(h.sent[0], 'base64'));
  assert.deepEqual(t.signers, [W.address], 'the wallet is the only signer');
  assert.equal(t.signatures.length, 1);
  assert.deepEqual(h.posts.map(p => p[1]), ['/gw/f/devnet-play/act/context', P.DEVNET_MARCH_SUBMIT_PATH]);
  assert.equal(h.posts[0][2].wallet, W.address, 'the devnet context names the wallet');
  assert.equal(h.posts[1][2].schema, DEVNET_MARCH_SUBMIT_SCHEMA);
  assert.deepEqual(h.rpc, ['getLatestBlockhash', 'getMultipleAccounts', 'sendTransaction'], 'one read of the accounts, then one send');
  assert.deepEqual(await h.deps.track(r.signature), { ok: true, slot: 93 });
  // the same bytes again: refused before any send, and nothing sent
  const again = await h.flow.marchSubmit(JSON.parse(JSON.stringify(h.posts[1][2]))).catch(e => e);
  assert.equal(again.code, 'LocalMarchMessageUsed');
  assert.equal(h.sent.length, 1);
});

test('refusals before the send: local play\'s schema, another command, a province of another Season, a two-signer wire; nothing sent', async () => {
  const h = joined();
  await h.deps.submit({ name: 'Depart', fields: FIELDS });
  const body = JSON.parse(JSON.stringify(h.posts[1][2]));
  const refused = async (b, code, flow = h.flow) => { const e = await flow.marchSubmit(b).catch(x => x); assert.equal(e.code, code, JSON.stringify(e)); };
  await refused({ ...body, schema: LOCAL_MARCH_SUBMIT_SCHEMA }, 'LocalMarchInvalid');
  await refused({ ...body, name: 'Reveal' }, 'LocalMarchNotAllowed');
  const other = joined({ province: row(provinceBytes(PROVINCE, 7n)) });
  const r2 = await other.deps.submit({ name: 'Depart', fields: FIELDS });
  assert.equal(r2.ok, false); assert.equal(r2.code, 'LocalMarchProvince');
  assert.equal(other.sent.length, 0);
  // a wire with a second signer: refused as a signer problem
  const wire = Buffer.from(body.transaction_b64, 'base64');
  const two = Buffer.concat([Buffer.from([2]), wire.subarray(1, 65), Buffer.alloc(64), wire.subarray(65)]);
  await refused({ ...body, transaction_b64: two.toString('base64') }, 'LocalMarchInvalid');
  assert.equal(h.sent.length, 1);
});

test('the march status: `expired` once the blockhash is no longer valid and the signature unknown; a failure with its program code', async () => {
  const h = joined({ blockhashValid: false, statusValue: null });
  const r = await h.deps.submit({ name: 'Depart', fields: FIELDS });
  assert.equal((await h.flow.marchStatus({ schema: 'frontier-devnet-play-march-status-v1', signature: r.signature })).status, 'expired');
  assert.deepEqual(await h.deps.track(r.signature), { ok: false, state: 'expired', code: 'LocalMarchExpired' });
  const f = joined({ statusValue: { slot: 93, confirmationStatus: 'confirmed', err: { InstructionError: [2, { Custom: 31 }] } } });
  const r2 = await f.deps.submit({ name: 'Depart', fields: FIELDS });
  assert.deepEqual(await f.deps.track(r2.signature), { ok: false, state: 'failed', code: 'TransactionFailed', programCode: 31 });
  const unknown = await h.flow.marchStatus({ schema: 'frontier-devnet-play-march-status-v1', signature: '1'.repeat(64) }).catch(e => e);
  assert.equal(unknown.code, 'LocalMarchUnknownSignature');
});

/** A minimal IndexedDB (as web-frontier-local-play-keystore.test.mjs): values kept as given (structured clone keeps a CryptoKey). */
function fakeIdb() {
  const dbs = new Map();
  const request = fn => { const r = {}; queueMicrotask(() => { try { r.result = fn(); r.onsuccess?.(); } catch (e) { r.error = e; r.onerror?.(); } }); return r; };
  return { dbs, open(name) {
    const r = {};
    queueMicrotask(() => {
      let db = dbs.get(name); const fresh = !db;
      if (!db) { db = new Map(); dbs.set(name, db); }
      r.result = { objectStoreNames: { contains: n => db.has(n) }, createObjectStore: n => { db.set(n, new Map()); },
        transaction(store) { const m = db.get(store), tx = {}; tx.objectStore = () => ({ get: k => request(() => m.get(k)), put: (v, k) => { m.set(k, v); return {}; }, delete: k => { m.delete(k); return {}; } }); setTimeout(() => tx.oncomplete?.(), 0); return tx; },
        close() {} };
      if (fresh) r.onupgradeneeded?.();
      r.onsuccess?.();
    });
    return r;
  } };
}

test('the devnet march book: its own database, a non-extractable key, encrypted at rest, kept across a reload, one book per (program, Season, wallet)', async () => {
  const idb = fakeIdb(), dp = { programId: PROGRAM, seasonAddress: A.season };
  const b1 = await openDevnetBook(dp, W.address, { idb });
  assert.deepEqual([...idb.dbs.keys()], [DEVNET_BOOK_DB], 'not local play\'s TEST key store');
  assert.notEqual(DEVNET_BOOK_DB, KS.KEYSTORE_DB);
  const secret = JSON.stringify([{ v: 1, host: String(HOST), arriveBell: 21, plain: 'PLAINTEXT-HALF', salt: 'SALT-HALF', state: 'sent' }]);
  b1.storage.set('k', secret);
  await b1.flush();
  const secrets = idb.dbs.get(DEVNET_BOOK_DB).get('secrets');
  const key = [...secrets.entries()].find(([k]) => k.endsWith('#key'))[1];
  assert.equal(key.extractable, false, 'the book key cannot be exported');
  await assert.rejects(globalThis.crypto.subtle.exportKey('raw', key));
  const sealed = secrets.get(KS.bookScope(devnetBookScope(dp), W.address));
  assert.ok(sealed.iv instanceof Uint8Array && sealed.iv.length === 12);
  assert.ok(!Buffer.from(sealed.data).toString('latin1').includes('PLAINTEXT-HALF'), 'encrypted at rest');
  // a reload: a new page opens the same book
  const b2 = await openDevnetBook(dp, W.address, { idb });
  assert.equal(b2.storage.get('k'), secret);
  // another Season's (or wallet's) book is another book
  const b3 = await openDevnetBook({ programId: PROGRAM, seasonAddress: seasonAddresses(PROGRAM, '2').season }, W.address, { idb });
  assert.equal(b3.storage.get('k'), null);
  // a tampered book is refused, never repaired
  secrets.set(KS.bookScope(devnetBookScope(dp), W.address), { iv: sealed.iv, data: Uint8Array.from(sealed.data, (x, i) => (i === 0 ? x ^ 1 : x)) });
  await assert.rejects(openDevnetBook(dp, W.address, { idb }), e => e.code === 'StoredBookInvalid');
});

test('the gateway never takes the page\'s secret: no reveal route on the devnet play routes; the info names the keeper as the revealer', () => {
  assert.ok(!Object.keys(devnetPlayRoutes).some(r => /reveal/i.test(r)), 'no reveal on these routes (POST /f/reveal is the keeper link)');
  assert.equal(createDevnetPlayAct({ cfg }).info().schema, DEVNET_ACT_INFO_SCHEMA);
});
