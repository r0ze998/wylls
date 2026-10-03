//! §8.7 item 6 (MC contract v1.3, A-21, A-26, A-29; unit CQ2-F): the
//! field-equality test of `agents::campaign` against the simulator's
//! planner. `build.rs` compiles the simulator's own source here (a
//! visibility-lifted copy, no expression changed) with one probe around
//! `Sim::mc_campaign_epoch`. At every planner epoch of a whole simulated
//! season the probe
//!
//! - builds a [`World`] and a [`Board`] from the simulator's state at the
//!   planner's input (the same instant its planner reads);
//! - compares, field for field and bit for bit, the scoring the port reads:
//!   `keep_def`, `hold_def`, `keep_value` (with the Herald's Call
//!   doubling), `target_legal` (may_besiege v3, the record checks, the
//!   dormancy filter and the plan-time `TooLate`), `can_declare`,
//!   `travel` and the relief estimate, for every keep, every holding and
//!   every faction;
//! - runs the port's whole epoch (`plan_epoch`) and, after the simulator's
//!   epoch, compares the Herald's Call, every faction's campaigns (target,
//!   fails, attempt, muster, hosts: so the occupation slot's candidates and
//!   order and its sharing of the single holding slot), the strikes
//!   pending, every host the plan sent (owner, source, troops, province,
//!   tile, mission, arrival bell) with the hold rule's `retreat_bps`, every
//!   garrison after the launches, and the occupation counters
//!   (`McStats::dbg[11..=13]`).
//!
//! The rally stay (A-26) is checked against the simulator's arrival rule
//! on the same seasons (`dbg[14]`, `dbg[15]`).

use std::cell::RefCell;
use std::collections::BTreeMap;

include!(concat!(env!("OUT_DIR"), "/frontier_sim_lifted.rs"));

use frontier_agents::campaign::{
    self as cp, AgentView, Attempt as PAttempt, Board, Campaign as PCampaign, EpochPlan, HoldView,
    HostState, HostView, Mission as PMission, Params, ProvView, SiegeView, Target as PTarget,
    World,
};
use frontier_agents::profile::ARCHS;
use frontier_agents::rng::Rng as ARng;

use crate::config::Config;
use crate::mc::{BotProfile, Policy, Rules};
use crate::sim::campaign::{Campaign as SCampaign, Target as STarget};
use crate::sim::{HState, Mission as SMission, Sim};

// ------------------------------------------------------------- adapters

fn target(t: STarget) -> PTarget {
    match t {
        STarget::Keep(x) => PTarget::Keep(x),
        STarget::Hold(x) => PTarget::Hold(x),
    }
}

fn mission(m: SMission) -> PMission {
    match m {
        SMission::Camp => PMission::Camp,
        SMission::Siege(x) => PMission::Siege(x),
        SMission::Relic => PMission::Relic,
        SMission::Defend(x) => PMission::Defend(x),
        SMission::Occupy(x) => PMission::Occupy(x),
        SMission::Rally(x) => PMission::Rally(x),
        SMission::Keep(x) => PMission::Keep(x),
        SMission::KeepRally(x) => PMission::KeepRally(x),
        SMission::KeepDefend(x) => PMission::KeepDefend(x),
        SMission::Stage(x) => PMission::Stage(x),
    }
}

fn state(s: HState) -> HostState {
    match s {
        HState::Marching { arrive } => HostState::Marching { arrive },
        HState::Stationed { from } => HostState::Stationed { from },
        HState::Returning => HostState::Returning,
        HState::Dead => HostState::Dead,
    }
}

fn campaigns(cs: &[SCampaign]) -> Vec<PCampaign> {
    cs.iter()
        .map(|c| PCampaign {
            target: target(c.target),
            fails: c.fails,
            attempt: c.attempt.as_ref().map(|a| PAttempt {
                muster: a.muster,
                hosts: a.hosts.clone(),
            }),
            idle_since: c.idle_since,
        })
        .collect()
}

fn board_of(sim: &Sim) -> Board {
    let mut b = Board::default();
    for (f, cs) in sim.mcs.camps.iter().enumerate().take(6) {
        b.camps[f] = campaigns(cs);
    }
    b.pending = sim.mcs.pending.clone();
    b
}

fn factions(sim: &Sim) -> [bool; 6] {
    core::array::from_fn(|f| sim.cfg.policy[f] == Policy::Campaign)
}

