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
        for m in [TRACE, ORACLE, TEST_BEACON, CUSTODY_PREVIEW, LOCALNET_EXPEDITION_SBF] {
            assert!(
                script.contains(core::str::from_utf8(m).unwrap()),
                "build-frontier.sh checks {}",
                core::str::from_utf8(m).unwrap()
            );
        }
        let _ = active();
    }
}
