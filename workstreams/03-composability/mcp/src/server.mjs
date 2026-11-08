// The MCP server's logic, transport-free: JSON-RPC in, JSON-RPC out, for one
// authenticated principal per call (http.mjs resolves the Bearer token; the
// stdio transport has none and refuses every tool). Authority never comes
// from a tool's arguments or from text the tools return: it comes from the
// principal (the owner-signed link), its scopes, the link's signed grant
// (② MOCK), and — for the one write — the agent wallet gateway (⑤'s budget,
// the owner's policy, the on-chain delegation) and the program itself.
import { createHash } from 'node:crypto';
import { Game, GameError, untrusted } from './game.mjs';
import { SCOPES } from './auth.mjs';
import { MockGrantPort, STATES, TERMINAL } from './ports.mjs';
import { LocalReceiptPort, assertReceiptPort } from './receipt-port.mjs';
import { budgetOf, refusalOf } from './budget-port.mjs';
import { KINDS, SETTLE_OUTCOME, RAID_CHOICE, caravanEvent, cargoOf, placeOfLog } from './events.mjs';
import { REQUEST_ID, RUN_ID, SERVER_INSTRUCTIONS, TOOLS } from './tools.mjs';

export const PROTOCOL_VERSIONS = Object.freeze(['2025-11-25', '2025-06-18', '2025-03-26']);
export const SERVER_INFO = Object.freeze({ name: 'wylls-mcp', title: 'Wylls (local test stack)', version: '0.1.0' });
export const PLAN_TTL_MS = 5 * 60_000;
const EVENT_PAGES_PER_CHECK = 10;
/** How long an attempt with an unknown outcome waits for a trace before it counts as not sent (a blockhash lives about 60–90 s). */
export const UNCERTAIN_WINDOW_MS = 5 * 60_000;
/** A finished operation stays in the main store this long (answers to its retries stay fast), then moves to the archive. */
export const ARCHIVE_AFTER_MS = 60 * 60_000;
const ARCHIVE_PER_CALL = 200;

const text = obj => [{ type: 'text', text: JSON.stringify(obj) }];
const ok = obj => ({ content: text(obj), structuredContent: obj, isError: false });
const fail = (code, message, extra = {}) => { const e = { ok: false, error: { code, message, ...extra } }; return { content: text(e), structuredContent: e, isError: true }; };
const sha = s => createHash('sha256').update(s).digest('hex');
const RESOURCE_NAMES = ['Food', 'Wood', 'Stone', 'Ore', 'Arms', 'Gold', 'Science', 'Influence'];
const cargoArray = c => RESOURCE_NAMES.map(r => (Number.isInteger(c?.[r]) ? c[r] : 0));

/**
 * @param {object} o
 * @param {Auth} o.auth
 * @param {Game} o.game
 * @param {JsonStore} o.store
 */
