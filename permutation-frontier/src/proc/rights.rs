//! **Proposal (workstream 02-rights, not adopted):** the WorkshopUse
//! Grant (`frontier_abi::v2::rights`, contract
//! `workstreams/02-rights/03-CONTRACT.ja.md`). Routed by [`crate::dispatch`]
//! before the v2 tag table, so no allocated tag, code or account kind
//! changes.
//!
//! - **Who signs.** IssueGrant: the issuer's wallet only (a session is
//!   refused `WalletRequired`, as a send to another player). ReserveUse
//!   and ConsumeUse: the grantee (wallet or its own live session, through
//!   the player prologue, its action bucket included). RevokeGrant: the
//!   issuer (wallet or session; revoking only takes power away).
//!   ReleaseUse: the grantee, or any signer once the Grant is expired or a
//!   pinned holding is stale. CloseGrant: any signer once nothing is
//!   escrowed and the Grant can no longer be used (the rent goes to
//!   `RENT_TO` whoever signs).
//! - **What is pinned.** The Grant's address is a with-seed address of the
//!   Season PDA (`gr‖issuer_tag,nonce`), recomputed on every use; the
//!   facility and the station by key, generation and owner; both in one
//!   Province, whose capture lock is checked for both.
//! - **Not owner activity.** Grant instructions settle the holdings they
//!   write without `touch_owner` (as a caravan's delivery does): a grantee
//!   cannot keep an absent owner's holding awake.
//! - **Capture.** A holding that changed generation makes the Grant
//!   unusable (`StaleHolding`), as redesign 20 §5 (adopted) voids a
//!   captured store's cards. An open reservation is then released into the
//!   holdings as they stand — the captor's included, since that section
//!   gives a captured store's contents to the captor — and is lost only
//!   where no live holding remains (contract §6; the alternative, burning,
//!   is listed there as a proposal).
//! - **No log record yet.** The PS2 log has no kind for these (the
//!   verifier and herald would need one; contract §8). The handlers write
//!   holdings without a chained record, which the current verifier would
//!   flag: adopting this needs the record kinds first.

use solana_program::{account_info::AccountInfo, pubkey::Pubkey};

use frontier_abi::addr::AddrCtx;
use frontier_abi::v2::layout::AccountKind as K2;
use frontier_abi::v2::rights::{self as rt, layout as G, RightsError};
use frontier_abi::v2::CqError;
use permutation_rules::fixed::MILLI;
use permutation_rules::frontier::arms;
use permutation_rules::frontier::holding::{Holding as KHolding, Resource, RESOURCES};

use super::conquest::cq;
use super::holding::{self as hold, Player};
use crate::addr;
use crate::error::{BAD_ACCOUNT, OVERFLOW};
use crate::init::{self, SeasonSigner, Sink};
use crate::layout::{citizen as C, holding as H, Ro, Rw};
use crate::prologue::{self, expect_key, key, present_v2, view};
use crate::{FrontierError, R};

/// Routes one rights instruction (tags 0xD0–0xD5).
pub fn dispatch(p: &Pubkey, a: &[AccountInfo], d: &[u8]) -> R<()> {
    match d.first().copied() {
        Some(rt::tag::ISSUE_GRANT) => issue_grant(p, a, d),
        Some(rt::tag::RESERVE_USE) => reserve_use(p, a, d),
        Some(rt::tag::CONSUME_USE) => consume_use(p, a, d),
        Some(rt::tag::RELEASE_USE) => release_use(p, a, d),
        Some(rt::tag::REVOKE_GRANT) => revoke_grant(p, a, d),
        Some(rt::tag::CLOSE_GRANT) => close_grant(p, a, d),
        _ => Err(FrontierError::BadData.into()),
    }
}

fn err(e: RightsError) -> crate::Error {
    e.into()
}

/// The account flags a handler needs beyond the player prologue's.
fn writable(ai: &AccountInfo) -> R<()> {
    if ai.is_writable {
        Ok(())
    } else {
        Err(BAD_ACCOUNT)
    }
}

