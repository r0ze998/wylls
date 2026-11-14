//! Bounded one-shot resident preparation; never starts a keeper or uses keys.
//! Fresh account inspection and blockhash reads yield unsigned Message bytes.
//! Neither the selected snapshot nor an RPC response grants execution consent.
use crate::{wideexpedition_preview as preview, widesnapshot::SnapshotSource};
use base64::Engine;
use fclient::{
    blockhash_preflight::ObservedBlockhash,
    experimental_expedition_message::{prepare_resident, Target},
    tx::TxBudget,
    unsigned_message_preflight::Limits,
    wide_resident_draft::Draft,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use solana_address::Address;
use std::{future::Future, io::Read};

pub const REQUEST_SCHEMA: &str = "frontier-experimental-expedition-prepare-request-v1";
pub const REPORT_SCHEMA: &str = "frontier-experimental-expedition-prepare-report-v1";
pub const MAX_REQUEST_BYTES: usize = 16 * 1024;
pub const MAX_OUTPUT_BYTES: usize = 64 * 1024;

#[derive(Clone, Copy)]
pub struct Settings {
    pub program: Address,
    pub season: Address,
    pub fee_payer: Address,
    pub ruleset_hash: [u8; 32],
    pub cu_limit: u32,
    pub loaded_limit: u32,
}
pub struct Request {
    echo: Value,
    source: preview::Request,
    action: String,
    source_context_slot: u64,
}
impl Request {
    pub fn program(&self) -> Address {
        self.source.program()
    }
    pub fn echo(&self) -> &Value {
        &self.echo
    }
}
fn exact(v: &Value, keys: &[&str]) -> bool {
    v.as_object()
        .is_some_and(|o| o.len() == keys.len() && keys.iter().all(|k| o.contains_key(*k)))
}
fn hex_bytes<const N: usize>(v: &Value) -> Result<[u8; N], &'static str> {
    let text = v.as_str().ok_or("RequestInvalid")?;
    let mut bytes = [0; N];
    if text.len() != 2 * N
        || !text
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err("RequestInvalid");
    }
    hex::decode_to_slice(text, &mut bytes).map_err(|_| "RequestInvalid")?;
    Ok(bytes)
}
fn decimal(v: &Value) -> Result<u64, &'static str> {
    let s = v.as_str().ok_or("RequestInvalid")?;
    if s.is_empty()
        || s.len() > 20
        || !s.bytes().all(|b| b.is_ascii_digit())
        || (s.len() > 1 && s.starts_with('0'))
    {
        return Err("RequestInvalid");
    }
    s.parse().map_err(|_| "RequestInvalid")
}
pub fn parse_request(bytes: &[u8]) -> Result<Request, &'static str> {
    if bytes.len() > MAX_REQUEST_BYTES {
        return Err("RequestInvalid");
    }
    let echo: Value = serde_json::from_slice(bytes).map_err(|_| "RequestInvalid")?;
    if !exact(
        &echo,
        &[
            "schema",
            "request_id",
            "action",
            "source_request",
            "source_context_slot",
            "source_snapshot_digest",
            "proposal",
        ],
    ) || echo["schema"] != REQUEST_SCHEMA
    {
        return Err("RequestInvalid");
    }
    let request_id = echo["request_id"].as_str().ok_or("RequestInvalid")?;
    if request_id.is_empty()
        || request_id.len() > 64
        || !request_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        return Err("RequestInvalid");
    }
    let action = echo["action"]
        .as_str()
        .filter(|a| matches!(*a, "Dissolve" | "Return"))
        .ok_or("RequestInvalid")?
        .to_owned();
    let source = preview::parse_request(
        &serde_json::to_vec(&echo["source_request"]).map_err(|_| "RequestInvalid")?,
    )
    .map_err(|_| "RequestInvalid")?;
    // (0x4804 as before; the local test candidate 0xC804 only under its own id: crate::local_lane)
    if crate::local_lane::served_scope(source.scope()).is_none() {
        return Err("RequestInvalid");
    }
    let source_context_slot = decimal(&echo["source_context_slot"])?;
    if source_context_slot < source.min_slot() {
        return Err("RequestInvalid");
    }
    hex_bytes::<32>(&echo["source_snapshot_digest"])?;
    let proposal = &echo["proposal"];
    if !exact(proposal, &["bytes_hex", "content_digest", "roles"]) {
        return Err("RequestInvalid");
    }
    hex_bytes::<60>(&proposal["bytes_hex"])?;
    hex_bytes::<32>(&proposal["content_digest"])?;
    let roles = proposal["roles"]
        .as_array()
        .filter(|a| a.len() <= 8)
        .ok_or("RequestInvalid")?;
    for role in roles {
        if !exact(role, &["name", "address", "signer", "writable"])
            || !role["name"].is_string()
            || !role["address"].is_string()
            || !role["signer"].is_boolean()
            || !role["writable"].is_boolean()
        {
            return Err("RequestInvalid");
        }
    }
    Ok(Request {
        echo,
        source,
        action,
        source_context_slot,
    })
}
pub fn read_request(reader: impl Read) -> Result<Request, &'static str> {
    let mut bytes = Vec::new();
    reader
        .take((MAX_REQUEST_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| "RequestInvalid")?;
    parse_request(&bytes)
}
pub fn failure(request: Option<&Request>, code: &str) -> Value {
    json!({"schema":REPORT_SCHEMA,"status":"blocked","request":request.map(|r|r.echo.clone()),
        "source":null,"blockhash":null,"prepared":null,"blocker":{"code":code},
        "host_only":true,"ready":false,"deployment_verified":false,"admitted":false,
        "signed":false,"enqueued":false,"relay_submission_available":false,"automatic_send":false})
}
pub fn output_bytes(value: &Value) -> Vec<u8> {
    match serde_json::to_vec(value) {
        Ok(bytes) if bytes.len() <= MAX_OUTPUT_BYTES => bytes,
        _ => serde_json::to_vec(&failure(None, "OutputTooLarge")).unwrap_or_default(),
    }
}

