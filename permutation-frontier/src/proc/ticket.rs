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
    self as kt, KIND_RECEIPT, KIND_SHARE, KIND_USE, MAX_OPEN_ISSUES, SRC_HOLDING, SRC_VAULT, STATE_CLOSED,
    STATE_LIVE,
};
use permutation_rules::frontier::travel::BELLS_PER_DAY;

use super::caravan::{place_of, send, vault_shares, Place, SendAccounts, SendOrder};
use super::conquest::{check_accounts_v2, cq, cqlog, present_v2, Chained2};
use super::holding::{self as hold, Player};
use crate::error::{BAD_ACCOUNT, OVERFLOW};
use crate::addr::AddrCtx;
use crate::init::{self, SeasonSigner, Sink};
use permutation_rules::frontier::holding::RESOURCES;
use crate::layout::{citizen2 as C, holding2 as H, Ro, Rw};
use crate::prologue::expect_key;
use crate::{FrontierError, R};

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
    };
    expect_key(ai, &frontier_abi::v2::addr::issue(ctx, v.issuer_tag, v.seq))?;
    Ok(v)
}

/// The issue's source account at its canonical address; its generation
/// now, or `None` when it is gone or no longer live (its tickets are void).
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
    Ok(place_of(p, &pl.ctx, pl.pc.season.id, source)?.map(|s| s.gen))
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
        // A new lot, seeded by the giver's counter.
        let seq = Ro(&citizen.try_borrow_data()?).u32(C::LOTS)?;
        init_lot(
            p, &pl, payer, season_ai, to_lot, &iv, &rkey, rtag, giver_tag, seq, x.amount,
        )?;
        {
            let mut cd = citizen.try_borrow_mut_data()?;
            Rw(&mut cd).set_u32(C::LOTS, seq.checked_add(1).ok_or(OVERFLOW)?)?;
        }
        Rw(&mut lot.try_borrow_mut_data()?).set_u64(LT::AMOUNT, from.amount - x.amount)?;
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
        let sum = to.amount.checked_add(x.amount).ok_or(OVERFLOW)?;
        Rw(&mut to_lot.try_borrow_mut_data()?).set_u64(LT::AMOUNT, sum)?;
        Rw(&mut lot.try_borrow_mut_data()?).set_u64(LT::AMOUNT, from.amount - x.amount)?;
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
        let mut stores = [0i64; RESOURCES];
        for (r, v) in stores.iter_mut().enumerate() {
            *v = Ro(&vd).i64(VA::store(r))?;
        }
        kt::value_of(&stores).min(u64::MAX as u128) as u64
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
        true,
    )?;
    let supply = iv.supply - x.amount;
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
        .u64(dv.min(u64::MAX as u128) as u64)
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
