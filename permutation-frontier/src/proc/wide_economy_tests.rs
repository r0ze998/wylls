//! Fixed-data tests of [`super`]: the S1 preview over literal wide holding
//! and wide province byte images. No account, signer, address derivation
//! or dispatch is touched. Every fixture carries the identity the pins
//! assert; a passing preview proves the bytes pass the module's listed
//! identity and state checks against the pins, and nothing about any
//! chain, owner or authorisation. The fixtures are minimal decoder and
//! preview images, not generated gameplay records.

use alloc::vec;
use alloc::vec::Vec;

use frontier_abi::layout::header;
use frontier_abi::world_index::holding::wide_holding as WH;
use frontier_abi::world_index::land::{province as WP, readiness};
use frontier_abi::world_index::{
    WideCoord, WideHolding, WideProvince, WorldId, HOST_IDENTITY_FULL_REF_V1, WIDE_BOUND,
};
use permutation_rules::fixed::MILLI;
use permutation_rules::frontier::arms;
use permutation_rules::frontier::catalog::{self, Cost};
use permutation_rules::frontier::doctrine::of_faction_v3;
use permutation_rules::frontier::holding::{
    Effect, Holding as KHolding, QueueItem, Resource, Tier, DAY, HOUR, MAX_WALLS,
};

use super::{preview, Action, Clock, Outcome, Pins, Preview};
use crate::error::{BAD_ACCOUNT, OVERFLOW};
use crate::layout::player::{accrual, queue_item as QI, transit as T};
use crate::layout::{
    cohort, holding as H, holding2 as H2, province as P, site as SM, site2 as SM2, Ro, Rw,
};
use crate::proc::holding::{
    queue_kind, read_holding, terrain_ore, touch, train_cost, write_holding, ITEM_TIER_UP,
};
use crate::{CqError, Error, FrontierError, R};

// ------------------------------------------------------------ fixture

const SEASON: u64 = 7;
const WORLD: [u8; 32] = [0x5A; 32];
const OWNER: [u8; 32] = [0xC1; 32];
const SITE: u8 = 3;
const GEN: u8 = 2;
const SLOT: u8 = 2;
/// "B Tide": the neutral wall cost, so walls cost exactly 300 stone.
const FACTION: u8 = 1;
const ORE: i64 = 10 * MILLI;
const GENESIS: i64 = 1_700_000_000;
/// Bell 52; the stores settle from here.
const FOUNDED: i64 = GENESIS + 31_200;
/// Bell 100, eight whole hours after the founding.
const NOW: i64 = GENESIS + 60_000;
const RESOLVED_NEXT: u32 = 99;
const WALLS: Action = Action::Build {
    item: catalog::ITEM_WALLS,
};
const TIER_UP: Action = Action::Build { item: ITEM_TIER_UP };
/// Stores credited at founding (milli): food, wood, stone, ore, arms, gold.
const RICH: [i64; 8] = [
    1_000_000, 1_500_000, 1_200_000, 500_000, 300_000, 600_000, 0, 0,
];
const BAD: Error = BAD_ACCOUNT;
const QUEUE_FULL: Error = Error::Frontier(FrontierError::QueueFull);
const BAD_DATA: Error = Error::Frontier(FrontierError::BadData);
const KERNEL: Error = Error::Frontier(FrontierError::Kernel);

/// Holding bytes no successful preview changes: header and chain, prefix
/// identity, ticket, founding, host sequence, shield, delegate, transits,
/// explore, escrow, rent payer, final_ts, pool debt, the v2 capture block
/// with the terrain ore, and the whole trailer.
const KEPT: &[(usize, usize)] = &[
    (0, header::H_SIZE),
    (H::P, 7),
    (H::OWNER_CITIZEN, 32),
    (H::TICKET_SCORE, 8),
    (H::FACTION, 2),
    (H::TICKET_BELL, 4),
    (H::FOUNDED_TS, 12),
    (H::HOST_SEQ, 4),
    (H::SHIELD_UNTIL, 8),
    (H::DELEGATE, 32),
    (H::TRANSIT, H::TRANSIT_N * T::SIZE),
    (H::EXPLORE, 24),
    (H::ESCROW, 8),
    (H::RENT_PAYER, 32),
    (H::FINAL_TS, 8),
    (H::POOL_OWED, 8),
    (H2::PREV_OWNER_TAG, 32),
    (WH::TRAILER, WH::SIZE - WH::TRAILER),
];

fn world() -> WorldId {
    WorldId::new(WORLD).unwrap()
}

fn coord() -> WideCoord {
    WideCoord::checked(200, -50).unwrap()
}

/// A Hamlet founded at `FOUNDED` with the S1 base production over `ORE`,
/// the given credits, and its stores carrying the rates (as the owner touch
/// of a founding write leaves them).
fn kernel_holding(credits: &[i64; 8]) -> KHolding {
    let mut h = KHolding::found(FOUNDED, 0, SLOT);
    h.production = arms::base_production(Tier::Hamlet, ORE);
    for (r, v) in credits.iter().enumerate().filter(|(_, v)| **v > 0) {
        h.credit(FOUNDED, Resource::ALL[r], *v).unwrap();
    }
    h.touch_owner(FOUNDED).unwrap();
    h
}

fn holding_bytes_for(coord: WideCoord, h: &KHolding) -> Vec<u8> {
    let mut d = vec![0u8; WH::SIZE];
    WideHolding {
        season_id: SEASON,
        world: world(),
        coord,
        site: SITE,
        gen: GEN,
        slot: SLOT,
        owner_citizen: OWNER,
        host_identity: HOST_IDENTITY_FULL_REF_V1,
        open_transits: 0,
    }
    .write_identity(&mut d)
    .unwrap();
    {
        let mut w = Rw(&mut d);
        w.set_u64(header::EVENT_SEQ, 12).unwrap();
        w.set_arr(header::EVENT_HEAD, &[0xE1; 32]).unwrap();
        w.set_u8(H::TILE, 17).unwrap();
        w.set_u8(H::STATE, H::STATE_FINAL).unwrap();
        w.set_u64(H::TICKET_SCORE, 4_242).unwrap();
        w.set_u8(H::FACTION, FACTION).unwrap();
        w.set_u32(H::TICKET_BELL, 40).unwrap();
        w.set_u32(H::HOST_SEQ, 3).unwrap();
        w.set_i64(H::SHIELD_UNTIL, FOUNDED + 48 * HOUR).unwrap();
        w.set_u32(H::reserve(3), 7).unwrap();
        w.set_arr(H::DELEGATE, &[0xD3; 32]).unwrap();
        // stale payload of a free (legacy-layout) transit record, kept
        // verbatim: shows the preview never writes the transit block; it
        // is not a test of an active transit's lifecycle
        w.set_u64(H::transit(1) + T::HOST_ID, 0x7E57).unwrap();
        w.set_u64(H::ESCROW, 55_555).unwrap();
        w.set_arr(H::RENT_PAYER, &[0xA7; 32]).unwrap();
        w.set_i64(H::FINAL_TS, FOUNDED + HOUR).unwrap();
        w.set_u64(H::POOL_OWED, 9_999).unwrap();
        w.set_u8(H2::CAPTURE_FLAGS, 1).unwrap();
        w.set_i64(H2::TERRAIN_ORE, ORE).unwrap();
    }
    write_holding(&mut d, h, FOUNDED).unwrap();
    d
}

