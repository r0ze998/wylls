//! Conquest milestone (lab, sim-balance): rule and behaviour levers, a
//! day-end control layer (per March and per province) and the map-movement
//! summary. A faction controls a March (province) when it holds >= 50% of
//! the strength weight of the live holdings there (design §5.6); occupied
//! holdings count for the occupier only with `CqRules::occ_control`.

use std::fmt::Write;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;

use crate::config::Config;

#[derive(Clone, Debug)]
pub struct CqRules {
    /// An occupied holding's strength weight (control and Dominion) counts
    /// for the occupier's faction while the occupation lasts (D9 kept:
    /// the holding is not transferred).
    pub occ_control: bool,
    /// D9 relaxed: a completed siege of a first holding outside the
    /// heartland captures it (the owner re-founds with a refugee kit).
    pub first_capture: bool,
    /// Provinces around the attacker's strongest holding searched for a
    /// siege target (sim behaviour; the design has no range limit).
    pub radius: u32,
    /// Multiplier on every archetype's aggression (behaviour assumption).
    pub aggr_mult: f64,
    /// Extra bells every siege needs (`Siege::declare` extra).
    pub siege_extra: u32,
    /// Holdings 2-3 do not prefer the own wedge (salients form).
    pub expand_front: bool,
    /// Holdings 2-3 prefer free sites in Marches the own faction does not
    /// control (a "frontier pull" the Mandate menu can ask for).
    pub expand_contest: bool,
    /// Attackers prefer targets in Marches their faction does not control
    /// but could tip (control-aware target choice, as a Warden's Mandate
    /// or the war map would suggest).
    pub target_control: bool,
    /// Anti-snowball: a faction controlling more than this share of the
    /// controlled Marches (bps) cannot declare new sieges (None = off).
    pub cap_share_bps: Option<u32>,
    /// Anti-snowball: occupations by a faction above its homeland share
    /// pay the occupier no laurels (tribute only to the owner).
    pub stretch: bool,
    /// Lab fix of the M0 sim: a siege host is at least MIN_HOST_TROOPS
    /// (before, attacks on weak targets asked for < 100 troops and `send`
    /// refused them: 87% of the attacks that passed every check).
    pub launch_floor: bool,
    /// Siege rally: up to this many faction-mates' hosts join a siege
    /// (0 = off, the M0 single-attacker behaviour).
    pub rally: u32,
    /// K-model: every province has a keep (a faction-held fort on a
    /// non-site tile near the centre, owned by no wallet). The control
    /// layer is the keep map instead of holding weight.
    pub keeps: bool,
    /// Keeps outside the heartland start neutral (barbarian guard) instead
    /// of with the wedge's faction.
    pub keep_neutral: bool,
    /// Bells of uncontested holding to take a keep.
    pub keep_bells: u32,
    /// Share of the capturing host that stays as the keep's garrison (bps).
    pub keep_garrison_bps: u32,
    /// Garrison of a home keep / a neutral keep at opening (troops).
    pub keep_home_guard: i64,
    pub keep_neutral_guard: i64,
    /// Daily decay of a keep garrison with no holding of its faction within
    /// 3 provinces (bps kept per day; design supply rule 1%/bell = 2,355).
    pub keep_supply_bps: u32,
    /// Heartland keeps (rings 2-3 of the own wedge) cannot be besieged
    /// (no War in this milestone).
    pub keep_heartland_safe: bool,
    /// Dominion: each held captured keep credits its captor this many fact
    /// units per hour (0 = Dominion stays holding-weight only).
    pub keep_dom: u64,
    /// Behaviour: probability multiplier of a keep attempt per session.
    pub keep_aggr: f64,
    /// Keeps per March needed for March control: majority of open keeps.
    pub _reserved: u32,
    /// Bells after a keep changes hands during which it cannot be
    /// besieged (consolidation).
    pub keep_shield: u32,
    /// Stress test: faction `fav_faction` plays with aggression × fav_mult
    /// and decision quality + fav_q (a coordinated guild faction).
    pub fav_faction: u8,
    pub fav_mult: f64,
    pub fav_q: f64,
    /// Bells after a keep siege's horn before progress counts (lets the
    /// defenders' standing order arrive whatever the attacker's speed).
    pub keep_horn: u32,
}

