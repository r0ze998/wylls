//! The machine-readable view of one persisted run (`runexec run view`, and
//! the answer of `run accept`): what the store holds, read in **one**
//! snapshot, so a run, its transitions, attempts, receipts and fees are
//! all of the same moment even while an executor writes beside the reader.
//!
//! `sent` and `settled` come from receipts of a confirmed send or
//! settlement, never from the state of a request: a stored request is
//! not a send.

use serde_json::{json, Value};

use crate::store::{Step, Store};

/// The schema name of the view.
pub const RUN_VIEW_VERSION: &str = "p04-run/0.1";

/// The persisted run as JSON (`None`: no such run), all fields from one
/// read snapshot ([`Store::read_snapshot`]).
pub fn run_view(s: &Store, id: &str) -> Result<Option<Value>, String> {
    run_view_at(s, id, || {})
}

/// [`run_view`] with a hook run between the first read (the run row,
/// which fixes the snapshot) and the rest. For tests: a write committed
/// on another connection inside the hook must not show in the answer.
pub fn run_view_at(
    s: &Store,
    id: &str,
    between_reads: impl FnOnce(),
) -> Result<Option<Value>, String> {
    s.read_snapshot(|s| {
        let Some(r) = s.load(id)? else {
            return Ok(None);
        };
        between_reads();
        let receipts = s.receipts(id)?;
        let effects: Vec<String> = receipts.iter().map(|x| x.kind.clone()).collect();
        let transitions: Vec<Value> = s
            .history(id)?
            .into_iter()
            .map(|(from, to, by, why)| {
                json!({ "from": from, "to": to, "executor": by, "reason": why })
            })
            .collect();
        let mut attempts = vec![];
        for step in [Step::Facility, Step::Ship] {
            for a in s.attempts(id, step)? {
                attempts.push(json!({
                    "step": a.step,
                    "request_key": a.request_key,
                    "sig": a.prepared.sig,
                    "valid_until": a.prepared.valid_until,
                    "fee": a.prepared.fee,
                    "status": a.status,
                }));
            }
        }
        Ok(Some(json!({
            "view_version": RUN_VIEW_VERSION,
            "run_id": id,
            "cargo_only": r.spec.cargo_only(),
            "state": r.state.name(),
            "terminal": r.state.terminal(),
            "in_flight": r.state.in_flight(),
            "held_reason": r.held,
            "cancel_requested": r.cancel_requested,
            "cancel_phase": r.cancel_phase(),
            "version": r.version,
            "next_check": r.next_check,
            "spec_digest": r.spec.digest(),
            "spec": r.spec,
            "detail": r.detail,
            "reason": r.detail.reason,
            "outcome": r.detail.outcome,
            "sent": effects.iter().any(|k| k == "caravan_sent"),
            "settled": effects.iter().any(|k| k == "caravan_settled"),
            "effects": effects,
            "fees": s.fees(id)?,
            "transitions": transitions,
            "attempts": attempts,
            "receipts": receipts,
        })))
    })
}
