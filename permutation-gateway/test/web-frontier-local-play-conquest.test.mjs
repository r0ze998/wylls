// Local play: the siege of the Free City in the province an original host stays in (flocalplay-conquest.mjs), from the
// expedition card's own observation. A KEY-USING test (scripts/ci/node-key-tests.txt): the memory-only wallet's
// non-extractable key is made by WebCrypto in this process and signs the prepared message. No chain, no network.
//
// EVERYTHING HERE IS A STAND-IN. The observation is the repository's synthetic one; the prepared report is built by
// this test; the world capability (`WORLD`) and the page conditions (`TEST_CONDITIONS`) are test-only values passed
// explicitly. They say nothing about the real program, the real world (which has no Free City) or the heap frame
// (unconfirmed). The first test pins that without them the page prepares nothing.
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
import * as LC from '../../permutation-server/web/frontier/flocalplay-conquest.mjs';
import * as EW from '../../permutation-server/web/frontier/fephemeral-wallet.mjs';
import * as hand from '../../permutation-server/web/frontier/hud/hand.mjs';
import { setLang, missingKeys } from '../../permutation-server/web/lang.mjs';
import { syntheticReturnInspection } from '../screens/codex/return-observation.mjs';
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
/** TEST-ONLY: a stand-in world capability (a Free City at site 3, tile 43 of the province the host stands in) and stand-in page conditions. */
const WORLD = { schema: 'frontier-local-play-conquest-world-v1', program: PROGRAM, season: A.season, world_preset: 'local-conquest-test-v1', free_city: { p: '129', q: '0', site: 3, tile: 43 } };
const TEST_CONDITIONS = { heapConfirmed: true };

/** A page in local play with the expedition card open on an original host observed in wide land at (129, 0). */
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
  const p = { fs, ctx: { pin: PIN, relay: RELAY, source: {} }, signer, WALLET, world: WORLD };
  await observe(p, phase);
  return p;
}
async function observe(p, phase) {
  await inspectExpedition(p.fs, { context: () => p.ctx, read: async r => syntheticReturnInspection(r, { phase }) });
  assert.ok(p.fs.expeditionPreview.report, 'observed');
}
/**
 * A stand-in PUBLIC unsigned report for `request`, in the contract's shape, with the canonical twelve accounts.
 * `roles`, `dispatch`, `data` let a test offer something else in a well-formed message.
 */
function synthetic(request, { roles: reroles = null, dispatch = DECLARE_SIEGE_DISPATCH, data: redata = null } = {}) {
  const s = request.source_request;
  let roles = canonicalDeclareSiegeRoles(s, request.target.site).map(x => ({ ...x }));
  if (reroles) roles = reroles(roles);
  const budget = (op, n, len = 5) => { const d = new Uint8Array(len); d[0] = op; new DataView(d.buffer).setUint32(1, n, true); return { programId: COMPUTE_BUDGET_PROGRAM, keys: [], data: d }; };
  const data = redata ?? declareSiegeInstruction(request.target.site, request.target.entry, dispatch), hash = encode(new Uint8Array(32).fill(77));
  const message = compileMessage({ feePayer: s.wallet, recentBlockhash: hash, instructions: [budget(2, 400000), budget(3, 0, 9), budget(4, 1048576), ...(dispatch.heap === null ? [] : [budget(1, dispatch.heap)]),
    { programId: s.program, keys: roles.map(x => ({ pubkey: x.address, isSigner: x.signer, isWritable: x.writable })), data }] });
  const m = parseMessage(message), h = m.header, n = m.accountKeys.length, slot = (BigInt(request.source_context_slot) + 1n).toString();
  return { schema: LC.LOCAL_CONQUEST_REPORT_SCHEMA, status: 'prepared', request: structuredClone(request),
    source: { request_digest: requestDigest(s), context_slot: slot, digest: 'cd'.repeat(32), coherent: true, authority_verified: false },
    blockhash: { hash, latest_context_slot: slot, validity_context_slot: slot, height_min_context_slot: slot, block_height: '100', last_valid_block_height: '250', remaining_block_heights: '150',
      valid: true, commitment: 'confirmed', coherent: false, authority_verified: false },
    prepared: { program: s.program, season: s.season, program_version: '18436', action: 'DeclareSiege', fee_payer: s.wallet, dispatch: { tag: dispatch.tag, kind: dispatch.kind },
      budget: { cu_limit: 400000, cu_price: '0', loaded_limit: 1048576, heap: dispatch.heap }, roles, instruction_hex: toHex(data), message_b64: toBase64(message), message_digest: toHex(sha256(message)),
      signers: m.signers, shape: { bytes: message.length + 65, locks: n, writes: n - h.numReadonlySignedAccounts - h.numReadonlyUnsignedAccounts, sigs: 1 } },
    blocker: null, host_only: true, ready: false, deployment_verified: false, admitted: false, signed: false, enqueued: false, relay_submission_available: false, automatic_send: false };
}
const honest = (request, over = {}, resubmit = null) => {
  const report = over.report ? over.report(synthetic(request, over)) : synthetic(request, over);
  let submit = { route: 'POST /f/local-play/conquest/submit', schema: 'frontier-local-play-conquest-submit-v1', message_digest: report.prepared?.message_digest ?? null,
    last_valid_block_height: report.blockhash?.last_valid_block_height ?? null, signer: request.source_request.wallet };
  if (resubmit) submit = resubmit(submit);
  return { report, submit };
};
const blocked = (request, code) => ({ report: { ...synthetic(request), status: 'blocked', blockhash: null, prepared: null, blocker: { code } }, submit: null });
function deps(p, { prepare = request => honest(request), submit = () => 'submitted', status = () => ({ status: 'confirmed', slot: 77 }), allowed = null, onPost = null, conditions = TEST_CONDITIONS, world = () => p.world } = {}) {
  const log = { posts: [], states: [], statuses: 0 };
  const allow = allowed ?? (() => LD.localDepartAllowed({ localPlay: p.fs.localPlay, cluster: 'localnet', hostname: '127.0.0.1', relay: p.ctx.relay, wallet: p.fs.wallet?.address, signer: EW.currentEphemeralWallet() }));
  const post = async (origin, path, body) => {
    log.posts.push({ origin, path, body: JSON.parse(JSON.stringify(body)) });
    if (onPost) await onPost(path, log.posts.length);
    if (path === LC.LOCAL_CONQUEST_PREPARE_PATH) return prepare(body);
    if (path === LC.LOCAL_CONQUEST_SUBMIT_PATH) {
      const signature = encode(parseTransaction(fromBase64(body.transaction_b64)).signatures[0]);
      const r = await submit(body, signature);
      return typeof r === 'string' ? { status: r, signature, status_route: 'POST /f/local-play/conquest/status' } : r;
    }
    const r = await status(body.signature, ++log.statuses);
    return r && typeof r.status === 'string' && !('signature' in r) ? { signature: body.signature, err: null, slot: null, ...r } : r;
  };
  const o = { allowed: allow, context: () => p.ctx, signer: () => EW.currentEphemeralWallet(), world, post, changed: () => { log.states.push(LC.localConquestOf(p.fs).status); }, ...(conditions ? { conditions } : {}) };
  return { log, options: o, count: path => log.posts.filter(x => x.path === path).length };
}
const P = LC.LOCAL_CONQUEST_PREPARE_PATH, S = LC.LOCAL_CONQUEST_SUBMIT_PATH, T = LC.LOCAL_CONQUEST_STATUS_PATH;

test('CLOSED by default: the page\'s own conditions are not established and no world capability exists, so nothing is prepared, posted or signed', async () => {
  assert.deepEqual(LC.LOCAL_CONQUEST_PAGE_CONDITIONS, { heapConfirmed: false }, 'the heap frame is not claimed as confirmed');
  assert.deepEqual(DECLARE_SIEGE_DISPATCH, { tag: 0xda, kind: 12, heap: 256 * 1024 });
  // the module's own conditions (what the controller uses): closed, whatever world is offered
  { const p = await page(), d = deps(p, { conditions: null });
    const s = await LC.prepareLocalConquest(p.fs, d.options);
    assert.deepEqual([s.status, s.error, s.sent], ['error', 'ConquestRouteClosed', false]); assert.equal(d.log.posts.length, 0);
    assert.equal((await LC.sendLocalConquest(p.fs, d.options)).status, 'error'); assert.equal(d.log.posts.length, 0); }
  // conditions that are not all true, or none at all, are closed too
  for (const conditions of [{ heapConfirmed: false }, {}, { heapConfirmed: true, other: false }, { heapConfirmed: 'yes' }]) {
    const p = await page(), d = deps(p, { conditions });
    assert.equal((await LC.prepareLocalConquest(p.fs, d.options)).error, 'ConquestRouteClosed'); assert.equal(d.log.posts.length, 0);
  }
  // with the test conditions but without a world capability of this very world and province: no offer, nothing posted
  const other = encode(new Uint8Array(32).fill(9));
  for (const [world, code] of [[null, 'ConquestWorldUnavailable'], [undefined, 'ConquestWorldUnavailable'], [{}, 'ConquestWorldUnavailable'], [{ ...WORLD, world_preset: 'expedition' }, 'ConquestWorldUnavailable'],
    [{ ...WORLD, schema: 'x' }, 'ConquestWorldUnavailable'], [{ ...WORLD, verified: true }, 'ConquestWorldUnavailable'], [{ ...WORLD, free_city: { p: '129', q: '0', site: 12, tile: 43 } }, 'ConquestWorldUnavailable'],
    [{ ...WORLD, free_city: { p: 129, q: 0, site: 3, tile: 43 } }, 'ConquestWorldUnavailable'], [{ ...WORLD, program: other }, 'ConquestWorldMismatch'], [{ ...WORLD, season: other }, 'ConquestWorldMismatch'],
    [{ ...WORLD, free_city: { p: '130', q: '0', site: 3, tile: 43 } }, 'ConquestNoFreeCityHere'], [{ ...WORLD, free_city: { p: '129', q: '1', site: 3, tile: 43 } }, 'ConquestNoFreeCityHere']]) {
    const p = await page(), d = deps(p, { world: () => world });
    const s = await LC.prepareLocalConquest(p.fs, d.options);
    assert.deepEqual([s.status, s.error], ['error', code], JSON.stringify(world)); assert.equal(d.log.posts.length, 0);
  }
  // a host that is not simply staying (a Leave processed, or still being processed) is offered no siege
  for (const phase of ['return', 'resolving']) {
    const p = await page(phase), d = deps(p);
    assert.equal((await LC.prepareLocalConquest(p.fs, d.options)).error, 'ConquestHostNotStaying'); assert.equal(d.log.posts.length, 0);
    assert.deepEqual(LC.localConquestOffer(p.fs, p.ctx, WORLD), { ok: false, code: 'ConquestHostNotStaying' });
  }
});

