//! The MC conquest instructions (MC contract §5.5): DeclareSiege (0xA0),
//! SettleSiege (0xA1), SettleCapture (0xA2), FoldMarch (0xA5), RetireHost
//! (0xA6) and CloseMarch (0xA7).
//!
//! **Wave 2 hand-over (§11).** CQ2-A's first commit adds this file with
//! every handler a `NotImplemented` (99) stub, so the v2 dispatch table of
//! [`crate::dispatch`] is complete from day 1 of the wave; from then on the
//! file belongs to **CQ2-C** (prog-conquest), which implements the six
//! handlers against §3.4–§3.6, §3.10 and §5.5. FileOutpost (0xA3) is
//! CQ2-A's and lives in `proc/citizen.rs` beside FileTicket.
//!
//! Every handler has the signature `fn(&Pubkey, &[AccountInfo], &[u8]) ->
//! R<()>`; `RELEASE_CHECK=1` (G13, CQ4-A) fails while any path still
//! returns `NotImplemented`.

use solana_program::{account_info::AccountInfo, pubkey::Pubkey};

use crate::{FrontierError, R};

fn not_implemented(p: &Pubkey, a: &[AccountInfo], d: &[u8]) -> R<()> {
    let _ = (p, a, d);
    Err(FrontierError::NotImplemented.into())
}

/// 0xA0 DeclareSiege (P): §3.4 steps 1–10, §5.5. CQ2-C.
pub fn declare_siege(p: &Pubkey, a: &[AccountInfo], d: &[u8]) -> R<()> {
    not_implemented(p, a, d)
}

/// 0xA1 SettleSiege (N): stake, slot release, season-end lapse (§5.5).
/// CQ2-C.
pub fn settle_siege(p: &Pubkey, a: &[AccountInfo], d: &[u8]) -> R<()> {
    not_implemented(p, a, d)
}

/// 0xA2 SettleCapture (D): §3.6 into the reserved slot (§5.5). CQ2-C.
pub fn settle_capture(p: &Pubkey, a: &[AccountInfo], d: &[u8]) -> R<()> {
    not_implemented(p, a, d)
}

/// 0xA5 FoldMarch (D): §3.10 per hour, MarchState init (§5.5). CQ2-C.
pub fn fold_march(p: &Pubkey, a: &[AccountInfo], d: &[u8]) -> R<()> {
    not_implemented(p, a, d)
}

/// 0xA6 RetireHost (P the victim during the season, N after `end_bell`;
/// K-27, §5.5). CQ2-C.
pub fn retire_host(p: &Pubkey, a: &[AccountInfo], d: &[u8]) -> R<()> {
    not_implemented(p, a, d)
}

/// 0xA7 CloseMarch (N): after `end + 72 h` (§5.5). CQ2-C.
pub fn close_march(p: &Pubkey, a: &[AccountInfo], d: &[u8]) -> R<()> {
    not_implemented(p, a, d)
}
