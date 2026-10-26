//! The S1 candidates (redesign stage 1, plan 30 §1f; `ai/s1.rs`): on the
//! MC fixture world played as an S1 season (program_version 4), the brain
//! offers a march onto another nation's caravan road that arrives before
//! the caravan (ambush), onto the bot's own caravan road (escort), and a
//! caravan of a full store's surplus to another of its holdings; each
//! re-plans into the intent the bot sends (a Depart, a SendCaravan), and
//! none of it appears outside an S1 season.

use std::collections::BTreeMap;

use fclient::abi::layout::season as s;
use fclient::Signer;
use frontier_abi::v2::layout::player::{citizen as C2, holding as H2};
use frontier_abi::v2::layout::province::{caravan_slot as CS, province as P2};
use frontier_agents::cqfixture::{self, fixture, BELL, END_BELL, GENESIS_TS};
use frontier_agents::keys;
use frontier_agents::obs::{b64, b64_encode, MeView, Observation, ProvinceView, SeasonView};
use frontier_agents::policy::Intent;
use frontier_bots::ai::brain::{self, Action, ChosenParams, Inputs, MarchKind, Taken};
use frontier_bots::ai::follow::Side;
use frontier_bots::ai::s1;
use frontier_bots::ai::standing::Standing;
use frontier_bots::ai::DayState;
use permutation_rules::frontier::caravan::caravan_id;
use permutation_rules::frontier::geometry::ProvinceCoord;
use permutation_rules::frontier::terrain::generate_province;
use serde_json::{json, Value};

const SEED: u64 = 7;

/// The fixture season as an MC (`program_version` 3) or S1 (4) season.
fn season(program_version: u16) -> SeasonView {
    let m1 = frontier_agents::fixture::world();
    let mut sj: Value = serde_json::from_slice(&m1.files["h/season.json"]).unwrap();
    let mut sb = b64(sj["bytes_b64"].as_str().unwrap()).unwrap();
    sb[8..16].copy_from_slice(&cqfixture::SEASON_ID.to_le_bytes());
    sb[s::PROGRAM_VERSION..s::PROGRAM_VERSION + 2].copy_from_slice(&program_version.to_le_bytes());
    sb[s::GENESIS_TS..s::GENESIS_TS + 8].copy_from_slice(&GENESIS_TS.to_le_bytes());
    sb[s::END_BELL..s::END_BELL + 4].copy_from_slice(&END_BELL.to_le_bytes());
    let cq = frontier_abi::v2::presets::FRONTIER_7.to_bytes();
    let o = frontier_abi::v2::presets::SEASON_CQ_OFFSET;
    sb[o..o + cq.len()].copy_from_slice(&cq);
    sj["bytes_b64"] = json!(b64_encode(&sb));
    sj["season"] = json!(cqfixture::SEASON_ID.to_string());
    sj["genesisTs"] = json!(GENESIS_TS);
    sj["latestUnix"] = json!(cqfixture::ts(BELL) + 100);
    sj["rMax"] = json!(16);
    sj["rings"] = json!((0..=cqfixture::RINGS)
        .map(|d| json!({"d": d, "seed": hex::encode(cqfixture::ring_seed(d))}))
        .collect::<Vec<_>>());
    SeasonView::from_json(&sj).unwrap()
}

