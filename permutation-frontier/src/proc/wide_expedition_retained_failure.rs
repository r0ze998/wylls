//! Private present-slot bad-seal settlement. Preserves existing defence
//! entitlement and immutable slot rent; PSFF v3 only, no previous generation.
use super::*;
use frontier_abi::world_index::{
    expedition_retained_failure_event as event, expedition_retained_failure_ix as ix,
};

pub(in super::super) fn execute_draft(p: &Pubkey, a: &[AccountInfo], d: &[u8]) -> R<()> {
    let command = ix::DraftCommand::decode(d)?;
    if a.len() != ix::ACCOUNT_COUNT {
        return Err(FrontierError::TooManyAccounts.into());
    }
    let base = ix::BASE;
    for (i, ai) in a.iter().enumerate() {
        let spec = ix::spec(i).ok_or(BAD_ACCOUNT)?;
        if (spec.signer && !ai.is_signer)
            || (spec.wr == frontier_abi::prologue::Wr::W && !ai.is_writable)
        {
            return Err(BAD_ACCOUNT);
        }
    }
    // The additional structural read role may not alias a payment or writer.
    if a[..ix::ROSTER].iter().any(|ai| ai.key == a[ix::ROSTER].key) {
        return Err(BAD_ACCOUNT);
    }
    let before = snapshots(a, base)?;
    let (pending, code, anchor) = super::super::stage_bad_retained(
        p,
        &a[..base],
        &a[base],
        command.slot(),
        command.commit(),
        command.seal(),
    )?;
    let now = prologue::now()?;
    let hdr = settle_season(&a[0], p, now.ts)?;
    let bell = hdr.bell(now.ts).ok_or(FrontierError::WrongStatus)?;
    let ctx = addr::ctx(&key(&a[0]), &p.to_bytes());
    let bridge = OwnedBridgeTransit::from_bytes(&ctx, &before[2].data).map_err(|_| BAD_ACCOUNT)?;
    let t = bridge.transit();
    let off = H::transit(command.slot() as usize);
    let marker = BridgeMarker::from_bytes(&ctx, &before[1].data[off..off + MARKER_LEN])
        .map_err(|_| BAD_ACCOUNT)?;
    let pair = authenticate_pair(
        &ctx,
        &before[1].address,
        command.slot(),
        &before[2].address,
        &marker,
        bridge.common(),
    )
    .map_err(|_| BAD_ACCOUNT)?;
    let finances = pair
        .financial_input(
            Ro(&before[0].data).u64(S::MARCH_FEE)?,
            Ro(&before[0].data).u64(S::SEAL_BOND)?,
        )
        .map_err(|_| BAD_ACCOUNT)?;
    // Reuse the existing deployed payment table without an economic override.
    let fate = match pending.payments_if_valid.outcome {
        WideOutcome::Fate(fate) => fate,
        _ => return Err(BAD_ACCOUNT),
    };
    let plan = plan_settlement(
        WideOutcome::BadSeal {
            code,
            fate: Some(fate),
        },
        &finances.transit,
        None,
        finances.fee,
        finances.bond,
        true,
    )?;
    if plan.forfeit != (fate != wa::wide_arrival::FATE_DESTROYED)
        || plan.stays
        || plan.returns.is_some()
        || plan.total != pending.payments_if_valid.total
        || plan.reward != (plan.total, PayTo::SettleBeneficiary)
    {
        return Err(BAD_ACCOUNT);
    }
    expect_key(
        &a[ix::ROSTER],
        &wro::roster_address(&ctx, t.dest.ok_or(BAD_ACCOUNT)?),
    )?;
    let destination_stage = if plan.forfeit {
        stage_roster_forfeit(
            p,
            &ctx,
            hdr.id,
            &a[4],
            &a[ix::ROSTER],
            t.dest.ok_or(BAD_ACCOUNT)?,
            &t.host,
            bell,
        )?
    } else {
        // Authenticate the unused structural read role even in Destroyed.
        if let Some(roster) = roster_at(&a[ix::ROSTER], p, hdr.id, t.dest.ok_or(BAD_ACCOUNT)?)? {
            roster
                .validate_paired(
                    &before[ix::ROSTER].data,
                    &wres::live_ids(&before[4].data).map_err(resolve_err)?,
                )
                .map_err(|_| BAD_ACCOUNT)?;
        }
        None
    };
    let forfeited = destination_stage.is_some();
    let mut after = before.clone();
    if let Some(data) = destination_stage {
        let mut destination = after[4].clone();
        destination.data = data;
        replace(&mut after, 4, destination);
    }
    let mut holding = after[1].clone();
    holding.data = pending.holding;
    replace(&mut after, 1, holding);
    let reward = payment(p, &mut after, base + 5, plan.reward.0, false)?;
    let mut ih = WideClashInputsHdr::read(&before[5].data).map_err(|_| BAD_ACCOUNT)?;
    ih.settled_mask |= 1u32 << pending.arrival_position;
    let mut inputs = after[5].clone();
    ih.write(&mut inputs.data).map_err(|_| BAD_ACCOUNT)?;
    replace(&mut after, 5, inputs);
    let slot = pending.retained_slot.ok_or(BAD_ACCOUNT)?;
    let common = slot.common();
    let sd = Ro(&before[0].data);
    let clock = SeasonClock::read(&before[0].data)?;
    let params = DefenceParams {
        defence_cap_milli: sd.u32(S::DEFENCE_CAP_MILLI)?,
        tip_min: fees::min_tip_lamports(
            sd.u32(S::MIN_REVEAL_PRIORITY_MILLI)?,
            sd.u32(S::REVEAL_CU_LIMIT)?,
            sd.u32(S::REVEAL_LOADED_LIMIT)?,
        ),
    };
    let claim_eligible = wide_claim_eligible(
        common,
        anchor.anchor_slot,
        sd.u8(S::LATENESS_SLOTS)?,
        &params,
        now.ts,
        clock.reveal_close(t.arrive_bell, anchor.a),
    )?;
    let slot_rent_to = common.rent_to;
    let recipient = [base + 1, base + 2, base + 3, base + 4, base + 5, 7]
        .into_iter()
        .find(|&i| after[i].address == slot_rent_to);
    let (slot_retained, slot_rent) = if let Some(recipient) = recipient.filter(|_| !claim_eligible)
    {
        (false, close_stage(p, &mut after, 6, recipient)?)
    } else {
        let mut next = after[6].clone();
        next.data = slot
            .with_settled()
            .to_bytes(&ctx)
            .map_err(|_| BAD_ACCOUNT)?
            .to_vec();
        replace(&mut after, 6, next);
        (true, 0)
    };
    let rent = close_stage(p, &mut after, 2, 7)?;
    let mut diversion = None;
    if reward.diverted && reward.amount != 0 && reward.recipient != before[1].address {
        let payload = Buf::<9>::new().u64(reward.amount).u8(divert_reason::REWARD);
        let mut record = [0; events::MAX_RECORD];
        let n = events::record(
            Kind::DIVERT,
            bell,
            &reward.recipient,
            payload.get()?,
            &mut [],
            &mut record,
        )?;
        diversion = Some(record[..n].to_vec());
    }
    let holding_chain = event::Chain::from_account(&before[1].data).map_err(|_| BAD_ACCOUNT)?;
    let destination_chain = event::Chain::from_account(&before[4].data).map_err(|_| BAD_ACCOUNT)?;
    let receipt = event::Receipt {
        slot_retained,
        claim_eligible,
        slot_rent_to,
        slot_rent,
        fate,
        forfeited,
        slot: command.slot(),
        seal_code: code,
        diverted: reward.diverted,
        now_ts: now.ts,
        now_slot: now.slot,
        host: t.host,
        original_owner: bridge.original_owner(),
        destination: t.dest.ok_or(BAD_ACCOUNT)?,
        reward_to: reward.recipient,
        reward: reward.amount,
        rent_to: before[7].address,
        rent,
        input: event::manifest(&ctx, d, now.ts, now.slot, &manifest(&before), &[])
            .map_err(|_| BAD_ACCOUNT)?,
        output: event::manifest(
            &ctx,
            d,
            now.ts,
            now.slot,
            &manifest(&after),
            &[before[1].address, before[4].address],
        )
        .map_err(|_| BAD_ACCOUNT)?,
        holding_chain,
        destination_chain,
    }
    .advance(&ctx, holding_chain, destination_chain)
    .map_err(|_| OVERFLOW)?;
    let record = receipt.to_bytes(&ctx).map_err(|_| BAD_ACCOUNT)?;
    let mut holding = after[1].clone();
    crate::layout::set_chain(
        &mut holding.data,
        receipt.holding_chain.seq,
        &receipt.holding_chain.head,
    )?;
    replace(&mut after, 1, holding);
    let mut destination = after[4].clone();
    crate::layout::set_chain(
        &mut destination.data,
        receipt.destination_chain.seq,
        &receipt.destination_chain.head,
    )?;
    replace(&mut after, 4, destination);
    // The shared committer acquires every output borrow before resizing. No
    // member/camp receipt or saved proof capability is accepted or emitted.
    commit_snapshots(p, a, &before, &after)?;
    if let Some(record) = diversion {
        solana_program::log::sol_log_data(&[frontier_abi::log::PREFIX, &record]);
    }
    solana_program::log::sol_log_data(&[event::PREFIX, &record]);
    Ok(())
}
