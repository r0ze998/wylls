//! One-shot, keyless WideClaimDefence preview. This module never enters
//! keeper startup and accepts only the read-only `SnapshotSource` interface.
//! The complete request and read set are validated before the first read.
//! One source call supplies every account plus Clock and Rent; there is no
//! retry, partial repair, signing, simulation, admission or transaction output.

use std::io::Read;

use frontier_abi::world_index::wide_ix::WIDE_EXPERIMENTAL_VERSION_BIT;
use frontier_abi::world_index::{ProvinceKey, WideCoord, WorldId};
use serde_json::{json, Map, Value};
use solana_address::Address;

use crate::wideclaim::{self, Block, Candidate, SlotId};
use crate::wideduty::{Block as DutyBlock, Deployment, Scope};
use crate::widesnapshot::{Snapshot, SnapshotError, SnapshotSource};

pub const MAX_REQUEST_BYTES: usize = 8 * 1024;
pub const MAX_OUTPUT_BYTES: usize = 64 * 1024;
pub const MAX_SNAPSHOT_DATA_BYTES: usize = 64 * 1024;
pub const MAX_RPC_URL_BYTES: usize = 2 * 1024;
pub const MAX_RPC_RESPONSE_BYTES: usize = 1024 * 1024;
const MAX_SELECTED: usize = 6;

/// Closed diagnostic vocabulary. No input value, path, URL or error string
/// is retained in a request error.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RequestError {
    pub code: &'static str,
    pub field: &'static str,
}

fn bad(code: &'static str, field: &'static str) -> RequestError {
    RequestError { code, field }
}

/// Validated, immutable input. Its private fields prevent a caller from
/// bypassing bounds or changing an identity after the read set is derived.
#[derive(Clone, Debug)]
pub struct Request {
    scope: Scope,
    keeper: Address,
    day: u32,
    min_slot: u64,
    selected: Vec<SlotId>,
    keys: Vec<Address>,
}

impl Request {
    pub fn program(&self) -> Address {
        self.scope.program
    }
    pub fn required_keys(&self) -> &[Address] {
        &self.keys
    }
    pub fn min_slot(&self) -> u64 {
        self.min_slot
    }
}

/// The reader is capped before JSON parsing, including on stdin. An
/// overlong input consumes at most MAX_REQUEST_BYTES + 1 bytes.
pub fn read_request(reader: impl Read) -> Result<Request, RequestError> {
    let mut bytes = Vec::new();
    reader
        .take((MAX_REQUEST_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| bad("InputRead", "request"))?;
    parse_request(&bytes)
}

fn object<'a>(
    value: &'a Value,
    fields: &[&str],
    at: &'static str,
) -> Result<&'a Map<String, Value>, RequestError> {
    let obj = value.as_object().ok_or(bad("ObjectRequired", at))?;
    if obj.len() != fields.len() || fields.iter().any(|field| !obj.contains_key(*field)) {
        return Err(bad("ExactFieldsRequired", at));
    }
    Ok(obj)
}

fn string<'a>(value: &'a Value, at: &'static str) -> Result<&'a str, RequestError> {
    value.as_str().ok_or(bad("StringRequired", at))
}

fn decimal<T: std::str::FromStr>(
    value: &Value,
    at: &'static str,
    signed: bool,
) -> Result<T, RequestError> {
    let s = string(value, at)?;
    let digits = if signed {
        s.strip_prefix('-').unwrap_or(s)
    } else {
        s
    };
    if digits.is_empty()
        || digits.len() > 20
        || !digits.bytes().all(|b| b.is_ascii_digit())
        || (digits.len() > 1 && digits.starts_with('0'))
        || s == "-0"
    {
        return Err(bad("CanonicalDecimalRequired", at));
    }
    s.parse().map_err(|_| bad("IntegerOutOfRange", at))
}

