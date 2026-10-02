//! Criterion 10 ("the faction map moved", CONQUEST-CONTRACT §13.4) from a
//! season's per-bell control series, the 10k / 28-day gate of §8.7 item 4,
//! the v1.1 measurements of §8.7 item 7 (bot activity per bot-day, 7-day
//! net movement, coordination), the thresholds files and `mapmove-gate`.
//!
//! The series: the keep model records every change of a province's
//! control at its bell (KEEP_TAKEN); the holding-weight models (M1 and the
//! `mc-weightmap` control) are sampled at each game hour's last bell with
//! the strict controller. `lasting_changes` is criterion 10's definition
//! (a change from faction g at b − 1 to faction f at b that keeps f for
//! bells b … b + 5, or to `end_bell − 1`).

use std::collections::BTreeMap;
use std::fmt::Write;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;

use crate::config::Config;
use crate::mc::cqk::{self, NO_FACTION};
use crate::mc::BotProfile;
use crate::model::Arch;
use crate::sim::Sim;
use permutation_rules::frontier::travel::BELLS_PER_DAY;

/// Bells a change must last (criterion 10's ≥ 6 bells).
pub const LASTING_BELLS: u32 = 6;

/// One province of the series.
#[derive(Clone, Debug)]
pub struct ProvInfo {
    pub ring: u32,
    pub march: u32,
    pub opened: u32,
    pub initial: u8,
}

/// What criterion 10 and the reports read from one season.
#[derive(Clone, Debug)]
pub struct Series {
    pub end_bell: u32,
    pub days: u32,
    pub heartland_max_ring: u32,
    pub provs: Vec<Option<ProvInfo>>,
    pub n_marches: usize,
    /// (bell, province, from, to), in bell order.
    pub events: Vec<(u32, u32, u8, u8)>,
}

impl Series {
    pub fn from_sim(sim: &Sim) -> Series {
        let keeps = sim.cfg.rules.keeps();
        let provs = sim
            .provs
            .iter()
            .map(|p| {
                p.as_ref().map(|p| ProvInfo {
                    ring: p.ring,
                    march: p.march,
                    opened: p.opened,
                    initial: if keeps && p.mkeep.is_some() {
                        p.wedge
                    } else {
                        NO_FACTION
                    },
                })
            })
            .collect();
        let mut events = sim.mcs.ctl.events.clone();
        events.sort_by_key(|e| (e.0, e.1));
        Series {
            end_bell: sim.end_bell,
            days: sim.cfg.days,
            heartland_max_ring: if sim.cfg.rules.mc() {
                sim.cfg.mc.heartland_max_ring
            } else {
                3
            },
            provs,
            n_marches: sim
                .provs
                .iter()
                .flatten()
                .map(|p| p.march as usize + 1)
                .max()
                .unwrap_or(0),
            events,
        }
    }

    /// Control of every province at bell `at` (after that bell's changes).
    pub fn control_at(&self, at: u32) -> Vec<u8> {
        let mut c: Vec<u8> = self
            .provs
            .iter()
            .map(|p| match p {
                Some(p) if p.opened <= at => p.initial,
                _ => NO_FACTION,
            })
            .collect();
        for &(b, p, _, to) in &self.events {
            if b > at {
                break;
            }
            c[p as usize] = to;
        }
        c
    }

    /// Events per province, in bell order.
    fn by_prov(&self) -> BTreeMap<u32, Vec<(u32, u8, u8)>> {
        let mut m: BTreeMap<u32, Vec<(u32, u8, u8)>> = BTreeMap::new();
        for &(b, p, from, to) in &self.events {
            m.entry(p).or_default().push((b, from, to));
        }
        m
    }

    /// `control::lasting_changes`: (bell, province, from, to) of every
    /// faction-to-faction change that lasts `min_bells`.
    pub fn lasting_changes(&self, min_bells: u32) -> Vec<(u32, u32, u8, u8)> {
        let last = self.end_bell.saturating_sub(1);
        let mut out = Vec::new();
        for (p, ev) in self.by_prov() {
            for (i, &(b, from, to)) in ev.iter().enumerate() {
                if b > last || from >= 6 || to >= 6 || from == to {
                    continue;
                }
                let next = ev[i + 1..].iter().map(|e| e.0).find(|&nb| nb > b);
                let holds_to = (b + min_bells - 1).min(last);
                if next.is_none_or(|nb| nb > holds_to) {
                    out.push((b, p, from, to));
                }
            }
        }
        out.sort_unstable();
        out
    }
}

