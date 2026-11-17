#![cfg(feature = "world-index-experimental")]
//! Literal public identifiers only. No key generation, signing or native crypto.
use frontier_abi::conquest_model::{
    Record, SiteRecordRules, SiteReport, SiteTransitionMirror, StepParams,
};
use frontier_abi::v2::{
    layout::{
        player::citizen as C,
        province::{conquest as CR, site as SM},
    },
    presets::FRONTIER_7,
};
use frontier_abi::world_index::{conquest::*, ProvinceKey, WideCoord, WideHostRef, WorldId};

fn world() -> WorldId {
    WorldId::new([7; 32]).unwrap()
}
fn key() -> ProvinceKey {
    ProvinceKey::new(world(), WideCoord::checked(1i64 << 54, -129).unwrap())
}
fn entry() -> WideConquestEntry {
    WideConquestEntry {
        rules: SiteRecordRules {
            kind: CR::KIND_SIEGE,
            faction: 1,
            flags: CR::FLAG_HELD | CR::FLAG_NEUTRAL,
            required: 1,
            target: CR::target(CR::TARGET_FREE_CITY, 2),
            bell: 1,
            ..Default::default()
        },
        citizen: [8; 32],
        source: Some(WideHostRef::new(key(), 3, 8, 0).unwrap()),
        actor_tag: frontier_abi::addr::citizen_tag(&[8; 32]),
        reserved_slot: 2,
        original_target_gen: 0,
        declaration_bell: 1,
    }
}
fn mirror() -> SiteTransitionMirror {
    SiteTransitionMirror {
        state: SM::STATE_FREE_CITY,
        gen: 0,
        order: 0,
        held_since_hour: 0,
        walls_committed: 101,
    }
}
fn params() -> StepParams {
    StepParams {
        genesis_ts: 0,
        end_bell: 100,
        cq: FRONTIER_7,
    }
}
fn declared() -> ConquestPlan {
    WideConquest::new(3, key(), [2; 32])
        .unwrap()
        .declare(0, Record::ZERO, mirror(), entry())
        .unwrap()
}
fn binding() -> CaptureBinding {
    CaptureBinding {
        key: key(),
        site: 0,
        gen: 0,
        declaration_bell: 1,
    }
}

fn inventory_citizen() -> [u8; C::SIZE] {
    let mut c = [0xa5; C::SIZE];
    c[C::SLOTS] = 0;
    for slot in 2..=3 {
        c[C::holding_of_slot(slot) + 5] = C::EMPTY_GEN;
    }
    c[C::TICKET_BELL..C::TICKET_BELL + 4].copy_from_slice(&C::NO_TICKET.to_le_bytes());
    c[C::CITIZEN_TAG..C::CITIZEN_TAG + 8]
        .copy_from_slice(&frontier_abi::addr::citizen_tag(&[8; 32]).to_le_bytes());
    c
}

