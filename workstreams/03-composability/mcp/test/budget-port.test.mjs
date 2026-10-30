// The boundary with ⑤: this server keeps no balance, hold or price; it shows ⑤'s view and passes ⑤'s refusals
// through with their code, naming whose decision each was. Every code here is checked against the gateway in use.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FIVE_NOT_FROM_ACTIONS, FIVE_REFUSALS, budgetOf, refusalOf } from '../src/budget-port.mjs';
import { client, connect, contract, server, world } from './fixture.mjs';

test('every ⑤ refusal code named here is one the gateway has, and every gateway code is accounted for', () => {
  const codes = new Set(Object.values(contract.ERR));
  for (const k of Object.keys(FIVE_REFUSALS)) assert.ok(codes.has(k), `${k} is not a code of ⑤'s gateway`);
  for (const k of FIVE_NOT_FROM_ACTIONS) assert.ok(codes.has(k), `${k} is not a code of ⑤'s gateway`);
  for (const k of codes) assert.ok(FIVE_REFUSALS[k] || FIVE_NOT_FROM_ACTIONS.includes(k), `⑤'s ${k} is not accounted for`);
  assert.deepEqual(refusalOf('SomethingNew').by, 'unknown', 'an unknown code is not guessed');
  assert.equal(refusalOf('BudgetExceeded').kind, 'budget');
  assert.match(refusalOf('InsufficientBalance').next, /never a tool/);
});

test('the budget shown is ⑤\'s as reported, nothing computed here', () => {
  const v = { balance: { available: '10', reserved: '2' }, policy: { budget: { perDay: '5' } }, day: { spent: '1' }, quota: { left: 3 } };
  assert.deepEqual(budgetOf(v), { source: 'agent wallet (GET /f/agent)', owner: '⑤', testAssetsOnly: true, balance: v.balance, policyBudget: v.policy.budget, day: v.day, quota: v.quota });
  assert.deepEqual(budgetOf(null).balance, null);
});

test('a refusal by ⑤ reaches the owner with its code and whose decision it was (policy without the transport group)', async () => {
  const w = await world({ allowed: ['economy'] });
  const s = await server(w);
  try {
    const m = client(s, (await connect(s, w)).access_token);
    const st = (await m.tool('get_village_status')).structuredContent;
    assert.equal(st.budget.owner, '⑤');
    const p = (await m.tool('prepare_caravan', { from: st.storehouses[0].placeId, to: st.village.placeId, cargo: { Stone: 10 } })).structuredContent;
    const r = await m.tool('send_caravan', { planId: p.planId, requestId: 'req-five-0001' });
    assert.equal(r.isError, true);
    assert.equal(r.structuredContent.error.code, 'ActionNotAllowed');
    assert.deepEqual([r.structuredContent.error.receipt.error.boundary.by, r.structuredContent.error.receipt.error.boundary.kind], ['⑤', 'policy']);
    assert.equal(w.r.chain.sent.length, 0);
  } finally { await s.close(); }
});
