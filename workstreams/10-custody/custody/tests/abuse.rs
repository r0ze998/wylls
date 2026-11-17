//! Misuse by the custodian, the carrier, the user and the owner; double
//! reservation; replays; concurrent requests; capacity.

mod common;
use common::*;

use wylls_custody::model::fixture::{units, Cast, ORE};
use wylls_custody::model::Error;
use wylls_custody::*;

// ------------------------------------------------------------ the custodian

/// B's general stock, production, sales and other loans never reach A's
/// lot: B can spend only its `STORES`.
#[test]
fn the_custodian_cannot_use_spend_sell_or_relend_the_lot() {
    let (mut c, lot) = stocked(500, 300);
    let b = w(c.b);
    // Sell / send: from the vault's general stock only (0 there).
    assert_eq!(
        c.w.send_caravan(&b, c.vb, c.home(&c.d), ore(1)),
        Err(Error::Insufficient)
    );
    // Its own goods still move: put 50 in the general stock, send 50, not 51.
    let home_b = c.home(&c.b);
    let k = c.w.send_caravan(&b, home_b, c.vb, ore(50)).unwrap();
    c.w.advance(10);
    c.w.settle_caravan(k).unwrap();
    assert_eq!(
        c.w.send_caravan(&b, c.vb, c.home(&c.d), ore(51)),
        Err(Error::Insufficient)
    );
    c.w.send_caravan(&b, c.vb, c.home(&c.d), ore(50)).unwrap();
    // Order, ship, consume, revoke on A's lot.
    let spec = ship_order(&c, c.c, 10, c.vd);
    assert_eq!(
        c.w.set_order(&b, lot, 0, 0, spec),
        Err(custody(CustodyError::NotAuthorized))
    );
    let spec = use_order(&c, c.b, 10, 0);
    assert_eq!(
        c.w.set_order(&b, lot, 0, 0, spec),
        Err(custody(CustodyError::NotAuthorized))
    );
    let seq = c.w.next_seq(&c.b);
    assert_eq!(
        c.w.ship(
            &b,
            seq,
            lot,
            By::Owner,
            units(10),
            ShipTo::OwnPlace(home_b),
            0
        ),
        Err(custody(CustodyError::NotAuthorized))
    );
    assert_eq!(
        c.w.ship(
            &b,
            seq,
            lot,
            By::Order { slot: 0, id: 0 },
            units(10),
            ShipTo::Lot(c.vd),
            0
        ),
        Err(custody(CustodyError::Order))
    );
    assert_eq!(
        c.w.consume(&b, lot, 0, 0, units(1), 0),
        Err(custody(CustodyError::Order))
    );
    // Lend the same room twice: the vault's CAP bounds stores + quotas.
    assert_eq!(
        c.w.open_lot(&b, c.vb, c.e, ORE, units(501)),
        Err(custody(CustodyError::Capacity))
    );
    c.w.open_lot(&b, c.vb, c.e, ORE, units(500)).unwrap();
    // Shrink or close under the goods.
    assert_eq!(
        c.w.set_quota(&b, lot, units(299)),
        Err(custody(CustodyError::NotEmpty))
    );
    assert_eq!(
        c.w.close_lot(Some(&b), lot),
        Err(custody(CustodyError::NotEmpty))
    );
    assert_eq!(c.w.close_vault(&b, c.vb), Err(Error::NotEmpty));
    assert_eq!(held(&c, &lot), 300);
    ok(&c);
}

/// B's own caravans into its vault cannot fill the room promised to lots:
/// the general stock is capped at CAP − CUSTODY_QUOTA (what is beyond is
/// the existing clamp's loss, B's own, and logged by credited < cargo).
#[test]
fn the_custodians_deliveries_cannot_eat_the_lots_room() {
    let (mut c, lot) = stocked(900, 0);
    let b = w(c.b);
    let k = c.w.send_caravan(&b, c.home(&c.b), c.vb, ore(100)).unwrap();
    c.w.advance(10);
    c.w.settle_caravan(k).unwrap();
    assert_eq!(general(&c, &c.vb), 100, "CAP 1000 − quota 900");
    // A can still fill all 900.
    let home = c.home(&c.a);
    let seq = c.w.next_seq(&c.a);
    let k = c.w.deposit(&w(c.a), seq, home, lot, units(900), 0).unwrap();
    c.w.advance(10);
    c.w.settle_custody(k).unwrap();
    assert_eq!(held(&c, &lot), 900);
    ok(&c);
}

