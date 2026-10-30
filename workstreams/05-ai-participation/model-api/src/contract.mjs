// The provider contract for the away-mode agent (⑤): one shape for Claude
// (Anthropic Messages API) and GPT (OpenAI Responses API), so either can
// be configured without changing the budget, the guard or the game path.
//
// LOCAL DESIGN ONLY. Nothing here reads, creates or stores an API key, opens
// a network connection or calls a model. A live call would go through an
// injected transport (the official SDK of the chosen provider, an approval
// item); the tests drive the adapters with recorded-shape fixtures.
//
// Sources (read 2026-10-30, official docs only; no production model or price
// is chosen here):
//   Claude  https://platform.claude.com/docs/en/api/messages/create (Message.usage, stop_reason)
//           https://platform.claude.com/docs/en/api/errors (status codes, request-id header)
//           https://platform.claude.com/docs/en/about-claude/pricing (price components)
//   OpenAI  https://developers.openai.com/api/reference/resources/responses/methods/create (Response.usage, status)
//           https://developers.openai.com/api/docs/guides/error-codes (429 rate vs quota codes)
//           https://developers.openai.com/api/reference/overview (x-request-id, X-Client-Request-Id)
//           https://developers.openai.com/api/docs/pricing (price components, tiers)

export const PROVIDERS = Object.freeze({ ANTHROPIC: 'anthropic', OPENAI: 'openai', FIXTURE: 'fixture' });

/**
 * What became of one model call, as far as this process can know.
 *   ok          an answer to use
 *   truncated   an answer cut short (output limit, context window): billed, usable only if the guard accepts it
 *   refused     the model declined: billed per its usage, nothing to act on
 *   rejected    the provider refused the request before generating (bad request, auth, permission): no usage returned
 *   billing     the provider says the account cannot pay (credits, spend cap, quota): stop, never retry
 *   throttled   rate limited, retry later (the provider names when, or not)
 *   failed      a server error after the request arrived: whether it is billed is not stated by the provider
 *   unknown     the request may have reached the provider and no answer came (timeout, connection lost after sending)
 *   not_sent    the request provably did not leave (connection refused before sending, preflight stop)
 */
export const OUTCOME = Object.freeze({ OK: 'ok', TRUNCATED: 'truncated', REFUSED: 'refused', REJECTED: 'rejected', BILLING: 'billing', THROTTLED: 'throttled', FAILED: 'failed', UNKNOWN: 'unknown', NOT_SENT: 'not_sent' });

/**
 * The cost of one call, kept in separate fields (amounts in test-USDC base units, decimal strings):
 *   priceBook   which price book version was used (never a production one here)
 *   quote       the most this call can cost by the book, reserved BEFORE the call
 *   measured    computed by us from the provider's usage report × the book; null without a usage report
 *   unknown     true when the provider may have billed and no usage came back (the money stays reserved)
 *   invoiced    what the provider's invoice or usage/cost report says: NOT IMPLEMENTED (null); reconciliation is an approval item
 *   overrun     measured above the quote: the owner is charged the quote at most, the difference is the operator's record
 */
export function emptyCost(priceBook, quote) {
  return { priceBook, quote: String(quote), measured: null, unknown: false, invoiced: null, overrun: '0' };
}

/**
 * Usage, provider-neutral. Every field is a count of tokens or uses, or null when the provider did not report it.
 *   inputUncached   input tokens billed at the base input rate
 *   cacheRead       input tokens read from the provider's prompt cache
 *   cacheWrite      input tokens written to the cache, by TTL where the provider says ({'5m': n, '1h': n, unspecified: n})
 *   output          output tokens (the billed total)
 *   reasoning       of `output`, the tokens spent on reasoning (informational: already inside `output`)
 *   serverTools     provider-run tool uses ({web_search: n, …}); none are enabled by this design
 */
export function emptyUsage() {
  return { inputUncached: null, cacheRead: null, cacheWrite: {}, output: null, reasoning: null, serverTools: {} };
}

/** The model as configured and as the provider SAID it served it. A served name is a self-report, never verification. */
export function modelRecord(provider, configured, served) {
  return { provider, configured, served: served ?? null, assurance: served ? 'self-reported by the provider response (not verified)' : 'configured only' };
}

/**
 * A provider-neutral request. `messages` are {role: 'system'|'user', text}; the adapter maps them.
 * `requestKey` is ours (the journal's key for this call): sent where the provider accepts a client id
 * (OpenAI X-Client-Request-Id), kept locally otherwise. Neither provider documents an idempotency key
 * for inference, so a retry is a new, separately billed call.
 */
export function neutralRequest({ requestKey, model, messages, maxOutputTokens, jsonSchema = null }) {
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(String(requestKey))) throw new Error('requestKey: 8–128 of A–Z a–z 0–9 . _ : -');
  if (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 1) throw new Error('maxOutputTokens must be a positive integer');
  return { requestKey, model, messages: messages.map(m => ({ role: m.role, text: String(m.text) })), maxOutputTokens, jsonSchema };
}
