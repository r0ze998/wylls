// The agent wallet's interface (docs/agent-wallet/DESIGN.md §3): the one
// shape every entry point uses — the browser, the operator's AI runner and a
// future MCP server all send an ActionRequest and get an ActionResult, and
// all of them go through the same AgentGateway checks (owner, mode, policy
// version, allowed action, budget, balance, the game's own shape rules and
// simulation). Nothing here is MCP-specific: an MCP server is one more
// caller of AgentGateway.submit(), never a separate balance or payment path,
// and never a replacement for the owner's wallet signature.
//
// Amounts are test-USDC base units (6 decimals) carried as decimal strings.
// Local test tokens only; nothing here has value.
import { RouteError } from '../../routes/errors.mjs';

/** Where a request came from (recorded, never trusted for authority). */
export const SOURCES = Object.freeze(['browser', 'ai', 'mcp']);

/** Agent control of one owner's village. */
export const MODES = Object.freeze({ MANUAL: 'manual', AUTO: 'auto' });

/** Spending categories kept apart in the ledger and its history. */
export const CATEGORIES = Object.freeze({ INFERENCE: 'inference', NETWORK: 'network', GAME: 'game' });

/**
 * Game actions an owner may allow, in groups (the policy names actions).
 * All are existing relay player shapes signed by the session key; their
 * in-game costs are unchanged (resources, or free): the agent wallet never
 * turns a free or resource-paid action into a USDC charge. A USDC price
 * applies only when `gamePrices` names one, and that table is empty.
 */
export const ACTION_GROUPS = Object.freeze({
  economy: Object.freeze(['Harvest', 'Build', 'Train', 'Muster', 'Garrison']),
  explore: Object.freeze(['Explore']),
  military: Object.freeze(['Depart', 'Dissolve']),
  vigil: Object.freeze(['SetVigil']),
});
export const AGENT_ACTIONS = Object.freeze(Object.values(ACTION_GROUPS).flat());

/**
 * Never delegable, whatever a policy says: joining, rotating the session
 * key (wallet-only on chain anyway), founding or giving up land, and
 * conquest declarations. Ownership, payout and policy changes are not game
 * actions at all: they are owner commands (owner-auth.mjs).
 */
export const NEVER_DELEGATED = Object.freeze(['Join', 'SetSession', 'PlaceHome', 'FileTicket', 'FileOutpost', 'DeclareSiege', 'RetireHost']);

/** Machine-readable refusals (stable: callers, MCP tools and tests match on them). */
export const ERR = Object.freeze({
  BAD_REQUEST: 'BadRequest',
  UNKNOWN_AGENT: 'UnknownAgent',
  NOT_OWNER: 'NotOwner',
  BAD_OWNER_SIGNATURE: 'BadOwnerSignature',
  OWNER_COMMAND_EXPIRED: 'OwnerCommandExpired',
  OWNER_COMMAND_REPLAYED: 'OwnerCommandReplayed',
  BAD_CAPABILITY: 'BadCapability',
  AGENT_STOPPED: 'AgentStopped',
  STALE_POLICY: 'StalePolicy',
  STALE_MODE: 'StaleMode',
  ACTION_NOT_ALLOWED: 'ActionNotAllowed',
  WRONG_VILLAGE: 'WrongVillage',
  BUDGET_EXCEEDED: 'BudgetExceeded',
  DAILY_LIMIT: 'DailyLimitReached',
  CALL_LIMIT: 'CallLimitReached',
  INSUFFICIENT_BALANCE: 'InsufficientBalance',
  IDEMPOTENCY_CONFLICT: 'IdempotencyConflict',
  SESSION_NOT_DELEGATED: 'SessionNotDelegated',
  RELAY_REFUSED: 'RelayRefused',
  SEND_FAILED: 'SendFailed',
  DEPOSIT_INVALID: 'DepositInvalid',
  DEPOSIT_PENDING: 'DepositPending',
  WITHDRAW_FAILED: 'WithdrawFailed',
  INFERENCE_FAILED: 'InferenceFailed',
  AGENT_KEY_DIRECT: 'AgentKeyDirect',
  TOO_MANY_AGENTS: 'TooManyAgents',
  DISABLED: 'AgentWalletDisabled',
});

