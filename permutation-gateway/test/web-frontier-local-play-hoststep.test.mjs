// Local play: ONE player-signed step at a time for the host the expedition card observes, across the step modules
// (flocalplay-hoststep.mjs): the return's Dissolve / Return (flocalplay-return.mjs) and the siege's DeclareSiege
// (flocalplay-conquest.mjs). Alternating, concurrent and unknown-outcome cases, in both directions.
// A KEY-USING test (scripts/ci/node-key-tests.txt): the memory-only wallet signs the prepared messages. No chain, no
// network. The siege side runs under explicit TEST-ONLY conditions and a stand-in world capability, which say nothing
// about the real program or world.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { seasonAddresses, hostId } from '../../permutation-server/web/frontier/faddr.mjs';
import { encode, decode as fromB58 } from '../../permutation-server/web/sdk/base58.mjs';
import { encodeAccount } from '../../permutation-server/web/sdk/frontier/codec.mjs';
import { decode } from '../../permutation-server/web/frontier/fcodec.mjs';
import { EXPEDITION_POP, clearInspection, inspectExpedition, requestDigest } from '../../permutation-server/web/frontier/fexpedition.mjs';
import { canonicalDeclareSiegeRoles, declareSiegeInstruction, DECLARE_SIEGE_DISPATCH } from '../../permutation-server/web/frontier/fconquest-identity.mjs';
import * as LD from '../../permutation-server/web/frontier/flocalplay-depart.mjs';
import * as LT from '../../permutation-server/web/frontier/flocalplay-return.mjs';
import * as LC from '../../permutation-server/web/frontier/flocalplay-conquest.mjs';
import * as HS from '../../permutation-server/web/frontier/flocalplay-hoststep.mjs';
import * as EW from '../../permutation-server/web/frontier/fephemeral-wallet.mjs';
import * as hand from '../../permutation-server/web/frontier/hud/hand.mjs';
import { setLang } from '../../permutation-server/web/lang.mjs';
import { syntheticReturnInspection } from '../screens/codex/return-observation.mjs';
import { syntheticPreparation } from '../screens/codex/prepare-observation.mjs';
import { compileMessage, parseMessage, parseTransaction, COMPUTE_BUDGET_PROGRAM } from '../../permutation-server/web/sdk/solana-tx.mjs';
import { fromBase64, toBase64, toHex } from '../../permutation-server/web/sdk/bytes.mjs';
import { sha256 } from '../../permutation-server/web/sdk/sha256.mjs';

const LOCAL = { cluster: 'localnet', hostname: '127.0.0.1', localPlay: true };
const PROGRAM = encode(new Uint8Array(32).fill(94)), A = seasonAddresses(PROGRAM, '1');
const PIN = { programId: PROGRAM, cluster: 'localnet', seasonId: '1', addresses: A };
const HOST = hostId({ p: 2, q: 0, site: 3, gen: 1, seq: 0 }).toString();
const acct = (kind, values) => decode(kind, encodeAccount(kind, { SEASON_ID: 1n, ...values }));
const SEASON = decode('Season', Buffer.from(JSON.parse(readFileSync(new URL('fixtures/frontier/season.json', import.meta.url), 'utf8')).bytes_b64, 'base64'));
const RELAY = 'http://127.0.0.1:41966';
/** TEST-ONLY stand-ins for the siege side. */
const WORLD = { schema: 'frontier-local-play-conquest-world-v1', program: PROGRAM, season: A.season, world_preset: 'local-conquest-test-v1', free_city: { p: '129', q: '0', site: 3, tile: 43 } };
const TEST_CONDITIONS = { heapConfirmed: true };

