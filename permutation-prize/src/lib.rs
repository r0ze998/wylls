//! Wylls prize pool (test assets only).
//!
//! One pool per (game program, season). Entry fees are paid into a vault
//! the pool PDA owns; `ops_bps` of each fee is the operator's, the rest is
//! the prize. The winner is not written by anybody: after the game's
//! Season is Ended, [`tally`] reads the game's own Province accounts
//! (owner = the game program, address re-derived, every bell before
//! `end_bell` resolved), counts each keep once for its holder and
//! [`finalize`] names the nation(s) with the largest area once every
//! keep is counted: the count must equal the game's own figure at
//! Finalize, the sum of its six ProvinceFunds' opened provinces less the
//! seven keepless provinces of rings 0–1. The map may grow during the
//! season, so no count is fixed before it (`expected_keeps` is display
//! only); after Ended no Province opens and none closes before
//! `end + 72 h`, so that sum is the map at the end.
//!
//! **The freeze.** The game resolves no bell at or after `end_bell`
//! (permutation-frontier `proc/clash.rs`: "Bells at or after `end_bell` are
//! never gathered, resolved or skipped"), and a keep changes holder only in
//! a bell's resolution. Tally therefore takes a Province only when the
//! Season is Ended and the Province's `resolved_next ≥ end_bell` (every
//! bell that could move its keep is done), and refuses a keep whose
//! `since_bell ≥ end_bell`. A Province opened at or after `end_bell`
//! (between the end bell and EndSeason) did not exist at the end: it is
//! counted with no area and no territory. A counted Province is never read
//! again (bitmap), and Finalize closes the tally for good. The bitmap
//! covers rings 0–17, so InitPool refuses a season with `r_max` > 17,
//! and (map growth) one whose conquest `r_max_ceiling` > 17
//! (`CeilingPastTally`): ExtendFrontier may raise such a season's map past
//! the bitmap, and the game program cannot see the pool. The limit stays
//! 17; a ceiling of at most 17 keeps the whole map inside the tally.
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
//! | 3 | Finalize | `[pool w] [season] [province fund]×6` (wedges 0–5) |
//! | 4 | SetShares(mode u8, total_points [u64;6], root 32, ledger_hash 32) | `[operator s] [pool w]` |
//! | 5 | Claim(nation u8, points u64, n u8, proof 32×n) | `[wallet s] [pool w] [entry w] [citizen] [vault w] [wallet token w] [mint] [token]` |
//! | 6 | WithdrawOps | `[operator s] [pool w] [vault w] [operator token w] [mint] [token]` |
//! | 7 | RecordNation (candidate, workstream 04) | `[pool] [entry w] [citizen]` |
//! | 8 | PayResident(generation u32) (experimental, `nft-experimental`) | `[owner s] [payer s,w] [pool w] [entry w] [owner token w] [vault w] [mint] [token] [system] [policy] [asset] [resident]` |
//! | 9 | ClaimResident(generation u32, nation u8, points u64, n u8, proof 32×n) (experimental) | `[owner s] [pool w] [entry w] [citizen] [link] [vault w] [owner token w] [mint] [token] [policy] [asset] [resident]` |
//! | 10 | RecordResidentNation (experimental) | `[pool] [entry w] [citizen]` |
//!
//! **NFT pass entries (experimental, feature `nft-experimental`; NFT-PRIZE.md).**
//! A player of the `nft-experimental` game holds an NFT pass (a Metaplex Core
//! asset of the resident program's collection, workstream 20): its entry and
//! its unclaimed prize rights belong to the pass, so they follow it to its
//! **current** owner, whoever paid. Every pass instruction reads, in the same
//! invocation and never from the caller: the game program's resident policy
//! (its own PDA, program-owned, write-once), the Core asset (owner, collection,
//! transfer guard) and the resident program's record (holder generation,
//! session) — `frontier_abi::resident_auth`, exactly the game's check — and
//! refuses a session key, an owner that moved on, or a signature from before
//! a transfer (the signed generation). The NFT Entry is its own account kind
//! (`["entry-nft", pool, asset]`, 192 B, magic `WYPRNFTE`), so a wallet Claim
//! never pays it and a pass Claim never pays a wallet Entry; its share leaf is
//! `sha256(0x02 ‖ pool ‖ asset ‖ nation ‖ points)` (a wallet leaf starts with
//! 0x00, a node with 0x01), under the one shares root. Everything the legacy
//! wallet path does is unchanged. Undecided and therefore refused (fail
//! closed): a pass claim in refund mode (`ResidentRefundUndecided`: whom a
//! refund follows is not decided), and for the same reason **every new pass
//! deposit**: PayResident (tag 8) is answered `ResidentDepositsDisabled` at
//! dispatch, before any read, write or CPI, so no pass fee the pool could
//! never return is taken. An NFT Entry that already exists keeps its shares
//! claim. Nothing about legacy-to-NFT migration.
//!
//! **RecordNation** (candidate, 2026-11-06; changes no rule and no amount).
//! A shares claim needs the wallet's nation, which the game keeps in its
//! Citizen (written once, at Join, never changed). The game's cleanup may
//! close that Citizen (CloseCitizen, anyone, `end + 72 h`) whether or not
//! its wallet has claimed, and the claim would then be refused for good.
//! RecordNation lets anyone copy the nation from the live Citizen into the
//! wallet's own Entry (bytes 10–11, unused before); a later Claim reads the
//! live Citizen as before and, only when that Citizen's address is empty,
//! the recorded nation. Who may claim, how much and until when are
//! unchanged. Entries without a record behave exactly as before.

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
use frontier_abi::layout::world::province_fund as PF;
use frontier_abi::v2::layout::player::citizen as C;
use frontier_abi::v2::layout::province::{keep as K, province as P};
use frontier_abi::v2::layout::world::season as S;
use permutation_rules::hash::sha256;

pub const TOKEN_PROGRAM: Pubkey =
    solana_program::pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
pub const SYSTEM_PROGRAM: Pubkey = Pubkey::new_from_array([0u8; 32]);