/** A refusal with a stable code: a RouteError (the HTTP layer answers it as is) whose arguments are code-first. */
export class AgentError extends RouteError {
  constructor(code, message, status = 400, extra = {}) {
    super(status, message, code, extra);
  }
}

const isInt = v => typeof v === 'string' && /^\d{1,20}$/.test(v);
const isStr = (v, max = 128) => typeof v === 'string' && v.length > 0 && v.length <= max;

/**
 * Checks an ActionRequest's shape; returns the normalised request or throws
 * BadRequest. The request:
 *
 *   { agentId, source: 'browser'|'ai'|'mcp', idempotencyKey,
 *     policyVersion,                   // the policy the caller decided under: a newer one refuses (StalePolicy)
 *     modeEpoch?,                      // optional: the auto period the caller started in (StaleMode)
 *     reason?,                          // optional, ≤ 200 chars: why the caller chose this (recorded in the history, never trusted)
 *     action: { name, holding: [p, q, site], fields: {…} } }
 *
 * Authority is never read from the request: it comes from the caller's
 * credential (the owner's signature or the agent's capability, checked by
 * the gateway) and the ledger's record of the agent.
 */
export function parseActionRequest(r) {
  const bad = m => { throw new AgentError(ERR.BAD_REQUEST, `action request: ${m}`); };
  if (!r || typeof r !== 'object') bad('not an object');
  if (!isStr(r.agentId, 64)) bad('agentId is required');
  if (!SOURCES.includes(r.source)) bad(`source must be one of ${SOURCES.join(', ')}`);
  if (!isStr(r.idempotencyKey, 128)) bad('idempotencyKey is required (≤ 128 chars)');
  if (!Number.isInteger(r.policyVersion) || r.policyVersion < 1) bad('policyVersion must be a positive integer');
  if (r.modeEpoch !== undefined && (!Number.isInteger(r.modeEpoch) || r.modeEpoch < 0)) bad('modeEpoch must be a non-negative integer');
  if (r.reason !== undefined && (typeof r.reason !== 'string' || r.reason.length > 200)) bad('reason must be a string of at most 200 chars');
  const a = r.action;
  if (!a || typeof a !== 'object') bad('action is required');
  if (!isStr(a.name, 32)) bad('action.name is required');
  if (!Array.isArray(a.holding) || a.holding.length !== 3 || !a.holding.every(Number.isInteger)) bad('action.holding must be [p, q, site]');
  const fields = a.fields ?? {};
  if (typeof fields !== 'object' || Array.isArray(fields)) bad('action.fields must be an object');
  return { agentId: r.agentId, source: r.source, idempotencyKey: r.idempotencyKey, policyVersion: r.policyVersion, modeEpoch: r.modeEpoch, reason: r.reason,
    action: { name: a.name, holding: [...a.holding], fields } };
}

/**
 * The result every entry point returns (also cached under the idempotency
 * key, so a retry returns the same object with `replayed: true`):
 *
 *   { ok, requestId, agentId, status: 'sent'|'refused'|'failed',
 *     signature?, charges: [{category, amount, state}], error?: {code, message},
 *     balance: {available, reserved, spent, withdrawn, pendingWithdraw} }
 *
 * 'sent' means the relay accepted and sent the transaction (its on-chain
 * result is GET /f/tx/{signature}); 'refused' means nothing was sent and
 * nothing was charged; 'failed' means an attempt was made and any charge it
 * carries is listed.
 */
export const RESULT_STATUS = Object.freeze({ SENT: 'sent', REFUSED: 'refused', FAILED: 'failed' });

export const isAmount = isInt;
