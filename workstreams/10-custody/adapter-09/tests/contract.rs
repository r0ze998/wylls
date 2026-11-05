//! Contract tests: ⑨'s own `Harness` (unchanged) over ⑩'s lots through the
//! adapter. Material use, goods reserved in a job, returns and completion,
//! duplicates and restarts.

mod common;

use common::*;
use permutation_rules::frontier::arms::ARMS;
use permutation_rules::frontier::holding::{Resource, HOUR};
use wylls_capacity::custody::{By, Custody, CustodyError, Key, Move};
use wylls_capacity::ledger::{Op, Outcome};
use wylls_capacity::model::Place;
use wylls_capacity::policy::{LossPolicy, Policies};
use wylls_capacity::testkit::{B, C, SITE_A, T0, X};
use wylls_capacity::CapError;
use wylls_custody::lot::CustodyError as LotError;
use wylls_custody_adapter_09::{Note, Refusal, Why};

const ORE: u8 = Resource::Ore as u8;

#[test]
fn materials_from_a_lot_keep_their_return_room_until_used_up() {
    let (mut w, f) = world(Policies::PROVISIONAL);
    let j = job(f, 1, 1);
    reserve(&mut w, T0 + 10, B, j, 20);
    caravan(&mut w, B, 77, Resource::Ore, 20);
    caravan(&mut w, B, 77, Resource::Wood, 20);
    deposit(
        &mut w,
        T0 + 20,
        B,
        j,
        1,
        Resource::Ore,
        u(20),
        Place::Vault(V),
    )
    .unwrap();
    deposit(
        &mut w,
        T0 + 20,
        B,
        j,
        2,
        Resource::Ore,
        u(20),
        Place::Caravan(77),
    )
    .unwrap();
    deposit(
        &mut w,
        T0 + 20,
        B,
        j,
        3,
        Resource::Wood,
        u(20),
        Place::Caravan(77),
    )
    .unwrap();
    // The lot is empty, its room kept for the 20 out in the job; C's lot
    // in the same vault is untouched.
    assert_eq!(held(&w, V, B), 0);
    assert_eq!(w.custody.return_room(V, B, Resource::Ore), u(20));
    assert_eq!(held(&w, V, C), u(10));
    let n = w.custody.take_notes();
    assert_eq!(
        n,
        vec![Note::Reserved {
            job: j,
            vault: V,
            owner: B,
            r: ORE,
            qty: u(20)
        }]
    );
    // Partial settlement uses inputs in milli units; the reservation stays
    // while the hopper still has ore.
    ap(&mut w, S + HOUR, X, &Op::Settle { job: j }).unwrap();
    assert_eq!(w.custody.balance(Place::Hopper(j), Resource::Ore).1, u(24));
    assert_eq!(w.custody.return_room(V, B, Resource::Ore), u(20));
    // Completion uses the rest: the hopper's ore is gone and so is the
    // reservation, released once.
    ap(&mut w, S + 3 * HOUR, X, &Op::Settle { job: j }).unwrap();
    assert_eq!(w.custody.balance(Place::Hopper(j), Resource::Ore).1, 0);
    assert_eq!(w.custody.return_room(V, B, Resource::Ore), 0);
    let n = w.custody.take_notes();
    let released: Vec<_> = n
        .iter()
        .filter(|x| matches!(x, Note::Released { .. }))
        .collect();
    assert_eq!(
        released,
        vec![&Note::Released {
            job: j,
            vault: V,
            owner: B,
            r: ORE,
            qty: u(20),
            why: Why::Emptied
        }]
    );
    let used: i64 = n
        .iter()
        .map(|x| match x {
            Note::Consumed { r, qty, .. } if *r == ORE => *qty,
            _ => 0,
        })
        .sum();
    assert_eq!(used, u(40)); // 16 at the first settlement, 24 at completion
                             // Arms cannot enter a lot (⑩ enables ore only): the claim is refused
                             // whole and nothing moves; to a caravan it goes.
    let before = bytes(&w);
    assert_eq!(
        ap(
            &mut w,
            S + 3 * HOUR,
            B,
            &Op::Claim {
                job: j,
                to: Place::Vault(V)
            }
        ),
        Err(CapError::Custody)
    );
    assert_eq!(bytes(&w), before);
    ap(
        &mut w,
        S + 3 * HOUR,
        B,
        &Op::Claim {
            job: j,
            to: Place::Caravan(78),
        },
    )
    .unwrap();
    assert_eq!(
        w.custody.balance(Place::Caravan(78), ARMS),
        (Some(B), u(20))
    );
}

