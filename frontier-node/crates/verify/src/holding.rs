//! The Holding replay of V7 (contract §8.5 V7 "holdings … through the
//! kernel's lazy functions"; W4-D notes §2, deferred to W5): an
//! **independent transcription** of the program's pinned Holding codec and
//! owner touch (`permutation-frontier/src/proc/holding.rs`, W3-B's pinned
//! rules, "the verifier replays the same sequence"), driving the kernel's
//! `holding::Holding` (`settle`, `touch_owner`, `commit_walls`, `pay`,
//! `enqueue`, `set_upkeep`) and `catalog` (`building`, `tier_up_item`,
//! `train`, `base_production`).
//!
//! - **Codec.** `tier` u8 = `Tier` in declaration order; queue item `kind`
//!   0 free, 1 `Production {resource = arg, delta}`, 2 `Upkeep`, 3
//!   `TierUp`, 4 `Walls {delta}`; stores, production, upkeep, walls,
//!   `walls_committed_before`, `food_shortfall` one to one. Writing also
//!   sets the dormant-flag cache at `now` (and M1's shield, see [`write`]).
//! - **Touch** (every owner action): `settle` split at each finished
//!   tier-up (the new tier's base production from its completion, food
//!   upkeep re-applied at that instant), `touch_owner(now)`,
//!   `commit_walls(now)`.
//! - **Harvest** = the touch. **Build(item)**: items 0–5 the buildings
//!   (copy number `1 + (production[r] − base(tier)[r]) / per_hour + queued
//!   copies`), 6 walls (copy 1, a wall item in the site mirror), 7 the
//!   tier-up (one at a time); `pay(now, cost)`, `enqueue(now, secs,
//!   effect)`. **Train(unit, n)**: `pay(now, catalog::train(unit, n))` (a
//!   conquest season: `catalog::train_v2`, K2: the Horseman at a Spearman's
//!   ore and gold, every other unit as M1), `reserve[unit] += n` (whole
//!   troops, I-56).
//! - **S1** (redesign stage 1, program version 4; [`Rules::S1`]): base
//!   production takes the holding's terrain ore (`TERRAIN_ORE`, written at
//!   founding; 0 in M1 and MC holdings, whose base stays
//!   `catalog::base_production`), Build accepts the workshop
//!   (`arms::ITEM_WORKSHOP`, `arms::building`), Train pays
//!   `arms::train_v3`, and the doctrines are `DOCTRINES_V3`.

use frontier_abi::layout::player::{accrual, holding as H, queue_item as QI};
use frontier_abi::layout::province::{province as PV, site as SM};
use frontier_abi::v2::presets::ConquestParams;
use permutation_rules::fixed::MILLI;
use permutation_rules::frontier::holding::{
    Accrual, Effect, Holding as KHolding, LifecycleParams, QueueItem, Resource, Tier, QUEUE_SLOTS,
    RESOURCES,
};
use permutation_rules::frontier::{arms, catalog};

use crate::world::le;

/// Build item of the tier-up (after the six buildings and the walls).
pub const ITEM_TIER_UP: u8 = catalog::ITEM_COUNT;

/// Queue item kinds (the program's pinned `queue_kind`).
pub mod queue_kind {
    pub const FREE: u8 = 0;
    pub const PRODUCTION: u8 = 1;
    pub const UPKEEP: u8 = 2;
    pub const TIER_UP: u8 = 3;
    pub const WALLS: u8 = 4;
}

fn i64_at(d: &[u8], o: usize) -> Result<i64, String> {
    d.get(o..o + 8)
        .map(|b| le(b) as i64)
        .ok_or(format!("holding: short at {o}"))
}

fn u32_at(d: &[u8], o: usize) -> Result<u32, String> {
    d.get(o..o + 4)
        .map(|b| le(b) as u32)
        .ok_or(format!("holding: short at {o}"))
}

fn u8_at(d: &[u8], o: usize) -> Result<u8, String> {
    d.get(o).copied().ok_or(format!("holding: short at {o}"))
}

fn put(d: &mut [u8], o: usize, b: &[u8]) -> Result<(), String> {
    d.get_mut(o..o + b.len())
        .ok_or(format!("holding: short at {o}"))?
        .copy_from_slice(b);
    Ok(())
}

pub fn tier_of(v: u8) -> Result<Tier, String> {
    Ok(match v {
        0 => Tier::Hamlet,
        1 => Tier::Town,
        2 => Tier::City,
        3 => Tier::Stronghold,
        _ => return Err(format!("holding: tier {v}")),
    })
}

fn tier_u8(t: Tier) -> u8 {
    match t {
        Tier::Hamlet => 0,
        Tier::Town => 1,
        Tier::City => 2,
        Tier::Stronghold => 3,
    }
}

fn resource_of(v: u8) -> Result<Resource, String> {
    Resource::ALL
        .get(v as usize)
        .copied()
        .ok_or(format!("holding: resource {v}"))
}

