//! The conquest bot layer on the MC herald fixture (MC contract v1.3
//! §8.6; §11 CQ2-F): the planner's world read from the herald's Province
//! v2, Citizen and Holding bytes; `campaign::plan` identical across 32
//! bots that read the same files in shuffled order; every conquest
//! persona's expected refusal code from the local checks.

use std::collections::BTreeMap;

use frontier_agents::campaign::{self as cp, Board, HostState, Mission, Target, World};
use frontier_agents::cqbehave::{self, CqIntent};
use frontier_agents::cqfixture::{self, fixture, CqFixture, BELL, END_BELL, FLEET, FULL_WALLET};
use frontier_agents::cqobs::{hold_id, world_from_herald, HeraldEpoch};
use frontier_agents::cqpersona::{self, CqPersona, Expect};
use frontier_agents::profile::Arch;
use frontier_agents::rng::Rng;
use permutation_rules::frontier::geometry::ProvinceCoord;

fn pc(k: (i16, i16)) -> ProvinceCoord {
    ProvinceCoord::new(k.0 as i32, k.1 as i32)
}

fn hid(k: (i16, i16, u8)) -> u32 {
    hold_id(pc((k.0, k.1)), k.2)
}

fn world(f: &CqFixture) -> World {
    world_from_herald(&f.epoch).expect("world").0
}

#[test]
fn cq_world_from_herald_reads_the_fixture() {
    let f = fixture();
    let (w, ids) = world_from_herald(&f.epoch).unwrap();
    let r = f.roles;
    assert_eq!(
        (w.bell, w.end_bell, w.genesis_ts),
        (BELL, END_BELL, cqfixture::GENESIS_TS)
    );
    assert_eq!(w.open_ring, cqfixture::RINGS);
    let home = w.hold(hid(r.home));
    assert_eq!((home.faction, home.order, home.free_city()), (1, 1, false));
    let out = w.hold(hid(r.outpost));
    assert_eq!((out.faction, out.order), (1, 2));
    let fc = w.hold(hid(r.free_city));
    assert!(fc.free_city() && fc.garrison == 300_000);
    let sieged = w.hold(hid(r.besieged));
    assert_eq!(
        sieged
            .siege
            .map(|s| (s.attacker_faction, s.declared, s.required)),
        Some((0, 290, 36))
    );
    assert!(w.msieges.contains(&hid(r.besieged)));
    let k = w.prov(pc(r.border).index()).keep.expect("border keep");
    assert_eq!(k.holder, 1);
    assert!(!k.heartland_safe);
    let hk = w
        .prov(pc(r.heartland_keep).index())
        .keep
        .expect("heartland keep");
    assert!(hk.heartland_safe);
    // Hosts: the lead and the smaller faction-mate are fleet wallets 0 and
    // 1; the Scout is civilian; the marchbook's march is a Rally host.
    let lead = ids.host_of_chain[&r.lead];
    let smaller = ids.host_of_chain[&r.smaller];
    assert_eq!((w.host(lead).owner, w.host(smaller).owner), (0, 1));
    assert_eq!(w.host(lead).mission, Mission::Siege(hid(r.home)));
    assert!(w.host(ids.host_of_chain[&r.scout]).unit.is_civilian());
    let rally = w
        .hosts
        .values()
        .find(|h| matches!(h.state, HostState::Marching { .. }))
        .expect("the march in transit");
    assert_eq!(rally.mission, Mission::Rally(hid(r.home)));
    assert_eq!(
        cqbehave::lead_on(&w, home.prov, home.tile, 1, BELL),
        Some(lead)
    );
    // Fleet wallets: settled, Bots, faction 0; the full wallet has no slot.
    for a in 0..FLEET {
        let ag = w.agent(a);
        assert!(ag.settled && ag.arch == Some(Arch::Bot) && ag.faction == 0);
        assert!(w.free_slot23(a).is_some());
    }
    assert_eq!(w.free_slot23(FULL_WALLET), None);
    assert!(w.hold(w.agent(0).holdings[0]).stock[3] > 0);
}

