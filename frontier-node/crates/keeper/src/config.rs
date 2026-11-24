//! `keeper.toml` (M1 contract §8.2).
//!
//! ```toml
//! program = "<base58>"
//! season = 1
//! rpc = ["http://127.0.0.1:41010"]
//! drand = ["http://127.0.0.1:41020"]
//! roles = ["beacon", "archive", "rings"]
//! regions = "0-15"
//! reveal_pool = 150
//! delay_pool = 32
//! funders = 4
//! r99_reveals = 4000
//! p_def_milli = 2000
//! p_delay_milli = 500
//! beneficiary = "<base58>"
//! api = "127.0.0.1:41050"
//! token_file = "keeper.token"
//! master_seed_file = "keeper.seed"
//! journal = "keeper.journal.sqlite"
//! beneficiary_key_file = "beneficiary.key"   # W4-C: ClaimDefence signer (= beneficiary)
//! backup_delay_slots = 0                      # W6T-2: a backup keeper's settle delay
//! ```
//!
//! The parser reads the flat subset of TOML the file uses (`key = value`
//! with strings, integers, floats, booleans and one-line arrays; `#`
//! comments); no dependency is added for it. Unknown keys are refused, so
//! a typo never silently falls back to a default.

use std::collections::BTreeMap;
use std::net::SocketAddr;
use std::path::PathBuf;

use solana_address::Address;

/// The default ExtendFrontier cap of the keeper: `permutation_prize::MAX_RING`
/// (17), restated here: the keeper does not link the prize program.
pub const EXTEND_MAX_RING_DEFAULT: u16 = 17;

/// The largest `rim_per_wedge`: a wedge's arc on ring 129 has 129
/// provinces.
pub const RIM_PER_WEDGE_MAX: u16 = 129;

/// The largest `provinces_reach` (devnet-open-province): ⑭ R3's
/// `SPAWN_REACH_MAX` and `outpost_range`'s upper bound are both 8.
pub const PROVINCES_REACH_MAX: u16 = 8;

/// Duties (§8.2 `roles`). W2-F runs `beacon` (genesis seed, anchors, seed
/// caches, beacon logs) and `archive`; W3-C runs `rings` (every ring, its
/// seed and provinces), `fold`, `tickets`, `explore`, `dormancy` (releases
/// and stranded hosts) and `sweep`, and the `/v1/reveal` accept path; W4-C
/// runs `reveal`, `settle-departure` (with the §21 returns), `gather`,
/// `resolve`, `skip`, `settle`, `close` and `claims`.
pub const ROLES: [&str; 16] = [
    "beacon",
    "reveal",
    "settle-departure",
    "gather",
    "resolve",
    "skip",
    "settle",
    "tickets",
    "explore",
    "archive",
    "close",
    "fold",
    "rings",
    "dormancy",
    "claims",
    "sweep",
];

/// Roles of the playable lane (devnet runbook gap P7), accepted besides
/// [`ROLES`] only by a keeper built with the `playable-lane` feature and
/// never part of an "every role" keeper (they are listed apart so the
/// stack's and the tests' all-roles keepers stay what they were):
/// `wide-tickets` settles the wide claims (WideSettleTicket 0xDC) and
/// finalizes the wide villages (WideFinalize 0xDF), [`crate::widetickets`].
/// `expeditions` (P13) sends the rim → wide expedition's steps after the
/// player's Depart ([`crate::expeditions`]); it needs `gather` and `resolve`
/// (the origin's departure bell) and `beacon` (anchors and seeds).
/// `wide-resolve` (P9) keeps every known wide province resolved bell by bell
/// (the quiet wide Resolve 0xDC op 1), so a wide village stays resident for
/// WideMuster / WideGarrison ([`crate::wideresolve`]); it needs `beacon`.
/// `territory` (devnet-territory-dev) is player territory's class-D crank in
/// a territory world (keep holder `NeutralTerritoryV1`): the upkeep settles,
/// the decay of unpaid land and the conquest transfer after a keep capture
/// ([`crate::territory`]); it reads the feed index (Citizens, claimed
/// provinces) and needs nothing else.
pub const WIDE_ROLES: [&str; 4] = ["wide-tickets", "expeditions", "wide-resolve", "territory"];

/// The most wide rings the `rings` duty opens (`wide_rings`): rings
/// 129..=136. The devnet profile asks for 3 (129–131, the local wide world).
pub const WIDE_RINGS_MAX: u16 = 8;

/// The most wide provinces per wedge and ring (`wide_per_wedge`): a wedge's
/// arc on ring 129 has 129 provinces.
pub const WIDE_PER_WEDGE_MAX: u16 = 129;

/// Whether this build carries the playable lane's wide duties.
pub const PLAYABLE_LANE: bool = cfg!(feature = "playable-lane");

#[derive(Clone, Debug, PartialEq)]
pub enum Value {
    Str(String),
    Int(i64),
    Float(f64),
    Bool(bool),
    Arr(Vec<Value>),
}

/// Parses the flat TOML subset.
pub fn parse_toml(text: &str) -> Result<BTreeMap<String, Value>, String> {
    let mut out = BTreeMap::new();
    for (n, raw) in text.lines().enumerate() {
        let line = strip_comment(raw).trim().to_string();
        if line.is_empty() {
            continue;
        }
        let (k, v) = line
            .split_once('=')
            .ok_or(format!("line {}: expected `key = value`", n + 1))?;
        let k = k.trim();
        if k.is_empty() || !k.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
            return Err(format!("line {}: bad key `{k}`", n + 1));
        }
        let v = parse_value(v.trim()).map_err(|e| format!("line {}: {e}", n + 1))?;
        if out.insert(k.to_string(), v).is_some() {
            return Err(format!("line {}: `{k}` given twice", n + 1));
        }
    }
    Ok(out)
}

fn strip_comment(s: &str) -> &str {
    let mut in_str = false;
    for (i, c) in s.char_indices() {
        match c {
            '"' => in_str = !in_str,
            '#' if !in_str => return &s[..i],
            _ => {}
        }
    }
    s
}

