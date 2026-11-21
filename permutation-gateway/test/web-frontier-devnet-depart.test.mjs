// devnet-p15-p9 (devnet gap P15): the page's BOUNDARY DEPARTURE on a devnet wide season (permutation-server/web/frontier
// fdevnet-depart.mjs: two presses — the preview, then the connected wallet's signature and ONE send) joined, in this
// process, to the gateway's devnet expedition routes (src/frontier/devnet-play-act.mjs `expeditionSubmit` /
// `expeditionStatus`), and the ONE shared builder of the unsigned message (fexpedition-depart-message.mjs), pinned
// byte for byte to the keyless Rust CLI's recorded output. A KEY-USING test (scripts/ci/node-key-tests.txt): ed25519
// TEST keys are made here by node:crypto and never printed or stored. The RPC is a stand-in, the IndexedDB a fake:
// no process, no chain, no network, no devnet.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { generateKeyPairSync, sign as edSign } from 'node:crypto';
import { seasonAddresses, hostId } from '../../permutation-server/web/frontier/faddr.mjs';
import { encode, decode as fromB58 } from '../../permutation-server/web/sdk/base58.mjs';
import { encodeAccount } from '../../permutation-server/web/sdk/frontier/codec.mjs';
import { decode } from '../../permutation-server/web/frontier/fcodec.mjs';
import { OUTBOUND_POP, openOutbound, editOutbound } from '../../permutation-server/web/frontier/fexpedition-compose.mjs';
import { departUnsignedMessage, DEVNET_DEPART_CU_LIMIT, DEVNET_DEPART_LOADED_LIMIT } from '../../permutation-server/web/frontier/fexpedition-depart-message.mjs';
import * as DD from '../../permutation-server/web/frontier/fdevnet-depart.mjs';
import { openDevnetBook } from '../../permutation-server/web/frontier/fdevnetbook.mjs';
import { parseTransaction, wireTransaction } from '../../permutation-server/web/sdk/solana-tx.mjs';
import { createDevnetPlayAct, DEVNET_EXPEDITION_ROUTES, DEVNET_EXPEDITION_COMMANDS, DEVNET_EXPEDITION_SUBMIT_SCHEMA, DEVNET_EXPEDITION_STATUS_SCHEMA } from '../src/frontier/devnet-play-act.mjs';
import { devnetPlayRoutes, DEVNET_PLAY_PUBLIC_ROUTES, DEVNET_PLAY_IP_LIMITS } from '../src/frontier/routes/devnet-play.mjs';
import { FRONTIER_PUBLIC_ROUTES } from '../src/frontier/app.mjs';
import { expeditionDepartPrepareReport, canonicalDepartProposal } from '../src/frontier/expedition-depart-prepare.mjs';
import { LocalMarchError } from '../src/frontier/local-play-march.mjs';

// ------------------------------------------------------------------ TEST keys (node:crypto; never printed)
function testKey() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url');
  return { address: encode(raw), sign: m => new Uint8Array(edSign(null, Buffer.from(m), privateKey)) };
}
const W = testKey(), OTHER = testKey();
/** The connected wallet's signTransaction stand-in: the wire with the message and this key's signature. */
const signWith = key => async wire => { const t = parseTransaction(Uint8Array.from(wire)); return wireTransaction(t.message, [key.sign(t.message)]); };

