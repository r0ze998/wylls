//! Continuous world (migration candidate, conquest `CONTINUOUS` = 1) on the
//! test-beacon build: the world does not end, so work keeps going across
//! the bells where the 7- and 28-day seasons would have ended. 1,008 and
//! 4,032 are **test checkpoints** only (no rule of a continuous world);
//! the caravan and vault cases are in `caravan.rs` (`continuous_world`).
//!
//! Crafted state as `holding.rs` and `reveal.rs` (`world::holding`): the
//! season is made continuous the way CreateSeason stores one (both end
//! bells `NO_END_BELL`, the conquest flag); `continuous_world_is_created`
//! creates one through the program.

mod common;

use frontier_abi::layout::world::season as S;
use frontier_abi::log::Kind;
use frontier_abi::presets::NO_END_BELL;
use frontier_abi::v2::presets::{cq_layout, S1_LOCAL_7D, SEASON_CQ_OFFSET};
use permutation_frontier_svm_tests::chain::{assert_code, expect_lands, Chain, SendResult};
use permutation_frontier_svm_tests::fixtures::tlock::SealCase;
use permutation_frontier_svm_tests::ix::holding as hx;
use permutation_frontier_svm_tests::records;
use permutation_frontier_svm_tests::world::holding::{open_path, read_kholding, Estate};
use permutation_frontier_svm_tests::world::World;
use permutation_frontier_svm_tests::{FrontierError as E, Instruction, Signer};
use permutation_rules::fixed::MILLI;
use permutation_rules::frontier::catalog;
use permutation_rules::frontier::doctrine::of_faction;
use permutation_rules::frontier::holding::{Resource, Tier, DAY, HOUR};

/// The 7-day season's end bell, used only as a checkpoint.
const B7: u32 = 1_008;
/// The 28-day season's end bell, used only as a checkpoint.
const B28: u32 = 4_032;

fn continuous(c: &mut Chain, w: &World) {
    c.edit(&w.a.season, |d| {
        d[S::END_BELL..S::END_BELL + 4].copy_from_slice(&NO_END_BELL.to_le_bytes());
        d[S::JOIN_CLOSE_BELL..S::JOIN_CLOSE_BELL + 4].copy_from_slice(&NO_END_BELL.to_le_bytes());
        d[SEASON_CQ_OFFSET + cq_layout::CONTINUOUS] = 1;
    });
}

fn world_at(b: u32) -> (Chain, World, Estate) {
    let (mut c, w) = common::test_beacon();
    continuous(&mut c, &w);
    w.to_bell(&mut c, b, 5);
    let e = w.craft_estate(&mut c, "a", 0, (2, 0), 0);
    (c, w, e)
}

fn send(c: &mut Chain, e: &Estate, ix: Instruction) -> SendResult {
    c.send(&[ix], &[&e.wallet])
}

/// CreateSeason takes a continuous world (both end bells `NO_END_BELL`)
/// and stores it; the flag with a finite end is refused (`BadData`), as
/// is a finite end past 28 days without the flag.
#[test]
fn continuous_world_is_created() {
    let mut p = S1_LOCAL_7D;
    p.cq.continuous = 1;
    p.base.end_bell = NO_END_BELL;
    p.base.join_close_bell = NO_END_BELL;
    assert_eq!(p.validate(), Ok(()));
    let mut c = Chain::test_beacon();
    let w = World::land_v2(&mut c, 3, p);
    let d = c.data(&w.a.season);
    assert_eq!(
        u32::from_le_bytes(d[S::END_BELL..S::END_BELL + 4].try_into().unwrap()),
        NO_END_BELL
    );
    assert_eq!(d[SEASON_CQ_OFFSET + cq_layout::CONTINUOUS], 1);
    let mut bad = p;
    bad.base.end_bell = B7;
    bad.base.join_close_bell = 756;
    assert_eq!(bad.validate(), Err("join_close_bell/end_bell"));
}

/// Joining stays open: a citizen joins after bell 4,032 (the 28-day
/// season's join close is long past).
#[test]
fn continuous_join_after_both_checkpoints() {
    let (mut c, w) = common::test_beacon();
    continuous(&mut c, &w);
    w.to_bell(&mut c, B28 + 10, 5);
    let who = c.funded(b"w8-late-joiner", 10);
    expect_lands(w.join(&mut c, &who, 3), "Join after 4,032");
}