/// The observation of fleet wallet `agent` (faction 0) at the fixture's
/// epoch, its Provinces patched by `patch`.
fn observe(
    program_version: u16,
    agent: u32,
    patch: impl Fn(&mut BTreeMap<(i16, i16), Vec<u8>>),
) -> Observation {
    let f = fixture();
    let mut provs = f.epoch.provinces.clone();
    // The fixture leaves the masks the chain writes at a Province's opening
    // zero; the roads read the passable one (from the kernel's terrain).
    for (&(p, q), b) in provs.iter_mut() {
        let pc = ProvinceCoord::new(p as i32, q as i32);
        let t = generate_province(&cqfixture::ring_seed(pc.ring()), pc);
        let mask = (0..61u8)
            .filter(|&i| t.passable(i))
            .fold(0u64, |m, i| m | 1 << i);
        b[P2::PASSABLE_MASK..P2::PASSABLE_MASK + 8].copy_from_slice(&mask.to_le_bytes());
    }
    patch(&mut provs);
    let provinces = provs
        .iter()
        .map(|(&(p, q), bytes)| {
            let v = json!({"v": 1, "key": format!("pv:{p},{q}"), "bell": BELL - 1, "slot": 1, "bytes": b64_encode(bytes)});
            ((p, q), ProvinceView::from_json(&v).unwrap())
        })
        .collect();
    let addrs =
        fclient::addr::Addresses::new(frontier_agents::fixture::program(), cqfixture::SEASON_ID);
    let w = f.epoch.wallets.iter().find(|w| w.agent == agent).unwrap();
    let key = keys::wallet(SEED, agent).pubkey();
    let mut c = w.citizen.clone().unwrap();
    c[C2::WALLET..C2::WALLET + 32].copy_from_slice(key.as_ref());
    let holdings: Vec<Value> = w
        .holdings
        .iter()
        .map(|h| {
            let p = i16::from_le_bytes([h[H2::P], h[H2::P + 1]]);
            let q = i16::from_le_bytes([h[H2::Q], h[H2::Q + 1]]);
            json!({"address": addrs.holding(p as i32, q as i32, h[H2::SITE]).to_string(), "bytes_b64": b64_encode(h)})
        })
        .collect();
    let me = json!({
        "v": 1, "wallet": key.to_string(),
        "citizen": {"address": addrs.citizen(&key).to_string(), "bytes_b64": b64_encode(&c)},
        "holdings": holdings, "slots": [],
        "quota": {"left": 38, "resetsAt": GENESIS_TS + 86_400},
    });
    Observation {
        now: cqfixture::ts(BELL) + 200,
        season: season(program_version),
        me: MeView::from_json(&me).unwrap(),
        provinces,
        province_bells: BTreeMap::new(),
        overviews: vec![],
        bells: BTreeMap::new(),
    }
}

const S1: u16 = frontier_abi::v2::presets::PROGRAM_VERSION_S1;
const MC: u16 = fclient::abi::PROGRAM_VERSION_V2;
/// Fleet wallet 0: its home at (3, 1), its one ready host (2,000 troops) at (0, 4).
const AGENT: u32 = 0;
const HOST_AT: (i16, i16) = (0, 4);

fn day() -> DayState {
    DayState {
        day: 0,
        h0: 0,
        marches: vec![],
    }
}

fn inputs<'a>(obs: &'a Observation, ds: &'a DayState) -> Inputs<'a> {
    let h = brain::home_holding(obs).expect("a final holding");
    let rows = brain::host_rows(obs, h);
    let (home, _) = brain::home_troops(obs, h, &rows);
    // (the caps V3a-c are not this file's subject: a home five times the host)
    let home = home.max(10_000);
    Inputs {
        obs,
        h,
        faction: h.faction,
        ds,
        presets: [5_000, 10_000, 20_000],
        autopilot_summary: String::new(),
        rows,
        home_troops: home,
        quota_left: 40,
    }
}

/// A passable tile of the host's Province that is no site, not the host's
/// own, not the keep's nor the camp's: where the test's caravan stands.
fn road_tile(obs: &Observation) -> u8 {
    let pv = obs.province(HOST_AT.0, HOST_AT.1).unwrap();
    let sites = &pv.sites[..pv.site_count as usize];
    let host = pv
        .entries
        .iter()
        .find(|e| e.state != 0 && e.faction == 0)
        .map(|e| e.tile);
    let keep = pv.cq.as_ref().and_then(|c| c.keep.map(|k| k.tile));
    (0..61u8)
        .find(|&t| {
            pv.passable_mask >> t & 1 == 1
                && !sites.contains(&t)
                && Some(t) != host
                && Some(t) != keep
                && t != pv.camp.tile
        })
        .expect("a road tile")
}