fn public_address(value: &Value, at: &'static str) -> Result<Address, RequestError> {
    let s = string(value, at)?;
    if s.len() > 44 {
        return Err(bad("PublicAddressRequired", at));
    }
    s.parse().map_err(|_| bad("PublicAddressRequired", at))
}

fn bytes32(value: &Value, at: &'static str) -> Result<[u8; 32], RequestError> {
    let s = string(value, at)?;
    let mut out = [0; 32];
    if s.len() != 64 || hex::decode_to_slice(s, &mut out).is_err() {
        return Err(bad("Hex32Required", at));
    }
    Ok(out)
}

pub fn parse_request(bytes: &[u8]) -> Result<Request, RequestError> {
    if bytes.len() > MAX_REQUEST_BYTES {
        return Err(bad("RequestTooLarge", "request"));
    }
    let value: Value = serde_json::from_slice(bytes).map_err(|_| bad("InvalidJson", "request"))?;
    let root = object(
        &value,
        &[
            "program",
            "season",
            "deployment",
            "keeper",
            "day",
            "min_slot",
            "slots",
        ],
        "request",
    )?;
    // Bound selection before decoding or deriving any selected identity.
    let slots = root["slots"]
        .as_array()
        .ok_or(bad("ArrayRequired", "slots"))?;
    if slots.is_empty() || slots.len() > MAX_SELECTED {
        return Err(bad("SelectionCount", "slots"));
    }
    let deployment = object(
        &root["deployment"],
        &["program_version", "ruleset_hash"],
        "deployment",
    )?;
    let program_version: u16 = decimal(&deployment["program_version"], "program_version", false)?;
    if program_version & WIDE_EXPERIMENTAL_VERSION_BIT == 0 {
        return Err(bad("WideVersionRequired", "program_version"));
    }
    let scope = Scope {
        program: public_address(&root["program"], "program")?,
        season: public_address(&root["season"], "season")?,
        deployment: Some(Deployment {
            program_version,
            ruleset_hash: bytes32(&deployment["ruleset_hash"], "ruleset_hash")?,
        }),
    };
    let keeper = public_address(&root["keeper"], "keeper")?;
    let day = decimal(&root["day"], "day", false)?;
    let min_slot = decimal(&root["min_slot"], "min_slot", false)?;
    let mut selected = Vec::with_capacity(slots.len());
    for slot in slots {
        let s = object(slot, &["world", "p", "q", "bell", "faction", "i"], "slot")?;
        let world = WorldId::new(bytes32(&s["world"], "world")?)
            .map_err(|_| bad("ReservedWorld", "world"))?;
        let coord = WideCoord::checked(decimal(&s["p"], "p", true)?, decimal(&s["q"], "q", true)?)
            .map_err(|_| bad("CoordinateOutOfRange", "slot"))?;
        selected.push(SlotId {
            dest: ProvinceKey::new(world, coord),
            bell: decimal(&s["bell"], "bell", false)?,
            faction: decimal(&s["faction"], "faction", false)?,
            i: decimal(&s["i"], "i", false)?,
        });
    }
    let keys = wideclaim::required_keys(&scope, keeper, day, &selected).map_err(|b| {
        bad(
            match b {
                Block::Common(DutyBlock::World) => "WrongWorld",
                Block::SlotPosition { .. } => "SlotPosition",
                Block::DuplicateSlot { .. } => "DuplicateSlot",
                Block::KeeperAlias => "KeeperAlias",
                _ => "InvalidSelection",
            },
            "slots",
        )
    })?;
    if keys.len() > wideclaim::MAX_READ_KEYS {
        return Err(bad("ReadSetTooLarge", "slots"));
    }
    Ok(Request {
        scope,
        keeper,
        day,
        min_slot,
        selected,
        keys,
    })
}

