// Local play: the departure of the boundary draft from the memory-only wallet through the loopback relay's two
// dedicated routes (flocalplay-depart.mjs). A KEY-USING test (scripts/ci/node-key-tests.txt): the wallet's
// non-extractable key is made by WebCrypto in this process and signs the prepared message. No chain, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { seasonAddresses, hostId } from '../../permutation-server/web/frontier/faddr.mjs';
import { encode, decode as fromB58 } from '../../permutation-server/web/sdk/base58.mjs';
import { encodeAccount } from '../../permutation-server/web/sdk/frontier/codec.mjs';
import { decode } from '../../permutation-server/web/frontier/fcodec.mjs';
import { OUTBOUND_POP, openOutbound, editOutbound, inspectOutboundContext } from '../../permutation-server/web/frontier/fexpedition-compose.mjs';
import * as LD from '../../permutation-server/web/frontier/flocalplay-depart.mjs';
import * as EW from '../../permutation-server/web/frontier/fephemeral-wallet.mjs';
import * as DP from '../../permutation-server/web/frontier/fexpedition-depart-prepare.mjs';
import * as hand from '../../permutation-server/web/frontier/hud/hand.mjs';
import { setLang, missingKeys } from '../../permutation-server/web/lang.mjs';
import { compileMessage, parseTransaction, COMPUTE_BUDGET_PROGRAM } from '../../permutation-server/web/sdk/solana-tx.mjs';
import { toBase64, fromBase64, toHex, fromHex } from '../../permutation-server/web/sdk/bytes.mjs';
import { sha256 } from '../../permutation-server/web/sdk/sha256.mjs';

const LOCAL = { cluster: 'localnet', hostname: '127.0.0.1', localPlay: true };
const PROGRAM = encode(new Uint8Array(32).fill(94)), A = seasonAddresses(PROGRAM, '1');
const PIN = { programId: PROGRAM, cluster: 'localnet', seasonId: '1', addresses: A };
const HOST = hostId({ p: 128, q: 0, site: 3, gen: 1, seq: 0 }).toString();
const acct = (kind, values) => decode(kind, encodeAccount(kind, { SEASON_ID: 1n, ...values }));
const SEASON = decode('Season', Buffer.from(JSON.parse(readFileSync(new URL('fixtures/frontier/season.json', import.meta.url), 'utf8')).bytes_b64, 'base64'));
const BLOCKHASH = encode(new Uint8Array(32).fill(7)), RELAY = 'http://127.0.0.1:41966';
const le = (n, size) => { const b = new Uint8Array(size); new DataView(b.buffer)[size === 8 ? 'setBigUint64' : 'setUint32'](0, size === 8 ? BigInt(n) : n, true); return b; };

/** A page in local play: the memory-only wallet, its Citizen and village at (128, 0), a reviewed and observed boundary draft. */
async function page() {
  EW.destroyEphemeralWallet();
  const signer = await EW.createEphemeralWallet(LOCAL), WALLET = signer.address, OWNER = A.of('Citizen', { wallet: WALLET });
  const h = acct('Holding', { P: 128, Q: 0, SITE: 3, GEN: 1, TILE: 60, STATE: 2, FACTION: 0, TIER: 1, HOST_SEQ: 1, OWNER_CITIZEN: fromB58(OWNER), RESERVE: [400, 0, 0, 0, 0, 0, 100, 0] });
  const province = acct('Province', { P: 128, Q: 0, RESOLVED_NEXT: 42, SITE_COUNT: 1, SITES: Uint8Array.of(60, ...new Array(11).fill(0)), PASSABLE_MASK: (1n << 61n) - 1n,
    SITE_MIRROR: [{ STATE: 1, GEN: 1, FACTION: 0, TIER: 1 }, ...Array.from({ length: 11 }, () => ({ STATE: 0 }))],
    ENTRIES: [{ ID: BigInt(HOST), FACTION: 0, UNIT: 0, TILE: 60, STATE: 1, TROOPS: 600000, STAMINA_VALUE: 120, STAMINA_BELL: 42 }] });
  const fs = { mode: 'play', sample: null, proto: null, season: { ...SEASON, seasonId: 1n, programVersion: 18436, rulesetHash: new Uint8Array(32).fill(1) },
    wallet: { address: WALLET }, resident: null, session: null, meStatus: 'ready', meAnswered: true,
    localPlay: { address: WALLET, programId: PROGRAM, cluster: 'localnet', seasonId: '1', seasonAddress: A.season },
    citizen: acct('Citizen', { WALLET: fromB58(WALLET), FACTION: 0, FLAGS: 5, TICKET_BELL: 0xffffffff, HOLDING: [{ P: 128, Q: 0, SITE: 3, GEN: 1 }, { GEN: 255 }, { GEN: 255 }] }), holdings: [h], activeHolding: 0,
    selected: { kind: 'tile', p: 128, q: 0, idx: 60 }, hand: { host: HOST, pop: OUTBOUND_POP }, nowBell: 42, chain: { now: () => 1000 }, provinces: new Map([['128,0', { province }]]),
    view: { lod: 'tile', fog: true }, land: { stage: 'final' }, marches: [], book: [], orders: [], compose: null };
  const ctx = { pin: PIN, relay: RELAY, source: {} };
  openOutbound(fs, ctx); editOutbound(fs, ctx, 'step', '0'); editOutbound(fs, ctx, 'arriveBell', '44');
  assert.equal(fs.expeditionCompose.status, 'review');
  await observe({ fs, ctx });
  return { fs, ctx, signer, WALLET };
}
/** Read the departure conditions (again): a new observation of the chain as it is now, conditions holding. */
async function observe({ fs, ctx }) {
  await inspectOutboundContext(fs, { context: () => ctx,
    snapshot: async source => ({ status: 'read', source, lands: [], season: fs.season, holdingBytes: null, clock: { unixTimestamp: 1000n }, contextSlot: '7', digest: 'ab'.repeat(32), coherent: true, contentConsistent: true }),
    judge: () => ({ ok: true, code: null }), evaluate: () => ({ ok: true, code: null, min: 44, max: 47, travelSecs: 120, wearBps: 0, stepIndex: null }) });
  assert.equal(fs.expeditionCompose.contextCheck?.status, 'read');
}
const WANT = JSON.parse(readFileSync(new URL('./fixtures/frontier-expedition-depart-prepare-wallet-payer-heap256k-rust.json', import.meta.url), 'utf8'));
/**
 * What the local-play relay answers a `prepare` (permutation-gateway local-play-relay.mjs): `{report, submit}`. The
 * report is in the REAL Rust report's exact shape (the wallet-payer heap fixture's source, blockhash and flags) for
 * THIS request; its unsigned message is compiled here by the web SDK. Not a keeper's output.
 */