fn parse_value(v: &str) -> Result<Value, String> {
    if let Some(inner) = v.strip_prefix('[') {
        let inner = inner.strip_suffix(']').ok_or("unclosed array")?;
        let mut items = vec![];
        let mut cur = String::new();
        let mut in_str = false;
        for c in inner.chars() {
            match c {
                '"' => {
                    in_str = !in_str;
                    cur.push(c);
                }
                ',' if !in_str => {
                    if !cur.trim().is_empty() {
                        items.push(parse_value(cur.trim())?);
                    }
                    cur.clear();
                }
                _ => cur.push(c),
            }
        }
        if !cur.trim().is_empty() {
            items.push(parse_value(cur.trim())?);
        }
        return Ok(Value::Arr(items));
    }
    if let Some(s) = v.strip_prefix('"') {
        let s = s.strip_suffix('"').ok_or("unclosed string")?;
        if s.contains('"') || s.contains('\\') {
            return Err("escapes are not supported".into());
        }
        return Ok(Value::Str(s.into()));
    }
    match v {
        "true" => return Ok(Value::Bool(true)),
        "false" => return Ok(Value::Bool(false)),
        _ => {}
    }
    let clean = v.replace('_', "");
    if let Ok(i) = clean.parse::<i64>() {
        return Ok(Value::Int(i));
    }
    if let Ok(f) = clean.parse::<f64>() {
        return Ok(Value::Float(f));
    }
    Err(format!("cannot parse `{v}`"))
}

/// Parses `"0-15"`, `"0,3,7-9"`.
pub fn parse_regions(s: &str) -> Result<Vec<u8>, String> {
    let mut out = vec![];
    for part in s.split(',').map(str::trim).filter(|p| !p.is_empty()) {
        let (a, b) = match part.split_once('-') {
            Some((a, b)) => (a.trim(), b.trim()),
            None => (part, part),
        };
        let a: u8 = a.parse().map_err(|_| format!("region `{a}`"))?;
        let b: u8 = b.parse().map_err(|_| format!("region `{b}`"))?;
        if a > b || b >= fclient::abi::REGIONS {
            return Err(format!("regions `{part}` outside 0-15"));
        }
        out.extend(a..=b);
    }
    out.sort_unstable();
    out.dedup();
    if out.is_empty() {
        return Err("no region".into());
    }
    Ok(out)
}

