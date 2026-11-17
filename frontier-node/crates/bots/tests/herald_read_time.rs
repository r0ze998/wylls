//! WRITTEN, NOT RUN (2026-11-17, under an execution pause): this file has not
//! been compiled or run. Run it only with its own approval.
//!
//! `herald_read_time` (bot.rs): a herald that has read no block time yet
//! answers `latestUnix` 0 (herald views.rs `f.st.last_time`), and the fleet
//! takes that as no season, never as a game time.
//!   R1 latestUnix 0 (and a negative one) → an error naming it; nothing to observe
//!   R2 a real time → (latestSlot, latestUnix) as the herald gave them
//!   R3 before genesis is a real time (a pre-season chain), not refused
//!   R4 why: `GameClock` fed `(0, 0)` then one real read measures a scale of
//!      latestUnix over the wall seconds between them (fclient, unchanged)
//!
//! Plain JSON and a clock only: no key is generated, derived or used; nothing
//! is signed, sent, spawned or fetched.

use std::time::{Duration, Instant};

use fclient::clock::GameClock;
use fclient::ports::ClockSysvar;
use frontier_agents::obs::SeasonView;
use frontier_bots::bot::herald_read_time;
use serde_json::{json, Value};

const GENESIS_TS: i64 = 1_789_600_000;

fn season_json(latest_slot: u64, latest_unix: i64) -> Value {
    json!({
        "v": 1,
        "programId": "11111111111111111111111111111111",
        "season": "1",
        "genesisTs": GENESIS_TS,
        "bellSecs": 600,
        "W": 600,
        "drand": { "publicKey": "00".repeat(96), "period": 3, "genesis": 1_692_803_367 },
        "latestSlot": latest_slot,
        "latestUnix": latest_unix,
    })
}

fn view(latest_slot: u64, latest_unix: i64) -> SeasonView {
    SeasonView::from_json(&season_json(latest_slot, latest_unix)).expect("a season view")
}

#[test]
fn r1_no_read_time_is_an_error() {
    for unix in [0, -1] {
        let e = herald_read_time(&view(0, unix)).expect_err("no read time");
        assert!(e.contains("no read time yet"), "{e}");
        assert!(e.contains(&format!("latestUnix {unix}")), "{e}");
    }
    // a slot without a time is still no time
    assert!(herald_read_time(&view(41, 0)).is_err());
}

#[test]
fn r2_a_real_time_is_passed_on() {
    let t = GENESIS_TS + 12 * 600 + 30;
    assert_eq!(herald_read_time(&view(9_000, t)), Ok((9_000, t)));
}

#[test]
fn r3_before_genesis_is_a_time() {
    let t = GENESIS_TS - 3_600;
    assert_eq!(herald_read_time(&view(500, t)), Ok((500, t)));
}

#[test]
fn r4_why_a_zero_sample_is_never_observed() {
    let at0 = Instant::now();
    let t = GENESIS_TS + 600;
    let mut c = GameClock::new(1.0);
    c.observe(
        ClockSysvar {
            slot: 0,
            unix_timestamp: 0,
            ..ClockSysvar::default()
        },
        at0,
    );
    c.observe(
        ClockSysvar {
            slot: 5,
            unix_timestamp: t,
            ..ClockSysvar::default()
        },
        at0 + Duration::from_secs(2),
    );
    assert!(c.scale() > 1e8, "scale {} from a (0, 0) sample", c.scale());
    let mut ok = GameClock::new(1.0);
    ok.observe(
        ClockSysvar {
            slot: 5,
            unix_timestamp: t,
            ..ClockSysvar::default()
        },
        at0 + Duration::from_secs(2),
    );
    assert_eq!(ok.scale(), 1.0, "one real sample: the default scale");
}
