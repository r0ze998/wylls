//! Accounting on 10's one table of lots: split claims, the owner's
//! decisions (products to the user, unused lot ore back to its lot), held
//! returns and sub-unit rests, seizures, a user's own lot, one source per
//! job, receipts against 10's notes, and 10's refusal reasons.

mod common;
use common::*;

use permutation_rules::fixed::MILLI;
use permutation_rules::frontier::arms::ARMS;
use permutation_rules::frontier::holding::{Resource, HOUR};
use wylls_capacity::custody::{Custody, CustodyError};
use wylls_capacity::event::Event;
use wylls_capacity::ledger::{Op, Outcome, Refusal};
use wylls_capacity::model::Place;
use wylls_capacity::testkit::*;
use wylls_capacity::CapError;
use wylls_capacity_bridge10::*;
use wylls_custody_adapter_09::Note;

/// Job 1 fed 40 of M's ore and 20 of B's wood, cancelled at 2,666 milli
/// arms: 34.668 ore and 17.334 wood unused.
fn cancelled(release: Release) -> Fx {
    let mut x = fx(release, 80);
    let j = x.job;
    ore(&mut x, T0 + 20, j, 1, 40).unwrap();
    wood(&mut x, T0 + 20, j, 2, 20).unwrap();
    x.b.apply(S + 1_200, B, &Op::Cancel { job: j }).unwrap();
    x
}

#[test]
fn decided_products_to_the_user_unused_ore_back_to_its_lot() {
    let mut x = cancelled(Release::Decided);
    let j = x.job;
    x.b.apply(S + 1_300, B, &Op::Claim { job: j, to: HOME })
        .unwrap();
    assert_eq!(x.b.cap.custody.balance(HOME, ARMS), (Some(B), 2_666));
    assert_eq!(x.b.cap.custody.balance(HOME, Resource::Wood).1, 17_334);
    assert_eq!(
        x.b.cap.custody.balance(HOME, Resource::Ore).1,
        0,
        "no ore to B"
    );
    let l = m_lot(&x);
    assert_eq!(l.held, (100 - 40 + 34) * MILLI);
    assert!(l.balanced(x.b.bell(S + 1_300)));
    assert_eq!(x.b.returned[&key_m()], 34 * MILLI);
    assert_eq!(x.b.owed[&key_m()], 668);
    x.b.check().unwrap();
    // A resent claim moves nothing; nor does a restart and resend.
    assert_eq!(
        x.b.apply(S + 1_400, B, &Op::Claim { job: j, to: HOME }),
        Ok(Outcome::AlreadyApplied)
    );
    x.b = Bridge::load(&x.b.save()).unwrap();
    assert_eq!(
        x.b.apply(S + 1_500, B, &Op::Claim { job: j, to: HOME }),
        Ok(Outcome::AlreadyApplied)
    );
    assert_eq!(m_lot(&x), l);
}

#[test]
fn rests_owed_to_a_lot_add_up_to_whole_units() {
    let mut x = fx(Release::Decided, 80);
    for (n, start) in [(1u32, S), (2, S + 4 * HOUR)] {
        let j = if n == 1 {
            x.job
        } else {
            reserve(&mut x.b, x.g, 2, start)
        };
        ore(&mut x, start - HOUR + 30, j, 1, 40).unwrap();
        wood(&mut x, start - HOUR + 30, j, 2, 20).unwrap();
        x.b.apply(start + 1_200, B, &Op::Cancel { job: j }).unwrap();
        x.b.apply(start + 1_300, B, &Op::Claim { job: j, to: HOME })
            .unwrap();
    }
    // 2 × 34.668 = 69.336: 69 back, 0.336 owed.
    assert_eq!(x.b.returned[&key_m()], 69 * MILLI);
    assert_eq!(x.b.owed[&key_m()], 336);
    assert_eq!(m_lot(&x).held, (100 - 80 + 69) * MILLI);
    x.b.check().unwrap();
}

#[test]
fn a_split_claim_sends_the_users_goods_apart_and_the_ore_home() {
    let mut x = cancelled(Release::Decided);
    let j = x.job;
    let (arms_to, wood_to, rest_to, ore_to) = (
        Place::Caravan(81),
        Place::Caravan(82),
        Place::Caravan(83),
        Place::Caravan(84),
    );
    let op = Op::ClaimSplit {
        job: j,
        output_to: arms_to,
        refund_to: [ore_to, wood_to],
        remainder_to: rest_to,
    };
    x.b.apply(S + 1_300, B, &op).unwrap();
    assert_eq!(x.b.cap.custody.balance(arms_to, ARMS).1, 2_666);
    assert_eq!(
        x.b.cap.custody.balance(wood_to, Resource::Wood).1,
        17 * MILLI
    );
    assert_eq!(x.b.cap.custody.balance(rest_to, Resource::Wood).1, 334);
    assert_eq!(
        x.b.cap.custody.balance(ore_to, Resource::Ore).1,
        0,
        "M's ore is not B's to place"
    );
    assert_eq!(x.b.returned[&key_m()], 34 * MILLI);
    x.b.check().unwrap();
}