/// The keeper's configuration.
#[derive(Clone, Debug, PartialEq)]
pub struct KeeperConfig {
    pub program: Address,
    pub season_id: u64,
    pub rpc: Vec<String>,
    pub drand: Vec<String>,
    pub roles: Vec<String>,
    pub regions: Vec<u8>,
    pub reveal_pool: usize,
    pub delay_pool: usize,
    pub funders: usize,
    pub r99_reveals: u64,
    pub p_def_milli: u64,
    pub p_delay_milli: u64,
    /// N-class bid and the start of D-class escalation (0.1).
    pub p_low_milli: u64,
    /// `--peace-start <fraction>`: W writes start at `fraction × p_tip`
    /// (O-M1-09 / I-23: off by default, p_start = p_tip).
    pub peace_start: Option<f64>,
    /// Reveal-pool floor override (lamports); default `F_r` from R99 (§8.2).
    pub reveal_floor: Option<u64>,
    /// Delay-pool floor (lamports); default 0.5 SOL (§8.2).
    pub delay_floor: u64,
    pub daily_budget_lamports: u64,
    /// Most lamports the versions of one write may cost (§8.2 duplicates bound).
    pub per_write_cap_lamports: u64,
    pub beneficiary: Address,
    pub api: Option<SocketAddr>,
    pub token_file: Option<PathBuf>,
    pub master_seed_file: Option<PathBuf>,
    pub journal: Option<PathBuf>,
    pub budgets_file: Option<PathBuf>,
    /// Peacetime lag of per-region anchor fallbacks behind the combined
    /// anchor (0 = always together; contested regions use 0).
    pub fallback_lag_slots: u64,
    /// Not landed after this many slots at a bid ≥ p_tip → contested.
    pub contested_slots: u64,
    /// A seed cache not landed after this many slots switches nonce.
    pub nonce_switch_slots: u64,
    /// Bells scanned back for missing anchors at start.
    pub rescan_bells: u32,
    /// Payer care every this many slots (at rest), at the latest.
    pub care_every_slots: u64,
    /// Payer care every this many game seconds (at rest), at the latest
    /// (W6-C, W5-B F1: a cadence in slots alone ran every 10 bells at 100×
    /// and the reveal pool starved). A pool below its minimum effective N
    /// is cared for at once (§8.2 "tops up at once").
    pub care_every_game_secs: u64,
    /// D and N writes: slots between versions while one is in flight and
    /// the bid rises / at the class cap (`engine::EngineParams`).
    pub d_resend_slots: u64,
    pub cap_resend_slots: u64,
    /// W writes (Reveals): at most this many versions that can still land
    /// at once (`engine::EngineParams::max_unknown_w_versions`; ⑱, owner
    /// decision 2026-11-05). `0` keeps the every-slot ladder.
    pub max_unknown_w_versions: u32,
    /// fix-keeper-backoff: a write the program refused deterministically
    /// waits `2 << (n − 1)` slots and `2^(n − 1)` passes after its `n`-th
    /// refusal in a row with one code, at most these (`engine::EngineParams`).
    pub refusal_max_slots: u64,
    pub refusal_max_passes: u64,
    /// Distinct keys of one duty kind refused with one code (nothing of
    /// that kind landed since) before the kind sends one probe at a time.
    /// `0` turns the group breaker off.
    pub refusal_group_min: u32,
    /// Land (W3-C): Holdings the feed named are re-read every this many
    /// slots (dormancy, sweeps).
    pub land_scan_slots: u64,
    /// Land (W3-C): backstop scan of every opened Province for stranded
    /// hosts every this many slots (a release triggers one at once).
    pub stranded_scan_slots: u64,
    /// Pools below their contract minimum are allowed (tests, local drills).
    pub dev: bool,
    /// W4-C: the beneficiary's key file (32-byte secret seed or 64-byte
    /// keypair, like `master_seed_file`); ClaimDefence needs the
    /// beneficiary's signature (§5.12). Without it the `claims` role is idle.
    pub beneficiary_key_file: Option<PathBuf>,
    /// The claim signer's address (set from `beneficiary_key_file`, or by
    /// [`crate::Keeper::set_claim_key`]).
    pub claim_key: Option<Address>,
    /// W4-C: a random 0..=n-slot start jitter on play writes (offchain
    /// design §6.5, several keepers racing); 0 (off) for the operator's
    /// keeper, whose latency the exit criteria measure.
    pub race_jitter_slots: u64,
    /// W6T-2 (w6-s7 triage): a backup keeper's delay. SettleDeparture and
    /// SettleTransit wait this many slots after they first become eligible,
    /// then re-read the transit before they are planned, so a backup pays
    /// only for what the primary left undone. 0 (the default) for the
    /// operator's keeper.
    pub backup_delay_slots: u32,
    /// Map growth (`docs/frontier/map-growth/keeper-load-rules.ja.md` §2,
    /// stage 3): a resting S1 Province is not written every turn but
    /// fast-forwarded (FastForward) when something wakes it and at the
    /// season's end. Off (every Province every turn, as before) by default.
    pub rest: bool,
    /// Map growth, a local candidate (off by default): the `rings` duty
    /// also sends ExtendFrontier when the season has an `r_max_ceiling`
    /// and the program would accept it, after the same waits as a
    /// crowding ring ([`crate::rings::extend_due`]). Never past
    /// [`KeeperConfig::extend_max_ring`].
    pub extend: bool,
    /// The outermost ring this keeper extends to (default 17: the prize
    /// program's `MAX_RING`, its tally covers rings 0–17; the keeper cannot
    /// see whether the season has a prize pool, so it keeps the cap unless
    /// told otherwise). At most 128 (`R_MAX_HARD`).
    pub extend_max_ring: u16,
    /// Lazy provinces (devnet-preset-wide, the `S1_DEVNET_WIDE_7D` season;
    /// off by default): past the genesis rings the `rings` duty opens and
    /// seeds rings but opens none of their provinces, and a seeded ring
    /// counts as complete at once (no fold wait: an unopened province adds
    /// no site to fold). The genesis rings are still opened whole. Provinces
    /// past them open on demand: [`KeeperConfig::provinces_reach`] next to
    /// the settled land, [`KeeperConfig::rim_per_wedge`] on the rim,
    /// [`KeeperConfig::wide_rings`] past it (OpenProvince is also
    /// permissionless; before devnet-open-province nothing opened the
    /// provinces between the genesis rings and the rim). Opening
    /// every province to ring 128 would cost 49,537 province rents
    /// (1,224 SOL at 5,080 lamports/byte).
    pub lazy_provinces: bool,
    /// Rim provinces per wedge (owner Q-W1, 2026-11-20: a first village may
    /// also be founded on the rim of a wide season; default 0 = off): once
    /// the legacy rim (ring 128) is opened and seeded, the `rings` duty
    /// opens the ring-128 provinces that border the middle `rim_per_wedge`
    /// ring-129 provinces of each wedge ([`crate::rings::rim_plan`], the
    /// local wide world's rim), so a player can file a rim FileTicket and
    /// a later wide claim is within `outpost_range`. Rent comes from the
    /// wedge funds (24,709,120 lamports a province at 5,080 lamports/byte).
    /// At most [`RIM_PER_WEDGE_MAX`].
    pub rim_per_wedge: u16,
    /// Provinces on demand (devnet-open-province, D-devnet-rim-homes-2;
    /// default 0 = off): with `lazy_provinces` nothing opened the
    /// provinces of rings 4..=127, yet a second or third village
    /// (FileOutpost: ring > `heartland_max_ring`, within `outpost_range` of
    /// the home, its Province present) and a ⑭ R3 home past the heartland
    /// (PlaceHome within `spawn_reach` of a settled witness) need one. With
    /// `provinces_reach = n` the `rings` duty opens every absent province
    /// of a seeded legacy ring past the genesis rings that lies within `n`
    /// provinces of a SETTLED province (`n_sites_used > 0`), nearest first
    /// ([`crate::rings::demand_plan`]). Bounded by `provinces_per_pass`,
    /// `provinces_max` and a per-wedge fund floor that keeps what the
    /// rings duty still needs ([`crate::rings::demand_fund_floor`]); it
    /// sends nothing while the feed guard holds automatic writes. Rent
    /// from the wedge funds (24,709,120 lamports a province at 5,080
    /// lamports/byte; the floor and rents are priced at the cluster's
    /// Rent sysvar, [`crate::rent`]), fees from the keeper's payer. At most
    /// [`PROVINCES_REACH_MAX`].
    pub provinces_reach: u16,
    /// `provinces_reach`: the most OpenProvince writes one scan plans
    /// (default 12, at least 1).
    pub provinces_per_pass: u16,
    /// `provinces_reach`: the most provinces this keeper opens on demand
    /// in its run (default 600).
    pub provinces_max: u32,
    /// `provinces_reach`: slots between two scans of the settled provinces
    /// (default 75, about 30 s; at least 1).
    pub provinces_scan_slots: u64,
    /// Wide rings the `rings` duty opens (devnet runbook gap P6; default 0
    /// = off; needs the `playable-lane` build): once the legacy rim (ring
    /// 128) is seeded, rings `129..129 + wide_rings` one at a time, each a
    /// bell after the previous one opened (the program's rule):
    /// WideRequestRingSeed (the record's rent from the keeper's payer),
    /// WideConsumeRingSeed on the bound quicknet round, then
    /// WideOpenProvince for the `wide_per_wedge` provinces in the middle of
    /// each wedge's arc ([`crate::rings::wide_plan`], the local wide
    /// world's plan; rent from the wedge funds). At most [`WIDE_RINGS_MAX`].
    pub wide_rings: u16,
    /// Wide provinces per wedge and ring (with `wide_rings`; 1..=
    /// [`WIDE_PER_WEDGE_MAX`]). The same `n` as `rim_per_wedge` puts every
    /// rim village within `outpost_range` of a ring-129 province.
    pub wide_per_wedge: u16,
    /// `wide-tickets`: slots between two scans of the known Citizens' wide
    /// ticket records (default 25, about 10 s; at least 1).
    pub wide_scan_slots: u64,
    /// `territory`: every this many bells a plain upkeep settle of every
    /// territory with tiles (default 1: every bell, as the local runner; at
    /// least 1). Decay and conquest are planned every bell regardless.
    pub territory_settle_bells: u64,
    /// `territory`: writes planned per bell at most (default 24, the local
    /// runner's `SENDS_PER_BELL`; at least 1). More steps than that: the
    /// start rotates each bell so nobody is starved.
    pub territory_per_bell: u64,
    /// Where the transaction feed comes from (devnet-readiness B2):
    /// `"localnet"` (default: `frontier_feed` of `frontier-localnet`) or
    /// `"rpc"` (a public cluster: `findex::RpcPoll` over
    /// `getSignaturesForAddress` + `getTransaction`, `crate::clusterfeed`).
    pub feed: FeedSource,
    /// `feed = "rpc"`: least time between two polls of the cluster
    /// (default 2,000 ms, at least 200).
    pub feed_poll_ms: u64,
    /// `feed = "rpc"`: the longest wait after failed polls (doubling from
    /// `feed_poll_ms`; default 60,000 ms).
    pub feed_max_backoff_ms: u64,
    /// `feed = "rpc"`: the program's first signature, so the first poll
    /// must reach it (findex G1); optional.
    pub feed_origin: Option<String>,
    /// `feed = "rpc"`: a second RPC endpoint the poller cross-checks
    /// (findex G3); optional.
    pub feed_witness: Option<String>,
    /// Least time between two JSON-RPC calls of this keeper to its `rpc`
    /// (every client shares one pacer; an HTTP 429/503 backs all off).
    /// Default 0 (unpaced) with `feed = "localnet"`, 150 ms with `"rpc"`
    /// (≈ 66 calls per 10 s, under the public devnet RPC's per-IP limit).
    pub rpc_min_gap_ms: Option<u64>,
    /// Least time between two JSON-RPC calls the loopback API makes for
    /// externally-triggered work (the `/v1/reveal` gate), on a budget of
    /// its own in front of the shared pacer (fix-gw-highs, audit H-1).
    /// Default: five `rpc_min_gap_ms` (a fifth of the pacer), 33 ms when
    /// unpaced; 0 = unlimited (tests only).
    pub api_rpc_gap_ms: Option<u64>,
}