pub const POOL_SEED: &[u8] = b"pool";
pub const VAULT_SEED: &[u8] = b"vault";
pub const ENTRY_SEED: &[u8] = b"entry";
/// The NFT Entry's seed (experimental): never a wallet Entry's address.
pub const ENTRY_RESIDENT_SEED: &[u8] = b"entry-nft";
pub const FACTIONS: usize = 6;
/// Most basis points of a fee the operator may keep.
pub const MAX_OPS_BPS: u16 = 10_000;
/// Provinces the tally bitmap covers (`province_index < 1,024`: rings 0–17).
pub const MAX_PROVINCES: u32 = 1_024;
/// The outermost ring the bitmap covers whole (ring 17: 919 provinces;
/// ring 18 would need 1,027).
pub const MAX_RING: u16 = 17;
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
    /// Candidate (workstream 04): copy the Citizen's nation into the Entry.
    pub const RECORD_NATION: u8 = 7;
    /// NFT pass (experimental, provisional numbers; dispatched only with the
    /// `nft-experimental` feature, `BadData` otherwise): the pass's current
    /// owner pays the fee; the NFT Entry names the pass, not a wallet.
    pub const PAY_RESIDENT: u8 = 8;
    /// NFT pass: the pass's current owner claims its share (shares mode only).
    pub const CLAIM_RESIDENT: u8 = 9;
    /// NFT pass: copy the NFT Citizen's nation into the NFT Entry (anyone).
    pub const RECORD_RESIDENT_NATION: u8 = 10;
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
    /// 1 once [`super::record_nation`] has copied the Citizen's nation; 0
    /// on every Entry before it (Pay leaves bytes 10–15 zero).
    pub const NATION_RECORDED: usize = 10;
    /// The recorded nation (meaningful only when `NATION_RECORDED == 1`).
    pub const NATION: usize = 11;
    pub const POOL: usize = 16;
    pub const WALLET: usize = 48;
    pub const AMOUNT: usize = 80;
    pub const PAID_SLOT: usize = 88;
    pub const CLAIM_AMOUNT: usize = 96;
}

