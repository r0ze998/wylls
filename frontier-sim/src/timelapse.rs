//! `timelapse`: play one season exactly as `mapmove` / `run` do (the same
//! `Sim::new` + `step` loop of `suite::play`) and write a read-only trace of
//! the map every `--every` bells, for the six-nation map recording
//! (`scripts/demo/sixnation/map/`). Output only: it reads the season state
//! between steps and never changes it, so every digest and gate is unchanged.
//!
//! The file is JSON:
//! `{v, seed, days, bellsPerDay, endBell, every, rules, preset, provinces:
//! [{i, p, q, ring, wedge, opened, cq, cr, t}], frames: [{b, ctl, hold, march, ev}]}`:
//! - `ctl[i]`: the province keep's holder 0–5, or 255 (no keep / not open);
//! - `hold`: flat `[prov, tile, side, tier, …]` per live holding; side 0–5 is
//!   the nation holding it (the occupier's nation while occupied), 6 a Free
//!   City; tier 0 Hamlet … 3 Stronghold;
//! - `march`: flat `[host, fromProv, toProv, nation, troops, departBell,
//!   arriveBell, …]` per marching host (`departBell` is the host's
//!   `ready_bell`, the bell it was sent);
//! - `ev`: flat `[bell, prov, from, to, …]`: keep control changes since the
//!   previous frame (`McState::ctl.events`).
//!
//! A province's `cq, cr` is its centre tile on the global hex grid
//! (`ProvinceCoord::centre`) and `t` its 61 tiles' terrain in
//! `geometry::tile_offset` order (G grassland, P plains, F forest, H hills,
//! M mountain, W water); the `tile` of a holding indexes the same order.

use std::fmt::Write;

use crate::config::Config;
use crate::sim::{HState, Sim, NONE};
use permutation_rules::frontier::holding::Tier;
use permutation_rules::frontier::travel::BELLS_PER_DAY;
use permutation_rules::map::Terrain;

const NO: u8 = 255;

fn tier(t: Tier) -> u8 {
    match t {
        Tier::Hamlet => 0,
        Tier::Town => 1,
        Tier::City => 2,
        Tier::Stronghold => 3,
    }
}

fn frame(sim: &Sim, b: u32, ev_from: &mut usize, out: &mut String) {
    let ctl: Vec<String> = sim
        .provs
        .iter()
        .map(|p| match p.as_ref().and_then(|p| p.mkeep) {
            Some(k) if k.holder < 6 => k.holder.to_string(),
            _ => NO.to_string(),
        })
        .collect();
    let mut hold = Vec::new();
    for x in &sim.holds {
        if !x.alive {
            continue;
        }
        let side = if x.owner == NONE {
            6
        } else if x.occupier.is_some() {
            x.mc.occ_faction
        } else {
            x.faction
        };
        hold.push(format!("{},{},{},{}", x.prov, x.tile, side, tier(x.h.tier)));
    }
    let mut march = Vec::new();
    for (id, h) in sim.hosts.iter().enumerate() {
        if let HState::Marching { arrive } = h.state {
            let from = sim.holds.get(h.home as usize).map_or(h.prov, |x| x.prov);
            march.push(format!(
                "{id},{from},{},{},{},{},{}",
                h.prov,
                h.faction,
                h.troops / 1000,
                h.ready_bell,
                arrive
            ));
        }
    }
    let evs = &sim.mcs.ctl.events;
    let mut ev = Vec::new();
    while *ev_from < evs.len() {
        let (eb, p, f, t) = evs[*ev_from];
        ev.push(format!("{eb},{p},{f},{t}"));
        *ev_from += 1;
    }
    write!(
        out,
        "{{\"b\":{b},\"ctl\":[{}],\"hold\":[{}],\"march\":[{}],\"ev\":[{}]}}",
        ctl.join(","),
        hold.join(","),
        march.join(","),
        ev.join(",")
    )
    .unwrap();
}

