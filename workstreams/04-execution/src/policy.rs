//! What the executor may do on its own.
//!
//! Automatic work is limited to logistics and facility use: a facility use
//! under a right, and SendCaravan between places. The executor observes
//! settlements (the keeper's `csettle` duty sends SettleCaravan; it is not
//! duplicated here) and never starts a march, a raid, a seizure, a siege or
//! a vote. `Request` cannot express those; this list is the second fence,
//! for the execution path (③) to enforce on the run signer's scope.

use frontier_abi::v2::Ix;

/// The on-chain instructions a run signer may send.
pub const AUTOMATABLE: [Ix; 1] = [Ix::SendCaravan];

pub fn automatable(ix: Ix) -> bool {
    AUTOMATABLE.contains(&ix)
}

/// The instruction of a request (`None`: the facility use, which has no
/// instruction on today's chain: MOCK only).
pub fn instruction_of(r: &crate::ports::Request) -> Option<Ix> {
    match r {
        crate::ports::Request::SendCaravan { .. } => Some(Ix::SendCaravan),
        crate::ports::Request::UseFacility { .. } => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_military_instruction_is_automatable() {
        for ix in [
            Ix::Depart,
            Ix::Reveal,
            Ix::Muster,
            Ix::Train,
            Ix::Garrison,
            Ix::DeclareSiege,
            Ix::FileOutpost,
            Ix::RaidCaravan,
            Ix::RaidDomestic,
            Ix::SeizeVault,
            Ix::SeizeStructure,
            Ix::FortGarrison,
            Ix::Propose,
            Ix::Vote,
        ] {
            assert!(!automatable(ix), "{ix:?}");
        }
        // Everything automatable is a player-shape the relay sponsors.
        for ix in Ix::ALL {
            if automatable(*ix) {
                assert!(frontier_abi::v2::tags::relay_player_shape(*ix));
            }
        }
        assert_eq!(Ix::ALL.iter().filter(|i| automatable(**i)).count(), 1);
    }
}