// ------------------------------------------------------------ the Grant

/// A Grant as read and checked.
#[derive(Clone, Copy, Debug)]
struct Grant {
    state: u8,
    p: i16,
    q: i16,
    issuer: [u8; 32],
    grantee: [u8; 32],
    facility: [u8; 32],
    facility_gen: u8,
    station: [u8; 32],
    station_gen: u8,
    expires_ts: i64,
    max_uses: u16,
    uses: u16,
    max_units: u32,
    units_consumed: u32,
    open_units: u32,
    open: [i64; 3],
    rent_to: [u8; 32],
}

/// The Grant at `ai`: owned by this program, exact size and magic, of
/// season `sid`, at the address its own `issuer_tag` and `nonce`
/// recompute in `ctx` (`BadGrant` for any of these).
fn load_grant(p: &Pubkey, ctx: &AddrCtx, sid: u64, ai: &AccountInfo) -> R<Grant> {
    let d = ai.try_borrow_data()?;
    let bad = || err(RightsError::BadGrant);
    if ai.owner != p || d.len() != G::SIZE || d.get(..8) != Some(&G::MAGIC[..]) {
        return Err(bad());
    }
    let r = Ro(&d);
    if r.u64(G::SEASON_ID)? != sid
        || r.u16(G::VERSION)? != G::VERSION_1
        || r.u8(G::KIND)? != rt::KIND_WORKSHOP_USE
    {
        return Err(bad());
    }
    let canonical = rt::grant(ctx, r.u64(G::ISSUER_TAG)?, r.u32(G::NONCE)?);
    if canonical != key(ai) {
        return Err(bad());
    }
    Ok(Grant {
        state: r.u8(G::STATE)?,
        p: r.i16(G::P)?,
        q: r.i16(G::Q)?,
        issuer: r.arr(G::ISSUER_CITIZEN)?,
        grantee: r.arr(G::GRANTEE_CITIZEN)?,
        facility: r.arr(G::FACILITY)?,
        facility_gen: r.u8(G::FACILITY_GEN)?,
        station: r.arr(G::STATION)?,
        station_gen: r.u8(G::STATION_GEN)?,
        expires_ts: r.i64(G::EXPIRES_TS)?,
        max_uses: r.u16(G::MAX_USES)?,
        uses: r.u16(G::USES)?,
        max_units: r.u32(G::MAX_UNITS)?,
        units_consumed: r.u32(G::UNITS_CONSUMED)?,
        open_units: r.u32(G::OPEN_UNITS)?,
        open: [
            r.i64(G::OPEN_ORE)?,
            r.i64(G::OPEN_WOOD)?,
            r.i64(G::OPEN_ARMS)?,
        ],
        rent_to: r.arr(G::RENT_TO)?,
    })
}

/// Writes the open reservation (`units == 0`: none).
fn write_open(ai: &AccountInfo, units: u32, ts: i64, open: [i64; 3]) -> R<()> {
    let mut d = ai.try_borrow_mut_data()?;
    let mut w = Rw(&mut d);
    w.set_u32(G::OPEN_UNITS, units)?;
    w.set_i64(G::OPEN_TS, ts)?;
    w.set_i64(G::OPEN_ORE, open[0])?;
    w.set_i64(G::OPEN_WOOD, open[1])?;
    w.set_i64(G::OPEN_ARMS, open[2])?;
    Ok(())
}

/// Ore, wood and arms (milli) of `units` arms' worth of work.
fn escrow_of(units: u32) -> R<[i64; 3]> {
    let u = units as i64;
    let m = |per: i64| u.checked_mul(per)?.checked_mul(MILLI);
    Ok([
        m(arms::ORE_PER_ARM).ok_or(OVERFLOW)?,
        m(arms::WOOD_PER_ARM).ok_or(OVERFLOW)?,
        m(1).ok_or(OVERFLOW)?,
    ])
}