#[test]
fn opening_needs_the_custodians_wallet_and_another_owner_and_ore() {
    let mut c = Cast::new();
    assert_eq!(
        c.w.open_lot(&Cast::session(c.b), c.vb, c.a, ORE, units(10)),
        Err(custody(CustodyError::WalletRequired))
    );
    assert_eq!(
        c.w.open_lot(&w(c.a), c.vb, c.a, ORE, units(10)),
        Err(custody(CustodyError::NotAuthorized))
    );
    assert_eq!(
        c.w.open_lot(&w(c.b), c.vb, c.b, ORE, units(10)),
        Err(custody(CustodyError::SelfDealing))
    );
    assert_eq!(
        c.w.open_lot(&w(c.b), c.vb, c.a, 0, units(10)),
        Err(custody(CustodyError::Resource))
    );
    assert_eq!(
        c.w.open_lot(&w(c.b), c.vb, c.a, ORE, 1_500),
        Err(custody(CustodyError::Quantity))
    );
    c.w.open_lot(&w(c.b), c.vb, c.a, ORE, units(10)).unwrap();
    assert_eq!(
        c.w.open_lot(&w(c.b), c.vb, c.a, ORE, units(10)),
        Err(Error::BadData),
        "one lot per owner"
    );
    ok(&c);
}

// ------------------------------------------------------------ the carrier

#[test]
fn a_carrier_moves_only_what_and_where_it_was_allowed() {
    let (mut c, lot) = stocked(500, 300);
    let ld = lot_d(&mut c, 300);
    let spec = ship_order(&c, c.c, 100, c.vd);
    let id = c.w.set_order(&w(c.a), lot, 0, 0, spec).unwrap();
    let cc = w(c.c);
    let seq = c.w.next_seq(&c.c);
    let by = By::Order { slot: 0, id };
    // Wrong destination, home, too much, session key, wrong id, the owner's
    // own path.
    let v_e = {
        let e = c.e;
        c.w.add_vault(e, 6, 0, 5, units(500))
    };
    assert_eq!(
        c.w.ship(&cc, seq, lot, by, units(100), ShipTo::Lot(v_e), 0),
        Err(custody(CustodyError::Order))
    );
    assert_eq!(
        c.w.ship(
            &cc,
            seq,
            lot,
            by,
            units(100),
            ShipTo::OwnPlace(c.home(&c.c)),
            0
        ),
        Err(custody(CustodyError::Order))
    );
    assert_eq!(
        c.w.ship(&cc, seq, lot, by, units(101), ShipTo::Lot(c.vd), 0),
        Err(custody(CustodyError::Insufficient))
    );
    assert_eq!(
        c.w.ship(
            &Cast::session(c.c),
            seq,
            lot,
            by,
            units(50),
            ShipTo::Lot(c.vd),
            0
        ),
        Err(custody(CustodyError::WalletRequired))
    );
    assert_eq!(
        c.w.ship(
            &cc,
            seq,
            lot,
            By::Order {
                slot: 0,
                id: id + 1
            },
            units(50),
            ShipTo::Lot(c.vd),
            0
        ),
        Err(custody(CustodyError::Order))
    );
    assert_eq!(
        c.w.ship(&cc, seq, lot, By::Owner, units(50), ShipTo::Lot(c.vd), 0),
        Err(custody(CustodyError::NotAuthorized))
    );
    // Someone else holding the order's id.
    let seq_e = c.w.next_seq(&c.e);
    assert_eq!(
        c.w.ship(&w(c.e), seq_e, lot, by, units(50), ShipTo::Lot(c.vd), 0),
        Err(custody(CustodyError::NotAuthorized))
    );
    // In two parts, then nothing more.
    c.w.ship(&cc, seq, lot, by, units(60), ShipTo::Lot(c.vd), 0)
        .unwrap();
    c.w.ship(&cc, seq + 1, lot, by, units(40), ShipTo::Lot(c.vd), 0)
        .unwrap();
    assert_eq!(
        c.w.ship(&cc, seq + 2, lot, by, units(1), ShipTo::Lot(c.vd), 0),
        Err(custody(CustodyError::Order))
    );
    assert_eq!(held(&c, &lot), 200);
    assert_eq!(c.w.lot(&ld).unwrap().incoming(), units(100));
    ok(&c);
}

