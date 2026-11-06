//! Agent acts registered as runs (`runexec::acts`): a scripted fate reader,
//! no gateway, no keys, nothing signed.

mod common;

use std::cell::RefCell;
use std::collections::VecDeque;

use common::*;
use runexec::acts::{self, FateReader};
use runexec::store::Store;
use serde_json::{json, Value};

/// Answers in order (the last repeats); `None` is a failed read.
struct Script(RefCell<VecDeque<Option<Value>>>);

impl Script {
    fn new(v: Vec<Option<Value>>) -> Script {
        Script(RefCell::new(v.into()))
    }
}

impl FateReader for Script {
    fn fate(&self, _a: &str, _k: &str) -> Result<Value, String> {
        let mut q = self.0.borrow_mut();
        let x = if q.len() > 1 {
            q.pop_front().unwrap()
        } else {
            q.front().cloned().flatten()
        };
        x.ok_or_else(|| "connection refused".to_string())
    }
}

fn signed(state: &str, commitment: Option<&str>) -> Option<Value> {
    Some(
        json!({ "state": state, "sent": true, "signature": "sigA", "lastValidBlockHeight": 5000,
                 "slotFloor": 4000, "signedAt": 1_762_000_000_000u64, "commitment": commitment, "why": state }),
    )
}

#[test]
fn registration_is_idempotent_and_never_merged() {
    let s = Store::open(&db_path("acts-reg")).unwrap();
    let a = acts::register(&s, "agent1", "ai:p05.r1", "ai", Some("p05-run-1"), 10).unwrap();
    assert_eq!(
        a,
        acts::register(&s, "agent1", "ai:p05.r1", "ai", Some("p05-run-1"), 99).unwrap()
    );
    assert!(a.starts_with("act-") && a.len() == 20);
    assert!(
        acts::register(&s, "agent1", "ai:p05.r1", "mcp", Some("p05-run-1"), 10).is_err(),
        "another source under the same key"
    );
    assert!(
        acts::register(&s, "agent1", "ai:p05.r1", "ai", Some("other-run"), 10).is_err(),
        "another caller run"
    );
    assert_ne!(
        a,
        acts::register(&s, "agent2", "ai:p05.r1", "ai", Some("p05-run-1"), 10).unwrap(),
        "per agent"
    );
    assert_eq!(acts::by_ext_run(&s, "p05-run-1").unwrap().len(), 2);
}

#[test]
fn pending_then_finalized_with_the_signing_facts() {
    let s = Store::open(&db_path("acts-pend")).unwrap();
    let id = acts::register(&s, "agent1", "mcp:r1", "mcp", None, 1).unwrap();
    let r = Script::new(vec![
        signed("pending", Some("confirmed")),
        signed("landed", Some("finalized")),
    ]);
    let p = acts::refresh(&s, &r, &id).unwrap();
    assert_eq!(
        (
            p["state"].as_str(),
            p["final"].as_bool(),
            p["commitment"].as_str()
        ),
        (Some("pending"), Some(false), Some("confirmed"))
    );
    assert_eq!(p["cancel"]["phase"], json!("AwaitingSigned"));
    assert_eq!(p["cancel"]["until"]["lastValidBlockHeight"], json!(5000));
    let l = acts::refresh(&s, &r, &id).unwrap();
    assert_eq!(
        (l["state"].as_str(), l["final"].as_bool()),
        (Some("landed"), Some(true))
    );
    assert_eq!(
        (
            l["signature"].as_str(),
            l["signedAt"].as_u64(),
            l["slotFloor"].as_u64()
        ),
        (Some("sigA"), Some(1_762_000_000_000), Some(4000))
    );
    assert_eq!(l["cancel"]["result"], json!("Irrevocable"));
    assert_eq!(l["cancel"]["phase"], json!("Completed"));
}

