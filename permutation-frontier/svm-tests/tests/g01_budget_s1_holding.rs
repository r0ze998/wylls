//! G1 for the S1 holding settle (redesign stage 1a, the workshops): every
//! owner instruction settles its holding first (`proc/holding.rs`
//! `load_touched`), and an S1 holding with workshops converts ore and wood
//! into arms, splitting the settle where an input runs dry and where a
//! queued building changes the rates. The MC rows of Harvest, Build and
//! Train were measured on M1 and MC holdings; in a local S1 season
//! (`s1-season-1`, 2026-10-26) an AI citizen's holding whose ore ran dry
//! needed 21.7k CU to Harvest against the 19k limit and was refused at
//! every turn after. Measured here in that state, worst of the holding
//! instructions the page and the bots send; asserted against the S1 limits
//! (`frontier_abi::v2::budgets::cu_limit_s1`).

mod common;

use frontier_abi::v2::budgets as b2;
use frontier_abi::v2::Ix;
use permutation_frontier_svm_tests::chain::{expect_lands, Chain};
use permutation_frontier_svm_tests::ix::holding as hx;
use permutation_frontier_svm_tests::world::holding::{read_kholding, Estate};
use permutation_frontier_svm_tests::world::World;
use permutation_frontier_svm_tests::Instruction;
use permutation_rules::fixed::MILLI;
use permutation_rules::frontier::arms::{ARMS, WORKSHOP_ARMS_PER_HOUR};
use permutation_rules::frontier::holding::{Effect, Resource, Tier, HOUR};

const B0: u32 = 10;

/// A City converting ore into arms with workshops being built, its ore
/// short, and queued buildings finishing through the gap; then `gap`
/// seconds pass with nobody touching it.
fn dry_workshops(c: &mut Chain, w: &World, e: &Estate, short: &[(Resource, i64)], gap: i64) {
    w.enrich(c, e, 1_000_000);
    let now = c.now;
    w.edit_kholding(c, e, |h| {
        h.tier = Tier::City;
        for r in Resource::ALL {
            h.stores[r as usize].cap = Tier::City.storage_cap() * 1_000;
        }
        for &(r, units) in short {
            h.stores[r as usize].value = units * MILLI;
        }
        // two workshops running, two more and two producers queued to finish inside the gap
        h.production[ARMS as usize] = 2 * WORKSHOP_ARMS_PER_HOUR * MILLI;
        for (k, dt) in [(ARMS, 900i64), (ARMS, 5 * HOUR), (Resource::Wood, 3 * HOUR), (Resource::Food, 9 * HOUR)] {
            h.enqueue(
                now,
                dt,
                Effect::Production {
                    resource: k,
                    delta: if k == ARMS { WORKSHOP_ARMS_PER_HOUR * MILLI } else { 10 * MILLI },
                },
            )
            .unwrap();
        }
    });
    // one landed touch puts the stores on the program's own rates (workshops at full speed)
    c.advance(60);
    expect_lands(
        c.send(&[hx::harvest(&w.a, &e.player(), e.href())], &[&e.wallet]),
        "harvest",
    );
    c.advance(gap);
}

/// Measures, prints, and returns `(label, need, limit)`; the test asserts
/// after every figure is printed.
fn need(c: &Chain, label: &str, ix: Ix, ixs: &[Instruction], e: &Estate) -> (String, u64, u32) {
    let n = c
        .measure(ixs, &[&e.wallet])
        .unwrap_or_else(|f| panic!("{label}: refused while measuring: {f:?}"));
    let limit = b2::cu_limit_s1(ix);
    println!("{label}: {n} (S1 limit {limit} CU)");
    (label.to_string(), n.cu, limit)
}

fn assert_all(rows: &[(String, u64, u32)]) {
    for (label, cu, limit) in rows {
        assert!(cu <= &(*limit as u64), "{label}: {cu} CU > the S1 limit {limit}");
    }
}

#[test]
fn g01_budget_s1_holding_with_dry_workshops() {
    let mut c = Chain::release();
    let w = World::running(&mut c, 1);
    w.to_bell(&mut c, B0, 5);
    let e = w.craft_estate(&mut c, "dry", 0, (2, 0), 0);
    dry_workshops(&mut c, &w, &e, &[(Resource::Ore, 12)], 30 * HOUR);
    let h = read_kholding(&c.data(&e.holding));
    assert!(
        h.production[ARMS as usize] > 0,
        "the workshops are running"
    );
    let p = e.player();
    let rows = vec![
        need(
            &c,
            "Harvest (workshops, ore dry, 4 items done in the gap)",
            Ix::Harvest,
            &[hx::harvest(&w.a, &p, e.href())],
            &e,
        ),
        need(
            &c,
            "Build (same holding)",
            Ix::Build,
            &[hx::build_item(&w.a, &p, e.href(), 1, false)],
            &e,
        ),
    ];
    // every unit costs ore, so Train is measured where wood ran dry instead
    let t = w.craft_estate(&mut c, "dryw", 2, (2, 0), 2);
    dry_workshops(&mut c, &w, &t, &[(Resource::Wood, 12)], 30 * HOUR);
    let tp = t.player();
    let mut rows = rows;
    rows.push(need(
        &c,
        "Train 100 (workshops, wood dry)",
        Ix::Train,
        &[hx::train(&w.a, &tp, t.href(), 0, 100)],
        &t,
    ));
    rows.push(need(
        &c,
        "Train 100 Pikemen, arms (same holding)",
        Ix::Train,
        &[hx::train(&w.a, &tp, t.href(), 3, 100)],
        &t,
    ));
    // the longest walk: both inputs run dry at different moments, the queue finishes through the gap, and the holding
    // falls dormant before it is touched again (3 days without its owner)
    let x = w.craft_estate(&mut c, "dryx", 3, (2, 0), 3);
    dry_workshops(&mut c, &w, &x, &[(Resource::Ore, 12), (Resource::Wood, 40)], 80 * HOUR);
    rows.push(need(
        &c,
        "Harvest (both inputs dry, dormant, 80 h)",
        Ix::Harvest,
        &[hx::harvest(&w.a, &x.player(), x.href())],
        &x,
    ));
    rows.push(need(
        &c,
        "Build (both inputs dry, dormant, 80 h)",
        Ix::Build,
        &[hx::build_item(&w.a, &x.player(), x.href(), 1, false)],
        &x,
    ));
    // and a quiet S1 holding (no workshop, an hour of accrual), for the difference
    let q = w.craft_estate(&mut c, "quiet", 1, (2, 0), 1);
    c.advance(HOUR);
    let quiet = need(
        &c,
        "Harvest (quiet S1 holding)",
        Ix::Harvest,
        &[hx::harvest(&w.a, &q.player(), q.href())],
        &q,
    );
    println!(
        "the dry workshops' settle adds {} CU to a Harvest",
        rows[0].1.saturating_sub(quiet.1)
    );
    assert_all(&rows);
}
