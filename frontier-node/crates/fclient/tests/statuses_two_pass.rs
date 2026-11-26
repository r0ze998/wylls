//! keeper-landing-investigate (devnet world 3, 2026-11-26): keeper A never
//! recorded a landing. Each poll asked `getSignatureStatuses` with
//! `searchTransactionHistory` for every unsettled signature, 256 per call;
//! api.devnet needs ≈ 0.18 s per signature on that path (256 → 45 s), past
//! fclient's 20 s POST deadline, so `statuses` failed as a whole and the
//! engine's `unwrap_or_default` saw no status at all, every poll.
//!
//! A loopback mock (port 41510, range 41500–41549) plays the public RPC:
//! the status cache knows recent landings; the history search knows older
//! ones but refuses (HTTP 504, as a deadline would end it) any call with
//! more than 32 signatures. It also injects 429s.
//!
//!   S1 landings in the status cache are returned even when the unknown
//!      list is long (the old code sent 256 to the history search and failed)
//!   S2 the history search gets at most HISTORY_CHUNK per call and at most
//!      HISTORY_PER_CALL per `statuses`, and rotates: repeated polls find
//!      every older landing
//!   S3 a 429 on one chunk leaves only that chunk unknown
//!   S4 no status-cache chunk answered at all: the call is an error (start-up
//!      reconciliation must not mistake "RPC down" for "all unknown")
//!   S5 the history search runs at most once per `history_every` (20 s on a
//!      remote URL): unknown re-sends stay unknown forever and the keeper
//!      polls every tick, so without the gate every tick waits for it

use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use fclient::ports::{ChainPort, Signature};
use fclient::rpc::{
    RpcClient, RpcPort, HISTORY_CHUNK, HISTORY_EVERY, HISTORY_PER_CALL, STATUS_CHUNK,
};
use serde_json::{json, Value};
use solana_address::Address;

const PORT: u16 = 41510;

static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[derive(Default)]
struct Chain {
    /// In the node's status cache (recent).
    recent: HashSet<String>,
    /// Only in the history store (older), with a custom error code.
    old: HashMap<String, u32>,
    /// Signature counts of the calls: (history?, n).
    calls: Vec<(bool, usize)>,
    /// Answer the next `n` calls of this kind with 429.
    fail_cache: usize,
    fail_history: usize,
    /// Fail every status-cache call (S4).
    cache_down: bool,
}

fn serve(chain: Arc<Mutex<Chain>>) {
    let l = TcpListener::bind(("127.0.0.1", PORT))
        .unwrap_or_else(|e| panic!("127.0.0.1:{PORT} must be free: {e}"));
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
            let (status, out) = answer(&chain, &q);
            let _ = c.write_all(
                format!(
                    "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{out}",
                    out.len()
                )
                .as_bytes(),
            );
        }
    });
}

fn answer(chain: &Arc<Mutex<Chain>>, q: &Value) -> (u16, String) {
    assert_eq!(q["method"], "getSignatureStatuses");
    let sigs: Vec<String> = q["params"][0]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s.as_str().unwrap().to_string())
        .collect();
    let history = q["params"][1]["searchTransactionHistory"] == json!(true);
    let mut c = chain.lock().unwrap();
    c.calls.push((history, sigs.len()));
    let busy = json!({"jsonrpc": "2.0", "id": q["id"], "error": {"code": 429, "message": "Too many requests for a specific RPC call"}}).to_string();
    if !history && (c.cache_down || c.fail_cache > 0) {
        c.fail_cache = c.fail_cache.saturating_sub(1);
        return (429, busy);
    }
    if history && c.fail_history > 0 {
        c.fail_history -= 1;
        return (429, busy);
    }
    if sigs.len() > 256 {
        return (200, json!({"jsonrpc": "2.0", "id": q["id"], "error": {"code": -32602, "message": "Too many inputs provided; max 256"}}).to_string());
    }
    if history && sigs.len() > 32 {
        // ≈ 0.18 s per signature on api.devnet: past the client's deadline.
        return (504, String::new());
    }
    let v: Vec<Value> = sigs
        .iter()
        .map(|s| {
            if c.recent.contains(s) {
                json!({"slot": 100, "confirmations": null, "err": null, "confirmationStatus": "finalized"})
            } else if let (true, Some(code)) = (history, c.old.get(s)) {
                json!({"slot": 50, "confirmations": null, "err": {"InstructionError": [0, {"Custom": code}]}, "confirmationStatus": "finalized"})
            } else {
                Value::Null
            }
        })
        .collect();
    (
        200,
        json!({"jsonrpc": "2.0", "id": q["id"], "result": {"context": {"slot": 200}, "value": v}})
            .to_string(),
    )
}

async fn stop() {
    let _ = RpcClient::new(format!("http://127.0.0.1:{PORT}"))
        .call("__stop", json!([]))
        .await;
}

fn sig(i: u32) -> Signature {
    let mut b = [0u8; 64];
    b[..4].copy_from_slice(&i.to_le_bytes());
    b[63] = 7;
    Signature::from(b)
}

