//! A world for the contract tests: ⑨'s facility and pool (from ⑨'s own
//! testkit pieces) with custody by [`LotCustody`], a vault `V` beside the
//! facility kept by `K`, and lots of B and C in it.
#![allow(dead_code)]

use borsh::{BorshDeserialize, BorshSerialize};
use permutation_rules::fixed::MILLI;
use permutation_rules::frontier::holding::{Resource, HOUR};
use wylls_capacity::custody::Key;
use wylls_capacity::ledger::{Harness, Op, Outcome};
use wylls_capacity::model::{Actor, FacilityId, GrantId, JobId, Place};
use wylls_capacity::policy::Policies;
use wylls_capacity::testkit::{self, B, C, GRANT_DAYS, SITE_A, T0};
use wylls_capacity::CapError;
use wylls_custody_adapter_09::LotCustody;

pub type W = Harness<LotCustody>;

/// The vault's keeper.
pub const K: Actor = Actor::test(0x4B);
/// A vault beside the facility (A's province, tile 5) and one far away.
pub const V: u64 = 1;
pub const FAR: u64 = 2;
/// Job start used by the scenarios.
pub const S: i64 = T0 + HOUR;

pub fn u(n: i64) -> i64 {
    n * MILLI
}

/// ⑨'s fixture world (testkit::world) rebuilt over `LotCustody`: 3
/// workshops, 2 lent, grants 1 (B) and 2 (C) of 2 units each. Vault V
/// (cap 100) beside the facility with lots of B and C (quota 30 ore each),
/// B's holding 20 ore and C's 10; vault FAR elsewhere with a lot of B.
pub fn world(policies: Policies) -> (W, FacilityId) {
    let mut cu = LotCustody::new();
    cu.add_vault(V, SITE_A.p, SITE_A.q, 5, K, u(100));
    cu.add_vault(FAR, 7, -3, 0, K, u(100));
    cu.open_lot(V, K, B, Resource::Ore, u(30)).unwrap();
    cu.open_lot(V, K, C, Resource::Ore, u(30)).unwrap();
    cu.open_lot(FAR, K, B, Resource::Ore, u(30)).unwrap();
    cu.try_import(arrival(1), Place::Vault(V), B, Resource::Ore, u(20))
        .unwrap();
    cu.try_import(arrival(2), Place::Vault(V), C, Resource::Ore, u(10))
        .unwrap();
    cu.try_import(arrival(3), Place::Vault(FAR), B, Resource::Ore, u(20))
        .unwrap();
    cu.take_notes();
    let mut w = Harness::new(cu);
    w.add_facility(testkit::facility(3));
    let f = w.facilities[&SITE_A].id();
    w.apply(
        T0,
        testkit::A,
        &Op::OpenPool {
            facility: f,
            policies,
        },
    )
    .unwrap();
    w.apply(
        T0,
        testkit::A,
        &Op::Lend {
            facility: f,
            units: 2,
            seq: 0,
        },
    )
    .unwrap();
    for (seq, user) in [(1, B), (2, C)] {
        w.apply(
            T0,
            testkit::A,
            &Op::Grant {
                grant: GrantId { facility: f, seq },
                user,
                recipe: wylls_capacity::recipe::RECIPE_ARMS,
                max_units: 2,
                max_output: 100 * MILLI,
                from: T0,
                until: T0 + GRANT_DAYS * 86_400,
            },
        )
        .unwrap();
    }
    w.custody.check().unwrap();
    (w, f)
}

/// An arrival's key (scopes far above any job uid).
pub fn arrival(n: u64) -> Key {
    Key {
        scope: 1 << 40,
        kind: 100,
        n,
    }
}

pub fn job(f: FacilityId, grant: u32, seq: u32) -> JobId {
    JobId {
        grant: GrantId {
            facility: f,
            seq: grant,
        },
        seq,
    }
}

/// Goods of `who` arrived at the facility in caravan `id`.
pub fn caravan(w: &mut W, who: Actor, id: u64, r: Resource, units: i64) {
    w.custody
        .try_import(
            Key {
                scope: 1 << 41,
                kind: 100,
                n: id * 8 + r as u64,
            },
            Place::Caravan(id),
            who,
            r,
            u(units),
        )
        .unwrap();
}

/// Applies and checks every invariant after (applied or refused).
pub fn ap(w: &mut W, now: i64, who: Actor, op: &Op) -> Result<Outcome, CapError> {
    let r = w.apply(now, who, op);
    w.custody
        .check()
        .unwrap_or_else(|e| panic!("after {op:?} -> {r:?}: {e}"));
    r
}

pub fn reserve(w: &mut W, now: i64, who: Actor, j: JobId, max_arms: i64) {
    ap(
        w,
        now,
        who,
        &Op::Reserve {
            job: j,
            units: 2,
            start: S,
            end: S + 3 * HOUR,
            max_output: u(max_arms),
        },
    )
    .unwrap();
}

#[allow(clippy::too_many_arguments)]
pub fn deposit(
    w: &mut W,
    now: i64,
    who: Actor,
    j: JobId,
    n: u64,
    r: Resource,
    units_milli: i64,
    from: Place,
) -> Result<Outcome, CapError> {
    ap(
        w,
        now,
        who,
        &Op::Deposit {
            job: j,
            deposit: n,
            resource: r,
            amount: units_milli,
            from,
        },
    )
}

/// A restart: the whole world through its bytes.
pub fn restart(w: &W) -> W {
    let b = borsh::to_vec(w).unwrap();
    W::try_from_slice(&b).unwrap()
}

pub fn bytes<T: BorshSerialize>(t: &T) -> Vec<u8> {
    borsh::to_vec(t).unwrap()
}

pub fn held(w: &W, v: u64, who: Actor) -> i64 {
    w.custody.lot(v, who, Resource::Ore as u8).unwrap().held
}
