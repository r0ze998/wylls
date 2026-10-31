// ⑤ in a world that does not end. The boundary here is a TEST-LOCAL instant (UTC midnight of the world clock, where
// the per-day inference cap rolls over); it is not a World or Period model (that canon is ④/⑧'s) and it ends nothing.
//   T1 bounded authority: a continuing world does not make a mandate or a budget permanent
//   T2 the delegation's own expiry is still enforced, never extended by ⑤
//   T3 across the boundary, with a process restart in between: ownership, counts, run ids and costs stay consistent
//   T4 today's core binds the Citizen's address to the season id: when the relay finds no Citizen, ⑤ stops paying
//   T5 long-running state (separate from crossing a boundary): compaction, snapshots and bounded memory
// No outside network, no key, test assets only. Relay and chain are the local fixtures (scripted chain).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RunJournal } from '../../src/adapters.mjs';
import { createLocalWorld, northernRequests } from '../../src/local-world.mjs';
import { mandateFor } from '../../test/helpers.mjs';
import { openaiAdapter } from '../src/adapters.mjs';
import { apiDecider } from '../src/api-decider.mjs';
import { Autopilot } from '../src/autopilot.mjs';
import { MAX_MANDATE_SECS, checkBounds } from '../src/bounds.mjs';
import { createAgentMcp } from '../../src/deps.mjs';
import { tool } from '../../src/participate.mjs';
import { loopbackTransport } from '../src/http-transport.mjs';
import { DecisionRegistry } from '../src/inference.mjs';
import { FIXTURE_BOOK } from '../src/price-book.mjs';
import { KEY_RETENTION_DAYS, RunCostMock } from '../src/run-cost.mjs';
import { localReceiptPort } from '../src/run-receipt.mjs';
import { startHttpFixture } from '../fixture/http-fixture.mjs';
import { tokenCheck } from './relay-tree.mjs';

const userOf = body => JSON.parse((body.messages ?? body.input).find(m => m.role === 'user').content);
const answerFirst = body => { const r = userOf(body).requests[0]; return { proposals: r ? [{ request: r.id, action: 'Train', fields: { unit: 0, n: 100 }, reason: 'one batch' }] : [], skipped: [] }; };
const DAY = 86_400;

async function setup({ script, caps = { total: '1000000' }, mandateSecs = 2 * DAY, timeoutMs = 2_000 } = {}) {
  const srv = await startHttpFixture(script);
  const w = await createLocalWorld({ stores: { Food: 5000, Wood: 100, Stone: 100, Ore: 2000, Gold: 1000 } });
  // Requests that stay open across the boundary (the fixture board's deadlines are hours away).
  const b = northernRequests()[0];
  w.board.splice(0, w.board.length, ...[1, 2, 3, 4, 5, 6].map(i => ({ ...b, id: `R-${i}`, deadlineSec: w.state.clock + 4 * DAY, ask: { kind: 'train', unit: 0, n: 100 } })));
  const now = () => w.state.clock * 1000;
  const mandate = mandateFor(w, { allowed: ['Train'], expiresAt: w.state.clock + mandateSecs, limits: { perRequest: { Food: 60, Ore: 20, Gold: 10 }, perDay: { Food: 600, Ore: 200, Gold: 100 }, troopsPerRequest: 100 } });
  const journal = new RunJournal({ now });
  const mcp = () => createAgentMcp({ relay: 'http://relay.test', agentId: w.agentId, capability: w.capability, fetch: w.fetch, source: 'ai' });
  const view = async () => (await tool(mcp(), 'agent_view')).structuredContent;
  const make = costs => {
    let ap;
    const decider = apiDecider({ adapter: openaiAdapter, model: 'gpt-fixture-model', transport: loopbackTransport({ baseUrl: srv.url, timeoutMs }), book: FIXTURE_BOOK(), costs, registry: new DecisionRegistry(), runId: () => ap.currentRun, sleep: async () => {} });
    ap = new Autopilot({ world: w, mandate, decider, journal, mcp, receipts: localReceiptPort({ view, txState: w.txState, costs }), tokenCheck: tokenCheck() });
    return ap;
  };
  const costs = new RunCostMock({ available: '1000000', caps, now });
  return { srv, w, now, mandate, journal, view, costs, ap: make(costs), make, close: () => srv.close() };
}

