//! V0E — evidence a successful transaction must leave for the other checks
//! to judge it (⑪, 2026-11-05; beside ⑱'s V0, which judges the
//! instructions themselves). The checks read the program's records from the
//! logs and the accounts from the post-states; when those are missing, cut
//! short, or produced by a call the archive does not show, nothing judges
//! what happened, and the report used to say PASS. So, for every
//! **successful** transaction, each of these is `Unverifiable` (never a
//! PASS, never a FAIL: the program may well have run correctly):
//!
//! - `MissingLogs`: it calls the program at top level, and its logs show no
//!   invocation of the program at all (an archive without logs); or it only
//!   names the program among its accounts (a possible CPI) and has no logs
//!   at all (r6);
//! - `TruncatedLogs`: the runtime cut its logs (`Log truncated`), so
//!   records after the cut are absent (also when it only names the program,
//!   r6);
//! - `IncompleteLogs` (r6): an invocation of the program has no `success`
//!   line, though the transaction succeeded: the archive lost the tail of
//!   its logs without the runtime's marker;
//! - `UnverifiedInnerInstruction`: the program ran inside another program
//!   (`Program <id> invoke [n]`, n > 1). The archive keeps top-level
//!   instructions only; V0 never sees these;
//! - `MissingPostState` (archives with post-states only): it held writable
//!   an account of the program the archive knows (a post-state or final
//!   state of a program kind other than Holding, which V7 covers), and its
//!   post-states do not include it. A transaction with **no** post-state at
//!   all is reported only when one of its program instructions is not a
//!   `Close…` one: the recorded archives keep no post-state for a
//!   transaction that only closes accounts (CloseArrivalDay and
//!   CloseArrivalSlot in `march-program`), and V1 judges a closed chain by
//!   its tombstone;
//! - `UnverifiedRecord` (r7): it carries a record no check judges where it
//!   stands: a conquest kind outside [`MODELLED_CQ_KINDS`] (a kind a later
//!   ABI adds, such as workstream 20's RESIDENT_JOINED, is not a PASS
//!   until a check models it and the list names it), or a DIVERT in a
//!   transaction without a TRANSIT_SETTLED (V13 judges DIVERTs only there).
//!   Workstream 20's RESIDENT_JOINED (130, [`CONDITIONAL_CQ_KINDS`]) is
//!   judged only where the program emits it: a transaction whose top-level
//!   JoinResident (`resident_wire::JOIN_RESIDENT`) names the record's
//!   generation and faction (V0 judges that instruction, V9 the record's
//!   key, V12 its explore floor). Anywhere else, or not matching, it is
//!   `UnverifiedRecord` (r8).

use std::collections::BTreeSet;

use frontier_abi::layout::AccountKind;
use frontier_abi::log::Kind;

use super::Ctx;
use crate::codes::*;
use crate::world::Key;

const V: &str = "V0E";

/// The line the runtime appends when a transaction's logs exceed the limit.
pub const LOG_TRUNCATED: &str = "Log truncated";

/// The conquest record kinds (ABI v2, 80–104) the checks of this verifier
/// read. Deliberately a literal list: a kind the ABI adds later is not
/// judged by any check here until one models it. 104 (FRONTIER_EXTENDED,
/// map growth) is V26's.
pub const MODELLED_CQ_KINDS: &[u8] = &[
    80, 81, 82, 83, 84, 85, 86, 87, 88, 90, 91, 92, 93, 94, 95, 96, 97, 98, 99, 100, 101, 102, 103,
    104,
];

/// Conquest kinds judged only beside the instruction that emits them (see
/// [`explained`]): ⑳'s RESIDENT_JOINED (130), emitted by JoinResident only.
pub const CONDITIONAL_CQ_KINDS: &[u8] = &[130];

/// Conquest kinds the ABI knows that no check of this verifier models, and
/// whose every record a guard keeps from a PASS: workstream 10's custody
/// records (LOT_OPENED 105 … LOT_LOSS 113), which `V26:custody-guard` makes a
/// FAIL in a program without custody and UNVERIFIABLE in a custody season,
/// until V26 replays custody. Listing them here changes nothing V0E reports:
/// each such record is still `UnverifiedRecord`. The list only answers the
/// tripwire test that every conquest kind has been decided on (⑪, 2026-11-07).
pub const GUARDED_CQ_KINDS: &[u8] = &[105, 106, 107, 108, 109, 110, 111, 112, 113];

/// Whether `c` (a kind of [`CONDITIONAL_CQ_KINDS`]) stands beside the
/// instruction that emits it: a top-level JoinResident of the same
/// transaction (`tag ‖ generation u32 ‖ faction u8`) with the record's
/// generation and faction.
fn explained(w: &crate::world::World, c: &crate::world::CqRec) -> bool {
    if c.kind as u8 != 130 {
        return false;
    }
    let (Ok(g), [f]) = (
        <[u8; 4]>::try_from(c.field("generation", true)),
        c.field("faction", true),
    ) else {
        return false;
    };
    w.txs.get(c.tx).is_some_and(|t| {
        t.ixs.iter().any(|ix| {
            ix.tag() == Some(frontier_abi::resident_wire::JOIN_RESIDENT)
                && ix.data.get(1..5) == Some(&g[..])
                && ix.data.get(5) == Some(f)
        })
    })
}

