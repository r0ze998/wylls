//! world4-pacing-impl: the NEXT world's pacing rules on the real SBF program
//! (test-beacon build, any round, I-53), each against a legacy world that
//! takes the same instructions (the world-3 side: `pacing` 0).
//!
//! - CreateSeason stores the pacing bytes and refuses the new-world values
//!   without `pacing` 1 (BadData) — the deliberate-break side of the gate;
//! - Depart: an arrival 1 bell after the departure lands only in a paced
//!   world (ArrivalBell in a legacy one); the Depart stamina is the Season's
//!   `depart_stamina` (the transit records it);
//! - Reveal of such a 1-bell march lands (paced) and its arrival bell still
//!   has to fit the path (a long path is ArrivalBell either way);
//! - PlaceHome's starter host: a muster-pending Spearman entry of
//!   `starter_host` troops and a MUSTER record in a paced world; nothing in
//!   a legacy one;
//! - SetWindowSchedule: 300 s only in a paced world.
//!
//! Crafted accounts as in `reveal.rs` (`world::holding`): the estates and
//! hosts are written as W3-A's instructions leave them; the Seasons are made
//! by the program's own AnnounceSeason / CreateSeason.

mod common;

use frontier_abi::layout::player::{holding as H, transit as T};
use frontier_abi::layout::world::season as SL;
use frontier_abi::log::Kind;
use frontier_abi::v2::layout::player::citizen as C;
use frontier_abi::v2::layout::province::province as P;
use frontier_abi::v2::presets::{
    cq_layout, pacing_fast, SeasonParamsV2, PACING_FAST_V1, S1_LOCAL_7D, S1_TEST, SEASON_CQ_OFFSET,
};
use permutation_frontier_svm_tests::chain::{assert_code, expect_lands, Chain};
use permutation_frontier_svm_tests::fixtures::tlock::SealCase;
use permutation_frontier_svm_tests::records::one;
use permutation_frontier_svm_tests::world::holding::{open_path, u32_at};
use permutation_frontier_svm_tests::world::{params_v2_for, World};
use permutation_frontier_svm_tests::{FrontierError as E, Signer};

const B0: u32 = 10;

/// A Running world of `p` (the program's own lifecycle), Clock at genesis.
fn running_v2(c: &mut Chain, id: u64, p: SeasonParamsV2) -> World {
    let p = params_v2_for(c, p);
    let w = World::with_v2(c, id, p);
    expect_lands(w.announce(c), "AnnounceSeason");
    expect_lands(w.create(c), "CreateSeason");
    expect_lands(w.init_logs(c), "InitBeaconLogs");
    for f in 0..6 {
        expect_lands(w.init_shards(c, f), "InitShards");
    }
    expect_lands(w.consume_genesis(c), "ConsumeGenesisSeed");
    let g = w.genesis_ts();
    if c.now < g {
        c.set_time(g);
    }
    w
}

fn legacy() -> SeasonParamsV2 {
    S1_LOCAL_7D
}

fn paced() -> SeasonParamsV2 {
    pacing_fast(S1_LOCAL_7D)
}

#[test]
fn create_season_stores_the_pacing_bytes_and_legacy_stays_zero() {
    let mut c = Chain::test_beacon();
    let w = running_v2(&mut c, 41, paced());
    let d = c.data(&w.a.season);
    let cq = SEASON_CQ_OFFSET;
    assert_eq!(d[cq + cq_layout::PACING], PACING_FAST_V1);
    assert_eq!(d[cq + cq_layout::DEPART_STAMINA], 74);
    assert_eq!(
        u16::from_le_bytes([
            d[cq + cq_layout::STARTER_HOST],
            d[cq + cq_layout::STARTER_HOST + 1]
        ]),
        500
    );
    assert_eq!(d[SL::MIN_LEAD], 1);
    assert_eq!(u32_at(&d, SL::REVEAL_WINDOW), 300);
    let mut c = Chain::test_beacon();
    let w = running_v2(&mut c, 42, legacy());
    let d = c.data(&w.a.season);
    assert!(d[cq + cq_layout::PACING..cq + cq_layout::RSV]
        .iter()
        .all(|b| *b == 0));
    assert_eq!(d[SL::MIN_LEAD], 2);
}

#[test]
fn create_season_refuses_new_world_values_without_pacing() {
    for (what, f) in [
        (
            "min_lead 1",
            (|p: &mut SeasonParamsV2| p.base.min_lead = 1) as fn(&mut SeasonParamsV2),
        ),
        ("reveal 300", |p| p.base.reveal_window = 300),
        ("stamina 37", |p| p.cq.depart_stamina = 37),
        ("starter 500", |p| p.cq.starter_host = 500),
    ] {
        let mut c = Chain::test_beacon();
        let mut p = legacy();
        f(&mut p);
        let p = params_v2_for(&c, p);
        let w = World::with_v2(&mut c, 43, p);
        expect_lands(w.announce(&mut c), "AnnounceSeason");
        assert_code(w.create(&mut c), E::BadData);
        let _ = what;
    }
}

