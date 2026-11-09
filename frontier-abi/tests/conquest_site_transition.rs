//! Fixed-byte fixtures: no key generation, derivation, signing, or terrain RNG.
use frontier_abi::bytes::{wr_u16, wr_u32};
use frontier_abi::clash_model::ModelError;
use frontier_abi::conquest_model::{self as qm, BellReport, Record, SiteReport, StepParams};
use frontier_abi::v2::layout::province::{conquest as CR, keep as KP, province as P, site as SM};
use frontier_abi::v2::log::{event, Event};
use frontier_abi::v2::presets::MC_LOCAL_7D;

fn params() -> StepParams {
    let mut p = StepParams {
        genesis_ts: 0,
        end_bell: 0,
        cq: MC_LOCAL_7D.cq,
    };
    p.cq.immunity_bells = 9;
    p.cq.respite_bells = 7;
    p.cq.occupation_tenure_bells = 100;
    p.cq.capture_credit_min_bells = 12;
    p
}

fn siege(target: u8) -> Record {
    Record {
        kind: CR::KIND_SIEGE,
        faction: 1,
        flags: CR::FLAG_NEUTRAL,
        progress: 1,
        required: 3,
        target,
        bell: 1,
        actor: 0xfeed_0123_4567_89ab,
        src: 0xffff_aabb_ccdd_0099,
        ..Record::ZERO
    }
}

fn fixture(r: Record, state: u8) -> Vec<u8> {
    let mut pd = vec![0; P::SIZE];
    pd[P::KEEP + KP::TILE] = KP::NO_TILE;
    // Sentinel bytes prove every unmentioned mirror byte remains untouched.
    pd[P::site(0)..P::site(0) + SM::SIZE].fill(0xa5);
    pd[P::site(0) + SM::STATE] = state;
    pd[P::site(0) + SM::GEN] = 255;
    pd[P::site(0) + SM::ORDER] = 2;
    assert!(wr_u16(&mut pd, P::site(0) + SM::HELD_SINCE_HOUR, 1));
    assert!(wr_u32(&mut pd, P::site(0) + SM::WALLS_COMMITTED, 101));
    pd[P::record(0)..P::record(0) + CR::SIZE].fill(0x5a);
    r.write(&mut pd, 0).unwrap();
    pd
}

fn report(holders: u8, defender_present: bool) -> BellReport {
    let mut rep = BellReport::default();
    rep.sites[0] = SiteReport {
        holders,
        defender_present,
    };
    rep
}

fn ev(code: u8, faction: u8, progress: u8) -> Event {
    Event {
        site: 0,
        code,
        faction,
        progress,
    }
}

fn check(
    mut pd: Vec<u8>,
    expected: Vec<u8>,
    b: u32,
    rep: BellReport,
    events: &[Event],
    changed: bool,
    quiet: bool,
    active: bool,
) {
    let out = qm::step(&mut pd, b, &rep, &params()).unwrap();
    assert_eq!(pd, expected, "complete Province bytes at bell {b}");
    assert_eq!(out.events(), events);
    assert_eq!(out.changed, changed);
    assert_eq!(out.quiet_inputs_changed, quiet);
    assert_eq!(out.active, active);
    assert!(!out.roster_changed);
    assert_eq!(out.keep_taken, None);
    assert_eq!(out.snapshot, None);
}

#[test]
fn progress_and_defender_pause_preserve_opaque_context() {
    let r = siege(CR::target(CR::TARGET_OTHER, 3));
    let pd = fixture(r, SM::STATE_HOLDING);
    let mut expected = pd.clone();
    Record { progress: 2, ..r }.write(&mut expected, 0).unwrap();
    check(
        pd.clone(),
        expected,
        11,
        report(2, false),
        &[],
        true,
        false,
        true,
    );
    check(pd.clone(), pd, 11, report(2, true), &[], false, false, true);
}