/// The simulator's state at the planner's input, as a [`World`].
fn world_of(sim: &Sim, b: u32) -> World {
    let now = sim::now_of(b);
    let c = &sim.cfg;
    let params = Params {
        heartland_max_ring: c.mc.heartland_max_ring.min(u8::MAX as u32) as u8,
        sieges_per_day: c.mc.sieges_per_day,
        siege_stake_gold: c.mc.siege_stake_gold,
        dormant_after_secs: c.mc.dormant_after_secs,
        frontier_protect_secs: c.mc.frontier_protect_secs,
        frontier_protect_after_secs: c.mc.frontier_protect_after_secs,
        keeps: c.rules.keeps(),
        occ_slots: c.occ_slots,
        holding_slots: c.holding_slots,
        siege_hold: c.siege_hold,
        keep_aggr: c.cq.keep_aggr,
        epoch_bots: c.bot_profile != BotProfile::Sim,
    };
    let mut provs = BTreeMap::new();
    for (i, p) in sim.provs.iter().enumerate() {
        if let Some(p) = p {
            provs.insert(
                i as u32,
                ProvView {
                    coord: p.coord,
                    march: p.march,
                    sites: p.site_h.clone(),
                    stationed: p.stationed.clone(),
                    keep: p.mkeep,
                },
            );
        }
    }
    let mut holds = BTreeMap::new();
    for (i, x) in sim.holds.iter().enumerate() {
        holds.insert(
            i as u32,
            HoldView {
                owner: x.owner,
                faction: x.faction,
                prov: x.prov,
                tile: x.tile,
                order: x.h.order,
                tier: x.h.tier,
                garrison: x.garrison,
                walls: x.h.walls,
                walls_now: x.h.walls_at(now).unwrap_or(x.h.walls),
                founded_ts: x.h.founded_ts,
                last_owner_action: x.h.last_owner_action,
                alive: x.alive,
                shield_until: x.mc.shield_until,
                immune_until: x.mc.immune_until,
                barred: x.mc.barred,
                siege: x.mc.siege.map(|s| SiegeView {
                    attacker_faction: s.attacker_faction,
                    declared: s.declared,
                    required: s.required,
                }),
                occupied: x.occupier.is_some(),
                occ_faction: x.mc.occ_faction,
                busy: false,
                vigil: x.vigil,
                stock: x.h.stock_at(now),
            },
        );
    }
    let mut hosts = BTreeMap::new();
    for (i, h) in sim.hosts.iter().enumerate() {
        hosts.insert(
            i as u32,
            HostView {
                owner: h.owner,
                home: h.home,
                faction: h.faction,
                unit: h.unit,
                troops: h.troops,
                state: state(h.state),
                prov: h.prov,
                tile: h.tile,
                mission: mission(h.mission),
                retreat: h.retreat,
            },
        );
    }
    let mut agents = BTreeMap::new();
    for (i, a) in sim.agents.iter().enumerate() {
        agents.insert(
            i as u32,
            AgentView {
                faction: a.faction,
                arch: Some(ARCHS[a.arch.idx()]),
                settled: a.state == sim::JoinState::Settled,
                declares: a.declares,
                reserved: a.reserved.clone(),
                holdings: a.holdings.clone(),
            },
        );
    }
    World {
        bell: b,
        end_bell: sim.end_bell,
        open_ring: sim.open_ring,
        genesis_ts: 0,
        params,
        doctrine: core::array::from_fn(|f| sim.doctrine[f].k),
        provs,
        holds,
        hosts,
        agents,
        keep_live: sim.mcs.keep_live.clone(),
        msieges: sim.mcs.msieges.clone(),
        call: sim.mcs.call,
        next_host: sim.hosts.len() as u32,
    }
}

// ------------------------------------------------------------- the probe

#[derive(Default)]
struct Expect {
    bell: u32,
    world: Option<World>,
    board: Board,
    plan: EpochPlan,
    hosts_before: usize,
    dbg_before: [u64; 16],
}

#[derive(Default, Debug, Clone, Copy)]
struct Tally {
    epochs: u64,
    dispatches: u64,
    occ_dispatches: u64,
    keep_dispatches: u64,
    defence_dispatches: u64,
    campaigns_seen: u64,
    occ_campaigns_seen: u64,
    scores_checked: u64,
    legal_checked: u64,
    legal_true: u64,
    ranked: u64,
    ranked_homes: u64,
    rally_checked: u64,
    rally_stays: u64,
}

/// Each fill's ranked candidates `(faction, [(score, target)])`.
type Ranked = Vec<(u8, Vec<(f64, PTarget)>)>;