impl Default for CqRules {
    fn default() -> Self {
        CqRules {
            occ_control: false,
            first_capture: false,
            radius: 2,
            aggr_mult: 1.0,
            siege_extra: 0,
            expand_front: false,
            expand_contest: false,
            target_control: false,
            cap_share_bps: None,
            stretch: false,
            launch_floor: false,
            rally: 0,
            keeps: false,
            keep_neutral: false,
            keep_bells: 36,
            keep_garrison_bps: 5_000,
            keep_home_guard: 300,
            keep_neutral_guard: 300,
            keep_supply_bps: 2_355,
            keep_heartland_safe: true,
            keep_dom: 0,
            keep_aggr: 1.0,
            _reserved: 0,
            keep_shield: 0,
            fav_faction: 0,
            fav_mult: 1.0,
            fav_q: 0.0,
            keep_horn: 0,
        }
    }
}

impl CqRules {
    /// Parse `key=value,...` (bools as 0/1).
    pub fn apply(&mut self, spec: &str) {
        for kv in spec.split(',').filter(|x| !x.is_empty()) {
            let (k, v) = kv.split_once('=').unwrap_or((kv, "1"));
            let b = v != "0";
            match k {
                "occ" => self.occ_control = b,
                "first" => self.first_capture = b,
                "radius" => self.radius = v.parse().expect("radius"),
                "aggr" => self.aggr_mult = v.parse().expect("aggr"),
                "extra" => self.siege_extra = v.parse().expect("extra"),
                "front" => self.expand_front = b,
                "contest" => self.expand_contest = b,
                "target" => self.target_control = b,
                "cap" => self.cap_share_bps = Some(v.parse().expect("cap")),
                "stretch" => self.stretch = b,
                "floor" => self.launch_floor = b,
                "rally" => self.rally = v.parse().expect("rally"),
                "keeps" => self.keeps = b,
                "kneutral" => self.keep_neutral = b,
                "kbells" => self.keep_bells = v.parse().expect("kbells"),
                "kgar" => self.keep_garrison_bps = v.parse().expect("kgar"),
                "khome" => self.keep_home_guard = v.parse().expect("khome"),
                "kguard" => self.keep_neutral_guard = v.parse().expect("kguard"),
                "ksupply" => self.keep_supply_bps = v.parse().expect("ksupply"),
                "khl" => self.keep_heartland_safe = b,
                "kdom" => self.keep_dom = v.parse().expect("kdom"),
                "kaggr" => self.keep_aggr = v.parse().expect("kaggr"),
                "kshield" => self.keep_shield = v.parse().expect("kshield"),
                "favf" => self.fav_faction = v.parse().expect("favf"),
                "favm" => self.fav_mult = v.parse().expect("favm"),
                "favq" => self.fav_q = v.parse().expect("favq"),
                "khorn" => self.keep_horn = v.parse().expect("khorn"),
                x => panic!("unknown --cq key {x}"),
            }
        }
    }
}

/// One day-end snapshot.
#[derive(Clone, Debug, Default)]
pub struct DayRow {
    pub day: u32,
    #[allow(dead_code)]
    pub marches_open: u32,
    pub controlled: u32,
    pub foreign: u32,
    pub by_faction: [u32; 6],
    pub home_by_faction: [u32; 6],
    pub pby_faction: [u32; 6],
    pub changes: u32,
    pub flips: u32,
    #[allow(dead_code)]
    pub provs_open: u32,
    pub pcontrolled: u32,
    pub pforeign: u32,
    pub pchanges: u32,
    pub pflips: u32,
    pub sieges: u64,
    pub completed: u64,
    pub occupations: u64,
    pub captures: u64,
    pub fc_captures: u64,
    pub liberations: u64,
    pub holdings: u32,
    pub foreign_holdings: u32,
    pub occupied_now: u32,
    pub keep_sieges: u64,
    pub keep_captures: u64,
    pub keep_failed: u64,
    pub neutral_keeps: u32,
}