fn cost(ore: i64, wood: i64, arms_: i64) -> [i64; RESOURCES] {
    let mut c = [0i64; RESOURCES];
    c[Resource::Ore as usize] = ore;
    c[Resource::Wood as usize] = wood;
    c[arms::ARMS as usize] = arms_;
    c
}

// ------------------------------------------------------------ holdings

/// A pinned holding: the key the Grant names (`BadGrant`), then present,
/// live, of generation `gen` and owned by `owner` (`StaleHolding`).
fn pinned(
    p: &Pubkey,
    sid: u64,
    ai: &AccountInfo,
    want: &[u8; 32],
    gen: u8,
    owner: &[u8; 32],
) -> R<frontier_abi::prologue::HoldingHdr> {
    if key(ai) != *want {
        return Err(err(RightsError::BadGrant));
    }
    let stale = || err(RightsError::StaleHolding);
    if present_v2(ai, p, K2::Holding, sid).is_err() {
        return Err(stale());
    }
    let d = ai.try_borrow_data()?;
    let r = Ro(&d);
    let h = frontier_abi::prologue::HoldingHdr {
        p: r.i16(H::P)?,
        q: r.i16(H::Q)?,
        site: r.u8(H::SITE)?,
        gen: r.u8(H::GEN)?,
        state: r.u8(H::STATE)?,
        ticket_bell: r.u32(H::TICKET_BELL)?,
        final_ts: r.i64(H::FINAL_TS)?,
    };
    if h.gen != gen || r.arr::<32>(H::OWNER_CITIZEN)? != *owner || hold::live(&h).is_err() {
        return Err(stale());
    }
    Ok(h)
}

/// The Grant's Province at its canonical address, and the capture lock of
/// each holding written.
fn province_unlocked(
    p: &Pubkey,
    ctx: &AddrCtx,
    sid: u64,
    g: &Grant,
    province: &AccountInfo,
    holdings: &[&frontier_abi::prologue::HoldingHdr],
) -> R<()> {
    expect_key(province, &ctx.province(g.p as i32, g.q as i32))?;
    present_v2(province, p, K2::Province, sid)?;
    for h in holdings {
        hold::capture_lock(h, province)?;
    }
    Ok(())
}

/// The holding settled to `now`, not touched (a Grant's action is not the
/// owner's).
fn settled(ai: &AccountInfo, now: i64) -> R<KHolding> {
    let (mut h, ore) = {
        let d = ai.try_borrow_data()?;
        (hold::read_holding(&d)?, hold::terrain_ore(&d)?)
    };
    hold::settle_tiered(&mut h, now, ore)?;
    Ok(h)
}

fn store(ai: &AccountInfo, h: &KHolding, now: i64) -> R<()> {
    let mut d = ai.try_borrow_mut_data()?;
    hold::write_holding(&mut d, h, now)
}

fn credit(ai: &AccountInfo, now: i64, amounts: &[(Resource, i64)]) -> R<()> {
    let mut h = settled(ai, now)?;
    for (r, v) in amounts {
        if *v > 0 {
            h.credit(now, *r, *v).map_err(hold::holding_err)?;
        }
    }
    store(ai, &h, now)
}

/// The holding at a pinned key as it stands now, whoever holds it: `None`
/// when no live holding is there any more (released or closed); `BadGrant`
/// for another key.
fn place_now(
    p: &Pubkey,
    sid: u64,
    ai: &AccountInfo,
    want: &[u8; 32],
) -> R<Option<frontier_abi::prologue::HoldingHdr>> {
    if key(ai) != *want {
        return Err(err(RightsError::BadGrant));
    }
    if present_v2(ai, p, K2::Holding, sid).is_err() {
        return Ok(None);
    }
    let d = ai.try_borrow_data()?;
    let r = Ro(&d);
    let h = frontier_abi::prologue::HoldingHdr {
        p: r.i16(H::P)?,
        q: r.i16(H::Q)?,
        site: r.u8(H::SITE)?,
        gen: r.u8(H::GEN)?,
        state: r.u8(H::STATE)?,
        ticket_bell: r.u32(H::TICKET_BELL)?,
        final_ts: r.i64(H::FINAL_TS)?,
    };
    Ok(hold::live(&h).ok().map(|_| h))
}

