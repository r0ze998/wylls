//! Host-only wide evidence against the deployed, shared defence allowance.
//! No slot closes here. The per-region cap is deliberately per call, as in
//! the deployed handler; this does not invent a global region counter.
use super::*;
use crate::layout::{defence_claim as DC, defence_pool as DP, init_header};
use crate::proc::defence::{refund, Caps};
use frontier_abi::addr::{day_of, defence_claim_seed, keeper_tag8};

pub(super) fn claim_defence(p: &Pubkey, a: &[AccountInfo], x: &wix::ClaimDefence) -> R<()> {
    if x.n == 0 || x.n as usize > DC::MAX_SLOTS {
        return Err(FrontierError::BadData.into());
    }
    check_accounts(Shape(wix::CLAIM_DEFENCE), a, Some(&[1, x.n]))?;
    let [keeper, season, pool, claim, _system, rest @ ..] = a else {
        return Err(FrontierError::TooManyAccounts.into());
    };
    let now = prologue::now()?;
    let hdr = settle_season(season, p, now.ts)?;
    let now_bell = hdr.bell(now.ts).ok_or(FrontierError::WrongStatus)?;
    if day_of(now_bell) != x.day {
        return Err(FrontierError::BadData.into());
    }
    let ctx = addr::ctx(&key(season), &p.to_bytes());
    let world = world_of(&ctx)?;
    let beneficiary = key(keeper);
    expect_key(pool, &ctx.defence_pool())?;
    prologue::present(pool, p, AccountKind::DefencePool, hdr.id)?;
    let seed = defence_claim_seed(&keeper_tag8(&beneficiary), x.day);
    expect_key(claim, &ctx.of(&seed))?;
    let present = prologue::presence(claim, p, AccountKind::DefenceClaim, hdr.id)?;
    let mut claim_stage = if present {
        let d = claim.try_borrow_data()?;
        let r = Ro(&d);
        if r.arr::<32>(DC::BENEFICIARY)? != beneficiary || r.u32(DC::DAY)? != x.day {
            return Err(BAD_ACCOUNT);
        }
        d.to_vec()
    } else {
        let mut d = alloc::vec![0; DC::SIZE];
        init_header(&mut d, AccountKind::DefenceClaim, hdr.id)?;
        Rw(&mut d).set_arr(DC::BENEFICIARY, &beneficiary)?;
        Rw(&mut d).set_u32(DC::DAY, x.day)?;
        d
    };
    let claimed = Ro(&claim_stage).u64(DC::CLAIMED)?;
    let (clock, lateness, params) = {
        let d = season.try_borrow_data()?;
        let r = Ro(&d);
        (
            SeasonClock::read(&d)?,
            r.u8(S::LATENESS_SLOTS)?,
            DefenceParams {
                defence_cap_milli: r.u32(S::DEFENCE_CAP_MILLI)?,
                tip_min: fees::min_tip_lamports(
                    r.u32(S::MIN_REVEAL_PRIORITY_MILLI)?,
                    r.u32(S::REVEAL_CU_LIMIT)?,
                    r.u32(S::REVEAL_LOADED_LIMIT)?,
                ),
            },
        )
    };
    let mut pool_stage = pool.try_borrow_data()?.to_vec();
    let region_cap = Ro(&pool_stage).u64(DP::PER_BELL_REGION_CAP)?;
    let day_cap = Ro(&pool_stage).u64(DP::PER_KEEPER_DAY_CAP)?;
    let mut caps = Caps::default();
    let mut total = 0u64;
    let mut slots = Vec::with_capacity(x.n as usize);
    for i in 0..x.n as usize {
        let slot = &rest[2 * i];
        let anchor = &rest[2 * i + 1];
        if (0..i).any(|j| rest[2 * j].key == slot.key) {
            return Err(FrontierError::NotEligible.into());
        }
        if slot.owner != p {
            return Err(BAD_ACCOUNT);
        }
        let mut d = slot.try_borrow_data()?.to_vec();
        let mut s = WideArrivalSlot::read(&d).map_err(|_| BAD_ACCOUNT)?;
        if s.season_id != hdr.id || s.dest.world() != world {
            return Err(BAD_ACCOUNT);
        }
        expect_key(
            slot,
            &wa::arrival_slot_address(&ctx, s.dest, s.bell, s.faction, s.i),
        )?;
        if s.beneficiary != beneficiary || s.claimed {
            return Err(FrontierError::NotEligible.into());
        }
        let region = wr::wide_region(s.dest.coord());
        expect_key(anchor, &ctx.bell_anchor(s.bell, region))?;
        if !prologue::presence(anchor, p, AccountKind::BellAnchor, hdr.id)? {
            return Err(FrontierError::NoAnchor.into());
        }
        let (anchor_slot, grace_end) = {
            let d = anchor.try_borrow_data()?;
            let r = Ro(&d);
            if r.u32(BA::BELL)? != s.bell || r.u8(BA::REGION)? != region {
                return Err(BAD_ACCOUNT);
            }
            (
                r.u64(BA::SLOT)?,
                clock
                    .reveal_close(s.bell, r.i64(BA::A)?)
                    .checked_add(DC::CLAIM_GRACE_BELLS as i64 * 600)
                    .ok_or(OVERFLOW)?,
            )
        };
        if now.ts >= grace_end {
            return Err(FrontierError::WindowClosed.into());
        }
        if s.ev_slot.saturating_sub(anchor_slot) < lateness as u64 {
            return Err(FrontierError::NotEligible.into());
        }
        let amount = refund(&s.evidence(), &params);
        if amount == 0 {
            return Err(FrontierError::NotEligible.into());
        }
        total = total
            .checked_add(caps.admit(s.bell, region, amount, region_cap))
            .ok_or(OVERFLOW)?;
        s.claimed = true;
        s.write(&mut d).map_err(|_| BAD_ACCOUNT)?;
        slots.push(d);
    }
    let capped = total.min(day_cap.saturating_sub(claimed));
    let paid = capped.min(pool.try_lamports()?.saturating_sub(init::rent(DP::SIZE)?));
    Rw(&mut claim_stage).add_u64(DC::CLAIMED, paid)?;
    Rw(&mut claim_stage).add_u32(DC::COUNT, x.n as u32)?;
    Rw(&mut pool_stage).add_u64(DP::PAID_TOTAL, paid)?;
    Rw(&mut pool_stage).add_u64(DP::CLAIMS, x.n as u64)?;
    let rent = init::rent(DC::SIZE)?;
    let needed = if present {
        0
    } else {
        rent.saturating_sub(claim.try_lamports()?)
    };
    let keeper_after = keeper
        .try_lamports()?
        .checked_sub(needed)
        .ok_or(FrontierError::Insufficient)?
        .checked_add(paid)
        .ok_or(OVERFLOW)?;
    let pool_after = pool.try_lamports()?.checked_sub(paid).ok_or(OVERFLOW)?;
    let payload = Buf::<14>::new()
        .u32(x.day)
        .u8(x.n)
        .u64(paid)
        .u8((paid < capped) as u8);
    let mut record = [0; events::MAX_RECORD];
    let record_len = events::record(
        Kind::DEFENCE_CLAIM,
        now_bell,
        &beneficiary,
        payload.get()?,
        &mut [],
        &mut record,
    )?;
    // Probe every eventual mutable borrow before allocation. These are
    // released for the System CPI; its failures need runtime rollback.
    if !present {
        let pd = pool.try_borrow_mut_data()?;
        let cd = claim.try_borrow_mut_data()?;
        let mut sd = Vec::with_capacity(slots.len());
        for i in 0..slots.len() {
            sd.push(rest[2 * i].try_borrow_mut_data()?);
        }
        let _kl = keeper.try_borrow_mut_lamports()?;
        let _pl = pool.try_borrow_mut_lamports()?;
        let _cl = claim.try_borrow_mut_lamports()?;
        if pd.len() != pool_stage.len()
            || !cd.is_empty()
            || sd.iter().zip(&slots).any(|(d, s)| d.len() != s.len())
        {
            return Err(BAD_ACCOUNT);
        }
        drop((pd, cd, sd, _kl, _pl, _cl));
        init::init_with_seed(
            keeper,
            claim,
            season,
            &SeasonSigner::new(hdr.id, hdr.bump),
            &seed,
            DC::SIZE,
            rent,
            p,
        )?;
    }
    // Acquire *all* borrows and check every length before any write. The
    // existing-account path is atomic even under direct host dispatch.
    let mut pd = pool.try_borrow_mut_data()?;
    let mut cd = claim.try_borrow_mut_data()?;
    let mut sd = Vec::with_capacity(slots.len());
    for i in 0..slots.len() {
        sd.push(rest[2 * i].try_borrow_mut_data()?);
    }
    let mut kl = keeper.try_borrow_mut_lamports()?;
    let mut pl = pool.try_borrow_mut_lamports()?;
    if pd.len() != pool_stage.len()
        || cd.len() != claim_stage.len()
        || sd.iter().zip(&slots).any(|(d, s)| d.len() != s.len())
    {
        return Err(BAD_ACCOUNT);
    }
    pd.copy_from_slice(&pool_stage);
    cd.copy_from_slice(&claim_stage);
    for (d, s) in sd.iter_mut().zip(&slots) {
        d.copy_from_slice(s);
    }
    **kl = keeper_after;
    **pl = pool_after;
    solana_program::log::sol_log_data(&[frontier_abi::log::PREFIX, &record[..record_len]]);
    Ok(())
}
