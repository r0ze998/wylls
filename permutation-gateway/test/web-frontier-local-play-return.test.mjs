// Local play: the return's two player-signed steps (Dissolve, then Return) from the return card's own observation,
// through the loopback relay's resident routes (flocalplay-return.mjs). A KEY-USING test
// (scripts/ci/node-key-tests.txt): the memory-only wallet's non-extractable key is made by WebCrypto in this process
// and signs the prepared message. No chain, no network: the observation and the prepared report are the repository's
// own synthetic ones (screens/codex/return-observation.mjs, prepare-observation.mjs), for THIS page's request.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { seasonAddresses, hostId } from '../../permutation-server/web/frontier/faddr.mjs';
import { encode, decode as fromB58 } from '../../permutation-server/web/sdk/base58.mjs';
import { encodeAccount } from '../../permutation-server/web/sdk/frontier/codec.mjs';
import { decode } from '../../permutation-server/web/frontier/fcodec.mjs';
import { EXPEDITION_POP, clearInspection, inspectExpedition } from '../../permutation-server/web/frontier/fexpedition.mjs';
import { preparationRequest } from '../../permutation-server/web/frontier/fexpedition-prepare.mjs';
import * as LD from '../../permutation-server/web/frontier/flocalplay-depart.mjs';
import * as LT from '../../permutation-server/web/frontier/flocalplay-return.mjs';
import * as EW from '../../permutation-server/web/frontier/fephemeral-wallet.mjs';
import * as hand from '../../permutation-server/web/frontier/hud/hand.mjs';
import { setLang, missingKeys } from '../../permutation-server/web/lang.mjs';
import { syntheticReturnInspection } from '../screens/codex/return-observation.mjs';
import { syntheticPreparation } from '../screens/codex/prepare-observation.mjs';
import { parseTransaction } from '../../permutation-server/web/sdk/solana-tx.mjs';
import { fromBase64 } from '../../permutation-server/web/sdk/bytes.mjs';

const LOCAL = { cluster: 'localnet', hostname: '127.0.0.1', localPlay: true };
const PROGRAM = encode(new Uint8Array(32).fill(94)), A = seasonAddresses(PROGRAM, '1');
const PIN = { programId: PROGRAM, cluster: 'localnet', seasonId: '1', addresses: A };
const HOST = hostId({ p: 2, q: 0, site: 3, gen: 1, seq: 0 }).toString();
const acct = (kind, values) => decode(kind, encodeAccount(kind, { SEASON_ID: 1n, ...values }));
const SEASON = decode('Season', Buffer.from(JSON.parse(readFileSync(new URL('fixtures/frontier/season.json', import.meta.url), 'utf8')).bytes_b64, 'base64'));
const RELAY = 'http://127.0.0.1:41966';

