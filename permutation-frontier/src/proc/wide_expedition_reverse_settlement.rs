//! Private reverse final settlement. Actual wide seal proof, original final
//! set and original economics. All effects stage before any native writeback.
use super::*;
use frontier_abi::layout::clash::{arrival as AR, arrival_slot as AS, clash_inputs as CI};
use frontier_abi::log::EntityKind;
use frontier_abi::v2::layout::AccountKind as K2;
use frontier_abi::world_index::expedition_reverse_transport::{
    authenticate_pair, ReverseMarker, ReverseTransit, MARKER_LEN,
};
use frontier_abi::world_index::{
    expedition_reverse_settlement_event as event, expedition_reverse_settlement_ix as ix,
};

fn snapshot_reverse(a: &[AccountInfo]) -> R<Vec<Snapshot>> {
    for (i, ai) in a.iter().enumerate() {
        if ai.executable {
            return Err(BAD_ACCOUNT);
        }
        for (j, aj) in a[..i].iter().enumerate() {
            let same = ai.key == aj.key;
            if same != Rc::ptr_eq(&ai.data, &aj.data)
                || same != Rc::ptr_eq(&ai.lamports, &aj.lamports)
            {
                return Err(BAD_ACCOUNT);
            }
            let structural = |n| n < 7 || n == 8 || n == 14;
            let exclusive = |n| matches!(n, 0 | 2 | 6 | 8 | 14);
            if same
                && (ai.owner != aj.owner
                    || ai.is_signer != aj.is_signer
                    || ai.is_writable != aj.is_writable
                    || exclusive(i)
                    || exclusive(j)
                    || (structural(i) && structural(j) && (j, i) != (3, 4)))
            {
                return Err(BAD_ACCOUNT);
            }
        }
    }
    a.iter()
        .map(|a| {
            Ok(Snapshot {
                address: key(a),
                owner: a.owner.to_bytes(),
                present: !init::is_absent(a),
                signer: a.is_signer,
                writable: a.is_writable,
                lamports: a.try_lamports()?,
                data: a.try_borrow_data()?.to_vec(),
            })
        })
        .collect()
}

