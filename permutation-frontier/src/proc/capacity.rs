//! **Preview** (`capacity-preview`): workstream 09's instructions, lending
//! a workshop's processing capacity (`frontier_abi::capacity`, tags
//! 0xF0–0xFD, workstream 4's provisional allocation).
//!
//! | Tag | Instruction | Here |
//! |---|---|---|
//! | 0xF0 | OpenCapacityPool | [`open_pool`] |
//! | 0xF1 / 0xF2 | LendCapacity / ReclaimCapacity | [`lend`] |
//! | 0xF3 | GrantCapacity | [`grant`] |
//! | 0xF4 | RevokeCapacity | [`revoke`] |
//! | 0xF5 | ReserveCapacity | [`reserve`] |
//! | 0xF6 | DepositToJob | [`deposit`] |
//! | 0xF7 | SettleJob | [`settle`] |
//! | 0xF8 | CancelJob | [`cancel`] |
//! | 0xF9 | ClaimJob | [`claim`] |
//! | 0xFA | RecordFacilityLoss | [`lose`] |
//! | 0xFB / 0xFC / 0xFD | RetireJob / RetireGrant / RetirePool | [`retire`] |
//!
//! Every check is the rules' (`permutation_rules::frontier::capacity`,
//! proven equal to workstream 09's kernel by its differential test), run
//! once per instruction on the accounts as read; this file reads and
//! writes the accounts and moves the goods the rules' events name:
//!
//! - **Holding** (the facility, the core's): its generation, owner and
//!   capture record decide whether the pool is live and when its
//!   generation ended; Lend and Reclaim change its own production
//!   (`Holding::lend_workshops`, core patch 0001); a captor's share of a
//!   loss goes into its stores.
//! - **The user's Vault** in the facility's province (S1's): DepositToJob
//!   takes the goods from its stores, ClaimJob puts the products and the
//!   unused materials back (refused whole, `Custody`, if they do not fit).
//!   Goods from another owner's lot (workstream 10's custody) are not wired
//!   here yet.
//! - **CapacityPool / CapacityJob** (this preview's accounts, with-seed
//!   addresses off the Season as every v2 account): created by
//!   OpenCapacityPool and ReserveCapacity, closed by RetireJob and
//!   RetirePool, the rent back to who paid it.
//!
//! **Not here (undecided or unallocated).** No PS2 record: workstream 09's
//! record kinds are not allocated, so a capacity build's Season is not
//! verifiable for these instructions. The end of a released generation and
//! of one that advanced twice before the loss was recorded cannot be read
//! from the Holding: RecordFacilityLoss refuses them (`NotImplemented`).
//! The owner's and the user's instructions run the deployed player
//! prologue, which refuses them after the season's end bell (workstream
//! 09's continuity note R1 asks workstream 4 not to).

extern crate alloc;

use alloc::vec::Vec;

use solana_program::{account_info::AccountInfo, program_error::ProgramError, pubkey::Pubkey};

use frontier_abi::capacity::{self as fc, CapData, CapIx};
use frontier_abi::prologue::Group;
use frontier_abi::v2::layout::s1::vault as VA;
use frontier_abi::v2::layout::AccountKind as K2;
use permutation_rules::frontier::capacity::{self as cap, CapError, Done, Event, Key};
use permutation_rules::frontier::holding::{Holding as KHolding, Resource, RESOURCES};

use super::conquest::present_v2;
use super::holding::{self as hold, read_holding, write_holding, Player};
use crate::error::{Error, BAD_ACCOUNT};
use crate::init::{self, SeasonSigner, Sink};
use crate::layout::{holding2 as H, season2 as S, Ro, Rw};
use crate::prologue::{self, check_accounts, expect_key, key, IxTable};
use crate::{addr, FrontierError, R};

impl IxTable for CapIx {
    fn groups(self) -> &'static [Group] {
        fc::accounts_of(self)
    }
    fn top_level_only(self) -> bool {
        CapIx::top_level_only(self)
    }
}

/// A refusal of the rules as the program's error (`109 + code`).
fn cap_err(e: CapError) -> Error {
    Error::Program(ProgramError::Custom(fc::program_error(e.code())))
}

const POOL_SPACE: usize = cap::layout::pool::SIZE + fc::RENT_TO_LEN;
/// A job account: the rules' record, its rent payer, then its [`Link`].
const LINK_AT: usize = cap::layout::job::SIZE + fc::RENT_TO_LEN;
const LINK_LEN: usize = 1 + 32 + 8 + 8 + 8;
pub(crate) const JOB_SPACE: usize = LINK_AT + LINK_LEN;

/// A job fed from another owner's lot (workstream 10): which lot, the ore
/// taken from it, given back into it, and owed to it (taken back from the
/// job but not yet in the lot: a sub-unit rest, or whole units a frozen or
/// full lot could not take). The goods a lot lends a job are the lot's:
/// what the job does not use goes back (the owner's decision of
/// 2026-11-06), never to the user.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct Link {
    pub fed: bool,
    pub lot: Key,
    pub taken: i64,
    pub returned: i64,
    pub owed: i64,
}

pub(crate) fn link_of(d: &[u8]) -> R<Link> {
    let r = Ro(d);
    let fed = match r.u8(LINK_AT)? {
        0 => false,
        1 => true,
        _ => return Err(BAD_ACCOUNT),
    };
    Ok(Link {
        fed,
        lot: r.arr(LINK_AT + 1)?,
        taken: r.i64(LINK_AT + 33)?,
        returned: r.i64(LINK_AT + 41)?,
        owed: r.i64(LINK_AT + 49)?,
    })
}

fn put_link(ai: &AccountInfo, l: &Link) -> R<()> {
    let mut d = ai.try_borrow_mut_data()?;
    let mut w = Rw(&mut d);
    w.set_u8(LINK_AT, l.fed as u8)?;
    w.set_arr(LINK_AT + 1, &l.lot)?;
    w.set_i64(LINK_AT + 33, l.taken)?;
    w.set_i64(LINK_AT + 41, l.returned)?;
    w.set_i64(LINK_AT + 49, l.owed)
}

