#![allow(dead_code)]

use wylls_custody::model::fixture::{units, Cast, ORE};
use wylls_custody::model::{CaravanKey, Error, LotKey, World};
use wylls_custody::*;

pub use wylls_custody::model::fixture::ore;

pub fn w(k: [u8; 32]) -> wylls_custody::model::Signer {
    Cast::wallet(k)
}

/// Every invariant, and a restart that changes nothing.
pub fn ok(c: &Cast) {
    c.w.check().unwrap();
    assert_eq!(World::restore(&c.w.snapshot()), c.w);
}

pub fn custody(e: CustodyError) -> Error {
    Error::Custody(e)
}

/// B's lot for A (quota `quota`) holding `held` units, deposited and
/// settled.
pub fn stocked(quota: i64, held: i64) -> (Cast, LotKey) {
    let mut c = Cast::new();
    let lot = c.w.open_lot(&w(c.b), c.vb, c.a, ORE, units(quota)).unwrap();
    if held > 0 {
        let home = c.home(&c.a);
        let seq = c.w.next_seq(&c.a);
        let k =
            c.w.deposit(&w(c.a), seq, home, lot, units(held), 0)
                .unwrap();
        c.w.advance(20);
        c.w.settle_custody(k).unwrap();
    }
    ok(&c);
    (c, lot)
}

pub fn ship_order(c: &Cast, grantee: [u8; 32], qty: i64, dst: PlaceRef) -> OrderSpec {
    OrderSpec {
        kind: ORDER_SHIP,
        grantee,
        qty: units(qty),
        expires_bell: c.w.bell + 100,
        dst,
        purpose: 0,
    }
}

pub fn use_order(c: &Cast, grantee: [u8; 32], qty: i64, purpose: u16) -> OrderSpec {
    OrderSpec {
        kind: ORDER_USE,
        grantee,
        qty: units(qty),
        expires_bell: c.w.bell + 100,
        dst: PlaceRef::default(),
        purpose,
    }
}

/// A lot for A in D's vault.
pub fn lot_d(c: &mut Cast, quota: i64) -> LotKey {
    c.w.open_lot(&w(c.d), c.vd, c.a, ORE, units(quota)).unwrap()
}

/// C ships `qty` from `lot` to D's vault under a fresh order.
pub fn carry(c: &mut Cast, lot: LotKey, qty: i64) -> CaravanKey {
    let nonce = c.w.lot(&lot).unwrap().nonce;
    let slot =
        c.w.lot(&lot)
            .unwrap()
            .orders
            .iter()
            .position(|o| !o.live(c.w.bell))
            .unwrap() as u8;
    let spec = ship_order(c, c.c, qty, c.vd);
    let id = c.w.set_order(&w(c.a), lot, slot, nonce, spec).unwrap();
    let seq = c.w.next_seq(&c.c);
    c.w.ship(
        &w(c.c),
        seq,
        lot,
        By::Order { slot, id },
        units(qty),
        ShipTo::Lot(c.vd),
        0,
    )
    .unwrap()
}

pub fn held(c: &Cast, lot: &LotKey) -> i64 {
    c.w.lot(lot).unwrap().held / 1000
}

pub fn general(c: &Cast, v: &PlaceRef) -> i64 {
    c.w.vault(v).unwrap().stores[ORE as usize] / 1000
}