/** A page in local play whose card observes an original host that STAYS at (129, 0): both a Dissolve and a siege could be offered. */
async function page() {
  EW.destroyEphemeralWallet();
  const signer = await EW.createEphemeralWallet(LOCAL), WALLET = signer.address, OWNER = A.of('Citizen', { wallet: WALLET });
  const h = acct('Holding', { P: 2, Q: 0, SITE: 3, GEN: 1, TILE: 30, STATE: 2, FACTION: 0, TIER: 1, HOST_SEQ: 1, OWNER_CITIZEN: fromB58(OWNER), RESERVE: [400, 0, 0, 0, 0, 0, 100, 0] });
  const province = acct('Province', { P: 2, Q: 0, RESOLVED_NEXT: 42, SITE_COUNT: 1, SITES: Uint8Array.of(30, ...new Array(11).fill(0)), PASSABLE_MASK: (1n << 61n) - 1n,
    SITE_MIRROR: [{ STATE: 1, GEN: 1, FACTION: 0, TIER: 1 }, ...Array.from({ length: 11 }, () => ({ STATE: 0 }))],
    ENTRIES: [{ ID: BigInt(HOST), FACTION: 0, UNIT: 0, TILE: 30, STATE: 1, TROOPS: 600000, STAMINA_VALUE: 120, STAMINA_BELL: 42 }] });
  const fs = { mode: 'play', sample: null, proto: null, season: { ...SEASON, seasonId: 1n, programVersion: 18436, rulesetHash: new Uint8Array(32).fill(1) },
    wallet: { address: WALLET }, resident: null, session: null, meStatus: 'ready', meAnswered: true,
    localPlay: { address: WALLET, programId: PROGRAM, cluster: 'localnet', seasonId: '1', seasonAddress: A.season, conquestWorld: WORLD },
    citizen: acct('Citizen', { WALLET: fromB58(WALLET), FACTION: 0, FLAGS: 5, TICKET_BELL: 0xffffffff, HOLDING: [{ P: 2, Q: 0, SITE: 3, GEN: 1 }, { GEN: 255 }, { GEN: 255 }] }), holdings: [h], activeHolding: 0,
    selected: { kind: 'tile', p: 2, q: 0, idx: 30 }, hand: { host: HOST, pop: EXPEDITION_POP }, nowBell: 42, chain: { now: () => 1000 }, provinces: new Map([['2,0', { province }]]),
    view: { lod: 'tile', fog: true }, land: { stage: 'final' }, marches: [], book: [], orders: [], compose: null };
  clearInspection(fs);
  fs.expeditionPreview.p = '129'; fs.expeditionPreview.q = '0'; fs.expeditionPreview.sequence = '';
  const p = { fs, ctx: { pin: PIN, relay: RELAY, source: {} }, signer, WALLET };
  await observe(p);
  return p;
}
const observe = p => inspectExpedition(p.fs, { context: () => p.ctx, read: async r => syntheticReturnInspection(r, { phase: 'dissolve' }) });
/** The stand-in prepared answer of a siege (canonical accounts, wrapped DeclareSiege), built by this test. */
function siegeAnswer(request) {
  const s = request.source_request, roles = canonicalDeclareSiegeRoles(s, request.target.site).map(x => ({ ...x })), pin = DECLARE_SIEGE_DISPATCH;
  const budget = (op, n, len = 5) => { const d = new Uint8Array(len); d[0] = op; new DataView(d.buffer).setUint32(1, n, true); return { programId: COMPUTE_BUDGET_PROGRAM, keys: [], data: d }; };
  const data = declareSiegeInstruction(request.target.site, request.target.entry), hash = encode(new Uint8Array(32).fill(77));
  const message = compileMessage({ feePayer: s.wallet, recentBlockhash: hash, instructions: [budget(2, 400000), budget(3, 0, 9), budget(4, 1048576), budget(1, pin.heap),
    { programId: s.program, keys: roles.map(x => ({ pubkey: x.address, isSigner: x.signer, isWritable: x.writable })), data }] });
  const m = parseMessage(message), h = m.header, n = m.accountKeys.length, slot = (BigInt(request.source_context_slot) + 1n).toString();
  const report = { schema: LC.LOCAL_CONQUEST_REPORT_SCHEMA, status: 'prepared', request: structuredClone(request),
    source: { request_digest: requestDigest(s), context_slot: slot, digest: 'cd'.repeat(32), coherent: true, authority_verified: false },
    blockhash: { hash, latest_context_slot: slot, validity_context_slot: slot, height_min_context_slot: slot, block_height: '100', last_valid_block_height: '250', remaining_block_heights: '150',
      valid: true, commitment: 'confirmed', coherent: false, authority_verified: false },
    prepared: { program: s.program, season: s.season, program_version: '18436', action: 'DeclareSiege', fee_payer: s.wallet, dispatch: { tag: pin.tag, kind: pin.kind },
      budget: { cu_limit: 400000, cu_price: '0', loaded_limit: 1048576, heap: pin.heap }, roles, instruction_hex: toHex(data), message_b64: toBase64(message), message_digest: toHex(sha256(message)),
      signers: m.signers, shape: { bytes: message.length + 65, locks: n, writes: n - h.numReadonlySignedAccounts - h.numReadonlyUnsignedAccounts, sigs: 1 } },
    blocker: null, host_only: true, ready: false, deployment_verified: false, admitted: false, signed: false, enqueued: false, relay_submission_available: false, automatic_send: false };
  return { report, submit: { route: 'POST /f/local-play/conquest/submit', schema: 'frontier-local-play-conquest-submit-v1', message_digest: report.prepared.message_digest, last_valid_block_height: '250', signer: s.wallet } };
}
const returnAnswer = request => { const report = syntheticPreparation(request);
  return { report, submit: { route: 'POST /f/local-play/resident/submit', schema: 'frontier-local-play-resident-submit-v1', message_digest: report.prepared.message_digest, last_valid_block_height: report.blockhash.last_valid_block_height, signer: request.source_request.wallet } }; };