/// The figures of one season.
#[derive(Clone, Debug, Default)]
pub struct Metrics {
    pub seed: u64,
    // criterion 10
    pub lasting: f64,
    pub days_with_change: f64,
    pub two_controllers: f64,
    pub banner_changes: f64,
    pub marches_two_banners: f64,
    /// Contract v1.2's 10e (P₂ only: rings outside the heartlands open by
    /// bell 288, control at `end_bell − 1` vs bell 287); reported since
    /// the W1-close (PO-1 (b), CQH1(1)), gated no more.
    pub net_movement: f64,
    /// 10e′, the gated 10e since the W1-close (PO-1 (b), CQH1(1); E2's
    /// alternative 10e): every province outside the heartlands that is
    /// open at bell 287 or opens later, its holder at the later of its
    /// opening bell and bell 287 against its holder at `end_bell − 1`, both
    /// faction-controlled (see [`net_movement_open`]).
    pub net_movement_open: f64,
    pub breadth: f64,
    pub largest_share: f64,
    pub smallest_share: f64,
    pub sieges_declared: f64,
    pub sieges_completed: f64,
    pub sieges_failed: f64,
    pub occupations: f64,
    pub liberations: f64,
    pub captures: f64,
    pub outposts: f64,
    pub d9_transfers: f64,
    // the 28-day gate and reported figures
    pub banner_changes_per_day: f64,
    pub days_without_banner_change: f64,
    pub keep_taken_per_day: f64,
    pub retaken_3d: f64,
    pub provinces_ever_changed: f64,
    pub f0_share_q1: f64,
    pub f0_share_end: f64,
    pub departs_per_bot_day: f64,
    pub keep_marches_per_bot_day: f64,
    pub keep_captures_per_bot_day: f64,
    pub declares_per_bot_day: f64,
    pub departs_per_agent_day: f64,
    pub homes_released: f64,
    pub homes_released_casual: f64,
    pub credited: f64,
    pub uncredited: f64,
    pub fc_captures: f64,
    pub keep_contests: f64,
    pub keep_broken: f64,
    pub clash_errors: f64,
    pub lab: crate::conquest::Summary,
}

/// Shares of faction-controlled provinces in `ctl` (largest, smallest,
/// faction 0).
fn shares(ctl: &[u8]) -> (f64, f64, f64) {
    let mut by = [0u32; 6];
    for &c in ctl {
        if (c as usize) < 6 {
            by[c as usize] += 1;
        }
    }
    let tot: u32 = by.iter().sum();
    if tot == 0 {
        return (0.0, 0.0, 0.0);
    }
    let s = |x: u32| x as f64 / tot as f64;
    (
        s(*by.iter().max().unwrap()),
        s(*by.iter().min().unwrap()),
        s(by[0]),
    )
}

#[allow(clippy::needless_range_loop)]
pub fn metrics(sim: &Sim) -> Metrics {
    let s = Series::from_sim(sim);
    let st = &sim.mcs.st;
    let end = s.end_bell;
    let last = end.saturating_sub(1);
    let days = s.days.max(1);
    let lasting = s.lasting_changes(LASTING_BELLS);
    // 10b: game days 2..=D (day d covers bells 144(d−1) … 144d − 1).
    let mut day_has = vec![false; days as usize + 1];
    for &(b, _, _, _) in &lasting {
        let d = (b / BELLS_PER_DAY + 1) as usize;
        if d < day_has.len() {
            day_has[d] = true;
        }
    }
    let days_with_change = (2..=days as usize).filter(|&d| day_has[d]).count() as f64;
    // Populations P (opened by bell 144) and P₂ (by 288), rings > the
    // heartland ring (outside every heartland).
    let in_p = |i: usize, by: u32| {
        s.provs[i]
            .as_ref()
            .is_some_and(|p| p.ring > s.heartland_max_ring && p.opened <= by)
    };
    // 10c: distinct faction controllers during the season.
    let mut ctls: Vec<u8> = vec![0; s.provs.len()];
    for (i, p) in s.provs.iter().enumerate() {
        if let Some(p) = p {
            if (p.initial as usize) < 6 {
                ctls[i] |= 1 << p.initial;
            }
        }
    }
    for &(b, p, _, to) in &s.events {
        if b <= last && (to as usize) < 6 {
            ctls[p as usize] |= 1 << to;
        }
    }
    let (mut pn, mut p2) = (0u32, 0u32);
    for i in 0..s.provs.len() {
        if in_p(i, BELLS_PER_DAY) {
            pn += 1;
            if ctls[i].count_ones() >= 2 {
                p2 += 1;
            }
        }
    }
    let two_controllers = p2 as f64 / pn.max(1) as f64;
    // 10d: March banners through the season.
    let (banner_changes, two_banners, per_day) = banners(&s);
    let days_without_banner_change = {
        let from = 3.min(days);
        let n = (from..=days).count() as f64;
        (from..=days)
            .filter(|&d| per_day.get(d as usize).copied().unwrap_or(0) == 0)
            .count() as f64
            / n.max(1.0)
    };
    // 10e: control at end − 1 vs bell 287 over P₂ (provinces a faction
    // controls at both bells: a first claim of empty land is not movement;
    // with keeps every province is controlled at both).
    let a = s.control_at(2 * BELLS_PER_DAY - 1);
    let z = s.control_at(last);
    let (mut n2, mut moved) = (0u32, 0u32);
    for i in 0..s.provs.len() {
        if in_p(i, 2 * BELLS_PER_DAY) && a[i] < 6 && z[i] < 6 {
            n2 += 1;
            if a[i] != z[i] {
                moved += 1;
            }
        }
    }
    let net_movement = moved as f64 / n2.max(1) as f64;
    let net_movement_open = net_movement_open(&s);
    // 10f: factions with a lasting gain and a lasting loss.
    let (mut gain, mut loss) = ([false; 6], [false; 6]);
    for &(_, _, from, to) in &lasting {
        loss[from as usize] = true;
        gain[to as usize] = true;
    }
    let breadth = (0..6).filter(|&f| gain[f] && loss[f]).count() as f64;
    // 10g: balance at end − 1.
    let (largest_share, smallest_share, f0_end) = shares(&z);
    let q1 = s.control_at(end / 4);
    let (_, _, f0_q1) = shares(&q1);
    // Ping-pong: a taking that hands a province back to the faction that
    // lost it less than 3 days before.
    let (mut takes, mut back) = (0u32, 0u32);
    for (_, ev) in s.by_prov() {
        for i in 0..ev.len() {
            let (b, from, to) = ev[i];
            if from >= 6 || to >= 6 {
                continue;
            }
            takes += 1;
            if i > 0 {
                let (b0, f0, _) = ev[i - 1];
                if f0 == to && b - b0 < 3 * BELLS_PER_DAY {
                    back += 1;
                }
            }
        }
    }
    let ever = ctls.iter().filter(|m| m.count_ones() >= 2).count() as f64;
    let opened = s.provs.iter().flatten().count() as f64;
    // Activity per bot-day (§8.7 item 7).
    let bots = sim
        .agents
        .iter()
        .filter(|a| a.arch == Arch::Bot && a.state == crate::sim::JoinState::Settled)
        .count() as f64;
    let agents = sim
        .agents
        .iter()
        .filter(|a| a.state == crate::sim::JoinState::Settled)
        .count() as f64;
    let bd = (bots * days as f64).max(1.0);
    let bi = Arch::Bot.idx();
    Metrics {
        seed: sim.cfg.seed,
        lasting: lasting.len() as f64,
        days_with_change,
        two_controllers,
        banner_changes,
        marches_two_banners: two_banners,
        net_movement,
        net_movement_open,
        breadth,
        largest_share,
        smallest_share,
        // The season counters (both rule sets write them; M1's holdings 2–3
        // are not outposts, so M1 reports its second holdings there).
        sieges_declared: sim.stats.sieges_declared as f64,
        sieges_completed: sim.stats.sieges_completed as f64,
        sieges_failed: sim.stats.sieges_failed as f64,
        occupations: sim.stats.occupations as f64,
        liberations: sim.stats.liberations as f64,
        captures: (sim.stats.captures + sim.stats.free_city_captures) as f64,
        outposts: sim.stats.second_holdings as f64,
        d9_transfers: st.d9_transfers as f64,
        banner_changes_per_day: banner_changes / days as f64,
        days_without_banner_change,
        keep_taken_per_day: st.keep_taken as f64 / days as f64,
        retaken_3d: back as f64 / takes.max(1) as f64,
        provinces_ever_changed: ever / opened.max(1.0),
        f0_share_q1: f0_q1,
        f0_share_end: f0_end,
        departs_per_bot_day: st.departs[bi] as f64 / bd,
        keep_marches_per_bot_day: st.keep_marches[bi] as f64 / bd,
        keep_captures_per_bot_day: st.keep_taken_by[bi] as f64 / bd,
        declares_per_bot_day: st.declares[bi] as f64 / bd,
        departs_per_agent_day: st.departs.iter().sum::<u64>() as f64
            / (agents * days as f64).max(1.0),
        homes_released: st.homes_released.iter().sum::<u64>() as f64,
        homes_released_casual: st.homes_released[Arch::Casual.idx()] as f64,
        credited: st.credited as f64,
        uncredited: st.uncredited as f64,
        fc_captures: st.fc_captures as f64,
        keep_contests: st.keep_contests as f64,
        keep_broken: st.keep_broken as f64,
        clash_errors: sim.stats.clash_errors as f64,
        lab: crate::conquest::summarise(&sim.cq),
    }
}

