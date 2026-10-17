//! V19 (partial; conquest contract §8.5 "Control and folds"), listed as
//! `V19:march-folds`: every FoldMarch replayed from the states before its
//! transaction with the shared conquest model, as the program's
//! `fold_march` does (MC §3.10, §5.5 0xA5): the seven members' hour
//! samples (`conquest_model::fold`: a member opened after the hour weighs
//! nothing, one not resolved past it refuses, a ring slot moved past it
//! loses the hour), the hour applied to the MarchState
//! (`conquest_model::apply_fold`: the controller, a flip, the credited
//! faction's Dominion and control hours, the captures), the first fold
//! creating the MarchState at `first_hour`. Each MARCH_FOLD record of
//! the transaction must be the fold's log, in order, and the MarchState
//! written must be the replay's (`MarchFoldMismatch`). The snapshots the
//! folds read are V15's (a CONQUEST record's snapshot equals the step's).
//! Not independent: the shared model. Not judged: the Dominion sums of
//! credited captures (`CaptureCreditMismatch`), the herald's files.

use frontier_abi::conquest_model as cm;
use frontier_abi::v2::addr::{march_members, march_state};
use frontier_abi::v2::ix::FoldMarch;
use frontier_abi::v2::layout::world::march_state as MS;
use frontier_abi::v2::log::CqKind;
use frontier_abi::v2::tags::Ix as V2Ix;

use super::Ctx;
use crate::codes::MARCH_FOLD_MISMATCH;
use crate::world::le;

const V: &str = "V19";

/// The MarchState bytes the folds own: from `M` to `RENT_TO`.
const OWNED: core::ops::Range<usize> = MS::M..MS::RENT_TO;

