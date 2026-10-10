//! Wylls prize pool (test assets only).
//!
//! One pool per (game program, season). Entry fees are paid into a vault
//! the pool PDA owns; `ops_bps` of each fee is the operator's, the rest is
//! the prize. The winner is not written by anybody: after the game's
//! Season is Ended, [`tally`] reads the game's own Province accounts
//! (owner = the game program, address re-derived, every bell before
//! `end_bell` resolved), counts each keep once for its holder and
//! [`finalize`] names the nation(s) with the largest area once every
//! keep is counted: the pool's `expected_keeps` must equal both the count
//! and the game's own figure (its Frontier account's opened provinces less
//! the seven keepless provinces of rings 0–1).
//!
//! **The freeze.** The game resolves no bell at or after `end_bell`
//! (permutation-frontier `proc/clash.rs`: "Bells at or after `end_bell` are
//! never gathered, resolved or skipped"), and a keep changes holder only in
//! a bell's resolution. Tally therefore takes a Province only when the
//! Season is Ended and the Province's `resolved_next ≥ end_bell` (every
//! bell that could move its keep is done), and refuses a keep whose
//! `since_bell ≥ end_bell`. A counted Province is never read again (bitmap),
//! and Finalize closes the tally for good.
//!
//! **Decided** (owner): the winner is the nation holding the most provinces
//! at the end; 80% of each fee is prize, 20% the operator's. **Provisional**
//! (undecided, [`provisional`]): the tie rule and the fallbacks.
//!
//! Shares inside the winning nation: the operator posts one merkle root
//! over `(wallet, nation, points)` plus the sha256 of the published
//! contribution ledger ([`set_shares`], once, after Finalize). A claim
//! needs the wallet's Entry (it paid), its game Citizen of a winning
//! nation, and a proof. This part is isolated in [`set_shares`] and
//! [`claim`] so that it can be replaced.
//!
//! | tag | instruction | accounts |
//! |---|---|---|
//! | 0 | InitPool(fee u64, ops_bps u16, expected_keeps u16, params_hash 32) | `[operator s,w] [pool w] [vault w] [mint] [season] [game program] [token] [system]` |
//! | 1 | Pay | `[wallet s] [payer s,w] [pool w] [entry w] [wallet token w] [vault w] [mint] [token] [system]` |
//! | 2 | Tally | `[pool w] [season] [province]…` |
//! | 3 | Finalize | `[pool w] [frontier]` |
//! | 4 | SetShares(mode u8, total_points [u64;6], root 32, ledger_hash 32) | `[operator s] [pool w]` |
//! | 5 | Claim(nation u8, points u64, n u8, proof 32×n) | `[wallet s] [pool w] [entry w] [citizen] [vault w] [wallet token w] [mint] [token]` |
//! | 6 | WithdrawOps | `[operator s] [pool w] [vault w] [operator token w] [mint] [token]` |

use solana_program::{
    account_info::AccountInfo,
    entrypoint::ProgramResult,
    instruction::{AccountMeta, Instruction},
    msg,
    program::{invoke, invoke_signed},
    program_error::ProgramError,
    pubkey::Pubkey,
    rent::Rent,
    sysvar::Sysvar,
};

use frontier_abi::addr::{province_index, AddrCtx};
use frontier_abi::v2::layout::player::citizen as C;
use frontier_abi::v2::layout::province::{keep as K, province as P};
use frontier_abi::layout::world::frontier as F;
use frontier_abi::v2::layout::world::season as S;
use permutation_rules::hash::sha256;

pub const TOKEN_PROGRAM: Pubkey =
    solana_program::pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
pub const SYSTEM_PROGRAM: Pubkey = Pubkey::new_from_array([0u8; 32]);

pub const POOL_SEED: &[u8] = b"pool";
pub const VAULT_SEED: &[u8] = b"vault";
pub const ENTRY_SEED: &[u8] = b"entry";
pub const FACTIONS: usize = 6;
/// Most basis points of a fee the operator may keep.
pub const MAX_OPS_BPS: u16 = 10_000;
/// Provinces the tally bitmap covers (`province_index < 1,024`: rings 0–17).
pub const MAX_PROVINCES: u32 = 1_024;
/// Most merkle proof nodes of a Claim.
pub const MAX_PROOF: usize = 24;

/// Instruction tags.
pub mod tag {
    pub const INIT_POOL: u8 = 0;
    pub const PAY: u8 = 1;
    pub const TALLY: u8 = 2;
    pub const FINALIZE: u8 = 3;
    pub const SET_SHARES: u8 = 4;
    pub const CLAIM: u8 = 5;
    pub const WITHDRAW_OPS: u8 = 6;
}

