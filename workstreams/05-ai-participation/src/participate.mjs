// One participation run of the proxy agent, through the existing MCP tools:
//
//   resume   finish what a previous run began and did not record (same requestId: never sent twice)
//   verify   ask the chain (GET /f/tx) and the world what became of earlier sends; remember only what is confirmed
//   observe  agent_view (mode, policy version, mode epoch, delegation) + the public world: the village, the nation's requests
//   grant    the relay's policy ∩ the owner's mandate (② provisional)
//   plan     the decider's proposals (a model call is metered by the gateway; past a cap the free rules stand in)
//   guard    each proposal against ③, ②, the request and the stores; the owner gets a reason and a decision when it stops
//   act      agent_act with the versions read at observe; a stale view stops the run before anything is sent
//
// Nothing here can widen the agent's authority: every send is agent_act,
// which the relay checks again (AgentGateway.submit).
import { createHash } from 'node:crypto';
import { CommandContract, OUTCOME, grantFrom } from './adapters.mjs';
import { checkProposal, ignoredWhy, parseAsk } from './guard.mjs';
import { ruleDecider } from './deciders.mjs';
import { ERR, sanitize } from './deps.mjs';
import { BUDGET_STOP_CODES } from './staking/budget.mjs';

export const PARTICIPATION_VERSION = 'wylls-05/0.1';

/** Calls one MCP tool through the server's JSON-RPC handler; returns the tool result ({content, structuredContent, isError}). */
export async function tool(mcp, name, args = {}) {
  const res = await mcp.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  if (res.error) return { isError: true, structuredContent: { ok: false, error: { code: 'ToolError', message: res.error.message } } };
  return res.result;
}

/** The deterministic retry key of one contribution (the MCP requestId pattern: 8–100 of A–Z a–z 0–9 . _ : -). */
export const requestIdOf = key => `p05.${createHash('sha256').update(key).digest('hex').slice(0, 40)}`;
const keyOf = (agentId, requestId, name, mandateVersion) => `${agentId}|${requestId}|${name}|m${mandateVersion}`;
/**
 * The relay's answers that are an HTTP error rather than an ActionResult (the MCP server reports them as
 * {ok: false, error: {code}}): the gateway's stable refusals and the rate limit. Nothing was sent for these.
 * Any other code is not known to be a refusal, so it is treated as an unknown outcome and retried later.
 */
const REFUSAL_CODES = new Set([...Object.values(ERR), 'RateLimited']);
/**
 * An agent_act answer as {status, code, signature, replayed, sent, facts}; status null when the outcome is not known.
 * `sent` is the relay's own word (④ 0a5473af: whether signed bytes left); null when the relay predates it. `facts` are
 * the signing facts fixed when the bytes left (signature, lastValidBlockHeight, slotFloor, signedAt).
 */
const resultOf = s => (s?.status ? { status: s.status, code: s.error?.code ?? null, signature: s.signature ?? null, replayed: s.replayed === true, sent: typeof s.sent === 'boolean' ? s.sent : null,
  facts: s.sent === true ? { lastValidBlockHeight: s.lastValidBlockHeight ?? null, slotFloor: s.slotFloor ?? null, signedAt: s.signedAt ?? null } : null }
  : { status: REFUSAL_CODES.has(s?.error?.code) ? OUTCOME.REFUSED : null, code: s?.error?.code ?? 'NoAnswer', signature: null, replayed: false, sent: false, facts: null });
/**
 * A `failed` answer that may have left the relay signed: the relay says `sent: true` (it then gives the signature), or
 * it is an older relay that does not say (④ actionFateView reads such a record as result unknown). It is followed
 * like a sent act — held, counted, never answered with a new requestId — until the chain proves it had no effect.
 * Only `failed` with `sent: false` is "nothing left" (a new attempt may follow).
 */
export const mayHaveLeft = a => a.status === OUTCOME.FAILED && a.sent !== false;
const LIVE = new Set([OUTCOME.SENT, OUTCOME.LANDED, OUTCOME.CONTRIBUTED, OUTCOME.UNKNOWN, OUTCOME.ACTING]);
/** The last journal entry of `step` for a contribution. */
const lastOf = (journal, key, step, pred = () => true) => journal.entries.findLast(e => e.key === key && e.step === step && pred(e)) ?? null;
/**
 * A contribution's attempts: a new requestId after each refusal or failure, so that a send refused for a reason
 * that has since gone (the owner re-delegated, the stores filled) is not answered by the gateway's recorded refusal.
 * A retry of the SAME attempt (the relay unreachable, a restart) keeps the requestId.
 */
