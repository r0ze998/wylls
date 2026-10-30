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
import { KINDS, SETTLE_OUTCOME, RAID_CHOICE, caravanEvent } from './events.mjs';
import { REQUEST_ID, SERVER_INSTRUCTIONS, TOOLS } from './tools.mjs';

export const PROTOCOL_VERSIONS = Object.freeze(['2025-11-25', '2025-06-18', '2025-03-26']);
export const SERVER_INFO = Object.freeze({ name: 'wylls-mcp', title: 'Wylls (local test stack)', version: '0.1.0' });
export const PLAN_TTL_MS = 5 * 60_000;
const EVENT_PAGES_PER_CHECK = 10;
/** How long an attempt with an unknown outcome waits for a trace before it counts as not sent (a blockhash lives about 60–90 s). */
export const UNCERTAIN_WINDOW_MS = 5 * 60_000;

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
export function createWyllsMcp({ auth, game, store, now = Date.now, log = () => {}, grants = new MockGrantPort({ now }), receipts = new LocalReceiptPort(), uncertainWindowMs = UNCERTAIN_WINDOW_MS }) {
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
    return ok({ owner: principal.owner, agentId: principal.agentId, scopes: principal.scopes, write: principal.scopes.includes(SCOPES.CARAVAN),
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
    db.plans[id] = { id, linkId: principal.linkId, createdAt: now(), expiresAt: now() + PLAN_TTL_MS, usedBy: null,
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
    const opId = opIdOf(principal, requestId);
    return single(opId, async () => {
      // A retry of a decision already taken: the same operation, never a second send.
      const prior = db.operations[opId];
      if (prior) {
        if (prior.planId !== planId) return fail('IdempotencyConflict', 'this requestId was used for another plan: use a new requestId', { operationId: opId });
        if (prior.state === STATES.REQUESTED) return joined(await resume(principal, prior));
        return joined(answer(await track(prior, principal)));
      }
      // Async reads first (the owner's village as it is now), then every decision synchronously.
      let v;
      try { v = await game.view(principal); } catch (e) { return gameFail(e); }
      const plan = db.plans[planId];
      if (!plan || plan.linkId !== principal.linkId) return fail('PlanUnknown', 'no such plan for this connection: prepare_caravan first');
      if (plan.usedBy) return fail('PlanUsed', 'this plan was already sent', { operationId: plan.usedBy });
      if (plan.expiresAt <= now()) return fail('PlanExpired', 'the plan has expired: prepare again');
      if (Number(v.citizen?.caravans ?? -1) !== plan.seq || v.agent.village.some((x, i) => x !== plan.holding[i])) return fail('PlanStale', 'the village changed since the plan (another caravan was sent): prepare again');
      const link = auth.link(principal.linkId);
      const op = { id: opId, requestId, planId, linkId: principal.linkId, kind: 'caravan.send', state: null, createdAt: new Date(now()).toISOString(), updatedAt: null, steps: [],
        planSummary: plan.summary, caravan: { seq: plan.seq, ownerTag: v.citizenTag, arriveAt: null, outcome: null }, eventsCursor: '0', attempts: 0, unknownSince: null, grant: 'none' };
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
    const stop = late ?? (capability ? null : 'NoCapability');
    if (stop) {
      if (op.attempts === 0) definite(op, link, stop, `no send: ${stop}`);
      else uncertain(op, link, `no new attempt (${stop}); an earlier attempt may have been sent: the chain decides`);
      store.save();
      return answer(op);
    }
    const request = { agentId: principal.agentId, source: 'mcp', idempotencyKey: `ws03:${op.linkId}:${op.requestId}`, policyVersion: plan.policyVersion, modeEpoch: plan.modeEpoch,
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
    op.gateway = { status: res.status ?? null, signature: res.signature ?? null, code: res.error?.code ?? res.code ?? null, replayed: res.replayed === true, charges: res.charges ?? [] };
    if (r.status === 200 && res.status === 'sent') {
      delete op.error;
      grantConsume(link, op);
      step(op, STATES.ACCEPTED, 'the relay sent the transaction');
    } else if (r.status === 200 && res.status === 'failed') {
      // The gateway attempted the send and its outcome is the chain's (it gives no signature then).
      uncertain(op, link, 'the send was attempted and its outcome is unknown: the chain decides');
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

  /** The caravan's own trace (by owner tag and seq): on the road, sent, raided, settled. Moves `op` on. */
  async function evidence(op) {
    const feed = await game.caravansFeed();
    const c = feed?.caravans?.moving?.find(x => String(x.ownerTag) === op.caravan.ownerTag && x.seq === op.caravan.seq);
    let seen = false;
    if (c) { seen = true; op.caravan.arriveAt = new Date(Number(c.arriveTs) * 1000).toISOString(); op.caravan.raided = c.raided; }
    for (let i = 0; i < EVENT_PAGES_PER_CHECK && !TERMINAL.includes(op.state); i++) {
      const page = await game.events(op.eventsCursor);
      if (!page) break;
      for (const row of page.events) {
        const e = caravanEvent(row);
        if (!e || e.ownerTag !== op.caravan.ownerTag || e.seq !== op.caravan.seq) continue;
        seen = true;
        if (e.kind === KINDS.CARAVAN_SENT) op.caravan.arriveAt ??= new Date(Number(e.payload.arrive_ts) * 1000).toISOString();
        if (op.state !== STATES.PROCESSING && !TERMINAL.includes(op.state)) step(op, STATES.PROCESSING, 'the caravan is on the road (its record)');
        if (e.kind === KINDS.CARAVAN_RAIDED) {
          const choice = RAID_CHOICE[Number(e.payload.choice)] ?? 'raided';
          op.caravan.raid = { bell: Number(e.payload.bell), choice };
          if (choice === 'taken') { op.outcome = 'taken'; op.arrival = receipts.arrival(op); step(op, STATES.COMPLETED, 'another village took the caravan in a raid'); }
        }
        if (e.kind === KINDS.CARAVAN_SETTLED && !TERMINAL.includes(op.state)) {
          const o = SETTLE_OUTCOME[Number(e.payload.outcome)] ?? 'settled';
          op.outcome = op.caravan.raid?.choice === 'burned' && o === 'delivered' ? 'burned' : o;
          op.caravan.settledAtBell = e.bell;
          op.arrival = receipts.arrival(op);
          step(op, STATES.COMPLETED, op.outcome === 'delivered' ? 'the caravan arrived and was settled' : `the caravan was settled: ${op.outcome}`);
        }
      }
      if (page.next !== null && page.next !== undefined) op.eventsCursor = String(page.next);
      if (!page.full) break;
    }
    if (seen && (op.state === STATES.ACCEPTED || op.state === STATES.REQUESTED)) step(op, STATES.PROCESSING, 'the caravan is on the road');
    return seen;
  }

  /** Moves an operation on from what the chain and the herald now say (pull: the client asks again). */
  async function track(op, principal = null) {
    if (TERMINAL.includes(op.state)) return op;
    // A request that never reached the relay has nothing to look for (unless an attempt's outcome is unknown).
    if (op.state === STATES.REQUESTED && op.unknownSince === null) return op;
    const link = auth.link(op.linkId);
    if (op.state === STATES.ACCEPTED && op.gateway?.signature) {
      const tx = await game.txStatus(op.gateway.signature);
      if (tx?.state === 'landed') { op.chain = { state: 'landed', slot: tx.slot ?? null }; step(op, STATES.PROCESSING, 'the transaction landed: the caravan is on the road'); }
      else if (tx?.state === 'failed') { op.chain = { state: 'failed', code: tx.code ?? null }; definite(op, link, tx.code ?? 'TransactionFailed', 'the transaction failed on chain: nothing moved', 'program'); }
      else if (tx?.state === 'expired') { op.chain = { state: 'expired' }; definite(op, link, 'Expired', 'the transaction expired before it landed: nothing moved'); }
      else op.chain = { state: tx?.state ?? 'unknown' };
    }
    if (!TERMINAL.includes(op.state)) {
      const seen = await evidence(op);
      // Unknown outcome, no trace after the window, and the owner's caravan counter never reached past this seq:
      // the transaction can no longer land (its blockhash has expired): nothing was sent.
      if (!seen && op.unknownSince !== null && op.state !== STATES.PROCESSING && now() - op.unknownSince >= uncertainWindowMs) {
        const owner = principal?.owner ?? link?.owner;
        const me = owner ? await game.herald.me(owner) : null;
        const counter = me?.ok ? Number(me.citizen?.caravans ?? -1) : -1;
        if (counter >= 0 && counter <= op.caravan.seq) definite(op, link, 'NotSent', 'the attempt left no trace and can no longer land: nothing was sent');
      }
    }
    store.save();
    return op;
  }

  const mineOp = (principal, op) => op && op.linkId === principal.linkId;

  /**
   * The owner's operations across all their connections, revoked ones included: for an owner whose signed query
   * auth.ownerQuery verified (http: POST /owner/operations). Reads only. A revoked connection's operations are
   * reconciled here: one with no recorded attempt is failed and its hold given back (the attempt counter is
   * written before anything leaves, so 0 means nothing was sent); any other is tracked on the chain and herald.
   */
  async function ownerOperations(owner) {
    const links = Object.values(db.links).filter(l => l.owner === owner);
    const ids = new Set(links.map(l => l.linkId));
    const ops = Object.values(db.operations).filter(op => ids.has(op.linkId)).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, 50);
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
    if (typeof args?.operationId === 'string') op = db.operations[args.operationId];
    else if (typeof args?.requestId === 'string' && REQUEST_ID.test(args.requestId)) op = db.operations[opIdOf(principal, args.requestId)];
    else return fail('BadRequest', 'operationId or requestId is required');
    if (!mineOp(principal, op)) return fail('UnknownOperation', 'no such operation for this connection');
    return answer(await track(op, principal));
  }

  async function listOps(principal) {
    const mine = Object.values(db.operations).filter(op => mineOp(principal, op)).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, 20);
    return ok({ operations: mine.map(op => ({ operationId: op.id, requestId: op.requestId, state: op.state, outcome: op.outcome ?? null, createdAt: op.createdAt, updatedAt: op.updatedAt, summary: op.planSummary })) });
  }

  const tools = { get_connection: connection, get_village_status: status, check_resource_shortfall: shortfall, prepare_caravan: prepare, send_caravan: send, get_operation_status: opStatus, list_operations: listOps };

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
        try { return reply(await fn(principal, msg.params?.arguments ?? {})); } catch (e) { log(`mcp: ${name} threw ${scrub(e?.message)}`); return reply(fail('InternalError', 'internal error')); }
      }
      default: return notification ? null : error(-32601, `method not found: ${msg.method.slice(0, 40)}`);
    }
  }

  return { handle, tools: Object.keys(tools), track, ownerOperations, receipts: { contract: receipts.contract, real: receipts.real } };
}
