//! Contract tests of the 09 ↔ 10 connection against 10's real kernel
//! (`wylls_custody`): order replays, a restart mid-processing, capacity
//! shortage, failures after 10 accepted, 10's refusals, ore only, the
//! release hold, cancel, seizure and capture, and random interleavings.

use permutation_rules::fixed::MILLI;
use permutation_rules::frontier::arms::ARMS;
use permutation_rules::frontier::holding::{Resource, HOUR};
use wylls_capacity::custody::Custody;
use wylls_capacity::ledger::{Op, Outcome};
use wylls_capacity::model::{Actor, FacilityId, GrantId, JobId, Place};
use wylls_capacity::policy::Policies;
use wylls_capacity::testkit::*;
use wylls_capacity::CapError;
use wylls_capacity_bridge10::*;
use wylls_custody::{
    begin_inbound, finish_inbound, open, set_order, CustodyError, OrderSpec, PlaceRef, VaultView,
    ORDER_USE,
};

/// The custodian of the vault and the lot's owner (neither is A, B or C).
const V: Actor = Actor::test(0xD4);
const M: Actor = Actor::test(0x4D);
const S: i64 = T0 + HOUR;

/// A refusal case: its name, the step, the expected error.
type Case = (
    &'static str,
    Box<dyn Fn(&mut Fx) -> Result<Outcome, BridgeError>>,
    BridgeError,
);

struct Fx {
    b: Bridge,
    f: FacilityId,
    job: JobId,
    lot: LotId,
    order: u32,
}

fn vault() -> VaultView {
    VaultView {
        p: 1,
        q: -1,
        tile: 5,
        gen: 1,
        live: true,
        owner: V.0,
        owner_tag: tag_of(V),
        stores: [0; 8],
        cap: 5_000 * MILLI,
        quota: [0; 8],
        lots: 0,
    }
}

/// A's facility (3 workshops, 2 lent), B's grant; M's lot of 100 ore in
/// V's vault with a use order of 60 for B (purpose: workshop arms); B's
/// job: 2 copies, 20 arms over [S, S + 3 h); 20 wood of B's own arrived.
fn fx(release: Release) -> Fx {
    let (w, f) = world(3, 2, 2, Policies::PROVISIONAL);
    let mut b = Bridge::new(w, T0);
    b.release = release;
    let bell = b.bell(T0);
    let mut v = vault();
    let mut lot = open(
        &mut v,
        &actor10(V),
        (M.0, tag_of(M)),
        Resource::Ore as u8,
        200 * MILLI,
        bell,
        [0; 32],
    )
    .unwrap();
    begin_inbound(&v, &mut lot, (tag_of(M), 1), 100 * MILLI).unwrap();
    finish_inbound(Some(&v), &mut lot, (tag_of(M), 1), 100 * MILLI).unwrap();
    let spec = OrderSpec {
        kind: ORDER_USE,
        grantee: B.0,
        qty: 60 * MILLI,
        expires_bell: bell + 500,
        dst: PlaceRef::default(),
        purpose: PURPOSE_WORKSHOP_ARMS,
    };
    let nonce = lot.nonce;
    let order = set_order(&v, &mut lot, &actor10(M), 0, nonce, &spec, bell).unwrap();
    let id = LotId::of(&lot);
    b.vaults.insert((v.p, v.q, v.tile), v);
    b.lots.insert(id, lot);
    let job = JobId {
        grant: GrantId {
            facility: f,
            seq: 1,
        },
        seq: 1,
    };
    b.apply(
        T0 + 10,
        B,
        &Op::Reserve {
            job,
            units: 2,
            start: S,
            end: S + 3 * HOUR,
            max_output: 20 * MILLI,
        },
    )
    .unwrap();
    arrived(&mut b.cap.custody, B, 77, 0, 20);
    Fx {
        b,
        f,
        job,
        lot: id,
        order,
    }
}

