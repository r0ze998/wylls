//! **Destination preparation** for a chosen-destination march in the
//! keyless local sandbox (2026-11-08). See
//! `docs/frontier/map-growth/LOCAL-DESTINATION-STAGE-20261108.md`.
//!
//! **Declared, not yet run, not called.** `main.rs` declares
//! `mod destination_stage;` so it builds and its tests can run; nothing calls
//! this module yet. It uses only `runtime`, `land_bootstrap` and
//! `order_material` public items.
//!
//! **What it does.**
//!
//! - [`prepare_destination`] brings a province opened by `land_bootstrap`
//!   from its opening bell to `resolved_next = 20` by running the **real**
//!   WideResolve once per bell, from the cursor through 19, at the
//!   controller's supplied time (bell 21 or later, never earlier than the
//!   last bell's reveal close). The clock is never moved: every dispatch
//!   uses the supplied `now`/`slot`.
//! - Each bell's non-arrival beacon pair is a **synthetic local fixture**
//!   built exactly as the exporter's `stage_seed` under the T model
//!   (`wide_land_runtime_tests.rs:428-446`, `:567-609`): the literal seed
//!   `[0x5a; 32]`, the anchor's round `T(bell)`, `A = round_time(T) + 30`,
//!   the cache's round `S(bell, A)`. No signature is claimed (the anchor's
//!   `SIG48` stays zero).
//! - Each bell's per-destination accounts (roster, ArrivalDay,
//!   ClashInputs, SeedCache, BellAnchor) are added to a staged copy **only
//!   for that bell's dispatch** and removed afterwards if unchanged
//!   (bounded temporary staging). The committed map gains nothing; the one
//!   image that changes is the province.
//! - [`arrival_plan`] lists, without staging, every canonical account the
//!   engine's arrival phase needs for bell 20 and bells 21 to 23 at that
//!   destination, aliasing images that already exist at the same key.
//!
//! **What it never does.** No PostAnchor or PostSeed (the public bell-20
//! material is the engine's job with `order_material`); no key generation
//! or derivation, no signature, no new cryptographic material; no overwrite
//! of any existing image; no edit of any rule or record type. Unknown,
//! non-bootstrap or occupied targets fail closed.
#![allow(dead_code)] // Declared but not called yet.

use std::collections::BTreeMap;

use crate::land_bootstrap::{self as land, Images, GATED, MAX_TOTAL_IMAGES, PROVINCE_PREFIX};
use crate::order_material::ARRIVE_BELL;
use crate::runtime::{self, Image, Meta, PROGRAM};
use frontier_abi::addr::{archive_part_of, AddrCtx};
use frontier_abi::bytes::{rd_u32, rd_u8, wr_arr, wr_i64, wr_u32, wr_u64, wr_u8};
use frontier_abi::layout::beacon::{bell_anchor as BA, seed_cache as SC};
use frontier_abi::layout::world::beacon_log as BL;
use frontier_abi::prologue::ids::SYSTEM_PROGRAM;
use frontier_abi::v2::layout::province::province as PV2;
use frontier_abi::v2::layout::{write_header, AccountKind as K2};
use frontier_abi::world_index::arrival as wa;
use frontier_abi::world_index::event::{self as ev, WideKind, WideTarget};
use frontier_abi::world_index::land::{self as wl, WideProvince};
use frontier_abi::world_index::roster as wro;
use frontier_abi::world_index::rules as wr;
use frontier_abi::world_index::wide_ix as wix;
use frontier_abi::world_index::{ProvinceKey, WideCoord};
use permutation_frontier::clock::SeasonClock;
use permutation_frontier::layout::chain_of;
use permutation_rules::frontier::beacon::bell_at;

// ------------------------------------------------------------ pins

/// The last bell this module resolves (the arrival bell's predecessor).
pub const LAST_PREPARED_BELL: u32 = ARRIVE_BELL - 1;
/// The exporter's literal non-arrival bell seed (`BELL_SEED`,
/// `wide_land_runtime_tests.rs:128`).
pub const SYNTHETIC_BELL_SEED: [u8; 32] = [0x5a; 32];
/// The exporter's fixture balance of a staged pair or beacon log (`BIG`,
/// `map_growth_runtime_tests.rs:150`).
pub const FIXTURE_LAMPORTS: u64 = 10_000_000_000;
/// The T model's anchor lag (`beacon_rounds`, `:439`).
pub const ANCHOR_LAG_SECS: i64 = 30;
/// The resolver named in every resolve (the engine's beneficiary).
pub const BENEFICIARY: [u8; 32] = [0xd4; 32];
/// Temporaries one resolve stages: roster, day, inputs, cache, anchor.
pub const TEMPORARIES_PER_RESOLVE: usize = 5;
/// Every bell this module touches lies in day 0 (one ArrivalDay name).
const _: () = assert!(ARRIVE_BELL + 3 < wa::wide_arrival_day::BELLS);

pub const PROVENANCE_PREPARED: &str = "REAL_RESOLVE_OVER_SYNTHETIC_NON_ARRIVAL_PAIRS";

/// Labels the UI should show beside a prepared destination.
pub const DESTINATION_EVIDENCE_LABELS: [(&str, &str); 5] = [
    (
        "non_arrival_pairs",
        "SYNTHETIC_NON_ARRIVAL_BEACON_PAIRS: literal seed 0x5a.., T-model rounds exactly as the \
         exporter's stage_seed; no signature; staged per dispatch and dropped; rebuilt \
         deterministically from the Season clock",
    ),
    (
        "resolves",
        "REAL_WIDE_RESOLVE_AT_SUPPLIED_TIME: one real WideResolve per bell from the opening bell \
         through 19, each receipt chained to the province",
    ),
    (
        "clock",
        "CLOCK_NOT_MOVED: every dispatch at the controller's supplied time (bell 21 or later)",
    ),
    (
        "beacon_log",
        "LOCAL_FIXTURE_BEACON_LOG: a region's log as InitBeaconLogs leaves it, nothing posted \
         (arrival plan only)",
    ),
    ("auth", "NO_KEY_NO_SIGNATURE_NO_NEW_CRYPTO"),
];

// ------------------------------------------------------------ types

/// A canonical destination province in the map.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Destination {
    pub name: String,
    pub coord: WideCoord,
    pub key: ProvinceKey,
    pub region: u8,
    pub opened_bell: u32,
    pub resolved_next: u32,
}

/// One account an instruction needs: its role, the image name to list
/// (an existing alias when an image already has that key) and, when no
/// image exists at the key, the image to stage temporarily.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PlannedAccount {
    pub role: String,
    pub name: String,
    pub key: [u8; 32],
    pub temporary: Option<Image>,
}

/// How an existing image at a planned key is treated.
enum Expect {
    /// Reuse it only if byte-identical to this image (synthetic pairs).
    Exact(Image),
    /// Reuse whatever is there (the handler judges it); stage this image
    /// when nothing is.
    AnyAtKey(Image),
}

/// One staged synthetic non-arrival pair.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SyntheticPair {
    pub bell: u32,
    pub region: u8,
    pub tlock_round: u64,
    pub a: i64,
    pub seed_round: u64,
    pub cache: Image,
    pub anchor: Image,
}

/// What a prepared bell's pair was (for evidence display).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PairEvidence {
    pub bell: u32,
    pub region: u8,
    pub tlock_round: u64,
    pub a: i64,
    pub seed_round: u64,
    pub cache_key: [u8; 32],
    pub anchor_key: [u8; 32],
    /// An identical image already existed at both keys and was reused.
    pub aliased: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PreparedDestination {
    pub name: String,
    pub p: i64,
    pub q: i64,
    pub region: u8,
    pub from_bell: u32,
    pub to_bell: u32,
    pub resolved_next: u32,
    pub score_next_bell: u32,
    pub now: i64,
    /// One `PSW1` Resolve body per bell, in order (for the engine's log).
    pub receipts: Vec<Vec<u8>>,
    pub pairs: Vec<PairEvidence>,
    pub provenance: &'static str,
}

/// The five accounts of one bell's resolve.
struct BellAccounts {
    roster: PlannedAccount,
    day: PlannedAccount,
    inputs: PlannedAccount,
    cache: PlannedAccount,
    anchor: PlannedAccount,
    pair: SyntheticPair,
}

impl BellAccounts {
    fn list(&self) -> [PlannedAccount; TEMPORARIES_PER_RESOLVE] {
        [
            self.roster.clone(),
            self.day.clone(),
            self.inputs.clone(),
            self.cache.clone(),
            self.anchor.clone(),
        ]
    }
}

