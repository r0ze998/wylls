// The browser side of the unsigned Depart preparation (web/frontier/fexpedition-depart-prepare.mjs) against the
// report the real Rust CLI produced (fixtures/frontier-expedition-depart-prepare-rust.json, never edited) and a
// synthetic LOCAL boundary draft with injected observations and relay answers. No boot, network, wallet, key, seal,
// signature or send: the commit and seal used here are fixed public filler bytes, not a seal of anything.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { seasonAddresses, hostId } from '../../permutation-server/web/frontier/faddr.mjs';
import { encode, decode as fromB58 } from '../../permutation-server/web/sdk/base58.mjs';
import { encodeAccount } from '../../permutation-server/web/sdk/frontier/codec.mjs';
import { decode } from '../../permutation-server/web/frontier/fcodec.mjs';
import { OUTBOUND_POP, openOutbound, editOutbound, clearOutbound, inspectOutboundContext } from '../../permutation-server/web/frontier/fexpedition-compose.mjs';
import * as DP from '../../permutation-server/web/frontier/fexpedition-depart-prepare.mjs';
import { compileMessage, parseMessage, COMPUTE_BUDGET_PROGRAM } from '../../permutation-server/web/sdk/solana-tx.mjs';

// The real Rust reports of the canonical shape (three budget instructions, the one fixed 256 KiB heap frame, the dispatch).
const RUST_TEXT = readFileSync(new URL('./fixtures/frontier-expedition-depart-prepare-heap256k-rust.json', import.meta.url), 'utf8');
// HISTORICAL, never edited: the real Rust reports of the FORMER shape (no heap frame). Kept as the old contract's record.
const FORMER_TEXT = readFileSync(new URL('./fixtures/frontier-expedition-depart-prepare-rust.json', import.meta.url), 'utf8');
const FORMER_WALLET_PAYER_TEXT = readFileSync(new URL('./fixtures/frontier-expedition-depart-prepare-wallet-payer-rust.json', import.meta.url), 'utf8');
const rust = () => JSON.parse(RUST_TEXT);
const codeOf = fn => { try { fn(); return null; } catch (e) { return e.code ?? String(e); } };
const SEALED = Object.freeze({ commit: '01'.repeat(32), seal: 'a7'.repeat(264) });
const OTHER = 'B7yQBg4KBnypKx7TQRSaZFDD17hfhry5JN51dmz88rX3';

test('the real Rust report: this module rebuilds the request\'s roles, bytes and digest and accepts the report whole', () => {
  const report = rust(), request = report.request, { proposal, ...scope } = request;
  assert.equal(Buffer.byteLength(RUST_TEXT), 7767); assert.equal(createHash('sha256').update(RUST_TEXT).digest('hex'), 'eb6bfe3a34bb0aecc47cade1eeb5da3fd429b849fd181136c1aaab7fc70152e4', 'the real preparer\'s output, as generated');
  assert.deepEqual(DP.canonicalDepartProposal(scope), proposal);
  assert.deepEqual(DP.departPreparationRequestOf(request), request);
  const accepted = DP.departPreparationReport(report, request);
  assert.deepEqual(accepted, report); assert.ok(Object.isFrozen(accepted) && Object.isFrozen(accepted.prepared));
  for (const flag of DP.DEPART_PREPARE_CLOSED) assert.equal(accepted[flag], false, flag);
  assert.deepEqual(DP.DEPART_PREPARE_CLOSED.slice().sort(), ['admitted', 'automatic_send', 'deployment_verified', 'enqueued', 'ready', 'relay_submission_available', 'seal_verified', 'signed']);
  assert.deepEqual(accepted.not_proven, [...DP.DEPART_NOT_PROVEN]);
  assert.equal(DP.DEPART_PREPARE_PATH, '/f/expedition/depart/prepare');
});

test('a report that opens a flag, answers another request or restates any field or message byte is refused', () => {
  const request = rust().request, refuse = (v, want, label) => assert.equal(codeOf(() => DP.departPreparationReport(v, request)), want, label);
  for (const flag of DP.DEPART_PREPARE_CLOSED) { const v = rust(); v[flag] = true; refuse(v, 'UnsafeDepartPreparationReport', flag); }
  const cases = {
    BadDepartPreparationReport: [v => { v.host_only = false; }, v => { v.sendable = false; }, v => { v.status = 'ready'; }, v => { v.not_proven.pop(); }, v => { v.not_proven[4] = 'seal verified'; }, v => { v.blocker = { code: 'X' }; }],
    DepartPreparationRequestMismatch: [v => { v.request = null; }, v => { v.request.tip = '2504'; }, v => { v.request.request_id = 'depart-2'; }, v => { v.request.public_seal = `${v.request.public_seal.slice(0, -2)}a8`; }],
    BadDepartPreparationSource: [v => { v.source = null; }, v => { v.source.transit_slot_free = false; }, v => { v.source.coherent = false; }, v => { v.source.authority_verified = true; }, v => { v.source.unix_timestamp = 1; }],
    DepartPreparationSourceStale: [v => { v.source.context_slot = '79'; }],
    DepartPreparationArrival: [v => { v.source.arrive_bell = '16'; }, v => { v.source.current_bell = '14'; }],
    BadDepartPreparationBlockhash: [v => { v.blockhash = null; }, v => { v.blockhash.commitment = 'processed'; }, v => { v.blockhash.coherent = true; }, v => { v.blockhash.valid = false; }],
    DepartPreparationBlockhashContext: [v => { v.blockhash.latest_context_slot = '99'; }, v => { v.blockhash.height_min_context_slot = '102'; }],
    DepartPreparationBlockhashExpired: [v => { v.blockhash.last_valid_block_height = '201'; v.blockhash.remaining_block_heights = '1'; }, v => { v.blockhash.remaining_block_heights = '11'; }],
    DepartPreparationScopeMismatch: [v => { v.prepared.program = OTHER; }, v => { v.prepared.action = 'Return'; }, v => { v.prepared.fee_payer = v.request.wallet; }, v => { v.prepared.roles[2].writable = true; }, v => { v.prepared.proposal_digest = 'ab'.repeat(32); }, v => { v.prepared.signatures = []; }],
    DepartPreparationBudgetMismatch: [v => { v.prepared.budget.cu_price = '1'; }, v => { v.prepared.budget.heap = 1; }, v => { v.prepared.budget.cu_limit = 1400001; }, v => { v.prepared.budget.cu_limit = 200001; }, v => { v.prepared.budget.loaded_limit = 999999; }],
    DepartPreparationInstructionMismatch: [v => { v.prepared.instruction_hex = `daff0204${v.prepared.instruction_hex.slice(8)}`; }],
    DepartPreparationMessageDigest: [v => { v.prepared.message_digest = 'ab'.repeat(32); }, v => { v.prepared.message_b64 += '\n'; }, v => { v.prepared.message_b64 = '!!!!'; }],
    DepartPreparationMessageMismatch: [v => { v.blockhash.hash = OTHER; }],
    DepartPreparationSignerMismatch: [v => { v.prepared.signers.reverse(); }, v => { v.prepared.signers.push(OTHER); }],
    DepartPreparationShapeMismatch: [v => { v.prepared.shape.bytes = 907; }, v => { v.prepared.shape.writes = 4; }],
  };
  for (const [want, list] of Object.entries(cases)) list.forEach((mutate, i) => { const v = rust(); mutate(v); refuse(v, want, `${want} #${i}`); });
  // the message itself, with its digest restated so only its content differs
  const withMessage = mutate => { const v = rust(), b = Buffer.from(v.prepared.message_b64, 'base64'); mutate(b);
    v.prepared.message_b64 = b.toString('base64'); v.prepared.message_digest = createHash('sha256').update(b).digest('hex'); return v; };
  assert.deepEqual(DP.departPreparationReport(withMessage(() => {}), request), rust());
  const at = (b, needle) => { const i = b.indexOf(Buffer.from(needle)); assert.ok(i >= 0); return i; };
  for (const [name, mutate] of Object.entries({ 'one signer': b => { b[0] = 1; }, 'wallet writable': b => { b[1] = 0; }, 'read-only count': b => { b[2] += 1; }, 'fee payer': b => { b[4] ^= 1; },
    'compute limit': b => { b[at(b, [0x02, 0x40, 0x0d, 0x03, 0x00]) + 1] ^= 1; }, 'compute price': b => { b[at(b, [0x03, 0, 0, 0, 0, 0, 0, 0, 0]) + 1] = 1; },
    'dispatch kind': b => { b[at(b, [0xda, 0xff, 0x02, 0x00, 0xda, 0xff, 0x01, 0x06]) + 3] = 4; }, 'tip': b => { b[at(b, [0x0f, 0, 0, 0, 0xc7, 0x09]) + 4] ^= 1; },
    'last seal byte': b => { b[b.length - 1] ^= 1; }, 'role order': b => { const i = at(b, [0x09, 0x01, 0x00, 0x09, 0x03]); [b[i + 1], b[i + 2]] = [b[i + 2], b[i + 1]]; } }))
    assert.ok(codeOf(() => DP.departPreparationReport(withMessage(mutate), request))?.startsWith('DepartPreparation'), name);
  // a refusal is a closed report too
  const blocked = code => ({ ...rust(), status: 'blocked', source: null, blockhash: null, prepared: null, blocker: { code } });
  assert.equal(DP.departPreparationReport(blocked('TransitSlotBusy'), request).blocker.code, 'TransitSlotBusy');
  assert.equal(DP.departPreparationReport({ ...blocked('OutputTooLarge'), request: null }, request).request, null);
  for (const mutate of [v => { v.seal_verified = true; }, v => { v.prepared = rust().prepared; }, v => { v.blocker = { code: 'slot busy' }; }, v => { v.request.tip = '1'; }]) { const v = blocked('X'); mutate(v); assert.ok(codeOf(() => DP.departPreparationReport(v, request))); }
});