const PROGRAM = encode(new Uint8Array(32).fill(94)), SEASON_ID = '1', A = seasonAddresses(PROGRAM, SEASON_ID);
const HASH = '01'.repeat(32), BLOCKHASH = encode(new Uint8Array(32).fill(7)), ORIGIN = 'http://127.0.0.1:41965';
const PIN = { programId: PROGRAM, cluster: 'devnet', seasonId: SEASON_ID, addresses: A };
const HOST = hostId({ p: 128, q: 0, site: 3, gen: 1, seq: 0 }).toString();
const acct = (kind, values) => decode(kind, encodeAccount(kind, { SEASON_ID: 1n, ...values }));
const SEASON = decode('Season', Buffer.from(JSON.parse(readFileSync(new URL('fixtures/frontier/season.json', import.meta.url), 'utf8')).bytes_b64, 'base64'));
const cfg = { cluster: 'devnet', rpc: 'https://rpc.devnet.example', programId: PROGRAM, seasonId: SEASON_ID, devnetPlay: true, devnetPlayRulesetHash: HASH };
const CITIZEN_AT = A.of('Citizen', { wallet: W.address });
const RIM = { p: 128, q: 0, site: 3 }, PROVINCE = { p: 128, q: 0 };
const HOLDING_AT = A.of('Holding', RIM), PROVINCE_AT = A.of('Province', PROVINCE);
function citizenBytes(wallet = W.address) { const at = A.of('Citizen', { wallet }), b = new Uint8Array(384), v = new DataView(b.buffer); b.set(Buffer.from('PSF1CITZ'), 0); v.setBigUint64(8, 1n, true); v.setUint16(16, 2, true); b.set(fromB58(wallet), 64); b.set(fromB58(at).subarray(0, 8), 208); return b; }
function holdingBytes(owner = CITIZEN_AT) { const b = new Uint8Array(1280), v = new DataView(b.buffer); b.set(Buffer.from('PSF1HOLD'), 0); v.setBigUint64(8, 1n, true); v.setInt16(64, RIM.p, true); v.setInt16(66, RIM.q, true); b[68] = RIM.site; b.set(fromB58(owner), 72); return b; }
function provinceBytes() { const b = new Uint8Array(4096), v = new DataView(b.buffer); b.set(Buffer.from('PSF1PROV'), 0); v.setBigUint64(8, 1n, true); v.setInt16(64, PROVINCE.p, true); v.setInt16(66, PROVINCE.q, true); return b; }
const row = bytes => (bytes === null ? null : { owner: PROGRAM, executable: false, lamports: 1, data: [Buffer.from(bytes).toString('base64'), 'base64'] });

/** The gateway's flow over a stand-in RPC. */
function gateway({ gcfg = cfg, holdingOwner = CITIZEN_AT, blockhashValid = true, statusValue = { slot: 93, confirmationStatus: 'confirmed', err: null }, sendError = null } = {}) {
  const rpc = [], sent = [];
  const flow = createDevnetPlayAct({ cfg: gcfg, rpc: async (method, params) => {
    rpc.push(method);
    if (method === 'getMinimumBalanceForRentExemption') { assert.equal(params[0], 336); return { result: 2357120 }; }
    if (method === 'getLatestBlockhash') return { result: { context: { slot: 90 }, value: { blockhash: BLOCKHASH, lastValidBlockHeight: 300 } } };
    if (method === 'getMultipleAccounts') return { result: { context: { slot: 91 }, value: params[0].map(a => (a === CITIZEN_AT ? row(citizenBytes()) : a === HOLDING_AT ? row(holdingBytes(holdingOwner)) : a === PROVINCE_AT ? row(provinceBytes()) : null)) } };
    if (method === 'sendTransaction') { if (sendError) return { error: sendError }; sent.push(params[0]); return { result: encode(Buffer.from(params[0], 'base64').subarray(1, 65)) }; }
    if (method === 'isBlockhashValid') return { result: { context: { slot: 94 }, value: blockhashValid } };
    if (method === 'getSignatureStatuses') return { result: { context: { slot: 95 }, value: [statusValue] } };
    return { error: { code: -1 } };
  } });
  const routeOf = { [DD.DEVNET_DEPART_CONTEXT_PATH]: 'context', [DD.DEVNET_DEPART_SUBMIT_PATH]: 'expeditionSubmit', [DD.DEVNET_DEPART_STATUS_PATH]: 'expeditionStatus' };
  const posts = [];
  const post = async (origin, path, body) => {
    posts.push([origin, path, JSON.stringify(body)]);
    try { return JSON.parse(JSON.stringify(await flow[routeOf[path]](JSON.parse(JSON.stringify(body))))); }
    catch (e) { if (e instanceof LocalMarchError) throw Object.assign(new Error('refused'), { code: e.code, refused: true, status: e.status }); throw e; }
  };
  return { flow, rpc, sent, posts, post };
}

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

