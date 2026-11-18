//! The keeper's public-cluster feed (`feed = "rpc"`, devnet-readiness B2)
//! against a loopback mock of a public RPC (no `frontier_feed`): ports
//! 41464–41467 (the fnode-devnet-rpc range).
//!
//!   F1 the first read polls the history and numbers it 1..N, oldest first
//!   F2 at the head within `feed_poll_ms`: an empty page, no RPC call
//!   F3 after the interval a new transaction arrives as seq N+1
//!   F4 a 429 → error, then `Unavailable` (never an empty page) without
//!      calling during the backoff; the backoff doubles; it recovers
//!   F5 a cursor past the log is refused
//!   F6 `keeper.toml`: `feed`, the pacing keys, and the https/localnet guard

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::Engine;
use fclient::ports::{ChainPort, Cursor, PortError, Signature};
use fclient::rpc::{Pacer, RpcClient, RpcPort};
use findex::RpcPoll;
use keeper_core::clusterfeed::{ClusterPort, FeedPacing};
use keeper_core::config::{FeedSource, KeeperConfig};
use serde_json::{json, Value};
use solana_address::Address;

#[derive(Default)]
struct Chain {
    /// (signature, slot), oldest first.
    sigs: Vec<(String, u64)>,
    throttle: bool,
    calls: usize,
}

fn sig(i: u8) -> String {
    Signature::from([i; 64]).to_string()
}

fn answer(c: &mut Chain, q: &Value) -> (u16, Value) {
    c.calls += 1;
    if c.throttle {
        return (429, json!({}));
    }
    let id = q["id"].clone();
    let p = &q["params"];
    let result = match q["method"].as_str().unwrap() {
        "getSignaturesForAddress" => {
            let cfg = &p[1];
            let limit = cfg["limit"].as_u64().unwrap_or(1000) as usize;
            let newest_first: Vec<_> = c.sigs.iter().rev().collect();
            let start = match cfg["before"].as_str() {
                Some(b) => newest_first
                    .iter()
                    .position(|(s, _)| s == b)
                    .map_or(newest_first.len(), |i| i + 1),
                None => 0,
            };
            let mut out = vec![];
            for (s, slot) in &newest_first[start..] {
                if cfg["until"].as_str() == Some(s.as_str()) || out.len() == limit {
                    break;
                }
                out.push(json!({"signature": s, "slot": slot, "err": null, "blockTime": 1_700_000_000 + *slot as i64}));
            }
            json!(out)
        }
        "getTransaction" => {
            let s = p[0].as_str().unwrap();
            match c.sigs.iter().find(|(x, _)| x == s) {
                None => Value::Null,
                Some((_, slot)) => json!({
                    "slot": slot,
                    "blockTime": 1_700_000_000 + *slot as i64,
                    "transaction": [base64::engine::general_purpose::STANDARD.encode([*slot as u8; 8]), "base64"],
                    "meta": {"err": null, "logMessages": ["Program log: x"], "computeUnitsConsumed": 100, "fee": 5000},
                }),
            }
        }
        "frontier_feed" => {
            return (
                200,
                json!({"jsonrpc": "2.0", "id": id, "error": {"code": -32601, "message": "Method not found"}}),
            )
        }
        m => panic!("unexpected {m}"),
    };
    (200, json!({"jsonrpc": "2.0", "id": id, "result": result}))
}

fn mock(port: u16) -> Arc<Mutex<Chain>> {
    let l = TcpListener::bind(("127.0.0.1", port))
        .unwrap_or_else(|e| panic!("127.0.0.1:{port} must be free: {e}"));
    let chain = Arc::new(Mutex::new(Chain::default()));
    let c2 = chain.clone();
    std::thread::spawn(move || {
        for c in l.incoming() {
            let Ok(mut c) = c else { break };
            let mut r = BufReader::new(c.try_clone().unwrap());
            let mut line = String::new();
            if r.read_line(&mut line).is_err() {
                continue;
            }
            let mut len = 0usize;
            loop {
                let mut h = String::new();
                r.read_line(&mut h).unwrap();
                if h == "\r\n" || h.is_empty() {
                    break;
                }
                if let Some(v) = h.to_ascii_lowercase().strip_prefix("content-length:") {
                    len = v.trim().parse().unwrap();
                }
            }
            let mut body = vec![0; len];
            r.read_exact(&mut body).unwrap();
            let q: Value = serde_json::from_slice(&body).unwrap();
            let (status, v) = answer(&mut c2.lock().unwrap(), &q);
            let out = v.to_string();
            let _ = c.write_all(
                format!(
                    "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{out}",
                    out.len()
                )
                .as_bytes(),
            );
        }
    });
    chain
}

