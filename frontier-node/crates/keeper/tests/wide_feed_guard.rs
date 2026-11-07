//! Literal bytes and in-memory planning only. No key generation, private
//! keys, signing, transaction execution, BLS, or network access.
use std::collections::{BTreeMap, VecDeque};
use std::path::Path;
use std::sync::{Arc, Mutex};

use base64::Engine as _;
use fclient::abi::{self, Class};
use fclient::addr::Addresses;
use fclient::budgets::Budgets;
use fclient::ports::*;
use fclient::Address;
use frontier_abi::log::{self as plog, Kind};
use keeper_core::engine::{BuildCtx, Engine, EngineParams, WriteSpec};
use keeper_core::feedguard::FeedBlock;
use keeper_core::journal::Journal;
use keeper_core::landindex::LandIndex;
use keeper_core::play::PlayDuty;
use keeper_core::playindex::PlayIndex;

fn addrs() -> Addresses {
    Addresses {
        program: Address::new_from_array([23; 32]),
        season_id: 7,
        season: Address::new_from_array([24; 32]),
        bump: 255,
    }
}
fn line(tag: &[u8], body: &[u8]) -> String {
    let b64 = base64::engine::general_purpose::STANDARD;
    format!("Program data: {} {}", b64.encode(tag), b64.encode(body))
}
fn province(p: i32) -> Vec<u8> {
    let mut key = p.to_le_bytes().to_vec();
    key.extend(2i32.to_le_bytes());
    let mut body = vec![0; 512];
    let n = plog::write_body(
        Kind::PROVINCE_OPEN,
        3,
        &key,
        &vec![0; Kind::PROVINCE_OPEN.spec().payload_len()],
        &mut body,
    )
    .unwrap();
    body.truncate(n);
    body.push(0);
    body
}
fn tx(seq: u64, lines: Vec<String>) -> TxRecord {
    TxRecord {
        seq,
        slot: 10 + seq,
        signature: Signature::from([seq as u8; 64]),
        block_time: 0,
        tx: vec![],
        logs: fclient::log::in_frame(&addrs().program, lines),
        err: None,
        code: None,
        units: 0,
        fee: 0,
        post: vec![],
    }
}
fn legacy(seq: u64) -> TxRecord {
    tx(seq, vec![line(b"PS2", &province(seq as i32))])
}
fn wide(seq: u64) -> TxRecord {
    tx(seq, vec![line(b"PSW1", &[0x82, 7])])
}
fn engine() -> Engine {
    Engine::new(Budgets::default(), EngineParams::default())
}
fn spec(kind: &'static str, key: &str) -> WriteSpec {
    WriteSpec {
        key: key.into(),
        kind,
        tag: abi::tag::RESOLVE_CLASH,
        class: Class::D,
        bell: None,
        region: None,
        build: Arc::new(|_: &BuildCtx| panic!("must not build/sign")),
        deadline_slot: None,
        not_before_slot: 0,
        fixed_payer: None,
    }
}

#[test]
fn both_indexes_freeze_before_first_wide_transaction_and_stay_blocked() {
    let a = addrs();
    let mut land = LandIndex::default();
    let mut play = PlayIndex::default();
    // A mixed transaction is atomic: its leading PS2 body must not be applied.
    let mixed = tx(
        2,
        vec![line(b"PS2", &province(99)), line(b"PSW1", &[0x82, 7])],
    );
    let page = vec![legacy(1), mixed, legacy(3)];
    assert_eq!(land.ingest_page(&page, &a), 1);
    assert_eq!(play.ingest_page(&page, &a), 1);
    assert_eq!(land.cursor, Cursor(1));
    assert_eq!(play.cursor, Cursor(1));
    assert_eq!(land.provinces, [(1, 2)].into());
    assert_eq!(play.provinces, [(1, 2)].into());
    assert_eq!(land.feed.blocked(), play.feed.blocked());
    assert_eq!(land.feed.blocked().unwrap().seq, 2);
    assert_eq!(land.feed.status()["state"], "blocked");
    assert_eq!(land.feed.status()["automatic_writes"], false);
    assert_eq!(land.ingest_page(&[legacy(4)], &a), 0);
    assert_eq!(play.ingest_page(&[legacy(4)], &a), 0);
    land.ingest(&province(5), 20, &a);
    play.ingest(&province(5), 20);
    assert_eq!(land.provinces.len(), 1);
    assert_eq!(play.provinces.len(), 1);
    assert_eq!(land.bad, 1);
    assert_eq!(play.bad, 1);
}

