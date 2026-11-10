//! Private reverse Reveal: real original ArrivalSlot/ArrivalDay writes.
//! Original four-slot quota and original short-header accounts are shared.
//! The reverse transport and original Holding remain byte-for-byte unchanged.
//! No public command, gate or successful seal proof is introduced.
use super::*;
use crate::layout::init_header;
use frontier_abi::layout::clash::{arrival_day as AD, arrival_slot as AS};
use frontier_abi::v2::layout::AccountKind as K2;
use frontier_abi::world_index::expedition::AccountResolver;
use frontier_abi::world_index::expedition_event::AccountSnapshot;
use frontier_abi::world_index::expedition_reverse_reveal::{self as wire, ReverseReveal};
use frontier_abi::world_index::expedition_reverse_transport::{
    authenticate_pair, ReverseMarker, ReverseTransit, MARKER_LEN,
};
use permutation_rules::frontier::clash::{admit_arrival, SlotDecision, SlotEntry};

pub(super) struct RevealPlan {
    pub dest: ProvinceKey,
    pub arrive: u32,
    pub faction: u8,
    pub slot_bytes: Vec<u8>,
    pub day_bytes: Vec<u8>,
    pub slot_index: usize,
    pub create_slot: bool,
    pub create_day: bool,
    pub write_day: bool,
    pub rent_slot: u64,
    pub rent_day: u64,
    pub payer_debit: u64,
    pub route: expedition_route::RouteCost,
}