test('the former shape (no heap frame) is refused; the heap frame is exactly 256 KiB, once, fourth', () => {
  assert.equal(DP.DEPART_HEAP_FRAME, 262144);
  for (const [formerText, nowText, size] of [[FORMER_TEXT, RUST_TEXT, 9412], [FORMER_WALLET_PAYER_TEXT, WALLET_PAYER_TEXT, 9316]]) {
    const former = JSON.parse(formerText), now = JSON.parse(nowText);
    assert.equal(Buffer.byteLength(formerText), size, 'the former fixture is untouched');
    assert.equal(former.prepared.budget.heap, null); assert.equal(now.prepared.budget.heap, 262144);
    assert.deepEqual(former.request, now.request, 'the same request'); assert.equal(former.prepared.instruction_hex, now.prepared.instruction_hex, 'the same dispatch instruction');
    assert.deepEqual(DP.departPreparationRequestOf(former.request), former.request, 'the former REQUEST is still canonical');
    assert.equal(codeOf(() => DP.departPreparationReport(JSON.parse(formerText), former.request)), 'DepartPreparationBudgetMismatch', 'the former report is refused for its budget');
    assert.deepEqual(DP.departPreparationReport(JSON.parse(nowText), now.request), now, 'the present report is accepted');
    { const v = JSON.parse(formerText); v.prepared.budget.heap = 262144; assert.equal(codeOf(() => DP.departPreparationReport(v, former.request)), 'DepartPreparationMessageMismatch', 'the former message under a restated budget'); }
    for (const heap of [null, 0, 32768, 131072, 262143, 262145, '262144']) { const v = JSON.parse(nowText); v.prepared.budget.heap = heap; assert.equal(codeOf(() => DP.departPreparationReport(v, now.request)), 'DepartPreparationBudgetMismatch', `heap ${heap}`); }
    // messages compiled here from the fixture's own instructions, digest and shape restated
    const base = parseMessage(Buffer.from(now.prepared.message_b64, 'base64')), u32 = n => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
    const ix = base.instructions.map(i => ({ programId: i.programId, keys: i.keys, data: Buffer.from(i.data) }));
    const heapOf = bytes => ({ programId: COMPUTE_BUDGET_PROGRAM, keys: [], data: Buffer.concat([Buffer.from([1]), u32(bytes)]) });
    const report = instructions => { const v = JSON.parse(nowText), m = Buffer.from(compileMessage({ feePayer: base.accountKeys[0], recentBlockhash: base.recentBlockhash, instructions })), parsed = parseMessage(m), n = parsed.accountKeys.length;
      v.prepared.message_b64 = m.toString('base64'); v.prepared.message_digest = createHash('sha256').update(m).digest('hex');
      v.prepared.shape = { bytes: m.length + 1 + 64 * parsed.signers.length, locks: n, writes: n - parsed.header.numReadonlySignedAccounts - parsed.header.numReadonlyUnsignedAccounts, sigs: parsed.signers.length }; return v; };
    assert.equal(codeOf(() => DP.departPreparationReport(report(ix), now.request)), null, 'the same five instructions, recompiled, are accepted');
    const cases = { 'no heap frame': [ix[0], ix[1], ix[2], ix[4]], 'two heap frames': [ix[0], ix[1], ix[2], ix[3], ix[3], ix[4]], 'the heap frame first': [ix[3], ix[0], ix[1], ix[2], ix[4]],
      'the heap frame last': [ix[0], ix[1], ix[2], ix[4], ix[3]], 'a 32 KiB frame': [ix[0], ix[1], ix[2], heapOf(32768), ix[4]], 'a 128 KiB frame': [ix[0], ix[1], ix[2], heapOf(131072), ix[4]],
      'a sixth instruction': [...ix, { programId: COMPUTE_BUDGET_PROGRAM, keys: [], data: Buffer.from([2, 1, 0, 0, 0]) }], 'the dispatch twice': [ix[0], ix[1], ix[2], ix[3], ix[4], ix[4]] };
    for (const [name, instructions] of Object.entries(cases)) assert.ok(codeOf(() => DP.departPreparationReport(report(instructions), now.request))?.startsWith('DepartPreparation'), name);
  }
});

test('a request is the canonical one for its own public facts or it is not a request; a public seal is only looked at for its form', () => {
  const bad = mutate => { const r = rust().request; mutate(r); return codeOf(() => DP.departPreparationRequestOf(r)); };
  for (const mutate of [r => { r.sign = true; }, r => { delete r.tip; }, r => { r.deployment.program_version = '16388'; }, r => { r.transit_slot = '4'; }, r => { r.arrive_bell = '015'; },
    r => { r.proposal.roles[0].signer = false; }, r => { r.proposal.bytes_hex = `${r.proposal.bytes_hex.slice(0, -2)}a8`; }, r => { r.proposal.content_digest = 'ab'.repeat(32); },
    r => { r.tip = '2504'; }, r => { r.wallet = OTHER; }, r => { r.standing.p = '129'; }, r => { r.host = `01ff${r.host.slice(4)}`; }, r => { r.season = r.program; }])
    assert.equal(bad(mutate), 'BadDepartPreparationRequest');
  assert.equal(DP.publicSealOk(SEALED), true);
  for (const sealed of [null, undefined, {}, { commit: SEALED.commit }, { ...SEALED, key: 'x' }, { commit: '00'.repeat(32), seal: SEALED.seal }, { commit: SEALED.commit, seal: '00'.repeat(264) },
    { commit: SEALED.commit, seal: SEALED.seal.slice(2) }, { commit: 'AB'.repeat(32), seal: SEALED.seal }, { commit: SEALED.commit, seal: `27${SEALED.seal.slice(2)}` }, { commit: SEALED.commit, seal: `e7${SEALED.seal.slice(2)}` },
    { commit: new Uint8Array(32).fill(1), seal: SEALED.seal }]) assert.equal(DP.publicSealOk(sealed), false);
});

