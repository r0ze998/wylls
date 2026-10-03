//! The herald as the playtest exposes it (PT-B): the page injection (the design session's index.html is
//! served unchanged on disk, with one script tag placed in front of `app.mjs`), the landing redirect,
//! the per-address limits (token bucket over every route, loopback exempt, the address read from
//! `CF-Connecting-IP`, else from the LAST `X-Forwarded-For` entry), and the per-address socket cap.

mod common;

use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;
use std::time::Duration;

use common::tmp;
use herald_fold::fixture;
use herald_fold::runner::{Ingest, IngestCfg};
use herald_fold::server::{self, client_ip, inject_script, ip_bucket, App, IpLimits};
use herald_fold::views::SeasonStatic;
use herald_fold::ws::WsCfg;
use serde_json::json;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::broadcast;

const PAGE: &str = "<html><body><main></main>\n<script type=\"module\" src=\"app.mjs\"></script>\n</body></html>";

async fn serve(name: &str, tweak: impl FnOnce(&mut App)) -> (SocketAddr, std::path::PathBuf) {
    let dir = tmp(name);
    let (diffs, _) = broadcast::channel(16);
    let cfg = IngestCfg::new(&dir, fixture::program(), fixture::SEASON_ID);
    let ing = Ingest::open(cfg.clone(), diffs.clone()).unwrap();
    let web = dir.join("web");
    std::fs::create_dir_all(web.join("frontier/playtest")).unwrap();
    std::fs::write(web.join("frontier/index.html"), PAGE).unwrap();
    std::fs::write(web.join("frontier/index.html.gz"), b"not gzip: must not be served").unwrap();
    std::fs::write(web.join("frontier/other.html"), PAGE).unwrap();
    std::fs::write(web.join("frontier/playtest/boot.mjs"), "export {};").unwrap();
    std::fs::create_dir_all(web.join("frontier/art/terrain/@1x")).unwrap();
    std::fs::write(web.join("frontier/art/terrain/@1x/hills_1.webp"), b"RIFFxxxx").unwrap();
    std::fs::write(web.join("index.html"), "<!doctype html>v9").unwrap();
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
    app.web = Some(web);
    app.ws = WsCfg {
        heartbeat: Duration::from_secs(5),
        max_lags: 1,
        max_sockets: 64,
    };
    tweak(&mut app);
    let l = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let addr = l.local_addr().unwrap();
    tokio::spawn(server::serve(l, Arc::new(app)));
    (addr, dir)
}

async fn req(addr: SocketAddr, method: &str, path: &str, headers: &[(&str, &str)]) -> (u16, Vec<(String, String)>, Vec<u8>) {
    let mut s = tokio::net::TcpStream::connect(addr).await.unwrap();
    let mut r = format!("{method} {path} HTTP/1.1\r\nHost: {addr}\r\nConnection: close\r\nContent-Length: 0\r\n");
    for (k, v) in headers {
        r.push_str(&format!("{k}: {v}\r\n"));
    }
    r.push_str("\r\n");
    s.write_all(r.as_bytes()).await.unwrap();
    let mut buf = vec![];
    s.read_to_end(&mut buf).await.unwrap();
    let a = fclient::http::parse_response(&buf).unwrap();
    (a.status, a.headers, a.body)
}

fn h<'a>(hs: &'a [(String, String)], k: &str) -> Option<&'a str> {
    hs.iter().find(|(x, _)| x.eq_ignore_ascii_case(k)).map(|(_, v)| v.as_str())
}