test('T1 bounded authority: no expiry, an expiry beyond 30 days, or no total cap is refused before any model call; the owner renews explicitly', async () => {
  assert.equal(checkBounds({ mandate: { expiresAt: 0 }, costs: { caps: { total: '1' } }, nowSec: 100 }).reasons[0].code, 'MandateUnbounded');
  assert.equal(checkBounds({ mandate: { expiresAt: Infinity }, costs: { caps: { total: '1' } }, nowSec: 100 }).reasons[0].code, 'MandateUnbounded');
  assert.equal(checkBounds({ mandate: { expiresAt: 100 + MAX_MANDATE_SECS + 1 }, costs: { caps: { total: '1' } }, nowSec: 100 }).reasons[0].code, 'MandateTooLong');
  assert.equal(checkBounds({ mandate: { expiresAt: 200 }, costs: { caps: { perDay: '5', total: null } }, nowSec: 100 }).reasons[0].code, 'BudgetUnbounded');
  const s = await setup({ script: body => ({ answer: answerFirst(body) }), caps: { perDay: '100000' }, mandateSecs: 40 * DAY });
  try {
    await assert.rejects(s.ap.start({ by: 'owner' }), e => e.code === 'MandateTooLong' && e.reasons.some(r => r.code === 'BudgetUnbounded'));
    assert.equal(s.srv.requests(), 0);
    // The owner renews: a 7-day mandate and a total cap. Nothing extended them by itself.
    s.ap.mandate = { ...s.ap.mandate, expiresAt: s.w.state.clock + 7 * DAY };
    s.costs.caps.total = '50000';
    await s.ap.start({ by: 'owner' });
    assert.equal(s.ap.state, 'running');
    s.ap.stop({ by: 'test' });
  } finally { await s.close(); }
});

test('T2 the delegation\'s own expiry is enforced across time: when the session expires, ⑤ makes no model call and does not renew it', async () => {
  const s = await setup({ script: body => ({ answer: answerFirst(body) }) });
  try {
    await s.ap.start({ by: 'owner' });
    assert.equal((await s.ap.tick()).game[0].outcome, 'sent');
    s.w.sessionExpiresAt(s.w.state.clock + 120);     // the owner gave the key for two more minutes
    s.w.advance(300);
    // The relay caches its chain-clock read for clockTtlMs = 1,000 ms of WALL time (src/frontier/chain.mjs): until it
    // refreshes, its view still says "delegated". Within that window ⑤ could pay for one call (the program refuses the
    // act itself on chain). Recorded for ④; here the test waits the cache out.
    await new Promise(r => setTimeout(r, 1_100));
    const calls = s.srv.requests();
    const t = await s.ap.tick();
    // Either the grant is already invalid (blocked before the decider) or the decider's preflight refuses: no call.
    assert.ok(t.status === 'blocked' ? t.inference === null : t.inference.preflight.includes('NotDelegated'), JSON.stringify({ status: t.status, inference: t.inference?.preflight }));
    assert.equal(s.srv.requests(), calls, 'no model call after the session expired');
    const v = await s.view();
    assert.equal(v.delegation.delegated, false);
    assert.ok(v.delegation.expiry < v.delegation.now, '⑤ did not extend the session');
    s.ap.stop({ by: 'test' });
    await assert.rejects(s.ap.start({ by: 'owner' }), e => e.code === 'NotReady');
  } finally { await s.close(); }
});

test('T3 across the boundary with a restart in between: one send per decision, run ids continue, an undecided cost stays held, the day cap rolls over and the total does not', async () => {
  // The second model call times out (undecided) just before the boundary.
  const s = await setup({ script: (body, n) => n === 1 ? { delayMs: 250, answer: answerFirst(body) } : { answer: answerFirst(body) }, timeoutMs: 60 });
  try {
    await s.ap.start({ by: 'owner' });
    const t1 = await s.ap.tick();
    assert.equal(t1.game[0].outcome, 'sent');
    s.w.settle();
    s.w.advance(60);
    const t2 = await s.ap.tick();
    assert.equal(t2.inference.outcome, 'unknown');
    await new Promise(r => setTimeout(r, 260));
    const held = s.costs.classes().undecided;
    assert.notEqual(held, '0');
    // The day cap now refuses another call today (what was used or held today plus one more quote).
    const quote = s.ap.decider.records.at(-1).quote;
    s.costs.caps.perDay = String(BigInt(s.costs.classes().settled) + BigInt(held) + BigInt(quote) - 1n);
    assert.equal(s.costs.check(quote)?.code, 'CategoryDayLimit');
    const before = { settled: s.costs.classes().settled, sends: s.w.sentCount(), snapshot: JSON.stringify(s.costs.toJSON()) };
    // The process stops; the boundary passes (UTC midnight of the world clock); a new process starts from the snapshot.
    s.ap.stop({ by: 'process exit' });
    const day0 = new Date(s.now()).toISOString().slice(0, 10);
    s.w.advance(DAY - ((s.w.state.clock) % DAY) + 30);
    assert.notEqual(new Date(s.now()).toISOString().slice(0, 10), day0, 'the boundary was crossed');
    const costs2 = RunCostMock.fromJSON(JSON.parse(before.snapshot), { now: s.now });
    assert.equal(costs2.classes().undecided, held, 'the undecided cost survived the restart and the boundary');
    assert.equal(costs2.classes().settled, before.settled);
    assert.equal(costs2.check(quote), null, 'the day cap rolled over');
    costs2.caps.total = String(BigInt(before.settled) + BigInt(held) + BigInt(quote) - 1n);
    assert.equal(costs2.check(quote)?.code, 'CategoryTotalLimit', 'the total still counts what came before the boundary');
    costs2.caps.total = '1000000';
    const ap2 = s.make(costs2);
    assert.equal(ap2.ticks, 2, 'the new process continues the journal\'s run ids');
    await ap2.start({ by: 'owner' });
    const t3 = await ap2.tick();
    assert.match(t3.runId, /:t3$/);
    assert.equal(t3.game[0].outcome, 'sent');
    s.w.settle();
    // One relay send per sent decision; no requestId begun twice; the relay's books are sound.
    const begun = s.journal.entries.filter(e => e.step === 'act-begin').map(e => e.attemptId);
    assert.equal(new Set(begun).size, begun.length);
    assert.equal(s.w.sentCount(), before.sends + 1);
    assert.deepEqual(s.w.books(), []);
    assert.equal(costs2.classes().undecided, held, 'still held: only an outside answer moves it');
    ap2.stop({ by: 'test' });
  } finally { await s.close(); }
});

