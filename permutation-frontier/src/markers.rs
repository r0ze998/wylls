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
//! | `localnet-nft-sbf` | `PSF_LOCALNET_NFT_SBF_BUILD`, with `PSF_TEST_BEACON_BUILD` (isolated local NFT world lane, never deployable) |
//! | `localnet-conquest-nft-sbf` | `PSF_LOCALNET_CONQUEST_NFT_SBF_BUILD`, with the conquest lane's two markers (local test candidate, never deployable, not built yet) |
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
pub const LOCALNET_NFT_SBF: &[u8] = b"PSF_LOCALNET_NFT_SBF_BUILD";
/// Local test candidate (`localnet-conquest-nft-sbf`), with the conquest lane's two markers; never deployable.
pub const LOCALNET_CONQUEST_NFT_SBF: &[u8] = b"PSF_LOCALNET_CONQUEST_NFT_SBF_BUILD";

/// Keeps the `trace` and `oracle` markers alive (called by `dispatch`).
#[inline(always)]
pub fn touch() {
    #[cfg(feature = "trace")]
    core::hint::black_box(TRACE.as_ptr());
    #[cfg(feature = "oracle")]
    core::hint::black_box(ORACLE.as_ptr());
    #[cfg(feature = "custody-preview")]
    core::hint::black_box(CUSTODY_PREVIEW.as_ptr());
}

/// Keeps the `localnet-expedition-sbf` marker alive (called by the lane's
/// program-id check at the top of `dispatch`).
#[inline(always)]
pub fn touch_localnet_expedition_sbf() {
    #[cfg(feature = "localnet-expedition-sbf")]
    core::hint::black_box(LOCALNET_EXPEDITION_SBF.as_ptr());
    #[cfg(feature = "localnet-conquest-sbf")]
    core::hint::black_box(LOCALNET_CONQUEST_SBF.as_ptr());
    #[cfg(feature = "localnet-conquest-nft-sbf")]
    core::hint::black_box(LOCALNET_CONQUEST_NFT_SBF.as_ptr());
}

/// Keeps the `localnet-nft-sbf` marker alive (called by the lane's
/// program-id check at the top of `dispatch`).
#[inline(always)]
pub fn touch_localnet_nft_sbf() {
    #[cfg(feature = "localnet-nft-sbf")]
    core::hint::black_box(LOCALNET_NFT_SBF.as_ptr());
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
        assert_ne!(LOCALNET_NFT_SBF, LOCALNET_EXPEDITION_SBF);
        assert_ne!(LOCALNET_CONQUEST_NFT_SBF, LOCALNET_CONQUEST_SBF);
        assert_ne!(LOCALNET_CONQUEST_NFT_SBF, LOCALNET_NFT_SBF);
        for m in [
            TRACE,
            ORACLE,
            TEST_BEACON,
            CUSTODY_PREVIEW,
            LOCALNET_EXPEDITION_SBF,
            LOCALNET_CONQUEST_SBF,
            LOCALNET_NFT_SBF,
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
        let line = |name: &str| cargo.lines().find(|l| l.starts_with(&format!("{name} = "))).unwrap_or_else(|| panic!("{name} feature"));
        assert_eq!(line("localnet-expedition-sbf"), r#"localnet-expedition-sbf = ["expedition-dispatch-experimental"]"#);
        assert!(!line("expedition-dispatch-experimental").contains("conquest"));
        assert!(line("localnet-conquest-sbf").contains(r#""localnet-expedition-sbf""#) && line("localnet-conquest-sbf").contains(r#""conquest-dispatch-experimental""#));
        let lib = include_str!("lib.rs");
        assert!(lib.contains("feature = \"conquest-dispatch-experimental\",\n    not(feature = \"localnet-conquest-sbf\")"), "SBF guard present");
        let script = include_str!("../../scripts/build-frontier.sh");
        assert!(script.contains("localnet-conquest-sbf:PSF_LOCALNET_EXPEDITION_SBF_BUILD|localnet-conquest-sbf:PSF_LOCALNET_CONQUEST_SBF_BUILD"));
        // the expedition lane wants only its own marker, so a conquest marker in it is refused
        assert!(!script.contains("localnet-expedition-sbf:PSF_LOCALNET_CONQUEST_SBF_BUILD"));
        assert!(script.contains("PSF_LOCALNET_CONQUEST_SBF_LANE"));
    }

    /// The local NFT lane is S1 + nft-experimental + test-beacon only, wants
    /// its own marker and the test-beacon one, and only its own script
    /// builds it; no other lane's artefact may carry its marker.
    #[test]
    fn the_local_nft_lane_is_isolated() {
        let cargo = include_str!("../Cargo.toml");
        let line = |name: &str| {
            cargo
                .lines()
                .find(|l| l.starts_with(&format!("{name} = ")))
                .unwrap_or_else(|| panic!("{name} feature"))
        };
        assert_eq!(
            line("localnet-nft-sbf"),
            r#"localnet-nft-sbf = ["nft-experimental", "test-beacon"]"#
        );
        for other in [
            "localnet-expedition-sbf",
            "localnet-conquest-sbf",
            "expedition-dispatch-experimental",
        ] {
            assert!(
                !line(other).contains("nft"),
                "{other} never carries NFT residents"
            );
        }
        let lib = include_str!("lib.rs");
        assert!(lib.contains("compile_error!(\"localnet-nft-sbf is the isolated local NFT lane"));
        assert!(lib.contains("compile_error!(\"nft-experimental on SBF requires localnet-nft-sbf"));
        let script = include_str!("../../scripts/build-frontier.sh");
        assert!(script.contains(
            "localnet-nft-sbf:PSF_LOCALNET_NFT_SBF_BUILD|localnet-nft-sbf:PSF_TEST_BEACON_BUILD"
        ));
        assert!(script.contains("PSF_LOCALNET_NFT_SBF_LANE"));
        assert!(!script.contains("localnet-conquest-sbf:PSF_LOCALNET_NFT_SBF_BUILD"));
    }
}
