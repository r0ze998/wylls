//! Another owner's lot feeding a job under a use order, on the same lot
//! store as the user's own lots: ⑨'s bridge contract (992f4ba5) on the
//! adapter. Replays, restarts, failures after ⑩ accepted, ⑩'s refusals,
//! the release hold, own and others' ore in one job, and random runs.

mod common;

use common::*;
use permutation_rules::frontier::arms::ARMS;
use permutation_rules::frontier::holding::{Resource, HOUR};
use wylls_capacity::custody::Custody;
use wylls_capacity::ledger::{Op, Outcome};
use wylls_capacity::model::{Actor, JobId, Place};
use wylls_capacity::policy::Policies;
use wylls_capacity::testkit::{B, C, T0, X};
use wylls_capacity::CapError;
use wylls_custody::lot::CustodyError as LotError;
use wylls_custody_adapter_09::connect::*;
use wylls_custody_adapter_09::{Note, Refusal, Why};

/// The owner of the lot B uses (not A, B, C or the keeper).
const M: Actor = Actor::test(0x4D);
const ORE: u8 = Resource::Ore as u8;

struct Fx {
    c: Connected,
    j: JobId,
    order: u32,
}

/// ⑨'s world over the adapter; M's lot of 40 ore (the vault's CAP 100
/// is then fully committed: B 30, C 30, M 40) in V with a use order of
/// 40 for B (workshop arms, until bell 1,000); B's job of 20 arms over
/// [S, S + 3 h) (needs 40 ore, 20 wood); 20 wood of B's own arrived.
fn fx(release: Release) -> Fx {
    let (mut w, f) = world(Policies::PROVISIONAL);
    w.custody.open_lot(V, K, M, Resource::Ore, u(40)).unwrap();
    w.custody
        .try_import(arrival(10), Place::Vault(V), M, Resource::Ore, u(40))
        .unwrap();
    let order = w
        .custody
        .set_use_order(V, M, B, 0, u(40), 1_000, PURPOSE_WORKSHOP_ARMS, 0)
        .unwrap();
    caravan(&mut w, B, 77, Resource::Wood, 20);
    w.custody.take_notes();
    let mut c = Connected::new(w, T0);
    c.release = release;
    let j = job(f, 1, 1);
    c.apply(
        T0 + 10,
        B,
        &Op::Reserve {
            job: j,
            units: 2,
            start: S,
            end: S + 3 * HOUR,
            max_output: u(20),
        },
    )
    .unwrap();
    Fx { c, j, order }
}

fn ck(c: &Connected) {
    c.w.custody.check().unwrap();
}

fn wood(c: &mut Connected, j: JobId, n: u64) -> Result<Outcome, ConnError> {
    c.apply(
        T0 + 20,
        B,
        &Op::Deposit {
            job: j,
            deposit: n,
            resource: Resource::Wood,
            amount: u(20),
            from: Place::Caravan(77),
        },
    )
}

fn lot(c: &Connected, owner: Actor) -> wylls_custody::lot::Lot {
    c.w.custody.lot(V, owner, ORE).unwrap()
}

#[test]
fn another_owners_lot_feeds_the_job_once_in_whole_units() {
    let mut x = fx(Release::Hold);
    let (j, o) = (x.j, x.order);
    x.c.deposit_from_lot(T0 + 20, B, j, 1, V, M, 0, o, 40)
        .unwrap();
    wood(&mut x.c, j, 2).unwrap();
    ck(&x.c);
    let l = lot(&x.c, M);
    assert_eq!((l.held, l.consumed, l.orders[0].qty_left), (0, u(40), 0));
    assert_eq!(
        x.c.w.custody.balance(Place::Hopper(j), Resource::Ore).1,
        u(40)
    );
    // Five settlements at odd times: ⑩ is never called again.
    let before = bytes(&lot(&x.c, M).held);
    for t in [
        S + 7,
        S + 1_111,
        S + HOUR + 3,
        S + 2 * HOUR + 59,
        S + 3 * HOUR,
    ] {
        x.c.apply(t, X, &Op::Settle { job: j }).unwrap();
        ck(&x.c);
    }
    assert_eq!(bytes(&lot(&x.c, M).held), before);
    assert_eq!(lot(&x.c, M).consumed, u(40));
    assert_eq!(x.c.w.custody.balance(Place::Output(j), ARMS).1, u(20));
    let notes = x.c.w.custody.take_notes();
    assert_eq!(
        notes
            .iter()
            .filter(|n| matches!(n, Note::Used { .. }))
            .count(),
        1
    );
}

