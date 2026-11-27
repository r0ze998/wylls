//! JSON-RPC client and the `ChainPort` over it.
//!
//! `RpcPort::localnet(url, program)` also reads the ordered transaction feed
//! (`frontier_feed`); against a public RPC `feed` needs the
//! `getSignaturesForAddress` + `getTransaction` pager, `findex`'s `RpcPoll`,
//! so it reports `Unsupported` here: the herald (`--source rpc`) and the
//! keeper (`feed = "rpc"`, `keeper::clusterfeed`) wrap this port with it.
//! An `https://` URL is served through `crate::https` (B1).

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use base64::Engine;
use serde_json::{json, Value};
use solana_address::Address;
use solana_hash::Hash;

use crate::ports::{
    Account, ChainPort, ClockSysvar, Cursor, FeedScan, PortError, PortResult, Signature, SimResult,
    Status, TxRecord,
};

const B64: base64::engine::GeneralPurpose = base64::engine::general_purpose::STANDARD;

/// `maxSupportedTransactionVersion` of every transaction read (B5,
/// measured 2026-11-21: devnet carries **version 1** transactions, 15 of
/// the 33 in slot 523,600,000; with 0 the node refuses each one with
/// -32015, so a single v1 transaction that names the program stalled every
/// `getSignaturesForAddress` + `getTransaction` poller on it). The bytes of
/// a v0/v1 transaction are kept as served; `crate::tx::from_wire` decodes
/// legacy ones only, so to the decoders a v1 record is as undecodable as a
/// v0 one already was (it no longer stops the read).
pub const MAX_TX_VERSION: u8 = 1;

pub struct RpcClient {
    pub url: String,
    id: AtomicU64,
    max_response_bytes: Option<usize>,
    /// Options of an `https://` URL's POSTs (trust anchor, limits).
    pub https: crate::https::PostOpts,
    /// Spacing shared with other clients of the same endpoint (a public
    /// RPC's per-IP limit), `None`: unpaced (loopback).
    pub pacer: Option<Arc<Pacer>>,
    /// How often one call is tried again after an HTTP 429/503 (each try
    /// waits the pacer's penalty, at least the server's `Retry-After`).
    /// 0 (default): the 429 is the caller's error. [`RpcClient::with_pacer`]
    /// sets [`PUBLIC_RETRIES`] for an `https://` URL.
    pub retries: u32,
}

/// Retries of a paced `https://` client (B5, measured 2026-11-21: the
/// public devnet RPC allows about 10 calls of one method per 10 s per IP
/// and answers the 11th with 429 and `Retry-After: 10`; without a retry a
/// one-shot reader such as the verifier stopped at the 11th transaction).
pub const PUBLIC_RETRIES: u32 = 6;

/// Request spacing for one public RPC endpoint, shared by every client that
/// reads it from this process (devnet-readiness B2: the public devnet RPC
/// is rate-limited per IP). Each call waits for its turn (`min_gap` after
/// the previous one); an HTTP 429 or 503 pushes every client back by a
/// penalty that doubles up to `max_penalty` and clears on the next success.
#[derive(Debug)]
pub struct Pacer {
    pub min_gap: Duration,
    pub max_penalty: Duration,
    state: tokio::sync::Mutex<PacerState>,
    /// HTTP requests made through this pacer (each retry counts).
    pub calls: AtomicU64,
    /// Of those, answered 429/503.
    pub throttles: AtomicU64,
}

#[derive(Debug)]
struct PacerState {
    next: Option<tokio::time::Instant>,
    penalty: Duration,
}

impl Pacer {
    pub fn new(min_gap: Duration, max_penalty: Duration) -> Arc<Pacer> {
        Arc::new(Pacer {
            min_gap,
            max_penalty: max_penalty.max(Duration::from_millis(1)),
            state: tokio::sync::Mutex::new(PacerState {
                next: None,
                penalty: Duration::ZERO,
            }),
            calls: AtomicU64::new(0),
            throttles: AtomicU64::new(0),
        })
    }

    /// Waits for this caller's turn (FIFO: the lock is held across the
    /// wait, so callers go one `min_gap` apart in arrival order).
    pub async fn turn(&self) {
        let mut st = self.state.lock().await;
        let now = tokio::time::Instant::now();
        if let Some(n) = st.next.filter(|n| *n > now) {
            tokio::time::sleep_until(n).await;
        }
        st.next = Some(tokio::time::Instant::now() + self.min_gap);
    }

    /// The endpoint said "too many requests": everyone waits a penalty.
    pub async fn throttled(&self) {
        self.throttled_for(None).await
    }

    /// [`Pacer::throttled`], waiting at least `retry_after` (the server's
    /// `Retry-After`, capped by `max_penalty`).
    pub async fn throttled_for(&self, retry_after: Option<Duration>) {
        let mut st = self.state.lock().await;
        st.penalty = (st.penalty * 2)
            .max(Duration::from_millis(500))
            .max(retry_after.unwrap_or_default())
            .min(self.max_penalty);
        // Jittered (verify-pr123): up to a quarter more, so clients of one
        // endpoint in other processes do not retry in lockstep.
        let until = tokio::time::Instant::now() + st.penalty + jitter(st.penalty / 4);
        st.next = Some(st.next.map_or(until, |n| n.max(until)));
    }

    /// A call succeeded: the penalty starts over.
    pub async fn ok(&self) {
        self.state.lock().await.penalty = Duration::ZERO;
    }

    /// The current penalty (tests, status).
    pub async fn penalty(&self) -> Duration {
        self.state.lock().await.penalty
    }
}

/// A random duration in `[0, max]` (no RNG dependency: the std hasher's
/// per-process random keys over the clock).
fn jitter(max: Duration) -> Duration {
    use std::hash::{BuildHasher, Hasher};
    if max.is_zero() {
        return Duration::ZERO;
    }
    let mut h = std::collections::hash_map::RandomState::new().build_hasher();
    h.write_u128(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_nanos()),
    );
    let ns = max.as_nanos().min(u64::MAX as u128) as u64;
    Duration::from_nanos(h.finish() % (ns + 1))
}

