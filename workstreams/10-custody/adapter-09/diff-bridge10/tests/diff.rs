//! ⑨'s bridge (992f4ba5) and ⑩'s adapter, the same steps, compared after
//! each: the outcome, M's lot (⑩'s account, all but the rent payee), the
//! vault's custody counts, ⑨'s ledger (the deposit's transit place mapped:
//! the bridge passes lot ore through `Place::Vault(0xF10A…)`, the adapter
//! through `Place::Caravan(1 << 63 | uid)`, since a vault place is a lot
//! there), ⑨'s events, and the job's places.

use borsh::BorshDeserialize;
use permutation_rules::fixed::MILLI;
use permutation_rules::frontier::arms::ARMS;
use permutation_rules::frontier::holding::{Resource, HOUR};
use wylls_capacity::custody::{Custody, Key};
use wylls_capacity::ledger::{Harness, Ledger, Op, Outcome};
use wylls_capacity::model::{Actor, GrantId, JobId, Place};
use wylls_capacity::policy::Policies;
use wylls_capacity::testkit::{self, B, SITE_A, T0, X};
use wylls_capacity_bridge10 as nine;
use wylls_custody::lot as L;
use wylls_custody_adapter_09::connect::{self as ten, ConnError, Connected};
use wylls_custody_adapter_09::{use_place, LotCustody, Refusal};

const K: Actor = Actor::test(0x4B);
const ORE: u8 = Resource::Ore as u8;
const M: Actor = Actor::test(0x4D);
const VID: u64 = 1;
const S: i64 = T0 + HOUR;
const CAP: i64 = 100 * MILLI;
const QUOTA: i64 = 40 * MILLI;

fn vault_view() -> L::VaultView {
    L::VaultView {
        p: SITE_A.p,
        q: SITE_A.q,
        tile: 5,
        gen: 1,
        live: true,
        owner: K.0,
        owner_tag: nine::tag_of(K),
        stores: [0; 8],
        cap: CAP,
        quota: [0; 8],
        lots: 0,
    }
}

/// ⑨'s side as ⑨'s tests build it (testkit::world, kernel functions).
fn bridge(release: nine::Release, expires: u32) -> (nine::Bridge, nine::LotId, u32, JobId) {
    let (w, f) = testkit::world(3, 2, 2, Policies::PROVISIONAL);
    let mut b = nine::Bridge::new(w, T0);
    b.release = release;
    let mut v = vault_view();
    let mut lot = L::open(&mut v, &nine::actor10(K), (M.0, nine::tag_of(M)), ORE, QUOTA, 0, K.0).unwrap();
    L::begin_inbound(&v, &mut lot, (7, 0), QUOTA).unwrap();
    L::finish_inbound(Some(&v), &mut lot, (7, 0), QUOTA).unwrap();
    let spec = L::OrderSpec {
        kind: L::ORDER_USE,
        grantee: B.0,
        qty: QUOTA,
        expires_bell: expires,
        dst: L::PlaceRef::default(),
        purpose: nine::PURPOSE_WORKSHOP_ARMS,
    };
    let order = L::set_order(&v, &mut lot, &nine::actor10(M), 0, 0, &spec, 0).unwrap();
    let id = nine::LotId::of(&lot);
    b.vaults.insert((v.p, v.q, v.tile), v);
    b.lots.insert(id, lot);
    testkit::arrived(&mut b.cap.custody, B, 77, 0, 20);
    let j = JobId { grant: GrantId { facility: f, seq: 1 }, seq: 1 };
    (b, id, order, j)
}

