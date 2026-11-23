//! fix-herald-gw-502 (verify-pr181 O-1): the herald's `/gw/*` relay proxy
//! when the relay answers EARLY and resets the connection.
//!
//! The live relay is Node's http server. It answers some requests before
//! reading their body (the per-address limiter's 429, a 404, the funds
//! check's 503) and then closes the socket without lingering, so a body
//! byte still unread at the close (or arriving after it) makes the kernel
//! send RST. The herald used to write head and body in two writes and give
//! up on any read error: the player got 502 `RelayUnavailable` although the
//! relay's whole 429 was already in the herald's receive buffer.
//!
//! The fake relays here are blocking threads. Each one reads the request on
//! purpose the way the case needs (head only; one `read` like Node; the
//! whole request), and none uses a sleep as synchronisation: the "body is
//! waiting unread" state is reached with `peek`, so the reset is certain.

mod common;

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use common::tmp;
use fclient::ports::ChainInfo;
use herald_fold::fixture;
use herald_fold::runner::{Ingest, IngestCfg};
use herald_fold::server::{self, App};
use herald_fold::views::SeasonStatic;
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::broadcast;

const NUDGE: &str = r#"{"province":[3,-2],"bell":41}"#;
const LIMITED: &str = r#"{"error":"too many requests","code":"RateLimited"}"#;

/// A herald on 127.0.0.1:0 whose relay is `relay`.
async fn herald(name: &str, relay: String) -> SocketAddr {
    let dir = tmp(name);
    let (diffs, _) = broadcast::channel(16);
    let cfg = IngestCfg::new(&dir, fixture::program(), fixture::SEASON_ID);
    let ing = Ingest::open(cfg.clone(), diffs.clone()).unwrap();
    let mut app = App::new(
        ing.fold.clone(),
        herald_fold::files::Out::new(cfg.files_dir()),
        SeasonStatic {
            cluster: "localnet".into(),
            // A literal (no key generated): this suite runs in CI's key-free step.
            drand: ChainInfo {
                public_key: [0; 96],
                period: 3,
                genesis_time: 0,
                genesis_seed: [0; 32],
                chain_hash: [0; 32],
                scheme: "unused".into(),
                beacon_id: "unused".into(),
            },
            quotas: json!({}),
        },
        diffs,
    );
    app.relay = Some(relay);
    let l = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let addr = l.local_addr().unwrap();
    tokio::spawn(server::serve(l, Arc::new(app)));
    addr
}

/// The browser's side: one request to the herald, the whole answer back.
async fn post(addr: SocketAddr, path: &str, body: &str) -> (u16, Value) {
    let mut s = tokio::net::TcpStream::connect(addr).await.unwrap();
    let r = format!(
        "POST {path} HTTP/1.1\r\nHost: {addr}\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
        body.len()
    );
    s.write_all(r.as_bytes()).await.unwrap();
    let mut buf = vec![];
    s.read_to_end(&mut buf).await.unwrap();
    let a = fclient::http::parse_response(&buf).unwrap();
    let v = serde_json::from_slice(&a.body)
        .unwrap_or_else(|e| panic!("{e}: {}", String::from_utf8_lossy(&a.body)));
    (a.status, v)
}

fn content_length(head: &[u8]) -> usize {
    String::from_utf8_lossy(head)
        .to_ascii_lowercase()
        .lines()
        .find_map(|l| {
            l.strip_prefix("content-length:")
                .map(|v| v.trim().to_string())
        })
        .and_then(|v| v.parse().ok())
        .unwrap_or(0)
}

/// Read up to and including the blank line, one byte at a time, so no body
/// byte is consumed.
fn read_head(c: &mut TcpStream) -> Vec<u8> {
    let mut head = vec![];
    let mut b = [0u8; 1];
    while !head.ends_with(b"\r\n\r\n") {
        match c.read(&mut b) {
            Ok(1) => head.push(b[0]),
            _ => break,
        }
    }
    head
}

