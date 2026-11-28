//! `frontier-verify features` (verify-bin-rebuild): the one JSON line a caller reads before it trusts this binary as a
//! judge. scripts/devnet/verify-watch.mjs refuses to start unless it lists `playable-lane` (the 74f60922 build of
//! 2026-11-28 lacked it and FAILed world 3 ×7986). Runs in both builds: the list must match the build's features.
use std::process::Command;

#[test]
fn features_reports_this_builds_lane_and_no_mutation() {
    let out = Command::new(env!("CARGO_BIN_EXE_frontier-verify"))
        .arg("features")
        .output()
        .expect("run frontier-verify features");
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let line = String::from_utf8(out.stdout).expect("utf8");
    assert_eq!(line.lines().count(), 1, "one line: {line}");
    let v: serde_json::Value = serde_json::from_str(line.trim()).expect("JSON");
    assert_eq!(v["bin"], "frontier-verify");
    assert_eq!(v["version"], env!("CARGO_PKG_VERSION"));
    let feats: Vec<&str> = v["features"]
        .as_array()
        .expect("features[]")
        .iter()
        .map(|f| f.as_str().expect("str"))
        .collect();
    assert_eq!(
        feats.contains(&"playable-lane"),
        cfg!(feature = "playable-lane"),
        "{feats:?}"
    );
    assert_eq!(
        feats.contains(&"wide-world-experimental"),
        cfg!(feature = "wide-world-experimental"),
        "{feats:?}"
    );
    assert_eq!(
        v["mutated"].as_str(),
        verify_core::mutated(),
        "a mutate-* build says so"
    );
}