#[test]
fn a_cancelled_job_returns_its_materials_into_the_lot_through_the_reservation() {
    let (mut w, f) = world(Policies::PROVISIONAL);
    let j = job(f, 1, 1);
    reserve(&mut w, T0 + 10, B, j, 10);
    deposit(
        &mut w,
        T0 + 20,
        B,
        j,
        1,
        Resource::Ore,
        u(10),
        Place::Vault(V),
    )
    .unwrap();
    assert_eq!(
        (held(&w, V, B), w.custody.return_room(V, B, Resource::Ore)),
        (u(10), u(10))
    );
    ap(&mut w, T0 + 30, B, &Op::Cancel { job: j }).unwrap();
    w.custody.take_notes();
    ap(
        &mut w,
        T0 + 40,
        B,
        &Op::Claim {
            job: j,
            to: Place::Vault(V),
        },
    )
    .unwrap();
    assert_eq!(
        (held(&w, V, B), w.custody.return_room(V, B, Resource::Ore)),
        (u(20), 0)
    );
    assert_eq!(
        w.custody.take_notes(),
        vec![Note::Returned {
            job: j,
            vault: V,
            owner: B,
            r: ORE,
            qty: u(10),
            covered: u(10),
            released: 0
        }]
    );
    // Retire: ⑨ forgets the job; nothing is left to release.
    ap(&mut w, T0 + 50, B, &Op::Retire { job: j }).unwrap();
    assert!(w.custody.take_notes().is_empty());
    assert!(w.custody.returns.is_empty() && w.custody.jobs.is_empty());
    assert!(w.custody.keys.keys().all(|k| k.scope >= 1 << 40));
}

#[test]
fn a_fractional_refund_cannot_enter_a_lot_and_goes_elsewhere_without_a_leak() {
    let (mut w, f) = world(Policies::PROVISIONAL);
    let j = job(f, 1, 1);
    reserve(&mut w, T0 + 10, B, j, 10);
    caravan(&mut w, B, 77, Resource::Wood, 10);
    deposit(
        &mut w,
        T0 + 20,
        B,
        j,
        1,
        Resource::Ore,
        u(20),
        Place::Vault(V),
    )
    .unwrap();
    deposit(
        &mut w,
        T0 + 20,
        B,
        j,
        2,
        Resource::Wood,
        u(10),
        Place::Caravan(77),
    )
    .unwrap();
    // Cancel mid-run: 2 222 milli arms made, so 15 556 milli ore is left.
    ap(&mut w, S + 1000, B, &Op::Cancel { job: j }).unwrap();
    let ore_left = w.custody.balance(Place::Hopper(j), Resource::Ore).1;
    assert_eq!(ore_left, 15_556);
    // ⑩'s lots take whole units only: the refund into the lot is refused
    // (precise reason from the adapter itself), the claim changes nothing.
    let mut probe = w.custody.clone();
    assert_eq!(
        probe.try_transfer(
            Key {
                scope: 0,
                kind: 250,
                n: 0
            },
            By::Kernel,
            Place::Hopper(j),
            Place::Vault(V),
            Resource::Ore,
            ore_left,
            B
        ),
        Err(Refusal::Lot(LotError::Quantity))
    );
    let before = bytes(&w);
    assert_eq!(
        ap(
            &mut w,
            S + 1000,
            B,
            &Op::Claim {
                job: j,
                to: Place::Vault(V)
            }
        ),
        Err(CapError::Custody)
    );
    assert_eq!(bytes(&w), before);
    assert_eq!(w.custody.return_room(V, B, Resource::Ore), u(20));
    // Claimed elsewhere, the reservation is released once.
    w.custody.take_notes();
    ap(
        &mut w,
        S + 1000,
        B,
        &Op::Claim {
            job: j,
            to: Place::Caravan(78),
        },
    )
    .unwrap();
    assert_eq!(w.custody.return_room(V, B, Resource::Ore), 0);
    let n: Vec<_> = w
        .custody
        .take_notes()
        .into_iter()
        .filter(|x| matches!(x, Note::Released { .. } | Note::Returned { .. }))
        .collect();
    assert_eq!(
        n,
        vec![Note::Released {
            job: j,
            vault: V,
            owner: B,
            r: ORE,
            qty: u(20),
            why: Why::Emptied
        }]
    );
    assert_eq!(
        w.custody.balance(Place::Caravan(78), Resource::Ore),
        (Some(B), 15_556)
    );
}

