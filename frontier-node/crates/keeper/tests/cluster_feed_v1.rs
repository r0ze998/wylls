//! B5 (read-only devnet run, 2026-11-21): devnet carries version-1
//! transactions (15 of the 33 in slot 523,600,000). A v1 transaction that
//! names the program is listed by `getSignaturesForAddress`; asked for with
//! `maxSupportedTransactionVersion` 0 the node refuses it (-32015), and the
//! `feed = "rpc"` poller stopped on it at every poll, forever. Replayed
//! offline with the RECORDED devnet answers (`fclient/tests/fixtures/
//! devnet-b5/`), loopback port 41491.
//!
//!   V1 the feed hands back the v1 record (and the one before it) and
//!      reaches its head; every `getTransaction` asked for version ≥ 1

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use fclient::ports::{ChainPort, Cursor, Signature};
use fclient::rpc::RpcPort;
use findex::RpcPoll;
use keeper_core::clusterfeed::{ClusterPort, FeedPacing};
use serde_json::{json, Value};
use solana_address::Address;

const PORT: u16 = 41491;
const V1_SIG: &str =
    "4t9MfiyECe35pAzgAupvqBYJ9dYXciYyUKNU9heES1AxFPNhSfXGrt2w75nxpL2ggJqS9ihSK6RcSq6NBkDkYb2x";

fn fixture(name: &str) -> Value {
    let p = format!(
        "{}/../fclient/tests/fixtures/devnet-b5/{name}",
        env!("CARGO_MANIFEST_DIR")
    );
    serde_json::from_str(&std::fs::read_to_string(&p).unwrap()).unwrap()
}

fn legacy_sig() -> String {
    Signature::from([5u8; 64]).to_string()
}

fn answer(q: &Value, asked: &Mutex<Vec<u64>>) -> Value {
    let p = &q["params"];
    let result = match q["method"].as_str().unwrap() {
        // Newest first: the v1 transaction, then an older legacy one.
        "getSignaturesForAddress" => {
            let rows = [
                (V1_SIG.to_string(), 523_600_000u64),
                (legacy_sig(), 523_599_000),
            ];
            let before = p[1]["before"].as_str();
            let start = before.map_or(0, |b| {
                rows.iter().position(|r| r.0 == b).map_or(2, |i| i + 1)
            });
            json!(rows[start..]
                .iter()
                .map(|(s, slot)| json!({"signature": s, "slot": slot, "err": null, "blockTime": 1_794_997_722}))
                .collect::<Vec<_>>())
        }
        "getTransaction" => {
            let max = p[1]["maxSupportedTransactionVersion"].as_u64().unwrap_or(0);
            asked.lock().unwrap().push(max);
            if p[0] == V1_SIG {
                let mut v = if max >= 1 {
                    fixture("getTransaction-v1-max1.json")
                } else {
                    fixture("getTransaction-v1-max0.json")
                };
                v["id"] = q["id"].clone();
                return v;
            }
            json!({"slot": 523_599_000u64, "blockTime": 1_794_997_000,
                   "transaction": ["AQ==", "base64"],
                   "meta": {"err": null, "logMessages": [], "computeUnitsConsumed": 1, "fee": 5000}})
        }
        m => panic!("unexpected {m}"),
    };
    json!({"jsonrpc": "2.0", "id": q["id"], "result": result})
}

fn mock() -> Arc<Mutex<Vec<u64>>> {
    let l = TcpListener::bind(("127.0.0.1", PORT))
        .unwrap_or_else(|e| panic!("127.0.0.1:{PORT} must be free: {e}"));
    let asked = Arc::new(Mutex::new(vec![]));
    let a2 = asked.clone();
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
            let out = answer(&q, &a2).to_string();
            let _ = c.write_all(
                format!(
                    "HTTP/1.1 200 X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{out}",
                    out.len()
                )
                .as_bytes(),
            );
        }
    });
    asked
}

#[tokio::test]
async fn v1_a_version_1_transaction_does_not_stall_the_feed() {
    let asked = mock();
    let url = format!("http://127.0.0.1:{PORT}");
    let program = Address::new_from_array([3; 32]);
    let port = ClusterPort::polled(
        RpcPort::new(url.clone(), program),
        RpcPoll::new(url, program),
        FeedPacing {
            poll: Duration::from_millis(10),
            max_backoff: Duration::from_millis(50),
        },
    );
    let page = port
        .feed(Cursor(0))
        .await
        .expect("the feed reads past a v1 transaction");
    assert_eq!(page.len(), 2);
    assert_eq!(page[0].signature.to_string(), legacy_sig());
    assert_eq!((page[1].seq, page[1].slot), (2, 523_600_000));
    assert_eq!(page[1].tx.first(), Some(&0x81), "its v1 bytes, as served");
    tokio::time::sleep(Duration::from_millis(20)).await;
    assert!(
        port.feed(Cursor(2)).await.unwrap().is_empty(),
        "at the head"
    );
    assert!(asked.lock().unwrap().iter().all(|&m| m >= 1));
}