/// The existing transport supports POST only over HTTP. Keep this one-shot
/// entry point on explicit loopback endpoints, reject URL injection/userinfo,
/// and never pass an unsupported HTTPS URL to another transport as fallback.
pub fn validate_rpc_url(url: &str) -> Result<(), RequestError> {
    if url.len() > MAX_RPC_URL_BYTES {
        return Err(bad("LoopbackHttpRpcRequired", "rpc_url"));
    }
    let rest = url
        .strip_prefix("http://")
        .ok_or(bad("LoopbackHttpRpcRequired", "rpc_url"))?;
    let (authority, path) = rest
        .find('/')
        .map_or((rest, ""), |i| (&rest[..i], &rest[i..]));
    let port = authority
        .strip_prefix("127.0.0.1:")
        .or_else(|| authority.strip_prefix("[::1]:"))
        .ok_or(bad("LoopbackHttpRpcRequired", "rpc_url"))?;
    if port.is_empty()
        || port.len() > 5
        || !port.bytes().all(|b| b.is_ascii_digit())
        || port.parse::<u16>().ok().is_none_or(|p| p == 0)
    {
        return Err(bad("RpcPortOutOfRange", "rpc_url"));
    }
    if !path
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'/' | b'-' | b'_' | b'.' | b'~'))
    {
        return Err(bad("RpcPathInvalid", "rpc_url"));
    }
    Ok(())
}

/// Closed output: all integral facts are decimal strings. No Instruction,
/// transaction, arbitrary error message, source label or URL is serialized.
#[derive(Clone, Debug)]
pub struct Report {
    value: Value,
}

impl Report {
    pub fn json(&self) -> &Value {
        &self.value
    }
    pub fn is_preview(&self) -> bool {
        self.value["status"] == "preview"
    }
    pub fn to_json_bytes(&self) -> Vec<u8> {
        let bytes = serde_json::to_vec(&self.value).expect("JSON values serialize");
        if bytes.len() > MAX_OUTPUT_BYTES {
            // Defensive invariant guard; no partial/truncated facts escape.
            return failure("output", "OutputTooLarge").to_json_bytes();
        }
        bytes
    }
}

fn envelope(stage: &'static str) -> Value {
    json!({
        "schema": "frontier-wide-claim-preview-v1",
        "status": "blocked", "stage": stage,
        "signed": false, "automatic_send": false, "fees_included": false,
        "warnings": [
            "UnsignedPreviewOnly", "TransactionFeesNotIncluded",
            "ZeroPaidStillConsumesSelectedSlots", "ClaimRentFundedBeforeRefund",
            "SnapshotCoherenceIsNotAuthorityOrFreshness", "ProductionGatesUnchanged"
        ],
        "source": {
            "kind": "single_snapshot_source", "read_calls": "0", "coherent": false,
            "authority_verified": false, "freshness": "unknown", "complete_world_view": false
        },
        "blocker": null, "facts": null
    })
}

pub fn failure(stage: &'static str, code: &'static str) -> Report {
    let mut value = envelope(stage);
    value["blocker"] = json!({"code": code});
    Report { value }
}

pub fn request_failure(error: RequestError) -> Report {
    let mut report = failure("request", error.code);
    report.value["blocker"]["field"] = json!(error.field);
    report
}

pub fn snapshot_timeout_failure() -> Report {
    let mut report = failure("snapshot", "PreviewTimeout");
    report.value["source"]["read_calls"] = json!("1");
    report
}

/// Useful for callers/tests: malformed requests cannot invoke the source.
pub async fn preview_bytes(bytes: &[u8], source: &dyn SnapshotSource) -> Report {
    match parse_request(bytes) {
        Ok(request) => preview(&request, source).await,
        Err(error) => request_failure(error),
    }
}

