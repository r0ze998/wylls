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
//!   chain (6d per ring; the Concord is ring 0).
//!
//! A program that answers `NotImplemented` (99) for a land instruction
//! ends this duty with an alert (the W2 program); the beacon duties keep
//! running.

use std::collections::BTreeSet;
use std::sync::Arc;

use solana_address::Address;

use fclient::abi::{status, tag, Class};
use fclient::decode::{Frontier, RingSeed, Season};
use fclient::ix;
use fclient::land::{frontier_extend_check, ring_open_check, ExtendWait, RingWait};
use fclient::ports::{ChainPort, DrandPort, PortResult};
use permutation_rules::frontier::geometry::ring_provinces;

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
) -> Result<u16, ExtendWait2> {
    let d = frontier_extend_check(s, fr, now).map_err(ExtendWait2::Rule)?;
    if d > cap {
        return Err(ExtendWait2::PastCap { d, cap });
    }
    if !crowding_ring_allowed(d, 0, outer_complete_bell, fr.fold_bell, fr.fold_part) {
        return Err(ExtendWait2::RingIncomplete);
    }
    Ok(d)
}

impl RingDuty {
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
            extend_due(&s0, &frontier(17, 0, 9), now, Some(5), 17),
            Err(ExtendWait2::Rule(ExtendWait::NoCeiling))
        );
        let s = season(g, 24);
        // All rules met: ring 16 complete at bell 5, folded at bell 9.
        assert_eq!(
            extend_due(&s, &frontier(17, 0, 9), now, Some(5), 24),
            Ok(17)
        );
        // Ring 16 not opened yet; not complete; not folded after completing.
        assert_eq!(
            extend_due(&s, &frontier(16, 0, 9), now, Some(5), 24),
            Err(ExtendWait2::Rule(ExtendWait::RingsNotOpened))
        );
        assert_eq!(
            extend_due(&s, &frontier(17, 0, 9), now, None, 24),
            Err(ExtendWait2::RingIncomplete)
        );
        assert_eq!(
            extend_due(&s, &frontier(17, 0, 5), now, Some(5), 24),
            Err(ExtendWait2::RingIncomplete)
        );
        // The keeper's cap (the prize program's ring 17 by default).
        assert_eq!(
            extend_due(&s, &frontier(17, 0, 9), now, Some(5), 17),
            Ok(17)
        );
        assert_eq!(
            extend_due(&s, &frontier(18, 17, 9), now, Some(5), 17),
            Err(ExtendWait2::PastCap { d: 18, cap: 17 })
        );
        // After it landed (r_max_ext 17): nothing until ring 17 is opened,
        // then d is 18, recomputed from the chain.
        assert_eq!(
            extend_due(&s, &frontier(17, 17, 9), now, Some(5), 24),
            Err(ExtendWait2::Rule(ExtendWait::RingsNotOpened))
        );
        assert_eq!(
            extend_due(&s, &frontier(18, 17, 9), now, Some(5), 24),
            Ok(18)
        );
        assert_eq!(crate::config::EXTEND_MAX_RING_DEFAULT, 17);
    }
}
