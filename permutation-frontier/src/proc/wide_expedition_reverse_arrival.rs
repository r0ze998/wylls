//! Private original-destination Gather for the distinct reverse transport.
//! Uses the ORIGINAL four-slot quota and ClashInputs, never a parallel quota.
//! Missing inputs are allocated by the real System program with the Season
//! signer and fee evidence. No public wire, seal verdict or assertion of
//! historical producer execution belongs here.
use super::*;
use frontier_abi::layout::clash::{
    arrival as AR, arrival_day as AD, arrival_slot as AS, clash_inputs as CI,
};
use frontier_abi::log::EntityKind;
use frontier_abi::v2::layout::AccountKind as K2;
use frontier_abi::world_index::expedition::AccountResolver;
use frontier_abi::world_index::expedition_reverse_transport::{
    authenticate_pair, ReverseMarker, ReverseTransit, MARKER_LEN,
};

// payer(s,w), Season(r), original destination(r), anchor/archive(r),
// original ArrivalDay(r), original ArrivalSlot(r), original Holding(r),
// reverse transit(w), original ClashInputs(w); optional creation-only suffix
// instructions(r), System(r). No public instruction table.
const TABLE: &[ap::Group] = &[
    ap::Group {
        specs: &[
            ap::Spec {
                name: "payer",
                acc: ap::Acc::Any,
                signer: true,
                wr: ap::Wr::W,
            },
            ap::Spec {
                name: "season",
                acc: ap::Acc::Any,
                signer: false,
                wr: ap::Wr::R,
            },
            ap::Spec {
                name: "destination",
                acc: ap::Acc::Any,
                signer: false,
                wr: ap::Wr::R,
            },
            ap::Spec {
                name: "anchor",
                acc: ap::Acc::Any,
                signer: false,
                wr: ap::Wr::R,
            },
            ap::Spec {
                name: "day",
                acc: ap::Acc::Any,
                signer: false,
                wr: ap::Wr::R,
            },
            ap::Spec {
                name: "slot",
                acc: ap::Acc::Any,
                signer: false,
                wr: ap::Wr::R,
            },
            ap::Spec {
                name: "holding",
                acc: ap::Acc::Any,
                signer: false,
                wr: ap::Wr::R,
            },
            ap::Spec {
                name: "reverse",
                acc: ap::Acc::Any,
                signer: false,
                wr: ap::Wr::W,
            },
            ap::Spec {
                name: "inputs",
                acc: ap::Acc::Any,
                signer: false,
                wr: ap::Wr::W,
            },
        ],
        min: 1,
        max: 1,
    },
    ap::Group {
        specs: &[
            ap::Spec {
                name: "instructions",
                acc: ap::Acc::IxSysvar,
                signer: false,
                wr: ap::Wr::R,
            },
            ap::Spec {
                name: "system",
                acc: ap::Acc::System,
                signer: false,
                wr: ap::Wr::R,
            },
        ],
        min: 0,
        max: 1,
    },
];

struct Prepared {
    inputs: Vec<u8>,
    reverse: Vec<u8>,
    record: Vec<u8>,
    manifest: [u8; 97],
    repeated: bool,
    create_inputs: bool,
    rent: u64,
    payer_after: u64,
    inputs_after: u64,
    signer: SeasonSigner,
    coord: (i32, i32),
}

