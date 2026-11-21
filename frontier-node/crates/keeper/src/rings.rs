//! Rings and provinces (M1 contract §8.2 "Genesis" and "Rings", §5.9,
//! I-30, I-46, I-48). Role `rings`, class D.
//!
//! - **OpenRing(d)** for `d = Frontier.rings_opened`: a genesis ring
//!   (`d ≤ g`) opens as soon as the season is Seeded (seeded at open, no
//!   ConsumeRingSeed); a crowding ring (`d > g`) opens when the rule of
//!   §5.9 holds on the **folded** values ([`fclient::land::ring_open_check`]:
//!   Running, one bell since the last opening, some wedge crowded past θ,
//!   every wedge fund able to pay `d` provinces).
//! - **ConsumeRingSeed(d)** once the RingSeed's round
//!   (`ring_seed_round(t_open)`) is published.
//! - **OpenProvince** for every province of every seeded ring not yet on
//!   chain (6d per ring; the Concord is ring 0). With `lazy_provinces`
//!   (devnet-preset-wide) only the genesis rings' provinces: a seeded ring
//!   past them is complete at once ([`ring_complete_lazily`]).
//! - **The rim's provinces** (`rim_per_wedge` > 0; owner Q-W1: a first
//!   village may also be founded on the rim of a wide season): once ring
//!   128 is opened and seeded, OpenProvince for every province of
//!   [`rim_plan`] not yet on chain, so a player can file a rim FileTicket
//!   (which the `tickets` role settles) next to the wide land.
//!
//! - **Provinces on demand** (`provinces_reach` > 0; devnet-open-province,
//!   D-devnet-rim-homes-2): with `lazy_provinces` nothing else opens the
//!   provinces of rings past the genesis rings, yet a second village
//!   (FileOutpost: ring > `heartland_max_ring`, within `outpost_range` of
//!   the home) and a ⑭ R3 home past the heartland need a present Province.
//!   Every `provinces_scan_slots` the duty reads the provinces it knows,
//!   and OpenProvince for the absent provinces of seeded legacy rings past
//!   the genesis within `provinces_reach` of a settled one ([`demand_plan`]),
//!   at most `provinces_per_pass` a scan and `provinces_max` a run, never
//!   below a wedge fund's floor ([`demand_fund_floor`]) and never while
//!   the feed guard holds automatic writes.
//!
//! - **The wide rings** (`wide_rings` > 0, `playable-lane` build; devnet
//!   runbook gap P6): once ring 128 is seeded, rings 129.. one at a time
//!   ([`RingDuty::plan_wide`]): WideRequestRingSeed when the previous ring
//!   is seeded, its plan complete and a bell has passed since it opened;
//!   WideConsumeRingSeed once the bound round is published; then
//!   WideOpenProvince for every province of [`wide_plan`] not on chain.
//!   A `NotImplemented` there (no WideSetRules yet) ends only the wide part.
//!
//! A program that answers `NotImplemented` (99) for a land instruction
//! ends this duty with an alert (the W2 program); the beacon duties keep
//! running.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use solana_address::Address;

use fclient::abi::{status, tag, Class};
use fclient::decode::{Frontier, Province, RingSeed, Season};
use fclient::ix;
use fclient::land::{
    frontier_extend_check, ring_open_check, ExtendWait, RingWait, FUND_RENT, PROVINCE_RENT_V2,
};
use fclient::ports::{ChainPort, DrandPort, PortResult};
use permutation_rules::frontier::geometry::{ring_provinces, ProvinceCoord, R_MAX_HARD};

use crate::engine::{BuildCtx, CancelReason, Engine, WriteSpec};
use crate::rounds::Rounds;
use crate::Tick;

pub fn ring_key(d: u16) -> String {
    format!("open-ring:{d}")
}
pub fn ring_seed_key(d: u16) -> String {
    format!("ring-seed:{d}")
}
pub fn province_key(p: i32, q: i32) -> String {
    format!("open-province:{p},{q}")
}
pub fn extend_key(d: u16) -> String {
    format!("extend-frontier:{d}")
}

#[derive(Default)]
pub struct RingDuty {
    /// Provinces seen present on chain.
    pub opened: BTreeSet<(i32, i32)>,
    /// Rings whose every province is present.
    pub complete: BTreeSet<u16>,
    /// The program has no land instructions (99 on a ring or province write).
    pub unsupported: bool,
    /// Every genesis ring opened and every genesis province created.
    pub genesis_done: bool,
    /// Why the next crowding ring waits (status).
    pub waiting: Option<RingWait>,
    /// Why ExtendFrontier waits (status; `None` while the duty is off or
    /// the season has no ceiling).
    pub extend_waiting: Option<ExtendWait2>,
    /// `(d, slot)` when this keeper first saw ring d opened / seeded.
    pub opened_at: Vec<(u16, u64)>,
    pub seeded_at: Vec<(u16, u64)>,
    seen_open: BTreeSet<u16>,
    seen_seeded: BTreeSet<u16>,
    /// Bell at which this keeper saw ring d complete (keeper policy below).
    complete_bell: std::collections::BTreeMap<u16, u32>,
    /// `rim_per_wedge`: every province of [`rim_plan`] is on chain.
    pub rim_done: bool,
    /// `rim_per_wedge`: the plan's provinces seen on chain (status).
    pub rim_present: usize,
    /// `wide_rings` (P6): where each wide ring stands (status, tests).
    pub wide: WideRings,
    /// `provinces_reach`: provinces on demand (status, tests).
    pub demand: Demand,
}

/// `provinces_reach` (devnet-open-province) as this keeper saw it.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Demand {
    /// Slot of the last scan (`None` before the first).
    pub last_scan: Option<u64>,
    /// Known provinces with a settled site at the last scan.
    pub settled: usize,
    /// Absent provinces the last scan wanted (before the caps).
    pub wanted: usize,
    /// Provinces this keeper planned an OpenProvince for on demand.
    pub planned: BTreeSet<(i32, i32)>,
    /// Of `planned`, those seen on chain since.
    pub opened: usize,
    /// Why the last scan planned less than it wanted (status).
    pub waiting: Option<String>,
}

/// The P6 wide rings as this keeper saw them.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct WideRings {
    /// Per wide ring: `(requested, seeded, plan provinces present, plan size)`.
    pub rings: BTreeMap<u64, (bool, bool, usize, usize)>,
    /// Every ring of `wide_rings` seeded and its plan on chain.
    pub done: bool,
    /// Why the next request waits (status).
    pub waiting: Option<String>,
    /// A wide write died `NotImplemented` (no WideSetRules on this season).
    pub unsupported: bool,
    /// Wide provinces seen present (not re-read).
    pub present: BTreeSet<(i64, i64)>,
}