/** One stand-in relay for both flows. `submit(flow)` → 'submitted' | 'unknown' | throws | a promise; `status(flow)` → `{status, …}`. */
function relay(p, { submit = () => 'submitted', status = () => ({ status: 'confirmed', slot: 70 }) } = {}) {
  const posts = [];
  const flowOf = path => (path.includes('/conquest/') ? 'conquest' : 'return');
  const post = async (origin, path, body) => {
    const flow = flowOf(path), step = path.split('/').at(-1);
    posts.push({ flow, step });
    if (step === 'prepare') return flow === 'conquest' ? siegeAnswer(body) : returnAnswer(body);
    if (step === 'submit') {
      const signature = encode(parseTransaction(fromBase64(body.transaction_b64)).signatures[0]);
      const r = await submit(flow, signature);
      return { status: r, signature, status_route: `POST /f/local-play/${flow === 'conquest' ? 'conquest' : 'resident'}/status` };
    }
    return { signature: body.signature, err: null, slot: null, ...(await status(flow)) };
  };
  const allowed = () => LD.localDepartAllowed({ localPlay: p.fs.localPlay, cluster: 'localnet', hostname: '127.0.0.1', relay: p.ctx.relay, wallet: p.fs.wallet?.address, signer: EW.currentEphemeralWallet() });
  const base = { allowed, context: () => p.ctx, signer: () => EW.currentEphemeralWallet(), post, changed: () => {} };
  return { posts, count: (flow, step) => posts.filter(x => x.flow === flow && x.step === step).length,
    ret: base, siege: { ...base, world: () => p.fs.localPlay.conquestWorld, conditions: TEST_CONDITIONS } };
}
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

