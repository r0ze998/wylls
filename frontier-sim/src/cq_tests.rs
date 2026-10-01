//! MC (CQ1-B) tests of the simulator: the M1 rules stay bit-identical,
//! an MC season conserves and moves, the v1.1 rules hold their
//! invariants, the campaign planner is deterministic, criterion 10's
//! negative controls fail, and the thresholds files are well formed.

use crate::config::Config;
use crate::mapmove;
use crate::mc::{BotProfile, McParams, Policy, Rules};
use crate::model::Arch;
use crate::suite::play;
use permutation_rules::frontier::host::MAX_HOST_TROOPS;

fn mc(seed: u64, agents: usize, days: u32) -> Config {
    let mut c = Config {
        seed,
        agents,
        days,
        ..Config::default()
    };
    c.set_rules(Rules::Mc, None);
    c
}

/// `--rules m1` (the default) is the CQ0 simulator: the settled digest of
/// a 600-wallet season equals the one CQ0 (`39ff369`) prints.
#[test]
fn cq_m1_rules_keep_the_cq0_digest() {
    let d = play(&Config {
        seed: 5,
        agents: 600,
        ..Config::default()
    })
    .1
    .digest;
    let want: [u8; 32] = [
        0xe1, 0xdb, 0x88, 0xcf, 0xb7, 0x4f, 0x63, 0x93, 0xb7, 0xd3, 0x9d, 0x15, 0x55, 0x14, 0x93,
        0xc4, 0x66, 0x8c, 0x3b, 0x80, 0x67, 0xa5, 0x18, 0xbb, 0x5c, 0x43, 0xef, 0x5e, 0xef, 0x03,
        0x2a, 0xed,
    ];
    assert_eq!(d, want);
}

/// A 7-day MC season: money and laurels conserve, keeps change hands,
/// no first holding changes owner (D9), every keep garrison stays under
/// the host cap (R-01), no clash is refused, and the season end leaves no
/// reservation and no open siege (§3.11).
#[test]
fn cq_mc_season_conserves_moves_and_keeps_the_invariants() {
    let (sim, o) = play(&mc(3, 600, 7));
    for c in &o.checks {
        assert!(c.ok, "{} ({})", c.name, c.detail);
    }
    let st = &sim.mcs.st;
    assert!(st.keep_taken > 0, "no keep changed hands");
    assert!(st.sieges_declared > 0 && st.captures + st.fc_captures > 0);
    assert_eq!(st.d9_transfers, 0);
    assert_eq!(sim.stats.clash_errors, 0);
    assert!(st.fc_genesis > 0);
    for p in sim.provs.iter().flatten() {
        if let Some(k) = p.mkeep {
            assert!(k.troops <= MAX_HOST_TROOPS);
            assert_eq!(k.heartland_safe, p.ring <= 3);
        } else {
            assert!(p.ring < 2, "every ring ≥ 2 province has a keep");
        }
    }
    for a in &sim.agents {
        assert!(a.reserved.is_empty(), "a reservation outlived the season");
        let mut orders: Vec<u8> = a
            .holdings
            .iter()
            .map(|&h| sim.holds[h as usize].h.order)
            .collect();
        orders.sort_unstable();
        let n = orders.len();
        orders.dedup();
        assert_eq!(orders.len(), n, "two holdings in one slot");
        assert!(orders.iter().all(|&x| (1..=3).contains(&x)));
    }
    assert!(sim.holds.iter().all(|x| x.mc.siege.is_none()));
    // The control series and criterion 10 read it.
    let m = mapmove::metrics(&sim);
    assert!(m.lasting > 0.0 && m.d9_transfers == 0.0);
}

/// Heartland keeps never change hands (OD-7), and a keep only changes
/// hands after its contest (keep_bells held bells).
#[test]
fn cq_heartland_keeps_hold() {
    let (sim, _) = play(&mc(4, 600, 7));
    for p in sim.provs.iter().flatten() {
        if let Some(k) = p.mkeep {
            if k.heartland_safe {
                assert_eq!(k.changes, 0);
                assert_eq!(k.holder, p.wedge);
            }
        }
    }
    let first = sim
        .mcs
        .ctl
        .events
        .iter()
        .map(|e| e.0)
        .min()
        .expect("a keep changed");
    assert!(first >= McParams::FRONTIER_7.keep_bells as u32);
}

/// The campaign planner is a pure function of the season state: two runs
/// of a seed give the same figures, and the plan is used.
#[test]
fn cq_campaign_policy_is_deterministic() {
    let mut c = mc(6, 600, 7);
    c.policy = [Policy::Campaign; 6];
    c.bot_profile = BotProfile::Cq;
    c.bot_share = 0.5;
    let (a, _) = play(&c);
    let (b, _) = play(&c);
    let (ma, mb) = (mapmove::metrics(&a), mapmove::metrics(&b));
    assert_eq!(a.mcs.ctl.events, b.mcs.ctl.events);
    assert_eq!(ma.lasting, mb.lasting);
    assert!(
        a.mcs.st.keep_marches[Arch::Bot.idx()] > 0,
        "bots never marched on a keep"
    );
    assert!(a.mcs.st.keep_taken > 0);
}

