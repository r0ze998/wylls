// What the operator resident may choose in the REAL world, from a live observation (observe.mjs) (2026-11-17).
// Only what an existing contract already means:
//   respond   workstream 1's `respond` record (record.mjs): accept a request, offering at most the request's need
//             (the board page offers the need: coop-ui.mjs 'accept'). A record the board verifies; it moves nothing.
//   send      workstream 1's send of an accepted request: a S1 SendCaravan planned by workstream 1's planSend
//             (send.mjs: the game's fastestPath and CARAVAN_FEE, the source village's owner, the destination and the
//             cargo checked from the chain), after the board's rule for an earlier send of this request
//             (pending.mjs pendingSendOf: an unknown or landed-but-unlinked send stops a new one).
//   wait      nothing now.
// No test-world rule (world/rules.mjs), no 1-D distance, no mock fee. Nothing here signs, posts, submits or joins:
// a candidate names the authority it would need (`needs`), and step.mjs never uses one that was not supplied.
//
// Not supported (said, never replaced by something else):
export const UNSUPPORTED = Object.freeze({
  'payment-offer': "a payment or return offered with a request: workstream 1's request has no such field",
  'open-if-declined': "reopening a declined request to everyone: workstream 1's board has no such rule",
  'citizen-addressed-request': "a request addressed to one citizen: workstream 1's request names a destination village, not a recipient",
  'post-request': "the resident's own needs as a new request: no model of the resident's needs is mapped to workstream 1's goal and need",
  join: 'joining the world: the operator-invite route is not adopted for residents (README: it conflicts with the design)',
  build: "building and training: no mapping from the resident's choices to the S1 build and train actions",
  gift: 'gifts and returns between residents: no counterpart in workstream 1',
  'other-villages': "other villages' stock and owners: not read (no world-wide list); only the board's verified destinations are known",
  events: "the test world's event kinds (delivered, raided, …): not mapped from the herald's program records here",
});

/** The resident's response to a request, as the board folds it (record.mjs): null when none. */
const responseOf = (q, me) => (me && q.responses ? q.responses[me] ?? null : null);

/**
 * → {candidates: [{id, kind, request, needs, offer?|source?, held?}], unsupported: UNSUPPORTED, why: [...]}
 *   needs   the authorities the act would need: 'board-sign' (sign a record with the resident's identity and post it),
 *           'send-sign' (sign the caravan transaction with the resident's wallet and submit it)
 *   held    present when the candidate cannot be chosen now, with why (a missing input is never guessed)
 * `deps.pendingSendOf(q, wallet, outcomeOf)`: workstream 1's pending.mjs rule. Without it, no send is offered.
 */
export function liveCandidates(obs, { wallet, deps = {} } = {}) {
  const why = [], candidates = [];
  if (!obs || obs.kind !== 'live-partial') return { candidates, unsupported: UNSUPPORTED, why: ['not a live observation'] };
  if (!obs.world) why.push('no world: nothing is offered');
  if (obs.self?.status !== 'ok') why.push(`own villages: ${obs.self?.status ?? 'unread'} (${obs.self?.why ?? ''})`);
  if (!obs.world || obs.self?.status !== 'ok') return { candidates, unsupported: UNSUPPORTED, why };
  const mine = new Set(obs.self.holdings.map(h => `${h.place.p},${h.place.q},${h.place.site},${h.place.gen}`));
  for (const q of obs.requests) {
    if (q.requester === wallet) continue;   // the board refuses answering one's own request; sending to one's own village is the game's
    if (mine.has(`${q.to.p},${q.to.q},${q.to.site},${q.to.gen}`)) continue;
    // (2026-11-17) responses not read: whether the resident already answered is unknown, so nothing is offered for
    // this request but a held entry that says why (an unread field is never taken as "no answer")
    if (q.responses === null) {
      candidates.push(Object.freeze({ id: `respond:${q.id}`, kind: 'respond', request: q.id, offer: Object.freeze({ ...q.need }), needs: Object.freeze(['board-sign']), held: Object.freeze(["the board's responses for this request were not read"]) }));
      continue;
    }
    const r = responseOf(q, wallet);
    const accepted = r && r.answer === 'accept' && !r.withdrawn;
    if (!r) {
      candidates.push(Object.freeze({ id: `respond:${q.id}`, kind: 'respond', request: q.id, offer: Object.freeze({ ...q.need }), needs: Object.freeze(['board-sign']) }));
      continue;
    }
    if (!accepted) continue;   // declined or withdrawn: nothing more for this request
    const held = [];
    // (2026-11-17) the earlier sends and links must be read as the board has them: unread is never "none sent"
    if (q.sendings === null || q.links === null) held.push(`the board's ${[q.sendings === null ? 'sendings' : null, q.links === null ? 'links' : null].filter(Boolean).join(' and ')} for this request were not read: an earlier send cannot be ruled out`);
    else if (typeof deps.pendingSendOf !== 'function') held.push("workstream 1's rule for an earlier send (pending.mjs) not supplied");
    else {
      const p = deps.pendingSendOf(q, wallet, z => z.outcome);
      if (p) held.push(`an earlier send stops a new one (${p.kind}): ${p.why}`);
    }
    const offer = r.offer && typeof r.offer === 'object' ? r.offer : null;
    if (!offer) held.push('the accepted offer is not readable');
    // a source village: one of the resident's own, with a stock estimate that covers the offer (else held, never guessed)
    const sources = obs.self.holdings.filter(h => h.stock && offer && Object.entries(offer).every(([res, n]) => Number.isFinite(h.stock[res]) && h.stock[res] >= n));
    if (offer && !obs.self.holdings.some(h => h.stock)) held.push('the stock of the own villages is unknown (no herald time or no stock reader)');
    else if (offer && !sources.length) held.push('no own village holds the offer (estimate; the program decides at sending)');
    candidates.push(Object.freeze({ id: `send:${q.id}`, kind: 'send', request: q.id, offer: offer ? Object.freeze({ ...offer }) : null,
      source: sources[0] ? Object.freeze({ ...sources[0].place }) : null, needs: Object.freeze(['send-sign', 'board-sign']), ...(held.length ? { held: Object.freeze(held) } : {}) }));
  }
  return { candidates: Object.freeze(candidates), unsupported: UNSUPPORTED, why: Object.freeze(why) };
}

/**
 * The plan of a chosen `send` candidate, by workstream 1's planSend (supplied: `deps.planSend`, `deps.reader`,
 * `deps.season`). Reads the chain only; signs and sends nothing. → planSend's own answer, or {ok: false, code, why}.
 */
export async function planLiveSend(cand, q, { wallet, deps = {} } = {}) {
  if (cand?.kind !== 'send' || cand.held) return { ok: false, code: 'NotChoosable', why: cand?.held?.join('; ') ?? 'not a send candidate' };
  if (typeof deps.planSend !== 'function' || !deps.reader || !deps.season) return { ok: false, code: 'PlannerNotSupplied', why: "workstream 1's planSend, its chain reader or the Season is not supplied" };
  return deps.planSend({ reader: deps.reader, season: deps.season, wallet, request: q, cargo: cand.offer, source: cand.source ? { p: cand.source.p, q: cand.source.q, site: cand.source.site } : null });
}