test('two prepared messages never stand side by side: preparing one step discards the other\'s, in both directions', async () => {
  // return first, then the siege
  { const p = await page(), r = relay(p);
    assert.equal((await LT.prepareLocalReturn(p.fs, r.ret)).status, 'prepared');
    assert.equal((await LC.prepareLocalConquest(p.fs, r.siege)).status, 'prepared');
    assert.equal(LT.localReturnOf(p.fs).status, 'idle', 'the return\'s prepared message was discarded');
    assert.equal((await LT.sendLocalReturn(p.fs, r.ret)).status, 'idle'); assert.equal(r.count('return', 'submit'), 0, 'and it can no longer be sent');
    assert.equal((await LC.sendLocalConquest(p.fs, r.siege)).status, 'confirmed'); assert.equal(r.count('conquest', 'submit'), 1); }
  // the siege first, then the return
  { const p = await page(), r = relay(p);
    assert.equal((await LC.prepareLocalConquest(p.fs, r.siege)).status, 'prepared');
    assert.equal((await LT.prepareLocalReturn(p.fs, r.ret)).status, 'prepared');
    assert.equal(LC.localConquestOf(p.fs).status, 'idle');
    assert.equal((await LC.sendLocalConquest(p.fs, r.siege)).status, 'idle'); assert.equal(r.count('conquest', 'submit'), 0);
    assert.equal((await LT.sendLocalReturn(p.fs, r.ret)).status, 'confirmed'); assert.equal(r.count('return', 'submit'), 1); }
});

test('while one step is being sent, the other can be neither prepared nor sent (concurrent), in both directions', async () => {
  for (const [first, second] of [['return', 'conquest'], ['conquest', 'return']]) {
    const gate = deferred(), p = await page(), r = relay(p, { submit: flow => (flow === first ? gate.promise : 'submitted') });
    const run = { return: { prepare: () => LT.prepareLocalReturn(p.fs, r.ret), send: () => LT.sendLocalReturn(p.fs, r.ret), of: () => LT.localReturnOf(p.fs) },
      conquest: { prepare: () => LC.prepareLocalConquest(p.fs, r.siege), send: () => LC.sendLocalConquest(p.fs, r.siege), of: () => LC.localConquestOf(p.fs) } };
    assert.equal((await run[first].prepare()).status, 'prepared');
    const sending = run[first].send();
    while (r.count(first, 'submit') < 1) await new Promise(x => setImmediate(x));
    assert.equal(run[first].of().busy, true); assert.equal(HS.hostStepInFlight(p.fs, second), first);
    // the other step, pressed while the first is on its way
    const blocked = await run[second].prepare();
    assert.deepEqual([blocked.status, blocked.error, blocked.sent], ['error', 'HostStepInFlight', false], `${second} during ${first}`);
    assert.equal((await run[second].send()).status, 'error'); assert.equal(r.count(second, 'prepare'), 0); assert.equal(r.count(second, 'submit'), 0);
    gate.resolve('submitted');
    assert.equal((await sending).status, 'confirmed');
    // the first has settled: the observation it was sent on is used up for the OTHER step too
    assert.equal(HS.hostStepInFlight(p.fs, second), null);
    const spent = await run[second].prepare();
    assert.equal(spent.status, 'error'); assert.match(spent.error, /ObservationSpent$/); assert.equal(r.count(second, 'prepare'), 0);
    assert.equal(LT.localReturnSpent(p.fs), true); assert.equal(LC.localConquestSpent(p.fs), true);
    // read again: a step may be prepared again
    await observe(p); assert.equal(LT.localReturnSpent(p.fs), false); assert.equal(LC.localConquestSpent(p.fs), false);
    LT.clearLocalReturn(p.fs); LC.clearLocalConquest(p.fs);
    assert.equal((await run[second].prepare()).status, 'prepared');
  }
});

