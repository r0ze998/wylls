//! Private original-to-wide retained ArrivalSlot cleanup. No wire admission.
//! Native v1 cleanup remains unchanged and cannot read these v2 records.
use super::*;
use frontier_abi::world_index::expedition_transport::ExpeditionArrivalSlot;

/// Same four/five accounts and timing policy as native CloseArrivalSlot.
/// Authentication is repeated in this call, not accepted as a staged verdict.
pub(super) fn close_slot(p: &Pubkey, a: &[AccountInfo]) -> R<()> {
    // The generic flag prologue reads balances infallibly. Refuse existing
    // exclusive borrows before constructing those views, without panicking.
    for account in a {
        let _balance = account.try_borrow_lamports()?;
        let _data = account.try_borrow_data()?;
    }
    // Different runtime keys cannot share the same backing cells. Reject
    // synthetic cross-key aliases before any eventual write or close.
    for (i, left) in a.iter().enumerate() {
        for right in &a[i + 1..] {
            if left.key != right.key
                && (alloc::rc::Rc::ptr_eq(&left.lamports, &right.lamports)
                    || alloc::rc::Rc::ptr_eq(&left.data, &right.data))
            {
                return Err(BAD_ACCOUNT);
            }
        }
    }
    check_accounts(Shape(wix::CLOSE_SLOT), a, None)?;
    let [_any, season, slot, rent_to, tail @ ..] = a else {
        return Err(FrontierError::TooManyAccounts.into());
    };
    // A signer may also receive its rent. No mutable account may alias a
    // structural input (or each other), even when the anchor is not needed.
    for (i, ai) in a.iter().enumerate() {
        if i != 2 && ai.key == slot.key {
            return Err(BAD_ACCOUNT);
        }
        if i != 0 && i != 3 && ai.key == rent_to.key {
            return Err(BAD_ACCOUNT);
        }
    }
    let now = prologue::now()?;
    let (sid, rules_apply, bell_log) = close_season(season, p, now.ts)?;
    let ctx = addr::ctx(&key(season), &p.to_bytes());
    if slot.owner != p {
        return Err(BAD_ACCOUNT);
    }
    // Strict v2 codec checks version, reserved bytes, wear, full original
    // identity, nonzero original owner and original-to-wide family binding.
    let expedition = ExpeditionArrivalSlot::read(&ctx, &slot.try_borrow_data()?)
        .map_err(|_| BAD_ACCOUNT)?;
    let s = expedition.common();
    if s.season_id != sid || s.dest.world() != world_of(&ctx)? {
        return Err(BAD_ACCOUNT);
    }
    expect_key(slot, &wa::arrival_slot_address(&ctx, s.dest, s.bell, s.faction, s.i))?;
    expect_key(rent_to, &s.rent_to)?;
    let settled = s.flags & wa::wide_arrival_slot::FLAG_SETTLED != 0;
    let anchor = match tail.first() {
        Some(an) if rules_apply && settled && !s.claimed => {
            expect_key(an, &ctx.bell_anchor(s.bell, absent_destination_region(s.dest.coord())))?;
            if prologue::presence(an, p, AccountKind::BellAnchor, sid)? {
                let a_ts = crate::layout::beacon::Anchor::read(&an.try_borrow_data()?)?.a;
                let clock = SeasonClock::read(&season.try_borrow_data()?)?;
                AnchorClose::At(clock.reveal_close(s.bell, a_ts))
            } else {
                AnchorClose::Archived
            }
        }
        _ => AnchorClose::NotListed,
    };
    if !slot_close_due(rules_apply, settled, s.claimed, anchor, now.ts) {
        return Err(FrontierError::TooEarly.into());
    }
    // Stages authenticated receipt, rejects overflow/under-rent payout and
    // probes all eventual mutable borrows before resize, assignment or debit.
    close_record_to_rent(p, slot, rent_to, bell_log, s.dest,
        (wix::CLOSE_WHAT_SLOT, s.bell, s.faction, s.i))
}

#[cfg(test)]
#[path = "wide_expedition_close_tests.rs"]
mod tests;
