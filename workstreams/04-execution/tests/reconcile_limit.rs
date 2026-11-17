//! `Store::attempts_to_reconcile`: `limit` counts attempts that are past
//! their validity. Rows that are never past validity (a gateway attempt's
//! `valid_until` is `u64::MAX`) at the front of the order must not keep later
//! attempts from being reconciled (`docs/RUNBOOK.ja.md` §5: every tick
//! settles `superseded` attempts past validity). WRITTEN, NOT RUN (2026-11-17):
//! run it only with its own approval. A store in this test's own SQLite file;
//! no network, no keys, nothing signed.

mod common;

use common::*;
use runexec::ports::{Prepared, Request};
use runexec::store::Store;

/// Inserts one attempt row directly (the table has no foreign key).
fn attempt(s: &Store, sig: &str, status: &str, valid_until: u64, fee: Option<i64>) {
    let p = Prepared {
        sig: sig.into(),
        request: Request::SendCaravan {
            owner: OWNER,
            seq: 0,
            src: holding(-3, 7, 11),
            dst: vault(-3, 7, 20),
            cargo: r(6, 3),
        },
        wire: vec![],
        valid_until,
        fee: 5,
    };
    s.conn
        .execute(
            "INSERT INTO attempts(run_id, step, request_key, sig, prepared, status, epoch, slot, fee_charged)
             VALUES('r1', 'Ship', 'k', ?1, ?2, ?3, 1, 1, ?4)",
            rusqlite::params![sig, serde_json::to_string(&p).unwrap(), status, fee],
        )
        .unwrap();
}

#[test]
fn never_expiring_rows_do_not_starve_later_ones() {
    let s = Store::open(&db_path("reconcile-limit")).unwrap();
    for i in 0..20 {
        attempt(&s, &format!("gw{i}"), "superseded", u64::MAX, None);
    }
    attempt(&s, "late-superseded", "superseded", 10, None);
    attempt(&s, "late-landed", "landed", 10, None);
    let got: Vec<String> = s
        .attempts_to_reconcile(100, 16)
        .unwrap()
        .into_iter()
        .map(|a| a.prepared.sig)
        .collect();
    assert_eq!(got, vec!["late-superseded", "late-landed"], "the past-validity rows behind 20 never-expiring ones");
}

#[test]
fn limit_counts_returned_rows_and_filters_are_unchanged() {
    let s = Store::open(&db_path("reconcile-limit-2")).unwrap();
    for i in 0..20 {
        attempt(&s, &format!("old{i}"), "superseded", 10, None);
    }
    attempt(&s, "not-yet", "superseded", 500, None);
    attempt(&s, "fee-known", "landed", 10, Some(7));
    attempt(&s, "decided", "expired", 10, None);
    let got = s.attempts_to_reconcile(100, 16).unwrap();
    assert_eq!(got.len(), 16, "at most `limit`");
    assert!(got.iter().all(|a| a.prepared.valid_until < 100));
    assert_eq!(got[0].prepared.sig, "old0", "oldest first, as before");
    let all: Vec<String> = s.attempts_to_reconcile(100, 100).unwrap().into_iter().map(|a| a.prepared.sig).collect();
    assert_eq!(all.len(), 20, "not the unexpired one, not a landed one with its fee known, not a decided one");
    assert!(s.attempts_to_reconcile(100, 0).unwrap().is_empty(), "limit 0: nothing");
}