/// Play the season of `cfg` and return the trace JSON.
pub fn trace(cfg: &Config, every: u32) -> String {
    let every = every.max(1);
    let mut sim = Sim::new(cfg);
    let mut frames = Vec::new();
    let mut ev_from = 0usize;
    for b in 0..sim.end_bell {
        sim.step(b);
        if b % every == every - 1 || b + 1 == sim.end_bell {
            let mut s = String::new();
            frame(&sim, b, &mut ev_from, &mut s);
            frames.push(s);
        }
    }
    sim.finish();
    // Provinces are listed after the season: a province opened late is in
    // the table with its `opened` bell; frames before that show it as 255.
    let provs: Vec<String> = sim
        .provs
        .iter()
        .enumerate()
        .filter_map(|(i, p)| {
            p.as_ref().map(|p| {
                let c = p.coord.centre();
                let t: String = p
                    .terrain
                    .terrain
                    .iter()
                    .map(|t| match t {
                        Terrain::Grassland => 'G',
                        Terrain::Plains => 'P',
                        Terrain::Forest => 'F',
                        Terrain::Hills => 'H',
                        Terrain::Mountain => 'M',
                        Terrain::Water => 'W',
                    })
                    .collect();
                format!(
                    "{{\"i\":{i},\"p\":{},\"q\":{},\"ring\":{},\"wedge\":{},\"opened\":{},\"cq\":{},\"cr\":{},\"t\":\"{t}\"}}",
                    p.coord.p, p.coord.q, p.ring, p.wedge, p.opened, c.q, c.r
                )
            })
        })
        .collect();
    format!(
        "{{\"v\":1,\"seed\":{},\"days\":{},\"bellsPerDay\":{},\"endBell\":{},\"every\":{every},\"rules\":\"{:?}\",\"preset\":\"{}\",\"agents\":{},\"bots\":{},\"provinces\":[{}],\"frames\":[\n{}\n]}}\n",
        cfg.seed,
        cfg.days,
        BELLS_PER_DAY,
        sim.end_bell,
        cfg.rules,
        cfg.mc.preset,
        cfg.agents,
        cfg.bot_share,
        provs.join(","),
        frames.join(",\n")
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mc::{BotProfile, Policy, Rules};

    fn cfg(seed: u64) -> Config {
        let mut c = Config {
            seed,
            agents: 300,
            days: 2,
            bot_share: 0.99,
            ..Config::default()
        };
        c.set_rules(Rules::Mc, None);
        c.policy = [Policy::Campaign; 6];
        c.bot_profile = BotProfile::Cq;
        c
    }

    /// The trace is a pure read: the same seed gives the same file, and the
    /// season it watched ends exactly as an unwatched one (`suite::play`).
    #[test]
    fn trace_is_deterministic_and_read_only() {
        let c = cfg(2002);
        let a = trace(&c, 3);
        assert_eq!(a, trace(&c, 3));
        let (sim, _) = crate::suite::play(&c);
        let evs = &sim.mcs.ctl.events;
        let in_trace: usize = a
            .lines()
            .filter_map(|l| l.split("\"ev\":[").nth(1))
            .map(|s| s.split(']').next().unwrap())
            .filter(|s| !s.is_empty())
            .map(|s| s.split(',').count() / 4)
            .sum();
        assert_eq!(in_trace, evs.len());
        let frames = a.lines().filter(|l| l.starts_with("{\"b\":")).count();
        assert_eq!(frames as u32, sim.end_bell.div_ceil(3));
        let holds = sim.holds.iter().filter(|x| x.alive).count();
        let last = a.lines().rev().find(|l| l.starts_with("{\"b\":")).unwrap();
        let hold = last
            .split("\"hold\":[")
            .nth(1)
            .unwrap()
            .split(']')
            .next()
            .unwrap();
        assert_eq!(hold.split(',').count() / 4, holds);
    }

    #[test]
    fn provinces_carry_61_terrain_tiles_and_their_centre() {
        let a = trace(&cfg(5), 6);
        let head = a.split("\"frames\"").next().unwrap();
        let n = head.matches("\"t\":\"").count();
        assert!(n > 0);
        for t in head.split("\"t\":\"").skip(1) {
            let t = t.split('"').next().unwrap();
            assert_eq!(t.len(), 61);
            assert!(t.chars().all(|c| "GPFHMW".contains(c)));
        }
        assert!(head.contains("\"cq\":") && head.contains("\"cr\":"));
    }
}