pub async fn preview(request: &Request, source: &dyn SnapshotSource) -> Report {
    let mut value = envelope("snapshot");
    value["source"]["read_calls"] = json!("1");
    let deployment = request
        .scope
        .deployment
        .expect("request parser pins deployment");
    value["scope"] = json!({
        "program": request.scope.program.to_string(), "season": request.scope.season.to_string(),
        "program_version": deployment.program_version.to_string(),
        "ruleset_hash": hex::encode(deployment.ruleset_hash), "keeper": request.keeper.to_string(),
        "day": request.day.to_string(), "min_slot": request.min_slot.to_string()
    });
    // Exactly one bounded key set, Clock and Rent. No other port API is used.
    let snapshot = match source
        .snapshot_boxed(&request.keys, true, request.min_slot)
        .await
    {
        Ok(snapshot) => snapshot,
        Err(error) => {
            value["blocker"] = snapshot_block(&error);
            return Report { value };
        }
    };
    if let Some(code) = snapshot_mismatch(request, &snapshot) {
        value["blocker"] = json!({"code": code});
        return Report { value };
    }
    let meta = snapshot.meta();
    value["source"]["coherent"] = json!(true);
    value["source"]["single_response"] = json!(true);
    value["source"]["context_slot"] = json!(meta.context_slot().to_string());
    value["source"]["min_slot"] = json!(meta.min_slot().to_string());
    value["source"]["account_count"] = json!(meta.keys().to_string());
    value["source"]["clock_included"] = json!(true);
    value["source"]["rent_included"] = json!(true);
    value["source"]["commitment"] = json!(meta.commitment());
    value["source"]["digest"] = json!(hex::encode(meta.digest()));
    value["stage"] = json!("plan");
    match wideclaim::plan_snapshot(
        &request.scope,
        request.keeper,
        request.day,
        &request.selected,
        &snapshot,
    ) {
        Ok(candidate) => {
            value["status"] = json!("preview");
            value["facts"] = facts(&candidate);
        }
        Err(block) => value["blocker"] = claim_block(&block),
    }
    Report { value }
}

fn snapshot_mismatch(request: &Request, snapshot: &Snapshot) -> Option<&'static str> {
    let meta = snapshot.meta();
    if meta.min_slot() != request.min_slot || meta.context_slot() < request.min_slot {
        return Some("SnapshotRequestMismatch");
    }
    if snapshot.accounts().len() != request.keys.len()
        || request
            .keys
            .iter()
            .any(|key| !snapshot.accounts().contains_key(key))
    {
        return Some("SnapshotKeySetMismatch");
    }
    if !meta.rent_included() || snapshot.rent().is_none() {
        return Some("SnapshotRentRequired");
    }
    let mut total = 0usize;
    for account in snapshot.accounts().values().flatten() {
        total = match total.checked_add(account.data.len()) {
            Some(total) if total <= MAX_SNAPSHOT_DATA_BYTES => total,
            _ => return Some("SnapshotDataTooLarge"),
        };
    }
    if !meta.verify(
        request.min_slot,
        Some(&snapshot.clock()),
        snapshot.rent().as_ref(),
        snapshot.accounts(),
    ) {
        return Some("SnapshotCoherenceMismatch");
    }
    None
}

fn snapshot_block(error: &SnapshotError) -> Value {
    // Deliberately do not call Debug, Display, code(), or source.label().
    // Even a custom source's static-string payload could contain a secret.
    json!({"code": match error {
        SnapshotError::Unsupported => "SnapshotUnsupported",
        SnapshotError::TooManyKeys { .. } => "SnapshotTooManyKeys",
        SnapshotError::DuplicateKey => "SnapshotDuplicateKey",
        SnapshotError::Rpc(_) => "SnapshotRpc",
        SnapshotError::Malformed(_) => "SnapshotMalformed",
        SnapshotError::Partial { .. } => "SnapshotPartial",
        SnapshotError::Stale { .. } => "SnapshotStale",
        SnapshotError::BadClock(_) => "SnapshotBadClock",
        SnapshotError::BadRent(_) => "SnapshotBadRent",
    }})
}

