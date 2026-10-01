//! Scripted tests of the MC holding contest inside the simulator (integ-W1,
//! review CQ1-B): post-siege immunity and the stake (§3.4 failure),
//! occupation start, end and Respite (§3.5), capture credit, the slot move
//! and post-capture immunity (§3.6), and the release of a reserved slot on
//! failure, lapse and occupation (K-25). Each test plays a real MC season
//! to a mid-season bell, then drives one record through the simulator's
//! own handlers (`mc_siege_failed`, `mc_siege_completed`, `mc_capture`,
//! `mc_occupation_bell`, `mc_finish`) and checks the contract's outcome.
//! A season-level test asserts that occupations and liberations occur at
//! all under the MC rules, and that the D9 audit stays at 0 there.

use super::*;
use crate::config::Config;
use crate::mc::{Policy, Rules};

const AT: u32 = 520;

fn season(seed: u64) -> Sim {
    let mut c = Config {
        seed,
        agents: 600,
        days: 7,
        ..Config::default()
    };
    c.set_rules(Rules::Mc, None);
    c.policy = [Policy::Lone; 6];
    let mut sim = Sim::new(&c);
    for b in 0..AT {
        sim.step(b);
    }
    sim
}

fn gold(sim: &Sim, hid: u32, b: u32) -> Milli {
    sim.holds[hid as usize].h.stock_at(now_of(b))[Resource::Gold as usize]
}

/// Empty the holding's Gold so a credit is never capped by storage.
fn drain_gold(sim: &mut Sim, hid: u32, b: u32) {
    let g = gold(sim, hid, b);
    let mut c = [0 as Milli; RESOURCES];
    c[Resource::Gold as usize] = g;
    sim.holds[hid as usize]
        .h
        .pay(now_of(b), &c)
        .expect("pay own gold");
}

/// A live player holding of the given order class (1, or ≥ 2) without a
/// record, and the faction that owns it.
fn target(sim: &Sim, first: bool) -> (u32, u8) {
    let t = (0..sim.holds.len() as u32)
        .find(|&h| {
            let x = &sim.holds[h as usize];
            x.alive
                && !x.free_city()
                && (x.h.order == 1) == first
                && x.mc.siege.is_none()
                && x.occupier.is_none()
                && x.mc.immune_until == 0
        })
        .expect("a holding of that order");
    (t, sim.holds[t as usize].faction)
}

/// A live genesis Free City without a record.
fn free_city(sim: &Sim) -> u32 {
    (0..sim.holds.len() as u32)
        .find(|&h| {
            let x = &sim.holds[h as usize];
            x.alive && x.free_city() && x.mc.siege.is_none()
        })
        .expect("a genesis Free City")
}

/// An agent of another faction than `not` (and than `not2`) with a live
/// first holding and a free slot 2 or 3: (agent, its first holding).
fn attacker(sim: &Sim, not: u8, not2: u8) -> (u32, u32) {
    for (i, ag) in sim.agents.iter().enumerate() {
        if ag.faction == not || ag.faction == not2 || !ag.reserved.is_empty() {
            continue;
        }
        let Some(&src) = ag.holdings.iter().find(|&&h| {
            let y = &sim.holds[h as usize];
            y.alive && y.h.order == 1
        }) else {
            continue;
        };
        if sim.mc_free_slot23(i as u32).is_some() {
            return (i as u32, src);
        }
    }
    panic!("no attacker");
}

/// A third faction, neither `a` nor `b`.
fn third(a: u8, b: u8) -> u8 {
    (0..6u8).find(|&f| f != a && f != b).expect("six factions")
}

/// A host id whose owner is not `a` (a lead host that does not stand on
/// the target's hex).
fn other_host(sim: &Sim, a: u32) -> u32 {
    (0..sim.hosts.len() as u32)
        .find(|&h| sim.hosts[h as usize].owner != a)
        .expect("a host")
}

/// Stand host `h` of agent `a` (faction `f`) resident on `t`'s hex.
fn station_on(sim: &mut Sim, h: u32, a: u32, f: u8, t: u32, b: u32) {
    let (pi, tile) = (sim.holds[t as usize].prov, sim.holds[t as usize].tile);
    let x = &mut sim.hosts[h as usize];
    x.owner = a;
    x.faction = f;
    x.state = HState::Stationed { from: b - 1 };
    x.prov = pi;
    x.tile = tile;
    x.mission = Mission::Siege(t);
    x.troops = 5_000 * MILLI as MilliTroops;
    sim.prov_mut(pi).stationed.push(h);
}