fn program_kind(data: &[u8]) -> Option<AccountKind> {
    AccountKind::from_magic(data.get(..8)?.try_into().ok()?)
}

pub fn run(cx: &mut Ctx) {
    let w = cx.w;
    let program = cx.cfg.program.to_string();
    let invoke = format!("Program {program} invoke [");
    // Program accounts the archive knows (by a post-state or a final
    // state of a program kind), Holdings excepted (V7).
    let known: BTreeSet<Key> = w
        .txs
        .iter()
        .flat_map(|t| t.post.iter())
        .chain(w.finals.iter())
        .filter(|(_, a)| {
            a.as_ref().is_some_and(|a| {
                a.owner.to_bytes() == w.program
                    && program_kind(&a.data).is_some_and(|k| k != AccountKind::Holding)
            })
        })
        .map(|(k, _)| *k)
        .collect();
    for c in &w.cq_recs {
        let k = c.kind as u8;
        let judged = MODELLED_CQ_KINDS.contains(&k)
            || (CONDITIONAL_CQ_KINDS.contains(&k) && explained(w, c));
        if !judged {
            cx.unverifiable(
                V,
                UNVERIFIED_RECORD,
                format!("tx#{}", c.tx),
                c.bell,
                Some(c.tx),
                format!(
                    "record kind {} is judged by no check of this verifier",
                    c.kind as u8
                ),
            );
        }
    }
    for (i, t) in w.txs.iter().enumerate() {
        if !t.ok {
            continue;
        }
        let kinds = || t.recs.iter().map(|&n| w.recs[n].kind);
        if kinds().any(|k| k == Kind::DIVERT) && !kinds().any(|k| k == Kind::TRANSIT_SETTLED) {
            cx.unverifiable(
                V,
                UNVERIFIED_RECORD,
                format!("tx#{i}"),
                0,
                Some(i),
                "a DIVERT outside a TRANSIT_SETTLED is judged by no check",
            );
        }
        let logs = cx
            .input
            .txs
            .get(i)
            .map(|r| r.logs.as_slice())
            .unwrap_or(&[]);
        let top = logs.iter().filter(|l| **l == format!("{invoke}1]")).count();
        let nested = logs
            .iter()
            .filter(|l| l.starts_with(&invoke) && !l.ends_with("[1]"))
            .count();
        let truncated = logs.iter().any(|l| l == LOG_TRUNCATED);
        // Calls it at top level, or names it among its accounts (it may
        // have been reached by CPI: ③'s courier; ⑯ P1's A8).
        let reaches = !t.ixs.is_empty() || t.keys.iter().any(|(k, _)| *k == w.program);
        // Cut before the program's first line: the cut, not an absent log.
        // A transaction that only names the program, with logs that show
        // it never ran, is harmless (V2 warns); with no logs at all, nothing
        // tells whether it ran (r6).
        let no_logs_for_a_call = !t.ixs.is_empty() && top == 0 && nested == 0;
        let no_logs_for_a_mention = t.ixs.is_empty() && reaches && logs.is_empty();
        if (no_logs_for_a_call || no_logs_for_a_mention) && !truncated {
            cx.unverifiable(
                V,
                MISSING_LOGS,
                format!("tx#{i}"),
                0,
                Some(i),
                "it calls the program and its logs show no invocation of it: its records are not in the archive",
            );
        }
        if (reaches || top > 0 || nested > 0) && truncated {
            cx.unverifiable(
                V,
                TRUNCATED_LOGS,
                format!("tx#{i}"),
                0,
                Some(i),
                "the runtime cut its logs: records after the cut are not in the archive",
            );
        }
        // Every invocation of the program in a successful transaction ends
        // with its `success` line; fewer means the archive lost the tail of
        // the logs without the runtime's marker (r6).
        let ended = logs
            .iter()
            .filter(|l| **l == format!("Program {program} success"))
            .count();
        if !truncated && ended < top + nested {
            cx.unverifiable(
                V,
                INCOMPLETE_LOGS,
                format!("tx#{i}"),
                0,
                Some(i),
                format!(
                    "the program was invoked {} time(s) and {ended} invocation(s) end in the logs: the rest of its records are not in the archive",
                    top + nested
                ),
            );
        }
        if nested > 0 {
            cx.unverifiable(
                V,
                UNVERIFIED_INNER_INSTRUCTION,
                format!("tx#{i}"),
                0,
                Some(i),
                format!(
                    "the program ran inside another program {nested} time(s); the archive has no inner instruction to judge"
                ),
            );
        }
        let only_closes = t.ixs.iter().all(|ix| {
            ix.tag()
                .and_then(frontier_abi::v2::Ix::from_tag)
                .is_some_and(|x| x.name().starts_with("Close"))
        });
        if w.has_post && !(t.post.is_empty() && only_closes) {
            for (k, writable) in &t.keys {
                if *writable && known.contains(k) && !t.post.contains_key(k) {
                    cx.unverifiable(
                        V,
                        MISSING_POST_STATE,
                        format!("tx#{i}"),
                        0,
                        Some(i),
                        "it held a program account writable and the archive has no post-state of it",
                    );
                }
            }
        }
    }
}