test('while one step\'s outcome is unknown or merely submitted, the other is refused; only that step\'s own status look-up moves anything', async () => {
  for (const [first, second] of [['return', 'conquest'], ['conquest', 'return']]) for (const outcome of ['unknown', 'pending']) {
    const p = await page();
    const r = relay(p, { submit: flow => { if (flow === first && outcome === 'unknown') throw Object.assign(new Error('socket'), { code: 'LocalPlayRpcUnavailable' }); return 'submitted'; }, status: () => ({ status: 'pending' }) });
    const run = { return: { prepare: () => LT.prepareLocalReturn(p.fs, r.ret), send: () => LT.sendLocalReturn(p.fs, r.ret), reconcile: () => LT.reconcileLocalReturn(p.fs, r.ret), clear: () => LT.clearLocalReturn(p.fs) },
      conquest: { prepare: () => LC.prepareLocalConquest(p.fs, r.siege), send: () => LC.sendLocalConquest(p.fs, r.siege), reconcile: () => LC.reconcileLocalConquest(p.fs, r.siege), clear: () => LC.clearLocalConquest(p.fs) } };
    await run[first].prepare();
    const s = await run[first].send();
    assert.equal(s.status, outcome === 'unknown' ? 'unknown' : 'submitted', `${first} ${outcome}`);
    for (let i = 0; i < 2; i++) {
      const b = await run[second].prepare();
      assert.deepEqual([b.status, b.error], ['error', 'HostStepInFlight'], `${second} while ${first} is ${outcome}`);
      assert.equal((await run[second].send()).status, 'error');
    }
    assert.equal(r.count(second, 'prepare'), 0); assert.equal(r.count(second, 'submit'), 0); assert.equal(r.count(first, 'submit'), 1, 'and the first is never sent again');
    assert.equal(run[first].clear(), false, 'an unsettled step cannot be cleared to make room');
    // the other step's refusal changed nothing of the first: it is still asked about by its own signature
    assert.equal((await run[first].reconcile()).status, outcome === 'unknown' ? 'unknown' : 'submitted'); assert.equal(HS.hostStepInFlight(p.fs, second), first);
  }
});

test('F2 — a step settled as "did not land" releases the host: the old reading stays used, and on a FRESH reading the other step is prepared (both directions)', async () => {
  // (stand-in relay answers; prepared messages have a last valid block height of 250)
  const EXPIRED = { status: 'expired_unlanded', context_slot: 251, last_valid_block_height: '250' };
  for (const [first, second] of [['siege', 'ret'], ['ret', 'siege']]) {
    const p = await page();
    const run = { siege: { prepare: LC.prepareLocalConquest, send: LC.sendLocalConquest, reconcile: LC.reconcileLocalConquest, flow: 'conquest' },
      ret: { prepare: LT.prepareLocalReturn, send: LT.sendLocalReturn, reconcile: LT.reconcileLocalReturn, flow: 'return' } };
    // the first step is sent and its outcome is not settled: the other step is held off
    let answer = { status: 'pending' };
    const r = relay(p, { status: () => answer });
    await run[first].prepare(p.fs, r[first]); let s = await run[first].send(p.fs, r[first]); assert.equal(s.status, 'submitted', first);
    let other = await run[second].prepare(p.fs, r[second]); assert.equal(other.status, 'error'); assert.equal(r.count(run[second].flow, 'prepare'), 0);
    // the relay settles it as "did not land": terminal; ONE submit was made and none follows
    answer = EXPIRED; s = await run[first].reconcile(p.fs, r[first]);
    assert.deepEqual([s.status, s.busy, s.chain], ['expired', false, 'expired_unlanded'], first);
    assert.equal(HS.hostStepInFlight(p.fs, second === 'siege' ? 'conquest' : 'return'), null, 'the host is released');
    // the OLD reading stays used: neither step is prepared on it
    other = await run[second].prepare(p.fs, r[second]); assert.equal(other.status, 'error'); assert.match(other.error, /ObservationSpent$/); assert.equal(r.count(run[second].flow, 'prepare'), 0);
    // (the same step again on the used reading: refused for the used reading too, with nothing asked of the relay)
    const before = r.count(run[first].flow, 'prepare'), same = await run[first].prepare(p.fs, r[first]);
    assert.equal(same.status, 'error'); assert.match(same.error, /ObservationSpent$/); assert.equal(r.count(run[first].flow, 'prepare'), before);
    // a FRESH reading: the other step is prepared
    await observe(p);
    other = await run[second].prepare(p.fs, r[second]); assert.equal(other.status, 'prepared', `${second} after ${first} expired`);
    assert.equal(r.count(run[first].flow, 'submit'), 1); assert.equal(r.count(run[second].flow, 'submit'), 0);
    EW.destroyEphemeralWallet();
  }
});

