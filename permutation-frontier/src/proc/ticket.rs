//! S2 (redesign stage 2, 2a): the ticket groundwork — issuing receipt and
//! use tickets, giving and splitting lots, closing them
//! (`docs/frontier/stage2/S2-2A-CONTRACT.md` §3; decisions L1, L7, L8).
//!
//! | Tag | Instruction | Here |
//! |---|---|---|
//! | 0xC0 | IssueTickets | [`issue_tickets`] |
//! | 0xC1 | GiveLot | [`give_lot`] |
//! | 0xC2 | CloseLot | [`close_lot`] |
//!
//! An **issue** (`ti‖issuer_tag,seq`) is one kind of ticket from one
//! source; a **lot** (`tl‖seed_tag,seq`) is one holder's units of it. The
//! rules are the kernel's (`permutation_rules::frontier::ticket`).
//!
//! Pinned here:
//! - **Validity follows the source's generation**: every use compares the
//!   lot's `SRC_GEN` with the source's `GEN` read now (`TicketVoid`); a
//!   source that is gone or closed voids its tickets too.
//! - **The seed** of a lot is the tag and `Citizen.LOTS` of whoever made it
//!   (`SEED_TAG`, `SEQ`); a whole-lot gift rewrites the holder in place.
//! - **A gift to another citizen needs the wallet** (L7,
//!   `WalletRequired`); a split may be signed by the session key.
//! - **The fee** (`ticket::ISSUE_FEE`) is paid from the paying holding and
//!   burned (L8).

use solana_program::{account_info::AccountInfo, pubkey::Pubkey};

use frontier_abi::addr::{citizen_tag, host_id};
use frontier_abi::v2::addr::{deposit_seq, is_deposit_seq};
use frontier_abi::v2::ix as ix2;
use frontier_abi::v2::layout::s1::{place as PL, vault as VA};
use frontier_abi::v2::layout::s2::{issue as IS, lot as LT};
use frontier_abi::v2::layout::AccountKind as K2;
use frontier_abi::v2::log::{close_key_issue, close_key_lot, CqKind, EntityKind as E2};
use frontier_abi::v2::tags::Ix as Ix2;
use frontier_abi::v2::CqError;
use permutation_rules::frontier::arms;
use permutation_rules::frontier::ticket::{
    self as kt, KIND_RECEIPT, KIND_SHARE, KIND_USE, MAX_OPEN_ISSUES, SRC_HOLDING, SRC_VAULT,
    STATE_CLOSED, STATE_LIVE,
};
use permutation_rules::frontier::travel::BELLS_PER_DAY;

use super::caravan::{
    period_of, place_of, put_period, roll_vault, send, vault_shares, Place, SendAccounts, SendBy,
    SendOrder,
};
use super::conquest::{check_accounts_v2, cq, cqlog, present_v2, Chained2};
use super::holding::{self as hold, Player};
use crate::addr::AddrCtx;
use crate::error::{BAD_ACCOUNT, OVERFLOW};
use crate::init::{self, SeasonSigner, Sink};
use crate::layout::{citizen2 as C, holding2 as H, Ro, Rw};
use crate::prologue::expect_key;
use crate::{FrontierError, R};
use permutation_rules::frontier::holding::RESOURCES;

/// The record key of an issue: `issuer_tag ‖ seq`.
fn key12(tag: u64, seq: u32) -> [u8; 12] {
    let mut k = [0u8; 12];
    k[..8].copy_from_slice(&tag.to_le_bytes());
    k[8..].copy_from_slice(&seq.to_le_bytes());
    k
}

/// What a handler reads of an Issue.
struct IssueView {
    kind: u8,
    state: u8,
    src_kind: u8,
    src_gen: u8,
    p: i16,
    q: i16,
    at: u8,
    issuer_tag: u64,
    seq: u32,
    issuer: [u8; 32],
    supply: u64,
    rent_to: [u8; 32],
    resource: u8,
    per_unit: u64,
    until_day: u32,
    src_stamp: i64,
}

fn read_issue(p: &Pubkey, pl: &Player, ai: &AccountInfo) -> R<IssueView> {
    read_issue_at(p, &pl.ctx, pl.pc.season.id, ai)
}

fn read_issue_at(p: &Pubkey, ctx: &AddrCtx, sid: u64, ai: &AccountInfo) -> R<IssueView> {
    present_v2(ai, p, K2::Issue, sid)?;
    let d = ai.try_borrow_data()?;
    let r = Ro(&d);
    let v = IssueView {
        kind: r.u8(IS::KIND)?,
        state: r.u8(IS::STATE)?,
        src_kind: r.u8(IS::SRC_KIND)?,
        src_gen: r.u8(IS::SRC_GEN)?,
        p: r.i16(IS::P)?,
        q: r.i16(IS::Q)?,
        at: r.u8(IS::AT)?,
        issuer_tag: r.u64(IS::ISSUER_TAG)?,
        seq: r.u32(IS::SEQ)?,
        issuer: r.arr(IS::ISSUER_CITIZEN)?,
        supply: r.u64(IS::SUPPLY)?,
        rent_to: r.arr(IS::RENT_TO)?,
        resource: r.u8(IS::RESOURCE)?,
        per_unit: r.u64(IS::PER_UNIT)?,
        until_day: r.u32(IS::UNTIL_DAY)?,
        src_stamp: r.i64(IS::SRC_STAMP)?,
    };
    expect_key(ai, &frontier_abi::v2::addr::issue(ctx, v.issuer_tag, v.seq))?;
    Ok(v)
}

/// A live source's stamp: a vault's `BUILT_TS`, a holding's `FOUNDED_TS`.
fn source_stamp(source: &AccountInfo) -> R<i64> {
    let d = source.try_borrow_data()?;
    let r = Ro(&d);
    if d.len() == VA::SIZE && d[..8] == VA::MAGIC {
        r.i64(VA::BUILT_TS)
    } else {
        r.i64(H::FOUNDED_TS)
    }
}

/// The issue's source account at its canonical address; its generation
/// now, or `None` when it is gone, no longer live, or rebuilt since the
/// issue (another stamp): its tickets are void.
fn source_now(p: &Pubkey, pl: &Player, iv: &IssueView, source: &AccountInfo) -> R<Option<u8>> {
    let want = match iv.src_kind {
        SRC_VAULT => frontier_abi::v2::addr::vault(&pl.ctx, iv.p as i32, iv.q as i32, iv.at),
        SRC_HOLDING => pl.ctx.holding(iv.p as i32, iv.q as i32, iv.at),
        _ => return Err(BAD_ACCOUNT),
    };
    expect_key(source, &want)?;
    if init::is_absent(source) {
        return Ok(None);
    }
    let place = place_of(p, &pl.ctx, pl.pc.season.id, source)?;
    if place.is_some() && source_stamp(source)? != iv.src_stamp {
        return Ok(None);
    }
    Ok(place.map(|s| s.gen))
}

/// Whether the issue's tickets are valid now (live issue, source live in
/// the issue's generation).
fn issue_valid(p: &Pubkey, pl: &Player, iv: &IssueView, source: &AccountInfo) -> R<bool> {
    let now = source_now(p, pl, iv, source)?;
    Ok(iv.state == STATE_LIVE && now.is_some_and(|g| kt::valid(iv.src_gen, g, true)))
}

/// What a handler reads of a Lot.
struct LotView {
    issuer_tag: u64,
    issue_seq: u32,
    src_gen: u8,
    state: u8,
    holder: [u8; 32],
    seed_tag: u64,
    seq: u32,
    amount: u64,
    escrow: u64,
    rent_to: [u8; 32],
    /// 2c: the day (+1) the lot last claimed, and the milli it claimed.
    day: u32,
    day_amount: u64,
}

fn read_lot(p: &Pubkey, pl: &Player, ai: &AccountInfo) -> R<LotView> {
    read_lot_at(p, &pl.ctx, pl.pc.season.id, ai)
}

fn read_lot_at(p: &Pubkey, ctx: &AddrCtx, sid: u64, ai: &AccountInfo) -> R<LotView> {
    present_v2(ai, p, K2::Lot, sid)?;
    let d = ai.try_borrow_data()?;
    let r = Ro(&d);
    let v = LotView {
        issuer_tag: r.u64(LT::ISSUER_TAG)?,
        issue_seq: r.u32(LT::ISSUE_SEQ)?,
        src_gen: r.u8(LT::SRC_GEN)?,
        state: r.u8(LT::STATE)?,
        holder: r.arr(LT::HOLDER_CITIZEN)?,
        seed_tag: r.u64(LT::SEED_TAG)?,
        seq: r.u32(LT::SEQ)?,
        amount: r.u64(LT::AMOUNT)?,
        escrow: r.u64(LT::ESCROW)?,
        rent_to: r.arr(LT::RENT_TO)?,
        day: r.u32(LT::DAY)?,
        day_amount: r.u64(LT::DAY_AMOUNT)?,
    };
    expect_key(ai, &frontier_abi::v2::addr::lot(ctx, v.seed_tag, v.seq))?;
    Ok(v)
}

/// Creates a Lot account and writes it (holder `holder`/`holder_tag`, seed
/// `seed_tag`/`seq`).
#[allow(clippy::too_many_arguments)]
fn init_lot<'a>(
    p: &Pubkey,
    pl: &Player,
    payer: &AccountInfo<'a>,
    season_ai: &AccountInfo<'a>,
    lot: &AccountInfo<'a>,
    iv: &IssueView,
    holder: &[u8; 32],
    holder_tag: u64,
    seed_tag: u64,
    seq: u32,
    amount: u64,
) -> R<()> {
    let at = Season {
        ctx: &pl.ctx,
        sid: pl.pc.season.id,
        bump: pl.pc.season.bump,
    };
    init_lot_at(
        p, &at, payer, season_ai, lot, iv, holder, holder_tag, seed_tag, seq, amount,
    )
}

/// The season a handler without a `Player` writes in (a settlement).
pub(crate) struct Season<'c> {
    pub(crate) ctx: &'c AddrCtx,
    pub(crate) sid: u64,
    pub(crate) bump: u8,
}

/// [`init_lot`] in season `at`.
#[allow(clippy::too_many_arguments)]
fn init_lot_at<'a>(
    p: &Pubkey,
    at: &Season,
    payer: &AccountInfo<'a>,
    season_ai: &AccountInfo<'a>,
    lot: &AccountInfo<'a>,
    iv: &IssueView,
    holder: &[u8; 32],
    holder_tag: u64,
    seed_tag: u64,
    seq: u32,
    amount: u64,
) -> R<()> {
    let sid = at.sid;
    expect_key(lot, &frontier_abi::v2::addr::lot(at.ctx, seed_tag, seq))?;
    if !init::is_absent(lot) {
        return Err(BAD_ACCOUNT);
    }
    let signer = SeasonSigner::new(sid, at.bump);
    let seed = frontier_abi::v2::addr::lot_seed(seed_tag, seq);
    let rent = init::rent(LT::SIZE)?;
    init::init_with_seed(payer, lot, season_ai, &signer, &seed, LT::SIZE, rent, p)?;
    let mut d = lot.try_borrow_mut_data()?;
    if !frontier_abi::v2::layout::write_header(&mut d, K2::Lot, sid) {
        return Err(BAD_ACCOUNT);
    }
    let mut w = Rw(&mut d);
    w.set_u64(LT::ISSUER_TAG, iv.issuer_tag)?;
    w.set_u32(LT::ISSUE_SEQ, iv.seq)?;
    w.set_u8(LT::KIND, iv.kind)?;
    w.set_u8(LT::SRC_GEN, iv.src_gen)?;
    w.set_u8(LT::STATE, STATE_LIVE)?;
    w.set_arr(LT::HOLDER_CITIZEN, holder)?;
    w.set_u64(LT::HOLDER_TAG, holder_tag)?;
    w.set_u64(LT::SEED_TAG, seed_tag)?;
    w.set_u32(LT::SEQ, seq)?;
    w.set_u64(LT::AMOUNT, amount)?;
    w.set_arr(LT::RENT_TO, payer.key.as_ref())
}