// ------------------------------------------------------------------ the run over a synthetic local boundary draft
const PROGRAM = encode(new Uint8Array(32).fill(94)), WALLET = encode(new Uint8Array(32).fill(65));
const A = seasonAddresses(PROGRAM, '1'), PIN = { programId: PROGRAM, cluster: 'localnet', seasonId: '1', addresses: A };
const OWNER = A.of('Citizen', { wallet: WALLET }), HOST = hostId({ p: 128, q: 0, site: 3, gen: 1, seq: 0 }).toString();
const acct = (kind, values) => decode(kind, encodeAccount(kind, { SEASON_ID: 1n, ...values }));
const SEASON = decode('Season', Buffer.from(JSON.parse(readFileSync(new URL('fixtures/frontier/season.json', import.meta.url), 'utf8')).bytes_b64, 'base64'));
/** The boundary fixture of web-frontier-expedition-compose.test.mjs on the host-only dispatch revision, with a reviewed draft (one step out, turn 44). */
function world({ programVersion = 18436 } = {}) {
  const h = acct('Holding', { P: 128, Q: 0, SITE: 3, GEN: 1, TILE: 60, STATE: 2, FACTION: 0, TIER: 1, HOST_SEQ: 1, OWNER_CITIZEN: fromB58(OWNER), RESERVE: [400, 0, 0, 0, 0, 0, 100, 0] });
  const province = acct('Province', { P: 128, Q: 0, RESOLVED_NEXT: 42, SITE_COUNT: 1, SITES: Uint8Array.of(60, ...new Array(11).fill(0)), PASSABLE_MASK: (1n << 61n) - 1n,
    SITE_MIRROR: [{ STATE: 1, GEN: 1, FACTION: 0, TIER: 1 }, ...Array.from({ length: 11 }, () => ({ STATE: 0 }))],
    ENTRIES: [{ ID: BigInt(HOST), FACTION: 0, UNIT: 0, TILE: 60, STATE: 1, TROOPS: 600000, STAMINA_VALUE: 120, STAMINA_BELL: 42 }] });
  const fs = { mode: 'play', sample: null, proto: null, season: { ...SEASON, seasonId: 1n, programVersion, rulesetHash: new Uint8Array(32).fill(1) },
    wallet: { address: WALLET }, resident: null, session: null, meStatus: 'ready', meAnswered: true,
    citizen: acct('Citizen', { WALLET: fromB58(WALLET), FACTION: 0, FLAGS: 5, TICKET_BELL: 0xffffffff, HOLDING: [{ P: 128, Q: 0, SITE: 3, GEN: 1 }, { GEN: 255 }, { GEN: 255 }] }), holdings: [h], activeHolding: 0,
    selected: { kind: 'tile', p: 128, q: 0, idx: 60 }, hand: { host: HOST, pop: OUTBOUND_POP }, nowBell: 42, chain: { now: () => 1000 }, provinces: new Map([['128,0', { province }]]),
    view: { lod: 'tile', fog: true }, land: { stage: 'final' }, marches: [], book: [], orders: [], compose: null };
  const ctx = { pin: PIN, relay: '/gw', source: {} };
  openOutbound(fs, ctx); editOutbound(fs, ctx, 'step', '0'); editOutbound(fs, ctx, 'arriveBell', '44');
  assert.equal(fs.expeditionCompose.status, 'review'); assert.equal(fs.expeditionCompose.review.roles.length, 9);
  return { fs, ctx, h, province };
}
/** Injected observation (conditions hold unless `ready`/`route` say otherwise) and relay; every wait is released by the test. */
function rig(w, { ready = { ok: true, code: null }, route = { ok: true, code: null, min: 44, max: 47, travelSecs: 120, wearBps: 0, stepIndex: null }, answer = null, holdRead = false, holdObserve = false } = {}) {
  const log = { observed: 0, asked: [], signals: [] }, gates = { read: [], observe: [] };
  const blocked = (request, code = 'TransitSlotBusy') => ({ ...rust(), status: 'blocked', request, source: null, blockhash: null, prepared: null, blocker: { code } });
  const options = { context: () => w.ctx, sealed: SEALED, requestId: 'run-1',
    snapshot: async source => { log.observed++; if (holdObserve) await new Promise(release => gates.observe.push(release));
      return { status: 'read', source, lands: [], season: w.fs.season, holdingBytes: null, clock: { unixTimestamp: 1000n }, contextSlot: '7', digest: 'ab'.repeat(32), coherent: true, contentConsistent: true }; },
    judge: () => ready, evaluate: () => route,
    read: async (request, { signal, relay }) => { log.asked.push({ request, relay }); log.signals.push(signal); if (holdRead) await new Promise(release => gates.read.push(release));
      return answer ? answer(request) : blocked(request); } };
  return { log, gates, options, blocked };
}
const tick = async (n = 12) => { for (let i = 0; i < n; i++) await Promise.resolve(); };

test('the run reads the departure conditions again, builds the request from the draft as it stands, and keeps a closed result', async () => {
  const w = world(), r = rig(w);
  const state = await DP.prepareOutboundDeparture(w.fs, r.options);
  assert.equal(r.log.observed, 1, 'a fresh read of source, village, terrain and clock before anything is asked');
  assert.equal(r.log.asked.length, 1); assert.equal(r.log.asked[0].relay, '/gw');
  const { request } = r.log.asked[0], s = w.fs.expeditionCompose;
  assert.deepEqual(DP.departPreparationRequestOf(request), request, 'what is sent is a canonical request');
  assert.equal(request.request_id, 'run-1'); assert.equal(request.min_slot, '7', 'the fresh observation\'s slot');
  assert.equal(request.arrive_bell, '44'); assert.equal(request.transit_slot, String(s.review.transitSlot)); assert.equal(request.tip, s.review.tip.lamports);
  assert.equal(request.wallet, WALLET); assert.equal(request.payer, WALLET); assert.equal(request.host, s.source.host); assert.deepEqual(request.standing, { p: '128', q: '0' });
  assert.equal(request.public_commit, SEALED.commit); assert.equal(request.public_seal, SEALED.seal);
  assert.deepEqual(request.proposal.roles, s.review.roles.map(x => ({ name: x.name, address: x.address, signer: x.signer, writable: x.writable })), 'the draft\'s own reviewed roles');
  assert.equal(state.status, 'blocked'); assert.equal(state.error, 'TransitSlotBusy'); assert.equal(state.report.prepared, null); assert.equal(state.request, request);
  for (const [k, v] of Object.entries(state)) if (!['status', 'error', 'request', 'report'].includes(k)) assert.equal(v, false, `${k} stays closed`);
  assert.ok('sendable' in state && 'signed' in state && 'seal_verified' in state);
  assert.equal(DP.departPreparationOf(w.fs, w.ctx), state, 'the same result is shown while nothing has changed');
  assert.equal(w.fs.session, null, 'no session was made');
});