#[test]
fn failed_wide_and_other_program_frames_do_not_poison_legacy_history() {
    let mut failed = wide(1);
    failed.err = Some("failure".into());
    let other = Address::new_from_array([25; 32]);
    let nested = tx(
        2,
        vec![
            format!("Program {other} invoke [2]"),
            line(b"PSW1", &[0x82, 7]),
            format!("Program {other} success"),
            line(b"PS2", &province(2)),
        ],
    );
    for_play_and_land(
        &[failed, nested, legacy(3)],
        |cursor, provinces, blocked| {
            assert_eq!(cursor, Cursor(3));
            assert_eq!(provinces, 2);
            assert!(!blocked);
        },
    );
}
fn for_play_and_land(page: &[TxRecord], check: impl Fn(Cursor, usize, bool)) {
    let mut land = LandIndex::default();
    let mut play = PlayIndex::default();
    land.ingest_page(page, &addrs());
    play.ingest_page(page, &addrs());
    check(
        land.cursor,
        land.provinces.len(),
        land.feed.blocked().is_some(),
    );
    check(
        play.cursor,
        play.provinces.len(),
        play.feed.blocked().is_some(),
    );
}

#[test]
fn incomplete_provenance_and_invalid_body_are_not_successful_empty_history() {
    let mut truncated = legacy(1);
    truncated.logs.pop();
    let mut empty = legacy(1);
    empty.logs.clear();
    let malformed = tx(1, vec!["Program data: !!! ???".into()]);
    let bad_body = tx(1, vec![line(b"PS2", &[1, 2])]);
    let mut unframed = legacy(1);
    unframed.logs = vec![line(b"PSW1", &[0x82, 7])];
    let mut wrong_depth = legacy(1);
    wrong_depth.logs[0] = format!("Program {} invoke [2]", addrs().program);
    let short_wide = tx(1, vec!["Program data: UFNXMQ==".into()]);
    let short_ps2 = tx(1, vec!["Program data: UFMy".into()]);
    for bad in [
        truncated,
        empty,
        malformed,
        bad_body,
        unframed,
        wrong_depth,
        short_wide,
        short_ps2,
    ] {
        for_play_and_land(&[bad, legacy(2)], |cursor, provinces, blocked| {
            assert_eq!(cursor, Cursor(0));
            assert_eq!(provinces, 0);
            assert!(blocked);
        });
    }
}

#[test]
fn raw_body_library_calls_refuse_wide_versions_without_kind_aliases() {
    for version in [0x81, 0x82] {
        let mut land = LandIndex::default();
        let mut play = PlayIndex::default();
        land.ingest(&[version, 1], 3, &addrs());
        play.ingest(&[version, 1], 3);
        assert!(land.feed.blocked().is_some());
        assert!(play.feed.blocked().is_some());
        assert!(land.counts.is_empty());
        assert!(play.departs.is_empty());
    }
}

#[test]
fn queued_retries_and_new_game_writes_are_gated_but_not_cancelled() {
    let mut e = engine();
    assert!(e.ensure(spec("resolve", "old"), 0));
    assert!(e.ensure(spec("anchor", "beacon"), 0));
    let mut index = LandIndex::default();
    index.ingest_page(&[wide(1)], &addrs());
    assert!(!index.feed.gate(&mut e, None).unwrap());
    assert_eq!(e.send_candidates(None), ["beacon"]);
    assert!(e.send_candidates(Some(&["resolve"])).is_empty());
    assert!(
        e.is_pending("old"),
        "pausing is not cancellation or finalized success"
    );
    for kind in [
        "resolve",
        "skip",
        "gather",
        "reveal",
        "close",
        "claim",
        "ticket",
        "return",
        "settle",
        "capture",
        "cmarch",
        "open-province",
        "archive",
        "future-kind",
    ] {
        assert!(!e.ensure(spec(kind, kind), 1));
    }
    e.set_feed_ready(true);
    assert!(!e.feed_writes_allowed(), "sticky latch cannot resume");
}