fn wood(x: &mut Fx, now: i64) {
    x.b.apply(
        now,
        B,
        &Op::Deposit {
            job: x.job,
            deposit: 100,
            resource: Resource::Wood,
            amount: 20 * MILLI,
            from: Place::Caravan(77),
        },
    )
    .unwrap();
}

fn ore(x: &mut Fx, now: i64, deposit: u64, units: u32) -> Result<Outcome, BridgeError> {
    let (job, lot, order) = (x.job, x.lot, x.order);
    x.b.deposit_from_lot(now, B, job, deposit, lot, 0, order, units)
}

fn lot(x: &Fx) -> wylls_custody::Lot {
    x.b.lots[&x.lot]
}

fn lot_bytes(x: &Fx) -> Vec<u8> {
    let mut d = vec![0u8; wylls_custody::layout::lot::SIZE];
    lot(x).encode(&mut d).unwrap();
    d
}

#[test]
fn lot_ore_feeds_a_job_once_in_whole_units() {
    let mut x = fx(Release::ToUser);
    assert!(matches!(
        ore(&mut x, T0 + 20, 1, 40),
        Ok(Outcome::Applied(_))
    ));
    wood(&mut x, T0 + 20);
    let l = lot(&x);
    assert_eq!(
        (l.held, l.consumed, l.orders[0].qty_left),
        (60 * MILLI, 40 * MILLI, 20 * MILLI)
    );
    assert_eq!(x.b.cap.job(x.job).unwrap().hopper, [40 * MILLI, 20 * MILLI]);
    // 09 settles in milli at odd times; 10 is never called again.
    for t in [S + 7, S + 1_801, S + 5_000, S + 9_001, S + 3 * HOUR] {
        x.b.apply(t, X, &Op::Settle { job: x.job }).unwrap();
        assert_eq!(lot(&x).consumed, 40 * MILLI, "at {}", t - S);
        x.b.check(t).unwrap();
    }
    assert_eq!(x.b.cap.custody.produced[ARMS as usize], 20 * MILLI);
    x.b.apply(
        S + 3 * HOUR,
        B,
        &Op::Claim {
            job: x.job,
            to: Place::Caravan(78),
        },
    )
    .unwrap();
    assert_eq!(
        x.b.cap.custody.balance(Place::Caravan(78), ARMS),
        (Some(B), 20 * MILLI)
    );
    x.b.check(S + 3 * HOUR).unwrap();
}

#[test]
fn a_resent_order_consumes_once() {
    let mut x = fx(Release::Hold);
    ore(&mut x, T0 + 20, 1, 40).unwrap();
    let after = (lot_bytes(&x), x.b.cap.clone());
    // The same deposit again: before the start, after it, after a restart.
    assert_eq!(ore(&mut x, T0 + 30, 1, 40), Ok(Outcome::AlreadyApplied));
    assert_eq!(ore(&mut x, S + HOUR, 1, 40), Ok(Outcome::AlreadyApplied));
    let mut y = Fx {
        b: Bridge::load(&x.b.save()).unwrap(),
        ..x
    };
    assert_eq!(ore(&mut y, S + HOUR, 1, 40), Ok(Outcome::AlreadyApplied));
    assert_eq!(lot_bytes(&y), after.0);
    // The same id with other terms is a conflict, and changes nothing.
    assert_eq!(ore(&mut y, S + HOUR, 1, 30), Err(BridgeError::Conflict));
    assert_eq!(lot_bytes(&y), after.0);
    // An id already used by an own-goods deposit cannot be reused for a lot.
    wood(&mut y, T0 + 40);
    let before = lot_bytes(&y);
    // (09's Deposit reports it: the id holds other terms.)
    assert_eq!(
        ore(&mut y, T0 + 50, 100, 10),
        Err(BridgeError::Capacity(CapError::Conflict))
    );
    assert_eq!(lot_bytes(&y), before, "10 not consumed");
    y.b.check(T0 + 50).unwrap();
}

