// The boundary with ⑤ (the agent wallet: budget, balance, policy, mode, delegation). This server keeps no balance,
// no hold and no price of its own: it reads ⑤'s view (GET /f/agent) and passes ⑤'s refusals through with their code.
// This module only names, for the owner and the model, whose decision a refusal was and what can be done about it.
// The codes are ⑤'s (permutation-gateway/src/frontier/agent/contract.mjs ERR); test/budget-port.test.mjs checks
// every code here against the gateway in use, so a renamed code fails the tests instead of being guessed.

/** ⑤'s view of the agent as this server shows it (read-only; nothing computed here). */
export function budgetOf(agentView) {
  const a = agentView ?? {};
  return { source: 'agent wallet (GET /f/agent)', owner: '⑤', testAssetsOnly: true, balance: a.balance ?? null, policyBudget: a.policy?.budget ?? null, day: a.day ?? null, quota: a.quota ?? null };
}

const R = (by, kind, retrySame, next) => Object.freeze({ by, kind, retrySame, next });
/**
 * ⑤'s refusal codes that `POST /f/agent/action` can answer, with whose decision each is (`⑤`, `chain` through ⑤,
 * or `owner` action needed) and the next step. `retrySame`: the same requestId may be sent again unchanged.
 */
export const FIVE_REFUSALS = Object.freeze({
  BadRequest: R('⑤', 'request', false, 'prepare the caravan again'),
  UnknownAgent: R('⑤', 'agent', false, 'the owner reconnects with an existing agent'),
  NotOwner: R('⑤', 'agent', false, 'the owner reconnects with their own agent'),
  BadCapability: R('⑤', 'agent', false, 'the owner reconnects (the agent\'s capability was rotated)'),
  AgentStopped: R('⑤', 'mode', false, 'the owner switches the agent to auto on the agent page, then prepares again'),
  StalePolicy: R('⑤', 'policy', false, 'the owner changed the policy: prepare again'),
  StaleMode: R('⑤', 'mode', false, 'the mode changed since the plan: prepare again'),
  ActionNotAllowed: R('⑤', 'policy', false, 'the owner allows the transport group in the agent\'s policy (and the relay needs patch 0005)'),
  WrongVillage: R('⑤', 'policy', false, 'only the agent\'s own village can send'),
  BudgetExceeded: R('⑤', 'budget', false, 'the owner raises the budget, or waits'),
  DailyLimitReached: R('⑤', 'budget', false, 'wait for the next UTC day, or the owner raises the daily limit'),
  CallLimitReached: R('⑤', 'budget', false, 'wait, or the owner raises the call limit'),
  InsufficientBalance: R('⑤', 'budget', false, 'the owner deposits test USDC on the agent page (a wallet-signed transfer, never a tool)'),
  IdempotencyConflict: R('⑤', 'request', false, 'use a new requestId for a different request'),
  SessionNotDelegated: R('⑤', 'delegation', false, 'the owner delegates the village to the agent on chain (SetSession, wallet-signed)'),
  RelayRefused: R('⑤', 'request', false, 'the relay refused the transaction\'s shape: prepare again'),
  SendFailed: R('chain', 'chain', false, 'the chain\'s answer is in the receipt'),
  AgentKeyDirect: R('⑤', 'request', false, 'the agent\'s key is used only through the agent wallet'),
  AgentWalletDisabled: R('⑤', 'agent', false, 'the relay runs without the agent wallet'),
  // ⑤'s patch 0001 (agent-wallet-staking-limits, ⑤ ba3c180b; not applied in this repository): present only on a
  // gateway that has it.
  PerCallLimit: R('⑤', 'budget', false, 'the owner raises the per-call limit, or the plan asks for less'),
  CategoryLimit: R('⑤', 'budget', false, 'the owner raises this category\'s limit (game or inference), or waits for the next day'),
  PolicyExpired: R('⑤', 'policy', false, 'the owner renews the agent\'s permission (its policy expired)'),
});

/** Codes above that only ⑤'s patch 0001 adds: a gateway without it does not have them (and is not wrong). */
export const FIVE_PATCH_0001_CODES = Object.freeze(['PerCallLimit', 'CategoryLimit', 'PolicyExpired']);

/**
 * ⑤'s codes that `POST /f/agent/action` does not answer (deposits, withdrawals, model calls, owner commands, agent
 * creation): listed so that the tests know every code of ⑤'s is accounted for.
 */
export const FIVE_NOT_FROM_ACTIONS = Object.freeze(['BadOwnerSignature', 'OwnerCommandExpired', 'OwnerCommandReplayed', 'DepositInvalid', 'DepositPending', 'WithdrawFailed', 'InferenceFailed', 'TooManyAgents']);

/** Whose decision a refusal was. An unknown code is reported as unknown, never guessed. */
export function refusalOf(code) {
  return FIVE_REFUSALS[code] ?? Object.freeze({ by: 'unknown', kind: 'unknown', retrySame: false, next: `an unrecognised refusal (${String(code).slice(0, 40)}): shown as the relay gave it` });
}
