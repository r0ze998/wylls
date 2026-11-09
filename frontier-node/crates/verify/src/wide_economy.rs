//! **Experimental, opt-in** (`wide-economy-experimental`): the independent
//! replay of **one** wide S1 owner action — Harvest, Build or Train over a
//! wide holding — from the record the experimental handler logs (the wide
//! event kinds 15 `Economy` and 16 `EconomyMirror`,
//! `frontier_abi::world_index::{economy, event}`) and the account snapshots
//! a caller supplies for before and after it.
//!
//! [`verify_transition`] answers one question and no other: *given these
//! Season bytes, these three snapshots before and these three after, is
//! this record the one the S1 rules produce, and does it chain the
//! accounts it names?* It is a **state-transition and receipt / chain
//! check over caller-supplied snapshots**. It does **not** prove, and no
//! caller may read a PASS as proving:
//!
//! * who acted: no actor signature, session key, NFT resident proof or
//!   holder generation is seen (the record carries none);
//! * that the Citizen named by the holding's `owner_citizen` is the Citizen
//!   whose bytes were supplied, or that any account sat at its canonical
//!   address under the program (no Season PDA, program id or address
//!   derivation is involved; the Citizen's binding check is the generic
//!   wide slot marker, which names no coordinate). The Citizen's short
//!   header — the Citizen magic and the Season's id — **is** checked, as
//!   the program's player prologue checks it (`prologue::check_present`),
//!   but that is a codec check of the bytes, not a proof of which account
//!   or whose they are;
//! * where the snapshots came from, that they were the chain's state at
//!   the record's slot, or what clock the handler read (`now_ts` is the
//!   receipt's own claim, checked only for consistency with the Season);
//! * anything about the transitions before or after this one, the
//!   Citizen's complete history, or the Season as a whole:
//!   [`FULL_SEASON_REPLAY_SUPPORTED`] is `false`, and this module is not a
//!   check of [`crate::verify`].
//!
//! It **fails closed**: any other record kind, a malformed or mismatched
//! snapshot, a Season that is not the exact wide S1 build, not Running at
//! `now_ts`, not on the S1 ruleset or past its end bell, a record bell that
//! is not the Season's bell at `now_ts`, a receipt whose digests do not
//! recompute, a flip the rules do not produce (or fail to produce), a link
//! that does not continue the pre-state header, a post-state that differs
//! from the independent replay in **any** byte (an unaffected field such as
//! the shield, the trailer, the Citizen's flags or a non-mirror province's
//! header included), a holding whose stored numbers the replay's
//! arithmetic cannot represent (the preflight below), or trailing /
//! missing bytes anywhere is a refusal.
//!
//! **Order of judgement in [`verify_transition`].** The record is decoded
//! and its **input digest** is recomputed over the raw supplied pre-state
//! first; only a record whose receipt commits to exactly these bytes
//! reaches the staging. A corrupted pre-state snapshot is therefore
//! refused by the receipt, never fed to the replay. [`stage`] is public
//! and guards itself too: before the kernel replay it runs the numeric
//! preflight over the holding it is about to replay.
//!
//! ## What is structural and what is independent arithmetic
//!
//! | step | kind | source |
//! |---|---|---|
//! | record body, kind, key, receipt, tail shape | structural | the ABI codec (`event::WideRecord::decode`, `economy::EconomyReceipt`) — the record's own format |
//! | Season size, magic, effective status, ruleset hash, program version, end bell | structural | field reads against the ABI layout and the pinned constants `RULESET_HASH_V3`, `PROGRAM_VERSION_S1`, `WIDE_EXPERIMENTAL_VERSION_BIT` |
//! | bell of `now_ts` | **independent** | [`bell_at`]: `⌊(now − genesis) / 600⌋`, checked |
//! | snapshot shapes and identity (holding ↔ key, province ↔ holding, Citizen size) | structural | `economy::check_snapshots` (the digests' own validation), `WideHolding::read`, `WideProvince::read` |
//! | Citizen short header (magic `PSF1CITZ`, `season_id` = the Season's) | structural | `layout::read_short_header` against `citizen::MAGIC` and the Season read — what the program's `check_present(Citizen)` requires; no `layout_version` requirement, as the program makes none |
//! | Citizen slot bound wide, holding `order` = slot, live state, mirror shows the holding, no capture lock | **independent** (transcribed) | this module, over the layout offsets |
//! | lazy finality (`became_final`) | **independent** (transcribed) | [`finality_due`]: state provisional, `now ≥ final_ts`, [`cohort_closed`] (no Citizen flag: a wide holding is never a first home) |
//! | Citizen bucket and `last_action_ts` | **independent** (transcribed) | [`debit_bucket`]: the §5.6 step-3 arithmetic re-stated here; every other Citizen byte (its own PS2 header included) must be unchanged |
//! | numeric preflight of the holding (terrain ore × tier bonus, the dormancy instants, the settle differences, the store fractions) | **independent** | [`preflight_holding`]: the kernel's own unchecked products and sums re-stated checked over the holding the replay is about to read; a representability guard, not a rule |
//! | the holding's economy (settle, touch, cost, copy number, intro timing, pay, enqueue, reserve, dormancy cache) | **independent** | [`crate::holding::replay`] under [`Rules::S1`], the verifier's existing transcription of the deployed handlers — never the program's preview, never its implementation |
//! | the walls mirror item | **independent** | [`crate::holding::wall_item`] |
//! | the tier-up mirror item | **independent** (transcribed) | this module: `tier` = the replayed post tier, `tier_next = tier + 1`, `tier_next_bell = bell_at(done_at) + 1` |
//! | every unaffected byte | **independent** | the whole expected post-state is compared with the supplied one byte for byte |
//! | links (`seq + 1`, chained head) | structural | `event::advance` from the pre-state headers — the chain rule's definition |
//! | input / output digests | structural | `economy::input_digest` / `economy::output_digest` — the receipt's definition, over the raw pre-state (judged **before** the staging) and the **expected** post-state (judged last) |
//!
//! **The numeric preflight** ([`preflight_holding`]) refuses, before the
//! kernel sees the holding, exactly the stored numbers the existing replay
//! arithmetic would not represent: `terrain_ore.max(0) × (100 + bonus%)`
//! for each of the four tiers (`arms::base_production`'s product, taken
//! before its `/ 100`; all four tiers is the conservative replay-range
//! form, not an ore cap), `last_owner_action + DORMANT_AFTER` and `now +
//! DORMANT_AFTER` (the kernel's `dormant_at` at the pre-state and after
//! the touch), `now − t0` for each store settled forward (`Accrual::settle`
//! subtracts in `i64` before widening; no intermediate settle instant
//! exceeds `now`, so the largest difference is the one checked), and the
//! canonical store fraction `0 ≤ frac < HOUR` (the kernel's carried
//! remainder; a fraction outside it makes the workshop dry-time arithmetic
//! non-monotonic). It adds no cost, cap or clamp, changes no normal
//! output, and claims nothing about other malformed numeric states.
//!
//! **The layout-version adapter.** The existing replay's `write` rewrites
//! `SHIELD_UNTIL` from M1's constants unless the header's `layout_version`
//! is 2; a wide holding carries 3. The replay therefore runs over a scratch
//! copy whose two `layout_version` bytes are set to 2 and restored after
//! it — those two bytes and nothing else, so no other write the replay
//! might make to the header, the shield or the trailer is hidden; the
//! whole-byte comparison then catches any such write. The wide prefix `P`,
//! `Q` (zero) and the trailer are never touched.

use core::fmt;

use frontier_abi::bytes::{
    rd_arr, rd_i64, rd_u16, rd_u32, rd_u64, rd_u8, wr_arr, wr_i64, wr_u32, wr_u64, wr_u8,
};
use frontier_abi::layout::header as HDR;
use frontier_abi::layout::province::{cohort as CO, province as PV, site as SM};
use frontier_abi::layout::read_short_header;
use frontier_abi::layout::world::season as S;
use frontier_abi::v2::layout::player::{citizen as C2, holding as H2};
use frontier_abi::v2::layout::province::site as SM2;
use frontier_abi::v2::presets::{PROGRAM_VERSION_S1, RULESET_HASH_V3};
use frontier_abi::world_index::economy::{self, Action, EconomyReceipt, Snapshots};
use frontier_abi::world_index::event::{self, WideEntity, WideKind, WideLink, WideRecord};
use frontier_abi::world_index::holding::{
    binding_of, wide_holding as WH, SlotBinding, WideHolding,
};
use frontier_abi::world_index::land::{province as WP, WideProvince, WIDE_LAYOUT_VERSION};
use frontier_abi::world_index::wide_ix::WIDE_EXPERIMENTAL_VERSION_BIT;
use frontier_abi::world_index::{ProvinceKey, WideHostRef};
use permutation_rules::frontier::catalog;
use permutation_rules::frontier::holding::{Holding as KHolding, Tier, DORMANT_AFTER, HOUR};

use crate::holding::{self as hold, Rules};

/// The `program_version` of the experimental wide S1 build
/// (`WIDE_EXPERIMENTAL_VERSION_BIT | PROGRAM_VERSION_S1`).
pub const WIDE_S1_PROGRAM_VERSION: u16 = WIDE_EXPERIMENTAL_VERSION_BIT | PROGRAM_VERSION_S1;
/// The NFT build's staging bit (`wide_ix` module doc: disjoint from the
/// wide bit; both together name a build with both features). The only
/// other version accepted: [`WIDE_S1_PROGRAM_VERSION`] with this bit.
pub const NFT_VERSION_BIT: u16 = 0x8000;
/// Seconds per bell (§5.1).
pub const BELL_SECS: i64 = 600;
/// Whole-Season replay of the wide economy is **not** supported by this
/// module or any other; a verdict here is about one transition.
pub const FULL_SEASON_REPLAY_SUPPORTED: bool = false;
/// What a passing [`verify_transition`] does **not** establish (module doc).
pub const NOT_PROVEN: &[&str] = &[
    "the actor's signature, session or NFT resident authorisation",
    "the canonical addresses of the accounts and their program owner",
    "that the supplied Citizen is the holding's owner_citizen account",
    "the provenance or freshness of the snapshots against the chain",
    "the clock source of now_ts",
    "the transitions before or after this one",
    "the Citizen's complete history",
    "the Season as a whole (no full-season replay exists)",
];

/// Why a transition is refused. Every variant carries a human-readable
/// detail; the variant names the check that failed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Refusal {
    /// The record body: not a wide record, not an economy kind, a bell
    /// that is not the Season's at `now_ts`, a tail that does not fit.
    Record(String),
    /// The Season bytes: size, magic, status, ruleset, version, end bell.
    Season(String),
    /// A snapshot's shape or identity (the ABI's own validation).
    Snapshot(String),
    /// The holding's state: not live, a capture pending, `order` ≠ slot.
    State(String),
    /// The Citizen: not the Citizen magic, not this Season's, slot not
    /// bound wide, bucket empty, time overflow.
    Citizen(String),
    /// The holding's economy: the replay refused the action, or the
    /// supplied post-state differs from the replayed one.
    Holding(String),
    /// The province: the mirror does not show the holding, the wall queue
    /// is full, a mirror bell overflows, or the supplied post-state differs.
    Province(String),
    /// A link does not continue the pre-state header.
    Chain(String),
    /// A receipt digest does not recompute.
    Digest(String),
    /// The lazy flip the receipt claims is not the one the rules give.
    Finality(String),
}