#[test]
fn empty_inventory_requires_exact_context_and_no_orphan_markers() {
    let escrow = WideCaptureEscrow::new(3, world(), [8; 32], [2; 32]).unwrap();
    let c = inventory_citizen();
    assert_eq!(escrow.validate_inventory(3, world(), [8; 32], &c), Ok(()));
    assert_eq!(escrow.terminal_citizen_plan(3, world(), [8; 32], &c), Ok(c));
    for (season, w, citizen) in [
        (4, world(), [8; 32]),
        (3, WorldId::new([9; 32]).unwrap(), [8; 32]),
        (3, world(), [9; 32]),
    ] {
        assert_eq!(
            escrow.validate_inventory(season, w, citizen, &c),
            Err(ConquestError::Identity)
        );
        assert_eq!(
            escrow.terminal_citizen_plan(season, w, citizen, &c),
            Err(ConquestError::Identity)
        );
    }
    let mut wrong_tag = c;
    wrong_tag[C::CITIZEN_TAG] ^= 1;
    assert_eq!(
        escrow.validate_inventory(3, world(), [8; 32], &wrong_tag),
        Err(ConquestError::Identity)
    );
    for short in [&c[..C::SIZE - 1], &c[..0]] {
        assert_eq!(
            escrow.terminal_citizen_plan(3, world(), [8; 32], short),
            Err(ConquestError::Length)
        );
    }
    for slots in [16, 32, 16 | 4, 32 | 8, 16 | 32 | 4 | 8] {
        let mut orphan = c;
        orphan[C::SLOTS] = slots;
        assert_eq!(
            escrow.validate_inventory(3, world(), [8; 32], &orphan),
            Err(ConquestError::Marker)
        );
    }
    // Empty escrow does not claim or clear legacy reservations or holdings.
    let mut legacy = c;
    legacy[C::SLOTS] = 4 | 8;
    legacy[C::holding_of_slot(2) + 5] = 1;
    assert_eq!(
        escrow.validate_inventory(3, world(), [8; 32], &legacy),
        Ok(())
    );
    assert_eq!(
        escrow.terminal_citizen_plan(3, world(), [8; 32], &legacy),
        Ok(legacy)
    );
}

#[test]
fn terminal_inventory_clears_only_owned_pairs_without_a_table() {
    let initial = WideCaptureEscrow::new(3, world(), [8; 32], [2; 32]).unwrap();
    let (one, _) = initial.reserve(2, binding(), 100, [3; 32]).unwrap();
    let (both, _) = one
        .reserve(
            3,
            CaptureBinding {
                site: 1,
                ..binding()
            },
            100,
            [4; 32],
        )
        .unwrap();
    for escrow in [&one, &both] {
        let mut c = inventory_citizen();
        // Preserve unrelated bits, legacy reservation, ticket and all data.
        c[C::SLOTS] = 0xc0 | 1 | if escrow.active_mask() == 4 { 8 } else { 0 };
        c[C::TICKET_BELL..C::TICKET_BELL + 4].copy_from_slice(&2u32.to_le_bytes());
        let expected = c;
        for slot in 2..=3 {
            if escrow.active_mask() & C::reserved_bit(slot) != 0 {
                mark(&mut c, slot).unwrap();
            }
        }
        let before = c;
        let raw = escrow.to_bytes();
        assert_eq!(escrow.validate_inventory(3, world(), [8; 32], &c), Ok(()));
        assert_eq!(
            escrow.terminal_citizen_plan(3, world(), [8; 32], &c),
            Ok(expected)
        );
        assert_eq!(c, before);
        assert_eq!(escrow.to_bytes(), raw);
    }
}

#[test]
fn inventory_rejects_occupied_missing_and_ticket_overlaps_without_partial_clear() {
    let empty = WideCaptureEscrow::new(3, world(), [8; 32], [2; 32]).unwrap();
    let (one, _) = empty.reserve(2, binding(), 100, [3; 32]).unwrap();
    let (both, _) = one
        .reserve(
            3,
            CaptureBinding {
                site: 1,
                ..binding()
            },
            100,
            [3; 32],
        )
        .unwrap();
    let mut valid = inventory_citizen();
    mark(&mut valid, 2).unwrap();
    mark(&mut valid, 3).unwrap();
    for slot in 2..=3 {
        // Malformed ref, ordinary legacy holding, and exact wide marker.
        for reference in [[0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 1], [0, 0, 0, 0, 12, 0]] {
            let mut bad = valid;
            let start = C::holding_of_slot(slot);
            bad[start..start + 6].copy_from_slice(&reference);
            let before = bad;
            assert_eq!(
                both.terminal_citizen_plan(3, world(), [8; 32], &bad),
                Err(ConquestError::Marker)
            );
            assert_eq!(bad, before);
        }
        let mut missing = valid;
        clear(&mut missing, slot).unwrap();
        assert_eq!(
            both.validate_inventory(3, world(), [8; 32], &missing),
            Err(ConquestError::Marker)
        );
        let mut ticket = valid;
        ticket[C::SLOTS] |= slot;
        ticket[C::TICKET_BELL..C::TICKET_BELL + 4].copy_from_slice(&2u32.to_le_bytes());
        assert_eq!(
            both.validate_inventory(3, world(), [8; 32], &ticket),
            Err(ConquestError::Marker)
        );
    }
    // Pending WideTicket is rejected even on a different slot or before the
    // first capture reservation. Malformed ticket markers also fail closed.
    for escrow in [&empty, &one] {
        for ticket_slot in [0, 3] {
            let mut c = inventory_citizen();
            if escrow.active_mask() != 0 {
                mark(&mut c, 2).unwrap();
            }
            c[C::SLOTS] |= ticket_slot;
            c[C::TICKET_BELL..C::TICKET_BELL + 4].copy_from_slice(&2u32.to_le_bytes());
            c[C::TICKET_SITES..C::TICKET_NEXT].fill(0);
            assert_eq!(
                escrow.validate_inventory(3, world(), [8; 32], &c),
                Err(ConquestError::Marker)
            );
            assert_eq!(
                escrow.terminal_citizen_plan(3, world(), [8; 32], &c),
                Err(ConquestError::Marker)
            );
        }
    }
}