fn json_answer(status: &str, body: &str) -> Vec<u8> {
    format!(
        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
    .into_bytes()
}

/// A fake relay thread: `on(conn)` for every connection; the number of
/// connections it accepted is counted.
fn relay(on: impl Fn(TcpStream) + Send + Sync + 'static) -> (String, Arc<AtomicUsize>) {
    let l = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = l.local_addr().unwrap().to_string();
    let n = Arc::new(AtomicUsize::new(0));
    let n2 = n.clone();
    std::thread::spawn(move || {
        for c in l.incoming() {
            let Ok(c) = c else { return };
            // A safety net only (never synchronisation): a stuck herald must
            // not pin the thread forever.
            let _ = c.set_read_timeout(Some(std::time::Duration::from_secs(30)));
            n2.fetch_add(1, Ordering::SeqCst);
            on(c);
        }
    });
    (addr, n)
}

/// The Node relay's early answer, made certain: the head is read, the body
/// is waiting UNREAD in this socket (`peek`), the whole 429 is written, and
/// the socket is closed with that body unread, which is a RST. The herald
/// writes the request in one write, so even a herald that waited for the
/// close could not get a FIN here.
fn early_answer_then_reset(answer: Vec<u8>) -> impl Fn(TcpStream) + Send + Sync {
    move |mut c| {
        let head = read_head(&mut c);
        let want = content_length(&head);
        let mut peek = vec![0u8; want.max(1)];
        while want > 0 && c.peek(&mut peek).unwrap_or(0) < want {
            std::thread::yield_now();
        }
        let _ = c.write_all(&answer);
        drop(c);
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_early_429_then_a_reset_reaches_the_player_as_429_not_502() {
    let (addr, conns) = relay(early_answer_then_reset(json_answer(
        "429 Too Many Requests",
        LIMITED,
    )));
    let h = herald("gw-early-429", addr).await;
    for i in 0..20 {
        let (status, v) = post(h, "/gw/f/nudge", NUDGE).await;
        assert_eq!(
            (status, v["code"].as_str()),
            (429, Some("RateLimited")),
            "round {i}: the relay's own answer, not the herald's RelayUnavailable: {v}"
        );
    }
    assert_eq!(
        conns.load(Ordering::SeqCst),
        20,
        "one connection per request: nothing re-sent"
    );
}

/// Node's own way: ONE `read` (whatever has arrived), answer, close. A
/// request split over two writes can leave the body out of that read; the
/// herald writes head and body together, so the relay always holds the
/// whole request after its first read and closes with a FIN.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn head_and_body_go_out_in_one_write() {
    let split = Arc::new(AtomicUsize::new(0));
    let s2 = split.clone();
    let (addr, _) = relay(move |mut c| {
        let mut buf = vec![0u8; 65_536];
        let n = c.read(&mut buf).unwrap_or(0);
        let end = buf[..n].windows(4).position(|w| w == b"\r\n\r\n");
        let whole = end.is_some_and(|e| n >= e + 4 + content_length(&buf[..e]));
        if !whole {
            s2.fetch_add(1, Ordering::SeqCst);
        }
        let _ = c.write_all(&json_answer("429 Too Many Requests", LIMITED));
    });
    let h = herald("gw-one-write", addr).await;
    for i in 0..100 {
        let (status, v) = post(h, "/gw/f/nudge", NUDGE).await;
        assert_eq!(status, 429, "round {i}: {v}");
    }
    assert_eq!(
        split.load(Ordering::SeqCst),
        0,
        "a relay's first read held only part of the request"
    );
}

/// A reset before the answer is whole is still an error: no truncated body
/// goes to the player, and no answer whose end cannot be known.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_reset_in_the_middle_of_an_answer_is_still_502() {
    let short = b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{\"ok\":tr".to_vec();
    let (addr, _) = relay(early_answer_then_reset(short));
    let h = herald("gw-short", addr).await;
    let (status, v) = post(h, "/gw/f/nudge", NUDGE).await;
    assert_eq!(
        (status, v["code"].as_str()),
        (502, Some("RelayUnavailable"))
    );

    let unframed =
        b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{\"ok\":true}".to_vec();
    let (addr, _) = relay(early_answer_then_reset(unframed));
    let h = herald("gw-unframed", addr).await;
    let (status, v) = post(h, "/gw/f/nudge", NUDGE).await;
    assert_eq!(
        (status, v["code"].as_str()),
        (502, Some("RelayUnavailable")),
        "{v}"
    );

    let chunked = b"HTTP/1.1 429 Too Many Requests\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n5\r\n{\"a\":\r\n2\r\n1}\r\n0\r\n\r\n".to_vec();
    let (addr, _) = relay(early_answer_then_reset(chunked));
    let h = herald("gw-chunked", addr).await;
    let (status, v) = post(h, "/gw/f/nudge", NUDGE).await;
    assert_eq!(
        (status, v),
        (429, json!({"a": 1})),
        "a whole chunked answer is kept"
    );
}

/// A request that reached the relay is never sent twice, even when the
/// relay hangs up without an answer (a signed transaction must not be
/// relayed twice by the herald).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_request_that_reached_the_relay_is_not_retried() {
    let (addr, conns) = relay(|mut c| {
        let head = read_head(&mut c);
        let mut body = vec![0u8; content_length(&head)];
        let _ = c.read_exact(&mut body);
        drop(c); // whole request read, no answer: a FIN
    });
    let h = herald("gw-no-retry", addr).await;
    let (status, v) = post(h, "/gw/f/relay", r#"{"tx":"AAAA"}"#).await;
    assert_eq!(
        (status, v["code"].as_str()),
        (502, Some("RelayUnavailable"))
    );
    assert_eq!(conns.load(Ordering::SeqCst), 1);

    let (addr, conns) = relay(early_answer_then_reset(
        b"HTTP/1.1 200 OK\r\nContent-Length: 50\r\n\r\n{".to_vec(),
    ));
    let h = herald("gw-no-retry-rst", addr).await;
    let (status, _) = post(h, "/gw/f/relay", r#"{"tx":"AAAA"}"#).await;
    assert_eq!(status, 502);
    assert_eq!(
        conns.load(Ordering::SeqCst),
        1,
        "a reset after the request left is not retried"
    );
}

/// A refused connect sent nothing, so it is tried once more: a relay that
/// is listening again by then answers. A relay still down is one 502.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_refused_connect_is_tried_once_more() {
    let l = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = l.local_addr().unwrap().port();
    drop(l);
    let h = herald("gw-refused", format!("127.0.0.1:{port}")).await;
    let (status, v) = post(h, "/gw/f/nudge", NUDGE).await;
    assert_eq!(
        (status, v["code"].as_str()),
        (502, Some("RelayUnavailable"))
    );

    // The relay comes back between the two tries: the herald waits
    // GW_RECONNECT_PAUSE (200 ms) after the refusal; it is back after 20 ms.
    let l = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = l.local_addr().unwrap();
    drop(l);
    let h = herald("gw-refused-back", addr.to_string()).await;
    let up = std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(20));
        let l = TcpListener::bind(addr).unwrap();
        let (mut c, _) = l.accept().unwrap();
        let head = read_head(&mut c);
        let mut body = vec![0u8; content_length(&head)];
        c.read_exact(&mut body).unwrap();
        c.write_all(&json_answer("200 OK", r#"{"ok":true}"#))
            .unwrap();
    });
    let (status, v) = post(h, "/gw/f/nudge", NUDGE).await;
    assert_eq!((status, v), (200, json!({"ok": true})));
    up.join().unwrap();
}

/// Soak against a REAL Node http relay (manual): `FHGW_NODE_RELAY=127.0.0.1:PORT
/// cargo test -p herald --test gw_relay_reset -- --ignored --nocapture`, with a
/// Node server that answers 429 without reading the body (as the gateway's
/// per-address limiter does; evidence/fix-herald-gw-502/node-relay.mjs).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "needs a Node relay (FHGW_NODE_RELAY)"]
async fn soak_against_a_node_relay() {
    let relay = std::env::var("FHGW_NODE_RELAY").expect("FHGW_NODE_RELAY");
    let h = herald("gw-node-soak", relay).await;
    let mut counts = std::collections::BTreeMap::<u16, usize>::new();
    for _ in 0..500 {
        let (status, _) = post(h, "/gw/f/nudge", NUDGE).await;
        *counts.entry(status).or_default() += 1;
    }
    println!("node relay soak, 500 nudges via /gw: {counts:?}");
    assert_eq!(counts.get(&429), Some(&500), "{counts:?}");
}
