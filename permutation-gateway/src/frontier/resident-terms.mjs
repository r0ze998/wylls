// ⑳ NFT resident ID: the relay's copy of the undecided-item switches
// (`frontier-abi/src/resident_terms.rs`, DEFAULT). Owner decision 2026-11-18
// 18:26 JST: local and devnet only, no sale. Each value is the conservative
// default (`permutation-nft-resident-spike/docs/UNDECIDED.ja.md`), confirmed
// by r0ze 2026-11-18 21:44 JST (t353u, "keep current defaults").
//
// The program enforces `transfer` (built with `nft-resident-no-transfer`, only
// the first holder acts). The others are enforced off chain or describe what
// the program already does. A test keeps this table equal to the Rust one.
export const RESIDENT_TERMS = Object.freeze({
  transfer: 'Allowed', // U7: option B, local only ('Refused' = soulbound)
  private: 'NotCarried', // U8/U9: private talk and AI memory stay with the holder generation
  voting: 'KeptByResident', // U5: Citizen.JOIN_BELL is not reset on transfer
  obligations: 'MovedWithResident', // U17: held goods and debts move, never erased
  sealed: 'UntilPublicTime', // U10: nobody sees a sealed target early, the new holder included
  perWallet: 'Many', // U31: one link per (Season, asset); a wallet may hold several
  migration: 'None', // U6/U38: wallet Citizens are never bound to an NFT
  sale: 'None', // U1/U20/U24/U30: no sale, price or royalties
});

/**
 * The key private, per-resident data (U8/U9) is kept under off chain: the
 * asset and, unless private data is carried, the holder generation — so a new
 * holder starts with nothing private of the previous one (A→B→A is a new
 * generation too).
 */
export function privateScope(asset, generation, terms = RESIDENT_TERMS) {
  if (typeof asset !== 'string' || !asset) throw new TypeError('asset');
  if (terms.private === 'Carried') return asset;
  if (!Number.isInteger(generation) || generation < 0) throw new TypeError('generation');
  return `${asset}#g${generation}`;
}
