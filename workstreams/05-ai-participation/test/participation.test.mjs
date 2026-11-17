// The proxy agent's participation in a nation's activity, on the local world
// (the real relay, agent wallet and MCP server over the gateway tests'
// scripted chain; the program's effects emulated; see src/local-world.mjs).
// Each test names the case of the brief it reproduces. No network, no
// outside model: every "model" here is a scripted stand-in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CommandContract, OUTCOME, RunJournal, gatewayBuilds } from '../src/adapters.mjs';
import { modelDecider, ruleDecider } from '../src/deciders.mjs';
import { OPERATOR_SECRET_MARKER, hostileRequests, northernRequests, scriptedLlm } from '../src/local-world.mjs';
import { item, mandateFor, run, settleAndVerify, world } from './helpers.mjs';

const OPERATOR_TOKEN = 'op-token'; // the relay fixture's operator token

// ------------------------------------------------------------------ the happy path and the current support

test('the demo path: read the board → check stores and grant → propose → act inside the grant → confirm landing and effect', async () => {
  const w = await world();
  const before = w.sentCount();
  const { report, journal } = await run(w);
  assert.equal(report.status, 'done');
  assert.equal(item(report, 'N-1').outcome, OUTCOME.SENT);
  assert.deepEqual(item(report, 'N-1').command, { name: 'Train', fields: { unit: 0, n: 200 } });
  assert.equal(w.sentCount(), before + 1, 'exactly one transaction');
  // Not yet a success: nothing is remembered before the chain and the world answer.
  assert.deepEqual(journal.memory(), []);
  const v = await settleAndVerify(w, journal);
  assert.equal(v[0].outcome, OUTCOME.CONTRIBUTED);
  assert.equal(w.state.reserve.Spearman, 200);
  assert.deepEqual(journal.memory().map(m => [m.requestId, m.outcome, m.verified]), [['N-1', 'contributed', true]]);
  // The rest of the board: each with a reason and the owner's decision, nothing invented.
  assert.deepEqual([item(report, 'N-2').code, item(report, 'N-3').code, item(report, 'N-4').code], ['WalletRequired', 'DecidedNotForProxy', 'NotImplemented']);
  for (const id of ['N-2', 'N-3', 'N-4']) { assert.equal(item(report, id).outcome, OUTCOME.NEEDS_OWNER); assert.ok(item(report, id).ownerDecision); }
  assert.deepEqual(report.ignored.map(x => [x.requestId, x.code]).sort(), [['N-5', 'RequestExpired'], ['N-6', 'NotOurNation']]);
});

test('the command contract is read from the code: caravans, votes and structures have no agent path today', () => {
  const c = new CommandContract();
  for (const n of ['Harvest', 'Build', 'Train', 'Muster', 'Garrison', 'Explore', 'Depart', 'Dissolve', 'SetVigil']) assert.equal(gatewayBuilds(n), true, n);
  for (const n of ['SendCaravan', 'Vote', 'Propose', 'BuildVault', 'BuildStructure', 'FortGarrison', 'RaidCaravan', 'SetSession']) assert.equal(gatewayBuilds(n), false, n);
  assert.equal(c.describe('SendCaravan').exists, true);
  assert.equal(c.describe('SendCaravan').agentGateway, false);
  assert.equal(c.check({ name: 'SendCaravan', fields: {} }, { toOtherPlayer: false }).code, 'NoAgentPath');
  assert.equal(c.check({ name: 'SendCaravan', fields: {} }, { toOtherPlayer: true }).code, 'WalletRequired');
  assert.equal(c.check({ name: 'Vote', fields: {} }).code, 'DecidedNotForProxy');
  assert.equal(c.check({ name: 'SetSession', fields: {} }).code, 'NotDelegable');
  assert.equal(c.check({ name: 'UseFacility' }).code, 'NotImplemented');
  assert.equal(c.check({ name: 'TeleportArmy' }).code, 'UnknownCommand');
});

// ------------------------------------------------------------------ limits, deadlines, stops

