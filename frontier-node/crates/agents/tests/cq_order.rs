//! A conquest march order on the M1 herald fixture (MC contract v1.3 §8.6;
//! unit CQ2-F; `cq_*`): the pure rule `cqorder::step` turns a plan's
//! dispatch into a Muster, then a sealed Depart pushed to the campaign's
//! common arrival bell, carrying the hold rule's `retreat_bps`; it waits
//! for a Muster to land and gives a stale or homeless order up.

use std::collections::BTreeMap;

use fclient::abi::layout::entry as le;
use fclient::Signer;
use frontier_agents::campaign::Mission;
use frontier_agents::cqorder::{dedupe, step, Order, Step, MUSTER_WAIT_BELLS, ORDER_TTL_BELLS};
use frontier_agents::fixture::{self, FINAL, SEED};
use frontier_agents::keys;
use frontier_agents::obs::{BellView, MeView, Observation, Overview, ProvinceView, SeasonView};
use frontier_agents::policy::Intent;
use frontier_agents::profile::{AgentSpec, Arch};
use serde_json::Value;

fn json(b: &[u8]) -> Value {
    serde_json::from_slice(b).expect("json")
}

/// The fixture world as wallet `FINAL` reads it, its hosts rested and
/// full-sized (the M1 fixture's entries carry whole-troop counts; a real
/// roster entry is in milli-troops), its home reserve filled.
fn observe() -> Observation {
    let w = fixture::world();
    let f = |p: &str| w.files.get(p).cloned();
    let season = SeasonView::from_json(&json(&f("h/season.json").unwrap())).unwrap();
    let wallet = keys::wallet(SEED, FINAL).pubkey();
    let mut me = MeView::from_json(&json(&f(&format!("h/me/{wallet}.json")).unwrap())).unwrap();
    let mut provinces = BTreeMap::new();
    let mut bells = BTreeMap::new();
    let mut overviews = vec![];
    for (k, b) in &w.files {
        if k.starts_with("h/province/") {
            let mut v = ProvinceView::from_json(&json(b)).unwrap();
            v.province.resolved_next = fixture::BELL;
            for e in v.province.entries.iter_mut() {
                if e.state == le::STATE_ROSTER {
                    e.troops = e.troops.max(1) * 1_000;
                    e.stamina_value = permutation_rules::frontier::host::STAMINA_CAP;
                    e.stamina_bell = fixture::BELL;
                    e.ready_bell = 0;
                    e.from_bell = 0;
                }
            }
            provinces.insert(v.coord(), v);
        } else if k.starts_with("h/overview/") {
            overviews.push(Overview::decode(b).unwrap());
        } else if k.starts_with("h/bell/") {
            let v = BellView::from_json(&json(b)).unwrap();
            bells.insert((v.bell, v.region), v);
        }
    }
    for (_, h) in me.holdings.iter_mut() {
        h.reserve = [2_000; 8];
        h.reserve[frontier_agents::policy::SCOUT as usize] = 0;
    }
    Observation {
        now: fixture::NOW,
        season,
        me,
        provinces,
        province_bells: BTreeMap::new(),
        overviews,
        bells,
    }
}

fn spec() -> AgentSpec {
    AgentSpec {
        index: FINAL,
        arch: Arch::Bot,
        faction: 0,
        join_day: 0,
        join_bell: 5,
        persona: None,
    }
}

/// An order from the fixture's home holding to the enemy's home province.
fn order(obs: &Observation, arrive_min: u32) -> Order {
    let (_, h) = &obs.me.holdings[0];
    let enemy = fixture::world().enemy_home;
    let pv = obs
        .province(enemy.0, enemy.1)
        .expect("the enemy's province");
    Order {
        src: (h.p, h.q, h.site),
        troops: 400,
        to: enemy,
        tile: pv.sites[0],
        arrive_min,
        retreat: Some(60_000),
        why: "siege_march",
        mission: Mission::Siege(7),
        planned: 55,
        issued: obs.bell(),
        mustered: None,
    }
}

const REVEAL_L: u32 = fixture::REVEAL_LOADED_LIMIT;

