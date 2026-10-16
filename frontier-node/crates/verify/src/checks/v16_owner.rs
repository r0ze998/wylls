//! V16 (partial; conquest contract §8.5 "Completion effects"): **a first
//! holding never changes owner** (`FirstHoldingTransferred`, T30; MC
//! §3.5: an occupation never transfers a first holding). Every Holding
//! write of the run: a Holding of `order` 1 whose generation is unchanged
//! keeps its `owner_citizen` (a re-founding after a release bumps the
//! generation); a CAPTURE_SETTLED into slot 1 is the same failure.
//!
//! The rest of V16 (occupation and capture effects, liberation, immunity,
//! the stake routing) is not implemented; the report lists this check as
//! `V16:first-holding-owner`.

use frontier_abi::layout::player::holding as H;
use frontier_abi::v2::log::CqKind;

use super::Ctx;
use crate::codes::FIRST_HOLDING_TRANSFERRED;
use crate::world::le;

const V: &str = "V16";

pub fn run(cx: &mut Ctx) {
    let w = cx.w;
    let f = cx.f;
    if !w.has_post {
        cx.missing(
            V,
            "holdings",
            0,
            None,
            "no post-states: Holding owners cannot be followed",
        );
        return;
    }
    let mut bad: Vec<(usize, (i32, i32, u8), u32, String)> = vec![];
    for (t, tx) in w.txs.iter().enumerate() {
        if !tx.ok {
            continue;
        }
        for (k, a) in &tx.post {
            let Some(a) = a else { continue };
            let post = &a.data;
            if post.len() != H::SIZE || post[..8] != H::MAGIC {
                continue;
            }
            let Some(before) = w.state_before(k, t) else {
                continue;
            };
            if before.len() != H::SIZE || before[..8] != H::MAGIC {
                continue;
            }
            if before[H::ORDER] != 1 || before[H::GEN] != post[H::GEN] {
                continue;
            }
            let owner = H::OWNER_CITIZEN..H::OWNER_CITIZEN + 32;
            if before[owner.clone()] != post[owner] {
                let pqs = (
                    le(&post[H::P..H::P + 2]) as u16 as i16 as i32,
                    le(&post[H::Q..H::Q + 2]) as u16 as i16 as i32,
                    post[H::SITE],
                );
                let bell = frontier_abi::prologue::bell_at(f.genesis_ts, tx.time).unwrap_or(0);
                bad.push((
                    t,
                    pqs,
                    bell,
                    format!(
                        "the owner of a first holding changed with its generation ({}) unchanged",
                        post[H::GEN]
                    ),
                ));
            }
        }
    }
    for r in &w.cq_recs {
        if r.kind == CqKind::CAPTURE_SETTLED && r.field("slot", true).first() == Some(&1) {
            let pqs = (
                le(r.field("p", false)) as u32 as i32,
                le(r.field("q", false)) as u32 as i32,
                r.field("site", false).first().copied().unwrap_or(0),
            );
            bad.push((
                r.tx,
                pqs,
                r.bell,
                "a capture settled into slot 1 (the first holding)".into(),
            ));
        }
    }
    for (t, (p, q, s), bell, detail) in bad {
        cx.fail(
            V,
            FIRST_HOLDING_TRANSFERRED,
            format!("holding ({p}, {q}, {s})"),
            bell,
            Some(t),
            detail,
        );
    }
}