pub(in super::super) fn execute_draft(p: &Pubkey, a: &[AccountInfo], d: &[u8]) -> R<()> {
    let x = ix::DraftCommand::decode(d)?;
    if a.len() != ix::ACCOUNT_COUNT {
        return Err(FrontierError::TooManyAccounts.into());
    }
    for (i, a) in a.iter().enumerate() {
        let spec = ix::spec(i).ok_or(BAD_ACCOUNT)?;
        if (spec.signer && !a.is_signer) || (spec.wr == ap::Wr::W && !a.is_writable) {
            return Err(BAD_ACCOUNT);
        }
    }
    let before = snapshot_reverse(a)?;
    let now = prologue::now()?;
    let hdr = settle_season(&a[0], p, now.ts)?;
    let bell = hdr.bell(now.ts).ok_or(FrontierError::WrongStatus)?;
    let ctx = addr::ctx(&before[0].address, &p.to_bytes());
    let resolver = AccountResolver::for_season(&ctx).map_err(|_| BAD_ACCOUNT)?;
    prologue::present_v2(&a[1], p, K2::Holding, hdr.id)?;
    if a[2].owner != p {
        return Err(BAD_ACCOUNT);
    }
    let reverse = ReverseTransit::from_bytes(&ctx, &before[2].data).map_err(|_| BAD_ACCOUNT)?;
    let t = reverse.transit();
    if t.state != MarchState::Gathered || t.arrive_bell >= hdr.end_bell {
        return Err(FrontierError::TransitState.into());
    }
    let offset = H::transit(x.slot() as usize);
    let marker = ReverseMarker::from_bytes(
        &ctx,
        before[1]
            .data
            .get(offset..offset + MARKER_LEN)
            .ok_or(BAD_ACCOUNT)?,
    )
    .map_err(|_| BAD_ACCOUNT)?;
    authenticate_pair(
        &ctx,
        &before[1].address,
        x.slot(),
        &before[2].address,
        &marker,
        &reverse,
    )
    .map_err(|_| BAD_ACCOUNT)?;
    let id = resolver.legacy_host_id(&t.host).map_err(|_| BAD_ACCOUNT)?;
    let hr = Ro(&before[1].data);
    expect_key(
        &a[1],
        &resolver.holding_address(&t.host).map_err(|_| BAD_ACCOUNT)?,
    )?;
    crate::proc::conquest::check_source_province(p, &ctx, hdr.id, &a[1], &a[3])?;
    if t.host.gen() != hr.u8(H::GEN)?
        || t.host.seq() >= hr.u32(H::HOST_SEQ)?
        || reverse.original_owner() != hr.arr::<32>(H::OWNER_CITIZEN)?
        || !matches!(hr.u8(H::STATE)?, H::STATE_FINAL | H::STATE_PROVISIONAL)
    {
        return Err(BAD_ACCOUNT);
    }
    expect_key(&a[7], &t.rent_to)?;
    expect_key(&a[12], &hr.arr::<32>(H::RENT_PAYER)?)?;
    expect_key(&a[14], &reverse.original_owner())?;
    let dest = reverse.destination();
    let coord = resolver
        .adapter()
        .coord_of(&dest)
        .map_err(|_| BAD_ACCOUNT)?;
    expect_key(&a[4], &ctx.province(coord.p, coord.q))?;
    prologue::present_v2(&a[4], p, K2::Province, hdr.id)?;
    let dr = Ro(&before[4].data);
    if dr.i16(PV::P)? as i32 != coord.p || dr.i16(PV::Q)? as i32 != coord.q {
        return Err(BAD_ACCOUNT);
    }
    let clock = SeasonClock::read(&before[0].data)?;
    let region = permutation_rules::frontier::geometry::region_of(coord);
    let src = the_anchor_or_archive(p, &ctx, hdr.id, &a[8], t.arrive_bell, region, &clock)?;
    let close = clock.reveal_close(t.arrive_bell, src.a);
    if now.ts
        < close
            .checked_add(crate::proc::transit::SETTLE_AFTER_CLOSE_SECS)
            .ok_or(OVERFLOW)?
        || dr.u32(PV::RESOLVED_NEXT)? <= t.arrive_bell
    {
        return Err(FrontierError::TooEarly.into());
    }
    if cseal::wide_seal_root_of(x.commit(), x.seal()) != t.seal_root {
        return Err(FrontierError::CommitMismatch.into());
    }
    let sig = sys::bls_g1_decompress(&src.sig48)
        .map_err(|_| crypto(crate::error::crypto_sub::BAD_POINT))?;
    let (code, plain) = cseal::judge_wide(&sig, x.seal(), x.commit(), &t.host, t.arrive_bell);
    if !matches!(code, 0 | 1 | 2 | 4 | 5) || (code == 0) != plain.is_some() {
        return Err(BAD_ACCOUNT);
    }
    if plain.is_some_and(|pl| pl.dest != dest) {
        return Err(FrontierError::BadAddress.into());
    }
    expect_key(&a[5], &ctx.clash_inputs(coord.p, coord.q, t.arrive_bell))?;
    prologue::present(&a[5], p, AccountKind::ClashInputs, hdr.id)?;
    let cd = &before[5].data;
    let cr = Ro(cd);
    if cd.len() != CI::SIZE
        || cr.i16(CI::P)? as i32 != coord.p
        || cr.i16(CI::Q)? as i32 != coord.q
        || cr.u32(CI::BELL)? != t.arrive_bell
        || cr.u8(CI::FLAGS)? & CI::FLAG_RESOLVED == 0
        || cr.u32(CI::ARRIVALS_MASK)? != CI::ALL_GATHERED
        || cr.u32(CI::SETTLED_MASK)? & !CI::ALL_GATHERED != 0
        || cr.u32(CI::CAMP_MASK)? & !CI::ALL_GATHERED != 0
    {
        return Err(BAD_ACCOUNT);
    }
    let mut position = None;
    let mut count = 0;
    for k in 0..24 {
        let at = CI::arrival(k);
        let present = cr.u8(at + AR::PRESENT)?;
        if present > 1 {
            return Err(BAD_ACCOUNT);
        }
        if present != 0 {
            count += 1;
            if cr.u64(at + AR::HOST_ID)? == id {
                if position.is_some() || k / 4 != t.faction as usize {
                    return Err(BAD_ACCOUNT);
                }
                position = Some(k);
            }
        }
    }
    if cr.u8(CI::N_PRESENT)? != count {
        return Err(BAD_ACCOUNT);
    }
    let position = position.ok_or(FrontierError::NotImplemented)?;
    if cr.u32(CI::SETTLED_MASK)? & (1 << position) != 0 {
        return Err(FrontierError::LatchClosed.into());
    }
    let at = CI::arrival(position);
    let rec = WideArrival {
        host: t.host,
        citizen: reverse.original_owner(),
        dep_mass: cr.u32(at + AR::DEP_MASS)?,
        troops: cr.u32(at + AR::TROOPS)?,
        stamina: cr.u16(at + AR::STAMINA)?,
        retreat_bps: cr.u16(at + AR::RETREAT)?,
        dealt_bps: cr.u16(at + AR::DEALT)?,
        faction: cr.u8(at + AR::FACTION)?,
        unit: cr.u8(at + AR::UNIT)?,
        tile: cr.u8(at + AR::TILE)?,
        stance: cr.u8(at + AR::STANCE)?,
        present: true,
        fate: cr.u8(at + AR::FATE)?,
        troops_after: cr.u32(at + AR::TROOPS_AFTER)?,
    };
    if cr.u64(at + AR::CITIZEN_TAG)? != addr::citizen_tag(&reverse.original_owner())
        || rec.dep_mass != t.dep_mass
        || rec.unit != t.unit
        || rec.faction != t.faction
        || !(1..=5).contains(&rec.fate)
        || rec.stamina > 120
        || rec.troops != t.troops_after
        || rec.stamina
            != frontier_abi::clash_model::arrival_stamina(
                t.stamina_after,
                t.depart_bell,
                t.arrive_bell,
            )
        || rec.troops_after > rec.troops
        || (rec.fate == 5 && rec.troops_after != 0)
        || rec.tile >= 61
        || rec.retreat_bps > 60000
        || Stance::from_u8(rec.stance).is_none()
    {
        return Err(BAD_ACCOUNT);
    }
    expect_key(
        &a[6],
        &ctx.arrival_slot(
            coord.p,
            coord.q,
            t.arrive_bell,
            t.faction,
            (position % 4) as u8,
        ),
    )?;
    let own_slot = prologue::presence(&a[6], p, AccountKind::ArrivalSlot, hdr.id)?;
    if own_slot {
        let sd = &before[6].data;
        let sr = Ro(sd);
        if sd.len() != AS::SIZE
            || sr.i16(AS::P)? as i32 != coord.p
            || sr.i16(AS::Q)? as i32 != coord.q
            || sr.u32(AS::BELL)? != t.arrive_bell
            || sr.u8(AS::FACTION)? != t.faction
            || sr.u8(AS::I)? != (position % 4) as u8
            || sr.u64(AS::HOST_ID)? != id
            || sr.u64(AS::CITIZEN_TAG)? != addr::citizen_tag(&reverse.original_owner())
            || sr.u8(AS::UNIT)? != t.unit
            || sr.u32(AS::DEP_MASS)? != t.dep_mass
            || sr.u8(AS::FLAGS)? & !AS::FLAG_CREATED_DAY != 0
            || sr.u8(AS::CLAIMED)? > 1
            || sd[AS::RSV..].iter().any(|b| *b != 0)
            || sr.u8(AS::TILE)? != rec.tile
            || sr.u8(AS::STANCE)? != rec.stance
            || sr.u16(AS::RETREAT_BPS)? != rec.retreat_bps
            || sr.u16(AS::DEALT_BPS)? != rec.dealt_bps
            || sr.u16(frontier_abi::v2::layout::s1::arrival::WORN_BPS)?
                > permutation_rules::frontier::structure::TOWER_WEAR_CAP_BPS
        {
            return Err(BAD_ACCOUNT);
        }
    }
    let expected_dealt = hold::bps16(of_faction_v3(t.faction).ok_or(BAD_ACCOUNT)?.dealt_bps(
        Posture::Stance(Stance::from_u8(rec.stance).ok_or(BAD_ACCOUNT)?),
        true,
    ))?;
    if rec.dealt_bps != expected_dealt {
        return Err(BAD_ACCOUNT);
    }
    let sr = Ro(&before[0].data);
    // `reverse.transit()` returns the record by value: copy it, then replace
    // only the tip with the marker's financial authority.
    let mut financial = t.clone();
    financial.tip = marker.tip();
    let fee = if marker.flags() & T::FLAG_FEE_ESCROWED != 0 {
        sr.u64(S::MARCH_FEE)?
    } else {
        0
    };
    let bond = if marker.flags() & T::FLAG_BOND_ESCROWED != 0 {
        sr.u64(S::SEAL_BOND)?
    } else {
        0
    };
    let outcome = if code == 0 {
        WideOutcome::Fate(rec.fate)
    } else {
        WideOutcome::BadSeal {
            code,
            fate: Some(rec.fate),
        }
    };
    let plan = plan_settlement(outcome, &financial, Some(&rec), fee, bond, own_slot)?;
    let mut after = before.clone();
    let mut holding = after[1].clone();
    Rw(&mut holding.data).set_u64(
        H::ESCROW,
        hr.u64(H::ESCROW)?
            .checked_sub(plan.total)
            .ok_or(BAD_ACCOUNT)?,
    )?;
    holding.data[offset..offset + MARKER_LEN].fill(0);
    replace(&mut after, 1, holding);
    let mut payments = [event::Payment {
        recipient: [0; 32],
        amount: 0,
        diverted: false,
    }; 4];
    let mut diversions = Vec::new();
    for (i, (amount, to)) in [plan.tip, plan.fee, plan.bond, plan.reward]
        .into_iter()
        .enumerate()
    {
        let target = match to {
            PayTo::PoolOwed => 1,
            PayTo::SlotBeneficiary => {
                expect_key(&a[10], &Ro(&before[6].data).arr::<32>(AS::BENEFICIARY)?)?;
                10
            }
            PayTo::Resolver => {
                expect_key(&a[11], &cr.arr::<32>(CI::RESOLVER)?)?;
                11
            }
            PayTo::RentPayer => 12,
            PayTo::SettleBeneficiary => 13,
        };
        let payment = payment(p, &mut after, target, amount, to == PayTo::PoolOwed)?;
        payments[i] = event::Payment {
            recipient: payment.recipient,
            amount: payment.amount,
            diverted: payment.diverted,
        };
        if payment.diverted && amount != 0 && payment.recipient != before[1].address {
            let reasons = [
                divert_reason::TIP,
                divert_reason::MARCH_FEE,
                divert_reason::BOND,
                divert_reason::REWARD,
            ];
            let payload = Buf::<9>::new().u64(amount).u8(reasons[i]);
            let mut record = [0; events::MAX_RECORD];
            let n = events::record(
                Kind::DIVERT,
                bell,
                &payment.recipient,
                payload.get()?,
                &mut [],
                &mut record,
            )?;
            diversions.push(record[..n].to_vec());
        }
    }
    let mut forfeited = false;
    if plan.forfeit {
        let mut dest = after[4].clone();
        if let Some(i) = find_entry(&dest.data, id) {
            let mut e = read_entry(&dest.data, i).map_err(|_| BAD_ACCOUNT)?;
            if e.state == E::STATE_ROSTER && !e.busy() {
                e.op = EntryOp::Forfeit;
                e.pend_bell = bell;
                write_entry(&mut dest.data, i, &e).map_err(|_| BAD_ACCOUNT)?;
                let epoch = Ro(&dest.data).u32(PV::ROSTER_EPOCH)?.wrapping_add(1);
                Rw(&mut dest.data).set_u32(PV::ROSTER_EPOCH, epoch)?;
                forfeited = true;
            }
        }
        replace(&mut after, 4, dest);
    }
    let mut credited = 0;
    let mut home_written = false;
    if let Some((troops, stamina, routed)) = plan.returns {
        if routed {
            return Err(BAD_ACCOUNT);
        }
        let mut home = after[3].clone();
        let mut holding = after[1].clone();
        credited = super::super::super::stage_legacy_home(
            &mut home.data,
            &mut holding.data,
            &t,
            id,
            troops,
            stamina,
            t.arrive_bell,
            bell,
        )?;
        home_written = home.data != after[3].data;
        replace(&mut after, 3, home);
        replace(&mut after, 1, holding);
    }
    let camp_works = if code == 0
        && rec.fate == AR::FATE_STAYS
        && cr.u32(CI::CAMP_MASK)? != 0
        && cr.u32(CI::CAMP_MASK)?.trailing_zeros() as usize == position
    {
        permutation_rules::frontier::camp::loot() as u64
    } else {
        0
    };
    if camp_works != 0 {
        prologue::present_v2(&a[14], p, K2::Citizen, hdr.id)?;
        crate::proc::resident::expect_citizen_address(&ctx, &a[14], &before[14].data)?;
        if Ro(&before[14].data).u64(crate::layout::citizen::CITIZEN_TAG)?
            != addr::citizen_tag(&reverse.original_owner())
        {
            return Err(BAD_ACCOUNT);
        }
        let mut citizen = after[14].clone();
        Rw(&mut citizen.data).add_u64(crate::layout::citizen::WORKS, camp_works)?;
        replace(&mut after, 14, citizen);
    }
    let mut inputs = after[5].clone();
    Rw(&mut inputs.data).set_u32(
        CI::SETTLED_MASK,
        cr.u32(CI::SETTLED_MASK)? | (1 << position),
    )?;
    replace(&mut after, 5, inputs);
    let mut slot_retained = false;
    let mut eligible = false;
    let mut slot_rent = 0;
    let mut slot_rent_to = [0; 32];
    if own_slot {
        let params = DefenceParams {
            defence_cap_milli: sr.u32(S::DEFENCE_CAP_MILLI)?,
            tip_min: fees::min_tip_lamports(
                sr.u32(S::MIN_REVEAL_PRIORITY_MILLI)?,
                sr.u32(S::REVEAL_CU_LIMIT)?,
                sr.u32(S::REVEAL_LOADED_LIMIT)?,
            ),
        };
        eligible = crate::proc::transit::claim_eligible(
            &before[6].data,
            src.anchor_slot,
            sr.u8(S::LATENESS_SLOTS)?,
            &params,
            now.ts,
            close,
        )?;
        slot_rent_to = Ro(&before[6].data).arr(AS::RENT_TO)?;
        let recipient = (9..=13)
            .find(|&i| before[i].address == slot_rent_to)
            .filter(|_| !eligible);
        if let Some(i) = recipient {
            slot_rent = close_stage(p, &mut after, 6, i)?;
        } else {
            let mut slot = after[6].clone();
            let flags = Ro(&slot.data).u8(AS::FLAGS)?;
            Rw(&mut slot.data).set_u8(AS::FLAGS, flags | AS::FLAG_SETTLED)?;
            replace(&mut after, 6, slot);
            slot_retained = true;
        }
    }
    let bridge_rent = close_stage(p, &mut after, 2, 7)?;
    let mut targets = vec![(1, EntityKind::Holding), (4, EntityKind::Province)];
    if home_written && before[3].address != before[4].address {
        targets.push((3, EntityKind::Province));
    }
    if camp_works != 0 {
        targets.push((14, EntityKind::Citizen));
    }
    let links = targets
        .iter()
        .map(|&(i, entity)| {
            let (seq, head) = crate::layout::chain_of(&before[i].data)?;
            Ok(event::Chain {
                entity,
                address: before[i].address,
                seq,
                head,
            })
        })
        .collect::<R<Vec<_>>>()?;
    let normalized: Vec<_> = links.iter().map(|l| l.address).collect();
    let receipt = event::Receipt {
        slot: x.slot(),
        seal_code: code,
        fate: rec.fate,
        outcome: if code == 0 {
            rec.fate
        } else {
            frontier_abi::log::transit_outcome::BAD_SEAL
        },
        forfeited,
        slot_retained,
        claim_eligible: eligible,
        now_ts: now.ts,
        now_slot: now.slot,
        host: t.host,
        original_owner: reverse.original_owner(),
        destination: dest,
        credited_milli: credited,
        camp_works,
        payments,
        bridge_rent,
        slot_rent,
        slot_rent_to,
        input: event::manifest(&ctx, d, now.ts, now.slot, &manifest(&before), &[])
            .map_err(|_| BAD_ACCOUNT)?,
        output: event::manifest(&ctx, d, now.ts, now.slot, &manifest(&after), &normalized)
            .map_err(|_| BAD_ACCOUNT)?,
        links,
    }
    .advance(&ctx)
    .map_err(|_| OVERFLOW)?;
    let record = receipt.to_bytes(&ctx).map_err(|_| BAD_ACCOUNT)?;
    for (&(i, _), link) in targets.iter().zip(&receipt.links) {
        let mut s = after[i].clone();
        crate::layout::set_chain(&mut s.data, link.seq, &link.head)?;
        replace(&mut after, i, s);
    }
    commit_snapshots(p, a, &before, &after)?;
    for record in diversions {
        solana_program::log::sol_log_data(&[frontier_abi::log::PREFIX, &record]);
    }
    solana_program::log::sol_log_data(&[event::PREFIX, &record]);
    Ok(())
}