/// The kernel holding of a Holding account's bytes.
pub fn read(d: &[u8]) -> Result<KHolding, String> {
    let mut stores = [Accrual::default(); RESOURCES];
    for (i, s) in stores.iter_mut().enumerate() {
        let o = H::store(i);
        *s = Accrual {
            value: i64_at(d, o + accrual::VALUE)?,
            rate: i64_at(d, o + accrual::RATE)?,
            cap: i64_at(d, o + accrual::CAP)?,
            t0: i64_at(d, o + accrual::T0)?,
            frac: i64_at(d, o + accrual::FRAC)?,
        };
    }
    let mut production = [0i64; RESOURCES];
    let mut upkeep = [0i64; RESOURCES];
    for i in 0..RESOURCES {
        production[i] = i64_at(d, H::PRODUCTION + 8 * i)?;
        upkeep[i] = i64_at(d, H::UPKEEP + 8 * i)?;
    }
    let mut queue = [None; QUEUE_SLOTS];
    for (i, q) in queue.iter_mut().enumerate() {
        let o = H::queue(i);
        let kind = u8_at(d, o + QI::KIND)?;
        if kind == queue_kind::FREE {
            continue;
        }
        let done_at = i64_at(d, o + QI::DONE_AT)?;
        let arg = u8_at(d, o + QI::ARG)?;
        let delta = i64_at(d, o + QI::DELTA)?;
        let effect = match kind {
            queue_kind::PRODUCTION => Effect::Production {
                resource: resource_of(arg)?,
                delta,
            },
            queue_kind::UPKEEP => Effect::Upkeep {
                resource: resource_of(arg)?,
                delta,
            },
            queue_kind::TIER_UP => Effect::TierUp,
            queue_kind::WALLS => Effect::Walls {
                delta: u32::try_from(delta).map_err(|_| format!("holding: walls {delta}"))?,
            },
            k => return Err(format!("holding: queue kind {k}")),
        };
        *q = Some(QueueItem { done_at, effect });
    }
    Ok(KHolding {
        tier: tier_of(u8_at(d, H::TIER)?)?,
        order: u8_at(d, H::ORDER)?,
        founded_ts: i64_at(d, H::FOUNDED_TS)?,
        founded_day: u32_at(d, H::FOUNDED_DAY)?,
        last_owner_action: i64_at(d, H::LAST_OWNER_ACTION)?,
        stores,
        production,
        upkeep,
        queue,
        walls: u32_at(d, H::WALLS)?,
        walls_committed_before: i64_at(d, H::WALLS_COMMITTED_BEFORE)?,
        food_shortfall: i64_at(d, H::FOOD_SHORTFALL)?,
    })
}

/// Writes the kernel holding into a copy of the account bytes (every other
/// field kept), with the dormant-flag cache at `now`. An M1 Holding's
/// `shield_until` is rewritten from M1's constants (the M1 program did); a
/// conquest Holding's (header `layout_version` 2) is kept: the conquest
/// program writes it once, at founding or capture, from the season's
/// timers (`permutation-frontier/src/proc/holding.rs` `write_holding`,
/// MC §3.9).
pub fn write(d: &mut [u8], h: &KHolding, now: i64) -> Result<(), String> {
    use frontier_abi::layout::header as HDR;
    let v2 = d.get(HDR::LAYOUT_VERSION..HDR::LAYOUT_VERSION + 2) == Some(&2u16.to_le_bytes()[..]);
    if !v2 {
        put(d, H::SHIELD_UNTIL, &h.shield_until().to_le_bytes())?;
    }
    put(d, H::TIER, &[tier_u8(h.tier)])?;
    put(d, H::ORDER, &[h.order])?;
    put(d, H::FOUNDED_TS, &h.founded_ts.to_le_bytes())?;
    put(d, H::FOUNDED_DAY, &h.founded_day.to_le_bytes())?;
    put(d, H::LAST_OWNER_ACTION, &h.last_owner_action.to_le_bytes())?;
    for (i, s) in h.stores.iter().enumerate() {
        let o = H::store(i);
        put(d, o + accrual::VALUE, &s.value.to_le_bytes())?;
        put(d, o + accrual::RATE, &s.rate.to_le_bytes())?;
        put(d, o + accrual::CAP, &s.cap.to_le_bytes())?;
        put(d, o + accrual::T0, &s.t0.to_le_bytes())?;
        put(d, o + accrual::FRAC, &s.frac.to_le_bytes())?;
    }
    for i in 0..RESOURCES {
        put(d, H::PRODUCTION + 8 * i, &h.production[i].to_le_bytes())?;
        put(d, H::UPKEEP + 8 * i, &h.upkeep[i].to_le_bytes())?;
    }
    for (i, q) in h.queue.iter().enumerate() {
        let o = H::queue(i);
        let (done_at, kind, arg, delta) = match q {
            None => (0, queue_kind::FREE, 0, 0),
            Some(QueueItem { done_at, effect }) => match *effect {
                Effect::Production { resource, delta } => {
                    (*done_at, queue_kind::PRODUCTION, resource as u8, delta)
                }
                Effect::Upkeep { resource, delta } => {
                    (*done_at, queue_kind::UPKEEP, resource as u8, delta)
                }
                Effect::TierUp => (*done_at, queue_kind::TIER_UP, 0, 0),
                Effect::Walls { delta } => (*done_at, queue_kind::WALLS, 0, delta as i64),
            },
        };
        put(d, o + QI::DONE_AT, &done_at.to_le_bytes())?;
        put(d, o + QI::KIND, &[kind])?;
        put(d, o + QI::ARG, &[arg])?;
        put(d, o + QI::DELTA, &delta.to_le_bytes())?;
    }
    put(d, H::WALLS, &h.walls.to_le_bytes())?;
    put(
        d,
        H::WALLS_COMMITTED_BEFORE,
        &h.walls_committed_before.to_le_bytes(),
    )?;
    put(d, H::FOOD_SHORTFALL, &h.food_shortfall.to_le_bytes())?;
    let flags = u8_at(d, H::FLAGS)?;
    let dormant = if h.is_dormant(now) {
        H::FLAG_DORMANT_CACHE
    } else {
        0
    };
    put(d, H::FLAGS, &[(flags & !H::FLAG_DORMANT_CACHE) | dormant])
}