/// What [`create_issue`] writes.
struct NewIssue<'s> {
    stamp: i64,
    kind: u8,
    src_kind: u8,
    src: &'s Place,
    seq: u32,
    resource: u8,
    supply: u64,
    per_unit: u64,
    until_day: u32,
}

/// Creates the citizen's Issue `x.seq` and writes it.
fn create_issue<'a>(
    p: &Pubkey,
    pl: &Player,
    payer: &AccountInfo<'a>,
    season_ai: &AccountInfo<'a>,
    citizen: &AccountInfo<'a>,
    issue: &AccountInfo<'a>,
    x: &NewIssue,
) -> R<()> {
    let sid = pl.pc.season.id;
    let issuer_tag = pl.pc.citizen_tag;
    expect_key(
        issue,
        &frontier_abi::v2::addr::issue(&pl.ctx, issuer_tag, x.seq),
    )?;
    if !init::is_absent(issue) {
        return Err(BAD_ACCOUNT);
    }
    let signer = SeasonSigner::new(sid, pl.pc.season.bump);
    let seed = frontier_abi::v2::addr::issue_seed(issuer_tag, x.seq);
    let rent = init::rent(IS::SIZE)?;
    init::init_with_seed(payer, issue, season_ai, &signer, &seed, IS::SIZE, rent, p)?;
    let mut idata = issue.try_borrow_mut_data()?;
    if !frontier_abi::v2::layout::write_header(&mut idata, K2::Issue, sid) {
        return Err(BAD_ACCOUNT);
    }
    let mut w = Rw(&mut idata);
    w.set_u8(IS::KIND, x.kind)?;
    w.set_u8(IS::STATE, STATE_LIVE)?;
    w.set_u8(IS::SRC_KIND, x.src_kind)?;
    w.set_u8(IS::SRC_GEN, x.src.gen)?;
    w.set_i16(IS::P, x.src.p)?;
    w.set_i16(IS::Q, x.src.q)?;
    w.set_u8(IS::AT, x.src.at)?;
    w.set_u8(IS::RESOURCE, x.resource)?;
    w.set_u32(IS::SEQ, x.seq)?;
    w.set_arr(IS::ISSUER_CITIZEN, citizen.key.as_ref())?;
    w.set_u64(IS::ISSUER_TAG, issuer_tag)?;
    w.set_u64(IS::SUPPLY, x.supply)?;
    w.set_u64(IS::PER_UNIT, x.per_unit)?;
    w.set_u32(IS::UNTIL_DAY, x.until_day)?;
    w.set_i64(IS::SRC_STAMP, x.stamp)?;
    w.set_u32(IS::CREATED_BELL, pl.pc.now_bell)?;
    w.set_arr(IS::RENT_TO, payer.key.as_ref())
}

/// The paying holding of an issue (the citizen's, live, final, unlocked)
/// pays the fee, burned (L8): its host id.
fn pay_fee(
    p: &Pubkey,
    pl: &Player,
    holding: &AccountInfo,
    citizen: &AccountInfo,
    holding_province: &AccountInfo,
) -> R<u64> {
    let now = pl.now.ts;
    let hh = hold::owned_holding(p, pl, holding, citizen)?;
    hold::live(&hh)?;
    hold::own_province_unlocked(p, pl, &hh, holding_province)?;
    hold::finality(pl, &hh, holding, citizen, holding_province)?;
    let mut h = hold::load_touched(holding, now)?;
    h.pay(now, &kt::issue_fee()).map_err(hold::holding_err)?;
    let mut hd = holding.try_borrow_mut_data()?;
    hold::write_holding(&mut hd, &h, now)?;
    host_id(hh.p as i32, hh.q as i32, hh.site, hh.gen, 0).ok_or(BAD_ACCOUNT)
}

// ------------------------------------------------------------ 0xC0 IssueTickets

/// 0xC0 IssueTickets(kind, resource, amount, per_unit, until_day): P +
/// `[holding w] [holding_province r] [source r] [issue w] [lot w]
/// [system]` (2a contract §3.1).
pub fn issue_tickets(p: &Pubkey, a: &[AccountInfo], d: &[u8]) -> R<()> {
    check_accounts_v2(Ix2::IssueTickets, a, None)?;
    let x = ix2::IssueTickets::decode(d)?;
    let pl: Player = hold::player(p, a)?;
    let [_, payer, season_ai, citizen, holding, holding_province, source, issue, lot, _system] = a
    else {
        return Err(FrontierError::TooManyAccounts.into());
    };
    let sid = pl.pc.season.id;
    let now = pl.now.ts;
    let bell = pl.pc.now_bell;
    // The paying holding.
    let hh = hold::owned_holding(p, &pl, holding, citizen)?;
    hold::live(&hh)?;
    hold::own_province_unlocked(p, &pl, &hh, holding_province)?;
    hold::finality(&pl, &hh, holding, citizen, holding_province)?;
    // The source: the citizen's, live, of the kind the ticket needs.
    let src: Place = place_of(p, &pl.ctx, sid, source)?.ok_or(cq(CqError::TicketTerms))?;
    if src.owner != citizen.key.to_bytes() {
        return Err(FrontierError::NotOwner.into());
    }
    let (src_kind, cap) = {
        let sd = source.try_borrow_data()?;
        let r = Ro(&sd);
        match x.kind {
            KIND_RECEIPT if src.kind == PL::KIND_VAULT => {
                // 2b: a shared vault's goods are its holders' (2c decides
                // receipts beside shares).
                if vault_shares(&sd)?.is_some() {
                    return Err(cq(CqError::VaultShared));
                }
                (SRC_VAULT, r.i64(VA::CAP)?)
            }
            KIND_USE if src.kind == PL::KIND_HOLDING => {
                let arms_rate = r.i64(H::PRODUCTION + 8 * arms::ARMS as usize)?;
                if r.u8(H::STATE)? != H::STATE_FINAL || arms_rate < arms::WORKSHOP_DELTA {
                    return Err(cq(CqError::TicketTerms));
                }
                (SRC_HOLDING, 0)
            }
            _ => return Err(cq(CqError::TicketTerms)),
        }
    };
    kt::check_terms(
        x.kind,
        x.resource,
        x.amount,
        x.per_unit,
        x.until_day,
        cap,
        bell / BELLS_PER_DAY,
    )
    .map_err(|_| cq(CqError::TicketTerms))?;
    // The limit and the counters.
    let (seq, lot_seq) = {
        let cd = citizen.try_borrow_data()?;
        let r = Ro(&cd);
        if r.u8(C::OPEN_ISSUES)? >= MAX_OPEN_ISSUES {
            return Err(cq(CqError::TicketLimit));
        }
        (r.u32(C::ISSUES)?, r.u32(C::LOTS)?)
    };
    // The fee, burned (L8).
    let fee = kt::issue_fee();
    {
        let mut h = hold::load_touched(holding, now)?;
        h.pay(now, &fee).map_err(hold::holding_err)?;
        let mut hd = holding.try_borrow_mut_data()?;
        hold::write_holding(&mut hd, &h, now)?;
    }
    // The issue.
    let issuer_tag = pl.pc.citizen_tag;
    create_issue(
        p,
        &pl,
        payer,
        season_ai,
        citizen,
        issue,
        &NewIssue {
            stamp: source_stamp(source)?,
            kind: x.kind,
            src_kind,
            src: &src,
            seq,
            resource: x.resource,
            supply: x.amount,
            per_unit: x.per_unit,
            until_day: x.until_day,
        },
    )?;
    let iv = read_issue(p, &pl, issue)?;
    // The issuer's first lot: the whole amount.
    let me = citizen.key.to_bytes();
    init_lot(
        p, &pl, payer, season_ai, lot, &iv, &me, issuer_tag, issuer_tag, lot_seq, x.amount,
    )?;
    {
        let mut cd = citizen.try_borrow_mut_data()?;
        let r = Ro(&cd);
        let open = r.u8(C::OPEN_ISSUES)?;
        let mut w = Rw(&mut cd);
        w.set_u32(C::ISSUES, seq.checked_add(1).ok_or(OVERFLOW)?)?;
        w.set_u32(C::LOTS, lot_seq.checked_add(1).ok_or(OVERFLOW)?)?;
        w.set_u8(C::OPEN_ISSUES, open + 1)?;
    }
    let hkey = host_id(hh.p as i32, hh.q as i32, hh.site, hh.gen, 0).ok_or(BAD_ACCOUNT)?;
    let payload = crate::events::Buf::<82>::new()
        .u8(x.kind)
        .bytes(&src.log())
        .u8(x.resource)
        .u64(x.amount)
        .u64(x.per_unit)
        .u32(x.until_day)
        .u32(lot_seq)
        .u64(hkey)
        .bytes(&hold::cost_digest(&fee));
    let mut cd = citizen.try_borrow_mut_data()?;
    let mut hd = holding.try_borrow_mut_data()?;
    let mut idata = issue.try_borrow_mut_data()?;
    let mut ld = lot.try_borrow_mut_data()?;
    cqlog::emit(
        CqKind::TICKETS_ISSUED as u8,
        bell,
        &key12(issuer_tag, seq),
        payload.get()?,
        &mut [
            Chained2 {
                entity: E2::Citizen,
                data: &mut cd,
            },
            Chained2 {
                entity: E2::Holding,
                data: &mut hd,
            },
            Chained2 {
                entity: E2::Issue,
                data: &mut idata,
            },
            Chained2 {
                entity: E2::Lot,
                data: &mut ld,
            },
        ],
    )
}

// ------------------------------------------------------------ 0xC1 GiveLot

