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

/// Expected `qm::step` outcome: the emitted events and the three outcome flags.
struct Want<'a> {
    events: &'a [Event],
    changed: bool,
    quiet: bool,
    active: bool,
}

fn check(mut pd: Vec<u8>, expected: Vec<u8>, b: u32, rep: BellReport, want: Want) {
    let out = qm::step(&mut pd, b, &rep, &params()).unwrap();
    assert_eq!(pd, expected, "complete Province bytes at bell {b}");
    assert_eq!(out.events(), want.events);
    assert_eq!(out.changed, want.changed);
    assert_eq!(out.quiet_inputs_changed, want.quiet);
    assert_eq!(out.active, want.active);
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
        Want {
            events: &[],
            changed: true,
            quiet: false,
            active: true,
        },
    );
    check(
        pd.clone(),
        pd,
        11,
        report(2, true),
        Want {
            events: &[],
            changed: false,
            quiet: false,
            active: true,
        },
    );
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
            Want {
                events: &[ev(
                    event::SIEGE_FAILED | if defender { event::DETAIL } else { 0 },
                    1,
                    1,
                )],
                changed: true,
                quiet: false,
                active: false,
            },
        );
    }
}

/// Expected post-capture site-mirror values.
struct CaptureMirror {
    order: u8,
    hour: u16,
    walls: u32,
}

fn expected_capture(
    pd: &mut [u8],
    r: Record,
    b: u32,
    credited: bool,
    free: bool,
    mirror: CaptureMirror,
) {
    let CaptureMirror { order, hour, walls } = mirror;
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
            CaptureMirror {
                order: if slot == 0 { 2 } else { slot },
                hour,
                walls,
            },
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
            Want {
                events: &[ev(
                    event::CAPTURE_DUE | if credit { event::DETAIL } else { 0 },
                    faction,
                    3,
                )],
                changed: true,
                quiet: true,
                active: false,
            },
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
        Want {
            events: &[ev(event::OCCUPIED, 1, 3)],
            changed: true,
            quiet: false,
            active: true,
        },
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
                Want {
                    events: &[ev(code, 1, 0)],
                    changed: true,
                    quiet: false,
                    active: false,
                },
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
        Want {
            events: &[],
            changed: false,
            quiet: false,
            active: true,
        },
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
            Want {
                events: &[],
                changed: false,
                quiet: false,
                active: kind == CR::KIND_SIEGE || kind == CR::KIND_OCCUPATION,
            },
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
        Want {
            events: &[],
            changed: false,
            quiet: false,
            active: false,
        },
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
        Want {
            events: &[
                ev(event::SIEGE_FAILED, 1, 1),
                Event {
                    site: 1,
                    ..ev(event::SIEGE_FAILED, 1, 1)
                },
            ],
            changed: true,
            quiet: false,
            active: false,
        },
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
        Want {
            events: &[],
            changed: false,
            quiet: false,
            active: true,
        },
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
        Want {
            events: &[ev(event::OCCUPIED, 1, 255)],
            changed: true,
            quiet: false,
            active: true,
        },
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
        Want {
            events: &[ev(event::SIEGE_FAILED | event::DETAIL, 1, 1)],
            changed: true,
            quiet: false,
            active: false,
        },
    );
}