/** A page in local play with the return card open on an original host observed staying in wide land at (129, 0). */
async function page(phase = 'dissolve') {
  EW.destroyEphemeralWallet();
  const signer = await EW.createEphemeralWallet(LOCAL), WALLET = signer.address, OWNER = A.of('Citizen', { wallet: WALLET });
  const h = acct('Holding', { P: 2, Q: 0, SITE: 3, GEN: 1, TILE: 30, STATE: 2, FACTION: 0, TIER: 1, HOST_SEQ: 1, OWNER_CITIZEN: fromB58(OWNER), RESERVE: [400, 0, 0, 0, 0, 0, 100, 0] });
  const province = acct('Province', { P: 2, Q: 0, RESOLVED_NEXT: 42, SITE_COUNT: 1, SITES: Uint8Array.of(30, ...new Array(11).fill(0)), PASSABLE_MASK: (1n << 61n) - 1n,
    SITE_MIRROR: [{ STATE: 1, GEN: 1, FACTION: 0, TIER: 1 }, ...Array.from({ length: 11 }, () => ({ STATE: 0 }))],
    ENTRIES: [{ ID: BigInt(HOST), FACTION: 0, UNIT: 0, TILE: 30, STATE: 1, TROOPS: 600000, STAMINA_VALUE: 120, STAMINA_BELL: 42 }] });
  const fs = { mode: 'play', sample: null, proto: null, season: { ...SEASON, seasonId: 1n, programVersion: 18436, rulesetHash: new Uint8Array(32).fill(1) },
    wallet: { address: WALLET }, resident: null, session: null, meStatus: 'ready', meAnswered: true,
    localPlay: { address: WALLET, programId: PROGRAM, cluster: 'localnet', seasonId: '1', seasonAddress: A.season },
    citizen: acct('Citizen', { WALLET: fromB58(WALLET), FACTION: 0, FLAGS: 5, TICKET_BELL: 0xffffffff, HOLDING: [{ P: 2, Q: 0, SITE: 3, GEN: 1 }, { GEN: 255 }, { GEN: 255 }] }), holdings: [h], activeHolding: 0,
    selected: { kind: 'tile', p: 2, q: 0, idx: 30 }, hand: { host: HOST, pop: EXPEDITION_POP }, nowBell: 42, chain: { now: () => 1000 }, provinces: new Map([['2,0', { province }]]),
    view: { lod: 'tile', fog: true }, land: { stage: 'final' }, marches: [], book: [], orders: [], compose: null };
  clearInspection(fs);
  fs.expeditionPreview.p = '129'; fs.expeditionPreview.q = '0'; fs.expeditionPreview.sequence = '';
  const ctx = { pin: PIN, relay: RELAY, source: {} };
  const p = { fs, ctx, signer, WALLET };
  await observe(p, phase);
  return p;
}
/** The card reads (again): a new observation at `phase`. */
async function observe(p, phase) {
  await inspectExpedition(p.fs, { context: () => p.ctx, read: async r => syntheticReturnInspection(r, { phase }) });
  assert.ok(p.fs.expeditionPreview.report, 'observed');
}
/** What the relay answers a `prepare`: the existing report for THIS request and the submit note. */
const honest = (request, { report: reshape = null, submit: resubmit = null } = {}) => {
  let report = syntheticPreparation(request); if (reshape) report = reshape(report);
  let submit = { route: 'POST /f/local-play/resident/submit', schema: 'frontier-local-play-resident-submit-v1', message_digest: report.prepared?.message_digest ?? null,
    last_valid_block_height: report.blockhash?.last_valid_block_height ?? null, signer: request.source_request.wallet };
  if (resubmit) submit = resubmit(submit);
  return { report, submit };
};
const blocked = (request, code) => ({ report: { ...syntheticPreparation(request), status: 'blocked', blockhash: null, prepared: null, blocker: { code } }, submit: null });
function deps(p, { prepare = request => honest(request), submit = () => 'submitted', status = () => ({ status: 'confirmed', slot: 77 }), allowed = null, onPost = null } = {}) {
  const log = { posts: [], states: [], statuses: 0 };
  const allow = allowed ?? (() => LD.localDepartAllowed({ localPlay: p.fs.localPlay, cluster: 'localnet', hostname: '127.0.0.1', relay: p.ctx.relay, wallet: p.fs.wallet?.address, signer: EW.currentEphemeralWallet() }));
  const post = async (origin, path, body) => {
    log.posts.push({ origin, path, body: JSON.parse(JSON.stringify(body)) });
    if (onPost) await onPost(path, log.posts.length);
    if (path === LT.LOCAL_RETURN_PREPARE_PATH) return prepare(body);
    if (path === LT.LOCAL_RETURN_SUBMIT_PATH) {
      const signature = encode(parseTransaction(fromBase64(body.transaction_b64)).signatures[0]);
      const r = await submit(body, signature);
      return typeof r === 'string' ? { status: r, signature, status_route: 'POST /f/local-play/resident/status' } : r;
    }
    const r = await status(body.signature, ++log.statuses);
    return r && typeof r.status === 'string' && !('signature' in r) ? { signature: body.signature, err: null, slot: null, ...r } : r;
  };
  const o = { allowed: allow, context: () => p.ctx, signer: () => EW.currentEphemeralWallet(), post, changed: () => { log.states.push(LT.localReturnOf(p.fs).status); } };
  return { log, options: o, count: path => log.posts.filter(x => x.path === path).length };
}
const P = LT.LOCAL_RETURN_PREPARE_PATH, S = LT.LOCAL_RETURN_SUBMIT_PATH, T = LT.LOCAL_RETURN_STATUS_PATH;