test('under explicit stand-in conditions and world: the offer, the closed request, the page\'s own check, the explicit send signs that very message once, the status confirms the declaration and no more', async () => {
  const p = await page(), d = deps(p);
  assert.deepEqual(LC.localConquestOffer(p.fs, p.ctx, WORLD), { ok: true, site: 3, entry: 0, tile: 43, standing: { p: '129', q: '0' } });
  assert.equal((await LC.sendLocalConquest(p.fs, d.options)).status, 'idle', 'nothing is sent without a prepared siege'); assert.equal(d.log.posts.length, 0);
  const ready = await LC.prepareLocalConquest(p.fs, { ...d.options, requestId: 'cq_1' });
  assert.deepEqual([ready.status, ready.site, ready.entry, ready.busy, ready.sent, ready.signature], ['prepared', 3, 0, false, false, null]); assert.deepEqual(ready.standing, { p: '129', q: '0' });
  assert.equal(d.count(P), 1); assert.equal(d.count(S), 0, 'preparing signs and sends nothing');
  // the request: the card's own observed request, the observation it was read at, the site of the world and the entry of the observation
  const prep = d.log.posts[0].body, state = p.fs.expeditionPreview;
  assert.deepEqual(Object.keys(prep), ['schema', 'request_id', 'action', 'source_request', 'source_context_slot', 'source_snapshot_digest', 'target']);
  assert.equal(prep.schema, 'frontier-local-play-conquest-prepare-request-v1'); assert.equal(prep.action, 'DeclareSiege'); assert.deepEqual(prep.target, { site: 3, entry: 0 });
  assert.deepEqual(prep.source_request, JSON.parse(JSON.stringify(state.request))); assert.equal(prep.source_request.wallet, p.WALLET); assert.equal(prep.source_request.payer, p.WALLET);
  assert.equal(prep.source_context_slot, state.report.source.context_slot); assert.equal(prep.source_snapshot_digest, state.report.source.digest);
  assert.equal(ready.digest, honest(prep).report.prepared.message_digest); assert.equal(ready.lastValidBlockHeight, '250');
  // the explicit send
  const done = await LC.sendLocalConquest(p.fs, d.options);
  assert.deepEqual([done.status, done.chain, done.slot, done.sent, done.busy], ['confirmed', 'confirmed', 77, true, false]);
  assert.deepEqual(d.log.posts.map(x => [x.origin, x.path]), [[RELAY, P], [RELAY, S], [RELAY, T]]);
  const sub = d.log.posts[1].body;
  assert.deepEqual(Object.keys(sub), ['schema', 'message_digest', 'transaction_b64']); assert.equal(sub.schema, 'frontier-local-play-conquest-submit-v1'); assert.equal(sub.message_digest, ready.digest);
  assert.deepEqual(d.log.posts[2].body, { schema: 'frontier-local-play-conquest-status-v1', signature: done.signature });
  const tx = parseTransaction(fromBase64(sub.transaction_b64)), message = fromBase64(honest(prep).report.prepared.message_b64);
  assert.deepEqual([...tx.message], [...message]); assert.deepEqual(tx.signers, [p.WALLET]); assert.equal(encode(tx.signatures[0]), done.signature);
  const game = parseMessage(message).instructions.at(-1);
  assert.equal(toHex(game.data), 'daff020c' + 'daff0105' + '0300', 'kind 12 under tag 0xDA, then the ABI\'s own DeclareSiege of site 3, entry 0');
  assert.deepEqual(game.keys.map(k => k.pubkey), canonicalDeclareSiegeRoles(prep.source_request, 3).map(r => r.address));
  const key = await crypto.subtle.importKey('raw', fromB58(p.WALLET), 'Ed25519', false, ['verify']);
  assert.equal(await crypto.subtle.verify('Ed25519', key, tx.signatures[0], tx.message), true);
  assert.deepEqual([...new Set(d.log.states)], ['preparing', 'prepared', 'signing', 'submitting', 'submitted', 'confirmed']);
  // the state claims no result: no capture, no ownership, no Holding, no slot
  assert.deepEqual(Object.keys(done).sort(), ['busy', 'chain', 'code', 'digest', 'entry', 'error', 'host', 'lastValidBlockHeight', 'requestId', 'sent', 'signature', 'site', 'slot', 'standing', 'status']);
  // the observation this siege was sent on is used up until the card reads again
  assert.equal(LC.localConquestSpent(p.fs), true); assert.equal(LC.clearLocalConquest(p.fs), true); assert.equal(LC.localConquestSpent(p.fs), true);
  const again = await LC.prepareLocalConquest(p.fs, d.options); assert.deepEqual([again.status, again.error], ['error', 'ConquestObservationSpent']); assert.equal(d.count(P), 1);
  await observe(p, 'dissolve'); assert.equal(LC.localConquestSpent(p.fs), false);
});

test('the page checks the prepared message itself: a report cannot move the signature to another site, province, village, table or escrow, nor to another command', async () => {
  const cases = [
    // well-formed DeclareSiege messages of SOMETHING ELSE, offered for this request
    [r => honest(r, { roles: () => canonicalDeclareSiegeRoles(r.source_request, 4).map(x => ({ ...x })) }), 'ConquestRolesMismatch'],
    [r => honest(r, { roles: () => canonicalDeclareSiegeRoles({ ...r.source_request, standing: { p: '130', q: '0' } }, 3).map(x => ({ ...x })) }), 'ConquestRolesMismatch'],
    [r => honest(r, { roles: roles => roles.map((x, i) => (i === 9 ? { ...x, address: canonicalDeclareSiegeRoles({ ...r.source_request, standing: { p: '130', q: '0' } }, 3)[9].address } : x)) }), 'ConquestRolesMismatch'],
    [r => honest(r, { roles: roles => roles.map((x, i) => (i === 10 ? { ...x, address: encode(new Uint8Array(32).fill(60)) } : x)) }), 'ConquestRolesMismatch'],
    [r => honest(r, { roles: roles => roles.map((x, i) => (i === 4 ? { ...x, address: encode(new Uint8Array(32).fill(61)) } : x)) }), 'ConquestRolesMismatch'],
    [r => honest(r, { roles: roles => roles.map((x, i) => (i === 6 ? { ...x, writable: true } : x)) }), 'ConquestRolesMismatch'],
    [r => honest(r, { roles: roles => [...roles, { name: 'extra', address: encode(new Uint8Array(32).fill(62)), signer: false, writable: true }] }), 'ConquestRolesMismatch'],
    // the right accounts with another command: another site or entry in the bytes, another kind, an existing kind, no heap frame
    [r => honest(r, { data: declareSiegeInstruction(4, 0) }), 'ConquestInstructionMismatch'],
    [r => honest(r, { data: declareSiegeInstruction(3, 1) }), 'ConquestInstructionMismatch'],
    [r => honest(r, { dispatch: { tag: 0xda, kind: 13, heap: 256 * 1024 } }), 'ConquestScopeMismatch'],
    [r => honest(r, { dispatch: { tag: 0xda, kind: 4, heap: 256 * 1024 } }), 'ConquestScopeMismatch'],
    [r => honest(r, { dispatch: { tag: 0xdc, kind: 12, heap: 256 * 1024 } }), 'ConquestScopeMismatch'],
    [r => honest(r, { dispatch: { tag: 0xda, kind: 12, heap: null } }), 'ConquestBudgetMismatch'],
    // claims and bytes
    [r => honest(r, { report: v => ({ ...v, signed: true }) }), 'BadConquestReport'],
    [r => honest(r, { report: v => ({ ...v, automatic_send: true }) }), 'BadConquestReport'],
    [r => honest(r, { report: v => ({ ...v, request: { ...v.request, request_id: 'other' } }) }), 'ConquestRequestMismatch'],
    [r => honest(r, { report: v => ({ ...v, request: { ...v.request, target: { site: 4, entry: 0 } } }) }), 'ConquestRequestMismatch'],
    [r => honest(r, { report: v => ({ ...v, prepared: { ...v.prepared, message_digest: '00'.repeat(32) } }) }), 'ConquestMessageDigest'],
    [r => honest(r, { report: v => ({ ...v, prepared: { ...v.prepared, fee_payer: encode(new Uint8Array(32).fill(9)) } }) }), 'ConquestScopeMismatch'],
    [r => honest(r, { report: v => ({ ...v, prepared: { ...v.prepared, action: 'SettleCapture' } }) }), 'ConquestScopeMismatch'],
    [r => honest(r, { report: v => ({ ...v, source: { ...v.source, context_slot: '1' } }) }), 'ConquestSourceStale'],
    [r => honest(r, { report: v => ({ ...v, blockhash: { ...v.blockhash, remaining_block_heights: '1', last_valid_block_height: '101' } }) }), 'ConquestBlockhashExpired'],
    // the submit note
    [r => honest(r, {}, s => ({ ...s, route: 'POST /f/local-play/depart/submit' })), 'LocalConquestSubmitMismatch'],
    [r => honest(r, {}, s => ({ ...s, schema: 'frontier-local-play-resident-submit-v1' })), 'LocalConquestSubmitMismatch'],
    [r => honest(r, {}, s => ({ ...s, signer: encode(new Uint8Array(32).fill(9)) })), 'LocalConquestSubmitMismatch'],
    [r => ({ ...honest(r), submit: null }), 'BadLocalConquestPrepared'],
    [r => ({ ...blocked(r, 'TargetNotFreeCity'), submit: honest(r).submit }), 'BadLocalConquestPrepared'],
    // a blocked report: its own closed blocker, nothing to sign; an unknown blocker word is no report
    [r => blocked(r, 'TargetNotFreeCity'), 'TargetNotFreeCity'], [r => blocked(r, 'HostNotOnTarget'), 'HostNotOnTarget'], [r => blocked(r, 'DispatchKindUnavailable'), 'DispatchKindUnavailable'],
    [r => blocked(r, 'AnythingElse'), 'BadConquestReport'],
    [() => { throw Object.assign(new Error('refused'), { code: 'NotFound', refused: true }); }, 'NotFound'],
  ];
  for (const [prepare, code] of cases) {
    const p = await page(), d = deps(p, { prepare });
    const s = await LC.prepareLocalConquest(p.fs, d.options);
    assert.deepEqual([s.status, s.error, s.sent], ['error', code, false], code);
    assert.equal((await LC.sendLocalConquest(p.fs, d.options)).status, 'error'); assert.equal(d.count(S), 0, code);
  }
});

