// Settling undecided model calls from the provider's own record — on a FIXTURE of that record.
//
// An undecided call (sent, no usage came back) stays held until an outside answer. This matches each undecided
// attempt to a provider-side record by the ids both sides have:
//   - our attempt key, where the provider logged it as the client request id (OpenAI X-Client-Request-Id)
//   - the provider's request id, where the error answer carried one (request-id / x-request-id)
// A match with a usage report settles the call at its measured cost (never above its reservation); a match that says
// the provider did not bill releases it; no match leaves it undecided for the operator.
//
// NOT IMPLEMENTED for real: which provider report or API gives per-request usage, its shape, how soon, and who may read
// it are approval items (it would need an admin credential this code never reads). `entries` here are a fixture in the
// neutral usage shape of contract.mjs.
/** Providers that log a client-supplied request id (OpenAI X-Client-Request-Id). Claude documents none. */
const CLIENT_ID_PROVIDERS = new Set(['openai']);

export function reconcileUndecided({ costs, book, records, entries }) {
  const attempts = records.flatMap(r => r.attempts.map(a => ({ ...a, provider: r.provider, model: r.configuredModel })));
  const out = [];
  for (const it of costs.items.values()) {
    if (it.state !== 'undecided') continue;
    const a = attempts.find(x => x.key === it.key);
    const byClient = a && CLIENT_ID_PROVIDERS.has(a.provider) ? entries.find(x => x.clientRequestId === it.key) : null;
    const e = byClient ?? (a?.providerRequestId ? entries.find(x => x.providerRequestId === a.providerRequestId) : null);
    if (!e) { out.push({ key: it.key, result: 'undecided', why: a?.providerRequestId ? 'no provider record with this request id yet' : 'no id the provider record could be matched by (no client id, no request id): the operator decides' }); continue; }
    const matchedBy = e === byClient ? 'client request id' : 'provider request id';
    if (e.billed === false) { costs.decide(it.key, { by: 'operator', outcome: 'refund', note: `provider record (${matchedBy}): not billed` }); out.push({ key: it.key, result: 'released', matchedBy }); continue; }
    const measured = a ? book.measure(a.provider, a.model, e.usage) : null;
    if (measured === null) { out.push({ key: it.key, result: 'undecided', why: 'the provider record has no complete usage' }); continue; }
    const s = costs.decide(it.key, { by: 'provider-report', amount: measured, note: `${matchedBy} ${e.clientRequestId ?? e.providerRequestId}` });
    out.push({ key: it.key, result: 'settled', matchedBy, measured, settled: s.settled });
  }
  return out;
}
