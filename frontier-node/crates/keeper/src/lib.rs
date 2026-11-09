//! `keeper-core` (M1 contract §8.2; offchain design §6).
//!
//! | module | what |
//! |---|---|
//! | [`config`] | `keeper.toml` |
//! | [`pools`] | reveal (≥ 150) and delay (≥ 32) payer pools, ≥ 4 funders, uniform draws, payer care |
//! | [`engine`] | the escalation engine: W/D/N bids ×2 per slot, a new payer per version, the CU and heap retry ladder, contested detection |
//! | [`journal`] | SQLite journal (WAL, `synchronous=FULL`), the process lock |
//! | [`rounds`] | verified drand rounds with their hints |
//! | [`beacon`] | anchors (combined + fallbacks), seed caches with the nonce switch, beacon logs |
//! | [`genesis`] | the genesis seed |
//! | [`archive`] | ArchiveAnchors 48 h after the anchor, CloseSeedCache |
//! | [`rings`] | every ring (genesis and crowding), ConsumeRingSeed, OpenProvince (W3-C) |
//! | [`fold`] | FoldOccupancy, three parts per bell while joins are open (W3-C) |
//! | [`tickets`] | SettleTicket in descending score per site, displacement, expiry (W3-C) |
//! | [`explore`] | SettleExplore (W3-C) |
//! | [`holdings`] | ReleaseDormant, DisbandStranded, SweepPoolOwed (W3-C) |
//! | [`landindex`] | the land objects the feed's PS2 records name (W3-C) |
//! | [`seeds`] | where a `(bell, region)` seed is read and its value (W3-C) |
//! | [`reveal_accept`] | the `/v1/reveal` accept path against chain (W3-C) |
//! | [`playindex`] | transits, reveals, gathers, clashes and closes the feed names (W4-C) |
//! | [`play`] | decrypt, the reveal pipeline, SettleDeparture and returns, the gather/resolve/skip scheduler, SettleTransit, closes, claims (W4-C) |
//! | [`conquest`] | MC (CQ2-D): contested bells, fold-driven skips, SettleCapture, SettleSiege, FoldMarch, the horn watcher, the season-end flush, CloseMarch |
//! | [`api`] | the loopback API (`/v1/*`, `/metrics`) |
//! | `wideindex` (feature `wide-world-experimental`) | **read-only** discovery of the wide world from explicitly supplied, authenticated PSW1 bodies: provinces, full holding and host references, transit slots, reveals, settlements, closes; read-account plans only, no duty, no write |
//! | `wideclaim` (feature `wide-world-experimental`) | **read-only, unsigned** WideClaimDefence planning from selected full slot identities and pinned account reads; shared caps, rent shortfall and payment predictions, with a sealed-snapshot entry point; no admission, signing or send |
//! | `wideclaim_preview` (feature `wide-world-experimental`) | bounded, one-shot keyless claim-preview input and JSON facts over one coherent snapshot; separate opt-in executable, no keeper startup, transaction output or send |
//! | `wideproof` (feature `wide-world-experimental`) | **read-only**: the Depart commitment and 264-byte seal of a committed WideDepart, taken from a feed record's wire and bound to the `Departed` record inside the same instruction's log frame; unavailable on any CPI, rollback or mismatch; no signature verified, no key |
//! | `wideduty` (feature `wide-world-experimental`) | **read-only, unsigned**: WideSettleDeparture, WideReturn, WideGather and WideResolve instructions planned from current account reads with the dispatcher's tables and refusals (the gather's arrival evidence is the wide ArrivalDay account, never the absence of feed events; the resolve replays the ABI's `resolve_bell` on scratch bytes; WideSettleTransit is not planned); explicit block reasons; never signed, simulated, sent or queued |
//! | `widereveal` (feature `wide-world-experimental`) | **read-only, unsigned**: a WideReveal candidate planned from a `wideproof::DepartProof`, a caller-supplied seal opening and current account reads; the handler's timing, latch, path, shield, quota and ArrivalDay rules replayed; a matching commitment is never called a cryptographic verification |
//! | `widesettle` (feature `wide-world-experimental`) | **read-only, unsigned**: the WideSettleTransit candidate of a march whose seal opens under the anchor's own public round signature and whose host is in the resolved final set with a fate that does not come home; the outcome and payments from the shared `frontier_abi::world_index::settle` functions the program calls; bad seals, absent destinations, bounces, routs, returns home and camp loot refused, not planned; no tick wiring yet |
//! | `widereview` (feature `wide-world-experimental`) | **read-only** admission review of a wide candidate against the engine's public state: a typed full-identity key, kind, tag, class and concrete denials; never a `WriteSpec`, never `ensure`/`poll`/`send` |
//! | `widesnapshot` (feature `wide-world-experimental`) | the additive same-response account snapshot (`SnapshotPort`, default `Unsupported`; the JSON-RPC port implements it): all keys + Clock (+ Rent) in one `getMultipleAccounts` response with its context slot; coherence, never currency or permission |
//! | `widefees` (feature `wide-world-experimental`) | what executing a wide candidate requires of its fee payer, calculated only from a same-response Rent sysvar and payer account (ABI sizes), every assumption named, unmet or unknown declared |
//! | `widetick` (feature `wide-world-experimental`) | the bounded per-tick **read-only** review of the observer's candidates for `/v1/status` (`Keeper::enable_wide_review`): plans and reviews, enqueues nothing; over one snapshot response through the keeper's own port when `Keeper::enable_wide_snapshot_via_port` was called; reveal hints only from proofs extracted from the observer-accepted feed prefix, a verified public beacon and the public opening, when the runtime has them |
//! | `widefollow` (feature `wide-world-experimental`) | **read-only, opt-in** (`Keeper::enable_wide_follow`): after the legacy feed gate blocks, bounded pulls from the follower's own cursor shown to the same observer and proof store; never a legacy cursor, gate, signature or completeness claim |
//! | `widereconcile` (feature `wide-world-experimental`) | **read-only** diagnostics: the observer's PSW1 chain head of a province or holding against the account's own `EVENT_SEQ`/`EVENT_HEAD` in one coherent snapshot — agree / lag / behind / mismatch / stale / missing / closed / closed-but-present / identity / scope / unknown; cross-input consistency only (the records' and the snapshot's source relationship unverified), never authenticity, completeness or permission |
//!
//! [`Keeper::tick`] runs once per slot: it reads the Clock, plans every
//! duty from chain reads (the chain is the state), then lets the engine
//! poll, settle and send. Every rule time is the Clock's `unix_timestamp`,
//! never the wall clock, so the same code runs at 1× on a validator and at
//! 20× (or in virtual time) on `localnet`.
//!
//! W3-C added land (rings past genesis, folds, tickets, explore, dormancy,
//! stranded hosts, sweeps, the `/v1/reveal` accept path); W4-C adds the
//! reveal pipeline, gathers, resolves, skips, settlements, closes and claims.

pub mod api;
pub mod archive;
pub mod beacon;
pub mod caravans;
pub mod config;
pub mod conquest;
pub mod engine;
pub mod explore;
pub mod feedguard;
pub mod fold;
pub mod genesis;
pub mod holdings;
pub mod journal;
pub mod landindex;
pub mod nations;
pub mod play;
pub mod playindex;
pub mod pools;
pub mod reveal_accept;
pub mod rings;
pub mod rounds;
pub mod seeds;
#[cfg(test)]
pub(crate) mod testkit;
pub mod tickets;
#[cfg(feature = "wide-world-experimental")]
pub mod wideclaim;
#[cfg(feature = "wide-world-experimental")]
pub mod wideclaim_preview;
#[cfg(feature = "wide-world-experimental")]
pub mod wideduty;
#[cfg(feature = "wide-world-experimental")]
pub mod widefees;
#[cfg(feature = "wide-world-experimental")]
pub mod widefollow;
#[cfg(feature = "wide-world-experimental")]
pub mod wideindex;
#[cfg(feature = "wide-world-experimental")]
pub mod wideproof;
#[cfg(feature = "wide-world-experimental")]
pub mod widereconcile;
#[cfg(feature = "wide-world-experimental")]
pub mod widereveal;
#[cfg(feature = "wide-world-experimental")]
pub mod widereview;
#[cfg(feature = "wide-world-experimental")]
pub mod widesettle;
#[cfg(feature = "wide-world-experimental")]
pub mod widesnapshot;
#[cfg(feature = "wide-world-experimental")]
pub mod widetick;

use std::collections::{BTreeMap, BTreeSet};
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};
use solana_address::Address;

use fclient::abi::{self, status, tag, Class};
use fclient::addr::Addresses;
use fclient::budgets::Budgets;
use fclient::clock::SeasonClock;
use fclient::decode::Season;
use fclient::fees;
use fclient::ports::{ChainPort, DrandPort, Signature, Status};

use crate::archive::ArchiveDuty;
use crate::beacon::BeaconDuty;
use crate::config::KeeperConfig;
use crate::engine::{BuildCtx, Engine, EngineParams, Outcome, WriteSpec, PAYER_CARE_KIND};
use crate::explore::ExploreDuty;
use crate::fold::FoldDuty;
use crate::genesis::GenesisDuty;
use crate::holdings::HoldingDuty;
use crate::journal::{Attempt, Journal};
use crate::landindex::LandIndex;
use crate::play::PlayDuty;
use crate::pools::Payers;
use crate::rings::RingDuty;
use crate::rounds::Rounds;
use crate::seeds::SeedFinder;
use crate::tickets::TicketDuty;

/// Land roles that need the feed index.
const LAND_ROLES: [&str; 5] = ["tickets", "explore", "dormancy", "sweep", "fold"];
/// Play roles (W4-C). **MC (W2R2-D3):** the conquest duty (settles, folds,
/// the season-end flush) runs inside the play duty, on the Provinces and
/// MarchStates the play reads. A role set with `fold` (a land role) but none
/// of these folds M1's land only: it never folds a MarchState. The default
/// all-roles keeper is unaffected; a split deployment keeps `fold` with at
/// least `settle` (CQ4-B's runbook).
pub const PLAY_ROLES: [&str; 8] = [
    "reveal",
    "settle-departure",
    "gather",
    "resolve",
    "skip",
    "settle",
    "close",
    "claims",
];

/// The role a land write key belongs to (for "the program lacks it").
fn role_of_key(key: &str) -> Option<&'static str> {
    match key.split(':').next()? {
        "fold" => Some("fold"),
        "ticket" => Some("tickets"),
        "explore" => Some("explore"),
        "release" | "stranded" => Some("dormancy"),
        "sweep" => Some("sweep"),
        "reveal" => Some("reveal"),
        "sdep" | "return" => Some("settle-departure"),
        "gather" => Some("gather"),
        "resolve" => Some("resolve"),
        "skip" | "ff" => Some("skip"),
        "settle" => Some("settle"),
        "close" => Some("close"),
        "claim" => Some("claims"),
        _ => None,
    }
}

/// The beacon duty's latency-critical write kinds: sent as soon as they
/// are planned, and on the idle ticks of a slot (W6T-2).
const BEACON_KINDS: [&str; 3] = ["anchor", "anchor-multi", "seed"];

/// P_def = 2.0, P_delay = 0.5 (milli-units, §8.2).
pub const P_DEF_MILLI: u64 = 2_000;
pub const P_DELAY_MILLI: u64 = 500;
/// The fixed low bid of class N writes and the start of D escalation.
pub const P_LOW_MILLI: u64 = 100;

/// The W1 skeleton's bid schedule, kept for its callers: the priority of
/// the version sent `slots` slots after the first (see [`EngineParams::bid`]).
pub fn bid_milli(class: Class, p_start: u64, slots: u32, season_cap_milli: u64) -> u64 {
    EngineParams {
        p_start_milli: p_start,
        d_start_milli: p_start,
        p_def_milli: P_DEF_MILLI.min(season_cap_milli),
        ..EngineParams::default()
    }
    .bid(class, slots as u64)
}

/// The canonical budgets table (`frontier-abi/vectors/budgets.json`, §10.2):
/// per-kind CU limit and `L(kind)`, regenerated by the gates from the
/// measured program; a `budgets_file` in `keeper.toml` overrides it.
pub const CANONICAL_BUDGETS: &str = include_str!("../../../../frontier-abi/vectors/budgets.json");