/// `settle(now)` split at every finished tier-up, the new tier's base
/// production applied from the tier-up's completion.
///
/// `terrain_ore`: the holding's `TERRAIN_ORE` ([`terrain_ore`]); 0 for an
/// M1 or MC holding.
pub fn settle_tiered(h: &mut KHolding, now: i64, terrain_ore: i64) -> Result<(), String> {
    loop {
        let next = h
            .queue
            .iter()
            .flatten()
            .filter(|q| matches!(q.effect, Effect::TierUp) && q.done_at <= now)
            .map(|q| q.done_at)
            .min();
        let Some(t) = next else { break };
        let t = t.max(h.stores[0].t0);
        let old = h.tier;
        h.settle(t).map_err(|e| format!("settle: {e:?}"))?;
        if h.tier == old {
            break;
        }
        let (a, b) = (
            base_production(old, terrain_ore),
            base_production(h.tier, terrain_ore),
        );
        for r in 0..RESOURCES {
            h.production[r] = h.production[r].saturating_add(b[r] - a[r]);
        }
        let food = Resource::Food as usize;
        let up = h.upkeep[food];
        h.set_upkeep(t, Resource::Food, up)
            .map_err(|e| format!("set_upkeep: {e:?}"))?;
    }
    h.settle(now).map_err(|e| format!("settle: {e:?}"))
}

/// The settler cost of a citizen's next outpost with `holdings_n` holdings
/// (MC §3.8; the program's `settler_cost`): `catalog::SETTLER_COST` under
/// the duplicate rule with `n = holdings_n`, in milli. `None` on overflow.
pub fn settler_cost(holdings_n: u8) -> Option<[i64; RESOURCES]> {
    let mut c = [0i64; RESOURCES];
    for (r, base) in catalog::SETTLER_COST.iter().enumerate() {
        let units =
            permutation_rules::frontier::holding::duplicate_cost(*base as u64, holdings_n as u32)?;
        c[r] = i64::try_from(units).ok()?.checked_mul(MILLI)?;
    }
    Some(c)
}

/// The Holding an owner touch at `now` that pays `cost` leaves (no queue
/// item): what FileOutpost writes into its anchor (the program's
/// `load_touched`, `pay`, `write_holding`).
pub fn touched_paid(before: &[u8], now: i64, cost: &[i64; RESOURCES]) -> Result<Vec<u8>, String> {
    let mut h = read(before)?;
    touch(&mut h, now, terrain_ore(before)?)?;
    h.pay(now, cost).map_err(|e| format!("pay: {e:?}"))?;
    let mut d = before.to_vec();
    write(&mut d, &h, now)?;
    Ok(d)
}

/// The Holding a caravan's delivery leaves (S1 1b, the program's
/// `settle_caravan`): settled to `now` (no owner touch), the cargo
/// credited resource by resource.
pub fn credited(before: &[u8], now: i64, cargo: &[i64; RESOURCES]) -> Result<Vec<u8>, String> {
    let mut h = read(before)?;
    settle_tiered(&mut h, now, terrain_ore(before)?)?;
    for (r, c) in cargo.iter().enumerate() {
        if *c > 0 {
            h.credit(now, Resource::ALL[r], *c)
                .map_err(|e| format!("credit: {e:?}"))?;
        }
    }
    let mut d = before.to_vec();
    write(&mut d, &h, now)?;
    Ok(d)
}