test('the gate, the identity, the observation and the world are asked again at every step; an unknown outcome is asked about and never sent again', async () => {
  const yes = () => ({ ok: true, relay: RELAY }), other = encode(new Uint8Array(32).fill(77));
  // while the relay prepares
  for (const change of [p => { p.fs.localPlay = { ...p.fs.localPlay, seasonAddress: other }; }, p => { p.fs.expeditionPreview.report = { ...p.fs.expeditionPreview.report }; }, p => { p.fs.hand = { ...p.fs.hand, pop: null }; },
    p => { p.world = { ...WORLD, free_city: { ...WORLD.free_city, site: 4 } }; }, p => { p.world = null; }]) {
    const p = await page(), d = deps(p, { allowed: yes, onPost: path => { if (path === P) change(p); } });
    const s = await LC.prepareLocalConquest(p.fs, d.options);
    assert.deepEqual([s.status, s.error], ['error', 'LocalConquestChanged']); assert.equal((await LC.sendLocalConquest(p.fs, d.options)).status, 'error'); assert.equal(d.count(S), 0);
  }
  // at every gate of the send (before signing, after connect, after the signature, in the turn of the POST): identity, then the world
  for (const change of [p => { p.fs.localPlay = { ...p.fs.localPlay, programId: other }; }, p => { p.world = { ...WORLD, free_city: { ...WORLD.free_city, site: 5 } }; }]) for (let n = 1; n <= 5; n++) {
    const p = await page(), d = deps(p, { allowed: yes });
    assert.equal((await LC.prepareLocalConquest(p.fs, d.options)).status, 'prepared');
    let calls = 0;
    const s = await LC.sendLocalConquest(p.fs, { ...d.options, allowed: () => { if (++calls === n) change(p); return yes(); } });
    assert.deepEqual([s.status, s.error, s.sent], ['error', 'LocalConquestChanged', false], `gate ${n}`); assert.equal(d.count(S), 0, `gate ${n}`); assert.ok(calls >= n);
    assert.equal(LC.localConquestSpent(p.fs), false, 'a siege that sent nothing uses nothing up');
  }
  // the card read again between the presses: what was prepared is no longer this card's; a prepared message is offered once
  { const p = await page(), d = deps(p);
    assert.equal((await LC.prepareLocalConquest(p.fs, d.options)).status, 'prepared');
    await observe(p, 'dissolve');
    const s = await LC.sendLocalConquest(p.fs, d.options); assert.deepEqual([s.status, s.error], ['error', 'LocalConquestChanged']); assert.equal(d.count(S), 0);
    assert.equal((await LC.sendLocalConquest(p.fs, d.options)).status, 'error', 'no send without a new prepare'); assert.equal(d.count(S), 0); }
  // a double press starts one run
  { const p = await page(), d = deps(p, { status: () => ({ status: 'pending' }) });
    await Promise.all([LC.prepareLocalConquest(p.fs, d.options), LC.prepareLocalConquest(p.fs, d.options)]); assert.equal(d.count(P), 1);
    await Promise.all([LC.sendLocalConquest(p.fs, d.options), LC.sendLocalConquest(p.fs, d.options)]); assert.equal(d.count(S), 1);
    assert.equal((await LC.prepareLocalConquest(p.fs, d.options)).status, 'submitted'); assert.equal(LC.clearLocalConquest(p.fs), false); assert.equal(d.count(P), 1); }
  // unknown: not a success; asked about by its first signature only
  const p = await page(), d = deps(p, { submit: () => { throw Object.assign(new Error('socket'), { code: 'LocalPlayRpcUnavailable' }); } });
  await LC.prepareLocalConquest(p.fs, d.options);
  const s = await LC.sendLocalConquest(p.fs, d.options);
  assert.deepEqual([s.status, s.sent, s.busy, s.error], ['unknown', true, false, 'LocalPlayRpcUnavailable']); assert.equal(d.count(S), 1); assert.equal(d.count(T), 0);
  assert.equal((await LC.prepareLocalConquest(p.fs, d.options)).status, 'unknown'); assert.equal((await LC.sendLocalConquest(p.fs, d.options)).status, 'unknown'); assert.equal(LC.clearLocalConquest(p.fs), false);
  assert.equal(d.count(P), 1); assert.equal(d.count(S), 1);
  const ask = status => LC.reconcileLocalConquest(p.fs, { ...d.options, post: deps(p, { status }).options.post });
  let r = await ask(() => ({ status: 'pending' })); assert.deepEqual([r.status, r.chain], ['unknown', 'pending']);
  r = await ask(() => ({ signature: 'x', status: 'confirmed', err: null, slot: 1 })); assert.deepEqual([r.status, r.error], ['unknown', 'BadLocalConquestStatus']);
  r = await ask(() => { throw Object.assign(new Error('unknown'), { code: 'LocalPlayUnknownSignature', refused: true }); }); assert.deepEqual([r.status, r.error], ['unknown', 'LocalPlayUnknownSignature']);
  const live = p.fs.localPlay; p.fs.localPlay = { ...live, programId: other };
  r = await LC.reconcileLocalConquest(p.fs, { ...d.options, allowed: yes }); assert.deepEqual([r.status, r.error], ['unknown', 'LocalConquestIdentityChanged']);
  p.fs.localPlay = live;
  r = await ask(() => ({ status: 'failed', err: { InstructionError: [4, { Custom: 6001 }] }, slot: 91 })); assert.deepEqual([r.status, r.chain, r.slot], ['failed', 'failed', 91]); assert.match(r.code, /Custom/);
  assert.equal(d.count(S), 1); assert.equal(LC.localConquestSpent(p.fs), true);
});

test('the expedition card: one honest line without a world, the two separate presses with one, and no word of capture or ownership', async () => {
  const p = await page(), card = () => String(hand.renderPop(p.fs, hand.handModel(p.fs)));
  const PREP = /data-act="local-conquest-prepare"/, SEND = /data-act="local-conquest-send"/, ASK = /data-act="local-conquest-reconcile"/;
  const CLAIMS = /占領しました|奪いました|あなたの村になりました|あなたの都市|領土になりました|勝ちました|勝利/;
  setLang('ja');
  try {
    // the ordinary page: nothing of it
    const identity = p.fs.localPlay; p.fs.localPlay = null; assert.doesNotMatch(card(), /local-conquest/); p.fs.localPlay = identity;
    // local play, the host stays, NO world capability (today's world): one line, nothing to press
    let c = card(); assert.match(c, /data-local-conquest="unavailable"/); assert.match(c, /包囲できる自由都市がまだありません/); assert.doesNotMatch(c, PREP); assert.doesNotMatch(c, SEND);
    // a host that is not staying is offered nothing at all
    await observe(p, 'return'); assert.doesNotMatch(card(), /local-conquest/); await observe(p, 'dissolve');
    // with a stand-in world on the identity: the prepare button, and the reminder that staying is not owning
    p.fs.localPlay = { ...identity, conquestWorld: WORLD };
    c = card(); assert.match(c, PREP); assert.doesNotMatch(c, SEND); assert.match(c, /滞在しているだけでは、都市はあなたのものではありません/);
    // the reservation's rules are said BEFORE the first press: no cancellation, the day's count stays used, the deposit and the slot come back, the first that qualifies
    for (const rule of [/予約は取り消せません。/, /今日の宣言回数は1回使われたままです/, /預けた資源と使用枠は戻りますが/, /条件を満たす最初の予約だけが包囲になります/, /条件を満たしていれば包囲として始まります/]) assert.match(c, rule);
    assert.doesNotMatch(c, /包囲を宣言します|data-siege-order/, 'not an immediate declaration; and no order state is read today'); assert.doesNotMatch(c, /data-act="local-conquest-prepare" aria-disabled/);
    // pressed with the module's own conditions (the controller's path): the route is closed, said so, nothing sent
    let d = deps(p, { conditions: null });
    await LC.prepareLocalConquest(p.fs, d.options);
    c = card(); assert.match(c, /包囲の経路はまだ閉じています/); assert.match(c, /ConquestRouteClosed/); assert.match(c, /何も送っていません/); assert.equal(d.log.posts.length, 0);
    // under the stand-in conditions: prepared, what would be signed, the explicit send
    LC.clearLocalConquest(p.fs); d = deps(p, { status: () => ({ status: 'pending' }) });
    let s = await LC.prepareLocalConquest(p.fs, d.options);
    c = card(); assert.match(c, SEND); assert.match(c, /署名する内容を確かめました：自由都市の包囲を予約（州 129, 0・場所 3/); assert.match(c, /送ると取り消せません。包囲が始まらなくても、今日の宣言回数は1回使われます。/); assert.ok(c.includes(`${s.digest.slice(0, 12)}…`)); assert.doesNotMatch(c, /記録されました/);
    s = await LC.sendLocalConquest(p.fs, d.options); assert.equal(s.status, 'submitted');
    c = card(); assert.match(c, ASK); assert.doesNotMatch(c, SEND); assert.doesNotMatch(c, PREP); assert.match(c, /まだ確認できていません/); assert.doesNotMatch(c, /予約が記録されました/); assert.doesNotMatch(c, CLAIMS);
    // confirmed: the TRANSACTION is recorded — whether it became a reservation or an immediate siege is not known without a read; no capture, no ownership
    s = await LC.reconcileLocalConquest(p.fs, { ...d.options, post: deps(p).options.post }); assert.equal(s.status, 'confirmed');
    c = card(); assert.match(c, /取引が記録されました。予約として受け付けられたのか、すでに包囲として始まったのかは、まだ確認できていません。占領もまだ分かりません。受け付けられた予約は取り消せません。/);
    // (the same signed message lands as a reservation OR as an immediate declaration: the recorded fact only — no claim of either, and none that the siege has not started)
    assert.doesNotMatch(c, /予約が記録されました|まだ包囲は始まっていません|包囲は始まっていません|包囲が始まりました|宣言が記録されました|予約しました|予約されました/);
    setLang('en'); c = card();
    assert.match(c, /The transaction is recorded\. Whether it was accepted as a reservation or has already started as a siege is not confirmed yet\. Nothing is known about a capture either\. An accepted reservation cannot be cancelled\./);
    assert.doesNotMatch(c, /reservation is recorded|has not started|siege has started|was reserved|was declared|is declared/i); assert.doesNotMatch(c, /captured the Free City|is yours now/);
    setLang('ja'); c = card(); assert.doesNotMatch(c, CLAIMS);
    assert.match(c, /data-act="local-conquest-prepare" aria-disabled="true"/); assert.match(c, /すでに手順を送りました/);
    // unknown and failed
    await observe(p, 'dissolve'); LC.clearLocalConquest(p.fs);
    d = deps(p, { submit: () => { throw new Error('reset'); } }); await LC.prepareLocalConquest(p.fs, d.options); s = await LC.sendLocalConquest(p.fs, d.options); assert.equal(s.status, 'unknown');
    c = card(); assert.match(c, /この取引が記録されたかどうかは不明です/); assert.doesNotMatch(c, /予約されたかどうか|宣言されたかどうか/); assert.match(c, /もう一度送らずに/); assert.match(c, ASK); assert.doesNotMatch(c, SEND); assert.doesNotMatch(c, CLAIMS);
    s = await LC.reconcileLocalConquest(p.fs, { ...d.options, post: deps(p, { status: () => ({ status: 'failed', err: { InstructionError: [4, { Custom: 58 }] }, slot: 4 }) }).options.post });
    c = card(); assert.match(c, /包囲を予約する取引は失敗しました/); assert.match(c, /Custom/); assert.match(c, /何も変わっていません/);
    // English: every string of the block has its translation
    setLang('en'); c = card(); assert.match(c, /The transaction reserving the siege failed/); assert.match(c, /A reservation cannot be cancelled\./); assert.match(c, /still counts as one of today&#39;s declarations/);
    assert.deepEqual(missingKeys().filter(k => /包囲|自由都市|予約/.test(k)), []);
  } finally { setLang('ja'); EW.destroyEphemeralWallet(); }
});

test('the wiring: three actions to the controller under the departure\'s gate, no condition passed from the page, the world from the identity only; nothing stored', async () => {
  const read = file => readFileSync(new URL(`../../permutation-server/web/frontier/${file}`, import.meta.url), 'utf8');
  const app = read('app.mjs'), ctl = read('controller.mjs'), mod = read('flocalplay-conquest.mjs');
  for (const [act, fn] of [['local-conquest-prepare', 'prepareLocalPlayConquest'], ['local-conquest-send', 'sendLocalPlayConquest'], ['local-conquest-reconcile', 'reconcileLocalPlayConquest']]) assert.ok(app.includes(`'${act}': () => ${fn}(),`), act);
  assert.match(app, /import \{[^}]*\bprepareLocalPlayConquest, sendLocalPlayConquest, reconcileLocalPlayConquest\b[^}]*\} from '\.\/controller\.mjs';/);
  assert.ok(app.includes('!LOCAL_CONQUEST_ACTS.includes(el.dataset.act) && !LOCAL_RETURN_ACTS.includes(el.dataset.act) &&'), 'pressing them keeps the card\'s observation');
  assert.ok(ctl.includes("const localConquestDeps = () => ({ allowed: localDepartGate, context: expeditionContext, signer: currentEphemeralWallet, world: () => localPlay?.conquestWorld ?? null, changed: () => invalidate('panel') });"));
  const from = ctl.indexOf('const localConquestDeps'), block = ctl.slice(from, ctl.indexOf('export const reconcileLocalPlayConquest', from) + 120);
  for (const banned of ['conditions', 'heapConfirmed', 'fsession', 'FS.session', 'submit(', 'sendMarch', 'act(', 'faucet', 'storage']) assert.ok(!block.includes(banned), banned);
  // (2026-11-12: of the three general refusals, two are unconditional as they were; the one in `act` now lets through
  //  exactly the six economy commands in their plain form, to their own page-signed path — and nothing of this siege)
  assert.equal([...ctl.matchAll(/if \(localPlay\) return (failed|early)\(localPlayReadOnly\(\)\)/g)].length, 1, 'the one unconditional refusal of local play is as it was'); assert.equal(ctl.split('if (localPlay && FS.localMarch?.open !== true) return failed(localPlayReadOnly());').length - 1, 1, '(2026-11-13, march lane) the march\'s refusal: unless its own answer is open');
  // (what that one decision does for every command — only the six go on, DeclareSiege is not one of them — is tested
  //  as behaviour in web-frontier-local-play-act.test.mjs; here: that the order path asks it before anything else)
  assert.equal(ctl.split("const route = localAct.localOrderRoute({ localPlay, name, v, signer, requester });\n  if (route === 'refuse') return early(localPlayReadOnly());").length - 1, 1, 'the order path refuses everything but the six economy commands');
  for (const banned of ['localStorage', 'sessionStorage', 'indexedDB', 'console.', 'setInterval', 'document.cookie']) assert.ok(!mod.includes(banned), banned);
  assert.ok(mod.includes('export const LOCAL_CONQUEST_PAGE_CONDITIONS = Object.freeze({ heapConfirmed: false });'));
  // the post: one bounded loopback POST to the three conquest routes only
  const calls = [];
  const fetch = async (url, init) => { calls.push({ url, init }); return { ok: true, text: async () => '{"ok":1}' }; };
  assert.deepEqual(await LC.postLocalConquest(RELAY, P, { a: 1 }, { fetch }), { ok: 1 });
  assert.equal(calls[0].init.credentials, 'omit'); assert.equal(calls[0].init.redirect, 'error');
  await assert.rejects(LC.postLocalConquest('https://relay.example', P, {}, { fetch }), { code: 'LocalConquestRelay' });
  await assert.rejects(LC.postLocalConquest(RELAY, '/gw/f/local-play/resident/submit', {}, { fetch }), { code: 'LocalConquestRelay' });
  await assert.rejects(LC.postLocalConquest(RELAY, S, {}, { fetch: async () => ({ ok: false, text: async () => '{"code":"NotFound"}' }) }), { code: 'NotFound', refused: true });
  assert.equal(calls.length, 1);
});