// ------------------------------------------------------------ records

fn ctx_of(season: [u8; 32]) -> AddrCtx {
    AddrCtx {
        season,
        program: PROGRAM,
    }
}

fn acct(name: &str, signer: bool, writable: bool) -> Meta {
    Meta {
        name: name.into(),
        signer,
        writable,
    }
}

/// An absent account at `key`: System-owned, no data, no lamports.
pub fn absent(key: [u8; 32]) -> Image {
    Image {
        key,
        owner: SYSTEM_PROGRAM,
        lamports: 0,
        data: Vec::new(),
    }
}

/// The exporter's `stage_seed(bell, region, BELL_SEED)` under the T model,
/// byte for byte: THE anchor (`BELL`, `REGION`, `ROUND = T(bell)`, `A =
/// round_time(T) + 30`, `SLOT = 1`, no signature) and the nonce-0
/// SeedCache (`BELL`, `REGION`, `ROUND = S(bell, A)`, the literal seed, the
/// anchor's key, `A`), both program-owned with the fixture balance.
pub fn synthetic_pair(
    ctx: &AddrCtx,
    season_id: u64,
    clock: &SeasonClock,
    bell: u32,
    region: u8,
) -> Result<SyntheticPair, String> {
    let tlock_round = clock.tlock_round(bell);
    let a = clock
        .round_time(tlock_round)
        .checked_add(ANCHOR_LAG_SECS)
        .ok_or("DEST_STAGE_TIME")?;
    let seed_round = clock.seed_round(bell, a);
    let anchor_key = ctx.bell_anchor(bell, region);
    let mut ad = vec![0u8; K2::BellAnchor.size()];
    let mut ok = write_header(&mut ad, K2::BellAnchor, season_id)
        & wr_u32(&mut ad, BA::BELL, bell)
        & wr_u8(&mut ad, BA::REGION, region)
        & wr_u64(&mut ad, BA::ROUND, tlock_round)
        & wr_i64(&mut ad, BA::A, a)
        & wr_u64(&mut ad, BA::SLOT, 1);
    let mut cd = vec![0u8; K2::SeedCache.size()];
    ok &= write_header(&mut cd, K2::SeedCache, season_id)
        & wr_u32(&mut cd, SC::BELL, bell)
        & wr_u8(&mut cd, SC::REGION, region)
        & wr_u8(&mut cd, SC::NONCE, 0)
        & wr_u64(&mut cd, SC::ROUND, seed_round)
        & wr_arr(&mut cd, SC::SEED, &SYNTHETIC_BELL_SEED)
        & wr_arr(&mut cd, SC::ANCHOR_KEY, &anchor_key)
        & wr_i64(&mut cd, SC::A, a);
    if !ok {
        return Err("DEST_STAGE_PAIR_ENCODE".into());
    }
    Ok(SyntheticPair {
        bell,
        region,
        tlock_round,
        a,
        seed_round,
        cache: Image {
            key: ctx.seed_cache(bell, region, 0),
            owner: PROGRAM,
            lamports: FIXTURE_LAMPORTS,
            data: cd,
        },
        anchor: Image {
            key: anchor_key,
            owner: PROGRAM,
            lamports: FIXTURE_LAMPORTS,
            data: ad,
        },
    })
}

/// The exporter's `beacon_log(region)` fixture: InitBeaconLogs's record
/// with nothing posted (`wide_land_runtime_tests.rs:1563-1578`).
pub fn beacon_log_fixture(ctx: &AddrCtx, season_id: u64, region: u8) -> Result<Image, String> {
    let mut d = vec![0u8; K2::BeaconLog.size()];
    if !(write_header(&mut d, K2::BeaconLog, season_id) & wr_u8(&mut d, BL::REGION, region)) {
        return Err("DEST_STAGE_LOG_ENCODE".into());
    }
    Ok(Image {
        key: ctx.beacon_log(region),
        owner: PROGRAM,
        lamports: FIXTURE_LAMPORTS,
        data: d,
    })
}

// ------------------------------------------------------------ planning

/// The canonical wide province at `(p, q)`: exactly one image at its
/// with-seed address, program-owned, this Season and world, the stored
/// region the configured candidate's (`wide_region`).
pub fn destination(images: &Images, p: i64, q: i64) -> Result<Destination, String> {
    let coord = WideCoord::checked(p, q).map_err(|_| "DEST_STAGE_COORD")?;
    let ctx_land = land::season_context(images)?;
    let key = wl::province_address(&ctx_of(ctx_land.season_key), coord);
    let names: Vec<&String> = images
        .iter()
        .filter(|(_, im)| im.key == key)
        .map(|(n, _)| n)
        .collect();
    let name = match names.as_slice() {
        [] => return Err("DEST_STAGE_TARGET_MISSING".into()),
        [n] => (*n).clone(),
        _ => return Err("DEST_STAGE_TARGET_ALIAS".into()),
    };
    let im = &images[&name];
    let pv = WideProvince::read(&im.data).map_err(|_| "DEST_STAGE_TARGET")?;
    if im.owner != PROGRAM
        || pv.coord != coord
        || pv.world != ctx_land.world
        || pv.season_id != ctx_land.season_id
        || pv.region != wr::wide_region(coord)
    {
        return Err("DEST_STAGE_TARGET".into());
    }
    let resolved_next = rd_u32(&im.data, PV2::RESOLVED_NEXT).ok_or("DEST_STAGE_TARGET")?;
    Ok(Destination {
        name,
        coord,
        key: ProvinceKey::new(ctx_land.world, coord),
        region: pv.region,
        opened_bell: pv.opened_bell,
        resolved_next,
    })
}

/// One planned account: an existing image at the key is aliased (never
/// duplicated, never overwritten); otherwise the default name is used and
/// must be free.
fn plan_account(
    images: &Images,
    role: String,
    default_name: String,
    expect: Expect,
) -> Result<PlannedAccount, String> {
    let (supply, exact) = match expect {
        Expect::Exact(im) => (im, true),
        Expect::AnyAtKey(im) => (im, false),
    };
    let key = supply.key;
    let found: Vec<(&String, &Image)> = images.iter().filter(|(_, im)| im.key == key).collect();
    match found.as_slice() {
        [] => {
            if images.contains_key(&default_name) {
                return Err(format!("DEST_STAGE_NAME_CONFLICT:{default_name}"));
            }
            Ok(PlannedAccount {
                role,
                name: default_name,
                key,
                temporary: Some(supply),
            })
        }
        [(name, im)] => {
            if exact && **im != supply {
                return Err(format!("DEST_STAGE_CONFLICT:{name}"));
            }
            Ok(PlannedAccount {
                role,
                name: String::clone(name),
                key,
                temporary: None,
            })
        }
        _ => Err(format!("DEST_STAGE_ALIAS:{role}")),
    }
}

fn bell_accounts(
    images: &Images,
    dest: &Destination,
    ctx: &AddrCtx,
    season_id: u64,
    clock: &SeasonClock,
    bell: u32,
) -> Result<BellAccounts, String> {
    let pair = synthetic_pair(ctx, season_id, clock, bell, dest.region)?;
    let n = &dest.name;
    let k = dest.key;
    Ok(BellAccounts {
        roster: plan_account(
            images,
            "roster".into(),
            format!("{n}_roster"),
            Expect::AnyAtKey(absent(wro::roster_address(ctx, k))),
        )?,
        day: plan_account(
            images,
            "day".into(),
            format!("{n}_day"),
            Expect::AnyAtKey(absent(wa::arrival_day_address(ctx, k, wa::day_of(bell)))),
        )?,
        inputs: plan_account(
            images,
            format!("inputs_{bell}"),
            format!("{n}_inputs_{bell}"),
            Expect::AnyAtKey(absent(wa::clash_inputs_address(ctx, k, bell))),
        )?,
        cache: plan_account(
            images,
            format!("cache_{bell}"),
            format!("{n}_cache_{bell}"),
            Expect::Exact(pair.cache.clone()),
        )?,
        anchor: plan_account(
            images,
            format!("anchor_{bell}"),
            format!("{n}_anchor_{bell}"),
            Expect::Exact(pair.anchor.clone()),
        )?,
        pair,
    })
}

