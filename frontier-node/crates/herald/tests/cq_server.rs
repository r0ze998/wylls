//! `cq_*`: the MC read paths and WS messages (contract §8.4; CQ2-E) over
//! the synthetic conquest mini-season, on `127.0.0.1:0`: every new path
//! answers with its cache rule and decodes with `cqfmt`; `/h/me` carries
//! alerts; `/h/events` decodes MC records; a WS socket subscribed to
//! `control`, `sieges` and `standings` (and its wallet) receives the
//! control deltas, siege deltas, standings and alerts in sequence.

mod common;

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use common::{tmp, VecSource};
use herald_fold::cqfixture::{self, SEASON_ID};
use herald_fold::cqfmt::{
    decode_control_delta, CallFile, ConquestDay, ControlFile, FinalFile, KeepHistory,
    Overview2File, PlayersFile, SiegeHistory, SiegesFile, StandingsLatest, StandingsSeries,
};
use herald_fold::runner::{Ingest, IngestCfg};
use herald_fold::server::{self, App};
use herald_fold::views::SeasonStatic;
use herald_fold::ws::{self, WsCfg};
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::broadcast;

struct Answer {
    status: u16,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

impl Answer {
    fn h(&self, k: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(x, _)| x.eq_ignore_ascii_case(k))
            .map(|(_, v)| v.as_str())
    }
}

async fn get(addr: SocketAddr, path: &str) -> Answer {
    let mut s = tokio::net::TcpStream::connect(addr).await.unwrap();
    let r = format!("GET {path} HTTP/1.1\r\nHost: {addr}\r\nConnection: close\r\n\r\n");
    s.write_all(r.as_bytes()).await.unwrap();
    let mut buf = vec![];
    s.read_to_end(&mut buf).await.unwrap();
    let a = fclient::http::parse_response(&buf).unwrap();
    Answer {
        status: a.status,
        headers: a.headers,
        body: a.body,
    }
}

