//! Failures: raids, seizure ("occupation" of the custodian's vault), a
//! destination lost on the way, parties leaving mid-way, a revocation
//! mid-flight, tower wear, restarts (period boundaries: `continuity.rs`). Nothing vanishes:
//! every quantity is held, on its way, withdrawn, used, or a loss with a
//! cause and a counterparty.

mod common;
use common::*;

use wylls_custody::model::fixture::{units, Cast, ORE};
use wylls_custody::model::{Error, Event, Whereabouts, World};
use wylls_custody::*;

fn unknowns(c: &Cast) -> Vec<&'static str> {
    c.w.whereabouts(c.w.tag(&c.a))
        .into_iter()
        .filter_map(|x| match x {
            Whereabouts::Unknown { why, .. } => Some(why),
            _ => None,
        })
        .collect()
}

// ------------------------------------------------------------ raids (J2)

/// A raider takes the custody caravan: under J2 the whole caravan becomes
/// the raider's. Until the raid is settled the goods are "unknown"; after
/// the take the loss is confirmed at ReconcileLot as `Raided` to the
/// raider, and the caravan settles as an ordinary one into the raider's
/// holding.
#[test]
fn a_taken_custody_caravan_is_a_confirmed_loss_to_the_raider() {
    let (mut c, lot) = stocked(500, 300);
    let ld = lot_d(&mut c, 300);
    let k = carry(&mut c, lot, 200);
    c.w.advance(1);
    c.w.open_raid(k, c.e).unwrap();
    assert_eq!(unknowns(&c), vec!["raid open: take or burn undecided"]);
    c.w.advance(20);
    assert_eq!(
        c.w.settle_custody(k),
        Err(Error::RaidState),
        "no settlement while a raid is open"
    );
    assert_eq!(
        c.w.settle_raid(Some(&w(c.c)), k, true),
        Err(Error::NotOwner),
        "only the raider decides"
    );
    c.w.settle_raid(Some(&w(c.e)), k, true).unwrap();
    ok(&c);
    assert_eq!(
        unknowns(&c),
        vec!["taken by a raider: loss confirmed at ReconcileLot"]
    );
    // The taken caravan is no longer custody: the destination lot cannot
    // receive it, the raider's settlement can.
    assert_eq!(c.w.settle_custody(k), Err(Error::CustodyCaravan));
    c.w.reconcile(ld).unwrap();
    assert_eq!(
        c.w.losses(c.w.tag(&c.a)).get(&Loss::Raided),
        Some(&units(200))
    );
    c.w.advance(20);
    let home_e = c.home(&c.e);
    c.w.settle_caravan(k).unwrap();
    assert_eq!(c.w.holdings[&home_e].stores[ORE as usize], units(200));
    let to = c.w.log.iter().find_map(|e| match e {
        Event::Loss {
            cause: Loss::Raided,
            to,
            ..
        } => Some(*to),
        _ => None,
    });
    assert_eq!(to, Some(c.w.tag(&c.e)), "the loss names the raider");
    // Reconciling once more changes nothing.
    assert_eq!(c.w.reconcile(ld), Err(custody(CustodyError::State)));
    assert_eq!(held(&c, &lot), 100);
    assert_eq!(held(&c, &ld), 0);
    ok(&c);
}

/// The reconciliation also works after the raider's caravan is closed.
#[test]
fn a_taken_caravan_already_closed_is_reconciled_too() {
    let (mut c, lot) = stocked(500, 300);
    let ld = lot_d(&mut c, 300);
    let k = carry(&mut c, lot, 100);
    c.w.open_raid(k, c.e).unwrap();
    c.w.settle_raid(None, k, true).unwrap(); // DefaultRaid
    c.w.advance(30);
    c.w.settle_caravan(k).unwrap();
    assert!(c.w.caravan(&k).is_err());
    c.w.reconcile(ld).unwrap();
    assert_eq!(
        c.w.losses(c.w.tag(&c.a)).get(&Loss::Raided),
        Some(&units(100))
    );
    ok(&c);
}

