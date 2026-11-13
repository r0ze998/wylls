//! Private candidate child of `wide`. No public instruction or proof stub.
//! These snapshots are deliberately NOT executable settlement authorization.
//! Resolved/gathered accounts do not prove a seal valid. The private draft
//! consumer performs the real proof, timing and claim checks, re-reads all
//! accounts, stages payments/diversion and commits paired cleanup with
//! original PS2 and destination PSW1 receipts. No event identifiers allocated.
//! Only strict owned bridge-v2 is accepted. Both final-set and retained-slot
//! Citizen bind to its immutable original owner; PREV_OWNER_TAG remains only
//! a legacy single-history consistency check, not full-identity authority.
use super::*;
use crate::layout::holding2 as H2;
use frontier_abi::entry::{find_entry, unit_from_u8, Entry};
use frontier_abi::world_index::expedition::AccountResolver;
use frontier_abi::world_index::expedition_bridge::{authenticate_pair, BridgeMarker, MARKER_LEN};
use frontier_abi::world_index::expedition_transport::{ArrivalSlot, OwnedBridgeTransit};

/// All fields remain private: a preview cannot be passed to a commit routine.
/// Arrival-slot rent/claims and camp Works are intentionally not projected.
pub(super) struct PendingResolvedReturn {
    holding: Vec<u8>,
    home: Option<Vec<u8>>,
    previous_home: Option<Vec<u8>>,
    payments_if_valid: SettlementPlan,
    arrival_position: usize,
    resolver: [u8; 32],
    slot_beneficiary: Option<[u8; 32]>,
    retained_slot: Option<ArrivalSlot>,
    holding_rent_payer: [u8; 32],
    external_rent_to: [u8; 32],
    external_rent: u64,
    credited_milli: u32,
}

/// Current ownership or the one surviving capture-history record, never an
/// inferred ancestor or the captor's generation. Issuance is checked only in
/// the current generation because capture resets HOST_SEQ.
fn previous_generation(hd: &[u8], t: &WideTransit) -> R<bool> {
    let r = Ro(hd);
    if t.host.gen() == r.u8(H::GEN)? {
        // Released holdings retain current-generation legacy settlements.
        if t.host.seq() >= r.u32(H::HOST_SEQ)? {
            return Err(BAD_ACCOUNT);
        }
        return Ok(false);
    }
    if r.u8(H2::CAPTURE_FLAGS)? & H2::CAPTURE_FLAG_CAPTURED == 0
        || t.host.gen() != r.u8(H2::PREV_GEN)?
    {
        return Err(BAD_ACCOUNT);
    }
    Ok(true)
}

/// The deployed legacy return-home rule over copies, not a WideRoster alias.
/// An existing original ID is refused even if capacity would fall back to
/// Reserve: a malformed duplicate must not produce another spendable copy.
fn stage_legacy_home(
    pd: &mut [u8],
    hd: &mut [u8],
    t: &WideTransit,
    id: u64,
    troops: u32,
    stamina: u16,
    stamina_bell: u32,
    now_bell: u32,
) -> R<u32> {
    if find_entry(pd, id).is_some() {
        return Err(BAD_ACCOUNT);
    }
    let mut total = 0;
    let mut own = 0;
    let mut free = None;
    for i in 0..PV::ENTRIES_N {
        let o = PV::entry(i);
        let r = Ro(pd);
        match r.u8(o + E::STATE)? {
            E::STATE_FREE => {
                if free.is_none() {
                    free = Some(i);
                }
            }
            E::STATE_ROSTER | E::STATE_MUSTER_PENDING => {
                total += 1;
                if r.u8(o + E::FACTION)? == t.faction {
                    own += 1;
                }
            }
            _ => {}
        }
    }
    if total >= PV::ROSTER_CAP || own >= PV::FACTION_CAP {
        free = None;
    }
    let Some(i) = free else {
        return reserve_credit(hd, t.unit, troops);
    };
    let from = now_bell.checked_add(1).ok_or(OVERFLOW)?;
    let ready = t
        .depart_bell
        .checked_add(t.ready_bell_off as u32)
        .ok_or(OVERFLOW)?
        .max(from);
    let doctrine = of_faction_v3(t.faction).ok_or(BAD_ACCOUNT)?;
    let dealt = hold::bps16(doctrine.dealt_bps(Posture::Stance(Stance::Hold), false))?;
    let host = permutation_rules::frontier::host::Host {
        id,
        owner: frontier_abi::addr::holding_key_of_host(id),
        faction: t.faction,
        unit: unit_from_u8(t.unit).ok_or(BAD_ACCOUNT)?,
        troops,
        stamina: permutation_rules::frontier::host::Stamina {
            value: stamina,
            bell: stamina_bell,
        },
        ready_bell: ready,
        pending: None,
    };
    let tile = Ro(hd).u8(H::TILE)?;
    let e = Entry::from_host(&host, tile, E::STATE_MUSTER_PENDING, dealt, from);
    write_entry(pd, i, &e).map_err(|_| BAD_ACCOUNT)?;
    let n = Ro(pd).u8(PV::N_ENTRIES)?.checked_add(1).ok_or(OVERFLOW)?;
    let epoch = Ro(pd).u32(PV::ROSTER_EPOCH)?.wrapping_add(1);
    Rw(pd).set_u8(PV::N_ENTRIES, n)?;
    Rw(pd).set_u32(PV::ROSTER_EPOCH, epoch)?;
    Ok(troops)
}