/// Undoes the open reservation: each side goes back to the holding it
/// came from **as that holding stands now** — its owner's, or its
/// captor's after a capture (redesign 20 §5, adopted: a captured store's
/// contents are the captor's) — and is lost only when no live holding is
/// there any more. A capture not yet settled waits (`CapturePending`).
/// Clears the reservation.
#[allow(clippy::too_many_arguments)]
fn unwind(
    p: &Pubkey,
    ctx: &AddrCtx,
    sid: u64,
    now: i64,
    g: &Grant,
    grant: &AccountInfo,
    facility: &AccountInfo,
    station: &AccountInfo,
    province: &AccountInfo,
) -> R<()> {
    if g.open_units == 0 {
        return Ok(());
    }
    let st = place_now(p, sid, station, &g.station)?;
    let fa = place_now(p, sid, facility, &g.facility)?;
    let live: alloc::vec::Vec<&frontier_abi::prologue::HoldingHdr> =
        [&st, &fa].into_iter().flatten().collect();
    province_unlocked(p, ctx, sid, g, province, &live)?;
    if st.is_some() {
        credit(
            station,
            now,
            &[(Resource::Ore, g.open[0]), (Resource::Wood, g.open[1])],
        )?;
    }
    if fa.is_some() {
        credit(facility, now, &[(arms::ARMS, g.open[2])])?;
    }
    write_open(grant, 0, 0, [0; 3])
}

// ------------------------------------------------------------ 0xD0 IssueGrant

