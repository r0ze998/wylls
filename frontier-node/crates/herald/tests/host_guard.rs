//! The herald's Host allow-list and WS Origin check (devnet-readiness B13,
//! after PR #28's ③ pattern), over real loopback TCP on ports 41470–41471
//! (the fnode-devnet-rpc range).
//!
//!   H1 default (no --public-host): loopback Host names pass on every route
//!   H2 another, a missing, a malformed or a rebinding Host → 403
//!      HostNotAllowed (on /h/*, /frontier/*, /gw/* and the WS route)
//!   H3 --public-host: that exact name passes (any port, any case), a
//!      sub/superdomain does not
//!   H4 WS: an allowed Origin upgrades; another, `null`, or a bad scheme →
//!      403 OriginNotAllowed; no Origin (a non-browser client) upgrades
//!   H5 an absolute-form request target naming another host → 403
//!   H6 --public-host values are validated

mod common;

use std::sync::{Arc, RwLock};

use common::tmp;
use fclient::ports::ChainInfo;
use herald_fold::clash::Provisional;
use herald_fold::files::Out;
use herald_fold::fixture;
use herald_fold::fold::{Fold, FoldCfg};
use herald_fold::server::{self, App, HostPolicy};
use herald_fold::views::SeasonStatic;
use serde_json::json;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::broadcast;

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

async fn serve(name: &str, port: u16, hosts: HostPolicy) {
    let dir = tmp(name);
    let mut f = Fold::new(
        FoldCfg {
            program: fixture::program(),
            season_id: fixture::SEASON_ID,
            builder: Arc::new(Provisional),
            exact_post: true,
        },
        Out::new(&dir),
    );
    for t in &fixture::mini_season(2) {
        f.apply(t);
    }
    let (diffs, _) = broadcast::channel(16);
    let mut app = App::new(
        Arc::new(RwLock::new(f)),
        Out::new(&dir),
        SeasonStatic {
            cluster: "localnet".into(),
            drand: drand(),
            quotas: json!({}),
        },
        diffs,
    );
    app.hosts = hosts;
    let l = tokio::net::TcpListener::bind(("127.0.0.1", port))
        .await
        .unwrap_or_else(|e| panic!("127.0.0.1:{port} must be free: {e}"));
    tokio::spawn(server::serve(l, Arc::new(app)));
}

/// Sends raw request head lines; returns (status, body text).
async fn raw(port: u16, head: &str) -> (u16, String) {
    let mut s = tokio::net::TcpStream::connect(("127.0.0.1", port))
        .await
        .unwrap();
    s.write_all(head.as_bytes()).await.unwrap();
    let mut buf = vec![0u8; 8192];
    // The WS upgrade keeps the socket open: read the head only.
    let mut got = vec![];
    while !got.windows(4).any(|w| w == b"\r\n\r\n") {
        let n = s.read(&mut buf).await.unwrap();
        if n == 0 {
            break;
        }
        got.extend_from_slice(&buf[..n]);
    }
    // Read the body by Content-Length only: a refused WS handshake keeps
    // the connection alive (no `Connection: close`), so EOF never comes.
    if !got.starts_with(b"HTTP/1.1 101") {
        let head_end = got
            .windows(4)
            .position(|w| w == b"\r\n\r\n")
            .map_or(got.len(), |i| i + 4);
        let head = String::from_utf8_lossy(&got[..head_end]).to_ascii_lowercase();
        let len: usize = head
            .lines()
            .find_map(|l| l.strip_prefix("content-length:"))
            .and_then(|v| v.trim().parse().ok())
            .unwrap_or(0);
        while got.len() < head_end + len {
            let n = s.read(&mut buf).await.unwrap();
            if n == 0 {
                break;
            }
            got.extend_from_slice(&buf[..n]);
        }
    }
    let text = String::from_utf8_lossy(&got).to_string();
    let status = text
        .split(' ')
        .nth(1)
        .and_then(|c| c.parse().ok())
        .unwrap_or(0);
    (status, text)
}

fn get(path: &str, host: Option<&str>) -> String {
    match host {
        Some(h) => format!("GET {path} HTTP/1.1\r\nHost: {h}\r\nConnection: close\r\n\r\n"),
        None => format!("GET {path} HTTP/1.0\r\n\r\n"),
    }
}

