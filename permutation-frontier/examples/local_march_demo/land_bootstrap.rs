//! **LOCAL synthetic land bootstrap** for the keyless march sandbox
//! (2026-11-08). See `docs/frontier/map-growth/LOCAL-LAND-BOOTSTRAP-20261108.md`.
//!
//! **Compiled, not yet called.** `main.rs` declares this module so it builds
//! and its tests run, but no controller calls it yet; the engine/protocol
//! wiring follows the concurrent work. It depends only on committed pieces: the
//! fixture account names `season`, `payer`, `system`, `origin` and
//! `destination`, the committed `metadata.tsv` keys, and
//! `runtime::{Image, Meta, dispatch, PROGRAM}`.
//!
//! **What it does.** [`verify_initial_evidence`] checks the exported Season,
//! world, authority, payer and both original provinces (address, identity,
//! ring seed `[0x81; 32]`, seed round 32,547,581, opened bell 1, region,
//! funded lamports) and recomputes the ring seed's round from the Season
//! clock. [`bootstrap_records`] writes three kinds of explicit LOCAL records
//! through the ABI codecs at their canonical with-seed addresses: the wide
//! ring seed of ring 129, the original prototype rules configuration v1
//! `RuleBytes{1,2,2,1}` under the Season's authority, and six wedge funds
//! with zero counters. [`golden_gate`] re-opens BOTH original provinces with
//! the real WideOpenProvince handler at the original bell 1 in a SCRATCH map
//! and compares the source-supported immutable ranges with the exported
//! images. [`install`] runs the three and commits the records only when all
//! pass. [`open_province`] opens another ring-129 province with the real
//! handler at the caller's simulated time, staged on a copy of the whole map
//! and judged before commit.
//!
//! **What it never does.** No WideRequestRingSeed, WideConsumeRingSeed or
//! WideSetRules call and no claim that one ran; no key generation or
//! derivation, no signature, no seal, no network, no file write. Public
//! PDA / with-seed arithmetic only. The payer's signer flag is the runtime's
//! local fixture flag, not authentication.
#![allow(dead_code)] // Integration pending: no controller calls this module yet.

use std::collections::BTreeMap;
use std::ops::Range;

use crate::runtime::{self, Image, Meta, PROGRAM};
use frontier_abi::addr::AddrCtx;
use frontier_abi::bytes::{rd_arr, rd_i64, rd_u16, rd_u32, rd_u64, rd_u8, wr_u32, wr_u64, wr_u8};
use frontier_abi::layout::header;
use frontier_abi::layout::world::{province_fund as PF, season as S};
use frontier_abi::prologue::ids::SYSTEM_PROGRAM;
use frontier_abi::v2::layout::province::province as PV2;
use frontier_abi::v2::layout::{write_header, AccountKind as K2};
use frontier_abi::world_index::land::{self as wl, SeedStatus, WideProvince, WideRingSeed};
use frontier_abi::world_index::rules::{
    self as wr, CampRule, FreeCityRule, KeepHolderRule, RegionRule, RuleBytes, WideRulesConfig,
};
use frontier_abi::world_index::wide_ix::{self as wix, WIDE_EXPERIMENTAL_VERSION_BIT};
use frontier_abi::world_index::{WideCoord, WorldId, FIRST_WIDE_RING};
use permutation_frontier::clock::SeasonClock;
use permutation_frontier::proc::map::encode_terrain;
use permutation_rules::frontier::beacon::{bell_at, bell_start, ring_seed_round};
use permutation_rules::frontier::terrain::wide::generate_province_wide;
use solana_program::rent::Rent;

/// The sandbox's named account images (the runtime's input).
pub type Images = BTreeMap<String, Image>;
/// The committed `metadata.tsv` pairs.
pub type Metadata = BTreeMap<String, String>;

// ------------------------------------------------------------ pins

/// The one ring this slice can open: the first wide ring.
pub const LAND_RING: u64 = FIRST_WIDE_RING;
const _: () = assert!(LAND_RING == 129);

/// The exported Season's id (`map_growth_runtime_tests::SEASON_ID`).
pub const ORIGINAL_SEASON_ID: u64 = 11;
/// The Season's stored authority (`wide_land_runtime_tests::AUTHORITY`),
/// checked against the exported Season bytes.
pub const ORIGINAL_AUTHORITY: [u8; 32] = [0xaa; 32];
/// The literal payer of the exported world (`PAYER`).
pub const ORIGINAL_PAYER: [u8; 32] = [0xd4; 32];
/// The literal ring-129 seed (`RING129_SEED`), as both exported province
/// trailers store it. A test literal, never a beacon output.
pub const ORIGINAL_RING_SEED: [u8; 32] = [0x81; 32];
/// The ring seed's round as both exported trailers store it.
pub const ORIGINAL_SEED_ROUND: u64 = 32_547_581;
/// Source-inferred (no exported byte holds it): the request ran after
/// `w.at(1, 0)`, so `opened_bell` 1 and `t_open = bell_start(1)`.
pub const ORIGINAL_RING_OPENED_BELL: u32 = 1;
/// The original provinces' opened bell (stored in both prefixes).
pub const ORIGINAL_OPEN_BELL: u32 = 1;
/// Source-inferred: origin, destination and the exporter's third
/// province (not exported) were opened from the record.
pub const ORIGINAL_PROVINCES_CREATED: u64 = 3;
/// The original harness's candidate bytes (`wide_land_runtime_tests::RULES`):
/// a test choice, not a product rule.
pub const ORIGINAL_RULES: RuleBytes = RuleBytes {
    keep_holder: KeepHolderRule::MixedInterleaved as u8,
    free_city: FreeCityRule::CanonicalHashV1 as u8,
    camp: CampRule::SortKeyDrawV1 as u8,
    region: RegionRule::SortKeyHashV1 as u8,
};
const _: () = assert!(
    ORIGINAL_RULES.keep_holder == 1
        && ORIGINAL_RULES.free_city == 2
        && ORIGINAL_RULES.camp == 2
        && ORIGINAL_RULES.region == 1
);
pub const ORIGINAL_ORIGIN: (i64, i64) = (129, 0);
pub const ORIGINAL_DESTINATION: (i64, i64) = (129, -1);

/// Demo budget of additional provinces (a transport bound, not a game
/// rule). Each wedge fund is funded for exactly this many openings.
pub const MAX_EXTRA_PROVINCES: usize = 4;
/// Demo bound on the image map (the engine's fixture load bound).
pub const MAX_TOTAL_IMAGES: usize = 96;

pub const RING_SEED_NAME: &str = "land_ring_seed_129";
pub const RULES_CONFIG_NAME: &str = "land_rules_config";
pub const PROVINCE_PREFIX: &str = "land_province_";
/// Every image this module adds starts with this.
pub const LAND_PREFIX: &str = "land_";

/// Provenance of every province [`open_province`] adds.
pub const PROVENANCE_OPENED: &str = "REAL_HANDLER_OUTPUT_AT_SUPPLIED_TIME";

