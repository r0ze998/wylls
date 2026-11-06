//! V0H — the history evidence (2026-11-07; beside ⑱'s V0 and ⑪'s V0E).
//! Every other check judges the transactions it is given. None of them
//! can tell whether those are *all* of the season's: a findex archive
//! proves its own integrity, one node's signature poll cannot show a gap
//! on its first pull nor a range its own history lacks
//! (`findex::ingest`), and a recording is whatever was recorded. So a
//! PASS over a partial history used to read as a PASS over the season.
//!
//! The loaders now say what they observed ([`crate::input::HistoryEvidence`])
//! and this check judges it by [`Assurance`]:
//!
//! - `DatasetOnly` (a fixture, a slice, a builder, or nothing recorded)
//!   and `LocalFeed` (a local node's own feed: the harness): no finding.
//!   The verdict is about the dataset given, and the report labels it so
//!   (`history.assurance`, the Markdown's "History evidence" line). This
//!   keeps the recorded fixtures and the stack's own runs verifiable
//!   offline without claiming more than they can;
//! - `Unverifiable` (an archive or one node's poll read in full):
//!   `HistoryCoverageUnverifiable`. A real-chain claim needs coverage
//!   evidence this tree does not have (workstream 19's bundle has not
//!   been received); an agreeing second observation (`cross_checked`) is
//!   reported but is not proof of completeness or finality;
//! - `EmptyObservation` (a source that returned nothing):
//!   `HistoryCoverageUnverifiable`. An empty read is a genuine observation
//!   and not evidence that the season has no transactions (a wrong
//!   program id, a wrong node and pruned history look the same);
//! - `Gap`: `HistoryGap`; `NotObserved` (a source named but not read, or
//!   a feed, archive or poll with no observation recorded: a local feed
//!   is not the harness's dataset until it is read): `HistoryNotObserved`;
//!   `Malformed` (a `history` block this verifier cannot read, or read
//!   bounds no read can produce): `HistoryEvidenceMalformed`. Nothing
//!   missing, legacy or broken is ever read as better than it is.
//!
//! Every finding here is `Unverifiable`: the program may well have run
//! correctly; what is missing is evidence about the input, so the season
//! is not judged either way.

use super::Ctx;
use crate::codes::*;
use crate::input::Assurance;

const V: &str = "V0H";
const ENTITY: &str = "history";

pub fn run(cx: &mut Ctx) {
    let h = &cx.input.history;
    let given = cx.input.txs.len();
    let what = h.describe();
    match h.assurance() {
        Assurance::DatasetOnly | Assurance::LocalFeed => {}
        Assurance::Unverifiable => {
            cx.unverifiable(
                V,
                HISTORY_COVERAGE_UNVERIFIABLE,
                ENTITY,
                0,
                None,
                format!(
                    "{what}; {given} transactions judged. Nothing shows they are all of the season's: the source proves no completeness, and this verifier has no coverage evidence to compare it with"
                ),
            );
        }
        Assurance::EmptyObservation => {
            cx.unverifiable(
                V,
                HISTORY_COVERAGE_UNVERIFIABLE,
                ENTITY,
                0,
                None,
                format!(
                    "{what}. An empty read is not evidence that the season has no transactions (a wrong program id, a wrong node and pruned history look the same)"
                ),
            );
        }
        Assurance::Gap => {
            cx.unverifiable(
                V,
                HISTORY_GAP,
                ENTITY,
                0,
                None,
                format!("{what}; the {given} transactions given are a known partial history"),
            );
        }
        Assurance::NotObserved => {
            cx.unverifiable(
                V,
                HISTORY_NOT_OBSERVED,
                ENTITY,
                0,
                None,
                format!("{what}; nothing shows the {given} transactions given were read from the source named, nor what that read returned"),
            );
        }
        Assurance::Malformed => {
            cx.unverifiable(
                V,
                HISTORY_EVIDENCE_MALFORMED,
                ENTITY,
                0,
                None,
                format!("{what}; the evidence is not read as anything better"),
            );
        }
    }
}
