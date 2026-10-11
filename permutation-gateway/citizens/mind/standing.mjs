// Standing orders (contract section 3.6): code-held in the ledger (`standing`, section 5.1), returned
// in every /v1/decide answer, cached by the brain and used unchanged if the mind is unreachable,
// expiring by bell.
//   reserved       [{host_id, until_bell}]  hosts the model chose to keep home (a hold-kind or recall choice)
//   declined_calls [period]                 a session in which the Call candidate was offered and not chosen
//                                           (and choose is not ["autopilot"]) declines that period's Call
// (v1.1's `avoid` order is deferred and does not exist.)
import { kindBase } from './schema.mjs';

export const RESERVE_BELLS = 12;

export function emptyStanding() {
  return { reserved: [], declined_calls: [] };
}

/** The live part of a ledger's standing at `bell`: expired reservations are removed. Pure. */
export function liveStanding(standing, bell) {
  const s = standing ?? emptyStanding();
  const reserved = (s.reserved ?? [])
    .filter((r) => r.host_id != null && r.until_bell > bell)
    .map((r) => ({ host_id: String(r.host_id), until_bell: r.until_bell }))
    .sort((a, b) => (BigInt(a.host_id) < BigInt(b.host_id) ? -1 : BigInt(a.host_id) > BigInt(b.host_id) ? 1 : 0));
  const declined = [...new Set(s.declined_calls ?? [])].filter(Number.isInteger).sort((a, b) => a - b);
  return { reserved, declined_calls: declined };
}

/** Host ids a hold or recall candidate keeps home. hold lists handles (facts.keeps_home), recall has facts.host_id; ids are decimal strings. */
const hostIdsOf = (c, hosts = []) => {
  const f = c.facts ?? {};
  const out = [];
  const byHandle = new Map(hosts.map((h) => [h.handle, String(h.host_id)]));
  for (const h of f.keeps_home ?? []) if (byHandle.has(h)) out.push(byHandle.get(h));
  if (f.host_id != null) out.push(String(f.host_id));
  if (c.host_id != null) out.push(String(c.host_id));
  return [...new Set(out)];
};
export { hostIdsOf };

/**
 * Update the ledger's standing after a model decision. `candidates` is the offered list, `chosenIds`
 * the surviving choice ids (after V2/V3). Mutates and returns ledger standing. Only called for
 * decisions whose mode is "model" (an autopilot fallback never declines or reserves).
 */
export function updateStanding(standing, { bell, candidates, chosenIds, hosts = [], callPeriod = null, reserveBells = RESERVE_BELLS }) {
  const s = standing ?? emptyStanding();
  s.reserved ??= [];
  s.declined_calls ??= [];
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const chosen = chosenIds.map((id) => byId.get(id)).filter(Boolean);
  for (const c of chosen) {
    if (kindBase(c.kind) === 'hold' || kindBase(c.kind) === 'recall') {
      for (const host_id of hostIdsOf(c, hosts)) {
        const until = bell + reserveBells;
        const prev = s.reserved.find((r) => r.host_id === host_id);
        if (prev) prev.until_bell = Math.max(prev.until_bell, until);
        else s.reserved.push({ host_id, until_bell: until });
      }
    }
  }
  const onlyAutopilot = chosenIds.length === 1 && kindBase(byId.get(chosenIds[0])?.kind) === 'autopilot';
  if (!onlyAutopilot) {
    for (const c of candidates) {
      const isCall = kindBase(c.kind) === 'march' && c.flags?.council;
      if (!isCall || chosenIds.includes(c.id)) continue;
      const period = c.facts?.period ?? c.facts?.call_period ?? c.period ?? callPeriod;
      if (Number.isInteger(period) && !s.declined_calls.includes(period)) s.declined_calls.push(period);
    }
  }
  s.reserved = s.reserved.filter((r) => r.until_bell > bell);
  return s;
}

/** Which period's Call was offered and declined in this decision (for the chronicle `call_declined` line). */
export function declinedPeriods(candidates, chosenIds, callPeriod = null) {
  const onlyAutopilot = chosenIds.length === 1 && kindBase(candidates.find((c) => c.id === chosenIds[0])?.kind) === 'autopilot';
  if (onlyAutopilot) return [];
  return candidates
    .filter((c) => kindBase(c.kind) === 'march' && c.flags?.council && !chosenIds.includes(c.id))
    .map((c) => c.facts?.period ?? c.facts?.call_period ?? c.period ?? callPeriod)
    .filter(Number.isInteger);
}
