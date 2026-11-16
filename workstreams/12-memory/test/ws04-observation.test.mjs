// Workstream 4's read observation (`ws04-observation/0`, 4 @ 7baa4d93) as 12's HELD report (2026-11-17).
// SOURCE-ONLY when written: not run in the session that wrote it. Not listed in tools/keyfree-tests.txt yet.
// The page below is written by hand in the shape 4's serde gives (ObservedEvent: {kind, value}); it is not 4's output.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { heldFromWs04Observation, WS04_OBSERVATION_FORMAT, WS04_OBSERVATION_HELD, WS04_PAGE_HELD } from '../adapters/ws04-observation.mjs';
import { parseJsonU64 } from '../adapters/ws04-receipts.mjs';

const H = ['world_binding_unproven', 'finality_unproven', 'transaction_record_identity_unproven', 'committed_frame_unproven'];
const P = ['not_executor_receipts', 'source_provenance_unproven', 'resume_cursor_not_admitted'];
const sha = 'a'.repeat(64);
const settled = (over = {}) => ({ event_cursor: 7, archive_sequence: 3, ps2_ordinal: 0, signature: 'sig1', transaction_slot: 24, body_sha256: sha, local_locator: 'findex-row:3:0',
  event: { kind: 'caravan_settled', value: { key: { owner: '18446744073709551615', seq: 0 }, outcome: 0, dst: { kind: 2, p: 1, q: 0, at: 5, gen: 1 }, cargo: [0, 3, 0, 0, 0, 0, 0, 0], credited: null, slot: 24 } }, held: [...H], ...over });
const raided = { ...settled({ event_cursor: 8, ps2_ordinal: 1, signature: 'sig2', transaction_slot: 30 }), event: { kind: 'caravan_raided', value: { key: { owner: '119', seq: 1 }, choice: 0, raider: '5', taken: [0, 1, 0, 0, 0, 0, 0, 0], slot: 30 } } };
const PAGE = { format: 'ws04-observation/0', basis: 'unproven', world: null, finality: null, complete: null, observations: [settled(), raided], next_local_cursor: 8, held: [...P] };

test("4's page: every observation held, 4's reasons verbatim, nothing admitted", () => {
  assert.deepEqual([WS04_OBSERVATION_FORMAT, [...WS04_OBSERVATION_HELD], [...WS04_PAGE_HELD]], ['ws04-observation/0', H, P]);
  const r = heldFromWs04Observation(PAGE);
  assert.deepEqual([r.status, r.admitted, r.why, r.pageHeld], ['held', 0, [], P]);
  assert.deepEqual(r.observations.map(o => [o.kind, o.transaction_slot, o.held, o.why]), [['caravan_settled', 24, H, []], ['caravan_raided', 30, H, []]]);
  assert.equal(r.observations[0].triple, `sig1|0|${sha}`); assert.equal(r.observations[0].locator, 'findex-row:3:0');
  assert.ok(!('facts' in r) && !('receipts' in r) && !('id' in r.observations[0]), 'no fact, no receipt, no id');
});

test('a page that claims more is not believed: more reasons, never fewer, still held', () => {
  for (const [over, why] of [[{ basis: 'chain' }, 'ws04_observation_basis_chain_not_admitted'], [{ world: 'P/S' }, 'ws04_observation_claims_world_not_admitted'],
    [{ finality: 'finalized' }, 'ws04_observation_claims_finality_not_admitted'], [{ complete: true }, 'ws04_observation_claims_complete_not_admitted'],
    [{ complete: false }, 'ws04_observation_claims_complete_not_admitted'], [{ format: 'ws04-observation/1' }, 'ws04_observation_format:ws04-observation/1'],
    [{ held: P.slice(1) }, 'ws04_observation_page_held_missing:not_executor_receipts'], [{ held: 'x' }, 'ws04_observation_page_held_malformed']]) {
    const r = heldFromWs04Observation({ ...PAGE, ...over });
    assert.ok(r.why.includes(why), `${why}: ${r.why}`); assert.equal(r.status, 'held'); assert.equal(r.admitted, 0);
  }
  for (const bad of [null, [], 'x']) assert.equal(heldFromWs04Observation(bad).status, 'held');
});

test('an observation missing a reason, crediting, or carrying another slot is reported; none is admitted', () => {
  const r = heldFromWs04Observation({ ...PAGE, observations: [
    settled({ held: H.slice(0, 3) }),
    settled({ event: { ...settled().event, value: { ...settled().event.value, credited: [0, 3, 0, 0, 0, 0, 0, 0] } } }),
    settled({ event: { ...settled().event, value: { ...settled().event.value, slot: 99 } } }),
    settled({ event: { kind: 'caravan_sent', value: {} } }),
    settled({ body_sha256: 'xyz', transaction_slot: -1, signature: '' }),
    null,
  ] });
  assert.deepEqual(r.observations.map(o => o.why), [
    ['held_missing:committed_frame_unproven'], ['credited_present_not_admitted'], ['event_slot_not_the_transaction_slot'], ['event_kind:caravan_sent'],
    ['transaction_slot_malformed', 'signature_malformed', 'body_sha256_malformed'], ['observation_not_an_object']]);
  assert.equal(r.admitted, 0);
  const big = heldFromWs04Observation({ ...PAGE, observations: Array.from({ length: 300 }, () => settled()) });
  assert.ok(big.why.includes('ws04_observation_page_over_256')); assert.equal(big.observations.length, 256);
});