/// What every duty sees of one tick.
pub struct Tick<'a> {
    pub slot: u64,
    /// The Clock's `unix_timestamp` (game time).
    pub now: i64,
    pub season: &'a Season,
    pub clock: SeasonClock,
    pub addrs: &'a Addresses,
    pub cfg: &'a KeeperConfig,
}

/// State the loopback API reads and writes (updated every tick).
///
/// W6T-2: a tick never takes `status`, `metrics`, `tracks` or
/// `reveal_keys` out of it; the play duty takes only the queued `reveals`
/// and `nudges` and merges its track updates back. Before, the whole
/// struct was taken for the play duty's plan, and `/v1/status` answered
/// `null` for as long as the plan ran (322 of 1,035 bells in w6-s7), a
/// track answered 404 and the same material could be queued twice.
#[derive(Default)]
pub struct Shared {
    /// The status snapshot of the last tick (published after its sends).
    pub status: Value,
    /// Discovery is incomplete or has an unsupported record; do not accept new work.
    pub feed_paused: bool,
    pub metrics: String,
    /// Owner reveal material queued by `/v1/reveal` (W3-C accepts, W4-C sends).
    pub reveals: Vec<(String, Value)>,
    /// `holding:slot:commit` → track id (the same material answers the same track).
    pub reveal_keys: BTreeMap<String, String>,
    pub tracks: BTreeMap<String, Value>,
    pub nudges: Vec<Value>,
    pub next_track: u64,
    /// `/v1/reveal` read the journal's acknowledged tracks (⑱: ids go on
    /// after them, the same material answers its journalled track).
    pub owner_tracks_restored: bool,
    /// `"P,Q"` → what holds the province now (W4-C, `/v1/nudge`).
    pub blocking: BTreeMap<String, Vec<Value>>,
}

/// What one tick did.
#[derive(Debug, Default)]
pub struct TickReport {
    pub slot: u64,
    pub now: i64,
    pub idle: bool,
    pub sent: usize,
    pub outcomes: Vec<(String, Outcome)>,
    pub contested: Vec<(Option<u32>, Option<u8>, String)>,
    /// The chain's slot when the first version went out (`None`: nothing
    /// sent), and per phase `(name, wall ms, chain reads)` (W6T-2; logged
    /// with `FRONTIER_KEEPER_TICK_LOG=1`).
    pub chain_at_send: Option<u64>,
    pub phases: Vec<(&'static str, u64, u64)>,
}

impl TickReport {
    /// One line per tick: `TICK slot=… chain_at_send=… sent=… total=…ms
    /// <phase>=<ms>ms/<reads>r …`.
    pub fn line(&self, total_ms: u64) -> String {
        let mut l = format!(
            "TICK slot={} chain_at_send={} sent={} total={total_ms}ms",
            self.slot,
            self.chain_at_send.map_or(-1, |s| s as i64),
            self.sent
        );
        for (n, ms, r) in &self.phases {
            l.push_str(&format!(" {n}={ms}ms/{r}r"));
        }
        l
    }
}

/// `(p99, p50)`-style quantile of a sample (nearest rank).
pub fn quantile(v: &[u64], q: f64) -> Option<u64> {
    if v.is_empty() {
        return None;
    }
    let mut s = v.to_vec();
    s.sort_unstable();
    let i = ((q * s.len() as f64).ceil() as usize).clamp(1, s.len()) - 1;
    Some(s[i])
}

pub struct Keeper<P: ChainPort, D: DrandPort> {
    pub cfg: KeeperConfig,
    pub port: P,
    pub drand: D,
    pub addrs: Addresses,
    pub payers: Payers,
    pub engine: Engine,
    pub journal: Option<Journal>,
    pub rounds: Rounds,
    pub season: Option<Season>,
    pub beacon: BeaconDuty,
    pub genesis: GenesisDuty,
    pub archive: ArchiveDuty,
    pub rings: RingDuty,
    pub fold: FoldDuty,
    pub tickets: TicketDuty,
    pub explore: ExploreDuty,
    pub holdings: HoldingDuty,
    pub index: LandIndex,
    pub seeds: SeedFinder,
    /// Play (W4-C).
    pub play: PlayDuty,
    /// Land roles the program answered NotImplemented (99) for: off.
    pub unsupported_roles: BTreeSet<&'static str>,
    pub shared: Arc<Mutex<Shared>>,
    pub last_slot: Option<u64>,
    /// `(slot, kind, detail)`.
    pub alerts: Vec<(u64, String, String)>,
    /// Per bell: `(bell, effective N reveal, effective N delay)` (E5 criterion 4).
    pub effective_n: Vec<(u32, usize, usize)>,
    /// Fees sent per game day (the daily budget).
    pub spend_by_day: BTreeMap<u32, u64>,
    season_read_slot: Option<u64>,
    wrong_key_alerted: bool,
    /// The last payer care: `(slot, Clock now, transfers planned)`.
    care_last: Option<(u64, i64, usize)>,
    /// Older keepers recorded care attempts as "expired" from slot age,
    /// without proving that the transfer never landed. Requires an operator
    /// reconciliation before care can safely resume.
    care_legacy_unknown: bool,
    /// The season's ABI the engine's budgets follow (R-22: an MC season
    /// takes `frontier-abi/vectors/v2/budgets.json` unless `budgets_file`
    /// overrides it).
    budgets_version: u16,
    /// The read-only wide observer (feature `wide-world-experimental`),
    /// enabled by [`Keeper::enable_wide_observation`]: shown the same feed
    /// pages the legacy discovery pulls, before the legacy guard ingests
    /// them. It never plans, sends, signs or unblocks anything.
    #[cfg(feature = "wide-world-experimental")]
    pub wide_observer: Option<wideindex::WideObserver>,
    /// The bounded read-only review of the observer's candidates
    /// (`widetick`), enabled by [`Keeper::enable_wide_review`]. It plans
    /// and reviews; it enqueues, signs and sends nothing.
    #[cfg(feature = "wide-world-experimental")]
    pub wide_review: Option<widetick::WideReview>,
    /// The review's own verified beacon cache (`widetick::BeaconCache`),
    /// separate from the beacon duty's `rounds` so a review ask never
    /// changes what the beacon duty asks or sends. Set with the review.
    #[cfg(feature = "wide-world-experimental")]
    pub wide_beacon: Option<widetick::BeaconCache>,
    /// How the wide review takes its same-response snapshot: off, through
    /// the keeper's own read port (`enable_wide_snapshot_via_port`, when
    /// `P: SnapshotPort`), or through a separately attached source whose
    /// relation to the read port is not verified (`enable_wide_snapshot`).
    #[cfg(feature = "wide-world-experimental")]
    pub wide_snapshot: widesnapshot::SnapshotMode<P>,
    /// The read-only observation follower (`widefollow`), enabled by
    /// [`Keeper::enable_wide_follow`]: pulls from its own cursor only in
    /// ticks the legacy discovery did not pull.
    #[cfg(feature = "wide-world-experimental")]
    pub wide_follow: Option<widefollow::WideFollow>,
    /// Whether `refresh_discovery` pulled feed pages this tick (the
    /// follower stands aside then).
    #[cfg(feature = "wide-world-experimental")]
    wide_legacy_pulled: bool,
}

/// Slots between two cares while a pool is below its minimum (the top-up
/// of the previous care has had a block to land).
pub const CARE_LOW_GAP_SLOTS: u64 = 2;

/// Whether payer care runs this tick (W6-C, W5-B F1). Care runs at rest,
/// never while care transfers are still pending (that would top the same
/// payer up twice): on the first tick; every `care_every_slots` slots or
/// `care_every_game_secs` game seconds, whichever comes first (a cadence in
/// slots alone ran every 10 bells at 100×); and, when a pool is below its
/// minimum effective N (`low`), `CARE_LOW_GAP_SLOTS` after a care that
/// planned transfers (§8.2: "tops up at once"; a care that found no
/// funder able to pay waits for the cadence).
pub fn care_due(
    cfg: &KeeperConfig,
    last: Option<(u64, i64, usize)>,
    slot: u64,
    now: i64,
    low: bool,
    care_pending: bool,
) -> bool {
    if care_pending {
        return false;
    }
    let Some((s0, n0, planned)) = last else {
        return true;
    };
    slot >= s0 + cfg.care_every_slots.max(1)
        || now >= n0 + cfg.care_every_game_secs.max(1) as i64
        || (low && planned > 0 && slot >= s0 + CARE_LOW_GAP_SLOTS)
}

/// Refuse a logically invalid journal before asking RPC to resolve it. A
/// filtered signature list would shift later responses onto the wrong rows.
fn recovery_signatures(attempts: &[Attempt]) -> Result<Vec<Signature>, String> {
    attempts
        .iter()
        .map(|a| {
            a.sig
                .parse()
                .map_err(|_| "invalid signature in keeper journal; refusing restart".into())
        })
        .collect()
}

/// A partial RPC reply must not drop an undecided attempt from adoption.
fn recovery_statuses(
    attempts: &[Attempt],
    statuses: Vec<Option<Status>>,
) -> Result<impl Iterator<Item = (&Attempt, Option<Status>)>, String> {
    if attempts.len() != statuses.len() {
        return Err("incomplete keeper signature statuses; refusing restart".into());
    }
    Ok(attempts.iter().zip(statuses))
}

impl<P: ChainPort, D: DrandPort> Keeper<P, D> {
    /// A keeper over `port` and `drand` with payers derived from `master`.
    pub fn new(
        cfg: KeeperConfig,
        port: P,
        drand: D,
        master: &[u8; 32],
        journal: Option<Journal>,
    ) -> Result<Keeper<P, D>, String> {
        let budgets = match &cfg.budgets_file {
            Some(p) => Budgets::from_json(
                &serde_json::from_slice(&std::fs::read(p).map_err(|e| e.to_string())?)
                    .map_err(|e| e.to_string())?,
            )?,
            None => Budgets::from_json(
                &serde_json::from_str(CANONICAL_BUDGETS).map_err(|e| e.to_string())?,
            )?,
        };
        // The reveal floor is priced at the Reveal this table requests
        // (integ-W6 review, W6-E F1).
        let payers = Payers::with_budgets(master, &cfg, &budgets).map_err(|e| format!("{e:?}"))?;
        let params = EngineParams {
            d_start_milli: cfg.p_low_milli,
            p_low_milli: cfg.p_low_milli,
            p_def_milli: cfg.p_def_milli,
            p_delay_milli: cfg.p_delay_milli,
            contested_slots: cfg.contested_slots,
            per_write_cap: cfg.per_write_cap_lamports,
            d_resend_slots: cfg.d_resend_slots,
            cap_resend_slots: cfg.cap_resend_slots,
            max_unknown_w_versions: cfg.max_unknown_w_versions,
            ..EngineParams::default()
        };
        let pk96 = drand.info().public_key;
        let mut engine = Engine::new(budgets, params);
        engine.restore_feed_block(journal.as_ref())?;
        // Payer care: plain System transfers (tag 0 is no Frontier instruction).
        engine.budgets.set(
            0,
            fclient::budgets::Budget {
                cu_limit: 2_000,
                loaded_limit: fees::PAGE,
            },
        );
        Ok(Keeper {
            addrs: Addresses::new(cfg.program, cfg.season_id),
            beacon: BeaconDuty::new(cfg.regions.clone()),
            engine,
            rounds: Rounds::new(pk96),
            payers,
            journal,
            season: None,
            genesis: GenesisDuty::default(),
            archive: ArchiveDuty::default(),
            rings: RingDuty::default(),
            fold: FoldDuty::default(),
            tickets: TicketDuty::default(),
            explore: ExploreDuty::default(),
            holdings: HoldingDuty::default(),
            index: LandIndex::default(),
            seeds: SeedFinder::default(),
            play: PlayDuty::default(),
            unsupported_roles: BTreeSet::new(),
            // Never `null` (W6T-2): the API answers from the process start.
            shared: Arc::new(Mutex::new(Shared {
                status: json!({"starting": true}),
                feed_paused: true,
                ..Shared::default()
            })),
            last_slot: None,
            alerts: vec![],
            effective_n: vec![],
            spend_by_day: BTreeMap::new(),
            season_read_slot: None,
            wrong_key_alerted: false,
            care_last: None,
            care_legacy_unknown: false,
            budgets_version: abi::PROGRAM_VERSION_V1,
            #[cfg(feature = "wide-world-experimental")]
            wide_observer: None,
            #[cfg(feature = "wide-world-experimental")]
            wide_review: None,
            #[cfg(feature = "wide-world-experimental")]
            wide_beacon: None,
            #[cfg(feature = "wide-world-experimental")]
            wide_snapshot: widesnapshot::SnapshotMode::Off,
            #[cfg(feature = "wide-world-experimental")]
            wide_follow: None,
            #[cfg(feature = "wide-world-experimental")]
            wide_legacy_pulled: false,
            cfg,
            port,
            drand,
        })
    }

