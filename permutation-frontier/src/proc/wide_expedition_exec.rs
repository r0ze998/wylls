//! Closed legacy expedition candidate. Public dispatch stays disabled.
//! Staging is read-only; private commits authenticate again in the same call
//! and prepare bounded original-chain receipts before effects. Plans are never
//! authorization tokens. Tests do not exercise the departure allocation CPI.
use super::*;
use frontier_abi::entry::{find_entry, read_entry, write_entry, Entry};
use frontier_abi::world_index::expedition::AccountResolver;
use frontier_abi::world_index::expedition_bridge::{authenticate_pair, BridgeMarker, MARKER_LEN};
use frontier_abi::world_index::expedition_event as receipt;
use frontier_abi::world_index::expedition_transport::{OwnedBridgeTransit, OWNED_BRIDGE_LEN};

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

fn snapshots(a: &[AccountInfo]) -> R<Vec<Snapshot>> {
    a.iter()
        .map(|ai| {
            Ok(Snapshot {
                address: key(ai),
                owner: ai.owner.to_bytes(),
                present: !init::is_absent(ai),
                signer: ai.is_signer,
                writable: ai.is_writable,
                lamports: ai.lamports(),
                data: ai.try_borrow_data()?.to_vec(),
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

/// A standing Province can also occupy the issuer-Province role. All aliases
/// commit the same resulting bytes/balance while retaining observed privileges.
fn replace(s: &mut [Snapshot], i: usize, next: Snapshot) {
    let address = s[i].address;
    for item in s.iter_mut().filter(|s| s.address == address) {
        item.owner = next.owner;
        item.present = next.present;
        item.lamports = next.lamports;
        item.data.clone_from(&next.data);
    }
}

pub(super) struct ReceiptPlan {
    after: Vec<Snapshot>,
    body: Vec<u8>,
}

/// Prepare a bounded PS2 record and all original header advances on copies.
/// Input headers are raw; only output headers are normalized by the codec.
fn prepare_receipt(
    ctx: &AddrCtx,
    action: receipt::Action,
    identity: receipt::Identity,
    command: &[u8],
    now: i64,
    bell: u32,
    before: &[Snapshot],
    mut after: Vec<Snapshot>,
    outcomes: receipt::Outcomes,
) -> R<ReceiptPlan> {
    let season_i = if action == receipt::Action::Depart {
        2
    } else {
        1
    };
    let context = receipt::Context {
        command,
        now_ts: now,
        bell,
        season: &before[season_i].data,
        evidence: &[],
    };
    let input = receipt::input_digest(ctx, action, &identity, &context, &manifest(before))
        .map_err(|_| BAD_ACCOUNT)?;
    let output = receipt::output_digest(
        ctx,
        action,
        &identity,
        &context,
        &manifest(&after),
        outcomes,
    )
    .map_err(|_| BAD_ACCOUNT)?;
    let mut previous = Vec::new();
    for entity in action.entities() {
        let address = match entity {
            frontier_abi::log::EntityKind::Citizen => identity.citizen,
            frontier_abi::log::EntityKind::Holding => identity.holding,
            frontier_abi::log::EntityKind::Province => identity.province,
            _ => return Err(BAD_ACCOUNT),
        };
        let s = before
            .iter()
            .find(|s| s.address == address)
            .ok_or(BAD_ACCOUNT)?;
        let (seq, head) = crate::layout::chain_of(&s.data)?;
        previous.push(frontier_abi::log::Link {
            entity: *entity,
            seq,
            head,
        });
    }
    let (body, links) = receipt::SourceReceipt {
        bell,
        identity,
        receipt: receipt::Receipt::new(action, input, output),
    }
    .prepare(ctx, &previous)
    .map_err(|_| OVERFLOW)?;
    for link in links {
        let address = match link.entity {
            frontier_abi::log::EntityKind::Citizen => identity.citizen,
            frontier_abi::log::EntityKind::Holding => identity.holding,
            frontier_abi::log::EntityKind::Province => identity.province,
            _ => return Err(BAD_ACCOUNT),
        };
        for s in after.iter_mut().filter(|s| s.address == address) {
            crate::layout::set_chain(&mut s.data, link.seq, &link.head)?;
        }
    }
    Ok(ReceiptPlan { after, body })
}

pub(super) fn prepare_depart(
    p: &Pubkey,
    a: &[AccountInfo],
    x: &wix::ExpeditionDepart,
    auth: &Auth,
) -> R<ReceiptPlan> {
    let plan = stage_depart(p, a, x, auth)?;
    let before = snapshots(a)?;
    let mut after = before.clone();
    let ctx = addr::ctx(&key(&a[2]), &p.to_bytes());
    let transit = OwnedBridgeTransit::from_bytes(&ctx, &plan.bridge)
        .map_err(|_| BAD_ACCOUNT)?
        .transit();
    let identity = receipt::Identity {
        host: transit.host,
        slot: x.transit_slot,
        citizen: key(&a[3]),
        holding: key(&a[4]),
        origin: transit.origin.key(),
        province: key(&a[5]),
        external: key(&a[8]),
    };
    for (i, data) in [(3, plan.citizen), (4, plan.holding), (5, plan.province)] {
        let mut next = after[i].clone();
        next.data = data;
        replace(&mut after, i, next);
    }
    let rent_paid = plan.rent.saturating_sub(a[8].lamports());
    let total = plan.escrow.checked_add(rent_paid).ok_or(OVERFLOW)?;
    if total != 0 && !init::is_absent(&a[1]) {
        return Err(BAD_ACCOUNT);
    }
    let mut payer = after[1].clone();
    payer.lamports = payer
        .lamports
        .checked_sub(total)
        .ok_or(FrontierError::Insufficient)?;
    replace(&mut after, 1, payer);
    let mut holding = after[4].clone();
    holding.lamports = holding.lamports.checked_add(plan.escrow).ok_or(OVERFLOW)?;
    replace(&mut after, 4, holding);
    let mut external = after[8].clone();
    external.owner = p.to_bytes();
    external.present = true;
    external.lamports = external.lamports.checked_add(rent_paid).ok_or(OVERFLOW)?;
    external.data = plan.bridge.to_vec();
    replace(&mut after, 8, external);
    // Dedicated provisional envelope, never reinterpret WideDepart dispatch.
    let command = x.to_bytes();
    prepare_receipt(
        &ctx,
        receipt::Action::Depart,
        identity,
        &command,
        transit.depart_ts,
        transit.depart_bell,
        &before,
        after,
        receipt::Outcomes {
            escrow: plan.escrow,
            rent: rent_paid,
            dep_mass: transit.dep_mass,
            march_stamina: transit.march_stamina,
            finalized: plan.became_final,
            ..receipt::Outcomes::default()
        },
    )
}

pub(super) fn prepare_origin(p: &Pubkey, a: &[AccountInfo], slot: u8) -> R<ReceiptPlan> {
    let plan = stage_origin(p, a, slot)?;
    let before = snapshots(a)?;
    let mut after = before.clone();
    let ctx = addr::ctx(&key(&a[1]), &p.to_bytes());
    let transit = OwnedBridgeTransit::from_bytes(&ctx, &plan.bridge)
        .map_err(|_| BAD_ACCOUNT)?
        .transit();
    let identity = receipt::Identity {
        host: transit.host,
        slot,
        citizen: [0; 32],
        holding: key(&a[3]),
        origin: transit.origin.key(),
        province: key(&a[2]),
        external: key(&a[5]),
    };
    for (i, data) in [(2, plan.province), (5, plan.bridge.to_vec())] {
        let mut next = after[i].clone();
        next.data = data;
        replace(&mut after, i, next);
    }
    let now = prologue::now()?;
    let hdr = prologue::season(
        &a[1],
        p,
        Some(&RULESET_HASH),
        &[S::STATUS_RUNNING, S::STATUS_ENDED],
        now.ts,
    )?;
    prepare_receipt(
        &ctx,
        receipt::Action::SettleOrigin,
        identity,
        &wix::ExpeditionSettleOrigin { transit_slot: slot }.to_bytes(),
        now.ts,
        hdr.bell(now.ts).unwrap_or(frontier_abi::log::NO_BELL),
        &before,
        after,
        receipt::Outcomes {
            dep_mass: transit.dep_mass,
            march_stamina: transit.march_stamina,
            troops_after: transit.troops_after,
            stamina_after: transit.stamina_after,
            ready_bell_off: transit.ready_bell_off,
            destroyed: transit.state == MarchState::DestroyedAtOrigin,
            ..receipt::Outcomes::default()
        },
    )
}

/// Private candidate commit. Public dispatch must refuse before reaching this
/// function. Every deterministic byte/chain/financial operation is preflighted
/// by prepare_depart. CPI failures still rely on the chain transaction rollback.
pub(super) fn execute_depart(
    p: &Pubkey,
    a: &[AccountInfo],
    x: &wix::ExpeditionDepart,
    auth: &Auth,
) -> R<()> {
    let plan = prepare_depart(p, a, x, auth)?;
    let payer = &a[1];
    let season = &a[2];
    let holding = &a[4];
    let external = &a[8];
    let sd = season.try_borrow_data()?;
    let sid = prologue::season(
        season,
        p,
        Some(&RULESET_HASH),
        &[S::STATUS_RUNNING],
        prologue::now()?.ts,
    )?
    .id;
    let signer = SeasonSigner::new(sid, Ro(&sd).u8(S::BUMP)?);
    drop(sd);
    let escrow = plan.after[4]
        .lamports
        .checked_sub(holding.lamports())
        .ok_or(BAD_ACCOUNT)?;
    // A held read borrow is a deterministic refusal, not a CPI failure. Check
    // every distinct mutable data/balance borrow together before moving funds.
    // Release before the System CPI, which must access its own accounts.
    {
        let _cd = a[3].try_borrow_mut_data()?;
        let _hd = holding.try_borrow_mut_data()?;
        let _pd = a[5].try_borrow_mut_data()?;
        let _td = external.try_borrow_mut_data()?;
        let _payer_balance = payer.try_borrow_mut_lamports()?;
        let _holding_balance = holding.try_borrow_mut_lamports()?;
        let _external_balance = external.try_borrow_mut_lamports()?;
    }
    init::transfer(payer, holding, escrow)?;
    init::init_with_seed(
        payer,
        external,
        season,
        &signer,
        &wm::transit_seed(&key(holding), x.transit_slot),
        OWNED_BRIDGE_LEN,
        init::rent(OWNED_BRIDGE_LEN)?,
        p,
    )?;
    // Acquire every distinct mutable borrow and verify lengths/balances before
    // copying any live bytes. The issuer Province may alias standing Province,
    // but has no second write here.
    let mut cd = a[3].try_borrow_mut_data()?;
    let mut hd = holding.try_borrow_mut_data()?;
    let mut pd = a[5].try_borrow_mut_data()?;
    let mut td = external.try_borrow_mut_data()?;
    if cd.len() != plan.after[3].data.len()
        || hd.len() != plan.after[4].data.len()
        || pd.len() != plan.after[5].data.len()
        || td.len() != OWNED_BRIDGE_LEN
        || payer.lamports() != plan.after[1].lamports
        || holding.lamports() != plan.after[4].lamports
        || external.lamports() != plan.after[8].lamports
    {
        return Err(BAD_ACCOUNT);
    }
    cd.copy_from_slice(&plan.after[3].data);
    hd.copy_from_slice(&plan.after[4].data);
    pd.copy_from_slice(&plan.after[5].data);
    td.copy_from_slice(&plan.after[8].data);
    solana_program::log::sol_log_data(&[receipt::PREFIX, &plan.body]);
    Ok(())
}

/// Private candidate origin commit, no CPI or payment. Marker finances remain
/// exactly current; the Holding's ONLY change is its original PS2 chain tail.
pub(super) fn execute_origin(p: &Pubkey, a: &[AccountInfo], slot: u8) -> R<()> {
    let plan = prepare_origin(p, a, slot)?;
    let mut pd = a[2].try_borrow_mut_data()?;
    let mut hd = a[3].try_borrow_mut_data()?;
    let mut td = a[5].try_borrow_mut_data()?;
    if pd.len() != plan.after[2].data.len()
        || hd.len() != plan.after[3].data.len()
        || td.len() != plan.after[5].data.len()
    {
        return Err(BAD_ACCOUNT);
    }
    pd.copy_from_slice(&plan.after[2].data);
    hd.copy_from_slice(&plan.after[3].data);
    td.copy_from_slice(&plan.after[5].data);
    solana_program::log::sol_log_data(&[receipt::PREFIX, &plan.body]);
    Ok(())
}

/// Receipt/readers, routing, return and terminal cleanup remain incomplete.
/// No public argument or feature can turn this into a writer.
pub(super) const EXPEDITION_ENABLED: bool = false;

pub(super) struct DepartPlan {
    pub citizen: Vec<u8>,
    pub holding: Vec<u8>,
    pub province: Vec<u8>,
    pub bridge: [u8; OWNED_BRIDGE_LEN],
    pub escrow: u64,
    pub rent: u64,
    pub became_final: bool,
}

/// Private typed input only, NOT the existing WideDepart instruction. Account
/// shape is legacy Depart's eight accounts plus the selected external slot.
/// The embedded four slots are the sole occupancy ledger; every bridge marker
/// is checked by host_in_transit_with_bridge before this slot is reserved.
pub(super) fn stage_depart(
    p: &Pubkey,
    a: &[AccountInfo],
    x: &wix::ExpeditionDepart,
    auth: &Auth,
) -> R<DepartPlan> {
    let [_, payer, season_ai, citizen, holding, province, _, own, external] = a else {
        return Err(FrontierError::TooManyAccounts.into());
    };
    check_accounts(Shape(wix::EXPEDITION_DEPART), a, None)?;
    let now = prologue::now()?;
    let start = player_start_as(p, a, now.ts, auth)?;
    let hdr = start.season;
    let bell = hdr.bell(now.ts).ok_or(FrontierError::WrongStatus)?;
    let ctx = addr::ctx(&key(season_ai), &p.to_bytes());
    let resolver = AccountResolver::for_season(&ctx).map_err(|_| BAD_ACCOUNT)?;
    let host_ref = WideHostRef::from_bytes(&x.host).map_err(|_| BAD_ACCOUNT)?;
    let id = resolver
        .legacy_host_id(&host_ref)
        .map_err(|_| BAD_ACCOUNT)?;
    prologue::present_v2(
        holding,
        p,
        frontier_abi::v2::layout::AccountKind::Holding,
        hdr.id,
    )?;
    let mut hd = holding.try_borrow_data()?.to_vec();
    let hh = ap::check_holding(&view(holding, &hd), &ctx, hdr.id, &key(citizen))?;
    if host_ref.gen() != hh.gen
        || resolver
            .holding_address(&host_ref)
            .map_err(|_| BAD_ACCOUNT)?
            != key(holding)
    {
        return Err(FrontierError::NotOwner.into());
    }
    if host_ref.seq() >= Ro(&hd).u32(H::HOST_SEQ)? {
        return Err(BAD_ACCOUNT);
    }
    check_source_province(p, &ctx, hdr.id, holding, own)?;
    prologue::present_v2(
        province,
        p,
        frontier_abi::v2::layout::AccountKind::Province,
        hdr.id,
    )?;
    let mut pd = province.try_borrow_data()?.to_vec();
    let pp = Ro(&pd).i16(PV::P)?;
    let pq = Ro(&pd).i16(PV::Q)?;
    expect_key(province, &ctx.province(pp as i32, pq as i32))?;
    let rn = Ro(&pd).u32(PV::RESOLVED_NEXT)?;
    let mut cd = citizen.try_borrow_data()?.to_vec();
    let home_slot = Ro(&hd).u8(H::ORDER)?;
    if !(1..=3).contains(&home_slot) {
        return Err(BAD_ACCOUNT);
    }
    let home = C2::holding_of_slot(home_slot);
    let cr = Ro(&cd);
    if cr.i16(home)? != hh.p
        || cr.i16(home + 2)? != hh.q
        || cr.u8(home + 4)? != hh.site
        || cr.u8(home + 5)? != hh.gen
    {
        return Err(FrontierError::NotOwner.into());
    }
    // Preserve the legacy lazy finality rule, but only on snapshots.
    if (pp, pq) == (hh.p, hh.q) {
        capture_lock_of(&pd, &hd)?;
        if ap::finality_due(&hh, &pd, now.ts, bell) {
            if Ro(&hd).u8(H::ORDER)? == 1 {
                ap::apply_finality(&mut hd, &mut cd)?;
            } else {
                Rw(&mut hd).set_u8(H::STATE, H::STATE_FINAL)?;
            }
        }
    }
    if Ro(&hd).u8(H::STATE)? != H::STATE_FINAL {
        return Err(FrontierError::NotFinal.into());
    }
    if !ap::resident_ok(rn, bell) {
        return Err(FrontierError::NotResident.into());
    }
    if !super::super::host::seal_flag_ok(x.seal[0]) {
        return Err(FrontierError::BadData.into());
    }
    if ap::host_in_transit_with_bridge(&ctx, &key(holding), &hd, id)? {
        return Err(FrontierError::HostInTransit.into());
    }
    let index = find_entry(&pd, id).ok_or(FrontierError::NotResident)?;
    let mut e = read_entry(&pd, index).map_err(|_| BAD_ACCOUNT)?;
    if e.state != E::STATE_ROSTER {
        return Err(FrontierError::NotResident.into());
    }
    if e.busy() {
        return Err(FrontierError::HostBusy.into());
    }
    let mut host = e.to_host().map_err(|_| BAD_ACCOUNT)?;
    host.depart(bell, super::super::host::DEPART_STAMINA, rn)
        .map_err(|e| super::super::host::host_err(e, FrontierError::NotResident))?;
    if x.arrive_bell < bell.checked_add(2).ok_or(OVERFLOW)?
        || x.arrive_bell > bell.checked_add(72).ok_or(OVERFLOW)?
        || x.arrive_bell >= hdr.end_bell
    {
        return Err(FrontierError::ArrivalBell.into());
    }
    let sd = season_ai.try_borrow_data()?;
    let sr = Ro(&sd);
    if x.tip
        < fees::min_tip_lamports(
            sr.u32(S::MIN_REVEAL_PRIORITY_MILLI)?,
            sr.u32(S::REVEAL_CU_LIMIT)?,
            sr.u32(S::REVEAL_LOADED_LIMIT)?,
        )
    {
        return Err(FrontierError::TipTooLow.into());
    }
    if x.transit_slot as usize >= H::TRANSIT_N {
        return Err(FrontierError::BadData.into());
    }
    let off = H::transit(x.transit_slot as usize);
    if Ro(&hd).u8(off + T::STATE)? != T::STATE_FREE {
        return Err(FrontierError::TransitState.into());
    }
    expect_key(
        external,
        &wm::transit_address(&ctx, &key(holding), x.transit_slot),
    )?;
    if !external.is_writable || !init::is_absent(external) {
        return Err(BAD_ACCOUNT);
    }
    let fee = sr.u64(S::MARCH_FEE)?;
    let bond = sr.u64(S::SEAL_BOND)?;
    let escrow = x
        .tip
        .checked_add(fee)
        .and_then(|n| n.checked_add(bond))
        .ok_or(OVERFLOW)?;
    let rent = init::rent(OWNED_BRIDGE_LEN)?;
    let rent_paid = rent.saturating_sub(external.lamports());
    if payer.lamports() < escrow.checked_add(rent_paid).ok_or(OVERFLOW)? {
        return Err(FrontierError::Insufficient.into());
    }
    let origin_key = ProvinceKey::new(
        world_of(&ctx)?,
        WideCoord::checked(pp as i64, pq as i64).map_err(|_| BAD_ACCOUNT)?,
    );
    let origin = TileAddress::new(origin_key, e.tile).map_err(|_| BAD_ACCOUNT)?;
    let dealt = hold::bps16(
        of_faction_v3(e.faction)
            .ok_or(BAD_ACCOUNT)?
            .dealt_bps(Posture::Stance(Stance::Hold), true),
    )?;
    let transit = WideTransit::depart(
        wm::HOST_IDENTITY_FULL_REF_V1,
        host_ref,
        e.unit,
        e.faction,
        origin,
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
    // player_start_as authenticated this Citizen and check_holding matched its
    // full address against OWNER_CITIZEN. Retain it even after later capture.
    let bridge = OwnedBridgeTransit::new(&ctx, x.transit_slot, transit, key(citizen))
        .map_err(|_| BAD_ACCOUNT)?;
    let marker = BridgeMarker::new(
        &ctx,
        bridge.common(),
        x.tip,
        T::FLAG_FEE_ESCROWED | T::FLAG_BOND_ESCROWED,
    )
    .map_err(|_| BAD_ACCOUNT)?;
    let touched = hold::load_touched(holding, now.ts)?;
    hold::write_holding(&mut hd, &touched, now.ts)?;
    hd[off..off + MARKER_LEN].copy_from_slice(&marker.to_bytes());
    Rw(&mut hd).add_u64(H::ESCROW, escrow)?;
    start.finish(&mut cd, now.ts)?;
    Rw(&mut cd).set_i64(C::LAST_ACTION_TS, now.ts)?;
    Rw(&mut cd).add_u32(C::ARRIVALS, 1)?;
    e.set_host(&host);
    write_entry(&mut pd, index, &e).map_err(|_| BAD_ACCOUNT)?;
    Ok(DepartPlan {
        citizen: cd,
        holding: hd,
        province: pd,
        bridge: bridge.to_bytes(),
        escrow,
        rent,
        became_final: hh.state != H::STATE_FINAL,
    })
}

/// Exact origin-settlement outputs, before receipts. Holding bytes (including
/// current capture-cleared financial flags) are deliberately unchanged.
pub(super) struct OriginPlan {
    pub province: Vec<u8>,
    pub bridge: [u8; OWNED_BRIDGE_LEN],
}

/// Permissionless, read-only preparation, with the legacy SettleDeparture
/// account table followed by the paired external account. The existing source
/// combat/Spend resolution is NOT run here: only its actual settled entry can
/// pass `march_values`. Neither caller-provided survivors nor a WideRoster is
/// accepted. No balances, escrow, rent, generation or reserve are changed.
pub(super) fn stage_origin(p: &Pubkey, a: &[AccountInfo], slot: u8) -> R<OriginPlan> {
    let [payer, season_ai, province, holding, holding_province, external] = a else {
        return Err(FrontierError::TooManyAccounts.into());
    };
    check_accounts(Shape(wix::EXPEDITION_SETTLE_ORIGIN), a, None)?;
    if !payer.is_signer || !external.is_writable || external.owner != p {
        return Err(BAD_ACCOUNT);
    }
    require_wide_season(season_ai)?;
    let now = prologue::now()?;
    let hdr = prologue::season(
        season_ai,
        p,
        Some(&RULESET_HASH),
        &[S::STATUS_RUNNING, S::STATUS_ENDED],
        now.ts,
    )?;
    let ctx = addr::ctx(&key(season_ai), &p.to_bytes());
    prologue::present_v2(
        holding,
        p,
        frontier_abi::v2::layout::AccountKind::Holding,
        hdr.id,
    )?;
    check_source_province(p, &ctx, hdr.id, holding, holding_province)?;
    if slot as usize >= H::TRANSIT_N {
        return Err(FrontierError::BadData.into());
    }
    let hd = holding.try_borrow_data()?;
    let r = Ro(&hd);
    let (hp, hq, site) = (r.i16(H::P)?, r.i16(H::Q)?, r.u8(H::SITE)?);
    expect_key(holding, &ctx.holding(hp as i32, hq as i32, site))?;
    let off = H::transit(slot as usize);
    let marker =
        BridgeMarker::from_bytes(&ctx, &hd[off..off + MARKER_LEN]).map_err(|_| BAD_ACCOUNT)?;
    let bridge = OwnedBridgeTransit::from_bytes(&ctx, &external.try_borrow_data()?)
        .map_err(|_| BAD_ACCOUNT)?;
    authenticate_pair(
        &ctx,
        &key(holding),
        slot,
        &key(external),
        &marker,
        bridge.common(),
    )
    .map_err(|_| BAD_ACCOUNT)?;
    let t = bridge.transit();
    if t.state != wm::MarchState::Departed {
        return Err(FrontierError::AlreadyDone.into());
    }
    let resolver = AccountResolver::for_season(&ctx).map_err(|_| BAD_ACCOUNT)?;
    let id = resolver.legacy_host_id(&t.host).map_err(|_| BAD_ACCOUNT)?;
    // Capture resets HOST_SEQ. It is authoritative only for this generation.
    // The paired marker is the previous generation's durable reservation,
    // exactly as in legacy SettleDeparture; no current owner's troops credited.
    if t.host.gen() == r.u8(H::GEN)? && t.host.seq() >= r.u32(H::HOST_SEQ)? {
        return Err(BAD_ACCOUNT);
    }
    expect_key(
        province,
        &resolver
            .province_address(t.origin.key())
            .map_err(|_| BAD_ACCOUNT)?,
    )?;
    prologue::present_v2(
        province,
        p,
        frontier_abi::v2::layout::AccountKind::Province,
        hdr.id,
    )?;
    let mut pd = province.try_borrow_data()?.to_vec();
    let origin = resolver
        .adapter()
        .coord_of(&t.origin.key())
        .map_err(|_| BAD_ACCOUNT)?;
    if Ro(&pd).i16(PV::P)? as i32 != origin.p || Ro(&pd).i16(PV::Q)? as i32 != origin.q {
        return Err(BAD_ACCOUNT);
    }
    if (origin.p, origin.q) == (hp as i32, hq as i32) {
        capture_lock_of(&pd, &hd)?;
    }
    let rn = Ro(&pd).u32(PV::RESOLVED_NEXT)?;
    if rn <= t.depart_bell {
        return Err(FrontierError::TooEarly.into());
    }
    let index = find_entry(&pd, id).ok_or(FrontierError::NotResident)?;
    let e = read_entry(&pd, index).map_err(|_| BAD_ACCOUNT)?;
    if e.state != E::STATE_DEPARTED
        || e.unit != t.unit
        || e.faction != t.faction
        || e.tile != t.origin.local()
    {
        return Err(FrontierError::NotResident.into());
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
    let next = bridge
        .settle_origin(&ctx, destroyed, Some((troops, stamina, ready)))
        .map_err(|_| BAD_ACCOUNT)?;
    write_entry(&mut pd, index, &Entry::FREE).map_err(|_| BAD_ACCOUNT)?;
    let n = Ro(&pd)
        .u8(PV::N_ENTRIES)?
        .checked_sub(1)
        .ok_or(BAD_ACCOUNT)?;
    Rw(&mut pd).set_u8(PV::N_ENTRIES, n)?;
    Ok(OriginPlan {
        province: pd,
        bridge: next.to_bytes(),
    })
}

#[cfg(test)]
#[path = "wide_expedition_exec_tests.rs"]
mod tests;
