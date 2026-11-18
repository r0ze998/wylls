//! `frontier-operator` (devnet blocker B3 / runbook gap G4): the operator's
//! season setup against a public RPC. It runs the same steps as the
//! local stack ([`crate::setup`]): AnnounceSeason, the 24-hour lead,
//! CreateSeason, InitBeaconLogs and InitShards for the six factions.
//! The authority (the program's upgrade authority, I-51) signs from a
//! Solana CLI key file.
//!
//! - **Dry run by default.** Without `--yes-send` it prints the exact
//!   transaction plan (accounts, data, the accounts each transaction
//!   creates with their rent and float) and sends nothing.
//! - **Idempotent and resumable.** Each run reads the chain first (the
//!   Season, the 16 BeaconLogs, the 48 JoinShards) and plans only what is
//!   missing, so a run that stopped half-way (or the 24-hour lead between
//!   AnnounceSeason and CreateSeason) is finished by running it again.
//! - **Cluster guard.** The RPC URL is loopback or an `https` host on the
//!   profile's allow-list (`mainnet`/`testnet` hosts are refused whatever
//!   the profile says), and the cluster's genesis hash is read before
//!   anything else: mainnet-beta's and testnet's are always refused, and a
//!   public URL must give devnet's.
//! - **Key file guard.** A regular file (no symlink) of this user, mode
//!   600 or stricter, in the Solana CLI format. Its bytes are never printed.

use std::collections::BTreeMap;
use std::path::Path;
use std::time::{Duration, Instant};

use fclient::addr::Addresses;
use fclient::ports::ChainPort;
use fclient::{Address, Keypair, Signer};
use serde_json::{json, Value};

use crate::chain::{timed, Chain};
use crate::setup::{self, SeasonBytes, Step};

/// `getGenesisHash` of mainnet-beta: always refused.
pub const MAINNET_GENESIS: &str = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
/// `getGenesisHash` of testnet: always refused.
pub const TESTNET_GENESIS: &str = "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY";
/// `getGenesisHash` of devnet: the only genesis a public URL may give.
pub const DEVNET_GENESIS: &str = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
/// Host substrings refused whatever the profile allows (as
/// `scripts/devnet/plan.mjs` `HARD_REFUSED_RPC_HOST_PATTERNS`).
pub const HARD_REFUSED_HOST_PATTERNS: [&str; 2] = ["mainnet", "testnet"];
/// The profile format shared with `scripts/devnet/dry-run.mjs`.
pub const PROFILE_SCHEMA: &str = "wylls-devnet-profile-v1";
/// `t_create_min` = the chain clock + the program's minimum lead + this
/// margin (the AnnounceSeason must land before the lead shrinks below
/// `MIN_ANNOUNCE_LEAD_SECS`; a public cluster may take a minute or two).
pub const ANNOUNCE_MARGIN_SECS: i64 = 300;
/// Base fee per signature (one signature per setup transaction).
pub const FEE_PER_SIGNATURE: u64 = 5_000;
/// How long one setup transaction may take to finalize.
pub const LAND_LIMIT: Duration = Duration::from_secs(120);
/// The key file is at most this long (a CLI key file is ~ 230 B).
const MAX_KEY_FILE: u64 = 4_096;

pub const EXIT_OK: i32 = 0;
pub const EXIT_FAILED: i32 = 1;
pub const EXIT_REFUSED: i32 = 2;
/// AnnounceSeason landed (or had landed) and the lead is still running:
/// run again after `t_create_min` (or pass `--wait`).
pub const EXIT_WAITING: i32 = 3;

// ------------------------------------------------------------------ profile

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BeaconChoice {
    /// The preset's key (drand quicknet): the release build.
    Quicknet,
    /// The public test key (I-53): only a test-beacon build accepts it, and
    /// only on a loopback cluster.
    TestKey,
}

#[derive(Clone, Debug)]
pub struct Profile {
    pub cluster: String,
    pub rpc_url: String,
    pub allowed_hosts: Vec<String>,
    pub refused_patterns: Vec<String>,
    /// `None` while the profile holds r0ze's placeholder.
    pub program: Option<Address>,
    pub upgrade_authority: Option<Address>,
    /// `rent.assume` (lamports per byte) for the offline plan.
    pub rent_per_byte: u64,
    pub preset: String,
    pub season_id: u64,
    pub beacon: BeaconChoice,
}

pub fn is_placeholder(s: &str) -> bool {
    s.contains("SET-BY-R0ZE") || (s.starts_with('<') && s.ends_with('>'))
}

fn opt_address(v: &Value, k: &str) -> Result<Option<Address>, String> {
    match v.get(k).and_then(Value::as_str) {
        None => Err(format!("profile: {k} missing")),
        Some(s) if is_placeholder(s) => Ok(None),
        Some(s) => s
            .parse()
            .map(Some)
            .map_err(|_| format!("profile: {k} {s} is not a base58 address")),
    }
}

fn strings(v: &Value, k: &str) -> Vec<String> {
    v.get(k)
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str().map(|s| s.to_ascii_lowercase()))
                .collect()
        })
        .unwrap_or_default()
}

/// Parses a `wylls-devnet-profile-v1` file (`scripts/devnet/devnet-profile.json`
/// plus its `operator` block).
pub fn parse_profile(text: &str) -> Result<Profile, String> {
    let v: Value = serde_json::from_str(text).map_err(|e| format!("profile: {e}"))?;
    if v["schema"] != PROFILE_SCHEMA {
        return Err(format!("profile: schema is not {PROFILE_SCHEMA}"));
    }
    let cluster = v["cluster"].as_str().unwrap_or("").to_string();
    if cluster != "devnet" && cluster != "localnet" {
        return Err(format!(
            "profile: cluster {cluster:?}: devnet (or localnet for loopback tests) only"
        ));
    }
    let op = v
        .get("operator")
        .ok_or("profile: the operator block is missing")?;
    let beacon = match op["beacon"].as_str().unwrap_or("quicknet") {
        "quicknet" => BeaconChoice::Quicknet,
        "test-key" => BeaconChoice::TestKey,
        b => {
            return Err(format!(
                "profile: operator.beacon {b:?}: quicknet or test-key"
            ))
        }
    };
    Ok(Profile {
        rpc_url: v["rpcUrl"]
            .as_str()
            .ok_or("profile: rpcUrl missing")?
            .to_string(),
        allowed_hosts: strings(&v, "allowedRpcHosts"),
        refused_patterns: strings(&v, "refusedRpcHostPatterns"),
        program: opt_address(&v, "programId")?,
        upgrade_authority: opt_address(&v, "upgradeAuthority")?,
        rent_per_byte: v["rent"]["assume"]
            .as_u64()
            .ok_or("profile: rent.assume missing")?,
        preset: v["season"]["preset"]
            .as_str()
            .ok_or("profile: season.preset missing")?
            .to_string(),
        season_id: op["seasonId"]
            .as_u64()
            .ok_or("profile: operator.seasonId missing")?,
        beacon,
        cluster,
    })
}

