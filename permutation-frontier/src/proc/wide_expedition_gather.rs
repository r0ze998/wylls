//! Private destination Gather staging and dedicated producer child.
//! Public dispatch stays closed; staging itself has no writes or seal verdict.
//! The private table deliberately adds the original Holding to every position.
//! Native v1 slots are discriminated and refused, never reinterpreted as v2.
//! Account ownership authenticates stored inputs, not proof of prior producer
//! execution: activation still needs reviewed atomic producers and receipts.
use super::*;
use crate::layout::holding2 as H2;
use frontier_abi::v2::layout::AccountKind as K2;
use frontier_abi::world_index::expedition::AccountResolver;
use frontier_abi::world_index::expedition_bridge::{authenticate_pair, BridgeMarker, MARKER_LEN};
use frontier_abi::world_index::expedition_transport::{
    ArrivalSlot, ExpeditionArrivalSlot, OwnedBridgeTransit,
};

// Same eight fixed positions, EXPLICITLY different per-position triples:
// payer(s,w), Season, destination, anchor/archive, inputs(w), day, ix, system;
// then n * [slot(r), original Holding(r), external bridge(w)]. No public ABI.
const TABLE: &[ap::Group] = &[
    wix::GATHER[0],
    ap::Group {
        specs: &[
            ap::Spec {
                name: "slot",
                acc: ap::Acc::Any,
                signer: false,
                wr: ap::Wr::R,
            },
            ap::Spec {
                name: "original_holding",
                acc: ap::Acc::Any,
                signer: false,
                wr: ap::Wr::R,
            },
            ap::Spec {
                name: "owned_bridge",
                acc: ap::Acc::Any,
                signer: false,
                wr: ap::Wr::Either,
            },
        ],
        min: 0,
        max: 24,
    },
];

pub(super) struct GatherPlan {
    inputs: Vec<u8>,
    /// Absolute account index and complete owned v2 bytes. Never committed.
    bridges: Vec<(usize, Vec<u8>)>,
    create_inputs: bool,
}

fn empty_arrival(s: &WideArrivalSlot) -> WideArrival {
    WideArrival {
        host: s.host,
        citizen: s.citizen,
        dep_mass: s.dep_mass,
        troops: 0,
        stamina: 0,
        retreat_bps: s.retreat_bps,
        dealt_bps: s.dealt_bps,
        faction: s.faction,
        unit: s.unit,
        tile: s.tile,
        stance: s.stance,
        present: false,
        fate: wa::wide_arrival::FATE_NONE,
        troops_after: 0,
    }
}

/// Preserve the deployed live/current-or-actual-PREV_GEN rule. A released,
/// missing or older-history issuer contributes metadata only, not the captor.
fn eligible(hd: &[u8], gen: u8) -> R<bool> {
    let r = Ro(hd);
    Ok(
        matches!(r.u8(H::STATE)?, H::STATE_PROVISIONAL | H::STATE_FINAL)
            && (r.u8(H::GEN)? == gen
                || (r.u8(H2::CAPTURE_FLAGS)? & H2::CAPTURE_FLAG_CAPTURED != 0
                    && r.u8(H2::PREV_GEN)? == gen)),
    )
}

fn arrival_for(s: &ExpeditionArrivalSlot, b: &OwnedBridgeTransit) -> R<WideArrival> {
    let t = b.transit();
    // Real SettleDeparture only emits Settled for >=500 survivors. Capped
    // wear cannot reduce that to zero. DestroyedAtOrigin emits exactly (0,0).
    // Hence zero Gathered troops are destroyed-origin, not stamina regeneration.
    // Still require the retained row on repeats; these invariants are not a
    // substitute for proof of atomic producer history.
    if t.stamina_after > 120 || (t.troops_after == 0 && t.stamina_after != 0) {
        return Err(BAD_ACCOUNT);
    }
    let mut a = empty_arrival(s.common());
    a.troops = t.troops_after;
    if a.troops != 0 {
        a.stamina = frontier_abi::clash_model::arrival_stamina(
            t.stamina_after,
            t.depart_bell,
            t.arrive_bell,
        );
    }
    a.present = a.troops >= DESTROYED_BELOW;
    if !a.present {
        a.fate = wa::wide_arrival::FATE_DESTROYED;
    }
    Ok(a)
}