/// The carrier's caravan is the carrier's (faction, sequence); the cargo
/// is not: an ordinary settlement cannot credit it to the destination's
/// keeper, and the carrier gains nothing.
#[test]
fn a_custody_caravan_settles_only_into_the_owners_lot() {
    let (mut c, lot) = stocked(500, 300);
    let ld = lot_d(&mut c, 300);
    let k = carry(&mut c, lot, 200);
    let cv = c.w.caravan(&k).unwrap();
    assert_eq!(cv.owner, c.c);
    assert_eq!(cv.faction, c.w.citizens[&c.c].faction);
    assert_eq!(cv.custody_owner_tag, c.w.tag(&c.a));
    c.w.advance(20);
    assert_eq!(c.w.settle_caravan(k), Err(Error::CustodyCaravan));
    c.w.settle_custody(k).unwrap();
    assert_eq!(held(&c, &ld), 200);
    assert_eq!(general(&c, &c.vd), 0);
    assert_eq!(c.w.settle_custody(k), Err(Error::NotFound), "settled once");
    ok(&c);
}

// ------------------------------------------------------------ the user

#[test]
fn a_user_consumes_within_its_order_only() {
    let (mut c, lot) = stocked(500, 300);
    let spec = use_order(&c, c.b, 50, 7);
    let id = c.w.set_order(&w(c.a), lot, 2, 0, spec).unwrap();
    let b = w(c.b);
    assert_eq!(
        c.w.consume(&b, lot, 2, id, units(51), 7),
        Err(custody(CustodyError::Insufficient))
    );
    assert_eq!(
        c.w.consume(&b, lot, 2, id, units(10), 6),
        Err(custody(CustodyError::Order))
    );
    assert_eq!(
        c.w.consume(&w(c.c), lot, 2, id, units(10), 7),
        Err(custody(CustodyError::NotAuthorized))
    );
    assert_eq!(
        c.w.consume(&b, lot, 1, id, units(10), 7),
        Err(custody(CustodyError::Order))
    );
    c.w.consume(&b, lot, 2, id, units(50), 7).unwrap();
    assert_eq!(
        c.w.consume(&b, lot, 2, id, units(1), 7),
        Err(custody(CustodyError::Order))
    );
    // A ship order cannot be consumed, a use order cannot ship.
    let spec = ship_order(&c, c.b, 10, c.vd);
    let sid = c.w.set_order(&w(c.a), lot, 0, 1, spec).unwrap();
    assert_eq!(
        c.w.consume(&b, lot, 0, sid, units(1), 0),
        Err(custody(CustodyError::Order))
    );
    let spec = use_order(&c, c.c, 10, 0);
    let uid = c.w.set_order(&w(c.a), lot, 1, 2, spec).unwrap();
    let seq = c.w.next_seq(&c.c);
    assert_eq!(
        c.w.ship(
            &w(c.c),
            seq,
            lot,
            By::Order { slot: 1, id: uid },
            units(1),
            ShipTo::Lot(c.vd),
            0
        ),
        Err(custody(CustodyError::Order))
    );
    // Purpose 0 = any processing.
    c.w.consume(&w(c.c), lot, 1, uid, units(10), 99).unwrap();
    assert_eq!(held(&c, &lot), 240);
    ok(&c);
}

// ------------------------------------------------------------ double reservation

