// What the owner can read of each decision (the integration round of
// 2026-10-23): every runner decision, paid or free, leaves one history line
// with who decided, what came of it, the model's own reason and the charge —
// a paid "rest" too; the view says who drives the village now and keeps the
// free autopilot standing in for the model apart from the owner's stop; the
// "result" trigger survives a history longer than the view's 50 lines; a
// policy names actions, so an action added to a group later is not allowed
// by an existing policy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Keypair } from '@solana/web3.js';
import { ACTION_GROUPS, AGENT_ACTIONS } from '../src/frontier/agent/contract.mjs';
import { normalisePolicy, checkAllowed } from '../src/frontier/agent/policy.mjs';
import { llmDecider, ruleDecider, runOnce, triggersOf } from '../src/frontier/agent/runner.mjs';
import { call, createAgent, delegate, deposit, ownerCommand, policy, relay, sound } from './agent-wallet-fixtures.mjs';
import { decisionText, driverModel, historyRows, parsePolicyForm, policyForm } from '../../permutation-server/web/frontier/fagent.mjs';

const post = (r, path, body) => call(r.public, 'POST', path, { body, ip: '127.0.0.1' });
const fakeLlm = answer => ({ alias: 'fake', async complete() { try { return { ok: true, content: await answer(), usage: { prompt_tokens: 50, completion_tokens: 8 } }; } catch (e) { return { ok: false, error: e.message, usage: null }; } } });
const decisions = view => view.history.filter(h => h.type === 'decision');

async function ready(r, { balance = 50_000n, p = policy(['economy']) } = {}) {
  const owner = Keypair.generate();
  const o = owner.publicKey.toBase58();
  const made = await createAgent(r, owner, { policy: p });
  if (balance > 0n) await deposit(r, o, made.agentId, balance);
  delegate(r, o, made.agentKey);
  await post(r, '/f/agent/command', ownerCommand(owner, 'mode', { agentId: made.agentId, params: { mode: 'auto' } }));
  return { owner, o, ...made };
}

test('every decision leaves one line: a paid rest with its reason, a model action, the autopilot standing in with its cause', async () => {
  const r = relay({ prices: { inference: '10000' } });
  const a = await ready(r, { balance: 20_000n });
  assert.deepEqual(r.gateway.view(a.agentId).driver, { state: 'waiting' }, 'auto, nothing decided yet');

  const rest = await runOnce(r.gateway, a.agentId, llmDecider({ llm: fakeLlm(() => JSON.stringify({ action: 'rest', fields: {}, reason: 'stores are low; wait for the harvest' })) }), { tick: 1 });
  assert.equal(rest.charged, '10000');
  let d = decisions(r.gateway.view(a.agentId));
  assert.equal(d.length, 1);
  assert.deepEqual([d[0].driver, d[0].outcome, d[0].charged, d[0].reason], ['model', 'rest', '10000', 'stores are low; wait for the harvest'], 'the paid rest says why');
  assert.equal(d[0].action, undefined);

  const act = await runOnce(r.gateway, a.agentId, llmDecider({ llm: fakeLlm(() => JSON.stringify({ action: 'Harvest', fields: {}, reason: 'collect' })) }), { tick: 2 });
  assert.equal(act.result.status, 'sent');
  d = decisions(r.gateway.view(a.agentId));
  assert.deepEqual([d[1].driver, d[1].outcome, d[1].action, d[1].charged, d[1].signature], ['model', 'sent', 'Harvest', '10000', act.result.signature]);
  assert.deepEqual(r.gateway.view(a.agentId).driver.state, 'model');

  // The balance is spent: the model cannot be paid for, the free autopilot plays and the view says why.
  const fb = await runOnce(r.gateway, a.agentId, llmDecider({ llm: fakeLlm(() => { throw new Error('never asked'); }) }), { tick: 3 });
  assert.equal(fb.charged, '0');
  d = decisions(r.gateway.view(a.agentId));
  assert.deepEqual([d[2].driver, d[2].cause, d[2].outcome, d[2].charged], ['autopilot', 'InsufficientBalance', 'sent', '0']);
  const drv = r.gateway.view(a.agentId).driver;
  assert.deepEqual([drv.state, drv.cause], ['autopilot', 'InsufficientBalance']);

  // A model failure is charged and the autopilot's turn carries the cause.
  await deposit(r, a.o, a.agentId, 10_000n);
  const failed = await runOnce(r.gateway, a.agentId, llmDecider({ llm: fakeLlm(() => 'not json') }), { tick: 4 });
  assert.equal(failed.charged, '10000');
  d = decisions(r.gateway.view(a.agentId));
  assert.deepEqual([d[3].driver, d[3].cause, d[3].charged, d[3].modelError], ['autopilot', 'InferenceFailed', '10000', 'model: not JSON']);

  // The owner's stop: the view says stopped, not autopilot; a decision is refused before any charge.
  await post(r, '/f/agent/command', ownerCommand(a.owner, 'mode', { agentId: a.agentId, params: { mode: 'manual' } }));
  assert.deepEqual(r.gateway.view(a.agentId).driver, { state: 'stopped' });
  const skipped = await runOnce(r.gateway, a.agentId, ruleDecider(), { tick: 5 });
  assert.equal(skipped.skipped, 'manual');
  assert.equal(decisions(r.gateway.view(a.agentId)).length, 4, 'nothing decided while stopped');
  // Back to auto: a new auto period starts with nothing decided in it.
  await post(r, '/f/agent/command', ownerCommand(a.owner, 'mode', { agentId: a.agentId, params: { mode: 'auto' } }));
  assert.deepEqual(r.gateway.view(a.agentId).driver, { state: 'waiting' });
  sound(r);
});