impl RpcClient {
    pub fn new(url: impl Into<String>) -> RpcClient {
        RpcClient {
            url: url.into(),
            id: AtomicU64::new(1),
            max_response_bytes: None,
            https: crate::https::PostOpts::default(),
            pacer: None,
            retries: 0,
        }
    }

    /// Spaces this client's calls through `pacer` (shared per endpoint);
    /// an `https://` client also retries a 429/503 [`PUBLIC_RETRIES`]
    /// times (loopback clients keep 0: their tests see the 429).
    pub fn with_pacer(mut self, pacer: Arc<Pacer>) -> RpcClient {
        self.pacer = Some(pacer);
        if self.url.starts_with("https://") {
            self.retries = PUBLIC_RETRIES;
        }
        self
    }

    /// Sets [`RpcClient::retries`].
    pub fn with_retries(mut self, n: u32) -> RpcClient {
        self.retries = n;
        self
    }

    /// Trusts `ca` (a PEM file) instead of curl's store for `https://`
    /// (loopback tests with their own CA).
    pub fn with_cacert(mut self, ca: impl Into<std::path::PathBuf>) -> RpcClient {
        self.https.cacert = Some(ca.into());
        self
    }

    /// Opt-in cap on each response's HTTP wire bytes (headers and body).
    /// Replies must also have a matching JSON-RPC 2.0 response envelope.
    /// Construction stores configuration only; it performs no I/O.
    pub fn new_with_response_limit(url: impl Into<String>, max_bytes: usize) -> RpcClient {
        RpcClient {
            max_response_bytes: Some(max_bytes),
            ..RpcClient::new(url)
        }
    }

    pub async fn call(&self, method: &str, params: Value) -> PortResult<Value> {
        let id = self.id.fetch_add(1, Ordering::Relaxed);
        let req = json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params});
        let mut tries = 0u32;
        let resp = loop {
            if let Some(p) = &self.pacer {
                p.turn().await;
            }
            let resp =
                crate::http::post_json_with(&self.url, &req, self.max_response_bytes, &self.https)
                    .await?;
            let busy = matches!(resp.status, 429 | 503);
            let hint = resp
                .header("retry-after")
                .and_then(crate::https::retry_after_secs)
                .map(Duration::from_secs);
            if let Some(p) = &self.pacer {
                p.calls.fetch_add(1, Ordering::Relaxed);
                if busy {
                    p.throttles.fetch_add(1, Ordering::Relaxed);
                }
            }
            match &self.pacer {
                Some(p) if busy => p.throttled_for(hint).await,
                Some(p) if resp.status == 200 => p.ok().await,
                _ => {}
            }
            if !busy || tries >= self.retries {
                break resp;
            }
            tries += 1;
            if self.pacer.is_none() {
                // Unpaced: wait here (the server's hint, else doubling).
                let back = Duration::from_millis(500 << tries.min(6));
                let wait = hint.unwrap_or(back).min(Duration::from_secs(30));
                tokio::time::sleep(wait + jitter(wait / 4)).await;
            }
        };
        if resp.status != 200 {
            return Err(PortError::Http(resp.status));
        }
        let v: Value =
            serde_json::from_slice(&resp.body).map_err(|e| PortError::Decode(e.to_string()))?;
        if self.max_response_bytes.is_some() {
            return parse_bounded_response(&v, id);
        }
        if let Some(e) = v.get("error") {
            return Err(PortError::Rpc {
                code: e.get("code").and_then(|c| c.as_i64()).unwrap_or(0),
                message: e
                    .get("message")
                    .and_then(|m| m.as_str())
                    .unwrap_or("")
                    .into(),
            });
        }
        v.get("result")
            .cloned()
            .ok_or_else(|| PortError::Decode("no result".into()))
    }

    pub async fn get_slot(&self) -> PortResult<u64> {
        self.call("getSlot", json!([]))
            .await?
            .as_u64()
            .ok_or_else(|| PortError::Decode("slot".into()))
    }

    pub async fn get_balance(&self, k: &Address) -> PortResult<u64> {
        let v = self.call("getBalance", json!([k.to_string()])).await?;
        v.get("value")
            .and_then(|x| x.as_u64())
            .ok_or_else(|| PortError::Decode("balance".into()))
    }

    pub async fn request_airdrop(&self, k: &Address, lamports: u64) -> PortResult<Signature> {
        let v = self
            .call("requestAirdrop", json!([k.to_string(), lamports]))
            .await?;
        parse_sig(&v)
    }

    pub async fn get_multiple_accounts(
        &self,
        keys: &[Address],
        min_slot: u64,
    ) -> PortResult<Vec<Option<Account>>> {
        self.get_multiple_accounts_at(keys, min_slot, "confirmed")
            .await
    }

    /// Account post-state for archival ingestion. Live chain reads continue
    /// to use `confirmed` through `get_multiple_accounts`.
    pub async fn get_finalized_multiple_accounts(
        &self,
        keys: &[Address],
        min_slot: u64,
    ) -> PortResult<Vec<Option<Account>>> {
        self.get_multiple_accounts_at(keys, min_slot, "finalized")
            .await
    }

    async fn get_multiple_accounts_at(
        &self,
        keys: &[Address],
        min_slot: u64,
        commitment: &str,
    ) -> PortResult<Vec<Option<Account>>> {
        let mut out = Vec::with_capacity(keys.len());
        for chunk in keys.chunks(100) {
            let ks: Vec<String> = chunk.iter().map(|k| k.to_string()).collect();
            let mut cfg = json!({"encoding": "base64", "commitment": commitment});
            if min_slot > 0 {
                cfg["minContextSlot"] = json!(min_slot);
            }
            let v = self.call("getMultipleAccounts", json!([ks, cfg])).await?;
            let arr = v
                .get("value")
                .and_then(|x| x.as_array())
                .ok_or_else(|| PortError::Decode("value".into()))?;
            // One entry per key asked, in order: callers index the answer by
            // the key's position, so a short (or long) answer from a hostile
            // or broken RPC is refused here instead of panicking them.
            if arr.len() != chunk.len() {
                return Err(PortError::Decode(format!(
                    "getMultipleAccounts: {} values for {} keys",
                    arr.len(),
                    chunk.len()
                )));
            }
            for a in arr {
                out.push(parse_account(a)?);
            }
        }
        Ok(out)
    }
}

