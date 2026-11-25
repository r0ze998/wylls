//! World goals' prize pool (feature `goals`; TEST USDC, localnet and devnet
//! only — design record `docs/design/win-conditions/01-proposal.ja.md`
//! §7 and §10.1, owner r0ze 2026-11-24 00:21 t481u and 01:04 t485u).
//!
//! A continuous world has no end, and the goals have no deadline: a goal is
//! posted, stays until a nation achieves it, pays a part of its kind's
//! treasury to that nation's contributors and is followed by the next round.
//! Nothing here reads a season end or an end bell, and no province bitmap
//! limits the map (Q18: `RING_17` lifted — a flag keep may be on any ring).
//!
//! | tag | instruction | accounts |
//! |---|---|---|
//! | 13 | InitGoalPool(params, see [`init_data`]) | `[operator s,w] [gpool w] [vault w] [mint] [season] [game program] [token] [system]` |
//! | 14 | BuyPass | `[wallet s] [payer s,w] [gpool w] [pass w] [wallet token w] [vault w] [mint] [token] [system] [exclusion]` |
//! | 15 | PostGoal(kind u8, round u32, need u8, hold_bells u32, payout_bps u16, posting_hash 32, n u8, (p i16, q i16)×n) | `[operator s,w] [gpool w] [goal w] [season] [system]` |
//! | 16 | Achieve | `[goal w] [gpool w] [season] [province]×n` (the posted flags, in order) |
//! | 17 | AttestAchieve(winners u8, achieved_bell u32, evidence_hash 32) | `[operator s] [goal w] [gpool w] [season]` |
//! | 18 | VoidGoal | `[operator s] [goal w] [gpool w]` |
//! | 19 | SetGoalShares(mode u8, total_points [u64;6], root 32, ledger_hash 32) | `[operator s] [goal w] [gpool w]` |
//! | 20 | GoalClaim(nation u8, points u64, n u8, proof 32×n) | `[wallet s,w] [goal w] [gpool w] [pass] [receipt w] [citizen] [exclusion] [vault w] [wallet token w] [mint] [token] [system]` |
//! | 21 | GoalSweep | `[goal w] [gpool w]` |
//! | 22 | RetireGoal | `[operator s] [goal w] [gpool w]` |
//! | 23 | GoalWithdrawOps | `[operator s] [gpool w] [vault w] [operator token w] [mint] [token]` |
//!
//! **Money in (§7.1, Q13 E2).** A wallet buys a 30-day pass (BuyPass); the
//! fee goes into the goal pool's one vault: `ops_bps` (20%) is the
//! operator's, the rest is split into the four kinds' treasuries by
//! `kind_bps` (40/20/20/20). A kind no goal has been posted for yet sends
//! its part to hegemony (§7.2 "まだ作っていない種類の分は、作るまで覇権に回す").
//! The treasuries are counters over the one vault.
//!
//! **Achievement (P1, P8).** Hegemony (kind 0, flag keeps) is judged on
//! chain by [`achieve`], from the game's Province accounts alone — the
//! judge of PR #198 (`world-goals.mjs`): a flag keep held by nation `n`
//! counts from `max(since_bell, posted_bell)` and is held long at that bell
//! plus `hold_bells`; the nation reaches the goal at the bell its `need`-th
//! keep is held long; the earliest such bell wins, nations at the same bell
//! tie. The other kinds have no chain record yet (P8): the operator posts
//! the winners and an evidence hash (AttestAchieve) and SetGoalShares waits
//! `dispute_secs`, during which the operator may VoidGoal it.
//!
//! **Payout (P4, §7.2).** At the achievement, `payout = treasury[kind] ×
//! payout_bps` (fixed when the goal was posted) leaves the treasury; the
//! rest stays for the next round.
//!
//! **Shares (P5, §7.3 (a)).** Per goal: the operator posts a merkle root
//! over `(wallet, nation, points)` (the legacy [`crate::leaf`], keyed by the
//! goal's address) and the sha256 of the published ledger. A claim is
//! `share_amount(payout, winning nations, points, nation's total)`; a
//! winning nation with no eligible member leaves its part to the sweep.
//!
//! **Eligibility (§7.4, Q17, Q19).** GoalClaim checks on chain: the
//! wallet's pass was valid at the achievement bell's time; its Citizen is of
//! a winning nation and joined at least `member_bells` before the
//! achievement bell; it carries no operator-member mark (ExcludeWallet);
//! the amount is at least `min_payout`; the claim window is open; and the
//! wallet has no receipt yet (one receipt PDA per goal and wallet — a second
//! claim is refused). Operator AI points leave the totals in the ledger
//! (Q17 (b)); external AI residents are left out of it until the legal
//! review (Q7) — the chain cannot tell them from people.
//!
//! **Unclaimed (P7).** After `claim_secs`, GoalSweep returns what was not
//! claimed (and the rounding dust) to the kind's treasury. A goal with no
//! eligible member returns its payout at once (SetGoalShares mode RETURN).

use solana_program::{
    account_info::AccountInfo, instruction::AccountMeta, instruction::Instruction, msg,
    program::invoke, program_error::ProgramError, pubkey::Pubkey, sysvar::Sysvar,
};

use super::*;
use crate::member::{continuous_running, not_excluded};

/// Present in the `.so` only when built with feature `goals`
/// (`scripts/build-prize.sh --features goals` requires it; every other
/// build refuses it).
pub const MARKER: &[u8] = b"PRZ_GOALS_TEST_USDC_BUILD";

pub const GOAL_POOL_SEED: &[u8] = b"gpool";
pub const PASS_SEED: &[u8] = b"gpass";
pub const GOAL_SEED: &[u8] = b"goal";
pub const RECEIPT_SEED: &[u8] = b"gclaim";

/// The four kinds of goals (§4): hegemony (flag keeps), science, wonder,
/// exploration.
pub const KINDS: usize = 4;
pub const KIND_HEGEMONY: u8 = 0;
/// Most flag keeps a hegemony goal may post.
pub const MAX_FLAGS: usize = 32;

