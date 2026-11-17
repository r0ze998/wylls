// The PREPARED, NOT CONNECTED reader of the conquest table's reservation region (conquest-reservations.mjs).
//
// EVERY BYTE HERE IS WRITTEN BY THIS TEST from the provisional layout (SPEC §4.1). The Rust vectors are checked in
// frontier-conquest-reservation-vectors.test.mjs; this file covers the refusals and the facts mapping, so this
// proves the reader agrees with the document as read, NOT with the program. No RPC, no relay, no chain, no wallet;
// runs under the no-key guard.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import * as R from '../src/frontier/conquest-reservations.mjs';
import { siegeOrderModel } from '../../permutation-server/web/frontier/fconquest-order.mjs';
import { encode } from '../../permutation-server/web/sdk/base58.mjs';

const CITIZEN = n => new Uint8Array(32).fill(n);
/** One 128-byte record from fields, per the provisional layout. */
function record({ status = 1, site = 3, entry = 2, slot = 2, faction = 1, done = 0, bell = 41, seq = 0, citizen = CITIZEN(7), gold = 5000n, arms = 50000n } = {}) {
  const b = new Uint8Array(128), v = new DataView(b.buffer);
  b.set([status, site, entry, slot, faction, done]);
  v.setUint32(8, bell, true); v.setUint32(12, seq, true); b.set(citizen, 16); b.fill(9, 48, 104);
  v.setBigUint64(104, 1n, true); v.setBigUint64(112, gold, true); v.setBigUint64(120, arms, true);
  return b;
}
/** A table account's bytes: an opaque header and site entries, the seq counter, then the given records by index. */
function table(records = {}, next = 8) {
  const b = new Uint8Array(2688); b.fill(0xab, 0, 120); b.fill(0xcd, 128, 1664);
  new DataView(b.buffer).setUint32(120, next, true);
  for (const [i, r] of Object.entries(records)) b.set(r, 1664 + Number(i) * 128);
  return b;
}
const STANDING = { p: '-129', q: '0' };

test('used only by the read-only reservation read: two gateway modules import the reader, no page file does; a chain table is not claimed as checked', () => {
  assert.deepEqual(R.RESERVATION_LAYOUT_CHECKED, { abiCodecVector: true, chainTable: false });
  // (since the read route was wired: the family reader and the relay's read. Both are read-only and closed with the conquest routes)
  const USERS = ['conquest-table-read.mjs', 'local-play-conquest-orders.mjs'];
  for (const dir of ['../src/frontier/', '../../permutation-server/web/frontier/', '../../permutation-server/web/frontier/hud/']) {
    for (const f of readdirSync(new URL(dir, import.meta.url)).filter(f => f.endsWith('.mjs') && f !== 'conquest-reservations.mjs')) {
      const uses = readFileSync(new URL(dir + f, import.meta.url), 'utf8').includes('conquest-reservations');
      assert.equal(uses, dir === '../src/frontier/' && USERS.includes(f), `${dir}${f}`);
    }
  }
  const src = readFileSync(new URL('../src/frontier/conquest-reservations.mjs', import.meta.url), 'utf8');
  for (const banned of ['fetch', 'node:http', 'node:net', 'node:child_process', 'getAccountInfo', 'process.env', 'writeFile']) assert.ok(!src.includes(banned), banned);
});

test('reads the records the provisional layout describes: pending, each owed part, amounts, order', () => {
  assert.deepEqual(R.decodeReservationRegion(table()), []);
  const got = R.decodeReservationRegion(table({
    0: record({ seq: 4 }),
    2: record({ status: 2, done: 0, seq: 1, slot: 3, citizen: CITIZEN(8), bell: 40 }),
    5: record({ status: 2, done: 2, seq: 2, citizen: CITIZEN(9), site: 11, faction: 5, gold: 0xffff_ffff_ffff_ffffn, arms: 0n }),
    7: record({ status: 2, done: 1, seq: 7, citizen: CITIZEN(10) }),
  }));
  assert.deepEqual(got.map(r => [r.index, r.status, r.seq, r.resourcesReturned, r.slotRentReleased]),
    [[0, 'pending', 4, false, false], [2, 'not_applied', 1, false, false], [5, 'not_applied', 2, false, true], [7, 'not_applied', 7, true, false]]);
  assert.deepEqual(got[0], { index: 0, status: 'pending', site: 3, entry: 2, slot: 2, faction: 1, resourcesReturned: false, slotRentReleased: false, bell: 41, seq: 4, citizen: encode(CITIZEN(7)), goldMilli: '5000', armsMilli: '50000' });
  assert.deepEqual([got[2].site, got[2].faction, got[2].goldMilli, got[2].armsMilli], [11, 5, '18446744073709551615', '0']);
  assert.ok(Object.isFrozen(got) && Object.isFrozen(got[0]));
  // a record whose slot and rent are released no longer holds its (Citizen, slot): another may
  assert.equal(R.decodeReservationRegion(table({ 0: record({ status: 2, done: 2, seq: 0 }), 1: record({ seq: 1 }) })).length, 2);
});

