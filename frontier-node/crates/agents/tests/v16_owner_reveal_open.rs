//! ⑯ independent verification of ⑱'s bots change (r18 b71b8197): bot owners
//! send their reveal material only after T(arrive) is published (plus the
//! margin) and only through the bell after the arrival bell. No key: the
//! drand public key is zero bytes and only the clock is used.

use frontier_agents::obs::SeasonView;
use frontier_agents::policy::{owner_reveal_open, REVEAL_PUBLISH_MARGIN_SECS};
use fclient::Address;

fn season(genesis_ts: i64, drand_genesis: i64) -> SeasonView {
    SeasonView {
        program: Address::new_from_array([1; 32]),
        season_id: 1,
        genesis_ts,
        bell_secs: 600,
        w: 600,
        delta: 60,
        drand_pk: [0; 96],
        drand_period: 3,
        drand_genesis,
        r_max: 0,
        rings: vec![],
        tip_priority_milli: 0,
        reveal_cu_limit: 0,
        march_fee: 0,
        seal_bond: 0,
        latest_slot: 0,
        latest_unix: 0,
        season: None,
    }
}

#[test]
fn v16_r1_opens_exactly_at_publication_plus_margin_for_many_bells_and_genesis_offsets() {
    // Genesis offsets 0..3 s against the drand round grid, so the rounding of tlock_round is exercised.
    for off in 0..3i64 {
        let s = season(1_800_000_000 + off, 1_692_803_367);
        for arrive in [1u32, 2, 40, 143, 144, 1_007, 1_008, 10_000] {
            let start = s.genesis_ts + 600 * arrive as i64;
            let p = s.published_at(arrive);
            assert!(p >= start + 600, "arrive {arrive} off {off}: the seal's round {p} is before the bell's end");
            let open = |seen: i64| owner_reveal_open(&s, arrive, s.bell_at(seen), seen);
            let first = p + REVEAL_PUBLISH_MARGIN_SECS;
            assert!(!open(first - 1), "arrive {arrive} off {off}: open one second early");
            if s.bell_at(first) <= arrive + 1 {
                assert!(open(first), "arrive {arrive} off {off}: not open at publication + margin");
            }
            // Never before the arrival bell ends, and never from bell arrive + 2.
            assert!(!open(start), "open at the arrival bell's start");
            let late = start + 2 * 600;
            assert!(!open(late), "open in bell arrive + 2");
        }
    }
}
