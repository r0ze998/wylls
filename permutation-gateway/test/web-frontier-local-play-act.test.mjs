// The page side of the local-play economy path (permutation-server/web/frontier/flocalplay-act.mjs) — joined to the
// relay's own flow (src/frontier/local-play-act.mjs `createLocalPlayAct`) in this process: what the page builds, signs
// and posts is what the relay rebuilds and accepts. A KEY-USING test (scripts/ci/node-key-tests.txt): the wallet is
// the game's own memory-only test wallet, made here and never printed or stored. The runner's RPC and the accounts
// are stand-ins; no process, no chain, no network. It is not a world and not a player's play.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { submitLocalAct, localActRead, localActIntentOf, localActMessage as pageMessage, postLocalAct, localOrderRoute, LOCAL_ACT_NAMES,
  LOCAL_ACT_CONTEXT_PATH, LOCAL_ACT_SUBMIT_PATH, LOCAL_ACT_STATUS_PATH } from '../../permutation-server/web/frontier/flocalplay-act.mjs';
import { createEphemeralWallet } from '../../permutation-server/web/frontier/fephemeral-wallet.mjs';
import { track } from '../../permutation-server/web/frontier/fplay.mjs';
import { seasonAddresses, seasonPda } from '../../permutation-server/web/frontier/faddr.mjs';
import { decode, encode } from '../../permutation-server/web/sdk/base58.mjs';
import { createLocalPlayAct, localActMessage as relayMessage, localActIntent, LocalActError, LOCAL_ACT_COMMANDS, LOCAL_ACT_ROUTES } from '../src/frontier/local-play-act.mjs';
import { LOCAL_PLAY_PROGRAM, LOCAL_PLAY_RULESET_HASH } from '../src/frontier/local-play-relay.mjs';

const W = await createEphemeralWallet({ cluster: 'localnet', hostname: '127.0.0.1', localPlay: true });
const SEASON = seasonPda(LOCAL_PLAY_PROGRAM, 11)[0], ORIGIN = 'http://localhost:41966', HASH = encode(new Uint8Array(32).fill(7)), INSTANCE = 'ab'.repeat(32);
const A = seasonAddresses(LOCAL_PLAY_PROGRAM, '11'), CITIZEN_AT = A.of('Citizen', { wallet: W.address });
const IDENTITY = Object.freeze({ address: W.address, programId: LOCAL_PLAY_PROGRAM, seasonAddress: SEASON, cluster: 'localnet' });
// (the page's holding object carries more than the village's three coordinates; only those three are the intent)
const HOME = { p: 3, q: -2, site: 4, gen: 1, state: 2, tile: 9 };
const ORDERS = {
  Harvest: { v: { holding: HOME }, fields: undefined }, Build: { v: { holding: HOME }, fields: { item: 1 } },
  Train: { v: { holding: HOME }, fields: { unit: 0, n: 10 } }, Muster: { v: { holding: HOME }, fields: { unit: 0, troops: 10, tile: 30 } },
  PlaceHome: { v: { holding: HOME, faction: 2 }, fields: { p: 3, q: -2, site: 4 } },
  Join: { v: { faction: 2, joinGate: null, invite: undefined }, fields: { faction: 2, session: new Uint8Array(32).fill(1), session_expiry: 1785600000n } },
};
const cfg = { localPlay: true, rpc: 'http://127.0.0.1:41964', program: LOCAL_PLAY_PROGRAM, season: SEASON, wallet: W.address, rulesetHash: LOCAL_PLAY_RULESET_HASH, prepareBin: '/x/depart', cuLimit: '1000000', loadedLimit: '67108864' };
function citizenBytes() { const b = new Uint8Array(384), v = new DataView(b.buffer); b.set(Buffer.from('PSF1CITZ'), 0); v.setBigUint64(8, 11n, true); v.setUint16(16, 2, true); b.set(decode(W.address), 64); b.set(decode(CITIZEN_AT).subarray(0, 8), 208); return b; }
function holdingBytes(magic = 'PSF1HOLD') { const b = new Uint8Array(1280), v = new DataView(b.buffer); b.set(Buffer.from(magic), 0); v.setBigUint64(8, 11n, true); v.setInt16(64, 3, true); v.setInt16(66, -2, true); b[68] = 4; b.set(decode(CITIZEN_AT), 72); return b; }
const row = bytes => (bytes === null ? null : { owner: LOCAL_PLAY_PROGRAM, executable: false, lamports: 1, data: [Buffer.from(bytes).toString('base64'), 'base64'] });
/** The relay's real flow over a stand-in runner, and a `post` that hands the page's requests to it (the relay's errors as HTTP refusals). */
function joined({ citizen = row(citizenBytes()), holding = row(holdingBytes()), lost = false, statusValue = undefined, sendError = false, known = false, http = null } = {}) {
  const rpc = []; let sentYet = known;
  const act = createLocalPlayAct({ cfg, runnerInstance: INSTANCE, rpc: async (method, params) => {
    rpc.push(method);
    if (method === 'getLatestBlockhash') return { result: { context: { slot: 90 }, value: { blockhash: HASH, lastValidBlockHeight: 300 } } };
    if (method === 'getMultipleAccounts') return { result: { context: { slot: 91 }, value: params[0].map(a => (a === CITIZEN_AT ? citizen : holding)) } };
    if (method === 'sendTransaction') { sentYet = true; return sendError ? { error: { code: -32002, message: 'preflight failed' } } : { result: encode(Buffer.from(params[0], 'base64').subarray(1, 65)) }; }
    if (method === 'getSignatureStatuses') return { result: { context: { slot: 95, instance: INSTANCE }, value: [sentYet ? (statusValue === undefined ? { slot: 93, confirmationStatus: 'confirmed', err: null } : statusValue) : null] } };
    return { error: { code: -1 } };
  } });
  const posts = [];
  const post = async (origin, path, body) => {
    posts.push([origin, path, body]);
    const route = { [LOCAL_ACT_CONTEXT_PATH]: 'context', [LOCAL_ACT_SUBMIT_PATH]: 'submit', [LOCAL_ACT_STATUS_PATH]: 'status' }[path];
    let answer;
    try { answer = await act[route](JSON.parse(JSON.stringify(body))); } catch (e) { if (e instanceof LocalActError) throw Object.assign(new Error('refused'), { code: e.code, refused: true, status: e.status }); throw e; }
    if (lost && route === 'submit') throw Object.assign(new Error('no answer'), { code: 'LocalActNoAnswer' });
    // (an HTTP failure AFTER the relay did its work — a proxy's 500, a code this page does not know)
    if (http && route === 'submit') throw Object.assign(new Error('refused'), { code: http.code, refused: true, status: http.status });
    return JSON.parse(JSON.stringify(answer));
  };
  const deps = (over = {}) => ({ allowed: () => ({ ok: true, relay: ORIGIN }), identity: () => IDENTITY, rulesetHash: () => LOCAL_PLAY_RULESET_HASH, signer: () => W, post, ...over });
  return { act, rpc, posts, post, deps, sends: () => rpc.filter(m => m === 'sendTransaction').length };
}

test('the same six on both sides; the message the page builds is, byte for byte, the one the relay rebuilds from the stated intent', () => {
  assert.deepEqual([...LOCAL_ACT_NAMES], [...LOCAL_ACT_COMMANDS]);
  assert.deepEqual([LOCAL_ACT_CONTEXT_PATH, LOCAL_ACT_SUBMIT_PATH, LOCAL_ACT_STATUS_PATH].map(p => `POST ${p.slice(3)}`), Object.values(LOCAL_ACT_ROUTES), 'the page\'s paths are the relay\'s routes behind /gw');
  const pins = { program: LOCAL_PLAY_PROGRAM, season: SEASON, seasonId: 11, wallet: W.address, rulesetHash: LOCAL_PLAY_RULESET_HASH };
  for (const [name, o] of Object.entries(ORDERS)) {
    const intent = localActIntentOf(name, o.v, o.fields, W.address);
    assert.deepEqual(JSON.parse(JSON.stringify(localActIntent(JSON.parse(JSON.stringify(intent)), { wallet: W.address }))), JSON.parse(JSON.stringify(intent)), `${name}: the relay takes the page's intent as it is`);
    assert.deepEqual([...pageMessage(intent, IDENTITY, LOCAL_PLAY_RULESET_HASH, HASH)], [...relayMessage(localActIntent(intent, { wallet: W.address }), pins, HASH).message], name);
  }
  // Join: whatever session key the order carried, the one registered is the wallet itself
  assert.equal(localActIntentOf('Join', ORDERS.Join.v, ORDERS.Join.fields, W.address).fields.session, W.address);
});

