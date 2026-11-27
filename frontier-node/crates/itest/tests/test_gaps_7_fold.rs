//! test-gaps-7 (#293 fix-loop27, the demo setup's FoldStale retry): scripted outcome sequences the in-module tests
//! (`capture_demo::tests`, a bell model) do not reach — a fold that fits on exactly the LAST allowed attempt, the
//! bound counted in folds AND in waits, and a non-44 refusal or an unknown outcome AFTER a retry, at every part,
//! stopping at once. Pure: no chain, no socket, no key (the outcomes are literal `Sent` values).
#![cfg(feature = "localnet-expedition-play")]

use std::cell::{Cell, RefCell};

use itest::capture_demo::{fold_retrying, is_fold_stale, FOLD_TRIES};
use itest::keeper_loop::Sent;
use serde_json::Value;

fn stale(p: u8) -> Sent {
    Sent::Failed(format!(
        "FoldOccupancy {p} failed: InstructionError(4, Custom(44)) (code Some(44)) []"
    ))
}

fn other(p: u8) -> Sent {
    Sent::Failed(format!(
        "FoldOccupancy {p} failed: InstructionError(4, Custom(45)) (code Some(45)) []"
    ))
}

fn block<F: std::future::Future>(f: F) -> F::Output {
    tokio::runtime::Builder::new_current_thread()
        .build()
        .unwrap()
        .block_on(f)
}

/// Runs a fold whose `k`-th part send (0-based, over every attempt) is answered `script(k, part)`; returns the
/// result, the parts sent in order, the waits for the next bell and the retry lines.
fn run(script: impl Fn(usize, u8) -> Sent) -> (Result<u32, String>, Vec<u8>, u32, Vec<Value>) {
    let sent = RefCell::new(vec![]);
    let waits = Cell::new(0u32);
    let logs = RefCell::new(vec![]);
    let r = block(fold_retrying(
        |p| {
            let k = sent.borrow().len();
            sent.borrow_mut().push(p);
            let o = script(k, p);
            async move { o }
        },
        || {
            waits.set(waits.get() + 1);
            let b = 100 + waits.get();
            async move { Ok(b) }
        },
        FOLD_TRIES,
        |v| logs.borrow_mut().push(v),
    ));
    (r, sent.into_inner(), waits.get(), logs.into_inner())
}

#[test]
fn the_bound_is_four_folds() {
    assert_eq!(FOLD_TRIES, 4, "fix-loop27: at most 4 folds (3 retries)");
}

#[test]
fn a_fold_that_fits_on_the_last_allowed_attempt_lands() {
    // folds 1-3 go stale at parts 1, 2, 1; fold 4 lands all three parts
    let plan: [&[u8]; 4] = [&[0, 1], &[0, 1, 2], &[0, 1], &[0, 1, 2]];
    let ends: Vec<usize> = plan
        .iter()
        .scan(0, |acc, f| {
            *acc += f.len();
            Some(*acc - 1)
        })
        .collect();
    let (r, sent, waits, logs) = run(|k, p| {
        if ends[..3].contains(&k) {
            stale(p)
        } else {
            Sent::Landed(format!("s{k}"))
        }
    });
    assert_eq!(r, Ok(3), "three retries, then landed");
    assert_eq!(sent, plan.concat(), "each retry from part 0");
    assert_eq!(waits, 3, "one wait for the next bell per retry");
    let at: Vec<(u64, u64, u64)> = logs
        .iter()
        .map(|l| {
            (
                l["attempt"].as_u64().unwrap(),
                l["stale_part"].as_u64().unwrap(),
                l["restart_bell"].as_u64().unwrap(),
            )
        })
        .collect();
    assert_eq!(at, vec![(1, 1, 101), (2, 2, 102), (3, 1, 103)]);
    assert!(logs.iter().all(|l| l["of"] == FOLD_TRIES));
}

#[test]
fn four_stale_folds_stop_without_a_fifth_or_a_fourth_wait() {
    for at in [1u8, 2] {
        let (r, sent, waits, logs) = run(|k, p| {
            if p == at {
                stale(p)
            } else {
                Sent::Landed(format!("s{k}"))
            }
        });
        let e = r.unwrap_err();
        assert!(
            e.starts_with(&format!("FoldOccupancy {at}: Failed("))
                && e.ends_with(&format!(
                    "(FoldStale on {FOLD_TRIES} folds in a row; not resent again)"
                )),
            "{e}"
        );
        assert_eq!(
            sent.iter().filter(|&&p| p == 0).count(),
            FOLD_TRIES as usize,
            "exactly 4 folds: {sent:?}"
        );
        assert_eq!(sent.len(), FOLD_TRIES as usize * (at as usize + 1));
        assert_eq!(waits, FOLD_TRIES - 1, "no wait after the last fold");
        assert_eq!(logs.len(), FOLD_TRIES as usize - 1);
    }
}

#[test]
fn a_non_44_refusal_or_unknown_after_a_retry_stops_at_once_at_every_part() {
    let unknown = || Sent::Unknown {
        signature: "s".into(),
        why: "did not land (code Some(44))".into(),
    };
    for part in 0..3u8 {
        for (what, word) in [(0, "Custom(45)"), (1, "Unknown {")] {
            // fold 1 stale at part 1; fold 2 answered `what` at `part`
            let (r, sent, waits, logs) = run(|k, p| match k {
                1 => stale(p),
                _ if k >= 2 && p == part => {
                    if what == 0 {
                        other(p)
                    } else {
                        unknown()
                    }
                }
                _ => Sent::Landed(format!("s{k}")),
            });
            let e = r.unwrap_err();
            assert!(
                e.starts_with(&format!("FoldOccupancy {part}: "))
                    && e.contains(word)
                    && e.ends_with("(not resent)"),
                "part {part}: {e}"
            );
            assert_eq!(
                sent.len(),
                2 + part as usize + 1,
                "nothing after the refusal: {sent:?}"
            );
            assert_eq!(
                (waits, logs.len()),
                (1, 1),
                "only the first (stale) fold retried"
            );
        }
    }
}

#[test]
fn only_the_programs_code_44_counts_as_fold_stale() {
    assert!(is_fold_stale(&stale(1)));
    for s in [
        other(1),
        // the number alone, another code that contains 44, an RPC error, a landed send
        Sent::Failed("FoldOccupancy 1 failed: Custom(44)".into()),
        Sent::Failed("FoldOccupancy 1 failed: (code Some(4400))".into()),
        Sent::Failed("FoldOccupancy 1 failed: (code Some(144))".into()),
        Sent::Failed("rpc: 429 Too Many Requests (code 44)".into()),
        Sent::Landed("(code Some(44))".into()),
    ] {
        assert!(!is_fold_stale(&s), "{s:?}");
    }
    // a non-44 refusal on the FIRST fold is never retried either
    let (r, sent, waits, _) = run(|k, p| {
        if p == 1 {
            other(p)
        } else {
            Sent::Landed(format!("s{k}"))
        }
    });
    assert!(r.unwrap_err().ends_with("(not resent)"));
    assert_eq!((sent, waits), (vec![0, 1], 0));
}