/// `keeper.toml` `feed`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FeedSource {
    Localnet,
    Rpc,
}

impl KeeperConfig {
    /// Defaults for everything but the program, season and beneficiary.
    pub fn new(program: Address, season_id: u64, beneficiary: Address) -> KeeperConfig {
        KeeperConfig {
            program,
            season_id,
            rpc: vec![],
            drand: vec![],
            roles: vec!["beacon".into(), "rings".into(), "archive".into()],
            regions: (0..fclient::abi::REGIONS).collect(),
            reveal_pool: fclient::payers::MIN_REVEAL,
            delay_pool: fclient::payers::MIN_DELAY,
            funders: fclient::payers::MIN_FUNDERS,
            r99_reveals: fclient::payers::R99_DEFAULT,
            p_def_milli: crate::P_DEF_MILLI,
            p_delay_milli: crate::P_DELAY_MILLI,
            p_low_milli: crate::P_LOW_MILLI,
            peace_start: None,
            reveal_floor: None,
            delay_floor: fclient::payers::DELAY_FLOOR_DEFAULT,
            daily_budget_lamports: 50_000_000_000,
            per_write_cap_lamports: 20_000_000,
            beneficiary,
            api: None,
            token_file: None,
            master_seed_file: None,
            journal: None,
            budgets_file: None,
            fallback_lag_slots: 1,
            contested_slots: 2,
            nonce_switch_slots: 2,
            rescan_bells: 288,
            care_every_slots: 150,
            care_every_game_secs: 300,
            d_resend_slots: 2,
            cap_resend_slots: 16,
            max_unknown_w_versions: 2,
            refusal_max_slots: crate::engine::REFUSAL_MAX_SLOTS,
            refusal_max_passes: crate::engine::REFUSAL_MAX_PASSES,
            refusal_group_min: crate::engine::REFUSAL_GROUP_MIN,
            land_scan_slots: 8,
            stranded_scan_slots: 450,
            dev: false,
            beneficiary_key_file: None,
            claim_key: None,
            race_jitter_slots: 0,
            backup_delay_slots: 0,
            rest: false,
            extend: false,
            extend_max_ring: EXTEND_MAX_RING_DEFAULT,
            lazy_provinces: false,
            rim_per_wedge: 0,
            provinces_reach: 0,
            provinces_per_pass: 12,
            provinces_max: 600,
            provinces_scan_slots: 75,
            wide_rings: 0,
            wide_per_wedge: 0,
            wide_scan_slots: 25,
            territory_settle_bells: 1,
            territory_per_bell: 24,
            feed: FeedSource::Localnet,
            feed_poll_ms: 2_000,
            feed_max_backoff_ms: 60_000,
            feed_origin: None,
            feed_witness: None,
            rpc_min_gap_ms: None,
            api_rpc_gap_ms: None,
        }
    }

    /// The pacing gap of this keeper's RPC calls ([`Self::rpc_min_gap_ms`]).
    pub fn rpc_min_gap(&self) -> std::time::Duration {
        std::time::Duration::from_millis(self.rpc_min_gap_ms.unwrap_or(match self.feed {
            FeedSource::Localnet => 0,
            FeedSource::Rpc => 150,
        }))
    }