pub fn wide_ring_key(ring: u64) -> String {
    format!("wide-ring:{ring}")
}
pub fn wide_seed_key(ring: u64) -> String {
    format!("wide-ring-seed:{ring}")
}
pub fn wide_province_key(p: i64, q: i64) -> String {
    format!("wide-province:{p},{q}")
}

/// The wide provinces P6 opens on `ring` (`wide_per_wedge` per wedge, the
/// middle of each wedge's arc): [`crate::widelane::wide_plan`].
#[cfg(feature = "playable-lane")]
pub use crate::widelane::wide_plan;

/// The rim provinces a keeper with `rim_per_wedge = n` opens (owner Q-W1):
/// on the first wide ring (129), per wedge, the `n` provinces in the middle
/// of that wedge's arc (in the ring's walking order, wedges in order); then
/// every ring-128 province that borders one of them, in that order, each
/// once. The same provinces as the local wide world's rim (`itest`
/// `wide_land::rim_plan(&wide_plan(129, n))`, pinned there), so a rim first
/// village is within `outpost_range` (3) of the wide provinces a wide-ring
/// duty would open with the same `n`. Pure.
pub fn rim_plan(per_wedge: usize) -> Vec<(i32, i32)> {
    let r = i32::from(R_MAX_HARD) + 1;
    /// A ring-129 province with its angle along the ring.
    type Along = (f64, (i32, i32));
    let mut by_wedge: BTreeMap<u8, Vec<Along>> = BTreeMap::new();
    for p in -r..=r {
        for q in (-r).max(-p - r)..=r.min(-p + r) {
            let c = ProvinceCoord::new(p, q);
            if c.ring() != r as u32 {
                continue;
            }
            let Some(w) = c.wedge() else { continue };
            // (the axial position's angle: a stable order along the ring)
            let (x, y) = (
                p as f64 + q as f64 / 2.0,
                q as f64 * 0.866_025_403_784_438_6,
            );
            by_wedge.entry(w).or_default().push((y.atan2(x), (p, q)));
        }
    }
    let mut wide = vec![];
    for (_, mut v) in by_wedge {
        v.sort_by(|a, b| a.0.total_cmp(&b.0));
        // (a wedge straddling the angle's wrap: walk it from its largest gap so the arc is contiguous)
        if v.len() > 1 {
            let gap = (0..v.len())
                .max_by(|&i, &j| {
                    let g = |k: usize| {
                        (v[(k + 1) % v.len()].0 - v[k].0).rem_euclid(std::f64::consts::TAU)
                    };
                    g(i).total_cmp(&g(j))
                })
                .unwrap_or(0);
            let n = v.len();
            v.rotate_left((gap + 1) % n);
        }
        let n = per_wedge.min(v.len());
        let from = (v.len() - n) / 2;
        wide.extend(v[from..from + n].iter().map(|x| x.1));
    }
    let mut out = vec![];
    for (p, q) in wide {
        for (dp, dq) in [(1, 0), (1, -1), (0, -1), (-1, 0), (-1, 1), (0, 1)] {
            let n = (p + dp, q + dq);
            if ProvinceCoord::new(n.0, n.1).ring() == u32::from(R_MAX_HARD) && !out.contains(&n) {
                out.push(n);
            }
        }
    }
    out
}

/// The bytes of a wide Province (`frontier_abi::world_index::land::province::SIZE`,
/// a feature-gated module; pinned in a test of the `playable-lane` build).
pub const WIDE_PROVINCE_BYTES: usize = 4_864;

/// The lamports a wedge fund must keep above its own rent after an
/// on-demand OpenProvince (`provinces_reach`): what the `rings` duty of this
/// configuration may still ask of it. The largest balance check still ahead
/// (OpenRing(d) checks `d × rent(4,736)` up to `extend_max_ring`;
/// WideRequestRingSeed(r) checks `r × rent(4,864)` up to the last wide
/// ring), plus the wedge's share of the rim plan and of every wide ring's
/// plan. Conservative: it stays reserved after those openings are done.
/// Pure.
pub fn demand_fund_floor(cfg: &crate::config::KeeperConfig) -> u64 {
    let wide_rent = frontier_abi::layout::rent(WIDE_PROVINCE_BYTES);
    let legacy_check = if cfg.extend {
        u64::from(cfg.extend_max_ring) * PROVINCE_RENT_V2
    } else {
        0
    };
    let wide_check = if cfg.wide_rings > 0 {
        (u64::from(R_MAX_HARD) + u64::from(cfg.wide_rings)) * wide_rent
    } else {
        0
    };
    let rim_share =
        rim_plan(cfg.rim_per_wedge as usize).len().div_ceil(6) as u64 * PROVINCE_RENT_V2;
    let wide_share = u64::from(cfg.wide_rings) * u64::from(cfg.wide_per_wedge) * wide_rent;
    legacy_check.max(wide_check) + rim_share + wide_share
}

/// The absent provinces `provinces_reach` wants (pure): every province
/// within `reach` of a `settled` one, of a legacy ring `genesis < ring <
/// rings_opened` (and ≤ 128) that `seeded` holds, not in `known`; each
/// once, nearest to a settled province first, then by ring, then by
/// coordinate.
pub fn demand_plan(
    settled: &[(i32, i32)],
    known: &BTreeSet<(i32, i32)>,
    seeded: &BTreeSet<u16>,
    genesis: u16,
    rings_opened: u16,
    reach: u16,
) -> Vec<(i32, i32)> {
    let mut best: BTreeMap<(i32, i32), u32> = BTreeMap::new();
    let r = i32::from(reach);
    for &(sp, sq) in settled {
        let s = ProvinceCoord::new(sp, sq);
        for dp in -r..=r {
            for dq in (-r).max(-dp - r)..=r.min(-dp + r) {
                let c = ProvinceCoord::new(sp + dp, sq + dq);
                let ring = c.ring();
                if ring <= u32::from(genesis)
                    || ring >= u32::from(rings_opened)
                    || ring > u32::from(R_MAX_HARD)
                    || !seeded.contains(&(ring as u16))
                    || known.contains(&(c.p, c.q))
                {
                    continue;
                }
                let d = s.distance(c);
                let e = best.entry((c.p, c.q)).or_insert(d);
                *e = (*e).min(d);
            }
        }
    }
    let mut v: Vec<((i32, i32), u32)> = best.into_iter().collect();
    v.sort_by_key(|&((p, q), d)| (d, ProvinceCoord::new(p, q).ring(), p, q));
    v.into_iter().map(|x| x.0).collect()
}