#[test]
fn codec_exact_identity_reserved_and_source() {
    let p = declared();
    let b = p.conquest.to_bytes();
    assert_eq!(b.len(), 1664);
    assert_eq!(WideConquest::read(&b, 3, key()).unwrap(), p.conquest);
    assert_eq!(p.prefix.src, 0);
    for i in [18, 31, 82, 87, 120, 127, 128 + 118, 255] {
        let mut bad = b;
        bad[i] = 1;
        assert_eq!(
            WideConquest::read(&bad, 3, key()),
            Err(ConquestError::Reserved)
        );
    }
    let mut bad = b;
    bad[16] = 2;
    assert_eq!(
        WideConquest::read(&bad, 3, key()),
        Err(ConquestError::Version)
    );
    let mut bad = b;
    bad[0] = 0;
    assert_eq!(
        WideConquest::read(&bad, 3, key()),
        Err(ConquestError::Magic)
    );
    assert_eq!(
        WideConquest::read(&b[..1663], 3, key()),
        Err(ConquestError::Length)
    );
    assert_eq!(
        WideConquest::read(&b, 4, key()),
        Err(ConquestError::Identity)
    );
    let mut bad = b;
    bad[128 + 48 + 52] = 1;
    assert_eq!(
        WideConquest::read(&bad, 3, key()),
        Err(ConquestError::Identity)
    );
    let mut bad = b;
    bad[128 + 48 + 1] = 9;
    assert_eq!(
        WideConquest::read(&bad, 3, key()),
        Err(ConquestError::Identity)
    );
    assert_ne!(conquest_seed(key()), capture_escrow_seed(&[8; 32]));
}

#[test]
fn shared_success_capture_settlement_and_stale_context() {
    let p = declared();
    let e = entry();
    let report = SiteReport {
        holders: 2,
        defender_present: false,
    };
    let expected =
        frontier_abi::conquest_model::site_transition(e.rules, mirror(), 2, report, &params())
            .unwrap();
    let n = p
        .conquest
        .step(0, p.prefix, e, mirror(), 2, report, &params())
        .unwrap();
    assert_eq!(n.transition, expected);
    assert_eq!(n.prefix.kind, CR::KIND_CAPTURE_DUE);
    // Every supported Free City capture is credited by the shared rules.
    let mut forged = n.conquest.to_bytes();
    forged[128 + 2] = 0;
    assert_eq!(
        WideConquest::read(&forged, 3, key()),
        Err(ConquestError::State)
    );
    let due = n.conquest.entry(0).unwrap().unwrap();
    assert_eq!(due.source, e.source);
    assert_eq!(n.transition.unwrap().capture.unwrap().gen, 1);
    assert_eq!(
        n.conquest
            .step(0, p.prefix, e, mirror(), 3, report, &params()),
        Err(ConquestError::Stale)
    );
    let settled = n
        .conquest
        .settle(0, n.prefix, due, 3, false, 100, 9)
        .unwrap();
    assert_eq!(settled.return_stake_to, e.source);
    assert_eq!(settled.prefix.faction, CR::BARRED_ALL);
    assert_eq!(settled.prefix.bell, 12);
    assert_eq!(settled.conquest.entry(0).unwrap(), None);
    assert!(settled.conquest.validate_paired(0, settled.prefix).is_ok());
    assert_eq!(
        settled.conquest.settle(0, n.prefix, due, 3, false, 100, 9),
        Err(ConquestError::Stale)
    );
    assert_eq!(settled.prefix.actor, 0);
    assert_eq!(settled.prefix.src, 0);
}

