// ③'s operations in ④'s proposed vocabulary (④ HEAD 2e536b6b, CONTRACTS 0.2): a MOCK mapping, checked against
// ④'s own source when WS04_ROOT points at a tree that has workstreams/04-execution (skipped otherwise).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { WS04, Ws04MappedPort, assertReceiptPort, feesOf, receiptPortFor, ws04CancelPhase, ws04View } from '../src/receipt-port.mjs';
import { portConformance } from './port-conformance.mjs';

const base = { id: 'op_x', requestId: 'req-x', linkId: 'l', createdAt: 't', updatedAt: 't', steps: [], caravan: { seq: 4, ownerTag: '255' }, unknownSince: null };
const to = (k) => ({ planSummary: { from: 'vault:1,2,33', to: k === 'vault' ? 'vault:1,2,34' : 'village:1,2,3', cargo: { Stone: 100 } } });
const op = o => ({ ...base, ...to('village'), attempts: 1, ...o });

test('the mapped port is a MOCK that passes the port conformance; ④\'s real adapter is still not in this build', () => {
  const p = assertReceiptPort(receiptPortFor('ws04-mapped'));
  assert.ok(p instanceof Ws04MappedPort);
  assert.deepEqual([p.real, /mock/.test(p.contract)], [false, true]);
  portConformance(p);
  assert.throws(() => receiptPortFor('ws04'), /no adapter in this build/);
});

test('states, held reasons and outcomes follow ④\'s STATE-MACHINE for a ship-only run', () => {
  const v = o => ws04View(op(o));
  assert.equal(ws04View(op({ state: 'requested', attempts: 0 })).state, 'Accepted');
  assert.equal(v({ state: 'requested' }).state, 'ShipRequested');
  assert.equal(v({ state: 'accepted', gateway: { signature: 's' } }).state, 'ShipSubmitted');
  assert.equal(v({ state: 'processing', gateway: { signature: 's' } }).state, 'InTransit');
  const vault = ws04View({ ...op({ state: 'completed', outcome: 'delivered', gateway: { signature: 's' } }), ...to('vault') });
  assert.deepEqual([vault.state, vault.outcome.verification, vault.outcome.delivered, vault.outcome.cargo_logged], ['DeliveredUnverified', 'Unverifiable', null, { Stone: 100 }]);
  const village = v({ state: 'completed', outcome: 'delivered', gateway: { signature: 's' } });
  assert.deepEqual([village.state, village.outcome.verification, village.outcome.delivered], ['Fulfilled', 'RuleDerived', { Stone: 100 }]);
  for (const [outcome, reason] of [['lost', 'DestinationChanged'], ['taken', 'Raided'], ['burned', 'LostInTransit']]) {
    const x = v({ state: 'completed', outcome, gateway: { signature: 's' } });
    assert.deepEqual([x.state, x.reason, x.outcome.verification], ['Failed', reason, 'KnownZero']);
  }
  assert.equal(v({ state: 'requested', hold: { code: 'CapabilityUnavailable' } }).held_reason, 'PortUnavailable');
  assert.equal(v({ state: 'accepted', uncertain: true, unknownSince: 1 }).held_reason, 'Indeterminate');
  assert.equal(ws04View(op({ state: 'failed', attempts: 0, error: { code: 'GrantRevoked' } })).state, 'Cancelled');
  // Arrival through the port: the village's is verified by the rule, the storehouse's is not, a take is nothing.
  const p = new Ws04MappedPort();
  assert.deepEqual(p.arrival(op({ state: 'processing', outcome: 'delivered' })).quantity, { state: 'verified', received: { Stone: 100 }, basis: 'RuleDerived (④): a holding credits the whole cargo (Accrual::add has no cap)' });
  assert.equal(p.arrival({ ...op({ outcome: 'delivered' }), ...to('vault') }).quantity.state, 'unverified');
  assert.equal(p.arrival(op({ outcome: 'taken' })).quantity.state, 'none');
});

