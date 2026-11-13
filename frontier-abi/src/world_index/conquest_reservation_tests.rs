//! Pure tests of the siege reservation table (spec
//! `CLAUDE-CONQUEST-RESERVATION-SPEC-20261112.md`): codec, invariants, order,
//! application bookkeeping, the full fail-closed return and its idempotence.
use super::*;
use crate::world_index::WideCoord;

fn world() -> WorldId {
    WorldId::new([0x77; 32]).unwrap()
}
fn key() -> ProvinceKey {
    ProvinceKey::new(world(), WideCoord::checked(129, 0).unwrap())
}
fn home() -> ProvinceKey {
    ProvinceKey::new(world(), WideCoord::checked(130, 0).unwrap())
}
fn citizen(n: u8) -> [u8; 32] {
    [n; 32]
}
fn host(n: u8) -> WideHostRef {
    WideHostRef::new(home(), 2, 1, n as u32).unwrap()
}
fn res(c: u8, site: u8, bell: u32, slot: u8, faction: u8) -> Reservation {
    Reservation {
        status: RES_PENDING,
        site,
        entry: c,
        reserved_slot: slot,
        faction,
        done: 0,
        bell,
        seq: 0,
        citizen: citizen(c),
        host: host(c),
        actor_tag: crate::addr::citizen_tag(&citizen(c)),
        gold_milli: 25_000,
        arms_milli: 50_000,
    }
}
fn idle() -> Record {
    let mut r = Record::ZERO;
    r.faction = CR::BARRED_NONE;
    r
}
fn table() -> WideConquest {
    WideConquest::new(11, key(), [9; 32]).unwrap()
}
fn reserve(t: &WideConquest, prefix: Record, r: Reservation) -> (WideConquest, Record, Reservation) {
    t.reserve(prefix, r).unwrap()
}
fn roundtrip(t: &WideConquest) -> WideConquest {
    let b = t.to_bytes();
    assert_eq!(b.len(), CONQUEST_SIZE);
    WideConquest::read(&b, 11, key()).unwrap()
}
fn entry_of(r: &Reservation) -> WideConquestEntry {
    WideConquestEntry {
        rules: SiteRecordRules {
            kind: CR::KIND_SIEGE,
            faction: r.faction,
            flags: CR::FLAG_HELD | CR::FLAG_NEUTRAL,
            progress: 0,
            required: 3,
            target: CR::target(CR::TARGET_FREE_CITY, r.reserved_slot),
            vigil_start: 0,
            vigil_next: 0,
            vigil_from_day: 0,
            bell: r.bell,
        },
        citizen: r.citizen,
        source: Some(r.source()),
        actor_tag: r.actor_tag,
        reserved_slot: r.reserved_slot,
        original_target_gen: 0,
        declaration_bell: r.bell,
    }
}

#[test]
fn size_and_empty_table_roundtrip() {
    assert_eq!(CONQUEST_SIZE, 2688);
    let t = table();
    assert_eq!(roundtrip(&t), t);
    assert!(t.is_empty());
    assert_eq!(t.next_seq(), 0);
}

/// The conquest lane reads ONLY the version-2 layout: an original 1664-byte v1 table and the 2688-byte v1 form
/// (present only in the historical 87b19e9e evidence) are both refused; no migration.
#[test]
fn the_conquest_lane_refuses_v1_tables_of_either_size() {
    let v2 = table().to_bytes();
    assert_eq!(u16_at(&v2, 16), 2, "the conquest lane writes table version 2");
    let mut v1_long = v2;
    v1_long[16..18].copy_from_slice(&1u16.to_le_bytes());
    assert_eq!(WideConquest::read(&v1_long, 11, key()), Err(ConquestError::Version), "2688/v1 refused");
    let mut v1_short = [0u8; 1664];
    v1_short.copy_from_slice(&v1_long[..1664]);
    assert_eq!(WideConquest::read(&v1_short, 11, key()), Err(ConquestError::Length), "1664/v1 refused");
}