/// ⑩'s side: the same world over the adapter.
fn adapter(release: ten::Release, expires: u32) -> (Connected, u32) {
    let mut cu = LotCustody::new();
    cu.add_vault(VID, SITE_A.p, SITE_A.q, 5, K, CAP);
    cu.open_lot(VID, K, M, Resource::Ore, QUOTA).unwrap();
    cu.try_import(Key { scope: 1 << 40, kind: 100, n: 1 }, Place::Vault(VID), M, Resource::Ore, QUOTA).unwrap();
    let order = cu.set_use_order(VID, M, B, 0, QUOTA, expires, ten::PURPOSE_WORKSHOP_ARMS, 0).unwrap();
    // The wood as testkit::arrived keys it.
    cu.try_import(Key { scope: 77, kind: 100, n: 1 }, Place::Caravan(77), B, Resource::Wood, 20 * MILLI).unwrap();
    cu.take_notes();
    let mut w = Harness::new(cu);
    w.add_facility(testkit::facility(3));
    let f = w.facilities[&SITE_A].id();
    w.apply(T0, testkit::A, &Op::OpenPool { facility: f, policies: Policies::PROVISIONAL }).unwrap();
    w.apply(T0, testkit::A, &Op::Lend { facility: f, units: 2, seq: 0 }).unwrap();
    for (seq, user) in [(1, B), (2, testkit::C)] {
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
                until: T0 + testkit::GRANT_DAYS * 86_400,
            },
        )
        .unwrap();
    }
    let mut c = Connected::new(w, T0);
    c.release = release;
    (c, order)
}

#[derive(Debug, PartialEq, Eq)]
enum R {
    Applied(usize),
    Already,
    Cap(wylls_capacity::CapError),
    Lot(L::CustodyError),
    Conflict,
    Held,
    Other(String),
}

fn from_nine(r: Result<Outcome, nine::BridgeError>) -> R {
    match r {
        Ok(Outcome::Applied(e)) => R::Applied(e.len()),
        Ok(Outcome::AlreadyApplied) => R::Already,
        Err(nine::BridgeError::Capacity(e)) => R::Cap(e),
        Err(nine::BridgeError::Custody(e)) => R::Lot(e),
        Err(nine::BridgeError::Conflict) => R::Conflict,
        Err(nine::BridgeError::OwnershipUndecided) => R::Held,
        Err(e) => R::Other(format!("{e:?}")),
    }
}

fn from_ten(r: Result<Outcome, ConnError>) -> R {
    match r {
        Ok(Outcome::Applied(e)) => R::Applied(e.len()),
        Ok(Outcome::AlreadyApplied) => R::Already,
        Err(ConnError::Capacity(e)) => R::Cap(e),
        Err(ConnError::Custody(Refusal::Lot(e))) => R::Lot(e),
        Err(ConnError::Conflict) => R::Conflict,
        Err(ConnError::OwnershipUndecided) => R::Held,
        Err(e) => R::Other(format!("{e:?}")),
    }
}

/// ⑨'s ledger with the bridge's transit place renamed to the adapter's.
fn ledger(l: &Ledger, map: bool) -> Ledger {
    let mut l = l.clone();
    if map {
        for p in l.pools.values_mut() {
            for j in p.jobs.iter_mut() {
                for d in j.deposits.iter_mut() {
                    if let Place::Vault(x) = d.3 {
                        if x >> 48 == 0xF10A {
                            d.3 = use_place(x & 0x0000_FFFF_FFFF_FFFF);
                        }
                    }
                }
            }
        }
    }
    l
}

fn same(b: &nine::Bridge, id: nine::LotId, c: &Connected, j: JobId, ctx: &str) {
    let mut lb = b.lots[&id];
    let mut lc = c.w.custody.lot(VID, M, ORE).unwrap();
    lb.rent_to = [0; 32];
    lc.rent_to = [0; 32];
    assert_eq!(lb, lc, "{ctx}: M's lot");
    let vb = b.vaults[&(SITE_A.p, SITE_A.q, 5)];
    let vc = &c.w.custody.vaults[&VID];
    assert_eq!((vb.quota[ORE as usize], vb.lots), (vc.quota[ORE as usize], vc.lots), "{ctx}: vault counts");
    assert_eq!(ledger(&b.cap.ledger, true), ledger(&c.w.ledger, false), "{ctx}: ⑨'s ledger");
    assert_eq!(b.cap.events, c.w.events, "{ctx}: ⑨'s events");
    for p in [Place::Hopper(j), Place::Output(j)] {
        for r in [Resource::Ore, Resource::Wood, ARMS] {
            assert_eq!(b.cap.custody.balance(p, r), c.w.custody.balance(p, r), "{ctx}: {p:?} {r:?}");
        }
    }
    b.check(c.w.clock.max(T0)).unwrap_or_else(|e| panic!("{ctx}: bridge {e}"));
    c.w.custody.check().unwrap_or_else(|e| panic!("{ctx}: adapter {e}"));
}

