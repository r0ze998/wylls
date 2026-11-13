//! Siege reservations end to end on the real handlers (experimental conquest
//! lane only): DeclareSiege behind the cursor -> resolve_inner with conquest
//! -> SettleReservation (dispatch kind 18) -> CloseCaptureEscrow /
//! CloseConquest. Spec: docs/integration/CLAUDE-CONQUEST-RESERVATION-SPEC-20261112.md.
//!
//! Fixture rules. Only literal public identities, PDA arithmetic and codecs;
//! no signing, keys, network or processes. No combat result, report, table
//! entry or reservation outcome is ever fabricated: they come only from the
//! handlers. Fixture state is written only (a) before the first handler runs
//! (cursor, host positions/troops, second Citizen, Season end) or (b) where a
//! case needs a state that no handler in this harness can produce; every
//! such write is marked `FIXTURE (between handlers)` with its reason.
use super::*;
use crate::layout::{citizen as C1, holding as H1};
use crate::proc::wide::conquest_exec as declaration_engine;
use crate::proc::wide::conquest_exec::tests as declaration;
use frontier_abi::layout::player::accrual as A;
use frontier_abi::world_index::conquest::WideConquestEntry;
use frontier_abi::world_index::event::WideRecord;

const WALLET2: [u8; 32] = [0xa2; 32];
const ANY: [u8; 32] = [0xee; 32];
const NOW: i64 = GENESIS + 6_000;
const GOLD: usize = permutation_rules::frontier::holding::Resource::Gold as usize;
const ARMS: usize = permutation_rules::frontier::arms::ARMS as usize;
const ENDED_GRACE_BELL: u32 = 1000 + 432;

fn pk(a: &[AccountInfo]) -> ProvinceKey {
    let ctx = addr::ctx(&key(&a[2]), &PROGRAM);
    ProvinceKey::new(world_of(&ctx).unwrap(), WideCoord::checked(129, 0).unwrap())
}
fn tbl(a: &[AccountInfo]) -> WideConquest {
    let ctx = addr::ctx(&key(&a[2]), &PROGRAM);
    table(&program(), &ctx, SID, pk(a), &a[9]).unwrap()
}
fn prefix(a: &[AccountInfo]) -> Record {
    Record::read(&a[5].try_borrow_data().unwrap(), 1).unwrap()
}
fn cursor(a: &[AccountInfo]) -> u32 {
    Ro(&a[5].try_borrow_data().unwrap())
        .u32(PV::RESOLVED_NEXT)
        .unwrap()
}
fn wide_rent() -> u64 {
    init::rent(wh::wide_holding::SIZE).unwrap()
}

/// FIXTURE (before any handler): the province cursor and its bell-local
/// bookkeeping, as the existing lifecycle sets them for cursor 10.
fn prep(a: &[AccountInfo], next: u32) {
    let mut pd = a[5].try_borrow_mut_data().unwrap();
    pd[PV2::KEEP + frontier_abi::v2::layout::province::keep::TILE] =
        frontier_abi::v2::layout::province::keep::NO_TILE;
    Rw(&mut pd).set_u32(PV2::SCORE_NEXT_BELL, next).unwrap();
    Rw(&mut pd)
        .set_u32(PV::CAMP + CP::NEXT_CHECK_DAY, 1)
        .unwrap();
    Rw(&mut pd).set_u32(PV::RESOLVED_NEXT, next).unwrap();
}

/// FIXTURE (before any handler): the host in roster entry `i`.
fn host_entry(a: &[AccountInfo], i: usize, edit: impl FnOnce(&mut Entry)) {
    let mut pd = a[5].try_borrow_mut_data().unwrap();
    let mut e = read_entry(&pd, i).unwrap();
    edit(&mut e);
    write_entry(&mut pd, i, &e).unwrap();
}

fn start(next: u32) -> Vec<AccountInfo<'static>> {
    let a = declaration::fixture();
    prep(&a, next);
    a
}

fn declare(d: &[AccountInfo], entry: u8) -> R<()> {
    declaration_engine::declare_siege_inner(
        &program(),
        d,
        &wix::DeclareSiege { site: 1, entry },
        &Auth::Wallet,
    )
}

