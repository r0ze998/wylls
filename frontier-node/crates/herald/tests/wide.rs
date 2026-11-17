//! The recorded wide world (`src/wide.rs`, `/h/world/wide`): the fixture
//! archive's captured Provinces come out as world-scoped wide coordinates
//! (decimal strings) in bounded, ring-ordered pages; a Province's bytes
//! changing every bell moves no snapshot; a closed account is a known
//! closed record (not unknown); a cursor of another world, of an earlier
//! snapshot, or malformed is refused by name; without the feature the
//! routes answer `503 WideWorldUnavailable`.
//!
//! Fixed data only: the fixture's constant program and season ids, public
//! PDA derivations; no keypair, no signing, no network beyond loopback.

mod common;

use std::net::SocketAddr;
use std::sync::{Arc, RwLock};

use common::tmp;
use fclient::ports::{ChainInfo, Signature, TxRecord};
use herald_fold::clash::Provisional;
use herald_fold::files::Out;
use herald_fold::fixture;
use herald_fold::fold::{Fold, FoldCfg};
use herald_fold::server::{self, App};
use herald_fold::views::SeasonStatic;
use serde_json::{json, Value};
use solana_address::Address;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::broadcast;

fn cfg() -> FoldCfg {
    FoldCfg {
        program: fixture::program(),
        season_id: fixture::SEASON_ID,
        builder: Arc::new(Provisional),
        exact_post: true,
    }
}

/// A fixed drand description (no key material: zeros are fine for a
/// static record the tests never seal against).
fn drand() -> ChainInfo {
    ChainInfo {
        public_key: [0; 96],
        period: 3,
        genesis_time: 1_692_803_367,
        genesis_seed: [0; 32],
        chain_hash: [0; 32],
        scheme: "bls-unchained-g1-rfc9380".into(),
        beacon_id: "test".into(),
    }
}

/// A landed transaction that closes the account at `addr` (post-state
/// `None`), with a fixed signature derived from its sequence.
#[allow(dead_code)]
fn close_tx(seq: u64, slot: u64, addr: [u8; 32]) -> TxRecord {
    let mut sig = [0u8; 64];
    sig[..8].copy_from_slice(&seq.to_le_bytes());
    sig[8] = 0xC1;
    TxRecord {
        seq,
        slot,
        signature: Signature::from(sig),
        block_time: fixture::GENESIS_TS + 1,
        tx: vec![],
        logs: vec![],
        err: None,
        code: None,
        units: 0,
        fee: 0,
        post: vec![(Address::new_from_array(addr), None)],
    }
}

async fn serve(name: &str, bells: u32) -> (SocketAddr, Arc<RwLock<Fold>>, Vec<TxRecord>) {
    let dir = tmp(name);
    let txs = fixture::mini_season(bells);
    let mut f = Fold::new(cfg(), Out::new(&dir));
    for t in &txs {
        f.apply(t);
    }
    let fold = Arc::new(RwLock::new(f));
    let (diffs, _) = broadcast::channel(16);
    let app = App::new(
        fold.clone(),
        Out::new(&dir),
        SeasonStatic {
            cluster: "localnet".into(),
            drand: drand(),
            quotas: json!({}),
        },
        diffs,
    );
    let l = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let addr = l.local_addr().unwrap();
    tokio::spawn(server::serve(l, Arc::new(app)));
    (addr, fold, txs)
}

async fn get(addr: SocketAddr, path: &str) -> (u16, Value) {
    let mut s = tokio::net::TcpStream::connect(addr).await.unwrap();
    let r = format!("GET {path} HTTP/1.1\r\nHost: {addr}\r\nConnection: close\r\n\r\n");
    s.write_all(r.as_bytes()).await.unwrap();
    let mut buf = vec![];
    s.read_to_end(&mut buf).await.unwrap();
    let a = fclient::http::parse_response(&buf).unwrap();
    let v: Value = serde_json::from_slice(&a.body)
        .unwrap_or_else(|e| panic!("{e}: {}", String::from_utf8_lossy(&a.body)));
    (a.status, v)
}

