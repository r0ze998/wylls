//! AC3a step 0 (contract §11.3): (a) a fixture confirms the program accepts
//! a march onto the own holding tile (else `recall` is dropped); (e) the
//! host-size distribution under the autopilot on the agents fixtures and on
//! the recorded real herald files. The results print with `--nocapture`;
//! AC3a-NOTES.md copies them. ((b) is `ai_autopilot_no_voluntary_march.rs`;
//! (c) and (d) need a live stack: the exact commands are in the notes.)

#[path = "ai_common.rs"]
mod common;

use std::collections::BTreeMap;

use common::*;
use fclient::abi::layout::entry as le;
use fclient::seal::validate;
use frontier_agents::fixture::{FINAL, SEED};
use frontier_agents::obs::Observation;
use frontier_agents::policy::{self, Ctx, Intent, Memory, Target};
use frontier_agents::profile::Arch;
use frontier_bots::ai::brain;
use frontier_bots::ai::ready;
use frontier_bots::bot::{Bot, Config};
use permutation_rules::frontier::geometry::{locate, ProvinceCoord};

/// (a) Reveal §5.11 check 6 (`permutation-frontier/src/proc/reveal.rs`,
/// "6. path"): the destination is only refused when it is another nation's
/// holding site that is shielded (`other && shield_bell > arrive`) or when
/// the sender is shielded against such a site; an own holding site is not
/// `other`. The kernel prices any passable path; nothing refuses a
/// destination tile that carries the own village. A host standing on the
/// holding tile itself has no path to it (start = goal: `walk` needs ≥ 1
/// step and the agents' planner returns none), which is why a recall exists
/// only for an **arrived** host away from home.
#[tokio::test]
async fn a_march_onto_the_own_holding_tile_plans_and_the_kernel_prices_it() {
    use permutation_rules::frontier::travel;
    use permutation_rules::hex::{Hex, DIRECTIONS};
    let r = rig(None, &[(FINAL, "ai")]);
    let obs = Bot::new(spec(FINAL, Arch::Skilled), SEED)
        .observe(&r.sh)
        .await
        .unwrap();
    let h = brain::home_holding(&obs).unwrap();
    let home = (h.p, h.q);
    // An own host that stands in a neighbouring province on a passable tile
    // (an arrived army): take a neighbour in view and a passable tile there.
    let (at, tile) = obs
        .provinces
        .iter()
        .filter(|(k, _)| **k != home)
        .find_map(|(k, v)| {
            let pv = &v.province;
            (0..61u8)
                .find(|&i| pv.passable_mask >> i & 1 == 1 && pv.camp.tile != i)
                .map(|t| (*k, t))
        })
        .expect("a neighbour province");
    let mut host = policy::own_hosts(&obs, h)
        .into_iter()
        .map(|(_, e)| e)
        .find(|e| e.unit != ready::SCOUT)
        .unwrap();
    host.tile = tile;
    let target = Target {
        p: h.p,
        q: h.q,
        tile: h.tile,
        why: "recall",
    };
    let (path, plain, _slot) = policy::plan_march(&obs, h, at, &host, target, 0, 0, 0)
        .expect("a path from the neighbour to the own holding tile");
    assert!(
        !policy::shield_refuses(&obs, h, &target, plain.arrive_bell),
        "an own site is never `other`"
    );
    validate(&plain, host.id, plain.arrive_bell).expect("a valid plaintext");
    // The kernel prices the same path (check 6's `path_cost`).
    let mut cur = ProvinceCoord::new(at.0 as i32, at.1 as i32)
        .tile(host.tile)
        .unwrap();
    let mut steps = vec![];
    for i in 0..plain.path_len {
        let dir = fclient::seal::step(&plain.path, i);
        let (dq, dr) = DIRECTIONS[dir as usize];
        cur = Hex::new(cur.q + dq, cur.r + dr);
        let (pc, idx) = locate(cur);
        let pv = obs.province(pc.p as i16, pc.q as i16).expect("observed");
        assert!(pv.passable_mask >> idx & 1 == 1);
        let terrain = [
            permutation_rules::map::Terrain::Grassland,
            permutation_rules::map::Terrain::Plains,
            permutation_rules::map::Terrain::Forest,
            permutation_rules::map::Terrain::Hills,
            permutation_rules::map::Terrain::Mountain,
            permutation_rules::map::Terrain::Water,
        ][pv.terrain[idx as usize] as usize];
        steps.push(travel::Step {
            hex: cur,
            terrain,
            road: pv.road_mask >> idx & 1 == 1,
        });
    }
    let (dp, di) = locate(cur);
    assert_eq!(
        (dp.p as i16, dp.q as i16, di),
        (h.p, h.q, h.tile),
        "the path ends on the own holding tile"
    );
    let unit = permutation_rules::frontier::catalog::unit_of(host.unit).unwrap();
    let cost = travel::path_cost(
        ProvinceCoord::new(at.0 as i32, at.1 as i32)
            .tile(host.tile)
            .unwrap(),
        &steps,
        unit,
    )
    .unwrap();
    travel::check_arrival_bell(
        obs.season.genesis_ts,
        obs.now + policy::DEPART_SLACK_SECS,
        cost.secs,
        plain.arrive_bell,
    )
    .unwrap();
    println!("step0(a): recall plan from {at:?} tile {tile} to the own holding tile {} = {} hexes, {} s, arrive bell {}", h.tile, path.dirs.len(), cost.secs, plain.arrive_bell);
    // A host standing ON the holding tile has no plan to it.
    let mut on_tile = host;
    on_tile.tile = h.tile;
    assert!(policy::plan_march(&obs, h, home, &on_tile, target, 0, 0, 0).is_none());
}