/// Circle's mainnet USDC mint: never a goal pool's asset (legal gate — a
/// real-money prize needs a legal review first, owner 2026-11-18 t351u).
pub const MAINNET_USDC: Pubkey =
    solana_program::pubkey!("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

/// Rules of goal pools as the owner decided them (design record §11,
/// 2026-11-24 00:21 t481u / 01:04 t485u).
pub mod decided {
    pub const NO_DEADLINE: &str =
        "goals: a goal has no deadline; it stays posted until a nation achieves it (Q2)";
    pub const PASS_30D: &str =
        "goals: money comes from 30-day passes, 80% prize / 20% operator (Q13 E2)";
    pub const KIND_TREASURIES: &str = "goals: one treasury per kind (initial 40/20/20/20); a kind not posted yet sends its part to hegemony; an achievement pays a fixed part of its kind's treasury (Q14)";
    pub const PROPORTIONAL: &str = "goals: inside a nation, in proportion to points (share_amount); ties between nations split equally first (Q15 a)";
    pub const NO_TREASURY: &str = "goals: no national treasury share (0%) (Q16)";
    pub const OPERATOR_AI_NO_MONEY: &str = "goals: operator AI residents count like people in the game, but a wallet marked by the join gate can neither buy a pass nor claim; their points leave the ledger's totals (Q17 b)";
    pub const ANY_RING: &str =
        "goals: flag keeps are read where they are posted, any ring (Q18: RING_17 lifted)";
    pub const ELIGIBILITY: &str = "goals: a claim needs a pass valid at the achievement and a Citizen of a winning nation joined at least 24 h (144 bells) before it (Q19)";
    pub const FLAG_KEEPS: &str = "goals: hegemony = hold `need` (half) of the posted flag keeps, each for `hold_bells` (24 h) (Q3, Q21)";
    pub const RULES: [&str; 9] = [
        NO_DEADLINE,
        PASS_30D,
        KIND_TREASURIES,
        PROPORTIONAL,
        NO_TREASURY,
        OPERATOR_AI_NO_MONEY,
        ANY_RING,
        ELIGIBILITY,
        FLAG_KEEPS,
    ];
}

/// Choices this program makes that the design record does not fix (listed
/// as owner questions in the run's report; the tooling prints them).
pub mod provisional {
    pub const HOLD_FROM_POSTING: &str = "goals: a flag keep's hold counts from max(since_bell, the bell the goal was posted) (PR #198 R1)";
    pub const READ_AT_ACHIEVE: &str = "goals: Achieve reads the keeps as they are when it is sent; a keep lost before Achieve was sent does not count (the crank sends it within a bell)";
    pub const MIN_PAYOUT_STAYS: &str = "goals: a share under min_payout is not paid; it returns to the kind's treasury with the unclaimed rest (PR #198 splitPrize)";
    pub const ATTESTED_KINDS: &str = "goals: science, wonder and exploration are attested by the operator (winners + evidence hash) with a dispute window before shares (P8, until the game records them)";
    pub const RETIRE_AFTER: &str = "goals: the operator may retire an unachieved goal only `retire_secs` (30 days) after posting it, to post an easier one (Q5)";
    pub const TWO_PASS_SPANS: &str = "goals: a pass remembers its current and its previous validity span; a claim is checked against either";
    pub const RULES: [&str; 6] = [
        HOLD_FROM_POSTING,
        READ_AT_ACHIEVE,
        MIN_PAYOUT_STAYS,
        ATTESTED_KINDS,
        RETIRE_AFTER,
        TWO_PASS_SPANS,
    ];
}

/// Goal pool (PDA `["gpool", game, le64(season)]`, 448 B). The season id
/// and the game program sit at the legacy pool's offsets.
pub mod gpool {
    pub const MAGIC: [u8; 8] = *b"WYPRGPOL";
    pub const SIZE: usize = 448;
    pub const BUMP: usize = 8;
    pub const VAULT_BUMP: usize = 9;
    pub const DECIMALS: usize = 10;
    /// Bit k: a goal of kind k has been posted (its part of fees is its own).
    pub const ENABLED: usize = 11;
    /// Bit k: a goal of kind k is posted and not yet achieved, retired or voided.
    pub const LIVE: usize = 12;
    pub const SEASON_ID: usize = 16;
    pub const GAME_PROGRAM: usize = 24;
    pub const SEASON: usize = 56;
    pub const OPERATOR: usize = 88;
    pub const MINT: usize = 120;
    pub const VAULT: usize = 152;
    pub const PASS_FEE: usize = 184;
    pub const OPS_BPS: usize = 192;
    pub const PASS_SECS: usize = 196;
    pub const CLAIM_SECS: usize = 200;
    pub const MEMBER_BELLS: usize = 204;
    pub const MIN_PAYOUT: usize = 208;
    pub const DISPUTE_SECS: usize = 216;
    pub const RETIRE_SECS: usize = 220;
    /// `[u16; 4]`, summing to 10,000.
    pub const KIND_BPS: usize = 224;
    pub const BELL_SECS: usize = 232;
    pub const GENESIS_TS: usize = 240;
    /// `[u64; 4]`.
    pub const TREASURY: usize = 248;
    pub const COLLECTED: usize = 280;
    pub const OPS: usize = 288;
    pub const OPS_WITHDRAWN: usize = 296;
    /// Total paid out by GoalClaim.
    pub const PAID: usize = 304;
    /// Total returned to the treasuries (sweeps, RETURN, voids).
    pub const RETURNED: usize = 312;
    pub const PASSES: usize = 320;
    /// `[u32; 4]`: the round the next PostGoal of each kind must carry.
    pub const NEXT_ROUND: usize = 324;
    pub const PARAMS_HASH: usize = 340;
    pub const END: usize = 372;
}

/// A wallet's pass (PDA `["gpass", gpool, wallet]`, 96 B).
pub mod pass {
    pub const MAGIC: [u8; 8] = *b"WYPRGPAS";
    pub const SIZE: usize = 96;
    pub const BUMP: usize = 8;
    pub const WALLET: usize = 16;
    pub const VALID_FROM: usize = 48;
    pub const VALID_UNTIL: usize = 56;
    pub const PREV_FROM: usize = 64;
    pub const PREV_UNTIL: usize = 72;
    pub const PAID: usize = 80;
    pub const COUNT: usize = 88;
}

/// A goal (PDA `["goal", gpool, kind, le32(round)]`, 448 B).
pub mod goal {
    pub const MAGIC: [u8; 8] = *b"WYPRGOAL";
    pub const SIZE: usize = 448;
    pub const BUMP: usize = 8;
    pub const KIND: usize = 9;
    pub const STATE: usize = 10;
    pub const WINNERS: usize = 11;
    pub const MODE: usize = 12;
    pub const SHARE_NATIONS: usize = 13;
    pub const NEED: usize = 14;
    pub const FLAGS_N: usize = 15;
    pub const ROUND: usize = 16;
    pub const HOLD_BELLS: usize = 20;
    pub const POSTED_BELL: usize = 24;
    pub const ACHIEVED_BELL: usize = 28;
    pub const GPOOL: usize = 32;
    pub const POSTING_HASH: usize = 64;
    pub const PAYOUT_BPS: usize = 96;
    /// [`JUDGE_CHAIN`] or [`JUDGE_ATTESTED`].
    pub const JUDGE: usize = 98;
    pub const POSTED_TS: usize = 104;
    /// The achievement bell's time (`genesis + bell × bell_secs`).
    pub const ACHIEVED_TS: usize = 112;
    /// SetGoalShares is open from here (the end of the dispute window).
    pub const SHARES_OPEN_TS: usize = 120;
    /// GoalClaim closes and GoalSweep opens here.
    pub const DEADLINE_TS: usize = 128;
    pub const PAYOUT: usize = 136;
    pub const CLAIMED: usize = 144;
    pub const CLAIMS: usize = 152;
    pub const RETURNED: usize = 160;
    pub const TOTAL_POINTS: usize = 168;
    pub const ROOT: usize = 216;
    pub const LEDGER_HASH: usize = 248;
    pub const EVIDENCE_HASH: usize = 280;
    /// `(p i16, q i16) × MAX_FLAGS`.
    pub const FLAGS: usize = 312;
    pub const END: usize = FLAGS + 4 * super::MAX_FLAGS;

    pub const JUDGE_CHAIN: u8 = 0;
    pub const JUDGE_ATTESTED: u8 = 1;

    pub const STATE_POSTED: u8 = 1;
    pub const STATE_ACHIEVED: u8 = 2;
    pub const STATE_SHARES: u8 = 3;
    /// Swept, returned (no eligible member), voided or retired: nothing more.
    pub const STATE_CLOSED: u8 = 4;

    pub const MODE_SHARES: u8 = 1;
    /// No eligible member: the payout returns to the kind's treasury.
    pub const MODE_RETURN: u8 = 2;
}

/// A claim's receipt (PDA `["gclaim", goal, wallet]`, 56 B): its existence
/// refuses a second claim.
pub mod receipt {
    pub const MAGIC: [u8; 8] = *b"WYPRGRCP";
    pub const SIZE: usize = 56;
    pub const WALLET: usize = 8;
    pub const AMOUNT: usize = 40;
    pub const POINTS: usize = 48;
}

pub fn goal_pool_address(program: &Pubkey, game: &Pubkey, season_id: u64) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[GOAL_POOL_SEED, game.as_ref(), &season_id.to_le_bytes()],
        program,
    )
}
pub fn pass_address(program: &Pubkey, gpool: &Pubkey, wallet: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[PASS_SEED, gpool.as_ref(), wallet.as_ref()], program)
}
pub fn goal_address(program: &Pubkey, gpool: &Pubkey, kind: u8, round: u32) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[GOAL_SEED, gpool.as_ref(), &[kind], &round.to_le_bytes()],
        program,
    )
}
pub fn receipt_address(program: &Pubkey, goal: &Pubkey, wallet: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[RECEIPT_SEED, goal.as_ref(), wallet.as_ref()], program)
}

// ------------------------------------------------------------------ pure rules

/// The parameters of InitGoalPool.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Params {
    pub pass_fee: u64,
    pub ops_bps: u16,
    pub pass_secs: u32,
    pub claim_secs: u32,
    pub member_bells: u32,
    pub dispute_secs: u32,
    pub retire_secs: u32,
    pub min_payout: u64,
    pub kind_bps: [u16; KINDS],
    pub params_hash: [u8; 32],
}

impl Params {
    /// The design record's initial values (§7.1–§7.4, Q13/Q14/Q19, Q5) for
    /// a 6-decimal test mint: a 25 test USDC pass (⑰ owner default) of 30 days, 80/20, kinds
    /// 40/20/20/20, claims for 14 days, 24 h membership, 0.01 minimum, a 3-day
    /// dispute window, retire after 30 days.
    pub const fn recommended(params_hash: [u8; 32]) -> Params {
        Params {
            pass_fee: 25_000_000,
            ops_bps: 2_000,
            pass_secs: 30 * 86_400,
            claim_secs: 14 * 86_400,
            member_bells: 144,
            dispute_secs: 3 * 86_400,
            retire_secs: 30 * 86_400,
            min_payout: 10_000,
            kind_bps: [4_000, 2_000, 2_000, 2_000],
            params_hash,
        }
    }
}

pub const INIT_DATA_LEN: usize = 8 + 2 + 4 * 5 + 8 + 2 * KINDS + 32;