#[derive(Clone, Debug, Default)]
pub struct Track {
    pub prev: Vec<u32>,
    pub ever: Vec<u8>,
    pub pprev: Vec<u32>,
    pub pever: Vec<u8>,
    pub rows: Vec<DayRow>,
    pub last: [u64; 6],
    /// Day-end controller of every March, by day (for the hand-off sample).
    pub series: Vec<Vec<u32>>,
    /// Day-end controller of every province (u8, 255 = none).
    pub pseries: Vec<Vec<u8>>,
    /// war() diagnostics: calls, no stake, no troops, no candidates, too
    /// strong, declared; candidate refusals: heartland, shielded, frontier,
    /// occupied/sieged, dormant first, full (3 holdings); FC cands, first
    /// cands, other cands.
    pub diag: [u64; 16],
    pub keep_sieges: u64,
    pub keep_captures: u64,
    pub keep_failed: u64,
    pub klast: [u64; 3],
    /// Keep captures by capturing faction and by losing faction.
    pub kcap_by: [u64; 7],
    pub klost_by: [u64; 7],
    /// Tenure of the holder a capture ended: < 6 h, < 1 d, < 3 d, < 7 d,
    /// longer; re-takes by the previous holder within a day; captures of
    /// neutral keeps.
    pub tenure: [u64; 5],
    pub flicker: u64,
    pub from_neutral: u64,
}

/// Season summary of map movement.
#[derive(Clone, Debug, Default)]
pub struct Summary {
    pub days: f64,
    pub marches_ctl_end: f64,
    pub changes_pd: f64,
    pub flips_pd: f64,
    pub changes_pd_per100: f64,
    pub changed_hands: f64,
    pub foreign_end: f64,
    pub pchanges_pd: f64,
    pub pflips_pd: f64,
    pub pchanged_hands: f64,
    pub pforeign_end: f64,
    pub captures_pd: f64,
    pub occupations_pd: f64,
    pub fc_pd: f64,
    pub sieges_pd: f64,
    pub lib_pd: f64,
    pub leader_end: f64,
    pub min_end: f64,
    pub leader_home_end: f64,
    pub min_home_end: f64,
    pub leader_gain: f64,
    pub zero_flip_days: f64,
    pub longest_zero: f64,
    pub leader_changes: f64,
    pub foreign_holdings_end: f64,
    pub occupied_end: f64,
    pub flips_last_week_pd: f64,
    pub keep_caps_pd: f64,
    pub keep_sieges_pd: f64,
    pub keep_fail_pd: f64,
    pub neutral_end: f64,
    pub tenure_short: f64,
    pub flicker_share: f64,
    /// Mean share of controlled provinces whose controller differs from
    /// 7 days before (net weekly movement).
    pub weekly_net: f64,
    /// Faction 0 (the stress-test faction): share of controlled Marches
    /// and of controlled provinces at the end; province share at Q1 and
    /// at mid-season; max province share of any faction at the end.
    pub f0_m_end: f64,
    pub f0_p_end: f64,
    pub f0_p_q1: f64,
    pub f0_p_mid: f64,
    pub pmax_end: f64,
    pub pmin_end: f64,
}