fn port() -> RpcPort {
    RpcPort::new(
        format!("http://127.0.0.1:{PORT}"),
        Address::new_from_array([9; 32]),
    )
}

/// 600 unsettled signatures as keeper A had: 40 landed recently, 10 landed
/// long ago (AlreadyDone 52), 550 never landed (expired re-sends).
fn world() -> (Arc<Mutex<Chain>>, Vec<Signature>) {
    let sigs: Vec<Signature> = (0..600).map(sig).collect();
    let mut c = Chain::default();
    for i in (0..600).step_by(15) {
        c.recent.insert(sigs[i].to_string());
    }
    for i in (7..600).step_by(60) {
        c.old.insert(sigs[i].to_string(), 52);
    }
    assert_eq!((c.recent.len(), c.old.len()), (40, 10));
    (Arc::new(Mutex::new(c)), sigs)
}

#[tokio::test]
async fn s1_s2_cache_landings_survive_a_long_unknown_list_and_history_rotates() {
    let _g = SERIAL.lock().await;
    let (chain, sigs) = world();
    serve(chain.clone());
    let p = port();
    let mut found_old = HashSet::new();
    for poll in 0..20 {
        chain.lock().unwrap().calls.clear();
        let st = p.statuses(&sigs).await.expect("statuses");
        assert_eq!(st.len(), sigs.len());
        // S1: every recent landing, every poll.
        for i in (0..600).step_by(15) {
            let s = st[i]
                .as_ref()
                .unwrap_or_else(|| panic!("poll {poll}: recent {i} missing"));
            assert_eq!((s.slot, s.err.as_deref()), (100, None));
        }
        for (i, s) in st.iter().enumerate() {
            if let Some(s) = s {
                if s.slot == 50 {
                    assert_eq!(s.code, Some(52));
                    found_old.insert(i);
                }
            }
        }
        // S2: bounded history work per call.
        let calls = chain.lock().unwrap().calls.clone();
        let cache: Vec<usize> = calls.iter().filter(|c| !c.0).map(|c| c.1).collect();
        let hist: Vec<usize> = calls.iter().filter(|c| c.0).map(|c| c.1).collect();
        assert_eq!(
            cache,
            vec![STATUS_CHUNK, STATUS_CHUNK, 600 - 2 * STATUS_CHUNK]
        );
        assert!(hist.iter().all(|&n| n <= HISTORY_CHUNK), "{hist:?}");
        assert_eq!(hist.iter().sum::<usize>(), HISTORY_PER_CALL, "{hist:?}");
    }
    // 560 unknown to the cache, 32 per call: 18 calls cover them all.
    assert_eq!(found_old.len(), 10, "found {found_old:?}");
    stop().await;
}

#[tokio::test]
async fn s3_a_429_on_one_chunk_leaves_only_that_chunk_unknown() {
    let _g = SERIAL.lock().await;
    let (chain, sigs) = world();
    chain.lock().unwrap().fail_cache = 1; // the first 256
    chain.lock().unwrap().fail_history = 1;
    serve(chain.clone());
    let st = port()
        .statuses(&sigs)
        .await
        .expect("partial answer, not an error");
    for i in (0..600).step_by(15) {
        if i < STATUS_CHUNK {
            assert!(st[i].is_none(), "{i}: its chunk was refused");
        } else {
            assert!(st[i].is_some(), "{i}: answered by its own chunk");
        }
    }
    stop().await;
}

#[tokio::test]
async fn s4_no_answer_at_all_is_an_error() {
    let _g = SERIAL.lock().await;
    let (chain, sigs) = world();
    chain.lock().unwrap().cache_down = true;
    serve(chain.clone());
    assert!(port().statuses(&sigs).await.is_err());
    // No history search is spent when the cache pass learned nothing.
    assert!(chain.lock().unwrap().calls.iter().all(|c| !c.0));
    stop().await;
}

#[tokio::test]
async fn s5_history_runs_at_most_once_per_history_every() {
    let _g = SERIAL.lock().await;
    let (chain, sigs) = world();
    serve(chain.clone());
    // A remote URL gets the gate by default; loopback does not.
    assert_eq!(
        RpcPort::new(
            "https://api.devnet.solana.com",
            Address::new_from_array([9; 32])
        )
        .history_every,
        HISTORY_EVERY
    );
    assert_eq!(port().history_every, Duration::ZERO);
    let p = port().with_history_every(Duration::from_millis(400));
    for _ in 0..3 {
        p.statuses(&sigs).await.unwrap();
    }
    let hist = |c: &Arc<Mutex<Chain>>| c.lock().unwrap().calls.iter().filter(|c| c.0).count();
    // Only the first of three back-to-back calls searched history.
    assert_eq!(hist(&chain), HISTORY_PER_CALL / HISTORY_CHUNK);
    tokio::time::sleep(Duration::from_millis(450)).await;
    let st = p.statuses(&sigs).await.unwrap();
    assert_eq!(hist(&chain), 2 * (HISTORY_PER_CALL / HISTORY_CHUNK));
    // The cache pass is never gated.
    assert!(st[0].is_some());
    stop().await;
}