/// The presets the operator may create, by the profile's `season.preset`.
pub const PRESETS: [&str; 2] = ["S1_LOCAL_7D", "S1_LOCAL_14D"];

/// The season's CreateSeason bytes from the profile (the same
/// [`setup::conquest_bytes`] the local stack uses; S1 seasons only: the
/// program refuses any other version).
pub fn season_bytes(p: &Profile) -> Result<SeasonBytes, String> {
    use frontier_abi::v2::presets as v2;
    let mut sp = match p.preset.as_str() {
        "S1_LOCAL_7D" => v2::S1_LOCAL_7D,
        "S1_LOCAL_14D" => v2::S1_LOCAL_14D,
        x => {
            return Err(format!(
                "profile: season.preset {x}: one of {}",
                PRESETS.join(", ")
            ))
        }
    };
    if p.beacon == BeaconChoice::TestKey {
        sp.base.quicknet_pk_hash = fclient::beacon::pk_hash(&fclient::beacon::TestKey::new().pk96);
    }
    setup::conquest_bytes(&sp).map_err(|e| format!("season params ({}): {e}", p.preset))
}

// ------------------------------------------------------------------ cluster guard

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Endpoint {
    /// 127.0.0.1, localhost or [::1]: a local validator or frontier-localnet.
    Loopback,
    /// An allow-listed https host (devnet).
    Public,
}

/// What may be shown of an RPC URL (no path or query: providers put API
/// keys there).
pub fn redact(url: &str) -> String {
    fclient::https::redact(url)
}

/// The URL rule. Nothing is contacted here.
pub fn check_url(url: &str, p: &Profile) -> Result<Endpoint, String> {
    let shown = redact(url);
    let (scheme, rest) = url
        .split_once("://")
        .ok_or_else(|| format!("RPC URL {shown}: not a URL"))?;
    let authority = &rest[..rest.find(['/', '?', '#']).unwrap_or(rest.len())];
    if authority.contains('@') {
        return Err(format!("RPC URL {shown}: no credentials in the URL"));
    }
    let host = if authority.starts_with('[') {
        &authority[..authority.find(']').map_or(authority.len(), |i| i + 1)]
    } else {
        authority.split(':').next().unwrap_or("")
    }
    .to_ascii_lowercase();
    if host.is_empty() {
        return Err(format!("RPC URL {shown}: no host"));
    }
    if matches!(host.as_str(), "127.0.0.1" | "localhost" | "[::1]") {
        return match scheme {
            "http" | "https" => Ok(Endpoint::Loopback),
            _ => Err(format!("RPC URL {shown}: http or https only")),
        };
    }
    if p.cluster != "devnet" {
        return Err(format!(
            "RPC URL {shown}: a {} profile allows loopback URLs only",
            p.cluster
        ));
    }
    if scheme != "https" {
        return Err(format!("RPC URL {shown}: https only for a public host"));
    }
    for pat in HARD_REFUSED_HOST_PATTERNS
        .iter()
        .map(|s| s.to_string())
        .chain(p.refused_patterns.iter().cloned())
    {
        if host.contains(&pat) {
            return Err(format!(
                "RPC URL {shown}: host {host} is refused ({pat}); devnet only"
            ));
        }
    }
    if !p.allowed_hosts.contains(&host) {
        return Err(format!(
            "RPC URL {shown}: host {host} is not in the profile's allowedRpcHosts"
        ));
    }
    fclient::https::check_post_url(url).map_err(|e| format!("RPC URL {shown}: {e}"))?;
    Ok(Endpoint::Public)
}

/// The genesis rule: mainnet-beta and testnet never; a public URL must be
/// devnet.
pub fn check_genesis(genesis: &str, ep: Endpoint) -> Result<(), String> {
    match genesis {
        MAINNET_GENESIS => Err(format!(
            "genesis {genesis} is mainnet-beta: refused (devnet only)"
        )),
        TESTNET_GENESIS => Err(format!(
            "genesis {genesis} is testnet: refused (devnet only)"
        )),
        g if ep == Endpoint::Public && g != DEVNET_GENESIS => Err(format!(
            "genesis {g} is not devnet's ({DEVNET_GENESIS}): refused"
        )),
        _ => Ok(()),
    }
}

// ------------------------------------------------------------------ key file

/// The effective uid, without libc: the owner of a file this process
/// creates.
fn current_uid() -> Result<u32, String> {
    use std::os::unix::fs::MetadataExt;
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let p = std::env::temp_dir().join(format!(
        ".frontier-operator-uid-{}-{nanos}",
        std::process::id()
    ));
    let f = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&p)
        .map_err(|e| format!("uid probe: {e}"))?;
    let uid = f.metadata().map(|m| m.uid());
    drop(f);
    let _ = std::fs::remove_file(&p);
    uid.map_err(|e| format!("uid probe: {e}"))
}

fn wipe(b: &mut [u8]) {
    for x in b.iter_mut() {
        // SAFETY: a valid, aligned &mut u8; volatile so the wipe is kept.
        unsafe { std::ptr::write_volatile(x, 0) };
    }
}