#[test]
fn a_restart_mid_processing_changes_nothing() {
    let run = |restart_at: Option<i64>| {
        let mut x = fx(Release::ToUser);
        ore(&mut x, T0 + 20, 1, 40).unwrap();
        wood(&mut x, T0 + 20);
        for t in [S + HOUR, S + 2 * HOUR + 17, S + 3 * HOUR] {
            if restart_at == Some(t) {
                x.b = Bridge::load(&x.b.save()).unwrap();
            }
            x.b.apply(t, X, &Op::Settle { job: x.job }).unwrap();
        }
        x.b.apply(
            S + 3 * HOUR,
            B,
            &Op::Claim {
                job: x.job,
                to: Place::Caravan(78),
            },
        )
        .unwrap();
        x
    };
    let once = run(None);
    for t in [S + HOUR, S + 2 * HOUR + 17, S + 3 * HOUR] {
        let x = run(Some(t));
        assert_eq!(x.b, once.b, "restart at {}", t - S);
    }
    // 10's lot survives its own byte layout unchanged.
    let back = Bridge::load(&once.b.save()).unwrap();
    assert_eq!(back, once.b);
    assert_eq!(lot(&once).consumed, 40 * MILLI);
    assert_eq!(once.b.cap.custody.produced[ARMS as usize], 20 * MILLI);
}

#[test]
fn capacity_shortage_touches_no_lot() {
    let mut x = fx(Release::Hold);
    let before = lot_bytes(&x);
    // 2 lent copies are held by B's job: C cannot reserve any for those hours.
    let jc = JobId {
        grant: GrantId {
            facility: x.f,
            seq: 2,
        },
        seq: 1,
    };
    let op = Op::Reserve {
        job: jc,
        units: 1,
        start: S,
        end: S + HOUR,
        max_output: MILLI,
    };
    assert_eq!(
        x.b.apply(T0 + 20, C, &op),
        Err(BridgeError::Capacity(CapError::CapacityExceeded))
    );
    // A deposit to the job that was refused consumes nothing.
    let lot_id = x.lot;
    let order = x.order;
    assert_eq!(
        x.b.deposit_from_lot(
            T0 + 21,
            B,
            JobId {
                grant: x.job.grant,
                seq: 2
            },
            1,
            lot_id,
            0,
            order,
            10
        ),
        Err(BridgeError::Capacity(CapError::UnknownJob))
    );
    assert_eq!(lot_bytes(&x), before);
    x.b.check(T0 + 21).unwrap();
}

#[test]
fn a_failure_after_10_accepted_rolls_back() {
    // The job has started: 10 would accept, 09 refuses; nothing changes.
    let mut x = fx(Release::Hold);
    let before = (lot_bytes(&x), x.b.cap.clone());
    assert_eq!(
        ore(&mut x, S + 1, 1, 10),
        Err(BridgeError::Capacity(CapError::AlreadyStarted))
    );
    assert_eq!((lot_bytes(&x), x.b.cap.clone()), before);
    // The deposit table is full: the ninth deposit is refused whole.
    let mut y = fx(Release::Hold);
    for d in 1..=8u64 {
        ore(&mut y, T0 + 20, d, 1).unwrap();
    }
    let before = lot_bytes(&y);
    assert_eq!(
        ore(&mut y, T0 + 21, 9, 1),
        Err(BridgeError::Capacity(CapError::TooMany))
    );
    assert_eq!(lot_bytes(&y), before);
    assert_eq!(lot(&y).consumed, 8 * MILLI);
    y.b.check(T0 + 21).unwrap();
    // A later valid deposit (another job) consumes exactly its own units.
    let j2 = JobId {
        grant: y.job.grant,
        seq: 2,
    };
    y.b.apply(
        T0 + 22,
        B,
        &Op::Reserve {
            job: j2,
            units: 1,
            start: S + 4 * HOUR,
            end: S + 5 * HOUR,
            max_output: 4 * MILLI,
        },
    )
    .unwrap();
    let (l, o) = (y.lot, y.order);
    y.b.deposit_from_lot(T0 + 23, B, j2, 1, l, 0, o, 8).unwrap();
    assert_eq!(lot(&y).consumed, 16 * MILLI);
    y.b.check(T0 + 23).unwrap();
}

