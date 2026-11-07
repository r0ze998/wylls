//! Workstream 04's own adversarial checks of `findex::ledger::join` (⑲'s
//! 7ab2b0b2), written at integration, independent of ⑲'s tests/ledger.rs:
//! the cases the owner asked about (2026-11-07) must never be taken for a
//! whole history.
//!
//! - a ledger rewound under the same runId, seen through another archive
//!   that read the ledger after the rewind;
//! - a ledger number and a signature that disagree between archives;
//! - one archive shorter than the other: nothing past the shorter one is
//!   ever joined as whole.
//!
//! Keyless: signatures are fixed byte patterns, transactions three opaque
//! bytes; no key is generated, derived or signed (no network either).

use fclient::ports::{Signature, TxRecord};
use findex::ledger::{join, Part};
use serde_json::{json, Value};

fn sig(i: u8) -> Signature {
    Signature::from([i; 64])
}

fn rec(arch_seq: u64, s: u8) -> TxRecord {
    TxRecord {
        seq: arch_seq,
        slot: arch_seq,
        signature: sig(s),
        block_time: 0,
        tx: vec![1, 2, 3],
        logs: vec![],
        err: None,
        code: None,
        units: 0,
        fee: 0,
        post: vec![],
    }
}

fn cursor(after: u64, ledger: &str) -> Value {
    json!({"feed_after": after, "feed_start": 0, "ledger": ledger})
}

/// A part: (signature byte, ledger number) in archive order.
fn part(name: &str, recs: &[(u8, u64)], c: Value) -> Part {
    Part {
        name: name.into(),
        records: recs
            .iter()
            .enumerate()
            .map(|(i, (s, f))| (rec(i as u64 + 1, *s), Some(*f)))
            .collect(),
        cursor: c,
    }
}

fn numbers(parts: &[Part]) -> Vec<u64> {
    join(parts).entries.iter().map(|e| e.feed_seq).collect()
}

/// The baseline the cases below change: A (ledger 1, 3, 5), B (2, 3, 4) with
/// ledger 3 a transaction of both programs; joined once, whole through 5.
fn good() -> [Part; 2] {
    [
        part("A", &[(11, 1), (13, 3), (15, 5)], cursor(5, "run1")),
        part("B", &[(12, 2), (13, 3), (14, 4)], cursor(5, "run1")),
    ]
}

#[test]
fn the_baseline_is_whole() {
    let j = join(&good());
    assert!(j.whole(), "{:?}", j.problems);
    assert_eq!(numbers(&good()), vec![1, 2, 3, 4, 5]);
}

/// The ledger lost its tail (no fsync, power loss) and kept its runId: A was
/// archived before, B after the rewind, when ledger number 5 is another
/// transaction (B's). One number, two signatures: never whole.
#[test]
fn a_rewind_under_the_same_run_id_seen_by_the_other_archive_is_not_whole() {
    let [a, _] = good();
    let b_after_rewind = part(
        "B",
        &[(12, 2), (13, 3), (14, 4), (31, 5)],
        cursor(5, "run1"),
    );
    let j = join(&[a, b_after_rewind]);
    assert!(!j.whole());
    assert!(
        j.problems
            .iter()
            .any(|p| p.contains("two transactions, one ledger number")),
        "{:?}",
        j.problems
    );
}

/// The same rewind where the re-numbered transaction is the one both programs
/// share: B holds it at a new number. One signature, two numbers: never whole.
#[test]
fn a_shared_transaction_at_two_numbers_is_not_whole() {
    let [a, _] = good();
    let b = part("B", &[(12, 2), (14, 4), (13, 6)], cursor(6, "run1"));
    let j = join(&[a, b]);
    assert!(!j.whole());
    assert!(
        j.problems
            .iter()
            .any(|p| p.contains("one transaction, two ledger numbers")),
        "{:?}",
        j.problems
    );
}

/// Every way of changing the shared transaction in one archive only (its
/// number, or its signature) is a contradiction the join must name.
#[test]
fn every_one_sided_change_of_the_shared_entry_is_not_whole() {
    for f in [1u64, 2, 4, 5, 6] {
        let [a, _] = good();
        let mut recs = vec![(12u8, 2u64), (14, 4)];
        recs.push((13, f));
        recs.sort_by_key(|r| r.1);
        let b = part("B", &recs, cursor(6, "run1"));
        assert!(!join(&[a, b]).whole(), "shared entry moved to {f} in B");
    }
    for s in [0x20u8, 0x21, 0xff] {
        let [a, _] = good();
        let b = part("B", &[(12, 2), (s, 3), (14, 4)], cursor(5, "run1"));
        assert!(!join(&[a, b]).whole(), "shared entry re-signed {s:#x} in B");
    }
}

/// B was read only through ledger 3 (a restart before its next commit): the
/// join is cut at 3. A's 5 is counted as beyond, never joined as whole.
#[test]
fn a_shorter_archive_cuts_the_join_and_nothing_past_it_is_joined() {
    let [a, _] = good();
    let short_b = part("B", &[(12, 2), (13, 3)], cursor(3, "run1"));
    let j = join(&[a, short_b]);
    assert!(j.whole(), "{:?}", j.problems);
    assert_eq!(j.through, 3);
    assert!(j.entries.iter().all(|e| e.feed_seq <= 3));
    assert_eq!(j.beyond, 1, "A's 5");
    // A shorter archive that still holds a record past its own cursor is a
    // contradiction, not a cut.
    let [a, _] = good();
    let lying_b = part("B", &[(12, 2), (13, 3), (14, 4)], cursor(3, "run1"));
    assert!(!join(&[a, lying_b]).whole());
}

/// An archive that read nothing yet (cursor 0) cuts the join at 0: nothing is
/// joined, whatever the other archive holds.
#[test]
fn an_archive_that_read_nothing_joins_nothing() {
    let [a, _] = good();
    let empty_b = part("B", &[], cursor(0, "run1"));
    let j = join(&[a, empty_b]);
    assert_eq!(j.through, 0);
    assert!(j.entries.is_empty());
    assert_eq!(j.beyond, 3, "A's 1, 3 and 5");
}

/// Different runIds (a rebuilt node) never join, even with consistent numbers.
#[test]
fn archives_of_two_ledgers_never_join_as_whole() {
    let [a, _] = good();
    let b = part("B", &[(12, 2), (13, 3), (14, 4)], cursor(5, "run2"));
    assert!(!join(&[a, b]).whole());
}