/// Bind an opt-in bounded response to its request before exposing its result.
/// Legacy unlimited clients deliberately keep their existing parsing behavior.
fn parse_bounded_response(v: &Value, expected_id: u64) -> PortResult<Value> {
    let response = v
        .as_object()
        .ok_or_else(|| PortError::Decode("RPC response must be an object".into()))?;
    if response.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
        return Err(PortError::Decode("RPC response jsonrpc must be 2.0".into()));
    }
    if response.get("id").and_then(Value::as_u64) != Some(expected_id) {
        return Err(PortError::Decode(
            "RPC response id must match request".into(),
        ));
    }
    match (response.get("result"), response.get("error")) {
        (Some(result), None) => Ok(result.clone()),
        (None, Some(error)) => {
            let error = error
                .as_object()
                .ok_or_else(|| PortError::Decode("RPC error must be an object".into()))?;
            let code = error
                .get("code")
                .and_then(Value::as_i64)
                .ok_or_else(|| PortError::Decode("RPC error code must be an i64".into()))?;
            let message = error
                .get("message")
                .and_then(Value::as_str)
                .ok_or_else(|| PortError::Decode("RPC error message must be a string".into()))?;
            Err(PortError::Rpc {
                code,
                message: message.into(),
            })
        }
        _ => Err(PortError::Decode(
            "RPC response must contain exactly one of result or error".into(),
        )),
    }
}

/// One row of `getSignaturesForAddress` (newest first on the wire).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SigInfo {
    pub signature: Signature,
    pub slot: u64,
    pub failed: bool,
    pub block_time: Option<i64>,
}

impl RpcClient {
    /// `getSignaturesForAddress` at confirmed commitment, newest first.
    pub async fn get_signatures_for_address(
        &self,
        address: &Address,
        before: Option<&Signature>,
        until: Option<&Signature>,
        limit: usize,
    ) -> PortResult<Vec<SigInfo>> {
        self.get_signatures_for_address_at(address, before, until, limit, "confirmed")
            .await
    }

    /// Finalized signatures for `findex`'s durable RpcPoll cursor. A
    /// confirmed fork must not enter an append-only archive.
    pub async fn get_finalized_signatures_for_address(
        &self,
        address: &Address,
        before: Option<&Signature>,
        until: Option<&Signature>,
        limit: usize,
    ) -> PortResult<Vec<SigInfo>> {
        self.get_signatures_for_address_at(address, before, until, limit, "finalized")
            .await
    }

    async fn get_signatures_for_address_at(
        &self,
        address: &Address,
        before: Option<&Signature>,
        until: Option<&Signature>,
        limit: usize,
        commitment: &str,
    ) -> PortResult<Vec<SigInfo>> {
        let mut cfg = json!({"limit": limit.clamp(1, 1_000), "commitment": commitment});
        if let Some(b) = before {
            cfg["before"] = json!(b.to_string());
        }
        if let Some(u) = until {
            cfg["until"] = json!(u.to_string());
        }
        let v = self
            .call("getSignaturesForAddress", json!([address.to_string(), cfg]))
            .await?;
        v.as_array()
            .ok_or_else(|| PortError::Decode("signatures".into()))?
            .iter()
            .map(|r| {
                Ok(SigInfo {
                    signature: r
                        .get("signature")
                        .ok_or_else(|| PortError::Decode("signature".into()))
                        .and_then(parse_sig)?,
                    slot: r.get("slot").and_then(|x| x.as_u64()).unwrap_or(0),
                    failed: r.get("err").is_some_and(|e| !e.is_null()),
                    block_time: r.get("blockTime").and_then(|x| x.as_i64()),
                })
            })
            .collect()
    }

    /// `getTransaction(sig, base64)` at confirmed commitment as a [`TxRecord`]
    /// with `seq = 0` (the caller numbers its feed) and no post-state.
    pub async fn get_transaction(&self, sig: &Signature) -> PortResult<Option<TxRecord>> {
        self.get_transaction_at(sig, "confirmed").await
    }

    /// Finalized transaction bytes and logs for `findex`'s archive.
    pub async fn get_finalized_transaction(&self, sig: &Signature) -> PortResult<Option<TxRecord>> {
        self.get_transaction_at(sig, "finalized").await
    }

    async fn get_transaction_at(
        &self,
        sig: &Signature,
        commitment: &str,
    ) -> PortResult<Option<TxRecord>> {
        let v = self
            .call(
                "getTransaction",
                json!([sig.to_string(), {"encoding": "base64", "commitment": commitment, "maxSupportedTransactionVersion": MAX_TX_VERSION}]),
            )
            .await?;
        if v.is_null() {
            return Ok(None);
        }
        parse_transaction(sig, &v).map(Some)
    }
}

/// The balances a `getTransaction` result shows (`meta.preBalances`,
/// `meta.postBalances`: lamports per message key, in message key order),
/// which a public RPC serves although it serves no post-state. `None` when
/// either is absent or not a list of integers of the same length.
pub fn parse_balances(v: &Value) -> Option<(Vec<u64>, Vec<u64>)> {
    let meta = v.get("meta")?;
    let list = |k: &str| -> Option<Vec<u64>> {
        meta.get(k)?
            .as_array()?
            .iter()
            .map(|x| x.as_u64())
            .collect()
    };
    let (pre, post) = (list("preBalances")?, list("postBalances")?);
    (pre.len() == post.len()).then_some((pre, post))
}

impl RpcClient {
    /// `getTransaction(sig)` at `commitment` as its balances only
    /// ([`parse_balances`]); `Ok(None)`: not served, or served without them.
    pub async fn get_transaction_balances(
        &self,
        sig: &Signature,
        commitment: &str,
    ) -> PortResult<Option<(Vec<u64>, Vec<u64>)>> {
        let v = self
            .call(
                "getTransaction",
                json!([sig.to_string(), {"encoding": "base64", "commitment": commitment, "maxSupportedTransactionVersion": MAX_TX_VERSION}]),
            )
            .await?;
        Ok(parse_balances(&v))
    }
}