fn prepare(p: &Pubkey, a: &[AccountInfo], bell: u32, index: u8) -> R<Prepared> {
    let suffix = match a.len() {
        9 => 0,
        11 => 1,
        _ => return Err(FrontierError::TooManyAccounts.into()),
    };
    check_accounts(TopLevelShape(TABLE), a, Some(&[1, suffix]))?;
    prologue::top_level(TopLevelShape(TABLE))?;
    if index >= 4 {
        return Err(FrontierError::BadData.into());
    }
    for (i, ai) in a.iter().enumerate() {
        if ![0, 7, 8].contains(&i) && ai.is_writable {
            return Err(BAD_ACCOUNT);
        }
    }
    let [payer, season, destination, anchor, day, slot, holding, external, inputs, _suffix @ ..] =
        a
    else {
        return Err(BAD_ACCOUNT);
    };
    // Stronger than meta alias checks: host AccountInfo cells must not alias
    // under another key either. Refuse every borrow before staging or writes.
    for ai in a {
        let _d = ai.try_borrow_data()?;
        let _l = ai.try_borrow_lamports()?;
    }
    for i in [0, 7, 8] {
        for (j, ai) in a.iter().enumerate() {
            if i != j
                && (a[i].key == ai.key
                    || alloc::rc::Rc::ptr_eq(&a[i].data, &ai.data)
                    || alloc::rc::Rc::ptr_eq(&a[i].lamports, &ai.lamports))
            {
                return Err(BAD_ACCOUNT);
            }
        }
    }
    let now = prologue::now()?;
    let hdr = prologue::keeper(a, p, &[S::STATUS_RUNNING, S::STATUS_ENDED], now.ts)?;
    require_wide_season(season)?;
    let ctx = addr::ctx(&key(season), &p.to_bytes());
    let resolver = AccountResolver::for_season(&ctx).map_err(|_| BAD_ACCOUNT)?;
    if external.owner != p {
        return Err(BAD_ACCOUNT);
    }
    let reverse =
        ReverseTransit::from_bytes(&ctx, &external.try_borrow_data()?).map_err(|_| BAD_ACCOUNT)?;
    let t = reverse.transit();
    if t.arrive_bell != bell
        || bell >= hdr.end_bell
        || t.stamina_after > 120
        || (t.troops_after == 0 && t.stamina_after != 0)
    {
        return Err(BAD_ACCOUNT);
    }
    if t.state == MarchState::Departed {
        return Err(FrontierError::DepartureUnsettled.into());
    }
    if !matches!(
        t.state,
        MarchState::Settled | MarchState::DestroyedAtOrigin | MarchState::Gathered
    ) || (t.state == MarchState::Settled && t.troops_after < DESTROYED_BELOW)
    {
        return Err(BAD_ACCOUNT);
    }
    let dest = reverse.destination();
    let coord = resolver
        .adapter()
        .coord_of(&dest)
        .map_err(|_| BAD_ACCOUNT)?;
    let (pp, pq) = (coord.p as i16, coord.q as i16);
    expect_key(destination, &ctx.province(coord.p, coord.q))?;
    prologue::present_v2(destination, p, K2::Province, hdr.id)?;
    let pd = destination.try_borrow_data()?;
    let pr = Ro(&pd);
    if pr.i16(PV::P)? != pp || pr.i16(PV::Q)? != pq || pr.u32(PV::RESOLVED_NEXT)? > bell {
        return Err(BAD_ACCOUNT);
    }
    let region = permutation_rules::frontier::geometry::region_of(coord);
    let clock = SeasonClock::read(&season.try_borrow_data()?)?;
    crate::proc::clash::window_closed(p, &ctx, hdr.id, &clock, now.ts, bell, region, anchor)?;
    let host_id = resolver.legacy_host_id(&t.host).map_err(|_| BAD_ACCOUNT)?;
    expect_key(
        holding,
        &resolver.holding_address(&t.host).map_err(|_| BAD_ACCOUNT)?,
    )?;
    prologue::present_v2(holding, p, K2::Holding, hdr.id)?;
    let hd = holding.try_borrow_data()?;
    let hr = Ro(&hd);
    expect_key(
        holding,
        &ctx.holding(hr.i16(H::P)? as i32, hr.i16(H::Q)? as i32, hr.u8(H::SITE)?),
    )?;
    // Narrow first consumer: capture/released/older-history issuers refuse;
    // they must not silently become current-owner or metadata-only arrivals.
    if !matches!(hr.u8(H::STATE)?, H::STATE_FINAL | H::STATE_PROVISIONAL)
        || hr.u8(H::GEN)? != t.host.gen()
        || t.host.seq() >= hr.u32(H::HOST_SEQ)?
        || hr.arr::<32>(H::OWNER_CITIZEN)? != reverse.original_owner()
    {
        return Err(BAD_ACCOUNT);
    }
    let off = H::transit(reverse.slot() as usize);
    let marker = ReverseMarker::from_bytes(&ctx, hd.get(off..off + MARKER_LEN).ok_or(BAD_ACCOUNT)?)
        .map_err(|_| BAD_ACCOUNT)?;
    authenticate_pair(
        &ctx,
        &key(holding),
        reverse.slot(),
        &key(external),
        &marker,
        &reverse,
    )
    .map_err(|_| BAD_ACCOUNT)?;
    expect_key(day, &ctx.arrival_day(coord.p, coord.q, bell / 144))?;
    prologue::present(day, p, AccountKind::ArrivalDay, hdr.id)?;
    let dd = day.try_borrow_data()?;
    let dr = Ro(&dd);
    let (bit_at, bit) = AD::bit(bell);
    if dd.len() != AD::SIZE
        || dr.i16(AD::P)? != pp
        || dr.i16(AD::Q)? != pq
        || dr.u32(AD::DAY)? != bell / 144
        || dr.u8(bit_at)? & bit == 0
    {
        return Err(BAD_ACCOUNT);
    }
    expect_key(
        slot,
        &ctx.arrival_slot(coord.p, coord.q, bell, t.faction, index),
    )?;
    prologue::present(slot, p, AccountKind::ArrivalSlot, hdr.id)?;
    let sd = slot.try_borrow_data()?;
    let sr = Ro(&sd);
    if sd.len() != AS::SIZE
        || sr.i16(AS::P)? != pp
        || sr.i16(AS::Q)? != pq
        || sr.u32(AS::BELL)? != bell
        || sr.u8(AS::FACTION)? != t.faction
        || sr.u8(AS::I)? != index
        || sr.u64(AS::HOST_ID)? != host_id
        || sr.u64(AS::CITIZEN_TAG)? != addr::citizen_tag(&reverse.original_owner())
        || sr.u8(AS::UNIT)? != t.unit
        || sr.u32(AS::DEP_MASS)? != t.dep_mass
        || sr.u8(AS::FLAGS)? & !AS::FLAG_CREATED_DAY != 0
        || sr.u8(AS::CLAIMED)? > 1
        || sr.u8(AS::TILE)? >= 61
        || sr.u16(AS::RETREAT_BPS)? > 60000
        || sd[AS::RSV..].iter().any(|b| *b != 0)
    {
        return Err(BAD_ACCOUNT);
    }
    let stance = Stance::from_u8(sr.u8(AS::STANCE)?).ok_or(BAD_ACCOUNT)?;
    let dealt = hold::bps16(
        of_faction_v3(t.faction)
            .ok_or(BAD_ACCOUNT)?
            .dealt_bps(Posture::Stance(stance), true),
    )?;
    if sr.u16(AS::DEALT_BPS)? != dealt {
        return Err(BAD_ACCOUNT);
    }
    let worn = sr.u16(frontier_abi::v2::layout::s1::arrival::WORN_BPS)?;
    let next = reverse
        .gather_worn(&ctx, dest, worn)
        .map_err(|_| BAD_ACCOUNT)?;
    let nt = next.transit();
    expect_key(inputs, &ctx.clash_inputs(coord.p, coord.q, bell))?;
    let create_inputs = init::is_absent(inputs);
    let mut cd = if create_inputs {
        if suffix == 0 {
            return Err(FrontierError::TooManyAccounts.into());
        }
        let ev = evidence::read(&a[9], now.slot)?;
        let mut bytes = vec![0; CI::SIZE];
        crate::layout::init_header(&mut bytes, AccountKind::ClashInputs, hdr.id)?;
        let mut w = Rw(&mut bytes);
        w.set_i16(CI::P, pp)?;
        w.set_i16(CI::Q, pq)?;
        w.set_u32(CI::BELL, bell)?;
        w.set_arr(CI::RENT_TO, &key(payer))?;
        w.set_u64(CI::EV_SLOT, ev.slot)?;
        w.set_u64(CI::EV_PRICE, ev.price)?;
        w.set_u32(CI::EV_LIMIT, ev.limit)?;
        bytes
    } else {
        prologue::present(inputs, p, AccountKind::ClashInputs, hdr.id)?;
        inputs.try_borrow_data()?.to_vec()
    };
    let rent = init::rent(CI::SIZE)?;
    let input_balance = **inputs.try_borrow_lamports()?;
    let paid = if create_inputs {
        rent.saturating_sub(input_balance)
    } else {
        0
    };
    if paid != 0 && !init::is_absent(payer) {
        return Err(BAD_ACCOUNT);
    }
    let payer_after = (**payer.try_borrow_lamports()?)
        .checked_sub(paid)
        .ok_or(FrontierError::Insufficient)?;
    let inputs_after = input_balance.checked_add(paid).ok_or(OVERFLOW)?;
    let cr = Ro(&cd);
    if cd.len() != CI::SIZE
        || cr.i16(CI::P)? != pp
        || cr.i16(CI::Q)? != pq
        || cr.u32(CI::BELL)? != bell
        || cr.u8(CI::FLAGS)? != 0
        || cr.u32(CI::SETTLED_MASK)? != 0
        || cr.u32(CI::CAMP_MASK)? != 0
        || cr.u64(CI::POSTURE_MASK)? != 0
        || cr.u32(CI::RESOLVED_TS)? != 0
        || cr.arr::<32>(CI::RESOLVER)? != [0; 32]
        || cr.u32(CI::ARRIVALS_MASK)? & !CI::ALL_GATHERED != 0
    {
        return Err(BAD_ACCOUNT);
    }
    let initial_count = (0..CI::POSITIONS)
        .filter(|k| cd[CI::arrival(*k) + AR::PRESENT] == 1)
        .count();
    if cr.u8(CI::N_PRESENT)? as usize != initial_count
        || (0..CI::POSITIONS).any(|k| {
            cd[CI::arrival(k) + AR::PRESENT] > 1
                || (cr.u32(CI::ARRIVALS_MASK).unwrap_or(0) & (1 << k) == 0
                    && cd[CI::arrival(k)..CI::arrival(k) + AR::SIZE]
                        .iter()
                        .any(|b| *b != 0))
        })
    {
        return Err(BAD_ACCOUNT);
    }
    let k = CI::position(t.faction, index);
    let at = CI::arrival(k);
    let mask = cr.u32(CI::ARRIVALS_MASK)?;
    let mut rec = [0; AR::SIZE];
    let mut w = Rw(&mut rec);
    w.set_u64(AR::HOST_ID, host_id)?;
    w.set_u64(
        AR::CITIZEN_TAG,
        addr::citizen_tag(&reverse.original_owner()),
    )?;
    w.set_u32(AR::DEP_MASS, t.dep_mass)?;
    w.set_u32(AR::TROOPS, nt.troops_after)?;
    w.set_u16(
        AR::STAMINA,
        if nt.troops_after == 0 {
            0
        } else {
            frontier_abi::clash_model::arrival_stamina(
                nt.stamina_after,
                nt.depart_bell,
                nt.arrive_bell,
            )
        },
    )?;
    w.set_u16(AR::RETREAT, sr.u16(AS::RETREAT_BPS)?)?;
    w.set_u16(AR::DEALT, dealt)?;
    w.set_u8(AR::FACTION, t.faction)?;
    w.set_u8(AR::UNIT, t.unit)?;
    w.set_u8(AR::TILE, sr.u8(AS::TILE)?)?;
    w.set_u8(AR::STANCE, sr.u8(AS::STANCE)?)?;
    w.set_u8(AR::PRESENT, (nt.troops_after >= DESTROYED_BELOW) as u8)?;
    w.set_u8(
        AR::FATE,
        if nt.troops_after >= DESTROYED_BELOW {
            AR::FATE_NONE
        } else {
            AR::FATE_DESTROYED
        },
    )?;
    let repeated = mask & (1 << k) != 0;
    if repeated {
        if t.state != MarchState::Gathered || cd[at..at + AR::SIZE] != rec {
            return Err(BAD_ACCOUNT);
        }
    } else {
        if t.state == MarchState::Gathered || cd[at..at + AR::SIZE].iter().any(|b| *b != 0) {
            return Err(BAD_ACCOUNT);
        }
        cd[at..at + AR::SIZE].copy_from_slice(&rec);
        let count = (0..CI::POSITIONS)
            .filter(|k| cd[CI::arrival(*k) + AR::PRESENT] == 1)
            .count();
        Rw(&mut cd).set_u8(CI::N_PRESENT, count as u8)?;
        Rw(&mut cd).set_u32(CI::ARRIVALS_MASK, mask | (1 << k))?;
    }
    let mut record = [0; events::MAX_RECORD];
    let n = if repeated {
        0
    } else {
        let mut key12 = [0; 12];
        key12[..4].copy_from_slice(&coord.p.to_le_bytes());
        key12[4..8].copy_from_slice(&coord.q.to_le_bytes());
        key12[8..].copy_from_slice(&bell.to_le_bytes());
        let payload = Buf::<7>::new().u8(k as u8).u8(1).u32(mask | (1 << k)).u8(0);
        events::record(
            Kind::GATHER,
            bell_log(&hdr, now.ts),
            &key12,
            payload.get()?,
            &mut [events::Chained {
                entity: EntityKind::ClashInputs,
                data: &mut cd,
            }],
            &mut record,
        )?
    };
    let next_bytes = next.to_bytes().to_vec();
    // Independent private manifest supplements the original GATHER chain.
    // Every input/output raw byte (including chain headers), balance, owner
    // and ordered privilege is bound; the digest is never an authority token.
    use frontier_abi::world_index::{
        expedition_event::AccountSnapshot, expedition_reverse_reveal::raw_manifest_digest,
    };
    let data = a
        .iter()
        .map(AccountInfo::try_borrow_data)
        .collect::<Result<Vec<_>, _>>()?;
    let before = a
        .iter()
        .enumerate()
        .map(|(i, ai)| {
            Ok(AccountSnapshot {
                role: (i + 1) as u16,
                address: key(ai),
                owner: ai.owner.to_bytes(),
                present: !(ai.owner.as_array() == &ap::ids::SYSTEM_PROGRAM && data[i].is_empty()),
                signer: ai.is_signer,
                writable: ai.is_writable,
                lamports: **ai.try_borrow_lamports()?,
                data: &data[i],
            })
        })
        .collect::<R<Vec<_>>>()?;
    let mut after = before.clone();
    after[0].lamports = payer_after;
    after[7].data = &next_bytes;
    after[8].owner = p.to_bytes();
    after[8].present = true;
    after[8].lamports = inputs_after;
    after[8].data = &cd;
    let mut command = [0; 13];
    command[..8].copy_from_slice(b"PSRGATH1");
    command[8..12].copy_from_slice(&bell.to_le_bytes());
    command[12] = index;
    let input = raw_manifest_digest(
        &ctx,
        b"REVERSE-GATHER-v1",
        &command,
        now.ts,
        now.slot,
        &before,
        None,
    )
    .ok_or(BAD_ACCOUNT)?;
    let output = raw_manifest_digest(
        &ctx,
        b"REVERSE-GATHER-v1",
        &command,
        now.ts,
        now.slot,
        &after,
        Some(&record[..n]),
    )
    .ok_or(BAD_ACCOUNT)?;
    let mut manifest = [0; 97];
    manifest[0] = 1;
    manifest[1..33].copy_from_slice(&permutation_rules::hash::sha256(&[
        b"PSF-REVERSE-GATHER-OPERATION-v1",
        &input,
        &output,
    ]));
    manifest[33..65].copy_from_slice(&input);
    manifest[65..97].copy_from_slice(&output);
    drop(after);
    drop(before);
    drop(data);
    // Detect held data and balance borrows before a transfer/allocation CPI.
    // The actual System operation needs these cells released at invocation.
    {
        let _external = external.try_borrow_mut_data()?;
        let _inputs = inputs.try_borrow_mut_data()?;
        let _payer_money = payer.try_borrow_mut_lamports()?;
        let _input_money = inputs.try_borrow_mut_lamports()?;
    }
    Ok(Prepared {
        inputs: cd,
        reverse: next_bytes,
        record: record[..n].to_vec(),
        manifest,
        repeated,
        create_inputs,
        rent,
        payer_after,
        inputs_after,
        signer: SeasonSigner::new(hdr.id, hdr.bump),
        coord: (coord.p, coord.q),
    })
}