#[test]
fn durable_block_survives_reopen_and_rejects_corrupt_state() {
    let path = std::env::temp_dir().join(format!("wylls-wide-feed-{}.sqlite", std::process::id()));
    let first = FeedBlock {
        seq: 17,
        slot: 23,
        signature: "literal receipt".into(),
        reason: "unsupported PSW1 record".into(),
    };
    {
        let journal = Journal::open(&path).unwrap();
        first.save(&journal).unwrap();
        let mut later = first.clone();
        later.seq = 99;
        later.save(&journal).unwrap();
    }
    {
        let journal = Journal::open_existing(&path).unwrap();
        let mut restarted = engine();
        restarted.restore_feed_block(Some(&journal)).unwrap();
        assert_eq!(restarted.feed_block(), Some(&first));
        assert!(!restarted.ensure(spec("settle", "new"), 99));
        journal.set_cursor("unsupported-feed-v1", "{}").unwrap();
        assert!(engine().restore_feed_block(Some(&journal)).is_err());
    }
    std::fs::remove_file(path).unwrap();
}

#[test]
fn journal_failure_never_reopens_game_writes() {
    let journal = Journal::open(Path::new(":memory:")).unwrap();
    journal.conn.execute_batch("PRAGMA query_only=ON").unwrap();
    let mut land = LandIndex::default();
    land.ingest_page(&[wide(1)], &addrs());
    let mut e = engine();
    assert!(e.ensure(spec("settle", "existing"), 0));
    assert!(land.feed.gate(&mut e, Some(&journal)).is_err());
    assert!(!e.feed_writes_allowed());
    assert!(e.send_candidates(None).is_empty());
    assert!(e.is_pending("existing"));
}

#[test]
fn direct_library_gate_restores_durable_block_before_planning() {
    let journal = Journal::open(Path::new(":memory:")).unwrap();
    let mut old = LandIndex::default();
    old.ingest_page(&[wide(1)], &addrs());
    old.feed.gate(&mut engine(), Some(&journal)).unwrap();
    let fresh = LandIndex::default();
    let mut e = engine();
    assert!(!fresh.feed.gate(&mut e, Some(&journal)).unwrap());
    assert!(!e.ensure(spec("resolve", "fresh"), 0));
}

#[derive(Default)]
struct FeedOnly {
    pages: Mutex<VecDeque<Vec<TxRecord>>>,
    cursors: Mutex<Vec<Cursor>>,
}
impl ChainPort for FeedOnly {
    async fn feed(&self, after: Cursor) -> PortResult<Vec<TxRecord>> {
        self.cursors.lock().unwrap().push(after);
        Ok(self.pages.lock().unwrap().pop_front().unwrap_or_default())
    }
    async fn clock(&self) -> PortResult<ClockSysvar> {
        panic!("no clock reads")
    }
    async fn accounts(&self, _: &[Address], _: u64) -> PortResult<Vec<Option<Account>>> {
        panic!("no account reads")
    }
    async fn simulate(&self, _: &[u8]) -> PortResult<SimResult> {
        panic!("no execution")
    }
    async fn send(&self, _: &[u8]) -> PortResult<Signature> {
        panic!("no sending/signing")
    }
    async fn statuses(&self, _: &[Signature]) -> PortResult<Vec<Option<Status>>> {
        panic!("no signatures")
    }
    async fn blockhash(&self) -> PortResult<(solana_hash::Hash, u64)> {
        panic!("no blockhash")
    }
}