/// Private typed input only, never the existing public WideReveal dispatcher.
/// Uses its exact16+path account shape/privileges and the real fee evidence.
/// No signature, oracle or witness override is accepted.
pub(super) fn stage(p: &Pubkey, a: &[AccountInfo], x: &ReverseReveal) -> R<RevealPlan> {
    ReverseReveal::decode(&x.to_bytes()).ok_or(FrontierError::BadData)?;
    let n_path = a
        .len()
        .checked_sub(wix::REVEAL_FIXED)
        .ok_or(FrontierError::TooManyAccounts)?;
    if n_path + 1 > MAX_PATH_PROVINCES {
        return Err(FrontierError::TooManyAccounts.into());
    }
    check_accounts(TopLevelShape(wix::REVEAL), a, Some(&[1, n_path as u8]))?;
    prologue::top_level(TopLevelShape(wix::REVEAL))?;
    if x.target_i >= 4 || x.transit_slot as usize >= H::TRANSIT_N {
        return Err(FrontierError::BadData.into());
    }
    for i in 0..4 {
        if a[wix::REVEAL_SLOT0 + i].is_writable != (i == x.target_i as usize) {
            return Err(BAD_ACCOUNT);
        }
    }
    // Acc::Any cannot enforce the declared read-only lock by itself. Match
    // Reveal's documented shape explicitly for all nonpayer/day/selected-slot
    // inputs, including the legacy family and beacon/evidence accounts.
    for (i, ai) in a.iter().enumerate() {
        if i != 0
            && i != wix::REVEAL_DAY
            && i != wix::REVEAL_SLOT0 + x.target_i as usize
            && ai.is_writable
        {
            return Err(BAD_ACCOUNT);
        }
    }
    let [payer, season, holding, external, anchor, archive, log, inputs, dest_ai, day_ai, s0, s1, s2, s3, ix_sysvar, _, path @ ..] =
        a
    else {
        return Err(FrontierError::TooManyAccounts.into());
    };
    let now = prologue::now()?;
    let hdr = prologue::keeper(a, p, &[S::STATUS_RUNNING, S::STATUS_ENDED], now.ts)?;
    require_wide_season(season)?;
    let ctx = addr::ctx(&key(season), &p.to_bytes());
    prologue::present_v2(holding, p, K2::Holding, hdr.id)?;
    let hd = holding.try_borrow_data()?;
    let hr = Ro(&hd);
    expect_key(
        holding,
        &ctx.holding(hr.i16(H::P)? as i32, hr.i16(H::Q)? as i32, hr.u8(H::SITE)?),
    )?;
    if external.owner != p {
        return Err(BAD_ACCOUNT);
    }
    let bridge =
        ReverseTransit::from_bytes(&ctx, &external.try_borrow_data()?).map_err(|_| BAD_ACCOUNT)?;
    let off = H::transit(x.transit_slot as usize);
    let marker =
        ReverseMarker::from_bytes(&ctx, &hd[off..off + MARKER_LEN]).map_err(|_| BAD_ACCOUNT)?;
    authenticate_pair(
        &ctx,
        &key(holding),
        x.transit_slot,
        &key(external),
        &marker,
        &bridge,
    )
    .map_err(|_| BAD_ACCOUNT)?;
    let t = bridge.transit();
    // V2 departure authenticated and retained the full original Citizen.
    // Capture cannot replace it with the captor or recover it from a short tag.
    // A same-generation disagreement is inconsistent program-owned state.
    let citizen = bridge.original_owner();
    let resolver = AccountResolver::for_season(&ctx).map_err(|_| BAD_ACCOUNT)?;
    let host_id = resolver.legacy_host_id(&t.host).map_err(|_| BAD_ACCOUNT)?;
    if t.state == MarchState::Gathered {
        return Err(FrontierError::LatchClosed.into());
    }
    if t.host.gen() != hr.u8(H::GEN)?
        || citizen != hr.arr::<32>(H::OWNER_CITIZEN)?
        || t.host.seq() >= hr.u32(H::HOST_SEQ)?
        || !matches!(hr.u8(H::STATE)?, H::STATE_FINAL | H::STATE_PROVISIONAL)
    {
        return Err(BAD_ACCOUNT);
    }
    if hdr.status == S::STATUS_ENDED && t.arrive_bell >= hdr.end_bell {
        return Err(FrontierError::WrongStatus.into());
    }
    let plain = wseal::unpack(&x.plain).map_err(|_| FrontierError::BadPlaintext)?;
    wseal::validate(&plain, &t.host, t.arrive_bell).map_err(|_| FrontierError::BadPlaintext)?;
    let commit = wseal::commit(&x.plain, &x.salt);
    if wseal::seal_root(&commit, &x.ct_hash) != t.seal_root {
        return Err(FrontierError::CommitMismatch.into());
    }
    let dest = plain.dest;
    if dest != bridge.destination() {
        return Err(FrontierError::BadPlaintext.into());
    }
    let coord = resolver
        .adapter()
        .coord_of(&dest)
        .map_err(|_| BAD_ACCOUNT)?;
    expect_key(dest_ai, &ctx.province(coord.p, coord.q))?;
    prologue::present_v2(dest_ai, p, K2::Province, hdr.id)?;
    let dp = coord.p as i16;
    let dq = coord.q as i16;
    let region = permutation_rules::frontier::geometry::region_of(coord);
    {
        let pd = dest_ai.try_borrow_data()?;
        if Ro(&pd).i16(PV::P)? != dp || Ro(&pd).i16(PV::Q)? != dq {
            return Err(BAD_ACCOUNT);
        }
    }
    let clock = SeasonClock::read(&season.try_borrow_data()?)?;
    let arrive = t.arrive_bell;
    expect_key(anchor, &ctx.bell_anchor(arrive, region))?;
    let part = archive_part_of(arrive);
    expect_key(archive, &ctx.anchor_archive(region, part))?;
    expect_key(log, &ctx.beacon_log(region))?;
    if prologue::presence(anchor, p, AccountKind::BellAnchor, hdr.id)? {
        let ad = anchor.try_borrow_data()?;
        let r = Ro(&ad);
        if r.u32(BA::BELL)? != arrive || r.u8(BA::REGION)? != region {
            return Err(BAD_ACCOUNT);
        }
        let at = r.i64(BA::A)?;
        if now.ts >= clock.reveal_close(arrive, at) {
            return Err(FrontierError::WindowClosed.into());
        }
        prologue::present(log, p, AccountKind::BeaconLog, hdr.id)?;
        let ld = log.try_borrow_data()?;
        let lr = Ro(&ld);
        if lr.u8(BL::REGION)? != region {
            return Err(BAD_ACCOUNT);
        }
        if lr.u64(BL::LATEST_ROUND)? >= clock.seed_round(arrive, at) {
            return Err(FrontierError::WindowClosed.into());
        }
    } else if prologue::presence(archive, p, AccountKind::AnchorArchive, hdr.id)? {
        let ad = archive.try_borrow_data()?;
        if archive_key(&ad)? != (region, part) {
            return Err(BAD_ACCOUNT);
        }
        if archive_tombstoned(&ad, arrive)? {
            return Err(FrontierError::Archived.into());
        }
    }
    expect_key(inputs, &ctx.clash_inputs(coord.p, coord.q, arrive))?;
    if !init::is_absent(inputs) {
        return Err(FrontierError::LatchClosed.into());
    }
    let pd = dest_ai.try_borrow_data()?;
    let dr = Ro(&pd);
    if dr.u32(PV::RESOLVED_NEXT)? > arrive {
        return Err(FrontierError::LatchClosed.into());
    }
    let n = dr.u8(PV::SITE_COUNT)? as usize;
    if n > PV::SITES_N {
        return Err(BAD_ACCOUNT);
    }
    let sites: [u8; PV::SITES_N] = dr.arr(PV::SITES)?;
    let target = sites
        .iter()
        .take(n)
        .position(|&tile| tile == plain.dest_tile);
    let mut provinces = Vec::with_capacity(1 + n_path);
    provinces.push(dest_ai.clone());
    provinces.extend_from_slice(path);
    let route = expedition_route::inspect_reverse(p, season, holding, &bridge, &plain, &provinces)?;
    // Preserve quota mass unchanged; explicit slot v2 carries wear for the
    // authenticated first gather to apply to actual post-origin survivors.
    if let Some(site) = target {
        let at = PV::site(site);
        let other =
            dr.u8(at + SM::STATE)? == SM::STATE_HOLDING && dr.u8(at + SM::FACTION)? != t.faction;
        if other && dr.u32(at + SM::SHIELD_UNTIL_BELL)? > arrive {
            return Err(FrontierError::Shielded.into());
        }
        let own_shielded = hr.u8(H::FLAGS)? & H::FLAG_DORMANT_CACHE == 0
            && hr.i64(H::SHIELD_UNTIL)?
                > permutation_rules::frontier::beacon::bell_start(hdr.genesis_ts, arrive);
        if other && own_shielded {
            return Err(FrontierError::Shielded.into());
        }
    }
    let slots_ai = [s0, s1, s2, s3];
    let mut slots = [None; 4];
    let mut rents = [None; 4];
    for (i, ai) in slots_ai.iter().enumerate() {
        expect_key(
            ai,
            &ctx.arrival_slot(coord.p, coord.q, arrive, t.faction, i as u8),
        )?;
        if init::is_absent(ai) {
            continue;
        }
        prologue::present_v2(ai, p, K2::ArrivalSlot, hdr.id)?;
        let data = ai.try_borrow_data()?;
        let r = Ro(&data);
        if data.len() != AS::SIZE
            || r.i16(AS::P)? != dp
            || r.i16(AS::Q)? != dq
            || r.u32(AS::BELL)? != arrive
            || r.u8(AS::FACTION)? != t.faction
            || r.u8(AS::I)? != i as u8
        {
            return Err(BAD_ACCOUNT);
        }
        slots[i] = Some(SlotEntry {
            host_id: r.u64(AS::HOST_ID)?,
            citizen: r.u64(AS::CITIZEN_TAG)?,
            troops: r.u32(AS::DEP_MASS)?,
        });
        rents[i] = Some(r.arr::<32>(AS::RENT_TO)?);
    }
    let me = SlotEntry {
        host_id,
        citizen: addr::citizen_tag(&citizen),
        troops: t.dep_mass,
    };
    let (i, displaced) = match admit_arrival(coord, arrive, &slots, me) {
        SlotDecision::Refuse(SlotRefusal::AlreadyIn) => {
            return Err(FrontierError::AlreadyDone.into())
        }
        SlotDecision::Refuse(_) => return Err(FrontierError::QuotaRefused.into()),
        SlotDecision::Fill { slot } => (slot, false),
        SlotDecision::Displace { slot, .. } => (slot, true),
    };
    if i != x.target_i {
        return Err(FrontierError::SlotMoved.into());
    }
    let day = frontier_abi::addr::day_of(arrive);
    expect_key(day_ai, &ctx.arrival_day(coord.p, coord.q, day))?;
    let create_day = init::is_absent(day_ai);
    let mut day_bytes = if create_day {
        let mut bytes = vec![0; AD::SIZE];
        init_header(&mut bytes, AccountKind::ArrivalDay, hdr.id)?;
        let mut w = Rw(&mut bytes);
        w.set_i16(AD::P, dp)?;
        w.set_i16(AD::Q, dq)?;
        w.set_u32(AD::DAY, day)?;
        w.set_arr(AD::RENT_TO, &key(payer))?;
        bytes
    } else {
        prologue::present_v2(day_ai, p, K2::ArrivalDay, hdr.id)?;
        let data = day_ai.try_borrow_data()?;
        let r = Ro(&data);
        if data.len() != AD::SIZE
            || r.i16(AD::P)? != dp
            || r.i16(AD::Q)? != dq
            || r.u32(AD::DAY)? != day
        {
            return Err(BAD_ACCOUNT);
        }
        data.to_vec()
    };
    let (bit_at, mask) = AD::bit(arrive);
    let write_day = day_bytes[bit_at] & mask == 0;
    if write_day && !day_ai.is_writable {
        return Err(FrontierError::NeedArrivalDay.into());
    }
    day_bytes[bit_at] |= mask;
    let ev = evidence::read(ix_sysvar, now.slot)?;
    let stance = Stance::from_u8(plain.stance).ok_or(FrontierError::BadPlaintext)?;
    let doctrine = of_faction_v3(t.faction).ok_or(BAD_ACCOUNT)?;
    let create_slot = !displaced;
    let mut slot_bytes = vec![0; AS::SIZE];
    init_header(&mut slot_bytes, AccountKind::ArrivalSlot, hdr.id)?;
    let mut w = Rw(&mut slot_bytes);
    w.set_i16(AS::P, dp)?;
    w.set_i16(AS::Q, dq)?;
    w.set_u32(AS::BELL, arrive)?;
    w.set_u8(AS::FACTION, t.faction)?;
    w.set_u8(AS::I, i)?;
    w.set_u8(AS::UNIT, t.unit)?;
    w.set_u8(AS::STANCE, plain.stance)?;
    w.set_u8(AS::TILE, plain.dest_tile)?;
    w.set_u16(AS::RETREAT_BPS, plain.retreat_bps)?;
    w.set_u64(AS::HOST_ID, host_id)?;
    w.set_u64(AS::CITIZEN_TAG, addr::citizen_tag(&citizen))?;
    w.set_u32(AS::DEP_MASS, t.dep_mass)?;
    w.set_u16(
        AS::DEALT_BPS,
        hold::bps16(doctrine.dealt_bps(Posture::Stance(stance), true))?,
    )?;
    w.set_u16(
        frontier_abi::v2::layout::s1::arrival::WORN_BPS,
        route.wear_bps,
    )?;
    w.set_u8(
        AS::FLAGS,
        if write_day && create_slot {
            AS::FLAG_CREATED_DAY
        } else {
            0
        },
    )?;
    w.set_arr(AS::BENEFICIARY, &x.beneficiary)?;
    w.set_arr(
        AS::RENT_TO,
        &if displaced {
            rents[i as usize].ok_or(BAD_ACCOUNT)?
        } else {
            key(payer)
        },
    )?;
    w.set_u64(AS::EV_SLOT, ev.slot)?;
    w.set_u64(AS::EV_PRICE, ev.price)?;
    w.set_u32(AS::EV_LIMIT, ev.limit)?;
    w.set_u32(AS::EV_LOADED, ev.loaded)?;
    let rent_slot = init::rent(AS::SIZE)?;
    let rent_day = init::rent(AD::SIZE)?;
    let payer_debit = (if create_slot {
        rent_slot.saturating_sub(slots_ai[i as usize].lamports())
    } else {
        0
    })
    .checked_add(if create_day {
        rent_day.saturating_sub(day_ai.lamports())
    } else {
        0
    })
    .ok_or(OVERFLOW)?;
    if payer.lamports() < payer_debit {
        return Err(FrontierError::Insufficient.into());
    }
    if payer_debit != 0 && !init::is_absent(payer) {
        return Err(BAD_ACCOUNT);
    }
    Ok(RevealPlan {
        dest,
        arrive,
        faction: t.faction,
        slot_bytes,
        day_bytes,
        slot_index: i as usize,
        create_slot,
        create_day,
        write_day,
        rent_slot,
        rent_day,
        payer_debit,
        route,
    })
}

