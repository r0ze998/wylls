// Workstream 02-rights: the off-chain half of the delegation boundary.
//   node --test workstreams/02-rights/tests/agent-policy-boundary.test.mjs
// The agent wallet's policy (permutation-gateway, unchanged) refuses Vote
// and every action outside AGENT_ACTIONS. The on-chain half is the program
// test `a_live_session_votes_though_the_agent_wallet_never_offers_vote`
// (permutation-frontier/src/proc/rights_tests.rs): the same session key,
// sent straight to the program, votes. Together they show that these
// limits hold only for requests that go through the operator's server.
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalisePolicy, checkAllowed } from '../../../permutation-gateway/src/frontier/agent/policy.mjs';
import { AGENT_ACTIONS, NEVER_DELEGATED } from '../../../permutation-gateway/src/frontier/agent/contract.mjs';

const budget = { total: '1000000', perDay: '100000' };

test('the agent wallet never offers Vote, nor a Grant instruction', () => {
  assert.ok(!AGENT_ACTIONS.includes('Vote'));
  assert.throws(() => normalisePolicy({ allowed: ['Vote'], budget }));
  const p = normalisePolicy({ allowed: ['economy', 'military', 'explore', 'vigil'], budget });
  for (const name of ['Vote', 'Propose', 'SendCaravan', 'BuildVault', 'ReserveSwap', 'IssueGrant']) {
    assert.throws(() => checkAllowed(p, name), /not allowed/, name);
  }
});

test('the budget is a test-USDC amount, not a bound on game resources', () => {
  const p = normalisePolicy({ allowed: ['economy'], budget });
  assert.deepEqual(Object.keys(p.budget).sort(), ['perDay', 'total']);
  // Nothing in the policy names ore, wood, arms, troops or a holding.
  assert.ok(!/ore|wood|arms|troop|holding/i.test(JSON.stringify(p)));
  assert.ok(NEVER_DELEGATED.includes('SetSession'));
});