/// 10e′ (W1-close, PO-1 (b), CQH1(1)): the share of the provinces outside
/// the heartlands that are open at bell 287 or open later (by
/// `end_bell − 1`) whose holder at `end_bell − 1` differs from their holder
/// at the later of their opening bell and bell 287. A province counts only
/// when a faction holds it at both bells (a first claim of empty land is
/// not movement; with keeps every opened province has a holder).
pub fn net_movement_open(s: &Series) -> f64 {
    let last = s.end_bell.saturating_sub(1);
    let day2 = 2 * BELLS_PER_DAY - 1;
    let by = s.by_prov();
    let none: Vec<(u32, u8, u8)> = Vec::new();
    let (mut n, mut moved) = (0u32, 0u32);
    for (i, p) in s.provs.iter().enumerate() {
        let Some(p) = p else { continue };
        if p.ring <= s.heartland_max_ring || p.opened > last {
            continue;
        }
        let r = p.opened.max(day2);
        let ev = by.get(&(i as u32)).unwrap_or(&none);
        let holder_at = |at: u32| {
            let mut c = p.initial;
            for &(b, _, to) in ev {
                if b > at {
                    break;
                }
                c = to;
            }
            c
        };
        let (a, z) = (holder_at(r), holder_at(last));
        if a < 6 && z < 6 {
            n += 1;
            if a != z {
                moved += 1;
            }
        }
    }
    moved as f64 / n.max(1) as f64
}

