//! Settlement windows for a continuous world (feature `epochs`; test
//! assets, local and devnet only — see
//! `docs/frontier/payments/X402-PRIZE-EPOCHS.md`).
//!
//! A continuous S1 world never reaches Season Ended, so the legacy pool's
//! only exit (Tally/Finalize after the end) never opens
//! (`X402-PRIZE-CONTINUITY.ja.md` D2). An **epoch pool** replaces "the end"
//! with a bell the operator fixes when it opens the pool: `end_bell` of
//! epoch `n`. Fees are taken until that bell's time; the keeps are counted
//! as they stood once every bell before it was resolved; the winner is the
//! nation holding the most of them (the owner's rule, read per window);
//! shares and claims are the legacy pool's (SetShares, Claim, WithdrawOps,
//! RecordNation, unchanged). After a claim window, Sweep moves what is
//! left of the prize into a later epoch's open pool, so no deposit stays
//! in a vault for good.
//!
//! | tag | instruction | accounts |
//! |---|---|---|
//! | 8 | InitEpochPool(epoch u32, end_bell u32, claim_bells u32, fee u64, ops_bps u16, params_hash 32) | as InitPool, `[pool]` = the epoch pool |
//! | 9 | EpochTally | `[pool w] [season] [province]…` |
//! | 10 | EpochFinalize | `[pool w] [season] [province fund]×6` |
//! | 11 | Sweep | `[pool w] [vault w] [next pool w] [next vault w] [mint] [token]` |
//!
//! **Snapshot without a freeze.** The world keeps resolving bells after
//! `end_bell`, so a keep may change holder before EpochTally reads it.
//! The game writes `since_bell = b + 1` when a keep is taken in bell `b`
//! (permutation-rules `frontier/keep.rs`). A Province is read once every
//! bell before `end_bell` is resolved (`resolved_next ≥ end_bell`); its
//! holder is the holder at `end_bell` exactly when `since_bell ≤ end_bell`.
//! PROVISIONAL (`provisional::VOID_AFTER_CLOSE`): a keep taken after the
//! window closed (`since_bell > end_bell`) is counted for nobody. The
//! stack's crank tallies each Province within a bell of the close, so this
//! is the rare case, not the rule.
//!
//! DECIDED (owner, 2026-11-18 21:44 JST, t353u; `decided::TIE_EQUAL_SPLIT`): a tie for first place is
//! shared equally. The legacy tie break reads cumulative territory bells,
//! which in a live world depend on when the tally runs.

use solana_program::{
    account_info::AccountInfo, instruction::AccountMeta, instruction::Instruction, msg,
    program::invoke, program_error::ProgramError, pubkey::Pubkey, sysvar::Sysvar,
};

use super::*;

/// Present in the `.so` only when built with feature `epochs`
/// (`scripts/build-prize.sh --features epochs` requires it; the default
/// build and the devnet profile's default refuse it).
pub const MARKER: &[u8] = b"PRZ_EPOCHS_TEST_USDC_BUILD";

/// Rules of epoch pools the owner decided on 2026-11-18 21:44 JST (t353u,
/// "keep the current defaults"; devnet/local test USDC only, mainnet needs a
/// legal review).
pub mod decided {
    pub const PER_EPOCH_ENTRY: &str =
        "epoch: an entry is per window; only a wallet that paid into this epoch's pool can claim from it";
    pub const ROLLOVER: &str = "epoch: after the claim window, the unclaimed prize (and rounding dust) moves to a later epoch's open pool (Sweep); the operator's part is unaffected";
    pub const TIE_EQUAL_SPLIT: &str =
        "epoch: a tie for first place is shared equally (no territory-bell tie break)";
    pub const RING_17: &str = "epoch: the prize covers maps up to ring 17 only (InitEpochPool refuses a larger r_max or r_max_ceiling)";
    pub const NO_OPERATOR_AI: &str = "epoch: no AI residents in paid periods: a wallet the season's join gate marked as an operator member (ExcludeWallet) can neither Pay nor Claim";
    pub const RULES: [&str; 5] = [
        PER_EPOCH_ENTRY,
        ROLLOVER,
        TIE_EQUAL_SPLIT,
        RING_17,
        NO_OPERATOR_AI,
    ];
}

