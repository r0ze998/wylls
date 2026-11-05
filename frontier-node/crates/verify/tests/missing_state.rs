//! Workstream 11, patch 0003: Holding continuity (V7) that could not be
//! judged for lack of post-states is UNVERIFIABLE, not a silent PASS.

mod common;

use common::*;
use verify_core::Verdict;

const HOLD: &[u8; 8] = b"PSF1HOLD";

fn holding_keys(inp: &verify_core::input::Input, t: usize) -> Vec<fclient::Address> {
    inp.txs[t]
        .post
        .iter()
        .filter(|(_, a)| a.as_ref().is_some_and(|a| a.data.starts_with(HOLD)))
        .map(|(k, _)| *k)
        .collect()
}

fn v7_missing(r: &verify_core::Report) -> bool {
    r.findings
        .iter()
        .any(|f| f.check == "V7" && f.code == "MissingData")
}

#[test]
fn a_holding_write_with_no_earlier_post_state_is_not_a_pass() {
    let base = land();
    let mut n = 0;
    // Every Holding post-state of the archive, dropped one at a time.
    for t in 0..base.txs.len() {
        for k in holding_keys(&base, t) {
            let mut inp = base.clone();
            inp.txs[t].post.retain(|(x, _)| *x != k);
            let r = verify_core::verify(&inp);
            assert_ne!(r.verdict, Verdict::Pass, "tx#{t} {k}: {}", show(&r));
            assert!(v7_missing(&r), "tx#{t} {k}: {}", show(&r));
            n += 1;
        }
    }
    println!("{n} dropped Holding post-states: none is a PASS");
    assert!(n > 0);
}

#[test]
fn an_archive_without_post_states_says_continuity_is_unjudged() {
    let mut inp = land();
    for r in inp.txs.iter_mut() {
        r.post.clear();
    }
    let r = verify_core::verify(&inp);
    assert_eq!(r.verdict, Verdict::Unverifiable, "{}", show(&r));
    assert!(v7_missing(&r), "{}", show(&r));
}
