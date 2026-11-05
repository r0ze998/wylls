//! Narrow SVM coverage for creating a continuous world on the existing,
//! fixed map. The program's real CreateSeason writes this state; no finite
//! Season or old prize pool is migrated by these tests.

use frontier_abi::layout::world::season as S;
use frontier_abi::presets::NO_END_BELL;
use frontier_abi::v2::error::CqError;
use frontier_abi::v2::presets::{cq_layout, S1_LOCAL_7D, SEASON_CQ_OFFSET};
use permutation_frontier_svm_tests::chain::{assert_code, expect_lands, Chain};
use permutation_frontier_svm_tests::ix::season::end_season;
use permutation_frontier_svm_tests::world::{params_v2_for, World};
use permutation_frontier_svm_tests::{FrontierError as E, Signer};

fn u32_at(data: &[u8], at: usize) -> u32 {
    u32::from_le_bytes(data[at..at + 4].try_into().unwrap())
}

#[test]
fn continuous_world_is_created_and_accepts_later_join() {
    let mut p = S1_LOCAL_7D;
    p.cq.continuous = 1;
    p.base.end_bell = NO_END_BELL;
    p.base.join_close_bell = NO_END_BELL;
    assert_eq!(p.validate(), Ok(()));

    let mut c = Chain::release();
    // land_v2 performs Announce, Create, beacon/shard initialization and
    // genesis through the deployed program, then opens the genesis rings.
    let w = World::land_v2(&mut c, 31, p);
    let created = c.data(&w.a.season);
    assert_eq!(created[S::STATUS], S::STATUS_SEEDED);
    assert_eq!(u32_at(&created, S::END_BELL), NO_END_BELL);
    assert_eq!(u32_at(&created, S::JOIN_CLOSE_BELL), NO_END_BELL);
    assert_eq!(created[SEASON_CQ_OFFSET + cq_layout::CONTINUOUS], 1);
    assert_eq!(
        &created[SEASON_CQ_OFFSET + cq_layout::RSV_PRE_CONTINUOUS
            ..SEASON_CQ_OFFSET + cq_layout::CONTINUOUS],
        &[0; 3],
        "the map extension bytes remain reserved"
    );
    assert_eq!(
        &created[S::PARAMS_HASH..S::PARAMS_HASH + 32],
        &w.params.hash(),
        "Announce and Create committed to the same parameters"
    );

    // The old 28-day endpoint is only a checkpoint in this world. Join is
    // still possible while the existing fixed map has capacity.
    c.set_time(w.bell_end(4_033));
    let joiner = c.funded(b"continuous-created-late-joiner", 10);
    expect_lands(w.join(&mut c, &joiner, 3), "Join after old endpoint");

    let any = c.funded(b"continuous-created-end", 1);
    let before = c.account(&w.a.season).unwrap();
    assert_code(
        c.send(&[end_season(&w.a, any.pubkey())], &[&any]),
        CqError::ContinuousWorld,
    );
    let after = c.account(&w.a.season).unwrap();
    assert_eq!(after.data, before.data, "EndSeason must not change history");
    assert_eq!(after.lamports, before.lamports);
    assert_eq!(after.owner, before.owner);
}

#[test]
fn continuous_world_requires_both_no_end_values() {
    // A continuous flag with a finite join close, or an unflagged world
    // with an unlimited end, is not this protocol's creation contract.
    for (id, flag, end, join) in [(32, 1, NO_END_BELL, 756), (33, 0, NO_END_BELL, 756)] {
        let mut p = S1_LOCAL_7D;
        p.cq.continuous = flag;
        p.base.end_bell = end;
        p.base.join_close_bell = join;
        assert!(p.validate().is_err());
        let mut c = Chain::release();
        let p = params_v2_for(&c, p);
        let w = World::with_v2(&mut c, id, p);
        expect_lands(w.announce(&mut c), "Announce invalid creation params");
        assert_code(w.create(&mut c), E::BadData);
        assert_eq!(c.data(&w.a.season)[S::STATUS], S::STATUS_ANNOUNCED);
        assert!(c.is_absent(&w.a.frontier()));
    }
}

#[test]
fn finite_world_still_ends() {
    let mut c = Chain::release();
    let w = World::land_v2(&mut c, 34, S1_LOCAL_7D);
    let d = c.data(&w.a.season);
    assert_eq!(d[SEASON_CQ_OFFSET + cq_layout::CONTINUOUS], 0);
    assert_eq!(u32_at(&d, S::END_BELL), S1_LOCAL_7D.base.end_bell);
    // The unlimited join deadline belongs only to a new continuous world.
    c.set_time(w.bell_end(S1_LOCAL_7D.base.join_close_bell));
    let late_joiner = c.funded(b"finite-created-late-joiner", 10);
    assert_code(w.join(&mut c, &late_joiner, 3), E::WrongStatus);
    c.set_time(w.end_ts());
    let any = c.funded(b"finite-created-end", 1);
    expect_lands(
        c.send(&[end_season(&w.a, any.pubkey())], &[&any]),
        "finite EndSeason",
    );
    assert_eq!(c.data(&w.a.season)[S::STATUS], S::STATUS_ENDED);
}