fn holding_bytes() -> Vec<u8> {
    holding_bytes_for(coord(), &kernel_holding(&RICH))
}

/// A minimal decoder/preview fixture, not a full generated or
/// gameplay-valid Province: the identity and readiness `WideProvince::read`
/// requires, `resolved_next`, and one site mirror holding this fixture's
/// holding. Terrain, site count and the other mirrors stay zero. Cohorts
/// start empty and finality tests populate them explicitly; finality reads
/// those records. The mirror's tier-next field starts at zero rather than
/// the generated sentinel, so this is not a Resolve integration fixture.
fn province_bytes_at(coord: WideCoord) -> Vec<u8> {
    let mut d = vec![0u8; WP::SIZE];
    WideProvince {
        season_id: SEASON,
        world: world(),
        coord,
        wedge: coord.wedge().unwrap(),
        region: 5,
        opened_bell: 3,
        readiness: readiness::REQUIRED,
        seed_round: 11,
        ring_seed: [0x9D; 32],
        funded_lamports: 1_000_000,
    }
    .write_identity(&mut d)
    .unwrap();
    let mut w = Rw(&mut d);
    w.set_u32(P::RESOLVED_NEXT, RESOLVED_NEXT).unwrap();
    let o = P::site(SITE as usize);
    w.set_u8(o + SM::STATE, SM::STATE_HOLDING).unwrap();
    w.set_u8(o + SM::FACTION, FACTION).unwrap();
    w.set_u8(o + SM::ORDER, SLOT).unwrap();
    w.set_u8(o + SM::GEN, GEN).unwrap();
    w.set_u32(o + SM::GARRISON, 250).unwrap();
    w.set_u32(o + SM::WALLS_COMMITTED, 100).unwrap();
    w.set_u32(o + SM::SHIELD_UNTIL_BELL, 7).unwrap();
    d
}

fn province_bytes() -> Vec<u8> {
    province_bytes_at(coord())
}

fn pins() -> Pins {
    Pins {
        season_id: SEASON,
        world: world(),
        coord: coord(),
        site: SITE,
        gen: GEN,
        slot: SLOT,
        owner_citizen: OWNER,
    }
}

fn clock() -> Clock {
    Clock {
        genesis_ts: GENESIS,
        now_ts: NOW,
    }
}

fn at(now_ts: i64) -> Clock {
    Clock {
        genesis_ts: GENESIS,
        now_ts,
    }
}

/// Runs the preview and pins both source snapshots byte for byte.
fn run(hd: &[u8], pd: &[u8], pins: &Pins, clock: &Clock, action: Action) -> R<Preview> {
    let (h0, p0) = (hd.to_vec(), pd.to_vec());
    let r = preview(hd, pd, pins, clock, action);
    assert_eq!(hd, &h0[..], "holding snapshot changed");
    assert_eq!(pd, &p0[..], "province snapshot changed");
    r
}

fn go(hd: &[u8], pd: &[u8], action: Action) -> R<Preview> {
    run(hd, pd, &pins(), &clock(), action)
}

// ------------------------------------------------------------ the S1 routines
//
// These reconstruct the economic substeps of the S1 bodies over a copy with
// the same `proc::holding` helpers the module calls. They are neither
// handler execution nor an independent oracle: agreement shows the module
// composes the helpers in the stated order, not that a handler would accept.

/// The Harvest substeps over a copy: touch, write.
fn touched(hd: &[u8], now: i64) -> (Vec<u8>, KHolding) {
    let mut e = hd.to_vec();
    let ore = terrain_ore(&e).unwrap();
    let mut h = read_holding(&e).unwrap();
    touch(&mut h, now, ore).unwrap();
    write_holding(&mut e, &h, now).unwrap();
    (e, h)
}

/// The Build substeps over a copy: touch, pay, enqueue, write.
fn built(hd: &[u8], now: i64, cost: &Cost, secs: i64, effect: Effect) -> (Vec<u8>, i64) {
    let (mut e, mut h) = touched(hd, now);
    h.pay(now, cost).unwrap();
    let done = h.enqueue(now, secs, effect).unwrap();
    write_holding(&mut e, &h, now).unwrap();
    (e, done)
}

/// The Train substeps over a copy: touch, pay, write, reserve.
fn trained(hd: &[u8], now: i64, unit: u8, n: u32) -> Vec<u8> {
    let (mut e, mut h) = touched(hd, now);
    h.pay(now, &train_cost(unit, n).unwrap()).unwrap();
    write_holding(&mut e, &h, now).unwrap();
    Rw(&mut e).add_u32(H::reserve(unit as usize), n).unwrap();
    e
}

// ------------------------------------------------------------ readers

fn store(d: &[u8], r: Resource) -> i64 {
    Ro(d).i64(H::store(r as usize) + accrual::VALUE).unwrap()
}

fn rate(d: &[u8], r: Resource) -> i64 {
    Ro(d).i64(H::store(r as usize) + accrual::RATE).unwrap()
}

fn production(d: &[u8], r: Resource) -> i64 {
    Ro(d).i64(H::PRODUCTION + 8 * r as usize).unwrap()
}

fn flags(d: &[u8]) -> u8 {
    Ro(d).u8(H::FLAGS).unwrap()
}

fn state(d: &[u8]) -> u8 {
    Ro(d).u8(H::STATE).unwrap()
}

fn build_outcome(p: &Preview) -> (Cost, i64) {
    match p.outcome {
        Outcome::Build { cost, done_at, .. } => (cost, done_at),
        o => panic!("{o:?}"),
    }
}

fn wall_offs(i: usize) -> (usize, usize) {
    let o = P::site(SITE as usize);
    match i {
        0 => (o + SM::WALL_ITEM0_BELL, o + SM::WALL_ITEM0_DELTA),
        _ => (o + SM::WALL_ITEM1_BELL, o + SM::WALL_ITEM1_DELTA),
    }
}