/// The scenario of the first test as a list of operations.
fn script(f: wylls_capacity::model::FacilityId) -> Vec<(i64, wylls_capacity::model::Actor, Op)> {
    let j = job(f, 1, 1);
    let k = job(f, 2, 1);
    let l = job(f, 1, 2);
    vec![
        (
            T0 + 10,
            B,
            Op::Reserve {
                job: j,
                units: 1,
                start: S,
                end: S + 3 * HOUR,
                max_output: u(8),
            },
        ),
        (
            T0 + 10,
            C,
            Op::Reserve {
                job: k,
                units: 1,
                start: S,
                end: S + 3 * HOUR,
                max_output: u(4),
            },
        ),
        (
            T0 + 10,
            B,
            Op::Reserve {
                job: l,
                units: 1,
                start: S + 3 * HOUR,
                end: S + 4 * HOUR,
                max_output: u(2),
            },
        ),
        (
            T0 + 15,
            B,
            Op::Deposit {
                job: l,
                deposit: 1,
                resource: Resource::Ore,
                amount: u(4),
                from: Place::Vault(V),
            },
        ),
        (T0 + 16, B, Op::Cancel { job: l }),
        (
            T0 + 17,
            B,
            Op::Claim {
                job: l,
                to: Place::Vault(V),
            },
        ),
        (
            T0 + 20,
            B,
            Op::Deposit {
                job: j,
                deposit: 1,
                resource: Resource::Ore,
                amount: u(16),
                from: Place::Vault(V),
            },
        ),
        (
            T0 + 20,
            B,
            Op::Deposit {
                job: j,
                deposit: 2,
                resource: Resource::Wood,
                amount: u(8),
                from: Place::Caravan(77),
            },
        ),
        (
            T0 + 20,
            C,
            Op::Deposit {
                job: k,
                deposit: 1,
                resource: Resource::Ore,
                amount: u(10),
                from: Place::Vault(V),
            },
        ),
        (
            T0 + 20,
            C,
            Op::Deposit {
                job: k,
                deposit: 2,
                resource: Resource::Wood,
                amount: u(4),
                from: Place::Caravan(79),
            },
        ),
        (S + HOUR, X, Op::Settle { job: j }),
        (S + HOUR, X, Op::Settle { job: k }),
        (
            S + HOUR,
            B,
            Op::Claim {
                job: j,
                to: Place::Caravan(78),
            },
        ),
        (S + 3 * HOUR, X, Op::Settle { job: j }),
        (
            S + 3 * HOUR,
            C,
            Op::Claim {
                job: k,
                to: Place::Vault(V),
            },
        ),
        (
            S + 3 * HOUR,
            C,
            Op::Claim {
                job: k,
                to: Place::Caravan(80),
            },
        ),
        (
            S + 3 * HOUR,
            B,
            Op::Claim {
                job: j,
                to: Place::Caravan(78),
            },
        ),
        (S + 4 * HOUR, B, Op::Retire { job: j }),
        (S + 4 * HOUR, C, Op::Retire { job: k }),
        (S + 4 * HOUR, B, Op::Retire { job: l }),
    ]
}

