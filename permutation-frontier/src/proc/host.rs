//! Hosts and departures (M1 contract §5.10, §5.11): Muster (0x43),
//! Dissolve (0x44), Garrison (0x45), DisbandStranded (0x48), Depart (0x50),
//! SettleDeparture (0x52). Implemented by W3-B.
//!
//! Entries are read and written through `frontier_abi::entry` (the one
//! codec of the 48-B entry); hosts obey the kernel `host::Host` rules:
//! every change issued during bell b is pending until b's clash (roster
//! freeze), one change per host.
//!
//! ## Pinned here (recorded in `W3-B-NOTES.md`)
//!
//! - **Units:** `Holding.reserve` counts whole troops, entries and the site
//!   mirror hold `MilliTroops` (§5.3 note); Muster and Garrison data are
//!   whole troops.
//! - **Muster** needs a passable tile of the holding's province
//!   (`BadData`); the caps (48 over states 1–2, 8 per faction) and a free
//!   entry are `ProvinceFull`; kernel bounds (100–30,000) are `Kernel`
//!   with a sub-code. `dealt_bps` = the faction doctrine at Hold, not
//!   arriving; `n_entries` counts non-free entries.
//! - **Garrison** moves whole troops of the Spearman reserve (the unit the
//!   simulator's garrison purchase prices) into the site mirror's pending
//!   change. **Only positive deltas in M1** (`BadData` otherwise): the
//!   program has no settle step that returns a withdrawal's post-clash
//!   troops to the Holding's reserve, and crediting them at issue would
//!   let a withdrawal issued during bell b keep troops that die in b's
//!   clash (W3-B notes, open item for the contract).
//! - **Depart** charges `march_stamina(32)` (I-32); the transit's
//!   `dealt_bps` is the faction doctrine at Hold arriving (the sealed
//!   stance is applied by Reveal's slot).
//! - **SettleDeparture** of a transit already settled is `AlreadyDone`
//!   (keeper idempotency); `ready_bell_off = ready_bell − depart_bell`.
//! - **DisbandStranded** of a host whose Holding is live with the same
//!   generation is `NotDormant` (46, "not stranded"). v1.5: a host in a
//!   roster (state 1 or 2) is disbanded as a pending `Forfeit` of
//!   `now_bell`, freed by that bell's resolve (roster freeze).

use solana_program::{account_info::AccountInfo, pubkey::Pubkey};

use frontier_abi::addr::split_host_id;
use frontier_abi::entry::{find_entry, read_entry, write_entry, Entry, EntryOp};
use frontier_abi::ix as aix;
use frontier_abi::layout::AccountKind;
use frontier_abi::log::{EntityKind, Kind, NO_BELL};
use frontier_abi::prologue::{self as ap, HoldingHdr};
use frontier_abi::tags::Ix;
use permutation_rules::fixed::{MilliTroops, MILLI};
use permutation_rules::frontier::catalog;
use permutation_rules::frontier::doctrine::{of_faction, Doctrine};
use permutation_rules::frontier::fees;
use permutation_rules::frontier::host::{GarrisonState, Host, HostError, DESTROYED_BELOW};
use permutation_rules::frontier::stance::{Posture, Stance};
use permutation_rules::frontier::travel::{march_stamina, MAX_PATH_STEPS};

use super::holding::{
    bps16, finality, live, load_touched, own_province, owned_holding, player, site_of, sub,
    write_holding, Player,
};
use crate::addr;
use crate::error::{kernel, BAD_ACCOUNT, OVERFLOW};
use crate::events::{self, Buf, Chained};
use crate::init;
use crate::layout::holding2 as H2;
use crate::layout::{
    citizen as C, entry as E, holding as H, province as P, season as S, site as SM, transit as T,
    Ro, Rw,
};
use crate::prologue::{self, check_accounts, expect_key, key};
use crate::{FrontierError, R, RULESET_HASH};

use super::conquest::{capture_lock, capture_lock_of, retire_hosts_of};

/// The capture lock (§5.8) of a resident action that names the Holding's
/// own Province.
fn lock_own(province: &AccountInfo, hh: &HoldingHdr) -> R<()> {
    let pd = province.try_borrow_data()?;
    capture_lock(&pd, hh.site, hh.gen)
}

/// A kernel host refusal as a program code. `Unresolved` is the caller's
/// (`NotResident` for resident actions, `TooEarly` for settlements).
pub(crate) fn host_err(e: HostError, unresolved: FrontierError) -> crate::Error {
    match e {
        HostError::NoStamina | HostError::Cooldown => FrontierError::Cooldown.into(),
        HostError::Busy | HostError::Unsettled => FrontierError::HostBusy.into(),
        HostError::Unresolved => unresolved.into(),
        HostError::TooSmall => kernel(sub::HOST_TOO_SMALL),
        HostError::TooLarge => kernel(sub::HOST_TOO_LARGE),
        HostError::NotAHostUnit => kernel(sub::HOST_NOT_A_HOST_UNIT),
        HostError::Mismatch => kernel(sub::HOST_MISMATCH),
        HostError::TimeReversed => kernel(sub::HOST_TIME_REVERSED),
    }
}

/// The doctrine of `faction` (a stored faction outside 0..6 is `BadAccount`).
fn doctrine(faction: u8) -> R<&'static Doctrine> {
    of_faction(faction).ok_or(BAD_ACCOUNT)
}

/// A resident host of the caller, found in the Province it stands in.
pub(crate) struct ResidentHost {
    pub entry: Entry,
    pub index: usize,
    /// The province the host stands in.
    pub p: i16,
    pub q: i16,
}

/// The Province an account claims to be, at its canonical address
/// (`BadAddress`) and present (`BadAccount`): `(P, Q, resolved_next)`.
pub(crate) fn province_at(
    program: &Pubkey,
    pl: &Player,
    province: &AccountInfo,
) -> R<(i16, i16, u32)> {
    prologue::present(province, program, AccountKind::Province, pl.pc.season.id)?;
    let (pp, pq, rn) = {
        let pd = province.try_borrow_data()?;
        let r = Ro(&pd);
        (r.i16(P::P)?, r.i16(P::Q)?, r.u32(P::RESOLVED_NEXT)?)
    };
    expect_key(province, &pl.ctx.province(pp as i32, pq as i32))?;
    Ok((pp, pq, rn))
}