/// Routes one capacity instruction.
pub fn dispatch(p: &Pubkey, a: &[AccountInfo], d: &[u8]) -> R<()> {
    let x = CapData::decode(d)?;
    match x.ix() {
        CapIx::OpenCapacityPool => open_pool(p, a, x),
        CapIx::LendCapacity | CapIx::ReclaimCapacity => lend(p, a, x),
        CapIx::GrantCapacity => grant(p, a, x),
        CapIx::RevokeCapacity => revoke(p, a, x),
        CapIx::ReserveCapacity => reserve(p, a, x),
        CapIx::DepositToJob => deposit(p, a, x),
        CapIx::SettleJob => settle(p, a, x),
        CapIx::CancelJob => cancel(p, a, x),
        CapIx::ClaimJob => claim(p, a, x),
        CapIx::RecordFacilityLoss => lose(p, a),
        CapIx::RetireJob | CapIx::RetireGrant | CapIx::RetirePool => retire(p, a, x),
    }
}

// ------------------------------------------------------------ season

/// A Season of another program version (another build's) is refused.
fn this_build(season: &AccountInfo) -> R<()> {
    let v = Ro(&season.try_borrow_data()?).u16(S::PROGRAM_VERSION)?;
    if v != crate::PROGRAM_VERSION {
        return Err(FrontierError::RulesetMismatch.into());
    }
    Ok(())
}

/// Anyone's instructions: the keeper prologue over a Running or Ended
/// Season of this build.
fn keeper(p: &Pubkey, a: &[AccountInfo]) -> R<(addr::AddrCtx, u64, i64)> {
    let now = prologue::now()?;
    let hdr = prologue::keeper(a, p, &[S::STATUS_RUNNING, S::STATUS_ENDED], now.ts)?;
    let season = a.get(1).ok_or(FrontierError::TooManyAccounts)?;
    this_build(season)?;
    Ok((addr::ctx(&key(season), &p.to_bytes()), hdr.id, now.ts))
}

/// The owner's and the user's instructions: the deployed player prologue
/// (wallet or session), then this build's Season. The signer is the
/// Citizen.
fn player(p: &Pubkey, a: &[AccountInfo]) -> R<(Player, Key)> {
    let pl = hold::player_as(p, a, &super::Auth::Wallet)?;
    let season = a.get(2).ok_or(FrontierError::TooManyAccounts)?;
    this_build(season)?;
    let citizen = a.get(3).ok_or(FrontierError::TooManyAccounts)?;
    Ok((pl, key(citizen)))
}

// ------------------------------------------------------------ facility

/// The facility as its Holding tells it.
struct Fac {
    p: i16,
    q: i16,
    site: u8,
    gen: u8,
    owner: Key,
    prev_gen: u8,
    captured_bell: u32,
}

impl Fac {
    /// The rules' view for a pool of generation `gen` (`genesis_ts`: the
    /// season clock, to date a capture by its bell).
    fn view(&self, gen: u8, genesis_ts: i64) -> cap::Facility {
        let end = if self.gen != gen && self.prev_gen == gen && self.captured_bell != 0 {
            Some((
                genesis_ts.saturating_add(600 * self.captured_bell as i64),
                Some(self.owner),
            ))
        } else {
            None
        };
        cap::Facility {
            gen: self.gen,
            owner: self.owner,
            // A wrapped generation needs the facility's history, which no
            // account keeps; a pool of the same number is refused once lost
            // (`GenerationReused`, the rules' OpenCapacityPool).
            reused: false,
            end,
        }
    }

    /// The end of generation `gen` is known (or it has not ended).
    fn dated(&self, gen: u8) -> bool {
        self.gen == gen || (self.prev_gen == gen && self.captured_bell != 0)
    }
}

fn facility(p: &Pubkey, ctx: &addr::AddrCtx, sid: u64, ai: &AccountInfo) -> R<Fac> {
    present_v2(ai, p, K2::Holding, sid)?;
    let d = ai.try_borrow_data()?;
    let r = Ro(&d);
    let f = Fac {
        p: r.i16(H::P)?,
        q: r.i16(H::Q)?,
        site: r.u8(H::SITE)?,
        gen: r.u8(H::GEN)?,
        owner: r.arr(H::OWNER_CITIZEN)?,
        prev_gen: r.u8(H::PREV_GEN)?,
        captured_bell: r.u32(H::CAPTURED_BELL)?,
    };
    expect_key(ai, &ctx.holding(f.p as i32, f.q as i32, f.site))?;
    Ok(f)
}

fn genesis_of(season: &AccountInfo) -> R<i64> {
    Ro(&season.try_borrow_data()?).i64(S::GENESIS_TS)
}

// ------------------------------------------------------------ accounts

fn pool_at(p: &Pubkey, ctx: &addr::AddrCtx, ai: &AccountInfo) -> R<cap::Pool> {
    if init::is_absent(ai) {
        return Err(cap_err(CapError::UnknownPool));
    }
    if ai.owner != p {
        return Err(BAD_ACCOUNT);
    }
    let pool = cap::Pool::decode(&ai.try_borrow_data()?).ok_or(BAD_ACCOUNT)?;
    let f = pool.facility;
    expect_key(ai, &fc::pool(ctx, f.p, f.q, f.site, f.gen))?;
    Ok(pool)
}

/// The pool is this facility's (the Holding of its site).
fn pool_of(pool: &cap::Pool, f: &Fac) -> R<()> {
    let id = pool.facility;
    if (id.p, id.q, id.site) != (f.p, f.q, f.site) {
        return Err(BAD_ACCOUNT);
    }
    Ok(())
}

fn put_pool(ai: &AccountInfo, pool: &cap::Pool) -> R<()> {
    pool.encode(&mut ai.try_borrow_mut_data()?)
        .ok_or(BAD_ACCOUNT)
}