/// Banner changes (faction → another faction through any contested
/// interval), the share of Marches with ≥ 2 faction banners, and banner
/// changes per game day (index = game day, 1-based).
fn banners(s: &Series) -> (f64, f64, Vec<u32>) {
    let nm = s.n_marches;
    let mut members: Vec<Vec<usize>> = vec![Vec::new(); nm];
    for (i, p) in s.provs.iter().enumerate() {
        if let Some(p) = p {
            members[p.march as usize].push(i);
        }
    }
    // Change points: openings and events, in bell order.
    let mut points: Vec<(u32, u32)> = Vec::new(); // (bell, province)
    for (i, p) in s.provs.iter().enumerate() {
        if let Some(p) = p {
            points.push((p.opened, i as u32));
        }
    }
    for &(b, p, _, _) in &s.events {
        points.push((b, p));
    }
    points.sort_unstable();
    let last = s.end_bell.saturating_sub(1);
    let mut ctl: Vec<u8> = vec![NO_FACTION; s.provs.len()];
    let mut open: Vec<bool> = vec![false; s.provs.len()];
    let mut last_banner: Vec<u8> = vec![NO_FACTION; nm];
    let mut seen: Vec<u8> = vec![0; nm];
    let mut changes = 0u32;
    let mut per_day = vec![0u32; s.days as usize + 2];
    let mut ev = s.events.iter().peekable();
    let mut i = 0;
    while i < points.len() {
        let b = points[i].0;
        if b > last {
            break;
        }
        let mut touched: Vec<usize> = Vec::new();
        while i < points.len() && points[i].0 == b {
            let p = points[i].1 as usize;
            if !open[p] {
                if let Some(pi) = &s.provs[p] {
                    if pi.opened <= b {
                        open[p] = true;
                        ctl[p] = pi.initial;
                    }
                }
            }
            touched.push(s.provs[p].as_ref().map_or(0, |x| x.march as usize));
            i += 1;
        }
        while let Some(&&(eb, p, _, to)) = ev.peek() {
            if eb != b {
                break;
            }
            ctl[p as usize] = to;
            ev.next();
        }
        touched.sort_unstable();
        touched.dedup();
        for m in touched {
            let v: Vec<u8> = members[m]
                .iter()
                .filter(|&&p| open[p])
                .map(|&p| ctl[p])
                .collect();
            if let Some(bf) = cqk::march_banner(&v) {
                if last_banner[m] != NO_FACTION && last_banner[m] != bf {
                    changes += 1;
                    let d = (b / BELLS_PER_DAY + 1) as usize;
                    if d < per_day.len() {
                        per_day[d] += 1;
                    }
                }
                last_banner[m] = bf;
                seen[m] |= 1 << bf;
            }
        }
    }
    let with = (0..nm)
        .filter(|&m| members[m].iter().any(|&p| open[p]))
        .count();
    let two = seen.iter().filter(|x| x.count_ones() >= 2).count();
    (changes as f64, two as f64 / with.max(1) as f64, per_day)
}

// ------------------------------------------------------------ thresholds

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Dir {
    /// The figure must be at least the floor.
    Min,
    /// The figure must be at most the floor.
    Max,
}

/// A gated figure: name, direction, floor, whether the "p10 ≥ 2 × floor"
/// rule of Gate CQ1 applies, and its getter.
pub struct Gated {
    pub name: &'static str,
    pub dir: Dir,
    pub floor: f64,
    pub doubling: bool,
    pub get: fn(&Metrics) -> f64,
}

/// Criterion 10's floors (§13.4, v1.1 R-25, amended at the W1-close: PO-1
/// (b), CQH1(1)) for a `days`-day season: 10a 45 (was 60), 10c 13% (was
/// 15%), 10e′ 6% replaces 10e's 10% (10e is reported), occupations 10 (was
/// 3), liberations 1; the "p10 ≥ 2 × floor" rule (`doubling`) is kept for
/// every map figure and 10h count.
pub fn floors_c10(days: u32) -> Vec<Gated> {
    let d = (days.max(2) - 1) as f64;
    let g = |name, dir, floor, doubling, get| Gated {
        name,
        dir,
        floor,
        doubling,
        get,
    };
    vec![
        g("10a_lasting_changes", Dir::Min, 45.0, true, |m| m.lasting),
        g("10b_days_with_change", Dir::Min, d, false, |m| {
            m.days_with_change
        }),
        g("10c_share_two_controllers", Dir::Min, 0.13, true, |m| {
            m.two_controllers
        }),
        g("10d_banner_changes", Dir::Min, 6.0, true, |m| {
            m.banner_changes
        }),
        g("10d_marches_two_banners", Dir::Min, 0.10, true, |m| {
            m.marches_two_banners
        }),
        g("10e_net_movement_open", Dir::Min, 0.06, true, |m| {
            m.net_movement_open
        }),
        g("10f_breadth", Dir::Min, 4.0, false, |m| m.breadth),
        g("10g_largest_share", Dir::Max, 0.30, false, |m| {
            m.largest_share
        }),
        g("10g_smallest_share", Dir::Min, 0.08, false, |m| {
            m.smallest_share
        }),
        g("10h_sieges_declared", Dir::Min, 20.0, true, |m| {
            m.sieges_declared
        }),
        g("10h_sieges_completed", Dir::Min, 10.0, true, |m| {
            m.sieges_completed
        }),
        g("10h_sieges_failed", Dir::Min, 3.0, true, |m| {
            m.sieges_failed
        }),
        g("10h_occupations", Dir::Min, 10.0, true, |m| m.occupations),
        g("10h_liberations", Dir::Min, 1.0, true, |m| m.liberations),
        g("10h_captures", Dir::Min, 5.0, true, |m| m.captures),
        g("10h_outposts", Dir::Min, 10.0, true, |m| m.outposts),
        g("10i_d9_transfers", Dir::Max, 0.0, false, |m| m.d9_transfers),
    ]
}

/// The 10k / 28-day gate (§8.7 item 4, balance lab §8; W1-close PO-3,
/// CQH1(3): banner changes ≥ 3.5 a day (was 5) and Marches with ≥ 2
/// banners ≥ 10% (was 15%); the shares and the days without a change are
/// unchanged).
pub fn floors_28d() -> Vec<Gated> {
    let g = |name, dir, floor, get| Gated {
        name,
        dir,
        floor,
        doubling: false,
        get,
    };
    vec![
        g("banner_changes_per_day", Dir::Min, 3.5, |m: &Metrics| {
            m.banner_changes_per_day
        }),
        g("marches_two_banners", Dir::Min, 0.10, |m: &Metrics| {
            m.marches_two_banners
        }),
        g("largest_share", Dir::Max, 0.22, |m: &Metrics| {
            m.largest_share
        }),
        g("smallest_share", Dir::Min, 0.12, |m: &Metrics| {
            m.smallest_share
        }),
        g(
            "days_without_banner_change",
            Dir::Max,
            0.30,
            |m: &Metrics| m.days_without_banner_change,
        ),
    ]
}