    /// Enables the bounded read-only review of the wide observer's
    /// candidates under a pinned deployment (`widetick`). Requires the
    /// observer. Adds at most `widetick::CANDIDATES_PER_TICK` plans of
    /// account reads per tick and a `review` entry under `wide` in the
    /// status; no write gate, cursor or signer changes.
    #[cfg(feature = "wide-world-experimental")]
    pub fn enable_wide_review(&mut self, deployment: wideduty::Deployment) -> Result<(), String> {
        if self.wide_observer.is_none() {
            return Err(
                "wide review needs the wide observer (enable_wide_observation first)".into(),
            );
        }
        self.wide_review = Some(widetick::WideReview::new(deployment));
        // The review verifies the rounds it asks for under the drand port's
        // published key; the planner's gate re-checks that key's hash
        // against the Season's pin.
        self.wide_beacon = Some(widetick::BeaconCache::new(self.drand.info().public_key));
        Ok(())
    }

    /// Takes the wide review's same-response snapshot through the keeper's
    /// **own** read port — the preferred form: the same node and client
    /// the keeper already reads through, no second relation to trust.
    /// Callable only where the port's type is known to implement
    /// `SnapshotPort` (the JSON-RPC port does); the runtime keeps a
    /// function pointer and calls it where it only knows `P: ChainPort`.
    /// Requires the review. Read only; no gate, cursor or signer changes.
    #[cfg(feature = "wide-world-experimental")]
    pub fn enable_wide_snapshot_via_port(&mut self) -> Result<(), String>
    where
        P: widesnapshot::SnapshotPort,
    {
        if self.wide_review.is_none() {
            return Err(
                "the wide snapshot needs the wide review (enable_wide_review first)".into(),
            );
        }
        self.wide_snapshot = widesnapshot::SnapshotMode::ViaPort(widesnapshot::snapshot_via::<P>);
        Ok(())
    }

    /// Takes the wide review's snapshot through a **separately attached**
    /// source. Its relation to the keeper's read port (the same node or
    /// not) is the operator's claim and is **not** verified here; every
    /// response is still bound to its own keys, context slot and sysvars.
    /// Prefer [`Keeper::enable_wide_snapshot_via_port`]. Requires the
    /// review. Read only.
    #[cfg(feature = "wide-world-experimental")]
    pub fn enable_wide_snapshot(
        &mut self,
        source: Box<dyn widesnapshot::SnapshotSource>,
    ) -> Result<(), String> {
        if self.wide_review.is_none() {
            return Err(
                "the wide snapshot needs the wide review (enable_wide_review first)".into(),
            );
        }
        self.wide_snapshot = widesnapshot::SnapshotMode::Separate(source);
        Ok(())
    }

    /// Enables the read-only observation follower (`widefollow`): in ticks
    /// the legacy discovery does not pull (its feed gate blocked, or no
    /// gameplay role), at most `widefollow::PAGES_PER_TICK` pages are
    /// pulled from the follower's own cursor — starting after what the
    /// observer has processed — and shown to the observer and the review's
    /// proof store exactly as the legacy pull shows them. Requires the
    /// observer. Touches no legacy cursor, gate or signer; claims no
    /// completeness.
    #[cfg(feature = "wide-world-experimental")]
    pub fn enable_wide_follow(&mut self) -> Result<(), String> {
        match self.wide_observer.as_ref() {
            Some(o) => {
                self.wide_follow = Some(widefollow::WideFollow::from_observer(o));
                Ok(())
            }
            None => {
                Err("wide follow needs the wide observer (enable_wide_observation first)".into())
            }
        }
    }

    /// Enables the read-only wide observer over this Season's one legacy
    /// world (`WorldId::derive_legacy_season` of the public Season PDA and
    /// program id). Observation only: the legacy feed guard, the legacy
    /// cursors and every write gate are untouched; the observer's status
    /// always reports `automatic_writes: false` and `source_complete:
    /// false`. Starts empty on every process start (no journal).
    #[cfg(feature = "wide-world-experimental")]
    pub fn enable_wide_observation(&mut self, limits: wideindex::Limits) -> Result<(), String> {
        let world = frontier_abi::world_index::WorldId::derive_legacy_season(
            &self.addrs.season.to_bytes(),
            &self.addrs.program.to_bytes(),
        )
        .map_err(|e| format!("{e:?}"))?;
        self.wide_observer = Some(wideindex::WideObserver::new(
            wideindex::Scope {
                program: self.addrs.program,
                season: self.addrs.season,
                world,
                source: "keeper feed pages shared with the legacy discovery; program invocation frames decoded by fclient::typed_log; source completeness not established"
                    .into(),
            },
            limits,
        ));
        Ok(())
    }

    /// Sets the ClaimDefence signer: the beneficiary's key (§5.12: the
    /// keeper that claims is the beneficiary of the slots).
    pub fn set_claim_key(&mut self, kp: fclient::Keypair) -> Result<(), String> {
        use solana_signer::Signer as _;
        if kp.pubkey() != self.cfg.beneficiary {
            return Err(format!(
                "the claim key {} is not the beneficiary {}",
                kp.pubkey(),
                self.cfg.beneficiary
            ));
        }
        self.cfg.claim_key = Some(kp.pubkey());
        self.payers.extra.push(kp);
        Ok(())
    }

    fn alert(&mut self, slot: u64, kind: &str, detail: String) {
        if let Some(j) = &self.journal {
            let _ = j.alert(slot, kind, &detail);
        }
        self.alerts.push((slot, kind.into(), detail));
    }

    /// Start-up (§8.2 crash safety): reconcile every in-flight attempt of
    /// the journal with the chain, adopt the ones still undecided so their
    /// landing ends the write, and read the payers' balances.
    pub async fn start(&mut self) -> Result<usize, String> {
        let clock = self.port.clock().await.map_err(|e| e.to_string())?;
        // A status from the first moment (a restarted keeper answered
        // `null` until its first tick ended; W6T-2, R2).
        self.publish(clock.slot, clock.unix_timestamp, None);
        let mut adopted = 0;
        if let Some(j) = &self.journal {
            let inflight = j.in_flight()?;
            let sigs = recovery_signatures(&inflight)?;
            let sts = self.port.statuses(&sigs).await.map_err(|e| e.to_string())?;
            let mut keep = vec![];
            for (a, st) in recovery_statuses(&inflight, sts)? {
                match st {
                    Some(st) => {
                        let s = if st.err.is_none() {
                            "landed"
                        } else if a
                            .tag
                            .zip(st.code)
                            .is_some_and(|(tag, code)| abi::err::is_done(tag, code))
                        {
                            "done"
                        } else {
                            "failed"
                        };
                        j.record_recovered_finality(a, s, st.slot, st.code)?;
                        self.engine.charge_recovered(a);
                        if a.kind == PAYER_CARE_KIND {
                            self.engine.note_care_settled(st.slot);
                        }
                    }
                    // Slot age is not proof that this signature never landed:
                    // a null status can also mean RPC history is unavailable.
                    None => keep.push(a.clone()),
                }
            }
            adopted = keep.len();
            self.engine.adopt(&keep)?;
            // A restarted process has the signatures but not the original
            // retry ladder, fee cap and duty plan. Never spend another fee
            // against an old write by re-planning it with current settings.
            // Keep observing every unknown signature and unblock this key
            // only after they all have a definitive result. New rows carry
            // a write ID so observations can be matched to their generation;
            // legacy rows remain ungrouped and are held just as strictly.
            let mut checked = BTreeSet::new();
            for a in &keep {
                if checked.insert(a.object_key.clone()) {
                    self.engine.hold_adopted_until_known(&a.object_key);
                }
            }
            // Older keepers labelled care attempts "expired" from 151 slots
            // alone. Query their signatures again; only a finalized result
            // may clear that ambiguous status.
            let legacy = j.expired_attempts_of_kind(PAYER_CARE_KIND)?;
            let sigs = recovery_signatures(&legacy)?;
            let statuses = self.port.statuses(&sigs).await.map_err(|e| e.to_string())?;
            for (a, st) in recovery_statuses(&legacy, statuses)? {
                if let Some(st) = st {
                    let s = if st.err.is_none() { "landed" } else { "failed" };
                    j.record_recovered_finality(a, s, st.slot, st.code)?;
                    self.engine.charge_recovered(a);
                    self.engine.note_care_settled(st.slot);
                }
            }
            if let Some(slot) = j.latest_settled_slot(PAYER_CARE_KIND)? {
                self.engine.note_care_settled(slot);
            }
            self.care_legacy_unknown = j.has_expired_attempt(PAYER_CARE_KIND)?;
        }
        if self.care_legacy_unknown {
            self.alert(
                clock.slot,
                "care-unknown-legacy",
                "old payer-care 'expired' attempts need reconciliation before another transfer"
                    .into(),
            );
        }
        self.payers
            .refresh_at_least(
                &self.port,
                clock.slot,
                self.engine.care_settled_slot().unwrap_or(0),
            )
            .await
            .map_err(|e| e.to_string())?;
        Ok(adopted)
    }

    /// One feed pass shared by both legacy indexes. Never advance past a
    /// blocker, and never plan from a partial restart prefix. Beacon-only
    /// deployments need no gameplay feed and keep their previous behavior.
    async fn refresh_discovery(&mut self) -> Result<(), String> {
        #[cfg(feature = "wide-world-experimental")]
        {
            self.wide_legacy_pulled = false;
        }
        if !LAND_ROLES
            .iter()
            .chain(PLAY_ROLES.iter())
            .any(|r| self.cfg.has_role(r))
            && !self.cfg.has_role("rings")
            && !self.cfg.has_role("archive")
        {
            return Ok(());
        }
        self.engine.restore_feed_block(self.journal.as_ref())?;
        if let Some(block) = self.engine.feed_block().cloned() {
            self.index.feed.restore(block.clone());
            self.play.index.feed.restore(block);
        }
        self.engine.set_feed_ready(false);
        self.shared
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .feed_paused = true;
        let result = if self.index.feed.blocked().is_some()
            || self.play.index.feed.blocked().is_some()
        {
            Ok(())
        } else if self.index.cursor == self.play.index.cursor {
            #[cfg(feature = "wide-world-experimental")]
            {
                self.wide_legacy_pulled = true;
            }
            self.index.feed.begin_pull();
            self.play.index.feed.begin_pull();
            let mut result = Ok(());
            for _ in 0..crate::landindex::PAGES_PER_TICK {
                let page = match self.port.feed(self.index.cursor).await {
                    Ok(page) => page,
                    Err(e) => {
                        result = Err(e.to_string());
                        break;
                    }
                };
                // The read-only wide observer sees the same page before
                // the legacy guard ingests it; it changes nothing below.
                #[cfg(feature = "wide-world-experimental")]
                let accepted = match self.wide_observer.as_mut() {
                    Some(o) => {
                        o.observe_page(&page, &self.addrs.program);
                        o.accepted_prefix
                    }
                    None => 0,
                };
                // The read-only wide review's proof store sees exactly the
                // records the observer processed from this page (its
                // `accepted_prefix`: none when it was blocked already or
                // refused the page's order, the records before the one
                // that blocked it otherwise); the rest are dropped and
                // counted; committed WideDeparts are extracted by
                // `wideproof` (wire and frame bound, signatures
                // unverified), at most `MAX_EXTRACT_PER_PAGE` per page.
                #[cfg(feature = "wide-world-experimental")]
                if let Some(r) = self.wide_review.as_mut() {
                    r.proofs.observe_page(
                        &page,
                        &wideproof::ProofScope {
                            program: self.addrs.program,
                            season: self.addrs.season,
                        },
                        accepted,
                    );
                }
                if page.is_empty() {
                    self.index.feed.caught_up();
                    self.play.index.feed.caught_up();
                    break;
                }
                self.index.ingest_page(&page, &self.addrs);
                self.play.index.ingest_page(&page, &self.addrs);
                if self.index.feed.blocked().is_some() || self.play.index.feed.blocked().is_some() {
                    break;
                }
            }
            result
        } else {
            #[cfg(feature = "wide-world-experimental")]
            {
                self.wide_legacy_pulled = true;
            }
            let land = self.index.pull(&self.port, &self.addrs).await;
            let play = self.play.index.pull(&self.port, &self.addrs).await;
            land.and(play).map(|_| ()).map_err(|e| e.to_string())
        };
        if let Some(block) = self
            .index
            .feed
            .blocked()
            .or(self.play.index.feed.blocked())
            .cloned()
        {
            self.engine.block_feed(block.clone());
            self.index.feed.restore(block.clone());
            self.play.index.feed.restore(block);
        }
        // Latch in memory before the fallible durable write. A storage error
        // cannot accidentally authorize the next tick or direct Engine send.
        self.engine.persist_feed_block(self.journal.as_ref())?;
        self.engine
            .set_feed_ready(self.index.feed.ready() && self.play.index.feed.ready());
        self.play.feed_read = true;
        self.shared
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .feed_paused = !self.engine.feed_writes_allowed();
        if self.engine.feed_block().is_some() {
            Ok(())
        } else {
            result
        }
    }

