// The relay's JSON views of prize entries (GET /f/prize?wallet= and
// ?asset=): the one projection the route serializes, so the page's readers
// (fprize.claimIsMine, passClaimModel) and the contract test see exactly
// what the route sends. Pure: plain objects in, plain objects out; no
// chain, no key, no address derivation. Amounts are decimal strings (bigint
// → string); `claimedBy` and `claimGeneration` are kept together, since a
// pass claim is this owner's only when BOTH name it (an Entry claimed by an
// earlier owner, or by the same wallet at another generation, is not).
//
// The decoded inputs are sdk prize.mjs's `decodeEntry` / `decodeEntryResident`
// (or null for no account); `citizen` is a decoded Citizen or null.

const str = v => (v === null || v === undefined ? null : String(v));

/** A wallet Entry's view, or null: `{paid, claimed, claimAmount, nation}`. */
export function walletEntryView(e) {
  if (!e) return null;
  return { paid: str(e.amount), claimed: !!e.claimed, claimAmount: str(e.claimAmount), nation: e.nation ?? null };
}

/**
 * An NFT pass Entry's view, or null: who paid and at which generation, and,
 * once claimed, who claimed and at which generation. `claimGeneration` is
 * always present (null until claimed): a reader that compares it must see
 * the field, never an absent key.
 */
export function passEntryView(e) {
  if (!e) return null;
  return {
    paid: str(e.amount), paidBy: e.paidBy ?? null, payGeneration: Number.isInteger(e.payGeneration) ? e.payGeneration : null,
    claimed: !!e.claimed, claimedBy: e.claimed ? e.claimedBy ?? null : null, claimGeneration: e.claimed && Number.isInteger(e.claimGeneration) ? e.claimGeneration : null,
    claimAmount: str(e.claimAmount), nation: e.nation ?? null,
  };
}

/** The `pass` block of GET /f/prize?asset=: the pass, its NFT Citizen's address and nation, its Entry's view. */
export function passView({ asset, citizen, citizenAccount = null, entry = null }) {
  return { asset, citizen, faction: citizenAccount ? citizenAccount.FACTION : null, entry: passEntryView(entry) };
}

/** The keys a pass Entry view always carries (the contract the page relies on). */
export const PASS_ENTRY_VIEW_KEYS = Object.freeze(['paid', 'paidBy', 'payGeneration', 'claimed', 'claimedBy', 'claimGeneration', 'claimAmount', 'nation']);