test('the free rule autopilot as the runner\'s decider is the autopilot, without a cause', async () => {
  const r = relay();
  const a = await ready(r);
  await runOnce(r.gateway, a.agentId, ruleDecider(), { tick: 1 });
  const d = decisions(r.gateway.view(a.agentId))[0];
  assert.deepEqual([d.driver, d.cause, d.charged, d.outcome], ['autopilot', undefined, '0', 'sent']);
  assert.deepEqual(r.gateway.view(a.agentId).driver.state, 'autopilot');
  assert.equal(r.gateway.view(a.agentId).driver.cause, undefined);
});

test('the result trigger reads the ledger\'s sequence, not the view\'s 50 lines', async () => {
  const r = relay();
  const a = await ready(r);
  // Fill the history past the view's 50 lines.
  for (let i = 0; i < 60; i++) r.gateway.ledger.recordDecision(a.agentId, { key: `k${i}`, by: 'autopilot', driver: 'autopilot', outcome: 'rest', charged: '0' });
  const v0 = r.gateway.view(a.agentId);
  assert.equal(v0.history.length, 50);
  const obs = { bell: 1, holding: 'h', province: 'p', citizen: 'c' };
  const last = { ...obs, policyVersion: v0.policy.version, modeEpoch: v0.modeEpoch, historyLength: v0.history.length, historySeq: v0.historySeq };
  assert.deepEqual(triggersOf(obs, v0, last), [], 'nothing new');
  // The owner (or an MCP caller) acts through the gateway: the view is still 50 lines long, the trigger still fires.
  r.gateway.ledger.recordAction(a.agentId, { name: 'Harvest', key: 'by-hand', source: 'browser', status: 'sent' });
  const v1 = r.gateway.view(a.agentId);
  assert.equal(v1.history.length, 50);
  assert.ok(v1.historySeq > v0.historySeq);
  assert.deepEqual(triggersOf(obs, v1, last), ['result']);
  // The agent's own action is not a result trigger.
  const last1 = { ...last, historySeq: v1.historySeq };
  r.gateway.ledger.recordAction(a.agentId, { name: 'Harvest', key: 'ai', source: 'ai', status: 'sent' });
  assert.deepEqual(triggersOf(obs, r.gateway.view(a.agentId), last1), []);
});

