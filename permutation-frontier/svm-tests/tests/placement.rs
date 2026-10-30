//! Real VM coverage of the dispersed first-home placement (conquest block
//! `placement` 1, `permutation_rules::frontier::geometry::home_nation`):
//! six nations place first homes in small groups spread round the
//! heartland rings; the placement-0 rule is `first_home.rs`.
use fclient::ix::Site;
use frontier_abi::conquest_model::read_keep;
use frontier_abi::layout::world::season as SE;
use frontier_abi::v2::layout::player::{citizen as C, holding as H};
use frontier_abi::v2::layout::province::{province as P, site as S};
use frontier_abi::v2::presets::{SeasonParamsV2, MC_LOCAL_7D, PLACEMENT_DISPERSED};
use permutation_frontier_svm_tests::chain::{assert_code, expect_lands, Chain};
use permutation_frontier_svm_tests::world::land::{rd_i64, Citizen};
use permutation_frontier_svm_tests::world::World;
use permutation_frontier_svm_tests::FrontierError as E;
use permutation_rules::frontier::geometry::{home_nation, ProvinceCoord};
use solana_instruction::Instruction;

const HMR: u8 = 3;

fn dispersed() -> SeasonParamsV2 {
    let mut p = MC_LOCAL_7D;
    p.cq.placement = PLACEMENT_DISPERSED;
    p.cq.heartland_max_ring = HMR;
    p
}

fn seed_of(c: &Chain, w: &World) -> [u8; 32] {
    let d = c.data(&w.a.season);
    let mut s = [0u8; 32];
    s.copy_from_slice(&d[SE::GENESIS_SEED..SE::GENESIS_SEED + 32]);
    s
}

fn nation(seed: &[u8; 32], pq: (i16, i16)) -> u8 {
    home_nation(
        ProvinceCoord::new(pq.0 as i32, pq.1 as i32),
        PLACEMENT_DISPERSED,
        HMR,
        seed,
    )
    .unwrap()
}

fn place(c: &Chain, w: &World, who: &Citizen, s: Site) -> Instruction {
    let d = w.citizen_data(c, who);
    fclient::ix::place_home(&w.a, &who.player(), s, who.faction, d[C::JOIN_SHARD])
}

/// A dispersed season with every province of rings 2 and 3 open.
fn setup() -> (Chain, World, [u8; 32], Vec<(i16, i16)>) {
    let mut c = Chain::test_beacon();
    let w = World::land_v2(&mut c, 1, dispersed());
    let mut v = w.open_provinces(&mut c, 2, None);
    v.extend(w.open_provinces(&mut c, 3, None));
    let seed = seed_of(&c, &w);
    (c, w, seed, v)
}

#[test]
fn placement_six_nations_place_homes_in_groups_spread_over_wedges() {
    let (mut c, w, seed, v) = setup();
    for f in 0..6u8 {
        let mine: Vec<_> = v
            .iter()
            .copied()
            .filter(|pq| nation(&seed, *pq) == f)
            .collect();
        assert_eq!(mine.len(), 5, "2 provinces of ring 2 and 3 of ring 3");
        let wedges: std::collections::BTreeSet<_> = mine
            .iter()
            .map(|(p, q)| ProvinceCoord::new(*p as i32, *q as i32).wedge().unwrap())
            .collect();
        assert!(wedges.len() >= 3, "nation {f}: wedges {wedges:?}");
        // two members of the nation in each of its provinces (a small group)
        for (i, pq) in mine.iter().enumerate() {
            for k in 0..2u8 {
                let who = w.citizen(&mut c, &format!("n{f}-{i}-{k}"), f);
                let s = Site {
                    p: pq.0,
                    q: pq.1,
                    site: k,
                };
                expect_lands(
                    c.send(&[place(&c, &w, &who, s)], &[&who.wallet]),
                    "PlaceHome",
                );
                let hd = c.data(&w.a.holding(pq.0 as i32, pq.1 as i32, k));
                assert_eq!(hd[H::STATE], H::STATE_FINAL);
                // shield: the season's first-holding shield, unchanged by the placement
                assert_eq!(
                    rd_i64(&hd, H::SHIELD_UNTIL),
                    c.now + w.params.cq.shield_secs as i64
                );
            }
        }
    }
    // The keep of every heartland province is held by its assigned nation and heartland-safe.
    for pq in &v {
        let pd = c.data(&w.a.province(pq.0 as i32, pq.1 as i32));
        let k = read_keep(&pd).unwrap().expect("a keep");
        assert_eq!(k.holder, nation(&seed, *pq), "{pq:?}");
        assert!(k.heartland_safe, "{pq:?}");
    }
}

#[test]
fn placement_refuses_another_nations_province_an_occupied_site_and_a_late_join() {
    let (mut c, w, seed, v) = setup();
    let pq = v[0];
    let owner = nation(&seed, pq);
    let other = (owner + 1) % 6;
    // Another nation's assigned province (even inside the joiner's own wedge).
    let stranger = w.citizen(&mut c, "stranger", other);
    let s = Site {
        p: pq.0,
        q: pq.1,
        site: 0,
    };
    assert_code(
        c.send(&[place(&c, &w, &stranger, s)], &[&stranger.wallet]),
        E::BadData,
    );
    let own_wedge_foreign = v
        .iter()
        .copied()
        .find(|(p, q)| {
            ProvinceCoord::new(*p as i32, *q as i32).wedge() == Some(other)
                && nation(&seed, (*p, *q)) != other
        })
        .expect("a province of the stranger's wedge assigned elsewhere");
    let s2 = Site {
        p: own_wedge_foreign.0,
        q: own_wedge_foreign.1,
        site: 0,
    };
    assert_code(
        c.send(&[place(&c, &w, &stranger, s2)], &[&stranger.wallet]),
        E::BadData,
    );
    // The site taken by one member cannot be taken by a second (no overlap).
    let a = w.citizen(&mut c, "a", owner);
    let b = w.citizen(&mut c, "b", owner);
    expect_lands(c.send(&[place(&c, &w, &a, s)], &[&a.wallet]), "PlaceHome");
    let pd = c.data(&w.a.province(pq.0 as i32, pq.1 as i32));
    assert_eq!(pd[P::site(0) + S::STATE], S::STATE_HOLDING);
    c.next_slot();
    assert_code(
        c.send(&[place(&c, &w, &b, s)], &[&b.wallet]),
        E::TicketState,
    );
    // ...but the next site of the same province is free for the second member.
    let s1 = Site {
        p: pq.0,
        q: pq.1,
        site: 1,
    };
    expect_lands(
        c.send(&[place(&c, &w, &b, s1)], &[&b.wallet]),
        "PlaceHome (site 1)",
    );
    // Join closes at join_close_bell as before.
    let late = c.funded(b"late-joiner", 10);
    let mut f = c.fork();
    f.set_time(w.genesis_ts() + w.params.season.join_close_bell as i64 * 600);
    assert_code(w.join(&mut f, &late, owner), E::WrongStatus);
}

#[test]
fn placement_is_reproducible_from_the_genesis_seed() {
    let (c, w, seed, v) = setup();
    let (c2, w2, seed2, _) = setup();
    assert_eq!(seed, seed2);
    for pq in &v {
        let k1 = read_keep(&c.data(&w.a.province(pq.0 as i32, pq.1 as i32)))
            .unwrap()
            .unwrap();
        let k2 = read_keep(&c2.data(&w2.a.province(pq.0 as i32, pq.1 as i32)))
            .unwrap()
            .unwrap();
        assert_eq!(k1.holder, k2.holder);
    }
}