#[tokio::test]
async fn pull_returns_blocked_and_never_fetches_past_or_retries_it() {
    let port = FeedOnly {
        pages: Mutex::new([vec![legacy(1), wide(2)], vec![legacy(3)]].into()),
        ..Default::default()
    };
    let mut land = LandIndex::default();
    assert!(land.pull(&port, &addrs()).await.is_err());
    assert!(land.pull(&port, &addrs()).await.is_err());
    assert_eq!(*port.cursors.lock().unwrap(), [Cursor(0)]);
    let port = FeedOnly {
        pages: Mutex::new([vec![wide(1)]].into()),
        ..Default::default()
    };
    let mut play = PlayIndex::default();
    assert!(play.pull(&port, &addrs()).await.is_err());
    assert!(play.pull(&port, &addrs()).await.is_err());
    assert_eq!(*port.cursors.lock().unwrap(), [Cursor(0)]);
}

#[tokio::test]
async fn partial_catchup_is_not_ready_and_legacy_resumes_only_at_feed_end() {
    let port = FeedOnly {
        pages: Mutex::new((1..=9).map(|n| vec![legacy(n)]).collect()),
        ..Default::default()
    };
    let mut index = PlayIndex::default();
    let mut e = engine();
    assert_eq!(index.pull(&port, &addrs()).await.unwrap(), 8);
    assert_eq!(index.feed.status()["state"], "catching_up");
    assert!(!index.feed.gate(&mut e, None).unwrap());
    assert!(!e.ensure(spec("resolve", "early"), 0));
    assert_eq!(index.pull(&port, &addrs()).await.unwrap(), 1);
    assert!(index.feed.gate(&mut e, None).unwrap());
    assert!(e.ensure(spec("resolve", "after"), 0));
    assert_eq!(index.provinces.len(), 9);
}

struct NoDrand;
impl DrandPort for NoDrand {
    async fn round(&self, _: u64) -> PortResult<Option<Beacon>> {
        panic!("no crypto")
    }
    fn info(&self) -> ChainInfo {
        panic!("no crypto")
    }
}
#[tokio::test]
async fn direct_play_and_land_duty_calls_cannot_bypass_block() {
    let a = addrs();
    let mut bytes = vec![0; abi::size::SEASON];
    bytes[..8].copy_from_slice(abi::magic::SEASON);
    // CREATED deliberately: the guard must run even before the status fast path.
    let season = fclient::decode::Season::decode(&bytes).unwrap();
    let cfg =
        keeper_core::config::KeeperConfig::new(a.program, 7, Address::new_from_array([26; 32]));
    let tick = keeper_core::Tick {
        slot: 1,
        now: 0,
        season: &season,
        clock: fclient::clock::SeasonClock::from_season(&season),
        addrs: &a,
        cfg: &cfg,
    };
    let journal = Journal::open(Path::new(":memory:")).unwrap();
    let mut duty = PlayDuty::default();
    duty.index.ingest_page(&[wide(1)], &a);
    let mut e = engine();
    let port = FeedOnly::default();
    duty.plan_core(
        &tick,
        &port,
        &NoDrand,
        &mut keeper_core::rounds::Rounds::new([0; 96]),
        &mut e,
        &BTreeMap::new(),
        &mut keeper_core::seeds::SeedFinder::default(),
        &mut keeper_core::Shared::default(),
        Some(&journal),
        &[],
    )
    .await
    .unwrap();
    assert!(!e.feed_writes_allowed());
    assert!(FeedBlock::restore(&journal).unwrap().is_some());
    duty.housekeeping(&tick, &port, &mut e, &BTreeMap::new())
        .await
        .unwrap();
    let mut land = LandIndex::default();
    land.ingest_page(&[wide(1)], &a);
    let mut e = engine();
    keeper_core::holdings::HoldingDuty::default()
        .plan(&tick, &port, &mut e, &mut land, &Default::default())
        .await
        .unwrap();
    assert!(!e.feed_writes_allowed());
    assert!(port.cursors.lock().unwrap().is_empty());
}