fn sizes(
    obs: &Observation,
    arch: Arch,
    spec_index: u32,
    shifts: u32,
) -> (BTreeMap<u32, usize>, BTreeMap<u32, usize>) {
    use fclient::Signer;
    let spec = spec(spec_index, arch);
    let mem = Memory::default();
    let (mut muster, mut train) = (BTreeMap::new(), BTreeMap::new());
    for s in 0..shifts {
        let mut o = obs.clone();
        o.now += s as i64 * 600;
        resolve_all(&mut o);
        let cx = Ctx {
            spec: &spec,
            seed: SEED,
            wallet: frontier_agents::keys::wallet(SEED, spec_index).pubkey(),
            mem: &mem,
            reveal_loaded_limit: Config::new(SEED).reveal_loaded_limit(),
            direct: false,
            session: true,
        };
        for i in policy::decide(&o, &cx) {
            match i {
                Intent::Muster { troops, unit, .. } if unit != ready::SCOUT => {
                    *muster.entry(troops).or_default() += 1
                }
                Intent::Train { n, unit, .. } if unit != ready::SCOUT => {
                    *train.entry(n).or_default() += 1
                }
                _ => {}
            }
        }
    }
    (muster, train)
}

/// (e) What the autopilot (`Arch::Skilled`: want_hosts = 1 + floor(2 q) = 2,
/// train k = 1 + floor(4 q) = 4 hundreds, muster all the reserve up to
/// 30,000 in hundreds) builds on the agents fixture world, and how large a
/// host passes V3(a)–(c) next to it.
#[tokio::test]
async fn the_autopilots_host_sizes_on_the_agents_fixture_world() {
    let r = rig(None, &[(FINAL, "ai")]);
    let obs = Bot::new(spec(FINAL, Arch::Skilled), SEED)
        .observe(&r.sh)
        .await
        .unwrap();
    let (muster, train) = sizes(&obs, Arch::Skilled, FINAL, 120);
    println!("step0(e) fixture world (reserve 300, 1 host of 500): Skilled muster sizes {muster:?}, train sizes {train:?}");
    // The fixture's reserve is 300: it musters 300; the largest train is k = 4 hundreds.
    assert!(
        muster
            .keys()
            .all(|t| (100..=400).contains(t) && t % 100 == 0),
        "{muster:?}"
    );
    assert!(
        train
            .keys()
            .all(|n| (100..=400).contains(n) && n % 100 == 0),
        "{train:?}"
    );
    // V3(a)-(c) next to a second host: hosts a, b at home with no reserve.
    for (a, b) in [(400u32, 400u32), (300, 300), (400, 100), (300, 0), (400, 0)] {
        let home = a + b;
        let ok = |x: u32| {
            x > 0
                && brain::caps_violation(
                    x,
                    1,
                    home,
                    &frontier_bots::ai::DayState::fresh(0, home),
                    None,
                )
                .is_none()
        };
        println!("step0(e) hosts {a}+{b} (home {home}): largest {a} marchable = {}, smaller {b} marchable = {}", ok(a), ok(b));
    }
}

/// (e) on the recorded real herald files (bots seed 1, wallets 153 and 202,
/// final state of the m1-exit season read at bell 997): the policy's
/// Skilled decisions and the home troops.
#[tokio::test]
async fn the_autopilots_host_sizes_on_the_recorded_real_files() {
    for w in [153u32, 202] {
        let r = rig_real(None, &[(w, "ai")], 1_789_685_000);
        let mut b = Bot::new(spec(w, Arch::Skilled), 1);
        b.ai.on = true;
        let obs = b.observe(&r.sh).await.unwrap();
        let h = brain::home_holding(&obs).unwrap();
        let rows = brain::host_rows(&obs, h);
        let (home, _) = brain::home_troops(&obs, h, &rows);
        println!(
            "step0(e) real wallet {w}: hosts {:?}, reserve {:?}, home_troops {home}, ready {:?}",
            rows.iter()
                .map(|r| (
                    r.handle.clone(),
                    r.troops(),
                    r.e.unit,
                    r.ready,
                    ready::stamina_at(&r.e, obs.bell())
                ))
                .collect::<Vec<_>>(),
            &h.reserve[..7],
            rows.iter().filter(|r| r.ready).count(),
        );
        assert!(rows.iter().all(|r| r.e.state == le::STATE_ROSTER));
    }
}