/// A copy of the epoch as one bot reads it: the same files, fetched and
/// listed in another order.
fn shuffled(e: &HeraldEpoch, rng: &mut Rng) -> HeraldEpoch {
    let mut x = e.clone();
    let n = x.wallets.len();
    for i in (1..n).rev() {
        let j = rng.below(i as u64 + 1) as usize;
        x.wallets.swap(i, j);
    }
    let mut ps: Vec<_> = e.provinces.clone().into_iter().collect();
    for i in (1..ps.len()).rev() {
        let j = rng.below(i as u64 + 1) as usize;
        ps.swap(i, j);
    }
    x.provinces = BTreeMap::new();
    for (k, v) in ps {
        x.provinces.insert(k, v);
    }
    let mut ms = x.marches.clone();
    ms.reverse();
    x.marches = ms;
    x
}

/// §11 CQ2-F: `campaign::plan` is identical across 32 bots with shuffled
/// observation order, over a day of epochs (each bot carries its own
/// board).
#[test]
fn cq_plan_identical_across_32_bots_with_shuffled_observations() {
    let f = fixture();
    let seed = 42;
    let mut boards: Vec<Board> = vec![Board::default(); 32];
    let mut first: Option<(Board, cp::EpochPlan)> = None;
    let mut rng = Rng::new(9);
    for (i, board) in boards.iter_mut().enumerate() {
        let e = shuffled(&f.epoch, &mut rng);
        let w = world_from_herald(&e).unwrap().0;
        let (nb, plan, _) = cp::plan(seed, 0, &w, board);
        *board = nb.clone();
        match &first {
            None => first = Some((nb, plan)),
            Some((b0, p0)) => {
                assert_eq!(&nb, b0, "bot {i}: board");
                assert_eq!(&plan, p0, "bot {i}: plan");
            }
        }
    }
    let (b0, p0) = first.unwrap();
    assert!(!b0.camps[0].is_empty(), "faction 0 plans campaigns");
    assert!(
        !p0.dispatches.is_empty(),
        "faction 0 sends hosts: {:?}",
        b0.camps[0]
    );
    // 13 settled members: ⌈13 / 40⌉ = 1 campaign, and with a legal home
    // in reach the occupation slot is the faction's holding slot (A-29):
    // the plan occupies, and its strike carries the hold rule.
    let w = world(&f);
    assert_eq!(b0.camps[0].len(), 1);
    assert!(w.occ_target(&b0.camps[0][0].target), "{:?}", b0.camps[0]);
    assert!(p0.stats.occ_added == 1 && p0.stats.occ_launched == 1);
    for d in &p0.dispatches {
        assert!(d.agent <= FULL_WALLET);
        assert!(w.agent(d.agent).holdings.contains(&d.src));
        assert!(d.arrive > BELL && d.arrive < END_BELL);
        assert!(d.retreat.is_some_and(|r| r >= 6_667), "hold rule: {d:?}");
    }
    // A different fleet seed draws differently only where a draw is made
    // (keep interest < 1.0): at 1.0 the plan is the seed's too.
    let (_, p1, _) = cp::plan(seed + 1, 0, &w, &Board::default());
    assert_eq!(p1, p0);
}