thread_local! {
    /// The simulator's ranked candidates of the running epoch.
    static RANKED: RefCell<Ranked> = const { RefCell::new(Vec::new()) };
    static EXPECT: RefCell<Option<Expect>> = const { RefCell::new(None) };
    static TALLY: RefCell<Tally> = RefCell::new(Tally::default());
}

/// Every keep, holding and faction: the port's scoring equals the
/// simulator's, bit for bit.
fn check_scoring(sim: &Sim, w: &World, b: u32) {
    let mut t = TALLY.with(|t| *t.borrow());
    for f in 0..6u8 {
        for (&pi, p) in &w.provs {
            if p.keep.is_none() || p.coord.ring() < 2 {
                continue;
            }
            assert_eq!(
                w.keep_def(pi).to_bits(),
                sim.mc_keep_def(pi).to_bits(),
                "keep_def {pi} b{b}"
            );
            for call in [false, true] {
                assert_eq!(
                    w.keep_value(pi, f, call).to_bits(),
                    sim.mc_keep_value(pi, f, call).to_bits(),
                    "keep_value {pi} f{f} b{b}"
                );
            }
            let legal = w.target_legal(PTarget::Keep(pi), f, b);
            assert_eq!(
                legal,
                sim.mc_target_legal(STarget::Keep(pi), f, b),
                "keep legal {pi} f{f} b{b}"
            );
            t.legal_checked += 1;
            t.legal_true += legal as u64;
            t.scores_checked += 1;
        }
        for (&h, x) in &w.holds {
            if !x.alive {
                continue;
            }
            let legal = w.target_legal(PTarget::Hold(h), f, b);
            assert_eq!(
                legal,
                sim.mc_target_legal(STarget::Hold(h), f, b),
                "hold legal {h} f{f} b{b}"
            );
            assert_eq!(
                w.dormant(x, sim::now_of(b)),
                sim.mc_dormant(&sim.holds[h as usize], sim::now_of(b)),
                "dormant {h}"
            );
            t.legal_checked += 1;
            t.legal_true += legal as u64;
            if f == 0 {
                assert_eq!(
                    w.hold_def(h).to_bits(),
                    sim.mc_hold_def(h).to_bits(),
                    "hold_def {h} b{b}"
                );
                t.scores_checked += 1;
            }
        }
    }
    // The members' horn checks and travel (every holding's owner, its own
    // holding as the source, a few targets).
    let targets: Vec<u32> = w.holds.keys().copied().step_by(37).collect();
    if targets.is_empty() {
        TALLY.with(|x| *x.borrow_mut() = t);
        return;
    }
    for (&h, x) in w.holds.iter().step_by(11) {
        if x.free_city() || !x.alive {
            continue;
        }
        for &t in &targets {
            assert_eq!(
                w.can_declare(x.owner, h, t, b),
                sim.mc_can_declare(x.owner, h, t, b),
                "can_declare {h} {t}"
            );
        }
        let tp = w.hold(targets[0]).prov;
        assert_eq!(
            w.travel(x.faction, x.prov, tp, b),
            sim.travel(x.faction, x.prov, tp, b),
            "travel"
        );
    }
    TALLY.with(|x| *x.borrow_mut() = t);
}

mod cq_probe {
    use super::*;

    /// A Rally host arrived on `t`'s hex (A-26): the port's rule decides
    /// as the simulator did.
    pub fn rally(sim: &Sim, b: u32, t: u32, fac: usize, stays: bool) {
        let w = world_of(sim, b);
        let campaign = fac < 6 && sim.cfg.policy[fac] == Policy::Campaign && sim.cfg.rally_stay;
        assert_eq!(
            cp::rally_stays(&w, &board_of(sim), t, campaign),
            stays,
            "rally stay on {t} at bell {b}"
        );
        TALLY.with(|x| {
            let mut x = x.borrow_mut();
            x.rally_checked += 1;
            x.rally_stays += stays as u64;
        });
    }

    pub fn candidates(f: u8, _b: u32, cands: &[(f64, STarget)]) {
        let v = cands.iter().map(|(s, t)| (*s, target(*t))).collect();
        RANKED.with(|r| r.borrow_mut().push((f, v)));
    }

