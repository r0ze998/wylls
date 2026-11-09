//! Closed candidate for an original-origin host that is already resident wide.
//! The isolated draft codec is not publicly recognized or dispatched. These retain
//! original ownership/issuance/capture/transit checks and stage paired receipts
//! before effects. Current-generation live source only: captured previous
//! generations, stranded cleanup and reverse sealed marches remain unsupported.
use super::*;
use alloc::rc::Rc;
use frontier_abi::entry::{find_entry, read_entry, unit_from_u8, write_entry, Entry};
use frontier_abi::world_index::expedition::AccountResolver;
use frontier_abi::world_index::expedition_resident_event as receipt;

use frontier_abi::world_index::expedition_resident_ix::{DISSOLVE, RETURN};

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
fn snapshots(a: &[AccountInfo], actor_pair: bool) -> R<Vec<Snapshot>> {
    for (i, ai) in a.iter().enumerate() {
        if ai.executable {
            return Err(BAD_ACCOUNT);
        }
        for (j, aj) in a[..i].iter().enumerate() {
            let same = ai.key == aj.key;
            if same != Rc::ptr_eq(&ai.data, &aj.data)
                || same != Rc::ptr_eq(&ai.lamports, &aj.lamports)
                || (same
                    && (!actor_pair
                        || (j, i) != (0, 1)
                        || ai.owner != aj.owner
                        || ai.is_signer != aj.is_signer
                        || ai.is_writable != aj.is_writable))
            {
                return Err(BAD_ACCOUNT);
            }
        }
    }
    a.iter()
        .map(|a| {
            Ok(Snapshot {
                address: key(a),
                owner: a.owner.to_bytes(),
                present: !init::is_absent(a),
                signer: a.is_signer,
                writable: a.is_writable,
                lamports: a.try_lamports()?,
                data: a.try_borrow_data()?.to_vec(),
            })
        })
        .collect()
}
fn manifest(s: &[Snapshot]) -> Vec<receipt::AccountSnapshot<'_>> {
    s.iter()
        .enumerate()
        .map(|(i, s)| receipt::AccountSnapshot {
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

/// Source address, family, current generation, issuance and original capture
/// lock are re-read in each call. A stale captured generation never credits a
/// captor's reserve. Embedded original transit/bridge markers remain authority.
fn source(
    p: &Pubkey,
    ctx: &AddrCtx,
    sid: u64,
    host: WideHostRef,
    holding: &AccountInfo,
    home: &AccountInfo,
) -> R<([u8; 32], u64)> {
    let resolver = AccountResolver::for_season(ctx).map_err(|_| BAD_ACCOUNT)?;
    let id = resolver.legacy_host_id(&host).map_err(|_| BAD_ACCOUNT)?;
    if resolver.legacy_host_ref(id).map_err(|_| BAD_ACCOUNT)? != host {
        return Err(BAD_ACCOUNT);
    }
    expect_key(
        holding,
        &resolver.holding_address(&host).map_err(|_| BAD_ACCOUNT)?,
    )?;
    prologue::present_v2(
        holding,
        p,
        frontier_abi::v2::layout::AccountKind::Holding,
        sid,
    )?;
    check_source_province(p, ctx, sid, holding, home)?;
    let hd = holding.try_borrow_data()?;
    let r = Ro(&hd);
    let parts = frontier_abi::addr::split_host_id(id).ok_or(BAD_ACCOUNT)?;
    if r.i16(H::P)? as i32 != parts.province.p
        || r.i16(H::Q)? as i32 != parts.province.q
        || r.u8(H::SITE)? != parts.site
        || r.u8(H::GEN)? != host.gen()
        || !matches!(r.u8(H::STATE)?, H::STATE_PROVISIONAL | H::STATE_FINAL)
    {
        return Err(FrontierError::NotOwner.into());
    }
    if host.seq() >= r.u32(H::HOST_SEQ)? {
        return Err(BAD_ACCOUNT);
    }
    if ap::host_in_transit_with_bridge(ctx, &key(holding), &hd, id)? {
        return Err(FrontierError::HostInTransit.into());
    }
    let citizen = r.arr::<32>(H::OWNER_CITIZEN)?;
    if citizen == [0; 32] {
        return Err(BAD_ACCOUNT);
    }
    Ok((citizen, id))
}

fn resident(
    p: &Pubkey,
    ctx: &AddrCtx,
    sid: u64,
    host: WideHostRef,
    standing: &AccountInfo,
    roster_ai: &AccountInfo,
) -> R<(ProvinceKey, WideRoster, usize, Entry)> {
    let world = world_of(ctx)?;
    let prov = canonical_province(standing, p, ctx, sid, world)?;
    let k = ProvinceKey::new(world, prov.coord);
    expect_key(roster_ai, &wro::roster_address(ctx, k))?;
    let roster = roster_at(roster_ai, p, sid, k)?.ok_or(FrontierError::AlreadyDone)?;
    let pd = standing.try_borrow_data()?;
    let rd = roster_ai.try_borrow_data()?;
    roster
        .validate_paired(&rd, &wres::live_ids(&pd).map_err(resolve_err)?)
        .map_err(|_| BAD_ACCOUNT)?;
    let index = find_entry(&pd, wide_host_alias(&host)).ok_or(FrontierError::AlreadyDone)?;
    let e = read_entry(&pd, index).map_err(|_| BAD_ACCOUNT)?;
    if !roster.entry_matches(&rd, index, e.id, &host)
        || unit_from_u8(e.unit).is_none()
        || e.unit as usize >= H::RESERVE_N
    {
        return Err(BAD_ACCOUNT);
    }
    Ok((k, roster, index, e))
}

#[allow(clippy::too_many_arguments)]
fn finish(
    ctx: &AddrCtx,
    a: &[AccountInfo],
    before: Vec<Snapshot>,
    mut after: Vec<Snapshot>,
    action: receipt::Action,
    identity: receipt::Identity,
    now_ts: i64,
    now_slot: u64,
    bell: u32,
    outcomes: receipt::Outcomes,
) -> R<()> {
    let (season, province, original, changed): (usize, usize, &[usize], &[usize]) = match action {
        receipt::Action::Dissolve => (2, 5, &[3, 4], &[3, 4, 5]),
        receipt::Action::Return => (1, 2, &[4], &[2, 3, 4]),
    };
    let command = identity.host.to_bytes();
    let context = receipt::Context {
        command: &command,
        now_ts,
        now_slot,
        bell,
        season: &before[season].data,
    };
    let prepared = receipt::prepare(
        ctx,
        identity,
        action,
        &context,
        &manifest(&before),
        &manifest(&after),
        outcomes,
    )
    .map_err(|_| BAD_ACCOUNT)?;
    if prepared.original_links.len() != original.len() {
        return Err(BAD_ACCOUNT);
    }
    for (&i, link) in original.iter().zip(&prepared.original_links) {
        crate::layout::set_chain(&mut after[i].data, link.seq, &link.head)?;
    }
    crate::layout::set_chain(
        &mut after[province].data,
        prepared.wide_link.seq,
        &prepared.wide_link.head,
    )?;
    // Hold every distinct mutable borrow and verify length before the first
    // live copy. No CPI, payment, fallible codec or chain calculation follows.
    let mut writes = Vec::with_capacity(changed.len());
    for &i in changed {
        let data = a[i].try_borrow_mut_data()?;
        if data.len() != after[i].data.len() {
            return Err(BAD_ACCOUNT);
        }
        writes.push((i, data));
    }
    for (i, data) in &mut writes {
        data.copy_from_slice(&after[*i].data);
    }
    drop(writes);
    solana_program::log::sol_log_data(&[frontier_abi::log::PREFIX, &prepared.original]);
    solana_program::log::sol_log_data(&[wev::WIDE_LOG_PREFIX, &prepared.wide]);
    Ok(())
}

/// Candidate private writer, not reachable from any public instruction. The
/// original wallet/session player prologue is real; no supplied authorization,
/// outcome, prepared plan or captured-holding redirect is accepted.
pub(super) fn execute_dissolve(p: &Pubkey, a: &[AccountInfo], host: WideHostRef) -> R<()> {
    check_accounts(Shape(DISSOLVE), a, None)?;
    let [_, _, season, citizen, holding, standing, roster, home] = a else {
        return Err(FrontierError::TooManyAccounts.into());
    };
    let before = snapshots(a, true)?;
    let mut after = before.clone();
    let now = prologue::now()?;
    let start = player_start_as(p, a, now.ts, &Auth::Wallet)?;
    let hdr = start.season;
    let bell = hdr.bell(now.ts).ok_or(FrontierError::WrongStatus)?;
    let ctx = addr::ctx(&key(season), &p.to_bytes());
    let (owner, _) = source(p, &ctx, hdr.id, host, holding, home)?;
    if owner != key(citizen) {
        return Err(FrontierError::NotOwner.into());
    }
    prologue::present_v2(
        citizen,
        p,
        frontier_abi::v2::layout::AccountKind::Citizen,
        hdr.id,
    )?;
    let hh = ap::check_holding(&view(holding, &before[4].data), &ctx, hdr.id, &owner)?;
    if hh.state != H::STATE_FINAL {
        return Err(FrontierError::NotFinal.into());
    }
    let slot = Ro(&before[4].data).u8(H::ORDER)?;
    if wh::binding_of(&before[3].data, slot).map_err(holding_err)?
        != wh::SlotBinding::Legacy(wh::HoldingRef {
            p: hh.p,
            q: hh.q,
            site: hh.site,
            gen: hh.gen,
        })
    {
        return Err(FrontierError::NotOwner.into());
    }
    let (standing_key, _, index, mut e) = resident(p, &ctx, hdr.id, host, standing, roster)?;
    if !ap::resident_ok(Ro(&before[5].data).u32(PV::RESOLVED_NEXT)?, bell)
        || e.state != E::STATE_ROSTER
        || e.from_bell > bell
    {
        return Err(FrontierError::NotResident.into());
    }
    if e.faction != Ro(&before[3].data).u8(C::FACTION)? {
        return Err(BAD_ACCOUNT);
    }
    if e.busy() {
        return Err(FrontierError::HostBusy.into());
    }
    let touched = hold::load_touched(holding, now.ts)?;
    hold::write_holding(&mut after[4].data, &touched, now.ts)?;
    start.finish(&mut after[3].data, now.ts)?;
    Rw(&mut after[3].data).set_i64(C::LAST_ACTION_TS, now.ts)?;
    e.op = EntryOp::Leave;
    e.pend_bell = bell;
    write_entry(&mut after[5].data, index, &e).map_err(|_| BAD_ACCOUNT)?;
    finish(
        &ctx,
        a,
        before,
        after,
        receipt::Action::Dissolve,
        receipt::Identity {
            host,
            original_owner: owner,
            holding: key(holding),
            standing: standing_key,
            province: key(standing),
        },
        now.ts,
        now.slot,
        bell,
        receipt::Outcomes {
            entry: index as u8,
            unit: e.unit,
            troops_milli: e.troops,
            pending_bell: bell,
            credited_units: 0,
        },
    )
}

/// Current-generation voluntary Leave only. The real wide resolver must have
/// departed the paired row. Whole troops credit the original reserve exactly
/// once; no new host id is issued and no wide holding can receive this credit.
pub(super) fn execute_return(p: &Pubkey, a: &[AccountInfo], host: WideHostRef) -> R<()> {
    check_accounts(Shape(RETURN), a, None)?;
    let [_, season, standing, roster_ai, holding, home] = a else {
        return Err(FrontierError::TooManyAccounts.into());
    };
    let before = snapshots(a, false)?;
    let mut after = before.clone();
    let now = prologue::now()?;
    let hdr = settle_season(season, p, now.ts)?;
    let ctx = addr::ctx(&key(season), &p.to_bytes());
    let (owner, _) = source(p, &ctx, hdr.id, host, holding, home)?;
    let (standing_key, roster, index, e) = resident(p, &ctx, hdr.id, host, standing, roster_ai)?;
    if e.state != E::STATE_DEPARTED
        || !matches!(e.op, EntryOp::Leave)
        || Ro(&before[2].data).u32(PV::RESOLVED_NEXT)? <= e.pend_bell
    {
        return Err(FrontierError::TooEarly.into());
    }
    // Entry's generic decoder deliberately projects Leave without its raw
    // payload. RetireHost/keep-donor markers can carry a different return
    // target there; this voluntary-Dissolve candidate must not erase it.
    let raw = Ro(&before[2].data);
    let row = PV::entry(index);
    if raw.u8(row + E::OP_A)? != 0
        || raw.u16(row + E::OP_B)? != 0
        || raw.u32(row + E::OP_TROOPS)? != 0
        || raw.u32(row + E::OP_REF)? != 0
    {
        return Err(FrontierError::NotImplemented.into());
    }
    let whole = e.troops / MILLI as u32;
    let offset = H::reserve(e.unit as usize);
    let reserve = Ro(&before[4].data)
        .u32(offset)?
        .checked_add(whole)
        .ok_or(OVERFLOW)?;
    Rw(&mut after[4].data).set_u32(offset, reserve)?;
    write_entry(&mut after[2].data, index, &Entry::FREE).map_err(|_| BAD_ACCOUNT)?;
    let count = Ro(&before[2].data)
        .u8(PV::N_ENTRIES)?
        .checked_sub(1)
        .ok_or(BAD_ACCOUNT)?;
    Rw(&mut after[2].data).set_u8(PV::N_ENTRIES, count)?;
    roster
        .release(&mut after[3].data, index)
        .map_err(|_| BAD_ACCOUNT)?;
    let bell = hdr.bell(now.ts).ok_or(FrontierError::WrongStatus)?;
    finish(
        &ctx,
        a,
        before,
        after,
        receipt::Action::Return,
        receipt::Identity {
            host,
            original_owner: owner,
            holding: key(holding),
            standing: standing_key,
            province: key(standing),
        },
        now.ts,
        now.slot,
        bell,
        receipt::Outcomes {
            entry: index as u8,
            unit: e.unit,
            troops_milli: e.troops,
            pending_bell: e.pend_bell,
            credited_units: whole,
        },
    )
}
