//! herald-pull-chunk test support (also used by the herald's tests, by
//! path): a loopback JSON-RPC server (`127.0.0.1:0`) over a fixed list of
//! signed transfers, as a public RPC serves them: `getSignaturesForAddress`
//! honours `before`/`until`/`limit`, `getTransaction`, `getMultipleAccounts`
//! (one call can be made to fail), and `getAccountInfo` of the Clock sysvar
//! whose slot ticks on every read. Every method's calls are counted. No
//! network beyond loopback, no key (unsigned wires, placeholder signatures).
//! test-gaps-7: every request's arrival is stamped, getTransaction can be
//! answered HTTP 429 (a per-method storm) and the Clock read can fail; both
//! are off by default, so the answers above are unchanged.
#![allow(dead_code)]

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::response::{IntoResponse, Response};
use axum::{extract::State, http::StatusCode, routing::post, Json, Router};
use base64::Engine;
use fclient::{tx, Address, Hash};
use serde_json::{json, Value};

#[derive(Clone, Default)]
pub struct Chain {
    /// (signature, slot), oldest first.
    pub sigs: Arc<Mutex<Vec<(String, u64)>>>,
    pub wires: Arc<Mutex<HashMap<String, Vec<u8>>>>,
    pub calls: Arc<Mutex<HashMap<String, u64>>>,
    /// Fail the getMultipleAccounts call with this 1-based number (0: none).
    pub fail_accounts_call: Arc<AtomicU64>,
    /// The Clock's slot (advances by 1 on every read).
    pub clock_slot: Arc<AtomicU64>,
    /// A pause in every getTransaction (a slow, rate-limited node).
    pub tx_delay_us: Arc<AtomicU64>,
    /// test-gaps-7: answer every getTransaction HTTP 429 (devnet's
    /// per-method limit) while set.
    pub tx_429: Arc<AtomicBool>,
    /// test-gaps-7: the `Retry-After` seconds sent with those 429s (0: none).
    pub tx_429_retry_after: Arc<AtomicU64>,
    /// test-gaps-7: answer every getAccountInfo (the Clock) with a JSON-RPC
    /// error while set.
    pub clock_fail: Arc<AtomicBool>,
    /// test-gaps-7: (method, arrival) of every request, in arrival order.
    pub stamps: Arc<Mutex<Vec<(String, Instant)>>>,
}

/// The account every transfer goes to (the "program" the poller lists).
pub fn recipient() -> Address {
    Address::new_from_array([48; 32])
}

impl Chain {
    /// `n` distinct transfers to [`recipient`], slot `base + i`: UNSIGNED
    /// wires with a placeholder signature (the index), so no key is
    /// generated, derived or signed (key-free CI).
    pub fn with_transfers(n: u64, base: u64) -> Chain {
        let c = Chain::default();
        let payer = Address::new_from_array([47; 32]);
        let bh = Hash::new_from_array([49; 32]);
        let budget = tx::TxBudget {
            cu_limit: 10_000,
            cu_price: 0,
            loaded_limit: 1_048_576,
            heap: None,
        };
        for i in 0..n {
            let m = tx::message(
                &[tx::transfer(payer, recipient(), 1_000 + i)],
                &budget,
                &payer,
                &bh,
            );
            let mut t = fclient::Transaction::new_unsigned(m);
            let mut sig = [0x5Au8; 64];
            sig[..8].copy_from_slice(&(i + 1).to_le_bytes());
            t.signatures[0] = fclient::ports::Signature::from(sig);
            let sig = tx::signature(&t).to_string();
            c.sigs.lock().unwrap().push((sig.clone(), base + i));
            c.wires.lock().unwrap().insert(sig, tx::wire(&t));
        }
        c.clock_slot.store(base + n + 100, Ordering::SeqCst);
        c
    }

    pub fn count(&self, method: &str) -> u64 {
        *self.calls.lock().unwrap().get(method).unwrap_or(&0)
    }
}