const attemptOf = (journal, key) => journal.entries.filter(e => e.key === key && ((e.step === 'act-result' && e.outcome !== OUTCOME.SENT) || (e.step === 'verify' && (e.outcome === OUTCOME.FAILED || e.outcome === OUTCOME.EXPIRED)))).length;

/** How many troops the journal says are on their way or done for a request (a failed or expired send counts nothing). */
export function contributedTo(journal, requestId) {
  const latest = new Map();
  for (const e of journal.entries) if (e.requestId === requestId && e.key && e.outcome) latest.set(e.key, e);
  let n = 0;
  for (const [key, e] of latest) {
    if (!LIVE.has(e.outcome)) continue;
    n += lastOf(journal, key, 'act-begin')?.args?.action?.fields?.n ?? 0;
  }
  return n;
}

/**
 * What became of earlier sends: the chain's word on the transaction, then
 * the world's on its effect. Only both together make a `contributed`
 * memory; a failed or expired one is remembered as that; anything not yet
 * provable stays open for the next run.
 */
export async function verifyPending({ journal, txState, world, guard = null }) {
  const out = [];
  const keys = new Set(journal.entries.filter(e => e.step === 'act-result' && e.outcome === OUTCOME.SENT).map(e => e.key));
  for (const key of keys) {
    const last = journal.stateOf(key);
    if (!last || ![OUTCOME.SENT, OUTCOME.UNKNOWN, OUTCOME.LANDED].includes(last.outcome)) continue;
    const begin = lastOf(journal, key, 'act-begin');
    const sent = lastOf(journal, key, 'act-result', e => !!e.signature);
    if (!sent) continue;
    let tx;
    // The requestId lets a fate-based txState (model-api/src/fate-reader.mjs) read GET /f/agent/fate by key.
    try { tx = await txState(sent.signature, { requestId: begin?.attemptId ?? sent.attemptId }); } catch (e) { tx = { state: 'unknown', fateState: 'unqueryable', why: String(e?.message ?? e) }; }
    const base = { step: 'verify', key, requestId: begin?.requestId, signature: sent.signature, tx: tx.state, ...(tx.code ? { txCode: tx.code } : {}), ...(tx.fateState ? { fateState: tx.fateState } : {}), ...(tx.relayState ? { relayTx: tx.relayState } : {}), ...(tx.source ? { readBy: tx.source } : {}) };
    // An end that frees the act for a new attempt must be proved. GET /f/tx's own `expired` is not (④ EXECUTION-CONTRACT
    // §2: confirmed height only, no history check): it is held as unknown, never re-sent on its word.
    if (tx.state === 'expired' && tx.proved !== true) {
      journal.append({ ...base, tx: 'unknown', relayTx: 'expired', outcome: OUTCOME.UNKNOWN, why: 'GET /f/tx says expired, which is not a proof that it never landed; held' });
      out.push({ key, outcome: OUTCOME.UNKNOWN, fateState: tx.fateState ?? 'unknown' });
      continue;
    }
    if (tx.state === 'failed' || tx.state === 'expired') {
      // Nothing moved: the executor's game reservation comes back (the relay's own hold is released by its reconcile).
      guard?.release(`game:${begin?.attemptId}`);
      journal.append({ ...base, outcome: tx.state === 'failed' ? OUTCOME.FAILED : OUTCOME.EXPIRED });
      journal.remember(key, { outcome: tx.state === 'failed' ? OUTCOME.FAILED : OUTCOME.EXPIRED, verified: true, requestId: begin?.requestId, txCode: tx.code ?? null });
      out.push({ key, outcome: tx.state });
      continue;
    }
    if (tx.state !== 'landed') {
      // pending, result unknown and could-not-ask are all "not decided", recorded apart (fateState) and all held.
      const why = tx.fateState === 'unqueryable' ? 'the chain could not be asked; says nothing about the transaction' : tx.fateState === 'unknown' ? 'result unknown: past its lifetime, absence not provable; held' : 'the chain has no final answer yet; not counted as done';
      journal.append({ ...base, outcome: OUTCOME.UNKNOWN, why });
      out.push({ key, outcome: OUTCOME.UNKNOWN, fateState: tx.fateState ?? 'unknown' });
      continue;
    }
    // Landed. The effect, from the public world: the reserve of that unit grew by the troops sent since the baseline.
    const f = begin?.args?.action?.fields ?? {};
    const effect = begin?.args?.action?.name === 'Train' ? (() => {
      const v = world.village();
      const now = v?.reserve_troops?.[begin.unitName] ?? 0;
      return { confirmed: now >= (begin.baseline ?? 0) + (f.n ?? 0), seen: now, expected: (begin.baseline ?? 0) + (f.n ?? 0) };
    })() : { confirmed: false, seen: null, expected: null };
    if (!effect.confirmed) {
      journal.append({ ...base, outcome: OUTCOME.LANDED, effect, why: 'landed on chain; the public world does not show the effect yet' });
      out.push({ key, outcome: OUTCOME.LANDED, effect });
      continue;
    }
    journal.append({ ...base, outcome: OUTCOME.CONTRIBUTED, effect });
    journal.remember(key, { outcome: OUTCOME.CONTRIBUTED, verified: true, requestId: begin?.requestId, action: begin?.args?.action, signature: sent.signature });
    out.push({ key, outcome: OUTCOME.CONTRIBUTED, effect });
  }
  return out;
}

