//! Host-only versioned route to existing authenticated expedition consumers.
//! The old outbound gate and raw private codecs remain closed. No caller may
//! supply a proof verdict, receipt or prepared state instead of runtime inputs.
use super::*;
use frontier_abi::world_index::expedition_dispatch_ix::{Command, Kind, PROGRAM_VERSION};

pub(super) fn execute(p: &Pubkey, a: &[AccountInfo], data: &[u8]) -> R<()> {
    let command = Command::decode(data)?;
    let carrier = wix::WideIx::from_tag(command.kind().tag()).ok_or(FrontierError::BadData)?;
    prologue::top_level(carrier)?;
    let season = a
        .get(command.kind().season_index())
        .ok_or(FrontierError::TooManyAccounts)?;
    // Full Seasons only: terminal tombstones cannot prove this revision.
    if season.owner != p || season.executable {
        return Err(BAD_ACCOUNT);
    }
    let sd = season.try_borrow_data()?;
    if sd.len() != frontier_abi::v2::layout::AccountKind::Season.size() {
        return Err(BAD_ACCOUNT);
    }
    if Ro(&sd).u16(S::PROGRAM_VERSION)? != PROGRAM_VERSION
        || crate::PROGRAM_VERSION != PROGRAM_VERSION
    {
        return Err(FrontierError::RulesetMismatch.into());
    }
    let season_id = Ro(&sd).u64(S::SEASON_ID)?;
    drop(sd);
    prologue::present_v2(
        season,
        p,
        frontier_abi::v2::layout::AccountKind::Season,
        season_id,
    )?;
    // Existing consumer prologues authenticate canonical Season/owner/layout,
    // exact roles and privileges, wallet/permissionless policy and all proofs.
    match command.kind() {
        Kind::Depart | Kind::SettleOrigin | Kind::Reveal | Kind::Gather => {
            dispatch_expedition_command(p, a, wix::WideCommand::decode(command.inner())?)
        }
        Kind::Dissolve | Kind::Return => expedition_resident::execute_draft(p, a, command.inner()),
        Kind::SettleMember => expedition_return::settle_draft(p, a, command.inner()),
        Kind::SettleCamp => expedition_return::settle_camp_draft(p, a, command.inner()),
        Kind::SettleFailure => expedition_return::settle_failure_draft(p, a, command.inner()),
        Kind::SettleForfeit => expedition_return::settle_forfeit_draft(p, a, command.inner()),
        Kind::CloseTerminal => expedition_return::close_terminal_draft(p, a, command.inner()),
        Kind::SettleRetainedFailure => {
            expedition_return::settle_retained_failure_draft(p, a, command.inner())
        }
    }
}