test('without a public commit and seal the run stops before any read; a not-ready observation and the wrong revision stop before the relay', async () => {
  for (const sealed of [null, undefined, { commit: SEALED.commit, seal: '00'.repeat(264) }, { commit: SEALED.commit }]) {
    const w = world(), r = rig(w), state = await DP.prepareOutboundDeparture(w.fs, { ...r.options, sealed });
    assert.equal(state.status, 'error'); assert.equal(state.error, 'DepartSealUnavailable'); assert.equal(r.log.observed, 0); assert.equal(r.log.asked.length, 0);
  }
  const cases = [[{ ready: { ok: false, code: 'Cooldown' } }, {}, 'DepartObservationNotReady'], [{ route: { ok: false, code: 'RouteImpassable', min: null, max: null, travelSecs: null, wearBps: null, stepIndex: 0 } }, {}, 'DepartObservationUnavailable'],
    [{ route: { ok: false, code: 'ArrivalTooEarly', min: 46, max: 47, travelSecs: 120, wearBps: 0, stepIndex: null } }, {}, 'DepartObservationNotReady'], [{}, { programVersion: 16388 }, 'ExperimentalPreparationUnavailable']];
  for (const [rigOptions, worldOptions, want] of cases) {
    const w = world(worldOptions), r = rig(w, rigOptions), state = await DP.prepareOutboundDeparture(w.fs, r.options);
    assert.equal(state.status, 'error', want); assert.equal(state.error, want); assert.equal(r.log.observed, 1); assert.equal(r.log.asked.length, 0, 'the relay is not asked');
  }
  // an observation that could not be read at all
  const w = world(), r = rig(w), state = await DP.prepareOutboundDeparture(w.fs, { ...r.options, snapshot: async () => ({ status: 'blocked', code: 'ExpeditionPreviewDisabled' }) });
  assert.equal(state.error, 'DepartObservationUnavailable'); assert.equal(r.log.asked.length, 0);
  // no card, no draft
  const closed = world(); closed.fs.hand = { ...closed.fs.hand, pop: null };
  assert.equal((await DP.prepareOutboundDeparture(closed.fs, rig(closed).options)).error, 'DepartDraftUnavailable');
  // the pure builder refuses a draft with only a look-alike observation
  const fake = world(); fake.fs.expeditionCompose.contextCheck = { status: 'read', coherent: true, contentConsistent: true, contextSlot: '7', ready: { ok: true }, report: { ok: true, code: null, min: 44, max: 47 } };
  assert.equal(codeOf(() => DP.departPreparationRequest(fake.fs, { sealed: SEALED })), 'DepartObservationUnavailable');
});

test('an answer is kept only when it is a closed report for this very request', async () => {
  const cases = [[q => ({ ...rig(world()).blocked(q), seal_verified: true }), 'UnsafeDepartPreparationReport'], [q => ({ ...rig(world()).blocked(q), signed: true }), 'UnsafeDepartPreparationReport'],
    [q => rig(world()).blocked({ ...q, tip: '1' }), 'DepartPreparationRequestMismatch'], [() => rust(), 'DepartPreparationRequestMismatch'],
    [() => ({ status: 'prepared' }), 'BadDepartPreparationReport'], [() => null, 'BadDepartPreparationReport'], [() => { throw Object.assign(new Error('x'), { code: 'ExpeditionDepartPrepareDisabled' }); }, 'ExpeditionDepartPrepareDisabled'],
    [() => { throw new Error('offline'); }, 'DepartPreparationUnavailable']];
  for (const [answer, want] of cases) {
    const w = world(), r = rig(w, { answer }), state = await DP.prepareOutboundDeparture(w.fs, r.options);
    assert.equal(state.status, 'error', want); assert.equal(state.error, want); assert.equal(state.report, null);
  }
});

test('a result is for the draft, revision, observation, wallet, session, source and relay the run began with, or it is dropped', async () => {
  const changes = { 'another turn typed': w => { editOutbound(w.fs, w.ctx, 'arriveBell', '45'); }, 'a step added': w => { editOutbound(w.fs, w.ctx, 'step', '0'); },
    'the same turn typed again (a new revision)': w => { editOutbound(w.fs, w.ctx, 'arriveBell', '44'); }, 'the card closed': w => { clearOutbound(w.fs); w.fs.hand = { ...w.fs.hand, pop: null }; },
    'closed and reopened': w => { openOutbound(w.fs, w.ctx); editOutbound(w.fs, w.ctx, 'step', '0'); editOutbound(w.fs, w.ctx, 'arriveBell', '44'); },
    'another wallet object': w => { w.fs.wallet = { address: WALLET }; }, 'a session appeared': w => { w.fs.session = { publicKey: OTHER }; }, 'another relay': w => { w.ctx.relay = '/other'; },
    'another source': w => { w.ctx.source = {}; }, 'the turn moved on': w => { w.fs.nowBell++; }, 'the host changed': w => { w.province.entries[0].troops++; },
    'the observation was read again by hand': async w => { await inspectOutboundContext(w.fs, { context: () => w.ctx, snapshot: async source => ({ status: 'read', source, lands: [], season: w.fs.season, holdingBytes: null, clock: { unixTimestamp: 1000n }, contextSlot: '8', digest: 'cd'.repeat(32), coherent: true, contentConsistent: true }), judge: () => ({ ok: true, code: null }), evaluate: () => ({ ok: true, code: null, min: 44, max: 47, travelSecs: 120, wearBps: 0, stepIndex: null }) }); } };
  for (const [name, change] of Object.entries(changes)) {
    // while the relay is answering
    { const w = world(), r = rig(w, { holdRead: true }), run = DP.prepareOutboundDeparture(w.fs, r.options);
      await tick(); assert.equal(r.gates.read.length, 1, name); assert.equal(DP.departPreparationOf(w.fs, w.ctx).status, 'loading');
      await change(w); r.gates.read[0]();
      assert.equal(await run, null, `${name}: the late answer is not kept`); assert.equal(DP.departPreparationOf(w.fs, w.ctx).status, 'idle', name); }
    // after the result was kept
    { const w = world(), r = rig(w), state = await DP.prepareOutboundDeparture(w.fs, r.options);
      assert.equal(DP.departPreparationOf(w.fs, w.ctx), state); await change(w);
      assert.equal(DP.departPreparationOf(w.fs, w.ctx).status, 'idle', `${name}: a kept result is not shown for another draft`);
      assert.equal(DP.departPreparationOf(w.fs, w.ctx).report, null); }
  }
  // while the fresh observation is being read: a render in between does not end the run, a change does
  { const w = world(), r = rig(w, { holdObserve: true }), run = DP.prepareOutboundDeparture(w.fs, r.options);
    await tick(); assert.equal(DP.departPreparationOf(w.fs, w.ctx).status, 'reading'); assert.equal(DP.departPreparationOf(w.fs, w.ctx).status, 'reading');
    r.gates.observe[0](); assert.equal((await run).status, 'blocked'); assert.equal(r.log.asked.length, 1); }
  { const w = world(), r = rig(w, { holdObserve: true }), run = DP.prepareOutboundDeparture(w.fs, r.options);
    await tick(); w.fs.wallet = { address: WALLET }; r.gates.observe[0]();
    assert.equal(await run, null); assert.equal(r.log.asked.length, 0, 'the relay is never asked for a draft that changed during the read'); }
});

test('a second run supersedes the first: the first is aborted and keeps nothing', async () => {
  const w = world(), r = rig(w, { holdRead: true });
  const first = DP.prepareOutboundDeparture(w.fs, r.options); await tick();
  const second = DP.prepareOutboundDeparture(w.fs, { ...r.options, requestId: 'run-2' }); await tick();
  assert.equal(r.log.signals[0].aborted, true, 'the first request was aborted'); assert.equal(r.gates.read.length, 2);
  r.gates.read[0](); assert.equal(await first, null);
  assert.equal(DP.departPreparationOf(w.fs, w.ctx).status, 'loading', 'the first\'s late answer did not end the second');
  r.gates.read[1](); const state = await second;
  assert.equal(state.status, 'blocked'); assert.equal(state.request.request_id, 'run-2'); assert.equal(DP.departPreparationOf(w.fs, w.ctx), state);
  DP.clearDepartPreparation(w.fs); assert.equal(DP.departPreparationOf(w.fs, w.ctx).status, 'idle');
});