#[test]
fn custody_refusals_leave_capacity_untouched() {
    let cases: Vec<Case> = vec![
        (
            "more than the order",
            Box::new(|x| ore(x, T0 + 20, 1, 61)),
            BridgeError::Custody(CustodyError::Insufficient),
        ),
        (
            "after the order expired",
            Box::new(|x| {
                let late = T0 + 600 * 600;
                let j = x.job;
                x.b.apply(
                    late,
                    B,
                    &Op::Reserve {
                        job: JobId {
                            grant: j.grant,
                            seq: 2,
                        },
                        units: 1,
                        start: late + HOUR,
                        end: late + 2 * HOUR,
                        max_output: MILLI,
                    },
                )
                .unwrap();
                let (l, o) = (x.lot, x.order);
                x.b.deposit_from_lot(
                    late,
                    B,
                    JobId {
                        grant: j.grant,
                        seq: 2,
                    },
                    1,
                    l,
                    0,
                    o,
                    1,
                )
            }),
            BridgeError::Custody(CustodyError::Expired),
        ),
        (
            "another order id",
            Box::new(|x| {
                let (j, l) = (x.job, x.lot);
                x.b.deposit_from_lot(T0 + 20, B, j, 1, l, 0, 99, 1)
            }),
            BridgeError::Custody(CustodyError::Order),
        ),
        (
            "not the grantee",
            Box::new(|x| {
                // C's own job, under B's order.
                let jc = JobId {
                    grant: GrantId {
                        facility: x.f,
                        seq: 2,
                    },
                    seq: 1,
                };
                x.b.apply(
                    T0 + 15,
                    C,
                    &Op::Reserve {
                        job: jc,
                        units: 1,
                        start: S + 4 * HOUR,
                        end: S + 5 * HOUR,
                        max_output: MILLI,
                    },
                )
                .unwrap();
                let (l, o) = (x.lot, x.order);
                x.b.deposit_from_lot(T0 + 20, C, jc, 1, l, 0, o, 1)
            }),
            BridgeError::Custody(CustodyError::NotAuthorized),
        ),
        (
            "the vault was seized",
            Box::new(|x| {
                x.b.vaults.get_mut(&(1, -1, 5)).unwrap().gen = 2;
                ore(x, T0 + 20, 1, 10)
            }),
            BridgeError::Custody(CustodyError::Forfeited),
        ),
    ];
    for (name, f, want) in cases {
        let mut x = fx(Release::Hold);
        let lot_before = lot_bytes(&x);
        let r = f(&mut x);
        assert_eq!(r, Err(want), "{name}");
        assert_eq!(lot_bytes(&x), lot_before, "{name}: lot");
        assert!(
            x.b.cap.job(x.job).unwrap().hopper == [0, 0],
            "{name}: hopper"
        );
        assert!(x.b.links.is_empty(), "{name}");
    }
}

#[test]
fn a_purpose_of_another_kind_is_refused() {
    // M's order names another purpose: 10 refuses the workshop's.
    let mut x = fx(Release::Hold);
    let bell = x.b.bell(T0);
    let v = x.b.vaults[&(1, -1, 5)];
    let l = x.b.lots.get_mut(&x.lot).unwrap();
    let spec = OrderSpec {
        kind: ORDER_USE,
        grantee: B.0,
        qty: 10 * MILLI,
        expires_bell: bell + 50,
        dst: PlaceRef::default(),
        purpose: 0x0777,
    };
    let nonce = l.nonce;
    let other = set_order(&v, l, &actor10(M), 1, nonce, &spec, bell).unwrap();
    let (j, id) = (x.job, x.lot);
    assert_eq!(
        x.b.deposit_from_lot(T0 + 20, B, j, 1, id, 1, other, 5),
        Err(BridgeError::Custody(CustodyError::Order))
    );
}

