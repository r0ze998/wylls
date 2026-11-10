//! Closed native execution of existing conquest wire contracts. No new wire
//! number, gate, outcome or authorization override. Public dispatch repeats
//! its unchanged lifecycle gate before reaching the same command consumer.
use super::*;

/// Only the three initial-Free-City operations supported by the continuous
/// original-host capture/return path. Exact codecs reject trailing data,
/// invalid versions and unsupported operations before account effects.
pub(super) fn execute_draft(p: &Pubkey, a: &[AccountInfo], data: &[u8]) -> R<()> {
    execute_command(p, a, wix::WideCommand::decode(data)?)
}

pub(super) fn execute_command(
    p: &Pubkey,
    a: &[AccountInfo],
    command: wix::WideCommand<'_>,
) -> R<()> {
    match command {
        wix::WideCommand::DeclareSiege(x) => {
            conquest_exec::declare_siege_inner(p, a, &x, &Auth::Wallet)
        }
        wix::WideCommand::ResolveWithConquest(x) => execute_resolve_with_conquest(p, a, &x),
        wix::WideCommand::SettleCapture(x) => conquest_settle_exec::settle_capture_inner(p, a, &x),
        _ => Err(FrontierError::BadData.into()),
    }
}