#[allow(clippy::too_many_arguments)]
fn rec(f: u8, a: u32, src: u32, lead: u32, b: u32, slot: u8, sim: &Sim, t: u32) -> McSiege {
    let x = &sim.holds[t as usize];
    McSiege {
        attacker_faction: f,
        declarer: a,
        src,
        lead_host: lead,
        required: 36,
        progress: 5,
        declared: b - 10,
        vigil: if x.free_city() { None } else { Some(x.vigil) },
        slot,
    }
}

/// §3.4 failure, broken by the defender: the stake goes to the target,
/// and immunity `b + 1 + immunity_bells` bars the besieging faction only.
#[test]
fn cq_siege_broken_by_defender_bars_the_attacker_only_and_pays_the_target() {
    let mut sim = season(31);
    let b = AT;
    let (t, tf) = target(&sim, true);
    let (a, src) = attacker(&sim, tf, tf);
    let g = sim.agents[a as usize].faction;
    let h3 = third(tf, g);
    drain_gold(&mut sim, t, b);
    let src0 = gold(&sim, src, b);
    let r = rec(g, a, src, other_host(&sim, a), b, 0, &sim, t);
    sim.holds[t as usize].mc.siege = Some(r);
    sim.mcs.msieges.insert(t);
    let fbd0 = sim.mcs.st.failed_by_defender;
    sim.mc_siege_failed(t, b, r, true);
    let x = &sim.holds[t as usize];
    assert!(x.mc.siege.is_none() && !sim.mcs.msieges.contains(&t));
    assert_eq!(x.mc.barred, g);
    assert_eq!(x.mc.immune_until, b + 1 + sim.cfg.mc.immunity_bells);
    assert_eq!(gold(&sim, t, b), sim.cfg.mc.siege_stake_gold * MILLI);
    assert_eq!(gold(&sim, src, b), src0, "the source gets nothing back");
    assert_eq!(sim.mcs.st.failed_by_defender, fbd0 + 1);
    assert_eq!(sim.mc_record_free(t, g, b + 1), Err(Refusal::Immune));
    assert_eq!(sim.mc_record_free(t, h3, b + 1), Ok(()));
    let until = sim.holds[t as usize].mc.immune_until;
    assert_eq!(
        sim.mc_record_free(t, g, until),
        Ok(()),
        "ends at immune_until"
    );
}

/// §3.4 failure, deserted (the besiegers left): no immunity, and the stake
/// is burned (neither the target nor the source is credited).
#[test]
fn cq_siege_deserted_burns_the_stake_without_immunity() {
    let mut sim = season(32);
    let b = AT;
    let (t, tf) = target(&sim, true);
    let (a, src) = attacker(&sim, tf, tf);
    let g = sim.agents[a as usize].faction;
    drain_gold(&mut sim, t, b);
    let src0 = gold(&sim, src, b);
    let r = rec(g, a, src, other_host(&sim, a), b, 0, &sim, t);
    sim.holds[t as usize].mc.siege = Some(r);
    sim.mcs.msieges.insert(t);
    let fbd0 = sim.mcs.st.failed_by_defender;
    sim.mc_siege_failed(t, b, r, false);
    let x = &sim.holds[t as usize];
    assert_eq!(x.mc.immune_until, 0);
    assert_eq!(gold(&sim, t, b), 0);
    assert_eq!(gold(&sim, src, b), src0);
    assert_eq!(sim.mcs.st.failed_by_defender, fbd0);
    assert_eq!(sim.mc_record_free(t, g, b + 1), Ok(()));
}

/// A Free City's failed siege burns the stake and gives no immunity, even
/// when broken; the reserved slot is released exactly once.
#[test]
fn cq_free_city_failure_burns_the_stake_and_releases_the_slot_once() {
    let mut sim = season(33);
    let b = AT;
    let t = free_city(&sim);
    let (a, src) = attacker(&sim, NEUTRAL, NEUTRAL);
    let g = sim.agents[a as usize].faction;
    let slot = sim.mc_free_slot23(a).expect("free slot");
    let other = if slot == 2 { 3 } else { 2 };
    sim.agents[a as usize].reserved = vec![slot, other];
    let src0 = gold(&sim, src, b);
    let r = rec(g, a, src, other_host(&sim, a), b, slot, &sim, t);
    sim.holds[t as usize].mc.siege = Some(r);
    sim.mcs.msieges.insert(t);
    sim.mc_siege_failed(t, b, r, true);
    assert_eq!(sim.holds[t as usize].mc.immune_until, 0);
    assert_eq!(gold(&sim, src, b), src0, "a Free City's stake is burned");
    assert_eq!(sim.agents[a as usize].reserved, vec![other]);
}