/// Reported figures (not gated) carried in the files.
/// A reported figure: its name and getter.
pub type Figure = (&'static str, fn(&Metrics) -> f64);

pub fn reported() -> Vec<Figure> {
    vec![
        // Contract v1.2's 10e (P₂ only), reported since the W1-close.
        ("net_movement_p2", |m| m.net_movement),
        ("banner_changes_per_day", |m| m.banner_changes_per_day),
        ("days_without_banner_change", |m| {
            m.days_without_banner_change
        }),
        ("keep_taken_per_day", |m| m.keep_taken_per_day),
        ("retaken_within_3d", |m| m.retaken_3d),
        ("provinces_ever_changed", |m| m.provinces_ever_changed),
        ("faction0_share_q1", |m| m.f0_share_q1),
        ("faction0_share_end", |m| m.f0_share_end),
        ("departs_per_bot_day", |m| m.departs_per_bot_day),
        ("keep_marches_per_bot_day", |m| m.keep_marches_per_bot_day),
        ("keep_captures_per_bot_day", |m| m.keep_captures_per_bot_day),
        ("declares_per_bot_day", |m| m.declares_per_bot_day),
        ("departs_per_agent_day", |m| m.departs_per_agent_day),
        ("homes_released", |m| m.homes_released),
        ("homes_released_casual", |m| m.homes_released_casual),
        ("captures_credited", |m| m.credited),
        ("captures_uncredited", |m| m.uncredited),
        ("free_city_captures", |m| m.fc_captures),
        ("keep_contests", |m| m.keep_contests),
        ("keep_contests_broken", |m| m.keep_broken),
        ("clash_errors", |m| m.clash_errors),
        ("lab_march_changes_per_day", |m| m.lab.changes_pd),
        ("lab_marches_ever_changed", |m| m.lab.changed_hands),
        ("lab_province_flips_per_day", |m| m.lab.pflips_pd),
        ("lab_provinces_ever_changed", |m| m.lab.pchanged_hands),
        ("lab_days_without_march_flip", |m| m.lab.zero_flip_days),
        ("lab_max_province_share_end", |m| m.lab.pmax_end),
        ("lab_min_province_share_end", |m| m.lab.pmin_end),
        ("lab_holding_captures_occupations_per_day", |m| {
            m.lab.captures_pd + m.lab.occupations_pd
        }),
    ]
}

/// Linear-interpolation percentile (numpy's default) of `v`.
pub fn pct(v: &[f64], q: f64) -> f64 {
    if v.is_empty() {
        return f64::NAN;
    }
    let mut s = v.to_vec();
    s.sort_by(|a, b| a.total_cmp(b));
    let x = (s.len() - 1) as f64 * q;
    let lo = x.floor() as usize;
    let hi = x.ceil() as usize;
    s[lo] + (s[hi] - s[lo]) * (x - lo as f64)
}

/// Round to 6 decimals (the files' precision; `--check` compares these).
pub fn r6(x: f64) -> f64 {
    (x * 1e6).round() / 1e6
}

/// Play `seeds` seasons (`first_seed + 1 ..= first_seed + seeds`).
pub fn run(base: &Config, seeds: u64, first_seed: u64) -> Vec<Metrics> {
    let jobs: Vec<Config> = (1..=seeds)
        .map(|k| Config {
            seed: first_seed + k,
            verbose: false,
            ..base.clone()
        })
        .collect();
    let n = jobs.len();
    let threads = base.threads(n);
    let next = AtomicUsize::new(0);
    let slots: Vec<Mutex<Option<Metrics>>> = (0..n).map(|_| Mutex::new(None)).collect();
    std::thread::scope(|sc| {
        for _ in 0..threads {
            sc.spawn(|| loop {
                let i = next.fetch_add(1, Ordering::SeqCst);
                if i >= n {
                    break;
                }
                let (sim, o) = crate::suite::play(&jobs[i]);
                assert!(o.checks.iter().all(|c| c.ok), "conservation failed");
                if std::env::var("FRONTIER_SIM_DEBUG").is_ok() {
                    eprintln!(
                        "seed {} dbg {:?} refusals {:?}",
                        jobs[i].seed,
                        sim.mcs.st.dbg,
                        crate::sim::mcsim::REFUSAL_NAMES
                            .iter()
                            .zip(sim.mcs.st.refusals)
                            .collect::<Vec<_>>()
                    );
                }
                *slots[i].lock().unwrap() = Some(metrics(&sim));
            });
        }
    });
    slots
        .into_iter()
        .map(|m| m.into_inner().unwrap().expect("season"))
        .collect()
}

/// The run's parameters as written into the files.
pub fn describe(cfg: &Config, seeds: u64, first_seed: u64) -> Vec<(&'static str, String)> {
    let pol: Vec<&str> = cfg
        .policy
        .iter()
        .map(|p| match p {
            crate::mc::Policy::Lone => "lone",
            crate::mc::Policy::Campaign => "campaign",
        })
        .collect();
    let mut rules = cfg.rules.name().to_string();
    if cfg.bannerdom > 0 {
        write!(rules, ",bannerdom={}", cfg.bannerdom).unwrap();
    }
    if cfg.keepdom {
        rules.push_str(",keepdom");
    }
    let mut forward = cfg.forward.to_string();
    if cfg.keep_stay {
        // Only a --keep-stay run names it, so the committed files' run
        // keys stay as they are and a --keep-stay run drifts against them.
        forward.push_str(",keep_stay");
    }
    vec![
        ("rules", rules),
        (
            "preset",
            if cfg.rules.mc() {
                cfg.mc.preset.to_string()
            } else {
                "-".into()
            },
        ),
        ("policy", pol.join(",")),
        ("bot_profile", cfg.bot_profile.name().to_string()),
        ("agents", cfg.agents.to_string()),
        ("bots", format!("{}", cfg.bot_share)),
        ("days", cfg.days.to_string()),
        ("keep_aggr", format!("{}", cfg.cq.keep_aggr)),
        ("forward", forward),
        (
            "sizes",
            cfg.faction_weights
                .iter()
                .map(|x| x.to_string())
                .collect::<Vec<_>>()
                .join(","),
        ),
        ("seeds", seeds.to_string()),
        ("first_seed", (first_seed + 1).to_string()),
        (
            "kernels",
            format!(
                "keep v{} control v{} (permutation-rules, CQ1-A kernels)",
                crate::mc::cqk::KEEP_VERSION,
                crate::mc::cqk::CONTROL_VERSION
            ),
        ),
    ]
}

/// The JSON file of a run (`--json`; the thresholds files are exactly
/// this for their defining runs): parameters, floors, per-seed figures and
/// p10 / p50 / p90 of every figure.
pub fn to_json(
    cfg: &Config,
    seeds: u64,
    first_seed: u64,
    ms: &[Metrics],
    gate: &[Gated],
    note: &str,
) -> String {
    let mut s = String::new();
    s.push_str("{\n  \"format\": \"frontier-sim mapmove v1\",\n");
    writeln!(s, "  \"note\": {:?},", note).unwrap();
    s.push_str("  \"run\": {");
    let d = describe(cfg, seeds, first_seed);
    for (i, (k, v)) in d.iter().enumerate() {
        write!(s, "{}\"{k}\": {:?}", if i == 0 { "" } else { ", " }, v).unwrap();
    }
    s.push_str("},\n  \"gated\": {\n");
    for (i, g) in gate.iter().enumerate() {
        let v: Vec<f64> = ms.iter().map(g.get).collect();
        writeln!(
            s,
            "    \"{}\": {{\"dir\": \"{}\", \"floor\": {}, \"doubling\": {}, \"p10\": {}, \"p50\": {}, \"p90\": {}, \"half_p10\": {}, \"seeds\": [{}]}}{}",
            g.name,
            if g.dir == Dir::Min { "min" } else { "max" },
            g.floor,
            g.doubling,
            r6(pct(&v, 0.1)),
            r6(pct(&v, 0.5)),
            r6(pct(&v, 0.9)),
            if g.dir == Dir::Min {
                format!("{}", r6(pct(&v, 0.1) / 2.0))
            } else {
                "null".to_string()
            },
            v.iter().map(|x| format!("{}", r6(*x))).collect::<Vec<_>>().join(", "),
            if i + 1 == gate.len() { "" } else { "," }
        )
        .unwrap();
    }
    s.push_str("  },\n  \"reported\": {\n");
    let rep = reported();
    for (i, (name, get)) in rep.iter().enumerate() {
        let v: Vec<f64> = ms.iter().map(get).collect();
        writeln!(
            s,
            "    \"{}\": {{\"p10\": {}, \"p50\": {}, \"p90\": {}, \"mean\": {}}}{}",
            name,
            r6(pct(&v, 0.1)),
            r6(pct(&v, 0.5)),
            r6(pct(&v, 0.9)),
            r6(v.iter().sum::<f64>() / v.len().max(1) as f64),
            if i + 1 == rep.len() { "" } else { "," }
        )
        .unwrap();
    }
    s.push_str("  }\n}\n");
    s
}

/// Markdown: one row per seed and the p10 / p50 / p90 rows.
pub fn table(ms: &[Metrics], gate: &[Gated]) -> String {
    let mut s = String::new();
    write!(s, "| seed |").unwrap();
    for g in gate {
        write!(s, " {} |", g.name).unwrap();
    }
    s.push('\n');
    writeln!(s, "|{}", "---|".repeat(gate.len() + 1)).unwrap();
    for m in ms {
        write!(s, "| {} |", m.seed).unwrap();
        for g in gate {
            write!(s, " {} |", fmt((g.get)(m))).unwrap();
        }
        s.push('\n');
    }
    for (label, q) in [("p10", 0.1), ("p50", 0.5), ("p90", 0.9)] {
        write!(s, "| **{label}** |").unwrap();
        for g in gate {
            let v: Vec<f64> = ms.iter().map(g.get).collect();
            write!(s, " {} |", fmt(pct(&v, q))).unwrap();
        }
        s.push('\n');
    }
    write!(s, "| floor |").unwrap();
    for g in gate {
        write!(
            s,
            " {}{} |",
            if g.dir == Dir::Min { "≥ " } else { "≤ " },
            fmt(g.floor)
        )
        .unwrap();
    }
    s.push('\n');
    s
}

/// Markdown of the reported figures (p10 / p50 / p90 and the mean).
pub fn reported_table(ms: &[Metrics]) -> String {
    let mut s = String::from("| figure | p10 | p50 | p90 | mean |\n|---|---|---|---|---|\n");
    for (name, get) in reported() {
        let v: Vec<f64> = ms.iter().map(get).collect();
        writeln!(
            s,
            "| {name} | {} | {} | {} | {} |",
            fmt(pct(&v, 0.1)),
            fmt(pct(&v, 0.5)),
            fmt(pct(&v, 0.9)),
            fmt(v.iter().sum::<f64>() / v.len().max(1) as f64)
        )
        .unwrap();
    }
    s
}

pub fn fmt(x: f64) -> String {
    if x.is_nan() {
        "n.a.".into()
    } else if x != 0.0 && x.abs() < 1.0 {
        format!("{x:.3}")
    } else if x.fract() == 0.0 {
        format!("{x:.0}")
    } else {
        format!("{x:.2}")
    }
}

/// Seeds on which every gated figure meets its floor, per figure.
pub fn passes(ms: &[Metrics], gate: &[Gated]) -> Vec<(&'static str, usize)> {
    gate.iter()
        .map(|g| {
            let ok = ms
                .iter()
                .filter(|m| {
                    let v = (g.get)(m);
                    match g.dir {
                        Dir::Min => v >= g.floor,
                        Dir::Max => v <= g.floor,
                    }
                })
                .count();
            (g.name, ok)
        })
        .collect()
}

/// `mapmove-gate`'s verdict: every figure meets its floor on ≥ 4 of 5
/// seeds (⌈0.8 × seeds⌉ in general).
pub fn gate_verdict(ms: &[Metrics], gate: &[Gated]) -> (bool, String) {
    let need = (ms.len() * 4).div_ceil(5);
    let mut s = String::new();
    let mut ok = true;
    for (name, n) in passes(ms, gate) {
        let pass = n >= need;
        ok &= pass;
        writeln!(
            s,
            "- {name}: {n}/{} seeds {}",
            ms.len(),
            if pass { "PASS" } else { "FAIL" }
        )
        .unwrap();
    }
    (ok, s)
}

// ------------------------------------------------------------ a tiny JSON reader

/// Read `gated.<name>.<field>` / `reported.<name>.<field>` / `run.<key>`
/// from a file this module wrote.
pub fn json_get(text: &str, path: &[&str]) -> Option<String> {
    let mut rest = text;
    for (i, key) in path.iter().enumerate() {
        let pat = format!("\"{key}\":");
        let at = rest.find(&pat)?;
        rest = &rest[at + pat.len()..];
        if i + 1 == path.len() {
            let r = rest.trim_start();
            if let Some(stripped) = r.strip_prefix('"') {
                let end = stripped.find('"')?;
                return Some(stripped[..end].to_string());
            }
            let end = r.find([',', '}', '\n']).unwrap_or(r.len());
            return Some(r[..end].trim().to_string());
        }
    }
    None
}

pub fn json_num(text: &str, path: &[&str]) -> Option<f64> {
    json_get(text, path)?.parse().ok()
}

/// The bot-activity rates §8.8 takes as the stack's reference: `--check`
/// compares their p50 too (integ-W1, review CQ1-B), so a planner change
/// cannot move the reference silently.
pub const CHECKED_RATES: [&str; 4] = [
    "departs_per_bot_day",
    "keep_marches_per_bot_day",
    "keep_captures_per_bot_day",
    "declares_per_bot_day",
];

/// The thresholds file's `note`: the cadence assumption of the bot
/// profile the rates were measured with (§8.7 item 7, §8.8; a CQ2-F and
/// CQ3-B hand-off).
pub fn cadence_note(cfg: &Config) -> &'static str {
    match cfg.bot_profile {
        BotProfile::Cq => "bot profile cq: military decisions (keep strikes, holding sieges, rallies) once per bot per hourly planner epoch; economy, defence sends and outposts at M1's session cadence (24 sessions a day), so departs_per_bot_day includes session-cadence defence sends and 10h outposts is a session-cadence figure",
        BotProfile::M1 => "bot profile m1: campaign plan plus M1-rate lone rolls (calibrated to M1's measured Departs per bot-day); economy, defence and outposts at M1's session cadence",
        BotProfile::Sim => "bot profile sim: the simulator's bot archetype (24 sessions a day, a keep roll per session), every decision at session cadence",
    }
}