test('a policy names actions: an action added to a group later is not allowed by a policy saved before', () => {
  const saved = normalisePolicy({ allowed: ['economy'], budget: { total: '1', perDay: '1' } });
  assert.deepEqual(saved.allowed, [...ACTION_GROUPS.economy].sort());
  // A later build adds an action to the economy group (simulated): the saved policy is a list of names, not the group.
  const later = 'Fortify';
  assert.equal(AGENT_ACTIONS.includes(later), false);
  assert.throws(() => checkAllowed(saved, later), /not allowed/);
  // And a name the gateway does not know is refused even when a policy names it.
  assert.throws(() => checkAllowed({ allowed: [later] }, later), /not allowed/);
  assert.throws(() => normalisePolicy({ allowed: [later], budget: { total: '1', perDay: '1' } }), /unknown action/);
  // The conquest and founding actions stay never delegable.
  for (const n of ['DeclareSiege', 'FileOutpost', 'PlaceHome', 'SetSession', 'Join']) assert.throws(() => normalisePolicy({ allowed: [n], budget: { total: '1', perDay: '1' } }), /never be delegated/);
});

test('the page: decision lines, the driver sentence, the owner\'s call cap in the policy form', () => {
  const rest = decisionText({ driver: 'model', outcome: 'rest', charged: '10000' });
  assert.match(rest, /モデル/); assert.match(rest, /休み/); assert.match(rest, /判断料 0\.01/);
  const fb = decisionText({ driver: 'autopilot', cause: 'InsufficientBalance', outcome: 'sent', action: 'Harvest', charged: '0' });
  assert.match(fb, /無料の自動運転（残高が足りない）/); assert.match(fb, /Harvest を送信/); assert.match(fb, /無料/);
  const rows = historyRows({ history: [{ type: 'decision', at: 1, driver: 'model', outcome: 'sent', action: 'Build', charged: '10000', reason: '<b>x</b>' }] });
  assert.deepEqual([rows[0].kind, rows[0].category, rows[0].amount, rows[0].reason], ['decision', 'inference', '0.01', '<b>x</b>']);

  assert.equal(driverModel({ mode: 'manual', driver: { state: 'stopped' } }).state, 'stopped');
  assert.match(driverModel({ mode: 'manual', driver: { state: 'stopped' } }).text, /停止中/);
  const ap = driverModel({ mode: 'auto', driver: { state: 'autopilot', cause: 'DailyLimitReached' } });
  assert.match(ap.text, /停止ではありません/); assert.match(ap.text, /1日の上限/); assert.equal(ap.tone, 'warn');
  assert.equal(driverModel({ mode: 'auto' }).state, 'waiting', 'an older relay without driver');

  assert.equal(policyForm({ policy: { allowed: [], budget: { total: '1', perDay: '1', callsPerDay: 4 } } }).callsPerDay, '4');
  assert.equal(policyForm({ policy: { allowed: [], budget: { total: '1', perDay: '1' } } }).callsPerDay, '');
  const groups = { economy: true };
  assert.deepEqual(parsePolicyForm({ groups, total: '1', perDay: '0.5', callsPerDay: '12' }).policy.budget, { total: '1000000', perDay: '500000', callsPerDay: 12 });
  assert.deepEqual(parsePolicyForm({ groups, total: '1', perDay: '0.5', callsPerDay: '' }).policy.budget, { total: '1000000', perDay: '500000' }, 'blank: no cap');
  assert.equal(parsePolicyForm({ groups, total: '1', perDay: '0.5', callsPerDay: '-1' }).ok, false);
  assert.equal(parsePolicyForm({ groups, total: '1', perDay: '0.5', callsPerDay: '1.5' }).ok, false);
});
