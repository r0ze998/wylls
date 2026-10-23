//! V15 / V18 / V19 at the record level (conquest contract §8.5), listed as
//! `V15:conquest-records`: every CONQUEST, KEEP and RETIRE record of a
//! transaction, in order, equals the one the replayed conquest step leaves
//! (V7's v2 skip and clash replays run `conquest_model::step` bell by
//! bell; [`crate::cqrec`] rebuilds the records as the program's
//! `emit_conquest` does). A site event that differs is
//! `SiegeProgressMismatch` (V15: a siege's progress, completion or
//! failure); a keep event, the keep's fields, a KEEP or a RETIRE that
//! differs is `KeepMismatch` (V18); a snapshot that differs is
//! `SnapshotMismatch` (V19); the conquest records' digest alone differing
//! is `SiegeProgressMismatch`. The records of a transaction whose bells
//! were not replayed (V7 reported why) are `MissingData`.
//!
//! Not the whole of V15/V18/V19: a siege's legality at its declaration
//! (V14), the vigil the snapshot was taken from, the folds' arithmetic and
//! the Dominion sums (V19 `MarchFoldMismatch`, `CaptureCreditMismatch`)
//! are not judged here.

use std::collections::{BTreeMap, BTreeSet};

use frontier_abi::v2::log::{event, keep_cause, retire_by, ConquestPayload, CqKind};

use super::Ctx;
use crate::codes::{KEEP_MISMATCH, SIEGE_PROGRESS_MISMATCH, SNAPSHOT_MISMATCH};
use crate::cqrec::Expected;
use crate::world::{le, CqRec};

const V: &str = "V15";

/// `(code, detail)` of a logged CONQUEST payload against the replay's.
fn classify_conquest(got: &[u8], want: &[u8]) -> (&'static str, String) {
    let (Some(g), Some(w)) = (
        ConquestPayload::from_bytes(got),
        ConquestPayload::from_bytes(want),
    ) else {
        return (
            SIEGE_PROGRESS_MISMATCH,
            "the CONQUEST payload does not decode".into(),
        );
    };
    let ge = &g.events[..g.n.min(14) as usize];
    let we = &w.events[..w.n.min(14) as usize];
    if ge != we {
        let site_event = ge
            .iter()
            .chain(we.iter())
            .any(|e| e.site != event::KEEP_SITE);
        let detail = format!(
            "events logged {:?}, the replay's {:?}",
            ge.iter()
                .map(|e| (e.site, e.code, e.faction, e.progress))
                .collect::<Vec<_>>(),
            we.iter()
                .map(|e| (e.site, e.code, e.faction, e.progress))
                .collect::<Vec<_>>()
        );
        return (
            if site_event {
                SIEGE_PROGRESS_MISMATCH
            } else {
                KEEP_MISMATCH
            },
            detail,
        );
    }
    if (
        g.keep_holder,
        g.keep_contender,
        g.keep_progress,
        g.keep_troops,
        g.donor_host_id,
    ) != (
        w.keep_holder,
        w.keep_contender,
        w.keep_progress,
        w.keep_troops,
        w.donor_host_id,
    ) {
        return (
            KEEP_MISMATCH,
            format!(
                "keep logged (holder {}, contender {}, progress {}, troops {}, donor {}), the replay's ({}, {}, {}, {}, {})",
                g.keep_holder, g.keep_contender, g.keep_progress, g.keep_troops, g.donor_host_id,
                w.keep_holder, w.keep_contender, w.keep_progress, w.keep_troops, w.donor_host_id
            ),
        );
    }
    if g.snapshot != w.snapshot {
        return (
            SNAPSHOT_MISMATCH,
            format!(
                "snapshot logged {:?}, the replay's {:?}",
                g.snapshot, w.snapshot
            ),
        );
    }
    (
        SIEGE_PROGRESS_MISMATCH,
        "the conquest records' digest after the step differs from the replay's".into(),
    )
}

fn pq_of(key: &[u8]) -> (i32, i32) {
    (
        le(key.get(0..4).unwrap_or(&[])) as u32 as i32,
        le(key.get(4..8).unwrap_or(&[])) as u32 as i32,
    )
}

