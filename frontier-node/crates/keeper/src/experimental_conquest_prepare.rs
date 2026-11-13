//! Bounded one-shot preparation of the one player-signed conquest step: a wide
//! `DeclareSiege` by an original host that stays in a wide province, on that
//! province's Free City site. Never starts a keeper or uses keys.
//!
//! ONE fresh snapshot, then unsigned Message bytes. The snapshot is the union
//! of the keys the existing original-host inspection reads (the Season, the
//! Citizen, the host's village and its Province, the wide province, ITS ROSTER,
//! the bridges) and the conquest step's own (the target holding position, the
//! conquest table, the capture escrow). Every check is made on those same bytes
//! at that one context slot; the report's context, digest and blockhash floor
//! are that snapshot's:
//!   - the existing inspection's own planner (`wideexpedition::plan`), on this
//!     snapshot: the roster entry is paired with exactly the selected host's
//!     56-byte reference, the host is resident (state 1) with nothing pending
//!     (`OwnerDissolve` is the next step it could take: no Leave, no Spend, no
//!     bridge in flight), at the roster entry the request names. An entry
//!     reused by another host of the same village (another sequence or
//!     generation) is not the selected host and is refused by that pairing;
//!   - the site is a Free City (state 5, generation 0, order 0, NEUTRAL), the
//!     entry stands on that site's tile, the holding position is absent.
//! Nothing is taken from an earlier read: a request's `source_context_slot` is
//! only a floor.
//!
//! What is NOT judged here and stays the program's: that the host leads on the
//! tile, the Citizen's free slot, stake, arms and daily cap, the province
//! being resolved through the current bell, and the conquest table's state.
//! A prepared message is therefore a proposal the program may still refuse.
//!
//! The outer dispatch kind exists only with `conquest-dispatch-experimental`.
//! Without it every check above still runs and the answer is the closed blocker
//! `DispatchKindUnavailable`: nothing is wrapped under a guessed kind.
//!
//! Neither the selected snapshot nor an RPC response grants execution consent.
use crate::{wideexpedition_preview as preview, widesnapshot::SnapshotSource};
// (the report's `source.request_digest` stays the inspection request's own digest; `source.digest` and
// `source.context_slot` are the ONE union snapshot's)
use fclient::{blockhash_preflight::ObservedBlockhash, wide_conquest_draft::Draft};
use frontier_abi::bytes::rd_u8;
use frontier_abi::entry::read_entry;
use frontier_abi::layout::province::province as PV;
use frontier_abi::layout::province::site as SM;
use frontier_abi::v2::layout::province::site as SM2;
use frontier_abi::world_index::expedition_dispatch_ix;
use permutation_rules::frontier::clash::NEUTRAL;
use serde_json::{json, Value};
use solana_address::Address;
use std::{future::Future, io::Read};

pub use crate::experimental_expedition_prepare::Settings;

pub const REQUEST_SCHEMA: &str = "frontier-local-play-conquest-prepare-request-v1";
pub const REPORT_SCHEMA: &str = "frontier-local-play-conquest-prepare-report-v1";
pub const MAX_REQUEST_BYTES: usize = 16 * 1024;
pub const MAX_OUTPUT_BYTES: usize = 32 * 1024;