test('each of the four economy commands, end to end through the relay\'s flow: one context read, one signature, ONE send, followed by its signature', async () => {
  for (const name of ['Harvest', 'Build', 'Train', 'Muster']) {
    const h = joined(), r = await submitLocalAct({ name, ...ORDERS[name] }, h.deps());
    assert.equal(r.ok, true, `${name}: ${r.code}`); assert.equal(r.feePayer, W.address); assert.equal(typeof r.signature, 'string'); assert.equal(r.lastValidBlockHeight, 300);
    assert.deepEqual(h.posts.map(p => p[1]), [LOCAL_ACT_CONTEXT_PATH, LOCAL_ACT_SUBMIT_PATH]); assert.ok(h.posts.every(p => p[0] === ORIGIN));
    assert.deepEqual(h.rpc, ['getLatestBlockhash', 'getMultipleAccounts', 'getSignatureStatuses', 'sendTransaction']); assert.equal(h.sends(), 1);
    // what was posted: the intent in plain JSON and one transaction; never a key
    const sent = h.posts[1][2]; assert.deepEqual(Object.keys(sent), ['schema', 'name', 'subject', 'fields', 'transaction_b64']); assert.deepEqual(sent.subject, { holding: { p: 3, q: -2, site: 4 } });
    // followed with the game's own `track`, reading the relay's status
    const t = await track(r.signature, { tries: 2, every: 0, wait: async () => {}, read: localActRead({ allowed: () => ({ ok: true, relay: ORIGIN }), post: h.post }) });
    assert.deepEqual(t, { ok: true, state: 'landed', slot: 93 }); assert.equal(h.sends(), 1, 'following sends nothing');
  }
  // PlaceHome (the village not there yet) and Join (no Citizen yet) go the same way
  let h = joined({ holding: null }); assert.equal((await submitLocalAct({ name: 'PlaceHome', ...ORDERS.PlaceHome }, h.deps())).ok, true); assert.equal(h.sends(), 1);
  h = joined({ citizen: null }); assert.equal((await submitLocalAct({ name: 'Join', ...ORDERS.Join }, h.deps())).ok, true); assert.equal(h.sends(), 1);
});

test('nothing is sent: a command outside the six, a wide village, a refusal by the relay on the real accounts, a page that is not allowed, a wallet that is not the identity\'s', async () => {
  const none = async (order, deps, code, h) => { const r = await submitLocalAct(order, deps); assert.deepEqual([r.ok, r.code], [false, code]); if (h) assert.equal(h.sends(), 0, code); };
  let h = joined();
  for (const name of ['DeclareSiege', 'Depart', 'SetSession', 'SendCaravan', 'Dissolve', 'Explore']) await none({ name, v: { holding: HOME }, fields: {} }, h.deps(), 'LocalActNotAllowed', h);
  await none({ name: 'Harvest', v: { holding: { p: 129, q: 0, site: 1 } } }, h.deps(), 'LocalActWideHolding', h);
  await none({ name: 'Train', v: { holding: HOME }, fields: { unit: 0, n: 0 } }, h.deps(), 'LocalActShape', h);
  await none({ name: 'Join', v: { faction: 2, joinGate: 'Gate1111111111111111111111111111111111111111' }, fields: ORDERS.Join.fields }, h.deps(), 'LocalActShape', h);
  assert.deepEqual(h.posts, [], 'none of those asked the relay anything');
  // the relay's own refusals, on what the chain holds: a wide Holding, another owner's, no Citizen, an existing Citizen on Join
  h = joined({ holding: row(holdingBytes('PSFXWHL1')) }); await none({ name: 'Harvest', ...ORDERS.Harvest }, h.deps(), 'LocalActWideHolding', h);
  h = joined({ holding: null }); await none({ name: 'Harvest', ...ORDERS.Harvest }, h.deps(), 'LocalActHolding', h);
  h = joined({ citizen: null }); await none({ name: 'Train', ...ORDERS.Train }, h.deps(), 'LocalActCitizen', h);
  h = joined(); await none({ name: 'Join', ...ORDERS.Join }, h.deps(), 'LocalActAlreadyJoined', h);
  // the page: its gate closed, another identity, a destroyed wallet, no ruleset hash, a context naming another wallet
  h = joined(); await none({ name: 'Harvest', ...ORDERS.Harvest }, h.deps({ allowed: () => ({ ok: false, code: 'LocalDepartNotLocalPlay' }) }), 'LocalDepartNotLocalPlay', h);
  await none({ name: 'Harvest', ...ORDERS.Harvest }, h.deps({ identity: () => ({ ...IDENTITY, address: SEASON }) }), 'LocalActSigner', h);
  await none({ name: 'Harvest', ...ORDERS.Harvest }, h.deps({ identity: () => ({ ...IDENTITY, cluster: 'devnet' }) }), 'LocalActIdentity', h);
  await none({ name: 'Harvest', ...ORDERS.Harvest }, h.deps({ signer: () => ({ address: W.address, destroyed: true }) }), 'LocalActSigner', h);
  await none({ name: 'Harvest', ...ORDERS.Harvest }, h.deps({ rulesetHash: () => null }), 'LocalActIdentity', h);
  await none({ name: 'Harvest', ...ORDERS.Harvest }, h.deps({ post: async (o, p) => (p === LOCAL_ACT_CONTEXT_PATH ? { wallet: SEASON, blockhash: { hash: HASH, last_valid_block_height: '300', context_slot: '90' } } : {}) }), 'BadLocalActContext');
});

test('once the ONE POST is made the order has a signature for good: an answer that never comes is "sent, not confirmed" — followed, never sent again; pending is never "failed"', async () => {
  const h = joined({ lost: true }), r = await submitLocalAct({ name: 'Harvest', ...ORDERS.Harvest }, h.deps());
  assert.equal(r.ok, true); assert.equal(r.outcome, 'unknown'); assert.equal(typeof r.signature, 'string'); assert.equal(h.sends(), 1);
  const read = localActRead({ allowed: () => ({ ok: true, relay: ORIGIN }), post: h.post });
  assert.deepEqual(await read(r.signature), { ok: true, state: 'landed', slot: 93 }); assert.equal(h.sends(), 1);
  // a status the chain has not got yet, or only processed: pending — and `track` then says "not confirmed", not "failed" or "expired"
  for (const statusValue of [null, { slot: 93, confirmationStatus: 'processed', err: null }]) {
    const g = joined({ statusValue }), s = await submitLocalAct({ name: 'Build', ...ORDERS.Build }, g.deps());
    const rd = localActRead({ allowed: () => ({ ok: true, relay: ORIGIN }), post: g.post });
    assert.deepEqual(await rd(s.signature), { ok: true, state: 'pending' });
    assert.deepEqual(await track(s.signature, { tries: 2, every: 0, wait: async () => {}, read: rd }), { ok: false, state: 'unknown', code: 'Unconfirmed' });
  }
  // the chain's own refusal is a failure; a signature the relay never sent, or a closed gate, is "no answer", not a failure
  const g = joined({ statusValue: { slot: 93, confirmationStatus: 'confirmed', err: { InstructionError: [2, 'Custom'] } } }), s = await submitLocalAct({ name: 'Train', ...ORDERS.Train }, g.deps());
  const rd = localActRead({ allowed: () => ({ ok: true, relay: ORIGIN }), post: g.post });
  assert.deepEqual(await rd(s.signature), { ok: true, state: 'failed', code: 'TransactionFailed' });
  assert.deepEqual((await rd('never-sent')).ok, false); assert.equal((await localActRead({ allowed: () => ({ ok: false, code: 'Closed' }), post: g.post })(s.signature)).ok, false);
});

test('after the POST began, "not sent" is said ONLY for the relay\'s refusals before its send; a send the runner refused, a signature already known, and any other HTTP failure KEEP the signature', async () => {
  const { LOCAL_ACT_PRESEND_REFUSALS } = await import('../../permutation-server/web/frontier/flocalplay-act.mjs');
  const relay = await import('../src/frontier/local-play-act.mjs');
  assert.deepEqual([...LOCAL_ACT_PRESEND_REFUSALS], [...relay.LOCAL_ACT_PRESEND_REFUSALS], 'one list on both sides');
  for (const c of ['LocalActSendRefused', 'LocalActMessageUsed', 'LocalActUnknownSignature', 'LocalActRefused', 'LocalActFailed']) assert.ok(!LOCAL_ACT_PRESEND_REFUSALS.includes(c), c);
  const read = h => localActRead({ allowed: () => ({ ok: true, relay: ORIGIN }), post: h.post });
  // (1) HTTP 502 LocalActSendRefused: the relay CALLED the runner's send. The order keeps its signature — "sent, outcome unknown"
  let h = joined({ sendError: true, statusValue: null }), r = await submitLocalAct({ name: 'Train', ...ORDERS.Train }, h.deps());
  assert.deepEqual([r.ok, r.outcome, r.relayCode], [true, 'unknown', 'LocalActSendRefused']); assert.equal(typeof r.signature, 'string'); assert.equal(h.sends(), 1);
  // it is followed by that signature (the relay recorded it before the send) and is "not confirmed" — not "not sent", not "failed"
  assert.deepEqual(await read(h)(r.signature), { ok: true, state: 'pending' });
  assert.deepEqual(await track(r.signature, { tries: 2, every: 0, wait: async () => {}, read: read(h) }), { ok: false, state: 'unknown', code: 'Unconfirmed' });
  assert.equal(h.sends(), 1, 'nothing was sent again');
  // (2) the runner ALREADY KNOWS the signature (LocalActMessageUsed): this relay sends nothing, and the order keeps its signature
  h = joined({ known: true }); r = await submitLocalAct({ name: 'Harvest', ...ORDERS.Harvest }, h.deps());
  assert.deepEqual([r.ok, r.outcome, r.relayCode], [true, 'unknown', 'LocalActMessageUsed']); assert.equal(h.sends(), 0);
  assert.deepEqual(await read(h)(r.signature), { ok: true, state: 'landed', slot: 93 }, 'and its status is readable: the relay recorded the signature');
  // (3) any other HTTP failure after the relay worked — a 500, a 502 with a code this page does not know, a 409 that is not on the list
  for (const http of [{ status: 500, code: 'LocalPlayUnavailable' }, { status: 502, code: 'BadGateway' }, { status: 409, code: 'LocalActMessageUsed' }, { status: 400, code: 'SomethingElse' }]) {
    h = joined({ http }); r = await submitLocalAct({ name: 'Build', ...ORDERS.Build }, h.deps());
    assert.deepEqual([r.ok, r.outcome, r.relayCode], [true, 'unknown', http.code], JSON.stringify(http)); assert.equal(typeof r.signature, 'string'); assert.equal(h.sends(), 1);
  }
  // (4) every refusal BEFORE the send is still "not sent", with its code, and no signature is claimed
  for (const [over, code] of [[{ holding: row(holdingBytes('PSFXWHL1')) }, 'LocalActWideHolding'], [{ holding: null }, 'LocalActHolding'], [{ citizen: null }, 'LocalActCitizen']]) {
    h = joined(over); r = await submitLocalAct({ name: 'Muster', ...ORDERS.Muster }, h.deps());
    assert.deepEqual([r.ok, r.code, r.signature], [false, code, undefined]); assert.equal(h.sends(), 0);
  }
  // a pre-send CODE that arrives without the relay's refusal mark (a thrown error, not an HTTP refusal) is not believed either
  h = joined(); r = await submitLocalAct({ name: 'Harvest', ...ORDERS.Harvest }, h.deps({ post: async (o, p, b) => { if (p === LOCAL_ACT_SUBMIT_PATH) { await h.post(o, p, b); throw Object.assign(new Error('x'), { code: 'LocalActHolding' }); } return h.post(o, p, b); } }));
  assert.deepEqual([r.ok, r.outcome], [true, 'unknown']); assert.equal(h.sends(), 1);
});