test('refused: any table or record the layout does not allow', () => {
  const bad = (bytes, code) => assert.throws(() => R.decodeReservationRegion(bytes), { code });
  for (const b of [null, [], new Uint8Array(1664), new Uint8Array(2687), new Uint8Array(2689), Buffer.alloc(2688).toString('hex')]) bad(b, 'ReservationTableSize');
  { const b = table(); b[125] = 1; bad(b, 'ReservationTableReserved'); }
  { const r = record(); r[6] = 1; bad(table({ 0: r }), 'ReservationRecordReserved'); }
  { const r = record(); r[7] = 1; bad(table({ 0: r }), 'ReservationRecordReserved'); }
  for (const status of [0, 3, 255]) bad(table({ 0: record({ status }) }), 'ReservationRecordStatus');
  // PENDING with a done bit; NOT_APPLIED with both (the program frees it) or an unknown bit
  for (const done of [1, 2, 3]) bad(table({ 0: record({ status: 1, done }) }), 'ReservationRecordDone');
  for (const done of [3, 4, 128]) bad(table({ 0: record({ status: 2, done }) }), 'ReservationRecordDone');
  for (const more of [{ site: 12 }, { faction: 6 }, { slot: 0 }, { slot: 1 }, { slot: 4 }, { bell: 0 }, { citizen: CITIZEN(0) }]) bad(table({ 0: record(more) }), 'ReservationRecordField');
  bad(table({ 0: record({ seq: 8 }) }), 'ReservationRecordSeq');
  bad(table({ 0: record({ seq: 0 }) }, 0), 'ReservationRecordSeq');
  bad(table({ 0: record({ seq: 3 }), 1: record({ seq: 3, citizen: CITIZEN(8) }) }), 'ReservationRecordSeq');
  // one (Citizen, slot) among records that still hold it
  bad(table({ 0: record({ seq: 0 }), 1: record({ seq: 1 }) }), 'ReservationRecordSlot');
  bad(table({ 0: record({ status: 2, done: 1, seq: 0 }), 1: record({ seq: 1 }) }), 'ReservationRecordSlot');
});

test('the page facts from a record: only what the record says; how it ended and the source Holding only from the caller', () => {
  const [pending, owed, slotBack, resBack] = R.decodeReservationRegion(table({
    0: record({ seq: 0 }), 1: record({ status: 2, done: 0, seq: 1, citizen: CITIZEN(8) }), 2: record({ status: 2, done: 2, seq: 2, citizen: CITIZEN(9) }), 3: record({ status: 2, done: 1, seq: 3, citizen: CITIZEN(10) }) }));
  const model = (...a) => siegeOrderModel(R.reservationFacts(...a));
  // PENDING → ordered, at a negative province as well
  let m = model(pending, STANDING);
  assert.deepEqual([m.ok, m.phase, m.orderBell, m.decidedBell, m.stake, m.slot, m.settled, m.standing.p], [true, 'ordered', '41', null, 'held', 'held', false, '-129']);
  // NOT_APPLIED with no basis for how it ended: nothing of how, no turn
  m = model(owed, STANDING);
  assert.deepEqual([m.phase, m.lapsed, m.source, m.decidedBell, m.reason, m.stake, m.slot, m.settled], ['not_applied', null, null, null, null, 'held', 'held', false]);
  // the two owed parts, each alone: never settled
  m = model(slotBack, STANDING); assert.deepEqual([m.stake, m.slot, m.settled], ['held', 'released', false]);
  m = model(resBack, STANDING); assert.deepEqual([m.stake, m.slot, m.settled], ['returned', 'held', false]);
  // the caller's own VERIFIED reads (a state difference or a digest replay — not the receipt): a lapse, the turn's processing, the source Holding
  m = model(slotBack, STANDING, { lapsed: true, source: 'absent' }); assert.deepEqual([m.ok, m.lapsed, m.source, m.decidedBell, m.settled], [true, true, 'absent', null, false]);
  m = model(owed, STANDING, { lapsed: false, source: 'present' }); assert.deepEqual([m.ok, m.lapsed, m.decidedBell], [true, false, '41']);
  // refused: facts a record cannot carry
  const no = (code, ...a) => assert.throws(() => R.reservationFacts(...a), { code });
  no('ReservationFactsMore', pending, STANDING, { lapsed: true }); no('ReservationFactsMore', pending, STANDING, { source: 'absent' });
  no('ReservationFactsMore', resBack, STANDING, { source: 'absent' }); no('ReservationFactsMore', owed, STANDING, { lapsed: 'yes' }); no('ReservationFactsMore', owed, STANDING, { source: 'gone' });
  no('ReservationFactsRecord', null, STANDING); no('ReservationFactsRecord', { status: 'captured' }, STANDING); no('ReservationFactsStanding', owed, { p: -129, q: 0 });
  // no record is ever turned into a started siege, a capture, or a completed return
  for (const r of [pending, owed, slotBack, resBack]) for (const more of [{}, { lapsed: true }, { lapsed: false }]) {
    if (r === pending && more.lapsed !== undefined) continue;
    const x = model(r, STANDING, more); assert.ok(x.ok && ['ordered', 'not_applied'].includes(x.phase) && x.settled === false);
  }
});
