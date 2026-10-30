// Three clients on ONE Citizen and ONE agent, on the real relay: ③'s REAL MCP server (the owner's own operations),
// ⑤'s autopilot (model behind the HTTP fixture), and a STAND-IN for ④'s executor (relay submit with ws04: keys).
// Scenarios for ④ (CONTENTION-SCENARIOS.ja.md lists each with its invariant, and maps what other suites already cover):
//   C1 two budgets, no double reservation   C2 the caravan number   C3 the owner's manual stop first
//   C4 ⑤'s stop and cancel do not stop ③/④  C5 ⑤ restarted between ③'s operations
// Env-gated (ws03-harness.mjs). [SIMULATED CHAIN]: the program is not executed, so the chain's own seq check is not
// either; where a scenario needs the chain's answer, the test says what it emulates.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autopilotOver, fourStandIn, load, sharedWorld, skip, threeSend, trainFirst } from './ws03-harness.mjs';

const relayUsed = v => BigInt(v.balance.reserved) + BigInt(v.balance.spent.inference) + BigInt(v.balance.spent.game);

test('C1 two budgets, no double reservation: ③, ⑤ and ④ race for a relay budget of two priced actions; ⑤\'s inference is a separate ledger', { skip }, async ctx => {
  const L = await load();
  // The relay budget fits two priced actions (TEST prices: SendCaravan and Train 20,000 each; budget 50,000).
  const { w, s, three, cap } = await sharedWorld(L, { prices: { game: { SendCaravan: '20000', Train: '20000' } }, budget: ['50000', '50000'] });
  const four = fourStandIn(L, w, cap);
  try {
    // ③'s test world deposits nothing: the owner's test-USDC deposit (the gateway fixture's own helper; real Custody check).
    await L.f.fx.deposit(w.r, w.o, w.agent.agentId, 100_000n);
    assert.equal(w.r.gateway.view(w.agent.agentId).balance.available, '100000');
    const a = await threeSend(three, 'req-c1-000001');
    const r3 = await a.send();
    assert.equal(r3.state, 'accepted', JSON.stringify(r3).slice(0, 200));
    w.state.caravans += 1; // the chain's CARAVANS after ③'s caravan (emulated)
    const five = await autopilotOver(L, w, () => cap.token, { script: body => ({ answer: trainFirst(body) }) });
    try {
      await five.ap.start({ by: 'owner' });
      const [t, r4] = await Promise.all([five.ap.tick(), four.send('run-c1', 0, { seq: 1 })]);
      const v = await five.view();
      // The relay: one ledger for all three; never past the budget, never a request held twice.
      assert.ok(relayUsed(v) <= 50_000n, `relay used ${relayUsed(v)}`);
      const keys = v.history.filter(h => h.type === 'action').map(h => h.key);
      assert.equal(new Set(keys).size, keys.length, 'every idempotency key at most once');
      const priced = [r3.state === 'accepted', r4.status === 'sent', t.game.some(g => g.outcome === 'sent')].filter(Boolean).length;
      ctx.diagnostic(`C1 outcomes: ③ ${r3.state}; ④ ${r4.status}${r4.error ? ` ${r4.error.code}` : ''}; ⑤ ${t.game.map(g => `${g.outcome}${g.code ? ` ${g.code}` : ''}`).join(',') || 'none'}; relay used ${relayUsed(v)}`);
      assert.ok(priced <= 2, `priced actions sent: ${priced}`);
      if (r4.status !== 'sent') assert.ok(['BudgetExceeded', 'Duplicate'].includes(r4.error?.code), JSON.stringify(r4.error));
      assert.deepEqual(w.r.gateway.ledger.check(), []);
      // ⑤'s inference cost: its own ledger (test-USDC), keyed by ⑤'s decision keys only; the relay's ledger never holds it.
      assert.ok([...five.costs.items.keys()].every(k => /^d05-/.test(k)));
      assert.equal(v.balance.spent.inference, '0', 'the relay meter was not used by ⑤\'s API path');
    } finally { five.ap.stop({ by: 'test' }); await five.srv.close(); }
  } finally { await s.close(); }
});