test('a callback that closes or starts another run at once (reading, loading, completion): the old run starts nothing, cancels nothing, returns nothing', async () => {
  for (const at of ['reading', 'loading', 'blocked']) {
    // --- the callback closes the card's preparation synchronously
    { const w = world(), r = rig(w); let fired = 0;
      const changed = () => { if (!fired && DP.departPreparationOf(w.fs, w.ctx).status === at) { fired++; DP.clearDepartPreparation(w.fs); } };
      const out = await DP.prepareOutboundDeparture(w.fs, { ...r.options, changed });
      assert.equal(fired, 1, at); assert.equal(out, null, `${at}: nothing is returned to the old caller`);
      assert.equal(r.log.observed, at === 'reading' ? 0 : 1, `${at}: no read is started after the close`);
      assert.equal(r.log.asked.length, at === 'blocked' ? 1 : 0, `${at}: no request is sent after the close`);
      assert.equal(DP.departPreparationOf(w.fs, w.ctx).status, 'idle'); }
    // --- the callback starts another run synchronously
    { const w = world(), old = rig(w), next = rig(w, { holdRead: true }); let fired = 0, second = null;
      const changed = () => { if (!fired && DP.departPreparationOf(w.fs, w.ctx).status === at) { fired++; second = DP.prepareOutboundDeparture(w.fs, { ...next.options, requestId: 'run-2' }); } };
      const first = await DP.prepareOutboundDeparture(w.fs, { ...old.options, changed });
      assert.equal(fired, 1, at); assert.equal(first, null, `${at}: the old caller is not handed the new run's state`);
      assert.equal(old.log.observed, at === 'reading' ? 0 : 1, `${at}: the old run reads nothing once superseded`);
      assert.equal(old.log.asked.length, at === 'blocked' ? 1 : 0, `${at}: the old run sends nothing once superseded`);
      await tick(40);
      assert.equal(next.log.observed, 1, `${at}: the new run's own read was not cancelled`); assert.equal(next.gates.read.length, 1, `${at}: and it reached the relay`);
      assert.equal(next.log.signals[0].aborted, false, `${at}: the new run's request is not aborted by the old run`);
      assert.equal(DP.departPreparationOf(w.fs, w.ctx).status, 'loading');
      next.gates.read[0](); const state = await second;
      assert.equal(state.status, 'blocked'); assert.equal(state.request.request_id, 'run-2'); assert.equal(DP.departPreparationOf(w.fs, w.ctx), state);
      assert.deepEqual(next.log.asked.map(x => x.request.request_id), ['run-2']); }
  }
  // the old run's request, when one was sent before it was superseded, was aborted with its own handle
  { const w = world(), old = rig(w, { holdRead: true }), next = rig(w); let fired = 0, second = null;
    const first = DP.prepareOutboundDeparture(w.fs, old.options); await tick(40); assert.equal(old.gates.read.length, 1);
    second = DP.prepareOutboundDeparture(w.fs, { ...next.options, requestId: 'run-2', changed: () => { fired++; } });
    assert.equal(old.log.signals[0].aborted, true); const state = await second; assert.equal(state.request.request_id, 'run-2'); assert.equal(next.log.signals[0].aborted, false);
    old.gates.read[0](); assert.equal(await first, null); assert.equal(DP.departPreparationOf(w.fs, w.ctx), state, 'the old answer arriving late changes nothing'); assert.ok(fired > 0); }
  // a callback that edits the draft at once: the run ends, the relay is not asked for the edited draft
  for (const at of ['reading', 'loading']) { const w = world(), r = rig(w); let fired = 0;
    const out = await DP.prepareOutboundDeparture(w.fs, { ...r.options, changed: () => { if (!fired && DP.departPreparationOf(w.fs, w.ctx).status === at) { fired++; editOutbound(w.fs, w.ctx, 'arriveBell', '45'); } } });
    assert.equal(out, null, at); assert.equal(r.log.asked.length, 0, at); assert.equal(DP.departPreparationOf(w.fs, w.ctx).status, 'idle'); }
});

const WALLET_PAYER_TEXT = readFileSync(new URL('./fixtures/frontier-expedition-depart-prepare-wallet-payer-heap256k-rust.json', import.meta.url), 'utf8');
/** A local boundary draft whose public facts are a fixture request's (wallet path): `{fs, ctx}`, or null when its Season id is not found. */
function draftOf(q) {
  let seasonId = null;
  for (let id = 0; id < 4096 && seasonId === null; id++) if (seasonAddresses(q.program, String(id)).season === q.season) seasonId = String(id);
  if (seasonId === null) return null;
  // the host reference: version, world, ring/wedge/pos (big-endian), site, generation, sequence
  const hb = Buffer.from(q.host, 'hex'), ring = hb.readBigUInt64BE(33), wedge = hb[41], pos = hb.readBigUInt64BE(42);
  let hp = ring - pos, hq = pos; for (let i = 0; i < wedge; i++) [hp, hq] = [-hq, hp + hq];
  const home = { p: Number(hp), q: Number(hq), site: hb[50], gen: hb[51], seq: hb.readUInt32LE(52) }, at = { p: Number(q.standing.p), q: Number(q.standing.q) };
  const A2 = seasonAddresses(q.program, seasonId), owner = A2.of('Citizen', { wallet: q.wallet }), id = hostId(home).toString();
  const account = (kind, values) => decode(kind, encodeAccount(kind, { SEASON_ID: BigInt(seasonId), ...values }));
  const h = account('Holding', { P: home.p, Q: home.q, SITE: home.site, GEN: home.gen, TILE: 60, STATE: 2, FACTION: 0, TIER: 1, HOST_SEQ: home.seq + 1, OWNER_CITIZEN: fromB58(owner), RESERVE: [400, 0, 0, 0, 0, 0, 100, 0] });
  const province = account('Province', { P: at.p, Q: at.q, RESOLVED_NEXT: 10, SITE_COUNT: 1, SITES: Uint8Array.of(60, ...new Array(11).fill(0)), PASSABLE_MASK: (1n << 61n) - 1n,
    SITE_MIRROR: [{ STATE: 1, GEN: home.gen, FACTION: 0, TIER: 1 }, ...Array.from({ length: 11 }, () => ({ STATE: 0 }))],
    ENTRIES: [{ ID: BigInt(id), FACTION: 0, UNIT: 0, TILE: 60, STATE: 1, TROOPS: 600000, STAMINA_VALUE: 120, STAMINA_BELL: 10 }] });
  const fs = { mode: 'play', sample: null, proto: null, season: { ...SEASON, seasonId: BigInt(seasonId), programVersion: 18436, rulesetHash: Uint8Array.from(Buffer.from(q.deployment.ruleset_hash, 'hex')) },
    wallet: { address: q.wallet }, resident: null, session: null, meStatus: 'ready', meAnswered: true,
    citizen: account('Citizen', { WALLET: fromB58(q.wallet), FACTION: 0, FLAGS: 5, TICKET_BELL: 0xffffffff, HOLDING: [{ P: home.p, Q: home.q, SITE: home.site, GEN: home.gen }, { GEN: 255 }, { GEN: 255 }] }), holdings: [h], activeHolding: 0,
    selected: { kind: 'tile', p: at.p, q: at.q, idx: 60 }, hand: { host: id, pop: OUTBOUND_POP }, nowBell: 10, chain: { now: () => 1000 }, provinces: new Map([[`${at.p},${at.q}`, { province }]]),
    view: { lod: 'tile', fog: true }, land: { stage: 'final' }, marches: [], book: [], orders: [], compose: null };
  const ctx = { pin: { programId: q.program, cluster: q.cluster, seasonId, addresses: A2 }, relay: '/gw', source: {} };
  openOutbound(fs, ctx); editOutbound(fs, ctx, 'step', '0'); editOutbound(fs, ctx, 'arriveBell', q.arrive_bell);
  return { fs, ctx };
}
/** The run's options for a draft of `q`: a fresh observation at `q.min_slot` whose conditions hold, the given relay answer. */
const runOf = (w, q, answer, log = { observed: 0, asked: [] }) => ({ log, options: { context: () => w.ctx, sealed: { commit: q.public_commit, seal: q.public_seal }, requestId: q.request_id,
  snapshot: async source => { log.observed++; return { status: 'read', source, lands: [], season: w.fs.season, holdingBytes: null, clock: { unixTimestamp: 1700006000n }, contextSlot: q.min_slot, digest: 'ab'.repeat(32), coherent: true, contentConsistent: true }; },
  judge: () => ({ ok: true, code: null }), evaluate: () => ({ ok: true, code: null, min: 0, max: 4294967295, travelSecs: 120, wearBps: 0, stepIndex: null }),
  read: async request => { log.asked.push(request); return answer(request); } } });