/// InitGoalPool's data (after the tag).
pub fn init_data(p: &Params) -> Vec<u8> {
    let mut d = Vec::with_capacity(INIT_DATA_LEN);
    d.extend_from_slice(&p.pass_fee.to_le_bytes());
    d.extend_from_slice(&p.ops_bps.to_le_bytes());
    for v in [
        p.pass_secs,
        p.claim_secs,
        p.member_bells,
        p.dispute_secs,
        p.retire_secs,
    ] {
        d.extend_from_slice(&v.to_le_bytes());
    }
    d.extend_from_slice(&p.min_payout.to_le_bytes());
    for b in p.kind_bps {
        d.extend_from_slice(&b.to_le_bytes());
    }
    d.extend_from_slice(&p.params_hash);
    d
}

/// Parses and checks InitGoalPool's data.
pub fn parse_init(d: &[u8]) -> R<Params> {
    if d.len() != INIT_DATA_LEN {
        return Err(E::BadData.into());
    }
    let mut kind_bps = [0u16; KINDS];
    for (k, b) in kind_bps.iter_mut().enumerate() {
        *b = u16_at(d, 38 + 2 * k)?;
    }
    let p = Params {
        pass_fee: u64_at(d, 0)?,
        ops_bps: u16_at(d, 8)?,
        pass_secs: u32_at(d, 10)?,
        claim_secs: u32_at(d, 14)?,
        member_bells: u32_at(d, 18)?,
        dispute_secs: u32_at(d, 22)?,
        retire_secs: u32_at(d, 26)?,
        min_payout: u64_at(d, 30)?,
        kind_bps,
        params_hash: rd(d, 38 + 2 * KINDS)?,
    };
    let bps: u32 = p.kind_bps.iter().map(|b| *b as u32).sum();
    if p.pass_fee == 0
        || p.ops_bps > MAX_OPS_BPS
        || p.pass_secs == 0
        || p.claim_secs == 0
        || bps != 10_000
    {
        return Err(E::BadParams.into());
    }
    Ok(p)
}

/// The prize part of a fee into the kinds' treasuries: `kind_bps` of the
/// kinds `enabled` (bit k); a kind not enabled and the rounding dust go to
/// hegemony. The parts sum to `prize`.
pub fn split_into_kinds(prize: u64, kind_bps: &[u16; KINDS], enabled: u8) -> [u64; KINDS] {
    let mut out = [0u64; KINDS];
    let mut given = 0u64;
    for k in 1..KINDS {
        if enabled & (1 << k) != 0 {
            out[k] = (prize as u128 * kind_bps[k] as u128 / 10_000) as u64;
            given += out[k];
        }
    }
    out[0] = prize - given;
    out
}

/// A pass bought at `now`: still valid → extended; lapsed (or new) → a new
/// span from now, the old one kept as the previous span. Returns
/// `(from, until, prev_from, prev_until)`.
pub fn renew(span: (i64, i64), prev: (i64, i64), now: i64, secs: u32) -> R<(i64, i64, i64, i64)> {
    let (from, until) = span;
    if until > now {
        let u = until.checked_add(secs as i64).ok_or(E::Overflow)?;
        Ok((from, u, prev.0, prev.1))
    } else {
        let u = now.checked_add(secs as i64).ok_or(E::Overflow)?;
        let (pf, pu) = if until > 0 { (from, until) } else { prev };
        Ok((now, u, pf, pu))
    }
}

/// Whether a pass with these spans was valid at `at`.
pub fn valid_at(span: (i64, i64), prev: (i64, i64), at: i64) -> bool {
    (span.0 <= at && at < span.1) || (prev.0 <= at && at < prev.1)
}

/// One flag keep as Achieve reads it: its holder, since_bell and the
/// province's `resolved_next`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FlagRead {
    pub holder: u8,
    pub since: u32,
    pub resolved_next: u32,
}

/// The flag-keeps judge (PR #198 `progressOf` + `achievementOf`, on chain).
/// Each held flag counts from `max(since, posted)` and is held long at that
/// plus `hold`; it is only taken as known when that bell is resolved in its
/// province (`long_at ≤ resolved_next`). A nation reaches the goal at its
/// `need`-th smallest `long_at`; the earliest bell wins, ties share. Returns
/// `(bell, winners mask)`; `NotAchieved` when no nation reaches it;
/// `ProvinceNotFinal` when some flag province has not resolved up to that
/// bell (a tie there could still be unseen).
pub fn judge_flags(flags: &[FlagRead], posted: u32, hold: u32, need: u8) -> R<(u32, u8)> {
    if need == 0 || need as usize > flags.len() {
        return Err(E::BadParams.into());
    }
    let mut reach = [u32::MAX; FACTIONS];
    for (n, r) in reach.iter_mut().enumerate() {
        let mut longs = [u32::MAX; MAX_FLAGS];
        let mut c = 0usize;
        for f in flags {
            if f.holder as usize != n {
                continue;
            }
            let long_at = f.since.max(posted).checked_add(hold).ok_or(E::Overflow)?;
            if long_at <= f.resolved_next && c < MAX_FLAGS {
                longs[c] = long_at;
                c += 1;
            }
        }
        if c >= need as usize {
            longs[..c].sort_unstable();
            *r = longs[need as usize - 1];
        }
    }
    let bell = *reach.iter().min().unwrap_or(&u32::MAX);
    if bell == u32::MAX {
        return Err(E::NotAchieved.into());
    }
    if flags.iter().any(|f| f.resolved_next < bell) {
        return Err(E::ProvinceNotFinal.into());
    }
    let winners = (0..FACTIONS)
        .filter(|&n| reach[n] == bell)
        .fold(0u8, |m, n| m | (1 << n));
    Ok((bell, winners))
}

/// The payout of an achievement: `treasury × payout_bps`, rounded down.
pub fn payout_of(treasury: u64, payout_bps: u16) -> u64 {
    (treasury as u128 * payout_bps as u128 / 10_000) as u64
}

/// The unix time of a bell of the season.
pub fn bell_ts(genesis_ts: i64, bell_secs: u32, bell: u32) -> R<i64> {
    genesis_ts
        .checked_add(bell as i64 * bell_secs as i64)
        .ok_or(E::Overflow.into())
}

/// The bell the season is in at `now` (0 before genesis).
pub fn bell_at(genesis_ts: i64, bell_secs: u32, now: i64) -> u32 {
    if bell_secs == 0 || now <= genesis_ts {
        return 0;
    }
    ((now - genesis_ts) / bell_secs as i64).min(u32::MAX as i64) as u32
}

// ------------------------------------------------------------------ accounts

fn gpool_of(program: &Pubkey, ai: &AccountInfo) -> R<()> {
    let d = ai.try_borrow_data()?;
    if ai.owner != program || d.len() != gpool::SIZE || d[..8] != gpool::MAGIC {
        return Err(E::BadAccount.into());
    }
    Ok(())
}

/// The goal, of this program and of `gpool`.
fn goal_of(program: &Pubkey, ai: &AccountInfo, gpool_key: &Pubkey) -> R<()> {
    let d = ai.try_borrow_data()?;
    if ai.owner != program
        || d.len() != goal::SIZE
        || d[..8] != goal::MAGIC
        || key_at(&d, goal::GPOOL)? != *gpool_key
    {
        return Err(E::BadAccount.into());
    }
    Ok(())
}

fn operator_of(pd: &[u8], operator: &AccountInfo) -> R<()> {
    if !operator.is_signer || key_at(pd, gpool::OPERATOR)? != *operator.key {
        return Err(E::NotOperator.into());
    }
    Ok(())
}

fn now() -> R<i64> {
    Ok(solana_program::clock::Clock::get()?.unix_timestamp)
}

fn add_at(d: &mut [u8], off: usize, v: u64) -> R<()> {
    let x = add(u64_at(d, off)?, v)?;
    put(d, off, &x.to_le_bytes())
}
fn sub_at(d: &mut [u8], off: usize, v: u64) -> R<()> {
    let x = u64_at(d, off)?.checked_sub(v).ok_or(E::Overflow)?;
    put(d, off, &x.to_le_bytes())
}

fn signer_seeds(pd: &[u8]) -> R<([u8; 32], [u8; 8], [u8; 1])> {
    Ok((
        rd(pd, gpool::GAME_PROGRAM)?,
        rd(pd, gpool::SEASON_ID)?,
        [pd[gpool::BUMP]],
    ))
}

// ------------------------------------------------------------------ instructions

