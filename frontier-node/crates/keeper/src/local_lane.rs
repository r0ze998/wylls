//! The program versions a local-play deployment may carry, as the preparation tools check them (read from the
//! deployment, never a second literal). `0x4804` — the conquest lane (S1 | wide 0x4000 | host-only dispatch 0x0800)
//! — is served as before, under whatever program the deployment names. `0xC804` is the LOCAL TEST CANDIDATE
//! `localnet-conquest-nft-sbf` (the conquest lane with NFT residents): served ONLY under its candidate program id
//! [0x4C; 32]. Not an allocation, never deployable; the production version is undecided and is not here.
//! (The same rule as permutation-gateway/src/frontier/local-lane-versions.mjs and the page's flocallanes.mjs.)
//! WRITTEN 2026-11-14 WITHOUT COMPILING (no host build was agreed then); its tests are below.
use crate::wideduty::Scope;
use frontier_abi::world_index::expedition_dispatch_ix;
use solana_address::Address;

/// The conquest lane's exact version (`expedition_dispatch_ix::PROGRAM_VERSION`, 0x4804).
pub const CONQUEST_VERSION: u16 = expedition_dispatch_ix::PROGRAM_VERSION;
/// The local test candidate's version: the conquest lane's with the existing NFT bit (0xC804).
pub const CANDIDATE_VERSION: u16 = CONQUEST_VERSION | 0x8000;
/// The local test candidate's program id (not a keypair's public key).
pub const CANDIDATE_PROGRAM: [u8; 32] = [0x4C; 32];

/// Whether `version` is served for `program`: 0x4804 as before; 0xC804 only under the candidate id.
pub fn served(program: &Address, version: u16) -> bool {
    version == CONQUEST_VERSION
        || (version == CANDIDATE_VERSION && program.to_bytes() == CANDIDATE_PROGRAM)
}

/// The served version a request's deployment names for its program, or `None` (no deployment, or not served).
pub fn served_scope(scope: &Scope) -> Option<u16> {
    scope
        .deployment
        .as_ref()
        .map(|d| d.program_version)
        .filter(|v| served(&scope.program, *v))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_conquest_version_as_before_and_the_candidate_only_under_its_id() {
        assert_eq!(CONQUEST_VERSION, 0x4804);
        assert_eq!(CANDIDATE_VERSION, 0xC804);
        let any = Address::new_from_array([0x45; 32]);
        let cand = Address::new_from_array(CANDIDATE_PROGRAM);
        assert!(served(&any, 0x4804));
        assert!(served(&cand, 0x4804));
        assert!(served(&cand, 0xC804));
        assert!(
            !served(&any, 0xC804),
            "the candidate version under another program"
        );
        for v in [4u16, 0x4004, 0x8004, 0x4805, 0xC805, 0] {
            assert!(!served(&cand, v), "{v:#06x}");
            assert!(!served(&any, v), "{v:#06x}");
        }
    }
}