fn wall_item(pd: &[u8], i: usize) -> (u32, u32) {
    let (b, dl) = wall_offs(i);
    (Ro(pd).u32(b).unwrap(), Ro(pd).u32(dl).unwrap())
}

fn set_wall_item(pd: &mut [u8], i: usize, bell: u32, delta: u32) {
    let (b, dl) = wall_offs(i);
    Rw(pd).set_u32(b, bell).unwrap();
    Rw(pd).set_u32(dl, delta).unwrap();
}

fn mirror_u32(pd: &[u8], f: usize) -> u32 {
    Ro(pd).u32(P::site(SITE as usize) + f).unwrap()
}

fn mirror_u8(pd: &[u8], f: usize) -> u8 {
    pd[P::site(SITE as usize) + f]
}

fn set_mirror(pd: &mut [u8], state: u8, gen: u8) {
    let o = P::site(SITE as usize);
    pd[o + SM::STATE] = state;
    pd[o + SM::GEN] = gen;
}

fn assert_same(before: &[u8], after: &[u8], ranges: &[(usize, usize)]) {
    for &(off, len) in ranges {
        assert_eq!(
            &before[off..off + len],
            &after[off..off + len],
            "bytes {off}+{len}"
        );
    }
}

/// Everything outside this holding's mirror, and the mirror's identity and
/// garrison, as they were.
fn assert_province_kept(before: &[u8], after: &[u8]) {
    let o = P::site(SITE as usize);
    assert_eq!(after.len(), WP::SIZE);
    assert_eq!(&before[..o], &after[..o]);
    assert_eq!(&before[o + SM::SIZE..], &after[o + SM::SIZE..]);
    for f in [SM::STATE, SM::FACTION, SM::ORDER, SM::GEN] {
        assert_eq!(before[o + f], after[o + f]);
    }
    assert_eq!(mirror_u32(after, SM::GARRISON), 250);
    assert_eq!(mirror_u32(after, SM::SHIELD_UNTIL_BELL), 7);
}

// ------------------------------------------------------------ Harvest

#[test]
fn harvest_matches_the_deployed_touch_and_accrues_eight_hours() {
    let (hd, pd) = (holding_bytes(), province_bytes());
    let p = go(&hd, &pd, Action::Harvest).unwrap();
    assert_eq!(p.holding, touched(&hd, NOW).0);
    assert_eq!(p.province, None);
    assert_eq!(p.outcome, Outcome::Harvest);
    assert!(!p.became_final);
    assert_eq!(p.now_bell, 100);
    assert_eq!(p.holding.len(), WH::SIZE);
    // eight hours of the Hamlet base over the terrain ore
    assert_eq!(store(&p.holding, Resource::Food), 1_320_000);
    assert_eq!(store(&p.holding, Resource::Wood), 1_740_000);
    assert_eq!(store(&p.holding, Resource::Stone), 1_360_000);
    assert_eq!(store(&p.holding, Resource::Ore), 580_000);
    assert_eq!(store(&p.holding, Resource::Horses), 300_000);
    assert_eq!(store(&p.holding, Resource::Gold), 720_000);
    assert_eq!(store(&p.holding, Resource::Science), 40_000);
    assert_eq!(Ro(&p.holding).i64(H::LAST_OWNER_ACTION).unwrap(), NOW);
    assert_eq!(Ro(&p.holding).i64(H::store(0) + accrual::T0).unwrap(), NOW);
    assert_eq!(state(&p.holding), H::STATE_FINAL);
    assert_same(&hd, &p.holding, KEPT);
    assert_same(&hd, &p.holding, &[(H::RESERVE, 32)]);
}

#[test]
fn harvest_runs_workshops_limited_once_the_ore_input_is_exhausted() {
    // Two workshops (16 ore an hour in, 10 from the terrain) over 6 ore.
    let mut h = kernel_holding(&[
        1_000_000, 1_500_000, 1_200_000, 6_000, 300_000, 600_000, 0, 0,
    ]);
    h.production[arms::ARMS as usize] = 2 * arms::WORKSHOP_DELTA;
    h.touch_owner(FOUNDED).unwrap();
    let (hd, pd) = (holding_bytes_for(coord(), &h), province_bytes());
    let p = go(&hd, &pd, Action::Harvest).unwrap();
    assert_eq!(p.holding, touched(&hd, NOW).0);
    // dry after one hour at full speed, then 62.5% for seven hours
    assert_eq!(store(&p.holding, Resource::Ore), 0);
    assert_eq!(store(&p.holding, Resource::Horses), 343_000);
    assert_eq!(store(&p.holding, Resource::Wood), 1_697_000);
    assert_eq!(rate(&p.holding, Resource::Ore), 0);
    assert_eq!(rate(&p.holding, Resource::Horses), 5_000);
    assert_eq!(production(&p.holding, Resource::Horses), 8_000);
}

#[test]
fn harvest_clears_the_cached_dormancy_flag_and_halves_production_after_day_five() {
    let (mut hd, pd) = (holding_bytes(), province_bytes());
    let f = flags(&hd);
    Rw(&mut hd)
        .set_u8(H::FLAGS, f | H::FLAG_DORMANT_CACHE)
        .unwrap();
    let late = at(FOUNDED + 6 * DAY);
    let p = run(&hd, &pd, &pins(), &late, Action::Harvest).unwrap();
    assert_eq!(p.holding, touched(&hd, late.now_ts).0);
    assert_eq!(p.now_bell, 916);
    assert_eq!(flags(&p.holding) & H::FLAG_DORMANT_CACHE, 0);
    assert_eq!(
        Ro(&p.holding).i64(H::LAST_OWNER_ACTION).unwrap(),
        late.now_ts
    );
    // five days full, one day at half: 120 × 5 + 24 × 2.5 science
    assert_eq!(store(&p.holding, Resource::Science), 660_000);
    assert_eq!(
        store(&p.holding, Resource::Food),
        Tier::Hamlet.storage_cap()
    );
    assert_same(&hd, &p.holding, KEPT);
}