const PLAIN_SECRET = new Uint8Array(136).fill(0x5a), SALT_SECRET = new Uint8Array(32).fill(0x3c);
/** A stand-in seal (the real one is seal-wide.mjs over a drand round): public commit and seal, the reveal half. */
const fakeSeal = async () => ({ ok: true, commit: new Uint8Array(32).fill(0xcd), seal: Uint8Array.from([0x80, ...new Array(263).fill(0xab)]),
  ctHash: new Uint8Array(32).fill(1), sealRoot: new Uint8Array(32).fill(2), reveal: { plain: PLAIN_SECRET, salt: SALT_SECRET } });

/** A devnet page: the connected wallet's Citizen and rim village at (128, 0), a reviewed boundary draft one step out. */
async function page({ idb = fakeIdb() } = {}) {
  const h = acct('Holding', { P: 128, Q: 0, SITE: 3, GEN: 1, TILE: 60, STATE: 2, FACTION: 0, TIER: 1, HOST_SEQ: 1, OWNER_CITIZEN: fromB58(CITIZEN_AT), RESERVE: [400, 0, 0, 0, 0, 0, 100, 0] });
  const province = acct('Province', { P: 128, Q: 0, RESOLVED_NEXT: 42, SITE_COUNT: 1, SITES: Uint8Array.of(60, ...new Array(11).fill(0)), PASSABLE_MASK: (1n << 61n) - 1n,
    SITE_MIRROR: [{ STATE: 1, GEN: 1, FACTION: 0, TIER: 1 }, ...Array.from({ length: 11 }, () => ({ STATE: 0 }))],
    ENTRIES: [{ ID: BigInt(HOST), FACTION: 0, UNIT: 0, TILE: 60, STATE: 1, TROOPS: 600000, STAMINA_VALUE: 120, STAMINA_BELL: 42 }] });
  const fs = { mode: 'play', sample: null, proto: null, season: { ...SEASON, seasonId: 1n, programVersion: 18436, rulesetHash: fromHexStr(HASH) },
    wallet: { address: W.address }, resident: null, session: null, meStatus: 'ready', meAnswered: true, localPlay: null,
    citizen: acct('Citizen', { WALLET: fromB58(W.address), FACTION: 0, FLAGS: 5, TICKET_BELL: 0xffffffff, HOLDING: [{ P: 128, Q: 0, SITE: 3, GEN: 1 }, { GEN: 255 }, { GEN: 255 }] }), holdings: [h], activeHolding: 0,
    selected: { kind: 'tile', p: 128, q: 0, idx: 60 }, hand: { host: HOST, pop: OUTBOUND_POP }, nowBell: 42, chain: { now: () => 1000 }, provinces: new Map([['128,0', { province }]]),
    view: { lod: 'tile', fog: true }, land: { stage: 'final' }, marches: [], book: [], orders: [], compose: null };
  const ctx = { pin: PIN, relay: ORIGIN, source: {} };
  openOutbound(fs, ctx); editOutbound(fs, ctx, 'step', '0'); editOutbound(fs, ctx, 'arriveBell', '44');
  assert.equal(fs.expeditionCompose.status, 'review', fs.expeditionCompose.error);
  const book = await openDevnetBook({ programId: PROGRAM, seasonAddress: A.season }, W.address, { idb });
  return { fs, ctx, book, idb };
}
function fromHexStr(h) { return Uint8Array.from(Buffer.from(h, 'hex')); }
const deps = (p, g, more = {}) => ({ allowed: () => ({ ok: true, relay: ORIGIN }), context: () => p.ctx, sealInput: () => ({}), seal: fakeSeal,
  book: async () => p.book, wallet: () => W.address, post: g.post, sign: signWith(W), ...more });