/// A caravan of `id` and `faction` standing on `tile` of the host's
/// Province for 3 bells from `first`.
fn with_caravan(
    id: u64,
    faction: u8,
    tile: u8,
    first: u32,
) -> impl Fn(&mut BTreeMap<(i16, i16), Vec<u8>>) {
    move |provs| {
        let b = provs.get_mut(&HOST_AT).unwrap();
        let slot = permutation_rules::frontier::caravan::CaravanSlot {
            id,
            faction,
            n: 3,
            raid_off: permutation_rules::frontier::caravan::RAID_NONE,
            raid_pos: 0,
            first_bell: first,
            tiles: [tile, tile, tile, 0, 0, 0, 0, 0],
            raider: 0,
        };
        slot.encode(&mut b[CS::at(0)..CS::at(0) + CS::SIZE])
            .unwrap();
    }
}

fn own_tag(obs: &Observation) -> u64 {
    obs.me.citizen.as_ref().unwrap().1.citizen_tag
}

fn road_marches(o: &[brain::Offer]) -> Vec<&brain::Offer> {
    o.iter()
        .filter(|x| {
            matches!(
                x.action,
                Action::March {
                    kind: MarchKind::Ambush | MarchKind::Escort,
                    ..
                }
            )
        })
        .collect()
}

#[test]
fn an_ambush_is_offered_on_another_nations_caravan_road_and_planned_into_a_depart() {
    let base = observe(S1, AGENT, |_| {});
    let tile = road_tile(&base);
    let first = BELL + 40;
    let obs = observe(
        S1,
        AGENT,
        with_caravan(caravan_id(424_242, 0), 1, tile, first),
    );
    let ds = day();
    let offers = brain::candidates_with(&inputs(&obs, &ds), &Side::default());
    let road = road_marches(&offers);
    assert_eq!(
        road.len(),
        1,
        "one road march: {:?}",
        offers.iter().map(|o| &o.cand.kind).collect::<Vec<_>>()
    );
    let o = road[0];
    assert_eq!(o.cand.kind, "march");
    assert_eq!(o.cand.facts["target_kind"], "ambush");
    assert_eq!(
        o.cand.facts["caravan_bell"],
        json!(first + 2),
        "the caravan's last stand there"
    );
    assert_eq!(
        o.cand.facts["target"],
        json!({"p": HOST_AT.0, "q": HOST_AT.1, "tile": tile})
    );
    let arrive = o.cand.facts["earliest_bell"].as_u64().unwrap() as u32;
    assert!(arrive <= first + 2);
    assert_eq!(o.cand.facts["waits_bells"], json!(first + 2 - arrive));
    // chosen: a Depart onto the road tile
    let (it, troops) = brain::replan_with(
        &o.action,
        &ChosenParams::default(),
        &inputs(&obs, &ds),
        &mut Taken::default(),
        &Standing::default(),
        &Side::default(),
    )
    .unwrap();
    let Intent::Depart(plan) = it else {
        panic!("a depart")
    };
    assert_eq!(
        (plan.plain.dest_p, plan.plain.dest_q, plan.plain.dest_tile),
        (HOST_AT.0, HOST_AT.1, tile)
    );
    assert_eq!(plan.why, "ambush");
    assert_eq!(troops, Some(2_000));
    // the caravan gone from the fresh files: dropped
    assert_eq!(
        brain::replan_with(
            &o.action,
            &ChosenParams::default(),
            &inputs(&base, &ds),
            &mut Taken::default(),
            &Standing::default(),
            &Side::default()
        )
        .unwrap_err(),
        "caravan gone"
    );
}

#[test]
fn no_road_march_when_the_caravan_passes_first_nor_outside_s1() {
    let base = observe(S1, AGENT, |_| {});
    let tile = road_tile(&base);
    let ds = day();
    // the caravan's last stand on the tile is the next bell: no host gets there in time
    let soon = observe(
        S1,
        AGENT,
        with_caravan(caravan_id(424_242, 0), 1, tile, BELL - 1),
    );
    assert!(road_marches(&brain::candidates_with(
        &inputs(&soon, &ds),
        &Side::default()
    ))
    .is_empty());
    // an MC season has no caravans to wait for (and no S1 candidates)
    let mc = observe(
        MC,
        AGENT,
        with_caravan(caravan_id(424_242, 0), 1, tile, BELL + 40),
    );
    assert!(s1::offer(&inputs(&mc, &ds)).is_empty());
    // a raided caravan is no target
    let raided = observe(S1, AGENT, |provs| {
        with_caravan(caravan_id(424_242, 0), 1, tile, BELL + 40)(provs);
        provs.get_mut(&HOST_AT).unwrap()[CS::at(0) + CS::RAID_OFF] = 1;
    });
    assert!(road_marches(&brain::candidates_with(
        &inputs(&raided, &ds),
        &Side::default()
    ))
    .is_empty());
}

