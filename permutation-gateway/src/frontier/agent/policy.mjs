// Agent policies (docs/agent-wallet/DESIGN.md §4.2): what an owner allows
// and how much the agent may spend. Set only by owner commands; enforced by
// the gateway on every request, never by the model's prompt.
//
//   { allowed: [action or group name, …],
//     budget: { total, perDay, callsPerDay?,      // test-USDC base units (strings); callsPerDay: model calls a day (integer), optional
//               perCall?,                         // optional: the most one hold (one model call, one priced action) may take
//               byCategory? },                    // optional: { inference: {total?, perDay?}, game: {total?, perDay?} }, apart from the whole
//     expiresAt? }                                // optional: unix ms after which the agent may not act or call (the owner's permission ends)
//
// `total` caps all the agent's spending ever (settled + held); `perDay` caps
// one UTC day's. Prices are the operator's (config), not the owner's.
import { ACTION_GROUPS, AGENT_ACTIONS, AgentError, ERR, NEVER_DELEGATED, isAmount } from './contract.mjs';

/** The normalised policy (allowed: sorted action names) or BadRequest. */
export function normalisePolicy(p) {
  const bad = m => { throw new AgentError(ERR.BAD_REQUEST, `policy: ${m}`); };
  if (!p || typeof p !== 'object') bad('missing');
  if (!Array.isArray(p.allowed)) bad('allowed must be a list of actions or groups');
  const allowed = new Set();
  for (const n of p.allowed) {
    if (NEVER_DELEGATED.includes(n)) bad(`${n} can never be delegated to an agent`);
    if (ACTION_GROUPS[n]) for (const a of ACTION_GROUPS[n]) allowed.add(a);
    else if (AGENT_ACTIONS.includes(n)) allowed.add(n);
    else bad(`unknown action or group ${n}`);
  }
  const b = p.budget ?? {};
  if (!isAmount(b.total)) bad('budget.total must be a base-unit amount string');
  if (!isAmount(b.perDay)) bad('budget.perDay must be a base-unit amount string');
  if (b.callsPerDay !== undefined && b.callsPerDay !== null && (!Number.isInteger(b.callsPerDay) || b.callsPerDay < 0)) bad('budget.callsPerDay must be a non-negative integer');
  if (b.perCall !== undefined && b.perCall !== null && !isAmount(b.perCall)) bad('budget.perCall must be a base-unit amount string');
  let byCategory = null;
  if (b.byCategory !== undefined && b.byCategory !== null) {
    if (typeof b.byCategory !== 'object' || Array.isArray(b.byCategory)) bad('budget.byCategory must be an object');
    byCategory = {};
    for (const [c, lim] of Object.entries(b.byCategory)) {
      if (c !== 'inference' && c !== 'game') bad(`budget.byCategory: ${c} is not a spending category an owner caps (inference, game)`);
      const out = {};
      for (const k of ['total', 'perDay']) if (lim?.[k] !== undefined && lim[k] !== null) { if (!isAmount(lim[k])) bad(`budget.byCategory.${c}.${k} must be a base-unit amount string`); out[k] = lim[k]; }
      byCategory[c] = out;
    }
  }
  if (p.expiresAt !== undefined && p.expiresAt !== null && (!Number.isSafeInteger(p.expiresAt) || p.expiresAt <= 0)) bad('expiresAt must be unix milliseconds');
  return { allowed: [...allowed].sort(), budget: { total: b.total, perDay: b.perDay, ...(Number.isInteger(b.callsPerDay) ? { callsPerDay: b.callsPerDay } : {}),
    ...(isAmount(b.perCall) ? { perCall: b.perCall } : {}), ...(byCategory ? { byCategory } : {}) }, ...(Number.isSafeInteger(p.expiresAt) ? { expiresAt: p.expiresAt } : {}) };
}

/** Throws ActionNotAllowed unless `name` is allowed by `policy` (and delegable at all). */
export function checkAllowed(policy, name) {
  if (NEVER_DELEGATED.includes(name) || !AGENT_ACTIONS.includes(name) || !policy.allowed.includes(name)) {
    throw new AgentError(ERR.ACTION_NOT_ALLOWED, `${name} is not allowed for this agent`, 403);
  }
}