/// Parses a `getTransaction` result (base64 encoding).
pub fn parse_transaction(sig: &Signature, v: &Value) -> PortResult<TxRecord> {
    let d = |m: &str| PortError::Decode(format!("transaction {m}"));
    let meta = v.get("meta").ok_or_else(|| d("meta"))?;
    let err = meta.get("err").cloned().unwrap_or(Value::Null);
    let tx = v
        .get("transaction")
        .and_then(|t| t.get(0))
        .and_then(|t| t.as_str())
        .ok_or_else(|| d("bytes"))?;
    Ok(TxRecord {
        seq: 0,
        slot: v
            .get("slot")
            .and_then(|x| x.as_u64())
            .ok_or_else(|| d("slot"))?,
        signature: *sig,
        block_time: v.get("blockTime").and_then(|x| x.as_i64()).unwrap_or(0),
        tx: B64
            .decode(tx)
            .map_err(|e| PortError::Decode(e.to_string()))?,
        logs: meta
            .get("logMessages")
            .and_then(|x| x.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|l| l.as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default(),
        code: code_of(&err),
        err: err_string(&err),
        units: meta
            .get("computeUnitsConsumed")
            .and_then(|x| x.as_u64())
            .unwrap_or(0),
        fee: meta.get("fee").and_then(|x| x.as_u64()).unwrap_or(0),
        post: vec![],
        loaded: crate::vtx::loaded_from_meta(meta).map_err(PortError::Decode)?,
    })
}

pub fn parse_sig(v: &Value) -> PortResult<Signature> {
    v.as_str()
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| PortError::Decode("signature".into()))
}

/// `{data: [b64, "base64"], lamports, owner, executable}` or null.
pub fn parse_account(a: &Value) -> PortResult<Option<Account>> {
    if a.is_null() {
        return Ok(None);
    }
    let data = a
        .get("data")
        .and_then(|d| d.get(0))
        .and_then(|d| d.as_str())
        .map(|s| B64.decode(s))
        .transpose()
        .map_err(|e| PortError::Decode(e.to_string()))?
        .unwrap_or_default();
    Ok(Some(Account {
        lamports: a
            .get("lamports")
            .and_then(|x| x.as_u64())
            .ok_or_else(|| PortError::Decode("lamports".into()))?,
        data,
        owner: a
            .get("owner")
            .and_then(|x| x.as_str())
            .and_then(|s| s.parse().ok())
            .ok_or_else(|| PortError::Decode("owner".into()))?,
        executable: a
            .get("executable")
            .and_then(|x| x.as_bool())
            .unwrap_or(false),
    }))
}

/// The account JSON a JSON-RPC server returns.
pub fn account_json(a: &Account) -> Value {
    json!({
        "data": [B64.encode(&a.data), "base64"],
        "executable": a.executable,
        "lamports": a.lamports,
        "owner": a.owner.to_string(),
        "rentEpoch": u64::MAX,
        "space": a.data.len(),
    })
}

/// A custom program error code out of an RPC `err` value
/// (`{"InstructionError":[i,{"Custom":n}]}`) or its string form.
pub fn code_of(err: &Value) -> Option<u32> {
    if let Some(ie) = err.get("InstructionError").and_then(|x| x.as_array()) {
        return ie.get(1)?.get("Custom")?.as_u64().map(|c| c as u32);
    }
    err.as_str().and_then(crate::ports::custom_code)
}

fn err_string(err: &Value) -> Option<String> {
    (!err.is_null()).then(|| err.to_string())
}

/// `ChainPort::statuses` is used to end durable writes. A confirmed fork can
/// still disappear, so only a status explicitly marked finalized is a result.
fn parse_finalized_status(s: &Value) -> Option<Status> {
    if s.get("confirmationStatus").and_then(Value::as_str) != Some("finalized") {
        return None;
    }
    let slot = s.get("slot").and_then(Value::as_u64)?;
    let err = s.get("err")?;
    if !(err.is_null() || err.is_string() || err.is_object()) {
        return None;
    }
    Some(Status {
        slot,
        code: code_of(err),
        err: err_string(err),
    })
}

/// Preserve the block-height expiry bound from `getLatestBlockhash`.
/// A missing bound is not height zero: callers must not journal a signed
/// transaction without knowing the bound needed for later reconciliation.
fn parse_latest_blockhash_result(v: &Value) -> PortResult<(Hash, u64)> {
    let val = v
        .get("value")
        .ok_or_else(|| PortError::Decode("value".into()))?;
    let hash = val
        .get("blockhash")
        .and_then(Value::as_str)
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| PortError::Decode("blockhash".into()))?;
    let last_valid_block_height = val
        .get("lastValidBlockHeight")
        .and_then(Value::as_u64)
        .filter(|height| *height > 0)
        .ok_or_else(|| PortError::Decode("lastValidBlockHeight".into()))?;
    Ok((hash, last_valid_block_height))
}

/// Signatures per `getSignatureStatuses` call that reads only the node's
/// status cache (the RPC's own cap is 256; api.devnet answers 256 in
/// ≈ 0.3 s).
pub const STATUS_CHUNK: usize = 256;
/// Signatures per `getSignatureStatuses` call with
/// `searchTransactionHistory` (keeper-landing-investigate, measured on
/// api.devnet 2026-11-26: ≈ 0.18 s per signature — 16 in 4.4 s, 64 in
/// 13.6 s, 256 in 45 s. One 256-signature history call is past the 20 s
/// POST deadline, so every poll failed and keeper A never saw a landing).
pub const HISTORY_CHUNK: usize = 32;
/// At most this many signatures go to the history search in one
/// [`ChainPort::statuses`] call (≈ 6 s on api.devnet); the rest wait for
/// a later call ([`RpcPort::statuses`] rotates through them).
pub const HISTORY_PER_CALL: usize = 32;
/// A history search runs at most once per this long on a remote RPC
/// ([`RpcPort::history_every`]): re-sends that never landed stay unknown
/// forever, and the keeper polls every tick (twice: writes and orphans).
/// 1,000 unknown signatures are all re-read in ≈ 10 min.
pub const HISTORY_EVERY: Duration = Duration::from_secs(20);

