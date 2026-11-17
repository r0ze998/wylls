//! Map growth beyond the season's `r_max` (S1, ExtendFrontier 0xC1): a
//! season created with `r_max_ceiling > r_max` may raise its outermost
//! ring one ring at a time, on the same occupancy condition as OpenRing;
//! the new ring is then opened by OpenRing, seeded and its Provinces
//! created as any other. Bounded by the ceiling (≤ `R_MAX_HARD`, 128): this
//! is a finite map that can keep growing during play, not an infinite one.
//!
//! Crafted state (each named where used): the Frontier's folded
//! `wedge_occupied` (occupancy that would need many settlements), as in
//! `tests/map.rs`.

use fclient::ix::Site;
use frontier_abi::layout::province::province as PV;
use frontier_abi::layout::world::{frontier as FR, ring_seed as RS};
use frontier_abi::v2::log::CqKind;
use frontier_abi::v2::presets::{SeasonParamsV2, MC_TEST};
use permutation_frontier_svm_tests::chain::{assert_code, expect_lands, Chain, SendResult};
use permutation_frontier_svm_tests::ix::map as mix;
use permutation_frontier_svm_tests::records::one_cq;
use permutation_frontier_svm_tests::world::land::{provinces_of, rd_u16, rd_u32};
use permutation_frontier_svm_tests::world::World;
use permutation_frontier_svm_tests::{FrontierError as E, Signer};
use permutation_rules::frontier::geometry::ProvinceCoord;

/// MC_TEST with `r_max` 4 and a ceiling of 6 (genesis ring 3).
fn growing() -> SeasonParamsV2 {
    let mut p = MC_TEST;
    p.base.r_max = 4;
    p.cq.r_max_ceiling = 6;
    p
}

fn extend(c: &mut Chain, w: &World, d: u16) -> SendResult {
    let ix = fclient::ix::v2::extend_frontier(&w.a, w.keeper.pubkey(), d);
    c.send(&[ix], &[&w.keeper])
}

fn r_max_ext(c: &Chain, w: &World) -> u16 {
    rd_u16(&c.data(&w.a.frontier()), FR::R_MAX_EXT)
}

/// Crafted: wedge 0's folded occupancy at `bps` of its open sites.
fn occupancy(c: &mut Chain, w: &World, bps: u64) {
    let open0 = rd_u32(&c.data(&w.a.frontier()), FR::WEDGE_OPEN);
    assert!(open0 > 0, "wedge 0 has open sites (fold first)");
    let occ = (open0 as u64 * bps / 10_000) as u32;
    c.edit(&w.a.frontier(), |d| {
        d[FR::WEDGE_OCCUPIED..FR::WEDGE_OCCUPIED + 4].copy_from_slice(&occ.to_le_bytes())
    });
}

/// Seeds ring `d` (OpenRing landed): the Clock moves to its round.
fn seed_ring(c: &mut Chain, w: &World, d: u16) {
    let round = rd_u64(&c.data(&w.a.ring_seed(d)), RS::ROUND);
    c.set_time(World::round_time(round));
    let arg = w.beacons.must(round);
    let ix = mix::consume_ring_seed(&w.a, w.keeper.pubkey(), d, &arg);
    expect_lands(c.send(&[ix], &[&w.keeper]), "ConsumeRingSeed");
    assert_eq!(c.data(&w.a.ring_seed(d))[RS::STATUS], RS::STATUS_SEEDED);
}

fn rd_u64(d: &[u8], o: usize) -> u64 {
    u64::from_le_bytes(d[o..o + 8].try_into().unwrap())
}

fn terrain_bytes(c: &Chain, w: &World, (p, q): (i16, i16)) -> Vec<u8> {
    c.data(&w.a.province(p as i32, q as i32))[PV::TERRAIN..PV::SITE_MIRROR].to_vec()
}

fn dist(a: (i16, i16), b: (i16, i16)) -> u32 {
    ProvinceCoord::new(a.0 as i32, a.1 as i32).distance(ProvinceCoord::new(b.0 as i32, b.1 as i32))
}

/// A season without a ceiling (every preset today) cannot grow: `r_max`
/// stays final and the Frontier's `r_max_ext` stays 0.
#[test]
fn extend_frontier_refused_without_a_ceiling() {
    let mut c = Chain::test_beacon();
    let w = World::land_v2(&mut c, 1, MC_TEST);
    assert_eq!(MC_TEST.cq.r_max_ceiling, 0);
    let r = MC_TEST.base.r_max;
    assert_code(extend(&mut c, &w, r + 1), E::BadData);
    assert_eq!(r_max_ext(&c, &w), 0);
    // Past r_max nothing opens, as before.
    assert_code(w.open_ring(&mut c, r + 1), E::BadData);
    assert_code(w.open_province(&mut c, r as i16 + 1, 0), E::BadData);
}