#[test]
fn failure_burns_stake_and_end_waits_for_resolution() {
    let p = declared();
    let report = SiteReport {
        holders: 0,
        defender_present: true,
    };
    let failed = p
        .conquest
        .step(0, p.prefix, entry(), mirror(), 2, report, &params())
        .unwrap();
    assert_eq!(failed.prefix.flags, CR::FLAG_SLOT_OWED);
    assert_eq!(failed.prefix.required, 2);
    let e = failed.conquest.entry(0).unwrap().unwrap();
    assert_eq!(e.source, None);
    let settled = failed
        .conquest
        .settle(0, failed.prefix, e, 3, false, 100, 9)
        .unwrap();
    assert_eq!(settled.return_stake_to, None);
    assert_eq!(
        p.conquest.settle(0, p.prefix, entry(), 99, true, 100, 9),
        Err(ConquestError::TooEarly)
    );
    let lapse = p
        .conquest
        .settle(0, p.prefix, entry(), 100, true, 100, 9)
        .unwrap();
    assert_eq!(lapse.return_stake_to, entry().source);
    assert_eq!(p.conquest, declared().conquest);
    let mut wrong = entry();
    wrong.citizen = [9; 32];
    assert_eq!(
        p.conquest.settle(0, p.prefix, wrong, 100, true, 100, 9),
        Err(ConquestError::Stale)
    );
    let mut owned = mirror();
    owned.state = SM::STATE_HOLDING;
    assert_eq!(
        WideConquest::new(3, key(), [2; 32])
            .unwrap()
            .declare(0, Record::ZERO, owned, entry()),
        Err(ConquestError::State)
    );
}

#[test]
fn representability_and_pre_declaration_bells_are_not_activation() {
    let blank = WideConquest::new(3, key(), [2; 32]).unwrap();
    for faction in [6, 127, 253] {
        assert_eq!(
            blank.validate_paired(
                0,
                Record {
                    faction,
                    ..Record::ZERO
                }
            ),
            Err(ConquestError::Stale)
        );
    }
    assert_eq!(
        blank.validate_paired(
            0,
            Record {
                flags: CR::FLAG_NEUTRAL,
                ..Record::ZERO
            }
        ),
        Err(ConquestError::Stale)
    );
    for gen in [254, 255] {
        let mut e = entry();
        e.original_target_gen = gen;
        let mut m = mirror();
        m.gen = gen;
        assert_eq!(
            blank.declare(0, Record::ZERO, m, e),
            Err(ConquestError::State)
        );
    }
    for gen in [0, 255] {
        let mut e = entry();
        e.source = Some(WideHostRef::new(key(), 3, gen, 0).unwrap());
        assert_eq!(
            blank.declare(0, Record::ZERO, mirror(), e),
            Err(ConquestError::Identity)
        );
    }
    let mut e = entry();
    e.source = Some(
        WideHostRef::new(
            ProvinceKey::new(world(), WideCoord::checked(128, 0).unwrap()),
            3,
            1,
            0,
        )
        .unwrap(),
    );
    assert_eq!(
        blank.declare(0, Record::ZERO, mirror(), e),
        Err(ConquestError::Identity)
    );
    let p = declared();
    let unchanged = p
        .conquest
        .step(
            0,
            p.prefix,
            entry(),
            mirror(),
            1,
            SiteReport {
                holders: 2,
                defender_present: false,
            },
            &params(),
        )
        .unwrap();
    assert_eq!(unchanged.conquest, p.conquest);
    assert_eq!(unchanged.transition, None);
}