impl fmt::Display for Refusal {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let (what, d) = match self {
            Refusal::Record(d) => ("record", d),
            Refusal::Season(d) => ("season", d),
            Refusal::Snapshot(d) => ("snapshot", d),
            Refusal::State(d) => ("state", d),
            Refusal::Citizen(d) => ("citizen", d),
            Refusal::Holding(d) => ("holding", d),
            Refusal::Province(d) => ("province", d),
            Refusal::Chain(d) => ("chain", d),
            Refusal::Digest(d) => ("digest", d),
            Refusal::Finality(d) => ("finality", d),
        };
        write!(f, "wide economy {what}: {d}")
    }
}

impl std::error::Error for Refusal {}

/// The Season fields the transition needs, read structurally
/// ([`read_season`]).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SeasonFacts {
    pub season_id: u64,
    pub genesis_ts: i64,
    pub end_bell: u32,
    pub program_version: u16,
    pub bucket_rate_per_h: u16,
    pub bucket_burst: u16,
    /// `bell_at(genesis_ts, now_ts)`.
    pub now_bell: u32,
}

/// The expected post-states of one record over the pre-state snapshots
/// ([`stage`]): the independent replay's output **before** the record's
/// links are written into the chained headers (the holding's and, for a
/// mirror write, the province's header still carry the pre-state chain).
/// A scratch image for comparison and digesting; never anything to apply.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Staged {
    pub kind: WideKind,
    pub action: Action,
    pub holding_ref: WideHostRef,
    /// The holding's own province (the record's attribution).
    pub province_key: ProvinceKey,
    pub now_ts: i64,
    pub bell: u32,
    pub became_final: bool,
    pub season: SeasonFacts,
    pub citizen: Vec<u8>,
    pub holding: Vec<u8>,
    pub province: Vec<u8>,
    /// The Citizen's bucket after the debit (milli-tokens).
    pub bucket_left: u32,
}

/// A verified transition: what the record says and what was recomputed.
/// It is **not** a season verdict ([`FULL_SEASON_REPLAY_SUPPORTED`],
/// [`NOT_PROVEN`]).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Verified {
    pub kind: WideKind,
    pub action: Action,
    pub holding_ref: WideHostRef,
    pub province_key: ProvinceKey,
    pub now_ts: i64,
    pub bell: u32,
    pub became_final: bool,
    pub holding_link: WideLink,
    /// The province's link: `Some` exactly for an `EconomyMirror`.
    pub province_link: Option<WideLink>,
    pub bucket_left: u32,
}

impl Verified {
    /// Always `false`: one transition over supplied snapshots proves no
    /// Season.
    pub const fn full_season(&self) -> bool {
        FULL_SEASON_REPLAY_SUPPORTED
    }

    /// [`NOT_PROVEN`].
    pub const fn not_proven(&self) -> &'static [&'static str] {
        NOT_PROVEN
    }
}

// ------------------------------------------------------------ independent arithmetic

/// `⌊(t − genesis_ts) / 600⌋` for `t ≥ genesis_ts`, `None` otherwise or on
/// overflow (an independent statement of §5.1).
pub fn bell_at(genesis_ts: i64, t: i64) -> Option<u32> {
    let dt = t.checked_sub(genesis_ts)?;
    if dt < 0 {
        return None;
    }
    u32::try_from(dt / BELL_SECS).ok()
}

/// The §5.6 step-3 bucket debit, transcribed: `t = max(now − genesis, 0)`
/// (checked), `dt = max(t − bucket_t, 0)`, `refill = rate × 1,000 × dt /
/// 3,600` (saturating, integer), `have = min(milli + refill, burst ×
/// 1,000)`, `left = have − 1,000` (else the bucket refuses), `bucket_t =
/// t` as `u32` (checked). Writes `BUCKET_MILLI` and `BUCKET_T`, nothing
/// else; returns `left`.
pub fn debit_bucket(
    citizen: &mut [u8],
    now: i64,
    genesis_ts: i64,
    rate_per_h: u16,
    burst: u16,
) -> Result<u32, Refusal> {
    let short = || Refusal::Citizen("citizen bytes too short for the bucket".into());
    let milli = rd_u32(citizen, C2::BUCKET_MILLI).ok_or_else(short)? as u64;
    let t0 = rd_u32(citizen, C2::BUCKET_T).ok_or_else(short)? as i64;
    let t = now
        .checked_sub(genesis_ts)
        .ok_or_else(|| Refusal::Citizen("now − genesis overflows".into()))?
        .max(0);
    let dt = (t - t0).max(0) as u64;
    let cap = burst as u64 * 1_000;
    let refill = (rate_per_h as u64).saturating_mul(1_000).saturating_mul(dt) / 3_600;
    let have = milli.saturating_add(refill).min(cap);
    let left = have.checked_sub(1_000).ok_or_else(|| {
        Refusal::Citizen(format!(
            "action bucket empty: {have} milli-tokens at now (cap {cap}), 1,000 needed"
        ))
    })?;
    let t32 =
        u32::try_from(t).map_err(|_| Refusal::Citizen("bucket time does not fit u32".into()))?;
    if !(wr_u32(citizen, C2::BUCKET_MILLI, left as u32) && wr_u32(citizen, C2::BUCKET_T, t32)) {
        return Err(short());
    }
    Ok(left as u32)
}

/// I-47, transcribed: the cohort of `ticket_bell` is closed when 24 bells
/// have passed since it, or when no cohort record of that bell has a
/// ticket still open (`filed == 0` or `settled ≥ filed`). A province too
/// short to hold a cohort is **open** (fail closed).
pub fn cohort_closed(province: &[u8], ticket_bell: u32, now_bell: u32) -> bool {
    if now_bell >= ticket_bell.saturating_add(PV::COHORT_BELLS) {
        return true;
    }
    (0..PV::COHORTS_N).all(|i| {
        let o = PV::cohort(i);
        match (
            rd_u32(province, o + CO::BELL),
            rd_u16(province, o + CO::FILED),
            rd_u16(province, o + CO::SETTLED),
        ) {
            (Some(b), Some(f), Some(s)) => b != ticket_bell || f == 0 || s >= f,
            _ => false,
        }
    })
}

/// The lazy provisional → final flip of a wide holding (an outpost: the
/// state byte alone, no Citizen flag), transcribed: state provisional,
/// `now ≥ final_ts`, the cohort of its ticket bell closed.
pub fn finality_due(holding: &[u8], province: &[u8], now: i64, now_bell: u32) -> bool {
    let (Some(state), Some(final_ts), Some(ticket_bell)) = (
        rd_u8(holding, H2::STATE),
        rd_i64(holding, H2::FINAL_TS),
        rd_u32(holding, H2::TICKET_BELL),
    ) else {
        return false;
    };
    state == H2::STATE_PROVISIONAL
        && now >= final_ts
        && cohort_closed(province, ticket_bell, now_bell)
}

// ------------------------------------------------------------ season

/// The Season bytes, structurally (module doc): exactly `season::SIZE`
/// bytes with the Season magic; effective status Running at `now_ts`
/// (stored Seeded with `now ≥ genesis`, or Running); the ruleset
/// `RULESET_HASH_V3`; the program version exactly
/// [`WIDE_S1_PROGRAM_VERSION`], with or without [`NFT_VERSION_BIT`]; a
/// bell at `now_ts` below `end_bell`.
pub fn read_season(season: &[u8], now_ts: i64) -> Result<SeasonFacts, Refusal> {
    if season.len() != S::SIZE {
        return Err(Refusal::Season(format!(
            "{} bytes, the Season is {}",
            season.len(),
            S::SIZE
        )));
    }
    let short = || Refusal::Season("short".into());
    if rd_arr::<8>(season, HDR::MAGIC).ok_or_else(short)? != S::MAGIC {
        return Err(Refusal::Season("not the Season magic".into()));
    }
    let stored = rd_u8(season, S::STATUS).ok_or_else(short)?;
    let genesis_ts = rd_i64(season, S::GENESIS_TS).ok_or_else(short)?;
    let status = if stored == S::STATUS_SEEDED && now_ts >= genesis_ts {
        S::STATUS_RUNNING
    } else {
        stored
    };
    if status != S::STATUS_RUNNING {
        return Err(Refusal::Season(format!(
            "effective status {status} at now_ts {now_ts}, not Running"
        )));
    }
    let ruleset = rd_arr::<32>(season, S::RULESET_HASH).ok_or_else(short)?;
    if ruleset != RULESET_HASH_V3 {
        return Err(Refusal::Season(
            "ruleset hash is not RULESET_HASH_V3".into(),
        ));
    }
    let program_version = rd_u16(season, S::PROGRAM_VERSION).ok_or_else(short)?;
    if program_version != WIDE_S1_PROGRAM_VERSION
        && program_version != (WIDE_S1_PROGRAM_VERSION | NFT_VERSION_BIT)
    {
        return Err(Refusal::Season(format!(
            "program version {program_version:#06x} is not the wide S1 build {WIDE_S1_PROGRAM_VERSION:#06x} (NFT bit allowed)"
        )));
    }
    let end_bell = rd_u32(season, S::END_BELL).ok_or_else(short)?;
    let now_bell = bell_at(genesis_ts, now_ts).ok_or_else(|| {
        Refusal::Season(format!("now_ts {now_ts} is before genesis {genesis_ts}"))
    })?;
    if now_bell >= end_bell {
        return Err(Refusal::Season(format!(
            "bell {now_bell} at now_ts is not below the end bell {end_bell}"
        )));
    }
    Ok(SeasonFacts {
        season_id: rd_u64(season, S::SEASON_ID).ok_or_else(short)?,
        genesis_ts,
        end_bell,
        program_version,
        bucket_rate_per_h: rd_u16(season, S::BUCKET_RATE_PER_H).ok_or_else(short)?,
        bucket_burst: rd_u16(season, S::BUCKET_BURST).ok_or_else(short)?,
        now_bell,
    })
}

// ------------------------------------------------------------ citizen

/// The Citizen's short header, structurally: the Citizen magic
/// (`citizen::MAGIC`, `PSF1CITZ`) and `season_id` — exactly what the
/// program's player prologue requires of the Citizen account before any
/// owner action (`prologue::check_present(Citizen)`: owner, size, magic,
/// season). The owner is not visible here; the size is
/// `economy::check_snapshots`'s. No `layout_version` is required, as the
/// program requires none. Establishes nothing about the account's address
/// or holder.
pub fn check_citizen_header(citizen: &[u8], season_id: u64) -> Result<(), Refusal> {
    let (magic, id) = read_short_header(citizen)
        .ok_or_else(|| Refusal::Citizen("citizen bytes too short for the header".into()))?;
    if magic != C2::MAGIC {
        return Err(Refusal::Citizen(format!(
            "magic {:?} is not the Citizen magic {:?}",
            String::from_utf8_lossy(&magic),
            String::from_utf8_lossy(&C2::MAGIC)
        )));
    }
    if id != season_id {
        return Err(Refusal::Citizen(format!(
            "citizen of season {id} under Season {season_id}"
        )));
    }
    Ok(())
}

