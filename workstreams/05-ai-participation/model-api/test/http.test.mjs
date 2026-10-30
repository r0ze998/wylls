// The adapters over REAL HTTP, against the local fixture server on 127.0.0.1 (fixture/http-fixture.mjs).
// No outside network: the transport refuses any other host, and no credential is ever sent. The answers,
// usage figures and request ids are the fixture's inventions in the providers' documented shapes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OUTCOME } from '../src/contract.mjs';
import { anthropicAdapter, openaiAdapter } from '../src/adapters.mjs';
import { loopbackTransport } from '../src/http-transport.mjs';
import { FIXTURE_BOOK } from '../src/price-book.mjs';
import { RunCostMock } from '../src/run-cost.mjs';
import { DecisionRegistry, infer } from '../src/inference.mjs';
import { closedPort, startHttpFixture } from '../fixture/http-fixture.mjs';

const ANSWER = { proposals: [{ request: 'R-1', action: 'Train', fields: { unit: 0, n: 100 }, reason: 'fits' }], skipped: [] };
const MSGS = [{ role: 'system', text: 'You help one village inside its owner\'s limits.' }, { role: 'user', text: '{"requests":[{"id":"R-1"}]}' }];
const BOTH = [['Claude', anthropicAdapter, 'claude-fixture-model'], ['GPT', openaiAdapter, 'gpt-fixture-model']];
const go = ({ adapter, model, url, key = 'decision-0001', costs = new RunCostMock({ available: '100000' }), retry = {}, registry = null, timeoutMs = 2_000 }) =>
  infer({ adapter, transport: loopbackTransport({ baseUrl: url, timeoutMs }), book: FIXTURE_BOOK(), costs, registry, retry, sleep: async () => {},
    request: { requestKey: key, model, messages: MSGS, maxOutputTokens: 400 } }).then(r => ({ r, costs }));
const withFixture = async (script, fn) => { const s = await startHttpFixture(script); try { return await fn(s); } finally { await s.close(); } };

for (const [name, adapter, model] of BOTH) {
  test(`${name} over loopback HTTP: the request on the wire, the answer, the usage, the measured cost settled`, () => withFixture(() => ({ answer: ANSWER }), async s => {
    const { r, costs } = await go({ adapter, model, url: s.url });
    assert.equal(r.outcome, OUTCOME.OK);
    assert.deepEqual(JSON.parse(r.text), ANSWER);
    const seen = s.seen[0];
    assert.equal(seen.path, adapter === anthropicAdapter ? '/v1/messages' : '/v1/responses');
    assert.equal(seen.body.model, model);
    for (const h of Object.keys(seen.headers)) assert.equal(/authorization|api-key|openai-(organization|project)/i.test(h), false, h);
    if (adapter === openaiAdapter) assert.equal(seen.headers['x-client-request-id'], 'decision-0001#0');
    const a = r.attempts[0];
    assert.equal(a.providerRequestId, 'req_fixture_0');
    assert.equal(a.usage.inputUncached, 900);
    assert.equal(a.usage.output, 120);
    assert.equal(a.usage.reasoning, 30);
    assert.equal(a.model.served, model, 'the served name is what the fixture said: a self-report');
    // FIXTURE prices (invented): 1 micro-USD an input token, 5 an output token.
    assert.equal(a.cost.measured, String(900 + 120 * 5));
    assert.equal(costs.classes().settled, String(900 + 120 * 5));
    assert.equal(costs.classes().undecided, '0');
  }));

  test(`${name}: a timeout after sending is undecided and not retried; the fixture saw exactly one request`, () => withFixture(() => ({ delayMs: 300, answer: ANSWER }), async s => {
    const { r, costs } = await go({ adapter, model, url: s.url, timeoutMs: 60 });
    assert.equal(r.outcome, OUTCOME.UNKNOWN);
    assert.equal(r.attempts.length, 1);
    assert.equal(costs.classes().undecided, r.quote, 'the whole quote stays held: the provider may have billed it');
    assert.equal(costs.classes().released, '0');
    await new Promise(res => setTimeout(res, 320));
    assert.equal(s.requests(), 1);
  }));

  test(`${name}: a connection lost before or during the answer is undecided, never zero`, () => withFixture((b, n) => ({ hangUp: n === 0 ? 'before-headers' : 'mid-body', answer: ANSWER }), async s => {
    const one = await go({ adapter, model, url: s.url, key: 'decision-0001' });
    const two = await go({ adapter, model, url: s.url, key: 'decision-0002' });
    for (const { r, costs } of [one, two]) {
      assert.equal(r.outcome, OUTCOME.UNKNOWN);
      assert.equal(r.attempts[0].cost.unknown, true);
      assert.equal(costs.classes().undecided, r.quote);
    }
  }));

  test(`${name}: rate limit and overload are held as unknown and not retried by default; retried only when allowed, each try a new reservation flagged as possible double billing`, () => withFixture((b, n) => n === 0 ? { status: 429, headers: { 'retry-after': '0' }, error: { type: 'rate_limit_error' } } : n === 1 ? { status: adapter === anthropicAdapter ? 529 : 500, error: { type: adapter === anthropicAdapter ? 'overloaded_error' : 'server_error' } } : { answer: ANSWER }, async s => {
    const t = await go({ adapter, model, url: s.url, key: 'decision-0001' });
    assert.equal(t.r.outcome, OUTCOME.THROTTLED);
    assert.equal(t.r.attempts.length, 1);
    assert.equal(t.costs.classes().undecided, t.r.quote, 'a 429 has no usage report: its cost is unknown, not 0');
    const f = await go({ adapter, model, url: s.url, key: 'decision-0002', retry: { retryFailed: true } });
    assert.equal(f.r.outcome, OUTCOME.OK);
    assert.deepEqual(f.r.attempts.map(a => a.key), ['decision-0002#0', 'decision-0002#1']);
    assert.match(f.r.possibleDoubleBilling, /may have billed both/);
    assert.equal(f.costs.classes().undecided, f.r.quote, 'the failed try stays held until a report or the operator decides');
    assert.equal(s.requests(), 3);
  }));
}