for (const [phase, action] of [['dissolve', 'Dissolve'], ['return', 'Return']]) test(`${action}: prepared from the card's own observation, shown, then the player's explicit send signs that very message once; the status confirms this step and no more`, async () => {
  const p = await page(phase), d = deps(p);
  // nothing is sent without a prepared step
  assert.equal((await LT.sendLocalReturn(p.fs, d.options)).status, 'idle'); assert.equal(d.log.posts.length, 0);
  const ready = await LT.prepareLocalReturn(p.fs, { ...d.options, requestId: 'lp_1' });
  assert.deepEqual([ready.status, ready.action, ready.busy, ready.sent, ready.signature], ['prepared', action, false, false, null]);
  assert.equal(d.count(P), 1); assert.equal(d.count(S), 0, 'preparing signs and sends nothing');
  // the request is the existing full preparation request, rebuilt from the observation: this wallet acts and pays
  const prep = d.log.posts[0].body, state = p.fs.expeditionPreview;
  assert.deepEqual(prep, JSON.parse(JSON.stringify(preparationRequest(state.report, state.request, 'lp_1'))));
  assert.equal(prep.action, action); assert.equal(prep.source_request.wallet, p.WALLET); assert.equal(prep.source_request.payer, p.WALLET); assert.equal(prep.source_request.deployment.program_version, '18436');
  assert.equal(ready.digest, honest(prep).report.prepared.message_digest); assert.equal(ready.lastValidBlockHeight, '250');
  if (action === 'Return') assert.equal(ready.returnUnits, '600'); else assert.equal(ready.returnUnits, null);
  // the explicit send
  const done = await LT.sendLocalReturn(p.fs, d.options);
  assert.deepEqual([done.status, done.chain, done.slot, done.sent, done.busy, done.action], ['confirmed', 'confirmed', 77, true, false, action]);
  assert.deepEqual(d.log.posts.map(x => [x.origin, x.path]), [[RELAY, P], [RELAY, S], [RELAY, T]]);
  const sub = d.log.posts[1].body, stat = d.log.posts[2].body;
  assert.deepEqual(Object.keys(sub), ['schema', 'message_digest', 'transaction_b64']); assert.equal(sub.schema, 'frontier-local-play-resident-submit-v1'); assert.equal(sub.message_digest, ready.digest);
  assert.deepEqual(stat, { schema: 'frontier-local-play-resident-status-v1', signature: done.signature });
  const tx = parseTransaction(fromBase64(sub.transaction_b64)), message = fromBase64(honest(prep).report.prepared.message_b64);
  assert.deepEqual([...tx.message], [...message]); assert.deepEqual(tx.signers, [p.WALLET]); assert.equal(encode(tx.signatures[0]), done.signature);
  const key = await crypto.subtle.importKey('raw', fromB58(p.WALLET), 'Ed25519', false, ['verify']);
  assert.equal(await crypto.subtle.verify('Ed25519', key, tx.signatures[0], tx.message), true);
  assert.deepEqual([...new Set(d.log.states)], ['preparing', 'prepared', 'signing', 'submitting', 'submitted', 'confirmed']);
  // the observation this step was sent on is used up: nothing more is prepared on it, until the card reads again
  assert.equal(LT.localReturnSpent(p.fs), true);
  assert.equal(LT.clearLocalReturn(p.fs), true); assert.equal(LT.localReturnSpent(p.fs), true, 'clearing the lines does not bring it back');
  const again = await LT.prepareLocalReturn(p.fs, d.options);
  assert.deepEqual([again.status, again.error], ['error', 'ReturnObservationSpent']); assert.equal(d.count(P), 1);
  await observe(p, phase === 'dissolve' ? 'resolving' : 'return'); assert.equal(LT.localReturnSpent(p.fs), false);
  // while the turn is still to be processed the observation names no step: nothing can be prepared
  if (phase === 'dissolve') { LT.clearLocalReturn(p.fs); const none = await LT.prepareLocalReturn(p.fs, d.options); assert.deepEqual([none.status, none.error], ['error', 'ReturnStepUnavailable']); assert.equal(d.count(P), 1); }
});

test('a double press starts one run; nothing new while one is in flight, submitted or unknown; a prepared message is offered once', async () => {
  const p = await page('return'), d = deps(p, { status: () => ({ status: 'pending' }) });
  const [a, b] = await Promise.all([LT.prepareLocalReturn(p.fs, d.options), LT.prepareLocalReturn(p.fs, d.options)]);
  assert.equal(d.count(P), 1); assert.ok([a.status, b.status].includes('prepared'));
  const [x, y] = await Promise.all([LT.sendLocalReturn(p.fs, d.options), LT.sendLocalReturn(p.fs, d.options)]);
  assert.equal(d.count(S), 1); assert.ok([x.status, y.status].includes('submitted'));
  // submitted: no prepare, no send, no clearing over it
  assert.equal((await LT.prepareLocalReturn(p.fs, d.options)).status, 'submitted'); assert.equal((await LT.sendLocalReturn(p.fs, d.options)).status, 'submitted'); assert.equal(LT.clearLocalReturn(p.fs), false);
  assert.equal(d.count(P), 1); assert.equal(d.count(S), 1);
  // a send that fails before anything left the page: the prepared message is not offered again (prepare again)
  const q = await page('dissolve'), dq = deps(q);
  assert.equal((await LT.prepareLocalReturn(q.fs, dq.options)).status, 'prepared');
  const live = q.fs.localPlay; q.fs.localPlay = { ...live, seasonAddress: encode(new Uint8Array(32).fill(77)) };
  const e = await LT.sendLocalReturn(q.fs, { ...dq.options, allowed: () => ({ ok: true, relay: RELAY }) });
  assert.deepEqual([e.status, e.error, e.sent], ['error', 'LocalReturnChanged', false]); assert.equal(dq.count(S), 0);
  q.fs.localPlay = live;
  assert.equal((await LT.sendLocalReturn(q.fs, dq.options)).status, 'error', 'no send without a new prepare'); assert.equal(dq.count(S), 0);
  assert.equal(LT.localReturnSpent(q.fs), false, 'a step that sent nothing uses nothing up');
});