pub fn run(cx: &mut Ctx) {
    let w = cx.w;
    let f = cx.f;
    let Some(cq) = f.cq.as_ref() else { return };
    let tag = V2Ix::FoldMarch.tag();
    if !w.has_post {
        if w.txs.iter().any(|tx| tx.ixs.iter().any(|i| i.tag() == Some(tag))) {
            cx.missing(V, "marches", 0, None, "no post-states: a fold cannot be replayed");
        }
        return;
    }
    let mut bad: Vec<(usize, String, u32, String)> = vec![];
    for (t, tx) in w.txs.iter().enumerate() {
        if !tx.ok {
            continue;
        }
        let folds: Vec<&crate::world::Ix> = tx.ixs.iter().filter(|i| i.tag() == Some(tag)).collect();
        if folds.is_empty() {
            continue;
        }
        let logged: Vec<&crate::world::CqRec> = w
            .cq_recs
            .iter()
            .filter(|r| r.tx == t && r.kind == CqKind::MARCH_FOLD)
            .collect();
        let mut expected: Vec<(i32, i32, u32, [u8; 44])> = vec![];
        let mut states: Vec<([u8; 32], Vec<u8>)> = vec![];
        for ix in folds {
            let Ok(x) = FoldMarch::decode(&ix.data) else {
                bad.push((t, "march".into(), 0, "the FoldMarch instruction does not decode".into()));
                continue;
            };
            let what = format!("march ({}, {})", x.m, x.n);
            let bell = x.hour.saturating_mul(cm::HOUR_BELLS);
            let mk = march_state(&f.ctx, x.m, x.n);
            if ix.key(2) != Some(mk) || ix.accounts.len() < 11 {
                bad.push((t, what, bell, "the instruction's MarchState is not the March's".into()));
                continue;
            }
            let coords = march_members(x.m, x.n);
            let mut datas: [Option<Vec<u8>>; 7] = Default::default();
            let mut ok = true;
            for (i, (mp, mq)) in coords.iter().enumerate() {
                let k = f.ctx.province(*mp, *mq);
                if ix.key(3 + i) != Some(k) {
                    bad.push((t, what.clone(), bell, format!("member {i} is not the canonical Province ({mp}, {mq})")));
                    ok = false;
                    break;
                }
                datas[i] = w.state_before(&k, t).map(|d| d.to_vec());
            }
            if !ok {
                continue;
            }
            let views: [Option<&[u8]>; 7] = core::array::from_fn(|i| datas[i].as_deref());
            // The MarchState before, or the first fold's fresh one.
            let mut md = match w.state_before(&mk, t) {
                Some(d) if d.len() == MS::SIZE => d.to_vec(),
                Some(_) => {
                    bad.push((t, what, bell, "the MarchState before is not a MarchState".into()));
                    continue;
                }
                None => {
                    let first = match cm::first_hour(&views) {
                        Ok(Some(h)) => h,
                        Ok(None) => {
                            bad.push((t, what, bell, "a first fold with no member present".into()));
                            continue;
                        }
                        Err(e) => {
                            bad.push((t, what, bell, format!("first_hour: {e:?}")));
                            continue;
                        }
                    };
                    let mut d = vec![0u8; MS::SIZE];
                    d[MS::M..MS::M + 4].copy_from_slice(&x.m.to_le_bytes());
                    d[MS::N..MS::N + 4].copy_from_slice(&x.n.to_le_bytes());
                    d[MS::NEXT_HOUR..MS::NEXT_HOUR + 4].copy_from_slice(&first.to_le_bytes());
                    d[MS::CONTROLLER] = MS::CONTROLLER_NONE;
                    d
                }
            };
            for k in 0..x.count as u32 {
                let h = x.hour + k;
                let hf = match cm::fold(&views, h) {
                    Ok(hf) => hf,
                    Err(e) => {
                        bad.push((t, what.clone(), h * cm::HOUR_BELLS, format!("hour {h} does not fold: {e:?}")));
                        break;
                    }
                };
                match cm::apply_fold(&mut md, &hf, cq.dominion_per_hour) {
                    Ok(log) => expected.push((x.m, x.n, h, log.to_bytes())),
                    Err(e) => {
                        bad.push((t, what.clone(), h * cm::HOUR_BELLS, format!("hour {h} does not apply: {e:?}")));
                        break;
                    }
                }
            }
            states.push((mk, md));
        }
        // The records of the transaction, in order.
        for i in 0..logged.len().max(expected.len()) {
            match (logged.get(i), expected.get(i)) {
                (Some(r), Some((m, n, h, pl))) => {
                    let (rm, rn, rh) = (
                        le(r.field("m", false)) as u32 as i32,
                        le(r.field("n", false)) as u32 as i32,
                        le(r.field("hour", false)) as u32,
                    );
                    if (rm, rn, rh) != (*m, *n, *h) {
                        bad.push((t, format!("march ({m}, {n})"), h * cm::HOUR_BELLS, format!(
                            "record {i} is the fold of ({rm}, {rn}) hour {rh}, the replay's is ({m}, {n}) hour {h}"
                        )));
                    } else if r.payload[..] != pl[..] {
                        let diff = r.payload.iter().zip(pl.iter()).position(|(a, b)| a != b).unwrap_or(44);
                        let field = match diff {
                            0..=27 => "weight",
                            28 => "controller",
                            29 => "contested",
                            30 => "credit",
                            31 => "lost",
                            _ => "captures",
                        };
                        bad.push((t, format!("march ({m}, {n})"), h * cm::HOUR_BELLS, format!(
                            "hour {h}: MARCH_FOLD's {field} differs from the fold's (logged {}, replay {})",
                            hex::encode(&r.payload),
                            hex::encode(pl)
                        )));
                    }
                }
                (Some(r), None) => bad.push((t, "march".into(), r.bell, format!("record {i}: a MARCH_FOLD the replayed folds do not leave"))),
                (None, Some((m, n, h, _))) => bad.push((t, format!("march ({m}, {n})"), h * cm::HOUR_BELLS, format!("hour {h}: the replayed fold leaves a MARCH_FOLD the chain did not log"))),
                (None, None) => {}
            }
        }
        for (mk, md) in states {
            match tx.post_data(&mk) {
                Some(after) if after.len() == MS::SIZE => {
                    if after[OWNED] != md[OWNED] {
                        let at = after[OWNED].iter().zip(md[OWNED].iter()).position(|(a, b)| a != b).map(|o| o + MS::M).unwrap_or(0);
                        let (m, n) = (le(&md[MS::M..MS::M + 4]) as u32 as i32, le(&md[MS::N..MS::N + 4]) as u32 as i32);
                        bad.push((t, format!("march ({m}, {n})"), 0, format!("the MarchState written differs from the replay (first at byte {at})")));
                    }
                }
                _ => bad.push((t, "march".into(), 0, "no MarchState post-state after the fold".into())),
            }
        }
    }
    for (t, what, bell, detail) in bad {
        cx.fail(V, MARCH_FOLD_MISMATCH, what, bell, Some(t), detail);
    }
}