#[test]
fn a_frozen_lot_keeps_the_return_owed() {
    let mut x = cancelled(Release::Decided);
    let j = x.job;
    x.b.cap.custody.seize_vault(VM, X).unwrap();
    let held = m_lot(&x).held;
    x.b.apply(S + 1_300, B, &Op::Claim { job: j, to: HOME })
        .unwrap();
    assert_eq!(
        x.b.cap.custody.balance(HOME, ARMS).1,
        2_666,
        "the user's products still go out"
    );
    assert_eq!(m_lot(&x).held, held, "a frozen lot takes nothing");
    assert_eq!(x.b.owed[&key_m()], 34_668, "all of it owed, nothing lost");
    x.b.check().unwrap();
}

#[test]
fn a_full_lot_keeps_the_return_owed() {
    let mut x = cancelled(Release::Decided);
    let j = x.job;
    // V shrinks M's room to what M's lot holds now.
    x.b.cap
        .custody
        .set_quota(VM, V, M, Resource::Ore, 60 * MILLI)
        .unwrap();
    x.b.apply(S + 1_300, B, &Op::Claim { job: j, to: HOME })
        .unwrap();
    assert_eq!(m_lot(&x).held, 60 * MILLI);
    assert_eq!(x.b.owed[&key_m()], 34_668);
    x.b.check().unwrap();
}

#[test]
fn a_facility_capture_gives_the_captor_what_is_there() {
    let mut x = fx(Release::Decided, 80);
    let j = x.job;
    ore(&mut x, T0 + 20, j, 1, 40).unwrap();
    wood(&mut x, T0 + 20, j, 2, 20).unwrap();
    let cap = S + HOUR;
    x.b.cap
        .facilities
        .get_mut(&SITE_A)
        .unwrap()
        .capture(cap, X)
        .unwrap();
    x.b.apply(
        cap,
        X,
        &Op::FacilityLost {
            facility: x.g.facility,
        },
    )
    .unwrap();
    assert_eq!(
        x.b.cap.custody.balance(Place::Holding(SITE_A), ARMS),
        (Some(X), 8 * MILLI)
    );
    assert_eq!(
        x.b.cap
            .custody
            .balance(Place::Holding(SITE_A), Resource::Ore),
        (Some(X), 24 * MILLI)
    );
    assert_eq!(
        x.b.apply(cap + 1, B, &Op::Claim { job: j, to: HOME }),
        Ok(Outcome::AlreadyApplied)
    );
    assert_eq!(m_lot(&x).held, 60 * MILLI, "nothing back to M");
    assert!(x.b.returned.is_empty() && x.b.owed.is_empty());
    let a = x.b.cap.job(j).unwrap().accounts();
    assert_eq!(a.inputs[0].forfeited, 24 * MILLI);
    x.b.check().unwrap();
}

#[test]
fn a_users_own_lot_takes_its_ore_back_in_whole_units() {
    let mut x = fx(Release::Decided, 80);
    let j = x.job;
    x.b.apply(
        T0 + 20,
        B,
        &Op::Deposit {
            job: j,
            deposit: 1,
            resource: Resource::Ore,
            amount: 40 * MILLI,
            from: Place::Vault(VB),
        },
    )
    .unwrap();
    wood(&mut x, T0 + 20, j, 2, 20).unwrap();
    assert_eq!(b_lot(&x).held, 60 * MILLI);
    x.b.apply(S + 1_200, B, &Op::Cancel { job: j }).unwrap();
    // Not fed by another's lot: 09's split claim straight to B's lot.
    let op = Op::ClaimSplit {
        job: j,
        output_to: HOME,
        refund_to: [Place::Vault(VB), HOME],
        remainder_to: HOME,
    };
    x.b.apply(S + 1_300, B, &op).unwrap();
    assert_eq!(b_lot(&x).held, 94 * MILLI);
    assert_eq!(x.b.cap.custody.balance(HOME, Resource::Ore).1, 668);
    assert_eq!(
        x.b.cap.custody.return_room(VB, B, Resource::Ore),
        0,
        "the reservation ended once"
    );
    // The plain claim of fractions and arms into the lot is refused whole.
    let mut y = fx(Release::Decided, 80);
    let j = y.job;
    y.b.apply(
        T0 + 20,
        B,
        &Op::Deposit {
            job: j,
            deposit: 1,
            resource: Resource::Ore,
            amount: 40 * MILLI,
            from: Place::Vault(VB),
        },
    )
    .unwrap();
    wood(&mut y, T0 + 20, j, 2, 20).unwrap();
    y.b.apply(S + 1_200, B, &Op::Cancel { job: j }).unwrap();
    let before = y.b.clone();
    let r = y.b.cap.apply_detailed(
        S + 1_300,
        B,
        &Op::Claim {
            job: j,
            to: Place::Vault(VB),
        },
    );
    assert!(
        matches!(
            r,
            Err(Refusal {
                code: CapError::Custody,
                custody: Some(_)
            })
        ),
        "{r:?}"
    );
    assert_eq!(y.b, before);
}

