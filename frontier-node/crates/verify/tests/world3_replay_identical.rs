//! world4-pacing-impl: **world 3 is unchanged by the pacing program**.
//!
//! The next world's pacing rules (`frontier_abi::v2::pacing`) live in the
//! same program as world 3 and are gated by Season bytes that world 3 stores
//! as zero. This test re-executes EVERY archived transaction of the committed
//! playable-lane recordings (the lane world 3 runs, program version 0x4804)
//! twice from the archive's own pre-states (`vx_reexec::replay_one`, the
//! verifier's re-execution): once with world 3's program (the committed
//! fixture `devnet-playable-245ce1ab.so.gz`, = origin/main's build) and once
//! with the program under test, and requires the two outcomes to be
//! identical: the error (or success), every judged log line (all but the
//! runtime's compute-unit accounting) and every post-state account, byte for
//! byte.
//!
//! Run (needs the program under test, a devnet-playable build):
//! `PSF_PACING_SO=/abs/permutation_frontier.so cargo test -p verify --features playable-lane \
//!   --test world3_replay_identical -- --ignored --nocapture`
//!
//! Deliberate break: `PSF_PACING_SO` pointing at a program whose behaviour
//! differs for world 3 fails here (checked with a build that always charges
//! 37 stamina at Depart; see reports/world4-pacing-impl.md).
#![cfg(feature = "playable-lane")]

mod common;

use std::sync::Arc;

use verify_core::reexec::{judged_logs, Program, Replayed};

const WORLD3_SO: &str = "devnet-playable-245ce1ab.so.gz";
const WORLD3_SHA256: &str = "245ce1abcdb48d59aaec9e74eb571f5316e89302b02ae877bd3976b9245d0d34";

/// The compute units the frontier program's top-level invocation reports (the last "consumed N of" line).
fn cu_of(logs: &[String]) -> u64 {
    logs.iter()
        .filter_map(|l| {
            let rest = l.split(" consumed ").nth(1)?;
            rest.split(' ').next()?.parse::<u64>().ok()
        })
        .max()
        .unwrap_or(0)
}

fn outcome(r: &Replayed) -> String {
    let logs: Vec<&str> = judged_logs(&r.logs);
    let accounts: Vec<String> = r
        .accounts
        .iter()
        .map(|(k, _, _, post)| format!("{k:?}={post:?}"))
        .collect();
    format!("err={:?}\nlogs={logs:?}\naccounts={accounts:?}", r.err)
}

#[test]
#[ignore = "needs PSF_PACING_SO (a devnet-playable build of the program under test)"]
fn every_archived_world3_lane_transaction_replays_identically() {
    let new_path = std::env::var("PSF_PACING_SO").expect("PSF_PACING_SO");
    let new = Program::load(std::path::Path::new(&new_path)).expect("the program under test");
    // (verify-pr279) `PSF_WORLD3_SO`: a rebuild of origin/main's devnet-playable program instead of the committed
    // fixture; it must still be world 3's program byte for byte (sha256 below).
    let old_path = std::env::var("PSF_WORLD3_SO")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| common::fixtures_dir().join(WORLD3_SO));
    let old = Program::load(&old_path).expect("world 3's .so");
    assert_eq!(
        hex::encode(old.sha256()),
        WORLD3_SHA256,
        "the fixture is world 3's program"
    );
    assert_ne!(
        old.sha256(),
        new.sha256(),
        "PSF_PACING_SO is not another program"
    );
    let old_so = Arc::new(old.so.as_ref().clone());
    let new_so = Arc::new(new.so.as_ref().clone());
    let mut names: Vec<String> = std::fs::read_dir(common::fixtures_dir())
        .expect("fixtures")
        .filter_map(|e| e.ok()?.file_name().into_string().ok())
        .filter(|n| n.starts_with("playable-") && n.ends_with(".json.gz"))
        .collect();
    names.sort();
    let mut paths: Vec<(String, std::path::PathBuf)> = names
        .iter()
        .map(|n| (n.clone(), common::fixtures_dir().join(n)))
        .collect();
    // (verify-pr279) `PSF_WORLD3_ARCHIVE`: more verifier inputs (':'-separated paths), e.g. a read-only copy of the
    // live world-3 archive pulled by scripts/devnet/verify-watch.mjs (`input.json.gz`).
    if let Ok(more) = std::env::var("PSF_WORLD3_ARCHIVE") {
        for p in more.split(':').filter(|p| !p.is_empty()) {
            paths.push((p.to_string(), std::path::PathBuf::from(p)));
        }
    }
    let (mut files, mut txs, mut replayed, mut ok_txs, mut unreplayable) = (0, 0, 0, 0, 0);
    let mut diffs = vec![];
    let mut cu_rows: Vec<String> = vec![];
    for (name, path) in &paths {
        let Ok(base) = verify_core::input::Input::load(path) else {
            println!("{name}: not loadable, skipped");
            continue;
        };
        files += 1;
        println!("{name}: {} transactions", base.txs.len());
        let mut a = base.clone();
        a.program_so = Some(old_so.clone());
        let mut b = base;
        b.program_so = Some(new_so.clone());
        for i in 0..a.txs.len() {
            txs += 1;
            let ra = verify_core::checks::vx_reexec::replay_one(&a, i);
            let rb = verify_core::checks::vx_reexec::replay_one(&b, i);
            match (ra, rb) {
                (Ok(x), Ok(y)) => {
                    replayed += 1;
                    cu_rows.push(format!(
                        "{name}\t{i}\t{}\t{}\t{}",
                        cu_of(&x.logs),
                        cu_of(&y.logs),
                        x.err.is_none()
                    ));
                    if x.err.is_none() {
                        ok_txs += 1;
                    }
                    let (ox, oy) = (outcome(&x), outcome(&y));
                    if ox != oy {
                        diffs.push(format!(
                            "{name} tx#{i}:\n world3: {}\n new:    {}",
                            &ox[..ox.len().min(600)],
                            &oy[..oy.len().min(600)]
                        ));
                    }
                }
                (Err(e), Err(f)) if e == f => unreplayable += 1,
                (x, y) => diffs.push(format!(
                    "{name} tx#{i}: replay differs: world3 {:?} / new {:?}",
                    x.map(|r| r.err),
                    y.map(|r| r.err)
                )),
            }
        }
    }
    println!(
        "world3-replay: {files} recordings, {txs} transactions, {replayed} re-executed ({ok_txs} succeeded under world 3's program), {unreplayable} not re-executable by either (same reason), {} differing",
        diffs.len()
    );
    // (verify-pr279) `PSF_CU_TSV`: every re-executed transaction's compute units under both programs
    // (file, index, world 3's, the program under test's, succeeded) for a per-instruction CU comparison.
    if let Ok(out) = std::env::var("PSF_CU_TSV") {
        std::fs::write(&out, cu_rows.join("\n") + "\n").expect("PSF_CU_TSV");
    }
    assert!(replayed > 0, "nothing was re-executed");
    assert!(
        diffs.is_empty(),
        "world 3 would change:\n{}",
        diffs.join("\n")
    );
}
