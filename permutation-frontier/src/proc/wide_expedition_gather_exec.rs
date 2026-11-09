//! PRIVATE candidate child of expedition_gather, never a dispatch admission.
//! Authenticated staging precedes a complete borrowed before/after manifest
//! and provisional PS2 kind147, whose exact tail is empty. No seal verdict.
//! The absent-input branch uses the real standard allocator and transaction
//! rollback on CPI failure; host tests never execute or stub that branch.
use super::*;
use frontier_abi::world_index::expedition_producer_event as receipt;
use frontier_abi::world_index::expedition_transport::OWNED_BRIDGE_LEN;

struct Prepared {
    staged: GatherPlan,
    body: Vec<u8>,
    destination: ProvinceKey,
    season_id: u64,
    season_bump: u8,
    rent_inputs: u64,
    /// Expected balances for every position, including readonly aliases.
    after_balances: Vec<u64>,
}

/// A mutable role must be its sole address and sole storage. Readonly aliases
/// remain allowed, with their complete distinct roles in the receipt. Refuse
/// synthetic host aliases that share a RefCell under different public keys as
/// well as real duplicate metas; never let one copy overwrite another.
fn check_aliases(a: &[AccountInfo], writes: &[usize]) -> R<()> {
    for &i in writes {
        for (j, other) in a.iter().enumerate() {
            if i != j
                && (a[i].key == other.key
                    || alloc::rc::Rc::ptr_eq(&a[i].data, &other.data)
                    || alloc::rc::Rc::ptr_eq(&a[i].lamports, &other.lamports))
            {
                return Err(BAD_ACCOUNT);
            }
        }
    }
    Ok(())
}

fn prepare(p: &Pubkey, a: &[AccountInfo], x: &wix::ExpeditionGather) -> R<Prepared> {
    let command = x.to_bytes();
    wix::ExpeditionGather::decode(&command)?;
    if a.len() != 8 + 3 * x.n as usize {
        return Err(FrontierError::TooManyAccounts.into());
    }
    // Fallible access first: never panic through AccountInfo::lamports when
    // another borrower is holding a balance, including on readonly roles.
    let balances: Vec<u64> = a
        .iter()
        .map(|ai| ai.try_borrow_lamports().map(|n| **n))
        .collect::<Result<Vec<_>, _>>()?;
    for ai in a {
        let _data = ai.try_borrow_data()?;
    }
    check_accounts(TopLevelShape(wix::EXPEDITION_GATHER), a, Some(&[1, x.n]))?;
    prologue::top_level(TopLevelShape(wix::EXPEDITION_GATHER))?;
    let staged = stage(
        p,
        a,
        &wix::Gather {
            bell: x.bell,
            start: x.start,
            n: x.n,
        },
    )?;
    if !a[4].is_writable || staged.inputs.len() != wa::wide_clash_inputs::SIZE {
        return Err(BAD_ACCOUNT);
    }
    let ih = WideClashInputsHdr::read(&staged.inputs).map_err(|_| BAD_ACCOUNT)?;
    let now = prologue::now()?;
    let hdr = prologue::keeper(a, p, &[S::STATUS_RUNNING, S::STATUS_ENDED], now.ts)?;
    if ih.season_id != hdr.id || ih.bell != x.bell {
        return Err(BAD_ACCOUNT);
    }
    let ctx = addr::ctx(&key(&a[1]), &p.to_bytes());
    let mut writes = alloc::vec![0, 4];
    let mut stamped_mask = 0u32;
    for (at, bytes) in &staged.bridges {
        if *at < 10
            || (*at - 10) % 3 != 0
            || *at >= a.len()
            || !a[*at].is_writable
            || a[*at].owner != p
            || bytes.len() != OWNED_BRIDGE_LEN
        {
            return Err(BAD_ACCOUNT);
        }
        let bit = 1u32 << (x.start as usize + (*at - 10) / 3);
        if stamped_mask & bit != 0 {
            return Err(BAD_ACCOUNT);
        }
        stamped_mask |= bit;
        writes.push(*at);
    }
    check_aliases(a, &writes)?;
    // Receipt records the target minimum even for an existing allocation;
    // paid_inputs/payer_debit remain zero unless this call creates it.
    let rent_inputs = init::rent(wa::wide_clash_inputs::SIZE)?;
    let paid_inputs = if staged.create_inputs {
        rent_inputs.saturating_sub(balances[4])
    } else {
        0
    };
    if paid_inputs != 0 && !init::is_absent(&a[0]) {
        return Err(BAD_ACCOUNT);
    }
    let mut after_balances = balances.clone();
    after_balances[0] = balances[0]
        .checked_sub(paid_inputs)
        .ok_or(FrontierError::Insufficient)?;
    after_balances[4] = balances[4].checked_add(paid_inputs).ok_or(OVERFLOW)?;
    if !staged.create_inputs && (a[4].owner != p || a[4].data_len() != wa::wide_clash_inputs::SIZE)
    {
        return Err(BAD_ACCOUNT);
    }
    // Borrow full readonly state. Only the already-staged outputs allocate
    // data copies; large Province/Season/Holding bytes are never cloned here.
    let body = {
        let data = a
            .iter()
            .map(AccountInfo::try_borrow_data)
            .collect::<Result<Vec<_>, _>>()?;
        let before: Vec<receipt::AccountSnapshot<'_>> = a
            .iter()
            .enumerate()
            .map(|(i, ai)| receipt::AccountSnapshot {
                role: (i + 1) as u16,
                address: key(ai),
                owner: ai.owner.to_bytes(),
                present: !(ai.owner.as_array() == &frontier_abi::prologue::ids::SYSTEM_PROGRAM
                    && data[i].is_empty()),
                signer: ai.is_signer,
                writable: ai.is_writable,
                lamports: balances[i],
                data: &data[i],
            })
            .collect();
        let mut after = before.clone();
        after[0].lamports = after_balances[0];
        after[4].owner = p.to_bytes();
        after[4].present = true;
        after[4].lamports = after_balances[4];
        after[4].data = &staged.inputs;
        for (at, bytes) in &staged.bridges {
            after[*at].data = bytes;
        }
        let context = receipt::Context {
            command: &command,
            now_ts: now.ts,
            now_slot: now.slot,
            bell: bell_log(&hdr, now.ts),
            season: &data[1],
            evidence: &data[6],
        };
        receipt::prepare(
            &ctx,
            receipt::Target::Gather {
                destination: ih.dest,
            },
            &context,
            &before,
            &after,
            receipt::Outcomes::Gather(receipt::GatherOutcomes {
                create_inputs: staged.create_inputs,
                rent_inputs,
                paid_inputs,
                payer_debit: paid_inputs,
                arrivals_mask: ih.arrivals_mask,
                stamped_mask,
                n_present: ih.n_present,
                no_arrivals: ih.flags & wa::wide_clash_inputs::FLAG_NO_ARRIVALS != 0,
            }),
        )
        .map_err(|_| BAD_ACCOUNT)?
        .encode(&ctx)
        .map_err(|_| BAD_ACCOUNT)?
    };
    // Acquire EVERY mutable data and balance borrow simultaneously before
    // allocation or payment. This detects held reads and duplicate storage.
    // Release them before CPI, whose real System invocation needs the cells.
    {
        let mut data = Vec::new();
        let mut money = Vec::new();
        for &at in &writes {
            data.push(a[at].try_borrow_mut_data()?);
            money.push(a[at].try_borrow_mut_lamports()?);
        }
        for (j, _) in staged.bridges.iter().enumerate() {
            if data[j + 2].len() != OWNED_BRIDGE_LEN {
                return Err(BAD_ACCOUNT);
            }
        }
    }
    Ok(Prepared {
        staged,
        body,
        destination: ih.dest,
        season_id: hdr.id,
        season_bump: hdr.bump,
        rent_inputs,
        after_balances,
    })
}