/// Rules of epoch pools still undecided by the owner (listed by the tooling
/// next to [`super::provisional::RULES`]).
pub mod provisional {
    pub const VOID_AFTER_CLOSE: &str = "epoch: a keep taken after the window's end bell (since_bell > end_bell) before it was tallied counts for nobody";
    pub const RULES: [&str; 1] = [VOID_AFTER_CLOSE];
}

/// The end of an epoch pool's window, in unix seconds.
fn end_ts(pd: &[u8]) -> R<i64> {
    let genesis = i64::from_le_bytes(rd(pd, pool::EPOCH_GENESIS_TS)?);
    let secs = u32_at(pd, pool::EPOCH_BELL_SECS)? as i64;
    let end = u32_at(pd, pool::END_BELL)? as i64;
    genesis
        .checked_add(end.checked_mul(secs).ok_or(E::Overflow)?)
        .ok_or(E::Overflow.into())
}

/// Pay into an epoch pool: only before its end bell's time.
pub(crate) fn pay_open(pd: &[u8], now_ts: i64) -> R<()> {
    if now_ts >= end_ts(pd)? {
        return Err(E::EpochClosed.into());
    }
    Ok(())
}

/// ⑰ owner decision 2026-11-18 21:44 (t353u): no AI residents in paid
/// periods. Operator AI residents and script bots join a gated season by
/// invite, with the season's join-gate key; only that key can mark a wallet
/// here, and an epoch pool's Pay and Claim refuse a marked wallet
/// (`OperatorMember`). PDA `["noprize", game, le64(season), wallet]`.
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