fn ws(host: &str, origin: Option<&str>) -> String {
    let o = origin.map_or(String::new(), |o| format!("Origin: {o}\r\n"));
    format!(
        "GET /h/ws HTTP/1.1\r\nHost: {host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n{o}\r\n"
    )
}

#[tokio::test]
async fn h1_h2_h4_h5_loopback_default() {
    let p = 41470;
    serve("host-guard-default", p, HostPolicy::default()).await;
    // H1
    for h in [
        "127.0.0.1:41470",
        "localhost:41470",
        "LOCALHOST",
        "[::1]:41470",
        "127.0.0.1",
    ] {
        let (s, t) = raw(p, &get("/h/season", Some(h))).await;
        assert_eq!(s, 200, "{h}: {t}");
    }
    // H2
    for h in [
        Some("evil.example"),
        Some("evil.example:41470"),
        Some("127.0.0.1.evil.example"),
        Some("localhost.evil.example:41470"),
        Some("user@127.0.0.1"),
        Some("127.0.0.1:x"),
        Some("::1"),
        Some(""),
        None,
    ] {
        for path in ["/h/season", "/frontier/", "/gw/f/relay", "/h/ws", "/nope"] {
            let (s, t) = raw(p, &get(path, h)).await;
            assert_eq!(s, 403, "{h:?} {path}: {t}");
            assert!(t.contains("HostNotAllowed"), "{t}");
            assert!(t.contains("x-frame-options"), "security headers stay: {t}");
        }
    }
    // H4
    let (s, t) = raw(p, &ws("127.0.0.1:41470", Some("http://127.0.0.1:41470"))).await;
    assert_eq!(s, 101, "{t}");
    let (s, t) = raw(p, &ws("127.0.0.1:41470", Some("http://localhost:5173"))).await;
    assert_eq!(s, 101, "loopback origin on another port: {t}");
    let (s, t) = raw(p, &ws("127.0.0.1:41470", None)).await;
    assert_eq!(s, 101, "a non-browser client: {t}");
    for o in [
        "https://evil.example",
        "http://127.0.0.1.evil.example",
        "null",
        "file://",
        "chrome-extension://abc",
        "http://127.0.0.1:41470/path",
        "http://user@127.0.0.1",
    ] {
        let (s, t) = raw(p, &ws("127.0.0.1:41470", Some(o))).await;
        assert_eq!(s, 403, "{o}: {t}");
        assert!(t.contains("OriginNotAllowed"), "{t}");
    }
    // H5
    let (s, t) = raw(
        p,
        "GET http://evil.example/h/season HTTP/1.1\r\nHost: 127.0.0.1:41470\r\nConnection: close\r\n\r\n",
    )
    .await;
    assert_eq!(s, 403, "{t}");
}

#[tokio::test]
async fn h3_h4_public_host() {
    let p = 41471;
    let hosts = HostPolicy::with_public(&["play.example.org"]).unwrap();
    serve("host-guard-public", p, hosts).await;
    for h in [
        "play.example.org",
        "play.example.org:443",
        "PLAY.Example.org",
        "127.0.0.1:41471",
    ] {
        let (s, t) = raw(p, &get("/h/season", Some(h))).await;
        assert_eq!(s, 200, "{h}: {t}");
    }
    for h in [
        "example.org",
        "x.play.example.org",
        "play.example.org.evil",
        "play-example.org",
    ] {
        let (s, _) = raw(p, &get("/h/season", Some(h))).await;
        assert_eq!(s, 403, "{h}");
    }
    let (s, t) = raw(p, &ws("play.example.org", Some("https://play.example.org"))).await;
    assert_eq!(s, 101, "{t}");
    let (s, _) = raw(p, &ws("play.example.org", Some("https://evil.example.org"))).await;
    assert_eq!(s, 403);
}

#[test]
fn h6_public_host_values_are_checked() {
    for ok in ["play.example.org", "192.168.1.5", "a-b.example"] {
        assert!(HostPolicy::with_public(&[ok]).is_ok(), "{ok}");
    }
    for bad in [
        "",
        "*.example.org",
        "play.example.org:443",
        "a..b",
        ".a",
        "a.",
        "-a",
        "a b",
        "a/b",
        "[::1]",
    ] {
        assert!(HostPolicy::with_public(&[bad]).is_err(), "{bad}");
    }
    let p = HostPolicy::with_public(&["Play.Example.org", "play.example.org"]).unwrap();
    assert_eq!(
        p.names().len(),
        4,
        "loopback 3 + one, deduplicated, lowercased"
    );
}
