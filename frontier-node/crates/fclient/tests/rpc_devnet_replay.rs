//! B5 regressions from the read-only devnet run (2026-11-21), replayed
//! offline: a loopback mock answers with the public RPCs' RECORDED bodies
//! (`tests/fixtures/devnet-b5/`). Port 41490 (B5 range 41450–41499).
//!
//!   R1 a 429 with `Retry-After` (api.devnet.solana.com: "Too many requests
//!      for a specific RPC call", 10 s) is retried after at least that long,
//!      every try counted by the pacer; without retries it stays the
//!      caller's `Http(429)` (the verifier used to stop there)
//!   R2 a 429 without `Retry-After` (OnFinality's -32029 body) backs off
//!      by the pacer's doubling penalty and is retried too
//!   R3 a version-1 transaction: fclient asks `maxSupportedTransactionVersion`
//!      1 and gets its bytes (legacy decoding refuses them, as for v0);
//!      asked with 0 the node answers -32015, which stalled every poller

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use fclient::ports::PortError;
use fclient::rpc::{Pacer, RpcClient};
use serde_json::{json, Value};

const PORT: u16 = 41490;

fn fixture(name: &str) -> Value {
    let p = format!(
        "{}/tests/fixtures/devnet-b5/{name}",
        env!("CARGO_MANIFEST_DIR")
    );
    serde_json::from_str(&std::fs::read_to_string(&p).unwrap()).unwrap()
}

type Answer = Box<dyn FnMut(&Value) -> (u16, Vec<(String, String)>, Value) + Send>;