// ------------------------------------------------------------------ the reservation read (read-only)
// STAND-INS: the relay's answer is written by this test in the contract's shape. It says nothing about a chain.
const O = LC.LOCAL_CONQUEST_ORDERS_PATH;
const orderFacts = (more = {}) => ({ phase: 'ordered', site: 3, standing: { p: '129', q: '0' }, order_bell: '19', decided_bell: null, reason: null, lapsed: null, source: null, stake: 'held', slot: 'held', capture: null, day: null, ...more });
const ordersAnswer = (p, orders = [], over = {}) => ({ siege: null, schema: 'frontier-local-play-conquest-orders-v2', context_slot: '658', program: PROGRAM, season: A.season, wallet: p.WALLET, standing: { p: '129', q: '0' },
  table_address: encode(new Uint8Array(32).fill(44)), table: 'present', orders, ...over });
/** The read's deps: the page's own gate and identity (as `deps`), with a relay stand-in that answers `reply`. */
function readDeps(p, reply, over = {}) {
  const d = deps(p, over), posts = [];
  d.options.post = async (origin, path, body) => { posts.push({ origin, path, body: JSON.parse(JSON.stringify(body)) }); return typeof reply === 'function' ? reply(body, posts.length) : reply; };
  return { options: d.options, posts };
}
const withWorld = p => { p.fs.localPlay = { ...p.fs.localPlay, conquestWorld: WORLD }; return p; };
const cardOf = p => String(hand.renderPop(p.fs, hand.handModel(p.fs)));
const READ = /data-act="local-conquest-orders"/, SHOWN = /data-siege-order="/;

test('the reservation read, CLOSED: pressed under the module\'s own conditions it asks the relay nothing, and the card says why', async () => {
  const p = withWorld(await page());
  setLang('ja');
  try {
    // before any press: the button, nothing read
    let c = cardOf(p); assert.match(c, READ); assert.match(c, /data-siege-read="idle"/); assert.doesNotMatch(c, SHOWN);
    assert.deepEqual(LC.localConquestOrdersOf(p.fs), { status: 'idle', busy: false, error: null, contextSlot: null, table: null, standing: null, orders: [], city: null });
    // the controller's path passes no conditions: the module's own, which are not established
    const d = readDeps(p, () => { throw new Error('must not be asked'); }, { conditions: null });
    const s = await LC.readLocalConquestOrders(p.fs, d.options);
    assert.deepEqual([s.status, s.error, s.busy, s.orders.length], ['error', 'ConquestRouteClosed', false, 0]); assert.equal(d.posts.length, 0);
    // the REAL state reaches the card: the closed reason, its code, and that the state is not known — and the button still stands
    assert.equal(LC.localConquestOrdersOf(p.fs).error, 'ConquestRouteClosed');
    c = cardOf(p); assert.match(c, /data-siege-read="error"/); assert.match(c, /包囲の経路はまだ閉じています/); assert.match(c, /ConquestRouteClosed/); assert.match(c, /予約の状態は分かりません。/);
    assert.match(c, READ); assert.doesNotMatch(c, SHOWN); assert.doesNotMatch(c, /予約はいまありません|始まりました|戻りました|占領しました/);
    // a gate that refuses, and a missing observation, are said the same way (their own code), still with nothing asked
    const refusing = readDeps(p, () => { throw new Error('must not be asked'); }, { allowed: () => ({ ok: false, code: 'LocalDepartRelayMissing' }) });
    assert.deepEqual([(await LC.readLocalConquestOrders(p.fs, refusing.options)).error, refusing.posts.length], ['LocalDepartRelayMissing', 0]);
    assert.match(cardOf(p), /予約の状態を読めませんでした。/);
    // that error belongs to the page as it was at the press: another identity object, and it is no longer shown
    p.fs.localPlay = { ...p.fs.localPlay };
    assert.equal(LC.localConquestOrdersOf(p.fs).status, 'idle'); assert.match(cardOf(p), /data-siege-read="idle"/);
    setLang('en'); assert.match(cardOf(p), /Read the siege reservation state \(local play\)/);
    assert.deepEqual(missingKeys().filter(k => /予約の状態|包囲予約の状態|読み取りのスロット|この州の記録/.test(k)), []);
  } finally { setLang('ja'); EW.destroyEphemeralWallet(); }
});