/// `--check FILE`: the run's parameters and every p10 / p50 / p90 must
/// equal the file's (the simulator is deterministic), and so must the p50
/// of [`CHECKED_RATES`] when the file carries them. Returns the drifts.
pub fn check(
    text: &str,
    cfg: &Config,
    seeds: u64,
    first_seed: u64,
    ms: &[Metrics],
    gate: &[Gated],
) -> Vec<String> {
    let mut bad = Vec::new();
    for (k, v) in describe(cfg, seeds, first_seed) {
        match json_get(text, &["run", k]) {
            Some(x) if x == v => {}
            x => bad.push(format!("run.{k}: file {x:?}, run {v:?}")),
        }
    }
    for g in gate {
        let v: Vec<f64> = ms.iter().map(g.get).collect();
        for (q, name) in [(0.1, "p10"), (0.5, "p50"), (0.9, "p90")] {
            let got = r6(pct(&v, q));
            match json_num(text, &["gated", g.name, name]) {
                Some(x) if (x - got).abs() <= 1e-9 => {}
                x => bad.push(format!("gated.{}.{name}: file {x:?}, run {got}", g.name)),
            }
        }
    }
    for (name, get) in reported() {
        if !CHECKED_RATES.contains(&name) {
            continue;
        }
        let Some(x) = json_num(text, &["reported", name, "p50"]) else {
            continue;
        };
        let v: Vec<f64> = ms.iter().map(get).collect();
        let got = r6(pct(&v, 0.5));
        if (x - got).abs() > 1e-9 {
            bad.push(format!("reported.{name}.p50: file {x}, run {got}"));
        }
    }
    bad
}