/// 0xD0 IssueGrant: P (issuer, wallet) + `[facility r] [province r]
/// [grantee_citizen r] [station r] [grant w] [system]`.
pub fn issue_grant(p: &Pubkey, a: &[AccountInfo], d: &[u8]) -> R<()> {
    let x = rt::IssueGrant::decode(d)?;
    let [_, payer, season_ai, citizen, facility, province, grantee, station, grant, system] = a
    else {
        return Err(FrontierError::TooManyAccounts.into());
    };
    writable(grant)?;
    if key(system) != addr::ids::SYSTEM_PROGRAM {
        return Err(BAD_ACCOUNT);
    }
    let pl: Player = hold::player(p, a)?;
    if pl.pc.by_session {
        return Err(cq(CqError::WalletRequired));
    }
    let sid = pl.pc.season.id;
    let now = pl.now.ts;
    // The facility: the issuer's live holding with a workshop, unlocked.
    let fh = hold::owned_holding(p, &pl, facility, citizen)?;
    hold::live(&fh)?;
    hold::own_province_unlocked(p, &pl, &fh, province)?;
    {
        let fd = facility.try_borrow_data()?;
        let h = hold::read_holding(&fd)?;
        if arms::workshops_built(&h.production) < 1 {
            return Err(err(RightsError::NoWorkshop));
        }
    }
    // The grantee: another present Citizen at its canonical address.
    present_v2(grantee, p, K2::Citizen, sid)?;
    {
        let gd = grantee.try_borrow_data()?;
        let wallet: [u8; 32] = Ro(&gd).arr(C::WALLET)?;
        expect_key(
            grantee,
            &pl.ctx.citizen_by_tag15(&addr::citizen_tag15(&wallet)),
        )?;
    }
    if grantee.key == citizen.key {
        return Err(err(RightsError::BadTerms));
    }
    // The station: the grantee's live holding in the same Province.
    let sh = {
        let sv = station.try_borrow_data()?;
        let v = view(station, &sv);
        frontier_abi::prologue::check_holding(&v, &pl.ctx, sid, &key(grantee))
            .map_err(|_| err(RightsError::BadStation))?
    };
    if hold::live(&sh).is_err() || (sh.p, sh.q) != (fh.p, fh.q) || station.key == facility.key {
        return Err(err(RightsError::BadStation));
    }
    hold::capture_lock(&sh, province)?;
    if !rt::terms_ok(x.kind, x.max_uses, x.max_units, x.expires_ts, now) {
        return Err(err(RightsError::BadTerms));
    }
    // The Grant.
    let tag = pl.pc.citizen_tag;
    expect_key(grant, &rt::grant(&pl.ctx, tag, x.nonce))?;
    if !init::is_absent(grant) {
        return Err(err(RightsError::BadGrant));
    }
    let signer = SeasonSigner::new(sid, pl.pc.season.bump);
    let seed = rt::grant_seed(tag, x.nonce);
    let rent = init::rent(G::SIZE)?;
    init::init_with_seed(payer, grant, season_ai, &signer, &seed, G::SIZE, rent, p)?;
    let mut gd = grant.try_borrow_mut_data()?;
    let mut w = Rw(&mut gd);
    w.set_arr(0, &G::MAGIC)?;
    w.set_u64(G::SEASON_ID, sid)?;
    w.set_u16(G::VERSION, G::VERSION_1)?;
    w.set_u8(G::KIND, x.kind)?;
    w.set_u8(G::STATE, rt::STATE_ACTIVE)?;
    w.set_u8(G::FACILITY_GEN, fh.gen)?;
    w.set_u8(G::STATION_GEN, sh.gen)?;
    w.set_u8(G::FACILITY_SITE, fh.site)?;
    w.set_u8(G::STATION_SITE, sh.site)?;
    w.set_i16(G::P, fh.p)?;
    w.set_i16(G::Q, fh.q)?;
    w.set_u32(G::NONCE, x.nonce)?;
    w.set_arr(G::ISSUER_CITIZEN, citizen.key.as_ref())?;
    w.set_arr(G::GRANTEE_CITIZEN, grantee.key.as_ref())?;
    w.set_arr(G::FACILITY, facility.key.as_ref())?;
    w.set_arr(G::STATION, station.key.as_ref())?;
    w.set_u64(G::ISSUER_TAG, tag)?;
    w.set_i64(G::EXPIRES_TS, x.expires_ts)?;
    w.set_i64(G::ISSUED_TS, now)?;
    w.set_u16(G::MAX_USES, x.max_uses)?;
    w.set_u32(G::MAX_UNITS, x.max_units)?;
    w.set_arr(G::RENT_TO, payer.key.as_ref())?;
    Ok(())
}

// ------------------------------------------------------------ use

/// The checks ReserveUse and ConsumeUse share: P (grantee) + `[grant w]
/// [facility w] [station w] [province r]`; the Grant active and unexpired,
/// both holdings pinned and unlocked.
struct Use<'x, 'a> {
    now: i64,
    g: Grant,
    grant: &'x AccountInfo<'a>,
    facility: &'x AccountInfo<'a>,
    station: &'x AccountInfo<'a>,
}

fn use_prologue<'x, 'a>(p: &Pubkey, a: &'x [AccountInfo<'a>]) -> R<Use<'x, 'a>> {
    let [_, _payer, _season, citizen, grant, facility, station, province] = a else {
        return Err(FrontierError::TooManyAccounts.into());
    };
    for ai in [grant, facility, station] {
        writable(ai)?;
    }
    let pl: Player = hold::player(p, a)?;
    let sid = pl.pc.season.id;
    let g = load_grant(p, &pl.ctx, sid, grant)?;
    if g.grantee != key(citizen) {
        return Err(err(RightsError::NotGrantee));
    }
    if g.state != rt::STATE_ACTIVE {
        return Err(err(RightsError::Revoked));
    }
    if pl.now.ts >= g.expires_ts {
        return Err(err(RightsError::Expired));
    }
    let fh = pinned(p, sid, facility, &g.facility, g.facility_gen, &g.issuer)?;
    let sh = pinned(p, sid, station, &g.station, g.station_gen, &g.grantee)?;
    province_unlocked(p, &pl.ctx, sid, &g, province, &[&fh, &sh])?;
    Ok(Use {
        now: pl.now.ts,
        g,
        grant,
        facility,
        station,
    })
}

