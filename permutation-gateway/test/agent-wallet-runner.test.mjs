// The operator's runner (docs/agent-wallet/DESIGN.md §7): the autopilot
// plays free, a model is charged per call and falls back to the autopilot
// when it fails or cannot be paid for; a stopped agent is skipped; the
// scheduler ticks every agent in auto mode once per tick.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Keypair } from '@solana/web3.js';
import { AgentScheduler, BACKOFF_MAX_TICKS, CANDIDATES, decisionSchema, llmDecider, promptOf, ruleDecider, runOnce } from '../src/frontier/agent/runner.mjs';
import { call, createAgent, delegate, deposit, ownerCommand, policy, relay, sound } from './agent-wallet-fixtures.mjs';

const post = (r, path, body) => call(r.public, 'POST', path, { body, ip: '127.0.0.1' });

async function ready(r, { balance = 50_000n, policy: p = policy(['economy']) } = {}) {
  const owner = Keypair.generate();
  const o = owner.publicKey.toBase58();
  const made = await createAgent(r, owner, { policy: p });
  if (balance > 0n) await deposit(r, o, made.agentId, balance);
  delegate(r, o, made.agentKey);
  await post(r, '/f/agent/command', ownerCommand(owner, 'mode', { agentId: made.agentId, params: { mode: 'auto' } }));
  return { owner, o, ...made };
}

/** A llama-server stand-in: `answer(body)` → the content string, or throws. */
const fakeLlm = answer => ({ alias: 'fake', calls: [], async complete(body) { this.calls.push(body); try { return { ok: true, content: await answer(body), usage: { prompt_tokens: 50, completion_tokens: 8 } }; } catch (e) { return { ok: false, error: e.message, usage: null }; } } });

test('the autopilot harvests for free; a model decision is charged, checked against the candidates, and falls back to the autopilot', async () => {
  const r = relay({ prices: { inference: '10000' } });
  const a = await ready(r, { balance: 60_000n });
  const t0 = 1_000;
  const rule = await runOnce(r.gateway, a.agentId, ruleDecider(), { tick: t0 });
  assert.deepEqual([rule.decided, rule.charged, rule.by, rule.result.status], ['Harvest', '0', 'autopilot', 'sent']);
  assert.equal(r.gateway.view(a.agentId).balance.spent.inference, '0');
  // The model picks Train with its fields.
  const llm = fakeLlm(body => {
    const prompt = JSON.parse(body.messages[1].content);
    assert.deepEqual(prompt.allowed, ['Harvest', 'Train', 'Build']);
    assert.equal(JSON.stringify(body).includes(a.capability), false, 'the model never sees the token');
    assert.equal(JSON.stringify(body).includes(a.agentKey), false, 'nor the key');
    assert.equal(body.response_format.json_schema.schema.properties.action.enum.at(-1), 'rest');
    return JSON.stringify({ action: 'Train', fields: { unit: 1, n: 2 }, reason: 'more hands' });
  });
  const model = await runOnce(r.gateway, a.agentId, llmDecider({ llm }), { tick: t0 + 1 });
  assert.deepEqual([model.decided, model.charged, model.by, model.result.status], ['Train', '10000', 'model:fake', 'sent']);
  assert.equal(r.chain.sent.at(-1).instructions[3].data[0], 0x42, 'Train');
  // Rest: charged, nothing sent.
  const rest = await runOnce(r.gateway, a.agentId, llmDecider({ llm: fakeLlm(() => JSON.stringify({ action: 'rest', fields: {}, reason: 'wait' })) }), { tick: t0 + 2 });
  assert.deepEqual([rest.decided, rest.charged], [null, '10000']);
  // Not a candidate, missing field, not JSON, model down: all charged, the autopilot plays.
  for (const [what, answer] of [['not allowed', () => JSON.stringify({ action: 'Depart', fields: {}, reason: '' })], ['missing field', () => JSON.stringify({ action: 'Train', fields: { unit: 1 }, reason: '' })],
    ['not json', () => 'harvest!'], ['down', () => { throw new Error('timeout'); }]]) {
    const before = r.gateway.view(a.agentId).balance.spent.inference;
    const fb = await runOnce(r.gateway, a.agentId, llmDecider({ llm: fakeLlm(answer) }), { tick: t0 + 10 + Math.random() });
    assert.deepEqual([fb.decided, fb.charged, fb.result.status], ['Harvest', '10000', 'sent'], what);
    assert.match(fb.by, /autopilot \(after InferenceFailed\)/, what);
    assert.equal(BigInt(r.gateway.view(a.agentId).balance.spent.inference) - BigInt(before), 10_000n, what);
  }
  // Six model calls spent the 60,000: the model cannot be paid for, the autopilot plays free.
  const v = r.gateway.view(a.agentId);
  assert.equal(v.balance.spent.inference, '60000');
  assert.equal(v.balance.available, '0');
  const poor = await runOnce(r.gateway, a.agentId, llmDecider({ llm: fakeLlm(() => JSON.stringify({ action: 'Harvest', fields: {}, reason: '' })) }), { tick: t0 + 20 });
  assert.deepEqual([poor.decided, poor.charged], ['Harvest', '0']);
  assert.match(poor.by, /autopilot \(after InsufficientBalance\)/);
  // Stopped: skipped, nothing charged.
  r.gateway.setMode(a.agentId, a.o, 'manual');
  assert.equal((await runOnce(r.gateway, a.agentId, ruleDecider(), { tick: t0 + 30 })).skipped, 'manual');
  sound(r);
});