test('T4 today\'s core: the Citizen\'s address comes from the season id — when the relay finds no Citizen (as after a season-id switch), ⑤ pays for nothing and keeps its costs; it resumes when the Citizen is there again', async () => {
  const s = await setup({ script: body => ({ answer: answerFirst(body) }) });
  try {
    await s.ap.start({ by: 'owner' });
    await s.ap.tick();
    const addr = s.w.relay.ctx.addresses.citizen(s.w.owner);
    const saved = s.w.relay.chain.accounts.get(addr);
    s.w.relay.chain.accounts.delete(addr);              // the relay's season-scoped address now names no Citizen
    const calls = s.srv.requests();
    const costsBefore = JSON.stringify(s.costs.classes());
    s.w.advance(60);
    const t = await s.ap.tick();
    // The grant itself is invalid (no Citizen, so no delegation): the run is blocked before the decider is asked.
    assert.equal(t.status, 'blocked');
    assert.equal(t.inference, null);
    assert.equal(s.srv.requests(), calls);
    assert.equal(JSON.stringify(s.costs.classes()), costsBefore);
    s.w.relay.chain.accounts.set(addr, saved);
    s.w.advance(60);
    assert.equal((await s.ap.tick()).game[0].outcome, 'sent');
    s.ap.stop({ by: 'test' });
  } finally { await s.close(); }
});

test('T5 long-running state: 60 days of calls compact to per-day sums with exact caps; undecided costs are never compacted; snapshots round-trip; memory stays bounded', () => {
  let clock = Date.UTC(2027, 0, 1);
  const now = () => clock;
  const a = new RunCostMock({ available: '1000000000', caps: { total: '1000000000', perDay: '100000' }, now });
  const twin = new RunCostMock({ available: '1000000000', caps: { total: '1000000000', perDay: '100000' }, now });
  const keysByDay = [];
  for (let d = 0; d < 60; d++) {
    const ks = [];
    for (let i = 0; i < 200; i++) {
      const k = `d05-${d}-${i}#0`;
      for (const c of [a, twin]) { c.reserve(k, '100'); c.calling(k); if (d === 0 && i < 3) c.undecided(k, 'timeout'); else if (i % 10 === 0) c.release(k, 'not sent'); else c.settle(k, '70'); }
      ks.push(k);
    }
    keysByDay.push(ks);
    a.compact({ beforeDay: new Date(clock).toISOString().slice(0, 10) });
    clock += 86_400_000;
  }
  // 12,000 items in the twin; the compacted ledger keeps today's and the undecided ones only.
  assert.equal(twin.items.size, 12_000);
  assert.ok(a.items.size <= 200 + 3, `items kept: ${a.items.size}`);
  assert.deepEqual(a.classes(), twin.classes(), 'every class sums the same');
  assert.equal(a.classes().undecided, '300');
  for (const k of ['d05-0-0#0', 'd05-0-1#0', 'd05-0-2#0']) assert.equal(a.items.get(k).state, 'undecided');
  // The caps see the folded days: the same answers as the uncompacted twin.
  for (const amt of ['1', '100000']) assert.deepEqual(a.check(amt), twin.check(amt));
  // Keys are remembered for KEY_RETENTION_DAYS: a recent one cannot be reserved again; a key older than that is forgotten.
  assert.ok(a.archive.keys.size <= (KEY_RETENTION_DAYS + 1) * 200);
  assert.throws(() => a.reserve(keysByDay[58][5], '1'), e => e.code === 'DuplicateKey');
  assert.equal(a.archive.keys.has(keysByDay[1][5]), false);
  // A snapshot round-trips (and applies the restart rule to anything in flight).
  const b = RunCostMock.fromJSON(JSON.parse(JSON.stringify(a.toJSON())), { now });
  assert.deepEqual(b.classes(), a.classes());
  assert.ok(a.log.length <= 2_000, 'the debug log is bounded');
  // The decision registry keeps a bounded number of finished decisions.
  const r = new DecisionRegistry({ maxDone: 100 });
  for (let i = 0; i < 1_000; i++) r.remember(`k${i}`, { i });
  assert.equal(r.done.size, 100);
  assert.ok(r.done.has('k999') && !r.done.has('k0'));
});
