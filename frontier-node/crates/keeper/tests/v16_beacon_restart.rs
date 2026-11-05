//! ⑯ independent verification (⑧ restart inside a bell): how many
//! PostBeacon writes land in one region's BeaconLog during one bell when
//! the keeper is restarted from its journal in the middle of that bell.
//!
//! The keeper's once-per-bell guard for BeaconLog posts
//! (`beacon.rs` `beacon_log_bell`) lives in memory; ⑧ reported (commit
//! 5366f7c5, not in the integration candidate) that a restart inside a bell
//! posts that bell again with a newer round: extra fees, no duplicated
//! state (the program refuses only older rounds). This test counts posts per
//! (bell, region) from the chain itself (each landed post changes
//! `posted_ts`), with a restart and, as the control, without one.
//!
//! Harness: `tests/common` (localnet in process, the test-beacon key; the
//! program is the `.so` named by `PSF_FRONTIER_SO`, else the native model).

mod common;
mod model;

use std::collections::BTreeMap;

use fclient::abi::BELL_SECS;
use fclient::decode::BeaconLog;
use keeper_core::journal::{self, Journal};
use keeper_core::Keeper;

use common::*;

/// Posts per (bell, region) seen on chain over `bells` bells, restarting
/// the keeper at `restart_into` seconds into bell `restart_bell` (if any).
async fn run(name: &str, bells: u32, restart: Option<(u32, i64)>) -> BTreeMap<(u32, u8), u32> {
    let w = world().await;
    println!("program: {}", w.which.label());
    let s = w.season();
    let regions = s.regions;
    let sc = fclient::clock::SeasonClock::from_season(&s);
    let dir = std::env::temp_dir().join(format!("keeper-v16-beacon-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let jpath = dir.join("keeper.journal.sqlite");
    let master = [0x16u8; 32];
    let cfg = keeper_config(&w);
    let mut lock = Some(journal::lock(&jpath).unwrap());
    let mut k = Keeper::new(cfg.clone(), w.ip.clone(), w.drand.clone(), &master, Some(Journal::open(&jpath).unwrap())).unwrap();
    fund(&w, &k.payers);
    k.start().await.unwrap();

    let mut last: BTreeMap<u8, (u64, i64)> = BTreeMap::new();
    let mut posts: BTreeMap<(u32, u8), u32> = BTreeMap::new();
    let mut restarted = false;
    let end = s.genesis_ts + bells as i64 * BELL_SECS;
    while w.now() < end {
        k.tick().await.unwrap();
        w.step();
        for r in 0..regions {
            let Some(a) = w.ip.lock().account(&w.addrs.beacon_log(r)) else { continue };
            let Ok(l) = BeaconLog::decode(&a.data) else { continue };
            let cur = (l.latest_round, l.posted_ts);
            if last.get(&r) != Some(&cur) {
                last.insert(r, cur);
                let b = sc.bell_at(l.posted_ts).unwrap_or(u32::MAX);
                *posts.entry((b, r)).or_default() += 1;
            }
        }
        if let Some((rb, into)) = restart {
            if !restarted && w.now() >= s.genesis_ts + rb as i64 * BELL_SECS + into {
                restarted = true;
                drop(k);
                lock.take().unwrap().unlock().unwrap();
                lock = Some(journal::lock(&jpath).expect("the restart takes the lock"));
                k = Keeper::new(cfg.clone(), w.ip.clone(), w.drand.clone(), &master, Some(Journal::open(&jpath).unwrap())).unwrap();
                let adopted = k.start().await.unwrap();
                println!("{name}: restart at bell {rb} + {into} s (slot {}), {adopted} adopted", w.slot());
            }
        }
    }
    drop(lock);
    println!("{name}: posts per (bell, region) where > 1: {:?}", posts.iter().filter(|(_, &n)| n > 1).collect::<Vec<_>>());
    posts
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn v16_r1_beaconlog_posts_once_per_bell_and_region_across_a_restart() {
    // Control: no restart; one post per bell and region (the measure is sound).
    let base = run("control", 6, None).await;
    let dup_base: Vec<_> = base.iter().filter(|(_, &n)| n > 1).collect();
    assert!(!base.is_empty(), "the keeper posted no BeaconLog at all; the measure is empty");
    assert!(dup_base.is_empty(), "control without restart already posts twice: {dup_base:?}");
    // Restart 300 s into bell 3, after that bell's posts landed.
    let got = run("restart", 6, Some((3, 300))).await;
    let in_bell3: u32 = got.iter().filter(|((b, _), _)| *b == 3).map(|(_, &n)| n).sum();
    let regions_bell3 = got.keys().filter(|(b, _)| *b == 3).count() as u32;
    let dup: Vec<_> = got.iter().filter(|(_, &n)| n > 1).collect();
    assert!(
        dup.is_empty(),
        "a restart inside bell 3 posted BeaconLog again in the same bell: {} posts for {} regions ({} extra PostBeacon fees, no state duplicated); per (bell, region) > 1: {dup:?}",
        in_bell3, regions_bell3, in_bell3 - regions_bell3
    );
}
