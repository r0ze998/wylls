//! Authenticated initial-Free-City declaration. All decisions, balances and
//! receipt chains are staged before allocation. Dispatch stays closed until
//! the entire lifecycle and its replay contract have been independently checked.
use super::*;
use crate::layout::record as CR;
use crate::proc::conquest::{cq, mirror_walls_at};
use frontier_abi::conquest_model::{Record, SiteRecordRules, SiteTransitionMirror};
use frontier_abi::v2::error::CqError;
use frontier_abi::world_index::conquest::{
    self as wc, CaptureBinding, WideCaptureEscrow, WideConquest, WideConquestEntry,
};
use frontier_abi::world_index::event::conquest as receipts;

/// Owned full-state manifest. Roles are the one-based command account index.
/// Every role is present, including absent canonical account positions.
#[derive(Clone)]
pub(super) struct State {
    pub address: [u8; 32],
    pub owner: [u8; 32],
    pub present: bool,
    pub lamports: u64,
    pub data: Vec<u8>,
    pub chained: bool,
}

pub(super) fn states(a: &[AccountInfo], chained: &[usize]) -> R<Vec<State>> {
    a.iter()
        .enumerate()
        .map(|(i, ai)| {
            Ok(State {
                address: key(ai),
                owner: ai.owner.to_bytes(),
                present: !init::is_absent(ai),
                lamports: ai.lamports(),
                data: ai.try_borrow_data()?.to_vec(),
                chained: chained.iter().any(|j| a[*j].key == a[i].key),
            })
        })
        .collect()
}

/// Keep duplicate read roles synchronized (notably source province == target).
/// A single account never acquires two independently staged states.
pub(super) fn replace(states: &mut [State], i: usize, next: State) {
    let address = states[i].address;
    for s in states.iter_mut().filter(|s| s.address == address) {
        *s = next.clone();
    }
}

pub(super) fn receipt(
    action: u8,
    command: &[u8],
    now_ts: i64,
    bell: u32,
    season: &[u8],
    evidence: &[u8],
    before: &[State],
    after: &[State],
    outcomes: &[u8],
) -> R<[u8; 100]> {
    fn views(s: &[State]) -> Vec<receipts::AccountSnapshot<'_>> {
        s.iter()
            .enumerate()
            .map(|(i, s)| receipts::AccountSnapshot {
                role: (i + 1) as u16,
                address: s.address,
                owner: s.owner,
                present: s.present,
                lamports: s.lamports,
                data: s.data.as_slice(),
                chained: s.chained,
            })
            .collect()
    }
    let context = receipts::Context {
        command,
        now_ts,
        bell,
        season,
        evidence,
    };
    let input = receipts::input_digest(&context, &views(before)).map_err(|_| BAD_ACCOUNT)?;
    let output =
        receipts::output_digest(&context, &views(after), outcomes).map_err(|_| BAD_ACCOUNT)?;
    Ok(receipts::Receipt::new(action, 0, input, output)
        .map_err(|_| BAD_ACCOUNT)?
        .encode())
}

pub(super) fn table_at(
    ai: &AccountInfo,
    p: &Pubkey,
    ctx: &AddrCtx,
    sid: u64,
    key_: ProvinceKey,
) -> R<Option<WideConquest>> {
    expect_key(ai, &wc::conquest_address(ctx, key_))?;
    if init::is_absent(ai) {
        return Ok(None);
    }
    if ai.owner != p {
        return Err(BAD_ACCOUNT);
    }
    Ok(Some(
        WideConquest::read(&ai.try_borrow_data()?, sid, key_).map_err(|_| BAD_ACCOUNT)?,
    ))
}

pub(super) fn escrow_at(
    ai: &AccountInfo,
    p: &Pubkey,
    ctx: &AddrCtx,
    sid: u64,
    world: WorldId,
    citizen: [u8; 32],
) -> R<Option<WideCaptureEscrow>> {
    expect_key(ai, &wc::capture_escrow_address(ctx, &citizen))?;
    if init::is_absent(ai) {
        return Ok(None);
    }
    if ai.owner != p {
        return Err(BAD_ACCOUNT);
    }
    Ok(Some(
        WideCaptureEscrow::read(&ai.try_borrow_data()?, sid, world, citizen)
            .map_err(|_| BAD_ACCOUNT)?,
    ))
}