/// The resident checks of Dissolve and Explore in the order of §5.6 and
/// §5.10: the host id names this holding and generation (`NotOwner`); the
/// host is in no transit record in state 1–3 (`HostInTransit`, step 6);
/// the province it stands in (canonical, present; the lazy finality flip
/// when it is the holding's own); the holding final (`NotFinal`); the
/// province resolved through b − 2 and the host in its roster, state 1
/// (`NotResident`).
pub(crate) fn resident_host(
    program: &Pubkey,
    pl: &Player,
    hh: &HoldingHdr,
    holding: &AccountInfo,
    citizen: &AccountInfo,
    province: &AccountInfo,
    host_id: u64,
) -> R<ResidentHost> {
    caller_host(hh, host_id)?;
    {
        let hd = holding.try_borrow_data()?;
        if ap::host_in_transit(&hd, host_id) {
            return Err(FrontierError::HostInTransit.into());
        }
    }
    let (pp, pq, rn) = province_at(program, pl, province)?;
    let state = if (pp, pq) == (hh.p, hh.q) {
        finality(pl, hh, holding, citizen, province)?
    } else {
        hh.state
    };
    if state != H::STATE_FINAL {
        return Err(FrontierError::NotFinal.into());
    }
    if !ap::resident_ok(rn, pl.pc.now_bell) {
        return Err(FrontierError::NotResident.into());
    }
    let pd = province.try_borrow_data()?;
    let index = find_entry(&pd, host_id).ok_or(FrontierError::NotResident)?;
    let entry = read_entry(&pd, index).map_err(|_| BAD_ACCOUNT)?;
    if entry.state != E::STATE_ROSTER {
        return Err(FrontierError::NotResident.into());
    }
    Ok(ResidentHost {
        entry,
        index,
        p: pp,
        q: pq,
    })
}

/// The host id names the holding `hh` and its current generation
/// (`NotOwner`).
fn caller_host(hh: &HoldingHdr, host_id: u64) -> R<()> {
    let parts = split_host_id(host_id).ok_or(FrontierError::NotOwner)?;
    if parts.province.p != hh.p as i32
        || parts.province.q != hh.q as i32
        || parts.site != hh.site
        || parts.gen != hh.gen
    {
        return Err(FrontierError::NotOwner.into());
    }
    Ok(())
}

/// Writes entry `i` of a Province.
fn put_entry(province: &AccountInfo, i: usize, e: &Entry) -> R<()> {
    let mut pd = province.try_borrow_mut_data()?;
    write_entry(&mut pd, i, e).map_err(|_| BAD_ACCOUNT)
}

/// `roster_epoch += 1`.
fn bump_epoch(w: &mut Rw) -> R<()> {
    let e = w.u32(P::ROSTER_EPOCH)?.wrapping_add(1);
    w.set_u32(P::ROSTER_EPOCH, e)
}

// ------------------------------------------------------------ Muster

/// 0x43 Muster(unit, troops, tile): P + `[holding w] [province w]` (the
/// holding's). Troops come from `reserve[unit]` (whole troops) and form a
/// muster-pending entry (state 2) joining the roster at `now_bell + 1`.
pub fn muster(p: &Pubkey, a: &[AccountInfo], d: &[u8]) -> R<()> {
    check_accounts(Ix::Muster, a, None)?;
    let x = aix::Muster::decode(d)?;
    let pl = player(p, a)?;
    let [_, _, _, citizen, holding, province] = a else {
        return Err(FrontierError::TooManyAccounts.into());
    };
    let hh = owned_holding(p, &pl, holding, citizen)?;
    live(&hh)?;
    own_province(p, &pl, &hh, province)?;
    lock_own(province, &hh)?;
    let state = finality(&pl, &hh, holding, citizen, province)?;
    let now = pl.now.ts;
    let h = load_touched(holding, now)?;
    if state != H::STATE_FINAL {
        return Err(FrontierError::NotFinal.into());
    }
    let b = pl.pc.now_bell;
    let (rn, passable) = {
        let pd = province.try_borrow_data()?;
        let r = Ro(&pd);
        (r.u32(P::RESOLVED_NEXT)?, r.u64(P::PASSABLE_MASK)?)
    };
    if !ap::resident_ok(rn, b) {
        return Err(FrontierError::NotResident.into());
    }
    let unit = catalog::unit_of(x.unit).ok_or(FrontierError::BadData)?;
    let (faction, gen, seq, have) = {
        let hd = holding.try_borrow_data()?;
        let r = Ro(&hd);
        (
            r.u8(H::FACTION)?,
            r.u8(H::GEN)?,
            r.u32(H::HOST_SEQ)?,
            r.u32(H::reserve(x.unit as usize))?,
        )
    };
    if have < x.troops {
        return Err(FrontierError::Insufficient.into());
    }
    let milli: MilliTroops = x
        .troops
        .checked_mul(MILLI as u32)
        .ok_or_else(|| kernel(sub::HOST_TOO_LARGE))?;
    let id = addr::host_id(hh.p as i32, hh.q as i32, hh.site, gen, seq).ok_or(BAD_ACCOUNT)?;
    let host = Host::muster(
        id,
        frontier_abi::addr::holding_key_of_host(id),
        faction,
        unit,
        milli,
        b,
    )
    .map_err(|e| host_err(e, FrontierError::NotResident))?;
    if x.tile as usize >= P::TILES || passable & (1u64 << x.tile) == 0 {
        return Err(FrontierError::BadData.into());
    }
    let dealt = bps16(doctrine(faction)?.dealt_bps(Posture::Stance(Stance::Hold), false))?;
    // Caps over states 1–2 and a free entry.
    let slot = {
        let pd = province.try_borrow_data()?;
        let (mut total, mut own, mut free) = (0usize, 0usize, None);
        for i in 0..P::ENTRIES_N {
            let o = P::entry(i);
            let st = Ro(&pd).u8(o + E::STATE)?;
            match st {
                E::STATE_FREE => {
                    if free.is_none() {
                        free = Some(i);
                    }
                }
                E::STATE_ROSTER | E::STATE_MUSTER_PENDING => {
                    total += 1;
                    if Ro(&pd).u8(o + E::FACTION)? == faction {
                        own += 1;
                    }
                }
                _ => {}
            }
        }
        if total >= P::ROSTER_CAP || own >= P::FACTION_CAP {
            return Err(FrontierError::ProvinceFull.into());
        }
        free.ok_or(FrontierError::ProvinceFull)?
    };
    let e = Entry::from_host(&host, x.tile, E::STATE_MUSTER_PENDING, dealt, b + 1);
    put_entry(province, slot, &e)?;
    {
        let mut pd = province.try_borrow_mut_data()?;
        let mut w = Rw(&mut pd);
        bump_epoch(&mut w)?;
        let n = w.u8(P::N_ENTRIES)?.saturating_add(1);
        w.set_u8(P::N_ENTRIES, n)?;
    }
    {
        let mut hd = holding.try_borrow_mut_data()?;
        write_holding(&mut hd, &h, now)?;
        let mut w = Rw(&mut hd);
        w.set_u32(H::reserve(x.unit as usize), have - x.troops)?;
        w.set_u32(H::HOST_SEQ, seq.checked_add(1).ok_or(OVERFLOW)?)?;
    }
    let payload = Buf::<7>::new()
        .u8(x.unit)
        .u32(x.troops)
        .u8(x.tile)
        .u8(slot as u8);
    super::holding::emit3(
        Kind::MUSTER,
        b,
        &id.to_le_bytes(),
        payload.get()?,
        citizen,
        holding,
        Some(province),
    )
}

