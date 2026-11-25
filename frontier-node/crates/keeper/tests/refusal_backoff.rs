//! fix-keeper-backoff (D-dress-8) over `localnet` in process: the real
//! keeper's archive duty with one region's ArchiveAnchors refused
//! deterministically. The keeper's view of region 0's anchors names a wrong
//! `rent_to` (the dress rehearsal's cause: declared anchors with no poster),
//! so the program answers `BadAccount` to every batch of region 0, for good.
//! The same run twice:
//!
//! - **before**: the new engine with the old engine's parameters (2, 4, … slots capped at 1,024,
//!   no pass gate, no group breaker: `refusal_max_slots = 1024`,
//!   `refusal_max_passes = 0`, `refusal_group_min = 0`);
//! - **after**: the keeper.toml defaults (9,000 slots, 64 passes, group 4).
//!
//! Healthy duties keep their cadence in both: every anchor of every region
//! lands, the other 15 regions' day 0 is archived and their caches close.
//!
//! A second test refuses **every** region's batches (a systemic refusal: no
//! ArchiveAnchors lands at all), where the group breaker sends one probe at
//! a time instead of every key on its own schedule.

mod common;
mod model;

use fclient::abi::{tag, BELL_SECS};
use fclient::ports::{ChainPort, Cursor};
use fclient::Address;
use keeper_core::journal::Journal;
use keeper_core::Keeper;

use common::*;

const BAD_REGION: u8 = 0;

struct Run {
    region0_sends: usize,
    region0_landed: usize,
    other_archive_sends: usize,
    archived_bells: u64,
    caches_closed: u64,
    anchors: usize,
    anchor_p99: Option<u64>,
    ticks: u64,
    slots: u64,
    suppressed: u64,
    status: serde_json::Value,
    archive_kind: serde_json::Value,
}