/// §3.5 start: a completed siege on a first holding starts an occupation
/// by the attacker's faction; ownership never changes (D9); the stake goes
/// back to the source; no slot is touched.
#[test]
fn cq_completed_first_holding_siege_occupies_without_transfer() {
    let mut sim = season(34);
    let b = AT;
    let (t, tf) = target(&sim, true);
    let owner = sim.holds[t as usize].owner;
    let (a, src) = attacker(&sim, tf, tf);
    let g = sim.agents[a as usize].faction;
    let h = other_host(&sim, a);
    station_on(&mut sim, h, a, g, t, b);
    drain_gold(&mut sim, src, b);
    sim.agents[a as usize].reserved = vec![3];
    let r = rec(g, a, src, h, b, 0, &sim, t);
    let occ0 = sim.mcs.st.occupations;
    sim.mc_siege_completed(t, b, r);
    let x = &sim.holds[t as usize];
    assert_eq!(x.occupier, Some((a, h)));
    assert_eq!((x.mc.occ_start, x.mc.occ_faction), (b, g));
    assert_eq!((x.owner, x.faction, x.h.order), (owner, tf, 1));
    assert!(sim.mcs.occupied.contains(&t));
    assert_eq!(sim.mcs.st.occupations, occ0 + 1);
    assert_eq!(gold(&sim, src, b), sim.cfg.mc.siege_stake_gold * MILLI);
    assert_eq!(
        sim.agents[a as usize].reserved,
        vec![3],
        "slot 0 releases nothing"
    );
    sim.mc_d9_check();
    assert_eq!(sim.mcs.st.d9_transfers, 0);
}

/// Set up a running occupation of `t` by faction `g` from `start`, with
/// bell `b`'s clash report.
#[allow(clippy::too_many_arguments)]
fn occupy(sim: &mut Sim, t: u32, a: u32, h: u32, g: u8, start: u32, b: u32, r: BellReport) {
    let x = &mut sim.holds[t as usize];
    x.occupier = Some((a, h));
    x.mc.occ_start = start;
    x.mc.occ_faction = g;
    x.report = Some((b, r));
    sim.mcs.occupied.insert(t);
}

/// §3.5 end with Respite: expiry (tenure reached) and the owner's own
/// liberation bar the occupier's faction only, until `end + respite_bells`.
#[test]
fn cq_occupation_expiry_and_owner_liberation_give_respite_against_the_occupier_only() {
    for case in 0..2 {
        let mut sim = season(35 + case);
        let (t, tf) = target(&sim, true);
        let owner = sim.holds[t as usize].owner;
        let (a, _) = attacker(&sim, tf, tf);
        let g = sim.agents[a as usize].faction;
        let h3 = third(tf, g);
        let tenure = sim.cfg.mc.occupation_tenure_bells;
        let b = AT;
        let (start, r) = if case == 0 {
            // Tenure reached while the occupier still holds the hex.
            (
                b - tenure,
                BellReport {
                    holders: 1 << g,
                    defender_present: false,
                },
            )
        } else {
            // The owner's side retook the hex before tenure.
            (
                b - 10,
                BellReport {
                    holders: 0,
                    defender_present: true,
                },
            )
        };
        let h = other_host(&sim, a);
        occupy(&mut sim, t, a, h, g, start, b, r);
        let st0 = sim.mcs.st.clone();
        sim.mc_occupation_bell(t, b);
        let x = &sim.holds[t as usize];
        assert!(x.occupier.is_none() && !sim.mcs.occupied.contains(&t));
        assert_eq!(x.mc.barred, g, "case {case}");
        assert_eq!(
            x.mc.immune_until,
            b + sim.cfg.mc.respite_bells,
            "case {case}"
        );
        assert_eq!((x.owner, x.h.order), (owner, 1), "D9");
        assert_eq!(sim.mc_record_free(t, g, b + 1), Err(Refusal::Immune));
        assert_eq!(
            sim.mc_record_free(t, h3, b + 1),
            Ok(()),
            "Respite bars one faction"
        );
        let st = &sim.mcs.st;
        let d = (
            st.expiries - st0.expiries,
            st.liberations - st0.liberations,
            st.liberated_no_respite - st0.liberated_no_respite,
        );
        assert_eq!(d, if case == 0 { (1, 0, 0) } else { (0, 1, 0) });
    }
}

