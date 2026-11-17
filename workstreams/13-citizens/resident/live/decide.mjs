// How the operator resident chooses among live candidates (candidates.mjs) without a paid model (2026-11-17).
//
//   noChargeDecider   a local rule, no model, no network, nothing billed:
//                     1. keep a promise: a choosable `send` for a request already accepted (earliest expiry first);
//                     2. else accept the earliest-expiring request whose need one own village's stock estimate covers
//                        (an unknown stock is never taken as enough);
//                     3. else wait.
//   decideLive        the boundary: the local rule unless a provider is injected. An injected provider must state
//                     `charges: false` (or be explicitly allowed by `allow.model`), answer one candidate id that is
//                     offered and not held, and is otherwise refused: the answer is then `wait` with why (fail-closed).

const expiry = c => (Number.isSafeInteger(c.expiresAt) ? c.expiresAt : Number.MAX_SAFE_INTEGER);

export function noChargeDecider({ candidates, obs }) {
  const byId = new Map((obs?.requests ?? []).map(q => [q.id, q]));
  const free = candidates.filter(c => !c.held).map(c => ({ ...c, expiresAt: byId.get(c.request)?.expiresAt ?? null }));
  const send = free.filter(c => c.kind === 'send').sort((a, b) => expiry(a) - expiry(b))[0];
  if (send) return { choice: send.id, by: 'no-charge-rule', why: 'keeps an accepted request (earliest expiry)' };
  const stocks = (obs?.self?.holdings ?? []).map(h => h.stock).filter(Boolean);
  const covered = c => stocks.some(s => Object.entries(c.offer ?? {}).every(([res, n]) => Number.isFinite(s[res]) && s[res] >= n));
  const accept = free.filter(c => c.kind === 'respond' && covered(c)).sort((a, b) => expiry(a) - expiry(b))[0];
  if (accept) return { choice: accept.id, by: 'no-charge-rule', why: 'an own village can cover the need (estimate)' };
  return { choice: 'wait', by: 'no-charge-rule', why: 'nothing choosable that the known stock covers' };
}

export function decideLive({ candidates, obs }, provider = null, { allow = {} } = {}) {
  if (!provider) return noChargeDecider({ candidates, obs });
  if (typeof provider.decide !== 'function') return { choice: 'wait', by: 'refused', why: 'the injected provider has no decide()' };
  if (provider.charges !== false && allow.model !== true) return { choice: 'wait', by: 'refused', why: 'a provider that may charge was not explicitly allowed (allow.model)' };
  let a;
  try { a = provider.decide({ candidates, obs }); } catch (e) { return { choice: 'wait', by: 'refused', why: `the provider failed: ${String(e?.message ?? e).slice(0, 60)}` }; }
  if (a?.choice === 'wait') return { choice: 'wait', by: provider.name ?? 'provider', why: a.why ?? '' };
  const c = candidates.find(x => x.id === a?.choice);
  if (!c) return { choice: 'wait', by: 'refused', why: 'the provider chose something that was not offered' };
  if (c.held) return { choice: 'wait', by: 'refused', why: `the provider chose a held candidate: ${c.held.join('; ')}` };
  return { choice: c.id, by: provider.name ?? 'provider', why: a.why ?? '' };
}