function honest(request, { mutate = null, report: reshape = null, submit: resubmit = null } = {}) {
  const budget = (tag, n, size) => ({ programId: COMPUTE_BUDGET_PROGRAM, keys: [], data: Uint8Array.of(tag, ...le(n, size)) });
  const data = Uint8Array.of(0xda, 0xff, 2, 0, ...fromHex(request.proposal.bytes_hex));
  let instructions = [budget(2, 200000, 4), budget(3, 0, 8), budget(4, 1000000, 4), budget(1, 262144, 4),
    { programId: request.program, keys: request.proposal.roles.map(x => ({ pubkey: x.address, isSigner: x.signer, isWritable: x.writable })), data }];
  if (mutate) instructions = mutate({ instructions, budget });
  const message = compileMessage({ feePayer: request.payer, recentBlockhash: WANT.blockhash.hash, instructions });
  const m = parseTransaction(Uint8Array.of(1, ...new Uint8Array(64), ...message)), n = m.accountKeys.length;
  let report = { ...WANT, request, source: { ...WANT.source, arrive_bell: request.arrive_bell, current_bell: '42' },
    prepared: { program: request.program, season: request.season, program_version: '18436', action: 'Depart', fee_payer: request.payer,
      budget: { cu_limit: 200000, cu_price: '0', loaded_limit: 1000000, heap: 262144 }, roles: request.proposal.roles, instruction_hex: toHex(data),
      message_b64: toBase64(message), message_digest: toHex(sha256(message)), signers: [request.payer],
      shape: { bytes: message.length + 1 + 64, locks: n, writes: n - m.header.numReadonlySignedAccounts - m.header.numReadonlyUnsignedAccounts, sigs: 1 }, proposal_digest: request.proposal.content_digest } };
  if (reshape) report = reshape(report);
  let submit = { route: 'POST /f/local-play/depart/submit', schema: 'frontier-local-play-depart-submit-v1', message_digest: report.prepared?.message_digest ?? null,
    last_valid_block_height: report.blockhash?.last_valid_block_height ?? null, signer: request.wallet };
  if (resubmit) submit = resubmit(submit);
  return { report, submit };
}
const blocked = (request, code) => ({ report: { ...WANT, status: 'blocked', request, source: null, blockhash: null, prepared: null, blocker: { code } }, submit: null });
const sealStub = (log = []) => async req => { log.push(req); const n = log.length; return { ok: true, seal: new Uint8Array(264).fill(0xa7), commit: new Uint8Array(32).fill(n), ctHash: new Uint8Array(32), sealRoot: new Uint8Array(32), round: 9,
  reveal: { plain: new Uint8Array(136).fill(3), salt: new Uint8Array(32).fill(3 + n) } }; };
const SEAL_INPUT = { clock: { genesisTs: 1, drand: { genesis: 1, period: 3 } }, drand: { publicKey: 'aa', period: 3, genesis: 1 }, seasonPkHash: 'bb', seasonNetwork: 0, cluster: 'localnet' };
const refusal = code => Object.assign(new Error(code), { code, refused: true });
/**
 * The page's deps with a stand-in relay. `prepare(request)` → the answer; `submit(body, signature)` → 'submitted' |
 * 'unknown' | throws; `status(signature, n)` → the status answer's `{status, err?, slot?}` | throws (n counts from 1).
 */
function deps(p, { prepare = request => honest(request), submit = () => 'submitted', status = () => ({ status: 'confirmed', slot: 77 }), allowed = null } = {}) {
  const log = { posts: [], seals: [], changed: 0, states: [], statuses: 0 };
  const allow = allowed ?? (() => LD.localDepartAllowed({ localPlay: p.fs.localPlay, cluster: 'localnet', hostname: '127.0.0.1', relay: p.ctx.relay, wallet: p.fs.wallet?.address, signer: EW.currentEphemeralWallet() }));
  const post = async (origin, path, body) => {
    log.posts.push({ origin, path, body: JSON.parse(JSON.stringify(body)) });
    if (path === LD.LOCAL_DEPART_PREPARE_PATH) return prepare(body);
    if (path === LD.LOCAL_DEPART_SUBMIT_PATH) {
      const tx = parseTransaction(fromBase64(body.transaction_b64)), signature = encode(tx.signatures[0]);
      const r = await submit(body, signature, tx);
      return typeof r === 'string' ? { status: r, signature, status_route: 'POST /f/local-play/depart/status' } : r;
    }
    const r = await status(body.signature, ++log.statuses);
    return r && typeof r.status === 'string' && !('signature' in r) ? { signature: body.signature, err: null, slot: null, ...r } : r;
  };
  const o = { allowed: allow, context: () => p.ctx, sealInput: () => SEAL_INPUT, seal: sealStub(log.seals), signer: () => EW.currentEphemeralWallet(), post,
    changed: () => { log.changed++; log.states.push(LD.localDepartOf(p.fs).status); }, requestId: 'lp-1' };
  return { log, options: o, count: path => log.posts.filter(x => x.path === path).length };
}
const P = LD.LOCAL_DEPART_PREPARE_PATH, S = LD.LOCAL_DEPART_SUBMIT_PATH, T = LD.LOCAL_DEPART_STATUS_PATH;

test('the gate: local play identity, localnet, a loopback page and relay, the identity\'s own live memory-only wallet; anything else is refused', async () => {
  const p = await page(), ok = { localPlay: p.fs.localPlay, cluster: 'localnet', hostname: '127.0.0.1', relay: RELAY, wallet: p.WALLET, signer: p.signer };
  assert.deepEqual(LD.localDepartAllowed(ok), { ok: true, relay: RELAY });
  assert.deepEqual(LD.localDepartAllowed({ ...ok, hostname: 'localhost', relay: 'http://localhost:41966/gw' }), { ok: true, relay: 'http://localhost:41966' });
  const other = encode(new Uint8Array(32).fill(9));
  for (const [change, code] of [[{ localPlay: null }, 'LocalDepartNotLocalPlay'], [{ localPlay: undefined }, 'LocalDepartNotLocalPlay'], [{ cluster: 'devnet' }, 'LocalDepartCluster'], [{ cluster: 'mainnet-beta' }, 'LocalDepartCluster'],
    [{ localPlay: { ...p.fs.localPlay, cluster: 'devnet' } }, 'LocalDepartCluster'], [{ hostname: 'wylls.example' }, 'LocalDepartHost'], [{ hostname: '192.168.1.5' }, 'LocalDepartHost'],
    [{ relay: 'https://relay.example/gw' }, 'LocalDepartRelay'], [{ relay: '/gw' }, 'LocalDepartRelay'], [{ relay: 'http://user:pw@127.0.0.1:1' }, 'LocalDepartRelay'], [{ relay: 'ftp://127.0.0.1' }, 'LocalDepartRelay'],
    [{ wallet: other }, 'LocalDepartWallet'], [{ wallet: null }, 'LocalDepartWallet'], [{ signer: null }, 'LocalDepartSigner'], [{ signer: { address: p.WALLET, destroyed: false, wallet: { features: {} } } }, 'LocalDepartSigner'],
    [{ signer: { ...p.signer, address: other } }, 'LocalDepartSigner']]) {
    assert.deepEqual(LD.localDepartAllowed({ ...ok, ...change }), { ok: false, code }, JSON.stringify(Object.keys(change)));
  }
  p.signer.destroy();
  assert.deepEqual(LD.localDepartAllowed(ok), { ok: false, code: 'LocalDepartSigner' }, 'a destroyed wallet signs nothing');
});

