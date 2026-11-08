// The cost port (resident/ports/cost.mjs): workstream 5's reserve-quote / charge-measured / unknown-stays-undecided
// rules on top of the agent wallet's ledger. No model is called: providers here are fixtures that report a usage.
// The last test uses workstream 5's real TokenPriceBook when its code is in the tree (skipped otherwise).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { small, run } from './helpers.mjs';
import { flatCost, priceBookCost } from '../resident/ports/cost.mjs';
import { decisionsOf } from '../demo/report.mjs';
import { ws05 as ws05Root } from './roots.mjs';

/** A stand-in with workstream 5's TokenPriceBook methods: 1 unit per input token or byte, 5 per output token. */
const standIn = () => ({
  version: 'stand-in',
  entry(p, m) { if (`${p}/${m}` !== 'fixture/m') throw Object.assign(new Error('no price'), { code: 'NoPrice' }); return {}; },
  quote(p, m, { inputTokenCeiling, maxOutputTokens }) { return String(inputTokenCeiling + 5 * maxOutputTokens); },
  measure(p, m, u) { return u.inputUncached === null || u.output === null ? null : String(u.inputUncached + 5 * u.output); },
});

/** A provider answering the best candidate with a given usage report, or failing in a given way. */
const providerWith = ({ usage = { inputTokens: 100, outputTokens: 10 }, fail = null, choice = null } = {}) => ({
  async decide(req) {
    if (fail === 'slow') return new Promise(() => {});
    if (fail) throw Object.assign(new Error(`provider ${fail}`), { outcome: fail });
    const best = [...req.candidates].sort((a, b) => b.score - a.score)[0];
    return { choice: choice ?? best.id, reason: 'fixture', mem: [], usage, provider: 'fixture', model: 'm' };
  },
});

async function oneDecision(provider, { limits = {} } = {}) {
  const env = await small({ residents: [{ id: 'ren', goal: 'village-first', pos: { q: 0, r: 0 }, provider, limits }] });
  const ren = env.rs.ren;
  ren.ports.cost = priceBookCost(standIn(), { provider: 'fixture', model: 'm' });
  await run(env, 1);
  const d = decisionsOf(ren).find(x => x.cost);
  return { env, ren, d, rec: ren.ledger.get('ren') };
}

test('flat is the default and unchanged: the fixed price, answered or not', () => {
  const f = flatCost('10000');
  assert.equal(f.quote({}), '10000');
  assert.deepEqual(f.settle({ outcome: 'unknown' }), { charge: '10000' });
});

test('price book: the quote is reserved before the call, the measured usage is charged after', async () => {
  const { d, rec, ren } = await oneDecision(providerWith({ usage: { inputTokens: 100, outputTokens: 10 } }));
  assert.equal(d.cost.kind, 'price-book');
  assert.ok(Number(d.cost.quote) > 150, 'the quote covers every input byte and the output ceiling');
  assert.equal(d.cost.charge, '150');
  assert.equal(rec.bal.spent.inference, '150');
  assert.equal(rec.bal.reserved, '0');
  assert.deepEqual(ren.ledger.check(), []);
});

test('price book: usage above the quote is charged at the quote and recorded as overrun', async () => {
  const { d, rec } = await oneDecision(providerWith({ usage: { inputTokens: 1e6, outputTokens: 0 } }));
  assert.equal(d.cost.charge, d.cost.quote);
  assert.equal(BigInt(d.cost.overrun), 1_000_000n - BigInt(d.cost.quote));
  assert.equal(rec.bal.spent.inference, d.cost.quote);
});

test('price book: a late call stays undecided — reserved, unresolved, counted against the call cap — and is never released by code', async () => {
  const { d, rec, ren, env } = await oneDecision(providerWith({ fail: 'slow' }), { limits: { providerDeadlineMs: 20 } });
  assert.equal(d.refusal, 'Late');
  assert.match(d.cost.undecided, /unknown/);
  const h = Object.values(rec.holds);
  assert.deepEqual(h.map(x => [x.state, x.amount]), [['unresolved', d.cost.quote]]);
  assert.equal(rec.bal.reserved, d.cost.quote);
  assert.equal(rec.day.calls, 1);
  await run(env, 30);
  assert.equal(Object.values(ren.ledger.get('ren').holds).filter(x => x.state === 'unresolved' && x.key === h[0].key).length, 1, 'still unresolved later');
  assert.deepEqual(ren.ledger.check(), []);
});

test('price book: a provider refusal before generating charges nothing; an answer refused here is charged its usage', async () => {
  const rejected = await oneDecision(providerWith({ fail: 'rejected' }));
  assert.equal(rejected.d.cost.charge, '0');
  assert.equal(rejected.rec.bal.spent.inference, '0');
  const invalid = await oneDecision(providerWith({ choice: 'raid:everyone', usage: { inputTokens: 40, outputTokens: 2 } }));
  assert.equal(invalid.d.refusal, 'NotACandidate');
  assert.equal(invalid.d.cost.charge, '50');
  const noCount = await oneDecision(providerWith({ usage: { inputTokens: null, outputTokens: 2 } }));
  assert.match(noCount.d.cost.undecided, /no billed count/);
});

test('price book: a model the book does not price is refused before any call', () => {
  assert.throws(() => priceBookCost(standIn(), { provider: 'fixture', model: 'other' }), /no price/);
  assert.throws(() => priceBookCost({}, { provider: 'x', model: 'y' }), /quote\(\) and measure\(\)/);
});

// In the tree, or a restored checkout of workstream 5 (WS05_ROOT).
const WS05 = ws05Root().root ? pathToFileURL(path.join(ws05Root().root, 'workstreams/05-ai-participation/model-api/src/price-book.mjs')) : new URL('../../05-ai-participation/model-api/src/price-book.mjs', import.meta.url);
const ws05 = existsSync(fileURLToPath(WS05));
test('with workstream 5\'s real TokenPriceBook (its FIXTURE book; invented prices)', { skip: ws05 ? false : 'workstream 5 code is not in this tree' }, async () => {
  const { FIXTURE_BOOK } = await import(WS05);
  const book = FIXTURE_BOOK();
  const env = await small({ residents: [{ id: 'ren', goal: 'village-first', pos: { q: 0, r: 0 }, provider: providerWith({ usage: { inputUncached: 1200, cacheRead: 0, cacheWrite: {}, output: 40 } }) }] });
  const ren = env.rs.ren;
  ren.ports.cost = priceBookCost(book, { provider: 'anthropic', model: 'claude-fixture-model' });
  await run(env, 1);
  const d = decisionsOf(ren).find(x => x.cost);
  assert.equal(d.cost.charge, book.measure('anthropic', 'claude-fixture-model', { inputUncached: 1200, cacheRead: 0, cacheWrite: {}, output: 40 }));
  assert.ok(BigInt(d.cost.charge) <= BigInt(d.cost.quote));
  assert.deepEqual(ren.ledger.check(), []);
});