test('a request above the limits: partial help when the owner allowed it, the owner\'s decision when not', async () => {
  const board = [{ ...northernRequests()[0], ask: { kind: 'train', unit: 0, n: 600 } }];
  const w1 = await world({ requests: board });
  const r1 = (await run(w1)).report;
  assert.equal(item(r1, 'N-1').outcome, OUTCOME.SENT);
  assert.equal(item(r1, 'N-1').command.fields.n, 200, 'clamped to the mandate (200 troops; Food 120 for two batches)');
  const w2 = await world({ requests: board });
  const r2 = (await run(w2, { mandate: mandateFor(w2, { partial: false }) })).report;
  assert.equal(item(r2, 'N-1').outcome, OUTCOME.NEEDS_OWNER);
  assert.equal(item(r2, 'N-1').code, 'ExceedsMandate');
  assert.match(item(r2, 'N-1').ownerDecision, /上限/);
  assert.equal(w2.sentCount(), 0);
});

test('the day limit holds across runs: a second request the same day is stopped at the per-day limit', async () => {
  const board = [northernRequests()[0], { ...northernRequests()[0], id: 'N-1b', title: '第二陣：槍兵200' }];
  const w = await world({ requests: board, stores: { Food: 1000, Ore: 500, Gold: 500 } });
  const m = mandateFor(w, { limits: { perDay: { Food: 150, Ore: 100, Gold: 50 } } });
  const { report } = await run(w, { mandate: m });
  assert.equal(item(report, 'N-1').outcome, OUTCOME.SENT);
  // 200 troops cost Food 120; the second can take only one batch (Food 60 would make 180 > 150): nothing more fits.
  assert.notEqual(item(report, 'N-1b')?.outcome, OUTCOME.SENT);
  assert.equal(w.sentCount(), 1);
});

test('expired: a past-deadline request, an expired mandate, an expired delegation', async () => {
  const w = await world();
  // A model that answers the expired request anyway.
  const llm = scriptedLlm(() => ({ proposals: [{ request: 'N-5', action: 'Train', fields: { unit: 0, n: 100 }, reason: 'old one' }], skipped: [] }));
  const r = (await run(w, { decider: modelDecider({ llm }) })).report;
  // The model is not even shown it (only open requests are), and a proposal for it is refused.
  assert.equal(JSON.stringify(llm.calls[0].messages).includes('N-5'), false);
  assert.equal(item(r, 'N-5').code, 'RequestExpired');
  assert.equal(w.sentCount(), 0);
  const w2 = await world();
  const r2 = (await run(w2, { mandate: mandateFor(w2, { expiresAt: w2.state.clock - 1 }) })).report;
  assert.equal(r2.status, 'blocked');
  assert.deepEqual(r2.blocked.map(b => b.code), ['MandateExpired']);
  const w3 = await world();
  w3.sessionExpiresAt(w3.state.clock - 1);
  const r3 = (await run(w3)).report;
  assert.equal(r3.status, 'blocked');
  assert.deepEqual(r3.blocked.map(b => b.code), ['SessionNotDelegated']);
  assert.equal(w2.sentCount() + w3.sentCount(), 0);
});

test('stopped or revoked: before the run, between the plan and the act, and at the last moment (the relay refuses)', async () => {
  // Stopped before: nothing is planned.
  const w = await world();
  await w.ownerSetMode('manual');
  const r = (await run(w)).report;
  assert.deepEqual([r.status, r.blocked.map(b => b.code)], ['blocked', ['AgentStopped']]);
  // Stopped while the plan was made (a slow decider): the fresh view before acting sees it; nothing is sent.
  const w2 = await world();
  const slow = { name: 'rules-slow', free: true, async plan(...a) { const p = await ruleDecider().plan(...a); await w2.ownerSetMode('manual'); return p; } };
  const r2 = (await run(w2, { decider: slow })).report;
  assert.equal(item(r2, 'N-1').outcome, OUTCOME.SKIPPED);
  assert.equal(item(r2, 'N-1').code, 'StaleObservation');
  assert.equal(w2.sentCount(), 0);
  // Stopped and restarted after the fresh view, right before agent_act: the relay refuses the old epoch.
  const w3 = await world();
  const r3 = (await run(w3, { crash: async step => { if (step === 'act-begin') { await w3.ownerSetMode('manual'); await w3.ownerSetMode('auto'); } } })).report;
  assert.equal(item(r3, 'N-1').outcome, 'refused');
  assert.equal(item(r3, 'N-1').code, 'StaleMode');
  assert.equal(w3.sentCount(), 0);
  // The owner rotated the capability: the old one is refused at agent_act. (Found here: agent_view is a public read,
  // GET /f/agent?id=, so the old token still reads the view and plans; only the act is refused. A model decider would
  // have paid for its call first: see MCP-EXTENSIONS.ja.md, agent_whoami.)
  const w4 = await world();
  await w4.ownerRotate();
  const r4 = (await run(w4)).report;
  assert.equal(r4.status, 'done');
  assert.deepEqual([item(r4, 'N-1').outcome, item(r4, 'N-1').code], ['refused', 'BadCapability']);
  // The owner took the key back on chain (SetSession): the view shows it; nothing is planned.
  const w5 = await world();
  w5.ownerTakeKeyBack();
  const r5 = (await run(w5)).report;
  assert.deepEqual(r5.blocked.map(b => b.code), ['SessionNotDelegated']);
  // The owner revoked the mandate.
  const w6 = await world();
  const r6 = (await run(w6, { mandate: mandateFor(w6, { revokedAt: w6.state.clock - 5 }) })).report;
  assert.deepEqual(r6.blocked.map(b => b.code), ['MandateRevoked']);
  assert.equal(w4.sentCount() + w5.sentCount() + w6.sentCount(), 0);
});