/// Labels the UI should show beside land the bootstrap touched:
/// `(record, label: meaning)`.
pub const EVIDENCE_LABELS: [(&str, &str); 8] = [
    (
        "land_ring_seed_129",
        "LOCAL_SYNTHETIC_RING_SEED: seed 0x81.. and round 32547581 copied from the exported \
         province trailers, status Seeded as the harness's seed_as_consume_would; not a verified \
         beacon output; opened bell 1, t_open, provinces_created 3 and payer are source-inferred",
    ),
    (
        "land_rules_config",
        "PROTOTYPE_CANDIDATE_RULES_V1: the original harness's RuleBytes{1,2,2,1} under the \
         Season's stored authority; candidates, not product rules; no SetRules ran",
    ),
    (
        "land_fund_*",
        "LOCAL_FIXTURE_FUNDS: zero counters and demo-budget lamports; no provenance; not the \
         exporter's fund state",
    ),
    (
        "golden_gate",
        "GOLDEN_REOPEN_STATIC_FIELDS_MATCH: the real handler re-opened both original provinces at \
         bell 1 from these records and reproduced their header identity, prefix identity, opened \
         bell, terrain block (incl. passable and rough masks) and trailer; keep, camp, site \
         mirror, road and explored masks and the event chain not compared",
    ),
    (
        "land_province_*",
        "REAL_HANDLER_OUTPUT_AT_SUPPLIED_TIME: WideOpenProvince executed in-process at the \
         controller's simulated time; never precomputed",
    ),
    ("auth", "MOCK_PAYER_SIGNER_FLAG_NO_SIGNATURE"),
    (
        "resolve_history",
        "NO_RESOLVE_HISTORY: a new province starts at resolved_next = its opening bell with no \
         staged beacon pairs; not yet a march destination",
    ),
    (
        "budget",
        "DEMO_BUDGET_4_EXTRA_PROVINCES: transport bound, not a game rule",
    ),
];

// ------------------------------------------------------------ golden ranges

/// Ranges the golden gate requires equal. Each is written only at the
/// opening: the chained header's identity (the chain itself excluded), the
/// prefix `P`/`Q`/`RING` zero, `WEDGE`, `REGION`, `OPENED_BELL`, the terrain
/// block up to the road mask (terrain, resources, sites, site count, masks
/// passable and rough: `encode_terrain` is their only writer in the crate)
/// and the whole wide trailer (`write_identity`).
pub const GATED: [(&str, Range<usize>); 5] = [
    ("header_identity", 0..header::EVENT_SEQ),
    ("prefix_identity", PV2::P..PV2::RESOLVED_NEXT),
    ("opened_bell", PV2::OPENED_BELL..PV2::RELATIONS),
    ("terrain", PV2::TERRAIN..PV2::ROAD_MASK),
    ("trailer", wl::province::TRAILER..wl::province::SIZE),
];

/// Ranges reported but never gating: gameplay or the exporter may change
/// them after the opening (resolves, Explore writes `EXPLORED_MASK`, the
/// keep, camp and site mirror evolve, every receipt advances the chain).
pub const INFORMATIONAL: [(&str, Range<usize>); 7] = [
    ("event_chain", header::EVENT_SEQ..PV2::P),
    ("resolved_next", PV2::RESOLVED_NEXT..PV2::OPENED_BELL),
    ("road_and_explored_masks", PV2::ROAD_MASK..PV2::SITE_MIRROR),
    ("site_mirror", PV2::SITE_MIRROR..PV2::ENTRIES),
    ("camp", PV2::CAMP..PV2::TICKET_COHORTS),
    ("keep", PV2::KEEP..PV2::SNAP),
    ("score_next_bell", PV2::SCORE_NEXT_BELL..PV2::FORTS),
];

// ------------------------------------------------------------ reports

/// What the Season image says. Its key is checked to equal the Season PDA
/// recomputed from its stored id and bump (canonical-address consistency);
/// that equality does not authenticate the snapshot's bytes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LandContext {
    pub season_key: [u8; 32],
    pub season_id: u64,
    pub world: WorldId,
    pub genesis_ts: i64,
    pub authority: [u8; 32],
}

/// The checked initial evidence the records are built from.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct InitialEvidence {
    pub land: LandContext,
    pub ring_seed: [u8; 32],
    pub seed_round: u64,
    pub ring_t_open: i64,
    pub origin: WideProvince,
    pub destination: WideProvince,
}

/// One golden re-opening.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GoldenProvince {
    pub label: &'static str,
    pub p: i64,
    pub q: i64,
    /// Every [`GATED`] range, all equal (a mismatch is an error instead).
    pub gated: Vec<&'static str>,
    /// Every [`INFORMATIONAL`] range and whether it happens to be equal.
    pub informational: Vec<(&'static str, bool)>,
    pub lamports_equal: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GoldenReport {
    pub provinces: Vec<GoldenProvince>,
    pub open_ts: i64,
    pub open_bell: u32,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LandInstall {
    pub evidence: InitialEvidence,
    pub golden: GoldenReport,
    /// The names added, in map order.
    pub records: Vec<String>,
}

/// A province [`open_province`] added.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OpenedProvince {
    pub name: String,
    pub p: i64,
    pub q: i64,
    pub key: [u8; 32],
    pub wedge: u8,
    pub region: u8,
    pub opened_bell: u32,
    pub site_count: u8,
    pub funded_lamports: u64,
    pub provenance: &'static str,
}

// ------------------------------------------------------------ helpers

/// The rent the handler sees in the sandbox (`init::rent` under the
/// local-march scope is `Rent::default()`).
fn rent(space: usize) -> u64 {
    Rent::default().minimum_balance(space)
}

/// Lamports of each LOCAL wedge fund: its own rent plus the demo budget of
/// province rents.
pub fn fund_lamports() -> u64 {
    rent(PF::SIZE) + MAX_EXTRA_PROVINCES as u64 * rent(wl::province::SIZE)
}

fn ctx_of(season: [u8; 32]) -> AddrCtx {
    AddrCtx {
        season,
        program: PROGRAM,
    }
}

pub fn fund_name(wedge: u8) -> String {
    format!("land_fund_{wedge}")
}

pub fn province_name(coord: WideCoord) -> String {
    let (p, q) = (coord.p(), coord.q());
    format!("land_province_{p}_{q}")
}

fn image<'a>(images: &'a Images, name: &str) -> Result<&'a Image, String> {
    images
        .get(name)
        .ok_or_else(|| format!("LAND_MISSING:{name}"))
}

fn acct(name: &str, signer: bool, writable: bool) -> Meta {
    Meta {
        name: name.into(),
        signer,
        writable,
    }
}

fn unhex(s: &str) -> Option<Vec<u8>> {
    if s.len() % 2 != 0 {
        return None;
    }
    (0..s.len())
        .step_by(2)
        .map(|i| s.get(i..i + 2).and_then(|h| u8::from_str_radix(h, 16).ok()))
        .collect()
}

fn meta_str<'a>(meta: &'a Metadata, k: &str) -> Result<&'a str, String> {
    meta.get(k)
        .map(String::as_str)
        .ok_or_else(|| format!("LAND_EVIDENCE_META:{k}"))
}

fn meta_num<T: std::str::FromStr>(meta: &Metadata, k: &str) -> Result<T, String> {
    meta_str(meta, k)?
        .parse::<T>()
        .map_err(|_| format!("LAND_EVIDENCE_META:{k}"))
}

fn meta_hex32(meta: &Metadata, k: &str) -> Result<[u8; 32], String> {
    unhex(meta_str(meta, k)?)
        .and_then(|v| <[u8; 32]>::try_from(v).ok())
        .ok_or_else(|| format!("LAND_EVIDENCE_META:{k}"))
}

fn add32(d: &mut [u8], off: usize, v: u32) -> bool {
    match rd_u32(d, off).and_then(|x| x.checked_add(v)) {
        Some(x) => wr_u32(d, off, x),
        None => false,
    }
}

fn add64(d: &mut [u8], off: usize, v: u64) -> bool {
    match rd_u64(d, off).and_then(|x| x.checked_add(v)) {
        Some(x) => wr_u64(d, off, x),
        None => false,
    }
}

/// Lamports of a map, each account key counted once.
fn total_lamports(m: &Images) -> u128 {
    let mut by_key = BTreeMap::new();
    for im in m.values() {
        by_key.entry(im.key).or_insert(im.lamports);
    }
    by_key.values().map(|l| u128::from(*l)).sum()
}

