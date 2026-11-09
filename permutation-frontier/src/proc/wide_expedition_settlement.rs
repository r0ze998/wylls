//! Private same-call resolved original-to-wide settlement. No dispatcher.
//! All proof, account, payment and receipt preparation precedes effects.
//! Runtime resize/assignment still needs the runtime transaction contract;
//! direct-host tests must not claim to establish rollback or successful close.
use super::*;
use alloc::rc::Rc;
use frontier_abi::world_index::expedition_event::AccountSnapshot;
use frontier_abi::world_index::expedition_settlement_event as receipt;

#[derive(Clone)]
struct Snapshot {
    address: [u8; 32],
    owner: [u8; 32],
    present: bool,
    signer: bool,
    writable: bool,
    lamports: u64,
    data: Vec<u8>,
}
fn manifest(s: &[Snapshot]) -> Vec<AccountSnapshot<'_>> {
    s.iter()
        .enumerate()
        .map(|(i, s)| AccountSnapshot {
            role: (i + 1) as u16,
            address: s.address,
            owner: s.owner,
            present: s.present,
            signer: s.signer,
            writable: s.writable,
            lamports: s.lamports,
            data: &s.data,
        })
        .collect()
}
fn replace(s: &mut [Snapshot], i: usize, next: Snapshot) {
    let key = s[i].address;
    for item in s.iter_mut().filter(|x| x.address == key) {
        item.owner = next.owner;
        item.present = next.present;
        item.lamports = next.lamports;
        item.data.clone_from(&next.data);
    }
}
fn balance(s: &mut [Snapshot], i: usize, value: u64) {
    let key = s[i].address;
    for item in s.iter_mut().filter(|x| x.address == key) {
        item.lamports = value;
    }
}

/// Repeated payment recipients share one balance. Distinct structural roles
/// may not alias, nor may a recipient alias a closing or read-only role.
/// Program-owned live output accounts may also be payees (diversion applies).
/// Same-key fake AccountInfos and cross-key shared RefCells refuse
/// before even reading account balances (which otherwise can panic).
fn snapshots(a: &[AccountInfo], base: usize) -> R<Vec<Snapshot>> {
    for (i, ai) in a.iter().enumerate() {
        if ai.executable {
            return Err(BAD_ACCOUNT);
        }
        for (j, aj) in a[..i].iter().enumerate() {
            let same = ai.key == aj.key;
            let data = Rc::ptr_eq(&ai.data, &aj.data);
            let lamports = Rc::ptr_eq(&ai.lamports, &aj.lamports);
            if same != data || same != lamports {
                return Err(BAD_ACCOUNT);
            }
            let structural = |n: usize| n < 7 || (base == 9 && n == 8) || n == base;
            let exclusive = |n: usize| matches!(n, 0 | 2 | 6) || n == base;
            if same
                && (ai.owner != aj.owner
                    || ai.is_signer != aj.is_signer
                    || ai.is_writable != aj.is_writable
                    || (structural(i) && structural(j))
                    || exclusive(i)
                    || exclusive(j))
            {
                return Err(BAD_ACCOUNT);
            }
        }
    }
    a.iter()
        .map(|ai| {
            Ok(Snapshot {
                address: key(ai),
                owner: ai.owner.to_bytes(),
                present: !(ai.owner == &init::SYSTEM && ai.try_data_len()? == 0),
                signer: ai.is_signer,
                writable: ai.is_writable,
                lamports: ai.try_lamports()?,
                data: ai.try_borrow_data()?.to_vec(),
            })
        })
        .collect()
}

fn payment(
    p: &Pubkey,
    s: &mut [Snapshot],
    recipient: usize,
    amount: u64,
    direct_pool: bool,
) -> R<receipt::Payment> {
    let mut result = receipt::Payment {
        recipient: s[recipient].address,
        amount,
        diverted: false,
    };
    if amount == 0 {
        return Ok(result);
    }
    let divert = if direct_pool || s[recipient].owner == p.to_bytes() {
        true
    } else {
        init::diverts(
            s[recipient].lamports,
            amount,
            init::rent(s[recipient].data.len())?,
        )
        .ok_or(OVERFLOW)?
    };
    result.diverted = divert;
    if divert {
        let next = Ro(&s[1].data)
            .u64(H::POOL_OWED)?
            .checked_add(amount)
            .ok_or(OVERFLOW)?;
        let mut holding = s[1].clone();
        Rw(&mut holding.data).set_u64(H::POOL_OWED, next)?;
        replace(s, 1, holding);
    } else {
        let debit = s[1].lamports.checked_sub(amount).ok_or(BAD_ACCOUNT)?;
        let credit = s[recipient].lamports.checked_add(amount).ok_or(OVERFLOW)?;
        balance(s, 1, debit);
        balance(s, recipient, credit);
    }
    Ok(result)
}

