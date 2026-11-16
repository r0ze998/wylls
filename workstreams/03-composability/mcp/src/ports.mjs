// The three boundaries this server does not own, as ports:
//
//   GrantPort      ② rights. **MOCK** (`wylls.mock-grant/0`): workstream 02's Grant was not received. The mock
//                  keeps the limits the owner signed at consent (actions, sends, cargo per send, expiry) and
//                  enforces them here, before the gateway. It is not a rights model; replace it.
//   RunReceipt     ④ execution and result tracking. **MOCK** (`wylls.mock-run-receipt/0`): the states and
//                  fields are a proposal (docs 08 §4), not a production contract.
//   Budget         ⑤ AI budget, payment, manual/auto. **Not a mock and not ours:** the agent wallet's ledger,
//                  read through GET /f/agent and enforced by AgentGateway on every request. This server keeps
//                  no balance and no price of its own.
//
// Everything here is synchronous where it decides, so two concurrent calls cannot both take the last unit.

export const MOCK_GRANT_CONTRACT = 'wylls.mock-grant/0';
export const MOCK_RUN_RECEIPT = 'wylls.mock-run-receipt/0';

/** The grant the consent statement names (normalised), or throws. */
export function normaliseGrant(g, { now, maxTtlMs }) {
  const bad = m => { throw Object.assign(new Error(`grant: ${m}`), { code: 'BadGrant' }); };
  if (!g || typeof g !== 'object') bad('missing');
  const actions = Array.isArray(g.actions) ? [...new Set(g.actions)] : bad('actions must be a list');
  for (const a of actions) if (a !== 'SendCaravan') bad(`${a} is not an action this server can ask for`);
  if (!Number.isInteger(g.maxSends) || g.maxSends < 1 || g.maxSends > 100) bad('maxSends must be 1–100');
  if (!Array.isArray(g.maxCargo) || g.maxCargo.length !== 8 || !g.maxCargo.every(v => Number.isInteger(v) && v >= 0 && v <= 1_000_000)) bad('maxCargo must be eight whole amounts');
  if (!Number.isInteger(g.expiresAt) || g.expiresAt <= now || g.expiresAt > now + maxTtlMs) bad('expiresAt must be in the future and within the link\'s lifetime');
  return { contract: MOCK_GRANT_CONTRACT, actions, maxSends: g.maxSends, maxCargo: [...g.maxCargo], expiresAt: g.expiresAt };
}

/** ② MOCK: the link's signed limits, used and reserved per operation. */
export class MockGrantPort {
  constructor({ now = Date.now } = {}) { this.now = now; }

  /** Whether the link's grant allows `action` now; `{ok, code?, message?}` (no change). */
  check(link, action) {
    const g = link.grant;
    if (!g) return { ok: false, code: 'GrantMissing', message: 'the owner granted no write action to this connection' };
    if (link.revokedAt) return { ok: false, code: 'GrantRevoked', message: 'the owner revoked this connection' };
    if (this.now() >= g.expiresAt) return { ok: false, code: 'GrantExpired', message: 'the owner\'s grant for this connection has expired' };
    if (!g.actions.includes(action.name)) return { ok: false, code: 'GrantActionNotAllowed', message: `${action.name} is not granted to this connection` };
    const use = link.grantUse ?? { used: 0, reserved: {} };
    if (use.used + Object.keys(use.reserved).length >= g.maxSends) return { ok: false, code: 'GrantLimitReached', message: `the grant allows ${g.maxSends} send(s); they are used` };
    const over = (action.cargo ?? []).findIndex((v, i) => v > g.maxCargo[i]);
    if (over >= 0) return { ok: false, code: 'GrantCargoOverCap', message: `resource ${over}: ${action.cargo[over]} is over the granted ${g.maxCargo[over]} per send`, resource: over };
    return { ok: true };
  }

  /** check, then hold one send for `opId` (synchronous). */
  reserve(link, action, opId) {
    const c = this.check(link, action);
    if (!c.ok) return c;
    link.grantUse ??= { used: 0, reserved: {} };
    link.grantUse.reserved[opId] = this.now();
    return c;
  }
  /** The send happened (or may have): it counts. */
  consume(link, opId) {
    if (!link.grantUse?.reserved?.[opId]) return;
    delete link.grantUse.reserved[opId];
    link.grantUse.used++;
  }
  /** A consumed send that moved nothing after all (failed on chain, expired, never sent): it no longer counts. */
  refund(link) { if (link.grantUse?.used > 0) link.grantUse.used--; }
  /** Nothing was sent: the hold comes back. */
  release(link, opId) { if (link.grantUse?.reserved) delete link.grantUse.reserved[opId]; }

