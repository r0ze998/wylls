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

/// W2R2-F1: the planner reads the site mirror's ORDER as the program writes
/// it (1-based: first holding 1, outposts 2 and 3, a Free City 0). The
/// check is independent of the fixture's own writer: the weights the
/// planner's world implies (`site_weight_centi(tier, garrison, order - 1)`
/// per holding, a Free City's neutral) equal `conquest_model::control_weights`
/// over the same Province bytes, and the herald's own first/other split
/// (`order <= 1` is a first holding) agrees with the planner's `order`.
#[test]
fn cq_world_order_is_the_programs_one_based_mirror_order() {
    use frontier_abi::conquest_model::control_weights;
    use frontier_abi::v2::layout::province::{province as P2, site as S2};
    use permutation_rules::frontier::control::site_weight_centi;
    use permutation_rules::frontier::laurel::Tier;
    let f = fixture();
    let (w, ids) = world_from_herald(&f.epoch).unwrap();
    let (mut homes, mut outposts) = (0, 0);
    for (&(p, q), pd) in &f.epoch.provinces {
        let mut sum = [0u32; 7];
        for s in 0..pd[P2::SITE_COUNT] as usize {
            let o = P2::site(s);
            let st = pd[o + S2::STATE];
            if st != S2::STATE_HOLDING && st != S2::STATE_FREE_CITY {
                continue;
            }
            let t = hold_id(pc((p, q)), s as u8);
            let h = w.hold(t);
            assert_eq!(ids.holds[&t], (p, q, s as u8));
            if st == S2::STATE_FREE_CITY {
                assert!(h.free_city() && h.order == 0);
            } else {
                assert_eq!(
                    h.order,
                    pd[o + S2::ORDER],
                    "the mirror's order is read as is"
                );
                assert!(h.order >= 1, "a holding's order is 1-based");
                homes += (h.order == 1) as u32;
                outposts += (h.order >= 2) as u32;
            }
            let side = if st == S2::STATE_FREE_CITY {
                6
            } else {
                h.faction as usize
            };
            // the real kernel takes the 1-based order (a Free City counts as 1)
            let order1 = if st == S2::STATE_FREE_CITY {
                1
            } else {
                h.order
            };
            let tier = match h.tier {
                permutation_rules::frontier::holding::Tier::Hamlet => Tier::Hamlet,
                permutation_rules::frontier::holding::Tier::Town => Tier::Town,
                permutation_rules::frontier::holding::Tier::City => Tier::City,
                permutation_rules::frontier::holding::Tier::Stronghold => Tier::Stronghold,
            };
            sum[side] += site_weight_centi(tier, h.garrison, order1) as u32;
        }
        let want = control_weights(pd, BELL).unwrap();
        assert_eq!(sum, want, "({p},{q}): the planner's order is the model's");
    }
    assert!(
        homes > 0 && outposts > 0,
        "the fixture has homes and outposts"
    );
    // The fleet's first holdings are homes (order 1), so the planner sees
    // homes to occupy and anchors to file outposts from.
    let fleet_homes = w
        .holds
        .values()
        .filter(|h| h.faction == 0 && h.order == 1)
        .count();
    assert!(fleet_homes >= 1, "faction 0 has first holdings (order 1)");
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
        cqbehave::lead_on(&w, home.prov, home.tile, 0, BELL),
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

/// A copy of the epoch as one bot reads it: the same files, in another
/// order (the fleet's wallets and their holdings, the marchbook).
fn shuffled(e: &HeraldEpoch, rng: &mut Rng) -> HeraldEpoch {
    let mut x = e.clone();
    let n = x.wallets.len();
    for i in (1..n).rev() {
        let j = rng.below(i as u64 + 1) as usize;
        x.wallets.swap(i, j);
    }
    for w in &mut x.wallets {
        let n = w.holdings.len();
        for i in (1..n).rev() {
            let j = rng.below(i as u64 + 1) as usize;
            w.holdings.swap(i, j);
        }
    }
    x.marches.reverse();
    x
}

/// W2R2-F3: the plan is total. A board entry whose target the next epoch's
/// files no longer have (a holding released between epochs, an opened
/// Province whose file is missing) leaves the board; it never panics (it
/// did: `World::hold` is an `expect`, and the board persists in the hub, so
/// every bot's epoch would have panicked again each hour).
#[test]
fn cq_plan_survives_a_target_released_between_epochs() {
    let f = fixture();
    let params = cp::Params {
        keep_aggr: 0.5,
        ..cp::Params::FRONTIER_7
    };
    let mut board = Board::default();
    let mut e = f.epoch.clone();
    e.params = Some(params);
    let mut w = world_from_herald(&e).unwrap().0;
    // Plan until a holding campaign (not a keep) is on the board.
    let mut targets = vec![];
    for k in 0..24u32 {
        e.bell = BELL + 6 * k;
        w = world_from_herald(&e).unwrap().0;
        let (nb, _, _) = cp::plan_all(42, &[true; 6], &w, &board);
        board = nb;
        targets = board.camps[0].iter().map(|c| c.target).collect();
        if targets.iter().any(|t| matches!(t, Target::Hold(_))) {
            break;
        }
    }
    let held: Vec<u32> = targets
        .iter()
        .filter_map(|t| match t {
            Target::Hold(h) => Some(*h),
            _ => None,
        })
        .collect();
    assert!(!held.is_empty(), "a holding campaign is planned");
    // The next epoch: those holdings are gone from the world (released),
    // and one keep's Province too (an unreadable file would be an epoch
    // error in the hub; the planner itself must still not panic).
    for h in &held {
        let prov = w.hold(*h).prov;
        w.holds.remove(h);
        if let Some(p) = w.provs.get_mut(&prov) {
            p.sites.iter_mut().for_each(|s| {
                if s == h {
                    *s = cp::NONE
                }
            });
        }
        board.pending.insert(*h, BELL + 500);
    }
    let (nb, _, _) = cp::plan_all(42, &[true; 6], &w, &board);
    for c in nb.camps.iter().flatten() {
        assert!(w.has_target(c.target), "the board only names known targets");
    }
    assert!(nb.pending.keys().all(|t| w.holds.contains_key(t)));
    // Every faction, not only the planner's own, over the damaged world.
    let _ = cp::plan(42, 1, &w, &nb);
}

/// §11 CQ2-F: `campaign::plan` is identical across 32 bots reading the
/// same files in shuffled order, over a game day of epochs (each bot
/// carries its own board), with the seeded draws exercised (keep interest
/// below 1: the plan draws from the fleet seed, so a different fleet seed
/// must give a different day).
#[test]
fn cq_plan_identical_across_32_bots_with_shuffled_observations() {
    let f = fixture();
    let day = |seed: u64, shuffle: bool| -> Vec<(Board, cp::EpochPlan)> {
        let mut rng = Rng::new(9);
        let mut boards: Vec<Board> = vec![Board::default(); 32];
        let mut out: Vec<(Board, cp::EpochPlan)> = vec![];
        for k in 0..24u32 {
            let mut first: Option<(Board, cp::EpochPlan)> = None;
            for (i, board) in boards.iter_mut().enumerate() {
                let mut e = if shuffle {
                    shuffled(&f.epoch, &mut rng)
                } else {
                    f.epoch.clone()
                };
                e.bell = BELL + 6 * k;
                e.params = Some(cp::Params {
                    keep_aggr: 0.5,
                    ..cp::Params::FRONTIER_7
                });
                let w = world_from_herald(&e).unwrap().0;
                let (nb, plan, _) = cp::plan_all(seed, &[true; 6], &w, board);
                *board = nb.clone();
                match &first {
                    None => first = Some((nb, plan)),
                    Some((b0, p0)) => {
                        assert_eq!(&nb, b0, "epoch {k}, bot {i}: board");
                        assert_eq!(&plan, p0, "epoch {k}, bot {i}: plan");
                    }
                }
            }
            out.push(first.unwrap());
        }
        out
    };
    let a = day(42, true);
    // Shuffling the observations changes nothing.
    assert_eq!(a, day(42, false));
    // The plan plans: faction 0 has a campaign and sends hosts.
    assert!(a.iter().any(|(b, _)| !b.camps[0].is_empty()));
    assert!(a.iter().any(|(_, p)| !p.dispatches.is_empty()));
    // The seeded draws are exercised: another fleet seed, another day.
    assert_ne!(a, day(43, false), "keep interest < 1 draws from the seed");
    // 13 settled members: ⌈13 / 40⌉ = 1 campaign, and with a legal home
    // in reach the occupation slot is the faction's holding slot (A-29):
    // the plan occupies, and its strike carries the hold rule.
    let w = world(&f);
    let (b1, p1, _) = cp::plan(42, 0, &w, &Board::default());
    assert_eq!(b1.camps[0].len(), 1);
    assert!(w.occ_target(&b1.camps[0][0].target), "{:?}", b1.camps[0]);
    for d in &p1.dispatches {
        assert!(d.agent <= FULL_WALLET);
        assert!(w.agent(d.agent).holdings.contains(&d.src));
        assert!(d.arrive > BELL && d.arrive < END_BELL);
        assert!(d.retreat.is_some_and(|r| r >= 6_667), "hold rule: {d:?}");
    }
}

/// §11 CQ2-F: each conquest persona whose outcome is a refusal predicts
/// its code with the local checks on the fixture, **for every wallet it
/// may be given** (not the first that matches): wherever a persona acts
/// the code the local checks give is one it expects (the program, CQ2-A/C,
/// returns the same codes; the bot's report compares them), and every
/// refusal persona acts from at least one wallet. The keep personas'
/// targets cannot be contested; the others act.
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
    let wallets: Vec<u32> = (0..=FULL_WALLET).chain([cqfixture::VICTIM]).collect();
    // persona → wallets it acted from.
    let mut acted: BTreeMap<CqPersona, Vec<u32>> = BTreeMap::new();
    for p in CqPersona::ALL {
        let w = if p == CqPersona::SiegeLate {
            &late
        } else {
            &w0
        };
        for &a in &wallets {
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
            acted.entry(p).or_default().push(a);
            let code = cqpersona::local_code(&wa, &f.site_state, a, &it);
            match ex {
                Expect::Refused(_) => {
                    let name = code.map(|c| c.name());
                    assert!(
                        name.is_some_and(|n| p.accepts(n)),
                        "{} from wallet {a}: local code {name:?}, expected {:?}",
                        p.name(),
                        p.expected()
                    );
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
                }
            }
        }
    }
    eprintln!(
        "{:?}",
        acted
            .iter()
            .map(|(p, w)| (p.name(), w.len()))
            .collect::<Vec<_>>()
    );
    // Every refusal persona acts from some wallet of the fleet.
    for p in CqPersona::ALL.into_iter().filter(|p| p.locally_checkable()) {
        assert!(acted.contains_key(&p), "{} acts from no wallet", p.name());
    }
    let refusals = acted.keys().filter(|p| p.locally_checkable()).count();
    assert_eq!(refusals, 11, "{acted:?}");
    // The keep personas and first_taker act on the fixture.
    for n in ["keep_heartland", "keep_consolidation", "first_taker"] {
        let p = CqPersona::parse(n).unwrap();
        assert!(acted.contains_key(&p), "{n}: {acted:?}");
    }
    // The wallets `assign` gives the personas (every seed of a few): where
    // a persona acts, its code is an expected one.
    for seed in 0..8u64 {
        let given = cqpersona::assign(seed, wallets.len(), &|_| false, 1);
        for (&i, &p) in &given {
            let a = wallets[i];
            let w = if p == CqPersona::SiegeLate {
                &late
            } else {
                &w0
            };
            let mut wa = w.clone();
            if p == CqPersona::SiegeSpammer {
                let day = wa.bell / 144;
                wa.agents.get_mut(&a).unwrap().declares = (day, 2);
            }
            if let Some((it, Expect::Refused(_))) = cqpersona::act(p, &wa, &f.site_state, &board, a)
            {
                let code = cqpersona::local_code(&wa, &f.site_state, a, &it).map(|c| c.name());
                assert!(
                    code.is_some_and(|n| p.accepts(n)),
                    "seed {seed}: {} given wallet {a}: {code:?}",
                    p.name()
                );
            }
        }
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

/// The program's DeclareSiege codes for the cases the review named
/// (CQ2-C, §3.4): a Seat's reserved site is `NotBesiegeable` (step 3), a
/// capture due is `CapturePending` (step 3), a holding in a ring-1
/// Province is `ReservedSite` (step 8), and an own shielded first holding
/// bars the declarer `Shielded`.
#[test]
fn cq_declare_codes_follow_the_program() {
    use frontier_abi::v2::error::{Code, CqError};
    let f = fixture();
    let w = world(&f);
    let r = f.roles;
    // Step 3: the Seat's reserved site.
    let seat = r.seat;
    let host = (0..FLEET)
        .find_map(|a| {
            w.hosts
                .iter()
                .find(|(_, h)| h.owner == a && matches!(h.state, HostState::Stationed { .. }))
                .map(|(&h, _)| (a, h))
        })
        .expect("a resident host");
    let src = w.host(host.1).home;
    let code = cqbehave::declare_check(&w, &f.site_state, host.0, src, host.1, seat, BELL);
    assert_eq!(code, Err(Code::Cq(CqError::NotBesiegeable)));
    // Step 3: a capture due on the record.
    let mut wb = w.clone();
    let t = hid(r.home);
    wb.holds.get_mut(&t).unwrap().busy = true;
    let lead = {
        let x = wb.hold(t);
        cqbehave::lead_on(&wb, x.prov, x.tile, 0, BELL).expect("the lead host")
    };
    let owner = wb.host(lead).owner;
    let src = wb.host(lead).home;
    assert_eq!(
        cqbehave::declare_check(&wb, &f.site_state, owner, src, lead, r.home, BELL),
        Err(Code::Cq(CqError::CapturePending))
    );
    // Step 8: the Seat province's holding (ring 1).
    let mut ws = w.clone();
    let seat_pi = pc((seat.0, seat.1)).index();
    assert!(pc((seat.0, seat.1)).is_seat());
    ws.holds.get_mut(&t).unwrap().prov = seat_pi;
    ws.provs.get_mut(&seat_pi).unwrap().sites[0] = t;
    let x = ws.hold(t).clone();
    let _ = x;
    // The lead host must stand on that hex for steps 4–7 to pass.
    let hx = ws.host(lead).clone();
    let mut hx2 = hx;
    hx2.prov = seat_pi;
    hx2.tile = ws.hold(t).tile;
    ws.hosts.insert(lead, hx2);
    ws.provs.get_mut(&seat_pi).unwrap().stationed.push(lead);
    assert_eq!(
        cqbehave::declare_check(
            &ws,
            &f.site_state,
            owner,
            src,
            lead,
            (seat.0, seat.1, 0),
            BELL
        ),
        Err(Code::V1(frontier_abi::error::FrontierError::ReservedSite))
    );
    // The declarer's own shielded first holding bars it (after step 8).
    let mut wh = w.clone();
    let own = *wh.agent(owner).holdings.first().unwrap();
    wh.holds.get_mut(&own).unwrap().shield_until = wh.now(BELL) + 3_600;
    wh.holds.get_mut(&own).unwrap().order = 1;
    assert_eq!(
        cqbehave::declare_check(&wh, &f.site_state, owner, src, lead, r.home, BELL),
        Err(Code::V1(frontier_abi::error::FrontierError::Shielded))
    );
    // The lead host is the attacker faction's: a bigger host of another
    // faction on the tile does not displace it.
    let x = w.hold(t);
    let l0 = cqbehave::lead_on(&w, x.prov, x.tile, 0, BELL).unwrap();
    let mut wc = w.clone();
    let mut big = wc.host(l0).clone();
    big.faction = 2;
    big.troops *= 10;
    big.chain = Some(1);
    let id = wc.next_host;
    wc.next_host += 1;
    wc.hosts.insert(id, big);
    wc.provs.get_mut(&x.prov).unwrap().stationed.push(id);
    assert_eq!(cqbehave::lead_on(&wc, x.prov, x.tile, 0, BELL), Some(l0));
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
    // W2R2-F7: a host the CAPTOR mustered from the same site (its home id
    // is the same site, another faction) is not the victim's to retire.
    let mut w2 = w.clone();
    let mut theirs = w2.host(vh).clone();
    theirs.faction = 0;
    let nid = w2.hosts.keys().max().unwrap() + 1;
    w2.hosts.insert(nid, theirs);
    assert_eq!(
        cqbehave::retirements(&w2, cqfixture::VICTIM, &[home]),
        vec![CqIntent::RetireHost { host: vh }],
        "the captor's own host from that site is not retired"
    );
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
        &[],
        &mut Rng::new(3),
    );
    assert!(all.iter().any(|i| i.name() == "declare_siege"), "{all:?}");
}

/// CQ1-B D-7: an honest bot files no outpost while its own capture strike
/// marches or holds a slot (it would fill the slot on the way and the horn
/// would be refused `HoldingsFull`); an occupation strike (a first holding)
/// does not stop it.
#[test]
fn cq_no_outpost_while_a_capture_strike_marches() {
    let f = fixture();
    let w = world(&f);
    let r = f.roles;
    let board = Board::default();
    let run = |open: &[Mission], w: &World| {
        cqbehave::decide(
            w,
            &board,
            &[],
            &f.site_state,
            0,
            1.0,
            &[],
            open,
            &mut Rng::new(3),
        )
        .iter()
        .any(|i| matches!(i, CqIntent::FileOutpost { .. }))
    };
    assert!(run(&[], &w), "expands when nothing is marching");
    // The faction-1 outpost is a holding 2: a capture target.
    let capture = Mission::Siege(hid(r.outpost));
    assert!(cqbehave::capture_mission(&w, capture));
    assert!(!run(&[capture], &w), "a capture strike under way");
    // A Free City is one too; a first holding is not.
    assert!(cqbehave::capture_mission(
        &w,
        Mission::Siege(hid(r.free_city))
    ));
    let occupation = Mission::Siege(hid(r.home));
    assert!(!cqbehave::capture_mission(&w, occupation));
    assert!(run(&[occupation], &w), "an occupation does not stop it");
    // A slot reserved at a horn (the Citizen's reserved bit) stops it too.
    let mut wr = w.clone();
    wr.agents.get_mut(&0).unwrap().reserved = vec![2];
    assert!(!run(&[], &wr));
}
