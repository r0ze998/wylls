//! verify-local-source: `frontier-verify pull --incremental` against a
//! counting JSON-RPC stand-in on 127.0.0.1 (an ephemeral port; no devnet).
//!
//! - The same history pulled with and without `--incremental` archives the
//!   same records and the same balances; the default spends 2
//!   `getTransaction` per new transaction (the record, then its balances),
//!   `--incremental` 1 (both from one answer).
//! - A pull stopped in the middle (the node stops answering, the process is
//!   killed): the default has archived nothing, `--incremental` every whole
//!   chunk with its balances; the next run resumes from there without a
//!   duplicate.
//! - A transaction served without balances is read again by step 4, as in
//!   the default.
//!
//! Keyless: signatures are fixed byte patterns, transactions three opaque
//! bytes (undecodable: written by no key, judged by nothing here).

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use axum::{extract::State, routing::post, Json, Router};
use base64::Engine;
use serde_json::{json, Value};

#[derive(Clone, Default)]
struct Node {
    /// Signatures oldest first with their slots.
    txs: Arc<Mutex<Vec<(String, u64)>>>,
    /// Calls per method.
    calls: Arc<Mutex<BTreeMap<String, u64>>>,
    /// `getTransaction` calls after this many hang forever (0: never).
    hang_after: Arc<AtomicU64>,
    /// Transactions served without `preBalances` / `postBalances`.
    no_balances: Arc<Mutex<Vec<String>>>,
}

impl Node {
    fn calls(&self, m: &str) -> u64 {
        self.calls.lock().unwrap().get(m).copied().unwrap_or(0)
    }
    fn reset_calls(&self) {
        self.calls.lock().unwrap().clear();
    }
}

fn bal(slot: u64) -> (Vec<u64>, Vec<u64>) {
    (vec![1_000_000 + slot, 7], vec![995_000 + slot, 7])
}

async fn rpc(State(n): State<Node>, Json(req): Json<Value>) -> Json<Value> {
    let id = req.get("id").cloned().unwrap_or(json!(1));
    let p = req.get("params").cloned().unwrap_or(json!([]));
    let method = req
        .get("method")
        .and_then(|m| m.as_str())
        .unwrap_or("")
        .to_string();
    let k = {
        let mut c = n.calls.lock().unwrap();
        let e = c.entry(method.clone()).or_default();
        *e += 1;
        *e
    };
    let all = n.txs.lock().unwrap().clone();
    let top = all.last().map_or(1, |(_, s)| *s + 1);
    let result = match method.as_str() {
        "getTransaction" => {
            let h = n.hang_after.load(Ordering::SeqCst);
            if h > 0 && k > h {
                std::future::pending::<()>().await;
            }
            let sig = p.get(0).and_then(|x| x.as_str()).unwrap_or("");
            match all.iter().find(|(s, _)| s == sig) {
                None => Value::Null,
                Some((_, slot)) => {
                    let mut meta = json!({"err": null, "fee": 5000, "logMessages": [], "computeUnitsConsumed": 9});
                    if !n.no_balances.lock().unwrap().iter().any(|s| s == sig) {
                        let (pre, post) = bal(*slot);
                        meta["preBalances"] = json!(pre);
                        meta["postBalances"] = json!(post);
                    }
                    json!({"slot": slot, "blockTime": 7,
                        "transaction": [base64::engine::general_purpose::STANDARD.encode([1u8, 2, 3]), "base64"],
                        "meta": meta})
                }
            }
        }
        "getSignaturesForAddress" => {
            let cfg = p.get(1).cloned().unwrap_or(json!({}));
            let limit = cfg.get("limit").and_then(|x| x.as_u64()).unwrap_or(1000) as usize;
            let mut newest: Vec<&(String, u64)> = all.iter().rev().collect();
            if let Some(b) = cfg.get("before").and_then(|x| x.as_str()) {
                let i = newest
                    .iter()
                    .position(|(s, _)| s == b)
                    .map_or(newest.len(), |i| i + 1);
                newest = newest.split_off(i);
            }
            if let Some(u) = cfg.get("until").and_then(|x| x.as_str()) {
                if let Some(i) = newest.iter().position(|(s, _)| s == u) {
                    newest.truncate(i);
                }
            }
            json!(newest
                .iter()
                .take(limit)
                .map(|(s, slot)| json!({"signature": s, "slot": slot, "err": null, "blockTime": 0}))
                .collect::<Vec<_>>())
        }
        "getMultipleAccounts" => {
            let n = p.get(0).and_then(|x| x.as_array()).map_or(0, |a| a.len());
            json!({"context": {"slot": top}, "value": vec![Value::Null; n]})
        }
        "getAccountInfo" => json!({"context": {"slot": top}, "value": null}),
        "getProgramAccounts" => json!([]),
        _ => Value::Null,
    };
    Json(json!({"jsonrpc": "2.0", "id": id, "result": result}))
}