impl Summary {
    pub fn add(&mut self, o: &Summary) {
        macro_rules! acc { ($($f:ident),*) => { $( self.$f += o.$f; )* } }
        acc!(
            days,
            marches_ctl_end,
            changes_pd,
            flips_pd,
            changes_pd_per100,
            changed_hands,
            foreign_end,
            pchanges_pd,
            pflips_pd,
            pchanged_hands,
            pforeign_end,
            captures_pd,
            occupations_pd,
            fc_pd,
            sieges_pd,
            lib_pd,
            leader_end,
            min_end,
            leader_home_end,
            min_home_end,
            leader_gain,
            zero_flip_days,
            longest_zero,
            leader_changes,
            foreign_holdings_end,
            occupied_end,
            flips_last_week_pd,
            keep_caps_pd,
            keep_sieges_pd,
            keep_fail_pd,
            neutral_end,
            tenure_short,
            flicker_share,
            weekly_net,
            f0_m_end,
            f0_p_end,
            f0_p_q1,
            f0_p_mid,
            pmax_end,
            pmin_end
        );
    }
    pub fn scale(&mut self, k: f64) {
        macro_rules! sc { ($($f:ident),*) => { $( self.$f *= k; )* } }
        sc!(
            days,
            marches_ctl_end,
            changes_pd,
            flips_pd,
            changes_pd_per100,
            changed_hands,
            foreign_end,
            pchanges_pd,
            pflips_pd,
            pchanged_hands,
            pforeign_end,
            captures_pd,
            occupations_pd,
            fc_pd,
            sieges_pd,
            lib_pd,
            leader_end,
            min_end,
            leader_home_end,
            min_home_end,
            leader_gain,
            zero_flip_days,
            longest_zero,
            leader_changes,
            foreign_holdings_end,
            occupied_end,
            flips_last_week_pd,
            keep_caps_pd,
            keep_sieges_pd,
            keep_fail_pd,
            neutral_end,
            tenure_short,
            flicker_share,
            weekly_net,
            f0_m_end,
            f0_p_end,
            f0_p_q1,
            f0_p_mid,
            pmax_end,
            pmin_end
        );
    }
}

