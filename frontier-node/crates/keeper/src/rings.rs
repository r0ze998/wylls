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
//! A program that answers `NotImplemented` (99) for a land instruction
//! ends this duty with an alert (the W2 program); the beacon duties keep
//! running.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use solana_address::Address;

use fclient::abi::{status, tag, Class};
use fclient::decode::{Frontier, RingSeed, Season};
use fclient::ix;
use fclient::land::{frontier_extend_check, ring_open_check, ExtendWait, RingWait};
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
}

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
    let mut by_wedge: BTreeMap<u8, Vec<(f64, (i32, i32))>> = BTreeMap::new();
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
        if !rs[0]
            .as_ref()
            .and_then(|a| RingSeed::decode(&a.data).ok())
            .is_some_and(|rs| rs.status == 2)
        {
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
                    build: Arc::new(move |c: &BuildCtx| vec![ix::open_province(&a, c.payer, pi, qi)]),
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

    /// A write of this duty died with NotImplemented: the program has no
    /// land instructions yet.
    pub fn on_dead(&mut self, key: &str, code: Option<u32>) -> bool {
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
            let corner = [(128, 0), (0, 128), (-128, 128), (-128, 0), (0, -128), (128, -128)]
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