#[cfg(test)]
mod tests {
    use super::*;

    fn series(events: Vec<(u32, u32, u8, u8)>) -> Series {
        Series {
            end_bell: 1_008,
            days: 7,
            heartland_max_ring: 3,
            provs: vec![
                Some(ProvInfo {
                    ring: 4,
                    march: 0,
                    opened: 0,
                    initial: 0,
                }),
                Some(ProvInfo {
                    ring: 4,
                    march: 0,
                    opened: 0,
                    initial: 1,
                }),
                Some(ProvInfo {
                    ring: 4,
                    march: 0,
                    opened: 0,
                    initial: 1,
                }),
            ],
            n_marches: 1,
            events,
        }
    }

    #[test]
    fn cq_lasting_changes_drop_flicker_and_neutral() {
        let s = series(vec![
            (10, 0, 0, 2),    // reverts at 13: flicker
            (13, 0, 2, 0),    // lasts
            (500, 1, 1, 6),   // to neutral: not a faction change
            (1_005, 2, 1, 3), // lasts to end − 1
        ]);
        let l = s.lasting_changes(LASTING_BELLS);
        assert_eq!(l, vec![(13, 0, 2, 0), (1_005, 2, 1, 3)]);
    }

    #[test]
    fn cq_banner_changes_through_contested() {
        // March of 3: banner 1 (two of three); 0 takes one → banner 0;
        // later moves keep banner 0.
        let s = series(vec![(100, 1, 1, 0), (200, 2, 1, 2), (300, 2, 2, 0)]);
        let (changes, two, per_day) = banners(&s);
        assert_eq!(changes, 1.0);
        assert_eq!(two, 1.0);
        assert_eq!(per_day.iter().sum::<u32>(), 1);
    }