/// §11 CQ2-F: each conquest persona whose outcome is a refusal predicts
/// its code with the local checks on the fixture (the program, CQ2-A/C,
/// returns the same codes; the bot's report compares them); the keep
/// personas' targets cannot be contested; the others act.
#[test]
fn cq_personas_expected_codes_on_the_herald_fixture() {
    let f = fixture();
    let w0 = world(&f);
    let board = {
        let (b, _, _) = cp::plan(1, 0, &w0, &Board::default());
        b
    };
    // A late epoch for siege_late (≤ 36 bells left).
    let late = {
        let mut e = f.epoch.clone();
        e.bell = END_BELL - 20;
        world_from_herald(&e).unwrap().0
    };
    let mut checked = Vec::new();
    for p in CqPersona::ALL {
        let w = if p == CqPersona::SiegeLate {
            &late
        } else {
            &w0
        };
        let mut found = None;
        for a in (0..=FULL_WALLET).chain([cqfixture::VICTIM]) {
            let mut wa = w.clone();
            if p == CqPersona::SiegeSpammer {
                // Two declarations already today.
                let day = wa.bell / 144;
                wa.agents.get_mut(&a).unwrap().declares = (day, 2);
            }
            let Some((it, ex)) = cqpersona::act(p, &wa, &f.site_state, &board, a) else {
                continue;
            };
            assert_eq!(ex, p.expected());
            let code = cqpersona::local_code(&wa, &f.site_state, a, &it);
            match ex {
                Expect::Refused(c) => {
                    if code == Some(c) {
                        found = Some((a, it));
                        break;
                    }
                }
                Expect::Outcome(_) => {
                    if let CqIntent::March {
                        to,
                        mission: Mission::Keep(pi),
                        ..
                    } = &it
                    {
                        // No progress possible: heartland or consolidating.
                        assert!(!wa.target_legal(Target::Keep(*pi), 0, wa.bell), "{p:?}");
                        assert_eq!(pc(*to).index(), *pi);
                    }
                    found = Some((a, it));
                    break;
                }
            }
        }
        if p.locally_checkable() {
            let (a, it) =
                found.unwrap_or_else(|| panic!("{} found no action with its code", p.name()));
            checked.push((p.name(), a, it.name()));
        } else if let Some((a, it)) = found {
            checked.push((p.name(), a, it.name()));
        }
    }
    eprintln!("{checked:?}");
    let refusals = checked
        .iter()
        .filter(|(n, _, _)| CqPersona::parse(n).unwrap().locally_checkable())
        .count();
    assert_eq!(refusals, 11, "{checked:?}");
    // The keep personas and first_taker act on the fixture.
    for n in ["keep_heartland", "keep_consolidation", "first_taker"] {
        assert!(checked.iter().any(|c| c.0 == n), "{n}: {checked:?}");
    }
    // capture_cap's outpost is refused HoldingsFull too.
    let full = cqbehave::outpost_check(&w0, FULL_WALLET, pc(f.roles.border).index(), BELL);
    assert_eq!(
        full,
        Err(frontier_abi::v2::error::Code::Cq(
            frontier_abi::v2::error::CqError::HoldingsFull
        ))
    );
}

/// The behaviours on the fixture: the lead host's owner sounds the horn on
/// a planned target and no one else does; only the victim retires; expand
/// files at the front.
#[test]
fn cq_behaviours_on_the_fixture() {
    let f = fixture();
    let w = world(&f);
    let r = f.roles;
    let mut board = Board::default();
    board.pending.insert(hid(r.home), BELL + 6);
    let lead_horns = cqbehave::horns(&w, &board, &f.site_state, 0);
    assert!(
        lead_horns
            .iter()
            .any(|i| matches!(i, CqIntent::DeclareSiege { site, .. } if *site == r.home)),
        "{lead_horns:?}"
    );
    let racer = cqbehave::horns(&w, &board, &f.site_state, 1);
    assert!(
        racer.is_empty(),
        "the smaller host never sounds the horn: {racer:?}"
    );
    // Retire: the victim's previous-generation host (not defending).
    let (_, ids) = world_from_herald(&f.epoch).unwrap();
    let vh = ids.host_of_chain[&r.victim_host];
    let home = w.host(vh).home;
    let ret = cqbehave::retirements(&w, cqfixture::VICTIM, &[home]);
    assert_eq!(ret, vec![CqIntent::RetireHost { host: vh }]);
    assert_eq!(
        cqbehave::retire_check(0, cqfixture::VICTIM, BELL, END_BELL),
        Err(frontier_abi::v2::error::Code::Cq(
            frontier_abi::v2::error::CqError::NotLead
        ))
    );
    assert_eq!(
        cqbehave::retire_check(cqfixture::VICTIM, cqfixture::VICTIM, BELL, END_BELL),
        Ok(())
    );
    // Expand: a Town home, a free slot, the settler cost in store.
    let mut rng = Rng::new(3);
    let x = cqbehave::expand(&w, &f.site_state, 0, 1.0, &mut rng).expect("an outpost");
    match &x {
        CqIntent::FileOutpost { sites, anchor } => {
            assert_eq!(*anchor, w.agent(0).holdings[0]);
            let pi = pc((sites[0].0, sites[0].1)).index();
            assert!(cqbehave::outpost_check(&w, 0, pi, BELL).is_ok());
            assert!(pc((sites[0].0, sites[0].1)).ring() > 3);
        }
        other => panic!("{other:?}"),
    }
    // decide() gathers them.
    let (nb, plan, _) = cp::plan(5, 0, &w, &board);
    let all = cqbehave::decide(
        &w,
        &nb,
        &plan.dispatches,
        &f.site_state,
        0,
        1.0,
        &[],
        &mut Rng::new(3),
    );
    assert!(all.iter().any(|i| i.name() == "declare_siege"), "{all:?}");
}
