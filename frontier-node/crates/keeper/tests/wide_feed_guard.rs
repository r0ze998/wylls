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
        loaded: Default::default(),
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

#[test]
fn all_new_close_kinds_block_both_indexes_without_advancing_the_cursor() {
    for kind in [12, 13, 14] {
        // Prefix probes only, not evidence of a complete close record or valid chain.
        let close = tx(2, vec![line(b"PSW1", &[0x82, kind])]);
        for_play_and_land(
            &[legacy(1), close, legacy(3)],
            |cursor, provinces, blocked| {
                assert_eq!(cursor, Cursor(1));
                assert_eq!(provinces, 1);
                assert!(blocked);
            },
        );
    }
}

/// Devnet gap P8: a `playable-lane` keeper accounts for the PSW1 records of
/// the wide land's own actions (a wide village's Harvest / Build / Train,
/// WideGarrison, WideMuster, WideDissolve, the wide march's stages) instead
/// of latching, and still latches on every other PSW1 record. Literal
/// bodies built with the ABI's own encoder; no key, no signing, no chain.
/// `cargo test --locked -p keeper --features playable-lane --test wide_feed_guard`.
#[cfg(feature = "playable-lane")]
mod p8 {
    use super::*;
    use frontier_abi::addr::AddrCtx;
    use frontier_abi::world_index::event::{
        self as wev, encode, GarrisonReceipt, WideEntity, WideKind, WideLink,
        TRANSIT_SETTLED_DEST_AT,
    };
    use frontier_abi::world_index::expedition::AccountResolver;
    use frontier_abi::world_index::{
        EconomyAction, EconomyReceipt, ProvinceKey, WideCoord, WideHostRef, WorldId,
    };
    use keeper_core::feedguard::ACCOUNTED_KINDS;

    /// This Season's world (the one the program derives from its address).
    fn world() -> WorldId {
        let a = addrs();
        AccountResolver::for_season(&AddrCtx {
            program: a.program.to_bytes(),
            season: a.season.to_bytes(),
        })
        .unwrap()
        .adapter()
        .world()
    }
    fn other_world() -> WorldId {
        let w = world();
        let mut b = *w.as_bytes();
        b[0] ^= 1;
        WorldId::new(b).unwrap()
    }
    /// A ring-129 (wide) province key, or a ring-128 (the rim: legacy) one.
    fn key(w: WorldId, ring: i64) -> ProvinceKey {
        ProvinceKey::new(w, WideCoord::checked(ring, 0).unwrap())
    }
    fn link(entity: WideEntity) -> WideLink {
        WideLink {
            entity,
            seq: 1,
            head: [7; 32],
        }
    }
    fn economy(action: EconomyAction) -> [u8; wev::ECONOMY_PAYLOAD_LEN] {
        wev::economy_payload(&EconomyReceipt {
            action,
            now_ts: 1_790_600_000,
            became_final: false,
            input_digest: [0x1A; 32],
            output_digest: [0x0B; 32],
        })
        .unwrap()
    }
    /// A literal record of `kind`: the host (site 3, generation 1, sequence
    /// 2) or holding (sequence 0) at `home`, standing at `at`; a settlement
    /// sealed to `dest`. Economy kinds take `action`.
    fn record_at(
        kind: WideKind,
        home: ProvinceKey,
        at: ProvinceKey,
        dest: ProvinceKey,
        action: Option<EconomyAction>,
    ) -> Vec<u8> {
        let k: Vec<u8> = if kind.host_keyed() {
            let mut k = WideHostRef::new(home, 3, 1, 2).unwrap().to_bytes().to_vec();
            k.extend(at.to_bytes());
            k
        } else if kind.holding_keyed() {
            WideHostRef::new(home, 3, 1, 0).unwrap().to_bytes().to_vec()
        } else {
            at.to_bytes().to_vec()
        };
        let mut payload = vec![0u8; kind.payload_len()];
        match kind {
            WideKind::Economy => {
                payload = economy(action.unwrap_or(EconomyAction::Harvest)).to_vec()
            }
            WideKind::EconomyMirror => {
                payload = economy(action.unwrap_or(EconomyAction::Build { item: 6 })).to_vec()
            }
            WideKind::Garrison => {
                payload = wev::garrison_payload(&GarrisonReceipt {
                    delta: 7,
                    now_ts: 1_790_600_000,
                    became_final: false,
                    input_digest: [0x2A; 32],
                    output_digest: [0x0C; 32],
                })
                .unwrap()
                .to_vec()
            }
            WideKind::TransitSettled => {
                payload[TRANSIT_SETTLED_DEST_AT..].copy_from_slice(&dest.to_bytes())
            }
            WideKind::RecordClosed => payload[0] = 2,
            _ => {}
        }
        let links: Vec<WideLink> = kind.links().iter().map(|e| link(*e)).collect();
        let body = encode(kind, 40, &k, &payload, &links)
            .unwrap_or_else(|| panic!("{kind:?} home {home:?} at {at:?} encodes"));
        wev::WideRecord::decode(&body).unwrap_or_else(|e| panic!("{kind:?}: {e:?}"));
        body
    }
    fn record(kind: WideKind, action: Option<EconomyAction>) -> Vec<u8> {
        let w = key(world(), 129);
        record_at(kind, w, w, w, action)
    }
    fn psw1(seq: u64, bodies: &[Vec<u8>]) -> TxRecord {
        tx(seq, bodies.iter().map(|b| line(b"PSW1", b)).collect())
    }