/// The owner touch.
pub fn touch(h: &mut KHolding, now: i64, terrain_ore: i64) -> Result<(), String> {
    settle_tiered(h, now, terrain_ore)?;
    h.touch_owner(now)
        .map_err(|e| format!("touch_owner: {e:?}"))?;
    h.commit_walls(now);
    Ok(())
}

/// Copy number of building `item` (0..6, or the S1 workshop) the next
/// Build makes: production above the tier's base ([`base_production`])
/// over the building's rate, plus queued copies, plus one; a workshop's
/// from the arms production (`arms::WORKSHOP_DELTA`, no base).
pub fn copy_number(h: &KHolding, item: u8, terrain_ore: i64) -> Result<u32, String> {
    let (resource, per, base) = if item == arms::ITEM_WORKSHOP {
        (arms::ARMS, arms::WORKSHOP_DELTA, 0)
    } else {
        let bd = catalog::BUILDINGS
            .get(item as usize)
            .ok_or(format!("build item {item}"))?;
        let per = bd.per_hour.saturating_mul(MILLI);
        (
            bd.resource,
            per,
            base_production(h.tier, terrain_ore)[bd.resource as usize],
        )
    };
    let r = resource as usize;
    let built = (h.production[r].saturating_sub(base)).max(0) / per.max(1);
    let queued = h
        .queue
        .iter()
        .flatten()
        .filter(|q| matches!(q.effect, Effect::Production { resource: x, .. } if x == resource))
        .count() as i64;
    u32::try_from(built + queued + 1).map_err(|_| "copy number".to_string())
}

/// A holding's base production at tier `t` from its `TERRAIN_ORE`
/// (`arms::holding_base_production`: S1's when > 0, else M1's and MC's).
pub fn base_production(t: Tier, terrain_ore: i64) -> [i64; RESOURCES] {
    arms::holding_base_production(t, terrain_ore)
}

/// S1: the terrain ore of `tile` in a Province's data (the program's
/// `site_terrain_ore`, an independent call of the kernel over the stored
/// terrain block).
pub fn site_terrain_ore(province: &[u8], tile: u8) -> Result<i64, String> {
    let t: &[u8; 61] = province
        .get(PV::TERRAIN..PV::TERRAIN + 61)
        .and_then(|x| x.try_into().ok())
        .ok_or("province: short")?;
    let r: &[u8; 61] = province
        .get(PV::RESOURCE..PV::RESOURCE + 61)
        .and_then(|x| x.try_into().ok())
        .ok_or("province: short")?;
    arms::terrain_ore_per_hour_bytes(t, r, tile).ok_or_else(|| format!("tile {tile}"))
}

/// The holding's `TERRAIN_ORE` (S1; 0 in M1 and MC holdings).
pub fn terrain_ore(d: &[u8]) -> Result<i64, String> {
    let o = frontier_abi::v2::layout::player::holding::TERRAIN_ORE;
    d.get(o..o + 8)
        .map(|b| le(b) as i64)
        .ok_or_else(|| "holding: short".to_string())
}

/// The kernel holding of `d` settled to `now` (tier-aware).
pub fn read_settled(d: &[u8], now: i64) -> Result<KHolding, String> {
    let mut h = read(d)?;
    settle_tiered(&mut h, now, terrain_ore(d)?)?;
    Ok(h)
}

/// The kernel holding of `d` after an owner touch at `now`.
pub fn read_touched(d: &[u8], now: i64) -> Result<KHolding, String> {
    let mut h = read(d)?;
    touch(&mut h, now, terrain_ore(d)?)?;
    Ok(h)
}

/// The rules a season runs under, where the replay differs.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Rules {
    M1,
    /// The conquest rules (program version 3).
    Mc,
    /// The S1 rules (program version 4): MC plus the arms economy.
    S1,
}

impl Rules {
    pub fn of(conquest: bool, s1: bool) -> Rules {
        match (conquest, s1) {
            (_, true) => Rules::S1,
            (true, false) => Rules::Mc,
            _ => Rules::M1,
        }
    }

    /// The faction's doctrine under these rules.
    pub fn doctrine(
        self,
        f: u8,
    ) -> Option<&'static permutation_rules::frontier::doctrine::Doctrine> {
        match self {
            Rules::S1 => permutation_rules::frontier::doctrine::of_faction_v3(f),
            _ => permutation_rules::frontier::doctrine::of_faction(f),
        }
    }
}

/// HARVEST's digest: `sha256` of the eight stores.
pub fn stores_digest(d: &[u8]) -> Result<[u8; 32], String> {
    let s = d
        .get(H::STORES..H::STORES + H::STORES_N * accrual::SIZE)
        .ok_or("holding: short stores")?;
    Ok(permutation_rules::hash::sha256(&[s]))
}

/// BUILD's digest: `sha256` of the cost (eight i64 LE).
pub fn cost_digest(c: &[i64; RESOURCES]) -> [u8; 32] {
    let mut b = [0u8; 8 * RESOURCES];
    for (i, v) in c.iter().enumerate() {
        b[8 * i..8 * i + 8].copy_from_slice(&v.to_le_bytes());
    }
    permutation_rules::hash::sha256(&[&b])
}