/// 0xC1 GiveLot(amount): P + `[lot w] [issue r] [source r] [recipient r]
/// [to_lot w] [system]` (2a contract §3.2).
pub fn give_lot(p: &Pubkey, a: &[AccountInfo], d: &[u8]) -> R<()> {
    check_accounts_v2(Ix2::GiveLot, a, None)?;
    let x = ix2::GiveLot::decode(d)?;
    let pl: Player = hold::player(p, a)?;
    let [_, payer, season_ai, citizen, lot, issue, source, recipient, to_lot, _system] = a else {
        return Err(FrontierError::TooManyAccounts.into());
    };
    let sid = pl.pc.season.id;
    let bell = pl.pc.now_bell;
    let from = read_lot(p, &pl, lot)?;
    if from.holder != citizen.key.to_bytes() {
        return Err(FrontierError::NotOwner.into());
    }
    if from.state != STATE_LIVE || from.escrow != 0 {
        return Err(cq(CqError::TicketVoid));
    }
    let iv = read_issue(p, &pl, issue)?;
    if (iv.issuer_tag, iv.seq) != (from.issuer_tag, from.issue_seq) {
        return Err(BAD_ACCOUNT);
    }
    if !issue_valid(p, &pl, &iv, source)? || from.src_gen != iv.src_gen {
        return Err(cq(CqError::TicketVoid));
    }
    if x.amount == 0 || x.amount > from.amount {
        return Err(FrontierError::BadData.into());
    }
    // The recipient (L7: another citizen needs the wallet).
    present_v2(recipient, p, K2::Citizen, sid)?;
    let rtag = Ro(&recipient.try_borrow_data()?).u64(C::CITIZEN_TAG)?;
    let to_self = recipient.key == citizen.key;
    if !to_self && pl.pc.by_session {
        return Err(cq(CqError::WalletRequired));
    }
    let rkey = recipient.key.to_bytes();
    let giver_tag = pl.pc.citizen_tag;
    let whole = x.amount == from.amount;
    let today1 = bell / BELLS_PER_DAY + 1;
    // 2d: runs used today travel with the units (as many as they carry),
    // so a split never renews a lot's runs of the day.
    let moved_runs = if iv.kind == KIND_USE && from.day == today1 {
        from.day_amount.min(x.amount.saturating_mul(iv.per_unit))
    } else {
        0
    };
    let (to_key, new_lot) = if to_lot.key == lot.key {
        // A whole-lot gift, in place (never a deposit lot: its address is
        // its holder's, 2b).
        if !whole || to_self || is_deposit_seq(from.seq) {
            return Err(FrontierError::BadData.into());
        }
        let mut ld = lot.try_borrow_mut_data()?;
        let mut w = Rw(&mut ld);
        w.set_arr(LT::HOLDER_CITIZEN, &rkey)?;
        w.set_u64(LT::HOLDER_TAG, rtag)?;
        ((from.seed_tag, from.seq), false)
    } else if init::is_absent(to_lot) {
        // A new lot, seeded by the giver's counter (2c: "claimed today"
        // when the units were).
        let seq = Ro(&citizen.try_borrow_data()?).u32(C::LOTS)?;
        init_lot(
            p, &pl, payer, season_ai, to_lot, &iv, &rkey, rtag, giver_tag, seq, x.amount,
        )?;
        if (iv.kind == KIND_RECEIPT && from.day == today1) || moved_runs > 0 {
            let mut td = to_lot.try_borrow_mut_data()?;
            let mut w = Rw(&mut td);
            w.set_u32(LT::DAY, today1)?;
            w.set_u64(LT::DAY_AMOUNT, moved_runs)?;
        }
        {
            let mut cd = citizen.try_borrow_mut_data()?;
            Rw(&mut cd).set_u32(C::LOTS, seq.checked_add(1).ok_or(OVERFLOW)?)?;
        }
        {
            let mut ld = lot.try_borrow_mut_data()?;
            let mut w = Rw(&mut ld);
            w.set_u64(LT::AMOUNT, from.amount - x.amount)?;
            if moved_runs > 0 {
                w.set_u64(LT::DAY_AMOUNT, from.day_amount - moved_runs)?;
            }
        }
        ((giver_tag, seq), true)
    } else {
        // Added to the recipient's lot of the same issue.
        let to = read_lot(p, &pl, to_lot)?;
        if (to.issuer_tag, to.issue_seq) != (iv.issuer_tag, iv.seq)
            || to.holder != rkey
            || to.state != STATE_LIVE
            || to.escrow != 0
            || to.src_gen != iv.src_gen
        {
            return Err(cq(CqError::TicketVoid));
        }
        // 2c: units claimed today go only to a lot that claimed today.
        if iv.kind == KIND_RECEIPT && from.day == today1 && to.day != today1 {
            return Err(cq(CqError::ReceiptState));
        }
        let sum = to.amount.checked_add(x.amount).ok_or(OVERFLOW)?;
        Rw(&mut to_lot.try_borrow_mut_data()?).set_u64(LT::AMOUNT, sum)?;
        if moved_runs > 0 {
            let used = if to.day == today1 { to.day_amount } else { 0 };
            let mut td = to_lot.try_borrow_mut_data()?;
            let mut w = Rw(&mut td);
            w.set_u32(LT::DAY, today1)?;
            w.set_u64(LT::DAY_AMOUNT, used.saturating_add(moved_runs))?;
        }
        {
            let mut ld = lot.try_borrow_mut_data()?;
            let mut w = Rw(&mut ld);
            w.set_u64(LT::AMOUNT, from.amount - x.amount)?;
            if moved_runs > 0 {
                w.set_u64(LT::DAY_AMOUNT, from.day_amount - moved_runs)?;
            }
        }
        ((to.seed_tag, to.seq), false)
    };
    let payload = crate::events::Buf::<58>::new()
        .u64(giver_tag)
        .u64(from.seed_tag)
        .u32(from.seq)
        .u64(rtag)
        .u64(to_key.0)
        .u32(to_key.1)
        .u64(x.amount)
        .u8(whole as u8)
        .u8(new_lot as u8);
    let mut cd = citizen.try_borrow_mut_data()?;
    let key = key12(iv.issuer_tag, iv.seq);
    if to_lot.key == lot.key {
        let mut ld = lot.try_borrow_mut_data()?;
        cqlog::emit(
            CqKind::LOT_MOVED as u8,
            bell,
            &key,
            payload.get()?,
            &mut [
                Chained2 {
                    entity: E2::Citizen,
                    data: &mut cd,
                },
                Chained2 {
                    entity: E2::Lot,
                    data: &mut ld,
                },
            ],
        )
    } else {
        let mut ld = lot.try_borrow_mut_data()?;
        let mut td = to_lot.try_borrow_mut_data()?;
        cqlog::emit(
            CqKind::LOT_MOVED as u8,
            bell,
            &key,
            payload.get()?,
            &mut [
                Chained2 {
                    entity: E2::Citizen,
                    data: &mut cd,
                },
                Chained2 {
                    entity: E2::Lot,
                    data: &mut ld,
                },
                Chained2 {
                    entity: E2::Lot,
                    data: &mut td,
                },
            ],
        )
    }
}

// ------------------------------------------------------------ 0xC2 CloseLot

/// Logs an account's CLOSE (its chain and the rent's payee) and closes it.
fn close_account<'a>(
    p: &Pubkey,
    ai: &AccountInfo<'a>,
    rent_to: &AccountInfo<'a>,
    entity: E2,
    key: &[u8; 16],
    bell: u32,
) -> R<()> {
    let lamports = ai.lamports();
    {
        let mut d = ai.try_borrow_mut_data()?;
        let (s, head) = crate::layout::chain_of(&d)?;
        let payload = crate::events::Buf::<80>::new()
            .u64(s)
            .bytes(&head)
            .bytes(rent_to.key.as_ref())
            .u64(lamports);
        cqlog::emit(
            frontier_abi::log::Kind::CLOSE as u8,
            bell,
            key,
            payload.get()?,
            &mut [Chained2 {
                entity,
                data: &mut d,
            }],
        )?;
    }
    init::close_to(p, ai, rent_to, &Sink::Never, bell)?;
    Ok(())
}

/// 0xC2 CloseLot(close_issue): P + `[issue w] [source r] [issue_rent_to
/// w]` + optionally `[lot w] [rent_to w]` (2a contract §3.3).
pub fn close_lot(p: &Pubkey, a: &[AccountInfo], d: &[u8]) -> R<()> {
    check_accounts_v2(Ix2::CloseLot, a, None)?;
    let x = ix2::CloseLot::decode(d)?;
    let pl: Player = hold::player(p, a)?;
    let (citizen, issue, source, issue_rent_to, lot) = match a {
        [_, _, _, citizen, issue, source, issue_rent_to] => {
            (citizen, issue, source, issue_rent_to, None)
        }
        [_, _, _, citizen, issue, source, issue_rent_to, lot, rent_to] => {
            (citizen, issue, source, issue_rent_to, Some((lot, rent_to)))
        }
        _ => return Err(FrontierError::TooManyAccounts.into()),
    };
    let bell = pl.pc.now_bell;
    // An issue already closed (void and closed by its issuer) leaves its
    // lots void: each closes alone.
    if init::is_absent(issue) {
        let (lot, rent_to) = lot.ok_or(FrontierError::BadData)?;
        if x.close_issue != 0 {
            return Err(FrontierError::BadData.into());
        }
        return close_orphan_lot(p, &pl, citizen, issue, lot, rent_to, bell);
    }
    let iv = read_issue(p, &pl, issue)?;
    if iv.state != STATE_LIVE {
        return Err(cq(CqError::TicketVoid));
    }
    let valid = issue_valid(p, &pl, &iv, source)?;
    let me = citizen.key.to_bytes();
    let mut supply = iv.supply;
    let mut closed_lot: Option<(LotView, bool)> = None;
    if let Some((lot, rent_to)) = lot {
        let lv = read_lot(p, &pl, lot)?;
        if (lv.issuer_tag, lv.issue_seq) != (iv.issuer_tag, iv.seq) {
            return Err(BAD_ACCOUNT);
        }
        if lv.holder != me {
            return Err(FrontierError::NotOwner.into());
        }
        if lv.state != STATE_LIVE || lv.escrow != 0 || lv.rent_to != rent_to.key.to_bytes() {
            return Err(BAD_ACCOUNT);
        }
        let void = !valid || lv.src_gen != iv.src_gen;
        if lv.amount > 0 && !void {
            return Err(FrontierError::BadData.into());
        }
        supply = supply.saturating_sub(lv.amount);
        closed_lot = Some((lv, void));
    }
    let close_issue = x.close_issue != 0;
    if close_issue {
        if iv.issuer != me {
            return Err(FrontierError::NotOwner.into());
        }
        if supply != 0 && valid {
            return Err(FrontierError::BadData.into());
        }
        if iv.rent_to != issue_rent_to.key.to_bytes() {
            return Err(BAD_ACCOUNT);
        }
    } else if closed_lot.is_none() {
        return Err(FrontierError::BadData.into());
    }
    // 2b: closing a share issue clears its vault's shares.
    let src_log = match place_of(p, &pl.ctx, pl.pc.season.id, source) {
        Ok(Some(s)) => s.log(),
        _ => [0u8; 8],
    };
    let cleared = close_issue
        && iv.kind == KIND_SHARE
        && src_log[0] == PL::KIND_VAULT
        && vault_shares(&source.try_borrow_data()?)? == Some((iv.issuer_tag, iv.seq));
    if cleared {
        let mut vd = source.try_borrow_mut_data()?;
        let mut w = Rw(&mut vd);
        w.set_u8(VA::SHARES_ON, 0)?;
        w.set_u32(VA::SHARES_SEQ, 0)?;
        w.set_u64(VA::SHARES_ISSUER_TAG, 0)?;
    }
    Rw(&mut issue.try_borrow_mut_data()?).set_u64(IS::SUPPLY, supply)?;
    if close_issue {
        Rw(&mut issue.try_borrow_mut_data()?).set_u8(IS::STATE, STATE_CLOSED)?;
        let mut cd = citizen.try_borrow_mut_data()?;
        let open = Ro(&cd).u8(C::OPEN_ISSUES)?;
        Rw(&mut cd).set_u8(C::OPEN_ISSUES, open.saturating_sub(1))?;
    }
    let (lot_tag, lot_seq, amount, void) = closed_lot
        .as_ref()
        .map_or((0, 0, 0, false), |(l, v)| (l.seed_tag, l.seq, l.amount, *v));
    let payload = crate::events::Buf::<40>::new()
        .u64(pl.pc.citizen_tag)
        .u64(lot_tag)
        .u32(lot_seq)
        .u64(amount)
        .u8(void as u8)
        .u8(closed_lot.is_some() as u8)
        .u8(close_issue as u8)
        .bytes(&src_log)
        .u8(cleared as u8);
    let key = key12(iv.issuer_tag, iv.seq);
    {
        let mut cd = citizen.try_borrow_mut_data()?;
        if close_issue && cleared {
            let mut vd = source.try_borrow_mut_data()?;
            cqlog::emit(
                CqKind::LOT_CLOSED as u8,
                bell,
                &key,
                payload.get()?,
                &mut [
                    Chained2 {
                        entity: E2::Citizen,
                        data: &mut cd,
                    },
                    Chained2 {
                        entity: E2::Vault,
                        data: &mut vd,
                    },
                ],
            )?;
        } else if close_issue {
            cqlog::emit(
                CqKind::LOT_CLOSED as u8,
                bell,
                &key,
                payload.get()?,
                &mut [Chained2 {
                    entity: E2::Citizen,
                    data: &mut cd,
                }],
            )?;
        } else {
            let mut idata = issue.try_borrow_mut_data()?;
            cqlog::emit(
                CqKind::LOT_CLOSED as u8,
                bell,
                &key,
                payload.get()?,
                &mut [
                    Chained2 {
                        entity: E2::Citizen,
                        data: &mut cd,
                    },
                    Chained2 {
                        entity: E2::Issue,
                        data: &mut idata,
                    },
                ],
            )?;
        }
    }
    if let (Some((lot, rent_to)), Some((lv, _))) = (lot, closed_lot.as_ref()) {
        Rw(&mut lot.try_borrow_mut_data()?).set_u8(LT::STATE, STATE_CLOSED)?;
        close_account(
            p,
            lot,
            rent_to,
            E2::Lot,
            &close_key_lot(lv.seed_tag, lv.seq),
            bell,
        )?;
    }
    if close_issue {
        close_account(
            p,
            issue,
            issue_rent_to,
            E2::Issue,
            &close_key_issue(iv.issuer_tag, iv.seq),
            bell,
        )?;
    }
    Ok(())
}

