//! Closed reverse producer: authenticated original issuer, distinct wide standing.
//! No public dispatcher, seal opening, caller verdict or synthetic survivors.
use super::*;
use alloc::rc::Rc;
use frontier_abi::entry::{read_entry, write_entry, Entry};
use frontier_abi::world_index::{
    expedition::AccountResolver,
    expedition_reverse_ix as ix,
    expedition_reverse_transport::{self as transport, ReverseMarker, ReverseTransit},
};
use permutation_rules::hash::sha256;

/// Actual effective privileges may be elevated by a caller. Only actor/payer
/// and issuer/destination can alias; shared-storage identity must also match.
fn roles(
    a: &[AccountInfo],
    writes: &[usize],
    signers: &[usize],
    aliases: &[(usize, usize)],
    system: Option<usize>,
) -> R<()> {
    for (i, x) in a.iter().enumerate() {
        if (writes.contains(&i) && !x.is_writable)
            || (signers.contains(&i) && !x.is_signer)
            || (x.executable && system != Some(i))
        {
            return Err(BAD_ACCOUNT);
        }
        for (j, y) in a[..i].iter().enumerate() {
            let same = x.key == y.key;
            if same != Rc::ptr_eq(&x.data, &y.data)
                || same != Rc::ptr_eq(&x.lamports, &y.lamports)
                || (same
                    && (!aliases.contains(&(j, i))
                        || x.owner != y.owner
                        || x.is_writable != y.is_writable
                        || x.is_signer != y.is_signer))
            {
                return Err(BAD_ACCOUNT);
            }
        }
    }
    Ok(())
}
fn original_destination(
    p: &Pubkey,
    ctx: &AddrCtx,
    sid: u64,
    destination: ProvinceKey,
    ai: &AccountInfo,
) -> R<()> {
    let r = AccountResolver::for_season(ctx).map_err(|_| BAD_ACCOUNT)?;
    let coord = r
        .adapter()
        .coord_of(&destination)
        .map_err(|_| BAD_ACCOUNT)?;
    expect_key(
        ai,
        &r.province_address(destination).map_err(|_| BAD_ACCOUNT)?,
    )?;
    prologue::present_v2(ai, p, frontier_abi::v2::layout::AccountKind::Province, sid)?;
    let d = ai.try_borrow_data()?;
    if Ro(&d).i16(PV::P)? as i32 != coord.p || Ro(&d).i16(PV::Q)? as i32 != coord.q {
        return Err(BAD_ACCOUNT);
    }
    Ok(())
}
/// A bounded isolated observation, not a PS2/PSW1 kind or execution proof.
/// Full input/output account states are bound; output chain tails are normalized.
fn receipt(
    p: &Pubkey,
    a: &[AccountInfo],
    after: &mut [Vec<u8>],
    balances: &[u64],
    command: &[u8],
    action: u8,
    original: &[(usize, frontier_abi::log::EntityKind)],
    wide: usize,
) -> R<Vec<u8>> {
    let now = prologue::now()?;
    let mut input = sha256(&[b"PSF-REVERSE-INPUT-v1", p.as_ref(), command]);
    let mut output = sha256(&[b"PSF-REVERSE-OUTPUT-v1", p.as_ref(), command]);
    for (i, ai) in a.iter().enumerate() {
        let before = ai.try_borrow_data()?;
        input = sha256(&[
            &input,
            &(i as u32).to_le_bytes(),
            ai.key.as_ref(),
            ai.owner.as_ref(),
            &[ai.is_signer as u8, ai.is_writable as u8],
            &ai.try_lamports()?.to_le_bytes(),
            &(before.len() as u64).to_le_bytes(),
            &before,
        ]);
        let data = if i == wide || original.iter().any(|(n, _)| *n == i) {
            wev::normalize_chained(&after[i])
        } else {
            after[i].clone()
        };
        let owner = if after[i].len() != before.len() {
            p.to_bytes()
        } else {
            ai.owner.to_bytes()
        };
        output = sha256(&[
            &output,
            &(i as u32).to_le_bytes(),
            ai.key.as_ref(),
            &owner,
            &[ai.is_signer as u8, ai.is_writable as u8],
            &balances[i].to_le_bytes(),
            &(data.len() as u64).to_le_bytes(),
            &data,
        ]);
    }
    let mut body = Vec::new();
    body.extend_from_slice(b"PSFR");
    body.extend_from_slice(&[1, action]);
    body.extend_from_slice(&now.ts.to_le_bytes());
    body.extend_from_slice(&now.slot.to_le_bytes());
    body.extend_from_slice(&sha256(&[command]));
    body.extend_from_slice(&input);
    body.extend_from_slice(&output);
    let mut tails = Vec::new();
    for &(i, kind) in original {
        let (seq, head) = crate::layout::chain_of(&after[i])?;
        let link = frontier_abi::log::advance(kind, seq, &head, &body).ok_or(OVERFLOW)?;
        crate::layout::set_chain(&mut after[i], link.seq, &link.head)?;
        tails.extend_from_slice(&link.seq.to_le_bytes());
        tails.extend_from_slice(&link.head);
    }
    let (seq, head) = crate::layout::chain_of(&after[wide])?;
    let link = wev::advance(wev::WideEntity::Province, seq, &head, &body).ok_or(OVERFLOW)?;
    crate::layout::set_chain(&mut after[wide], link.seq, &link.head)?;
    tails.extend_from_slice(&link.seq.to_le_bytes());
    tails.extend_from_slice(&link.head);
    body.extend_from_slice(&tails);
    Ok(body)
}