/// One replayed owner action on a Holding.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Action {
    Harvest,
    Build {
        item: u8,
    },
    Train {
        unit: u8,
        n: u32,
    },
    /// FileOutpost's anchor (MC §3.8): the touch and the settler cost of
    /// the citizen's next holding, logged as a HARVEST of the anchor.
    OutpostAnchor {
        holdings_n: u8,
    },
}

/// What a replayed action leaves: the Holding bytes, the record payload it
/// logs, and (walls) the wall item `(effective bell, delta)`.
#[derive(Clone, Debug)]
pub struct Replayed {
    pub holding: Vec<u8>,
    pub payload: Vec<u8>,
    pub wall_item: Option<(u32, u32)>,
}

/// Replays one owner action at `now` over the Holding bytes `before`;
/// `rules` selects the conquest rules (Train's `catalog::train_v2`, K2)
/// or the S1 rules (the workshop, `arms::train_v3`, `DOCTRINES_V3`) where
/// they differ.
pub fn replay(
    before: &[u8],
    a: &Action,
    now: i64,
    genesis_ts: i64,
    rules: Rules,
) -> Result<Replayed, String> {
    let mut h = read(before)?;
    let ore = terrain_ore(before)?;
    touch(&mut h, now, ore)?;
    let mut d = before.to_vec();
    match *a {
        Action::Harvest => {
            write(&mut d, &h, now)?;
            let payload = stores_digest(&d)?.to_vec();
            Ok(Replayed {
                holding: d,
                payload,
                wall_item: None,
            })
        }
        Action::Build { item } => {
            let workshop = rules == Rules::S1 && item == arms::ITEM_WORKSHOP;
            if item > ITEM_TIER_UP && !workshop {
                return Err(format!("build item {item}"));
            }
            let walls = item == catalog::ITEM_WALLS;
            let doctrine = rules
                .doctrine(u8_at(before, H::FACTION)?)
                .ok_or("holding: faction")?;
            let (cost, effect, secs) = if item == ITEM_TIER_UP {
                if h.queue
                    .iter()
                    .flatten()
                    .any(|q| matches!(q.effect, Effect::TierUp))
                {
                    return Err("a second tier-up in the queue".into());
                }
                catalog::tier_up_item(h.tier).ok_or("tier-up at the top tier")?
            } else {
                let n = if walls {
                    1
                } else {
                    copy_number(&h, item, ore)?
                };
                if rules == Rules::S1 {
                    arms::building(item, n, doctrine)
                } else {
                    catalog::building(item, n, doctrine)
                }
                .ok_or(format!("build item {item}"))?
            };
            let intro = item < catalog::ITEM_WALLS
                && u8_at(before, H::FLAGS)? & H::FLAG_INTRO_BUILD_AVAILABLE != 0;
            let secs = if intro { H::INTRO_BUILD_SECS } else { secs };
            h.pay(now, &cost).map_err(|e| format!("pay: {e:?}"))?;
            let done_at = h
                .enqueue(now, secs as i64, effect)
                .map_err(|e| format!("enqueue: {e:?}"))?;
            write(&mut d, &h, now)?;
            if intro {
                d[H::FLAGS] &= !H::FLAG_INTRO_BUILD_AVAILABLE;
            }
            let mut payload = vec![item];
            payload.extend_from_slice(&cost_digest(&cost));
            payload.extend_from_slice(&done_at.to_le_bytes());
            let wall_item = if walls {
                let b = frontier_abi::prologue::bell_at(genesis_ts, done_at)
                    .and_then(|b| b.checked_add(1))
                    .ok_or("wall item bell")?;
                Some((b, catalog::WALL_STEP))
            } else {
                None
            };
            Ok(Replayed {
                holding: d,
                payload,
                wall_item,
            })
        }
        Action::OutpostAnchor { holdings_n } => {
            let cost = settler_cost(holdings_n).ok_or("settler cost")?;
            h.pay(now, &cost).map_err(|e| format!("pay: {e:?}"))?;
            write(&mut d, &h, now)?;
            let payload = stores_digest(&d)?.to_vec();
            Ok(Replayed {
                holding: d,
                payload,
                wall_item: None,
            })
        }
        Action::Train { unit, n } => {
            let cost = match rules {
                Rules::S1 => arms::train_v3(unit, n),
                Rules::Mc => catalog::train_v2(unit, n),
                Rules::M1 => catalog::train(unit, n),
            }
            .ok_or(format!("train unit {unit} n {n}"))?;
            h.pay(now, &cost).map_err(|e| format!("pay: {e:?}"))?;
            write(&mut d, &h, now)?;
            let at = H::reserve(unit as usize);
            let v = u32_at(&d, at)?.checked_add(n).ok_or("reserve overflow")?;
            put(&mut d, at, &v.to_le_bytes())?;
            let mut payload = vec![unit];
            payload.extend_from_slice(&n.to_le_bytes());
            payload.extend_from_slice(&now.to_le_bytes());
            Ok(Replayed {
                holding: d,
                payload,
                wall_item: None,
            })
        }
    }
}

