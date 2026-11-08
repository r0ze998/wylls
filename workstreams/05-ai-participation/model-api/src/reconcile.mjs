// Settling undecided model calls from the provider's own record — a FIXTURE CONTRACT, not verified in production.
//
// An undecided call (sent, no usage came back) stays held until an outside answer. This matches each undecided
// attempt to a record by the ids both sides have:
//   - our attempt key as the client request id. We can SEND it (OpenAI X-Client-Request-Id; the docs say it is logged
//     so that support can find a request). That a usage or billing report can be QUERIED by it, per request, with
//     its usage, is NOT verified: the fixture assumes it, production may not offer it.
//   - the provider's request id, where an answer carried one (request-id / x-request-id). Same caveat.
// A match with usage settles at the measured cost (never above the reservation); a match that says "not billed"
// releases it; no match leaves it undecided, held and not withdrawable. Nothing here, and nothing the operator can do
// in run-cost.mjs, turns an unmatched cost into 0 or a refund.
//
// Only `report.source === 'fixture'` is accepted. A production source (which report, its shape and delay, the admin
// credential to read it) is an approval item; this code reads no credential.

/** Providers whose client request id the FIXTURE contract lets us match by. Claude documents no client id at all. */
const FIXTURE_CLIENT_ID_PROVIDERS = new Set(['openai']);

export function reconcileUndecided({ costs, book, records, report }) {
  if (report?.source !== 'fixture') throw Object.assign(new Error('only a fixture provider record is accepted: no production usage report contract exists (an approval item)'), { code: 'UnverifiedReportSource' });
  const entries = report.entries ?? [];
  const attempts = records.flatMap(r => r.attempts.map(a => ({ ...a, provider: r.provider, model: r.configuredModel })));
  const out = [];
  for (const it of costs.items.values()) {
    if (it.state !== 'undecided') continue;
    const a = attempts.find(x => x.key === it.key);
    const byClient = a && FIXTURE_CLIENT_ID_PROVIDERS.has(a.provider) ? entries.find(x => x.clientRequestId === it.key) : null;
    const e = byClient ?? (a?.providerRequestId ? entries.find(x => x.providerRequestId === a.providerRequestId) : null);
    const base = { key: it.key, contract: 'fixture', productionVerified: false };
    if (!e) { out.push({ ...base, result: 'undecided', why: a?.providerRequestId ? 'no provider record with this request id' : 'no id the record could be matched by (no client id, no request id): stays undecided, held, not withdrawable' }); continue; }
    const matchedBy = e === byClient ? 'client request id (fixture contract)' : 'provider request id (fixture contract)';
    const evidence = { source: 'fixture', ref: `${matchedBy}: ${e.clientRequestId ?? e.providerRequestId}` };
    if (e.billed === false) { costs.decide(it.key, { by: 'operator', outcome: 'refund', note: 'the provider record says not billed', evidence }); out.push({ ...base, result: 'released', matchedBy }); continue; }
    const measured = a ? book.measure(a.provider, a.model, e.usage) : null;
    if (measured === null) { out.push({ ...base, result: 'undecided', why: 'the record has no complete usage' }); continue; }
    const s = costs.decide(it.key, { by: 'provider-report', amount: measured, note: matchedBy, evidence });
    out.push({ ...base, result: 'settled', matchedBy, measured, settled: s.settled });
  }
  return out;
}
