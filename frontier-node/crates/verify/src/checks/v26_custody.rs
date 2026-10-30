//! V26 guard (workstream 10, custody), listed as `V26:custody-guard`. The
//! custody check proper (the kernel's replay of every lot, order and
//! custody caravan) does not exist yet, so a history that carries any
//! custody trace is never a PASS:
//!
//! - in a season whose program has no custody (every ruleset up to
//!   `RULESET_HASH_V3`; the S1 program refuses the tags) a trace is a FAIL,
//!   `CustodyInProgramWithoutIt`;
//! - in a custody season (`RULESET_HASH_V4`, or a Season of
//!   `program_version >= PROGRAM_VERSION_CUSTODY`) it is UNVERIFIABLE,
//!   `CustodyUnverified`, until V26 replays it.
//!
//! A trace is: a custody instruction (0xC1–0xCB) of a landed transaction
//! (top level: a CPI is caught by what it leaves), a custody record
//! (`LOT_*`, a Lot's CLOSE), or, in any post-state or final account of the
//! program, a Lot, a Vault with custody counts, a Caravan with custody
//! fields. A failed transaction carrying a custody tag is not a trace (the
//! program refused it).

use frontier_abi::v2::layout::s1::{caravan as CV, lot as LT, vault as VA};
use frontier_abi::v2::log::CqKind;
use frontier_abi::v2::presets::{PROGRAM_VERSION_CUSTODY, RULESET_HASH_V4};
use frontier_abi::v2::Ix;

use super::{ent, Ctx};
use crate::codes::{CUSTODY_IN_PROGRAM_WITHOUT_IT, CUSTODY_UNVERIFIED};

const V: &str = "V26";
/// Findings listed one by one before the rest is counted in one line.
const LISTED: usize = 16;

/// Whether the season is a custody one.
pub fn custody_season(cx: &Ctx) -> bool {
    cx.cfg.ruleset_hash == RULESET_HASH_V4
        || cx.input.finals.values().flatten().any(|a| {
            fclient::decode::Season::decode(&a.data)
                .is_ok_and(|s| s.program_version >= PROGRAM_VERSION_CUSTODY)
        })
}

const LOT_KINDS: [CqKind; 9] = [
    CqKind::LOT_OPENED,
    CqKind::LOT_QUOTA,
    CqKind::LOT_INBOUND,
    CqKind::LOT_SHIPPED,
    CqKind::LOT_SETTLED,
    CqKind::LOT_ORDER,
    CqKind::LOT_REVOKED,
    CqKind::LOT_CONSUMED,
    CqKind::LOT_LOSS,
];

/// What custody leaves in an account of the program, if anything.
fn account_trace(d: &[u8]) -> Option<&'static str> {
    let magic = d.get(..8)?;
    let nonzero = |o: usize, n: usize| d.get(o..o + n).is_some_and(|b| b.iter().any(|x| *x != 0));
    if magic == LT::MAGIC {
        return Some("a Lot account");
    }
    if magic == VA::MAGIC && (nonzero(VA::CUSTODY_QUOTA, 64) || nonzero(VA::CUSTODY_LOTS, 2)) {
        return Some("a Vault with custody counts");
    }
    if magic == CV::MAGIC
        && (nonzero(CV::CUSTODY, 2)
            || nonzero(CV::CUSTODY_OWNER_TAG, 8)
            || nonzero(CV::TAKEN_BY_TAG, 8))
    {
        return Some("a Caravan with custody fields");
    }
    None
}

pub fn run(cx: &mut Ctx) {
    let w = cx.w;
    let program = w.program;
    let mut traces: Vec<(String, u32, Option<usize>, String)> = vec![];
    for (t, tx) in w.txs.iter().enumerate() {
        if !tx.ok {
            continue;
        }
        for ix in &tx.ixs {
            if let Some(x) = ix.tag().and_then(Ix::from_tag).filter(|x| x.is_custody()) {
                traces.push((
                    "transaction".into(),
                    u32::MAX,
                    Some(t),
                    format!("a landed {} instruction", x.name()),
                ));
            }
        }
        for (k, a) in &tx.post {
            if let Some(a) = a.as_ref().filter(|a| a.owner.to_bytes() == program) {
                if let Some(what) = account_trace(&a.data) {
                    traces.push((
                        ent("account", k),
                        u32::MAX,
                        Some(t),
                        format!("{what} after it"),
                    ));
                }
            }
        }
    }
    for r in &w.cq_recs {
        if LOT_KINDS.contains(&r.kind) {
            traces.push((
                "transaction".into(),
                r.bell,
                Some(r.tx),
                format!("record {} is custody's {}", r.pos, r.kind.name()),
            ));
        }
    }
    let lot_kind = frontier_abi::v2::layout::AccountKind::Lot as u8;
    for r in &w.recs {
        if r.kind == frontier_abi::log::Kind::CLOSE && r.key.first() == Some(&lot_kind) {
            traces.push((
                "transaction".into(),
                r.bell,
                Some(r.tx),
                format!("record {} closes a Lot", r.pos),
            ));
        }
    }
    for (k, a) in &w.finals {
        if let Some(a) = a.as_ref().filter(|a| a.owner.to_bytes() == program) {
            if let Some(what) = account_trace(&a.data) {
                traces.push((
                    ent("account", k),
                    u32::MAX,
                    None,
                    format!("{what} at the pinned slot"),
                ));
            }
        }
    }
    if traces.is_empty() {
        return;
    }
    let custody = custody_season(cx);
    let n = traces.len();
    for (i, (entity, bell, tx, what)) in traces.into_iter().enumerate() {
        if i == LISTED {
            let rest = format!("{} more custody traces", n - LISTED);
            if custody {
                cx.unverifiable(V, CUSTODY_UNVERIFIED, "season", u32::MAX, None, rest);
            } else {
                cx.fail(
                    V,
                    CUSTODY_IN_PROGRAM_WITHOUT_IT,
                    "season",
                    u32::MAX,
                    None,
                    rest,
                );
            }
            break;
        }
        if custody {
            cx.unverifiable(
                V,
                CUSTODY_UNVERIFIED,
                entity,
                bell,
                tx,
                format!("{what}: custody is not verified (no V26 replay yet)"),
            );
        } else {
            cx.fail(
                V,
                CUSTODY_IN_PROGRAM_WITHOUT_IT,
                entity,
                bell,
                tx,
                format!("{what} in a season whose program has no custody"),
            );
        }
    }
}