/** The fixture's tip in the draft: one of its own three choices when the test Season offers it, else the reviewed tip restated (returned as false). */
function tipOf(w, q) {
  const natural = ['standard', 'decisive', 'maximum'].find(tip => { editOutbound(w.fs, w.ctx, 'tip', tip); return w.fs.expeditionCompose.review.tip.lamports === q.tip; });
  if (!natural) { editOutbound(w.fs, w.ctx, 'tip', 'standard'); const s = w.fs.expeditionCompose; s.review = Object.freeze({ ...s.review, tip: Object.freeze({ id: 'standard', lamports: q.tip }) }); }
  return natural ?? false;
}

test('one whole run to `prepared` with the REAL wallet-payer Rust report: the draft\'s request is the fixture\'s, the report is accepted whole', async t => {
  assert.equal(Buffer.byteLength(WALLET_PAYER_TEXT), 7674); assert.equal(createHash('sha256').update(WALLET_PAYER_TEXT).digest('hex'), 'dcac5e3a1c22a0a18c7df48ff505f2248e4ee75df56b959b11453b4248b0a7d4', 'the real preparer\'s output, as generated');
  const want = JSON.parse(WALLET_PAYER_TEXT), q = want.request;
  assert.equal(q.payer, q.wallet, 'this fixture is the wallet path: the wallet is its own fee payer');
  assert.equal(want.status, 'prepared'); assert.deepEqual(DP.departPreparationReport(JSON.parse(WALLET_PAYER_TEXT), q), want, 'the pure inspection accepts it');
  assert.deepEqual(want.prepared.signers, [q.wallet]); assert.equal(want.prepared.shape.sigs, 1);
  const w = draftOf(q);
  if (!w) return t.skip('the fixture\'s Season id is not among 0..4095: the draft cannot be rebuilt here');
  assert.equal(w.fs.expeditionCompose.status, 'review', w.fs.expeditionCompose.error ?? '');
  const natural = tipOf(w, q);
  t.diagnostic(natural ? `the draft's own "${natural}" tip is the fixture's ${q.tip}` : `the test Season's tips differ from the fixture's ${q.tip}: the reviewed tip was restated for this test`);
  const r = runOf(w, q, () => JSON.parse(WALLET_PAYER_TEXT)), state = await DP.prepareOutboundDeparture(w.fs, r.options);
  assert.equal(r.log.observed, 1, 'the conditions were read again first'); assert.equal(r.log.asked.length, 1);
  assert.deepEqual(r.log.asked[0], q, 'the request built from the local draft is the Rust fixture\'s request, field for field: roles, inner bytes and digest');
  assert.equal(state.status, 'prepared', state.error ?? ''); assert.equal(state.error, null); assert.deepEqual(state.report, want); assert.deepEqual(state.request, q);
  for (const flag of DP.DEPART_PREPARE_CLOSED) assert.equal(state.report[flag], false, flag);
  for (const k of ['dispatch_available', 'executable', 'admitted', 'sealed', 'seal_verified', 'signed', 'enqueued', 'automatic_send', 'sendable']) assert.equal(state[k], false, `${k}: prepared is unsigned bytes, not a departure`);
  assert.equal(DP.departPreparationOf(w.fs, w.ctx), state); assert.equal(w.fs.session, null);
  // the split-payer report (another fee payer) is not an answer to this wallet's request, and the other way round
  assert.equal(codeOf(() => DP.departPreparationReport(rust(), q)), 'DepartPreparationRequestMismatch');
  assert.equal(codeOf(() => DP.departPreparationReport(JSON.parse(WALLET_PAYER_TEXT), rust().request)), 'DepartPreparationRequestMismatch');
  editOutbound(w.fs, w.ctx, 'arriveBell', String(Number(q.arrive_bell) + 1)); assert.equal(DP.departPreparationOf(w.fs, w.ctx).status, 'idle', 'and it is not shown for an edited draft');
});

test('a completion callback that edits the draft or closes the card (without clearing this module) gets no state back', async t => {
  const want = JSON.parse(WALLET_PAYER_TEXT), q = want.request;
  const acts = { 'the arrival turn edited': w => { editOutbound(w.fs, w.ctx, 'arriveBell', String(Number(q.arrive_bell) + 1)); }, 'a step added': w => { editOutbound(w.fs, w.ctx, 'step', '0'); },
    'clearOutbound': w => { clearOutbound(w.fs); }, 'the card closed': w => { clearOutbound(w.fs); w.fs.hand = { ...w.fs.hand, pop: null }; }, 'the hand\'s pop gone': w => { w.fs.hand = { ...w.fs.hand, pop: null }; },
    'another wallet object': w => { w.fs.wallet = { address: q.wallet }; }, 'another relay': w => { w.ctx.relay = '/other'; } };
  // a prepared completion (the real wallet-payer report) and a blocked one (the synthetic draft)
  for (const [name, act] of Object.entries(acts)) {
    const w = draftOf(q);
    if (!w) return t.skip('the fixture\'s Season id is not among 0..4095');
    tipOf(w, q);
    let fired = 0; const r = runOf(w, q, () => JSON.parse(WALLET_PAYER_TEXT));
    const changed = () => { if (!fired && DP.departPreparationOf(w.fs, w.ctx).status === 'prepared') { fired++; act(w); } };
    const out = await DP.prepareOutboundDeparture(w.fs, { ...r.options, changed });
    assert.equal(fired, 1, name); assert.equal(out, null, `${name}: the obsolete prepared state is not returned`);
    assert.equal(DP.departPreparationOf(w.fs, w.ctx).status, 'idle', `${name}: and is not shown`); assert.equal(DP.departPreparationOf(w.fs, w.ctx).report, null);
  }
  for (const act of [w => { editOutbound(w.fs, w.ctx, 'arriveBell', '45'); }, w => { clearOutbound(w.fs); w.fs.hand = { ...w.fs.hand, pop: null }; }]) {
    const w = world(), r = rig(w); let fired = 0;
    const out = await DP.prepareOutboundDeparture(w.fs, { ...r.options, changed: () => { if (!fired && DP.departPreparationOf(w.fs, w.ctx).status === 'blocked') { fired++; act(w); } } });
    assert.equal(fired, 1); assert.equal(out, null); assert.equal(DP.departPreparationOf(w.fs, w.ctx).status, 'idle');
  }
  // an error completion too
  { const w = world(), r = rig(w, { answer: () => null }); let fired = 0;
    const out = await DP.prepareOutboundDeparture(w.fs, { ...r.options, changed: () => { if (!fired && DP.departPreparationOf(w.fs, w.ctx).status === 'error') { fired++; editOutbound(w.fs, w.ctx, 'arriveBell', '45'); } } });
    assert.equal(fired, 1); assert.equal(out, null); assert.equal(DP.departPreparationOf(w.fs, w.ctx).status, 'idle'); }
  // a callback that changes nothing still gets the state
  { const w = world(), r = rig(w); let calls = 0; const out = await DP.prepareOutboundDeparture(w.fs, { ...r.options, changed: () => { calls++; } }); assert.equal(out.status, 'blocked'); assert.ok(calls >= 3); }
  // "no card": the refusal itself is still returned
  { const w = world(); w.fs.hand = { ...w.fs.hand, pop: null }; assert.equal((await DP.prepareOutboundDeparture(w.fs, rig(w).options)).error, 'DepartDraftUnavailable'); }
});