fn reserve_credit(hd: &mut [u8], unit: u8, troops: u32) -> R<u32> {
    if unit as usize >= H::RESERVE_N || unit_from_u8(unit).is_none() {
        return Err(BAD_ACCOUNT);
    }
    let whole = troops / MILLI as u32;
    let o = H::reserve(unit as usize);
    let next = Ro(hd).u32(o)?.checked_add(whole).ok_or(OVERFLOW)?;
    Rw(hd).set_u32(o, next)?;
    Ok(whole * MILLI as u32)
}

/// Read-only runtime-account preview for an actual resolved final-set member.
/// Private account table (no wire ABI): season, original holding, external,
/// original province, wide destination, inputs, arrival slot, external rent
/// recipient, optionally the mandatory captured PREV_HOME holding.
/// No caller-supplied outcome, survivor count, owner or seal verdict is accepted.
/// Non-member routing/bad-seal forfeiture require separate proof-bound staging.
pub(super) fn stage_resolved_return(
    p: &Pubkey,
    a: &[AccountInfo],
    slot_index: u8,
) -> R<PendingResolvedReturn> {
    let [season, holding, external, home, dest, inputs, slot, rent_to, tail @ ..] = a else {
        return Err(FrontierError::TooManyAccounts.into());
    };
    if tail.len() > 1 || slot_index as usize >= H::TRANSIT_N {
        return Err(BAD_ACCOUNT);
    }
    let now = prologue::now()?;
    let hdr = settle_season(season, p, now.ts)?;
    let now_bell = hdr.bell(now.ts).ok_or(FrontierError::WrongStatus)?;
    let ctx = addr::ctx(&key(season), &p.to_bytes());
    prologue::present_v2(
        holding,
        p,
        frontier_abi::v2::layout::AccountKind::Holding,
        hdr.id,
    )?;
    check_source_province(p, &ctx, hdr.id, holding, home)?;
    if external.owner != p {
        return Err(BAD_ACCOUNT);
    }
    let mut hd = holding.try_borrow_data()?.to_vec();
    let bridge = OwnedBridgeTransit::from_bytes(&ctx, &external.try_borrow_data()?)
        .map_err(|_| BAD_ACCOUNT)?;
    let off = H::transit(slot_index as usize);
    let marker = BridgeMarker::from_bytes(&ctx, hd.get(off..off + MARKER_LEN).ok_or(BAD_ACCOUNT)?)
        .map_err(|_| BAD_ACCOUNT)?;
    let pair = authenticate_pair(
        &ctx,
        &key(holding),
        slot_index,
        &key(external),
        &marker,
        bridge.common(),
    )
    .map_err(|_| BAD_ACCOUNT)?;
    let t = bridge.transit();
    let resolver = AccountResolver::for_season(&ctx).map_err(|_| BAD_ACCOUNT)?;
    let id = resolver.legacy_host_id(&t.host).map_err(|_| BAD_ACCOUNT)?;
    let parts = frontier_abi::addr::split_host_id(id).ok_or(BAD_ACCOUNT)?;
    let r = Ro(&hd);
    if r.i16(H::P)? as i32 != parts.province.p
        || r.i16(H::Q)? as i32 != parts.province.q
        || r.u8(H::SITE)? != parts.site
    {
        return Err(BAD_ACCOUNT);
    }
    let previous = previous_generation(&hd, &t)?;
    if previous != !tail.is_empty() {
        return Err(BAD_ACCOUNT);
    }
    if t.state != MarchState::Gathered {
        return Err(FrontierError::TransitState.into());
    }
    let dkey = t.dest.ok_or(BAD_ACCOUNT)?;
    let dp = province_at(dest, p, hdr.id)?.ok_or(BAD_ACCOUNT)?;
    if ProvinceKey::new(dp.world, dp.coord) != dkey {
        return Err(BAD_ACCOUNT);
    }
    expect_key(
        dest,
        &resolver.province_address(dkey).map_err(|_| BAD_ACCOUNT)?,
    )?;
    if Ro(&dest.try_borrow_data()?).u32(PV::RESOLVED_NEXT)? <= t.arrive_bell {
        return Err(FrontierError::TooEarly.into());
    }
    expect_key(inputs, &wa::clash_inputs_address(&ctx, dkey, t.arrive_bell))?;
    if inputs.owner != p {
        return Err(BAD_ACCOUNT);
    }
    let cd = inputs.try_borrow_data()?;
    let ih = WideClashInputsHdr::read(&cd).map_err(|_| BAD_ACCOUNT)?;
    if ih.season_id != hdr.id
        || ih.dest != dkey
        || ih.bell != t.arrive_bell
        || ih.flags & wa::wide_clash_inputs::FLAG_RESOLVED == 0
        || ih.arrivals_mask != wa::wide_clash_inputs::ALL_GATHERED
    {
        return Err(BAD_ACCOUNT);
    }
    let base = wa::wide_clash_inputs::position(t.faction, 0);
    let mut found = None;
    for i in 0..4 {
        if let Some(rec) = WideArrival::read_at(&cd, base + i).map_err(|_| BAD_ACCOUNT)? {
            if rec.present && rec.host == t.host {
                if found.is_some() {
                    return Err(BAD_ACCOUNT);
                }
                found = Some((i, rec));
            }
        }
    }
    let (position, rec) = found.ok_or(BAD_ACCOUNT)?;
    if ih.settled_mask & (1 << (base + position)) != 0 {
        return Err(FrontierError::AlreadyDone.into());
    }
    if rec.unit != t.unit
        || rec.citizen != bridge.original_owner()
        || rec.faction != t.faction
        || rec.dep_mass != t.dep_mass
        || !(wa::wide_arrival::FATE_STAYS..=wa::wide_arrival::FATE_DESTROYED).contains(&rec.fate)
    {
        return Err(BAD_ACCOUNT);
    }
    if previous {
        if frontier_abi::addr::citizen_tag(&rec.citizen) != r.u64(H2::PREV_OWNER_TAG)? {
            return Err(BAD_ACCOUNT);
        }
    } else if rec.citizen != r.arr::<32>(H::OWNER_CITIZEN)? {
        return Err(BAD_ACCOUNT);
    }
    expect_key(
        slot,
        &wa::arrival_slot_address(&ctx, dkey, t.arrive_bell, t.faction, position as u8),
    )?;
    let own_slot = if init::is_absent(slot) {
        None
    } else {
        if slot.owner != p {
            return Err(BAD_ACCOUNT);
        }
        let record = ArrivalSlot::read(&ctx, &slot.try_borrow_data()?).map_err(|_| BAD_ACCOUNT)?;
        let s = record.common();
        if s.season_id != hdr.id
            || s.dest != dkey
            || s.bell != t.arrive_bell
            || s.faction != t.faction
            || s.i != position as u8
            || s.host != t.host
            || s.unit != t.unit
            || s.dep_mass != t.dep_mass
            || s.citizen != bridge.original_owner()
            || s.transit_slot != slot_index
            || s.flags & wa::wide_arrival_slot::FLAG_SETTLED != 0
        {
            return Err(BAD_ACCOUNT);
        }
        Some(record)
    };
    expect_key(rent_to, &t.rent_to)?;
    if rent_to.key == external.key {
        return Err(BAD_ACCOUNT);
    }
    rent_to
        .lamports()
        .checked_add(external.lamports())
        .ok_or(OVERFLOW)?;
    let sd = season.try_borrow_data()?;
    let finances = pair
        .financial_input(Ro(&sd).u64(S::MARCH_FEE)?, Ro(&sd).u64(S::SEAL_BOND)?)
        .map_err(|_| BAD_ACCOUNT)?;
    let plan = plan_settlement(
        WideOutcome::Fate(rec.fate),
        &finances.transit,
        Some(&rec),
        finances.fee,
        finances.bond,
        own_slot.is_some(),
    )?;
    let escrow_after = r
        .u64(H::ESCROW)?
        .checked_sub(plan.total)
        .ok_or(BAD_ACCOUNT)?;
    let holding_rent_payer = r.arr(H::RENT_PAYER)?;
    let mut previous_home = None;
    let mut home_bytes = None;
    let mut credited_milli = 0;
    // Authenticate PREV_HOME even if no troops return. It is mandatory and
    // cannot alias the captured issuer, regardless of its current generation.
    if let Some(ph) = tail.first() {
        let prev_id = r.u64(H2::PREV_HOME)?;
        let prev = frontier_abi::addr::split_host_id(prev_id).ok_or(BAD_ACCOUNT)?;
        expect_key(
            ph,
            &ctx.holding(prev.province.p, prev.province.q, prev.site),
        )?;
        if ph.key == holding.key {
            return Err(BAD_ACCOUNT);
        }
        if prologue::presence_v2(
            ph,
            p,
            frontier_abi::v2::layout::AccountKind::Holding,
            hdr.id,
        )? {
            let mut pd = ph.try_borrow_data()?.to_vec();
            let pr = Ro(&pd);
            if pr.i16(H::P)? as i32 != prev.province.p
                || pr.i16(H::Q)? as i32 != prev.province.q
                || pr.u8(H::SITE)? != prev.site
            {
                return Err(BAD_ACCOUNT);
            }
            if pr.u8(H::GEN)? == prev.gen
                && matches!(pr.u8(H::STATE)?, H::STATE_PROVISIONAL | H::STATE_FINAL)
            {
                if let Some((troops, _, _)) = plan.returns {
                    credited_milli = reserve_credit(&mut pd, t.unit, troops)?;
                    previous_home = Some(pd);
                }
            }
        }
    } else if let Some((troops, stamina, _)) = plan.returns {
        let mut pd = home.try_borrow_data()?.to_vec();
        if Ro(&pd).i16(PV::P)? as i32 != parts.province.p
            || Ro(&pd).i16(PV::Q)? as i32 != parts.province.q
        {
            return Err(BAD_ACCOUNT);
        }
        credited_milli = stage_legacy_home(
            &mut pd,
            &mut hd,
            &t,
            id,
            troops,
            stamina,
            t.arrive_bell,
            now_bell,
        )?;
        home_bytes = Some(pd);
    }
    Rw(&mut hd).set_u64(H::ESCROW, escrow_after)?;
    hd[off..off + MARKER_LEN].fill(0);
    Ok(PendingResolvedReturn {
        holding: hd,
        home: home_bytes,
        previous_home,
        payments_if_valid: plan,
        arrival_position: base + position,
        resolver: ih.resolver,
        slot_beneficiary: own_slot.map(|s| s.common().beneficiary),
        retained_slot: own_slot,
        holding_rent_payer,
        external_rent_to: t.rent_to,
        external_rent: external.lamports(),
        credited_milli,
    })
}