#[test]
fn only_ore_comes_from_lots() {
    // 10 enables ore only: a wood lot cannot exist; wood is B's own deposit.
    let mut v = vault();
    assert_eq!(
        open(
            &mut v,
            &actor10(V),
            (M.0, tag_of(M)),
            Resource::Wood as u8,
            10 * MILLI,
            0,
            [0; 32]
        )
        .err(),
        Some(CustodyError::Resource)
    );
    assert_eq!(
        open(
            &mut v,
            &actor10(V),
            (M.0, tag_of(M)),
            ARMS as u8,
            10 * MILLI,
            0,
            [0; 32]
        )
        .err(),
        Some(CustodyError::Resource)
    );
}

#[test]
fn goods_from_a_lot_are_held_until_ownership_is_decided() {
    let mut x = fx(Release::Hold);
    ore(&mut x, T0 + 20, 1, 40).unwrap();
    wood(&mut x, T0 + 20);
    x.b.apply(S + 3 * HOUR, X, &Op::Settle { job: x.job })
        .unwrap();
    let claim = Op::Claim {
        job: x.job,
        to: Place::Caravan(78),
    };
    assert_eq!(
        x.b.apply(S + 3 * HOUR, B, &claim),
        Err(BridgeError::OwnershipUndecided)
    );
    // The arms stay in the job's output place; nothing moved, nothing lost.
    assert_eq!(
        x.b.cap.custody.balance(Place::Output(x.job), ARMS).1,
        20 * MILLI
    );
    x.b.check(S + 3 * HOUR).unwrap();
    // A job of B's own materials is not held.
    let j2 = JobId {
        grant: x.job.grant,
        seq: 2,
    };
    x.b.apply(
        S + 3 * HOUR,
        B,
        &Op::Reserve {
            job: j2,
            units: 1,
            start: S + 4 * HOUR,
            end: S + 5 * HOUR,
            max_output: 4 * MILLI,
        },
    )
    .unwrap();
    arrived(&mut x.b.cap.custody, B, 79, 8, 4);
    for (n, r, a) in [(1, Resource::Ore, 8), (2, Resource::Wood, 4)] {
        x.b.apply(
            S + 3 * HOUR,
            B,
            &Op::Deposit {
                job: j2,
                deposit: n,
                resource: r,
                amount: a * MILLI,
                from: Place::Caravan(79),
            },
        )
        .unwrap();
    }
    x.b.apply(
        S + 6 * HOUR,
        B,
        &Op::Claim {
            job: j2,
            to: Place::Caravan(80),
        },
    )
    .unwrap();
    assert_eq!(
        x.b.cap.custody.balance(Place::Caravan(80), ARMS).1,
        4 * MILLI
    );
}

#[test]
fn a_cancel_mid_run_keeps_the_rest_in_the_job() {
    // 10 has no way back into a lot: unused lot ore stays in the job (held),
    // never returned to the lot twice nor lost.
    let mut x = fx(Release::Hold);
    ore(&mut x, T0 + 20, 1, 40).unwrap();
    wood(&mut x, T0 + 20);
    x.b.apply(S + HOUR, B, &Op::Cancel { job: x.job }).unwrap();
    assert_eq!(
        x.b.cap
            .custody
            .balance(Place::Hopper(x.job), Resource::Ore)
            .1,
        24 * MILLI
    );
    assert_eq!(lot(&x).consumed, 40 * MILLI);
    assert_eq!(lot(&x).held, 60 * MILLI);
    x.b.check(S + HOUR).unwrap();
}