/// Pay and Claim in an epoch pool: `ai` is the wallet's exclusion address
/// in the pool's season, and nothing is there.
pub(crate) fn not_excluded(
    program: &Pubkey,
    pd: &[u8],
    wallet: &Pubkey,
    ai: &AccountInfo,
) -> R<()> {
    let game = key_at(pd, pool::GAME_PROGRAM)?;
    let sid = u64_at(pd, pool::SEASON_ID)?;
    if exclusion_address(program, &game, sid, wallet).0 != *ai.key {
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
/// of the season: no Pay and no Claim in any epoch pool of it. Repeating it
/// is a no-op; nothing removes a mark.
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

/// The season may hold epoch pools: a continuous S1 world, running.
fn continuous_running(sd: &[u8], now_ts: i64) -> R<()> {
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

fn epoch_pool_of(program: &Pubkey, ai: &AccountInfo) -> R<()> {
    pool_of(program, ai)?;
    if !is_epoch_pool(&ai.try_borrow_data()?) {
        return Err(E::WrongState.into());
    }
    Ok(())
}

/// 8 InitEpochPool: the season's authority opens settlement window
/// `epoch`, ending at `end_bell` (a bell still in the future).
pub(crate) fn init_epoch_pool(program: &Pubkey, a: &[AccountInfo], d: &[u8]) -> R<()> {
    let [operator, pool_ai, vault, mint, season, game, token, system] = a else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    if d.len() != 4 + 4 + 4 + 8 + 2 + 32 {
        return Err(E::BadData.into());
    }
    let epoch = u32_at(d, 0)?;
    let end_bell = u32_at(d, 4)?;
    let claim_bells = u32_at(d, 8)?;
    let fee = u64_at(d, 12)?;
    let ops_bps = u16_at(d, 20)?;
    let params_hash: [u8; 32] = rd(d, 22)?;
    if fee == 0 || ops_bps > MAX_OPS_BPS || end_bell == 0 || claim_bells == 0 {
        return Err(E::BadParams.into());
    }
    if !operator.is_signer || *token.key != TOKEN_PROGRAM || *system.key != SYSTEM_PROGRAM {
        return Err(E::BadAccount.into());
    }
    let now = solana_program::clock::Clock::get()?.unix_timestamp;
    let (sid, bell_secs, genesis_ts) = {
        let sd = season.try_borrow_data()?;
        if season.owner != game.key || sd.len() != S::SIZE || sd[..8] != S::MAGIC {
            return Err(E::BadAccount.into());
        }
        if key_at(&sd, S::AUTHORITY)? != *operator.key {
            return Err(E::NotOperator.into());
        }
        continuous_running(&sd, now)?;
        season_rings_fit(&sd)?;
        (
            u64_at(&sd, S::SEASON_ID)?,
            u32_at(&sd, S::BELL_SECS)?,
            i64::from_le_bytes(rd(&sd, S::GENESIS_TS)?),
        )
    };
    // The window must still be open: nobody can pay into a closed one.
    let end = genesis_ts
        .checked_add(i64::from(end_bell) * i64::from(bell_secs))
        .ok_or(E::BadParams)?;
    if now >= end {
        return Err(E::EpochClosed.into());
    }
    let (season_pda, _) =
        Pubkey::find_program_address(&[S::PDA_PREFIX, &sid.to_le_bytes()], game.key);
    if season_pda != *season.key {
        return Err(E::BadAccount.into());
    }
    let decimals = {
        let md = mint.try_borrow_data()?;
        if *mint.owner != TOKEN_PROGRAM || md.len() != 82 {
            return Err(E::BadAccount.into());
        }
        md[44]
    };
    let sid_le = sid.to_le_bytes();
    let epoch_le = epoch.to_le_bytes();
    let (pool_key, bump) = epoch_pool_address(program, game.key, sid, epoch);
    let (vault_key, vault_bump) = vault_address(program, &pool_key);
    if pool_key != *pool_ai.key || vault_key != *vault.key {
        return Err(E::BadAccount.into());
    }
    create(
        operator,
        pool_ai,
        pool::SIZE,
        program,
        &[
            EPOCH_POOL_SEED,
            game.key.as_ref(),
            &sid_le,
            &epoch_le,
            &[bump],
        ],
    )?;
    create(
        operator,
        vault,
        165,
        &TOKEN_PROGRAM,
        &[VAULT_SEED, pool_key.as_ref(), &[vault_bump]],
    )?;
    let mut init = Vec::with_capacity(33);
    init.push(18); // SPL Token InitializeAccount3
    init.extend_from_slice(pool_key.as_ref());
    invoke(
        &Instruction {
            program_id: TOKEN_PROGRAM,
            accounts: vec![
                AccountMeta::new(*vault.key, false),
                AccountMeta::new_readonly(*mint.key, false),
            ],
            data: init,
        },
        &[vault.clone(), mint.clone()],
    )?;
    let mut pd = pool_ai.try_borrow_mut_data()?;
    put(&mut pd, pool::HDR_MAGIC, &pool::MAGIC)?;
    pd[pool::BUMP] = bump;
    pd[pool::VAULT_BUMP] = vault_bump;
    pd[pool::DECIMALS] = decimals;
    put(&mut pd, pool::SEASON_ID, &sid_le)?;
    put(&mut pd, pool::GAME_PROGRAM, game.key.as_ref())?;
    put(&mut pd, pool::SEASON, season.key.as_ref())?;
    put(&mut pd, pool::OPERATOR, operator.key.as_ref())?;
    put(&mut pd, pool::MINT, mint.key.as_ref())?;
    put(&mut pd, pool::VAULT, vault.key.as_ref())?;
    put(&mut pd, pool::FEE, &fee.to_le_bytes())?;
    put(&mut pd, pool::OPS_BPS, &ops_bps.to_le_bytes())?;
    put(&mut pd, pool::PARAMS_HASH, &params_hash)?;
    put(&mut pd, pool::END_BELL, &end_bell.to_le_bytes())?;
    put(&mut pd, pool::EPOCH, &epoch_le)?;
    put(&mut pd, pool::EPOCH_BELL_SECS, &bell_secs.to_le_bytes())?;
    put(&mut pd, pool::EPOCH_GENESIS_TS, &genesis_ts.to_le_bytes())?;
    put(&mut pd, pool::CLAIM_BELLS, &claim_bells.to_le_bytes())?;
    pd[pool::KIND] = pool::KIND_EPOCH;
    msg!(
        "PRIZE epoch init season={} epoch={} end_bell={} fee={} ops_bps={}",
        sid,
        epoch,
        end_bell,
        fee,
        ops_bps
    );
    Ok(())
}

/// The pool's season, checked: the game's Season at the recorded address,
/// still continuous.
fn checked_season(pd: &[u8], season: &AccountInfo) -> R<(Pubkey, u64)> {
    let game = key_at(pd, pool::GAME_PROGRAM)?;
    let sid = u64_at(pd, pool::SEASON_ID)?;
    if key_at(pd, pool::SEASON)? != *season.key {
        return Err(E::BadAccount.into());
    }
    game_account(season, &game, &S::MAGIC, S::SIZE, sid)?;
    Ok((game, sid))
}

/// 9 EpochTally: count Provinces as they stood at the window's end bell.
/// Anyone may send it, in as many transactions as needed.
pub(crate) fn epoch_tally(program: &Pubkey, a: &[AccountInfo]) -> R<()> {
    let [pool_ai, season, provinces @ ..] = a else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    epoch_pool_of(program, pool_ai)?;
    let mut pd = pool_ai.try_borrow_mut_data()?;
    if pd[pool::STATE] != pool::STATE_OPEN {
        return Err(E::WrongState.into());
    }
    let (game, sid) = checked_season(&pd, season)?;
    // Fees are taken until the end bell's time; nothing is counted before.
    if solana_program::clock::Clock::get()?.unix_timestamp < end_ts(&pd)? {
        return Err(E::WindowOpen.into());
    }
    let end_bell = u32_at(&pd, pool::END_BELL)?;
    let ctx = AddrCtx {
        season: season.key.to_bytes(),
        program: game.to_bytes(),
    };
    let mut counted = u16_at(&pd, pool::COUNTED)?;
    for ai in provinces {
        game_account(ai, &game, &P::MAGIC, P::SIZE, sid)?;
        let d = ai.try_borrow_data()?;
        let p = i16::from_le_bytes(rd(&d, P::P)?) as i32;
        let q = i16::from_le_bytes(rd(&d, P::Q)?) as i32;
        if ctx.province(p, q) != ai.key.to_bytes() {
            return Err(E::BadAccount.into());
        }
        if d[P::KEEP + K::TILE] == K::NO_TILE {
            return Err(E::NoKeep.into());
        }
        // Opened at or after the end bell: not on the map at the end.
        let after_end = u32_at(&d, P::OPENED_BELL)? >= end_bell;
        if !after_end && u32_at(&d, P::RESOLVED_NEXT)? < end_bell {
            return Err(E::ProvinceNotFinal.into());
        }
        let i = province_index(p, q)
            .filter(|i| *i < MAX_PROVINCES)
            .ok_or(E::BadAccount)? as usize;
        let (byte, bit) = (pool::BITMAP + i / 8, 1u8 << (i % 8));
        if pd[byte] & bit != 0 {
            continue;
        }
        pd[byte] |= bit;
        counted = counted.checked_add(1).ok_or(E::Overflow)?;
        // Taken in bell b sets since_bell = b + 1: since_bell ≤ end_bell is
        // the holder at the end; later, a capture after the close (void).
        if after_end || u32_at(&d, P::KEEP + K::SINCE_BELL)? > end_bell {
            continue;
        }
        let holder = d[P::KEEP + K::HOLDER] as usize;
        if holder < FACTIONS {
            let off = pool::AREA + 2 * holder;
            let v = u16_at(&pd, off)?.checked_add(1).ok_or(E::Overflow)?;
            put(&mut pd, off, &v.to_le_bytes())?;
        }
    }
    put(&mut pd, pool::COUNTED, &counted.to_le_bytes())?;
    msg!("PRIZE epoch tally counted={}", counted);
    Ok(())
}

/// 10 EpochFinalize: every keep on the map is counted (the game's own
/// count, as legacy Finalize); the nations with the most provinces win, a
/// tie shared. Opens the claim window.
pub(crate) fn epoch_finalize(program: &Pubkey, a: &[AccountInfo]) -> R<()> {
    let [pool_ai, season, funds @ ..] = a else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    if funds.len() != PF::WEDGES {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    epoch_pool_of(program, pool_ai)?;
    let mut pd = pool_ai.try_borrow_mut_data()?;
    if pd[pool::STATE] != pool::STATE_OPEN {
        return Err(E::WrongState.into());
    }
    let (game, sid) = checked_season(&pd, season)?;
    let now = solana_program::clock::Clock::get()?.unix_timestamp;
    // Before the window's time is over, more fees may still come in.
    if now < end_ts(&pd)? {
        return Err(E::WindowOpen.into());
    }
    let ctx = AddrCtx {
        season: season.key.to_bytes(),
        program: game.to_bytes(),
    };
    let mut opened = 0u32;
    for (w, ai) in funds.iter().enumerate() {
        game_account(ai, &game, &PF::MAGIC, PF::SIZE, sid)?;
        if ctx.province_fund(w as u8) != ai.key.to_bytes() {
            return Err(E::BadAccount.into());
        }
        let n = u32_at(&ai.try_borrow_data()?, PF::PROVINCES_OPENED)?;
        opened = opened.checked_add(n).ok_or(E::Overflow)?;
    }
    let keeps = opened.saturating_sub(KEEPLESS_PROVINCES);
    let counted = u16_at(&pd, pool::COUNTED)? as u32;
    if counted < keeps {
        return Err(E::TallyIncomplete.into());
    }
    if counted != keeps {
        return Err(E::WrongExpectedCount.into());
    }
    let mut area = [0u16; FACTIONS];
    for (f, a) in area.iter_mut().enumerate() {
        *a = u16_at(&pd, pool::AREA + 2 * f)?;
    }
    let w = largest_area(&area);
    pd[pool::WINNERS] = w;
    pd[pool::STATE] = pool::STATE_FINAL;
    let window =
        i64::from(u32_at(&pd, pool::CLAIM_BELLS)?) * i64::from(u32_at(&pd, pool::EPOCH_BELL_SECS)?);
    let deadline = now.checked_add(window).ok_or(E::Overflow)?;
    put(&mut pd, pool::DEADLINE_TS, &deadline.to_le_bytes())?;
    msg!(
        "PRIZE epoch final winners_mask={} area={:?} deadline={}",
        w,
        area,
        deadline
    );
    Ok(())
}

/// 11 Sweep: after the claim window, anyone moves the unclaimed prize of a
/// finalized epoch pool into a later epoch's pool that still takes fees
/// (same game, season and mint). Claims on the swept pool close; the
/// operator's part stays for WithdrawOps.
pub(crate) fn sweep(program: &Pubkey, a: &[AccountInfo]) -> R<()> {
    let [pool_ai, vault, next_ai, next_vault, mint, token] = a else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    if *token.key != TOKEN_PROGRAM || pool_ai.key == next_ai.key {
        return Err(E::BadAccount.into());
    }
    epoch_pool_of(program, pool_ai)?;
    epoch_pool_of(program, next_ai)?;
    let now = solana_program::clock::Clock::get()?.unix_timestamp;
    let mut pd = pool_ai.try_borrow_mut_data()?;
    let mut nd = next_ai.try_borrow_mut_data()?;
    if !matches!(pd[pool::STATE], pool::STATE_FINAL | pool::STATE_SHARES) {
        return Err(E::WrongState.into());
    }
    if now < i64::from_le_bytes(rd(&pd, pool::DEADLINE_TS)?) {
        return Err(E::ClaimWindowOpen.into());
    }
    if key_at(&pd, pool::VAULT)? != *vault.key
        || key_at(&pd, pool::MINT)? != *mint.key
        || key_at(&nd, pool::VAULT)? != *next_vault.key
        || key_at(&nd, pool::MINT)? != *mint.key
        || key_at(&nd, pool::GAME_PROGRAM)? != key_at(&pd, pool::GAME_PROGRAM)?
        || key_at(&nd, pool::SEASON)? != key_at(&pd, pool::SEASON)?
        || u32_at(&nd, pool::EPOCH)? <= u32_at(&pd, pool::EPOCH)?
    {
        return Err(E::BadAccount.into());
    }
    // The next pool must still take fees, so its prize is not yet split.
    if nd[pool::STATE] != pool::STATE_OPEN
        || u16_at(&nd, pool::COUNTED)? != 0
        || now >= end_ts(&nd)?
    {
        return Err(E::WrongState.into());
    }
    let amount = u64_at(&pd, pool::PRIZE)?
        .checked_sub(u64_at(&pd, pool::CLAIMED)?)
        .ok_or(E::Overflow)?;
    put(&mut pd, pool::ROLLED_OUT, &amount.to_le_bytes())?;
    pd[pool::STATE] = pool::STATE_SWEPT;
    let v = add(u64_at(&nd, pool::COLLECTED)?, amount)?;
    put(&mut nd, pool::COLLECTED, &v.to_le_bytes())?;
    let v = add(u64_at(&nd, pool::PRIZE)?, amount)?;
    put(&mut nd, pool::PRIZE, &v.to_le_bytes())?;
    let signer = PoolSigner::of(&pd)?;
    let decimals = pd[pool::DECIMALS];
    let (from_epoch, to_epoch) = (u32_at(&pd, pool::EPOCH)?, u32_at(&nd, pool::EPOCH)?);
    drop(pd);
    drop(nd);
    if amount > 0 {
        token_transfer(
            vault,
            mint,
            next_vault,
            pool_ai,
            amount,
            decimals,
            Some(&signer.seeds()),
        )?;
    }
    msg!(
        "PRIZE sweep epoch={} -> {} amount={}",
        from_epoch,
        to_epoch,
        amount
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pool_with(end_bell: u32, secs: u32, genesis: i64) -> Vec<u8> {
        let mut d = vec![0u8; pool::SIZE];
        d[pool::END_BELL..pool::END_BELL + 4].copy_from_slice(&end_bell.to_le_bytes());
        d[pool::EPOCH_BELL_SECS..pool::EPOCH_BELL_SECS + 4].copy_from_slice(&secs.to_le_bytes());
        d[pool::EPOCH_GENESIS_TS..pool::EPOCH_GENESIS_TS + 8]
            .copy_from_slice(&genesis.to_le_bytes());
        d
    }

    #[test]
    fn pay_closes_at_the_end_bell() {
        let d = pool_with(10, 600, 1_000);
        assert_eq!(pay_open(&d, 1_000 + 5_999), Ok(()));
        assert_eq!(pay_open(&d, 1_000 + 6_000), Err(E::EpochClosed.into()));
    }

    #[test]
    fn the_tail_fits_the_legacy_pool() {
        assert_eq!(pool::BITMAP + pool::BITMAP_LEN, pool::EPOCH);
        const _: () = assert!(pool::ROLLED_OUT + 8 <= pool::SIZE);
        const _: () = assert!(pool::KIND < pool::DEADLINE_TS);
        let mut d = vec![0u8; pool::SIZE];
        assert!(!is_epoch_pool(&d));
        d[pool::KIND] = pool::KIND_EPOCH;
        assert!(is_epoch_pool(&d));
    }

    #[test]
    fn epoch_pools_need_a_running_continuous_world() {
        let at = frontier_abi::v2::presets::SEASON_CQ_OFFSET
            + frontier_abi::v2::presets::cq_layout::CONTINUOUS;
        let mut s = vec![0u8; S::SIZE];
        s[S::STATUS] = S::STATUS_RUNNING;
        s[S::BELL_SECS..S::BELL_SECS + 4].copy_from_slice(&600u32.to_le_bytes());
        assert_eq!(continuous_running(&s, 0), Err(E::FiniteSeason.into()));
        s[at] = 1;
        assert_eq!(continuous_running(&s, 0), Ok(()));
        s[at] = 2;
        assert_eq!(continuous_running(&s, 0), Err(E::BadAccount.into()));
        s[at] = 1;
        s[S::STATUS] = S::STATUS_ENDED;
        assert_eq!(continuous_running(&s, 0), Err(E::WrongState.into()));
        s[S::STATUS] = S::STATUS_SEEDED;
        s[S::GENESIS_TS..S::GENESIS_TS + 8].copy_from_slice(&5i64.to_le_bytes());
        assert_eq!(continuous_running(&s, 4), Err(E::WrongState.into()));
        assert_eq!(continuous_running(&s, 5), Ok(()));
        s[S::BELL_SECS..S::BELL_SECS + 4].copy_from_slice(&0u32.to_le_bytes());
        assert_eq!(continuous_running(&s, 5), Err(E::BadParams.into()));
    }
}