test('one whole run: seal, prepare (the full canonical request), the wallet signs that very message, one submit, the status confirms', async () => {
  const p = await page(), d = deps(p);
  const state = await LD.runLocalDepart(p.fs, d.options);
  assert.equal(state.status, 'confirmed'); assert.equal(state.busy, false); assert.equal(state.sent, true); assert.equal(state.requestId, 'lp-1'); assert.equal(state.chain, 'confirmed'); assert.equal(state.slot, 77);
  assert.deepEqual([...new Set(d.log.states)], ['sealing', 'preparing', 'signing', 'submitting', 'submitted', 'confirmed']);
  const sealReq = d.log.seals[0];
  assert.equal(d.log.seals.length, 1); assert.equal(sealReq.host, p.fs.expeditionCompose.source.host); assert.equal(sealReq.arriveBell, 44); assert.equal(sealReq.plain.arriveBell, 44); assert.equal(sealReq.cluster, 'localnet');
  assert.deepEqual(d.log.posts.map(x => [x.origin, x.path]), [[RELAY, P], [RELAY, S], [RELAY, T]]);
  const [prep, sub, stat] = d.log.posts.map(x => x.body);
  // prepare: the existing full canonical request, nothing else
  assert.deepEqual(DP.departPreparationRequestOf(prep), prep); assert.equal(prep.schema, 'frontier-experimental-expedition-depart-prepare-request-v1');
  assert.equal(prep.wallet, p.WALLET); assert.equal(prep.payer, p.WALLET); assert.equal(prep.arrive_bell, '44'); assert.equal(prep.public_seal, 'a7'.repeat(264)); assert.equal(prep.public_commit, '01'.repeat(32)); assert.equal(prep.request_id, 'lp-1');
  // submit: exactly schema, message_digest, transaction_b64
  assert.deepEqual(Object.keys(sub), ['schema', 'message_digest', 'transaction_b64']); assert.equal(sub.schema, 'frontier-local-play-depart-submit-v1'); assert.equal(sub.message_digest, state.digest);
  assert.deepEqual(stat, { schema: 'frontier-local-play-depart-status-v1', signature: state.signature });
  // what was sent is the prepared message, signed by this wallet, and the signature verifies
  const tx = parseTransaction(fromBase64(sub.transaction_b64)), honestMessage = fromBase64(honest(prep).report.prepared.message_b64);
  assert.deepEqual([...tx.message], [...honestMessage]); assert.deepEqual(tx.signers, [p.WALLET]); assert.equal(encode(tx.signatures[0]), state.signature);
  const key = await crypto.subtle.importKey('raw', fromB58(p.WALLET), 'Ed25519', false, ['verify']);
  assert.equal(await crypto.subtle.verify('Ed25519', key, tx.signatures[0], tx.message), true);
  // the reveal: memory only, by host, transit slot and commit; nothing of it (or of any key) in what was posted or in the state
  const host = p.fs.expeditionCompose.source.host, slot = p.fs.expeditionCompose.review.transitSlot;
  const reveal = LD.localDepartRevealFor(p.fs, host, slot, '01'.repeat(32));
  assert.deepEqual([...reveal.plain], new Array(136).fill(3)); assert.deepEqual([...reveal.salt], new Array(32).fill(4)); assert.equal(reveal.signature, state.signature); assert.equal(reveal.arriveBell, 44);
  const posted = JSON.stringify(d.log.posts) + JSON.stringify(state);
  assert.ok(!posted.includes(toHex(reveal.plain)) && !posted.includes(toHex(reveal.salt)) && !posted.includes('reveal'));
  // clearing the card's lines does not touch the reveal; nor does another seal for the same host and slot
  assert.equal(LD.clearLocalDepart(p.fs), true); assert.equal(LD.localDepartOf(p.fs).status, 'idle');
  assert.equal(LD.localDepartRevealFor(p.fs, host, slot, '01'.repeat(32)), reveal, 'still held after the card is cleared');
  // the observation this departure was sent on is used up: the same "conditions hold" is not sent on twice, nothing is even sealed
  assert.equal(LD.localDepartSpent(p.fs), true);
  const d0 = deps(p), s0 = await LD.runLocalDepart(p.fs, { ...d0.options, requestId: 'lp-0' });
  assert.equal(s0.status, 'error'); assert.equal(s0.error, 'DepartObservationSpent'); assert.equal(d0.log.seals.length, 0); assert.equal(d0.log.posts.length, 0);
  assert.equal(LD.clearLocalDepart(p.fs), true); assert.equal(LD.localDepartSpent(p.fs), true, 'clearing the card does not bring it back');
  // the conditions are read again (a new observation): a run may begin; here the chain says the slot is taken
  await observe(p); assert.equal(LD.localDepartSpent(p.fs), false);
  const d2 = deps(p, { prepare: request => blocked(request, 'TransitSlotBusy') }); d2.options.seal = sealStub([{}]); d2.options.requestId = 'lp-2';
  const s2 = await LD.runLocalDepart(p.fs, d2.options);
  assert.equal(s2.status, 'error'); assert.equal(s2.error, 'TransitSlotBusy'); assert.equal(s2.sent, false);
  const held = LD.localDepartRevealFor(p.fs, host, slot);
  assert.deepEqual(held.map(x => [x.commit, x.requestId, x.signature]), [['01'.repeat(32), 'lp-1', state.signature], ['02'.repeat(32), 'lp-2', null]], 'both seals keep their own reveal');
  assert.equal(LD.localDepartReveals(p.fs).length, 2); assert.deepEqual([...held[0].salt], new Array(32).fill(4)); assert.deepEqual([...held[1].salt], new Array(32).fill(5));
  assert.equal(LD.localDepartSpent(p.fs), false, 'a run that sent nothing uses nothing up');
  // another draft (the card reopened: its own observation) is not the spent one, and a spent one stays spent beside it
  const q = await page(), dq = deps(q);
  assert.equal((await LD.runLocalDepart(q.fs, dq.options)).status, 'confirmed'); assert.equal(LD.localDepartSpent(q.fs), true);
  editOutbound(q.fs, q.ctx, 'arriveBell', '45'); assert.equal(LD.localDepartSpent(q.fs), false, 'an edited draft has no observation yet');
  await observe(q); assert.equal(LD.localDepartSpent(q.fs), false, 'and its own new observation is fresh');
});