/// Eleven exact roles: actor,payer,season,Citizen,original Holding,wide standing,
/// System,issuer Province,external transit,wide roster,original destination.
pub(super) fn execute_depart(p: &Pubkey, a: &[AccountInfo], wire: &[u8]) -> R<()> {
    let [_, payer, season, citizen, holding, standing, system, home, external, roster, destination] =
        a
    else {
        return Err(FrontierError::TooManyAccounts.into());
    };
    roles(a, &[1, 3, 4, 5, 8], &[0, 1], &[(0, 1), (7, 10)], Some(6))?;
    if system.key != &init::SYSTEM
        || !system.executable
        || !init::is_absent(payer)
        || !init::is_absent(external)
    {
        return Err(BAD_ACCOUNT);
    }
    let ctx = addr::ctx(&key(season), &p.to_bytes());
    let x = ix::Depart::decode(&ctx, wire)?;
    let now = prologue::now()?;
    let start = player_start_as(p, a, now.ts, &Auth::Wallet)?;
    let hdr = start.season;
    require_wide_season(season)?;
    let bell = hdr.bell(now.ts).ok_or(FrontierError::WrongStatus)?;
    let (owner, _) = super::expedition_resident::source(p, &ctx, hdr.id, x.host, holding, home)?;
    if owner != key(citizen) {
        return Err(FrontierError::NotOwner.into());
    }
    let mut after: Vec<Vec<u8>> = a
        .iter()
        .map(|ai| ai.try_borrow_data().map(|d| d.to_vec()))
        .collect::<Result<_, _>>()?;
    let hh = ap::check_holding(&view(holding, &after[4]), &ctx, hdr.id, &owner)?;
    if hh.state != H::STATE_FINAL {
        return Err(FrontierError::NotFinal.into());
    }
    if wh::binding_of(&after[3], Ro(&after[4]).u8(H::ORDER)?).map_err(holding_err)?
        != wh::SlotBinding::Legacy(wh::HoldingRef {
            p: hh.p,
            q: hh.q,
            site: hh.site,
            gen: hh.gen,
        })
    {
        return Err(FrontierError::NotOwner.into());
    }
    let (standing_key, _, index, mut e) =
        super::expedition_resident::resident(p, &ctx, hdr.id, x.host, standing, roster)?;
    original_destination(p, &ctx, hdr.id, x.destination, destination)?;
    let rn = Ro(&after[5]).u32(PV::RESOLVED_NEXT)?;
    if !ap::resident_ok(rn, bell) || e.state != E::STATE_ROSTER || e.from_bell > bell {
        return Err(FrontierError::NotResident.into());
    }
    if e.faction != Ro(&after[3]).u8(C::FACTION)? {
        return Err(BAD_ACCOUNT);
    }
    if e.busy() {
        return Err(FrontierError::HostBusy.into());
    }
    if !super::super::host::seal_flag_ok(x.seal[0]) {
        return Err(FrontierError::BadData.into());
    }
    if x.arrive_bell < bell.checked_add(2).ok_or(OVERFLOW)?
        || x.arrive_bell > bell.checked_add(72).ok_or(OVERFLOW)?
        || x.arrive_bell >= hdr.end_bell
    {
        return Err(FrontierError::ArrivalBell.into());
    }
    let sr = Ro(&after[2]);
    if x.tip
        < fees::min_tip_lamports(
            sr.u32(S::MIN_REVEAL_PRIORITY_MILLI)?,
            sr.u32(S::REVEAL_CU_LIMIT)?,
            sr.u32(S::REVEAL_LOADED_LIMIT)?,
        )
    {
        return Err(FrontierError::TipTooLow.into());
    }
    let escrow = x
        .tip
        .checked_add(sr.u64(S::MARCH_FEE)?)
        .and_then(|v| v.checked_add(sr.u64(S::SEAL_BOND).ok()?))
        .ok_or(OVERFLOW)?;
    let bump = sr.u8(S::BUMP)?;
    let off = H::transit(x.slot as usize);
    if Ro(&after[4]).u8(off + T::STATE)? != T::STATE_FREE {
        return Err(FrontierError::TransitState.into());
    }
    expect_key(external, &wm::transit_address(&ctx, &key(holding), x.slot))?;
    let mut host = e.to_host().map_err(|_| BAD_ACCOUNT)?;
    host.depart(bell, super::super::host::DEPART_STAMINA, rn)
        .map_err(|e| super::super::host::host_err(e, FrontierError::NotResident))?;
    let dealt = hold::bps16(
        of_faction_v3(e.faction)
            .ok_or(BAD_ACCOUNT)?
            .dealt_bps(Posture::Stance(Stance::Hold), true),
    )?;
    let t = WideTransit::depart(
        wm::HOST_IDENTITY_FULL_REF_V1,
        x.host,
        e.unit,
        e.faction,
        TileAddress::new(standing_key, e.tile).map_err(|_| BAD_ACCOUNT)?,
        bell,
        x.arrive_bell,
        now.ts,
        e.troops,
        super::super::host::DEPART_STAMINA,
        dealt,
        cseal::wide_seal_root_of(&x.commit, &x.seal),
        0,
        0,
        key(payer),
    )
    .map_err(march_err)?;
    let reverse =
        ReverseTransit::new(&ctx, x.slot, t, owner, x.destination).map_err(|_| BAD_ACCOUNT)?;
    let marker = ReverseMarker::new(
        &ctx,
        &reverse,
        x.tip,
        T::FLAG_FEE_ESCROWED | T::FLAG_BOND_ESCROWED,
    )
    .map_err(|_| BAD_ACCOUNT)?;
    let touched = hold::load_touched(holding, now.ts)?;
    hold::write_holding(&mut after[4], &touched, now.ts)?;
    after[4][off..off + transport::MARKER_LEN].copy_from_slice(&marker.to_bytes());
    Rw(&mut after[4]).add_u64(H::ESCROW, escrow)?;
    start.finish(&mut after[3], now.ts)?;
    Rw(&mut after[3]).set_i64(C::LAST_ACTION_TS, now.ts)?;
    Rw(&mut after[3]).add_u32(C::ARRIVALS, 1)?;
    e.set_host(&host);
    write_entry(&mut after[5], index, &e).map_err(|_| BAD_ACCOUNT)?;
    after[8] = reverse.to_bytes().to_vec();
    let rent = init::rent(transport::LEN)?;
    let rent_paid = rent.saturating_sub(external.try_lamports()?);
    let mut balances = a
        .iter()
        .map(|a| a.try_lamports())
        .collect::<Result<Vec<_>, _>>()?;
    balances[1] = balances[1]
        .checked_sub(escrow.checked_add(rent_paid).ok_or(OVERFLOW)?)
        .ok_or(FrontierError::Insufficient)?;
    if a[0].key == payer.key {
        balances[0] = balances[1]
    }
    balances[4] = balances[4].checked_add(escrow).ok_or(OVERFLOW)?;
    balances[8] = balances[8].checked_add(rent_paid).ok_or(OVERFLOW)?;
    let log = receipt(
        p,
        a,
        &mut after,
        &balances,
        wire,
        1,
        &[
            (3, frontier_abi::log::EntityKind::Citizen),
            (4, frontier_abi::log::EntityKind::Holding),
        ],
        5,
    )?;
    {
        let _c = citizen.try_borrow_mut_data()?;
        let _h = holding.try_borrow_mut_data()?;
        let _p = standing.try_borrow_mut_data()?;
        let _t = external.try_borrow_mut_data()?;
        let _pb = payer.try_borrow_mut_lamports()?;
        let _hb = holding.try_borrow_mut_lamports()?;
        let _tb = external.try_borrow_mut_lamports()?;
    }
    init::transfer(payer, holding, escrow)?;
    init::init_with_seed(
        payer,
        external,
        season,
        &SeasonSigner::new(hdr.id, bump),
        &wm::transit_seed(&key(holding), x.slot),
        transport::LEN,
        rent,
        p,
    )?;
    let mut writes = Vec::new();
    for i in [3, 4, 5, 8] {
        let d = a[i].try_borrow_mut_data()?;
        if d.len() != after[i].len() {
            return Err(BAD_ACCOUNT);
        }
        writes.push((i, d));
    }
    for i in [1, 4, 8] {
        if a[i].try_lamports()? != balances[i] {
            return Err(BAD_ACCOUNT);
        }
    }
    for (i, d) in &mut writes {
        d.copy_from_slice(&after[*i]);
    }
    drop(writes);
    solana_program::log::sol_log_data(&[b"PSFR", &log]);
    Ok(())
}

