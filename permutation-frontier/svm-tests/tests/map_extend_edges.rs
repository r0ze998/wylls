//! Map growth edges (ExtendFrontier 0xC1, workstream 08 follow-up), beside
//! `tests/map_extend.rs`: every refusal leaves the Frontier byte-identical
//! (no partial update), two extensions in one transaction are all or
//! nothing, the program's hard limit (ring 128, `R_MAX_HARD`) is the last
//! ring an extension can reach, and a finite season does not grow once its
//! end bell has come. Bounded growth: never an infinite map.
//!
//! Crafted state (each named where used): the Frontier's folded
//! `wedge_occupied` (as `tests/map.rs`), and for the hard limit the
//! Frontier's `rings_opened` / `r_max_ext` (opening 127 rings one by one
//! is out of a unit test's reach; the program reads only these fields).

use frontier_abi::layout::world::{frontier as FR, ring_seed as RS, season as S};
use frontier_abi::v2::presets::{SeasonParamsV2, MC_TEST};
use permutation_frontier_svm_tests::chain::{assert_code, expect_lands, Chain, SendResult};
use permutation_frontier_svm_tests::ix::map as mix;
use permutation_frontier_svm_tests::world::land::{rd_u16, rd_u32};
use permutation_frontier_svm_tests::world::World;
use permutation_frontier_svm_tests::{FrontierError as E, Instruction, Signer};
use permutation_rules::frontier::geometry::R_MAX_HARD;

/// MC_TEST with `r_max` 4 and a ceiling (genesis ring 3).
fn growing(ceiling: u16) -> SeasonParamsV2 {
    let mut p = MC_TEST;
    p.base.r_max = 4;
    p.cq.r_max_ceiling = ceiling;
    p
}

fn ext_ix(w: &World, d: u16) -> Instruction {
    fclient::ix::v2::extend_frontier(&w.a, w.keeper.pubkey(), d)
}

fn extend(c: &mut Chain, w: &World, d: u16) -> SendResult {
    let ix = ext_ix(w, d);
    c.send(&[ix], &[&w.keeper])
}

fn frontier(c: &Chain, w: &World) -> Vec<u8> {
    c.data(&w.a.frontier())
}

fn r_max_ext(c: &Chain, w: &World) -> u16 {
    rd_u16(&frontier(c, w), FR::R_MAX_EXT)
}

/// Crafted: wedge 0's folded occupancy at `bps` of its open sites.
fn occupancy(c: &mut Chain, w: &World, bps: u64) {
    let open0 = rd_u32(&frontier(c, w), FR::WEDGE_OPEN);
    assert!(open0 > 0, "wedge 0 has open sites (fold first)");
    let occ = (open0 as u64 * bps / 10_000) as u32;
    c.edit(&w.a.frontier(), |d| {
        d[FR::WEDGE_OCCUPIED..FR::WEDGE_OCCUPIED + 4].copy_from_slice(&occ.to_le_bytes())
    });
}

fn rd_u64(d: &[u8], o: usize) -> u64 {
    u64::from_le_bytes(d[o..o + 8].try_into().unwrap())
}

/// A season of `ceiling` with ring 4 (its `r_max`) open and seeded, a bell
/// past that opening, wedge 0 crowded: ExtendFrontier(5) would land now.
fn ready(ceiling: u16) -> (Chain, World) {
    let mut c = Chain::test_beacon();
    let w = World::land_v2(&mut c, 1, growing(ceiling));
    // Ring-3 provinces of wedge 0 (open sites for the fold).
    w.open_provinces(&mut c, 3, Some(0));
    w.fold(&mut c);
    c.advance(600);
    occupancy(&mut c, &w, 10_000);
    expect_lands(w.open_ring(&mut c, 4), "OpenRing(4)");
    let round = rd_u64(&c.data(&w.a.ring_seed(4)), RS::ROUND);
    c.set_time(World::round_time(round));
    let arg = w.beacons.must(round);
    let ix = mix::consume_ring_seed(&w.a, w.keeper.pubkey(), 4, &arg);
    expect_lands(c.send(&[ix], &[&w.keeper]), "ConsumeRingSeed(4)");
    c.advance(600);
    occupancy(&mut c, &w, 10_000);
    (c, w)
}

/// Every refusal leaves the Frontier byte-identical: nothing is written
/// before the last check passes (no partial update).
#[test]
fn extend_frontier_refusals_leave_the_frontier_untouched() {
    let (mut c, w) = ready(6);
    let before = frontier(&c, &w);
    for (d, code) in [
        (0u16, E::AlreadyDone),
        (4, E::AlreadyDone),
        (6, E::TooEarly),
        (7, E::BadData),
        (u16::MAX, E::BadData),
    ] {
        assert_code(extend(&mut c, &w, d), code);
        assert_eq!(
            frontier(&c, &w),
            before,
            "ExtendFrontier({d}) wrote nothing"
        );
    }
    // Below θ: refused for capacity, still nothing written.
    occupancy(&mut c, &w, 0);
    let low = frontier(&c, &w);
    assert_code(extend(&mut c, &w, 5), E::Capacity);
    assert_eq!(frontier(&c, &w), low);
    assert_eq!(r_max_ext(&c, &w), 0);
}