/// Keeper policy for crowding rings (wave-3 review, W3-C D5/F1; the
/// contract allows any caller to open a ring whenever the folded values
/// are crowded): this keeper requests OpenRing(d > g) only once ring
/// d − 1 is complete (every province on chain) **and** a whole fold of a
/// later bell has landed, so the folded values count ring d − 1's sites.
/// Without it the folded values stay crowded for the bells the previous
/// ring needs to seed and open, and a ring opens every bell.
pub fn crowding_ring_allowed(
    d: u16,
    genesis: u16,
    complete_bell: Option<u32>,
    fold_bell: u32,
    fold_part: u8,
) -> bool {
    d <= genesis || complete_bell.is_some_and(|cb| fold_bell > cb && fold_part == 0)
}

/// `lazy_provinces`: a ring past the genesis rings is complete as soon as it
/// is seeded (its provinces open on demand), so the next crowding ring and
/// ExtendFrontier wait for no fold of its sites; the genesis rings are
/// opened whole as before.
pub fn ring_complete_lazily(lazy: bool, d: u16, genesis: u16) -> bool {
    lazy && d > genesis
}

/// Why this keeper does not send ExtendFrontier now: the program's rule
/// ([`fclient::land::frontier_extend_check`]) or one of the keeper's own
/// waits.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ExtendWait2 {
    /// The program would refuse it.
    Rule(ExtendWait),
    /// The outermost ring is not complete (every province on chain) and
    /// folded by a later bell yet ([`crowding_ring_allowed`]).
    RingIncomplete,
    /// `d` is past the keeper's cap (`extend_max_ring`, default 17: the
    /// prize program's `MAX_RING`).
    PastCap { d: u16, cap: u16 },
}

/// The keeper's ExtendFrontier policy (map growth, a local candidate; off
/// unless `extend = true`): `Ok(d)` to send ExtendFrontier(d) now. `d` is
/// computed from the chain on every tick (`effective r_max + 1`), never
/// remembered: once it lands the effective `r_max` is `d` and the next
/// tick asks for `d + 1` only after ring `d` is opened, complete and folded.
///
/// - the program's rule holds now ([`frontier_extend_check`]: a ceiling,
///   `d ≤ ceiling`, Running, every ring up to the effective `r_max`
///   opened, a bell since the last opening, some wedge crowded past θ);
/// - the outermost ring is complete and a whole fold of a later bell has
///   landed (the wait of a crowding ring, so the fold counts its sites);
/// - `d ≤ cap` (the keeper's `extend_max_ring`).
pub fn extend_due(
    s: &Season,
    fr: &Frontier,
    now: i64,
    outer_complete_bell: Option<u32>,
    cap: u16,
    lazy: bool,
) -> Result<u16, ExtendWait2> {
    let d = frontier_extend_check(s, fr, now).map_err(ExtendWait2::Rule)?;
    if d > cap {
        return Err(ExtendWait2::PastCap { d, cap });
    }
    let outer = d - 1;
    let lazy_done =
        ring_complete_lazily(lazy, outer, s.genesis_ring as u16) && outer_complete_bell.is_some();
    if !lazy_done && !crowding_ring_allowed(d, 0, outer_complete_bell, fr.fold_bell, fr.fold_part) {
        return Err(ExtendWait2::RingIncomplete);
    }
    Ok(d)
}

impl RingDuty {
    /// OpenProvince for every province of [`rim_plan`] not on chain yet
    /// (the rim's RingSeed must be seeded: the program reads its seed).
    async fn plan_rim<P: ChainPort>(
        &mut self,
        t: &Tick<'_>,
        port: &P,
        engine: &mut Engine,
    ) -> PortResult<()> {
        let rs = port.accounts(&[t.addrs.ring_seed(R_MAX_HARD)], 0).await?;
        let seeded = rs[0]
            .as_ref()
            .and_then(|a| RingSeed::decode(&a.data).ok())
            .is_some_and(|rs| rs.status == 2);
        if !seeded {
            return Ok(());
        }
        let plan = rim_plan(t.cfg.rim_per_wedge as usize);
        let want: Vec<(i32, i32)> = plan
            .iter()
            .copied()
            .filter(|c| !self.opened.contains(c))
            .collect();
        let keys: Vec<Address> = want.iter().map(|&(p, q)| t.addrs.province(p, q)).collect();
        let mut got = vec![];
        for chunk in keys.chunks(100) {
            got.extend(port.accounts(chunk, 0).await?);
        }
        let mut missing = 0usize;
        for (&(p, q), acct) in want.iter().zip(got) {
            if acct.is_some_and(|a| a.owner == t.addrs.program && !a.data.is_empty()) {
                self.opened.insert((p, q));
                engine.cancel(&province_key(p, q), CancelReason::ChainStateObserved);
                continue;
            }
            missing += 1;
            let a = t.addrs.clone();
            let (pi, qi) = (p as i16, q as i16);
            engine.ensure(
                WriteSpec {
                    key: province_key(p, q),
                    kind: "open-province",
                    tag: tag::OPEN_PROVINCE,
                    class: Class::D,
                    bell: None,
                    region: Some(ix::region_of(p, q)),
                    build: Arc::new(move |c: &BuildCtx| {
                        vec![ix::open_province(&a, c.payer, pi, qi)]
                    }),
                    deadline_slot: None,
                    not_before_slot: 0,
                    fixed_payer: None,
                },
                t.slot,
            );
        }
        self.rim_present = plan.len() - missing;
        self.rim_done = missing == 0;
        Ok(())
    }