/// `ChainPort` over JSON-RPC.
pub struct RpcPort {
    pub rpc: RpcClient,
    pub program: Address,
    /// The server is `frontier-localnet` (has `frontier_feed`).
    pub localnet: bool,
    /// Rotation of the capped history search ([`HISTORY_PER_CALL`]).
    history_next: std::sync::atomic::AtomicUsize,
    /// Least time between two history searches ([`HISTORY_EVERY`] for a
    /// remote URL, zero on loopback: a local node answers at once).
    pub history_every: Duration,
    history_last: std::sync::Mutex<Option<std::time::Instant>>,
}

impl RpcPort {
    pub fn new(url: impl Into<String>, program: Address) -> RpcPort {
        RpcPort {
            rpc: RpcClient::new(url),
            program,
            localnet: false,
            history_next: Default::default(),
            history_every: Duration::ZERO,
            history_last: Default::default(),
        }
        .remote_history_gate()
    }

    /// An RPC port with a per-response HTTP wire-byte cap and no localnet feed.
    /// Construction stores configuration only; it performs no I/O.
    pub fn new_with_response_limit(
        url: impl Into<String>,
        program: Address,
        max_bytes: usize,
    ) -> RpcPort {
        RpcPort {
            rpc: RpcClient::new_with_response_limit(url, max_bytes),
            program,
            localnet: false,
            history_next: Default::default(),
            history_every: Duration::ZERO,
            history_last: Default::default(),
        }
        .remote_history_gate()
    }

    /// [`HISTORY_EVERY`] unless the URL is loopback.
    fn remote_history_gate(mut self) -> RpcPort {
        if !crate::http::is_loopback(&self.rpc.url) {
            self.history_every = HISTORY_EVERY;
        }
        self
    }

    /// Sets [`RpcPort::history_every`].
    pub fn with_history_every(mut self, every: Duration) -> RpcPort {
        self.history_every = every;
        self
    }

    /// Whether a history search may run now (and, if so, marks it run).
    fn history_due(&self) -> bool {
        let mut last = self.history_last.lock().unwrap_or_else(|e| e.into_inner());
        let now = std::time::Instant::now();
        if last.is_some_and(|t| now.duration_since(t) < self.history_every) {
            return false;
        }
        *last = Some(now);
        true
    }

    /// One `getSignatureStatuses` call: the raw value per signature asked.
    async fn statuses_call(&self, chunk: &[Signature], history: bool) -> PortResult<Vec<Value>> {
        let ss: Vec<String> = chunk.iter().map(|s| s.to_string()).collect();
        let params = if history {
            json!([ss, {"searchTransactionHistory": true}])
        } else {
            json!([ss])
        };
        let v = self.rpc.call("getSignatureStatuses", params).await?;
        let arr = v
            .get("value")
            .and_then(|x| x.as_array())
            .ok_or_else(|| PortError::Decode("value".into()))?;
        // One status per signature asked (see get_multiple_accounts_at).
        if arr.len() != chunk.len() {
            return Err(PortError::Decode(format!(
                "getSignatureStatuses: {} values for {} signatures",
                arr.len(),
                chunk.len()
            )));
        }
        Ok(arr.clone())
    }

    pub fn localnet(url: impl Into<String>, program: Address) -> RpcPort {
        RpcPort {
            rpc: RpcClient::new(url),
            program,
            localnet: true,
            history_next: Default::default(),
            history_every: Duration::ZERO,
            history_last: Default::default(),
        }
        .remote_history_gate()
    }
}

/// Parses a `frontier_feed` record.
pub fn parse_feed_record(r: &Value) -> PortResult<TxRecord> {
    let d = |m: &str| PortError::Decode(format!("feed {m}"));
    let err = r.get("err").cloned().unwrap_or(Value::Null);
    Ok(TxRecord {
        seq: r
            .get("seq")
            .and_then(|x| x.as_u64())
            .ok_or_else(|| d("seq"))?,
        slot: r
            .get("slot")
            .and_then(|x| x.as_u64())
            .ok_or_else(|| d("slot"))?,
        signature: r
            .get("signature")
            .ok_or_else(|| d("signature"))
            .and_then(parse_sig)?,
        block_time: r.get("blockTime").and_then(|x| x.as_i64()).unwrap_or(0),
        tx: B64
            .decode(
                r.get("tx")
                    .and_then(|x| x.as_str())
                    .ok_or_else(|| d("tx"))?,
            )
            .map_err(|e| PortError::Decode(e.to_string()))?,
        logs: r
            .get("logs")
            .and_then(|x| x.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|l| l.as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default(),
        code: code_of(&err),
        err: err_string(&err),
        units: r.get("units").and_then(|x| x.as_u64()).unwrap_or(0),
        fee: r.get("fee").and_then(|x| x.as_u64()).unwrap_or(0),
        post: r
            .get("post")
            .and_then(|x| x.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|p| {
                        let k: Address = p.get("key")?.as_str()?.parse().ok()?;
                        Some((
                            k,
                            parse_account(p.get("account").unwrap_or(&Value::Null)).ok()?,
                        ))
                    })
                    .collect()
            })
            .unwrap_or_default(),
        // herald-v0v1-decode: the node's `loaded` (a v0 transaction's
        // lookup addresses); absent = none.
        loaded: crate::vtx::loaded_from_meta(
            &json!({"loadedAddresses": r.get("loaded").cloned().unwrap_or(Value::Null)}),
        )
        .map_err(PortError::Decode)?,
    })
}

impl ChainPort for RpcPort {
    async fn clock(&self) -> PortResult<ClockSysvar> {
        let v = self
            .rpc
            .call(
                "getAccountInfo",
                json!([crate::addr::clock_sysvar().to_string(), {"encoding": "base64"}]),
            )
            .await?;
        let a = parse_account(v.get("value").unwrap_or(&Value::Null))?
            .ok_or_else(|| PortError::Decode("no clock".into()))?;
        ClockSysvar::decode(&a.data).ok_or_else(|| PortError::Decode("clock bytes".into()))
    }

    async fn accounts(&self, keys: &[Address], min_slot: u64) -> PortResult<Vec<Option<Account>>> {
        self.rpc.get_multiple_accounts(keys, min_slot).await
    }

