//! Closed original bridge cleanup after the existing terminal Season rule.
//! All roles and proof are re-read in this invocation. No caller can submit a
//! plan, outcome, balance or recipient; no part of embedded escrow is spent.
use super::*;
use frontier_abi::world_index::expedition_event::AccountSnapshot;
use frontier_abi::world_index::{expedition_terminal_event as event, expedition_terminal_ix as ix};

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
        .map(|(i, a)| AccountSnapshot {
            role: (i + 1) as u16,
            address: a.address,
            owner: a.owner,
            present: a.present,
            signer: a.signer,
            writable: a.writable,
            lamports: a.lamports,
            data: &a.data,
        })
        .collect()
}

pub(super) fn execute_draft(p: &Pubkey, a: &[AccountInfo], d: &[u8]) -> R<()> {
    let command = ix::DraftCommand::decode(d)?;
    if a.len() != ix::ACCOUNT_COUNT {
        return Err(FrontierError::TooManyAccounts.into());
    }
    // No alias is needed by this contract. Reject both duplicate keys and
    // synthetic cross-key storage, and probe fallible borrows before helpers
    // that inspect balances through AccountInfo::lamports.
    let mut before = Vec::new();
    for (i, ai) in a.iter().enumerate() {
        if ai.executable || (i > 0 && !ai.is_writable) {
            return Err(BAD_ACCOUNT);
        }
        for other in &a[..i] {
            if ai.key == other.key
                || alloc::rc::Rc::ptr_eq(&ai.data, &other.data)
                || alloc::rc::Rc::ptr_eq(&ai.lamports, &other.lamports)
            {
                return Err(BAD_ACCOUNT);
            }
        }
        let lamports = ai.try_lamports()?;
        let data = ai.try_borrow_data()?.to_vec();
        before.push(Snapshot {
            address: key(ai),
            owner: ai.owner.to_bytes(),
            present: !init::is_absent(ai),
            signer: ai.is_signer,
            writable: ai.is_writable,
            lamports,
            data,
        });
    }
    let plan = stage_terminal(p, a, command.slot())?;
    let ctx = addr::ctx(&key(&a[0]), &p.to_bytes());
    let bridge = OwnedBridgeTransit::from_bytes(&ctx, &before[2].data).map_err(|_| BAD_ACCOUNT)?;
    if plan.external != before[2].address
        || plan.rent_to != before[3].address
        || plan.rent != before[2].lamports
    {
        return Err(BAD_ACCOUNT);
    }
    let now = prologue::now()?;
    let holding_present = plan.holding_marker_clear.is_some();
    let mut after = before.clone();
    if let Some(data) = plan.holding_marker_clear {
        after[1].data = data;
    }
    after[2].data.clear();
    after[2].lamports = 0;
    after[2].owner = init::SYSTEM.to_bytes();
    after[2].present = false;
    after[3].lamports = after[3].lamports.checked_add(plan.rent).ok_or(OVERFLOW)?;
    let receipt = event::Receipt {
        slot: command.slot(),
        holding_present,
        now_ts: now.ts,
        now_slot: now.slot,
        host: bridge.transit().host,
        original_owner: bridge.original_owner(),
        rent_to: plan.rent_to,
        rent: plan.rent,
        input: event::manifest(&ctx, d, now.ts, now.slot, &manifest(&before)),
        output: event::manifest(&ctx, d, now.ts, now.slot, &manifest(&after)),
    }
    .to_bytes(&ctx)
    .map_err(|_| BAD_ACCOUNT)?;
    // Acquire every eventual mutable borrow before the first effect. Resize
    // is the only remaining fallible operation; its guard is released alone.
    let mut holding = if holding_present {
        Some(a[1].try_borrow_mut_data()?)
    } else {
        None
    };
    let external = a[2].try_borrow_mut_data()?;
    let mut external_balance = a[2].try_borrow_mut_lamports()?;
    let mut recipient_balance = a[3].try_borrow_mut_lamports()?;
    drop(external);
    a[2].resize(0)?;
    a[2].assign(&init::SYSTEM);
    if let Some(ref mut bytes) = holding {
        bytes.copy_from_slice(&after[1].data);
    }
    **external_balance = 0;
    **recipient_balance = after[3].lamports;
    solana_program::log::sol_log_data(&[event::PREFIX, &receipt]);
    Ok(())
}

#[cfg(all(test, feature = "runtime-contract-tests", not(target_os = "solana")))]
#[path = "wide_expedition_terminal_tests.rs"]
mod tests;