test('the reservation read, under stand-in conditions: one bounded read; a waiting order and a not-applied one are shown as the record says; no record says nothing', async () => {
  const p = withWorld(await page());
  setLang('ja');
  try {
    // PENDING → "waiting for its turn": not started, not returned, not captured
    let d = readDeps(p, ordersAnswer(p, [{ seq: 0, facts: orderFacts() }]));
    let s = await LC.readLocalConquestOrders(p.fs, d.options);
    assert.deepEqual([s.status, s.error, s.contextSlot, s.table, s.orders.length], ['read', null, '658', 'present', 1]);
    assert.equal(d.posts.length, 1); assert.equal(d.posts[0].path, O); assert.equal(d.posts[0].origin, RELAY);
    assert.deepEqual(d.posts[0].body, { schema: 'frontier-local-play-conquest-orders-request-v1', source_request: JSON.parse(JSON.stringify(p.fs.expeditionPreview.request)) });
    let c = cardOf(p);
    assert.match(c, /data-siege-order="ordered"/); assert.match(c, /ターン 19 の処理を待っています（場所 3）/); assert.match(c, /読み取りのスロット 658。記録にある事実だけを表示しています。/); assert.match(c, READ);
    assert.doesNotMatch(c, /包囲が始まりました|戻りました|占領しました|予約はいまありません/);
    assert.equal(LC.localConquestOrderFor(p.fs, WORLD).phase, 'ordered');
    // the city is a site OF A PROVINCE: the same site number in another province, or another site here, is not this city's order
    for (const free_city of [{ p: '130', q: '0', site: 3, tile: 43 }, { p: '-129', q: '0', site: 3, tile: 43 }, { p: '129', q: '1', site: 3, tile: 43 }, { p: '129', q: '0', site: 4, tile: 43 }, { p: 129, q: 0, site: 3, tile: 43 }])
      assert.equal(LC.localConquestOrderFor(p.fs, { ...WORLD, free_city }), null, JSON.stringify(free_city));
    assert.equal(LC.localConquestOrderFor(p.fs, null), null);
    // ...and a read of THIS province is no evidence about a city of ANOTHER province: for such a world the read is idle,
    // so the card shows neither the order NOR "no reservation of yours for this city" (same site number, another place)
    for (const [cp, cq] of [['130', '0'], ['-129', '0'], ['129', '1']]) {
      const elsewhere = { ...WORLD, free_city: { p: cp, q: cq, site: 3, tile: 43 } };
      assert.equal(LC.localConquestReadFor(p.fs, elsewhere).status, 'idle'); assert.deepEqual(LC.localConquestReadFor(p.fs, elsewhere).orders, []);
      const view = String(hand.localConquestView({ localPlay: { ...p.fs.localPlay, conquestWorld: elsewhere } }, { phase: 'resident' },
        { state: LC.localConquestOf(p.fs), spent: false, other: false, order: LC.localConquestOrderFor(p.fs, elsewhere), read: LC.localConquestReadFor(p.fs, elsewhere) }));
      assert.match(view, /data-siege-read="idle"/); assert.match(view, READ);
      assert.doesNotMatch(view, SHOWN); assert.doesNotMatch(view, /予約はいまありません|読み取りのスロット|記録にある事実だけ/, `${cp},${cq}`);
    }
    assert.equal(LC.localConquestReadFor(p.fs, null).status, 'idle'); assert.equal(LC.localConquestReadFor(p.fs, WORLD).status, 'read');
    // the same through the LIVE card: the identity's world now names a city elsewhere
    { const live = p.fs.localPlay; p.fs.localPlay = { ...live, conquestWorld: { ...WORLD, free_city: { p: '130', q: '0', site: 3, tile: 43 } } };
      const lc = cardOf(p); assert.doesNotMatch(lc, SHOWN); assert.doesNotMatch(lc, /予約はいまありません|読み取りのスロット/); p.fs.localPlay = live; assert.match(cardOf(p), /data-siege-order="ordered"/); }
    // NOT_APPLIED, slot and rent released, resources owed: said as that; how it ended is NOT said (no basis)
    d = readDeps(p, ordersAnswer(p, [{ seq: 2, facts: orderFacts({ phase: 'not_applied', slot: 'released' }) }]));
    s = await LC.readLocalConquestOrders(p.fs, d.options); assert.equal(s.status, 'read');
    c = cardOf(p);
    assert.match(c, /data-siege-order="not_applied"/); assert.match(c, /包囲は始まりませんでした（場所 3）。予約は成立しませんでした。/); assert.match(c, /使用枠と預り金：解放済みです。/);
    assert.match(c, /預けた資源：返却待ちです。返却の債務として残っており/); assert.match(c, /data-siege-settled="no"/);
    // (the order's own lines: nothing of how it ended, no "returned", no missing Holding, no reason)
    assert.doesNotMatch(String(hand.siegeOrderView(LC.localConquestOrderFor(p.fs, WORLD))), /予約したターンの処理のときに|シーズンの終了または中断|預けた資源：戻りました|拠点がもうありません|理由/);
    assert.deepEqual(s.standing, { p: '129', q: '0' }, 'the read is about the province that was asked');
    // several of this wallet's records on the city: the latest (highest seq) is the one shown
    d = readDeps(p, ordersAnswer(p, [{ seq: 1, facts: orderFacts({ phase: 'not_applied' }) }, { seq: 4, facts: orderFacts({ order_bell: '23' }) }, { seq: 6, facts: orderFacts({ site: 5, order_bell: '30' }) }]));
    await LC.readLocalConquestOrders(p.fs, d.options);
    assert.deepEqual([LC.localConquestOrderFor(p.fs, WORLD).phase, LC.localConquestOrderFor(p.fs, WORLD).orderBell], ['ordered', '23']);
    // NO record (none at all, a table that does not exist, or only another site's): exactly that is said, and nothing is inferred from it
    for (const answer of [ordersAnswer(p, []), ordersAnswer(p, [], { table: 'absent' }), ordersAnswer(p, [{ seq: 6, facts: orderFacts({ site: 5 }) }])]) {
      s = await LC.readLocalConquestOrders(p.fs, readDeps(p, answer).options); assert.equal(s.status, 'read');
      c = cardOf(p); assert.doesNotMatch(c, SHOWN);
      assert.match(c, /この州の記録に、この都市へのあなたの予約はいまありません（読み取りのスロット 658）。記録がないことだけでは、包囲が始まったのか、返却が済んだのか、予約がなかったのかは分かりません。/);
      assert.doesNotMatch(c, /包囲が始まりました|戻りました|占領しました/);
    }
    // a host that no longer stays is still told, and offered the read but no prepare
    await LC.readLocalConquestOrders(p.fs, readDeps(p, ordersAnswer(p, [{ seq: 0, facts: orderFacts({ phase: 'not_applied' }) }])).options);
    const view = String(hand.localConquestView(p.fs, { phase: 'return-pending' }, { state: LC.localConquestOf(p.fs), spent: false, other: false, order: LC.localConquestOrderFor(p.fs, WORLD), read: LC.localConquestOrdersOf(p.fs) }));
    assert.match(view, /data-local-conquest="order-only"/); assert.match(view, /data-siege-order="not_applied"/); assert.match(view, READ); assert.doesNotMatch(view, /data-act="local-conquest-prepare"/);
    // the ordinary page, and local play without a world: no read button at all
    assert.doesNotMatch(String(hand.localConquestView({ localPlay: { conquestWorld: null } }, { phase: 'resident' }, { state: LC.localConquestOf(p.fs), spent: false, other: false, read: LC.localConquestOrdersOf(p.fs) })), READ);
  } finally { setLang('ja'); EW.destroyEphemeralWallet(); }
});

test('the reservation read refuses, whole: an answer of another scope or beyond what a record bears out, a relay refusal, a page that changed', async () => {
  const p = withWorld(await page());
  try {
    const error = async (reply, over) => { const d = readDeps(p, reply, over); const s = await LC.readLocalConquestOrders(p.fs, d.options); assert.equal(s.status, 'error'); assert.equal(s.orders.length, 0); assert.equal(LC.localConquestOrderFor(p.fs, WORLD), null); return s.error; };
    const one = (more, over) => ordersAnswer(p, [{ seq: 0, facts: orderFacts(more) }], over);
    // another wallet's, program's, Season's or province's answer
    for (const over of [{ wallet: encode(new Uint8Array(32).fill(9)) }, { program: A.season }, { season: PROGRAM }, { standing: { p: '130', q: '0' } }, { standing: { p: '-129', q: '0' } }])
      assert.equal(await error(one({}, over)), 'SiegeOrderAnswerScope', JSON.stringify(over));
    assert.equal(await error(one({ standing: { p: '130', q: '0' } })), 'SiegeOrderAnswerScope', 'an order of another province inside this province\'s answer');
    // more than a table record can say: a started siege, a capture, a loss, how it ended, the source Holding, a reason, the day's count
    for (const more of [{ phase: 'started', decided_bell: '19' }, { phase: 'captured', decided_bell: '58', slot: 'used', capture: { receipt: true, holding: true, slot: true } }, { phase: 'lost', decided_bell: '40', stake: 'burnt' },
      { phase: 'unresolved', decided_bell: '90' }, { phase: 'not_applied', lapsed: true }, { phase: 'not_applied', lapsed: false, decided_bell: '19' }, { phase: 'not_applied', source: 'absent' }, { phase: 'not_applied', source: 'present' },
      { phase: 'not_applied', lapsed: false, decided_bell: '19', reason: 'HostGone' }, { day: { used: 1, limit: 2 } }])
      assert.equal(await error(one(more)), 'SiegeOrderAnswerBeyondEvidence', JSON.stringify(more));
    // a statement that contradicts itself; one bad order refuses the good one beside it
    assert.equal(await error(one({ phase: 'not_applied', stake: 'burnt' })), 'SiegeOrderFactsInconsistent');
    assert.equal(await error(ordersAnswer(p, [{ seq: 0, facts: orderFacts() }, { seq: 1, facts: orderFacts({ phase: 'started', decided_bell: '19' }) }])), 'SiegeOrderAnswerBeyondEvidence');
    // malformed answers
    for (const bad of [null, {}, [], ordersAnswer(p, [], { schema: 'frontier-local-play-conquest-state-v1' }), { ...ordersAnswer(p), extra: 1 }, ordersAnswer(p, [{ seq: 0, facts: orderFacts() }], { table: 'absent' }),
      ordersAnswer(p, [], { table: 'gone' }), ordersAnswer(p, [], { context_slot: 658 }), ordersAnswer(p, [], { table_address: 'x' }), ordersAnswer(p, [{ seq: 1, facts: orderFacts() }, { seq: 1, facts: orderFacts() }]),
      ordersAnswer(p, [{ seq: 2, facts: orderFacts() }, { seq: 1, facts: orderFacts() }]), ordersAnswer(p, [{ seq: 0, facts: orderFacts(), more: 1 }]), ordersAnswer(p, Array.from({ length: 9 }, (_, i) => ({ seq: i, facts: orderFacts() })))])
      assert.equal(await error(bad), 'SiegeOrderAnswerMalformed', JSON.stringify(bad)?.slice(0, 80));
    // the relay refuses (the route does not exist while the conquest routes are closed), or does not answer
    assert.equal(await error(() => { throw Object.assign(new Error('refused'), { code: 'NotFound', refused: true }); }), 'NotFound');
    assert.equal(await error(() => { throw new Error('reset'); }), 'LocalConquestOrdersFailed');
    // the page changes WHILE the relay is asked: the answer is not taken
    const live = p.fs.localPlay;
    assert.equal(await error(() => { p.fs.localPlay = { ...live, seasonAddress: PROGRAM }; return one(); }), 'LocalConquestChanged'); p.fs.localPlay = live;
    assert.equal(await error(() => { p.fs.wallet = { address: p.WALLET }; return one(); }), 'LocalConquestChanged');
    const before = p.fs.expeditionPreview;
    assert.equal(await error(async () => { await observe(p, 'dissolve'); return one(); }), p.fs.expeditionPreview === before ? 'LocalConquestChanged' : 'LocalConquestChanged');
  } finally { EW.destroyEphemeralWallet(); }
});