/// Pool account (640 B, PDA `["pool", game program, le64(season id)]`).
pub mod pool {
    pub const MAGIC: [u8; 8] = *b"WYPRPOOL";
    pub const SIZE: usize = 640;
    pub const HDR_MAGIC: usize = 0;
    pub const BUMP: usize = 8;
    pub const VAULT_BUMP: usize = 9;
    pub const STATE: usize = 10;
    pub const DECIMALS: usize = 11;
    pub const WINNERS: usize = 12;
    pub const MODE: usize = 13;
    pub const SHARE_NATIONS: usize = 14;
    pub const SEASON_ID: usize = 16;
    pub const GAME_PROGRAM: usize = 24;
    pub const SEASON: usize = 56;
    pub const OPERATOR: usize = 88;
    pub const MINT: usize = 120;
    pub const VAULT: usize = 152;
    pub const FEE: usize = 184;
    pub const OPS_BPS: usize = 192;
    pub const EXPECTED_KEEPS: usize = 194;
    pub const COUNTED: usize = 196;
    pub const PARAMS_HASH: usize = 200;
    pub const ENTRIES: usize = 232;
    pub const CLAIMS: usize = 236;
    pub const COLLECTED: usize = 240;
    pub const PRIZE: usize = 248;
    pub const OPS: usize = 256;
    pub const OPS_WITHDRAWN: usize = 264;
    pub const CLAIMED: usize = 272;
    pub const AREA: usize = 280;
    pub const BELLS: usize = 296;
    pub const TOTAL_POINTS: usize = 344;
    pub const SHARES_ROOT: usize = 392;
    pub const LEDGER_HASH: usize = 424;
    pub const END_BELL: usize = 456;
    pub const BITMAP: usize = 472;
    pub const BITMAP_LEN: usize = 128;

    /// `state`: fees are taken until the first Tally.
    pub const STATE_OPEN: u8 = 0;
    /// The winner is written; nothing changes it.
    pub const STATE_FINAL: u8 = 1;
    /// The shares (or the refund) are set; claims are open.
    pub const STATE_SHARES: u8 = 2;

    /// `mode` of SetShares: points against the merkle root.
    pub const MODE_SHARES: u8 = 1;
    /// `mode` of SetShares: no eligible member, every payer takes its part
    /// of the prize back.
    pub const MODE_REFUND: u8 = 2;
}

/// Entry account (128 B, PDA `["entry", pool, wallet]`): proof of payment.
pub mod entry {
    pub const MAGIC: [u8; 8] = *b"WYPRENTR";
    pub const SIZE: usize = 128;
    pub const HDR_MAGIC: usize = 0;
    pub const BUMP: usize = 8;
    pub const CLAIMED: usize = 9;
    pub const POOL: usize = 16;
    pub const WALLET: usize = 48;
    pub const AMOUNT: usize = 80;
    pub const PAID_SLOT: usize = 88;
    pub const CLAIM_AMOUNT: usize = 96;
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u32)]
pub enum PrizeError {
    BadData = 0x100,
    BadAccount = 0x101,
    BadParams = 0x102,
    NotOperator = 0x103,
    WrongState = 0x104,
    AlreadyPaid = 0x105,
    SeasonNotEnded = 0x106,
    ProvinceNotFinal = 0x107,
    NoKeep = 0x108,
    TallyIncomplete = 0x109,
    BadShares = 0x10A,
    BadProof = 0x10B,
    NotWinner = 0x10C,
    AlreadyClaimed = 0x10D,
    NothingToPay = 0x10E,
    Overflow = 0x10F,
    WrongExpectedCount = 0x110,
}

impl From<PrizeError> for ProgramError {
    fn from(e: PrizeError) -> Self {
        ProgramError::Custom(e as u32)
    }
}

type R<T> = Result<T, ProgramError>;
use PrizeError as E;

fn rd<const N: usize>(d: &[u8], off: usize) -> R<[u8; N]> {
    d.get(off..off + N)
        .and_then(|s| s.try_into().ok())
        .ok_or(E::BadData.into())
}
fn u16_at(d: &[u8], off: usize) -> R<u16> {
    Ok(u16::from_le_bytes(rd(d, off)?))
}
fn u32_at(d: &[u8], off: usize) -> R<u32> {
    Ok(u32::from_le_bytes(rd(d, off)?))
}
fn u64_at(d: &[u8], off: usize) -> R<u64> {
    Ok(u64::from_le_bytes(rd(d, off)?))
}
fn key_at(d: &[u8], off: usize) -> R<Pubkey> {
    Ok(Pubkey::new_from_array(rd(d, off)?))
}
fn put(d: &mut [u8], off: usize, v: &[u8]) -> R<()> {
    d.get_mut(off..off + v.len())
        .ok_or(ProgramError::from(E::BadData))?
        .copy_from_slice(v);
    Ok(())
}
fn add(a: u64, b: u64) -> R<u64> {
    a.checked_add(b).ok_or(E::Overflow.into())
}