/// One mock at a time (the tests share the port).
static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn serve(answer: Answer) -> Arc<Mutex<usize>> {
    let l = TcpListener::bind(("127.0.0.1", PORT))
        .unwrap_or_else(|e| panic!("127.0.0.1:{PORT} must be free: {e}"));
    let calls = Arc::new(Mutex::new(0usize));
    let c2 = calls.clone();
    let answer = Arc::new(Mutex::new(answer));
    std::thread::spawn(move || {
        for c in l.incoming() {
            let Ok(mut c) = c else { break };
            let mut r = BufReader::new(c.try_clone().unwrap());
            let mut line = String::new();
            if r.read_line(&mut line).is_err() || line.is_empty() {
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
            if q["method"] == "__stop" {
                let _ = c
                    .write_all(b"HTTP/1.1 200 X\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
                break;
            }
            *c2.lock().unwrap() += 1;
            let (status, headers, mut v) = (answer.lock().unwrap())(&q);
            if v.get("id").is_some() {
                v["id"] = q["id"].clone();
            }
            let out = v.to_string();
            let extra: String = headers
                .iter()
                .map(|(k, v)| format!("{k}: {v}\r\n"))
                .collect();
            let _ = c.write_all(
                format!(
                    "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\n{extra}Content-Length: {}\r\nConnection: close\r\n\r\n{out}",
                    out.len()
                )
                .as_bytes(),
            );
        }
    });
    calls
}

async fn stop() {
    let _ = RpcClient::new(format!("http://127.0.0.1:{PORT}"))
        .call("__stop", json!([]))
        .await;
}

fn url() -> String {
    format!("http://127.0.0.1:{PORT}")
}

/// `n` recorded 429s, then `{"result": 42}`.
fn throttled_then_ok(n: usize, rec: Value, retry_after: Option<&'static str>) -> Answer {
    let mut left = n;
    Box::new(move |_q| {
        if left > 0 {
            left -= 1;
            let h = retry_after
                .map(|s| vec![("Retry-After".to_string(), s.to_string())])
                .unwrap_or_default();
            return (429, h, rec["body"].clone());
        }
        (
            200,
            vec![],
            json!({"jsonrpc": "2.0", "id": 0, "result": 42}),
        )
    })
}

#[tokio::test]
async fn r1_a_429_with_retry_after_is_retried_after_it() {
    let _g = SERIAL.lock().await;
    let rec = fixture("429-api-devnet.json");
    assert_eq!(rec["body"]["error"]["code"], 429);
    // Retried: 2 throttled answers, then the result.
    let calls = serve(throttled_then_ok(2, rec.clone(), Some("1")));
    let pacer = Pacer::new(Duration::from_millis(10), Duration::from_secs(30));
    let c = RpcClient::new(url()).with_pacer(pacer.clone());
    assert_eq!(c.retries, 0, "a loopback client does not retry by default");
    let c = c.with_retries(fclient::rpc::PUBLIC_RETRIES);
    let t0 = Instant::now();
    assert_eq!(c.call("getSlot", json!([])).await.unwrap(), json!(42));
    assert!(
        t0.elapsed() >= Duration::from_millis(1900),
        "waited {:?}, not 2 × Retry-After",
        t0.elapsed()
    );
    assert_eq!(*calls.lock().unwrap(), 3);
    assert_eq!(pacer.calls.load(std::sync::atomic::Ordering::Relaxed), 3);
    assert_eq!(
        pacer.throttles.load(std::sync::atomic::Ordering::Relaxed),
        2
    );
    assert_eq!(
        pacer.penalty().await,
        Duration::ZERO,
        "cleared by the success"
    );
    stop().await;
    // Without retries: the caller's Http(429), one request.
    let calls = serve(throttled_then_ok(1, rec, Some("1")));
    let c = RpcClient::new(url());
    assert!(matches!(
        c.call("getSlot", json!([])).await,
        Err(PortError::Http(429))
    ));
    assert_eq!(*calls.lock().unwrap(), 1);
    stop().await;
}

#[tokio::test]
async fn r2_a_429_without_retry_after_backs_off_and_is_retried() {
    let _g = SERIAL.lock().await;
    let rec = fixture("429-onfinality.json");
    assert_eq!(rec["body"]["error"]["code"], -32029);
    let calls = serve(throttled_then_ok(2, rec, None));
    let pacer = Pacer::new(Duration::from_millis(10), Duration::from_secs(30));
    let c = RpcClient::new(url())
        .with_pacer(pacer.clone())
        .with_retries(2);
    let t0 = Instant::now();
    assert_eq!(c.call("getSlot", json!([])).await.unwrap(), json!(42));
    // Penalties 500 ms, then 1 s.
    assert!(
        t0.elapsed() >= Duration::from_millis(1400),
        "{:?}",
        t0.elapsed()
    );
    assert_eq!(*calls.lock().unwrap(), 3);
    stop().await;
    // More 429s than retries: the error, after retries + 1 requests.
    let calls = serve(throttled_then_ok(9, fixture("429-onfinality.json"), None));
    let c = RpcClient::new(url())
        .with_pacer(Pacer::new(
            Duration::from_millis(10),
            Duration::from_millis(50),
        ))
        .with_retries(2);
    assert!(matches!(
        c.call("getSlot", json!([])).await,
        Err(PortError::Http(429))
    ));
    assert_eq!(*calls.lock().unwrap(), 3);
    stop().await;
}

#[tokio::test]
async fn r3_a_version_1_transaction_is_read_not_refused() {
    let _g = SERIAL.lock().await;
    let v1 = fixture("getTransaction-v1-max1.json");
    let refused = fixture("getTransaction-v1-max0.json");
    assert_eq!(refused["error"]["code"], -32015);
    assert_eq!(v1["result"]["version"], 1);
    let sig: fclient::ports::Signature =
        "4t9MfiyECe35pAzgAupvqBYJ9dYXciYyUKNU9heES1AxFPNhSfXGrt2w75nxpL2ggJqS9ihSK6RcSq6NBkDkYb2x"
            .parse()
            .unwrap();
    let asked = Arc::new(Mutex::new(vec![]));
    let a2 = asked.clone();
    let calls = serve(Box::new(move |q| {
        let max = q["params"][1]["maxSupportedTransactionVersion"].as_u64();
        a2.lock().unwrap().push(max);
        // As the devnet node: a v1 transaction needs max ≥ 1.
        if max.unwrap_or(0) >= 1 {
            (200, vec![], v1.clone())
        } else {
            (200, vec![], refused.clone())
        }
    }));
    let c = RpcClient::new(url());
    let rec = c
        .get_finalized_transaction(&sig)
        .await
        .expect("read")
        .expect("served");
    assert_eq!(rec.slot, 523_600_000);
    assert_eq!(
        rec.tx.first(),
        Some(&0x81),
        "version-1 wire bytes, as served"
    );
    assert!(
        fclient::tx::from_wire(&rec.tx).is_err(),
        "legacy decoding refuses v1"
    );
    // herald-v0v1-decode: the versioned reader decodes it whole
    let d = fclient::vtx::decode(&rec.tx).expect("v1 decodes");
    assert_eq!(d.version, fclient::vtx::Version::V1);
    assert_eq!(d.signature(), sig);
    assert!(rec.loaded.writable.is_empty() && rec.loaded.readonly.is_empty());
    assert!(c
        .get_transaction_balances(&sig, "finalized")
        .await
        .unwrap()
        .is_some());
    assert_eq!(
        *asked.lock().unwrap(),
        vec![Some(fclient::rpc::MAX_TX_VERSION as u64); 2]
    );
    // What every poller met before: the node's refusal at version 0.
    let e = c
        .call(
            "getTransaction",
            json!([sig.to_string(), {"encoding": "base64", "maxSupportedTransactionVersion": 0}]),
        )
        .await;
    assert!(
        matches!(e, Err(PortError::Rpc { code: -32015, .. })),
        "{e:?}"
    );
    assert_eq!(*calls.lock().unwrap(), 3);
    stop().await;
}
