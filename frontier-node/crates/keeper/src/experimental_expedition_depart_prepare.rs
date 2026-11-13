//! Bounded one-shot **unsigned** Depart preparation for the host-only
//! expedition dispatch build; never starts a keeper, reads a key or sends.
//!
//! The caller names an original-issued host at its current original standing,
//! a wallet and payer, a transit slot, an arrival bell, a tip and an already
//! public commit/seal pair. The canonical proposal is rebuilt from those facts
//! with `fclient::original_expedition_depart_draft::Draft::for_wallet` and must
//! equal the caller's proposal byte for byte, role for role.
//!
//! One sealed snapshot of exactly the departure's canonical accounts (its
//! meta, key set and digest verified; its own context slot used, never the
//! Clock's) is then checked as the program's `stage_depart` would check it
//! before its first effect: the Season's PDA, bump, revision, ruleset and
//! running clock; exact v2 layouts; the Citizen's wallet and home-slot
//! binding; the Holding's owner, generation, issued sequence, identity and
//! finality; the home Province's address and capture lock wherever the host
//! stands; the standing Province's coordinates; resolution, the roster entry
//! (not busy, a tile and faction of the province) and the kernel's
//! `Host::depart` with the program's march stamina; no slot holding the host
//! and the selected slot and its external account free; the arrival window
//! (`bell+2 ..= bell+72`, before `end_bell`); the minimum tip; and, on scratch
//! values, the escrow sum, the player bucket debit and the arrivals count.
//! Only then is a fresh blockhash observation compiled into an unsigned
//! Message by `prepare_depart`.
//!
//! This is the preparation of unsigned bytes, not a simulation: the Holding's
//! economic queue (`load_touched` / `write_holding`), payer funds and rent,
//! wallet authorization and the program's lazy finality flip are not
//! reproduced, and a snapshot is coherence, not authority. Those remain in
//! `not_proven` (economics among them). The commit and seal stay opaque:
//! only the program's seal-flag syntax is checked and the report always says
//! `seal_verified: false`. A prepared report keeps `host_only: true` and every
//! admission/sign/send flag `false`.
use crate::experimental_expedition_prepare::Settings;
use crate::wideduty::{self, Deployment, Scope};
use crate::widesnapshot::SnapshotSource;
use base64::Engine;
use fclient::{
    abi::status,
    blockhash_preflight::ObservedBlockhash,
    clock::SeasonClock,
    decode::{Citizen, Holding, Province, Season},
    experimental_expedition_message::{prepare_depart, Target},
    original_expedition_depart_draft::{Draft, NOT_PROVEN},
    tx::TxBudget,
    unsigned_message_preflight::Limits,
};
use frontier_abi::bytes::{rd_u32, rd_u64, rd_u8};
use frontier_abi::entry::{find_entry, read_entry};
use frontier_abi::layout::player::transit as T;
// (v1 prefix offsets of v2 accounts, as the program's own prologue reads them)
use frontier_abi::layout::player::{citizen as C1, holding as H1};
use frontier_abi::world_index::tiles::TileAddress;
use frontier_abi::layout::province::entry as E;
use frontier_abi::prologue::{holding_transit_occupancy, resident_ok, TransitOccupancy};
use frontier_abi::v2::layout::{player::holding as H, province::province as P, AccountKind};
use frontier_abi::world_index::{
    expedition::AccountResolver, expedition_dispatch_ix, holding as wh, seal::WIDE_SEAL_LEN,
    ProvinceKey, WideCoord, WideHostRef,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use solana_address::Address;
use std::{future::Future, io::Read};

pub const REQUEST_SCHEMA: &str = "frontier-experimental-expedition-depart-prepare-request-v1";
pub const REPORT_SCHEMA: &str = "frontier-experimental-expedition-depart-prepare-report-v1";
pub const MAX_REQUEST_BYTES: usize = 16 * 1024;
pub const MAX_OUTPUT_BYTES: usize = 64 * 1024;
/// Domain of the proposal digest: binds program, Season, inner bytes and roles.
pub const DIGEST_DOMAIN: &[u8] = b"PSF-ORIGINAL-DEPART-DRAFT-v1";
/// The stamina Depart charges, as `permutation-frontier::proc::host::DEPART_STAMINA`.
pub const DEPART_STAMINA: u16 = permutation_rules::frontier::travel::march_stamina(
    permutation_rules::frontier::travel::MAX_PATH_STEPS as u32,
);
/// Canonical role indices of `EXPEDITION_DEPART` (the draft's order).
const SEASON: usize = 2;
const CITIZEN: usize = 3;
const HOLDING: usize = 4;
const STANDING: usize = 5;
const HOME: usize = 7;
const TRANSIT: usize = 8;

pub struct Request {
    echo: Value,
    scope: Scope,
    wallet: Address,
    payer: Address,
    draft: Draft,
    min_slot: u64,
    digest: [u8; 32],
}
impl Request {
    pub fn program(&self) -> Address {
        self.scope.program
    }
    pub fn echo(&self) -> &Value {
        &self.echo
    }
    pub fn draft(&self) -> &Draft {
        &self.draft
    }
    pub fn content_digest(&self) -> [u8; 32] {
        self.digest
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
/// Canonical unsigned decimal string (no sign, no leading zero, ≤ 20 digits).
fn decimal<T: std::str::FromStr>(v: &Value) -> Result<T, &'static str> {
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
/// Canonical signed decimal string (`-0` refused).
fn signed<T: std::str::FromStr>(v: &Value) -> Result<T, &'static str> {
    let s = v.as_str().ok_or("RequestInvalid")?;
    let d = s.strip_prefix('-').unwrap_or(s);
    if d.is_empty()
        || d.len() > 20
        || !d.bytes().all(|b| b.is_ascii_digit())
        || (d.len() > 1 && d.starts_with('0'))
        || s == "-0"
    {
        return Err("RequestInvalid");
    }
    s.parse().map_err(|_| "RequestInvalid")
}
fn address(v: &Value) -> Result<Address, &'static str> {
    let s = v.as_str().filter(|s| s.len() <= 44).ok_or("RequestInvalid")?;
    let a: Address = s.parse().map_err(|_| "RequestInvalid")?;
    if a == Address::default() || a.to_string() != s {
        return Err("RequestInvalid");
    }
    Ok(a)
}

/// The proposal digest over the canonical draft (never over caller bytes).
pub fn content_digest(d: &Draft) -> [u8; 32] {
    let bytes = d.proposed_bytes();
    let roles = d.roles();
    let mut h = Sha256::new();
    h.update(DIGEST_DOMAIN);
    h.update(d.program().to_bytes());
    h.update(d.season().to_bytes());
    h.update((bytes.len() as u32).to_le_bytes());
    h.update(bytes);
    h.update((roles.len() as u32).to_le_bytes());
    for r in roles {
        h.update((r.name.len() as u32).to_le_bytes());
        h.update(r.name.as_bytes());
        h.update(r.address.to_bytes());
        h.update([r.signer as u8, r.writable as u8]);
    }
    h.finalize().into()
}
fn roles_json(d: &Draft) -> Vec<Value> {
    d.roles()
        .iter()
        .map(|r| json!({"name":r.name,"address":r.address.to_string(),"signer":r.signer,"writable":r.writable}))
        .collect()
}
/// The proposal a request must carry for `d`.
pub fn canonical_proposal(d: &Draft) -> Value {
    json!({"bytes_hex":hex::encode(d.proposed_bytes()),"content_digest":hex::encode(content_digest(d)),"roles":roles_json(d)})
}

const FIELDS: &[&str] = &[
    "schema",
    "request_id",
    "cluster",
    "program",
    "season",
    "deployment",
    "wallet",
    "payer",
    "host",
    "standing",
    "transit_slot",
    "arrive_bell",
    "tip",
    "public_commit",
    "public_seal",
    "min_slot",
    "proposal",
];

/// Strict request validation. Codes, in the order they are checked:
/// `RequestInvalid` (shape, encoding, scope), `VersionUnsupported` (not the
/// host-only dispatch revision), `TransitSlotInvalid`, `SealAbsent` (an all-zero
/// commit or seal: nothing public to carry), `ProposalUnavailable` (no canonical
/// draft for these facts) and `ProposalMismatch` (the caller's bytes, digest or
/// roles differ from the canonical draft).
pub fn parse_request(bytes: &[u8]) -> Result<Request, &'static str> {
    if bytes.len() > MAX_REQUEST_BYTES {
        return Err("RequestInvalid");
    }
    let echo: Value = serde_json::from_slice(bytes).map_err(|_| "RequestInvalid")?;
    if !exact(&echo, FIELDS) || echo["schema"] != REQUEST_SCHEMA {
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
    let cluster = echo["cluster"].as_str().ok_or("RequestInvalid")?;
    if cluster.is_empty()
        || cluster.len() > 32
        || !cluster
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
    {
        return Err("RequestInvalid");
    }
    let d = &echo["deployment"];
    if !exact(d, &["program_version", "ruleset_hash"]) {
        return Err("RequestInvalid");
    }
    let version: u16 = decimal(&d["program_version"])?;
    let ruleset_hash = hex_bytes::<32>(&d["ruleset_hash"])?;
    let program = address(&echo["program"])?;
    let season = address(&echo["season"])?;
    let wallet = address(&echo["wallet"])?;
    let payer = address(&echo["payer"])?;
    if program == season {
        return Err("RequestInvalid");
    }
    let s = &echo["standing"];
    if !exact(s, &["p", "q"]) {
        return Err("RequestInvalid");
    }
    let host_bytes = hex_bytes::<56>(&echo["host"])?;
    let slot: u8 = decimal(&echo["transit_slot"])?;
    let arrive_bell: u32 = decimal(&echo["arrive_bell"])?;
    let tip: u64 = decimal(&echo["tip"])?;
    let commit = hex_bytes::<32>(&echo["public_commit"])?;
    let seal = hex_bytes::<WIDE_SEAL_LEN>(&echo["public_seal"])?;
    let min_slot: u64 = decimal(&echo["min_slot"])?;
    let proposal = &echo["proposal"];
    if !exact(proposal, &["bytes_hex", "content_digest", "roles"])
        || !proposal["bytes_hex"].is_string()
        || !proposal["content_digest"].is_string()
        || !proposal["roles"].as_array().is_some_and(|a| a.len() == 9)
    {
        return Err("RequestInvalid");
    }
    if version != expedition_dispatch_ix::PROGRAM_VERSION {
        return Err("VersionUnsupported");
    }
    if slot >= 4 {
        return Err("TransitSlotInvalid");
    }
    if commit == [0; 32] || seal.iter().all(|b| *b == 0) {
        return Err("SealAbsent");
    }
    // The program's Depart syntax check (`proc::host::seal_flag_ok`): a
    // compressed G2 point's first byte, compression set and infinity clear.
    // Syntax only; validity is SettleTransit's and `seal_verified` stays false.
    if seal[0] & 0x80 == 0 || seal[0] & 0x40 != 0 {
        return Err("SealSyntax");
    }
    let scope = Scope {
        program,
        season,
        deployment: Some(Deployment {
            program_version: version,
            ruleset_hash,
        }),
    };
    let ctx = wideduty::ctx_of(&scope);
    let resolver = AccountResolver::for_season(&ctx).map_err(|_| "ProposalUnavailable")?;
    let coord = WideCoord::checked(signed(&s["p"])?, signed(&s["q"])?)
        .map_err(|_| "ProposalUnavailable")?;
    let standing = ProvinceKey::new(resolver.adapter().world(), coord);
    let host = WideHostRef::from_bytes(&host_bytes).map_err(|_| "ProposalUnavailable")?;
    let draft = Draft::for_wallet(
        &ctx,
        host,
        standing,
        wallet,
        payer,
        slot,
        arrive_bell,
        tip,
        commit,
        seal,
    )
    .map_err(|_| "ProposalUnavailable")?;
    if *proposal != canonical_proposal(&draft) {
        return Err("ProposalMismatch");
    }
    let digest = content_digest(&draft);
    Ok(Request {
        echo,
        scope,
        wallet,
        payer,
        draft,
        min_slot,
        digest,
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

fn closed(mut v: Value) -> Value {
    for k in [
        "ready",
        "deployment_verified",
        "admitted",
        "signed",
        "enqueued",
        "relay_submission_available",
        "automatic_send",
        "seal_verified",
    ] {
        v[k] = Value::Bool(false);
    }
    v["host_only"] = Value::Bool(true);
    v
}
pub fn failure(request: Option<&Request>, code: &str) -> Value {
    closed(json!({"schema":REPORT_SCHEMA,"status":"blocked","request":request.map(|r|r.echo.clone()),
        "source":null,"blockhash":null,"prepared":null,"blocker":{"code":code},"not_proven":NOT_PROVEN}))
}
pub fn output_bytes(value: &Value) -> Vec<u8> {
    match serde_json::to_vec(value) {
        Ok(bytes) if bytes.len() <= MAX_OUTPUT_BYTES => bytes,
        _ => serde_json::to_vec(&failure(None, "OutputTooLarge")).unwrap_or_default(),
    }
}

type Accounts = std::collections::BTreeMap<Address, Option<fclient::ports::Account>>;

/// A snapshot account that must exist, be owned by `program`, not be
/// executable and carry the exact v2 layout of `kind` for Season `season_id`
/// (size, magic, Season id, layout version 2), as the program's `present_v2`.
fn v2<'a>(
    accounts: &'a Accounts,
    key: &Address,
    program: &Address,
    kind: AccountKind,
    season_id: u64,
) -> Result<&'a [u8], &'static str> {
    let a = match accounts.get(key) {
        Some(Some(a)) => a,
        Some(None) => return Err("SourceAbsent"),
        None => return Err("SnapshotMismatch"),
    };
    if a.owner != *program || a.executable {
        return Err("SourceAccount");
    }
    let d = &a.data;
    if d.len() != kind.size()
        || d.get(..8) != Some(kind.magic().as_slice())
        || d.get(8..16).map(|b| u64::from_le_bytes(b.try_into().unwrap())) != Some(season_id)
        || d.get(16..18).map(|b| u16::from_le_bytes(b.try_into().unwrap())) != Some(2)
    {
        return Err("SourceLayout");
    }
    Ok(d)
}

impl Request {
    /// The exact snapshot key set, in request order: Season, Citizen, Holding,
    /// standing Province, home Province (when it is another account) and the
    /// selected external transit account.
    pub fn snapshot_keys(&self) -> Vec<Address> {
        let roles = self.draft.roles();
        let mut keys: Vec<Address> = Vec::with_capacity(6);
        for i in [SEASON, CITIZEN, HOLDING, STANDING, HOME, TRANSIT] {
            if !keys.contains(&roles[i].address) {
                keys.push(roles[i].address);
            }
        }
        keys
    }
}

/// The snapshot and blockhash providers are injected for key-free tests; the
/// one-shot binary would supply only read-only RPC. No send port exists here.
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
    // The configured target and payer, never the request's alone.
    if r.scope.program != s.program
        || r.scope.season != s.season
        || r.payer != s.fee_payer
        || r.scope.deployment.as_ref().map(|d| d.ruleset_hash) != Some(s.ruleset_hash)
    {
        return Err("ScopeMismatch");
    }
    let roles = r.draft.roles();
    let keys = r.snapshot_keys();
    let snap = source
        .snapshot_boxed(&keys, false, r.min_slot)
        .await
        .map_err(|_| "SourceUnavailable")?;
    // ---- one sealed response for exactly this key set (fclient's own check)
    let clock = snap.clock();
    let meta = snap.meta();
    let accounts = snap.accounts();
    if meta.min_slot() != r.min_slot
        || meta.context_slot() < r.min_slot
        || snap.rent().is_some()
        || accounts.len() != keys.len()
        || keys.iter().any(|k| !accounts.contains_key(k))
        || !meta.verify(r.min_slot, Some(&clock), None, accounts)
    {
        return Err("SnapshotMismatch");
    }
    // The response's own context slot, never the Clock's slot.
    let context = meta.context_slot();
    let now = clock.unix_timestamp;
    // ---- Season: this deployment, running, its clock
    let sa = match accounts.get(&roles[SEASON].address) {
        Some(Some(a)) if a.owner == s.program && !a.executable => a,
        Some(Some(_)) => return Err("SourceAccount"),
        _ => return Err("SourceAbsent"),
    };
    let season = Season::decode(&sa.data).map_err(|_| "SourceLayout")?;
    let sid = season.h.season_id;
    // The configured Season is this Season id's canonical PDA with its stored
    // bump (`player_start_as`: `season_pda(id, bump) == key(season)`).
    let (pda, bump) = fclient::addr::season_pda(&s.program, sid);
    if pda != s.season || bump != season.bump {
        return Err("SeasonAddress");
    }
    v2(accounts, &roles[SEASON].address, &s.program, AccountKind::Season, sid)?;
    if season.program_version != expedition_dispatch_ix::PROGRAM_VERSION
        || season.ruleset_hash != s.ruleset_hash
    {
        return Err("DeploymentMismatch");
    }
    if season.effective_status(now) != status::RUNNING {
        return Err("SeasonNotRunning");
    }
    let bell = SeasonClock::from_season(&season)
        .bell_at(now)
        .ok_or("SeasonNotRunning")?;
    // ---- the original issuer Holding and its owner (stage_depart's checks)
    let ctx = wideduty::ctx_of(&r.scope);
    let resolver = AccountResolver::for_season(&ctx).map_err(|_| "ProposalUnavailable")?;
    let host = WideHostRef::from_bytes(&r.draft.command().host).map_err(|_| "ProposalUnavailable")?;
    let id = resolver.legacy_host_id(&host).map_err(|_| "ProposalUnavailable")?;
    let cd = v2(accounts, &roles[CITIZEN].address, &s.program, AccountKind::Citizen, sid)?;
    let hd = v2(accounts, &roles[HOLDING].address, &s.program, AccountKind::Holding, sid)?;
    let pd = v2(accounts, &roles[STANDING].address, &s.program, AccountKind::Province, sid)?;
    let home = v2(accounts, &roles[HOME].address, &s.program, AccountKind::Province, sid)?;
    let citizen = Citizen::decode(cd).map_err(|_| "SourceLayout")?;
    let holding = Holding::decode(hd).map_err(|_| "SourceLayout")?;
    let standing = Province::decode(pd).map_err(|_| "SourceLayout")?;
    let home_p = Province::decode(home).map_err(|_| "SourceLayout")?;
    if citizen.wallet != r.wallet || roles[0].address != r.wallet {
        return Err("OwnerMismatch");
    }
    if holding.owner_citizen != roles[CITIZEN].address {
        return Err("OwnerMismatch");
    }
    if holding.gen != host.gen() {
        return Err("SourceGeneration");
    }
    if host.seq() >= holding.host_seq {
        return Err("HostNotIssued");
    }
    let parts = frontier_abi::addr::split_host_id(id).ok_or("ProposalUnavailable")?;
    if i32::from(holding.p) != parts.province.p
        || i32::from(holding.q) != parts.province.q
        || holding.site != parts.site
        || home_p.p != holding.p
        || home_p.q != holding.q
    {
        return Err("SourceIdentity");
    }
    // The Citizen's home slot binds this exact Holding.
    if !(1..=3).contains(&holding.order)
        || wh::binding_of(cd, holding.order).map_err(|_| "CitizenBinding")?
            != wh::SlotBinding::Legacy(wh::HoldingRef {
                p: holding.p,
                q: holding.q,
                site: holding.site,
                gen: holding.gen,
            })
    {
        return Err("CitizenBinding");
    }
    // ---- standing: capture lock at home, finality, residency, the roster entry
    // The Holding's own Province, wherever the host stands, at the canonical
    // address of the Holding's (P, Q) and free of a capture lock
    // (`proc::conquest::check_source_province`, called by every Depart).
    if Address::new_from_array(ctx.province(i32::from(holding.p), i32::from(holding.q)))
        != roles[HOME].address
    {
        return Err("SourceIdentity");
    }
    wideduty::capture_lock_of(home, hd).map_err(|_| "CaptureLocked")?;
    // The standing Province's own coordinates name its canonical address
    // (`stage_depart`: `expect_key(province, ctx.province(pp, pq))`).
    if Address::new_from_array(ctx.province(i32::from(standing.p), i32::from(standing.q)))
        != roles[STANDING].address
    {
        return Err("StandingIdentity");
    }
    // (the program may promote a due Holding to final itself; a snapshot that
    // does not already show it final is not enough here)
    if holding.state != H::STATE_FINAL {
        return Err("SourceNotFinal");
    }
    let rn = rd_u32(pd, P::RESOLVED_NEXT).ok_or("SourceLayout")?;
    if !resident_ok(rn, bell) {
        return Err("NotResident");
    }
    // ---- transit: the host is in no slot, the selected slot is free
    let occupancy = holding_transit_occupancy(&ctx, &roles[HOLDING].address.to_bytes(), hd)
        .map_err(|_| "TransitState")?;
    for (i, state) in occupancy.iter().enumerate() {
        if *state != TransitOccupancy::Free && rd_u64(hd, H::transit(i) + T::HOST_ID) == Some(id) {
            return Err("HostInTransit");
        }
    }
    let slot = r.draft.command().transit_slot as usize;
    if occupancy.get(slot) != Some(&TransitOccupancy::Free)
        || rd_u8(hd, H::transit(slot) + T::STATE) != Some(T::STATE_FREE)
    {
        return Err("TransitSlotBusy");
    }
    match accounts.get(&roles[TRANSIT].address) {
        Some(None) => {}
        Some(Some(a)) if fclient::decode::is_absent(&a.owner, &a.data) => {}
        Some(Some(_)) => return Err("TransitSlotBusy"),
        None => return Err("SnapshotMismatch"),
    }
    let index = find_entry(pd, id).ok_or("NotResident")?;
    let entry = read_entry(pd, index).map_err(|_| "SourceLayout")?;
    if entry.state != E::STATE_ROSTER {
        return Err("NotResident");
    }
    if entry.busy() {
        return Err("HostBusy");
    }
    // The kernel's own departure rule with the program's charge
    // (`proc::host::DEPART_STAMINA` = the longest path's march stamina):
    // stamina, cooldown and resolution, on a scratch copy of the host.
    let mut kernel_host = entry.to_host().map_err(|_| "SourceLayout")?;
    kernel_host
        .depart(bell, DEPART_STAMINA, rn)
        .map_err(|_| "HostCannotDepart")?;
    // ---- arrival window and tip, as the program bounds them
    let arrive = r.draft.command().arrive_bell;
    if bell.checked_add(2).is_none_or(|min| arrive < min)
        || bell.checked_add(72).is_none_or(|max| arrive > max)
        || arrive >= season.end_bell
    {
        return Err("ArrivalBell");
    }
    if r.draft.command().tip
        < fclient::fees::min_tip_lamports(
            season.min_reveal_priority_milli,
            season.reveal_cu_limit,
            season.reveal_loaded_limit,
        )
    {
        return Err("TipTooLow");
    }
    // ---- what stage_depart computes from the entry (524–537): a tile of the
    // standing Province and a faction with a doctrine
    let origin_key = ProvinceKey::new(
        resolver.adapter().world(),
        WideCoord::checked(i64::from(standing.p), i64::from(standing.q))
            .map_err(|_| "StandingIdentity")?,
    );
    TileAddress::new(origin_key, entry.tile).map_err(|_| "EntryInvalid")?;
    if permutation_rules::frontier::doctrine::of_faction_v3(entry.faction).is_none() {
        return Err("EntryInvalid");
    }
    // ---- the writes it would make (513–570), on scratch values: the escrow and
    // its sum into the Holding, the player bucket, the Citizen's arrivals
    let escrow = r
        .draft
        .command()
        .tip
        .checked_add(season.march_fee)
        .and_then(|n| n.checked_add(season.seal_bond))
        .ok_or("EscrowOverflow")?;
    rd_u64(hd, H1::ESCROW)
        .ok_or("SourceLayout")?
        .checked_add(escrow)
        .ok_or("EscrowOverflow")?;
    let mut scratch = cd.to_vec();
    frontier_abi::prologue::debit_bucket(
        &mut scratch,
        now,
        season.genesis_ts,
        season.bucket_rate_per_h,
        season.bucket_burst,
    )
    .map_err(|_| "Bucket")?;
    if bell >= season.end_bell {
        return Err("SeasonNotRunning");
    }
    rd_u32(cd, C1::ARRIVALS)
        .ok_or("SourceLayout")?
        .checked_add(1)
        .ok_or("ArrivalsOverflow")?;
    wideduty::chain_headroom(cd, 1, "original citizen").map_err(|_| "ChainHeadroom")?;
    wideduty::chain_headroom(hd, 1, "original holding").map_err(|_| "ChainHeadroom")?;
    wideduty::chain_headroom(pd, 1, "standing").map_err(|_| "ChainHeadroom")?;
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
        // The one fixed heap frame of a Depart (fclient: measured on the real SBF program, which does not
        // complete a Depart in the default 32 KiB). Not a setting: no operator or request chooses it.
        heap: Some(fclient::experimental_expedition_message::DEPART_HEAP_FRAME),
    };
    let prepared = prepare_depart(
        &r.draft,
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
    // The compiled instruction must carry exactly the canonical inner bytes.
    let expected = expedition_dispatch_ix::encode(
        expedition_dispatch_ix::Kind::Depart,
        &r.draft.proposed_bytes(),
    )
    .map_err(|_| "PreflightFailed")?;
    if prepared.instruction().data != expected {
        return Err("PreflightFailed");
    }
    let message = prepared.message_bytes().map_err(|_| "PreflightFailed")?;
    let report = prepared.report();
    let hash = observed.observation;
    Ok(closed(json!({"schema":REPORT_SCHEMA,"status":"prepared","request":r.echo,
        "source":{"context_slot":context.to_string(),"unix_timestamp":clock.unix_timestamp.to_string(),"current_bell":bell.to_string(),
            "arrive_bell":arrive.to_string(),"transit_slot_free":true,"coherent":true,"authority_verified":false},
        "blockhash":{"hash":fclient::Hash::new_from_array(hash.blockhash).to_string(),"latest_context_slot":observed.latest_context_slot.to_string(),"validity_context_slot":hash.context_slot.to_string(),"height_min_context_slot":observed.height_min_context_slot.to_string(),"block_height":hash.block_height.to_string(),"last_valid_block_height":hash.last_valid_block_height.to_string(),"remaining_block_heights":report.remaining_block_heights.to_string(),"valid":true,"commitment":"confirmed","coherent":false,"authority_verified":false},
        "prepared":{"program":s.program.to_string(),"season":s.season.to_string(),"program_version":expedition_dispatch_ix::PROGRAM_VERSION.to_string(),"action":"Depart","fee_payer":s.fee_payer.to_string(),
            "budget":{"cu_limit":budget.cu_limit,"cu_price":"0","loaded_limit":budget.loaded_limit,"heap":budget.heap},"roles":roles_json(&r.draft),
            "instruction_hex":hex::encode(&prepared.instruction().data),"message_b64":base64::engine::general_purpose::STANDARD.encode(&message),"message_digest":hex::encode(Sha256::digest(&message)),
            "signers":prepared.expected_signers().iter().map(ToString::to_string).collect::<Vec<_>>(),"shape":{"bytes":report.shape.bytes,"locks":report.shape.locks,"writes":report.shape.writes,"sigs":report.shape.sigs},
            "proposal_digest":hex::encode(r.digest)},
        "blocker":null,"not_proven":NOT_PROVEN})))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn addr(n: u8) -> String {
        Address::new_from_array([n; 32]).to_string()
    }
    /// Well-formed in every field; the host bytes are a placeholder, so a
    /// request that passes every earlier check stops at `ProposalUnavailable`.
    fn base() -> Value {
        json!({"schema":REQUEST_SCHEMA,"request_id":"r1","cluster":"localnet","program":addr(1),"season":addr(2),
            "deployment":{"program_version":expedition_dispatch_ix::PROGRAM_VERSION.to_string(),"ruleset_hash":"ab".repeat(32)},
            "wallet":addr(3),"payer":addr(4),"host":"00".repeat(56),"standing":{"p":"1","q":"0"},
            "transit_slot":"0","arrive_bell":"10","tip":"0","public_commit":"11".repeat(32),"public_seal":"a2".repeat(WIDE_SEAL_LEN),
            "min_slot":"5","proposal":{"bytes_hex":"","content_digest":"","roles":vec![Value::Null; 9]}})
    }
    fn code(v: &Value) -> &'static str {
        match parse_request(&serde_json::to_vec(v).unwrap()) {
            Ok(_) => "Ok",
            Err(c) => c,
        }
    }

    #[test]
    fn shape_and_encoding_refusals() {
        let mut v = base();
        v["schema"] = json!("frontier-experimental-expedition-prepare-request-v1");
        assert_eq!(code(&v), "RequestInvalid");
        let mut v = base();
        v["extra"] = json!(1);
        assert_eq!(code(&v), "RequestInvalid");
        let mut v = base();
        v.as_object_mut().unwrap().remove("tip");
        assert_eq!(code(&v), "RequestInvalid");
        for (k, bad) in [
            ("arrive_bell", json!("010")),
            ("tip", json!("-1")),
            ("min_slot", json!(5)),
            ("public_commit", json!("AB".repeat(32))),
            ("public_seal", json!("22".repeat(WIDE_SEAL_LEN - 1))),
            ("host", json!("00".repeat(55))),
            ("payer", json!(Address::default().to_string())),
            ("request_id", json!("a b")),
            ("cluster", json!("Local")),
        ] {
            let mut v = base();
            v[k] = bad;
            assert_eq!(code(&v), "RequestInvalid", "{k}");
        }
        let mut v = base();
        v["season"] = v["program"].clone();
        assert_eq!(code(&v), "RequestInvalid");
        let mut v = base();
        v["proposal"]["roles"] = json!([]);
        assert_eq!(code(&v), "RequestInvalid");
        assert_eq!(
            parse_request(&vec![b' '; MAX_REQUEST_BYTES + 1]).err(),
            Some("RequestInvalid")
        );
    }

    #[test]
    fn version_slot_and_absent_seal_are_refused_before_any_draft() {
        let mut v = base();
        v["deployment"]["program_version"] = json!((expedition_dispatch_ix::PROGRAM_VERSION ^ 0x0800).to_string());
        assert_eq!(code(&v), "VersionUnsupported");
        let mut v = base();
        v["transit_slot"] = json!("4");
        assert_eq!(code(&v), "TransitSlotInvalid");
        let mut v = base();
        v["public_commit"] = json!("00".repeat(32));
        assert_eq!(code(&v), "SealAbsent");
        let mut v = base();
        v["public_seal"] = json!("00".repeat(WIDE_SEAL_LEN));
        assert_eq!(code(&v), "SealAbsent");
        // compression flag clear, or infinity flag set: the program's syntax refusal
        for first in ["22", "e2"] {
            let mut v = base();
            v["public_seal"] = json!(format!("{first}{}", "a2".repeat(WIDE_SEAL_LEN - 1)));
            assert_eq!(code(&v), "SealSyntax", "{first}");
        }
        // Every earlier check passes; the placeholder host either has no
        // canonical draft or one whose proposal differs from the empty one.
        assert!(matches!(code(&base()), "ProposalUnavailable" | "ProposalMismatch"));
    }

    #[test]
    fn failure_report_stays_closed() {
        let v = failure(None, "SourceUnavailable");
        assert_eq!(v["schema"], REPORT_SCHEMA);
        assert_eq!(v["status"], "blocked");
        assert_eq!(v["host_only"], true);
        for k in [
            "ready",
            "deployment_verified",
            "admitted",
            "signed",
            "enqueued",
            "relay_submission_available",
            "automatic_send",
            "seal_verified",
        ] {
            assert_eq!(v[k], false, "{k}");
        }
        assert_eq!(v["prepared"], Value::Null);
        assert_eq!(v["not_proven"].as_array().map(Vec::len), Some(NOT_PROVEN.len()));
        assert!(output_bytes(&v).len() <= MAX_OUTPUT_BYTES);
    }
}