test('an unknown outcome is not a success: asked about by its first signature on the status route only; never signed or sent again', async () => {
  const p = await page('dissolve'), d = deps(p, { submit: () => { throw Object.assign(new Error('socket'), { code: 'LocalPlayRpcUnavailable' }); } });
  await LT.prepareLocalReturn(p.fs, d.options);
  const s = await LT.sendLocalReturn(p.fs, d.options);
  assert.deepEqual([s.status, s.sent, s.busy, s.error], ['unknown', true, false, 'LocalPlayRpcUnavailable']); assert.equal(typeof s.signature, 'string');
  assert.equal(d.count(S), 1); assert.equal(d.count(T), 0); assert.equal(LT.localReturnSpent(p.fs), true);
  assert.equal((await LT.prepareLocalReturn(p.fs, d.options)).status, 'unknown'); assert.equal((await LT.sendLocalReturn(p.fs, d.options)).status, 'unknown'); assert.equal(LT.clearLocalReturn(p.fs), false);
  assert.equal(d.count(P), 1); assert.equal(d.count(S), 1);
  const ask = status => LT.reconcileLocalReturn(p.fs, { ...d.options, post: deps(p, { status }).options.post });
  let r = await ask(() => ({ status: 'pending' })); assert.deepEqual([r.status, r.chain], ['unknown', 'pending']);
  r = await ask(() => ({ signature: 'x', status: 'confirmed', err: null, slot: 1 })); assert.deepEqual([r.status, r.error], ['unknown', 'BadLocalReturnStatus']);
  r = await ask(() => { throw Object.assign(new Error('unknown'), { code: 'LocalPlayUnknownSignature', refused: true }); });
  assert.deepEqual([r.status, r.error], ['unknown', 'LocalPlayUnknownSignature'], 'a relay that does not know the signature proves nothing');
  // another identity's answer is not asked for
  const live = p.fs.localPlay; p.fs.localPlay = { ...live, programId: encode(new Uint8Array(32).fill(77)) };
  r = await LT.reconcileLocalReturn(p.fs, { ...d.options, allowed: () => ({ ok: true, relay: RELAY }) }); assert.deepEqual([r.status, r.error], ['unknown', 'LocalReturnIdentityChanged']);
  p.fs.localPlay = live;
  // the chain's own failure is a failure and nothing else
  r = await ask(() => ({ status: 'failed', err: { InstructionError: [3, { Custom: 6001 }] }, slot: 91 }));
  assert.deepEqual([r.status, r.chain, r.slot], ['failed', 'failed', 91]); assert.match(r.code, /Custom/);
  assert.equal(d.count(S), 1); assert.equal(LT.localReturnSpent(p.fs), true, 'a failed step used its observation up too: the card reads again first');
});

test('P5 F1 — an exception in the gate, the identity or the status answer never settles an unsettled return step and never leaves it busy', async () => {
  // (a) the gate throws during the automatic look right after the submit: `submitted` stays `submitted`
  let p = await page(), d = deps(p), arm = false;
  await LT.prepareLocalReturn(p.fs, d.options);
  const gate = d.options.allowed, post = d.options.post;
  const throwing = { ...d.options, allowed: () => { if (arm) throw new Error('gate exploded'); return gate(); },
    post: async (o, path, body) => { const r = await post(o, path, body); if (path === S) arm = true; return r; } };
  let s = await LT.sendLocalReturn(p.fs, throwing);
  assert.deepEqual([s.status, s.busy, s.sent], ['submitted', false, true]); assert.equal(typeof s.error, 'string'); assert.equal(d.count(S), 1);
  arm = false;
  assert.equal((await LT.prepareLocalReturn(p.fs, d.options)).status, 'submitted', 'no new prepare while unsettled'); assert.equal(LT.clearLocalReturn(p.fs), false); assert.equal(d.count(P), 1);
  // (b) the gate throws on a manual reconcile press: unsettled as before, busy released; a later press settles it
  arm = true; s = await LT.reconcileLocalReturn(p.fs, throwing);
  assert.deepEqual([s.status, s.busy, s.error], ['submitted', false, 'LocalReturnGateFailed']);
  arm = false; s = await LT.reconcileLocalReturn(p.fs, d.options); assert.deepEqual([s.status, s.busy], ['confirmed', false]);
  EW.destroyEphemeralWallet();
  // (c) the identity accessor throws; (d) a status answer that throws when read
  p = await page(); d = deps(p, { status: () => ({ status: 'pending' }) });
  await LT.prepareLocalReturn(p.fs, d.options); s = await LT.sendLocalReturn(p.fs, d.options); assert.equal(s.status, 'submitted');
  const live = p.fs.localPlay; p.fs.localPlay = { ...live, get seasonId() { throw new Error('no id'); } };
  s = await LT.reconcileLocalReturn(p.fs, { ...d.options, allowed: () => ({ ok: true, relay: p.ctx.relay }) });
  assert.deepEqual([s.status, s.busy, s.error], ['submitted', false, 'LocalReturnGateFailed']); p.fs.localPlay = live;
  s = await LT.reconcileLocalReturn(p.fs, { ...d.options, post: async (o, path, body) => ({ signature: body.signature, get status() { throw new Error('boom'); } }) });
  assert.deepEqual([s.status, s.busy], ['submitted', false]);
  s = await LT.reconcileLocalReturn(p.fs, { ...d.options, post: async (o, path, body) => ({ signature: body.signature, status: 'confirmed', err: null, get slot() { throw new Error('boom'); } }) });
  assert.deepEqual([s.status, s.busy], ['submitted', false]);
  // (e) an exception after the POST began is an outcome not known, never a settled `error`
  EW.destroyEphemeralWallet(); p = await page(); d = deps(p);
  await LT.prepareLocalReturn(p.fs, d.options);
  s = await LT.sendLocalReturn(p.fs, { ...d.options, post: async (o, path, body) => (path === S ? { get status() { throw new Error('boom'); }, signature: 'x' } : d.options.post(o, path, body)) });
  assert.deepEqual([s.status, s.busy, s.sent], ['unknown', false, true]);
  assert.equal((await LT.prepareLocalReturn(p.fs, d.options)).status, 'unknown'); assert.equal(LT.clearLocalReturn(p.fs), false);
  EW.destroyEphemeralWallet();
});