#[test]
fn harvest_applies_a_tier_up_completed_exactly_now_and_not_one_second_later() {
    for (done_at, tier, food_prod, kind, cap) in [
        (
            NOW,
            1u8,
            60_000i64,
            queue_kind::FREE,
            Tier::Town.storage_cap(),
        ),
        (
            NOW + 1,
            0,
            40_000,
            queue_kind::TIER_UP,
            Tier::Hamlet.storage_cap(),
        ),
    ] {
        let mut h = kernel_holding(&RICH);
        h.queue[0] = Some(QueueItem {
            done_at,
            effect: Effect::TierUp,
        });
        let (hd, pd) = (holding_bytes_for(coord(), &h), province_bytes());
        let p = go(&hd, &pd, Action::Harvest).unwrap();
        assert_eq!(p.holding, touched(&hd, NOW).0);
        let r = Ro(&p.holding);
        assert_eq!(r.u8(H::TIER).unwrap(), tier);
        assert_eq!(production(&p.holding, Resource::Food), food_prod);
        assert_eq!(store(&p.holding, Resource::Food), 1_320_000);
        assert_eq!(r.u8(H::queue(0) + QI::KIND).unwrap(), kind);
        assert_eq!(r.i64(H::store(0) + accrual::CAP).unwrap(), cap);
    }
}

// ------------------------------------------------------------ the lazy flip

#[test]
fn provisional_flip_is_staged_when_due_and_the_cohort_is_closed() {
    let (mut hd, pd) = (holding_bytes(), province_bytes());
    Rw(&mut hd).set_u8(H::STATE, H::STATE_PROVISIONAL).unwrap();
    // final_ts (FOUNDED + 1 h) passed; ticket bell 40 expired at bell 64
    let p = go(&hd, &pd, Action::Harvest).unwrap();
    assert!(p.became_final);
    assert_eq!(state(&p.holding), H::STATE_FINAL);
    let mut flipped = hd.clone();
    Rw(&mut flipped).set_u8(H::STATE, H::STATE_FINAL).unwrap();
    assert_eq!(p.holding, touched(&flipped, NOW).0);
    assert_same(&hd, &p.holding, KEPT);
    // the same flip on a Train's copy
    let p = go(&hd, &pd, Action::Train { unit: 0, n: 10 }).unwrap();
    assert!(p.became_final);
    assert_eq!(state(&p.holding), H::STATE_FINAL);
    assert_eq!(p.holding, trained(&flipped, NOW, 0, 10));
}

#[test]
fn provisional_flip_waits_for_an_open_cohort_or_an_unreached_final_ts() {
    let (mut hd, mut pd) = (holding_bytes(), province_bytes());
    Rw(&mut hd).set_u8(H::STATE, H::STATE_PROVISIONAL).unwrap();
    Rw(&mut hd).set_u32(H::TICKET_BELL, 90).unwrap();
    let o = P::cohort(0);
    Rw(&mut pd).set_u32(o + cohort::BELL, 90).unwrap();
    Rw(&mut pd).set_u16(o + cohort::FILED, 3).unwrap();
    Rw(&mut pd).set_u16(o + cohort::SETTLED, 1).unwrap();
    let p = go(&hd, &pd, Action::Harvest).unwrap();
    assert!(!p.became_final);
    assert_eq!(state(&p.holding), H::STATE_PROVISIONAL);
    assert_eq!(p.holding, touched(&hd, NOW).0);
    // every ticket of the cohort settled: closed, the flip is due
    Rw(&mut pd).set_u16(o + cohort::SETTLED, 3).unwrap();
    assert!(go(&hd, &pd, Action::Harvest).unwrap().became_final);
    // a final_ts still ahead keeps the state with the cohort closed
    let (mut early, pd) = (holding_bytes(), province_bytes());
    Rw(&mut early)
        .set_u8(H::STATE, H::STATE_PROVISIONAL)
        .unwrap();
    Rw(&mut early).set_i64(H::FINAL_TS, NOW + 1).unwrap();
    let p = go(&early, &pd, Action::Harvest).unwrap();
    assert!(!p.became_final);
    assert_eq!(state(&p.holding), H::STATE_PROVISIONAL);
}

#[test]
fn due_provisional_flip_is_discarded_with_a_refused_action_and_the_snapshot_keeps_its_state() {
    let pd = province_bytes();
    // the starter kit alone: final_ts (FOUNDED + 1 h) passed, ticket bell 40
    // expired at bell 64, so the flip is due and a Harvest stages it
    let mut poor = holding_bytes_for(coord(), &kernel_holding(&catalog::starter_kit()));
    Rw(&mut poor)
        .set_u8(H::STATE, H::STATE_PROVISIONAL)
        .unwrap();
    assert!(go(&poor, &pd, Action::Harvest).unwrap().became_final);
    // the same due flip followed by a refusal: Err, and the caller's bytes
    // (state byte included) exactly as supplied
    let before = poor.clone();
    let short = Err(Error::Frontier(FrontierError::Insufficient));
    assert_eq!(go(&poor, &pd, TIER_UP), short);
    assert_eq!(
        go(
            &poor,
            &pd,
            Action::Train {
                unit: 3,
                n: 100_000
            }
        ),
        short
    );
    assert_eq!(go(&poor, &pd, Action::Build { item: 0xFF }), Err(BAD_DATA));
    assert_eq!(poor, before);
    assert_eq!(state(&poor), H::STATE_PROVISIONAL);
}

/// One representative action of each kind (a building, walls, the tier-up,
/// Harvest, Train), not every item or every branch.
#[test]
fn representative_actions_preserve_the_trailer_chain_rent_escrow_transit_shield_and_host_fields() {
    let (hd, pd) = (holding_bytes(), province_bytes());
    let train = Action::Train { unit: 3, n: 150 };
    for action in [
        Action::Harvest,
        Action::Build { item: 0 },
        WALLS,
        TIER_UP,
        train,
    ] {
        let p = go(&hd, &pd, action).unwrap();
        assert_eq!(p.holding.len(), WH::SIZE);
        assert_same(&hd, &p.holding, KEPT);
        let r = Ro(&p.holding);
        assert_eq!(r.u64(header::EVENT_SEQ).unwrap(), 12);
        assert_eq!(r.arr::<32>(header::EVENT_HEAD).unwrap(), [0xE1; 32]);
        assert_eq!(r.u64(H::ESCROW).unwrap(), 55_555);
        assert_eq!(r.u64(H::POOL_OWED).unwrap(), 9_999);
        assert_eq!(r.i64(H::SHIELD_UNTIL).unwrap(), FOUNDED + 48 * HOUR);
        assert_eq!(r.u32(H::HOST_SEQ).unwrap(), 3);
        assert_eq!(r.u16(WH::HOST_IDENTITY).unwrap(), HOST_IDENTITY_FULL_REF_V1);
        // a free transit's stale payload survives: the block is not written
        // (not a statement about an active transit's lifecycle)
        assert_eq!(r.u64(H::transit(1) + T::HOST_ID).unwrap(), 0x7E57);
        assert_eq!(r.i64(H2::TERRAIN_ORE).unwrap(), ORE);
        if action != train {
            assert_same(&hd, &p.holding, &[(H::RESERVE, 32)]);
        }
        if let Some(prov) = p.province {
            assert_province_kept(&pd, &prov);
        }
    }
}