/// Reprepare from live AccountInfos; no external detached plan is executable.
/// Both mutable borrows are held before the first copy. No fallible operation
/// remains between writes. Only real allocation may debit the payer. A CPI
/// failure uses ordinary transaction rollback, never a syscall-success stub.
pub(super) fn execute(p: &Pubkey, a: &[AccountInfo], bell: u32, index: u8) -> R<()> {
    let plan = prepare(p, a, bell, index)?;
    if plan.repeated {
        return Ok(());
    }
    if plan.create_inputs {
        init::init_with_seed(
            &a[0],
            &a[8],
            &a[1],
            &plan.signer,
            &frontier_abi::addr::clash_inputs_seed(plan.coord.0, plan.coord.1, bell),
            CI::SIZE,
            plan.rent,
            p,
        )?;
    }
    let mut external = a[7].try_borrow_mut_data()?;
    let mut inputs = a[8].try_borrow_mut_data()?;
    if a[8].owner != p
        || external.len() != plan.reverse.len()
        || inputs.len() != plan.inputs.len()
        || **a[0].try_borrow_lamports()? != plan.payer_after
        || **a[8].try_borrow_lamports()? != plan.inputs_after
    {
        return Err(BAD_ACCOUNT);
    }
    external.copy_from_slice(&plan.reverse);
    inputs.copy_from_slice(&plan.inputs);
    solana_program::log::sol_log_data(&[frontier_abi::log::PREFIX, &plan.record]);
    solana_program::log::sol_log_data(&[b"PSRGA1", &plan.manifest]);
    Ok(())
}

#[cfg(test)]
#[path = "wide_expedition_reverse_arrival_tests.rs"]
mod tests;