// ------------------------------------------------------------ Dissolve

/// 0x44 Dissolve(host): P + `[holding w] [province w]` (where the host
/// stands). The host (state 1, no pending change) leaves after the bell's
/// clash: pending op `Leave`, its troops back to the reserve at the settle
/// (the resolver's, W4-A).
pub fn dissolve(p: &Pubkey, a: &[AccountInfo], d: &[u8]) -> R<()> {
    check_accounts(Ix::Dissolve, a, None)?;
    let x = aix::Dissolve::decode(d)?;
    let pl = player(p, a)?;
    let [_, _, _, citizen, holding, province] = a else {
        return Err(FrontierError::TooManyAccounts.into());
    };
    let hh = owned_holding(p, &pl, holding, citizen)?;
    live(&hh)?;
    let rh = resident_host(p, &pl, &hh, holding, citizen, province, x.host_id)?;
    if (rh.p, rh.q) == (hh.p, hh.q) {
        lock_own(province, &hh)?;
    }
    let now = pl.now.ts;
    let h = load_touched(holding, now)?;
    if rh.entry.busy() {
        return Err(FrontierError::HostBusy.into());
    }
    let b = pl.pc.now_bell;
    let mut e = rh.entry;
    e.op = EntryOp::Leave;
    e.pend_bell = b;
    put_entry(province, rh.index, &e)?;
    {
        let mut hd = holding.try_borrow_mut_data()?;
        write_holding(&mut hd, &h, now)?;
    }
    let payload = Buf::<12>::new().u32(b).i64(e.troops as i64);
    super::holding::emit3(
        Kind::DISSOLVE,
        b,
        &x.host_id.to_le_bytes(),
        payload.get()?,
        citizen,
        holding,
        Some(province),
    )
}

// ------------------------------------------------------------ Garrison

/// The site mirror's garrison as the kernel's `GarrisonState` (an empty
/// pending slot is bell `NO_BELL` or a zero delta).
fn garrison_of(pd: &[u8], site: usize) -> R<GarrisonState> {
    let r = Ro(pd);
    let o = P::site(site);
    let slot = |b: usize, dl: usize| -> R<Option<(u32, i64)>> {
        let (bell, delta) = (r.u32(o + b)?, r.i64(o + dl)?);
        Ok((bell != SM::NO_BELL && delta != 0).then_some((bell, delta)))
    };
    Ok(GarrisonState {
        troops: r.u32(o + SM::GARRISON)?,
        pending: [
            slot(SM::PEND0_BELL, SM::PEND0_DELTA)?,
            slot(SM::PEND1_BELL, SM::PEND1_DELTA)?,
        ],
    })
}

fn put_garrison(pd: &mut [u8], site: usize, g: &GarrisonState) -> R<()> {
    let o = P::site(site);
    let mut w = Rw(pd);
    w.set_u32(o + SM::GARRISON, g.troops)?;
    for (k, (b, dl)) in [
        (SM::PEND0_BELL, SM::PEND0_DELTA),
        (SM::PEND1_BELL, SM::PEND1_DELTA),
    ]
    .into_iter()
    .enumerate()
    {
        let (bell, delta) = g.pending[k].unwrap_or((SM::NO_BELL, 0));
        w.set_u32(o + b, bell)?;
        w.set_i64(o + dl, delta)?;
    }
    Ok(())
}

/// Reserve unit a garrison draws on (module note).
pub const GARRISON_UNIT: usize = 0;