// ------------------------------------------------------------------ the shared builder
test('the shared builder is byte for byte the keyless Rust CLI\'s message (the recorded wallet-payer report), and the report checker accepts it', () => {
  const R = JSON.parse(readFileSync(new URL('./fixtures/frontier-expedition-depart-prepare-wallet-payer-heap256k-rust.json', import.meta.url), 'utf8'));
  const m = departUnsignedMessage({ request: R.request, blockhash: R.blockhash.hash, cuLimit: R.prepared.budget.cu_limit, loadedLimit: R.prepared.budget.loaded_limit });
  assert.equal(Buffer.from(m.message).toString('base64'), R.prepared.message_b64);
  assert.equal(m.digest, R.prepared.message_digest);
  assert.deepEqual([...m.signers], [R.request.wallet]);
  // the devnet budget: the same message shape at the page's limits, accepted by the relay's own independent checker
  const d = departUnsignedMessage({ request: R.request, blockhash: R.blockhash.hash });
  const report = { ...R, prepared: { ...R.prepared, budget: { ...R.prepared.budget, cu_limit: DEVNET_DEPART_CU_LIMIT, loaded_limit: DEVNET_DEPART_LOADED_LIMIT },
    message_b64: Buffer.from(d.message).toString('base64'), message_digest: d.digest, shape: { ...R.prepared.shape, bytes: d.message.length + 65 } } };
  assert.ok(expeditionDepartPrepareReport(report, R.request, { fee_payer: R.request.payer, cu_limit: DEVNET_DEPART_CU_LIMIT, loaded_limit: DEVNET_DEPART_LOADED_LIMIT }));
  // a payer that is not the wallet (two signers) is not this builder's
  assert.throws(() => departUnsignedMessage({ request: { ...R.request, payer: OTHER.address }, blockhash: R.blockhash.hash }), e => e.code === 'DepartMessageContract');
});

// ------------------------------------------------------------------ the gateway's routes
test('the gateway states the expedition it serves; the routes are public, rate-limited, and 404 without --devnet-play', async () => {
  const { flow } = gateway();
  assert.deepEqual(flow.info().expedition, { commands: ['ExpeditionDepart'], reveal: 'keeper', cu_limit: DEVNET_DEPART_CU_LIMIT, loaded_limit: DEVNET_DEPART_LOADED_LIMIT });
  assert.deepEqual([...DEVNET_EXPEDITION_COMMANDS], ['ExpeditionDepart']);
  for (const r of Object.values(DEVNET_EXPEDITION_ROUTES)) {
    assert.ok(DEVNET_PLAY_PUBLIC_ROUTES.includes(r) && FRONTIER_PUBLIC_ROUTES.includes(r) && DEVNET_PLAY_IP_LIMITS[r], r);
    await assert.rejects(devnetPlayRoutes[r]({ devnetPlay: null }, { json: async () => ({}) }), e => e.status === 404, r);
  }
  assert.ok(!Object.keys(devnetPlayRoutes).some(r => /reveal/i.test(r)), 'no reveal route: keeper A opens the seal');
});

// ------------------------------------------------------------------ the page, joined to the gateway
test('press 1 shows what will be signed; press 2 signs THAT message once, the gateway rebuilds it, sends once; the status confirms; nothing secret is posted', async () => {
  const p = await page(), g = gateway();
  const s1 = await DD.prepareDevnetDepart(p.fs, deps(p, g));
  assert.equal(s1.status, 'preview', s1.error);
  assert.equal(g.sent.length, 0, 'press 1 sends nothing');
  const pv = s1.preview;
  assert.equal(pv.action, 'ExpeditionDepart'); assert.equal(pv.payer, W.address); assert.equal(pv.signer, W.address);
  assert.equal(pv.arriveBell, 44); assert.equal(pv.fee, '5000');
  // (devnet-p15-p9 run3: the wallet paid 2,407,514 = 5,000 fee + 45,394 escrow + 2,357,120 transit rent at 5,080)
  assert.equal(pv.transitRent, '2357120');
  assert.equal(BigInt(pv.total), BigInt(pv.tip) + BigInt(pv.marchFee) + BigInt(pv.sealBond) + 5000n + 2357120n);
  assert.ok(pv.destination && pv.accounts >= 9 && /^[0-9a-f]{64}$/.test(pv.digest) && pv.blockhash === BLOCKHASH && pv.lastValidBlockHeight === '300');
  // the reveal half is in the encrypted book, never in a request
  const kept = DD.devnetDepartReveals(p.book.storage);
  assert.equal(kept.length, 1); assert.equal(kept[0].plain, Buffer.from(PLAIN_SECRET).toString('hex')); assert.equal(kept[0].signature, null);
  const s2 = await DD.sendDevnetDepart(p.fs, deps(p, g));
  assert.equal(s2.status, 'confirmed', s2.error);
  assert.equal(g.sent.length, 1, 'ONE send');
  const t = parseTransaction(Buffer.from(g.sent[0], 'base64'));
  assert.deepEqual(t.signers, [W.address]);
  assert.equal(Buffer.from(t.message).toString('hex'), Buffer.from(departUnsignedMessage({ request: JSON.parse(g.posts.find(x => x[1] === DD.DEVNET_DEPART_SUBMIT_PATH)[2]).request, blockhash: BLOCKHASH }).message).toString('hex'));
  assert.deepEqual(g.posts.map(x => x[1]), [DD.DEVNET_DEPART_CONTEXT_PATH, DD.DEVNET_DEPART_SUBMIT_PATH, DD.DEVNET_DEPART_STATUS_PATH]);
  const secretHex = [Buffer.from(PLAIN_SECRET).toString('hex'), Buffer.from(SALT_SECRET).toString('hex'), Buffer.from(PLAIN_SECRET).toString('base64'), Buffer.from(SALT_SECRET).toString('base64')];
  for (const [, , body] of g.posts) for (const s of secretHex) assert.ok(!body.includes(s), 'no request carries the reveal half');
  assert.equal(DD.devnetDepartReveals(p.book.storage)[0].signature, s2.signature, 'the kept half names its departure');
  // the same bytes again: refused before any send (the replay barrier)
  const body = JSON.parse(g.posts.find(x => x[1] === DD.DEVNET_DEPART_SUBMIT_PATH)[2]);
  await assert.rejects(g.flow.expeditionSubmit(body), e => e.code === 'LocalMarchMessageUsed');
  assert.equal(g.sent.length, 1);
  // a second press after the end does nothing; clearing a finished run is allowed, the halves stay
  assert.equal((await DD.sendDevnetDepart(p.fs, deps(p, g))).status, 'confirmed');
  assert.equal(DD.clearDevnetDepart(p.fs), true);
  assert.equal(DD.devnetDepartReveals(p.book.storage).length, 1);
});

