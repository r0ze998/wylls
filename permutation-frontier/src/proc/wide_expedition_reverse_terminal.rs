//! Closed reverse-record cleanup after the existing terminal Season rule.
//! All roles and proof are re-read in this invocation. No caller can submit a
//! plan, outcome, balance or recipient; no part of embedded escrow is spent.
use super::*;
use crate::layout::holding2 as H2;
use frontier_abi::world_index::expedition::AccountResolver;
use frontier_abi::world_index::expedition_event::AccountSnapshot;
use frontier_abi::world_index::expedition_reverse_transport::{
    authenticate_pair, ReverseMarker, ReverseTransit, MARKER_LEN,
};
use frontier_abi::world_index::{
    expedition_reverse_terminal_event as event, expedition_reverse_terminal_ix as ix,
};

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

struct TerminalPlan {
    holding_marker_clear: Option<Vec<u8>>,
    external: [u8; 32],
    rent_to: [u8; 32],
    rent: u64,
    captured: bool,
    escrow_remaining: u64,
}

/// Season expiry alone authorizes this rent-only cleanup. No march deadline,
/// absent destination, lost roster or claimed seal outcome is terminal proof.
fn stage(p: &Pubkey, a: &[AccountInfo], slot_index: u8) -> R<TerminalPlan> {
    let [season, holding, external, rent_to] = a else {
        return Err(BAD_ACCOUNT);
    };
    let (sid, _, _) = season_end(season, p, prologue::now()?.ts)?;
    let ctx = addr::ctx(&key(season), &p.to_bytes());
    if external.owner != p {
        return Err(BAD_ACCOUNT);
    }
    let reverse =
        ReverseTransit::from_bytes(&ctx, &external.try_borrow_data()?).map_err(|_| BAD_ACCOUNT)?;
    let t = reverse.transit();
    let resolver = AccountResolver::for_season(&ctx).map_err(|_| BAD_ACCOUNT)?;
    expect_key(
        holding,
        &resolver.holding_address(&t.host).map_err(|_| BAD_ACCOUNT)?,
    )?;
    if reverse.slot() != slot_index {
        return Err(BAD_ACCOUNT);
    }
    expect_key(
        external,
        &wm::transit_address(&ctx, &key(holding), slot_index),
    )?;
    expect_key(rent_to, &t.rent_to)?;
    rent_to
        .try_lamports()?
        .checked_add(external.try_lamports()?)
        .ok_or(OVERFLOW)?;
    let mut captured = false;
    let mut escrow_remaining = 0;
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
        if t.host.gen() == r.u8(H::GEN)? {
            if t.host.seq() >= r.u32(H::HOST_SEQ)?
                || r.arr::<32>(H::OWNER_CITIZEN)? != reverse.original_owner()
            {
                return Err(BAD_ACCOUNT);
            }
        } else {
            // Same single-history consistency rule as original settlement.
            // Full owner authority is the immutable reverse record, never a
            // reconstructed identity from PREV_OWNER_TAG or the captor.
            if r.u8(H2::CAPTURE_FLAGS)? & H2::CAPTURE_FLAG_CAPTURED == 0
                || r.u8(H2::PREV_GEN)? != t.host.gen()
                || r.u64(H2::PREV_OWNER_TAG)? != addr::citizen_tag(&reverse.original_owner())
            {
                return Err(BAD_ACCOUNT);
            }
            captured = true;
        }
        let off = H::transit(slot_index as usize);
        let marker =
            ReverseMarker::from_bytes(&ctx, hd.get(off..off + MARKER_LEN).ok_or(BAD_ACCOUNT)?)
                .map_err(|_| BAD_ACCOUNT)?;
        authenticate_pair(
            &ctx,
            &key(holding),
            slot_index,
            &key(external),
            &marker,
            &reverse,
        )
        .map_err(|_| BAD_ACCOUNT)?;
        escrow_remaining = r.u64(H::ESCROW)?;
        // No fee/bond rate can be reconstructed from a Closed tombstone. This
        // operation never consumes any ledger amount or moves Holding funds.
        // CloseHolding later sweeps pool_owed and closes all remaining funds,
        // including unsettled transit escrow, to H::RENT_PAYER.
        hd[off..off + MARKER_LEN].fill(0);
        Some(hd)
    } else {
        None
    };
    Ok(TerminalPlan {
        holding_marker_clear,
        external: key(external),
        rent_to: t.rent_to,
        rent: external.try_lamports()?,
        captured,
        escrow_remaining,
    })
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
        if ai.executable || ai.is_writable != (i > 0) {
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
    let plan = stage(p, a, command.slot())?;
    let ctx = addr::ctx(&key(&a[0]), &p.to_bytes());
    let bridge = ReverseTransit::from_bytes(&ctx, &before[2].data).map_err(|_| BAD_ACCOUNT)?;
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
        captured: plan.captured,
        escrow_remaining: plan.escrow_remaining,
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
#[path = "wide_expedition_reverse_terminal_tests.rs"]
mod tests;