    pub fn before(sim: &Sim, b: u32) {
        if !sim.cfg.rules.mc()
            || !sim.cfg.policy.contains(&Policy::Campaign)
            || !b.is_multiple_of(6)
        {
            return;
        }
        let mut w = world_of(sim, b);
        if !b.is_multiple_of(144) {
            // At a day start the Herald's Call is recomputed inside the
            // epoch; the value with the Call is compared after it.
            check_scoring(sim, &w, b);
        }
        RANKED.with(|r| r.borrow_mut().clear());
        let mut board = board_of(sim);
        let mut rng = ARng::new(0);
        let plan = cp::plan_epoch(&mut w, &mut board, &factions(sim), &mut rng);
        EXPECT.with(|e| {
            *e.borrow_mut() = Some(Expect {
                bell: b,
                world: Some(w),
                board,
                plan,
                hosts_before: sim.hosts.len(),
                dbg_before: sim.mcs.st.dbg,
            })
        });
    }

    pub fn after(sim: &Sim, b: u32) {
        let Some(e) = EXPECT.with(|e| e.borrow_mut().take()) else {
            return;
        };
        assert_eq!(e.bell, b);
        let w = e.world.expect("world");
        assert_eq!(w.call, sim.mcs.call, "Herald's Call b{b}");
        let sb = board_of(sim);
        for f in 0..6 {
            assert_eq!(
                e.board.camps[f], sb.camps[f],
                "campaigns of faction {f} at bell {b}"
            );
        }
        assert_eq!(e.board.pending, sb.pending, "pending at bell {b}");
        // The ranked candidates of every fill, score bits and order.
        let ranked = RANKED.with(|r| std::mem::take(&mut *r.borrow_mut()));
        assert_eq!(e.plan.candidates.len(), ranked.len(), "fills at bell {b}");
        let mut t = TALLY.with(|t| *t.borrow());
        for ((fa, ca), (fb, cb)) in e.plan.candidates.iter().zip(&ranked) {
            assert_eq!(fa, fb, "fill order at bell {b}");
            let bits = |c: &[(f64, PTarget)]| -> Vec<(u64, PTarget)> {
                c.iter().map(|(s, t)| (s.to_bits(), *t)).collect()
            };
            assert_eq!(
                bits(ca),
                bits(cb),
                "ranked candidates of faction {fa} at bell {b}"
            );
            t.ranked += ca.len() as u64;
            t.ranked_homes += ca.iter().filter(|c| w.occ_target(&c.1)).count() as u64;
        }
        TALLY.with(|x| *x.borrow_mut() = t);
        let new = &sim.hosts[e.hosts_before..];
        assert_eq!(
            e.plan.dispatches.len(),
            new.len(),
            "hosts sent at bell {b}: port {:?}",
            e.plan.dispatches
        );
        let mut t = TALLY.with(|t| *t.borrow());
        for (d, h) in e.plan.dispatches.iter().zip(new) {
            let arrive = match h.state {
                HState::Marching { arrive } => arrive,
                _ => panic!("a sent host is marching"),
            };
            assert_eq!(
                (d.agent, d.src, d.troops, d.prov, d.tile, d.mission, d.arrive),
                (
                    h.owner,
                    h.home,
                    h.troops,
                    h.prov,
                    h.tile,
                    mission(h.mission),
                    arrive
                ),
                "dispatch at bell {b}"
            );
            if let Some(r) = d.retreat {
                assert_eq!(Some(r), h.retreat, "hold rule retreat_bps at bell {b}");
                t.occ_dispatches += 1;
            }
            match d.mission {
                PMission::Keep(_) | PMission::KeepRally(_) => t.keep_dispatches += 1,
                PMission::Defend(_) | PMission::KeepDefend(_) => t.defence_dispatches += 1,
                _ => {}
            }
            t.dispatches += 1;
        }
        for (&i, x) in &w.holds {
            assert_eq!(
                x.garrison, sim.holds[i as usize].garrison,
                "garrison {i} b{b}"
            );
        }
        let d = |k: usize| sim.mcs.st.dbg[k] - e.dbg_before[k];
        assert_eq!(e.plan.stats.fills_with_home, d(11), "dbg[11] at bell {b}");
        assert_eq!(e.plan.stats.occ_added, d(12), "dbg[12] at bell {b}");
        assert_eq!(e.plan.stats.occ_launched, d(13), "dbg[13] at bell {b}");
        for f in 0..6 {
            for c in &e.board.camps[f] {
                t.campaigns_seen += 1;
                if w.occ_target(&c.target) {
                    t.occ_campaigns_seen += 1;
                }
            }
        }
        t.epochs += 1;
        TALLY.with(|x| *x.borrow_mut() = t);
    }
}

// ------------------------------------------------------------- seasons