    async fn simulate(&self, tx: &[u8]) -> PortResult<SimResult> {
        let t = crate::tx::from_wire(tx).map_err(PortError::Decode)?;
        let keys: Vec<String> = t
            .message
            .account_keys
            .iter()
            .map(|k| k.to_string())
            .collect();
        let cfg = json!({
            "encoding": "base64", "sigVerify": true, "replaceRecentBlockhash": false, "commitment": "confirmed",
            "accounts": {"encoding": "base64", "addresses": keys},
        });
        let v = self
            .rpc
            .call("simulateTransaction", json!([B64.encode(tx), cfg]))
            .await?;
        let v = v
            .get("value")
            .ok_or_else(|| PortError::Decode("value".into()))?;
        let err = v.get("err").cloned().unwrap_or(Value::Null);
        let accts = v
            .get("accounts")
            .and_then(|a| a.as_array())
            .cloned()
            .unwrap_or_default();
        Ok(SimResult {
            code: code_of(&err),
            err: err_string(&err),
            logs: v
                .get("logs")
                .and_then(|x| x.as_array())
                .map(|a| {
                    a.iter()
                        .filter_map(|l| l.as_str().map(String::from))
                        .collect()
                })
                .unwrap_or_default(),
            units: v.get("unitsConsumed").and_then(|x| x.as_u64()).unwrap_or(0),
            accounts: t
                .message
                .account_keys
                .iter()
                .enumerate()
                .map(|(i, k)| {
                    (
                        *k,
                        accts.get(i).and_then(|a| parse_account(a).ok()).flatten(),
                    )
                })
                .collect(),
        })
    }

    async fn send(&self, tx: &[u8]) -> PortResult<Signature> {
        let cfg = json!({"encoding": "base64", "skipPreflight": true, "maxRetries": 0});
        let v = self
            .rpc
            .call("sendTransaction", json!([B64.encode(tx), cfg]))
            .await?;
        parse_sig(&v)
    }

    /// Two passes (keeper-landing-investigate). First the status cache for
    /// every signature, [`STATUS_CHUNK`] per call: a version that landed
    /// since the last poll is there. Then `searchTransactionHistory` only
    /// for signatures the cache did not know, at most [`HISTORY_PER_CALL`]
    /// per call in [`HISTORY_CHUNK`]s, rotating, at most once per
    /// [`RpcPort::history_every`], so a long unknown list
    /// (re-sends whose blockhash expired unlanded) cannot push one call past
    /// the POST deadline. A chunk that fails leaves its signatures `None`
    /// (unknown: the caller keeps them pending) instead of discarding the
    /// answers of every other chunk; only when no status-cache chunk was
    /// answered at all is the call an error.
    async fn statuses(&self, sigs: &[Signature]) -> PortResult<Vec<Option<Status>>> {
        Ok(self.statuses_absent(sigs).await?.0)
    }

    /// [`ChainPort::statuses`] (above) with the history search's `null`
    /// answers marked: only a signature the history search itself answered
    /// `null` for is `absent` (verify-pr282). A status-cache `null` is not:
    /// the cache forgets a landed signature ≈ 300 blocks after its blockhash.
    async fn statuses_absent(
        &self,
        sigs: &[Signature],
    ) -> PortResult<(Vec<Option<Status>>, Vec<bool>)> {
        let mut out: Vec<Option<Status>> = vec![None; sigs.len()];
        let mut absent = vec![false; sigs.len()];
        // Signatures the status cache answered `null` for (unknown to it).
        let mut unseen: Vec<usize> = vec![];
        let mut first_err = None;
        let mut answered = false;
        for (c, chunk) in sigs.chunks(STATUS_CHUNK).enumerate() {
            match self.statuses_call(chunk, false).await {
                Ok(arr) => {
                    answered = true;
                    for (i, s) in arr.iter().enumerate() {
                        let at = c * STATUS_CHUNK + i;
                        if s.is_null() {
                            unseen.push(at);
                        } else {
                            out[at] = parse_finalized_status(s);
                        }
                    }
                }
                Err(e) => {
                    first_err.get_or_insert(e);
                }
            }
        }
        if !answered {
            if let Some(e) = first_err {
                return Err(e);
            }
        }
        if !unseen.is_empty() && self.history_due() {
            let n = unseen.len();
            let take = n.min(HISTORY_PER_CALL);
            let start = self
                .history_next
                .fetch_add(take, std::sync::atomic::Ordering::Relaxed)
                % n;
            let pick: Vec<usize> = (0..take).map(|k| unseen[(start + k) % n]).collect();
            for chunk in pick.chunks(HISTORY_CHUNK) {
                let ss: Vec<Signature> = chunk.iter().map(|&i| sigs[i]).collect();
                // A failed history chunk stays unknown; the next call tries others.
                if let Ok(arr) = self.statuses_call(&ss, true).await {
                    for (&i, s) in chunk.iter().zip(arr.iter()) {
                        absent[i] = s.is_null();
                        out[i] = parse_finalized_status(s);
                    }
                }
            }
        }
        Ok((out, absent))
    }

    async fn feed(&self, after: Cursor) -> PortResult<Vec<TxRecord>> {
        if !self.localnet {
            return Err(PortError::Unsupported(
                "feed over a public RPC is findex's RpcPoll (W2-F)",
            ));
        }
        let v = self
            .rpc
            .call(
                "frontier_feed",
                json!([after.0, 1_000, self.program.to_string()]),
            )
            .await?;
        v.as_array()
            .ok_or_else(|| PortError::Decode("feed".into()))?
            .iter()
            .map(parse_feed_record)
            .collect()
    }