pub(super) struct ProducerPlan {
    pub staged: RevealPlan,
    pub receipt: wire::Receipt,
    balances: [u64; 3],
    signer: SeasonSigner,
}

pub(super) fn prepare_producer(
    p: &Pubkey,
    a: &[AccountInfo],
    x: &ReverseReveal,
) -> R<ProducerPlan> {
    let staged = stage(p, a, x)?;
    let si = wix::REVEAL_SLOT0 + staged.slot_index;
    // No mutation may alias another role, including host-side AccountInfo cells
    // carrying an unrelated key. All refusal checks precede creation/writeback.
    for i in [0, 9, si] {
        for (j, ai) in a.iter().enumerate() {
            if i != j
                && (a[i].key == ai.key
                    || alloc::rc::Rc::ptr_eq(&a[i].data, &ai.data)
                    || alloc::rc::Rc::ptr_eq(&a[i].lamports, &ai.lamports))
            {
                return Err(BAD_ACCOUNT);
            }
        }
    }
    let now = prologue::now()?;
    let hdr = prologue::keeper(a, p, &[S::STATUS_RUNNING, S::STATUS_ENDED], now.ts)?;
    let ctx = addr::ctx(&key(&a[1]), &p.to_bytes());
    let data = a
        .iter()
        .map(|ai| ai.try_borrow_data())
        .collect::<Result<Vec<_>, _>>()?;
    let before = a
        .iter()
        .zip(data.iter())
        .enumerate()
        .map(|(i, (ai, bytes))| AccountSnapshot {
            role: (i + 1) as u16,
            address: key(ai),
            owner: ai.owner.to_bytes(),
            present: !init::is_absent(ai),
            signer: ai.is_signer,
            writable: ai.is_writable,
            lamports: ai.lamports(),
            data: &bytes[..],
        })
        .collect::<Vec<_>>();
    let paid_day = if staged.create_day {
        staged.rent_day.saturating_sub(before[9].lamports)
    } else {
        0
    };
    let paid_slot = if staged.create_slot {
        staged.rent_slot.saturating_sub(before[si].lamports)
    } else {
        0
    };
    let mut after = before.clone();
    after[0].lamports = before[0]
        .lamports
        .checked_sub(staged.payer_debit)
        .ok_or(OVERFLOW)?;
    after[9].lamports = before[9].lamports.checked_add(paid_day).ok_or(OVERFLOW)?;
    after[si].lamports = before[si].lamports.checked_add(paid_slot).ok_or(OVERFLOW)?;
    if staged.create_day {
        after[9].owner = p.to_bytes();
        after[9].present = true;
    }
    if staged.create_slot {
        after[si].owner = p.to_bytes();
        after[si].present = true;
    }
    if staged.write_day {
        after[9].data = &staged.day_bytes;
    }
    after[si].data = &staged.slot_bytes;
    use frontier_abi::world_index::expedition_producer_event::{Outcomes, RevealOutcomes};
    let outcomes = Outcomes::Reveal(RevealOutcomes {
        raw_secs: staged.route.raw_secs,
        watched_secs: staged.route.watched_secs,
        travel_secs: staged.route.travel_secs,
        wear_bps: staged.route.wear_bps,
        target_i: staged.slot_index as u8,
        create_slot: staged.create_slot,
        create_day: staged.create_day,
        write_day: staged.write_day,
        displaced: !staged.create_slot,
        rent_slot: staged.rent_slot,
        rent_day: staged.rent_day,
        paid_slot,
        paid_day,
        payer_debit: staged.payer_debit,
    })
    .encode()
    .map_err(|_| BAD_ACCOUNT)?;
    let receipt = wire::Receipt {
        input: wire::manifest_digest(&ctx, x, now.ts, now.slot, &before, None)
            .ok_or(BAD_ACCOUNT)?,
        output: wire::manifest_digest(&ctx, x, now.ts, now.slot, &after, Some(&outcomes))
            .ok_or(BAD_ACCOUNT)?,
    };
    let balances = [after[0].lamports, after[9].lamports, after[si].lamports];
    Ok(ProducerPlan {
        staged,
        receipt,
        balances,
        signer: SeasonSigner::new(hdr.id, hdr.bump),
    })
}