fn extra_provinces(images: &Images) -> usize {
    images
        .keys()
        .filter(|n| n.starts_with(PROVINCE_PREFIX))
        .count()
}

// ------------------------------------------------------------ evidence

/// The Season image: program-owned, Season magic, at the PDA of its stored
/// id and bump, Seeded/Running, this experimental build's version bit.
pub fn season_context(images: &Images) -> Result<LandContext, String> {
    const KIND: &str = "LAND_EVIDENCE_SEASON_KIND";
    let s = image(images, "season")?;
    let d = &s.data;
    if s.owner != PROGRAM || rd_arr::<8>(d, header::MAGIC) != Some(S::MAGIC) {
        return Err(KIND.into());
    }
    let id = rd_u64(d, header::SEASON_ID).ok_or(KIND)?;
    let bump = rd_u8(d, S::BUMP).ok_or(KIND)?;
    if permutation_frontier::addr::season_pda(id, bump, &PROGRAM) != s.key {
        return Err("LAND_EVIDENCE_SEASON_ADDRESS".into());
    }
    let status = rd_u8(d, S::STATUS).ok_or(KIND)?;
    if status != S::STATUS_RUNNING && status != S::STATUS_SEEDED {
        return Err("LAND_EVIDENCE_SEASON_STATUS".into());
    }
    let version = rd_u16(d, S::PROGRAM_VERSION).ok_or(KIND)?;
    if (version & WIDE_EXPERIMENTAL_VERSION_BIT) == 0 {
        return Err("LAND_EVIDENCE_SEASON_VERSION".into());
    }
    let genesis_ts = rd_i64(d, S::GENESIS_TS).ok_or(KIND)?;
    let authority = rd_arr::<32>(d, S::AUTHORITY).ok_or(KIND)?;
    let world =
        WorldId::derive_legacy_season(&s.key, &PROGRAM).map_err(|_| "LAND_EVIDENCE_WORLD")?;
    Ok(LandContext {
        season_key: s.key,
        season_id: id,
        world,
        genesis_ts,
        authority,
    })
}

/// One exported original province, checked against the pins.
fn original_province(
    images: &Images,
    land: &LandContext,
    name: &str,
    pq: (i64, i64),
    region: u8,
) -> Result<WideProvince, String> {
    let im = image(images, name)?;
    let coord = WideCoord::checked(pq.0, pq.1).map_err(|_| "LAND_EVIDENCE_COORD")?;
    let p = WideProvince::read(&im.data).map_err(|_| format!("LAND_EVIDENCE_PROVINCE:{name}"))?;
    if im.owner != PROGRAM || im.key != wl::province_address(&ctx_of(land.season_key), coord) {
        return Err(format!("LAND_EVIDENCE_ADDRESS:{name}"));
    }
    if p.coord != coord || p.season_id != land.season_id || p.world != land.world {
        return Err(format!("LAND_EVIDENCE_IDENTITY:{name}"));
    }
    if p.ring_seed != ORIGINAL_RING_SEED {
        return Err(format!("LAND_EVIDENCE_RING_SEED:{name}"));
    }
    if p.seed_round != ORIGINAL_SEED_ROUND {
        return Err(format!("LAND_EVIDENCE_SEED_ROUND:{name}"));
    }
    if p.opened_bell != ORIGINAL_OPEN_BELL {
        return Err(format!("LAND_EVIDENCE_OPENED_BELL:{name}"));
    }
    if Some(p.wedge) != coord.wedge() || p.region != region || p.region != wr::wide_region(coord) {
        return Err(format!("LAND_EVIDENCE_REGION:{name}"));
    }
    if p.funded_lamports != rent(wl::province::SIZE) {
        return Err(format!("LAND_EVIDENCE_FUNDED:{name}"));
    }
    Ok(p)
}

/// Checks the exported initial images and metadata against the pins and
/// recomputes the ring seed's round from the Season's clock
/// (`ring_seed_round(t_open = bell_start(1))`). Reads only.
pub fn verify_initial_evidence(
    images: &Images,
    meta: &Metadata,
) -> Result<InitialEvidence, String> {
    let land = season_context(images)?;
    if land.season_id != ORIGINAL_SEASON_ID {
        return Err("LAND_EVIDENCE_SEASON_ID".into());
    }
    if land.authority != ORIGINAL_AUTHORITY {
        return Err("LAND_EVIDENCE_AUTHORITY".into());
    }
    if meta_hex32(meta, "world")? != *land.world.as_bytes() {
        return Err("LAND_EVIDENCE_WORLD".into());
    }
    if meta_num::<i64>(meta, "genesis")? != land.genesis_ts {
        return Err("LAND_EVIDENCE_GENESIS".into());
    }
    for (k, v) in [
        ("origin_p", ORIGINAL_ORIGIN.0),
        ("origin_q", ORIGINAL_ORIGIN.1),
        ("destination_p", ORIGINAL_DESTINATION.0),
        ("destination_q", ORIGINAL_DESTINATION.1),
    ] {
        if meta_num::<i64>(meta, k)? != v {
            return Err(format!("LAND_EVIDENCE_META:{k}"));
        }
    }
    let payer = image(images, "payer")?;
    if payer.key != ORIGINAL_PAYER || payer.owner != SYSTEM_PROGRAM || !payer.data.is_empty() {
        return Err("LAND_EVIDENCE_PAYER".into());
    }
    if image(images, "system")?.key != SYSTEM_PROGRAM {
        return Err("LAND_EVIDENCE_SYSTEM".into());
    }
    let origin = original_province(
        images,
        &land,
        "origin",
        ORIGINAL_ORIGIN,
        meta_num(meta, "origin_region")?,
    )?;
    let destination = original_province(
        images,
        &land,
        "destination",
        ORIGINAL_DESTINATION,
        meta_num(meta, "region")?,
    )?;
    let clock = SeasonClock::read(&image(images, "season")?.data)
        .map_err(|_| "LAND_EVIDENCE_SEASON_CLOCK")?;
    let ring_t_open = bell_start(land.genesis_ts, ORIGINAL_RING_OPENED_BELL);
    if ring_seed_round(&clock.beacon(), ring_t_open, clock.seed_margin) != ORIGINAL_SEED_ROUND {
        return Err("LAND_EVIDENCE_ROUND_RECOMPUTE".into());
    }
    Ok(InitialEvidence {
        land,
        ring_seed: ORIGINAL_RING_SEED,
        seed_round: ORIGINAL_SEED_ROUND,
        ring_t_open,
        origin,
        destination,
    })
}

// ------------------------------------------------------------ records

/// The LOCAL ring-129 seed record: the trailers' seed and round, Seeded as
/// the harness's `seed_as_consume_would` leaves it; the request fields
/// (`opened_bell`, `t_open`, `provinces_created`, `payer`) source-inferred.
pub fn ring_seed_record(ev: &InitialEvidence) -> WideRingSeed {
    WideRingSeed {
        season_id: ev.land.season_id,
        world: ev.land.world,
        ring: LAND_RING,
        status: SeedStatus::Seeded,
        opened_bell: ORIGINAL_RING_OPENED_BELL,
        t_open: ev.ring_t_open,
        round: ev.seed_round,
        seed: ev.ring_seed,
        provinces_created: ORIGINAL_PROVINCES_CREATED,
        payer: ORIGINAL_PAYER,
    }
}