test('the book keeps the reveal half encrypted across a reload (a new page, the same IndexedDB)', async () => {
  const idb = fakeIdb(), p = await page({ idb }), g = gateway();
  assert.equal((await DD.prepareDevnetDepart(p.fs, deps(p, g))).status, 'preview');
  await p.book.flush();
  const raw = [...idb.dbs.values()].flatMap(db => [...db.values()].flatMap(m => [...m.values()]));
  assert.ok(!raw.some(v => v?.data && Buffer.from(v.data).toString('latin1').includes(Buffer.from(PLAIN_SECRET).toString('hex'))), 'encrypted at rest');
  const again = await openDevnetBook({ programId: PROGRAM, seasonAddress: A.season }, W.address, { idb });
  const kept = DD.devnetDepartReveals(again.storage);
  assert.equal(kept.length, 1); assert.equal(kept[0].salt, Buffer.from(SALT_SECRET).toString('hex')); assert.equal(kept[0].host, p.fs.expeditionCompose.source.host);
});

test('signing is refused when the draft changed after the preview, when another wallet signs, or the gate closed; nothing is sent', async () => {
  { // the draft changed (another step): no signature asked, nothing posted to submit
    const p = await page(), g = gateway();
    assert.equal((await DD.prepareDevnetDepart(p.fs, deps(p, g))).status, 'preview');
    let asked = 0;
    editOutbound(p.fs, p.ctx, 'step', '0');
    const s = await DD.sendDevnetDepart(p.fs, deps(p, g, { sign: async w => { asked++; return signWith(W)(w); } }));
    assert.equal(s.status, 'error'); assert.equal(s.error, 'DepartDraftChanged'); assert.equal(asked, 0); assert.equal(g.sent.length, 0);
    assert.equal(s.sent, false);
  }
  { // the wallet returned another key's signature: refused on the page
    const p = await page(), g = gateway();
    await DD.prepareDevnetDepart(p.fs, deps(p, g));
    const s = await DD.sendDevnetDepart(p.fs, deps(p, g, { sign: signWith(OTHER) }));
    assert.equal(s.status, 'error'); assert.equal(s.error, 'DevnetDepartSignatureInvalid'); assert.equal(g.sent.length, 0);
  }
  { // the gate closed between the presses
    const p = await page(), g = gateway();
    await DD.prepareDevnetDepart(p.fs, deps(p, g));
    const s = await DD.sendDevnetDepart(p.fs, deps(p, g, { allowed: () => ({ ok: false, code: 'NoWallet' }) }));
    assert.equal(s.error, 'NoWallet'); assert.equal(g.sent.length, 0);
  }
  { // the devnet page is not wide (the controller's gate): nothing is sealed
    const p = await page(), g = gateway();
    const s = await DD.prepareDevnetDepart(p.fs, deps(p, g, { allowed: () => ({ ok: false, code: 'DevnetDepartNotWide' }) }));
    assert.equal(s.error, 'DevnetDepartNotWide'); assert.equal(DD.devnetDepartReveals(p.book.storage).length, 0); assert.equal(g.posts.length, 0);
  }
});