test('F2 (page) — a return step is settled as "did not land" only by its own well-formed settlement; anything else leaves it unsettled; nothing is resent', async () => {
  // (the relay's answer is a stand-in; prepared messages here have a last valid block height of 250)
  const fresh = async status => { const p = await page(), d = deps(p, { status: () => ({ status: 'pending' }) }); await LT.prepareLocalReturn(p.fs, d.options);
    const s = await LT.sendLocalReturn(p.fs, d.options); assert.equal(s.status, 'submitted'); assert.equal(s.lastValidBlockHeight, '250');
    const r = await LT.reconcileLocalReturn(p.fs, { ...d.options, post: async (o, path, body) => ({ signature: body.signature, err: null, ...status(body) }) }); return { p, d, r }; };
  // the well-formed settlement: this step's own height, a slot past it → terminal
  let { p, d, r } = await fresh(() => ({ status: 'expired_unlanded', context_slot: 251, last_valid_block_height: '250' }));
  assert.deepEqual([r.status, r.busy, r.chain, r.slot, r.error, r.sent], ['expired', false, 'expired_unlanded', 251, null, true]);
  assert.equal((await LT.reconcileLocalReturn(p.fs, d.options)).status, 'expired'); assert.equal((await LT.sendLocalReturn(p.fs, d.options)).status, 'expired');
  assert.equal(LT.localReturnSpent(p.fs), true); assert.equal(d.count(S), 1);
  setLang('ja');
  try {
    const c = String(hand.renderPop(p.fs, hand.handModel(p.fs)));
    assert.match(c, /local-return-expired/); assert.match(c, /この操作は反映されませんでした。送った取引は有効期限を過ぎ、記録されていません。/); assert.doesNotMatch(c, /data-act="local-return-reconcile"|data-act="local-return-send"/);
  } finally { setLang('ja'); }
  // the boundary and the mismatches: a slot EQUAL to the height, a slot below it, another height (as a number or another value), a missing or malformed slot, nothing at all
  for (const bad of [{ context_slot: 250, last_valid_block_height: '250' }, { context_slot: 249, last_valid_block_height: '250' }, { context_slot: 251, last_valid_block_height: '249' },
    { context_slot: 251, last_valid_block_height: '251' }, { context_slot: 251, last_valid_block_height: 250 }, { context_slot: '251', last_valid_block_height: '250' },
    { context_slot: 251.5, last_valid_block_height: '250' }, { context_slot: -1, last_valid_block_height: '250' }, { last_valid_block_height: '250' }, { context_slot: 251 }, {}]) {
    EW.destroyEphemeralWallet(); ({ p, d, r } = await fresh(() => ({ status: 'expired_unlanded', ...bad })));
    assert.deepEqual([r.status, r.busy, r.error], ['submitted', false, 'BadLocalReturnStatus'], JSON.stringify(bad));
    assert.equal((await LT.prepareLocalReturn(p.fs, d.options)).status, 'submitted', 'still unsettled: nothing new is prepared');
  }
  // a pending answer far past the height settles nothing; timeouts, refusals and malformed answers leave it unsettled
  EW.destroyEphemeralWallet(); ({ p, d, r } = await fresh(() => ({ status: 'pending', context_slot: 1_000_000, last_valid_block_height: '250' })));
  assert.deepEqual([r.status, r.chain], ['submitted', 'pending']);
  for (const post of [async () => { throw new Error('timeout'); }, async () => { throw Object.assign(new Error('refused'), { code: 'LocalPlayUnknownSignature', refused: true }); }, async () => ({}), async () => null]) {
    const x = await LT.reconcileLocalReturn(p.fs, { ...d.options, post }); assert.equal(x.status, 'submitted'); assert.equal(x.busy, false);
  }
  assert.equal(d.count(S), 1);
  EW.destroyEphemeralWallet();
});