/// 13 InitGoalPool: the season's authority opens the goal pool of a
/// running continuous world. One per season; no end bell, no ring limit.
pub(crate) fn init_goal_pool(program: &Pubkey, a: &[AccountInfo], d: &[u8]) -> R<()> {
    let [operator, gpool_ai, vault, mint, season, game, token, system] = a else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    let p = parse_init(d)?;
    if !operator.is_signer || *token.key != TOKEN_PROGRAM || *system.key != SYSTEM_PROGRAM {
        return Err(E::BadAccount.into());
    }
    if *mint.key == MAINNET_USDC {
        return Err(E::RealMoneyMint.into());
    }
    let now = now()?;
    let (sid, bell_secs, genesis_ts) = {
        let sd = season.try_borrow_data()?;
        if season.owner != game.key || sd.len() != S::SIZE || sd[..8] != S::MAGIC {
            return Err(E::BadAccount.into());
        }
        if key_at(&sd, S::AUTHORITY)? != *operator.key {
            return Err(E::NotOperator.into());
        }
        continuous_running(&sd, now)?;
        (
            u64_at(&sd, S::SEASON_ID)?,
            u32_at(&sd, S::BELL_SECS)?,
            i64::from_le_bytes(rd(&sd, S::GENESIS_TS)?),
        )
    };
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
    let (key, bump) = goal_pool_address(program, game.key, sid);
    let (vault_key, vault_bump) = vault_address(program, &key);
    if key != *gpool_ai.key || vault_key != *vault.key {
        return Err(E::BadAccount.into());
    }
    create(
        operator,
        gpool_ai,
        gpool::SIZE,
        program,
        &[GOAL_POOL_SEED, game.key.as_ref(), &sid_le, &[bump]],
    )?;
    create(
        operator,
        vault,
        165,
        &TOKEN_PROGRAM,
        &[VAULT_SEED, key.as_ref(), &[vault_bump]],
    )?;
    let mut init = Vec::with_capacity(33);
    init.push(18); // SPL Token InitializeAccount3
    init.extend_from_slice(key.as_ref());
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
    let mut pd = gpool_ai.try_borrow_mut_data()?;
    put(&mut pd, 0, &gpool::MAGIC)?;
    pd[gpool::BUMP] = bump;
    pd[gpool::VAULT_BUMP] = vault_bump;
    pd[gpool::DECIMALS] = decimals;
    pd[gpool::ENABLED] = 1 << KIND_HEGEMONY;
    put(&mut pd, gpool::SEASON_ID, &sid_le)?;
    put(&mut pd, gpool::GAME_PROGRAM, game.key.as_ref())?;
    put(&mut pd, gpool::SEASON, season.key.as_ref())?;
    put(&mut pd, gpool::OPERATOR, operator.key.as_ref())?;
    put(&mut pd, gpool::MINT, mint.key.as_ref())?;
    put(&mut pd, gpool::VAULT, vault.key.as_ref())?;
    put(&mut pd, gpool::PASS_FEE, &p.pass_fee.to_le_bytes())?;
    put(&mut pd, gpool::OPS_BPS, &p.ops_bps.to_le_bytes())?;
    put(&mut pd, gpool::PASS_SECS, &p.pass_secs.to_le_bytes())?;
    put(&mut pd, gpool::CLAIM_SECS, &p.claim_secs.to_le_bytes())?;
    put(&mut pd, gpool::MEMBER_BELLS, &p.member_bells.to_le_bytes())?;
    put(&mut pd, gpool::MIN_PAYOUT, &p.min_payout.to_le_bytes())?;
    put(&mut pd, gpool::DISPUTE_SECS, &p.dispute_secs.to_le_bytes())?;
    put(&mut pd, gpool::RETIRE_SECS, &p.retire_secs.to_le_bytes())?;
    for (k, b) in p.kind_bps.iter().enumerate() {
        put(&mut pd, gpool::KIND_BPS + 2 * k, &b.to_le_bytes())?;
    }
    put(&mut pd, gpool::BELL_SECS, &bell_secs.to_le_bytes())?;
    put(&mut pd, gpool::GENESIS_TS, &genesis_ts.to_le_bytes())?;
    for k in 0..KINDS {
        put(&mut pd, gpool::NEXT_ROUND + 4 * k, &1u32.to_le_bytes())?;
    }
    put(&mut pd, gpool::PARAMS_HASH, &p.params_hash)?;
    msg!(
        "PRIZE goals init season={} fee={} ops_bps={} pass_secs={}",
        sid,
        p.pass_fee,
        p.ops_bps,
        p.pass_secs
    );
    Ok(())
}

/// 14 BuyPass: a 30-day pass (E2). New or lapsed: valid from now for
/// `pass_secs`; still valid: extended by `pass_secs`. The fee is split
/// (operator, then kinds). A wallet the join gate marked is refused.
pub(crate) fn buy_pass(program: &Pubkey, a: &[AccountInfo]) -> R<()> {
    let [wallet, payer, gpool_ai, pass_ai, from, vault, mint, token, system, exclusion] = a else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    gpool_of(program, gpool_ai)?;
    if !wallet.is_signer
        || !payer.is_signer
        || *token.key != TOKEN_PROGRAM
        || *system.key != SYSTEM_PROGRAM
    {
        return Err(E::BadAccount.into());
    }
    let (fee, ops_bps, decimals, secs, kind_bps, enabled) = {
        let pd = gpool_ai.try_borrow_data()?;
        let game = key_at(&pd, gpool::GAME_PROGRAM)?;
        let sid = u64_at(&pd, gpool::SEASON_ID)?;
        not_excluded(program, &game, sid, wallet.key, exclusion)?;
        if key_at(&pd, gpool::VAULT)? != *vault.key || key_at(&pd, gpool::MINT)? != *mint.key {
            return Err(E::BadAccount.into());
        }
        let mut kb = [0u16; KINDS];
        for (k, b) in kb.iter_mut().enumerate() {
            *b = u16_at(&pd, gpool::KIND_BPS + 2 * k)?;
        }
        (
            u64_at(&pd, gpool::PASS_FEE)?,
            u16_at(&pd, gpool::OPS_BPS)?,
            pd[gpool::DECIMALS],
            u32_at(&pd, gpool::PASS_SECS)?,
            kb,
            pd[gpool::ENABLED],
        )
    };
    let (pass_key, bump) = pass_address(program, gpool_ai.key, wallet.key);
    if pass_key != *pass_ai.key {
        return Err(E::BadAccount.into());
    }
    token_transfer(from, mint, vault, wallet, fee, decimals, None)?;
    if pass_ai.data_is_empty() {
        create(
            payer,
            pass_ai,
            pass::SIZE,
            program,
            &[
                PASS_SEED,
                gpool_ai.key.as_ref(),
                wallet.key.as_ref(),
                &[bump],
            ],
        )?;
        let mut ed = pass_ai.try_borrow_mut_data()?;
        put(&mut ed, 0, &pass::MAGIC)?;
        ed[pass::BUMP] = bump;
        put(&mut ed, pass::WALLET, wallet.key.as_ref())?;
    }
    let now = now()?;
    let (vf, vu) = {
        let mut ed = pass_ai.try_borrow_mut_data()?;
        if pass_ai.owner != program
            || ed.len() != pass::SIZE
            || ed[..8] != pass::MAGIC
            || key_at(&ed, pass::WALLET)? != *wallet.key
        {
            return Err(E::BadAccount.into());
        }
        let span = (
            i64::from_le_bytes(rd(&ed, pass::VALID_FROM)?),
            i64::from_le_bytes(rd(&ed, pass::VALID_UNTIL)?),
        );
        let prev = (
            i64::from_le_bytes(rd(&ed, pass::PREV_FROM)?),
            i64::from_le_bytes(rd(&ed, pass::PREV_UNTIL)?),
        );
        let (f, u, pf, pu) = renew(span, prev, now, secs)?;
        put(&mut ed, pass::VALID_FROM, &f.to_le_bytes())?;
        put(&mut ed, pass::VALID_UNTIL, &u.to_le_bytes())?;
        put(&mut ed, pass::PREV_FROM, &pf.to_le_bytes())?;
        put(&mut ed, pass::PREV_UNTIL, &pu.to_le_bytes())?;
        add_at(&mut ed, pass::PAID, fee)?;
        let c = u32_at(&ed, pass::COUNT)?
            .checked_add(1)
            .ok_or(E::Overflow)?;
        put(&mut ed, pass::COUNT, &c.to_le_bytes())?;
        (f, u)
    };
    let ops = ops_part(fee, ops_bps);
    let parts = split_into_kinds(fee - ops, &kind_bps, enabled);
    let mut pd = gpool_ai.try_borrow_mut_data()?;
    add_at(&mut pd, gpool::COLLECTED, fee)?;
    add_at(&mut pd, gpool::OPS, ops)?;
    for (k, v) in parts.iter().enumerate() {
        add_at(&mut pd, gpool::TREASURY + 8 * k, *v)?;
    }
    let n = u32_at(&pd, gpool::PASSES)?
        .checked_add(1)
        .ok_or(E::Overflow)?;
    put(&mut pd, gpool::PASSES, &n.to_le_bytes())?;
    msg!(
        "PRIZE pass wallet={} fee={} valid={}..{} kinds={:?}",
        wallet.key,
        fee,
        vf,
        vu,
        parts
    );
    Ok(())
}