/// §3.5 end without Respite: an occupier that walks away, or a third
/// faction that takes the hex, ends the occupation and bars nobody.
#[test]
fn cq_occupation_walk_away_or_third_faction_gives_no_respite() {
    for case in 0..2 {
        let mut sim = season(37 + case);
        let (t, tf) = target(&sim, true);
        let (a, _) = attacker(&sim, tf, tf);
        let g = sim.agents[a as usize].faction;
        let h3 = third(tf, g);
        let start = AT - 20;
        let b = AT;
        let r = BellReport {
            holders: if case == 0 { 0 } else { 1 << h3 },
            defender_present: false,
        };
        let h = other_host(&sim, a);
        occupy(&mut sim, t, a, h, g, start, b, r);
        let st0 = sim.mcs.st.clone();
        sim.mc_occupation_bell(t, b);
        let x = &sim.holds[t as usize];
        assert!(x.occupier.is_none());
        assert_eq!(x.mc.immune_until, 0, "case {case}");
        assert_eq!(sim.mc_record_free(t, g, b + 1), Ok(()));
        let st = &sim.mcs.st;
        assert_eq!(
            (
                st.liberations - st0.liberations,
                st.liberated_no_respite - st0.liberated_no_respite
            ),
            (1, 1)
        );
    }
}

/// An occupation that still holds before tenure continues.
#[test]
fn cq_occupation_continues_while_held() {
    let mut sim = season(39);
    let (t, tf) = target(&sim, true);
    let (a, _) = attacker(&sim, tf, tf);
    let g = sim.agents[a as usize].faction;
    let h = other_host(&sim, a);
    let r = BellReport {
        holders: 1 << g,
        defender_present: false,
    };
    occupy(&mut sim, t, a, h, g, AT - 5, AT, r);
    sim.mc_occupation_bell(t, AT);
    assert_eq!(sim.holds[t as usize].occupier, Some((a, h)));
    assert!(sim.mcs.occupied.contains(&t));
}

/// §3.6 capture of a holding (order 2–3): the declarer owns it in the
/// reserved slot, the reservation is consumed exactly once, immunity bars
/// every faction from `b + 1` for `immunity_bells`, the stake returns to
/// the source; credited keeps the stores and adds the capture's Dominion,
/// uncredited zeroes the stores and adds none (K-26).
#[test]
fn cq_capture_moves_the_slot_and_credits_only_long_held_sites() {
    for credited in [false, true] {
        let mut sim = season(40 + credited as u64);
        let b = AT;
        let (t, tf) = target(&sim, false);
        let victim = sim.holds[t as usize].owner;
        let (a, src) = attacker(&sim, tf, tf);
        let g = sim.agents[a as usize].faction;
        let slot = sim.mc_free_slot23(a).expect("free slot");
        sim.agents[a as usize].reserved = vec![slot];
        sim.holds[t as usize].mc.held_since_hour = if credited {
            0
        } else {
            crate::mc::cqk::held_since_hour(b - 10)
        };
        let _ = sim.holds[t as usize]
            .h
            .credit(now_of(b), Resource::Gold, 50 * MILLI);
        let stores0 = sim.holds[t as usize].h.stock_at(now_of(b));
        assert!(stores0.iter().any(|&x| x > 0));
        drain_gold(&mut sim, src, b);
        let dom0 = sim.agents[a as usize].facts[0];
        let r = rec(g, a, src, other_host(&sim, a), b, slot, &sim, t);
        let (cr0, un0) = (sim.mcs.st.credited, sim.mcs.st.uncredited);
        sim.mc_capture(t, b, r);
        let x = &sim.holds[t as usize];
        assert_eq!((x.owner, x.faction, x.h.order), (a, g, slot));
        assert!(x.alive && x.occupier.is_none());
        assert_eq!(x.mc.barred, ALL_FACTIONS);
        assert_eq!(x.mc.immune_until, b + 1 + sim.cfg.mc.immunity_bells);
        for f in 0..6u8 {
            assert_eq!(sim.mc_record_free(t, f, b + 1), Err(Refusal::Immune));
        }
        assert!(sim.agents[a as usize].reserved.is_empty());
        assert!(sim.agents[a as usize].holdings.contains(&t));
        assert!(!sim.agents[victim as usize].holdings.contains(&t));
        assert_eq!(gold(&sim, src, b), sim.cfg.mc.siege_stake_gold * MILLI);
        let stores = sim.holds[t as usize].h.stock_at(now_of(b));
        let dom = sim.agents[a as usize].facts[0] - dom0;
        if credited {
            assert_eq!(stores, stores0, "credited: stores stay");
            assert_eq!(dom, sim.cfg.mc.dominion_per_capture * 1_000);
            assert_eq!(
                (sim.mcs.st.credited - cr0, sim.mcs.st.uncredited - un0),
                (1, 0)
            );
        } else {
            assert!(stores.iter().all(|&x| x == 0), "uncredited: stores zeroed");
            assert_eq!(dom, 0);
            assert_eq!(
                (sim.mcs.st.credited - cr0, sim.mcs.st.uncredited - un0),
                (0, 1)
            );
        }
        sim.mc_d9_check();
        assert_eq!(
            sim.mcs.st.d9_transfers, 0,
            "an order-2 capture is no D9 transfer"
        );
    }
}

