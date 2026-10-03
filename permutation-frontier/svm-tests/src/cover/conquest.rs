//! Coverage of the MC conquest instructions (conquest contract §5.5, §13.3):
//! DeclareSiege, SettleSiege, SettleCapture, FoldMarch, RetireHost and
//! CloseMarch. Added by CQ2-A's first commit as `Pending`; owned by CQ2-C
//! from then on (§11 Wave 2). MC codes are asserted as `CqErr(Cq::X)`.

use super::Cover;

/// Ignored tests of this area waiting for a fix: (test, unit).
pub const PENDING: &[(&str, &str)] = &[];

pub const DECLARE_SIEGE: &[Cover] = &[Cover::Pending("CQ2-C")];
pub const SETTLE_SIEGE: &[Cover] = &[Cover::Pending("CQ2-C")];
pub const SETTLE_CAPTURE: &[Cover] = &[Cover::Pending("CQ2-C")];
pub const FOLD_MARCH: &[Cover] = &[Cover::Pending("CQ2-C")];
pub const RETIRE_HOST: &[Cover] = &[Cover::Pending("CQ2-C")];
pub const CLOSE_MARCH: &[Cover] = &[Cover::Pending("CQ2-C")];