/// Terminal cleanup never consumes the embedded escrow ledger. Existing
/// CloseHolding still sweeps that escrow normally, before or after this plan.
pub(super) struct TerminalRentOnly {
    holding_marker_clear: Option<Vec<u8>>,
    external: [u8; 32],
    rent_to: [u8; 32],
    rent: u64,
}

pub(super) fn stage_terminal(p: &Pubkey, a: &[AccountInfo], slot_index: u8) -> R<TerminalRentOnly> {
    let [season, holding, external, rent_to] = a else {
        return Err(BAD_ACCOUNT);
    };
    let (sid, _, _) = season_end(season, p, prologue::now()?.ts)?;
    let ctx = addr::ctx(&key(season), &p.to_bytes());
    if external.owner != p {
        return Err(BAD_ACCOUNT);
    }
    let bridge = OwnedBridgeTransit::from_bytes(&ctx, &external.try_borrow_data()?)
        .map_err(|_| BAD_ACCOUNT)?;
    let t = bridge.transit();
    let resolver = AccountResolver::for_season(&ctx).map_err(|_| BAD_ACCOUNT)?;
    expect_key(
        holding,
        &resolver.holding_address(&t.host).map_err(|_| BAD_ACCOUNT)?,
    )?;
    if bridge.slot() != slot_index {
        return Err(BAD_ACCOUNT);
    }
    expect_key(
        external,
        &wm::transit_address(&ctx, &key(holding), slot_index),
    )?;
    expect_key(rent_to, &t.rent_to)?;
    if rent_to.key == external.key || rent_to.key == holding.key {
        return Err(BAD_ACCOUNT);
    }
    rent_to
        .lamports()
        .checked_add(external.lamports())
        .ok_or(OVERFLOW)?;
    let holding_marker_clear = if prologue::presence_v2(
        holding,
        p,
        frontier_abi::v2::layout::AccountKind::Holding,
        sid,
    )? {
        let mut hd = holding.try_borrow_data()?.to_vec();
        let id = resolver.legacy_host_id(&t.host).map_err(|_| BAD_ACCOUNT)?;
        let parts = frontier_abi::addr::split_host_id(id).ok_or(BAD_ACCOUNT)?;
        let r = Ro(&hd);
        if r.i16(H::P)? as i32 != parts.province.p
            || r.i16(H::Q)? as i32 != parts.province.q
            || r.u8(H::SITE)? != parts.site
        {
            return Err(BAD_ACCOUNT);
        }
        let off = H::transit(slot_index as usize);
        let marker =
            BridgeMarker::from_bytes(&ctx, hd.get(off..off + MARKER_LEN).ok_or(BAD_ACCOUNT)?)
                .map_err(|_| BAD_ACCOUNT)?;
        authenticate_pair(
            &ctx,
            &key(holding),
            slot_index,
            &key(external),
            &marker,
            bridge.common(),
        )
        .map_err(|_| BAD_ACCOUNT)?;
        hd[off..off + MARKER_LEN].fill(0);
        Some(hd)
    } else {
        None
    };
    Ok(TerminalRentOnly {
        holding_marker_clear,
        external: key(external),
        rent_to: t.rent_to,
        rent: external.lamports(),
    })
}