test('the registry itself: a step is claimed against the others, names are unique, the used observation is one record', async () => {
  const p = await page(), r = relay(p);
  assert.equal(HS.hostStepInFlight(p.fs, 'return'), null); assert.equal(HS.hostStepInFlight(p.fs, 'conquest'), null);
  assert.throws(() => HS.registerHostStep('return', () => ({})), /bad host step/); assert.throws(() => HS.registerHostStep('', () => ({})), /bad host step/);
  assert.throws(() => HS.claimHostStep(p.fs, 'nobody'), { code: 'HostStepUnknown' });
  await LT.prepareLocalReturn(p.fs, r.ret);
  // holding (about to sign) is refused while ANOTHER step even holds a prepared message; claiming discards it instead
  assert.throws(() => HS.holdHostStep(p.fs, 'conquest'), { code: 'HostStepInFlight' });
  HS.claimHostStep(p.fs, 'conquest'); assert.equal(LT.localReturnOf(p.fs).status, 'idle'); HS.holdHostStep(p.fs, 'conquest');
  // the used observation is one record for every step
  const report = p.fs.expeditionPreview.report;
  assert.equal(HS.hostObservationSpent(p.fs, report), false); HS.spendHostObservation(p.fs, report);
  assert.equal(HS.hostObservationSpent(p.fs, report), true); assert.equal(HS.hostObservationSpent(p.fs, { ...report }), false); assert.equal(HS.hostObservationSpent(null, report), false);
});

test('the card: while one step is in flight or unknown, the other step\'s controls are disabled and say why', async () => {
  const p = await page(), card = () => String(hand.renderPop(p.fs, hand.handModel(p.fs)));
  setLang('ja');
  try {
    const r = relay(p, { submit: flow => { if (flow === 'return') throw new Error('reset'); return 'submitted'; } });
    let c = card();
    assert.doesNotMatch(c, /data-act="local-return-prepare" aria-disabled/); assert.doesNotMatch(c, /data-act="local-conquest-prepare" aria-disabled/); assert.doesNotMatch(c, /別の手順を送っているか/);
    await LT.prepareLocalReturn(p.fs, r.ret); assert.equal((await LT.sendLocalReturn(p.fs, r.ret)).status, 'unknown');
    c = card();
    assert.match(c, /data-act="local-return-reconcile"/); assert.match(c, /data-act="local-conquest-prepare" aria-disabled="true"/); assert.match(c, /別の手順を送っているか、その結果がまだ分かっていません/);
    // the reverse, on a fresh page
    const q = await page(), rq = relay(q, { submit: flow => { if (flow === 'conquest') throw new Error('reset'); return 'submitted'; } }), cardQ = () => String(hand.renderPop(q.fs, hand.handModel(q.fs)));
    await LC.prepareLocalConquest(q.fs, rq.siege); assert.equal((await LC.sendLocalConquest(q.fs, rq.siege)).status, 'unknown');
    c = cardQ();
    assert.match(c, /data-act="local-conquest-reconcile"/); assert.match(c, /data-act="local-return-prepare" aria-disabled="true"/); assert.match(c, /別の手順を送っているか、その結果がまだ分かっていません/);
  } finally { setLang('ja'); EW.destroyEphemeralWallet(); }
});

