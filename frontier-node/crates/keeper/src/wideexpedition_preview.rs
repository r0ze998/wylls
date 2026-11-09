//! Bounded, keyless original-host inspection. No keeper startup, initial Depart
//! planning, live-authority claim, executable instruction, signing or send API.
use crate::wideduty::{self, Block, Deployment, Scope};
use crate::wideexpedition::{self, Next, ReadPlan, Refusal, Selection};
use crate::widesnapshot::{Snapshot, SnapshotError, SnapshotSource};
use fclient::wide_resident_draft::Draft;
use frontier_abi::world_index::{
    expedition::AccountResolver, wide_ix::WIDE_EXPERIMENTAL_VERSION_BIT, ProvinceKey, WideCoord,
    WideHostRef,
};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use solana_address::Address;
use std::io::Read;

pub const MAX_REQUEST_BYTES: usize = 8 * 1024;
pub const MAX_OUTPUT_BYTES: usize = 64 * 1024;
pub const MAX_SNAPSHOT_DATA_BYTES: usize = 64 * 1024;
pub const MAX_RPC_RESPONSE_BYTES: usize = 1024 * 1024;
pub const REQUEST_SCHEMA: &str = "frontier-original-expedition-request-v1";
pub const REPORT_SCHEMA: &str = "frontier-original-expedition-preview-v1";
pub use crate::wideclaim_preview::validate_rpc_url;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RequestError {
    pub code: &'static str,
    pub field: &'static str,
}
fn bad(code: &'static str, field: &'static str) -> RequestError {
    RequestError { code, field }
}
#[derive(Clone, Debug)]
pub struct Request {
    scope: Scope,
    selected: Selection,
    reads: ReadPlan,
    min_slot: u64,
    wallet: Option<Address>,
    payer: Option<Address>,
    echo: Value,
    digest: String,
}
impl Request {
    pub fn program(&self) -> Address {
        self.scope.program
    }
    pub fn required_keys(&self) -> &[Address] {
        self.reads.keys()
    }
    pub fn min_slot(&self) -> u64 {
        self.min_slot
    }
    pub fn digest(&self) -> &str {
        &self.digest
    }
}
pub fn read_request(reader: impl Read) -> Result<Request, RequestError> {
    let mut bytes = Vec::new();
    reader
        .take((MAX_REQUEST_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| bad("InputRead", "request"))?;
    parse_request(&bytes)
}
fn object<'a>(
    v: &'a Value,
    fields: &[&str],
    at: &'static str,
) -> Result<&'a Map<String, Value>, RequestError> {
    let o = v.as_object().ok_or(bad("ObjectRequired", at))?;
    if o.len() != fields.len() || fields.iter().any(|f| !o.contains_key(*f)) {
        return Err(bad("ExactFieldsRequired", at));
    }
    Ok(o)
}
fn string<'a>(v: &'a Value, at: &'static str) -> Result<&'a str, RequestError> {
    v.as_str().ok_or(bad("StringRequired", at))
}
fn decimal<T: std::str::FromStr>(
    v: &Value,
    at: &'static str,
    signed: bool,
) -> Result<T, RequestError> {
    let s = string(v, at)?;
    let d = if signed {
        s.strip_prefix('-').unwrap_or(s)
    } else {
        s
    };
    if d.is_empty()
        || d.len() > 20
        || !d.bytes().all(|b| b.is_ascii_digit())
        || (d.len() > 1 && d.starts_with('0'))
        || s == "-0"
    {
        return Err(bad("CanonicalDecimalRequired", at));
    }
    s.parse().map_err(|_| bad("IntegerOutOfRange", at))
}
fn address(v: &Value, at: &'static str) -> Result<Address, RequestError> {
    let s = string(v, at)?;
    if s.len() > 44 {
        return Err(bad("PublicAddressRequired", at));
    }
    let a: Address = s.parse().map_err(|_| bad("PublicAddressRequired", at))?;
    if a == Address::default() || a.to_string() != s {
        return Err(bad("PublicAddressRequired", at));
    }
    Ok(a)
}
fn optional_address(v: &Value, at: &'static str) -> Result<Option<Address>, RequestError> {
    if v.is_null() {
        Ok(None)
    } else {
        address(v, at).map(Some)
    }
}
fn hex_array<const N: usize>(v: &Value, at: &'static str) -> Result<[u8; N], RequestError> {
    let s = string(v, at)?;
    let mut a = [0; N];
    if s.len() != N * 2
        || !s
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        || hex::decode_to_slice(s, &mut a).is_err()
    {
        return Err(bad("CanonicalHexRequired", at));
    }
    Ok(a)
}
pub fn parse_request(bytes: &[u8]) -> Result<Request, RequestError> {
    if bytes.len() > MAX_REQUEST_BYTES {
        return Err(bad("RequestTooLarge", "request"));
    }
    let echo: Value = serde_json::from_slice(bytes).map_err(|_| bad("InvalidJson", "request"))?;
    let r = object(
        &echo,
        &[
            "schema",
            "operation",
            "cluster",
            "program",
            "season",
            "deployment",
            "host",
            "original_owner",
            "standing",
            "min_slot",
            "wallet",
            "payer",
        ],
        "request",
    )?;
    if r["schema"] != REQUEST_SCHEMA {
        return Err(bad("Schema", "schema"));
    }
    if r["operation"] != "inspect" {
        return Err(bad("Operation", "operation"));
    }
    let cluster = string(&r["cluster"], "cluster")?;
    if cluster.is_empty()
        || cluster.len() > 32
        || !cluster
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
    {
        return Err(bad("ClusterLabel", "cluster"));
    }
    let d = object(
        &r["deployment"],
        &["program_version", "ruleset_hash"],
        "deployment",
    )?;
    let version: u16 = decimal(&d["program_version"], "program_version", false)?;
    if version & WIDE_EXPERIMENTAL_VERSION_BIT == 0 {
        return Err(bad("WideVersionRequired", "program_version"));
    }
    let scope = Scope {
        program: address(&r["program"], "program")?,
        season: address(&r["season"], "season")?,
        deployment: Some(Deployment {
            program_version: version,
            ruleset_hash: hex_array(&d["ruleset_hash"], "ruleset_hash")?,
        }),
    };
    if scope.program == scope.season {
        return Err(bad("ScopeAlias", "season"));
    }
    let ctx = wideduty::ctx_of(&scope);
    let resolver = AccountResolver::for_season(&ctx).map_err(|_| bad("World", "season"))?;
    let host = WideHostRef::from_bytes(&hex_array::<56>(&r["host"], "host")?)
        .map_err(|_| bad("HostReference", "host"))?;
    let s = object(&r["standing"], &["p", "q"], "standing")?;
    let coord = WideCoord::checked(decimal(&s["p"], "p", true)?, decimal(&s["q"], "q", true)?)
        .map_err(|_| bad("CoordinateOutOfRange", "standing"))?;
    let selected = Selection {
        host,
        standing: ProvinceKey::new(resolver.adapter().world(), coord),
        original_owner: address(&r["original_owner"], "original_owner")?,
    };
    let reads = ReadPlan::new(&scope, selected).map_err(|e| bad(refusal_code(&e), "selection"))?;
    if reads.keys().len() != 10 || reads.keys().contains(&scope.program) {
        return Err(bad("ReadSet", "selection"));
    }
    let min_slot = decimal(&r["min_slot"], "min_slot", false)?;
    let wallet = optional_address(&r["wallet"], "wallet")?;
    let payer = optional_address(&r["payer"], "payer")?;
    // Fixed field sequence, canonical ASCII values and one terminal newline.
    // This is request identity, not an authentication/signature mechanism.
    let fields = [
        r["operation"].as_str().unwrap(),
        cluster,
        r["program"].as_str().unwrap(),
        r["season"].as_str().unwrap(),
        d["program_version"].as_str().unwrap(),
        d["ruleset_hash"].as_str().unwrap(),
        r["host"].as_str().unwrap(),
        r["original_owner"].as_str().unwrap(),
        s["p"].as_str().unwrap(),
        s["q"].as_str().unwrap(),
        r["min_slot"].as_str().unwrap(),
        r["wallet"].as_str().unwrap_or(""),
        r["payer"].as_str().unwrap_or(""),
    ];
    let digest = hex::encode(Sha256::digest(
        format!("{REQUEST_SCHEMA}\n{}\n", fields.join("\n")).as_bytes(),
    ));
    Ok(Request {
        scope,
        selected,
        reads,
        min_slot,
        wallet,
        payer,
        echo,
        digest,
    })
}

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
        let b = serde_json::to_vec(&self.value).expect("JSON values serialize");
        if b.len() > MAX_OUTPUT_BYTES {
            return failure("output", "OutputTooLarge").to_json_bytes();
        }
        b
    }
}
fn envelope(stage: &'static str) -> Value {
    json!({"schema":REPORT_SCHEMA,"status":"blocked","stage":stage,"request_digest":null,"scope":null,
        "source":{"kind":"single_snapshot_source","read_calls":"0","coherent":false,"single_response":false,"context_slot":null,"digest":null,"authority_verified":false,"freshness":"unknown","complete_world_view":false},
        "blocker":null,"facts":null,"draft":null,"draft_blocker":null,
        "dispatch_available":false,"admitted":false,"signed":false,"enqueued":false,"automatic_send":false,"completion_proven":false,"history_verified":false})
}
pub fn failure(stage: &'static str, code: &'static str) -> Report {
    let mut value = envelope(stage);
    value["blocker"] = json!({"code":code});
    Report { value }
}
pub fn request_failure(e: RequestError) -> Report {
    let mut r = failure("request", e.code);
    r.value["blocker"]["field"] = json!(e.field);
    r
}
fn bound(request: &Request, stage: &'static str) -> Value {
    let mut v = envelope(stage);
    v["scope"] = request.echo.clone();
    v["request_digest"] = json!(request.digest);
    v
}
pub fn snapshot_timeout_failure(request: &Request) -> Report {
    let mut value = bound(request, "snapshot");
    value["source"]["read_calls"] = json!("1");
    value["blocker"] = json!({"code":"PreviewTimeout"});
    Report { value }
}
pub async fn preview_bytes(bytes: &[u8], source: &dyn SnapshotSource) -> Report {
    match parse_request(bytes) {
        Ok(r) => preview(&r, source).await,
        Err(e) => request_failure(e),
    }
}
pub async fn preview(request: &Request, source: &dyn SnapshotSource) -> Report {
    let mut value = bound(request, "snapshot");
    value["source"]["read_calls"] = json!("1");
    let snapshot = match source
        .snapshot_boxed(request.required_keys(), false, request.min_slot)
        .await
    {
        Ok(s) => s,
        Err(e) => {
            value["blocker"] = json!({"code":snapshot_code(&e)});
            return Report { value };
        }
    };
    if let Some(code) = snapshot_mismatch(request, &snapshot) {
        value["blocker"] = json!({"code":code});
        return Report { value };
    }
    value["source"]["coherent"] = json!(true);
    value["source"]["single_response"] = json!(true);
    value["source"]["context_slot"] = json!(snapshot.meta().context_slot().to_string());
    value["source"]["digest"] = json!(hex::encode(snapshot.meta().digest()));
    value["stage"] = json!("plan");
    match wideexpedition::plan(&request.scope, request.selected, &snapshot.reads()) {
        Err(e) => value["blocker"] = json!({"code":refusal_code(&e)}),
        Ok(facts) => {
            value["status"] = json!("preview");
            let (draft, block) = draft(request, facts.next);
            value["facts"] = facts.describe();
            value["draft"] = draft;
            value["draft_blocker"] = block.map_or(Value::Null, |s| json!(s));
        }
    }
    Report { value }
}
fn snapshot_mismatch(r: &Request, s: &Snapshot) -> Option<&'static str> {
    let m = s.meta();
    if m.min_slot() != r.min_slot || m.context_slot() < r.min_slot {
        return Some("SnapshotRequestMismatch");
    }
    if s.accounts().len() != r.required_keys().len()
        || r.required_keys()
            .iter()
            .any(|k| !s.accounts().contains_key(k))
    {
        return Some("SnapshotKeySetMismatch");
    }
    if m.rent_included() || s.rent().is_some() {
        return Some("SnapshotUnexpectedRent");
    }
    let mut n = 0usize;
    for a in s.accounts().values().flatten() {
        n = match n.checked_add(a.data.len()) {
            Some(n) if n <= MAX_SNAPSHOT_DATA_BYTES => n,
            _ => return Some("SnapshotDataTooLarge"),
        };
    }
    if !m.verify(r.min_slot, Some(&s.clock()), None, s.accounts()) {
        return Some("SnapshotCoherenceMismatch");
    }
    None
}
fn draft(r: &Request, next: Next) -> (Value, Option<&'static str>) {
    if !matches!(next, Next::OwnerDissolve | Next::ReturnOriginalReserve) {
        return (Value::Null, Some("NoResidentDraftAtThisStage"));
    }
    let Some(payer) = r.payer else {
        return (Value::Null, Some("PayerProposalRequired"));
    };
    let ctx = wideduty::ctx_of(&r.scope);
    let (action, d) = match next {
        Next::OwnerDissolve => {
            let Some(wallet) = r.wallet else {
                return (Value::Null, Some("WalletProposalRequired"));
            };
            if ctx.citizen(&wallet.to_bytes()) != r.selected.original_owner.to_bytes() {
                return (Value::Null, Some("WalletCitizenMismatch"));
            }
            (
                "Dissolve",
                Draft::for_wallet(&ctx, r.selected.host, r.selected.standing, wallet, payer),
            )
        }
        Next::ReturnOriginalReserve => (
            "Return",
            Draft::return_home(&ctx, r.selected.host, r.selected.standing, payer),
        ),
        _ => unreachable!(),
    };
    match d {
        Ok(d) => (
            json!({"kind":"closed-resident-role-draft","action":action,"roles":d.roles().iter().map(|r|json!({"name":r.name,"address":r.address.to_string(),"signer":r.signer,"writable":r.writable})).collect::<Vec<_>>(),"dispatch_available":false,"admitted":false}),
            None,
        ),
        Err(_) => (Value::Null, Some("DraftAccountContract")),
    }
}
fn snapshot_code(e: &SnapshotError) -> &'static str {
    match e {
        SnapshotError::Unsupported => "SnapshotUnsupported",
        SnapshotError::TooManyKeys { .. } => "SnapshotTooManyKeys",
        SnapshotError::DuplicateKey => "SnapshotDuplicateKey",
        SnapshotError::Rpc(_) => "SnapshotRpc",
        SnapshotError::Malformed(_) => "SnapshotMalformed",
        SnapshotError::Partial { .. } => "SnapshotPartial",
        SnapshotError::Stale { .. } => "SnapshotStale",
        SnapshotError::BadClock(_) => "SnapshotBadClock",
        SnapshotError::BadRent(_) => "SnapshotBadRent",
    }
}
fn refusal_code(e: &Refusal) -> &'static str {
    match e {
        Refusal::State(b) => common_code(b),
        Refusal::Snapshot(e) => snapshot_code(e),
        Refusal::HostMustBeOriginal => "HostMustBeOriginal",
        Refusal::StandingMustBeWide => "StandingMustBeWide",
        Refusal::OriginalOwnerRequired => "OriginalOwnerRequired",
        Refusal::MissingReads(_) => "MissingReads",
        Refusal::ExecutableAccount(_) => "ExecutableAccount",
        Refusal::OriginalAccount(_) => "OriginalAccount",
        Refusal::SourceGeneration => "SourceGeneration",
        Refusal::SourceNotLive => "SourceNotLive",
        Refusal::HostNotIssued => "HostNotIssued",
        Refusal::OwnerChanged => "OwnerChanged",
        Refusal::CitizenBinding => "CitizenBinding",
        Refusal::InvalidTransitOccupancy => "InvalidTransitOccupancy",
        Refusal::OrdinaryTransitOpen => "OrdinaryTransitOpen",
        Refusal::DuplicateTransit => "DuplicateTransit",
        Refusal::OwnedBridgeRequired => "OwnedBridgeRequired",
        Refusal::BridgePair => "BridgePair",
        Refusal::BridgeOwner => "BridgeOwner",
        Refusal::BridgeDestination => "BridgeDestination",
        Refusal::OrphanBridge => "OrphanBridge",
        Refusal::ResidentMissingHistoryRequired => "ResidentMissingHistoryRequired",
        Refusal::LeavePayloadUnsupported => "LeavePayloadUnsupported",
        Refusal::ResidentBusy => "ResidentBusy",
        Refusal::ResolveBehind => "ResolveBehind",
        Refusal::ClockMissing => "ClockMissing",
        Refusal::ClockBeforeGenesis => "ClockBeforeGenesis",
        Refusal::PendingBellInFuture => "PendingBellInFuture",
    }
}
fn common_code(b: &Block) -> &'static str {
    match b {
        Block::Read(_) => "Read",
        Block::Season(_) => "Season",
        Block::SeasonStatus(_) => "SeasonStatus",
        Block::SeasonDependsOnClock => "SeasonDependsOnClock",
        Block::SeasonNotStarted { .. } => "SeasonNotStarted",
        Block::DeploymentUnpinned => "DeploymentUnpinned",
        Block::ProgramVersion { .. } => "ProgramVersion",
        Block::RulesetHash => "RulesetHash",
        Block::World => "World",
        Block::Absent(_) => "Absent",
        Block::ForeignOwner(_) => "ForeignOwner",
        Block::Unreadable(_) => "Unreadable",
        Block::NotCanonical(_) => "NotCanonical",
        Block::TimingNeedsClock => "TimingNeedsClock",
        Block::Overflow(_) => "Overflow",
        Block::CapturePending => "CapturePending",
        Block::BadEntry => "BadEntry",
        Block::EntryUnpaired => "EntryUnpaired",
        Block::RosterUnpaired => "RosterUnpaired",
        Block::ReserveOverflow { .. } => "ReserveOverflow",
        Block::SeasonEnded => "SeasonEnded",
        Block::ChainOverflow(_) => "ChainOverflow",
        _ => "UnsupportedPlannerBlock",
    }
}