fn scripted_world() -> (W, wylls_capacity::model::FacilityId) {
    let (mut w, f) = world(Policies::PROVISIONAL);
    caravan(&mut w, B, 77, Resource::Wood, 8);
    caravan(&mut w, C, 79, Resource::Wood, 4);
    w.custody.take_notes();
    (w, f)
}

#[test]
fn every_notification_twice_changes_nothing_the_second_time() {
    let (mut w, f) = scripted_world();
    let (mut once, _) = scripted_world();
    for (t, who, op) in script(f) {
        let first = ap(&mut w, t, who, &op);
        let _ = ap(&mut once, t, who, &op);
        let after = bytes(&w.custody);
        let events = w.events.len();
        let second = ap(&mut w, t, who, &op);
        match first {
            Ok(Outcome::Applied(_)) => {
                assert!(
                    matches!(second, Ok(Outcome::AlreadyApplied) | Err(CapError::Retired)),
                    "{op:?}: {second:?}"
                )
            }
            _ => assert_eq!(second, first, "{op:?}"),
        }
        assert_eq!(bytes(&w.custody), after, "{op:?} replayed moved custody");
        assert_eq!(w.events.len(), events, "{op:?} replayed logged again");
    }
    assert_eq!(bytes(&w.custody), bytes(&once.custody));
    // The custody calls themselves, replayed under their keys: the same
    // call is a no-op, a different call under a used key is refused.
    let (mut w, f) = scripted_world();
    for (t, who, op) in script(f).into_iter().take(6) {
        ap(&mut w, t, who, &op).unwrap();
    }
    let (key, m) = w
        .custody
        .keys
        .iter()
        .find(|(_, m)| {
            matches!(
                m,
                Move::Transfer {
                    from: Place::Vault(_),
                    ..
                }
            )
        })
        .map(|(k, m)| (*k, m.clone()))
        .unwrap();
    let Move::Transfer {
        from,
        to,
        owner,
        r,
        amount,
    } = m
    else {
        unreachable!()
    };
    let r = Resource::ALL.into_iter().find(|x| *x as u8 == r).unwrap();
    let before = bytes(&w.custody);
    assert_eq!(
        w.custody
            .transfer(key, By::Actor(owner), from, to, r, amount, owner),
        Ok(())
    );
    assert_eq!(bytes(&w.custody), before);
    assert_eq!(
        w.custody
            .transfer(key, By::Actor(owner), from, to, r, amount - 1, owner),
        Err(CustodyError::KeyReused)
    );
    assert_eq!(bytes(&w.custody), before);
}

#[test]
fn a_restart_at_every_step_gives_the_same_world() {
    let (mut a, f) = scripted_world();
    let (mut b, _) = scripted_world();
    for (t, who, op) in script(f) {
        let ra = ap(&mut a, t, who, &op);
        b = restart(&b);
        let rb = ap(&mut b, t, who, &op);
        assert_eq!(ra, rb, "{op:?}");
        // A restart between a notification and its duplicate.
        b = restart(&b);
        let _ = ap(&mut b, t, who, &op);
    }
    assert_eq!(bytes(&a), bytes(&b));
    // Drained: no reservation, no job, no key of a job left anywhere.
    assert!(b.custody.returns.is_empty() && b.custody.jobs.is_empty());
    assert_eq!(
        b.custody.return_room(V, B, Resource::Ore) + b.custody.return_room(V, C, Resource::Ore),
        0
    );
    assert!(b.custody.keys.keys().all(|k| k.scope >= 1 << 40));
}