    #[test]
    fn cq_net_movement_open_counts_late_provinces() {
        let mut s = series(vec![
            (100, 0, 0, 2), // before bell 287: not movement
            (400, 1, 1, 0), // a P₂ province moves after 287
            (700, 3, 4, 5), // a late province (opened 600) moves
            (900, 4, 6, 3), // unclaimed late land claimed: not counted
        ]);
        s.provs.push(Some(ProvInfo {
            ring: 8,
            march: 0,
            opened: 600,
            initial: 4,
        }));
        s.provs.push(Some(ProvInfo {
            ring: 8,
            march: 0,
            opened: 800,
            initial: NO_FACTION,
        }));
        s.provs.push(Some(ProvInfo {
            ring: 2, // a heartland ring: never counted
            march: 0,
            opened: 0,
            initial: 1,
        }));
        s.provs.push(Some(ProvInfo {
            ring: 9, // opens at end_bell: not counted
            march: 0,
            opened: 1_008,
            initial: 2,
        }));
        // Provinces 0, 1, 2 (P₂) and 3 (late) count; 1 and 3 moved.
        assert!((net_movement_open(&s) - 0.5).abs() < 1e-12);
    }

    #[test]
    fn cq_w1_close_floors() {
        let f = |g: &[Gated], n: &str| {
            g.iter()
                .find(|x| x.name == n)
                .map(|x| (x.floor, x.doubling))
        };
        let c = floors_c10(7);
        assert_eq!(f(&c, "10a_lasting_changes"), Some((45.0, true)));
        assert_eq!(f(&c, "10c_share_two_controllers"), Some((0.13, true)));
        assert_eq!(f(&c, "10e_net_movement_open"), Some((0.06, true)));
        assert_eq!(f(&c, "10e_net_movement"), None);
        assert_eq!(f(&c, "10h_occupations"), Some((10.0, true)));
        assert_eq!(f(&c, "10h_liberations"), Some((1.0, true)));
        let d = floors_28d();
        assert_eq!(f(&d, "banner_changes_per_day"), Some((3.5, false)));
        assert_eq!(f(&d, "marches_two_banners"), Some((0.10, false)));
        assert_eq!(f(&d, "largest_share"), Some((0.22, false)));
        assert_eq!(f(&d, "smallest_share"), Some((0.12, false)));
        assert_eq!(f(&d, "days_without_banner_change"), Some((0.30, false)));
        assert!(reported().iter().any(|r| r.0 == "net_movement_p2"));
    }

    #[test]
    fn cq_percentiles_and_json_round_trip() {
        let v = [1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0, 9.0, 10.0];
        assert!((pct(&v, 0.1) - 1.9).abs() < 1e-12);
        assert!((pct(&v, 0.5) - 5.5).abs() < 1e-12);
        let t = "{\n  \"run\": {\"rules\": \"mc\", \"agents\": \"1000\"},\n  \"gated\": {\n    \"10a_lasting_changes\": {\"dir\": \"min\", \"floor\": 60, \"p10\": 1.9, \"p50\": 5.5}\n  }\n}\n";
        assert_eq!(json_get(t, &["run", "rules"]).as_deref(), Some("mc"));
        assert_eq!(
            json_num(t, &["gated", "10a_lasting_changes", "p10"]),
            Some(1.9)
        );
        assert_eq!(
            json_num(t, &["gated", "10a_lasting_changes", "floor"]),
            Some(60.0)
        );
    }
}