// LAST in this file: it registers a third, test-only step whose answers are switched below. Registered once (names are
// unique for the life of the module), left in its well-formed idle answer at the end.
test('FAIL CLOSED: a step whose probe throws, or answers anything but its exact shape, counts as in flight; a prepared message that cannot be discarded fails the claim', async () => {
  const idle = () => ({ busy: false, open: false, prepared: false, discard() {} });
  let answer = idle;
  HS.registerHostStep('test-step', fs => answer(fs));
  const p = await page(), r = relay(p);
  const inFlight = why => {
    assert.equal(HS.hostStepInFlight(p.fs, 'return'), 'test-step', why); assert.equal(HS.hostStepInFlight(p.fs, 'conquest'), 'test-step', why);
    assert.throws(() => HS.claimHostStep(p.fs, 'return'), { code: 'HostStepInFlight' }, why); assert.throws(() => HS.holdHostStep(p.fs, 'conquest'), { code: 'HostStepInFlight' }, why);
  };
  // well formed and idle: nothing is blocked
  assert.equal(HS.hostStepInFlight(p.fs, 'return'), null); HS.claimHostStep(p.fs, 'return'); HS.holdHostStep(p.fs, 'return');
  // a probe that really throws
  answer = () => { throw new Error('broken probe'); }; inFlight('throws');
  // answers that are not the exact shape: nothing, an empty object, missing or non-boolean fields, no discard
  for (const [bad, why] of [[null, 'null'], [undefined, 'undefined'], [{}, 'empty object'], ['idle', 'a string'], [0, 'a number'], [[], 'an array'],
    [{ busy: false, open: false, prepared: false }, 'no discard'], [{ busy: false, open: false, discard() {} }, 'no prepared'], [{ open: false, prepared: false, discard() {} }, 'no busy'],
    [{ busy: 0, open: false, prepared: false, discard() {} }, 'busy not a boolean'], [{ busy: false, open: 'no', prepared: false, discard() {} }, 'open not a boolean'],
    [{ busy: false, open: false, prepared: 1, discard() {} }, 'prepared not a boolean'], [{ busy: false, open: false, prepared: false, discard: true }, 'discard not a function']]) {
    answer = () => bad; inFlight(why);
  }
  // and the real steps refuse beside it: nothing is prepared, posted or sent while a step's state is not known
  answer = () => ({});
  for (const run of [() => LT.prepareLocalReturn(p.fs, r.ret), () => LC.prepareLocalConquest(p.fs, r.siege)]) {
    const s = await run(); assert.deepEqual([s.status, s.error, s.sent], ['error', 'HostStepInFlight', false]);
  }
  assert.equal(r.posts.length, 0);
  // a prepared message whose discard throws: the claim fails (it still stands), nothing is prepared beside it
  let discards = 0;
  answer = () => ({ busy: false, open: false, prepared: true, discard() { discards++; throw new Error('cannot forget'); } });
  assert.equal(HS.hostStepInFlight(p.fs, 'return'), null, 'merely prepared is not in flight');
  assert.throws(() => HS.claimHostStep(p.fs, 'return'), { code: 'HostStepInFlight' }); assert.equal(discards, 1);
  assert.throws(() => HS.holdHostStep(p.fs, 'return'), { code: 'HostStepInFlight' });
  let s = await LC.prepareLocalConquest(p.fs, r.siege); assert.deepEqual([s.status, s.error], ['error', 'HostStepInFlight']); assert.equal(r.posts.length, 0);
  // a discard that returns but leaves the message standing (or leaves the step busy, open, or unreadable) fails the claim too
  for (const after of [() => ({ busy: false, open: false, prepared: true, discard() {} }), () => ({ busy: true, open: false, prepared: false, discard() {} }), () => null]) {
    let told = false;
    answer = () => (told ? after() : { busy: false, open: false, prepared: true, discard() { told = true; } });
    assert.throws(() => HS.claimHostStep(p.fs, 'return'), { code: 'HostStepInFlight' }); assert.equal(told, true);
  }
  // a discard that works: the claim succeeds, and the real flows go on as before
  let gone = false;
  answer = () => ({ busy: false, open: false, prepared: !gone, discard() { gone = true; } });
  HS.claimHostStep(p.fs, 'return'); assert.equal(gone, true);
  s = await LT.prepareLocalReturn(p.fs, r.ret); assert.equal(s.status, 'prepared');
  // an unregistered name can neither claim nor hold
  assert.throws(() => HS.claimHostStep(p.fs, 'nobody'), { code: 'HostStepUnknown' }); assert.throws(() => HS.holdHostStep(p.fs, 'nobody'), { code: 'HostStepUnknown' });
  answer = idle; LT.clearLocalReturn(p.fs); EW.destroyEphemeralWallet();
});
