//! keeper-test-seam: guard for the PR CI filter `tg6_ fkc_ v290_ test_gaps_6_`.
//!
//! PR CI runs the keeper lib tests whose names start with those prefixes
//! (ci.yml, "Keeper playable lane" and "Frontier M1 off-chain workspace").
//! They must stay key-free: payers from `testkit::FakeSigner`
//! (`Keeper::with_payer_keys` / `testkit::fake_payers`), drand from
//! `testkit::PublicDrand`. This test reads the source (no build of the
//! tests themselves, no key) and fails when
//! - the set of tests the filter selects changes (a new test under one of
//!   the prefixes must be reviewed and listed here), or
//! - a selected test, or a helper it builds its keeper or payers with, uses
//!   a key path: `Payers::new`, `Payers::with_budgets(`, `payers()` (the
//!   seed-derived engine helper), `Keeper::new(`, `FakeDrand`, `Keypair`,
//!   `derive(`, `TestKey`, `set_claim_key`.

use std::path::Path;

const PREFIXES: [&str; 4] = ["tg6_", "fkc_", "v290_", "test_gaps_6_"];

/// Every lib test the filter selects (module path as `cargo test` prints it).
const SELECTED: [&str; 15] = [
    "engine::tests::tg6_hundred_send_pass_refreshes_every_16_sends",
    "engine::tests::tg6_send_pass_refreshes_after_15_seconds",
    "engine::tests::tg6_sent_reveal_requests_32000_cu_per_lane",
    "tests::fkc_long_first_tick_tops_up_payers_within_two_minutes",
    "tests::fkc_stuck_care_rows_from_a_previous_process_settle_after_restart",
    "tests::fkc_plain_rotation_reaches_few_care_rows",
    "tests::fkc_drained_payer_produces_no_sends",
    "tests::fkc_proven_dropped_care_tops_up_in_the_same_tick_before_the_feed",
    "tests::v290_first_tick_after_start_keeps_the_rent_reserve",
    "tests::v290_care_only_poll_keeps_the_other_orphans",
    "tests::v290_payer_short_of_the_real_fee_signs_nothing",
    "tests::test_gaps_6_restart_with_a_dropped_care_transfer_tops_up_again",
    "tests::test_gaps_6_first_tick_care_is_sent_in_that_tick",
    "tests::test_gaps_6_proven_dropped_care_does_not_cost_a_whole_tick",
    "tests::test_gaps_6_care_top_ups_go_out_before_the_feed_pull",
];

/// Helpers the selected tests build their keeper or payers with.
const HELPERS: [(&str, &str); 3] = [
    ("engine.rs", "fn key_free_payers"),
    ("lib.rs", "pub fn keeper(port: CarePort"),
    ("lib.rs", "fn tg6_keeper(journal"),
];

const KEY_PATHS: [&str; 10] = [
    "Payers::new",
    "Payers::with_budgets(",
    "payers()",
    "Keeper::new(",
    "FakeDrand",
    "Keypair",
    "derive(",
    "TestKey",
    "set_claim_key",
    "insecure_clone",
];

/// Whether `b` uses `key` as a path of its own (not the tail of a longer
/// name: `key_free_payers()` is not `payers()`).
fn uses(b: &str, key: &str) -> bool {
    b.match_indices(key).any(|(i, _)| {
        !b[..i]
            .chars()
            .next_back()
            .is_some_and(|c| c.is_alphanumeric() || c == '_')
    })
}

fn src(file: &str) -> String {
    std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("src").join(file))
        .unwrap_or_else(|e| panic!("{file}: {e}"))
}

/// The body of the item whose line contains `head`: from that line to the
/// first line closing it (`}` at the same indentation).
fn body<'a>(s: &'a str, head: &str) -> &'a str {
    let at = s.find(head).unwrap_or_else(|| panic!("{head} not found"));
    let line_start = s[..at].rfind('\n').map_or(0, |i| i + 1);
    let indent = s[line_start..].len() - s[line_start..].trim_start().len();
    let close = format!("\n{}}}\n", " ".repeat(indent));
    let end = s[at..]
        .find(&close)
        .unwrap_or_else(|| panic!("{head}: no end"))
        + at;
    &s[at..end]
}

/// `(module path, name)` of every test fn named with one of the prefixes.
fn selected(file: &str, module: &str) -> Vec<String> {
    let s = src(file);
    let mut out = vec![];
    for line in s.lines() {
        let t = line.trim_start();
        let Some(rest) = t
            .strip_prefix("async fn ")
            .or_else(|| t.strip_prefix("fn "))
        else {
            continue;
        };
        let name: String = rest
            .chars()
            .take_while(|c| c.is_alphanumeric() || *c == '_')
            .collect();
        if PREFIXES.iter().any(|p| name.starts_with(p)) {
            out.push(format!("{module}{name}"));
        }
    }
    out
}

#[test]
fn ci_filter_selects_exactly_the_reviewed_key_free_tests() {
    let mut got = selected("engine.rs", "engine::tests::");
    got.extend(selected("lib.rs", "tests::"));
    // Helpers under the prefixes (not tests) are allowed but are checked too.
    let helpers: Vec<String> = got
        .iter()
        .filter(|n| !SELECTED.contains(&n.as_str()))
        .cloned()
        .collect();
    for want in SELECTED {
        assert!(got.iter().any(|g| g == want), "{want} is not in the source");
    }
    for h in &helpers {
        let name = h.rsplit("::").next().unwrap();
        let file = if h.starts_with("engine::") {
            "engine.rs"
        } else {
            "lib.rs"
        };
        let s = src(file);
        let b = body(&s, &format!("fn {name}"));
        // A helper is never itself a test.
        let pre = &s[..s.find(&format!("fn {name}")).unwrap()];
        let last_attr = pre.rsplit('\n').nth(1).unwrap_or("");
        assert!(
            !last_attr.contains("test"),
            "{h}: a new test under a CI-filtered prefix; review it and list it in SELECTED"
        );
        for k in KEY_PATHS {
            assert!(!uses(b, k), "helper {h} uses a key path `{k}`");
        }
    }
}

#[test]
fn selected_tests_and_their_helpers_use_no_key() {
    for t in SELECTED {
        let (file, name) = match t.strip_prefix("engine::tests::") {
            Some(n) => ("engine.rs", n),
            None => ("lib.rs", t.strip_prefix("tests::").unwrap()),
        };
        let s = src(file);
        let b = body(&s, &format!("fn {name}("));
        for k in KEY_PATHS {
            assert!(!uses(b, k), "{t} uses a key path `{k}`");
        }
    }
    for (file, head) in HELPERS {
        let s = src(file);
        let b = body(&s, head);
        for k in KEY_PATHS {
            assert!(!uses(b, k), "helper `{head}` uses a key path `{k}`");
        }
        assert!(
            b.contains("FakeSigner") || b.contains("fake_payers"),
            "helper `{head}` builds no fake signer"
        );
    }
    // The keeper type the Keeper-level tests run on.
    let lib = src("lib.rs");
    for ty in ["pub type FkcKeeper =", "type Tg6Keeper ="] {
        let at = lib.find(ty).unwrap_or_else(|| panic!("{ty} not found"));
        let decl = &lib[at..at + lib[at..].find(';').unwrap()];
        assert!(
            decl.contains("PublicDrand") && decl.contains("FakeSigner"),
            "{ty} is not key-free: {decl}"
        );
    }
}