test('a finished reservation read is shown only while the page is still the one it was read for; an old answer never comes back', async () => {
  const shown = p => [LC.localConquestOrdersOf(p.fs).status, LC.localConquestOrderFor(p.fs, WORLD)?.phase ?? null];
  const fresh = async () => { const p = withWorld(await page()); const s = await LC.readLocalConquestOrders(p.fs, readDeps(p, ordersAnswer(p, [{ seq: 0, facts: orderFacts() }])).options); assert.equal(s.status, 'read'); assert.deepEqual(shown(p), ['read', 'ordered']); return p; };
  try {
    // AFTER completion: another program, Season, cluster or wallet address on the identity → idle, nothing shown
    let p = await fresh(); const live = p.fs.localPlay;
    for (const over of [{ programId: A.season }, { seasonAddress: PROGRAM }, { seasonId: '2' }, { cluster: 'devnet' }, { address: encode(new Uint8Array(32).fill(9)) }]) {
      p.fs.localPlay = { ...live, ...over }; assert.deepEqual(shown(p), ['idle', null], JSON.stringify(over));
      assert.doesNotMatch(cardOf({ ...p, fs: { ...p.fs, localPlay: { ...live, ...over } } }), SHOWN);
    }
    p.fs.localPlay = null; assert.deepEqual(shown(p), ['idle', null]);
    p.fs.localPlay = live; assert.deepEqual(shown(p), ['read', 'ordered'], '(the very identity it was read for)');
    // the page's wallet or session object replaced
    const wallet = p.fs.wallet; p.fs.wallet = { address: p.WALLET }; assert.deepEqual(shown(p), ['idle', null]); p.fs.wallet = wallet;
    p.fs.session = { any: 1 }; assert.deepEqual(shown(p), ['idle', null]); p.fs.session = null; assert.deepEqual(shown(p), ['read', 'ordered']);
    // another card observation: the answer belonged to the earlier one
    await observe(p, 'dissolve'); assert.deepEqual(shown(p), ['idle', null]); assert.doesNotMatch(cardOf(p), SHOWN);
    // the memory-only wallet destroyed: gone for good, also when the identity object is put back
    p = await fresh(); EW.destroyEphemeralWallet(); assert.deepEqual(shown(p), ['idle', null]);
    // a later press that is refused (the closed route) replaces the answer: the error is shown, the old order is NOT
    p = await fresh();
    const s = await LC.readLocalConquestOrders(p.fs, readDeps(p, () => { throw new Error('must not be asked'); }, { conditions: null }).options);
    assert.equal(s.error, 'ConquestRouteClosed'); assert.deepEqual(shown(p), ['error', null]);
    setLang('ja'); const c = cardOf(p); assert.match(c, /包囲の経路はまだ閉じています/); assert.doesNotMatch(c, SHOWN);
    // and while a new read is in flight the earlier answer is already gone
    let during = null;
    await LC.readLocalConquestOrders(p.fs, readDeps(p, () => { during = shown(p); return ordersAnswer(p, []); }).options);
    assert.deepEqual(during, ['reading', null]); assert.deepEqual(shown(p), ['read', null]);
  } finally { setLang('ja'); EW.destroyEphemeralWallet(); }
});

test('the city\'s present state on the card: your siege with its own numbers, a capture due, yours now, another player\'s — and gone with the read', async () => {
  const p = withWorld(await page());
  setLang('ja');
  try {
    const read = async (siege, orders = [], over = {}) => { const s = await LC.readLocalConquestOrders(p.fs, readDeps(p, ordersAnswer(p, orders, { siege, ...over })).options); return s; };
    const CITY = /data-siege-city="/, NONE = /予約はいまありません/;
    // nothing stands there and no record: the "no record" sentence, no city line
    let s = await read(null); assert.equal(s.status, 'read'); let c = cardOf(p); assert.doesNotMatch(c, CITY); assert.match(c, NONE);
    // your siege: its own progress of its own requirement; not yours yet; and NOT the "no reservation" sentence
    s = await read({ state: 'siege', site: 3, progress: 7, required: 36, declared_bell: '19' }); assert.equal(s.status, 'read');
    assert.deepEqual(LC.localConquestCityFor(p.fs, WORLD), { state: 'siege', site: 3, progress: 7, required: 36, declaredBell: '19' });
    c = cardOf(p); assert.match(c, /data-siege-city="siege"/); assert.match(c, /あなたの包囲が進行中です：7 \/ 36 ターン（宣言はターン 19・場所 3）/); assert.match(c, /都市はまだあなたのものではありません/); assert.doesNotMatch(c, NONE);
    assert.match(c, /読み取りのスロット 658/); assert.doesNotMatch(c, /占領しました|あなたが所有しています/);
    await read({ state: 'siege', site: 3, progress: 2, required: 5, declared_bell: '19' }); assert.match(cardOf(p), /2 \/ 5 ターン/);
    // a capture due: the due turn, no progress figure, not yours yet
    await read({ state: 'capture_due', site: 3, due_bell: '55', declared_bell: '19' });
    c = cardOf(p); assert.match(c, /占領の精算待ちです（ターン 55 以降・宣言はターン 19・場所 3）/); assert.doesNotMatch(c, /\d+ \/ \d+ ターン/); assert.doesNotMatch(c, /あなたが所有しています|占領しました/);
    // yours NOW: a present fact; no "captured", no "won"
    await read({ state: 'owned', site: 3, slot: 2, generation: 1 }, [], { table: 'absent' });
    c = cardOf(p); assert.match(c, /data-siege-city="owned"/); assert.match(c, /この都市はいま、あなたが所有しています（場所 3・拠点の枠 2）。いま所有しているという事実だけを表示しています。/);
    assert.doesNotMatch(c, /占領しました|勝ちました|勝利|奪いました/); assert.doesNotMatch(c, NONE);
    // a HELD city (yours, or another player's) is not offered a reservation: the prepare button is not drawn; the read button stays
    const PREPARE = /data-act="local-conquest-prepare"/;
    assert.doesNotMatch(c, PREPARE, 'yours now: no prepare button'); assert.match(c, READ);
    await read({ state: 'other', site: 3, what: 'holding' }, [], { table: 'absent' });
    c = cardOf(p); assert.doesNotMatch(c, PREPARE, 'another player holds it: no prepare button'); assert.match(c, READ); assert.match(c, /別のプレイヤーが所有しています/);
    // ...and ONLY then: a siege under way, a capture due, a slot owed, another player's siege, or nothing at all keep the button
    for (const siege of [null, { state: 'siege', site: 3, progress: 7, required: 36, declared_bell: '19' }, { state: 'capture_due', site: 3, due_bell: '55', declared_bell: '19' }, { state: 'slot_owed', site: 3, slot: 2 },
      { state: 'other', site: 3, what: 'siege' }, { state: 'other', site: 3, what: 'capture_due' }, { state: 'other', site: 3, what: 'slot_owed' }]) {
      await read(siege); assert.match(cardOf(p), PREPARE, JSON.stringify(siege));
    }
    // a held state of ANOTHER site or province is not this city's: the button stays
    await read({ state: 'owned', site: 5, slot: 2, generation: 1 }); assert.match(cardOf(p), PREPARE);
    // once the read is no longer shown (another identity), the button is back: nothing is remembered of "held"
    await read({ state: 'owned', site: 3, slot: 2, generation: 1 }, [], { table: 'absent' }); assert.doesNotMatch(cardOf(p), PREPARE);
    { const live = p.fs.localPlay; p.fs.localPlay = { ...live, address: encode(new Uint8Array(32).fill(9)) }; assert.equal(LC.localConquestCityFor(p.fs, WORLD), null); p.fs.localPlay = live; }
    // a message prepared BEFORE the read showed the city held is not offered for signing either: no send, no prepare — said in words; the read button stays
    {
      const held = { ...LC.localConquestOf(p.fs), status: 'prepared', host: 'x', site: 3, entry: 0, standing: { p: '129', q: '0' }, digest: 'ab'.repeat(32), lastValidBlockHeight: '250' };
      const base = { state: held, spent: false, other: false, order: null, read: LC.localConquestReadFor(p.fs, WORLD) }, SEND = /data-act="local-conquest-send"/;
      for (const city of [{ state: 'owned', site: 3, slot: 2, generation: 1 }, { state: 'other', site: 3, what: 'holding' }]) {
        const v = String(hand.localConquestView(p.fs, { phase: 'resident' }, { ...base, city }));
        assert.doesNotMatch(v, SEND, city.state); assert.doesNotMatch(v, PREPARE); assert.match(v, /この都市はすでに所有されています。包囲の予約は送れません。/); assert.match(v, READ);
      }
      for (const city of [null, { state: 'siege', site: 3, progress: 1, required: 36, declaredBell: '19' }, { state: 'other', site: 3, what: 'siege' }]) {
        const v = String(hand.localConquestView(p.fs, { phase: 'resident' }, { ...base, city })); assert.match(v, SEND); assert.match(v, PREPARE);
      }
    }
    // beside a record of yours: both are shown (a later reservation waiting while an earlier siege runs)
    await read({ state: 'siege', site: 3, progress: 1, required: 36, declared_bell: '19' }, [{ seq: 4, facts: orderFacts({ order_bell: '23' }) }]);
    c = cardOf(p); assert.match(c, /data-siege-order="ordered"/); assert.match(c, /data-siege-city="siege"/);
    // another player's: never "your"
    for (const [what, re] of [['siege', /別のプレイヤーの包囲が進行中です/], ['holding', /いま、別のプレイヤーが所有しています/], ['capture_due', /別のプレイヤーの包囲が占領の精算待ちです/], ['slot_owed', /別のプレイヤーの包囲に関する記録があります/]]) {
      await read({ state: 'other', site: 3, what }, [], what === 'holding' ? { table: 'absent' } : {}); c = cardOf(p); assert.match(c, re, what); assert.doesNotMatch(c, /あなたの包囲|あなたが所有/, what);
    }
    // a state of ANOTHER site is not this city's: nothing of it is shown
    await read({ state: 'owned', site: 5, slot: 2, generation: 1 });
    assert.equal(LC.localConquestCityFor(p.fs, WORLD), null); c = cardOf(p); assert.doesNotMatch(c, CITY); assert.match(c, NONE);
    // ...nor for a city of another province (same site number): idle, no city line, no "no reservation" either
    await read({ state: 'owned', site: 3, slot: 2, generation: 1 });
    assert.equal(LC.localConquestCityFor(p.fs, WORLD).state, 'owned');
    for (const [cp, cq] of [['130', '0'], ['-129', '0']]) {
      const elsewhere = { ...WORLD, free_city: { p: cp, q: cq, site: 3, tile: 43 } };
      assert.equal(LC.localConquestCityFor(p.fs, elsewhere), null);
      const live = p.fs.localPlay; p.fs.localPlay = { ...live, conquestWorld: elsewhere }; c = cardOf(p); p.fs.localPlay = live;
      assert.doesNotMatch(c, CITY); assert.doesNotMatch(c, NONE); assert.doesNotMatch(c, /あなたが所有/);
    }
    // refused answers: a malformed state, a past-tense state, an entry state with no table observed — the whole answer, nothing shown
    for (const [siege, over] of [[{ state: 'captured', site: 3 }, {}], [{ state: 'owned', site: 3, slot: 2, generation: 1, receipt: true }, {}], [{ state: 'siege', site: 3, progress: 36, required: 36, declared_bell: '19' }, {}],
      [{ state: 'siege', site: 3, progress: 1, required: 36, declared_bell: '19' }, { table: 'absent' }], [{ state: 'capture_due', site: 3, due_bell: '55', declared_bell: '19' }, { table: 'absent' }],
      [{ state: 'other', site: 3, what: 'siege' }, { table: 'absent' }], [{ state: 'owned', site: 3, slot: 1, generation: 1 }, {}]]) {
      // (with a good order beside it where a table is observed: the bad state refuses that order too)
      s = await read(siege, over.table === 'absent' ? [] : [{ seq: 0, facts: orderFacts() }], over);
      assert.deepEqual([s.status, s.error, s.city, s.orders.length], ['error', 'SiegeCityStateMalformed', null, 0], JSON.stringify(siege)); assert.doesNotMatch(cardOf(p), CITY); assert.doesNotMatch(cardOf(p), SHOWN);
    }
    // an answer without the `siege` key (the earlier shape) is not this contract's
    s = await LC.readLocalConquestOrders(p.fs, readDeps(p, (({ siege, ...rest }) => rest)(ordersAnswer(p))).options); assert.equal(s.error, 'SiegeOrderAnswerMalformed');
    // IDENTITY: the state is shown only while the page is still the one it was read for
    await read({ state: 'owned', site: 3, slot: 2, generation: 1 }); assert.match(cardOf(p), /あなたが所有しています/);
    const live = p.fs.localPlay;
    for (const over of [{ address: encode(new Uint8Array(32).fill(9)) }, { seasonAddress: PROGRAM }, { programId: A.season }, { seasonId: '2' }]) {
      p.fs.localPlay = { ...live, ...over }; assert.equal(LC.localConquestCityFor(p.fs, WORLD), null, JSON.stringify(over)); assert.doesNotMatch(cardOf(p), /あなたが所有|data-siege-city/);
    }
    p.fs.localPlay = live; assert.equal(LC.localConquestCityFor(p.fs, WORLD).state, 'owned');
    const wallet = p.fs.wallet; p.fs.wallet = { address: p.WALLET }; assert.equal(LC.localConquestCityFor(p.fs, WORLD), null); p.fs.wallet = wallet;
    await observe(p, 'dissolve'); assert.equal(LC.localConquestCityFor(p.fs, WORLD), null); assert.doesNotMatch(cardOf(p), /あなたが所有|data-siege-city/);
    await read({ state: 'owned', site: 3, slot: 2, generation: 1 }); EW.destroyEphemeralWallet(); assert.equal(LC.localConquestCityFor(p.fs, WORLD), null);
  } finally { setLang('ja'); EW.destroyEphemeralWallet(); }
});