#[test]
fn failures_preserve_slot_and_bar_rules_and_clear_source() {
    for (target, state, defender, slot, barred) in [
        (CR::TARGET_OTHER, SM::STATE_HOLDING, true, 3, true),
        (CR::TARGET_OTHER, SM::STATE_HOLDING, false, 3, false),
        (CR::TARGET_FIRST, SM::STATE_HOLDING, true, 0, true),
        (CR::TARGET_FREE_CITY, SM::STATE_FREE_CITY, true, 2, false),
    ] {
        let r = siege(CR::target(target, slot));
        let pd = fixture(r, state);
        let mut expected = pd.clone();
        Record {
            faction: if barred { 1 } else { CR::BARRED_NONE },
            flags: (if barred { CR::FLAG_STAKE_TO_HOLDING } else { 0 })
                | (if slot != 0 { CR::FLAG_SLOT_OWED } else { 0 }),
            progress: if barred { 255 } else { 0 },
            required: slot,
            bell: if barred { 21 } else { 0 },
            actor: if slot != 0 { r.actor } else { 0 },
            ..Record::ZERO
        }
        .write(&mut expected, 0)
        .unwrap();
        check(
            pd,
            expected,
            11,
            report(0, defender),
            &[ev(
                event::SIEGE_FAILED | if defender { event::DETAIL } else { 0 },
                1,
                1,
            )],
            true,
            false,
            false,
        );
    }
}

fn expected_capture(
    pd: &mut [u8],
    r: Record,
    b: u32,
    credited: bool,
    free: bool,
    order: u8,
    hour: u16,
    walls: u32,
) {
    let o = P::site(0);
    pd[o + SM::STATE] = SM::STATE_HOLDING;
    pd[o + SM::FACTION] = r.faction;
    pd[o + SM::ORDER] = order;
    pd[o + SM::GEN] = 0;
    assert!(wr_u16(pd, o + SM::HELD_SINCE_HOUR, hour));
    assert!(wr_u32(pd, o + SM::GARRISON, 0));
    assert!(wr_u32(pd, o + SM::PEND0_BELL, SM::NO_BELL));
    assert!(wr_u32(pd, o + SM::PEND1_BELL, SM::NO_BELL));
    pd[o + SM::PEND0_DELTA..o + SM::PEND0_DELTA + 8].fill(0);
    pd[o + SM::PEND1_DELTA..o + SM::PEND1_DELTA + 8].fill(0);
    assert!(wr_u32(pd, o + SM::WALLS_COMMITTED, walls));
    assert!(wr_u32(pd, o + SM::SHIELD_UNTIL_BELL, 0));
    if free {
        pd[o + SM::TIER_NEXT] = SM::NO_TIER_NEXT;
        assert!(wr_u32(pd, o + SM::TIER_NEXT_BELL, 0));
    }
    Record {
        kind: CR::KIND_CAPTURE_DUE,
        faction: r.faction,
        flags: if credited { CR::FLAG_CREDITED } else { 0 },
        target: r.target,
        bell: b,
        actor: r.actor,
        src: r.src,
        ..Record::ZERO
    }
    .write(pd, 0)
    .unwrap();
}