/// The records to add, through the ABI codecs, at their canonical
/// with-seed addresses, program-owned and rent-exempt: the ring seed, the
/// rules configuration and six wedge funds (zero counters, demo lamports).
pub fn bootstrap_records(ev: &InitialEvidence) -> Result<Images, String> {
    let ctx = ctx_of(ev.land.season_key);
    let mut out = Images::new();
    let mut seed = vec![0u8; wl::ring_seed::SIZE];
    ring_seed_record(ev)
        .write(&mut seed)
        .map_err(|_| "LAND_RECORD_RING_SEED")?;
    out.insert(
        RING_SEED_NAME.into(),
        Image {
            key: wl::ring_seed_address(&ctx, LAND_RING),
            owner: PROGRAM,
            lamports: rent(wl::ring_seed::SIZE),
            data: seed,
        },
    );
    let cfg = WideRulesConfig::new(
        ev.land.season_id,
        ev.land.world,
        ev.land.authority,
        ORIGINAL_RULES,
    )
    .map_err(|_| "LAND_RECORD_RULES")?;
    let mut config = vec![0u8; wr::rules_config::SIZE];
    cfg.write(&mut config).map_err(|_| "LAND_RECORD_RULES")?;
    out.insert(
        RULES_CONFIG_NAME.into(),
        Image {
            key: wr::rules_config_address(&ctx),
            owner: PROGRAM,
            lamports: rent(wr::rules_config::SIZE),
            data: config,
        },
    );
    for wedge in 0..PF::WEDGES as u8 {
        let mut d = vec![0u8; K2::ProvinceFund.size()];
        if !write_header(&mut d, K2::ProvinceFund, ev.land.season_id)
            || !wr_u8(&mut d, PF::WEDGE, wedge)
        {
            return Err("LAND_RECORD_FUND".into());
        }
        out.insert(
            fund_name(wedge),
            Image {
                key: ctx.province_fund(wedge),
                owner: PROGRAM,
                lamports: fund_lamports(),
                data: d,
            },
        );
    }
    Ok(out)
}

/// The installed records, each at its canonical address with its owner and
/// size; returns the ring seed record (Seeded or not: the caller decides).
fn installed(images: &Images, land: &LandContext) -> Result<WideRingSeed, String> {
    let ctx = ctx_of(land.season_key);
    let rs = image(images, RING_SEED_NAME)?;
    if rs.key != wl::ring_seed_address(&ctx, LAND_RING)
        || rs.owner != PROGRAM
        || rs.data.len() != wl::ring_seed::SIZE
    {
        return Err("LAND_RING_SEED_RECORD".into());
    }
    let seed = WideRingSeed::read(&rs.data).map_err(|_| "LAND_RING_SEED_RECORD")?;
    if seed.ring != LAND_RING || seed.world != land.world || seed.season_id != land.season_id {
        return Err("LAND_RING_SEED_RECORD".into());
    }
    let cf = image(images, RULES_CONFIG_NAME)?;
    if cf.key != wr::rules_config_address(&ctx) || cf.owner != PROGRAM {
        return Err("LAND_RULES_CONFIG".into());
    }
    let cfg = WideRulesConfig::read(&cf.data).map_err(|_| "LAND_RULES_CONFIG")?;
    if cfg.bytes() != ORIGINAL_RULES
        || cfg.authority != land.authority
        || cfg.world != land.world
        || cfg.season_id != land.season_id
    {
        return Err("LAND_RULES_CONFIG".into());
    }
    for wedge in 0..PF::WEDGES as u8 {
        let f = image(images, &fund_name(wedge))?;
        if f.key != ctx.province_fund(wedge)
            || f.owner != PROGRAM
            || f.data.len() != PF::SIZE
            || rd_arr::<8>(&f.data, header::MAGIC) != Some(PF::MAGIC)
            || rd_u64(&f.data, header::SEASON_ID) != Some(land.season_id)
            || rd_u8(&f.data, PF::WEDGE) != Some(wedge)
        {
            return Err(format!("LAND_FUND_RECORD:{wedge}"));
        }
    }
    Ok(seed)
}

// ------------------------------------------------------------ opening

/// One WideOpenProvince: the target and its wedge's fund.
#[derive(Clone, Debug, PartialEq, Eq)]
struct OpenPlan {
    coord: WideCoord,
    wedge: u8,
    target_name: String,
    target_key: [u8; 32],
    fund_name: String,
}

fn plan_target(
    land: &LandContext,
    coord: WideCoord,
    target_name: String,
) -> Result<OpenPlan, String> {
    let wedge = coord.wedge().ok_or("LAND_NOT_RING_129")?;
    Ok(OpenPlan {
        coord,
        wedge,
        target_name,
        target_key: wl::province_address(&ctx_of(land.season_key), coord),
        fund_name: fund_name(wedge),
    })
}

/// Stages the whole map (a copy), adds the absent target if the name is
/// new, and dispatches the real handler with the deployed account list
/// `[payer s,w] [season r] [ring seed w] [fund w] [province w] [config r]
/// [system r]`. The caller's map is never touched; the runtime commits into
/// the copy only after its own account, owner, lamport and log checks.
fn stage_open(
    images: &Images,
    plan: &OpenPlan,
    now: i64,
    slot: u64,
) -> Result<(Images, Vec<Vec<u8>>), String> {
    let mut stage = images.clone();
    stage.entry(plan.target_name.clone()).or_insert(Image {
        key: plan.target_key,
        owner: SYSTEM_PROGRAM,
        lamports: 0,
        data: Vec::new(),
    });
    let metas = [
        acct("payer", true, true),
        acct("season", false, false),
        acct(RING_SEED_NAME, false, true),
        acct(&plan.fund_name, false, true),
        acct(&plan.target_name, false, true),
        acct(RULES_CONFIG_NAME, false, false),
        acct("system", false, false),
    ];
    let data = wix::OpenProvince {
        p: plan.coord.p(),
        q: plan.coord.q(),
    }
    .to_bytes();
    let records = runtime::dispatch(&mut stage, &metas, &data, now, slot, false)?;
    Ok((stage, records))
}