/// The key file's checks, before it is read. Errors name the path, never
/// the content.
pub fn key_file_problem(path: &Path) -> Option<String> {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    let shown = path.display();
    let m = match std::fs::symlink_metadata(path) {
        Ok(m) => m,
        Err(_) => return Some(format!("key file {shown}: not found")),
    };
    if m.file_type().is_symlink() {
        return Some(format!("key file {shown}: a symlink; give the file itself"));
    }
    if !m.is_file() {
        return Some(format!("key file {shown}: not a regular file"));
    }
    let mode = m.permissions().mode() & 0o777;
    if mode & 0o077 != 0 {
        return Some(format!(
            "key file {shown}: mode {mode:o} lets group/other read it; chmod 600 it first"
        ));
    }
    match current_uid() {
        Ok(uid) if uid == m.uid() => {}
        Ok(_) => return Some(format!("key file {shown}: not owned by this user")),
        Err(e) => return Some(e),
    }
    if m.len() > MAX_KEY_FILE {
        return Some(format!("key file {shown}: too large for a key file"));
    }
    None
}

/// Loads the authority from a Solana CLI key file (a JSON array of 64
/// bytes) after [`key_file_problem`]. The read buffers are wiped.
pub fn load_authority(path: &Path) -> Result<Keypair, String> {
    if let Some(p) = key_file_problem(path) {
        return Err(p);
    }
    let bad = || {
        format!(
            "key file {}: not a Solana CLI key file (a JSON array of 64 bytes)",
            path.display()
        )
    };
    let mut text = std::fs::read(path).map_err(|_| bad())?;
    let mut bytes = Vec::with_capacity(64);
    let mut ok = false;
    if let Ok(s) = std::str::from_utf8(&text) {
        let s = s.trim();
        if let Some(inner) = s.strip_prefix('[').and_then(|x| x.strip_suffix(']')) {
            ok = true;
            for part in inner.split(',') {
                match part.trim().parse::<u8>() {
                    Ok(b) if bytes.len() < 64 => bytes.push(b),
                    _ => {
                        ok = false;
                        break;
                    }
                }
            }
            ok &= bytes.len() == 64;
        }
    }
    let kp = if ok {
        Keypair::try_from(&bytes[..]).map_err(|_| bad())
    } else {
        Err(bad())
    };
    wipe(&mut bytes);
    wipe(&mut text);
    kp
}

// ------------------------------------------------------------------ chain state and plan

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SeasonView {
    pub status: u8,
    pub params_hash: [u8; 32],
    pub t_create_min: i64,
    pub authority: Address,
}

/// What the chain holds for the season (or nothing, offline).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Observed {
    /// The cluster's Clock (`None`: offline plan).
    pub now: Option<i64>,
    pub season: Option<SeasonView>,
    pub logs: Vec<bool>,
    pub shards: Vec<Vec<bool>>,
}

impl Observed {
    /// The offline view: nothing done, clock unknown.
    pub fn fresh() -> Observed {
        use fclient::abi::{FACTIONS, REGIONS, SHARDS_PER_FACTION};
        Observed {
            now: None,
            season: None,
            logs: vec![false; REGIONS as usize],
            shards: vec![vec![false; SHARDS_PER_FACTION as usize]; FACTIONS as usize],
        }
    }
}

/// The four Season fields the setup needs, read at their layout offsets:
/// `fclient::decode::Season::decode` refuses an only-announced v2 Season
/// (AnnounceSeason writes no `program_version` yet: `InvalidSeasonMode`).
/// A CloseSeason tombstone (128 B) reads as Closed.
pub fn season_view(d: &[u8]) -> Result<SeasonView, String> {
    use frontier_abi::layout::world::season as s;
    if d.len() < 8 || d[..8] != s::MAGIC {
        return Err("the Season address holds another kind of account".into());
    }
    if d.len() < s::T_CREATE_MIN + 8 {
        let status = d.get(s::STATUS).copied().unwrap_or(s::STATUS_CLOSED);
        return Ok(SeasonView {
            status,
            params_hash: [0; 32],
            t_create_min: 0,
            authority: Address::default(),
        });
    }
    let arr = |o: usize| -> [u8; 32] { d[o..o + 32].try_into().expect("32 bytes") };
    Ok(SeasonView {
        status: d[s::STATUS],
        params_hash: arr(s::PARAMS_HASH),
        t_create_min: i64::from_le_bytes(
            d[s::T_CREATE_MIN..s::T_CREATE_MIN + 8]
                .try_into()
                .expect("8 bytes"),
        ),
        authority: Address::new_from_array(arr(s::AUTHORITY)),
    })
}

/// Reads the Clock, the Season, the BeaconLogs and the JoinShards.
pub async fn observe(chain: &Chain, a: &Addresses) -> Result<Observed, String> {
    use fclient::abi::{FACTIONS, REGIONS, SHARDS_PER_FACTION};
    let clock = timed(chain.port.clock())
        .await?
        .map_err(|e| format!("Clock: {e}"))?;
    let mut keys = vec![a.season];
    keys.extend((0..REGIONS).map(|r| a.beacon_log(r)));
    for f in 0..FACTIONS {
        keys.extend((0..SHARDS_PER_FACTION).map(|s| a.join_shard(f, s)));
    }
    let got = chain.accounts(&keys).await?;
    let present = |i: usize| -> Result<bool, String> {
        match &got[i] {
            None => Ok(false),
            Some(acc) if acc.owner == a.program => Ok(true),
            Some(acc) => Err(format!(
                "{} is held by another owner ({}): refused",
                keys[i], acc.owner
            )),
        }
    };
    let season = match &got[0] {
        None => None,
        Some(acc) => {
            present(0)?;
            Some(season_view(&acc.data)?)
        }
    };
    let mut o = Observed::fresh();
    o.now = Some(clock.unix_timestamp);
    o.season = season;
    for r in 0..REGIONS as usize {
        o.logs[r] = present(1 + r)?;
    }
    for f in 0..FACTIONS as usize {
        for s in 0..SHARDS_PER_FACTION as usize {
            o.shards[f][s] = present(1 + REGIONS as usize + f * SHARDS_PER_FACTION as usize + s)?;
        }
    }
    Ok(o)
}

/// One planned transaction: a setup step and the chain time it waits for.
#[derive(Clone, Debug, PartialEq)]
pub struct Planned {
    pub step: Step,
    /// CreateSeason (and what follows it) waits for `t_create_min`;
    /// `None` with [`Plan::t_create_min`] `None`: after the announce lead.
    pub not_before: Option<i64>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Plan {
    pub done: Vec<String>,
    pub todo: Vec<Planned>,
    /// Known once the season is announced (or planned with a clock).
    pub t_create_min: Option<i64>,
    /// The announced season's status.
    pub status: Option<u8>,
}

fn status_name(s: u8) -> &'static str {
    use fclient::abi::status as st;
    match s {
        st::ANNOUNCED => "Announced",
        st::CREATED => "Created",
        st::SEEDED => "Seeded",
        st::RUNNING => "Running",
        st::ENDED => "Ended",
        st::CLOSED => "Closed",
        st::ABORTED => "Aborted",
        _ => "unknown",
    }
}