#[test]
fn the_script_goes_in_front_of_app_mjs_exactly_once_and_only_for_a_plain_url() {
    let (out, did) = inject_script(PAGE.as_bytes().to_vec(), "/frontier/frontier/playtest/boot.mjs");
    let t = String::from_utf8(out).unwrap();
    assert!(did);
    assert_eq!(t.matches("playtest/boot.mjs").count(), 1);
    assert!(t.find("playtest/boot.mjs").unwrap() < t.find("src=\"app.mjs\"").unwrap());
    assert!(t.contains(PAGE.split("<script").next().unwrap()), "everything else is as it was");
    // no app.mjs tag: unchanged; a URL with a quote or a space: refused (no injection of markup)
    let (same, did) = inject_script(b"<html></html>".to_vec(), "/x.mjs");
    assert!(!did && same == b"<html></html>");
    let (same, did) = inject_script(PAGE.as_bytes().to_vec(), "/x.mjs\"><script>alert(1)</script>");
    assert!(!did && same == PAGE.as_bytes());
}

#[test]
fn the_client_address_is_cf_connecting_ip_else_the_last_forwarded_entry_and_only_behind_a_loopback_peer() {
    let loop_ip: IpAddr = "127.0.0.1".parse().unwrap();
    let remote: IpAddr = "198.51.100.1".parse().unwrap();
    let mut hs = axum::http::HeaderMap::new();
    assert_eq!(client_ip(loop_ip, &hs), loop_ip);
    hs.insert("x-forwarded-for", "10.9.9.9, 203.0.113.5".parse().unwrap());
    assert_eq!(client_ip(loop_ip, &hs).to_string(), "203.0.113.5", "the entry the proxy appended, not the browser's claim");
    hs.insert("cf-connecting-ip", "203.0.113.77".parse().unwrap());
    assert_eq!(client_ip(loop_ip, &hs).to_string(), "203.0.113.77");
    assert_eq!(client_ip(remote, &hs), remote, "a peer that is not this machine is never believed");
    let mut junk = axum::http::HeaderMap::new();
    junk.insert("x-forwarded-for", "not an address".parse().unwrap());
    assert_eq!(client_ip(loop_ip, &junk), loop_ip);
    // IPv6 clients share a bucket per /64; mapped IPv4 is the IPv4 address
    let a: IpAddr = "2001:db8:1:2:aaaa::1".parse().unwrap();
    let b: IpAddr = "2001:db8:1:2:bbbb::9".parse().unwrap();
    let c: IpAddr = "2001:db8:1:3::1".parse().unwrap();
    assert_eq!(ip_bucket(a), ip_bucket(b));
    assert_ne!(ip_bucket(a), ip_bucket(c));
    assert_eq!(ip_bucket("::ffff:203.0.113.5".parse().unwrap()), ip_bucket("203.0.113.5".parse().unwrap()));
}