async fn run(old_schedule: bool, every_region: bool) -> Run {
    let w = world().await;
    let genesis_ts = w.season().genesis_ts;
    let mut cfg = keeper_config(&w);
    if old_schedule {
        cfg.refusal_max_slots = 1_024;
        cfg.refusal_max_passes = 0;
        cfg.refusal_group_min = 0;
    }
    let mut k = Keeper::new(
        cfg,
        w.ip.clone(),
        w.drand.clone(),
        &[0x52u8; 32],
        Some(Journal::open(std::path::Path::new(":memory:")).unwrap()),
    )
    .unwrap();
    fund(&w, &k.payers);
    k.start().await.unwrap();
    let wrong = Address::new_from_array([0xd8; 32]);
    // Day 0 is archivable 48 h after its last anchor; then 12 more hours of
    // the keeper retrying region 0.
    let end = genesis_ts + 144 * BELL_SECS + 172_800 + 12 * 3_600;
    let (mut ticks, first_slot) = (0u64, w.ip.clock().await.unwrap().slot);
    while w.now() < end {
        for ((_, r), a) in k.beacon.anchors.iter_mut() {
            if every_region || *r == BAD_REGION {
                a.rent_to = wrong;
            }
        }
        k.tick().await.unwrap();
        ticks += 1;
        w.step();
    }
    let clock = w.ip.clock().await.unwrap();
    // Every ArchiveAnchors of the run, from the chain's own feed.
    let all = localnet::InProcess::from_chain(w.ip.chain.clone(), None);
    let mut feed: Vec<fclient::ports::TxRecord> = vec![];
    loop {
        let got = all
            .feed(Cursor(feed.last().map_or(0, |r| r.seq)))
            .await
            .unwrap();
        if got.is_empty() {
            break;
        }
        feed.extend(got);
    }
    let (mut region0_sends, mut region0_landed, mut other_archive_sends) = (0, 0, 0);
    for r in &feed {
        if r.tx.is_empty() {
            continue;
        }
        let t = fclient::tx::from_wire(&r.tx).unwrap();
        let m = &t.message;
        for ci in &m.instructions {
            if m.account_keys[ci.program_id_index as usize] != w.program
                || ci.data.first() != Some(&tag::ARCHIVE_ANCHORS)
            {
                continue;
            }
            if every_region || ci.data[1] == BAD_REGION {
                region0_sends += 1;
                region0_landed += usize::from(r.err.is_none());
            } else {
                other_archive_sends += 1;
            }
        }
    }
    let p99 = {
        let mut v = k.beacon.anchor_latency.clone();
        v.sort_unstable();
        (!v.is_empty()).then(|| v[((v.len() - 1) as f64 * 0.99) as usize])
    };
    Run {
        region0_sends,
        region0_landed,
        other_archive_sends,
        archived_bells: k.archive.archived_bells,
        caches_closed: k.archive.caches_closed,
        anchors: k.beacon.anchors.len(),
        anchor_p99: p99,
        ticks,
        slots: clock.slot - first_slot,
        suppressed: k.engine.stats.get("archive").map_or(0, |s| s.suppressed),
        status: k.status_json(clock.slot, clock.unix_timestamp, None)["refusals"].clone(),
        archive_kind: k.status_json(clock.slot, clock.unix_timestamp, None)["kinds"]["archive"]
            .clone(),
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn refused_archive_backs_off_while_healthy_duties_keep_cadence() {
    let t0 = std::time::Instant::now();
    let before = run(true, false).await;
    let after = run(false, false).await;
    for (name, r) in [("before", &before), ("after", &after)] {
        println!(
            "{name}: region-0 ArchiveAnchors sent {} (landed {}), other regions' ArchiveAnchors {}, \
             archived bells {}, caches closed {}, anchors {}, anchor latency p99 {:?} slots, \
             {} ticks / {} slots, ensure calls held back {}",
            r.region0_sends,
            r.region0_landed,
            r.other_archive_sends,
            r.archived_bells,
            r.caches_closed,
            r.anchors,
            r.anchor_p99,
            r.ticks,
            r.slots,
            r.suppressed,
        );
    }
    for (name, r) in [("before", &before), ("after", &after)] {
        println!("{name}: kinds.archive = {}", r.archive_kind);
    }
    println!(
        "after: /v1/status.refusals = {}",
        serde_json::to_string(&after.status).unwrap()
    );
    println!("both runs in {:.1} s", t0.elapsed().as_secs_f64());
    if before.archived_bells == 0 && after.archived_bells == 0 {
        println!("the program has no ArchiveAnchors here; nothing to compare");
        return;
    }
    // The refused write: never lands, and is sent far less often.
    assert_eq!((before.region0_landed, after.region0_landed), (0, 0));
    assert!(before.region0_sends > 0);
    // (This localnet runs ~75 slots a bell, devnet ~1,500: the run covers
    // only ~4 h of slots, so the 9,000-slot cap shows little of its
    // long-run effect; ≥ 25 % fewer here, measured 363 vs 543.)
    assert!(
        after.region0_sends * 4 <= before.region0_sends * 3,
        "after {} vs before {}",
        after.region0_sends,
        before.region0_sends
    );
    assert!(after.status["held"].as_u64().unwrap() > 0);
    assert!(after.status["refused_total"].as_u64().unwrap() > 0);
    // Healthy duties: the same work in both runs.
    assert_eq!(before.archived_bells, after.archived_bells);
    assert!(
        after.archived_bells >= 144 * 15,
        "15 healthy regions' day 0"
    );
    assert_eq!(before.anchors, after.anchors);
    assert_eq!(before.other_archive_sends, after.other_archive_sends);
    assert_eq!(before.caches_closed, after.caches_closed);
    assert!(after.anchor_p99 <= before.anchor_p99.map(|p| p + 1));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn systemic_archive_refusal_is_probed_one_key_at_a_time() {
    let t0 = std::time::Instant::now();
    let before = run(true, true).await;
    let after = run(false, true).await;
    for (name, r) in [("before", &before), ("after", &after)] {
        println!(
            "{name} (every region refused): ArchiveAnchors sent {} (landed {}), anchors {}, \
             anchor latency p99 {:?} slots, {} ticks / {} slots, ensure calls held back {}",
            r.region0_sends,
            r.region0_landed,
            r.anchors,
            r.anchor_p99,
            r.ticks,
            r.slots,
            r.suppressed,
        );
        println!(
            "{name} (every region refused): kinds.archive = {}",
            r.archive_kind
        );
    }
    let groups = &after.status["groups_open"];
    println!("after (every region refused): groups_open = {groups}");
    println!("both runs in {:.1} s", t0.elapsed().as_secs_f64());
    if before.region0_sends == 0 {
        println!("the program has no ArchiveAnchors here; nothing to compare");
        return;
    }
    assert_eq!((before.region0_landed, after.region0_landed), (0, 0));
    assert!(
        after.region0_sends * 5 <= before.region0_sends,
        "after {} vs before {}",
        after.region0_sends,
        before.region0_sends
    );
    assert_eq!(groups.as_array().unwrap().len(), 1, "{groups}");
    assert_eq!(groups[0]["kind"], "archive");
    assert_eq!(groups[0]["error"], "BadAccount");
    // The beacon is exempt and unaffected.
    assert_eq!(before.anchors, after.anchors);
    assert!(after.anchor_p99 <= before.anchor_p99.map(|p| p + 1));
}

/// verify-pr192: a keeper that starts (or restarts) with an archive backlog
/// while region 0 is refused for good. The backlog goes out in one pass;
/// region 0's batches are refused and retried together with nothing else
/// of the kind in flight, so the archive group breaker opens. `plan_archive`
/// plans region 0 first: before the fix every probe went to region 0 and
/// the 15 healthy regions archived nothing more for the rest of the run.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn stuck_region_backlog_does_not_starve_healthy_archives() {
    let t0 = std::time::Instant::now();
    let mut got = vec![];
    for old_schedule in [true, false] {
        let w = world().await;
        let genesis_ts = w.season().genesis_ts;
        let mut cfg = keeper_config(&w);
        if old_schedule {
            cfg.refusal_max_slots = 1_024;
            cfg.refusal_max_passes = 0;
            cfg.refusal_group_min = 0;
        }
        let mut k = Keeper::new(
            cfg,
            w.ip.clone(),
            w.drand.clone(),
            &[0x52u8; 32],
            Some(Journal::open(std::path::Path::new(":memory:")).unwrap()),
        )
        .unwrap();
        fund(&w, &k.payers);
        k.start().await.unwrap();
        let wrong = Address::new_from_array([0xd8; 32]);
        // Archive held off until half of day 1 is archivable too (a backlog
        // of several batches per region), then 12 h of archive.
        let flush = genesis_ts + 144 * BELL_SECS + 172_800 + 6 * 3_600;
        let end = flush + 12 * 3_600;
        let mut at_flush = None;
        while w.now() < end {
            for ((_, r), a) in k.beacon.anchors.iter_mut() {
                if *r == BAD_REGION {
                    a.rent_to = wrong;
                }
            }
            k.archive.unsupported = w.now() < flush;
            if !k.archive.unsupported && at_flush.is_none() {
                at_flush = Some(k.archive.archived_bells);
            }
            k.tick().await.unwrap();
            w.step();
        }
        let at_flush = at_flush.unwrap();
        let clock = w.ip.clock().await.unwrap();
        let st = k.status_json(clock.slot, clock.unix_timestamp, None);
        println!(
            "{}: archived bells {} (backlog pass and after), caches closed {}, \
             kinds.archive = {}, groups_open = {}",
            if old_schedule {
                "old schedule"
            } else {
                "defaults"
            },
            k.archive.archived_bells - at_flush,
            k.archive.caches_closed,
            st["kinds"]["archive"],
            st["refusals"]["groups_open"],
        );
        got.push(k.archive.archived_bells - at_flush);
    }
    println!("both runs in {:.1} s", t0.elapsed().as_secs_f64());
    if got[0] == 0 {
        println!("the program has no ArchiveAnchors here; nothing to compare");
        return;
    }
    // The healthy regions archive the same bells under both schedules.
    assert_eq!(
        got[1], got[0],
        "healthy archived bells: old {} vs defaults {}",
        got[0], got[1]
    );
}
