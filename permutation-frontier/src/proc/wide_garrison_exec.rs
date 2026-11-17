//! Host-only WideGarrison: deployed positive reinforcement rules, with
//! every byte and receipt chain staged before any live account write.
use super::{holding_at, holding_err, player_start_as, province_at, world_of, Shape};
use crate::addr;
use crate::error::{BAD_ACCOUNT, OVERFLOW};
use crate::layout::{
    chain_of, citizen as C, holding as H, province as P, set_chain, site as SM, Ro, Rw,
};
use crate::proc::conquest::capture_lock;
use crate::proc::holding::{read_holding, site_of, terrain_ore, touch, write_holding};
use crate::proc::host::{host_err, GARRISON_UNIT};
use crate::proc::Auth;
use crate::prologue::{self, check_accounts, expect_key, key};
use crate::{FrontierError, R};
use alloc::vec::Vec;
use frontier_abi::prologue as ap;
use frontier_abi::world_index::economy::{economy_key, Snapshots};
use frontier_abi::world_index::event::{self as wev, GarrisonReceipt, WideEntity, WideKind};
use frontier_abi::world_index::holding::{self as wh, HoldingError, SlotBinding};
use frontier_abi::world_index::land as wl;
use frontier_abi::world_index::wide_ix as wix;
use frontier_abi::world_index::{ProvinceKey, WideHostRef};
use permutation_rules::fixed::MILLI;
use permutation_rules::frontier::host::{GarrisonState, MAX_HOST_TROOPS};
use solana_program::{account_info::AccountInfo, pubkey::Pubkey};

