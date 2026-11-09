//! Private boundary Reveal producer. It authenticates the real route and
//! stages full-identity quota/day/slot output. Commit is available only through
//! dedicated private ExpeditionReveal input; public dispatch remains closed.
//! Explicit v2 transport retains the original owner and route wear. Host tests
//! execute existing-account writes, not creation CPI or payments.
use super::*;
use frontier_abi::v2::layout::AccountKind as K2;
use frontier_abi::world_index::expedition_bridge::{authenticate_pair, BridgeMarker, MARKER_LEN};
use frontier_abi::world_index::expedition_producer_event as producer;
use frontier_abi::world_index::expedition_transport::{
    ArrivalSlot, ExpeditionArrivalSlot, OwnedBridgeTransit,
};

pub(super) struct RevealPlan {
    pub slot: wa::WideArrivalSlot,
    pub expedition_slot: ExpeditionArrivalSlot,
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
pub(super) fn stage(p: &Pubkey, a: &[AccountInfo], x: &wix::Reveal) -> R<RevealPlan> {
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
    let bridge = OwnedBridgeTransit::from_bytes(&ctx, &external.try_borrow_data()?)
        .map_err(|_| BAD_ACCOUNT)?;
    let off = H::transit(x.transit_slot as usize);
    let marker =
        BridgeMarker::from_bytes(&ctx, &hd[off..off + MARKER_LEN]).map_err(|_| BAD_ACCOUNT)?;
    authenticate_pair(
        &ctx,
        &key(holding),
        x.transit_slot,
        &key(external),
        &marker,
        bridge.common(),
    )
    .map_err(|_| BAD_ACCOUNT)?;
    let t = bridge.transit();
    // V2 departure authenticated and retained the full original Citizen.
    // Capture cannot replace it with the captor or recover it from a short tag.
    // A same-generation disagreement is inconsistent program-owned state.
    let citizen = bridge.original_owner();
    if t.host.gen() == hr.u8(H::GEN)? && citizen != hr.arr::<32>(H::OWNER_CITIZEN)? {
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
    let dprov = canonical_province(dest_ai, p, &ctx, hdr.id, world_of(&ctx)?)?;
    if dprov.coord != dest.coord() || dprov.world != dest.world() {
        return Err(BAD_ACCOUNT);
    }
    let clock = SeasonClock::read(&season.try_borrow_data()?)?;
    let arrive = t.arrive_bell;
    expect_key(anchor, &ctx.bell_anchor(arrive, dprov.region))?;
    let part = archive_part_of(arrive);
    expect_key(archive, &ctx.anchor_archive(dprov.region, part))?;
    expect_key(log, &ctx.beacon_log(dprov.region))?;
    if prologue::presence(anchor, p, AccountKind::BellAnchor, hdr.id)? {
        let ad = anchor.try_borrow_data()?;
        let r = Ro(&ad);
        if r.u32(BA::BELL)? != arrive || r.u8(BA::REGION)? != dprov.region {
            return Err(BAD_ACCOUNT);
        }
        let at = r.i64(BA::A)?;
        if now.ts >= clock.reveal_close(arrive, at) {
            return Err(FrontierError::WindowClosed.into());
        }
        prologue::present(log, p, AccountKind::BeaconLog, hdr.id)?;
        let ld = log.try_borrow_data()?;
        let lr = Ro(&ld);
        if lr.u8(BL::REGION)? != dprov.region {
            return Err(BAD_ACCOUNT);
        }
        if lr.u64(BL::LATEST_ROUND)? >= clock.seed_round(arrive, at) {
            return Err(FrontierError::WindowClosed.into());
        }
    } else if prologue::presence(archive, p, AccountKind::AnchorArchive, hdr.id)? {
        let ad = archive.try_borrow_data()?;
        if archive_key(&ad)? != (dprov.region, part) {
            return Err(BAD_ACCOUNT);
        }
        if archive_tombstoned(&ad, arrive)? {
            return Err(FrontierError::Archived.into());
        }
    }
    expect_key(inputs, &wa::clash_inputs_address(&ctx, dest, arrive))?;
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
    let route = expedition_route::inspect(
        p,
        season,
        holding,
        external,
        x.transit_slot,
        &plain,
        &provinces,
    )?;
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
            &wa::arrival_slot_address(&ctx, dest, arrive, t.faction, i as u8),
        )?;
        if init::is_absent(ai) {
            continue;
        }
        if ai.owner != p {
            return Err(BAD_ACCOUNT);
        }
        let record = ArrivalSlot::read(&ctx, &ai.try_borrow_data()?).map_err(|_| BAD_ACCOUNT)?;
        let slot = record.common();
        if slot.season_id != hdr.id
            || slot.dest != dest
            || slot.bell != arrive
            || slot.faction != t.faction
            || slot.i != i as u8
        {
            return Err(BAD_ACCOUNT);
        }
        slots[i] = Some(WideSlotEntry {
            host: slot.host,
            citizen: slot.citizen,
            troops: slot.dep_mass,
        });
        rents[i] = Some(slot.rent_to);
    }
    let me = WideSlotEntry {
        host: t.host,
        citizen,
        troops: t.dep_mass,
    };
    let (i, displaced) = match wide_admit(dest, arrive, &slots, me) {
        WideSlotDecision::Refuse(SlotRefusal::AlreadyIn) => {
            return Err(FrontierError::AlreadyDone.into())
        }
        WideSlotDecision::Refuse(_) => return Err(FrontierError::QuotaRefused.into()),
        WideSlotDecision::Fill { slot } => (slot, false),
        WideSlotDecision::Displace { slot, .. } => (slot, true),
    };
    if i != x.target_i {
        return Err(FrontierError::SlotMoved.into());
    }
    let day = wa::day_of(arrive);
    expect_key(day_ai, &wa::arrival_day_address(&ctx, dest, day))?;
    let create_day = init::is_absent(day_ai);
    let mut day_record = if create_day {
        wa::WideArrivalDay::new(hdr.id, dest, day, key(payer))
    } else {
        if day_ai.owner != p {
            return Err(BAD_ACCOUNT);
        }
        let rec = wa::WideArrivalDay::read(&day_ai.try_borrow_data()?).map_err(|_| BAD_ACCOUNT)?;
        if rec.season_id != hdr.id || rec.dest != dest || rec.day != day {
            return Err(BAD_ACCOUNT);
        }
        rec
    };
    let write_day = !day_record.has(arrive);
    if write_day && !day_ai.is_writable {
        return Err(FrontierError::NeedArrivalDay.into());
    }
    let ev = evidence::read(ix_sysvar, now.slot)?;
    let stance = Stance::from_u8(plain.stance).ok_or(FrontierError::BadPlaintext)?;
    let doctrine = of_faction_v3(t.faction).ok_or(BAD_ACCOUNT)?;
    let create_slot = !displaced;
    let slot = wa::WideArrivalSlot {
        season_id: hdr.id,
        dest,
        bell: arrive,
        faction: t.faction,
        i,
        transit_slot: x.transit_slot,
        host: t.host,
        citizen,
        unit: t.unit,
        stance: plain.stance,
        tile: plain.dest_tile,
        retreat_bps: plain.retreat_bps,
        dealt_bps: hold::bps16(doctrine.dealt_bps(Posture::Stance(stance), true))?,
        dep_mass: t.dep_mass,
        flags: if create_day && create_slot {
            wa::wide_arrival_slot::FLAG_CREATED_DAY
        } else {
            0
        },
        beneficiary: x.beneficiary,
        rent_to: if displaced {
            rents[i as usize].ok_or(BAD_ACCOUNT)?
        } else {
            key(payer)
        },
        ev_slot: ev.slot,
        ev_price: ev.price,
        ev_limit: ev.limit,
        ev_loaded: ev.loaded,
        claimed: false,
    };
    let expedition_slot =
        ExpeditionArrivalSlot::new(&ctx, slot, route.wear_bps).map_err(|_| BAD_ACCOUNT)?;
    let slot_bytes = expedition_slot
        .to_bytes(&ctx)
        .map_err(|_| BAD_ACCOUNT)?
        .to_vec();
    if write_day && !day_record.set(arrive) {
        return Err(BAD_ACCOUNT);
    }
    let mut day_bytes = vec![0; wa::wide_arrival_day::SIZE];
    day_record.write(&mut day_bytes).map_err(|_| BAD_ACCOUNT)?;
    let rent_slot = init::rent(wa::wide_arrival_slot::SIZE)?;
    let rent_day = init::rent(wa::wide_arrival_day::SIZE)?;
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
        slot,
        expedition_slot,
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

/// Deliberate final refusal. Do not log WIDE_REVEALED as proof of mixed input
/// state: it carries no such manifest. No allocation, debit or byte write is
/// reachable until an independently allocated/verified receipt exists.
pub(super) fn execute(p: &Pubkey, a: &[AccountInfo], x: &wix::Reveal) -> R<()> {
    let _plan = stage(p, a, x)?;
    Err(FrontierError::NotImplemented.into())
}

pub(super) struct ProducerPlan {
    pub staged: RevealPlan,
    pub record: producer::Record,
    pub body: Vec<u8>,
    balances: [u64; 3], // payer, day, selected slot
    signer: SeasonSigner,
}

/// Full raw manifests are hashed while borrowed, without copying readonly
/// Province/archive buffers. The plan is not an authorization token; execution
/// prepares it again from authenticated live accounts within the same call.
pub(super) fn prepare_producer(
    p: &Pubkey,
    a: &[AccountInfo],
    x: &wix::ExpeditionReveal,
) -> R<ProducerPlan> {
    let common = wix::Reveal {
        transit_slot: x.transit_slot,
        target_i: x.target_i,
        plain: x.plain,
        salt: x.salt,
        ct_hash: x.ct_hash,
        beneficiary: x.beneficiary,
    };
    let staged = stage(p, a, &common)?;
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
        .map(|(i, (ai, bytes))| producer::AccountSnapshot {
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
    let si = wix::REVEAL_SLOT0 + staged.slot_index;
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
    let command = x.to_bytes();
    let context = producer::Context {
        command: &command,
        now_ts: now.ts,
        now_slot: now.slot,
        bell: bell_log(&hdr, now.ts),
        season: before[1].data,
        evidence: before[14].data,
    };
    let target = producer::Target::Reveal {
        destination: staged.slot.dest,
        identity: producer::RevealIdentity {
            host: staged.slot.host,
            original_owner: staged.slot.citizen,
            holding: key(&a[2]),
            external: key(&a[3]),
            transit_slot: x.transit_slot,
        },
    };
    let outcomes = producer::RevealOutcomes {
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
    };
    let record = producer::prepare(
        &ctx,
        target,
        &context,
        &before,
        &after,
        producer::Outcomes::Reveal(outcomes),
    )
    .map_err(|_| BAD_ACCOUNT)?;
    let body = record.encode(&ctx).map_err(|_| BAD_ACCOUNT)?;
    let balances = [after[0].lamports, after[9].lamports, after[si].lamports];
    Ok(ProducerPlan {
        staged,
        record,
        body,
        balances,
        signer: SeasonSigner::new(hdr.id, hdr.bump),
    })
}

/// Dedicated private producer only. All deterministic receipt/borrow/length
/// checks precede effects. System CPI failures rely on transaction rollback;
/// host tests exercise only already allocated records, without CPI stubs.
pub(super) fn execute_producer(p: &Pubkey, a: &[AccountInfo], x: &wix::ExpeditionReveal) -> R<()> {
    let plan = prepare_producer(p, a, x)?;
    let staged = &plan.staged;
    let payer = &a[0];
    let season = &a[1];
    let day = &a[9];
    let slot = &a[wix::REVEAL_SLOT0 + staged.slot_index];
    // All three keys must be distinct even if an account table's roles alias.
    if payer.key == day.key || payer.key == slot.key || day.key == slot.key {
        return Err(BAD_ACCOUNT);
    }
    {
        let dd = if staged.write_day {
            Some(day.try_borrow_mut_data()?)
        } else {
            None
        };
        let sd = slot.try_borrow_mut_data()?;
        if (!staged.create_slot && sd.len() != staged.slot_bytes.len())
            || (staged.write_day
                && !staged.create_day
                && dd.as_ref().unwrap().len() != staged.day_bytes.len())
        {
            return Err(BAD_ACCOUNT);
        }
        let _payer_balance = payer.try_borrow_mut_lamports()?;
        let _day_balance = day.try_borrow_mut_lamports()?;
        let _slot_balance = slot.try_borrow_mut_lamports()?;
    }
    if staged.create_day {
        init::init_with_seed(
            payer,
            day,
            season,
            &plan.signer,
            &wa::arrival_day_seed(staged.slot.dest, wa::day_of(staged.slot.bell)),
            wa::wide_arrival_day::SIZE,
            staged.rent_day,
            p,
        )?;
    }
    if staged.create_slot {
        init::init_with_seed(
            payer,
            slot,
            season,
            &plan.signer,
            &wa::arrival_slot_seed(
                staged.slot.dest,
                staged.slot.bell,
                staged.slot.faction,
                staged.slot_index as u8,
            ),
            wa::wide_arrival_slot::SIZE,
            staged.rent_slot,
            p,
        )?;
    }
    // Acquire both writable buffers before copying either. Verify actual CPI
    // outcomes; a no-op host CPI cannot masquerade as successful creation.
    let mut dd = if staged.write_day {
        Some(day.try_borrow_mut_data()?)
    } else {
        None
    };
    let mut sd = slot.try_borrow_mut_data()?;
    if day.owner != p
        || slot.owner != p
        || sd.len() != staged.slot_bytes.len()
        || dd
            .as_ref()
            .is_some_and(|d| d.len() != staged.day_bytes.len())
        || [payer.lamports(), day.lamports(), slot.lamports()] != plan.balances
    {
        return Err(BAD_ACCOUNT);
    }
    if let Some(ref mut d) = dd {
        d.copy_from_slice(&staged.day_bytes);
    }
    sd.copy_from_slice(&staged.slot_bytes);
    solana_program::log::sol_log_data(&[producer::PREFIX, &plan.body]);
    Ok(())
}

#[cfg(test)]
#[path = "wide_expedition_reveal_tests.rs"]
mod tests;
