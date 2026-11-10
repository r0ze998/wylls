//! Private live-season failure settlement for a destroyed resolved member.
//! No forfeiture, retained claim, previous generation or nonmember inference.
use super::*;
use frontier_abi::world_index::{expedition_failure_event as event, expedition_failure_ix as ix};

pub(in super::super) fn execute_draft(p: &Pubkey, a: &[AccountInfo], d: &[u8]) -> R<()> {
    let command = ix::DraftCommand::decode(d)?;
    if a.len() != ix::ACCOUNT_COUNT {
        return Err(FrontierError::TooManyAccounts.into());
    }
    let base = ix::ACCOUNT_LAYOUT.base();
    for (i, ai) in a.iter().enumerate() {
        let spec = ix::ACCOUNT_LAYOUT.spec(i).ok_or(BAD_ACCOUNT)?;
        if (spec.signer && !ai.is_signer)
            || (spec.wr == frontier_abi::prologue::Wr::W && !ai.is_writable)
        {
            return Err(BAD_ACCOUNT);
        }
    }
    let before = snapshots(a, base)?;
    let (pending, code) = super::super::stage_bad_destroyed(
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
    let plan = plan_settlement(
        WideOutcome::BadSeal {
            code,
            fate: Some(wa::wide_arrival::FATE_DESTROYED),
        },
        &finances.transit,
        None,
        finances.fee,
        finances.bond,
        false,
    )?;
    if plan.forfeit
        || plan.stays
        || plan.returns.is_some()
        || plan.total != pending.payments_if_valid.total
        || plan.reward != (plan.total, PayTo::SettleBeneficiary)
    {
        return Err(BAD_ACCOUNT);
    }
    let mut after = before.clone();
    let mut holding = after[1].clone();
    holding.data = pending.holding;
    replace(&mut after, 1, holding);
    let reward = payment(p, &mut after, base + 5, plan.reward.0, false)?;
    let mut ih = WideClashInputsHdr::read(&before[5].data).map_err(|_| BAD_ACCOUNT)?;
    ih.settled_mask |= 1u32 << pending.arrival_position;
    let mut inputs = after[5].clone();
    ih.write(&mut inputs.data).map_err(|_| BAD_ACCOUNT)?;
    replace(&mut after, 5, inputs);
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

#[cfg(all(
    test,
    feature = "runtime-contract-tests",
    feature = "public-proof-tests",
    not(target_os = "solana")
))]
#[path = "wide_expedition_failure_tests.rs"]
mod tests;