/// 0x45 Garrison(delta): P + `[holding w] [province w]` (the holding's):
/// `delta > 0` whole troops of the Spearman reserve join the garrison
/// after the bell's clash (`GarrisonState::change`).
pub fn garrison(p: &Pubkey, a: &[AccountInfo], d: &[u8]) -> R<()> {
    check_accounts(Ix::Garrison, a, None)?;
    let x = aix::Garrison::decode(d)?;
    let pl = player(p, a)?;
    let [_, _, _, citizen, holding, province] = a else {
        return Err(FrontierError::TooManyAccounts.into());
    };
    let hh = owned_holding(p, &pl, holding, citizen)?;
    live(&hh)?;
    own_province(p, &pl, &hh, province)?;
    lock_own(province, &hh)?;
    let state = finality(&pl, &hh, holding, citizen, province)?;
    let now = pl.now.ts;
    let h = load_touched(holding, now)?;
    if state != H::STATE_FINAL {
        return Err(FrontierError::NotFinal.into());
    }
    let b = pl.pc.now_bell;
    let rn = {
        let pd = province.try_borrow_data()?;
        Ro(&pd).u32(P::RESOLVED_NEXT)?
    };
    if !ap::resident_ok(rn, b) {
        return Err(FrontierError::NotResident.into());
    }
    if x.delta <= 0 || x.delta > u32::MAX as i64 {
        return Err(FrontierError::BadData.into());
    }
    let n = x.delta as u32;
    let have = {
        let hd = holding.try_borrow_data()?;
        Ro(&hd).u32(H::reserve(GARRISON_UNIT))?
    };
    if have < n {
        return Err(FrontierError::Insufficient.into());
    }
    let delta_milli = x.delta.checked_mul(MILLI).ok_or(OVERFLOW)?;
    {
        let mut pd = province.try_borrow_mut_data()?;
        let site = site_of(&pd, &hh)?;
        let mut g = garrison_of(&pd, site)?;
        g.change(b, delta_milli, rn)
            .map_err(|e| host_err(e, FrontierError::NotResident))?;
        put_garrison(&mut pd, site, &g)?;
    }
    {
        let mut hd = holding.try_borrow_mut_data()?;
        write_holding(&mut hd, &h, now)?;
        Rw(&mut hd).set_u32(H::reserve(GARRISON_UNIT), have - n)?;
    }
    let key = super::holding::pqs_key(hh.p, hh.q, hh.site)?;
    let payload = Buf::<12>::new().u32(b).i64(delta_milli);
    super::holding::emit3(
        Kind::GARRISON,
        b,
        &key,
        payload.get()?,
        citizen,
        holding,
        Some(province),
    )
}

// ------------------------------------------------------------ DisbandStranded

/// 0x48 DisbandStranded(entry): `[any s] [season] [province w] [holding r
/// (canonical, may be absent)]`, class N. The entry's host id names a
/// Holding that is absent or re-founded (another generation); its troops
/// are lost.
///
/// v1.5 (§5.10, wave-3 review of W3-B): the disband obeys the roster
/// freeze. A host that is (or will be) in a roster — state 1, or state 2
/// muster-pending — is not freed at once: it gets the pending op `Forfeit`
/// issued at `now_bell` (the province resolved through `now_bell − 2`,
/// `NotResident`; no other pending change, `HostBusy`), so every clash
/// whose roster was already fixed still reads it, and the resolve (or
/// skip) of `now_bell` frees the entry with its post-clash troops lost
/// (W4-A). A departed entry (state 3, in no roster), and any entry once
/// the province has resolved every bell of the season, is freed at once.
/// `STRANDED` records the troops at issue (milli-troops).
pub fn disband_stranded(p: &Pubkey, a: &[AccountInfo], d: &[u8]) -> R<()> {
    check_accounts(Ix::DisbandStranded, a, None)?;
    let x = aix::DisbandStranded::decode(d)?;
    let now = prologue::now()?;
    let [_any, season_ai, province, holding] = a else {
        return Err(FrontierError::TooManyAccounts.into());
    };
    let hdr = prologue::season(
        season_ai,
        p,
        Some(&RULESET_HASH),
        &[S::STATUS_RUNNING, S::STATUS_ENDED],
        now.ts,
    )?;
    let retire_hosts = {
        let sd = season_ai.try_borrow_data()?;
        retire_hosts_of(&sd)?
    };
    let ctx = addr::ctx(&key(season_ai), &p.to_bytes());
    prologue::present(province, p, AccountKind::Province, hdr.id)?;
    let (pp, pq, rn, e) = {
        let pd = province.try_borrow_data()?;
        let r = Ro(&pd);
        let e = read_entry(&pd, x.entry as usize).map_err(|_| FrontierError::BadData)?;
        (r.i16(P::P)?, r.i16(P::Q)?, r.u32(P::RESOLVED_NEXT)?, e)
    };
    expect_key(province, &ctx.province(pp as i32, pq as i32))?;
    if e.state == E::STATE_FREE {
        return Err(FrontierError::BadData.into());
    }
    let parts = split_host_id(e.id).ok_or(BAD_ACCOUNT)?;
    expect_key(
        holding,
        &ctx.holding(parts.province.p, parts.province.q, parts.site),
    )?;
    if prologue::presence(holding, p, AccountKind::Holding, hdr.id)? {
        let hd = holding.try_borrow_data()?;
        let r = Ro(&hd);
        let live = matches!(r.u8(H::STATE)?, H::STATE_PROVISIONAL | H::STATE_FINAL);
        if live && r.u8(H::GEN)? == parts.gen {
            return Err(FrontierError::NotDormant.into());
        }
        // K-27 (v1.1): a captured Holding's previous generation keeps
        // fighting for its victim until the victim retires it (RetireHost);
        // with `retire_hosts = 1` no third party may disband it. With
        // `retire_hosts = 0` (and in every M1 season) this is M1's rule.
        let captured = r.u8(H2::CAPTURE_FLAGS)? & H2::CAPTURE_FLAG_CAPTURED != 0;
        if live && retire_hosts == 1 && captured && r.u8(H2::PREV_GEN)? == parts.gen {
            return Err(FrontierError::NotDormant.into());
        }
    }
    let b = hdr.bell(now.ts).unwrap_or(NO_BELL);
    let in_roster = matches!(e.state, E::STATE_ROSTER | E::STATE_MUSTER_PENDING);
    let pending = in_roster && rn < hdr.end_bell;
    let lost = e.troops;
    {
        let mut pd = province.try_borrow_mut_data()?;
        if pending {
            if !ap::resident_ok(rn, b) {
                return Err(FrontierError::NotResident.into());
            }
            if e.busy() {
                return Err(FrontierError::HostBusy.into());
            }
            let mut f = e;
            f.op = EntryOp::Forfeit;
            f.pend_bell = b;
            write_entry(&mut pd, x.entry as usize, &f).map_err(|_| BAD_ACCOUNT)?;
            bump_epoch(&mut Rw(&mut pd))?;
        } else {
            write_entry(&mut pd, x.entry as usize, &Entry::FREE).map_err(|_| BAD_ACCOUNT)?;
            let mut w = Rw(&mut pd);
            bump_epoch(&mut w)?;
            let n = w.u8(P::N_ENTRIES)?.saturating_sub(1);
            w.set_u8(P::N_ENTRIES, n)?;
        }
    }
    let mut pd = province.try_borrow_mut_data()?;
    events::emit(
        Kind::STRANDED,
        b,
        &e.id.to_le_bytes(),
        &lost.to_le_bytes(),
        &mut [Chained {
            entity: EntityKind::Province,
            data: &mut pd,
        }],
    )
}