/// The job `(grant, job)` of `pool` at its address, or `None` when absent.
fn job_at(
    p: &Pubkey,
    ctx: &addr::AddrCtx,
    pool: &cap::Pool,
    ai: &AccountInfo,
    grant: u32,
    job: u32,
) -> R<Option<cap::Job>> {
    let f = pool.facility;
    expect_key(ai, &fc::job(ctx, f.p, f.q, f.site, f.gen, grant, job))?;
    if init::is_absent(ai) {
        return Ok(None);
    }
    if ai.owner != p {
        return Err(BAD_ACCOUNT);
    }
    let j = cap::Job::decode(&ai.try_borrow_data()?).ok_or(BAD_ACCOUNT)?;
    if (j.grant, j.seq) != (grant, job) {
        return Err(BAD_ACCOUNT);
    }
    Ok(Some(j))
}

/// A present job account of `pool`, whichever it is (RevokeCapacity and
/// RecordFacilityLoss list them; the rules check the set).
fn any_job(p: &Pubkey, ctx: &addr::AddrCtx, pool: &cap::Pool, ai: &AccountInfo) -> R<cap::Job> {
    if ai.owner != p || init::is_absent(ai) {
        return Err(BAD_ACCOUNT);
    }
    let j = cap::Job::decode(&ai.try_borrow_data()?).ok_or(BAD_ACCOUNT)?;
    job_at(p, ctx, pool, ai, j.grant, j.seq)?.ok_or(BAD_ACCOUNT)
}

fn put_job(ai: &AccountInfo, j: &cap::Job) -> R<()> {
    j.encode(&mut ai.try_borrow_mut_data()?).ok_or(BAD_ACCOUNT)
}

fn rent_to_of(ai: &AccountInfo, size: usize) -> R<Key> {
    Ro(&ai.try_borrow_data()?).arr(size)
}

fn set_rent_to(ai: &AccountInfo, size: usize, payer: &AccountInfo) -> R<()> {
    let mut d = ai.try_borrow_mut_data()?;
    d.get_mut(size..size + fc::RENT_TO_LEN)
        .ok_or(BAD_ACCOUNT)?
        .copy_from_slice(payer.key.as_ref());
    Ok(())
}

/// Creates a capacity account at its with-seed address, paid by `payer`.
#[allow(clippy::too_many_arguments)]
fn create<'a>(
    p: &Pubkey,
    pl: &Player,
    payer: &AccountInfo<'a>,
    season: &AccountInfo<'a>,
    target: &AccountInfo<'a>,
    seed: &frontier_abi::addr::Seed,
    space: usize,
) -> R<()> {
    let signer = SeasonSigner::new(pl.pc.season.id, pl.pc.season.bump);
    let rent = init::rent(space)?;
    init::init_with_seed(payer, target, season, &signer, seed, space, rent, p)
}

// ------------------------------------------------------------ the user's vault

/// The user's vault in the facility's province: live, the user's
/// (`NotOwner`), on a tile of that province (`BadAddress`).
struct UserVault {
    stores: [i64; RESOURCES],
    quota: [i64; RESOURCES],
    cap: i64,
    tag: u64,
}

fn user_vault(
    p: &Pubkey,
    ctx: &addr::AddrCtx,
    sid: u64,
    ai: &AccountInfo,
    user: &Key,
    f: &Fac,
) -> R<UserVault> {
    present_v2(ai, p, K2::Vault, sid)?;
    let d = ai.try_borrow_data()?;
    let r = Ro(&d);
    let (vp, vq, tile) = (r.i16(VA::P)?, r.i16(VA::Q)?, r.u8(VA::TILE)?);
    expect_key(
        ai,
        &frontier_abi::v2::addr::vault(ctx, vp as i32, vq as i32, tile),
    )?;
    if r.u8(VA::STATE)? != VA::STATE_LIVE {
        return Err(BAD_ACCOUNT);
    }
    if r.arr::<32>(VA::OWNER_CITIZEN)? != *user {
        return Err(FrontierError::NotOwner.into());
    }
    if (vp, vq) != (f.p, f.q) {
        return Err(FrontierError::BadAddress.into());
    }
    let mut v = UserVault {
        stores: [0; RESOURCES],
        quota: [0; RESOURCES],
        cap: r.i64(VA::CAP)?,
        tag: u64::from_le_bytes(ai.key.as_ref()[..8].try_into().map_err(|_| BAD_ACCOUNT)?),
    };
    for i in 0..RESOURCES {
        v.stores[i] = r.i64(VA::store(i))?;
        v.quota[i] = r.i64(VA::custody_quota(i))?;
    }
    Ok(v)
}

impl UserVault {
    fn take(&mut self, r: Resource, amount: i64) -> R<()> {
        let s = &mut self.stores[r as usize];
        *s = s
            .checked_sub(amount)
            .filter(|x| *x >= 0)
            .ok_or(cap_err(CapError::Custody))?;
        Ok(())
    }

    /// `STORES + CUSTODY_QUOTA ≤ CAP` after the credit (`Custody`).
    fn put(&mut self, r: Resource, amount: i64) -> R<()> {
        let i = r as usize;
        let next = self.stores[i]
            .checked_add(amount)
            .ok_or(cap_err(CapError::Overflow))?;
        if next.saturating_add(self.quota[i]) > self.cap {
            return Err(cap_err(CapError::Custody));
        }
        self.stores[i] = next;
        Ok(())
    }

    fn write(&self, ai: &AccountInfo) -> R<()> {
        let mut d = ai.try_borrow_mut_data()?;
        let mut w = Rw(&mut d);
        for i in 0..RESOURCES {
            w.set_i64(VA::store(i), self.stores[i])?;
        }
        Ok(())
    }
}

fn events(done: Done) -> Option<Vec<Event>> {
    match done {
        Done::Applied(ev) => Some(ev),
        Done::Already => None,
    }
}