#[test]
fn a_failed_read_is_unqueryable_and_keeps_what_was_known() {
    let s = Store::open(&db_path("acts-unq")).unwrap();
    let id = acts::register(&s, "agent1", "ai:x", "ai", None, 1).unwrap();
    let r = Script::new(vec![
        signed("pending", Some("processed")),
        None,
        signed("landed", Some("finalized")),
    ]);
    acts::refresh(&s, &r, &id).unwrap();
    let u = acts::refresh(&s, &r, &id).unwrap();
    assert_eq!(u["state"], json!("unqueryable"));
    assert_eq!(
        u["signature"],
        json!("sigA"),
        "the signature is still known"
    );
    assert_eq!(u["lastReadError"], json!("connection refused"));
    assert_eq!(
        acts::refresh(&s, &r, &id).unwrap()["state"],
        json!("landed")
    );
}

#[test]
fn final_states_never_change_and_contradictions_are_kept_aside() {
    let s = Store::open(&db_path("acts-final")).unwrap();
    let id = acts::register(&s, "agent1", "ai:y", "ai", None, 1).unwrap();
    let r = Script::new(vec![
        signed("expired", None),
        None,
        signed("landed", Some("finalized")),
    ]);
    assert_eq!(
        acts::refresh(&s, &r, &id).unwrap()["state"],
        json!("expired")
    );
    assert_eq!(
        acts::refresh(&s, &r, &id).unwrap()["state"],
        json!("expired"),
        "a failed read changes nothing final"
    );
    let c = acts::refresh(&s, &r, &id).unwrap();
    assert_eq!(c["state"], json!("expired"));
    assert_eq!(
        c["conflict"]["state"],
        json!("landed"),
        "kept for the operator, not applied"
    );
}

#[test]
fn result_unknown_and_not_sent_are_distinct() {
    let s = Store::open(&db_path("acts-unknown")).unwrap();
    let u = acts::register(&s, "agent1", "ai:u", "ai", None, 1).unwrap();
    let n = acts::register(&s, "agent1", "ai:n", "ai", None, 1).unwrap();
    let ru = Script::new(vec![signed("unknown", None)]);
    let rn = Script::new(vec![Some(
        json!({ "state": "not-sent", "sent": false, "why": "refused before signing" }),
    )]);
    let a = acts::refresh(&s, &ru, &u).unwrap();
    assert_eq!(
        (
            a["state"].as_str(),
            a["final"].as_bool(),
            a["cancel"]["result"].as_str()
        ),
        (Some("unknown"), Some(false), Some("Irrevocable"))
    );
    let b = acts::refresh(&s, &rn, &n).unwrap();
    assert_eq!(
        (
            b["state"].as_str(),
            b["final"].as_bool(),
            b["cancel"]["result"].as_str()
        ),
        (Some("not-sent"), Some(true), Some("NotSent"))
    );
    assert!(b["signature"].is_null());
}

#[test]
fn a_restart_answers_from_the_store() {
    let path = db_path("acts-restart");
    let id = {
        let s = Store::open(&path).unwrap();
        let id = acts::register(&s, "agent1", "ai:z", "ai", Some("run-z"), 1).unwrap();
        acts::refresh(
            &s,
            &Script::new(vec![signed("landed", Some("finalized"))]),
            &id,
        )
        .unwrap();
        id
    };
    let s = Store::open(&path).unwrap();
    let r = acts::receipt(&s, &id).unwrap();
    assert_eq!(
        (
            r["state"].as_str(),
            r["signature"].as_str(),
            r["runId"].as_str()
        ),
        (Some("landed"), Some("sigA"), Some("run-z"))
    );
    assert_eq!(
        acts::run4_id("agent1", "ai:z"),
        id,
        "the same act gets the same id after a restart"
    );
    assert!(
        r["retention"]["retentionBells"].is_null(),
        "kept indefinitely (workstream 13 asks for >= 144 bells)"
    );
    assert!(
        acts::receipt(&s, "act-0000000000000000").is_err(),
        "no record is not a state"
    );
}