/// Criterion 10's negative controls (§8.7 item 4): the M1 rules with lone
/// players move no province for good; the holding-weight map with
/// campaigns moves some (outposts and occupations shift strength-weight
/// majorities in thin provinces) but far less than the keep map. The
/// gate-scale verdicts are `mapmove-gate --controls` (CQ1-B-NOTES).
#[test]
fn cq_holding_weight_maps_move_far_less_than_keeps() {
    let mut m1 = Config {
        seed: 8,
        agents: 600,
        days: 7,
        ..Config::default()
    };
    m1.set_rules(Rules::M1, None);
    let mut wm = mc(8, 600, 7);
    wm.set_rules(Rules::McWeightmap, None);
    wm.policy = [Policy::Campaign; 6];
    let keeps = mapmove::metrics(&play(&mc(8, 600, 7)).0);
    let m = mapmove::metrics(&play(&m1).0);
    assert!(
        m.lasting < 5.0 && m.banner_changes == 0.0,
        "m1: {} lasting",
        m.lasting
    );
    let w = mapmove::metrics(&play(&wm).0);
    assert!(
        keeps.lasting >= 4.0 * w.lasting,
        "keeps {} vs weight map {}",
        keeps.lasting,
        w.lasting
    );
    assert!(keeps.banner_changes >= 4.0 * w.banner_changes);
}

/// The 7-day join schedule: 60% on day 0, the rest over days 1–5.
#[test]
fn cq_seven_day_joins() {
    let (sim, _) = play(&mc(9, 1_000, 7));
    let late = sim.agents.iter().filter(|a| a.join_day > 5).count();
    let d0 = sim.agents.iter().filter(|a| a.join_day == 0).count() as f64;
    assert_eq!(late, 0);
    assert!((d0 / 1_000.0 - 0.6).abs() < 0.05);
}

/// `MC_TEST` and the preset table: every value of §3.12.
#[test]
fn cq_presets_match_the_contract() {
    let f7 = McParams::FRONTIER_7;
    let f28 = McParams::FRONTIER_28;
    let t = McParams::TEST;
    assert_eq!(
        (f7.keep_bells, f7.keep_consolidate_bells, f7.keep_home_guard),
        (72, 288, 100)
    );
    assert_eq!(
        (f7.occupation_tenure_bells, f28.occupation_tenure_bells),
        (72, 288)
    );
    assert_eq!(
        (f7.capture_credit_min_bells, f28.capture_credit_min_bells),
        (144, 288)
    );
    assert_eq!(
        (f7.dormant_after_secs, f7.release_after_secs),
        (259_200, 604_800)
    );
    assert_eq!(
        (f28.dormant_after_secs, f28.release_after_secs),
        (432_000, 864_000)
    );
    assert_eq!(
        (f7.shield_secs, f28.shield_secs, f28.shield_late_secs),
        (86_400, 172_800, 259_200)
    );
    assert_eq!(
        (
            t.heartland_max_ring,
            t.free_city_min_ring,
            t.keep_bells,
            t.immunity_bells
        ),
        (2, 3, 24, 12)
    );
    assert_eq!(McParams::for_days(7), f7);
    assert_eq!(McParams::for_days(28), f28);
}

/// The thresholds files carry every gated figure of their gate, with
/// floors equal to §13.4's / §8.7's, and percentiles.
#[test]
fn cq_thresholds_files_are_complete() {
    for (text, gate) in [
        (
            include_str!("../thresholds/mc-7d-1k.json"),
            mapmove::floors_c10(7),
        ),
        (
            include_str!("../thresholds/mc-28d-10k.json"),
            mapmove::floors_28d(),
        ),
    ] {
        for g in &gate {
            assert_eq!(
                mapmove::json_num(text, &["gated", g.name, "floor"]),
                Some(g.floor),
                "{}",
                g.name
            );
            for q in ["p10", "p50", "p90"] {
                assert!(
                    mapmove::json_num(text, &["gated", g.name, q]).is_some(),
                    "{} {q}",
                    g.name
                );
            }
        }
    }
    let t = include_str!("../thresholds/mc-7d-1k.json");
    assert_eq!(
        mapmove::json_get(t, &["run", "bot_profile"]).as_deref(),
        Some("cq")
    );
    for k in [
        "departs_per_bot_day",
        "keep_marches_per_bot_day",
        "keep_captures_per_bot_day",
    ] {
        assert!(
            mapmove::json_num(t, &["reported", k, "p50"]).is_some(),
            "{k}"
        );
    }
}

/// `--policy` lists and ranges.
#[test]
fn cq_policy_parses() {
    let p = crate::parse_policy("campaign:0,lone:1-5");
    assert_eq!(p[0], Policy::Campaign);
    assert!(p[1..].iter().all(|&x| x == Policy::Lone));
    assert_eq!(crate::parse_policy("campaign"), [Policy::Campaign; 6]);
}