test('the scheduler ticks agents in auto mode only, one tick at a time; the schema and prompt carry public data only', async () => {
  const r = relay({ prices: { inference: '10000' } });
  const a = await ready(r);
  const b = await ready(r);
  const c = await ready(r);
  r.gateway.setMode(c.agentId, c.o, 'manual');
  const logs = [];
  const s = new AgentScheduler({ gateway: r.gateway, decider: ruleDecider(), tickMs: 1_000, log: m => logs.push(m) });
  const [one, two] = await Promise.all([s.tick(), s.tick()]);
  assert.equal(one, two, 'a tick in progress is shared');
  assert.deepEqual(one.map(x => [x.agentId, x.decided]), [[a.agentId, 'Harvest'], [b.agentId, 'Harvest']]);
  assert.equal(r.chain.sent.length, 2);
  assert.equal(logs.filter(l => l.startsWith('agent runner:')).length, 2);
  s.start();
  s.stop();
  assert.equal(s.timer, null);
  const view = r.gateway.view(a.agentId);
  const prompt = promptOf(view, ['Harvest']);
  assert.equal(prompt[1].content.includes(a.agentKey), false);
  assert.ok(decisionSchema(['Harvest']).properties.action.enum.includes('rest'));
  assert.deepEqual(Object.keys(CANDIDATES), ['Harvest', 'Train', 'Build', 'SetVigil']);
  sound(r);
});

test('the scheduler backs off after a tick that sent nothing: 1, 2, 4 … ticks without a model call, reset by a sent action', async () => {
  const r = relay({ prices: { inference: '10000' } });
  const a = await ready(r, { balance: 1_000_000n });
  let answer = 'rest';
  let calls = 0;
  const llm = { alias: 'f', async complete() { calls++; return { ok: true, content: JSON.stringify({ action: answer, fields: {}, reason: '' }), usage: null }; } };
  const s = new AgentScheduler({ gateway: r.gateway, decider: llmDecider({ llm }), tickMs: 1_000, log: () => {} });
  // Rest, rest, rest…: calls happen on ticks 1, 3, 6, 11, 20 (skips 1, 2, 4, 8); 20 ticks cost 5 calls, not 20.
  const called = [];
  for (let t = 1; t <= 20; t++) { const before = calls; await s.tick(); if (calls > before) called.push(t); }
  assert.deepEqual(called, [1, 3, 6, 11, 20]);
  assert.equal(r.gateway.view(a.agentId).balance.spent.inference, '50000');
  // An action that is sent resets the back-off: the next tick asks again.
  answer = 'Harvest';
  await s.tick(); // sat out (skip 16 was set after tick 20) — count the skip down to 0 first
  for (let i = 0; i < 15; i++) await s.tick();
  const before = calls;
  await s.tick();
  assert.equal(calls, before + 1, 'asked after the sit-out');
  assert.equal(r.chain.sent.length, 1);
  assert.equal(s.backoff.has(a.agentId), false, 'reset by the sent action');
  await s.tick();
  assert.equal(calls, before + 2, 'asked again right away after a sent action');
  // A refused action also backs off (here: the owner took the session key back, so the gateway refuses).
  delegate(r, a.o, Keypair.generate().publicKey.toBase58());
  const sentBefore = r.chain.sent.length;
  await s.tick();
  assert.equal(r.chain.sent.length, sentBefore);
  assert.deepEqual(s.backoff.get(a.agentId), { skip: 1, next: 2 });
  sound(r);
});