// ------------------------------------------------------------ Depart

/// A compressed G2 point's first byte: compression flag set, infinity flag
/// clear (Depart's syntax check; validity is SettleTransit's, I-44).
pub const fn seal_flag_ok(b0: u8) -> bool {
    b0 & 0x80 != 0 && b0 & 0x40 == 0
}

/// The stamina a march is charged at Depart (I-32): the longest path's.
pub const DEPART_STAMINA: u16 = march_stamina(MAX_PATH_STEPS as u32);

/// 0x50 Depart: P + `[holding w] [province w] [system]`; data `host_id,
/// commit, seal, arrive_bell, tip, transit_slot`. Checks in the order of
/// §5.11.
pub fn depart(p: &Pubkey, a: &[AccountInfo], d: &[u8]) -> R<()> {
    check_accounts(Ix::Depart, a, None)?;
    let x = aix::Depart::decode(d)?;
    let pl = player(p, a)?;
    let [_, payer, season_ai, citizen, holding, province, _system] = a else {
        return Err(FrontierError::TooManyAccounts.into());
    };
    let hh = owned_holding(p, &pl, holding, citizen)?;
    live(&hh)?;
    let (pp, pq, rn) = province_at(p, &pl, province)?;
    if (pp, pq) == (hh.p, hh.q) {
        lock_own(province, &hh)?;
    }
    let state = if (pp, pq) == (hh.p, hh.q) {
        finality(&pl, &hh, holding, citizen, province)?
    } else {
        hh.state
    };
    let now = pl.now.ts;
    let b = pl.pc.now_bell;
    let h = load_touched(holding, now)?;
    // 1.
    if state != H::STATE_FINAL {
        return Err(FrontierError::NotFinal.into());
    }
    if !ap::resident_ok(rn, b) {
        return Err(FrontierError::NotResident.into());
    }
    // 2.
    if !seal_flag_ok(x.seal[0]) {
        return Err(FrontierError::BadData.into());
    }
    // 3.
    caller_host(&hh, x.host_id)?;
    let (index, mut e) = {
        let pd = province.try_borrow_data()?;
        let i = find_entry(&pd, x.host_id).ok_or(FrontierError::NotResident)?;
        (i, read_entry(&pd, i).map_err(|_| BAD_ACCOUNT)?)
    };
    if e.state != E::STATE_ROSTER {
        return Err(FrontierError::NotResident.into());
    }
    if e.busy() {
        return Err(FrontierError::HostBusy.into());
    }
    {
        let hd = holding.try_borrow_data()?;
        if ap::host_in_transit(&hd, x.host_id) {
            return Err(FrontierError::HostInTransit.into());
        }
    }
    let mut host = e.to_host().map_err(|_| BAD_ACCOUNT)?;
    host.depart(b, DEPART_STAMINA, rn)
        .map_err(|er| host_err(er, FrontierError::NotResident))?;
    // 4. W6T-1 (w6-s7): the arrival must also be a bell of the season
    // (`< end_bell`): no anchor, resolve or SettleTransit exists at or
    // after `end_bell`, so such a march could never settle. The last
    // useful Depart bell is `end_bell - 3`.
    let lo = b.checked_add(2).ok_or(OVERFLOW)?;
    let hi = b.checked_add(72).ok_or(OVERFLOW)?;
    if x.arrive_bell < lo || x.arrive_bell > hi || x.arrive_bell >= pl.pc.season.end_bell {
        return Err(FrontierError::ArrivalBell.into());
    }
    // 5.
    let (priority, limit, loaded, fee, bond) = {
        let sd = season_ai.try_borrow_data()?;
        let r = Ro(&sd);
        (
            r.u32(S::MIN_REVEAL_PRIORITY_MILLI)?,
            r.u32(S::REVEAL_CU_LIMIT)?,
            r.u32(S::REVEAL_LOADED_LIMIT)?,
            r.u64(S::MARCH_FEE)?,
            r.u64(S::SEAL_BOND)?,
        )
    };
    if x.tip < fees::min_tip_lamports(priority, limit, loaded) {
        return Err(FrontierError::TipTooLow.into());
    }
    if x.transit_slot as usize >= H::TRANSIT_N {
        return Err(FrontierError::BadData.into());
    }
    let t0 = H::transit(x.transit_slot as usize);
    {
        let hd = holding.try_borrow_data()?;
        if Ro(&hd).u8(t0 + T::STATE)? != T::STATE_FREE {
            return Err(FrontierError::TransitState.into());
        }
    }
    let total = x
        .tip
        .checked_add(fee)
        .and_then(|v| v.checked_add(bond))
        .ok_or(OVERFLOW)?;
    if payer.lamports() < total {
        return Err(FrontierError::Insufficient.into());
    }
    // Effects.
    let ct_hash = permutation_rules::hash::sha256(&[&x.seal]);
    let seal_root = permutation_rules::hash::sha256(&[&x.commit, &ct_hash]);
    let dealt = bps16(doctrine(e.faction)?.dealt_bps(Posture::Stance(Stance::Hold), true))?;
    init::transfer(payer, holding, total)?;
    e.set_host(&host);
    put_entry(province, index, &e)?;
    {
        let mut hd = holding.try_borrow_mut_data()?;
        write_holding(&mut hd, &h, now)?;
        let mut w = Rw(&mut hd);
        w.set_u8(t0 + T::STATE, T::STATE_DEPARTED)?;
        w.set_u8(t0 + T::UNIT, e.unit)?;
        w.set_u8(t0 + T::FACTION, e.faction)?;
        w.set_u8(t0 + T::ORIGIN_TILE, e.tile)?;
        w.set_i16(t0 + T::ORIGIN_P, pp)?;
        w.set_i16(t0 + T::ORIGIN_Q, pq)?;
        w.set_u64(t0 + T::HOST_ID, x.host_id)?;
        w.set_u32(t0 + T::DEPART_BELL, b)?;
        w.set_u32(t0 + T::ARRIVE_BELL, x.arrive_bell)?;
        w.set_i64(t0 + T::DEPART_TS, now)?;
        w.set_u32(t0 + T::DEP_MASS, e.troops)?;
        w.set_u16(t0 + T::MARCH_STAMINA, DEPART_STAMINA)?;
        w.set_u16(t0 + T::DEALT_BPS, dealt)?;
        w.set_u32(t0 + T::TROOPS_AFTER, 0)?;
        w.set_u16(t0 + T::STAMINA_AFTER, 0)?;
        w.set_u16(t0 + T::READY_BELL_OFF, 0)?;
        w.set_arr(t0 + T::SEAL_ROOT, &seal_root)?;
        w.set_u64(t0 + T::TIP, x.tip)?;
        w.set_u8(t0 + T::FLAGS, T::FLAG_FEE_ESCROWED | T::FLAG_BOND_ESCROWED)?;
        w.add_u64(H::ESCROW, total)?;
    }
    {
        let mut cd = citizen.try_borrow_mut_data()?;
        Rw(&mut cd).add_u32(C::ARRIVALS, 1)?;
    }
    let payload = Buf::<260>::new()
        .i32(pp as i32)
        .i32(pq as i32)
        .u8(e.tile)
        .u32(b)
        .u32(x.arrive_bell)
        .u32(e.troops)
        .u16(DEPART_STAMINA)
        .u64(x.tip)
        .bytes(&seal_root)
        .bytes(&x.commit)
        .bytes(&x.seal);
    super::holding::emit3(
        Kind::DEPART,
        b,
        &x.host_id.to_le_bytes(),
        payload.get()?,
        citizen,
        holding,
        Some(province),
    )
}