test('a double press starts one run; no new run while one is in flight, submitted or unknown', async () => {
  const p = await page();
  let release; const d = deps(p, { prepare: async request => { await new Promise(r => { release = r; }); return honest(request); }, status: () => ({ status: 'processed', slot: 5 }) });
  const first = LD.runLocalDepart(p.fs, d.options), second = LD.runLocalDepart(p.fs, { ...d.options, requestId: 'lp-2' });
  assert.equal((await second).busy, true, 'the second press is answered with the run in flight');
  for (let i = 0; i < 50 && !release; i++) await new Promise(r => setImmediate(r));
  assert.equal(LD.clearLocalDepart(p.fs), false, 'a run in flight is not forgotten');
  release();
  const s = await first;
  assert.equal(s.status, 'submitted', 'processed is not confirmed'); assert.equal(s.chain, 'processed'); assert.equal(s.busy, false);
  // submitted, not yet confirmed: a press starts nothing, the card cannot forget it
  const again = await LD.runLocalDepart(p.fs, { ...d.options, requestId: 'lp-3' });
  assert.equal(again.status, 'submitted'); assert.equal(again.requestId, 'lp-1'); assert.equal(LD.clearLocalDepart(p.fs), false);
  assert.equal(d.log.seals.length, 1); assert.equal(d.count(P), 1); assert.equal(d.count(S), 1);
});

test('an unknown outcome is not a success: it is asked about by its first signature on the status route only; nothing is sealed, signed or submitted twice', async () => {
  for (const how of ['the submit never answers', 'the relay answers unknown', 'the relay refuses the submit', 'the answer names another signature']) {
    const p = await page(); const answers = [];
    const d = deps(p, { submit: () => { if (how.startsWith('the submit')) throw new Error('socket hang up'); if (how.includes('refuses')) throw refusal('LocalPlaySendRefused'); if (how.includes('another')) return { status: 'submitted', signature: encode(new Uint8Array(64).fill(5)) }; return 'unknown'; },
      status: (sig, n) => { const a = answers[n - 1]; if (a instanceof Error) throw a; return a; } });
    // the run's own first look: the relay does not know the signature (it restarted, or never recorded it): that proves nothing
    answers.push(refusal('LocalPlayUnknownSignature'), refusal('LocalPlayUnknownSignature'), new Error('timeout'), { status: 'pending' }, { status: 'processed', slot: 9 }, { status: 'finalized', slot: 9 });
    const state = await LD.runLocalDepart(p.fs, d.options);
    assert.equal(state.status, 'unknown', how); assert.equal(state.sent, true); assert.ok(state.signature); assert.equal(state.busy, false);
    assert.equal(LD.clearLocalDepart(p.fs), false, 'an unknown outcome is kept');
    assert.equal((await LD.runLocalDepart(p.fs, { ...d.options, requestId: 'lp-2' })).status, 'unknown', 'no new run over an unknown one');
    const seen = [];
    for (let i = 0; i < 6; i++) { const r = await LD.reconcileLocalDepart(p.fs, d.options); seen.push([r.status, r.error, r.chain]); assert.equal(r.signature, state.signature); }
    const first = how === 'the relay answers unknown' ? [] : [['unknown', 'LocalPlayUnknownSignature', null]];
    assert.deepEqual(seen.slice(0, 5 - (first.length ? 0 : 1)), [...first, ['unknown', 'LocalPlayUnknownSignature', null], ['unknown', 'LocalDepartStatusUnavailable', null], ['unknown', null, 'pending'], ['unknown', null, 'processed']].slice(0, 5 - (first.length ? 0 : 1)), how);
    assert.equal(LD.localDepartOf(p.fs).status, 'confirmed', 'only the chain\'s word ends it'); assert.equal(LD.localDepartOf(p.fs).chain, 'finalized');
    assert.equal(d.log.seals.length, 1); assert.equal(d.count(P), 1); assert.equal(d.count(S), 1, 'one submit, ever');
    const asked = d.log.posts.filter(x => x.path === T);
    assert.ok(asked.length >= 6 && asked.every(x => x.body.signature === state.signature && Object.keys(x.body).length === 2), 'every question is the first signature');
    const n = d.log.posts.length; await LD.reconcileLocalDepart(p.fs, d.options); assert.equal(d.log.posts.length, n, 'a confirmed run is not asked about again');
  }
});

test('failed is the chain\'s own error and nothing else; a status that cannot be believed changes nothing', async () => {
  let p = await page(), d = deps(p, { status: () => ({ status: 'failed', err: { InstructionError: [4, { Custom: 58 }] }, slot: 12 }) });
  let s = await LD.runLocalDepart(p.fs, d.options);
  assert.equal(s.status, 'failed'); assert.equal(s.code, '{"InstructionError":[4,{"Custom":58}]}'); assert.equal(s.chain, 'failed'); assert.equal(s.sent, true); assert.equal(LD.clearLocalDepart(p.fs), true);
  assert.equal(LD.localDepartReveals(p.fs).length, 1, 'the reveal of a failed departure is kept too');
  for (const bad of [() => ({ status: 'confirmed', signature: encode(new Uint8Array(64).fill(5)), err: null, slot: 1 }), () => ({ status: 'ok' }), () => null, () => ({ status: 'failed' }), () => ({ status: 'confirmed', err: { x: 1 } }), () => { throw refusal('LocalPlayUnknownSignature'); }]) {
    p = await page(); d = deps(p, { status: bad }); s = await LD.runLocalDepart(p.fs, d.options);
    assert.equal(s.status, 'submitted', 'the relay said submitted; the status said nothing believable'); assert.ok(s.error); assert.equal(s.code, null);
  }
});

