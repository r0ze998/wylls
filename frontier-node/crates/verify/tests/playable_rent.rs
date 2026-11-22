//! rent-live-rest — VX's and VG's re-execution runs under the CLUSTER's
//! rent, never a silent 5,080: the Rent sysvar read over RPC with the final
//! states, recorded with the input (`chain.rent`), or declared
//! (`--lamports-per-byte`); with none, 5,080 is ASSUMED and the report says
//! so (`rent.source = "assumed"`, a `RentAssumed` WARN beside any
//! re-execution mismatch).
//!
//! Two recordings of the same natural playable-lane season by the committed
//! devnet-playable `.so` (da3dc1aa…) in the in-process LiteSVM chain:
//! `playable-lane-genesis.json.gz` at 5,080 lamports per byte (recorded
//! before the rent was recorded: no `chain.rent`) and
//! `playable-lane-genesis-6960.json.gz` at 6,960 with the chain's Rent
//! sysvar (`playable_lane.rs record_playable_lane_natural_6960`). Key-free:
//! they read the recordings only.
#![cfg(feature = "playable-lane")]

mod common;

use verify_core::input::{Input, RentRead};
use verify_core::{Report, Severity, Verdict};

const AT_5080: &str = "playable-lane-genesis.json.gz";
const AT_6960: &str = "playable-lane-genesis-6960.json.gz";
const SO_GZ: &str = "devnet-playable-da3dc1aa.so.gz";

fn so() -> std::sync::Arc<Vec<u8>> {
    let p = verify_core::reexec::Program::load(&common::fixtures_dir().join(SO_GZ))
        .expect("the committed .so");
    std::sync::Arc::new(p.so.as_ref().clone())
}

/// As the local node archived it (post-states included), with the pinned binary.
fn archived(name: &str) -> Input {
    let mut inp = common::fixture(name);
    inp.program_so = Some(so());
    inp
}

/// As a public RPC serves it: no post-states (VG re-executes from genesis).
fn rpc_shaped(name: &str) -> Input {
    let mut inp = archived(name);
    for t in inp.txs.iter_mut() {
        t.post.clear();
    }
    inp
}

fn show(r: &Report) -> Vec<String> {
    r.findings
        .iter()
        .map(|f| {
            format!(
                "{:?} {} {} {}",
                f.severity,
                f.check,
                f.code,
                f.detail.chars().take(300).collect::<String>()
            )
        })
        .collect()
}

fn rent_of(r: &Report) -> (String, Option<u64>) {
    let v = r.rent.as_ref().expect("the report states the rent");
    (
        v["source"].as_str().unwrap().to_string(),
        v["lamports_per_byte"].as_u64(),
    )
}

fn reexec_fails(r: &Report) -> bool {
    r.findings
        .iter()
        .any(|f| f.fail() && matches!(f.check, "VX" | "VG"))
}

fn warned_assumed(r: &Report) -> bool {
    r.findings
        .iter()
        .any(|f| f.code == "RentAssumed" && f.severity == Severity::Warn)
}

#[test]
fn the_6960_recording_carries_the_chains_rent_sysvar() {
    let inp = common::fixture(AT_6960);
    let rent = inp.chain.rent.as_ref().expect("recorded");
    assert!(!rent.declared);
    assert_eq!(rent.lamports_per_byte(), Some(6_960));
    assert!(rent.slot.is_some());
    assert_eq!(inp.chain.balances.len(), inp.txs.len());
    // the 5,080 recording predates it: no rent recorded (re-executions assume)
    assert!(common::fixture(AT_5080).chain.rent.is_none());
}

#[test]
fn at_6960_the_archive_and_the_genesis_replay_pass_under_the_chains_rent() {
    let r = verify_core::verify(&archived(AT_6960));
    assert_eq!(r.verdict, Verdict::Pass, "{:#?}", show(&r));
    assert_eq!(rent_of(&r), ("chain".into(), Some(6_960)));
    assert!(r.checks_run.contains(&"VX:re-execution"));
    let r = verify_core::verify(&rpc_shaped(AT_6960));
    assert_eq!(r.verdict, Verdict::Pass, "{:#?}", show(&r));
    assert!(r.checks_run.contains(&"VG:genesis-replay"));
    assert_eq!(rent_of(&r), ("chain".into(), Some(6_960)));
    assert!(!warned_assumed(&r));
}