// ------------------------------------------------------------ SettleDeparture

/// 0x52 SettleDeparture(transit_slot): `[payer s] [season] [origin
/// province w] [holding w]`, class D. Once the origin resolved the
/// departure bell, the departed entry's post-clash values move into the
/// transit record (state 2, or 3 when destroyed at the origin) and the
/// entry is freed (I-11, D4).
pub fn settle_departure(p: &Pubkey, a: &[AccountInfo], d: &[u8]) -> R<()> {
    check_accounts(Ix::SettleDeparture, a, None)?;
    let x = aix::SettleDeparture::decode(d)?;
    // v1.5 §21: `transit_slot = 0xFF` is the return settle of hosts that
    // left a province (Dissolve's `Leave`), W4-A's choice of instruction.
    if x.transit_slot == super::clash::RETURN_SLOT {
        return settle_return(p, a);
    }
    let now = prologue::now()?;
    let [_payer, season_ai, province, holding] = a else {
        return Err(FrontierError::TooManyAccounts.into());
    };
    let hdr = prologue::season(
        season_ai,
        p,
        Some(&RULESET_HASH),
        &[S::STATUS_RUNNING, S::STATUS_ENDED],
        now.ts,
    )?;
    let ctx = addr::ctx(&key(season_ai), &p.to_bytes());
    prologue::present(holding, p, AccountKind::Holding, hdr.id)?;
    if x.transit_slot as usize >= H::TRANSIT_N {
        return Err(FrontierError::BadData.into());
    }
    let t0 = H::transit(x.transit_slot as usize);
    let (state, host_id, op, oq, depart_bell, own) = {
        let hd = holding.try_borrow_data()?;
        let r = Ro(&hd);
        let (hp, hq, site) = (r.i16(H::P)?, r.i16(H::Q)?, r.u8(H::SITE)?);
        expect_key(holding, &ctx.holding(hp as i32, hq as i32, site))?;
        (
            r.u8(t0 + T::STATE)?,
            r.u64(t0 + T::HOST_ID)?,
            r.i16(t0 + T::ORIGIN_P)?,
            r.i16(t0 + T::ORIGIN_Q)?,
            r.u32(t0 + T::DEPART_BELL)?,
            (hp, hq, site, r.u8(H::GEN)?),
        )
    };
    match state {
        T::STATE_DEPARTED => {}
        T::STATE_SETTLED | T::STATE_DESTROYED_AT_ORIGIN => {
            return Err(FrontierError::AlreadyDone.into())
        }
        _ => return Err(FrontierError::TransitState.into()),
    }
    expect_key(province, &ctx.province(op as i32, oq as i32))?;
    prologue::present(province, p, AccountKind::Province, hdr.id)?;
    // §5.8: no settle but SettleCapture writes a capture-locked Holding
    // (checkable when the origin is the Holding's own Province, D-1).
    if (op, oq) == (own.0, own.1) {
        let pd = province.try_borrow_data()?;
        let hd = holding.try_borrow_data()?;
        capture_lock_of(&pd, &hd)?;
    }
    let (rn, index, e) = {
        let pd = province.try_borrow_data()?;
        let rn = Ro(&pd).u32(P::RESOLVED_NEXT)?;
        if rn <= depart_bell {
            return Err(FrontierError::TooEarly.into());
        }
        let i = find_entry(&pd, host_id).ok_or(FrontierError::NotResident)?;
        (rn, i, read_entry(&pd, i).map_err(|_| BAD_ACCOUNT)?)
    };
    if e.state != E::STATE_DEPARTED {
        return Err(FrontierError::NotResident.into());
    }
    let host = e.to_host().map_err(|_| BAD_ACCOUNT)?;
    let (troops, stamina) = host
        .march_values(depart_bell, rn)
        .map_err(|er| host_err(er, FrontierError::TooEarly))?;
    let destroyed = troops < DESTROYED_BELOW;
    let (troops, stamina) = if destroyed { (0, 0) } else { (troops, stamina) };
    let ready_off = e
        .ready_bell
        .saturating_sub(depart_bell)
        .min(u16::MAX as u32) as u16;
    {
        let mut pd = province.try_borrow_mut_data()?;
        write_entry(&mut pd, index, &Entry::FREE).map_err(|_| BAD_ACCOUNT)?;
        let mut w = Rw(&mut pd);
        let n = w.u8(P::N_ENTRIES)?.saturating_sub(1);
        w.set_u8(P::N_ENTRIES, n)?;
    }
    {
        let mut hd = holding.try_borrow_mut_data()?;
        let mut w = Rw(&mut hd);
        w.set_u8(
            t0 + T::STATE,
            if destroyed {
                T::STATE_DESTROYED_AT_ORIGIN
            } else {
                T::STATE_SETTLED
            },
        )?;
        w.set_u32(t0 + T::TROOPS_AFTER, troops)?;
        w.set_u16(t0 + T::STAMINA_AFTER, stamina)?;
        w.set_u16(t0 + T::READY_BELL_OFF, ready_off)?;
    }
    let payload = Buf::<7>::new().u32(troops).u16(stamina).u8(destroyed as u8);
    let mut hd = holding.try_borrow_mut_data()?;
    let mut pd = province.try_borrow_mut_data()?;
    events::emit(
        Kind::DEPARTURE_SETTLED,
        hdr.bell(now.ts).unwrap_or(NO_BELL),
        &host_id.to_le_bytes(),
        payload.get()?,
        &mut [
            Chained {
                entity: EntityKind::Holding,
                data: &mut hd,
            },
            Chained {
                entity: EntityKind::Province,
                data: &mut pd,
            },
        ],
    )
}