#[test]
fn a_facility_capture_runs_09s_provisional_loss_rule_unchanged() {
    // Seizure rules are open on both sides; the bridge adds none. 09's
    // provisional rule (captor takes what is at the facility) runs as it
    // does for own materials; 10's lot is not touched.
    let mut x = fx(Release::Hold);
    ore(&mut x, T0 + 20, 1, 40).unwrap();
    wood(&mut x, T0 + 20);
    let cap_t = S + HOUR;
    x.b.cap
        .facilities
        .get_mut(&SITE_A)
        .unwrap()
        .capture(cap_t, X)
        .unwrap();
    let f = x.f;
    x.b.apply(cap_t, X, &Op::FacilityLost { facility: f })
        .unwrap();
    assert_eq!(
        x.b.cap.custody.balance(Place::Holding(SITE_A), ARMS),
        (Some(X), 8 * MILLI)
    );
    assert_eq!(lot(&x).consumed, 40 * MILLI);
    x.b.check(cap_t).unwrap();
}

#[test]
fn random_interleavings_never_consume_twice() {
    struct Rng(u64);
    impl Rng {
        fn below(&mut self, n: u64) -> u64 {
            self.0 ^= self.0 << 13;
            self.0 ^= self.0 >> 7;
            self.0 ^= self.0 << 17;
            self.0 % n.max(1)
        }
    }
    let mut applied = 0;
    let mut replays = 0;
    for seed in 1..=200u64 {
        let mut rng = Rng(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1);
        let mut x = fx(Release::ToUser);
        let mut now = T0 + 20;
        let mut done: Vec<(JobId, u64, u32)> = Vec::new();
        let mut next_job = 2u32;
        for _ in 0..60 {
            now += rng.below(1_200) as i64;
            match rng.below(6) {
                0 => {
                    let start = now + 60 + rng.below(4 * HOUR as u64) as i64;
                    let j = JobId {
                        grant: x.job.grant,
                        seq: next_job,
                    };
                    if x.b
                        .apply(
                            now,
                            B,
                            &Op::Reserve {
                                job: j,
                                units: 1,
                                start,
                                end: start + HOUR,
                                max_output: 4 * MILLI,
                            },
                        )
                        .is_ok()
                    {
                        next_job += 1;
                    }
                }
                1 | 2 => {
                    let seq = 1 + rng.below(next_job as u64) as u32;
                    let j = JobId {
                        grant: x.job.grant,
                        seq,
                    };
                    let d = 1 + rng.below(4);
                    let units = 1 + rng.below(12) as u32;
                    let (l, o) = (x.lot, x.order);
                    if let Ok(Outcome::Applied(_)) =
                        x.b.deposit_from_lot(now, B, j, d, l, 0, o, units)
                    {
                        applied += 1;
                        done.push((j, d, units));
                    }
                }
                3 => {
                    if !done.is_empty() {
                        let (j, d, u) = done[rng.below(done.len() as u64) as usize];
                        let (l, o) = (x.lot, x.order);
                        let before = lot_bytes(&x);
                        let r = x.b.deposit_from_lot(now, B, j, d, l, 0, o, u);
                        assert_eq!(r, Ok(Outcome::AlreadyApplied));
                        assert_eq!(lot_bytes(&x), before);
                        replays += 1;
                    }
                }
                4 => {
                    let seq = 1 + rng.below(next_job as u64) as u32;
                    let _ = x.b.apply(
                        now,
                        X,
                        &Op::Settle {
                            job: JobId {
                                grant: x.job.grant,
                                seq,
                            },
                        },
                    );
                }
                _ => x.b = Bridge::load(&x.b.save()).unwrap(),
            }
            x.b.check(now).unwrap();
            let taken: i64 = done.iter().map(|(_, _, u)| *u as i64 * MILLI).sum();
            assert_eq!(lot(&x).consumed, taken);
            assert!(lot(&x).consumed <= 60 * MILLI, "within the use order");
        }
    }
    eprintln!("random: {applied} lot deposits applied, {replays} replays answered without 10");
    assert!(
        applied > 300 && replays > 100,
        "applied {applied}, replays {replays}"
    );
}