#[test]
fn bridge_and_adapter_agree_step_by_step() {
    let seeds: u64 = std::env::var("DIFF_SEEDS").ok().and_then(|s| s.parse().ok()).unwrap_or(300);
    let mut steps = [0u64; 9];
    let (mut fed, mut held, mut refused) = (0u64, 0u64, 0u64);
    for seed in 0..seeds {
        let mut g = seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1;
        let mut rnd = |n: u64| {
            g ^= g << 13;
            g ^= g >> 7;
            g ^= g << 17;
            g % n
        };
        let to_user = rnd(4) == 0;
        let expires = 20 + rnd(40) as u32;
        let (mut b, id, ob, j) = bridge(if to_user { nine::Release::ToUser } else { nine::Release::Hold }, expires);
        let (mut c, oc) = adapter(if to_user { ten::Release::ToUser } else { ten::Release::Hold }, expires);
        assert_eq!(ob, oc);
        let reserve = Op::Reserve { job: j, units: 2, start: S, end: S + 3 * HOUR, max_output: (1 + rnd(20) as i64) * MILLI };
        assert_eq!(from_nine(b.apply(T0 + 10, B, &reserve)), from_ten(c.apply(T0 + 10, B, &reserve)));
        same(&b, id, &c, j, &format!("seed {seed} reserve"));
        let mut now = T0 + 20;
        let mut last = (1u64, 1u32);
        for step in 0..60 {
            now += rnd(500) as i64;
            let k = rnd(9) as usize;
            steps[k] += 1;
            let (rb, rc) = match k {
                0 | 1 => {
                    last = (1 + rnd(9), 1 + rnd(15) as u32);
                    (
                        from_nine(b.deposit_from_lot(now, B, j, last.0, id, 0, ob, last.1)),
                        from_ten(c.deposit_from_lot(now, B, j, last.0, VID, M, 0, oc, last.1)),
                    )
                }
                2 => (
                    from_nine(b.deposit_from_lot(now, B, j, last.0, id, 0, ob, last.1)),
                    from_ten(c.deposit_from_lot(now, B, j, last.0, VID, M, 0, oc, last.1)),
                ),
                3 => {
                    let op = Op::Deposit { job: j, deposit: 1 + rnd(9), resource: Resource::Wood, amount: (1 + rnd(4) as i64) * MILLI, from: Place::Caravan(77) };
                    (from_nine(b.apply(now, B, &op)), from_ten(c.apply(now, B, &op)))
                }
                4 | 5 => {
                    let op = Op::Settle { job: j };
                    (from_nine(b.apply(now, X, &op)), from_ten(c.apply(now, X, &op)))
                }
                6 => {
                    let op = Op::Cancel { job: j };
                    (from_nine(b.apply(now, B, &op)), from_ten(c.apply(now, B, &op)))
                }
                7 => {
                    let op = Op::Claim { job: j, to: Place::Caravan(78) };
                    (from_nine(b.apply(now, B, &op)), from_ten(c.apply(now, B, &op)))
                }
                _ => {
                    b = nine::Bridge::load(&b.save()).expect("bridge restarts");
                    c = Connected::try_from_slice(&borsh::to_vec(&c).unwrap()).unwrap();
                    (R::Already, R::Already)
                }
            };
            let ctx = format!("seed {seed} step {step} kind {k}");
            assert_eq!(rb, rc, "{ctx}: outcome");
            match (k, &rb) {
                (0 | 1, R::Applied(_)) => fed += 1,
                (7, R::Held) => held += 1,
                (_, R::Cap(_) | R::Lot(_) | R::Conflict) => refused += 1,
                _ => {}
            }
            same(&b, id, &c, j, &ctx);
        }
    }
    println!("seeds {seeds}: steps by kind (lot deposit x2, replay, wood, settle x2, cancel, claim, restart) {steps:?}; lot deposits applied {fed}, claims held {held}, refusals {refused}");
    assert!(fed >= seeds && held >= seeds / 4 && refused >= seeds);
}
