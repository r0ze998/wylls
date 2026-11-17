// The provider contract and its adapters, the price book, the ④ cost contract (mocked) and one away-mode
// decision call, all on fixtures. NO API IS CALLED: the transport answers from recorded-shape fixtures
// with invented values; no key is read; no socket is opened.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { OUTCOME } from '../src/contract.mjs';
import { anthropicAdapter, fixtureTransport, openaiAdapter } from '../src/adapters.mjs';
import { FIXTURE_BOOK, TokenPriceBook } from '../src/price-book.mjs';
import { RunCostMock } from '../src/run-cost.mjs';
import { infer, preflight } from '../src/inference.mjs';
import { claude200, claudeError, gpt200, gptError } from './fixtures.mjs';

const MSGS = [{ role: 'system', text: 'You help one village inside its owner\'s limits.' }, { role: 'user', text: '{"requests":[{"id":"R-1"}]}' }];
const claudeReq = (k = 'call-0001') => ({ requestKey: k, model: 'claude-fixture-model', messages: MSGS, maxOutputTokens: 400 });
const gptReq = (k = 'call-0001') => ({ requestKey: k, model: 'gpt-fixture-model', messages: MSGS, maxOutputTokens: 400 });
const run = (adapter, script, { req, costs = new RunCostMock({ available: '100000' }), retry = {} } = {}) =>
  infer({ adapter, transport: fixtureTransport(script), book: FIXTURE_BOOK(), costs, request: req ?? (adapter === anthropicAdapter ? claudeReq() : gptReq()), retry, sleep: async () => {} }).then(r => ({ r, costs }));

// ------------------------------------------------------------------ the contract is the same for both providers

test('Claude and GPT behind one contract: the same request gives each its own wire shape, never a credential header', () => {
  const a = anthropicAdapter.build({ requestKey: 'k-00000001', model: 'm', messages: MSGS, maxOutputTokens: 400, jsonSchema: { type: 'object' } });
  assert.equal(a.path, '/v1/messages');
  assert.deepEqual(Object.keys(a.body).sort(), ['max_tokens', 'messages', 'model', 'output_config', 'system']);
  const o = openaiAdapter.build({ requestKey: 'k-00000001', model: 'm', messages: MSGS, maxOutputTokens: 400 });
  assert.equal(o.path, '/v1/responses');
  assert.equal(o.headers['X-Client-Request-Id'], 'k-00000001');
  for (const w of [a, o]) for (const k of Object.keys(w.headers)) assert.equal(/authorization|api-key/i.test(k), false, k);
});

test('a usage report is mapped apart: uncached input, cache reads, cache writes by TTL, output (reasoning inside it)', async () => {
  const { r: c } = await run(anthropicAdapter, [claude200()]);
  assert.equal(c.outcome, OUTCOME.OK);
  assert.deepEqual(c.attempts[0].usage, { inputUncached: 1200, cacheRead: 2000, cacheWrite: { '5m': 200, '1h': 100 }, output: 150, reasoning: 40, serverTools: { web_search_requests: 0, web_fetch_requests: 0 } });
  // FIXTURE prices (invented): input 1, read 0.1, write 5m 1.25, write 1h 2, output 5 micro-USD a token.
  assert.equal(c.attempts[0].cost.measured, String(Math.ceil(1200 * 1 + 2000 * 0.1 + 200 * 1.25 + 100 * 2 + 150 * 5)));
  const { r: g } = await run(openaiAdapter, [gpt200()]);
  // GPT: cached and written tokens are taken as parts of input_tokens (an assumption to verify before live).
  assert.deepEqual(g.attempts[0].usage, { inputUncached: 1200, cacheRead: 2000, cacheWrite: { unspecified: 300 }, output: 150, reasoning: 40, serverTools: {} });
  // input 1200×1 + cache read 2000×0.1 + cache write 300×1.25 + output 150×5 (FIXTURE prices, micro-USD).
  assert.equal(g.attempts[0].cost.measured, String(Math.ceil(1200 * 1 + 2000 * 0.1 + 300 * 1.25 + 150 * 5)));
});

