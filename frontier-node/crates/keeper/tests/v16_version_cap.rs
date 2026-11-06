//! ⑯ independent verification of ⑱'s Reveal version cap (r18 b71b8197),
//! pure functions only: no engine send, no key, no signature.

use keeper_core::config::KeeperConfig;
use keeper_core::engine::{live_unknown_versions, EngineParams, EXPIRY_SLOTS};

#[test]
fn v16_c1_only_unsettled_versions_within_blockhash_validity_count() {
    let at = 10_000u64;
    let v = |sent: u64, settled: bool| (sent, settled);
    assert_eq!(live_unknown_versions([v(at, false)], at), 1, "sent this slot");
    assert_eq!(live_unknown_versions([v(at - EXPIRY_SLOTS, false)], at), 1, "last valid slot");
    assert_eq!(live_unknown_versions([v(at - EXPIRY_SLOTS - 1, false)], at), 0, "expired");
    assert_eq!(live_unknown_versions([v(at, true), v(at, true)], at), 0, "settled never count");
    // Near slot 0 nothing underflows.
    assert_eq!(live_unknown_versions([v(0, false)], 0), 1);
    // A version recorded with a sent slot in the future (clock skew) still counts as live.
    assert_eq!(live_unknown_versions([v(at + 5, false)], at), 1);
}

#[test]
fn v16_c2_the_keeper_default_is_2_and_the_engine_default_is_off() {
    let base = format!(
        "program = \"{}\"\nseason = 1\nbeneficiary = \"{}\"\n",
        fclient::Address::new_from_array([5; 32]),
        fclient::Address::new_from_array([6; 32])
    );
    assert_eq!(KeeperConfig::from_toml(&base).unwrap().max_unknown_w_versions, 2);
    assert_eq!(EngineParams::default().max_unknown_w_versions, 0);
    assert!(KeeperConfig::from_toml(&format!("{base}max_unknown_w_versions = -1\n")).is_err(), "a negative cap is refused");
}