#[test]
fn the_same_goods_cannot_be_promised_twice() {
    let (mut c, lot) = stocked(500, 300);
    let a = w(c.a);
    let s1 = ship_order(&c, c.c, 200, c.vd);
    c.w.set_order(&a, lot, 0, 0, s1).unwrap();
    let s2 = use_order(&c, c.b, 101, 0);
    assert_eq!(
        c.w.set_order(&a, lot, 1, 1, s2),
        Err(custody(CustodyError::Insufficient))
    );
    let s2 = use_order(&c, c.b, 100, 0);
    c.w.set_order(&a, lot, 1, 1, s2).unwrap();
    // Nothing left for the owner either.
    let seq = c.w.next_seq(&c.a);
    let home = c.home(&c.a);
    assert_eq!(
        c.w.ship(&a, seq, lot, By::Owner, units(1), ShipTo::OwnPlace(home), 0),
        Err(custody(CustodyError::Insufficient))
    );
    // A live slot cannot be overwritten.
    let s3 = use_order(&c, c.e, 1, 0);
    assert_eq!(
        c.w.set_order(&a, lot, 0, 2, s3),
        Err(custody(CustodyError::NoSlot))
    );
    assert_eq!(c.w.lot(&lot).unwrap().reserved(c.w.bell), units(300));
    ok(&c);
}

#[test]
fn an_expired_order_lapses_and_cannot_be_spent() {
    let (mut c, lot) = stocked(500, 300);
    let mut s = ship_order(&c, c.c, 300, c.vd);
    s.expires_bell = c.w.bell + 5;
    let id = c.w.set_order(&w(c.a), lot, 0, 0, s).unwrap();
    lot_d(&mut c, 300);
    c.w.advance(5);
    let seq = c.w.next_seq(&c.c);
    assert_eq!(
        c.w.ship(
            &w(c.c),
            seq,
            lot,
            By::Order { slot: 0, id },
            units(10),
            ShipTo::Lot(c.vd),
            0
        ),
        Err(custody(CustodyError::Expired))
    );
    assert_eq!(c.w.lot(&lot).unwrap().available(c.w.bell), units(300));
    // Orders are bounded in time.
    let mut s = use_order(&c, c.b, 1, 0);
    s.expires_bell = c.w.bell + MAX_ORDER_BELLS + 1;
    assert_eq!(
        c.w.set_order(&w(c.a), lot, 1, 1, s),
        Err(custody(CustodyError::Expired))
    );
    ok(&c);
}

// ------------------------------------------------------------ replays

#[test]
fn replayed_requests_are_stale() {
    let (mut c, lot) = stocked(500, 300);
    let a = w(c.a);
    let s = use_order(&c, c.b, 10, 0);
    c.w.set_order(&a, lot, 0, 0, s).unwrap();
    assert_eq!(
        c.w.set_order(&a, lot, 1, 0, s),
        Err(custody(CustodyError::Stale)),
        "same nonce"
    );
    let home = c.home(&c.a);
    let seq = c.w.next_seq(&c.a);
    c.w.deposit(&a, seq, home, lot, units(10), 0).unwrap();
    assert_eq!(
        c.w.deposit(&a, seq, home, lot, units(10), 0),
        Err(custody(CustodyError::Stale))
    );
    let seq = c.w.next_seq(&c.a);
    c.w.ship(
        &a,
        seq,
        lot,
        By::Owner,
        units(10),
        ShipTo::OwnPlace(home),
        0,
    )
    .unwrap();
    assert_eq!(
        c.w.ship(
            &a,
            seq,
            lot,
            By::Owner,
            units(10),
            ShipTo::OwnPlace(home),
            0
        ),
        Err(custody(CustodyError::Stale))
    );
    ok(&c);
}

// ------------------------------------------------------------ concurrency

type Op = Box<dyn FnMut(&mut wylls_custody::model::World) -> bool>;