test('model names: the configured id, and the name the provider says it served (a self-report, not verification)', async () => {
  const { r } = await run(anthropicAdapter, [claude200({ model: 'claude-other-model' })]);
  assert.deepEqual(r.attempts[0].model, { provider: 'anthropic', configured: 'claude-fixture-model', served: 'claude-other-model', assurance: 'self-reported by the provider response (not verified)' });
});

test('the price book: never a production book; a quote is an upper bound; a cost never exceeds what was reserved', async () => {
  assert.throws(() => new TokenPriceBook({ version: 'x', status: 'PRODUCTION', currency: 'test-USDC', models: {} }), /never a production one/);
  assert.throws(() => new TokenPriceBook({ version: 'x', status: 'TEST', currency: 'USD', models: {} }), /conversion rate/);
  // A measured cost above the quote (an input far larger than expected): the owner is charged the quote; the rest is the operator's record.
  const huge = claude200({ usage: { input_tokens: 9_000_000, output_tokens: 10, cache_read_input_tokens: 0 } });
  const { r, costs } = await run(anthropicAdapter, [huge]);
  assert.equal(r.attempts[0].cost.settled, r.quote);
  assert.equal(costs.overruns.length, 1);
});

// ------------------------------------------------------------------ outcomes and their costs

test('truncated and refused answers are billed by their usage; a refusal yields no text to act on', async () => {
  const { r: t } = await run(anthropicAdapter, [claude200({ stop_reason: 'max_tokens' })]);
  assert.deepEqual([t.outcome, t.attempts[0].cost.unknown], [OUTCOME.TRUNCATED, false]);
  const { r: f } = await run(anthropicAdapter, [claude200({ stop_reason: 'refusal', content: [] })]);
  assert.deepEqual([f.outcome, f.text], [OUTCOME.REFUSED, null]);
  assert.ok(BigInt(f.attempts[0].cost.measured) > 0n);
  const { r: g } = await run(openaiAdapter, [gpt200({ output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'no' }] }] })]);
  assert.equal(g.outcome, OUTCOME.REFUSED);
  const { r: gi } = await run(openaiAdapter, [gpt200({ status: 'incomplete' })]);
  assert.equal(gi.outcome, OUTCOME.TRUNCATED);
});

test('a rate limit is not retried inside the decision by default (its cost is unreported, so it stays held); when allowed, each retry is a NEW reservation; billing stops never retry', async () => {
  const { r, costs } = await run(anthropicAdapter, [claudeError(429, 'rate_limit_error', { 'retry-after': '2' }), claude200()]);
  assert.deepEqual([r.outcome, r.attempts.length], [OUTCOME.THROTTLED, 1]);
  assert.equal(costs.classes().undecided, r.quote, 'no usage report: held as undecided, not taken as 0');
  const { r: r2, costs: c2 } = await run(anthropicAdapter, [claudeError(429, 'rate_limit_error', { 'retry-after': '2' }), claude200()], { retry: { retryThrottled: true } });
  assert.deepEqual(r2.attempts.map(a => a.outcome), [OUTCOME.THROTTLED, OUTCOME.OK]);
  assert.deepEqual(r2.attempts.map(a => a.key), ['call-0001#0', 'call-0001#1']);
  assert.equal(c2.classes().undecided, r2.quote, 'the throttled attempt stays held');
  assert.match(r2.possibleDoubleBilling, /billed both/);
  for (const [adapter, x] of [[anthropicAdapter, claudeError(429, 'rate_limit_error')], [anthropicAdapter, claudeError(402, 'billing_error')], [openaiAdapter, gptError(429, 'credit_balance_exhausted')], [openaiAdapter, gptError(429, 'organization_spend_limit_exceeded')]]) {
    const { r: b } = await run(adapter, [x, adapter === anthropicAdapter ? claude200() : gpt200()], { retry: { retryThrottled: true, retryFailed: true } });
    assert.deepEqual([b.outcome, b.attempts.length], [OUTCOME.BILLING, 1], JSON.stringify(x.body));
  }
});