/// The real ResolveWithConquest body on the fixture's same accounts.
fn resolve(a: &[AccountInfo<'static>], bell: u32) -> R<()> {
    let ra = declaration::resolve_fixture(a, bell);
    crate::proc::wide::resolve_inner(
        &program(),
        &ra,
        &wix::Resolve {
            bell,
            beneficiary: PAYER,
        },
        Some(&wix::ResolveWithConquest {
            bell,
            beneficiary: PAYER,
        }),
    )
}

/// FIXTURE (before any handler): a second Citizen (wallet WALLET2, given
/// faction) with its own Holding on site 2 of the target province (same
/// public constructors as the first Citizen's fixture), its host in roster
/// entry 1 on the Free City's tile, and a retained empty escrow exactly like
/// the first Citizen's (so no System CPI is needed). Returns its 12-role
/// DeclareSiege account list. Must run before the first declaration.
fn second(a: &[AccountInfo<'static>], faction: u8, troops: MilliTroops) -> Vec<AccountInfo<'static>> {
    let ctx = addr::ctx(&key(&a[2]), &PROGRAM);
    let world = world_of(&ctx).unwrap();
    let coord = WideCoord::checked(129, 0).unwrap();
    let k = ProvinceKey::new(world, coord);
    let ck2 = ctx.citizen_by_tag15(&frontier_abi::addr::citizen_tag15(&WALLET2));
    let mut cd = a[3].try_borrow_data().unwrap().to_vec();
    Rw(&mut cd).set_arr(C1::WALLET, &WALLET2).unwrap();
    Rw(&mut cd)
        .set_u64(C1::CITIZEN_TAG, frontier_abi::addr::citizen_tag(&ck2))
        .unwrap();
    Rw(&mut cd).set_u8(C1::FACTION, faction).unwrap();
    let mut hd = WideHolding::captured_free_city(
        wh::CapturedFreeCity {
            world,
            season_id: SID,
            coord,
            site: 2,
            gen: 1,
            slot: 2,
            owner_citizen: ck2,
            tile: 2,
            tier: 1,
            captured_bell: 1,
            current_bell: Some(10),
            now: NOW,
            rent_payer: PAYER,
        },
        &cd,
        &[0; 61],
        &[0; 61],
    )
    .unwrap()
    .to_vec();
    WideHolding::allocate_identity(&mut hd).unwrap();
    Rw(&mut hd).set_u32(H1::HOST_SEQ, 1).unwrap();
    for i in 0..permutation_rules::frontier::holding::RESOURCES {
        Rw(&mut hd)
            .set_i64(H1::store(i) + A::VALUE, 1_000_000 * MILLI)
            .unwrap();
        Rw(&mut hd)
            .set_i64(H1::store(i) + A::CAP, 2_000_000 * MILLI)
            .unwrap();
    }
    {
        let mut pd = a[5].try_borrow_mut_data().unwrap();
        pd[PV::SITE_COUNT] = 3;
        pd[PV::SITES + 2] = 2;
        pd[PV::site(2) + SM::STATE] = SM::STATE_HOLDING;
        pd[PV::site(2) + SM::GEN] = 1;
        pd[PV::site(2) + SM::ORDER] = 2;
        pd[PV::site(2) + SM::FACTION] = faction;
        let mut rd = a[6].try_borrow_mut_data().unwrap();
        let roster = WideRoster::read(&rd).unwrap();
        let host = WideHostRef::new(k, 2, 1, 0).unwrap();
        let alias = roster.claim(&mut rd, 1, &host).unwrap();
        write_entry(
            &mut pd,
            1,
            &Entry {
                id: alias,
                faction,
                unit: 0,
                tile: 1,
                state: E::STATE_ROSTER,
                troops,
                from_bell: 1,
                ..Entry::FREE
            },
        )
        .unwrap();
        roster
            .validate_paired(&rd, &wres::live_ids(&pd).unwrap())
            .unwrap();
    }
    let binding = CaptureBinding {
        key: k,
        site: 1,
        gen: 0,
        declaration_bell: 1,
    };
    let (e, _) = WideCaptureEscrow::new(SID, world, ck2, PAYER)
        .unwrap()
        .reserve(3, binding, wide_rent(), PAYER)
        .unwrap();
    let (e, _) = e.refund(3, binding, 0).unwrap();
    vec![
        declaration::ai(WALLET2, [0; 32], vec![], 0, true, false),
        a[1].clone(),
        a[2].clone(),
        declaration::ai(ck2, PROGRAM, cd, 1_000_000_000, false, true),
        declaration::ai(
            wh::holding_address(&ctx, coord, 2),
            PROGRAM,
            hd,
            1_000_000_000,
            false,
            true,
        ),
        a[5].clone(),
        a[6].clone(),
        a[7].clone(),
        a[8].clone(),
        a[9].clone(),
        declaration::ai(
            wc::capture_escrow_address(&ctx, &ck2),
            PROGRAM,
            e.to_bytes().to_vec(),
            init::rent(wc::CAPTURE_ESCROW_SIZE).unwrap() + wide_rent(),
            false,
            true,
        ),
        a[11].clone(),
    ]
}

/// SettleReservation roles from a 12-role declaration list: any signer,
/// season, target province, table, Citizen, escrow, escrow funder (the
/// fixture's PAYER), source Holding position.
fn sr(d: &[AccountInfo<'static>]) -> Vec<AccountInfo<'static>> {
    vec![
        declaration::ai(ANY, [0; 32], vec![], 0, true, false),
        d[2].clone(),
        d[5].clone(),
        d[9].clone(),
        d[3].clone(),
        d[10].clone(),
        d[1].clone(),
        d[4].clone(),
    ]
}

/// SettleReservation through the program's own dispatch (versioned kind 18);
/// the raw inner bytes stay closed on the same accounts.
fn settle(s: &[AccountInfo], seq: u32) -> R<()> {
    use frontier_abi::world_index::expedition_dispatch_ix as dx;
    let inner = wix::SettleReservation { seq }.to_bytes();
    let wire = dx::encode(dx::Kind::SettleReservation, &inner).unwrap();
    refused(s, || crate::dispatch(&program(), s, &inner));
    crate::dispatch(&program(), s, &wire)
}

fn close_escrow_accounts(a: &[AccountInfo<'static>]) -> Vec<AccountInfo<'static>> {
    vec![
        a[0].clone(),
        a[2].clone(),
        a[3].clone(),
        a[10].clone(),
        a[1].clone(),
        a[1].clone(),
    ]
}
fn close_table_accounts(a: &[AccountInfo<'static>]) -> Vec<AccountInfo<'static>> {
    vec![a[0].clone(), a[2].clone(), a[9].clone(), a[1].clone()]
}
const CLOSE_TABLE: wix::CloseConquest = wix::CloseConquest { p: 129, q: 0 };

/// Gold and arms of a Holding accrued to now (the handler credits on top of
/// exactly this accrual, as the existing capture test computes it).
fn accrued(d: &[u8]) -> (i64, i64) {
    let mut h = hold::read_holding(d).unwrap();
    hold::settle_tiered(&mut h, prologue::now().unwrap().ts, hold::terrain_ore(d).unwrap()).unwrap();
    (h.stores[GOLD].value, h.stores[ARMS].value)
}
fn stored(d: &[u8]) -> (i64, i64) {
    let h = hold::read_holding(d).unwrap();
    (h.stores[GOLD].value, h.stores[ARMS].value)
}
/// FIXTURE (between handlers): the source store's gold value, standing for
/// production/other credits filling it or spending emptying it.
fn set_gold(ai: &AccountInfo, value: i64) {
    Rw(&mut ai.try_borrow_mut_data().unwrap())
        .set_i64(H1::store(GOLD) + A::VALUE, value)
        .unwrap();
}
fn gold_cap(ai: &AccountInfo) -> i64 {
    Ro(&ai.try_borrow_data().unwrap())
        .i64(H1::store(GOLD) + A::CAP)
        .unwrap()
}
fn slot_marks(ai: &AccountInfo) -> u8 {
    wc::wide_reservations(Ro(&ai.try_borrow_data().unwrap()).u8(C::SLOTS).unwrap()).unwrap()
}
fn sieges_today(ai: &AccountInfo) -> u8 {
    Ro(&ai.try_borrow_data().unwrap())
        .u8(C::SIEGES_TODAY)
        .unwrap()
}
/// FIXTURE (between handlers): season status/time for terminal phases.
fn ended_after_grace(a: &[AccountInfo]) {
    a[2].try_borrow_mut_data().unwrap()[S::STATUS] = S::STATUS_ENDED;
    time(ENDED_GRACE_BELL);
}
fn aborted(a: &[AccountInfo]) {
    a[2].try_borrow_mut_data().unwrap()[S::STATUS] = S::STATUS_ABORTED;
}
/// FIXTURE: a canonically absent account at `k` (what the existing
/// season-end CloseProvince / CloseCitizen / Holding close leave behind).
fn absent(k: [u8; 32]) -> AccountInfo<'static> {
    declaration::ai(k, [0; 32], vec![], 0, false, true)
}
fn wide_records(logs: &[(Vec<u8>, Vec<u8>)]) -> Vec<(WideKind, Vec<u8>)> {
    logs.iter()
        .filter(|(p, _)| p == wev::WIDE_LOG_PREFIX)
        .map(|(_, b)| {
            let r = WideRecord::decode(b).unwrap();
            (r.kind, r.payload.to_vec())
        })
        .collect()
}

/// One NOT_APPLIED reservation (seq 0) produced by the real resolver: the
/// first Citizen reserves bell 10 while the cursor is 9; its host arrives
/// only at bell 11 (FIXTURE before any handler), so it is not eligible when
/// bell 10 is applied.
fn not_applied() -> Vec<AccountInfo<'static>> {
    let a = start(9);
    host_entry(&a, 0, |e| e.from_bell = 11);
    declare(&a, 0).unwrap();
    resolve(&a, 9).unwrap();
    resolve(&a, 10).unwrap();
    let t = tbl(&a);
    let (_, r) = t.reservation(0).unwrap();
    assert_eq!((r.status, r.done), (wc::RES_NOT_APPLIED, 0));
    assert!(t.entry(1).unwrap().is_none());
    assert_eq!((prefix(&a).kind, prefix(&a).flags), (CR::KIND_NONE, 0));
    a
}

// ------------------------------------------------------------ A. resolver

fn trace(a: &[AccountInfo<'static>], bells: core::ops::RangeInclusive<u32>) -> Vec<(Option<WideConquestEntry>, u8, u8, u32, u8)> {
    let mut v = Vec::new();
    for bell in bells {
        resolve(a, bell).unwrap();
        let p = prefix(a);
        v.push((tbl(a).entry(1).unwrap(), p.kind, p.flags, p.bell, p.progress));
    }
    v
}

#[test]
fn a1_reservation_applies_at_its_bell_exactly_as_an_immediate_declaration() {
    let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let _stub = install();
    // Immediate declaration at bell 10 (cursor 10), the existing lifecycle.
    let i = start(10);
    declare(&i, 0).unwrap();
    let immediate_entry = tbl(&i).entry(1).unwrap().unwrap();
    let required = prefix(&i).required as u32;
    let immediate = trace(&i, 10..=10 + required);
    // The same signature one bell behind: a reservation for bell 10.
    let a = start(9);
    declare(&a, 0).unwrap();
    let t = tbl(&a);
    assert!(t.entry(1).unwrap().is_none());
    assert_eq!(t.pending_at(1, 10).len(), 1);
    assert_eq!((prefix(&a).kind, prefix(&a).flags), (CR::KIND_NONE, CR::FLAG_PENDING));
    // Bell 9: nothing to apply, still pending, flag kept.
    resolve(&a, 9).unwrap();
    assert_eq!(cursor(&a), 10);
    assert_eq!(tbl(&a).pending_at(1, 10).len(), 1);
    assert_eq!((prefix(&a).kind, prefix(&a).flags), (CR::KIND_NONE, CR::FLAG_PENDING));
    // Bell 10 applies it; the record is freed.
    let reserved = trace(&a, 10..=10 + required);
    assert!(tbl(&a).reservations().iter().all(Option::is_none));
    // The applied site entry is the one the immediate declaration wrote
    // (identical before its first step: kind, required, target, bell...).
    let applied_first = reserved[0].0.unwrap();
    let mut applied_unstepped = applied_first;
    applied_unstepped.rules.progress = immediate_entry.rules.progress;
    assert_eq!(applied_unstepped, immediate_entry);
    // And every subsequent bell runs identically to the immediate siege.
    assert_eq!(reserved, immediate);
    let done = prefix(&a);
    assert_eq!(done.kind, CR::KIND_CAPTURE_DUE);
    assert_eq!(done.bell, 10 + required);
    // Escrow binding, slot mark and cap are what the declaration carried.
    assert_eq!(
        a[10].try_borrow_data().unwrap().as_ref(),
        i[10].try_borrow_data().unwrap().as_ref()
    );
    assert_eq!(a[10].lamports(), i[10].lamports());
    assert_eq!(slot_marks(&a[3]), slot_marks(&i[3]));
    assert_eq!(sieges_today(&a[3]), 1);
    assert_eq!(stored(&a[4].try_borrow_data().unwrap()), stored(&i[4].try_borrow_data().unwrap()));
}

#[test]
fn a2_cross_faction_reservations_same_bell_first_in_order_applies() {
    let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let _stub = install();
    for second_first in [false, true] {
        let a = start(9);
        // Faction 1 Citizen; each host leads its own faction on the tile.
        let b = second(&a, 1, 100_000);
        // FIXTURE (before any handler): both hosts arrive at bell 10, so the
        // two factions do not meet in bell 9's real clash before application.
        host_entry(&a, 0, |e| e.from_bell = 10);
        host_entry(&a, 1, |e| e.from_bell = 10);
        if second_first {
            declare(&b, 1).unwrap();
            declare(&a, 0).unwrap();
        } else {
            declare(&a, 0).unwrap();
            declare(&b, 1).unwrap();
        }
        let (first_c, second_c) = if second_first {
            (key(&b[3]), key(&a[3]))
        } else {
            (key(&a[3]), key(&b[3]))
        };
        let t = tbl(&a);
        assert_eq!(t.reservation(0).unwrap().1.citizen, first_c);
        assert_eq!(t.reservation(1).unwrap().1.citizen, second_c);
        resolve(&a, 9).unwrap();
        // Both qualify at bell 10 by the shared lead judgement (read only).
        {
            let pd = a[5].try_borrow_data().unwrap();
            let rd = a[6].try_borrow_data().unwrap();
            let roster = WideRoster::read(&rd).unwrap();
            for (i, f) in [(0usize, 0u8), (1, 1)] {
                let h = roster.ref_at(&rd, i).unwrap().unwrap();
                assert_eq!(wres::siege_lead(&pd, &roster, &rd, 1, f, 10).unwrap(), Some((i, h)));
            }
        }
        resolve(&a, 10).unwrap();
        let t = tbl(&a);
        let e = t.entry(1).unwrap().unwrap();
        assert_eq!(e.citizen, first_c, "order {second_first}");
        assert_eq!(e.declaration_bell, 10);
        assert!(t.reservation(0).is_none());
        let (_, loser) = t.reservation(1).unwrap();
        assert_eq!((loser.status, loser.citizen, loser.done), (wc::RES_NOT_APPLIED, second_c, 0));
        assert_eq!(prefix(&a).kind, CR::KIND_SIEGE);
    }
}

#[test]
fn a3_first_in_order_not_leading_second_leader_applies() {
    let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let _stub = install();
    let a = start(9);
    // Same faction, fewer troops: at bell 10 this host does not lead.
    let b = second(&a, 0, 50_000);
    declare(&b, 1).unwrap();
    declare(&a, 0).unwrap();
    resolve(&a, 9).unwrap();
    resolve(&a, 10).unwrap();
    let t = tbl(&a);
    assert_eq!(t.entry(1).unwrap().unwrap().citizen, key(&a[3]));
    let (_, first) = t.reservation(0).unwrap();
    assert_eq!((first.status, first.citizen), (wc::RES_NOT_APPLIED, key(&b[3])));
    assert!(t.reservation(1).is_none());
}

#[test]
fn a4_vanished_or_reused_roster_entry_never_applies_to_another_host() {
    let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let _stub = install();
    for reused in [false, true] {
        let a = start(9);
        declare(&a, 0).unwrap();
        let named = tbl(&a).reservation(0).unwrap().1.host;
        // FIXTURE (between handlers): the host named at signature leaves the
        // province before bell 10 (entry freed) or its roster entry is then
        // claimed by another host of the same Holding, which leads the tile.
        // Departures/admissions are outside this harness (closed lifecycle).
        {
            let mut pd = a[5].try_borrow_mut_data().unwrap();
            let mut rd = a[6].try_borrow_mut_data().unwrap();
            let roster = WideRoster::read(&rd).unwrap();
            assert_eq!(roster.release(&mut rd, 0).unwrap(), Some(named));
            if reused {
                let other = WideHostRef::new(named.key(), named.site(), named.gen(), 1).unwrap();
                let alias = roster.claim(&mut rd, 0, &other).unwrap();
                let mut e = read_entry(&pd, 0).unwrap();
                e.id = alias;
                write_entry(&mut pd, 0, &e).unwrap();
                Rw(&mut a[4].try_borrow_mut_data().unwrap())
                    .set_u32(H1::HOST_SEQ, 2)
                    .unwrap();
                assert_eq!(
                    wres::siege_lead(&pd, &roster, &rd, 1, 0, 10).unwrap(),
                    Some((0, other))
                );
            } else {
                write_entry(&mut pd, 0, &Entry::FREE).unwrap();
            }
            roster
                .validate_paired(&rd, &wres::live_ids(&pd).unwrap())
                .unwrap();
        }
        resolve(&a, 9).unwrap();
        resolve(&a, 10).unwrap();
        let t = tbl(&a);
        assert!(t.entry(1).unwrap().is_none(), "reused {reused}");
        assert_eq!(t.reservation(0).unwrap().1.status, wc::RES_NOT_APPLIED);
        assert_eq!((prefix(&a).kind, prefix(&a).flags), (CR::KIND_NONE, 0));
    }
}

#[test]
fn a5_too_late_at_application_does_not_apply() {
    let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let _stub = install();
    let a = start(9);
    // FIXTURE (before any handler): the Season ends at bell 47, so a siege
    // declared at bell 10 with no walls (36 bells) just fits.
    Rw(&mut a[2].try_borrow_mut_data().unwrap())
        .set_u32(S::END_BELL, 47)
        .unwrap();
    declare(&a, 0).unwrap();
    // FIXTURE (between handlers): the city's walls rise before bell 10. The
    // signature and the application judge walls at the SAME bell, so in this
    // harness TooLate at application needs a wall change in between.
    Rw(&mut a[5].try_borrow_mut_data().unwrap())
        .set_u32(PV::site(1) + SM::WALLS_COMMITTED, 50)
        .unwrap();
    resolve(&a, 9).unwrap();
    resolve(&a, 10).unwrap();
    let t = tbl(&a);
    assert!(t.entry(1).unwrap().is_none());
    assert_eq!(t.reservation(0).unwrap().1.status, wc::RES_NOT_APPLIED);
    assert_eq!((prefix(&a).kind, prefix(&a).flags), (CR::KIND_NONE, 0));
}

#[test]
fn a6_later_bell_reservation_stays_pending_then_is_judged_at_its_bell() {
    let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let _stub = install();
    let a = start(9);
    let b = second(&a, 1, 100_000);
    declare(&a, 0).unwrap(); // seq 0, bell 10
    resolve(&a, 9).unwrap();
    // FIXTURE (clock only): bell 11, before bell 10's resolve; cursor is 10.
    prologue::set_test_clock(GENESIS + 11 * 600 + 60, 1_500);
    declare(&b, 1).unwrap(); // seq 1, bell 11
    assert_eq!(tbl(&a).reservation(1).unwrap().1.bell, 11);
    resolve(&a, 10).unwrap();
    let t = tbl(&a);
    assert_eq!(t.entry(1).unwrap().unwrap().citizen, key(&a[3]));
    assert!(t.reservation(0).is_none());
    let (_, later) = t.reservation(1).unwrap();
    assert_eq!((later.status, later.bell), (wc::RES_PENDING, 11));
    assert!(t.has_pending(1));
    assert_eq!(prefix(&a).kind, CR::KIND_SIEGE);
    resolve(&a, 11).unwrap();
    let t = tbl(&a);
    assert_eq!(t.reservation(1).unwrap().1.status, wc::RES_NOT_APPLIED);
    assert_eq!(t.entry(1).unwrap().unwrap().citizen, key(&a[3]));
    assert!(!t.has_pending(1));
}

#[test]
fn a7_plain_resolve_refuses_a_flagged_province_without_effects() {
    let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let _stub = install();
    let old = wix::Resolve {
        bell: 9,
        beneficiary: PAYER,
    };
    // Control: the same province with no reservation resolves plainly.
    let c = start(9);
    let rc = declaration::resolve_fixture(&c, 9);
    crate::proc::wide::resolve_inner(&program(), &rc[..9], &old, None).unwrap();
    let a = start(9);
    declare(&a, 0).unwrap();
    let ra = declaration::resolve_fixture(&a, 9);
    refused(&ra, || {
        crate::proc::wide::resolve_inner(&program(), &ra[..9], &old, None)
    });
    assert_eq!(cursor(&a), 9);
    assert_eq!(prefix(&a).flags, CR::FLAG_PENDING);
}

#[test]
fn a8_stale_pending_reservation_refuses_resolve_with_conquest() {
    let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let _stub = install();
    let a = start(9);
    declare(&a, 0).unwrap();
    let (i, r) = tbl(&a).reservation(0).unwrap();
    let off = wc::CONQUEST_SIZE - (wc::RESERVATIONS_N - i) * wc::RESERVATION_LEN + 8;
    assert_eq!(
        u32::from_le_bytes(a[9].try_borrow_data().unwrap()[off..off + 4].try_into().unwrap()),
        r.bell
    );
    // FIXTURE (between handlers): a PENDING record older than the cursor
    // bell. No handler sequence can produce it (bell b converts all of b's
    // reservations), so this is the defensive invariant only.
    a[9].try_borrow_mut_data().unwrap()[off..off + 4].copy_from_slice(&8u32.to_le_bytes());
    assert!(tbl(&a).stale_pending(9));
    let ra = declaration::resolve_fixture(&a, 9);
    let command = wix::ResolveWithConquest {
        bell: 9,
        beneficiary: PAYER,
    };
    let old = wix::Resolve {
        bell: 9,
        beneficiary: PAYER,
    };
    refused(&ra, || {
        crate::proc::wide::resolve_inner(&program(), &ra, &old, Some(&command))
    });
    // Restoring the record's own bell makes the identical resolve succeed.
    a[9].try_borrow_mut_data().unwrap()[off..off + 4].copy_from_slice(&10u32.to_le_bytes());
    crate::proc::wide::resolve_inner(&program(), &ra, &old, Some(&command)).unwrap();
    assert_eq!(cursor(&a), 10);
}

// ------------------------------------------------------- B. settlement

#[test]
fn b1_full_return_is_exact_and_cap_stays_consumed() {
    let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let _stub = install();
    let a = not_applied();
    let (_, r) = tbl(&a).reservation(0).unwrap();
    assert_eq!(r.gold_milli, FRONTIER_7.siege_stake_gold as u64 * MILLI as u64);
    assert_eq!(
        r.arms_milli as i64,
        permutation_rules::frontier::arms::siege_cost()[ARMS]
    );
    let s = sr(&a);
    let (gold, arms) = accrued(&a[4].try_borrow_data().unwrap());
    let payer = a[1].lamports();
    let escrow_l = a[10].lamports();
    assert_eq!(slot_marks(&a[3]), C::reserved_bit(3));
    LOGS.lock().unwrap().clear();
    settle(&s, 0).unwrap();
    assert_eq!(
        stored(&a[4].try_borrow_data().unwrap()),
        (gold + r.gold_milli as i64, arms + r.arms_milli as i64)
    );
    assert_eq!(a[1].lamports(), payer + wide_rent());
    assert_eq!(a[10].lamports(), escrow_l - wide_rent());
    let ctx = addr::ctx(&key(&a[2]), &PROGRAM);
    let e = escrow(&program(), &ctx, SID, pk(&a).world(), &a[3], &a[10]).unwrap();
    assert_eq!((e.escrow(), e.active_mask()), (0, 0));
    assert_eq!(slot_marks(&a[3]), 0);
    assert_eq!(sieges_today(&a[3]), 1, "the day's cap is not restored");
    assert!(tbl(&a).reservation(0).is_none());
    let logs = LOGS.lock().unwrap().clone();
    let recs = wide_records(&logs);
    let payload = |k| recs.iter().find(|(kind, _)| *kind == k).unwrap().1.clone();
    let settled = payload(WideKind::ConquestSettled);
    assert_eq!(settled, payload(WideKind::ConquestCredited));
    assert_eq!(
        receipt::Receipt::decode(&settled).unwrap().action,
        receipt::RESERVATION_REFUND
    );
    assert_eq!(settle(&s, 0), Err(FrontierError::AlreadyDone.into()));
}

#[test]
fn b2_b4_no_room_refuses_unchanged_then_returns_once_never_twice() {
    let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let _stub = install();
    let a = not_applied();
    let s = sr(&a);
    let (_, r) = tbl(&a).reservation(0).unwrap();
    set_gold(&a[4], gold_cap(&a[4]));
    let source_before = a[4].try_borrow_data().unwrap().to_vec();
    let payer = a[1].lamports();
    // First call: only the rent/slot part can complete.
    settle(&s, 0).unwrap();
    assert_eq!(a[4].try_borrow_data().unwrap().as_ref(), &source_before[..]);
    assert_eq!(a[1].lamports(), payer + wide_rent());
    assert_eq!(slot_marks(&a[3]), 0);
    let (_, kept) = tbl(&a).reservation(0).unwrap();
    assert_eq!((kept.status, kept.done), (wc::RES_NOT_APPLIED, wc::RES_SLOT_RENT_RELEASED));
    assert_eq!((kept.gold_milli, kept.arms_milli), (r.gold_milli, r.arms_milli));
    // Retry with no room: refused, nothing at all changes, debt kept.
    let before = snapshot(&s);
    let logs = LOGS.lock().unwrap().clone();
    assert_eq!(settle(&s, 0), Err(FrontierError::Capacity.into()));
    assert_eq!(snapshot(&s), before);
    assert_eq!(*LOGS.lock().unwrap(), logs);
    assert_eq!(tbl(&a).reservation(0).unwrap().1, kept);
    // Room made: the resources return once, the rent is not paid again.
    set_gold(&a[4], 1_000_000 * MILLI);
    let (gold, arms) = accrued(&a[4].try_borrow_data().unwrap());
    let payer = a[1].lamports();
    settle(&s, 0).unwrap();
    assert_eq!(
        stored(&a[4].try_borrow_data().unwrap()),
        (gold + r.gold_milli as i64, arms + r.arms_milli as i64)
    );
    assert_eq!(a[1].lamports(), payer);
    assert!(tbl(&a).reservation(0).is_none());
    let done = snapshot(&s);
    assert_eq!(settle(&s, 0), Err(FrontierError::AlreadyDone.into()));
    assert_eq!(snapshot(&s), done);
    assert_eq!(sieges_today(&a[3]), 1);
}

#[test]
fn b3_absent_or_new_generation_source_keeps_the_debt() {
    let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let _stub = install();
    for case in 0..3 {
        let a = not_applied();
        let mut s = sr(&a);
        let live = a[4].try_borrow_data().unwrap().to_vec();
        // FIXTURE (between handlers): the source Holding at its canonical
        // address closed (0), re-founded with a new generation (1), or released (2).
        s[7] = match case {
            0 => absent(key(&a[4])),
            1 => {
                let mut d = live.clone();
                d[H1::GEN] = 2;
                declaration::ai(key(&a[4]), PROGRAM, d, a[4].lamports(), false, true)
            }
            _ => {
                let mut d = live.clone();
                d[H1::STATE] = H1::STATE_RELEASED;
                declaration::ai(key(&a[4]), PROGRAM, d, a[4].lamports(), false, true)
            }
        };
        let replaced = snapshot(&s[7..8]);
        let payer = a[1].lamports();
        settle(&s, 0).unwrap();
        assert_eq!(snapshot(&s[7..8]), replaced, "case {case}: nothing credited or burnt");
        assert_eq!(a[1].lamports(), payer + wide_rent(), "case {case}");
        assert_eq!(slot_marks(&a[3]), 0);
        let (_, kept) = tbl(&a).reservation(0).unwrap();
        assert_eq!((kept.status, kept.done), (wc::RES_NOT_APPLIED, wc::RES_SLOT_RENT_RELEASED));
        assert_eq!(settle(&s, 0), Err(FrontierError::Capacity.into()));
        // The original live Holding still receives the full return later.
        s[7] = a[4].clone();
        let (gold, arms) = accrued(&live);
        settle(&s, 0).unwrap();
        assert_eq!(
            stored(&a[4].try_borrow_data().unwrap()),
            (gold + kept.gold_milli as i64, arms + kept.arms_milli as i64)
        );
        assert!(tbl(&a).reservation(0).is_none());
        assert_eq!(a[1].lamports(), payer + wide_rent());
    }
}

#[test]
fn b5_pending_while_live_is_too_early() {
    let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let _stub = install();
    let a = start(9);
    declare(&a, 0).unwrap();
    let s = sr(&a);
    for resolved_nine in [false, true] {
        if resolved_nine {
            resolve(&a, 9).unwrap();
        }
        let before = snapshot(&s);
        assert_eq!(settle(&s, 0), Err(FrontierError::TooEarly.into()));
        assert_eq!(snapshot(&s), before);
        assert_eq!(tbl(&a).reservation(0).unwrap().1.status, wc::RES_PENDING);
    }
}

#[test]
fn b6_fake_or_non_canonical_accounts_are_refused() {
    let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let _stub = install();
    let a = not_applied();
    let copy = |i: usize, k: [u8; 32]| {
        let d = a[i].try_borrow_data().unwrap().to_vec();
        declaration::ai(k, a[i].owner.to_bytes(), d, a[i].lamports(), false, true)
    };
    let ctx = addr::ctx(&key(&a[2]), &PROGRAM);
    let other_citizen = ctx.citizen_by_tag15(&frontier_abi::addr::citizen_tag15(&WALLET2));
    for case in 0..6 {
        let mut s = sr(&a);
        match case {
            // escrow of another Citizen's address, same bytes
            0 => s[5] = copy(10, wc::capture_escrow_address(&ctx, &other_citizen)),
            // a Citizen that is not the record's
            1 => s[4] = copy(3, other_citizen),
            // a province at a non-canonical address
            2 => s[2] = copy(5, [0x33; 32]),
            // the source at a non-canonical address
            3 => s[7] = copy(4, wh::holding_address(&ctx, WideCoord::checked(129, 0).unwrap(), 2)),
            // the canonical escrow absent while the Season is live
            4 => s[5] = absent(key(&a[10])),
            // a funder that is not the escrow's
            _ => s[6] = declaration::ai([0x44; 32], [0; 32], vec![], 0, false, true),
        }
        refused(&s, || settle(&s, 0));
        assert_eq!(tbl(&a).reservation(0).unwrap().1.done, 0, "case {case}");
    }
    // Never treated as released: the real accounts still return everything.
    let payer = a[1].lamports();
    settle(&sr(&a), 0).unwrap();
    assert_eq!(a[1].lamports(), payer + wide_rent());
    assert!(tbl(&a).reservation(0).is_none());
}

// ------------------------------------------------ C. terminal / close

#[test]
fn c1_close_conquest_refused_while_any_reservation_record_exists() {
    let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let _stub = install();
    // PENDING.
    let a = start(9);
    declare(&a, 0).unwrap();
    ended_after_grace(&a);
    let ct = close_table_accounts(&a);
    refused(&ct, || via(&ct, &CLOSE_TABLE.to_bytes()));
    // Ended (not aborted) with the province still present: no lapse.
    assert_eq!(settle(&sr(&a), 0), Err(FrontierError::TooEarly.into()));
    // NOT_APPLIED with the resources still owed.
    let b = not_applied();
    set_gold(&b[4], gold_cap(&b[4]));
    settle(&sr(&b), 0).unwrap();
    assert_eq!(tbl(&b).reservation(0).unwrap().1.done, wc::RES_SLOT_RENT_RELEASED);
    ended_after_grace(&b);
    let ct = close_table_accounts(&b);
    refused(&ct, || via(&ct, &CLOSE_TABLE.to_bytes()));
    set_gold(&b[4], 1_000_000 * MILLI);
    settle(&sr(&b), 0).unwrap();
    assert!(tbl(&b).is_empty());
    let rent_t = b[9].lamports();
    let payer = b[1].lamports();
    via(&ct, &CLOSE_TABLE.to_bytes()).unwrap();
    assert!(init::is_absent(&b[9]));
    assert_eq!(b[1].lamports(), payer + rent_t);
}

#[test]
fn c2_terminal_escrow_close_then_settle_counts_slot_rent_released_once() {
    let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let _stub = install();
    let a = not_applied();
    ended_after_grace(&a);
    let ce = close_escrow_accounts(&a);
    let payer = a[1].lamports();
    let escrow_l = a[10].lamports();
    via(&ce, &wix::CloseCaptureEscrow.to_bytes()).unwrap();
    assert!(init::is_absent(&a[10]));
    // The binding's rent (and the escrow's own rent) went back at close.
    assert_eq!(a[1].lamports(), payer + escrow_l);
    assert_eq!(slot_marks(&a[3]), 0);
    let s = sr(&a);
    let (gold, arms) = accrued(&a[4].try_borrow_data().unwrap());
    let (_, r) = tbl(&a).reservation(0).unwrap();
    let payer = a[1].lamports();
    settle(&s, 0).unwrap();
    assert_eq!(a[1].lamports(), payer, "no second rent refund");
    assert_eq!(
        stored(&a[4].try_borrow_data().unwrap()),
        (gold + r.gold_milli as i64, arms + r.arms_milli as i64)
    );
    assert!(tbl(&a).reservation(0).is_none());
    assert_eq!(settle(&s, 0), Err(FrontierError::AlreadyDone.into()));
}

#[test]
fn c3_after_escrow_and_citizen_close_resources_still_return() {
    let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let _stub = install();
    let a = not_applied();
    ended_after_grace(&a);
    via(&close_escrow_accounts(&a), &wix::CloseCaptureEscrow.to_bytes()).unwrap();
    let mut s = sr(&a);
    // FIXTURE (between handlers): the Citizen canonically absent, standing
    // for the existing season-end CloseCitizen (not run in this harness).
    let ctx = addr::ctx(&key(&a[2]), &PROGRAM);
    s[4] = absent(ctx.citizen_by_tag15(&frontier_abi::addr::citizen_tag15(&WALLET2)));
    refused(&s, || settle(&s, 0));
    s[4] = absent(key(&a[3]));
    let (gold, arms) = accrued(&a[4].try_borrow_data().unwrap());
    let (_, r) = tbl(&a).reservation(0).unwrap();
    let payer = a[1].lamports();
    settle(&s, 0).unwrap();
    assert_eq!(a[1].lamports(), payer);
    assert_eq!(
        stored(&a[4].try_borrow_data().unwrap()),
        (gold + r.gold_milli as i64, arms + r.arms_milli as i64)
    );
    assert!(tbl(&a).reservation(0).is_none());
}

#[test]
fn c4_aborted_lapse_and_closed_province() {
    let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let _stub = install();
    // Aborted: the PENDING reservation lapses and everything returns at once.
    let a = start(9);
    declare(&a, 0).unwrap();
    aborted(&a);
    let s = sr(&a);
    let (gold, arms) = accrued(&a[4].try_borrow_data().unwrap());
    let (_, r) = tbl(&a).reservation(0).unwrap();
    let payer = a[1].lamports();
    settle(&s, 0).unwrap();
    assert_eq!(a[1].lamports(), payer + wide_rent());
    assert_eq!(
        stored(&a[4].try_borrow_data().unwrap()),
        (gold + r.gold_milli as i64, arms + r.arms_milli as i64)
    );
    assert!(tbl(&a).reservation(0).is_none());
    assert_eq!((prefix(&a).kind, prefix(&a).flags), (CR::KIND_NONE, 0));
    assert_eq!(slot_marks(&a[3]), 0);
    // Province canonically absent (FIXTURE: the existing season-end
    // CloseProvince, not run here). While live: refused.
    let b = start(9);
    declare(&b, 0).unwrap();
    let mut s = sr(&b);
    s[2] = absent(key(&b[5]));
    refused(&s, || settle(&s, 0));
    // Ended past grace: the PENDING reservation lapses; unchained PSWR record.
    ended_after_grace(&b);
    let (gold, arms) = accrued(&b[4].try_borrow_data().unwrap());
    let (_, r) = tbl(&b).reservation(0).unwrap();
    LOGS.lock().unwrap().clear();
    settle(&s, 0).unwrap();
    assert_eq!(
        stored(&b[4].try_borrow_data().unwrap()),
        (gold + r.gold_milli as i64, arms + r.arms_milli as i64)
    );
    assert!(tbl(&b).reservation(0).is_none());
    let logs = LOGS.lock().unwrap().clone();
    let pswr: Vec<_> = logs.iter().filter(|(p, _)| p == b"PSWR").collect();
    assert_eq!(pswr.len(), 1);
    let body = &pswr[0].1;
    assert_eq!(body[0], 1);
    assert_eq!(&body[1..33], &key(&b[2]));
    assert_eq!(&body[33..65], &key(&b[9]));
    assert_eq!(&body[65..69], &0u32.to_le_bytes());
    let rc = receipt::Receipt::decode(&body[73..]).unwrap();
    assert_eq!(rc.action, receipt::RESERVATION_REFUND);
    let recs = wide_records(&logs);
    assert!(recs.iter().all(|(k, _)| *k != WideKind::ConquestSettled));
    assert_eq!(
        recs.iter()
            .find(|(k, _)| *k == WideKind::ConquestCredited)
            .unwrap()
            .1,
        body[73..].to_vec()
    );
}

#[test]
fn c5_live_escrow_with_absent_citizen_keeps_slot_rent_owed() {
    let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let _stub = install();
    let a = not_applied();
    ended_after_grace(&a);
    let mut s = sr(&a);
    // FIXTURE (between handlers): Citizen canonically absent, escrow kept.
    s[4] = absent(key(&a[3]));
    let (gold, arms) = accrued(&a[4].try_borrow_data().unwrap());
    let (_, r) = tbl(&a).reservation(0).unwrap();
    let payer = a[1].lamports();
    let escrow_before = snapshot(&a[10..11]);
    settle(&s, 0).unwrap();
    assert_eq!(a[1].lamports(), payer);
    assert_eq!(snapshot(&a[10..11]), escrow_before);
    assert_eq!(
        stored(&a[4].try_borrow_data().unwrap()),
        (gold + r.gold_milli as i64, arms + r.arms_milli as i64)
    );
    let (_, kept) = tbl(&a).reservation(0).unwrap();
    assert_eq!((kept.status, kept.done), (wc::RES_NOT_APPLIED, wc::RES_RESOURCES_RETURNED));
    let source = a[4].try_borrow_data().unwrap().to_vec();
    assert_eq!(settle(&s, 0), Err(FrontierError::Capacity.into()));
    assert_eq!(a[4].try_borrow_data().unwrap().as_ref(), &source[..]);
}

// ------------------------------------------------ B7. slot reuse

/// The settle stubs plus exactly one more CPI: a signed System transfer from
/// PAYER to the first Citizen's canonical escrow (a reservation's escrow
/// top-up). Anything else is delegated to the existing stubs (which refuse it).
struct TopupStubs {
    escrow: [u8; 32],
}
static TOPUPS: Mutex<Vec<u64>> = Mutex::new(Vec::new());
impl solana_program::program_stubs::SyscallStubs for TopupStubs {
    fn sol_log(&self, _: &str) {}
    fn sol_log_data(&self, fields: &[&[u8]]) {
        <Stubs as solana_program::program_stubs::SyscallStubs>::sol_log_data(&Stubs, fields);
    }
    fn sol_invoke_signed(
        &self,
        ix: &Instruction,
        infos: &[AccountInfo],
        seeds: &[&[&[u8]]],
    ) -> Result<(), ProgramError> {
        let d = &ix.data;
        if ix.program_id.to_bytes() != prologue::ids::SYSTEM_PROGRAM
            || d.len() != 12
            || u32::from_le_bytes(d[..4].try_into().unwrap()) != 2
        {
            return <Stubs as solana_program::program_stubs::SyscallStubs>::sol_invoke_signed(
                &Stubs, ix, infos, seeds,
            );
        }
        if infos.len() != 2
            || !seeds.is_empty()
            || !infos[0].is_signer
            || !infos[0].is_writable
            || !infos[1].is_writable
            || key(&infos[0]) != PAYER
            || key(&infos[1]) != self.escrow
        {
            return Err(ProgramError::InvalidArgument);
        }
        let n = u64::from_le_bytes(d[4..].try_into().unwrap());
        let from = infos[0]
            .lamports()
            .checked_sub(n)
            .ok_or(ProgramError::InsufficientFunds)?;
        let to = infos[1]
            .lamports()
            .checked_add(n)
            .ok_or(ProgramError::ArithmeticOverflow)?;
        **infos[0].try_borrow_mut_lamports()? = from;
        **infos[1].try_borrow_mut_lamports()? = to;
        TOPUPS.lock().unwrap().push(n);
        Ok(())
    }
}

fn reservation_bytes(a: &[AccountInfo], i: usize) -> Vec<u8> {
    let off = wc::CONQUEST_SIZE - (wc::RESERVATIONS_N - i) * wc::RESERVATION_LEN;
    a[9].try_borrow_data().unwrap()[off..off + wc::RESERVATION_LEN].to_vec()
}

#[test]
fn b7_slot_released_by_r1_reused_by_r2_then_r1_resources_return_without_touching_r2() {
    let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let _stub = install();
    // R1: seq 0, site 1, bell 10, slot 3 -> NOT_APPLIED (host arrives at 11).
    let a = not_applied();
    let _topup = Installed(Some(solana_program::program_stubs::set_syscall_stubs(
        Box::new(TopupStubs { escrow: key(&a[10]) }),
    )));
    TOPUPS.lock().unwrap().clear();
    let (_, r1) = tbl(&a).reservation(0).unwrap();
    assert_eq!(r1.reserved_slot, 3);
    let s = sr(&a);
    // Store full: the first settle releases only R1's rent and slot.
    set_gold(&a[4], gold_cap(&a[4]));
    let payer = a[1].lamports();
    settle(&s, 0).unwrap();
    assert_eq!(a[1].lamports(), payer + wide_rent());
    assert_eq!(slot_marks(&a[3]), 0);
    assert_eq!(tbl(&a).reservation(0).unwrap().1.done, wc::RES_SLOT_RENT_RELEASED);
    // Room is made before R2 so R2's own debit can be paid.
    set_gold(&a[4], 1_000_000 * MILLI);
    // R2: the same Citizen, same site, later bell 12 (cursor 11 behind),
    // FIXTURE (clock only). The released slot 3 is the lowest free slot again;
    // R1's binding was removed by its refund, so one-per-site allows R2.
    assert_eq!(cursor(&a), 11);
    prologue::set_test_clock(GENESIS + 12 * 600 + 60, 2_500);
    let payer_r2 = a[1].lamports();
    declare(&a, 0).unwrap();
    let (_, r2) = tbl(&a).reservation(1).unwrap();
    assert_eq!(
        (r2.status, r2.site, r2.bell, r2.reserved_slot, r2.citizen),
        (wc::RES_PENDING, 1, 12, 3, key(&a[3]))
    );
    assert_eq!(*TOPUPS.lock().unwrap(), vec![wide_rent()]);
    assert_eq!(a[1].lamports(), payer_r2 - wide_rent());
    assert_eq!(sieges_today(&a[3]), 2, "cap consumed twice, never restored");
    assert_eq!(slot_marks(&a[3]), C::reserved_bit(3));
    assert_eq!((prefix(&a).kind, prefix(&a).flags), (CR::KIND_NONE, CR::FLAG_PENDING));
    let ctx = addr::ctx(&key(&a[2]), &PROGRAM);
    let e2 = escrow(&program(), &ctx, SID, pk(&a).world(), &a[3], &a[10]).unwrap();
    assert_eq!(e2.binding(3).unwrap(), Some(r2.binding(pk(&a))));
    assert_eq!((e2.escrow(), e2.active_mask()), (wide_rent(), C::reserved_bit(3)));
    // R2 state, before R1's second settlement.
    let r2_record = reservation_bytes(&a, tbl(&a).reservation(1).unwrap().0);
    let escrow_state = snapshot(&a[10..11]);
    let citizen_state = snapshot(&a[3..4]);
    let prefix_before = prefix(&a);
    // R1 again: only its resources, exactly its own amounts, once.
    let (gold, arms) = accrued(&a[4].try_borrow_data().unwrap());
    let payer = a[1].lamports();
    settle(&s, 0).unwrap();
    assert_eq!(
        stored(&a[4].try_borrow_data().unwrap()),
        (gold + r1.gold_milli as i64, arms + r1.arms_milli as i64)
    );
    assert_eq!(a[1].lamports(), payer, "no second rent refund for R1");
    assert!(tbl(&a).reservation(0).is_none(), "R1 freed");
    let (i2, kept) = tbl(&a).reservation(1).unwrap();
    assert_eq!(kept, r2, "R2 kept");
    assert_eq!(reservation_bytes(&a, i2), r2_record);
    assert_eq!(snapshot(&a[10..11]), escrow_state);
    assert_eq!(snapshot(&a[3..4]), citizen_state);
    let p = prefix(&a);
    assert_eq!(
        (p.kind, p.flags, p.bell, p.progress, p.required),
        (prefix_before.kind, prefix_before.flags, prefix_before.bell, prefix_before.progress, prefix_before.required)
    );
    assert_eq!(settle(&s, 0), Err(FrontierError::AlreadyDone.into()));
    // R2 to its own outcome: judged at bell 12, where its host (arrived at
    // 11) is eligible and leads; it applies with R1's former slot.
    resolve(&a, 11).unwrap();
    assert_eq!(tbl(&a).reservation(1).unwrap().1.status, wc::RES_PENDING);
    resolve(&a, 12).unwrap();
    let t = tbl(&a);
    assert!(t.reservations().iter().all(Option::is_none));
    let e = t.entry(1).unwrap().unwrap();
    assert_eq!(
        (e.citizen, e.declaration_bell, e.reserved_slot),
        (key(&a[3]), 12, 3)
    );
    assert_eq!(prefix(&a).kind, CR::KIND_SIEGE);
    assert_eq!(*TOPUPS.lock().unwrap(), vec![wide_rent()]);
}

// ------------------------------------- A9. fresh sidecars (real SBF finding)

/// Fresh-sidecar CPIs as `continuous(fresh_sidecars=true)` accepts them: the
/// public-address-checked AllocateWithSeed of the conquest table or the
/// Citizen's capture escrow, and signed PAYER transfers to those two.
struct FreshStubs {
    season: [u8; 32],
    citizen: [u8; 32],
}
impl solana_program::program_stubs::SyscallStubs for FreshStubs {
    fn sol_log(&self, _: &str) {}
    fn sol_log_data(&self, fields: &[&[u8]]) {
        <Stubs as solana_program::program_stubs::SyscallStubs>::sol_log_data(&Stubs, fields);
    }
    fn sol_invoke_signed(
        &self,
        ix: &Instruction,
        infos: &[AccountInfo],
        seeds: &[&[&[u8]]],
    ) -> Result<(), ProgramError> {
        let d = &ix.data;
        let ctx = addr::ctx(&self.season, &PROGRAM);
        let k = ProvinceKey::new(world_of(&ctx).unwrap(), WideCoord::checked(129, 0).unwrap());
        let targets = [
            wc::conquest_address(&ctx, k),
            wc::capture_escrow_address(&ctx, &self.citizen),
        ];
        if ix.program_id.to_bytes() != prologue::ids::SYSTEM_PROGRAM || d.len() < 4 || infos.len() != 2 {
            return Err(ProgramError::InvalidInstructionData);
        }
        match u32::from_le_bytes(d[..4].try_into().unwrap()) {
            2 => {
                if d.len() != 12
                    || !seeds.is_empty()
                    || !infos[0].is_signer
                    || key(&infos[0]) != PAYER
                    || !targets.contains(&key(&infos[1]))
                {
                    return Err(ProgramError::InvalidArgument);
                }
                let n = u64::from_le_bytes(d[4..].try_into().unwrap());
                let from = infos[0].lamports().checked_sub(n).ok_or(ProgramError::InsufficientFunds)?;
                let to = infos[1].lamports().checked_add(n).ok_or(ProgramError::ArithmeticOverflow)?;
                **infos[0].try_borrow_mut_lamports()? = from;
                **infos[1].try_borrow_mut_lamports()? = to;
                Ok(())
            }
            9 => {
                let n = u64::from_le_bytes(d[36..44].try_into().unwrap()) as usize;
                if n > 32 || d.len() != 84 + n {
                    return Err(ProgramError::InvalidInstructionData);
                }
                let base: [u8; 32] = d[4..36].try_into().unwrap();
                let owner: [u8; 32] = d[52 + n..84 + n].try_into().unwrap();
                let space = u64::from_le_bytes(d[44 + n..52 + n].try_into().unwrap()) as usize;
                let expected = match space {
                    wc::CONQUEST_SIZE => wc::conquest_seed(k),
                    wc::CAPTURE_ESCROW_SIZE => wc::capture_escrow_seed(&self.citizen),
                    _ => return Err(ProgramError::InvalidInstructionData),
                };
                if owner != PROGRAM
                    || base != self.season
                    || base != key(&infos[1])
                    || expected.as_bytes() != &d[44..44 + n]
                    || key(&infos[0]) != permutation_rules::hash::sha256(&[&base, &d[44..44 + n], &owner])
                    || !targets.contains(&key(&infos[0]))
                    || !seeds.iter().any(|s| {
                        Pubkey::create_program_address(s, &program()).is_ok_and(|k| k.to_bytes() == base)
                    })
                {
                    return Err(ProgramError::InvalidSeeds);
                }
                if !init::is_absent(&infos[0]) {
                    return Err(ProgramError::AccountAlreadyInitialized);
                }
                infos[0].resize(space)?;
                infos[0].assign(&program());
                Ok(())
            }
            _ => Err(ProgramError::InvalidInstructionData),
        }
    }
}

/// `legacy_fixture` (verbatim construction) with its legacy home province at
/// (p, q), e.g. ring 128 like the real chain's home host.
fn legacy_at(p: i16, q: i16) -> Vec<AccountInfo<'static>> {
    use frontier_abi::world_index::expedition::AccountResolver;
    let mut a = declaration::fixture();
    let ctx = addr::ctx(&key(&a[2]), &PROGRAM);
    let world = world_of(&ctx).unwrap();
    let coord = WideCoord::checked(p as i64, q as i64).unwrap();
    let host = WideHostRef::new(ProvinceKey::new(world, coord), 0, 1, 0).unwrap();
    let resolver = AccountResolver::for_season(&ctx).unwrap();
    let mut empty_province = vec![0; K2::Province.size()];
    empty_province[PV::SITE_COUNT] = 1;
    let (_, generation) = cz::home_site(&empty_province, 0, 10).unwrap();
    let mut hd = vec![0; K2::Holding.size()];
    assert!(write_header(&mut hd, K2::Holding, SID));
    let mut economy = cz::founded_holding(NOW, addr::day_of(10), 0).unwrap();
    for s in &mut economy.stores {
        s.value = 1_000_000 * MILLI;
        s.cap = 2_000_000 * MILLI;
    }
    write_founding(
        &mut hd,
        &Founding {
            p,
            q,
            site: 0,
            gen: generation,
            tile: 0,
            owner: key(&a[3]),
            score: 0,
            faction: 0,
            ticket_bell: C1::NO_TICKET,
            rent_payer: PAYER,
            final_ts: NOW,
            pool_owed: 0,
            shield_until: NOW,
            terrain_ore: 0,
        },
        &economy,
    )
    .unwrap();
    Rw(&mut hd).set_u8(H1::STATE, H1::STATE_FINAL).unwrap();
    Rw(&mut hd).set_u32(H1::HOST_SEQ, 1).unwrap();
    crate::layout::set_chain(&mut hd, 7, &[0x6a; 32]).unwrap();
    a[4] = declaration::ai(resolver.holding_address(&host).unwrap(), PROGRAM, hd, a[4].lamports(), false, true);
    let mut sp = vec![0; K2::Province.size()];
    assert!(write_header(&mut sp, K2::Province, SID));
    Rw(&mut sp).set_i16(PV::P, p).unwrap();
    Rw(&mut sp).set_i16(PV::Q, q).unwrap();
    sp[PV::SITE_COUNT] = 1;
    sp[PV::site(0) + SM::STATE] = SM::STATE_HOLDING;
    sp[PV::site(0) + SM::GEN] = 1;
    sp[PV::site(0) + SM::ORDER] = 1;
    a[7] = declaration::ai(resolver.province_address(host.key()).unwrap(), PROGRAM, sp, 1_000_000_000, false, false);
    {
        let mut cd = a[3].try_borrow_mut_data().unwrap();
        wh::unbind(&mut cd, 2).unwrap();
        let o = C::holding_of_slot(1);
        // Home binding {p, q, site 0, gen}: i16 LE p, i16 LE q, site, gen.
        cd[o..o + 2].copy_from_slice(&p.to_le_bytes());
        cd[o + 2..o + 4].copy_from_slice(&q.to_le_bytes());
        cd[o + 4] = 0;
        cd[o + 5] = generation;
        cd[C::HOLDINGS_N] = 1;
        cd[C1::FLAGS] |= C1::FLAG_HOME_GRANTED | C1::FLAG_FIRST_HOLDING_FINAL;
    }
    {
        let mut rd = a[6].try_borrow_mut_data().unwrap();
        let roster = WideRoster::read(&rd).unwrap();
        roster.release(&mut rd, 0).unwrap();
        let alias = roster.claim(&mut rd, 0, &host).unwrap();
        let mut pd = a[5].try_borrow_mut_data().unwrap();
        let mut e = read_entry(&pd, 0).unwrap();
        e.id = alias;
        write_entry(&mut pd, 0, &e).unwrap();
        roster.validate_paired(&rd, &wres::live_ids(&pd).unwrap()).unwrap();
    }
    a
}

/// FIXTURE (before any handler): the source's host in roster entry 0 has
/// sequence `seq` (issued: HOST_SEQ = seq + 1).
fn host_seq(a: &[AccountInfo], seq: u32) {
    let mut rd = a[6].try_borrow_mut_data().unwrap();
    let roster = WideRoster::read(&rd).unwrap();
    let prior = roster.release(&mut rd, 0).unwrap().unwrap();
    let host = WideHostRef::new(prior.key(), prior.site(), prior.gen(), seq).unwrap();
    let alias = roster.claim(&mut rd, 0, &host).unwrap();
    let mut pd = a[5].try_borrow_mut_data().unwrap();
    let mut e = read_entry(&pd, 0).unwrap();
    e.id = alias;
    write_entry(&mut pd, 0, &e).unwrap();
    roster.validate_paired(&rd, &wres::live_ids(&pd).unwrap()).unwrap();
    Rw(&mut a[4].try_borrow_mut_data().unwrap())
        .set_u32(H1::HOST_SEQ, seq + 1)
        .unwrap();
}

#[test]
fn a9_fresh_sidecars_reserve_like_immediate_for_wide_and_legacy_sources() {
    let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let _stub = install();
    let mut results = Vec::new();
    for family in ["wide", "legacy-ring1", "legacy-ring128"] {
        for seq in [0u32, 1] {
            // 0 retained, 1 fresh unfunded, 2 fresh prefunded below rent
            for sidecars in 0..3 {
                for next in [10u32, 8] {
                    let mut a = match family {
                        "wide" => declaration::fixture(),
                        "legacy-ring1" => declaration::legacy_fixture(),
                        _ => legacy_at(128, 0),
                    };
                    if a[5].key == a[7].key {
                        a[7].is_writable = a[5].is_writable;
                    }
                    prep(&a, next);
                    host_seq(&a, seq);
                    if sidecars > 0 {
                        let rt = init::rent(wc::CONQUEST_SIZE).unwrap();
                        let re = init::rent(wc::CAPTURE_ESCROW_SIZE).unwrap();
                        let (pt, pe) = if sidecars == 2 { (rt / 3, re / 2) } else { (0, 0) };
                        a[9] = declaration::ai(key(&a[9]), prologue::ids::SYSTEM_PROGRAM, vec![], pt, false, true);
                        a[10] = declaration::ai(key(&a[10]), prologue::ids::SYSTEM_PROGRAM, vec![], pe, false, true);
                    }
                    let _fresh = Installed(Some(solana_program::program_stubs::set_syscall_stubs(
                        Box::new(FreshStubs {
                            season: key(&a[2]),
                            citizen: key(&a[3]),
                        }),
                    )));
                    let result = declare(&a, 0);
                    let shape = result.as_ref().ok().map(|_| {
                        let t = tbl(&a);
                        (t.entry(1).unwrap().is_some(), t.pending_at(1, 10).len())
                    });
                    results.push((family, seq, sidecars, next, result, shape));
                }
            }
        }
    }
    let failed: Vec<_> = results.iter().filter(|r| r.4.is_err()).collect();
    for r in &results {
        std::println!("A9 {:?}", r);
    }
    assert!(failed.is_empty(), "A9 failures: {failed:?}");
    for (_, _, _, next, _, shape) in &results {
        assert_eq!(*shape, Some(if *next == 10 { (true, 0) } else { (false, 1) }));
    }
}

/// A9 replay: the DeclareSiege source checks, in handler order, on the
/// ring-128 legacy source (diagnostic; prints every step's result).
#[test]
fn a9_replay_ring128_legacy_source_checks() {
    use frontier_abi::world_index::expedition::{AccountFamily, AccountResolver};
    let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let _stub = install();
    for (p, q) in [(1i16, 0i16), (128, 0)] {
        let a = legacy_at(p, q);
        prep(&a, 8);
        let ctx = addr::ctx(&key(&a[2]), &PROGRAM);
        let world = world_of(&ctx).unwrap();
        let rd = a[6].try_borrow_data().unwrap().to_vec();
        let roster = WideRoster::read(&rd).unwrap();
        let chosen = roster.ref_at(&rd, 0).unwrap().unwrap();
        let resolver = AccountResolver::for_season(&ctx).unwrap();
        std::println!("A9R ({p},{q}) family {:?}", resolver.family(chosen.key()));
        let src = declaration_engine::source_at(&a[4], &program(), &ctx, SID, chosen);
        std::println!("A9R ({p},{q}) source_at ok={}", src.is_ok());
        std::println!(
            "A9R ({p},{q}) holding addr matches={} ctx.province==resolver.province: {}",
            resolver.holding_address(&chosen).ok() == Some(key(&a[4])),
            ctx.province(p as i32, q as i32) == resolver.province_address(chosen.key()).unwrap()
        );
        let csp = crate::proc::conquest::check_source_province(&program(), &ctx, SID, &a[4], &a[7]);
        std::println!("A9R ({p},{q}) check_source_province {:?}", csp);
        let id = resolver.legacy_host_id(&chosen);
        std::println!("A9R ({p},{q}) legacy_host_id {:?}", id);
        if let Ok(id) = id {
            std::println!("A9R ({p},{q}) legacy_host_ref round trip {:?}", resolver.legacy_host_ref(id).map(|r| r == chosen));
        }
        if let Ok(Some(h)) = &src {
            std::println!("A9R ({p},{q}) source family legacy={} coord ok={}", h.family == AccountFamily::Legacy, h.coord == chosen.key().coord());
            let cd = a[3].try_borrow_data().unwrap();
            let hd = a[4].try_borrow_data().unwrap();
            let want = SlotBinding::Legacy(wh::HoldingRef {
                p: Ro(&hd).i16(H1::P).unwrap(),
                q: Ro(&hd).i16(H1::Q).unwrap(),
                site: h.site,
                gen: h.gen,
            });
            std::println!("A9R ({p},{q}) slot {} binding {:?} want {:?}", h.slot, wh::binding_of(&cd, h.slot), want);
            std::println!("A9R ({p},{q}) capture_lock_of {:?}", capture_lock_of(&a[7].try_borrow_data().unwrap(), &hd));
            let source_ref = WideHostRef::new(ProvinceKey::new(world, h.coord), h.site, h.gen, 0);
            std::println!("A9R ({p},{q}) source_ref {:?} == holding_ref {}", source_ref.is_ok(), source_ref.ok() == Some(chosen.holding_ref()));
        }
        drop(rd);
        let e = declare(&a, 0);
        std::println!("A9R ({p},{q}) declare {:?}", e);
        assert!(src.is_ok() && csp.is_ok() && e.is_ok(), "({p},{q})");
        assert_eq!(tbl(&a).pending_at(1, 10).len(), 1);
    }
}