// ------------------------------------------------------------------ stale, duplicate, failure, restart

test('a stale observation: the world clock moved past the limit while deciding; a policy change; the mandate written for an old policy', async () => {
  const w = await world();
  const slow = { name: 'rules-slow', free: true, async plan(...a) { const p = await ruleDecider().plan(...a); w.advance(900); return p; } };
  const r = (await run(w, { decider: slow, maxObsAgeSec: 300 })).report;
  assert.equal(item(r, 'N-1').code, 'StaleObservation');
  assert.equal(w.sentCount(), 0);
  // The owner changed the policy while the plan was made: version 1 → 2.
  const w2 = await world();
  const written = mandateFor(w2); // the owner wrote it against policy 1
  const bump = { name: 'rules-slow', free: true, async plan(...a) { const p = await ruleDecider().plan(...a); await w2.ownerSetPolicy({ allowed: ['economy'], budget: { total: '1000000', perDay: '1000000' } }); return p; } };
  const r2 = (await run(w2, { decider: bump, mandate: written })).report;
  assert.equal(item(r2, 'N-1').code, 'StaleObservation');
  assert.match(item(r2, 'N-1').reason, /版 1 から 2/);
  assert.equal(w2.sentCount(), 0);
  // The next run: the mandate still names policy 1, so the proxy stops until the owner looks again.
  const r3 = (await run(w2, { mandate: written })).report;
  assert.deepEqual(r3.blocked.map(b => b.code), ['MandatePolicyChanged']);
  // The owner re-writes the mandate for policy 2: it acts again.
  const r4 = (await run(w2, { mandate: mandateFor(w2, { version: 2 }) })).report;
  assert.equal(item(r4, 'N-1').outcome, OUTCOME.SENT);
  // A policy change right before agent_act: the relay refuses the old version.
  const w3 = await world();
  const r5 = (await run(w3, { crash: async step => { if (step === 'act-begin') await w3.ownerSetPolicy({ allowed: ['economy'], budget: { total: '1000000', perDay: '1000000' } }); } })).report;
  assert.equal(item(r5, 'N-1').code, 'StalePolicy');
  assert.equal(w3.sentCount(), 0);
});

test('duplicates: the same request in a second run, and the same requestId from a restarted MCP server, are sent once', async () => {
  const w = await world();
  const journal = new RunJournal();
  await run(w, { journal, runId: 'a' });
  assert.equal(w.sentCount(), 1);
  const again = (await run(w, { journal, runId: 'b' })).report;
  // The rules see the contribution in the journal and do not propose it again.
  assert.equal(item(again, 'N-1'), undefined);
  assert.ok(again.notes.some(n => n.requestId === 'N-1' && n.code === 'AlreadyContributed'));
  // A model that proposes it again anyway is stopped by the journal before the relay.
  const llm = scriptedLlm(() => ({ proposals: [{ request: 'N-1', action: 'Train', fields: { unit: 0, n: 200 }, reason: 'again' }], skipped: [] }));
  const again2 = (await run(w, { journal, runId: 'b2', decider: modelDecider({ llm }) })).report;
  assert.equal(item(again2, 'N-1').code, 'Duplicate');
  assert.equal(w.sentCount(), 1);
  // A different journal (lost) but the same decision: the gateway's idempotency answers with the recorded result.
  const lost = (await run(w, { runId: 'c' })).report;
  assert.equal(item(lost, 'N-1').outcome, OUTCOME.SENT);
  assert.equal(w.sentCount(), 1, 'the gateway replayed the same requestId instead of sending again');
});