#[test]
fn a_burned_custody_caravan_settles_empty_and_logs_the_burn() {
    let (mut c, lot) = stocked(500, 300);
    let ld = lot_d(&mut c, 300);
    let k = carry(&mut c, lot, 200);
    c.w.open_raid(k, c.e).unwrap();
    c.w.settle_raid(Some(&w(c.e)), k, false).unwrap();
    c.w.advance(20);
    let st = c.w.settle_custody(k).unwrap();
    assert_eq!((st.delivered, st.burned), (0, units(200)));
    assert_eq!(
        c.w.losses(c.w.tag(&c.a)).get(&Loss::Burned),
        Some(&units(200))
    );
    assert_eq!(c.w.lot(&ld).unwrap().incoming(), 0, "the room is released");
    let _ = lot;
    ok(&c);
}

/// The carrier cannot raid its own load (a clash never raids its own
/// faction; RaidDomestic needs another owner), so a carrier cannot turn a
/// custody caravan into its own by itself.
#[test]
fn the_carrier_cannot_take_the_load_itself() {
    let (mut c, lot) = stocked(500, 300);
    lot_d(&mut c, 300);
    let k = carry(&mut c, lot, 100);
    assert_eq!(c.w.open_raid(k, c.c), Err(Error::RaidState));
    ok(&c);
}

// ------------------------------------------------------------ seizure / occupation

/// E seizes B's vault while it keeps A's lot. The adopted rule (stage 2 §5,
/// 2026-10-23): the lot's claim is void, the goods are the captor's. Until
/// ReconcileLot the lot is frozen (no one may move it); then the loss is
/// confirmed as `Seized` to the captor and the goods are the vault's
/// general stock.
#[test]
fn a_seized_vault_freezes_then_forfeits_its_lots() {
    let (mut c, lot) = stocked(500, 300);
    lot_d(&mut c, 300);
    let s = use_order(&c, c.b, 50, 0);
    let uid = c.w.set_order(&w(c.a), lot, 0, 0, s).unwrap();
    let vb2 = c.w.seize_vault(&w(c.e), c.vb).unwrap();
    assert_eq!(vb2.gen, 2);
    let fr: Vec<_> =
        c.w.whereabouts(c.w.tag(&c.a))
            .into_iter()
            .filter(|x| matches!(x, Whereabouts::Frozen { .. }))
            .collect();
    assert_eq!(fr.len(), 1);
    // Frozen: no one moves it, not the owner, not the user, not the captor.
    let home = c.home(&c.a);
    let seq = c.w.next_seq(&c.a);
    assert_eq!(
        c.w.ship(
            &w(c.a),
            seq,
            lot,
            By::Owner,
            units(1),
            ShipTo::OwnPlace(home),
            0
        ),
        Err(custody(CustodyError::Forfeited))
    );
    assert_eq!(
        c.w.consume(&w(c.b), lot, 0, uid, units(1), 0),
        Err(custody(CustodyError::Forfeited))
    );
    assert_eq!(
        c.w.send_caravan(&w(c.e), vb2, c.home(&c.e), ore(1)),
        Err(Error::Insufficient)
    );
    assert_eq!(
        c.w.deposit(&w(c.a), seq, home, lot, units(1), 0),
        Err(custody(CustodyError::Forfeited))
    );
    // The captor cannot close the vault over unreconciled lots.
    assert_eq!(c.w.close_vault(&w(c.e), vb2), Err(Error::NotEmpty));
    // Anyone reconciles.
    c.w.reconcile(lot).unwrap();
    assert_eq!(general(&c, &vb2), 300);
    let l = c.w.lot(&lot).unwrap();
    assert_eq!(
        (l.state, l.held, l.forfeited),
        (LOT_FORFEITED, 0, units(300))
    );
    assert!(
        l.orders.iter().all(|o| o.kind == ORDER_FREE),
        "orders voided"
    );
    let to = c.w.log.iter().find_map(|e| match e {
        Event::Loss {
            cause: Loss::Seized,
            to,
            qty,
            ..
        } => Some((*to, *qty)),
        _ => None,
    });
    assert_eq!(to, Some((c.w.tag(&c.e), units(300))));
    // The captor now owns it as general stock; the forfeited lot closes.
    c.w.send_caravan(&w(c.e), vb2, c.home(&c.e), ore(300))
        .unwrap();
    c.w.close_lot(None, lot).unwrap();
    ok(&c);
}