// ------------------------------------------------------------ 0xF0

/// 0xF0 OpenCapacityPool(policies): the Holding's owner opens the pool of
/// its current generation.
pub fn open_pool(p: &Pubkey, a: &[AccountInfo], x: CapData) -> R<()> {
    check_accounts(CapIx::OpenCapacityPool, a, None)?;
    let CapData::OpenCapacityPool { policies } = x else {
        return Err(FrontierError::BadData.into());
    };
    let policies = cap::Policies::decode(policies).ok_or(FrontierError::BadData)?;
    let (pl, signer) = player(p, a)?;
    let [_, payer, season, _citizen, holding, pool_ai, _system] = a else {
        return Err(FrontierError::TooManyAccounts.into());
    };
    let sid = pl.pc.season.id;
    let f = facility(p, &pl.ctx, sid, holding)?;
    let id = cap::FacilityId {
        p: f.p,
        q: f.q,
        site: f.site,
        gen: f.gen,
    };
    expect_key(pool_ai, &fc::pool(&pl.ctx, f.p, f.q, f.site, f.gen))?;
    let existing = if init::is_absent(pool_ai) {
        None
    } else {
        Some(pool_at(p, &pl.ctx, pool_ai)?)
    };
    let (new, _) = cap::open_pool(
        existing.as_ref(),
        &f.view(f.gen, pl.pc.season.genesis_ts),
        &signer,
        id,
        policies,
    )
    .map_err(cap_err)?;
    if let Some(pool) = new {
        create(
            p,
            &pl,
            payer,
            season,
            pool_ai,
            &fc::pool_seed(f.p, f.q, f.site, f.gen),
            POOL_SPACE,
        )?;
        put_pool(pool_ai, &pool)?;
        set_rent_to(pool_ai, cap::layout::pool::SIZE, payer)?;
    }
    Ok(())
}

// ------------------------------------------------------------ 0xF1 / 0xF2

/// 0xF1 LendCapacity / 0xF2 ReclaimCapacity(units, seq): the owner moves
/// workshop copies between the Holding's own production and the pool.
pub fn lend(p: &Pubkey, a: &[AccountInfo], x: CapData) -> R<()> {
    let (lend, units, seq) = match x {
        CapData::LendCapacity { units, seq } => (true, units, seq),
        CapData::ReclaimCapacity { units, seq } => (false, units, seq),
        _ => return Err(FrontierError::BadData.into()),
    };
    check_accounts(x.ix(), a, None)?;
    let (pl, signer) = player(p, a)?;
    let [_, _payer, _season, _citizen, holding, pool_ai] = a else {
        return Err(FrontierError::TooManyAccounts.into());
    };
    let sid = pl.pc.season.id;
    let f = facility(p, &pl.ctx, sid, holding)?;
    let mut pool = pool_at(p, &pl.ctx, pool_ai)?;
    pool_of(&pool, &f)?;
    let now = pl.now.ts;
    let mut h: KHolding = read_holding(&holding.try_borrow_data()?)?;
    let view = f.view(pool.facility.gen, pl.pc.season.genesis_ts);
    let done =
        cap::lend(&mut pool, &mut h, &view, now, &signer, lend, units, seq).map_err(cap_err)?;
    if events(done).is_some() {
        write_holding(&mut holding.try_borrow_mut_data()?, &h, now)?;
        put_pool(pool_ai, &pool)?;
    }
    Ok(())
}

// ------------------------------------------------------------ 0xF3 / 0xF4

/// 0xF3 GrantCapacity: the owner grants a user (a Citizen) copies of the
/// pool under a recipe, a window and caps.
pub fn grant(p: &Pubkey, a: &[AccountInfo], x: CapData) -> R<()> {
    check_accounts(CapIx::GrantCapacity, a, None)?;
    let CapData::GrantCapacity {
        grant,
        user,
        recipe,
        max_units,
        max_output,
        from,
        until,
    } = x
    else {
        return Err(FrontierError::BadData.into());
    };
    let (pl, signer) = player(p, a)?;
    let [_, _payer, _season, _citizen, holding, pool_ai] = a else {
        return Err(FrontierError::TooManyAccounts.into());
    };
    let f = facility(p, &pl.ctx, pl.pc.season.id, holding)?;
    let mut pool = pool_at(p, &pl.ctx, pool_ai)?;
    pool_of(&pool, &f)?;
    let view = f.view(pool.facility.gen, pl.pc.season.genesis_ts);
    let g = cap::Grant {
        seq: grant,
        user,
        recipe,
        max_units,
        max_output,
        from,
        until,
        revoked_at: None,
        spent: 0,
        last_job_seq: None,
    };
    if events(cap::grant(&mut pool, &view, pl.now.ts, &signer, g).map_err(cap_err)?).is_some() {
        put_pool(pool_ai, &pool)?;
    }
    Ok(())
}

/// 0xF4 RevokeCapacity(grant): under CancelBooked, the grant's booked jobs
/// follow the pool's accounts, in the pool's order.
pub fn revoke(p: &Pubkey, a: &[AccountInfo], x: CapData) -> R<()> {
    let CapData::RevokeCapacity { grant } = x else {
        return Err(FrontierError::BadData.into());
    };
    let n = a
        .len()
        .checked_sub(6)
        .ok_or(FrontierError::TooManyAccounts)?;
    check_accounts(CapIx::RevokeCapacity, a, Some(&[1, n as u8]))?;
    let (pl, signer) = player(p, a)?;
    let [_, _payer, _season, _citizen, holding, pool_ai, jobs @ ..] = a else {
        return Err(FrontierError::TooManyAccounts.into());
    };
    let f = facility(p, &pl.ctx, pl.pc.season.id, holding)?;
    let mut pool = pool_at(p, &pl.ctx, pool_ai)?;
    pool_of(&pool, &f)?;
    let view = f.view(pool.facility.gen, pl.pc.season.genesis_ts);
    let mut js = jobs
        .iter()
        .map(|ai| any_job(p, &pl.ctx, &pool, ai))
        .collect::<R<Vec<cap::Job>>>()?;
    let mut refs: Vec<&mut cap::Job> = js.iter_mut().collect();
    let done =
        cap::revoke(&mut pool, &view, pl.now.ts, &signer, grant, &mut refs).map_err(cap_err)?;
    if events(done).is_some() {
        put_pool(pool_ai, &pool)?;
        for (ai, j) in jobs.iter().zip(js.iter()) {
            put_job(ai, j)?;
        }
    }
    Ok(())
}

