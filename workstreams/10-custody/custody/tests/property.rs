//! Random sequences of requests by every party, honest or not, in any
//! order, with restarts. After every step: the invariants of `World::check`
//! (each lot's law, the vaults' counts, every custody caravan expected by
//! its lot, each owner's conservation), and:
//!
//! * a lot's `HELD` only falls by a move its owner signed, a move within an
//!   order signed by that order's grantee, or a forfeiture after a seizure;
//! * a grantee never moves more than the orders it was given;
//! * a vault's general stock only rises by a settlement into it or a
//!   forfeiture;
//! * a restart (bytes round trip) changes nothing.

mod common;

use std::collections::BTreeMap;

use wylls_custody::model::fixture::{units, Cast, ORE};
use wylls_custody::model::{Key, LotKey, Signer, World};
use wylls_custody::*;

struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
    fn pick<T: Copy>(&mut self, xs: &[T]) -> T {
        xs[self.below(xs.len() as u64) as usize]
    }
}

#[derive(Clone, Copy, Debug)]
enum Kind {
    Owner,
    Grantee(u32),
    Forfeit,
    Other,
}

fn run(seed: u64, steps: usize, hits: &mut BTreeMap<String, u64>) {
    let mut r = Rng(seed | 1);
    let mut c = Cast::new();
    for h in c.w.holdings.values_mut() {
        h.stores = common::ore(5_000);
    }
    let people: Vec<Key> = vec![c.a, c.b, c.c, c.d, c.e];
    // A second owner, so lots of two owners share vaults.
    let vaults = [c.vb, c.vd];
    // Spent per (lot, grantee, order id) and granted.
    let mut granted: BTreeMap<(LotKey, Key), i64> = BTreeMap::new();
    let mut spent: BTreeMap<(LotKey, Key), i64> = BTreeMap::new();
    for step in 0..steps {
        let before = c.w.clone();
        let lots: Vec<LotKey> = c.w.lots.keys().copied().collect();
        let caravans: Vec<_> = c.w.caravans.keys().copied().collect();
        let op = r.below(16);
        // Seven in ten requests are well formed (the right signer, nonce,
        // sequence, slot, destination); the rest are anyone's, anything.
        let honest = r.below(10) < 7;
        let mut who = r.pick(&people);
        let mut qty = units(r.below(120) as i64 + 1);
        let lot = if lots.is_empty() {
            None
        } else {
            Some(r.pick(&lots))
        };
        let l = lot.and_then(|k| c.w.lot(&k).ok());
        let live: Vec<(u8, Order)> = l.map_or(vec![], |l| {
            l.orders
                .iter()
                .enumerate()
                .filter(|(_, o)| o.live(c.w.bell))
                .map(|(i, o)| (i as u8, *o))
                .collect()
        });
        if honest {
            match (op, l) {
                (0, _) => {}
                (1..=4, Some(l)) => who = l.owner,
                (5..=7, Some(l)) => {
                    let want = if op == 7 { ORDER_USE } else { ORDER_SHIP };
                    match live.iter().find(|(_, o)| o.kind == want) {
                        Some((_, o)) if r.below(4) != 0 || op == 7 => {
                            who = o.grantee;
                            qty = qty.min(o.qty_left);
                        }
                        _ => {
                            who = l.owner;
                            qty = qty.min(l.available(c.w.bell).max(units(1)));
                        }
                    }
                }
                _ => {}
            }
        }
        let s = Signer {
            citizen: who,
            session: !honest && r.below(3) == 0,
        };
        let mut kind = Kind::Other;
        let res: Result<(), String> = match (op, lot, l) {
            (0, _, _) => {
                let v = r.pick(&vaults);
                let v = c.w.vault(&v).map(|x| x.place()).unwrap_or(v);
                let (signer, owner) = if honest {
                    let vo = c.w.vault(&v).map(|x| x.owner).unwrap_or(who);
                    (Cast::wallet(vo), r.pick(&people))
                } else {
                    (s, r.pick(&people))
                };
                c.w.open_lot(&signer, v, owner, ORE, units(r.below(400) as i64 + 1))
                    .map(|_| ())
                    .map_err(|e| format!("{e:?}"))
            }
            (1, Some(lot), _) => {
                let seq = c.w.next_seq(&who);
                let home = c.home(&who);
                c.w.deposit(&s, seq, home, lot, qty, r.pick(&[0, 54, 300]))
                    .map(|_| ())
                    .map_err(|e| format!("{e:?}"))
            }
            (2 | 3, Some(lot), Some(l)) => {
                let nonce = l.nonce + (!honest && r.below(2) == 0) as u32;
                let grantee = if honest {
                    *people
                        .iter()
                        .filter(|p| **p != l.owner)
                        .nth(r.below(4) as usize)
                        .unwrap()
                } else {
                    r.pick(&people)
                };
                let dst =
                    c.w.vault(&r.pick(&vaults))
                        .map(|v| v.place())
                        .unwrap_or(c.vd);
                let free = l.orders.iter().position(|o| !o.live(c.w.bell)).unwrap_or(0) as u8;
                let slot = if honest { free } else { r.below(5) as u8 };
                let q = if honest {
                    qty.min(l.available(c.w.bell).max(units(1)))
                } else {
                    qty
                };
                let spec = OrderSpec {
                    kind: if op == 2 { ORDER_SHIP } else { ORDER_USE },
                    grantee,
                    qty: q,
                    expires_bell: c.w.bell
                        + if honest {
                            5 + r.below(60) as u32
                        } else {
                            r.below(60) as u32
                        },
                    dst,
                    purpose: r.below(3) as u16,
                };
                let res = c.w.set_order(&s, lot, slot, nonce, spec);
                if res.is_ok() {
                    *granted.entry((lot, grantee)).or_default() += q;
                }
                res.map(|_| ()).map_err(|e| format!("{e:?}"))
            }
            (4, Some(lot), Some(l)) => {
                let slot = r.below(4) as u8;
                c.w.revoke_order(&s, lot, slot, l.orders[slot as usize].id)
                    .map(|_| ())
                    .map_err(|e| format!("{e:?}"))
            }
            (5 | 6, Some(lot), Some(l)) => {
                let mine = live
                    .iter()
                    .find(|(_, o)| o.kind == ORDER_SHIP && o.grantee == who)
                    .copied();
                let (by, to) = match (honest, mine) {
                    (true, Some((slot, o))) => (By::Order { slot, id: o.id }, ShipTo::Lot(o.dst)),
                    (true, None) => {
                        let to = if r.below(2) == 0 {
                            ShipTo::OwnPlace(c.home(&who))
                        } else {
                            ShipTo::Lot(
                                c.w.vault(&r.pick(&vaults))
                                    .map(|v| v.place())
                                    .unwrap_or(c.vd),
                            )
                        };
                        (By::Owner, to)
                    }
                    (false, _) => {
                        let slot = r.below(4) as u8;
                        let by = if r.below(2) == 0 {
                            By::Owner
                        } else {
                            By::Order {
                                slot,
                                id: l.orders[slot as usize].id,
                            }
                        };
                        let to = match r.below(3) {
                            0 => ShipTo::OwnPlace(c.home(&who)),
                            1 => ShipTo::Lot(l.orders[slot as usize].dst),
                            _ => ShipTo::Lot(
                                c.w.vault(&r.pick(&vaults))
                                    .map(|v| v.place())
                                    .unwrap_or(c.vd),
                            ),
                        };
                        (by, to)
                    }
                };
                kind = match by {
                    By::Owner => Kind::Owner,
                    By::Order { id, .. } => Kind::Grantee(id),
                };
                let seq = c.w.next_seq(&who) + (!honest && r.below(3) == 0) as u32;
                c.w.ship(&s, seq, lot, by, qty, to, r.pick(&[0, 54]))
                    .map(|_| ())
                    .map_err(|e| format!("{e:?}"))
            }
            (7, Some(lot), Some(l)) => {
                let mine = live
                    .iter()
                    .find(|(_, o)| o.kind == ORDER_USE && o.grantee == who)
                    .copied();
                let (slot, id, purpose) = match (honest, mine) {
                    (true, Some((slot, o))) => (
                        slot,
                        o.id,
                        if o.purpose == 0 {
                            r.below(9) as u16
                        } else {
                            o.purpose
                        },
                    ),
                    _ => {
                        let slot = r.below(4) as u8;
                        (slot, l.orders[slot as usize].id, r.below(3) as u16)
                    }
                };
                kind = Kind::Grantee(id);
                c.w.consume(&s, lot, slot, id, qty, purpose)
                    .map_err(|e| format!("{e:?}"))
            }
            (8, _, _) if !caravans.is_empty() => {
                let k = r.pick(&caravans);
                c.w.settle_custody(k)
                    .map(|_| ())
                    .map_err(|e| format!("{e:?}"))
            }
            (9, _, _) if !caravans.is_empty() => {
                let k = r.pick(&caravans);
                c.w.settle_caravan(k).map_err(|e| format!("{e:?}"))
            }
            (10, _, _) if !caravans.is_empty() => {
                let k = r.pick(&caravans);
                c.w.open_raid(k, who).map_err(|e| format!("{e:?}"))
            }
            (11, _, _) if !caravans.is_empty() => {
                let k = r.pick(&caravans);
                let signer = if r.below(2) == 0 { Some(&s) } else { None };
                c.w.settle_raid(signer, k, r.below(2) == 0)
                    .map_err(|e| format!("{e:?}"))
            }
            (12, _, _) if r.below(25) == 0 => {
                let v = r.pick(&vaults);
                let v = c.w.vault(&v).map(|x| x.place()).unwrap_or(v);
                c.w.seize_vault(&s, v)
                    .map(|_| ())
                    .map_err(|e| format!("{e:?}"))
            }
            (13, Some(lot), _) => {
                kind = Kind::Forfeit;
                c.w.reconcile(lot).map_err(|e| format!("{e:?}"))
            }
            (14, Some(lot), _) if r.below(3) == 0 => {
                let signer = if r.below(3) == 0 { None } else { Some(&s) };
                c.w.close_lot(signer, lot).map_err(|e| format!("{e:?}"))
            }
            (15, _, _) => {
                // A vault's holder tries to empty its general stock home (the
                // lots must not feed it).
                let v = r.pick(&vaults);
                let v = c.w.vault(&v).map(|x| x.place()).unwrap_or(v);
                c.w.send_caravan(&s, v, c.home(&who), common::ore((r.below(400) + 1) as i64))
                    .map(|_| ())
                    .map_err(|e| format!("{e:?}"))
            }
            _ => Err("skip".into()),
        };
        if r.below(7) == 0 {
            c.w.advance(r.below(12) as u32 + 1);
        }
        c.w.check()
            .unwrap_or_else(|e| panic!("seed {seed} step {step} op {op}: {e}"));
        if step % 9 == 0 {
            assert_eq!(
                World::restore(&c.w.snapshot()),
                c.w,
                "seed {seed} step {step}: restart"
            );
        }
        let label = match (op, kind) {
            (5 | 6, Kind::Grantee(_)) => "ship by order".to_string(),
            (5 | 6, _) => "ship by owner".to_string(),
            (11, _)
                if c.w.log.last().is_some_and(|e| {
                    matches!(
                        e,
                        wylls_custody::model::Event::CaravanRaided { take: true, .. }
                    )
                }) =>
            {
                "raid take".to_string()
            }
            (11, _) => "raid burn".to_string(),
            (13, _)
                if c.w.log.iter().skip(before.log.len()).any(|e| {
                    matches!(
                        e,
                        wylls_custody::model::Event::Loss {
                            cause: Loss::Seized,
                            ..
                        }
                    )
                }) =>
            {
                "forfeit".to_string()
            }
            (13, _) => "reconcile raided".to_string(),
            _ => format!("op {op}"),
        };
        if res.is_ok() {
            *hits.entry(label).or_default() += 1;
        }
        if res.is_err() {
            // A refusal writes nothing (the bell may have moved after it).
            let mut b = before.clone();
            b.bell = c.w.bell;
            assert_eq!(
                b, c.w,
                "seed {seed} step {step} op {op}: a refusal changed the world"
            );
            continue;
        }
        // HELD falls only by an authorised move.
        for (k, d) in &before.lots {
            let old = Lot::decode(d).unwrap();
            let new = c.w.lot(k).ok();
            let fell = new.map_or(old.held, |n| old.held - n.held);
            if fell <= 0 {
                continue;
            }
            match kind {
                Kind::Owner => assert_eq!(
                    who, old.owner,
                    "seed {seed} step {step}: a non-owner moved a lot"
                ),
                Kind::Grantee(id) => {
                    let o = old
                        .orders
                        .iter()
                        .find(|o| o.id == id && o.kind != ORDER_FREE)
                        .expect("an order");
                    assert_eq!(o.grantee, who, "seed {seed} step {step}: not the grantee");
                    assert!(!s.session);
                    let e = spent.entry((*k, who)).or_default();
                    *e += fell;
                    assert!(
                        *e <= granted[&(*k, who)],
                        "seed {seed} step {step}: a grantee beyond its orders"
                    );
                }
                Kind::Forfeit => {
                    let v = c.w.vault(&k.0).unwrap();
                    assert_ne!(
                        v.gen, old.vault_gen,
                        "seed {seed} step {step}: forfeiture without seizure"
                    );
                }
                Kind::Other => panic!("seed {seed} step {step} op {op}: HELD fell by {fell}"),
            }
        }
        // General stock rises only by a settlement or a forfeiture.
        for (at, d) in &before.vaults {
            let old = wylls_custody::model::vault_view(d).stores[ORE as usize];
            let new = c.w.vaults.get(at).map_or(0, |d| {
                wylls_custody::model::vault_view(d).stores[ORE as usize]
            });
            if new > old {
                assert!(
                    matches!(op, 9 | 13),
                    "seed {seed} step {step} op {op}: a vault's stock rose"
                );
            }
        }
    }
    // Drain: keepers settle every raid, caravan and lot. No reservation is
    // left behind (none released twice: `check` after every step), and
    // every owner's books still balance.
    c.w.drain();
    c.w.check()
        .unwrap_or_else(|e| panic!("seed {seed} after drain: {e}"));
    assert!(
        c.w.caravans.is_empty(),
        "seed {seed}: caravans left after drain"
    );
    for (k, d) in &c.w.lots {
        let l = Lot::decode(d).unwrap();
        assert_eq!(l.incoming(), 0, "seed {seed}: {k:?} keeps a reservation");
    }
    *hits.entry("drained runs".into()).or_default() += 1;
}

#[test]
fn random_requests_keep_every_invariant() {
    let mut hits = BTreeMap::new();
    let seeds: u64 = std::env::var("CUSTODY_SEEDS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(300);
    for seed in 1..=seeds {
        run(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15), 400, &mut hits);
    }
    println!("successful requests by kind: {hits:#?}");
    // Every path the invariants are about was reached many times.
    for (k, min) in [
        ("op 0", 100),
        ("op 1", 100),
        ("op 2", 50),
        ("op 3", 50),
        ("ship by owner", 50),
        ("ship by order", 20),
        ("op 7", 20),
        ("op 8", 50),
        ("raid take", 20),
        ("raid burn", 20),
        ("forfeit", 20),
        ("reconcile raided", 10),
        ("op 12", 20),
    ] {
        assert!(
            hits.get(k).copied().unwrap_or(0) >= min,
            "{k}: only {:?} successes",
            hits.get(k)
        );
    }
}
