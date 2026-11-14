// The relay's answer when the Entry of a claim request reads CLAIMED: the
// one rule routes/prize.mjs applies (a wallet Claim and an NFT pass
// ClaimResident alike), kept pure so the contract test exercises exactly
// what the route does. No chain, no key, no address derivation.
//
// Two facts are kept apart:
//   * the received fact — the Entry is claimed (for good; nothing is ever
//     resent for it, and the relay's pending record is never released);
//   * the transaction evidence — the prior attempt's signature is handed
//     back ONLY when its status is finalized without error. A failed,
//     expired, merely confirmed or unknown signature is not evidence that
//     this requester's transaction paid the claim: `signature` is null then,
//     for a wallet and for a pass alike.
// And who was paid: a wallet Entry is claimed by its wallet only (`mine`
// always true); a pass Entry is this requester's only when it names the
// requester AND the generation it signed (`mine` from the route).

/** A signature status that proves the transaction landed: finalized, no error. */
export const finalizedOk = status => status?.confirmationStatus === 'finalized' && !status?.err;

/**
 * `{kind: 'unclaimed'}` when the Entry is absent, not the subject's, of
 * another pool or unclaimed; else `{kind: 'already' | 'claimedByOther',
 * signature, priorStatus, claimedBy, claimGeneration, amount}`:
 *   signature      the prior attempt's, only with finalized-ok evidence; else null
 *   priorStatus    what the pending record becomes: 'landed' with evidence, 'superseded' otherwise; null without a prior
 *   claimedBy      the Entry's claimer, or `fallbackClaimer` (a wallet Entry names none)
 */
export function claimedEntryAnswer({ entry, pool, owns, mine, prior = null, status = null, fallbackClaimer = null }) {
  if (!entry || !owns(entry) || entry.pool !== pool || !entry.claimed) return { kind: 'unclaimed' };
  const evidence = !!prior?.signature && finalizedOk(status);
  const base = {
    signature: evidence ? prior.signature : null,
    priorStatus: prior ? (evidence ? 'landed' : 'superseded') : null,
    claimedBy: entry.claimedBy ?? fallbackClaimer,
    claimGeneration: Number.isInteger(entry.claimGeneration) ? entry.claimGeneration : null,
    amount: String(entry.claimAmount ?? 0),
  };
  return { kind: mine(entry) ? 'already' : 'claimedByOther', ...base };
}
