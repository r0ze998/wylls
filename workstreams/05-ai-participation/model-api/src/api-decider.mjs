// The away-mode decider over a provider API (Claude or GPT, by configuration), with its own model budget.
// It has the shape participate() takes from a decider ({name, free, plan}), and it adds what the hosted call needs:
//
//   1. preflight, for free, before anything is reserved: the agent is running, the key is delegated, a command is
//      allowed, a request is open, the call cap and the budget leave room (inference.mjs preflight)
//   2. one decision key per decision (the run and what was asked): a re-run of the same tick replays the recorded
//      result instead of calling and reserving again (DecisionRegistry)
//   3. the call: reserve the quote → send → settle the measured cost, or hold it undecided (inference.mjs infer)
//   4. the answer is checked strictly against the schema the model was given; anything else is dropped whole.
//      What passes is still only a proposal: the guard (../../src/guard.mjs) and the relay decide.
//
// It records the inference apart from the game: "the model call failed" and "the model answered, the game refused"
// are different records (plan.inference here; the relay's code on each item in participate's report).
// It never sends a game operation itself and never touches the session key.
import { createHash } from 'node:crypto';
import { OUTCOME } from './contract.mjs';
import { infer, preflight, quoteFor } from './inference.mjs';
import { answerSchema, promptFor } from '../../src/deciders.mjs';
import { sanitize } from '../../src/deps.mjs';

/**
 * Commands the autopilot never proposes, even where the relay would take them as an agent action:
 * SendCaravan (③'s patch 0005 makes it one) — its arrival can be unverifiable (④ DeliveredUnverified: not 0, not a
 * loss, not known) and ⑤ has no way yet to show or count that; until ④'s arrival states are connected it stays the
 * owner's own operation (③'s MCP), never the autopilot's.
 */
export const NOT_FOR_AUTOPILOT = Object.freeze(['SendCaravan']);

/** Codes that stop the autopilot until the owner acts (budget, cap, the provider's own billing stop). */
export const API_BUDGET_STOPS = Object.freeze(new Set(['BudgetShort', 'CallCapReached', 'PerCallLimit', 'CategoryDayLimit', 'CategoryTotalLimit', 'InsufficientBalance', 'ProviderBilling']));

/**
 * The answer exactly as the schema says, or nothing. Returns {ok, answer, errors}.
 * Stricter than the schema where it matters: whole non-negative integers, no repeated request+action.
 */
export function validateAnswer(text, { names, requestIds }) {
  const errors = [];
  let a;
  try { a = JSON.parse(text); } catch { return { ok: false, answer: null, errors: ['not JSON'] }; }
  const keysAre = (o, ks) => o && typeof o === 'object' && !Array.isArray(o) && Object.keys(o).length === ks.length && ks.every(k => Object.hasOwn(o, k));
  if (!keysAre(a, ['proposals', 'skipped'])) return { ok: false, answer: null, errors: ['top level must be exactly {proposals, skipped}'] };
  if (!Array.isArray(a.proposals) || a.proposals.length > 8) errors.push('proposals: an array of at most 8');
  if (!Array.isArray(a.skipped) || a.skipped.length > 8) errors.push('skipped: an array of at most 8');
  if (errors.length) return { ok: false, answer: null, errors };
  const seen = new Set();
  a.proposals.forEach((p, i) => {
    if (!keysAre(p, ['request', 'action', 'fields', 'reason'])) return errors.push(`proposals[${i}]: exactly {request, action, fields, reason}`);
    if (!requestIds.includes(p.request)) errors.push(`proposals[${i}].request: not an open request`);
    if (!names.includes(p.action)) errors.push(`proposals[${i}].action: not a delegated command`);
    if (!p.fields || typeof p.fields !== 'object' || Array.isArray(p.fields) || !Object.values(p.fields).every(v => Number.isSafeInteger(v) && v >= 0)) errors.push(`proposals[${i}].fields: whole non-negative numbers only`);
    if (typeof p.reason !== 'string' || p.reason.length > 200) errors.push(`proposals[${i}].reason: a string of at most 200`);
    const k = `${p.request}|${p.action}`;
    if (seen.has(k)) errors.push(`proposals[${i}]: the same request and command twice`);
    seen.add(k);
  });
  a.skipped.forEach((x, i) => { if (!keysAre(x, ['request', 'why']) || typeof x.request !== 'string' || typeof x.why !== 'string' || x.why.length > 200) errors.push(`skipped[${i}]: exactly {request, why}`); });
  return errors.length ? { ok: false, answer: null, errors } : { ok: true, answer: a, errors: [] };
}

