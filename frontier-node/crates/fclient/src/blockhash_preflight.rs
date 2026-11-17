//! Bounded read-only blockhash context for unsigned-message inspection.
//! Three separate confirmed RPC observations, never an atomic snapshot,
//! authenticated RPC, signature, simulation, admission or send.
use crate::ports::{PortError, PortResult};
use crate::rpc::RpcClient;
use crate::unsigned_message_preflight::BlockhashObservation;
use serde_json::{json, Value};
use solana_hash::Hash;

pub const MAX_RESPONSE_BYTES: usize = 16 * 1024;
pub const TIMEOUT_SECONDS: u64 = 5;

#[derive(Clone, Copy, Debug)]
pub struct ObservedBlockhash {
    pub observation: BlockhashObservation,
    pub latest_context_slot: u64,
    /// getBlockHeight has no context envelope. This is the requested floor,
    /// not a claimed response slot or proof that the RPC respected it.
    pub height_min_context_slot: u64,
}
impl ObservedBlockhash {
    pub const fn read_calls(&self) -> u8 {
        3
    }
    pub const fn commitment(&self) -> &'static str {
        "confirmed"
    }
    pub const fn coherent_snapshot(&self) -> bool {
        false
    }
    pub const fn rpc_authority_verified(&self) -> bool {
        false
    }
    pub const fn admitted(&self) -> bool {
        false
    }
}

fn malformed(field: &str) -> PortError {
    PortError::Decode(format!("blockhash preflight {field}"))
}
fn context(value: &Value, floor: u64) -> PortResult<u64> {
    value
        .get("context")
        .and_then(|v| v.get("slot"))
        .and_then(Value::as_u64)
        .filter(|slot| *slot >= floor)
        .ok_or_else(|| malformed("context"))
}

/// Read the latest hash/expiry, check that exact hash, then read block height.
/// All requests use the same explicit endpoint and confirmed commitment. Each
/// later request carries the previous observed context as minContextSlot.
/// HTTP is allowed only on loopback; HTTPS uses the opt-in read-only transport.
/// Invalid/expired observations remain data for unsigned_message_preflight;
/// missing or contradictory fields are errors, never fabricated zero values.
/// This does not inspect program deployment, balances, accounts or instructions.
pub async fn read(url: &str, min_context_slot: u64) -> PortResult<ObservedBlockhash> {
    crate::http::check_curl_url(url)?;
    let rpc = RpcClient::new_with_response_limit(url, MAX_RESPONSE_BYTES);
    tokio::time::timeout(std::time::Duration::from_secs(TIMEOUT_SECONDS), async {
        let latest = read_call(
            &rpc,
            "getLatestBlockhash",
            json!([{
                "commitment":"confirmed", "minContextSlot":min_context_slot
            }]),
        )
        .await?;
        let latest_context_slot = context(&latest, min_context_slot)?;
        let value = latest
            .get("value")
            .ok_or_else(|| malformed("latest value"))?;
        let text = value
            .get("blockhash")
            .and_then(Value::as_str)
            .ok_or_else(|| malformed("hash"))?;
        let hash: Hash = text.parse().map_err(|_| malformed("hash"))?;
        if hash.to_bytes() == [0; 32] || hash.to_string() != text {
            return Err(malformed("hash"));
        }
        let last_valid_block_height = value
            .get("lastValidBlockHeight")
            .and_then(Value::as_u64)
            .filter(|height| *height > 0)
            .ok_or_else(|| malformed("expiry"))?;
        let validity = read_call(
            &rpc,
            "isBlockhashValid",
            json!([text, {
                "commitment":"confirmed", "minContextSlot":latest_context_slot
            }]),
        )
        .await?;
        let validity_context_slot = context(&validity, latest_context_slot)?;
        let valid = validity
            .get("value")
            .and_then(Value::as_bool)
            .ok_or_else(|| malformed("validity"))?;
        let block_height = read_call(
            &rpc,
            "getBlockHeight",
            json!([{
                "commitment":"confirmed", "minContextSlot":validity_context_slot
            }]),
        )
        .await?
        .as_u64()
        .ok_or_else(|| malformed("height"))?;
        Ok(ObservedBlockhash {
            observation: BlockhashObservation {
                blockhash: hash.to_bytes(),
                context_slot: validity_context_slot,
                valid,
                block_height,
                last_valid_block_height,
            },
            latest_context_slot,
            height_min_context_slot: validity_context_slot,
        })
    })
    .await
    .map_err(|_| malformed("timeout"))?
}

async fn read_call(rpc: &RpcClient, method: &str, params: Value) -> PortResult<Value> {
    if rpc.url.starts_with("https://") {
        crate::readonly_https_rpc::call(&rpc.url, method, params, MAX_RESPONSE_BYTES).await
    } else {
        rpc.call(method, params).await
    }
}
