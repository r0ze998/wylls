//! **Reach from the nation's land** (expansion-gameplay-1, owner t491u
//! 2026-11-24: nations should visibly spread across the map; design note
//! `docs/design/expansion/01-reach-from-land.md`).
//!
//! Before: a wide claim (0xD9 WideClaimSite) is in range only when its
//! target is within `outpost_range` provinces of the claimer's **first
//! home** (`holding::may_found_outpost`, `range` from the anchor). A
//! nation's villages could therefore never stand more than three provinces
//! from where its people first settled, whatever the nation did.
//!
//! Now the claim may name one more, read-only, wide province — the **reach
//! witness** (`wide_ix::CLAIM_SITE`'s optional `reach_province`). When the
//! witness is the claimer's **nation's land** ([`is_nation_land`]), the
//! range the outpost rule checks is the nearer of the anchor and the witness
//! ([`claim_range`]). Everything else in the outpost rule is unchanged (the
//! three holdings, the slot order, the tier, the heartland, the 50 % share
//! that keeps outposts off land the nation already dominates, the land gate,
//! the settler cost paid by the first home).
//!
//! A wide province is the nation's land when either
//!
//! - **settled**: a village of any citizen of that nation stands there
//!   (`faction_weight > 0`, the strength weight the share rule already reads
//!   from the province's site mirror), or
//! - **won**: its keep is held by that nation **and was taken at least once**
//!   (`changes > 0`). A keep the province opened with (every wide keep starts
//!   held by some nation, ⑧ wide land (i), interleaved) gives no reach: the
//!   genesis mosaic would otherwise put every nation's reach everywhere.
//!
//! So the frontier moves only where a nation has actually gone: each new
//! village and each captured keep extends that nation's reach by
//! `outpost_range` provinces.
//!
//! Pure; the program (`proc::wide::claim_site`) and the verifier
//! (`vwl_wide_claims`) call the same two functions.

use permutation_rules::frontier::keep::Keep;

/// Whether a wide province is `faction`'s land for a reach witness:
/// `faction_weight` is the nation's strength weight among the province's
/// sites (`proc::citizen::province_weights`), `keep` the province's keep.
pub fn is_nation_land(faction: u8, faction_weight: u64, keep: Option<&Keep>) -> bool {
    faction_weight > 0 || keep.is_some_and(|k| k.holder == faction && k.changes > 0)
}

/// The range the outpost rule checks: the anchor's distance, or the
/// witness's when a witness is named and nearer. The caller has already
/// refused a witness that is not the nation's land.
pub fn claim_range(anchor_distance: u128, witness_distance: Option<u128>) -> u128 {
    match witness_distance {
        Some(w) => anchor_distance.min(w),
        None => anchor_distance,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use permutation_rules::frontier::keep::NO_FACTION;

    fn keep(holder: u8, changes: u16) -> Keep {
        Keep {
            tile: 10,
            holder,
            contender: NO_FACTION,
            progress: 0,
            required: 72,
            heartland_safe: false,
            paused: false,
            changes,
            troops: 100,
            since_bell: 0,
            consolidated_until_bell: 0,
            contest_from_bell: 0,
            gen: changes as u32,
            last_taken_from: NO_FACTION,
        }
    }

    #[test]
    fn a_village_of_the_nation_makes_its_land() {
        assert!(is_nation_land(2, 1, None));
        assert!(
            is_nation_land(2, 1, Some(&keep(4, 0))),
            "whoever holds the keep"
        );
    }

    #[test]
    fn a_genesis_keep_is_not_reach_but_a_won_keep_is() {
        assert!(
            !is_nation_land(2, 0, Some(&keep(2, 0))),
            "the opening mosaic"
        );
        assert!(is_nation_land(2, 0, Some(&keep(2, 1))), "taken once");
        assert!(is_nation_land(2, 0, Some(&keep(2, 3))), "taken back");
        assert!(!is_nation_land(2, 0, Some(&keep(3, 5))), "another nation's");
        assert!(!is_nation_land(2, 0, None), "no keep, no village");
    }

    #[test]
    fn the_range_is_the_nearer_source() {
        assert_eq!(claim_range(9, None), 9);
        assert_eq!(claim_range(9, Some(2)), 2);
        assert_eq!(claim_range(2, Some(9)), 2, "a far witness never hurts");
    }
}