/// The site mirror's wall fields after a walls Build (the program's
/// `wall_item`): items already in force (`effective_bell ≤
/// resolved_next`) folded into `walls_committed` (capped), the new item in
/// the first free slot. `None`: both slots busy (the program refuses).
pub fn wall_item(province: &[u8], site: usize, item: (u32, u32)) -> Option<Vec<u8>> {
    let mut d = province.to_vec();
    let o = PV::site(site);
    let rn = le(d.get(PV::RESOLVED_NEXT..PV::RESOLVED_NEXT + 4)?) as u32;
    let items = [
        (SM::WALL_ITEM0_BELL, SM::WALL_ITEM0_DELTA),
        (SM::WALL_ITEM1_BELL, SM::WALL_ITEM1_DELTA),
    ];
    let rd = |d: &[u8], at: usize| d.get(at..at + 4).map(|b| le(b) as u32);
    let mut committed = rd(&d, o + SM::WALLS_COMMITTED)?;
    for (b, dl) in items {
        let (ib, idl) = (rd(&d, o + b)?, rd(&d, o + dl)?);
        if idl > 0 && ib <= rn {
            committed = committed
                .saturating_add(idl)
                .min(permutation_rules::frontier::holding::MAX_WALLS);
            d[o + b..o + b + 4].fill(0);
            d[o + dl..o + dl + 4].fill(0);
        }
    }
    d[o + SM::WALLS_COMMITTED..o + SM::WALLS_COMMITTED + 4]
        .copy_from_slice(&committed.to_le_bytes());
    for (b, dl) in items {
        if rd(&d, o + dl)? == 0 {
            d[o + b..o + b + 4].copy_from_slice(&item.0.to_le_bytes());
            d[o + dl..o + dl + 4].copy_from_slice(&item.1.to_le_bytes());
            return Some(d);
        }
    }
    None
}

// ------------------------------------------------------------ continuity (wave-5 review)

/// The Holding bytes the owner's lazy accrual owns: `order`, `tier`,
/// `flags`; `founded_ts`, `founded_day`; `last_owner_action` through
/// `food_shortfall` (shield, stores, production, upkeep, queue, walls).
/// Only SettleTicket's founding and the owner touches (Harvest, Build,
/// Train, Explore, Muster, Dissolve, Garrison, Depart) write them; every
/// other Holding write must leave them byte-identical.
pub const ACCRUAL_RANGES: [(usize, usize); 3] = [
    (H::ORDER, H::TICKET_BELL),
    (H::FOUNDED_TS, H::HOST_SEQ),
    (H::LAST_OWNER_ACTION, H::RESERVE),
];

/// The accrual bytes of a Holding account (`None` if too short).
pub fn accrual_bytes(d: &[u8]) -> Option<Vec<u8>> {
    let mut v = vec![];
    for (a, b) in ACCRUAL_RANGES {
        v.extend_from_slice(d.get(a..b)?);
    }
    Some(v)
}

/// First differing offset (in account bytes) of the accrual ranges.
pub fn accrual_diff(a: &[u8], b: &[u8]) -> Option<usize> {
    for (x, y) in ACCRUAL_RANGES {
        for o in x..y {
            if a.get(o) != b.get(o) {
                return Some(o);
            }
        }
    }
    None
}

/// The Holding an owner touch at `now` leaves (no payment, no queue item):
/// what Explore, Muster, Dissolve, Garrison and Depart write into the
/// accrual (the program's `load_touched` + `write_holding`).
pub fn touched(before: &[u8], now: i64) -> Result<Vec<u8>, String> {
    let mut h = read(before)?;
    touch(&mut h, now, terrain_ore(before)?)?;
    let mut d = before.to_vec();
    write(&mut d, &h, now)?;
    Ok(d)
}

/// A conquest season's holding lifecycle timers (MC §3.9, §3.12) as the
/// kernel's `LifecycleParams`: a transcription of the program's
/// `layout::conquest::lifecycle` over CreateSeason's conquest block.
pub fn lifecycle(cq: &ConquestParams) -> LifecycleParams {
    LifecycleParams {
        shield_secs: cq.shield_secs as i64,
        shield_late_secs: cq.shield_late_secs as i64,
        shield_late_after_secs: cq.shield_late_after_secs as i64,
        dormant_after_secs: cq.dormant_after_secs as i64,
        release_after_secs: cq.release_after_secs as i64,
        outpost_shield_secs: cq.outpost_shield_secs as i64,
    }
}

