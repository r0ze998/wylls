//! Shared by feature `epochs` ([`crate::epoch`]) and feature `goals`
//! ([`crate::goals`]): the operator-member exclusion (ExcludeWallet, tag 12)
//! and the "continuous world, running" check. Moved here unchanged from
//! `epoch.rs` (goal-prize-pool, 2026-11-24); `epoch::` re-exports every
//! public name, so no address, layout or behaviour changes.

use solana_program::{account_info::AccountInfo, msg, program_error::ProgramError, pubkey::Pubkey};

use super::*;

/// ⑰ owner decision 2026-11-18 21:44 (t353u): no AI residents in paid
/// periods. Operator AI residents and script bots join a gated season by
/// invite, with the season's join-gate key; only that key can mark a wallet
/// here, and an epoch pool's Pay and Claim refuse a marked wallet
/// (`OperatorMember`). PDA `["noprize", game, le64(season), wallet]`.
///
/// Goal pools (feature `goals`, Q17 (b), owner 2026-11-24 01:04): the same
/// mark refuses BuyPass and GoalClaim — operator AI residents count like
/// people in the game, but receive no money.
pub const EXCLUSION_SEED: &[u8] = b"noprize";
pub mod exclusion {
    pub const MAGIC: [u8; 8] = *b"WYPRNOPZ";
    pub const SIZE: usize = 72;
    pub const SEASON: usize = 8;
    pub const WALLET: usize = 40;
}

/// The exclusion address of `wallet` in a season of a game program.
pub fn exclusion_address(
    program: &Pubkey,
    game: &Pubkey,
    season_id: u64,
    wallet: &Pubkey,
) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[
            EXCLUSION_SEED,
            game.as_ref(),
            &season_id.to_le_bytes(),
            wallet.as_ref(),
        ],
        program,
    )
}

/// `ai` is the wallet's exclusion address in (game, season), and nothing is
/// there (`OperatorMember` otherwise).
pub(crate) fn not_excluded(
    program: &Pubkey,
    game: &Pubkey,
    sid: u64,
    wallet: &Pubkey,
    ai: &AccountInfo,
) -> R<()> {
    if exclusion_address(program, game, sid, wallet).0 != *ai.key {
        return Err(E::BadAccount.into());
    }
    if !is_empty(ai) {
        return Err(E::OperatorMember.into());
    }
    Ok(())
}

/// 12 ExcludeWallet: `[gate s] [payer s,w] [season] [game program]
/// [exclusion w] [wallet] [system]`. The season's join gate (the key that
/// admits operator members by invite) marks `wallet` as an operator member
/// of the season: no Pay and no Claim in any epoch pool of it, no BuyPass and
/// no GoalClaim in its goal pool. Repeating it is a no-op; nothing removes a
/// mark.
pub(crate) fn exclude_wallet(program: &Pubkey, a: &[AccountInfo]) -> R<()> {
    let [gate, payer, season, game, excl, wallet, system] = a else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    if !gate.is_signer || !payer.is_signer || *system.key != SYSTEM_PROGRAM {
        return Err(E::BadAccount.into());
    }
    let sid = {
        let sd = season.try_borrow_data()?;
        if season.owner != game.key || sd.len() != S::SIZE || sd[..8] != S::MAGIC {
            return Err(E::BadAccount.into());
        }
        let g: [u8; 32] = rd(&sd, S::JOIN_GATE)?;
        if g == [0u8; 32] || g != gate.key.to_bytes() {
            return Err(E::NotOperator.into());
        }
        u64_at(&sd, S::SEASON_ID)?
    };
    let (season_pda, _) =
        Pubkey::find_program_address(&[S::PDA_PREFIX, &sid.to_le_bytes()], game.key);
    if season_pda != *season.key {
        return Err(E::BadAccount.into());
    }
    let (key, bump) = exclusion_address(program, game.key, sid, wallet.key);
    if key != *excl.key {
        return Err(E::BadAccount.into());
    }
    if excl.owner == program && excl.try_borrow_data()?.get(..8) == Some(&exclusion::MAGIC[..]) {
        return Ok(());
    }
    create(
        payer,
        excl,
        exclusion::SIZE,
        program,
        &[
            EXCLUSION_SEED,
            game.key.as_ref(),
            &sid.to_le_bytes(),
            wallet.key.as_ref(),
            &[bump],
        ],
    )?;
    let mut d = excl.try_borrow_mut_data()?;
    put(&mut d, 0, &exclusion::MAGIC)?;
    put(&mut d, exclusion::SEASON, season.key.as_ref())?;
    put(&mut d, exclusion::WALLET, wallet.key.as_ref())?;
    msg!("PRIZE exclude season={} wallet={}", sid, wallet.key);
    Ok(())
}

/// The season may hold epoch pools and goal pools: a continuous S1 world,
/// running.
pub(crate) fn continuous_running(sd: &[u8], now_ts: i64) -> R<()> {
    let at = frontier_abi::v2::presets::SEASON_CQ_OFFSET
        + frontier_abi::v2::presets::cq_layout::CONTINUOUS;
    match sd.get(at) {
        Some(1) => {}
        Some(0) => return Err(E::FiniteSeason.into()),
        _ => return Err(E::BadAccount.into()),
    }
    let status = *sd.get(S::STATUS).ok_or(E::BadAccount)?;
    let genesis_ts = i64::from_le_bytes(rd(sd, S::GENESIS_TS)?);
    if !matches!(status, S::STATUS_SEEDED | S::STATUS_RUNNING) || now_ts < genesis_ts {
        return Err(E::WrongState.into());
    }
    if u32_at(sd, S::BELL_SECS)? == 0 {
        return Err(E::BadParams.into());
    }
    Ok(())
}