export function createWyllsMcp({ auth, game, store, now = Date.now, log = () => {}, grants = new MockGrantPort({ now }), receipts = new LocalReceiptPort(), uncertainWindowMs = UNCERTAIN_WINDOW_MS, archiveAfterMs = ARCHIVE_AFTER_MS, acts = null }) {
  assertReceiptPort(receipts);
  const receiptOf = op => receipts.receipt(op);
  const db = store.state;
  const inflight = new Map();
  const buckets = new Map();
  const scrub = s => String(s ?? '').replace(/[A-Za-z0-9_-]{40,}/g, m => (m.length >= 43 ? '[redacted]' : m));

  /** 30 calls burst, 1 a second, per connection: a runaway loop cannot flood the relay. */
  function limited(principal) {
    const t = now() / 1000;
    const b = buckets.get(principal.linkId) ?? { tokens: 30, t };
    b.tokens = Math.min(30, b.tokens + (t - b.t));
    b.t = t;
    buckets.set(principal.linkId, b);
    if (b.tokens < 1) return true;
    b.tokens -= 1;
    return false;
  }

  const needScope = (principal, scope) => {
    if (principal.scopes.includes(scope)) return null;
    // The OAuth step-up ChatGPT understands: a tool error carrying `_meta["mcp/www_authenticate"]`.
    const r = fail('InsufficientScope', `this connection was not granted ${scope}; the owner reconnects with it`, { scope });
    r._meta = { 'mcp/www_authenticate': [auth.wwwAuthenticate(`error="insufficient_scope", scope="${SCOPES.READ} ${scope}"`)] };
    return r;
  };

  const gameFail = e => (e instanceof GameError ? fail(e.code, e.message, e.extra) : fail('InternalError', scrub(e?.message ?? e)));

  // ------------------------------------------------------------ reads

  async function connection(principal) {
    const link = auth.link(principal.linkId);
    let context = null;
    try { context = await game.context(); } catch { context = null; }
    return ok({ owner: principal.owner, agentId: principal.agentId, scopes: principal.scopes, write: principal.scopes.includes(SCOPES.CARAVAN),
      // The world context the relay serves now, and the ones this server saw it replace: the connection, the owner's
      // identity and the operation history carry over; plans and in-flight tracking stay bound to their own context.
      context: { current: context, changes: game.contextChanges ?? [] },
      grant: grants.view(link), connectionExpiresAt: new Date(link.expiresAt).toISOString(), tokenExpiresAt: new Date(principal.tokenExpiresAt).toISOString(),
      notes: ['The grant is a MOCK of workstream 02\'s Grant (wylls.mock-grant/0): the limits the owner signed when connecting, enforced by this server.'] });
  }

  async function status(principal) {
    let v;
    try { v = await game.view(principal); } catch (e) { return gameFail(e); }
    const a = v.agent;
    return ok({
      owner: principal.owner, asOf: new Date(v.now * 1000).toISOString(),
      village: { placeId: v.village.placeId, p: v.village.p, q: v.village.q, site: v.village.site, stores: v.village.stores },
      storehouses: v.places.filter(pl => pl.kind === 'vault').map(pl => ({ placeId: pl.placeId, p: pl.p, q: pl.q, tile: pl.tile, cap: pl.cap, stores: pl.stores, known: pl.known })),
      caravansOnTheRoad: v.caravans, caravanFeed: v.feedOk ? 'ok' : 'unavailable',
      agent: { agentId: a.agentId, mode: a.mode, modeEpoch: a.modeEpoch, policyVersion: a.policy?.version, allowed: a.policy?.allowed ?? [],
        delegation: a.delegation ?? null, caravansAllowed: (a.policy?.allowed ?? []).includes('SendCaravan') },
      // ⑤'s budget, as the agent wallet reports it (this server keeps no balance of its own).
      budget: budgetOf(a),
      recentAgentHistory: (a.history ?? []).slice(-5).map(h => ({ at: h.at, name: h.name, status: h.status, code: h.code ?? null, source: h.source ?? null, ...(h.reason ? { reason: untrusted('agent history (a model\'s or a person\'s words)', h.reason) } : {}) })),
    });
  }

  async function shortfall(principal, args) {
    try { return ok(Game.shortfall(await game.view(principal), args?.goal)); } catch (e) { return gameFail(e); }
  }

  // ------------------------------------------------------------ plans

  async function prepare(principal, args) {
    let v, plan;
    try {
      v = await game.view(principal);
      plan = await game.plan(v, { from: String(args?.from ?? ''), to: String(args?.to ?? ''), cargo: cargoArray(args?.cargo) });
    } catch (e) { return gameFail(e); }
    const id = `pln_${sha(`${principal.linkId}\n${now()}\n${Math.random()}`).slice(0, 20)}`;
    const a = v.agent;
    db.plans[id] = { id, linkId: principal.linkId, createdAt: now(), expiresAt: now() + PLAN_TTL_MS, usedBy: null, context: game.pinned?.key ?? null,
      policyVersion: a.policy?.version, modeEpoch: a.modeEpoch, seq: plan.seq, holding: plan.holding, fields: plan.fields, route: plan.route, cargo: plan.cargo,
      summary: { from: plan.from, to: plan.to, cargo: plan.cargoNamed, steps: plan.steps, estimatedMinutes: Math.round(plan.estimatedSecs / 60), seq: plan.seq } };
    for (const [k, p] of Object.entries(db.plans)) if (p.expiresAt + PLAN_TTL_MS < now() && !p.usedBy) delete db.plans[k];
    store.save();
    const warnings = [];
    if (!(a.policy?.allowed ?? []).includes('SendCaravan')) warnings.push('The agent\'s policy does not allow SendCaravan: send_caravan will be refused (ActionNotAllowed) until the owner allows the transport group (and the relay has patch 0005).');
    if (a.mode !== 'auto') warnings.push('The agent is stopped (manual): send_caravan will be refused (AgentStopped).');
    if (a.delegation && !a.delegation.delegated) warnings.push('The village is not delegated to the agent on chain: send_caravan will be refused (SessionNotDelegated).');
    return ok({ planId: id, expiresAt: new Date(now() + PLAN_TTL_MS).toISOString(), summary: db.plans[id].summary, cost: { resources: plan.cargoNamed, settleFeeLamports: plan.feeLamports, paidBy: plan.paidBy },
      confirm: `Send a caravan from ${plan.from} to ${plan.to} with ${Object.entries(plan.cargoNamed).map(([r, n]) => `${n} ${r}`).join(', ')} (about ${Math.round(plan.estimatedSecs / 60)} min on the road; it cannot be recalled and can be raided).`,
      warnings, sent: false });
  }

  // ------------------------------------------------------------ operations

  const opIdOf = (principal, requestId) => `op_${sha(`${principal.linkId}\n${requestId}`).slice(0, 24)}`;
  const step = (op, state, detail = null) => { op.state = state; op.updatedAt = new Date(now()).toISOString(); op.steps.push({ state, at: op.updatedAt, ...(detail ? { detail } : {}) }); };

  const joined = r => ({ ...r, structuredContent: { ...r.structuredContent, replayed: true }, content: text({ ...r.structuredContent, replayed: true }) });
  /** One run per operation at a time: a retry while a send is under way joins it (never a second, concurrent submit). */
  function single(opId, fn) {
    if (inflight.has(opId)) return inflight.get(opId).then(joined);
    const run = fn().finally(() => inflight.delete(opId));
    inflight.set(opId, run);
    return run;
  }
  const answer = op => {
    const r = receiptOf(op);
    return op.state === STATES.FAILED ? fail(op.error?.code ?? 'Failed', op.error?.message ?? 'failed', { operationId: op.id, receipt: r }) : ok(r);
  };

  async function send(principal, args) {
    const denied = needScope(principal, SCOPES.CARAVAN);
    if (denied) return denied;
    const requestId = String(args?.requestId ?? '');
    if (!REQUEST_ID.test(requestId)) return fail('BadRequest', 'requestId: 8–100 characters of A–Z a–z 0–9 . _ : -');
    const planId = String(args?.planId ?? '');
    const runId = args?.runId === undefined ? null : String(args.runId);
    if (runId !== null && !RUN_ID.test(runId)) return fail('BadRequest', 'runId: 8–128 characters of A–Z a–z 0–9 . _ : -');
    const opId = opIdOf(principal, requestId);
    return single(opId, async () => {
      // A retry of a decision already taken: the same operation, never a second send.
      const prior = store.operation(opId);
      if (!prior) {
        // A requestId the same owner already used for this agent on another connection (a reconnect, a revoked link):
        // that operation may have sent. Never a second send under a new connection: refused, nothing sent, the
        // earlier operation named (its state: get_run_status on its run, or the owner's view).
        const others = auth.linksOf(principal.owner).filter(l => l.agentId === principal.agentId && l.linkId !== principal.linkId).map(l => l.linkId);
        const used = others.length ? store.operationsWithRequestId(others, requestId) : [];
        if (used.length) return fail('RequestIdUsedOnAnotherConnection', 'this requestId was already used for this agent on another connection: nothing was sent; that operation is the one to follow (a new decision needs a new requestId)', { operationId: used[0] });
      }
      if (prior) {
        if (prior.planId !== planId) return fail('IdempotencyConflict', 'this requestId was used for another plan: use a new requestId', { operationId: opId });
        if ((prior.runId ?? null) !== runId) return fail('IdempotencyConflict', 'this requestId was sent under another runId: the run is fixed for the requestId', { operationId: opId, runId: prior.runId ?? null });
        if (prior.state === STATES.REQUESTED) {
          // An attempt whose answer was lost: ask the wallet first, without sending.
          const f = await consult(prior);
          if (f === null) await recover(prior); // an older wallet: its history view
          if (prior.state !== STATES.REQUESTED) { store.save(); return joined(answer(await track(prior, principal))); }
          // The same key goes out again only when the wallet answered and holds nothing under it (it never forgets a
          // key: a POST is then its replay, or the first send if the first never arrived). It could not be asked, or
          // knows the act and has not decided: nothing is sent.
          if (f && !(f.state === 'unqueryable' && f.retained === false)) {
            prior.updatedAt = new Date(now()).toISOString();
            store.save();
            return fail('NotResent', `nothing was sent again: the agent wallet's state for this request is ${f.state}${f.why ? ` (${scrub(f.why)})` : ''}; ask again later with the same requestId`, { operationId: prior.id, retrySameRequestId: true, fate: prior.fate, receipt: receiptOf(prior) });
          }
          return joined(await resume(principal, prior));
        }
        return joined(answer(await track(prior, principal)));
      }
      // Async reads first (the owner's village as it is now), then every decision synchronously.
      let v;
      try { v = await game.view(principal); } catch (e) { return gameFail(e); }
      const plan = db.plans[planId];
      if (!plan || plan.linkId !== principal.linkId) return fail('PlanUnknown', 'no such plan for this connection: prepare_caravan first');
      if (plan.usedBy) return fail('PlanUsed', 'this plan was already sent', { operationId: plan.usedBy });
      if (plan.expiresAt <= now()) return fail('PlanExpired', 'the plan has expired: prepare again');
      if (plan.context && plan.context !== game.pinned?.key) return fail('PlanStale', 'the relay now serves another world context than the plan\'s: its addresses and caravan number belong to that context; prepare again', { planContext: plan.context, context: game.pinned?.key ?? null });
      if (Number(v.citizen?.caravans ?? -1) !== plan.seq || v.agent.village.some((x, i) => x !== plan.holding[i])) return fail('PlanStale', 'the village changed since the plan (another caravan was sent): prepare again');
      const link = auth.link(principal.linkId);
      const op = { id: opId, requestId, planId, linkId: principal.linkId, kind: 'caravan.send', state: null, createdAt: new Date(now()).toISOString(), updatedAt: null, steps: [],
        planSummary: plan.summary, caravan: { seq: plan.seq, ownerTag: v.citizenTag, arriveAt: null, outcome: null }, eventsCursor: '0', attempts: 0, unknownSince: null, grant: 'none',
        context: plan.context ?? null, ...(runId !== null ? { runId } : {}) };
      const g = grants.reserve(link, { name: 'SendCaravan', cargo: plan.cargo }, opId);
      if (!g.ok) {
        step(op, STATES.REQUESTED);
        op.error = { code: g.code, message: g.message, retryable: false, by: 'grant (mock of workstream 02)' };
        step(op, STATES.FAILED, g.code);
        db.operations[opId] = op;
        store.save();
        return fail(g.code, g.message, { operationId: opId, receipt: receiptOf(op) });
      }
      op.grant = 'reserved';
      plan.usedBy = opId;
      step(op, STATES.REQUESTED);
      db.operations[opId] = op;
      store.save(); // written before anything leaves: a restart finds the request and resumes it under the same key
      return resume(principal, op);
    });
  }

  // The grant's hold follows what can have happened: released only when nothing can have been sent.
  const grantRelease = (link, op) => { if (op.grant === 'reserved') grants.release(link, op.id); else if (op.grant === 'consumed') grants.refund(link); op.grant = 'none'; };
  const grantConsume = (link, op) => { if (op.grant === 'reserved') { grants.consume(link, op.id); op.grant = 'consumed'; } };

  const keyOf = op => `ws03:${op.linkId}:${op.requestId}`;
  const lifetimeOf = (f, source) => (f?.lastValidBlockHeight == null ? null
    : { lastValidBlockHeight: f.lastValidBlockHeight, slotFloor: f.slotFloor ?? null, signedAt: f.signedAt ?? null, unit: 'block height', signature: f.signature ?? null, source });

  /**
   * Registers the operation in workstream 04's act registry (`acts`: ④'s clients/acts.mjs, `runexec act register`),
   * source `mcp`, the operation id as the caller's run id. Idempotent: the same key, source and run id give the same
   * run4Id every time (a retry, a restart). Null without a registry. Throws ActsError (Conflict, StoreError, Spawn).
   */
  async function register(op, link) {
    if (!acts) return null;
    // The caller's run (a workstream 06 run, say) when one was given, else this operation: fixed at creation, so a retry
    // or a restart registers under the same run (④ refuses a key under another run).
    const args = { agentId: link.agentId, key: keyOf(op), source: 'mcp', runId: op.runId ?? op.id };
    let r;
    try { r = await acts.register(args); } catch (e) {
      // ④'s register reads then writes: a concurrent first registration of the same key loses with the store's UNIQUE
      // error (found by ⑤ e9d1551a). Registering is idempotent, so this one error is retried once; nothing else is.
      if (e?.code !== 'BadRequest' || !/UNIQUE/i.test(String(e?.message))) throw e;
      r = await acts.register(args);
    }
    op.ws04Act = { ...(op.ws04Act ?? {}), run4Id: r.run4Id, runId: r.runId ?? args.runId, registeredAt: op.ws04Act?.registeredAt ?? new Date(now()).toISOString(), receiptVersion: r.receiptVersion ?? null, state: op.ws04Act?.state ?? r.state };
    return r;
  }

  /** Nothing was sent and nothing will be: failed, the grant's hold given back. */
  function definite(op, link, code, message, by) {
    grantRelease(link, op);
    op.error = { code, message: scrub(message), retryable: false, ...(by ? { by } : {}) };
    step(op, STATES.FAILED, code);
  }
  /** Something may have been sent and no new attempt will be made: the chain and the herald decide (track). */
  function uncertain(op, link, why) {
    grantConsume(link, op);
    op.unknownSince ??= now();
    op.uncertain = true;
    delete op.error;
    step(op, STATES.ACCEPTED, why);
  }

  /** Sends (or re-sends under the same idempotency key) an operation still `requested`. */
  async function resume(principal, op) {
    const plan = db.plans[op.planId];
    const link = auth.link(op.linkId);
    // The owner's limits and the plan's life hold for a retry too.
    const g = link?.grant;
    const late = !g || link.revokedAt ? 'GrantRevoked' : now() >= g.expiresAt ? 'GrantExpired' : plan.expiresAt <= now() ? 'PlanExpired' : null;
    let capability = null;
    if (!late) {
      try { capability = auth.capabilityOf(op.linkId); } catch {
        // The capability is sealed under another key than this process's: hold, decide nothing. No attempt is made,
        // the grant's hold stays, and nothing is released: the operator restores the key, or the owner revokes the
        // connection and the operation is reconciled (ownerOperations).
        op.hold = { code: 'CapabilityUnavailable', since: op.hold?.since ?? new Date(now()).toISOString() };
        op.error = { code: 'CapabilityUnavailable', retryable: true, by: 'server',
          message: 'this server cannot open the connection\'s agent capability (sealed under another key): nothing new was sent; the operation and the limit it holds are kept until the operator restores the key or the owner revokes the connection' };
        op.updatedAt = new Date(now()).toISOString();
        store.save();
        return fail('CapabilityUnavailable', op.error.message, { operationId: op.id, receipt: receiptOf(op) });
      }
    }
    let current = null;
    try { current = (await game.context()).key; } catch { current = null; }
    if (op.context && current && op.context !== current) {
      // The plan's accounts and caravan number belong to the context it was made in: a new attempt now would sign
      // them against another. Nothing new is sent; an attempt already made is followed by its own signature.
      if (op.attempts === 0) definite(op, link, 'ContextChanged', `no send: the relay now serves another world context (${current}) than the plan's (${op.context})`);
      else { uncertain(op, link, `no new attempt: the relay now serves another world context (${current}) than the plan's (${op.context})`); hold(op, 'ContextChanged', 'an earlier attempt may have been sent in the plan\'s context: only its own signature can decide', { from: op.context, to: current }); }
      store.save();
      return answer(op);
    }
    const stop = late ?? (capability ? null : 'NoCapability');
    if (stop) {
      if (op.attempts === 0) definite(op, link, stop, `no send: ${stop}`);
      else uncertain(op, link, `no new attempt (${stop}); an earlier attempt may have been sent: the chain decides`);
      store.save();
      return answer(op);
    }
    try { await register(op, link); } catch (e) {
      // Not registered with ④: nothing is sent (the registry is the run's record). Nothing changes; retry later.
      if (e?.code === 'Conflict' && op.attempts === 0) { definite(op, link, 'RunConflict', `workstream 04's registry has this key under another run: ${e.message}`, 'ws04 act registry'); store.save(); return answer(op); }
      op.updatedAt = new Date(now()).toISOString();
      store.save();
      return fail('RunRegistryUnavailable', `workstream 04's act registry did not register this operation (${e?.code ?? 'error'}): nothing was sent; retry with the same requestId`, { operationId: op.id, retrySameRequestId: true, receipt: receiptOf(op) });
    }
    const request = { agentId: principal.agentId, source: 'mcp', idempotencyKey: keyOf(op), policyVersion: plan.policyVersion, modeEpoch: plan.modeEpoch,
      action: { name: 'SendCaravan', holding: plan.holding, fields: plan.fields, route: plan.route } };
    delete op.hold;
    if (op.error?.code === 'CapabilityUnavailable') delete op.error;
    op.attempts++;
    store.save();
    const r = await game.submit(capability, request);
    if (r.transport) {
      // Unknown whether the relay got it: the operation stays requested; a retry with the same requestId is safe.
      op.unknownSince ??= now();
      op.error = { code: 'RelayUnreachable', message: 'the relay was not reached; retry with the same requestId', retryable: true };
      op.updatedAt = new Date(now()).toISOString();
      store.save();
      return fail('RelayUnreachable', op.error.message, { operationId: op.id, retrySameRequestId: true, receipt: receiptOf(op) });
    }
    const res = r.json ?? {};
    const code = res.error?.code ?? res.code ?? `HTTP${r.status}`;
    op.gateway = { status: res.status ?? null, signature: res.signature ?? null, code: res.error?.code ?? res.code ?? null, replayed: res.replayed === true, charges: res.charges ?? [],
      ...(typeof res.sent === 'boolean' ? { sent: res.sent } : {}), ...(res.signedAt != null ? { signedAt: res.signedAt } : {}) };
    // The signature's lifetime, fixed when the bytes left (the wallet's ActionResult, workstream 04's change).
    if (res.signature && res.lastValidBlockHeight != null) op.lifetime = lifetimeOf(res, 'agent wallet ActionResult');
    if (r.status === 200 && res.status === 'sent') {
      delete op.error;
      grantConsume(link, op);
      step(op, STATES.ACCEPTED, 'the relay sent the transaction');
    } else if (r.status === 200 && res.status === 'failed' && res.error?.code === 'Duplicate') {
      // ⑤: the same bytes were already sent by an earlier request (`duplicateOf`); this one was not rebuilt. That send
      // is not proven this request's own, nor proven absent: counted, held, never re-sent. Only a proven end of that
      // transaction (failed at finalized, or proven never to land) decides; its landing alone does not make it ours.
      op.gateway.signature = null;
      op.gateway.duplicateOf = res.duplicateOf ?? res.signature ?? null;
      delete op.lifetime;
      // The same signature is the same transaction (⑤: the relay's replay key is the agent key's signature over the
      // message): one effect on chain. If another of this server's operations sent it, that operation carries the
      // effect and the count; this one ends as its duplicate and gives its hold back (counted once, not twice).
      const owner = op.gateway.duplicateOf && Object.values(db.operations).find(o => o.id !== op.id && o.gateway?.signature === op.gateway.duplicateOf);
      if (owner) {
        definite(op, link, 'DuplicateOfOperation', `the same transaction was already sent by this server's operation ${owner.id}: its outcome is that operation's`, 'agent wallet gateway (Duplicate)');
        op.error.duplicateOfOperation = owner.id;
      } else {
        uncertain(op, link, 'the relay answered Duplicate: the same transaction was already sent by an earlier request');
        hold(op, 'Duplicate', 'the same transaction was already sent by an earlier request: not proven this request\'s own, not proven absent; held, counted, not re-sent', { evidence: { duplicateOf: op.gateway.duplicateOf } });
      }
    } else if (r.status === 200 && res.status === 'failed' && res.sent === false && !res.signature) {
      // The wallet's own record: nothing left the relay under this key (failed before sending). Same key = its replay.
      definite(op, link, code, res.error?.message ?? 'failed before anything was sent', 'agent wallet gateway (sent: false)');
    } else if (r.status === 200 && res.status === 'failed') {
      // Signed and possibly sent (`sent: true` with its signature), or an older wallet that does not say: the chain
      // decides by this request's own signature. Never re-sent.
      uncertain(op, link, res.signature ? 'the send left signed and its answer says failed: it may still land; its own signature decides' : 'the send was attempted and its outcome is unknown: the chain decides');
    } else if (r.status === 200 && res.status === 'refused') {
      // The gateway's own record for this key: nothing was sent under it, ever.
      definite(op, link, code, res.error?.message ?? 'refused', 'agent wallet gateway / relay');
      op.error.boundary = refusalOf(code);
    } else if (op.unknownSince === null && [400, 401, 403, 404, 409].includes(r.status)) {
      // Refused before anything (credential, shape, conflict) on a first, clean attempt.
      definite(op, link, code, res.error?.message ?? res.error ?? 'refused', 'agent wallet gateway / relay');
      op.error.boundary = refusalOf(code);
    } else if (op.unknownSince !== null && [400, 401, 403, 404, 409].includes(r.status)) {
      // An earlier attempt may have been sent and this one cannot be: the chain decides.
      uncertain(op, link, `a retry was refused (${code}) after an attempt with an unknown outcome: the chain decides`);
    } else {
      // Rate limited or a server error: nothing decided; retry with the same requestId.
      op.error = { code, message: 'the relay could not take the request now; retry with the same requestId', retryable: true };
      op.updatedAt = new Date(now()).toISOString();
      store.save();
      return fail(code, op.error.message, { operationId: op.id, retrySameRequestId: true, receipt: receiptOf(op) });
    }
    store.save();
    log(`mcp: ${op.id} ${op.state}${op.error ? ` (${op.error.code})` : ''}`);
    return answer(op);
  }

  /** Holds an operation with a reason (not a state: nothing is decided, nothing released). */
  const hold = (op, code, detail, extra = {}) => {
    if (op.hold?.code === code) return;
    op.hold = { code, since: new Date(now()).toISOString(), detail, ...extra };
    op.updatedAt = op.hold.since;
    op.steps.push({ state: op.state, at: op.hold.since, detail: `held (${code}): ${detail}` });
  };
  const named = arr => Object.fromEntries(RESOURCE_NAMES.map((r, i) => [r, arr[i]]).filter(([, n]) => n > 0));

  /** Does the CARAVAN_SENT record say what this request asked (destination, cargo)? null when it does. */
  function contentMismatch(op, payload) {
    const f = db.plans[op.planId]?.fields;
    const dst = placeOfLog(BigInt(payload.dst ?? 0));
    if (f && (dst.kind !== Number(f.dst_kind) || dst.p !== Number(f.dst_p) || dst.q !== Number(f.dst_q) || dst.at !== Number(f.dst_at))) return `the record's destination ${JSON.stringify(dst)} is not the plan's`;
    const sent = payload.cargo ?? Array(8).fill(0);
    const asked = cargoArray(op.planSummary?.cargo);
    const worn = Number(payload.worn_bps ?? 0);
    // Worn on the road at the send (caravan.rs worn_cargo) and logged as floor(milli / 1000): never more than asked;
    // equal when nothing was worn.
    for (let r = 0; r < 8; r++) if (sent[r] > asked[r] || (worn === 0 && sent[r] !== asked[r])) return `the record's cargo ${JSON.stringify(named(sent))} is not the plan's ${JSON.stringify(named(asked))} (worn ${worn} bps)`;
    return null;
  }

  /**
   * The caravan's records (by owner tag and seq). A record counts for this operation only once the caravan is
   * proven this request's own: the CARAVAN_SENT record signed by this request's signature with the plan's content,
   * or this signature's own landed status. A record under another signature with the same seq is another route's
   * send (the seq alone proves nothing): the operation is held, never completed or released on it.
   */
  async function evidence(op) {
    // 1. Collect every record under this caravan's number (kept with the operation, so that a signature learned
    //    later, e.g. from a retry answered by the agent wallet's record, can still attribute earlier ones).
    op.caravan.seen ??= [];
    for (let i = 0; i < EVENT_PAGES_PER_CHECK; i++) {
      const page = await game.events(op.eventsCursor);
      if (!page) break;
      for (const row of page.events) {
        const e = caravanEvent(row);
        if (!e || e.ownerTag !== op.caravan.ownerTag || e.seq !== op.caravan.seq) continue;
        if (op.caravan.seen.some(x => x.event === e.eventSeq)) continue;
        const pl = e.payload;
        op.caravan.seen.push({ kind: e.kind, name: e.name, signature: e.signature, slot: row.slot ?? null, event: e.eventSeq, bell: e.bell,
          payload: { ...(pl.dst !== undefined ? { dst: String(pl.dst) } : {}), ...(pl.cargo ? { cargo: cargoOf(pl.cargo) } : {}), ...(pl.worn_bps !== undefined ? { worn_bps: Number(pl.worn_bps) } : {}),
            ...(pl.arrive_ts !== undefined ? { arrive_ts: Number(pl.arrive_ts) } : {}), ...(pl.choice !== undefined ? { choice: Number(pl.choice) } : {}), ...(pl.outcome !== undefined ? { outcome: Number(pl.outcome) } : {}), ...(pl.bell !== undefined ? { bell: Number(pl.bell) } : {}) } });
      }
      if (page.next !== null && page.next !== undefined) op.eventsCursor = String(page.next);
      if (!page.full) break;
    }
    // 2. Decide from what is known, in record order.
    const ours = op.gateway?.signature ?? null;
    for (const x of op.caravan.seen) {
      if (TERMINAL.includes(op.state)) break;
      const ref = { kind: x.name, signature: x.signature, slot: x.slot, event: x.event };
      if (x.kind === KINDS.CARAVAN_SENT) {
        if (op.caravan.mine?.event === x.event) continue;
        if (!ours) { hold(op, 'Indeterminate', 'a send with this caravan number is recorded, but this server does not know its own signature (the answer was lost): it cannot tell whether the send is its own. Each status query reads the agent wallet\'s record for this key (without re-sending); once it shows the signature, the send is proven or not.', { evidence: ref }); continue; }
        if (x.signature !== ours) { if (!op.caravan.mine) hold(op, 'SeqUsedByAnotherSend', 'another signature sent a caravan with this number: not this request\'s send; this request\'s own outcome is not decided by it', { evidence: ref }); continue; }
        const bad = contentMismatch(op, x.payload);
        if (bad) { hold(op, 'Inconsistent', bad, { evidence: ref }); continue; }
        op.caravan.mine = { by: 'CARAVAN_SENT signed by this request, content as planned', ...ref };
        if (op.hold && ['Indeterminate', 'SeqUsedByAnotherSend', 'ResultUnknown'].includes(op.hold.code)) delete op.hold;
        op.caravan.sentCargo = named(x.payload.cargo ?? []);
        op.caravan.wornBps = x.payload.worn_bps ?? 0;
        if (x.payload.arrive_ts) op.caravan.arriveAt ??= new Date(x.payload.arrive_ts * 1000).toISOString();
        if (op.state !== STATES.PROCESSING) step(op, STATES.PROCESSING, 'the caravan is on the road (its record, signed by this request)');
        continue;
      }
      if (!op.caravan.mine || op.hold?.code === 'Inconsistent') continue; // settle and raid records follow only a caravan proven this request's
      if (x.kind === KINDS.CARAVAN_RAIDED) {
        const choice = RAID_CHOICE[x.payload.choice] ?? 'raided';
        op.caravan.raid = { bell: x.payload.bell ?? x.bell, choice, record: ref };
        if (choice === 'taken') { op.outcome = 'taken'; op.arrival = receipts.arrival(op); step(op, STATES.COMPLETED, 'another village took the caravan in a raid'); }
      }
      if (x.kind === KINDS.CARAVAN_SETTLED) {
        const o = SETTLE_OUTCOME[x.payload.outcome] ?? 'settled';
        op.outcome = op.caravan.raid?.choice === 'burned' && o === 'delivered' ? 'burned' : o;
        op.caravan.settledAtBell = x.bell;
        op.caravan.settle = { record: ref, cargoLogged: named(x.payload.cargo ?? []), precision: 'whole units, floor(milli / 1000): a lower bound of the cargo carried, 0 included' };
        op.arrival = receipts.arrival(op);
        step(op, STATES.COMPLETED, op.outcome === 'delivered' ? 'the caravan arrived and was settled' : `the caravan was settled: ${op.outcome}`);
      }
    }
    if (op.caravan.mine) {
      const feed = await game.caravansFeed();
      const c = feed?.caravans?.moving?.find(x => String(x.ownerTag) === op.caravan.ownerTag && x.seq === op.caravan.seq);
      if (c) { op.caravan.arriveAt ??= new Date(Number(c.arriveTs) * 1000).toISOString(); op.caravan.raided = c.raided; }
    }
    return Boolean(op.caravan.mine);
  }

  /**
   * Moves an operation on from what the chain and the herald now say (pull: the client asks again). Decided only on
   * this request's own signature: landed (it is ours: on the road), failed at finalized (it ran and moved nothing),
   * or absent with the proof patch 0007 gives (finalized, history covering its lifetime). The relay's plain
   * "expired", the caravan counter, or a record under another signature decide nothing; past the window an
   * operation without its own evidence is held (Indeterminate), its grant still counted.
   */
  /**
   * A lost answer, asked again without sending anything: the agent wallet's own record for this request's key, read
   * from its public view (Game.agentRecord). Only what that record shows is taken: a signature (then this request's
   * own signature decides, as for an answer received), or a refusal before signing (nothing was ever sent under the
   * key). Not finding the key, or a failure without a signature, decides nothing and releases nothing.
   */
  async function recover(op) {
    if (op.gateway?.signature || op.gateway?.duplicateOf || op.attempts === 0) return;
    if (op.unknownSince === null && op.gateway?.status !== 'failed') return;
    const link = auth.link(op.linkId);
    if (!link?.agentId) return;
    const rec = await game.agentRecord(link.agentId, link.owner, `ws03:${op.linkId}:${op.requestId}`);
    const at = new Date(now()).toISOString();
    if (!rec) { op.agentRecord = { at, read: false, found: false }; return; }
    const sig = rec.entry?.signature ?? rec.hold?.signature ?? null;
    op.agentRecord = { at, read: true, found: Boolean(rec.entry || rec.hold), status: rec.entry?.status ?? null, signature: sig, ...(rec.hold ? { hold: rec.hold } : {}),
      window: rec.window, ...(rec.entry || rec.hold ? {} : { note: 'not in the view: proves nothing (the view keeps 50 lines; a stop between the send and its line leaves none)' }),
      ...(rec.entry?.status === 'failed' && !sig ? { note: 'failed with no signature in the agent wallet\'s record (its failed result carries none; ④ G-2): whether it was signed is unknown' } : {}) };
    if (sig) {
      op.gateway = { ...(op.gateway ?? { charges: [], replayed: false, code: null }), status: rec.entry?.status ?? op.gateway?.status ?? null, signature: sig,
        recoveredFrom: rec.entry?.signature ? 'agent wallet history (GET /f/agent, read only)' : 'agent wallet hold (GET /f/agent, read only)' };
      if (op.error?.code === 'RelayUnreachable') delete op.error;
      if (op.state === STATES.REQUESTED) { grantConsume(link, op); step(op, STATES.ACCEPTED, 'the agent wallet\'s record shows this request\'s signature (read without re-sending)'); }
      else op.steps.push({ state: op.state, at, detail: 'this request\'s signature read from the agent wallet\'s record (without re-sending)' });
      return;
    }
    if (rec.entry?.status === 'refused') {
      op.gateway = { ...(op.gateway ?? { charges: [], replayed: false }), status: 'refused', signature: null, code: rec.entry.code, recoveredFrom: 'agent wallet history (GET /f/agent, read only)' };
      definite(op, link, rec.entry.code ?? 'Refused', 'the agent wallet\'s record for this key: refused before signing, nothing sent under it', 'agent wallet gateway (its record, read without re-sending)');
      op.error.boundary = refusalOf(op.error.code);
    }
  }

  /**
   * Applies the wallet's answer for this request's key (④'s seven states). Only what is final or proven decides:
   * landed (finalized) puts the caravan on the road; failed (finalized) and expired (proven never to land) fail it;
   * not-sent (the wallet's own record) fails it with the hold given back. pending waits; unknown is held (it may have
   * landed: never re-sent, never released); unqueryable says nothing about the act and changes nothing.
   */
  function applyFate(op, link, f) {
    const at = new Date(now()).toISOString();
    op.fate = { state: f.state, retained: f.retained ?? null, signature: f.signature ?? null, commitment: f.commitment ?? null, queryFailed: f.queryFailed === true,
      why: f.why ?? null, source: f.source, at, ...(f.code ? { code: f.code } : {}) };
    if (TERMINAL.includes(op.state)) return;
    if (op.gateway?.duplicateOf) {
      // A Duplicate: the wallet's record may name the earlier send's signature; it is never adopted as this request's.
      const same = !f.signature || f.signature === op.gateway.duplicateOf;
      if (same && f.state === 'failed') { op.chain = { state: 'failed', of: 'duplicateOf', source: f.source }; definite(op, link, 'TransactionFailed', 'the identical transaction failed at finalized: nothing moved', 'program'); }
      else if (same && f.state === 'expired') { op.chain = { state: 'expired', of: 'duplicateOf', absenceProven: true, source: f.source }; definite(op, link, 'NotLanded', 'the identical transaction is proven never to land'); }
      return;
    }
    if (f.signature && op.gateway?.signature && f.signature !== op.gateway.signature) {
      hold(op, 'Inconsistent', 'the agent wallet\'s record for this key names another signature than the answer this server received: nothing is decided', { evidence: { recorded: f.signature, answered: op.gateway.signature } });
      return;
    }
    if (f.signature && !op.gateway?.signature) {
      op.gateway = { ...(op.gateway ?? { charges: [], replayed: false, code: null }), status: f.status ?? op.gateway?.status ?? null, signature: f.signature, sent: true,
        recoveredFrom: 'agent wallet GET /f/agent/fate (read only)' };
      if (op.error?.code === 'RelayUnreachable') delete op.error;
      if (op.state === STATES.REQUESTED) { grantConsume(link, op); op.uncertain = true; step(op, STATES.ACCEPTED, 'the agent wallet\'s record shows this request\'s signature (read without re-sending)'); }
      else op.steps.push({ state: op.state, at, detail: 'this request\'s signature read from the agent wallet\'s record (without re-sending)' });
    }
    if (f.signature && f.lastValidBlockHeight != null) op.lifetime = lifetimeOf(f, f.source);
    const open = [STATES.REQUESTED, STATES.ACCEPTED].includes(op.state);
    switch (f.state) {
      case 'not-sent':
        if (open && f.retained !== false && !op.gateway?.signature) definite(op, link, f.code ?? 'NotSent', `the agent wallet's record for this key: nothing was sent (${f.why ?? 'not sent'})`, 'agent wallet (its record, read without re-sending)');
        break;
      case 'landed':
        if (op.state === STATES.ACCEPTED) {
          op.chain = { state: 'landed', commitment: f.commitment ?? 'finalized', source: f.source };
          op.caravan.mine ??= { by: 'this request\'s own signature landed at finalized (agent wallet fate)', signature: op.gateway.signature };
          if (op.hold && ['Indeterminate', 'ResultUnknown'].includes(op.hold.code)) delete op.hold;
          step(op, STATES.PROCESSING, 'the transaction landed (finalized): the caravan is on the road');
        }
        break;
      case 'failed':
        if (open) { op.chain = { state: 'failed', commitment: f.commitment ?? 'finalized', why: f.why ?? null, source: f.source }; definite(op, link, 'TransactionFailed', `this request's own transaction failed at finalized: it ran and moved nothing (${f.why ?? 'failed'})`, 'program'); }
        break;
      case 'expired':
        if (open) { op.chain = { state: 'expired', absenceProven: true, why: f.why ?? null, source: f.source }; definite(op, link, 'NotLanded', 'this request\'s own signature is proven never to land: past its lifetime, with the node\'s history covering it'); }
        break;
      case 'unknown':
        if (open) hold(op, 'ResultUnknown', `the result is unknown: ${f.why ?? 'past its lifetime and its absence cannot be shown'}. It may have landed: it is not sent again and nothing is released; it stays held until a final answer`);
        break;
      default: break; // pending: wait. unqueryable: nothing is known about the act.
    }
  }

  /**
   * Asks, without sending anything, for the state of this request's own act: the wallet's GET /f/agent/fate for its
   * key, and workstream 04's registry receipt when a registry is configured (registered first if it is not yet: a
   * restart or an operation from before). Returns the wallet's answer (applied), undefined when nothing was ever
   * attempted, or null for a wallet without the route (then the older reads apply).
   */
  async function consult(op) {
    if (op.attempts === 0 && !op.gateway?.signature) return undefined;
    const link = auth.link(op.linkId);
    if (!link?.agentId) return undefined;
    const f = await game.actFate(link.agentId, keyOf(op));
    if (acts) {
      const at = new Date(now()).toISOString();
      try {
        if (!op.ws04Act?.run4Id) await register(op, link);
        const a = await acts.status({ agentId: link.agentId, key: keyOf(op) });
        op.ws04Act = { ...op.ws04Act, run4Id: a.run4Id, receiptVersion: a.receiptVersion ?? null, state: a.state, final: a.final === true, next: a.next ?? null, newAttemptAllowed: a.newAttemptAllowed === true,
          cancel: a.cancel ?? null, retention: a.retention ?? null, conflict: a.conflict ?? null, at };
      } catch (e) { op.ws04Act = { ...(op.ws04Act ?? {}), readError: `${e?.code ?? 'Error'}: ${scrub(e?.message)}`, at }; }
    }
    if (f === null) return null;
    applyFate(op, link, f);
    return f;
  }

  async function track(op, principal = null) {
    if (TERMINAL.includes(op.state)) return op;
    // A request that never reached the relay has nothing to look for (unless an attempt's outcome is unknown).
    if (op.state === STATES.REQUESTED && op.unknownSince === null) return op;
    const link = auth.link(op.linkId);
    const f = await consult(op);
    if (TERMINAL.includes(op.state)) { store.save(); return op; }
    // An older wallet (no fate route): its history view and the relay's /f/tx, as before.
    if (f === null) await recover(op);
    if (TERMINAL.includes(op.state)) { store.save(); return op; }
    if (f === null && op.state === STATES.ACCEPTED && op.gateway?.signature) {
      const tx = await game.txStatus(op.gateway.signature);
      const d = tx?.detail ?? null;
      const finality = d?.commitment ?? 'not reported';
      // The lifetime the relay recorded when it signed (patch 0007): the last block height this signature can land at.
      if (d?.lastValidBlockHeight != null) op.lifetime = { lastValidBlockHeight: d.lastValidBlockHeight, unit: 'block height', source: 'relay GET /f/tx?detail=1 (patch 0007)' };
      if (tx?.state === 'landed') {
        op.chain = { state: 'landed', slot: tx.slot ?? null, commitment: finality, fee: d?.fee ?? null };
        op.caravan.mine ??= { by: 'this request\'s own signature landed (relay status)', signature: op.gateway.signature, slot: tx.slot ?? null };
        step(op, STATES.PROCESSING, 'the transaction landed: the caravan is on the road');
      } else if (tx?.state === 'failed') {
        op.chain = { state: 'failed', code: tx.code ?? null, slot: tx.slot ?? null, commitment: finality, fee: d?.fee ?? null };
        if (finality === 'finalized') definite(op, link, tx.code ?? 'TransactionFailed', 'this request\'s own transaction failed at finalized: it ran and moved nothing (its fee was charged)', 'program');
        else hold(op, 'Indeterminate', `this request's own transaction failed at commitment "${finality}": not yet final, so nothing is decided`);
      } else if (tx?.state === 'expired' || (d && d.absence)) {
        const proven = d?.absence?.proven === true;
        op.chain = { state: tx?.state ?? 'unknown', absenceProven: proven, ...(d?.absence ? { absence: d.absence } : {}), lastValidBlockHeight: d?.lastValidBlockHeight ?? null };
        if (proven) definite(op, link, 'NotLanded', 'this request\'s own signature is proven absent over its whole lifetime (finalized history): it never landed and never will');
        else if (tx?.state === 'expired' && !op.unknownSince) { op.unknownSince = now(); op.uncertain = true; step(op, STATES.ACCEPTED, 'the relay reports the blockhash expired with no status seen: not proof that nothing landed'); }
      } else op.chain = { state: tx?.state ?? 'unknown' };
    }
    let current = null;
    try { current = (await game.context()).key; } catch { current = null; }
    if (!TERMINAL.includes(op.state) && op.context && current && op.context !== current) {
      // The herald now serves another context's records and event numbering: this operation's cursor and caravan
      // number mean nothing there. Its own signature (above) still decides; otherwise it is held, its history kept,
      // nothing released.
      hold(op, 'ContextChanged', 'the relay and herald now serve another world context: this operation\'s records are not read there; its own signature can still decide', { from: op.context, to: current });
      store.save();
      return op;
    }
    if (!TERMINAL.includes(op.state) && op.gateway?.duplicateOf) { store.save(); return op; } // held as Duplicate: only its fate decides (applyFate)
    if (!TERMINAL.includes(op.state)) {
      const mine = await evidence(op);
      if (mine && op.hold?.code === 'Indeterminate') { delete op.hold; op.steps.push({ state: op.state, at: new Date(now()).toISOString(), detail: 'no longer held: the caravan is proven this request\'s own' }); }
      if (!mine && op.unknownSince !== null && op.state !== STATES.PROCESSING && !['pending', 'unknown'].includes(op.fate?.state) && now() - op.unknownSince >= uncertainWindowMs) {
        hold(op, 'Indeterminate', op.gateway?.signature
          ? 'no evidence for this request\'s own signature, and its absence is not proven (the relay cannot show finalized history over its lifetime): not decided; the grant stays counted'
          : 'this server does not know its own signature (the answer was lost) and the caravan number alone proves nothing: not decided; each status query reads the agent wallet\'s record for this key (without re-sending), and its signature, once shown there, decides');
      }
    }
    store.save();
    return op;
  }

  const mineOp = (principal, op) => op && op.linkId === principal.linkId;

  /**
   * Moves finished operations older than `archiveAfterMs` to the store's append-only archive (a bounded number per
   * call), with the plans they used. Nothing unfinished moves: holds, reservations and tracking stay in the main
   * store. History is not changed: the archived record is the operation's last state, read back as it was.
   */
  function archiveFinished() {
    let moved = 0;
    for (const op of Object.values(db.operations)) {
      if (moved >= ARCHIVE_PER_CALL) break;
      if (!TERMINAL.includes(op.state) || inflight.has(op.id) || now() - Date.parse(op.updatedAt ?? op.createdAt) < archiveAfterMs) continue;
      store.archive(op);
      if (db.plans[op.planId]?.usedBy === op.id) delete db.plans[op.planId];
      moved++;
    }
    if (moved) store.save();
    return moved;
  }

  /**
   * The owner's operations across all their connections, revoked ones included: for an owner whose signed query
   * auth.ownerQuery verified (http: POST /owner/operations). Reads only. A revoked connection's operations are
   * reconciled here: one with no recorded attempt is failed and its hold given back (the attempt counter is
   * written before anything leaves, so 0 means nothing was sent); any other is tracked on the chain and herald.
   */
  async function ownerOperations(owner) {
    const links = Object.values(db.links).filter(l => l.owner === owner);
    const ids = new Set(links.map(l => l.linkId));
    const ops = store.operationsOf([...ids], 50);
    for (const op of ops) {
      if (TERMINAL.includes(op.state) || inflight.has(op.id)) continue;
      const link = auth.link(op.linkId);
      if (link?.revokedAt && op.state === STATES.REQUESTED && op.attempts === 0) definite(op, link, 'GrantRevoked', 'the connection was revoked before anything was sent: nothing was sent');
      else await track(op);
    }
    store.save();
    return {
      owner,
      connections: links.map(l => ({ linkId: l.linkId, agentId: l.agentId, scopes: l.scopes, createdAt: new Date(l.createdAt).toISOString(), revokedAt: l.revokedAt ? new Date(l.revokedAt).toISOString() : null,
        cancellation: receipts.cancellation(l, ops.filter(o => o.linkId === l.linkId)) })),
      operations: ops.map(op => ({ ...receiptOf(op), linkId: op.linkId })),
    };
  }

  async function opStatus(principal, args) {
    let op = null;
    if (typeof args?.operationId === 'string') op = store.operation(args.operationId);
    else if (typeof args?.requestId === 'string' && REQUEST_ID.test(args.requestId)) op = store.operation(opIdOf(principal, args.requestId));
    else return fail('BadRequest', 'operationId or requestId is required');
    if (!mineOp(principal, op)) return fail('UnknownOperation', 'no such operation for this connection');
    return answer(await track(op, principal));
  }

  /** A caller's run: this connection's operations sent with it (each followed, nothing sent) and ④'s receipts for it. */
  async function runStatus(principal, args) {
    const runId = String(args?.runId ?? '');
    if (!RUN_ID.test(runId)) return fail('BadRequest', 'runId: 8–128 characters of A–Z a–z 0–9 . _ : -');
    const ops = store.operationsOf([principal.linkId], 1000).filter(op => op.runId === runId);
    const operations = [];
    for (const op of ops) operations.push(receiptOf(await track(op, principal)));
    let registry = null;
    if (acts) {
      try {
        const l = await acts.list(runId);
        // ④'s list answers as last recorded; a row not final yet is read again (④'s status reads the wallet's fate,
        // read only), so that a run's state does not depend on which connection asks (a reconnect, another sender).
        const rows = [];
        for (const a of (l.acts ?? []).slice(0, 50)) {
          if (a.final === true) { rows.push(a); continue; }
          try { rows.push(await acts.status({ run4Id: a.run4Id })); } catch (e) { rows.push({ ...a, readError: `${e?.code ?? 'Error'}: ${scrub(e?.message)}` }); }
        }
        registry = { read: true, acts: rows, ...((l.acts ?? []).length > 50 ? { truncated: true } : {}) };
      }
      catch (e) { registry = { read: false, error: `${e?.code ?? 'Error'}: ${scrub(e?.message)}` }; }
    }
    return ok({ runId, operations, registry, notes: ['Read only: nothing is sent. The registry lists every act registered under this run (other senders\' included, each with its source).'] });
  }

  async function listOps(principal) {
    const mine = store.operationsOf([principal.linkId], 20);
    return ok({ operations: mine.map(op => ({ operationId: op.id, requestId: op.requestId, state: op.state, outcome: op.outcome ?? null, createdAt: op.createdAt, updatedAt: op.updatedAt, summary: op.planSummary })) });
  }

  const tools = { get_connection: connection, get_village_status: status, check_resource_shortfall: shortfall, prepare_caravan: prepare, send_caravan: send, get_operation_status: opStatus, get_run_status: runStatus, list_operations: listOps };

  /** One JSON-RPC message for `principal` (null: unauthenticated) → the response (null for a notification). */
  async function handle(msg, principal) {
    const reply = result => ({ jsonrpc: '2.0', id: msg.id, result });
    const error = (code, message) => ({ jsonrpc: '2.0', id: msg?.id ?? null, error: { code, message } });
    if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return error(-32600, 'invalid request');
    const notification = msg.id === undefined;
    switch (msg.method) {
      case 'initialize': {
        const asked = msg.params?.protocolVersion;
        return reply({ protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0], capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO, instructions: SERVER_INSTRUCTIONS });
      }
      case 'notifications/initialized': case 'notifications/cancelled': return null;
      case 'ping': return reply({});
      case 'tools/list': return reply({ tools: TOOLS });
      case 'tools/call': {
        const name = msg.params?.name;
        const fn = tools[name];
        if (!fn) return error(-32602, `unknown tool ${String(name).slice(0, 40)}`);
        if (!principal) return reply(fail('Unauthenticated', 'connect with OAuth first'));
        if (limited(principal)) return reply(fail('RateLimited', 'too many calls: wait a few seconds'));
        let out;
        try { out = reply(await fn(principal, msg.params?.arguments ?? {})); } catch (e) { log(`mcp: ${name} threw ${scrub(e?.message)}`); return reply(fail('InternalError', 'internal error')); }
        try { archiveFinished(); } catch (e) { log(`mcp: archive failed (nothing moved): ${scrub(e?.message)}`); }
        return out;
      }
      default: return notification ? null : error(-32601, `method not found: ${msg.method.slice(0, 40)}`);
    }
  }

  return { handle, tools: Object.keys(tools), track, ownerOperations, archiveFinished, receipts: { contract: receipts.contract, real: receipts.real } };
}