    /// The `rpc`/`feed` combination is one the keeper can run: every
    /// `rpc` (and `feed_witness`) URL is a plain `http://` one to ANY host
    /// (not only loopback; security audit L-4) or a checked `https://` one
    /// (`fclient::https::check_post_url`); `feed =
    /// "localnet"` never names an `https://` RPC (no `frontier-localnet`
    /// serves TLS: a public cluster needs `feed = "rpc"`); the `feed = "rpc"`
    /// pacing is sane; `feed_origin`/`feed_witness` only with `"rpc"`.
    pub fn check_feed(&self) -> Result<(), String> {
        let url_ok = |u: &str, k: &str| -> Result<(), String> {
            if u.starts_with("https://") {
                fclient::https::check_post_url(u)
                    .map_err(|e| format!("`{k}` URL {}: {e}", fclient::https::redact(u)))
            } else if u.starts_with("http://") {
                // Plain http stays as before (the local node, any host).
                fclient::http::split_url(u)
                    .map(|_| ())
                    .map_err(|e| format!("`{k}` URL: {e}"))
            } else {
                Err(format!(
                    "`{k}` URL {}: not http(s)",
                    fclient::https::redact(u)
                ))
            }
        };
        for u in &self.rpc {
            url_ok(u, "rpc")?;
        }
        match self.feed {
            FeedSource::Localnet => {
                if self.rpc.iter().any(|u| u.starts_with("https://")) {
                    return Err("`rpc` is https:// but `feed` is \"localnet\": a public cluster has no `frontier_feed`; set feed = \"rpc\"".into());
                }
                if self.feed_origin.is_some() || self.feed_witness.is_some() {
                    return Err("`feed_origin` / `feed_witness` need feed = \"rpc\"".into());
                }
            }
            FeedSource::Rpc => {
                if self.feed_poll_ms < 200 {
                    return Err("`feed_poll_ms` must be at least 200".into());
                }
                if self.feed_max_backoff_ms < self.feed_poll_ms {
                    return Err("`feed_max_backoff_ms` must be at least `feed_poll_ms`".into());
                }
                if let Some(w) = &self.feed_witness {
                    url_ok(w, "feed_witness")?;
                }
            }
        }
        Ok(())
    }

    pub fn has_role(&self, r: &str) -> bool {
        self.roles.iter().any(|x| x == r)
    }

    /// The playable lane's duties (P6 `wide_rings`, P7 `wide-tickets`):
    /// only in a `playable-lane` build, `wide_rings` with the `rings` role
    /// and a plan (`wide_per_wedge` ≥ 1).
    pub fn check_wide(&self) -> Result<(), String> {
        let wants = self.wide_rings > 0 || WIDE_ROLES.iter().any(|r| self.has_role(r));
        if wants && !PLAYABLE_LANE {
            return Err(
                "`wide_rings` / roles `wide-tickets`, `expeditions`, `wide-resolve`, `territory` need a keeper built with `--features playable-lane`"
                    .into(),
            );
        }
        if self.wide_rings > 0 && !self.has_role("rings") {
            return Err("`wide_rings` is part of the `rings` duty: add the role".into());
        }
        if self.wide_rings > 0 && self.wide_per_wedge == 0 {
            return Err("`wide_rings` needs `wide_per_wedge` ≥ 1".into());
        }
        if self.has_role("expeditions") {
            for r in ["beacon", "gather", "resolve"] {
                if !self.has_role(r) {
                    return Err(format!(
                        "role `expeditions` needs role `{r}` (the origin's departure bell, anchors and seeds)"
                    ));
                }
            }
        }
        if self.has_role("wide-resolve") && !self.has_role("beacon") {
            return Err(
                "role `wide-resolve` needs role `beacon` (the anchors and seeds of every bell)"
                    .into(),
            );
        }
        Ok(())
    }