    /// R-22: an MC season's writes take the v2 budgets table (`L(kind)`
    /// for the new kinds; the changed rows' CU), an M1 season keeps v1's.
    /// A `budgets_file` in `keeper.toml` is the operator's and stays.
    /// An S1 season takes S1's (its own `program_version`).
    fn follow_abi(&mut self, s: &Season) {
        let v = if s.is_v2() {
            s.program_version
        } else {
            abi::PROGRAM_VERSION_V1
        };
        if v == self.budgets_version || self.cfg.budgets_file.is_some() {
            return;
        }
        let care = self.engine.budgets.get(0);
        let mut b = Budgets::canonical_for(v);
        b.set(0, care);
        // The reveal floor follows the Reveal this table requests.
        let fr = crate::pools::reveal_floor_for(&self.cfg, &b);
        self.payers.reveal.floor = fr;
        self.payers.reveal.ceiling = fr.saturating_mul(2);
        self.engine.budgets = b;
        self.budgets_version = v;
    }

    fn update_params(&mut self, s: &Season) {
        let cost_reveal = fees::cost(s.reveal_cu_limit, 1, 2, s.reveal_loaded_limit);
        let tip_min = fees::min_tip_lamports(
            s.min_reveal_priority_milli,
            s.reveal_cu_limit,
            s.reveal_loaded_limit,
        );
        let p_tip = fees::p_tip_milli(tip_min, cost_reveal).max(1);
        let p = &mut self.engine.params;
        p.p_tip_milli = p_tip;
        p.p_start_milli = match self.cfg.peace_start {
            Some(f) => ((p_tip as f64) * f).round().max(1.0) as u64,
            None => p_tip,
        };
        p.p_def_milli = self.cfg.p_def_milli.min(s.defence_cap_milli as u64).max(1);
    }

    /// One slot of work. Returns early (idle) when the slot has not moved.
    pub async fn tick(&mut self) -> Result<TickReport, String> {
        let clock = self.port.clock().await.map_err(|e| e.to_string())?;
        let (slot, now) = (clock.slot, clock.unix_timestamp);
        let mut rep = TickReport {
            slot,
            now,
            ..Default::default()
        };
        if self.last_slot == Some(slot) {
            // W6T-2 (cause B): a drand round this slot asked for and did
            // not get is asked again within the slot, and its anchor or
            // seed cache goes out at once (beacon duty and send only). The
            // round is public from its time; waiting for the next slot cost
            // one of criterion 3's two slots (W6-A F-A3).
            if let Some(season) = self.season.clone() {
                if self.cfg.has_role("beacon")
                    && season.status >= status::SEEDED
                    && self.rounds.pk_hash() == season.quicknet_pk_hash
                    && self.rounds.take_missed(slot)
                {
                    let t = Tick {
                        slot,
                        now,
                        season: &season,
                        clock: SeasonClock::from_season(&season),
                        addrs: &self.addrs,
                        cfg: &self.cfg,
                    };
                    self.beacon
                        .plan(
                            &t,
                            &self.port,
                            &self.drand,
                            &mut self.rounds,
                            &mut self.engine,
                            self.journal.as_ref(),
                        )
                        .await
                        .map_err(|e| e.to_string())?;
                    let mut r = crate::engine::StepReport::default();
                    self.engine
                        .send_kinds(
                            &self.port,
                            &mut self.payers,
                            self.journal.as_ref(),
                            slot,
                            &mut r,
                            Some(&BEACON_KINDS),
                        )
                        .await;
                    rep.sent = r.sent;
                    rep.chain_at_send = self.engine.last_send_chain_slot.filter(|_| r.sent > 0);
                    self.note_step(slot, &r);
                    rep.outcomes = r.outcomes;
                    rep.contested = r.contested;
                }
            }
            rep.idle = true;
            return Ok(rep);
        }
        self.last_slot = Some(slot);
        let mut t_phase = std::time::Instant::now();
        let mut phase = |rep: &mut TickReport, name: &'static str, reads: u64| {
            rep.phases
                .push((name, t_phase.elapsed().as_millis() as u64, reads));
            t_phase = std::time::Instant::now();
        };
        // The season: every slot until it runs, then every 16 slots.
        let stale = self.season.as_ref().is_none_or(|s| {
            s.effective_status(now) != status::RUNNING
                || self.season_read_slot.is_none_or(|r| slot >= r + 16)
        });
        if stale {
            let got = self
                .port
                .accounts(&[self.addrs.season], 0)
                .await
                .map_err(|e| e.to_string())?;
            if let Some(s) = got[0]
                .as_ref()
                .filter(|a| a.owner == self.addrs.program)
                .and_then(|a| Season::decode(&a.data).ok())
            {
                self.update_params(&s);
                self.follow_abi(&s);
                self.season = Some(s);
                self.season_read_slot = Some(slot);
            }
        }
        // Payer care and the per-bell effective N (at rest, never inside a
        // critical write).
        let bell = self
            .season
            .as_ref()
            .and_then(|s| SeasonClock::from_season(s).bell_at(now));
        let low = self.payers.effective_n(Class::W)
            < fclient::payers::MIN_REVEAL.min(self.payers.reveal.keys.len())
            || self.payers.effective_n(Class::D)
                < fclient::payers::MIN_DELAY.min(self.payers.delay.keys.len());
        let care_pending = self.care_legacy_unknown || self.engine.care_unresolved();
        if care_due(&self.cfg, self.care_last, slot, now, low, care_pending) {
            self.payers
                .refresh_at_least(
                    &self.port,
                    slot,
                    self.engine.care_settled_slot().unwrap_or(0),
                )
                .await
                .map_err(|e| e.to_string())?;
            let planned = self.plan_care(slot);
            self.care_last = Some((slot, now, planned));
        }
        if let Some(b) = bell {
            if self.effective_n.last().is_none_or(|x| x.0 != b) {
                let (w, d) = (
                    self.payers.effective_n(Class::W),
                    self.payers.effective_n(Class::D),
                );
                self.effective_n.push((b, w, d));
                let want = fclient::payers::MIN_REVEAL.min(self.payers.reveal.keys.len());
                if w < want {
                    self.alert(
                        slot,
                        "reveal-pool-low",
                        format!(
                            "bell {b}: effective N {w} < {want}; topping up, W writes continue"
                        ),
                    );
                }
            }
        }
        phase(&mut rep, "season+care", 0);
        // Poll first: a write that landed is an outcome before the duties
        // re-read the chain.
        let mut r = self
            .engine
            .poll(&self.port, self.journal.as_ref(), slot)
            .await;
        for (k, o) in &r.outcomes {
            // A retry window ending without a definitive chain status is
            // not a program refusal. Do not trigger duty failure handlers.
            if matches!(o, Outcome::Unresolved { .. }) {
                continue;
            }
            if let Outcome::Landed { .. } = o {
                self.archive.on_landed(k, &mut self.beacon.anchors);
                self.fold.on_landed(k);
            }
            if k.starts_with("ticket:") {
                self.tickets.on_outcome(k, o);
            }
            let now_bell = bell.unwrap_or(0);
            self.play
                .conquest
                .on_outcome(k, o, now_bell, self.journal.as_ref());
            let tracks = self.play.on_outcome(k, o);
            if !tracks.is_empty() {
                let mut s = self.shared.lock().unwrap_or_else(|p| p.into_inner());
                for (id, v) in tracks {
                    s.tracks.insert(id, v);
                }
            }
        }
        phase(&mut rep, "poll", 0);
        // Duties.
        if let Some(season) = self.season.clone() {
            let sclock = SeasonClock::from_season(&season);
            let key_ok = self.rounds.pk_hash() == season.quicknet_pk_hash;
            if !key_ok && !self.wrong_key_alerted {
                self.wrong_key_alerted = true;
                self.alert(
                    slot,
                    "beacon-key",
                    "the drand key does not hash to the season's quicknet_pk_hash; beacon duties off"
                        .into(),
                );
            }
            // Roles the program lacks (99) are off for the rest of the run.
            let mut cfg = self.cfg.clone();
            cfg.roles
                .retain(|r| !self.unsupported_roles.contains(r.as_str()));
            let addrs = self.addrs.clone();
            let t = Tick {
                slot,
                now,
                season: &season,
                clock: sclock,
                addrs: &addrs,
                cfg: &cfg,
            };
            if key_ok {
                self.genesis
                    .plan(
                        &t,
                        &self.port,
                        &self.drand,
                        &mut self.rounds,
                        &mut self.engine,
                    )
                    .await
                    .map_err(|e| e.to_string())?;
                self.rings
                    .plan(
                        &t,
                        &self.port,
                        &self.drand,
                        &mut self.rounds,
                        &mut self.engine,
                    )
                    .await
                    .map_err(|e| e.to_string())?;
                if self.cfg.has_role("beacon") && season.status >= status::SEEDED {
                    self.beacon
                        .plan(
                            &t,
                            &self.port,
                            &self.drand,
                            &mut self.rounds,
                            &mut self.engine,
                            self.journal.as_ref(),
                        )
                        .await
                        .map_err(|e| e.to_string())?;
                }
            }
            self.archive
                .plan(&t, &self.beacon.anchors, &mut self.engine);
            phase(&mut rep, "beacon", 0);
            // The anchors and seed caches go out at once (W6T-2, R2): the
            // land and play duties first pull the feed (≈ 0.4 s a tick while
            // a restarted keeper re-reads it), and an anchor planned in its
            // publication slot but sent after them landed a slot late.
            self.engine
                .send_kinds(
                    &self.port,
                    &mut self.payers,
                    self.journal.as_ref(),
                    slot,
                    &mut r,
                    Some(&BEACON_KINDS),
                )
                .await;
            if r.sent > 0 {
                rep.chain_at_send = self.engine.last_send_chain_slot;
            }
            phase(&mut rep, "send0", 0);
            // Keep beacon publication ahead of the potentially slow feed
            // catch-up. No game write is sent until this shared gate runs.
            let result = self.refresh_discovery().await;
            // The read-only observation follower (feature
            // `wide-world-experimental`, opt in): in a tick the legacy
            // discovery did not pull, bounded pages from its own cursor
            // to the same observer and proof store. No legacy cursor, no
            // gate, no readiness change; the discovery result stands.
            #[cfg(feature = "wide-world-experimental")]
            if let (Some(o), Some(f)) = (self.wide_observer.as_mut(), self.wide_follow.as_mut()) {
                let scope = wideproof::ProofScope {
                    program: self.addrs.program,
                    season: self.addrs.season,
                };
                let proofs = self.wide_review.as_mut().map(|r| &mut r.proofs);
                let pulled = f
                    .step(&self.port, o, proofs, &scope, self.wide_legacy_pulled)
                    .await;
                phase(&mut rep, "wide-follow", pulled);
            }
            // The bounded read-only wide review (feature
            // `wide-world-experimental`): plans and reviews, enqueues
            // nothing; runs before the status is published, whether or not
            // the discovery pull failed or the legacy guard has fired, and
            // leaves the discovery result and every gate as they were.
            #[cfg(feature = "wide-world-experimental")]
            if let (Some(o), Some(r)) = (self.wide_observer.as_ref(), self.wide_review.as_mut()) {
                // Reveal inputs exist only once the Season has been read
                // (its clock names the beacon round) and the review's own
                // verified beacon cache is set; the beneficiary is the
                // configured public address. Without them no reveal hint
                // is listed and the status names the gap.
                let mut publications =
                    self.wide_beacon
                        .as_mut()
                        .map(|cache| widetick::DrandPublications {
                            drand: &self.drand,
                            cache,
                        });
                let inputs = match (self.season.as_ref(), publications.as_mut()) {
                    (Some(s), Some(p)) => Some(widetick::RevealInputs {
                        season: s,
                        beacon: p,
                        beneficiary: self.cfg.beneficiary,
                    }),
                    _ => None,
                };
                // The snapshot source: the keeper's own read port through
                // the function pointer taken when `P: SnapshotPort` was
                // known, a separately attached source, or none.
                let via = match &self.wide_snapshot {
                    widesnapshot::SnapshotMode::ViaPort(f) => Some(widesnapshot::PortSnapshot {
                        port: &self.port,
                        f: *f,
                    }),
                    _ => None,
                };
                let snapshot: Option<&dyn widesnapshot::SnapshotSource> = match &self.wide_snapshot
                {
                    widesnapshot::SnapshotMode::Off => None,
                    widesnapshot::SnapshotMode::ViaPort(_) => {
                        via.as_ref().map(|v| v as &dyn widesnapshot::SnapshotSource)
                    }
                    widesnapshot::SnapshotMode::Separate(b) => Some(b.as_ref()),
                };
                // The observer is lent read-only for the reconciliation
                // diagnostics (observed chain heads against the snapshot's
                // account chain fields): nothing it holds is moved.
                let plans = r
                    .step_observing(
                        &self.port,
                        &self.engine,
                        &o.model,
                        self.addrs.program,
                        self.addrs.season,
                        slot,
                        snapshot,
                        inputs,
                        Some(o),
                    )
                    .await;
                phase(&mut rep, "wide-review", plans);
            }
            self.publish(slot, now, bell);
            result?;
            // Both indexes are gated before the land and play duties.
            if self.engine.feed_writes_allowed() && LAND_ROLES.iter().any(|r| t.cfg.has_role(r)) {
                self.fold
                    .plan(&t, &self.port, &mut self.engine)
                    .await
                    .map_err(|e| e.to_string())?;
                self.tickets
                    .plan(
                        &t,
                        &self.port,
                        &mut self.engine,
                        &mut self.index,
                        &mut self.seeds,
                        &self.beacon.anchors,
                    )
                    .await
                    .map_err(|e| e.to_string())?;
                self.explore
                    .plan(
                        &t,
                        &self.port,
                        &mut self.engine,
                        &mut self.index,
                        &mut self.seeds,
                        &self.beacon.anchors,
                    )
                    .await
                    .map_err(|e| e.to_string())?;
                let mut provinces = self.rings.opened.clone();
                provinces.extend(
                    self.index
                        .provinces
                        .iter()
                        .map(|&(p, q)| (p as i32, q as i32)),
                );
                self.holdings
                    .plan(
                        &t,
                        &self.port,
                        &mut self.engine,
                        &mut self.index,
                        &provinces,
                    )
                    .await
                    .map_err(|e| e.to_string())?;
            }
            phase(&mut rep, "land", 0);
        }
        // Play (W4-C).
        let play_on = self.engine.feed_writes_allowed()
            && PLAY_ROLES.iter().any(|r| self.cfg.has_role(r))
            && !PLAY_ROLES
                .iter()
                .all(|r| self.unsupported_roles.contains(r));
        // The CU-meter test of a failed version reads the feed's meta,
        // which the play index pulls (W6T-2).
        self.engine.expect_tx_meta = play_on;
        if let Some(season) = self.season.clone() {
            if play_on {
                let cfg_eff;
                let cfg = if self.unsupported_roles.is_empty() {
                    &self.cfg
                } else {
                    let mut c = self.cfg.clone();
                    c.roles
                        .retain(|r| !self.unsupported_roles.contains(r.as_str()));
                    cfg_eff = c;
                    &cfg_eff
                };
                let t = Tick {
                    slot,
                    now,
                    season: &season,
                    clock: SeasonClock::from_season(&season),
                    addrs: &self.addrs,
                    cfg,
                };
                let mut provinces = self.rings.opened.clone();
                provinces.extend(
                    self.index
                        .provinces
                        .iter()
                        .map(|&(p, q)| (p as i32, q as i32)),
                );
                let opened: BTreeSet<(i16, i16)> = provinces
                    .iter()
                    .map(|&(p, q)| (p as i16, q as i16))
                    .collect();
                // Only the queued material and nudges leave the API's state
                // (W6T-2): the status, tracks and dedupe keys stay served.
                let mut shared = {
                    let mut s = self.shared.lock().unwrap_or_else(|p| p.into_inner());
                    Shared {
                        reveals: std::mem::take(&mut s.reveals),
                        nudges: std::mem::take(&mut s.nudges),
                        ..Shared::default()
                    }
                };
                let r2 = self
                    .play
                    .plan_core(
                        &t,
                        &self.port,
                        &self.drand,
                        &mut self.rounds,
                        &mut self.engine,
                        &self.beacon.anchors,
                        &mut self.seeds,
                        &mut shared,
                        self.journal.as_ref(),
                        &provinces.into_iter().collect::<Vec<_>>(),
                    )
                    .await;
                // MC (CQ2-D): settles, folds and the season-end flush, on
                // the Provinces the play duty just read.
                let r3 = if r2.is_ok() {
                    self.play
                        .conquest
                        .plan(
                            &t,
                            &self.port,
                            &mut self.engine,
                            &self.index.citizens,
                            &opened,
                        )
                        .await
                } else {
                    Ok(())
                };
                self.play.guard_reveals(&t, &mut self.engine);
                let blocking = self.play.blocking(&t, &self.engine);
                {
                    // Merge back: material the play duty could not take
                    // yet stays queued ahead of what the API queued since.
                    let mut s = self.shared.lock().unwrap_or_else(|p| p.into_inner());
                    let newer_reveals = std::mem::take(&mut s.reveals);
                    let newer_nudges = std::mem::take(&mut s.nudges);
                    s.reveals = std::mem::take(&mut shared.reveals);
                    s.reveals.extend(newer_reveals);
                    s.nudges = std::mem::take(&mut shared.nudges);
                    s.nudges.extend(newer_nudges);
                    s.tracks.extend(std::mem::take(&mut shared.tracks));
                    s.blocking = blocking;
                }
                for (sig, units, meter) in self.play.index.failed_meta.drain(..) {
                    self.engine.note_tx_meta(sig, units, meter);
                }
                r2.map_err(|e| e.to_string())?;
                r3.map_err(|e| e.to_string())?;
                for (s0, d) in std::mem::take(&mut self.play.conquest.alerts) {
                    self.alert(s0, "horn-rate", d);
                }
            }
        }
        phase(&mut rep, "play", 0);
        // Send the next versions.
        self.engine
            .send(
                &self.port,
                &mut self.payers,
                self.journal.as_ref(),
                slot,
                &mut r,
            )
            .await;
        if rep.chain_at_send.is_none() && r.sent > 0 {
            rep.chain_at_send = self.engine.last_send_chain_slot;
        }
        phase(&mut rep, "send", 0);
        // Housekeeping after the send (W6T-2): closes (class N) and claims
        // plan once the latency-critical versions of this slot are out, and
        // go out in a second send.
        if play_on {
            if let Some(season) = self.season.clone() {
                let mut cfg_eff = self.cfg.clone();
                cfg_eff
                    .roles
                    .retain(|r| !self.unsupported_roles.contains(r.as_str()));
                let t = Tick {
                    slot,
                    now,
                    season: &season,
                    clock: SeasonClock::from_season(&season),
                    addrs: &self.addrs,
                    cfg: &cfg_eff,
                };
                let before = self.play.closes_reads;
                self.play
                    .housekeeping(&t, &self.port, &mut self.engine, &self.beacon.anchors)
                    .await
                    .map_err(|e| e.to_string())?;
                self.play
                    .conquest
                    .housekeeping(&t, &self.port, &mut self.engine)
                    .await
                    .map_err(|e| e.to_string())?;
                let reads = self.play.closes_reads - before;
                phase(&mut rep, "closes", reads);
                let sent = r.sent;
                self.engine
                    .send(
                        &self.port,
                        &mut self.payers,
                        self.journal.as_ref(),
                        slot,
                        &mut r,
                    )
                    .await;
                if rep.chain_at_send.is_none() && r.sent > sent {
                    rep.chain_at_send = self.engine.last_send_chain_slot;
                }
                phase(&mut rep, "send2", 0);
            }
        }
        rep.sent = r.sent;
        let day = bell.map_or(0, |b| b / abi::BELLS_PER_DAY);
        let fees_now: u64 = self.engine.stats.values().map(|s| s.fees_charged).sum();
        self.spend_by_day.insert(day, fees_now);
        self.note_step(slot, &r);
        rep.outcomes = r.outcomes;
        rep.contested = r.contested;
        self.publish(slot, now, bell);
        Ok(rep)
    }