test('WHERE AN ORDER GOES, for every command the page can send: in local play only the six in their plain form go to the local path, everything else is refused; outside local play nothing ever does', async () => {
  const { localOrderRoute } = await import('../../permutation-server/web/frontier/flocalplay-act.mjs');
  const { SIGNED_BY } = await import('../../permutation-server/web/frontier/fplay.mjs');
  // (wide-local-playable: the wide claim is not an SDK shape — flocalplay-wide.mjs builds it — so it is not among SIGNED_BY)
  // (wide -> wide marches, #94: nor are the wide village's WideTrain / WideMuster / WideDepart — flocalplay-wide-host.mjs)
  // (territory-impl: nor is the single-tile claim — flocalplay-territory.mjs)
  const NOT_SDK = ['WideClaim', 'TerritoryClaim', 'WideTrain', 'WideMuster', 'WideDepart', 'ResearchPledge', 'ResearchApply'];  // (research: flocalplay-research.mjs)
  for (const n of NOT_SDK) assert.ok(!Object.hasOwn(SIGNED_BY, n), n);
  const names = [...Object.keys(SIGNED_BY), ...NOT_SDK], ID = IDENTITY, v = { holding: HOME };
  assert.ok(names.length > 20 && LOCAL_ACT_NAMES.every(n => names.includes(n)));
  for (const name of names) {
    const want = LOCAL_ACT_NAMES.includes(name) ? 'local-act' : 'refuse';
    assert.equal(localOrderRoute({ localPlay: ID, name, v, signer: undefined, requester: null }), want, name);
    // not local play (production, any ordinary page): the general path, always — this module is never chosen
    for (const localPlay of [null, undefined, false, 0, '']) assert.equal(localOrderRoute({ localPlay, name, v, signer: undefined, requester: null }), 'general', name);
  }
  assert.deepEqual(names.filter(n => localOrderRoute({ localPlay: ID, name: n, v, signer: undefined, requester: null }) === 'local-act').sort(), [...LOCAL_ACT_NAMES].sort());
  // the expedition and conquest steps keep their own paths: none of them is an "economy command"
  for (const name of ['Depart', 'DeclareSiege', 'Dissolve', 'Garrison', 'Explore', 'SettleTransit', 'SettleExplore', 'SetSession', 'JoinResident', 'SendCaravan', 'Vote']) assert.equal(localOrderRoute({ localPlay: ID, name, v, signer: undefined, requester: null }), 'refuse', name);
  // one of the six in any other form is refused too: a settle shape, a wallet-only shape, a requester, accounts as a function, no subjects
  for (const name of LOCAL_ACT_NAMES) {
    for (const over of [{ signer: null }, { signer: 'wallet' }, { signer: 'session' }, { requester: { publicKey: 'x' } }, { v: () => ({}) }, { v: null }, { v: 'x' }, { v: [HOME] }]) {
      assert.equal(localOrderRoute({ localPlay: ID, name, v, signer: undefined, requester: null, ...over }), 'refuse', `${name} ${JSON.stringify(Object.keys(over))}`);
    }
  }
  for (const name of ['harvest', 'HARVEST', 'Harvest ', '', undefined, null, 7, 'toString']) assert.equal(localOrderRoute({ localPlay: ID, name, v, signer: undefined, requester: null }), 'refuse', String(name));
});

test('the page\'s own gate decides whether anything is asked at all: not local play, not localnet, not a loopback page, another wallet — nothing is built, signed or posted', async () => {
  const { localDepartAllowed } = await import('../../permutation-server/web/frontier/flocalplay-depart.mjs');
  const gateOf = over => () => localDepartAllowed({ localPlay: IDENTITY, cluster: 'localnet', hostname: 'localhost', relay: `${ORIGIN}/gw`, wallet: W.address, signer: W, ...over });
  // the real gate, open: the order goes through (the relay base it returns is where the three POSTs go)
  let h = joined(); const open = gateOf({})(); assert.equal(open.ok, true, open.code);
  let r = await submitLocalAct({ name: 'Harvest', ...ORDERS.Harvest }, h.deps({ allowed: gateOf({}) })); assert.equal(r.ok, true, r.code); assert.equal(h.sends(), 1); assert.ok(h.posts.every(p => p[0] === open.relay));
  // closed, for each reason: nothing is posted, nothing is sent
  for (const over of [{ localPlay: null }, { cluster: 'devnet' }, { cluster: 'mainnet-beta' }, { hostname: 'play.example.com' }, { hostname: '192.168.1.5' }, { relay: 'https://relay.example.com/gw' },
    { wallet: SEASON }, { wallet: null }, { signer: null }, { signer: { address: W.address, destroyed: true } }, { localPlay: { ...IDENTITY, cluster: 'devnet' } }]) {
    h = joined(); r = await submitLocalAct({ name: 'Harvest', ...ORDERS.Harvest }, h.deps({ allowed: gateOf(over) }));
    assert.equal(r.ok, false, JSON.stringify(Object.keys(over))); assert.deepEqual(h.posts, []); assert.equal(h.sends(), 0);
  }
  // a relay that does not serve these routes (its context answers 404): said as "not served" — local play there is reads only, as before
  h = joined(); r = await submitLocalAct({ name: 'Harvest', ...ORDERS.Harvest }, h.deps({ post: async () => { throw Object.assign(new Error('refused'), { code: 'NotFound', refused: true, status: 404 }); } }));
  assert.deepEqual([r.ok, r.code], [false, 'LocalActNotServed']); assert.equal(h.sends(), 0);
});

test('SENT, NOT CONFIRMED: the order is held by its signature; a second press of the same order sends NOTHING and only asks; it is let go when the chain says landed or refused', async () => {
  const { createLocalActLedger, settleLocalAct, localActKey, localActScope } = await import('../../permutation-server/web/frontier/flocalplay-act.mjs');
  const S = localActScope({ identity: IDENTITY, relay: ORIGIN }); assert.equal(typeof S, 'string');
  // the same order has the same key; another village, amount, command or nation is another order
  const k = (n, o = ORDERS[n]) => localActKey(n, o.v, o.fields);
  assert.equal(k('Train'), localActKey('Train', { holding: { ...HOME, extra: 1 } }, { unit: 0, n: 10 }), 'only the village\'s coordinates and the fields count');
  assert.equal(new Set([k('Train'), localActKey('Train', { holding: HOME }, { unit: 0, n: 11 }), localActKey('Train', { holding: { ...HOME, site: 5 } }, { unit: 0, n: 10 }), k('Muster'), k('Harvest'), k('Build'), k('PlaceHome'), k('Join'),
    localActKey('Join', { faction: 3 }, { faction: 3, session_expiry: 1785600000n })]).size, 9);
  const ledger = createLocalActLedger();
  assert.equal(ledger.held(S,k('Train')), null); assert.deepEqual(ledger.list(S), []);
  // PRESS 1 (as the controller does it): send; the answer is lost; the order is HELD the moment it has a signature
  let status = null;   // (what the chain says of the signature: not there yet)
  const h = joined({ lost: true }); const press = async name => submitLocalAct({ name, ...ORDERS[name] }, h.deps());
  const reader = (hh, value) => localActRead({ allowed: () => ({ ok: true, relay: ORIGIN }), post: async (o, p, b) => { if (p !== LOCAL_ACT_STATUS_PATH) return hh.post(o, p, b); if (value() === 'gone') throw Object.assign(new Error('x'), { code: 'LocalActNoAnswer' });
    return { signature: b.signature, status: value() === null ? 'pending' : value().err ? 'failed' : 'confirmed', err: value()?.err ?? null, slot: 93 }; } });
  const r1 = await press('Train'); assert.equal(r1.ok, true); ledger.hold(S,k('Train'), { name: 'Train', signature: r1.signature });
  assert.throws(() => ledger.hold(S,k('Train'), { name: 'Train', signature: 'another' }), e => e.code === 'LocalActLedger', 'one held transaction per order');
  assert.deepEqual(ledger.list(S), [{ key: k('Train'), name: 'Train', signature: r1.signature }]); assert.equal(h.sends(), 1);
  // PRESS 2 of the same order while it is held: ONLY a question — pending, then no answer at all: still held, nothing sent
  assert.deepEqual(await settleLocalAct(ledger, S,k('Train'), reader(h, () => status)), { state: 'unconfirmed', signature: r1.signature });
  status = 'gone'; assert.deepEqual(await settleLocalAct(ledger, S,k('Train'), reader(h, () => status)), { state: 'unconfirmed', signature: r1.signature });
  assert.equal(ledger.held(S,k('Train')).signature, r1.signature); assert.equal(h.sends(), 1, 'the second and third press sent nothing');
  // another order (another amount, another command) is not held by it
  assert.equal(ledger.held(S,localActKey('Train', { holding: HOME }, { unit: 0, n: 11 })), null); assert.equal(ledger.held(S,k('Muster')), null);
  // the chain now has it: landed → let go; the next press of that order is a new order
  status = { err: null }; assert.deepEqual(await settleLocalAct(ledger, S,k('Train'), reader(h, () => status)), { state: 'landed', signature: r1.signature, slot: 93 });
  assert.equal(ledger.held(S,k('Train')), null); assert.deepEqual(await settleLocalAct(ledger, S,k('Train'), reader(h, () => status)), { state: 'none' });
  // the chain refused it: let go as well, as a failure — never as "not sent"
  // (another order, on a relay of its own: this test's stand-in runner answers one signature per harness)
  const h2 = joined({ lost: true }), r2 = await submitLocalAct({ name: 'Muster', ...ORDERS.Muster }, h2.deps()); ledger.hold(S,k('Muster'), { name: 'Muster', signature: r2.signature });
  status = { err: { InstructionError: [2, 'Custom'] } }; assert.deepEqual(await settleLocalAct(ledger, S,k('Muster'), reader(h2, () => status)), { state: 'failed', signature: r2.signature, code: 'TransactionFailed' });
  assert.deepEqual(ledger.list(S), []); assert.deepEqual([h.sends(), h2.sends()], [1, 1], 'two orders, one send each — the questions sent nothing');
});