/// Every canonical account the engine's arrival phase at this destination
/// needs: for bell 20 THE anchor and the nonce-0 cache (absent until the
/// real PostAnchor/PostSeed), the archive (absent), the region's beacon
/// log (the fixture log when none exists), the ClashInputs, the ArrivalDay,
/// the roster and the 24 ArrivalSlots (absent until the reveal/gather);
/// for bells 21 to 23 the ClashInputs (absent) and the synthetic pair.
/// Existing images at a key are aliased. Reads only; stages nothing.
pub fn arrival_plan(images: &Images, p: i64, q: i64) -> Result<Vec<PlannedAccount>, String> {
    let dest = destination(images, p, q)?;
    let ctx_land = land::season_context(images)?;
    let clock = SeasonClock::read(&images["season"].data).map_err(|_| "DEST_STAGE_CLOCK")?;
    let ctx = ctx_of(ctx_land.season_key);
    let (n, k, r, b) = (&dest.name, dest.key, dest.region, ARRIVE_BELL);
    let any = |key: [u8; 32]| Expect::AnyAtKey(absent(key));
    let mut plan = vec![
        plan_account(
            images,
            "arrival_anchor".into(),
            format!("{n}_anchor_{b}"),
            any(ctx.bell_anchor(b, r)),
        )?,
        plan_account(
            images,
            "arrival_cache".into(),
            format!("{n}_cache_{b}"),
            any(ctx.seed_cache(b, r, 0)),
        )?,
        plan_account(
            images,
            "archive".into(),
            format!("{n}_archive"),
            any(ctx.anchor_archive(r, archive_part_of(b))),
        )?,
        plan_account(
            images,
            "beacon_log".into(),
            format!("{n}_beacon_log"),
            Expect::AnyAtKey(beacon_log_fixture(&ctx, ctx_land.season_id, r)?),
        )?,
        plan_account(
            images,
            format!("inputs_{b}"),
            format!("{n}_inputs_{b}"),
            any(wa::clash_inputs_address(&ctx, k, b)),
        )?,
        plan_account(
            images,
            "day".into(),
            format!("{n}_day"),
            any(wa::arrival_day_address(&ctx, k, wa::day_of(b))),
        )?,
        plan_account(
            images,
            "roster".into(),
            format!("{n}_roster"),
            any(wro::roster_address(&ctx, k)),
        )?,
    ];
    for f in 0..6u8 {
        for i in 0..4u8 {
            plan.push(plan_account(
                images,
                format!("slot_{f}_{i}"),
                format!("{n}_slot_{f}_{i}"),
                any(wa::arrival_slot_address(&ctx, k, b, f, i)),
            )?);
        }
    }
    for bell in b + 1..=b + 3 {
        let pair = synthetic_pair(&ctx, ctx_land.season_id, &clock, bell, r)?;
        plan.push(plan_account(
            images,
            format!("inputs_{bell}"),
            format!("{n}_inputs_{bell}"),
            any(wa::clash_inputs_address(&ctx, k, bell)),
        )?);
        plan.push(plan_account(
            images,
            format!("cache_{bell}"),
            format!("{n}_cache_{bell}"),
            Expect::Exact(pair.cache),
        )?);
        plan.push(plan_account(
            images,
            format!("anchor_{bell}"),
            format!("{n}_anchor_{bell}"),
            Expect::Exact(pair.anchor),
        )?);
    }
    Ok(plan)
}

// ------------------------------------------------------------ staging

/// A staged copy of `images` with every planned temporary added. Refuses a
/// name or key that already exists and a staged map above
/// [`MAX_TOTAL_IMAGES`] (the demo bound is never exceeded, even
/// transiently). Returns the copy; `images` is untouched.
pub fn stage_temporaries(images: &Images, planned: &[PlannedAccount]) -> Result<Images, String> {
    let mut stage = images.clone();
    for a in planned {
        if let Some(im) = &a.temporary {
            if im.key != a.key
                || stage.contains_key(&a.name)
                || stage.values().any(|x| x.key == a.key)
            {
                return Err(format!("DEST_STAGE_TEMPORARY_CONFLICT:{}", a.name));
            }
            stage.insert(a.name.clone(), im.clone());
        }
    }
    if stage.len() > MAX_TOTAL_IMAGES {
        return Err(format!(
            "DEST_STAGE_ACCOUNT_BOUND:{}>{}",
            stage.len(),
            MAX_TOTAL_IMAGES
        ));
    }
    Ok(stage)
}

/// Removes every planned temporary that is still exactly as staged;
/// returns the names of those an instruction changed (now real state the
/// caller must judge and keep).
pub fn drop_unchanged_temporaries(stage: &mut Images, planned: &[PlannedAccount]) -> Vec<String> {
    let mut retained = Vec::new();
    for a in planned {
        if let Some(im) = &a.temporary {
            if stage.get(&a.name) == Some(im) {
                stage.remove(&a.name);
            } else {
                retained.push(a.name.clone());
            }
        }
    }
    retained
}

fn total_lamports(m: &Images) -> u128 {
    let mut by_key = BTreeMap::new();
    for im in m.values() {
        by_key.entry(im.key).or_insert(im.lamports);
    }
    by_key.values().map(|l| u128::from(*l)).sum()
}

// ------------------------------------------------------------ resolving

/// Judges one bell's resolve over the staged map: the same names; every
/// image but the province byte-identical (temporaries, payer, Season,
/// holding, Citizen, origin, funds, records all included); the province's
/// key, owner, lamports, size and every land-bootstrap gated range
/// (header identity, prefix identity, opened bell, terrain, trailer)
/// unchanged; the cursor `bell → bell + 1`; exactly one `PSW1` Resolve
/// receipt of this bell keyed by this province; the province chain advanced
/// by exactly that receipt; lamports conserved.
fn judge_resolve(
    before: &Images,
    after: &Images,
    dest: &Destination,
    bell: u32,
    receipts: &[Vec<u8>],
) -> Result<(), String> {
    if before.keys().ne(after.keys()) {
        return Err("DEST_STAGE_NAME_SET".into());
    }
    for (name, b) in before {
        if *name != dest.name && after.get(name) != Some(b) {
            return Err(format!("DEST_STAGE_FOREIGN_WRITE:{name}"));
        }
    }
    let (pb, pa) = (&before[&dest.name], &after[&dest.name]);
    if pa.key != pb.key
        || pa.owner != pb.owner
        || pa.lamports != pb.lamports
        || pa.data.len() != pb.data.len()
    {
        return Err("DEST_STAGE_PROVINCE_SHAPE".into());
    }
    for (field, range) in &GATED {
        if pa.data[range.clone()] != pb.data[range.clone()] {
            return Err(format!("DEST_STAGE_IDENTITY:{field}"));
        }
    }
    if rd_u32(&pb.data, PV2::RESOLVED_NEXT) != Some(bell)
        || rd_u32(&pa.data, PV2::RESOLVED_NEXT) != bell.checked_add(1)
    {
        return Err("DEST_STAGE_CURSOR".into());
    }
    let [body] = receipts else {
        return Err("DEST_STAGE_RECEIPTS".into());
    };
    let r = ev::WideRecord::decode(body).map_err(|_| "DEST_STAGE_RECEIPTS")?;
    if r.kind != WideKind::Resolve || r.bell != bell || r.province() != Some(dest.key) {
        return Err("DEST_STAGE_RECEIPTS".into());
    }
    let start = chain_of(&pb.data).map_err(|_| "DEST_STAGE_CHAIN")?;
    let end = chain_of(&pa.data).map_err(|_| "DEST_STAGE_CHAIN")?;
    if ev::verify_chain(WideTarget::Province(dest.key), start, [body.as_slice()]) != Ok(end) {
        return Err("DEST_STAGE_CHAIN".into());
    }
    if total_lamports(before) != total_lamports(after) {
        return Err("DEST_STAGE_LAMPORTS".into());
    }
    Ok(())
}

/// One real WideResolve of `bell` on a staged copy of `current`:
/// `[payer s,w] [season r] [province w] [roster w] [cache r] [anchor r]
/// [inputs r] [day r] [system r]` (`wide_ix::RESOLVE`; the harness's
/// `resolve_full_as`, `:1779-1800`). Returns the next map (temporaries
/// dropped) and the receipt; `current` is never touched.
fn resolve_one(
    current: &Images,
    dest: &Destination,
    acc: &BellAccounts,
    bell: u32,
    now: i64,
    slot: u64,
) -> Result<(Images, Vec<u8>), String> {
    let planned = acc.list();
    let before = stage_temporaries(current, &planned)?;
    let mut after = before.clone();
    let metas = [
        acct("payer", true, true),
        acct("season", false, false),
        acct(&dest.name, false, true),
        acct(&acc.roster.name, false, true),
        acct(&acc.cache.name, false, false),
        acct(&acc.anchor.name, false, false),
        acct(&acc.inputs.name, false, false),
        acct(&acc.day.name, false, false),
        acct("system", false, false),
    ];
    let data = wix::Resolve {
        bell,
        beneficiary: BENEFICIARY,
    }
    .to_bytes();
    let receipts = runtime::dispatch(&mut after, &metas, &data, now, slot, false)
        .map_err(|e| format!("DEST_STAGE_REFUSED:{bell}:{e}"))?;
    judge_resolve(&before, &after, dest, bell, &receipts)?;
    if !drop_unchanged_temporaries(&mut after, &planned).is_empty() {
        return Err("DEST_STAGE_TEMPORARY_WRITE".into());
    }
    let receipt = receipts.into_iter().next().ok_or("DEST_STAGE_RECEIPTS")?;
    Ok((after, receipt))
}