test('P5 F1 — an exception in the gate, the identity or the status answer never settles an unsettled step and never leaves it busy', async () => {
  // (a) the gate throws during the AUTOMATIC look right after a submit: the step stays `submitted`, not `error`
  let p = await page(), d = deps(p), n = 0;
  await LC.prepareLocalConquest(p.fs, d.options);
  const gate = d.options.allowed; let arm = false;
  const throwing = { ...d.options, allowed: () => { if (arm) throw new Error('gate exploded'); return gate(); } };
  // (armed by the submit itself: the very next gate call is reconcile's)
  const post = d.options.post; throwing.post = async (o, path, body) => { const r = await post(o, path, body); if (path === S) arm = true; return r; };
  let s = await LC.sendLocalConquest(p.fs, throwing);
  assert.deepEqual([s.status, s.busy, s.sent], ['submitted', false, true], 'still unsettled, not busy');
  assert.equal(typeof s.error, 'string'); assert.equal(d.count(S), 1);
  // unsettled means: nothing new is prepared, sent or cleared — and the return steps of the host stay held off
  arm = false;
  assert.equal((await LC.prepareLocalConquest(p.fs, d.options)).status, 'submitted'); assert.equal((await LC.sendLocalConquest(p.fs, d.options)).status, 'submitted');
  assert.equal(LC.clearLocalConquest(p.fs), false); assert.equal(d.count(P), 1); assert.equal(d.count(S), 1);
  // (b) the gate throws on a MANUAL reconcile press: unsettled as before, busy released, and a later press works
  arm = true; s = await LC.reconcileLocalConquest(p.fs, throwing);
  assert.deepEqual([s.status, s.busy], ['submitted', false]); assert.equal(s.error, 'LocalConquestGateFailed');
  arm = false; s = await LC.reconcileLocalConquest(p.fs, d.options); assert.deepEqual([s.status, s.busy], ['confirmed', false]);
  EW.destroyEphemeralWallet();
  // (c) the identity accessor throws (a Season id that cannot be read as a string)
  p = await page(); d = deps(p, { status: () => ({ status: 'pending' }) });
  await LC.prepareLocalConquest(p.fs, d.options); s = await LC.sendLocalConquest(p.fs, d.options); assert.equal(s.status, 'submitted');
  const live = p.fs.localPlay; p.fs.localPlay = { ...live, get seasonId() { throw new Error('no id'); } };
  s = await LC.reconcileLocalConquest(p.fs, { ...d.options, allowed: () => ({ ok: true, relay: RELAY }) });
  assert.deepEqual([s.status, s.busy, s.error], ['submitted', false, 'LocalConquestGateFailed']); p.fs.localPlay = live;
  // (d) a status answer that throws when read (an injected post; the real one is JSON): unsettled, not busy
  s = await LC.reconcileLocalConquest(p.fs, { ...d.options, post: async (o, path, body) => ({ signature: body.signature, get status() { throw new Error('boom'); } }) });
  assert.deepEqual([s.status, s.busy], ['submitted', false]); assert.equal(typeof s.error, 'string');
  s = await LC.reconcileLocalConquest(p.fs, { ...d.options, post: async (o, path, body) => ({ signature: body.signature, status: 'confirmed', err: null, get slot() { throw new Error('boom'); } }) });
  assert.deepEqual([s.status, s.busy], ['submitted', false]);
  // (e) an exception AFTER the POST began is an outcome not known, never `error`: here the submit answer throws when read
  EW.destroyEphemeralWallet(); p = await page(); d = deps(p);
  await LC.prepareLocalConquest(p.fs, d.options);
  s = await LC.sendLocalConquest(p.fs, { ...d.options, post: async (o, path, body) => (path === S ? { get status() { throw new Error('boom'); }, signature: 'x' } : d.options.post(o, path, body)) });
  assert.deepEqual([s.status, s.busy, s.sent], ['unknown', false, true]);
  assert.equal((await LC.prepareLocalConquest(p.fs, d.options)).status, 'unknown', 'no new prepare while unknown'); assert.equal(LC.clearLocalConquest(p.fs), false);
  // (f) BEFORE anything was sent an exception is an `error` with nothing sent (the gate throws at the first press)
  EW.destroyEphemeralWallet(); p = await page(); d = deps(p);
  s = await LC.prepareLocalConquest(p.fs, { ...d.options, allowed: () => { throw new Error('gate exploded'); } });
  assert.deepEqual([s.status, s.busy, s.sent], ['error', false, false]); assert.equal(d.log.posts.length, 0);
  void n; EW.destroyEphemeralWallet();
});

test('P5 F2 (page) — "did not land" is taken only as this step\'s own settlement; anything else leaves the step unsettled; nothing is resent', async () => {
  // (the relay's answer is a stand-in; prepared messages here have a last valid block height of 250)
  const fresh = async status => { const p = await page(), d = deps(p, { status: () => ({ status: 'pending' }) }); await LC.prepareLocalConquest(p.fs, d.options);
    const s = await LC.sendLocalConquest(p.fs, d.options); assert.equal(s.status, 'submitted'); assert.equal(s.lastValidBlockHeight, '250');
    const r = await LC.reconcileLocalConquest(p.fs, { ...d.options, post: async (o, path, body) => ({ signature: body.signature, err: null, ...status(body) }) }); return { p, d, r }; };
  // the well-formed settlement: this step's height, a slot past it → terminal `expired`
  let { p, d, r } = await fresh(() => ({ status: 'expired_unlanded', context_slot: 251, last_valid_block_height: '250' }));
  assert.deepEqual([r.status, r.busy, r.chain, r.slot, r.error, r.sent], ['expired', false, 'expired_unlanded', 251, null, true]);
  // terminal: no reconcile, no send; the observation it was sent on stays used; one submit only
  assert.equal((await LC.reconcileLocalConquest(p.fs, d.options)).status, 'expired'); assert.equal((await LC.sendLocalConquest(p.fs, d.options)).status, 'expired');
  assert.equal(LC.localConquestSpent(p.fs), true); assert.equal(d.count(S), 1);
  const again = await LC.prepareLocalConquest(p.fs, d.options); assert.deepEqual([again.status, again.error], ['error', 'ConquestObservationSpent'], 'a new step needs a new reading');
  assert.equal(d.count(P), 1);
  setLang('ja');
  try {
    LC.clearLocalConquest(p.fs); ({ p, d, r } = await fresh(() => ({ status: 'expired_unlanded', context_slot: 251, last_valid_block_height: '250' })));
    let c = String(hand.renderPop(p.fs, hand.handModel(p.fs)));
    assert.match(c, /data-local-conquest="expired"/); assert.match(c, /この操作は反映されませんでした。送った取引は有効期限を過ぎ、記録されていません。/); assert.doesNotMatch(c, /何も変わっていません/, 'said of this transaction only, not of the world');
    assert.doesNotMatch(c, /data-act="local-conquest-reconcile"|data-act="local-conquest-send"/); assert.doesNotMatch(c, /記録されました|失敗しました/);
    setLang('en'); c = String(hand.renderPop(p.fs, hand.handModel(p.fs))); assert.match(c, /This action did not take effect\. The transaction sent has passed its validity and was not recorded\./);
    assert.deepEqual(missingKeys().filter(k => /反映されませんでした/.test(k)), []);
  } finally { setLang('ja'); }
  // NOT a settlement: another height than the one held, a slot not past it, a missing or malformed slot, no height at all
  for (const bad of [{ context_slot: 251, last_valid_block_height: '249' }, { context_slot: 251, last_valid_block_height: 250 }, { context_slot: 250, last_valid_block_height: '250' },
    { context_slot: 100, last_valid_block_height: '250' }, { context_slot: '251', last_valid_block_height: '250' }, { context_slot: 251.5, last_valid_block_height: '250' },
    { last_valid_block_height: '250' }, { context_slot: 251 }, {}]) {
    EW.destroyEphemeralWallet(); ({ p, d, r } = await fresh(() => ({ status: 'expired_unlanded', ...bad })));
    assert.deepEqual([r.status, r.busy, r.error], ['submitted', false, 'BadLocalConquestStatus'], JSON.stringify(bad));
    assert.equal((await LC.prepareLocalConquest(p.fs, d.options)).status, 'submitted', 'still unsettled: nothing new is prepared');
  }
  // a pending answer (also one carrying a slot far past the height) settles nothing: only the relay may say "expired_unlanded"
  EW.destroyEphemeralWallet(); ({ p, d, r } = await fresh(() => ({ status: 'pending', context_slot: 1_000_000, last_valid_block_height: '250' })));
  assert.deepEqual([r.status, r.chain], ['submitted', 'pending']);
  // timeouts, refusals (also "unknown signature"), malformed answers: unsettled
  for (const post of [async () => { throw new Error('timeout'); }, async () => { throw Object.assign(new Error('refused'), { code: 'LocalPlayUnknownSignature', refused: true }); },
    async () => { throw Object.assign(new Error('refused'), { code: 'LocalPlayRpcUnavailable', refused: true }); }, async () => ({}), async () => null]) {
    const x = await LC.reconcileLocalConquest(p.fs, { ...d.options, post }); assert.equal(x.status, 'submitted'); assert.equal(x.busy, false);
  }
  assert.equal(d.count(S), 1);
  EW.destroyEphemeralWallet();
});

