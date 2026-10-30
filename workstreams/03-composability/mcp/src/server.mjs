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
import { MockGrantPort, STATES, TERMINAL, receiptOf } from './ports.mjs';
import { KINDS, SETTLE_OUTCOME, RAID_CHOICE, caravanEvent } from './events.mjs';
import { REQUEST_ID, SERVER_INSTRUCTIONS, TOOLS } from './tools.mjs';

export const PROTOCOL_VERSIONS = Object.freeze(['2025-11-25', '2025-06-18', '2025-03-26']);
export const SERVER_INFO = Object.freeze({ name: 'wylls-mcp', title: 'Wylls (local test stack)', version: '0.1.0' });
export const PLAN_TTL_MS = 5 * 60_000;
const EVENT_PAGES_PER_CHECK = 10;

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
export function createWyllsMcp({ auth, game, store, now = Date.now, log = () => {}, grants = new MockGrantPort({ now }) }) {
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
      budget: { source: 'agent wallet (GET /f/agent)', testAssetsOnly: true, balance: a.balance, policyBudget: a.policy?.budget ?? null, day: a.day ?? null, quota: a.quota ?? null },
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

  async function send(principal, args) {
    const denied = needScope(principal, SCOPES.CARAVAN);
    if (denied) return denied;
    const requestId = String(args?.requestId ?? '');
    if (!REQUEST_ID.test(requestId)) return fail('BadRequest', 'requestId: 8–100 characters of A–Z a–z 0–9 . _ : -');
    const planId = String(args?.planId ?? '');
    const opId = opIdOf(principal, requestId);
    // A retry of a decision already taken: the same operation, never a second send.
    const prior = db.operations[opId];
    if (prior) {
      if (prior.planId !== planId) return fail('IdempotencyConflict', 'this requestId was used for another plan: use a new requestId', { operationId: opId });
      if (prior.state === STATES.REQUESTED) return resume(principal, prior, true);
      return ok({ ...receiptOf(await track(prior)), replayed: true });
    }
    if (inflight.has(opId)) return inflight.get(opId).then(r => ({ ...r, structuredContent: { ...r.structuredContent, replayed: true }, content: text({ ...r.structuredContent, replayed: true }) }));
    const run = (async () => {
      // Async reads first (the owner's village as it is now), then every decision synchronously.
      let v;
      try { v = await game.view(principal); } catch (e) { return gameFail(e); }
      if (db.operations[opId]) return ok({ ...receiptOf(db.operations[opId]), replayed: true });
      const plan = db.plans[planId];
      if (!plan || plan.linkId !== principal.linkId) return fail('PlanUnknown', 'no such plan for this connection: prepare_caravan first');
      if (plan.usedBy) return fail('PlanUsed', 'this plan was already sent', { operationId: plan.usedBy });
      if (plan.expiresAt <= now()) return fail('PlanExpired', 'the plan has expired: prepare again');
      if (Number(v.citizen?.caravans ?? -1) !== plan.seq || v.agent.village.some((x, i) => x !== plan.holding[i])) return fail('PlanStale', 'the village changed since the plan (another caravan was sent): prepare again');
      const link = auth.link(principal.linkId);
      const op = { id: opId, requestId, planId, linkId: principal.linkId, kind: 'caravan.send', state: null, createdAt: new Date(now()).toISOString(), updatedAt: null, steps: [],
        planSummary: plan.summary, caravan: { seq: plan.seq, ownerTag: v.citizenTag, arriveAt: null, outcome: null }, eventsCursor: '0' };
      const g = grants.reserve(link, { name: 'SendCaravan', cargo: plan.cargo }, opId);
      if (!g.ok) {
        step(op, STATES.REQUESTED);
        op.error = { code: g.code, message: g.message, retryable: false, by: 'grant (mock of workstream 02)' };
        step(op, STATES.FAILED, g.code);
        db.operations[opId] = op;
        store.save();
        return fail(g.code, g.message, { operationId: opId, receipt: receiptOf(op) });
      }
      plan.usedBy = opId;
      step(op, STATES.REQUESTED);
      db.operations[opId] = op;
      store.save(); // written before anything leaves: a restart finds the request and resumes it under the same key
      return resume(principal, op, false);
    })();
    inflight.set(opId, run);
    try { return await run; } finally { inflight.delete(opId); }
  }

  /** Sends (or re-sends under the same idempotency key) an operation still `requested`. */
  async function resume(principal, op, replayed) {
    const plan = db.plans[op.planId];
    const link = auth.link(op.linkId);
    const capability = auth.capabilityOf(op.linkId);
    if (!capability) {
      op.error = { code: 'NoCapability', message: 'the connection holds no agent capability (revoked or read-only)', retryable: false };
      grants.release(link, op.id);
      step(op, STATES.FAILED, 'NoCapability');
      store.save();
      return fail('NoCapability', op.error.message, { operationId: op.id, receipt: receiptOf(op) });
    }
    const request = { agentId: principal.agentId, source: 'mcp', idempotencyKey: `ws03:${op.linkId}:${op.requestId}`, policyVersion: plan.policyVersion, modeEpoch: plan.modeEpoch,
      action: { name: 'SendCaravan', holding: plan.holding, fields: plan.fields, route: plan.route } };
    const r = await game.submit(capability, request);
    if (r.transport) {
      // Unknown whether the relay got it: the operation stays requested; a retry with the same requestId is safe.
      op.error = { code: 'RelayUnreachable', message: 'the relay was not reached; retry with the same requestId', retryable: true };
      op.updatedAt = new Date(now()).toISOString();
      store.save();
      return fail('RelayUnreachable', op.error.message, { operationId: op.id, retrySameRequestId: true, receipt: receiptOf(op) });
    }
    const res = r.json ?? {};
    delete op.error;
    op.gateway = { status: res.status ?? null, signature: res.signature ?? null, code: res.error?.code ?? res.code ?? null, replayed: res.replayed === true, charges: res.charges ?? [] };
    if (r.status === 200 && res.status === 'sent') {
      grants.consume(link, op.id);
      step(op, STATES.ACCEPTED, 'the relay sent the transaction');
    } else if (r.status === 200 && res.status === 'failed' && res.signature) {
      grants.consume(link, op.id);
      step(op, STATES.ACCEPTED, 'the send was attempted; the chain decides');
    } else {
      grants.release(link, op.id);
      const code = res.error?.code ?? res.code ?? `HTTP${r.status}`;
      op.error = { code, message: scrub(res.error?.message ?? res.error ?? 'refused'), retryable: false, by: 'agent wallet gateway / relay' };
      step(op, STATES.FAILED, code);
    }
    store.save();
    log(`mcp: ${op.id} ${op.state}${op.error ? ` (${op.error.code})` : ''}`);
    const out = receiptOf(op);
    return op.state === STATES.FAILED ? fail(op.error.code, op.error.message, { operationId: op.id, receipt: out }) : ok({ ...out, ...(replayed ? { replayed: true } : {}) });
  }

  /** Moves an operation on from what the chain and the herald now say (pull: the client asks again). */
  async function track(op) {
    if (TERMINAL.includes(op.state) || op.state === STATES.REQUESTED) return op;
    if (op.state === STATES.ACCEPTED && op.gateway?.signature) {
      const tx = await game.txStatus(op.gateway.signature);
      if (tx?.state === 'landed') { op.chain = { state: 'landed', slot: tx.slot ?? null }; step(op, STATES.PROCESSING, 'the transaction landed: the caravan is on the road'); }
      else if (tx?.state === 'failed') { op.chain = { state: 'failed', code: tx.code ?? null }; op.error = { code: tx.code ?? 'TransactionFailed', message: 'the transaction failed on chain: nothing moved', retryable: false, by: 'program' }; step(op, STATES.FAILED, op.error.code); }
      else if (tx?.state === 'expired') { op.chain = { state: 'expired' }; op.error = { code: 'Expired', message: 'the transaction expired before it landed: nothing moved', retryable: false }; step(op, STATES.FAILED, 'Expired'); }
      else op.chain = { state: tx?.state ?? 'unknown' };
    }
    if (op.state === STATES.PROCESSING) {
      const feed = await game.caravansFeed();
      const c = feed?.caravans?.moving?.find(x => String(x.ownerTag) === op.caravan.ownerTag && x.seq === op.caravan.seq);
      if (c) { op.caravan.arriveAt = new Date(Number(c.arriveTs) * 1000).toISOString(); op.caravan.raided = c.raided; }
      for (let i = 0; i < EVENT_PAGES_PER_CHECK && !TERMINAL.includes(op.state); i++) {
        const page = await game.events(op.eventsCursor);
        if (!page) break;
        for (const row of page.events) {
          const e = caravanEvent(row);
          if (!e || e.ownerTag !== op.caravan.ownerTag || e.seq !== op.caravan.seq) continue;
          if (e.kind === KINDS.CARAVAN_SENT) op.caravan.arriveAt ??= new Date(Number(e.payload.arrive_ts) * 1000).toISOString();
          if (e.kind === KINDS.CARAVAN_RAIDED) {
            const choice = RAID_CHOICE[Number(e.payload.choice)] ?? 'raided';
            op.caravan.raid = { bell: Number(e.payload.bell), choice };
            if (choice === 'taken') { op.outcome = 'taken'; step(op, STATES.COMPLETED, 'another village took the caravan in a raid'); }
          }
          if (e.kind === KINDS.CARAVAN_SETTLED && !TERMINAL.includes(op.state)) {
            const o = SETTLE_OUTCOME[Number(e.payload.outcome)] ?? 'settled';
            op.outcome = op.caravan.raid?.choice === 'burned' && o === 'delivered' ? 'burned' : o;
            op.caravan.settledAtBell = e.bell;
            step(op, STATES.COMPLETED, op.outcome === 'delivered' ? 'the caravan arrived and was settled' : `the caravan was settled: ${op.outcome}`);
          }
        }
        if (page.next !== null && page.next !== undefined) op.eventsCursor = String(page.next);
        if (!page.full) break;
      }
    }
    store.save();
    return op;
  }

  const mineOp = (principal, op) => op && op.linkId === principal.linkId;

  async function opStatus(principal, args) {
    let op = null;
    if (typeof args?.operationId === 'string') op = db.operations[args.operationId];
    else if (typeof args?.requestId === 'string' && REQUEST_ID.test(args.requestId)) op = db.operations[opIdOf(principal, args.requestId)];
    else return fail('BadRequest', 'operationId or requestId is required');
    if (!mineOp(principal, op)) return fail('UnknownOperation', 'no such operation for this connection');
    return ok(receiptOf(await track(op)));
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

  return { handle, tools: Object.keys(tools), track };
}