fn close_stage(p: &Pubkey, s: &mut [Snapshot], source: usize, recipient: usize) -> R<u64> {
    if s[source].address == s[recipient].address {
        return Err(BAD_ACCOUNT);
    }
    let amount = s[source].lamports;
    let after = s[recipient].lamports.checked_add(amount).ok_or(OVERFLOW)?;
    if amount != 0
        && s[recipient].owner != p.to_bytes()
        && after < init::rent(s[recipient].data.len())?
    {
        return Err(BAD_ACCOUNT);
    }
    balance(s, recipient, after);
    let mut gone = s[source].clone();
    gone.owner = init::SYSTEM.to_bytes();
    gone.present = false;
    gone.lamports = 0;
    gone.data.clear();
    replace(s, source, gone);
    Ok(amount)
}

struct Prepared {
    before: Vec<Snapshot>,
    after: Vec<Snapshot>,
    receipts: receipt::Prepared,
    diversions: Vec<Vec<u8>>,
}

/// Preserve native pay_wide/owe_wide's zero-link PS2 DIVERT events, including
/// intended recipient and reason. Encoding is fallible, so do it on scratch
/// buffers before any resize, assignment, balance write or log emission.
fn prepare_diversions(
    holding: &[u8; 32],
    bell: u32,
    payments: &[receipt::Payment; 3],
) -> R<Vec<Vec<u8>>> {
    let mut records = Vec::new();
    for (payment, reason) in payments.iter().zip([
        divert_reason::TIP,
        divert_reason::MARCH_FEE,
        divert_reason::BOND,
    ]) {
        if !payment.diverted || payment.amount == 0 || &payment.recipient == holding {
            continue;
        }
        let payload = Buf::<9>::new().u64(payment.amount).u8(reason);
        let mut record = [0; events::MAX_RECORD];
        let n = events::record(
            Kind::DIVERT,
            bell,
            &payment.recipient,
            payload.get()?,
            &mut [],
            &mut record,
        )?;
        records.push(record[..n].to_vec());
    }
    Ok(records)
}