/// Authenticate every prefix, including unused positions, before accepting a
/// table. An absent table cannot erase a nonzero obligation in the province.
pub(super) fn paired(table: &WideConquest, pd: &[u8]) -> R<()> {
    for site in 0..PV::SITES_N {
        table
            .validate_paired(site as u8, Record::read(pd, site).map_err(|_| BAD_ACCOUNT)?)
            .map_err(|_| BAD_ACCOUNT)?;
    }
    Ok(())
}

fn eligible(e: &Entry, tile: u8, faction: u8, bell: u32) -> bool {
    e.state == E::STATE_ROSTER
        && e.from_bell <= bell
        && !e.busy()
        && unit_from_u8(e.unit).is_some_and(|u| !u.is_civilian())
        && e.troops > 0
        && e.faction == faction
        && e.tile == tile
}

/// Full identity, never the truncated alias, decides the equal-troops lead.
fn lead(
    pd: &[u8],
    roster: &WideRoster,
    rd: &[u8],
    tile: u8,
    faction: u8,
    bell: u32,
) -> R<Option<(usize, WideHostRef)>> {
    roster
        .validate_paired(rd, &wres::live_ids(pd).map_err(resolve_err)?)
        .map_err(|_| BAD_ACCOUNT)?;
    let table = roster.table(rd).map_err(|_| BAD_ACCOUNT)?;
    let mut best: Option<(usize, WideHostRef, u32)> = None;
    for i in 0..PV::ENTRIES_N {
        let e = read_entry(pd, i).map_err(|_| BAD_ACCOUNT)?;
        if e.state != E::STATE_FREE && !table.iter().any(|(j, alias, _)| *j == i && *alias == e.id)
        {
            return Err(BAD_ACCOUNT);
        }
        if !eligible(&e, tile, faction, bell) {
            continue;
        }
        let (_, _, host) = table
            .iter()
            .find(|(j, alias, _)| *j == i && *alias == e.id)
            .ok_or(BAD_ACCOUNT)?;
        if best
            .is_none_or(|(_, old, troops)| e.troops > troops || (e.troops == troops && *host < old))
        {
            best = Some((i, *host, e.troops));
        }
    }
    Ok(best.map(|(i, h, _)| (i, h)))
}

pub(super) fn declare_siege_as(
    p: &Pubkey,
    a: &[AccountInfo],
    x: &wix::DeclareSiege,
    auth: &Auth,
) -> R<()> {
    require_conquest_lifecycle()?;
    declare_siege_inner(p, a, x, auth)
}

fn declare_siege_inner(p: &Pubkey, a: &[AccountInfo], x: &wix::DeclareSiege, auth: &Auth) -> R<()> {
    // A resident must use the outer-wire entry below. Never silently emit a
    // wallet-shaped receipt for an authenticated resident action.
    if !matches!(auth, Auth::Wallet) {
        return Err(FrontierError::BadData.into());
    }
    declare_siege_context(p, a, x, auth, a, &x.to_bytes())
}

/// Retain the exact signed outer bytes and all proof accounts in their
/// original wire order. The authentication still runs in player_start_as.
pub(super) fn declare_siege_resident(p: &Pubkey, accounts: &[AccountInfo], outer: &[u8]) -> R<()> {
    require_conquest_lifecycle()?;
    let (a, proof, x, generation) = resident_context(accounts, outer)?;
    let auth = Auth::Resident { proof, generation };
    declare_siege_context(p, a, &x, &auth, accounts, outer)
}

fn resident_context<'a, 'b>(
    accounts: &'a [AccountInfo<'b>],
    outer: &[u8],
) -> R<(
    &'a [AccountInfo<'b>],
    &'a [AccountInfo<'b>],
    wix::DeclareSiege,
    u32,
)> {
    let envelope = wix::ResidentAct::decode(outer)?;
    let wix::WideCommand::DeclareSiege(x) = envelope.command()? else {
        return Err(FrontierError::BadData.into());
    };
    if accounts.len() != 16 {
        return Err(FrontierError::TooManyAccounts.into());
    }
    let (a, proof) = accounts.split_at(12);
    Ok((a, proof, x, envelope.generation))
}

