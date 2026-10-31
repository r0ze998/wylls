//! Fixtures for the demo and the tests: two players' real Holdings in
//! neighbouring provinces, and caravans between them walked by the rules
//! crate's `caravan::walk` (open land: every tile passable, no rough, no
//! road). Not part of the contract.

use permutation_rules::fixed::MILLI;
use permutation_rules::frontier::arms::{self, ARMS, WORKSHOP_DELTA};
use permutation_rules::frontier::caravan::{self, Land};
use permutation_rules::frontier::doctrine::NEUTRAL;
use permutation_rules::frontier::geometry::ProvinceCoord;
use permutation_rules::frontier::holding::{Holding, Resource, Tier};

use crate::custody::{By, Custody, Key};
use crate::facility::Facility;
use crate::model::{Actor, Place, Site};

/// Season clock origin of the fixtures (any instant; 2026-11-01 00:00 UTC).
pub const T0: i64 = 1_793_491_200;

pub const A: Actor = Actor::test(0xA1);
pub const B: Actor = Actor::test(0xB2);
pub const C: Actor = Actor::test(0xC3);
pub const X: Actor = Actor::test(0xEE);

/// A's workshop village and B's (and C's) home, in neighbouring provinces.
pub const SITE_A: Site = Site {
    p: 0,
    q: 0,
    site: 0,
};
pub const SITE_B: Site = Site {
    p: 1,
    q: -1,
    site: 0,
};
pub const SITE_C: Site = Site {
    p: 0,
    q: 1,
    site: 0,
};

pub fn coord(s: Site) -> ProvinceCoord {
    ProvinceCoord::new(s.p as i32, s.q as i32)
}

/// A first Holding founded at `T0` with the S1 base production of a
/// Hamlet on 10 ore an hour of terrain, `workshops` workshop copies built,
/// and `ore`, `wood` units in its stores.
pub fn holding(workshops: u32, ore: i64, wood: i64) -> Holding {
    let mut h = Holding::found(T0, 0, 1);
    h.production = arms::base_production(Tier::Hamlet, 10 * MILLI);
    h.production[ARMS as usize] = workshops as i64 * WORKSHOP_DELTA;
    h.credit(T0, Resource::Ore, ore * MILLI).unwrap();
    h.credit(T0, Resource::Wood, wood * MILLI).unwrap();
    h.touch_owner(T0).unwrap();
    h
}

/// The facility: A's village with `workshops` copies.
pub fn facility(workshops: u32) -> Facility {
    Facility::new(SITE_A, 1, A, holding(workshops, 1_500, 1_500))
}

fn land(at: ProvinceCoord) -> Land {
    Land {
        at,
        passable: (1u64 << 61) - 1,
        rough: 0,
        road: 0,
    }
}

/// Seconds a caravan of the neutral doctrine takes from `from` to `to`
/// (both sites on their province's centre tile), by `caravan::walk`.
pub fn caravan_secs(from: Site, to: Site) -> i64 {
    let (a, b) = (coord(from), coord(to));
    let mut lands = vec![land(a), land(b)];
    for n in a.neighbors().into_iter().chain(b.neighbors()) {
        if !lands.iter().any(|l| l.at == n) {
            lands.push(land(n));
        }
    }
    let (dirs, order) = caravan::fastest_path((a, 0), (b, 0), &lands).expect("a path");
    let walk_lands: Vec<Land> = order.iter().map(|&pc| land(pc)).collect();
    let path = caravan::pack(&dirs).expect("packs");
    let steps = caravan::walk(
        (a, 0),
        &path,
        dirs.len() as u8,
        &walk_lands,
        NEUTRAL.caravan_time_bps,
    )
    .expect("walks");
    caravan::travel_secs(&steps) as i64
}

/// A caravan leaves `home` (a real Holding) with goods: the Holding pays
/// them, custody holds them in the caravan, owned by `owner`.
pub fn ship_out<Cu: Custody>(
    cu: &mut Cu,
    h: &mut Holding,
    now: i64,
    owner: Actor,
    caravan: u64,
    goods: &[(Resource, i64)],
) {
    let mut cost = [0; permutation_rules::frontier::holding::RESOURCES];
    for (r, a) in goods {
        cost[*r as usize] += a;
    }
    h.pay(now, &cost).expect("the home has the goods");
    for (i, (r, a)) in goods.iter().enumerate() {
        cu.import(
            Key {
                scope: caravan,
                kind: 100,
                n: i as u64,
            },
            Place::Caravan(caravan),
            owner,
            *r,
            *a,
        )
        .expect("import");
    }
}

/// A caravan arrives at a real Holding: custody hands its goods over and
/// the Holding is credited.
pub fn ship_in<Cu: Custody>(cu: &mut Cu, h: &mut Holding, now: i64, owner: Actor, caravan: u64) {
    for r in Resource::ALL {
        let (o, a) = cu.balance(Place::Caravan(caravan), r);
        if a > 0 {
            assert_eq!(o, Some(owner));
            cu.export(
                Key {
                    scope: caravan,
                    kind: 101,
                    n: r as u64,
                },
                By::Actor(owner),
                Place::Caravan(caravan),
                r,
                a,
            )
            .expect("export");
            h.credit(now, r, a).expect("credit");
        }
    }
}

/// Length of the fixture grants.
pub const GRANT_DAYS: i64 = 10;

/// A world with A's facility of `workshops` copies, a pool opened at
/// `T0` under `policies` with `lent` copies lent, and grant 1 to B and
/// grant 2 to C (each `max_units` copies, 100 arms, [`GRANT_DAYS`] days).
pub fn world(
    workshops: u32,
    lent: u32,
    max_units: u32,
    policies: crate::policy::Policies,
) -> (
    crate::ledger::Harness<crate::custody::MockCustody>,
    crate::model::FacilityId,
) {
    use crate::ledger::{Harness, Op};
    use crate::model::GrantId;
    let mut w = Harness::new(crate::custody::MockCustody::default());
    w.add_facility(facility(workshops));
    let f = w.facilities[&SITE_A].id();
    w.apply(
        T0,
        A,
        &Op::OpenPool {
            facility: f,
            policies,
        },
    )
    .unwrap();
    if lent > 0 {
        w.apply(
            T0,
            A,
            &Op::Lend {
                facility: f,
                units: lent,
                seq: 0,
            },
        )
        .unwrap();
    }
    for (seq, user) in [(1, B), (2, C)] {
        w.apply(
            T0,
            A,
            &Op::Grant {
                grant: GrantId { facility: f, seq },
                user,
                recipe: crate::recipe::RECIPE_ARMS,
                max_units,
                max_output: 100 * MILLI,
                from: T0,
                until: T0 + GRANT_DAYS * 86_400,
            },
        )
        .unwrap();
    }
    (w, f)
}

/// Gives `user` a caravan `id` in custody holding `ore` and `wood`
/// (units), as if it had arrived at the facility.
pub fn arrived(cu: &mut crate::custody::MockCustody, user: Actor, id: u64, ore: i64, wood: i64) {
    for (i, (r, a)) in [(Resource::Ore, ore), (Resource::Wood, wood)]
        .into_iter()
        .enumerate()
    {
        if a > 0 {
            cu.import(
                Key {
                    scope: id,
                    kind: 100,
                    n: i as u64,
                },
                Place::Caravan(id),
                user,
                r,
                a * MILLI,
            )
            .unwrap();
        }
    }
}