/// Brings the land-bootstrap province at `(p, q)` to `resolved_next = 20`
/// with one real WideResolve per bell from its cursor through 19, at the
/// supplied `now`/`slot` (never moved). Refuses before any dispatch: a
/// coordinate out of bounds, no canonical province there, a province not
/// opened by `land_bootstrap`, one already at 20 or past 19, one with live
/// entries, a time before bell 21 or before the last bell's reveal close,
/// any planned record conflicting with an existing image. All bells run on
/// one staged copy; any refusal or failed judgement leaves `images` exactly
/// as it was. On success the only changed image is the province.
pub fn prepare_destination(
    images: &mut Images,
    p: i64,
    q: i64,
    now: i64,
    slot: u64,
) -> Result<PreparedDestination, String> {
    let dest = destination(images, p, q)?;
    if !dest.name.starts_with(PROVINCE_PREFIX) {
        return Err("DEST_STAGE_TARGET".into());
    }
    if dest.resolved_next == ARRIVE_BELL {
        return Err("DEST_STAGE_ALREADY_PREPARED".into());
    }
    if dest.resolved_next == 0 || dest.resolved_next > LAST_PREPARED_BELL {
        return Err("DEST_STAGE_CURSOR".into());
    }
    if rd_u8(&images[&dest.name].data, PV2::N_ENTRIES) != Some(0) {
        return Err("DEST_STAGE_OCCUPIED".into());
    }
    let ctx_land = land::season_context(images)?;
    let clock = SeasonClock::read(&images["season"].data).map_err(|_| "DEST_STAGE_CLOCK")?;
    let ctx = ctx_of(ctx_land.season_key);
    let last = synthetic_pair(
        &ctx,
        ctx_land.season_id,
        &clock,
        LAST_PREPARED_BELL,
        dest.region,
    )?;
    let earliest = clock.reveal_close(LAST_PREPARED_BELL, last.a);
    match bell_at(ctx_land.genesis_ts, now) {
        Some(b) if b > ARRIVE_BELL && now >= earliest => {}
        _ => return Err("DEST_STAGE_TOO_EARLY".into()),
    }
    // Plan every bell before the first dispatch (conflicts fail closed).
    let bells: Vec<u32> = (dest.resolved_next..=LAST_PREPARED_BELL).collect();
    let mut plans = Vec::with_capacity(bells.len());
    for &bell in &bells {
        plans.push(bell_accounts(
            images,
            &dest,
            &ctx,
            ctx_land.season_id,
            &clock,
            bell,
        )?);
    }
    let mut current = images.clone();
    let mut receipts = Vec::with_capacity(bells.len());
    for (&bell, acc) in bells.iter().zip(&plans) {
        let (next, receipt) = resolve_one(&current, &dest, acc, bell, now, slot)?;
        current = next;
        receipts.push(receipt);
    }
    // The whole sequence: same names, only the province changed, the
    // cursor at 20, the chain advanced by exactly these receipts.
    if current.keys().ne(images.keys()) {
        return Err("DEST_STAGE_NAME_SET".into());
    }
    for (name, b) in images.iter() {
        if *name != dest.name && current.get(name) != Some(b) {
            return Err(format!("DEST_STAGE_FOREIGN_WRITE:{name}"));
        }
    }
    let (p0, p1) = (&images[&dest.name].data, &current[&dest.name].data);
    if rd_u32(p1, PV2::RESOLVED_NEXT) != Some(ARRIVE_BELL) {
        return Err("DEST_STAGE_CURSOR".into());
    }
    let start = chain_of(p0).map_err(|_| "DEST_STAGE_CHAIN")?;
    let end = chain_of(p1).map_err(|_| "DEST_STAGE_CHAIN")?;
    if ev::verify_chain(
        WideTarget::Province(dest.key),
        start,
        receipts.iter().map(|v| v.as_slice()),
    ) != Ok(end)
    {
        return Err("DEST_STAGE_CHAIN".into());
    }
    let score_next_bell = rd_u32(p1, PV2::SCORE_NEXT_BELL).ok_or("DEST_STAGE_CURSOR")?;
    let pairs = plans
        .iter()
        .map(|acc| PairEvidence {
            bell: acc.pair.bell,
            region: acc.pair.region,
            tlock_round: acc.pair.tlock_round,
            a: acc.pair.a,
            seed_round: acc.pair.seed_round,
            cache_key: acc.pair.cache.key,
            anchor_key: acc.pair.anchor.key,
            aliased: acc.cache.temporary.is_none() && acc.anchor.temporary.is_none(),
        })
        .collect();
    let report = PreparedDestination {
        name: dest.name.clone(),
        p,
        q,
        region: dest.region,
        from_bell: dest.resolved_next,
        to_bell: LAST_PREPARED_BELL,
        resolved_next: ARRIVE_BELL,
        score_next_bell,
        now,
        receipts,
        pairs,
        provenance: PROVENANCE_PREPARED,
    };
    *images = current;
    Ok(report)
}

// ------------------------------------------------------------ sub-map dispatch

/// The runtime's own bounds (`runtime.rs:17-18`, private there; restated,
/// not changed).
pub const RUNTIME_MAX_IMAGES: usize = 128;
pub const RUNTIME_MAX_METAS: usize = 96;
const _: () = assert!(MAX_TOTAL_IMAGES <= RUNTIME_MAX_IMAGES);

/// One instruction for [`dispatch_sub_map`], all of it from the trusted
/// engine: the account metas, the instruction bytes, the time, the slot and
/// whether the instruction logs one beacon record (PostAnchor/PostSeed).
#[derive(Clone, Copy, Debug)]
pub struct SubMapCall<'a> {
    pub metas: &'a [Meta],
    pub instruction: &'a [u8],
    pub now: i64,
    pub slot: u64,
    pub allow_beacon_logs: bool,
}

/// What a sub-map dispatch did to the persistent map.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SubMapDispatch {
    /// The runtime's successful receipts (the caller's judge checks them).
    pub receipts: Vec<Vec<u8>>,
    /// Images in the dispatched sub-map.
    pub sub_map_len: usize,
    /// Existing persistent names updated, every alias of a changed key
    /// included, sorted.
    pub changed: Vec<String>,
    /// Temporaries the instruction changed: now persistent.
    pub created: Vec<String>,
    /// Temporaries left exactly as staged: not kept.
    pub dropped: Vec<String>,
}