/// The pool address of a season of a game program.
pub fn pool_address(program: &Pubkey, game: &Pubkey, season_id: u64) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[POOL_SEED, game.as_ref(), &season_id.to_le_bytes()], program)
}
/// The pool's vault (an SPL token account the pool PDA owns).
pub fn vault_address(program: &Pubkey, pool: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[VAULT_SEED, pool.as_ref()], program)
}
/// A wallet's Entry.
pub fn entry_address(program: &Pubkey, pool: &Pubkey, wallet: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[ENTRY_SEED, pool.as_ref(), wallet.as_ref()], program)
}

/// The operator's part of one fee: `fee × ops_bps / 10,000`, rounded down
/// (the prize takes the remainder).
pub fn ops_part(fee: u64, ops_bps: u16) -> u64 {
    (fee as u128 * ops_bps as u128 / 10_000) as u64
}

/// The shares leaf of `(wallet, nation, points)` in `pool`.
pub fn leaf(pool: &[u8; 32], wallet: &[u8; 32], nation: u8, points: u64) -> [u8; 32] {
    sha256(&[&[0u8], pool, wallet, &[nation], &points.to_le_bytes()])
}
/// The parent of two nodes (sorted pair).
pub fn node(a: &[u8; 32], b: &[u8; 32]) -> [u8; 32] {
    let (lo, hi) = if a <= b { (a, b) } else { (b, a) };
    sha256(&[&[1u8], lo, hi])
}

/// Provinces of rings 0–1: opened like every other, but without a keep.
pub const KEEPLESS_PROVINCES: u32 = 7;

/// DECIDED (owner): the nations holding the most provinces, as a bit mask
/// (more than one bit: a tie for first place); 0 when no nation holds a keep.
pub fn largest_area(area: &[u16; FACTIONS]) -> u8 {
    let top = *area.iter().max().unwrap_or(&0);
    if top == 0 {
        return 0;
    }
    (0..FACTIONS)
        .filter(|&f| area[f] == top)
        .fold(0u8, |m, f| m | (1 << f))
}

/// PROVISIONAL rules: undecided by the owner, kept apart from the decided
/// ones so that they can be replaced. Every output of the tooling lists
/// them (`provisional: true`).
pub mod provisional {
    use super::FACTIONS;

    /// What is provisional in this program, by name (the tooling prints it).
    pub const RULES: [&str; 4] = [
        "tie for first place: more territory bells wins; still tied: the tied nations share the prize equally",
        "shares inside the winning nation: by points of the operator-posted, publicly recomputable ledger (SetShares)",
        "all contributions zero: the ledger gives every paid member of the winning nation one point (equal split)",
        "no eligible member in the winning nation: every payer takes its part of the prize back (refund)",
    ];

    /// Tie for first place among `tied` (a mask of the nations with the
    /// largest area): the ones with the most territory bells; still tied:
    /// all of them.
    pub fn break_tie(tied: u8, bells: &[u64; FACTIONS]) -> u8 {
        let best = (0..FACTIONS)
            .filter(|&f| tied & (1 << f) != 0)
            .map(|f| bells[f])
            .max();
        (0..FACTIONS)
            .filter(|&f| tied & (1 << f) != 0 && Some(bells[f]) == best)
            .fold(0u8, |m, f| m | (1 << f))
    }
}

/// The winners: [`largest_area`], a tie resolved by [`provisional::break_tie`].
pub fn winners(area: &[u16; FACTIONS], bells: &[u64; FACTIONS]) -> u8 {
    let top = largest_area(area);
    if top.count_ones() > 1 {
        provisional::break_tie(top, bells)
    } else {
        top
    }
}

/// A claim's amount in shares mode: the prize split evenly between the
/// `share_nations` winning nations that have points, then by points.
pub fn share_amount(prize: u64, share_nations: u8, points: u64, total: u64) -> Option<u64> {
    if share_nations == 0 || total == 0 || points > total {
        return None;
    }
    let slice = prize / share_nations as u64;
    Some((slice as u128 * points as u128 / total as u128) as u64)
}

/// A claim's amount in refund mode: the payer's part of the prize.
pub fn refund_amount(prize: u64, paid: u64, collected: u64) -> Option<u64> {
    if collected == 0 || paid > collected {
        return None;
    }
    Some((prize as u128 * paid as u128 / collected as u128) as u64)
}