test('a timeout after sending is undecided: held, never released or made available, not retried by default', async () => {
  const { r, costs } = await run(openaiAdapter, [{ transportError: 'ETIMEDOUT', sent: true }, gpt200()]);
  assert.deepEqual([r.outcome, r.attempts.length], [OUTCOME.UNKNOWN, 1]);
  const c = costs.classes();
  assert.deepEqual([c.undecided, c.withdrawable], [r.quote, String(100000n - BigInt(r.quote))]);
  assert.equal(costs.release('call-0001#0', 'try'), null, 'an undecided call cannot be released by code');
  assert.throws(() => costs.decide('call-0001#0', { by: 'operator', outcome: 'refund' }), /needs a note/);
  // The operator's word alone neither refunds nor zeroes it; a provider report needs evidence (here a fixture record).
  assert.throws(() => costs.decide('call-0001#0', { by: 'operator', outcome: 'refund', note: 'looks unbilled' }), e => e.code === 'EvidenceRequired');
  assert.throws(() => costs.decide('call-0001#0', { by: 'provider-report', amount: '0', note: 'trust me' }), e => e.code === 'EvidenceRequired');
  assert.throws(() => costs.decide('call-0001#0', { by: 'provider-report', amount: '0', note: 'x', evidence: { source: 'provider-usage-report', ref: 'r' } }), e => e.code === 'EvidenceRequired', 'no production source is accepted yet');
  assert.equal(costs.classes().undecided, r.quote);
  const d = costs.decide('call-0001#0', { by: 'provider-report', amount: '700', note: 'usage line', evidence: { source: 'fixture', ref: 'X-Client-Request-Id call-0001#0' } });
  assert.equal(d.evidence.productionVerified, false);
  assert.equal(costs.classes().settled, '700');
  // Allowed by policy: a retry after an unknown result, flagged as possible double billing.
  const { r: r2 } = await run(openaiAdapter, [{ transportError: 'ECONNRESET', sent: true }, gpt200()], { retry: { retryUnknown: true } });
  assert.deepEqual(r2.attempts.map(a => a.outcome), [OUTCOME.UNKNOWN, OUTCOME.OK]);
  assert.match(r2.possibleDoubleBilling, /billed both/);
});

test('a connection refused before sending is not billed and is retried; a server error is held as unknown, not retried by default, and when allowed its retries stay within the caps', async () => {
  const { r, costs } = await run(anthropicAdapter, [{ transportError: 'ECONNREFUSED', sent: false }, claude200()]);
  assert.deepEqual(r.attempts.map(a => a.outcome), [OUTCOME.NOT_SENT, OUTCOME.OK]);
  assert.equal(costs.classes().undecided, '0');
  // 529 overloaded: by default the decision ends there, the cost held (billing not stated).
  const { r: once } = await run(anthropicAdapter, [claudeError(529, 'overloaded_error'), claude200()]);
  assert.deepEqual([once.outcome, once.attempts.length, once.costs.undecided], [OUTCOME.FAILED, 1, once.quote]);
  // When retries are allowed: the per-day inference cap allows two quotes: two attempts, then the reservation is refused.
  const quoteOf = (await run(anthropicAdapter, [claude200()])).r.quote;
  const capped = new RunCostMock({ available: '1000000', caps: { perDay: String(2n * BigInt(quoteOf)) } });
  const { r: f } = await run(anthropicAdapter, [claudeError(529, 'overloaded_error')], { costs: capped, retry: { maxAttempts: 5, retryFailed: true } });
  assert.deepEqual(f.attempts.map(a => a.outcome ?? a.stop), [OUTCOME.FAILED, OUTCOME.FAILED, 'CategoryDayLimit']);
  assert.equal(capped.classes().undecided, String(2n * BigInt(quoteOf)), 'both 529s stay undecided: billing is not stated');
  assert.match(f.possibleDoubleBilling, /billed both/);
});