#[test]
fn several_reservations_on_one_site_are_held_in_order_and_flag_the_prefix() {
    let t = table();
    let (t, p, a) = reserve(&t, idle(), res(1, 4, 20, 2, 0));
    assert_eq!(p.flags, CR::FLAG_PENDING);
    assert_eq!(a.seq, 0);
    // Other Citizens, other factions, same site and bell: all accepted.
    let (t, p, b) = reserve(&t, p, res(2, 4, 20, 2, 1));
    let (t, p, c) = reserve(&t, p, res(3, 4, 20, 3, 0));
    // Same site, a later bell.
    let (t, p, d) = reserve(&t, p, res(4, 4, 21, 2, 2));
    assert_eq!((b.seq, c.seq, d.seq), (1, 2, 3));
    let t = roundtrip(&t);
    t.validate_paired(4, p).unwrap();
    let order: Vec<u32> = t.pending_at(4, 20).iter().map(|(_, r)| r.seq).collect();
    assert_eq!(order, [0, 1, 2]);
    assert_eq!(t.pending_at(4, 21).len(), 1);
    // The flag must agree with the table, both ways.
    t.validate_paired(4, idle()).unwrap_err();
    let mut wrong = idle();
    wrong.flags = CR::FLAG_PENDING;
    table().validate_paired(4, wrong).unwrap_err();
}

#[test]
fn reservation_capacity_and_existing_refusals_are_explicit() {
    let mut t = table();
    let mut p = idle();
    for c in 1..=RESERVATIONS_N as u8 {
        let (n, np, _) = reserve(&t, p, res(c, 4, 20, 2, 0));
        t = n;
        p = np;
    }
    assert_eq!(t.reserve(p, res(99, 4, 20, 2, 0)), Err(ConquestError::Full));
    // (Citizen, slot) stays unique.
    let (t2, p2, _) = reserve(&table(), idle(), res(1, 4, 20, 2, 0));
    let _ = p2;
    assert_eq!(t2.reserve(idle(), res(1, 5, 20, 2, 0)).err(), Some(ConquestError::State));
    // An owed or busy site is refused, as an immediate declaration is.
    let mut owed = idle();
    owed.flags = CR::FLAG_SLOT_OWED;
    assert!(table().reserve(owed, res(1, 4, 20, 2, 0)).is_err());
}

#[test]
fn an_immediate_declaration_cannot_overtake_a_pending_reservation() {
    let (t, p, r) = reserve(&table(), idle(), res(1, 4, 20, 2, 0));
    let mirror = SiteTransitionMirror {
        state: SM::STATE_FREE_CITY,
        gen: 0,
        order: 0,
        held_since_hour: 0,
        walls_committed: 0,
    };
    let mut e = entry_of(&res(2, 4, 20, 2, 1));
    e.rules.bell = 20;
    assert_eq!(t.declare(4, p, mirror, e).err(), Some(ConquestError::State));
    let _ = r;
}

#[test]
fn application_moves_the_first_to_the_entry_and_the_others_owe_a_full_return() {
    let (t, p, a) = reserve(&table(), idle(), res(1, 4, 20, 2, 0));
    let (t, p, b) = reserve(&t, p, res(2, 4, 20, 2, 1));
    let _ = p;
    let list = t.pending_at(4, 20);
    let plan = t.apply_reservation(list[0].0, entry_of(&a)).unwrap();
    let t = plan.conquest.not_apply(list[1].0).unwrap();
    assert_eq!(plan.prefix, entry_of(&a).prefix());
    assert_eq!(t.entry(4).unwrap(), Some(entry_of(&a)));
    assert!(t.reservation(a.seq).is_none());
    let (_, nb) = t.reservation(b.seq).unwrap();
    assert_eq!(nb.status, RES_NOT_APPLIED);
    assert!(nb.holds_slot());
    assert!(!t.has_pending(4));
    let t = roundtrip(&t);
    t.validate_paired(4, plan.prefix).unwrap();
    // A second application of the same record, or of a NOT_APPLIED one, fails.
    assert!(t.apply_reservation(list[0].0, entry_of(&a)).is_err());
    assert!(t.apply_reservation(list[1].0, entry_of(&b)).is_err());
}

#[test]
fn an_entry_mismatching_its_reservation_is_refused() {
    let (t, _, a) = reserve(&table(), idle(), res(1, 4, 20, 2, 0));
    let i = t.pending_at(4, 20)[0].0;
    for f in [
        |e: &mut WideConquestEntry| e.declaration_bell += 1,
        |e: &mut WideConquestEntry| e.reserved_slot = 3,
        |e: &mut WideConquestEntry| e.rules.faction = 1,
        |e: &mut WideConquestEntry| e.source = None,
    ] {
        let mut e = entry_of(&a);
        f(&mut e);
        assert!(t.apply_reservation(i, e).is_err());
    }
}

#[test]
fn a_stale_pending_reservation_is_detected() {
    let (t, _, _) = reserve(&table(), idle(), res(1, 4, 20, 2, 0));
    assert!(!t.stale_pending(20));
    assert!(t.stale_pending(21));
    let t = t.not_apply(t.pending_at(4, 20)[0].0).unwrap();
    assert!(!t.stale_pending(21));
}