    /// The wide village's own actions after its claim is final: none latches,
    /// the legacy records around them still apply, each is counted by kind.
    #[test]
    fn every_wide_village_action_is_accounted_for_and_never_latches() {
        let actions: [(WideKind, Option<EconomyAction>, &str); 7] = [
            (
                WideKind::Economy,
                Some(EconomyAction::Harvest),
                "WIDE_ECONOMY",
            ),
            (
                WideKind::Economy,
                Some(EconomyAction::Build { item: 0 }),
                "WIDE_ECONOMY",
            ),
            (
                WideKind::Economy,
                Some(EconomyAction::Train { unit: 0, n: 5 }),
                "WIDE_ECONOMY",
            ),
            (
                WideKind::EconomyMirror,
                Some(EconomyAction::Build { item: 6 }),
                "WIDE_ECONOMY_MIRROR",
            ),
            (WideKind::Garrison, None, "WIDE_GARRISON"),
            (WideKind::Muster, None, "WIDE_MUSTER"),
            (WideKind::Dissolve, None, "WIDE_DISSOLVE"),
        ];
        for (kind, action, name) in actions {
            assert_eq!(kind.name(), name);
            let page = vec![legacy(1), psw1(2, &[record(kind, action)]), legacy(3)];
            let mut land = LandIndex::default();
            let mut play = PlayIndex::default();
            assert_eq!(land.ingest_page(&page, &addrs()), 2, "{name}");
            assert_eq!(play.ingest_page(&page, &addrs()), 2, "{name}");
            // (the live pull marks catch-up at the feed's end)
            land.feed.caught_up();
            play.feed.caught_up();
            for (cursor, provinces, feed) in [
                (land.cursor, land.provinces.len(), &land.feed),
                (play.cursor, play.provinces.len(), &play.feed),
            ] {
                assert_eq!(cursor, Cursor(3), "{name}");
                assert_eq!(provinces, 2, "{name}");
                assert!(feed.blocked().is_none(), "{name}: {:?}", feed.blocked());
                assert_eq!(feed.wide_accounted().get(name), Some(&1), "{name}");
                assert_eq!(feed.status()["state"], "legacy");
                assert_eq!(feed.status()["wide_accounted"][name], 1);
            }
            // ...and the engine still allows every duty's writes (not only beacon kinds).
            let mut e = engine();
            assert!(land.feed.gate(&mut e, None).unwrap(), "{name}");
            for kind in [
                "fold",
                "settle-ticket",
                "wide-ring",
                "wide-settle",
                "wide-final",
                "open-province",
            ] {
                assert!(e.allows_write_kind(kind), "{name}: {kind}");
            }
        }
        // A mixed transaction: its PS2 body applies, its PSW1 body is counted.
        let mixed = tx(
            2,
            vec![
                line(b"PS2", &province(99)),
                line(b"PSW1", &record(WideKind::Economy, None)),
                line(b"PSW1", &record(WideKind::Muster, None)),
            ],
        );
        let mut land = LandIndex::default();
        assert_eq!(land.ingest_page(&[legacy(1), mixed], &addrs()), 2);
        assert_eq!(land.provinces, [(1, 2), (99, 2)].into());
        assert_eq!(land.feed.wide_accounted().values().sum::<u64>(), 2);
    }

    /// Every accounted kind (the wide march's stages included) in the wide
    /// world decodes and is counted; the restart re-read counts it again
    /// (the index is rebuilt from the feed) and still does not latch.
    #[test]
    fn every_accounted_kind_is_counted_and_a_reread_does_not_latch() {
        let bodies: Vec<Vec<u8>> = ACCOUNTED_KINDS.iter().map(|k| record(*k, None)).collect();
        let page = vec![legacy(1), psw1(2, &bodies), legacy(3)];
        for _ in 0..2 {
            for_play_and_land(&page, |cursor, provinces, blocked| {
                assert_eq!(cursor, Cursor(3));
                assert_eq!(provinces, 2);
                assert!(!blocked);
            });
        }
        let mut land = LandIndex::default();
        land.ingest_page(&page, &addrs());
        assert_eq!(land.feed.wide_accounted().values().sum::<u64>(), 17);
    }