    async fn feed_scan(&self, after: Cursor) -> PortResult<(Vec<TxRecord>, Option<FeedScan>)> {
        if !self.localnet {
            return Err(PortError::Unsupported(
                "feed over a public RPC is findex's RpcPoll (W2-F)",
            ));
        }
        let v = self
            .rpc
            .call(
                "frontier_feed",
                json!([after.0, 1_000, self.program.to_string(), {"scan": true}]),
            )
            .await?;
        // A node from before the scan answers with the array: no extent.
        if let Some(a) = v.as_array() {
            return Ok((
                a.iter().map(parse_feed_record).collect::<PortResult<_>>()?,
                None,
            ));
        }
        let d = |m: &str| PortError::Decode(format!("feed scan {m}"));
        let txs = v
            .get("txs")
            .and_then(Value::as_array)
            .ok_or_else(|| d("txs"))?
            .iter()
            .map(parse_feed_record)
            .collect::<PortResult<Vec<_>>>()?;
        let u = |k: &str| v.get(k).and_then(Value::as_u64);
        let scan = FeedScan {
            scanned_through: u("scannedThrough").ok_or_else(|| d("scannedThrough"))?,
            ledger_len: u("ledgerLen").ok_or_else(|| d("ledgerLen"))?,
            at_after: match v.get("atAfter") {
                None | Some(Value::Null) => None,
                Some(s) => Some(parse_sig(s)?),
            },
            run_id: v.get("runId").and_then(Value::as_str).map(String::from),
            ledger_bytes: u("ledgerBytes"),
            durable: v.get("durable").and_then(Value::as_bool),
        };
        Ok((txs, Some(scan)))
    }

    async fn blockhash(&self) -> PortResult<(Hash, u64)> {
        let v = self
            .rpc
            .call("getLatestBlockhash", json!([{"commitment": "confirmed"}]))
            .await?;
        parse_latest_blockhash_result(&v)
    }
}

#[cfg(test)]
mod bounded_response_tests {
    use super::*;

    #[test]
    fn accepts_matching_result_including_null() {
        for result in [json!({"value": 9}), Value::Null] {
            let response = json!({"jsonrpc": "2.0", "id": 7, "result": result});
            assert_eq!(parse_bounded_response(&response, 7).unwrap(), result);
        }
    }

    #[test]
    fn rejects_non_object_envelopes() {
        for response in [Value::Null, json!(true), json!(7), json!("2.0"), json!([])] {
            assert!(matches!(
                parse_bounded_response(&response, 7),
                Err(PortError::Decode(_))
            ));
        }
    }

    #[test]
    fn rejects_missing_or_wrong_jsonrpc_version() {
        for response in [
            json!({"id": 7, "result": null}),
            json!({"jsonrpc": "1.0", "id": 7, "result": null}),
            json!({"jsonrpc": 2.0, "id": 7, "result": null}),
            json!({"jsonrpc": null, "id": 7, "result": null}),
        ] {
            assert!(matches!(
                parse_bounded_response(&response, 7),
                Err(PortError::Decode(_))
            ));
        }
    }

    #[test]
    fn rejects_missing_mismatched_or_non_u64_ids() {
        assert!(matches!(
            parse_bounded_response(&json!({"jsonrpc": "2.0", "result": null}), 7),
            Err(PortError::Decode(_))
        ));
        for id in [
            Value::Null,
            json!(8),
            json!("7"),
            json!(-1),
            json!(7.0),
            json!(true),
            json!([]),
            json!({}),
        ] {
            let response = json!({"jsonrpc": "2.0", "id": id, "result": null});
            assert!(matches!(
                parse_bounded_response(&response, 7),
                Err(PortError::Decode(_))
            ));
        }
    }

    #[test]
    fn requires_exactly_one_result_or_error() {
        for response in [
            json!({"jsonrpc": "2.0", "id": 7}),
            json!({"jsonrpc": "2.0", "id": 7, "result": null, "error": null}),
            json!({"jsonrpc": "2.0", "id": 7, "result": 9,
                "error": {"code": -32602, "message": "invalid params"}}),
        ] {
            assert!(matches!(
                parse_bounded_response(&response, 7),
                Err(PortError::Decode(_))
            ));
        }
    }

    #[test]
    fn accepts_well_formed_rpc_error() {
        let response = json!({"jsonrpc": "2.0", "id": 7,
            "error": {"code": -32602, "message": "invalid params", "data": null}});
        assert!(matches!(
            parse_bounded_response(&response, 7),
            Err(PortError::Rpc { code: -32602, message }) if message == "invalid params"
        ));
    }

    #[test]
    fn rejects_malformed_rpc_errors() {
        for error in [
            Value::Null,
            json!([]),
            json!("invalid params"),
            json!(true),
            json!({}),
            json!({"code": -32602}),
            json!({"message": "invalid params"}),
            json!({"code": "-32602", "message": "invalid params"}),
            json!({"code": -32602.5, "message": "invalid params"}),
            json!({"code": -32602, "message": 5}),
        ] {
            let response = json!({"jsonrpc": "2.0", "id": 7, "error": error});
            assert!(matches!(
                parse_bounded_response(&response, 7),
                Err(PortError::Decode(_))
            ));
        }
    }

    #[test]
    fn constructors_only_store_configuration_and_keep_existing_defaults() {
        let url = "configuration-only";
        let client = RpcClient::new(url);
        assert_eq!(client.url, url);
        assert_eq!(client.id.load(Ordering::Relaxed), 1);
        assert_eq!(client.max_response_bytes, None);

        let client = RpcClient::new_with_response_limit(url, 123);
        assert_eq!(client.url, url);
        assert_eq!(client.id.load(Ordering::Relaxed), 1);
        assert_eq!(client.max_response_bytes, Some(123));

        // A literal public program address, not a keypair or derived key.
        let program = Address::new_from_array([7; 32]);
        let port = RpcPort::new(url, program);
        assert_eq!(port.rpc.max_response_bytes, None);
        assert!(!port.localnet);

        let localnet = RpcPort::localnet(url, program);
        assert_eq!(localnet.rpc.max_response_bytes, None);
        assert!(localnet.localnet);

        let port = RpcPort::new_with_response_limit(url, program, 456);
        assert_eq!(port.rpc.url, url);
        assert_eq!(port.rpc.max_response_bytes, Some(456));
        assert_eq!(port.program, program);
        assert!(!port.localnet);
    }
}

#[cfg(test)]
mod tests {
    /// verify-pr123: the backoff jitter stays in `[0, max]` and varies.
    #[test]
    fn backoff_jitter_is_bounded_and_varies() {
        use std::time::Duration;
        assert_eq!(super::jitter(Duration::ZERO), Duration::ZERO);
        let max = Duration::from_millis(250);
        let got: std::collections::BTreeSet<Duration> =
            (0..64).map(|_| super::jitter(max)).collect();
        assert!(got.iter().all(|d| *d <= max));
        assert!(got.len() > 1, "{got:?}");
    }