pub(super) fn garrison_as(p: &Pubkey, a: &[AccountInfo], x: &wix::Garrison, auth: &Auth) -> R<()> {
    check_accounts(Shape(wix::WideCommand::Garrison(*x).accounts()), a, None)?;
    let [_, _, season_ai, citizen, holding, province] = a else {
        return Err(FrontierError::TooManyAccounts.into());
    };
    let now = prologue::now()?;
    let start = player_start_as(p, a, now.ts, auth)?;
    let hdr = start.season;
    let now_bell = hdr.bell(now.ts).ok_or(FrontierError::WrongStatus)?;
    let ctx = addr::ctx(&key(season_ai), &p.to_bytes());
    let world = world_of(&ctx)?;
    let h = holding_at(holding, p, hdr.id)?.ok_or(BAD_ACCOUNT)?;
    if h.world != world {
        return Err(BAD_ACCOUNT);
    }
    expect_key(holding, &wh::holding_address(&ctx, h.coord, h.site))?;
    if h.owner_citizen != key(citizen) {
        return Err(FrontierError::NotOwner.into());
    }
    expect_key(province, &wl::province_address(&ctx, h.coord))?;
    let prov = province_at(province, p, hdr.id)?.ok_or(BAD_ACCOUNT)?;
    if prov.world != world || prov.coord != h.coord {
        return Err(BAD_ACCOUNT);
    }
    if key(citizen) == key(holding)
        || key(citizen) == key(province)
        || key(holding) == key(province)
    {
        return Err(BAD_ACCOUNT);
    }
    let season_in = season_ai.try_borrow_data()?.to_vec();
    let citizen_in = citizen.try_borrow_data()?.to_vec();
    let holding_in = holding.try_borrow_data()?.to_vec();
    let province_in = province.try_borrow_data()?.to_vec();
    if wh::binding_of(&citizen_in, h.slot).map_err(holding_err)? != SlotBinding::Wide {
        return Err(holding_err(HoldingError::NotWideBound(h.slot)));
    }
    let r = Ro(&holding_in);
    if r.u8(H::ORDER)? != h.slot {
        return Err(BAD_ACCOUNT);
    }
    let mut citizen_out = citizen_in.clone();
    start.finish(&mut citizen_out, now.ts)?;
    Rw(&mut citizen_out).set_i64(C::LAST_ACTION_TS, now.ts)?;
    let mut holding_out = holding_in.clone();
    let mut province_out = province_in.clone();
    // Same body and order as host::garrison_as, but exclusively on copies.
    let hh = ap::HoldingHdr {
        p: 0,
        q: 0,
        site: h.site,
        gen: h.gen,
        state: r.u8(H::STATE)?,
        ticket_bell: r.u32(H::TICKET_BELL)?,
        final_ts: r.i64(H::FINAL_TS)?,
    };
    if hh.state != H::STATE_PROVISIONAL && hh.state != H::STATE_FINAL {
        return Err(FrontierError::NotFinal.into());
    }
    capture_lock(&province_in, hh.site, hh.gen)?;
    let became_final = ap::finality_due(&hh, &province_in, now.ts, now_bell);
    if became_final {
        Rw(&mut holding_out).set_u8(H::STATE, H::STATE_FINAL)?;
    }
    let mut economic = read_holding(&holding_out)?;
    touch(&mut economic, now.ts, terrain_ore(&holding_out)?)?;
    if !became_final && hh.state != H::STATE_FINAL {
        return Err(FrontierError::NotFinal.into());
    }
    let rn = Ro(&province_in).u32(P::RESOLVED_NEXT)?;
    if !ap::resident_ok(rn, now_bell) {
        return Err(FrontierError::NotResident.into());
    }
    if x.delta <= 0 || x.delta > u32::MAX as i64 {
        return Err(FrontierError::BadData.into());
    }
    let have = r.u32(H::reserve(GARRISON_UNIT))?;
    if have < x.delta as u32 {
        return Err(FrontierError::Insufficient.into());
    }
    let delta_milli = x.delta.checked_mul(MILLI).ok_or(OVERFLOW)?;
    let site = site_of(&province_in, &hh)?;
    let mut g = garrison_of(&province_in, site)?;
    // The deployed room arithmetic subtracts the projected pending total
    // in i64. Reject an unrepresentable stored state before calling it.
    // Settle on this copy first, exactly as change does, so an already-due
    // extreme delta that the kernel safely clamps is not falsely rejected.
    let mut range_check = g;
    range_check.settle(rn);
    let projected = range_check
        .pending
        .iter()
        .flatten()
        .fold(range_check.troops as i64, |n, (_, delta)| {
            n.saturating_add(*delta)
        });
    if (MAX_HOST_TROOPS as i64).checked_sub(projected).is_none() {
        return Err(BAD_ACCOUNT);
    }
    g.change(now_bell, delta_milli, rn)
        .map_err(|e| host_err(e, FrontierError::NotResident))?;
    put_garrison(&mut province_out, site, &g)?;
    write_holding(&mut holding_out, &economic, now.ts)?;
    Rw(&mut holding_out).set_u32(H::reserve(GARRISON_UNIT), have - x.delta as u32)?;
    let href = WideHostRef::new(ProvinceKey::new(world, h.coord), h.site, h.gen, 0)
        .map_err(|_| BAD_ACCOUNT)?;
    let input_digest = wev::garrison_input_digest(
        &href,
        x.delta,
        now.ts,
        &season_in,
        &Snapshots {
            citizen: &citizen_in,
            holding: &holding_in,
            province: &province_in,
        },
    )
    .map_err(|_| BAD_ACCOUNT)?;
    let output_digest = wev::garrison_output_digest(
        &href,
        x.delta,
        now.ts,
        became_final,
        &Snapshots {
            citizen: &citizen_out,
            holding: &holding_out,
            province: &province_out,
        },
    )
    .map_err(|_| BAD_ACCOUNT)?;
    let receipt = GarrisonReceipt {
        delta: x.delta,
        now_ts: now.ts,
        became_final,
        input_digest,
        output_digest,
    };
    let kind = WideKind::Garrison;
    let payload = receipt.to_bytes().ok_or(BAD_ACCOUNT)?;
    let ekey = economy_key(&href).map_err(|_| BAD_ACCOUNT)?;
    let mut body = [0u8; wev::MAX_BODY];
    let n = wev::write_body(kind, now_bell, &ekey, &payload, &mut body).ok_or(BAD_ACCOUNT)?;
    let mut links = Vec::with_capacity(wev::MAX_LINKS);
    for entity in kind.links() {
        let data = match entity {
            WideEntity::Province => &mut province_out,
            WideEntity::Holding => &mut holding_out,
        };
        let (seq, head) = chain_of(data.as_slice())?;
        let link = wev::advance(*entity, seq, &head, &body[..n]).ok_or(OVERFLOW)?;
        set_chain(data.as_mut_slice(), link.seq, &link.head)?;
        links.push(link);
    }
    let m = wev::write_tail(kind, &links, &mut body, n).ok_or(BAD_ACCOUNT)?;
    // All borrows and lengths before the first write; no fallible operation
    // follows the first copy. The log is published only after the commit.
    {
        let mut cd = citizen.try_borrow_mut_data()?;
        let mut hd = holding.try_borrow_mut_data()?;
        let mut pd = province.try_borrow_mut_data()?;
        if cd.len() != citizen_out.len()
            || hd.len() != holding_out.len()
            || pd.len() != province_out.len()
        {
            return Err(BAD_ACCOUNT);
        }
        cd.copy_from_slice(&citizen_out);
        hd.copy_from_slice(&holding_out);
        pd.copy_from_slice(&province_out);
    }
    solana_program::log::sol_log_data(&[wev::WIDE_LOG_PREFIX, &body[..m]]);
    Ok(())
}

// Byte-for-byte codec semantics of host::{garrison_of, put_garrison}.
// Wide provinces retain this exact deployed site prefix.
fn garrison_of(pd: &[u8], site: usize) -> R<GarrisonState> {
    let r = Ro(pd);
    let o = P::site(site);
    let slot = |b: usize, dl: usize| -> R<Option<(u32, i64)>> {
        let (bell, delta) = (r.u32(o + b)?, r.i64(o + dl)?);
        Ok((bell != SM::NO_BELL && delta != 0).then_some((bell, delta)))
    };
    Ok(GarrisonState {
        troops: r.u32(o + SM::GARRISON)?,
        pending: [
            slot(SM::PEND0_BELL, SM::PEND0_DELTA)?,
            slot(SM::PEND1_BELL, SM::PEND1_DELTA)?,
        ],
    })
}

fn put_garrison(pd: &mut [u8], site: usize, g: &GarrisonState) -> R<()> {
    let o = P::site(site);
    let mut w = Rw(pd);
    w.set_u32(o + SM::GARRISON, g.troops)?;
    for (k, (b, dl)) in [
        (SM::PEND0_BELL, SM::PEND0_DELTA),
        (SM::PEND1_BELL, SM::PEND1_DELTA),
    ]
    .into_iter()
    .enumerate()
    {
        let (bell, delta) = g.pending[k].unwrap_or((SM::NO_BELL, 0));
        w.set_u32(o + b, bell)?;
        w.set_i64(o + dl, delta)?;
    }
    Ok(())
}