test('C1b the shared relay budget bites across clients: ③ and ⑤ use it up; ④\'s priced send is refused (BudgetExceeded) with nothing held or sent', { skip }, async () => {
  const L = await load();
  const { w, s, three, cap } = await sharedWorld(L, { prices: { game: { SendCaravan: '20000', Train: '20000' } }, budget: ['50000', '50000'] });
  const four = fourStandIn(L, w, cap);
  try {
    await L.f.fx.deposit(w.r, w.o, w.agent.agentId, 100_000n);
    const a = await threeSend(three, 'req-c1b-00001');
    assert.equal((await a.send()).state, 'accepted');          // ③: 20,000 held
    w.state.caravans += 1;
    const five = await autopilotOver(L, w, () => cap.token, { script: body => ({ answer: trainFirst(body) }) });
    try {
      await five.ap.start({ by: 'owner' });
      const t = await five.ap.tick();                           // nobody else acts during this tick
      assert.equal(t.game[0].outcome, 'sent', JSON.stringify(t.game));  // ⑤: 20,000 held
      const before = { sent: w.r.chain.sent.length, used: relayUsed(await five.view()) };
      assert.equal(before.used, 40_000n);
      const r4 = await four.send('run-c1b', 0, { seq: 1 });     // ④: 20,000 more would make 60,000 > 50,000
      assert.equal(r4.status, 'refused');
      assert.equal(r4.error?.code, 'BudgetExceeded', JSON.stringify(r4.error));
      assert.deepEqual(r4.charges, []);
      assert.equal(w.r.chain.sent.length, before.sent);
      assert.equal(relayUsed(await five.view()), 40_000n, 'nothing held for the refused request');
      assert.deepEqual(w.r.gateway.ledger.check(), []);
      assert.equal(five.costs.fourClasses().unit, 'test-USDC base units (model inference)', '⑤\'s inference ledger is apart from the relay\'s');
    } finally { five.ap.stop({ by: 'test' }); await five.srv.close(); }
  } finally { await s.close(); }
});

test('C2 the caravan number: ④ takes the seq after ③ planned — ③ refuses its stale plan (PlanStale), nothing sent; ⑤ sends no caravans and yields to ④\'s entry', { skip }, async () => {
  const L = await load();
  const { w, s, three, cap } = await sharedWorld(L);
  const four = fourStandIn(L, w, cap);
  try {
    const first = await threeSend(three, 'req-c2-000001');
    assert.equal((await first.send()).state, 'accepted');
    w.state.caravans = 1;                                      // emulated: the chain advanced CARAVANS
    const second = await threeSend(three, 'req-c2-000002');   // ③ plans with seq 1
    assert.equal(second.plan.summary?.seq ?? 1, 1);
    const r4 = await four.send('run-c2', 0, { seq: 1 });       // ④ sends seq 1 first
    assert.equal(r4.status, 'sent');
    w.state.caravans = 2;                                      // emulated: ④'s caravan landed and took seq 1
    const sentBefore = w.r.chain.sent.length;
    const r3 = await second.send();
    assert.equal(r3.error?.code, 'PlanStale', JSON.stringify(r3).slice(0, 200));
    assert.equal(w.r.chain.sent.length, sentBefore, '③ sent nothing on a stale plan');
    // ⑤: its observation sees ④'s ws04: entry after the mark only if ④ acts during the tick; here ④ acted before,
    // so ⑤ acts — and it never sends a caravan (NOT_FOR_AUTOPILOT), so it cannot take a seq.
    const five = await autopilotOver(L, w, () => cap.token, { script: body => ({ answer: trainFirst(body) }) });
    try {
      await five.ap.start({ by: 'owner' });
      const t = await five.ap.tick();
      assert.ok(t.game.every(g => g.proposed?.name !== 'SendCaravan'));
    } finally { five.ap.stop({ by: 'test' }); await five.srv.close(); }
  } finally { await s.close(); }
});

test('C3 the owner\'s manual stop goes first: during ⑤\'s model call the owner switches to manual — ⑤ does not act (its inference is still paid, not released); ③ and ④ are refused (AgentStopped); after auto, old observations and plans are stale', { skip }, async () => {
  const L = await load();
  const { w, s, three, cap } = await sharedWorld(L);
  const four = fourStandIn(L, w, cap);
  try {
    const warm = await threeSend(three, 'req-c3-000001');
    assert.equal((await warm.send()).state, 'accepted');
    w.state.caravans = 1;
    const plan = await threeSend(three, 'req-c3-000002');      // planned under mode epoch 1
    const owner = mode => L.f.fx.call(w.r.public, 'POST', '/f/agent/command', { body: L.f.fx.ownerCommand(w.owner, 'mode', { agentId: w.agent.agentId, params: { mode } }) });
    const five = await autopilotOver(L, w, () => cap.token, { script: async body => { await owner('manual'); return { answer: trainFirst(body) }; } });
    try {
      await five.ap.start({ by: 'owner' });
      const t = await five.ap.tick();
      assert.equal(t.inference.status, 'ok');
      assert.equal(t.game[0].outcome, 'skipped');
      assert.ok(['StaleObservation', 'OwnerActed'].includes(t.game[0].code), t.game[0].code);
      assert.equal(five.costs.classes().settled !== '0', true, 'the model call was made and is paid');
      assert.equal(five.costs.classes().released, '0');
      const r3 = await plan.send();
      assert.equal(r3.error?.code, 'AgentStopped', JSON.stringify(r3).slice(0, 200));
      const r4 = await four.send('run-c3', 0, { seq: 1 });
      assert.equal(r4.error?.code, 'AgentStopped');
      await owner('auto');                                      // a new mode epoch
      const stale = await four.send('run-c3', 1, { seq: 1 });   // still the epoch-1 request
      assert.equal(stale.error?.code, 'StaleMode');
      const again = await plan.send();
      assert.ok(['StaleMode', 'PlanStale', 'AgentStopped'].includes(again.error?.code), JSON.stringify(again).slice(0, 200));
      assert.equal(w.r.chain.sent.length, 1, 'only the warm-up caravan');
    } finally { five.ap.stop({ by: 'test' }); await five.srv.close(); }
  } finally { await s.close(); }
});