    /// Alerts and duty reactions for what a step reported: dead and
    /// failed writes, contested bells, retry-ladder rungs.
    fn note_step(&mut self, slot: u64, r: &crate::engine::StepReport) {
        for event in &r.cancelled_landed {
            self.alert(
                slot,
                "cancelled-late-landed",
                format!(
                    "{}: signature {} landed in slot {} after {:?} cancellation; reconcile chain state before re-planning",
                    event.key, event.sig, event.slot, event.reason
                ),
            );
        }
        for (k, o) in &r.outcomes {
            match o {
                Outcome::Dead { code, reason } => {
                    let land_role =
                        role_of_key(k).filter(|_| *code == Some(abi::err::NOT_IMPLEMENTED));
                    if let Some(role) = land_role {
                        if self.unsupported_roles.insert(role) {
                            self.alert(
                                slot,
                                "not-implemented",
                                format!("{k}: {reason}; role `{role}` off (the program lacks it)"),
                            );
                        }
                    } else if self.rings.on_dead(k, *code) || self.archive.on_dead(k, *code) {
                        self.alert(
                            slot,
                            "not-implemented",
                            format!("{k}: {reason}; the program lacks this instruction"),
                        );
                    } else {
                        self.alert(slot, "dead", format!("{k}: {reason}"));
                    }
                }
                Outcome::Landed { .. } => {}
                Outcome::Unresolved { .. } => {}
                Outcome::Failed { code, err, .. } => {
                    // Expected refusals of a re-planned write: an anchor or
                    // seed not there yet, a fold part of an older bell, a
                    // ticket whose preference moved (another settler won).
                    let expected = [
                        abi::err::NO_ANCHOR,
                        abi::err::SEED_NOT_READY,
                        abi::err::FOLD_STALE,
                        abi::err::TICKET_STATE,
                        // Play (W4-C): a skip that meets a contested bell
                        // (gathered and resolved instead), a slot index
                        // another Reveal took, a quota refusal (settled
                        // bounced), a settlement or gather a little early.
                        abi::err::NOT_QUIET,
                        abi::err::SLOT_MOVED,
                        abi::err::QUOTA_REFUSED,
                        abi::err::TOO_EARLY,
                        abi::err::DEPARTURE_UNSETTLED,
                        // MC (CQ2-D): a FoldMarch planned on a member read
                        // a little before its resolve landed (lag waits).
                        abi::err::FOLD_TOO_EARLY,
                    ];
                    if !code.is_some_and(|c| expected.contains(&c)) {
                        self.alert(slot, "failed", format!("{k}: {code:?} {err}"));
                    }
                }
            }
        }
        for (b, rg, k) in &r.contested {
            self.beacon.on_contested(*b);
            self.alert(
                slot,
                "contested",
                format!("{k} (bell {b:?}, region {rg:?})"),
            );
        }
        for (k, cu, heap) in &r.ladder {
            self.alert(slot, "retry-ladder", format!("{k}: cu {cu}, heap {heap:?}"));
        }
    }

    /// Top-ups and sweeps as class N transfers signed by their source.
    fn plan_care(&mut self, slot: u64) -> usize {
        let plan = self.payers.care_plan();
        let n = plan.len();
        for tr in plan {
            let ix = tr.instruction();
            self.engine.ensure(
                WriteSpec {
                    key: format!("care:{}:{}:{slot}", tr.from, tr.to),
                    kind: PAYER_CARE_KIND,
                    tag: 0,
                    class: Class::N,
                    bell: None,
                    region: None,
                    build: Arc::new(move |_: &BuildCtx| vec![ix.clone()]),
                    deadline_slot: None,
                    not_before_slot: 0,
                    fixed_payer: Some(tr.from),
                },
                slot,
            );
        }
        n
    }