/** A signed submit body for `request` (the canonical request of the page's draft) by `key`, on `blockhash`. */
async function bodyOf(request, key = W, blockhash = BLOCKHASH) {
  const m = departUnsignedMessage({ request, blockhash });
  return { schema: DEVNET_EXPEDITION_SUBMIT_SCHEMA, request, blockhash, transaction_b64: Buffer.from(wireTransaction(m.message, [key.sign(m.message)])).toString('base64') };
}
async function requestOf() {
  const p = await page();
  const sealed = await fakeSeal();
  return DD.devnetDepartRequest(p.fs, { sealed: { commit: Buffer.from(sealed.commit).toString('hex'), seal: Buffer.from(sealed.seal).toString('hex') }, requestId: 'dp_test_1', minSlot: '90' });
}

test('the gateway refuses before any send: another signer, a tampered message, another program / Season / ruleset, a payer that is not the wallet, a village not this wallet\'s', async () => {
  const request = await requestOf();
  const refused = async (g, body, code) => { await assert.rejects(g.flow.expeditionSubmit(body), e => e.code === code, code); assert.equal(g.sent.length, 0, code); };
  { const g = gateway(); await refused(g, await bodyOf(request, OTHER), 'LocalMarchSigner'); }
  { const g = gateway(), b = await bodyOf(request); await refused(g, { ...b, blockhash: encode(new Uint8Array(32).fill(8)) }, 'LocalMarchMessageMismatch'); }
  { const g = gateway(), b = await bodyOf(request); const w = Buffer.from(b.transaction_b64, 'base64'); w[w.length - 1] ^= 1; await refused(g, { ...b, transaction_b64: w.toString('base64') }, 'LocalMarchMessageMismatch'); }
  { const g = gateway({ gcfg: { ...cfg, devnetPlayRulesetHash: '02'.repeat(32) } }); await refused(g, await bodyOf(request), 'LocalMarchNotAllowed'); }
  { const g = gateway({ gcfg: { ...cfg, seasonId: '2' } }); await refused(g, await bodyOf(request), 'LocalMarchNotAllowed'); }
  { const g = gateway({ gcfg: { ...cfg, programId: encode(new Uint8Array(32).fill(95)) } }); await refused(g, await bodyOf(request), 'LocalMarchNotAllowed'); }
  { const g = gateway(); await refused(g, await bodyOf({ ...request, cluster: 'localnet' }), 'LocalMarchNotAllowed'); }
  { // payer ≠ wallet: a canonical two-signer request is not the devnet page's
    const scope = { ...request, payer: OTHER.address }; delete scope.proposal;
    const two = { ...scope, proposal: canonicalDepartProposal(scope) };
    const g = gateway();
    await refused(g, { schema: DEVNET_EXPEDITION_SUBMIT_SCHEMA, request: two, blockhash: BLOCKHASH, transaction_b64: (await bodyOf(request)).transaction_b64 }, 'LocalMarchSigner');
  }
  { const g = gateway({ holdingOwner: A.of('Citizen', { wallet: OTHER.address }) }); await refused(g, await bodyOf(request), 'LocalMarchHolding'); }
  { const g = gateway(); await refused(g, { ...(await bodyOf(request)), schema: 'frontier-devnet-play-march-submit-v1' }, 'LocalMarchInvalid'); }
  // the honest one passes, once
  const g = gateway(), b = await bodyOf(request);
  const r = await g.flow.expeditionSubmit(b);
  assert.equal(r.status, 'submitted'); assert.equal(g.sent.length, 1); assert.equal(r.status_route, DEVNET_EXPEDITION_ROUTES.status);
  assert.deepEqual(g.rpc, ['getMultipleAccounts', 'sendTransaction']);
});