// ------------------------------------------------------------ 0xF5

/// 0xF5 ReserveCapacity: the grant's user books copies for a window; the
/// job's account is created, paid by the payer.
pub fn reserve(p: &Pubkey, a: &[AccountInfo], x: CapData) -> R<()> {
    check_accounts(CapIx::ReserveCapacity, a, None)?;
    let CapData::ReserveCapacity {
        grant,
        job,
        units,
        start,
        end,
        max_output,
    } = x
    else {
        return Err(FrontierError::BadData.into());
    };
    let (pl, signer) = player(p, a)?;
    let [_, payer, season, _citizen, holding, pool_ai, job_ai, _system] = a else {
        return Err(FrontierError::TooManyAccounts.into());
    };
    let f = facility(p, &pl.ctx, pl.pc.season.id, holding)?;
    let mut pool = pool_at(p, &pl.ctx, pool_ai)?;
    pool_of(&pool, &f)?;
    let view = f.view(pool.facility.gen, pl.pc.season.genesis_ts);
    let existing = job_at(p, &pl.ctx, &pool, job_ai, grant, job)?;
    let now = pl.now.ts;
    let dormant = read_holding(&holding.try_borrow_data()?)?.is_dormant(now);
    let (new, _) = cap::reserve(
        &mut pool,
        &view,
        dormant,
        existing.as_ref(),
        now,
        &signer,
        grant,
        job,
        units,
        start,
        end,
        max_output,
    )
    .map_err(cap_err)?;
    if let Some(j) = new {
        let id = pool.facility;
        create(
            p,
            &pl,
            payer,
            season,
            job_ai,
            &fc::job_seed(id.p, id.q, id.site, id.gen, grant, job),
            JOB_SPACE,
        )?;
        put_job(job_ai, &j)?;
        set_rent_to(job_ai, cap::layout::job::SIZE, payer)?;
        put_pool(pool_ai, &pool)?;
    }
    Ok(())
}

// ------------------------------------------------------------ 0xF6 / 0xF9

/// 0xF6 DepositToJob: goods into the job (before it starts), from the
/// user's own vault in the facility's province, or (custody builds) from
/// another owner's lot in a vault of that province under its use order
/// for the user. A job takes each input from one source (workstream 09's
/// MixedSource: the mixed case is undecided and refused, `NotImplemented`).
pub fn deposit(p: &Pubkey, a: &[AccountInfo], x: CapData) -> R<()> {
    let n = a
        .len()
        .checked_sub(8)
        .ok_or(FrontierError::TooManyAccounts)?;
    check_accounts(CapIx::DepositToJob, a, Some(&[1, n as u8]))?;
    let CapData::DepositToJob {
        grant,
        job,
        deposit,
        resource,
        amount,
        source,
        slot,
        order,
    } = x
    else {
        return Err(FrontierError::BadData.into());
    };
    let resource = *Resource::ALL
        .get(resource as usize)
        .ok_or(FrontierError::BadData)?;
    let (pl, signer) = player(p, a)?;
    let [_, _payer, _season, citizen, holding, pool_ai, job_ai, vault, lot @ ..] = a else {
        return Err(FrontierError::TooManyAccounts.into());
    };
    let sid = pl.pc.season.id;
    let f = facility(p, &pl.ctx, sid, holding)?;
    let mut pool = pool_at(p, &pl.ctx, pool_ai)?;
    pool_of(&pool, &f)?;
    let view = f.view(pool.facility.gen, pl.pc.season.genesis_ts);
    let mut j = job_at(p, &pl.ctx, &pool, job_ai, grant, job)?;
    let mut link = match j {
        Some(_) => link_of(&job_ai.try_borrow_data()?)?,
        None => Link::default(),
    };
    let ore = Resource::Ore;
    if source == fc::SOURCE_LOT {
        let [lot] = lot else {
            return Err(FrontierError::TooManyAccounts.into());
        };
        return lots::deposit(
            p,
            &pl,
            citizen,
            &f,
            &mut pool,
            &view,
            j.as_mut(),
            &mut link,
            (grant, job),
            vault,
            lot,
            (deposit, resource, amount, slot, order),
            pool_ai,
            job_ai,
        );
    }
    if !lot.is_empty() {
        return Err(FrontierError::TooManyAccounts.into());
    }
    if link.fed && resource == ore {
        // Own ore into a job fed from a lot: two sources (undecided).
        return Err(FrontierError::NotImplemented.into());
    }
    let mut v = user_vault(p, &pl.ctx, sid, vault, &signer, &f)?;
    let done = cap::deposit(
        &mut pool,
        &view,
        j.as_mut(),
        (grant, job),
        pl.now.ts,
        &signer,
        deposit,
        resource,
        amount,
        v.tag,
    )
    .map_err(cap_err)?;
    let Some(ev) = events(done) else {
        return Ok(());
    };
    for e in &ev {
        if let Event::Deposited {
            resource, amount, ..
        } = *e
        {
            v.take(resource, amount)?;
        }
    }
    v.write(vault)?;
    put_job(job_ai, j.as_ref().ok_or(BAD_ACCOUNT)?)?;
    put_pool(pool_ai, &pool)
}