#[test]
fn a_retired_job_cannot_be_replayed_into_custody() {
    let (mut w, f) = scripted_world();
    let ops = script(f);
    for (t, who, op) in &ops {
        let _ = ap(&mut w, *t, *who, op);
    }
    let before = bytes(&w.custody);
    // Every operation of the retired jobs, sent again late: ⑨ refuses
    // before custody, whose keys for them are gone (the adapter does not
    // keep tombstones; this is ⑨'s side of the contract).
    for (_, who, op) in &ops {
        let r = w.apply(S + 5 * HOUR, *who, op);
        assert!(
            r.is_err() || r == Ok(Outcome::AlreadyApplied),
            "{op:?}: {r:?}"
        );
        assert_eq!(bytes(&w.custody), before, "{op:?}");
    }
}

#[test]
fn nobody_but_the_owner_reaches_a_lot() {
    let (mut w, f) = world(Policies::PROVISIONAL);
    let (jb, jc) = (job(f, 1, 1), job(f, 2, 1));
    for (who, jj) in [(B, jb), (C, jc)] {
        ap(
            &mut w,
            T0 + 10,
            who,
            &Op::Reserve {
                job: jj,
                units: 1,
                start: S,
                end: S + 3 * HOUR,
                max_output: u(4),
            },
        )
        .unwrap();
    }
    // C's lot holds 10; the vault holds 30. C cannot take 15: B's goods are
    // not C's to use, whatever the vault's total.
    assert_eq!(
        deposit(
            &mut w,
            T0 + 20,
            C,
            jc,
            1,
            Resource::Ore,
            u(15),
            Place::Vault(V)
        ),
        Err(CapError::Custody)
    );
    assert_eq!(held(&w, V, B), u(20));
    // B's own lot elsewhere is out of reach of this facility.
    assert_eq!(
        deposit(
            &mut w,
            T0 + 20,
            B,
            jb,
            1,
            Resource::Ore,
            u(5),
            Place::Vault(FAR)
        ),
        Err(CapError::Custody)
    );
    let cu = &mut w.custody.clone();
    let key = |n| Key {
        scope: 9,
        kind: 251,
        n,
    };
    // The keeper has no lot and may not open one in its own vault.
    assert_eq!(
        cu.try_transfer(
            key(1),
            By::Actor(K),
            Place::Vault(V),
            Place::Hopper(jc),
            Resource::Ore,
            u(1),
            K
        ),
        Err(Refusal::Nine(CustodyError::Insufficient))
    );
    assert_eq!(
        cu.open_lot(V, K, K, Resource::Ore, u(1)),
        Err(Refusal::Lot(LotError::SelfDealing))
    );
    // ⑨'s kernel moves only a job's own places.
    assert_eq!(
        cu.try_transfer(
            key(2),
            By::Kernel,
            Place::Vault(V),
            Place::Hopper(jb),
            Resource::Ore,
            u(1),
            B
        ),
        Err(Refusal::Nine(CustodyError::Forbidden))
    );
    // An owner's move does not change the owner.
    assert_eq!(
        cu.try_transfer(
            key(3),
            By::Actor(B),
            Place::Vault(V),
            Place::Hopper(jc),
            Resource::Ore,
            u(1),
            C
        ),
        Err(Refusal::Nine(CustodyError::Forbidden))
    );
    // Lot to caravan, lot to lot, lot to core: ⑩'s own instructions.
    for (n, to) in [
        (4, Place::Caravan(5)),
        (5, Place::Vault(FAR)),
        (6, Place::Holding(SITE_A)),
    ] {
        assert_eq!(
            cu.try_transfer(
                key(n),
                By::Actor(B),
                Place::Vault(V),
                to,
                Resource::Ore,
                u(1),
                B
            ),
            Err(Refusal::Nine(CustodyError::Forbidden))
        );
    }
    assert_eq!(
        cu.try_export(key(7), By::Actor(B), Place::Vault(V), Resource::Ore, u(1)),
        Err(Refusal::Nine(CustodyError::Forbidden))
    );
    // Nobody but the kernel empties a job's places, not even its user.
    deposit(
        &mut w,
        T0 + 20,
        B,
        jb,
        1,
        Resource::Ore,
        u(5),
        Place::Vault(V),
    )
    .unwrap();
    let cu = &mut w.custody.clone();
    assert_eq!(
        cu.try_transfer(
            key(8),
            By::Actor(B),
            Place::Hopper(jb),
            Place::Caravan(5),
            Resource::Ore,
            u(5),
            B
        ),
        Err(Refusal::Nine(CustodyError::Forbidden))
    );
    assert_eq!(
        cu.try_import(key(9), Place::Hopper(jb), B, Resource::Ore, u(1)),
        Err(Refusal::Nine(CustodyError::Forbidden))
    );
}