test('the prepared answer is this request\'s whole validated report with this wallet as its one signer, or nothing is offered for signing', async () => {
  const other = encode(new Uint8Array(32).fill(9));
  for (const [prepare, code] of [
    [r => blocked(r, 'SourceBlocked'), 'SourceBlocked'],
    [r => ({ ...blocked(r, 'SourceBlocked'), submit: honest(r).submit }), 'BadLocalReturnPrepared'],
    [r => ({ report: honest(r).report }), 'BadLocalReturnPrepared'],
    [r => ({ ...honest(r), extra: 1 }), 'BadLocalReturnPrepared'],
    [r => ({ ...honest(r), submit: null }), 'BadLocalReturnPrepared'],
    [r => honest(r, { submit: s => ({ ...s, route: 'POST /f/local-play/depart/submit' }) }), 'LocalReturnSubmitMismatch'],
    [r => honest(r, { submit: s => ({ ...s, schema: 'frontier-local-play-depart-submit-v1' }) }), 'LocalReturnSubmitMismatch'],
    [r => honest(r, { submit: s => ({ ...s, message_digest: '00'.repeat(32) }) }), 'LocalReturnSubmitMismatch'],
    [r => honest(r, { submit: s => ({ ...s, signer: other }) }), 'LocalReturnSubmitMismatch'],
    [r => honest(r, { submit: s => ({ ...s, last_valid_block_height: '251' }) }), 'LocalReturnSubmitMismatch'],
    [r => honest(r, { submit: s => ({ ...s, automatic: true }) }), 'LocalReturnSubmitMismatch'],
    [r => honest(r, { report: v => ({ ...v, signed: true }) }), 'BadPreparationReport'],
    [r => honest(r, { report: v => ({ ...v, request: { ...v.request, request_id: 'other' } }) }), 'PreparationRequestMismatch'],
    [r => honest(r, { report: v => ({ ...v, prepared: { ...v.prepared, message_digest: '00'.repeat(32) } }) }), 'PreparationMessageDigest'],
    [r => honest(r, { report: v => ({ ...v, prepared: { ...v.prepared, fee_payer: other } }) }), 'PreparationScopeMismatch'],
    [r => honest(r, { report: v => ({ ...v, prepared: { ...v.prepared, action: v.prepared.action === 'Return' ? 'Dissolve' : 'Return' } }) }), 'PreparationScopeMismatch'],
    [() => { throw Object.assign(new Error('refused'), { code: 'LocalPlayScopeMismatch', refused: true }); }, 'LocalPlayScopeMismatch'],
    [() => 'x', 'BadLocalReturnPrepared'],
  ]) {
    const p = await page('return'), d = deps(p, { prepare });
    const s = await LT.prepareLocalReturn(p.fs, d.options);
    assert.deepEqual([s.status, s.error, s.sent], ['error', code, false], code);
    assert.equal((await LT.sendLocalReturn(p.fs, d.options)).status, 'error'); assert.equal(d.count(S), 0, code);
  }
});

test('the gate, the identity and the card\'s observation are asked again at every step: a page that is another one ends the run unsent', async () => {
  const yes = () => ({ ok: true, relay: RELAY }), other = encode(new Uint8Array(32).fill(77));
  // the real gate: not local play, another cluster, a destroyed wallet
  { const p = await page('return'), d = deps(p);
    const identity = p.fs.localPlay; p.fs.localPlay = null;
    assert.deepEqual([(await LT.prepareLocalReturn(p.fs, d.options)).error], ['LocalDepartNotLocalPlay']); p.fs.localPlay = identity;
    p.signer.destroy(); assert.equal((await LT.prepareLocalReturn(p.fs, d.options)).status, 'error'); assert.equal(d.log.posts.length, 0); }
  // a page of another deployment prepares nothing, whatever its gate says
  for (const change of [fs => { fs.season = { ...fs.season, rulesetHash: null }; }, fs => { fs.localPlay = { ...fs.localPlay, address: other }; }, fs => { fs.localPlay = { ...fs.localPlay, programId: other }; },
    fs => { fs.hand = { ...fs.hand, pop: null }; }, fs => { fs.expeditionPreview.report = null; }]) {
    const p = await page('return'), d = deps(p, { allowed: yes }); change(p.fs);
    assert.equal((await LT.prepareLocalReturn(p.fs, d.options)).status, 'error'); assert.equal(d.log.posts.length, 0);
  }
  // while the relay prepares
  for (const change of [p => { p.fs.localPlay = { ...p.fs.localPlay, seasonAddress: other }; }, p => { p.fs.expeditionPreview.report = { ...p.fs.expeditionPreview.report }; }, p => { p.fs.wallet = { address: p.WALLET }; },
    p => { p.fs.hand = { ...p.fs.hand, pop: null }; }, p => { p.ctx.source = {}; }, p => { p.fs.session = {}; }]) {
    const p = await page('dissolve'), d = deps(p, { allowed: yes, onPost: path => { if (path === P) change(p); } });
    const s = await LT.prepareLocalReturn(p.fs, d.options);
    assert.deepEqual([s.status, s.error], ['error', 'LocalReturnChanged']); assert.equal((await LT.sendLocalReturn(p.fs, d.options)).status, 'error'); assert.equal(d.count(S), 0);
  }
  // between the two presses, and at every gate of the send (before signing, after connect, after the signature, in the turn of the POST)
  for (let n = 1; n <= 5; n++) {
    const p = await page('return'), d = deps(p, { allowed: yes });
    assert.equal((await LT.prepareLocalReturn(p.fs, d.options)).status, 'prepared');
    let calls = 0;
    const s = await LT.sendLocalReturn(p.fs, { ...d.options, allowed: () => { if (++calls === n) p.fs.localPlay = { ...p.fs.localPlay, programId: other }; return yes(); } });
    assert.deepEqual([s.status, s.error, s.sent], ['error', 'LocalReturnChanged', false], `gate ${n}`); assert.equal(d.count(S), 0, `gate ${n}`); assert.ok(calls >= n, `gate ${n} was reached`);
    assert.equal(LT.localReturnSpent(p.fs), false);
  }
  // the card read again between the presses (a new observation): what was prepared is no longer this card's
  { const p = await page('return'), d = deps(p);
    assert.equal((await LT.prepareLocalReturn(p.fs, d.options)).status, 'prepared');
    await observe(p, 'return');
    const s = await LT.sendLocalReturn(p.fs, d.options); assert.deepEqual([s.status, s.error], ['error', 'LocalReturnChanged']); assert.equal(d.count(S), 0); }
  // a signer that is not the one captured
  { const p = await page('return'), d = deps(p, { allowed: yes });
    assert.equal((await LT.prepareLocalReturn(p.fs, d.options)).status, 'prepared');
    const fake = { address: p.WALLET, destroyed: false, wallet: p.signer.wallet };
    const s = await LT.sendLocalReturn(p.fs, { ...d.options, signer: () => fake }); assert.deepEqual([s.status, s.error], ['error', 'LocalReturnChanged']); assert.equal(d.count(S), 0); }
});