async function act(mcp, args, retries) {
  let r;
  for (let i = 0; i <= retries; i++) {
    r = await tool(mcp, 'agent_act', args);
    // The relay was not reached: retry the SAME requestId (the gateway never sends a key twice).
    if (r.structuredContent?.error?.code !== 'RelayUnreachable') return { r, attempts: i + 1 };
  }
  return { r, attempts: retries + 1, unreachable: true };
}

/**
 * @param {object} o
 * @param {object} o.mcp        the agent's MCP server (mcp/agent-mcp.mjs createAgentMcp)
 * @param {object} o.world      public reads: clockSec(), bell(), village(), requests()
 * @param {Function} o.txState  signature → {state: landed|failed|expired|unknown} (GET /f/tx/{signature})
 * @param {Function} [o.meter]  (fn, {key, free, model}) → gateway.meterInference's answer; absent: model calls are not metered (tests of the rest)
 * @param {object} o.mandate    the owner's mandate (adapters.normaliseMandate)
 * @param {object} o.decider    ruleDecider() or modelDecider({llm})
 * @param {object} o.journal    RunJournal
 * @param {string} o.runId
 * @param {number} [o.maxObsAgeSec]  an observation older than this (world clock) is not acted on
 * @param {Function} [o.crash]  test hook: called with a step name; throwing there is a process dying at that step
 * @param {object} [o.boundary] model-api/src/citizen-boundary.mjs CitizenBoundary: the owner's own client on the same Citizen
 *                              acts first (any of its actions since the observation, or a history gap, skips this act)
 * @param {object} [o.staking]  the AI-staking executor's layer (src/staking): {guard: BudgetGuard, priceBook, modelCfg, identity,
 *                              gamePrices: the relay's game price table (agent_terms), onBudgetLimit: 'stop'|'rules', modelRetries}.
 *                              Absent: the participation demo's behaviour (a refused model call falls back to the free rules).
 */