/// All-or-nothing groups: one transaction creates the whole group, so a
/// partial group means something else wrote there.
fn group(name: &str, have: &[bool]) -> Result<bool, String> {
    let n = have.iter().filter(|x| **x).count();
    match n {
        0 => Ok(false),
        x if x == have.len() => Ok(true),
        _ => Err(format!(
            "{name}: {n} of {} accounts exist; a setup transaction creates all or none: refused",
            have.len()
        )),
    }
}

/// What is left to do, from what the chain holds. Pure.
pub fn plan(
    obs: &Observed,
    a: &Addresses,
    authority: Address,
    sb: &SeasonBytes,
) -> Result<Plan, String> {
    use fclient::abi::status as st;
    let after = setup::after_announce_steps(a, authority, sb);
    let Some(s) = &obs.season else {
        let t = obs
            .now
            .map(|n| n + frontier_abi::presets::MIN_ANNOUNCE_LEAD_SECS + ANNOUNCE_MARGIN_SECS);
        let mut todo = vec![Planned {
            step: setup::announce_step(a, authority, sb.params_hash, t.unwrap_or(0)),
            not_before: None,
        }];
        todo.extend(after.into_iter().map(|step| Planned {
            step,
            not_before: t,
        }));
        return Ok(Plan {
            done: vec![],
            todo,
            t_create_min: t,
            status: None,
        });
    };
    if !matches!(
        s.status,
        st::ANNOUNCED | st::CREATED | st::SEEDED | st::RUNNING
    ) {
        return Err(format!(
            "season {} is {}: past setup; use a new operator.seasonId",
            a.season_id,
            status_name(s.status)
        ));
    }
    if s.authority != authority {
        return Err(format!(
            "season {} was announced by {}, not by this authority {authority}: refused",
            a.season_id, s.authority
        ));
    }
    if s.params_hash != sb.params_hash {
        return Err(format!(
            "season {} was announced with params hash {}, the profile gives {} (another preset or beacon): refused",
            a.season_id,
            hex::encode(s.params_hash),
            hex::encode(sb.params_hash)
        ));
    }
    let mut done = vec!["AnnounceSeason".to_string()];
    let mut todo = vec![];
    let t = Some(s.t_create_min);
    match s.status {
        st::ANNOUNCED => {
            if let Some(now) = obs.now {
                if now >= s.t_create_min + frontier_abi::presets::CREATE_WINDOW_SECS {
                    return Err(format!(
                        "season {}: the CreateSeason window closed at {} (chain clock {now}); announce a new seasonId",
                        a.season_id,
                        s.t_create_min + frontier_abi::presets::CREATE_WINDOW_SECS
                    ));
                }
            }
            todo.extend(after.into_iter().map(|step| Planned {
                step,
                not_before: t,
            }));
        }
        st::CREATED | st::SEEDED | st::RUNNING => {
            done.push("CreateSeason".into());
            let mut it = after.into_iter().skip(1);
            let logs = it.next().expect("InitBeaconLogs");
            if group("BeaconLogs", &obs.logs)? {
                done.push(logs.name);
            } else {
                todo.push(Planned {
                    step: logs,
                    not_before: None,
                });
            }
            for (f, step) in it.enumerate() {
                if group(&format!("JoinShards of faction {f}"), &obs.shards[f])? {
                    done.push(step.name);
                } else {
                    todo.push(Planned {
                        step,
                        not_before: None,
                    });
                }
            }
        }
        _ => unreachable!("statuses past setup are refused above"),
    }
    Ok(Plan {
        done,
        todo,
        t_create_min: t,
        status: Some(s.status),
    })
}

// ------------------------------------------------------------------ rent and rendering

/// Where the plan's rent-exempt minimums come from.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Rent {
    /// `(128 + size) × rate` (the profile's `rent.assume`; offline).
    Rate(u64),
    /// `getMinimumBalanceForRentExemption` per size (online).
    Cluster(BTreeMap<usize, u64>),
}

impl Rent {
    pub fn of(&self, size: usize) -> u64 {
        match self {
            Rent::Rate(r) => (128 + size as u64) * r,
            Rent::Cluster(m) => m.get(&size).copied().unwrap_or(0),
        }
    }

    /// Reads the cluster's minimum for every size the plan creates.
    pub async fn from_cluster(chain: &Chain, p: &Plan) -> Result<Rent, String> {
        let mut m = BTreeMap::new();
        for c in p.todo.iter().flat_map(|t| &t.step.creates) {
            if let std::collections::btree_map::Entry::Vacant(e) = m.entry(c.size) {
                let v = chain
                    .call("getMinimumBalanceForRentExemption", json!([c.size]))
                    .await?;
                e.insert(v.as_u64().ok_or("getMinimumBalanceForRentExemption")?);
            }
        }
        Ok(Rent::Cluster(m))
    }
}

/// Lamports the plan's transactions move out of the authority: rent,
/// floats (bond, fund floats) and fees.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Cost {
    pub rent: u64,
    pub floats: u64,
    pub fees: u64,
}

impl Cost {
    pub fn total(&self) -> u64 {
        self.rent + self.floats + self.fees
    }
}

pub fn step_cost(s: &Step, rent: &Rent) -> Cost {
    Cost {
        rent: s.creates.iter().map(|c| rent.of(c.size)).sum(),
        floats: s.creates.iter().map(|c| c.extra).sum(),
        fees: FEE_PER_SIGNATURE,
    }
}

pub fn plan_cost(p: &Plan, rent: &Rent) -> Cost {
    p.todo.iter().fold(Cost::default(), |acc, t| {
        let c = step_cost(&t.step, rent);
        Cost {
            rent: acc.rent + c.rent,
            floats: acc.floats + c.floats,
            fees: acc.fees + c.fees,
        }
    })
}