pub struct Request {
    echo: Value,
    source: preview::Request,
    site: u8,
    entry: u8,
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
fn small(v: &Value, limit: u64) -> Result<u8, &'static str> {
    v.as_u64()
        .filter(|n| *n < limit && v.is_u64())
        .map(|n| n as u8)
        .ok_or("RequestInvalid")
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
            "target",
        ],
    ) || echo["schema"] != REQUEST_SCHEMA
        || echo["action"] != "DeclareSiege"
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
    let source = preview::parse_request(
        &serde_json::to_vec(&echo["source_request"]).map_err(|_| "RequestInvalid")?,
    )
    .map_err(|_| "RequestInvalid")?;
    if source
        .scope()
        .deployment
        .as_ref()
        .map(|d| d.program_version)
        != Some(expedition_dispatch_ix::PROGRAM_VERSION)
    {
        return Err("RequestInvalid");
    }
    // the player acts and pays: one wallet, named twice
    if source.wallet().is_none() || source.wallet() != source.payer() {
        return Err("RequestInvalid");
    }
    let source_context_slot = decimal(&echo["source_context_slot"])?;
    if source_context_slot < source.min_slot() {
        return Err("RequestInvalid");
    }
    let digest = echo["source_snapshot_digest"]
        .as_str()
        .ok_or("RequestInvalid")?;
    if digest.len() != 64
        || !digest
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err("RequestInvalid");
    }
    let target = &echo["target"];
    if !exact(target, &["site", "entry"]) {
        return Err("RequestInvalid");
    }
    let site = small(&target["site"], u64::from(fclient::wide_conquest_draft::SITES))?;
    let entry = small(
        &target["entry"],
        u64::from(fclient::wide_conquest_draft::ENTRIES),
    )?;
    Ok(Request {
        echo,
        source,
        site,
        entry,
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

/// The site facts of the target province's bytes: `Ok(tile)` when `site` is a
/// Free City exactly as the handler requires it, else the closed blocker.
pub fn free_city_tile(province: &[u8], site: u8) -> Result<u8, &'static str> {
    let n = rd_u8(province, PV::SITE_COUNT).ok_or("SourceUnavailable")? as usize;
    let site = usize::from(site);
    if n > PV::SITES_N || site >= n {
        return Err("TargetNotFreeCity");
    }
    let o = PV::site(site);
    let at = |off| rd_u8(province, o + off).ok_or("SourceUnavailable");
    if at(SM::STATE)? != SM2::STATE_FREE_CITY
        || at(SM::GEN)? != 0
        || at(SM::ORDER)? != 0
        || at(SM::FACTION)? != NEUTRAL
    {
        return Err("TargetNotFreeCity");
    }
    rd_u8(province, PV::SITES + site).ok_or("SourceUnavailable")
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
    let wallet = r.source.wallet().ok_or("RequestInvalid")?;
    if scope.program != s.program
        || scope.season != s.season
        || wallet != s.fee_payer
        || r.source.payer() != Some(s.fee_payer)
        || scope.deployment.as_ref().map(|d| d.ruleset_hash) != Some(s.ruleset_hash)
    {
        return Err("RequestInvalid");
    }
    let ctx = crate::wideduty::ctx_of(scope);
    let selected = r.source.selected();
    if ctx.citizen(&wallet.to_bytes()) != selected.original_owner.to_bytes() {
        return Err("SiegeUnavailable");
    }
    let draft = Draft::declare_siege(
        &ctx,
        selected.host,
        selected.standing,
        r.site,
        r.entry,
        wallet,
    )
    .map_err(|_| "SiegeUnavailable")?;
    let roles = draft.roles();
    let (province_at, roster_at, position_at) =
        (roles[5].address, roles[6].address, roles[8].address);
    // ONE snapshot: the inspection's own keys and the conquest step's, no older than the request's floor
    let mut keys: Vec<Address> = r.source.required_keys().to_vec();
    if !keys.contains(&province_at) || !keys.contains(&roster_at) {
        // (the inspection must itself read the province and its roster: the pairing is made on them)
        return Err("SourceUnavailable");
    }
    for k in [position_at, roles[9].address, roles[10].address] {
        if !keys.contains(&k) {
            keys.push(k);
        }
    }
    let snap = source
        .snapshot_boxed(&keys, false, r.source_context_slot.max(r.source.min_slot()))
        .await
        .map_err(|_| "SourceUnavailable")?;
    let context = snap.meta().context_slot();
    if context < r.source_context_slot
        || snap.accounts().len() != keys.len()
        || keys.iter().any(|k| !snap.accounts().contains_key(k))
    {
        return Err("SourceBlocked");
    }
    // the inspection's planner on THIS snapshot: roster pairing with the selected host's full reference, residency, nothing pending
    let facts = crate::wideexpedition::plan(scope, selected, &snap.reads())
        .map_err(|_| "SourceBlocked")?
        .describe();
    let observed = &facts["observed"];
    if observed["kind"] != "original-host-wide-resident"
        || observed["state"] != 1
        || facts["next_prerequisite"] != "OwnerDissolve"
    {
        return Err("SiegeUnavailable");
    }
    if observed["entry"] != u64::from(r.entry) {
        return Err("HostNotOnTarget");
    }
    let province = snap
        .accounts()
        .get(&province_at)
        .and_then(|a| a.as_ref())
        .filter(|a| a.owner == s.program)
        .ok_or("SourceUnavailable")?;
    let tile = free_city_tile(&province.data, r.site)?;
    let standing =
        read_entry(&province.data, usize::from(r.entry)).map_err(|_| "HostNotOnTarget")?;
    if standing.state != 1 || standing.tile != tile {
        return Err("HostNotOnTarget");
    }
    // (the handler requires the canonical holding position to be absent)
    match snap.accounts().get(&position_at) {
        Some(None) => {}
        Some(Some(a)) if fclient::decode::is_absent(&a.owner, &a.data) => {}
        _ => return Err("SiegeUnavailable"),
    }
    let digest = hex::encode(snap.meta().digest());
    let roles_json: Vec<_> = roles.iter().map(|p| json!({"name":p.name,"address":p.address.to_string(),"signer":p.signer,"writable":p.writable})).collect();
    wrap(r, s, &draft, roles_json, context, &digest, blockhash).await
}

/// Without the conquest dispatch feature there is no outer kind: every check
/// has passed, and the answer is the closed blocker.
#[cfg(not(feature = "conquest-dispatch-experimental"))]
async fn wrap<F, Fut>(
    _r: &Request,
    _s: Settings,
    _draft: &Draft,
    _roles: Vec<Value>,
    _context: u64,
    _digest: &str,
    _blockhash: F,
) -> Result<Value, &'static str>
where
    F: FnOnce(u64) -> Fut,
    Fut: Future<Output = Result<ObservedBlockhash, ()>>,
{
    Err("DispatchKindUnavailable")
}

#[cfg(feature = "conquest-dispatch-experimental")]
async fn wrap<F, Fut>(
    r: &Request,
    s: Settings,
    draft: &Draft,
    roles: Vec<Value>,
    context: u64,
    digest: &str,
    blockhash: F,
) -> Result<Value, &'static str>
where
    F: FnOnce(u64) -> Fut,
    Fut: Future<Output = Result<ObservedBlockhash, ()>>,
{
    use base64::Engine;
    use fclient::{
        experimental_expedition_message::{
            prepare_conquest_declare, Target, CONQUEST_DECLARE_HEAP_FRAME,
        },
        tx::TxBudget,
        unsigned_message_preflight::Limits,
    };
    use sha2::{Digest, Sha256};
    let observed = blockhash(context)
        .await
        .map_err(|_| "BlockhashUnavailable")?;
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
        heap: Some(CONQUEST_DECLARE_HEAP_FRAME),
    };
    let prepared = prepare_conquest_declare(
        draft,
        Target {
            program: s.program,
            season: s.season,
            program_version: expedition_dispatch_ix::PROGRAM_VERSION,
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
    let data = &prepared.instruction().data;
    Ok(json!({"schema":REPORT_SCHEMA,"status":"prepared","request":r.echo,
        "source":{"request_digest":r.source.digest(),"context_slot":context.to_string(),"digest":digest,"coherent":true,"authority_verified":false},
        "blockhash":{"hash":fclient::Hash::new_from_array(hash.blockhash).to_string(),"latest_context_slot":observed.latest_context_slot.to_string(),
            "validity_context_slot":hash.context_slot.to_string(),"height_min_context_slot":observed.height_min_context_slot.to_string(),
            "block_height":hash.block_height.to_string(),"last_valid_block_height":hash.last_valid_block_height.to_string(),
            "remaining_block_heights":hash.last_valid_block_height.saturating_sub(hash.block_height).to_string(),
            "valid":true,"commitment":"confirmed","coherent":false,"authority_verified":false},
        "prepared":{"program":s.program.to_string(),"season":s.season.to_string(),"program_version":expedition_dispatch_ix::PROGRAM_VERSION.to_string(),
            "action":"DeclareSiege","fee_payer":s.fee_payer.to_string(),"dispatch":{"tag":data[0],"kind":data[3]},
            "budget":{"cu_limit":budget.cu_limit,"cu_price":"0","loaded_limit":budget.loaded_limit,"heap":budget.heap},"roles":roles,
            "instruction_hex":hex::encode(data),"message_b64":base64::engine::general_purpose::STANDARD.encode(&message),"message_digest":hex::encode(Sha256::digest(&message)),
            "signers":prepared.expected_signers().iter().map(ToString::to_string).collect::<Vec<_>>(),
            "shape":{"bytes":report.shape.bytes,"locks":report.shape.locks,"writes":report.shape.writes,"sigs":report.shape.sigs}},
        "blocker":null,"host_only":true,"ready":false,"deployment_verified":false,"admitted":false,"signed":false,"enqueued":false,"relay_submission_available":false,"automatic_send":false}))
}