// ------------------------------------------------------------ record

/// The record's decoded facts: an economy kind, its holding reference and
/// receipt.
struct Decoded<'a> {
    record: WideRecord<'a>,
    holding_ref: WideHostRef,
    receipt: EconomyReceipt,
}

fn decode(body: &[u8]) -> Result<Decoded<'_>, Refusal> {
    let record = WideRecord::decode(body).map_err(|e| Refusal::Record(format!("{e:?}")))?;
    if !matches!(record.kind, WideKind::Economy | WideKind::EconomyMirror) {
        return Err(Refusal::Record(format!(
            "kind {} ({}) is not an economy receipt; only Economy (15) and EconomyMirror (16) are verified here",
            record.kind as u8,
            record.kind.name()
        )));
    }
    let holding_ref = record
        .holding()
        .ok_or_else(|| Refusal::Record("no holding reference".into()))?;
    let receipt = record
        .receipt()
        .ok_or_else(|| Refusal::Record("no receipt".into()))?;
    if receipt.kind() != record.kind {
        return Err(Refusal::Record(
            "receipt action under the other kind".into(),
        ));
    }
    Ok(Decoded {
        record,
        holding_ref,
        receipt,
    })
}

fn hold_action(a: Action) -> hold::Action {
    match a {
        Action::Harvest => hold::Action::Harvest,
        Action::Build { item } => hold::Action::Build { item },
        Action::Train { unit, n } => hold::Action::Train { unit, n },
    }
}

// ------------------------------------------------------------ numeric preflight

/// The numeric preflight of the holding replay (module doc): the kernel
/// holding `h` as [`crate::holding::read`] gives it, its `TERRAIN_ORE`
/// `terrain_ore`, and the receipt's `now`. Refuses exactly the stored
/// numbers the existing replay arithmetic would not represent, each with
/// the range it fails:
///
/// * `terrain_ore.max(0) × (100 + tier_bonus_pct(t))` for each of the four
///   tiers — the product `arms::base_production` takes before dividing by
///   100 (a conservative replay-range check, not an ore cap);
/// * `last_owner_action + DORMANT_AFTER` and `now + DORMANT_AFTER` — the
///   kernel's `dormant_at` at the pre-state and after the touch;
/// * `now − t0` for each store with `t0 < now` — `Accrual::settle`
///   subtracts in `i64`; no settle instant exceeds `now`;
/// * `0 ≤ frac < HOUR` for each store — the kernel's canonical carried
///   remainder, which the workshop dry-time arithmetic assumes.
///
/// A deterministic representability guard: no game cost, cap or clamp, no
/// change to any normal S1 output, and no claim about any other malformed
/// numeric state.
pub fn preflight_holding(h: &KHolding, terrain_ore: i64, now: i64) -> Result<(), Refusal> {
    let ore = terrain_ore.max(0);
    for t in [Tier::Hamlet, Tier::Town, Tier::City, Tier::Stronghold] {
        let pct = 100 + catalog::tier_bonus_pct(t);
        if ore.checked_mul(pct).is_none() {
            return Err(Refusal::Holding(format!(
                "terrain ore {terrain_ore} milli/h is outside the replay's representable range: ore × {pct} (the {t:?} bonus) overflows i64"
            )));
        }
    }
    if h.last_owner_action.checked_add(DORMANT_AFTER).is_none() {
        return Err(Refusal::Holding(format!(
            "last owner action {} is outside the replay's representable range: + {DORMANT_AFTER} s (dormancy) overflows i64",
            h.last_owner_action
        )));
    }
    if now.checked_add(DORMANT_AFTER).is_none() {
        return Err(Refusal::Holding(format!(
            "now_ts {now} is outside the replay's representable range: + {DORMANT_AFTER} s (dormancy) overflows i64"
        )));
    }
    for (i, s) in h.stores.iter().enumerate() {
        if now > s.t0 && now.checked_sub(s.t0).is_none() {
            return Err(Refusal::Holding(format!(
                "store {i} settle instant t0 {} is outside the replay's representable range: now_ts {now} − t0 overflows i64",
                s.t0
            )));
        }
        if s.frac < 0 || s.frac >= HOUR {
            return Err(Refusal::Holding(format!(
                "store {i} fraction {} is not the kernel's canonical remainder (0 ≤ frac < {HOUR})",
                s.frac
            )));
        }
    }
    Ok(())
}

// ------------------------------------------------------------ staging

/// The expected post-states of `record` over `before` under `season`
/// (module doc): the record decoded, the Season read, the snapshots
/// validated, the pre-state checks, the lazy flip compared with the
/// receipt, then the Citizen debit, the numeric preflight of the holding
/// ([`preflight_holding`]), the holding replay and the mirror write. The
/// chained headers of the staged holding and province are the pre-state's:
/// [`verify_transition`] writes the record's links into them after
/// checking them. The receipt's digests are **not** read here; a direct
/// caller gets the preflight's guard but not the input digest's
/// ([`verify_transition`] judges that first).
pub fn stage(record: &[u8], season: &[u8], before: &Snapshots<'_>) -> Result<Staged, Refusal> {
    let d = decode(record)?;
    let receipt = d.receipt;
    let now = receipt.now_ts;
    let sf = read_season(season, now)?;
    if d.record.bell != sf.now_bell {
        return Err(Refusal::Record(format!(
            "record bell {} is not the Season's bell {} at now_ts {now}",
            d.record.bell, sf.now_bell
        )));
    }
    // The snapshots: the ABI's own validation (shape, identity).
    economy::check_snapshots(&d.holding_ref, before)
        .map_err(|e| Refusal::Snapshot(format!("before: {e:?}")))?;
    let wh = WideHolding::read(before.holding).map_err(|e| Refusal::Snapshot(format!("{e:?}")))?;
    let wp =
        WideProvince::read(before.province).map_err(|e| Refusal::Snapshot(format!("{e:?}")))?;
    if wh.season_id != sf.season_id {
        return Err(Refusal::Holding(format!(
            "holding of season {} under Season {}",
            wh.season_id, sf.season_id
        )));
    }
    debug_assert_eq!(wp.season_id, wh.season_id);
    // The Citizen's short header, as the program's player prologue requires
    // of the Citizen account (`check_present`: the Citizen magic, the
    // Season's id; no layout version). A codec check of the bytes: not the
    // account's address, owner or holder (NOT_PROVEN).
    check_citizen_header(before.citizen, sf.season_id)?;
    // The Citizen: the slot the holding occupies carries the wide marker
    // (a generic binding, not a coordinate proof).
    match binding_of(before.citizen, wh.slot) {
        Ok(SlotBinding::Wide) => {}
        Ok(other) => {
            return Err(Refusal::Citizen(format!(
                "slot {} is {other:?}, not bound to a wide holding",
                wh.slot
            )))
        }
        Err(e) => return Err(Refusal::Citizen(format!("slot {}: {e:?}", wh.slot))),
    }
    // The holding prefix: order = slot, live.
    let short = || Refusal::Snapshot("holding short".into());
    let order = rd_u8(before.holding, H2::ORDER).ok_or_else(short)?;
    if order != wh.slot {
        return Err(Refusal::State(format!(
            "holding order {order} is not its slot {}",
            wh.slot
        )));
    }
    let state = rd_u8(before.holding, H2::STATE).ok_or_else(short)?;
    if state != H2::STATE_PROVISIONAL && state != H2::STATE_FINAL {
        return Err(Refusal::State(format!("holding state {state} is not live")));
    }
    // The site mirror shows this holding at this generation; a mirror one
    // generation ahead is a capture completed and not settled.
    let site = wh.site as usize;
    if site >= PV::SITES_N {
        return Err(Refusal::Snapshot(format!("site {site}")));
    }
    let so = PV::site(site);
    let pshort = || Refusal::Snapshot("province short".into());
    let mstate = rd_u8(before.province, so + SM::STATE).ok_or_else(pshort)?;
    let mgen = rd_u8(before.province, so + SM::GEN).ok_or_else(pshort)?;
    if mstate == SM::STATE_HOLDING && mgen == wh.gen.wrapping_add(1) {
        return Err(Refusal::State(format!(
            "capture pending: the site mirror shows generation {mgen} over the holding's {}",
            wh.gen
        )));
    }
    if mstate != SM::STATE_HOLDING || mgen != wh.gen {
        return Err(Refusal::Province(format!(
            "site mirror {site} is state {mstate} generation {mgen}, not this holding (state {} generation {})",
            SM::STATE_HOLDING,
            wh.gen
        )));
    }
    // The lazy flip, independently.
    let became_final = finality_due(before.holding, before.province, now, sf.now_bell);
    if became_final != receipt.became_final {
        return Err(Refusal::Finality(format!(
            "receipt says became_final {}, the rules give {became_final} (state {state}, final_ts {}, ticket bell {}, bell {})",
            receipt.became_final,
            rd_i64(before.holding, H2::FINAL_TS).unwrap_or(0),
            rd_u32(before.holding, H2::TICKET_BELL).unwrap_or(0),
            sf.now_bell
        )));
    }
    // The Citizen after: the bucket and the last action, nothing else.
    let mut citizen = before.citizen.to_vec();
    let bucket_left = debit_bucket(
        &mut citizen,
        now,
        sf.genesis_ts,
        sf.bucket_rate_per_h,
        sf.bucket_burst,
    )?;
    if !wr_i64(&mut citizen, C2::LAST_ACTION_TS, now) {
        return Err(Refusal::Citizen("short".into()));
    }
    // The holding after: the flip, then the existing S1 replay over a
    // scratch copy under layout version 2 (module doc, the adapter).
    let mut scratch = before.holding.to_vec();
    if became_final && !wr_u8(&mut scratch, H2::STATE, H2::STATE_FINAL) {
        return Err(short());
    }
    let version: [u8; 2] = rd_arr(&scratch, HDR::LAYOUT_VERSION).ok_or_else(short)?;
    if u16::from_le_bytes(version) != WIDE_LAYOUT_VERSION {
        return Err(Refusal::Snapshot(
            "holding layout version is not wide".into(),
        ));
    }
    wr_arr(&mut scratch, HDR::LAYOUT_VERSION, &2u16.to_le_bytes());
    // The numeric preflight over the holding the replay is about to read
    // (its own codec, its own `TERRAIN_ORE` read): before any kernel
    // arithmetic. A holding the codec cannot read is the replay's refusal
    // as before.
    let kernel = hold::read(&scratch)
        .map_err(|e| Refusal::Holding(format!("the S1 replay refuses the action: {e}")))?;
    let terrain_ore = hold::terrain_ore(&scratch)
        .map_err(|e| Refusal::Holding(format!("the S1 replay refuses the action: {e}")))?;
    preflight_holding(&kernel, terrain_ore, now)?;
    let replayed = hold::replay(
        &scratch,
        &hold_action(receipt.action),
        now,
        sf.genesis_ts,
        Rules::S1,
    )
    .map_err(|e| Refusal::Holding(format!("the S1 replay refuses the action: {e}")))?;
    let mut holding = replayed.holding;
    if holding.len() != WH::SIZE {
        return Err(Refusal::Holding(format!(
            "replay left {} bytes, the wide holding is {}",
            holding.len(),
            WH::SIZE
        )));
    }
    // Restore exactly the two version bytes.
    wr_arr(&mut holding, HDR::LAYOUT_VERSION, &version);
    // The province after: the mirror item of walls or the tier-up, else
    // byte for byte the pre-state.
    let province = match receipt.action {
        Action::Build {
            item: economy::BUILD_ITEM_WALLS,
        } => {
            let item = replayed
                .wall_item
                .ok_or_else(|| Refusal::Province("walls replay gave no wall item".into()))?;
            hold::wall_item(before.province, site, item).ok_or_else(|| {
                Refusal::Province("both wall item slots of the site mirror are busy".into())
            })?
        }
        Action::Build {
            item: economy::BUILD_ITEM_TIER_UP,
        } => {
            // payload: item u8 ‖ cost digest [32] ‖ done_at i64
            let done_at = rd_i64(&replayed.payload, 33)
                .ok_or_else(|| Refusal::Province("tier-up replay payload short".into()))?;
            let eff = bell_at(sf.genesis_ts, done_at)
                .and_then(|b| b.checked_add(1))
                .ok_or_else(|| Refusal::Province("tier-up mirror bell overflows".into()))?;
            let tier_now = rd_u8(&holding, H2::TIER).ok_or_else(short)?;
            let next = tier_now
                .checked_add(1)
                .ok_or_else(|| Refusal::Province("tier overflows".into()))?;
            let mut p = before.province.to_vec();
            if !(wr_u8(&mut p, so + SM::TIER, tier_now)
                && wr_u8(&mut p, so + SM2::TIER_NEXT, next)
                && wr_u32(&mut p, so + SM2::TIER_NEXT_BELL, eff))
            {
                return Err(pshort());
            }
            p
        }
        _ => before.province.to_vec(),
    };
    if province.len() != WP::SIZE {
        return Err(Refusal::Province(
            "mirror write changed the province size".into(),
        ));
    }
    Ok(Staged {
        kind: d.record.kind,
        action: receipt.action,
        holding_ref: d.holding_ref,
        province_key: d.holding_ref.key(),
        now_ts: now,
        bell: sf.now_bell,
        became_final,
        season: sf,
        citizen,
        holding,
        province,
        bucket_left,
    })
}