/// 0xD1 ReserveUse(units): the station's ore and wood and the facility's
/// arms for `units` go into the Grant; all or nothing (`Insufficient`).
pub fn reserve_use(p: &Pubkey, a: &[AccountInfo], d: &[u8]) -> R<()> {
    let x = rt::ReserveUse::decode(d)?;
    let u = use_prologue(p, a)?;
    let g = &u.g;
    if g.open_units != 0 {
        return Err(err(RightsError::ReservationOpen));
    }
    rt::quota_allows(g.max_uses, g.uses, g.max_units, g.units_consumed, x.units).map_err(err)?;
    let e = escrow_of(x.units)?;
    let mut sh = settled(u.station, u.now)?;
    sh.pay(u.now, &cost(e[0], e[1], 0))
        .map_err(hold::holding_err)?;
    let mut fh = settled(u.facility, u.now)?;
    fh.pay(u.now, &cost(0, 0, e[2]))
        .map_err(hold::holding_err)?;
    store(u.station, &sh, u.now)?;
    store(u.facility, &fh, u.now)?;
    write_open(u.grant, x.units, u.now, e)
}

/// 0xD2 ConsumeUse: the escrowed arms to the station, the escrowed ore and
/// wood to the facility; one use and its units counted. Final.
pub fn consume_use(p: &Pubkey, a: &[AccountInfo], d: &[u8]) -> R<()> {
    let _ = rt::ConsumeUse::decode(d)?;
    let u = use_prologue(p, a)?;
    let g = &u.g;
    if g.open_units == 0 {
        return Err(err(RightsError::NoReservation));
    }
    credit(u.station, u.now, &[(arms::ARMS, g.open[2])])?;
    credit(
        u.facility,
        u.now,
        &[(Resource::Ore, g.open[0]), (Resource::Wood, g.open[1])],
    )?;
    let uses = g.uses.checked_add(1).ok_or(OVERFLOW)?;
    let units = g.units_consumed.checked_add(g.open_units).ok_or(OVERFLOW)?;
    {
        let mut gd = u.grant.try_borrow_mut_data()?;
        let mut w = Rw(&mut gd);
        w.set_u16(G::USES, uses)?;
        w.set_u32(G::UNITS_CONSUMED, units)?;
    }
    write_open(u.grant, 0, 0, [0; 3])
}

// ------------------------------------------------------------ 0xD3 ReleaseUse

/// The Season at its PDA in any status (Release and Close run after the
/// season's end too).
fn season_any(p: &Pubkey, season_ai: &AccountInfo, now: i64) -> R<(u64, AddrCtx)> {
    let sd = season_ai.try_borrow_data()?;
    let s = frontier_abi::prologue::read_season(&view(season_ai, &sd), p.as_array(), now)?;
    if addr::season_pda(s.id, s.bump, p.as_array()) != key(season_ai) {
        return Err(FrontierError::BadAddress.into());
    }
    Ok((s.id, addr::ctx(&key(season_ai), &p.to_bytes())))
}