test('the expedition status: confirmed, failed with the chain\'s error, `expired` once its blockhash is gone and it is unknown; another signature is not this gateway\'s', async () => {
  const request = await requestOf();
  const statusOf = async more => { const g = gateway(more), r = await g.flow.expeditionSubmit(await bodyOf(request)); return g.flow.expeditionStatus({ schema: DEVNET_EXPEDITION_STATUS_SCHEMA, signature: r.signature }); };
  assert.equal((await statusOf()).status, 'confirmed');
  assert.equal((await statusOf({ statusValue: { slot: 93, confirmationStatus: 'confirmed', err: { InstructionError: [4, { Custom: 32 }] } } })).status, 'failed');
  assert.equal((await statusOf({ statusValue: null, blockhashValid: false })).status, 'expired');
  assert.equal((await statusOf({ statusValue: null, blockhashValid: true })).status, 'pending');
  const g = gateway();
  await assert.rejects(g.flow.expeditionStatus({ schema: DEVNET_EXPEDITION_STATUS_SCHEMA, signature: '1'.repeat(88) }), e => e.code === 'LocalMarchUnknownSignature');
  // a march's signature is not asked about on the expedition route (and the other way round)
  await assert.rejects(g.flow.marchStatus({ schema: 'frontier-devnet-play-march-status-v1', signature: (await g.flow.expeditionSubmit(await bodyOf(request))).signature }), e => e.code === 'LocalMarchUnknownSignature');
});

test('an outcome not known is never sent again: a send refusal after the press leaves the run `unknown`, asked about by its signature only', async () => {
  const p = await page(), g = gateway({ sendError: { code: -32002, message: 'Transaction simulation failed: custom program error: 0x20' } });
  await DD.prepareDevnetDepart(p.fs, deps(p, g));
  const s = await DD.sendDevnetDepart(p.fs, deps(p, g));
  assert.equal(s.status, 'unknown'); assert.equal(s.sent, true);
  const again = await DD.prepareDevnetDepart(p.fs, deps(p, g));
  assert.equal(again.status, 'unknown', 'no new run while the outcome is not settled');
  assert.equal(DD.clearDevnetDepart(p.fs), false);
});

test('the card: on a wide devnet page the devnet buttons and the preview lines, no departure-conditions read; local play\'s block absent; another page shows neither', async () => {
  const hand = await import('../../permutation-server/web/frontier/hud/hand.mjs');
  const { setLang } = await import('../../permutation-server/web/lang.mjs');
  const p = await page(), g = gateway();
  const card = () => String(hand.renderPop(p.fs, hand.handModel(p.fs)));
  try {
    setLang('ja');
    // not a devnet page: neither block, the context read as before
    let c = card();
    assert.ok(!c.includes('outbound-devnet-') && !c.includes('outbound-local-depart') && c.includes('outbound-context-read'));
    Object.assign(p.fs, { devnetPlay: { relay: ORIGIN }, devnetWide: true });
    c = card();
    assert.ok(c.includes('data-act="outbound-devnet-preview"') && !c.includes('outbound-context-read') && !c.includes('outbound-local-depart'));
    assert.match(c, /送る内容を確認/);
    await DD.prepareDevnetDepart(p.fs, deps(p, g));
    c = card();
    assert.ok(c.includes('data-act="outbound-devnet-send"') && c.includes('devnet-depart-preview'));
    assert.match(c, /ウォレットで署名して送る/); assert.match(c, /最大の支払い/);
    await DD.sendDevnetDepart(p.fs, deps(p, g));
    assert.match(card(), /keeper A/);
    setLang('en');
    assert.match(card(), /Keeper A does the rest/);
  } finally { setLang('ja'); }
});