/// `1,234,567` (lamports).
pub fn grouped(n: u64) -> String {
    let s = n.to_string();
    let mut out = String::new();
    for (i, c) in s.chars().enumerate() {
        if i > 0 && (s.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(c);
    }
    out
}

pub fn sol(n: u64) -> String {
    format!("{}.{:09}", n / 1_000_000_000, n % 1_000_000_000)
}

/// What the plan's header shows.
pub struct Header<'a> {
    pub mode: &'a str,
    pub cluster: String,
    pub profile: &'a Profile,
    pub authority: Address,
    pub rent_source: String,
}

/// The plan as text: the dry run's output (snapshot-tested).
pub fn render(h: &Header, a: &Addresses, sb: &SeasonBytes, p: &Plan, rent: &Rent) -> String {
    use std::fmt::Write;
    let mut labels: BTreeMap<Address, String> = BTreeMap::new();
    labels.insert(h.authority, "authority".into());
    labels.insert(a.season, "Season".into());
    labels.insert(a.program, "program".into());
    labels.insert(a.programdata(), "ProgramData".into());
    labels.insert(fclient::addr::system_program(), "System".into());
    for t in &p.todo {
        for c in &t.step.creates {
            labels.insert(c.address, c.label.clone());
        }
    }
    let mut o = String::new();
    let _ = writeln!(o, "frontier-operator: season setup plan ({})", h.mode);
    let _ = writeln!(o, "cluster    {}", h.cluster);
    let _ = writeln!(o, "program    {}", a.program);
    let _ = writeln!(o, "authority  {}", h.authority);
    let _ = writeln!(
        o,
        "season     id {}  {}  preset {}  beacon {}",
        a.season_id,
        a.season,
        h.profile.preset,
        match h.profile.beacon {
            BeaconChoice::Quicknet => "quicknet",
            BeaconChoice::TestKey => "test-key",
        }
    );
    let _ = writeln!(
        o,
        "params     hash {}  (CreateSeason data: {} B params + {} B payout)",
        hex::encode(sb.params_hash),
        sb.params.len(),
        sb.payout.len()
    );
    let _ = writeln!(o, "rent       {}", h.rent_source);
    match p.t_create_min {
        Some(t) => {
            let _ = writeln!(
                o,
                "t_create_min {t} (chain clock; CreateSeason window {} s)",
                frontier_abi::presets::CREATE_WINDOW_SECS
            );
        }
        None => {
            let _ = writeln!(
                o,
                "t_create_min = chain clock at AnnounceSeason + {} s (lead {} + margin {})",
                frontier_abi::presets::MIN_ANNOUNCE_LEAD_SECS + ANNOUNCE_MARGIN_SECS,
                frontier_abi::presets::MIN_ANNOUNCE_LEAD_SECS,
                ANNOUNCE_MARGIN_SECS
            );
        }
    }
    if let Some(s) = p.status {
        let _ = writeln!(o, "status     {}", status_name(s));
    }
    let _ = writeln!(
        o,
        "done       {}",
        if p.done.is_empty() {
            "nothing".to_string()
        } else {
            p.done.join(", ")
        }
    );
    for (i, t) in p.todo.iter().enumerate() {
        let c = step_cost(&t.step, rent);
        let when = match t.not_before {
            _ if t.step.name == "AnnounceSeason"
                || p.status.is_some() && t.not_before.is_none() =>
            {
                "now".to_string()
            }
            Some(x) => format!("chain clock >= {x}"),
            None => "after the lead".to_string(),
        };
        let _ = writeln!(o, "tx {:<2} {}  [{when}]", i + 1, t.step.name);
        for ix in &t.step.ixs {
            if t.step.name == "AnnounceSeason" {
                let tc = p
                    .t_create_min
                    .map_or("<chain clock at send + 86700>".to_string(), |x| {
                        x.to_string()
                    });
                let _ = writeln!(
                    o,
                    "      data   {} B: tag 0x{:02x}, season_id {}, params_hash {}, t_create_min {tc}, bond {}",
                    ix.data.len(),
                    ix.data[0],
                    a.season_id,
                    hex::encode(sb.params_hash),
                    grouped(setup::BOND)
                );
            } else {
                let _ = writeln!(
                    o,
                    "      data   {} B: tag 0x{:02x}, sha256 {}",
                    ix.data.len(),
                    ix.data[0],
                    hex::encode(<sha2::Sha256 as sha2::Digest>::digest(&ix.data))
                );
            }
            for m in &ix.accounts {
                let _ = writeln!(
                    o,
                    "      acct   {}{} {} {}",
                    if m.is_signer { "s" } else { "-" },
                    if m.is_writable { "w" } else { "-" },
                    m.pubkey,
                    labels.get(&m.pubkey).map_or("", |s| s.as_str())
                );
            }
        }
        for n in &t.step.creates {
            let _ = writeln!(
                o,
                "      create {:<16} {:>5} B  rent {:>13}{}",
                n.label,
                n.size,
                grouped(rent.of(n.size)),
                if n.extra > 0 {
                    format!("  + float {}", grouped(n.extra))
                } else {
                    String::new()
                }
            );
        }
        let _ = writeln!(
            o,
            "      cost   rent {} + float {} + fee {} = {} lamports",
            grouped(c.rent),
            grouped(c.floats),
            grouped(c.fees),
            grouped(c.total())
        );
    }
    let c = plan_cost(p, rent);
    let _ = writeln!(
        o,
        "total      {} tx: rent {} + floats {} + fees {} = {} lamports ({} SOL)",
        p.todo.len(),
        grouped(c.rent),
        grouped(c.floats),
        grouped(c.fees),
        grouped(c.total()),
        sol(c.total())
    );
    o
}

// ------------------------------------------------------------------ checks and sending