    /// Reads `keeper.toml` text.
    pub fn from_toml(text: &str) -> Result<KeeperConfig, String> {
        let mut m = parse_toml(text)?;
        let mut take = |k: &str| m.remove(k);
        let s = |v: Value, k: &str| match v {
            Value::Str(s) => Ok(s),
            _ => Err(format!("`{k}` must be a string")),
        };
        let int = |v: Value, k: &str| match v {
            Value::Int(i) if i >= 0 => Ok(i as u64),
            _ => Err(format!("`{k}` must be a non-negative integer")),
        };
        let strs = |v: Value, k: &str| match v {
            Value::Arr(a) => a
                .into_iter()
                .map(|x| match x {
                    Value::Str(s) => Ok(s),
                    _ => Err(format!("`{k}` must be an array of strings")),
                })
                .collect::<Result<Vec<_>, _>>(),
            _ => Err(format!("`{k}` must be an array")),
        };
        let addr = |x: String, k: &str| {
            x.parse::<Address>()
                .map_err(|_| format!("`{k}` is not a base58 address"))
        };
        let program = addr(
            s(take("program").ok_or("`program` is required")?, "program")?,
            "program",
        )?;
        let season = int(take("season").ok_or("`season` is required")?, "season")?;
        let beneficiary = addr(
            s(
                take("beneficiary").ok_or("`beneficiary` is required")?,
                "beneficiary",
            )?,
            "beneficiary",
        )?;
        let mut c = KeeperConfig::new(program, season, beneficiary);
        if let Some(v) = take("rpc") {
            c.rpc = strs(v, "rpc")?;
        }
        if let Some(v) = take("drand") {
            c.drand = strs(v, "drand")?;
            // https anywhere (verified TLS through curl), plain http only to
            // loopback (drand-replay); nothing curl could misread.
            for u in &c.drand {
                fclient::http::check_curl_url(u.trim_end_matches('/'))
                    .map_err(|e| format!("`drand` URL {u}: {e}"))?;
            }
        }
        if let Some(v) = take("roles") {
            c.roles = strs(v, "roles")?;
            if let Some(bad) = c
                .roles
                .iter()
                .find(|r| !ROLES.contains(&r.as_str()) && !WIDE_ROLES.contains(&r.as_str()))
            {
                return Err(format!("unknown role `{bad}`"));
            }
        }
        if let Some(v) = take("regions") {
            c.regions = parse_regions(&s(v, "regions")?)?;
        }
        macro_rules! num {
            ($k:literal, $f:ident, $t:ty) => {
                if let Some(v) = take($k) {
                    c.$f = int(v, $k)? as $t;
                }
            };
        }
        num!("reveal_pool", reveal_pool, usize);
        num!("delay_pool", delay_pool, usize);
        num!("funders", funders, usize);
        num!("r99_reveals", r99_reveals, u64);
        num!("p_def_milli", p_def_milli, u64);
        num!("p_delay_milli", p_delay_milli, u64);
        num!("p_low_milli", p_low_milli, u64);
        num!("delay_floor", delay_floor, u64);
        num!("daily_budget_lamports", daily_budget_lamports, u64);
        num!("per_write_cap_lamports", per_write_cap_lamports, u64);
        num!("fallback_lag_slots", fallback_lag_slots, u64);
        num!("contested_slots", contested_slots, u64);
        num!("nonce_switch_slots", nonce_switch_slots, u64);
        num!("rescan_bells", rescan_bells, u32);
        num!("care_every_slots", care_every_slots, u64);
        num!("care_every_game_secs", care_every_game_secs, u64);
        num!("d_resend_slots", d_resend_slots, u64);
        num!("cap_resend_slots", cap_resend_slots, u64);
        num!("max_unknown_w_versions", max_unknown_w_versions, u32);
        num!("refusal_max_slots", refusal_max_slots, u64);
        num!("refusal_max_passes", refusal_max_passes, u64);
        num!("refusal_group_min", refusal_group_min, u32);
        num!("land_scan_slots", land_scan_slots, u64);
        num!("stranded_scan_slots", stranded_scan_slots, u64);
        num!("race_jitter_slots", race_jitter_slots, u64);
        num!("backup_delay_slots", backup_delay_slots, u32);
        if let Some(v) = take("reveal_floor") {
            c.reveal_floor = Some(int(v, "reveal_floor")?);
        }
        if let Some(v) = take("daily_budget_sol") {
            c.daily_budget_lamports = match v {
                Value::Int(i) if i >= 0 => i as u64 * 1_000_000_000,
                Value::Float(f) if f >= 0.0 => (f * 1e9) as u64,
                _ => return Err("`daily_budget_sol` must be a number".into()),
            };
        }
        if let Some(v) = take("peace_start") {
            c.peace_start = Some(match v {
                Value::Float(f) if (0.0..=1.0).contains(&f) => f,
                Value::Int(i) if (0..=1).contains(&i) => i as f64,
                _ => return Err("`peace_start` must be a fraction in [0, 1]".into()),
            });
        }
        if let Some(v) = take("dev") {
            c.dev = matches!(v, Value::Bool(true));
        }
        if let Some(v) = take("rest") {
            c.rest = matches!(v, Value::Bool(true));
        }
        if let Some(v) = take("extend") {
            c.extend = matches!(v, Value::Bool(true));
        }
        if let Some(v) = take("lazy_provinces") {
            c.lazy_provinces = matches!(v, Value::Bool(true));
        }
        if let Some(v) = take("rim_per_wedge") {
            let n = int(v, "rim_per_wedge")?;
            if n > u64::from(RIM_PER_WEDGE_MAX) {
                return Err(format!(
                    "`rim_per_wedge` must be at most {RIM_PER_WEDGE_MAX}"
                ));
            }
            c.rim_per_wedge = n as u16;
        }
        if let Some(v) = take("provinces_reach") {
            let n = int(v, "provinces_reach")?;
            if n > u64::from(PROVINCES_REACH_MAX) {
                return Err(format!(
                    "`provinces_reach` must be at most {PROVINCES_REACH_MAX}"
                ));
            }
            c.provinces_reach = n as u16;
        }
        if let Some(v) = take("provinces_per_pass") {
            c.provinces_per_pass = int(v, "provinces_per_pass")?.clamp(1, 1_000) as u16;
        }
        if let Some(v) = take("provinces_max") {
            c.provinces_max = int(v, "provinces_max")?.min(u64::from(u32::MAX)) as u32;
        }
        if let Some(v) = take("provinces_scan_slots") {
            c.provinces_scan_slots = int(v, "provinces_scan_slots")?.max(1);
        }
        if let Some(v) = take("wide_rings") {
            let n = int(v, "wide_rings")?;
            if n > u64::from(WIDE_RINGS_MAX) {
                return Err(format!("`wide_rings` must be at most {WIDE_RINGS_MAX}"));
            }
            c.wide_rings = n as u16;
        }
        if let Some(v) = take("wide_per_wedge") {
            let n = int(v, "wide_per_wedge")?;
            if n > u64::from(WIDE_PER_WEDGE_MAX) {
                return Err(format!(
                    "`wide_per_wedge` must be at most {WIDE_PER_WEDGE_MAX}"
                ));
            }
            c.wide_per_wedge = n as u16;
        }
        if let Some(v) = take("wide_scan_slots") {
            c.wide_scan_slots = int(v, "wide_scan_slots")?.max(1);
        }
        if let Some(v) = take("territory_settle_bells") {
            c.territory_settle_bells = int(v, "territory_settle_bells")?.max(1);
        }
        if let Some(v) = take("territory_per_bell") {
            c.territory_per_bell = int(v, "territory_per_bell")?.max(1);
        }
        if let Some(v) = take("extend_max_ring") {
            let r = int(v, "extend_max_ring")?;
            if r > u64::from(permutation_rules::frontier::geometry::R_MAX_HARD) {
                return Err("`extend_max_ring` must be at most 128".into());
            }
            c.extend_max_ring = r as u16;
        }
        if let Some(v) = take("api") {
            let a: SocketAddr = s(v, "api")?
                .parse()
                .map_err(|_| "`api` must be host:port".to_string())?;
            if !a.ip().is_loopback() {
                return Err("`api` must bind a loopback address (§8.2)".into());
            }
            c.api = Some(a);
        }
        for (k, f) in [
            ("token_file", &mut c.token_file),
            ("master_seed_file", &mut c.master_seed_file),
            ("journal", &mut c.journal),
            ("budgets_file", &mut c.budgets_file),
            ("beneficiary_key_file", &mut c.beneficiary_key_file),
        ] {
            if let Some(v) = take(k) {
                *f = Some(PathBuf::from(s(v, k)?));
            }
        }
        if let Some(v) = take("feed") {
            c.feed = match s(v, "feed")?.as_str() {
                "localnet" => FeedSource::Localnet,
                "rpc" => FeedSource::Rpc,
                x => return Err(format!("`feed` {x:?}: \"localnet\" or \"rpc\"")),
            };
        }
        num!("feed_poll_ms", feed_poll_ms, u64);
        num!("feed_max_backoff_ms", feed_max_backoff_ms, u64);
        if let Some(v) = take("rpc_min_gap_ms") {
            c.rpc_min_gap_ms = Some(int(v, "rpc_min_gap_ms")?);
        }
        if let Some(v) = take("api_rpc_gap_ms") {
            c.api_rpc_gap_ms = Some(int(v, "api_rpc_gap_ms")?);
        }
        if let Some(v) = take("feed_origin") {
            let o = s(v, "feed_origin")?;
            o.parse::<fclient::ports::Signature>()
                .map_err(|_| "`feed_origin` must be a base58 signature".to_string())?;
            c.feed_origin = Some(o);
        }
        if let Some(v) = take("feed_witness") {
            c.feed_witness = Some(s(v, "feed_witness")?);
        }
        c.check_feed()?;
        c.check_wide()?;
        if c.provinces_reach > 0 && !c.has_role("rings") {
            return Err("`provinces_reach` is part of the `rings` duty: add the role".into());
        }
        if c.p_def_milli > crate::P_DEF_MILLI || c.p_delay_milli > c.p_def_milli {
            return Err("p_def_milli ≤ 2000 and p_delay_milli ≤ p_def_milli".into());
        }
        if let Some(k) = m.keys().next() {
            return Err(format!("unknown key `{k}`"));
        }
        Ok(c)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_documented_file() {
        let p = Address::new_from_array([5; 32]);
        let b = Address::new_from_array([6; 32]);
        let text = format!(
            r#"
            # keeper A (operator roles)
            program = "{p}"
            season = 7
            rpc = ["http://127.0.0.1:41010", "http://127.0.0.1:41510"]
            drand = ["http://127.0.0.1:41020"]
            roles = ["beacon", "archive", "rings"]
            regions = "0-3, 9"
            reveal_pool = 150
            delay_pool = 32
            funders = 4
            r99_reveals = 4_000
            p_def_milli = 2000
            p_delay_milli = 500
            daily_budget_sol = 2.5
            peace_start = 0.25
            beneficiary = "{b}"
            api = "127.0.0.1:41050"
            token_file = "k.token"  # loopback bearer token
            backup_delay_slots = 8
            "#
        );
        let c = KeeperConfig::from_toml(&text).unwrap();
        assert_eq!(c.season_id, 7);
        assert_eq!(c.rpc.len(), 2);
        assert_eq!(c.regions, vec![0, 1, 2, 3, 9]);
        assert_eq!(c.daily_budget_lamports, 2_500_000_000);
        assert_eq!(c.peace_start, Some(0.25));
        assert_eq!(c.api.unwrap().port(), 41_050);
        assert_eq!(c.backup_delay_slots, 8);
        assert_eq!(
            KeeperConfig::new(p, 1, b).backup_delay_slots,
            0,
            "no delay by default"
        );
        assert!(c.has_role("archive") && !c.has_role("reveal"));
        assert!(KeeperConfig::from_toml(&text.replace("regions", "regoins")).is_err());
        assert!(
            KeeperConfig::from_toml(&text.replace("127.0.0.1:41050", "0.0.0.0:41050")).is_err()
        );
        assert!(KeeperConfig::from_toml(&text.replace("\"rings\"]", "\"ringz\"]")).is_err());
        assert!(parse_regions("15-16").is_err());
        // map growth: resting Provinces only when asked
        assert!(!c.rest && !KeeperConfig::new(p, 1, b).rest);
        let rest = KeeperConfig::from_toml(&format!("{text}\nrest = true\n")).unwrap();
        assert!(rest.rest);
        // map growth: ExtendFrontier only when asked, capped at ring 17
        assert!(!c.extend && !KeeperConfig::new(p, 1, b).extend);
        assert_eq!(c.extend_max_ring, 17);
        let ext =
            KeeperConfig::from_toml(&format!("{text}\nextend = true\nextend_max_ring = 24\n"))
                .unwrap();
        assert!(ext.extend && ext.extend_max_ring == 24);
        assert!(KeeperConfig::from_toml(&format!("{text}\nextend_max_ring = 129\n")).is_err());
        // devnet-preset-wide: lazy provinces only when asked
        assert!(!c.lazy_provinces && !KeeperConfig::new(p, 1, b).lazy_provinces);
        let lazy = KeeperConfig::from_toml(&format!(
            "{text}\nextend = true\nextend_max_ring = 128\nlazy_provinces = true\n"
        ))
        .unwrap();
        assert!(lazy.lazy_provinces && lazy.extend && lazy.extend_max_ring == 128);
        // Q-W1: the rim's provinces only when asked
        assert_eq!(c.rim_per_wedge, 0);
        assert_eq!(KeeperConfig::new(p, 1, b).rim_per_wedge, 0);
        let rim = KeeperConfig::from_toml(&format!(
            "{text}\nlazy_provinces = true\nrim_per_wedge = 6\n"
        ))
        .unwrap();
        assert_eq!(rim.rim_per_wedge, 6);
        // devnet-open-province: provinces on demand only when asked
        assert_eq!(c.provinces_reach, 0);
        assert_eq!(KeeperConfig::new(p, 1, b).provinces_reach, 0);
        let dem = KeeperConfig::from_toml(&format!(
            "{text}\nlazy_provinces = true\nprovinces_reach = 3\nprovinces_per_pass = 0\nprovinces_max = 90\nprovinces_scan_slots = 0\n"
        ))
        .unwrap();
        assert_eq!(
            (
                dem.provinces_reach,
                dem.provinces_per_pass,
                dem.provinces_max,
                dem.provinces_scan_slots
            ),
            (3, 1, 90, 1)
        );
        assert!(KeeperConfig::from_toml(&format!("{text}\nprovinces_reach = 9\n")).is_err());
        assert!(KeeperConfig::from_toml(
            &format!("{text}\nprovinces_reach = 3\n").replace(", \"rings\"]", "]")
        )
        .is_err());
        assert!(KeeperConfig::from_toml(&format!("{text}\nrim_per_wedge = 130\n")).is_err());
        assert!(KeeperConfig::from_toml(&format!("{text}\nrim_per_wedge = -1\n")).is_err());
        // P6 / P7: the playable lane's duties only when asked, and only in a `playable-lane` build
        assert_eq!(
            (c.wide_rings, c.wide_per_wedge, c.wide_scan_slots),
            (0, 0, 25)
        );
        assert!(!c.has_role("wide-tickets"));
        let wide = format!(
            "{}\nwide_rings = 3\nwide_per_wedge = 6\nwide_scan_slots = 10\n",
            text.replace("\"rings\"]", "\"rings\", \"wide-tickets\"]")
        );
        match (KeeperConfig::from_toml(&wide), PLAYABLE_LANE) {
            (Ok(w), true) => {
                assert_eq!(
                    (w.wide_rings, w.wide_per_wedge, w.wide_scan_slots),
                    (3, 6, 10)
                );
                assert!(w.has_role("wide-tickets"));
            }
            (Err(e), false) => assert!(e.contains("playable-lane"), "{e}"),
            (r, lane) => panic!("playable-lane build {lane}: {:?}", r.err()),
        }
        if PLAYABLE_LANE {
            for bad in [
                "\nwide_rings = 9\nwide_per_wedge = 6\n",
                "\nwide_rings = 3\n",
                "\nwide_rings = 1\nwide_per_wedge = 130\n",
            ] {
                assert!(
                    KeeperConfig::from_toml(&format!("{text}{bad}")).is_err(),
                    "{bad}"
                );
            }
            let no_rings = format!(
                "{}\nwide_rings = 1\nwide_per_wedge = 1\n",
                text.replace(", \"rings\"]", "]")
            );
            assert!(KeeperConfig::from_toml(&no_rings).is_err());
        }
        // (the wide roles are never part of an all-roles keeper)
        assert!(!ROLES.contains(&WIDE_ROLES[0]));
        assert!(!ROLES.contains(&WIDE_ROLES[1]));
        assert!(!ROLES.contains(&WIDE_ROLES[2]));
        // P9: `wide-resolve` only in a `playable-lane` build, and with `beacon`
        let wr = text.replace(
            "[\"beacon\", \"archive\", \"rings\"]",
            "[\"beacon\", \"archive\", \"rings\", \"wide-resolve\"]",
        );
        match (KeeperConfig::from_toml(&wr), PLAYABLE_LANE) {
            (Ok(c), true) => assert!(c.has_role("wide-resolve")),
            (Err(e), false) => assert!(e.contains("playable-lane"), "{e}"),
            (r, lane) => panic!("playable-lane build {lane}: {:?}", r.err()),
        }
        if PLAYABLE_LANE {
            let e = KeeperConfig::from_toml(&text.replace(
                "[\"beacon\", \"archive\", \"rings\"]",
                "[\"archive\", \"rings\", \"wide-resolve\"]",
            ))
            .unwrap_err();
            assert!(e.contains("beacon"), "{e}");
        }
        // P13: `expeditions` only in a `playable-lane` build, and with `beacon`, `gather` and `resolve`
        let exp = |roles: &str| text.replace("[\"beacon\", \"archive\", \"rings\"]", roles);
        let full =
            exp("[\"beacon\", \"archive\", \"rings\", \"gather\", \"resolve\", \"expeditions\"]");
        match (KeeperConfig::from_toml(&full), PLAYABLE_LANE) {
            (Ok(c), true) => assert!(c.has_role("expeditions")),
            (Err(e), false) => assert!(e.contains("playable-lane"), "{e}"),
            (r, lane) => panic!("playable-lane build {lane}: {:?}", r.err()),
        }
        if PLAYABLE_LANE {
            for missing in ["gather", "resolve", "beacon"] {
                let roles = [
                    "beacon",
                    "archive",
                    "rings",
                    "gather",
                    "resolve",
                    "expeditions",
                ]
                .iter()
                .filter(|r| **r != missing)
                .map(|r| format!("\"{r}\""))
                .collect::<Vec<_>>()
                .join(", ");
                let e = KeeperConfig::from_toml(&exp(&format!("[{roles}]"))).unwrap_err();
                assert!(e.contains(missing), "{missing}: {e}");
            }
        }
    }

    #[test]
    fn max_unknown_w_versions_defaults_to_2_and_parses() {
        let p = Address::new_from_array([5; 32]);
        let b = Address::new_from_array([6; 32]);
        let base = format!("program = \"{p}\"\nseason = 1\nbeneficiary = \"{b}\"\n");
        assert_eq!(
            KeeperConfig::from_toml(&base)
                .unwrap()
                .max_unknown_w_versions,
            2
        );
        for n in [0u32, 1, 5] {
            let c =
                KeeperConfig::from_toml(&format!("{base}max_unknown_w_versions = {n}\n")).unwrap();
            assert_eq!(c.max_unknown_w_versions, n);
        }
    }

    #[test]
    fn refusal_backoff_defaults_and_parses() {
        let p = Address::new_from_array([5; 32]);
        let b = Address::new_from_array([6; 32]);
        let base = format!("program = \"{p}\"\nseason = 1\nbeneficiary = \"{b}\"\n");
        let c = KeeperConfig::from_toml(&base).unwrap();
        assert_eq!(
            (
                c.refusal_max_slots,
                c.refusal_max_passes,
                c.refusal_group_min
            ),
            (9_000, 64, 4)
        );
        let c = KeeperConfig::from_toml(&format!(
            "{base}refusal_max_slots = 1024\nrefusal_max_passes = 0\nrefusal_group_min = 0\n"
        ))
        .unwrap();
        assert_eq!(
            (
                c.refusal_max_slots,
                c.refusal_max_passes,
                c.refusal_group_min
            ),
            (1_024, 0, 0)
        );
    }

    #[test]
    fn drand_urls_are_https_or_loopback() {
        let p = Address::new_from_array([5; 32]);
        let b = Address::new_from_array([6; 32]);
        let with = |d: &str| {
            KeeperConfig::from_toml(&format!(
                "program = \"{p}\"\nseason = 1\nbeneficiary = \"{b}\"\ndrand = [{d}]\n"
            ))
        };
        let ok = with("\"https://api.drand.sh\", \"https://drand.cloudflare.com/\", \"http://127.0.0.1:41020\"").unwrap();
        assert_eq!(ok.drand.len(), 3);
        for bad in [
            "\"http://api.drand.sh\"",              // plain http off loopback
            "\"https://127.0.0.1:1@api.drand.sh\"", // userinfo
            "\"https://api.drand.sh/?x\"",
            "\"ftp://api.drand.sh\"",
            "\"--insecure\"",
        ] {
            assert!(with(bad).is_err(), "{bad}");
        }
    }
}
