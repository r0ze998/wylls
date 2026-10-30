// One away-mode decision call: preflight → reserve the quote → call → settle,
// release or hold as undecided → retry only where it cannot double-bill
// without saying so. The model call is the last thing tried: everything that
// can make the call useless is checked first, for free.
import { OUTCOME, neutralRequest } from './contract.mjs';

/**
 * Whether a call is worth making now, from what is already known (no model, no cost):
 * the relay's view (agent_view), the grant (src/adapters.mjs grantFrom), the open requests, and the money.
 * @returns {{call: boolean, reasons: Array<{code, detail}>}}
 */
export function preflight({ view, grant = null, openRequests = 0, quote, gameReserve = '0', available, callsToday = null }) {
  const reasons = [];
  const no = (code, detail) => reasons.push({ code, detail });
  if (view?.mode !== 'auto') no('Stopped', 'the owner stopped the agent: nothing new is decided');
  if (!view?.delegation) no('DelegationUnread', 'the relay could not read the chain\'s delegation');
  else if (view.delegation.delegated !== true) no('NotDelegated', 'the agent\'s key is not the Citizen\'s session now (the owner, or another holder of the one session slot, has it): ⑤ does not re-delegate');
  if (grant && !grant.ok) no('GrantInvalid', grant.reasons.map(r => r.code).join(', '));
  if (grant && grant.ok && grant.allowed.length === 0) no('NothingAllowed', 'no command is delegated');
  if (openRequests < 1) no('NothingOpen', 'no open request to answer');
  const cap = view?.policy?.budget?.callsPerDay;
  if (Number.isInteger(cap) && (callsToday ?? view?.day?.calls ?? 0) >= cap) no('CallCapReached', `the owner's ${cap} model calls a day are used`);
  if (view?.quota && !(view.quota.left > 0)) no('QuotaEmpty', 'the Citizen has no sponsored transactions left today: nothing decided could be sent');
  if (BigInt(available) < BigInt(quote) + BigInt(gameReserve)) no('BudgetShort', `available ${available} < quote ${quote} + game reserve ${gameReserve}`);
  return { call: reasons.length === 0, reasons };
}

/**
 * Retries inside one decision. By default only a request that provably never left is retried: every other failure
 * leaves a cost that may have been billed (no documented idempotency key), and a retry would reserve, and maybe
 * pay, a second time for the same decision. The next decision (a new tick, a new key) is the way to try again.
 */
const RETRY = Object.freeze({ maxAttempts: 3, retryThrottled: false, retryFailed: false, retryUnknown: false, baseDelayMs: 500 });

/**
 * One record per decision key: a second infer() for the same key returns what was recorded (replayed) and reserves
 * nothing; a concurrent one shares the call in flight. In memory, one process (the first-run scope).
 */
export class DecisionRegistry {
  constructor() { this.done = new Map(); this.flying = new Map(); }
}

/**
 * The most one call can cost by the book, before it is made: the request as it will go on the wire, and its quote.
 * An upper bound on input tokens is the UTF-8 byte length of the body (no tokenizer yields more tokens than bytes).
 */
export function quoteFor({ adapter, book, request }) {
  const req = neutralRequest(request);
  const wire = adapter.build(req);
  const inputTokenCeiling = Buffer.byteLength(JSON.stringify(wire.body), 'utf8');
  return { req, wire, quote: book.quote(adapter.provider, req.model, { inputTokenCeiling, maxOutputTokens: req.maxOutputTokens }) };
}

/**
 * @param {object} o
 * @param {object} o.adapter     anthropicAdapter | openaiAdapter
 * @param {object} o.transport   {send(wire) → exchange}  (fixtureTransport in this build)
 * @param {object} o.book        TokenPriceBook
 * @param {object} o.costs       RunCostMock (④'s cost contract, mocked)
 * @param {object} o.request     neutralRequest fields
 * @param {object} [o.retry]     {maxAttempts, retryFailed, retryUnknown, baseDelayMs}
 * @param {Function} [o.sleep]
 */
export async function infer({ registry = null, ...o }) {
  const key = o.request?.requestKey;
  if (registry) {
    if (registry.done.has(key)) return { ...registry.done.get(key), replayed: true };
    if (registry.flying.has(key)) return registry.flying.get(key).then(r => ({ ...r, replayed: true }));
  }
  const p = inferOnce(o);
  if (!registry) return p;
  registry.flying.set(key, p);
  try { const r = await p; registry.done.set(key, r); return r; } finally { registry.flying.delete(key); }
}

async function inferOnce({ adapter, transport, book, costs, request, retry = {}, sleep = ms => new Promise(r => setTimeout(r, ms)) }) {
  const R = { ...RETRY, ...retry };
  const { req, wire, quote } = quoteFor({ adapter, book, request });
  const attempts = [];
  let last = null;
  for (let i = 0; i < R.maxAttempts; i++) {
    const key = `${req.requestKey}#${i}`;
    try { costs.reserve(key, quote); } catch (e) { attempts.push({ key, reserved: false, stop: e.code, detail: e.message }); break; }
    costs.calling(key);
    let x;
    // Each attempt is a call of its own: where the provider takes a client id, it gets this attempt's key.
    try { x = await transport.send({ ...wire, headers: { ...wire.headers, ...(wire.headers['X-Client-Request-Id'] ? { 'X-Client-Request-Id': key } : {}) } }); }
    catch (e) { x = { transportError: String(e?.message ?? e), sent: e?.sent !== false }; }
    const p = adapter.parse(x);
    const a = { key, quote, outcome: p.outcome, providerRequestId: p.providerRequestId, model: p.model ? { ...p.model, configured: req.model } : { provider: adapter.provider, configured: req.model, served: null, assurance: 'configured only' }, usage: p.usage };
    if (p.cost.measurable) {
      const measured = book.measure(adapter.provider, req.model, p.usage);
      if (measured === null) { costs.undecided(key, 'answer without a complete usage report'); a.cost = { quote, measured: null, unknown: true }; }
      else { const s = costs.settle(key, measured, p.outcome); a.cost = { quote, measured, settled: s.settled, unknown: false }; }
    } else if (p.cost.unknown) { costs.undecided(key, p.why ?? `${p.outcome} (HTTP ${x.status ?? 'none'}): billing not stated`); a.cost = { quote, measured: null, unknown: true }; }
    else { costs.release(key, p.outcome); a.cost = { quote, measured: '0', unknown: false, basis: 'not sent: the request never left this process' }; }
    attempts.push(a);
    last = p;
    const again = p.outcome === OUTCOME.NOT_SENT || (p.outcome === OUTCOME.THROTTLED && R.retryThrottled) || (p.outcome === OUTCOME.FAILED && R.retryFailed) || (p.outcome === OUTCOME.UNKNOWN && R.retryUnknown);
    if (!again) break;
    if (i + 1 < R.maxAttempts) await sleep(p.retryAfterMs ?? R.baseDelayMs * 2 ** i);
  }
  return {
    outcome: last?.outcome ?? 'not_called', text: last?.outcome === OUTCOME.OK || last?.outcome === OUTCOME.TRUNCATED ? last.text : null,
    attempts, quote, costs: costs.classes(),
    // Neither provider documents an idempotency key for inference: an attempt with an unknown result followed by another may be billed twice.
    ...(attempts.slice(0, -1).some(a => a.cost?.unknown) ? { possibleDoubleBilling: 'an attempt with an unknown result was followed by another: the provider may have billed both' } : {}),
  };
}