test('Join is ONE order whatever its re-made expiry says; and the ledger is kept per wallet, world and relay — another scope neither sees, asks about nor releases an order, and it is not lost', async () => {
  const { createLocalActLedger, settleLocalAct, localActKey, localActScope } = await import('../../permutation-server/web/frontier/flocalplay-act.mjs');
  // JOIN: the controller works the expiry out from the clock at every press — a second later it is another number. The key is the same.
  const join = t => localActKey('Join', { faction: 2 }, { faction: 2, session_expiry: BigInt(1785600000 + t) });
  assert.equal(join(0), join(1)); assert.equal(join(0), join(86400)); assert.equal(join(0), localActKey('Join', { faction: 2 }, { faction: 2, session: new Uint8Array(32).fill(9), session_expiry: 1n }));
  assert.equal(join(0), localActKey('Join', { faction: 2, joinGate: null, invite: undefined }, {}), 'nothing but the nation tells two Joins apart');
  assert.notEqual(join(0), localActKey('Join', { faction: 3 }, { faction: 3, session_expiry: 1785600000n }));
  // …so an unknown Join holds the next press of Join, one second later: only a question, nothing sent
  const S = localActScope({ identity: IDENTITY, relay: ORIGIN }), ledger = createLocalActLedger();
  const h = joined({ citizen: null, lost: true }), r = await submitLocalAct({ name: 'Join', v: { faction: 2 }, fields: { faction: 2, session_expiry: 1785600000n } }, h.deps());
  assert.equal(r.ok, true); ledger.hold(S, join(0), { name: 'Join', signature: r.signature });
  assert.equal(ledger.held(S, join(1)).signature, r.signature, 'the press one second later finds the Join already sent');
  const pending = localActRead({ allowed: () => ({ ok: true, relay: ORIGIN }), post: async (o, p, b) => ({ signature: b.signature, status: 'pending' }) });
  assert.deepEqual(await settleLocalAct(ledger, S, join(1), pending), { state: 'unconfirmed', signature: r.signature }); assert.equal(h.sends(), 1);
  // the other commands still tell their fields apart (another amount is another order)
  assert.notEqual(localActKey('Train', { holding: HOME }, { unit: 0, n: 10 }), localActKey('Train', { holding: HOME }, { unit: 0, n: 11 }));
  // SCOPES: another wallet, another program or Season, another relay — each its own; none without a full identity and a relay
  const other = { ...IDENTITY, address: SEASON }, scopes = [S, localActScope({ identity: other, relay: ORIGIN }), localActScope({ identity: { ...IDENTITY, seasonAddress: W.address }, relay: ORIGIN }),
    localActScope({ identity: { ...IDENTITY, programId: W.address }, relay: ORIGIN }), localActScope({ identity: IDENTITY, relay: 'http://localhost:41971' })];
  assert.equal(new Set(scopes).size, 5); assert.ok(scopes.every(s => typeof s === 'string'));
  for (const bad of [{ identity: null, relay: ORIGIN }, { identity: IDENTITY, relay: null }, { identity: IDENTITY, relay: '' }, { identity: { ...IDENTITY, address: 'x' }, relay: ORIGIN }]) assert.equal(localActScope(bad), null);
  // an order held under one scope: not found, not asked about and not released under any other — and still there afterwards
  const asked = [], read = async sig => { asked.push(sig); return { ok: true, state: 'landed', slot: 1 }; };
  for (const s of scopes.slice(1)) {
    assert.equal(ledger.held(s, join(0)), null); assert.deepEqual(ledger.list(s), []);
    assert.deepEqual(await settleLocalAct(ledger, s, join(0), read), { state: 'none' }); assert.equal(ledger.release(s, join(0)), false);
  }
  assert.deepEqual(asked, [], 'no other scope asked the relay about this signature');
  assert.equal(ledger.held(S, join(0)).signature, r.signature, 'and it is still held where it was sent');
  // the same order under another scope is that scope's own; both are kept
  ledger.hold(scopes[1], join(0), { name: 'Join', signature: 'other-wallets-signature' });
  assert.deepEqual([ledger.held(S, join(0)).signature, ledger.held(scopes[1], join(0)).signature], [r.signature, 'other-wallets-signature']);
  // a null scope (the gate closed, no identity): holds nothing and finds nothing
  assert.throws(() => ledger.hold(null, join(0), { name: 'Join', signature: 'x' }), e => e.code === 'LocalActLedger'); assert.equal(ledger.held(null, join(0)), null); assert.deepEqual(ledger.list(null), []);
  // back under the first scope: asked, landed, let go — the other scope's entry is untouched
  assert.deepEqual(await settleLocalAct(ledger, S, join(0), read), { state: 'landed', signature: r.signature, slot: 1 }); assert.deepEqual(asked, [r.signature]);
  assert.equal(ledger.held(S, join(0)), null); assert.equal(ledger.held(scopes[1], join(0)).signature, 'other-wallets-signature');
});

test('IN FLIGHT: while a Join waits on its context, a second Join pressed a second later (another expiry) starts NOTHING — one context read, one signature, one send; other scopes and other orders are not blocked', async () => {
  const { createLocalActLedger, withLocalActSlot, localActKey, localActScope } = await import('../../permutation-server/web/frontier/flocalplay-act.mjs');
  const ledger = createLocalActLedger(), S = localActScope({ identity: IDENTITY, relay: ORIGIN }), h = joined({ citizen: null });
  // the relay's context answer is HELD BACK: press A is suspended inside its first await, with no signature yet
  let letGo; const gate = new Promise(r => { letGo = r; }); let contexts = 0;
  const post = async (o, p, b) => { if (p === LOCAL_ACT_CONTEXT_PATH) { contexts++; await gate; } return h.post(o, p, b); };
  const pressJoin = expiry => { const v = { faction: 2 }, fields = { faction: 2, session_expiry: expiry };
    return withLocalActSlot(ledger, S, localActKey('Join', v, fields), async () => { const r = await submitLocalAct({ name: 'Join', v, fields }, h.deps({ post })); if (r.ok) ledger.hold(S, localActKey('Join', v, fields), { name: 'Join', signature: r.signature }); return r; }); };
  const a = pressJoin(1785600000n);
  await new Promise(r => setImmediate(r));   // (A is now waiting on the context)
  assert.equal(contexts, 1);
  // press B, one second later: another expiry — the ordinary key would differ; here it is the same order, and it is in flight
  const b = await pressJoin(1785600001n);
  assert.deepEqual(b, { ok: false, code: 'InFlight' }); assert.equal(contexts, 1, 'B asked the relay nothing'); assert.equal(h.sends(), 0);
  // a third and a fourth press, same outcome; another nation's Join and another command are other orders and are not blocked
  assert.deepEqual(await pressJoin(1785600002n), { ok: false, code: 'InFlight' });
  assert.equal(ledger.begin(S, localActKey('Join', { faction: 3 }, {})), true); ledger.end(S, localActKey('Join', { faction: 3 }, {}));
  assert.equal(ledger.begin(S, localActKey('Harvest', { holding: HOME }, {})), true); ledger.end(S, localActKey('Harvest', { holding: HOME }, {}));
  // another scope (another wallet's page) is not blocked by this one's flight
  const S2 = localActScope({ identity: { ...IDENTITY, address: SEASON }, relay: ORIGIN }); assert.equal(ledger.begin(S2, localActKey('Join', { faction: 2 }, {})), true); ledger.end(S2, localActKey('Join', { faction: 2 }, {}));
  // the context arrives: A goes on — ONE signature, ONE send — and is held; the slot is given back
  letGo(); const ra = await a;
  assert.equal(ra.ok, true); assert.equal(h.sends(), 1); assert.equal(h.posts.filter(p => p[1] === LOCAL_ACT_SUBMIT_PATH).length, 1);
  assert.equal(ledger.held(S, localActKey('Join', { faction: 2 }, {})).signature, ra.signature);
  // and now the order is HELD: the next press is refused the slot too (it may only ask) — still one send
  assert.deepEqual(await pressJoin(1785600005n), { ok: false, code: 'InFlight' }); assert.equal(h.sends(), 1); assert.equal(contexts, 1);
  // a refusal or a throw inside the work gives the slot back
  const k = localActKey('Train', { holding: HOME }, { unit: 0, n: 1 });
  await assert.rejects(withLocalActSlot(ledger, S, k, async () => { throw new Error('x'); })); assert.equal(ledger.begin(S, k), true); ledger.end(S, k);
  assert.deepEqual(await withLocalActSlot(ledger, null, k, async () => ({ ok: true })), { ok: false, code: 'InFlight' }, 'no scope, no slot');
});