test('P5 F3 — a city the read shows HELD is not prepared for and a message prepared before is not signed', async () => {
  const p = withWorld(await page());
  try {
    const read = siege => LC.readLocalConquestOrders(p.fs, readDeps(p, ordersAnswer(p, [], { siege, table: 'absent' })).options);
    // held (yours / another player's) → prepare refuses before the relay is asked
    for (const siege of [{ state: 'owned', site: 3, slot: 2, generation: 1 }, { state: 'other', site: 3, what: 'holding' }]) {
      await read(siege); const d = deps(p), s = await LC.prepareLocalConquest(p.fs, d.options);
      assert.deepEqual([s.status, s.error, s.sent], ['error', 'ConquestCityHeld', false], siege.state); assert.equal(d.log.posts.length, 0); LC.clearLocalConquest(p.fs);
    }
    // not held (nothing, a siege of yours, another player's siege) → prepare goes ahead
    for (const siege of [null, { state: 'other', site: 3, what: 'siege' }]) {
      await LC.readLocalConquestOrders(p.fs, readDeps(p, ordersAnswer(p, [], { siege })).options); const d = deps(p);
      assert.equal((await LC.prepareLocalConquest(p.fs, d.options)).status, 'prepared', JSON.stringify(siege)); LC.clearLocalConquest(p.fs);
    }
    // prepared FIRST, then the read shows the city held → the send signs nothing and posts nothing
    const d = deps(p); let s = await LC.prepareLocalConquest(p.fs, d.options); assert.equal(s.status, 'prepared');
    await read({ state: 'owned', site: 3, slot: 2, generation: 1 });
    setLang('ja'); let c = cardOf(p); assert.doesNotMatch(c, /data-act="local-conquest-send"/); assert.match(c, /この都市はすでに所有されています。包囲の予約は送れません。/);
    s = await LC.sendLocalConquest(p.fs, d.options);
    assert.deepEqual([s.status, s.error, s.sent, s.signature], ['error', 'ConquestCityHeld', false, null]); assert.equal(d.count(S), 0);
    c = cardOf(p); assert.match(c, /この都市はすでに所有されています/); assert.match(c, /何も送っていません/);
    setLang('en'); assert.match(cardOf(p), /This city is already held\. A siege reservation cannot be sent\./);
  } finally { setLang('ja'); EW.destroyEphemeralWallet(); }
});

test('P5 F4 — the step\'s lines belong to its host and identity: not drawn on another host\'s card or after a change; an unsettled one is said, and nothing is prepared', async () => {
  const p = withWorld(await page());
  setLang('ja');
  try {
    const d = deps(p, { status: () => ({ status: 'pending' }) });
    await LC.prepareLocalConquest(p.fs, d.options); let s = await LC.sendLocalConquest(p.fs, d.options); assert.equal(s.status, 'submitted');
    const SENT = /local-conquest-sent/, FOREIGN = /別の軍勢またはウォレットで送った包囲の結果が、まだ確定していません/, PREP_OFF = /data-act="local-conquest-prepare" aria-disabled="true"/;
    // on its own host and identity: its line, the reconcile button
    assert.deepEqual([LC.localConquestShown(p.fs).state.status, LC.localConquestShown(p.fs).foreign], ['submitted', false]);
    let c = cardOf(p); assert.match(c, SENT); assert.match(c, /data-act="local-conquest-reconcile"/); assert.doesNotMatch(c, FOREIGN);
    // another HOST on the card: the line and the signature are not drawn; it says a siege elsewhere is unsettled; prepare is disabled
    const req = p.fs.expeditionPreview.request, sig = s.signature.slice(0, 8);
    p.fs.expeditionPreview.request = { ...req, host: 'another-host' };
    assert.deepEqual([LC.localConquestShown(p.fs).state.status, LC.localConquestShown(p.fs).foreign], ['idle', true]);
    c = String(hand.localConquestView(p.fs, { phase: 'resident' }, { ...LC.localConquestShown(p.fs), spent: false, other: false }));
    assert.doesNotMatch(c, SENT); assert.ok(!c.includes(sig)); assert.match(c, FOREIGN); assert.match(c, PREP_OFF); assert.doesNotMatch(c, /data-act="local-conquest-reconcile"/);
    p.fs.expeditionPreview.request = req;
    // another wallet address, Season, program, cluster; the page's wallet or session object replaced
    const live = p.fs.localPlay;
    for (const over of [{ address: encode(new Uint8Array(32).fill(9)) }, { seasonAddress: PROGRAM }, { seasonId: '2' }, { programId: A.season }, { cluster: 'devnet' }]) {
      p.fs.localPlay = { ...live, ...over }; assert.deepEqual([LC.localConquestShown(p.fs).state.status, LC.localConquestShown(p.fs).foreign], ['idle', true], JSON.stringify(over));
    }
    p.fs.localPlay = live;
    const wallet = p.fs.wallet; p.fs.wallet = { address: p.WALLET }; assert.equal(LC.localConquestShown(p.fs).state.status, 'idle'); p.fs.wallet = wallet;
    p.fs.session = { x: 1 }; assert.equal(LC.localConquestShown(p.fs).state.status, 'idle'); p.fs.session = null;
    assert.equal(LC.localConquestShown(p.fs).state.status, 'submitted', 'back on its own card');
    // the module itself is unchanged by what is shown: the unsettled step still refuses a new prepare, whoever looks
    p.fs.expeditionPreview.request = { ...req, host: 'another-host' };
    assert.equal((await LC.prepareLocalConquest(p.fs, d.options)).status, 'submitted'); assert.equal(d.count(P), 1); p.fs.expeditionPreview.request = req;
    // a SETTLED step of another host is simply not drawn, and nothing is held off
    s = await LC.reconcileLocalConquest(p.fs, { ...d.options, post: deps(p).options.post }); assert.equal(s.status, 'confirmed');
    assert.match(cardOf(p), /local-conquest-done/);
    p.fs.expeditionPreview.request = { ...req, host: 'another-host' };
    assert.deepEqual([LC.localConquestShown(p.fs).state.status, LC.localConquestShown(p.fs).foreign], ['idle', false]);
    c = String(hand.localConquestView(p.fs, { phase: 'resident' }, { ...LC.localConquestShown(p.fs), spent: false, other: false }));
    assert.doesNotMatch(c, /local-conquest-done|取引が記録されました/); assert.doesNotMatch(c, FOREIGN); assert.doesNotMatch(c, PREP_OFF);
    p.fs.expeditionPreview.request = req;
    // a refusal before anything was captured (the closed route) is shown only while the page objects are those of that press
    LC.clearLocalConquest(p.fs);
    await LC.prepareLocalConquest(p.fs, deps(p, { conditions: null }).options);
    assert.equal(LC.localConquestShown(p.fs).state.error, 'ConquestRouteClosed'); assert.match(cardOf(p), /包囲の経路はまだ閉じています/);
    p.fs.localPlay = { ...p.fs.localPlay }; assert.equal(LC.localConquestShown(p.fs).state.status, 'idle'); assert.doesNotMatch(cardOf(p), /ConquestRouteClosed/);
    setLang('en'); p.fs.expeditionPreview.request = { ...req, host: 'another-host' };
    assert.deepEqual(missingKeys().filter(k => /別の軍勢またはウォレット|すでに所有されています/.test(k)), []);
    const hud = readFileSync(new URL('../../permutation-server/web/frontier/hud/hand.mjs', import.meta.url), 'utf8');
    assert.ok(hud.includes('const shown = localConquestShown(FS);') && !hud.includes('localConquestOf(FS)'), 'the card draws the scoped state only');
  } finally { setLang('ja'); EW.destroyEphemeralWallet(); }
});

test('the read\'s wiring: one more HUD action to the controller, no condition passed, the order and the read state from the module only', () => {
  const read = file => readFileSync(new URL(`../../permutation-server/web/frontier/${file}`, import.meta.url), 'utf8');
  const app = read('app.mjs'), ctl = read('controller.mjs'), hud = read('hud/hand.mjs'), mod = read('flocalplay-conquest.mjs');
  assert.ok(app.includes("'local-conquest-orders': () => readLocalPlayConquestOrders(),"));
  assert.ok(app.includes("const LOCAL_CONQUEST_ACTS = Object.freeze(['local-conquest-prepare', 'local-conquest-send', 'local-conquest-reconcile', 'local-conquest-orders']);"), 'pressing it keeps the card\'s observation');
  assert.ok(ctl.includes('export const readLocalPlayConquestOrders = () => localConquest.readLocalConquestOrders(FS, localConquestDeps());'));
  assert.ok(hud.includes("order: localConquestOrderFor(FS, FS.localPlay?.conquestWorld ?? null), read: localConquestReadFor(FS, FS.localPlay?.conquestWorld ?? null),\n    city: localConquestCityFor(FS, FS.localPlay?.conquestWorld ?? null) });"), 'all three for this start\'s city');
  assert.ok(!hud.includes('localConquestOrdersOf'), 'the card never takes the raw read state: only the one that concerns this city');
  assert.ok(!hud.includes('siegeOrderRead') && !/from '[^']*fconquest-order\.mjs'/.test(hud), 'the card takes the order from the read module, and reads no answer itself');
  assert.ok(mod.includes("export const LOCAL_CONQUEST_ORDERS_PATH = '/gw/f/local-play/conquest/orders';"));
  assert.ok(mod.includes('export const LOCAL_CONQUEST_PAGE_CONDITIONS = Object.freeze({ heapConfirmed: false });'), 'the page condition is as it was');
  const from = mod.indexOf('export async function readLocalConquestOrders'), body = mod.slice(from);
  for (const banned of ['signTransaction', 'wireTransaction', 'LOCAL_CONQUEST_SUBMIT_PATH', 'setInterval', 'setTimeout', 'localStorage', 'spendHostObservation', 'claimHostStep']) assert.ok(!body.includes(banned), banned);
});