/// Judges a staged opening against the map before it. Allowed changes
/// only: the new target (canonical address, program-owned, exact size and
/// rent, a fresh chain, the identity of this coordinate, world, ring seed,
/// round and supplied bell, the kernel's terrain), the wedge fund (lamports
/// down by exactly the target's, exactly the four counters the handler
/// keeps) and the ring seed (`provinces_created + 1`, nothing else). Every
/// other image byte-identical; no image added or removed but the target;
/// lamports conserved by key.
fn judge_open(
    before: &Images,
    after: &Images,
    plan: &OpenPlan,
    now: i64,
) -> Result<OpenedProvince, String> {
    let land = season_context(before)?;
    if before.contains_key(&plan.target_name) {
        return Err("LAND_TARGET_PRESENT".into());
    }
    let added: Vec<&String> = after.keys().filter(|n| !before.contains_key(*n)).collect();
    if before.keys().any(|n| !after.contains_key(n))
        || added.len() != 1
        || *added[0] != plan.target_name
    {
        return Err("LAND_NAME_SET".into());
    }
    for (name, b) in before {
        if name == RING_SEED_NAME || *name == plan.fund_name {
            continue;
        }
        if after.get(name) != Some(b) {
            return Err(format!("LAND_FOREIGN_WRITE:{name}"));
        }
    }
    // The ring seed: one more province, nothing else.
    let (rb, ra) = (
        image(before, RING_SEED_NAME)?,
        image(after, RING_SEED_NAME)?,
    );
    if ra.key != rb.key || ra.owner != rb.owner || ra.lamports != rb.lamports {
        return Err("LAND_RING_SEED_DELTA".into());
    }
    let sb = WideRingSeed::read(&rb.data).map_err(|_| "LAND_RING_SEED_DELTA")?;
    let sa = WideRingSeed::read(&ra.data).map_err(|_| "LAND_RING_SEED_DELTA")?;
    if sb.with_province_created().ok() != Some(sa) {
        return Err("LAND_RING_SEED_DELTA".into());
    }
    // The target.
    let t = image(after, &plan.target_name)?;
    if t.key != plan.target_key
        || t.owner != PROGRAM
        || t.data.len() != wl::province::SIZE
        || t.lamports != rent(wl::province::SIZE)
    {
        return Err("LAND_TARGET_SHAPE".into());
    }
    let bell = bell_at(land.genesis_ts, now).ok_or("LAND_TIME_BEFORE_GENESIS")?;
    let p = WideProvince::read(&t.data).map_err(|_| "LAND_TARGET_IDENTITY")?;
    let fresh_chain = rd_u64(&t.data, header::EVENT_SEQ) == Some(0)
        && rd_arr::<32>(&t.data, header::EVENT_HEAD) == Some([0u8; 32]);
    if p.season_id != land.season_id
        || p.world != land.world
        || p.coord != plan.coord
        || p.wedge != plan.wedge
        || p.region != wr::wide_region(plan.coord)
        || p.opened_bell != bell
        || sb.terrain_seed() != Some(&p.ring_seed)
        || p.seed_round != sb.round
        || p.funded_lamports != t.lamports
        || rd_u32(&t.data, PV2::RESOLVED_NEXT) != Some(bell)
        || rd_u32(&t.data, PV2::SCORE_NEXT_BELL) != Some(bell)
        || !fresh_chain
    {
        return Err("LAND_TARGET_IDENTITY".into());
    }
    // The terrain block is the wide kernel's for this seed and coordinate
    // (the handler's own kernel: a consistency check, not independent).
    let terrain = generate_province_wide(&p.ring_seed, plan.coord.p(), plan.coord.q())
        .map_err(|_| "LAND_TARGET_TERRAIN")?;
    let mut kernel = vec![0u8; wl::province::SIZE];
    encode_terrain(&terrain, &mut kernel).map_err(|_| "LAND_TARGET_TERRAIN")?;
    let block = PV2::TERRAIN..PV2::ROAD_MASK;
    if kernel[block.clone()] != t.data[block] {
        return Err("LAND_TARGET_TERRAIN".into());
    }
    let site_count = rd_u8(&t.data, PV2::SITE_COUNT).ok_or("LAND_TARGET_IDENTITY")?;
    // The wedge fund: the rent out, the handler's four counters.
    let (fb, fa) = (
        image(before, &plan.fund_name)?,
        image(after, &plan.fund_name)?,
    );
    let mut want = fb.data.clone();
    let counted = add32(&mut want, PF::OPEN_SITES, u32::from(site_count))
        && add32(&mut want, PF::PROVINCES_OPENED, 1)
        && add32(&mut want, PF::PROVINCES_FUNDED, 1)
        && add64(&mut want, PF::SPENT_TOTAL, t.lamports);
    if !counted
        || fa.key != fb.key
        || fa.key != ctx_of(land.season_key).province_fund(plan.wedge)
        || fa.owner != fb.owner
        || fb.lamports.checked_sub(t.lamports) != Some(fa.lamports)
        || fa.data != want
    {
        return Err("LAND_FUND_DELTA".into());
    }
    if total_lamports(before) != total_lamports(after) {
        return Err("LAND_LAMPORTS".into());
    }
    Ok(OpenedProvince {
        name: plan.target_name.clone(),
        p: plan.coord.p(),
        q: plan.coord.q(),
        key: t.key,
        wedge: p.wedge,
        region: p.region,
        opened_bell: bell,
        site_count,
        funded_lamports: p.funded_lamports,
        provenance: PROVENANCE_OPENED,
    })
}

/// Stage, dispatch, require no receipt, judge, then commit the whole staged
/// map. Any failure leaves `images` exactly as it was.
fn execute_open(
    images: &mut Images,
    plan: &OpenPlan,
    now: i64,
    slot: u64,
) -> Result<OpenedProvince, String> {
    let (stage, records) =
        stage_open(images, plan, now, slot).map_err(|e| format!("LAND_OPEN_REFUSED:{e}"))?;
    // WideOpenProvince logs nothing (no PS2, no PSW1 kind is allocated).
    if !records.is_empty() {
        return Err("LAND_UNEXPECTED_RECEIPT".into());
    }
    let opened = judge_open(images, &stage, plan, now)?;
    *images = stage;
    Ok(opened)
}

/// Opens the ring-129 province `(p, q)` with the real WideOpenProvince at
/// the caller's simulated `now`/`slot`. Refuses before any dispatch: a
/// coordinate out of bounds or not in ring 129, records missing or not
/// canonical, the ring seed not Seeded, a time before genesis, a duplicate
/// (name or address), the demo budget, the image bound. A handler refusal
/// (`Insufficient`, ...) or a failed judgement leaves `images` untouched.
/// Duplicate commands and stale revisions are the controller's.
pub fn open_province(
    images: &mut Images,
    p: i64,
    q: i64,
    now: i64,
    slot: u64,
) -> Result<OpenedProvince, String> {
    let coord = WideCoord::checked(p, q).map_err(|_| "LAND_COORD_BOUNDS")?;
    if coord.ring() != LAND_RING {
        return Err("LAND_NOT_RING_129".into());
    }
    let land = season_context(images)?;
    let seed = installed(images, &land)?;
    if seed.status != SeedStatus::Seeded || seed.terrain_seed().is_none() {
        return Err("LAND_RING_UNSEEDED".into());
    }
    if bell_at(land.genesis_ts, now).is_none() {
        return Err("LAND_TIME_BEFORE_GENESIS".into());
    }
    let plan = plan_target(&land, coord, province_name(coord))?;
    if images.contains_key(&plan.target_name) || images.values().any(|im| im.key == plan.target_key)
    {
        return Err("LAND_DUPLICATE_OPEN".into());
    }
    if extra_provinces(images) >= MAX_EXTRA_PROVINCES {
        return Err("LAND_BUDGET".into());
    }
    if images.len() >= MAX_TOTAL_IMAGES {
        return Err("LAND_IMAGE_BOUND".into());
    }
    execute_open(images, &plan, now, slot)
}

/// The provinces this module added, decoded.
pub fn opened_provinces(images: &Images) -> Result<Vec<(String, WideProvince)>, String> {
    images
        .iter()
        .filter(|(n, _)| n.starts_with(PROVINCE_PREFIX))
        .map(|(n, im)| {
            WideProvince::read(&im.data)
                .map(|p| (n.clone(), p))
                .map_err(|_| format!("LAND_TARGET_IDENTITY:{n}"))
        })
        .collect()
}

// ------------------------------------------------------------ golden gate

fn compare_golden(
    label: &'static str,
    pq: (i64, i64),
    want: &Image,
    got: &Image,
) -> Result<GoldenProvince, String> {
    if want.key != got.key || want.owner != got.owner {
        return Err(format!("LAND_GOLDEN_MISMATCH:{label}:address_owner"));
    }
    if want.data.len() != wl::province::SIZE || got.data.len() != wl::province::SIZE {
        return Err(format!("LAND_GOLDEN_MISMATCH:{label}:length"));
    }
    for (field, range) in &GATED {
        if want.data[range.clone()] != got.data[range.clone()] {
            return Err(format!("LAND_GOLDEN_MISMATCH:{label}:{field}"));
        }
    }
    Ok(GoldenProvince {
        label,
        p: pq.0,
        q: pq.1,
        gated: GATED.iter().map(|(f, _)| *f).collect(),
        informational: INFORMATIONAL
            .iter()
            .map(|(f, r)| (*f, want.data[r.clone()] == got.data[r.clone()]))
            .collect(),
        lamports_equal: want.lamports == got.lamports,
    })
}