fn claim_block(block: &Block) -> Value {
    let code = match block {
        Block::Common(common) => return common_block(common),
        Block::SelectionCount(_) => "SelectionCount",
        Block::SlotPosition { .. } => "SlotPosition",
        Block::DuplicateSlot { .. } => "DuplicateSlot",
        Block::KeeperShape => "KeeperShape",
        Block::KeeperAlias => "KeeperAlias",
        Block::WrongDay {
            requested,
            observed,
        } => {
            return json!({
                "code": "WrongDay", "requested": requested.to_string(), "observed": observed.to_string()
            })
        }
        Block::ClaimIdentity => "ClaimIdentity",
        Block::SlotIdentity { .. } => "SlotIdentity",
        Block::WrongBeneficiary { .. } => "WrongBeneficiary",
        Block::AlreadyClaimed { .. } => "AlreadyClaimed",
        Block::LiveAnchorRequired { .. } => "LiveAnchorRequired",
        Block::AnchorIdentity { .. } => "AnchorIdentity",
        Block::WindowClosed {
            index,
            now,
            grace_end,
        } => {
            return json!({
                "code": "WindowClosed", "index": index.to_string(),
                "now": now.to_string(), "grace_end": grace_end.to_string()
            })
        }
        Block::NotLate {
            index,
            observed,
            required,
        } => {
            return json!({
                "code": "NotLate", "index": index.to_string(),
                "observed": observed.to_string(), "required": required.to_string()
            })
        }
        Block::NoRefund { .. } => "NoRefund",
        Block::KeeperShortfall { balance, needed } => {
            return json!({
                "code": "KeeperShortfall", "balance": balance.to_string(), "needed": needed.to_string()
            })
        }
        Block::SnapshotRentRequired => "SnapshotRentRequired",
        Block::SnapshotIncomplete(_) => "SnapshotIncomplete",
        Block::PacketTooLarge { predicted, max } => {
            return json!({
                "code": "PacketTooLarge", "predicted": predicted.to_string(), "max": max.to_string()
            })
        }
    };
    let mut value = json!({"code": code});
    match block {
        Block::SlotPosition { index, .. }
        | Block::DuplicateSlot { index }
        | Block::SlotIdentity { index }
        | Block::WrongBeneficiary { index }
        | Block::AlreadyClaimed { index }
        | Block::LiveAnchorRequired { index }
        | Block::AnchorIdentity { index }
        | Block::NoRefund { index } => {
            value["index"] = json!(index.to_string());
        }
        _ => {}
    }
    value
}

fn common_block(block: &DutyBlock) -> Value {
    let code = match block {
        DutyBlock::Read(_) => "Read",
        DutyBlock::Season(_) => "Season",
        DutyBlock::SeasonStatus(status) => {
            return json!({"code": "SeasonStatus", "status": status.to_string()})
        }
        DutyBlock::SeasonDependsOnClock => "SeasonDependsOnClock",
        DutyBlock::SeasonNotStarted {
            genesis_ts,
            observed,
        } => {
            return json!({
                "code": "SeasonNotStarted", "genesis_ts": genesis_ts.to_string(), "observed": observed.to_string()
            })
        }
        DutyBlock::DeploymentUnpinned => "DeploymentUnpinned",
        DutyBlock::ProgramVersion { expected, got } => {
            return json!({
                "code": "ProgramVersion", "expected": expected.to_string(), "got": got.to_string()
            })
        }
        DutyBlock::RulesetHash => "RulesetHash",
        DutyBlock::World => "World",
        DutyBlock::Absent(_) => "Absent",
        DutyBlock::ForeignOwner(_) => "ForeignOwner",
        DutyBlock::Unreadable(_) => "Unreadable",
        DutyBlock::NotCanonical(_) => "NotCanonical",
        DutyBlock::TimingNeedsClock => "TimingNeedsClock",
        DutyBlock::Overflow(_) => "Overflow",
        DutyBlock::RentSysvarMissing(_) => "RentSysvarMissing",
        _ => "UnsupportedPlannerBlock",
    };
    let mut value = json!({"code": code});
    if let DutyBlock::Absent(name)
    | DutyBlock::ForeignOwner(name)
    | DutyBlock::Unreadable(name)
    | DutyBlock::NotCanonical(name) = block
    {
        // A closed record-name map, not arbitrary text from an error payload.
        value["record"] = json!(match *name {
            "season" => "season",
            "defence pool" => "defence_pool",
            "defence claim" => "defence_claim",
            "wide arrival slot" => "wide_arrival_slot",
            "bell anchor" => "bell_anchor",
            _ => "unknown",
        });
    }
    value
}