/// CloseLot of a lot whose issue is gone (its issuer closed it void): the
/// holder's lot closes with its units (void), logged `LOT_CLOSED` with
/// `issue_closed` (the issue is already closed).
fn close_orphan_lot<'a>(
    p: &Pubkey,
    pl: &Player,
    citizen: &AccountInfo<'a>,
    issue: &AccountInfo<'a>,
    lot: &AccountInfo<'a>,
    rent_to: &AccountInfo<'a>,
    bell: u32,
) -> R<()> {
    let lv = read_lot(p, pl, lot)?;
    expect_key(
        issue,
        &frontier_abi::v2::addr::issue(&pl.ctx, lv.issuer_tag, lv.issue_seq),
    )?;
    if lv.holder != citizen.key.to_bytes() {
        return Err(FrontierError::NotOwner.into());
    }
    if lv.state != STATE_LIVE || lv.escrow != 0 || lv.rent_to != rent_to.key.to_bytes() {
        return Err(BAD_ACCOUNT);
    }
    let payload = crate::events::Buf::<40>::new()
        .u64(pl.pc.citizen_tag)
        .u64(lv.seed_tag)
        .u32(lv.seq)
        .u64(lv.amount)
        .u8(1)
        .u8(1)
        .u8(1)
        .bytes(&[0u8; 8])
        .u8(0);
    {
        let mut cd = citizen.try_borrow_mut_data()?;
        cqlog::emit(
            CqKind::LOT_CLOSED as u8,
            bell,
            &key12(lv.issuer_tag, lv.issue_seq),
            payload.get()?,
            &mut [Chained2 {
                entity: E2::Citizen,
                data: &mut cd,
            }],
        )?;
    }
    Rw(&mut lot.try_borrow_mut_data()?).set_u8(LT::STATE, STATE_CLOSED)?;
    close_account(
        p,
        lot,
        rent_to,
        E2::Lot,
        &close_key_lot(lv.seed_tag, lv.seq),
        bell,
    )
}

// ------------------------------------------------------------ 0xC3 OpenShares

/// 0xC3 OpenShares (2b): P + `[holding w] [holding_province r] [vault w]
/// [issue w] [lot w] [system]` (`S2-2B-CONTRACT.md` §3.1): the owner's
/// vault becomes shared; the owner's deposit lot holds the vault's value.
pub fn open_shares(p: &Pubkey, a: &[AccountInfo], d: &[u8]) -> R<()> {
    check_accounts_v2(Ix2::OpenShares, a, None)?;
    ix2::OpenShares::decode(d)?;
    let pl: Player = hold::player(p, a)?;
    let [_, payer, season_ai, citizen, holding, holding_province, vault, issue, lot, _system] = a
    else {
        return Err(FrontierError::TooManyAccounts.into());
    };
    let sid = pl.pc.season.id;
    let bell = pl.pc.now_bell;
    // The vault: the citizen's, live, not shared.
    let src: Place = place_of(p, &pl.ctx, sid, vault)?.ok_or(cq(CqError::TicketTerms))?;
    if src.kind != PL::KIND_VAULT {
        return Err(cq(CqError::TicketTerms));
    }
    if src.owner != citizen.key.to_bytes() {
        return Err(FrontierError::NotOwner.into());
    }
    let supply = {
        let vd = vault.try_borrow_data()?;
        if vault_shares(&vd)?.is_some() {
            return Err(cq(CqError::VaultShared));
        }
        // Receipts and shares never share a vault (2b §9, 2c §1): no claim
        // of yesterday or today and no grant of today may be outstanding
        // (claims and withdrawals are refused once it is shared).
        let mut period = period_of(&vd)?;
        if period.active() {
            period.roll(bell / BELLS_PER_DAY, &super::caravan::vault_free(&vd)?);
            if period.claims.iter().chain(period.res.iter()).any(|&v| v > 0) {
                return Err(cq(CqError::ReceiptState));
            }
        }
        // 2e: nor escrows' holds (they would leave with the basket).
        if super::caravan::vault_held(&vd)?.iter().any(|&h| h != 0) {
            return Err(cq(CqError::EscrowState));
        }
        let mut stores = [0i64; RESOURCES];
        for (r, v) in stores.iter_mut().enumerate() {
            *v = Ro(&vd).i64(VA::store(r))?;
        }
        (kt::value_of(&stores) / 1_000).min(u64::MAX as u128) as u64
    };
    let seq = {
        let cd = citizen.try_borrow_data()?;
        let r = Ro(&cd);
        if r.u8(C::OPEN_ISSUES)? >= MAX_OPEN_ISSUES {
            return Err(cq(CqError::TicketLimit));
        }
        r.u32(C::ISSUES)?
    };
    let hkey = pay_fee(p, &pl, holding, citizen, holding_province)?;
    let issuer_tag = pl.pc.citizen_tag;
    create_issue(
        p,
        &pl,
        payer,
        season_ai,
        citizen,
        issue,
        &NewIssue {
            stamp: source_stamp(vault)?,
            kind: KIND_SHARE,
            src_kind: SRC_VAULT,
            src: &src,
            seq,
            resource: 0,
            supply,
            per_unit: 0,
            until_day: kt::NO_END,
        },
    )?;
    let iv = read_issue(p, &pl, issue)?;
    let lot_seq = deposit_seq(issuer_tag, seq);
    let me = citizen.key.to_bytes();
    init_lot(
        p, &pl, payer, season_ai, lot, &iv, &me, issuer_tag, issuer_tag, lot_seq, supply,
    )?;
    {
        let mut vd = vault.try_borrow_mut_data()?;
        let mut w = Rw(&mut vd);
        w.set_u8(VA::SHARES_ON, 1)?;
        w.set_u32(VA::SHARES_SEQ, seq)?;
        w.set_u64(VA::SHARES_ISSUER_TAG, issuer_tag)?;
    }
    {
        let mut cd = citizen.try_borrow_mut_data()?;
        let open = Ro(&cd).u8(C::OPEN_ISSUES)?;
        let mut w = Rw(&mut cd);
        w.set_u32(C::ISSUES, seq.checked_add(1).ok_or(OVERFLOW)?)?;
        w.set_u8(C::OPEN_ISSUES, open + 1)?;
    }
    let payload = crate::events::Buf::<60>::new()
        .bytes(&src.log())
        .u64(supply)
        .u32(lot_seq)
        .u64(hkey)
        .bytes(&hold::cost_digest(&kt::issue_fee()));
    let mut cd = citizen.try_borrow_mut_data()?;
    let mut hd = holding.try_borrow_mut_data()?;
    let mut vd = vault.try_borrow_mut_data()?;
    let mut idata = issue.try_borrow_mut_data()?;
    let mut ld = lot.try_borrow_mut_data()?;
    cqlog::emit(
        CqKind::SHARES_OPENED as u8,
        bell,
        &key12(issuer_tag, seq),
        payload.get()?,
        &mut [
            Chained2 {
                entity: E2::Citizen,
                data: &mut cd,
            },
            Chained2 {
                entity: E2::Holding,
                data: &mut hd,
            },
            Chained2 {
                entity: E2::Vault,
                data: &mut vd,
            },
            Chained2 {
                entity: E2::Issue,
                data: &mut idata,
            },
            Chained2 {
                entity: E2::Lot,
                data: &mut ld,
            },
        ],
    )
}

// ------------------------------------------------------------ 0xC4 WithdrawShares

/// 0xC4 WithdrawShares (2b): P + `[lot w] [issue w] [src w] [dst r]
/// [caravan w] [system] [path_province w ×1..4]` (§3.2): the holder burns
/// `amount` units and sends the basket out of the shared vault.
pub fn withdraw_shares(p: &Pubkey, a: &[AccountInfo], d: &[u8]) -> R<()> {
    let n_prov = a
        .len()
        .checked_sub(10)
        .ok_or(FrontierError::TooManyAccounts)?;
    check_accounts_v2(Ix2::WithdrawShares, a, Some(&[1, 1, n_prov as u8]))?;
    let x = ix2::WithdrawShares::decode(d)?;
    let pl: Player = hold::player(p, a)?;
    let [_, payer, season_ai, citizen, lot, issue, src, dst, caravan, _system, provinces @ ..] = a
    else {
        return Err(FrontierError::TooManyAccounts.into());
    };
    let bell = pl.pc.now_bell;
    let from = read_lot(p, &pl, lot)?;
    if from.holder != citizen.key.to_bytes() {
        return Err(FrontierError::NotOwner.into());
    }
    if from.state != STATE_LIVE || from.escrow != 0 {
        return Err(cq(CqError::TicketVoid));
    }
    let iv = read_issue(p, &pl, issue)?;
    if (iv.issuer_tag, iv.seq) != (from.issuer_tag, from.issue_seq) {
        return Err(BAD_ACCOUNT);
    }
    if iv.kind != KIND_SHARE {
        return Err(cq(CqError::TicketTerms));
    }
    if !issue_valid(p, &pl, &iv, src)? || from.src_gen != iv.src_gen {
        return Err(cq(CqError::TicketVoid));
    }
    if x.amount == 0 || x.amount > from.amount {
        return Err(FrontierError::BadData.into());
    }
    let basket = {
        let vd = src.try_borrow_data()?;
        if vault_shares(&vd)? != Some((iv.issuer_tag, iv.seq)) {
            return Err(cq(CqError::TicketVoid));
        }
        let mut stores = [0i64; RESOURCES];
        for (r, v) in stores.iter_mut().enumerate() {
            *v = Ro(&vd).i64(VA::store(r))?;
        }
        kt::basket(&stores, x.amount, iv.supply)
    };
    send(
        p,
        &pl,
        &SendAccounts {
            payer,
            season_ai,
            citizen,
            src,
            dst,
            caravan,
            provinces,
        },
        &SendOrder {
            seq: x.seq,
            dst: (x.dst_kind, x.dst_p, x.dst_q, x.dst_at, x.dst_gen),
            steps: x.steps,
            path: x.path,
            fee: x.fee,
        },
        &basket,
        SendBy::Shares,
    )?;
    let supply = iv.supply.checked_sub(x.amount).ok_or(OVERFLOW)?;
    Rw(&mut lot.try_borrow_mut_data()?).set_u64(LT::AMOUNT, from.amount - x.amount)?;
    Rw(&mut issue.try_borrow_mut_data()?).set_u64(IS::SUPPLY, supply)?;
    let payload = crate::events::Buf::<40>::new()
        .u64(pl.pc.citizen_tag)
        .u64(from.seed_tag)
        .u32(from.seq)
        .u64(x.amount)
        .u64(supply)
        .u32(x.seq);
    let mut ld = lot.try_borrow_mut_data()?;
    let mut idata = issue.try_borrow_mut_data()?;
    cqlog::emit(
        CqKind::SHARES_WITHDRAWN as u8,
        bell,
        &key12(iv.issuer_tag, iv.seq),
        payload.get()?,
        &mut [
            Chained2 {
                entity: E2::Lot,
                data: &mut ld,
            },
            Chained2 {
                entity: E2::Issue,
                data: &mut idata,
            },
        ],
    )
}