    /// `provinces_reach`: one scan (module doc). Reads every province this
    /// duty knows on chain, keeps those with a settled site, and plans
    /// OpenProvince for [`demand_plan`]'s absent provinces within the caps.
    async fn plan_demand<P: ChainPort>(
        &mut self,
        t: &Tick<'_>,
        port: &P,
        engine: &mut Engine,
        rings_opened: u16,
    ) -> PortResult<()> {
        if !engine.feed_writes_allowed() {
            self.demand.waiting = Some("feed guard: automatic writes held".into());
            return Ok(());
        }
        if self
            .demand
            .last_scan
            .is_some_and(|s| t.slot < s.saturating_add(t.cfg.provinces_scan_slots))
        {
            return Ok(());
        }
        self.demand.last_scan = Some(t.slot);
        // The settled provinces among the known ones (rings ≥ 2: rings 0–1
        // are reserved unless the season is centre-free, and are genesis).
        let known: Vec<(i32, i32)> = self.opened.iter().copied().collect();
        let keys: Vec<Address> = known.iter().map(|&(p, q)| t.addrs.province(p, q)).collect();
        let mut got = vec![];
        for chunk in keys.chunks(100) {
            got.extend(port.accounts(chunk, 0).await?);
        }
        let settled: Vec<(i32, i32)> = known
            .iter()
            .zip(got)
            .filter_map(|(&c, a)| {
                a.and_then(|a| Province::decode(&a.data).ok())
                    .filter(|pv| pv.n_sites_used > 0)
                    .map(|_| c)
            })
            .collect();
        self.demand.settled = settled.len();
        self.demand.opened = self
            .demand
            .planned
            .iter()
            .filter(|c| self.opened.contains(c))
            .count();
        let want = demand_plan(
            &settled,
            &self.opened,
            &self.seen_seeded,
            t.season.genesis_ring as u16,
            rings_opened,
            t.cfg.provinces_reach,
        );
        self.demand.wanted = want.len();
        if want.is_empty() {
            self.demand.waiting = None;
            return Ok(());
        }
        // Present already (someone else opened it): known from now on.
        let keys: Vec<Address> = want.iter().map(|&(p, q)| t.addrs.province(p, q)).collect();
        let mut got = vec![];
        for chunk in keys.chunks(100) {
            got.extend(port.accounts(chunk, 0).await?);
        }
        let mut missing = vec![];
        for (&(p, q), acct) in want.iter().zip(got) {
            if acct.is_some_and(|a| a.owner == t.addrs.program && !a.data.is_empty()) {
                self.opened.insert((p, q));
                engine.cancel(&province_key(p, q), CancelReason::ChainStateObserved);
            } else {
                missing.push((p, q));
            }
        }
        if missing.is_empty() {
            self.demand.waiting = None;
            return Ok(());
        }
        let funds = port.accounts(&t.addrs.province_funds(), 0).await?;
        let mut lam: [u64; 6] =
            core::array::from_fn(|w| funds[w].as_ref().map_or(0, |a| a.lamports));
        let floor = demand_fund_floor(t.cfg);
        let mut waiting = None;
        let mut sent = 0u16;
        for (p, q) in missing {
            if sent >= t.cfg.provinces_per_pass {
                waiting = Some(format!("per-pass cap {}", t.cfg.provinces_per_pass));
                break;
            }
            let fresh = !self.demand.planned.contains(&(p, q));
            if fresh && self.demand.planned.len() >= t.cfg.provinces_max as usize {
                waiting = Some(format!("run cap {} reached", t.cfg.provinces_max));
                break;
            }
            let w = ix::wedge_of(p, q) as usize;
            if lam[w].saturating_sub(FUND_RENT) < floor.saturating_add(PROVINCE_RENT_V2) {
                waiting = Some(format!("wedge fund {w} at its floor ({floor} lamports)"));
                continue;
            }
            lam[w] -= PROVINCE_RENT_V2;
            self.demand.planned.insert((p, q));
            sent += 1;
            let a = t.addrs.clone();
            let (pi, qi) = (p as i16, q as i16);
            engine.ensure(
                WriteSpec {
                    key: province_key(p, q),
                    kind: "open-province",
                    tag: tag::OPEN_PROVINCE,
                    class: Class::D,
                    bell: None,
                    region: Some(ix::region_of(p, q)),
                    build: Arc::new(move |c: &BuildCtx| {
                        vec![ix::open_province(&a, c.payer, pi, qi)]
                    }),
                    deadline_slot: None,
                    not_before_slot: 0,
                    fixed_payer: None,
                },
                t.slot,
            );
        }
        self.demand.waiting = waiting;
        Ok(())
    }