test('the prepared report is this request\'s whole Rust-shaped report or nothing is signed', async () => {
  const other = encode(new Uint8Array(32).fill(9));
  const cases = [
    ['a blocked report', request => blocked(request, 'TransitSlotBusy'), 'TransitSlotBusy'],
    ['an opened flag', request => honest(request, { report: r => ({ ...r, signed: true }) }), 'UnsafeDepartPreparationReport'],
    ['a report for another request', request => honest(request, { report: r => ({ ...r, request: { ...r.request, arrive_bell: '45' } }) }), 'DepartPreparationRequestMismatch'],
    ['another proposal digest', request => honest(request, { report: r => ({ ...r, prepared: { ...r.prepared, proposal_digest: 'cd'.repeat(32) } }) }), 'DepartPreparationScopeMismatch'],
    ['a digest of other bytes', request => honest(request, { report: r => ({ ...r, prepared: { ...r.prepared, message_digest: 'ef'.repeat(32) } }), submit: s => ({ ...s, message_digest: 'ef'.repeat(32) }) }), 'DepartPreparationMessageDigest'],
    ['another blockhash than the message\'s', request => honest(request, { report: r => ({ ...r, blockhash: { ...r.blockhash, hash: other } }) }), 'DepartPreparationMessageMismatch'],
    ['no heap frame', request => honest(request, { mutate: ({ instructions }) => [instructions[0], instructions[1], instructions[2], instructions[4]] }), 'DepartPreparationMessageMismatch'],
    ['a smaller heap frame', request => honest(request, { mutate: ({ instructions, budget }) => [instructions[0], instructions[1], instructions[2], budget(1, 32 * 1024, 4), instructions[4]] }), 'DepartPreparationBudgetMismatch'],
    ['a priority fee', request => honest(request, { mutate: ({ instructions, budget }) => [instructions[0], budget(3, 5, 8), ...instructions.slice(2)] }), 'DepartPreparationBudgetMismatch'],
    ['an extra account on the dispatch', request => honest(request, { mutate: ({ instructions }) => [...instructions.slice(0, 4), { ...instructions[4], keys: [...instructions[4].keys, { pubkey: other, isSigner: false, isWritable: true }] }] }), 'DepartPreparationRolesMismatch'],
    ['other dispatch bytes', request => honest(request, { mutate: ({ instructions }) => [...instructions.slice(0, 4), { ...instructions[4], data: Uint8Array.from([...instructions[4].data.slice(0, -1), instructions[4].data.at(-1) ^ 1]) }] }), 'DepartPreparationInstructionMismatch'],
    ['a submit note for another digest', request => honest(request, { submit: s => ({ ...s, message_digest: 'ab'.repeat(32) }) }), 'LocalDepartSubmitMismatch'],
    ['a submit note for another signer', request => honest(request, { submit: s => ({ ...s, signer: other }) }), 'LocalDepartSubmitMismatch'],
    ['a submit note for another schema', request => honest(request, { submit: s => ({ ...s, schema: 'frontier-relay-v1' }) }), 'LocalDepartSubmitMismatch'],
    ['a submit note with another expiry', request => honest(request, { submit: s => ({ ...s, last_valid_block_height: '1' }) }), 'LocalDepartSubmitMismatch'],
    ['a bare report', request => honest(request).report, 'BadLocalDepartPrepared'],
    ['a prepared report with no submit note', request => ({ report: honest(request).report, submit: null }), 'BadLocalDepartPrepared'],
    ['a blocked report with a submit note', request => ({ ...blocked(request, 'TransitSlotBusy'), submit: honest(request).submit }), 'BadLocalDepartPrepared'],
    ['an extra field beside report and submit', request => ({ ...honest(request), signed_transaction: 'x' }), 'BadLocalDepartPrepared'],
  ];
  for (const [name, prepare, code] of cases) {
    const p = await page(), d = deps(p, { prepare });
    const s = await LD.runLocalDepart(p.fs, d.options);
    assert.equal(s.status, 'error', name); assert.equal(s.error, code, name); assert.equal(s.sent, false, name); assert.equal(s.signature, null, name);
    assert.equal(d.count(S), 0, `${name}: nothing is submitted`); assert.equal(d.count(T), 0);
    assert.equal(LD.localDepartReveals(p.fs).length, 1, `${name}: the reveal of the seal that was made is still kept`);
  }
});

test('the gate and the draft are asked again before each step that leaves the page, before signing and in the very turn of the POST', async () => {
  // not allowed at all: nothing is sealed
  let p = await page(), d = deps(p, { allowed: () => ({ ok: false, code: 'LocalDepartCluster' }) });
  let s = await LD.runLocalDepart(p.fs, d.options);
  assert.equal(s.status, 'error'); assert.equal(s.error, 'LocalDepartCluster'); assert.equal(d.log.seals.length, 0); assert.equal(d.log.posts.length, 0);
  // the wallet is destroyed while the relay prepares: nothing is signed or submitted
  p = await page(); d = deps(p, { prepare: request => { const a = honest(request); EW.destroyEphemeralWallet(); return a; } });
  s = await LD.runLocalDepart(p.fs, d.options);
  assert.equal(s.status, 'error'); assert.equal(s.error, 'LocalDepartSigner'); assert.equal(s.sent, false); assert.equal(d.log.posts.length, 1);
  // the draft is edited while the relay prepares
  p = await page(); d = deps(p, { prepare: request => { const a = honest(request); editOutbound(p.fs, p.ctx, 'arriveBell', '45'); return a; } });
  s = await LD.runLocalDepart(p.fs, d.options);
  assert.equal(s.status, 'error'); assert.equal(s.error, 'DepartDraftChanged'); assert.equal(d.log.posts.length, 1);
  // the card is closed while the seal is made
  p = await page(); d = deps(p); d.options.seal = async req => { p.fs.hand.pop = null; return sealStub()(req); };
  s = await LD.runLocalDepart(p.fs, d.options);
  assert.equal(s.status, 'error'); assert.equal(s.error, 'DepartDraftChanged'); assert.equal(d.log.posts.length, 0);
  // while the wallet's connect is awaited: the page stops being allowed / the draft is edited → nothing is signed
  for (const [what, code] of [['gate', 'LocalDepartHost'], ['draft', 'DepartDraftChanged']]) {
    p = await page(); d = deps(p); let off = false, signs = 0;
    const real = EW.currentEphemeralWallet(), features = real.wallet.features;
    const wrapped = { ...real, address: real.address, destroyed: false, wallet: { features: { ...features,
      'standard:connect': { connect: async () => { const r = await features['standard:connect'].connect(); if (what === 'gate') off = true; else editOutbound(p.fs, p.ctx, 'arriveBell', '45'); return r; } },
      'solana:signTransaction': { signTransaction: async (...a) => { signs++; return features['solana:signTransaction'].signTransaction(...a); } } } } };
    d.options.signer = () => wrapped; const allow = d.options.allowed; d.options.allowed = () => (off ? { ok: false, code: 'LocalDepartHost' } : allow());
    s = await LD.runLocalDepart(p.fs, d.options);
    assert.equal(s.status, 'error', what); assert.equal(s.error, code, what); assert.equal(signs, 0, `${what}: nothing was signed`); assert.equal(d.count(S), 0);
  }
  // the repaint of "submitting" (the page's own code, synchronous) closes the card / destroys the wallet / edits the draft: nothing is POSTed
  for (const [what, act, code] of [['card', q => { q.fs.hand.pop = null; }, 'DepartDraftChanged'], ['wallet', () => { EW.destroyEphemeralWallet(); }, 'LocalDepartSigner'], ['draft', q => { editOutbound(q.fs, q.ctx, 'arriveBell', '45'); }, 'DepartDraftChanged']]) {
    p = await page(); d = deps(p); const q = p, changed = d.options.changed;
    d.options.changed = () => { changed(); if (LD.localDepartOf(q.fs).status === 'submitting') act(q); };
    s = await LD.runLocalDepart(p.fs, d.options);
    assert.equal(s.status, 'error', what); assert.equal(s.error, code, what); assert.equal(s.sent, false, `${what}: not sent`); assert.equal(d.count(S), 0, `${what}: no submit`); assert.equal(d.count(T), 0);
    assert.equal(LD.clearLocalDepart(p.fs), true, 'an unsent run can be forgotten');
  }
  // the seal refuses: no reveal exists
  p = await page(); d = deps(p); d.options.seal = async () => ({ ok: false, code: 'ClockBeaconMismatch', error: 'x' });
  s = await LD.runLocalDepart(p.fs, d.options);
  assert.equal(s.status, 'error'); assert.equal(s.error, 'ClockBeaconMismatch'); assert.equal(LD.localDepartReveals(p.fs).length, 0);
  // no observation of the departure conditions: the request cannot be built
  p = await page(); p.fs.expeditionCompose.contextCheck = null; d = deps(p);
  s = await LD.runLocalDepart(p.fs, d.options);
  assert.equal(s.status, 'error'); assert.equal(s.error, 'DepartObservationUnavailable'); assert.equal(d.log.posts.length, 0);
  // a page that is not the identity's (another program): refused before the relay
  p = await page(); p.fs.localPlay = { ...p.fs.localPlay, programId: encode(new Uint8Array(32).fill(8)) }; d = deps(p, { allowed: () => ({ ok: true, relay: RELAY }) });
  s = await LD.runLocalDepart(p.fs, d.options);
  assert.equal(s.status, 'error'); assert.equal(s.error, 'LocalDepartIdentityMismatch'); assert.equal(d.log.posts.length, 0);
  // reconciling asks the gate too: a page that is no longer allowed asks nothing
  p = await page(); d = deps(p, { status: () => ({ status: 'pending' }) }); s = await LD.runLocalDepart(p.fs, d.options); assert.equal(s.status, 'submitted');
  const n = d.log.posts.length; s = await LD.reconcileLocalDepart(p.fs, { ...d.options, allowed: () => ({ ok: false, code: 'LocalDepartWallet' }) });
  assert.equal(s.status, 'submitted'); assert.equal(s.error, 'LocalDepartWallet'); assert.equal(d.log.posts.length, n);
});

