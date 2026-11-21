//! Build markers (M1 contract §3.2, I-53): a test-only feature leaves a
//! string in the `.so` that `scripts/build-frontier.sh` looks for, so a
//! `trace`, `oracle` or `test-beacon` artefact can never pass as the
//! deployable build.
//!
//! | feature | marker |
//! |---|---|
//! | `trace` | `PSF_TRACE_BUILD` |
//! | `oracle` | `PSF_ORACLE_BUILD` |
//! | `test-beacon` | `PSF_TEST_BEACON_BUILD` |
//! | `custody-preview` | `PSF_CUSTODY_PREVIEW_BUILD` (workstream 10: not a test build, but not deployable until verified) |
//! | `localnet-expedition-sbf` | `PSF_LOCALNET_EXPEDITION_SBF_BUILD` (isolated localnet lane, never deployable) |
//! | `localnet-conquest-sbf` | `PSF_LOCALNET_CONQUEST_SBF_BUILD`, in addition to the expedition lane's marker (isolated localnet conquest lane, never deployable) |
//! | `nft-experimental` | `PSF_NFT_EXPERIMENTAL_BUILD` (⑳ NFT resident ID, local and devnet only; never in the plain deployable build) |
//! | `localnet-nft-sbf` | `PSF_LOCALNET_NFT_SBF_BUILD`, in addition to both localnet markers (the playable lane with NFT residents, never deployable) |
//! | `devnet-playable-sbf` | `PSF_DEVNET_PLAYABLE_BUILD` (the devnet build of the playable lane, owner decision B7; deployable to devnet only, through `scripts/devnet/devnet-playable-profile.json`, which requires it; every other build and the S1 devnet profile refuse it) |
//! | `rights-experimental` | `PSF_RIGHTS_EXPERIMENTAL_BUILD` (workstream 02, option A; never deployable; `build-frontier.sh --features rights-test-beacon` builds it with `test-beacon` for LiteSVM) |
//! | `localnet-coexist-sbf` | `PSF_LOCALNET_COEXIST_SBF_BUILD`, in addition to the land lane's markers and the rights and custody ones (②+⑨+⑩ on the playable lane, version 0x7805, never deployable) |
//!
//! Each marker is passed through `core::hint::black_box` on a path every
//! instruction (or every beacon verification) runs, so neither the
//! compiler nor the linker can drop it; a plain build contains none of the
//! three strings (the script checks both directions).

/// The marker strings, for the host test and the build script's list.
pub const TRACE: &[u8] = b"PSF_TRACE_BUILD";
pub const ORACLE: &[u8] = b"PSF_ORACLE_BUILD";
pub const TEST_BEACON: &[u8] = b"PSF_TEST_BEACON_BUILD";
pub const CUSTODY_PREVIEW: &[u8] = b"PSF_CUSTODY_PREVIEW_BUILD";
pub const LOCALNET_EXPEDITION_SBF: &[u8] = b"PSF_LOCALNET_EXPEDITION_SBF_BUILD";
pub const LOCALNET_CONQUEST_SBF: &[u8] = b"PSF_LOCALNET_CONQUEST_SBF_BUILD";
pub const RIGHTS_EXPERIMENTAL: &[u8] = b"PSF_RIGHTS_EXPERIMENTAL_BUILD";
pub const NFT_EXPERIMENTAL: &[u8] = b"PSF_NFT_EXPERIMENTAL_BUILD";
pub const LOCALNET_NFT_SBF: &[u8] = b"PSF_LOCALNET_NFT_SBF_BUILD";
pub const DEVNET_PLAYABLE: &[u8] = b"PSF_DEVNET_PLAYABLE_BUILD";
pub const LOCALNET_WIDE_DEPART: &[u8] = b"PSF_LOCALNET_WIDE_DEPART_BUILD";
pub const LOCALNET_COEXIST_SBF: &[u8] = b"PSF_LOCALNET_COEXIST_SBF_BUILD";