/// The program at `a.program` exists and `authority` is its upgrade
/// authority (I-51: AnnounceSeason reads it from the ProgramData).
pub async fn check_program(chain: &Chain, a: &Addresses, authority: Address) -> Result<(), String> {
    let got = chain.accounts(&[a.program, a.programdata()]).await?;
    let loader: Address = fclient::abi::LOADER_V3.parse().map_err(|_| "loader id")?;
    match &got[0] {
        Some(p) if p.executable && p.owner == loader => {}
        Some(_) => return Err(format!("{} is not an upgradeable program", a.program)),
        None => {
            return Err(format!(
                "program {} is not deployed on this cluster (run after r0ze's deploy)",
                a.program
            ))
        }
    }
    let pd = got[1]
        .as_ref()
        .ok_or("the program's ProgramData is absent")?;
    let auth = (pd.data.len() >= 45 && pd.data[12] == 1)
        .then(|| Address::try_from(&pd.data[13..45]).ok())
        .flatten();
    match auth {
        Some(x) if x == authority => Ok(()),
        Some(x) => Err(format!(
            "the program's upgrade authority is {x}, not this key's {authority}: AnnounceSeason would fail (I-51)"
        )),
        None => Err("the program is immutable: no AnnounceSeason is possible (I-51)".into()),
    }
}

#[derive(Clone, Copy, Debug, Default)]
pub struct SendOpts {
    /// Sleep through the lead instead of exiting with [`EXIT_WAITING`].
    pub wait: bool,
    /// Stop after this many transactions (a staged run; the next run resumes).
    pub max_txs: Option<usize>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Outcome {
    /// Every step is on chain.
    Complete { sent: usize },
    /// CreateSeason waits for `t_create_min` (chain clock `now`).
    Waiting {
        sent: usize,
        t_create_min: i64,
        now: i64,
    },
    /// `--max-txs` reached.
    Stopped { sent: usize },
}

/// Sends what is missing, one transaction at a time, re-reading the chain
/// before each (so a concurrent or earlier run is never repeated).
pub async fn execute(
    chain: &Chain,
    a: &Addresses,
    authority: &Keypair,
    sb: &SeasonBytes,
    opts: SendOpts,
    log: &mut dyn FnMut(&str),
) -> Result<Outcome, String> {
    let auth = authority.pubkey();
    let mut sent = 0usize;
    let started = Instant::now();
    let mut wait_limit: Option<Duration> = None;
    loop {
        let obs = observe(chain, a).await?;
        let p = plan(&obs, a, auth, sb)?;
        let Some(next) = p.todo.first() else {
            return Ok(Outcome::Complete { sent });
        };
        if opts.max_txs.is_some_and(|m| sent >= m) {
            return Ok(Outcome::Stopped { sent });
        }
        let now = obs.now.unwrap_or(0);
        if let Some(t) = next.not_before.filter(|t| now < *t) {
            if !opts.wait {
                return Ok(Outcome::Waiting {
                    sent,
                    t_create_min: t,
                    now,
                });
            }
            // A chain second is about a wall second on a public cluster; allow an hour more.
            let limit =
                *wait_limit.get_or_insert(Duration::from_secs((t - now).max(0) as u64 + 3_600));
            if started.elapsed() > limit {
                return Err(format!(
                    "waited {:?} and the chain clock ({now}) is still before t_create_min {t}",
                    started.elapsed()
                ));
            }
            let secs = ((t - now) as u64).clamp(1, 15);
            log(&format!(
                "waiting for t_create_min {t} (chain clock {now}, {} s left)",
                t - now
            ));
            tokio::time::sleep(Duration::from_secs(secs)).await;
            continue;
        }
        let name = next.step.name.clone();
        log(&format!("sending {name}"));
        chain
            .send_op(&next.step.ixs, &[authority], LAND_LIMIT)
            .await
            .map_err(|e| {
                format!("{name}: {e}\n(re-run to resume: the tool re-reads the chain and sends only what is missing)")
            })?;
        sent += 1;
        log(&format!("{name}: finalized"));
    }
}

// ------------------------------------------------------------------ command line

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Opts {
    pub profile: String,
    pub authority: Option<String>,
    pub cluster_url: Option<String>,
    pub offline: bool,
    pub yes_send: bool,
    pub wait: bool,
    pub max_txs: Option<usize>,
}

pub const USAGE: &str =
    "usage: frontier-operator --profile FILE [--authority KEYFILE] [--cluster-url URL]
                         [--offline] [--yes-send] [--wait] [--max-txs N]