#[test]
fn an_escort_is_offered_on_the_bots_own_caravan_road() {
    let base = observe(S1, AGENT, |_| {});
    let tile = road_tile(&base);
    let tag = own_tag(&base);
    let obs = observe(
        S1,
        AGENT,
        with_caravan(caravan_id(tag, 3), 0, tile, BELL + 40),
    );
    let ds = day();
    let offers = brain::candidates_with(&inputs(&obs, &ds), &Side::default());
    let road = road_marches(&offers);
    assert_eq!(road.len(), 1);
    assert_eq!(road[0].cand.facts["target_kind"], "escort");
    assert_eq!(road[0].cand.facts["enemy_troops"], json!(0));
    // another faction-0 citizen's caravan is neither (a domestic raid is the nation's business)
    let other = observe(
        S1,
        AGENT,
        with_caravan(caravan_id(tag ^ 1, 3), 0, tile, BELL + 40),
    );
    assert!(road_marches(&brain::candidates_with(
        &inputs(&other, &ds),
        &Side::default()
    ))
    .is_empty());
}

/// Wallet 0's home with a second holding on another site of its Province,
/// the home's wood at 90 % of its cap and the second's empty.
fn two_villages() -> Observation {
    let mut obs = observe(S1, AGENT, |_| {});
    let (addr, home) = obs.me.holdings[0].clone();
    let pv = obs.province(home.p, home.q).unwrap();
    let site = (0..pv.site_count).find(|&k| k != home.site).unwrap();
    let mut other = home.clone();
    other.site = site;
    other.tile = pv.sites[site as usize];
    let now = obs.now;
    let set = |h: &mut fclient::decode::Holding, wood: i64| {
        let a = &mut h.stores[1];
        a.value = wood;
        a.rate = 0;
        a.t0 = now;
        a.frac = 0;
    };
    let mut home2 = home.clone();
    let cap = home.stores[1].cap;
    set(&mut home2, cap * 9 / 10);
    set(&mut other, 0);
    obs.me.holdings = vec![(addr, home2), (addr, other)];
    obs
}

#[test]
fn a_full_stores_surplus_is_offered_as_a_caravan_to_another_village_and_planned_into_a_send() {
    let obs = two_villages();
    let ds = day();
    let offers = brain::candidates_with(&inputs(&obs, &ds), &Side::default());
    let c = offers
        .iter()
        .find(|o| o.cand.kind == "caravan")
        .expect("a caravan candidate");
    let Action::Caravan { to, cargo } = &c.action else {
        panic!()
    };
    let (home, other) = (&obs.me.holdings[0].1, &obs.me.holdings[1].1);
    assert_eq!((to.p, to.q, to.site), (other.p, other.q, other.site));
    let cap = home.stores[1].cap;
    let want = ((cap * 9 / 10 - cap * s1::KEEP_PERMILLE / 1000).min(cap * s1::KEEP_PERMILLE / 1000)
        / 1000)
        .min(s1::MAX_CARGO) as u32;
    assert_eq!(cargo[1], want);
    assert!(
        cargo.iter().enumerate().all(|(r, &v)| r == 1 || v == 0),
        "only the full store"
    );
    let (it, _) = brain::replan_with(
        &c.action,
        &ChosenParams::default(),
        &inputs(&obs, &ds),
        &mut Taken::default(),
        &Standing::default(),
        &Side::default(),
    )
    .unwrap();
    let Intent::SendCaravan { args, .. } = it else {
        panic!("a send")
    };
    assert_eq!(
        args.seq,
        obs.me
            .citizen
            .as_ref()
            .unwrap()
            .1
            .cq
            .as_ref()
            .unwrap()
            .caravans
    );
    assert_eq!(args.cargo, *cargo);
    assert_eq!(args.fee, permutation_rules::frontier::caravan::CARAVAN_FEE);
    assert_eq!(
        args.provinces,
        vec![(home.p, home.q)],
        "a road within the Province"
    );
    assert!(args.steps > 0);
    // the walk the program checks: it ends on the other village's tile
    let lands = s1::lands(&obs);
    let land: Vec<_> = lands
        .iter()
        .filter(|l| (l.at.p, l.at.q) == (home.p as i32, home.q as i32))
        .copied()
        .collect();
    let pc =
        permutation_rules::frontier::geometry::ProvinceCoord::new(home.p as i32, home.q as i32);
    let walk = permutation_rules::frontier::caravan::walk(
        (pc, home.tile),
        &args.path,
        args.steps,
        &land,
        10_000,
    )
    .unwrap();
    assert_eq!(walk.last().unwrap().tile, other.tile);
    // one caravan a decision; the next choice is dropped
    let mut taken = Taken::default();
    brain::replan_with(
        &c.action,
        &ChosenParams::default(),
        &inputs(&obs, &ds),
        &mut taken,
        &Standing::default(),
        &Side::default(),
    )
    .unwrap();
    assert_eq!(
        brain::replan_with(
            &c.action,
            &ChosenParams::default(),
            &inputs(&obs, &ds),
            &mut taken,
            &Standing::default(),
            &Side::default()
        )
        .unwrap_err(),
        "caravan already sent"
    );
}