test('the return card: the local-play block only in local play, the step the observation names, two separate presses, every outcome in its own words', async () => {
  const p = await page('dissolve'), card = () => String(hand.renderPop(p.fs, hand.handModel(p.fs)));
  const PREP = /data-act="local-return-prepare"/, SEND = /data-act="local-return-send"/, ASK = /data-act="local-return-reconcile"/;
  setLang('ja');
  try {
    // the ordinary page: no such block; the general unsigned review is there instead, as before
    const identity = p.fs.localPlay; p.fs.localPlay = null;
    let c = card(); assert.doesNotMatch(c, /local-return/); assert.match(c, /data-act="expedition-prepare"/);
    p.fs.localPlay = identity;
    // local play: the step the observation names; no send button before a prepare; the general review (a route this relay does not serve) is not offered
    c = card(); assert.match(c, PREP); assert.match(c, /「広域で解散を指示」を準備する/); assert.doesNotMatch(c, SEND); assert.doesNotMatch(c, /data-act="expedition-prepare"/);
    // prepared: what would be signed, and the explicit send
    let d = deps(p, { status: () => ({ status: 'pending' }) });
    let s = await LT.prepareLocalReturn(p.fs, d.options);
    c = card(); assert.match(c, SEND); assert.match(c, /署名する内容を確かめました：広域で解散を指示/); assert.ok(c.includes(`${s.digest.slice(0, 12)}…`)); assert.match(c, /手数料も支払います/); assert.doesNotMatch(c, /記録されました/);
    // submitted, not confirmed: the look-up only, no word of success
    s = await LT.sendLocalReturn(p.fs, d.options); assert.equal(s.status, 'submitted');
    c = card(); assert.match(c, ASK); assert.doesNotMatch(c, SEND); assert.doesNotMatch(c, PREP); assert.match(c, /まだ確認できていません/); assert.doesNotMatch(c, /記録されました/);
    assert.ok(c.includes(`${s.signature.slice(0, 8)}…`));
    // confirmed Dissolve: recorded; the turn still has to be processed; the return is not finished; this reading is used up
    s = await LT.reconcileLocalReturn(p.fs, { ...d.options, post: deps(p).options.post }); assert.equal(s.status, 'confirmed');
    c = card(); assert.match(c, /解散の指示が記録されました/); assert.match(c, /帰還はまだ終わっていません/); assert.match(c, /data-act="local-return-prepare" aria-disabled="true"/); assert.match(c, /すでに手順を送りました/);
    assert.doesNotMatch(c, /帰還しました|帰還が完了|予備兵に戻りました/);
    // the turn is being processed: the observation names no step; nothing to press but the lines stay
    await observe(p, 'resolving'); c = card(); assert.match(c, /data-act="local-return-prepare" aria-disabled="true"/); assert.doesNotMatch(c, SEND);
    LT.clearLocalReturn(p.fs); c = card(); assert.doesNotMatch(c, /local-return/, 'no step named, nothing shown');
    // processed: the second step is the one named
    await observe(p, 'return'); c = card(); assert.match(c, /「元の村の予備兵に戻す」を準備する/); assert.doesNotMatch(c, /data-act="local-return-prepare" aria-disabled/);
    // unknown: said as unknown, the look-up only
    d = deps(p, { submit: () => { throw new Error('reset'); } });
    await LT.prepareLocalReturn(p.fs, d.options); c = card(); assert.match(c, /予備兵に戻す人数の候補: 600人/);
    s = await LT.sendLocalReturn(p.fs, d.options); assert.equal(s.status, 'unknown');
    c = card(); assert.match(c, /記録されたかどうかは不明です/); assert.match(c, /もう一度送らずに/); assert.match(c, ASK); assert.doesNotMatch(c, SEND); assert.doesNotMatch(c, /記録されました/);
    // failed: the chain's own error; nothing changed
    s = await LT.reconcileLocalReturn(p.fs, { ...d.options, post: deps(p, { status: () => ({ status: 'failed', err: { InstructionError: [3, { Custom: 58 }] }, slot: 4 }) }).options.post }); assert.equal(s.status, 'failed');
    c = card(); assert.match(c, /失敗しました/); assert.match(c, /Custom/); assert.match(c, /何も変わっていません/);
    // confirmed Return: recorded; the reserve is for the next reading to show, not claimed here
    await observe(p, 'return'); LT.clearLocalReturn(p.fs);
    d = deps(p); await LT.prepareLocalReturn(p.fs, d.options); s = await LT.sendLocalReturn(p.fs, d.options); assert.equal(s.status, 'confirmed');
    c = card(); assert.match(c, /予備兵に戻す取引が記録されました/); assert.match(c, /もう一度読み取って/); assert.doesNotMatch(c, /帰還しました|帰還が完了|予備兵に戻りました/);
    // an error before anything was sent says so
    await observe(p, 'return'); LT.clearLocalReturn(p.fs);
    d = deps(p, { prepare: r => blocked(r, 'SourceBlocked') }); await LT.prepareLocalReturn(p.fs, d.options);
    c = card(); assert.match(c, /この手順を進められませんでした（SourceBlocked）/); assert.match(c, /何も送っていません/);
    // English: every string of the block has its translation
    setLang('en'); c = card();
    assert.match(c, /This step could not go ahead \(SourceBlocked\)\. Nothing was sent\./); assert.match(c, /Prepare &quot;Return troops to the original village reserves&quot; \(local play\)|Prepare "Return troops to the original village reserves" \(local play\)/);
    assert.deepEqual(missingKeys().filter(k => /ローカルプレイ|手順|準備し直す|署名して送る|署名する内容|予備兵に戻す取引|解散の指示が記録/.test(k)), []);
  } finally { setLang('ja'); EW.destroyEphemeralWallet(); }
});