    /// Fail-closed is kept: an unknown, undecodable, not-accounted or
    /// cross-world PSW1 record still latches both indexes before the
    /// transaction, and later legacy pages stay refused.
    #[test]
    fn unknown_unaccounted_legacy_and_foreign_records_still_latch() {
        let wide = key(world(), 129);
        let rim = key(world(), 128);
        let foreign = key(other_world(), 129);
        let mut economy_trailing = record(WideKind::Economy, None);
        economy_trailing.push(0);
        let mut economy_short = record(WideKind::Economy, None);
        economy_short.truncate(economy_short.len() - 3);
        let mut unknown_kind = record(WideKind::Economy, None);
        unknown_kind[1] = 99;
        let mut retired = record(WideKind::Economy, None);
        retired[0] = 0x81;
        // the provisional conquest kinds 18..=24: canonical bodies, decodable, never merely accounted for. Since P14
        // (option a) a complete conquest TARGET alone is read by the paired conquest reader (`expedition_feed_guard`
        // `p14`); one that needs its source (Declared) and a source part alone (Debited, Credited) still latch here.
        let conquest: Vec<Vec<u8>> = {
            use wev::conquest as c;
            [
                (WideKind::ConquestDeclared, c::DECLARE),
                (WideKind::ConquestDebited, c::DECLARE),
                (WideKind::ConquestResolved, c::RESOLVE),
                (WideKind::ConquestSettled, c::FAILED),
                (WideKind::ConquestCaptured, c::CAPTURE),
                (WideKind::ConquestCredited, c::LAPSE),
                (WideKind::ConquestTableClosed, c::TABLE_CLOSE),
            ]
            .into_iter()
            .map(|(kind, action)| {
                let k = if kind.holding_keyed() {
                    WideHostRef::new(wide, 3, 1, 0).unwrap().to_bytes().to_vec()
                } else {
                    wide.to_bytes().to_vec()
                };
                let receipt = c::Receipt::new(action, 0, [1; 32], [2; 32])
                    .unwrap()
                    .encode();
                let links: Vec<WideLink> = kind.links().iter().map(|e| link(*e)).collect();
                let b = encode(kind, 40, &k, &receipt, &links).unwrap();
                assert_eq!(wev::WideRecord::decode(&b).unwrap().kind, kind);
                b
            })
            .collect()
        };
        // (the codec cannot encode an economy record of a legacy holding: the key's
        //  province is swapped in after encoding)
        let mut rim_economy = record(WideKind::Economy, None);
        rim_economy[6..6 + 50].copy_from_slice(&rim.to_bytes());
        let cases: Vec<(&str, TxRecord)> = vec![
            ("unknown kind", psw1(2, &[unknown_kind])),
            ("retired version", psw1(2, &[retired])),
            ("trailing byte", psw1(2, &[economy_trailing])),
            ("short body", psw1(2, &[economy_short])),
            ("prefix probe", tx(2, vec![line(b"PSW1", &[0x82, 15])])),
            ("legacy holding (the rim)", psw1(2, &[rim_economy])),
            (
                "rim host standing in the wide land",
                psw1(2, &[record_at(WideKind::Departed, rim, wide, wide, None)]),
            ),
            (
                "settlement sealed to the rim",
                psw1(
                    2,
                    &[record_at(WideKind::TransitSettled, wide, wide, rim, None)],
                ),
            ),
            (
                "another world",
                psw1(
                    2,
                    &[record_at(
                        WideKind::Garrison,
                        foreign,
                        foreign,
                        foreign,
                        None,
                    )],
                ),
            ),
            (
                "three parts",
                tx(
                    2,
                    vec![format!(
                        "{} AAAA",
                        line(b"PSW1", &record(WideKind::Economy, None))
                    )],
                ),
            ),
            (
                "an accounted record beside an unknown one",
                psw1(2, &[record(WideKind::Economy, None), vec![0x82, 99]]),
            ),
            (
                "an accounted record beside an expedition PS2 kind",
                tx(
                    2,
                    vec![
                        line(b"PSW1", &record(WideKind::Economy, None)),
                        line(b"PS2", &[fclient::log::VERSION, 145, 0, 0, 0, 0, 0]),
                    ],
                ),
            ),
        ];
        let mut cases = cases;
        for b in &conquest {
            let kind = wev::WideRecord::decode(b).unwrap().kind;
            let t = psw1(2, std::slice::from_ref(b));
            let scope = keeper_core::feedguard::WideScope::of(&addrs()).unwrap();
            match kind {
                WideKind::ConquestDeclared
                | WideKind::ConquestDebited
                | WideKind::ConquestCredited => cases.push((kind.name(), t)),
                // (P14: read, one conquest fact, nothing accounted as a wide-land action)
                _ => {
                    let got =
                        keeper_core::feedguard::bodies_scoped(&t, &addrs().program, Some(&scope))
                            .unwrap_or_else(|e| panic!("{}: {e}", kind.name()));
                    assert_eq!(got.conquest.len(), 1, "{}", kind.name());
                }
            }
        }
        for (what, bad) in cases {
            let page = vec![legacy(1), bad, legacy(3)];
            for_play_and_land(&page, |cursor, provinces, blocked| {
                assert_eq!(cursor, Cursor(1), "{what}");
                assert_eq!(provinces, 1, "{what}");
                assert!(blocked, "{what}");
            });
            let mut land = LandIndex::default();
            land.ingest_page(&page, &addrs());
            let b = land.feed.blocked().unwrap();
            assert_eq!(b.seq, 2, "{what}");
            assert!(
                b.reason.contains("PSW1")
                    || b.reason.contains("PS2")
                    || b.reason.contains("CONQUEST"),
                "{what}: {}",
                b.reason
            );
            assert_eq!(land.ingest_page(&[legacy(4)], &addrs()), 0, "{what}");
            land.feed.caught_up();
            let mut e = engine();
            assert!(!land.feed.gate(&mut e, None).unwrap(), "{what}");
            assert!(!e.allows_write_kind("fold"), "{what}");
            assert!(e.allows_write_kind("anchor"), "{what}");
        }
    }