#[test]
fn at_6960_without_the_rent_the_assumed_5080_is_never_a_pass_and_says_it_was_assumed() {
    // (the archive with post-states: VX reads the extra lamports as a credit outside the archive — UNVERIFIABLE;
    //  without post-states: VG's exact end state differs — FAIL. Either way never PASS, and the WARN names the rate.)
    for (mut inp, want) in [
        (archived(AT_6960), Verdict::Unverifiable),
        (rpc_shaped(AT_6960), Verdict::Fail),
    ] {
        inp.chain.rent = None;
        let r = verify_core::verify(&inp);
        assert_eq!(r.verdict, want, "{:#?}", show(&r));
        assert!(
            r.findings.iter().any(|f| matches!(f.check, "VX" | "VG")
                && f.severity != Severity::Warn
                && f.code != "RentAssumed"),
            "{:#?}",
            show(&r)
        );
        assert_eq!(rent_of(&r), ("assumed".into(), Some(5_080)));
        assert!(warned_assumed(&r), "{:#?}", show(&r));
        assert!(r.markdown().contains("**ASSUMED**"));
    }
}

#[test]
fn a_declared_rate_is_used_and_labelled_and_the_wrong_one_fails() {
    // 6,960 recording, rent stripped, the operator declares the right rate
    let mut inp = rpc_shaped(AT_6960);
    inp.chain.rent = Some(RentRead::declared(6_960));
    let r = verify_core::verify(&inp);
    assert_eq!(r.verdict, Verdict::Pass, "{:#?}", show(&r));
    assert_eq!(rent_of(&r), ("declared".into(), Some(6_960)));
    // 5,080 recording: declared 5,080 passes, declared 6,960 fails (no WARN: not assumed)
    let mut inp = rpc_shaped(AT_5080);
    inp.chain.rent = Some(RentRead::declared(5_080));
    let r = verify_core::verify(&inp);
    assert_eq!(r.verdict, Verdict::Pass, "{:#?}", show(&r));
    assert_eq!(rent_of(&r), ("declared".into(), Some(5_080)));
    let mut inp = rpc_shaped(AT_5080);
    inp.chain.rent = Some(RentRead::declared(6_960));
    let r = verify_core::verify(&inp);
    assert_eq!(r.verdict, Verdict::Fail, "{:#?}", show(&r));
    assert!(reexec_fails(&r));
    assert!(!warned_assumed(&r));
}

#[test]
fn the_5080_recording_without_rent_still_passes_and_the_report_says_assumed() {
    for inp in [archived(AT_5080), rpc_shaped(AT_5080)] {
        let r = verify_core::verify(&inp);
        assert_eq!(r.verdict, Verdict::Pass, "{:#?}", show(&r));
        assert_eq!(rent_of(&r), ("assumed".into(), Some(5_080)));
        assert!(!warned_assumed(&r), "no mismatch, no WARN");
        assert!(r.json()["rent"]["source"] == "assumed");
    }
    // without the pinned binary nothing is re-executed and no rent is stated
    let r = verify_core::verify(&common::fixture(AT_5080));
    assert!(r.rent.is_none());
}

#[test]
fn v9_counts_prefunded_accounts_at_the_seasons_rent() {
    let count = |r: &Report| {
        r.findings
            .iter()
            .find(|f| f.code == "PrefundedAddress")
            .map(|f| f.detail.split(' ').next().unwrap().parse::<u64>().unwrap())
            .unwrap_or(0)
    };
    let at_chain = count(&verify_core::verify(&archived(AT_6960)));
    let at_5080 = count(&verify_core::verify(&archived(AT_5080)));
    // the same season at either rate holds the same accounts above their minimum
    assert_eq!(at_chain, at_5080);
    let mut assumed = archived(AT_6960);
    assumed.chain.rent = None;
    assert!(count(&verify_core::verify(&assumed)) > at_chain);
}

#[test]
fn the_rent_record_round_trips_and_refuses_what_disagrees() {
    let inp = common::fixture(AT_6960);
    let r = inp.chain.rent.clone().unwrap();
    assert_eq!(RentRead::from_json(&r.to_json()).unwrap(), r);
    let d = RentRead::declared(6_960);
    assert_eq!(RentRead::from_json(&d.to_json()).unwrap(), d);
    let mut j = r.to_json();
    j["lamports_per_byte"] = 5_080.into();
    assert!(RentRead::from_json(&j).is_err());
    let mut j = r.to_json();
    j["source"] = "guess".into();
    assert!(RentRead::from_json(&j).is_err());
    let mut j = r.to_json();
    j["data"] = "00".into();
    assert!(RentRead::from_json(&j).is_err());
    // the fixture JSON keeps it through a save and a load
    let back = Input::from_json(&inp.to_json()).unwrap();
    assert_eq!(back.chain.rent, inp.chain.rent);
    // the old sysvar form 3,480 x 2.0 charges 6,960 per byte
    let old = fclient::rent::RentSysvar {
        lamports_per_byte_year: 3_480,
        exemption_threshold: 2.0,
        burn_percent: 50,
    };
    let o = RentRead::from_chain(&old.encode(), 1).unwrap();
    assert_eq!(o.lamports_per_byte(), Some(6_960));
}