// ------------------------------------------------------------ Build

#[test]
fn build_each_building_item_matches_the_deployed_pay_then_enqueue() {
    let (hd, pd) = (holding_bytes(), province_bytes());
    let d = of_faction_v3(FACTION).unwrap();
    for item in [0u8, 1, 2, 3, 4, 5, arms::ITEM_WORKSHOP] {
        let p = go(&hd, &pd, Action::Build { item }).unwrap();
        let (cost, effect, secs) = arms::building(item, 1, d).unwrap();
        let (expect, done_at) = built(&hd, NOW, &cost, secs as i64, effect);
        assert_eq!(p.holding, expect, "item {item}");
        assert_eq!(p.province, None);
        assert_eq!(
            p.outcome,
            Outcome::Build {
                item,
                cost,
                done_at
            }
        );
        assert_eq!(done_at, NOW + 5_400);
        assert!(!p.became_final);
    }
    // the first copies, in numbers
    let p = go(&hd, &pd, Action::Build { item: 0 }).unwrap();
    assert_eq!(build_outcome(&p).0, [0, 80_000, 40_000, 0, 0, 0, 0, 0]);
    assert_eq!(store(&p.holding, Resource::Wood), 1_660_000);
    assert_eq!(store(&p.holding, Resource::Stone), 1_320_000);
    let r = Ro(&p.holding);
    assert_eq!(
        r.u8(H::queue(0) + QI::KIND).unwrap(),
        queue_kind::PRODUCTION
    );
    assert_eq!(r.u8(H::queue(0) + QI::ARG).unwrap(), Resource::Food as u8);
    assert_eq!(r.i64(H::queue(0) + QI::DELTA).unwrap(), 12_000);
    assert_eq!(r.i64(H::queue(0) + QI::DONE_AT).unwrap(), NOW + 5_400);
    let p = go(
        &hd,
        &pd,
        Action::Build {
            item: arms::ITEM_WORKSHOP,
        },
    )
    .unwrap();
    assert_eq!(
        build_outcome(&p).0,
        [60_000, 120_000, 80_000, 40_000, 0, 0, 0, 0]
    );
    let r = Ro(&p.holding);
    assert_eq!(r.u8(H::queue(0) + QI::ARG).unwrap(), arms::ARMS as u8);
    assert_eq!(
        r.i64(H::queue(0) + QI::DELTA).unwrap(),
        arms::WORKSHOP_DELTA
    );
}

#[test]
fn build_walls_writes_the_mirror_item_and_folds_items_in_force() {
    let (hd, pd) = (holding_bytes(), province_bytes());
    let cost: Cost = [0, 0, 300_000, 0, 0, 0, 0, 0];
    let p = go(&hd, &pd, WALLS).unwrap();
    assert_eq!(build_outcome(&p), (cost, NOW + 14_400));
    let effect = Effect::Walls {
        delta: catalog::WALL_STEP,
    };
    assert_eq!(p.holding, built(&hd, NOW, &cost, 14_400, effect).0);
    let prov = p.province.unwrap();
    assert_province_kept(&pd, &prov);
    // bell_at(done_at) + 1 = 124 + 1, into the free item 0
    assert_eq!(wall_item(&prov, 0), (125, 100));
    assert_eq!(wall_item(&prov, 1), (0, 0));
    assert_eq!(mirror_u32(&prov, SM::WALLS_COMMITTED), 100);
    // item 0 in force (bell 90 ≤ resolved_next 99) folds and frees its slot
    let mut pd2 = pd.clone();
    set_wall_item(&mut pd2, 0, 90, 100);
    set_wall_item(&mut pd2, 1, 150, 100);
    let prov = go(&hd, &pd2, WALLS).unwrap().province.unwrap();
    assert_eq!(mirror_u32(&prov, SM::WALLS_COMMITTED), 200);
    assert_eq!(wall_item(&prov, 0), (125, 100));
    assert_eq!(wall_item(&prov, 1), (150, 100));
    assert_province_kept(&pd2, &prov);
    // the fold is capped at MAX_WALLS; a bell equal to resolved_next is in force
    // (1,150 committed with a pending item is a synthetic branch state for the
    // cap, not shown reachable through the deployed writers)
    let mut pd3 = pd.clone();
    Rw(&mut pd3)
        .set_u32(P::site(SITE as usize) + SM::WALLS_COMMITTED, 1_150)
        .unwrap();
    set_wall_item(&mut pd3, 0, RESOLVED_NEXT, 100);
    let prov = go(&hd, &pd3, WALLS).unwrap().province.unwrap();
    assert_eq!(mirror_u32(&prov, SM::WALLS_COMMITTED), MAX_WALLS);
    assert_eq!(wall_item(&prov, 0), (125, 100));
}

#[test]
fn build_walls_refuses_a_full_mirror_with_both_snapshots_unchanged() {
    let (hd, mut pd) = (holding_bytes(), province_bytes());
    set_wall_item(&mut pd, 0, 150, 100);
    set_wall_item(&mut pd, 1, 160, 100);
    assert_eq!(go(&hd, &pd, WALLS), Err(QUEUE_FULL));
}

#[test]
fn build_walls_and_tier_up_refuse_a_mirror_bell_overflow_after_pay_and_enqueue() {
    let (hd, pd) = (holding_bytes(), province_bytes());
    // the fixture counts 600-second bells (bell 100 at NOW); a genesis this
    // far back puts NOW at bell u32::MAX, so bell_at(done_at) + 1 for any
    // normal build time cannot exist
    let late = Clock {
        genesis_ts: NOW - (u32::MAX as i64) * 600,
        now_ts: NOW,
    };
    let p = run(&hd, &pd, &pins(), &late, Action::Harvest).unwrap();
    assert_eq!(p.now_bell, u32::MAX);
    // pay and enqueue succeed on the copy, the mirror item cannot be formed:
    // Err(Overflow), both snapshots as supplied (asserted by `run`)
    for action in [WALLS, TIER_UP] {
        assert_eq!(
            run(&hd, &pd, &pins(), &late, action),
            Err(OVERFLOW),
            "{action:?}"
        );
    }
    // a building writes no mirror item and still previews at this bell
    let p = run(&hd, &pd, &pins(), &late, Action::Build { item: 0 }).unwrap();
    assert_eq!(p.province, None);
    assert_eq!(build_outcome(&p).1, NOW + 5_400);
}