// ------------------------------------------------------------ deposits (SettleDeposit)

/// Where a deposit settles: the season, the bell, the vault's generation and
/// the caravan `(owner_tag, seq)`.
pub(crate) struct DepositAt<'c> {
    pub(crate) ctx: &'c AddrCtx,
    pub(crate) sid: u64,
    pub(crate) bump: u8,
    pub(crate) bell: u32,
    pub(crate) vault_gen: u8,
    pub(crate) caravan: (u64, u32),
}

/// The holder's deposit lot of the vault's share issue, created (empty, its
/// rent from `payer`) when absent; whether it was. SettleDeposit calls it
/// before moving any lamports, and [`deposit`] after.
#[allow(clippy::too_many_arguments)]
pub(crate) fn deposit_lot<'a>(
    p: &Pubkey,
    at: &DepositAt,
    payer: &AccountInfo<'a>,
    season_ai: &AccountInfo<'a>,
    issue: &AccountInfo<'a>,
    lot: &AccountInfo<'a>,
    issue_key: (u64, u32),
    holder: &[u8; 32],
) -> R<bool> {
    let iv = share_issue(p, at, issue, issue_key)?;
    let holder_tag = citizen_tag(holder);
    let lot_seq = deposit_seq(iv.issuer_tag, iv.seq);
    expect_key(
        lot,
        &frontier_abi::v2::addr::lot(at.ctx, holder_tag, lot_seq),
    )?;
    if !init::is_absent(lot) {
        return Ok(false);
    }
    let season = Season {
        ctx: at.ctx,
        sid: at.sid,
        bump: at.bump,
    };
    init_lot_at(
        p, &season, payer, season_ai, lot, &iv, holder, holder_tag, holder_tag, lot_seq, 0,
    )?;
    Ok(true)
}

/// The vault's live share issue `issue_key` in the vault's generation.
fn share_issue(
    p: &Pubkey,
    at: &DepositAt,
    issue: &AccountInfo,
    issue_key: (u64, u32),
) -> R<IssueView> {
    let iv = read_issue_at(p, at.ctx, at.sid, issue)?;
    if (iv.issuer_tag, iv.seq) != issue_key
        || iv.kind != KIND_SHARE
        || iv.state != STATE_LIVE
        || iv.src_gen != at.vault_gen
    {
        return Err(BAD_ACCOUNT);
    }
    Ok(iv)
}

/// A delivery into a shared vault (SettleDeposit, §1 and §3.3): mints
/// `ticket::minted(dv, supply, v0)` units into the holder's deposit lot
/// and logs `SHARES_DEPOSITED`. A deposit address held by a lot of another
/// issue mints nothing.
#[allow(clippy::too_many_arguments)]
pub(crate) fn deposit(
    p: &Pubkey,
    at: &DepositAt,
    issue: &AccountInfo,
    lot: &AccountInfo,
    issue_key: (u64, u32),
    holder: &[u8; 32],
    dv: u128,
    v0: u128,
    new_lot: bool,
) -> R<()> {
    let iv = share_issue(p, at, issue, issue_key)?;
    let holder_tag = citizen_tag(holder);
    let lot_seq = deposit_seq(iv.issuer_tag, iv.seq);
    expect_key(
        lot,
        &frontier_abi::v2::addr::lot(at.ctx, holder_tag, lot_seq),
    )?;
    let mut minted = kt::minted(dv, iv.supply, v0);
    {
        let lv = read_lot_at(p, at.ctx, at.sid, lot)?;
        let ours = (lv.issuer_tag, lv.issue_seq) == issue_key
            && lv.holder == *holder
            && lv.state == STATE_LIVE
            && lv.src_gen == iv.src_gen;
        if ours {
            let sum = lv.amount.saturating_add(minted);
            minted = sum - lv.amount;
            Rw(&mut lot.try_borrow_mut_data()?).set_u64(LT::AMOUNT, sum)?;
        } else {
            minted = 0;
        }
    }
    let supply = iv.supply.saturating_add(minted);
    Rw(&mut issue.try_borrow_mut_data()?).set_u64(IS::SUPPLY, supply)?;
    let payload = crate::events::Buf::<49>::new()
        .u64(holder_tag)
        .u32(lot_seq)
        .u64((dv / 1_000).min(u64::MAX as u128) as u64)
        .u64(minted)
        .u64(supply)
        .u64(at.caravan.0)
        .u32(at.caravan.1)
        .u8(new_lot as u8);
    let mut idata = issue.try_borrow_mut_data()?;
    let mut ld = lot.try_borrow_mut_data()?;
    cqlog::emit(
        CqKind::SHARES_DEPOSITED as u8,
        at.bell,
        &key12(iv.issuer_tag, iv.seq),
        payload.get()?,
        &mut [
            Chained2 {
                entity: E2::Issue,
                data: &mut idata,
            },
            Chained2 {
                entity: E2::Lot,
                data: &mut ld,
            },
        ],
    )
}

// ------------------------------------------------------------ 0xC6 ClaimReceipt, 0xC7 WithdrawReceipt

/// The receipt lot the citizen claims or withdraws from: its lot and issue,
/// checked (the citizen's, live, not in escrow, of a live receipt issue
/// valid now with `vault`).
fn receipt_lot(
    p: &Pubkey,
    pl: &Player,
    citizen: &AccountInfo,
    lot: &AccountInfo,
    issue: &AccountInfo,
    vault: &AccountInfo,
) -> R<(LotView, IssueView)> {
    let lv = read_lot(p, pl, lot)?;
    if lv.holder != citizen.key.to_bytes() {
        return Err(FrontierError::NotOwner.into());
    }
    if lv.state != STATE_LIVE || lv.escrow != 0 {
        return Err(cq(CqError::TicketVoid));
    }
    let iv = read_issue(p, pl, issue)?;
    if (iv.issuer_tag, iv.seq) != (lv.issuer_tag, lv.issue_seq) {
        return Err(BAD_ACCOUNT);
    }
    if iv.kind != KIND_RECEIPT {
        return Err(cq(CqError::TicketTerms));
    }
    if !issue_valid(p, pl, &iv, vault)? || lv.src_gen != iv.src_gen {
        return Err(cq(CqError::TicketVoid));
    }
    // A shared vault's goods are its holders' (2b): no receipts on it.
    if vault_shares(&vault.try_borrow_data()?)?.is_some() {
        return Err(cq(CqError::VaultShared));
    }
    Ok((lv, iv))
}

/// 0xC6 ClaimReceipt (2c): P + `[lot w] [issue r] [vault w]`
/// (`S2-2C-CONTRACT.md` §4.1): the lot's whole entitlement for today.
pub fn claim_receipt(p: &Pubkey, a: &[AccountInfo], d: &[u8]) -> R<()> {
    check_accounts_v2(Ix2::ClaimReceipt, a, None)?;
    ix2::ClaimReceipt::decode(d)?;
    let pl: Player = hold::player(p, a)?;
    let [_, _, _, citizen, lot, issue, vault] = a else {
        return Err(FrontierError::TooManyAccounts.into());
    };
    let bell = pl.pc.now_bell;
    let today = bell / BELLS_PER_DAY;
    let (lv, iv) = receipt_lot(p, &pl, citizen, lot, issue, vault)?;
    if iv.until_day != kt::NO_END && today > iv.until_day {
        return Err(cq(CqError::TicketTerms));
    }
    let today1 = today + 1;
    let claim = lv.amount.checked_mul(iv.per_unit).ok_or(OVERFLOW)?;
    let r = iv.resource as usize;
    let claims = {
        let mut vd = vault.try_borrow_mut_data()?;
        let mut period = period_of(&vd)?;
        period.roll(today, &super::caravan::vault_free(&vd)?);
        // Once a day; yesterday's claim withdrawn first, unless it grants
        // nothing (then it lapses).
        let pending = lv.day + 1 == today1 && kt::grant(lv.day_amount, period.ratio[r]) > 0;
        if lv.day == today1 || pending || claim == 0 {
            return Err(cq(CqError::ReceiptState));
        }
        period.claims[r] = period.claims[r].saturating_add(claim);
        put_period(&mut vd, &period)?;
        period.claims[r]
    };
    {
        let mut ld = lot.try_borrow_mut_data()?;
        let mut w = Rw(&mut ld);
        w.set_u32(LT::DAY, today1)?;
        w.set_u64(LT::DAY_AMOUNT, claim)?;
    }
    let src = place_of(p, &pl.ctx, pl.pc.season.id, vault)?.ok_or(BAD_ACCOUNT)?;
    let payload = crate::events::Buf::<52>::new()
        .u64(pl.pc.citizen_tag)
        .u64(lv.seed_tag)
        .u32(lv.seq)
        .u32(today)
        .u64(claim)
        .u64(claims)
        .bytes(&src.log());
    let mut ld = lot.try_borrow_mut_data()?;
    let mut vd = vault.try_borrow_mut_data()?;
    cqlog::emit(
        CqKind::RECEIPT_CLAIMED as u8,
        bell,
        &key12(iv.issuer_tag, iv.seq),
        payload.get()?,
        &mut [
            Chained2 {
                entity: E2::Lot,
                data: &mut ld,
            },
            Chained2 {
                entity: E2::Vault,
                data: &mut vd,
            },
        ],
    )
}

/// 0xC7 WithdrawReceipt (2c): P + `[lot w] [issue r] [src w] [dst r]
/// [caravan w] [system] [path_province w ×1..4]` (§4.2): yesterday's
/// claim at the day's ratio, out of the vault by caravan.
pub fn withdraw_receipt(p: &Pubkey, a: &[AccountInfo], d: &[u8]) -> R<()> {
    let n_prov = a
        .len()
        .checked_sub(10)
        .ok_or(FrontierError::TooManyAccounts)?;
    check_accounts_v2(Ix2::WithdrawReceipt, a, Some(&[1, 1, n_prov as u8]))?;
    let x = ix2::WithdrawReceipt::decode(d)?;
    let pl: Player = hold::player(p, a)?;
    let [_, payer, season_ai, citizen, lot, issue, src, dst, caravan, _system, provinces @ ..] = a
    else {
        return Err(FrontierError::TooManyAccounts.into());
    };
    let bell = pl.pc.now_bell;
    let today = bell / BELLS_PER_DAY;
    let (lv, iv) = receipt_lot(p, &pl, citizen, lot, issue, src)?;
    let r = iv.resource as usize;
    let (ratio, grant) = {
        let mut vd = src.try_borrow_mut_data()?;
        let mut period = roll_vault(&mut vd, bell)?;
        if lv.day == 0 || lv.day + 1 != period.res_day || lv.day_amount == 0 {
            return Err(cq(CqError::ReceiptState));
        }
        let ratio = period.ratio[r];
        let grant = kt::grant(lv.day_amount, ratio);
        if grant == 0 {
            return Err(cq(CqError::ReceiptState));
        }
        period.res[r] = period.res[r].checked_sub(grant).ok_or(OVERFLOW)?;
        put_period(&mut vd, &period)?;
        (ratio, grant)
    };
    Rw(&mut lot.try_borrow_mut_data()?).set_u64(LT::DAY_AMOUNT, 0)?;
    let mut cargo = [0i64; RESOURCES];
    cargo[r] = grant as i64;
    send(
        p,
        &pl,
        &SendAccounts {
            payer,
            season_ai,
            citizen,
            src,
            dst,
            caravan,
            provinces,
        },
        &SendOrder {
            seq: x.seq,
            dst: (x.dst_kind, x.dst_p, x.dst_q, x.dst_at, x.dst_gen),
            steps: x.steps,
            path: x.path,
            fee: x.fee,
        },
        &cargo,
        SendBy::Receipt,
    )?;
    let payload = crate::events::Buf::<56>::new()
        .u64(pl.pc.citizen_tag)
        .u64(lv.seed_tag)
        .u32(lv.seq)
        .u32(today - 1)
        .u64(lv.day_amount)
        .u32(ratio)
        .u64(grant)
        .u32(x.seq);
    let mut ld = lot.try_borrow_mut_data()?;
    cqlog::emit(
        CqKind::RECEIPT_WITHDRAWN as u8,
        bell,
        &key12(iv.issuer_tag, iv.seq),
        payload.get()?,
        &mut [Chained2 {
            entity: E2::Lot,
            data: &mut ld,
        }],
    )
}