#[test]
fn settling_a_lapsed_siege_keeps_the_flag_while_later_reservations_wait() {
    let (t, _, a) = reserve(&table(), idle(), res(1, 4, 20, 2, 0));
    let (t, _, _) = reserve(&t, idle_pending(), res(2, 4, 25, 2, 1));
    let plan = t.apply_reservation(t.pending_at(4, 20)[0].0, entry_of(&a)).unwrap();
    let t = plan.conquest;
    t.validate_paired(4, plan.prefix).unwrap();
    let s = t
        .settle(4, plan.prefix, entry_of(&a), 40, true, 40, 2)
        .unwrap();
    assert_eq!(s.prefix.flags, CR::FLAG_PENDING);
    s.conquest.validate_paired(4, s.prefix).unwrap();
}
fn idle_pending() -> Record {
    let mut r = idle();
    r.flags = CR::FLAG_PENDING;
    r
}

fn not_applied() -> (WideConquest, Reservation) {
    let (t, _, a) = reserve(&table(), idle(), res(1, 4, 20, 2, 0));
    let t = t.not_apply(t.pending_at(4, 20)[0].0).unwrap();
    (t, a)
}

#[test]
fn a_return_is_done_in_full_parts_and_never_paid_twice() {
    let (t, a) = not_applied();
    // Nothing doable now: refused, nothing changes, the debt stays.
    assert_eq!(t.settle_reservation(a.seq, false, false, false), Err(ConquestError::Blocked));
    // Rent and slot first while the resources are blocked (no room / source gone).
    let s1 = t.settle_reservation(a.seq, false, true, false).unwrap();
    assert!(!s1.return_resources && s1.release_slot_rent && !s1.freed);
    let t1 = roundtrip(&s1.conquest);
    let (_, r1) = t1.reservation(a.seq).unwrap();
    assert_eq!(r1.done, RES_SLOT_RENT_RELEASED);
    assert!(!r1.holds_slot());
    // A retry of the same part never pays again.
    assert_eq!(t1.settle_reservation(a.seq, false, true, false), Err(ConquestError::Blocked));
    // The slot may be reused after release (uniqueness ignores the released record).
    let (t1b, _, _) = reserve(&t1, idle(), res(1, 5, 30, 2, 0));
    roundtrip(&t1b);
    // The resources later, in full; the record is freed only now.
    let s2 = t1.settle_reservation(a.seq, true, true, false).unwrap();
    assert!(s2.return_resources && !s2.release_slot_rent && s2.freed);
    assert_eq!(s2.reservation.gold_milli, 25_000);
    assert_eq!(s2.reservation.arms_milli, 50_000);
    let t2 = roundtrip(&s2.conquest);
    assert_eq!(t2.settle_reservation(a.seq, true, true, false), Err(ConquestError::Absent));
    assert!(t2.is_empty());
}

#[test]
fn resources_first_then_slot_also_never_pays_twice() {
    let (t, a) = not_applied();
    let s1 = t.settle_reservation(a.seq, true, false, false).unwrap();
    assert!(s1.return_resources && !s1.release_slot_rent);
    let s2 = s1.conquest.settle_reservation(a.seq, true, true, false).unwrap();
    assert!(!s2.return_resources && s2.release_slot_rent && s2.freed);
}

#[test]
fn a_pending_reservation_cannot_be_settled_or_cancelled() {
    let (t, _, a) = reserve(&table(), idle(), res(1, 4, 20, 2, 0));
    assert_eq!(t.settle_reservation(a.seq, true, true, false), Err(ConquestError::TooEarly));
}

#[test]
fn corrupted_records_are_refused_on_read() {
    let (t, _, _) = reserve(&table(), idle(), res(1, 4, 20, 2, 0));
    let o = 1664;
    let mut b = t.to_bytes();
    b[o] = 3; // unknown status
    assert!(WideConquest::read(&b, 11, key()).is_err());
    let mut b = t.to_bytes();
    b[o + 5] = RES_RESOURCES_RETURNED; // a PENDING record with a done part
    assert!(WideConquest::read(&b, 11, key()).is_err());
    let mut b = t.to_bytes();
    b[120] = 0; // seq not below the counter
    assert!(WideConquest::read(&b, 11, key()).is_err());
    let mut b = t.to_bytes();
    b[o + 6] = 1; // reserved bytes
    assert!(WideConquest::read(&b, 11, key()).is_err());
}