test('concurrent calls in one process cannot both take the last unit; a restart turns in-flight calls into undecided', async () => {
  const quoteOf = BigInt((await run(anthropicAdapter, [claude200()])).r.quote);
  const costs = new RunCostMock({ available: String(quoteOf * 2n) });
  let release;
  const gate = new Promise(r => { release = r; });
  const slow = fixtureTransport(async () => { await gate; return claude200(); });
  const go = k => infer({ adapter: anthropicAdapter, transport: slow, book: FIXTURE_BOOK(), costs, request: claudeReq(k), sleep: async () => {} });
  const runs = [go('conc-0001'), go('conc-0002'), go('conc-0003'), go('conc-0004')];
  await new Promise(r => setImmediate(r));
  assert.equal(slow.calls.length, 2, 'two reservations fit, two calls are made');
  costs.restart();
  assert.equal(costs.classes().undecided, String(quoteOf * 2n));
  release();
  const out = await Promise.all(runs);
  assert.deepEqual(out.map(o => o.attempts[0].stop ?? 'called').sort(), ['InsufficientBalance', 'InsufficientBalance', 'called', 'called']);
  // The answers arrived after the restart: settled from undecided by their usage (the call happened once each).
  assert.equal(costs.classes().undecided, '0');
});

// ------------------------------------------------------------------ preflight: no useless inference

test('preflight: the model is not called when the agent is stopped, not delegated, has nothing to do, or cannot pay for the call and the game action', async () => {
  const view = { mode: 'auto', delegation: { delegated: true }, policy: { budget: { callsPerDay: 5 } }, day: { calls: 0 }, quota: { left: 3 } };
  const ok = preflight({ view, openRequests: 1, quote: '1000', gameReserve: '15000', available: '20000' });
  assert.equal(ok.call, true);
  const cases = [
    [{ ...view, mode: 'manual' }, {}, 'Stopped'],
    [{ ...view, delegation: { delegated: false } }, {}, 'NotDelegated'],
    [{ ...view, delegation: null }, {}, 'DelegationUnread'],
    [view, { openRequests: 0 }, 'NothingOpen'],
    [{ ...view, day: { calls: 5 } }, {}, 'CallCapReached'],
    [{ ...view, quota: { left: 0 } }, {}, 'QuotaEmpty'],
    [view, { available: '15500' }, 'BudgetShort'],
  ];
  for (const [v, over, code] of cases) {
    const p = preflight({ view: v, openRequests: 1, quote: '1000', gameReserve: '15000', available: '20000', ...over });
    assert.equal(p.call, false, code);
    assert.ok(p.reasons.some(x => x.code === code), JSON.stringify(p.reasons));
  }
  // The game reserve is kept apart: inference cannot spend what the game action needs.
  const costs = new RunCostMock({ available: '20000' });
  costs.setGameReserve('15000');
  assert.throws(() => costs.reserve('k-big', '6000'), e => e.code === 'InsufficientBalance');
  assert.ok(costs.reserve('k-ok', '5000'));
});

// ------------------------------------------------------------------ no key, no network

test('this build cannot call a model: no credential is read, no network module is used, a fixture refuses credential headers', async () => {
  const dir = new URL('../src/', import.meta.url);
  for (const f of readdirSync(dir)) {
    const src = readFileSync(new URL(f, dir), 'utf8').replace(/^\s*\/\/.*$/gm, '');
    assert.equal(/process\.env/.test(src), false, `${f}: reads the environment`);
    // One file may open a socket: the loopback transport, plain http to 127.0.0.1 / ::1 only (no https, no net, no tls, no fetch).
    const net = f === 'http-transport.mjs' ? /\bfetch\s*\(|node:https|node:net|node:tls|require\(['"]https?/ : /\bfetch\s*\(|node:https?|node:net|node:tls|require\(['"]https?/;
    assert.equal(net.test(src), false, `${f}: network code`);
  }
  assert.match(readFileSync(new URL('http-transport.mjs', dir), 'utf8'), /LOOPBACK = new Set\(\['127\.0\.0\.1', '::1', '\[::1\]', 'localhost'\]\)/);
  await assert.rejects(fixtureTransport([claude200()]).send({ headers: { 'x-api-key': 'not-a-real-key' }, body: {} }), /credential header/);
});