async fn rpc(State(s): State<Chain>, Json(req): Json<Value>) -> Response {
    let method = req
        .get("method")
        .and_then(|m| m.as_str())
        .unwrap_or("")
        .to_string();
    s.stamps
        .lock()
        .unwrap()
        .push((method.clone(), Instant::now()));
    if method == "getTransaction" && s.tx_429.load(Ordering::SeqCst) {
        *s.calls.lock().unwrap().entry("429".into()).or_insert(0) += 1;
        let ra = s.tx_429_retry_after.load(Ordering::SeqCst);
        let body = Json(
            json!({"jsonrpc": "2.0", "id": req.get("id").cloned().unwrap_or(json!(1)),
            "error": {"code": 429, "message": "Too many requests for a specific RPC call"}}),
        );
        return if ra > 0 {
            (
                StatusCode::TOO_MANY_REQUESTS,
                [("Retry-After", ra.to_string())],
                body,
            )
                .into_response()
        } else {
            (StatusCode::TOO_MANY_REQUESTS, body).into_response()
        };
    }
    if method == "getAccountInfo" && s.clock_fail.load(Ordering::SeqCst) {
        *s.calls.lock().unwrap().entry(method.clone()).or_insert(0) += 1;
        return Json(
            json!({"jsonrpc": "2.0", "id": req.get("id").cloned().unwrap_or(json!(1)),
            "error": {"code": -32000, "message": "temporary clock read failure"}}),
        )
        .into_response();
    }
    rpc_ok(s, req, method).await.into_response()
}

async fn rpc_ok(s: Chain, req: Value, method: String) -> Json<Value> {
    let id = req.get("id").cloned().unwrap_or(json!(1));
    let p = req.get("params").cloned().unwrap_or(json!([]));
    let n = {
        let mut c = s.calls.lock().unwrap();
        let e = c.entry(method.clone()).or_insert(0);
        *e += 1;
        *e
    };
    if method == "getMultipleAccounts" && s.fail_accounts_call.load(Ordering::SeqCst) == n {
        return Json(json!({"jsonrpc": "2.0", "id": id,
            "error": {"code": -32000, "message": "temporary account read failure"}}));
    }
    let all = s.sigs.lock().unwrap().clone();
    let result = match method.as_str() {
        "getSignaturesForAddress" => {
            let cfg = p.get(1).cloned().unwrap_or(json!({}));
            let limit = cfg.get("limit").and_then(|x| x.as_u64()).unwrap_or(1000) as usize;
            let before = cfg.get("before").and_then(|x| x.as_str());
            let until = cfg.get("until").and_then(|x| x.as_str());
            let mut newest: Vec<&(String, u64)> = all.iter().rev().collect();
            if let Some(b) = before {
                let i = newest
                    .iter()
                    .position(|(s, _)| s == b)
                    .map_or(newest.len(), |i| i + 1);
                newest = newest.split_off(i);
            }
            if let Some(u) = until {
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
        "getTransaction" => {
            let d = s.tx_delay_us.load(Ordering::SeqCst);
            if d > 0 {
                tokio::time::sleep(Duration::from_micros(d)).await;
            }
            let sig = p.get(0).and_then(|x| x.as_str()).unwrap_or("");
            match all.iter().find(|(s, _)| s == sig) {
                None => Value::Null,
                Some((_, slot)) => {
                    let wire = s
                        .wires
                        .lock()
                        .unwrap()
                        .get(sig)
                        .cloned()
                        .unwrap_or_default();
                    json!({"slot": slot, "blockTime": 7,
                        "transaction": [base64::engine::general_purpose::STANDARD.encode(wire), "base64"],
                        "meta": {"err": null, "fee": 5000, "logMessages": [], "computeUnitsConsumed": 9}})
                }
            }
        }
        "getMultipleAccounts" => {
            let keys = p
                .get(0)
                .and_then(|x| x.as_array())
                .cloned()
                .unwrap_or_default();
            let account = json!({"data": ["", "base64"], "lamports": 1_000_000,
                "owner": fclient::addr::system_program().to_string(), "executable": false});
            json!({"context": {"slot": 1u64 << 40}, "value": keys.iter().map(|_| account.clone()).collect::<Vec<_>>()})
        }
        "getAccountInfo" => {
            let slot = s.clock_slot.fetch_add(1, Ordering::SeqCst);
            let ck = fclient::ports::ClockSysvar {
                slot,
                epoch_start_timestamp: 0,
                epoch: 0,
                leader_schedule_epoch: 0,
                unix_timestamp: 1_800_000_000 + slot as i64,
            };
            let data = base64::engine::general_purpose::STANDARD.encode(ck.encode());
            json!({"context": {"slot": slot}, "value": {"data": [data, "base64"], "lamports": 1,
                "owner": fclient::addr::system_program().to_string(), "executable": false}})
        }
        _ => Value::Null,
    };
    Json(json!({"jsonrpc": "2.0", "id": id, "result": result}))
}

/// Serves `c` on `127.0.0.1:0`; returns its URL.
pub async fn start(c: Chain) -> String {
    let l = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let addr = l.local_addr().unwrap();
    let app = Router::new().route("/", post(rpc)).with_state(c);
    tokio::spawn(async move {
        let _ = axum::serve(l, app).await;
    });
    format!("http://{addr}")
}
