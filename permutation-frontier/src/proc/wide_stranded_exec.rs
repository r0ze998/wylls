//! Host-only orphan recovery using the deployed DisbandStranded schedule.
//! A still-open wide march remains gated: its paired entry is settlement evidence.
use super::*;
use frontier_abi::v2::layout::player::holding as H2;

pub(super) fn disband_stranded(p: &Pubkey, a: &[AccountInfo], x: &wix::DisbandStranded) -> R<()> {
    check_accounts(Shape(wix::DISBAND_STRANDED), a, None)?;
    let [_any, season_ai, province, roster_ai, holding, t0, t1, t2, t3] = a else {
        return Err(FrontierError::TooManyAccounts.into());
    };
    let now = prologue::now()?;
    let hdr = settle_season(season_ai, p, now.ts)?;
    let retire = super::super::conquest::retire_hosts_of(&season_ai.try_borrow_data()?)?;
    let ctx = addr::ctx(&key(season_ai), &p.to_bytes());
    let world = world_of(&ctx)?;
    let prov = canonical_province(province, p, &ctx, hdr.id, world)?;
    let pkey = ProvinceKey::new(world, prov.coord);
    expect_key(roster_ai, &wro::roster_address(&ctx, pkey))?;
    let roster = roster_at(roster_ai, p, hdr.id, pkey)?.ok_or(BAD_ACCOUNT)?;
    let mut pd = province.try_borrow_data()?.to_vec();
    let mut rd = roster_ai.try_borrow_data()?.to_vec();
    let i = x.entry as usize;
    let entry = read_entry(&pd, i).map_err(|_| FrontierError::BadData)?;
    if entry.state == E::STATE_FREE {
        return Err(FrontierError::BadData.into());
    }
    roster
        .validate_paired(&rd, &wres::live_ids(&pd).map_err(resolve_err)?)
        .map_err(|_| BAD_ACCOUNT)?;
    let host = roster
        .ref_at(&rd, i)
        .map_err(|_| BAD_ACCOUNT)?
        .ok_or(BAD_ACCOUNT)?;
    if host.key().coord().ring() < FIRST_WIDE_RING {
        return Err(BAD_ACCOUNT);
    }
    expect_key(
        holding,
        &wh::holding_address(&ctx, host.key().coord(), host.site()),
    )?;
    if let Some(h) = holding_at(holding, p, hdr.id)? {
        if h.world != world || h.coord != host.key().coord() || h.site != host.site() {
            return Err(BAD_ACCOUNT);
        }
        let hd = holding.try_borrow_data()?;
        let r = Ro(&hd);
        let live = matches!(r.u8(H::STATE)?, H::STATE_PROVISIONAL | H::STATE_FINAL);
        if live && h.gen == host.gen() {
            return Err(FrontierError::NotDormant.into());
        }
        // Preserve K-27: a captured previous generation belongs to its victim.
        // This is a refusal guard, not support for wide capture or RetireHost.
        let captured = r.u8(H2::CAPTURE_FLAGS)? & H2::CAPTURE_FLAG_CAPTURED != 0;
        if live && retire == 1 && captured && r.u8(H2::PREV_GEN)? == host.gen() {
            return Err(FrontierError::NotDormant.into());
        }
    }
    // Wide transit state is separate from the holding. Never erase evidence
    // needed by SettleDeparture/SettleTransit while its record is still open.
    // This existing wide restriction deliberately narrows legacy parity.
    if host_has_open_transit(p, &ctx, &key(holding), &[t0, t1, t2, t3], &host)? {
        return Err(FrontierError::HostInTransit.into());
    }
    let rn = Ro(&pd).u32(PV::RESOLVED_NEXT)?;
    let b = hdr.bell(now.ts).unwrap_or(frontier_abi::log::NO_BELL);
    let pending =
        matches!(entry.state, E::STATE_ROSTER | E::STATE_MUSTER_PENDING) && rn < hdr.end_bell;
    if pending {
        if !ap::resident_ok(rn, b) {
            return Err(FrontierError::NotResident.into());
        }
        if entry.busy() {
            return Err(FrontierError::HostBusy.into());
        }
        let mut queued = entry;
        queued.op = EntryOp::Forfeit;
        queued.pend_bell = b;
        write_entry(&mut pd, i, &queued).map_err(|_| BAD_ACCOUNT)?;
    } else {
        write_entry(&mut pd, i, &Entry::FREE).map_err(|_| BAD_ACCOUNT)?;
        roster.release(&mut rd, i).map_err(|_| BAD_ACCOUNT)?;
        let count = Ro(&pd).u8(PV::N_ENTRIES)?.saturating_sub(1);
        Rw(&mut pd).set_u8(PV::N_ENTRIES, count)?;
    }
    let epoch = Ro(&pd).u32(PV::ROSTER_EPOCH)?.wrapping_add(1);
    Rw(&mut pd).set_u32(PV::ROSTER_EPOCH, epoch)?;
    let (record, len) = prepare_wide(
        WideKind::Stranded,
        b,
        &wev::host_key(&host, pkey),
        &wev::stranded_payload(entry.troops, x.entry),
        &mut [(WideEntity::Province, &mut pd)],
    )?;
    // All refusal points, including receipt overflow and both borrows, precede
    // the first live write. No holding, Citizen, balance or transit is changed.
    {
        let mut live_pd = province.try_borrow_mut_data()?;
        let mut live_rd = roster_ai.try_borrow_mut_data()?;
        if live_pd.len() != pd.len() || live_rd.len() != rd.len() {
            return Err(BAD_ACCOUNT);
        }
        live_pd.copy_from_slice(&pd);
        live_rd.copy_from_slice(&rd);
    }
    solana_program::log::sol_log_data(&[wev::WIDE_LOG_PREFIX, &record[..len]]);
    Ok(())
}