/// NFT Entry account (192 B, PDA `["entry-nft", pool, asset]`; experimental,
/// `nft-experimental`): proof that the pass `asset` paid. Its first 104 bytes
/// sit where the wallet Entry's do, with the asset where the wallet is, so a
/// reader can share offsets; its size and magic differ, so neither kind is
/// ever read as the other. Bytes 172–191 are reserved (zero).
pub mod entry_resident {
    pub const MAGIC: [u8; 8] = *b"WYPRNFTE";
    pub const SIZE: usize = 192;
    pub const HDR_MAGIC: usize = 0;
    pub const BUMP: usize = 8;
    pub const CLAIMED: usize = 9;
    /// 1 once [`super::tag::RECORD_RESIDENT_NATION`] copied the NFT
    /// Citizen's nation; 0 before.
    pub const NATION_RECORDED: usize = 10;
    pub const NATION: usize = 11;
    /// The holder generation the payer signed (informational).
    pub const PAY_GENERATION: usize = 12;
    pub const POOL: usize = 16;
    pub const ASSET: usize = 48;
    pub const AMOUNT: usize = 80;
    pub const PAID_SLOT: usize = 88;
    pub const CLAIM_AMOUNT: usize = 96;
    /// The owner that paid (informational: the right follows the pass).
    pub const PAID_BY: usize = 104;
    /// The owner that claimed (zero until claimed).
    pub const CLAIMED_BY: usize = 136;
    /// The holder generation the claimant signed.
    pub const CLAIM_GENERATION: usize = 168;
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
    /// InitPool: an existing continuous world never reaches Season Ended,
    /// so the old end-dependent prize pool has no safe settlement path.
    ContinuousSeason = 0x112,
    /// InitPool: the season's `r_max_ceiling` lets ExtendFrontier grow the
    /// map past [`MAX_RING`] (the tally bitmap's rings 0–17).
    CeilingPastTally = 0x111,
    // NFT pass (experimental; provisional numbers, 0x111 is ⑧'s
    // CeilingPastTally): the six refusals of
    // `frontier_abi::resident_auth`, in this program's number space.
    /// The pass's owner did not sign.
    ResidentNotSigned = 0x113,
    /// The asset account is not a Core asset of the policy's collection.
    ResidentAsset = 0x114,
    /// The resident record is not the asset's, or not at its address.
    ResidentAccount = 0x115,
    /// The asset lacks the transfer guard (it could move without the
    /// generation changing).
    ResidentUnguarded = 0x116,
    /// The signed generation is not the current one: the pass moved since.
    ResidentStaleGeneration = 0x117,
    /// The signer is not the pass's current owner (a session key never
    /// claims or pays).
    ResidentNotCurrentAuthority = 0x118,
    /// The game program's resident policy is absent, not the game's, or not
    /// at its address: no pass can be judged.
    ResidentPolicy = 0x119,
    /// A pass claim in refund mode: whom a refund follows (the payer or the
    /// holder) is undecided, so it is refused and nothing moves.
    ResidentRefundUndecided = 0x11A,
    /// PayResident: new pass deposits are disabled at dispatch, before any
    /// read, write or CPI, until the pass refund right is decided (a
    /// deposit the pool could never return in refund mode is not taken).
    /// Existing NFT Entries keep their shares claim; the wallet Pay is as
    /// before.
    ResidentDepositsDisabled = 0x11B,
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
    Pubkey::find_program_address(
        &[POOL_SEED, game.as_ref(), &season_id.to_le_bytes()],
        program,
    )
}
/// The pool's vault (an SPL token account the pool PDA owns).
pub fn vault_address(program: &Pubkey, pool: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[VAULT_SEED, pool.as_ref()], program)
}
/// A wallet's Entry.
pub fn entry_address(program: &Pubkey, pool: &Pubkey, wallet: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[ENTRY_SEED, pool.as_ref(), wallet.as_ref()], program)
}
/// An NFT pass's Entry (experimental).
pub fn entry_resident_address(program: &Pubkey, pool: &Pubkey, asset: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[ENTRY_RESIDENT_SEED, pool.as_ref(), asset.as_ref()],
        program,
    )
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
/// The shares leaf of an NFT pass `(asset, nation, points)` in `pool`
/// (experimental): its own domain byte, so a pass leaf is never a wallet
/// leaf (0x00) or a node (0x01) of the same bytes. One root holds both kinds.
pub fn leaf_resident(pool: &[u8; 32], asset: &[u8; 32], nation: u8, points: u64) -> [u8; 32] {
    sha256(&[&[2u8], pool, asset, &[nation], &points.to_le_bytes()])
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
        "tie for first place: more territory time wins (the chain's TERRITORY_BELLS counters); still tied: the tied nations share the prize equally",
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
    // `expected` is display only (0: not given); Finalize uses the game's count.
    if fee == 0 || ops_bps > MAX_OPS_BPS || expected as u32 > MAX_PROVINCES {
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
        season_ends(&sd, solana_program::clock::Clock::get()?.unix_timestamp)?;
        // A map that may grow past the bitmap could never be tallied whole.
        season_rings_fit(&sd)?;
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
    msg!(
        "PRIZE init season={} fee={} ops_bps={} keeps={}",
        sid,
        fee,
        ops_bps,
        expected
    );
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
        (
            u64_at(&pd, pool::FEE)?,
            u16_at(&pd, pool::OPS_BPS)?,
            pd[pool::DECIMALS],
        )
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
        &[
            ENTRY_SEED,
            pool_ai.key.as_ref(),
            wallet.key.as_ref(),
            &[bump],
        ],
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
    let ops = credit_fee(pool_ai, fee, ops_bps)?;
    msg!(
        "PRIZE pay wallet={} fee={} prize+={} ops+={}",
        wallet.key,
        fee,
        fee - ops,
        ops
    );
    Ok(())
}

/// Books one paid fee into the pool: one more entry, `fee` collected, the
/// prize's and the operator's parts ([`ops_part`]). Returns the operator's
/// part. (Pay's own bookkeeping, unchanged; PayResident shares it.)
fn credit_fee(pool_ai: &AccountInfo, fee: u64, ops_bps: u16) -> R<u64> {
    let ops = ops_part(fee, ops_bps);
    let mut pd = pool_ai.try_borrow_mut_data()?;
    let n = u32_at(&pd, pool::ENTRIES)?
        .checked_add(1)
        .ok_or(E::Overflow)?;
    put(&mut pd, pool::ENTRIES, &n.to_le_bytes())?;
    let v = add(u64_at(&pd, pool::COLLECTED)?, fee)?;
    put(&mut pd, pool::COLLECTED, &v.to_le_bytes())?;
    let v = add(u64_at(&pd, pool::PRIZE)?, fee - ops)?;
    put(&mut pd, pool::PRIZE, &v.to_le_bytes())?;
    let v = add(u64_at(&pd, pool::OPS)?, ops)?;
    put(&mut pd, pool::OPS, &v.to_le_bytes())?;
    Ok(ops)
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
        // Opened at or after end_bell (before EndSeason): not on the map at
        // the end, so counted with nothing to add.
        let after_end = u32_at(&d, P::OPENED_BELL)? >= end_bell;
        // Bells at or after end_bell are never resolved: a province whose
        // every earlier bell is resolved cannot change its keep any more.
        if !after_end
            && (u32_at(&d, P::RESOLVED_NEXT)? < end_bell
                || u32_at(&d, P::KEEP + K::SINCE_BELL)? >= end_bell)
        {
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
        if after_end {
            continue;
        }
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
    let [pool_ai, season, funds @ ..] = a else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    if funds.len() != PF::WEDGES {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
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
    if season.try_borrow_data()?[S::STATUS] != S::STATUS_ENDED {
        return Err(E::SeasonNotEnded.into());
    }
    // The game's own count of keeps at the end: its six ProvinceFunds'
    // opened provinces (OpenProvince counts there, live) less rings 0–1.
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
        refund_amount(
            prize,
            u64_at(&ed, entry::AMOUNT)?,
            u64_at(&pd, pool::COLLECTED)?,
        )
    } else {
        // The wallet's Citizen of the game, in a winning nation: the live
        // Citizen as before; only when its address is empty (closed by the
        // game's cleanup), the nation recorded from it into the Entry.
        let game = key_at(&pd, pool::GAME_PROGRAM)?;
        let sid = u64_at(&pd, pool::SEASON_ID)?;
        let ctx = AddrCtx {
            season: rd(&pd, pool::SEASON)?,
            program: game.to_bytes(),
        };
        if ctx.citizen(&wallet.key.to_bytes()) != citizen.key.to_bytes() {
            return Err(E::BadAccount.into());
        }
        let faction = if is_empty(citizen) {
            if ed[entry::NATION_RECORDED] != 1 {
                return Err(E::BadAccount.into());
            }
            ed[entry::NATION]
        } else {
            game_account(citizen, &game, &C::MAGIC, C::SIZE, sid)?;
            let cd = citizen.try_borrow_data()?;
            if key_at(&cd, C::WALLET)? != *wallet.key {
                return Err(E::BadAccount.into());
            }
            cd[C::FACTION]
        };
        if nation as usize >= FACTIONS
            || faction != nation
            || pd[pool::WINNERS] & (1 << nation) == 0
        {
            return Err(E::NotWinner.into());
        }
        let mut h = leaf(
            &pool_ai.key.to_bytes(),
            &wallet.key.to_bytes(),
            nation,
            points,
        );
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
    let n = u32_at(&pd, pool::CLAIMS)?
        .checked_add(1)
        .ok_or(E::Overflow)?;
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
    msg!(
        "PRIZE claim wallet={} points={} amount={}",
        wallet.key,
        points,
        amount
    );
    Ok(())
}

/// An address with nothing at it: no data, and owned by the System program
/// or holding no lamports (a closed account).
fn is_empty(ai: &AccountInfo) -> bool {
    ai.data_is_empty() && (*ai.owner == SYSTEM_PROGRAM || ai.lamports() == 0)
}

/// 7 RecordNation (candidate): `[pool] [entry w] [citizen]`, no signer —
/// anyone may run it, for any Entry, in any pool state. It copies the
/// nation of the Entry's wallet from that wallet's live game Citizen (at
/// its address, of the pool's game and season) into the Entry. The game
/// writes a Citizen's nation once, at Join, so the copy is the value a
/// Claim would read from the Citizen. Repeating it is a no-op; a different
/// nation is refused (`BadAccount`). It moves no token and no lamport.
fn record_nation(program: &Pubkey, a: &[AccountInfo]) -> R<()> {
    let [pool_ai, entry_ai, citizen] = a else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    pool_of(program, pool_ai)?;
    if entry_ai.owner != program {
        return Err(E::BadAccount.into());
    }
    let pd = pool_ai.try_borrow_data()?;
    let mut ed = entry_ai.try_borrow_mut_data()?;
    if ed.len() != entry::SIZE
        || ed[..8] != entry::MAGIC
        || key_at(&ed, entry::POOL)? != *pool_ai.key
    {
        return Err(E::BadAccount.into());
    }
    let wallet = key_at(&ed, entry::WALLET)?;
    if entry_address(program, pool_ai.key, &wallet).0 != *entry_ai.key {
        return Err(E::BadAccount.into());
    }
    let game = key_at(&pd, pool::GAME_PROGRAM)?;
    let sid = u64_at(&pd, pool::SEASON_ID)?;
    let ctx = AddrCtx {
        season: rd(&pd, pool::SEASON)?,
        program: game.to_bytes(),
    };
    if ctx.citizen(&wallet.to_bytes()) != citizen.key.to_bytes() {
        return Err(E::BadAccount.into());
    }
    game_account(citizen, &game, &C::MAGIC, C::SIZE, sid)?;
    let cd = citizen.try_borrow_data()?;
    if key_at(&cd, C::WALLET)? != wallet {
        return Err(E::BadAccount.into());
    }
    let faction = cd[C::FACTION];
    match ed[entry::NATION_RECORDED] {
        0 => {
            ed[entry::NATION_RECORDED] = 1;
            ed[entry::NATION] = faction;
        }
        1 if ed[entry::NATION] == faction => {}
        _ => return Err(E::BadAccount.into()),
    }
    msg!("PRIZE nation wallet={} nation={}", wallet, faction);
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
    let amount = ops
        .checked_sub(u64_at(&pd, pool::OPS_WITHDRAWN)?)
        .ok_or(E::Overflow)?;
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

/// NFT pass entries and claims (experimental, feature `nft-experimental`;
/// NFT-PRIZE.md). The pass's current owner is judged from three live
/// accounts the caller cannot forge: the game program's resident policy (its
/// PDA, owned by the game, write-once), the Core asset (owned by the policy's
/// Core program, in the policy's collection, frozen with the resident
/// program's permanent transfer delegate) and the resident program's record
/// (owned by the policy's resident program, at `["resident", asset]`), with
/// the generation the owner signed — `frontier_abi::resident_auth::authorize`,
/// the game's own check, with `session_allowed = false`. The pass's Citizen
/// is this world's, at `citizen_by_tag15(resident id)` of the pool's season,
/// marked with the asset, and its link `["nft-citizen-link", season, asset]`
/// names asset, resident and Citizen.
#[cfg(feature = "nft-experimental")]
mod resident {
    use super::*;
    use frontier_abi::resident_auth::{self, Refusal};
    use frontier_abi::{resident_binding, resident_citizen, resident_policy};

    /// The game program's policy PDA (`permutation-frontier`
    /// `resident_binding::POLICY_SEED`).
    pub const POLICY_SEED: &[u8] = b"nft-resident-policy";
    /// The game's per-world link (`resident_binding::LINK_SEED`).
    pub const LINK_SEED: &[u8] = b"nft-citizen-link";
    /// The resident program's record of an asset (`resident_binding::RESIDENT_SEED`).
    pub const RESIDENT_SEED: &[u8] = b"resident";

    fn refusal(r: Refusal) -> ProgramError {
        let e = match r {
            Refusal::NotSigned => E::ResidentNotSigned,
            Refusal::Asset => E::ResidentAsset,
            Refusal::Resident => E::ResidentAccount,
            Refusal::Unguarded => E::ResidentUnguarded,
            Refusal::StaleGeneration => E::ResidentStaleGeneration,
            Refusal::NotCurrentAuthority => E::ResidentNotCurrentAuthority,
        };
        e.into()
    }

    /// The game program's resident policy, from its own account: at the
    /// policy PDA of `game`, owned by `game`, read-only, a complete
    /// `PSFNP002` record (`ResidentPolicy` otherwise). The caller never names
    /// the Core program, the resident program or the collection.
    fn game_policy(game: &Pubkey, policy: &AccountInfo) -> R<resident_auth::Policy> {
        let expected = Pubkey::find_program_address(&[POLICY_SEED], game).0;
        if *policy.key != expected || *policy.owner != *game || policy.is_writable {
            return Err(E::ResidentPolicy.into());
        }
        let d = policy.try_borrow_data()?;
        resident_policy::read(&d).ok_or(ProgramError::from(E::ResidentPolicy))
    }

    /// `owner` holds the pass `asset` now: it signed; the asset is a guarded
    /// Core asset of the policy's collection whose live owner is `owner` (no
    /// session); `resident` is the asset's record at its address under the
    /// policy's resident program; `generation` (signed instruction data) is
    /// the record's current one. Read in this invocation, cached nowhere.
    fn current_owner(
        policy: &resident_auth::Policy,
        asset: &AccountInfo,
        resident: &AccountInfo,
        owner: &AccountInfo,
        generation: u32,
        now: i64,
    ) -> R<()> {
        if asset.is_writable || resident.is_writable {
            return Err(E::BadAccount.into());
        }
        let resident_program = Pubkey::new_from_array(policy.resident_program);
        let expected =
            Pubkey::find_program_address(&[RESIDENT_SEED, asset.key.as_ref()], &resident_program).0;
        if *resident.key != expected {
            return Err(E::ResidentAccount.into());
        }
        let a = asset.try_borrow_data()?;
        let r = resident.try_borrow_data()?;
        resident_auth::authorize(
            &resident_auth::Binding {
                asset: asset.key.to_bytes(),
                resident: resident.key.to_bytes(),
            },
            policy,
            &resident_auth::Account {
                key: asset.key.to_bytes(),
                owner: asset.owner.to_bytes(),
                data: &a,
            },
            &resident_auth::Account {
                key: resident.key.to_bytes(),
                owner: resident.owner.to_bytes(),
                data: &r,
            },
            owner.key.as_array(),
            owner.is_signer,
            generation,
            now,
            false,
        )
        .map_err(refusal)
    }

    /// This world's NFT Citizen of `asset`: at `citizen_by_tag15(resident id)`
    /// of the pool's season (`BadAccount` otherwise).
    fn expect_citizen_address(ctx: &AddrCtx, asset: &Pubkey, citizen: &AccountInfo) -> R<()> {
        let tag15 = resident_citizen::resident_tag15(asset.as_array());
        if ctx.citizen_by_tag15(&tag15) != citizen.key.to_bytes() {
            return Err(E::BadAccount.into());
        }
        Ok(())
    }

    /// The nation of the live NFT Citizen `citizen` of `asset`: the game's
    /// account of this season, marked with exactly this asset.
    fn citizen_nation(citizen: &AccountInfo, game: &Pubkey, sid: u64, asset: &Pubkey) -> R<u8> {
        game_account(citizen, game, &C::MAGIC, C::SIZE, sid)?;
        let cd = citizen.try_borrow_data()?;
        if resident_citizen::resident_asset(&cd) != Some(asset.to_bytes()) {
            return Err(E::BadAccount.into());
        }
        Ok(cd[C::FACTION])
    }

    /// 8 PayResident: the pass's current owner pays the fee from its own
    /// token account; the NFT Entry names the pass. As Pay: while the pool is
    /// Open and nothing is tallied, once per pass (`AlreadyPaid`).
    ///
    /// **Not dispatched.** `process_instruction` answers the tag with
    /// `ResidentDepositsDisabled` before calling anything: until whom a
    /// pass's refund belongs to is decided, a deposit the pool could never
    /// return is not taken. Kept, unreachable, for that decision.
    #[allow(dead_code)]
    pub fn pay_resident(program: &Pubkey, a: &[AccountInfo], d: &[u8]) -> R<()> {
        let [owner, payer, pool_ai, entry_ai, from, vault, mint, token, system, policy_ai, asset, resident] =
            a
        else {
            return Err(ProgramError::NotEnoughAccountKeys);
        };
        if d.len() != 4 {
            return Err(E::BadData.into());
        }
        let generation = u32::from_le_bytes(rd(d, 0)?);
        pool_of(program, pool_ai)?;
        if !owner.is_signer
            || !payer.is_signer
            || *token.key != TOKEN_PROGRAM
            || *system.key != SYSTEM_PROGRAM
        {
            return Err(E::BadAccount.into());
        }
        let (fee, ops_bps, decimals, game) = {
            let pd = pool_ai.try_borrow_data()?;
            if pd[pool::STATE] != pool::STATE_OPEN || u16_at(&pd, pool::COUNTED)? != 0 {
                return Err(E::WrongState.into());
            }
            if key_at(&pd, pool::VAULT)? != *vault.key || key_at(&pd, pool::MINT)? != *mint.key {
                return Err(E::BadAccount.into());
            }
            (
                u64_at(&pd, pool::FEE)?,
                u16_at(&pd, pool::OPS_BPS)?,
                pd[pool::DECIMALS],
                key_at(&pd, pool::GAME_PROGRAM)?,
            )
        };
        let clock = solana_program::clock::Clock::get()?;
        let policy = game_policy(&game, policy_ai)?;
        current_owner(
            &policy,
            asset,
            resident,
            owner,
            generation,
            clock.unix_timestamp,
        )?;
        let (entry_key, bump) = entry_resident_address(program, pool_ai.key, asset.key);
        if entry_key != *entry_ai.key {
            return Err(E::BadAccount.into());
        }
        if !entry_ai.data_is_empty() {
            return Err(E::AlreadyPaid.into());
        }
        token_transfer(from, mint, vault, owner, fee, decimals, None)?;
        create(
            payer,
            entry_ai,
            entry_resident::SIZE,
            program,
            &[
                ENTRY_RESIDENT_SEED,
                pool_ai.key.as_ref(),
                asset.key.as_ref(),
                &[bump],
            ],
        )?;
        {
            use entry_resident as N;
            let mut ed = entry_ai.try_borrow_mut_data()?;
            put(&mut ed, N::HDR_MAGIC, &N::MAGIC)?;
            ed[N::BUMP] = bump;
            put(&mut ed, N::PAY_GENERATION, &generation.to_le_bytes())?;
            put(&mut ed, N::POOL, pool_ai.key.as_ref())?;
            put(&mut ed, N::ASSET, asset.key.as_ref())?;
            put(&mut ed, N::AMOUNT, &fee.to_le_bytes())?;
            put(&mut ed, N::PAID_SLOT, &clock.slot.to_le_bytes())?;
            put(&mut ed, N::PAID_BY, owner.key.as_ref())?;
        }
        let ops = credit_fee(pool_ai, fee, ops_bps)?;
        msg!(
            "PRIZE pay-nft asset={} owner={} gen={} fee={} prize+={} ops+={}",
            asset.key,
            owner.key,
            generation,
            fee,
            fee - ops,
            ops
        );
        Ok(())
    }

    /// 9 ClaimResident: the pass's current owner takes the pass's share, once
    /// (shares mode only; refund mode is `ResidentRefundUndecided`), into its
    /// own token account of the pool's mint (`[owner token w]` must be owned
    /// by the signer; `BadAccount` otherwise). The amount, the proof and the
    /// winning-nation rule are the wallet Claim's; the leaf is the pass's
    /// ([`leaf_resident`]). The nation comes from the live NFT Citizen, or,
    /// only when its address is empty, from the Entry's record
    /// (RecordResidentNation).
    pub fn claim_resident(program: &Pubkey, a: &[AccountInfo], d: &[u8]) -> R<()> {
        use entry_resident as N;
        let [owner, pool_ai, entry_ai, citizen, link, vault, to, mint, token, policy_ai, asset, resident] =
            a
        else {
            return Err(ProgramError::NotEnoughAccountKeys);
        };
        pool_of(program, pool_ai)?;
        if !owner.is_signer || *token.key != TOKEN_PROGRAM {
            return Err(E::BadAccount.into());
        }
        // generation u32 ‖ nation u8 ‖ points u64 ‖ n u8 ‖ proof 32×n
        if d.len() < 14 || d.len() != 14 + 32 * d[13] as usize || d[13] as usize > MAX_PROOF {
            return Err(E::BadData.into());
        }
        let generation = u32::from_le_bytes(rd(d, 0)?);
        let nation = d[4];
        let points = u64_at(d, 5)?;
        let n = d[13] as usize;
        let (entry_key, _) = entry_resident_address(program, pool_ai.key, asset.key);
        if entry_key != *entry_ai.key || entry_ai.owner != program {
            return Err(E::BadAccount.into());
        }
        let mut ed = entry_ai.try_borrow_mut_data()?;
        if ed.len() != N::SIZE
            || ed[..8] != N::MAGIC
            || key_at(&ed, N::POOL)? != *pool_ai.key
            || key_at(&ed, N::ASSET)? != *asset.key
        {
            return Err(E::BadAccount.into());
        }
        if ed[N::CLAIMED] != 0 {
            return Err(E::AlreadyClaimed.into());
        }
        let mut pd = pool_ai.try_borrow_mut_data()?;
        if pd[pool::STATE] != pool::STATE_SHARES {
            return Err(E::WrongState.into());
        }
        if key_at(&pd, pool::VAULT)? != *vault.key || key_at(&pd, pool::MINT)? != *mint.key {
            return Err(E::BadAccount.into());
        }
        // The share goes to the signer's own token account of the pool's mint
        // only: an SPL token account whose mint is the pool's and whose owner
        // field is the signer (the wallet Claim leaves its destination to the
        // signer; a pass claim binds it, so a later owner is paid to itself).
        {
            let td = to.try_borrow_data()?;
            if *to.owner != TOKEN_PROGRAM
                || td.len() != 165
                || key_at(&td, 0)? != *mint.key
                || key_at(&td, 32)? != *owner.key
            {
                return Err(E::BadAccount.into());
            }
        }
        let game = key_at(&pd, pool::GAME_PROGRAM)?;
        let sid = u64_at(&pd, pool::SEASON_ID)?;
        let season: [u8; 32] = rd(&pd, pool::SEASON)?;
        // Who holds the pass now, from the live Core asset and resident
        // record: never the payer, never a session, never a stale signature.
        let policy = game_policy(&game, policy_ai)?;
        current_owner(
            &policy,
            asset,
            resident,
            owner,
            generation,
            solana_program::clock::Clock::get()?.unix_timestamp,
        )?;
        if pd[pool::MODE] == pool::MODE_REFUND {
            return Err(E::ResidentRefundUndecided.into());
        }
        // This world's NFT Citizen and link of the pass.
        let ctx = AddrCtx {
            season,
            program: game.to_bytes(),
        };
        expect_citizen_address(&ctx, asset.key, citizen)?;
        let link_key =
            Pubkey::find_program_address(&[LINK_SEED, season.as_ref(), asset.key.as_ref()], &game)
                .0;
        if *link.key != link_key || *link.owner != game {
            return Err(E::BadAccount.into());
        }
        {
            let ld = link.try_borrow_data()?;
            let rec = resident_binding::read(&ld).ok_or(E::BadAccount)?;
            if !resident_binding::matches(
                &rec,
                asset.key.as_array(),
                resident.key.as_array(),
                citizen.key.as_array(),
            ) {
                return Err(E::BadAccount.into());
            }
        }
        let faction = if is_empty(citizen) {
            if ed[N::NATION_RECORDED] != 1 {
                return Err(E::BadAccount.into());
            }
            ed[N::NATION]
        } else {
            citizen_nation(citizen, &game, sid, asset.key)?
        };
        if nation as usize >= FACTIONS
            || faction != nation
            || pd[pool::WINNERS] & (1 << nation) == 0
        {
            return Err(E::NotWinner.into());
        }
        let mut h = leaf_resident(
            &pool_ai.key.to_bytes(),
            asset.key.as_array(),
            nation,
            points,
        );
        for i in 0..n {
            h = node(&h, &rd(d, 14 + 32 * i)?);
        }
        if h != rd::<32>(&pd, pool::SHARES_ROOT)? {
            return Err(E::BadProof.into());
        }
        let prize = u64_at(&pd, pool::PRIZE)?;
        let total = u64_at(&pd, pool::TOTAL_POINTS + 8 * nation as usize)?;
        let amount =
            share_amount(prize, pd[pool::SHARE_NATIONS], points, total).ok_or(E::BadShares)?;
        let claimed = add(u64_at(&pd, pool::CLAIMED)?, amount)?;
        if claimed > prize {
            return Err(E::Overflow.into());
        }
        put(&mut pd, pool::CLAIMED, &claimed.to_le_bytes())?;
        let c = u32_at(&pd, pool::CLAIMS)?
            .checked_add(1)
            .ok_or(E::Overflow)?;
        put(&mut pd, pool::CLAIMS, &c.to_le_bytes())?;
        ed[N::CLAIMED] = 1;
        put(&mut ed, N::CLAIM_AMOUNT, &amount.to_le_bytes())?;
        put(&mut ed, N::CLAIMED_BY, owner.key.as_ref())?;
        put(&mut ed, N::CLAIM_GENERATION, &generation.to_le_bytes())?;
        let sid_le = sid.to_le_bytes();
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
                Some(&[POOL_SEED, game.as_ref(), &sid_le, &[bump]]),
            )?;
        }
        msg!(
            "PRIZE claim-nft asset={} owner={} gen={} points={} amount={}",
            asset.key,
            owner.key,
            generation,
            points,
            amount
        );
        Ok(())
    }

    /// 10 RecordResidentNation: `[pool] [entry w] [citizen]`, no signer —
    /// RecordNation for an NFT Entry: anyone copies the nation of the pass's
    /// live NFT Citizen (at its address, of the pool's game and season,
    /// marked with the Entry's asset) into the Entry. A repeat is a no-op; a
    /// different nation is refused. It moves nothing.
    pub fn record_resident_nation(program: &Pubkey, a: &[AccountInfo]) -> R<()> {
        use entry_resident as N;
        let [pool_ai, entry_ai, citizen] = a else {
            return Err(ProgramError::NotEnoughAccountKeys);
        };
        pool_of(program, pool_ai)?;
        if entry_ai.owner != program {
            return Err(E::BadAccount.into());
        }
        let pd = pool_ai.try_borrow_data()?;
        let mut ed = entry_ai.try_borrow_mut_data()?;
        if ed.len() != N::SIZE || ed[..8] != N::MAGIC || key_at(&ed, N::POOL)? != *pool_ai.key {
            return Err(E::BadAccount.into());
        }
        let asset = key_at(&ed, N::ASSET)?;
        if entry_resident_address(program, pool_ai.key, &asset).0 != *entry_ai.key {
            return Err(E::BadAccount.into());
        }
        let game = key_at(&pd, pool::GAME_PROGRAM)?;
        let sid = u64_at(&pd, pool::SEASON_ID)?;
        let ctx = AddrCtx {
            season: rd(&pd, pool::SEASON)?,
            program: game.to_bytes(),
        };
        expect_citizen_address(&ctx, &asset, citizen)?;
        let faction = citizen_nation(citizen, &game, sid, &asset)?;
        match ed[N::NATION_RECORDED] {
            0 => {
                ed[N::NATION_RECORDED] = 1;
                ed[N::NATION] = faction;
            }
            1 if ed[N::NATION] == faction => {}
            _ => return Err(E::BadAccount.into()),
        }
        msg!("PRIZE nation-nft asset={} nation={}", asset, faction);
        Ok(())
    }
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
        tag::RECORD_NATION if d.is_empty() => record_nation(program, a),
        // NFT pass (experimental): only with the feature; `BadData` otherwise.
        // PayResident is refused here, before anything is read, written or
        // invoked: a pass's refund right is undecided, so no new pass deposit
        // is taken (`ResidentDepositsDisabled`). The handler stays for the
        // day the rule is decided; nothing dispatches to it.
        #[cfg(feature = "nft-experimental")]
        tag::PAY_RESIDENT => Err(E::ResidentDepositsDisabled.into()),
        #[cfg(feature = "nft-experimental")]
        tag::CLAIM_RESIDENT => resident::claim_resident(program, a, d),
        #[cfg(feature = "nft-experimental")]
        tag::RECORD_RESIDENT_NATION if d.is_empty() => resident::record_resident_nation(program, a),
        _ => Err(E::BadData.into()),
    }
}

/// Open an end-dependent pool only while a finite world is running.
/// An Announced Season already has its final PDA but not its final parameters;
/// Created and pre-genesis Seeded seasons can still be aborted. Opening a
/// payable pool in any of those states could strand its fees.
/// This does not change Pay, Tally, Finalize, Claim or Refund on existing pools.
fn season_ends(sd: &[u8], now_ts: i64) -> R<()> {
    let at = frontier_abi::v2::presets::SEASON_CQ_OFFSET
        + frontier_abi::v2::presets::cq_layout::CONTINUOUS;
    match sd.get(at) {
        Some(0) => {}
        Some(1) => return Err(E::ContinuousSeason.into()),
        _ => return Err(E::BadAccount.into()),
    }
    let status = *sd.get(S::STATUS).ok_or(E::BadAccount)?;
    let genesis_ts = i64::from_le_bytes(rd(sd, S::GENESIS_TS)?);
    if !matches!(status, S::STATUS_SEEDED | S::STATUS_RUNNING) || now_ts < genesis_ts {
        return Err(E::WrongState.into());
    }
    let join_close_bell = u32_at(sd, S::JOIN_CLOSE_BELL)?;
    let end_bell = u32_at(sd, S::END_BELL)?;
    let bell_secs = u32_at(sd, S::BELL_SECS)?;
    if join_close_bell >= end_bell || end_bell > 4_032 || bell_secs == 0 {
        return Err(E::BadParams.into());
    }
    let end_ts = genesis_ts
        .checked_add(i64::from(end_bell) * i64::from(bell_secs))
        .ok_or(E::BadParams)?;
    if now_ts >= end_ts {
        return Err(E::WrongState.into());
    }
    Ok(())
}

/// InitPool's map check: the season's `r_max` (`BadParams` past
/// [`MAX_RING`]) and, map growth, its conquest `r_max_ceiling` (0: no
/// extension; `CeilingPastTally` past [`MAX_RING`]).
fn season_rings_fit(sd: &[u8]) -> R<()> {
    if u16_at(sd, S::R_MAX)? > MAX_RING {
        return Err(E::BadParams.into());
    }
    let ceiling = u16_at(
        sd,
        frontier_abi::v2::presets::SEASON_CQ_OFFSET
            + frontier_abi::v2::presets::cq_layout::R_MAX_CEILING,
    )?;
    if ceiling > MAX_RING {
        return Err(E::CeilingPastTally.into());
    }
    Ok(())
}

#[cfg(not(feature = "no-entrypoint"))]
solana_program::entrypoint!(process_instruction);

#[cfg(test)]
mod tests {
    use super::*;

    /// Map growth: a ceiling past ring 17 is refused by name; up to 17 (or
    /// none) is taken; `r_max` past 17 stays `BadParams`.
    #[test]
    fn the_map_must_fit_the_tally_ceiling_included() {
        let at = frontier_abi::v2::presets::SEASON_CQ_OFFSET
            + frontier_abi::v2::presets::cq_layout::R_MAX_CEILING;
        let season = |r_max: u16, ceiling: u16| {
            let mut d = vec![0u8; S::SIZE];
            d[S::R_MAX..S::R_MAX + 2].copy_from_slice(&r_max.to_le_bytes());
            d[at..at + 2].copy_from_slice(&ceiling.to_le_bytes());
            d
        };
        assert_eq!(season_rings_fit(&season(16, 0)), Ok(()));
        assert_eq!(season_rings_fit(&season(16, 17)), Ok(()));
        assert_eq!(
            season_rings_fit(&season(16, 18)),
            Err(E::CeilingPastTally.into())
        );
        assert_eq!(
            season_rings_fit(&season(16, 128)),
            Err(E::CeilingPastTally.into())
        );
        assert_eq!(season_rings_fit(&season(18, 0)), Err(E::BadParams.into()));
        assert_eq!(MAX_RING, 17);
    }

    #[test]
    fn old_pool_needs_a_running_finite_world() {
        let at = frontier_abi::v2::presets::SEASON_CQ_OFFSET
            + frontier_abi::v2::presets::cq_layout::CONTINUOUS;
        let mut season = vec![0u8; S::SIZE];
        assert_eq!(season_ends(&season, 0), Err(E::WrongState.into()));
        season[S::STATUS] = S::STATUS_CREATED;
        assert_eq!(season_ends(&season, 0), Err(E::WrongState.into()));
        season[S::STATUS] = S::STATUS_SEEDED;
        season[S::GENESIS_TS..S::GENESIS_TS + 8].copy_from_slice(&10i64.to_le_bytes());
        assert_eq!(season_ends(&season, 0), Err(E::WrongState.into()));
        season[S::GENESIS_TS..S::GENESIS_TS + 8].copy_from_slice(&0i64.to_le_bytes());
        assert_eq!(season_ends(&season, 0), Err(E::BadParams.into()));
        season[S::JOIN_CLOSE_BELL..S::JOIN_CLOSE_BELL + 4].copy_from_slice(&324u32.to_le_bytes());
        season[S::END_BELL..S::END_BELL + 4].copy_from_slice(&432u32.to_le_bytes());
        season[S::BELL_SECS..S::BELL_SECS + 4].copy_from_slice(&600u32.to_le_bytes());
        for status in [S::STATUS_SEEDED, S::STATUS_RUNNING] {
            season[S::STATUS] = status;
            assert_eq!(season_ends(&season, 0), Ok(()));
        }
        assert_eq!(season_ends(&season, 432 * 600), Err(E::WrongState.into()));
        // A zero join deadline is legal for an already-created finite world.
        season[S::JOIN_CLOSE_BELL..S::JOIN_CLOSE_BELL + 4].copy_from_slice(&0u32.to_le_bytes());
        assert_eq!(season_ends(&season, 0), Ok(()));
        season[at] = 1;
        assert_eq!(season_ends(&season, 0), Err(E::ContinuousSeason.into()));
        season[at] = 2;
        assert_eq!(season_ends(&season, 0), Err(E::BadAccount.into()));
        assert_eq!(season_ends(&season[..at], 0), Err(E::BadAccount.into()));
        season[at] = 0;
        season[S::STATUS] = S::STATUS_ENDED;
        assert_eq!(season_ends(&season, 0), Err(E::WrongState.into()));
        season[S::STATUS] = 255;
        assert_eq!(season_ends(&season, 0), Err(E::WrongState.into()));
        season[S::STATUS] = S::STATUS_RUNNING;
        season[S::END_BELL..S::END_BELL + 4].copy_from_slice(&u32::MAX.to_le_bytes());
        assert_eq!(season_ends(&season, 0), Err(E::BadParams.into()));
    }

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
        assert_eq!(
            winners(&[10, 10, 9, 9, 8, 8], &[5, 7, 99, 0, 0, 0]),
            0b000010
        );
        // tie on both: both
        assert_eq!(
            winners(&[10, 10, 9, 9, 8, 8], &[7, 7, 99, 0, 0, 0]),
            0b000011
        );
        // the decided rule alone never looks at territory bells
        assert_eq!(largest_area(&[10, 10, 9, 9, 8, 8]), 0b000011);
        assert_eq!(largest_area(&[9, 11, 9, 9, 8, 8]), 0b000010);
        assert_eq!(
            provisional::break_tie(0b000011, &[5, 7, 99, 0, 0, 0]),
            0b000010
        );
    }

    #[test]
    fn shares_never_exceed_the_prize() {
        let prize = 16_000_001u64;
        let pts = [10u64, 3, 1];
        let total: u64 = pts.iter().sum();
        let paid: u64 = pts
            .iter()
            .map(|p| share_amount(prize, 1, *p, total).unwrap())
            .sum();
        assert!(paid <= prize && prize - paid < pts.len() as u64);
        assert_eq!(share_amount(prize, 2, 5, 5), Some(prize / 2));
        assert_eq!(share_amount(prize, 1, 6, 5), None);
        assert_eq!(share_amount(prize, 0, 1, 1), None);
        assert_eq!(
            refund_amount(16_000_000, 10_000_000, 20_000_000),
            Some(8_000_000)
        );
        assert_eq!(refund_amount(1, 1, 0), None);
    }

    // NFT pass (experimental): literal bytes only, no key, no I/O.
    #[test]
    fn nft_entry_fields_fit_and_share_the_wallet_entrys_offsets() {
        use entry_resident as N;
        let mut fields = [
            (N::HDR_MAGIC, 8),
            (N::BUMP, 1),
            (N::CLAIMED, 1),
            (N::NATION_RECORDED, 1),
            (N::NATION, 1),
            (N::PAY_GENERATION, 4),
            (N::POOL, 32),
            (N::ASSET, 32),
            (N::AMOUNT, 8),
            (N::PAID_SLOT, 8),
            (N::CLAIM_AMOUNT, 8),
            (N::PAID_BY, 32),
            (N::CLAIMED_BY, 32),
            (N::CLAIM_GENERATION, 4),
        ];
        fields.sort();
        for w in fields.windows(2) {
            assert!(w[0].0 + w[0].1 <= w[1].0, "{:?} overlaps {:?}", w[0], w[1]);
        }
        let last = *fields.last().unwrap();
        assert!(last.0 + last.1 <= N::SIZE);
        // The shared offsets (a reader's convenience), the separating size and magic.
        assert_eq!(
            [N::BUMP, N::CLAIMED, N::NATION_RECORDED, N::NATION],
            [
                entry::BUMP,
                entry::CLAIMED,
                entry::NATION_RECORDED,
                entry::NATION
            ]
        );
        assert_eq!(
            [N::POOL, N::ASSET, N::AMOUNT, N::PAID_SLOT, N::CLAIM_AMOUNT],
            [
                entry::POOL,
                entry::WALLET,
                entry::AMOUNT,
                entry::PAID_SLOT,
                entry::CLAIM_AMOUNT
            ]
        );
        assert_ne!(N::SIZE, entry::SIZE);
        assert_ne!(N::MAGIC, entry::MAGIC);
        assert_ne!(N::MAGIC, pool::MAGIC);
        assert_ne!(ENTRY_RESIDENT_SEED, ENTRY_SEED);
    }

    #[test]
    fn a_pass_leaf_is_never_a_wallet_leaf_or_a_node() {
        let p = [7u8; 32];
        let k = [1u8; 32];
        let l = leaf_resident(&p, &k, 2, 10);
        assert_ne!(l, leaf(&p, &k, 2, 10), "same bytes, different domain");
        assert_ne!(l, leaf_resident(&p, &k, 3, 10));
        assert_ne!(l, leaf_resident(&p, &k, 2, 11));
        assert_ne!(l, leaf_resident(&p, &[2; 32], 2, 10));
        assert_ne!(l, leaf_resident(&[8; 32], &k, 2, 10));
        // A proof step over a wallet leaf and a pass leaf is the same node
        // either way (one root holds both kinds).
        let w = leaf(&p, &[3; 32], 2, 4);
        assert_eq!(node(&l, &w), node(&w, &l));
        assert_ne!(node(&l, &w), l);
    }

    #[test]
    fn the_pass_error_numbers_are_the_allocated_band() {
        let band = [
            PrizeError::ResidentNotSigned,
            PrizeError::ResidentAsset,
            PrizeError::ResidentAccount,
            PrizeError::ResidentUnguarded,
            PrizeError::ResidentStaleGeneration,
            PrizeError::ResidentNotCurrentAuthority,
            PrizeError::ResidentPolicy,
            PrizeError::ResidentRefundUndecided,
            PrizeError::ResidentDepositsDisabled,
        ];
        for (e, code) in band.iter().zip(0x113u32..) {
            assert_eq!(*e as u32, code, "{e:?}");
        }
        // 0x111 stays free (⑧'s proposal); 0x112 is ContinuousSeason.
        assert_eq!(PrizeError::ContinuousSeason as u32, 0x112);
        assert_eq!(
            [
                tag::PAY_RESIDENT,
                tag::CLAIM_RESIDENT,
                tag::RECORD_RESIDENT_NATION
            ],
            [8, 9, 10]
        );
    }

    #[test]
    fn merkle_pairs_are_sorted() {
        let p = [7u8; 32];
        let a = leaf(&p, &[1; 32], 2, 10);
        let b = leaf(&p, &[2; 32], 2, 3);
        assert_eq!(node(&a, &b), node(&b, &a));
        // The vectors the JS SDK pins (permutation-gateway/test/frontier-prize.test.mjs).
        let hex = |h: [u8; 32]| h.iter().map(|x| format!("{x:02x}")).collect::<String>();
        assert_eq!(
            hex(a),
            "ae1f8f256f5c65762ac65c7a2bf12f69d6e7e4fdc870d74fd0da943da34c6e64"
        );
        assert_eq!(
            hex(node(&a, &b)),
            "fc71c2545a8a38c0bc74f5b24ab1d559fdfb6d0385fb5a594b4c9d78bc83c0e3"
        );
        assert_ne!(a, leaf(&p, &[1; 32], 3, 10));
        assert_ne!(a, leaf(&p, &[1; 32], 2, 11));
    }
}