/// Private role table: the proof's 8/9 base accounts, then canonical anchor,
/// signer payer, slot beneficiary, resolver, holding rent payer, settle
/// beneficiary. These are roles only, never a public instruction encoding.
fn prepare(
    p: &Pubkey,
    a: &[AccountInfo],
    base: usize,
    slot_index: u8,
    commit: &[u8; 32],
    seal: &[u8; wseal::WIDE_SEAL_LEN],
) -> R<Prepared> {
    if !matches!(base, 8 | 9) || a.len() != base + 6 {
        return Err(BAD_ACCOUNT);
    }
    let before = snapshots(a, base)?;
    if !a[base + 1].is_signer {
        return Err(BAD_ACCOUNT);
    }
    for i in (1..base).chain(base + 1..a.len()) {
        if !a[i].is_writable {
            return Err(BAD_ACCOUNT);
        }
    }
    let verified = super::stage(p, &a[..base], &a[base], slot_index, commit, seal)?;
    let pending = verified.pending;
    let now = prologue::now()?;
    let hdr = settle_season(&a[0], p, now.ts)?;
    let bell = hdr.bell(now.ts).ok_or(FrontierError::WrongStatus)?;
    let ctx = addr::ctx(&key(&a[0]), &p.to_bytes());
    let bridge = OwnedBridgeTransit::from_bytes(&ctx, &before[2].data).map_err(|_| BAD_ACCOUNT)?;
    let t = bridge.transit();
    let mut ih = WideClashInputsHdr::read(&before[5].data).map_err(|_| BAD_ACCOUNT)?;
    let plan = pending.payments_if_valid;
    let fate = match plan.outcome {
        WideOutcome::Fate(f) => f,
        _ => return Err(BAD_ACCOUNT),
    };
    // Camp loot needs its original Citizen Works and chain as one operation.
    // It is deliberately refused before effects until that path is complete.
    if fate == wa::wide_arrival::FATE_STAYS
        && ih.camp_mask != 0
        && ih.camp_mask.trailing_zeros() as usize == pending.arrival_position
    {
        return Err(FrontierError::NotImplemented.into());
    }
    if plan.forfeit || plan.reward.0 != 0 {
        return Err(BAD_ACCOUNT);
    }
    expect_key(&a[base + 4], &pending.holding_rent_payer)?;
    let mut after = before.clone();
    let mut holding = after[1].clone();
    holding.data = pending.holding;
    replace(&mut after, 1, holding);
    if let Some(data) = pending.home {
        let mut home = after[3].clone();
        home.data = data;
        replace(&mut after, 3, home);
    }
    if let Some(data) = pending.previous_home {
        let mut home = after[8].clone();
        home.data = data;
        replace(&mut after, 8, home);
    }
    let changed_home = (after[3].data != before[3].data).then_some(t.host.key());
    let changed_previous_home = if base == 9 && after[8].data != before[8].data {
        Some(key(&a[8]))
    } else {
        None
    };
    let empty = receipt::Payment {
        recipient: [0; 32],
        amount: 0,
        diverted: false,
    };
    let mut payments = [empty; 3];
    // Exact native order, including when all three roles share one wallet.
    for (i, (amount, to)) in [plan.tip, plan.fee, plan.bond].into_iter().enumerate() {
        let recipient = match to {
            PayTo::PoolOwed => 1,
            PayTo::SlotBeneficiary => {
                if amount != 0 {
                    expect_key(&a[base + 2], &pending.slot_beneficiary.ok_or(BAD_ACCOUNT)?)?;
                }
                base + 2
            }
            PayTo::Resolver => {
                if amount != 0 {
                    expect_key(&a[base + 3], &pending.resolver)?;
                }
                base + 3
            }
            PayTo::RentPayer => base + 4,
            PayTo::SettleBeneficiary => return Err(BAD_ACCOUNT),
        };
        payments[i] = payment(
            p,
            &mut after,
            recipient,
            amount,
            matches!(to, PayTo::PoolOwed),
        )?;
    }
    ih.settled_mask |= 1u32 << pending.arrival_position;
    let mut inputs = after[5].clone();
    ih.write(&mut inputs.data).map_err(|_| BAD_ACCOUNT)?;
    replace(&mut after, 5, inputs);
    let mut slot_rent = 0;
    let mut slot_rent_to = [0; 32];
    let mut slot_retained = false;
    if let Some(slot) = pending.retained_slot {
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
        let keep = wide_claim_eligible(
            slot.common(),
            verified.anchor.anchor_slot,
            sd.u8(S::LATENESS_SLOTS)?,
            &params,
            now.ts,
            clock.reveal_close(t.arrive_bell, verified.anchor.a),
        )?;
        let recipient = [base + 1, base + 2, base + 3, base + 4, base + 5, 7]
            .into_iter()
            .find(|&i| after[i].address == slot.common().rent_to);
        if let Some(recipient) = recipient.filter(|_| !keep) {
            slot_rent_to = slot.common().rent_to;
            slot_rent = close_stage(p, &mut after, 6, recipient)?;
        } else {
            after[6].data = slot
                .with_settled()
                .to_bytes(&ctx)
                .map_err(|_| BAD_ACCOUNT)?
                .to_vec();
            slot_retained = true;
        }
    }
    let bridge_rent = close_stage(p, &mut after, 2, 7)?;
    let diversions = prepare_diversions(&key(&a[1]), bell, &payments)?;
    let pool_owed = payments
        .iter()
        .filter(|x| x.diverted)
        .try_fold(0u64, |n, x| n.checked_add(x.amount).ok_or(OVERFLOW))?;
    let mut command = Vec::new();
    command.push(slot_index);
    command.extend_from_slice(commit);
    command.extend_from_slice(seal);
    let identity = receipt::Identity {
        host: t.host,
        slot: slot_index,
        original_owner: bridge.original_owner(),
        holding: key(&a[1]),
        external: key(&a[2]),
        destination: verified.plain.dest,
        province: key(&a[4]),
        changed_home,
        changed_previous_home,
        citizen: None,
    };
    let context = receipt::Context {
        command: &command,
        now_ts: now.ts,
        now_slot: now.slot,
        bell,
        season: &before[0].data,
        evidence: &before[base].data,
    };
    let outcomes = receipt::Outcomes {
        fate,
        credited_milli: pending.credited_milli,
        payments,
        pool_owed,
        bridge_rent,
        slot_rent,
        slot_rent_to,
        slot_retained,
    };
    let receipts = receipt::prepare(
        &ctx,
        identity,
        &context,
        &manifest(&before),
        &manifest(&after),
        outcomes,
    )
    .map_err(|_| BAD_ACCOUNT)?;
    let mut original_indices = vec![1];
    if changed_home.is_some() {
        original_indices.push(3);
    }
    if changed_previous_home.is_some() {
        original_indices.push(8);
    }
    for (link, i) in receipts.original_links.iter().zip(original_indices) {
        let mut next = after[i].clone();
        crate::layout::set_chain(&mut next.data, link.seq, &link.head)?;
        replace(&mut after, i, next);
    }
    let mut dest = after[4].clone();
    crate::layout::set_chain(
        &mut dest.data,
        receipts.wide_link.seq,
        &receipts.wide_link.head,
    )?;
    replace(&mut after, 4, dest);
    Ok(Prepared {
        before,
        after,
        receipts,
        diversions,
    })
}