test('a connection refused before sending costs nothing and is the one failure retried by default (within maxAttempts)', async () => {
  const url = await closedPort();
  const { r, costs } = await go({ adapter: anthropicAdapter, model: 'claude-fixture-model', url });
  assert.equal(r.outcome, OUTCOME.NOT_SENT);
  assert.equal(r.attempts.length, 3);
  assert.ok(r.attempts.every(a => a.cost.measured === '0' && a.cost.unknown === false));
  assert.equal(costs.classes().undecided, '0');
  assert.equal(costs.classes().reserved, '0');
  assert.equal(costs.classes().available, '100000');
  assert.equal(r.possibleDoubleBilling, undefined);
});

test('GPT: a 429 that names a billing code is a billing stop, never retried even when retries are allowed', () => withFixture(() => ({ status: 429, error: { type: 'insufficient_quota', code: 'insufficient_quota' } }), async s => {
  const { r } = await go({ adapter: openaiAdapter, model: 'gpt-fixture-model', url: s.url, retry: { retryThrottled: true, retryFailed: true, retryUnknown: true } });
  assert.equal(r.outcome, OUTCOME.BILLING);
  assert.equal(s.requests(), 1);
}));

test('the same decision asked twice (a re-run tick, a concurrent caller) is one HTTP request and one reservation', () => withFixture(() => ({ delayMs: 30, answer: ANSWER }), async s => {
  const registry = new DecisionRegistry();
  const costs = new RunCostMock({ available: '100000' });
  const both = await Promise.all([go({ adapter: openaiAdapter, model: 'gpt-fixture-model', url: s.url, registry, costs }), go({ adapter: openaiAdapter, model: 'gpt-fixture-model', url: s.url, registry, costs })]);
  const again = await go({ adapter: openaiAdapter, model: 'gpt-fixture-model', url: s.url, registry, costs });
  assert.equal(s.requests(), 1);
  assert.equal(costs.items.size, 1);
  assert.equal(both.filter(x => x.r.replayed).length, 1);
  assert.equal(again.r.replayed, true);
  assert.equal(again.r.text, both[0].r.text);
}));

test('the loopback transport refuses any outside host and any credential header', async () => {
  for (const u of ['https://api.anthropic.com', 'http://api.openai.com', 'http://10.0.0.5:8080', 'http://example.test']) assert.throws(() => loopbackTransport({ baseUrl: u }), e => e.code === 'NotLoopback', u);
  await withFixture(() => ({ answer: ANSWER }), async s => {
    await assert.rejects(loopbackTransport({ baseUrl: s.url }).send({ path: '/v1/messages', headers: { 'X-Api-Key': 'not-a-real-key' }, body: {} }), /credential header/);
    assert.equal(s.requests(), 0);
  });
});