/// 0xD3 ReleaseUse: `[actor s] [season r] [grantee_citizen r] [grant w]
/// [facility w] [station w] [province r]`.
pub fn release_use(p: &Pubkey, a: &[AccountInfo], d: &[u8]) -> R<()> {
    let _ = rt::ReleaseUse::decode(d)?;
    let [actor, season_ai, grantee, grant, facility, station, province] = a else {
        return Err(FrontierError::TooManyAccounts.into());
    };
    if !actor.is_signer {
        return Err(FrontierError::Auth.into());
    }
    for ai in [grant, facility, station] {
        writable(ai)?;
    }
    let now = prologue::now()?.ts;
    let (sid, ctx) = season_any(p, season_ai, now)?;
    let g = load_grant(p, &ctx, sid, grant)?;
    if g.open_units == 0 {
        return Err(err(RightsError::NoReservation));
    }
    if key(grantee) != g.grantee {
        return Err(err(RightsError::BadGrant));
    }
    present_v2(grantee, p, K2::Citizen, sid)?;
    let by_grantee = {
        let cd = grantee.try_borrow_data()?;
        let r = Ro(&cd);
        let k = key(actor);
        k == r.arr::<32>(C::WALLET)?
            || (k == r.arr::<32>(C::SESSION)?
                && k != [0u8; 32]
                && now < r.i64(C::SESSION_EXPIRY)?)
    };
    if !by_grantee {
        let stale = |ai: &AccountInfo, want: &[u8; 32], gen: u8, owner: &[u8; 32]| {
            matches!(
                pinned(p, sid, ai, want, gen, owner),
                Err(e) if e == err(RightsError::StaleHolding)
            )
        };
        let crank = now >= g.expires_ts
            || stale(station, &g.station, g.station_gen, &g.grantee)
            || stale(facility, &g.facility, g.facility_gen, &g.issuer);
        if !crank {
            return Err(err(RightsError::NotGrantee));
        }
    }
    unwind(p, &ctx, sid, now, &g, grant, facility, station, province)
}

// ------------------------------------------------------------ 0xD4 RevokeGrant

/// 0xD4 RevokeGrant: P (issuer) + `[grant w] [facility w] [station w]
/// [province r]`. An open reservation is undone first; the unused quota is
/// void; what was consumed stays.
pub fn revoke_grant(p: &Pubkey, a: &[AccountInfo], d: &[u8]) -> R<()> {
    let _ = rt::RevokeGrant::decode(d)?;
    let [_, _payer, _season, citizen, grant, facility, station, province] = a else {
        return Err(FrontierError::TooManyAccounts.into());
    };
    for ai in [grant, facility, station] {
        writable(ai)?;
    }
    let pl: Player = hold::player(p, a)?;
    let sid = pl.pc.season.id;
    let g = load_grant(p, &pl.ctx, sid, grant)?;
    if g.issuer != key(citizen) {
        return Err(err(RightsError::NotGrantee));
    }
    if g.state != rt::STATE_ACTIVE {
        return Err(err(RightsError::Revoked));
    }
    unwind(
        p, &pl.ctx, sid, pl.now.ts, &g, grant, facility, station, province,
    )?;
    let mut gd = grant.try_borrow_mut_data()?;
    let mut w = Rw(&mut gd);
    w.set_u8(G::STATE, rt::STATE_REVOKED)?;
    w.set_i64(G::REVOKED_TS, pl.now.ts)?;
    Ok(())
}

// ------------------------------------------------------------ 0xD5 CloseGrant

/// 0xD5 CloseGrant: `[actor s] [season r] [grant w] [rent_to w]`, once no
/// reservation is open and the Grant can no longer be used (revoked,
/// expired or its quota spent; `StillLive`).
pub fn close_grant(p: &Pubkey, a: &[AccountInfo], d: &[u8]) -> R<()> {
    let _ = rt::CloseGrant::decode(d)?;
    let [actor, season_ai, grant, rent_to] = a else {
        return Err(FrontierError::TooManyAccounts.into());
    };
    if !actor.is_signer {
        return Err(FrontierError::Auth.into());
    }
    writable(grant)?;
    writable(rent_to)?;
    let now = prologue::now()?.ts;
    let (sid, ctx) = season_any(p, season_ai, now)?;
    let g = load_grant(p, &ctx, sid, grant)?;
    if key(rent_to) != g.rent_to {
        return Err(err(RightsError::BadGrant));
    }
    let spent = g.uses >= g.max_uses || g.units_consumed >= g.max_units;
    let done = g.state == rt::STATE_REVOKED || now >= g.expires_ts || spent;
    if g.open_units != 0 || !done {
        return Err(err(RightsError::StillLive));
    }
    init::close_to(p, grant, rent_to, &Sink::Never, 0)?;
    Ok(())
}

#[cfg(test)]
#[path = "rights_tests.rs"]
mod tests;