    pub async fn plan<P: ChainPort, D: DrandPort>(
        &mut self,
        t: &Tick<'_>,
        port: &P,
        drand: &D,
        rounds: &mut Rounds,
        engine: &mut Engine,
    ) -> PortResult<()> {
        let s = t.season;
        let eff = s.effective_status(t.now);
        if !t.cfg.has_role("rings")
            || self.unsupported
            || !(eff == status::SEEDED || eff == status::RUNNING)
        {
            return Ok(());
        }
        let g = s.genesis_ring as u16;
        let now_bell = t.clock.bell_at(t.now).unwrap_or(0);
        let fr = port.accounts(&[t.addrs.frontier()], 0).await?;
        let Some(fr) = fr[0].as_ref().and_then(|a| Frontier::decode(&a.data).ok()) else {
            return Ok(());
        };
        let opened = fr.rings_opened;
        for d in 0..opened {
            if self.seen_open.insert(d) {
                self.opened_at.push((d, t.slot));
            }
        }
        // The next ring (map growth: up to the effective r_max, the Season's
        // or the Frontier's `r_max_ext` after ExtendFrontier).
        let r_max = s.r_max.max(fr.r_max_ext);
        let d = opened;
        let ready = if d <= g {
            self.waiting = None;
            true
        } else if d <= r_max
            && !(ring_complete_lazily(t.cfg.lazy_provinces, d - 1, g)
                && self.complete_bell.contains_key(&(d - 1)))
            && !crowding_ring_allowed(
                d,
                g,
                self.complete_bell.get(&(d - 1)).copied(),
                fr.fold_bell,
                fr.fold_part,
            )
        {
            self.waiting = Some(RingWait::TooSoon);
            false
        } else if d <= r_max {
            let funds = port.accounts(&t.addrs.province_funds(), 0).await?;
            let lam: [u64; 6] =
                core::array::from_fn(|w| funds[w].as_ref().map_or(0, |a| a.lamports));
            match ring_open_check(s, &fr, &lam, t.now) {
                Ok(()) => {
                    self.waiting = None;
                    true
                }
                Err(w) => {
                    self.waiting = Some(w);
                    false
                }
            }
        } else {
            self.waiting = Some(RingWait::AtMax);
            // Map growth (local candidate, off by default): every ring up
            // to the effective r_max is opened; extend by one ring when the
            // program would accept it and the keeper's waits hold.
            if t.cfg.extend && s.conquest.as_ref().is_some_and(|c| c.r_max_ceiling != 0) {
                match extend_due(
                    s,
                    &fr,
                    t.now,
                    self.complete_bell.get(&r_max).copied(),
                    t.cfg.extend_max_ring,
                    t.cfg.lazy_provinces,
                ) {
                    Ok(e) => {
                        self.extend_waiting = None;
                        let a = t.addrs.clone();
                        engine.ensure(
                            WriteSpec {
                                key: extend_key(e),
                                kind: "extend-frontier",
                                tag: tag::EXTEND_FRONTIER,
                                class: Class::D,
                                bell: None,
                                region: None,
                                build: Arc::new(move |c: &BuildCtx| {
                                    vec![ix::v2::extend_frontier(&a, c.payer, e)]
                                }),
                                deadline_slot: None,
                                not_before_slot: 0,
                                fixed_payer: None,
                            },
                            t.slot,
                        );
                    }
                    Err(w) => self.extend_waiting = Some(w),
                }
            }
            false
        };
        if ready {
            let a = t.addrs.clone();
            engine.ensure(
                WriteSpec {
                    key: ring_key(d),
                    kind: "open-ring",
                    tag: tag::OPEN_RING,
                    class: Class::D,
                    bell: None,
                    region: None,
                    build: Arc::new(move |c: &BuildCtx| vec![ix::open_ring(&a, c.payer, d)]),
                    deadline_slot: None,
                    not_before_slot: 0,
                    fixed_payer: None,
                },
                t.slot,
            );
        }
        // The rim's provinces (`rim_per_wedge`), once ring 128 is opened and seeded.
        if t.cfg.rim_per_wedge > 0 && !self.rim_done && opened > R_MAX_HARD {
            self.plan_rim(t, port, engine).await?;
        }
        // The wide rings (`wide_rings`, P6), once ring 128 is seeded.
        #[cfg(feature = "playable-lane")]
        if t.cfg.wide_rings > 0
            && !self.wide.done
            && !self.wide.unsupported
            && opened > R_MAX_HARD
            && eff == status::RUNNING
        {
            self.plan_wide(t, port, drand, rounds, engine, now_bell)
                .await?;
        }
        // Provinces on demand (`provinces_reach`), next to the settled land.
        if t.cfg.provinces_reach > 0 {
            self.plan_demand(t, port, engine, opened).await?;
        }
        // Seeds and provinces of the opened rings not complete yet.
        let rings: Vec<u16> = (0..opened).filter(|d| !self.complete.contains(d)).collect();
        if rings.is_empty() {
            self.genesis_done = opened > g;
            return Ok(());
        }
        let seeds = port
            .accounts(
                &rings
                    .iter()
                    .map(|&d| t.addrs.ring_seed(d))
                    .collect::<Vec<Address>>(),
                0,
            )
            .await?;
        let mut want: Vec<(u16, i32, i32)> = vec![];
        for (&d, acct) in rings.iter().zip(seeds) {
            let Some(rs) = acct.and_then(|a| RingSeed::decode(&a.data).ok()) else {
                continue;
            };
            match rs.status {
                // Requested: consume the ring seed once its round is out.
                1 if t.clock.drand.round_time(rs.round) <= t.now => {
                    if let Some(arg) = rounds.get(drand, rs.round, t.slot).await {
                        let a = t.addrs.clone();
                        engine.ensure(
                            WriteSpec {
                                key: ring_seed_key(d),
                                kind: "ring-seed",
                                tag: tag::CONSUME_RING_SEED,
                                class: Class::D,
                                bell: None,
                                region: None,
                                build: Arc::new(move |c: &BuildCtx| {
                                    vec![ix::consume_ring_seed(&a, c.payer, d, &arg)]
                                }),
                                deadline_slot: None,
                                not_before_slot: 0,
                                fixed_payer: None,
                            },
                            t.slot,
                        );
                    }
                }
                2 => {
                    if self.seen_seeded.insert(d) {
                        self.seeded_at.push((d, t.slot));
                    }
                    engine.cancel(&ring_seed_key(d), CancelReason::ChainStateObserved);
                    if ring_complete_lazily(t.cfg.lazy_provinces, d, g) {
                        self.complete.insert(d);
                        self.complete_bell.entry(d).or_insert(now_bell);
                        continue;
                    }
                    want.extend(
                        ring_provinces(d as u32)
                            .into_iter()
                            .map(|p| (d, p.p, p.q))
                            .filter(|&(_, p, q)| !self.opened.contains(&(p, q))),
                    );
                    if want.iter().all(|w| w.0 != d) {
                        self.complete.insert(d);
                        self.complete_bell.entry(d).or_insert(now_bell);
                    }
                }
                _ => {}
            }
        }
        if !want.is_empty() {
            let keys: Vec<Address> = want
                .iter()
                .map(|&(_, p, q)| t.addrs.province(p, q))
                .collect();
            let mut got = vec![];
            for chunk in keys.chunks(100) {
                got.extend(port.accounts(chunk, 0).await?);
            }
            let mut missing: BTreeSet<u16> = BTreeSet::new();
            for (&(d, p, q), acct) in want.iter().zip(got) {
                if acct.is_some_and(|a| a.owner == t.addrs.program && !a.data.is_empty()) {
                    self.opened.insert((p, q));
                    engine.cancel(&province_key(p, q), CancelReason::ChainStateObserved);
                    continue;
                }
                missing.insert(d);
                let a = t.addrs.clone();
                let (pi, qi) = (p as i16, q as i16);
                engine.ensure(
                    WriteSpec {
                        key: province_key(p, q),
                        kind: "open-province",
                        tag: tag::OPEN_PROVINCE,
                        class: Class::D,
                        bell: None,
                        region: Some(ix::region_of(p, q)),
                        build: Arc::new(move |c: &BuildCtx| {
                            vec![ix::open_province(&a, c.payer, pi, qi)]
                        }),
                        deadline_slot: None,
                        not_before_slot: 0,
                        fixed_payer: None,
                    },
                    t.slot,
                );
            }
            for &(d, _, _) in &want {
                if !missing.contains(&d) {
                    self.complete.insert(d);
                    self.complete_bell.entry(d).or_insert(now_bell);
                }
            }
        }
        self.genesis_done = opened > g && (0..=g).all(|d| self.complete.contains(&d));
        Ok(())
    }