// ------------------------------------------------------------ 0xC8 UseRun

/// 0xC8 UseRun(runs) (2d): P + `[lot w] [issue r] [holding w] [vault w]`
/// (`S2-2D-CONTRACT.md` §3): `runs` workshop-hours converted at once in the
/// citizen's vault in the workshop's Province (L4).
pub fn use_run(p: &Pubkey, a: &[AccountInfo], d: &[u8]) -> R<()> {
    check_accounts_v2(Ix2::UseRun, a, None)?;
    let x = ix2::UseRun::decode(d)?;
    let pl: Player = hold::player(p, a)?;
    let [_, _, _, citizen, lot, issue, holding, vault] = a else {
        return Err(FrontierError::TooManyAccounts.into());
    };
    let sid = pl.pc.season.id;
    let bell = pl.pc.now_bell;
    let today = bell / BELLS_PER_DAY;
    let today1 = today + 1;
    let runs = x.runs as u32;
    if runs == 0 {
        return Err(FrontierError::BadData.into());
    }
    // The lot and its issue, valid now.
    let lv = read_lot(p, &pl, lot)?;
    if lv.holder != citizen.key.to_bytes() {
        return Err(FrontierError::NotOwner.into());
    }
    if lv.state != STATE_LIVE || lv.escrow != 0 {
        return Err(cq(CqError::TicketVoid));
    }
    let iv = read_issue(p, &pl, issue)?;
    if (iv.issuer_tag, iv.seq) != (lv.issuer_tag, lv.issue_seq) {
        return Err(BAD_ACCOUNT);
    }
    if iv.kind != KIND_USE {
        return Err(cq(CqError::TicketTerms));
    }
    if !issue_valid(p, &pl, &iv, holding)? || lv.src_gen != iv.src_gen {
        return Err(cq(CqError::TicketVoid));
    }
    if iv.until_day != kt::NO_END && today > iv.until_day {
        return Err(cq(CqError::TicketTerms));
    }
    // The limits: the lot's and the workshop's runs today.
    let lot_used = if lv.day == today1 { lv.day_amount } else { 0 };
    let lot_runs = lot_used.checked_add(runs as u64).ok_or(OVERFLOW)?;
    if lot_runs > lv.amount.saturating_mul(iv.per_unit) {
        return Err(cq(CqError::UseLimit));
    }
    let holding_runs = {
        let hd = holding.try_borrow_data()?;
        let r = Ro(&hd);
        let mut production = [0i64; RESOURCES];
        for (i, v) in production.iter_mut().enumerate() {
            *v = r.i64(H::PRODUCTION + 8 * i)?;
        }
        let cap = arms::workshops_built(&production).max(0) as u32 * kt::RUNS_PER_COPY;
        let used = if r.u16(H::USE_DAY)? as u32 == today1 {
            r.u16(H::USE_RUNS)? as u32
        } else {
            0
        };
        let total = used + runs;
        if cap == 0 || total > cap {
            return Err(cq(CqError::UseLimit));
        }
        total
    };
    // The citizen's own unshared vault in the workshop's Province.
    let v: Place = place_of(p, &pl.ctx, sid, vault)?.ok_or(cq(CqError::TicketTerms))?;
    if v.kind != PL::KIND_VAULT || v.owner != citizen.key.to_bytes() {
        return Err(FrontierError::NotOwner.into());
    }
    if (v.p, v.q) != (iv.p, iv.q) {
        return Err(cq(CqError::TicketTerms));
    }
    let (ore, wood, made) = kt::run_change(runs);
    {
        let mut vd = vault.try_borrow_mut_data()?;
        if vault_shares(&vd)?.is_some() {
            return Err(cq(CqError::VaultShared));
        }
        // 2c: the day boundary first; reserved goods stay.
        let period = roll_vault(&mut vd, bell)?;
        let stock = super::caravan::vault_stock(&vd)?;
        let free = super::caravan::vault_free(&vd)?;
        let (o, w, m) = (
            permutation_rules::frontier::holding::Resource::Ore as usize,
            permutation_rules::frontier::holding::Resource::Wood as usize,
            arms::ARMS as usize,
        );
        if period.available(today, o, free[o]) < ore || period.available(today, w, free[w]) < wood
        {
            return Err(FrontierError::Insufficient.into());
        }
        let cap = Ro(&vd).i64(VA::CAP)?;
        if stock[m].checked_add(made).ok_or(OVERFLOW)? > cap {
            return Err(FrontierError::BadData.into());
        }
        let mut wr = Rw(&mut vd);
        wr.set_i64(VA::store(o), stock[o] - ore)?;
        wr.set_i64(VA::store(w), stock[w] - wood)?;
        wr.set_i64(VA::store(m), stock[m] + made)?;
    }
    {
        let mut ld = lot.try_borrow_mut_data()?;
        let mut w = Rw(&mut ld);
        w.set_u32(LT::DAY, today1)?;
        w.set_u64(LT::DAY_AMOUNT, lot_runs)?;
    }
    {
        let mut hd = holding.try_borrow_mut_data()?;
        let mut w = Rw(&mut hd);
        w.set_u16(H::USE_DAY, today1 as u16)?;
        w.set_u16(H::USE_RUNS, holding_runs as u16)?;
    }
    let (hp, hq, hsite, hgen) = {
        let hd = holding.try_borrow_data()?;
        let r = Ro(&hd);
        (r.i16(H::P)?, r.i16(H::Q)?, r.u8(H::SITE)?, r.u8(H::GEN)?)
    };
    let hkey = host_id(hp as i32, hq as i32, hsite, hgen, 0).ok_or(BAD_ACCOUNT)?;
    let payload = crate::events::Buf::<47>::new()
        .u64(pl.pc.citizen_tag)
        .u64(lv.seed_tag)
        .u32(lv.seq)
        .u32(today)
        .u8(x.runs)
        .u16(lot_runs as u16)
        .u16(holding_runs as u16)
        .u64(hkey)
        .bytes(&v.log());
    let mut ld = lot.try_borrow_mut_data()?;
    let mut hd = holding.try_borrow_mut_data()?;
    let mut vd = vault.try_borrow_mut_data()?;
    cqlog::emit(
        CqKind::USE_RUN as u8,
        bell,
        &key12(iv.issuer_tag, iv.seq),
        payload.get()?,
        &mut [
            Chained2 {
                entity: E2::Holding,
                data: &mut hd,
            },
            Chained2 {
                entity: E2::Vault,
                data: &mut vd,
            },
            Chained2 {
                entity: E2::Lot,
                data: &mut ld,
            },
        ],
    )
}

// ------------------------------------------------------------ 0xC9–0xCC escrows (2e)

use frontier_abi::v2::layout::s2::escrow as ES;

/// One side of an Escrow as stored (`S2-2E-CONTRACT.md` §2.1).
#[derive(Clone, Copy)]
struct Side {
    citizen: [u8; 32],
    tag: u64,
    kind: u8,
    state: u8,
    resource: u8,
    gen: u8,
    p: i16,
    q: i16,
    tile: u8,
    amount: u64,
    lot_tag: u64,
    lot_seq: u32,
}

impl Side {
    fn read(d: &[u8], i: usize) -> R<Side> {
        let (o, r) = (ES::side(i), Ro(d));
        use ES::side as S;
        Ok(Side {
            citizen: r.arr(o + S::CITIZEN)?,
            tag: r.u64(o + S::TAG)?,
            kind: r.u8(o + S::KIND)?,
            state: r.u8(o + S::STATE)?,
            resource: r.u8(o + S::RESOURCE)?,
            gen: r.u8(o + S::GEN)?,
            p: r.i16(o + S::P)?,
            q: r.i16(o + S::Q)?,
            tile: r.u8(o + S::TILE)?,
            amount: r.u64(o + S::AMOUNT)?,
            lot_tag: r.u64(o + S::LOT_TAG)?,
            lot_seq: r.u32(o + S::LOT_SEQ)?,
        })
    }
    fn write(&self, d: &mut [u8], i: usize) -> R<()> {
        let o = ES::side(i);
        use ES::side as S;
        let mut w = Rw(d);
        w.set_arr(o + S::CITIZEN, &self.citizen)?;
        w.set_u64(o + S::TAG, self.tag)?;
        w.set_u8(o + S::KIND, self.kind)?;
        w.set_u8(o + S::STATE, self.state)?;
        w.set_u8(o + S::RESOURCE, self.resource)?;
        w.set_u8(o + S::GEN, self.gen)?;
        w.set_i16(o + S::P, self.p)?;
        w.set_i16(o + S::Q, self.q)?;
        w.set_u8(o + S::TILE, self.tile)?;
        w.set_u64(o + S::AMOUNT, self.amount)?;
        w.set_u64(o + S::LOT_TAG, self.lot_tag)?;
        w.set_u32(o + S::LOT_SEQ, self.lot_seq)?;
        Ok(())
    }
    /// The logged place of a goods side's vault (zeros for a lot).
    fn src_log(&self) -> [u8; 8] {
        if self.kind != ES::ITEM_GOODS {
            return [0; 8];
        }
        Place {
            kind: PL::KIND_VAULT,
            p: self.p,
            q: self.q,
            at: self.tile,
            gen: self.gen,
            tile: self.tile,
            owner: [0; 32],
        }
        .log()
    }
}

/// An Escrow's header fields.
struct EscrowView {
    state: u8,
    seq: u32,
    deadline: u32,
    sides: [Side; 2],
    rent_to: [u8; 32],
}

fn read_escrow(p: &Pubkey, pl: &Player, ai: &AccountInfo) -> R<EscrowView> {
    present_v2(ai, p, K2::Escrow, pl.pc.season.id)?;
    let d = ai.try_borrow_data()?;
    let r = Ro(&d);
    let v = EscrowView {
        state: r.u8(ES::STATE)?,
        seq: r.u32(ES::SEQ)?,
        deadline: r.u32(ES::DEADLINE_BELL)?,
        sides: [Side::read(&d, 0)?, Side::read(&d, 1)?],
        rent_to: r.arr(ES::RENT_TO)?,
    };
    expect_key(
        ai,
        &frontier_abi::v2::addr::escrow(&pl.ctx, v.sides[0].tag, v.seq),
    )?;
    Ok(v)
}