fn facts(candidate: &Candidate) -> Value {
    let f = candidate.facts();
    let slots: Vec<Value> = f.slots.iter().map(|s| json!({
        "world": hex::encode(s.identity.dest.world().as_bytes()),
        "p": s.identity.dest.coord().p().to_string(), "q": s.identity.dest.coord().q().to_string(),
        "bell": s.identity.bell.to_string(), "faction": s.identity.faction.to_string(),
        "i": s.identity.i.to_string(), "address": s.address.to_string(), "anchor": s.anchor.to_string(),
        "region": s.region.to_string(), "evidence_slot": s.evidence_slot.to_string(),
        "anchor_slot": s.anchor_slot.to_string(), "anchor_ts": s.anchor_ts.to_string(),
        "reveal_close": s.reveal_close.to_string(), "grace_end": s.grace_end.to_string(),
        "evidence": { "price_micro": s.evidence.price_micro.to_string(),
            "limit": s.evidence.limit.to_string(), "loaded": s.evidence.loaded.to_string(),
            "created_day": s.evidence.created_day },
        "nominal_refund": s.nominal_refund.to_string(),
        "admitted_within_call": s.admitted_within_call.to_string(),
        "predicted_claimed": s.predicted_claimed
    })).collect();
    let balances: Vec<Value> = f
        .predicted_balances
        .iter()
        .map(|b| {
            json!({
                "address": b.address.to_string(), "before": b.before.to_string(),
                "predicted_after": b.predicted_after.to_string()
            })
        })
        .collect();
    json!({
        "keeper": candidate.keeper().to_string(), "day": f.day.to_string(),
        "now_bell": f.now_bell.to_string(), "judged_at": f.judged_at.to_string(),
        "observed_clock_slot": candidate.observed_clock().slot.to_string(),
        "pool": f.pool.to_string(), "claim": f.claim.to_string(), "claim_present": f.claim_present,
        "slots": slots, "per_bell_region_cap": f.per_bell_region_cap.to_string(),
        "region_cap_scope": "within_this_call_only",
        "per_keeper_day_cap": f.per_keeper_day_cap.to_string(),
        "day_cap_scope": "shared_with_legacy_claims_actual_paid",
        "admitted_within_call": f.admitted_within_call.to_string(),
        "day_room": f.day_room.to_string(), "day_capped": f.day_capped.to_string(),
        "pool_rent_floor": f.pool_rent_floor.to_string(), "pool_available": f.pool_available.to_string(),
        "predicted_paid": f.predicted_paid.to_string(), "predicted_partial": f.predicted_partial,
        "claimed_before": f.claimed_before.to_string(),
        "predicted_claimed_after": f.predicted_claimed_after.to_string(),
        "count_before": f.count_before.to_string(), "predicted_count_after": f.predicted_count_after.to_string(),
        "pool_paid_total_before": f.pool_paid_total_before.to_string(),
        "predicted_pool_paid_total_after": f.predicted_pool_paid_total_after.to_string(),
        "pool_claims_before": f.pool_claims_before.to_string(),
        "predicted_pool_claims_after": f.predicted_pool_claims_after.to_string(),
        "claim_rent_floor": f.claim_rent_floor.to_string(), "creation_shortfall": f.creation_shortfall.to_string(),
        "predicted_balances": balances, "packet_bytes": candidate.packet_bytes().to_string(),
        "status_promoted_by_clock": candidate.status_promoted_by_clock(),
        "slots_closed": false, "slot_rent_refunded": false,
        "transaction_success_established": false, "fee_sufficiency_established": false
    })
}