/// A host of estate "a" departing B0 on `dirs`, arriving at `B0 + lead`.
fn depart_world(
    p: SeasonParamsV2,
    id: u64,
    dirs: &[u8],
    lead: u32,
) -> (
    Chain,
    World,
    permutation_frontier_svm_tests::world::holding::Estate,
    permutation_frontier_svm_tests::world::holding::March,
    permutation_frontier_svm_tests::chain::SendResult,
) {
    let mut c = Chain::test_beacon();
    let w = running_v2(&mut c, id, p);
    w.to_bell(&mut c, B0, 5);
    let e = w.craft_estate(&mut c, "a", 0, (2, 0), 0);
    let hid = w.craft_host(&mut c, &e, &e.province, 0, 0, 0, 900, e.tile);
    let origin = (e.p as i32, e.q as i32, e.tile);
    open_path(&w, &mut c, origin, dirs);
    let m = w.plan_march(hid, 0, origin, dirs, B0 + lead, 1, 0, SealCase::Valid);
    let tip = w.tip_min(&c);
    let r = c.send(&[w.depart_ix(&e, (e.p, e.q), &m, tip)], &[&e.wallet]);
    (c, w, e, m, r)
}

#[test]
fn a_one_bell_arrival_departs_only_in_a_paced_world() {
    let (_, _, _, _, r) = depart_world(legacy(), 44, &[0], 1);
    assert_code(r, E::ArrivalBell);
    let (c, w, e, _, r) = depart_world(paced(), 45, &[0], 1);
    expect_lands(r, "Depart (lead 1, paced)");
    let hd = c.data(&w.a.holding(e.p as i32, e.q as i32, e.site));
    let t0 = H::transit(0);
    assert_eq!(u32_at(&hd, t0 + T::ARRIVE_BELL), B0 + 1);
    assert_eq!(
        u16::from_le_bytes([hd[t0 + T::MARCH_STAMINA], hd[t0 + T::MARCH_STAMINA + 1]]),
        74
    );
    // (lead 2 still lands in both)
    let (_, _, _, _, r) = depart_world(legacy(), 46, &[0], 2);
    expect_lands(r, "Depart (lead 2, legacy)");
}

#[test]
fn the_depart_stamina_is_the_seasons() {
    let mut p = paced();
    p.cq.depart_stamina = 37;
    let (c, w, e, _, r) = depart_world(p, 47, &[0, 0], 2);
    expect_lands(r, "Depart (stamina 37)");
    let hd = c.data(&w.a.holding(e.p as i32, e.q as i32, e.site));
    let t0 = H::transit(0);
    assert_eq!(
        u16::from_le_bytes([hd[t0 + T::MARCH_STAMINA], hd[t0 + T::MARCH_STAMINA + 1]]),
        37
    );
    let (c, w, e, _, r) = depart_world(legacy(), 48, &[0, 0], 2);
    expect_lands(r, "Depart (legacy)");
    let hd = c.data(&w.a.holding(e.p as i32, e.q as i32, e.site));
    assert_eq!(
        u16::from_le_bytes([hd[t0 + T::MARCH_STAMINA], hd[t0 + T::MARCH_STAMINA + 1]]),
        74
    );
}

#[test]
fn a_one_bell_march_reveals_in_a_paced_world_and_must_still_fit_its_path() {
    let (mut c, w, e, m, r) = depart_world(paced(), 49, &[0], 1);
    expect_lands(r, "Depart (lead 1)");
    let region = World::region(m.dest.0, m.dest.1);
    expect_lands(w.post_anchor(&mut c, m.arrive, region), "PostAnchor");
    let ix = w.reveal_ix(&w.keeper.pubkey(), &e, &m, 0, true);
    let landed = expect_lands(c.send(&[ix], &[&w.keeper]), "Reveal (lead 1)");
    println!("reveal lead-1 CU {}", landed.cu);
    // 20 steps (≥ 2,400 s) cannot arrive 1 bell (nor 2) after the departure, paced or not.
    let dirs = [0u8; 20];
    let (mut c, w, e, m, r) = depart_world(paced(), 50, &dirs, 1);
    expect_lands(r, "Depart (lead 1, long path)");
    let region = World::region(m.dest.0, m.dest.1);
    expect_lands(w.post_anchor(&mut c, m.arrive, region), "PostAnchor");
    let ix = w.reveal_ix(&w.keeper.pubkey(), &e, &m, 0, true);
    assert_code(c.send(&[ix], &[&w.keeper]), E::ArrivalBell);
}