#[test]
fn build_tier_up_writes_the_tier_mirror_from_the_kernel_tier() {
    let (hd, pd) = (holding_bytes(), province_bytes());
    let (cost, effect, secs) = catalog::tier_up_item(Tier::Hamlet).unwrap();
    assert_eq!(cost, [0, 1_000_000, 600_000, 0, 0, 300_000, 0, 0]);
    let p = go(&hd, &pd, TIER_UP).unwrap();
    assert_eq!(build_outcome(&p), (cost, NOW + 21_600));
    assert_eq!(p.holding, built(&hd, NOW, &cost, secs as i64, effect).0);
    assert_eq!(store(&p.holding, Resource::Wood), 740_000);
    assert_eq!(store(&p.holding, Resource::Gold), 420_000);
    let prov = p.province.unwrap();
    assert_province_kept(&pd, &prov);
    assert_eq!(mirror_u8(&prov, SM::TIER), 0);
    assert_eq!(mirror_u8(&prov, SM2::TIER_NEXT), 1);
    assert_eq!(mirror_u32(&prov, SM2::TIER_NEXT_BELL), 137);
    assert_eq!(wall_item(&prov, 0), (0, 0));
    // an earlier tier-up finished at FOUNDED + 2 h: the kernel tier is Town
    let mut h = kernel_holding(&[
        1_000_000, 5_000_000, 4_000_000, 500_000, 300_000, 2_000_000, 0, 0,
    ]);
    h.queue[0] = Some(QueueItem {
        done_at: FOUNDED + 2 * HOUR,
        effect: Effect::TierUp,
    });
    let hd2 = holding_bytes_for(coord(), &h);
    let (cost, effect, secs) = catalog::tier_up_item(Tier::Town).unwrap();
    assert_eq!(cost, [0, 4_000_000, 3_000_000, 0, 0, 1_500_000, 0, 0]);
    let p = go(&hd2, &pd, TIER_UP).unwrap();
    assert_eq!(build_outcome(&p), (cost, NOW + 43_200));
    assert_eq!(p.holding, built(&hd2, NOW, &cost, secs as i64, effect).0);
    assert_eq!(Ro(&p.holding).u8(H::TIER).unwrap(), 1);
    assert_eq!(store(&p.holding, Resource::Wood), 1_270_000);
    let prov = p.province.unwrap();
    assert_eq!(mirror_u8(&prov, SM::TIER), 1);
    assert_eq!(mirror_u8(&prov, SM2::TIER_NEXT), 2);
    assert_eq!(mirror_u32(&prov, SM2::TIER_NEXT_BELL), 173);
}

#[test]
fn build_tier_up_refuses_a_pending_tier_up_and_the_top_tier() {
    let pd = province_bytes();
    let mut h = kernel_holding(&RICH);
    h.queue[0] = Some(QueueItem {
        done_at: NOW + HOUR,
        effect: Effect::TierUp,
    });
    assert_eq!(
        go(&holding_bytes_for(coord(), &h), &pd, TIER_UP),
        Err(QUEUE_FULL)
    );
    let mut h = kernel_holding(&RICH);
    h.tier = Tier::Stronghold;
    assert_eq!(
        go(&holding_bytes_for(coord(), &h), &pd, TIER_UP),
        Err(KERNEL)
    );
}

#[test]
fn build_doctrine_prices_walls_and_an_unknown_faction_is_refused() {
    let (mut hd, pd) = (holding_bytes(), province_bytes());
    // "A Wardens of Stone": walls at 95%
    Rw(&mut hd).set_u8(H::FACTION, 0).unwrap();
    let p = go(&hd, &pd, WALLS).unwrap();
    assert_eq!(build_outcome(&p).0, [0, 0, 285_000, 0, 0, 0, 0, 0]);
    assert_eq!(store(&p.holding, Resource::Stone), 1_360_000 - 285_000);
    Rw(&mut hd).set_u8(H::FACTION, 6).unwrap();
    assert_eq!(go(&hd, &pd, WALLS), Err(BAD));
    assert_eq!(go(&hd, &pd, Action::Build { item: 0 }), Err(BAD));
}

#[test]
fn build_queued_duplicate_raises_the_copy_number_cost_and_seconds() {
    let effect = Effect::Production {
        resource: Resource::Food,
        delta: 12_000,
    };
    let mut h = kernel_holding(&RICH);
    h.queue[0] = Some(QueueItem {
        done_at: NOW + 5_400,
        effect,
    });
    let (hd, pd) = (holding_bytes_for(coord(), &h), province_bytes());
    let p = go(&hd, &pd, Action::Build { item: 0 }).unwrap();
    // the second copy: base × 1.5, 7,200 s after the queued item
    let cost: Cost = [0, 120_000, 60_000, 0, 0, 0, 0, 0];
    assert_eq!(build_outcome(&p), (cost, NOW + 12_600));
    assert_eq!(p.holding, built(&hd, NOW, &cost, 7_200, effect).0);
}

#[test]
fn build_intro_flag_makes_a_sixty_second_building_and_is_consumed_only_by_a_building() {
    let (mut hd, pd) = (holding_bytes(), province_bytes());
    let f = flags(&hd);
    Rw(&mut hd)
        .set_u8(H::FLAGS, f | H::FLAG_INTRO_BUILD_AVAILABLE)
        .unwrap();
    let p = go(&hd, &pd, Action::Build { item: 0 }).unwrap();
    let cost: Cost = [0, 80_000, 40_000, 0, 0, 0, 0, 0];
    assert_eq!(build_outcome(&p), (cost, NOW + 60));
    assert_eq!(flags(&p.holding) & H::FLAG_INTRO_BUILD_AVAILABLE, 0);
    let effect = Effect::Production {
        resource: Resource::Food,
        delta: 12_000,
    };
    let (mut expect, _) = built(&hd, NOW, &cost, 60, effect);
    let g = flags(&expect);
    Rw(&mut expect)
        .set_u8(H::FLAGS, g & !H::FLAG_INTRO_BUILD_AVAILABLE)
        .unwrap();
    assert_eq!(p.holding, expect);
    // walls neither use nor consume it
    let p = go(&hd, &pd, WALLS).unwrap();
    assert_eq!(build_outcome(&p).1, NOW + 14_400);
    assert_ne!(flags(&p.holding) & H::FLAG_INTRO_BUILD_AVAILABLE, 0);
}