/// PostGoal's data: `kind, round, need, hold_bells, payout_bps,
/// posting_hash, n, flags`.
pub fn post_data(
    kind: u8,
    round: u32,
    need: u8,
    hold_bells: u32,
    payout_bps: u16,
    posting_hash: &[u8; 32],
    flags: &[(i16, i16)],
) -> Vec<u8> {
    let mut d = vec![kind];
    d.extend_from_slice(&round.to_le_bytes());
    d.push(need);
    d.extend_from_slice(&hold_bells.to_le_bytes());
    d.extend_from_slice(&payout_bps.to_le_bytes());
    d.extend_from_slice(posting_hash);
    d.push(flags.len() as u8);
    for (p, q) in flags {
        d.extend_from_slice(&p.to_le_bytes());
        d.extend_from_slice(&q.to_le_bytes());
    }
    d
}

/// 15 PostGoal: the operator posts round `round` of a kind (the pool's next
/// round of it; none of that kind live). Hegemony carries its flag keeps,
/// need and hold time (judged on chain); the other kinds carry none (judged
/// by attestation). The payout part is fixed here (§3.2: a posting never
/// changes).
pub(crate) fn post_goal(program: &Pubkey, a: &[AccountInfo], d: &[u8]) -> R<()> {
    let [operator, gpool_ai, goal_ai, season, system] = a else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    gpool_of(program, gpool_ai)?;
    if *system.key != SYSTEM_PROGRAM {
        return Err(E::BadAccount.into());
    }
    if d.len() < 45 {
        return Err(E::BadData.into());
    }
    let kind = d[0];
    let round = u32_at(d, 1)?;
    let need = d[5];
    let hold = u32_at(d, 6)?;
    let payout_bps = u16_at(d, 10)?;
    let posting_hash: [u8; 32] = rd(d, 12)?;
    let n = d[44] as usize;
    if d.len() != 45 + 4 * n {
        return Err(E::BadData.into());
    }
    let mut flags = [(0i16, 0i16); MAX_FLAGS];
    for (i, f) in flags.iter_mut().enumerate().take(n.min(MAX_FLAGS)) {
        *f = (
            i16::from_le_bytes(rd(d, 45 + 4 * i)?),
            i16::from_le_bytes(rd(d, 47 + 4 * i)?),
        );
    }
    if kind as usize >= KINDS || payout_bps == 0 || payout_bps > 10_000 {
        return Err(E::BadParams.into());
    }
    let judge = if kind == KIND_HEGEMONY {
        if n == 0 || n > MAX_FLAGS || need == 0 || need as usize > n || hold == 0 {
            return Err(E::BadParams.into());
        }
        for i in 0..n {
            if flags[..i].contains(&flags[i]) {
                return Err(E::BadParams.into());
            }
        }
        goal::JUDGE_CHAIN
    } else {
        if n != 0 || need != 0 || hold != 0 {
            return Err(E::BadParams.into());
        }
        goal::JUDGE_ATTESTED
    };
    let now = now()?;
    let mut pd = gpool_ai.try_borrow_mut_data()?;
    operator_of(&pd, operator)?;
    if key_at(&pd, gpool::SEASON)? != *season.key {
        return Err(E::BadAccount.into());
    }
    let game = key_at(&pd, gpool::GAME_PROGRAM)?;
    let sid = u64_at(&pd, gpool::SEASON_ID)?;
    game_account(season, &game, &S::MAGIC, S::SIZE, sid)?;
    continuous_running(&season.try_borrow_data()?, now)?;
    let next_off = gpool::NEXT_ROUND + 4 * kind as usize;
    if round != u32_at(&pd, next_off)? || pd[gpool::LIVE] & (1 << kind) != 0 {
        return Err(E::WrongState.into());
    }
    let (key, bump) = goal_address(program, gpool_ai.key, kind, round);
    if key != *goal_ai.key {
        return Err(E::BadAccount.into());
    }
    create(
        operator,
        goal_ai,
        goal::SIZE,
        program,
        &[
            GOAL_SEED,
            gpool_ai.key.as_ref(),
            &[kind],
            &round.to_le_bytes(),
            &[bump],
        ],
    )?;
    let posted_bell = bell_at(
        i64::from_le_bytes(rd(&pd, gpool::GENESIS_TS)?),
        u32_at(&pd, gpool::BELL_SECS)?,
        now,
    );
    let mut gd = goal_ai.try_borrow_mut_data()?;
    put(&mut gd, 0, &goal::MAGIC)?;
    gd[goal::BUMP] = bump;
    gd[goal::KIND] = kind;
    gd[goal::STATE] = goal::STATE_POSTED;
    gd[goal::NEED] = need;
    gd[goal::FLAGS_N] = n as u8;
    gd[goal::JUDGE] = judge;
    put(&mut gd, goal::ROUND, &round.to_le_bytes())?;
    put(&mut gd, goal::HOLD_BELLS, &hold.to_le_bytes())?;
    put(&mut gd, goal::POSTED_BELL, &posted_bell.to_le_bytes())?;
    put(&mut gd, goal::GPOOL, gpool_ai.key.as_ref())?;
    put(&mut gd, goal::POSTING_HASH, &posting_hash)?;
    put(&mut gd, goal::PAYOUT_BPS, &payout_bps.to_le_bytes())?;
    put(&mut gd, goal::POSTED_TS, &now.to_le_bytes())?;
    for (i, (p, q)) in flags.iter().enumerate().take(n) {
        put(&mut gd, goal::FLAGS + 4 * i, &p.to_le_bytes())?;
        put(&mut gd, goal::FLAGS + 4 * i + 2, &q.to_le_bytes())?;
    }
    pd[gpool::LIVE] |= 1 << kind;
    pd[gpool::ENABLED] |= 1 << kind;
    put(&mut pd, next_off, &(round + 1).to_le_bytes())?;
    msg!(
        "PRIZE goal post kind={} round={} need={} hold={} flags={} bell={}",
        kind,
        round,
        need,
        hold,
        n,
        posted_bell
    );
    Ok(())
}

/// The achievement's bookkeeping, shared by Achieve and AttestAchieve.
fn achieved(pd: &mut [u8], gd: &mut [u8], bell: u32, winners: u8, open_ts: i64) -> R<u64> {
    let kind = gd[goal::KIND] as usize;
    let toff = gpool::TREASURY + 8 * kind;
    let payout = payout_of(u64_at(pd, toff)?, u16_at(gd, goal::PAYOUT_BPS)?);
    sub_at(pd, toff, payout)?;
    pd[gpool::LIVE] &= !(1u8 << kind);
    let ts = bell_ts(
        i64::from_le_bytes(rd(pd, gpool::GENESIS_TS)?),
        u32_at(pd, gpool::BELL_SECS)?,
        bell,
    )?;
    gd[goal::STATE] = goal::STATE_ACHIEVED;
    gd[goal::WINNERS] = winners;
    put(gd, goal::ACHIEVED_BELL, &bell.to_le_bytes())?;
    put(gd, goal::ACHIEVED_TS, &ts.to_le_bytes())?;
    put(gd, goal::SHARES_OPEN_TS, &open_ts.to_le_bytes())?;
    put(gd, goal::PAYOUT, &payout.to_le_bytes())?;
    Ok(payout)
}

