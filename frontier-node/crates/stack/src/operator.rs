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
//! - **The playable lane** (owner decision B7, devnet blocker B3): preset
//!   `S1_DEVNET_WIDE_7D` (or its continuous world
//!   `S1_DEVNET_WIDE_CONTINUOUS`: no end bell, joins always open, EndSeason
//!   refused) creates a program-version 0x4804 season (the
//!   `devnet-playable-sbf` build) and adds the authority's one wide-land
//!   transaction, WideSetRules (write-once; it needs the season Seeded, so
//!   it follows keeper A's ConsumeGenesisSeed). Built with the
//!   `playable-lane` feature (the wide-land ABI tables).
//! - **Send gate.** On a public URL, or any URL whose genesis is devnet's
//!   (a loopback tunnel or proxy to devnet), a send also needs
//!   `--i-have-r0ze-approval` and `--approved-sha256 HEX`, which must be the
//!   sha256 of the program the cluster runs (read from its ProgramData), and
//!   the program's markers must match the profile's `program.requiredMarkers`
//!   / `refusedMarkers`. Each landed transaction is reported with its
//!   compute units, fee and the lamports it took from the authority.

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
/// The S1 program's version (`frontier_abi::v2::presets::PROGRAM_VERSION_S1`).
pub const S1_VERSION: u16 = frontier_abi::v2::presets::PROGRAM_VERSION_S1;
/// The playable lane's program version (`devnet-playable-sbf`, B7): the S1
/// rules with the wide land, expedition and conquest dispatch.
pub const PLAYABLE_VERSION: u16 = 0x4804;
/// The flag a send to a public cluster needs (as `scripts/devnet/plan.mjs`).
pub const APPROVAL_FLAG: &str = "--i-have-r0ze-approval";
/// ProgramData's header before the ELF (loader v3: enum tag 4, slot 8,
/// `Option<Pubkey>` 33).
pub const PROGRAMDATA_HEADER: usize = 45;
/// The chain clock may be at most this far past `--t-create-min` minus the
/// program's lead when AnnounceSeason is sent.
pub const T_CREATE_MIN_SLACK_SECS: i64 = 60;

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
    /// `program.programVersion` (`"0x4804"`); `None`: the preset's own.
    pub program_version: Option<u16>,
    /// `program.requiredMarkers` / `program.refusedMarkers`: build markers
    /// the deployed program must (not) carry.
    pub required_markers: Vec<String>,
    pub refused_markers: Vec<String>,
    /// `wide.keepHolder`: the WideSetRules keep-holder byte of a playable-lane
    /// season ([`KEEP_HOLDER_NAMES`]); `None` (absent): MixedInterleaved,
    /// the rule every playable-lane season used so far.
    pub keep_holder: Option<u8>,
}

/// The keep-holder rule names a profile's `wide.keepHolder` may give, with
/// their WideSetRules byte (`frontier_abi::world_index::rules::KeepHolderRule`).
/// Bytes 3 and 4 are named here ahead of the rule table that defines them:
/// `Neutral` (3, every wide keep opens unowned) comes with #206
/// (expansion-gameplay-1, owner Q-1 2026-11-24 09:22) and
/// `NeutralTerritoryV1` (4, unowned and weaker keeps + player territory)
/// with #209 (territory-q2, owner 12:09 / 13:15). A build whose frontier-abi
/// does not know a byte refuses it ([`check_wide_rules`]); nothing is
/// reinterpreted.
pub const KEEP_HOLDER_NAMES: [(&str, u8); 4] = [
    ("MixedInterleaved", 1),
    ("OrbitBalanced", 2),
    ("Neutral", 3),
    ("NeutralTerritoryV1", 4),
];

/// The name of a keep-holder byte (`"?"` outside [`KEEP_HOLDER_NAMES`]). Pure.
pub fn keep_holder_name(b: u8) -> &'static str {
    KEEP_HOLDER_NAMES
        .iter()
        .find(|(_, x)| *x == b)
        .map(|(n, _)| *n)
        .unwrap_or("?")
}

/// The new devnet world's preset (devnet-new-world-plan, owner 12:07 U2/U3):
/// defined by #209 in `frontier_abi::v2::presets` as
/// `no_dormant_release(S1_DEVNET_WIDE_CONTINUOUS)` (no ReleaseDormant), found
/// there by name so this operator needs no change when it lands.
pub const NEW_WORLD_PRESET: &str = "S1_DEVNET_TERRITORY";

/// The keep-holder bytes whose wide keeps all open unowned (owner 12:07:
/// the new world starts with ALL wide land unowned).
pub const NEUTRAL_KEEP_HOLDERS: [u8; 2] = [3, 4];

/// A playable-lane profile's wide rules, checked against this build's rule
/// table (Ok: the keep-holder byte WideSetRules will carry). The new world's
/// preset needs an explicit neutral `wide.keepHolder`. Pure.
pub fn check_wide_rules(p: &Profile) -> Result<u8, String> {
    use frontier_abi::world_index::rules as wr;
    let b = p
        .keep_holder
        .unwrap_or(wr::KeepHolderRule::MixedInterleaved as u8);
    let rule = wr::KeepHolderRule::from_byte(b).map_err(|_| {
        format!(
            "wide.keepHolder {} (byte {b}) is not in this build's rule table: it needs {} merged and the operator rebuilt",
            keep_holder_name(b),
            match b {
                3 => "#206 (neutral wide land)",
                4 => "#209 (player territory)",
                _ => "a newer frontier-abi",
            }
        )
    })?;
    if !wr::keep_holder_allowed(permutation_rules::frontier::geometry::PLACEMENT_MIXED, rule) {
        return Err(format!(
            "wide.keepHolder {}: placement 2 (the playable lane's map) does not allow it",
            keep_holder_name(b)
        ));
    }
    if p.preset == NEW_WORLD_PRESET
        && !p
            .keep_holder
            .is_some_and(|k| NEUTRAL_KEEP_HOLDERS.contains(&k))
    {
        return Err(format!(
            "season.preset {NEW_WORLD_PRESET} needs wide.keepHolder Neutral or NeutralTerritoryV1 (owner 2026-11-24 12:07: all wide land unowned), not {}",
            p.keep_holder.map_or("the default MixedInterleaved", keep_holder_name)
        ));
    }
    Ok(b)
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

fn raw_strings(v: &Value, k: &str) -> Vec<String> {
    v.get(k)
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

/// `"0x4804"` or `"18436"`.
pub fn parse_version(s: &str) -> Result<u16, String> {
    let r = match s.strip_prefix("0x").or_else(|| s.strip_prefix("0X")) {
        Some(h) => u16::from_str_radix(h, 16),
        None => s.parse(),
    };
    r.map_err(|_| format!("program version {s:?}: a u16 (0x4804)"))
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
        program_version: match v["program"]["programVersion"].as_str() {
            Some(x) => Some(parse_version(x).map_err(|e| format!("profile: {e}"))?),
            None => None,
        },
        required_markers: raw_strings(&v["program"], "requiredMarkers"),
        refused_markers: raw_strings(&v["program"], "refusedMarkers"),
        keep_holder: match v["wide"]["keepHolder"].as_str() {
            None if v["wide"]["keepHolder"].is_null() => None,
            None => return Err("profile: wide.keepHolder must be a rule name".into()),
            Some(n) => Some(
                KEEP_HOLDER_NAMES
                    .iter()
                    .find(|(x, _)| *x == n)
                    .map(|(_, b)| *b)
                    .ok_or_else(|| {
                        format!(
                            "profile: wide.keepHolder {n:?}: one of {}",
                            KEEP_HOLDER_NAMES.map(|(x, _)| x).join(", ")
                        )
                    })?,
            ),
        },
    })
}

/// The presets the operator may create, by the profile's `season.preset`
/// (or `--preset`).
pub const PRESETS: [&str; 5] = [
    "S1_LOCAL_7D",
    "S1_LOCAL_14D",
    "S1_DEVNET_WIDE_7D",
    "S1_DEVNET_WIDE_CONTINUOUS",
    NEW_WORLD_PRESET,
];

/// The presets of the playable lane: program version [`PLAYABLE_VERSION`]
/// and the wide land's WideSetRules after the season is Seeded. The
/// continuous world (owner 2026-11-23: seasons abolished) is the same lane.
pub fn is_wide_preset(name: &str) -> bool {
    name == "S1_DEVNET_WIDE_7D" || name == "S1_DEVNET_WIDE_CONTINUOUS" || name == NEW_WORLD_PRESET
}