test('fees: never released (this server cannot prove absence); amounts are null, not 0', () => {
  const samples = [
    op({ state: 'requested', attempts: 0 }), op({ state: 'requested', unknownSince: 1, uncertain: true }), op({ state: 'accepted', gateway: { signature: 's' } }),
    op({ state: 'processing', gateway: { signature: 's' }, chain: { state: 'landed' } }), op({ state: 'failed', gateway: { signature: 's' }, chain: { state: 'failed' } }),
    op({ state: 'failed', error: { code: 'NotSent' }, unknownSince: 1, uncertain: true }), op({ state: 'accepted', chain: { state: 'expired', absenceProven: false }, unknownSince: 1, uncertain: true, gateway: { signature: 's' } }),
    op({ state: 'failed', error: { code: 'ActionNotAllowed' } }), op({ state: 'failed', gateway: { status: 'refused' } }),
  ];
  for (const s of samples) {
    const f = feesOf(s);
    assert.notEqual(f.category, 'released', JSON.stringify(s));
    assert.equal(f.lamports, null);
    if (f.category) assert.ok(WS04.fees.includes(f.category));
  }
  assert.equal(feesOf(samples[0]).category, null, 'no attempt, no fee');
  assert.equal(feesOf(samples[2]).category, 'reserved');
  assert.equal(feesOf(samples[3]).category, 'unconfirmed', 'landed: charged, amount not reported');
  assert.equal(feesOf(samples[5]).category, 'unconfirmed', 'NotSent proves no caravan, not no fee');
  assert.equal(feesOf(samples[7]).category, null, 'a clean refusal before signing costs nothing');
});

test('cancel phases: StoppingNew → AwaitingSigned (until unknown here) → Completed{effects} / Ineffective', () => {
  assert.deepEqual(ws04CancelPhase(op({ state: 'requested', attempts: 0 })), { phase: 'StoppingNew' });
  assert.deepEqual(ws04CancelPhase(op({ state: 'accepted', gateway: { signature: 's' } })), { phase: 'AwaitingSigned', until: null });
  assert.deepEqual(ws04CancelPhase(op({ state: 'processing' })), { phase: 'Ineffective', at: 'InTransit' });
  assert.deepEqual(ws04CancelPhase(op({ state: 'failed', error: { code: 'GrantRevoked' } })), { phase: 'Completed', effects: [] });
  assert.equal(ws04CancelPhase(op({ state: 'completed', outcome: 'delivered' })).effects.length, 2);
  const c = new Ws04MappedPort().cancellation({ revokedAt: 1 }, [op({ id: 'a', state: 'accepted', gateway: { signature: 's' } })]);
  assert.deepEqual([c.state, c.ws04.a.phase], ['reconciling', 'AwaitingSigned']);
});

const WS04_ROOT = process.env.WS04_ROOT ?? null;
const model = WS04_ROOT && path.join(WS04_ROOT, 'workstreams/04-execution/src/model.rs');
const store = WS04_ROOT && path.join(WS04_ROOT, 'workstreams/04-execution/src/store.rs');
test('the vocabulary is ④\'s own (against workstreams/04-execution/src at WS04_ROOT)', { skip: model && existsSync(model) ? false : 'set WS04_ROOT to a tree with ④\'s workstreams/04-execution' }, () => {
  const src = readFileSync(model, 'utf8');
  const variants = name => {
    const body = new RegExp(`pub enum ${name}\\s*\\{([\\s\\S]*?)\\n\\}`).exec(src)?.[1] ?? '';
    return body.split('\n').map(l => /^\s{4}([A-Z][A-Za-z]+)\b/.exec(l)?.[1]).filter(Boolean);
  };
  assert.deepEqual(variants('RunState'), WS04.states);
  assert.deepEqual(variants('CancelPhase'), WS04.cancel);
  assert.deepEqual(variants('Verification'), WS04.verification);
  // Held and failure reasons share one enum in ④ (the one that names WalletRequired).
  const reasons = /pub enum (\w+)\s*\{(?:(?!\n\})[\s\S])*?\bWalletRequired\b[\s\S]*?\n\}/.exec(src)?.[0];
  assert.ok(reasons, 'the reason enum is found');
  for (const h of [...WS04.held, 'DestinationChanged', 'Raided', 'LostInTransit']) assert.match(reasons, new RegExp(`\\n\\s{4}${h}\\b`));
  const fb = /pub struct FeeBook\s*\{([\s\S]*?)\n\}/.exec(readFileSync(store, 'utf8'))[1];
  assert.deepEqual([...fb.matchAll(/pub (\w+): u64/g)].map(m => m[1]), WS04.fees);
});