/// The growth path end to end: refusals, one extension (no duplicate on a
/// repeat), the new ring opened, seeded and its Province created once,
/// the old land untouched, and an outpost filed across the old border.
#[test]
fn extend_frontier_grows_one_ring_and_keeps_the_old_land() {
    let mut c = Chain::test_beacon();
    let w = World::land_v2(&mut c, 1, growing());
    assert_eq!(w.rings_opened(&c), 4, "genesis rings 0-3");
    // A home in ring 2 and a ring-3 province, their terrain recorded.
    let home = provinces_of(2, Some(0))[0];
    let e = w.final_estate(&mut c, "a", 0, home, 0, 10_000);
    let t3 = provinces_of(3, Some(0))[0];
    expect_lands(w.open_province(&mut c, t3.0, t3.1), "OpenProvince (ring 3)");
    let before = [terrain_bytes(&c, &w, home), terrain_bytes(&c, &w, t3)];
    w.fold(&mut c);

    // Refusals before ring 4 (= r_max) is open.
    assert_code(extend(&mut c, &w, 5), E::TooEarly); // ring 4 not open
    assert_code(extend(&mut c, &w, 4), E::AlreadyDone); // within r_max
    assert_code(extend(&mut c, &w, 6), E::TooEarly); // not r + 1
    assert_code(extend(&mut c, &w, 7), E::BadData); // beyond the ceiling
    assert_code(w.open_ring(&mut c, 5), E::BadData); // beyond r_max

    // Ring 4 (the season's r_max) opens as any ring.
    c.advance(600);
    occupancy(&mut c, &w, 10_000);
    expect_lands(w.open_ring(&mut c, 4), "OpenRing(4)");
    // The same bell as the last opening.
    assert_code(extend(&mut c, &w, 5), E::TooEarly);
    seed_ring(&mut c, &w, 4);
    c.advance(600);
    // Below θ: no wedge crowded enough.
    occupancy(&mut c, &w, 0);
    assert_code(extend(&mut c, &w, 5), E::Capacity);
    occupancy(&mut c, &w, 10_000);
    let l = expect_lands(extend(&mut c, &w, 5), "ExtendFrontier");
    let r = one_cq(&l.logs, CqKind::FRONTIER_EXTENDED);
    assert_eq!(r.u64("from"), 4);
    assert_eq!(r.u64("ceiling"), 6);
    assert_eq!(r_max_ext(&c, &w), 5);
    assert_eq!(w.rings_opened(&c), 5, "ExtendFrontier opens no ring");
    // A repeat (or a copy of the same transaction) changes nothing.
    assert_code(extend(&mut c, &w, 5), E::AlreadyDone);
    assert_eq!(r_max_ext(&c, &w), 5);

    // Ring 5 opens, is seeded, and its Province is created once.
    c.advance(600);
    expect_lands(w.open_ring(&mut c, 5), "OpenRing(5)");
    seed_ring(&mut c, &w, 5);
    let t5 = provinces_of(5, None)
        .into_iter()
        .find(|x| dist(home, *x) <= 3)
        .expect("a ring-5 province within 3 of the home");
    expect_lands(w.open_province(&mut c, t5.0, t5.1), "OpenProvince (ring 5)");
    assert_code(w.open_province(&mut c, t5.0, t5.1), E::AlreadyDone);
    // Ring 6 is within the ceiling but not opened; ring 7 is outside.
    let t6 = provinces_of(6, Some(0))[0];
    assert_code(w.open_province(&mut c, t6.0, t6.1), E::SeedNotReady);
    let t7 = provinces_of(7, Some(0))[0];
    assert_code(w.open_province(&mut c, t7.0, t7.1), E::BadData);
    assert_code(w.open_ring(&mut c, 6), E::BadData); // r_max is now 5

    // The old land is byte-for-byte the same.
    assert_eq!(terrain_bytes(&c, &w, home), before[0]);
    assert_eq!(terrain_bytes(&c, &w, t3), before[1]);

    // Across the old border: an outpost from the ring-2 home into ring 5.
    w.fold(&mut c);
    let s = w.free_sites(&c, t5.0, t5.1)[0];
    let ix = w.file_outpost_ix(
        &e,
        &[Site {
            p: t5.0,
            q: t5.1,
            site: s,
        }],
        &e,
    );
    expect_lands(c.send(&[ix], &[&e.wallet]), "FileOutpost (ring 5)");
}
