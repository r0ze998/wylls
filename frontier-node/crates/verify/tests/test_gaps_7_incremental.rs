//! test-gaps-7 (verify-pr291's hand checks, automated): `frontier-verify pull --incremental` stopped twice in the
//! middle of a chunk (the process killed while the node hangs on a getTransaction), resumed, and run again after the
//! chain grew, writes the SAME judge input (`DIR/input.json.gz`: transactions, history, finals, balances, rent,
//! tables) as one default pull of the final chain, and the offline judge gives the same verdict and report on both.
//! The archive has every transaction once (seq 1..N), `balances.jsonl` one line per transaction, and the killed runs
//! re-read at most the chunk each lost. verify-pr291 checked this once, by hand, on its recorded replica.
//!
//! The JSON-RPC stand-in is pull_incremental.rs's (copied: that file's tests would run twice if included), on
//! 127.0.0.1:0. Keyless: signatures are fixed byte patterns, transactions three opaque bytes; nothing is signed.

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
    let d = std::env::temp_dir().join(format!("verify-tg7-{name}-{}", std::process::id()));
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

fn hang_at(n: &Node, k: u64) {
    n.hang_after.store(k, Ordering::SeqCst);
}

/// Runs a pull that the node will hang on (its `k`-th getTransaction answered, the next never) and kills it there.
async fn killed_pull(url: &str, n: &Node, d: &Path, k: u64) {
    n.reset_calls();
    hang_at(n, k);
    let c = cmd(url, d, &["--incremental", "--chunk", "3"])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .unwrap();
    kill_while_hung(n, c, k).await;
    hang_at(n, 0);
}

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

/// `DIR/input.json.gz` as JSON text with the data directory's path written `<DATA>`.
fn input_text(d: &Path) -> String {
    use std::io::Read;
    let raw = std::fs::read(d.join("input.json.gz")).unwrap();
    let mut s = String::new();
    flate2::read::GzDecoder::new(&raw[..])
        .read_to_string(&mut s)
        .unwrap();
    s.replace(&d.display().to_string(), "<DATA>")
}

/// The offline judge over `DIR/input.json.gz`: (exit code, report.json with paths written `<DATA>`).
fn judge(d: &Path) -> (Option<i32>, Value) {
    let out = d.join("report");
    let o = std::process::Command::new(env!("CARGO_BIN_EXE_frontier-verify"))
        .arg("--fixture")
        .arg(d.join("input.json.gz"))
        .arg("--out")
        .arg(&out)
        .output()
        .unwrap();
    let text = std::fs::read_to_string(out.join("report.json")).unwrap_or_else(|e| {
        panic!(
            "no report ({e}): {}\n{}",
            String::from_utf8_lossy(&o.stdout),
            String::from_utf8_lossy(&o.stderr)
        )
    });
    let v: Value = serde_json::from_str(&text.replace(&d.display().to_string(), "<DATA>")).unwrap();
    (o.status.code(), v)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn killed_twice_resumed_and_grown_the_input_and_verdict_equal_one_default_pull() {
    const FIRST: u8 = 17;
    const N: u8 = 30;
    let n = Node::default();
    put(&n, FIRST);
    let url = start(n.clone()).await;
    let d1 = tmp("killed");

    // Kill 1: 7 answered (chunks of 3: 6 archived, the 7th lost with its chunk).
    killed_pull(&url, &n, &d1, 7).await;
    assert_eq!(archived(&d1), (1..=6).map(sig).collect::<Vec<_>>());
    assert_eq!(balances(&d1).1, 6);
    // Kill 2, resumed at 7: 5 answered (3 archived, 2 lost).
    killed_pull(&url, &n, &d1, 5).await;
    assert_eq!(archived(&d1), (1..=9).map(sig).collect::<Vec<_>>());
    assert_eq!(balances(&d1).1, 9);
    // The chain grows to 30; the run completes.
    put(&n, N);
    n.reset_calls();
    let s = pull(&url, &d1, &["--incremental", "--chunk", "3"]).await;
    assert_eq!(s["seq_before"], json!(9));
    assert_eq!(s["archived"], json!(N - 9));
    assert_eq!(
        n.calls("getTransaction"),
        (N - 9) as u64,
        "one getTransaction per new transaction"
    );
    assert_eq!(s["finals"]["consistent"], json!(true));

    // No duplicate anywhere.
    let a =
        findex::Archive::open(&d1.join("findex/archive"), findex::archive::SEGMENT_BYTES).unwrap();
    let recs = a.read_after(0).unwrap();
    assert_eq!(
        recs.iter().map(|r| r.seq).collect::<Vec<_>>(),
        (1..=N as u64).collect::<Vec<_>>()
    );
    assert_eq!(archived(&d1), (1..=N).map(sig).collect::<Vec<_>>());
    let (b1, lines) = balances(&d1);
    assert_eq!(
        (b1.len(), lines),
        (N as usize, N as usize),
        "one balances line per transaction"
    );

    // One default pull of the final chain.
    n.reset_calls();
    let d0 = tmp("default");
    let s0 = pull(&url, &d0, &[]).await;
    assert_eq!(s0["archived"], json!(N));
    assert_eq!(n.calls("getTransaction"), 2 * N as u64);
    assert_eq!(balances(&d0).0, b1);

    // The same judge input, byte for byte (paths aside), and the same verdict.
    let (i0, i1) = (input_text(&d0), input_text(&d1));
    assert!(i0.contains(&sig(N)), "the input holds the transactions");
    assert_eq!(
        i0, i1,
        "the resumed incremental input equals the default one"
    );
    let (c0, r0) = judge(&d0);
    let (c1, r1) = judge(&d1);
    eprintln!("verdict {:?} exit {c0:?}", r0["verdict"]);
    assert!(
        c0.is_some() && c0 != Some(0),
        "opaque transactions are never PASS: {c0:?}"
    );
    assert_eq!(c0, c1);
    assert_eq!(r0, r1, "the same report");
    let _ = std::fs::remove_dir_all(&d0);
    let _ = std::fs::remove_dir_all(&d1);
}