/// Not a reusable plan consumer: this entry repeats real proof and staging.
/// All mutable borrows are acquired together. The only fallible operation
/// after preflight is runtime shrink; VM failure atomicity is Solana's, not
/// demonstrated by a fabricated host AccountInfo allocation.
pub(super) fn settle(
    p: &Pubkey,
    a: &[AccountInfo],
    base: usize,
    slot_index: u8,
    commit: &[u8; 32],
    seal: &[u8; wseal::WIDE_SEAL_LEN],
) -> R<()> {
    let prepared = prepare(p, a, base, slot_index, commit, seal)?;
    let mut data = Vec::new();
    let mut balances = Vec::new();
    let mut closed = Vec::new();
    for i in 0..a.len() {
        if a[..i].iter().any(|x| x.key == a[i].key) {
            continue;
        }
        let before = &prepared.before[i];
        let after = &prepared.after[i];
        if before.data != after.data || before.owner != after.owner {
            if !a[i].is_writable || a[i].owner != p {
                return Err(BAD_ACCOUNT);
            }
            let borrow = a[i].try_borrow_mut_data()?;
            if borrow.len() != after.data.len() {
                if !after.data.is_empty() || after.owner != init::SYSTEM.to_bytes() {
                    return Err(BAD_ACCOUNT);
                }
                closed.push(i);
            }
            data.push((i, Some(borrow)));
        }
        if before.lamports != after.lamports {
            if !a[i].is_writable {
                return Err(BAD_ACCOUNT);
            }
            balances.push((i, a[i].try_borrow_mut_lamports()?));
        }
    }
    // Release only the closing data guards: resize itself needs those cells.
    // No aliases can share them, and every other output guard stays held.
    for (i, guard) in &mut data {
        if closed.contains(i) {
            *guard = None;
        }
    }
    for &i in &closed {
        a[i].resize(0)?;
        a[i].assign(&init::SYSTEM);
    }
    for (i, mut guard) in data {
        if let Some(ref mut bytes) = guard {
            bytes.copy_from_slice(&prepared.after[i].data);
        }
    }
    for (i, mut lamports) in balances {
        **lamports = prepared.after[i].lamports;
    }
    for record in &prepared.diversions {
        solana_program::log::sol_log_data(&[frontier_abi::log::PREFIX, record]);
    }
    solana_program::log::sol_log_data(&[
        frontier_abi::world_index::expedition_event::PREFIX,
        &prepared.receipts.original,
    ]);
    solana_program::log::sol_log_data(&[wev::WIDE_LOG_PREFIX, &prepared.receipts.wide]);
    Ok(())
}

#[cfg(test)]
#[path = "wide_expedition_settlement_tests.rs"]
mod tests;

#[cfg(all(
    test,
    feature = "runtime-contract-tests",
    feature = "public-proof-tests",
    not(target_os = "solana")
))]
#[path = "wide_expedition_runtime_contract_tests.rs"]
mod runtime_contract_tests;
