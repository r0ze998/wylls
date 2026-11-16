// WRITTEN, NOT RUN (2026-11-17, under an execution pause): no part of this file has been executed. Run it only through
// the repository's key-free guard once runs are allowed again.
//
// prepare_caravan's confirm (the text the server instructions say to show before send_caravan) keeps the cost and the
// refusals that cost and warnings carry:
//   P1 a sendable plan: cargo, road time, no recall, raids; the transaction fee, rent and settle fee paid by the relay's
//      fee payer; the settle fee is not called the transaction fee; the agent-wallet price is not known — never free
//   P2 the three refusals: the same warning texts as before, their codes in confirm, the server checks again at send
//   P3 server.mjs prepare uses prepareNotice and returns cost.agentPrice; tools.mjs says what confirm carries
// KEY-FREE: imports confirm.mjs (no imports); reads server.mjs and tools.mjs as text (not imported).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { AGENT_PRICE_NOT_READ, prepareNotice } from '../src/confirm.mjs';

const plan = { from: 'village:1,2,0', to: 'vault:1,3,4', cargoNamed: { Stone: 300, Wood: 20 }, estimatedSecs: 1500, feeLamports: '50000' };
const ready = { policy: { allowed: ['SendCaravan'] }, mode: 'auto', delegation: { delegated: true } };

test('P1 a sendable plan', () => {
  const n = prepareNotice(plan, ready);
  assert.deepEqual([n.warnings, n.refusals], [[], []]);
  assert.match(n.confirm, /^Send a caravan from village:1,2,0 to vault:1,3,4 with 300 Stone, 20 Wood \(about 25 min on the road; it cannot be recalled and can be raided\)\./);
  assert.match(n.confirm, /The transaction fee, the caravan's account rent and a 50000-lamport settle fee \(held in the caravan for whoever settles it\) are paid by the relay's fee payer \(sponsored\)\./);
  assert.match(n.confirm, /An agent-wallet price for this action, if the relay sets one, is not known here/);
  assert.doesNotMatch(n.confirm, /\bfree\b|costs nothing|no cost|price is 0|settle fee is the transaction fee/i);
  assert.doesNotMatch(n.confirm, /would be refused/);
  assert.match(AGENT_PRICE_NOT_READ, /^not read by this server/);
  assert.doesNotMatch(AGENT_PRICE_NOT_READ, /\bfree\b|\b0\b/);
});

test('P2 the refusals reach confirm', () => {
  const n = prepareNotice(plan, { policy: { allowed: [] }, mode: 'manual', delegation: { delegated: false } });
  assert.deepEqual(n.refusals, ['ActionNotAllowed', 'AgentStopped', 'SessionNotDelegated']);
  assert.equal(n.warnings.length, 3);
  assert.match(n.warnings[0], /patch 0005/, 'play.test.mjs:95 pins this');
  assert.match(n.warnings[1], /^The agent is stopped \(manual\): send_caravan will be refused \(AgentStopped\)\.$/);
  assert.match(n.warnings[2], /^The village is not delegated to the agent on chain: send_caravan will be refused \(SessionNotDelegated\)\.$/);
  assert.match(n.confirm, /As things stand, send_caravan would be refused: ActionNotAllowed, AgentStopped, SessionNotDelegated \(see warnings\); the server checks again at send\./);
  assert.match(n.confirm, /cannot be recalled and can be raided/, 'play.test.mjs:78 pins this');
  // No delegation read: no delegation warning (as before).
  assert.deepEqual(prepareNotice(plan, { policy: { allowed: ['SendCaravan'] }, mode: 'auto' }).refusals, []);
});

test('P3 wired in prepare and described', () => {
  const server = readFileSync(new URL('../src/server.mjs', import.meta.url), 'utf8');
  assert.match(server, /const \{ confirm, warnings \} = prepareNotice\(plan, a\);/);
  assert.match(server, /paidBy: plan\.paidBy, agentPrice: AGENT_PRICE_NOT_READ \}/);
  assert.doesNotMatch(server, /const warnings = \[\];/);
  const tools = readFileSync(new URL('../src/tools.mjs', import.meta.url), 'utf8');
  assert.match(tools, /it also says who pays the network costs and the settle fee, that an agent-wallet price is not known here, and any refusal send_caravan would meet now/);
});