#[test]
fn a_job_takes_ore_from_one_source_only() {
    // Not decided, not widened: mixing is refused both ways.
    let mut x = fx(Release::Decided, 80);
    let j = x.job;
    x.b.apply(
        T0 + 20,
        B,
        &Op::Deposit {
            job: j,
            deposit: 1,
            resource: Resource::Ore,
            amount: 20 * MILLI,
            from: Place::Vault(VB),
        },
    )
    .unwrap();
    let before = m_lot(&x);
    assert_eq!(
        ore(&mut x, T0 + 20, j, 2, 20),
        Err(BridgeError::MixedSource)
    );
    assert_eq!(m_lot(&x), before);
    let mut y = fx(Release::Decided, 80);
    let j = y.job;
    ore(&mut y, T0 + 20, j, 1, 20).unwrap();
    let own = Op::Deposit {
        job: j,
        deposit: 2,
        resource: Resource::Ore,
        amount: 20 * MILLI,
        from: Place::Vault(VB),
    };
    assert_eq!(y.b.apply(T0 + 20, B, &own), Err(BridgeError::MixedSource));
    y.b.check().unwrap();
}

#[test]
fn a_lot_outside_the_facilitys_province_is_too_far() {
    let mut x = fx(Release::Decided, 80);
    x.b.cap.custody.add_vault(9, 1, -1, 6, V, 5_000 * MILLI);
    x.b.cap
        .custody
        .open_lot(9, V, M, Resource::Ore, 200 * MILLI)
        .unwrap();
    let k = wylls_capacity::custody::Key {
        scope: 9,
        kind: 100,
        n: 0,
    };
    x.b.cap
        .custody
        .import(k, Place::Vault(9), M, Resource::Ore, 50 * MILLI)
        .unwrap();
    let o =
        x.b.cap
            .custody
            .set_use_order(9, M, B, 0, 50 * MILLI, 500, PURPOSE_WORKSHOP_ARMS, 0)
            .unwrap();
    let j = x.job;
    let before = x.b.cap.custody.lot(9, M, Resource::Ore as u8);
    assert_eq!(
        x.b.deposit_from_lot(T0 + 20, B, j, 1, 9, M, 0, o, 10),
        Err(BridgeError::TooFar)
    );
    assert_eq!(x.b.cap.custody.lot(9, M, Resource::Ore as u8), before);
}

#[test]
fn the_receipt_agrees_with_10s_notes() {
    let mut x = fx(Release::Decided, 80);
    let j = x.job;
    ore(&mut x, T0 + 20, j, 1, 40).unwrap();
    wood(&mut x, T0 + 20, j, 2, 20).unwrap();
    for t in [S + 999, S + 5_001, S + 3 * HOUR] {
        x.b.apply(t, X, &Op::Settle { job: j }).unwrap();
    }
    x.b.apply(S + 3 * HOUR, B, &Op::Claim { job: j, to: HOME })
        .unwrap();
    let Outcome::Applied(ev) = x.b.apply(S + 3 * HOUR, X, &Op::Retire { job: j }).unwrap() else {
        panic!()
    };
    let a = ev
        .iter()
        .find_map(|e| match e {
            Event::Receipt { job, accounts, .. } if *job == j => Some(*accounts),
            _ => None,
        })
        .expect("receipt");
    assert!(a.balanced());
    let notes = x.b.cap.custody.take_notes();
    let sum = |f: &dyn Fn(&Note) -> Option<i64>| notes.iter().filter_map(f).sum::<i64>();
    let used = sum(&|n| match n {
        Note::Used { job, qty, .. } if *job == j => Some(*qty),
        _ => None,
    });
    let consumed = sum(&|n| match n {
        Note::Consumed { job, r, qty } if *job == j && *r == Resource::Ore as u8 => Some(*qty),
        _ => None,
    });
    let produced = sum(&|n| match n {
        Note::Produced { job, qty, .. } if *job == j => Some(*qty),
        _ => None,
    });
    assert_eq!(used, a.inputs[0].in_total, "10's use = the job's ore in");
    assert_eq!(consumed, a.inputs[0].consumed);
    assert_eq!(produced, a.output.in_total);
    x.b.check().unwrap();
}

#[test]
fn a_seized_vault_refuses_with_10s_reason() {
    let mut x = fx(Release::Decided, 80);
    let j = x.job;
    x.b.cap.custody.seize_vault(VB, X).unwrap();
    let before = x.b.clone();
    let op = Op::Deposit {
        job: j,
        deposit: 1,
        resource: Resource::Ore,
        amount: 10 * MILLI,
        from: Place::Vault(VB),
    };
    let r = x.b.cap.apply_detailed(T0 + 20, B, &op);
    assert_eq!(
        r,
        Err(Refusal {
            code: CapError::Custody,
            custody: Some(CustodyError::Forbidden)
        })
    );
    assert_eq!(x.b, before);
}