pub fn run(cx: &mut Ctx) {
    let w = cx.w;
    // The records a step leaves: CONQUEST; KEEP of cause TAKEN (a PLACED
    // keep is OpenProvince's, V22's); RETIRE by the keep donor (a victim's
    // or after-end RetireHost is V17's).
    let of_step = |r: &CqRec| match r.kind {
        CqKind::CONQUEST => true,
        CqKind::KEEP => r.payload.first() == Some(&keep_cause::TAKEN),
        CqKind::RETIRE => r.field("by", true).first() == Some(&retire_by::KEEP_DONOR),
        _ => false,
    };
    let mut logged: BTreeMap<usize, Vec<&CqRec>> = BTreeMap::new();
    for r in &w.cq_recs {
        if of_step(r) {
            logged.entry(r.tx).or_default().push(r);
        }
    }
    let txs: BTreeSet<usize> = logged
        .keys()
        .copied()
        .chain(cx.cq_expected.keys().copied())
        .collect();
    // (code, entity, bell, tx, detail)
    let mut bad: Vec<(&'static str, String, u32, usize, String)> = vec![];
    let mut missing: Vec<(String, u32, usize, usize)> = vec![];
    let entity_of = |e: Option<&Expected>, g: Option<&&CqRec>| -> (String, u32) {
        match (e, g) {
            (Some(e), _) => {
                let (p, q) = pq_of(&e.key);
                (format!("province ({p}, {q})"), e.bell)
            }
            (None, Some(g)) => {
                let (p, q) = pq_of(&g.key);
                let b = if g.kind == CqKind::CONQUEST {
                    le(g.key.get(8..12).unwrap_or(&[])) as u32
                } else {
                    g.bell
                };
                (format!("province ({p}, {q})"), b)
            }
            (None, None) => ("province".into(), 0),
        }
    };
    for t in txs {
        let got = logged.get(&t).cloned().unwrap_or_default();
        if !cx.cq_replayed.contains(&t) {
            if let Some(first) = got.first() {
                let (what, b) = entity_of(None, Some(first));
                missing.push((what, b, t, got.len()));
            }
            continue;
        }
        let want = cx.cq_expected.get(&t).cloned().unwrap_or_default();
        for i in 0..got.len().max(want.len()) {
            match (got.get(i), want.get(i)) {
                (Some(g), Some(e)) => {
                    if g.kind == e.kind && g.key == e.key && g.payload == e.payload {
                        continue;
                    }
                    let (what, b) = entity_of(Some(e), Some(g));
                    let (code, detail) = if g.kind != e.kind || g.key != e.key {
                        (
                            if e.kind == CqKind::CONQUEST {
                                SIEGE_PROGRESS_MISMATCH
                            } else {
                                KEEP_MISMATCH
                            },
                            format!(
                                "record {} of the transaction is {} {}, the replay leaves {} {}",
                                i,
                                g.kind.name(),
                                hex::encode(&g.key),
                                e.kind.name(),
                                hex::encode(&e.key)
                            ),
                        )
                    } else if e.kind == CqKind::CONQUEST {
                        classify_conquest(&g.payload, &e.payload)
                    } else {
                        (
                            KEEP_MISMATCH,
                            format!(
                                "{} payload {}, the replay leaves {}",
                                e.kind.name(),
                                hex::encode(&g.payload),
                                hex::encode(&e.payload)
                            ),
                        )
                    };
                    bad.push((code, what, b, t, detail));
                }
                (Some(g), None) => {
                    let (what, b) = entity_of(None, Some(g));
                    bad.push((
                        if g.kind == CqKind::CONQUEST {
                            SIEGE_PROGRESS_MISMATCH
                        } else {
                            KEEP_MISMATCH
                        },
                        what,
                        b,
                        t,
                        format!(
                            "a {} record the replayed step does not leave",
                            g.kind.name()
                        ),
                    ));
                }
                (None, Some(e)) => {
                    let (what, b) = entity_of(Some(e), None);
                    bad.push((
                        if e.kind == CqKind::CONQUEST {
                            SIEGE_PROGRESS_MISMATCH
                        } else {
                            KEEP_MISMATCH
                        },
                        what,
                        b,
                        t,
                        format!(
                            "the replayed step leaves a {} record the chain did not log",
                            e.kind.name()
                        ),
                    ));
                }
                (None, None) => {}
            }
        }
    }
    for (what, b, t, n) in missing {
        cx.missing(
            V,
            what,
            b,
            Some(t),
            format!("{n} conquest records of a transaction whose bells V7 did not replay"),
        );
    }
    for (code, what, b, t, detail) in bad {
        cx.fail(V, code, what, b, Some(t), detail);
    }
}