// ------------------------------------------------------------ the return settle

/// Which return settle frees an entry (MC §3.6, §5.5 RetireHost, D-6).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ReturnTarget {
    /// `province index << 4 | site` of the Holding whose return settle
    /// frees the entry: the home of a bound retire Leave (`op_ref`), the
    /// issuing Holding otherwise.
    pub site_ident: u64,
    /// The generation that Holding must be live at to be credited.
    pub gen: u8,
    /// A retire Leave bound to a home Holding by RetireHost.
    pub bound: bool,
}

/// The return target of a departed Leave entry with host id `id`,
/// `op_a` and `op_ref`.
pub const fn return_target(id: u64, op_a: u8, op_ref: u32) -> ReturnTarget {
    use permutation_rules::frontier::addr::HOST_SITE_SHIFT;
    if op_a == frontier_abi::v2::entry::RETIRE_OP_A && op_ref != 0 {
        ReturnTarget {
            site_ident: (op_ref as u64) >> (HOST_SITE_SHIFT - 32),
            gen: op_ref as u8,
            bound: true,
        }
    } else {
        ReturnTarget {
            site_ident: id >> HOST_SITE_SHIFT,
            gen: (id >> 32) as u8,
            bound: false,
        }
    }
}

/// What the return settle does with one picked entry.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReturnFate {
    /// Whole troops into the Holding's `reserve[unit]`.
    Credit,
    /// Troops lost (`STRANDED`).
    Strand,
    /// Left for RetireHost (a captured Holding's previous generation while
    /// `retire_hosts = 1`): never stranded by a third party (K-27).
    Wait,
}

/// The holding facts the return settle decides on: its live generation
/// (`None` when absent or not live), and the previous generation of a
/// captured Holding when its victims' hosts wait for RetireHost.
pub const fn return_fate(t: ReturnTarget, live: Option<u8>, waiting_gen: Option<u8>) -> ReturnFate {
    match live {
        Some(g) if g == t.gen => ReturnFate::Credit,
        _ => match waiting_gen {
            Some(pg) if !t.bound && pg == t.gen => ReturnFate::Wait,
            _ => ReturnFate::Strand,
        },
    }
}