  Dry run by default: reads the cluster (unless --offline) and prints the
  season setup plan. --yes-send sends what is missing, signed by the
  --authority key file (mode 600, the program's upgrade authority).
  Exit: 0 done/plan printed, 1 failed, 2 refused, 3 waiting for t_create_min.";

pub fn parse_args(args: &[String]) -> Result<Opts, String> {
    let mut o = Opts::default();
    let mut it = args.iter();
    while let Some(a) = it.next() {
        let mut val = |name: &str| {
            it.next()
                .cloned()
                .ok_or_else(|| format!("{name} needs a value"))
        };
        match a.as_str() {
            "--profile" => o.profile = val("--profile")?,
            "--authority" => o.authority = Some(val("--authority")?),
            "--cluster-url" => o.cluster_url = Some(val("--cluster-url")?),
            "--offline" => o.offline = true,
            "--yes-send" => o.yes_send = true,
            "--wait" => o.wait = true,
            "--max-txs" => {
                o.max_txs = Some(
                    val("--max-txs")?
                        .parse()
                        .map_err(|_| "--max-txs N (a number)")?,
                )
            }
            "-h" | "--help" => return Err(USAGE.into()),
            x => return Err(format!("unknown argument {x}\n{USAGE}")),
        }
    }
    if o.profile.is_empty() {
        return Err(format!("--profile is required\n{USAGE}"));
    }
    if o.offline && o.yes_send {
        return Err("--offline plans only; it cannot be combined with --yes-send".into());
    }
    if o.yes_send && o.authority.is_none() {
        return Err("--yes-send needs --authority KEYFILE".into());
    }
    Ok(o)
}

/// The whole command; returns the exit code. `out` gets stdout lines,
/// `err` stderr lines.
pub async fn main_with(
    args: &[String],
    out: &mut dyn FnMut(&str),
    err: &mut dyn FnMut(&str),
) -> i32 {
    let o = match parse_args(args) {
        Ok(o) => o,
        Err(e) => {
            err(&e);
            return EXIT_REFUSED;
        }
    };
    match run(&o, out, err).await {
        Ok(code) => code,
        Err((code, e)) => {
            err(&format!("frontier-operator: {e}"));
            code
        }
    }
}

type Fail = (i32, String);

fn refused(e: impl Into<String>) -> Fail {
    (EXIT_REFUSED, e.into())
}

async fn run(o: &Opts, out: &mut dyn FnMut(&str), err: &mut dyn FnMut(&str)) -> Result<i32, Fail> {
    let text =
        std::fs::read_to_string(&o.profile).map_err(|e| refused(format!("{}: {e}", o.profile)))?;
    let profile = parse_profile(&text).map_err(refused)?;
    let url = o
        .cluster_url
        .clone()
        .unwrap_or_else(|| profile.rpc_url.clone());
    let ep = check_url(&url, &profile).map_err(refused)?;
    if profile.beacon == BeaconChoice::TestKey && ep == Endpoint::Public {
        return Err(refused(
            "operator.beacon test-key is for loopback test chains only (I-53)",
        ));
    }
    let key = match &o.authority {
        Some(p) => Some(load_authority(Path::new(p)).map_err(refused)?),
        None => None,
    };
    let authority =
        match (&key, profile.upgrade_authority) {
            (Some(k), Some(u)) if k.pubkey() != u => {
                return Err(refused(format!(
                    "the key file's address {} is not the profile's upgradeAuthority {u}",
                    k.pubkey()
                )))
            }
            (Some(k), _) => k.pubkey(),
            (None, Some(u)) => u,
            (None, None) => return Err(refused(
                "no authority: give --authority KEYFILE or fill upgradeAuthority in the profile",
            )),
        };
    let program = profile.program.ok_or_else(|| {
        refused("programId is still a placeholder: fill it in after r0ze's deploy")
    })?;
    let sb = season_bytes(&profile).map_err(refused)?;
    let a = Addresses::new(program, profile.season_id);

    if o.offline {
        let p = plan(&Observed::fresh(), &a, authority, &sb).map_err(refused)?;
        let rent = Rent::Rate(profile.rent_per_byte);
        let h = Header {
            mode: "DRY RUN, offline: nothing read, nothing sent",
            cluster: format!("{} (offline: assumes nothing is done yet)", profile.cluster),
            profile: &profile,
            authority,
            rent_source: format!(
                "{} lamports/byte (profile rent.assume; the cluster's own rate is read online)",
                profile.rent_per_byte
            ),
        };
        out(&render(&h, &a, &sb, &p, &rent));
        return Ok(EXIT_OK);
    }

    let chain = Chain::public(&url, program);
    // The genesis hash before anything else.
    let genesis = chain
        .call("getGenesisHash", json!([]))
        .await
        .map_err(|e| (EXIT_FAILED, format!("{}: {e}", redact(&url))))?;
    let genesis = genesis.as_str().unwrap_or("").to_string();
    check_genesis(&genesis, ep).map_err(refused)?;
    let prog_check = check_program(&chain, &a, authority).await;
    let obs = observe(&chain, &a).await.map_err(|e| (EXIT_FAILED, e))?;
    let p = plan(&obs, &a, authority, &sb).map_err(refused)?;
    let rent = Rent::from_cluster(&chain, &p)
        .await
        .map_err(|e| (EXIT_FAILED, e))?;
    let balance = chain
        .balance(&authority)
        .await
        .map_err(|e| (EXIT_FAILED, e))?;
    let cost = plan_cost(&p, &rent);
    let h = Header {
        mode: if o.yes_send {
            "SEND (--yes-send)"
        } else {
            "DRY RUN: nothing is sent without --yes-send"
        },
        cluster: format!(
            "{} {} (genesis {genesis}, chain clock {})",
            profile.cluster,
            redact(&url),
            obs.now.unwrap_or(0)
        ),
        profile: &profile,
        authority,
        rent_source: "from the cluster (getMinimumBalanceForRentExemption)".into(),
    };
    out(&render(&h, &a, &sb, &p, &rent));
    out(&format!(
        "balance    {} lamports ({} SOL){}",
        grouped(balance),
        sol(balance),
        if balance < cost.total() {
            format!(": SHORT by {} lamports", grouped(cost.total() - balance))
        } else {
            String::new()
        }
    ));
    if let Err(e) = &prog_check {
        out(&format!("check      FAILED: {e}"));
    } else {
        out("check      program deployed; this key is its upgrade authority");
    }
    if p.todo.is_empty() {
        out("setup      complete: nothing to send");
        return Ok(EXIT_OK);
    }
    if !o.yes_send {
        out("DRY RUN: nothing sent. Add --yes-send (with --authority) to send.");
        return Ok(EXIT_OK);
    }
    prog_check.map_err(refused)?;
    if balance < cost.total() {
        return Err(refused(format!(
            "the authority holds {} lamports, the plan needs {}: fund it first",
            grouped(balance),
            grouped(cost.total())
        )));
    }
    let key = key.expect("--yes-send has --authority");
    let mut log = |l: &str| err(l);
    let r = execute(
        &chain,
        &a,
        &key,
        &sb,
        SendOpts {
            wait: o.wait,
            max_txs: o.max_txs,
        },
        &mut log,
    )
    .await
    .map_err(|e| (EXIT_FAILED, e))?;
    Ok(match r {
        Outcome::Complete { sent } => {
            out(&format!(
                "setup      complete: {sent} transaction(s) sent; season {} is ready for keeper A's ConsumeGenesisSeed",
                a.season_id
            ));
            EXIT_OK
        }
        Outcome::Waiting {
            sent,
            t_create_min,
            now,
        } => {
            out(&format!(
                "waiting    {sent} transaction(s) sent; CreateSeason opens at chain clock {t_create_min} (now {now}, {} s left). Run the same command again then (or add --wait).",
                t_create_min - now
            ));
            EXIT_WAITING
        }
        Outcome::Stopped { sent } => {
            out(&format!(
                "stopped    after {sent} transaction(s) (--max-txs); run again to continue"
            ));
            EXIT_OK
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profile(cluster: &str) -> Profile {
        parse_profile(
            &json!({
                "schema": PROFILE_SCHEMA, "cluster": cluster,
                "rpcUrl": "https://api.devnet.solana.com",
                "allowedRpcHosts": ["api.devnet.solana.com"],
                "refusedRpcHostPatterns": ["mainnet", "api.solana.com", "testnet"],
                "programId": "<SET-BY-R0ZE: program>",
                "upgradeAuthority": "<SET-BY-R0ZE: authority>",
                "rent": {"assume": 6960},
                "season": {"preset": "S1_LOCAL_7D"},
                "operator": {"seasonId": 1, "beacon": "quicknet"}
            })
            .to_string(),
        )
        .unwrap()
    }

    #[test]
    fn url_rules() {
        let p = profile("devnet");
        assert_eq!(
            check_url("https://api.devnet.solana.com", &p),
            Ok(Endpoint::Public)
        );
        assert_eq!(
            check_url("http://127.0.0.1:41600", &p),
            Ok(Endpoint::Loopback)
        );
        assert_eq!(
            check_url("http://localhost:41600/", &p),
            Ok(Endpoint::Loopback)
        );
        assert_eq!(check_url("http://[::1]:41600", &p), Ok(Endpoint::Loopback));
        for bad in [
            "http://api.devnet.solana.com",
            "https://api.mainnet-beta.solana.com",
            "https://api.testnet.solana.com",
            "https://api.solana.com",
            "https://mainnet.helius-rpc.com/?api-key=abc",
            "https://devnet.example.com",
            "https://user:pw@api.devnet.solana.com",
            "https://127.0.0.1.evil.example",
            "ftp://127.0.0.1",
            "api.devnet.solana.com",
        ] {
            let e = check_url(bad, &p).unwrap_err();
            assert!(!e.contains("api-key"), "redacted: {e}");
        }
        // A localnet profile: loopback only.
        let l = profile("localnet");
        assert!(check_url("https://api.devnet.solana.com", &l).is_err());
        assert!(check_url("http://127.0.0.1:41600", &l).is_ok());
    }

    #[test]
    fn genesis_rules() {
        for ep in [Endpoint::Loopback, Endpoint::Public] {
            assert!(check_genesis(MAINNET_GENESIS, ep)
                .unwrap_err()
                .contains("mainnet"));
            assert!(check_genesis(TESTNET_GENESIS, ep).is_err());
            assert!(check_genesis(DEVNET_GENESIS, ep).is_ok());
        }
        assert!(check_genesis("Local1111", Endpoint::Loopback).is_ok());
        assert!(check_genesis("Local1111", Endpoint::Public).is_err());
    }

    #[test]
    fn profile_and_args() {
        let p = profile("devnet");
        assert_eq!(p.program, None);
        assert_eq!(p.season_id, 1);
        assert!(season_bytes(&p).is_ok());
        let mut q = p.clone();
        q.preset = "MC_LOCAL_7D".into();
        assert!(season_bytes(&q).is_err());
        let s = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<_>>();
        assert!(parse_args(&s(&["--profile", "p", "--yes-send"])).is_err());
        assert!(parse_args(&s(&[
            "--profile",
            "p",
            "--offline",
            "--yes-send",
            "--authority",
            "k"
        ]))
        .is_err());
        let o = parse_args(&s(&["--profile", "p", "--max-txs", "2"])).unwrap();
        assert_eq!(o.max_txs, Some(2));
        assert!(!o.yes_send);
    }

    fn view(status: u8, sb: &SeasonBytes, auth: Address) -> SeasonView {
        SeasonView {
            status,
            params_hash: sb.params_hash,
            t_create_min: 1_000_000,
            authority: auth,
        }
    }

    #[test]
    fn plan_follows_the_chain() {
        use fclient::abi::status as st;
        let p = profile("devnet");
        let sb = season_bytes(&p).unwrap();
        let a = Addresses::new(Address::new_from_array([7; 32]), 1);
        let auth = Address::new_from_array([9; 32]);
        // Fresh: 9 transactions; CreateSeason waits for the lead.
        let mut o = Observed::fresh();
        o.now = Some(500);
        let pl = plan(&o, &a, auth, &sb).unwrap();
        assert_eq!(pl.todo.len(), 9);
        assert_eq!(pl.t_create_min, Some(500 + 86_400 + ANNOUNCE_MARGIN_SECS));
        assert_eq!(pl.todo[1].not_before, pl.t_create_min);
        // Announced: 8 left.
        o.season = Some(view(st::ANNOUNCED, &sb, auth));
        let pl = plan(&o, &a, auth, &sb).unwrap();
        assert_eq!(pl.todo.len(), 8);
        assert_eq!(pl.todo[0].step.name, "CreateSeason");
        // Created, logs and two factions done: 4 left.
        o.season = Some(view(st::CREATED, &sb, auth));
        o.logs = vec![true; 16];
        o.shards[0] = vec![true; 8];
        o.shards[3] = vec![true; 8];
        let pl = plan(&o, &a, auth, &sb).unwrap();
        let names: Vec<_> = pl.todo.iter().map(|t| t.step.name.as_str()).collect();
        assert_eq!(
            names,
            [
                "InitShards(1)",
                "InitShards(2)",
                "InitShards(4)",
                "InitShards(5)"
            ]
        );
        // All done.
        o.shards = vec![vec![true; 8]; 6];
        assert!(plan(&o, &a, auth, &sb).unwrap().todo.is_empty());
        // Refusals: partial group, other params, other authority, closed window, past setup.
        o.shards[2][5] = false;
        assert!(plan(&o, &a, auth, &sb).unwrap_err().contains("7 of 8"));
        o.shards[2][5] = true;
        let mut other = view(st::CREATED, &sb, auth);
        other.params_hash = [1; 32];
        o.season = Some(other);
        assert!(plan(&o, &a, auth, &sb).unwrap_err().contains("params hash"));
        o.season = Some(view(st::CREATED, &sb, Address::new_from_array([8; 32])));
        assert!(plan(&o, &a, auth, &sb)
            .unwrap_err()
            .contains("announced by"));
        o.season = Some(view(st::ANNOUNCED, &sb, auth));
        o.now = Some(1_000_000 + frontier_abi::presets::CREATE_WINDOW_SECS);
        assert!(plan(&o, &a, auth, &sb)
            .unwrap_err()
            .contains("window closed"));
        o.season = Some(view(st::ENDED, &sb, auth));
        assert!(plan(&o, &a, auth, &sb).unwrap_err().contains("past setup"));
    }

    #[test]
    fn rent_and_numbers() {
        assert_eq!(Rent::Rate(5_080).of(256), 384 * 5_080);
        assert_eq!(grouped(1_234_567), "1,234,567");
        assert_eq!(grouped(12), "12");
        assert_eq!(sol(1_500_000_001), "1.500000001");
    }
}
