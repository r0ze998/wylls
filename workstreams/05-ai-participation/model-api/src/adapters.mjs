// Claude (Anthropic Messages API) and GPT (OpenAI Responses API) behind the
// one contract of contract.mjs. Each adapter is two pure functions:
//   build(neutralRequest)  → {path, headers, body}   no credential header: the transport adds it (approval item)
//   parse(exchange)        → {outcome, text, usage, model, providerRequestId, retryAfterMs, cost: {measurable, assumedZero, unknown}}
// `exchange` is {status, headers, body} from a transport, or {transportError, sent} when no HTTP answer came.
// Field names follow the official references named in contract.mjs; where a reference left something
// open, the code says so (VERIFY BEFORE LIVE).
import { OUTCOME, PROVIDERS, emptyUsage, modelRecord } from './contract.mjs';

const h = (headers, name) => { if (!headers) return null; const k = Object.keys(headers).find(x => x.toLowerCase() === name); return k ? headers[k] : null; };
const retryAfterMs = headers => { const v = h(headers, 'retry-after'); const s = Number(v); return v !== null && Number.isFinite(s) && s >= 0 ? s * 1000 : null; };
const n = v => (Number.isInteger(v) && v >= 0 ? v : null);

/** A transport failure: not sent at all (the request provably did not leave), or sent with no answer. */
function transportOutcome(x) {
  return x.sent === false
    ? { outcome: OUTCOME.NOT_SENT, cost: { measurable: false, assumedZero: true, unknown: false }, why: 'the request did not leave this process' }
    : { outcome: OUTCOME.UNKNOWN, cost: { measurable: false, assumedZero: false, unknown: true }, why: 'sent, no answer (timeout or connection lost): the provider may have run and billed it' };
}

// ------------------------------------------------------------------ Claude

