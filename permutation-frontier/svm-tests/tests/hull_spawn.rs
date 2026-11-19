//! Real VM coverage of ⑭ R3 (conquest byte 82 `spawn_reach`): a first home
//! outside the heartland goes next to the settled land. The season is the
//! playable preset `S1_LOCAL_7D` (placement 2, `spawn_reach` 2) with the
//! heartland cut to ring 2, so ring 3 (a genesis ring, open) lies outside
//! it. Every settlement here is a real PlaceHome; no state is crafted.
use fclient::ix::Site;
use frontier_abi::layout::world::season as SE;
use frontier_abi::v2::layout::player::{citizen as C, holding as H};
use frontier_abi::v2::layout::province::province as P;
use frontier_abi::v2::presets::{SeasonParamsV2, PLACEMENT_MIXED, S1_LOCAL_7D, SPAWN_PLAYABLE};
use permutation_frontier_svm_tests::chain::{assert_code, expect_lands, Chain};
use permutation_frontier_svm_tests::world::land::Citizen;
use permutation_frontier_svm_tests::world::World;
use permutation_frontier_svm_tests::FrontierError as E;
use permutation_rules::frontier::geometry::{home_nation, ProvinceCoord};
use solana_instruction::Instruction;

const HMR: u8 = 2;

fn params() -> SeasonParamsV2 {
    let mut p = S1_LOCAL_7D;
    assert_eq!(p.cq.spawn_reach, SPAWN_PLAYABLE);
    p.cq.heartland_max_ring = HMR;
    p
}

fn coord(pq: (i16, i16)) -> ProvinceCoord {
    ProvinceCoord::new(pq.0 as i32, pq.1 as i32)
}

fn place(
    c: &Chain,
    w: &World,
    who: &Citizen,
    pq: (i16, i16),
    site: u8,
    witness: Option<(i16, i16)>,
) -> Instruction {
    let d = w.citizen_data(c, who);
    let s = Site {
        p: pq.0,
        q: pq.1,
        site,
    };
    fclient::ix::place_home_near(
        &w.a,
        &who.player(),
        s,
        who.faction,
        d[C::JOIN_SHARD],
        witness,
    )
}

#[test]
fn hull_spawn_first_homes_follow_the_settled_land() {
    let mut c = Chain::test_beacon();
    let w = World::land_v2(&mut c, 41, params());
    let mut ring2 = w.open_provinces(&mut c, 2, None);
    let ring3 = w.open_provinces(&mut c, 3, None);
    let sd = c.data(&w.a.season);
    let mut seed = [0u8; 32];
    seed.copy_from_slice(&sd[SE::GENESIS_SEED..SE::GENESIS_SEED + 32]);
    let nation = |pq: (i16, i16)| home_nation(coord(pq), PLACEMENT_MIXED, HMR, &seed).unwrap();

    // A heartland home (ring 2) settles the first province.
    let settled = ring2.remove(0);
    let a = w.citizen(&mut c, "a", nation(settled));
    expect_lands(
        c.send(&[place(&c, &w, &a, settled, 0, None)], &[&a.wallet]),
        "heartland PlaceHome",
    );
    let pd = c.data(&w.a.province(settled.0 as i32, settled.1 as i32));
    assert_eq!(pd[P::N_SITES_USED], 1);

    let near = *ring3
        .iter()
        .find(|t| coord(**t).distance(coord(settled)) <= 2)
        .expect("a ring-3 province within 2 of it");
    let far = *ring3
        .iter()
        .find(|t| coord(**t).distance(coord(settled)) > 2)
        .expect("a ring-3 province beyond 2 of it");
    let empty = ring2[0];

    // Outside the heartland: no witness, an empty witness, a distant one.
    let b = w.citizen(&mut c, "b", nation(near));
    assert_code(
        c.send(&[place(&c, &w, &b, near, 0, None)], &[&b.wallet]),
        E::ReservedSite,
    );
    assert_code(
        c.send(&[place(&c, &w, &b, near, 0, Some(empty))], &[&b.wallet]),
        E::ReservedSite,
    );
    let f = w.citizen(&mut c, "f", nation(far));
    assert_code(
        c.send(&[place(&c, &w, &f, far, 0, Some(settled))], &[&f.wallet]),
        E::ReservedSite,
    );
    // A settled witness within reach: the home lands, under the CU row.
    let landed = expect_lands(
        c.send(&[place(&c, &w, &b, near, 0, Some(settled))], &[&b.wallet]),
        "hull PlaceHome",
    );
    assert!(
        landed.cu <= 40_000,
        "PlaceHome with a witness: {} CU",
        landed.cu
    );
    println!("hull PlaceHome CU {}", landed.cu);
    let hd = c.data(&w.a.holding(near.0 as i32, near.1 as i32, 0));
    assert_eq!(hd[H::STATE], H::STATE_FINAL);
    // The province is settled now: a second home there needs no witness.
    let d = w.citizen(&mut c, "d", nation(near));
    expect_lands(
        c.send(&[place(&c, &w, &d, near, 1, None)], &[&d.wallet]),
        "PlaceHome into a settled province",
    );
    // The heartland stays open without a witness.
    let e = w.citizen(&mut c, "e", nation(empty));
    let heartland = expect_lands(
        c.send(&[place(&c, &w, &e, empty, 0, None)], &[&e.wallet]),
        "heartland PlaceHome",
    );
    println!("heartland PlaceHome CU {}", heartland.cu);
}

/// The ring rule (`spawn_reach` 0) is today's PlaceHome: a witness is
/// refused, a ring outside the heartland is refused even next to a settled
/// province.
#[test]
fn ring_rule_refuses_a_witness() {
    let mut c = Chain::test_beacon();
    let mut p = params();
    p.cq.spawn_reach = 0;
    let w = World::land_v2(&mut c, 42, p);
    let ring2 = w.open_provinces(&mut c, 2, None);
    let ring3 = w.open_provinces(&mut c, 3, None);
    let sd = c.data(&w.a.season);
    let mut seed = [0u8; 32];
    seed.copy_from_slice(&sd[SE::GENESIS_SEED..SE::GENESIS_SEED + 32]);
    let nation = |pq: (i16, i16)| home_nation(coord(pq), PLACEMENT_MIXED, HMR, &seed).unwrap();
    let settled = ring2[0];
    let a = w.citizen(&mut c, "a", nation(settled));
    expect_lands(
        c.send(&[place(&c, &w, &a, settled, 0, None)], &[&a.wallet]),
        "PlaceHome",
    );
    let near = *ring3
        .iter()
        .find(|t| coord(**t).distance(coord(settled)) <= 1)
        .unwrap();
    let b = w.citizen(&mut c, "b", nation(near));
    assert_code(
        c.send(&[place(&c, &w, &b, near, 0, Some(settled))], &[&b.wallet]),
        E::ReservedSite,
    );
    let g = w.citizen(&mut c, "g", nation(ring2[1]));
    assert_code(
        c.send(
            &[place(&c, &w, &g, ring2[1], 0, Some(settled))],
            &[&g.wallet],
        ),
        E::ReservedSite,
    );
    expect_lands(
        c.send(&[place(&c, &w, &g, ring2[1], 0, None)], &[&g.wallet]),
        "PlaceHome",
    );
}
