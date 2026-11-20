//! ②+⑨+⑩ in one build (`coexist-experimental`; workstream 4's allocation
//! rev 8, `frontier_abi::feature_registry`): key-free host checks that the
//! combined program carries one exact version, custody's ruleset, and routes
//! all three bands through the one `dispatch` (each tag reaches its
//! feature's handler, which refuses an empty account list on its own terms,
//! never as the unknown tag `BadData` of the S1 build). The flows themselves
//! run in the three features' own harnesses (`rights_runtime_tests`,
//! `capacity_runtime_tests`, `proc::custody` tests), which this build
//! compiles and runs together, and on the real SBF artefact in
//! `frontier-node/crates/itest/tests/localnet_coexist.rs`.

use frontier_abi::feature_registry as fr;

#[test]
fn one_version_and_custodys_ruleset() {
    assert!(fr::is_coexist_version(crate::PROGRAM_VERSION));
    assert_eq!(
        crate::PROGRAM_VERSION & fr::BASE_MASK,
        fr::BASE_CUSTODY,
        "custody's base"
    );
    for bit in [fr::RIGHTS_BIT, fr::CAPACITY_BIT] {
        assert_eq!(crate::PROGRAM_VERSION & bit, bit);
    }
    assert_eq!(
        crate::PROGRAM_VERSION & (fr::WIDE_BIT | fr::EXPEDITION_BIT) != 0,
        cfg!(feature = "expedition-dispatch-experimental")
    );
    assert_eq!(crate::PROGRAM_VERSION & 0x8000, 0, "no NFT residents");
    assert_eq!(
        crate::RULESET_HASH,
        frontier_abi::v2::presets::RULESET_HASH_V4
    );
    assert_eq!(crate::RULES_VERSION, 13);
}

/// Every tag of the three bands reaches a handler (any refusal but the
/// unknown-tag `BadData`), with and without data bytes after the tag.
#[test]
fn the_three_bands_reach_their_handlers() {
    let pid = solana_program::pubkey::Pubkey::new_from_array([7; 32]);
    let mut routed = 0;
    for band in fr::TAG_BANDS {
        if !matches!(
            band.owner,
            fr::Owner::Rights | fr::Owner::Capacity | fr::Owner::Custody
        ) {
            continue;
        }
        for t in band.first..=band.last {
            // capacity decodes its exact data length first
            let len = frontier_abi::capacity::CapIx::from_tag(t as u8)
                .map_or(160, frontier_abi::capacity::CapData::len_of);
            let mut data = alloc::vec![t as u8];
            data.resize(len, 0);
            let r = crate::dispatch(&pid, &[], &data);
            assert!(r.is_err(), "{t:#04x} with no accounts");
            assert_ne!(
                r,
                Err(crate::FrontierError::BadData.into()),
                "{t:#04x} ({:?}) is routed",
                band.owner
            );
            routed += 1;
        }
    }
    assert_eq!(routed, 11 + 6 + 14);
}