test('a wallet that returns anything but that message signed by itself is refused; the relay post is one bounded loopback POST', async () => {
  const p = await page(), seen = [];
  await LD.runLocalDepart(p.fs, deps(p, { prepare: request => { seen.push(request); return blocked(request, 'Stop'); } }).options);
  const request = seen[0], message = fromBase64(honest(request).report.prepared.message_b64), prepared = { message, digest: toHex(sha256(message)) };
  const { wireTransaction } = await import('../../permutation-server/web/sdk/solana-tx.mjs');
  const account = (await p.signer.wallet.features['standard:connect'].connect()).accounts[0];
  const [good] = await p.signer.wallet.features['solana:signTransaction'].signTransaction({ account, transaction: wireTransaction(message, []) });
  const ok = await LD.localDepartSigned(good.signedTransaction, prepared, p.WALLET);
  assert.equal(ok.signature.length > 80, true);
  const code = async fn => { try { await fn(); return null; } catch (e) { return e.code; } };
  assert.equal(await code(() => LD.localDepartSigned(wireTransaction(message, []), prepared, p.WALLET)), 'LocalDepartSignedUnsigned');
  assert.equal(await code(() => LD.localDepartSigned(wireTransaction(message, [new Uint8Array(64).fill(1)]), prepared, p.WALLET)), 'LocalDepartSignatureInvalid');
  const otherMessage = fromBase64(honest(request, { mutate: ({ instructions, budget }) => [budget(2, 200001, 4), ...instructions.slice(1)] }).report.prepared.message_b64);
  const [swapped] = await p.signer.wallet.features['solana:signTransaction'].signTransaction({ account, transaction: wireTransaction(otherMessage, []) });
  assert.equal(await code(() => LD.localDepartSigned(swapped.signedTransaction, prepared, p.WALLET)), 'LocalDepartSignedOtherMessage');
  assert.equal(await code(() => LD.localDepartSigned(Uint8Array.of(1, 2, 3), prepared, p.WALLET)), 'LocalDepartSignedMalformed');
  // the post
  const calls = [];
  const fetcher = async (url, init) => { calls.push({ url, init }); return { ok: true, text: async () => '{"status":"prepared"}' }; };
  assert.deepEqual(await LD.postLocalDepart(RELAY, LD.LOCAL_DEPART_PREPARE_PATH, { a: 1 }, { fetch: fetcher }), { status: 'prepared' });
  assert.equal(calls[0].url, 'http://127.0.0.1:41966/gw/f/local-play/depart/prepare'); assert.equal(calls[0].init.method, 'POST'); assert.equal(calls[0].init.credentials, 'omit'); assert.equal(calls[0].init.redirect, 'error');
  assert.equal(await code(() => LD.postLocalDepart('https://relay.example', LD.LOCAL_DEPART_PREPARE_PATH, {}, { fetch: fetcher })), 'LocalDepartRelay');
  assert.equal(await code(() => LD.postLocalDepart(RELAY, '/gw/f/relay', {}, { fetch: fetcher })), 'LocalDepartRelay');
  assert.equal(await code(() => LD.postLocalDepart('/gw', LD.LOCAL_DEPART_PREPARE_PATH, {}, { fetch: fetcher })), 'LocalDepartRelay');
  assert.deepEqual(await LD.postLocalDepart(RELAY, LD.LOCAL_DEPART_STATUS_PATH, { a: 1 }, { fetch: fetcher }), { status: 'prepared' }); calls.pop();
  assert.equal(await code(() => LD.postLocalDepart(RELAY, LD.LOCAL_DEPART_SUBMIT_PATH, {}, { fetch: async () => ({ ok: false, text: async () => '{"code":"LocalPlayOnly"}' }) })), 'LocalPlayOnly');
  assert.equal(await code(() => LD.postLocalDepart(RELAY, LD.LOCAL_DEPART_SUBMIT_PATH, {}, { fetch: async () => ({ ok: true, text: async () => 'not json' }) })), 'LocalDepartAnswerMalformed');
  assert.equal(await code(() => LD.postLocalDepart(RELAY, LD.LOCAL_DEPART_SUBMIT_PATH, {}, { fetch: async () => ({ ok: true, text: async () => 'x'.repeat(70000) }) })), 'LocalDepartAnswerTooLarge');
  assert.equal(calls.length, 1, 'a refused address or path is never fetched');
  // the module: no storage, no session key, no other relay path, no export of a key
  const src = readFileSync(new URL('../../permutation-server/web/frontier/flocalplay-depart.mjs', import.meta.url), 'utf8');
  for (const banned of ['localStorage', 'sessionStorage', 'indexedDB', 'exportKey', 'fsession', "'sign'", '/f/relay', 'generateKey', 'request_id:', 'signed_tx_b64']) assert.ok(!src.includes(banned), banned);
  EW.destroyEphemeralWallet();
});