test('tool failure: the relay unreachable once is retried with the same requestId; unreachable throughout is unknown, never a success, and finished next run', async () => {
  const w = await world();
  w.faults.relayDown = 0;
  const journal = new RunJournal();
  // Drop exactly the first agent_act (two agent_view reads and the act's own view read come first).
  const realFetch = w.fetch;
  let acts = 0;
  w.fetch = async (url, init) => { if (init?.method === 'POST' && ++acts === 1) throw new Error('ECONNRESET'); return realFetch(url, init); };
  const r = (await run(w, { journal, mcp: w.mcp() })).report;
  assert.equal(item(r, 'N-1').outcome, OUTCOME.SENT);
  assert.equal(item(r, 'N-1').attempts, 2);
  assert.equal(w.sentCount(), 1);

  const w2 = await world();
  const j2 = new RunJournal();
  const realFetch2 = w2.fetch;
  let down = true;
  w2.fetch = async (url, init) => { if (down && init?.method === 'POST') throw new Error('ECONNREFUSED'); return realFetch2(url, init); };
  const r2 = (await run(w2, { journal: j2, mcp: w2.mcp() })).report;
  assert.equal(item(r2, 'N-1').outcome, OUTCOME.UNKNOWN);
  assert.equal(w2.sentCount(), 0);
  assert.deepEqual(j2.memory(), [], 'an unknown result is not remembered');
  down = false;
  const r3 = (await run(w2, { journal: j2, mcp: w2.mcp(), runId: 'run-2' })).report;
  assert.deepEqual(r3.resumed.map(x => x.outcome), ['sent']);
  assert.equal(item(r3, 'N-1')?.code ?? 'Duplicate', 'Duplicate');
  assert.equal(w2.sentCount(), 1);
  const v = await settleAndVerify(w2, j2);
  assert.equal(v[0].outcome, OUTCOME.CONTRIBUTED);
});