/// The shield a conquest season's founding writes (MC §3.9; the program's
/// PlaceHome and SettleTicket): `now + shield_secs_for(order, now,
/// genesis_ts)` — a first holding (`order` 1) gets `shield_secs`, or
/// `shield_late_secs` when founded `shield_late_after_secs` or more after
/// genesis; an outpost (2–3) `outpost_shield_secs`. `None` on overflow.
pub fn founding_shield(cq: &ConquestParams, order: u8, now: i64, genesis_ts: i64) -> Option<i64> {
    now.checked_add(lifecycle(cq).shield_secs_for(order, now, genesis_ts))
}

/// The accrual SettleTicket (or PlaceHome) writes into a founded Holding
/// at `now` (day `day`): a Hamlet of `order` (1 the first holding, 2–3 an
/// outpost) with the Hamlet's base production and no food upkeep; a first
/// holding has the starter kit credited, an outpost has not (MC §3.8) — an
/// independent transcription of the program's `founded_holding` and
/// `founded_outpost` (`proc/citizen.rs`). `shield`: the conquest season's
/// founding shield ([`founding_shield`]), written as is; `None` in an M1
/// season, whose shield [`write`] rewrites from M1's constants.
/// `terrain_ore`: an S1 season's site terrain ore ([`site_terrain_ore`]),
/// the base ore and the `TERRAIN_ORE` written; `None` before S1. The rest
/// of `post` is kept.
pub fn founded(
    post: &[u8],
    now: i64,
    day: u32,
    order: u8,
    shield: Option<i64>,
    terrain_ore: Option<i64>,
) -> Result<Vec<u8>, String> {
    let mut h = KHolding::found(now, day, order);
    h.production = base_production(Tier::Hamlet, terrain_ore.unwrap_or(0));
    h.set_upkeep(now, Resource::Food, 0)
        .map_err(|e| format!("set_upkeep: {e:?}"))?;
    if order <= 1 {
        for (r, amount) in catalog::starter_kit().iter().enumerate() {
            if *amount > 0 {
                h.credit(now, Resource::ALL[r], *amount)
                    .map_err(|e| format!("credit: {e:?}"))?;
            }
        }
    }
    let mut d = post.to_vec();
    for (a, b) in ACCRUAL_RANGES {
        d.get_mut(a..b).ok_or("holding: short")?.fill(0);
    }
    write(&mut d, &h, now)?;
    if let Some(s) = shield {
        put(&mut d, H::SHIELD_UNTIL, &s.to_le_bytes())?;
    }
    if let Some(o) = terrain_ore {
        let at = frontier_abi::v2::layout::player::holding::TERRAIN_ORE;
        put(&mut d, at, &o.to_le_bytes())?;
    }
    if post[H::FLAGS] & H::FLAG_INTRO_BUILD_AVAILABLE != 0 {
        d[H::FLAGS] |= H::FLAG_INTRO_BUILD_AVAILABLE;
    }
    Ok(d)
}

#[cfg(test)]
mod intro_tests {
    use super::*;
    #[test]
    fn intro_build_replay_consumes_exactly_one_persisted_entitlement() {
        let now = 1_800_000_000;
        let mut initial = vec![0u8; H::SIZE];
        initial[H::FLAGS] = H::FLAG_INTRO_BUILD_AVAILABLE;
        let initial = founded(&initial, now, 0, 1, None, None).unwrap();
        let first = replay(&initial, &Action::Build { item: 0 }, now, now, Rules::M1).unwrap();
        assert_eq!(
            i64_at(&first.holding, H::queue(0) + QI::DONE_AT).unwrap(),
            now + 60
        );
        assert_eq!(first.holding[H::FLAGS] & H::FLAG_INTRO_BUILD_AVAILABLE, 0);
        let next = replay(
            &first.holding,
            &Action::Build { item: 1 },
            now,
            now,
            Rules::M1,
        )
        .unwrap();
        assert_eq!(
            i64_at(&next.holding, H::queue(1) + QI::DONE_AT).unwrap(),
            now + 60 + 5400
        );
        let legacy = {
            let mut x = initial;
            x[H::FLAGS] = 0;
            x
        };
        let normal = replay(&legacy, &Action::Build { item: 0 }, now, now, Rules::M1).unwrap();
        assert_eq!(
            i64_at(&normal.holding, H::queue(0) + QI::DONE_AT).unwrap(),
            now + 5400
        );
    }