test('the boundary card: the local-play block only in local play, a button that waits for the conditions, and every outcome in its own words', async () => {
  const p = await page(), card = () => String(hand.renderPop(p.fs, hand.handModel(p.fs)));
  const DEPART = /data-act="outbound-local-depart"/, CHECK = /data-act="outbound-local-reconcile"/;
  setLang('ja');
  try {
    // the ordinary page: no such block at all
    const identity = p.fs.localPlay; p.fs.localPlay = null;
    assert.doesNotMatch(card(), /outbound-local/); assert.doesNotMatch(card(), /ローカルプレイ/);
    p.fs.localPlay = identity;
    // local play, conditions observed and met: the button is live; the reload warning is always there
    let c = card();
    assert.match(c, DEPART); assert.doesNotMatch(c, CHECK); assert.match(c, /再読み込みすると失われます/); assert.doesNotMatch(c, /data-act="outbound-local-depart" aria-disabled/);
    // conditions not observed: the button is disabled and says what to do first
    const check = p.fs.expeditionCompose.contextCheck; p.fs.expeditionCompose.contextCheck = null;
    c = card(); assert.match(c, /data-act="outbound-local-depart" aria-disabled="true"/); assert.match(c, /先に「出発条件を確認」/);
    p.fs.expeditionCompose.contextCheck = check;
    // submitted, not confirmed: no departure button, the look-up instead, and no word of success
    let d = deps(p, { status: () => ({ status: 'pending' }) });
    let s = await LD.runLocalDepart(p.fs, d.options); assert.equal(s.status, 'submitted');
    c = card(); assert.doesNotMatch(c, DEPART); assert.match(c, CHECK); assert.match(c, /確定はまだ確認できていません/); assert.doesNotMatch(c, /確定しました/);
    assert.ok(c.includes(`${s.signature.slice(0, 8)}…`), 'the signature is named, shortened');
    // confirmed
    d.options.post = async (o, path, body) => ({ signature: body.signature, status: 'confirmed', err: null, slot: 3 });
    s = await LD.reconcileLocalDepart(p.fs, d.options); assert.equal(s.status, 'confirmed');
    // confirmed: the same observation is used up. The button is there but disabled, and says to read the conditions again
    c = card(); assert.match(c, /出発が確定しました（ターン 44 に到着予定/); assert.match(c, /data-act="outbound-local-depart" aria-disabled="true"/); assert.match(c, /すでに出発を送りました/);
    assert.equal(LD.clearLocalDepart(p.fs), true);
    c = card(); assert.match(c, /data-act="outbound-local-depart" aria-disabled="true"/, 'still disabled once the lines are cleared'); assert.doesNotMatch(c, /確定しました/);
    await observe(p); c = card(); assert.doesNotMatch(c, /data-act="outbound-local-depart" aria-disabled/, 'live again after a fresh read of the conditions');
    // unknown: said as unknown, with the look-up and never the departure button
    d = deps(p, { submit: () => { throw new Error('reset'); }, status: () => { throw new Error('down'); } }); d.options.seal = sealStub([{}, {}]); d.options.requestId = 'lp-9';
    s = await LD.runLocalDepart(p.fs, d.options); assert.equal(s.status, 'unknown');
    c = card(); assert.match(c, /出発したかどうかは不明です/); assert.match(c, /もう一度送らずに/); assert.match(c, CHECK); assert.doesNotMatch(c, DEPART); assert.doesNotMatch(c, /確定しました/);
    // failed (the chain's error)
    d.options.post = async (o, path, body) => ({ signature: body.signature, status: 'failed', err: { InstructionError: [4, { Custom: 58 }] }, slot: 4 });
    s = await LD.reconcileLocalDepart(p.fs, d.options); assert.equal(s.status, 'failed');
    c = card(); assert.match(c, /出発は失敗しました/); assert.match(c, /Custom/); assert.doesNotMatch(c, /確定しました/);
    c = card(); assert.match(c, /data-act="outbound-local-depart" aria-disabled="true"/, 'a failed departure used its observation up too');
    // an error before anything was sent says so
    assert.equal(LD.clearLocalDepart(p.fs), true); await observe(p);
    d = deps(p, { prepare: request => blocked(request, 'TransitSlotBusy') }); d.options.seal = sealStub([{}, {}, {}]);
    s = await LD.runLocalDepart(p.fs, d.options); assert.equal(s.status, 'error');
    c = card(); assert.match(c, /出発できませんでした（TransitSlotBusy）/); assert.match(c, /何も送っていません/);
    // English: every string of the block has its translation
    setLang('en'); c = card();
    assert.match(c, /Could not depart \(TransitSlotBusy\)\. Nothing was sent\./); assert.match(c, /Depart \(local play\)/); assert.match(c, /lost on reload/);
    assert.deepEqual(missingKeys().filter(k => /ローカルプレイ|出発|照合|封をして|署名|送信/.test(k)), []);
  } finally { setLang('ja'); EW.destroyEphemeralWallet(); }
});