    /// The status JSON (`GET /v1/status`).
    pub fn status_json(&self, slot: u64, now: i64, bell: Option<u32>) -> Value {
        let kinds: BTreeMap<String, Value> = self
            .engine
            .stats
            .iter()
            .map(|(k, s)| {
                (
                    k.clone(),
                    json!({
                        "writes": s.writes, "versions": s.versions, "landed": s.landed, "failed": s.failed,
                        "dead": s.dead, "fees_charged": s.fees_charged,
                        "latency_slots_p50": quantile(&s.latency_slots, 0.5),
                        "latency_slots_p99": quantile(&s.latency_slots, 0.99),
                    }),
                )
            })
            .collect();
        let pool_sum = |ks: Vec<Address>| ks.iter().map(|k| self.payers.balance(k)).sum::<u64>();
        let mut status = json!({
            "slot": slot, "now": now, "bell": bell,
            "season": self.season.as_ref().map(|s| json!({
                "id": s.h.season_id, "status": s.effective_status(now), "genesis_ts": s.genesis_ts,
                "genesis_round": s.genesis_round,
            })),
            "duties": {
                "next_bell": self.beacon.next_bell,
                "anchors_known": self.beacon.anchors.len(),
                "caches_known": self.beacon.anchors.values().filter(|a| a.cache.is_some()).count(),
                "contested_bells": self.beacon.contested_bells.iter().collect::<Vec<_>>(),
                "anchor_latency_slots_p99": quantile(&self.beacon.anchor_latency, 0.99),
                "seed_latency_slots_p99": quantile(&self.beacon.seed_latency, 0.99),
                "provinces_opened": self.rings.opened.len(),
                "rings_complete": self.rings.complete.iter().collect::<Vec<_>>(),
                "ring_waiting": self.rings.waiting.as_ref().map(|w| format!("{w:?}")),
                "extend_waiting": self.rings.extend_waiting.as_ref().map(|w| format!("{w:?}")),
                "rings_unsupported": self.rings.unsupported,
                "folded_bells": self.fold.folded.len(),
                "tickets_open": self.index.tickets.len(),
                "tickets_settled": self.tickets.settled.len(),
                "tickets_expired": self.tickets.expired,
                "ticket_winner_latency_slots_p99": quantile(&self.tickets.winner_latency(), 0.99),
                "explores_sent": self.explore.sent.len(),
                "releases_sent": self.holdings.releases.len(),
                "sweeps_sent": self.holdings.sweeps.len(),
                "disbands_sent": self.holdings.disbands.len(),
                "land_unsupported": self.unsupported_roles.iter().collect::<Vec<_>>(),
                "archive_unsupported": self.archive.unsupported,
                "archived_bells": self.archive.archived_bells,
            },
            "discovery": {
                "automatic_writes": self.engine.feed_writes_allowed(),
                "blocker": self.engine.feed_block().map(crate::feedguard::FeedBlock::status),
                "land_cursor": self.index.cursor.0, "play_cursor": self.play.index.cursor.0,
                "land": self.index.feed.status(), "play": self.play.index.feed.status(),
            },
            "pending": self.engine.pending_len(),
            "kinds": kinds,
            "pools": {
                "reveal": {"n": self.payers.reveal.keys.len(), "effective_n": self.payers.effective_n(Class::W),
                           "floor": self.payers.reveal.floor, "lamports": pool_sum(self.payers.reveal.addresses())},
                "delay": {"n": self.payers.delay.keys.len(), "effective_n": self.payers.effective_n(Class::D),
                          "floor": self.payers.delay.floor, "lamports": pool_sum(self.payers.delay.addresses())},
                "funders": {"n": self.payers.funders.keys.len(),
                            "lamports": self.payers.funders.keys.iter().map(|k| self.payers.balance(&solana_signer::Signer::pubkey(k))).sum::<u64>()},
            },
            "params": {
                "p_tip_milli": self.engine.params.p_tip_milli, "p_start_milli": self.engine.params.p_start_milli,
                "p_def_milli": self.engine.params.p_def_milli, "p_delay_milli": self.engine.params.p_delay_milli,
            },
            "play": self.play.status(),
            "conquest": self.play.conquest.status(bell),
            "spend_by_day": self.spend_by_day,
            "alerts": self.alerts.len(),
        });
        // The read-only wide observation (feature `wide-world-experimental`):
        // counts and the blocker; never a readiness or completeness claim.
        if let Some(wide) = self.wide_status() {
            status["wide"] = wide;
        }
        status
    }

    /// The `wide` status entry: the observer's status, or the explicit
    /// "disabled" shape; `None` in a build without the feature.
    #[cfg(feature = "wide-world-experimental")]
    fn wide_status(&self) -> Option<Value> {
        Some(match &self.wide_observer {
            Some(o) => {
                let mut v = o.status();
                v["review"] = match &self.wide_review {
                    Some(r) => r.status(),
                    None => json!({"mode": "disabled", "automatic_writes": false}),
                };
                v["snapshot_mode"] = json!(self.wide_snapshot.label());
                v["follow"] = match &self.wide_follow {
                    Some(f) => f.status(),
                    None => {
                        json!({"mode": "disabled", "automatic_writes": false, "source_complete": false})
                    }
                };
                v
            }
            None => {
                json!({"mode": "disabled", "automatic_writes": false, "source_complete": false})
            }
        })
    }

    #[cfg(not(feature = "wide-world-experimental"))]
    fn wide_status(&self) -> Option<Value> {
        None
    }

    /// Prometheus text (`GET /metrics`).
    pub fn metrics_text(&self, slot: u64, bell: Option<u32>) -> String {
        let mut m = String::new();
        let mut line = |k: &str, v: String| {
            m.push_str(k);
            m.push(' ');
            m.push_str(&v);
            m.push('\n');
        };
        line("frontier_keeper_slot", slot.to_string());
        line(
            "frontier_keeper_bell",
            bell.map_or("-1".into(), |b| b.to_string()),
        );
        for (k, s) in &self.engine.stats {
            line(
                &format!("frontier_keeper_writes_total{{kind=\"{k}\"}}"),
                s.writes.to_string(),
            );
            line(
                &format!("frontier_keeper_versions_total{{kind=\"{k}\"}}"),
                s.versions.to_string(),
            );
            line(
                &format!("frontier_keeper_landed_total{{kind=\"{k}\"}}"),
                s.landed.to_string(),
            );
            line(
                &format!("frontier_keeper_failed_total{{kind=\"{k}\"}}"),
                s.failed.to_string(),
            );
            line(
                &format!("frontier_keeper_fees_lamports_total{{kind=\"{k}\"}}"),
                s.fees_charged.to_string(),
            );
            if let Some(p) = quantile(&s.latency_slots, 0.99) {
                line(
                    &format!("frontier_keeper_latency_slots{{kind=\"{k}\",q=\"0.99\"}}"),
                    p.to_string(),
                );
            }
        }
        for (pool, class) in [("reveal", Class::W), ("delay", Class::D)] {
            line(
                &format!("frontier_keeper_pool_effective_n{{pool=\"{pool}\"}}"),
                self.payers.effective_n(class).to_string(),
            );
        }
        line(
            "frontier_keeper_contested_bells",
            self.beacon.contested_bells.len().to_string(),
        );
        if let Some(p) = quantile(&self.beacon.anchor_latency, 0.99) {
            line(
                "frontier_keeper_anchor_latency_slots{q=\"0.99\"}",
                p.to_string(),
            );
        }
        if let Some(p) = quantile(&self.beacon.seed_latency, 0.99) {
            line(
                "frontier_keeper_seed_latency_slots{q=\"0.99\"}",
                p.to_string(),
            );
        }
        line(
            "frontier_keeper_alerts_total",
            self.alerts.len().to_string(),
        );
        line(
            "frontier_keeper_rounds_bad_total",
            self.rounds.bad.to_string(),
        );
        line(
            "frontier_keeper_discovery_blocked",
            u8::from(self.engine.feed_block().is_some()).to_string(),
        );
        line(
            "frontier_keeper_game_writes_paused",
            u8::from(!self.engine.feed_writes_allowed()).to_string(),
        );
        let ps = &self.play.stats;
        for (k, v) in [
            ("seals_opened", ps.opened),
            ("bad_seals", ps.bad_seals),
            ("reveals_sent", ps.reveals_sent),
            ("reveals_landed", ps.reveals_landed),
            ("reveals_refused", ps.reveals_refused),
            ("reveals_missed", ps.reveals_missed),
            ("slot_moved", ps.slot_moved),
            ("skipped_bells", ps.skipped_bells),
        ] {
            line(&format!("frontier_keeper_play_{k}_total"), v.to_string());
        }
        if let Some(p) = quantile(&ps.resolve_latency, 0.99) {
            line(
                "frontier_keeper_close_to_resolve_slots{q=\"0.99\"}",
                p.to_string(),
            );
        }
        self.play.conquest.metrics(&mut line);
        m
    }

    fn publish(&self, slot: u64, now: i64, bell: Option<u32>) {
        let status = self.status_json(slot, now, bell);
        let metrics = self.metrics_text(slot, bell);
        let mut s = self.shared.lock().unwrap_or_else(|p| p.into_inner());
        s.status = status;
        s.metrics = metrics;
    }
}

/// The land instruction tags W3-C sends, with their §5.5 class.
pub const W3C_TAGS: [(u8, Class); 9] = [
    (tag::OPEN_RING, Class::D),
    (tag::CONSUME_RING_SEED, Class::D),
    (tag::OPEN_PROVINCE, Class::D),
    (tag::FOLD_OCCUPANCY, Class::D),
    (tag::SETTLE_TICKET, Class::D),
    (tag::SETTLE_EXPLORE, Class::N),
    (tag::RELEASE_DORMANT, Class::N),
    (tag::DISBAND_STRANDED, Class::N),
    (tag::SWEEP_POOL_OWED, Class::N),
];

/// The play instruction tags W4-C sends, with their §5.5 class (the §21
/// return settle is SettleDeparture with `transit_slot = 0xFF`).
pub const W4C_TAGS: [(u8, Class); 10] = [
    (tag::REVEAL, Class::W),
    (tag::SETTLE_DEPARTURE, Class::D),
    (tag::GATHER_CLASH, Class::D),
    (tag::RESOLVE_FROM_INPUTS, Class::D),
    (tag::SKIP_QUIET, Class::D),
    (tag::SETTLE_TRANSIT, Class::D),
    (tag::CLAIM_DEFENCE, Class::D),
    (tag::CLOSE_CLASH_INPUTS, Class::N),
    (tag::CLOSE_ARRIVAL_DAY, Class::N),
    (tag::CLOSE_ARRIVAL_SLOT, Class::N),
];

