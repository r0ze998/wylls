//! The 09 ↔ 10 connection on 10's one table of lots: a job's ore from
//! another owner's lot under a use order, once per deposit id, whole
//! units, atomic; replays, restarts, capacity shortage, failures after 10
//! accepted, 10's refusals, ore only, the release rules, random runs.

mod common;
use common::*;

use permutation_rules::fixed::MILLI;
use permutation_rules::frontier::arms::ARMS;
use permutation_rules::frontier::holding::{Resource, HOUR};
use wylls_capacity::custody::Custody;
use wylls_capacity::ledger::{Op, Outcome};
use wylls_capacity::model::{GrantId, JobId, Place};
use wylls_capacity::testkit::*;
use wylls_capacity::CapError;
use wylls_capacity_bridge10::*;
use wylls_custody::CustodyError;

#[test]
fn lot_ore_feeds_a_job_once_in_whole_units() {
    let mut x = fx(Release::ToUser, 60);
    let j = x.job;
    assert!(matches!(
        ore(&mut x, T0 + 20, j, 1, 40),
        Ok(Outcome::Applied(_))
    ));
    wood(&mut x, T0 + 20, j, 2, 20).unwrap();
    let l = m_lot(&x);
    assert_eq!(
        (l.held, l.consumed, l.orders[0].qty_left),
        (60 * MILLI, 40 * MILLI, 20 * MILLI)
    );
    assert_eq!(x.b.cap.job(j).unwrap().hopper, [40 * MILLI, 20 * MILLI]);
    for t in [S + 7, S + 1_801, S + 5_000, S + 9_001, S + 3 * HOUR] {
        x.b.apply(t, X, &Op::Settle { job: j }).unwrap();
        assert_eq!(m_lot(&x).consumed, 40 * MILLI, "10 untouched at {}", t - S);
        x.b.check().unwrap();
    }
    x.b.apply(S + 3 * HOUR, B, &Op::Claim { job: j, to: HOME })
        .unwrap();
    assert_eq!(x.b.cap.custody.balance(HOME, ARMS), (Some(B), 20 * MILLI));
    x.b.check().unwrap();
}

#[test]
fn a_resent_order_consumes_once() {
    let mut x = fx(Release::Decided, 60);
    let j = x.job;
    ore(&mut x, T0 + 20, j, 1, 40).unwrap();
    let after = m_lot(&x);
    assert_eq!(ore(&mut x, T0 + 30, j, 1, 40), Ok(Outcome::AlreadyApplied));
    assert_eq!(ore(&mut x, S + HOUR, j, 1, 40), Ok(Outcome::AlreadyApplied));
    x.b = Bridge::load(&x.b.save()).unwrap();
    assert_eq!(ore(&mut x, S + HOUR, j, 1, 40), Ok(Outcome::AlreadyApplied));
    assert_eq!(m_lot(&x), after);
    assert_eq!(ore(&mut x, S + HOUR, j, 1, 30), Err(BridgeError::Conflict));
    assert_eq!(m_lot(&x), after);
    x.b.check().unwrap();
}

#[test]
fn an_id_used_by_an_own_deposit_is_not_reused_for_a_lot() {
    let mut x = fx(Release::Decided, 60);
    let j = x.job;
    wood(&mut x, T0 + 20, j, 100, 20).unwrap();
    let before = m_lot(&x);
    assert_eq!(
        ore(&mut x, T0 + 30, j, 100, 10),
        Err(BridgeError::Capacity(CapError::Conflict))
    );
    assert_eq!(m_lot(&x), before, "10 not consumed");
    x.b.check().unwrap();
}

#[test]
fn a_restart_mid_processing_changes_nothing() {
    let run = |restart_at: Option<i64>| {
        let mut x = fx(Release::Decided, 60);
        let j = x.job;
        ore(&mut x, T0 + 20, j, 1, 40).unwrap();
        wood(&mut x, T0 + 20, j, 2, 20).unwrap();
        for t in [S + HOUR, S + 2 * HOUR + 17, S + 3 * HOUR] {
            if restart_at == Some(t) {
                x.b = Bridge::load(&x.b.save()).unwrap();
            }
            x.b.apply(t, X, &Op::Settle { job: j }).unwrap();
        }
        x.b.apply(S + 3 * HOUR, B, &Op::Claim { job: j, to: HOME })
            .unwrap();
        x.b
    };
    let once = run(None);
    for t in [S + HOUR, S + 2 * HOUR + 17, S + 3 * HOUR] {
        assert_eq!(run(Some(t)), once, "restart at {}", t - S);
    }
    assert_eq!(Bridge::load(&once.save()).unwrap(), once);
}