/// Re-opens BOTH original provinces with the real handler at the original
/// bell 1 (`bell_start(1)`, slot 1,001, the exporter's `w.at(1, 0)`) in a
/// SCRATCH map holding only the Season, payer, system program and the
/// proposed records, and requires every [`GATED`] range equal to the
/// exported image. The scratch map is discarded; `images` is only read.
pub fn golden_gate(
    images: &Images,
    ev: &InitialEvidence,
    records: &Images,
) -> Result<GoldenReport, String> {
    let mut scratch = Images::new();
    for name in ["season", "payer", "system"] {
        scratch.insert(name.into(), image(images, name)?.clone());
    }
    for (name, im) in records {
        scratch.insert(name.clone(), im.clone());
    }
    let land = season_context(&scratch)?;
    installed(&scratch, &land)?;
    let open_ts = bell_start(ev.land.genesis_ts, ORIGINAL_OPEN_BELL);
    let slot = 1_000 + u64::from(ORIGINAL_OPEN_BELL);
    let mut provinces = Vec::with_capacity(2);
    for (label, pq) in [
        ("origin", ORIGINAL_ORIGIN),
        ("destination", ORIGINAL_DESTINATION),
    ] {
        let coord = WideCoord::checked(pq.0, pq.1).map_err(|_| "LAND_EVIDENCE_COORD")?;
        let plan = plan_target(&land, coord, format!("golden_{label}"))?;
        execute_open(&mut scratch, &plan, open_ts, slot)
            .map_err(|e| format!("LAND_GOLDEN_OPEN:{label}:{e}"))?;
        provinces.push(compare_golden(
            label,
            pq,
            image(images, label)?,
            image(&scratch, &plan.target_name)?,
        )?);
    }
    Ok(GoldenReport {
        provinces,
        open_ts,
        open_bell: ORIGINAL_OPEN_BELL,
    })
}

/// Evidence, records, golden gate, then one commit of the records. Any
/// failure leaves `images` untouched. Refuses a second install.
pub fn install(images: &mut Images, meta: &Metadata) -> Result<LandInstall, String> {
    if images.keys().any(|n| n.starts_with(LAND_PREFIX)) {
        return Err("LAND_ALREADY_INSTALLED".into());
    }
    let evidence = verify_initial_evidence(images, meta)?;
    let records = bootstrap_records(&evidence)?;
    if records
        .values()
        .any(|r| images.values().any(|im| im.key == r.key))
    {
        return Err("LAND_RECORD_COLLISION".into());
    }
    if images.len() + records.len() > MAX_TOTAL_IMAGES {
        return Err("LAND_IMAGE_BOUND".into());
    }
    let golden = golden_gate(images, &evidence, &records)?;
    let names = records.keys().cloned().collect();
    images.extend(records);
    Ok(LandInstall {
        evidence,
        golden,
        records: names,
    })
}

// ------------------------------------------------------------ tests

#[cfg(test)]
mod tests {
    use super::*;
    use frontier_abi::FrontierError;

    /// The committed fixtures, parsed independently of the engine. Nothing
    /// here calls the exporter or any signing function.
    fn fixture() -> (Images, Metadata) {
        let mut images = Images::new();
        for line in include_str!("fixtures/accounts.tsv").lines() {
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            let f: Vec<&str> = line.split('\t').collect();
            assert_eq!(f.len(), 5, "accounts.tsv columns");
            let im = Image {
                key: unhex(f[1]).expect("hex").try_into().expect("key"),
                owner: unhex(f[2]).expect("hex").try_into().expect("owner"),
                lamports: f[3].parse().expect("lamports"),
                data: unhex(f[4]).expect("hex"),
            };
            assert!(images.insert(f[0].to_string(), im).is_none(), "unique");
        }
        let mut meta = Metadata::new();
        for line in include_str!("fixtures/metadata.tsv").lines() {
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            let (k, v) = line.split_once('\t').expect("pair");
            assert!(
                meta.insert(k.to_string(), v.to_string()).is_none(),
                "unique"
            );
        }
        (images, meta)
    }

    fn installed_fixture() -> (Images, Metadata) {
        let (mut images, meta) = fixture();
        install(&mut images, &meta).expect("install");
        (images, meta)
    }

    fn genesis(meta: &Metadata) -> i64 {
        meta["genesis"].parse().expect("genesis")
    }

    /// The session's initial instant (bell 6 + 60 s), slot 1,006.
    fn initial_ts(meta: &Metadata) -> i64 {
        genesis(meta) + 6 * 600 + 60
    }

    fn refused(e: FrontierError) -> String {
        format!("Refused_{}", e.code())
    }

    fn tampered(after: &Images, f: impl FnOnce(&mut Images)) -> Images {
        let mut a = after.clone();
        f(&mut a);
        a
    }

    #[test]
    fn land_bootstrap_golden_gate_reopens_both_original_provinces_at_bell1() {
        let (mut images, meta) = fixture();
        let before = images.clone();
        let out = install(&mut images, &meta).expect("install");
        assert_eq!(out.golden.open_bell, 1);
        assert_eq!(out.golden.open_ts, genesis(&meta) + 600);
        let labels: Vec<_> = out
            .golden
            .provinces
            .iter()
            .map(|g| (g.label, g.p, g.q))
            .collect();
        assert_eq!(labels, [("origin", 129, 0), ("destination", 129, -1)]);
        let gated: Vec<&str> = GATED.iter().map(|(f, _)| *f).collect();
        for g in &out.golden.provinces {
            assert_eq!(g.gated, gated);
            assert_eq!(g.informational.len(), INFORMATIONAL.len());
        }
        // Originals untouched; the golden openings stayed in the scratch.
        for (name, im) in &before {
            assert_eq!(images.get(name), Some(im), "{name}");
        }
        assert!(!images.keys().any(|n| n.starts_with("golden_")));
        let seed = WideRingSeed::read(&images[RING_SEED_NAME].data).unwrap();
        assert_eq!(seed.provinces_created, ORIGINAL_PROVINCES_CREATED);
        for wedge in 0..6u8 {
            let f = &images[&fund_name(wedge)];
            assert_eq!(f.lamports, fund_lamports());
            assert_eq!(&f.data[PF::PROVINCES_OPENED..PF::RSV], &[0u8; 28][..]);
        }
    }

    #[test]
    fn land_bootstrap_golden_gate_ignores_gameplay_mutable_ranges() {
        let (mut images, meta) = fixture();
        for name in ["origin", "destination"] {
            let d = &mut images.get_mut(name).unwrap().data;
            for (_, r) in &INFORMATIONAL {
                d[r.start] ^= 0x01;
            }
        }
        images.get_mut("origin").unwrap().lamports += 1;
        let before = images.clone();
        let out = install(&mut images, &meta).expect("informational ranges never gate");
        assert!(!out.golden.provinces[0].lamports_equal);
        for (name, im) in &before {
            assert_eq!(images.get(name), Some(im), "{name}");
        }
    }

    #[test]
    fn land_bootstrap_golden_gate_refuses_tampered_terrain_without_mutation() {
        for (label, off) in [
            ("origin", PV2::TERRAIN),
            ("destination", PV2::RESOURCE + 3),
            ("origin", PV2::SITES),
            ("destination", PV2::SITE_COUNT),
            ("origin", PV2::PASSABLE_MASK),
            ("destination", PV2::ROUGH_MASK + 7),
        ] {
            let (mut images, meta) = fixture();
            images.get_mut(label).unwrap().data[off] ^= 0x01;
            let snap = images.clone();
            assert_eq!(
                install(&mut images, &meta).unwrap_err(),
                format!("LAND_GOLDEN_MISMATCH:{label}:terrain"),
                "{label} @ {off}"
            );
            assert_eq!(images, snap);
        }
    }