test('u64 owner tags stay exact when the page is read with parseJsonU64', () => {
  const text = JSON.stringify(PAGE).replace('"18446744073709551615"', '18446744073709551615');
  assert.equal(parseJsonU64(text).observations[0].event.value.key.owner, '18446744073709551615');
});

test('the source: no ingest, no receipt, no attestation, no coverage; observeLive keeps it beside the connection (pinned as text)', () => {
  const s = readFileSync(new URL('../adapters/ws04-observation.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(s, /^import /m, 'imports nothing');
  assert.doesNotMatch(s, /ingestReceipts\(|connectCanonical\(|receiptToFacts\(|coverageFromHistory\(|finalizedSlotFrom\(|\.observe\(|arrive_?(slot|ts)/);
  const live = readFileSync(new URL('../adapters/live-observation.mjs', import.meta.url), 'utf8');
  assert.match(live, /const ws04 = ws04Observation === undefined \? null : heldFromWs04Observation\(ws04Observation\);/);
  const call = live.slice(live.indexOf('const r = connectCanonical('), live.indexOf('const r = connectCanonical(') + 200);
  assert.doesNotMatch(call, /ws04/, 'never an input to the connection');
});

// (2026-11-17) Store mode (runexec `observe store`): epochs and pairing carried as given, or refused; never guessed.
test('store mode: epochs and the pairing facts are carried as given; malformed ones are refused, not guessed', () => {
  const epoch = { epoch: { from_seq: 1, source: 'rpc_poll', program_configured: 'P', commitment_requested: 'finalized' }, why: 'covered_by_epoch', pairing: 'same_directory_not_proof_of_same_archive' };
  const store = { same_directory: true, index_last_seq: 3, manifest_next_seq_before: 4, manifest_next_seq_after: 4, manifest_stable: true, generation: 'index_matches_manifest', limits: ['l'] };
  const page = { ...PAGE, held: [...P, 'store_pairing_is_not_a_snapshot_or_proof'], store, observations: [settled({ archive_sequence: 3, archive_epoch: epoch })] };
  const r = heldFromWs04Observation(page);
  assert.deepEqual(r.why, []);
  assert.deepEqual(r.observations[0].archive_epoch, epoch);
  assert.deepEqual(r.store, { ...store, unsafe: [] });
  assert.equal(r.admitted, 0); assert.deepEqual(r.observations[0].held, H);
  for (const bad of [{ ...epoch, why: 'guessed' }, { ...epoch, pairing: 'same_archive' }, { ...epoch, why: 'past_manifest_end' },
    { ...epoch, epoch: { ...epoch.epoch, from_seq: 4 } }, { ...epoch, epoch: { ...epoch.epoch, from_seq: 2 ** 53 } }, { ...epoch, epoch: { ...epoch.epoch, source: 5 } },
    { epoch: null, why: 'covered_by_epoch', pairing: epoch.pairing }, 'x']) {
    const o = heldFromWs04Observation({ ...page, observations: [settled({ archive_sequence: 3, archive_epoch: bad })] }).observations[0];
    assert.ok(o.why.includes('archive_epoch_malformed'), JSON.stringify(bad));
    assert.deepEqual(o.archive_epoch, { epoch: null, why: 'archive_epoch_malformed', pairing: 'same_directory_not_proof_of_same_archive' });
  }
  const unsafe = heldFromWs04Observation({ ...page, store: { ...store, index_last_seq: 2 ** 53 } });
  assert.equal(unsafe.store.index_last_seq, null); assert.deepEqual(unsafe.store.unsafe, ['index_last_seq']);
  for (const s of [{ ...store, same_directory: false }, { ...store, generation: 'same' }, { ...store, limits: 'l' }, null]) {
    const x = heldFromWs04Observation({ ...page, store: s });
    assert.ok(x.why.includes('ws04_observation_store_malformed')); assert.equal(x.store, null);
  }
  assert.ok(heldFromWs04Observation({ ...page, store: undefined }).why.includes('ws04_observation_store_mode_inconsistent'));
  assert.ok(heldFromWs04Observation({ ...page, observations: [settled()] }).why.includes('ws04_observation_store_mode_inconsistent'));
});

test('a plain page is reported as before (no store, no epochs), and an unsafe ordinal is never put into text', () => {
  const r = heldFromWs04Observation(PAGE);
  assert.ok(!('store' in r)); assert.ok(r.observations.every(o => !('archive_epoch' in o)));
  const big = heldFromWs04Observation({ ...PAGE, observations: [settled({ ps2_ordinal: 2 ** 53 + 2 })] }).observations[0];
  assert.equal(big.triple, null); assert.ok(big.why.includes('ps2_ordinal_malformed'));
});