pub fn summarise(t: &Track) -> Summary {
    let rows = &t.rows;
    let n = rows.len().max(1);
    let last = rows.last().cloned().unwrap_or_default();
    let days = (n - 1).max(1) as f64; // rows[0] is the end of day 0
    let body = &rows[1.min(rows.len())..];
    let sum = |f: &dyn Fn(&DayRow) -> f64| body.iter().map(f).sum::<f64>();
    let changes = sum(&|r| r.changes as f64);
    let flips = sum(&|r| r.flips as f64);
    let ctl_mean = sum(&|r| r.controlled as f64) / days;
    let share = |r: &DayRow, f: usize| r.by_faction[f] as f64 / r.controlled.max(1) as f64;
    let home = |r: &DayRow, f: usize| r.by_faction[f] as f64 / r.home_by_faction[f].max(1) as f64;
    let lead = |r: &DayRow| (0..6).map(|f| share(r, f)).fold(0.0, f64::max);
    let leader_idx = |r: &DayRow| {
        (0..6)
            .max_by(|&a, &b| share(r, a).total_cmp(&share(r, b)))
            .unwrap()
    };
    let mid = &rows[(rows.len() / 4).min(rows.len() - 1)];
    // Stalls: days from day 3 with no flip.
    let from = 3.min(rows.len());
    let tail = &rows[from..];
    let zero = tail.iter().filter(|r| r.flips == 0).count() as f64;
    let mut longest = 0u32;
    let mut run = 0u32;
    for r in tail {
        if r.flips == 0 {
            run += 1;
            longest = longest.max(run);
        } else {
            run = 0;
        }
    }
    let mut lc = 0;
    for w in body.windows(2) {
        if leader_idx(&w[0]) != leader_idx(&w[1]) && w[1].controlled > 0 {
            lc += 1;
        }
    }
    let lw = &rows[rows.len().saturating_sub(7).max(1)..];
    let ever = |v: &Vec<u8>| {
        let c = v.iter().filter(|&&m| m != 0).count().max(1) as f64;
        v.iter().filter(|&&m| m.count_ones() >= 2).count() as f64 / c
    };
    let s = |a: u64| a as f64 / days;
    let tot = |f: &dyn Fn(&DayRow) -> u64| body.iter().map(f).sum::<u64>();
    Summary {
        days,
        marches_ctl_end: last.controlled as f64,
        changes_pd: changes / days,
        flips_pd: flips / days,
        changes_pd_per100: 100.0 * changes / days / ctl_mean.max(1.0),
        changed_hands: ever(&t.ever),
        foreign_end: last.foreign as f64 / last.controlled.max(1) as f64,
        pchanges_pd: sum(&|r| r.pchanges as f64) / days,
        pflips_pd: sum(&|r| r.pflips as f64) / days,
        pchanged_hands: ever(&t.pever),
        pforeign_end: last.pforeign as f64 / last.pcontrolled.max(1) as f64,
        captures_pd: s(tot(&|r| r.captures)),
        occupations_pd: s(tot(&|r| r.occupations)),
        fc_pd: s(tot(&|r| r.fc_captures)),
        sieges_pd: s(tot(&|r| r.sieges)),
        lib_pd: s(tot(&|r| r.liberations)),
        leader_end: lead(&last),
        min_end: (0..6).map(|f| share(&last, f)).fold(1.0, f64::min),
        leader_home_end: (0..6).map(|f| home(&last, f)).fold(0.0, f64::max),
        min_home_end: (0..6).map(|f| home(&last, f)).fold(f64::MAX, f64::min),
        leader_gain: lead(&last) - lead(mid),
        zero_flip_days: zero / tail.len().max(1) as f64,
        longest_zero: longest as f64,
        leader_changes: lc as f64,
        foreign_holdings_end: last.foreign_holdings as f64 / last.holdings.max(1) as f64,
        occupied_end: last.occupied_now as f64,
        flips_last_week_pd: lw.iter().map(|r| r.flips as f64).sum::<f64>() / lw.len().max(1) as f64,
        keep_caps_pd: s(tot(&|r| r.keep_captures)),
        keep_sieges_pd: s(tot(&|r| r.keep_sieges)),
        keep_fail_pd: s(tot(&|r| r.keep_failed)),
        neutral_end: last.neutral_keeps as f64,
        tenure_short: {
            let tot: u64 = t.tenure.iter().sum();
            (t.tenure[0] + t.tenure[1]) as f64 / tot.max(1) as f64
        },
        f0_m_end: share(&last, 0),
        f0_p_end: last.pby_faction[0] as f64 / last.pcontrolled.max(1) as f64,
        f0_p_q1: {
            let r = &rows[(rows.len() / 4).min(rows.len() - 1)];
            r.pby_faction[0] as f64 / r.pcontrolled.max(1) as f64
        },
        f0_p_mid: {
            let r = &rows[(rows.len() / 2).min(rows.len() - 1)];
            r.pby_faction[0] as f64 / r.pcontrolled.max(1) as f64
        },
        pmax_end: (0..6)
            .map(|f| last.pby_faction[f] as f64 / last.pcontrolled.max(1) as f64)
            .fold(0.0, f64::max),
        pmin_end: (0..6)
            .map(|f| last.pby_faction[f] as f64 / last.pcontrolled.max(1) as f64)
            .fold(1.0, f64::min),
        weekly_net: {
            let ps = &t.pseries;
            let (mut acc, mut n) = (0.0f64, 0.0f64);
            for d in 7..ps.len() {
                let (a, b) = (&ps[d - 7], &ps[d]);
                let (mut ch, mut tot) = (0u32, 0u32);
                for i in 0..a.len().min(b.len()) {
                    if a[i] != 255 && b[i] != 255 {
                        tot += 1;
                        if a[i] != b[i] {
                            ch += 1;
                        }
                    }
                }
                if tot > 0 {
                    acc += ch as f64 / tot as f64;
                    n += 1.0;
                }
            }
            acc / n.max(1.0)
        },
        flicker_share: {
            let tot: u64 = t.tenure.iter().sum::<u64>() - t.from_neutral.min(t.tenure.iter().sum());
            t.flicker as f64 / tot.max(1) as f64
        },
    }
}