fn program() -> Address {
    Address::new_from_array([3; 32])
}

fn port(url: &str, poll_ms: u64, backoff_ms: u64) -> ClusterPort {
    ClusterPort::polled(
        RpcPort::new(url, program()),
        RpcPoll::new(url, program()),
        FeedPacing {
            poll: Duration::from_millis(poll_ms),
            max_backoff: Duration::from_millis(backoff_ms),
        },
    )
}

#[tokio::test]
async fn f1_f5_polled_feed_numbers_paces_and_backs_off() {
    let chain = mock(41464);
    {
        let mut c = chain.lock().unwrap();
        for i in 1..=5u8 {
            c.sigs.push((sig(i), 100 + i as u64));
        }
    }
    let url = "http://127.0.0.1:41464";
    let p = port(url, 300, 1_200);
    // F1
    let page = p.feed(Cursor(0)).await.unwrap();
    assert_eq!(
        page.iter().map(|r| r.seq).collect::<Vec<_>>(),
        [1, 2, 3, 4, 5]
    );
    assert_eq!(page[0].signature.to_string(), sig(1));
    assert_eq!(page[4].slot, 105);
    assert_eq!(page[2].tx, vec![103u8; 8]);
    // Re-reading below the head serves the log, no call.
    let calls = chain.lock().unwrap().calls;
    assert_eq!(p.feed(Cursor(2)).await.unwrap().len(), 3);
    // F2
    assert!(p.feed(Cursor(5)).await.unwrap().is_empty());
    assert_eq!(
        chain.lock().unwrap().calls,
        calls,
        "no RPC call at the head within the interval"
    );
    // F3
    chain.lock().unwrap().sigs.push((sig(6), 106));
    assert!(
        p.feed(Cursor(5)).await.unwrap().is_empty(),
        "still within the interval"
    );
    tokio::time::sleep(Duration::from_millis(320)).await;
    let page = p.feed(Cursor(5)).await.unwrap();
    assert_eq!(page.len(), 1);
    assert_eq!((page[0].seq, page[0].signature.to_string()), (6, sig(6)));
    // F4
    tokio::time::sleep(Duration::from_millis(320)).await;
    chain.lock().unwrap().throttle = true;
    let e = p.feed(Cursor(6)).await.unwrap_err();
    assert!(matches!(e, PortError::Http(429)), "{e:?}");
    let calls = chain.lock().unwrap().calls;
    let e = p.feed(Cursor(6)).await.unwrap_err();
    assert!(
        matches!(&e, PortError::Unavailable(m) if m.contains("backing off")),
        "{e:?}"
    );
    assert_eq!(
        chain.lock().unwrap().calls,
        calls,
        "no call during the backoff"
    );
    assert_eq!(
        p.feed.as_ref().unwrap().lock().await.backoff(),
        Duration::from_millis(300)
    );
    tokio::time::sleep(Duration::from_millis(320)).await;
    assert!(p.feed(Cursor(6)).await.is_err());
    assert_eq!(
        p.feed.as_ref().unwrap().lock().await.backoff(),
        Duration::from_millis(600)
    );
    chain.lock().unwrap().throttle = false;
    chain.lock().unwrap().sigs.push((sig(7), 107));
    tokio::time::sleep(Duration::from_millis(620)).await;
    let page = p.feed(Cursor(6)).await.unwrap();
    assert_eq!(page.iter().map(|r| r.seq).collect::<Vec<_>>(), [7]);
    assert_eq!(
        p.feed.as_ref().unwrap().lock().await.backoff(),
        Duration::ZERO
    );
    // F5
    let e = p.feed(Cursor(9)).await.unwrap_err();
    assert!(
        matches!(&e, PortError::Unavailable(m) if m.contains("past the polled log")),
        "{e:?}"
    );
}