test('one whole run to `prepared`: a local wallet-path draft of the Rust fixture\'s public facts, a synthetic closed report as the relay\'s answer', async t => {
  const want = rust(), q = want.request;
  // The fixture's Season is the canonical address of some Season id under its program: find it (public derivation only).
  let seasonId = null;
  for (let id = 0; id < 4096 && seasonId === null; id++) if (seasonAddresses(q.program, String(id)).season === q.season) seasonId = String(id);
  if (seasonId === null) return t.skip('the fixture\'s Season id is not among 0..4095: the draft cannot be rebuilt here (the pure checks above still cover the report)');
  const A2 = seasonAddresses(q.program, seasonId), owner = A2.of('Citizen', { wallet: q.wallet }), id = hostId({ p: 128, q: 0, site: 1, gen: 2, seq: 0 }).toString();
  const account = (kind, values) => decode(kind, encodeAccount(kind, { SEASON_ID: BigInt(seasonId), ...values }));
  const h = account('Holding', { P: 128, Q: 0, SITE: 1, GEN: 2, TILE: 60, STATE: 2, FACTION: 0, TIER: 1, HOST_SEQ: 1, OWNER_CITIZEN: fromB58(owner), RESERVE: [400, 0, 0, 0, 0, 0, 100, 0] });
  const province = account('Province', { P: 128, Q: 0, RESOLVED_NEXT: 10, SITE_COUNT: 1, SITES: Uint8Array.of(60, ...new Array(11).fill(0)), PASSABLE_MASK: (1n << 61n) - 1n,
    SITE_MIRROR: [{ STATE: 1, GEN: 2, FACTION: 0, TIER: 1 }, ...Array.from({ length: 11 }, () => ({ STATE: 0 }))],
    ENTRIES: [{ ID: BigInt(id), FACTION: 0, UNIT: 0, TILE: 60, STATE: 1, TROOPS: 600000, STAMINA_VALUE: 120, STAMINA_BELL: 10 }] });
  const fs = { mode: 'play', sample: null, proto: null, season: { ...SEASON, seasonId: BigInt(seasonId), programVersion: 18436, rulesetHash: Uint8Array.from(Buffer.from(q.deployment.ruleset_hash, 'hex')) },
    wallet: { address: q.wallet }, resident: null, session: null, meStatus: 'ready', meAnswered: true,
    citizen: account('Citizen', { WALLET: fromB58(q.wallet), FACTION: 0, FLAGS: 5, TICKET_BELL: 0xffffffff, HOLDING: [{ P: 128, Q: 0, SITE: 1, GEN: 2 }, { GEN: 255 }, { GEN: 255 }] }), holdings: [h], activeHolding: 0,
    selected: { kind: 'tile', p: 128, q: 0, idx: 60 }, hand: { host: id, pop: OUTBOUND_POP }, nowBell: 10, chain: { now: () => 1000 }, provinces: new Map([['128,0', { province }]]),
    view: { lod: 'tile', fog: true }, land: { stage: 'final' }, marches: [], book: [], orders: [], compose: null };
  const ctx = { pin: { programId: q.program, cluster: q.cluster, seasonId, addresses: A2 }, relay: '/gw', source: {} };
  openOutbound(fs, ctx); editOutbound(fs, ctx, 'step', '0'); editOutbound(fs, ctx, 'arriveBell', q.arrive_bell);
  const s = fs.expeditionCompose;
  assert.equal(s.status, 'review', s.error ?? ''); assert.equal(s.source.host, q.host, 'the draft\'s host reference is the fixture\'s');
  // The fixture was prepared for a fee payer that is ANOTHER key than the acting wallet (two signers). The browser's
  // draft is the explicit wallet path: the wallet is its own fee payer. So the fixture's request cannot come from a
  // browser draft; every role that does not depend on the payer is nevertheless the fixture's, address and privilege.
  assert.notEqual(q.payer, q.wallet); assert.equal(s.source.payer, q.wallet);
  const plain = x => ({ address: x.address, name: x.name, signer: x.signer, writable: x.writable });
  assert.deepEqual(s.review.roles.slice(2).map(plain), q.proposal.roles.slice(2).map(plain), 'season, citizen, holding, both provinces, system and transit');
  assert.deepEqual(s.review.roles.slice(0, 2).map(plain), [{ address: q.wallet, name: 'actor', signer: true, writable: true }, { address: q.wallet, name: 'payer', signer: true, writable: true }]);
  // The tip: one of the draft's own three choices when the test Season offers the fixture's amount; otherwise the
  // reviewed draft is restated with the fixture's public amount (said in the test's output, never silently).
  const natural = ['standard', 'decisive', 'maximum'].find(tip => { editOutbound(fs, ctx, 'tip', tip); return fs.expeditionCompose.review.tip.lamports === q.tip; });
  if (!natural) { editOutbound(fs, ctx, 'tip', 'standard'); s.review = Object.freeze({ ...s.review, tip: Object.freeze({ id: 'standard', lamports: q.tip }) }); }
  t.diagnostic(natural ? `the draft's own "${natural}" tip is the fixture's ${q.tip}` : `the test Season's tips differ from the fixture's ${q.tip}: the reviewed tip was restated for this test`);
  const log = { observed: 0, asked: [] };
  const state = await DP.prepareOutboundDeparture(fs, { context: () => ctx, sealed: { commit: q.public_commit, seal: q.public_seal }, requestId: q.request_id,
    snapshot: async source => { log.observed++; return { status: 'read', source, lands: [], season: fs.season, holdingBytes: null, clock: { unixTimestamp: 1700006000n }, contextSlot: q.min_slot, digest: 'ab'.repeat(32), coherent: true, contentConsistent: true }; },
    judge: () => ({ ok: true, code: null }), evaluate: () => ({ ok: true, code: null, min: 12, max: 82, travelSecs: 120, wearBps: 0, stepIndex: null }),
    // SYNTHETIC answer: a closed report in the Rust report's exact shape for THIS request, its unsigned message
    // compiled by the web SDK (three budget instructions, then the dispatch). Not a keeper's output.
    read: async request => { log.asked.push(request); return synthetic(request); } });
  function synthetic(request) {
    const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
    const data = Buffer.from(`daff0200${request.proposal.bytes_hex}`, 'hex');
    const message = Buffer.from(compileMessage({ feePayer: request.payer, recentBlockhash: want.blockhash.hash, instructions: [
      { programId: COMPUTE_BUDGET_PROGRAM, keys: [], data: Buffer.concat([Buffer.from([2]), u32(200000)]) }, { programId: COMPUTE_BUDGET_PROGRAM, keys: [], data: Buffer.concat([Buffer.from([3]), Buffer.alloc(8)]) },
      { programId: COMPUTE_BUDGET_PROGRAM, keys: [], data: Buffer.concat([Buffer.from([4]), u32(1000000)]) },
      { programId: COMPUTE_BUDGET_PROGRAM, keys: [], data: Buffer.concat([Buffer.from([1]), u32(262144)]) },
      { programId: request.program, keys: request.proposal.roles.map(x => ({ pubkey: x.address, isSigner: x.signer, isWritable: x.writable })), data }] }));
    const m = parseMessage(message), n = m.accountKeys.length;
    return { ...want, request, prepared: { program: request.program, season: request.season, program_version: '18436', action: 'Depart', fee_payer: request.payer,
      budget: { cu_limit: 200000, cu_price: '0', loaded_limit: 1000000, heap: 262144 }, roles: request.proposal.roles, instruction_hex: data.toString('hex'),
      message_b64: message.toString('base64'), message_digest: createHash('sha256').update(message).digest('hex'), signers: [request.payer],
      shape: { bytes: message.length + 1 + 64, locks: n, writes: n - m.header.numReadonlySignedAccounts - m.header.numReadonlyUnsignedAccounts, sigs: 1 }, proposal_digest: request.proposal.content_digest } };
  }
  assert.equal(log.observed, 1); assert.equal(log.asked.length, 1);
  const sent = log.asked[0];
  // the request built from the local draft: the fixture's public facts, with the wallet as its own payer
  for (const k of ['schema', 'request_id', 'cluster', 'program', 'season', 'deployment', 'wallet', 'host', 'standing', 'transit_slot', 'arrive_bell', 'tip', 'public_commit', 'public_seal', 'min_slot']) assert.deepEqual(sent[k], q[k], k);
  assert.equal(sent.payer, q.wallet); assert.notEqual(sent.proposal.content_digest, q.proposal.content_digest, 'another payer is another proposal');
  assert.equal(sent.proposal.bytes_hex, q.proposal.bytes_hex, 'the inner bytes do not name the payer: they are the fixture\'s');
  assert.equal(state.status, 'prepared', state.error ?? ''); assert.equal(state.error, null); assert.deepEqual(state.request, sent);
  assert.deepEqual(state.report.prepared.signers, [q.wallet], 'one signer: the wallet that also pays'); assert.equal(state.report.prepared.shape.sigs, 1);
  assert.equal(state.report.prepared.fee_payer, q.wallet);
  // the Rust report itself, prepared for the other payer, is not an answer to this request
  assert.equal(codeOf(() => DP.departPreparationReport(rust(), sent)), 'DepartPreparationRequestMismatch');
  for (const flag of DP.DEPART_PREPARE_CLOSED) assert.equal(state.report[flag], false, flag);
  for (const k of ['dispatch_available', 'executable', 'admitted', 'sealed', 'seal_verified', 'signed', 'enqueued', 'automatic_send', 'sendable']) assert.equal(state[k], false, `${k}: prepared is unsigned bytes, not a departure`);
  assert.equal(DP.departPreparationOf(fs, ctx), state); assert.equal(fs.session, null);
  editOutbound(fs, ctx, 'arriveBell', '16'); assert.equal(DP.departPreparationOf(fs, ctx).status, 'idle', 'and it is not shown for an edited draft');
});

