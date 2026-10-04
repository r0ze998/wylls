//! The brain against files recorded from a real herald (the paused m1-exit
//! stack, read-only GETs, 2026-10-04): `permutation-gateway/test/fixtures/
//! ai-brain-real` (bots seed 1, wallets 153 and 202, the files `Bot::observe`
//! reads, at game time = bell 997). Units are the chain's: a 100-troop host
//! is 100000 milli-troops, a camp has 100..400 whole troops.
//!
//! The recording is a **final-state** herald (the season had ended), read at
//! an earlier game time: it checks parsing, units and the candidate shape on
//! real bytes, not a timeline.

#[path = "ai_common.rs"]
mod common;

use common::*;
use frontier_agents::profile::Arch;
use frontier_bots::ai::brain::{self, Inputs};
use frontier_bots::ai::DayState;
use frontier_bots::bot::Bot;
use serde_json::json;

const NOW: i64 = 1_789_685_000;
const WALLET_153: u32 = 153;

fn bot(i: u32) -> Bot {
    let mut b = Bot::new(spec(i, Arch::Skilled), 1);
    b.ai.on = true;
    b
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn real_herald_files_give_whole_troop_candidates_in_the_wire_shape() {
    let fm = FakeMind::start(|_| autopilot_answer("below_gate")).await;
    let r = rig_real(Some(&fm), &[(WALLET_153, "ai")], NOW);
    let mut b = bot(WALLET_153);
    b.step(&r.sh, true).await;
    assert_eq!(fm.n_requests(), 1, "the brain asked once");
    let req = fm.requests.lock().unwrap()[0].clone();
    check_request_shape(&req);
    let me = &req["situation"]["me"];
    // The recorded wallet's two hosts are 100 troops each (100000 milli).
    let hosts = me["hosts"].as_array().unwrap();
    assert_eq!(hosts.len(), 2, "{hosts:?}");
    for h in hosts {
        assert_eq!(h["troops"], 100, "whole troops: {h}");
        assert_eq!(h["unit"], "spearman");
    }
    assert!(me["home_troops"].as_u64().unwrap() >= 200);
    // Camps are whole troops too (100..400).
    for p in req["situation"]["neighbourhood"].as_array().unwrap() {
        if let Some(c) = p.get("camp_troops") {
            let c = c.as_u64().unwrap();
            assert!((100..=400).contains(&c), "camp troops {c}");
        }
    }
    println!(
        "real: candidates {:?}",
        req["candidates"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| c["kind"].as_str().unwrap().to_string())
            .collect::<Vec<_>>()
    );
    println!("real: hosts {}", json!(hosts));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_real_recording_is_deterministic_and_the_march_obeys_the_caps() {
    let r = rig_real(None, &[(WALLET_153, "ai")], NOW);
    let b = bot(WALLET_153);
    let obs = b.observe(&r.sh).await.unwrap();
    let h = brain::home_holding(&obs).expect("a final home");
    let rows = brain::host_rows(&obs, h);
    let (home, _) = brain::home_troops(&obs, h, &rows);
    let ds = DayState {
        day: 0,
        h0: home,
        marches: vec![],
    };
    let mk = || Inputs {
        obs: &obs,
        h,
        faction: h.faction,
        ds: &ds,
        presets: obs
            .season
            .tip_presets(frontier_bots::bot::Config::new(1).reveal_loaded_limit()),
        autopilot_summary: String::new(),
        rows: rows.clone(),
        home_troops: home,
        quota_left: 40,
    };
    let a = brain::candidates(&mk());
    let c = brain::candidates(&mk());
    assert_eq!(a, c);
    for o in &a {
        if let Some(t) = o.cand.troops {
            // Every march candidate passes V3(a): at most 60 % of home troops.
            assert!(t as u64 * 100 <= 60 * home as u64, "{t} of {home}");
        }
    }
    println!(
        "real: home_troops {home}, rows {}, candidates {}",
        rows.len(),
        a.len()
    );
}