/// SettleDeparture(`transit_slot = 0xFF`), the return settle (M1 §21;
/// moved here from `clash.rs` by CQ2-C, MC §11): `[payer s] [season]
/// [province w] [holding w]`, the Holding canonical, possibly absent.
///
/// Every state-3 `Leave` entry of the Province whose **return target** is
/// that Holding is freed (at most [`super::clash::RETURN_MAX`] per
/// transaction, in entry order): a retire Leave bound by RetireHost
/// returns to its home Holding (`op_ref`, D-6), every other Leave to its
/// issuing Holding. Its whole troops go to `reserve[unit]` when the
/// Holding is live at the target generation, else they are lost —
/// except a captured Holding's previous generation while `retire_hosts =
/// 1`, which waits for its victim's RetireHost (K-27; never stranded by a
/// third party). `AlreadyDone` when nothing is returned. The capture lock
/// applies when the Province is the Holding's own (§5.8).
pub fn settle_return(p: &Pubkey, a: &[AccountInfo]) -> R<()> {
    use permutation_rules::frontier::addr::HOST_SITE_SHIFT;
    let [_payer, season_ai, province, holding] = a else {
        return Err(FrontierError::TooManyAccounts.into());
    };
    let now = prologue::now()?;
    let hdr = prologue::season(
        season_ai,
        p,
        Some(&RULESET_HASH),
        &[S::STATUS_RUNNING, S::STATUS_ENDED],
        now.ts,
    )?;
    let retire_hosts = {
        let sd = season_ai.try_borrow_data()?;
        retire_hosts_of(&sd)?
    };
    let sid = hdr.id;
    let ctx = addr::ctx(&key(season_ai), &p.to_bytes());
    prologue::present(province, p, AccountKind::Province, sid)?;
    let (pp, pq) = {
        let pd = province.try_borrow_data()?;
        let r = Ro(&pd);
        (r.i16(P::P)?, r.i16(P::Q)?)
    };
    expect_key(province, &ctx.province(pp as i32, pq as i32))?;
    // The Holding: its site identity, live generation and capture state.
    let (live, waiting, mut own) = if prologue::presence(holding, p, AccountKind::Holding, sid)? {
        let hd = holding.try_borrow_data()?;
        let r = Ro(&hd);
        let (hp, hq, site) = (r.i16(H::P)?, r.i16(H::Q)?, r.u8(H::SITE)?);
        expect_key(holding, &ctx.holding(hp as i32, hq as i32, site))?;
        let gen = r.u8(H::GEN)?;
        let live = matches!(r.u8(H::STATE)?, H::STATE_PROVISIONAL | H::STATE_FINAL).then_some(gen);
        let captured = r.u8(H2::CAPTURE_FLAGS)? & H2::CAPTURE_FLAG_CAPTURED != 0;
        let waiting =
            (captured && retire_hosts == 1 && live.is_some()).then_some(r.u8(H2::PREV_GEN)?);
        if (hp, hq) == (pp, pq) && live.is_some() {
            let pd = province.try_borrow_data()?;
            capture_lock(&pd, site, gen)?;
        }
        let ident = frontier_abi::addr::host_id(hp as i32, hq as i32, site, 0, 0)
            .ok_or(BAD_ACCOUNT)?
            >> HOST_SITE_SHIFT;
        (live, waiting, Some(ident))
    } else {
        (None, None, None)
    };
    let bell_log = hdr.bell(now.ts).unwrap_or(NO_BELL);
    let hkey = key(holding);
    // Selection: one read-only pass over the raw entries (state, op,
    // host id, op_a, op_ref); an absent Holding is matched by address,
    // derived once per run of one foreign site.
    let mut picked = [(0usize, ReturnFate::Strand); super::clash::RETURN_MAX];
    let mut n_picked = 0usize;
    {
        let pd = province.try_borrow_data()?;
        let r = Ro(&pd);
        let mut foreign: Option<u64> = None;
        for i in 0..P::ENTRIES_N {
            let o = P::entry(i);
            if r.u8(o + E::STATE)? != E::STATE_DEPARTED || r.u8(o + E::PEND_OP)? != E::OP_LEAVE {
                continue;
            }
            let id = r.u64(o + E::ID)?;
            let t = return_target(id, r.u8(o + E::OP_A)?, r.u32(o + E::OP_REF)?);
            let mine = match own {
                Some(s) => s == t.site_ident,
                None if foreign == Some(t.site_ident) => false,
                None => {
                    let k = t.site_ident << HOST_SITE_SHIFT;
                    let parts = split_host_id(k).ok_or(BAD_ACCOUNT)?;
                    if ctx.holding(parts.province.p, parts.province.q, parts.site) == hkey {
                        own = Some(t.site_ident);
                        true
                    } else {
                        foreign = Some(t.site_ident);
                        false
                    }
                }
            };
            if !mine {
                continue;
            }
            let fate = return_fate(t, live, waiting);
            if fate == ReturnFate::Wait {
                continue;
            }
            picked[n_picked] = (i, fate);
            n_picked += 1;
            if n_picked == super::clash::RETURN_MAX {
                break;
            }
        }
    }
    if n_picked == 0 {
        return Err(FrontierError::AlreadyDone.into());
    }
    for &(i, fate) in &picked[..n_picked] {
        let e = {
            let pd = province.try_borrow_data()?;
            read_entry(&pd, i).map_err(|_| BAD_ACCOUNT)?
        };
        {
            let mut pd = province.try_borrow_mut_data()?;
            write_entry(&mut pd, i, &Entry::FREE).map_err(|_| BAD_ACCOUNT)?;
            let mut w = Rw(&mut pd);
            let n = w.u8(P::N_ENTRIES)?.saturating_sub(1);
            w.set_u8(P::N_ENTRIES, n)?;
        }
        let key8 = e.id.to_le_bytes();
        if fate == ReturnFate::Credit {
            let whole = e.troops / MILLI as u32;
            {
                let mut hd = holding.try_borrow_mut_data()?;
                let mut w = Rw(&mut hd);
                let o = H::reserve(e.unit as usize);
                let v = w.u32(o)?.checked_add(whole).ok_or(OVERFLOW)?;
                w.set_u32(o, v)?;
            }
            let payload = Buf::<7>::new()
                .u32(whole.saturating_mul(MILLI as u32))
                .u16(0)
                .u8(super::clash::RETURNED);
            let mut hd = holding.try_borrow_mut_data()?;
            let mut pd = province.try_borrow_mut_data()?;
            events::emit(
                Kind::DEPARTURE_SETTLED,
                bell_log,
                &key8,
                payload.get()?,
                &mut [
                    Chained {
                        entity: EntityKind::Holding,
                        data: &mut hd,
                    },
                    Chained {
                        entity: EntityKind::Province,
                        data: &mut pd,
                    },
                ],
            )?;
        } else {
            let mut pd = province.try_borrow_mut_data()?;
            events::emit(
                Kind::STRANDED,
                bell_log,
                &key8,
                &e.troops.to_le_bytes(),
                &mut [Chained {
                    entity: EntityKind::Province,
                    data: &mut pd,
                }],
            )?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seal_syntax_and_depart_stamina() {
        assert!(seal_flag_ok(0x80));
        assert!(seal_flag_ok(0xA5));
        assert!(!seal_flag_ok(0x00));
        assert!(!seal_flag_ok(0xC0), "infinity");
        assert_eq!(DEPART_STAMINA, 74);
    }

    #[test]
    fn garrison_mirror_round_trips() {
        let mut pd = alloc::vec![0u8; P::SIZE];
        let g = GarrisonState {
            troops: 5_000_000,
            pending: [Some((7, 100_000)), None],
        };
        put_garrison(&mut pd, 3, &g).unwrap();
        assert_eq!(garrison_of(&pd, 3).unwrap(), g);
        // a zeroed mirror reads as empty pending slots
        assert_eq!(
            garrison_of(&alloc::vec![0u8; P::SIZE], 0).unwrap(),
            GarrisonState::new(0)
        );
    }
}