async fn ok(addr: SocketAddr, path: &str, cache: &str) -> Vec<u8> {
    let a = get(addr, path).await;
    assert_eq!(
        a.status,
        200,
        "{path}: {}",
        String::from_utf8_lossy(&a.body)
    );
    assert_eq!(a.h("cache-control"), Some(cache), "{path}");
    assert_eq!(a.h("access-control-allow-origin"), Some("*"), "{path}");
    assert_eq!(a.h("x-content-type-options"), Some("nosniff"), "{path}");
    a.body
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cq_routes_and_ws_messages() {
    let dir = tmp("cqsrv");
    let txs = cqfixture::mini_season();
    let (diffs, _) = broadcast::channel(1 << 16);
    let cfg = IngestCfg::new(&dir, cqfixture::program(), SEASON_ID);
    let mut ing = Ingest::open(cfg.clone(), diffs.clone()).unwrap();
    // fold the genesis and the first bells, then open the socket
    let n = 40;
    let mut src = VecSource::new(txs[..n].to_vec(), 10_000);
    while ing.step(&mut src).await.unwrap() > 0 {}
    let mut app = App::new(
        ing.fold.clone(),
        herald_fold::files::Out::new(cfg.files_dir()),
        SeasonStatic {
            cluster: "localnet".into(),
            drand: fclient::beacon::TestKey::new().info(),
            quotas: json!({"perDay": 40, "burst": 60}),
        },
        diffs,
    );
    app.index = Some(cfg.index_path());
    app.ws = WsCfg {
        heartbeat: Duration::from_secs(5),
        max_lags: 1_000,
        max_sockets: 8,
    };
    let l = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let addr = l.local_addr().unwrap();
    tokio::spawn(server::serve(l, Arc::new(app)));
    let host = addr.to_string();
    let mut c = ws::Client::connect(&host, "/h/ws").await.unwrap();
    let w1 = cqfixture::wallet(1);
    c.send_text(
        &json!({"op": "sub", "control": true, "sieges": true, "standings": true, "wallet": w1.to_string()})
            .to_string(),
    )
    .await
    .unwrap();
    let ack: Value = serde_json::from_str(&c.next_text().await.unwrap()).unwrap();
    assert_eq!(ack["op"], "subscribed");
    assert_eq!(ack["control"], true);
    // the rest of the season, drained by a reader so nothing lags
    let done = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let done2 = done.clone();
    let reader = tokio::spawn(async move {
        let mut out = vec![];
        loop {
            match tokio::time::timeout(Duration::from_secs(2), c.next_text()).await {
                Ok(Some(t)) => out.push(serde_json::from_str::<Value>(&t).unwrap()),
                Ok(None) => break,
                Err(_) if done2.load(std::sync::atomic::Ordering::SeqCst) => break,
                Err(_) => {}
            }
        }
        out
    });
    let mut src = VecSource::new(txs[n..].to_vec(), 50);
    while ing.step(&mut src).await.unwrap() > 0 {}
    done.store(true, std::sync::atomic::Ordering::SeqCst);
    let msgs = reader.await.unwrap();
    let seqs: Vec<u64> = msgs.iter().map(|m| m["seq"].as_u64().unwrap()).collect();
    assert_eq!(seqs, (1..=seqs.len() as u64).collect::<Vec<_>>(), "no gap");
    let of = |k: &str| msgs.iter().filter(|m| m["kind"] == k).collect::<Vec<_>>();
    let control = of("control");
    assert!(control.len() > 100, "{} control messages", control.len());
    let mut deltas = 0;
    for m in &control {
        assert!(m["key"].as_str().unwrap().starts_with("/h/control/"));
        let b = m["bytes_b64"].as_str().unwrap();
        if !b.is_empty() {
            use base64::Engine;
            let raw = base64::engine::general_purpose::STANDARD.decode(b).unwrap();
            decode_control_delta(&raw).expect("a valid delta");
            deltas += 1;
        }
    }
    assert!(deltas > 0, "control deltas");
    assert!(!of("siege").is_empty(), "siege deltas");
    assert!(!of("standings").is_empty(), "standings");
    let alerts = of("alert");
    assert!(
        alerts.len() >= 2,
        "the occupied wallet's alerts: {}",
        alerts.len()
    );
    assert!(
        of("acct").is_empty() && of("bell").is_empty(),
        "nothing else subscribed"
    );

    // ---- the read paths
    let ct = ok(addr, "/h/control/latest.bin", "public, max-age=2").await;
    let ct = ControlFile::decode(&ct).unwrap();
    assert_eq!(ct.bell, cqfixture::END_BELL - 1);
    ControlFile::decode(
        &ok(
            addr,
            "/h/control/7.bin",
            "public, max-age=31536000, immutable",
        )
        .await,
    )
    .unwrap();
    assert_eq!(get(addr, "/h/control/99999.bin").await.status, 404);
    assert_eq!(get(addr, "/h/control/x.bin").await.status, 404);
    let ring = (ct.rings().unwrap()) as u16;
    Overview2File::decode(
        &ok(
            addr,
            &format!("/h/overview2/{ring}/latest.bin"),
            "public, max-age=5",
        )
        .await,
    )
    .unwrap();
    Overview2File::decode(
        &ok(
            addr,
            &format!("/h/overview2/{ring}/9.bin"),
            "public, max-age=31536000, immutable",
        )
        .await,
    )
    .unwrap();
    SiegesFile::parse(&ok(addr, "/h/sieges/latest.json", "public, max-age=2").await).unwrap();
    SiegesFile::parse(
        &ok(
            addr,
            "/h/sieges/100.json",
            "public, max-age=31536000, immutable",
        )
        .await,
    )
    .unwrap();
    let day = ConquestDay::parse(
        &ok(
            addr,
            "/h/conquest/0.json",
            "public, max-age=31536000, immutable",
        )
        .await,
    )
    .unwrap();
    let declared = day
        .events
        .iter()
        .find(|e| e.kind == herald_fold::cqfmt::EventKind::SiegeDeclared)
        .unwrap();
    let path = format!(
        "/h/siege/{},{},{}/{}.json",
        declared.p.unwrap(),
        declared.q.unwrap(),
        declared.site.unwrap(),
        declared.bell
    );
    SiegeHistory::parse(&ok(addr, &path, "public, max-age=31536000, immutable").await).unwrap();
    let kt = day
        .events
        .iter()
        .find(|e| e.kind == herald_fold::cqfmt::EventKind::KeepTaken)
        .unwrap();
    let kp = format!("/h/keep/{},{}.json", kt.p.unwrap(), kt.q.unwrap());
    let k = KeepHistory::parse(&ok(addr, &kp, "public, max-age=5").await).unwrap();
    assert!(!k.captures.is_empty());
    assert_eq!(get(addr, "/h/keep/99,99.json").await.status, 404);
    StandingsSeries::decode(&ok(addr, "/h/standings/series.bin", "public, max-age=30").await)
        .unwrap();
    StandingsLatest::parse(&ok(addr, "/h/standings/latest.json", "public, max-age=5").await)
        .unwrap();
    PlayersFile::parse(&ok(addr, "/h/standings/players.json", "public, max-age=30").await).unwrap();
    CallFile::parse(
        &ok(
            addr,
            "/h/call/1.json",
            "public, max-age=31536000, immutable",
        )
        .await,
    )
    .unwrap();
    FinalFile::parse(
        &ok(
            addr,
            "/h/season/final.json",
            "public, max-age=31536000, immutable",
        )
        .await,
    )
    .unwrap();
    let st: Value =
        serde_json::from_slice(&ok(addr, "/h/status/conquest", "no-store").await).unwrap();
    assert_eq!(st["conquest"], true);
    assert_eq!(st["alarms"]["conquestMismatch"], 0);
    // the conquest day of a day past the season: live (empty)
    let live = ok(addr, "/h/conquest/40.json", "public, max-age=5").await;
    assert!(ConquestDay::parse(&live).unwrap().events.is_empty());
    // /h/me with alerts
    let me: Value =
        serde_json::from_slice(&ok(addr, &format!("/h/me/{w1}"), "no-store").await).unwrap();
    assert!(!me["alerts"].as_array().unwrap().is_empty());
    // /h/events decodes MC records
    let mut after = 0u64;
    let mut names = std::collections::BTreeSet::new();
    loop {
        let ev: Value =
            serde_json::from_slice(&get(addr, &format!("/h/events?after={after}")).await.body)
                .unwrap();
        for e in ev["events"].as_array().unwrap() {
            if let Some(n) = e["decoded"]["name"].as_str() {
                names.insert(n.to_string());
            }
        }
        if !ev["full"].as_bool().unwrap() {
            break;
        }
        after = ev["next"].as_str().unwrap().parse().unwrap();
    }
    for n in [
        "CONQUEST",
        "SIEGE_DECLARED",
        "MARCH_FOLD",
        "CAPTURE_SETTLED",
        "KEEP",
        "NEUTRAL",
    ] {
        assert!(names.contains(n), "{n} in /h/events: {names:?}");
    }
    let _ = std::fs::remove_dir_all(&dir);
}