    #[test]
    fn land_bootstrap_tampered_initial_evidence_is_refused_without_mutation() {
        type Tamper = fn(&mut Images, &mut Metadata);
        let cases: [(&str, Tamper); 9] = [
            ("LAND_EVIDENCE_AUTHORITY", |i, _| {
                i.get_mut("season").unwrap().data[S::AUTHORITY] ^= 1
            }),
            ("LAND_EVIDENCE_SEASON_ADDRESS", |i, _| {
                i.get_mut("season").unwrap().key[0] ^= 1
            }),
            ("LAND_EVIDENCE_WORLD", |_, m| {
                m.insert("world".into(), "00".repeat(31) + "01");
            }),
            ("LAND_EVIDENCE_GENESIS", |_, m| {
                m.insert("genesis".into(), "1".into());
            }),
            ("LAND_EVIDENCE_RING_SEED:origin", |i, _| {
                i.get_mut("origin").unwrap().data[wl::province::RING_SEED] ^= 1
            }),
            ("LAND_EVIDENCE_SEED_ROUND:destination", |i, _| {
                i.get_mut("destination").unwrap().data[wl::province::SEED_ROUND] ^= 1
            }),
            ("LAND_EVIDENCE_ADDRESS:origin", |i, _| {
                i.get_mut("origin").unwrap().key[0] ^= 1
            }),
            ("LAND_EVIDENCE_OPENED_BELL:destination", |i, _| {
                i.get_mut("destination").unwrap().data[PV2::OPENED_BELL] ^= 1
            }),
            ("LAND_EVIDENCE_REGION:origin", |_, m| {
                m.insert("origin_region".into(), "7".into());
            }),
        ];
        for (want, tamper) in cases {
            let (mut images, mut meta) = fixture();
            tamper(&mut images, &mut meta);
            let snap = images.clone();
            assert_eq!(install(&mut images, &meta).unwrap_err(), want);
            assert_eq!(images, snap, "{want}");
        }
    }

    #[test]
    fn land_bootstrap_install_adds_only_explicit_local_records() {
        let (mut images, meta) = fixture();
        let before = images.clone();
        let out = install(&mut images, &meta).expect("install");
        let mut expected: Vec<String> = vec![RING_SEED_NAME.into(), RULES_CONFIG_NAME.into()];
        expected.extend((0..6u8).map(fund_name));
        expected.sort();
        assert_eq!(out.records, expected);
        assert_eq!(images.len(), before.len() + 8);
        let land = season_context(&images).unwrap();
        let ctx = ctx_of(land.season_key);
        let seed = installed(&images, &land).unwrap();
        assert_eq!(
            seed,
            WideRingSeed {
                season_id: 11,
                world: land.world,
                ring: 129,
                status: SeedStatus::Seeded,
                opened_bell: 1,
                t_open: genesis(&meta) + 600,
                round: 32_547_581,
                seed: [0x81; 32],
                provinces_created: 3,
                payer: [0xd4; 32],
            }
        );
        let rs = &images[RING_SEED_NAME];
        assert_eq!(rs.key, wl::ring_seed_address(&ctx, 129));
        assert_eq!(
            (rs.owner, rs.lamports),
            (PROGRAM, rent(wl::ring_seed::SIZE))
        );
        let cf = &images[RULES_CONFIG_NAME];
        assert_eq!(cf.key, wr::rules_config_address(&ctx));
        assert_eq!(
            (cf.owner, cf.lamports),
            (PROGRAM, rent(wr::rules_config::SIZE))
        );
        let cfg = WideRulesConfig::read(&cf.data).unwrap();
        assert_eq!(
            cfg.bytes(),
            RuleBytes {
                keep_holder: 1,
                free_city: 2,
                camp: 2,
                region: 1
            }
        );
        assert_eq!((cfg.config_version, cfg.authority), (1, [0xaa; 32]));
        for wedge in 0..6u8 {
            let f = &images[&fund_name(wedge)];
            assert_eq!(f.key, ctx.province_fund(wedge));
            assert_eq!(f.owner, PROGRAM);
            assert_eq!(f.data[PF::WEDGE], wedge);
        }
        assert!(EVIDENCE_LABELS
            .iter()
            .all(|(k, v)| !k.is_empty() && !v.is_empty()));
    }

    #[test]
    fn land_bootstrap_install_twice_is_refused_without_mutation() {
        let (mut images, meta) = installed_fixture();
        let snap = images.clone();
        assert_eq!(
            install(&mut images, &meta).unwrap_err(),
            "LAND_ALREADY_INSTALLED"
        );
        assert_eq!(images, snap);
    }

    #[test]
    fn land_bootstrap_another_ring129_province_opens_at_supplied_time() {
        let (mut images, meta) = installed_fixture();
        let before = images.clone();
        let now = initial_ts(&meta);
        let o = open_province(&mut images, 129, -2, now, 1_006).expect("open");
        let coord = WideCoord::checked(129, -2).unwrap();
        assert_eq!(
            (o.p, o.q, o.opened_bell, o.provenance),
            (129, -2, 6, PROVENANCE_OPENED)
        );
        assert_eq!(o.name, province_name(coord));
        assert_eq!(Some(o.wedge), coord.wedge());
        let t = &images[&o.name];
        let p = WideProvince::read(&t.data).unwrap();
        assert_eq!(
            (p.ring_seed, p.seed_round),
            (ORIGINAL_RING_SEED, ORIGINAL_SEED_ROUND)
        );
        assert_eq!(p.region, wr::wide_region(coord));
        assert_eq!(rd_u32(&t.data, PV2::RESOLVED_NEXT), Some(6));
        assert_eq!(t.lamports, rent(wl::province::SIZE));
        let seed = WideRingSeed::read(&images[RING_SEED_NAME].data).unwrap();
        assert_eq!(seed.provinces_created, 4);
        let fund = fund_name(o.wedge);
        assert_eq!(
            images[&fund].lamports,
            fund_lamports() - rent(wl::province::SIZE)
        );
        assert_eq!(images.len(), before.len() + 1);
        for (name, im) in &before {
            if name != RING_SEED_NAME && *name != fund {
                assert_eq!(images.get(name), Some(im), "{name}");
            }
        }
        // A second one at a later supplied instant carries that bell.
        let later = genesis(&meta) + 21 * 600 + 300;
        let o2 = open_province(&mut images, 128, 1, later, 1_021).expect("open later");
        assert_eq!(o2.opened_bell, 21);
        let seed = WideRingSeed::read(&images[RING_SEED_NAME].data).unwrap();
        assert_eq!(seed.provinces_created, 5);
        let listed: Vec<String> = opened_provinces(&images)
            .unwrap()
            .into_iter()
            .map(|(n, _)| n)
            .collect();
        assert_eq!(listed.len(), 2);
    }

    #[test]
    fn land_bootstrap_duplicate_open_is_refused_without_mutation() {
        let (mut images, meta) = installed_fixture();
        let now = initial_ts(&meta);
        open_province(&mut images, 129, -2, now, 1_006).expect("first open");
        let snap = images.clone();
        for (p, q) in [(129, -2), (129, 0), (129, -1)] {
            assert_eq!(
                open_province(&mut images, p, q, now, 1_006).unwrap_err(),
                "LAND_DUPLICATE_OPEN"
            );
        }
        assert_eq!(images, snap);
        // The handler refuses too, on its own, when handed the existing
        // province: the precheck is not the only guard.
        let land = season_context(&images).unwrap();
        let plan =
            plan_target(&land, WideCoord::checked(129, 0).unwrap(), "origin".into()).unwrap();
        assert_eq!(
            stage_open(&images, &plan, now, 1_006).unwrap_err(),
            refused(FrontierError::AlreadyDone)
        );
        assert_eq!(images, snap);
    }