test('the request names the acting wallet as its own fee payer and no other; a draft whose payer is another key is refused', async () => {
  const w = world(), r = rig(w), state = await DP.prepareOutboundDeparture(w.fs, r.options);
  assert.equal(state.request.payer, state.request.wallet); assert.equal(state.request.wallet, WALLET);
  assert.equal(state.request.proposal.roles[0].address, state.request.proposal.roles[1].address, 'actor and payer are one account: it signs and pays');
  // (the relay prepares only for its one configured payer; another wallet is its ScopeMismatch, kept here as the relay's own code)
  const other = world(), o = rig(other, { answer: () => { throw Object.assign(new Error('x'), { code: 'ExpeditionDepartPrepareScopeMismatch' }); } });
  const refused = await DP.prepareOutboundDeparture(other.fs, o.options); assert.equal(refused.status, 'error'); assert.equal(refused.error, 'ExpeditionDepartPrepareScopeMismatch'); assert.equal(refused.report, null);
  const split = world(); await inspectOutboundContext(split.fs, { context: () => split.ctx, snapshot: rig(split).options.snapshot, judge: () => ({ ok: true, code: null }), evaluate: rig(split).options.evaluate });
  assert.equal(codeOf(() => DP.departPreparationRequest(split.fs, { sealed: SEALED })), null, 'the wallet path builds');
  split.fs.expeditionCompose.source = { ...split.fs.expeditionCompose.source, payer: OTHER };
  assert.ok(['DepartPayerUnavailable', 'DepartObservationUnavailable'].includes(codeOf(() => DP.departPreparationRequest(split.fs, { sealed: SEALED }))), 'a payer that is not the wallet is never put in a request');
});

test('the relay read: one bounded POST to the one path; an oversized, unreadable or refused answer is a code', async () => {
  const request = rust().request, calls = [];
  const response = (body, { ok = true, status = 200, length = null } = {}) => { const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body; let sent = false;
    return { ok, status, headers: { get: k => (k === 'content-length' ? length : null) }, body: { getReader: () => ({ read: async () => (sent ? { done: true } : (sent = true, { done: false, value: bytes })), cancel: async () => {}, releaseLock() {} }) } }; };
  const fetch = answer => async (url, init) => { calls.push({ url, init }); return answer; };
  assert.deepEqual(await DP.readDepartPreparation(request, { relay: 'http://127.0.0.1:41020/gw/', fetch: fetch(response(RUST_TEXT)) }), rust());
  assert.equal(calls[0].url, 'http://127.0.0.1:41020/gw/f/expedition/depart/prepare'); assert.equal(calls[0].init.method, 'POST'); assert.equal(calls[0].init.credentials, 'omit');
  assert.deepEqual(JSON.parse(calls[0].init.body), request); assert.deepEqual(calls[0].init.headers, { 'Content-Type': 'application/json' });
  const refused = async (options, want) => assert.equal(await DP.readDepartPreparation(request, { relay: '/gw', ...options }).then(() => null, e => e.code), want);
  await refused({ relay: '' }, 'NoRelay');
  await refused({ fetch: fetch(response('{}', { length: String(64 * 1024 + 1) })) }, 'DepartPreparationReportTooLarge');
  await refused({ fetch: fetch(response(new Uint8Array(64 * 1024 + 1).fill(32))) }, 'DepartPreparationReportTooLarge');
  await refused({ fetch: fetch(response('not json')) }, 'BadDepartPreparationReport');
  await refused({ fetch: fetch(response('{"error":"x","code":"ExpeditionDepartPrepareBusy"}', { ok: false, status: 429 })) }, 'ExpeditionDepartPrepareBusy');
  await refused({ fetch: fetch(response('{"code":"not a code!"}', { ok: false, status: 502 })) }, 'HTTP502');
  await refused({ fetch: fetch(response(RUST_TEXT)), isCurrent: () => false }, 'DepartPreparationSuperseded');
  const gone = new AbortController(); gone.abort(); await refused({ fetch: fetch(response(RUST_TEXT)), signal: gone.signal }, 'DepartPreparationSuperseded');
  await refused({ fetch: () => new Promise(() => {}), timeoutMs: 20 }, 'DepartPreparationTimeout');
  await refused({ fetch: fetch(response(RUST_TEXT)), timeoutMs: 30_001 }, 'BadDepartPreparationTimeout');
});

test('the module is pure web SDK: no wallet, signer, seal maker, key or send API, and it changes no existing file\'s exports', () => {
  const src = readFileSync(new URL('../../permutation-server/web/frontier/fexpedition-depart-prepare.mjs', import.meta.url), 'utf8');
  const code = src.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  assert.deepEqual([...code.matchAll(/from '([^']+)'/g)].map(m => m[1]).sort(), ['../sdk/base58.mjs', '../sdk/bytes.mjs', '../sdk/sha256.mjs', '../sdk/solana-tx.mjs', './faddr.mjs', './fexpedition-compose.mjs', './fexpedition-depart.mjs']);
  assert.doesNotMatch(code, /signTransaction|signMessage|sendTransaction|sendRawTransaction|secretKey|privateKey|keyFromSeed|localStorage|sealMarch|new Worker|crypto\.subtle|wallet\.connect/);
  assert.deepEqual(Object.keys(DP).sort(), ['DEPART_HEAP_FRAME', 'DEPART_NOT_PROVEN', 'DEPART_PREPARE_CLOSED', 'DEPART_PREPARE_MAX_REPORT_BYTES', 'DEPART_PREPARE_MAX_REQUEST_BYTES', 'DEPART_PREPARE_PATH', 'DEPART_PREPARE_PROGRAM_VERSION',
    'DEPART_PREPARE_REPORT_SCHEMA', 'DEPART_PREPARE_REQUEST_SCHEMA', 'DEPART_PREPARE_TIMEOUT_MS', 'DEPART_SEAL_BYTES', 'canonicalDepartProposal', 'clearDepartPreparation', 'departPreparationOf',
    'departPreparationReport', 'departPreparationRequest', 'departPreparationRequestOf', 'prepareOutboundDeparture', 'publicSealOk', 'readDepartPreparation']);
});