/// A citizen of nation 0 placing a first home in a heartland province of `p`.
fn place_first_home(
    p: SeasonParamsV2,
    id: u64,
) -> (
    Chain,
    World,
    fclient::ix::Site,
    permutation_frontier_svm_tests::chain::Landed,
) {
    let mut c = Chain::test_beacon();
    let w = running_v2(&mut c, id, p);
    w.open_genesis_rings(&mut c);
    let ps = w.open_provinces(&mut c, 2, Some(0));
    let who = w.citizen(&mut c, "first-home", 0);
    let s = fclient::ix::Site {
        p: ps[0].0,
        q: ps[0].1,
        site: 0,
    };
    let d = w.citizen_data(&c, &who);
    let tx = fclient::ix::place_home(&w.a, &who.player(), s, who.faction, d[C::JOIN_SHARD]);
    let landed = expect_lands(c.send_client(&[tx], &[&who.wallet]), "PlaceHome");
    (c, w, s, landed)
}

#[test]
fn place_home_gives_the_starter_host_only_in_a_paced_world() {
    // (S1_TEST keeps the wedge placement: wedge 0's heartland province is nation 0's)
    let (c, w, s, landed) = place_first_home(pacing_fast(S1_TEST), 51);
    println!("PlaceHome with starter host CU {}", landed.cu);
    assert!(
        landed.cu <= 40_000,
        "PlaceHome CU {} over its 40,000 row",
        landed.cu
    );
    let rec = one(&landed.logs, Kind::MUSTER);
    let pd = c.data(&w.a.province(s.p as i32, s.q as i32));
    let hd = c.data(&w.a.holding(s.p as i32, s.q as i32, s.site));
    let entries: Vec<_> = (0..P::ENTRIES_N)
        .map(|i| frontier_abi::entry::read_entry(&pd, i).unwrap())
        .filter(|e| e.state != 0)
        .collect();
    assert_eq!(entries.len(), 1, "one starter host");
    let e = entries[0];
    assert_eq!(
        e.state,
        frontier_abi::layout::province::entry::STATE_MUSTER_PENDING
    );
    assert_eq!(e.troops, 500 * 1000);
    assert_eq!(e.unit, 0);
    assert_eq!(e.tile, hd[H::TILE]);
    let t = rec.field("troops", true);
    assert_eq!(u32::from_le_bytes([t[0], t[1], t[2], t[3]]), 500);
    assert_eq!(u32_at(&hd, H::HOST_SEQ), 1);
    assert_eq!(u32_at(&hd, H::reserve(0)), 0);
    let (c, w, s, landed) = place_first_home(S1_TEST, 52);
    println!("PlaceHome legacy CU {}", landed.cu);
    assert!(
        permutation_frontier_svm_tests::records::of_kind(&landed.logs, Kind::MUSTER).is_empty()
    );
    let pd = c.data(&w.a.province(s.p as i32, s.q as i32));
    assert!((0..P::ENTRIES_N).all(|i| frontier_abi::entry::read_entry(&pd, i).unwrap().state == 0));
    let hd = c.data(&w.a.holding(s.p as i32, s.q as i32, s.site));
    assert_eq!(u32_at(&hd, H::HOST_SEQ), 0);
}

#[test]
fn a_300_s_window_schedule_only_in_a_paced_world() {
    for (p, id, ok) in [(paced(), 53, true), (legacy(), 54, false)] {
        let mut c = Chain::test_beacon();
        let w = running_v2(&mut c, id, p);
        let from_bell = w.bell_at(c.now).expect("running") + 200;
        let ix = permutation_frontier_svm_tests::ix::season::set_window_schedule(
            &w.a,
            w.authority.pubkey(),
            300,
            from_bell,
        );
        let r = c.send(&[ix], &[&w.authority]);
        if ok {
            expect_lands(r, "SetWindowSchedule 300 (paced)");
        } else {
            assert_code(r, E::BadData);
        }
    }
}