#[test]
fn a_replayed_deposit_calls_ten_no_more() {
    let mut x = fx(Release::Hold);
    let (j, o) = (x.j, x.order);
    x.c.deposit_from_lot(T0 + 20, B, j, 1, V, M, 0, o, 30)
        .unwrap();
    let lot_bytes = x.c.w.custody.lots.clone();
    for now in [T0 + 21, S + 10] {
        assert_eq!(
            x.c.deposit_from_lot(now, B, j, 1, V, M, 0, o, 30),
            Ok(Outcome::AlreadyApplied)
        );
    }
    x.c = restart_c(&x.c);
    assert_eq!(
        x.c.deposit_from_lot(S + 20, B, j, 1, V, M, 0, o, 30),
        Ok(Outcome::AlreadyApplied)
    );
    assert_eq!(x.c.w.custody.lots, lot_bytes);
    // The same id with other terms.
    assert_eq!(
        x.c.deposit_from_lot(S + 20, B, j, 1, V, M, 0, o, 10),
        Err(ConnError::Conflict)
    );
    assert_eq!(x.c.w.custody.lots, lot_bytes);
    // An id B used for its own wood cannot be reused for the lot.
    let mut y = fx(Release::Hold);
    wood(&mut y.c, y.j, 1).unwrap();
    let before = y.c.w.custody.lots.clone();
    assert_eq!(
        y.c.deposit_from_lot(T0 + 30, B, y.j, 1, V, M, 0, y.order, 10),
        Err(ConnError::Capacity(CapError::Conflict))
    );
    assert_eq!(y.c.w.custody.lots, before);
    ck(&y.c);
}

fn restart_c(c: &Connected) -> Connected {
    use borsh::BorshDeserialize;
    Connected::try_from_slice(&borsh::to_vec(c).unwrap()).unwrap()
}

#[test]
fn a_refusal_by_nine_after_ten_accepted_restores_both() {
    // The job has started: ⑩ would consume, ⑨ refuses the deposit.
    let mut x = fx(Release::Hold);
    let before = x.c.clone();
    assert_eq!(
        x.c.deposit_from_lot(S + 1, B, x.j, 1, V, M, 0, x.order, 10),
        Err(ConnError::Capacity(CapError::AlreadyStarted))
    );
    assert_eq!(x.c, before);
    // The deposit table is full (8): the ninth is refused whole.
    let mut y = fx(Release::Hold);
    for n in 1..=8 {
        y.c.deposit_from_lot(T0 + 20, B, y.j, n, V, M, 0, y.order, 1)
            .unwrap();
    }
    let before = y.c.clone();
    assert_eq!(
        y.c.deposit_from_lot(T0 + 20, B, y.j, 9, V, M, 0, y.order, 1),
        Err(ConnError::Capacity(CapError::TooMany))
    );
    assert_eq!(y.c, before);
    assert_eq!(lot(&y.c, M).consumed, u(8));
    ck(&y.c);
}

#[test]
fn tens_refusals_leave_both_unchanged() {
    type Step = fn(&mut Fx) -> Result<Outcome, ConnError>;
    let cases: [(&str, Step, ConnError); 6] = [
        (
            "more than the order",
            |x| {
                x.c.deposit_from_lot(T0 + 20, B, x.j, 1, V, M, 0, x.order, 41)
            },
            ConnError::Custody(Refusal::Lot(LotError::Insufficient)),
        ),
        (
            "an expired order",
            |x| {
                x.c.deposit_from_lot(T0 + 1_000 * 600, B, x.j, 1, V, M, 0, x.order, 1)
            },
            ConnError::Custody(Refusal::Lot(LotError::Expired)),
        ),
        (
            "another order id",
            |x| {
                x.c.deposit_from_lot(T0 + 20, B, x.j, 1, V, M, 0, x.order + 1, 1)
            },
            ConnError::Custody(Refusal::Lot(LotError::Order)),
        ),
        (
            "not the grantee (C's job)",
            |x| {
                let k = job(x.j.grant.facility, 2, 1);
                x.c.apply(
                    T0 + 20,
                    C,
                    &Op::Reserve {
                        job: k,
                        units: 1,
                        start: S + 4 * HOUR,
                        end: S + 5 * HOUR,
                        max_output: u(1),
                    },
                )?;
                x.c.deposit_from_lot(T0 + 21, C, k, 1, V, M, 0, x.order, 1)
            },
            ConnError::Custody(Refusal::Lot(LotError::NotAuthorized)),
        ),
        (
            "a seized vault",
            |x| {
                x.c.w.custody.seize_vault(V, X).unwrap();
                x.c.deposit_from_lot(T0 + 20, B, x.j, 1, V, M, 0, x.order, 1)
            },
            ConnError::Custody(Refusal::Lot(LotError::Forfeited)),
        ),
        (
            "the owner's own lot through an order",
            |x| {
                x.c.deposit_from_lot(T0 + 20, B, x.j, 1, V, B, 0, x.order, 1)
            },
            ConnError::Custody(Refusal::Lot(LotError::Order)),
        ),
    ];
    for (name, step, want) in cases {
        let mut x = fx(Release::Hold);
        let hop = x.c.w.custody.balance(Place::Hopper(x.j), Resource::Ore);
        let m = lot(&x.c, M);
        let got = step(&mut x);
        assert_eq!(got, Err(want), "{name}");
        assert_eq!(lot(&x.c, M).held, m.held, "{name}");
        assert_eq!(lot(&x.c, M).consumed, m.consumed, "{name}");
        assert_eq!(
            x.c.w.custody.balance(Place::Hopper(x.j), Resource::Ore),
            hop,
            "{name}"
        );
        ck(&x.c);
    }
}