/// 0xF9 ClaimJob: what the job made and, once final, what it did not use,
/// into the user's vault in the facility's province. For a job fed from a
/// lot (the lot and its vault listed after): the products and the user's
/// wood go to the user, the ore it did not use back into the lot (whole
/// units; the rest, or what a frozen or full lot cannot take, stays owed
/// in the job and is paid by a later ClaimJob).
pub fn claim(p: &Pubkey, a: &[AccountInfo], x: CapData) -> R<()> {
    let n = a
        .len()
        .checked_sub(8)
        .ok_or(FrontierError::TooManyAccounts)?;
    // The lot's pair `[lot_vault, lot]`, listed once or not at all.
    if n % 2 != 0 {
        return Err(FrontierError::TooManyAccounts.into());
    }
    check_accounts(CapIx::ClaimJob, a, Some(&[1, (n / 2) as u8]))?;
    let CapData::ClaimJob { grant, job } = x else {
        return Err(FrontierError::BadData.into());
    };
    let (pl, signer) = player(p, a)?;
    let [_, _payer, _season, _citizen, holding, pool_ai, job_ai, vault, lot @ ..] = a else {
        return Err(FrontierError::TooManyAccounts.into());
    };
    let sid = pl.pc.season.id;
    let f = facility(p, &pl.ctx, sid, holding)?;
    let mut pool = pool_at(p, &pl.ctx, pool_ai)?;
    pool_of(&pool, &f)?;
    let view = f.view(pool.facility.gen, pl.pc.season.genesis_ts);
    let mut j = job_at(p, &pl.ctx, &pool, job_ai, grant, job)?;
    let mut link = match j {
        Some(_) => link_of(&job_ai.try_borrow_data()?)?,
        None => Link::default(),
    };
    let mut v = user_vault(p, &pl.ctx, sid, vault, &signer, &f)?;
    let done = cap::claim(
        &mut pool,
        &view,
        j.as_mut(),
        (grant, job),
        pl.now.ts,
        &signer,
        link.fed,
        false,
    )
    .map_err(cap_err)?;
    let ev = events(done);
    let jj = j.as_ref().ok_or(BAD_ACCOUNT)?;
    let r = jj.recipe();
    for e in ev.iter().flatten() {
        if let Event::Claimed { output, refund, .. } = *e {
            if output > 0 {
                v.put(r.output, output)?;
            }
            for (i, (res, _)) in r.inputs.iter().enumerate() {
                if refund[i] <= 0 {
                    continue;
                }
                if link.fed && *res == Resource::Ore {
                    // The lot's ore: owed to the lot until it is in it.
                    link.owed = link
                        .owed
                        .checked_add(refund[i])
                        .ok_or(cap_err(CapError::Overflow))?;
                } else {
                    v.put(*res, refund[i])?;
                }
            }
        }
    }
    let paid = match lot {
        [] => false,
        [lv, l] if link.fed => lots::pay_owed(p, &pl.ctx, sid, lv, l, &mut link)?,
        _ => return Err(FrontierError::TooManyAccounts.into()),
    };
    if ev.is_none() && !paid {
        return Ok(());
    }
    v.write(vault)?;
    put_job(job_ai, jj)?;
    put_link(job_ai, &link)?;
    put_pool(pool_ai, &pool)
}

// ------------------------------------------------------------ 0xF7 / 0xF8

/// 0xF7 SettleJob (anyone): credit what the job made by now.
pub fn settle(p: &Pubkey, a: &[AccountInfo], x: CapData) -> R<()> {
    check_accounts(CapIx::SettleJob, a, None)?;
    let CapData::SettleJob { grant, job } = x else {
        return Err(FrontierError::BadData.into());
    };
    let (ctx, sid, now) = keeper(p, a)?;
    let [_, season, holding, pool_ai, job_ai] = a else {
        return Err(FrontierError::TooManyAccounts.into());
    };
    let f = facility(p, &ctx, sid, holding)?;
    let mut pool = pool_at(p, &ctx, pool_ai)?;
    pool_of(&pool, &f)?;
    let view = f.view(pool.facility.gen, genesis_of(season)?);
    let mut j = job_at(p, &ctx, &pool, job_ai, grant, job)?;
    let done = cap::settle(&mut pool, &view, j.as_mut(), (grant, job), now).map_err(cap_err)?;
    if events(done).is_some() {
        put_job(job_ai, j.as_ref().ok_or(BAD_ACCOUNT)?)?;
        put_pool(pool_ai, &pool)?;
    }
    Ok(())
}

/// 0xF8 CancelJob (the user).
pub fn cancel(p: &Pubkey, a: &[AccountInfo], x: CapData) -> R<()> {
    check_accounts(CapIx::CancelJob, a, None)?;
    let CapData::CancelJob { grant, job } = x else {
        return Err(FrontierError::BadData.into());
    };
    let (pl, signer) = player(p, a)?;
    let [_, _payer, _season, _citizen, holding, pool_ai, job_ai] = a else {
        return Err(FrontierError::TooManyAccounts.into());
    };
    let f = facility(p, &pl.ctx, pl.pc.season.id, holding)?;
    let mut pool = pool_at(p, &pl.ctx, pool_ai)?;
    pool_of(&pool, &f)?;
    let view = f.view(pool.facility.gen, pl.pc.season.genesis_ts);
    let mut j = job_at(p, &pl.ctx, &pool, job_ai, grant, job)?;
    let done = cap::cancel(
        &mut pool,
        &view,
        j.as_mut(),
        (grant, job),
        pl.now.ts,
        &signer,
    )
    .map_err(cap_err)?;
    if events(done).is_some() {
        put_job(job_ai, j.as_ref().ok_or(BAD_ACCOUNT)?)?;
        put_pool(pool_ai, &pool)?;
    }
    Ok(())
}

// ------------------------------------------------------------ 0xFA