/// The program's `step` keeps its own in-place copy of the site rules (the
/// G1 ResolveFromInputs budget; see the note above `step_siege` in
/// conquest_model.rs). This holds the two copies equal: over a seeded grid of
/// records, mirrors, reports, bells and parameters, `site_transition`'s
/// effects, applied here to the same Province bytes, give exactly `step`'s
/// bytes, events, flags and errors.
#[test]
fn site_transition_matches_the_legacy_step() {
    fn pick<T: Copy>(x: &mut u64, v: &[T]) -> T {
        // xorshift64: a fixed sequence, no RNG crate
        *x ^= *x << 13;
        *x ^= *x >> 7;
        *x ^= *x << 17;
        v[(*x % v.len() as u64) as usize]
    }
    let base = params();
    let mut short = base;
    short.cq.occupation_tenure_bells = 1;
    short.cq.capture_credit_min_bells = 0;
    short.genesis_ts = 1_700_000_000;
    let targets: Vec<u8> = [CR::TARGET_FIRST, CR::TARGET_OTHER, CR::TARGET_FREE_CITY]
        .into_iter()
        .flat_map(|k| (0..4).map(move |s| CR::target(k, s)))
        .collect();
    let flags = [
        0,
        CR::FLAG_NEUTRAL,
        CR::FLAG_STAKE_TO_SRC,
        CR::FLAG_NEUTRAL | CR::FLAG_STAKE_TO_SRC,
        CR::FLAG_HELD | CR::FLAG_NEUTRAL,
        0xff,
    ];
    let mut seen = [0u32; 7];
    let mut x = 0x9e37_79b9_7f4a_7c15u64;
    for _ in 0..60_000 {
        let r = Record {
            kind: pick(&mut x, &[CR::KIND_SIEGE, CR::KIND_OCCUPATION]),
            faction: pick(&mut x, &[0, 1, 5, 6, CR::BARRED_NONE]),
            flags: pick(&mut x, &flags),
            progress: pick(&mut x, &[0, 1, 2, 35, 254, 255]),
            required: pick(&mut x, &[0, 1, 3, 36, 255]),
            target: pick(&mut x, &targets),
            vigil_start: pick(&mut x, &[0, 60, 1380]),
            vigil_next: pick(&mut x, &[0, 120, 1439]),
            vigil_from_day: pick(&mut x, &[0, 1, 9]),
            bell: pick(&mut x, &[0, 1, 10, 11, 12, 190]),
            actor: 0xfeed_0123_4567_89ab,
            src: 0xffff_aabb_ccdd_0099,
        };
        let state = pick(&mut x, &[SM::STATE_HOLDING, SM::STATE_FREE_CITY, 99]);
        let b = pick(&mut x, &[11, 13, 205, u32::MAX]);
        let prm = pick(&mut x, &[base, short]);
        let sr = SiteReport {
            holders: pick(&mut x, &[0, 1, 2, 1 << 5, 1 << 6, 0x7f]),
            defender_present: pick(&mut x, &[false, true]),
        };
        let mut pd = fixture(r, state);
        let o = P::site(0);
        pd[o + SM::GEN] = pick(&mut x, &[0, 7, 255]);
        pd[o + SM::ORDER] = pick(&mut x, &[0, 1, 2, 3]);
        assert!(wr_u16(
            &mut pd,
            o + SM::HELD_SINCE_HOUR,
            pick(&mut x, &[0, 1, 3, u16::MAX])
        ));
        assert!(wr_u32(
            &mut pd,
            o + SM::WALLS_COMMITTED,
            pick(&mut x, &[0, 101, u32::MAX])
        ));
        let count = pick(&mut x, &[0, 7, u16::MAX]);
        for f in 0..P::FACTIONS {
            assert!(wr_u16(&mut pd, P::captures_by(f), count));
        }
        let mirror = qm::SiteTransitionMirror {
            state: pd[o + SM::STATE],
            gen: pd[o + SM::GEN],
            order: pd[o + SM::ORDER],
            held_since_hour: u16::from_le_bytes([
                pd[o + SM::HELD_SINCE_HOUR],
                pd[o + SM::HELD_SINCE_HOUR + 1],
            ]),
            walls_committed: u32::from_le_bytes(
                pd[o + SM::WALLS_COMMITTED..o + SM::WALLS_COMMITTED + 4]
                    .try_into()
                    .unwrap(),
            ),
        };
        let rep = BellReport {
            sites: {
                let mut s = [SiteReport::default(); P::SITES_N];
                s[0] = sr;
                s
            },
            ..BellReport::default()
        };
        let pure = qm::site_transition(r.into(), mirror, b, sr, &prm);
        let mut legacy = pd.clone();
        let got = qm::step(&mut legacy, b, &rep, &prm);
        let case = format!("{r:?} state {state} b {b} {sr:?} {mirror:?}");
        let t = match pure {
            Err(e) => {
                seen[6] += 1;
                assert_eq!(got.map(|_| ()), Err(e), "{case}");
                continue;
            }
            Ok(t) => t,
        };
        let out = got.unwrap_or_else(|e| panic!("{case}: step {e:?}"));
        let mut want = pd.clone();
        let mut events = vec![];
        let (mut changed, mut quiet) = (false, false);
        if let Some(t) = t {
            if let Some(c) = t.capture {
                let captor = t.record.faction;
                want[o + SM::STATE] = SM::STATE_HOLDING;
                want[o + SM::FACTION] = captor;
                want[o + SM::ORDER] = c.order;
                want[o + SM::GEN] = c.gen;
                assert!(wr_u16(
                    &mut want,
                    o + SM::HELD_SINCE_HOUR,
                    c.held_since_hour
                ));
                assert!(wr_u32(&mut want, o + SM::GARRISON, 0));
                assert!(wr_u32(&mut want, o + SM::PEND0_BELL, SM::NO_BELL));
                assert!(wr_u32(&mut want, o + SM::PEND1_BELL, SM::NO_BELL));
                want[o + SM::PEND0_DELTA..o + SM::PEND0_DELTA + 8].fill(0);
                want[o + SM::PEND1_DELTA..o + SM::PEND1_DELTA + 8].fill(0);
                assert!(wr_u32(
                    &mut want,
                    o + SM::WALLS_COMMITTED,
                    c.walls_committed
                ));
                assert!(wr_u32(&mut want, o + SM::SHIELD_UNTIL_BELL, 0));
                if c.clear_tier_next {
                    want[o + SM::TIER_NEXT] = SM::NO_TIER_NEXT;
                    assert!(wr_u32(&mut want, o + SM::TIER_NEXT_BELL, 0));
                }
                if c.credited && (captor as usize) < P::FACTIONS {
                    assert!(wr_u16(
                        &mut want,
                        P::captures_by(captor as usize),
                        count.saturating_add(1)
                    ));
                }
                quiet = true;
                seen[4] += 1;
            }
            let n = t.record;
            Record {
                kind: n.kind,
                faction: n.faction,
                flags: n.flags,
                progress: n.progress,
                required: n.required,
                target: n.target,
                vigil_start: n.vigil_start,
                vigil_next: n.vigil_next,
                vigil_from_day: n.vigil_from_day,
                bell: n.bell,
                actor: if t.retain_actor { r.actor } else { 0 },
                src: if t.retain_source { r.src } else { 0 },
            }
            .write(&mut want, 0)
            .unwrap();
            changed = true;
            match t.event {
                None => seen[1] += 1,
                Some((code, faction, progress)) => {
                    events.push(ev(code, faction, progress));
                    match code & !event::DETAIL {
                        event::SIEGE_FAILED => seen[2] += 1,
                        event::OCCUPIED => seen[3] += 1,
                        event::CAPTURE_DUE => {}
                        _ => seen[5] += 1,
                    }
                }
            }
        } else {
            seen[0] += 1;
        }
        assert_eq!(legacy, want, "{case}: Province bytes");
        assert_eq!(out.events(), &events[..], "{case}");
        assert_eq!(out.changed, changed, "{case}");
        assert_eq!(out.quiet_inputs_changed, quiet, "{case}");
        assert_eq!(out.active, qm::active_count(&want).unwrap() > 0, "{case}");
        assert!(!out.roster_changed && out.keep_taken.is_none() && out.snapshot.is_none());
    }
    // every outcome of the rules is reached: none, progress, failure,
    // occupation, capture, occupation end, refusal
    assert!(seen.iter().all(|&n| n >= 200), "outcome coverage {seen:?}");
}
