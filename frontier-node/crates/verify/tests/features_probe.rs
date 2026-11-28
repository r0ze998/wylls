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

/// Q-TG10-2 = a (r0ze 2026-11-28 19:45; D-test-gaps-10-2 / D-verify-pr313-1; fix-tg10): every `mutate-*` feature in
/// Cargo.toml is in `verify_core::mutated()`'s list, so a build with any one of them reports itself (`"mutated"` here)
/// and frontier-verify's own refusal fires. Before fix-tg10 mutate-vr / mutate-vl / mutate-vwl were missing and such a
/// build answered `"mutated": null`. The next mutate-* feature added to Cargo.toml without the list fails this test.
#[test]
fn mutated_lists_every_mutate_feature_in_cargo_toml() {
    let toml = include_str!("../Cargo.toml");
    let sec = &toml[toml.find("\n[features]\n").expect("[features]")..];
    let sec = &sec[1..];
    let sec = &sec[..sec[1..].find("\n[").map(|i| i + 1).unwrap_or(sec.len())];
    let cargo: Vec<&str> = sec
        .lines()
        .filter_map(|l| l.split_once(" = ").map(|(k, _)| k.trim()))
        .filter(|k| k.starts_with("mutate-"))
        .collect();
    let lib = include_str!("../src/lib.rs");
    let f = &lib[lib
        .find("pub fn mutated() -> Option<&'static str> {")
        .expect("fn mutated")..];
    let body = &f[f.find("m!(").expect("m!(")..f.find(")\n}").expect("end of m!")];
    let listed: Vec<&str> = body
        .split('"')
        .filter(|w| w.starts_with("mutate-"))
        .collect();
    assert!(cargo.len() >= 18, "{cargo:?}");
    let missing: Vec<&&str> = cargo.iter().filter(|f| !listed.contains(f)).collect();
    assert!(
        missing.is_empty(),
        "mutate-* features not in mutated(): {missing:?}"
    );
    let extra: Vec<&&str> = listed.iter().filter(|f| !cargo.contains(f)).collect();
    assert!(
        extra.is_empty(),
        "mutated() names features Cargo.toml lacks: {extra:?}"
    );
}