#[test]
fn own_lot_and_anothers_lot_in_one_job_on_one_store() {
    let mut x = fx(Release::Hold);
    let (j, o) = (x.j, x.order);
    // B's own 10 from its lot (return room kept), M's 30 under the order.
    deposit(
        &mut x.c.w,
        T0 + 20,
        B,
        j,
        1,
        Resource::Ore,
        u(10),
        Place::Vault(V),
    )
    .unwrap();
    x.c.deposit_from_lot(T0 + 20, B, j, 2, V, M, 0, o, 30)
        .unwrap();
    wood(&mut x.c, j, 3).unwrap();
    ck(&x.c);
    assert_eq!(x.c.w.custody.return_room(V, B, Resource::Ore), u(10));
    assert_eq!(lot(&x.c, M).consumed, u(30));
    assert_eq!(lot(&x.c, B).held, u(10));
    // Completion uses all 40: B's reservation ends (nothing to return),
    // M's lot is not touched again.
    x.c.apply(S + 3 * HOUR, X, &Op::Settle { job: j }).unwrap();
    ck(&x.c);
    assert_eq!(x.c.w.custody.return_room(V, B, Resource::Ore), 0);
    assert!(x.c.w.custody.take_notes().contains(&Note::Released {
        job: j,
        vault: V,
        owner: B,
        r: ORE,
        qty: u(10),
        why: Why::Emptied
    }));
    // The arms are held: whose they are is not decided.
    let before = x.c.clone();
    assert_eq!(
        x.c.apply(
            S + 3 * HOUR,
            B,
            &Op::Claim {
                job: j,
                to: Place::Caravan(78)
            }
        ),
        Err(ConnError::OwnershipUndecided)
    );
    assert_eq!(x.c, before);
}

#[test]
fn a_cancel_holds_the_mixed_hopper_and_its_return_room() {
    // Own and another's ore in one hopper, cancelled before start: under
    // the hold nothing is handed out, so B's own lot keeps the return room
    // until the ownership of the mixed leftovers is decided.
    let mut x = fx(Release::Hold);
    let (j, o) = (x.j, x.order);
    deposit(
        &mut x.c.w,
        T0 + 20,
        B,
        j,
        1,
        Resource::Ore,
        u(10),
        Place::Vault(V),
    )
    .unwrap();
    x.c.deposit_from_lot(T0 + 20, B, j, 2, V, M, 0, o, 30)
        .unwrap();
    x.c.apply(T0 + 30, B, &Op::Cancel { job: j }).unwrap();
    assert_eq!(
        x.c.apply(
            T0 + 40,
            B,
            &Op::Claim {
                job: j,
                to: Place::Vault(V)
            }
        ),
        Err(ConnError::OwnershipUndecided)
    );
    assert_eq!(x.c.w.custody.return_room(V, B, Resource::Ore), u(10));
    assert_eq!(
        x.c.w.custody.balance(Place::Hopper(j), Resource::Ore).1,
        u(40)
    );
    ck(&x.c);
    // The comparison case (to the user): 15 whole units back into B's lot,
    // the reservation covering B's 10 and the lot's free room M's 5. (A
    // refund beyond the quota is refused whole: B's lot holds at most 30.)
    let mut y = fx(Release::ToUser);
    deposit(
        &mut y.c.w,
        T0 + 20,
        B,
        y.j,
        1,
        Resource::Ore,
        u(10),
        Place::Vault(V),
    )
    .unwrap();
    y.c.deposit_from_lot(T0 + 20, B, y.j, 2, V, M, 0, y.order, 5)
        .unwrap();
    y.c.apply(T0 + 30, B, &Op::Cancel { job: y.j }).unwrap();
    y.c.w.custody.take_notes();
    y.c.apply(
        T0 + 40,
        B,
        &Op::Claim {
            job: y.j,
            to: Place::Vault(V),
        },
    )
    .unwrap();
    assert_eq!(
        y.c.w.custody.take_notes(),
        vec![Note::Returned {
            job: y.j,
            vault: V,
            owner: B,
            r: ORE,
            qty: u(15),
            covered: u(10),
            released: 0
        }]
    );
    assert_eq!(lot(&y.c, B).held, u(25));
    ck(&y.c);
}