fn mc_cq(seed: u64, agents: usize, days: u32) -> Config {
    let mut c = Config {
        seed,
        agents,
        days,
        bot_share: 0.99,
        bot_profile: BotProfile::Cq,
        policy: [Policy::Campaign; 6],
        ..Config::default()
    };
    c.set_rules(Rules::Mc, None);
    c
}

fn season(cfg: &Config) -> (Sim, Tally) {
    TALLY.with(|t| *t.borrow_mut() = Tally::default());
    let mut sim = Sim::new(cfg);
    for b in 0..sim.end_bell {
        sim.step(b);
    }
    sim.finish();
    (sim, TALLY.with(|t| *t.borrow()))
}

/// A whole 7-day `--bot-profile cq` campaign season of 1,000 wallets, 99%
/// bots (the thresholds' configuration, seed 2002 of `--first-seed 2001`):
/// every epoch equal, and the season exercises keeps, occupations (the
/// hold rule), defence and the rally stay.
#[test]
fn cq_campaign_plan_equals_the_simulator() {
    let (sim, t) = season(&mc_cq(2002, 1000, 7));
    eprintln!("{t:?} dbg {:?}", sim.mcs.st.dbg);
    assert_eq!(t.epochs, 7 * 24, "one comparison per planner epoch");
    assert!(t.dispatches > 100, "{t:?}");
    assert!(t.keep_dispatches > 0, "{t:?}");
    assert!(t.occ_dispatches > 0, "the hold rule was exercised: {t:?}");
    assert!(t.occ_campaigns_seen > 0, "{t:?}");
    assert!(t.scores_checked > 10_000 && t.legal_true > 0, "{t:?}");
    assert!(t.ranked > 1_000 && t.ranked_homes > 100, "{t:?}");
    assert!(t.rally_checked > 0 && t.rally_stays > 0, "{t:?}");
    assert!(sim.mcs.st.dbg[13] > 0, "occupation groups launched");
}

/// The human mix with campaign factions: session-driven members join the
/// board between epochs (the simulator's `mc_campaign_session`), so the
/// planner reads attempts it did not launch itself; the occupation slot
/// competes with Free Cities and holdings 2–3 for the single holding slot.
#[test]
fn cq_campaign_plan_equals_the_simulator_human_mix() {
    let mut cfg = mc_cq(1102, 500, 7);
    cfg.bot_share = 0.05;
    cfg.bot_profile = BotProfile::Sim;
    let (sim, t) = season(&cfg);
    eprintln!("{t:?} dbg {:?}", sim.mcs.st.dbg);
    assert_eq!(t.epochs, 7 * 24);
    assert!(t.campaigns_seen > 0, "{t:?}");
}

/// One campaign faction and five lone ones, the human mix (§12's
/// coordination row `--policy campaign:0,lone:1-5`): the planner runs for
/// faction 0 only, and the rally stay is campaign-only (A-26): lone
/// factions' rally hosts still go home on arrival.
#[test]
fn cq_campaign_plan_equals_the_simulator_one_campaign_faction() {
    let mut cfg = mc_cq(2003, 600, 7);
    cfg.bot_share = 0.05;
    cfg.bot_profile = BotProfile::Sim;
    cfg.policy = [
        Policy::Campaign,
        Policy::Lone,
        Policy::Lone,
        Policy::Lone,
        Policy::Lone,
        Policy::Lone,
    ];
    let (sim, t) = season(&cfg);
    eprintln!("{t:?} dbg {:?}", sim.mcs.st.dbg);
    assert_eq!(t.epochs, 7 * 24);
    assert!(t.ranked > 0, "{t:?}");
    // Lone factions' rally hosts were seen and sent home (A-26).
    assert!(t.rally_checked > t.rally_stays, "{t:?}");
}

/// A-26 on the port: the rally stay is for campaign factions only, and
/// only while the strike is pending or the siege is live.
#[test]
fn cq_rally_stay_is_campaign_only() {
    let cfg = mc_cq(2002, 300, 4);
    let mut sim = Sim::new(&cfg);
    for b in 0..420 {
        sim.step(b);
    }
    let w = world_of(&sim, 420);
    let board = board_of(&sim);
    let mut seen = 0;
    for (&t, x) in &w.holds {
        let live = x.siege.is_some() || board.pending.contains_key(&t);
        assert_eq!(cp::rally_stays(&w, &board, t, true), live);
        assert!(!cp::rally_stays(&w, &board, t, false));
        seen += live as u32;
    }
    assert!(seen > 0, "no live strike at bell 420");
}