/// Run `seeds` seasons of each labelled config on every core.
pub fn sweep(
    cfgs: &[(String, Config)],
    seeds: u64,
    first_seed: u64,
) -> Vec<(String, Summary, Vec<Summary>)> {
    let mut jobs: Vec<(usize, Config)> = Vec::new();
    for (i, (_, c)) in cfgs.iter().enumerate() {
        for k in 1..=seeds {
            jobs.push((
                i,
                Config {
                    seed: first_seed + k,
                    verbose: false,
                    ..c.clone()
                },
            ));
        }
    }
    let n = jobs.len();
    let threads = cfgs.first().map_or(1, |c| c.1.threads(n));
    let next = AtomicUsize::new(0);
    let slots: Vec<Mutex<Option<Summary>>> = (0..n).map(|_| Mutex::new(None)).collect();
    std::thread::scope(|sc| {
        for _ in 0..threads {
            sc.spawn(|| loop {
                let i = next.fetch_add(1, Ordering::SeqCst);
                if i >= n {
                    break;
                }
                let (sim, o) = crate::suite::play(&jobs[i].1);
                assert!(o.checks.iter().all(|c| c.ok), "conservation failed");
                *slots[i].lock().unwrap() = Some(summarise(&sim.cq));
            });
        }
    });
    let mut out: Vec<(String, Summary, Vec<Summary>)> = cfgs
        .iter()
        .map(|(l, _)| (l.clone(), Summary::default(), Vec::new()))
        .collect();
    for (i, s) in slots.into_iter().enumerate() {
        let s = s.into_inner().unwrap().expect("season");
        let k = jobs[i].0;
        out[k].1.add(&s);
        out[k].2.push(s);
    }
    for o in &mut out {
        o.1.scale(1.0 / seeds as f64);
    }
    out
}

pub fn table(rows: &[(String, Summary, Vec<Summary>)]) -> String {
    let mut s = String::new();
    writeln!(s, "| config | Marches ctl (end) | March changes/day | flips/day | changes/day per 100 | flips/day last 7d | Marches ever changed hands | foreign-held Marches (end) | province flips/day | provinces changed hands | captures/day | occupations/day | FC captures/day | sieges/day | leader share (end) | min share (end) | leader gain (Q1→end) | max ctl/home | min ctl/home | days w/o flip (≥ d3) | longest no-flip run | leader changes | foreign holdings (end) | occupied (end) | keep sieges/day | keep captures/day | keep sieges failed/day | neutral keeps (end) | captures ending a tenure < 1 day | retaken by the previous holder < 3 days | provinces changed vs 7 days before |").unwrap();
    writeln!(s, "|{}", "---|".repeat(32)).unwrap();
    for (l, m, all) in rows {
        let mx = |f: &dyn Fn(&Summary) -> f64| all.iter().map(f).fold(f64::MIN, f64::max);
        writeln!(
            s,
            "| {l} | {:.0} | {:.1} | {:.1} | {:.1} | {:.1} | {:.0}% | {:.1}% | {:.1} | {:.0}% | {:.2} | {:.2} | {:.1} | {:.1} | {:.1}% (max {:.1}%) | {:.1}% | {:+.1} pt | {:.2} | {:.2} | {:.0}% | {:.1} | {:.1} | {:.1}% | {:.0} | {:.1} | {:.1} | {:.1} | {:.0} | {:.0}% | {:.0}% | {:.1}% |",
            m.marches_ctl_end, m.changes_pd, m.flips_pd, m.changes_pd_per100, m.flips_last_week_pd,
            100.0 * m.changed_hands, 100.0 * m.foreign_end, m.pflips_pd, 100.0 * m.pchanged_hands,
            m.captures_pd, m.occupations_pd, m.fc_pd, m.sieges_pd, 100.0 * m.leader_end,
            100.0 * mx(&|x| x.leader_end), 100.0 * m.min_end, 100.0 * m.leader_gain, m.leader_home_end, m.min_home_end,
            100.0 * m.zero_flip_days, m.longest_zero, m.leader_changes, 100.0 * m.foreign_holdings_end, m.occupied_end,
            m.keep_sieges_pd, m.keep_caps_pd, m.keep_fail_pd, m.neutral_end,
            100.0 * m.tenure_short, 100.0 * m.flicker_share, 100.0 * m.weekly_net,
        )
        .unwrap();
    }
    s
}

