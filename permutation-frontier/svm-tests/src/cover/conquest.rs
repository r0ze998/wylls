//! Coverage of the MC conquest instructions (MC §5.5, §13.3 G13): the
//! seven new tags of `frontier_abi::v2::tags::Ix`, which the M1 registry
//! (`covered_by`, exhaustive over `tags::Ix`) does not name.
//!
//! **Stub (CQ2-A's first commit, §11 Wave 2):** every new instruction is
//! `Pending` until its unit hands in its tests (CQ2-C; FileOutpost CQ2-A).

use frontier_abi::v2::tags::Ix as I2;

use super::Cover;

/// The tests covering a new MC instruction (`None` for an M1 tag, which
/// [`super::covered_by`] covers).
pub fn covered_by_new(ix: I2) -> Option<&'static [Cover]> {
    Some(match ix {
        I2::DeclareSiege
        | I2::SettleSiege
        | I2::SettleCapture
        | I2::FoldMarch
        | I2::RetireHost
        | I2::CloseMarch => &[Cover::Pending("CQ2-C")],
        I2::FileOutpost => &[Cover::Pending("CQ2-A")],
        _ => return None,
    })
}