// ------------------------------------------------------------------ verify-pr129: the preview IS the signed transaction
// (independent of the page's own decoders: the signed wire is parsed with the SDK's message parser, the Depart's inner
// bytes at the program's offsets — DEPART_INNER_HEAD 4, host 56, transit slot u8, arrive bell u32 LE, tip u64 LE, commit
// 32, seal 264 — and the march fee / seal bond read raw from the Season bytes at frontier-abi layout/world.rs MARCH_FEE
// @280, SEAL_BOND @288, which proc/wide_expedition_exec.rs escrows with the tip; the transit rent is the gateway's
// getMinimumBalanceForRentExemption(OWNED_BRIDGE_LEN = 304 + 32 = 336), which the program charges via init::rent.)
test('verify-pr129: every amount and identity in the preview equals the transaction the wallet signs and the gateway sends', async () => {
  const { parseMessage, COMPUTE_BUDGET_PROGRAM } = await import('../../permutation-server/web/sdk/solana-tx.mjs');
  const { createHash } = await import('node:crypto');
  const p = await page(), g = gateway();
  const s1 = await DD.prepareDevnetDepart(p.fs, deps(p, g));
  assert.equal(s1.status, 'preview', s1.error);
  const pv = s1.preview;
  let shown = null;
  const s2 = await DD.sendDevnetDepart(p.fs, deps(p, g, { sign: async w => { shown = parseTransaction(Uint8Array.from(w)).message; return signWith(W)(w); } }));
  assert.equal(s2.status, 'confirmed', s2.error);
  assert.equal(g.sent.length, 1);
  const tx = parseTransaction(Buffer.from(g.sent[0], 'base64'));
  // the wallet was asked to sign exactly the message the gateway sent, and that message is the previewed one
  assert.equal(Buffer.from(shown).toString('hex'), Buffer.from(tx.message).toString('hex'));
  assert.equal(createHash('sha256').update(tx.message).digest('hex'), pv.digest);
  const m = parseMessage(tx.message);
  assert.equal(m.recentBlockhash, pv.blockhash);
  assert.equal(m.accountKeys.length, pv.accounts);
  // one signer = the fee payer = the previewed payer and signer
  assert.deepEqual(m.signers, [pv.payer]); assert.equal(pv.payer, pv.signer); assert.equal(m.accountKeys[0], pv.payer);
  assert.equal(tx.signatures.length, 1);
  // the fee: one signature × 5,000 and a compute-unit price of 0 (no priority fee); no other instruction
  const budget = m.instructions.filter(ix => ix.programId === COMPUTE_BUDGET_PROGRAM);
  const price = budget.find(ix => ix.data[0] === 3);
  assert.ok(price && Buffer.from(price.data).readBigUInt64LE(1) === 0n, 'cu price 0');
  assert.equal(BigInt(pv.fee), 5000n * BigInt(m.header.numRequiredSignatures));
  const program = m.instructions.filter(ix => ix.programId !== COMPUTE_BUDGET_PROGRAM);
  assert.equal(program.length, 1, 'one program instruction (no transfer, nothing else that moves lamports)');
  assert.equal(program[0].programId, PROGRAM);
  assert.equal(m.instructions.length, 5);
  // the Depart's own bytes: tip, arrival bell, transit slot, commit as previewed
  const d = Buffer.from(program[0].data);
  assert.deepEqual([...d.subarray(0, 4)], [0xda, 0xff, 2, 0]);
  const inner = d.subarray(4);
  assert.equal(inner.length, 369);
  assert.deepEqual([...inner.subarray(0, 4)], [0xda, 0xff, 1, 6]);
  assert.equal(inner[60], pv.transitSlot);
  assert.equal(inner.readUInt32LE(61), pv.arriveBell);
  assert.equal(inner.readBigUInt64LE(65).toString(), pv.tip);
  assert.equal(inner.subarray(73, 105).toString('hex'), pv.commit);
  // the escrow the program takes (tip + Season MARCH_FEE + SEAL_BOND) and the transit rent, read independently
  const raw = Buffer.from(JSON.parse(readFileSync(new URL('fixtures/frontier/season.json', import.meta.url), 'utf8')).bytes_b64, 'base64');
  assert.equal(pv.marchFee, raw.readBigUInt64LE(280).toString());
  assert.equal(pv.sealBond, raw.readBigUInt64LE(288).toString());
  assert.equal(pv.transitRent, '2357120');   // the stand-in RPC answers getMinimumBalanceForRentExemption(336) only
  assert.equal(BigInt(pv.total), inner.readBigUInt64LE(65) + raw.readBigUInt64LE(280) + raw.readBigUInt64LE(288) + 5000n + 2357120n);
});