#[test]
fn capacity_shortage_touches_no_lot() {
    let mut x = fx(Release::Decided, 60);
    let before = m_lot(&x);
    let jc = JobId {
        grant: GrantId {
            facility: x.g.facility,
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
    let missing = JobId { grant: x.g, seq: 2 };
    assert_eq!(
        ore(&mut x, T0 + 21, missing, 1, 10),
        Err(BridgeError::Capacity(CapError::UnknownJob))
    );
    assert_eq!(m_lot(&x), before);
    x.b.check().unwrap();
}

#[test]
fn a_failure_after_10_accepted_rolls_back() {
    let mut x = fx(Release::Decided, 60);
    let j = x.job;
    let before = x.b.clone();
    assert_eq!(
        ore(&mut x, S + 1, j, 1, 10),
        Err(BridgeError::Capacity(CapError::AlreadyStarted))
    );
    assert_eq!(x.b, before, "10 accepted, 09 refused: both as before");
    let mut y = fx(Release::Decided, 60);
    let j = y.job;
    for d in 1..=8u64 {
        ore(&mut y, T0 + 20, j, d, 1).unwrap();
    }
    let before = m_lot(&y);
    assert_eq!(
        ore(&mut y, T0 + 21, j, 9, 1),
        Err(BridgeError::Capacity(CapError::TooMany))
    );
    assert_eq!(m_lot(&y), before);
    assert_eq!(m_lot(&y).consumed, 8 * MILLI);
    let j2 = reserve(&mut y.b, y.g, 2, S + 4 * HOUR);
    ore(&mut y, T0 + 4 * HOUR + 30, j2, 1, 8).unwrap();
    assert_eq!(m_lot(&y).consumed, 16 * MILLI);
    y.b.check().unwrap();
}

#[test]
fn custody_refusals_leave_capacity_untouched() {
    type Step = Box<dyn Fn(&mut Fx) -> Result<Outcome, BridgeError>>;
    let cases: Vec<(&str, Step, BridgeError)> = vec![
        (
            "more than the order",
            Box::new(|x| {
                let j = x.job;
                ore(x, T0 + 20, j, 1, 61)
            }),
            BridgeError::Custody(CustodyError::Insufficient),
        ),
        (
            "another order id",
            Box::new(|x| {
                let j = x.job;
                x.b.deposit_from_lot(T0 + 20, B, j, 1, VM, M, 0, 99, 1)
            }),
            BridgeError::Custody(CustodyError::Order),
        ),
        (
            "not the grantee",
            Box::new(|x| {
                let jc = JobId {
                    grant: GrantId {
                        facility: x.g.facility,
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
                let o = x.order;
                x.b.deposit_from_lot(T0 + 20, C, jc, 1, VM, M, 0, o, 1)
            }),
            BridgeError::Custody(CustodyError::NotAuthorized),
        ),
        (
            "after the order expired",
            Box::new(|x| {
                let late = T0 + 600 * 600;
                let j2 = reserve(&mut x.b, x.g, 2, late + HOUR);
                let o = x.order;
                x.b.deposit_from_lot(late, B, j2, 1, VM, M, 0, o, 1)
            }),
            BridgeError::Custody(CustodyError::Expired),
        ),
        (
            "the vault was seized",
            Box::new(|x| {
                x.b.cap.custody.seize_vault(VM, X).unwrap();
                let j = x.job;
                ore(x, T0 + 20, j, 1, 10)
            }),
            BridgeError::Custody(CustodyError::Forfeited),
        ),
    ];
    for (name, f, want) in cases {
        let mut x = fx(Release::Decided, 60);
        let r = f(&mut x);
        assert_eq!(r, Err(want), "{name}");
        assert_eq!(x.b.cap.job(x.job).unwrap().hopper, [0, 0], "{name}");
        assert!(!x.b.lot_fed(x.job), "{name}");
    }
}

#[test]
fn only_ore_lots_exist() {
    // 10 enables ore only; not widened here.
    let mut x = fx(Release::Decided, 60);
    for r in [Resource::Wood, ARMS] {
        assert!(
            x.b.cap.custody.open_lot(VM, V, M, r, 10 * MILLI).is_err(),
            "{r:?}"
        );
    }
}

#[test]
fn hold_and_to_user_remain_comparison_rules() {
    let mut x = fx(Release::Hold, 60);
    let j = x.job;
    ore(&mut x, T0 + 20, j, 1, 40).unwrap();
    wood(&mut x, T0 + 20, j, 2, 20).unwrap();
    x.b.apply(S + 3 * HOUR, X, &Op::Settle { job: j }).unwrap();
    assert_eq!(
        x.b.apply(S + 3 * HOUR, B, &Op::Claim { job: j, to: HOME }),
        Err(BridgeError::OwnershipUndecided)
    );
    x.b.release = Release::ToUser;
    x.b.apply(S + 3 * HOUR, B, &Op::Claim { job: j, to: HOME })
        .unwrap();
    assert_eq!(x.b.cap.custody.balance(HOME, ARMS).1, 20 * MILLI);
    x.b.check().unwrap();
}

#[test]
fn random_runs_never_consume_twice() {
    struct Rng(u64);
    impl Rng {
        fn below(&mut self, n: u64) -> u64 {
            self.0 ^= self.0 << 13;
            self.0 ^= self.0 >> 7;
            self.0 ^= self.0 << 17;
            self.0 % n.max(1)
        }
    }
    let (mut applied, mut replays, mut claims, mut returned) = (0, 0, 0, 0i64);
    for (release, seed) in [Release::ToUser, Release::Decided]
        .into_iter()
        .flat_map(|r| (1..=200u64).map(move |s| (r, s)))
    {
        let mut rng = Rng(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1);
        let mut x = fx(release, 60);
        let mut now = T0 + 20;
        let mut done: Vec<(JobId, u64, u32)> = Vec::new();
        let mut next = 2u32;
        for _ in 0..60 {
            now += rng.below(1_200) as i64;
            let job = JobId {
                grant: x.g,
                seq: 1 + rng.below(next as u64) as u32,
            };
            match rng.below(7) {
                0 => {
                    let start = now + 60 + rng.below(4 * HOUR as u64) as i64;
                    let j = JobId {
                        grant: x.g,
                        seq: next,
                    };
                    let op = Op::Reserve {
                        job: j,
                        units: 1,
                        start,
                        end: start + HOUR,
                        max_output: 4 * MILLI,
                    };
                    if x.b.apply(now, B, &op).is_ok() {
                        next += 1;
                    }
                }
                1 | 2 => {
                    let (d, u) = (1 + rng.below(4), 1 + rng.below(12) as u32);
                    if let Ok(Outcome::Applied(_)) = ore(&mut x, now, job, d, u) {
                        applied += 1;
                        done.push((job, d, u));
                    }
                }
                3 => {
                    if !done.is_empty() {
                        let (j, d, u) = done[rng.below(done.len() as u64) as usize];
                        let before = m_lot(&x);
                        assert_eq!(ore(&mut x, now, j, d, u), Ok(Outcome::AlreadyApplied));
                        assert_eq!(m_lot(&x), before);
                        replays += 1;
                    }
                }
                4 => {
                    let _ = x.b.apply(now, X, &Op::Settle { job });
                }
                5 => {
                    let op = if rng.below(2) == 0 {
                        Op::Cancel { job }
                    } else {
                        Op::Claim {
                            job,
                            to: Place::Caravan(9_000),
                        }
                    };
                    if let (Op::Claim { .. }, Ok(Outcome::Applied(_))) =
                        (&op, x.b.apply(now, B, &op))
                    {
                        claims += 1;
                    }
                }
                _ => x.b = Bridge::load(&x.b.save()).unwrap(),
            }
            x.b.check().unwrap();
            let taken: i64 = done.iter().map(|(_, _, u)| *u as i64 * MILLI).sum();
            assert_eq!(m_lot(&x).consumed, taken);
            assert!(taken <= 60 * MILLI, "within the use order");
        }
        returned += x.b.returned.values().sum::<i64>();
    }
    eprintln!("random: {applied} lot deposits, {replays} replays answered without 10, {claims} claims, {returned} milli returned to lots");
    assert!(
        applied > 600 && replays > 200 && claims > 100 && returned > 0,
        "{applied} {replays} {claims} {returned}"
    );
}
