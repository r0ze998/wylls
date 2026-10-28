//! Resting S1 Provinces between their writes (map growth, stage 4:
//! `docs/frontier/map-growth/keeper-load-rules.ja.md` §3).
//!
//! A keeper in rest mode leaves a resting Province's `resolved_next`
//! behind and writes the bells later with one FastForward. Every bell of
//! that gap is still decided by the chain: the Province's own bytes say
//! how far it may rest (`rest_model::rest_limit`), the anchors say which
//! reveal windows have closed by the latest folded block time, and an
//! absent or clear ArrivalDay bit says nothing arrived. [`advance`] walks
//! each resting Province forward over exactly those bells with
//! `rest_model::project` (the bytes SkipQuiet would leave, host test
//! `project_equals_bell_by_bell`) and hands each projected bell to the
//! per-bell files as if it had resolved: the ring overviews (via
//! `State::pending`), the control file, standings and the day files (via
//! [`crate::conquest::rest_views`]). The official territory of a resting
//! Province is therefore the stored counter plus the proven tail (R1).
//!
//! Not checkpointed: after a restart each Province is projected again from
//! its stored `resolved_next`; bells whose files were already written are
//! dropped by their writers. A Province the transaction wrote is projected
//! again from its new bytes. Nothing here is written for a bell the chain
//! has not proven, and no Province envelope (`h/province/…`) is written
//! for a projected bell: those stay the chain's bytes.

use std::collections::BTreeMap;

use fclient::decode::ArrivalDay;
use frontier_abi::bytes::rd_u32;
use frontier_abi::clash_model::DAY_BELLS;
use frontier_abi::conquest_model::StepParams;
use frontier_abi::rest_model;
use frontier_abi::v2::layout::province::province as P;
use permutation_rules::frontier::beacon;

use crate::control::is_v2_province;
use crate::fold::Fold;

/// Bells one Province is projected at most per transaction.
const MAX_BELLS: u32 = 4_096;

/// One Province's projection.
#[derive(Clone, Debug)]
pub struct Proj {
    /// The Province's bytes after bell `through − 1` (empty when stopped
    /// before any projection).
    pub pd: Vec<u8>,
    /// Bells `resolved_next..through` are proven.
    pub through: u32,
    /// No further bell can be proven from these bytes (not resting, an
    /// arrival, the rest's own limit); cleared when the Province is written.
    pub stop: bool,
}

/// The projections (module note).
#[derive(Clone, Debug, Default)]
pub struct Rests {
    pub by: BTreeMap<(i16, i16), Proj>,
    /// The block time the projections were last advanced at.
    pub time: i64,
}

impl Rests {
    /// The first bell not yet known for `pq`: its `resolved_next` or the
    /// projection's end, whichever is later.
    pub fn next(&self, pq: (i16, i16), rn: u32) -> u32 {
        self.by.get(&pq).map_or(rn, |p| p.through.max(rn))
    }
}

/// One projected bell: the Province before and after it.
#[derive(Clone, Debug)]
pub struct Bell {
    pub pq: (i16, i16),
    pub bell: u32,
    pub before: Vec<u8>,
    pub after: Vec<u8>,
}

/// Advances every resting Province over the bells the chain proves
/// quiet (module note). `written`: the Provinces this transaction wrote.
pub fn advance(f: &mut Fold, written: &[(i16, i16)]) -> Vec<Bell> {
    let mut rests = std::mem::take(&mut f.rest);
    for pq in written {
        rests.by.remove(pq);
    }
    let now = f.st.last_time;
    let mut out = vec![];
    // Nothing new can be proven without a written Province or a later time.
    if (!written.is_empty() || rests.time != now) && crate::conquest::is_s1(f) {
        if let (Some(si), Some(season)) = (crate::conquest::season_info(f), f.season.clone()) {
            let mut closed: BTreeMap<(u32, u8), bool> = BTreeMap::new();
            let mut is_closed = |b: u32, r: u8| -> bool {
                *closed.entry((b, r)).or_insert_with(|| {
                    f.anchor_of(b, r)
                        .is_some_and(|(a, _, _)| now >= beacon::reveal_close(a, season.window(b)))
                })
            };
            for (pq, m) in &f.provinces {
                let Some(c) = f.account(&m.addr) else {
                    continue;
                };
                let p = rests
                    .by
                    .entry(*pq)
                    .or_insert_with(|| start(&c.data, &si.prm));
                let (pp, qq) = (pq.0 as i32, pq.1 as i32);
                let mut n = 0;
                while !p.stop && p.through < si.end_bell && n < MAX_BELLS {
                    let b = p.through;
                    if !is_closed(b, m.region) {
                        break;
                    }
                    let day = b / DAY_BELLS;
                    let j = (b % DAY_BELLS) as usize;
                    let arrived = f
                        .account(&f.ctx.arrival_day(pp, qq, day))
                        .and_then(|a| ArrivalDay::decode(&a.data).ok())
                        .is_some_and(|d| d.bits[j / 8] & (1 << (j % 8)) != 0);
                    if arrived {
                        p.stop = true;
                        break;
                    }
                    let before = p.pd.clone();
                    if rest_model::project(&mut p.pd, b + 1, &si.prm).is_err() {
                        p.pd = before;
                        p.stop = true;
                        break;
                    }
                    out.push(Bell {
                        pq: *pq,
                        bell: b,
                        before,
                        after: p.pd.clone(),
                    });
                    p.through = b + 1;
                    n += 1;
                }
            }
        }
    }
    rests.time = now;
    f.rest = rests;
    out
}

/// A Province's projection from its stored bytes.
fn start(d: &[u8], prm: &StepParams) -> Proj {
    let rn = rd_u32(d, P::RESOLVED_NEXT).unwrap_or(0);
    let rests = is_v2_province(d)
        && rest_model::resting(d).unwrap_or(false)
        && rest_model::rest_limit(d, u32::MAX, prm).is_ok_and(|t| t > rn);
    Proj {
        pd: if rests { d.to_vec() } else { vec![] },
        through: rn,
        stop: !rests,
    }
}