/// Option (a) of the arrival budget: dispatches one instruction over a
/// **sub-map** holding only the accounts its metas list (plus the runtime's
/// one name-keyed dependency, `"holding"`, when an image at the holding's
/// key is listed), then merges the result back into the full persistent
/// map.
///
/// - `permitted` is the explicit set of planned accounts this call may use
///   beyond existing images. A temporary must carry an image at its own key,
///   with a name and key that exist neither in `images` nor in another
///   temporary. An alias (no temporary) must name an existing image at its
///   key. Every temporary must be listed by some meta. Every meta must name
///   an existing image or a permitted temporary.
/// - Bounds: the persistent map at most [`MAX_TOTAL_IMAGES`] before and
///   after; the sub-map at most [`RUNTIME_MAX_IMAGES`]; metas at most
///   [`RUNTIME_MAX_METAS`]. No constant is changed.
/// - The dispatch runs on a copy of the sub-map. The result must keep the
///   sub-map's names and keys, agree across aliases and conserve lamports.
/// - Merge: a changed existing image updates **every** persistent name at
///   its key (aliases stay consistent); a changed temporary is inserted as
///   new persistent state; an unchanged temporary is dropped. Every unlisted
///   image is carried over untouched; no key is duplicated.
/// - `judge(before, after, receipts)` sees the whole persistent map before
///   and after; it is where the caller checks receipts and allowed writes.
///   Any refusal (bounds, plan, runtime, handler, judge) returns before the
///   commit and leaves `images` byte-identical.
pub fn dispatch_sub_map<J>(
    images: &mut Images,
    permitted: &[PlannedAccount],
    call: &SubMapCall<'_>,
    judge: J,
) -> Result<SubMapDispatch, String>
where
    J: FnOnce(&Images, &Images, &[Vec<u8>]) -> Result<(), String>,
{
    if images.len() > MAX_TOTAL_IMAGES {
        return Err(format!(
            "SUBMAP_PERSISTENT_BOUND:{}>{}",
            images.len(),
            MAX_TOTAL_IMAGES
        ));
    }
    if call.metas.is_empty() || call.metas.len() > RUNTIME_MAX_METAS {
        return Err("SUBMAP_METAS".into());
    }
    // 1. The permitted planned accounts.
    let mut temps = Images::new();
    for a in permitted {
        match &a.temporary {
            Some(im) => {
                if a.name.is_empty()
                    || im.key != a.key
                    || images.contains_key(&a.name)
                    || images.values().any(|x| x.key == a.key)
                    || temps.contains_key(&a.name)
                    || temps.values().any(|x| x.key == a.key)
                {
                    return Err(format!("SUBMAP_PLANNED:{}", a.name));
                }
                temps.insert(a.name.clone(), im.clone());
            }
            None => {
                if images.get(&a.name).map(|im| im.key) != Some(a.key) {
                    return Err(format!("SUBMAP_PLANNED_ALIAS:{}", a.name));
                }
            }
        }
    }
    // 2. The sub-map: exactly the listed names.
    let mut sub = Images::new();
    for m in call.metas {
        let im = images
            .get(&m.name)
            .or_else(|| temps.get(&m.name))
            .ok_or_else(|| format!("SUBMAP_UNKNOWN_META:{}", m.name))?;
        sub.insert(m.name.clone(), im.clone());
    }
    if let Some(n) = temps.keys().find(|n| !sub.contains_key(*n)) {
        return Err(format!("SUBMAP_UNUSED_PLANNED:{n}"));
    }
    // 3. The runtime's one name-keyed dependency (its Transfer allowance).
    if let Some(h) = images.get("holding") {
        if sub.values().any(|im| im.key == h.key) {
            sub.insert("holding".into(), h.clone());
        }
    }
    if sub.len() > RUNTIME_MAX_IMAGES {
        return Err(format!(
            "SUBMAP_RUNTIME_BOUND:{}>{}",
            sub.len(),
            RUNTIME_MAX_IMAGES
        ));
    }
    // 4. The real handler on a copy of the sub-map.
    let mut after = sub.clone();
    let receipts = runtime::dispatch(
        &mut after,
        call.metas,
        call.instruction,
        call.now,
        call.slot,
        call.allow_beacon_logs,
    )
    .map_err(|e| format!("SUBMAP_REFUSED:{e}"))?;
    // 5. Runtime consistency: names, keys, aliases, lamports.
    if after.keys().ne(sub.keys()) {
        return Err("SUBMAP_RUNTIME_NAMES".into());
    }
    let mut by_key: BTreeMap<[u8; 32], &Image> = BTreeMap::new();
    for (n, a) in &after {
        if a.key != sub[n].key {
            return Err("SUBMAP_RUNTIME_KEY".into());
        }
        if let Some(prev) = by_key.insert(a.key, a) {
            if prev != a {
                return Err("SUBMAP_RUNTIME_ALIAS".into());
            }
        }
    }
    if total_lamports(&sub) != total_lamports(&after) {
        return Err("SUBMAP_LAMPORTS".into());
    }
    // 6. The merge into a staged copy of the whole persistent map.
    let mut staged = images.clone();
    let (mut changed, mut created, mut dropped) = (Vec::new(), Vec::new(), Vec::new());
    for (n, a) in &after {
        let unchanged = *a == sub[n];
        match (temps.contains_key(n), unchanged) {
            (true, true) => dropped.push(n.clone()),
            (true, false) => {
                staged.insert(n.clone(), a.clone());
                created.push(n.clone());
            }
            (false, true) => {}
            (false, false) => {
                for (sn, s) in staged.iter_mut() {
                    if s.key == a.key {
                        *s = a.clone();
                        changed.push(sn.clone());
                    }
                }
            }
        }
    }
    changed.sort();
    changed.dedup();
    if staged.len() > MAX_TOTAL_IMAGES {
        return Err(format!(
            "SUBMAP_PERSISTENT_BOUND:{}>{}",
            staged.len(),
            MAX_TOTAL_IMAGES
        ));
    }
    judge(images, &staged, &receipts)?;
    let report = SubMapDispatch {
        receipts,
        sub_map_len: sub.len(),
        changed,
        created,
        dropped,
    };
    *images = staged;
    Ok(report)
}

// ------------------------------------------------------------ tests

#[cfg(test)]
mod tests {
    use super::*;
    use crate::land_bootstrap::Metadata;
    use permutation_frontier::layout::summary as SU;