/// Two requests built on the same state: whichever runs first wins, the
/// other is refused, and the books balance either way.
#[test]
fn concurrent_requests_serialise_either_way() {
    for first in [0, 1] {
        let (mut c, lot) = stocked(500, 300);
        lot_d(&mut c, 400);
        let s = ship_order(&c, c.c, 300, c.vd);
        let id = c.w.set_order(&w(c.a), lot, 0, 0, s).unwrap();
        let home = c.home(&c.a);
        let seq_a = c.w.next_seq(&c.a);
        let seq_c = c.w.next_seq(&c.c);
        let (a, cc, vd) = (w(c.a), w(c.c), c.vd);
        // The carrier ships 300 while the owner revokes and withdraws 300.
        let mut ops: Vec<Op> = vec![
            Box::new(move |w| {
                w.ship(
                    &cc,
                    seq_c,
                    lot,
                    By::Order { slot: 0, id },
                    units(300),
                    ShipTo::Lot(vd),
                    0,
                )
                .is_ok()
            }),
            Box::new(move |w| {
                w.atomic(|w| {
                    w.revoke_order(&a, lot, 0, id)?;
                    w.ship(
                        &a,
                        seq_a,
                        lot,
                        By::Owner,
                        units(300),
                        ShipTo::OwnPlace(home),
                        0,
                    )
                })
                .is_ok()
            }),
        ];
        let r0 = ops[first](&mut c.w);
        let r1 = ops[1 - first](&mut c.w);
        assert!(r0, "the first request succeeds");
        assert!(!r1, "the second finds the goods gone");
        assert_eq!(held(&c, &lot), 0);
        ok(&c);
    }
}

#[test]
fn concurrent_deposits_cannot_overfill_a_lot() {
    let (mut c, lot) = stocked(300, 0);
    let home = c.home(&c.a);
    let a = w(c.a);
    let seq = c.w.next_seq(&c.a);
    let k1 = c.w.deposit(&a, seq, home, lot, units(200), 0).unwrap();
    // A second caravan for the remaining 100 at most: room is reserved at
    // departure, so arrival never finds the lot full.
    assert_eq!(
        c.w.deposit(&a, seq + 1, home, lot, units(101), 0),
        Err(custody(CustodyError::Capacity))
    );
    let k2 = c.w.deposit(&a, seq + 1, home, lot, units(100), 0).unwrap();
    c.w.advance(10);
    c.w.settle_custody(k2).unwrap();
    c.w.settle_custody(k1).unwrap();
    assert_eq!(held(&c, &lot), 300);
    // Inbound slots are bounded too.
    let (mut c, lot) = stocked(900, 0);
    let seq = c.w.next_seq(&c.a);
    for i in 0..MAX_INBOUND as u32 {
        c.w.deposit(&a, seq + i, home, lot, units(1), 0).unwrap();
    }
    assert_eq!(
        c.w.deposit(&a, seq + MAX_INBOUND as u32, home, lot, units(1), 0),
        Err(custody(CustodyError::NoSlot))
    );
    ok(&c);
}

// ------------------------------------------------------------ session keys

#[test]
fn a_session_key_moves_goods_only_home_and_may_revoke() {
    let (mut c, lot) = stocked(500, 300);
    lot_d(&mut c, 300);
    let s = Cast::session(c.a);
    let home = c.home(&c.a);
    let seq = c.w.next_seq(&c.a);
    assert_eq!(
        c.w.ship(&s, seq, lot, By::Owner, units(10), ShipTo::Lot(c.vd), 0),
        Err(custody(CustodyError::WalletRequired))
    );
    let spec = use_order(&c, c.b, 10, 0);
    assert_eq!(
        c.w.set_order(&s, lot, 0, 0, spec),
        Err(custody(CustodyError::WalletRequired))
    );
    assert_eq!(
        c.w.deposit(&s, seq, home, lot, units(10), 0),
        Err(Error::WalletRequired)
    );
    c.w.ship(
        &s,
        seq,
        lot,
        By::Owner,
        units(10),
        ShipTo::OwnPlace(home),
        0,
    )
    .unwrap();
    let id = c.w.set_order(&w(c.a), lot, 0, 0, spec).unwrap();
    assert_eq!(c.w.revoke_order(&s, lot, 0, id), Ok(units(10)));
    ok(&c);
}