  view(link) {
    const g = link.grant;
    if (!g) return null;
    const use = link.grantUse ?? { used: 0, reserved: {} };
    return { contract: MOCK_GRANT_CONTRACT, mock: true, actions: g.actions, maxSends: g.maxSends, used: use.used, reserved: Object.keys(use.reserved).length, maxCargo: g.maxCargo, expiresAt: new Date(g.expiresAt).toISOString(), expired: this.now() >= g.expiresAt };
  }
}

/** ④ MOCK: the receipt states (a proposal; docs 08 §4). */
export const STATES = Object.freeze({ REQUESTED: 'requested', ACCEPTED: 'accepted', PROCESSING: 'processing', COMPLETED: 'completed', FAILED: 'failed' });
export const TERMINAL = Object.freeze([STATES.COMPLETED, STATES.FAILED]);

/**
 * What the caller can do after a failure, by code (data for the model and the person; never an instruction
 * this server follows itself).
 */
export const RECOVERY = Object.freeze({
  RelayUnreachable: ['retry caravan_send with the same requestId (nothing is known to have been sent)'],
  GrantExpired: ['ask the owner to connect again with a new grant'],
  GrantRevoked: ['ask the owner to connect again'],
  GrantLimitReached: ['ask the owner to connect again with more sends'],
  GrantCargoOverCap: ['prepare a smaller caravan', 'ask the owner for a larger cap'],
  GrantActionNotAllowed: ['ask the owner to grant the action'],
  // Generic; actionNotAllowedNext picks the advice from the relay's own message (three different causes).
  ActionNotAllowed: ['the relay refused SendCaravan for this agent (the agent\'s policy, a season other than S1, or a relay without patch 0005): error.message says which'],
  AgentStopped: ['the owner switches the agent to auto on the agent page'],
  StalePolicy: ['read village_status again and prepare again'],
  StaleMode: ['read village_status again and prepare again'],
  SessionNotDelegated: ['the owner gives the agent\'s key the village with SetSession (agent page)'],
  BudgetExceeded: ['the owner raises the agent\'s budget or deposits more (agent page)'],
  DailyLimitReached: ['wait for the next UTC day', 'the owner raises the daily limit'],
  InsufficientBalance: ['the owner deposits more (agent page)'],
  Insufficient: ['prepare a smaller caravan', 'wait for production'],
  PlanExpired: ['prepare again'],
  PlanUsed: ['check operation_status of the operation that used the plan'],
  PlanStale: ['prepare again: the village changed'],
  WrongVillage: ['the agent acts on its own village only'],
  TransactionFailed: ['check village_status; prepare again'],
  Expired: ['the transaction expired before it landed: prepare again (nothing moved)'],
  lost: ['the destination changed generation: nothing can be recovered for this caravan'],
  taken: ['another village took the caravan in a raid: nothing can be recovered for this caravan'],
  burned: ['a raid burned the cargo: nothing can be recovered for this caravan'],
});

/**
 * The relay answers ActionNotAllowed for different reasons (permutation-gateway src/frontier/agent, read only):
 * policy.mjs checkAllowed "<name> is not allowed for this agent" (the policy does not allow it — or, on a relay
 * without workstream 03 patch 0005, the action is not an agent action there at all: the same message), gateway.mjs
 * "SendCaravan exists in S1 seasons only", and gateway.mjs "<name> is not an action an agent sends" (a relay that does
 * not take SendCaravan from an agent). The advice follows the message the relay gave; it never says that allowing the
 * transport group always helps.
 */
export function actionNotAllowedNext(message) {
  const m = String(message ?? '');
  if (/is not allowed for this agent/.test(m)) return ['the owner allows the transport group (SendCaravan) in the agent\'s policy (agent page), then prepares again; on a relay without patch 0005 there is no transport group to allow'];
  if (/S1 seasons only/.test(m)) return ['this season takes no caravans from an agent (SendCaravan exists in S1 seasons only): a policy change does not help'];
  if (/is not an action an agent sends/.test(m)) return ['this relay does not take SendCaravan from an agent (a relay without patch 0005): a policy change does not help'];
  return RECOVERY.ActionNotAllowed;
}