#[allow(clippy::too_many_arguments)]
fn position(
    p: &Pubkey,
    ctx: &AddrCtx,
    sid: u64,
    s: &ExpeditionArrivalSlot,
    holding: &AccountInfo,
    external: &AccountInfo,
    old: Option<WideArrival>,
    scanned: bool,
) -> R<(WideArrival, Option<OwnedBridgeTransit>)> {
    let common = s.common();
    // ClaimDefence consumes refund entitlement only. It may happen before
    // Gather and must not change the combat arrival or repeat reconstruction.
    if common.season_id != sid || common.flags & wa::wide_arrival_slot::FLAG_SETTLED != 0 {
        return Err(BAD_ACCOUNT);
    }
    let resolver = AccountResolver::for_season(ctx).map_err(|_| BAD_ACCOUNT)?;
    let hk = resolver
        .holding_address(&common.host)
        .map_err(|_| BAD_ACCOUNT)?;
    expect_key(holding, &hk)?;
    if !prologue::presence_v2(holding, p, K2::Holding, sid)? {
        let a = empty_arrival(common);
        if scanned && old != Some(a) {
            return Err(BAD_ACCOUNT);
        }
        return Ok((a, None));
    }
    let hd = holding.try_borrow_data()?;
    let r = Ro(&hd);
    expect_key(
        holding,
        &ctx.holding(r.i16(H::P)? as i32, r.i16(H::Q)? as i32, r.u8(H::SITE)?),
    )?;
    if !eligible(&hd, common.host.gen())? {
        let a = empty_arrival(common);
        if scanned && old != Some(a) {
            return Err(BAD_ACCOUNT);
        }
        return Ok((a, None));
    }
    if external.owner != p {
        return Err(BAD_ACCOUNT);
    }
    let b = OwnedBridgeTransit::from_bytes(ctx, &external.try_borrow_data()?)
        .map_err(|_| BAD_ACCOUNT)?;
    let t = b.transit();
    let off = H::transit(common.transit_slot as usize);
    let m = BridgeMarker::from_bytes(ctx, hd.get(off..off + MARKER_LEN).ok_or(BAD_ACCOUNT)?)
        .map_err(|_| BAD_ACCOUNT)?;
    authenticate_pair(
        ctx,
        &hk,
        common.transit_slot,
        &key(external),
        &m,
        b.common(),
    )
    .map_err(|_| BAD_ACCOUNT)?;
    if t.host != common.host
        || common.citizen != b.original_owner()
        || t.march_stamina > 120
        || t.stamina_after > 120
        || t.dep_mass < DESTROYED_BELOW
    {
        return Err(BAD_ACCOUNT);
    }
    if r.u8(H::GEN)? == t.host.gen() {
        if b.original_owner() != r.arr::<32>(H::OWNER_CITIZEN)?
            || t.host.seq() >= r.u32(H::HOST_SEQ)?
        {
            return Err(BAD_ACCOUNT);
        }
    } else if frontier_abi::addr::citizen_tag(&b.original_owner()) != r.u64(H2::PREV_OWNER_TAG)? {
        return Err(BAD_ACCOUNT);
    }
    match t.state {
        MarchState::Departed => return Err(FrontierError::DepartureUnsettled.into()),
        MarchState::Settled if t.troops_after < DESTROYED_BELOW => return Err(BAD_ACCOUNT),
        MarchState::Gathered if !scanned || old.is_none() => return Err(BAD_ACCOUNT),
        MarchState::Free => return Err(BAD_ACCOUNT),
        _ => {}
    }
    // Checks every immutable producer pair field (but intentionally NOT the
    // departure Hold dealt multiplier). Wear operates on post-origin troops.
    let next = b.gather_worn(ctx, s).map_err(|_| BAD_ACCOUNT)?;
    let arrival = arrival_for(s, &next)?;
    if scanned {
        if old != Some(arrival) || t.state != MarchState::Gathered {
            return Err(BAD_ACCOUNT);
        }
        return Ok((arrival, None));
    }
    if !external.is_writable {
        return Err(BAD_ACCOUNT);
    }
    Ok((arrival, Some(next)))
}