fn create<'a>(
    payer: &AccountInfo<'a>,
    target: &AccountInfo<'a>,
    space: usize,
    owner: &Pubkey,
    seeds: &[&[u8]],
) -> R<()> {
    if !target.data_is_empty() || *target.owner != SYSTEM_PROGRAM {
        return Err(E::BadAccount.into());
    }
    let lamports = Rent::get()?
        .minimum_balance(space)
        .saturating_sub(target.lamports());
    let mut d = Vec::with_capacity(52);
    d.extend_from_slice(&0u32.to_le_bytes()); // System CreateAccount
    d.extend_from_slice(&lamports.to_le_bytes());
    d.extend_from_slice(&(space as u64).to_le_bytes());
    d.extend_from_slice(owner.as_ref());
    invoke_signed(
        &Instruction {
            program_id: SYSTEM_PROGRAM,
            accounts: vec![
                AccountMeta::new(*payer.key, true),
                AccountMeta::new(*target.key, true),
            ],
            data: d,
        },
        &[payer.clone(), target.clone()],
        &[seeds],
    )
}

#[allow(clippy::too_many_arguments)]
fn token_transfer<'a>(
    from: &AccountInfo<'a>,
    mint: &AccountInfo<'a>,
    to: &AccountInfo<'a>,
    authority: &AccountInfo<'a>,
    amount: u64,
    decimals: u8,
    seeds: Option<&[&[u8]]>,
) -> R<()> {
    let mut d = Vec::with_capacity(10);
    d.push(12); // SPL Token TransferChecked
    d.extend_from_slice(&amount.to_le_bytes());
    d.push(decimals);
    let ix = Instruction {
        program_id: TOKEN_PROGRAM,
        accounts: vec![
            AccountMeta::new(*from.key, false),
            AccountMeta::new_readonly(*mint.key, false),
            AccountMeta::new(*to.key, false),
            AccountMeta::new_readonly(*authority.key, true),
        ],
        data: d,
    };
    let infos = [from.clone(), mint.clone(), to.clone(), authority.clone()];
    match seeds {
        Some(s) => invoke_signed(&ix, &infos, &[s]),
        None => invoke(&ix, &infos),
    }
}

/// The pool account of this program, checked; returns its key bytes.
fn pool_of(program: &Pubkey, ai: &AccountInfo) -> R<()> {
    let d = ai.try_borrow_data()?;
    if ai.owner != program || d.len() != pool::SIZE || d[..8] != pool::MAGIC {
        return Err(E::BadAccount.into());
    }
    Ok(())
}

/// An account of the game program with the chained header's magic and
/// season id.
fn game_account(ai: &AccountInfo, game: &Pubkey, magic: &[u8; 8], size: usize, sid: u64) -> R<()> {
    let d = ai.try_borrow_data()?;
    if ai.owner != game
        || d.len() != size
        || d[..8] != magic[..]
        || u64_at(&d, S::SEASON_ID)? != sid
    {
        return Err(E::BadAccount.into());
    }
    Ok(())
}