test('C4 ⑤\'s stop and cancel stop only ⑤: ③ and ④ keep sending; ⑤\'s receipt says Completed with no effects, on the relay\'s record', { skip }, async () => {
  const L = await load();
  const { w, s, three, cap } = await sharedWorld(L);
  const four = fourStandIn(L, w, cap);
  try {
    const warm = await threeSend(three, 'req-c4-000001');
    assert.equal((await warm.send()).state, 'accepted');
    w.state.caravans = 1;
    let runId = null;
    const five = await autopilotOver(L, w, () => cap.token, { script: body => ({ answer: trainFirst(body) }) });
    try {
      await five.ap.start({ by: 'owner' });
      five.ap.stop({ by: 'owner' });                            // ⑤ only
      assert.deepEqual(await five.ap.tick(), { skipped: true, state: 'stopped' });
      await five.receipts.open({ runId: 'c4-run' });
      five.receipts.cancel('c4-run', 'before-sign');
      runId = 'c4-run';
      const ph = five.receipts.cancelPhase(runId);
      assert.equal(ph.phase, 'Completed');
      assert.deepEqual(ph.effects, []);
      assert.match(ph.basis, /not ④'s run store/);
      const r4 = await four.send('run-c4', 0, { seq: 1 });
      assert.equal(r4.status, 'sent', 'the relay mode is still auto: ④ is not stopped by ⑤');
      w.state.caravans = 2;
      const next = await threeSend(three, 'req-c4-000002');
      assert.equal((await next.send()).state, 'accepted', '③ is not stopped by ⑤');
      assert.equal(five.srv.requests(), 0, '⑤ called no model after its stop');
    } finally { await five.srv.close(); }
  } finally { await s.close(); }
});

test('C5 ⑤ restarted between ③\'s operations: the new process continues its run ids, marks after ③\'s entries, and acts once', { skip }, async () => {
  const L = await load();
  const { w, s, three, cap } = await sharedWorld(L);
  try {
    const a = await threeSend(three, 'req-c5-000001');
    assert.equal((await a.send()).state, 'accepted');
    w.state.caravans = 1;
    const five = await autopilotOver(L, w, () => cap.token, { script: body => ({ answer: trainFirst(body) }) });
    try {
      await five.ap.start({ by: 'owner' });
      const t1 = await five.ap.tick();
      assert.equal(t1.game[0].outcome, 'sent');
      five.ap.stop({ by: 'process exit' });
      const b = await threeSend(three, 'req-c5-000002');       // ③ acts while ⑤ is down
      assert.equal((await b.send()).state, 'accepted');
      w.state.caravans = 2;
      const restarted = new L.Autopilot({ world: five.world, mandate: five.mandate, decider: five.decider, journal: five.journal, citizen: new L.CitizenBoundary({ ownerQuotaReserve: 1 }), receipts: five.receipts, mcp: five.world.mcp });
      assert.equal(restarted.ticks, 1);
      await restarted.start({ by: 'owner' });
      const t2 = await restarted.tick();
      assert.match(t2.runId, /:t2$/);
      assert.equal(t2.game[0].outcome, 'sent', '③\'s entry is before the new mark: ⑤ acts on the fresh observation');
      const fives = (await five.view()).history.filter(h => h.type === 'action' && /p05\./.test(h.key));
      assert.equal(new Set(fives.map(h => h.key)).size, fives.length);
      assert.equal(fives.length, 2);
      restarted.stop({ by: 'test' });
    } finally { await five.srv.close(); }
  } finally { await s.close(); }
});
