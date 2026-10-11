//! Wave-1 close (W1C-B-sim; DECISIONS CQ-H, OWNER-OPTIONS-W1) tests: the
//! package is the default MC behaviour. The planner's occupation
//! objective (PO-1 (a)) occupies and liberates with `cq` bots, its hold
//! rule is the sheet's formula, the keep tile is the symmetric kernel
//! (PO-5), and the planner defaults and their exploration overrides are
//! as documented. K2's train-cost table is tested in `k2`; the
//! floors in `mapmove`.

use crate::config::Config;
use crate::mapmove;
use crate::mc::{BotProfile, Policy, Rules, OCC_SLOTS};
use crate::model::Arch;
use crate::sim::Sim;
use crate::suite::play;
use permutation_rules::frontier::clash::RETREAT_MAX_BPS;
use permutation_rules::frontier::geometry::PROVINCE_TILES;

fn mc_cq(seed: u64, agents: usize) -> Config {
    let mut c = Config {
        seed,
        agents,
        days: 7,
        bot_share: 0.99,
        bot_profile: BotProfile::Cq,
        policy: [Policy::Campaign; 6],
        ..Config::default()
    };
    c.set_rules(Rules::Mc, None);
    c
}

/// The occupation objective, the hold rule and rally stay are on by
/// default; `--mc` overrides them for exploration only (the preset then
/// reads "custom", so such a run drifts against the thresholds files).
#[test]
fn cq_planner_package_is_the_default() {
    let c = Config::default();
    assert_eq!((c.occ_slots, c.siege_hold, c.rally_stay), (1, true, true));
    assert_eq!(OCC_SLOTS, 1);
    let m = mc_cq(1, 100);
    assert_eq!(m.mc.preset, "MC_LOCAL_7D");
    assert_eq!((m.occ_slots, m.siege_hold, m.rally_stay), (1, true, true));
    let mut x = Config {
        days: 7,
        mc_overrides: "occ_slots=0,siege_hold=0,rally_stay=0".into(),
        ..Config::default()
    };
    x.set_rules(Rules::Mc, None);
    assert_eq!((x.occ_slots, x.siege_hold, x.rally_stay), (0, false, false));
    assert_eq!(x.mc.preset, "custom");
    assert_eq!(x.mc.keep_bells, 72);
    let mut y = Config {
        days: 7,
        mc_overrides: "keep_home_guard=50,occ_slots=2".into(),
        ..Config::default()
    };
    y.set_rules(Rules::Mc, None);
    assert_eq!((y.occ_slots, y.mc.keep_home_guard), (2, 50));
}

/// The hold rule: retreat_bps = clamp(10,000 × group ÷ own, 6,667,
/// RETREAT_MAX_BPS) (OWNER-OPTIONS-W1 PO-1 (a)).
#[test]
fn cq_hold_rule_is_the_sheet_formula() {
    let r = Sim::occ_retreat;
    assert_eq!(r(1_000_000, 1_000_000), 10_000);
    assert_eq!(r(3_000_000, 1_000_000), 30_000);
    assert_eq!(r(1_500_000, 1_000_000), 15_000);
    assert_eq!(r(100_000_000, 1_000_000), RETREAT_MAX_BPS as u32);
    assert_eq!(r(500_000, 1_000_000), 6_667);
    assert_eq!(r(0, 0), 10_000);
}

/// With `cq` bots the campaign plan now besieges first holdings: the
/// season occupies and liberates (0 / 0 before the W1-close), launches
/// occupation groups, keeps rally hosts on their hex, conserves and
/// transfers no first holding (D9).
#[test]
fn cq_occupation_objective_occupies_with_cq_bots() {
    let (sim, o) = play(&mc_cq(2002, 1_000));
    for c in &o.checks {
        assert!(c.ok, "{} ({})", c.name, c.detail);
    }
    let st = &sim.mcs.st;
    assert!(st.dbg[12] > 0, "no occupation campaign planned");
    assert!(st.dbg[13] > 0, "no occupation group launched");
    assert!(st.dbg[14] > 0, "no rally host stayed");
    let m = mapmove::metrics(&sim);
    assert!(m.occupations >= 10.0, "occupations {}", m.occupations);
    assert!(m.liberations >= 1.0, "liberations {}", m.liberations);
    assert_eq!(m.d9_transfers, 0.0);
    assert!(m.net_movement_open >= 0.06, "10e' {}", m.net_movement_open);
    assert!(sim.mcs.st.departs[Arch::Bot.idx()] > 0);
}

/// Every keep stands on the tile `keep::keep_tile_symmetric` gives for its
/// province's wedge (PO-5, CQH1(5)), which is `keep_tile` in wedge 0.
#[test]
fn cq_keep_tile_is_the_symmetric_kernel() {
    use permutation_rules::frontier::keep::{keep_tile, keep_tile_symmetric};
    let (sim, _) = play(&mc_cq(3, 300));
    let (mut n, mut moved) = (0, 0);
    for p in sim.provs.iter().flatten() {
        let Some(k) = p.mkeep else { continue };
        let bytes: [u8; PROVINCE_TILES] = core::array::from_fn(|i| p.terrain.terrain[i] as u8);
        let t = &p.terrain;
        let sym = keep_tile_symmetric(&bytes, &t.sites, t.site_count, p.wedge).unwrap();
        assert_eq!(k.tile, sym);
        let old = keep_tile(&bytes, &t.sites, t.site_count).unwrap();
        if p.wedge == 0 {
            assert_eq!(sym, old);
        }
        n += 1;
        moved += (sym != old) as u32;
    }
    assert!(n > 0 && moved > 0, "{moved} of {n} keeps moved");
}

/// A-26 (contract v1.3 §8.6, DECISIONS CQI16): the rally stay applies to
/// campaign factions only, as the package was measured. Under MC a lone
/// faction's arriving Rally host still goes home even with the target's
/// MC siege live or the strike pending (`dbg[15]`); a campaign faction's
/// stays (`dbg[14]`). The overnight doctrine band (O-A, `--policy lone`)
/// depends on this: with the stay for every policy it is 5/6
/// (W1C-B-sim-NOTES §3.1).
#[test]
fn cq_rally_stay_is_campaign_only() {
    use crate::mc::Policy::{Campaign, Lone};
    let run = |policy: [crate::mc::Policy; 6]| {
        let mut c = Config {
            seed: 2602,
            agents: 1_000,
            days: 7,
            policy,
            ..Config::default()
        };
        c.set_rules(Rules::Mc, None);
        assert!(c.rally_stay);
        let (sim, o) = play(&c);
        for k in &o.checks {
            assert!(k.ok, "{} ({})", k.name, k.detail);
        }
        (sim.mcs.st.dbg[14], sim.mcs.st.dbg[15])
    };
    // every faction lone: no rally host stays, and some went home with
    // their target's siege live (the defect kept for the human model)
    let (stay, home) = run([Lone; 6]);
    assert_eq!(stay, 0, "a lone rally host stayed");
    assert!(home > 0, "no lone rally host met a live siege");
    // faction 0 campaign, 1-5 lone (OD-16's coordination row): both paths
    let (stay, home) = run([Campaign, Lone, Lone, Lone, Lone, Lone]);
    assert!(stay > 0, "the campaign faction's rally hosts did not stay");
    assert!(home > 0, "no lone rally host met a live siege");
    // every faction campaign: no rally host meets a live siege and leaves
    let (stay, home) = run([Campaign; 6]);
    assert!(stay > 0);
    assert_eq!(home, 0, "a campaign rally host went home from a live siege");
}