/// 0xFA RecordFacilityLoss (anyone): the pool's generation ended (read
/// from the Holding); every job of the pool follows, in the pool's order;
/// a captor's share goes into the Holding's stores.
pub fn lose(p: &Pubkey, a: &[AccountInfo]) -> R<()> {
    let n = a
        .len()
        .checked_sub(4)
        .ok_or(FrontierError::TooManyAccounts)?;
    check_accounts(CapIx::RecordFacilityLoss, a, Some(&[1, n as u8]))?;
    let (ctx, sid, now) = keeper(p, a)?;
    let [_, season, holding, pool_ai, jobs @ ..] = a else {
        return Err(FrontierError::TooManyAccounts.into());
    };
    let f = facility(p, &ctx, sid, holding)?;
    let mut pool = pool_at(p, &ctx, pool_ai)?;
    pool_of(&pool, &f)?;
    if pool.lost_at.is_none() && !f.dated(pool.facility.gen) {
        // Released, or captured twice before anyone recorded the first
        // loss: the Holding no longer tells when this generation ended.
        return Err(FrontierError::NotImplemented.into());
    }
    let view = f.view(pool.facility.gen, genesis_of(season)?);
    let mut js = jobs
        .iter()
        .map(|ai| any_job(p, &ctx, &pool, ai))
        .collect::<R<Vec<cap::Job>>>()?;
    let mut refs: Vec<&mut cap::Job> = js.iter_mut().collect();
    let done = cap::lose(&mut pool, &view, &mut refs).map_err(cap_err)?;
    let Some(ev) = events(done) else {
        return Ok(());
    };
    let mut h: KHolding = read_holding(&holding.try_borrow_data()?)?;
    let mut credited = false;
    for e in &ev {
        if let Event::Forfeited {
            job,
            output,
            refund,
            ..
        } = *e
        {
            let r = js
                .iter()
                .find(|j| (j.grant, j.seq) == job)
                .ok_or(BAD_ACCOUNT)?
                .recipe();
            let mut add = |res: Resource, amt: i64| -> R<()> {
                if amt > 0 {
                    h.credit(now, res, amt).map_err(hold::holding_err)?;
                    credited = true;
                }
                Ok(())
            };
            add(r.output, output)?;
            for (i, (res, _)) in r.inputs.iter().enumerate() {
                add(*res, refund[i])?;
            }
        }
    }
    if credited {
        write_holding(&mut holding.try_borrow_mut_data()?, &h, now)?;
    }
    for (ai, j) in jobs.iter().zip(js.iter()) {
        put_job(ai, j)?;
    }
    put_pool(pool_ai, &pool)
}

// ------------------------------------------------------------ 0xFB–0xFD

/// 0xFB RetireJob, 0xFC RetireGrant, 0xFD RetirePool (anyone): close a
/// finished record; a closed account's rent goes back to who paid it.
pub fn retire(p: &Pubkey, a: &[AccountInfo], x: CapData) -> R<()> {
    check_accounts(x.ix(), a, None)?;
    let (ctx, _sid, now) = keeper(p, a)?;
    let pool_ai = a.get(2).ok_or(FrontierError::TooManyAccounts)?;
    let mut pool = pool_at(p, &ctx, pool_ai)?;
    match x {
        CapData::RetireJob { grant, job } => {
            let [_, _season, _pool, job_ai, rent_to] = a else {
                return Err(FrontierError::TooManyAccounts.into());
            };
            let j = job_at(p, &ctx, &pool, job_ai, grant, job)?;
            if j.is_some() && link_of(&job_ai.try_borrow_data()?)?.owed != 0 {
                // Ore still owed to a lot: the record keeps it.
                return Err(cap_err(CapError::NotRetirable));
            }
            let done = cap::retire(&mut pool, j.as_ref(), (grant, job)).map_err(cap_err)?;
            if events(done).is_some() {
                if rent_to_of(job_ai, cap::layout::job::SIZE)? != key(rent_to) {
                    return Err(BAD_ACCOUNT);
                }
                put_pool(pool_ai, &pool)?;
                init::close_to(p, job_ai, rent_to, &Sink::Never, bell(now, a)?)?;
            }
        }
        CapData::RetireGrant { grant } => {
            if events(cap::retire_grant(&mut pool, now, grant).map_err(cap_err)?).is_some() {
                put_pool(pool_ai, &pool)?;
            }
        }
        CapData::RetirePool => {
            let [_, _season, _pool, rent_to] = a else {
                return Err(FrontierError::TooManyAccounts.into());
            };
            cap::retire_pool(&pool).map_err(cap_err)?;
            if rent_to_of(pool_ai, cap::layout::pool::SIZE)? != key(rent_to) {
                return Err(BAD_ACCOUNT);
            }
            init::close_to(p, pool_ai, rent_to, &Sink::Never, bell(now, a)?)?;
        }
        _ => return Err(FrontierError::BadData.into()),
    }
    Ok(())
}

fn bell(now: i64, a: &[AccountInfo]) -> R<u32> {
    let season = a.get(1).ok_or(FrontierError::TooManyAccounts)?;
    Ok(frontier_abi::prologue::bell_at(genesis_of(season)?, now).unwrap_or(u32::MAX))
}

// ------------------------------------------------------------ lots (workstream 10)

/// Another owner's lot feeding a job (workstream 10's custody kernel,
/// `permutation_rules::frontier::custody`, through `proc::custody`'s own
/// readers and writers): the use order's grantee consumes whole units
/// (`consume`, logged `LOT_CONSUMED` on the lot's chain as ConsumeLot logs
/// it), and what the job did not use is un-consumed back into the lot
/// (`return_unused`). No record kind exists for a return yet (workstream
/// 4's to allocate, asked by workstream 10); the lot's state is written,
/// its chain is not advanced, and workstream 10's V26 accepts the lower
/// CONSUMED as unverifiable. In a build without custody a lot source is
/// unknown data.
#[cfg(feature = "custody-preview")]
mod lots {
    use super::super::custody::{actor, cerr, emit_lot, lot_of, lot_raw, put_lot, vault_of_lot};
    use super::*;
    use frontier_abi::v2::log::CqKind;
    use permutation_rules::frontier::custody::{self as kc, CustodyError, Lot, VaultView};