#[test]
fn capture_credit_threshold_walls_free_city_and_generation_wrap() {
    // held_since_hour=1: b=16 is one below credit, b=17 is the threshold.
    for (b, faction, free, slot, credit, hour, walls) in [
        (16, 1, false, 3, false, 3, 50),
        (17, 1, false, 3, true, 3, 50),
        (17, 5, false, 0, true, 3, 101),
        (11, 1, true, 2, true, 2, 50),
        (u32::MAX, 5, false, 3, true, u16::MAX, 101),
    ] {
        let r = Record {
            faction,
            progress: 2,
            ..siege(CR::target(
                if free {
                    CR::TARGET_FREE_CITY
                } else {
                    CR::TARGET_OTHER
                },
                slot,
            ))
        };
        let mut pd = fixture(
            r,
            if free {
                SM::STATE_FREE_CITY
            } else {
                SM::STATE_HOLDING
            },
        );
        // Both normal increment and saturation must be preserved.
        let before = if faction == 5 { u16::MAX } else { 8 };
        assert!(wr_u16(&mut pd, P::captures_by(faction as usize), before));
        let mut expected = pd.clone();
        expected_capture(
            &mut expected,
            r,
            b,
            credit,
            free,
            if slot == 0 { 2 } else { slot },
            hour,
            walls,
        );
        assert!(wr_u16(
            &mut expected,
            P::captures_by(faction as usize),
            if credit {
                before.saturating_add(1)
            } else {
                before
            }
        ));
        check(
            pd,
            expected,
            b,
            report(1 << faction, false),
            &[ev(
                event::CAPTURE_DUE | if credit { event::DETAIL } else { 0 },
                faction,
                3,
            )],
            true,
            true,
            false,
        );
    }
}

#[test]
fn first_home_becomes_occupation_without_mirror_changes() {
    let r = Record {
        progress: 2,
        ..siege(CR::TARGET_FIRST)
    };
    let pd = fixture(r, SM::STATE_HOLDING);
    let mut expected = pd.clone();
    Record {
        kind: CR::KIND_OCCUPATION,
        faction: 1,
        flags: CR::FLAG_STAKE_TO_SRC,
        target: r.target,
        bell: 11,
        actor: r.actor,
        src: r.src,
        ..Record::ZERO
    }
    .write(&mut expected, 0)
    .unwrap();
    check(
        pd,
        expected,
        11,
        report(2, false),
        &[ev(event::OCCUPIED, 1, 3)],
        true,
        false,
        true,
    );
}

#[test]
fn occupation_exit_unpaid_stake_respite_and_expiry_precedence() {
    for paid in [false, true] {
        for (b, holders, defender, respite, code) in [
            (11, 0, true, true, event::LIBERATED),
            (11, 0, false, false, event::LIBERATED | event::DETAIL),
            (11, 4, false, false, event::LIBERATED | event::DETAIL),
            (101, 0, true, true, event::OCCUPATION_EXPIRED),
            (u32::MAX, 2, false, true, event::OCCUPATION_EXPIRED),
        ] {
            let r = Record {
                kind: CR::KIND_OCCUPATION,
                flags: if paid { 0 } else { CR::FLAG_STAKE_TO_SRC },
                ..siege(CR::TARGET_FIRST)
            };
            let pd = fixture(r, SM::STATE_HOLDING);
            let mut expected = pd.clone();
            Record {
                faction: if respite { 1 } else { CR::BARRED_NONE },
                flags: r.flags,
                bell: if respite { b.saturating_add(7) } else { 0 },
                src: r.src,
                ..Record::ZERO
            }
            .write(&mut expected, 0)
            .unwrap();
            check(
                pd,
                expected,
                b,
                report(holders, defender),
                &[ev(code, 1, 0)],
                true,
                false,
                false,
            );
        }
    }
    let r = Record {
        kind: CR::KIND_OCCUPATION,
        ..siege(CR::TARGET_FIRST)
    };
    let pd = fixture(r, SM::STATE_HOLDING);
    check(
        pd.clone(),
        pd,
        11,
        report(2, false),
        &[],
        false,
        false,
        true,
    );
}