test('the wiring: the page\'s two actions go to the controller\'s local-play entry points; every other send stays refused in local play', () => {
  const read = file => readFileSync(new URL(`../../permutation-server/web/frontier/${file}`, import.meta.url), 'utf8');
  const app = read('app.mjs'), ctl = read('controller.mjs');
  assert.match(app, /\n  'outbound-local-depart': \(\) => sendLocalPlayDeparture\(\),\n  'outbound-local-reconcile': \(\) => reconcileLocalPlayDeparture\(\),\n/);
  assert.match(app, /import \{[^}]*\bsendLocalPlayDeparture, reconcileLocalPlayDeparture\b[^}]*\} from '\.\/controller\.mjs';/);
  assert.match(app, /'outbound-arrival-earliest', 'outbound-local-depart', 'outbound-local-reconcile'\]\.includes\(el\.dataset\.act\)\) clearOutbound\(FS\);/, 'pressing them keeps the draft');
  // the controller: the gate is asked with the page's own facts, and the run gets nothing but it, the composer's context, the seal and the live wallet
  assert.match(ctl, /const localDepartGate = \(\) => localDepart\.localDepartAllowed\(\{ localPlay, cluster: io\.pinned\(\)\?\.cluster, relay: io\.relay\(\), wallet: FS\.wallet\?\.address \?\? null, signer: currentEphemeralWallet\(\) \}\);/);
  assert.match(ctl, /export const sendLocalPlayDeparture = \(\) => localDepart\.runLocalDepart\(FS, \{ allowed: localDepartGate, context: expeditionContext,/);
  assert.match(ctl, /export const reconcileLocalPlayDeparture = \(\) => localDepart\.reconcileLocalDepart\(FS, \{ allowed: localDepartGate, changed: localDepartChanged \}\);/);
  const from = ctl.indexOf('const localDepartGate'), block = ctl.slice(from, ctl.indexOf('export const clearLocalPlayDeparture', from));
  for (const banned of ['fsession', 'FS.session', 'submit(', 'sendMarch', 'act(', 'faucet', 'storage']) assert.ok(!block.includes(banned), banned);
  // the general gate is as it was: the refusals of local play are all still there
  assert.match(ctl, /const localPlayReadOnly = \(\) => \(\{ code: 'LocalPlayReadOnly'/);
  // (2026-11-12, the economy path: two of the three are unconditional as they were; the one in `act` asks ONE decision
  //  — flocalplay-act.mjs `localOrderRoute` — and refuses everything but the six economy commands in their plain form.
  //  What that decision does for every command, Depart included, is tested as behaviour in web-frontier-local-play-act.test.mjs.)
  assert.equal([...ctl.matchAll(/if \(localPlay\) return (failed|early)\(localPlayReadOnly\(\)\)/g)].length, 1, 'the one unconditional refusal of local play is as it was'); assert.equal(ctl.split('if (localPlay && FS.localMarch?.open !== true) return failed(localPlayReadOnly());').length - 1, 1, '(2026-11-13, march lane) the march\'s refusal: unless its own answer is open');
  assert.equal(ctl.split("const route = localAct.localOrderRoute({ localPlay, name, v, signer, requester });\n  if (route === 'refuse') return early(localPlayReadOnly());").length - 1, 1);
  assert.match(ctl, /if \(localPlay\) \{ orderAnswered\(order, false, \{ code: 'LocalPlayReadOnly', sent: false \}\); return failed\(localPlayReadOnly\(\)\); \}/);
  // (2026-11-12, the economy path: `join` and `home-confirm` left the list — in local play they are the page-signed Join
  //  and PlaceHome and make no key; what they may do is pinned in web-frontier-local-play.test.mjs and web-frontier-local-play-act.test.mjs)
  assert.match(ctl, /export const LOCAL_PLAY_REFUSED = Object\.freeze\(\['session', 'nft-login', 'nft-logout', 'prize-faucet', 'nudge', 'forget'\]\);/);
  assert.match(ctl, /const restored = sc && !localPlay \? await fsession\.restore\(sc, address\) : null;/);
});

test('the clock moving on, first noticed at any step of the run, ends it unsent: while sealing, while the relay prepares, while the wallet connects or signs, and in the very turn of the POST', async () => {
  const forward = [['the next slot', q => { q.fs.chain.last = { slot: (q.fs.chain.last?.slot ?? 100) + 1, unix: (q.fs.chain.last?.unix ?? 1000) + 1 }; }], ['the next turn', q => { q.fs.nowBell++; }], ['another measured rate', q => { q.fs.chain.rate = (q.fs.chain.rate ?? 1) + 0.01; }]];
  for (const [how, move] of forward) {
    // (nothing looks at the draft between the move and the run's own guard: the guard is the first to notice)
    // while the seal is made
    let p = await page(), d = deps(p); d.options.seal = async req => { move(p); return sealStub()(req); };
    let s = await LD.runLocalDepart(p.fs, d.options);
    assert.equal(s.status, 'error', how); assert.equal(s.error, 'DepartDraftChanged', `${how} while sealing`); assert.equal(s.sent, false); assert.equal(d.log.posts.length, 0, 'nothing is asked of the relay');
    assert.equal(p.fs.expeditionCompose.directions.length, 1, 'the steps stand'); assert.equal(p.fs.expeditionCompose.contextCheck, null, 'the observation is dropped: read again before another run');
    // while the relay prepares
    p = await page(); d = deps(p, { prepare: request => { const a = honest(request); move(p); return a; } });
    s = await LD.runLocalDepart(p.fs, d.options);
    assert.equal(s.error, 'DepartDraftChanged', `${how} while preparing`); assert.equal(s.sent, false); assert.equal(s.signature, null); assert.equal(d.count(S), 0);
    // while the wallet connects, and while it signs: nothing is submitted
    for (const at of ['connect', 'sign']) {
      p = await page(); d = deps(p);
      const real = EW.currentEphemeralWallet(), features = real.wallet.features; let signs = 0;
      const wrapped = { ...real, address: real.address, destroyed: false, wallet: { features: { ...features,
        'standard:connect': { connect: async () => { const r = await features['standard:connect'].connect(); if (at === 'connect') move(p); return r; } },
        'solana:signTransaction': { signTransaction: async (...a) => { signs++; const r = await features['solana:signTransaction'].signTransaction(...a); if (at === 'sign') move(p); return r; } } } } };
      d.options.signer = () => wrapped;
      s = await LD.runLocalDepart(p.fs, d.options);
      assert.equal(s.status, 'error', `${how} at ${at}`); assert.equal(s.error, 'DepartDraftChanged', `${how} at ${at}`); assert.equal(s.sent, false); assert.equal(d.count(S), 0, `${how} at ${at}: no submit`);
      assert.equal(signs, at === 'connect' ? 0 : 1, at === 'connect' ? 'nothing was signed' : 'what was signed is thrown away, never sent');
    }
    // in the repaint of "submitting", the last thing before the POST
    p = await page(); d = deps(p); const q = p, changed = d.options.changed;
    d.options.changed = () => { changed(); if (LD.localDepartOf(q.fs).status === 'submitting') move(q); };
    s = await LD.runLocalDepart(p.fs, d.options);
    assert.equal(s.status, 'error', `${how} before the POST`); assert.equal(s.error, 'DepartDraftChanged'); assert.equal(s.sent, false, 'not sent'); assert.equal(d.count(S), 0); assert.equal(d.count(T), 0);
    assert.equal(LD.localDepartSpent(p.fs), false, 'nothing was sent on that observation'); assert.equal(LD.clearLocalDepart(p.fs), true);
    // after it: the conditions are read again under the new clock, and a run goes through
    await observe(p); d = deps(p); d.options.seal = sealStub([{}, {}]); d.options.requestId = 'lp-again';
    s = await LD.runLocalDepart(p.fs, d.options);
    assert.equal(s.status, 'confirmed', `${how}: a new read, a new run`);
  }
  // a tick before the press: the run begins on the draft as it then stands, which has no observation
  const p = await page(); p.fs.nowBell++; const d = deps(p);
  const s = await LD.runLocalDepart(p.fs, d.options);
  assert.equal(s.status, 'error'); assert.equal(s.error, 'DepartObservationUnavailable'); assert.equal(d.log.seals.length, 1, 'the seal is made'); assert.equal(d.log.posts.length, 0, 'nothing is prepared or sent');
});