/// The preset's parameters as the season is created: the beacon key and
/// the program version applied. Pure.
pub fn season_params(p: &Profile) -> Result<frontier_abi::v2::presets::SeasonParamsV2, String> {
    use frontier_abi::v2::presets as v2;
    let mut sp = match p.preset.as_str() {
        "S1_LOCAL_7D" => v2::S1_LOCAL_7D,
        "S1_LOCAL_14D" => v2::S1_LOCAL_14D,
        "S1_DEVNET_WIDE_7D" => v2::S1_DEVNET_WIDE_7D,
        "S1_DEVNET_WIDE_CONTINUOUS" => v2::S1_DEVNET_WIDE_CONTINUOUS,
        NEW_WORLD_PRESET => v2::PRESETS_S1
            .iter()
            .find(|(n, _)| *n == NEW_WORLD_PRESET)
            .map(|(_, p)| *p)
            .ok_or_else(|| {
                format!(
                    "season.preset {NEW_WORLD_PRESET}: not in this build's frontier-abi (it lands with #209, player territory); rebuild the operator after it merges"
                )
            })?,
        x => return Err(format!("season.preset {x}: one of {}", PRESETS.join(", "))),
    };
    let version = p.program_version.unwrap_or(if is_wide_preset(&p.preset) {
        PLAYABLE_VERSION
    } else {
        S1_VERSION
    });
    if is_wide_preset(&p.preset) && version != PLAYABLE_VERSION {
        return Err(format!(
            "season.preset {}: the wide land runs on program version 0x{PLAYABLE_VERSION:04x} only (profile program.programVersion is 0x{version:04x})",
            p.preset
        ));
    }
    if version != S1_VERSION && version != PLAYABLE_VERSION {
        return Err(format!(
            "program version 0x{version:04x}: 0x{S1_VERSION:04x} (S1 release) or 0x{PLAYABLE_VERSION:04x} (playable lane) only"
        ));
    }
    if is_wide_preset(&p.preset) && !cfg!(feature = "playable-lane") {
        return Err(format!(
            "season.preset {}: this frontier-operator was built without the playable lane; build it with `cargo build -p stack --features playable-lane --bin frontier-operator`",
            p.preset
        ));
    }
    sp.base.program_version = version;
    if p.beacon == BeaconChoice::TestKey {
        sp.base.quicknet_pk_hash = fclient::beacon::pk_hash(&fclient::beacon::TestKey::new().pk96);
    }
    Ok(sp)
}

/// The season's CreateSeason bytes from the profile (the same
/// [`setup::conquest_bytes`] the local stack uses; S1 seasons, version 4
/// or the playable lane's 0x4804).
pub fn season_bytes(p: &Profile) -> Result<SeasonBytes, String> {
    let sp = season_params(p).map_err(|e| format!("profile: {e}"))?;
    lane_bytes(&sp).map_err(|e| format!("season params ({}): {e}", p.preset))
}

/// [`setup::conquest_bytes`] for version 4, and for the playable lane's
/// 0x4804 the program's own rule (`proc/season.rs` `range_view`): the
/// ranges are checked on a copy whose `program_version` is 4, and the bytes
/// keep 0x4804 (`SeasonParamsV2::validate` knows 3, 4 and 5 only).
pub fn lane_bytes(
    sp: &frontier_abi::v2::presets::SeasonParamsV2,
) -> Result<SeasonBytes, &'static str> {
    if sp.base.program_version != PLAYABLE_VERSION {
        return setup::conquest_bytes(sp);
    }
    let mut view = *sp;
    view.base.program_version = S1_VERSION;
    view.validate()?;
    let payout = setup::payout_rev3();
    let b = sp.to_bytes();
    Ok(SeasonBytes {
        params_hash: frontier_abi::v2::presets::params_hash_v2(&b, &payout),
        params: b.to_vec(),
        payout,
        pfund_initial: sp.base.pfund_initial,
        dpool_initial: sp.base.dpool_initial,
    })
}

/// The genesis round and `genesis_ts` a `t_create_min` fixes (CreateSeason:
/// `genesis_round = first_round_from(t_create_min + 600 + seed_margin)`,
/// `genesis_ts = round_time(genesis_round) + 600`). Pure.
pub fn genesis_of(sp: &frontier_abi::v2::presets::SeasonParamsV2, t_create_min: i64) -> (u64, i64) {
    use permutation_rules::frontier::beacon as kb;
    let clock = permutation_rules::frontier::clash::BeaconClock {
        genesis: sp.base.drand_genesis,
        period: sp.base.drand_period as i64,
    };
    let r = kb::genesis_seed_round(&clock, t_create_min, sp.base.seed_margin);
    (r, kb::genesis_ts(&clock, r))
}

// ------------------------------------------------------------------ the wide land (playable lane)

/// The playable lane's one authority transaction beyond the S1 setup:
/// WideSetRules (0xDB) with the playable conquest world's rule bytes.
#[cfg(feature = "playable-lane")]
pub mod wide {
    use fclient::addr::Addresses;
    use fclient::{AccountMeta, Address, Instruction};
    use frontier_abi::world_index::rules as wr;
    use frontier_abi::world_index::wide_ix as wix;

    use crate::setup::{NewAccount, Step};

    /// The rule bytes every playable-lane world and test uses (svm-tests
    /// `devnet_preset_wide.rs`, itest `wide_land.rs`): interleaved keeps
    /// (the default; placement 2 also allows Neutral and NeutralTerritoryV1 from
    /// the profile through [`rules_for`]), the deployed Free City
    /// site (the only Free City rule placement 2 allows), no camp, the
    /// sort-key-hash region. Write-once on chain.
    pub const RULES: wr::RuleBytes = wr::RuleBytes {
        keep_holder: wr::KeepHolderRule::MixedInterleaved as u8,
        free_city: wr::FreeCityRule::DeployedLe32V1 as u8,
        camp: wr::CampRule::NoCamp as u8,
        region: wr::RegionRule::SortKeyHashV1 as u8,
    };

    pub const RULES_TEXT: &str = "keep_holder MixedInterleaved(1), free_city DeployedLe32V1(3), camp NoCamp(1), region SortKeyHashV1(1)";

    /// [`RULES`] with the profile's keep-holder byte (`None`: [`RULES`]).
    pub const fn rules_for(keep_holder: Option<u8>) -> wr::RuleBytes {
        match keep_holder {
            Some(k) => wr::RuleBytes {
                keep_holder: k,
                ..RULES
            },
            None => RULES,
        }
    }

    /// The plan's text for [`rules_for`] (exactly [`RULES_TEXT`] for the default).
    pub fn rules_text(keep_holder: Option<u8>) -> String {
        match keep_holder {
            None => RULES_TEXT.to_string(),
            Some(k) => RULES_TEXT.replacen(
                "MixedInterleaved(1)",
                &format!("{}({k})", super::keep_holder_name(k)),
                1,
            ),
        }
    }

    fn ctx(a: &Addresses) -> frontier_abi::addr::AddrCtx {
        frontier_abi::addr::AddrCtx {
            program: a.program.to_bytes(),
            season: a.season.to_bytes(),
        }
    }

    /// The season's wide RulesConfig address.
    pub fn rules_config(a: &Addresses) -> Address {
        Address::new_from_array(wr::rules_config_address(&ctx(a)))
    }

    /// `[authority s,w] [season r] [rules_config w] [system]`.
    pub fn set_rules_step(a: &Addresses, authority: Address) -> Step {
        set_rules_step_for(a, authority, RULES)
    }

    /// [`set_rules_step`] with chosen rule bytes ([`rules_for`]).
    pub fn set_rules_step_for(a: &Addresses, authority: Address, rules: wr::RuleBytes) -> Step {
        let data = wix::SetRules {
            config_version: wr::WIDE_RULES_CONFIG_VERSION,
            keep_holder: rules.keep_holder,
            free_city: rules.free_city,
            camp: rules.camp,
            region: rules.region,
        }
        .to_bytes()
        .to_vec();
        Step {
            name: "WideSetRules".into(),
            ixs: vec![Instruction {
                program_id: a.program,
                accounts: vec![
                    AccountMeta::new(authority, true),
                    AccountMeta::new_readonly(a.season, false),
                    AccountMeta::new(rules_config(a), false),
                    AccountMeta::new_readonly(fclient::addr::system_program(), false),
                ],
                data,
            }],
            creates: vec![NewAccount {
                label: "WideRulesConfig".into(),
                address: rules_config(a),
                size: wr::rules_config::SIZE,
                extra: 0,
            }],
        }
    }

