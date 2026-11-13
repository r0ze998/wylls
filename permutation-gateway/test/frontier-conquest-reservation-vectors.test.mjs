// The reservation-region reader (conquest-reservations.mjs) against the RUST-GENERATED vectors
// docs/integration/CLAUDE-CONQUEST-RESERVATION-VECTORS-20261112.json (built through the real ABI codecs by
// frontier-abi/src/world_index/conquest_reservation_vectors_tests.rs; synthetic: no chain, world or key).
//
// What this establishes: the reader decodes a table the ABI codec wrote, record for record, and refuses the tables
// the ABI refuses. What it does NOT establish: anything about a real chain, the receipts' contents (their outcome
// bytes are committed only inside a digest and cannot be read from a receipt or log), or how a reservation ended.
// The file is read only; nothing is connected. Runs under the no-key guard.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as R from '../src/frontier/conquest-reservations.mjs';
import { siegeOrderModel } from '../../permutation-server/web/frontier/fconquest-order.mjs';

const V = JSON.parse(readFileSync(new URL('../../docs/integration/CLAUDE-CONQUEST-RESERVATION-VECTORS-20261112.json', import.meta.url), 'utf8'));
const hex = s => { assert.match(s, /^([0-9a-f]{2})*$/); return Uint8Array.from(s.match(/../g) ?? [], x => parseInt(x, 16)); };
const T = V.table, BYTES = hex(T.table_hex);

test('the vector file is the one expected: schema, synthetic, a 2688-byte table', () => {
  assert.equal(V.schema, 'wylls-conquest-reservation-vectors-v1');
  assert.equal(typeof V.synthetic, 'string');
  assert.equal(T.size, 2688); assert.equal(BYTES.length, R.CONQUEST_TABLE_SIZE);
  assert.equal(new DataView(BYTES.buffer).getUint32(R.NEXT_SEQ_OFFSET, true), T.next_reservation_seq);
});

test('the Rust-written table decodes record for record to the owner\'s expected values', () => {
  const got = R.decodeReservationRegion(BYTES);
  assert.equal(got.length, T.records.length);
  assert.deepEqual(got.map(r => ({ ...r })), T.records.map(r => r.fable_decoder_expected));
  // the same values against the vector's own raw fields (not only the "expected for Fable" block)
  for (const [i, r] of T.records.entries()) {
    const g = got[i];
    assert.equal(r.offset, R.RESERVATION_REGION_OFFSET + r.index * R.RESERVATION_RECORD_SIZE);
    assert.deepEqual([...BYTES.subarray(r.offset, r.offset + R.RESERVATION_RECORD_SIZE)], [...hex(r.record_hex)], `record ${r.index} bytes`);
    assert.deepEqual([g.index, g.status, g.site, g.entry, g.slot, g.faction, g.bell, g.seq, g.citizen, g.goldMilli, g.armsMilli, g.resourcesReturned, g.slotRentReleased],
      [r.index, r.status_name, r.site, r.entry, r.slot, r.faction, r.bell, r.seq, r.citizen_base58, r.gold_milli, r.arms_milli, r.resources_returned, r.slot_rent_released], `record ${r.index}`);
    assert.equal(g.status === 'pending', r.status === R.RES_PENDING);
    assert.equal(r.done, (r.resources_returned ? 1 : 0) | (r.slot_rent_released ? 2 : 0));
  }
  // free records are skipped, in the middle as well; the seq numbers have gaps and stay below the counter
  const used = got.map(r => r.index);
  for (const i of T.free_record_indices) assert.ok(!used.includes(i), `index ${i} is free`);
  assert.deepEqual([...used, ...T.free_record_indices].sort((a, b) => a - b), [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.ok(got.every(r => r.seq < T.next_reservation_seq));
  // a reservation that applied, and one whose return completed, have NO record: the reader says nothing of them
  const seqs = got.map(r => r.seq);
  assert.ok(!seqs.includes(T.applied_reservation_now_site_entry.former_seq), 'the applied one is a site entry now, not a record');
  assert.ok(!seqs.includes(T.fully_returned_seq_absent), 'the fully returned one is gone');
});

test('the tables the ABI refuses are refused here, with the expected code', () => {
  assert.ok(V.refused_tables.length >= 2);
  for (const t of V.refused_tables) {
    const bytes = hex(t.table_hex);
    assert.equal(bytes.length, 2688, t.name);
    assert.throws(() => R.decodeReservationRegion(bytes), { code: t.fable_decoder_expected_code }, `${t.name}: ${t.change}`);
  }
});

test('page facts from the Rust-written records: pending or not-applied with its owed parts; never how it ended, never a completed return', () => {
  const standing = T.province;
  for (const r of R.decodeReservationRegion(BYTES)) {
    const m = siegeOrderModel(R.reservationFacts(r, standing));
    assert.equal(m.ok, true, `seq ${r.seq}`);
    assert.deepEqual(m.standing, standing); assert.equal(m.site, r.site); assert.equal(m.orderBell, String(r.bell));
    if (r.status === 'pending') assert.deepEqual([m.phase, m.stake, m.slot, m.decidedBell], ['ordered', 'held', 'held', null]);
    else assert.deepEqual([m.phase, m.lapsed, m.source, m.decidedBell, m.stake, m.slot], ['not_applied', null, null, null, r.resourcesReturned ? 'returned' : 'held', r.slotRentReleased ? 'released' : 'held']);
    assert.equal(m.settled, false);
  }
});

test('the receipts carry no readable outcome: nothing here reads a lapse, a terminal close or an amount from them', () => {
  // the owner's statement, pinned: the outcome bytes are committed only inside the output digest
  assert.equal(typeof V.receipts.outcome_not_in_receipt, 'string');
  for (const x of [V.receipts.reserve, ...V.receipts.reservation_refund]) {
    assert.equal(x.receipt.outcome_byte, 0);
    // (named a PREIMAGE by the owner: a synthetic expected value, not something a receipt or a log yields)
    assert.match(x.outcome_preimage_hex, /^([0-9a-f]{2})+$/, 'the synthetic outcome preimage is present');
    assert.equal(x.outcome_hex, undefined); assert.equal(x.outcome_fields, undefined);
    assert.ok(!x.receipt.receipt_hex.includes(x.outcome_preimage_hex), 'the outcome bytes are not in the receipt');
    for (const part of ['declared', 'debited_wide_source', 'settled_or_pswr', 'credited_wide_source']) if (x[part]?.body_hex) assert.ok(!x[part].body_hex.includes(x.outcome_preimage_hex), `${part}: not in the event body`);
  }
  const src = readFileSync(new URL('../src/frontier/conquest-reservations.mjs', import.meta.url), 'utf8');
  // the legacy source family's vector is present (the real SBF fixture's source is Legacy); this reader does not read it
  assert.ok(V.receipts.legacy_source_ps2 !== undefined && V.receipts.legacy_source_ps2 !== null);
  for (const banned of ['outcome', 'receipt_hex', 'PSWR', 'terminal', 'legacy', 'ps2']) assert.ok(!src.split('\n').filter(l => !l.trimStart().startsWith('//')).join('\n').includes(banned), banned);
});