pub(super) fn stage(p: &Pubkey, a: &[AccountInfo], x: &wix::Gather) -> R<GatherPlan> {
    if x.n == 0 || x.start as usize + x.n as usize > wa::wide_clash_inputs::POSITIONS {
        return Err(FrontierError::BadData.into());
    }
    check_accounts(TopLevelShape(TABLE), a, Some(&[1, x.n]))?;
    prologue::top_level(TopLevelShape(TABLE))?;
    if a.len() != 8 + 3 * x.n as usize {
        return Err(FrontierError::TooManyAccounts.into());
    }
    for (i, ai) in a.iter().enumerate() {
        if i != 0 && i != 4 && !(i >= 8 && (i - 8) % 3 == 2) && ai.is_writable {
            return Err(BAD_ACCOUNT);
        }
    }
    let now = prologue::now()?;
    let hdr = prologue::keeper(a, p, &[S::STATUS_RUNNING, S::STATUS_ENDED], now.ts)?;
    let [payer, season, province, anchor, inputs, day, ix, _, rest @ ..] = a else {
        return Err(BAD_ACCOUNT);
    };
    require_wide_season(season)?;
    let ctx = addr::ctx(&key(season), &p.to_bytes());
    let prov = canonical_province(province, p, &ctx, hdr.id, world_of(&ctx)?)?;
    let dest = ProvinceKey::new(prov.world, prov.coord);
    if x.bell < Ro(&province.try_borrow_data()?).u32(PV::RESOLVED_NEXT)? {
        return Err(FrontierError::LatchClosed.into());
    }
    if x.bell >= hdr.end_bell {
        return Err(FrontierError::WrongStatus.into());
    }
    let clock = SeasonClock::read(&season.try_borrow_data()?)?;
    crate::proc::clash::window_closed(
        p,
        &ctx,
        hdr.id,
        &clock,
        now.ts,
        x.bell,
        prov.region,
        anchor,
    )?;
    expect_key(inputs, &wa::clash_inputs_address(&ctx, dest, x.bell))?;
    let create_inputs = init::is_absent(inputs);
    let mut cd = if create_inputs {
        let ev = evidence::read(ix, now.slot)?;
        let mut h = WideClashInputsHdr::new(hdr.id, dest, x.bell, key(payer));
        h.ev_slot = ev.slot;
        h.ev_price = ev.price;
        h.ev_limit = ev.limit;
        let mut d = alloc::vec![0; wa::wide_clash_inputs::SIZE];
        h.write(&mut d).map_err(|_| BAD_ACCOUNT)?;
        d
    } else {
        if inputs.owner != p {
            return Err(BAD_ACCOUNT);
        }
        inputs.try_borrow_data()?.to_vec()
    };
    let mut h = WideClashInputsHdr::read(&cd).map_err(|_| BAD_ACCOUNT)?;
    if h.season_id != hdr.id || h.dest != dest || h.bell != x.bell {
        return Err(BAD_ACCOUNT);
    }
    if h.flags & wa::wide_clash_inputs::FLAG_RESOLVED != 0 {
        return Err(FrontierError::AlreadyDone.into());
    }
    if h.resolved_ts != 0
        || h.resolver != [0; 32]
        || h.camp_mask != 0
        || h.settled_mask != 0
        || h.posture_mask != 0
    {
        return Err(BAD_ACCOUNT);
    }
    let mut initial_present = 0;
    for k in 0..wa::wide_clash_inputs::POSITIONS {
        if let Some(row) = WideArrival::read_at(&cd, k).map_err(|_| BAD_ACCOUNT)? {
            if h.arrivals_mask & (1 << k) == 0 || row.troops_after != 0 {
                return Err(BAD_ACCOUNT);
            }
            if row.present {
                initial_present += 1;
            }
        }
    }
    if h.n_present != initial_present
        || (h.flags & wa::wide_clash_inputs::FLAG_NO_ARRIVALS != 0
            && (h.arrivals_mask != wa::wide_clash_inputs::ALL_GATHERED || initial_present != 0))
    {
        return Err(BAD_ACCOUNT);
    }
    let has_arrivals = arrival_day_bit(day, p, &ctx, hdr.id, dest, x.bell)?;
    let mut bridges = Vec::new();
    if !has_arrivals {
        // A clear day never erases already gathered evidence.
        for k in 0..wa::wide_clash_inputs::POSITIONS {
            if WideArrival::read_at(&cd, k)
                .map_err(|_| BAD_ACCOUNT)?
                .is_some()
            {
                return Err(BAD_ACCOUNT);
            }
        }
        h.arrivals_mask = wa::wide_clash_inputs::ALL_GATHERED;
    } else {
        for j in 0..x.n as usize {
            let k = x.start as usize + j;
            let f = (k / 4) as u8;
            let i = (k % 4) as u8;
            let slot = &rest[3 * j];
            expect_key(slot, &wa::arrival_slot_address(&ctx, dest, x.bell, f, i))?;
            let scanned = h.arrivals_mask & (1 << k) != 0;
            let old = WideArrival::read_at(&cd, k).map_err(|_| BAD_ACCOUNT)?;
            if !scanned && old.is_some() {
                return Err(BAD_ACCOUNT);
            }
            if init::is_absent(slot) {
                if old.is_some() {
                    return Err(BAD_ACCOUNT);
                }
            } else {
                if slot.owner != p {
                    return Err(BAD_ACCOUNT);
                }
                let s = match ArrivalSlot::read(&ctx, &slot.try_borrow_data()?)
                    .map_err(|_| BAD_ACCOUNT)?
                {
                    ArrivalSlot::Expedition(s) => s,
                    ArrivalSlot::Native(_) => return Err(FrontierError::NotImplemented.into()),
                };
                let c = s.common();
                if c.season_id != hdr.id
                    || c.dest != dest
                    || c.bell != x.bell
                    || c.faction != f
                    || c.i != i
                {
                    return Err(BAD_ACCOUNT);
                }
                let (row, next) = position(
                    p,
                    &ctx,
                    hdr.id,
                    &s,
                    &rest[3 * j + 1],
                    &rest[3 * j + 2],
                    old,
                    scanned,
                )?;
                row.write_at(&mut cd, k).map_err(|_| BAD_ACCOUNT)?;
                if let Some(b) = next {
                    bridges.push((8 + 3 * j + 2, b.to_bytes().to_vec()));
                }
            }
            h.arrivals_mask |= 1 << k;
        }
    }
    h.n_present = 0;
    let mut seen = Vec::new();
    for k in 0..wa::wide_clash_inputs::POSITIONS {
        if let Some(row) = WideArrival::read_at(&cd, k).map_err(|_| BAD_ACCOUNT)? {
            if h.arrivals_mask & (1 << k) == 0 {
                return Err(BAD_ACCOUNT);
            }
            if seen.contains(&row.host) {
                return Err(BAD_ACCOUNT);
            }
            seen.push(row.host);
            if row.present {
                h.n_present += 1;
            }
        }
    }
    h.flags &= !wa::wide_clash_inputs::FLAG_NO_ARRIVALS;
    if h.arrivals_mask == wa::wide_clash_inputs::ALL_GATHERED && h.n_present == 0 {
        h.flags |= wa::wide_clash_inputs::FLAG_NO_ARRIVALS;
    }
    h.write(&mut cd).map_err(|_| BAD_ACCOUNT)?;
    Ok(GatherPlan {
        inputs: cd,
        bridges,
        create_inputs,
    })
}

pub(super) fn execute(p: &Pubkey, a: &[AccountInfo], x: &wix::Gather) -> R<()> {
    let _ = stage(p, a, x)?;
    Err(FrontierError::NotImplemented.into())
}

#[cfg(test)]
#[path = "wide_expedition_gather_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "wide_expedition_destination_tests.rs"]
mod destination_tests;

/// Dedicated private writer; no public dispatch admission.
#[path = "wide_expedition_gather_exec.rs"]
mod exec;