/// The keeper-write instruction tags this unit sends (budget coverage test).
pub const W2F_TAGS: [u8; 9] = [
    tag::CONSUME_GENESIS_SEED,
    tag::POST_ANCHOR,
    tag::POST_ANCHOR_MULTI,
    tag::POST_SEED,
    tag::POST_BEACON,
    tag::OPEN_RING,
    tag::OPEN_PROVINCE,
    tag::ARCHIVE_ANCHORS,
    tag::CLOSE_SEED_CACHE,
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn locally_cancelled_landing_creates_distinct_alert() {
        let cfg = KeeperConfig::new(
            Address::new_from_array([0x5f; 32]),
            7,
            Address::new_from_array([0xbe; 32]),
        );
        let journal = Journal::open(std::path::Path::new(":memory:")).unwrap();
        let mut keeper = Keeper::new(
            cfg,
            crate::testkit::FakePort::default(),
            crate::testkit::FakeDrand::new(),
            &[1; 32],
            Some(journal),
        )
        .unwrap();
        let mut report = crate::engine::StepReport::default();
        report
            .cancelled_landed
            .push(crate::engine::CancelledLanding {
                key: "seed:5:3:42".into(),
                sig: Signature::default(),
                slot: 12,
                reason: crate::engine::CancelReason::SupersededNonce,
            });
        keeper.note_step(13, &report);
        assert_eq!(keeper.alerts.len(), 1);
        assert_eq!(keeper.alerts[0].1, "cancelled-late-landed");
        assert!(keeper
            .journal
            .as_ref()
            .unwrap()
            .alerts("cancelled-late-landed")
            .unwrap()[0]
            .1
            .contains("SupersededNonce"));
        assert!(report.outcomes.is_empty());
    }

    fn recovery_attempt(sig: String) -> Attempt {
        Attempt {
            sig,
            write_id: None,
            tag: None,
            kind: "anchor".into(),
            object_key: "anchor:5:3".into(),
            bell: Some(5),
            region: Some(3),
            class: "D".into(),
            payer: "P".into(),
            bid_milli: 100,
            fee: 5_000,
            cu_limit: 345_000,
            heap: None,
            first_valid_slot: 10,
            sent_slot: 10,
            last_valid_block_height: None,
            landed_slot: None,
            status: "sent".into(),
            code: None,
        }
    }

    #[test]
    fn restart_rejects_invalid_journal_signature_before_status_lookup() {
        let valid = recovery_attempt(Signature::default().to_string());
        let invalid = recovery_attempt("not a signature".into());
        assert!(recovery_signatures(&[valid, invalid]).is_err());
    }

    #[test]
    fn restart_rejects_incomplete_or_excess_status_reply_before_reconciliation() {
        let attempts = [recovery_attempt(Signature::default().to_string())];
        assert!(recovery_statuses(&attempts, vec![]).is_err());
        assert!(recovery_statuses(&attempts, vec![None, None]).is_err());
        let pairs: Vec<_> = recovery_statuses(&attempts, vec![None]).unwrap().collect();
        assert_eq!(pairs.len(), 1);
        assert_eq!(pairs[0].0.sig, attempts[0].sig);
    }

    #[tokio::test]
    async fn restart_accounts_for_an_attempt_that_landed_before_adoption() {
        let program = Address::new_from_array([0x5f; 32]);
        let cfg = KeeperConfig::new(program, 7, Address::new_from_array([0xbe; 32]));
        let journal = Journal::open(std::path::Path::new(":memory:")).unwrap();
        let sig = Signature::default();
        let attempt = recovery_attempt(sig.to_string());
        journal.record_attempt(&attempt).unwrap();
        let port = crate::testkit::FakePort::default();
        port.set_clock(12, 1_000);
        port.statuses.lock().unwrap().insert(
            sig,
            Status {
                slot: 11,
                err: Some("AlreadyDone".into()),
                code: Some(52),
            },
        );
        let mut k = Keeper::new(
            cfg,
            port,
            crate::testkit::FakeDrand::new(),
            &[1; 32],
            Some(journal),
        )
        .unwrap();
        assert_eq!(k.start().await.unwrap(), 0);
        assert_eq!(k.engine.stats["anchor"].fees_charged, attempt.fee);
        assert!(k.journal.as_ref().unwrap().in_flight().unwrap().is_empty());
        // Re-reading startup cannot charge the settled journal row again.
        assert_eq!(k.start().await.unwrap(), 0);
        assert_eq!(k.engine.stats["anchor"].fees_charged, attempt.fee);
    }

    #[tokio::test]
    async fn restart_records_tag_specific_already_done_as_done_without_replaying_duty() {
        let program = Address::new_from_array([0x5f; 32]);
        let cfg = KeeperConfig::new(program, 7, Address::new_from_array([0xbe; 32]));
        let journal = Journal::open(std::path::Path::new(":memory:")).unwrap();
        let sig = Signature::from([4u8; 64]);
        let mut attempt = recovery_attempt(sig.to_string());
        attempt.write_id = Some(sig.to_string());
        attempt.tag = Some(tag::POST_ANCHOR);
        journal.record_attempt(&attempt).unwrap();
        let port = crate::testkit::FakePort::default();
        port.set_clock(12, 1_000);
        port.statuses.lock().unwrap().insert(
            sig,
            Status {
                slot: 11,
                err: Some("AlreadyDone".into()),
                code: Some(abi::err::ALREADY_DONE),
            },
        );
        let mut keeper = Keeper::new(
            cfg,
            port,
            crate::testkit::FakeDrand::new(),
            &[1; 32],
            Some(journal),
        )
        .unwrap();
        assert_eq!(keeper.start().await.unwrap(), 0);
        let recovered = keeper
            .journal
            .as_ref()
            .unwrap()
            .attempts_of("anchor:5:3")
            .unwrap();
        assert_eq!(recovered[0].status, "done");
        assert_eq!(keeper.engine.stats["anchor"].fees_charged, attempt.fee);
        assert_eq!(keeper.engine.stats["anchor"].landed, 0);
    }

    #[tokio::test]
    async fn restart_holds_unknown_signature_when_sibling_already_settled() {
        let program = Address::new_from_array([0x5f; 32]);
        let cfg = KeeperConfig::new(program, 7, Address::new_from_array([0xbe; 32]));
        let journal = Journal::open(std::path::Path::new(":memory:")).unwrap();
        let mut failed = recovery_attempt(Signature::default().to_string());
        failed.status = "failed".into();
        let sig = Signature::from([2u8; 64]);
        let mut unknown = recovery_attempt(sig.to_string());
        unknown.payer = Address::new_from_array([1; 32]).to_string();
        journal.record_attempt(&failed).unwrap();
        journal.record_attempt(&unknown).unwrap();
        let port = crate::testkit::FakePort::default();
        port.set_clock(12, 1_000);
        let mut keeper = Keeper::new(
            cfg,
            port,
            crate::testkit::FakeDrand::new(),
            &[1; 32],
            Some(journal),
        )
        .unwrap();
        assert_eq!(keeper.start().await.unwrap(), 1);
        let make_spec = |key: &str| WriteSpec {
            key: key.into(),
            kind: "anchor",
            tag: tag::POST_ANCHOR,
            class: Class::D,
            bell: Some(5),
            region: Some(3),
            build: Arc::new(|_| vec![]),
            deadline_slot: None,
            not_before_slot: 0,
            fixed_payer: None,
        };
        assert!(!keeper.engine.ensure(make_spec("anchor:5:3"), 12));
        assert!(keeper.engine.ensure(make_spec("anchor:5:4"), 12));
        keeper.port.statuses.lock().unwrap().insert(
            sig,
            Status {
                slot: 13,
                err: Some("rejected".into()),
                code: Some(8),
            },
        );
        keeper
            .engine
            .poll(&keeper.port, keeper.journal.as_ref(), 13)
            .await;
        assert!(keeper.engine.ensure(make_spec("anchor:5:3"), 14));
        assert!(keeper
            .journal
            .as_ref()
            .unwrap()
            .in_flight()
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn restart_holds_even_a_single_unknown_signature_until_chain_reconciliation() {
        let program = Address::new_from_array([0x5f; 32]);
        let cfg = KeeperConfig::new(program, 7, Address::new_from_array([0xbe; 32]));
        let journal = Journal::open(std::path::Path::new(":memory:")).unwrap();
        let sig = Signature::from([3u8; 64]);
        let mut unknown = recovery_attempt(sig.to_string());
        unknown.write_id = Some(sig.to_string());
        unknown.payer = Address::new_from_array([1; 32]).to_string();
        journal.record_attempt(&unknown).unwrap();
        let port = crate::testkit::FakePort::default();
        port.set_clock(200, 1_000);
        let mut keeper = Keeper::new(
            cfg,
            port,
            crate::testkit::FakeDrand::new(),
            &[1; 32],
            Some(journal),
        )
        .unwrap();
        assert_eq!(keeper.start().await.unwrap(), 1);
        let spec = || WriteSpec {
            key: "anchor:5:3".into(),
            kind: "anchor",
            tag: tag::POST_ANCHOR,
            class: Class::D,
            bell: Some(5),
            region: Some(3),
            build: Arc::new(|_| vec![]),
            deadline_slot: None,
            not_before_slot: 0,
            fixed_payer: None,
        };
        assert!(!keeper.engine.ensure(spec(), 200));
        keeper.port.statuses.lock().unwrap().insert(
            sig,
            Status {
                slot: 201,
                err: None,
                code: None,
            },
        );
        let report = keeper
            .engine
            .poll(&keeper.port, keeper.journal.as_ref(), 202)
            .await;
        assert!(
            report.outcomes.is_empty(),
            "a recovered signature is observation only"
        );
        assert!(keeper.engine.ensure(spec(), 203));
        let attempts = keeper
            .journal
            .as_ref()
            .unwrap()
            .attempts_of("anchor:5:3")
            .unwrap();
        assert_eq!(
            attempts[0].write_id.as_deref(),
            Some(sig.to_string().as_str())
        );
        assert_eq!(attempts[0].status, "landed");
    }

    #[tokio::test]
    async fn restart_adopts_old_unknown_attempt_and_later_counts_its_fee_once() {
        let program = Address::new_from_array([0x5f; 32]);
        let cfg = KeeperConfig::new(program, 7, Address::new_from_array([0xbe; 32]));
        let journal = Journal::open(std::path::Path::new(":memory:")).unwrap();
        let sig = Signature::default();
        let mut attempt = recovery_attempt(sig.to_string());
        attempt.payer = Address::new_from_array([1; 32]).to_string();
        journal.record_attempt(&attempt).unwrap();
        let port = crate::testkit::FakePort::default();
        let late = attempt.first_valid_slot + crate::engine::EXPIRY_SLOTS + 1;
        port.set_clock(late, 1_000);
        let mut keeper = Keeper::new(
            cfg,
            port,
            crate::testkit::FakeDrand::new(),
            &[1; 32],
            Some(journal),
        )
        .unwrap();

        assert_eq!(keeper.start().await.unwrap(), 1);
        assert_eq!(
            keeper.journal.as_ref().unwrap().in_flight().unwrap().len(),
            1
        );
        assert_eq!(
            keeper.engine.stats.get("anchor").map(|s| s.fees_charged),
            None
        );
        keeper.port.statuses.lock().unwrap().insert(
            sig,
            Status {
                slot: late,
                err: None,
                code: None,
            },
        );
        keeper
            .engine
            .poll(&keeper.port, keeper.journal.as_ref(), late + 1)
            .await;
        keeper
            .engine
            .poll(&keeper.port, keeper.journal.as_ref(), late + 2)
            .await;
        assert!(keeper
            .journal
            .as_ref()
            .unwrap()
            .in_flight()
            .unwrap()
            .is_empty());
        assert_eq!(keeper.engine.stats["anchor"].fees_charged, attempt.fee);
    }

    #[tokio::test]
    async fn restart_keeps_unknown_care_and_blocks_a_new_plan_after_151_slots() {
        let program = Address::new_from_array([0x5f; 32]);
        let mut cfg = KeeperConfig::new(program, 7, Address::new_from_array([0xbe; 32]));
        cfg.roles.clear();
        let journal = Journal::open(std::path::Path::new(":memory:")).unwrap();
        let mut attempt = recovery_attempt(Signature::default().to_string());
        attempt.kind = PAYER_CARE_KIND.into();
        attempt.object_key = "care:old:transfer:1".into();
        attempt.payer = Address::new_from_array([1; 32]).to_string();
        journal.record_attempt(&attempt).unwrap();
        let port = crate::testkit::FakePort::default();
        port.set_clock(200, 1_000);
        let mut k = Keeper::new(
            cfg,
            port,
            crate::testkit::FakeDrand::new(),
            &[1; 32],
            Some(journal),
        )
        .unwrap();
        assert_eq!(k.start().await.unwrap(), 1);
        assert!(k.engine.care_unresolved());
        k.tick().await.unwrap();
        assert!(
            k.care_last.is_none(),
            "adopted unknown care prevents a new plan"
        );
        assert!(k.port.sent.lock().unwrap().is_empty());
        assert_eq!(k.journal.as_ref().unwrap().in_flight().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn legacy_expired_care_requires_finalized_reconciliation() {
        let program = Address::new_from_array([0x5f; 32]);
        let mut cfg = KeeperConfig::new(program, 7, Address::new_from_array([0xbe; 32]));
        cfg.roles.clear();
        let journal = Journal::open(std::path::Path::new(":memory:")).unwrap();
        let sig = Signature::default();
        let mut attempt = recovery_attempt(sig.to_string());
        attempt.kind = PAYER_CARE_KIND.into();
        attempt.object_key = "care:old:transfer:1".into();
        attempt.status = "expired".into();
        journal.record_attempt(&attempt).unwrap();
        let port = crate::testkit::FakePort::default();
        port.set_clock(200, 1_000);
        let mut k = Keeper::new(
            cfg,
            port,
            crate::testkit::FakeDrand::new(),
            &[1; 32],
            Some(journal),
        )
        .unwrap();
        k.start().await.unwrap();
        assert!(k.care_legacy_unknown);
        k.tick().await.unwrap();
        assert!(k.care_last.is_none());
        assert!(k
            .journal
            .as_ref()
            .unwrap()
            .has_expired_attempt(PAYER_CARE_KIND)
            .unwrap());

        // A later finalized result can reconcile the old row. The next
        // balance read must include the transfer's actual landing slot.
        k.port.statuses.lock().unwrap().insert(
            sig,
            Status {
                slot: 199,
                err: None,
                code: None,
            },
        );
        k.start().await.unwrap();
        assert!(!k.care_legacy_unknown);
        assert!(!k
            .journal
            .as_ref()
            .unwrap()
            .has_expired_attempt(PAYER_CARE_KIND)
            .unwrap());
        assert_eq!(k.engine.care_settled_slot(), Some(199));
        assert_eq!(k.port.min_context_slots.lock().unwrap().last(), Some(&199));
    }

    #[tokio::test]
    async fn finalized_failed_care_requires_fresh_fee_balance_at_restart() {
        use std::sync::atomic::Ordering;

        let program = Address::new_from_array([0x5f; 32]);
        let cfg = KeeperConfig::new(program, 7, Address::new_from_array([0xbe; 32]));
        let journal = Journal::open(std::path::Path::new(":memory:")).unwrap();
        let sig = Signature::default();
        let mut attempt = recovery_attempt(sig.to_string());
        attempt.kind = PAYER_CARE_KIND.into();
        attempt.object_key = "care:old:transfer:1".into();
        journal.record_attempt(&attempt).unwrap();
        let port = crate::testkit::FakePort::default();
        port.set_clock(101, 1_000);
        port.max_context_slot.store(94, Ordering::SeqCst);
        port.statuses.lock().unwrap().insert(
            sig,
            Status {
                slot: 95,
                err: Some("insufficient funds".into()),
                code: None,
            },
        );
        let mut k = Keeper::new(
            cfg,
            port,
            crate::testkit::FakeDrand::new(),
            &[1; 32],
            Some(journal),
        )
        .unwrap();
        assert!(k
            .start()
            .await
            .unwrap_err()
            .contains("account context too old"));
        assert_eq!(k.engine.care_settled_slot(), Some(95));
        k.port.max_context_slot.store(101, Ordering::SeqCst);
        assert_eq!(k.start().await.unwrap(), 0);
        assert_eq!(k.port.min_context_slots.lock().unwrap().last(), Some(&95));
        assert_eq!(
            k.journal
                .as_ref()
                .unwrap()
                .latest_settled_slot(PAYER_CARE_KIND)
                .unwrap(),
            Some(95)
        );
    }

    /// W6-C (W5-B F1): payer care runs on a game-time cadence as well as a
    /// slot one, at once (after a block) when a pool is below its minimum
    /// and the last care planned top-ups, and never over pending transfers.
    #[test]
    fn payer_care_cadence_follows_game_time_and_low_pools() {
        let c = KeeperConfig::new(
            Address::new_from_array([1; 32]),
            1,
            Address::new_from_array([2; 32]),
        );
        assert_eq!((c.care_every_slots, c.care_every_game_secs), (150, 300));
        assert!(care_due(&c, None, 10, 1_000, false, false), "first tick");
        assert!(
            !care_due(&c, None, 10, 1_000, true, true),
            "never over pending care"
        );
        let last = Some((10, 1_000, 0));
        // At 100× a slot is 40 game s: 300 game s pass after 8 slots, long
        // before 150 slots (the old cadence: 10 bells).
        assert!(!care_due(&c, last, 17, 1_280, false, false));
        assert!(care_due(&c, last, 18, 1_320, false, false));
        // At 1× (0.4 game s a slot) the slot cadence comes first.
        assert!(!care_due(&c, last, 159, 1_060, false, false));
        assert!(care_due(&c, last, 160, 1_060, false, false));
        // A low pool: at once after a care that planned top-ups, but not
        // when the last care found nothing to fund.
        let topped = Some((10, 1_000, 150));
        assert!(!care_due(&c, topped, 11, 1_040, true, false));
        assert!(care_due(&c, topped, 12, 1_080, true, false));
        assert!(!care_due(&c, last, 12, 1_080, true, false));
        assert!(!care_due(&c, topped, 12, 1_080, true, true));
    }

    #[test]
    fn escalation_by_class() {
        assert_eq!(bid_milli(Class::W, 433, 0, 2_000), 433);
        assert_eq!(bid_milli(Class::W, 433, 1, 2_000), 866);
        assert_eq!(bid_milli(Class::W, 433, 3, 2_000), 2_000);
        assert_eq!(bid_milli(Class::W, 433, 9, 1_500), 1_500, "season cap");
        assert_eq!(bid_milli(Class::D, 433, 2, 2_000), 500);
        assert_eq!(bid_milli(Class::N, 433, 9, 2_000), P_LOW_MILLI);
    }

    #[test]
    fn quantiles_and_classes_of_the_w2f_writes() {
        assert_eq!(quantile(&[], 0.99), None);
        assert_eq!(quantile(&[3, 1, 2], 0.5), Some(2));
        assert_eq!(quantile(&(1..=100).collect::<Vec<u64>>(), 0.99), Some(99));
        // §5.5 / I-21: every keeper write of this unit is D except the
        // beacon log and the cache close (N).
        for t in W2F_TAGS {
            let c = abi::ix_info(t).unwrap().class;
            let want = if t == tag::POST_BEACON || t == tag::CLOSE_SEED_CACHE {
                Class::N
            } else {
                Class::D
            };
            assert_eq!(c, want, "tag {t:#x}");
        }
    }

    #[test]
    fn land_writes_have_their_contract_class_and_a_budget() {
        let b = Budgets::from_json(&serde_json::from_str(CANONICAL_BUDGETS).unwrap()).unwrap();
        for (t, class) in W3C_TAGS {
            assert_eq!(abi::ix_info(t).unwrap().class, class, "tag {t:#x}");
            let x = b.get(t);
            assert!(x.cu_limit > 0 && x.loaded_limit >= fees::PAGE, "tag {t:#x}");
        }
        assert_eq!(role_of_key("ticket:x:5:0"), Some("tickets"));
        assert_eq!(role_of_key("stranded:2,0:9"), Some("dormancy"));
        assert_eq!(role_of_key("anchor:1:2"), None);
    }

    /// R-22 (MC §5.1, §5.4): the keeper's budgets follow the season's
    /// ABI. An MC season (program_version 3) takes the v2 table (`L(kind)`
    /// for the new kinds), an M1 season keeps v1's; the status carries the
    /// `conquest` block and `/metrics` the `fk_` lines (§8.2).
    #[tokio::test]
    async fn cq_keeper_follows_the_season_abi() {
        use fclient::abi::layout::{h, season as ls};
        let program = Address::new_from_array([0x5F; 32]);
        let mut cfg = KeeperConfig::new(program, 7, Address::new_from_array([0xBE; 32]));
        cfg.roles = vec![];
        let port = crate::testkit::FakePort::default();
        let mut k =
            Keeper::new(cfg, port, crate::testkit::FakeDrand::new(), &[1; 32], None).unwrap();
        let season_bytes = |version: u16| {
            let mut d = vec![0u8; fclient::abi::size::SEASON];
            crate::testkit::put(&mut d, 0, fclient::abi::magic::SEASON);
            let layout = if version >= abi::PROGRAM_VERSION_V2 {
                abi::LAYOUT_VERSION_V2
            } else {
                1
            };
            crate::testkit::put(&mut d, h::LAYOUT_VERSION, &layout.to_le_bytes());
            d[ls::STATUS] = status::SEEDED;
            crate::testkit::put(&mut d, ls::PROGRAM_VERSION, &version.to_le_bytes());
            crate::testkit::put(&mut d, ls::END_BELL, &1_008u32.to_le_bytes());
            let cq = frontier_abi::v2::presets::MC_TEST.cq.to_bytes();
            let o = frontier_abi::v2::presets::SEASON_CQ_OFFSET;
            d[o..o + cq.len()].copy_from_slice(&cq);
            d
        };
        let v1_fold = k.engine.budgets.get(tag::FOLD_MARCH);
        k.port.put(
            k.addrs.season,
            crate::testkit::acct(program, season_bytes(abi::PROGRAM_VERSION_V2)),
        );
        k.port.set_clock(5, 1_000);
        k.tick().await.unwrap();
        assert!(k.season.as_ref().unwrap().is_v2());
        let v2 = Budgets::canonical_v2();
        assert_eq!(
            k.engine.budgets.get(tag::FOLD_MARCH),
            v2.get(tag::FOLD_MARCH)
        );
        assert_ne!(k.engine.budgets.get(tag::FOLD_MARCH), v1_fold);
        // L(kind) from the v2 table (the placeholder `.so` length moves with
        // the measured release `.so`: integ-W2 A-33), never a literal.
        assert_eq!(
            k.engine.budgets.get(tag::FOLD_MARCH).loaded_limit,
            frontier_abi::v2::budgets::loaded_limit(frontier_abi::v2::tags::Ix::FoldMarch)
        );
        assert_eq!(k.engine.budgets.get(tag::HARVEST), v2.get(tag::HARVEST));
        assert_eq!(k.engine.budgets.get(0).cu_limit, 2_000, "payer care kept");
        let st = k.shared.lock().unwrap().status.clone();
        for f in [
            "sieges_active",
            "keeps_contested",
            "occupations",
            "settle_pending",
            "fold_lag_hours_p99",
            "horns_last_bell",
        ] {
            assert!(st["conquest"].get(f).is_some(), "status conquest.{f}");
        }
        let m = k.shared.lock().unwrap().metrics.clone();
        assert!(m.contains("fk_capture_settle_pending 0"), "{m}");
        // An S1 season takes S1's table (its loaded limits), not MC's: with
        // MC's, ConsumeGenesisSeed exceeds its loaded-data limit.
        k.port.put(
            k.addrs.season,
            crate::testkit::acct(program, season_bytes(abi::PROGRAM_VERSION_S1)),
        );
        // (the keeper re-reads a running Season every 16 slots)
        k.port.set_clock(22, 1_500);
        k.tick().await.unwrap();
        assert_eq!(k.engine.budgets, {
            let mut b = Budgets::canonical_s1();
            b.set(0, k.engine.budgets.get(0));
            b
        });
        assert_ne!(Budgets::canonical_s1(), v2, "the tables differ");
        // An M1 season (another run of the same keeper) goes back to v1's.
        k.port.put(
            k.addrs.season,
            crate::testkit::acct(program, season_bytes(1)),
        );
        k.port.set_clock(40, 2_000);
        k.tick().await.unwrap();
        assert!(!k.season.as_ref().unwrap().is_v2());
        assert_eq!(k.engine.budgets, {
            let mut b = Budgets::canonical();
            b.set(0, k.engine.budgets.get(0));
            b
        });
    }

    #[test]
    fn play_writes_have_their_contract_class_and_a_budget() {
        let b = Budgets::from_json(&serde_json::from_str(CANONICAL_BUDGETS).unwrap()).unwrap();
        for (t, class) in W4C_TAGS {
            assert_eq!(abi::ix_info(t).unwrap().class, class, "tag {t:#x}");
            let x = b.get(t);
            assert!(x.cu_limit > 0 && x.loaded_limit >= fees::PAGE, "tag {t:#x}");
        }
        for (k, role) in [
            ("reveal:1:2", "reveal"),
            ("sdep:1:2:3,4", "settle-departure"),
            ("return:1,2,3:3,4", "settle-departure"),
            ("gather:3,4:9:0", "gather"),
            ("resolve:3,4:9", "resolve"),
            ("skip:3,4:9:24", "skip"),
            ("ff:3,4:9:300", "skip"),
            ("settle:1:2", "settle"),
            ("close:slot:3,4:9:0:1", "close"),
            ("claim:0:x", "claims"),
        ] {
            assert_eq!(role_of_key(k), Some(role), "{k}");
            assert!(PLAY_ROLES.contains(&role));
        }
    }
}