#[path = "wide_expedition_return_proof.rs"]
mod proof;

/// Private draft-wire route only. No public command parser or dispatcher
/// admits this operation. The proof child consumes exact roles and reopens
/// the original stored commitment before the existing settlement can write.
pub(super) fn settle_forfeit_draft(p: &Pubkey, a: &[AccountInfo], d: &[u8]) -> R<()> {
    proof::settle_forfeit_draft(p, a, d)
}

pub(super) fn settle_retained_failure_draft(p: &Pubkey, a: &[AccountInfo], d: &[u8]) -> R<()> {
    proof::settle_retained_failure_draft(p, a, d)
}

pub(super) fn settle_failure_draft(p: &Pubkey, a: &[AccountInfo], d: &[u8]) -> R<()> {
    proof::settle_failure_draft(p, a, d)
}

pub(super) fn settle_draft(p: &Pubkey, a: &[AccountInfo], d: &[u8]) -> R<()> {
    proof::settle_draft(p, a, d)
}

/// Camp-v2's isolated bytes route. Public dispatch remains closed.
pub(super) fn settle_camp_draft(p: &Pubkey, a: &[AccountInfo], d: &[u8]) -> R<()> {
    proof::settle_camp_draft(p, a, d)
}

#[path = "wide_expedition_terminal.rs"]
mod terminal;