#[test]
fn the_bucket_empties_refills_and_exempts_loopback() {
    let l = IpLimits::new(100.0, 5.0, 6);
    let ip: IpAddr = "203.0.113.5".parse().unwrap();
    assert_eq!((0..8).filter(|_| l.take(ip)).count(), 5);
    assert!(!l.take(ip));
    assert!(l.take("203.0.113.6".parse().unwrap()), "another address");
    assert!(l.take("127.0.0.1".parse().unwrap()), "loopback is exempt");
    std::thread::sleep(Duration::from_millis(60));
    assert!(l.take(ip), "refilled");
    let off = IpLimits::new(0.0, 5.0, 6);
    assert!((0..1000).all(|_| off.take(ip)));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn page_injection_landing_and_limits_over_http() {
    let (addr, _dir) = serve("pt-b-http", |app| {
        app.inject = Some(("frontier/index.html".into(), "/frontier/frontier/playtest/boot.mjs".into()));
        app.landing = Some("/frontier/frontier/playtest/".into());
        app.limits = Arc::new(IpLimits::new(20.0, 30.0, 2));
    })
    .await;
    // the page: injected, not the gz sibling, not cached as the file on disk; another html page is untouched
    let (st, hs, body) = req(addr, "GET", "/frontier/frontier/index.html", &[("Accept-Encoding", "gzip")]).await;
    assert_eq!(st, 200);
    assert!(h(&hs, "content-encoding").is_none());
    assert_eq!(String::from_utf8(body).unwrap().matches("playtest/boot.mjs").count(), 1);
    let (_, _, other) = req(addr, "GET", "/frontier/frontier/other.html", &[]).await;
    assert_eq!(other, PAGE.as_bytes());
    // the tile art sits in `@1x` directories
    let (st, hs, body) = req(addr, "GET", "/frontier/frontier/art/terrain/@1x/hills_1.webp", &[]).await;
    assert_eq!((st, body.as_slice(), h(&hs, "content-type")), (200, &b"RIFFxxxx"[..], Some("image/webp")));
    for bad in ["/frontier/frontier/art/%40/../../../etc", "/frontier/frontier/art/@/..", "/frontier/frontier/art/.@1x"] {
        assert_eq!(req(addr, "GET", bad, &[]).await.0, 404, "{bad}");
    }
    // the front door
    for p in ["/", "/frontier", "/frontier/"] {
        let (st, hs, _) = req(addr, "GET", p, &[]).await;
        assert_eq!((st, h(&hs, "location")), (302, Some("/frontier/frontier/playtest/")), "{p}");
    }
    // a stranger flooding: a bucket of 30, the rest 429 with Retry-After and the security headers; another address is fine
    let evil = [("X-Forwarded-For", "10.1.1.1, 198.51.100.9")];
    let mut codes = vec![];
    for _ in 0..60 {
        codes.push(req(addr, "GET", "/h/season", &evil).await.0);
    }
    let refused = codes.iter().filter(|c| **c == 429).count();
    assert!(refused >= 25, "{codes:?}");
    let (st, hs, body) = req(addr, "GET", "/h/season", &evil).await;
    assert_eq!(st, 429);
    assert_eq!(h(&hs, "retry-after"), Some("2"));
    assert_eq!(h(&hs, "x-frame-options"), Some("DENY"));
    assert!(String::from_utf8_lossy(&body).contains("TooManyRequests"));
    assert_ne!(req(addr, "GET", "/h/season", &[("X-Forwarded-For", "198.51.100.10")]).await.0, 429);
    // the browser's claim does not buy a new bucket; CF-Connecting-IP does decide
    assert_eq!(req(addr, "GET", "/h/season", &[("X-Forwarded-For", "192.0.2.77, 198.51.100.9")]).await.0, 429);
    assert_ne!(req(addr, "GET", "/h/season", &[("CF-Connecting-IP", "198.51.100.11"), ("X-Forwarded-For", "198.51.100.9")]).await.0, 429);
    // this machine's own clients (bots, viewers, the operator) are not limited
    for _ in 0..80 {
        assert_ne!(req(addr, "GET", "/h/season", &[]).await.0, 429);
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sockets_per_address_are_capped_and_freed() {
    let (addr, _dir) = serve("pt-b-ws", |app| {
        app.limits = Arc::new(IpLimits::new(50.0, 300.0, 2));
    })
    .await;
    async fn upgrade(addr: SocketAddr, ip: &str) -> (u16, tokio::net::TcpStream) {
        let mut s = tokio::net::TcpStream::connect(addr).await.unwrap();
        let r = format!("GET /h/ws HTTP/1.1\r\nHost: {addr}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nX-Forwarded-For: {ip}\r\n\r\n");
        s.write_all(r.as_bytes()).await.unwrap();
        let mut b = [0u8; 64];
        let n = s.read(&mut b).await.unwrap();
        let st: u16 = String::from_utf8_lossy(&b[..n]).split(' ').nth(1).unwrap().parse().unwrap();
        (st, s)
    }
    let (a, s1) = upgrade(addr, "198.51.100.1").await;
    let (b, s2) = upgrade(addr, "198.51.100.1").await;
    let (c, _s3) = upgrade(addr, "198.51.100.1").await;
    let (d, _s4) = upgrade(addr, "198.51.100.2").await;
    assert_eq!((a, b, c, d), (101, 101, 429, 101));
    drop((s1, s2));
    tokio::time::sleep(Duration::from_millis(400)).await;
    let (e, _s5) = upgrade(addr, "198.51.100.1").await;
    assert_eq!(e, 101, "a closed socket frees the slot");
}