#[test]
fn escrow_keeps_one_binding_per_citizen_and_site() {
    // Full three-way pairing with real Citizen bytes is in the program's
    // native reservation tests; here only the existing escrow rule.
    let a = res(1, 4, 20, 2, 0);
    let e = WideCaptureEscrow::new(11, world(), citizen(1), [9; 32]).unwrap();
    let (e, _) = e.reserve(2, a.binding(key()), 1_000, [8; 32]).unwrap();
    assert!(e.reserve(3, res(1, 4, 21, 3, 0).binding(key()), 1_000, [8; 32]).is_err());
    assert!(e.reserve(3, res(1, 5, 21, 3, 0).binding(key()), 1_000, [8; 32]).is_ok());
}

/// A canonical freshly joined Citizen: no ticket, every holding slot empty
/// (`EMPTY_GEN`), its tag. The zero Citizen is not canonical.
fn citizen_bytes(n: u8) -> [u8; C::SIZE] {
    let mut cd = [0u8; C::SIZE];
    cd[C::TICKET_BELL..C::TICKET_BELL + 4].copy_from_slice(&C::NO_TICKET.to_le_bytes());
    for s in 1..=3 {
        cd[C::holding_of_slot(s) + 5] = C::EMPTY_GEN;
    }
    let tag = crate::addr::citizen_tag(&citizen(n));
    cd[C::CITIZEN_TAG..C::CITIZEN_TAG + 8].copy_from_slice(&tag.to_le_bytes());
    cd
}
/// Reserve for Citizen 1 on site 4 with its Citizen mark and escrow binding.
fn paired_reservation() -> (WideConquest, Reservation, WideCaptureEscrow, [u8; C::SIZE]) {
    let (t, _, a) = reserve(&table(), idle(), res(1, 4, 20, 2, 0));
    let mut cd = citizen_bytes(1);
    mark(&mut cd, 2).unwrap();
    let e = WideCaptureEscrow::new(11, world(), citizen(1), [9; 32]).unwrap();
    let (e, _) = e.reserve(2, a.binding(key()), 1_000, [8; 32]).unwrap();
    (t, a, e, cd)
}

#[test]
fn three_way_pairing_holds_for_a_reservation() {
    let (t, a, e, cd) = paired_reservation();
    e.validate_inventory(11, world(), citizen(1), &cd).unwrap();
    e.validate_paired_reservation(&t, a.seq, citizen(1), &cd).unwrap();
}

#[test]
fn three_way_pairing_refuses_a_binding_without_its_reservation() {
    // Forward: the escrow holds two bindings to this province; the table
    // holds the reservation of only one of them.
    let (t, _, b) = reserve(&table(), idle(), res(1, 6, 20, 3, 0));
    let mut cd = citizen_bytes(1);
    mark(&mut cd, 2).unwrap();
    mark(&mut cd, 3).unwrap();
    let e = WideCaptureEscrow::new(11, world(), citizen(1), [9; 32]).unwrap();
    let (e, _) = e.reserve(3, b.binding(key()), 1_000, [8; 32]).unwrap();
    let (e, _) = e.reserve(2, res(1, 4, 20, 2, 0).binding(key()), 1_000, [8; 32]).unwrap();
    e.validate_inventory(11, world(), citizen(1), &cd).unwrap();
    assert_eq!(
        e.validate_paired_reservation(&t, b.seq, citizen(1), &cd).err(),
        Some(ConquestError::Stale)
    );
    // With the second reservation present the same escrow pairs.
    let (t2, _, a) = reserve(&t, idle(), res(1, 4, 20, 2, 0));
    e.validate_paired_reservation(&t2, b.seq, citizen(1), &cd).unwrap();
    e.validate_paired_reservation(&t2, a.seq, citizen(1), &cd).unwrap();
}

#[test]
fn three_way_pairing_refuses_a_reservation_without_its_binding() {
    // Reverse: the table holds the reservation, the escrow has no binding.
    let (t, a, _, cd) = paired_reservation();
    let bare = WideCaptureEscrow::new(11, world(), citizen(1), [9; 32]).unwrap();
    // The Citizen mark without a binding already fails the inventory check.
    assert!(bare.validate_paired_reservation(&t, a.seq, citizen(1), &cd).is_err());
    // A binding for a different bell is stale too.
    let e2 = WideCaptureEscrow::new(11, world(), citizen(1), [9; 32]).unwrap();
    let (e2, _) = e2.reserve(2, res(1, 4, 21, 2, 0).binding(key()), 1_000, [8; 32]).unwrap();
    assert_eq!(
        e2.validate_paired_reservation(&t, a.seq, citizen(1), &cd).err(),
        Some(ConquestError::Stale)
    );
    // Another Citizen's escrow is refused by identity.
    let (_, _, e1, _) = paired_reservation();
    assert!(e1.validate_paired_reservation(&t, a.seq, citizen(2), &citizen_bytes(2)).is_err());
}