const autopilotGrant = grant => ({ ...grant, allowed: grant.allowed.filter(n => !NOT_FOR_AUTOPILOT.includes(n)) });

/** One key per decision: the same run asking the same thing gets the same key (and so the recorded result). */
export const decisionKeyOf = ({ agentId, policyVersion, modeEpoch, runId, messages }) =>
  `d05-${createHash('sha256').update(JSON.stringify([agentId, policyVersion, modeEpoch, runId, messages])).digest('hex').slice(0, 40)}`;

/**
 * @param {object} o
 * @param {object} o.adapter     anthropicAdapter | openaiAdapter (the configured provider)
 * @param {string} o.model       the configured model id (no production model is chosen: fixture ids in this build)
 * @param {object} o.transport   {send(wire)}: loopbackTransport to the HTTP fixture, or fixtureTransport (a live client is an approval item)
 * @param {object} o.book        TokenPriceBook (FIXTURE / TEST / PROPOSED only)
 * @param {object} o.costs       RunCostMock: ④'s cost contract, mocked
 * @param {object} o.registry    DecisionRegistry
 * @param {Function} o.runId     () → the current run id (the autopilot's tick)
 * @param {object} [o.retry]     inference.mjs retry options (default: only not_sent is retried)
 * @param {string} [o.gameReserve]  money to keep apart for the game action, checked before the call
 * @param {object} [o.citizen]   CitizenBoundary: the owner's reserves of the shared quota and day budget, checked before the call
 */