async fn start(n: Node) -> String {
    let l = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let addr = l.local_addr().unwrap();
    let app = Router::new().route("/", post(rpc)).with_state(n);
    tokio::spawn(async move {
        let _ = axum::serve(l, app).await;
    });
    format!("http://{addr}")
}

fn sig(i: u8) -> String {
    fclient::ports::Signature::from([i; 64]).to_string()
}

fn put(n: &Node, count: u8) {
    let mut t = n.txs.lock().unwrap();
    t.clear();
    t.extend((1..=count).map(|i| (sig(i), i as u64)));
}

const PROGRAM: &str = "11111111111111111111111111111112";

fn tmp(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("verify-pull-inc-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn cmd(url: &str, data: &Path, extra: &[&str]) -> std::process::Command {
    let mut c = std::process::Command::new(env!("CARGO_BIN_EXE_frontier-verify"));
    c.args(["pull", "--program", PROGRAM, "--season", "3", "--rpc", url])
        .arg("--data")
        .arg(data)
        .args(["--rpc-min-gap-ms", "1", "--page", "8"])
        .args(extra);
    c
}

/// One pull run to its end: the summary line.
async fn pull(url: &str, data: &Path, extra: &[&str]) -> Value {
    let mut c = cmd(url, data, extra);
    let out = tokio::task::spawn_blocking(move || c.output().unwrap())
        .await
        .unwrap();
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert!(
        out.status.success(),
        "pull failed: {stdout}\n{}",
        String::from_utf8_lossy(&out.stderr)
    );
    serde_json::from_str(stdout.trim().lines().last().unwrap()).unwrap()
}

/// The archived signatures, in archive order.
fn archived(data: &Path) -> Vec<String> {
    let a = findex::Archive::open(&data.join("findex/archive"), findex::archive::SEGMENT_BYTES)
        .unwrap();
    a.read_after(0)
        .unwrap()
        .into_iter()
        .map(|r| r.signature.to_string())
        .collect()
}

/// `balances.jsonl` as signature → (pre, post), and its line count.
fn balances(data: &Path) -> (BTreeMap<String, Value>, usize) {
    let text = std::fs::read_to_string(data.join("balances.jsonl")).unwrap_or_default();
    let mut m = BTreeMap::new();
    let mut lines = 0;
    for l in text.lines() {
        lines += 1;
        let v: Value = serde_json::from_str(l).unwrap();
        m.insert(
            v["sig"].as_str().unwrap().to_string(),
            json!([v["pre"], v["post"]]),
        );
    }
    (m, lines)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn incremental_archives_the_same_with_one_get_transaction_per_tx() {
    const N: u8 = 23;
    let n = Node::default();
    put(&n, N);
    let url = start(n.clone()).await;

    let d0 = tmp("default");
    let s0 = pull(&url, &d0, &[]).await;
    let gt0 = n.calls("getTransaction");
    let gs0 = n.calls("getSignaturesForAddress");
    n.reset_calls();

    let d1 = tmp("incremental");
    let s1 = pull(&url, &d1, &["--incremental", "--chunk", "5"]).await;
    let gt1 = n.calls("getTransaction");
    let gs1 = n.calls("getSignaturesForAddress");

    // The same archive and the same balances.
    let want: Vec<String> = (1..=N).map(sig).collect();
    assert_eq!(archived(&d0), want);
    assert_eq!(archived(&d1), want);
    let (b0, l0) = balances(&d0);
    let (b1, l1) = balances(&d1);
    assert_eq!(b0, b1);
    assert_eq!((l0, l1), (N as usize, N as usize), "each balance once");
    assert_eq!(b1[&sig(4)], json!([bal(4).0, bal(4).1]));
    assert_eq!(s0["finals"]["consistent"], json!(true));
    assert_eq!(s1["finals"]["consistent"], json!(true));
    assert_eq!(s0["archived"], json!(N));
    assert_eq!(s1["archived"], json!(N));

    // The measured count: 2 getTransaction per new transaction → 1.
    assert_eq!(gt0, 2 * N as u64, "default: the record, then its balances");
    assert_eq!(
        gt1, N as u64,
        "incremental: one getTransaction per transaction"
    );
    assert_eq!(s0["balances"]["fetched"], json!(N));
    assert_eq!(s1["balances"]["fetched"], json!(0));
    assert_eq!(s1["balances"]["inline"], json!(N));
    assert_eq!(s1["incremental"], json!({"chunk": 5}));
    assert_eq!(s0["incremental"], Value::Null);
    // Listing: one per chunk (+ the continuity page after the first).
    let chunks = (N as u64).div_ceil(5);
    assert!(
        gs1 <= gs0 + 2 * chunks + 2,
        "listing calls default {gs0}, incremental {gs1}"
    );
    eprintln!(
        "RPC counts for {N} new txs: default getTransaction={gt0} getSignaturesForAddress={gs0} requests={}; \
         incremental(chunk 5) getTransaction={gt1} getSignaturesForAddress={gs1} requests={}",
        s0["requests"], s1["requests"]
    );

    // A later run with nothing new: 0 getTransaction either way.
    n.reset_calls();
    let s2 = pull(&url, &d1, &["--incremental", "--chunk", "5"]).await;
    assert_eq!(s2["archived"], json!(0));
    assert_eq!(n.calls("getTransaction"), 0);

    // Two more transactions: 2 getTransaction, appended, balances once each.
    put(&n, N + 2);
    n.reset_calls();
    let s3 = pull(&url, &d1, &["--incremental", "--chunk", "5"]).await;
    assert_eq!(s3["archived"], json!(2));
    assert_eq!(n.calls("getTransaction"), 2);
    assert_eq!(archived(&d1).len(), N as usize + 2);
    assert_eq!(balances(&d1).1, N as usize + 2);
}

/// Waits until the node has answered `k` `getTransaction` calls and hangs on
/// the next, then lets the pull settle a moment and kills it.
async fn kill_while_hung(n: &Node, mut child: std::process::Child, k: u64) {
    for _ in 0..600 {
        if n.calls("getTransaction") > k {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    assert!(
        n.calls("getTransaction") > k,
        "the pull never reached the hang"
    );
    tokio::time::sleep(std::time::Duration::from_millis(400)).await;
    assert!(
        child.try_wait().unwrap().is_none(),
        "the pull must still be running (hung)"
    );
    child.kill().unwrap();
    child.wait().unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_stopped_incremental_pull_keeps_its_whole_chunks() {
    const N: u8 = 23;
    let n = Node::default();
    put(&n, N);
    let url = start(n.clone()).await;
    // 12 transactions served, then the node stops answering getTransaction.
    n.hang_after.store(12, Ordering::SeqCst);

    let d0 = tmp("stop-default");
    let c0 = cmd(&url, &d0, &[])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .unwrap();
    kill_while_hung(&n, c0, 12).await;
    assert!(
        archived(&d0).is_empty(),
        "default: the in-memory batch is lost"
    );

    n.reset_calls();
    let d1 = tmp("stop-incremental");
    let c1 = cmd(&url, &d1, &["--incremental", "--chunk", "5"])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .unwrap();
    kill_while_hung(&n, c1, 12).await;
    let kept = archived(&d1);
    assert_eq!(
        kept,
        (1..=10).map(sig).collect::<Vec<_>>(),
        "two whole chunks"
    );
    let (b, lines) = balances(&d1);
    assert_eq!(lines, 10);
    assert!(kept.iter().all(|s| b.contains_key(s)));

    // The node answers again: the next run resumes at 11, no duplicate.
    n.hang_after.store(0, Ordering::SeqCst);
    n.reset_calls();
    let s = pull(&url, &d1, &["--incremental", "--chunk", "5"]).await;
    assert_eq!(s["seq_before"], json!(10));
    assert_eq!(s["archived"], json!(N - 10));
    assert_eq!(n.calls("getTransaction"), (N - 10) as u64);
    assert_eq!(archived(&d1), (1..=N).map(sig).collect::<Vec<_>>());
    assert_eq!(balances(&d1).1, N as usize);
    assert_eq!(s["balances"]["fetched"], json!(0));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_transaction_served_without_balances_is_read_again_by_step_4() {
    let n = Node::default();
    put(&n, 6);
    n.no_balances.lock().unwrap().push(sig(3));
    let url = start(n.clone()).await;
    let d = tmp("no-bal");
    let s = pull(&url, &d, &["--incremental", "--chunk", "4"]).await;
    assert_eq!(s["balances"]["inline"], json!(5));
    // step 4 asks once more for the one without; still none: unserved.
    assert_eq!(s["balances"]["fetched"], json!(0));
    assert_eq!(s["balances"]["unserved"], json!(1));
    assert_eq!(n.calls("getTransaction"), 7);
    assert!(!balances(&d).0.contains_key(&sig(3)));
}

#[test]
fn chunk_needs_incremental() {
    let out = std::process::Command::new(env!("CARGO_BIN_EXE_frontier-verify"))
        .args([
            "pull",
            "--program",
            PROGRAM,
            "--season",
            "3",
            "--rpc",
            "http://127.0.0.1:9",
        ])
        .args(["--data", "/nonexistent-verify-local-source", "--chunk", "5"])
        .output()
        .unwrap();
    assert!(!out.status.success());
    assert!(String::from_utf8_lossy(&out.stdout).contains("--chunk needs --incremental"));
}