    /// The strict entry point (`bodies`, no scope) still refuses every PSW1
    /// record, the accounted kinds included.
    #[test]
    fn the_strict_reader_still_refuses_every_psw1_record() {
        let p = addrs().program;
        let t = psw1(2, &[record(WideKind::Economy, None)]);
        assert!(keeper_core::feedguard::bodies(&t, &p).is_err());
        let scope = keeper_core::feedguard::WideScope::of(&addrs()).expect("a lane scope");
        let got = keeper_core::feedguard::bodies_scoped(&t, &p, Some(&scope)).unwrap();
        assert!(got.ps2.is_empty());
        assert_eq!(got.wide, vec!["WIDE_ECONOMY"]);
    }
}

/// Without `playable-lane` a well-formed wide economy record still latches.
#[cfg(not(feature = "playable-lane"))]
#[test]
fn without_the_playable_lane_every_psw1_record_still_latches() {
    assert!(keeper_core::feedguard::WideScope::of(&addrs()).is_none());
    // (a literal economy record's prefix; any PSW1 line refuses here)
    let t = tx(2, vec![line(b"PSW1", &[0x82, 15, 40, 0, 0, 0])]);
    for_play_and_land(&[legacy(1), t, legacy(3)], |cursor, _, blocked| {
        assert_eq!(cursor, Cursor(1));
        assert!(blocked);
    });
}

/// P8 audit: the playable lane's other record formats in the program's own
/// frame (a Citizen-sidecar close PSWC, a reservation PSWR, an expedition
/// failure PSFF or terminal PSFT; some are a transaction's only record and
/// write a legacy Holding or Citizen) latch in every build; another
/// program's records stay ignored.
#[test]
fn other_record_formats_of_the_program_latch_in_every_build() {
    for tag in [&b"PSWC"[..], b"PSWR", b"PSFF", b"PSFT", b"PSRGA1", b"XYZ"] {
        let alone = tx(2, vec![line(tag, &[1, 2, 3])]);
        for_play_and_land(
            &[legacy(1), alone, legacy(3)],
            |cursor, provinces, blocked| {
                assert_eq!(cursor, Cursor(1));
                assert_eq!(provinces, 1);
                assert!(blocked);
            },
        );
        let mut land = LandIndex::default();
        land.ingest_page(&[tx(2, vec![line(tag, &[1, 2, 3])])], &addrs());
        let reason = &land.feed.blocked().unwrap().reason;
        assert!(reason.starts_with("unsupported "), "{reason}");
        let other = Address::new_from_array([25; 32]);
        let nested = tx(
            2,
            vec![
                format!("Program {other} invoke [2]"),
                line(tag, &[1, 2, 3]),
                format!("Program {other} success"),
            ],
        );
        for_play_and_land(&[nested], |cursor, _, blocked| {
            assert_eq!(cursor, Cursor(2));
            assert!(!blocked);
        });
    }
}
