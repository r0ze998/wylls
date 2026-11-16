// provenanceOf: missing or invalid fold evidence is never a stable snapshot (Lane C, 2026-11-17).
// WRITTEN, NOT RUN. A pure file: it imports only node:test, node:assert/strict and ./centre.mjs (which imports
// ../proto/geometry.mjs and nothing else). Hand-made status values only; no server, process, file, network or key.
// The herald writes /h/status as `foldedThrough` and `lastSlot` JSON numbers from u64 and `events` as the u64 in a
// decimal string (frontier-node/crates/herald/src/server.rs, read, not imported here).
import test from 'node:test';
import assert from 'node:assert/strict';
import { provenanceOf } from './centre.mjs';

const STATUS = (n, slot) => ({ v: 1, foldedThrough: n, events: String(n * 3), lastSlot: slot, alarms: { rewrites: 0 } });

const unknown = p => {
  assert.equal(p.from, 'herald /h/status');
  assert.equal(p.stable, null, JSON.stringify(p));
  assert.notEqual(p.stable, true);
  assert.match(p.why, /no valid fold position/);
};

test('provenance: {v: 1} alone on both reads is not a snapshot', () => {
  unknown(provenanceOf({ before: { v: 1 }, after: { v: 1 } }));
});

test('provenance: a missing or mistyped fold field, on one read or both, is not a snapshot', () => {
  const S = STATUS(9, 77);
  for (const bad of [
    { ...S, foldedThrough: undefined }, { ...S, foldedThrough: '9' }, { ...S, foldedThrough: -1 }, { ...S, foldedThrough: 1.5 },
    { ...S, foldedThrough: null }, { ...S, foldedThrough: 2 ** 53 },
    { ...S, events: undefined }, { ...S, events: 27 }, { ...S, events: '027' }, { ...S, events: '-1' }, { ...S, events: '2.5' }, { ...S, events: '' },
    { ...S, lastSlot: undefined }, { ...S, lastSlot: '77' }, { ...S, lastSlot: -1 }, { ...S, lastSlot: null },
  ]) {
    unknown(provenanceOf({ before: bad, after: bad }));
    unknown(provenanceOf({ before: S, after: bad }));
    unknown(provenanceOf({ before: bad, after: S }));
  }
});

test('provenance: events above u64::MAX is not a fold position, even when equal on both reads', () => {
  const S = STATUS(9, 77);
  for (const events of ['18446744073709551616', '99999999999999999999', '100000000000000000000', '1'.repeat(40)]) {
    unknown(provenanceOf({ before: { ...S, events }, after: { ...S, events } }));
  }
  // u64::MAX itself is a position
  const top = { ...S, events: '18446744073709551615' };
  assert.equal(provenanceOf({ before: top, after: top }).stable, true);
});

test('provenance: the normal cases are unchanged', () => {
  assert.equal(provenanceOf({ before: STATUS(9, 77), after: STATUS(9, 77) }).stable, true);
  assert.equal(provenanceOf({ before: STATUS(9, 77), after: STATUS(10, 80) }).stable, false);
  assert.equal(provenanceOf({ before: STATUS(9, 77), after: STATUS(9, 78) }).stable, false, 'lastSlot moved');
  assert.equal(provenanceOf({ before: STATUS(0, 0), after: STATUS(0, 0) }).stable, true, 'zero is a position');
  const one = provenanceOf({ before: STATUS(9, 77), after: null });
  assert.equal(one.stable, false);
  assert.match(one.why, /only one/);
  const none = provenanceOf(null);
  assert.equal(none.from, null);
  assert.equal(none.stable, null);
});
