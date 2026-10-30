//! ⑯ independent verification (flows A and C): the herald's caravan feed
//! (`herald_fold::caravan::Caravans`) after a raid that TAKES a caravan,
//! and what it keeps of a send's tower wear.
//!
//! The program (decision J2, `permutation-frontier/src/proc/caravan.rs`
//! `settle_raid`) makes a taken caravan the raider's (OWNER_CITIZEN and
//! FACTION rewritten) but keeps OWNER_TAG and SEQ as the account seed, so
//! CARAVAN_RAIDED(TAKE) and the following CARAVAN_SENT carry the sender's
//! key. S1-1B-CONTRACT §3.5: "take the caravan (it becomes the raider's)".
//! These tests pin that contract as the feed's invariant.

use fclient::conquest::{CqEvent, LogPlace, LogRun};
use frontier_abi::v2::log::raid_choice;
use herald_fold::caravan::Caravans;

const VICTIM: u64 = 0x1111_2222_3333_4444;
const RAIDER: u64 = 0x5555_6666_7777_8888;

fn holding(p: i16, q: i16, site: u8, tile: u8) -> LogPlace {
    LogPlace { kind: 1, p, q, at: site, gen: 1, tile }
}

fn sent(faction: u8, src: LogPlace, dst: LogPlace, worn_bps: u16, cargo: [u32; 8]) -> CqEvent {
    CqEvent::CaravanSent {
        owner_tag: VICTIM,
        seq: 0,
        faction,
        src,
        dst,
        steps: 4,
        cargo,
        arrive_ts: 1_800_003_600,
        runs: vec![LogRun { p: 3, q: 0, first_bell: 290, n: 2 }],
        worn_bps,
        path: [0; 12],
    }
}

/// The three records one TAKE produces, in order, as `herald/src/caravan.rs`
/// documents them: the send, the raid, the raider's new route.
fn take_sequence() -> Vec<CqEvent> {
    let field = LogPlace { kind: 3, p: 3, q: 0, at: 21, gen: 0, tile: 21 };
    vec![
        sent(1, holding(3, 0, 2, 20), holding(4, 0, 1, 30), 0, [0, 100, 0, 0, 0, 0, 0, 0]),
        CqEvent::CaravanRaided {
            owner_tag: VICTIM,
            seq: 0,
            p: 3,
            q: 0,
            bell: 291,
            choice: raid_choice::TAKE,
            by: raid_choice::BY_RAIDER,
            raider_tag: RAIDER,
            taken: [0, 100, 0, 0, 0, 0, 0, 0],
            dst: holding(3, 0, 6, 30),
            cleared: vec![(4, 0)],
            domestic: false,
        },
        sent(3, field, holding(3, 0, 6, 30), 0, [0, 100, 0, 0, 0, 0, 0, 0]),
    ]
}

#[test]
fn v16_a1_feed_names_the_raider_as_the_holder_after_a_take() {
    let mut c = Caravans::default();
    for ev in take_sequence() {
        assert!(c.fold(&ev), "an S1 record folds");
    }
    assert_eq!(c.moving.len(), 1, "one caravan, re-keyed by its seed");
    let m = c.moving.values().next().unwrap();
    // The invariant: whoever reads the feed can tell the caravan is the raider's now. The entry's `ownerTag` is the
    // account seed (the sender's tag), so a holder has to be named somewhere else: `holderTag`, `heldBy`, or ownerTag
    // itself rewritten. Any of those satisfies the test; none of them exists today.
    let holder = m
        .get("holderTag")
        .or_else(|| m.get("heldBy"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .or_else(|| {
            let t = m["ownerTag"].as_str()?;
            (t == RAIDER.to_string()).then(|| t.to_string())
        });
    assert_eq!(
        holder.as_deref(),
        Some(RAIDER.to_string().as_str()),
        "the feed must name the raider as the holder of a taken caravan; entry: {m}"
    );
}

#[test]
fn v16_a1c_a_take_does_not_leave_the_caravan_marked_as_a_plain_cart_of_the_victim() {
    // Weaker form: after the TAKE the entry says `raided: true` or its faction is the raider's AND the reader is told
    // so; today the re-SENT resets `raided` to false and only `faction` changes, with `ownerTag` still the victim's.
    let mut c = Caravans::default();
    for ev in take_sequence() {
        c.fold(&ev);
    }
    let m = c.moving.values().next().unwrap();
    assert_eq!(m["faction"], 3, "the faction follows the raider (what the program writes)");
    assert_eq!(m["ownerTag"], VICTIM.to_string(), "the key stays the sender's (the account seed)");
    assert_eq!(
        m["raided"], true,
        "a taken caravan must not read as an unraided cart of the victim; entry: {m}"
    );
}

#[test]
fn v16_c2_feed_keeps_the_tower_wear_of_a_send() {
    // CARAVAN_SENT's `cargo` is the cargo AFTER the towers' wear (`worn_bps`); the source paid the whole. A page that
    // shows "sent 100, arrived 100" from the feed alone hides the loss unless the feed carries worn_bps.
    let mut c = Caravans::default();
    c.fold(&sent(1, holding(3, 0, 2, 20), holding(4, 0, 1, 30), 1_500, [0, 85, 0, 0, 0, 0, 0, 0]));
    let m = c.moving.values().next().unwrap();
    assert!(
        m.get("wornBps").is_some() || m.get("worn_bps").is_some(),
        "the feed entry must carry the send's worn_bps (the loss the cargo already took); entry: {m}"
    );
}

#[test]
fn v16_a2_two_sent_records_of_one_key_stay_one_caravan() {
    // Confirmation (expected to pass): the feed never lists the re-SENT as a second caravan.
    let mut c = Caravans::default();
    for ev in take_sequence() {
        c.fold(&ev);
    }
    assert_eq!(c.moving.len(), 1);
    assert_eq!(c.moving.values().next().unwrap()["dst"]["at"], 6, "the route is the raider's");
}