/// A building started late in bell 1,007 finishes after the checkpoint,
/// once: production rises by exactly one farm, the cost was paid once.
#[test]
fn continuous_build_queue_crosses_the_checkpoint() {
    let (mut c, w, e) = world_at(B7 - 1);
    w.enrich(&mut c, &e, 100_000);
    w.to_bell(&mut c, B7 - 1, 500);
    let mut before = read_kholding(&c.data(&e.holding));
    before.settle(c.now).unwrap();
    let l = expect_lands(
        send(
            &mut c,
            &e,
            hx::build_item(&w.a, &e.player(), e.href(), 0, false),
        ),
        "a farm late in bell 1,007",
    );
    let (cost, _, secs) = catalog::building(0, 1, of_faction(e.faction).unwrap()).unwrap();
    let done = records::one(&l.logs, Kind::BUILD).u64("done_at") as i64;
    assert!(done > w.bell_start(B7), "finishes past the checkpoint");
    assert_eq!(done, c.now + secs as i64);
    let after_pay = read_kholding(&c.data(&e.holding));
    let food = Resource::Food as usize;
    c.advance(secs as i64 + HOUR);
    expect_lands(
        send(&mut c, &e, hx::harvest(&w.a, &e.player(), e.href())),
        "harvest after",
    );
    let h = read_kholding(&c.data(&e.holding));
    assert_eq!(
        h.production[food],
        catalog::base_production(Tier::Hamlet)[food] + 12 * MILLI,
        "one farm, once"
    );
    for (r, x) in cost.iter().enumerate() {
        assert_eq!(
            before.stores[r].value - after_pay.stores[r].value,
            *x,
            "paid once, resource {r}"
        );
    }
    assert!(h.queue.iter().all(|q| q.is_none()), "the queue is empty");
}

/// A holding nobody touches for 120 days harvests at its caps: no
/// overflow, no wrap, stores within their caps.
#[test]
fn continuous_long_idle_holding_harvests_within_caps() {
    let (mut c, w, e) = world_at(10);
    c.advance(120 * DAY);
    assert!(w.bell(&c) > B28);
    expect_lands(
        send(&mut c, &e, hx::harvest(&w.a, &e.player(), e.href())),
        "harvest after 120 idle days",
    );
    let h = read_kholding(&c.data(&e.holding));
    for s in &h.stores {
        assert!(s.value >= 0 && s.value <= s.cap, "{s:?}");
    }
}

/// A sealed march departs before bell 1,008 and arrives after it: its
/// arrival's anchor is posted and the seal revealed once past the
/// checkpoint; the repeat is AlreadyDone. (The test-beacon build opens any
/// round, so the seal's secrecy before its round is not what this shows.) On a season ending at
/// 1,008 the same Depart is refused (its arrival is past the end).
#[test]
fn continuous_sealed_march_crosses_the_checkpoint() {
    let dirs = [0u8, 0, 0, 0, 0, 0, 0, 0];
    let (mut c, w) = common::test_beacon();
    let mut ending = c.fork();
    continuous(&mut c, &w);
    let b0 = B7 - 3;
    w.to_bell(&mut c, b0, 5);
    let e = w.craft_estate(&mut c, "a", 0, (2, 0), 0);
    let id = w.craft_host(&mut c, &e, &e.province, 0, 0, 0, 900, e.tile);
    let origin = (e.p as i32, e.q as i32, e.tile);
    open_path(&w, &mut c, origin, &dirs);
    let m = w.plan_march(id, 0, origin, &dirs, B7 + 3, 1, 0, SealCase::Valid);
    let tip = w.tip_min(&c);
    expect_lands(
        c.send(&[w.depart_ix(&e, (e.p, e.q), &m, tip)], &[&e.wallet]),
        "Depart before 1,008, arriving after",
    );
    let reveal = w.reveal_ix(&w.keeper.pubkey(), &e, &m, 0, true);
    let region = World::region(m.dest.0, m.dest.1);
    expect_lands(
        w.post_anchor(&mut c, m.arrive, region),
        "PostAnchor past 1,008",
    );
    let l = expect_lands(c.send(&[reveal.clone()], &[&w.keeper]), "Reveal past 1,008");
    assert_eq!(
        records::one(&l.logs, Kind::REVEAL).u64("host_id"),
        m.host_id
    );
    assert_code(c.send(&[reveal], &[&w.keeper]), E::AlreadyDone);

    // Contrast: a season ending at 1,008 refuses the same Depart.
    ending.edit(&w.a.season, |d| {
        d[S::END_BELL..S::END_BELL + 4].copy_from_slice(&B7.to_le_bytes())
    });
    w.to_bell(&mut ending, b0, 5);
    let e2 = w.craft_estate(&mut ending, "a", 0, (2, 0), 0);
    let id2 = w.craft_host(&mut ending, &e2, &e2.province, 0, 0, 0, 900, e2.tile);
    open_path(&w, &mut ending, origin, &dirs);
    let m2 = w.plan_march(id2, 0, origin, &dirs, B7 + 3, 1, 0, SealCase::Valid);
    let tip = w.tip_min(&ending);
    assert!(
        ending
            .send(&[w.depart_ix(&e2, (e2.p, e2.q), &m2, tip)], &[&e2.wallet])
            .is_err(),
        "an ending season refuses an arrival past its end"
    );
}