/// Retaking the vault does not revive the claim (the adopted rule voids
/// it at the seizure; no safe-vault exception).
#[test]
fn retaking_the_vault_does_not_revive_the_lot() {
    let (mut c, lot) = stocked(500, 300);
    let vb2 = c.w.seize_vault(&w(c.e), c.vb).unwrap();
    let vb3 = c.w.seize_vault(&w(c.b), vb2).unwrap();
    assert_eq!(vb3.gen, 3);
    let seq = c.w.next_seq(&c.a);
    let home = c.home(&c.a);
    assert_eq!(
        c.w.ship(
            &w(c.a),
            seq,
            lot,
            By::Owner,
            units(1),
            ShipTo::OwnPlace(home),
            0
        ),
        Err(custody(CustodyError::Forfeited))
    );
    c.w.reconcile(lot).unwrap();
    assert_eq!(
        general(&c, &vb3),
        300,
        "the holder at reconciliation, B again"
    );
    ok(&c);
}

// ------------------------------------------------------------ the destination lost

/// D's vault is seized while C's caravan is on its way to it. As S1 loses a
/// delivery to a vault of another generation, the cargo is a loss
/// (`DestinationGone`, to the vault's new holder in the log) — recorded,
/// not dropped. Closing the destination under the caravan is refused.
#[test]
fn a_destination_seized_on_the_way_is_a_recorded_loss() {
    let (mut c, lot) = stocked(500, 300);
    let ld = lot_d(&mut c, 300);
    let k = carry(&mut c, lot, 200);
    // D can neither close the lot nor the vault under the caravan.
    assert_eq!(
        c.w.close_lot(Some(&w(c.d)), ld),
        Err(custody(CustodyError::NotEmpty))
    );
    assert_eq!(c.w.close_vault(&w(c.d), c.vd), Err(Error::NotEmpty));
    assert_eq!(
        c.w.set_quota(&w(c.d), ld, units(100)),
        Err(custody(CustodyError::NotEmpty))
    );
    c.w.seize_vault(&w(c.e), c.vd).unwrap();
    c.w.advance(20);
    let st = c.w.settle_custody(k).unwrap();
    assert_eq!((st.delivered, st.dest_gone), (0, units(200)));
    assert_eq!(
        c.w.losses(c.w.tag(&c.a)).get(&Loss::DestinationGone),
        Some(&units(200))
    );
    // The forfeited destination lot: reconcile (nothing held), then close.
    c.w.reconcile(ld).unwrap();
    c.w.close_lot(None, ld).unwrap();
    assert_eq!(held(&c, &lot), 100);
    ok(&c);
}

/// A ship order names the destination's generation: after a seizure of the
/// destination the order cannot be used (the carrier would deliver into
/// a vault that is no longer the one agreed).
#[test]
fn an_order_to_a_seized_destination_cannot_be_used() {
    let (mut c, lot) = stocked(500, 300);
    lot_d(&mut c, 300);
    let s = ship_order(&c, c.c, 100, c.vd);
    let id = c.w.set_order(&w(c.a), lot, 0, 0, s).unwrap();
    let vd2 = c.w.seize_vault(&w(c.e), c.vd).unwrap();
    let seq = c.w.next_seq(&c.c);
    let cc = w(c.c);
    // The old place names a lot that is forfeited; the new one is not the
    // order's.
    assert_eq!(
        c.w.ship(
            &cc,
            seq,
            lot,
            By::Order { slot: 0, id },
            units(100),
            ShipTo::Lot(c.vd),
            0
        ),
        Err(custody(CustodyError::Forfeited))
    );
    assert_eq!(
        c.w.ship(
            &cc,
            seq,
            lot,
            By::Order { slot: 0, id },
            units(100),
            ShipTo::Lot(vd2),
            0
        ),
        Err(custody(CustodyError::Order))
    );
    // The owner revokes and the goods are free again.
    assert_eq!(c.w.revoke_order(&w(c.a), lot, 0, id), Ok(units(100)));
    ok(&c);
}

// ------------------------------------------------------------ leaving mid-way