/// Puts goods in escrow: `amount` milli of `r` held in the citizen's own
/// live unshared vault `vault` (rolled first; only the free stock, less
/// today's receipt reservation, may be held). Returns the vault's place.
fn hold_goods(
    p: &Pubkey,
    pl: &Player,
    citizen: &AccountInfo,
    vault: &AccountInfo,
    at: (i16, i16, u8),
    r: u8,
    amount: u64,
) -> R<Place> {
    let v: Place = place_of(p, &pl.ctx, pl.pc.season.id, vault)?.ok_or(cq(CqError::TicketTerms))?;
    if v.kind != PL::KIND_VAULT || (v.p, v.q, v.at) != at {
        return Err(BAD_ACCOUNT);
    }
    if v.owner != citizen.key.to_bytes() {
        return Err(FrontierError::NotOwner.into());
    }
    let r = r as usize;
    if r >= RESOURCES || !goods_amount_ok(amount) {
        return Err(FrontierError::BadData.into());
    }
    let mut vd = vault.try_borrow_mut_data()?;
    if vault_shares(&vd)?.is_some() {
        return Err(cq(CqError::VaultShared));
    }
    let bell = pl.pc.now_bell;
    let period = roll_vault(&mut vd, bell)?;
    let free = super::caravan::vault_free(&vd)?;
    if period.available(bell / BELLS_PER_DAY, r, free[r]) < amount as i64 {
        return Err(FrontierError::Insufficient.into());
    }
    let held = Ro(&vd).u64(VA::held(r))?;
    Rw(&mut vd).set_u64(VA::held(r), held.checked_add(amount).ok_or(OVERFLOW)?)?;
    Ok(v)
}

/// An escrowed goods amount: whole units, nonzero, within a vault's reach
/// (`ESCROW_MAX_GOODS`; a larger one would wrap the signed stock maths).
fn goods_amount_ok(amount: u64) -> bool {
    amount != 0 && amount % 1_000 == 0 && amount <= kt::ESCROW_MAX_GOODS
}

/// Puts a whole lot in escrow (marked with `mark`): the citizen's, live,
/// not escrowed, not a share deposit lot, with units.
fn hold_lot(p: &Pubkey, pl: &Player, citizen: &AccountInfo, lot: &AccountInfo, key: (u64, u32), mark: u64) -> R<()> {
    expect_key(lot, &frontier_abi::v2::addr::lot(&pl.ctx, key.0, key.1))?;
    let lv = read_lot(p, pl, lot)?;
    if lv.holder != citizen.key.to_bytes() {
        return Err(FrontierError::NotOwner.into());
    }
    if lv.state != STATE_LIVE || lv.escrow != 0 || lv.amount == 0 || is_deposit_seq(lv.seq) {
        return Err(cq(CqError::TicketTerms));
    }
    Rw(&mut lot.try_borrow_mut_data()?).set_u64(LT::ESCROW, mark)
}

/// 0xC9 OpenEscrow (2e): P + `[escrow w] [taker r] [give_src w] [system]`
/// (`S2-2E-CONTRACT.md` §3.1).
pub fn open_escrow(p: &Pubkey, a: &[AccountInfo], d: &[u8]) -> R<()> {
    check_accounts_v2(Ix2::OpenEscrow, a, None)?;
    let x = ix2::OpenEscrow::decode(d)?;
    let pl: Player = hold::player(p, a)?;
    let [_, payer, season_ai, citizen, escrow, taker, give_src, _system] = a else {
        return Err(FrontierError::TooManyAccounts.into());
    };
    let sid = pl.pc.season.id;
    let bell = pl.pc.now_bell;
    if x.deadline_bell <= bell || x.deadline_bell - bell > kt::ESCROW_MAX_BELLS {
        return Err(FrontierError::BadData.into());
    }
    present_v2(taker, p, K2::Citizen, sid)?;
    let ttag = Ro(&taker.try_borrow_data()?).u64(C::CITIZEN_TAG)?;
    if taker.key == citizen.key || ttag != x.taker_tag {
        return Err(FrontierError::BadData.into());
    }
    match x.want_kind {
        ES::ITEM_GOODS => {
            if x.want_resource as usize >= RESOURCES || !goods_amount_ok(x.want_amount) {
                return Err(FrontierError::BadData.into());
            }
        }
        // A wanted lot names the units it must hold at acceptance.
        ES::ITEM_LOT => {
            if x.want_amount == 0 {
                return Err(FrontierError::BadData.into());
            }
        }
        _ => return Err(FrontierError::BadData.into()),
    }
    let tag = pl.pc.citizen_tag;
    let seq = Ro(&citizen.try_borrow_data()?).u32(C::LOTS)?;
    expect_key(escrow, &frontier_abi::v2::addr::escrow(&pl.ctx, tag, seq))?;
    if !init::is_absent(escrow) {
        return Err(BAD_ACCOUNT);
    }
    let mark = frontier_abi::v2::addr::escrow_mark(tag, seq);
    let mut give = Side {
        citizen: citizen.key.to_bytes(),
        tag,
        kind: x.give_kind,
        state: ES::SIDE_IN,
        resource: 0,
        gen: 0,
        p: 0,
        q: 0,
        tile: 0,
        amount: 0,
        lot_tag: 0,
        lot_seq: 0,
    };
    match x.give_kind {
        ES::ITEM_GOODS => {
            let v = hold_goods(
                p,
                &pl,
                citizen,
                give_src,
                (x.give_p, x.give_q, x.give_tile),
                x.give_resource,
                x.give_amount,
            )?;
            (give.resource, give.gen, give.p, give.q, give.tile) =
                (x.give_resource, v.gen, v.p, v.q, v.at);
            give.amount = x.give_amount;
        }
        ES::ITEM_LOT => {
            hold_lot(p, &pl, citizen, give_src, (x.give_lot_tag, x.give_lot_seq), mark)?;
            give.amount = Ro(&give_src.try_borrow_data()?).u64(LT::AMOUNT)?;
            (give.lot_tag, give.lot_seq) = (x.give_lot_tag, x.give_lot_seq);
        }
        _ => return Err(FrontierError::BadData.into()),
    }
    let want = Side {
        citizen: taker.key.to_bytes(),
        tag: ttag,
        kind: x.want_kind,
        state: ES::SIDE_PROMISED,
        resource: if x.want_kind == ES::ITEM_GOODS { x.want_resource } else { 0 },
        gen: 0,
        p: 0,
        q: 0,
        tile: 0,
        amount: x.want_amount,
        lot_tag: if x.want_kind == ES::ITEM_LOT { x.want_lot_tag } else { 0 },
        lot_seq: if x.want_kind == ES::ITEM_LOT { x.want_lot_seq } else { 0 },
    };
    // The Escrow, funded by the payer.
    {
        let signer = SeasonSigner::new(sid, pl.pc.season.bump);
        let seed = frontier_abi::v2::addr::escrow_seed(tag, seq);
        let rent = init::rent(ES::SIZE)?;
        init::init_with_seed(payer, escrow, season_ai, &signer, &seed, ES::SIZE, rent, p)?;
        let mut ed = escrow.try_borrow_mut_data()?;
        if !frontier_abi::v2::layout::write_header(&mut ed, K2::Escrow, sid) {
            return Err(BAD_ACCOUNT);
        }
        {
            let mut w = Rw(&mut ed);
            w.set_u8(ES::STATE, ES::STATE_OPEN)?;
            w.set_u32(ES::SEQ, seq)?;
            w.set_u32(ES::DEADLINE_BELL, x.deadline_bell)?;
            w.set_u32(ES::OPENED_BELL, bell)?;
            w.set_arr(ES::RENT_TO, payer.key.as_ref())?;
        }
        give.write(&mut ed, 0)?;
        want.write(&mut ed, 1)?;
    }
    {
        let mut cd = citizen.try_borrow_mut_data()?;
        Rw(&mut cd).set_u32(C::LOTS, seq.checked_add(1).ok_or(OVERFLOW)?)?;
    }
    let payload = crate::events::Buf::<96>::new()
        .u64(ttag)
        .u32(x.deadline_bell)
        .u8(give.kind)
        .u64(give.amount)
        .u64(give.lot_tag)
        .u32(give.lot_seq)
        .bytes(&give.src_log())
        .u8(want.kind)
        .u64(want.amount)
        .u64(want.lot_tag)
        .u32(want.lot_seq)
        .bytes(payer.key.as_ref())
        .u8(give.resource)
        .u8(want.resource);
    let mut cd = citizen.try_borrow_mut_data()?;
    let mut gd = give_src.try_borrow_mut_data()?;
    let mut ed = escrow.try_borrow_mut_data()?;
    let give_entity = if give.kind == ES::ITEM_GOODS { E2::Vault } else { E2::Lot };
    cqlog::emit(
        CqKind::ESCROW_OPENED as u8,
        bell,
        &key12(tag, seq),
        payload.get()?,
        &mut [
            Chained2 {
                entity: E2::Citizen,
                data: &mut cd,
            },
            Chained2 {
                entity: give_entity,
                data: &mut gd,
            },
            Chained2 {
                entity: E2::Escrow,
                data: &mut ed,
            },
        ],
    )
}

/// The item account of side `s` (its vault or its lot) at its address.
fn expect_item(pl: &Player, ai: &AccountInfo, s: &Side) -> R<()> {
    let want = if s.kind == ES::ITEM_GOODS {
        frontier_abi::v2::addr::vault(&pl.ctx, s.p as i32, s.q as i32, s.tile)
    } else {
        frontier_abi::v2::addr::lot(&pl.ctx, s.lot_tag, s.lot_seq)
    };
    expect_key(ai, &want)
}

/// Gives an escrowed lot to `to` (holder rewritten in place, mark cleared).
fn hand_lot(lot: &AccountInfo, to: &[u8; 32], to_tag: u64, mark: u64) -> R<()> {
    let mut ld = lot.try_borrow_mut_data()?;
    if Ro(&ld).u64(LT::ESCROW)? != mark {
        return Err(cq(CqError::EscrowState));
    }
    let mut w = Rw(&mut ld);
    w.set_arr(LT::HOLDER_CITIZEN, to)?;
    w.set_u64(LT::HOLDER_TAG, to_tag)?;
    w.set_u64(LT::ESCROW, 0)
}

