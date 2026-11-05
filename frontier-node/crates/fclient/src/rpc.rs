//! JSON-RPC client and the `ChainPort` over it.
//!
//! `RpcPort::localnet(url, program)` also reads the ordered transaction feed
//! (`frontier_feed`); against a public RPC `feed` needs the
//! `getSignaturesForAddress` + `getTransaction` pager, which `findex`'s
//! `RpcPoll` ingest adds in wave 2 (W2-F), so it reports `Unsupported` here.

use std::sync::atomic::{AtomicU64, Ordering};

use base64::Engine;
use serde_json::{json, Value};
use solana_address::Address;
use solana_hash::Hash;

use crate::ports::{
    Account, ChainPort, ClockSysvar, Cursor, PortError, PortResult, Signature, SimResult, Status,
    TxRecord,
};

const B64: base64::engine::GeneralPurpose = base64::engine::general_purpose::STANDARD;

pub struct RpcClient {
    pub url: String,
    id: AtomicU64,
}

impl RpcClient {
    pub fn new(url: impl Into<String>) -> RpcClient {
        RpcClient {
            url: url.into(),
            id: AtomicU64::new(1),
        }
    }

    pub async fn call(&self, method: &str, params: Value) -> PortResult<Value> {
        let id = self.id.fetch_add(1, Ordering::Relaxed);
        let req = json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params});
        let resp = crate::http::post_json(&self.url, &req).await?;
        if resp.status != 200 {
            return Err(PortError::Http(resp.status));
        }
        let v: Value =
            serde_json::from_slice(&resp.body).map_err(|e| PortError::Decode(e.to_string()))?;
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
            for a in arr {
                out.push(parse_account(a)?);
            }
        }
        Ok(out)
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
                json!([sig.to_string(), {"encoding": "base64", "commitment": commitment, "maxSupportedTransactionVersion": 0}]),
            )
            .await?;
        if v.is_null() {
            return Ok(None);
        }
        parse_transaction(sig, &v).map(Some)
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

/// `ChainPort` over JSON-RPC.
pub struct RpcPort {
    pub rpc: RpcClient,
    pub program: Address,
    /// The server is `frontier-localnet` (has `frontier_feed`).
    pub localnet: bool,
}

impl RpcPort {
    pub fn new(url: impl Into<String>, program: Address) -> RpcPort {
        RpcPort {
            rpc: RpcClient::new(url),
            program,
            localnet: false,
        }
    }
    pub fn localnet(url: impl Into<String>, program: Address) -> RpcPort {
        RpcPort {
            rpc: RpcClient::new(url),
            program,
            localnet: true,
        }
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

    async fn statuses(&self, sigs: &[Signature]) -> PortResult<Vec<Option<Status>>> {
        let mut out = vec![];
        for chunk in sigs.chunks(256) {
            let ss: Vec<String> = chunk.iter().map(|s| s.to_string()).collect();
            let v = self
                .rpc
                .call(
                    "getSignatureStatuses",
                    json!([ss, {"searchTransactionHistory": true}]),
                )
                .await?;
            for s in v
                .get("value")
                .and_then(|x| x.as_array())
                .ok_or_else(|| PortError::Decode("value".into()))?
            {
                out.push(parse_finalized_status(s));
            }
        }
        Ok(out)
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

    async fn blockhash(&self) -> PortResult<(Hash, u64)> {
        let v = self
            .rpc
            .call("getLatestBlockhash", json!([{"commitment": "confirmed"}]))
            .await?;
        parse_latest_blockhash_result(&v)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