test('the wiring: three actions to the controller\'s return entry points under the departure\'s gate; the post is one bounded loopback POST; nothing is stored', async () => {
  const read = file => readFileSync(new URL(`../../permutation-server/web/frontier/${file}`, import.meta.url), 'utf8');
  const app = read('app.mjs'), ctl = read('controller.mjs'), mod = read('flocalplay-return.mjs');
  for (const [act, fn] of [['local-return-prepare', 'prepareLocalPlayReturn'], ['local-return-send', 'sendLocalPlayReturn'], ['local-return-reconcile', 'reconcileLocalPlayReturn']]) assert.ok(app.includes(`'${act}': () => ${fn}(),`), act);
  assert.match(app, /import \{[^}]*\bprepareLocalPlayReturn, sendLocalPlayReturn, reconcileLocalPlayReturn\b[^}]*\} from '\.\/controller\.mjs';/);
  assert.ok(app.includes("!LOCAL_RETURN_ACTS.includes(el.dataset.act) && !['expedition-inspect', 'expedition-prepare'].includes(el.dataset.act)) clearInspection(FS);"), 'pressing them keeps the card\'s observation');
  assert.ok(ctl.includes("const localReturnDeps = () => ({ allowed: localDepartGate, context: expeditionContext, signer: currentEphemeralWallet, changed: () => invalidate('panel') });"));
  const from = ctl.indexOf('const localReturnDeps'), block = ctl.slice(from, ctl.indexOf('export const clearLocalPlayReturn', from));
  for (const banned of ['fsession', 'FS.session', 'submit(', 'sendMarch', 'act(', 'faucet', 'storage']) assert.ok(!block.includes(banned), banned);
  // (2026-11-12: of the three general refusals, two are unconditional as they were; the one in `act` now lets through
  //  exactly the six economy commands in their plain form, to their own page-signed path — and nothing of this return)
  assert.equal([...ctl.matchAll(/if \(localPlay\) return (failed|early)\(localPlayReadOnly\(\)\)/g)].length, 1, 'the one unconditional refusal of local play is as it was'); assert.equal(ctl.split('if (localPlay && FS.localMarch?.open !== true) return failed(localPlayReadOnly());').length - 1, 1, '(2026-11-13, march lane) the march\'s refusal: unless its own answer is open');
  assert.equal(ctl.split("const route = localAct.localOrderRoute({ localPlay, name, v, signer, requester });\n  if (route === 'refuse') return early(localPlayReadOnly());").length - 1, 1, 'the order path refuses everything but the six economy commands (behaviour: web-frontier-local-play-act.test.mjs)');
  for (const banned of ['localStorage', 'sessionStorage', 'indexedDB', 'console.', 'setInterval', 'document.cookie']) assert.ok(!mod.includes(banned), banned);
  // the post
  const calls = [];
  const fetch = async (url, init) => { calls.push({ url, init }); return { ok: true, text: async () => '{"ok":1}' }; };
  assert.deepEqual(await LT.postLocalReturn(RELAY, P, { a: 1 }, { fetch }), { ok: 1 });
  assert.equal(calls[0].url, RELAY + P); assert.equal(calls[0].init.method, 'POST'); assert.equal(calls[0].init.credentials, 'omit'); assert.equal(calls[0].init.redirect, 'error');
  await assert.rejects(LT.postLocalReturn('https://relay.example', P, {}, { fetch }), { code: 'LocalReturnRelay' });
  await assert.rejects(LT.postLocalReturn(RELAY, '/gw/f/expedition/prepare', {}, { fetch }), { code: 'LocalReturnRelay' });
  await assert.rejects(LT.postLocalReturn(RELAY, '/gw/f/local-play/depart/submit', {}, { fetch }), { code: 'LocalReturnRelay' });
  await assert.rejects(LT.postLocalReturn(RELAY, S, {}, { fetch: async () => ({ ok: false, text: async () => '{"code":"LocalPlayMessageUsed"}' }) }), { code: 'LocalPlayMessageUsed', refused: true });
  assert.equal(calls.length, 1);
});