#[test]
fn slot_release_then_reuse_then_full_return_without_double_payment() {
    let (t, a, e, mut cd) = paired_reservation();
    let t = t.not_apply(t.pending_at(4, 20)[0].0).unwrap();
    e.validate_paired_reservation(&t, a.seq, citizen(1), &cd).unwrap();
    // Resources blocked; release rent and slot exactly as the handler does.
    let s1 = t.settle_reservation(a.seq, false, true, false).unwrap();
    assert!(s1.release_slot_rent && !s1.return_resources);
    let (e, refund) = e.refund(2, a.binding(key()), 1_000).unwrap();
    assert_eq!(refund, 1_000);
    clear(&mut cd, 2).unwrap();
    let t = s1.conquest;
    // The released record no longer pairs a slot; the empty escrow agrees.
    e.validate_paired_reservation(&t, a.seq, citizen(1), &cd).unwrap();
    // A retry of rent/slot is refused: nothing to pay twice.
    assert_eq!(t.settle_reservation(a.seq, false, true, false), Err(ConquestError::Blocked));
    assert!(e.refund(2, a.binding(key()), 1_000).is_err());
    // The slot is reused by a new reservation (another site, later bell).
    let (t, _, b) = reserve(&t, idle(), res(1, 5, 30, 2, 0));
    mark(&mut cd, 2).unwrap();
    let (e, _) = e.reserve(2, b.binding(key()), 1_000, [8; 32]).unwrap();
    e.validate_paired_reservation(&t, b.seq, citizen(1), &cd).unwrap();
    e.validate_paired_reservation(&t, a.seq, citizen(1), &cd).unwrap();
    let t = roundtrip(&t);
    // The old debt is still owed and returned once, in full.
    let s2 = t.settle_reservation(a.seq, true, true, false).unwrap();
    assert!(s2.return_resources && !s2.release_slot_rent && s2.freed);
    assert_eq!((s2.reservation.gold_milli, s2.reservation.arms_milli), (25_000, 50_000));
    assert_eq!(
        s2.conquest.settle_reservation(a.seq, true, true, false),
        Err(ConquestError::Absent)
    );
    // The new reservation is untouched.
    assert_eq!(s2.conquest.reservation(b.seq).map(|(_, r)| r), Some(b));
}

#[test]
fn a_pending_reservation_lapses_only_by_the_seasons_end_or_abort() {
    let (t, _, a) = reserve(&table(), idle(), res(1, 4, 20, 2, 0));
    // No early cancellation: without the authenticated terminal state.
    assert_eq!(t.settle_reservation(a.seq, true, true, false), Err(ConquestError::TooEarly));
    // Terminal, nothing doable now: the lapse alone records the owed return.
    let s = t.settle_reservation(a.seq, false, false, true).unwrap();
    assert!(s.lapsed && !s.return_resources && !s.release_slot_rent && !s.freed);
    let t1 = roundtrip(&s.conquest);
    let (_, r) = t1.reservation(a.seq).unwrap();
    assert_eq!((r.status, r.done), (RES_NOT_APPLIED, 0));
    assert!(!t1.has_pending(4));
    // The prefix flag is recomputed by the caller from the table.
    assert_eq!(t1.idle_prefix(4, idle_pending()).unwrap().flags, 0);
    // The owed return is then paid like any NOT_APPLIED one, once.
    let s2 = t1.settle_reservation(a.seq, true, true, true).unwrap();
    assert!(!s2.lapsed && s2.return_resources && s2.release_slot_rent && s2.freed);
    assert_eq!(
        s2.conquest.settle_reservation(a.seq, true, true, true),
        Err(ConquestError::Absent)
    );
}

#[test]
fn a_terminal_lapse_with_parts_doable_pays_them_in_the_same_call() {
    let (t, _, a) = reserve(&table(), idle(), res(1, 4, 20, 2, 0));
    let s = t.settle_reservation(a.seq, true, false, true).unwrap();
    assert!(s.lapsed && s.return_resources && !s.release_slot_rent && !s.freed);
    let (_, r) = s.conquest.reservation(a.seq).unwrap();
    assert_eq!(r.done, RES_RESOURCES_RETURNED);
    // Nothing doable after that: refused, debt (slot/rent) kept.
    assert_eq!(
        s.conquest.settle_reservation(a.seq, false, false, true),
        Err(ConquestError::Blocked)
    );
}