/// Per-day curve of one season (for the doc and the hand-off).
pub fn curve(t: &Track) -> String {
    let mut s = String::new();
    writeln!(s, "| day | Marches ctl | foreign | changes | flips | prov flips | share by faction (%) | sieges | occ | cap | FC cap | lib | occupied now | keep sieges | keep caps | neutral keeps |").unwrap();
    writeln!(
        s,
        "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|"
    )
    .unwrap();
    for r in &t.rows {
        let sh: Vec<String> = (0..6)
            .map(|f| {
                format!(
                    "{:.0}",
                    100.0 * r.by_faction[f] as f64 / r.controlled.max(1) as f64
                )
            })
            .collect();
        writeln!(
            s,
            "| {} | {} | {} | {} | {} | {} | {} | {} | {} | {} | {} | {} | {} | {} | {} | {} |",
            r.day,
            r.controlled,
            r.foreign,
            r.changes,
            r.flips,
            r.pflips,
            sh.join("/"),
            r.sieges,
            r.occupations,
            r.captures,
            r.fc_captures,
            r.liberations,
            r.occupied_now,
            r.keep_sieges,
            r.keep_captures,
            r.neutral_keeps
        )
        .unwrap();
    }
    s
}

/// Compact table: movement and snowball columns only.
pub fn table_short(rows: &[(String, Summary, Vec<Summary>)]) -> String {
    let mut s = String::new();
    writeln!(s, "| config | March changes/day | Marches ever changed hands | province flips/day | provinces ever changed hands | provinces changed vs 7 d before | keep captures/day | holding captures + occupations/day | re-taken by previous holder < 3 d | max province share (end) | min province share (end) | faction 0 provinces Q1 → mid → end | faction 0 Marches (end) | days w/o March flip |").unwrap();
    writeln!(s, "|{}", "---|".repeat(14)).unwrap();
    for (l, m, all) in rows {
        let mx = |f: &dyn Fn(&Summary) -> f64| all.iter().map(f).fold(f64::MIN, f64::max);
        writeln!(
            s,
            "| {l} | {:.1} | {:.0}% | {:.1} | {:.0}% | {:.1}% | {:.1} | {:.1} | {:.0}% | {:.1}% (worst seed {:.1}%) | {:.1}% | {:.1}% → {:.1}% → {:.1}% | {:.1}% | {:.0}% |",
            m.changes_pd, 100.0 * m.changed_hands, m.pflips_pd, 100.0 * m.pchanged_hands, 100.0 * m.weekly_net,
            m.keep_caps_pd, m.captures_pd + m.occupations_pd, 100.0 * m.flicker_share,
            100.0 * m.pmax_end, 100.0 * mx(&|x| x.pmax_end), 100.0 * m.pmin_end,
            100.0 * m.f0_p_q1, 100.0 * m.f0_p_mid, 100.0 * m.f0_p_end, 100.0 * m.f0_m_end, 100.0 * m.zero_flip_days,
        )
        .unwrap();
    }
    s
}
