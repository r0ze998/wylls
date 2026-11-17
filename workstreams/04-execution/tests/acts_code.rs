//! WRITTEN, NOT RUN (2026-11-17): the act receipt carries the gateway's `code` for this key's entry, as recorded,
//! under the same receiptVersion. A scripted fate reader; no gateway, no keys, nothing signed. Run it only with its
//! own approval.

mod common;

use std::cell::RefCell;
use std::collections::VecDeque;

use common::*;
use runexec::acts::{self, FateReader};
use runexec::store::Store;
use serde_json::{json, Value};

/// Answers in order (the last repeats); `None` is a failed read.
struct Script(RefCell<VecDeque<Option<Value>>>);

impl FateReader for Script {
    fn fate(&self, _a: &str, _k: &str) -> Result<Value, String> {
        let mut q = self.0.borrow_mut();
        let x = if q.len() > 1 { q.pop_front().unwrap() } else { q.front().cloned().flatten() };
        x.ok_or_else(|| "connection refused".to_string())
    }
}

fn script(v: Vec<Option<Value>>) -> Script {
    Script(RefCell::new(v.into()))
}

/// The wallet's fate view of a Duplicate entry (gateway.mjs actionFateView): code Duplicate, the EARLIER send's
/// signature, and that signature's chain fate.
fn duplicate_landed() -> Option<Value> {
    Some(json!({ "retained": true, "key": "resident:k1", "status": "failed", "code": "Duplicate", "sent": true,
                 "signature": "sigEarlier", "lastValidBlockHeight": 5000, "slotFloor": 4000, "signedAt": null,
                 "state": "landed", "fate": "landed", "commitment": "finalized", "queryFailed": false, "why": "finalized" }))
}

#[test]
fn a_duplicate_entry_keeps_its_code_in_the_receipt() {
    let s = Store::open(&db_path("acts-code-dup")).unwrap();
    let id = acts::register(&s, "agent1", "resident:k1", "resident", Some("ws13-run"), 1).unwrap();
    let r = acts::refresh(&s, &script(vec![duplicate_landed()]), &id).unwrap();
    assert_eq!(r["code"], json!("Duplicate"));
    assert_eq!(r["receiptVersion"], json!("p04-acts/0.1"), "an added field, the same version");
    // Unchanged fields: the state and signature are the wallet's reading, as before.
    assert_eq!((r["state"].as_str(), r["signature"].as_str()), (Some("landed"), Some("sigEarlier")));
    // Store-only (no read): the same code from the recorded reading.
    assert_eq!(acts::receipt(&s, &id).unwrap()["code"], json!("Duplicate"));
}

#[test]
fn a_plain_send_has_a_null_code_and_a_failed_read_keeps_what_was_known() {
    let s = Store::open(&db_path("acts-code-plain")).unwrap();
    let id = acts::register(&s, "agent1", "resident:k2", "resident", None, 1).unwrap();
    let pending = Some(json!({ "state": "pending", "sent": true, "signature": "sigA", "lastValidBlockHeight": 5000,
                                "slotFloor": 4000, "commitment": "confirmed", "why": "confirmed" }));
    let r = acts::refresh(&s, &script(vec![pending]), &id).unwrap();
    assert!(r["code"].is_null(), "no code: null, as other absent facts");

    let s2 = Store::open(&db_path("acts-code-kept")).unwrap();
    let id2 = acts::register(&s2, "agent1", "resident:k3", "resident", None, 1).unwrap();
    let pending_dup = Some(json!({ "status": "failed", "code": "Duplicate", "sent": true, "signature": "sigEarlier",
                                    "state": "pending", "commitment": "confirmed", "why": "confirmed" }));
    acts::refresh(&s2, &script(vec![pending_dup]), &id2).unwrap();
    let after = acts::refresh(&s2, &script(vec![None]), &id2).unwrap();
    assert_eq!(after["state"], json!("unqueryable"));
    assert_eq!(after["code"], json!("Duplicate"), "a failed read keeps the recorded facts, the code with them");
}
