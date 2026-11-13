// The WHOLE prepared report of a wide DeclareSiege as the Rust side produces it (frontier-node keeper
// `experimental_conquest_prepare` with `conquest-dispatch-experimental`, recorded by its own test into
// frontier-node/crates/keeper/tests/fixtures/conquest_declare_siege_report_v1.json), run through BOTH independent
// validators: the gateway's (src/frontier/conquest-prepare.mjs) and the page's
// (permutation-server/web/frontier/flocalplay-conquest.mjs). Public bytes only: no key, no network, no process.
//
// It shows the three sides agree on one message. It does not show the program accepts it: the fixture's accounts are
// the audited preview test's synthetic ones, and the heap frame is unconfirmed on the real program.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { conquestPrepareRequest, conquestPrepareReport, CONQUEST_DISPATCH_PINS } from '../src/frontier/conquest-prepare.mjs';
import { conquestPreparationReport, localConquestPrepared } from '../../permutation-server/web/frontier/flocalplay-conquest.mjs';
import { canonicalDeclareSiegeRoles, declareSiegeInstruction, DECLARE_SIEGE_DISPATCH } from '../../permutation-server/web/frontier/fconquest-identity.mjs';
import { parseMessage, COMPUTE_BUDGET_PROGRAM } from '../../permutation-server/web/sdk/solana-tx.mjs';
import { fromBase64, toHex } from '../../permutation-server/web/sdk/bytes.mjs';

const RUST = JSON.parse(readFileSync(new URL('../../frontier-node/crates/keeper/tests/fixtures/conquest_declare_siege_report_v1.json', import.meta.url), 'utf8'));
const REQUEST = RUST.request, WALLET = REQUEST.source_request.wallet;
const PINS = { fee_payer: WALLET, cu_limit: 400000, loaded_limit: 1048576, dispatch: CONQUEST_DISPATCH_PINS.DeclareSiege };
const clone = x => JSON.parse(JSON.stringify(x));

test('the Rust report is accepted whole by the gateway\'s validator and by the page\'s, for the same request', () => {
  assert.equal(RUST.status, 'prepared');
  // the request the Rust side echoed is a canonical request for both sides
  assert.deepEqual(conquestPrepareRequest(clone(REQUEST)), REQUEST);
  assert.deepEqual(conquestPrepareReport(clone(RUST), REQUEST, PINS), RUST);
  assert.deepEqual(conquestPreparationReport(clone(RUST), REQUEST), RUST);
  // and the page takes the relay's answer built around it
  const submit = { route: 'POST /f/local-play/conquest/submit', schema: 'frontier-local-play-conquest-submit-v1', message_digest: RUST.prepared.message_digest,
    last_valid_block_height: RUST.blockhash.last_valid_block_height, signer: WALLET };
  const prepared = localConquestPrepared({ report: clone(RUST), submit }, REQUEST);
  assert.equal(prepared.digest, RUST.prepared.message_digest); assert.equal(toHex(prepared.message), toHex(fromBase64(RUST.prepared.message_b64)));
});