    fn unhex(s: &str) -> Vec<u8> {
        assert!(s.len() % 2 == 0, "even hex");
        (0..s.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&s[i..i + 2], 16).expect("hex"))
            .collect()
    }

    /// The committed fixtures, parsed here (no engine, exporter or signing
    /// code is called).
    fn fixture() -> (Images, Metadata) {
        let mut images = Images::new();
        for line in include_str!("fixtures/accounts.tsv").lines() {
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            let f: Vec<&str> = line.split('\t').collect();
            assert_eq!(f.len(), 5, "accounts.tsv columns");
            let im = Image {
                key: unhex(f[1]).try_into().expect("key"),
                owner: unhex(f[2]).try_into().expect("owner"),
                lamports: f[3].parse().expect("lamports"),
                data: unhex(f[4]),
            };
            assert!(images.insert(f[0].to_string(), im).is_none());
        }
        let mut meta = Metadata::new();
        for line in include_str!("fixtures/metadata.tsv").lines() {
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            let (k, v) = line.split_once('\t').expect("pair");
            meta.insert(k.to_string(), v.to_string());
        }
        (images, meta)
    }

    fn genesis(meta: &Metadata) -> i64 {
        meta["genesis"].parse().unwrap()
    }

    /// Fixture, land installed, (129,−2) opened at the session's bell 6.
    fn opened() -> (Images, Metadata) {
        let (mut images, meta) = fixture();
        land::install(&mut images, &meta).expect("land install");
        let initial = genesis(&meta) + 6 * 600 + 60;
        land::open_province(&mut images, 129, -2, initial, 1_006).expect("open (129,-2)");
        (images, meta)
    }

    /// The engine's post_reveal instant (bell 21 + 213 s), slot 1,021.
    fn bell21(meta: &Metadata) -> i64 {
        genesis(meta) + 21 * 600 + 213
    }

    fn context(images: &Images) -> (u64, AddrCtx, SeasonClock) {
        let l = land::season_context(images).unwrap();
        let clock = SeasonClock::read(&images["season"].data).unwrap();
        (l.season_id, ctx_of(l.season_key), clock)
    }

    #[test]
    fn destination_stage_synthetic_pairs_match_exported_fixture_pairs_byte_for_byte() {
        let (images, meta) = fixture();
        let (sid, ctx, clock) = context(&images);
        let region: u8 = meta["region"].parse().unwrap();
        let origin_region: u8 = meta["origin_region"].parse().unwrap();
        for (bell, r, cache, anchor) in [
            (21, region, "destination_cache_21", "destination_anchor_21"),
            (22, region, "destination_cache_22", "destination_anchor_22"),
            (23, region, "destination_cache_23", "destination_anchor_23"),
            (5, origin_region, "origin_cache_5", "origin_anchor_5"),
            (6, origin_region, "origin_cache_6", "origin_anchor_6"),
        ] {
            let pair = synthetic_pair(&ctx, sid, &clock, bell, r).unwrap();
            assert_eq!(pair.cache, images[cache], "{cache}");
            assert_eq!(pair.anchor, images[anchor], "{anchor}");
            assert_eq!(pair.tlock_round, clock.tlock_round(bell));
            assert_eq!(pair.a, clock.round_time(pair.tlock_round) + 30);
            assert_eq!(pair.seed_round, clock.seed_round(bell, pair.a));
        }
        assert_eq!(
            beacon_log_fixture(&ctx, sid, region).unwrap(),
            images["beacon_log"]
        );
    }

    #[test]
    fn destination_stage_arrival_plan_aliases_every_existing_fixture_account() {
        let (images, meta) = fixture();
        let p: i64 = meta["destination_p"].parse().unwrap();
        let q: i64 = meta["destination_q"].parse().unwrap();
        let plan = arrival_plan(&images, p, q).expect("plan");
        let mut want: Vec<String> = [
            "arrival_anchor",
            "arrival_cache",
            "archive",
            "beacon_log",
            "destination_inputs_20",
            "destination_day",
            "destination_roster",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        for f in 0..6 {
            for i in 0..4 {
                want.push(format!("slot_{f}_{i}"));
            }
        }
        for b in 21..=23 {
            want.push(format!("destination_inputs_{b}"));
            want.push(format!("destination_cache_{b}"));
            want.push(format!("destination_anchor_{b}"));
        }
        let got: Vec<String> = plan.iter().map(|a| a.name.clone()).collect();
        assert_eq!(got, want);
        for a in &plan {
            assert!(a.temporary.is_none(), "{} exists in the fixture", a.name);
            assert_eq!(images[&a.name].key, a.key, "{}", a.name);
        }
    }

    #[test]
    fn destination_stage_prepares_opened_province_through_bell19_at_bell21() {
        let (mut images, meta) = opened();
        let before = images.clone();
        let name = land::province_name(WideCoord::checked(129, -2).unwrap());
        assert_eq!(rd_u32(&images[&name].data, PV2::RESOLVED_NEXT), Some(6));
        let now = bell21(&meta);
        let out = prepare_destination(&mut images, 129, -2, now, 1_021).expect("prepare");
        assert_eq!((out.from_bell, out.to_bell, out.resolved_next), (6, 19, 20));
        assert_eq!((out.name.as_str(), out.now), (name.as_str(), now));
        assert_eq!(out.provenance, PROVENANCE_PREPARED);
        assert_eq!(out.receipts.len(), 14);
        for (body, bell) in out.receipts.iter().zip(6u32..) {
            let r = ev::WideRecord::decode(body).unwrap();
            assert_eq!((r.kind, r.bell), (WideKind::Resolve, bell));
        }
        assert_eq!(out.pairs.len(), 14);
        // The cursor and the score pin the exporter asserted (`:6301-6302`).
        let pd = &images[&name].data;
        assert_eq!(rd_u32(pd, PV2::RESOLVED_NEXT), Some(20));
        assert_eq!(rd_u32(pd, PV2::SCORE_NEXT_BELL), Some(20));
        assert_eq!(out.score_next_bell, 20);
        assert_eq!(rd_u32(pd, PV2::RESOLVE_SUMMARY + SU::BELL), Some(19));
        // Only the province changed: source, economy, records and funds kept.
        assert_eq!(images.len(), before.len());
        for (n, im) in &before {
            if *n != name {
                assert_eq!(images.get(n), Some(im), "{n}");
            }
        }
        for (field, range) in &GATED {
            assert_eq!(
                images[&name].data[range.clone()],
                before[&name].data[range.clone()],
                "{field}"
            );
        }
        // Prepared once: a second call refuses and changes nothing.
        let snap = images.clone();
        assert_eq!(
            prepare_destination(&mut images, 129, -2, now, 1_021).unwrap_err(),
            "DEST_STAGE_ALREADY_PREPARED"
        );
        assert_eq!(images, snap);
    }

    #[test]
    fn destination_stage_is_deterministic() {
        let (images, meta) = opened();
        let now = bell21(&meta);
        let (mut a, mut b) = (images.clone(), images);
        let ra = prepare_destination(&mut a, 129, -2, now, 1_021).unwrap();
        let rb = prepare_destination(&mut b, 129, -2, now, 1_021).unwrap();
        assert_eq!(ra, rb);
        assert_eq!(a, b);
    }

    #[test]
    fn destination_stage_refuses_early_time_without_mutation() {
        let (mut images, meta) = opened();
        let g = genesis(&meta);
        let (sid, ctx, clock) = context(&images);
        let dest = destination(&images, 129, -2).unwrap();
        let last = synthetic_pair(&ctx, sid, &clock, 19, dest.region).unwrap();
        let earliest = clock.reveal_close(19, last.a);
        assert_eq!(
            earliest,
            g + 21 * 600 + 30,
            "bell 19's window closes 30 s into bell 21"
        );
        let snap = images.clone();
        for now in [
            g + 6 * 600 + 60,
            g + 20 * 600 + 599,
            g + 21 * 600,
            earliest - 1,
        ] {
            assert_eq!(
                prepare_destination(&mut images, 129, -2, now, 1_021).unwrap_err(),
                "DEST_STAGE_TOO_EARLY",
                "{now}"
            );
            assert_eq!(images, snap);
        }
        // The boundary itself is accepted by the real handler.
        prepare_destination(&mut images, 129, -2, earliest, 1_021).expect("at the close");
    }

    #[test]
    fn destination_stage_refuses_invalid_targets_without_mutation() {
        let (mut images, meta) = opened();
        let now = bell21(&meta);
        let snap = images.clone();
        for (p, q, want) in [
            (129, -1, "DEST_STAGE_TARGET"),
            (129, 0, "DEST_STAGE_TARGET"),
            (129, -3, "DEST_STAGE_TARGET_MISSING"),
            (128, 1, "DEST_STAGE_TARGET_MISSING"),
            (i64::MAX, 0, "DEST_STAGE_COORD"),
        ] {
            assert_eq!(
                prepare_destination(&mut images, p, q, now, 1_021).unwrap_err(),
                want,
                "({p},{q})"
            );
        }
        assert_eq!(images, snap);
    }

    #[test]
    fn destination_stage_rolls_back_a_mid_sequence_handler_refusal() {
        let (mut images, meta) = opened();
        let (_, ctx, _) = context(&images);
        let dest = destination(&images, 129, -2).unwrap();
        // A program-owned record at bell 12's ClashInputs key: bells 6 to
        // 11 resolve on the staged copy, then the real handler refuses.
        images.insert(
            "intruder_inputs_12".into(),
            Image {
                key: wa::clash_inputs_address(&ctx, dest.key, 12),
                owner: PROGRAM,
                lamports: 1,
                data: vec![1; 8],
            },
        );
        let snap = images.clone();
        let err = prepare_destination(&mut images, 129, -2, bell21(&meta), 1_021).unwrap_err();
        assert!(err.starts_with("DEST_STAGE_REFUSED:12:"), "{err}");
        assert_eq!(images, snap);
        assert_eq!(
            rd_u32(&images[&dest.name].data, PV2::RESOLVED_NEXT),
            Some(6)
        );
    }

    #[test]
    fn destination_stage_refuses_conflicting_existing_records_without_mutation() {
        let (images, meta) = opened();
        let now = bell21(&meta);
        let (sid, ctx, clock) = context(&images);
        let dest = destination(&images, 129, -2).unwrap();
        // A different record at the synthetic cache key of bell 6.
        let mut forged = synthetic_pair(&ctx, sid, &clock, 6, dest.region)
            .unwrap()
            .cache;
        forged.data[SC::SEED] ^= 1;
        let mut a = images.clone();
        a.insert("foreign_cache".into(), forged);
        let snap = a.clone();
        assert_eq!(
            prepare_destination(&mut a, 129, -2, now, 1_021).unwrap_err(),
            "DEST_STAGE_CONFLICT:foreign_cache"
        );
        assert_eq!(a, snap);
        // A planned name already taken by another key.
        let mut b = images.clone();
        let taken = format!("{}_roster", dest.name);
        b.insert(taken.clone(), images["payer"].clone());
        let snap = b.clone();
        assert_eq!(
            prepare_destination(&mut b, 129, -2, now, 1_021).unwrap_err(),
            format!("DEST_STAGE_NAME_CONFLICT:{taken}")
        );
        assert_eq!(b, snap);
    }

    #[test]
    fn destination_stage_temporaries_are_bounded_and_dropped_only_when_unchanged() {
        let (images, _) = opened();
        let plan = arrival_plan(&images, 129, -2).expect("plan");
        assert_eq!(plan.len(), 7 + 24 + 9);
        let mut names: Vec<&String> = plan.iter().map(|a| &a.name).collect();
        names.sort();
        names.dedup();
        assert_eq!(names.len(), plan.len(), "unique names");
        let temps = plan.iter().filter(|a| a.temporary.is_some()).count();
        assert!(images.len() + temps > MAX_TOTAL_IMAGES);
        assert_eq!(
            stage_temporaries(&images, &plan).unwrap_err(),
            format!(
                "DEST_STAGE_ACCOUNT_BOUND:{}>{}",
                images.len() + temps,
                MAX_TOTAL_IMAGES
            )
        );
        // A small staging fits, and only changed temporaries are retained.
        let few: Vec<PlannedAccount> = plan
            .iter()
            .filter(|a| a.temporary.is_some())
            .take(TEMPORARIES_PER_RESOLVE)
            .cloned()
            .collect();
        let mut stage = stage_temporaries(&images, &few).expect("fits");
        assert_eq!(stage.len(), images.len() + few.len());
        stage.get_mut(&few[0].name).unwrap().lamports = 1;
        assert_eq!(
            drop_unchanged_temporaries(&mut stage, &few),
            vec![few[0].name.clone()]
        );
        assert_eq!(stage.len(), images.len() + 1);
        // A temporary never replaces an existing name or key.
        let mut clash = few[0].clone();
        clash.name = "payer".into();
        assert!(stage_temporaries(&images, &[clash]).is_err());
        assert!(DESTINATION_EVIDENCE_LABELS
            .iter()
            .all(|(k, v)| !k.is_empty() && !v.is_empty()));
    }

    // ---------------------------------------------- sub-map dispatch tests

    /// Fixture, land installed, the first of four ring-129 candidates whose
    /// region is not the fixture destination's (so no bell-20 fixture image
    /// aliases its arrival anchor) opened at bell 6 and prepared at bell 21.
    fn prepared_outside_fixture_region() -> (Images, Metadata, i64, i64) {
        let (mut images, meta) = fixture();
        land::install(&mut images, &meta).expect("land install");
        let fixture_region: u8 = meta["region"].parse().unwrap();
        let (p, q) = [(129, -2), (129, -3), (128, 1), (127, 2)]
            .into_iter()
            .find(|&(p, q)| wr::wide_region(WideCoord::checked(p, q).unwrap()) != fixture_region)
            .expect("a candidate outside the fixture destination's region");
        let g = genesis(&meta);
        land::open_province(&mut images, p, q, g + 6 * 600 + 60, 1_006).expect("open");
        prepare_destination(&mut images, p, q, bell21(&meta), 1_021).expect("prepare");
        (images, meta, p, q)
    }

    /// The engine's resolve_arrival instant (bell 22 + 300 s), slot 1,022:
    /// after bell 20's reveal window closes for the T-model anchor fixture
    /// (`A = bell_end(20) + 30`, close `A + 600 = bell_start(22) + 30`).
    fn bell22(meta: &Metadata) -> i64 {
        genesis(meta) + 22 * 600 + 300
    }

    fn role<'a>(plan: &'a [PlannedAccount], r: &str) -> &'a PlannedAccount {
        plan.iter().find(|a| a.role == r).expect("planned role")
    }

    /// The permitted subset and metas of a no-arrival Gather of bell 20:
    /// the bell-20 anchor as a **synthetic local fixture** (`stage_seed`'s
    /// shape; no signature), the absent ClashInputs, ArrivalDay and 24
    /// slots; every transit position the system program, as the engine
    /// lists non-faction positions (`engine.rs` resolve_arrival).
    fn gather_call(images: &Images, p: i64, q: i64) -> (Vec<PlannedAccount>, Vec<Meta>) {
        let (sid, ctx, clock) = context(images);
        let dest = destination(images, p, q).unwrap();
        let plan = arrival_plan(images, p, q).unwrap();
        let mut anchor = role(&plan, "arrival_anchor").clone();
        assert!(
            anchor.temporary.is_some(),
            "no fixture image at this region's anchor"
        );
        anchor.temporary = Some(
            synthetic_pair(&ctx, sid, &clock, 20, dest.region)
                .unwrap()
                .anchor,
        );
        let inputs = role(&plan, "inputs_20").clone();
        let day = role(&plan, "day").clone();
        let mut permitted = vec![anchor.clone(), inputs.clone(), day.clone()];
        let mut metas = vec![
            acct("payer", true, true),
            acct("season", false, false),
            acct(&dest.name, false, false),
            acct(&anchor.name, false, false),
            acct(&inputs.name, false, true),
            acct(&day.name, false, false),
            acct("ix_sysvar", false, false),
            acct("system", false, false),
        ];
        for j in 0..24 {
            let slot = role(&plan, &format!("slot_{}_{}", j / 4, j % 4)).clone();
            metas.push(acct(&slot.name, false, false));
            metas.push(acct("system", false, false));
            permitted.push(slot);
        }
        (permitted, metas)
    }

    fn gather_bytes() -> [u8; wix::Gather::LEN] {
        wix::Gather {
            bell: 20,
            start: 0,
            n: 24,
        }
        .to_bytes()
    }

    fn accept(_: &Images, _: &Images, _: &[Vec<u8>]) -> Result<(), String> {
        Ok(())
    }

    #[test]
    fn destination_stage_sub_map_real_gather_and_resolve_on_prepared_empty_destination() {
        let (mut images, meta, p, q) = prepared_outside_fixture_region();
        let before = images.clone();
        let dest = destination(&images, p, q).unwrap();
        // The full arrival plan cannot be staged on the whole map.
        let plan = arrival_plan(&images, p, q).unwrap();
        assert_eq!(plan.len(), 40);
        assert!(stage_temporaries(&images, &plan)
            .unwrap_err()
            .starts_with("DEST_STAGE_ACCOUNT_BOUND:"));
        // The needed subset, over a sub-map, runs the real Gather.
        let (permitted, metas) = gather_call(&images, p, q);
        let data = gather_bytes();
        let now = bell22(&meta);
        let call = SubMapCall {
            metas: &metas,
            instruction: &data,
            now,
            slot: 1_022,
            allow_beacon_logs: false,
        };
        let out = dispatch_sub_map(&mut images, &permitted, &call, |_, _, receipts| {
            let [body] = receipts else {
                return Err("GATHER_RECEIPTS".into());
            };
            let r = ev::WideRecord::decode(body).map_err(|_| "GATHER_RECEIPTS")?;
            if r.kind != WideKind::Gathered || r.province() != Some(dest.key) {
                return Err("GATHER_RECEIPTS".into());
            }
            Ok(())
        })
        .expect("real Gather over the sub-map");
        let inputs = role(&plan, "inputs_20").name.clone();
        assert_eq!(out.created, vec![inputs.clone()]);
        assert_eq!(out.changed, vec!["payer".to_string()]);
        assert_eq!(out.dropped.len(), permitted.len() - 1);
        assert!(out.sub_map_len <= RUNTIME_MAX_IMAGES && out.sub_map_len < metas.len());
        assert_eq!(images.len(), before.len() + 1);
        let cd = &images[&inputs];
        assert_eq!(cd.owner, PROGRAM);
        let ih = wa::WideClashInputsHdr::read(&cd.data).unwrap();
        assert_eq!(ih.arrivals_mask, wa::wide_clash_inputs::ALL_GATHERED);
        assert_ne!(ih.flags & wa::wide_clash_inputs::FLAG_NO_ARRIVALS, 0);
        assert_eq!(ih.n_present, 0);
        let rent =
            solana_program::rent::Rent::default().minimum_balance(wa::wide_clash_inputs::SIZE);
        assert_eq!(cd.lamports, rent);
        assert_eq!(images["payer"].lamports, before["payer"].lamports - rent);
        for (n, im) in &before {
            if n != "payer" {
                assert_eq!(images.get(n), Some(im), "{n}");
            }
        }
        // Then the real bell-20 Resolve over the gathered record, with the
        // bell-20 pair as synthetic local fixtures (no march arrived).
        let (sid, ctx, clock) = context(&images);
        let pair = synthetic_pair(&ctx, sid, &clock, 20, dest.region).unwrap();
        let mut cache = role(&plan, "arrival_cache").clone();
        cache.temporary = Some(pair.cache);
        let mut anchor = role(&plan, "arrival_anchor").clone();
        anchor.temporary = Some(pair.anchor);
        let roster = role(&plan, "roster").clone();
        let day = role(&plan, "day").clone();
        let gathered = PlannedAccount {
            role: "inputs_20".into(),
            name: inputs.clone(),
            key: images[&inputs].key,
            temporary: None,
        };
        let permitted = [
            cache.clone(),
            anchor.clone(),
            roster.clone(),
            day.clone(),
            gathered,
        ];
        let metas = [
            acct("payer", true, true),
            acct("season", false, false),
            acct(&dest.name, false, true),
            acct(&roster.name, false, true),
            acct(&cache.name, false, false),
            acct(&anchor.name, false, false),
            acct(&inputs, false, true),
            acct(&day.name, false, false),
            acct("system", false, false),
        ];
        let data = wix::Resolve {
            bell: 20,
            beneficiary: BENEFICIARY,
        }
        .to_bytes();
        let mid = images.clone();
        let call = SubMapCall {
            metas: &metas,
            instruction: &data,
            now,
            slot: 1_022,
            allow_beacon_logs: false,
        };
        let out = dispatch_sub_map(&mut images, &permitted, &call, |b, a, receipts| {
            let start = chain_of(&b[&dest.name].data).map_err(|_| "CHAIN")?;
            let end = chain_of(&a[&dest.name].data).map_err(|_| "CHAIN")?;
            let ok = ev::verify_chain(
                WideTarget::Province(dest.key),
                start,
                receipts.iter().map(|v| v.as_slice()),
            ) == Ok(end);
            ok.then_some(()).ok_or_else(|| "CHAIN".to_string())
        })
        .expect("real bell-20 Resolve over the sub-map");
        assert_eq!(out.created, Vec::<String>::new());
        let mut want = vec![dest.name.clone(), inputs.clone()];
        want.sort();
        assert_eq!(out.changed, want);
        assert_eq!(images.len(), mid.len());
        assert_eq!(
            rd_u32(&images[&dest.name].data, PV2::RESOLVED_NEXT),
            Some(21)
        );
        let ih = wa::WideClashInputsHdr::read(&images[&inputs].data).unwrap();
        assert_ne!(ih.flags & wa::wide_clash_inputs::FLAG_RESOLVED, 0);
        for n in [
            "holding",
            "citizen",
            "origin",
            "origin_roster",
            "destination",
        ] {
            assert_eq!(images[n], before[n], "{n}");
        }
    }

    #[test]
    fn destination_stage_sub_map_enforces_bounds_without_mutation() {
        let (mut images, meta, p, q) = prepared_outside_fixture_region();
        let (permitted, metas) = gather_call(&images, p, q);
        let data = gather_bytes();
        let call = SubMapCall {
            metas: &metas,
            instruction: &data,
            now: bell22(&meta),
            slot: 1_022,
            allow_beacon_logs: false,
        };
        // Pad the persistent map to exactly 96 with unrelated absent images:
        // the Gather would create one more, so it is refused after the
        // dispatch and before the commit.
        let mut i = 0u8;
        while images.len() < MAX_TOTAL_IMAGES {
            let mut key = [0xee; 32];
            key[0] = i;
            images.insert(format!("pad_{i}"), absent(key));
            i += 1;
        }
        let snap = images.clone();
        assert_eq!(
            dispatch_sub_map(&mut images, &permitted, &call, accept).unwrap_err(),
            format!(
                "SUBMAP_PERSISTENT_BOUND:{}>{}",
                MAX_TOTAL_IMAGES + 1,
                MAX_TOTAL_IMAGES
            )
        );
        assert_eq!(images, snap);
        // Above the bound on entry.
        let mut over = images.clone();
        over.insert("pad_extra".into(), absent([0xef; 32]));
        let snap_over = over.clone();
        assert!(dispatch_sub_map(&mut over, &permitted, &call, accept)
            .unwrap_err()
            .starts_with("SUBMAP_PERSISTENT_BOUND:"));
        assert_eq!(over, snap_over);
        // Too many metas for the runtime.
        let many: Vec<Meta> = (0..RUNTIME_MAX_METAS + 1)
            .map(|_| acct("system", false, false))
            .collect();
        let call = SubMapCall {
            metas: &many,
            ..call
        };
        assert_eq!(
            dispatch_sub_map(&mut images, &[], &call, accept).unwrap_err(),
            "SUBMAP_METAS"
        );
        assert_eq!(images, snap);
    }

    #[test]
    fn destination_stage_sub_map_refuses_unknown_metas_and_malformed_plans_without_mutation() {
        let (mut images, meta, p, q) = prepared_outside_fixture_region();
        let (permitted, metas) = gather_call(&images, p, q);
        let data = gather_bytes();
        let call = SubMapCall {
            metas: &metas,
            instruction: &data,
            now: bell22(&meta),
            slot: 1_022,
            allow_beacon_logs: false,
        };
        let snap = images.clone();
        let payer_key = images["payer"].key;
        let first = permitted[0].clone();
        let mut bad_key = first.clone();
        bad_key.key[0] ^= 1;
        let cases: Vec<(Vec<PlannedAccount>, String)> = vec![
            (
                vec![PlannedAccount {
                    role: "x".into(),
                    name: "payer".into(),
                    key: [1; 32],
                    temporary: None,
                }],
                "SUBMAP_PLANNED_ALIAS:payer".into(),
            ),
            (
                vec![PlannedAccount {
                    role: "x".into(),
                    name: "season".into(),
                    key: [2; 32],
                    temporary: Some(absent([2; 32])),
                }],
                "SUBMAP_PLANNED:season".into(),
            ),
            (
                vec![PlannedAccount {
                    role: "x".into(),
                    name: "dup_payer".into(),
                    key: payer_key,
                    temporary: Some(absent(payer_key)),
                }],
                "SUBMAP_PLANNED:dup_payer".into(),
            ),
            (
                vec![bad_key.clone()],
                format!("SUBMAP_PLANNED:{}", bad_key.name),
            ),
            (
                vec![first.clone(), first.clone()],
                format!("SUBMAP_PLANNED:{}", first.name),
            ),
        ];
        for (plan, want) in cases {
            assert_eq!(
                dispatch_sub_map(&mut images, &plan, &call, accept).unwrap_err(),
                want
            );
            assert_eq!(images, snap);
        }
        // A meta naming nothing known, and a permitted temporary no meta lists.
        let mut unknown = metas.clone();
        unknown.push(acct("nope", false, false));
        let c = SubMapCall {
            metas: &unknown,
            ..call
        };
        assert_eq!(
            dispatch_sub_map(&mut images, &permitted, &c, accept).unwrap_err(),
            "SUBMAP_UNKNOWN_META:nope"
        );
        let mut extra = permitted.clone();
        extra.push(PlannedAccount {
            role: "x".into(),
            name: "unlisted".into(),
            key: [3; 32],
            temporary: Some(absent([3; 32])),
        });
        assert_eq!(
            dispatch_sub_map(&mut images, &extra, &call, accept).unwrap_err(),
            "SUBMAP_UNUSED_PLANNED:unlisted"
        );
        assert_eq!(images, snap);
    }

    #[test]
    fn destination_stage_sub_map_handler_or_judge_failure_preserves_whole_map() {
        let (mut images, meta, p, q) = prepared_outside_fixture_region();
        let (permitted, metas) = gather_call(&images, p, q);
        let data = gather_bytes();
        let snap = images.clone();
        // The real handler refuses: one second before bell 20's window closes.
        let early = SubMapCall {
            metas: &metas,
            instruction: &data,
            now: genesis(&meta) + 22 * 600 + 29,
            slot: 1_022,
            allow_beacon_logs: false,
        };
        let err = dispatch_sub_map(&mut images, &permitted, &early, accept).unwrap_err();
        assert!(err.starts_with("SUBMAP_REFUSED:"), "{err}");
        assert_eq!(images, snap);
        // The handler succeeds but the caller's judge refuses.
        let call = SubMapCall {
            now: bell22(&meta),
            ..early
        };
        assert_eq!(
            dispatch_sub_map(&mut images, &permitted, &call, |_, _, _| Err(
                "JUDGE_NO".into()
            ))
            .unwrap_err(),
            "JUDGE_NO"
        );
        assert_eq!(images, snap);
    }

    #[test]
    fn destination_stage_sub_map_keeps_unlisted_aliases_consistent_and_unrelated_images() {
        let (mut images, meta, p, q) = prepared_outside_fixture_region();
        // An unlisted alias of the payer: same key, same bytes.
        images.insert("payer_alias".into(), images["payer"].clone());
        let before = images.clone();
        let (permitted, metas) = gather_call(&images, p, q);
        let data = gather_bytes();
        let call = SubMapCall {
            metas: &metas,
            instruction: &data,
            now: bell22(&meta),
            slot: 1_022,
            allow_beacon_logs: false,
        };
        let out = dispatch_sub_map(&mut images, &permitted, &call, accept).expect("gather");
        assert_eq!(
            out.changed,
            vec!["payer".to_string(), "payer_alias".to_string()]
        );
        assert_eq!(images["payer"], images["payer_alias"]);
        assert_ne!(images["payer"], before["payer"]);
        for (n, im) in &before {
            if n != "payer" && n != "payer_alias" {
                assert_eq!(images.get(n), Some(im), "{n}");
            }
        }
        // Deterministic: the same call on the same map gives the same result.
        let mut again = before.clone();
        let out2 = dispatch_sub_map(&mut again, &permitted, &call, accept).unwrap();
        assert_eq!((out2, again), (out, images));
    }
}