    /// A present lot at its canonical address, and its vault (present,
    /// canonical for the lot's tile): workstream 10's own readers.
    fn lot_and_vault(
        p: &Pubkey,
        ctx: &addr::AddrCtx,
        sid: u64,
        vault: &AccountInfo,
        lot: &AccountInfo,
    ) -> R<(Lot, VaultView)> {
        let l = lot_of(p, ctx, sid, lot)?;
        let v = vault_of_lot(p, ctx, sid, vault, &l)?.ok_or(cerr(CustodyError::Forfeited))?;
        Ok((l, v))
    }

    /// DepositToJob from a lot.
    #[allow(clippy::too_many_arguments)]
    pub(super) fn deposit(
        p: &Pubkey,
        pl: &Player,
        citizen: &AccountInfo,
        f: &Fac,
        pool: &mut cap::Pool,
        view: &cap::Facility,
        j: Option<&mut cap::Job>,
        link: &mut Link,
        job: (u32, u32),
        vault: &AccountInfo,
        lot_ai: &AccountInfo,
        (deposit, resource, amount, slot, order): (u64, Resource, i64, u8, u32),
        pool_ai: &AccountInfo,
        job_ai: &AccountInfo,
    ) -> R<()> {
        let sid = pl.pc.season.id;
        let (mut l, v) = lot_and_vault(p, &pl.ctx, sid, vault, lot_ai)?;
        // Same province: used directly (the owner's decision of 2026-11-06;
        // farther goods travel by caravan first).
        if (l.p, l.q) != (f.p, f.q) {
            return Err(FrontierError::BadAddress.into());
        }
        if l.resource != resource as u8 {
            return Err(FrontierError::BadData.into());
        }
        let key = lot_ai.key.to_bytes();
        let own_ore = j.as_ref().map_or(0, |j| j.hopper[0] - link.taken);
        if (link.fed && link.lot != key) || own_ore != 0 {
            // A second lot, or the user's own ore already in: two sources
            // (undecided).
            return Err(FrontierError::NotImplemented.into());
        }
        let signer = key_of(citizen);
        let mut j = j;
        let done = cap::deposit(
            pool,
            view,
            j.as_deref_mut(),
            job,
            pl.now.ts,
            &signer,
            deposit,
            resource,
            amount,
            u64::from_le_bytes(key[..8].try_into().map_err(|_| BAD_ACCOUNT)?),
        )
        .map_err(cap_err)?;
        if events(done).is_none() {
            return Ok(());
        }
        kc::consume(
            &v,
            &mut l,
            &actor(pl, citizen),
            slot,
            order,
            amount,
            fc::PURPOSE_WORKSHOP_ARMS,
            pl.pc.now_bell,
        )
        .map_err(cerr)?;
        put_lot(lot_ai, &l)?;
        link.fed = true;
        link.lot = key;
        link.taken = link
            .taken
            .checked_add(amount)
            .ok_or(cap_err(CapError::Overflow))?;
        put_job(job_ai, j.as_deref().ok_or(BAD_ACCOUNT)?)?;
        put_link(job_ai, link)?;
        put_pool(pool_ai, pool)?;
        let payload = crate::events::Buf::<22>::new()
            .u32(order)
            .u64(pl.pc.citizen_tag)
            .i64(amount)
            .u16(fc::PURPOSE_WORKSHOP_ARMS);
        emit_lot(
            CqKind::LOT_CONSUMED,
            pl.pc.now_bell,
            &lot_raw(&l),
            payload.get()?,
            lot_ai,
        )
    }

    /// Pays the whole units owed to the job's lot if it can take them now
    /// (usable, room; workstream 10's `return_unused`). Returns whether it
    /// paid.
    pub(super) fn pay_owed(
        p: &Pubkey,
        ctx: &addr::AddrCtx,
        sid: u64,
        vault: &AccountInfo,
        lot_ai: &AccountInfo,
        link: &mut Link,
    ) -> R<bool> {
        if lot_ai.key.to_bytes() != link.lot {
            return Err(BAD_ACCOUNT);
        }
        let due = link.owed / permutation_rules::fixed::MILLI * permutation_rules::fixed::MILLI;
        if due == 0 {
            return Ok(false);
        }
        let (mut l, v) = lot_and_vault(p, ctx, sid, vault, lot_ai)?;
        match kc::return_unused(&v, &mut l, due) {
            Ok(()) => {
                put_lot(lot_ai, &l)?;
                link.owed -= due;
                link.returned += due;
                Ok(true)
            }
            // Frozen (its vault seized) or full: it stays owed.
            Err(CustodyError::Forfeited | CustodyError::Capacity) => Ok(false),
            Err(e) => Err(cerr(e)),
        }
    }

    fn key_of(ai: &AccountInfo) -> Key {
        ai.key.to_bytes()
    }
}

/// In a build without custody there is no lot to take from.
#[cfg(not(feature = "custody-preview"))]
mod lots {
    use super::*;

    #[allow(clippy::too_many_arguments)]
    pub(super) fn deposit(
        _p: &Pubkey,
        _pl: &Player,
        _citizen: &AccountInfo,
        _f: &Fac,
        _pool: &mut cap::Pool,
        _view: &cap::Facility,
        _j: Option<&mut cap::Job>,
        _link: &mut Link,
        _job: (u32, u32),
        _vault: &AccountInfo,
        _lot: &AccountInfo,
        _x: (u64, Resource, i64, u8, u32),
        _pool_ai: &AccountInfo,
        _job_ai: &AccountInfo,
    ) -> R<()> {
        Err(FrontierError::BadData.into())
    }

    pub(super) fn pay_owed(
        _p: &Pubkey,
        _ctx: &addr::AddrCtx,
        _sid: u64,
        _vault: &AccountInfo,
        _lot: &AccountInfo,
        _link: &mut Link,
    ) -> R<bool> {
        Err(FrontierError::BadData.into())
    }
}