#[test]
fn random_runs_with_both_paths_keep_every_invariant() {
    let seeds: u64 = std::env::var("ADAPTER_SEEDS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(200);
    let (mut used, mut replays, mut restarts, mut own) = (0, 0, 0, 0);
    for seed in 0..seeds {
        let mut g = seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1;
        let mut rnd = |n: u64| {
            g ^= g << 13;
            g ^= g >> 7;
            g ^= g << 17;
            g % n
        };
        let mut x = fx(if rnd(4) == 0 {
            Release::ToUser
        } else {
            Release::Hold
        });
        let j = x.j;
        let mut now = T0 + 20;
        let mut last: Option<(u64, u32)> = None;
        for _ in 0..60 {
            now += rnd(400) as i64;
            let r = match rnd(9) {
                0 | 1 => {
                    let (n, q) = (1 + rnd(8), 1 + rnd(12) as u32);
                    last = Some((n, q));
                    let r = x.c.deposit_from_lot(now, B, j, n, V, M, 0, x.order, q);
                    if r == Ok(Outcome::Applied(vec![])) || matches!(r, Ok(Outcome::Applied(_))) {
                        used += 1;
                    }
                    r.map(|_| ())
                }
                2 => match last {
                    Some((n, q)) => {
                        replays += 1;
                        let before = x.c.w.custody.lots.clone();
                        let r = x.c.deposit_from_lot(now, B, j, n, V, M, 0, x.order, q);
                        if r == Ok(Outcome::AlreadyApplied) {
                            assert_eq!(x.c.w.custody.lots, before, "seed {seed}");
                        }
                        r.map(|_| ())
                    }
                    None => Ok(()),
                },
                3 => {
                    let r = x.c.apply(
                        now,
                        B,
                        &Op::Deposit {
                            job: j,
                            deposit: 1 + rnd(8),
                            resource: Resource::Ore,
                            amount: u(1 + rnd(5) as i64),
                            from: Place::Vault(V),
                        },
                    );
                    if matches!(r, Ok(Outcome::Applied(_))) {
                        own += 1;
                    }
                    r.map(|_| ())
                }
                4 => wood(&mut x.c, j, 1 + rnd(8)).map(|_| ()),
                5 => x.c.apply(now, X, &Op::Settle { job: j }).map(|_| ()),
                6 => x.c.apply(now, B, &Op::Cancel { job: j }).map(|_| ()),
                7 => {
                    x.c.apply(
                        now,
                        B,
                        &Op::Claim {
                            job: j,
                            to: if rnd(2) == 0 {
                                Place::Vault(V)
                            } else {
                                Place::Caravan(78)
                            },
                        },
                    )
                    .map(|_| ())
                }
                _ => {
                    restarts += 1;
                    x.c = restart_c(&x.c);
                    Ok(())
                }
            };
            let _ = r;
            x.c.w
                .custody
                .check()
                .unwrap_or_else(|e| panic!("seed {seed}: {e}"));
            // M's CONSUMED is exactly the ore the order let into the job.
            let taken: i64 = x.c.w.custody.uses.values().map(|u| u.qty).sum();
            assert_eq!(lot(&x.c, M).consumed, taken, "seed {seed}");
        }
    }
    println!("seeds {seeds}: lot deposits {used}, replays {replays}, restarts {restarts}, own-lot deposits {own}");
    assert!(used >= seeds && replays >= seeds && own >= seeds / 2);
}

#[test]
fn tens_side_releases_once_per_deposit_even_when_called_directly() {
    use wylls_custody_adapter_09::UseLink;
    let x = fx(Release::Hold);
    let mut cu = x.c.w.custody.clone();
    let link = UseLink {
        vault: V,
        owner: M,
        grantee: B,
        slot: 0,
        order: x.order,
        qty: u(5),
        bell: 0,
    };
    assert_eq!(
        cu.release_by_order(x.j, 99, 1, link, PURPOSE_WORKSHOP_ARMS),
        Ok(true)
    );
    let lots = cu.lots.clone();
    assert_eq!(
        cu.release_by_order(x.j, 99, 1, link, PURPOSE_WORKSHOP_ARMS),
        Ok(false)
    );
    assert_eq!(cu.lots, lots);
    let other = UseLink { qty: u(6), ..link };
    assert_eq!(
        cu.release_by_order(x.j, 99, 1, other, PURPOSE_WORKSHOP_ARMS),
        Err(Refusal::Nine(
            wylls_capacity::custody::CustodyError::KeyReused
        ))
    );
    assert_eq!(cu.lots, lots);
    assert_eq!(cu.lot(V, M, ORE).unwrap().consumed, u(5));
}