/// 0xCA AcceptEscrow (2e): P + `[escrow w] [maker_src w] [taker_src w]` (`S2-2E-CONTRACT.md` §3.2): the taker's item in, and the
/// swap.
pub fn accept_escrow(p: &Pubkey, a: &[AccountInfo], d: &[u8]) -> R<()> {
    check_accounts_v2(Ix2::AcceptEscrow, a, None)?;
    let x = ix2::AcceptEscrow::decode(d)?;
    let pl: Player = hold::player(p, a)?;
    let [_, _, _, citizen, escrow, maker_src, taker_src] = a else {
        return Err(FrontierError::TooManyAccounts.into());
    };
    let bell = pl.pc.now_bell;
    let ev = read_escrow(p, &pl, escrow)?;
    let [mut ms, mut ts] = ev.sides;
    if ev.state != ES::STATE_OPEN || bell > ev.deadline || ts.citizen != citizen.key.to_bytes() {
        return Err(cq(CqError::EscrowState));
    }
    expect_item(&pl, maker_src, &ms)?;
    // The maker's goods must still be owed from a live vault (a seizure
    // since the opening voided them).
    if ms.kind == ES::ITEM_GOODS && !goods_live(p, &pl, maker_src, &ms)? {
        return Err(cq(CqError::TicketVoid));
    }
    let mark = frontier_abi::v2::addr::escrow_mark(ms.tag, ev.seq);
    // The taker's item in.
    if ts.kind == ES::ITEM_GOODS {
        let v = hold_goods(
            p,
            &pl,
            citizen,
            taker_src,
            (x.vault_p, x.vault_q, x.vault_tile),
            ts.resource,
            ts.amount,
        )?;
        (ts.gen, ts.p, ts.q, ts.tile) = (v.gen, v.p, v.q, v.at);
    } else {
        hold_lot(p, &pl, citizen, taker_src, (ts.lot_tag, ts.lot_seq), mark)?;
        if Ro(&taker_src.try_borrow_data()?).u64(LT::AMOUNT)? != ts.amount {
            return Err(cq(CqError::EscrowState));
        }
    }
    // The swap: lots change holder now, goods become owed.
    if ms.kind == ES::ITEM_LOT {
        hand_lot(maker_src, &ts.citizen, ts.tag, mark)?;
        ms.state = ES::SIDE_DONE;
    } else {
        ms.state = ES::SIDE_OWED;
    }
    if ts.kind == ES::ITEM_LOT {
        hand_lot(taker_src, &ms.citizen, ms.tag, mark)?;
        ts.state = ES::SIDE_DONE;
    } else {
        ts.state = ES::SIDE_OWED;
    }
    let nothing_owed = ms.state != ES::SIDE_OWED && ts.state != ES::SIDE_OWED;
    {
        let mut ed = escrow.try_borrow_mut_data()?;
        Rw(&mut ed).set_u8(ES::STATE, ES::STATE_SETTLED)?;
        ms.write(&mut ed, 0)?;
        ts.write(&mut ed, 1)?;
    }
    let payload = crate::events::Buf::<43>::new()
        .u64(ts.tag)
        .u8(ms.kind)
        .u8(ts.kind)
        .u64(ms.lot_tag)
        .u32(ms.lot_seq)
        .u64(ts.lot_tag)
        .u32(ts.lot_seq)
        .bytes(&ts.src_log())
        .u8(nothing_owed as u8);
    let mut ed = escrow.try_borrow_mut_data()?;
    let mut td = taker_src.try_borrow_mut_data()?;
    let key = key12(ms.tag, ev.seq);
    let t_entity = if ts.kind == ES::ITEM_GOODS { E2::Vault } else { E2::Lot };
    if ms.kind == ES::ITEM_LOT {
        let mut md = maker_src.try_borrow_mut_data()?;
        // Tail order: a vault (9) before the lots (14), the maker's lot
        // before the taker's.
        let mut chain = [
            Chained2 {
                entity: E2::Lot,
                data: &mut md,
            },
            Chained2 {
                entity: t_entity,
                data: &mut td,
            },
            Chained2 {
                entity: E2::Escrow,
                data: &mut ed,
            },
        ];
        if t_entity == E2::Vault {
            chain.swap(0, 1);
        }
        cqlog::emit(CqKind::ESCROW_SETTLED as u8, bell, &key, payload.get()?, &mut chain)
    } else {
        cqlog::emit(
            CqKind::ESCROW_SETTLED as u8,
            bell,
            &key,
            payload.get()?,
            &mut [
                Chained2 {
                    entity: t_entity,
                    data: &mut td,
                },
                Chained2 {
                    entity: E2::Escrow,
                    data: &mut ed,
                },
            ],
        )
    }
}

/// Whether goods side `s` is still owed from a live vault in its
/// generation (`vault` at its address).
fn goods_live(p: &Pubkey, pl: &Player, vault: &AccountInfo, s: &Side) -> R<bool> {
    expect_item(pl, vault, s)?;
    if init::is_absent(vault) {
        return Ok(false);
    }
    Ok(place_of(p, &pl.ctx, pl.pc.season.id, vault)?.is_some_and(|v| v.gen == s.gen))
}

/// Releases goods side `s` held in `vault` when it is live in its
/// generation (a seizure cleared the holds already). `true` when released.
fn release_goods(p: &Pubkey, pl: &Player, vault: &AccountInfo, s: &Side) -> R<bool> {
    if !goods_live(p, pl, vault, s)? {
        return Ok(false);
    }
    let mut vd = vault.try_borrow_mut_data()?;
    let r = s.resource as usize;
    let held = Ro(&vd).u64(VA::held(r))?;
    Rw(&mut vd).set_u64(VA::held(r), held.checked_sub(s.amount).ok_or(OVERFLOW)?)?;
    Ok(true)
}

/// 0xCB CancelEscrow (2e): P + `[escrow w] [rent_to w]` + `[src w ×1..2]`
/// (`S2-2E-CONTRACT.md` §3.3).
pub fn cancel_escrow(p: &Pubkey, a: &[AccountInfo], d: &[u8]) -> R<()> {
    let n_src = a.len().checked_sub(6).ok_or(FrontierError::TooManyAccounts)?;
    check_accounts_v2(Ix2::CancelEscrow, a, Some(&[1, 1, n_src as u8]))?;
    ix2::CancelEscrow::decode(d)?;
    let pl: Player = hold::player(p, a)?;
    let [_, _, _, citizen, escrow, rent_to, srcs @ ..] = a else {
        return Err(FrontierError::TooManyAccounts.into());
    };
    let bell = pl.pc.now_bell;
    let ev = read_escrow(p, &pl, escrow)?;
    if rent_to.key.to_bytes() != ev.rent_to {
        return Err(BAD_ACCOUNT);
    }
    let me = citizen.key.to_bytes();
    let [ms, ts] = ev.sides;
    let party = me == ms.citizen || me == ts.citizen;
    let mut released = 0u8;
    let mut rel_src: Option<&AccountInfo> = None;
    if ev.state == ES::STATE_OPEN {
        // The maker any time; anyone after the deadline.
        if me != ms.citizen && bell <= ev.deadline {
            return Err(cq(CqError::EscrowState));
        }
        let src = srcs.first().ok_or(FrontierError::TooManyAccounts)?;
        if ms.kind == ES::ITEM_GOODS {
            if release_goods(p, &pl, src, &ms)? {
                released = ES::ITEM_GOODS;
            }
        } else {
            expect_item(&pl, src, &ms)?;
            let mark = frontier_abi::v2::addr::escrow_mark(ms.tag, ev.seq);
            if !init::is_absent(src) {
                let mut ld = src.try_borrow_mut_data()?;
                if Ro(&ld).u64(LT::ESCROW)? == mark {
                    Rw(&mut ld).set_u64(LT::ESCROW, 0)?;
                    released = ES::ITEM_LOT;
                }
            }
        }
        if released != 0 {
            rel_src = Some(src);
        }
    } else {
        // Settled: a party closes it once nothing owed is live.
        if !party {
            return Err(cq(CqError::EscrowState));
        }
        let mut it = srcs.iter();
        for s in [&ms, &ts] {
            if s.state == ES::SIDE_OWED {
                let v = it.next().ok_or(FrontierError::TooManyAccounts)?;
                if goods_live(p, &pl, v, s)? {
                    return Err(cq(CqError::EscrowState));
                }
            }
        }
    }
    let payload = crate::events::Buf::<29>::new()
        .u64(pl.pc.citizen_tag)
        .u8(released)
        .u64(if released == ES::ITEM_LOT { ms.lot_tag } else { 0 })
        .u32(if released == ES::ITEM_LOT { ms.lot_seq } else { 0 })
        .bytes(&if released == ES::ITEM_GOODS { ms.src_log() } else { [0; 8] });
    let key = key12(ms.tag, ev.seq);
    {
        let mut ed = escrow.try_borrow_mut_data()?;
        match rel_src {
            Some(src) => {
                let mut sd = src.try_borrow_mut_data()?;
                let entity = if released == ES::ITEM_GOODS { E2::Vault } else { E2::Lot };
                cqlog::emit(
                    CqKind::ESCROW_CANCELLED as u8,
                    bell,
                    &key,
                    payload.get()?,
                    &mut [
                        Chained2 {
                            entity,
                            data: &mut sd,
                        },
                        Chained2 {
                            entity: E2::Escrow,
                            data: &mut ed,
                        },
                    ],
                )?;
            }
            None => cqlog::emit(
                CqKind::ESCROW_CANCELLED as u8,
                bell,
                &key,
                payload.get()?,
                &mut [Chained2 {
                    entity: E2::Escrow,
                    data: &mut ed,
                }],
            )?,
        }
    }
    close_account(
        p,
        escrow,
        rent_to,
        E2::Escrow,
        &frontier_abi::v2::log::close_key_escrow(ms.tag, ev.seq),
        bell,
    )
}

/// 0xCC WithdrawEscrow (2e): P + `[escrow w] [src w] [dst r] [caravan w]
/// [system] [rent_to w] [path_province w ×1..4]` (`S2-2E-CONTRACT.md`
/// §3.4): the receiver sends owed goods out of the giver's vault.
pub fn withdraw_escrow(p: &Pubkey, a: &[AccountInfo], d: &[u8]) -> R<()> {
    let n_prov = a
        .len()
        .checked_sub(10)
        .ok_or(FrontierError::TooManyAccounts)?;
    check_accounts_v2(Ix2::WithdrawEscrow, a, Some(&[1, 1, n_prov as u8]))?;
    let x = ix2::WithdrawEscrow::decode(d)?;
    let pl: Player = hold::player(p, a)?;
    let [_, payer, season_ai, citizen, escrow, src, dst, caravan, _system, rent_to, provinces @ ..] = a
    else {
        return Err(FrontierError::TooManyAccounts.into());
    };
    let bell = pl.pc.now_bell;
    let ev = read_escrow(p, &pl, escrow)?;
    let i = x.side as usize;
    if i > 1 {
        return Err(FrontierError::BadData.into());
    }
    let mut sides = ev.sides;
    let (s, other) = (sides[i], sides[1 - i]);
    if ev.state != ES::STATE_SETTLED
        || s.kind != ES::ITEM_GOODS
        || s.state != ES::SIDE_OWED
        || other.citizen != citizen.key.to_bytes()
    {
        return Err(cq(CqError::EscrowState));
    }
    if rent_to.key.to_bytes() != ev.rent_to {
        return Err(BAD_ACCOUNT);
    }
    // The day boundary first, on the stock the hold still covers (2c).
    if goods_live(p, &pl, src, &s)? {
        roll_vault(&mut src.try_borrow_mut_data()?, bell)?;
    }
    if !release_goods(p, &pl, src, &s)? {
        return Err(cq(CqError::TicketVoid));
    }
    let mut cargo = [0i64; RESOURCES];
    cargo[s.resource as usize] = s.amount as i64;
    send(
        p,
        &pl,
        &SendAccounts {
            payer,
            season_ai,
            citizen,
            src,
            dst,
            caravan,
            provinces,
        },
        &SendOrder {
            seq: x.seq,
            dst: (x.dst_kind, x.dst_p, x.dst_q, x.dst_at, x.dst_gen),
            steps: x.steps,
            path: x.path,
            fee: x.fee,
        },
        &cargo,
        SendBy::Escrow,
    )?;
    sides[i].state = ES::SIDE_DONE;
    let closed = sides.iter().all(|s| s.state != ES::SIDE_OWED);
    {
        let mut ed = escrow.try_borrow_mut_data()?;
        sides[i].write(&mut ed, i)?;
    }
    let payload = crate::events::Buf::<22>::new()
        .u64(pl.pc.citizen_tag)
        .u8(x.side)
        .u64(s.amount)
        .u32(x.seq)
        .u8(closed as u8);
    let key = key12(sides[0].tag, ev.seq);
    {
        let mut ed = escrow.try_borrow_mut_data()?;
        cqlog::emit(
            CqKind::ESCROW_WITHDRAWN as u8,
            bell,
            &key,
            payload.get()?,
            &mut [Chained2 {
                entity: E2::Escrow,
                data: &mut ed,
            }],
        )?;
    }
    if closed {
        close_account(
            p,
            escrow,
            rent_to,
            E2::Escrow,
            &frontier_abi::v2::log::close_key_escrow(sides[0].tag, ev.seq),
            bell,
        )?;
    }
    Ok(())
}