fn init_pool(program: &Pubkey, a: &[AccountInfo], d: &[u8]) -> R<()> {
    let [operator, pool_ai, vault, mint, season, game, token, system] = a else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    if d.len() != 8 + 2 + 2 + 32 {
        return Err(E::BadData.into());
    }
    let fee = u64_at(d, 0)?;
    let ops_bps = u16_at(d, 8)?;
    let expected = u16_at(d, 10)?;
    let params_hash: [u8; 32] = rd(d, 12)?;
    if fee == 0 || ops_bps > MAX_OPS_BPS || expected == 0 || expected as u32 > MAX_PROVINCES {
        return Err(E::BadParams.into());
    }
    if !operator.is_signer || *token.key != TOKEN_PROGRAM || *system.key != SYSTEM_PROGRAM {
        return Err(E::BadAccount.into());
    }
    // The season: the game program's Season account; the pool's operator is
    // its authority (nobody else can open a season's pool).
    let (sid, end_bell) = {
        let sd = season.try_borrow_data()?;
        if season.owner != game.key || sd.len() != S::SIZE || sd[..8] != S::MAGIC {
            return Err(E::BadAccount.into());
        }
        if key_at(&sd, S::AUTHORITY)? != *operator.key {
            return Err(E::NotOperator.into());
        }
        (u64_at(&sd, S::SEASON_ID)?, u32_at(&sd, S::END_BELL)?)
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
    let (pool_key, bump) = pool_address(program, game.key, sid);
    let (vault_key, vault_bump) = vault_address(program, &pool_key);
    if pool_key != *pool_ai.key || vault_key != *vault.key {
        return Err(E::BadAccount.into());
    }
    create(
        operator,
        pool_ai,
        pool::SIZE,
        program,
        &[POOL_SEED, game.key.as_ref(), &sid_le, &[bump]],
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
    put(&mut pd, pool::EXPECTED_KEEPS, &expected.to_le_bytes())?;
    put(&mut pd, pool::PARAMS_HASH, &params_hash)?;
    put(&mut pd, pool::END_BELL, &end_bell.to_le_bytes())?;
    msg!("PRIZE init season={} fee={} ops_bps={} keeps={}", sid, fee, ops_bps, expected);
    Ok(())
}

fn pay(program: &Pubkey, a: &[AccountInfo]) -> R<()> {
    let [wallet, payer, pool_ai, entry_ai, from, vault, mint, token, system] = a else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    pool_of(program, pool_ai)?;
    if !wallet.is_signer
        || !payer.is_signer
        || *token.key != TOKEN_PROGRAM
        || *system.key != SYSTEM_PROGRAM
    {
        return Err(E::BadAccount.into());
    }
    let (fee, ops_bps, decimals) = {
        let pd = pool_ai.try_borrow_data()?;
        if pd[pool::STATE] != pool::STATE_OPEN || u16_at(&pd, pool::COUNTED)? != 0 {
            return Err(E::WrongState.into());
        }
        if key_at(&pd, pool::VAULT)? != *vault.key || key_at(&pd, pool::MINT)? != *mint.key {
            return Err(E::BadAccount.into());
        }
        (u64_at(&pd, pool::FEE)?, u16_at(&pd, pool::OPS_BPS)?, pd[pool::DECIMALS])
    };
    let (entry_key, bump) = entry_address(program, pool_ai.key, wallet.key);
    if entry_key != *entry_ai.key {
        return Err(E::BadAccount.into());
    }
    if !entry_ai.data_is_empty() {
        return Err(E::AlreadyPaid.into());
    }
    token_transfer(from, mint, vault, wallet, fee, decimals, None)?;
    create(
        payer,
        entry_ai,
        entry::SIZE,
        program,
        &[ENTRY_SEED, pool_ai.key.as_ref(), wallet.key.as_ref(), &[bump]],
    )?;
    {
        let mut ed = entry_ai.try_borrow_mut_data()?;
        put(&mut ed, entry::HDR_MAGIC, &entry::MAGIC)?;
        ed[entry::BUMP] = bump;
        put(&mut ed, entry::POOL, pool_ai.key.as_ref())?;
        put(&mut ed, entry::WALLET, wallet.key.as_ref())?;
        put(&mut ed, entry::AMOUNT, &fee.to_le_bytes())?;
        let slot = solana_program::clock::Clock::get()?.slot;
        put(&mut ed, entry::PAID_SLOT, &slot.to_le_bytes())?;
    }
    let ops = ops_part(fee, ops_bps);
    let mut pd = pool_ai.try_borrow_mut_data()?;
    let n = u32_at(&pd, pool::ENTRIES)?.checked_add(1).ok_or(E::Overflow)?;
    put(&mut pd, pool::ENTRIES, &n.to_le_bytes())?;
    let v = add(u64_at(&pd, pool::COLLECTED)?, fee)?;
    put(&mut pd, pool::COLLECTED, &v.to_le_bytes())?;
    let v = add(u64_at(&pd, pool::PRIZE)?, fee - ops)?;
    put(&mut pd, pool::PRIZE, &v.to_le_bytes())?;
    let v = add(u64_at(&pd, pool::OPS)?, ops)?;
    put(&mut pd, pool::OPS, &v.to_le_bytes())?;
    msg!("PRIZE pay wallet={} fee={} prize+={} ops+={}", wallet.key, fee, fee - ops, ops);
    Ok(())
}

fn tally(program: &Pubkey, a: &[AccountInfo]) -> R<()> {
    let [pool_ai, season, provinces @ ..] = a else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    pool_of(program, pool_ai)?;
    let mut pd = pool_ai.try_borrow_mut_data()?;
    if pd[pool::STATE] != pool::STATE_OPEN {
        return Err(E::WrongState.into());
    }
    let game = key_at(&pd, pool::GAME_PROGRAM)?;
    let sid = u64_at(&pd, pool::SEASON_ID)?;
    if key_at(&pd, pool::SEASON)? != *season.key {
        return Err(E::BadAccount.into());
    }
    game_account(season, &game, &S::MAGIC, S::SIZE, sid)?;
    let end_bell = {
        let sd = season.try_borrow_data()?;
        if sd[S::STATUS] != S::STATUS_ENDED {
            return Err(E::SeasonNotEnded.into());
        }
        u32_at(&sd, S::END_BELL)?
    };
    put(&mut pd, pool::END_BELL, &end_bell.to_le_bytes())?;
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
        // Bells at or after end_bell are never resolved: a province whose
        // every earlier bell is resolved cannot change its keep any more.
        if u32_at(&d, P::RESOLVED_NEXT)? < end_bell
            || u32_at(&d, P::KEEP + K::SINCE_BELL)? >= end_bell
        {
            return Err(E::ProvinceNotFinal.into());
        }
        let i = province_index(p, q).filter(|i| *i < MAX_PROVINCES).ok_or(E::BadAccount)? as usize;
        let (byte, bit) = (pool::BITMAP + i / 8, 1u8 << (i % 8));
        if pd[byte] & bit != 0 {
            continue;
        }
        pd[byte] |= bit;
        counted = counted.checked_add(1).ok_or(E::Overflow)?;
        let holder = d[P::KEEP + K::HOLDER] as usize;
        if holder < FACTIONS {
            let off = pool::AREA + 2 * holder;
            let v = u16_at(&pd, off)?.checked_add(1).ok_or(E::Overflow)?;
            put(&mut pd, off, &v.to_le_bytes())?;
        }
        for f in 0..FACTIONS {
            let off = pool::BELLS + 8 * f;
            let v = add(u64_at(&pd, off)?, u64_at(&d, P::TERRITORY_BELLS + 8 * f)?)?;
            put(&mut pd, off, &v.to_le_bytes())?;
        }
    }
    put(&mut pd, pool::COUNTED, &counted.to_le_bytes())?;
    msg!("PRIZE tally counted={}", counted);
    Ok(())
}

fn finalize(program: &Pubkey, a: &[AccountInfo]) -> R<()> {
    let [pool_ai, frontier] = a else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    pool_of(program, pool_ai)?;
    let mut pd = pool_ai.try_borrow_mut_data()?;
    if pd[pool::STATE] != pool::STATE_OPEN {
        return Err(E::WrongState.into());
    }
    // The game's own count of keeps: its opened provinces less rings 0–1.
    let game = key_at(&pd, pool::GAME_PROGRAM)?;
    let ctx = AddrCtx {
        season: rd(&pd, pool::SEASON)?,
        program: game.to_bytes(),
    };
    game_account(frontier, &game, &F::MAGIC, F::SIZE, u64_at(&pd, pool::SEASON_ID)?)?;
    if ctx.frontier() != frontier.key.to_bytes() {
        return Err(E::BadAccount.into());
    }
    let keeps = u32_at(&frontier.try_borrow_data()?, F::PROVINCES_OPENED)?
        .saturating_sub(KEEPLESS_PROVINCES);
    let expected = u16_at(&pd, pool::EXPECTED_KEEPS)?;
    if expected as u32 != keeps {
        return Err(E::WrongExpectedCount.into());
    }
    if u16_at(&pd, pool::COUNTED)? != expected {
        return Err(E::TallyIncomplete.into());
    }
    let mut area = [0u16; FACTIONS];
    let mut bells = [0u64; FACTIONS];
    for f in 0..FACTIONS {
        area[f] = u16_at(&pd, pool::AREA + 2 * f)?;
        bells[f] = u64_at(&pd, pool::BELLS + 8 * f)?;
    }
    let w = winners(&area, &bells);
    pd[pool::WINNERS] = w;
    pd[pool::STATE] = pool::STATE_FINAL;
    msg!("PRIZE final winners_mask={} area={:?}", w, area);
    Ok(())
}

fn set_shares(program: &Pubkey, a: &[AccountInfo], d: &[u8]) -> R<()> {
    let [operator, pool_ai] = a else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    pool_of(program, pool_ai)?;
    if d.len() != 1 + 48 + 32 + 32 {
        return Err(E::BadData.into());
    }
    let mut pd = pool_ai.try_borrow_mut_data()?;
    if !operator.is_signer || key_at(&pd, pool::OPERATOR)? != *operator.key {
        return Err(E::NotOperator.into());
    }
    if pd[pool::STATE] != pool::STATE_FINAL {
        return Err(E::WrongState.into());
    }
    let mode = d[0];
    let w = pd[pool::WINNERS];
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
    // Shares need points; a refund is for no points at all.
    match (mode, share_nations) {
        (pool::MODE_SHARES, n) if n > 0 => {}
        (pool::MODE_REFUND, 0) => {}
        _ => return Err(E::BadShares.into()),
    }
    pd[pool::MODE] = mode;
    pd[pool::SHARE_NATIONS] = share_nations;
    put(&mut pd, pool::TOTAL_POINTS, &d[1..49])?;
    put(&mut pd, pool::SHARES_ROOT, &d[49..81])?;
    put(&mut pd, pool::LEDGER_HASH, &d[81..113])?;
    pd[pool::STATE] = pool::STATE_SHARES;
    msg!("PRIZE shares mode={} nations={}", mode, share_nations);
    Ok(())
}

fn claim(program: &Pubkey, a: &[AccountInfo], d: &[u8]) -> R<()> {
    let [wallet, pool_ai, entry_ai, citizen, vault, to, mint, token] = a else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    pool_of(program, pool_ai)?;
    if !wallet.is_signer || *token.key != TOKEN_PROGRAM {
        return Err(E::BadAccount.into());
    }
    if d.len() < 10 || d.len() != 10 + 32 * d[9] as usize || d[9] as usize > MAX_PROOF {
        return Err(E::BadData.into());
    }
    let nation = d[0];
    let points = u64_at(d, 1)?;
    let (entry_key, _) = entry_address(program, pool_ai.key, wallet.key);
    if entry_key != *entry_ai.key || entry_ai.owner != program {
        return Err(E::BadAccount.into());
    }
    let mut ed = entry_ai.try_borrow_mut_data()?;
    if ed.len() != entry::SIZE || ed[..8] != entry::MAGIC {
        return Err(E::BadAccount.into());
    }
    if ed[entry::CLAIMED] != 0 {
        return Err(E::AlreadyClaimed.into());
    }
    let mut pd = pool_ai.try_borrow_mut_data()?;
    if pd[pool::STATE] != pool::STATE_SHARES {
        return Err(E::WrongState.into());
    }
    if key_at(&pd, pool::VAULT)? != *vault.key || key_at(&pd, pool::MINT)? != *mint.key {
        return Err(E::BadAccount.into());
    }
    let prize = u64_at(&pd, pool::PRIZE)?;
    let amount = if pd[pool::MODE] == pool::MODE_REFUND {
        refund_amount(prize, u64_at(&ed, entry::AMOUNT)?, u64_at(&pd, pool::COLLECTED)?)
    } else {
        // The wallet's Citizen of the game, in a winning nation.
        let game = key_at(&pd, pool::GAME_PROGRAM)?;
        let sid = u64_at(&pd, pool::SEASON_ID)?;
        game_account(citizen, &game, &C::MAGIC, C::SIZE, sid)?;
        let ctx = AddrCtx {
            season: rd(&pd, pool::SEASON)?,
            program: game.to_bytes(),
        };
        let cd = citizen.try_borrow_data()?;
        if ctx.citizen(&wallet.key.to_bytes()) != citizen.key.to_bytes()
            || key_at(&cd, C::WALLET)? != *wallet.key
        {
            return Err(E::BadAccount.into());
        }
        if nation as usize >= FACTIONS
            || cd[C::FACTION] != nation
            || pd[pool::WINNERS] & (1 << nation) == 0
        {
            return Err(E::NotWinner.into());
        }
        let mut h = leaf(&pool_ai.key.to_bytes(), &wallet.key.to_bytes(), nation, points);
        for i in 0..d[9] as usize {
            h = node(&h, &rd(d, 10 + 32 * i)?);
        }
        if h != rd::<32>(&pd, pool::SHARES_ROOT)? {
            return Err(E::BadProof.into());
        }
        let total = u64_at(&pd, pool::TOTAL_POINTS + 8 * nation as usize)?;
        share_amount(prize, pd[pool::SHARE_NATIONS], points, total)
    }
    .ok_or(E::BadShares)?;
    let claimed = add(u64_at(&pd, pool::CLAIMED)?, amount)?;
    if claimed > prize {
        return Err(E::Overflow.into());
    }
    put(&mut pd, pool::CLAIMED, &claimed.to_le_bytes())?;
    let n = u32_at(&pd, pool::CLAIMS)?.checked_add(1).ok_or(E::Overflow)?;
    put(&mut pd, pool::CLAIMS, &n.to_le_bytes())?;
    ed[entry::CLAIMED] = 1;
    put(&mut ed, entry::CLAIM_AMOUNT, &amount.to_le_bytes())?;
    let game = key_at(&pd, pool::GAME_PROGRAM)?;
    let sid = u64_at(&pd, pool::SEASON_ID)?.to_le_bytes();
    let (bump, decimals) = (pd[pool::BUMP], pd[pool::DECIMALS]);
    drop(pd);
    drop(ed);
    if amount > 0 {
        token_transfer(
            vault,
            mint,
            to,
            pool_ai,
            amount,
            decimals,
            Some(&[POOL_SEED, game.as_ref(), &sid, &[bump]]),
        )?;
    }
    msg!("PRIZE claim wallet={} points={} amount={}", wallet.key, points, amount);
    Ok(())
}

fn withdraw_ops(program: &Pubkey, a: &[AccountInfo]) -> R<()> {
    let [operator, pool_ai, vault, to, mint, token] = a else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    pool_of(program, pool_ai)?;
    let mut pd = pool_ai.try_borrow_mut_data()?;
    if !operator.is_signer || key_at(&pd, pool::OPERATOR)? != *operator.key {
        return Err(E::NotOperator.into());
    }
    if pd[pool::STATE] == pool::STATE_OPEN {
        return Err(E::WrongState.into());
    }
    if key_at(&pd, pool::VAULT)? != *vault.key
        || key_at(&pd, pool::MINT)? != *mint.key
        || *token.key != TOKEN_PROGRAM
    {
        return Err(E::BadAccount.into());
    }
    let ops = u64_at(&pd, pool::OPS)?;
    let amount = ops.checked_sub(u64_at(&pd, pool::OPS_WITHDRAWN)?).ok_or(E::Overflow)?;
    if amount == 0 {
        return Err(E::NothingToPay.into());
    }
    put(&mut pd, pool::OPS_WITHDRAWN, &ops.to_le_bytes())?;
    let game = key_at(&pd, pool::GAME_PROGRAM)?;
    let sid = u64_at(&pd, pool::SEASON_ID)?.to_le_bytes();
    let (bump, decimals) = (pd[pool::BUMP], pd[pool::DECIMALS]);
    drop(pd);
    token_transfer(
        vault,
        mint,
        to,
        pool_ai,
        amount,
        decimals,
        Some(&[POOL_SEED, game.as_ref(), &sid, &[bump]]),
    )?;
    msg!("PRIZE ops amount={}", amount);
    Ok(())
}

pub fn process_instruction(program: &Pubkey, a: &[AccountInfo], data: &[u8]) -> ProgramResult {
    let (t, d) = data.split_first().ok_or(E::BadData)?;
    match *t {
        tag::INIT_POOL => init_pool(program, a, d),
        tag::PAY if d.is_empty() => pay(program, a),
        tag::TALLY if d.is_empty() => tally(program, a),
        tag::FINALIZE if d.is_empty() => finalize(program, a),
        tag::SET_SHARES => set_shares(program, a, d),
        tag::CLAIM => claim(program, a, d),
        tag::WITHDRAW_OPS if d.is_empty() => withdraw_ops(program, a),
        _ => Err(E::BadData.into()),
    }
}

#[cfg(not(feature = "no-entrypoint"))]
solana_program::entrypoint!(process_instruction);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fee_split_is_80_20() {
        assert_eq!(ops_part(10_000_000, 2_000), 2_000_000);
        assert_eq!(ops_part(7, 2_000), 1); // rounding favours the prize
        assert_eq!(ops_part(u64::MAX, 10_000), u64::MAX);
    }

    #[test]
    fn largest_area_wins_then_bells_then_all() {
        let b0 = [0u64; 6];
        assert_eq!(winners(&[9, 10, 9, 9, 9, 8], &b0), 0b000010);
        assert_eq!(winners(&[0; 6], &b0), 0);
        // tie on area: more territory bells
        assert_eq!(winners(&[10, 10, 9, 9, 8, 8], &[5, 7, 99, 0, 0, 0]), 0b000010);
        // tie on both: both
        assert_eq!(winners(&[10, 10, 9, 9, 8, 8], &[7, 7, 99, 0, 0, 0]), 0b000011);
        // the decided rule alone never looks at territory bells
        assert_eq!(largest_area(&[10, 10, 9, 9, 8, 8]), 0b000011);
        assert_eq!(largest_area(&[9, 11, 9, 9, 8, 8]), 0b000010);
        assert_eq!(provisional::break_tie(0b000011, &[5, 7, 99, 0, 0, 0]), 0b000010);
    }

    #[test]
    fn shares_never_exceed_the_prize() {
        let prize = 16_000_001u64;
        let pts = [10u64, 3, 1];
        let total: u64 = pts.iter().sum();
        let paid: u64 = pts.iter().map(|p| share_amount(prize, 1, *p, total).unwrap()).sum();
        assert!(paid <= prize && prize - paid < pts.len() as u64);
        assert_eq!(share_amount(prize, 2, 5, 5), Some(prize / 2));
        assert_eq!(share_amount(prize, 1, 6, 5), None);
        assert_eq!(share_amount(prize, 0, 1, 1), None);
        assert_eq!(refund_amount(16_000_000, 10_000_000, 20_000_000), Some(8_000_000));
        assert_eq!(refund_amount(1, 1, 0), None);
    }

    #[test]
    fn merkle_pairs_are_sorted() {
        let p = [7u8; 32];
        let a = leaf(&p, &[1; 32], 2, 10);
        let b = leaf(&p, &[2; 32], 2, 3);
        assert_eq!(node(&a, &b), node(&b, &a));
        // The vectors the JS SDK pins (permutation-gateway/test/frontier-prize.test.mjs).
        let hex = |h: [u8; 32]| h.iter().map(|x| format!("{x:02x}")).collect::<String>();
        assert_eq!(hex(a), "ae1f8f256f5c65762ac65c7a2bf12f69d6e7e4fdc870d74fd0da943da34c6e64");
        assert_eq!(hex(node(&a, &b)), "fc71c2545a8a38c0bc74f5b24ab1d559fdfb6d0385fb5a594b4c9d78bc83c0e3");
        assert_ne!(a, leaf(&p, &[1; 32], 3, 10));
        assert_ne!(a, leaf(&p, &[1; 32], 2, 11));
    }
}