/// Closed season-terminal rent-only cleanup. No live failure settlement,
/// seal verdict, forfeiture, escrow payout or public dispatch is implied.
pub(super) fn close_terminal_draft(p: &Pubkey, a: &[AccountInfo], d: &[u8]) -> R<()> {
    terminal::execute_draft(p, a, d)
}

#[cfg(test)]
#[path = "wide_expedition_return_tests.rs"]
pub(in crate::proc::wide) mod tests;

// Isolated unsigned test adapter only. No production API, dispatch or proof bypass.
#[cfg(all(
    test,
    feature = "runtime-contract-tests",
    feature = "public-proof-tests",
    feature = "system-cpi-tests",
    not(target_os = "solana")
))]
pub(super) fn runtime_settle(
    p: &Pubkey,
    a: &[AccountInfo],
    base: usize,
    slot: u8,
    commit: &[u8; 32],
    seal: &[u8; wseal::WIDE_SEAL_LEN],
) -> R<()> {
    proof::runtime_settle(p, a, base, slot, commit, seal)
}

/// Private reverse final-set consumer; no public instruction allocation.
pub(super) fn settle_reverse_draft(p: &Pubkey, a: &[AccountInfo], d: &[u8]) -> R<()> {
 proof::settle_reverse_draft(p,a,d)
}