#[test]
fn escrow_two_slots_topup_partial_prefund_refund_and_close() {
    let initial = WideCaptureEscrow::new(3, world(), [8; 32], [2; 32]).unwrap();
    let (a, t) = initial.reserve(2, binding(), 100, [3; 32]).unwrap();
    assert_eq!(t, 100);
    let other = CaptureBinding {
        site: 1,
        ..binding()
    };
    let (b, t) = a.reserve(3, other, 100, [4; 32]).unwrap();
    assert_eq!(t, 100);
    assert_eq!(b.funder(), [4; 32]);
    let raw = b.to_bytes();
    assert_eq!(raw.len(), 320);
    assert_eq!(
        WideCaptureEscrow::read(&raw, 3, world(), [8; 32]).unwrap(),
        b
    );
    let terminal = b.close_refund_plan(250).unwrap();
    assert_eq!(terminal.active_slots, 12);
    assert_eq!(terminal.refund, 200);
    assert_eq!(terminal.remainder, 50);
    assert_eq!(
        b.to_bytes(),
        raw,
        "terminal plan does not mutate unresolved bindings"
    );
    let (c, spent) = b.capture(2, binding(), 100, 60).unwrap();
    assert_eq!(spent, 40);
    assert_eq!(c.escrow(), 160);
    assert_eq!(c.capture(2, binding(), 100, 0), Err(ConquestError::Stale));
    let (d, refund) = c.refund(3, other, 100).unwrap();
    assert_eq!(refund, 100);
    assert_eq!(d.escrow(), 60);
    let (e, topup) = d.reserve(2, binding(), 50, [5; 32]).unwrap();
    assert_eq!(topup, 0);
    assert_eq!(e.funder(), [4; 32]);
    assert_eq!(e.rent_payer(), [2; 32]);
    let (f, refund) = e.refund(2, binding(), 100).unwrap();
    assert_eq!(refund, 60);
    assert_eq!(f.escrow(), 0);
    let close = d.close_refund_plan(110).unwrap();
    assert_eq!(close.refund, 60);
    assert_eq!(close.active_slots, 0);
    assert_eq!(close.remainder, 50);
    assert_eq!(close.funder, [4; 32]);
    assert_eq!(close.rent_payer, [2; 32]);
    assert_eq!(d.close_refund_plan(59), Err(ConquestError::Escrow));
    assert_eq!(
        a.reserve(3, other, u64::MAX, [4; 32]),
        Err(ConquestError::Overflow)
    );
    assert_eq!(a.refund(2, other, 100), Err(ConquestError::Stale));
    for i in [18, 169, 175, 288, 319] {
        let mut bad = raw;
        bad[i] = 1;
        assert_eq!(
            WideCaptureEscrow::read(&bad, 3, world(), [8; 32]),
            Err(ConquestError::Reserved)
        );
    }
    let mut bad = raw;
    bad[168] = 4;
    assert!(WideCaptureEscrow::read(&bad, 3, world(), [8; 32]).is_err());
}