/// Both entry points supply a complete, immutable authenticated wire context.
/// The extra proof roles are read-only inputs, never substitutes for main12.
fn declare_siege_context(
    p: &Pubkey,
    a: &[AccountInfo],
    x: &wix::DeclareSiege,
    auth: &Auth,
    manifest: &[AccountInfo],
    command: &[u8],
) -> R<()> {
    check_accounts(Shape(wix::DECLARE_SIEGE), a, None)?;
    let [_, payer, season_ai, citizen, source, province, roster_ai, source_province, target, table_ai, escrow_ai, _system] =
        a
    else {
        return Err(FrontierError::TooManyAccounts.into());
    };
    let now = prologue::now()?;
    let start = player_start_as(p, a, now.ts, auth)?;
    let hdr = start.season;
    let bell = hdr.bell(now.ts).ok_or(FrontierError::WrongStatus)?;
    let ctx = addr::ctx(&key(season_ai), p.as_array());
    let world = world_of(&ctx)?;
    let prov = canonical_province(province, p, &ctx, hdr.id, world)?;
    let pkey = ProvinceKey::new(world, prov.coord);
    let source_h = holding_at(source, p, hdr.id)?.ok_or(BAD_ACCOUNT)?;
    expect_key(
        source,
        &wh::holding_address(&ctx, source_h.coord, source_h.site),
    )?;
    if source_h.world != world || source_h.owner_citizen != key(citizen) {
        return Err(FrontierError::NotOwner.into());
    }
    let sp = canonical_province(source_province, p, &ctx, hdr.id, world)?;
    if sp.coord != source_h.coord {
        return Err(BAD_ACCOUNT);
    }
    // Only the two Province roles may alias. Actor/payer alias is normal.
    for i in 2..a.len() {
        for j in i + 1..a.len() {
            if a[i].key == a[j].key && (i, j) != (5, 7) {
                return Err(BAD_ACCOUNT);
            }
        }
        if a[i].key == payer.key || a[i].key == a[0].key {
            return Err(BAD_ACCOUNT);
        }
    }
    let before = states(manifest, &[4, 5])?;
    let mut after = before.clone();
    let cd = &before[3].data;
    let hd = &before[4].data;
    let pd = &before[5].data;
    capture_lock_of(&before[7].data, hd)?;
    if wh::binding_of(cd, source_h.slot).map_err(holding_err)? != SlotBinding::Wide {
        return Err(BAD_ACCOUNT);
    }
    let (state, due) = if source_h.coord == prov.coord {
        wide_finality_due(source, province, now.ts, bell)?
    } else {
        (Ro(hd).u8(H::STATE)?, false)
    };
    if state != H::STATE_FINAL && !due {
        return Err(FrontierError::NotFinal.into());
    }
    if due {
        Rw(&mut after[4].data).set_u8(H::STATE, H::STATE_FINAL)?;
    }
    let r = Ro(pd);
    let site = x.site as usize;
    if r.u8(PV::SITE_COUNT)? as usize > PV::SITES_N || site >= r.u8(PV::SITE_COUNT)? as usize {
        return Err(FrontierError::BadData.into());
    }
    let off = PV::site(site);
    if r.u8(off + SM::STATE)? != SM2::STATE_FREE_CITY
        || r.u8(off + SM::GEN)? != 0
        || r.u8(off + SM::ORDER)? != 0
        || r.u8(off + SM::FACTION)? != NEUTRAL
    {
        return Err(cq(CqError::NotBesiegeable));
    }
    // Wide canonical provinces have ring >=129: neither Concord (ring0)
    // nor the six Seats (ring1) can enter this path.
    if prov.coord.ring() < FIRST_WIDE_RING {
        return Err(FrontierError::ReservedSite.into());
    }
    expect_key(target, &wh::holding_address(&ctx, prov.coord, x.site))?;
    if !init::is_absent(target) {
        return Err(BAD_ACCOUNT);
    }
    if !ap::resident_ok(r.u32(PV::RESOLVED_NEXT)?, bell) {
        return Err(FrontierError::NotResident.into());
    }
    expect_key(roster_ai, &wro::roster_address(&ctx, pkey))?;
    let roster = roster_at(roster_ai, p, hdr.id, pkey)?.ok_or(BAD_ACCOUNT)?;
    let faction = Ro(cd).u8(C::FACTION)?;
    let tile = r.u8(PV::SITES + site)?;
    let chosen = read_entry(pd, x.entry as usize).map_err(|_| cq(CqError::NotOnHex))?;
    let chosen_ref = roster
        .ref_at(&before[6].data, x.entry as usize)
        .map_err(|_| BAD_ACCOUNT)?
        .ok_or(cq(CqError::NotOnHex))?;
    if source_h.host_identity != wm::HOST_IDENTITY_FULL_REF_V1
        || chosen_ref.seq() == 0
        || chosen_ref.seq() > Ro(hd).u32(H::HOST_SEQ)?
    {
        return Err(cq(CqError::NotOnHex));
    }
    if !eligible(&chosen, tile, faction, bell)
        || chosen_ref.key() != ProvinceKey::new(world, source_h.coord)
        || chosen_ref.site() != source_h.site
        || chosen_ref.gen() != source_h.gen
    {
        return Err(cq(CqError::NotOnHex));
    }
    if lead(pd, &roster, &before[6].data, tile, faction, bell)?
        != Some((x.entry as usize, chosen_ref))
    {
        return Err(cq(CqError::NotLead));
    }
    let present_table = table_at(table_ai, p, &ctx, hdr.id, pkey)?;
    let new_table = present_table.is_none();
    let table = match present_table {
        Some(t) => t,
        None => WideConquest::new(hdr.id, pkey, key(payer)).map_err(|_| BAD_ACCOUNT)?,
    };
    paired(&table, pd)?;
    let prefix = Record::read(pd, site).map_err(|_| BAD_ACCOUNT)?;
    if prefix.kind != CR::KIND_NONE {
        return Err(cq(CqError::SiegeBusy));
    }
    if prefix.flags & CR::OWED_MASK != 0 || table.entry(x.site).map_err(|_| BAD_ACCOUNT)?.is_some()
    {
        return Err(cq(CqError::StakeUnsettled));
    }
    let sd = &before[2].data;
    let cq_params = season_cq(sd)?;
    let today = u16::try_from(frontier_abi::addr::day_of(bell)).map_err(|_| OVERFLOW)?;
    let used = if Ro(cd).u16(C2::SIEGE_DAY)? == today {
        Ro(cd).u8(C2::SIEGES_TODAY)?
    } else {
        0
    };
    if used >= cq_params.sieges_per_day {
        return Err(cq(CqError::SiegeCap));
    }
    let slot = C2::lowest_free_slot(
        Ro(cd).u8(C2::SLOTS)?,
        Ro(cd).u8(C2::holding_of_slot(2) + 5)?,
        Ro(cd).u8(C2::holding_of_slot(3) + 5)?,
    )
    .ok_or(cq(CqError::HoldingsFull))?;
    refuse_wide_ticket(cd)?;
    let required =
        siege::required_bells(mirror_walls_at(pd, site, bell)?, 0).min(u8::MAX as u32) as u8;
    let from = bell.checked_add(1).ok_or(OVERFLOW)?;
    if hdr.end_bell.saturating_sub(from) < required as u32 {
        return Err(cq(CqError::TooLate));
    }
    let source_ref = WideHostRef::new(
        ProvinceKey::new(world, source_h.coord),
        source_h.site,
        source_h.gen,
        0,
    )
    .map_err(|_| BAD_ACCOUNT)?;
    let entry = WideConquestEntry {
        rules: SiteRecordRules {
            kind: CR::KIND_SIEGE,
            faction,
            flags: CR::FLAG_HELD | CR::FLAG_NEUTRAL,
            progress: 0,
            required,
            target: CR::target(CR::TARGET_FREE_CITY, slot),
            vigil_start: 0,
            vigil_next: 0,
            vigil_from_day: 0,
            bell,
        },
        citizen: key(citizen),
        source: Some(source_ref),
        actor_tag: start.citizen_tag,
        reserved_slot: slot,
        original_target_gen: 0,
        declaration_bell: bell,
    };
    let plan = table
        .declare(
            x.site,
            prefix,
            SiteTransitionMirror {
                state: r.u8(off + SM::STATE)?,
                gen: 0,
                order: r.u8(off + SM::ORDER)?,
                held_since_hour: r.u16(off + SM2::HELD_SINCE_HOUR)?,
                walls_committed: r.u32(off + SM::WALLS_COMMITTED)?,
            },
            entry,
        )
        .map_err(|_| BAD_ACCOUNT)?;
    let present_escrow = escrow_at(escrow_ai, p, &ctx, hdr.id, world, key(citizen))?;
    let new_escrow = present_escrow.is_none();
    let escrow = match present_escrow {
        Some(e) => e,
        None => WideCaptureEscrow::new(hdr.id, world, key(citizen), key(payer))
            .map_err(|_| BAD_ACCOUNT)?,
    };
    escrow
        .validate_inventory(hdr.id, world, key(citizen), cd)
        .map_err(|_| BAD_ACCOUNT)?;
    let rent_table = init::rent(wc::CONQUEST_SIZE)?;
    let rent_escrow = init::rent(wc::CAPTURE_ESCROW_SIZE)?;
    if !new_escrow
        && escrow_ai.lamports() < rent_escrow.checked_add(escrow.escrow()).ok_or(OVERFLOW)?
    {
        return Err(BAD_ACCOUNT);
    }
    let binding = CaptureBinding {
        key: pkey,
        site: x.site,
        gen: 0,
        declaration_bell: bell,
    };
    let (escrow_out, topup) = escrow
        .reserve(
            slot,
            binding,
            init::rent(wh::wide_holding::SIZE)?,
            key(payer),
        )
        .map_err(|_| BAD_ACCOUNT)?;
    let mut economic = hold::read_holding(&after[4].data)?;
    hold::touch(&mut economic, now.ts, hold::terrain_ore(hd)?)?;
    let mut cost = permutation_rules::frontier::arms::siege_cost();
    cost[permutation_rules::frontier::holding::Resource::Gold as usize] =
        (cq_params.siege_stake_gold as i64)
            .checked_mul(MILLI)
            .ok_or(OVERFLOW)?;
    economic.pay(now.ts, &cost).map_err(hold::holding_err)?;
    hold::write_holding(&mut after[4].data, &economic, now.ts)?;
    start.finish(&mut after[3].data, now.ts)?;
    Rw(&mut after[3].data).set_i64(C::LAST_ACTION_TS, now.ts)?;
    Rw(&mut after[3].data).set_u16(C2::SIEGE_DAY, today)?;
    Rw(&mut after[3].data).set_u8(C2::SIEGES_TODAY, used.checked_add(1).ok_or(OVERFLOW)?)?;
    wc::mark(&mut after[3].data, slot).map_err(|_| BAD_ACCOUNT)?;
    plan.prefix
        .write(&mut after[5].data, site)
        .map_err(|_| BAD_ACCOUNT)?;
    after[9].data = plan.conquest.to_bytes().to_vec();
    after[10].data = escrow_out.to_bytes().to_vec();
    escrow_out
        .validate_paired(
            &plan.conquest,
            x.site,
            plan.prefix,
            key(citizen),
            &after[3].data,
        )
        .map_err(|_| BAD_ACCOUNT)?;
    let table_need = if new_table {
        rent_table.saturating_sub(table_ai.lamports())
    } else {
        0
    };
    // Retained/prefunded lamports never replace the escrow ledger's funder.
    let escrow_need = if new_escrow {
        rent_escrow.saturating_sub(escrow_ai.lamports())
    } else {
        0
    };
    let total = table_need
        .checked_add(escrow_need)
        .and_then(|n| n.checked_add(topup))
        .ok_or(OVERFLOW)?;
    if total != 0 && !init::is_absent(payer) {
        return Err(BAD_ACCOUNT);
    }
    after[1].lamports = after[1]
        .lamports
        .checked_sub(total)
        .ok_or(FrontierError::Insufficient)?;
    after[9].lamports = after[9].lamports.checked_add(table_need).ok_or(OVERFLOW)?;
    after[10].lamports = after[10]
        .lamports
        .checked_add(escrow_need)
        .and_then(|n| n.checked_add(topup))
        .ok_or(OVERFLOW)?;
    for i in [9, 10] {
        after[i].owner = p.to_bytes();
        after[i].present = true;
    }
    for i in [1, 5] {
        let next = after[i].clone();
        replace(&mut after, i, next);
    }
    let payload = receipt(
        1,
        command,
        now.ts,
        bell,
        sd,
        &chosen_ref.to_bytes(),
        &before,
        &after,
        &total.to_le_bytes(),
    )?;
    let (declaration, dn) = prepare_wide(
        WideKind::ConquestDeclared,
        bell,
        &pkey.to_bytes(),
        &payload,
        &mut [(WideEntity::Province, &mut after[5].data)],
    )?;
    let (debit, hn) = prepare_wide(
        WideKind::ConquestDebited,
        bell,
        &source_ref.to_bytes(),
        &payload,
        &mut [(WideEntity::Holding, &mut after[4].data)],
    )?;
    // All predictable borrow conflicts before the first CPI. Dynamic syscall
    // failures still require the normal transaction rollback boundary.
    {
        let _payer = payer.try_borrow_mut_lamports()?;
        let _tl = table_ai.try_borrow_mut_lamports()?;
        let _el = escrow_ai.try_borrow_mut_lamports()?;
        let _cd = citizen.try_borrow_mut_data()?;
        let _hd = source.try_borrow_mut_data()?;
        let _pd = province.try_borrow_mut_data()?;
        let _td = table_ai.try_borrow_mut_data()?;
        let _ed = escrow_ai.try_borrow_mut_data()?;
    }
    let signer = SeasonSigner::new(hdr.id, hdr.bump);
    if new_table {
        init::init_with_seed(
            payer,
            table_ai,
            season_ai,
            &signer,
            &wc::conquest_seed(pkey),
            wc::CONQUEST_SIZE,
            rent_table,
            p,
        )?;
    }
    if new_escrow {
        init::init_with_seed(
            payer,
            escrow_ai,
            season_ai,
            &signer,
            &wc::capture_escrow_seed(&key(citizen)),
            wc::CAPTURE_ESCROW_SIZE,
            rent_escrow,
            p,
        )?;
    }
    init::transfer(payer, escrow_ai, topup)?;
    {
        let mut cd = citizen.try_borrow_mut_data()?;
        let mut hd = source.try_borrow_mut_data()?;
        let mut pd = province.try_borrow_mut_data()?;
        let mut td = table_ai.try_borrow_mut_data()?;
        let mut ed = escrow_ai.try_borrow_mut_data()?;
        if cd.len() != after[3].data.len()
            || hd.len() != after[4].data.len()
            || pd.len() != after[5].data.len()
            || td.len() != after[9].data.len()
            || ed.len() != after[10].data.len()
        {
            return Err(BAD_ACCOUNT);
        }
        cd.copy_from_slice(&after[3].data);
        hd.copy_from_slice(&after[4].data);
        pd.copy_from_slice(&after[5].data);
        td.copy_from_slice(&after[9].data);
        ed.copy_from_slice(&after[10].data);
    }
    solana_program::log::sol_log_data(&[wev::WIDE_LOG_PREFIX, &declaration[..dn]]);
    solana_program::log::sol_log_data(&[wev::WIDE_LOG_PREFIX, &debit[..hn]]);
    Ok(())
}

#[cfg(test)]
#[path = "wide_conquest_exec_tests.rs"]
pub(super) mod tests;