export async function participate({ mcp, world, txState, meter = null, mandate, decider, fallback = ruleDecider(), contract = new CommandContract(), journal, runId, maxObsAgeSec = 300, retries = 2, crash = () => {}, staking = null, boundary = null }) {
  const S = staking;
  const report = { runId, version: PARTICIPATION_VERSION, decider: decider.name, resumed: [], verified: [], items: [], notes: [], charged: '0', status: 'done' };
  const J = e => journal.append({ runId, ...e });

  // ---- verify earlier sends.
  report.verified = await verifyPending({ journal, txState, world, guard: S?.guard ?? null });

  // ---- observe.
  const v = await tool(mcp, 'agent_view');
  if (v.isError) { J({ step: 'observe', ok: false, code: v.structuredContent?.error?.code }); return { ...report, status: 'blocked', code: v.structuredContent?.error?.code ?? 'ViewFailed' }; }
  const nowSec = world.clockSec();
  const obs = { observedAtSec: nowSec, bell: world.bell?.() ?? null, view: v.structuredContent, village: world.village(), requests: world.requests() };
  J({ step: 'observe', ok: true, worldSec: nowSec, policyVersion: obs.view.policy.version, modeEpoch: obs.view.modeEpoch, mode: obs.view.mode, delegated: obs.view.delegation?.delegated ?? null,
    stores: obs.village?.stores, reserve: obs.village?.reserve_troops, requests: obs.requests.map(r => ({ id: r.id, nation: r.nation, ask: parseAsk(r.ask), deadlineSec: r.deadlineSec })) });

  // ---- grant.
  const grant = grantFrom(obs.view, mandate, nowSec);
  J({ step: 'grant', ok: grant.ok, reasons: grant.reasons, allowed: grant.allowed, deniedByPolicy: grant.deniedByPolicy, limits: grant.limits, versions: grant.versions });
  // ---- resume: an action begun and not recorded. Same requestId: replayed if it was sent, sent once if it was not.
  // Only under a valid grant: re-asking may send (the relay has no read-only lookup by requestId yet; MCP-EXTENSIONS
  // action_status), so a stop, a revoked or expired mandate or a lost delegation holds it as unknown instead.
  if (!grant.ok) report.held = journal.unfinished().map(b => ({ key: b.key, requestId: b.requestId, outcome: OUTCOME.UNKNOWN, why: 'the grant is not valid now; not re-sent' }));
  else for (const b of journal.unfinished()) {
    const { r, unreachable } = await act(mcp, b.args, retries);
    if (unreachable) { J({ step: 'act-error', key: b.key, requestId: b.requestId, attemptId: b.args.requestId, outcome: OUTCOME.UNKNOWN, code: 'RelayUnreachable', resumed: true }); report.resumed.push({ key: b.key, outcome: OUTCOME.UNKNOWN }); continue; }
    const a = resultOf(r.structuredContent);
    if (!a.status) { J({ step: 'act-error', key: b.key, requestId: b.requestId, attemptId: b.args.requestId, outcome: OUTCOME.UNKNOWN, code: a.code, resumed: true }); report.resumed.push({ key: b.key, outcome: OUTCOME.UNKNOWN, code: a.code }); continue; }
    const left = mayHaveLeft(a);
    J({ step: 'act-result', key: b.key, requestId: b.requestId, attemptId: b.args.requestId, outcome: left ? OUTCOME.SENT : a.status, ...(left ? { relayStatus: OUTCOME.FAILED } : {}), sent: a.sent, code: a.code, signature: a.signature, ...(a.facts ?? {}), replayed: a.replayed, cost: b.cost, worldSec: b.worldSec, resumed: true });
    report.resumed.push({ key: b.key, outcome: left ? OUTCOME.UNKNOWN : a.status, replayed: a.replayed, ...(left ? { code: a.code, why: 'failed after the bytes may have left: followed, not re-sent' } : {}) });
  }

  if (!grant.ok) {
    report.status = 'blocked';
    report.blocked = grant.reasons;
    return report;
  }

  // ---- plan (the model's call is the gateway's to meter and to refuse past a cap).
  const committedToday = journal.committedToday(nowSec);
  const planCtx = { nowSec, committedToday, contributedTo: id => contributedTo(journal, id) };
  let plan, by = decider.name, cause = null, modelError = null;
  const attempts = [];
  let charged = 0n;
  if (decider.free || !meter) {
    plan = await decider.plan(obs, grant, contract, planCtx);
    // A decider that keeps its own model budget (model-api/src/api-decider.mjs) says when that budget stops it: nothing is decided or sent.
    if (plan.stop) {
      J({ step: 'plan', by: null, charged: plan.inference?.costs?.settled ?? '0', cause: plan.stop, inference: plan.inference ?? null, proposals: [], notes: plan.notes ?? [] });
      return { ...report, status: 'stopped-by-budget', stoppedBy: plan.stop, inference: plan.inference ?? null, notes: plan.notes ?? [], reason: '予算の上限に達したので、新しい判断も操作もしない。本人が予算を見直すまで止まる' };
    }
  }
  else if (decider.needsCall && !decider.needsCall(obs, grant, contract, planCtx)) plan = { proposals: [], notes: [{ code: 'NothingToAsk', reason: '委任された命令か、開いている依頼がないので、モデルを呼ばない（請求なし）' }] };
  else {
    // A failed model call may be retried, each try a call of its own: held, charged and capped like the first (the
    // relay's call cap and budget, and this executor's per-call and per-category caps), so retries cannot exceed them.
    const tries = 1 + Math.max(0, S?.modelRetries ?? 0);
    for (let i = 0; i < tries && !plan; i++) {
      const mkey = `${runId}:plan:${i}`;
      let quote = null;
      try {
        if (S) { quote = S.priceBook.quote(S.modelCfg); S.guard.reserve(mkey, 'inference', quote.amount); }
      } catch (e) { cause = e?.code ?? 'QuoteRefused'; modelError = String(e?.message ?? e); break; }
      try {
        const m = await meter(() => decider.plan(obs, grant, contract, planCtx), { key: mkey, free: false, model: S?.modelCfg?.model ?? decider.name });
        S?.guard.commit(mkey, m.charged);
        charged += BigInt(m.charged);
        attempts.push({ attempt: i, ok: m.ok, charged: m.charged, quote: quote?.amount ?? null, ...(quote && BigInt(m.charged) > BigInt(quote.amount) ? { priceMismatch: true } : {}), servedModel: m.result?.servedModel ?? null, error: m.ok ? null : sanitize(m.error.message, { limit: 120 }) });
        if (m.ok) plan = m.result;
        else { modelError = m.error.message; cause = m.error.code; }
      } catch (e) {
        // The relay refused to hold the call (balance, budget, the owner's daily call cap, a stop): no call was made.
        S?.guard.release(mkey);
        cause = e?.code ?? 'MeterRefused';
        modelError = String(e?.message ?? e);
        break;
      }
    }
    report.charged = String(charged);
    if (!plan && S?.onBudgetLimit === 'stop' && BUDGET_STOP_CODES.has(cause)) {
      J({ step: 'plan', by: null, charged: report.charged, cause, attempts, configuredModel: S.modelCfg?.model ?? null, modelError: sanitize(modelError ?? '', { limit: 200 }), proposals: [], notes: [] });
      return { ...report, status: 'stopped-by-budget', stoppedBy: cause, reason: '予算の上限に達したので、新しい判断も操作もしない。本人が予算を見直すまで止まる' };
    }
    if (!plan) { plan = await fallback.plan(obs, grant, contract, planCtx); by = `${fallback.name} (after ${cause})`; }
  }
  const served = attempts.findLast(a => a.servedModel)?.servedModel ?? null;
  J({ step: 'plan', by, charged: report.charged, cause, attempts, configuredModel: S?.modelCfg?.model ?? null, servedModel: served, modelFile: S?.identity?.modelFile ?? null, reportedAlias: S?.identity?.reportedAlias ?? null,
    modelError: modelError ? sanitize(modelError, { limit: 200 }) : null, ...(plan.inference ? { inference: plan.inference } : {}), proposals: plan.proposals.map(p => ({ requestId: p.requestId, command: p.command, reason: p.reason })), notes: plan.notes });
  report.by = by;
  report.notes = plan.notes ?? [];
  if (plan.inference) report.inference = plan.inference;
  // The board's requests this run does not answer, and why (another nation's, an author the owner does not follow, past its deadline).
  report.ignored = obs.requests.map(r => ({ requestId: r.id, code: ignoredWhy(r, grant, nowSec) })).filter(x => x.code);

  // ---- guard and act, one proposal at a time.
  const committedThisRun = {};
  /** Troops of each unit this run has sent so far: the next one's effect is counted on top of them. */
  const sentUnits = {};
  let stale = null;
  let budgetStop = null;
  for (const p of plan.proposals) {
    const req = obs.requests.find(r => r.id === p.requestId);
    // The request's author goes with every item, so that an owner asked to decide sees who asked.
    const item = { requestId: p.requestId, title: req ? sanitize(req.title ?? '', { limit: 60, untrusted: true }) : null, author: req ? sanitize(req.author ?? '?', { limit: 40, untrusted: true }) : null, by: p.by, proposed: p.command };
    report.items.push(item);
    if (budgetStop) { Object.assign(item, { outcome: OUTCOME.SKIPPED, code: budgetStop, reason: '予算の上限に達したので、残りの提案は送らない' }); continue; }
    if (stale) { Object.assign(item, { outcome: OUTCOME.SKIPPED, code: stale, reason: 'この回の観測が古くなったので、残りの提案は次の回に観測し直してから決める' }); continue; }
    const key = keyOf(obs.view.agentId, p.requestId, p.command?.name, grant.versions.mandateVersion);
    const prior = journal.stateOf(key);
    if (prior && LIVE.has(prior.outcome)) { Object.assign(item, { outcome: OUTCOME.SKIPPED, code: 'Duplicate', reason: `同じ依頼への同じ協力は記録済み（${prior.outcome}）` }); continue; }
    const g = checkProposal(p, { grant, contract, obs, nowSec, committedToday, committedThisRun, contributedTo: id => contributedTo(journal, id) });
    J({ step: 'guard', key, requestId: p.requestId, by: p.by, command: p.command, verdict: g.verdict, code: g.code ?? null, reason: g.reason, ownerDecision: g.ownerDecision ?? null });
    if (g.verdict !== 'execute') { Object.assign(item, { outcome: g.verdict === 'needs_owner' ? OUTCOME.NEEDS_OWNER : OUTCOME.REFUSED, code: g.code, reason: g.reason, ownerDecision: g.ownerDecision }); continue; }

    // Freshness right before acting: the owner's stop or policy change, or a world that moved on, since we observed.
    const v2 = await tool(mcp, 'agent_view');
    const view2 = v2.structuredContent;
    const worldNow = world.clockSec();
    if (v2.isError || view2.mode !== 'auto' || view2.policy?.version !== obs.view.policy.version || view2.modeEpoch !== obs.view.modeEpoch || worldNow - obs.observedAtSec > maxObsAgeSec) {
      stale = 'StaleObservation';
      const why = v2.isError ? 'agent_view が読めない' : view2.mode !== 'auto' ? '本人が停止した' : view2.policy?.version !== obs.view.policy.version ? `方針が版 ${obs.view.policy.version} から ${view2.policy?.version} に変わった` : view2.modeEpoch !== obs.view.modeEpoch ? '停止と再開があった' : `観測から ${worldNow - obs.observedAtSec} 秒たった（上限 ${maxObsAgeSec}）`;
      J({ step: 'guard', key, requestId: p.requestId, verdict: 'refused', code: stale, reason: why });
      Object.assign(item, { outcome: OUTCOME.SKIPPED, code: stale, reason: why, ownerDecision: view2?.mode !== 'auto' ? '再開するかは本人が決める' : null });
      continue;
    }
    // The same Citizen's other client (the owner's own MCP, ③): if it acted since we observed, the owner goes first.
    const bd = boundary?.beforeAct(obs.view, view2, { nextGamePrice: String(S?.gamePrices?.[g.command.name] ?? '0') });
    if (bd && !bd.ok) {
      stale = bd.code;
      J({ step: 'guard', key, requestId: p.requestId, verdict: 'refused', code: bd.code, reason: bd.detail });
      Object.assign(item, { outcome: OUTCOME.SKIPPED, code: bd.code, reason: `本人の側の操作を優先する（${bd.detail}）。この観測では送らない`, ownerDecision: null });
      continue;
    }

    const unitName = g.command.name === 'Train' ? contract.catalog.train.find(u => u.unit === g.command.fields.unit)?.name : null;
    const args = { requestId: requestIdOf(`${key}#${attemptOf(journal, key)}`), policyVersion: obs.view.policy.version, modeEpoch: obs.view.modeEpoch, action: g.command, reason: `nation request ${String(p.requestId).slice(0, 40)}: ${p.reason ?? ''}`.slice(0, 200) };
    // The game's USDC price of this action (the relay's table; empty in the shipped config): this executor's cap first.
    const gamePrice = String(S?.gamePrices?.[g.command.name] ?? '0');
    if (S && BigInt(gamePrice) > 0n) {
      try { S.guard.reserve(`game:${args.requestId}`, 'game', gamePrice); } catch (e) {
        J({ step: 'guard', key, requestId: p.requestId, verdict: 'refused', code: e.code, reason: e.message });
        Object.assign(item, { outcome: OUTCOME.REFUSED, code: e.code, reason: `${e.message}（送らない。何も請求されない）`, ownerDecision: '本人が上限を見直すか、待つ' });
        if (S.onBudgetLimit === 'stop') { budgetStop = e.code; report.status = 'stopped-by-budget'; report.stoppedBy = e.code; }
        continue;
      }
    }
    J({ step: 'act-begin', key, requestId: p.requestId, attemptId: args.requestId, outcome: OUTCOME.ACTING, args, cost: g.cost, gamePrice, worldSec: nowSec, unitName, baseline: unitName ? (obs.village?.reserve_troops?.[unitName] ?? 0) + (sentUnits[unitName] ?? 0) : null });
    await crash('act-begin');
    const { r, unreachable, attempts } = await act(mcp, args, retries);
    await crash('act-sent');
    // Not known to have been sent: its cost still counts against this run and the day (it may land), and its troops against the next baseline.
    const commit = () => { for (const [k, n] of Object.entries(g.cost ?? {})) committedThisRun[k] = (committedThisRun[k] ?? 0) + n; if (unitName) sentUnits[unitName] = (sentUnits[unitName] ?? 0) + g.command.fields.n; };
    if (unreachable) {
      commit();
      J({ step: 'act-error', key, requestId: p.requestId, attemptId: args.requestId, outcome: OUTCOME.UNKNOWN, code: 'RelayUnreachable', attempts });
      Object.assign(item, { outcome: OUTCOME.UNKNOWN, code: 'RelayUnreachable', reason: `中継に ${attempts} 回届かなかった。送られたかは分からない。次の回に同じ requestId で確かめる（二重には送られない）` });
      continue;
    }
    const a = resultOf(r.structuredContent);
    if (!a.status) {
      commit();
      J({ step: 'act-error', key, requestId: p.requestId, attemptId: args.requestId, outcome: OUTCOME.UNKNOWN, code: a.code, attempts });
      Object.assign(item, { outcome: OUTCOME.UNKNOWN, code: a.code, reason: `中継の答え（${a.code}）からは、送られたか分からない。次の回に同じ requestId で確かめる` });
      continue;
    }
    const left = mayHaveLeft(a);
    if (left) {
      // The relay failed after the bytes may have left: it can still land. Held and counted like a sent act; the chain
      // decides (verifyPending), never a new requestId on the next run.
      commit();
      J({ step: 'act-result', key, requestId: p.requestId, attemptId: args.requestId, outcome: OUTCOME.SENT, relayStatus: OUTCOME.FAILED, sent: a.sent, code: a.code, signature: a.signature, ...(a.facts ?? {}), replayed: a.replayed, cost: g.cost, worldSec: nowSec, attempts });
      Object.assign(item, { outcome: OUTCOME.UNKNOWN, code: a.code, signature: a.signature, command: g.command, attempts,
        reason: a.signature ? `中継は失敗と答えたが（${a.code}）、署名済みで送られている。着地するかを鎖で確かめるまで、送り直さない` : `中継は失敗と答えたが（${a.code}）、送られたかを示していない（古い中継）。送り直さず保留する` });
      continue;
    }
    if (a.status !== 'sent') S?.guard.release(`game:${args.requestId}`);
    J({ step: 'act-result', key, requestId: p.requestId, attemptId: args.requestId, outcome: a.status, sent: a.sent, code: a.code, signature: a.signature, ...(a.facts ?? {}), replayed: a.replayed, cost: g.cost, worldSec: nowSec, attempts });
    Object.assign(item, { outcome: a.status, code: a.code, signature: a.signature, command: g.command, attempts,
      reason: a.status === 'sent' ? '中継が受け付けて送った。着地と効果は次の確認で見る' : a.status === OUTCOME.FAILED ? `中継が送る前に失敗した（${a.code}）。何も送られていない` : `中継が断った（${a.code}）。何も送られず、何も請求されない`,
      ...(a.status !== 'sent' ? { ownerDecision: ['AgentStopped', 'StaleMode', 'StalePolicy', 'SessionNotDelegated', 'BadCapability'].includes(a.code) ? '本人の停止・方針・委任・接続トークンの変更による。続けるかは本人が決める' : null } : {}) });
    if (a.status === 'sent') commit();
    // A refusal for a stale version, a stop or a revoked token means nothing else in this run can go either.
    if (['StalePolicy', 'StaleMode', 'AgentStopped', 'BadCapability'].includes(a.code)) stale = 'StaleObservation';
    // The relay's budget refused it: with the owner's "stop at the limit", nothing more this run.
    if (S?.onBudgetLimit === 'stop' && BUDGET_STOP_CODES.has(a.code)) { budgetStop = a.code; report.status = 'stopped-by-budget'; report.stoppedBy = a.code; }
  }
  return report;
}