    /// The rule bytes of a RulesConfig account (`None`: not one).
    pub fn rules_of(d: &[u8]) -> Option<[u8; 4]> {
        use wr::rules_config as rc;
        if d.len() < rc::SIZE || d[..8] != rc::MAGIC {
            return None;
        }
        Some([
            d[rc::KEEP_HOLDER],
            d[rc::FREE_CITY],
            d[rc::CAMP],
            d[rc::REGION],
        ])
    }

    pub fn ours() -> [u8; 4] {
        ours_for(None)
    }

    /// [`ours`] for the profile's keep-holder byte.
    pub fn ours_for(keep_holder: Option<u8>) -> [u8; 4] {
        let r = rules_for(keep_holder);
        [r.keep_holder, r.free_city, r.camp, r.region]
    }
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
    /// The wide RulesConfig's rule bytes (playable lane; `None`: absent or
    /// not read).
    pub rules: Option<[u8; 4]>,
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
            rules: None,
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

/// Reads the Clock, the Season, the BeaconLogs and the JoinShards (and,
/// with `wide`, the wide RulesConfig).
pub async fn observe(chain: &Chain, a: &Addresses, wide: bool) -> Result<Observed, String> {
    use fclient::abi::{FACTIONS, REGIONS, SHARDS_PER_FACTION};
    let clock = timed(chain.port.clock())
        .await?
        .map_err(|e| format!("Clock: {e}"))?;
    let mut keys = vec![a.season];
    keys.extend((0..REGIONS).map(|r| a.beacon_log(r)));
    for f in 0..FACTIONS {
        keys.extend((0..SHARDS_PER_FACTION).map(|s| a.join_shard(f, s)));
    }
    let rules_at = keys.len();
    if wide {
        keys.push(rules_config_address(a)?);
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
    if wide && present(rules_at)? {
        let d = &got[rules_at].as_ref().expect("present").data;
        o.rules = Some(
            rules_of(d)
                .ok_or_else(|| format!("{} is not a wide RulesConfig: refused", keys[rules_at]))?,
        );
    }
    Ok(o)
}

#[cfg(feature = "playable-lane")]
fn rules_config_address(a: &Addresses) -> Result<Address, String> {
    Ok(wide::rules_config(a))
}
#[cfg(not(feature = "playable-lane"))]
fn rules_config_address(_: &Addresses) -> Result<Address, String> {
    Err("the playable lane needs the playable-lane build".into())
}
#[cfg(feature = "playable-lane")]
fn rules_of(d: &[u8]) -> Option<[u8; 4]> {
    wide::rules_of(d)
}
#[cfg(not(feature = "playable-lane"))]
fn rules_of(_: &[u8]) -> Option<[u8; 4]> {
    None
}
#[cfg(feature = "playable-lane")]
fn set_rules_step(a: &Addresses, authority: Address, k: Option<u8>) -> Result<Step, String> {
    Ok(wide::set_rules_step_for(a, authority, wide::rules_for(k)))
}
#[cfg(not(feature = "playable-lane"))]
fn set_rules_step(_: &Addresses, _: Address, _: Option<u8>) -> Result<Step, String> {
    Err("the playable lane needs the playable-lane build".into())
}
#[cfg(feature = "playable-lane")]
fn our_rules(k: Option<u8>) -> [u8; 4] {
    wide::ours_for(k)
}
#[cfg(not(feature = "playable-lane"))]
fn our_rules(_: Option<u8>) -> [u8; 4] {
    [0; 4]
}

/// One planned transaction: a setup step and the chain time it waits for.
#[derive(Clone, Debug, PartialEq)]
pub struct Planned {
    pub step: Step,
    /// CreateSeason (and what follows it) waits for `t_create_min`;
    /// `None` with [`Plan::t_create_min`] `None`: after the announce lead.
    pub not_before: Option<i64>,
    /// WideSetRules: only once the season is Seeded (keeper A's
    /// ConsumeGenesisSeed), whatever the clock.
    pub after_seeded: bool,
}

/// What the plan covers beyond the S1 setup.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct PlanOpts {
    /// The playable lane: WideSetRules after the season is Seeded.
    pub wide: bool,
    /// `--t-create-min`: the announced `t_create_min` (else the chain
    /// clock + lead + [`ANNOUNCE_MARGIN_SECS`]).
    pub t_create_min: Option<i64>,
    /// The profile's `wide.keepHolder` byte (`None`: MixedInterleaved).
    pub keep_holder: Option<u8>,
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

/// What is left to do, from what the chain holds (the S1 setup). Pure.
pub fn plan(
    obs: &Observed,
    a: &Addresses,
    authority: Address,
    sb: &SeasonBytes,
) -> Result<Plan, String> {
    plan_with(obs, a, authority, sb, PlanOpts::default())
}

/// [`plan`] with the playable lane's WideSetRules and a chosen
/// `t_create_min`. Pure.
pub fn plan_with(
    obs: &Observed,
    a: &Addresses,
    authority: Address,
    sb: &SeasonBytes,
    o: PlanOpts,
) -> Result<Plan, String> {
    use fclient::abi::status as st;
    let mut p = plan_s1(obs, a, authority, sb, o.t_create_min)?;
    if !o.wide {
        return Ok(p);
    }
    let seeded = matches!(p.status, Some(x) if x == st::SEEDED || x == st::RUNNING);
    match obs.rules {
        Some(r) if r == our_rules(o.keep_holder) => p.done.push("WideSetRules".into()),
        Some(r) => p.done.push(format!(
            "WideSetRules (other rule bytes on chain: {r:?}; write-once)"
        )),
        None => {
            let not_before = p.todo.last().and_then(|t| t.not_before);
            p.todo.push(Planned {
                step: set_rules_step(a, authority, o.keep_holder)?,
                not_before: if seeded { None } else { not_before },
                after_seeded: !seeded,
            })
        }
    }
    Ok(p)
}

fn plan_s1(
    obs: &Observed,
    a: &Addresses,
    authority: Address,
    sb: &SeasonBytes,
    chosen: Option<i64>,
) -> Result<Plan, String> {
    use fclient::abi::status as st;
    let after = setup::after_announce_steps(a, authority, sb);
    let Some(s) = &obs.season else {
        let t = match (chosen, obs.now) {
            (Some(t), Some(now))
                if t < now + frontier_abi::presets::MIN_ANNOUNCE_LEAD_SECS + T_CREATE_MIN_SLACK_SECS =>
            {
                return Err(format!(
                    "--t-create-min {t}: the program needs at least {} s of lead and the chain clock is {now}; pick >= {}",
                    frontier_abi::presets::MIN_ANNOUNCE_LEAD_SECS,
                    now + frontier_abi::presets::MIN_ANNOUNCE_LEAD_SECS + T_CREATE_MIN_SLACK_SECS
                ))
            }
            (Some(t), _) => Some(t),
            (None, now) => {
                now.map(|n| n + frontier_abi::presets::MIN_ANNOUNCE_LEAD_SECS + ANNOUNCE_MARGIN_SECS)
            }
        };
        let mut todo = vec![Planned {
            step: setup::announce_step(a, authority, sb.params_hash, t.unwrap_or(0)),
            not_before: None,
            after_seeded: false,
        }];
        todo.extend(after.into_iter().map(|step| Planned {
            step,
            not_before: t,
            after_seeded: false,
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
                after_seeded: false,
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
                    after_seeded: false,
                });
            }
            for (f, step) in it.enumerate() {
                if group(&format!("JoinShards of faction {f}"), &obs.shards[f])? {
                    done.push(step.name);
                } else {
                    todo.push(Planned {
                        step,
                        not_before: None,
                        after_seeded: false,
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
    /// The playable lane's line (`None` for an S1 season: its plan text is
    /// unchanged).
    pub lane: Option<String>,
    /// The genesis round and `genesis_ts` the plan's `t_create_min` fixes.
    pub genesis: Option<(u64, i64)>,
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
    if let Some(l) = &h.lane {
        let _ = writeln!(o, "lane       {l}");
    }
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
    if let Some((r, g)) = h.genesis {
        let _ = writeln!(
            o,
            "genesis    round {r} (quicknet; keeper A consumes it), genesis_ts {g}"
        );
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
            _ if t.after_seeded => {
                "after keeper A's ConsumeGenesisSeed: the season Seeded".to_string()
            }
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
            } else if t.step.name == "WideSetRules" {
                let _ = writeln!(
                    o,
                    "      data   {} B: tag 0x{:02x}, config_version {}, {}",
                    ix.data.len(),
                    ix.data[0],
                    u16::from_le_bytes([ix.data[1], ix.data[2]]),
                    wide_rules_text(h.profile.keep_holder)
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

#[cfg(feature = "playable-lane")]
fn wide_rules_text(k: Option<u8>) -> String {
    wide::rules_text(k)
}
#[cfg(not(feature = "playable-lane"))]
fn wide_rules_text(_: Option<u8>) -> String {
    String::new()
}

// ------------------------------------------------------------------ checks and sending

/// What the cluster's program is: its ELF's sha256 (the `.so` file's, as
/// `sha256sum` gives it: the ProgramData holds the ELF padded to `max_len`),
/// and which of the profile's markers it carries.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ProgramInfo {
    pub sha256: Option<String>,
    /// `solana-verify get-program-hash`'s hash: the ProgramData after its
    /// header with trailing zero bytes stripped (Ellipsis-Labs/
    /// solana-verifiable-build `get_binary_hash`). It differs from
    /// [`ProgramInfo::sha256`] when the ELF itself ends in zeros (the
    /// playable lane's does: `786ef80f…` vs `da3dc1aa…`, and `8dcaef87…` vs `67a33c92…` after P14 b).
    pub verify_hash: Option<String>,
    pub elf_len: usize,
    pub found_markers: Vec<String>,
    /// Required markers missing and refused markers present.
    pub marker_problems: Vec<String>,
}

/// The ELF's length from its header (`e_shoff + e_shnum × e_shentsize`:
/// cargo-build-sbf writes the section headers last), if `d` is a 64-bit
/// little-endian ELF that fits.
pub fn elf_len(d: &[u8]) -> Option<usize> {
    if d.len() < 64 || d[..4] != *b"\x7fELF" || d[4] != 2 || d[5] != 1 {
        return None;
    }
    let shoff = u64::from_le_bytes(d[0x28..0x30].try_into().ok()?) as usize;
    let size = u16::from_le_bytes(d[0x3A..0x3C].try_into().ok()?) as usize;
    let n = u16::from_le_bytes(d[0x3C..0x3E].try_into().ok()?) as usize;
    let len = shoff.checked_add(size.checked_mul(n)?)?;
    (len <= d.len() && len >= 64).then_some(len)
}

/// [`ProgramInfo`] of a ProgramData account's data. Pure.
pub fn program_info(programdata: &[u8], p: &Profile) -> ProgramInfo {
    let elf = programdata.get(PROGRAMDATA_HEADER..).unwrap_or(&[]);
    let Some(len) = elf_len(elf) else {
        return ProgramInfo {
            marker_problems: vec!["the ProgramData holds no ELF".into()],
            ..ProgramInfo::default()
        };
    };
    let stripped = {
        let all = programdata.get(PROGRAMDATA_HEADER..).unwrap_or(&[]);
        let end = all.iter().rposition(|b| *b != 0).map_or(0, |i| i + 1);
        hex::encode(<sha2::Sha256 as sha2::Digest>::digest(&all[..end]))
    };
    let elf = &elf[..len];
    let has = |m: &str| elf.windows(m.len()).any(|w| w == m.as_bytes());
    let mut info = ProgramInfo {
        sha256: Some(hex::encode(<sha2::Sha256 as sha2::Digest>::digest(elf))),
        verify_hash: Some(stripped),
        elf_len: len,
        ..ProgramInfo::default()
    };
    for m in &p.required_markers {
        if has(m) {
            info.found_markers.push(m.clone());
        } else {
            info.marker_problems.push(format!(
                "required marker {m} is not in the deployed program"
            ));
        }
    }
    for m in &p.refused_markers {
        if has(m) {
            info.found_markers.push(m.clone());
            info.marker_problems
                .push(format!("refused marker {m} is in the deployed program"));
        }
    }
    info
}

/// Why a send would be refused before anything is read (the flags only).
/// Loopback chains need `--yes-send` alone; a public cluster also
/// [`APPROVAL_FLAG`] and `--approved-sha256`.
pub fn gate_flags(o: &Opts, ep: Endpoint) -> Vec<String> {
    let mut out = vec![];
    if !o.yes_send {
        out.push("--yes-send is not given (dry run)".into());
    }
    if ep == Endpoint::Public {
        if !o.approval {
            out.push(format!(
                "{APPROVAL_FLAG} is not given (a public cluster: r0ze's go-ahead)"
            ));
        }
        if o.approved_sha256.is_none() {
            out.push("--approved-sha256 <sha256 of the .so r0ze approved> is not given".into());
        }
    }
    out
}

/// The gate after the program is read: the approved hash is the deployed
/// program's, and its markers are the profile's.
pub fn gate_program(o: &Opts, ep: Endpoint, info: &ProgramInfo) -> Vec<String> {
    let mut out = vec![];
    if let Some(want) = &o.approved_sha256 {
        match &info.sha256 {
            Some(h) if h == want => {}
            Some(h) => out.push(format!(
                "--approved-sha256 {want} is not the deployed program's sha256 {h}"
            )),
            None => out.push("the deployed program's sha256 could not be read".into()),
        }
    }
    if ep == Endpoint::Public || o.approved_sha256.is_some() {
        out.extend(info.marker_problems.iter().cloned());
    }
    out
}

/// The program at `a.program` exists and `authority` is its upgrade
/// authority (I-51: AnnounceSeason reads it from the ProgramData); with
/// what the program is ([`ProgramInfo`], default when it is absent).
pub async fn check_program(
    chain: &Chain,
    a: &Addresses,
    authority: Address,
    p: &Profile,
) -> (Result<(), String>, ProgramInfo) {
    let got = match chain.accounts(&[a.program, a.programdata()]).await {
        Ok(g) => g,
        Err(e) => return (Err(e), ProgramInfo::default()),
    };
    let info = got[1]
        .as_ref()
        .map(|pd| program_info(&pd.data, p))
        .unwrap_or_default();
    (program_authority(&got, a, authority), info)
}

fn program_authority(
    got: &[Option<fclient::ports::Account>],
    a: &Addresses,
    authority: Address,
) -> Result<(), String> {
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
    /// Sleep through the lead (and, for WideSetRules, until the season is
    /// Seeded) instead of exiting with [`EXIT_WAITING`].
    pub wait: bool,
    /// Stop after this many transactions (a staged run; the next run resumes).
    pub max_txs: Option<usize>,
    /// The plan's options (playable lane, chosen `t_create_min`).
    pub plan: PlanOpts,
    /// The loaded-accounts-data limit each transaction requests.
    pub loaded_limit: u32,
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
    /// WideSetRules waits for keeper A's ConsumeGenesisSeed.
    WaitingSeeded { sent: usize, status: u8 },
    /// `--max-txs` reached.
    Stopped { sent: usize },
}

/// One landed transaction: what the cluster says it cost.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Landed {
    pub name: String,
    pub signature: String,
    pub slot: u64,
    /// `meta.computeUnitsConsumed` (`None`: the cluster did not say).
    pub cu: Option<u64>,
    pub fee: Option<u64>,
    /// The authority's (fee payer's) balance before minus after.
    pub lamports: Option<u64>,
}

impl Landed {
    pub fn line(&self) -> String {
        let n = |x: Option<u64>| x.map_or("?".to_string(), grouped);
        format!(
            "landed     {:<16} cu {:>9}  fee {:>7}  lamports {:>15}  slot {}  sig {}",
            self.name,
            n(self.cu),
            n(self.fee),
            n(self.lamports),
            self.slot,
            self.signature
        )
    }

    pub fn json(&self) -> Value {
        json!({"tx": self.name, "signature": self.signature, "slot": self.slot,
            "compute_units": self.cu, "fee": self.fee, "lamports_from_authority": self.lamports})
    }
}

/// `getTransaction` of a landed signature (a few tries: a public node may
/// answer a status before the transaction).
pub async fn landed(chain: &Chain, name: &str, sig: &str) -> Landed {
    let mut v = Value::Null;
    for _ in 0..10 {
        v = chain
            .call(
                "getTransaction",
                json!([sig, {"encoding": "json", "commitment": "confirmed", "maxSupportedTransactionVersion": fclient::rpc::MAX_TX_VERSION}]),
            )
            .await
            .unwrap_or(Value::Null);
        if !v.is_null() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    let m = &v["meta"];
    let pre = m["preBalances"][0].as_u64();
    let post = m["postBalances"][0].as_u64();
    Landed {
        name: name.to_string(),
        signature: sig.to_string(),
        slot: v["slot"].as_u64().unwrap_or(0),
        cu: m["computeUnitsConsumed"].as_u64(),
        fee: m["fee"].as_u64(),
        lamports: pre.zip(post).map(|(a, b)| a.saturating_sub(b)),
    }
}

/// Sends what is missing, one transaction at a time, re-reading the chain
/// before each (so a concurrent or earlier run is never repeated). Every
/// landed transaction goes to `record`.
#[allow(clippy::too_many_arguments)]
pub async fn execute(
    chain: &Chain,
    a: &Addresses,
    authority: &Keypair,
    sb: &SeasonBytes,
    opts: SendOpts,
    log: &mut dyn FnMut(&str),
    record: &mut dyn FnMut(&Landed),
) -> Result<Outcome, String> {
    use fclient::abi::status as st;
    let auth = authority.pubkey();
    let mut sent = 0usize;
    let started = Instant::now();
    let mut wait_limit: Option<Duration> = None;
    loop {
        let obs = observe(chain, a, opts.plan.wide).await?;
        let p = plan_with(&obs, a, auth, sb, opts.plan)?;
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
        let status = p.status.unwrap_or(st::ANNOUNCED);
        if next.after_seeded && status != st::SEEDED && status != st::RUNNING {
            if !opts.wait {
                return Ok(Outcome::WaitingSeeded { sent, status });
            }
            // Genesis is 600 s after the genesis round; keeper A consumes it then. Allow two hours.
            let limit = *wait_limit.get_or_insert(Duration::from_secs(7_200));
            if started.elapsed() > limit {
                return Err(format!(
                    "waited {:?} and the season is still {} (keeper A's ConsumeGenesisSeed has not landed)",
                    started.elapsed(),
                    status_name(status)
                ));
            }
            log(&format!(
                "waiting for the season to be Seeded (keeper A's ConsumeGenesisSeed; now {})",
                status_name(status)
            ));
            tokio::time::sleep(Duration::from_secs(15)).await;
            continue;
        }
        let name = next.step.name.clone();
        log(&format!("sending {name}"));
        let sig = chain
            .send_op_with(&next.step.ixs, &[authority], LAND_LIMIT, opts.loaded_limit)
            .await
            .map_err(|e| {
                format!("{name}: {e}\n(re-run to resume: the tool re-reads the chain and sends only what is missing)")
            })?;
        sent += 1;
        let l = landed(chain, &name, &sig.to_string()).await;
        log(&format!("{name}: finalized"));
        record(&l);
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
    /// `--preset`: overrides the profile's `season.preset`.
    pub preset: Option<String>,
    /// `--t-create-min`: the announced `t_create_min` (unix seconds).
    pub t_create_min: Option<i64>,
    /// [`APPROVAL_FLAG`].
    pub approval: bool,
    /// `--approved-sha256`: the deployed program's sha256 r0ze approved.
    pub approved_sha256: Option<String>,
    /// `--record FILE`: one JSON line per landed transaction (appended).
    pub record: Option<String>,
}

pub const USAGE: &str = "usage: frontier-operator --profile FILE [--preset NAME] [--rpc URL]
                         [--authority KEYFILE] [--offline] [--t-create-min UNIX]
                         [--yes-send [--i-have-r0ze-approval --approved-sha256 HEX]]
                         [--wait] [--max-txs N] [--record FILE]

  Dry run by default: reads the cluster (unless --offline) and prints the
  season setup plan, every transaction with its accounts, data and cost.
  --yes-send sends what is missing, signed by the --authority key file
  (mode 600, the program's upgrade authority). On a public cluster (devnet)
  a send also needs --i-have-r0ze-approval and --approved-sha256 (the
  deployed program's sha256). --preset S1_DEVNET_WIDE_7D or
  S1_DEVNET_WIDE_CONTINUOUS (the same world with no end): the playable lane
  (program version 0x4804; WideSetRules after keeper A seeds the season;
  its keep-holder rule is the profile's wide.keepHolder, default
  MixedInterleaved). S1_DEVNET_TERRITORY (the new world: no ReleaseDormant,
  needs wide.keepHolder Neutral or NeutralTerritoryV1) exists once #209 is in
  this build. --rpc is --cluster-url. Presets: S1_LOCAL_7D, S1_LOCAL_14D,
  S1_DEVNET_WIDE_7D, S1_DEVNET_WIDE_CONTINUOUS, S1_DEVNET_TERRITORY.
  Exit: 0 done/plan printed, 1 failed, 2 refused, 3 waiting (t_create_min,
  or the season to be Seeded); run the same command again to resume.
  frontier-operator end-season --help: the season's end and clean-up
  (EndSeason, then from end + 72 h the province closes and CloseSeason).";

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
            "--cluster-url" | "--rpc" => {
                if o.cluster_url.is_some() {
                    return Err("--rpc / --cluster-url given twice".into());
                }
                o.cluster_url = Some(val("--rpc")?)
            }
            "--preset" => o.preset = Some(val("--preset")?),
            "--offline" => o.offline = true,
            "--yes-send" => o.yes_send = true,
            "--wait" => o.wait = true,
            x if x == APPROVAL_FLAG => o.approval = true,
            "--approved-sha256" => {
                let h = val("--approved-sha256")?.to_ascii_lowercase();
                if h.len() != 64 || !h.bytes().all(|b| b.is_ascii_hexdigit()) {
                    return Err("--approved-sha256 HEX (64 hex digits)".into());
                }
                o.approved_sha256 = Some(h)
            }
            "--t-create-min" => {
                o.t_create_min = Some(
                    val("--t-create-min")?
                        .parse()
                        .map_err(|_| "--t-create-min UNIX (seconds)")?,
                )
            }
            "--record" => o.record = Some(val("--record")?),
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
    if (o.approval || o.approved_sha256.is_some()) && !o.yes_send {
        return Err(format!(
            "{APPROVAL_FLAG} / --approved-sha256 belong to a send: add --yes-send (or drop them for a dry run)"
        ));
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
    // devnet-end-season (D-dress-6): the season's end and clean-up.
    if args.first().map(String::as_str) == Some("end-season") {
        return crate::operator_end::main_with(&args[1..], out, err).await;
    }
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

/// The plan header's lane line (`None` for a version-4 S1 season).
fn lane_line(version: u16, wide: bool, loaded_limit: u32) -> Option<String> {
    (version != S1_VERSION).then(|| {
        format!(
            "playable (program_version 0x{version:04x}{}); each tx requests cu_limit 1,400,000, loaded data {} MiB",
            if wide {
                "; + WideSetRules, the wide land's rules, once keeper A has seeded the season"
            } else {
                ""
            },
            loaded_limit / (1024 * 1024)
        )
    })
}

async fn run(o: &Opts, out: &mut dyn FnMut(&str), err: &mut dyn FnMut(&str)) -> Result<i32, Fail> {
    let text =
        std::fs::read_to_string(&o.profile).map_err(|e| refused(format!("{}: {e}", o.profile)))?;
    let mut profile = parse_profile(&text).map_err(refused)?;
    if let Some(p) = &o.preset {
        profile.preset = p.clone();
    }
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
    // The send gate's flags, before any key is read or the cluster contacted.
    if o.yes_send {
        let closed = gate_flags(o, ep);
        if !closed.is_empty() {
            return Err(refused(format!(
                "SEND GATE: CLOSED\n  - {}\n(nothing was read or sent; without --yes-send this is a dry run)",
                closed.join("\n  - ")
            )));
        }
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
    let sp = season_params(&profile).map_err(|e| refused(format!("profile: {e}")))?;
    let sb = season_bytes(&profile).map_err(refused)?;
    let a = Addresses::new(program, profile.season_id);
    let wide = is_wide_preset(&profile.preset);
    if wide {
        check_wide_rules(&profile).map_err(|e| refused(format!("profile: {e}")))?;
    }
    let version = sp.base.program_version;
    let loaded_limit = if version == S1_VERSION {
        crate::chain::OP_LOADED_LIMIT
    } else {
        crate::chain::MAX_LOADED_LIMIT
    };
    let popts = PlanOpts {
        wide,
        t_create_min: o.t_create_min,
        keep_holder: profile.keep_holder,
    };

    if o.offline {
        let p = plan_with(&Observed::fresh(), &a, authority, &sb, popts).map_err(refused)?;
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
            lane: lane_line(version, wide, loaded_limit),
            genesis: p.t_create_min.map(|t| genesis_of(&sp, t)),
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
    // A loopback URL that reaches devnet (an SSH tunnel, a local proxy) is
    // devnet: the public cluster's gate applies, decided by the cluster's
    // genesis, not by the URL.
    let ep = if genesis == DEVNET_GENESIS {
        Endpoint::Public
    } else {
        ep
    };
    if profile.beacon == BeaconChoice::TestKey && ep == Endpoint::Public {
        return Err(refused(
            "operator.beacon test-key is for loopback test chains only (I-53); this cluster is devnet",
        ));
    }
    if o.yes_send {
        let closed = gate_flags(o, ep);
        if !closed.is_empty() {
            return Err(refused(format!(
                "SEND GATE: CLOSED (genesis {genesis} is devnet's)\n  - {}\n(nothing was sent)",
                closed.join("\n  - ")
            )));
        }
    }
    let (prog_check, info) = check_program(&chain, &a, authority, &profile).await;
    let obs = observe(&chain, &a, wide)
        .await
        .map_err(|e| (EXIT_FAILED, e))?;
    let p = plan_with(&obs, &a, authority, &sb, popts).map_err(refused)?;
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
        lane: lane_line(version, wide, loaded_limit),
        genesis: p.t_create_min.map(|t| genesis_of(&sp, t)),
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
    if let Some(h) = &info.sha256 {
        out(&format!(
            "program    sha256 {h} ({} B ELF; solana-verify program hash {}){}",
            grouped(info.elf_len as u64),
            info.verify_hash.as_deref().unwrap_or("?"),
            if info.found_markers.is_empty() {
                String::new()
            } else {
                format!("; markers {}", info.found_markers.join(", "))
            }
        ));
    }
    for m in &info.marker_problems {
        out(&format!("check      FAILED: {m}"));
    }
    let mut closed = gate_flags(o, ep);
    closed.extend(gate_program(o, ep, &info));
    if let Err(e) = &prog_check {
        closed.push(e.clone());
    }
    if balance < cost.total() {
        closed.push(format!(
            "the authority holds {} lamports, the plan needs {}: fund it first",
            grouped(balance),
            grouped(cost.total())
        ));
    }
    if p.todo.is_empty() {
        out("setup      complete: nothing to send");
        return Ok(EXIT_OK);
    }
    if closed.is_empty() {
        out("SEND GATE: OPEN");
    } else {
        out(&format!("SEND GATE: CLOSED\n  - {}", closed.join("\n  - ")));
    }
    if !o.yes_send {
        out(&format!(
            "DRY RUN: nothing sent. Add --yes-send (with --authority{}) to send.",
            if ep == Endpoint::Public {
                format!(", {APPROVAL_FLAG} and --approved-sha256")
            } else {
                String::new()
            }
        ));
        return Ok(EXIT_OK);
    }
    if !closed.is_empty() {
        return Err(refused(format!("SEND GATE: CLOSED: {}", closed.join("; "))));
    }
    let key = key.expect("--yes-send has --authority");
    let mut log = |l: &str| err(l);
    let mut rec_lines: Vec<Landed> = vec![];
    let r = execute(
        &chain,
        &a,
        &key,
        &sb,
        SendOpts {
            wait: o.wait,
            max_txs: o.max_txs,
            plan: popts,
            loaded_limit,
        },
        &mut log,
        &mut |l: &Landed| rec_lines.push(l.clone()),
    )
    .await;
    for l in &rec_lines {
        out(&l.line());
    }
    if let Some(path) = &o.record {
        use std::io::Write;
        let mut f = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .map_err(|e| (EXIT_FAILED, format!("--record {path}: {e}")))?;
        for l in &rec_lines {
            let mut v = l.json();
            v["season_id"] = json!(a.season_id);
            v["preset"] = json!(profile.preset);
            writeln!(f, "{v}").map_err(|e| (EXIT_FAILED, format!("--record {path}: {e}")))?;
        }
    }
    let r = r.map_err(|e| (EXIT_FAILED, e))?;
    Ok(match r {
        Outcome::Complete { sent } => {
            out(&format!(
                "setup      complete: {sent} transaction(s) sent; season {} is {}",
                a.season_id,
                if wide {
                    "set up for the playable lane (keeper A: rings duty extend to 128 with lazy_provinces; the wide rings are not a keeper duty yet)"
                } else {
                    "ready for keeper A's ConsumeGenesisSeed"
                }
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
        Outcome::WaitingSeeded { sent, status } => {
            out(&format!(
                "waiting    {sent} transaction(s) sent; WideSetRules needs the season Seeded (now {}): start keeper A (its beacon duty sends ConsumeGenesisSeed at genesis), then run the same command again (or add --wait).",
                status_name(status)
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

    fn wide_profile() -> Profile {
        let mut p = profile("devnet");
        p.preset = "S1_DEVNET_WIDE_7D".into();
        p
    }

    /// devnet-new-world-plan: `wide.keepHolder` names the WideSetRules
    /// keep-holder rule; absent keeps the old default byte for byte.
    #[test]
    fn wide_keep_holder_from_the_profile() {
        let with = |k: serde_json::Value| {
            parse_profile(
                &json!({
                    "schema": PROFILE_SCHEMA, "cluster": "devnet",
                    "rpcUrl": "https://api.devnet.solana.com",
                    "programId": "<SET-BY-R0ZE: program>",
                    "upgradeAuthority": "<SET-BY-R0ZE: authority>",
                    "rent": {"assume": 5080},
                    "season": {"preset": "S1_DEVNET_WIDE_CONTINUOUS"},
                    "operator": {"seasonId": 3},
                    "wide": {"keepHolder": k}
                })
                .to_string(),
            )
        };
        assert_eq!(wide_profile().keep_holder, None);
        assert_eq!(with(json!(null)).unwrap().keep_holder, None);
        for (n, b) in KEEP_HOLDER_NAMES {
            assert_eq!(with(json!(n)).unwrap().keep_holder, Some(b));
            assert_eq!(keep_holder_name(b), n);
        }
        assert!(with(json!("neutral"))
            .unwrap_err()
            .contains("one of MixedInterleaved"));
        assert!(with(json!(3)).unwrap_err().contains("must be a rule name"));
        assert_eq!(keep_holder_name(9), "?");
        // The table's known bytes agree with this build's frontier-abi.
        use frontier_abi::world_index::rules::KeepHolderRule as K;
        assert_eq!(K::MixedInterleaved as u8, 1);
        assert_eq!(K::OrbitBalanced as u8, 2);
        for (n, b) in KEEP_HOLDER_NAMES {
            if let Ok(k) = K::from_byte(b) {
                assert_eq!(format!("{k:?}"), n, "byte {b}");
            }
        }
        // Default: MixedInterleaved, allowed on placement 2.
        assert_eq!(check_wide_rules(&wide_profile()), Ok(1));
        // OrbitBalanced is known but placement 2 refuses it.
        let mut p = wide_profile();
        p.keep_holder = Some(2);
        assert!(check_wide_rules(&p).unwrap_err().contains("placement 2"));
        // Neutral / NeutralTerritoryV1: refused until #206 / #209 are in the build.
        for (b, pr) in [(3u8, "#206"), (4, "#209")] {
            p.keep_holder = Some(b);
            match K::from_byte(b) {
                Ok(_) => assert_eq!(check_wide_rules(&p), Ok(b)),
                Err(_) => assert!(check_wide_rules(&p).unwrap_err().contains(pr)),
            }
        }
    }

    /// devnet-new-world-plan (owner 12:07 U2/U3): the new world's preset is
    /// found by name in frontier-abi (#209), needs a neutral keep holder and
    /// commits to another params hash than the announced Season 2's.
    #[test]
    fn the_new_world_preset() {
        use frontier_abi::world_index::rules::KeepHolderRule as K;
        assert!(PRESETS.contains(&NEW_WORLD_PRESET));
        assert!(is_wide_preset(NEW_WORLD_PRESET));
        let mut p = wide_profile();
        p.preset = NEW_WORLD_PRESET.into();
        // A missing or non-neutral keep holder is refused, whatever the build.
        assert!(check_wide_rules(&p)
            .unwrap_err()
            .contains("all wide land unowned"));
        p.keep_holder = Some(1);
        let e = check_wide_rules(&p).unwrap_err();
        assert!(
            e.contains("Neutral or NeutralTerritoryV1") && e.contains("MixedInterleaved"),
            "{e}"
        );
        p.keep_holder = Some(4);
        if K::from_byte(4).is_err() {
            assert!(check_wide_rules(&p).unwrap_err().contains("#209"));
        } else {
            assert_eq!(check_wide_rules(&p), Ok(4));
        }
        let in_abi = frontier_abi::v2::presets::PRESETS_S1
            .iter()
            .any(|(n, _)| *n == NEW_WORLD_PRESET);
        let r = season_params(&p);
        if !cfg!(feature = "playable-lane") {
            assert!(r.is_err());
            return;
        }
        if !in_abi {
            assert!(r.unwrap_err().contains("lands with #209"));
            return;
        }
        let sp = r.unwrap();
        assert_eq!(sp.base.program_version, PLAYABLE_VERSION);
        assert_eq!(sp.cq.continuous, 1);
        assert_eq!(sp.base.release_after_secs, u32::MAX);
        let mut c = wide_profile();
        c.preset = "S1_DEVNET_WIDE_CONTINUOUS".into();
        assert_ne!(
            season_bytes(&p).unwrap().params_hash,
            season_bytes(&c).unwrap().params_hash,
            "the announced Season 2 (S1_DEVNET_WIDE_CONTINUOUS) can never be created with the new preset"
        );
    }

    #[test]
    fn presets_and_versions() {
        assert_eq!(parse_version("0x4804"), Ok(0x4804));
        assert_eq!(parse_version("4"), Ok(4));
        assert!(parse_version("0xZZ").is_err());
        // S1 presets: version 4 unless the profile names the lane's.
        let mut p = profile("devnet");
        assert_eq!(season_params(&p).unwrap().base.program_version, S1_VERSION);
        p.program_version = Some(PLAYABLE_VERSION);
        assert_eq!(
            season_params(&p).unwrap().base.program_version,
            PLAYABLE_VERSION
        );
        p.program_version = Some(0x4004);
        assert!(season_params(&p).unwrap_err().contains("0x4004"));
        // The wide preset: 0x4804 only, and only in a playable-lane build.
        let mut w = wide_profile();
        let r = season_params(&w);
        if cfg!(feature = "playable-lane") {
            let sp = r.unwrap();
            assert_eq!(sp.base.program_version, PLAYABLE_VERSION);
            assert_eq!(sp.cq.r_max_ceiling, 128);
            let sb = season_bytes(&w).unwrap();
            assert_eq!(sb.pfund_initial, 36_000_000_000);
            // The program's range view: version 4 validates, the bytes keep 0x4804.
            let o = params_version_offset();
            assert_eq!(
                u16::from_le_bytes([sb.params[o], sb.params[o + 1]]),
                PLAYABLE_VERSION
            );
        } else {
            assert!(r.unwrap_err().contains("--features playable-lane"));
        }
        w.program_version = Some(S1_VERSION);
        assert!(season_params(&w).is_err());
        assert!(is_wide_preset("S1_DEVNET_WIDE_7D") && !is_wide_preset("S1_LOCAL_7D"));
        assert!(is_wide_preset("S1_DEVNET_WIDE_CONTINUOUS"));
    }

    /// devnet-continuous-1: the continuous devnet world is the playable
    /// lane (0x4804, WideSetRules) with no end bell, and commits to another
    /// params hash than the 7-day preset (a new AnnounceSeason, a new id).
    #[test]
    fn continuous_wide_preset() {
        let mut w = wide_profile();
        w.preset = "S1_DEVNET_WIDE_CONTINUOUS".into();
        let r = season_params(&w);
        if !cfg!(feature = "playable-lane") {
            assert!(r.unwrap_err().contains("--features playable-lane"));
            return;
        }
        let sp = r.unwrap();
        assert_eq!(sp.base.program_version, PLAYABLE_VERSION);
        assert_eq!(sp.cq.continuous, 1);
        assert_eq!(sp.base.end_bell, frontier_abi::presets::NO_END_BELL);
        assert_eq!(sp.base.join_close_bell, frontier_abi::presets::NO_END_BELL);
        assert_eq!(sp.cq.r_max_ceiling, 128);
        let sb = season_bytes(&w).unwrap();
        assert_eq!(sb.pfund_initial, 36_000_000_000);
        let finite = season_bytes(&wide_profile()).unwrap();
        assert_ne!(sb.params_hash, finite.params_hash);
        assert_eq!(sb.params.len(), finite.params.len());
        // genesis does not depend on the end bell.
        assert_eq!(
            genesis_of(&sp, 1_790_456_787),
            genesis_of(&season_params(&wide_profile()).unwrap(), 1_790_456_787)
        );
    }

    /// The offset of `program_version` in CreateSeason's params bytes.
    fn params_version_offset() -> usize {
        let mut a = frontier_abi::v2::presets::S1_LOCAL_7D;
        let mut b = a;
        a.base.program_version = 0;
        b.base.program_version = 0xFFFF;
        let (x, y) = (a.to_bytes(), b.to_bytes());
        (0..x.len())
            .find(|i| x[*i] != y[*i])
            .expect("the version bytes")
    }

    #[test]
    fn genesis_follows_t_create_min() {
        let sp = frontier_abi::v2::presets::S1_DEVNET_WIDE_7D;
        let (r, g) = genesis_of(&sp, 1_790_456_787);
        assert_eq!(r, 32_551_361);
        assert_eq!(
            g,
            permutation_rules::frontier::beacon::round_time(
                sp.base.drand_genesis,
                sp.base.drand_period,
                r
            ) + 600
        );
    }

    #[test]
    fn a_chosen_t_create_min_needs_the_lead() {
        let p = profile("devnet");
        let sb = season_bytes(&p).unwrap();
        let a = Addresses::new(Address::new_from_array([7; 32]), 1);
        let auth = Address::new_from_array([9; 32]);
        let mut o = Observed::fresh();
        o.now = Some(1_000);
        let opts = |t| PlanOpts {
            wide: false,
            t_create_min: Some(t),
            keep_holder: None,
        };
        let lead = frontier_abi::presets::MIN_ANNOUNCE_LEAD_SECS;
        assert!(plan_with(&o, &a, auth, &sb, opts(1_000 + lead))
            .unwrap_err()
            .contains("--t-create-min"));
        let pl = plan_with(&o, &a, auth, &sb, opts(1_000 + lead + 60)).unwrap();
        assert_eq!(pl.t_create_min, Some(1_000 + lead + 60));
        // Offline (no clock): taken as given.
        assert_eq!(
            plan_with(&Observed::fresh(), &a, auth, &sb, opts(5))
                .unwrap()
                .t_create_min,
            Some(5)
        );
    }

    #[cfg(feature = "playable-lane")]
    #[test]
    fn the_wide_step_follows_the_seeded_season() {
        use fclient::abi::status as st;
        let p = wide_profile();
        let sb = season_bytes(&p).unwrap();
        let a = Addresses::new(Address::new_from_array([7; 32]), 1);
        let auth = Address::new_from_array([9; 32]);
        let wide = PlanOpts {
            wide: true,
            t_create_min: None,
            keep_holder: None,
        };
        let mut o = Observed::fresh();
        o.now = Some(500);
        let pl = plan_with(&o, &a, auth, &sb, wide).unwrap();
        assert_eq!(pl.todo.len(), 10);
        let last = pl.todo.last().unwrap();
        assert_eq!(last.step.name, "WideSetRules");
        assert!(last.after_seeded);
        assert_eq!(last.step.ixs[0].data[0], 0xDB);
        assert_eq!(last.step.ixs[0].accounts[2].pubkey, wide::rules_config(&a));
        // Created and set up: WideSetRules alone, still after Seeded.
        o.season = Some(view(st::CREATED, &sb, auth));
        o.logs = vec![true; 16];
        o.shards = vec![vec![true; 8]; 6];
        let pl = plan_with(&o, &a, auth, &sb, wide).unwrap();
        assert_eq!(pl.todo.len(), 1);
        assert!(pl.todo[0].after_seeded);
        // Seeded / Running: now.
        for s in [st::SEEDED, st::RUNNING] {
            o.season = Some(view(s, &sb, auth));
            let pl = plan_with(&o, &a, auth, &sb, wide).unwrap();
            assert_eq!(pl.todo.len(), 1);
            assert!(!pl.todo[0].after_seeded);
            assert_eq!(pl.todo[0].not_before, None);
        }
        // Done (ours, or another rule set: write-once).
        o.rules = Some(wide::ours());
        let pl = plan_with(&o, &a, auth, &sb, wide).unwrap();
        assert!(pl.todo.is_empty());
        assert_eq!(pl.done.last().unwrap(), "WideSetRules");
        o.rules = Some([2, 3, 1, 1]);
        let pl = plan_with(&o, &a, auth, &sb, wide).unwrap();
        assert!(pl.todo.is_empty());
        assert!(pl.done.last().unwrap().contains("other rule bytes"));
        // A profile's keep holder: its byte in the instruction, the default's
        // record counts as other rule bytes (write-once), and the text names it.
        let k3 = PlanOpts {
            keep_holder: Some(3),
            ..wide
        };
        o.rules = None;
        let pl = plan_with(&o, &a, auth, &sb, k3).unwrap();
        let d = &pl.todo.last().unwrap().step.ixs[0].data;
        assert_eq!(d[0], 0xDB);
        assert_eq!(&d[3..7], &[3, 3, 1, 1]);
        assert_eq!(
            &wide::set_rules_step(&a, auth).ixs[0].data[3..7],
            &wide::ours()
        );
        o.rules = Some(wide::ours());
        assert!(plan_with(&o, &a, auth, &sb, k3)
            .unwrap()
            .done
            .last()
            .unwrap()
            .contains("other rule bytes"));
        o.rules = Some(wide::ours_for(Some(3)));
        assert_eq!(
            plan_with(&o, &a, auth, &sb, k3)
                .unwrap()
                .done
                .last()
                .unwrap(),
            "WideSetRules"
        );
        assert_eq!(wide::rules_text(None), wide::RULES_TEXT);
        assert!(wide::rules_text(Some(4))
            .starts_with("keep_holder NeutralTerritoryV1(4), free_city DeployedLe32V1(3)"));
        // The S1 plan never has the wide step.
        let s1 = season_bytes(&profile("devnet")).unwrap();
        o.rules = None;
        o.season = Some(view(st::SEEDED, &s1, auth));
        assert!(plan(&o, &a, auth, &s1).unwrap().todo.is_empty());
        // The bit the keeper's lane table keys on is the ABI's.
        assert_eq!(
            fclient::budgets::LANE_VERSION_BIT,
            frontier_abi::world_index::wide_ix::WIDE_EXPERIMENTAL_VERSION_BIT
        );
        assert_ne!(PLAYABLE_VERSION & fclient::budgets::LANE_VERSION_BIT, 0);
        // The rules record reader.
        let mut d = vec![0u8; frontier_abi::world_index::rules::rules_config::SIZE];
        assert_eq!(wide::rules_of(&d), None);
        d[..8].copy_from_slice(&frontier_abi::world_index::rules::rules_config::MAGIC);
        d[18..22].copy_from_slice(&wide::ours());
        assert_eq!(wide::rules_of(&d), Some(wide::ours()));
    }

    /// A 64-bit little-endian ELF header whose section headers end at `len`.
    fn fake_elf(len: usize, body: &[u8]) -> Vec<u8> {
        let mut e = vec![0u8; len];
        e[..4].copy_from_slice(b"\x7fELF");
        e[4] = 2;
        e[5] = 1;
        let (n, size) = (2u16, 64u16);
        let shoff = (len - (n * size) as usize) as u64;
        e[0x28..0x30].copy_from_slice(&shoff.to_le_bytes());
        e[0x3A..0x3C].copy_from_slice(&size.to_le_bytes());
        e[0x3C..0x3E].copy_from_slice(&n.to_le_bytes());
        e[100..100 + body.len()].copy_from_slice(body);
        e
    }

    #[test]
    fn the_deployed_program_is_hashed_and_its_markers_read() {
        let elf = fake_elf(4_096, b"PSF_DEVNET_PLAYABLE_BUILD");
        assert_eq!(elf_len(&elf), Some(4_096));
        assert_eq!(elf_len(&elf[..4_000]), None);
        assert_eq!(elf_len(b"not an elf"), None);
        // ProgramData: header, the ELF, zero padding to max_len.
        let mut pd = vec![3u8; PROGRAMDATA_HEADER];
        pd.extend_from_slice(&elf);
        pd.extend(std::iter::repeat_n(0u8, 5_000));
        let mut p = profile("devnet");
        p.required_markers = vec!["PSF_DEVNET_PLAYABLE_BUILD".into()];
        p.refused_markers = vec!["PSF_TEST_BEACON_BUILD".into()];
        let info = program_info(&pd, &p);
        let want = hex::encode(<sha2::Sha256 as sha2::Digest>::digest(&elf));
        assert_eq!(info.sha256.as_deref(), Some(want.as_str()));
        assert_eq!(info.elf_len, 4_096);
        // solana-verify's hash strips the trailing zeros (here the fake ELF's own and the padding).
        let end = elf.iter().rposition(|b| *b != 0).unwrap() + 1;
        let v = hex::encode(<sha2::Sha256 as sha2::Digest>::digest(&elf[..end]));
        assert_eq!(info.verify_hash.as_deref(), Some(v.as_str()));
        assert_eq!(info.found_markers, ["PSF_DEVNET_PLAYABLE_BUILD"]);
        assert!(info.marker_problems.is_empty());
        let bad = program_info(
            &[
                &pd[..PROGRAMDATA_HEADER],
                &fake_elf(4_096, b"PSF_TEST_BEACON_BUILD")[..],
            ]
            .concat(),
            &p,
        );
        assert_eq!(bad.marker_problems.len(), 2, "{:?}", bad.marker_problems);
        assert!(!program_info(&[0u8; 10], &p).marker_problems.is_empty());
    }

    #[test]
    fn the_send_gate() {
        let o = |yes: bool, approval: bool, sha: Option<&str>| Opts {
            profile: "p".into(),
            yes_send: yes,
            approval,
            approved_sha256: sha.map(str::to_string),
            ..Opts::default()
        };
        let h = "ab".repeat(32);
        // Loopback: --yes-send alone.
        assert!(gate_flags(&o(true, false, None), Endpoint::Loopback).is_empty());
        assert_eq!(
            gate_flags(&o(false, false, None), Endpoint::Loopback).len(),
            1
        );
        // Public: the approval and the hash too.
        assert_eq!(gate_flags(&o(true, false, None), Endpoint::Public).len(), 2);
        assert_eq!(gate_flags(&o(true, true, None), Endpoint::Public).len(), 1);
        assert!(gate_flags(&o(true, true, Some(&h)), Endpoint::Public).is_empty());
        let info = ProgramInfo {
            sha256: Some(h.clone()),
            verify_hash: None,
            elf_len: 1,
            found_markers: vec![],
            marker_problems: vec!["required marker X is not in the deployed program".into()],
        };
        // The hash must be the deployed program's; markers count on a public cluster.
        assert_eq!(
            gate_program(&o(true, true, Some(&h)), Endpoint::Public, &info).len(),
            1
        );
        let other = "cd".repeat(32);
        assert_eq!(
            gate_program(&o(true, true, Some(&other)), Endpoint::Public, &info).len(),
            2
        );
        assert!(gate_program(&o(true, false, None), Endpoint::Loopback, &info).is_empty());
        // Arguments.
        let s = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<_>>();
        let a = parse_args(&s(&[
            "--profile",
            "p",
            "--rpc",
            "http://127.0.0.1:1",
            "--preset",
            "S1_DEVNET_WIDE_7D",
            "--authority",
            "k",
            "--yes-send",
            APPROVAL_FLAG,
            "--approved-sha256",
            &h.to_uppercase(),
            "--t-create-min",
            "123",
            "--record",
            "r.jsonl",
        ]))
        .unwrap();
        assert_eq!(a.cluster_url.as_deref(), Some("http://127.0.0.1:1"));
        assert_eq!(a.approved_sha256.as_deref(), Some(h.as_str()));
        assert_eq!((a.approval, a.t_create_min), (true, Some(123)));
        assert!(parse_args(&s(&["--profile", "p", "--rpc", "a", "--cluster-url", "b"])).is_err());
        assert!(parse_args(&s(&["--profile", "p", APPROVAL_FLAG])).is_err());
        assert!(parse_args(&s(&[
            "--profile",
            "p",
            "--yes-send",
            "--authority",
            "k",
            "--approved-sha256",
            "xyz"
        ]))
        .is_err());
    }

    #[test]
    fn rent_and_numbers() {
        assert_eq!(Rent::Rate(5_080).of(256), 384 * 5_080);
        assert_eq!(grouped(1_234_567), "1,234,567");
        assert_eq!(grouped(12), "12");
        assert_eq!(sol(1_500_000_001), "1.500000001");
    }
}