#[tokio::test]
async fn f1_pacer_spaces_the_first_poll() {
    let chain = mock(41465);
    {
        let mut c = chain.lock().unwrap();
        for i in 1..=3u8 {
            c.sigs.push((sig(i), 10 + i as u64));
        }
    }
    let url = "http://127.0.0.1:41465";
    let pacer = Pacer::new(Duration::from_millis(40), Duration::from_secs(1));
    let mut poll = RpcPoll::new(url, program());
    poll.rpc = RpcClient::new(url).with_pacer(pacer.clone());
    let p = ClusterPort::polled(
        RpcPort::new(url, program()),
        poll,
        FeedPacing {
            poll: Duration::from_millis(500),
            max_backoff: Duration::from_secs(2),
        },
    );
    let t = std::time::Instant::now();
    assert_eq!(p.feed(Cursor(0)).await.unwrap().len(), 3);
    let calls = chain.lock().unwrap().calls as u32;
    assert!(calls >= 4, "{calls}");
    // calls - 1 gaps of 40 ms at least.
    assert!(
        t.elapsed() >= Duration::from_millis(40) * (calls - 1),
        "{:?} for {calls}",
        t.elapsed()
    );
}

#[test]
fn f6_keeper_toml_feed_keys() {
    let base = |extra: &str| {
        format!(
            "program = \"{}\"\nseason = 1\nbeneficiary = \"{}\"\n{extra}",
            program(),
            Address::new_from_array([4; 32])
        )
    };
    let c = KeeperConfig::from_toml(&base("rpc = [\"http://127.0.0.1:41010\"]")).unwrap();
    assert_eq!(c.feed, FeedSource::Localnet);
    assert_eq!(c.rpc_min_gap(), Duration::ZERO);
    let c = KeeperConfig::from_toml(&base(
        "rpc = [\"https://api.devnet.solana.com\"]\nfeed = \"rpc\"\nfeed_poll_ms = 3000\nfeed_max_backoff_ms = 90000",
    ))
    .unwrap();
    assert_eq!(
        (c.feed, c.feed_poll_ms, c.feed_max_backoff_ms),
        (FeedSource::Rpc, 3000, 90000)
    );
    assert_eq!(c.rpc_min_gap(), Duration::from_millis(150));
    let c = KeeperConfig::from_toml(&base(
        "rpc = [\"https://rpc.example.com/?api-key=k\"]\nfeed = \"rpc\"\nrpc_min_gap_ms = 50",
    ))
    .unwrap();
    assert_eq!(c.rpc_min_gap(), Duration::from_millis(50));
    for (bad, why) in [
        (
            "rpc = [\"https://api.devnet.solana.com\"]",
            "has no `frontier_feed`",
        ),
        ("feed = \"devnet\"", "localnet"),
        (
            "rpc = [\"https://api.devnet.solana.com\"]\nfeed = \"rpc\"\nfeed_poll_ms = 10",
            "at least 200",
        ),
        (
            "rpc = [\"https://a.example/?k=a b\"]\nfeed = \"rpc\"",
            "query",
        ),
        ("rpc = [\"ftp://a.example\"]", "not http"),
        ("feed_witness = \"https://b.example\"", "need feed"),
        (
            "rpc = [\"https://a.example\"]\nfeed = \"rpc\"\nfeed_origin = \"x\"",
            "signature",
        ),
    ] {
        let e = KeeperConfig::from_toml(&base(bad)).unwrap_err();
        assert!(e.contains(why), "{bad}: {e}");
    }
    // The error names the host, never the key.
    let e = KeeperConfig::from_toml(&base(
        "rpc = [\"https://a.example/s3cret?k=a b\"]\nfeed = \"rpc\"",
    ))
    .unwrap_err();
    assert!(!e.contains("s3cret"), "{e}");
}
