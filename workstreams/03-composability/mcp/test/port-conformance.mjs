// What any RunReceipt port must do (src/receipt-port.mjs), the local MOCK adapter and ④'s future one alike.
// Inputs are this server's own operation records; the assertions are about what the port says from them.
import assert from 'node:assert/strict';
import { STATES, TERMINAL } from '../src/ports.mjs';

const op = (o = {}) => ({ id: 'op_0123456789abcdef01234567', requestId: 'req-port-0001', kind: 'caravan.send', linkId: 'lnk_a', state: STATES.REQUESTED,
  createdAt: '2026-10-30T00:00:00.000Z', updatedAt: '2026-10-30T00:00:00.000Z', planSummary: { from: 'vault:1,2,33', to: 'village:1,2,3', cargo: { Stone: 100 }, steps: 3, seq: 0 },
  caravan: { seq: 0, ownerTag: '1', arriveAt: null, outcome: null }, steps: [{ state: STATES.REQUESTED, at: '2026-10-30T00:00:00.000Z' }], attempts: 0, unknownSince: null, ...o });

export function portConformance(port) {
  // 1. The receipt names the operation, its state, and whether it is final; a port that is not ④'s says so.
  for (const state of Object.values(STATES)) {
    const r = port.receipt(op({ state, ...(state === STATES.FAILED ? { error: { code: 'X', message: 'x' } } : {}) }));
    assert.equal(r.operationId, 'op_0123456789abcdef01234567');
    assert.equal(r.requestId, 'req-port-0001');
    assert.equal(r.state, state);
    assert.equal(r.terminal, TERMINAL.includes(state));
    assert.equal(r.contract, port.contract);
    assert.equal(r.mock, !port.real, 'a receipt says whether it is a MOCK');
  }
  // 2. Sending is not arriving: no arrival before the end of transport.
  assert.equal(port.receipt(op({ state: STATES.PROCESSING })).arrival, undefined);
  // 3. The end of transport is not a verified amount: never the full cargo as received, never 0, unless verified.
  for (const to of ['vault:1,2,33', 'village:1,2,3']) {
    const a = port.arrival(op({ state: STATES.COMPLETED, outcome: 'delivered', planSummary: { to, cargo: { Stone: 100 } } }));
    assert.equal(a.transportEnded, true);
    assert.ok(['unverified', 'verified'].includes(a.quantity.state));
    if (a.quantity.state === 'unverified') { assert.equal(a.quantity.received, undefined); assert.ok(a.quantity.basis); }
    else assert.ok(a.quantity.received && a.quantity.basis, 'a verified amount names its evidence');
  }
  assert.equal(port.arrival(op({ state: STATES.COMPLETED, outcome: 'lost' })).quantity.state, 'none');
  for (const outcome of ['taken', 'burned']) assert.notEqual(port.arrival(op({ state: STATES.COMPLETED, outcome })).quantity.state, 'verified');
  // 4. A live connection has no cancellation; a revoked one stops new requests and lists what awaits reconciliation.
  assert.equal(port.cancellation({ linkId: 'lnk_a', revokedAt: null }, [op()]), null);
  const open = op({ id: 'op_open', state: STATES.ACCEPTED });
  const done = op({ id: 'op_done', state: STATES.COMPLETED, outcome: 'delivered' });
  const c = port.cancellation({ linkId: 'lnk_a', revokedAt: Date.parse('2026-10-30T01:00:00Z') }, [open, done]);
  assert.equal(c.newRequests, 'stopped');
  assert.deepEqual(c.awaitingReconciliation, ['op_open']);
  assert.equal(c.state, 'reconciling');
  assert.equal(port.cancellation({ linkId: 'lnk_a', revokedAt: 1 }, [done]).state, 'done');
  // 5. A held send stays visible as held, with its reason.
  const held = port.receipt(op({ hold: { code: 'CapabilityUnavailable', since: '2026-10-30T00:00:00.000Z' } }));
  assert.equal(held.state, STATES.REQUESTED);
  assert.equal(held.hold.code, 'CapabilityUnavailable');
}