/// §3.11 lapse: a siege still running at the season end returns its stake
/// to the source and releases its reserved slot exactly once.
#[test]
fn cq_season_end_lapses_open_sieges_and_releases_their_slot() {
    let mut sim = season(42);
    let t = free_city(&sim);
    let (a, src) = attacker(&sim, NEUTRAL, NEUTRAL);
    let g = sim.agents[a as usize].faction;
    let slot = sim.mc_free_slot23(a).expect("free slot");
    sim.agents[a as usize].reserved = vec![slot];
    let end = sim.end_bell;
    drain_gold(&mut sim, src, end);
    let r = rec(g, a, src, other_host(&sim, a), AT, slot, &sim, t);
    sim.holds[t as usize].mc.siege = Some(r);
    sim.mcs.msieges.insert(t);
    let lapsed0 = sim.mcs.st.lapsed;
    let open = sim.mcs.msieges.len() as u64;
    sim.mc_finish();
    assert!(sim.holds[t as usize].mc.siege.is_none());
    assert!(sim.agents[a as usize].reserved.is_empty());
    assert_eq!(sim.mcs.st.lapsed, lapsed0 + open);
    assert!(sim.holds.iter().all(|x| x.mc.siege.is_none()));
    assert_eq!(
        gold(&sim, src, sim.end_bell),
        sim.cfg.mc.siege_stake_gold * MILLI
    );
}

/// The D9 audit sees a first holding that changed owner, independently of
/// the capture code (criterion 10i can fail).
#[test]
fn cq_d9_audit_detects_a_first_holding_transfer() {
    let mut sim = season(43);
    sim.mc_d9_check();
    assert_eq!(sim.mcs.st.d9_transfers, 0);
    let (t, tf) = target(&sim, true);
    let (a, _) = attacker(&sim, tf, tf);
    sim.holds[t as usize].owner = a;
    sim.mc_d9_check();
    assert_eq!(sim.mcs.st.d9_transfers, 1);
    sim.mc_d9_check();
    assert_eq!(sim.mcs.st.d9_transfers, 1, "counted once");
    let t2 = (0..sim.holds.len() as u32)
        .find(|&h| {
            let x = &sim.holds[h as usize];
            h != t && x.alive && !x.free_city() && x.h.order == 1
        })
        .expect("another first holding");
    sim.holds[t2 as usize].h.order = 2;
    sim.mc_d9_check();
    assert_eq!(sim.mcs.st.d9_transfers, 2, "a first holding left slot 1");
}

/// Occupations and liberations occur at all under the MC rules (the lone
/// human mix, which passes `mapmove-gate`; integ-CQ1-NOTES §4.7), and the
/// D9 audit stays 0 over a whole season.
#[test]
fn cq_mc_season_has_occupations_and_liberations() {
    let mut c = Config {
        seed: 11,
        agents: 600,
        days: 7,
        ..Config::default()
    };
    c.set_rules(Rules::Mc, None);
    let (sim, _) = crate::suite::play(&c);
    let st = &sim.mcs.st;
    assert!(st.occupations > 0, "no occupation");
    assert!(st.liberations + st.expiries > 0, "no occupation ended");
    assert!(st.liberations > 0, "no liberation");
    assert_eq!(st.d9_transfers, 0);
    assert!(!sim.mcs.first_owner.is_empty());
}