#[test]
fn markers_preserve_every_other_byte_and_allow_other_legacy_slot() {
    let mut c = vec![0xa5; C::SIZE];
    c[C::SLOTS] = 3;
    c[C::TICKET_BELL..C::TICKET_BELL + 4].copy_from_slice(&1u32.to_le_bytes());
    c[C::holding_of_slot(2) + 5] = C::EMPTY_GEN;
    let before = c.clone();
    mark(&mut c, 2).unwrap();
    assert_eq!(c[C::SLOTS], 3 | 4 | 16);
    assert_eq!(wide_reservations(c[C::SLOTS]), Ok(4));
    assert_eq!(legacy_reservations(c[C::SLOTS] | 8), Ok(8));
    assert_eq!(
        ensure_legacy_slot(c[C::SLOTS], 2),
        Err(ConquestError::Marker)
    );
    assert!(ensure_legacy_slot(c[C::SLOTS], 3).is_ok());
    let mut expected = before.clone();
    expected[C::SLOTS] = 3 | 4 | 16;
    assert_eq!(c, expected);
    let marked = c.clone();
    assert!(mark(&mut c, 2).is_err());
    assert_eq!(c, marked);
    clear(&mut c, 2).unwrap();
    assert_eq!(c, before);
    assert!(clear(&mut c, 2).is_err());
    assert_eq!(c, before);
    assert_eq!(wide_reservations(16), Err(ConquestError::Marker));
    assert_eq!(wide_reservations(32 | 4), Err(ConquestError::Marker));
    assert_eq!(legacy_reservations(4 | 8), Ok(12));
    assert_eq!(has_wide_reservations(4 | 16), Ok(true));
    c[C::SLOTS] = 0;
    c[C::TICKET_BELL..C::TICKET_BELL + 4].copy_from_slice(&C::NO_TICKET.to_le_bytes());
    c[C::holding_of_slot(3) + 5] = C::EMPTY_GEN;
    mark(&mut c, 2).unwrap();
    mark(&mut c, 3).unwrap();
    assert_eq!(wide_reservations(c[C::SLOTS]), Ok(12));
    clear(&mut c, 2).unwrap();
    assert_eq!(wide_reservations(c[C::SLOTS]), Ok(8));
}

#[test]
fn three_way_binding_survives_failure_and_refuses_wrong_context() {
    let p = declared();
    let (escrow, _) = WideCaptureEscrow::new(3, world(), [8; 32], [2; 32])
        .unwrap()
        .reserve(2, binding(), 100, [3; 32])
        .unwrap();
    let mut c = vec![0; C::SIZE];
    c[C::holding_of_slot(2) + 5] = C::EMPTY_GEN;
    c[C::TICKET_BELL..C::TICKET_BELL + 4].copy_from_slice(&C::NO_TICKET.to_le_bytes());
    c[C::CITIZEN_TAG..C::CITIZEN_TAG + 8].copy_from_slice(&entry().actor_tag.to_le_bytes());
    mark(&mut c, 2).unwrap();
    assert!(escrow
        .validate_paired(&p.conquest, 0, p.prefix, [8; 32], &c)
        .is_ok());
    assert_eq!(
        escrow.validate_paired(&p.conquest, 0, p.prefix, [9; 32], &c),
        Err(ConquestError::Identity)
    );
    assert_eq!(
        escrow.reserve(
            3,
            CaptureBinding {
                declaration_bell: 2,
                ..binding()
            },
            100,
            [3; 32]
        ),
        Err(ConquestError::State)
    );
    let failed = p
        .conquest
        .step(
            0,
            p.prefix,
            entry(),
            mirror(),
            2,
            SiteReport {
                holders: 0,
                defender_present: true,
            },
            &params(),
        )
        .unwrap();
    assert_eq!(
        failed.conquest.entry(0).unwrap().unwrap().declaration_bell,
        1
    );
    assert!(escrow
        .validate_paired(&failed.conquest, 0, failed.prefix, [8; 32], &c)
        .is_ok());
    c[C::holding_of_slot(2) + 5] = 1;
    let before = c.clone();
    assert_eq!(clear(&mut c, 2), Err(ConquestError::Slot));
    assert_eq!(c, before);
    assert_eq!(
        escrow.validate_paired(&failed.conquest, 0, failed.prefix, [8; 32], &c),
        Err(ConquestError::Marker)
    );
    assert_eq!(
        p.conquest.settle(0, p.prefix, entry(), 100, false, 100, 9),
        Err(ConquestError::TooEarly)
    );
    let blank = WideConquest::new(3, key(), [2; 32]).unwrap();
    assert!(blank
        .declare(
            0,
            Record {
                faction: CR::BARRED_ALL,
                bell: 999,
                ..Record::ZERO
            },
            mirror(),
            entry()
        )
        .is_ok());
}