/// Keeps the `trace` and `oracle` markers alive (called by `dispatch`).
#[inline(always)]
pub fn touch() {
    #[cfg(feature = "trace")]
    core::hint::black_box(TRACE.as_ptr());
    #[cfg(feature = "oracle")]
    core::hint::black_box(ORACLE.as_ptr());
    #[cfg(feature = "custody-preview")]
    core::hint::black_box(CUSTODY_PREVIEW.as_ptr());
    #[cfg(feature = "rights-experimental")]
    core::hint::black_box(RIGHTS_EXPERIMENTAL.as_ptr());
    #[cfg(feature = "nft-experimental")]
    core::hint::black_box(NFT_EXPERIMENTAL.as_ptr());
    #[cfg(feature = "devnet-playable-sbf")]
    core::hint::black_box(DEVNET_PLAYABLE.as_ptr());
}

/// Keeps the `localnet-expedition-sbf` marker alive (called by the lane's
/// program-id check at the top of `dispatch`).
#[inline(always)]
pub fn touch_localnet_expedition_sbf() {
    #[cfg(feature = "localnet-expedition-sbf")]
    core::hint::black_box(LOCALNET_EXPEDITION_SBF.as_ptr());
    #[cfg(feature = "localnet-conquest-sbf")]
    core::hint::black_box(LOCALNET_CONQUEST_SBF.as_ptr());
    #[cfg(feature = "localnet-nft-sbf")]
    core::hint::black_box(LOCALNET_NFT_SBF.as_ptr());
    #[cfg(feature = "localnet-wide-depart")]
    core::hint::black_box(LOCALNET_WIDE_DEPART.as_ptr());
    #[cfg(feature = "localnet-coexist-sbf")]
    core::hint::black_box(LOCALNET_COEXIST_SBF.as_ptr());
}

/// Keeps the `test-beacon` marker alive (called by every beacon
/// verification).
#[inline(always)]
pub fn touch_test_beacon() {
    #[cfg(feature = "test-beacon")]
    core::hint::black_box(TEST_BEACON.as_ptr());
}

/// Which markers this build carries.
pub const fn active() -> (bool, bool, bool) {
    (
        cfg!(feature = "trace"),
        cfg!(feature = "oracle"),
        cfg!(feature = "test-beacon"),
    )
}

#[cfg(test)]
mod tests {
    #[test]
    fn markers_are_distinct_and_named() {
        use super::*;
        for m in [TRACE, ORACLE, TEST_BEACON] {
            assert!(m.starts_with(b"PSF_") && m.ends_with(b"_BUILD"));
        }
        assert_ne!(TRACE, ORACLE);
        let script = include_str!("../../scripts/build-frontier.sh");
        assert_ne!(LOCALNET_EXPEDITION_SBF, LOCALNET_CONQUEST_SBF);
        for m in [
            TRACE,
            ORACLE,
            TEST_BEACON,
            CUSTODY_PREVIEW,
            LOCALNET_EXPEDITION_SBF,
            LOCALNET_CONQUEST_SBF,
            RIGHTS_EXPERIMENTAL,
            NFT_EXPERIMENTAL,
            LOCALNET_NFT_SBF,
            DEVNET_PLAYABLE,
            LOCALNET_COEXIST_SBF,
        ] {
            assert!(
                script.contains(core::str::from_utf8(m).unwrap()),
                "build-frontier.sh checks {}",
                core::str::from_utf8(m).unwrap()
            );
        }
        let _ = active();
    }