// ------------------------------------------------------------ chain

fn chain_of(d: &[u8]) -> Option<(u64, [u8; 32])> {
    Some((rd_u64(d, HDR::EVENT_SEQ)?, rd_arr(d, HDR::EVENT_HEAD)?))
}

fn set_chain(d: &mut [u8], link: &WideLink) -> bool {
    wr_u64(d, HDR::EVENT_SEQ, link.seq) && wr_arr(d, HDR::EVENT_HEAD, &link.head)
}

/// The link `entity` must carry: `event::advance` from the pre-state
/// header of `pre`, compared with the record's.
fn expected_link(r: &WideRecord<'_>, entity: WideEntity, pre: &[u8]) -> Result<WideLink, Refusal> {
    let (seq, head) = chain_of(pre)
        .ok_or_else(|| Refusal::Chain(format!("{entity:?}: pre-state header short")))?;
    let want = event::advance(entity, seq, &head, r.body_without_tail)
        .ok_or_else(|| Refusal::Chain(format!("{entity:?}: sequence overflow at {seq}")))?;
    let got = r
        .link(entity)
        .ok_or_else(|| Refusal::Chain(format!("{entity:?}: the record carries no link")))?;
    if got != want {
        return Err(Refusal::Chain(format!(
            "{entity:?}: link seq {} head {} does not continue the pre-state chain (seq {seq}: expected seq {} head {})",
            got.seq,
            hex::encode(got.head),
            want.seq,
            hex::encode(want.head)
        )));
    }
    Ok(want)
}

fn first_diff(a: &[u8], b: &[u8]) -> Option<usize> {
    if a.len() != b.len() {
        return Some(a.len().min(b.len()));
    }
    a.iter().zip(b).position(|(x, y)| x != y)
}

fn compare(what: &str, expected: &[u8], got: &[u8]) -> Result<(), String> {
    if expected.len() != got.len() {
        return Err(format!(
            "{what} after: {} bytes supplied, {} expected",
            got.len(),
            expected.len()
        ));
    }
    match first_diff(expected, got) {
        None => Ok(()),
        Some(o) => Err(format!(
            "{what} after differs from the independent replay at offset {o} (supplied {:#04x}, expected {:#04x})",
            got[o], expected[o]
        )),
    }
}

// ------------------------------------------------------------ the verdict

/// Verifies one economy record over the snapshots before and after it
/// (module doc): the record decoded, the input digest over the raw
/// pre-state **before** any staging, then [`stage`], the links from the
/// pre-state headers, the whole expected post-states against the supplied
/// ones byte for byte, then the output digest over the expected
/// post-state. `Err` on the first refusal; `Ok` is a transition verdict
/// and nothing more ([`Verified::not_proven`]).
pub fn verify_transition(
    record: &[u8],
    season: &[u8],
    before: &Snapshots<'_>,
    after: &Snapshots<'_>,
) -> Result<Verified, Refusal> {
    let d = decode(record)?;
    // The input digest first: the raw pre-state the action saw, as the
    // receipt commits to it. A pre-state the receipt does not commit to is
    // refused here and never replayed. The digest's own validation of the
    // snapshots (shape, identity) is the ABI's, as in `stage`.
    let input = economy::input_digest(
        &d.holding_ref,
        d.receipt.action,
        d.receipt.now_ts,
        season,
        before,
    )
    .map_err(|e| Refusal::Snapshot(format!("before: {e:?}")))?;
    if input != d.receipt.input_digest {
        return Err(Refusal::Digest(
            "input digest does not recompute over the Season and the pre-state snapshots".into(),
        ));
    }
    let mut st = stage(record, season, before)?;
    // The links, from the pre-state headers, written into the staged
    // post-states.
    let holding_link = expected_link(&d.record, WideEntity::Holding, before.holding)?;
    if !set_chain(&mut st.holding, &holding_link) {
        return Err(Refusal::Holding("short".into()));
    }
    let province_link = if st.kind == WideKind::EconomyMirror {
        let l = expected_link(&d.record, WideEntity::Province, before.province)?;
        if !set_chain(&mut st.province, &l) {
            return Err(Refusal::Province("short".into()));
        }
        Some(l)
    } else {
        if d.record.link(WideEntity::Province).is_some() {
            return Err(Refusal::Chain(
                "an Economy record chains no province".into(),
            ));
        }
        None
    };
    // Every byte of every post-state.
    compare("citizen", &st.citizen, after.citizen).map_err(Refusal::Citizen)?;
    compare("holding", &st.holding, after.holding).map_err(Refusal::Holding)?;
    compare("province", &st.province, after.province).map_err(Refusal::Province)?;
    // The output digest over the expected post-state (normalized per the
    // ABI: the headers zeroed, so the link does not enter it).
    let expected_after = Snapshots {
        citizen: &st.citizen,
        holding: &st.holding,
        province: &st.province,
    };
    let output = economy::output_digest(
        &d.holding_ref,
        st.action,
        st.now_ts,
        st.became_final,
        &expected_after,
    )
    .map_err(|e| Refusal::Digest(format!("output: {e:?}")))?;
    if output != d.receipt.output_digest {
        return Err(Refusal::Digest(
            "output digest does not recompute over the expected post-state".into(),
        ));
    }
    Ok(Verified {
        kind: st.kind,
        action: st.action,
        holding_ref: st.holding_ref,
        province_key: st.province_key,
        now_ts: st.now_ts,
        bell: st.bell,
        became_final: st.became_final,
        holding_link,
        province_link,
        bucket_left: st.bucket_left,
    })
}

// ------------------------------------------------------------ synthetic unit cases

/// Synthetic cases over literal byte images built with the ABI's encoders
/// and the verifier's own holding codec. They exercise the refusal paths
/// and the module's **self-consistency** (a record built from the staged
/// post-state verifies; any other byte does not). They are **not** a
/// parity check against the program: that is the fixture test
/// (`tests/wide_economy.rs`) over records the real handler dispatched.
#[cfg(test)]
mod tests {
    use super::*;

    /// Fixed wire bytes only: no snapshot builders, replay or key operations.
    #[test]
    fn garrison_is_explicitly_not_an_economy_receipt() {
        use frontier_abi::world_index::{WideCoord, WorldId};
        let world = WorldId::new([7; 32]).unwrap();
        let province = ProvinceKey::new(world, WideCoord::checked(129, 0).unwrap());
        let holding = WideHostRef::new(province, 3, 1, 0).unwrap();
        let payload = event::garrison_payload(&event::GarrisonReceipt {
            delta: 123,
            now_ts: 100,
            became_final: false,
            input_digest: [1; 32],
            output_digest: [2; 32],
        })
        .unwrap();
        let links = [
            WideLink {
                entity: WideEntity::Province,
                seq: 1,
                head: [3; 32],
            },
            WideLink {
                entity: WideEntity::Holding,
                seq: 1,
                head: [4; 32],
            },
        ];
        let body =
            event::encode(WideKind::Garrison, 9, &holding.to_bytes(), &payload, &links).unwrap();
        match decode(&body) {
            Err(Refusal::Record(reason)) => assert_eq!(reason,
                "kind 17 (WIDE_GARRISON) is not an economy receipt; only Economy (15) and EconomyMirror (16) are verified here"),
            _ => panic!("Garrison must be explicitly refused, never economy-verified"),
        }
    }
    use frontier_abi::bytes::wr_u16;
    use frontier_abi::layout::player::accrual;
    use frontier_abi::v2::layout::province::province as PV2;
    use frontier_abi::world_index::holding::{bind, wide_holding};
    use frontier_abi::world_index::land::readiness;
    use frontier_abi::world_index::{WideCoord, WorldId, HOST_IDENTITY_UNALLOCATED};
    use permutation_rules::fixed::MILLI;
    use permutation_rules::frontier::arms;
    use permutation_rules::frontier::catalog;
    use permutation_rules::frontier::holding::{
        Effect, Holding as KHolding, QueueItem, Resource, Tier,
    };