export const anthropicAdapter = Object.freeze({
  provider: PROVIDERS.ANTHROPIC,
  requestIdHeader: 'request-id',
  build(req) {
    const system = req.messages.filter(m => m.role === 'system').map(m => ({ type: 'text', text: m.text }));
    const messages = req.messages.filter(m => m.role !== 'system').map(m => ({ role: 'user', content: m.text }));
    return {
      path: '/v1/messages',
      // The API version header is fixed by the chosen SDK in a live client; no credential header here.
      headers: { 'content-type': 'application/json' },
      body: { model: req.model, max_tokens: req.maxOutputTokens, ...(system.length ? { system } : {}), messages,
        ...(req.jsonSchema ? { output_config: { format: { type: 'json_schema', schema: req.jsonSchema } } } : {}) },
    };
  },
  parse(x) {
    if (x.transportError) return { ...transportOutcome(x), usage: emptyUsage(), model: null, providerRequestId: null, retryAfterMs: null };
    const rid = h(x.headers, 'request-id') ?? x.body?.request_id ?? null;
    const base = { providerRequestId: rid, retryAfterMs: retryAfterMs(x.headers) };
    if (x.status === 200 && x.body?.type === 'message') {
      const u = x.body.usage ?? {};
      const usage = emptyUsage();
      usage.inputUncached = n(u.input_tokens);
      usage.cacheRead = n(u.cache_read_input_tokens) ?? 0;
      // Total input = input_tokens + cache_creation_input_tokens + cache_read_input_tokens (Message.usage docs).
      if (u.cache_creation) usage.cacheWrite = { '5m': n(u.cache_creation.ephemeral_5m_input_tokens) ?? 0, '1h': n(u.cache_creation.ephemeral_1h_input_tokens) ?? 0 };
      else if (n(u.cache_creation_input_tokens)) usage.cacheWrite = { unspecified: u.cache_creation_input_tokens };
      usage.output = n(u.output_tokens);
      usage.reasoning = n(u.output_tokens_details?.thinking_tokens); // inside output_tokens (documented)
      usage.serverTools = { ...(u.server_tool_use ?? {}) };
      const text = (x.body.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('');
      const sr = x.body.stop_reason;
      const outcome = sr === 'refusal' ? OUTCOME.REFUSED : (sr === 'max_tokens' || sr === 'model_context_window_exceeded' || sr === 'pause_turn') ? OUTCOME.TRUNCATED : OUTCOME.OK;
      return { ...base, outcome, text, stopReason: sr, usage, model: modelRecord(PROVIDERS.ANTHROPIC, null, x.body.model), cost: { measurable: true, assumedZero: false, unknown: false } };
    }
    const type = x.body?.error?.type ?? null;
    const err = { ...base, usage: emptyUsage(), model: null, errorType: type, httpStatus: x.status };
    // A 429 is a rate limit when it names a retry time; a tier spend cap returns 429 WITHOUT retry-after and keeps failing (errors docs).
    if (x.status === 429) return base.retryAfterMs !== null ? { ...err, outcome: OUTCOME.THROTTLED, cost: { measurable: false, assumedZero: true, unknown: false } }
      : { ...err, outcome: OUTCOME.BILLING, why: '429 without retry-after: possibly the spend cap', cost: { measurable: false, assumedZero: true, unknown: false } };
    if (x.status === 402) return { ...err, outcome: OUTCOME.BILLING, cost: { measurable: false, assumedZero: true, unknown: false } };
    // 400 is also returned when a spend limit the owner set is reached (errors docs): not retryable either way.
    if (x.status >= 400 && x.status < 500) return { ...err, outcome: OUTCOME.REJECTED, cost: { measurable: false, assumedZero: true, unknown: false } };
    // 500 api_error, 504 timeout_error, 529 overloaded_error: retryable; whether such a request is billed is not stated.
    return { ...err, outcome: OUTCOME.FAILED, cost: { measurable: false, assumedZero: false, unknown: true } };
  },
});

// ------------------------------------------------------------------ GPT

/** 429 codes that mean "the account cannot pay": retrying never helps (error-codes guide). */
export const OPENAI_BILLING_CODES = Object.freeze(['credit_balance_exhausted', 'organization_spend_limit_exceeded', 'project_spend_limit_exceeded', 'organization_usage_limit_exceeded', 'insufficient_quota']);

export const openaiAdapter = Object.freeze({
  provider: PROVIDERS.OPENAI,
  requestIdHeader: 'x-request-id',
  build(req) {
    const instructions = req.messages.filter(m => m.role === 'system').map(m => m.text).join('\n\n');
    return {
      path: '/v1/responses',
      // X-Client-Request-Id: our key, logged by the provider; lets support say whether a timed-out request arrived (API overview).
      headers: { 'content-type': 'application/json', 'X-Client-Request-Id': req.requestKey },
      body: { model: req.model, ...(instructions ? { instructions } : {}), input: req.messages.filter(m => m.role !== 'system').map(m => ({ role: 'user', content: m.text })),
        max_output_tokens: req.maxOutputTokens,
        // VERIFY BEFORE LIVE: `store` and the `text.format` json_schema shape were not in the part of the reference read.
        store: false,
        ...(req.jsonSchema ? { text: { format: { type: 'json_schema', name: 'decision', schema: req.jsonSchema, strict: true } } } : {}) },
    };
  },
  parse(x) {
    if (x.transportError) return { ...transportOutcome(x), usage: emptyUsage(), model: null, providerRequestId: null, retryAfterMs: null };
    const base = { providerRequestId: h(x.headers, 'x-request-id'), retryAfterMs: retryAfterMs(x.headers) };
    if (x.status === 200 && x.body?.object === 'response') {
      const u = x.body.usage ?? null;
      const usage = emptyUsage();
      if (u) {
        const cached = n(u.input_tokens_details?.cached_tokens) ?? 0;
        const written = n(u.input_tokens_details?.cache_write_tokens) ?? 0;
        // ASSUMPTION (VERIFY BEFORE LIVE): cached_tokens and cache_write_tokens are parts of input_tokens, not additions to it.
        usage.inputUncached = n(u.input_tokens) === null ? null : Math.max(0, u.input_tokens - cached - written);
        usage.cacheRead = cached;
        if (written) usage.cacheWrite = { unspecified: written };
        usage.output = n(u.output_tokens);
        usage.reasoning = n(u.output_tokens_details?.reasoning_tokens); // ASSUMPTION: inside output_tokens
      }
      const items = (x.body.output ?? []).flatMap(o => o.content ?? []);
      const refused = items.some(c => c.type === 'refusal');
      const text = items.filter(c => c.type === 'output_text').map(c => c.text).join('');
      const st = x.body.status;
      const outcome = refused ? OUTCOME.REFUSED : st === 'completed' ? OUTCOME.OK : st === 'incomplete' ? OUTCOME.TRUNCATED : st === 'failed' ? OUTCOME.FAILED : OUTCOME.UNKNOWN;
      // A response with a usage report is measurable whatever its status; without one (queued, in progress, failed with no usage) it is not.
      return { ...base, outcome, text, status: st, usage, model: modelRecord(PROVIDERS.OPENAI, null, x.body.model), cost: u ? { measurable: true, assumedZero: false, unknown: false } : { measurable: false, assumedZero: false, unknown: true } };
    }
    const code = x.body?.error?.code ?? null;
    const err = { ...base, usage: emptyUsage(), model: null, errorType: x.body?.error?.type ?? null, errorCode: code, httpStatus: x.status };
    if (x.status === 429) return OPENAI_BILLING_CODES.includes(code) ? { ...err, outcome: OUTCOME.BILLING, cost: { measurable: false, assumedZero: true, unknown: false } }
      : { ...err, outcome: OUTCOME.THROTTLED, cost: { measurable: false, assumedZero: true, unknown: false } };
    if (x.status >= 400 && x.status < 500) return { ...err, outcome: OUTCOME.REJECTED, cost: { measurable: false, assumedZero: true, unknown: false } };
    return { ...err, outcome: OUTCOME.FAILED, cost: { measurable: false, assumedZero: false, unknown: true } };
  },
});

export const adapterFor = provider => ({ [PROVIDERS.ANTHROPIC]: anthropicAdapter, [PROVIDERS.OPENAI]: openaiAdapter })[provider] ?? null;

/**
 * A transport that answers from a script, for tests and the local demo. It is NOT a client: it never opens a
 * socket, and it refuses any request that carries a credential header (the adapters never add one).
 * script: array of exchanges ({status, headers, body} | {transportError, sent}) or a function (wire, n) => exchange.
 */
export function fixtureTransport(script) {
  const calls = [];
  return {
    calls,
    async send(wire) {
      for (const k of Object.keys(wire.headers ?? {})) if (/^(authorization|x-api-key|api-key|openai-organization|openai-project)$/i.test(k)) throw new Error(`fixture transport: a credential header (${k}) must never reach a fixture`);
      calls.push(structuredClone(wire));
      const i = calls.length - 1;
      const x = typeof script === 'function' ? await script(wire, i) : script[Math.min(i, script.length - 1)];
      if (x?.transportError) { const e = new Error(x.transportError); e.sent = x.sent; throw e; }
      return structuredClone(x);
    },
  };
}