/// The carrier stops playing after dispatch: settlement is permissionless,
/// so A's goods arrive. The custodian stops playing: A still withdraws
/// without it. A stops playing: no one else can move its lot.
#[test]
fn any_party_leaving_mid_way_leaves_the_goods_the_owners() {
    let (mut c, lot) = stocked(500, 300);
    let ld = lot_d(&mut c, 300);
    let k = carry(&mut c, lot, 100);
    // C is gone: nobody signs for it; a keeper settles.
    c.w.advance(20);
    c.w.settle_custody(k).unwrap();
    assert_eq!(held(&c, &ld), 100);
    // B is gone: A withdraws from B's vault by itself.
    let home = c.home(&c.a);
    let seq = c.w.next_seq(&c.a);
    let k =
        c.w.ship(
            &w(c.a),
            seq,
            lot,
            By::Owner,
            units(200),
            ShipTo::OwnPlace(home),
            0,
        )
        .unwrap();
    c.w.advance(20);
    c.w.settle_caravan(k).unwrap();
    // A is gone: B, D, C have no move on A's lot.
    for who in [c.b, c.c, c.d, c.e] {
        let seq = c.w.next_seq(&who);
        assert!(c
            .w
            .ship(
                &w(who),
                seq,
                ld,
                By::Owner,
                units(1),
                ShipTo::OwnPlace(c.home(&who)),
                0
            )
            .is_err());
        assert!(c.w.close_lot(Some(&w(who)), ld).is_err() || who == c.d);
    }
    assert_eq!(held(&c, &ld), 100);
    ok(&c);
}

/// Revoking an order after the carrier left does not recall the caravan
/// (S1 caravans cannot be recalled): the goods arrive at the agreed lot,
/// still the owner's.
#[test]
fn revoking_mid_flight_keeps_the_caravan_going_to_the_owners_lot() {
    let (mut c, lot) = stocked(500, 300);
    let ld = lot_d(&mut c, 300);
    let s = ship_order(&c, c.c, 200, c.vd);
    let id = c.w.set_order(&w(c.a), lot, 0, 0, s).unwrap();
    let seq = c.w.next_seq(&c.c);
    let k =
        c.w.ship(
            &w(c.c),
            seq,
            lot,
            By::Order { slot: 0, id },
            units(150),
            ShipTo::Lot(c.vd),
            0,
        )
        .unwrap();
    assert_eq!(c.w.revoke_order(&w(c.a), lot, 0, id), Ok(units(50)));
    assert_eq!(
        c.w.ship(
            &w(c.c),
            seq + 1,
            lot,
            By::Order { slot: 0, id },
            units(50),
            ShipTo::Lot(c.vd),
            0
        ),
        Err(custody(CustodyError::Order))
    );
    c.w.advance(20);
    c.w.settle_custody(k).unwrap();
    assert_eq!((held(&c, &lot), held(&c, &ld)), (150, 150));
    ok(&c);
}

// ------------------------------------------------------------ wear, restart

#[test]
fn tower_wear_is_a_logged_loss_at_departure() {
    let (mut c, lot) = stocked(500, 0);
    let home = c.home(&c.a);
    let seq = c.w.next_seq(&c.a);
    let k =
        c.w.deposit(&w(c.a), seq, home, lot, units(300), 54)
            .unwrap();
    assert_eq!(
        c.w.lot(&lot).unwrap().incoming(),
        298_380,
        "300 × (1 − 0.54%) rounded up"
    );
    c.w.advance(20);
    c.w.settle_custody(k).unwrap();
    assert_eq!(c.w.losses(c.w.tag(&c.a)).get(&Loss::Worn), Some(&1_620));
    ok(&c);
}

/// A keeper restarted between any two steps reads the same accounts and
/// finishes the same way; a settlement run twice (resent) does nothing the
/// second time.
#[test]
fn restart_and_resend_between_every_step() {
    let (mut c, lot) = stocked(500, 300);
    let ld = lot_d(&mut c, 300);
    let k = carry(&mut c, lot, 200);
    c.w = World::restore(&c.w.snapshot());
    c.w.advance(20);
    let before = c.w.clone();
    c.w.settle_custody(k).unwrap();
    let after = c.w.clone();
    c.w = World::restore(&c.w.snapshot());
    assert_eq!(c.w.settle_custody(k), Err(Error::NotFound));
    assert_eq!(c.w, after);
    // The settlement from the state before the restart gives the same world.
    let mut again = World::restore(&before.snapshot());
    again.settle_custody(k).unwrap();
    assert_eq!(again, after);
    assert_eq!(held(&c, &ld), 200);
    ok(&c);
}