    /// P6: the next step of the wide rings `129..129 + wide_rings`, one
    /// ring at a time (module doc). Every gate the keeper checks before a
    /// send is the program's own (`proc/wide.rs request_ring_seed`): the
    /// previous ring seeded and a bell since it opened; the θ and fund
    /// checks are left to the program (a refusal is a failed write the
    /// engine backs off, and the status shows it).
    #[cfg(feature = "playable-lane")]
    async fn plan_wide<P: ChainPort, D: DrandPort>(
        &mut self,
        t: &Tick<'_>,
        port: &P,
        drand: &D,
        rounds: &mut Rounds,
        engine: &mut Engine,
        now_bell: u32,
    ) -> PortResult<()> {
        use frontier_abi::world_index::land::{self as wl, SeedStatus, WideRingSeed};
        let c = crate::widelane::ctx(t.addrs);
        let first = crate::widelane::FIRST_RING;
        let last = first + u64::from(t.cfg.wide_rings) - 1;
        let n = t.cfg.wide_per_wedge as usize;
        // The legacy rim's seed (the previous ring of 129).
        let rs = port.accounts(&[t.addrs.ring_seed(R_MAX_HARD)], 0).await?;
        let Some(rim) = rs[0]
            .as_ref()
            .filter(|a| a.owner == t.addrs.program)
            .and_then(|a| RingSeed::decode(&a.data).ok())
            .filter(|r| r.status == 2)
        else {
            self.wide.waiting = Some("ring 128 not seeded".into());
            return Ok(());
        };
        // (previous ring's opened bell)
        let mut prev_opened = rim.opened_bell;
        for ring in first..=last {
            let key = Address::new_from_array(wl::ring_seed_address(&c, ring));
            let got = port.accounts(&[key], 0).await?;
            let rec = got[0]
                .as_ref()
                .filter(|a| a.owner == t.addrs.program)
                .and_then(|a| WideRingSeed::read(&a.data).ok());
            let Some(rec) = rec else {
                // Not requested: the program's own gates (a bell since the
                // previous ring opened).
                self.wide.rings.insert(ring, (false, false, 0, 0));
                if now_bell <= prev_opened {
                    self.wide.waiting = Some(format!(
                        "ring {ring}: a bell after bell {prev_opened} (now {now_bell})"
                    ));
                    return Ok(());
                }
                self.wide.waiting = None;
                let a = t.addrs.clone();
                engine.ensure(
                    WriteSpec {
                        key: wide_ring_key(ring),
                        kind: "wide-ring",
                        tag: frontier_abi::world_index::wide_ix::WideIx::RequestRingSeed.tag(),
                        class: Class::D,
                        bell: None,
                        region: None,
                        build: Arc::new(move |c: &BuildCtx| {
                            vec![crate::widelane::request_ring_seed(&a, c.payer, ring)]
                        }),
                        deadline_slot: None,
                        not_before_slot: 0,
                        fixed_payer: None,
                    },
                    t.slot,
                );
                return Ok(());
            };
            engine.cancel(&wide_ring_key(ring), CancelReason::ChainStateObserved);
            if rec.status == SeedStatus::Requested {
                self.wide.rings.insert(ring, (true, false, 0, 0));
                if t.clock.drand.round_time(rec.round) > t.now {
                    self.wide.waiting =
                        Some(format!("ring {ring}: round {} not published", rec.round));
                    return Ok(());
                }
                let Some(arg) = rounds.get(drand, rec.round, t.slot).await else {
                    self.wide.waiting = Some(format!(
                        "ring {ring}: round {} not served by drand",
                        rec.round
                    ));
                    return Ok(());
                };
                self.wide.waiting = None;
                let a = t.addrs.clone();
                let (round, sig48) = (arg.round, arg.sig48);
                engine.ensure(
                    WriteSpec {
                        key: wide_seed_key(ring),
                        kind: "wide-ring-seed",
                        tag: frontier_abi::world_index::wide_ix::WideIx::ConsumeRingSeed.tag(),
                        class: Class::D,
                        bell: None,
                        region: None,
                        build: Arc::new(move |c: &BuildCtx| {
                            crate::widelane::consume_ring_seed(&a, c.payer, ring, round, sig48)
                                .map(|i| vec![i])
                                .unwrap_or_default()
                        }),
                        deadline_slot: None,
                        not_before_slot: 0,
                        fixed_payer: None,
                    },
                    t.slot,
                );
                return Ok(());
            }
            engine.cancel(&wide_seed_key(ring), CancelReason::ChainStateObserved);
            // Seeded: the plan's provinces.
            let plan = wide_plan(ring, n);
            let want: Vec<_> = plan
                .iter()
                .copied()
                .filter(|x| !self.wide.present.contains(&(x.p(), x.q())))
                .collect();
            let keys: Vec<Address> = want
                .iter()
                .map(|&x| Address::new_from_array(wl::province_address(&c, x)))
                .collect();
            let mut got = vec![];
            for chunk in keys.chunks(100) {
                got.extend(port.accounts(chunk, 0).await?);
            }
            let mut missing = 0usize;
            for (&x, acct) in want.iter().zip(got) {
                if acct.is_some_and(|a| a.owner == t.addrs.program && !a.data.is_empty()) {
                    self.wide.present.insert((x.p(), x.q()));
                    engine.cancel(
                        &wide_province_key(x.p(), x.q()),
                        CancelReason::ChainStateObserved,
                    );
                    continue;
                }
                missing += 1;
                let a = t.addrs.clone();
                engine.ensure(
                    WriteSpec {
                        key: wide_province_key(x.p(), x.q()),
                        kind: "wide-province",
                        tag: frontier_abi::world_index::wide_ix::WideIx::OpenProvince.tag(),
                        class: Class::D,
                        bell: None,
                        region: None,
                        build: Arc::new(move |c: &BuildCtx| {
                            crate::widelane::open_province(&a, c.payer, x)
                                .map(|i| vec![i])
                                .unwrap_or_default()
                        }),
                        deadline_slot: None,
                        not_before_slot: 0,
                        fixed_payer: None,
                    },
                    t.slot,
                );
            }
            self.wide
                .rings
                .insert(ring, (true, true, plan.len() - missing, plan.len()));
            if missing > 0 {
                self.wide.waiting = Some(format!("ring {ring}: {missing} provinces to open"));
                return Ok(());
            }
            prev_opened = rec.opened_bell;
        }
        self.wide.waiting = None;
        self.wide.done = true;
        Ok(())
    }

    /// A write of this duty died with NotImplemented: the program has no
    /// land instructions yet.
    pub fn on_dead(&mut self, key: &str, code: Option<u32>) -> bool {
        // (P6: a wide write refused NotImplemented — a season without
        //  WideSetRules — ends the wide part only; the legacy rings go on)
        if key.starts_with("wide-") && code == Some(fclient::abi::err::NOT_IMPLEMENTED) {
            self.wide.unsupported = true;
            return true;
        }
        if (key.starts_with("open-ring:")
            || key.starts_with("ring-seed:")
            || key.starts_with("open-province:"))
            && code == Some(fclient::abi::err::NOT_IMPLEMENTED)
        {
            self.unsupported = true;
            return true;
        }
        false
    }