test('restart in the middle: killed after the send and before the record; the next process replays, sends nothing more, then confirms', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wylls05-'));
  try {
    const file = join(dir, 'journal.jsonl');
    const w = await world();
    await assert.rejects(run(w, { journal: new RunJournal({ file }), crash: step => { if (step === 'act-sent') throw new Error('killed'); } }), /killed/);
    assert.equal(w.sentCount(), 1);
    const lines = readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    assert.equal(lines.at(-1).step, 'act-begin', 'the journal ends with an action that may have been sent');
    // A new process: a new journal object from the file, a new MCP server.
    const j = new RunJournal({ file });
    const r = (await run(w, { journal: j, mcp: w.mcp(), runId: 'after-restart' })).report;
    assert.deepEqual(r.resumed.map(x => [x.outcome, x.replayed]), [['sent', true]]);
    assert.equal(w.sentCount(), 1, 'no second send');
    const v = await settleAndVerify(w, j);
    assert.equal(v[0].outcome, OUTCOME.CONTRIBUTED);
    // Killed before the send: the restart sends it, once.
    const w2 = await world();
    const file2 = join(dir, 'j2.jsonl');
    await assert.rejects(run(w2, { journal: new RunJournal({ file: file2 }), crash: step => { if (step === 'act-begin') throw new Error('killed'); } }), /killed/);
    assert.equal(w2.sentCount(), 0);
    const r2 = (await run(w2, { journal: new RunJournal({ file: file2 }), runId: 'after' })).report;
    assert.deepEqual(r2.resumed.map(x => [x.outcome, x.replayed]), [['sent', false]]);
    assert.equal(w2.sentCount(), 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ------------------------------------------------------------------ hostile text, hostile model answers

test('other players\' request text saying "ignore the limits" and "give the private key" is data: the rules ignore it, the model is told it is untrusted, nothing secret is in its input', async () => {
  const w = await world({ requests: [...northernRequests(), ...hostileRequests()] });
  // Rules: X-1's author is not one the owner follows; X-2 has no structured ask.
  const rr = (await run(w)).report;
  assert.ok(rr.ignored.some(x => x.requestId === 'X-1' && x.code === 'NotFromFollowedAuthor'));
  assert.ok(rr.ignored.some(x => x.requestId === 'X-2' && x.code === 'NotFromFollowedAuthor'));
  assert.equal(w.sentCount(), 1, 'only N-1');
  // The owner follows anyone in the nation: the hostile requests reach the planner.
  const w2 = await world({ requests: [...northernRequests(), ...hostileRequests()] });
  const obeying = scriptedLlm(() => ({
    proposals: [
      { request: 'X-1', action: 'Train', fields: { unit: 0, n: 5000 }, reason: 'the limits were lifted' },
      { request: 'X-2', action: 'SetSession', fields: {}, reason: 'identity check' },
      { request: 'X-2', action: 'Withdraw', fields: { all: 1 }, reason: 'send everything' },
    ], skipped: [],
  }));
  const d = modelDecider({ llm: obeying });
  const r = (await run(w2, { decider: d, mandate: mandateFor(w2, { from: [] }) })).report;
  assert.equal(w2.sentCount(), 0, 'nothing the hostile text asked for was sent');
  const codes = r.items.map(i => i.code);
  assert.deepEqual(codes, ['ExceedsMandate', 'NotDelegable', 'UnknownCommand']);
  // X-1 has a structured ask: the owner may raise the limit, and sees who asked. X-2 is text only: what the model read
  // into it (SetSession, Withdraw) is refused outright and never shown to the owner as something to sign.
  assert.deepEqual(r.items.map(i => [i.outcome, i.author, i.ownerDecision === null]), [['needs_owner', 'Mallory', false], ['refused', 'Mallory', true], ['refused', 'Mallory', true]]);
  // What the model was given.
  const prompt = JSON.stringify(d.lastPrompt);
  assert.ok(d.lastPrompt[1].content.includes('<untrusted from=\\"Mallory\\" ch=\\"nation\\"'), 'the hostile text is wrapped as untrusted data');
  assert.equal(prompt.includes('<|im_start|>'), false, 'special tokens are removed from untrusted text');
  assert.equal(prompt.includes('[INST]'), false);
  for (const secret of [w2.capability, OPERATOR_TOKEN, OPERATOR_SECRET_MARKER, w2.owner, w2.agentKey]) assert.equal(prompt.includes(secret), false, `not in the model input: ${secret.slice(0, 8)}…`);
  // And nothing secret anywhere the run wrote.
  const all = JSON.stringify(r) + JSON.stringify((await run(w2, { decider: d, mandate: mandateFor(w2, { from: [] }), runId: 'again' })).journal.entries);
  assert.equal(all.includes(w2.capability), false);
  assert.equal(all.includes(OPERATOR_SECRET_MARKER), false);
});

test('a model that proposes unallowed commands and quantities: each is refused with its reason; the allowed one goes', async () => {
  const w = await world();
  const llm = scriptedLlm(() => ({
    proposals: [
      { request: 'N-1', action: 'Depart', fields: { troops: 200 }, reason: 'march north now' },
      { request: 'N-1', action: 'Train', fields: { unit: 5, n: 200 }, reason: 'knights are better' },
      { request: 'N-1', action: 'Train', fields: { unit: 0, n: 200, holding: 7 }, reason: 'other village' },
      { request: 'N-1', action: 'TeleportArmy', fields: {}, reason: 'fast' },
      { request: 'N-9', action: 'Train', fields: { unit: 0, n: 100 }, reason: 'a request nobody posted' },
      { request: 'N-1', action: 'Train', fields: { unit: 0, n: 200 }, reason: 'as asked' },
    ], skipped: [],
  }));
  const r = (await run(w, { decider: modelDecider({ llm }) })).report;
  assert.deepEqual(r.items.map(i => i.code ?? i.outcome), ['NotWhatWasAsked', 'NotWhatWasAsked', 'BadFields', 'NotWhatWasAsked', 'NoSuchRequest', 'sent']);
  assert.equal(w.sentCount(), 1);
  // A request with no structured ask (free text only): the model's reading is still bounded by the contract and the mandate.
  const w2 = await world({ requests: [{ ...northernRequests()[0], id: 'T-1', ask: null, title: '北が危ない', body: '何か備えて' }] });
  const llm2 = scriptedLlm(() => ({ proposals: [{ request: 'T-1', action: 'Depart', fields: {}, reason: 'go' }, { request: 'T-1', action: 'Train', fields: { unit: 0, n: 900 }, reason: 'many' }], skipped: [] }));
  const r2 = (await run(w2, { decider: modelDecider({ llm: llm2 }) })).report;
  // Depart: the proxy's candidates have no march (the runner never starts one); Train 900: above the mandate's 200.
  assert.deepEqual(r2.items.map(i => i.code), ['NoAgentPath', 'ExceedsMandate']);
  assert.deepEqual(r2.items.map(i => i.outcome), ['refused', 'refused'], 'a text-only request does not raise owner prompts');
  assert.equal(w2.sentCount(), 0);
});

// ------------------------------------------------------------------ cost, unknown results, failures

test('the cost cap: the owner\'s daily call cap and an empty balance stop model calls; the free rules stand in; charges match the ledger', async () => {
  const w = await world({ policy: { allowed: ['economy'], budget: { total: '1000000', perDay: '1000000', callsPerDay: 1 } } });
  const llm = scriptedLlm(() => ({ proposals: [{ request: 'N-1', action: 'Train', fields: { unit: 0, n: 200 }, reason: 'as asked' }], skipped: [] }));
  const journal = new RunJournal();
  const r1 = (await run(w, { decider: modelDecider({ llm }), journal })).report;
  assert.equal(r1.charged, '10000');
  assert.equal(r1.by, 'model:scripted-stand-in');
  const r2 = (await run(w, { decider: modelDecider({ llm }), journal, runId: 'run-2' })).report;
  assert.equal(r2.by, 'rules (after CallLimitReached)');
  assert.equal(r2.charged, '0');
  assert.equal(llm.calls.length, 1, 'the model was not called past the cap');
  assert.equal(w.relay.gateway.view(w.agentId).balance.spent.inference, '10000');
  // No balance at all: the call is never made.
  const w2 = await world({ balance: '0' });
  const llm2 = scriptedLlm(() => ({ proposals: [], skipped: [] }));
  const r3 = (await run(w2, { decider: modelDecider({ llm: llm2 }) })).report;
  assert.equal(r3.by, 'rules (after InsufficientBalance)');
  assert.equal(llm2.calls.length, 0);
  assert.equal(item(r3, 'N-1').outcome, OUTCOME.SENT, 'the free rules still answer the structured request');
});

test('an unknown result: no chain status yet, or landed without the effect showing, is not remembered as a success until both are seen', async () => {
  const w = await world();
  const { journal } = await run(w);
  w.faults.txUnknown = true;
  const v1 = await settleAndVerify(w, journal);
  assert.equal(v1[0].outcome, OUTCOME.UNKNOWN);
  assert.deepEqual(journal.memory(), []);
  // The chain answers later; the herald lags.
  w.faults.txUnknown = false;
  w.settled = 0;
  w.faults.effectLag = true;
  const v2 = await settleAndVerify(w, journal);
  assert.equal(v2[0].outcome, OUTCOME.LANDED);
  assert.deepEqual(journal.memory(), []);
  w.catchUp();
  const v3 = await settleAndVerify(w, journal);
  assert.equal(v3[0].outcome, OUTCOME.CONTRIBUTED);
  assert.equal(journal.memory().length, 1);
  assert.throws(() => journal.remember('x', { outcome: OUTCOME.CONTRIBUTED, verified: false }), /only once the chain and the world confirm/);
});

test('a failed action is remembered as a failure, and a later attempt uses a new requestId (the recorded failure is not replayed)', async () => {
  const w = await world();
  const journal = new RunJournal();
  await run(w, { journal });
  w.faults.txFail = 6017;
  const v = await settleAndVerify(w, journal);
  assert.equal(v[0].outcome, OUTCOME.FAILED);
  assert.deepEqual(journal.memory().map(m => m.outcome), ['failed']);
  assert.equal(w.state.reserve.Spearman, 0);
  // Next run: the rules try again under a new attempt id; the per-day limit still counts the failed send (Food 120 of 300).
  w.faults.txFail = null;
  const r = (await run(w, { journal, runId: 'run-2' })).report;
  assert.equal(item(r, 'N-1').outcome, OUTCOME.SENT);
  const ids = journal.entries.filter(e => e.step === 'act-begin').map(e => e.args.requestId);
  assert.equal(new Set(ids).size, 2);
  assert.equal(w.sentCount(), 2);
});

// ------------------------------------------------------------------ the owner's grant only narrows; the owner's changes change the behaviour

test('the mandate can only narrow the relay\'s policy: a command the policy does not allow stays out, whatever the mandate says', async () => {
  const w = await world({ policy: { allowed: ['vigil'], budget: { total: '1000000', perDay: '1000000' } } });
  const { report, journal } = await run(w);
  const g = journal.entries.find(e => e.step === 'grant');
  assert.deepEqual(g.allowed, []);
  assert.deepEqual(g.deniedByPolicy.sort(), ['Harvest', 'Train']);
  assert.equal(item(report, 'N-1').code, 'NotInMandate');
  assert.match(item(report, 'N-1').reason, /中継の方針が許していない/);
  assert.equal(w.sentCount(), 0);
});

test('what the owner decides changes what the agent does: the purpose\'s limits, the allowed commands, whom to follow, the stop', async () => {
  const outcome = async over => {
    const w = await world({ requests: [...northernRequests(), ...hostileRequests()] });
    if (over === 'stopped') await w.ownerSetMode('manual');
    const { report } = await run(w, { mandate: mandateFor(w, over === 'stopped' ? {} : over) });
    return { status: report.status, sent: report.items.filter(i => i.outcome === 'sent').map(i => `${i.requestId}:${i.command.name}×${i.command.fields.n}`), chain: w.sentCount() };
  };
  assert.deepEqual(await outcome({}), { status: 'done', sent: ['N-1:Train×200'], chain: 1 });
  assert.deepEqual(await outcome({ limits: { troopsPerRequest: 100 } }), { status: 'done', sent: ['N-1:Train×100'], chain: 1 });
  assert.deepEqual(await outcome({ allowed: ['Harvest'] }), { status: 'done', sent: [], chain: 0 });
  // Following anyone in the nation: the rules also answer Mallory's structured ask, up to the same limits (a reason to keep `from`).
  assert.deepEqual(await outcome({ from: [], limits: { perDay: { Food: 600, Ore: 200, Gold: 100 } } }), { status: 'done', sent: ['N-1:Train×200', 'X-1:Train×200'], chain: 2 });
  assert.deepEqual(await outcome('stopped'), { status: 'blocked', sent: [], chain: 0 });
});

test('restart under a revoked mandate: the pending action is held as unknown, not re-sent; once the owner allows again it is sent once', async () => {
  const w = await world();
  const journal = new RunJournal();
  await assert.rejects(run(w, { journal, crash: step => { if (step === 'act-begin') throw new Error('killed'); } }), /killed/);
  assert.equal(w.sentCount(), 0);
  const r = (await run(w, { journal, mandate: mandateFor(w, { revokedAt: w.state.clock - 1 }), runId: 'revoked' })).report;
  assert.equal(r.status, 'blocked');
  assert.deepEqual(r.held.map(h => h.outcome), ['unknown']);
  assert.equal(w.sentCount(), 0, 'not re-sent while the owner has revoked the mandate');
  const r2 = (await run(w, { journal, runId: 'allowed' })).report;
  assert.deepEqual(r2.resumed.map(x => x.outcome), ['sent']);
  assert.equal(w.sentCount(), 1);
});

test('an unreadable delegation is not taken as delegated; two sends of one unit in a run are each confirmed on their own baseline', async () => {
  const w = await world();
  const realFetch = w.fetch;
  // The relay answers the view without the chain's word on the delegation (it could not read the chain).
  w.fetch = async (url, init) => { const res = await realFetch(url, init); if (!url.includes('/f/agent?id=')) return res; const j = await res.json(); return { status: res.status, json: async () => ({ ...j, delegation: null }) }; };
  const r = (await run(w, { mcp: w.mcp() })).report;
  assert.deepEqual(r.blocked.map(b => b.code), ['DelegationUnread']);
  const w2 = await world({ requests: [...northernRequests(), ...hostileRequests()] });
  const { report, journal } = await run(w2, { mandate: mandateFor(w2, { from: [], limits: { perDay: { Food: 600, Ore: 200, Gold: 100 } } }) });
  assert.equal(report.items.filter(i => i.outcome === 'sent').length, 2);
  const begins = journal.entries.filter(e => e.step === 'act-begin');
  assert.deepEqual(begins.map(b => b.baseline), [0, 200]);
  const v = await settleAndVerify(w2, journal);
  assert.deepEqual(v.map(x => [x.outcome, x.effect.expected]), [['contributed', 200], ['contributed', 400]]);
  // The day's committed resources come from the attempts begun (two trainings of 200: Food 240).
  assert.equal(journal.committedToday(w2.state.clock).Food, 240);
});