/// The blockhash provider is injected for key-free tests; the one-shot binary
/// supplies only fclient's bounded read-only RPC routine. No send port is used.
pub async fn prepare<F, Fut>(
    request: &Request,
    settings: Settings,
    source: &dyn SnapshotSource,
    blockhash: F,
) -> Value
where
    F: FnOnce(u64) -> Fut,
    Fut: Future<Output = Result<ObservedBlockhash, ()>>,
{
    match prepare_inner(request, settings, source, blockhash).await {
        Ok(value) => value,
        Err(code) => failure(Some(request), code),
    }
}
async fn prepare_inner<F, Fut>(
    r: &Request,
    s: Settings,
    source: &dyn SnapshotSource,
    blockhash: F,
) -> Result<Value, &'static str>
where
    F: FnOnce(u64) -> Fut,
    Fut: Future<Output = Result<ObservedBlockhash, ()>>,
{
    let scope = r.source.scope();
    if scope.program != s.program
        || scope.season != s.season
        || r.source.payer() != Some(s.fee_payer)
        || scope.deployment.as_ref().map(|d| d.ruleset_hash) != Some(s.ruleset_hash)
    {
        return Err("RequestInvalid");
    }
    let fresh = preview::preview(&r.source, source).await;
    if !fresh.is_preview() {
        return Err("SourceBlocked");
    }
    let fresh = fresh.json();
    let context = decimal(&fresh["source"]["context_slot"]).map_err(|_| "SourceUnavailable")?;
    if context < r.source_context_slot || fresh["source"]["coherent"] != true {
        return Err("SourceBlocked");
    }
    let next = if r.action == "Dissolve" {
        "OwnerDissolve"
    } else {
        "ReturnOriginalReserve"
    };
    if fresh["facts"]["next_prerequisite"] != next || fresh["draft"]["action"] != r.action {
        return Err("ActionUnavailable");
    }
    let ctx = crate::wideduty::ctx_of(scope);
    let selected = r.source.selected();
    let draft = if r.action == "Dissolve" {
        let wallet = r.source.wallet().ok_or("ActionUnavailable")?;
        if ctx.citizen(&wallet.to_bytes()) != selected.original_owner.to_bytes() {
            return Err("ActionUnavailable");
        }
        Draft::for_wallet(&ctx, selected.host, selected.standing, wallet, s.fee_payer)
    } else {
        Draft::return_home(&ctx, selected.host, selected.standing, s.fee_payer)
    }
    .map_err(|_| "ProposalMismatch")?;
    let roles:Vec<_>=draft.roles().iter().map(|p|json!({"name":p.name,"address":p.address.to_string(),"signer":p.signer,"writable":p.writable})).collect();
    let proposal_digest = hex::encode(draft.content_digest());
    if r.echo["proposal"]
        != json!({"bytes_hex":hex::encode(draft.proposed_bytes()),"content_digest":proposal_digest,"roles":roles})
    {
        return Err("ProposalMismatch");
    }
    let observed = blockhash(context)
        .await
        .map_err(|_| "BlockhashUnavailable")?;
    // Bind both explicit context envelopes; height_min_context_slot is a request
    // floor only and never re-labelled as a proven response context.
    if observed.latest_context_slot < context
        || observed.observation.context_slot < observed.latest_context_slot
        || observed.height_min_context_slot != observed.observation.context_slot
    {
        return Err("BlockhashUnavailable");
    }
    let budget = TxBudget {
        cu_limit: s.cu_limit,
        cu_price: 0,
        loaded_limit: s.loaded_limit,
        heap: Some(fclient::experimental_expedition_message::RESIDENT_HEAP_FRAME),
    };
    // the deployment's own served version (checked at parse; read again, never a literal)
    let version = crate::local_lane::served_scope(r.source.scope()).ok_or("RequestInvalid")?;
    let prepared = prepare_resident(
        &draft,
        Target {
            program: s.program,
            season: s.season,
            program_version: version,
        },
        observed.observation,
        budget,
        Limits {
            max_locks: 32,
            max_writes: 16,
            min_context_slot: context,
            min_remaining_block_heights: 2,
        },
    )
    .map_err(|_| "PreflightFailed")?;
    let message = prepared.message_bytes().map_err(|_| "PreflightFailed")?;
    let report = prepared.report();
    let hash = observed.observation;
    Ok(
        json!({"schema":REPORT_SCHEMA,"status":"prepared","request":r.echo,
        "source":{"request_digest":r.source.digest(),"context_slot":context.to_string(),"digest":fresh["source"]["digest"],"coherent":true,"authority_verified":false},
        "blockhash":{"hash":fclient::Hash::new_from_array(hash.blockhash).to_string(),"latest_context_slot":observed.latest_context_slot.to_string(),"validity_context_slot":hash.context_slot.to_string(),"height_min_context_slot":observed.height_min_context_slot.to_string(),"block_height":hash.block_height.to_string(),"last_valid_block_height":hash.last_valid_block_height.to_string(),"remaining_block_heights":report.remaining_block_heights.to_string(),"valid":true,"commitment":"confirmed","coherent":false,"authority_verified":false},
        "prepared":{"program":s.program.to_string(),"season":s.season.to_string(),"program_version":version.to_string(),"action":r.action,"fee_payer":s.fee_payer.to_string(),
            "budget":{"cu_limit":budget.cu_limit,"cu_price":"0","loaded_limit":budget.loaded_limit,"heap":budget.heap},"roles":roles,
            "instruction_hex":hex::encode(&prepared.instruction().data),"message_b64":base64::engine::general_purpose::STANDARD.encode(&message),"message_digest":hex::encode(Sha256::digest(&message)),
            "signers":prepared.expected_signers().iter().map(ToString::to_string).collect::<Vec<_>>(),"shape":{"bytes":report.shape.bytes,"locks":report.shape.locks,"writes":report.shape.writes,"sigs":report.shape.sigs},"proposal_digest":proposal_digest},
        "blocker":null,"host_only":true,"ready":false,"deployment_verified":false,"admitted":false,"signed":false,"enqueued":false,"relay_submission_available":false,"automatic_send":false}),
    )
}