#[test]
fn build_workshop_and_tier_up_keep_the_intro_flag_an_ordinary_building_consumes() {
    let (mut hd, pd) = (holding_bytes(), province_bytes());
    let f = flags(&hd);
    Rw(&mut hd)
        .set_u8(H::FLAGS, f | H::FLAG_INTRO_BUILD_AVAILABLE)
        .unwrap();
    // the workshop (item 8) takes its own time and leaves the flag set
    let p = go(
        &hd,
        &pd,
        Action::Build {
            item: arms::ITEM_WORKSHOP,
        },
    )
    .unwrap();
    assert_eq!(build_outcome(&p).1, NOW + 5_400);
    assert_ne!(flags(&p.holding) & H::FLAG_INTRO_BUILD_AVAILABLE, 0);
    assert_eq!(flags(&p.holding), flags(&hd));
    // the tier-up (item 7) likewise, with its mirror item written
    let p = go(&hd, &pd, TIER_UP).unwrap();
    assert_eq!(build_outcome(&p).1, NOW + 21_600);
    assert_ne!(flags(&p.holding) & H::FLAG_INTRO_BUILD_AVAILABLE, 0);
    assert_eq!(flags(&p.holding), flags(&hd));
    assert!(p.province.is_some());
    // an ordinary building (the last, item 5) takes the intro time and clears it
    let p = go(&hd, &pd, Action::Build { item: 5 }).unwrap();
    assert_eq!(build_outcome(&p).1, NOW + 60);
    assert_eq!(flags(&p.holding) & H::FLAG_INTRO_BUILD_AVAILABLE, 0);
}

#[test]
fn build_refuses_unknown_items_insufficient_stores_and_a_full_queue() {
    let (hd, pd) = (holding_bytes(), province_bytes());
    for item in [9u8, 10, 0x7F, 0xFF] {
        assert_eq!(
            go(&hd, &pd, Action::Build { item }),
            Err(BAD_DATA),
            "item {item}"
        );
    }
    // the starter kit alone cannot pay the Hamlet's tier-up
    let poor = holding_bytes_for(coord(), &kernel_holding(&catalog::starter_kit()));
    assert_eq!(
        go(&poor, &pd, TIER_UP),
        Err(Error::Frontier(FrontierError::Insufficient))
    );
    // a Hamlet's two slots taken
    let mut h = kernel_holding(&RICH);
    for (i, q) in h.queue.iter_mut().take(2).enumerate() {
        let effect = Effect::Production {
            resource: Resource::Wood,
            delta: 10_000,
        };
        *q = Some(QueueItem {
            done_at: NOW + (i as i64 + 1) * HOUR,
            effect,
        });
    }
    let full = holding_bytes_for(coord(), &h);
    assert_eq!(go(&full, &pd, Action::Build { item: 0 }), Err(QUEUE_FULL));
}

// ------------------------------------------------------------ Train

#[test]
fn train_strong_unit_costs_arms_per_started_hundred_and_credits_the_whole_reserve() {
    let (hd, pd) = (holding_bytes(), province_bytes());
    let p = go(&hd, &pd, Action::Train { unit: 3, n: 150 }).unwrap();
    let cost = train_cost(3, 150).unwrap();
    // Pikeman, two started hundreds: 120 food, 80 ore, 40 gold, 100 arms
    assert_eq!(cost, [120_000, 0, 0, 80_000, 100_000, 40_000, 0, 0]);
    assert_eq!(
        p.outcome,
        Outcome::Train {
            unit: 3,
            n: 150,
            cost,
            reserve: 157
        }
    );
    assert_eq!(p.holding, trained(&hd, NOW, 3, 150));
    assert_eq!(p.province, None);
    assert_eq!(Ro(&p.holding).u32(H::reserve(3)).unwrap(), 157);
    assert_eq!(store(&p.holding, Resource::Food), 1_200_000);
    assert_eq!(store(&p.holding, Resource::Ore), 500_000);
    assert_eq!(store(&p.holding, Resource::Horses), 200_000);
    assert_eq!(store(&p.holding, Resource::Gold), 680_000);
    assert_same(&hd, &p.holding, KEPT);
    // one over a hundred starts a second hundred of arms
    for (n, arms_cost, reserve) in [(100u32, 50_000i64, 107u32), (101, 100_000, 108)] {
        let p = go(&hd, &pd, Action::Train { unit: 3, n }).unwrap();
        let Outcome::Train {
            cost, reserve: got, ..
        } = p.outcome
        else {
            panic!()
        };
        assert_eq!((cost[arms::ARMS as usize], got), (arms_cost, reserve));
    }
}

#[test]
fn train_refuses_unknown_unit_zero_count_insufficient_and_reserve_overflow() {
    let (hd, pd) = (holding_bytes(), province_bytes());
    assert_eq!(
        go(&hd, &pd, Action::Train { unit: 7, n: 10 }),
        Err(BAD_DATA)
    );
    assert_eq!(
        go(&hd, &pd, Action::Train { unit: 0xFF, n: 10 }),
        Err(BAD_DATA)
    );
    assert_eq!(go(&hd, &pd, Action::Train { unit: 0, n: 0 }), Err(BAD_DATA));
    let short = Err(Error::Frontier(FrontierError::Insufficient));
    assert_eq!(
        go(
            &hd,
            &pd,
            Action::Train {
                unit: 3,
                n: 100_000
            }
        ),
        short
    );
    let mut maxed = hd.clone();
    Rw(&mut maxed).set_u32(H::reserve(0), u32::MAX).unwrap();
    assert_eq!(
        go(&maxed, &pd, Action::Train { unit: 0, n: 1 }),
        Err(OVERFLOW)
    );
}

// ------------------------------------------------------------ identity

#[test]
fn identity_pins_must_match_the_record_exactly() {
    let (hd, pd) = (holding_bytes(), province_bytes());
    let base = pins();
    let other_world = WorldId::new([0x5B; 32]).unwrap();
    let other_coord = WideCoord::checked(201, -50).unwrap();
    let cases = [
        (
            Pins {
                season_id: 8,
                ..base
            },
            BAD,
        ),
        (
            Pins {
                world: other_world,
                ..base
            },
            BAD,
        ),
        (
            Pins {
                coord: other_coord,
                ..base
            },
            BAD,
        ),
        (Pins { site: 4, ..base }, BAD),
        (Pins { gen: 3, ..base }, BAD),
        (Pins { slot: 3, ..base }, BAD),
        (
            Pins {
                owner_citizen: [0xC2; 32],
                ..base
            },
            Error::Frontier(FrontierError::NotOwner),
        ),
    ];
    for (p, want) in cases {
        assert_eq!(
            run(&hd, &pd, &p, &clock(), Action::Harvest),
            Err(want),
            "{p:?}"
        );
    }
    assert!(go(&hd, &pd, Action::Harvest).is_ok());
}