#[cfg(feature = "wide-world-experimental")]
mod on {
    use super::*;
    use frontier_abi::world_index::{Lookup, ReportedState, WorldId};
    use herald_fold::wide;

    /// The fixture's four Provinces in ring order (ring, wedge, position):
    /// (2,0) wedge 0 pos 0; (1,1) wedge 0 pos 1; (0,2) wedge 1 pos 0; (3,0).
    const ORDER: [(i64, i64); 4] = [(2, 0), (1, 1), (0, 2), (3, 0)];

    fn pq(e: &Value) -> (i64, i64) {
        let p: i64 = e["p"].as_str().unwrap().parse().unwrap();
        let q: i64 = e["q"].as_str().unwrap().parse().unwrap();
        (p, q)
    }

    #[test]
    fn the_fixture_archive_is_recorded_exactly_and_bytes_changing_move_no_snapshot() {
        let dir = tmp("wide-fold");
        let txs = fixture::mini_season(6);
        let mut f = Fold::new(cfg(), Out::new(&dir));
        // fold until every fixture Province is captured
        let mut i = 0;
        while f.provinces.len() < fixture::PROVINCES.len() {
            f.apply(&txs[i]);
            i += 1;
        }
        let w = f
            .wide
            .as_ref()
            .expect("the index derives from the season's public addresses");
        assert_eq!(
            w.world(),
            WorldId::derive_legacy_season(&f.ctx.season, &fixture::program().to_bytes()).unwrap()
        );
        assert_eq!(w.len(), fixture::PROVINCES.len());
        let (epoch, stamp) = (w.epoch(), w.stamp());
        assert_eq!(
            epoch,
            fixture::PROVINCES.len() as u64,
            "one mutation per first capture"
        );
        // every later transaction (resolves, skips, arrivals) rewrites Province bytes: no mutation
        for t in &txs[i..] {
            f.apply(t);
        }
        let w = f.wide.as_ref().unwrap();
        assert_eq!((w.epoch(), w.stamp()), (epoch, stamp));
        assert_eq!(w.refused(), 0);
        // what is recorded is exactly what the fold captured, never more
        for (p, q, ring, _) in fixture::PROVINCES {
            let Lookup::Known(e) = w.lookup(p, q) else {
                panic!("{p},{q} captured")
            };
            assert_eq!(e.state, ReportedState::Open);
            assert_eq!(e.revision, 1);
            assert_eq!(e.key.coord().ring(), ring as u64);
            assert_eq!(e.observed_at, f.provinces[&(p, q)].first as u64);
        }
        assert_eq!(
            w.lookup(0, 0),
            Lookup::Unknown,
            "the Concord was never captured: unknown, not open"
        );
        assert_eq!(w.lookup(4, 0), Lookup::Unknown);
        // the manifest names the season and the counts
        let m = wide::manifest_json(&f).unwrap();
        assert_eq!(m["v"], 1);
        assert_eq!(m["experimental"], true);
        assert_eq!(m["readOnly"], true);
        assert_eq!(m["completeness"], "captured");
        assert_eq!(m["world"], json!(hex::encode(w.world().as_bytes())));
        assert_eq!(m["season"], json!(fixture::SEASON_ID.to_string()));
        assert_eq!(m["program"], json!(fixture::program().to_string()));
        assert_eq!(
            m["seasonAddress"],
            json!(Address::new_from_array(f.ctx.season).to_string())
        );
        assert_eq!(m["recorded"], 4);
        assert_eq!(m["refused"], 0);
        assert_eq!(m["legacy"]["provinces"], 4);
        assert_eq!(m["legacy"]["rMaxHard"], 128);
        assert_eq!(m["snapshot"]["epoch"], json!(epoch.to_string()));
        assert_eq!(m["snapshot"]["stamp"], json!(hex::encode(stamp)));
        assert_eq!(m["page"]["max"], 256);
        // a whole page: ring order, decimal strings, the legacy identity of each capture
        let page = wide::page_json(&f, None, Some(64)).unwrap();
        assert_eq!(page["world"], m["world"]);
        assert_eq!(page["snapshot"]["epoch"], m["snapshot"]["epoch"]);
        assert_eq!(page["after"], Value::Null);
        assert!(page["next"].is_null());
        let entries = page["entries"].as_array().unwrap();
        assert_eq!(entries.iter().map(pq).collect::<Vec<_>>(), ORDER);
        for e in entries {
            assert!(e["p"].is_string() && e["q"].is_string() && e["ring"].is_string());
            assert_eq!(e["state"], "open");
            let (p, q) = pq(e);
            let meta = f.provinces[&(p as i16, q as i16)];
            assert_eq!(e["legacy"]["p"], json!(p));
            assert_eq!(e["legacy"]["q"], json!(q));
            assert_eq!(e["legacy"]["ring"], json!(meta.ring));
            assert_eq!(e["legacy"]["region"], json!(meta.region));
            assert_eq!(e["legacy"]["openedBell"], json!(meta.first));
            assert_eq!(
                e["legacy"]["address"],
                json!(Address::new_from_array(meta.addr).to_string())
            );
            assert_eq!(
                e["legacy"]["slot"],
                json!(f.account(&meta.addr).unwrap().slot)
            );
            assert_eq!(e["ring"], json!(meta.ring.to_string()));
        }
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn pages_are_bounded_and_a_close_is_recorded_as_closed_and_kills_the_cursor() {
        let dir = tmp("wide-pages");
        let txs = fixture::mini_season(3);
        let mut f = Fold::new(cfg(), Out::new(&dir));
        for t in &txs {
            f.apply(t);
        }
        let p1 = wide::page_json(&f, None, Some(3)).unwrap();
        let e1 = p1["entries"].as_array().unwrap();
        assert_eq!(e1.iter().map(pq).collect::<Vec<_>>(), &ORDER[..3]);
        let next = p1["next"]
            .as_str()
            .expect("a cursor after a full page")
            .to_string();
        let p2 = wide::page_json(&f, Some(&next), Some(3)).unwrap();
        assert_eq!(p2["after"], json!(next));
        assert_eq!(
            p2["entries"]
                .as_array()
                .unwrap()
                .iter()
                .map(pq)
                .collect::<Vec<_>>(),
            &ORDER[3..]
        );
        assert!(p2["next"].is_null());
        // limits
        assert_eq!(
            wide::page_json(&f, None, Some(0)),
            Err(wide::WideFault::BadLimit)
        );
        assert_eq!(
            wide::page_json(&f, None, Some(257)),
            Err(wide::WideFault::BadLimit)
        );
        assert_eq!(
            wide::page_json(&f, Some("not-hex"), Some(3)),
            Err(wide::WideFault::BadCursor)
        );
        assert_eq!(
            wide::page_json(&f, Some(""), Some(3)),
            Err(wide::WideFault::BadCursor)
        );
        // a cursor whose world bytes were changed (bytes otherwise valid): another world
        let mut other = hex::decode(&next).unwrap();
        other[1..33].copy_from_slice(&[9u8; 32]);
        assert_eq!(
            wide::page_json(&f, Some(&hex::encode(&other)), Some(3)),
            Err(wide::WideFault::WorldMismatch)
        );
        // a cursor stamped with another epoch: stale
        let mut stale = hex::decode(&next).unwrap();
        stale[33..41].copy_from_slice(&99u64.to_le_bytes());
        assert_eq!(
            wide::page_json(&f, Some(&hex::encode(&stale)), Some(3)),
            Err(wide::WideFault::StaleSnapshot)
        );
        // the Province (3, 0) closes: a known closed record, the live cursor dies
        let before = f.wide.as_ref().unwrap().epoch();
        let seq = txs.last().unwrap().seq + 1;
        f.apply(&close_tx(seq, 10_000, f.ctx.province(3, 0)));
        let w = f.wide.as_ref().unwrap();
        assert_eq!(w.epoch(), before + 1);
        assert!(!f.provinces.contains_key(&(3, 0)));
        let Lookup::Known(c) = w.lookup(3, 0) else {
            panic!("closed is known")
        };
        assert_eq!(
            (c.state, c.revision, c.observed_at),
            (ReportedState::Closed, 2, 10_000)
        );
        assert_eq!(
            wide::page_json(&f, Some(&next), Some(3)),
            Err(wide::WideFault::StaleSnapshot)
        );
        let fresh = wide::page_json(&f, None, Some(64)).unwrap();
        let last = &fresh["entries"].as_array().unwrap()[3];
        assert_eq!(pq(last), (3, 0));
        assert_eq!(last["state"], "closed");
        assert_eq!(last["revision"], "2");
        assert_eq!(last["legacy"], Value::Null, "no capture to point at");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn the_routes_answer_with_explicit_codes() {
        let (a, fold, txs) = serve("wide-http", 3).await;
        let (st, m) = get(a, "/h/world/wide").await;
        assert_eq!(st, 200);
        assert_eq!(m["recorded"], 4);
        let world = m["world"].as_str().unwrap().to_string();
        assert_eq!(world.len(), 64);
        let (st, w) = get(a, "/h/world").await;
        assert_eq!(st, 200);
        assert_eq!(w["paths"]["wide"], "/h/world/wide");
        let (st, p1) = get(a, "/h/world/wide/page?limit=2").await;
        assert_eq!(st, 200);
        assert_eq!(p1["world"], json!(world));
        assert_eq!(p1["entries"].as_array().unwrap().len(), 2);
        let next = p1["next"].as_str().unwrap().to_string();
        let (st, p2) = get(a, &format!("/h/world/wide/page?limit=2&after={next}")).await;
        assert_eq!(st, 200);
        assert_eq!(p2["entries"].as_array().unwrap().len(), 2);
        assert!(p2["next"].is_null());
        assert_eq!(p2["snapshot"], p1["snapshot"]);
        let (st, e) = get(a, "/h/world/wide/page?limit=0").await;
        assert_eq!((st, e["code"].as_str()), (400, Some("BadLimit")));
        let (st, e) = get(a, "/h/world/wide/page?limit=x").await;
        assert_eq!((st, e["code"].as_str()), (400, Some("BadLimit")));
        let (st, e) = get(a, "/h/world/wide/page?after=zz").await;
        assert_eq!((st, e["code"].as_str()), (400, Some("BadCursor")));
        // the index moves (a close): the cursor is refused as stale over HTTP too
        {
            let mut f = fold.write().unwrap();
            let seq = txs.last().unwrap().seq + 1;
            let addr = f.ctx.province(1, 1);
            f.apply(&close_tx(seq, 20_000, addr));
        }
        let (st, e) = get(a, &format!("/h/world/wide/page?limit=2&after={next}")).await;
        assert_eq!((st, e["code"].as_str()), (409, Some("StaleSnapshot")));
        let (st, m2) = get(a, "/h/world/wide").await;
        assert_eq!(st, 200);
        assert_ne!(m2["snapshot"]["stamp"], m["snapshot"]["stamp"]);
        assert_eq!(m2["recorded"], 4, "closed is still recorded");
        assert_eq!(m2["legacy"]["provinces"], 3);
    }
}

#[cfg(not(feature = "wide-world-experimental"))]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn without_the_feature_the_routes_are_explicitly_unavailable() {
    let (a, _fold, _txs) = serve("wide-off", 2).await;
    for path in ["/h/world/wide", "/h/world/wide/page?limit=8"] {
        let (st, e) = get(a, path).await;
        assert_eq!(st, 503, "{path}");
        assert_eq!(e["code"], "WideWorldUnavailable", "{path}");
        assert_eq!(e["ok"], false);
    }
    // the dense world answers as before, and names the path it does not serve
    let (st, w) = get(a, "/h/world").await;
    assert_eq!(st, 200);
    assert_eq!(w["paths"]["wide"], "/h/world/wide");
}