test('FOLLOWED UNDER THE SCOPE OF THE SEND: at the relay it was sent through, only while the page is still that scope; a result that arrives for another page is not shown and releases nothing', async () => {
  const { createLocalActLedger, followLocalAct, settleLocalAct, localActKey, localActScope } = await import('../../permutation-server/web/frontier/flocalplay-act.mjs');
  const S = localActScope({ identity: IDENTITY, relay: ORIGIN }), K = localActKey('Train', { holding: HOME }, { unit: 0, n: 10 }), noWait = async () => {};
  // a real order through the relay's flow, its answer lost: held under S
  const h = joined({ lost: true, statusValue: null }), r = await submitLocalAct({ name: 'Train', ...ORDERS.Train }, h.deps());
  const ledger = createLocalActLedger(); ledger.hold(S, K, { name: 'Train', signature: r.signature });
  // (1) still the same scope, the chain does not have it yet: unconfirmed — every poll went to the relay of the send
  let scopeNow = S; const still = () => scopeNow === S, asked = [];
  const post = async (o, p, b) => { asked.push(o); return h.post(o, p, b); };
  assert.deepEqual(await followLocalAct(r.signature, { origin: ORIGIN, still, post, tries: 3, every: 0, wait: noWait }), { state: 'unconfirmed' });
  assert.deepEqual(asked, [ORIGIN, ORIGIN, ORIGIN]);
  // (2) the page becomes another scope BEFORE a poll: the following stops at once, nothing more is asked
  asked.length = 0; scopeNow = 'another';
  assert.deepEqual(await followLocalAct(r.signature, { origin: ORIGIN, still, post, tries: 5, every: 0, wait: noWait }), { state: 'left' }); assert.deepEqual(asked, []);
  // (3) the page becomes another scope WHILE a poll is awaited, and that poll's answer is "landed": NOT landed for this page
  scopeNow = S; const landedLate = async (o, p, b) => { scopeNow = 'another'; return { signature: b.signature, status: 'confirmed', err: null, slot: 93 }; };
  assert.deepEqual(await followLocalAct(r.signature, { origin: ORIGIN, still, post: landedLate, tries: 5, every: 0, wait: noWait }), { state: 'left' });
  assert.equal(ledger.held(S, K).signature, r.signature, 'still held under the scope it was sent under');
  // (4) the question of a held order, the same way: the page left before the read, or during it → 'left', nothing released
  scopeNow = 'another'; const reads = [];
  const read = async sig => { reads.push(sig); return { ok: true, state: 'landed', slot: 93 }; };
  assert.deepEqual(await settleLocalAct(ledger, S, K, read, { still }), { state: 'left', signature: r.signature }); assert.deepEqual(reads, [], 'not even asked');
  scopeNow = S; const readThenLeave = async sig => { reads.push(sig); scopeNow = 'another'; return { ok: true, state: 'landed', slot: 93 }; };
  assert.deepEqual(await settleLocalAct(ledger, S, K, readThenLeave, { still }), { state: 'left', signature: r.signature });
  assert.equal(ledger.held(S, K).signature, r.signature, 'a result that arrived for another page released nothing');
  // (5) the other scope does not see it and cannot ask about it; nothing was sent by any of this
  assert.deepEqual(await settleLocalAct(ledger, 'another', K, read, { still: () => true }), { state: 'none' }); assert.equal(h.sends(), 1);
  // (6) back under the scope of the send: asked at its relay, landed, released
  scopeNow = S; assert.deepEqual(await settleLocalAct(ledger, S, K, read, { still }), { state: 'landed', signature: r.signature, slot: 93 }); assert.equal(ledger.held(S, K), null);
  // a failure is said only under the scope too
  assert.deepEqual(await followLocalAct('sig', { origin: ORIGIN, still: () => true, post: async (o, p, b) => ({ signature: b.signature, status: 'failed', err: 'Custom' }), tries: 1, wait: noWait }), { state: 'failed', code: 'TransactionFailed' });
});

test('THE MOMENT THE SEND HAS A SIGNATURE: held first, then the scope, then the page\'s callback — a scope that changed during the send gets no callback and no signature; a callback that throws loses nothing', async () => {
  const { createLocalActLedger, settleLocalSend, settleLocalAct, localActKey, localActScope } = await import('../../permutation-server/web/frontier/flocalplay-act.mjs');
  const S = localActScope({ identity: IDENTITY, relay: ORIGIN }), S2 = localActScope({ identity: { ...IDENTITY, address: SEASON }, relay: ORIGIN });
  const KJ = localActKey('Join', { faction: 2 }, {}), KP = localActKey('PlaceHome', ORDERS.PlaceHome.v, ORDERS.PlaceHome.fields);
  // a real Join through the relay's flow (a real signature)
  const h = joined({ citizen: null }), r = await submitLocalAct({ name: 'Join', ...ORDERS.Join }, h.deps()); assert.equal(r.ok, true);
  // (1) the ordinary case: when the callback runs, the order is ALREADY held
  let ledger = createLocalActLedger(), seen = null;
  let out = settleLocalSend(ledger, { scope: S, key: KJ }, 'Join', r, { still: () => true, onSent: (x, under) => { seen = { heldAlready: ledger.held(S, KJ)?.signature, got: x.signature, under }; } });
  assert.deepEqual(out, { state: 'held', callbackError: null }); assert.deepEqual(seen, { heldAlready: r.signature, got: r.signature, under: { scope: S } }, 'and it is told the scope of the send, for the note it writes');
  // (2) THE SCOPE CHANGED WHILE THE SEND WAS AWAITED (another wallet connected): the callback is NOT called — the old
  //     signature is never written into the new page's state — and the order is held under the scope it was sent under
  ledger = createLocalActLedger(); const homeState = { pending: null };   // (what `saveHomePatch` would write for the page as it is NOW)
  out = settleLocalSend(ledger, { scope: S, key: KJ }, 'Join', r, { still: () => false, onSent: x => { homeState.pending = { kind: 'Join', signature: x.signature }; } });
  assert.deepEqual(out, { state: 'left' }); assert.deepEqual(homeState, { pending: null }, 'nothing of the old scope was written');
  assert.equal(ledger.held(S, KJ).signature, r.signature, 'held under the scope of the send'); assert.equal(ledger.held(S2, KJ), null); assert.deepEqual(ledger.list(S2), []);
  // …the new scope's own Join is its own order, not blocked and not confused with it
  assert.equal(ledger.begin(S2, KJ), true); ledger.end(S2, KJ); assert.equal(ledger.begin(S, KJ), false, 'the old scope\'s Join cannot be started again');
  // …and back under the old scope it is asked about by that signature, and let go when landed
  assert.deepEqual(await settleLocalAct(ledger, S, KJ, async () => ({ ok: true, state: 'landed', slot: 9 }), { still: () => true }), { state: 'landed', signature: r.signature, slot: 9 });
  // (3) THE CALLBACK THROWS: the order is held all the same, the error comes back as a value, nothing is thrown past the hold
  ledger = createLocalActLedger(); const boom = new Error('saveHomePatch failed');
  out = settleLocalSend(ledger, { scope: S, key: KP }, 'PlaceHome', { signature: 'SigOfPlaceHome' }, { still: () => true, onSent: () => { throw boom; } });
  assert.deepEqual([out.state, out.callbackError], ['held', boom]); assert.equal(ledger.held(S, KP).signature, 'SigOfPlaceHome');
  assert.equal(ledger.begin(S, KP), false, 'and the same PlaceHome cannot be sent again');
  out = settleLocalSend(ledger, { scope: S, key: localActKey('Train', { holding: HOME }, { unit: 0, n: 1 }) }, 'Train', { signature: 'SigT' }, { still: () => true, onSent: () => { throw undefined; } });
  assert.equal(out.state, 'held'); assert.ok(out.callbackError instanceof Error);
  // no callback given (Train and Muster pass none): held, and that is all
  ledger = createLocalActLedger(); assert.deepEqual(settleLocalSend(ledger, { scope: S, key: KP }, 'Muster', { signature: 'SigM' }, { still: () => true }), { state: 'held', callbackError: null });
  // a signature is required to hold: a send without one is not a send
  assert.throws(() => settleLocalSend(createLocalActLedger(), { scope: S, key: KP }, 'Muster', { signature: '' }, { still: () => true }), e => e.code === 'LocalActLedger');
});

