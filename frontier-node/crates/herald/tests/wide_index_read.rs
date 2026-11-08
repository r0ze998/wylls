//! Fixed published fixture + literal wide wire observations. Loopback only;
//! no keys/signing/program execution or live-world evidence.
mod common;
use fclient::ports::ChainInfo;
use herald_fold::{
    clash::Provisional,
    files::Out,
    fixture,
    fold::{Fold, FoldCfg},
    server::{self, App},
    views::SeasonStatic,
};
use serde_json::{json, Value};
use std::{
    net::SocketAddr,
    path::PathBuf,
    sync::{Arc, RwLock},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    sync::broadcast,
};
fn app(path: Option<PathBuf>) -> App {
    let dir = common::tmp("wide-index-read");
    let mut f = Fold::new(
        FoldCfg {
            program: fixture::program(),
            season_id: fixture::SEASON_ID,
            builder: Arc::new(Provisional),
            exact_post: false,
        },
        Out::new(dir),
    );
    for tx in fixture::mini_season(1) {
        f.apply(&tx);
    }
    let (diffs, _) = broadcast::channel(16);
    let mut app = App::new(
        Arc::new(RwLock::new(f)),
        Out::new(common::tmp("read-out")),
        SeasonStatic {
            cluster: "localnet".into(),
            drand: ChainInfo {
                public_key: [0; 96],
                period: 3,
                genesis_time: 1_692_803_367,
                genesis_seed: [0; 32],
                chain_hash: [0; 32],
                scheme: "bls-unchained-g1-rfc9380".into(),
                beacon_id: "test".into(),
            },
            quotas: json!({}),
        },
        diffs,
    );
    app.wide_index = path;
    app
}
async fn serve(app: App) -> (SocketAddr, tokio::task::JoinHandle<std::io::Result<()>>) {
    let l = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let addr = l.local_addr().unwrap();
    (addr, tokio::spawn(server::serve(l, Arc::new(app))))
}
async fn get(addr: SocketAddr, path: &str) -> (u16, Value) {
    let mut s = tokio::net::TcpStream::connect(addr).await.unwrap();
    s.write_all(
        format!("GET {path} HTTP/1.1\r\nHost: {addr}\r\nConnection: close\r\n\r\n").as_bytes(),
    )
    .await
    .unwrap();
    let mut b = vec![];
    s.read_to_end(&mut b).await.unwrap();
    let r = fclient::http::parse_response(&b).unwrap();
    (r.status, serde_json::from_slice(&r.body).unwrap())
}
#[cfg(not(feature = "wide-index-read-experimental"))]
#[tokio::test]
async fn default_routes_are_explicitly_unavailable() {
    let (addr, task) = serve(app(None)).await;
    for path in ["/h/wide-index/status", "/h/wide-index/events?through=0"] {
        let (s, v) = get(addr, path).await;
        assert_eq!(s, 503);
        assert_eq!(v["code"], "WideIndexUnavailable");
    }
    task.abort();
}
#[cfg(feature = "wide-index-read-experimental")]
mod enabled {
    use super::*;
    use base64::Engine;
    use fclient::ports::{Signature, TxRecord};
    use findex::wide_index::WideIndex;
    use frontier_abi::world_index::{event as e, ProvinceKey, WideCoord, WorldId};
    fn setup() -> (App, PathBuf, WideIndex) {
        let path = common::tmp("wide-http.sqlite");
        let a = app(Some(path.clone()));
        let f = a.fold.read().unwrap();
        let world =
            WorldId::derive_legacy_season(&f.ctx.season, &f.cfg.program.to_bytes()).unwrap();
        drop(f);
        let i = WideIndex::open(&path, fixture::program(), world).unwrap();
        (a, path, i)
    }
    fn record(seq: u64, n: usize) -> TxRecord {
        let f = app(None);
        let f = f.fold.read().unwrap();
        let world =
            WorldId::derive_legacy_season(&f.ctx.season, &f.cfg.program.to_bytes()).unwrap();
        let key = ProvinceKey::new(
            world,
            WideCoord::checked(9_007_199_254_740_993, -130).unwrap(),
        );
        let b = e::encode(
            e::WideKind::RecordClosed,
            4,
            &key.to_bytes(),
            &e::record_closed_payload(2, 4, 1, 0, &[8; 32], 5),
            &[],
        )
        .unwrap();
        let b64 = base64::engine::general_purpose::STANDARD;
        TxRecord {
            seq,
            slot: seq + 100,
            signature: Signature::from([seq as u8; 64]),
            block_time: 0,
            tx: vec![],
            logs: fclient::log::in_frame(
                &fixture::program(),
                (0..n).map(|_| format!("Program data: {} {}", b64.encode(b"PSW1"), b64.encode(&b))),
            ),
            err: None,
            code: None,
            units: 0,
            fee: 0,
            post: vec![],
        }
    }
    #[tokio::test]
    async fn serves_real_readonly_index_pages_without_creating_land_or_upgrading_captures() {
        let (a, path, mut i) = setup();
        i.add(&[record(1, 2)]).unwrap();
        i.mark_caught_up(1).unwrap();
        let snapshot = hex::encode(i.status().unwrap().snapshot);
        drop(i);
        let before = std::fs::read(&path).unwrap();
        let fold = a.fold.clone();
        let provinces = fold.read().unwrap().provinces.len();
        let (addr, task) = serve(a).await;
        let (s, v) = get(addr, "/h/wide-index/status").await;
        assert_eq!(s, 200);
        assert_eq!(v["sourceCoverage"], "unknown");
        assert_eq!(v["captureVerification"], "unverified");
        assert_eq!(v["state"], "observed");
        assert_eq!(v["automaticWrites"], false);
        let (s, p) = get(
            addr,
            &format!("/h/wide-index/events?after=0&limit=1&through=1&snapshot={snapshot}"),
        )
        .await;
        assert_eq!(s, 200);
        assert_eq!(p["events"].as_array().unwrap().len(), 1);
        assert_eq!(p["events"][0]["province"]["p"], "9007199254740993");
        assert_eq!(p["events"][0]["province"]["q"], "-130");
        assert_eq!(
            p["events"][0]["province"]["keyHex"].as_str().unwrap().len(),
            100
        );
        assert_eq!(p["more"], true);
        assert_eq!(p["next"], "1");
        let (_, p) = get(
            addr,
            &format!("/h/wide-index/events?after=1&limit=1&through=1&snapshot={snapshot}"),
        )
        .await;
        assert_eq!(p["more"], false);
        assert_eq!(p["next"], "2");
        assert_eq!(
            get(
                addr,
                &format!("/h/wide-index/events?through=0&snapshot={snapshot}")
            )
            .await
            .0,
            409
        );
        assert_eq!(
            get(
                addr,
                &format!("/h/wide-index/events?through=1&after=99&snapshot={snapshot}")
            )
            .await
            .0,
            400
        );
        assert_eq!(
            get(
                addr,
                &format!("/h/wide-index/events?through=1&limit=0&snapshot={snapshot}")
            )
            .await
            .0,
            400
        );
        assert_eq!(
            get(
                addr,
                &format!("/h/wide-index/events?through=1&limit=bad&snapshot={snapshot}")
            )
            .await
            .0,
            400
        );
        assert_eq!(
            get(
                addr,
                &format!("/h/wide-index/events?after=0&snapshot={snapshot}")
            )
            .await
            .0,
            400
        );
        assert_eq!(fold.read().unwrap().provinces.len(), provinces);
        assert_eq!(std::fs::read(&path).unwrap(), before);
        task.abort();
        std::fs::remove_file(path).unwrap();
    }
    #[tokio::test]
    async fn missing_incomplete_blocked_and_wrong_scope_are_not_successful_empty_pages() {
        let snapshot = "00".repeat(32);
        let missing = common::tmp("missing-wide.sqlite");
        let (addr, task) = serve(app(Some(missing.clone()))).await;
        assert_eq!(get(addr, "/h/wide-index/status").await.0, 503);
        assert!(!missing.exists());
        task.abort();
        let (a, path, mut i) = setup();
        let (addr, task) = serve(a).await;
        let (_, v) = get(addr, "/h/wide-index/status").await;
        assert_eq!(v["state"], "incomplete");
        let (_, v) = get(
            addr,
            &format!("/h/wide-index/events?through=0&snapshot={snapshot}"),
        )
        .await;
        assert_eq!(v["code"], "WideIndexIncomplete");
        let mut bad = record(1, 1);
        bad.logs.clear();
        assert!(i.add(&[bad]).is_err());
        let (_, v) = get(addr, "/h/wide-index/status").await;
        assert_eq!(v["state"], "blocked");
        assert_eq!(v["caughtUp"], false);
        let (s, v) = get(
            addr,
            &format!("/h/wide-index/events?through=0&snapshot={snapshot}"),
        )
        .await;
        assert_eq!(s, 503);
        assert_eq!(v["code"], "WideIndexBlocked");
        task.abort();
        drop(i);
        std::fs::remove_file(path).unwrap();
        let wrong = common::tmp("wrong-wide.sqlite");
        drop(WideIndex::open(&wrong, fixture::program(), WorldId::new([9; 32]).unwrap()).unwrap());
        let (addr, task) = serve(app(Some(wrong.clone()))).await;
        assert_eq!(get(addr, "/h/wide-index/status").await.0, 503);
        task.abort();
        std::fs::remove_file(wrong).unwrap();
    }
    #[tokio::test]
    async fn fixture_sources_remain_rejected_even_with_a_configured_index() {
        let (mut a, path, i) = setup();
        a.season.cluster = "fixture".into();
        let (addr, task) = serve(a).await;
        let (s, v) = get(addr, "/h/wide-index/status").await;
        assert_eq!(s, 503);
        assert_eq!(v["code"], "FixtureWorldUnavailable");
        task.abort();
        drop(i);
        std::fs::remove_file(path).unwrap();
    }
    #[test]
    fn checkpoint_readonly_mode_never_replaces_missing_or_damaged_state_with_empty_land() {
        let dir = common::tmp("readonly-checkpoint");
        let cfg = herald_fold::runner::IngestCfg::new(&dir, fixture::program(), fixture::SEASON_ID);
        assert!(herald_fold::wide_read::load_read_only_fold(&cfg).is_err());
        assert!(!dir.exists());
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(cfg.checkpoint_path(), b"bad").unwrap();
        assert!(herald_fold::wide_read::load_read_only_fold(&cfg).is_err());
        let a = app(None);
        let f = a.fold.read().unwrap();
        let bytes = herald_fold::checkpoint::encode(
            &fixture::program().to_bytes(),
            fixture::SEASON_ID,
            &f.st,
        );
        std::fs::write(cfg.checkpoint_path(), &bytes).unwrap();
        let loaded = herald_fold::wide_read::load_read_only_fold(&cfg).unwrap();
        let got = loaded.read().unwrap();
        assert_eq!(got.provinces.len(), f.provinces.len());
        assert!(!got.cfg.exact_post);
        assert!(got.ingest.stopped);
        assert_eq!(got.ingest.coverage.as_ref().unwrap()["state"], "unknown");
        assert_eq!(std::fs::read(cfg.checkpoint_path()).unwrap(), bytes);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
