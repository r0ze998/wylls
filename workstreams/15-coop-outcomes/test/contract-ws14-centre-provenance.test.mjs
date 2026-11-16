// readCentreFacts: 'snapshot' only for a re-checked herald fold position (Lane C, 2026-11-17).
// WRITTEN, NOT RUN. A pure file: it imports only node:test, node:assert/strict and ../src/adapters/ws14-centre.mjs
// (which imports ./s1-chain.mjs and nothing else). Hand-made documents only; no fixture file, server, process,
// network or key. The herald writes /h/status `foldedThrough` and `lastSlot` as JSON numbers from u64 and `events` as
// the u64 in a decimal string (frontier-node/crates/herald/src/server.rs, read, not imported here).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readCentreFacts } from '../src/adapters/ws14-centre.mjs';

const ST = (events = '900', lastSlot = 5000, foldedThrough = 4) => ({ v: 1, foldedThrough, events, lastSlot, alarms: { rewrites: 0 } });
const DOC = (before, after, stable = true, from = 'herald /h/status') => ({
  schema: 'wylls.ws14.centre-facts/1', refused: null, observedAt: 'hand-made', facts: [],
  provenance: { from, before, after, stable, why: 'producer\'s reason', slotCommitment: 'not stated by the herald' },
});
const between = r => {
  assert.equal(r.status, 'between', JSON.stringify(r.reasons));
  assert.match(r.reasons[0], /not taken as a snapshot/);
  assert.equal(r.counted, false);
};

test('herald-shaped, equal reads stated stable are a snapshot', () => {
  const r = readCentreFacts(DOC(ST(), ST()));
  assert.equal(r.status, 'snapshot');
  assert.deepEqual(r.reasons, []);
  assert.equal(r.counted, false);
  assert.equal(readCentreFacts(DOC(ST('0', 0, 0), ST('0', 0, 0))).status, 'snapshot', 'zero is a position');
  assert.equal(readCentreFacts(DOC(ST('18446744073709551615'), ST('18446744073709551615'))).status, 'snapshot', 'u64::MAX is a position');
});

test('stable: true with a missing read or a missing or mistyped fold field is not a snapshot', () => {
  between(readCentreFacts(DOC(null, ST())));
  between(readCentreFacts(DOC(ST(), undefined)));
  between(readCentreFacts(DOC({ v: 1 }, { v: 1 })));
  const S = ST();
  for (const bad of [
    { ...S, foldedThrough: undefined }, { ...S, foldedThrough: '4' }, { ...S, foldedThrough: -1 }, { ...S, foldedThrough: 1.5 }, { ...S, foldedThrough: 2 ** 53 },
    { ...S, events: undefined }, { ...S, events: 900 }, { ...S, events: '0900' }, { ...S, events: '-1' }, { ...S, events: '9.5' }, { ...S, events: '' },
    { ...S, lastSlot: undefined }, { ...S, lastSlot: '5000' }, { ...S, lastSlot: -1 }, { ...S, lastSlot: null },
  ]) {
    between(readCentreFacts(DOC(bad, bad)));
    between(readCentreFacts(DOC(S, bad)));
    between(readCentreFacts(DOC(bad, S)));
  }
});

test('stable: true over reads that differ is not a snapshot', () => {
  between(readCentreFacts(DOC(ST('900'), ST('905'))));
  between(readCentreFacts(DOC(ST('900', 5000), ST('900', 5012))));
  between(readCentreFacts(DOC(ST('900', 5000, 4), ST('900', 5000, 5))));
});

test('events above u64::MAX is not a fold position, even when equal on both reads', () => {
  for (const events of ['18446744073709551616', '99999999999999999999', '100000000000000000000', '1'.repeat(40)]) {
    between(readCentreFacts(DOC(ST(events), ST(events))));
  }
});

test('unchanged: stable false or null is between with the producer\'s reason; no source is source_unknown', () => {
  for (const stable of [false, null]) {
    const r = readCentreFacts(DOC(ST(), ST(), stable));
    assert.equal(r.status, 'between');
    assert.deepEqual(r.reasons, ['producer\'s reason']);
  }
  const u = readCentreFacts(DOC(ST(), ST(), true, null));
  assert.equal(u.status, 'source_unknown');
});
