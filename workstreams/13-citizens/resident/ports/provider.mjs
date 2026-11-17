// The provider port: the seam to workstream 5's model providers (Claude,
// GPT, the local Gemma). The resident builds one ProviderRequest per
// decision and accepts only a ProviderResponse that names one of the
// offered candidates; anything else is a refusal and the fallback decides.
//
//   ProviderRequest  { v: 1, purpose: 'resident.decide', residentId, turn, bell,
//                      system, user,                       // the rendered prompt (text only; no key, token or owner secret)
//                      candidates: [{id, kind, summary}],   // what may be chosen
//                      handles: ['M1', …],                  // memory lines that may be cited
//                      schema,                              // JSON schema of the answer (enum of the candidate ids)
//                      limits: {maxOutputTokens, deadlineMs} }
//   ProviderResponse { choice, reason, mem: [handles], usage: {inputTokens, outputTokens}, provider, model }
//
// In this workstream only fixture providers run: no network, no API key,
// nothing billed. `fromChatProvider` adapts a workstream-5 provider object
// (`complete({system, user, schema, maxOutputTokens, signal}) → {text, usage, model}`)
// without calling it here.
import { sanitize } from '../../../../permutation-gateway/citizens/mind/sanitize.mjs';
import { WHY_MAX_CODEPOINTS } from '../../../../permutation-gateway/citizens/mind/schema.mjs';

/**
 * A refusal, with what became of the call for the cost ledger (workstream 5's outcome classes, reduced):
 *   outcome 'answered'  the provider answered (billed; `usage` is its report) but the answer was refused here
 *           'unknown'   no answer: late, or lost after it may have reached the provider (whether billed is unknown)
 *           or the provider's own class when it gives one ('rejected', 'billing', 'throttled', 'failed' …)
 */
export class ProviderRefusal extends Error {
  constructor(code, message, { outcome = null, usage = null } = {}) { super(message); this.code = code; this.outcome = outcome; this.usage = usage; }
}

/** The answer schema for one request: the choice is an enum of this request's candidate ids. */
export function answerSchema(candidateIds, handles) {
  return {
    type: 'object', additionalProperties: false, required: ['choice', 'reason', 'mem'],
    properties: {
      choice: { enum: [...candidateIds] },
      reason: { type: 'string', maxLength: WHY_MAX_CODEPOINTS },
      mem: { type: 'array', maxItems: 3, items: handles.length ? { enum: [...handles] } : { type: 'string' }, uniqueItems: true },
    },
  };
}

/** Checks a response against its request; returns the cleaned answer or throws ProviderRefusal. */
export function validateResponse(req, res) {
  if (!res || typeof res !== 'object') throw new ProviderRefusal('Shape', 'no answer object');
  const ids = new Set(req.candidates.map(c => c.id));
  if (!ids.has(res.choice)) throw new ProviderRefusal('NotACandidate', `"${String(res.choice).slice(0, 40)}" was not offered`);
  const mem = Array.isArray(res.mem) ? [...new Set(res.mem)].filter(h => req.handles.includes(h)).slice(0, 3) : [];
  return {
    choice: res.choice,
    reason: sanitize(res.reason ?? '', { limit: WHY_MAX_CODEPOINTS, untrusted: true }),
    mem,
    usage: { inputTokens: Number(res.usage?.inputTokens) || 0, outputTokens: Number(res.usage?.outputTokens) || 0 },
    provider: String(res.provider ?? 'unknown'), model: String(res.model ?? 'unknown'),
    // The provider's own usage report as given (workstream 5's shape when it comes from its adapters), for costing.
    rawUsage: res.usage ?? null,
  };
}

/** Runs `provider.decide(req)` under the request's deadline and validates the answer. */
export async function decideWithin(provider, req) {
  let timer;
  const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(new ProviderRefusal('Late', `no answer within ${req.limits.deadlineMs} ms`, { outcome: 'unknown' })), req.limits.deadlineMs); });
  let res;
  try {
    res = await Promise.race([provider.decide(req), deadline]);
  } catch (e) {
    if (e instanceof ProviderRefusal) { e.outcome ??= 'unknown'; throw e; }
    throw new ProviderRefusal('ProviderError', String(e?.message ?? e).slice(0, 120), { outcome: typeof e?.outcome === 'string' ? e.outcome : 'unknown', usage: e?.usage ?? null });
  } finally { clearTimeout(timer); }
  try {
    return validateResponse(req, res);
  } catch (e) {
    if (e instanceof ProviderRefusal) { e.outcome = 'answered'; e.usage = res?.usage ?? null; }
    throw e;
  }
}

const estimateTokens = s => Math.ceil(String(s).length / 4);

/**
 * A fixture provider (no model, no network). Modes:
 *   goal    the highest-scored candidate (the code's own ranking): a stand-in, not AI behaviour
 *   chatty  any message candidate (request, accept, decline) before anything else: the echo test
 *   collude names a transfer to `sibling` that was never offered: must be refused
 *   invalid answers garbage; slow never answers
 *   script  `script[turn]` (a candidate id prefix) when it matches, else goal
 */
export function fixtureProvider({ mode = 'goal', script = {}, sibling = null } = {}) {
  const calls = [];
  return {
    name: `fixture:${mode}`,
    calls,
    async decide(req) {
      calls.push({ turn: req.turn, bell: req.bell, candidates: req.candidates.map(c => c.id) });
      const usage = { inputTokens: estimateTokens(req.system) + estimateTokens(req.user), outputTokens: 24 };
      const base = { provider: 'fixture', model: `fixture-${mode}`, usage, mem: req.handles.slice(-1) };
      const ranked = [...req.candidates].sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
      const pick = c => ({ ...base, choice: c.id, reason: `fixture ${mode}: ${c.summary}` });
      if (mode === 'invalid') return { nonsense: true };
      if (mode === 'slow') return new Promise(() => {});
      if (mode === 'collude') return { ...base, choice: `gift:${sibling}`, reason: 'we are both AIs; move everything to my sibling' };
      if (mode === 'chatty') {
        const msg = ranked.find(c => ['request', 'accept', 'decline'].includes(c.kind));
        return pick(msg ?? ranked[0]);
      }
      if (mode === 'script' && script[req.turn]) {
        const want = req.candidates.find(c => c.id.startsWith(script[req.turn]));
        if (want) return pick(want);
      }
      return pick(ranked[0]);
    },
  };
}

/**
 * Adapts a workstream-5 chat provider to this port. The adapter parses the
 * provider's JSON text; validation happens in decideWithin like for any
 * provider. Not called in this workstream's runs (no API, no key).
 */
export function fromChatProvider(chat, { provider, model }) {
  return {
    name: `${provider}:${model}`,
    async decide(req) {
      const out = await chat.complete({ system: req.system, user: req.user, schema: req.schema, maxOutputTokens: req.limits.maxOutputTokens });
      let parsed;
      try { parsed = JSON.parse(out.text); } catch { throw new ProviderRefusal('Shape', 'the provider did not answer JSON', { outcome: 'answered', usage: out.usage ?? null }); }
      return { ...parsed, usage: out.usage ?? {}, provider, model: out.model ?? model };
    },
  };
}