    #[test]
    fn get_transaction_balances_parse() {
        let v = json!({"slot": 3, "meta": {"err": null, "preBalances": [10, 0, 1], "postBalances": [5, 4, 1]}});
        assert_eq!(
            super::parse_balances(&v),
            Some((vec![10, 0, 1], vec![5, 4, 1]))
        );
        // absent, mismatched or not integers: none
        assert_eq!(super::parse_balances(&json!({"meta": {}})), None);
        assert_eq!(
            super::parse_balances(&json!({"meta": {"preBalances": [1], "postBalances": []}})),
            None
        );
        assert_eq!(
            super::parse_balances(&json!({"meta": {"preBalances": [-1], "postBalances": [1]}})),
            None
        );
    }

    use super::*;

    /// security-audit: one loopback JSON-RPC answer per connection (a thread); → the URL.
    /// The server reads the whole request and outlives the client's read
    /// (see `crate::http::serve_one_http`; fix-rpc-flake).
    fn rpc_answer_once(result: Value) -> String {
        let body = json!({"jsonrpc": "2.0", "id": 1, "result": result}).to_string();
        let reply = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        format!("http://{}", crate::http::serve_one_http(reply.into_bytes()))
    }

    fn run<F: std::future::Future>(f: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(f)
    }

    /// security-audit: a hostile or broken RPC that answers fewer (or more)
    /// accounts or statuses than asked is refused as a decode error; callers
    /// index the answer by position and used to panic (the keeper's tick is
    /// not isolated, so the whole keeper stopped).
    #[test]
    fn short_or_long_answers_are_refused() {
        let keys = [
            Address::new_from_array([1; 32]),
            Address::new_from_array([2; 32]),
        ];
        for value in [json!([]), json!([null]), json!([null, null, null])] {
            let url = rpc_answer_once(json!({"context": {"slot": 5}, "value": value}));
            let got = run(RpcClient::new(url).get_multiple_accounts(&keys, 0));
            assert!(
                matches!(&got, Err(PortError::Decode(m)) if m.contains("for 2 keys")),
                "{value}: {got:?}"
            );
        }
        let sigs = [Signature::from([7u8; 64]), Signature::from([8u8; 64])];
        let url = rpc_answer_once(json!({"context": {"slot": 5}, "value": [null]}));
        let port = RpcPort::new(url, Address::new_from_array([3; 32]));
        let got = run(port.statuses(&sigs));
        assert!(
            matches!(&got, Err(PortError::Decode(m)) if m.contains("for 2 signatures")),
            "{got:?}"
        );
        // The exact count still parses (absent accounts are None).
        let url = rpc_answer_once(json!({"context": {"slot": 5}, "value": [null, null]}));
        assert_eq!(
            run(RpcClient::new(url).get_multiple_accounts(&keys, 0)).unwrap(),
            vec![None, None]
        );
    }

    #[test]
    fn parses_errors_and_accounts() {
        assert_eq!(
            code_of(&json!({"InstructionError": [3, {"Custom": 35}]})),
            Some(35)
        );
        assert_eq!(code_of(&json!("MaxLoadedAccountsDataSizeExceeded")), None);
        let a = Account {
            lamports: 5,
            data: vec![1, 2, 3],
            owner: Address::new_from_array([3; 32]),
            executable: false,
        };
        assert_eq!(parse_account(&account_json(&a)).unwrap(), Some(a));
        assert_eq!(parse_account(&Value::Null).unwrap(), None);
    }

    #[test]
    fn only_finalized_signature_statuses_end_durable_writes() {
        let failed = json!({"slot": 9, "confirmationStatus": "confirmed", "err": {"InstructionError": [3, {"Custom": 52}]}});
        assert_eq!(parse_finalized_status(&Value::Null), None);
        assert_eq!(parse_finalized_status(&failed), None);
        assert_eq!(
            parse_finalized_status(&json!({"slot": 9, "err": null})),
            None
        );
        let success = json!({"slot": 10, "confirmationStatus": "finalized", "err": null});
        assert_eq!(
            parse_finalized_status(&success),
            Some(Status {
                slot: 10,
                err: None,
                code: None
            })
        );
        assert_eq!(
            parse_finalized_status(&json!({"confirmationStatus": "finalized", "err": null})),
            None,
            "missing slot is not slot zero"
        );
        assert_eq!(
            parse_finalized_status(&json!({"slot": 10, "confirmationStatus": "finalized"})),
            None,
            "missing error field is not proof of success"
        );
        assert_eq!(
            parse_finalized_status(
                &json!({"slot": -1, "confirmationStatus": "finalized", "err": null})
            ),
            None
        );
        assert_eq!(
            parse_finalized_status(
                &json!({"slot": 10, "confirmationStatus": "finalized", "err": 42})
            ),
            None
        );
        let mut finalized_failure = failed;
        finalized_failure["confirmationStatus"] = json!("finalized");
        assert_eq!(
            parse_finalized_status(&finalized_failure),
            Some(Status {
                slot: 9,
                err: Some("{\"InstructionError\":[3,{\"Custom\":52}]}".into()),
                code: Some(52),
            })
        );
    }

    #[test]
    fn latest_blockhash_requires_a_valid_block_height_bound() {
        let hash = Hash::new_from_array([7; 32]);
        let valid = json!({"value": {"blockhash": hash.to_string(), "lastValidBlockHeight": 123}});
        assert_eq!(
            parse_latest_blockhash_result(&valid),
            Ok((Hash::new_from_array([7; 32]), 123))
        );
        for invalid in [
            json!({"value": {"blockhash": hash.to_string()}}),
            json!({"value": {"blockhash": hash.to_string(), "lastValidBlockHeight": null}}),
            json!({"value": {"blockhash": hash.to_string(), "lastValidBlockHeight": "123"}}),
            json!({"value": {"blockhash": hash.to_string(), "lastValidBlockHeight": -1}}),
            json!({"value": {"blockhash": hash.to_string(), "lastValidBlockHeight": 0}}),
        ] {
            assert_eq!(
                parse_latest_blockhash_result(&invalid),
                Err(PortError::Decode("lastValidBlockHeight".into()))
            );
        }
    }
}