#[test]
fn same_bell_capture_due_unknown_kind_and_invalid_state() {
    for kind in [CR::KIND_SIEGE, CR::KIND_OCCUPATION, 99] {
        let r = Record {
            kind,
            bell: 11,
            ..siege(CR::TARGET_OTHER)
        };
        let pd = fixture(r, 99);
        check(
            pd.clone(),
            pd,
            11,
            report(0, false),
            &[],
            false,
            false,
            kind == CR::KIND_SIEGE || kind == CR::KIND_OCCUPATION,
        );
    }
    let r = Record {
        kind: CR::KIND_CAPTURE_DUE,
        ..siege(CR::TARGET_OTHER)
    };
    let pd = fixture(r, 99);
    check(
        pd.clone(),
        pd,
        11,
        report(0, false),
        &[],
        false,
        false,
        false,
    );
    for (kind, state) in [
        (99, SM::STATE_HOLDING),
        (CR::KIND_SIEGE, 99),
        (CR::KIND_OCCUPATION, SM::STATE_FREE_CITY),
    ] {
        let r = Record {
            kind,
            ..siege(CR::TARGET_OTHER)
        };
        let mut pd = fixture(r, state);
        assert_eq!(
            qm::step(&mut pd, 11, &report(0, false), &params()),
            Err(ModelError::Kernel(qm::sub::RECORD))
        );
        assert_eq!(
            qm::site_transition(
                r.into(),
                qm::SiteTransitionMirror {
                    state,
                    ..Default::default()
                },
                11,
                SiteReport::default(),
                &params()
            ),
            Err(ModelError::Kernel(qm::sub::RECORD))
        );
    }
}

#[test]
fn independent_site_events_remain_in_site_index_order() {
    let r = siege(CR::TARGET_FIRST);
    let mut pd = fixture(r, SM::STATE_HOLDING);
    let o = P::site(0);
    let bytes = pd[o..o + SM::SIZE].to_vec();
    pd[P::site(1)..P::site(1) + SM::SIZE].copy_from_slice(&bytes);
    r.write(&mut pd, 1).unwrap();
    let mut expected = pd.clone();
    let n = Record {
        faction: CR::BARRED_NONE,
        ..Record::ZERO
    };
    n.write(&mut expected, 0).unwrap();
    n.write(&mut expected, 1).unwrap();
    check(
        pd,
        expected,
        11,
        BellReport::default(),
        &[
            ev(event::SIEGE_FAILED, 1, 1),
            Event {
                site: 1,
                ..ev(event::SIEGE_FAILED, 1, 1)
            },
        ],
        true,
        false,
        false,
    );
}

#[test]
fn vigil_progress_saturation_and_immunity_saturation() {
    // At genesis+110 minutes, a midnight vigil pauses the non-neutral siege.
    let r = Record {
        flags: 0,
        ..siege(CR::TARGET_FIRST)
    };
    let pd = fixture(r, SM::STATE_HOLDING);
    check(
        pd.clone(),
        pd,
        11,
        report(2, false),
        &[],
        false,
        false,
        true,
    );
    let r = Record {
        progress: 255,
        required: 255,
        ..siege(CR::TARGET_FIRST)
    };
    let pd = fixture(r, SM::STATE_HOLDING);
    let mut expected = pd.clone();
    Record {
        kind: CR::KIND_OCCUPATION,
        faction: 1,
        flags: CR::FLAG_STAKE_TO_SRC,
        target: r.target,
        bell: 11,
        actor: r.actor,
        src: r.src,
        ..Record::ZERO
    }
    .write(&mut expected, 0)
    .unwrap();
    check(
        pd,
        expected,
        11,
        report(2, false),
        &[ev(event::OCCUPIED, 1, 255)],
        true,
        false,
        true,
    );
    let r = siege(CR::TARGET_FIRST);
    let pd = fixture(r, SM::STATE_HOLDING);
    let mut expected = pd.clone();
    Record {
        faction: 1,
        flags: CR::FLAG_STAKE_TO_HOLDING,
        progress: 255,
        bell: u32::MAX,
        ..Record::ZERO
    }
    .write(&mut expected, 0)
    .unwrap();
    check(
        pd,
        expected,
        u32::MAX,
        report(0, true),
        &[ev(event::SIEGE_FAILED | event::DETAIL, 1, 1)],
        true,
        false,
        false,
    );
}