    const SEASON_ID: u64 = 7;
    const WORLD: [u8; 32] = [0x5A; 32];
    const OWNER: [u8; 32] = [0xC1; 32];
    const SITE: u8 = 3;
    const GEN: u8 = 2;
    const SLOT: u8 = 2;
    const FACTION: u8 = 1;
    const ORE: i64 = 10 * MILLI;
    const GENESIS: i64 = 1_700_000_000;
    /// Bell 52.
    const FOUNDED: i64 = GENESIS + 31_200;
    /// Bell 100.
    const NOW: i64 = GENESIS + 60_000;
    const RESOLVED_NEXT: u32 = 99;
    const RATE: u16 = 60;
    const BURST: u16 = 12;
    /// Not M1's `founded_ts + 48 h`: a shield the replay's `write` would
    /// rewrite under layout version 1, kept under the adapter.
    const ODD_SHIELD: i64 = FOUNDED + 12_345;
    const RICH: [i64; 8] = [
        1_000_000, 1_500_000, 1_200_000, 500_000, 300_000, 600_000, 0, 0,
    ];

    fn world() -> WorldId {
        WorldId::new(WORLD).unwrap()
    }
    fn coord() -> WideCoord {
        WideCoord::checked(200, -50).unwrap()
    }
    fn href() -> WideHostRef {
        WideHostRef::new(ProvinceKey::new(world(), coord()), SITE, GEN, 0).unwrap()
    }

    fn season() -> Vec<u8> {
        let mut d = vec![0u8; S::SIZE];
        wr_arr(&mut d, HDR::MAGIC, &S::MAGIC);
        wr_u64(&mut d, S::SEASON_ID, SEASON_ID);
        wr_u8(&mut d, S::STATUS, S::STATUS_SEEDED);
        wr_arr(&mut d, S::RULESET_HASH, &RULESET_HASH_V3);
        wr_u16(&mut d, S::PROGRAM_VERSION, WIDE_S1_PROGRAM_VERSION);
        wr_i64(&mut d, S::GENESIS_TS, GENESIS);
        wr_u32(&mut d, S::END_BELL, 4_000);
        wr_u16(&mut d, S::BUCKET_RATE_PER_H, RATE);
        wr_u16(&mut d, S::BUCKET_BURST, BURST);
        d
    }

    fn kernel(credits: &[i64; 8]) -> KHolding {
        let mut h = KHolding::found(FOUNDED, 0, SLOT);
        h.production = arms::base_production(Tier::Hamlet, ORE);
        for (r, v) in credits.iter().enumerate().filter(|(_, v)| **v > 0) {
            h.credit(FOUNDED, Resource::ALL[r], *v).unwrap();
        }
        h.touch_owner(FOUNDED).unwrap();
        h
    }

    fn holding_with(h: &KHolding, state: u8) -> Vec<u8> {
        let mut d = vec![0u8; wide_holding::SIZE];
        WideHolding {
            season_id: SEASON_ID,
            world: world(),
            coord: coord(),
            site: SITE,
            gen: GEN,
            slot: SLOT,
            owner_citizen: OWNER,
            host_identity: HOST_IDENTITY_UNALLOCATED,
            open_transits: 0,
        }
        .write_identity(&mut d)
        .unwrap();
        wr_u64(&mut d, HDR::EVENT_SEQ, 12);
        wr_arr(&mut d, HDR::EVENT_HEAD, &[0xE1; 32]);
        wr_u8(&mut d, H2::TILE, 17);
        wr_u8(&mut d, H2::STATE, state);
        wr_u8(&mut d, H2::FACTION, FACTION);
        wr_u32(&mut d, H2::TICKET_BELL, 40);
        wr_arr(&mut d, H2::DELEGATE, &[0xD3; 32]);
        wr_u64(&mut d, H2::ESCROW, 55_555);
        wr_arr(&mut d, H2::RENT_PAYER, &[0xA7; 32]);
        wr_i64(&mut d, H2::FINAL_TS, FOUNDED + 3_600);
        wr_u64(&mut d, H2::POOL_OWED, 9_999);
        wr_i64(&mut d, H2::TERRAIN_ORE, ORE);
        hold::write(&mut d, h, FOUNDED).unwrap();
        // after the codec's write (which rewrites the shield under version 3)
        wr_i64(&mut d, H2::SHIELD_UNTIL, ODD_SHIELD);
        d
    }

    fn holding() -> Vec<u8> {
        holding_with(&kernel(&RICH), H2::STATE_FINAL)
    }

    fn province() -> Vec<u8> {
        let mut d = vec![0u8; WP::SIZE];
        WideProvince {
            season_id: SEASON_ID,
            world: world(),
            coord: coord(),
            wedge: coord().wedge().unwrap(),
            region: 5,
            opened_bell: 3,
            readiness: readiness::REQUIRED,
            seed_round: 11,
            ring_seed: [0x9D; 32],
            funded_lamports: 1_000_000,
        }
        .write_identity(&mut d)
        .unwrap();
        wr_u64(&mut d, HDR::EVENT_SEQ, 5);
        wr_arr(&mut d, HDR::EVENT_HEAD, &[0xE5; 32]);
        wr_u32(&mut d, PV2::RESOLVED_NEXT, RESOLVED_NEXT);
        let o = PV2::site(SITE as usize);
        wr_u8(&mut d, o + SM::STATE, SM::STATE_HOLDING);
        wr_u8(&mut d, o + SM::FACTION, FACTION);
        wr_u8(&mut d, o + SM::ORDER, SLOT);
        wr_u8(&mut d, o + SM::GEN, GEN);
        wr_u32(&mut d, o + SM::GARRISON, 250);
        wr_u32(&mut d, o + SM::WALLS_COMMITTED, 100);
        d
    }

    fn citizen() -> Vec<u8> {
        let mut d = vec![0u8; C2::SIZE];
        // the short header the program's prologue requires of a Citizen
        wr_arr(&mut d, HDR::MAGIC, &C2::MAGIC);
        wr_u64(&mut d, HDR::SEASON_ID, SEASON_ID);
        for slot in 1..=3u8 {
            d[C2::holding_of_slot(slot) + frontier_abi::layout::player::holding_ref::GEN] =
                C2::EMPTY_GEN;
        }
        bind(&mut d, SLOT).unwrap();
        wr_u64(&mut d, HDR::EVENT_SEQ, 77);
        wr_arr(&mut d, HDR::EVENT_HEAD, &[0x77; 32]);
        wr_arr(&mut d, C2::WALLET, &[0xAB; 32]);
        wr_u8(&mut d, C2::FLAGS, C2::FLAG_JOINED | C2::FLAG_PROVISIONAL);
        wr_u32(&mut d, C2::BUCKET_MILLI, 2_500);
        wr_u32(&mut d, C2::BUCKET_T, (FOUNDED - GENESIS) as u32);
        wr_i64(&mut d, C2::LAST_ACTION_TS, FOUNDED);
        d
    }

    struct Built {
        record: Vec<u8>,
        citizen: Vec<u8>,
        holding: Vec<u8>,
        province: Vec<u8>,
    }

    /// A record built from this module's own staged post-state: the
    /// self-consistency form (module doc of the tests).
    fn build(season: &[u8], before: &Snapshots<'_>, action: Action, became_final: bool) -> Built {
        let h = href();
        let input = economy::input_digest(&h, action, NOW, season, before).unwrap();
        // a provisional record to stage from (digests are not read by stage)
        let kind = action.kind();
        let draft = EconomyReceipt {
            action,
            now_ts: NOW,
            became_final,
            input_digest: input,
            output_digest: [0; 32],
        };
        let bell = bell_at(GENESIS, NOW).unwrap();
        let fake: Vec<WideLink> = kind
            .links()
            .iter()
            .map(|e| WideLink {
                entity: *e,
                seq: 0,
                head: [0; 32],
            })
            .collect();
        let body0 = event::encode(
            kind,
            bell,
            &h.to_bytes(),
            &event::economy_payload(&draft).unwrap(),
            &fake,
        )
        .unwrap();
        let st = stage(&body0, season, before).unwrap();
        let output = economy::output_digest(
            &h,
            action,
            NOW,
            became_final,
            &Snapshots {
                citizen: &st.citizen,
                holding: &st.holding,
                province: &st.province,
            },
        )
        .unwrap();
        let receipt = EconomyReceipt {
            output_digest: output,
            ..draft
        };
        let payload = event::economy_payload(&receipt).unwrap();
        let mut bwt = [0u8; event::MAX_BODY];
        let n = event::write_body(kind, bell, &h.to_bytes(), &payload, &mut bwt).unwrap();
        let mut links = Vec::new();
        for e in kind.links() {
            let pre = match e {
                WideEntity::Province => before.province,
                WideEntity::Holding => before.holding,
            };
            let (seq, head) = chain_of(pre).unwrap();
            links.push(event::advance(*e, seq, &head, &bwt[..n]).unwrap());
        }
        let record = event::encode(kind, bell, &h.to_bytes(), &payload, &links).unwrap();
        let mut holding = st.holding;
        let mut province = st.province;
        for l in &links {
            match l.entity {
                WideEntity::Holding => assert!(set_chain(&mut holding, l)),
                WideEntity::Province => assert!(set_chain(&mut province, l)),
            }
        }
        Built {
            record,
            citizen: st.citizen,
            holding,
            province,
        }
    }