    /// A conquest season's Train pays `catalog::train_v2`: the Horseman
    /// (unit 2) at a Spearman's ore and gold, the Spearman as under M1.
    #[test]
    fn conquest_train_pays_the_v2_cost() {
        let now = 1_800_000_000;
        let initial = founded(&vec![0u8; H::SIZE], now, 0, 1, None, None).unwrap();
        let horse = Action::Train { unit: 2, n: 100 };
        let spear = Action::Train { unit: 0, n: 100 };
        let m1 = replay(&initial, &horse, now, now, Rules::M1).unwrap();
        let mc = replay(&initial, &horse, now, now, Rules::Mc).unwrap();
        let ore = |d: &[u8]| i64_at(d, H::store(Resource::Ore as usize) + accrual::VALUE).unwrap();
        assert!(
            ore(&mc.holding) > ore(&m1.holding),
            "M1 charges the cavalry surcharge"
        );
        let spear_m1 = replay(&initial, &spear, now, now, Rules::M1).unwrap();
        let spear_mc = replay(&initial, &spear, now, now, Rules::Mc).unwrap();
        assert_eq!(
            spear_m1.holding, spear_mc.holding,
            "the Spearman costs the same"
        );
        assert_eq!(
            stores_digest(&mc.holding).unwrap(),
            stores_digest(&spear_mc.holding).unwrap(),
            "a conquest Horseman costs a Spearman's"
        );
        assert_eq!(u32_at(&mc.holding, H::reserve(2)).unwrap(), 100);
    }

    /// S1: a founding writes the site's terrain ore and takes it as the
    /// base ore; Build accepts the workshop only under the S1 rules; Train
    /// charges the strong units arms.
    #[test]
    fn s1_founding_workshop_and_arms_training() {
        let now = 1_800_000_000;
        let ore = 9 * MILLI;
        let d = founded(&vec![0u8; H::SIZE], now, 0, 1, None, Some(ore)).unwrap();
        assert_eq!(terrain_ore(&d).unwrap(), ore);
        let h = read(&d).unwrap();
        assert_eq!(h.production, arms::base_production(Tier::Hamlet, ore));
        // The ore building's first copy counts above the terrain base.
        assert_eq!(copy_number(&h, 3, ore).unwrap(), 1);
        // The workshop is item 8 under S1 and refused before.
        let w = Action::Build {
            item: arms::ITEM_WORKSHOP,
        };
        assert!(replay(&d, &w, now, now, Rules::Mc).is_err());
        let built = replay(&d, &w, now, now, Rules::S1).unwrap();
        let hb = read(&built.holding).unwrap();
        assert!(hb.queue.iter().flatten().any(|q| q.effect
            == Effect::Production {
                resource: arms::ARMS,
                delta: arms::WORKSHOP_DELTA
            }));
        // A Pikeman needs arms the founded holding does not have.
        let pike = Action::Train { unit: 3, n: 100 };
        assert!(replay(&d, &pike, now, now, Rules::Mc).is_ok());
        assert!(replay(&d, &pike, now, now, Rules::S1).is_err());
        // A Spearman costs no arms.
        let spear = Action::Train { unit: 0, n: 100 };
        assert_eq!(
            replay(&d, &spear, now, now, Rules::S1).unwrap().holding,
            replay(&d, &spear, now, now, Rules::Mc).unwrap().holding
        );
        // M1 and MC holdings (TERRAIN_ORE 0) keep the flat base.
        assert_eq!(
            base_production(Tier::Town, 0),
            catalog::base_production(Tier::Town)
        );
    }

    /// A conquest founding's shield is the season's for the order (MC
    /// §3.9), written as given into a v2 Holding; an outpost (order 2–3)
    /// has no starter kit (MC §3.8).
    #[test]
    fn conquest_founding_shield_follows_the_season_timers() {
        use frontier_abi::layout::header as HDR;
        use frontier_abi::v2::presets::FRONTIER_28;
        let g = 1_800_000_000;
        let cq = FRONTIER_28;
        assert_eq!(founding_shield(&cq, 1, g + 10, g), Some(g + 10 + 172_800));
        assert_eq!(
            founding_shield(&cq, 1, g + 604_800, g),
            Some(g + 604_800 + 259_200)
        );
        assert_eq!(founding_shield(&cq, 2, g + 10, g), Some(g + 10 + 7_200));
        assert_eq!(
            founding_shield(&cq, 3, g + 604_800, g),
            Some(g + 604_800 + 7_200)
        );
        let mut post = vec![0u8; H::SIZE];
        post[HDR::LAYOUT_VERSION..HDR::LAYOUT_VERSION + 2].copy_from_slice(&2u16.to_le_bytes());
        let first = founded(&post, g + 10, 0, 1, Some(g + 172_810), None).unwrap();
        assert_eq!(i64_at(&first, H::SHIELD_UNTIL).unwrap(), g + 172_810);
        assert_eq!(first[H::ORDER], 1);
        let outpost = founded(&post, g + 10, 0, 2, Some(g + 7_210), None).unwrap();
        assert_eq!(i64_at(&outpost, H::SHIELD_UNTIL).unwrap(), g + 7_210);
        assert_eq!(outpost[H::ORDER], 2);
        let food =
            |d: &[u8]| i64_at(d, H::store(Resource::Food as usize) + accrual::VALUE).unwrap();
        assert!(food(&first) > 0, "the first holding has the starter kit");
        assert_eq!(food(&outpost), 0, "an outpost has none");
    }
}