    /// Negative feature combinations stay closed: the expedition lane does
    /// not include the conquest kinds, an SBF build with the conquest kinds
    /// but without the conquest lane is a compile error, and only the
    /// conquest lane's own script/marker pair builds it.
    #[test]
    fn the_expedition_artefact_can_never_accept_the_conquest_kinds() {
        let cargo = include_str!("../Cargo.toml");
        let line = |name: &str| {
            cargo
                .lines()
                .find(|l| l.starts_with(&format!("{name} = ")))
                .unwrap_or_else(|| panic!("{name} feature"))
        };
        assert_eq!(
            line("localnet-expedition-sbf"),
            r#"localnet-expedition-sbf = ["expedition-dispatch-experimental"]"#
        );
        assert!(!line("expedition-dispatch-experimental").contains("conquest"));
        assert!(
            line("localnet-conquest-sbf").contains(r#""localnet-expedition-sbf""#)
                && line("localnet-conquest-sbf").contains(r#""conquest-dispatch-experimental""#)
        );
        let lib = include_str!("lib.rs");
        assert!(lib.contains("feature = \"conquest-dispatch-experimental\",\n    not(feature = \"localnet-conquest-sbf\")"), "SBF guard present");
        let script = include_str!("../../scripts/build-frontier.sh");
        assert!(script.contains("localnet-conquest-sbf:PSF_LOCALNET_EXPEDITION_SBF_BUILD|localnet-conquest-sbf:PSF_LOCALNET_CONQUEST_SBF_BUILD"));
        // the expedition lane wants only its own marker, so a conquest marker in it is refused
        assert!(!script.contains("localnet-expedition-sbf:PSF_LOCALNET_CONQUEST_SBF_BUILD"));
        assert!(script.contains("PSF_LOCALNET_CONQUEST_SBF_LANE"));
    }

    /// ⑳: only the NFT lane's script builds the playable lane with NFT
    /// residents, it wants all four markers, and no other lane accepts an
    /// NFT marker.
    #[test]
    fn the_nft_lane_is_its_own_artefact() {
        let cargo = include_str!("../Cargo.toml");
        let line = |name: &str| {
            cargo
                .lines()
                .find(|l| l.starts_with(&format!("{name} = ")))
                .unwrap_or_else(|| panic!("{name} feature"))
        };
        assert_eq!(
            line("localnet-nft-sbf"),
            r#"localnet-nft-sbf = ["localnet-conquest-sbf", "nft-experimental"]"#
        );
        assert!(!line("localnet-conquest-sbf").contains("nft"));
        let lib = include_str!("lib.rs");
        assert!(
            lib.contains(
                "feature = \"localnet-expedition-sbf\",\n    not(feature = \"localnet-nft-sbf\")"
            ),
            "SBF guard present"
        );
        let script = include_str!("../../scripts/build-frontier.sh");
        for m in [
            "PSF_LOCALNET_EXPEDITION_SBF_BUILD",
            "PSF_LOCALNET_CONQUEST_SBF_BUILD",
            "PSF_LOCALNET_NFT_SBF_BUILD",
            "PSF_NFT_EXPERIMENTAL_BUILD",
        ] {
            assert!(script.contains(&format!("localnet-nft-sbf:{m}")), "{m}");
        }
        assert!(script.contains("nft-experimental:PSF_NFT_EXPERIMENTAL_BUILD"));
        assert!(!script.contains("localnet-conquest-sbf:PSF_NFT_EXPERIMENTAL_BUILD"));
        assert!(!script.contains("nft-experimental:PSF_LOCALNET_NFT_SBF_BUILD|"));
        assert!(script.contains("PSF_LOCALNET_NFT_SBF_LANE"));
    }

    /// The devnet build of the playable lane (owner decision B7) is the land
    /// lane's code without the localnet lane: no localnet feature (so no
    /// [0x45; 32] id check and no localnet marker), its own guards, and its
    /// own script, which requires its marker; every other build refuses it.
    #[test]
    fn the_devnet_playable_build_is_separate_from_the_localnet_lanes() {
        let cargo = include_str!("../Cargo.toml");
        let line = cargo
            .lines()
            .find(|l| l.starts_with("devnet-playable-sbf = "))
            .expect("devnet-playable-sbf feature");
        assert_eq!(
            line,
            r#"devnet-playable-sbf = ["expedition-dispatch-experimental", "land-preview"]"#
        );
        // P14 (b): no Free City conquest kinds in the devnet build, by feature or by guard
        assert!(
            !line.contains("conquest"),
            "devnet-playable-sbf carries no conquest feature"
        );
        let land = cargo
            .lines()
            .find(|l| l.starts_with("localnet-land-sbf = "))
            .expect("localnet-land-sbf feature");
        assert!(land.contains(r#""land-preview""#) && land.contains(r#""localnet-conquest-sbf""#));
        let lib = include_str!("lib.rs");
        for guard in [
            "not(feature = \"localnet-expedition-sbf\"),\n    not(feature = \"devnet-playable-sbf\")\n))]\ncompile_error!(\"wide-world-experimental",
            "feature = \"conquest-dispatch-experimental\",\n    not(feature = \"localnet-conquest-sbf\")\n))]\ncompile_error!(\"conquest-dispatch-experimental on SBF requires localnet-conquest-sbf (",
            "#[cfg(all(\n    feature = \"devnet-playable-sbf\",\n    feature = \"conquest-dispatch-experimental\"\n))]\ncompile_error!(",
            "#[cfg(all(feature = \"devnet-playable-sbf\", feature = \"localnet-expedition-sbf\"))]\ncompile_error!",
            "\"devnet-playable-sbf cannot combine with host proof",
        ] {
            assert!(lib.contains(guard), "lib.rs guard {guard}");
        }
        // the id check stays the localnet lane's only
        assert!(lib.contains("#[cfg(feature = \"localnet-expedition-sbf\")]\n    if !localnet_identity_ok(program_id)"));
        let devnet = include_str!("../../scripts/build-frontier-devnet-playable-sbf.sh");
        assert!(devnet.contains("--features devnet-playable-sbf"));
        assert!(devnet.contains("PSF_DEVNET_PLAYABLE_BUILD"));
        let plain = include_str!("../../scripts/build-frontier.sh");
        assert!(
            plain.contains("PSF_DEVNET_PLAYABLE_BUILD"),
            "build-frontier.sh refuses it"
        );
        let land_script = include_str!("../../scripts/build-frontier-localnet-land-sbf.sh");
        assert!(
            land_script.contains("PSF_DEVNET_PLAYABLE_BUILD"),
            "the land lane refuses it"
        );
    }

    /// ②+⑨+⑩ (coexist): only its own script builds the playable lane with
    /// the three, the plain build, the land lane and the devnet build refuse
    /// its marker, and the devnet build's feature line never names it.
    #[test]
    fn the_coexist_lane_is_its_own_artefact() {
        let cargo = include_str!("../Cargo.toml");
        let line = |name: &str| {
            cargo
                .lines()
                .find(|l| l.starts_with(&format!("{name} = ")))
                .unwrap_or_else(|| panic!("{name} feature"))
        };
        assert_eq!(
            line("localnet-coexist-sbf"),
            r#"localnet-coexist-sbf = ["localnet-land-sbf", "coexist-experimental"]"#
        );
        for f in [
            "localnet-land-sbf",
            "devnet-playable-sbf",
            "localnet-conquest-sbf",
        ] {
            assert!(!line(f).contains("coexist"), "{f}");
        }
        let lib = include_str!("lib.rs");
        for guard in [
            "compile_error!(\"coexist-experimental never enters the devnet-playable build\")",
            "not(feature = \"localnet-coexist-sbf\")\n))]\ncompile_error!(\n    \"coexist-experimental on SBF",
        ] {
            assert!(lib.contains(guard), "lib.rs guard {guard}");
        }
        let plain = include_str!("../../scripts/build-frontier.sh");
        assert!(
            plain.contains("PSF_LOCALNET_COEXIST_SBF_BUILD"),
            "build-frontier.sh refuses it"
        );
        let land = include_str!("../../scripts/build-frontier-localnet-land-sbf.sh");
        assert!(
            land.contains("PSF_LOCALNET_COEXIST_SBF_BUILD"),
            "the land lane refuses it"
        );
        let own = include_str!("../../scripts/build-frontier-localnet-coexist-sbf.sh");
        assert!(own.contains("--features localnet-coexist-sbf"));
        for m in [
            "PSF_LOCALNET_EXPEDITION_SBF_BUILD",
            "PSF_LOCALNET_CONQUEST_SBF_BUILD",
            "PSF_LOCALNET_COEXIST_SBF_BUILD",
            "PSF_RIGHTS_EXPERIMENTAL_BUILD",
            "PSF_CUSTODY_PREVIEW_BUILD",
        ] {
            assert!(own.contains(m), "{m}");
        }
    }
}