#[test]
fn no_caravan_without_a_full_store_or_a_second_village() {
    let ds = day();
    let one = observe(S1, AGENT, |_| {});
    assert!(
        !brain::candidates_with(&inputs(&one, &ds), &Side::default())
            .iter()
            .any(|o| o.cand.kind == "caravan")
    );
    let mut half = two_villages();
    let cap = half.me.holdings[0].1.stores[1].cap;
    half.me.holdings[0].1.stores[1].value = cap / 2;
    assert!(
        !brain::candidates_with(&inputs(&half, &ds), &Side::default())
            .iter()
            .any(|o| o.cand.kind == "caravan")
    );
}

/// A village whose workshops eat all its ore (s1-season-2: every AI village
/// after its first workshop) is offered an ore producer among its builds,
/// and only then.
#[test]
fn an_ore_producer_is_offered_while_the_workshops_starve_the_ore() {
    let ds = day();
    let offers = |starve: bool| -> Vec<String> {
        let mut obs = observe(S1, AGENT, |_| {});
        let now = obs.now;
        let h = &mut obs.me.holdings[0].1;
        for a in h.stores.iter_mut() {
            a.value = 5_000_000;
            a.t0 = now;
            a.frac = 0;
        }
        if starve {
            h.production[permutation_rules::frontier::arms::ARMS as usize] = 4_000;
            h.stores[3].value = 0;
            h.stores[3].rate = -4_000;
        }
        brain::candidates_with(&inputs(&obs, &ds), &Side::default())
            .into_iter()
            .map(|o| o.cand.kind)
            .filter(|k| k.starts_with("build:"))
            .collect()
    };
    let starved = offers(true);
    assert!(starved.iter().any(|k| k == "build:ore"), "{starved:?}");
    let fed = offers(false);
    assert!(
        !fed.iter().any(|k| k == "build:ore") || fed.len() <= 2,
        "{fed:?}"
    );
}

/// The situation names the stores for the mind: slot 4 is arms in an S1
/// season (the s1-model-1 prompts said "horses 47" for the workshops' arms).
#[test]
fn the_situation_names_slot_four_arms_in_an_s1_season() {
    let ds = day();
    let s1 = observe(S1, AGENT, |_| {});
    let sit = brain::situation(&inputs(&s1, &ds), (0, 0));
    assert_eq!(sit["resources"][4], "arms");
    assert_eq!(sit["resources"][3], "ore");
    let mc = observe(MC, AGENT, |_| {});
    assert_eq!(
        brain::situation(&inputs(&mc, &ds), (0, 0))["resources"][4],
        "horses"
    );
}