/// (verify-pr279) Q-PM2-3's safety argument on chain: a march arriving ONE bell after its departure into a defended
/// province of a paced world. The destination's battle of `B0 + 1` must wait for the origin's battle of `B0`
/// (`DepartureUnsettled` while the origin is unresolved and SettleDeparture not landed), and its result must not
/// depend on that wait (the G7 lag property at lead 1): the CLASH input and outcome digests and the fates are the same
/// whether the origin settled before the reveal or only after the destination's close.
fn lead1_into_defended(hold: bool, real_origin: bool) -> (Vec<u8>, Vec<u8>, Vec<u8>) {
    use permutation_frontier_svm_tests::ix::host as hix;
    use permutation_frontier_svm_tests::world::clash::THIRDS;
    const DIRS: [u8; 2] = [0, 0];
    let mut c = Chain::test_beacon();
    let w = running_v2(&mut c, 60 + real_origin as u64, paced());
    w.to_bell(&mut c, B0, 5);
    let e = w.craft_estate(&mut c, "lag-a", 0, (2, 0), 0);
    let origin = (e.p as i32, e.q as i32, e.tile);
    let steps = permutation_frontier_svm_tests::world::holding::trace(origin, &DIRS);
    let last = *steps.last().unwrap();
    let dest = (last.p, last.q);
    assert_ne!(dest, (origin.0, origin.1), "the march leaves its province");
    let d = w.craft_estate(&mut c, "lag-d", 1, (dest.0 as i16, dest.1 as i16), 0);
    open_path(&w, &mut c, origin, &DIRS);
    w.craft_host(&mut c, &d, &d.province, 0, 0, 0, 600, last.tile);
    let id = w.craft_host(&mut c, &e, &e.province, 0, 0, 0, 900, e.tile);
    let arrive = B0 + 1;
    let m = w.plan_march(id, 1, origin, &DIRS, arrive, 1, 0, SealCase::Valid);
    let tip = w.tip_min(&c);
    expect_lands(
        c.send(&[w.depart_ix(&e, (e.p, e.q), &m, tip)], &[&e.wallet]),
        "Depart (lead 1)",
    );
    let origin_region = World::region(origin.0, origin.1);
    let dest_region = World::region(dest.0, dest.1);
    let settle_origin = |c: &mut Chain| {
        if real_origin {
            w.set_resolved_next(c, &e.province, B0);
            w.ready_bell(c, B0, origin_region, None);
            for ix in w.gather_parts(c, (origin.0, origin.1), B0, &THIRDS) {
                expect_lands(c.send(&[ix], &[&w.keeper]), "GatherClash (origin)");
            }
            expect_lands(
                c.send(&[w.resolve_ix((origin.0, origin.1), B0)], &[&w.keeper]),
                "ResolveFromInputs (origin)",
            );
        } else {
            w.resolve_through(c, &e.province, B0);
        }
        let settle = hix::settle_departure(&w.a, w.keeper.pubkey(), (e.p, e.q), e.href(), 1);
        expect_lands(c.send(&[settle], &[&w.keeper]), "SettleDeparture");
        if w.anchor_a(c, B0, origin_region).is_none() {
            expect_lands(w.post_anchor(c, B0, origin_region), "origin anchor");
        }
    };
    if !hold {
        settle_origin(&mut c);
    }
    if w.anchor_a(&c, arrive, dest_region).is_none() {
        expect_lands(w.post_anchor(&mut c, arrive, dest_region), "PostAnchor");
    }
    let rv = w.reveal_ix(&w.keeper.pubkey(), &e, &m, 0, true);
    expect_lands(c.send(&[rv], &[&w.keeper]), "Reveal (lead 1)");
    w.set_resolved_next(&mut c, &d.province, arrive);
    w.ready_bell(&mut c, arrive, dest_region, None);
    if hold {
        let g = w.gather_parts(&c, dest, arrive, &THIRDS);
        assert_code(
            c.fork().send(&[g[0].clone()], &[&w.keeper]),
            E::DepartureUnsettled,
        );
        c.advance(2 * 600);
        settle_origin(&mut c);
    }
    for ix in w.gather_parts(&c, dest, arrive, &THIRDS) {
        expect_lands(c.send(&[ix], &[&w.keeper]), "GatherClash");
    }
    let l = expect_lands(
        c.send(&[w.resolve_ix(dest, arrive)], &[&w.keeper]),
        "ResolveFromInputs",
    );
    let clash = one(&l.logs, Kind::CLASH);
    assert!(
        clash.u64("engagements") > 0,
        "the arrival fought the resident"
    );
    (
        clash.field("input_digest", true).to_vec(),
        clash.field("outcome_digest", true).to_vec(),
        clash.field("fates", true).to_vec(),
    )
}

#[test]
fn a_one_bell_march_waits_for_its_origin_and_its_battle_does_not_depend_on_the_wait() {
    for real_origin in [false, true] {
        let unheld = lead1_into_defended(false, real_origin);
        let held = lead1_into_defended(true, real_origin);
        assert_eq!(
            unheld, held,
            "real_origin {real_origin}: lead-1 battle identical held and unheld"
        );
    }
}