#[test]
fn cq_order_departs_a_ready_host_at_the_common_bell_with_the_hold_rule() {
    let obs = observe();
    let sp = spec();
    let early = match step(&obs, &sp, SEED, REVEAL_L, &order(&obs, 0), &|_| false) {
        Step::Depart(p) => p,
        other => panic!("{other:?}"),
    };
    assert_eq!(early.plain.retreat_bps, 60_000, "the hold rule's order");
    assert_eq!(
        (early.plain.dest_p, early.plain.dest_q),
        fixture::world().enemy_home
    );
    // The host that leaves stands at home and is no scout.
    let (_, h) = &obs.me.holdings[0];
    assert_eq!(early.host_at, (h.p, h.q));
    // Pushed to the campaign's muster bell, the same for every member.
    let late_bell = early.plain.arrive_bell + 5;
    let late = match step(&obs, &sp, SEED, REVEAL_L, &order(&obs, late_bell), &|_| {
        false
    }) {
        Step::Depart(p) => p,
        other => panic!("{other:?}"),
    };
    assert_eq!(late.plain.arrive_bell, late_bell);
    // Deterministic in (seed, observation, order).
    let again = match step(&obs, &sp, SEED, REVEAL_L, &order(&obs, late_bell), &|_| {
        false
    }) {
        Step::Depart(p) => p,
        other => panic!("{other:?}"),
    };
    assert_eq!(*late, *again);
}

#[test]
fn cq_order_musters_when_no_host_is_ready_then_waits_for_it() {
    let obs = observe();
    let sp = spec();
    // Every host of the holding is already on a march: Muster out of the
    // reserve (the unit with the most in it, whole 100s, one host).
    let taken_all = |_id: u64| true;
    let mut o = order(&obs, 0);
    match step(&obs, &sp, SEED, REVEAL_L, &o, &taken_all) {
        Step::Muster(Intent::Muster {
            unit, troops, tile, ..
        }) => {
            assert_ne!(unit, frontier_agents::policy::SCOUT);
            assert_eq!(troops, 400, "the plan's troops, whole 100s");
            let (_, h) = &obs.me.holdings[0];
            assert_eq!(tile, h.tile);
        }
        other => panic!("{other:?}"),
    }
    // After the Muster, wait for it to land.
    o.mustered = Some(obs.bell());
    assert!(matches!(
        step(&obs, &sp, SEED, REVEAL_L, &o, &taken_all),
        Step::Wait
    ));
    // MUSTER_WAIT_BELLS later, another try.
    o.mustered = Some(obs.bell().saturating_sub(MUSTER_WAIT_BELLS));
    assert!(matches!(
        step(&obs, &sp, SEED, REVEAL_L, &o, &taken_all),
        Step::Muster(_)
    ));
}

#[test]
fn cq_order_is_given_up_when_stale_or_homeless() {
    let obs = observe();
    let sp = spec();
    let mut o = order(&obs, 0);
    o.issued = obs.bell().saturating_sub(ORDER_TTL_BELLS + 1);
    assert!(matches!(
        step(&obs, &sp, SEED, REVEAL_L, &o, &|_| false),
        Step::Drop("stale")
    ));
    let mut o = order(&obs, 0);
    o.src.2 = 11;
    assert!(matches!(
        step(&obs, &sp, SEED, REVEAL_L, &o, &|_| false),
        Step::Drop("no_holding")
    ));
    // No reserve and no host: nothing to send, the order waits.
    let mut poor = observe();
    for (_, h) in poor.me.holdings.iter_mut() {
        h.reserve = [0; 8];
    }
    assert!(matches!(
        step(&poor, &sp, SEED, REVEAL_L, &order(&poor, 0), &|_| true),
        Step::Wait
    ));
}

#[test]
fn cq_a_replanned_strike_is_one_order() {
    let obs = observe();
    let mut orders = vec![];
    let mut a = order(&obs, 100);
    a.mustered = Some(12);
    dedupe(&mut orders, a.clone());
    let mut b = order(&obs, 106);
    b.troops = 900;
    b.issued = a.issued + 6;
    dedupe(&mut orders, b);
    assert_eq!(orders.len(), 1);
    // The newer plan's size and bell, the older order's Muster.
    assert_eq!((orders[0].troops, orders[0].arrive_min), (900, 106));
    assert_eq!(orders[0].mustered, Some(12));
    // A different target is another order.
    let mut c = order(&obs, 106);
    c.tile ^= 1;
    dedupe(&mut orders, c);
    assert_eq!(orders.len(), 2);
}