/// Two extensions in one transaction are all or nothing: a duplicate of
/// the same request, or the next ring in the same transaction, fails the
/// whole transaction and leaves the Frontier as it was; the request alone
/// then lands once, and its copy is AlreadyDone.
#[test]
fn extend_frontier_twice_in_one_transaction_is_all_or_nothing() {
    let (mut c, w) = ready(8);
    let before = frontier(&c, &w);
    let dup = c.send(&[ext_ix(&w, 5), ext_ix(&w, 5)], &[&w.keeper]);
    assert_code(dup, E::AlreadyDone);
    assert_eq!(frontier(&c, &w), before, "a duplicate rolls the first back");
    let next = c.send(&[ext_ix(&w, 5), ext_ix(&w, 6)], &[&w.keeper]);
    assert_code(next, E::TooEarly); // ring 5 is not opened in between
    assert_eq!(
        frontier(&c, &w),
        before,
        "the second ring rolls the first back"
    );
    expect_lands(extend(&mut c, &w, 5), "ExtendFrontier(5) alone");
    assert_eq!(r_max_ext(&c, &w), 5);
    let after = frontier(&c, &w);
    assert_code(extend(&mut c, &w, 5), E::AlreadyDone);
    assert_eq!(frontier(&c, &w), after);
}

/// The hard limit: a season whose ceiling is `R_MAX_HARD` (128) reaches
/// ring 128 and no further; nothing past it is created or opened.
#[test]
fn extend_frontier_stops_at_the_hard_limit() {
    assert_eq!(R_MAX_HARD, 128);
    let (mut c, w) = ready(R_MAX_HARD);
    // Crafted: rings 0..127 opened and the extension at 127 (what 123
    // extensions and openings would leave), a bell past the last opening.
    c.edit(&w.a.frontier(), |d| {
        d[FR::RINGS_OPENED..FR::RINGS_OPENED + 2].copy_from_slice(&128u16.to_le_bytes());
        d[FR::R_MAX_EXT..FR::R_MAX_EXT + 2].copy_from_slice(&127u16.to_le_bytes());
    });
    c.advance(600);
    assert_code(extend(&mut c, &w, 129), E::BadData);
    let l = expect_lands(extend(&mut c, &w, 128), "ExtendFrontier(128)");
    let _ = l;
    assert_eq!(r_max_ext(&c, &w), 128);
    assert_code(extend(&mut c, &w, 128), E::AlreadyDone);
    assert_code(extend(&mut c, &w, 129), E::BadData);
    // Past the hard limit nothing opens: OpenRing(129) is beyond r_max.
    c.edit(&w.a.frontier(), |d| {
        d[FR::RINGS_OPENED..FR::RINGS_OPENED + 2].copy_from_slice(&129u16.to_le_bytes());
    });
    c.advance(600);
    assert_code(w.open_ring(&mut c, 129), E::BadData);
    assert_code(w.open_province(&mut c, 129, 0), E::BadData);
}

/// A finite season does not grow once its end bell has come, whether or
/// not EndSeason was sent yet (the effective status stays Running until
/// it is): the map at the end is the map the season ends with.
#[test]
fn extend_frontier_refused_from_the_end_bell() {
    let (mut c, w) = ready(6);
    let end_bell = rd_u32(&c.data(&w.a.season), S::END_BELL);
    w.to_bell(&mut c, end_bell, 1);
    occupancy(&mut c, &w, 10_000);
    let before = frontier(&c, &w);
    assert_code(extend(&mut c, &w, 5), E::WrongStatus);
    assert_eq!(frontier(&c, &w), before);
    // After EndSeason: the status is Ended, refused as before.
    let ix = fclient::ix::end_season(&w.a, w.keeper.pubkey());
    expect_lands(c.send(&[ix], &[&w.keeper]), "EndSeason");
    assert_code(extend(&mut c, &w, 5), E::WrongStatus);
    assert_eq!(r_max_ext(&c, &w), 0);
}

/// The bell before the end still grows (the boundary is the end bell).
#[test]
fn extend_frontier_lands_in_the_last_bell() {
    let (mut c, w) = ready(6);
    let end_bell = rd_u32(&c.data(&w.a.season), S::END_BELL);
    w.to_bell(&mut c, end_bell - 1, 1);
    occupancy(&mut c, &w, 10_000);
    expect_lands(extend(&mut c, &w, 5), "ExtendFrontier(5) in the last bell");
    assert_eq!(r_max_ext(&c, &w), 5);
}