test('what Rust built is what JavaScript derives: the twelve accounts, the wrapped instruction, the budget prefix with the heap frame, one signer', () => {
  const p = RUST.prepared, roles = canonicalDeclareSiegeRoles(REQUEST.source_request, REQUEST.target.site);
  assert.deepEqual(p.roles, roles.map(x => ({ ...x })), 'name, address, signer, writable of every position');
  assert.deepEqual(p.dispatch, { tag: DECLARE_SIEGE_DISPATCH.tag, kind: DECLARE_SIEGE_DISPATCH.kind }); assert.equal(p.budget.heap, DECLARE_SIEGE_DISPATCH.heap);
  assert.equal(p.instruction_hex, toHex(declareSiegeInstruction(REQUEST.target.site, REQUEST.target.entry)));
  const m = parseMessage(fromBase64(p.message_b64));
  assert.deepEqual(m.signers, [WALLET]); assert.equal(m.accountKeys[0], WALLET); assert.equal(m.recentBlockhash, RUST.blockhash.hash);
  assert.equal(m.instructions.length, 5, 'limit, zero price, loaded-data limit, the heap frame, then the one game instruction');
  assert.deepEqual(m.instructions.slice(0, 4).map(ix => [ix.programId === COMPUTE_BUDGET_PROGRAM, ix.keys.length, ix.data[0]]), [[true, 0, 2], [true, 0, 3], [true, 0, 4], [true, 0, 1]]);
  const game = m.instructions[4];
  assert.equal(game.programId, REQUEST.source_request.program); assert.equal(toHex(game.data), p.instruction_hex);
  assert.deepEqual(game.keys.map(k => k.pubkey), roles.map(r => r.address));
  // the report's context is the ONE snapshot's, and the blockhash is no older
  assert.ok(BigInt(RUST.source.context_slot) >= BigInt(REQUEST.source_context_slot)); assert.ok(BigInt(RUST.blockhash.latest_context_slot) >= BigInt(RUST.source.context_slot));
  for (const k of ['ready', 'deployment_verified', 'admitted', 'signed', 'enqueued', 'relay_submission_available', 'automatic_send']) assert.equal(RUST[k], false, k);
});

test('the same Rust report offered for another request, or altered, is refused by both validators', () => {
  const both = (v, request, pins = PINS) => {
    assert.throws(() => conquestPrepareReport(clone(v), request, pins), e => e.code === 'ConquestPrepareInvalidReport', 'gateway');
    assert.throws(() => conquestPreparationReport(clone(v), request), e => typeof e.code === 'string' && /Conquest/.test(e.code), 'page');
  };
  // for a request naming another site, entry, province or wallet's host (each is a canonical request of its own)
  for (const change of [r => { r.target.site = 2; }, r => { r.target.entry = 3; }, r => { r.source_request.standing = { p: '130', q: '0' }; }, r => { r.request_id = 'other'; }]) {
    const request = clone(REQUEST); change(request);
    both(RUST, request);
  }
  // altered claims and bytes
  for (const change of [v => { v.signed = true; }, v => { v.admitted = true; }, v => { v.prepared.dispatch.kind = 13; }, v => { v.prepared.dispatch.tag = 0xdc; }, v => { v.prepared.budget.heap = null; },
    v => { v.prepared.roles[8].address = v.prepared.roles[9].address; }, v => { v.prepared.roles[6].writable = true; }, v => { v.prepared.roles.pop(); }, v => { v.prepared.instruction_hex = 'daff020cdaff01050202'; },
    v => { v.prepared.message_digest = '00'.repeat(32); }, v => { v.prepared.signers.push(v.prepared.roles[2].address); }, v => { v.prepared.fee_payer = v.prepared.roles[2].address; },
    v => { v.prepared.action = 'SettleCapture'; }, v => { v.prepared.program_version = '16388'; }, v => { v.source.context_slot = '79'; }, v => { v.source.authority_verified = true; },
    v => { v.blockhash.remaining_block_heights = '1'; v.blockhash.last_valid_block_height = '201'; }, v => { v.prepared.shape.writes += 1; }, v => { v.host_only = false; }]) {
    const v = clone(RUST); change(v);
    both(v, REQUEST);
  }
  // the gateway's own pins: another fee payer, other limits, another dispatch than the pinned one
  for (const pins of [{ ...PINS, fee_payer: RUST.prepared.roles[2].address }, { ...PINS, cu_limit: 400001 }, { ...PINS, loaded_limit: 1048577 }, { ...PINS, dispatch: { tag: 0xda, kind: 13, heap: 256 * 1024 } }, { ...PINS, dispatch: { tag: 0xda, kind: 12, heap: null } }]) {
    assert.throws(() => conquestPrepareReport(clone(RUST), REQUEST, pins), e => e.code === 'ConquestPrepareInvalidReport');
  }
});