export function apiDecider({ adapter, model, transport, book, costs, registry, runId, maxOutputTokens = 400, retry = {}, gameReserve = '0', sleep, boundary = 'fixture', citizen = null }) {
  const d = {
    name: `api:${adapter.provider}:${model}`, free: true, // free to participate(): this decider reserves and settles its own model cost
    records: [],
    needsCall(obs, grant, contract, ctx = {}) { const p = promptFor(obs, autopilotGrant(grant), contract, ctx); return p.names.length > 0 && p.requestIds.length > 0; },
    async plan(obs, grant, contract, ctx = {}) {
      const p = promptFor(obs, autopilotGrant(grant), contract, ctx);
      const messages = p.messages.map(m => ({ role: m.role, text: m.content }));
      const requestKey = decisionKeyOf({ agentId: obs.view.agentId, policyVersion: obs.view.policy?.version, modeEpoch: obs.view.modeEpoch, runId: runId(), messages });
      const request = { requestKey, model, messages, maxOutputTokens, jsonSchema: answerSchema(p.names, p.requestIds) };
      const rec = { requestKey, boundary, provider: adapter.provider, configuredModel: model, servedModel: null, called: false, preflight: [], status: null, outcome: null, attempts: [], quote: null, answer: null, errors: [] };
      const done = (status, extra = {}) => { Object.assign(rec, { status, costs: costs.classes() }, extra); d.records.push(rec); return rec; };

      // 1. Preflight (nothing reserved, nothing sent). A replay of a decision already made skips it: its cost is already recorded.
      if (!registry?.done.has(requestKey)) {
        const { quote } = quoteFor({ adapter, book, request });
        rec.quote = quote;
        // Model calls made today by this process: one per decision (its first attempt), as the owner's cap counts them.
        const today = new Date(costs.now()).toISOString().slice(0, 10);
        const callsToday = [...costs.items.values()].filter(i => i.day === today && String(i.key).endsWith('#0') && i.state !== 'released').length;
        const pf = preflight({ view: obs.view, grant, openRequests: p.names.length ? p.requestIds.length : 0, quote, gameReserve, available: costs.classes().available, callsToday });
        // The caps (per call, per day, total) are checked here too, so that a call the reservation would refuse is not even prepared.
        const cap = pf.call ? costs.check(quote) : null;
        if (cap) pf.reasons.push({ code: cap.code, detail: cap.message });
        pf.call = pf.call && !cap;
        // The same Citizen's owner keeps a reserve of the shared quota and day budget: no call that could only eat into it.
        const own = pf.call && citizen ? citizen.beforeDecide(obs.view, { nextGamePrice: gameReserve }) : null;
        if (own && !own.ok) { pf.reasons.push(...own.reasons); pf.call = false; }
        rec.preflight = pf.reasons;
        if (!pf.call) {
          const stop = pf.reasons.find(r => API_BUDGET_STOPS.has(r.code))?.code ?? null;
          done(stop ? 'stopped-by-budget' : 'not-called');
          return { proposals: [], notes: pf.reasons.map(r => ({ code: r.code, reason: `モデルを呼ばない（予約も請求もなし）: ${r.detail}` })), ...(stop ? { stop } : {}), inference: rec };
        }
      }

      // 2–3. The call (or the recorded result of the same decision).
      const r = await infer({ adapter, transport, book, costs, registry, retry, sleep, request });
      Object.assign(rec, { called: !r.replayed && r.attempts.some(a => a.outcome && a.outcome !== OUTCOME.NOT_SENT), replayed: !!r.replayed, outcome: r.outcome, quote: r.quote, possibleDoubleBilling: r.possibleDoubleBilling ?? null,
        attempts: r.attempts.map(a => ({ key: a.key, outcome: a.outcome ?? null, stop: a.stop ?? null, providerRequestId: a.providerRequestId ?? null, cost: a.cost ?? null })),
        servedModel: r.attempts.findLast(a => a.model?.served)?.model.served ?? null });
      const reserveStop = r.attempts.find(a => a.stop)?.stop ?? null;
      if (reserveStop) { done('stopped-by-budget'); return { proposals: [], notes: [{ code: reserveStop, reason: 'モデルの予算が予約を断った。呼ばない' }], stop: reserveStop, inference: rec }; }
      if (r.outcome === OUTCOME.BILLING) { done('stopped-by-budget'); return { proposals: [], notes: [{ code: 'ProviderBilling', reason: '提供者が支払いできないと答えた。再試行しない' }], stop: 'ProviderBilling', inference: rec }; }
      if (r.outcome === OUTCOME.REFUSED) { done('refused-by-model'); return { proposals: [], notes: [{ code: 'ModelRefused', reason: 'モデルが答えを断った。何も送らない' }], inference: rec }; }
      if (r.outcome !== OUTCOME.OK) {
        // Truncated answers are dropped too: a cut-off JSON is not the owner's decision.
        done('inference-failed');
        return { proposals: [], notes: [{ code: 'InferenceFailed', reason: `推論が使える答えを返さなかった（${r.outcome}）。この回は何も送らない${r.outcome === OUTCOME.UNKNOWN || r.outcome === OUTCOME.FAILED || r.outcome === OUTCOME.THROTTLED ? '。費用は確認待ちとして予約に残る' : ''}` }], inference: rec };
      }

      // 4. Strict answer check, then only proposals.
      const v = validateAnswer(r.text, { names: p.names, requestIds: p.requestIds });
      if (!v.ok) { done('answer-invalid', { errors: v.errors }); return { proposals: [], notes: [{ code: 'AnswerInvalid', reason: `答えが形式に合わない（${v.errors.slice(0, 3).join('; ')}）。全部捨てる` }], inference: rec }; }
      done('ok', { answer: 'valid' });
      return {
        proposals: v.answer.proposals.map(x => ({ requestId: x.request, command: { name: x.action, fields: x.fields }, by: d.name, reason: sanitize(x.reason, { limit: 200 }) })),
        notes: v.answer.skipped.map(x => ({ requestId: x.request, code: 'ModelSkipped', reason: sanitize(x.why, { limit: 200 }) })),
        inference: rec, servedModel: rec.servedModel,
      };
    },
  };
  return d;
}