/// Real private writer. All deterministic refusal precedes any effect. The
/// standard allocation branch can fail after a transfer; ordinary on-chain
/// transaction rollback applies, never a fake host CPI success or manual undo.
pub(super) fn execute(p: &Pubkey, a: &[AccountInfo], x: &wix::ExpeditionGather) -> R<()> {
    let plan = prepare(p, a, x)?;
    if plan.staged.create_inputs {
        init::init_with_seed(
            &a[0],
            &a[4],
            &a[1],
            &SeasonSigner::new(plan.season_id, plan.season_bump),
            &wa::clash_inputs_seed(plan.destination, x.bell),
            wa::wide_clash_inputs::SIZE,
            plan.rent_inputs,
            p,
        )?;
    }
    let mut writes = Vec::new();
    writes.push((4, a[4].try_borrow_mut_data()?));
    for (at, _) in &plan.staged.bridges {
        writes.push((*at, a[*at].try_borrow_mut_data()?));
    }
    // Verify all cells and balances before the first byte copy. Holding all
    // output borrows means a later output cannot fail after an earlier write.
    for (i, ai) in a.iter().enumerate() {
        if **ai.try_borrow_lamports()? != plan.after_balances[i] {
            return Err(BAD_ACCOUNT);
        }
    }
    if a[4].owner != p || writes[0].1.len() != plan.staged.inputs.len() {
        return Err(BAD_ACCOUNT);
    }
    for (j, (at, bytes)) in plan.staged.bridges.iter().enumerate() {
        if a[*at].owner != p || writes[j + 1].1.len() != bytes.len() {
            return Err(BAD_ACCOUNT);
        }
    }
    writes[0].1.copy_from_slice(&plan.staged.inputs);
    for (j, (_, bytes)) in plan.staged.bridges.iter().enumerate() {
        writes[j + 1].1.copy_from_slice(bytes);
    }
    solana_program::log::sol_log_data(&[receipt::PREFIX, &plan.body]);
    Ok(())
}

#[cfg(test)]
#[path = "wide_expedition_gather_exec_tests.rs"]
mod tests;