#[test]
fn return_room_holds_against_arrivals_and_quota_cuts() {
    let (mut w, f) = world(Policies::PROVISIONAL);
    let j = job(f, 1, 1);
    reserve(&mut w, T0 + 10, B, j, 10);
    deposit(
        &mut w,
        T0 + 20,
        B,
        j,
        1,
        Resource::Ore,
        u(20),
        Place::Vault(V),
    )
    .unwrap();
    // Quota 30: held 0 + return 20. A caravan of 11 does not fit, 10 does.
    assert_eq!(
        w.custody.begin_inbound(V, B, Resource::Ore, (9, 1), u(11)),
        Err(Refusal::Lot(LotError::Capacity))
    );
    w.custody
        .begin_inbound(V, B, Resource::Ore, (9, 1), u(10))
        .unwrap();
    // The keeper cannot cut the quota under what is promised.
    assert_eq!(
        w.custody.set_quota(V, K, B, Resource::Ore, u(29)),
        Err(Refusal::Lot(LotError::NotEmpty))
    );
    // Nor can an arrival from outside take the return's room.
    assert_eq!(
        w.custody
            .try_import(arrival(50), Place::Vault(V), B, Resource::Ore, u(1)),
        Err(Refusal::Lot(LotError::Capacity))
    );
    // The return fits exactly.
    ap(&mut w, T0 + 30, B, &Op::Cancel { job: j }).unwrap();
    ap(
        &mut w,
        T0 + 40,
        B,
        &Op::Claim {
            job: j,
            to: Place::Vault(V),
        },
    )
    .unwrap();
    let l = w.custody.lot(V, B, ORE).unwrap();
    assert_eq!((l.held, l.incoming(), l.quota), (u(20), u(10), u(30)));
    w.custody.check().unwrap();
}

#[test]
fn a_facility_loss_ends_each_reservation_exactly_once() {
    for loss in [
        LossPolicy::CaptorTakesAll,
        LossPolicy::UserKeepsAll,
        LossPolicy::UserKeepsOutput,
    ] {
        let (mut w, f) = world(Policies {
            loss,
            ..Policies::PROVISIONAL
        });
        let j = job(f, 1, 1);
        reserve(&mut w, T0 + 10, B, j, 10);
        deposit(
            &mut w,
            T0 + 20,
            B,
            j,
            1,
            Resource::Ore,
            u(10),
            Place::Vault(V),
        )
        .unwrap();
        w.custody.take_notes();
        w.facilities
            .get_mut(&SITE_A)
            .unwrap()
            .capture(S + 10, X)
            .unwrap();
        ap(&mut w, S + 20, X, &Op::FacilityLost { facility: f }).unwrap();
        ap(&mut w, S + 30, X, &Op::FacilityLost { facility: f }).unwrap();
        let mut n = w.custody.take_notes();
        if loss == LossPolicy::UserKeepsAll {
            // The goods are still B's in the job; B brings them home.
            assert!(n.is_empty());
            assert_eq!(w.custody.return_room(V, B, Resource::Ore), u(10));
            ap(
                &mut w,
                S + 40,
                B,
                &Op::Claim {
                    job: j,
                    to: Place::Vault(V),
                },
            )
            .unwrap();
            ap(
                &mut w,
                S + 50,
                B,
                &Op::Claim {
                    job: j,
                    to: Place::Vault(V),
                },
            )
            .unwrap();
            n = w.custody.take_notes();
            assert_eq!(
                n,
                vec![Note::Returned {
                    job: j,
                    vault: V,
                    owner: B,
                    r: ORE,
                    qty: u(10),
                    covered: u(10),
                    released: 0
                }]
            );
            assert_eq!(held(&w, V, B), u(20));
        } else {
            // The inputs go to the captor (⑨'s policy); the lot's
            // reservation ends, the rest of the lot stays B's.
            assert_eq!(
                n,
                vec![Note::Released {
                    job: j,
                    vault: V,
                    owner: B,
                    r: ORE,
                    qty: u(10),
                    why: Why::Emptied
                }]
            );
            assert_eq!(
                w.custody.balance(Place::Holding(SITE_A), Resource::Ore),
                (Some(X), u(10))
            );
            assert_eq!(held(&w, V, B), u(10));
        }
        assert_eq!(w.custody.return_room(V, B, Resource::Ore), 0);
    }
}