/// Creation uses real init_with_seed CPI; existing-account writes execute on
/// native AccountInfo. A no-op host CPI cannot count as successful creation.
/// On-chain CPI failures rely on transaction rollback. No test signs a seal.
pub(super) fn execute_producer(p: &Pubkey, a: &[AccountInfo], x: &ReverseReveal) -> R<()> {
    let plan = prepare_producer(p, a, x)?;
    let s = &plan.staged;
    let payer = &a[0];
    let season = &a[1];
    let day = &a[9];
    let slot = &a[wix::REVEAL_SLOT0 + s.slot_index];
    let coord = AccountResolver::for_season(&addr::ctx(&key(season), &p.to_bytes()))
        .map_err(|_| BAD_ACCOUNT)?
        .adapter()
        .coord_of(&s.dest)
        .map_err(|_| BAD_ACCOUNT)?;
    {
        let dd = if s.write_day {
            Some(day.try_borrow_mut_data()?)
        } else {
            None
        };
        let sd = slot.try_borrow_mut_data()?;
        if (!s.create_slot && sd.len() != AS::SIZE)
            || (s.write_day && !s.create_day && dd.as_ref().unwrap().len() != AD::SIZE)
        {
            return Err(BAD_ACCOUNT);
        }
        let _pb = payer.try_borrow_mut_lamports()?;
        let _db = day.try_borrow_mut_lamports()?;
        let _sb = slot.try_borrow_mut_lamports()?;
    }
    if s.create_day {
        init::init_with_seed(
            payer,
            day,
            season,
            &plan.signer,
            &frontier_abi::addr::arrival_day_seed(
                coord.p,
                coord.q,
                frontier_abi::addr::day_of(s.arrive),
            ),
            AD::SIZE,
            s.rent_day,
            p,
        )?;
    }
    if s.create_slot {
        init::init_with_seed(
            payer,
            slot,
            season,
            &plan.signer,
            &frontier_abi::addr::arrival_slot_seed(
                coord.p,
                coord.q,
                s.arrive,
                s.faction,
                s.slot_index as u8,
            ),
            AS::SIZE,
            s.rent_slot,
            p,
        )?;
    }
    let mut dd = if s.write_day {
        Some(day.try_borrow_mut_data()?)
    } else {
        None
    };
    let mut sd = slot.try_borrow_mut_data()?;
    if day.owner != p
        || slot.owner != p
        || sd.len() != AS::SIZE
        || dd.as_ref().is_some_and(|d| d.len() != AD::SIZE)
        || [payer.lamports(), day.lamports(), slot.lamports()] != plan.balances
    {
        return Err(BAD_ACCOUNT);
    }
    if let Some(ref mut d) = dd {
        d.copy_from_slice(&s.day_bytes);
    }
    sd.copy_from_slice(&s.slot_bytes);
    solana_program::log::sol_log_data(&[wire::PREFIX, &plan.receipt.to_bytes()]);
    Ok(())
}

#[cfg(test)]
#[path = "wide_expedition_reverse_reveal_tests.rs"]
mod tests;