    #[test]
    fn land_bootstrap_out_of_range_coordinates_are_refused_without_mutation() {
        let (mut images, meta) = installed_fixture();
        let now = initial_ts(&meta);
        let snap = images.clone();
        for (p, q, want) in [
            (128, 0, "LAND_NOT_RING_129"),
            (130, 0, "LAND_NOT_RING_129"),
            (0, 0, "LAND_NOT_RING_129"),
            (i64::MAX, 0, "LAND_COORD_BOUNDS"),
        ] {
            assert_eq!(
                open_province(&mut images, p, q, now, 1_006).unwrap_err(),
                want
            );
        }
        assert_eq!(images, snap);
        let land = season_context(&images).unwrap();
        // The legacy disk: the handler's BadData.
        let c = WideCoord::checked(128, 0).unwrap();
        let plan = plan_target(&land, c, province_name(c)).unwrap();
        assert_eq!(
            stage_open(&images, &plan, now, 1_006).unwrap_err(),
            refused(FrontierError::BadData)
        );
        // Ring 130 with ring 129's seed record: the handler's address check.
        let c = WideCoord::checked(130, 0).unwrap();
        let plan = plan_target(&land, c, province_name(c)).unwrap();
        assert_eq!(
            stage_open(&images, &plan, now, 1_006).unwrap_err(),
            refused(FrontierError::BadAddress)
        );
        assert_eq!(images, snap);
    }

    #[test]
    fn land_bootstrap_unseeded_ring_is_refused_without_mutation() {
        let (mut images, meta) = installed_fixture();
        let now = initial_ts(&meta);
        {
            let ai = images.get_mut(RING_SEED_NAME).unwrap();
            let mut rec = WideRingSeed::read(&ai.data).unwrap();
            rec.status = SeedStatus::Requested;
            rec.seed = [0; 32];
            rec.write(&mut ai.data).unwrap();
        }
        let snap = images.clone();
        assert_eq!(
            open_province(&mut images, 129, -2, now, 1_006).unwrap_err(),
            "LAND_RING_UNSEEDED"
        );
        assert_eq!(images, snap);
        let land = season_context(&images).unwrap();
        let c = WideCoord::checked(129, -2).unwrap();
        let plan = plan_target(&land, c, province_name(c)).unwrap();
        assert_eq!(
            stage_open(&images, &plan, now, 1_006).unwrap_err(),
            refused(FrontierError::SeedNotReady)
        );
        assert_eq!(images, snap);
    }

    #[test]
    fn land_bootstrap_insufficient_fund_is_refused_without_mutation() {
        let (mut images, meta) = installed_fixture();
        let now = initial_ts(&meta);
        let c = WideCoord::checked(129, -2).unwrap();
        let fund = fund_name(c.wedge().unwrap());
        images.get_mut(&fund).unwrap().lamports = rent(PF::SIZE) + rent(wl::province::SIZE) - 1;
        let snap = images.clone();
        assert_eq!(
            open_province(&mut images, 129, -2, now, 1_006).unwrap_err(),
            format!("LAND_OPEN_REFUSED:{}", refused(FrontierError::Insufficient))
        );
        assert_eq!(images, snap);
        // One lamport more is exactly enough: the fund ends at its own rent.
        images.get_mut(&fund).unwrap().lamports += 1;
        open_province(&mut images, 129, -2, now, 1_006).expect("boundary opens");
        assert_eq!(images[&fund].lamports, rent(PF::SIZE));
    }

    #[test]
    fn land_bootstrap_budget_is_enforced_without_mutation() {
        let (mut images, meta) = installed_fixture();
        let now = initial_ts(&meta);
        let coords = [(129, -2), (129, -3), (128, 1), (127, 2)];
        assert_eq!(coords.len(), MAX_EXTRA_PROVINCES);
        for (p, q) in coords {
            assert_eq!(WideCoord::checked(p, q).unwrap().ring(), 129);
            open_province(&mut images, p, q, now, 1_006).expect("within budget");
        }
        let snap = images.clone();
        assert_eq!(WideCoord::checked(126, 3).unwrap().ring(), 129);
        assert_eq!(
            open_province(&mut images, 126, 3, now, 1_006).unwrap_err(),
            "LAND_BUDGET"
        );
        assert_eq!(images, snap);
    }

    #[test]
    fn land_bootstrap_judge_rejects_foreign_and_malformed_writes() {
        let (images, meta) = installed_fixture();
        let snap = images.clone();
        let now = initial_ts(&meta);
        let land = season_context(&images).unwrap();
        let c = WideCoord::checked(129, -2).unwrap();
        let plan = plan_target(&land, c, province_name(c)).unwrap();
        let (after, records) = stage_open(&images, &plan, now, 1_006).expect("stage");
        assert!(records.is_empty(), "OpenProvince logs no receipt");
        assert!(judge_open(&images, &after, &plan, now).is_ok());
        let target = plan.target_name.clone();
        let fund = plan.fund_name.clone();
        let cases = [
            (
                "LAND_FOREIGN_WRITE:season",
                tampered(&after, |a| {
                    a.get_mut("season").unwrap().data[S::AUTHORITY] ^= 1
                }),
            ),
            (
                "LAND_FOREIGN_WRITE:payer",
                tampered(&after, |a| {
                    a.get_mut("payer").unwrap().lamports -= 1;
                    a.get_mut(&target).unwrap().lamports += 1;
                }),
            ),
            (
                "LAND_RING_SEED_DELTA",
                tampered(&after, |a| {
                    a.insert(RING_SEED_NAME.into(), images[RING_SEED_NAME].clone());
                }),
            ),
            (
                "LAND_TARGET_SHAPE",
                tampered(&after, |a| {
                    a.get_mut(&target).unwrap().owner = SYSTEM_PROGRAM
                }),
            ),
            (
                "LAND_TARGET_TERRAIN",
                tampered(&after, |a| {
                    a.get_mut(&target).unwrap().data[PV2::TERRAIN + 1] ^= 1
                }),
            ),
            (
                "LAND_FUND_DELTA",
                tampered(&after, |a| a.get_mut(&fund).unwrap().data[PF::RSV] = 1),
            ),
            (
                "LAND_NAME_SET",
                tampered(&after, |a| {
                    a.insert("intruder".into(), images["payer"].clone());
                }),
            ),
            (
                "LAND_NAME_SET",
                tampered(&after, |a| {
                    a.remove("holding");
                }),
            ),
        ];
        for (want, a) in &cases {
            assert_eq!(judge_open(&images, a, &plan, now).unwrap_err(), *want);
        }
        // The opening is bound to the supplied instant.
        assert_eq!(
            judge_open(&images, &after, &plan, now + 600).unwrap_err(),
            "LAND_TARGET_IDENTITY"
        );
        assert_eq!(images, snap);
    }

    #[test]
    fn land_bootstrap_noncanonical_or_tampered_records_are_refused() {
        let (images, meta) = installed_fixture();
        let now = initial_ts(&meta);
        let cases: [(&str, Images); 4] = [
            (
                "LAND_RULES_CONFIG",
                tampered(&images, |a| {
                    a.get_mut(RULES_CONFIG_NAME).unwrap().data[wr::rules_config::CAMP] = 1
                }),
            ),
            (
                "LAND_FUND_RECORD:0",
                tampered(&images, |a| a.get_mut(&fund_name(0)).unwrap().key[0] ^= 1),
            ),
            (
                "LAND_RING_SEED_RECORD",
                tampered(&images, |a| {
                    a.get_mut(RING_SEED_NAME).unwrap().data[wl::ring_seed::RING] ^= 1
                }),
            ),
            (
                "LAND_MISSING:land_rules_config",
                tampered(&images, |a| {
                    a.remove(RULES_CONFIG_NAME);
                }),
            ),
        ];
        for (want, mut t) in cases {
            let snap = t.clone();
            assert_eq!(
                open_province(&mut t, 129, -2, now, 1_006).unwrap_err(),
                want
            );
            assert_eq!(t, snap, "{want}");
        }
    }
}
