// The autopilot's authority stays bounded in a world that does not end.
//
// A continuing world is no reason to make a mandate permanent or to drop a budget cap: the owner's delegation and money
// must still run out unless the owner renews them. Checked at every start and resume, before any model call:
//   - the mandate has an expiry, in the future, at most MAX_MANDATE_SECS ahead (the Citizen's session key itself is
//     capped at 30 days by the program: frontier-abi layout/player.rs MAX_SESSION_SECS; a mandate does not outlive it)
//   - the inference budget has a total cap (a per-day cap alone would refill forever)
// Renewal is the owner's act (a new mandate, a new cap); nothing here extends either.
export const MAX_MANDATE_SECS = 30 * 86_400;

export function checkBounds({ mandate, costs, nowSec }) {
  const reasons = [];
  const exp = mandate?.expiresAt;
  if (!Number.isFinite(exp) || exp <= 0) reasons.push({ code: 'MandateUnbounded', detail: 'the mandate has no expiry: a delegation must run out unless the owner renews it' });
  else if (exp <= nowSec) reasons.push({ code: 'MandateExpired', detail: 'the mandate has expired: the owner renews it' });
  else if (exp - nowSec > MAX_MANDATE_SECS) reasons.push({ code: 'MandateTooLong', detail: `the mandate runs ${Math.round((exp - nowSec) / 86_400)} days; at most ${MAX_MANDATE_SECS / 86_400} (the session key's own limit)` });
  if (!costs) reasons.push({ code: 'BudgetUnknown', detail: 'the decider has no cost ledger to bound' });
  else if (costs.caps?.total === null || costs.caps?.total === undefined) reasons.push({ code: 'BudgetUnbounded', detail: 'the inference budget has no total cap: a per-day cap alone refills forever' });
  return { ok: reasons.length === 0, reasons };
}