    fn snaps<'a>(c: &'a [u8], h: &'a [u8], p: &'a [u8]) -> Snapshots<'a> {
        Snapshots {
            citizen: c,
            holding: h,
            province: p,
        }
    }

    /// Re-seals a valid record over altered Citizen bytes, the way a forger
    /// with a malicious snapshot would: the input digest over the altered
    /// pre-state, the output digest over the altered post-state, the links
    /// from the (unaltered) pre-state holding and province headers, and the
    /// chained headers of the post-states re-set to those links. The result
    /// is byte-consistent with itself, so a refusal of it is structural —
    /// never an incidental digest or chain mismatch.
    fn reseal(
        season: &[u8],
        before: &Snapshots<'_>,
        citizen_after: &[u8],
        valid: &Built,
        action: Action,
        became_final: bool,
    ) -> Built {
        let h = href();
        let kind = action.kind();
        let input = economy::input_digest(&h, action, NOW, season, before).unwrap();
        // the output digest normalizes the chained headers, so the valid
        // post holding and province serve as they are
        let output = economy::output_digest(
            &h,
            action,
            NOW,
            became_final,
            &snaps(citizen_after, &valid.holding, &valid.province),
        )
        .unwrap();
        let receipt = EconomyReceipt {
            action,
            now_ts: NOW,
            became_final,
            input_digest: input,
            output_digest: output,
        };
        let payload = event::economy_payload(&receipt).unwrap();
        let bell = bell_at(GENESIS, NOW).unwrap();
        let mut bwt = [0u8; event::MAX_BODY];
        let n = event::write_body(kind, bell, &h.to_bytes(), &payload, &mut bwt).unwrap();
        let mut holding = valid.holding.clone();
        let mut province = valid.province.clone();
        let mut links = Vec::new();
        for e in kind.links() {
            let pre = match e {
                WideEntity::Province => before.province,
                WideEntity::Holding => before.holding,
            };
            let (seq, head) = chain_of(pre).unwrap();
            let l = event::advance(*e, seq, &head, &bwt[..n]).unwrap();
            match e {
                WideEntity::Holding => assert!(set_chain(&mut holding, &l)),
                WideEntity::Province => assert!(set_chain(&mut province, &l)),
            }
            links.push(l);
        }
        let record = event::encode(kind, bell, &h.to_bytes(), &payload, &links).unwrap();
        Built {
            record,
            citizen: citizen_after.to_vec(),
            holding,
            province,
        }
    }

    /// A record whose **input digest and links** are sealed over `before`
    /// at `now` under `season` (its genesis read from the bytes) and whose
    /// output digest is zero: the form a boundary case takes, where the
    /// staging refuses and no post-state exists to seal. A refusal of it by
    /// `verify_transition` is therefore never the input digest's or the
    /// chain's; the output digest is judged last and is never reached.
    fn sealed_input(season: &[u8], before: &Snapshots<'_>, action: Action, now: i64) -> Vec<u8> {
        let h = href();
        let kind = action.kind();
        let genesis = rd_i64(season, S::GENESIS_TS).unwrap();
        let bell = bell_at(genesis, now).unwrap();
        let receipt = EconomyReceipt {
            action,
            now_ts: now,
            became_final: false,
            input_digest: economy::input_digest(&h, action, now, season, before).unwrap(),
            output_digest: [0; 32],
        };
        let payload = event::economy_payload(&receipt).unwrap();
        let mut bwt = [0u8; event::MAX_BODY];
        let n = event::write_body(kind, bell, &h.to_bytes(), &payload, &mut bwt).unwrap();
        let links: Vec<WideLink> = kind
            .links()
            .iter()
            .map(|e| {
                let pre = match e {
                    WideEntity::Province => before.province,
                    WideEntity::Holding => before.holding,
                };
                let (seq, head) = chain_of(pre).unwrap();
                event::advance(*e, seq, &head, &bwt[..n]).unwrap()
            })
            .collect();
        event::encode(kind, bell, &h.to_bytes(), &payload, &links).unwrap()
    }

    /// Moves every non-zero time of the test holding by `shift` seconds
    /// (founded, last owner action, shield, final, walls committed, each
    /// store's `t0`); the test holding's queue is empty.
    fn shift_times(h: &mut [u8], shift: i64) {
        let mut at = |o: usize| {
            let v = rd_i64(h, o).unwrap();
            if v != 0 {
                assert!(wr_i64(h, o, v.checked_add(shift).unwrap()));
            }
        };
        for o in [
            H2::FOUNDED_TS,
            H2::LAST_OWNER_ACTION,
            H2::SHIELD_UNTIL,
            H2::FINAL_TS,
            H2::WALLS_COMMITTED_BEFORE,
        ] {
            at(o);
        }
        for i in 0..H2::STORES_N {
            at(H2::store(i) + accrual::T0);
        }
    }

    fn run(action: Action) -> (Vec<u8>, Vec<u8>, Vec<u8>, Vec<u8>, Built) {
        let (s, c, h, p) = (season(), citizen(), holding(), province());
        let b = build(&s, &snaps(&c, &h, &p), action, false);
        (s, c, h, p, b)
    }

    fn verify(s: &[u8], c: &[u8], h: &[u8], p: &[u8], b: &Built) -> Result<Verified, Refusal> {
        verify_transition(
            &b.record,
            s,
            &snaps(c, h, p),
            &snaps(&b.citizen, &b.holding, &b.province),
        )
    }

    #[test]
    fn self_built_records_verify_and_claim_no_season() {
        for action in [
            Action::Harvest,
            Action::Build { item: 0 },
            Action::Build {
                item: economy::BUILD_ITEM_WALLS,
            },
            Action::Build {
                item: economy::BUILD_ITEM_TIER_UP,
            },
            Action::Build {
                item: economy::BUILD_ITEM_MAX,
            },
            Action::Train { unit: 0, n: 100 },
        ] {
            let (s, c, h, p, b) = run(action);
            let v = verify(&s, &c, &h, &p, &b).unwrap_or_else(|e| panic!("{action:?}: {e}"));
            assert_eq!(v.action, action);
            assert_eq!(v.kind, action.kind());
            assert_eq!(v.bell, 100);
            assert!(!v.became_final);
            assert_eq!(v.province_link.is_some(), action.mirror_write());
            assert_eq!(v.holding_link.seq, 13);
            assert!(!v.full_season());
            assert!(!FULL_SEASON_REPLAY_SUPPORTED);
            assert!(!v.not_proven().is_empty());
            // the non-standard shield survives the adapter
            assert_eq!(rd_i64(&b.holding, H2::SHIELD_UNTIL), Some(ODD_SHIELD));
            assert_eq!(
                rd_u16(&b.holding, HDR::LAYOUT_VERSION),
                Some(WIDE_LAYOUT_VERSION)
            );
            // the trailer is untouched
            assert_eq!(
                &b.holding[wide_holding::TRAILER..],
                &h[wide_holding::TRAILER..]
            );
            if !action.mirror_write() {
                assert_eq!(
                    b.province, p,
                    "{action:?}: a non-mirror action leaves the province"
                );
            } else {
                assert_eq!(rd_u64(&b.province, HDR::EVENT_SEQ), Some(6));
            }
        }
    }

    #[test]
    fn nonstandard_shield_rewritten_by_the_m1_rule_is_refused() {
        let (s, c, h, p, mut b) = run(Action::Harvest);
        // what the replay's `write` would have left without the adapter
        let k = hold::read(&b.holding).unwrap();
        wr_i64(&mut b.holding, H2::SHIELD_UNTIL, k.shield_until());
        assert_ne!(k.shield_until(), ODD_SHIELD);
        assert!(matches!(
            verify(&s, &c, &h, &p, &b),
            Err(Refusal::Holding(d)) if d.contains(&format!("offset {}", H2::SHIELD_UNTIL))
        ));
    }

    #[test]
    fn bucket_arithmetic_rounds_down_and_an_empty_bucket_refuses() {
        // dt = NOW − FOUNDED = 28,800 s; refill = 60 × 1,000 × 28,800 / 3,600
        // = 480,000; capped at 12,000; left 11,000.
        let (s, c, h, p, b) = run(Action::Harvest);
        let v = verify(&s, &c, &h, &p, &b).unwrap();
        assert_eq!(v.bucket_left, 11_000);
        assert_eq!(rd_u32(&b.citizen, C2::BUCKET_MILLI), Some(11_000));
        assert_eq!(
            rd_u32(&b.citizen, C2::BUCKET_T),
            Some((NOW - GENESIS) as u32)
        );
        assert_eq!(rd_i64(&b.citizen, C2::LAST_ACTION_TS), Some(NOW));
        // integer truncation: 7 per hour over 1,000 s = 1,944.44 → 1,944
        let mut cz = citizen();
        wr_u32(&mut cz, C2::BUCKET_MILLI, 0);
        wr_u32(&mut cz, C2::BUCKET_T, (NOW - GENESIS - 1_000) as u32);
        assert_eq!(debit_bucket(&mut cz, NOW, GENESIS, 7, 100), Ok(944));
        // too little
        let mut cz = citizen();
        wr_u32(&mut cz, C2::BUCKET_MILLI, 0);
        wr_u32(&mut cz, C2::BUCKET_T, (NOW - GENESIS) as u32);
        assert!(matches!(
            debit_bucket(&mut cz, NOW, GENESIS, 1, 100),
            Err(Refusal::Citizen(_))
        ));
        // the stage refuses too, so no record over an empty bucket verifies
        let mut cz = citizen();
        wr_u32(&mut cz, C2::BUCKET_MILLI, 0);
        wr_u32(&mut cz, C2::BUCKET_T, (NOW - GENESIS) as u32);
        let mut sz = season();
        wr_u16(&mut sz, S::BUCKET_RATE_PER_H, 0);
        assert!(matches!(
            stage(&b.record, &sz, &snaps(&cz, &h, &p)),
            Err(Refusal::Citizen(_))
        ));
        // other Citizen bytes (flags, its own PS2 header) must not move
        let mut t = b.citizen.clone();
        t[C2::FLAGS] ^= C2::FLAG_PROVISIONAL;
        let after = snaps(&t, &b.holding, &b.province);
        assert!(matches!(
            verify_transition(&b.record, &s, &snaps(&c, &h, &p), &after),
            Err(Refusal::Citizen(_))
        ));
        let mut t = b.citizen.clone();
        wr_u64(&mut t, HDR::EVENT_SEQ, 78);
        let after = snaps(&t, &b.holding, &b.province);
        assert!(matches!(
            verify_transition(&b.record, &s, &snaps(&c, &h, &p), &after),
            Err(Refusal::Citizen(_))
        ));
    }

    #[test]
    fn a_tier_up_finished_by_the_touch_is_the_mirror_tier_of_the_next_one() {
        // Town → City costs 4,000 wood, 3,000 stone, 1,500 gold: credited
        // above the Hamlet cap (a credit is not clamped; it only stops
        // accruing), so the second tier-up is affordable.
        let richer: [i64; 8] = [
            1_000_000, 4_500_000, 3_500_000, 500_000, 300_000, 2_000_000, 0, 0,
        ];
        let mut k = kernel(&richer);
        // a Hamlet → Town tier-up that completed before NOW
        k.queue[0] = Some(QueueItem {
            done_at: FOUNDED + 600,
            effect: Effect::TierUp,
        });
        let h = holding_with(&k, H2::STATE_FINAL);
        let (s, c, p) = (season(), citizen(), province());
        let b = build(
            &s,
            &snaps(&c, &h, &p),
            Action::Build {
                item: economy::BUILD_ITEM_TIER_UP,
            },
            false,
        );
        let v = verify(&s, &c, &h, &p, &b).unwrap();
        assert_eq!(v.kind, WideKind::EconomyMirror);
        let o = PV2::site(SITE as usize);
        assert_eq!(rd_u8(&b.holding, H2::TIER), Some(1), "Town after the touch");
        assert_eq!(rd_u8(&b.province, o + SM::TIER), Some(1));
        assert_eq!(rd_u8(&b.province, o + SM2::TIER_NEXT), Some(2));
        // the Town → City item's bell: done_at from the replay, + 1
        let k2 = hold::read(&b.holding).unwrap();
        let done = k2
            .queue
            .iter()
            .flatten()
            .find(|q| matches!(q.effect, Effect::TierUp))
            .unwrap()
            .done_at;
        assert_eq!(
            rd_u32(&b.province, o + SM2::TIER_NEXT_BELL),
            Some(bell_at(GENESIS, done).unwrap() + 1)
        );
        // a post mirror with the stale tier is refused
        let mut t = b.province.clone();
        wr_u8(&mut t, o + SM::TIER, 0);
        let after = snaps(&b.citizen, &b.holding, &t);
        assert!(matches!(
            verify_transition(&b.record, &s, &snaps(&c, &h, &p), &after),
            Err(Refusal::Province(_))
        ));
    }

    #[test]
    fn a_full_wall_queue_refuses_before_any_record_is_judged() {
        let mut p = province();
        let o = PV2::site(SITE as usize);
        // both items pending (bells above resolved_next, deltas set)
        wr_u32(&mut p, o + SM::WALL_ITEM0_BELL, RESOLVED_NEXT + 5);
        wr_u32(&mut p, o + SM::WALL_ITEM0_DELTA, catalog::WALL_STEP);
        wr_u32(&mut p, o + SM::WALL_ITEM1_BELL, RESOLVED_NEXT + 6);
        wr_u32(&mut p, o + SM::WALL_ITEM1_DELTA, catalog::WALL_STEP);
        let (s, c, h) = (season(), citizen(), holding());
        // a harvest over the same province still stages
        let b = build(&s, &snaps(&c, &h, &p), Action::Harvest, false);
        assert!(verify(&s, &c, &h, &p, &b).is_ok());
        // walls: the record of a harvest re-labelled cannot exist; stage a
        // walls draft directly
        let draft = EconomyReceipt {
            action: Action::Build {
                item: economy::BUILD_ITEM_WALLS,
            },
            now_ts: NOW,
            became_final: false,
            input_digest: [0; 32],
            output_digest: [0; 32],
        };
        let body = event::encode(
            WideKind::EconomyMirror,
            100,
            &href().to_bytes(),
            &event::economy_payload(&draft).unwrap(),
            &[
                WideLink {
                    entity: WideEntity::Province,
                    seq: 0,
                    head: [0; 32],
                },
                WideLink {
                    entity: WideEntity::Holding,
                    seq: 0,
                    head: [0; 32],
                },
            ],
        )
        .unwrap();
        assert!(matches!(
            stage(&body, &s, &snaps(&c, &h, &p)),
            Err(Refusal::Province(d)) if d.contains("busy")
        ));
        // one item already in force folds and frees its slot
        let mut p2 = province();
        wr_u32(&mut p2, o + SM::WALL_ITEM0_BELL, RESOLVED_NEXT - 1);
        wr_u32(&mut p2, o + SM::WALL_ITEM0_DELTA, 50);
        let b = build(
            &s,
            &snaps(&c, &h, &p2),
            Action::Build {
                item: economy::BUILD_ITEM_WALLS,
            },
            false,
        );
        assert!(verify(&s, &c, &h, &p2, &b).is_ok());
        assert_eq!(rd_u32(&b.province, o + SM::WALLS_COMMITTED), Some(150));
        assert_eq!(
            rd_u32(&b.province, o + SM::WALL_ITEM0_DELTA),
            Some(catalog::WALL_STEP)
        );
    }

    #[test]
    fn finality_is_recomputed_and_must_match_the_receipt() {
        let h = holding_with(&kernel(&RICH), H2::STATE_PROVISIONAL);
        let (s, c, p) = (season(), citizen(), province());
        // final_ts = FOUNDED + 1 h < NOW; ticket bell 40 + 24 ≤ 100: closed
        let b = build(&s, &snaps(&c, &h, &p), Action::Harvest, true);
        let v = verify(&s, &c, &h, &p, &b).unwrap();
        assert!(v.became_final);
        assert_eq!(rd_u8(&b.holding, H2::STATE), Some(H2::STATE_FINAL));
        // a Citizen flag is not part of a wide flip
        assert_eq!(b.citizen[C2::FLAGS], c[C2::FLAGS]);
        // the receipt claiming no flip is refused
        let draft = EconomyReceipt {
            action: Action::Harvest,
            now_ts: NOW,
            became_final: false,
            input_digest: [0; 32],
            output_digest: [0; 32],
        };
        let body = event::encode(
            WideKind::Economy,
            100,
            &href().to_bytes(),
            &event::economy_payload(&draft).unwrap(),
            &[WideLink {
                entity: WideEntity::Holding,
                seq: 0,
                head: [0; 32],
            }],
        )
        .unwrap();
        assert!(matches!(
            stage(&body, &s, &snaps(&c, &h, &p)),
            Err(Refusal::Finality(_))
        ));
        // an open cohort of the ticket bell within 24 bells keeps it provisional
        let mut p2 = province();
        let o = PV::cohort(0);
        wr_u32(&mut p2, o + CO::BELL, 40);
        wr_u16(&mut p2, o + CO::FILED, 3);
        wr_u16(&mut p2, o + CO::SETTLED, 1);
        assert!(cohort_closed(&p2, 40, 64), "24 bells expire the cohort");
        assert!(!cohort_closed(&p2, 40, 60));
        let mut h2 = h.clone();
        wr_u32(&mut h2, H2::TICKET_BELL, 90);
        assert!(
            finality_due(&h2, &p2, NOW, 100),
            "an open cohort of another bell does not hold the flip"
        );
        let mut p3 = p2.clone();
        wr_u32(&mut p3, o + CO::BELL, 90);
        assert!(!finality_due(&h2, &p3, NOW, 100));
        let b = build(&s, &snaps(&c, &h2, &p3), Action::Harvest, false);
        assert!(!verify(&s, &c, &h2, &p3, &b).unwrap().became_final);
        // a final holding never flips again
        let (s, c, h, p, b) = run(Action::Harvest);
        assert!(!verify(&s, &c, &h, &p, &b).unwrap().became_final);
    }

    #[test]
    fn identity_state_and_season_refusals_fail_closed() {
        let (s, c, h, p, b) = run(Action::Harvest);
        let before = snaps(&c, &h, &p);
        // another record kind
        let muster = event::encode(
            WideKind::Muster,
            100,
            &event::host_key(
                &WideHostRef::new(href().key(), SITE, GEN, 1).unwrap(),
                href().key(),
            ),
            &event::muster_payload(0, 300, 17, 0, 1),
            &[
                WideLink {
                    entity: WideEntity::Province,
                    seq: 6,
                    head: [0; 32],
                },
                WideLink {
                    entity: WideEntity::Holding,
                    seq: 13,
                    head: [0; 32],
                },
            ],
        )
        .unwrap();
        assert!(matches!(
            stage(&muster, &s, &before),
            Err(Refusal::Record(_))
        ));
        // a holding of another site than the key's
        let mut x = h.clone();
        x[H2::SITE] = SITE + 1;
        assert!(matches!(
            stage(&b.record, &s, &snaps(&c, &x, &p)),
            Err(Refusal::Snapshot(_))
        ));
        // the Citizen slot not bound wide
        let mut x = c.clone();
        x[C2::holding_of_slot(SLOT) + frontier_abi::layout::player::holding_ref::GEN] =
            C2::EMPTY_GEN;
        assert!(matches!(
            stage(&b.record, &s, &snaps(&x, &h, &p)),
            Err(Refusal::Citizen(_))
        ));
        // order ≠ slot
        let mut x = h.clone();
        x[H2::ORDER] = 3;
        assert!(matches!(
            stage(&b.record, &s, &snaps(&c, &x, &p)),
            Err(Refusal::State(_))
        ));
        // not live
        let mut x = h.clone();
        x[H2::STATE] = H2::STATE_RELEASED;
        assert!(matches!(
            stage(&b.record, &s, &snaps(&c, &x, &p)),
            Err(Refusal::State(_))
        ));
        // capture pending, mirror not this holding
        let o = PV2::site(SITE as usize);
        let mut x = p.clone();
        x[o + SM::GEN] = GEN + 1;
        assert!(matches!(
            stage(&b.record, &s, &snaps(&c, &h, &x)),
            Err(Refusal::State(d)) if d.contains("capture")
        ));
        let mut x = p.clone();
        x[o + SM::STATE] = SM::STATE_FREE;
        assert!(matches!(
            stage(&b.record, &s, &snaps(&c, &h, &x)),
            Err(Refusal::Province(_))
        ));
        // the Season: version, ruleset, status, end bell, size
        let mut x = s.clone();
        wr_u16(&mut x, S::PROGRAM_VERSION, PROGRAM_VERSION_S1);
        assert!(matches!(
            stage(&b.record, &x, &before),
            Err(Refusal::Season(_))
        ));
        let mut x = s.clone();
        wr_u16(
            &mut x,
            S::PROGRAM_VERSION,
            WIDE_S1_PROGRAM_VERSION | NFT_VERSION_BIT,
        );
        assert!(
            stage(&b.record, &x, &before).is_ok(),
            "the NFT bit is allowed"
        );
        let mut x = s.clone();
        x[S::RULESET_HASH] ^= 1;
        assert!(matches!(
            stage(&b.record, &x, &before),
            Err(Refusal::Season(_))
        ));
        let mut x = s.clone();
        wr_u8(&mut x, S::STATUS, S::STATUS_ENDED);
        assert!(matches!(
            stage(&b.record, &x, &before),
            Err(Refusal::Season(_))
        ));
        let mut x = s.clone();
        wr_u32(&mut x, S::END_BELL, 100);
        assert!(matches!(
            stage(&b.record, &x, &before),
            Err(Refusal::Season(_))
        ));
        assert!(matches!(
            stage(&b.record, &s[..S::SIZE - 1], &before),
            Err(Refusal::Season(_))
        ));
        let mut x = s.clone();
        wr_u64(&mut x, S::SEASON_ID, SEASON_ID + 1);
        assert!(matches!(
            stage(&b.record, &x, &before),
            Err(Refusal::Holding(_))
        ));
        // the bell of the record is the Season's at now_ts
        let mut x = s.clone();
        wr_i64(&mut x, S::GENESIS_TS, GENESIS - 600);
        assert!(matches!(
            stage(&b.record, &x, &before),
            Err(Refusal::Record(_))
        ));
        // digests, links and whole bytes
        let mut x = s.clone();
        x[S::RSV_TAIL] ^= 1;
        assert!(matches!(
            verify_transition(
                &b.record,
                &x,
                &before,
                &snaps(&b.citizen, &b.holding, &b.province)
            ),
            Err(Refusal::Digest(_))
        ));
        let mut r = b.record.clone();
        let n = r.len();
        r[n - 1] ^= 1;
        assert!(matches!(
            verify_transition(&r, &s, &before, &snaps(&b.citizen, &b.holding, &b.province)),
            Err(Refusal::Chain(_))
        ));
        let mut x = b.holding.clone();
        wr_u64(&mut x, HDR::EVENT_SEQ, 12);
        assert!(matches!(
            verify_transition(&b.record, &s, &before, &snaps(&b.citizen, &x, &b.province)),
            Err(Refusal::Holding(_))
        ));
        let mut x = b.province.clone();
        wr_u64(&mut x, HDR::EVENT_SEQ, 6);
        assert!(matches!(
            verify_transition(&b.record, &s, &before, &snaps(&b.citizen, &b.holding, &x)),
            Err(Refusal::Province(_))
        ));
        let mut x = b.holding.clone();
        x[wide_holding::SIZE - 1] ^= 1;
        assert!(matches!(
            verify_transition(&b.record, &s, &before, &snaps(&b.citizen, &x, &b.province)),
            Err(Refusal::Holding(_))
        ));
        // a store the replay did not produce
        let mut x = b.holding.clone();
        x[H2::store(0) + accrual::VALUE] ^= 1;
        assert!(matches!(
            verify_transition(&b.record, &s, &before, &snaps(&b.citizen, &x, &b.province)),
            Err(Refusal::Holding(_))
        ));
    }

    /// The Citizen's short header is what the program's player prologue
    /// requires (`check_present(Citizen)`: magic, season). A Citizen of the
    /// wrong magic or season is refused **structurally**: the forged record
    /// is re-sealed so that its digests and links recompute over the
    /// malicious snapshots, and the refusal is still `Citizen`, naming the
    /// header field — not `Digest`, not `Chain`.
    #[test]
    fn citizen_magic_and_season_are_refused_structurally_not_by_digest() {
        let (s, c, h, p, b) = run(Action::Harvest);
        let action = Action::Harvest;
        let both = |pre: &mut Vec<u8>, post: &mut Vec<u8>, f: &dyn Fn(&mut Vec<u8>)| {
            f(pre);
            f(post);
        };
        // The re-seal itself is sound: a benign Citizen change (another
        // wallet) carried through it verifies, so a refusal below is the
        // header's and not the procedure's.
        let (mut pre, mut post) = (c.clone(), b.citizen.clone());
        both(&mut pre, &mut post, &|z| {
            wr_arr(z, C2::WALLET, &[0xCD; 32]);
        });
        let f = reseal(&s, &snaps(&pre, &h, &p), &post, &b, action, false);
        assert!(verify(&s, &pre, &h, &p, &f).is_ok(), "the re-seal is sound");
        // No layout_version requirement: the program makes none.
        let (mut pre, mut post) = (c.clone(), b.citizen.clone());
        both(&mut pre, &mut post, &|z| {
            wr_u16(z, HDR::LAYOUT_VERSION, 9);
        });
        let f = reseal(&s, &snaps(&pre, &h, &p), &post, &b, action, false);
        assert!(
            verify(&s, &pre, &h, &p, &f).is_ok(),
            "no layout_version is required"
        );
        // Wrong magic: a flipped byte, another account kind's, an unwritten
        // header.
        let flipped = {
            let mut m = C2::MAGIC;
            m[7] ^= 1;
            m
        };
        for magic in [flipped, S::MAGIC, WH::MAGIC, [0u8; 8]] {
            let (mut pre, mut post) = (c.clone(), b.citizen.clone());
            both(&mut pre, &mut post, &|z| {
                wr_arr(z, HDR::MAGIC, &magic);
            });
            let f = reseal(&s, &snaps(&pre, &h, &p), &post, &b, action, false);
            // the digests do recompute over the forged snapshots
            let dec = decode(&f.record).unwrap();
            assert_eq!(
                dec.receipt.input_digest,
                economy::input_digest(&href(), action, NOW, &s, &snaps(&pre, &h, &p)).unwrap()
            );
            assert_eq!(
                dec.receipt.output_digest,
                economy::output_digest(
                    &href(),
                    action,
                    NOW,
                    false,
                    &snaps(&post, &f.holding, &f.province)
                )
                .unwrap()
            );
            match verify(&s, &pre, &h, &p, &f) {
                Err(Refusal::Citizen(d)) => assert!(d.contains("magic"), "{d}"),
                other => panic!("magic {magic:?}: {other:?}"),
            }
            assert!(matches!(
                stage(&f.record, &s, &snaps(&pre, &h, &p)),
                Err(Refusal::Citizen(d)) if d.contains("magic")
            ));
        }
        // Wrong season: another Season's Citizen, an unwritten header.
        for id in [SEASON_ID + 1, SEASON_ID - 1, 0, u64::MAX] {
            let (mut pre, mut post) = (c.clone(), b.citizen.clone());
            both(&mut pre, &mut post, &|z| {
                wr_u64(z, HDR::SEASON_ID, id);
            });
            let f = reseal(&s, &snaps(&pre, &h, &p), &post, &b, action, false);
            let dec = decode(&f.record).unwrap();
            assert_eq!(
                dec.receipt.input_digest,
                economy::input_digest(&href(), action, NOW, &s, &snaps(&pre, &h, &p)).unwrap()
            );
            match verify(&s, &pre, &h, &p, &f) {
                Err(Refusal::Citizen(d)) => assert!(d.contains("season"), "{d}"),
                other => panic!("season {id}: {other:?}"),
            }
            assert!(matches!(
                stage(&f.record, &s, &snaps(&pre, &h, &p)),
                Err(Refusal::Citizen(d)) if d.contains("season")
            ));
        }
        // The header is judged before the slot binding: a Citizen of the
        // wrong season with no wide binding is refused for the season.
        let mut pre = c.clone();
        wr_u64(&mut pre, HDR::SEASON_ID, SEASON_ID + 1);
        pre[C2::holding_of_slot(SLOT) + frontier_abi::layout::player::holding_ref::GEN] =
            C2::EMPTY_GEN;
        assert!(matches!(
            stage(&b.record, &s, &snaps(&pre, &h, &p)),
            Err(Refusal::Citizen(d)) if d.contains("season")
        ));
        // A short Citizen is the ABI's own refusal, before the header.
        assert!(matches!(
            stage(&b.record, &s, &snaps(&c[..C2::SIZE - 1], &h, &p)),
            Err(Refusal::Snapshot(_))
        ));
        // The check on its own.
        assert_eq!(check_citizen_header(&c, SEASON_ID), Ok(()));
        assert!(matches!(
            check_citizen_header(&c[..HDR::LAYOUT_VERSION - 1], SEASON_ID),
            Err(Refusal::Citizen(d)) if d.contains("short")
        ));
        assert!(matches!(
            check_citizen_header(&c, SEASON_ID + 1),
            Err(Refusal::Citizen(d)) if d.contains("season")
        ));
    }

    /// The numeric preflight: a holding whose stored numbers the replay's
    /// arithmetic cannot represent is **refused**, by `stage` directly and
    /// by `verify_transition` over a record whose input digest and links
    /// are sealed over it (so the refusal is the preflight's, not the
    /// digest's or the chain's) — never overflowed into a panic. The
    /// canonical holding, and a store at the edge of the canonical
    /// fraction, verify as before.
    #[test]
    fn unrepresentable_holding_numbers_are_refused_not_overflowed() {
        let (c, p) = (citizen(), province());
        let actions = [Action::Harvest, Action::Build { item: 0 }];
        let check = |season: &[u8], holding: &[u8], now: i64, what: &str| {
            for action in actions {
                let before = snaps(&c, holding, &p);
                let r = sealed_input(season, &before, action, now);
                match stage(&r, season, &before) {
                    Err(Refusal::Holding(d)) => assert!(d.contains(what), "{action:?} stage: {d}"),
                    other => panic!("{action:?} stage, {what}: {other:?}"),
                }
                // the post-state is never reached: the pre-state serves
                let after = snaps(&c, holding, &p);
                match verify_transition(&r, season, &before, &after) {
                    Err(Refusal::Holding(d)) => assert!(d.contains(what), "{action:?} verify: {d}"),
                    other => panic!("{action:?} verify, {what}: {other:?}"),
                }
            }
        };
        let s = season();
        // terrain ore at the top of i64: ore × (100 + bonus) has no i64
        let mut x = holding();
        wr_i64(&mut x, H2::TERRAIN_ORE, i64::MAX);
        check(&s, &x, NOW, "terrain ore");
        // the last owner action at the top of i64: + DORMANT_AFTER has none
        let mut x = holding();
        wr_i64(&mut x, H2::LAST_OWNER_ACTION, i64::MAX);
        check(&s, &x, NOW, "dormancy");
        // now_ts near i64::MAX under a Season whose genesis is near it too
        // (a Running Season, end bell 4,000, record bell 100: every
        // structural check passes; the holding's times are shifted along)
        let g = i64::MAX - 100_000;
        let shift = g - GENESIS;
        let now = NOW + shift;
        let mut sz = season();
        wr_i64(&mut sz, S::GENESIS_TS, g);
        let sf = read_season(&sz, now).unwrap();
        assert_eq!(sf.now_bell, 100);
        let mut x = holding();
        shift_times(&mut x, shift);
        assert_eq!(rd_i64(&x, H2::LAST_OWNER_ACTION), Some(FOUNDED + shift));
        check(&sz, &x, now, "dormancy");
        // a store's t0 at the bottom of i64: now − t0 has no i64
        let mut x = holding();
        wr_i64(&mut x, H2::store(0) + accrual::T0, i64::MIN);
        check(&s, &x, NOW, "settle instant");
        // a store's fraction outside the kernel's canonical 0 ≤ frac < HOUR
        let ore_store = H2::store(Resource::Ore as usize) + accrual::FRAC;
        for frac in [-1, HOUR, i64::MIN, i64::MAX] {
            let mut x = holding();
            wr_i64(&mut x, ore_store, frac);
            check(&s, &x, NOW, "fraction");
        }
        // the edge of the canonical fraction is canonical: it stages and
        // verifies through the normal path
        let mut x = holding();
        wr_i64(&mut x, ore_store, HOUR - 1);
        let b = build(&s, &snaps(&c, &x, &p), Action::Harvest, false);
        assert!(verify(&s, &c, &x, &p, &b).is_ok());
        // the preflight on its own over the canonical kernel holding
        let k = hold::read(&holding()).unwrap();
        assert_eq!(preflight_holding(&k, ORE, NOW), Ok(()));
        assert_eq!(
            preflight_holding(&k, 0, NOW),
            Ok(()),
            "no ore is no product"
        );
        assert_eq!(
            preflight_holding(&k, -1, NOW),
            Ok(()),
            "negative ore is max(0)"
        );
        // the canonical holding is untouched: every self-built record still
        // verifies (the preflight is no economic rule)
        for action in actions {
            let (s, c, h, p, b) = run(action);
            assert!(verify(&s, &c, &h, &p, &b).is_ok(), "{action:?}");
        }
    }

    /// The input digest is judged before the staging: a pre-state the
    /// receipt does not commit to is refused as `Digest`, whatever its
    /// numbers, and the replay never sees it. The same bytes under a
    /// re-sealed receipt reach the preflight's `Holding` refusal.
    #[test]
    fn input_digest_is_judged_before_any_arithmetic() {
        let (s, c, h, p, b) = run(Action::Build { item: 0 });
        let after = snaps(&b.citizen, &b.holding, &b.province);
        let mut x = h.clone();
        wr_i64(&mut x, H2::TERRAIN_ORE, i64::MAX);
        assert!(matches!(
            verify_transition(&b.record, &s, &snaps(&c, &x, &p), &after),
            Err(Refusal::Digest(_))
        ));
        let r = sealed_input(&s, &snaps(&c, &x, &p), Action::Build { item: 0 }, NOW);
        assert!(matches!(
            verify_transition(&r, &s, &snaps(&c, &x, &p), &after),
            Err(Refusal::Holding(d)) if d.contains("terrain ore")
        ));
        // a snapshot the digest cannot even validate is the ABI's refusal
        assert!(matches!(
            verify_transition(&b.record, &s, &snaps(&c, &h[..WH::SIZE - 1], &p), &after),
            Err(Refusal::Snapshot(_))
        ));
    }
}