/// 16 Achieve (hegemony): anyone, with the goal's flag provinces in posted
/// order. [`judge_flags`] over the keeps as they are now; the payout leaves
/// the treasury; SetGoalShares is open at once.
pub(crate) fn achieve(program: &Pubkey, a: &[AccountInfo]) -> R<()> {
    let [goal_ai, gpool_ai, season, provinces @ ..] = a else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    gpool_of(program, gpool_ai)?;
    goal_of(program, goal_ai, gpool_ai.key)?;
    let mut pd = gpool_ai.try_borrow_mut_data()?;
    let mut gd = goal_ai.try_borrow_mut_data()?;
    if gd[goal::STATE] != goal::STATE_POSTED || gd[goal::JUDGE] != goal::JUDGE_CHAIN {
        return Err(E::WrongState.into());
    }
    let game = key_at(&pd, gpool::GAME_PROGRAM)?;
    let sid = u64_at(&pd, gpool::SEASON_ID)?;
    if key_at(&pd, gpool::SEASON)? != *season.key {
        return Err(E::BadAccount.into());
    }
    game_account(season, &game, &S::MAGIC, S::SIZE, sid)?;
    let n = gd[goal::FLAGS_N] as usize;
    if provinces.len() != n {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    let ctx = AddrCtx {
        season: season.key.to_bytes(),
        program: game.to_bytes(),
    };
    let mut reads = [FlagRead {
        holder: K::NONE,
        since: 0,
        resolved_next: 0,
    }; MAX_FLAGS];
    for (i, ai) in provinces.iter().enumerate() {
        let p = i16::from_le_bytes(rd(&gd, goal::FLAGS + 4 * i)?) as i32;
        let q = i16::from_le_bytes(rd(&gd, goal::FLAGS + 4 * i + 2)?) as i32;
        if ctx.province(p, q) != ai.key.to_bytes() {
            return Err(E::BadAccount.into());
        }
        game_account(ai, &game, &P::MAGIC, P::SIZE, sid)?;
        let d = ai.try_borrow_data()?;
        if d[P::KEEP + K::TILE] == K::NO_TILE {
            return Err(E::NoKeep.into());
        }
        reads[i] = FlagRead {
            holder: d[P::KEEP + K::HOLDER],
            since: u32_at(&d, P::KEEP + K::SINCE_BELL)?,
            resolved_next: u32_at(&d, P::RESOLVED_NEXT)?,
        };
    }
    let (bell, winners) = judge_flags(
        &reads[..n],
        u32_at(&gd, goal::POSTED_BELL)?,
        u32_at(&gd, goal::HOLD_BELLS)?,
        gd[goal::NEED],
    )?;
    let payout = achieved(&mut pd, &mut gd, bell, winners, now()?)?;
    msg!(
        "PRIZE goal achieve kind=0 round={} bell={} winners_mask={} payout={}",
        u32_at(&gd, goal::ROUND)?,
        bell,
        winners,
        payout
    );
    Ok(())
}

/// 17 AttestAchieve (science, wonder, exploration — P8): the operator posts
/// the winners, the achievement bell (not in the future, not before the
/// posting) and the evidence's hash; SetGoalShares waits `dispute_secs`.
pub(crate) fn attest_achieve(program: &Pubkey, a: &[AccountInfo], d: &[u8]) -> R<()> {
    let [operator, goal_ai, gpool_ai, season] = a else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    gpool_of(program, gpool_ai)?;
    goal_of(program, goal_ai, gpool_ai.key)?;
    if d.len() != 1 + 4 + 32 {
        return Err(E::BadData.into());
    }
    let winners = d[0];
    let bell = u32_at(d, 1)?;
    let evidence: [u8; 32] = rd(d, 5)?;
    let mut pd = gpool_ai.try_borrow_mut_data()?;
    let mut gd = goal_ai.try_borrow_mut_data()?;
    operator_of(&pd, operator)?;
    if gd[goal::STATE] != goal::STATE_POSTED || gd[goal::JUDGE] != goal::JUDGE_ATTESTED {
        return Err(E::WrongState.into());
    }
    if key_at(&pd, gpool::SEASON)? != *season.key {
        return Err(E::BadAccount.into());
    }
    let now = now()?;
    let cur = bell_at(
        i64::from_le_bytes(rd(&pd, gpool::GENESIS_TS)?),
        u32_at(&pd, gpool::BELL_SECS)?,
        now,
    );
    if winners == 0
        || winners >> FACTIONS != 0
        || bell > cur
        || bell < u32_at(&gd, goal::POSTED_BELL)?
    {
        return Err(E::BadParams.into());
    }
    let open = now
        .checked_add(u32_at(&pd, gpool::DISPUTE_SECS)? as i64)
        .ok_or(E::Overflow)?;
    put(&mut gd, goal::EVIDENCE_HASH, &evidence)?;
    let payout = achieved(&mut pd, &mut gd, bell, winners, open)?;
    msg!(
        "PRIZE goal attest kind={} round={} bell={} winners_mask={} payout={}",
        gd[goal::KIND],
        u32_at(&gd, goal::ROUND)?,
        bell,
        winners,
        payout
    );
    Ok(())
}

/// Close a goal, returning `amount` to its kind's treasury.
fn close_returning(pd: &mut [u8], gd: &mut [u8], amount: u64) -> R<()> {
    add_at(pd, gpool::TREASURY + 8 * gd[goal::KIND] as usize, amount)?;
    add_at(pd, gpool::RETURNED, amount)?;
    add_at(gd, goal::RETURNED, amount)?;
    gd[goal::STATE] = goal::STATE_CLOSED;
    Ok(())
}

/// 18 VoidGoal: during an attested achievement's dispute window, the
/// operator withdraws it; the payout returns to the treasury. (The next
/// round may restate the goal.)
pub(crate) fn void_goal(program: &Pubkey, a: &[AccountInfo]) -> R<()> {
    let [operator, goal_ai, gpool_ai] = a else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    gpool_of(program, gpool_ai)?;
    goal_of(program, goal_ai, gpool_ai.key)?;
    let mut pd = gpool_ai.try_borrow_mut_data()?;
    let mut gd = goal_ai.try_borrow_mut_data()?;
    operator_of(&pd, operator)?;
    if gd[goal::STATE] != goal::STATE_ACHIEVED || gd[goal::JUDGE] != goal::JUDGE_ATTESTED {
        return Err(E::WrongState.into());
    }
    if now()? >= i64::from_le_bytes(rd(&gd, goal::SHARES_OPEN_TS)?) {
        return Err(E::WrongState.into());
    }
    let payout = u64_at(&gd, goal::PAYOUT)?;
    close_returning(&mut pd, &mut gd, payout)?;
    msg!(
        "PRIZE goal void round={} returned={}",
        u32_at(&gd, goal::ROUND)?,
        payout
    );
    Ok(())
}

/// 19 SetGoalShares: once per achieved goal, after its dispute window.
/// SHARES: points totals (only winning nations, at least one) + root +
/// ledger hash; the claim window opens. RETURN: no eligible member — the
/// payout returns to the treasury and the goal closes.
pub(crate) fn set_goal_shares(program: &Pubkey, a: &[AccountInfo], d: &[u8]) -> R<()> {
    let [operator, goal_ai, gpool_ai] = a else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    gpool_of(program, gpool_ai)?;
    goal_of(program, goal_ai, gpool_ai.key)?;
    if d.len() != 1 + 48 + 32 + 32 {
        return Err(E::BadData.into());
    }
    let mut pd = gpool_ai.try_borrow_mut_data()?;
    let mut gd = goal_ai.try_borrow_mut_data()?;
    operator_of(&pd, operator)?;
    if gd[goal::STATE] != goal::STATE_ACHIEVED {
        return Err(E::WrongState.into());
    }
    let now = now()?;
    if now < i64::from_le_bytes(rd(&gd, goal::SHARES_OPEN_TS)?) {
        return Err(E::DisputeOpen.into());
    }
    let mode = d[0];
    let w = gd[goal::WINNERS];
    let mut share_nations = 0u8;
    for f in 0..FACTIONS {
        let t = u64_at(d, 1 + 8 * f)?;
        if t != 0 && w & (1 << f) == 0 {
            return Err(E::BadShares.into());
        }
        if t != 0 {
            share_nations += 1;
        }
    }
    match (mode, share_nations) {
        (goal::MODE_SHARES, n) if n > 0 => {}
        (goal::MODE_RETURN, 0) => {}
        _ => return Err(E::BadShares.into()),
    }
    gd[goal::MODE] = mode;
    put(&mut gd, goal::LEDGER_HASH, &d[81..113])?;
    if mode == goal::MODE_RETURN {
        let payout = u64_at(&gd, goal::PAYOUT)?;
        close_returning(&mut pd, &mut gd, payout)?;
        msg!("PRIZE goal shares mode=return returned={}", payout);
        return Ok(());
    }
    // §7.3: the payout is first split by the number of winning nations; a
    // winning nation with no eligible member (total 0) leaves its part
    // unclaimed, and GoalSweep returns it to the treasury (PR #198
    // `splitPrize`: "the part of a nation with no eligible member stays").
    gd[goal::SHARE_NATIONS] = w.count_ones() as u8;
    put(&mut gd, goal::TOTAL_POINTS, &d[1..49])?;
    put(&mut gd, goal::ROOT, &d[49..81])?;
    let deadline = now
        .checked_add(u32_at(&pd, gpool::CLAIM_SECS)? as i64)
        .ok_or(E::Overflow)?;
    put(&mut gd, goal::DEADLINE_TS, &deadline.to_le_bytes())?;
    gd[goal::STATE] = goal::STATE_SHARES;
    msg!(
        "PRIZE goal shares mode=shares nations={} deadline={}",
        share_nations,
        deadline
    );
    Ok(())
}

/// GoalClaim's data: `nation, points, n, proof`.
pub fn claim_data(nation: u8, points: u64, proof: &[[u8; 32]]) -> Vec<u8> {
    let mut d = vec![nation];
    d.extend_from_slice(&points.to_le_bytes());
    d.push(proof.len() as u8);
    for p in proof {
        d.extend_from_slice(p);
    }
    d
}

/// 20 GoalClaim: a contributor takes its share of an achieved goal (see the
/// module's eligibility list). The receipt PDA (`["gclaim", goal, wallet]`,
/// paid by the wallet) refuses a second claim.
pub(crate) fn goal_claim(program: &Pubkey, a: &[AccountInfo], d: &[u8]) -> R<()> {
    let [wallet, goal_ai, gpool_ai, pass_ai, receipt_ai, citizen, exclusion, vault, to, mint, token, system] =
        a
    else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    gpool_of(program, gpool_ai)?;
    goal_of(program, goal_ai, gpool_ai.key)?;
    if !wallet.is_signer || *token.key != TOKEN_PROGRAM || *system.key != SYSTEM_PROGRAM {
        return Err(E::BadAccount.into());
    }
    if d.len() < 10 || d.len() != 10 + 32 * d[9] as usize || d[9] as usize > MAX_PROOF {
        return Err(E::BadData.into());
    }
    let nation = d[0];
    let points = u64_at(d, 1)?;
    let (rkey, rbump) = receipt_address(program, goal_ai.key, wallet.key);
    if rkey != *receipt_ai.key {
        return Err(E::BadAccount.into());
    }
    if !is_empty(receipt_ai) {
        return Err(E::AlreadyClaimed.into());
    }
    let now = now()?;
    let mut pd = gpool_ai.try_borrow_mut_data()?;
    let mut gd = goal_ai.try_borrow_mut_data()?;
    if gd[goal::STATE] != goal::STATE_SHARES {
        return Err(E::WrongState.into());
    }
    if now >= i64::from_le_bytes(rd(&gd, goal::DEADLINE_TS)?) {
        return Err(E::ClaimClosed.into());
    }
    if key_at(&pd, gpool::VAULT)? != *vault.key || key_at(&pd, gpool::MINT)? != *mint.key {
        return Err(E::BadAccount.into());
    }
    let game = key_at(&pd, gpool::GAME_PROGRAM)?;
    let sid = u64_at(&pd, gpool::SEASON_ID)?;
    // Q17 (b): an operator member takes no money.
    not_excluded(program, &game, sid, wallet.key, exclusion)?;
    // §7.4: a pass valid at the achievement.
    let at = i64::from_le_bytes(rd(&gd, goal::ACHIEVED_TS)?);
    {
        if pass_address(program, gpool_ai.key, wallet.key).0 != *pass_ai.key {
            return Err(E::BadAccount.into());
        }
        if is_empty(pass_ai) {
            return Err(E::PassNotValid.into());
        }
        let ed = pass_ai.try_borrow_data()?;
        if pass_ai.owner != program || ed.len() != pass::SIZE || ed[..8] != pass::MAGIC {
            return Err(E::BadAccount.into());
        }
        let span = (
            i64::from_le_bytes(rd(&ed, pass::VALID_FROM)?),
            i64::from_le_bytes(rd(&ed, pass::VALID_UNTIL)?),
        );
        let prev = (
            i64::from_le_bytes(rd(&ed, pass::PREV_FROM)?),
            i64::from_le_bytes(rd(&ed, pass::PREV_UNTIL)?),
        );
        if !valid_at(span, prev, at) {
            return Err(E::PassNotValid.into());
        }
    }
    // The wallet's live Citizen: of a winning nation, a member long enough.
    let ctx = AddrCtx {
        season: rd(&pd, gpool::SEASON)?,
        program: game.to_bytes(),
    };
    if ctx.citizen(&wallet.key.to_bytes()) != citizen.key.to_bytes() {
        return Err(E::BadAccount.into());
    }
    game_account(citizen, &game, &C::MAGIC, C::SIZE, sid)?;
    let (faction, join_bell) = {
        let cd = citizen.try_borrow_data()?;
        if key_at(&cd, C::WALLET)? != *wallet.key {
            return Err(E::BadAccount.into());
        }
        (cd[C::FACTION], u32_at(&cd, C::JOIN_BELL)?)
    };
    if nation as usize >= FACTIONS || faction != nation || gd[goal::WINNERS] & (1 << nation) == 0 {
        return Err(E::NotWinner.into());
    }
    let achieved_bell = u32_at(&gd, goal::ACHIEVED_BELL)?;
    let member_bells = u32_at(&pd, gpool::MEMBER_BELLS)?;
    if join_bell
        .checked_add(member_bells)
        .is_none_or(|b| b > achieved_bell)
    {
        return Err(E::MemberTooRecent.into());
    }
    let mut h = leaf(
        &goal_ai.key.to_bytes(),
        &wallet.key.to_bytes(),
        nation,
        points,
    );
    for i in 0..d[9] as usize {
        h = node(&h, &rd(d, 10 + 32 * i)?);
    }
    if h != rd::<32>(&gd, goal::ROOT)? {
        return Err(E::BadProof.into());
    }
    let payout = u64_at(&gd, goal::PAYOUT)?;
    let total = u64_at(&gd, goal::TOTAL_POINTS + 8 * nation as usize)?;
    let amount =
        share_amount(payout, gd[goal::SHARE_NATIONS], points, total).ok_or(E::BadShares)?;
    if amount < u64_at(&pd, gpool::MIN_PAYOUT)? || amount == 0 {
        return Err(E::BelowMinimum.into());
    }
    let claimed = add(u64_at(&gd, goal::CLAIMED)?, amount)?;
    if claimed > payout {
        return Err(E::Overflow.into());
    }
    put(&mut gd, goal::CLAIMED, &claimed.to_le_bytes())?;
    let c = u32_at(&gd, goal::CLAIMS)?
        .checked_add(1)
        .ok_or(E::Overflow)?;
    put(&mut gd, goal::CLAIMS, &c.to_le_bytes())?;
    add_at(&mut pd, gpool::PAID, amount)?;
    let (g, s, b) = signer_seeds(&pd)?;
    let decimals = pd[gpool::DECIMALS];
    drop(pd);
    drop(gd);
    create(
        wallet,
        receipt_ai,
        receipt::SIZE,
        program,
        &[
            RECEIPT_SEED,
            goal_ai.key.as_ref(),
            wallet.key.as_ref(),
            &[rbump],
        ],
    )?;
    {
        let mut rd_ = receipt_ai.try_borrow_mut_data()?;
        put(&mut rd_, 0, &receipt::MAGIC)?;
        put(&mut rd_, receipt::WALLET, wallet.key.as_ref())?;
        put(&mut rd_, receipt::AMOUNT, &amount.to_le_bytes())?;
        put(&mut rd_, receipt::POINTS, &points.to_le_bytes())?;
    }
    token_transfer(
        vault,
        mint,
        to,
        gpool_ai,
        amount,
        decimals,
        Some(&[GOAL_POOL_SEED, &g, &s, &b]),
    )?;
    msg!(
        "PRIZE goal claim wallet={} nation={} points={} amount={}",
        wallet.key,
        nation,
        points,
        amount
    );
    Ok(())
}

/// 21 GoalSweep: anyone, after the claim window: the unclaimed rest of the
/// payout (shares under the minimum, unclaimed shares, dust) returns to the
/// kind's treasury; the goal closes.
pub(crate) fn goal_sweep(program: &Pubkey, a: &[AccountInfo]) -> R<()> {
    let [goal_ai, gpool_ai] = a else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    gpool_of(program, gpool_ai)?;
    goal_of(program, goal_ai, gpool_ai.key)?;
    let mut pd = gpool_ai.try_borrow_mut_data()?;
    let mut gd = goal_ai.try_borrow_mut_data()?;
    if gd[goal::STATE] != goal::STATE_SHARES {
        return Err(E::WrongState.into());
    }
    if now()? < i64::from_le_bytes(rd(&gd, goal::DEADLINE_TS)?) {
        return Err(E::ClaimWindowOpen.into());
    }
    let rest = u64_at(&gd, goal::PAYOUT)?
        .checked_sub(u64_at(&gd, goal::CLAIMED)?)
        .ok_or(E::Overflow)?;
    close_returning(&mut pd, &mut gd, rest)?;
    msg!(
        "PRIZE goal sweep round={} returned={}",
        u32_at(&gd, goal::ROUND)?,
        rest
    );
    Ok(())
}

/// 22 RetireGoal (Q5): the operator retires a goal nobody achieved,
/// `retire_secs` after it was posted, to post an easier next round. No
/// money moves (the treasury was never touched).
pub(crate) fn retire_goal(program: &Pubkey, a: &[AccountInfo]) -> R<()> {
    let [operator, goal_ai, gpool_ai] = a else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    gpool_of(program, gpool_ai)?;
    goal_of(program, goal_ai, gpool_ai.key)?;
    let mut pd = gpool_ai.try_borrow_mut_data()?;
    let mut gd = goal_ai.try_borrow_mut_data()?;
    operator_of(&pd, operator)?;
    if gd[goal::STATE] != goal::STATE_POSTED {
        return Err(E::WrongState.into());
    }
    let posted = i64::from_le_bytes(rd(&gd, goal::POSTED_TS)?);
    let at = posted
        .checked_add(u32_at(&pd, gpool::RETIRE_SECS)? as i64)
        .ok_or(E::Overflow)?;
    if now()? < at {
        return Err(E::WrongState.into());
    }
    gd[goal::STATE] = goal::STATE_CLOSED;
    pd[gpool::LIVE] &= !(1u8 << gd[goal::KIND]);
    msg!(
        "PRIZE goal retire kind={} round={}",
        gd[goal::KIND],
        u32_at(&gd, goal::ROUND)?
    );
    Ok(())
}

/// 23 GoalWithdrawOps: the operator's part of the passes, any time.
pub(crate) fn goal_withdraw_ops(program: &Pubkey, a: &[AccountInfo]) -> R<()> {
    let [operator, gpool_ai, vault, to, mint, token] = a else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    gpool_of(program, gpool_ai)?;
    let mut pd = gpool_ai.try_borrow_mut_data()?;
    operator_of(&pd, operator)?;
    if key_at(&pd, gpool::VAULT)? != *vault.key
        || key_at(&pd, gpool::MINT)? != *mint.key
        || *token.key != TOKEN_PROGRAM
    {
        return Err(E::BadAccount.into());
    }
    let ops = u64_at(&pd, gpool::OPS)?;
    let amount = ops
        .checked_sub(u64_at(&pd, gpool::OPS_WITHDRAWN)?)
        .ok_or(E::Overflow)?;
    if amount == 0 {
        return Err(E::NothingToPay.into());
    }
    put(&mut pd, gpool::OPS_WITHDRAWN, &ops.to_le_bytes())?;
    let (g, s, b) = signer_seeds(&pd)?;
    let decimals = pd[gpool::DECIMALS];
    drop(pd);
    token_transfer(
        vault,
        mint,
        to,
        gpool_ai,
        amount,
        decimals,
        Some(&[GOAL_POOL_SEED, &g, &s, &b]),
    )?;
    msg!("PRIZE goals ops amount={}", amount);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const fn f(holder: u8, since: u32, resolved_next: u32) -> FlagRead {
        FlagRead {
            holder,
            since,
            resolved_next,
        }
    }

    #[test]
    fn layouts_fit() {
        const _: () = assert!(gpool::END <= gpool::SIZE);
        const _: () = assert!(goal::END <= goal::SIZE);
        const _: () = assert!(pass::COUNT + 4 <= pass::SIZE);
        const _: () = assert!(receipt::POINTS + 8 <= receipt::SIZE);
        // The season id and game program sit where the legacy pool keeps them.
        assert_eq!(gpool::SEASON_ID, pool::SEASON_ID);
        assert_eq!(gpool::GAME_PROGRAM, pool::GAME_PROGRAM);
        assert_eq!(decided::RULES.len(), 9);
        assert_eq!(provisional::RULES.len(), 6);
    }

    #[test]
    fn init_data_round_trips_and_is_checked() {
        let p = Params::recommended([7; 32]);
        assert_eq!(parse_init(&init_data(&p)), Ok(p));
        let bad = |m: fn(&mut Params)| {
            let mut q = p;
            m(&mut q);
            parse_init(&init_data(&q))
        };
        assert_eq!(bad(|q| q.pass_fee = 0), Err(E::BadParams.into()));
        assert_eq!(bad(|q| q.ops_bps = 10_001), Err(E::BadParams.into()));
        assert_eq!(bad(|q| q.pass_secs = 0), Err(E::BadParams.into()));
        assert_eq!(bad(|q| q.claim_secs = 0), Err(E::BadParams.into()));
        assert_eq!(
            bad(|q| q.kind_bps = [4_000, 2_000, 2_000, 1_999]),
            Err(E::BadParams.into())
        );
        assert_eq!(parse_init(&init_data(&p)[1..]), Err(E::BadData.into()));
    }

    #[test]
    fn fees_go_to_hegemony_until_a_kind_is_posted() {
        let bps = [4_000, 2_000, 2_000, 2_000];
        // 25 test USDC, 80 %: 20,000,000 of prize.
        assert_eq!(
            split_into_kinds(20_000_000, &bps, 0b0001),
            [20_000_000, 0, 0, 0]
        );
        assert_eq!(
            split_into_kinds(20_000_000, &bps, 0b0011),
            [16_000_000, 4_000_000, 0, 0]
        );
        assert_eq!(
            split_into_kinds(20_000_000, &bps, 0b1111),
            [8_000_000, 4_000_000, 4_000_000, 4_000_000]
        );
        // Dust goes to hegemony; the parts always sum to the prize.
        let s = split_into_kinds(7, &bps, 0b1111);
        assert_eq!(s.iter().sum::<u64>(), 7);
        assert_eq!(s, [4, 1, 1, 1]);
        let s = split_into_kinds(u64::MAX, &bps, 0b1111);
        assert_eq!(s.iter().map(|x| *x as u128).sum::<u128>(), u64::MAX as u128);
    }

    #[test]
    fn a_pass_extends_or_restarts() {
        let d = 30 * 86_400;
        // New.
        let (f0, u0, pf, pu) = renew((0, 0), (0, 0), 1_000, d).unwrap();
        assert_eq!((f0, u0, pf, pu), (1_000, 1_000 + d as i64, 0, 0));
        // Renewed while valid: the same span, longer.
        let (f1, u1, pf, pu) = renew((f0, u0), (pf, pu), 2_000, d).unwrap();
        assert_eq!((f1, u1, pf, pu), (1_000, 1_000 + 2 * d as i64, 0, 0));
        // Lapsed: a new span; the old one kept.
        let late = u1 + 50;
        let (f2, u2, pf, pu) = renew((f1, u1), (pf, pu), late, d).unwrap();
        assert_eq!((f2, u2, pf, pu), (late, late + d as i64, f1, u1));
        assert!(valid_at((f2, u2), (pf, pu), 1_500));
        assert!(!valid_at((f2, u2), (pf, pu), u1 + 10)); // the gap
        assert!(valid_at((f2, u2), (pf, pu), late));
        assert!(!valid_at((f2, u2), (pf, pu), u2));
        assert!(!valid_at((0, 0), (0, 0), 0));
    }

    #[test]
    fn the_flag_judge_is_pr198s() {
        // 6 flags, need 3, hold 144, posted at bell 100.
        let posted = 100;
        let hold = 144;
        let mut flags = [
            f(2, 10, 400),  // counts from 100 (posting) → 244
            f(2, 150, 400), // → 294
            f(2, 120, 400), // → 264
            f(1, 90, 400),  // nation 1: → 244
            f(1, 200, 400), // → 344
            f(255, 0, 400), // nobody
        ];
        // Nation 2 reaches 3 at 294; nation 1 holds only 2.
        assert_eq!(judge_flags(&flags, posted, hold, 3), Ok((294, 1 << 2)));
        // Nation 1 takes the free flag at 130 → 274: reaches its 3rd at 344 > 294.
        flags[5] = f(1, 130, 400);
        assert_eq!(judge_flags(&flags, posted, hold, 3), Ok((294, 1 << 2)));
        // A tie: nation 1's third at the same bell.
        flags[4] = f(1, 150, 400);
        assert_eq!(
            judge_flags(&flags, posted, hold, 3),
            Ok((294, (1 << 1) | (1 << 2)))
        );
        // Not long enough yet (a province resolved only to 290: its 294 is unknown).
        flags[1] = f(2, 150, 290);
        flags[4] = f(1, 150, 290);
        assert_eq!(
            judge_flags(&flags, posted, hold, 3),
            Err(E::NotAchieved.into())
        );
        // Lagging province: a winner exists at 294, but one flag province is
        // resolved only to 280 — a tie there could be unseen.
        let lag = [f(2, 10, 400), f(2, 10, 400), f(2, 150, 400), f(3, 0, 280)];
        assert_eq!(
            judge_flags(&lag, posted, hold, 3),
            Err(E::ProvinceNotFinal.into())
        );
        assert_eq!(judge_flags(&lag[..3], posted, hold, 3), Ok((294, 1 << 2)));
        // need bounds
        assert_eq!(judge_flags(&lag, posted, hold, 0), Err(E::BadParams.into()));
        assert_eq!(judge_flags(&lag, posted, hold, 5), Err(E::BadParams.into()));
        // Overflow near u32::MAX is an error, not a wrap.
        assert_eq!(
            judge_flags(&[f(0, u32::MAX - 1, u32::MAX)], 0, 144, 1),
            Err(E::Overflow.into())
        );
    }

    #[test]
    fn payout_and_bells() {
        assert_eq!(payout_of(20_000_000, 3_000), 6_000_000);
        assert_eq!(payout_of(7, 3_000), 2);
        assert_eq!(payout_of(u64::MAX, 10_000), u64::MAX);
        assert_eq!(bell_at(1_000, 600, 999), 0);
        assert_eq!(bell_at(1_000, 600, 1_000 + 600 * 144 + 599), 144);
        assert_eq!(bell_at(1_000, 0, 5_000), 0);
        assert_eq!(bell_ts(1_000, 600, 144), Ok(1_000 + 86_400));
    }

    #[test]
    fn data_builders() {
        let d = post_data(0, 1, 6, 144, 3_000, &[9; 32], &[(1, -2), (-3, 4)]);
        assert_eq!(d.len(), 45 + 8);
        assert_eq!(d[44], 2);
        let c = claim_data(2, 30, &[[1; 32]]);
        assert_eq!(c.len(), 10 + 32);
        assert_eq!(c[9], 1);
    }
}