#[test]
fn records_must_decode_as_wide_and_agree_with_each_other() {
    let (hd, pd) = (holding_bytes(), province_bytes());
    let refused = |h: &[u8], p: &[u8]| assert_eq!(go(h, p, Action::Harvest), Err(BAD));
    // lengths: exactly the wide sizes
    refused(&hd[..WH::SIZE - 1], &pd[..]);
    refused(&hd[..], &pd[..WP::SIZE - 1]);
    let (mut lh, mut lp) = (hd.clone(), pd.clone());
    lh.push(0);
    lp.push(0);
    refused(&lh[..], &pd[..]);
    refused(&hd[..], &lp[..]);
    // the holding's codec, one fault at a time
    let faults: [&dyn Fn(&mut [u8]); 7] = [
        &|m| m[header::MAGIC] ^= 1,
        &|m| Rw(m).set_u16(header::LAYOUT_VERSION, 2).unwrap(),
        &|m| m[WH::STATUS] = 0,
        &|m| m[WH::RSV] = 1,
        &|m| Rw(m).set_i16(H::P, 5).unwrap(),
        &|m| m[WH::SLOT] = 1,
        &|m| Rw(m).set_u8(H::ORDER, 3).unwrap(),
    ];
    for f in faults {
        let mut m = hd.clone();
        f(m.as_mut_slice());
        refused(&m[..], &pd[..]);
    }
    // the province names another coordinate, season or world; or is malformed
    refused(
        &hd[..],
        &province_bytes_at(WideCoord::checked(201, -50).unwrap())[..],
    );
    let faults: [&dyn Fn(&mut [u8]); 5] = [
        &|m| Rw(m).set_u64(header::SEASON_ID, 8).unwrap(),
        &|m| Rw(m).set_arr(WP::WORLD, &[0x5B; 32]).unwrap(),
        &|m| m[WP::READINESS] = readiness::REQUIRED & !readiness::CAMP,
        &|m| Rw(m).set_arr(WP::RING_SEED, &[0u8; 32]).unwrap(),
        &|m| m[P::WEDGE] ^= 1,
    ];
    for f in faults {
        let mut m = pd.clone();
        f(m.as_mut_slice());
        refused(&hd[..], &m[..]);
    }
}

#[test]
fn coordinates_past_two_to_the_fifty_three_and_at_the_bound_preview_and_a_legacy_ring_does_not() {
    const B: i64 = WIDE_BOUND;
    for (p, q) in [(1i64 << 60, -(1i64 << 59)), (B, B), (-B, 0), (B, -B)] {
        let c = WideCoord::checked(p, q).unwrap();
        assert!(c.ring() > 1u64 << 53, "{c:?}");
        let hd = holding_bytes_for(c, &kernel_holding(&RICH));
        let pd = province_bytes_at(c);
        let pinned = Pins { coord: c, ..pins() };
        let p = run(&hd, &pd, &pinned, &clock(), Action::Harvest).unwrap();
        assert_eq!(p.holding, touched(&hd, NOW).0);
        assert_eq!(&p.holding[WH::SORT_KEY..WH::SORT_KEY + 17], &c.sort_key());
        let near = c.neighbors().into_iter().flatten().next().unwrap();
        let moved = Pins {
            coord: near,
            ..pinned
        };
        assert_eq!(run(&hd, &pd, &moved, &clock(), Action::Harvest), Err(BAD));
    }
    // the last legacy ring is not a wide record, however well formed
    let c = WideCoord::checked(128, 0).unwrap();
    let hd = holding_bytes_for(c, &kernel_holding(&RICH));
    let pinned = Pins { coord: c, ..pins() };
    assert_eq!(
        run(
            &hd,
            &province_bytes_at(c),
            &pinned,
            &clock(),
            Action::Harvest
        ),
        Err(BAD)
    );
}

#[test]
fn mirror_must_show_this_holding_pending_capture_and_mismatch_are_refused() {
    let (hd, mut pd) = (holding_bytes(), province_bytes());
    let actions = [
        Action::Harvest,
        Action::Build { item: 0 },
        Action::Train { unit: 0, n: 1 },
    ];
    // the captor's generation on the mirror: the v2 capture lock
    set_mirror(&mut pd, SM::STATE_HOLDING, GEN + 1);
    for a in actions {
        assert_eq!(go(&hd, &pd, a), Err(Error::Cq(CqError::CapturePending)));
    }
    // any other generation, or no holding on the site
    set_mirror(&mut pd, SM::STATE_HOLDING, GEN + 2);
    for a in actions {
        assert_eq!(go(&hd, &pd, a), Err(BAD));
    }
    set_mirror(&mut pd, SM::STATE_FREE, GEN);
    for a in actions {
        assert_eq!(go(&hd, &pd, a), Err(BAD));
    }
    set_mirror(&mut pd, SM::STATE_HOLDING, GEN);
    assert!(go(&hd, &pd, Action::Harvest).is_ok());
}

#[test]
fn clock_before_genesis_or_before_the_last_settle_is_refused() {
    let (hd, pd) = (holding_bytes(), province_bytes());
    let actions = [
        Action::Harvest,
        Action::Build { item: 0 },
        Action::Train { unit: 0, n: 1 },
    ];
    for a in actions {
        let r = run(&hd, &pd, &pins(), &at(GENESIS - 1), a);
        assert_eq!(r, Err(Error::Frontier(FrontierError::WrongStatus)));
        assert_eq!(run(&hd, &pd, &pins(), &at(FOUNDED - 1), a), Err(KERNEL));
    }
    // the founding second itself is not reversed
    let p = run(&hd, &pd, &pins(), &at(FOUNDED), Action::Harvest).unwrap();
    assert_eq!(p.now_bell, 52);
    assert_eq!(store(&p.holding, Resource::Food), 1_000_000);
}

#[test]
fn released_or_unfounded_state_is_not_live() {
    let (mut hd, pd) = (holding_bytes(), province_bytes());
    for s in [H::STATE_RELEASED, H::STATE_NONE, 9] {
        Rw(&mut hd).set_u8(H::STATE, s).unwrap();
        let r = go(&hd, &pd, Action::Harvest);
        assert_eq!(
            r,
            Err(Error::Frontier(FrontierError::NotFinal)),
            "state {s}"
        );
    }
}
