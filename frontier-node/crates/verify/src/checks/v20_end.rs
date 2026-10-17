//! V20 (partial; conquest contract §8.5 "Season end"): no completion, keep
//! capture or occupation start at or after `end_bell` (`CompletionAfterEnd`,
//! T33: a CONQUEST record's OCCUPIED, CAPTURE_DUE or KEEP_TAKEN event at a
//! step bell ≥ `end_bell`); once the season has ended (the final Season's
//! status), no site's conquest record is live or owes a stake or a slot
//! (`SiegeNotSettled`: a lapsed siege is settled by SettleSiege at the
//! end, a completed one by SettleCapture or the occupation's own end, so
//! the final Provinces carry only zero records); no outpost
//! founded at or after `end_bell − 24` (`OutpostAfterClose`; the contract
//! bounds the filing, this reads the OUTPOST_SETTLED record's bell, which
//! is at or after it). The lapsed sieges' stake return and slot release
//! are not checked. The report lists this check as `V20:season-end`.

use frontier_abi::layout::province::province as PV;
use frontier_abi::layout::world::season as S;
use frontier_abi::v2::layout::province::{conquest as CR, province as P2};
use frontier_abi::log::NO_BELL;
use frontier_abi::v2::log::{event, ConquestPayload, CqKind};

use super::Ctx;
use crate::codes::{COMPLETION_AFTER_END, OUTPOST_AFTER_CLOSE, SIEGE_NOT_SETTLED};
use crate::world::le;

const V: &str = "V20";

/// The contract's outpost close: no outpost filed in the last day.
pub const OUTPOST_CLOSE_BELLS: u32 = 24;

pub fn run(cx: &mut Ctx) {
    let w = cx.w;
    let f = cx.f;
    let Some(end) = f.params.as_ref().map(|p| p.end_bell) else {
        cx.missing(
            V,
            "season",
            0,
            None,
            "no CreateSeason parameters: end_bell unknown",
        );
        return;
    };
    let pq = |r: &crate::world::CqRec| {
        (
            le(r.field("p", false)) as u32 as i32,
            le(r.field("q", false)) as u32 as i32,
        )
    };
    for r in w.cq_recs.iter() {
        match r.kind {
            CqKind::CONQUEST => {
                let b = le(r.field("bell", false)) as u32;
                if b < end {
                    continue;
                }
                let Some(pl) = ConquestPayload::from_bytes(&r.payload) else {
                    continue;
                };
                let (p, q) = pq(r);
                for e in pl.events.iter().take(pl.n as usize) {
                    let code = e.code & !event::DETAIL;
                    if matches!(
                        code,
                        event::OCCUPIED | event::CAPTURE_DUE | event::KEEP_TAKEN
                    ) {
                        cx.fail(
                            V,
                            COMPLETION_AFTER_END,
                            format!("province ({p}, {q})"),
                            b,
                            Some(r.tx),
                            format!(
                                "conquest event {code} (site {}) at step bell {b}, at or after end_bell {end}",
                                e.site
                            ),
                        );
                    }
                }
            }
            CqKind::OUTPOST_SETTLED => {
                if r.bell != NO_BELL && r.bell.saturating_add(OUTPOST_CLOSE_BELLS) >= end {
                    let (p, q) = pq(r);
                    let s = r.field("site", false).first().copied().unwrap_or(0);
                    cx.fail(
                        V,
                        OUTPOST_AFTER_CLOSE,
                        format!("holding ({p}, {q}, {s})"),
                        r.bell,
                        Some(r.tx),
                        format!(
                            "an outpost settled at bell {}, within {OUTPOST_CLOSE_BELLS} bells of end_bell {end}",
                            r.bell
                        ),
                    );
                }
            }
            _ => {}
        }
    }
    // Once the season has ended, no site's record stays live or owing
    // (MC §3.11: every lapsed siege is settled at the end; a completed one
    // was settled by SettleCapture or the occupation's end).
    let ended = w
        .finals
        .get(&f.ctx.season)
        .and_then(|a| a.as_ref())
        .and_then(|a| a.data.get(S::STATUS).copied())
        .is_some_and(|st| st >= S::STATUS_ENDED);
    if !ended {
        return;
    }
    let mut open: Vec<(i32, i32, u8, u8, u8)> = vec![];
    for a in w.finals.values().flatten() {
        let d = &a.data;
        if d.len() != P2::SIZE || d[..8] != PV::MAGIC {
            continue;
        }
        let (p, q) = (
            le(&d[PV::P..PV::P + 2]) as u16 as i16 as i32,
            le(&d[PV::Q..PV::Q + 2]) as u16 as i16 as i32,
        );
        let n = (d[PV::SITE_COUNT] as usize).min(PV::SITES_N);
        for s in 0..n {
            let o = P2::record(s);
            let (kind, flags) = (d[o + CR::KIND], d[o + CR::FLAGS]);
            if kind != CR::KIND_NONE || flags & CR::OWED_MASK != 0 {
                open.push((p, q, s as u8, kind, flags));
            }
        }
    }
    for (p, q, s, kind, flags) in open {
        cx.fail(
            V,
            SIEGE_NOT_SETTLED,
            format!("holding ({p}, {q}, {s})"),
            end,
            None,
            format!("the season ended with the site's record live or owing (kind {kind}, flags {flags:#x})"),
        );
    }
}
