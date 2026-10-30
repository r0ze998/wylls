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
  // 3. The end of transport is not a verified amount: never the plan's cargo as received, never 0, unless verified;
  //    and only for a caravan proven this request's own (its signature). The settle record's cargo is
  //    floor(milli / 1000): a lower bound, and a 0 there is not "nothing arrived".
  const mine = { by: 'test', signature: 's' };
  const settle = logged => ({ record: { kind: 'CARAVAN_SETTLED' }, cargoLogged: logged, precision: 'floor' });
  for (const to of ['vault:1,2,33', 'village:1,2,3']) {
    const a = port.arrival(op({ state: STATES.COMPLETED, outcome: 'delivered', planSummary: { to, cargo: { Stone: 100 } }, caravan: { seq: 0, ownerTag: '1', mine, settle: settle({ Stone: 97 }) } }));
    assert.equal(a.transportEnded, true);
    assert.ok(['unverified', 'verified'].includes(a.quantity.state));
    if (a.quantity.state === 'unverified') { assert.equal(a.quantity.received, undefined); assert.ok(a.quantity.basis); }
    else {
      assert.ok(a.quantity.received && a.quantity.basis, 'a verified amount names its evidence');
      assert.notDeepEqual(a.quantity.received, { Stone: 100 }, 'never the plan\'s cargo (the road wears it)');
      assert.deepEqual(a.quantity.received.atLeast, { Stone: 97 }, 'the record\'s lower bound, with its precision');
      assert.ok(a.quantity.received.precision);
    }
    // A record of 0: not "0 arrived".
    const z = port.arrival(op({ state: STATES.COMPLETED, outcome: 'delivered', planSummary: { to, cargo: { Stone: 1 } }, caravan: { seq: 0, ownerTag: '1', mine, settle: settle({}) } }));
    assert.notEqual(z.quantity.state, 'none');
    // Not proven this request's own: nothing claimed.
    const n = port.arrival(op({ state: STATES.COMPLETED, outcome: 'delivered', planSummary: { to, cargo: { Stone: 100 } } }));
    assert.equal(n.quantity.state, 'unverified');
  }
  assert.equal(port.arrival(op({ state: STATES.COMPLETED, outcome: 'lost', caravan: { seq: 0, ownerTag: '1', mine, settle: settle({}) } })).quantity.state, 'none');
  assert.equal(port.arrival(op({ state: STATES.COMPLETED, outcome: 'lost' })).quantity.state, 'unverified', 'lost, but not proven ours: not known to be nothing');
  for (const outcome of ['taken', 'burned']) {
    assert.notEqual(port.arrival(op({ state: STATES.COMPLETED, outcome, caravan: { seq: 0, ownerTag: '1', mine, raid: { choice: outcome, record: { kind: 'CARAVAN_RAIDED' } } } })).quantity.state, 'verified');
    assert.notEqual(port.arrival(op({ state: STATES.COMPLETED, outcome })).quantity.state, 'none', 'a raid without its own matching record is not known to be nothing');
  }
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