/// Seven roles: payer,Season,issuer Holding,issuer Province,wide standing,
/// writable wide roster,external reverse record. No payment or CPI.
pub(super) fn execute_origin(p: &Pubkey, a: &[AccountInfo], slot: u8) -> R<()> {
    let [_, season, holding, home, standing, roster_ai, external] = a else {
        return Err(FrontierError::TooManyAccounts.into());
    };
    roles(a, &[2, 4, 5, 6], &[0], &[], None)?;
    if slot >= 4 || external.owner != p {
        return Err(BAD_ACCOUNT);
    }
    let now = prologue::now()?;
    let hdr = settle_season(season, p, now.ts)?;
    let ctx = addr::ctx(&key(season), &p.to_bytes());
    let reverse =
        ReverseTransit::from_bytes(&ctx, &external.try_borrow_data()?).map_err(|_| BAD_ACCOUNT)?;
    let t = reverse.transit();
    if t.state != MarchState::Departed {
        return Err(FrontierError::AlreadyDone.into());
    }
    let r = AccountResolver::for_season(&ctx).map_err(|_| BAD_ACCOUNT)?;
    expect_key(
        holding,
        &r.holding_address(&t.host).map_err(|_| BAD_ACCOUNT)?,
    )?;
    prologue::present_v2(
        holding,
        p,
        frontier_abi::v2::layout::AccountKind::Holding,
        hdr.id,
    )?;
    check_source_province(p, &ctx, hdr.id, holding, home)?;
    let mut after: Vec<Vec<u8>> = a
        .iter()
        .map(|ai| ai.try_borrow_data().map(|d| d.to_vec()))
        .collect::<Result<_, _>>()?;
    let hd = Ro(&after[2]);
    let id = r.legacy_host_id(&t.host).map_err(|_| BAD_ACCOUNT)?;
    let parts = frontier_abi::addr::split_host_id(id).ok_or(BAD_ACCOUNT)?;
    if hd.i16(H::P)? as i32 != parts.province.p
        || hd.i16(H::Q)? as i32 != parts.province.q
        || hd.u8(H::SITE)? != parts.site
        || !matches!(hd.u8(H::STATE)?, H::STATE_PROVISIONAL | H::STATE_FINAL)
        || hd.u8(H::GEN)? != t.host.gen()
        || t.host.seq() >= hd.u32(H::HOST_SEQ)?
        || hd.arr::<32>(H::OWNER_CITIZEN)? != reverse.original_owner()
    {
        return Err(FrontierError::NotOwner.into());
    }
    let off = H::transit(slot as usize);
    let marker = ReverseMarker::from_bytes(&ctx, &after[2][off..off + transport::MARKER_LEN])
        .map_err(|_| BAD_ACCOUNT)?;
    transport::authenticate_pair(&ctx, &key(holding), slot, &key(external), &marker, &reverse)
        .map_err(|_| BAD_ACCOUNT)?;
    let (key, roster, index, e) =
        super::expedition_resident::resident(p, &ctx, hdr.id, t.host, standing, roster_ai)?;
    let rn = Ro(&after[4]).u32(PV::RESOLVED_NEXT)?;
    if key != t.origin.key()
        || e.tile != t.origin.local()
        || e.unit != t.unit
        || e.faction != t.faction
        || e.state != E::STATE_DEPARTED
        || rn <= t.depart_bell
    {
        return Err(FrontierError::TooEarly.into());
    }
    let host = e.to_host().map_err(|_| BAD_ACCOUNT)?;
    let (troops, stamina) = host
        .march_values(t.depart_bell, rn)
        .map_err(|e| super::super::host::host_err(e, FrontierError::TooEarly))?;
    let destroyed = troops < permutation_rules::frontier::host::DESTROYED_BELOW;
    let (troops, stamina) = if destroyed { (0, 0) } else { (troops, stamina) };
    let ready = e
        .ready_bell
        .saturating_sub(t.depart_bell)
        .min(u16::MAX as u32) as u16;
    after[6] = reverse
        .settle_origin(&ctx, destroyed, (troops, stamina, ready))
        .map_err(|_| BAD_ACCOUNT)?
        .to_bytes()
        .to_vec();
    write_entry(&mut after[4], index, &Entry::FREE).map_err(|_| BAD_ACCOUNT)?;
    let count = Ro(&after[4])
        .u8(PV::N_ENTRIES)?
        .checked_sub(1)
        .ok_or(BAD_ACCOUNT)?;
    Rw(&mut after[4]).set_u8(PV::N_ENTRIES, count)?;
    roster
        .release(&mut after[5], index)
        .map_err(|_| BAD_ACCOUNT)?;
    let balances = a
        .iter()
        .map(|a| a.try_lamports())
        .collect::<Result<Vec<_>, _>>()?;
    let log = receipt(
        p,
        a,
        &mut after,
        &balances,
        &[slot],
        2,
        &[(2, frontier_abi::log::EntityKind::Holding)],
        4,
    )?;
    let mut writes = Vec::new();
    for i in [2, 4, 5, 6] {
        let d = a[i].try_borrow_mut_data()?;
        if d.len() != after[i].len() {
            return Err(BAD_ACCOUNT);
        }
        writes.push((i, d));
    }
    for (i, d) in &mut writes {
        d.copy_from_slice(&after[*i]);
    }
    drop(writes);
    solana_program::log::sol_log_data(&[b"PSFR", &log]);
    Ok(())
}

#[cfg(all(
    test,
    feature = "runtime-contract-tests",
    feature = "system-cpi-tests",
    not(target_os = "solana")
))]
#[path = "wide_expedition_reverse_tests.rs"]
mod tests;