    /// Provinces of every ring `0..=d_max` (the genesis count check).
    pub fn provinces_of_rings(d_max: u16) -> usize {
        (0..=d_max as u32).map(|d| ring_provinces(d).len()).sum()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// devnet-open-province: the on-demand plan is next to the settled land
    /// only, on seeded legacy rings past the genesis, nearest first.
    #[test]
    fn the_demand_plan_opens_next_to_settled_provinces_only() {
        let seeded: BTreeSet<u16> = (0..=6).collect();
        let known: BTreeSet<(i32, i32)> = (0..=3u32)
            .flat_map(ring_provinces)
            .map(|c| (c.p, c.q))
            .collect();
        // nothing settled: nothing wanted
        assert!(demand_plan(&[], &known, &seeded, 3, 129, 3).is_empty());
        // a settled ring-3 province, reach 3, rings 4..=6 seeded
        let home = ring_provinces(3)[0];
        let plan = demand_plan(&[(home.p, home.q)], &known, &seeded, 3, 129, 3);
        assert!(!plan.is_empty());
        let rings: Vec<u32> = plan
            .iter()
            .map(|&(p, q)| ProvinceCoord::new(p, q).ring())
            .collect();
        assert!(rings.iter().all(|r| (4..=6).contains(r)), "{rings:?}");
        let dists: Vec<u32> = plan
            .iter()
            .map(|&(p, q)| home.distance(ProvinceCoord::new(p, q)))
            .collect();
        assert!(dists.iter().all(|&d| (1..=3).contains(&d)));
        assert!(
            dists.windows(2).all(|w| w[0] <= w[1]),
            "nearest first: {dists:?}"
        );
        let set: BTreeSet<_> = plan.iter().collect();
        assert_eq!(set.len(), plan.len(), "each once");
        // exactly the hex disc of radius 3 outside rings 0..=3
        let disc = (-3i32..=3)
            .flat_map(|dp| ((-3).max(-dp - 3)..=3.min(-dp + 3)).map(move |dq| (dp, dq)))
            .map(|(dp, dq)| ProvinceCoord::new(home.p + dp, home.q + dq))
            .filter(|c| c.ring() > 3)
            .count();
        assert_eq!(plan.len(), disc);
        // an unseeded ring (5) and the opened-ring bound (rings_opened 6) are left out
        let partial: BTreeSet<u16> = [0, 1, 2, 3, 4, 6].into_iter().collect();
        let p2 = demand_plan(&[(home.p, home.q)], &known, &partial, 3, 6, 3);
        assert!(
            p2.iter()
                .all(|&(p, q)| ProvinceCoord::new(p, q).ring() == 4),
            "{p2:?}"
        );
        // known provinces are not wanted again; two settled provinces share the overlap once
        let mut k2 = known.clone();
        k2.extend(plan.iter().take(5).copied());
        let p3 = demand_plan(&[(home.p, home.q)], &k2, &seeded, 3, 129, 3);
        assert_eq!(p3.len(), plan.len() - 5);
        let other = ring_provinces(3)[1];
        let both = demand_plan(
            &[(home.p, home.q), (other.p, other.q)],
            &known,
            &seeded,
            3,
            129,
            3,
        );
        assert_eq!(both.iter().collect::<BTreeSet<_>>().len(), both.len());
        assert!(both.len() > plan.len());
        // never past the legacy rim
        let rim = (128, 0);
        let all: BTreeSet<u16> = (0..=128).collect();
        let p4 = demand_plan(&[rim], &BTreeSet::new(), &all, 3, 200, 2);
        assert!(p4
            .iter()
            .all(|&(p, q)| ProvinceCoord::new(p, q).ring() <= 128));
    }

    /// devnet-open-province: the fund floor of the devnet profile's keeper A
    /// (extend to 128, rim 6, wide rings 3 × 6) keeps ring 131's balance
    /// check, the rim's and the wide rings' shares; off duties add nothing.
    #[test]
    fn the_demand_fund_floor_keeps_what_the_rings_duty_still_needs() {
        let b = Address::new_from_array([2; 32]);
        let mut c = crate::config::KeeperConfig::new(Address::new_from_array([1; 32]), 1, b);
        assert_eq!(demand_fund_floor(&c), 0);
        c.extend = true;
        c.extend_max_ring = 128;
        assert_eq!(demand_fund_floor(&c), 128 * 24_709_120);
        c.rim_per_wedge = 6;
        c.wide_rings = 3;
        c.wide_per_wedge = 6;
        let wide = frontier_abi::layout::rent(WIDE_PROVINCE_BYTES);
        assert_eq!(wide, 25_359_360);
        assert_eq!(rim_plan(6).len(), 42);
        assert_eq!(
            demand_fund_floor(&c),
            131 * wide + 7 * 24_709_120 + 18 * wide
        );
        // 3,951,477,120 lamports: below a 6 SOL wedge fund less its genesis provinces
        assert!(demand_fund_floor(&c) < 5_500_000_000);
    }

    /// Q-W1: the rim plan is on ring 128, each province once, every one beside a planned ring-129 province, in
    /// every wedge; 0 opens nothing; it grows with `n`.
    #[test]
    fn the_rim_plan_is_on_the_rim_beside_the_middle_of_each_wedge() {
        assert!(rim_plan(0).is_empty());
        let plan = rim_plan(6);
        let set: BTreeSet<(i32, i32)> = plan.iter().copied().collect();
        assert_eq!(set.len(), plan.len(), "each province once");
        let mut wedges = BTreeSet::new();
        for &(p, q) in &plan {
            let c = ProvinceCoord::new(p, q);
            assert_eq!(c.ring(), 128);
            wedges.insert(c.wedge().unwrap());
            assert!(
                [(1, 0), (1, -1), (0, -1), (-1, 0), (-1, 1), (0, 1)]
                    .iter()
                    .any(|(dp, dq)| ProvinceCoord::new(p + dp, q + dq).ring() == 129),
                "({p},{q}) borders the wide land"
            );
        }
        assert_eq!(wedges.len(), 6);
        // six ring-129 provinces per wedge touch 7 or 8 rim provinces each (a corner adds one)
        assert!((42..=48).contains(&plan.len()), "{}", plan.len());
        assert!(rim_plan(1).len() < plan.len() && rim_plan(12).len() > plan.len());
        // the middle of a wedge, not its ends: far from the six corners (k·128 along an axis)
        for &(p, q) in &plan {
            let corner = [
                (128, 0),
                (0, 128),
                (-128, 128),
                (-128, 0),
                (0, -128),
                (128, -128),
            ]
            .iter()
            .map(|&(cp, cq)| ProvinceCoord::new(p, q).distance(ProvinceCoord::new(cp, cq)))
            .min()
            .unwrap();
            assert!(corner > 40, "({p},{q}) is {corner} from a corner");
        }
    }

    #[test]
    fn crowding_rings_wait_for_the_previous_ring_and_a_later_fold() {
        // Genesis rings never wait.
        assert!(crowding_ring_allowed(3, 3, None, 0, 0));
        // Ring 4: ring 3 not complete yet.
        assert!(!crowding_ring_allowed(4, 3, None, 50, 0));
        // Complete at bell 40: a fold of bell 40 or earlier does not count,
        // nor a fold of bell 41 still in its parts.
        assert!(!crowding_ring_allowed(4, 3, Some(40), 40, 0));
        assert!(!crowding_ring_allowed(4, 3, Some(40), 41, 1));
        assert!(crowding_ring_allowed(4, 3, Some(40), 41, 0));
    }

    fn put(d: &mut [u8], o: usize, v: &[u8]) {
        d[o..o + v.len()].copy_from_slice(v);
    }

    /// A Running S1-shaped season: r_max 16, θ 55% early, `ceiling` (0: none).
    fn season(genesis: i64, ceiling: u16) -> Season {
        use fclient::abi::layout::season as l;
        let mut d = vec![0u8; fclient::abi::size::SEASON];
        put(&mut d, 0, fclient::abi::magic::SEASON);
        d[l::STATUS] = status::SEEDED;
        put(&mut d, l::GENESIS_TS, &genesis.to_le_bytes());
        put(&mut d, l::R_MAX, &16u16.to_le_bytes());
        put(&mut d, l::THETA_EARLY_BPS, &5_500u16.to_le_bytes());
        put(&mut d, l::THETA_LATE_BPS, &6_500u16.to_le_bytes());
        put(&mut d, l::THETA_SWITCH_SECS, &259_200u32.to_le_bytes());
        // A 7-day season (end bell 1,008), as M1_LOCAL_7D.
        put(&mut d, l::END_BELL, &1_008u32.to_le_bytes());
        let mut s = Season::decode(&d).unwrap();
        let mut cq = frontier_abi::v2::presets::FRONTIER_7;
        cq.r_max_ceiling = ceiling;
        s.conquest = Some(cq);
        s
    }

    /// Rings 0..opened−1 opened, the last at bell 3, wedge 2 crowded (60%),
    /// a whole fold of bell `fold_bell`.
    fn frontier(opened: u16, ext: u16, fold_bell: u32) -> Frontier {
        use fclient::abi::layout::frontier as l;
        let mut b = vec![0u8; fclient::abi::size::FRONTIER];
        put(&mut b, 0, fclient::abi::magic::FRONTIER);
        put(&mut b, l::RINGS_OPENED, &opened.to_le_bytes());
        put(&mut b, l::LAST_RING_OPEN_BELL, &3u32.to_le_bytes());
        put(&mut b, l::FOLD_BELL, &fold_bell.to_le_bytes());
        for w in 0..6 {
            put(&mut b, l::WEDGE_OPEN + 4 * w, &100u32.to_le_bytes());
        }
        put(&mut b, l::WEDGE_OCCUPIED + 8, &60u32.to_le_bytes());
        let mut fr = Frontier::decode(&b).unwrap();
        fr.r_max_ext = ext;
        fr
    }

    /// Map growth (local candidate): the keeper's ExtendFrontier policy.
    #[test]
    fn extend_waits_for_the_rule_the_outer_ring_and_the_cap() {
        let g = 1_000_000;
        let now = g + 10 * 600; // bell 10
                                // A season without a ceiling: never.
        let s0 = season(g, 0);
        assert_eq!(
            extend_due(&s0, &frontier(17, 0, 9), now, Some(5), 17, false),
            Err(ExtendWait2::Rule(ExtendWait::NoCeiling))
        );
        let s = season(g, 24);
        // All rules met: ring 16 complete at bell 5, folded at bell 9.
        assert_eq!(
            extend_due(&s, &frontier(17, 0, 9), now, Some(5), 24, false),
            Ok(17)
        );
        // Ring 16 not opened yet; not complete; not folded after completing.
        assert_eq!(
            extend_due(&s, &frontier(16, 0, 9), now, Some(5), 24, false),
            Err(ExtendWait2::Rule(ExtendWait::RingsNotOpened))
        );
        assert_eq!(
            extend_due(&s, &frontier(17, 0, 9), now, None, 24, false),
            Err(ExtendWait2::RingIncomplete)
        );
        assert_eq!(
            extend_due(&s, &frontier(17, 0, 5), now, Some(5), 24, false),
            Err(ExtendWait2::RingIncomplete)
        );
        // The keeper's cap (the prize program's ring 17 by default).
        assert_eq!(
            extend_due(&s, &frontier(17, 0, 9), now, Some(5), 17, false),
            Ok(17)
        );
        assert_eq!(
            extend_due(&s, &frontier(18, 17, 9), now, Some(5), 17, false),
            Err(ExtendWait2::PastCap { d: 18, cap: 17 })
        );
        // After it landed (r_max_ext 17): nothing until ring 17 is opened,
        // then d is 18, recomputed from the chain.
        assert_eq!(
            extend_due(&s, &frontier(17, 17, 9), now, Some(5), 24, false),
            Err(ExtendWait2::Rule(ExtendWait::RingsNotOpened))
        );
        assert_eq!(
            extend_due(&s, &frontier(18, 17, 9), now, Some(5), 24, false),
            Ok(18)
        );
        assert_eq!(crate::config::EXTEND_MAX_RING_DEFAULT, 17);
    }

    /// devnet-preset-wide: with `lazy_provinces` a seeded ring past the
    /// genesis rings is complete at once; ExtendFrontier then waits for no
    /// fold of it (none of its provinces exist), but still for it to be
    /// seeded (complete) and for the program's own rule.
    #[test]
    fn lazy_provinces_skip_the_fold_wait_past_the_genesis_rings() {
        assert!(
            !ring_complete_lazily(true, 3, 3),
            "a genesis ring opens whole"
        );
        assert!(ring_complete_lazily(true, 4, 3));
        assert!(!ring_complete_lazily(false, 4, 3), "off by default");
        let g = 1_000_000;
        let now = g + 10 * 600;
        let s = season(g, 128);
        // ring 16 seeded at bell 5, no fold since: eager waits, lazy goes on
        assert_eq!(
            extend_due(&s, &frontier(17, 0, 5), now, Some(5), 128, false),
            Err(ExtendWait2::RingIncomplete)
        );
        assert_eq!(
            extend_due(&s, &frontier(17, 0, 5), now, Some(5), 128, true),
            Ok(17)
        );
        // not seeded yet: lazy waits too
        assert_eq!(
            extend_due(&s, &frontier(17, 0, 5), now, None, 128, true),
            Err(ExtendWait2::RingIncomplete)
        );
        // the program's rule still binds (ceiling 128)
        assert_eq!(
            extend_due(&s, &frontier(129, 128, 9), now, Some(5), 128, true),
            Err(ExtendWait2::Rule(ExtendWait::AtCeiling))
        );
    }
}
