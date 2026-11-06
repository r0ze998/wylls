//! Fixtures on workstream 10's one table of lots (`LotCustody`).
#![allow(dead_code)]

use permutation_rules::fixed::MILLI;
use permutation_rules::frontier::holding::{Resource, HOUR};
use wylls_capacity::custody::{Custody, Key};
use wylls_capacity::ledger::{Op, Outcome};
use wylls_capacity::model::{Actor, GrantId, JobId, Place};
use wylls_capacity::policy::Policies;
use wylls_capacity::testkit::*;
use wylls_capacity_bridge10::*;
use wylls_custody::Lot;
use wylls_custody_adapter_09::LotCustody;

/// The keeper of both vaults and the owner of the lent lot.
pub const V: Actor = Actor::test(0xD4);
pub const M: Actor = Actor::test(0x4D);
/// M's vault (tile 6) and B's own vault (tile 5), in the facility's
/// province (0, 0).
pub const VM: u64 = 5;
pub const VB: u64 = 7;
pub const S: i64 = T0 + HOUR;
pub const HOME: Place = Place::Caravan(78);

pub struct Fx {
    pub b: Bridge,
    pub g: GrantId,
    pub job: JobId,
    pub order: u32,
}

/// A's facility (3 copies, 2 lent) and B's grant; M's lot of 100 ore with
/// a use order of `order_units` for B; B's own lot of 100 ore; 100 wood of
/// B's in caravan 77; B's job 1: 2 copies, 20 arms over [S, S + 3 h).
pub fn fx(release: Release, order_units: i64) -> Fx {
    let mut cu = LotCustody::new();
    cu.add_vault(VM, 0, 0, 6, V, 5_000 * MILLI);
    cu.add_vault(VB, 0, 0, 5, V, 5_000 * MILLI);
    cu.open_lot(VM, V, M, Resource::Ore, 200 * MILLI).unwrap();
    cu.open_lot(VB, V, B, Resource::Ore, 200 * MILLI).unwrap();
    cu.import(
        Key {
            scope: 1,
            kind: 100,
            n: 0,
        },
        Place::Vault(VM),
        M,
        Resource::Ore,
        100 * MILLI,
    )
    .unwrap();
    cu.import(
        Key {
            scope: 1,
            kind: 100,
            n: 1,
        },
        Place::Vault(VB),
        B,
        Resource::Ore,
        100 * MILLI,
    )
    .unwrap();
    cu.import(
        Key {
            scope: 1,
            kind: 100,
            n: 2,
        },
        Place::Caravan(77),
        B,
        Resource::Wood,
        100 * MILLI,
    )
    .unwrap();
    let order = cu
        .set_use_order(
            VM,
            M,
            B,
            0,
            order_units * MILLI,
            500,
            PURPOSE_WORKSHOP_ARMS,
            0,
        )
        .unwrap();
    cu.take_notes();
    let (w, f) = world_with(cu, 3, 2, 2, Policies::PROVISIONAL);
    let mut b = Bridge::new(w, T0);
    b.release = release;
    let g = GrantId {
        facility: f,
        seq: 1,
    };
    let job = reserve(&mut b, g, 1, S);
    Fx { b, g, job, order }
}

/// B reserves job `seq`: 2 copies, 20 arms over [start, start + 3 h).
pub fn reserve(b: &mut Bridge, g: GrantId, seq: u32, start: i64) -> JobId {
    let j = JobId { grant: g, seq };
    let now = (start - HOUR).max(b.cap.clock).max(T0 + 10);
    b.apply(
        now,
        B,
        &Op::Reserve {
            job: j,
            units: 2,
            start,
            end: start + 3 * HOUR,
            max_output: 20 * MILLI,
        },
    )
    .unwrap();
    j
}

/// M's ore into `job` under B's order.
pub fn ore(
    x: &mut Fx,
    now: i64,
    job: JobId,
    deposit: u64,
    units: u32,
) -> Result<Outcome, BridgeError> {
    let o = x.order;
    x.b.deposit_from_lot(now, B, job, deposit, VM, M, 0, o, units)
}

/// B's own wood (caravan 77) into `job`.
pub fn wood(
    x: &mut Fx,
    now: i64,
    job: JobId,
    deposit: u64,
    units: i64,
) -> Result<Outcome, BridgeError> {
    x.b.apply(
        now,
        B,
        &Op::Deposit {
            job,
            deposit,
            resource: Resource::Wood,
            amount: units * MILLI,
            from: Place::Caravan(77),
        },
    )
}

/// M's lot as 10 holds it.
pub fn m_lot(x: &Fx) -> Lot {
    x.b.cap.custody.lot(VM, M, Resource::Ore as u8).unwrap()
}

pub fn b_lot(x: &Fx) -> Lot {
    x.b.cap.custody.lot(VB, B, Resource::Ore as u8).unwrap()
}

pub fn key_m() -> LotKey {
    LotKey {
        vault: VM,
        owner: M,
    }
}