#[test]
fn a_seized_vault_freezes_the_lot_and_the_return_goes_elsewhere() {
    let (mut w, f) = world(Policies::PROVISIONAL);
    let j = job(f, 1, 1);
    let j2 = job(f, 1, 2);
    reserve(&mut w, T0 + 10, B, j, 10);
    ap(
        &mut w,
        T0 + 10,
        B,
        &Op::Reserve {
            job: j2,
            units: 1,
            start: S + 4 * HOUR,
            end: S + 5 * HOUR,
            max_output: u(1),
        },
    )
    .unwrap();
    deposit(
        &mut w,
        T0 + 20,
        B,
        j,
        1,
        Resource::Ore,
        u(10),
        Place::Vault(V),
    )
    .unwrap();
    w.custody.seize_vault(V, X).unwrap();
    w.custody.check().unwrap();
    ap(&mut w, T0 + 30, B, &Op::Cancel { job: j }).unwrap();
    // A refund into the frozen lot would be lost to B: refused whole.
    let before = bytes(&w);
    assert_eq!(
        ap(
            &mut w,
            T0 + 40,
            B,
            &Op::Claim {
                job: j,
                to: Place::Vault(V)
            }
        ),
        Err(CapError::Custody)
    );
    assert_eq!(bytes(&w), before);
    w.custody.take_notes();
    ap(
        &mut w,
        T0 + 40,
        B,
        &Op::Claim {
            job: j,
            to: Place::Caravan(78),
        },
    )
    .unwrap();
    assert_eq!(
        w.custody
            .take_notes()
            .into_iter()
            .filter(|x| matches!(x, Note::Released { .. }))
            .collect::<Vec<_>>(),
        vec![Note::Released {
            job: j,
            vault: V,
            owner: B,
            r: ORE,
            qty: u(10),
            why: Why::Emptied
        }]
    );
    // Frozen: B cannot take more out; the captor has no lot there; the lot
    // still holds B's 10 (forfeiture is not decided, the adapter runs none).
    assert_eq!(
        deposit(
            &mut w,
            T0 + 50,
            B,
            j2,
            1,
            Resource::Ore,
            u(1),
            Place::Vault(V)
        ),
        Err(CapError::Custody)
    );
    let mut cu = w.custody.clone();
    assert_eq!(
        cu.try_transfer(
            Key {
                scope: 9,
                kind: 252,
                n: 0
            },
            By::Actor(X),
            Place::Vault(V),
            Place::Hopper(j2),
            Resource::Ore,
            u(1),
            X
        ),
        Err(Refusal::Nine(CustodyError::Insufficient))
    );
    let l = w.custody.lot(V, B, ORE).unwrap();
    assert_eq!(
        (l.held, l.forfeited, l.state),
        (u(10), 0, wylls_custody::lot::LOT_OPEN)
    );
    w.custody.check().unwrap();
}