test('COMING BACK TO A PENDING Join / PlaceHome: asked once at this scope\'s relay; an unknown outcome or a changed scope keeps the note and the held order and sends nothing; only the chain\'s own word lets go', async () => {
  const { createLocalActLedger, recheckLocalPending, localActKey, localActScope } = await import('../../permutation-server/web/frontier/flocalplay-act.mjs');
  const S = localActScope({ identity: IDENTITY, relay: ORIGIN }), S2 = localActScope({ identity: { ...IDENTITY, address: SEASON }, relay: ORIGIN }), KJ = localActKey('Join', { faction: 2 }, {});
  // a real Join through the relay's flow whose answer was lost: the home choice holds its "pending" note, the ledger holds the order
  const h = joined({ citizen: null, lost: true, statusValue: null }), r = await submitLocalAct({ name: 'Join', ...ORDERS.Join }, h.deps());
  const ledger = createLocalActLedger(); ledger.hold(S, KJ, { name: 'Join', signature: r.signature });
  const note = { pending: { kind: 'Join', signature: r.signature, scope: S } };   // (the page's memory-only home record: the note carries the scope of the SEND)
  let scopeNow = S; const still = () => scopeNow === S; const asked = [];
  const post = async (o, p, b) => { asked.push([o, p]); return h.post(o, p, b); };
  // (1) the chain does not have it yet: UNCONFIRMED — one question, to this scope's relay; the order stays held; nothing sent
  assert.deepEqual(await recheckLocalPending(ledger, S, note.pending, { origin: ORIGIN, still, post }), { state: 'unconfirmed' });
  assert.deepEqual(asked, [[ORIGIN, LOCAL_ACT_STATUS_PATH]]); assert.equal(ledger.held(S, KJ).signature, r.signature); assert.equal(h.sends(), 1, 'the question sent nothing');
  // …and no answer at all (the relay unreachable) is the same: unconfirmed, held
  assert.deepEqual(await recheckLocalPending(ledger, S, note.pending, { origin: ORIGIN, still, post: async () => { throw Object.assign(new Error('x'), { code: 'LocalActNoAnswer' }); } }), { state: 'unconfirmed' });
  assert.equal(ledger.held(S, KJ).signature, r.signature);
  // …so the same order cannot be started again: the slot is refused while it is held
  assert.equal(ledger.begin(S, localActKey('Join', { faction: 2 }, { faction: 2, session_expiry: 1785600999n })), false);
  // (2) THE SCOPE CHANGED (another wallet's page): not asked at all — and an answer that arrives after the change is not used
  asked.length = 0; scopeNow = S2;
  assert.deepEqual(await recheckLocalPending(ledger, S, note.pending, { origin: ORIGIN, still, post }), { state: 'left' }); assert.deepEqual(asked, []);
  scopeNow = S; const landedLate = async (o, p, b) => { scopeNow = S2; return { signature: b.signature, status: 'confirmed', err: null, slot: 9 }; };
  assert.deepEqual(await recheckLocalPending(ledger, S, note.pending, { origin: ORIGIN, still, post: landedLate }), { state: 'left' });
  assert.equal(ledger.held(S, KJ).signature, r.signature, 'a result that arrived for another page released nothing');
  // A NOTE OF ANOTHER SCOPE — the same wallet and world through ANOTHER RELAY, another wallet, or a note with no scope at
  // all (the home record's own key has no relay in it): NOT ASKED. A signature is never asked of a relay it was not sent
  // through, and nothing is released.
  asked.length = 0;
  const S3 = localActScope({ identity: IDENTITY, relay: 'http://localhost:41971' });   // (this wallet, this world — the page now talks to another relay)
  const wouldSayLanded = async (o, p, b) => { asked.push([o, p]); return { signature: b.signature, status: 'confirmed', err: null, slot: 9 }; };
  for (const [now, n] of [[S3, note.pending], [S2, note.pending], [S, { kind: 'Join', signature: r.signature }], [S, { kind: 'Join', signature: r.signature, scope: S3 }], [S, { kind: 'Join', signature: r.signature, scope: null }]]) {
    assert.deepEqual(await recheckLocalPending(ledger, now, n, { origin: 'http://localhost:41971', still: () => true, post: wouldSayLanded }), { state: 'other-scope' });
  }
  assert.deepEqual(asked, [], 'the new relay was asked nothing about the old relay\'s signature'); assert.equal(ledger.held(S, KJ).signature, r.signature, 'and this scope\'s order is untouched');
  for (const [sc, n] of [[null, note.pending], ['', note.pending], [S, { ...note.pending, signature: '' }], [S, null], [S, undefined]]) assert.deepEqual(await recheckLocalPending(ledger, sc, n, { origin: ORIGIN, still: () => true, post }), { state: 'left' });
  // ALREADY LET GO (it landed and the ledger released it; the page has not shown the Citizen yet): the note of THIS scope
  // is still asked about by its signature — the ledger need not hold it — and says landed again; nothing waits for ever
  { const empty = createLocalActLedger();
    assert.deepEqual(await recheckLocalPending(empty, S, note.pending, { origin: ORIGIN, still: () => true, post: async (o, p, b) => ({ signature: b.signature, status: 'confirmed', err: null, slot: 9 }) }), { state: 'landed', slot: 9 });
    // …and a relay that no longer knows the signature (restarted): unconfirmed — the caller then goes by what the page sees (the Citizen exists)
    assert.deepEqual(await recheckLocalPending(empty, S, note.pending, { origin: ORIGIN, still: () => true, post: async () => { throw Object.assign(new Error('refused'), { code: 'LocalActUnknownSignature', refused: true, status: 404 }); } }), { state: 'unconfirmed' }); }
  // the home record keeps the note's scope as it is (home.mjs; the page's memory-only storage in local play)
  { const { loadHome, saveHome } = await import('../../permutation-server/web/frontier/home.mjs'); const m = new Map(), store = { get: k => m.get(k) ?? null, set: (k, v) => { m.set(k, v); } };
    saveHome(store, 'k', { pending: { kind: 'Join', signature: r.signature, scope: S } }); assert.deepEqual(loadHome(store, 'k').pending, { kind: 'Join', signature: r.signature, scope: S }); }
  // (3) the chain REFUSED it: failed — let go (the next press of Join is then a new order)
  scopeNow = S; const refusedByChain = async (o, p, b) => ({ signature: b.signature, status: 'failed', err: { InstructionError: [0, 'Custom'] } });
  assert.deepEqual(await recheckLocalPending(ledger, S, note.pending, { origin: ORIGIN, still, post: refusedByChain }), { state: 'failed', code: 'TransactionFailed' });
  assert.equal(ledger.held(S, KJ), null);
  // (4) it LANDED: let go
  ledger.hold(S, KJ, { name: 'Join', signature: r.signature });
  assert.deepEqual(await recheckLocalPending(ledger, S, note.pending, { origin: ORIGIN, still, post: async (o, p, b) => ({ signature: b.signature, status: 'finalized', err: null, slot: 12 }) }), { state: 'landed', slot: 12 });
  assert.equal(ledger.held(S, KJ), null); assert.equal(h.sends(), 1, 'through all of it, one send');
  // THE CONTROLLER: in local play the home choice's re-check is this one — never the ordinary tracker — and its note is
  // cleared only on landed (a Join whose Citizen is seen) or failed; unknown and a changed scope return without touching it
  const ctl = readFileSync(new URL('../../permutation-server/web/frontier/controller.mjs', import.meta.url), 'utf8');
  const from = ctl.indexOf('if (saved.pending && playLane()) {'), local = ctl.slice(from, ctl.indexOf('} else if (saved.pending) {', from));
  assert.ok(from > 0); assert.doesNotMatch(local, /tx\.track|'expired'/);
  assert.match(local, /const s = await localAct\.recheckLocalPending\(localActLedger, lscope, saved\.pending, \{ origin: g\.relay, still, lane: pl\.lane \}\);\n\s+if \(s\.state === 'left' \|\| !still\(\)\) return;\n\s+if \(s\.state === 'other-scope'\) return error\('PendingHome',/);
  assert.ok(local.indexOf("if (s.state === 'other-scope') return error('PendingHome'") < local.indexOf('await refresh();'), 'a note of another scope returns before anything is read or cleared');
  assert.match(local, /await refresh\(\);\n\s+if \(!still\(\)\) return;\n\s+if \(FS\.homeGrant\) return;/);
  assert.match(local, /if \(saved\.pending\.kind === 'Join' && FS\.citizen\) saveHomePatch\(\{ pending: null \}\);\n\s+else if \(s\.state === 'failed'\) saveHomePatch\(\{ pending: null \}\);\n\s+else return error\('PendingHome',/);
  // the note is WRITTEN with the scope of the send, by both of its writers in local play
  assert.match(ctl, /onSent: \(r, sentUnder\) => saveHomePatch\(\{ pending: \{ kind: 'PlaceHome', signature: r\.signature, \.\.\.\(typeof sentUnder\?\.scope === 'string' \? \{ scope: sentUnder\.scope \} : \{\}\) \} \}\),/);
  assert.match(ctl, /onSent: \(r, sentUnder\) => \{ if \(FS\.homeChoice\?\.busy\) saveHomePatch\(\{ pending: \{ kind: 'Join', signature: r\.signature, \.\.\.\(typeof sentUnder\?\.scope === 'string' \? \{ scope: sentUnder\.scope \} : \{\}\) \} \}\); \},/);
  // (fix-devnet-join-wait: a third case, the same rule — a rim village request's note (FileTicket) is cleared when the
  //  page SEES its ticket or its village; a landed send not shown yet is WAITED for (waitForOwn), never cleared unseen)
  assert.equal([...local.matchAll(/saveHomePatch\(\{ pending: null \}\)/g)].length, 3, 'the note is cleared in exactly those three cases');
  assert.match(local, /if \(saved\.pending\.kind === 'FileTicket' && ticketShown\(\)\) \{ saveHomePatch\(\{ pending: null \}\); return; \}/);
  assert.match(local, /if \(s\.state === 'landed'\) \{[\s\S]*?if \(!await waitForOwn\(shown, \{ what: [^\n]*still: \(\) => still\(\) && mine\(\) \}\)\) return notShown\(/);
  assert.match(ctl, /onSent: \(r, sentUnder\) => saveHomePatch\(\{ pending: \{ kind: 'FileTicket', signature: r\.signature, \.\.\.\(typeof sentUnder\?\.scope === 'string' \? \{ scope: sentUnder\.scope \} : \{\}\) \} \}\),/);
  // outside local play the re-check is what it was, with the same wait for a landed Join / PlaceHome not shown yet
  assert.match(ctl, /\} else if \(saved\.pending\) \{\n\s+pending\('confirming'\);\n\s+const tracked = await tx\.track\(saved\.pending\.signature\);\n\s+await refresh\(\);\n\s+if \(FS\.homeGrant\) return;\n[\s\S]{0,900}?\n\s+if \(saved\.pending\.kind === 'Join' && FS\.citizen\) saveHomePatch\(\{ pending: null \}\);\n\s+else if \(!tracked\.ok && \['failed', 'expired'\]\.includes\(tracked\.state\)\) saveHomePatch\(\{ pending: null \}\);/);
  assert.match(ctl, /if \(tracked\.ok && saved\.pending\.kind === 'Join' && !FS\.citizen\) \{\n\s+if \(!await waitForOwn\(\(\) => !!FS\.citizen, \{ what: 'join', still: mine \}\)\) return notShown\('join'\);/);
});

test('the controller: the six are held from the moment they are sent, an unconfirmed outcome is recorded as that (never refused), a held order is only asked about; Join and PlaceHome need no in-game key in local play', () => {
  const ctl = readFileSync(new URL('../../permutation-server/web/frontier/controller.mjs', import.meta.url), 'utf8');
  const between = (a, b) => { const i = ctl.indexOf(a), j = ctl.indexOf(b, i); assert.ok(i >= 0 && j > i, `${a} … ${b}`); return ctl.slice(i, j); };
  // held BEFORE the outcome is asked for; released only on landed or failed
  const sendPart = between('let r = await send();', '// W6-D');
  const settle = 'const s = localAct.settleLocalSend(localActLedger, lo, name, r, { still: stillScope, onSent });';
  assert.ok(sendPart.indexOf(settle) >= 0 && sendPart.indexOf(settle) < sendPart.indexOf('await follow(r.signature)'), 'held (and the scope asked, and only then the callback) before it is followed');
  // in local play the page's callback and the "sent" effect run ONLY through that step — never before the hold
  const localBranch = sendPart.slice(sendPart.indexOf('if (local && r.ok) {'), sendPart.indexOf('} else if (r.ok) {'));
  assert.doesNotMatch(localBranch, /onSent\?\.\(r\)/); assert.ok(localBranch.indexOf(settle) < localBranch.indexOf("fxEmit('action:sent', fxa);"));
  assert.match(localBranch, /if \(s\.state === 'left'\) \{ code = 'LocalActScopeChanged'; fxDone = true; return \{ ok: false, code, signature: r\.signature, sent: true \}; \}/);
  // outside local play the order of the ordinary path is what it was
  assert.match(sendPart, /\} else if \(r\.ok\) \{\n\s+\/\/ the transaction left this browser \(a refusal before sending never reaches here\)\n\s+sent = true; onSent\?\.\(r\); fxEmit\('action:sent', fxa\);\n\s+\}/);
  assert.match(sendPart, /if \(local && r\.ok && \(t\.ok \|\| t\.state === 'failed'\)\) localActLedger\.release\(lscope, lkey\);/);
  // the scope, the stable key and the relay are taken by `act` BEFORE anything is awaited, and handed to the one place that sends
  const actHead = between('async function act(name,', 'const localActLedger');
  // (devnet gap P1: the transport — local play's, or a verified devnet season's — is `pl`, playLane(); in local play it is localPlay's own)
  const taken = "const local = { scope: localAct.localActScope({ identity: pl.identity, relay: g.relay }), key: localAct.localActKey(name, v, fields), origin: g.relay,\n      identity: pl.identity, lane: pl.lane, deps: pl.deps };";
  assert.match(ctl, /if \(localPlay\) return \{ lane: localAct\.LOCAL_LANE, identity: localPlay, gate: localDepartGate, deps: localActDeps\(\), otherwise: 'refuse' \};/);
  assert.ok(actHead.indexOf(taken) >= 0 && actHead.indexOf(taken) < actHead.indexOf('await '), 'taken before the first await of the order path');
  assert.match(actHead, /const out = await localAct\.withLocalActSlot\(localActLedger, local\.scope, local\.key, \(\) => actOnce\(name, \{ v, fields, signer, requester, label, after, onSent, onLost, order, say \}, early, local\)\);/);
  assert.ok(actHead.indexOf("if (route === 'local-act') {") < actHead.indexOf('const key = sendKey(name, fields);'), 'local play never reaches the ordinary sendKey guard (which would tell two Joins apart by their expiry)');
  assert.match(ctl, /const lscope = local \? lo\.scope : null, lkey = local \? lo\.key : null;/);
  assert.match(ctl, /const localActScopeNow = \(\) => \{ const pl = playLane\(\), g = pl\?\.gate\(\); return localAct\.localActScope\(\{ identity: pl\?\.identity \?\? null, relay: g\?\.ok \? g\.relay : null \}\); \};/);
  // followed at the relay of the SEND, only while the page is still that scope; a page that left shows nothing and releases nothing
  assert.match(ctl, /const f = await localAct\.followLocalAct\(signature, \{ origin: lo\.origin, still: stillScope, lane: lo\.lane \}\);/);
  assert.doesNotMatch(ctl, /tx\.track\(signature, \{ read: localAct\.localActRead\(\{ allowed: localDepartGate \}\) \}\)/, 'no longer followed through whatever the gate allows at each poll');
  const left = "if (local && r.ok && (t.state === 'left' || !stillScope())) { code = 'LocalActScopeChanged'; fxDone = true; return { ok: false, code, signature: r.signature, sent: true }; }";
  assert.ok(sendPart.indexOf(left) >= 0 && sendPart.indexOf(left) < sendPart.indexOf('localActLedger.release(lscope, lkey)'), 'asked after the follow, BEFORE anything is released or shown');
  // unconfirmed: its own record with the signature, the "sent, not confirmed" notice, and NOT the refused effect
  assert.match(sendPart, /if \(local && r\.ok && !t\.ok && t\.state !== 'failed'\) \{\n\s+code = 'LocalActUnconfirmed'; fxDone = true;\n\s+orderUnconfirmed\(order, r\.signature\);/);
  assert.match(ctl, /const rec = \{ \.\.\.o, state: 'unconfirmed', sent: true, signature, code: 'LocalActUnconfirmed' \};/); assert.match(ctl, /fxEmit\('order:unconfirmed', payload\);/);
  // a held order: `act` goes to the question and returns — before `actOnce` (the only place that sends) can run
  const actPart = between('async function act(name,', 'const localActLedger');
  assert.ok(actPart.indexOf('if (localActLedger.held(local.scope, local.key)) {') >= 0 && actPart.indexOf('if (localActLedger.held(local.scope, local.key)) {') < actPart.indexOf('withLocalActSlot('), 'asked before anything can be sent');
  const askPart = between('async function localActAsk(', '/** What the local-play transport asks');
  assert.doesNotMatch(askPart, /submitLocalAct|tx\.submit|actOnce|send\(/);
  assert.match(askPart, /localAct\.settleLocalAct\(localActLedger, lo\.scope, lo\.key, localAct\.localActRead\(\{ allowed: \(\) => \(\{ ok: true, relay: lo\.origin \}\), lane: lo\.lane \}\), \{ still: \(\) => localActScopeNow\(\) === lo\.scope \}\);/);
  assert.match(askPart, /if \(s\.state === 'left' \|\| s\.state === 'none'\) return \{ ok: false, code: 'LocalActScopeChanged', sent: s\.state === 'left' \};/);
  assert.match(askPart, /return \{ ok: false, code: 'LocalActUnconfirmed', signature: s\.signature, sent: true \};/);
  // no automatic second transaction in local play
  assert.match(ctl, /if \(!local && !t\.ok && retryAfterCatchUp\(name, t\.code\)\) \{/);
  // Join: in local play no in-game key is derived, remembered or registered; a pool or a gate is not served
  const joinPart = between('  join: async () => {', '    const pin = io.pinned();');
  assert.match(joinPart, /if \(localPlay \|\| devnetPlay\) \{/); assert.doesNotMatch(joinPart, /fsession|FS\.session|SetSession|publicKeyBytes/);
  assert.match(joinPart, /if \(FS\.prize \|\| FS\.season\?\.joinGate\?\.some\?\.\(x => x !== 0\)\) return failed\(localPlayReadOnly\(\)\);/);
  // PlaceHome: the session step is skipped in local play only
  assert.match(ctl, /if \(!localPlay && !devnetPlay && !FS\.resident && \(!FS\.session \|\| FS\.sessionProblem\)\) \{\n\s+await ACTIONS\.session\(\);/);
  // outside local play the ordinary path is word for word what it was where it matters: the session rule and the transport
  assert.match(ctl, /if \(!FS\.session\) return early\(\{ code: 'NoSession' \}\);/); assert.match(ctl, /return tx\.submit\(\{ name, accounts, fields, signer: sign, requester,/);
  assert.match(ctl, /if \(localPlay\) return failed\(localPlayReadOnly\(\)\);   \/\/ no faucet, no payment, no Join/, 'the paid Join stays refused in local play');
});

test('AS THE CONTROLLER CALLS THEM: each entry point\'s own arguments — the page\'s holding object with all its fields, Build\'s item beside the village, the ABI\'s widths — go through to one send of exactly that order', async () => {
  const { TAGS } = await import('../../permutation-server/web/sdk/frontier/abi-v2-tags.mjs');
  // the ABI's own argument widths, which the intent's bounds follow (a byte: 0-255; four bytes: up to 2^32 - 1)
  // (wide-local-playable: FileTicket's data is a variable list — no fixed widths — and the wide claim is no SDK shape)
  const args = Object.fromEntries(TAGS.instructions.filter(i => LOCAL_ACT_NAMES.includes(i.name) && i.name !== 'FileTicket').map(i => [i.name, (i.data ?? i.args ?? i.fields).map(a => `${a.name}:${a.len}`)]));
  assert.deepEqual(args, { Join: ['faction:1', 'session:32', 'session_expiry:8'], PlaceHome: ['p:2', 'q:2', 'site:1'], Harvest: [], Build: ['item:1'], Train: ['unit:1', 'n:4'], Muster: ['unit:1', 'troops:4', 'tile:1'] });
  // the page's ACTIVE HOLDING as it is decoded (fstate.mjs activeHolding): far more than three coordinates, with bytes and bigints
  const holding = { p: 3, q: -2, site: 4, gen: 1, tile: 9, state: 2, seasonId: 11n, ownerCitizen: decode(CITIZEN_AT), faction: 2, hostSeq: 3, transit: [{ state: 0 }, { state: 0 }, { state: 0 }, { state: 0 }], flags: 0 };
  // the home choice's SITE as confirmHome has it
  const site = { p: 3, q: -2, site: 4, faction: 2, tile: 9, score: 12, key: 'x' };
  const calls = {
    Harvest: { v: { holding } },                                                         // ACTIONS.harvest: no fields given
    Build: { v: { holding, item: 6 }, fields: { item: 6 } },                             // ACTIONS.build: the item is beside the village too
    Train: { v: { holding }, fields: { unit: 2, n: 70000 } },                            // trainOrder: more than 65535 is a valid order (4 bytes)
    Muster: { v: { holding }, fields: { unit: 2, troops: 70000, tile: holding.tile } },  // musterOrder: the village's own tile when none is named
    PlaceHome: { v: { holding: site, faction: 2 }, fields: { p: site.p, q: site.q, site: site.site } },   // confirmHome
    Join: { v: { faction: 2 }, fields: { faction: 2, session_expiry: BigInt(1785600000 + 30 * 86400 - 600) } },   // ACTIONS.join in local play: no session key given
  };
  for (const [name, o] of Object.entries(calls)) {
    const h = joined(name === 'Join' ? { citizen: null } : name === 'PlaceHome' ? { holding: null } : {});
    assert.equal(localOrderRoute({ localPlay: IDENTITY, name, v: o.v, signer: undefined, requester: null }), 'local-act', name);
    const r = await submitLocalAct({ name, v: o.v, fields: o.fields }, h.deps());
    assert.equal(r.ok, true, `${name}: ${r.code}`); assert.equal(h.sends(), 1);
    const sent = h.posts.find(p => p[1] === LOCAL_ACT_SUBMIT_PATH)[2];
    // the stated intent is plain JSON of the three coordinates and the fields — none of the holding's other fields, no bytes, no bigint
    assert.doesNotThrow(() => JSON.stringify(sent)); assert.deepEqual(Object.keys(sent.subject).sort(), name === 'Join' ? ['faction'] : name === 'PlaceHome' ? ['faction', 'holding'] : ['holding']);
    if (name !== 'Join') assert.deepEqual(sent.subject.holding, { p: 3, q: -2, site: 4 });
    if (name === 'Train') assert.deepEqual(sent.fields, { unit: 2, n: 70000 }); if (name === 'Muster') assert.deepEqual(sent.fields, { unit: 2, troops: 70000, tile: 9 });
    if (name === 'Build') assert.deepEqual(sent.fields, { item: 6 }); if (name === 'Join') assert.deepEqual(sent.fields, { faction: 2, session: W.address, session_expiry: String(1785600000 + 30 * 86400 - 600) });
  }
  // no active holding (nothing selected), or a Muster with no tile to stand on: refused before anything is asked
  for (const [name, o] of [['Harvest', { v: { holding: undefined } }], ['Train', { v: { holding: null }, fields: { unit: 0, n: 1 } }], ['Muster', { v: { holding }, fields: { unit: 0, troops: 1, tile: undefined } }]]) {
    const h = joined(), r = await submitLocalAct({ name, v: o.v, fields: o.fields }, h.deps()); assert.deepEqual([r.ok, r.code], [false, 'LocalActShape'], name); assert.deepEqual(h.posts, []);
  }
});

test('THE RELAY GOING AWAY, as the page is told it: stopping or not answering before the send → "not sent", with the status the page\'s existing notices read (unavailable / busy); after the send → the signature is kept', async () => {
  const { failureText } = await import('../../permutation-server/web/frontier/fi18n.mjs'); const { setLang } = await import('../../permutation-server/web/lang.mjs');
  const refusal = (code, status) => async (o, p) => { if (p === LOCAL_ACT_CONTEXT_PATH) throw Object.assign(new Error('refused'), { code, refused: true, status }); return {}; };
  const h = joined();
  // the relay is closing (503) or its runner gave no usable answer (503): not sent, httpStatus 503
  for (const code of ['LocalActClosed', 'LocalActRpcUnavailable']) { const r = await submitLocalAct({ name: 'Harvest', ...ORDERS.Harvest }, h.deps({ post: refusal(code, 503) })); assert.deepEqual([r.ok, r.code, r.httpStatus], [false, code, 503]); }
  // the relay is gone (no answer at all): not sent, read as unavailable
  let r = await submitLocalAct({ name: 'Harvest', ...ORDERS.Harvest }, h.deps({ post: async () => { throw Object.assign(new Error('x'), { code: 'LocalActNoAnswer' }); } }));
  assert.deepEqual([r.ok, r.code, r.httpStatus], [false, 'LocalActNoAnswer', 503]);
  // too many unsettled commands (429): not sent, read as busy
  r = await submitLocalAct({ name: 'Harvest', ...ORDERS.Harvest }, h.deps({ post: refusal('LocalActBusy', 429) })); assert.deepEqual([r.ok, r.code, r.httpStatus], [false, 'LocalActBusy', 429]);
  // a refusal on what the order states (409): its own code, no "unavailable"
  r = await submitLocalAct({ name: 'Harvest', ...ORDERS.Harvest }, h.deps({ post: refusal('LocalActWideHolding', 409) })); assert.deepEqual([r.ok, r.code, r.httpStatus], [false, 'LocalActWideHolding', 409]);
  // the routes not served at all (404): "not served" — the controller says "reads only", as before
  r = await submitLocalAct({ name: 'Harvest', ...ORDERS.Harvest }, h.deps({ post: refusal('NotFound', 404) })); assert.deepEqual([r.ok, r.code, r.httpStatus], [false, 'LocalActNotServed', undefined]);
  assert.equal(h.sends(), 0);
  // what the page's notice texts make of those results: unavailable for 5xx; the relay's Busy (429) has its OWN sentence
  // (fix-loop5, L5-1: it was read as the daily quota — "you can send more when the game day rolls over" — which was false)
  setLang('en');
  try {
    const unavailable = failureText({ code: 'HTTP503' }), quota = failureText({ code: 'HTTP429' }), busy = failureText({ ok: false, code: 'LocalActBusy', httpStatus: 429 });
    assert.equal(failureText({ ok: false, code: 'LocalActClosed', httpStatus: 503 }), unavailable); assert.equal(failureText({ ok: false, code: 'LocalActNoAnswer', httpStatus: 503 }), unavailable);
    assert.notEqual(busy, quota); assert.notEqual(unavailable, busy); assert.match(busy, /not resolved yet.*not sent.*Wait about a minute/); assert.doesNotMatch(busy, /today|game day/i);
    assert.match(failureText({ ok: false, code: 'LocalMarchBusy', httpStatus: 429 }), /marches you just sent are not resolved yet/);
    // (re-pinned 2026-11-21: 決着 is "resolved" in the play screen's English — web-frontier-words.test.mjs bans "not settled")
    assert.doesNotMatch(unavailable, /LocalAct|\?/); assert.match(failureText({ ok: false, code: 'LocalActWideHolding', httpStatus: 409 }), /LocalActWideHolding/, 'a refusal with no sentence of its own still names its code');
  } finally { setLang('ja'); }
  // the relay stops AFTER it sent (the answer never comes): the order keeps its signature — never "not sent", never "unavailable"
  const g = joined({ lost: true }); r = await submitLocalAct({ name: 'Train', ...ORDERS.Train }, g.deps());
  assert.deepEqual([r.ok, r.outcome, typeof r.signature, r.httpStatus], [true, 'unknown', 'string', undefined]); assert.equal(g.sends(), 1);
});

test('the POST helper takes only the three paths; the general order path is not opened by this module', async () => {
  await assert.rejects(postLocalAct(ORIGIN, '/gw/f/tx', {}), e => e.code === 'BadLocalActPath'); await assert.rejects(postLocalAct(ORIGIN, '/gw/f/local-play/depart/submit', {}), e => e.code === 'BadLocalActPath');
  const calls = [], fetch = async (url, init) => { calls.push([url, init]); return { ok: false, status: 409, text: async () => JSON.stringify({ code: 'LocalActWideHolding' }) }; };
  await assert.rejects(postLocalAct(ORIGIN, LOCAL_ACT_SUBMIT_PATH, { a: 1 }, { fetch }), e => e.code === 'LocalActWideHolding' && e.refused === true);
  assert.deepEqual([calls[0][0], calls[0][1].method, calls[0][1].credentials, calls[0][1].redirect], [`${ORIGIN}${LOCAL_ACT_SUBMIT_PATH}`, 'POST', 'omit', 'error']);
  const me = readFileSync(new URL('../../permutation-server/web/frontier/flocalplay-act.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(me, /localStorage|sessionStorage|indexedDB|document\.cookie|fsession|setSession|SetSession'|\/f\/tx\b|sendTx|relayInfo/);
});