#[test]
fn duplicate_obligations_and_unmatched_global_markers_are_refused() {
    let p = declared();
    assert_eq!(
        p.conquest.declare(1, Record::ZERO, mirror(), entry()),
        Err(ConquestError::State)
    );
    let mut raw = p.conquest.to_bytes();
    let first: Vec<u8> = raw[128..256].to_vec();
    raw[256..384].copy_from_slice(&first);
    assert_eq!(
        WideConquest::read(&raw, 3, key()),
        Err(ConquestError::State)
    );
    let (escrow, _) = WideCaptureEscrow::new(3, world(), [8; 32], [2; 32])
        .unwrap()
        .reserve(2, binding(), 100, [3; 32])
        .unwrap();
    let mut c = vec![0; C::SIZE];
    c[C::holding_of_slot(2) + 5] = C::EMPTY_GEN;
    c[C::holding_of_slot(3) + 5] = C::EMPTY_GEN;
    c[C::TICKET_BELL..C::TICKET_BELL + 4].copy_from_slice(&C::NO_TICKET.to_le_bytes());
    c[C::CITIZEN_TAG..C::CITIZEN_TAG + 8].copy_from_slice(&entry().actor_tag.to_le_bytes());
    mark(&mut c, 2).unwrap();
    mark(&mut c, 3).unwrap();
    assert_eq!(
        escrow.validate_paired(&p.conquest, 0, p.prefix, [8; 32], &c),
        Err(ConquestError::Marker)
    );
    let (both, _) = escrow
        .reserve(
            3,
            CaptureBinding {
                site: 1,
                ..binding()
            },
            100,
            [3; 32],
        )
        .unwrap();
    assert_eq!(
        both.validate_paired(&p.conquest, 0, p.prefix, [8; 32], &c),
        Err(ConquestError::Stale)
    );
    let mut second = entry();
    second.reserved_slot = 3;
    second.rules.target = CR::target(CR::TARGET_FREE_CITY, 3);
    let paired = p
        .conquest
        .declare(1, Record::ZERO, mirror(), second)
        .unwrap();
    assert!(both
        .validate_paired(&paired.conquest, 0, p.prefix, [8; 32], &c)
        .is_ok());
    let mut only_slot_two = c.clone();
    clear(&mut only_slot_two, 3).unwrap();
    assert_eq!(
        escrow.validate_paired(&paired.conquest, 0, p.prefix, [8; 32], &only_slot_two),
        Err(ConquestError::Stale)
    );
    let mut mismatch = paired.conquest.to_bytes();
    mismatch[256 + 113] = 1;
    let mismatch = WideConquest::read(&mismatch, 3, key()).unwrap();
    assert_eq!(
        both.validate_paired(&mismatch, 0, p.prefix, [8; 32], &c),
        Err(ConquestError::Stale)
    );
    c[C::holding_of_slot(3) + 5] = 1;
    assert_eq!(
        both.validate_paired(&paired.conquest, 0, p.prefix, [8; 32], &c),
        Err(ConquestError::Marker)
    );
    let mut bytes = both.to_bytes();
    let first: Vec<u8> = bytes[176..232].to_vec();
    bytes[232..288].copy_from_slice(&first);
    assert_eq!(
        WideCaptureEscrow::read(&bytes, 3, world(), [8; 32]),
        Err(ConquestError::State)
    );
}