/**
 * Not decided yet, and its result is not known (held, or an attempt that may have been sent — 08 state table: accepted
 * also covers "result unknown"): neither sent-and-travelling nor failed, and never to be sent again.
 */
// The state is the evidence: `uncertain` and `unknownSince` are never cleared (history), so they count only where no
// later evidence moved the operation on — requested with a lost answer (the relay may or may not have it), accepted
// with an attempt whose outcome is not known; processing means it landed (its arrival is then a matter of time), and
// only a hold keeps it undecided there.
export const resultUnknown = op => !TERMINAL.includes(op.state) && (Boolean(op.hold)
  || (op.state === STATES.ACCEPTED && op.uncertain === true)
  || (op.state === STATES.REQUESTED && op.unknownSince !== null && op.unknownSince !== undefined));

/** The receipt view of an operation record (what operation_status returns). */
export function receiptOf(op) {
  const unknown = resultUnknown(op);
  const next = op.state === STATES.FAILED ? (op.error?.code === 'ActionNotAllowed' ? actionNotAllowedNext(op.error.message) : RECOVERY[op.error?.code] ?? ['prepare again'])
    : op.state === STATES.COMPLETED ? (op.outcome === 'delivered' ? [] : RECOVERY[op.outcome] ?? [])
    : unknown && op.state === STATES.REQUESTED && !op.hold ? [`the result is not known yet${op.error?.code ? ` (${op.error.code})` : ''}: the relay may or may not have the request; it is neither delivered nor failed; call operation_status again later (it asks without sending) — a retry may only reuse the same requestId, never a new plan or a new requestId`]
    : unknown ? [`the result is not known yet${op.hold ? ` (${op.hold.code})` : ''}: do not prepare or send this again; it is neither delivered nor failed until operation_status says so; call operation_status again later`]
    : ['call operation_status again later (arrival is not instant; ETA in caravan.arriveAt)'];
  return {
    contract: MOCK_RUN_RECEIPT, mock: true,
    operationId: op.id, requestId: op.requestId, kind: op.kind, state: op.state, terminal: TERMINAL.includes(op.state),
    ...(op.outcome ? { outcome: op.outcome } : {}),
    createdAt: op.createdAt, updatedAt: op.updatedAt,
    plan: op.planSummary,
    gateway: op.gateway ?? null,
    chain: op.chain ?? null,
    // The signature's lifetime as the relay recorded it (patch 0007), and the agent wallet's own record for this
    // request's key when the answer was lost (read without re-sending).
    ...(op.lifetime ? { lifetime: op.lifetime } : {}),
    ...(op.agentRecord ? { agentRecord: op.agentRecord } : {}),
    // The wallet's answer for this request's key (workstream 04's seven states), and ④'s registry receipt.
    ...(op.fate ? { fate: op.fate } : {}),
    ...(op.ws04Act ? { ws04Act: op.ws04Act } : {}),
    caravan: op.caravan ?? null,
    // The world context the operation was made in (null: made before contexts were recorded; never assumed to be the
    // current one).
    context: op.context ?? null, contextRecorded: op.context !== undefined,
    ...(op.runId ? { runId: op.runId } : {}),
    ...(op.arrival ? { arrival: op.arrival } : {}),
    ...(op.hold ? { hold: op.hold } : {}),
    ...(op.error ? { error: op.error } : {}),
    history: op.steps.map(s => ({ ...s })),
    next,
    notes: ['accepted = the relay sent the transaction, or an attempt whose result is not known yet (then hold and history say so); processing = it landed and the caravan is on the road; completed = the caravan was settled (delivered, lost, or raided). Sending is not arriving, and an unknown result is neither.',
      'completed is the end of transport; arrival.quantity says whether the amount that arrived is known (unverified: it is not).'],
  };
}

/**
 * A revoked connection's cancellation, in ④'s three stages as reported (④'s contract not received: MOCK shape):
 * new requests stopped; requests that may have been sent awaiting reconciliation; done when none is left.
 */
export function cancellationOf(link, ops) {
  if (!link?.revokedAt) return null;
  const pending = ops.filter(o => !TERMINAL.includes(o.state)).map(o => o.id);
  return { contract: MOCK_RUN_RECEIPT, mock: true, newRequests: 'stopped', since: new Date(link.revokedAt).toISOString(),
    awaitingReconciliation: pending, state: pending.length ? 'reconciling' : 'done' };
}
