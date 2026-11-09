//! Opt-in independent replay of one kind-17 WideGarrison transition.
//! Receipt codecs and chain hashes define the wire format, not the arithmetic.
//! Garrison settle, cap, room, ordering and insertion are restated here; this
//! module never calls the program or GarrisonState::change. Holding economics
//! use the verifier's existing read/touch/write with exactly the wide economy
//! layout-version adapter. Full supplied post-state bytes must match.
//! A successful check proves neither authority, canonical addresses, chain
//! provenance nor full-season replay. This is not wired into crate::verify.

use crate::holding as hold;
use crate::wide_economy::{
    check_citizen_header, debit_bucket, finality_due, preflight_holding, read_season,
};
pub use crate::wide_economy::{Refusal, SeasonFacts, NOT_PROVEN};
use frontier_abi::bytes::{
    rd_arr, rd_i64, rd_u32, rd_u64, rd_u8, wr_arr, wr_i64, wr_u32, wr_u64, wr_u8,
};
use frontier_abi::layout::header as HDR;
use frontier_abi::layout::province::{province as PV, site as SM};
use frontier_abi::v2::layout::player::{citizen as C2, holding as H2};
use frontier_abi::world_index::economy::{self, Snapshots};
use frontier_abi::world_index::event::{
    self, GarrisonReceipt, WideEntity, WideKind, WideLink, WideRecord,
};
use frontier_abi::world_index::holding::{binding_of, SlotBinding, WideHolding};
use frontier_abi::world_index::land::WideProvince;
use frontier_abi::world_index::WideHostRef;

pub const FULL_SEASON_REPLAY_SUPPORTED: bool = false;
const CAP: i64 = 30_000_000;
const MILLI: i64 = 1_000;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Staged {
    pub holding_ref: WideHostRef,
    pub receipt: GarrisonReceipt,
    pub bell: u32,
    pub citizen: Vec<u8>,
    pub holding: Vec<u8>,
    pub province: Vec<u8>,
    pub bucket_left: u32,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Verified {
    pub holding_ref: WideHostRef,
    pub delta: i64,
    pub now_ts: i64,
    pub bell: u32,
    pub became_final: bool,
    pub holding_link: WideLink,
    pub province_link: WideLink,
    pub bucket_left: u32,
}
impl Verified {
    pub fn full_season(&self) -> bool {
        FULL_SEASON_REPLAY_SUPPORTED
    }
    pub fn not_proven(&self) -> &'static [&'static str] {
        NOT_PROVEN
    }
}
struct Decoded<'a> {
    record: WideRecord<'a>,
    holding_ref: WideHostRef,
    receipt: GarrisonReceipt,
}
fn decode(bytes: &[u8]) -> Result<Decoded<'_>, Refusal> {
    let record = WideRecord::decode(bytes).map_err(|e| Refusal::Record(format!("{e:?}")))?;
    if record.kind != WideKind::Garrison {
        return Err(Refusal::Record("expected kind 17 Garrison".into()));
    }
    let holding_ref = record
        .holding()
        .ok_or_else(|| Refusal::Record("holding reference".into()))?;
    let receipt = record
        .garrison_receipt()
        .ok_or_else(|| Refusal::Record("garrison receipt".into()))?;
    Ok(Decoded {
        record,
        holding_ref,
        receipt,
    })
}

// Independent transcription of deployed positive reinforcement, including
// stable pending ordering, per-step clamp, and normalization of empty slots.
fn reinforce(
    province: &mut [u8],
    site: usize,
    bell: u32,
    rn: u32,
    delta: i64,
) -> Result<(), Refusal> {
    let err = |s: &str| Refusal::Province(s.into());
    if rn as u64 + 1 < bell as u64 {
        return Err(err("resident lag"));
    }
    let o = PV::site(site);
    let offsets = [
        (SM::PEND0_BELL, SM::PEND0_DELTA),
        (SM::PEND1_BELL, SM::PEND1_DELTA),
    ];
    let mut pending = [None; 2];
    let mut troops =
        rd_u32(province, o + SM::GARRISON).ok_or_else(|| err("short garrison"))? as i64;
    for (i, (b, d)) in offsets.iter().enumerate() {
        let b = rd_u32(province, o + b).ok_or_else(|| err("short pending bell"))?;
        let d = rd_i64(province, o + d).ok_or_else(|| err("short pending delta"))?;
        if b != SM::NO_BELL && d != 0 {
            pending[i] = Some((b, d));
        }
    }
    pending.sort_by_key(|x| x.map_or(u32::MAX, |(b, _)| b));
    for slot in &mut pending {
        if let Some((b, d)) = *slot {
            if b < rn {
                troops = troops.saturating_add(d).clamp(0, CAP);
                *slot = None;
            }
        }
    }
    let projected = pending
        .iter()
        .flatten()
        .fold(troops, |n, (_, d)| n.saturating_add(*d));
    // Checked subtraction fails closed on a malformed extreme negative
    // projection, instead of allowing the program's unchecked subtraction.
    let room = CAP
        .checked_sub(projected)
        .ok_or_else(|| err("room subtraction overflow"))?
        .clamp(0, CAP);
    if delta <= 0 || delta > room {
        return Err(err("garrison cap or nonpositive delta"));
    }
    if let Some((_, d)) = pending.iter_mut().flatten().find(|(b, _)| *b == bell) {
        *d = d
            .checked_add(delta)
            .ok_or_else(|| err("pending merge overflow"))?;
    } else {
        *pending
            .iter_mut()
            .find(|p| p.is_none())
            .ok_or_else(|| err("pending slots full"))? = Some((bell, delta));
    }
    wr_u32(province, o + SM::GARRISON, troops as u32);
    for (i, (b, d)) in offsets.iter().enumerate() {
        let (pb, pd) = pending[i].unwrap_or((SM::NO_BELL, 0));
        wr_u32(province, o + b, pb);
        wr_i64(province, o + d, pd);
    }
    Ok(())
}

/// Stage only: does not validate digest commitments or chain tails. Use
/// verify_transition for a verdict. No output is applied to real accounts.
pub fn stage(record: &[u8], season: &[u8], before: &Snapshots<'_>) -> Result<Staged, Refusal> {
    let d = decode(record)?;
    let receipt = d.receipt;
    let now = receipt.now_ts;
    let sf = read_season(season, now)?;
    if d.record.bell != sf.now_bell {
        return Err(Refusal::Record("bell mismatch".into()));
    }
    // The snapshots: the ABI's own validation (shape, identity).
    economy::check_snapshots(&d.holding_ref, before)
        .map_err(|e| Refusal::Snapshot(format!("before: {e:?}")))?;
    let wh = WideHolding::read(before.holding).map_err(|e| Refusal::Snapshot(format!("{e:?}")))?;
    let wp =
        WideProvince::read(before.province).map_err(|e| Refusal::Snapshot(format!("{e:?}")))?;
    if wh.season_id != sf.season_id {
        return Err(Refusal::Holding(format!(
            "holding of season {} under Season {}",
            wh.season_id, sf.season_id
        )));
    }
    debug_assert_eq!(wp.season_id, wh.season_id);
    // The Citizen's short header, as the program's player prologue requires
    // of the Citizen account (`check_present`: the Citizen magic, the
    // Season's id; no layout version). A codec check of the bytes: not the
    // account's address, owner or holder (NOT_PROVEN).
    check_citizen_header(before.citizen, sf.season_id)?;
    // The Citizen: the slot the holding occupies carries the wide marker
    // (a generic binding, not a coordinate proof).
    match binding_of(before.citizen, wh.slot) {
        Ok(SlotBinding::Wide) => {}
        Ok(other) => {
            return Err(Refusal::Citizen(format!(
                "slot {} is {other:?}, not bound to a wide holding",
                wh.slot
            )))
        }
        Err(e) => return Err(Refusal::Citizen(format!("slot {}: {e:?}", wh.slot))),
    }
    // The holding prefix: order = slot, live.
    let short = || Refusal::Snapshot("holding short".into());
    let order = rd_u8(before.holding, H2::ORDER).ok_or_else(short)?;
    if order != wh.slot {
        return Err(Refusal::State(format!(
            "holding order {order} is not its slot {}",
            wh.slot
        )));
    }
    let state = rd_u8(before.holding, H2::STATE).ok_or_else(short)?;
    if state != H2::STATE_PROVISIONAL && state != H2::STATE_FINAL {
        return Err(Refusal::State(format!("holding state {state} is not live")));
    }
    // The site mirror shows this holding at this generation; a mirror one
    // generation ahead is a capture completed and not settled.
    let site = wh.site as usize;
    if site >= PV::SITES_N {
        return Err(Refusal::Snapshot(format!("site {site}")));
    }
    let so = PV::site(site);
    let pshort = || Refusal::Snapshot("province short".into());
    let mstate = rd_u8(before.province, so + SM::STATE).ok_or_else(pshort)?;
    let mgen = rd_u8(before.province, so + SM::GEN).ok_or_else(pshort)?;
    if mstate == SM::STATE_HOLDING && mgen == wh.gen.wrapping_add(1) {
        return Err(Refusal::State(format!(
            "capture pending: the site mirror shows generation {mgen} over the holding's {}",
            wh.gen
        )));
    }
    if mstate != SM::STATE_HOLDING || mgen != wh.gen {
        return Err(Refusal::Province(format!(
            "site mirror {site} is state {mstate} generation {mgen}, not this holding (state {} generation {})",
            SM::STATE_HOLDING,
            wh.gen
        )));
    }
    // The lazy flip, independently.
    let became_final = finality_due(before.holding, before.province, now, sf.now_bell);
    if became_final != receipt.became_final {
        return Err(Refusal::Finality(format!(
            "receipt says became_final {}, the rules give {became_final} (state {state}, final_ts {}, ticket bell {}, bell {})",
            receipt.became_final,
            rd_i64(before.holding, H2::FINAL_TS).unwrap_or(0),
            rd_u32(before.holding, H2::TICKET_BELL).unwrap_or(0),
            sf.now_bell
        )));
    }
    // The Citizen after: the bucket and the last action, nothing else.
    let mut citizen = before.citizen.to_vec();
    let bucket_left = debit_bucket(
        &mut citizen,
        now,
        sf.genesis_ts,
        sf.bucket_rate_per_h,
        sf.bucket_burst,
    )?;
    if !wr_i64(&mut citizen, C2::LAST_ACTION_TS, now) {
        return Err(Refusal::Citizen("short".into()));
    }
    if !became_final && state != H2::STATE_FINAL {
        return Err(Refusal::Finality("holding is not final".into()));
    }
    let rn = rd_u32(before.province, PV::RESOLVED_NEXT).ok_or_else(pshort)?;
    if rn as u64 + 1 < sf.now_bell as u64 {
        return Err(Refusal::Province("resident lag".into()));
    }
    let have = rd_u32(before.holding, H2::reserve(0)).ok_or_else(short)?;
    if receipt.delta <= 0 || receipt.delta > u32::MAX as i64 || receipt.delta > have as i64 {
        return Err(Refusal::Holding(
            "invalid delta or insufficient unit-0 reserve".into(),
        ));
    }
    let mut holding = before.holding.to_vec();
    if became_final {
        wr_u8(&mut holding, H2::STATE, H2::STATE_FINAL);
    }
    let version: [u8; 2] = rd_arr(&holding, HDR::LAYOUT_VERSION).ok_or_else(short)?;
    wr_arr(&mut holding, HDR::LAYOUT_VERSION, &2u16.to_le_bytes());
    let mut kernel = hold::read(&holding).map_err(Refusal::Holding)?;
    let ore = hold::terrain_ore(&holding).map_err(Refusal::Holding)?;
    preflight_holding(&kernel, ore, now)?;
    hold::touch(&mut kernel, now, ore).map_err(Refusal::Holding)?;
    hold::write(&mut holding, &kernel, now).map_err(Refusal::Holding)?;
    wr_arr(&mut holding, HDR::LAYOUT_VERSION, &version);
    wr_u32(&mut holding, H2::reserve(0), have - receipt.delta as u32);
    let mut province = before.province.to_vec();
    reinforce(
        &mut province,
        site,
        sf.now_bell,
        rn,
        receipt
            .delta
            .checked_mul(MILLI)
            .ok_or_else(|| Refusal::Holding("delta overflow".into()))?,
    )?;
    Ok(Staged {
        holding_ref: d.holding_ref,
        receipt,
        bell: sf.now_bell,
        citizen,
        holding,
        province,
        bucket_left,
    })
}

fn chain_of(d: &[u8]) -> Option<(u64, [u8; 32])> {
    Some((rd_u64(d, HDR::EVENT_SEQ)?, rd_arr(d, HDR::EVENT_HEAD)?))
}

fn set_chain(d: &mut [u8], link: &WideLink) -> bool {
    wr_u64(d, HDR::EVENT_SEQ, link.seq) && wr_arr(d, HDR::EVENT_HEAD, &link.head)
}

/// The link `entity` must carry: `event::advance` from the pre-state
/// header of `pre`, compared with the record's.
fn expected_link(r: &WideRecord<'_>, entity: WideEntity, pre: &[u8]) -> Result<WideLink, Refusal> {
    let (seq, head) = chain_of(pre)
        .ok_or_else(|| Refusal::Chain(format!("{entity:?}: pre-state header short")))?;
    let want = event::advance(entity, seq, &head, r.body_without_tail)
        .ok_or_else(|| Refusal::Chain(format!("{entity:?}: sequence overflow at {seq}")))?;
    let got = r
        .link(entity)
        .ok_or_else(|| Refusal::Chain(format!("{entity:?}: the record carries no link")))?;
    if got != want {
        return Err(Refusal::Chain(format!(
            "{entity:?}: link seq {} head {} does not continue the pre-state chain (seq {seq}: expected seq {} head {})",
            got.seq,
            hex::encode(got.head),
            want.seq,
            hex::encode(want.head)
        )));
    }
    Ok(want)
}

fn first_diff(a: &[u8], b: &[u8]) -> Option<usize> {
    if a.len() != b.len() {
        return Some(a.len().min(b.len()));
    }
    a.iter().zip(b).position(|(x, y)| x != y)
}

fn compare(what: &str, expected: &[u8], got: &[u8]) -> Result<(), String> {
    if expected.len() != got.len() {
        return Err(format!(
            "{what} after: {} bytes supplied, {} expected",
            got.len(),
            expected.len()
        ));
    }
    match first_diff(expected, got) {
        None => Ok(()),
        Some(o) => Err(format!(
            "{what} after differs from the independent replay at offset {o} (supplied {:#04x}, expected {:#04x})",
            got[o], expected[o]
        )),
    }
}

/// Verify input commitment first, then independent state and both chains,
/// complete post bytes, and the separate Garrison output commitment.
pub fn verify_transition(
    record: &[u8],
    season: &[u8],
    before: &Snapshots<'_>,
    after: &Snapshots<'_>,
) -> Result<Verified, Refusal> {
    let d = decode(record)?;
    let r = d.receipt;
    let input = event::garrison_input_digest(&d.holding_ref, r.delta, r.now_ts, season, before)
        .map_err(|e| Refusal::Snapshot(format!("{e:?}")))?;
    if input != r.input_digest {
        return Err(Refusal::Digest("garrison input commitment".into()));
    }
    let mut st = stage(record, season, before)?;
    let holding_link = expected_link(&d.record, WideEntity::Holding, before.holding)?;
    let province_link = expected_link(&d.record, WideEntity::Province, before.province)?;
    if !set_chain(&mut st.holding, &holding_link) || !set_chain(&mut st.province, &province_link) {
        return Err(Refusal::Chain("short snapshot".into()));
    }
    compare("citizen", &st.citizen, after.citizen).map_err(Refusal::Citizen)?;
    compare("holding", &st.holding, after.holding).map_err(Refusal::Holding)?;
    compare("province", &st.province, after.province).map_err(Refusal::Province)?;
    let output = event::garrison_output_digest(
        &d.holding_ref,
        r.delta,
        r.now_ts,
        r.became_final,
        &Snapshots {
            citizen: &st.citizen,
            holding: &st.holding,
            province: &st.province,
        },
    )
    .map_err(|e| Refusal::Digest(format!("{e:?}")))?;
    if output != r.output_digest {
        return Err(Refusal::Digest("garrison output commitment".into()));
    }
    Ok(Verified {
        holding_ref: d.holding_ref,
        delta: r.delta,
        now_ts: r.now_ts,
        bell: st.bell,
        became_final: r.became_final,
        holding_link,
        province_link,
        bucket_left: st.bucket_left,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn image(troops: u32, pending: [(u32, i64); 2]) -> Vec<u8> {
        let mut p = vec![0; frontier_abi::world_index::land::province::SIZE];
        let o = PV::site(0);
        wr_u32(&mut p, o + SM::GARRISON, troops);
        for ((b, d), (pb, pd)) in [
            (SM::PEND0_BELL, SM::PEND0_DELTA),
            (SM::PEND1_BELL, SM::PEND1_DELTA),
        ]
        .into_iter()
        .zip(pending)
        {
            wr_u32(&mut p, o + b, pb);
            wr_i64(&mut p, o + d, pd);
        }
        p
    }
    #[test]
    fn chronological_settle_clamps_each_step() {
        let mut p = image(100, [(9, 20), (8, -200)]);
        reinforce(&mut p, 0, 10, 10, 1000).unwrap();
        let o = PV::site(0);
        assert_eq!(rd_u32(&p, o + SM::GARRISON), Some(20));
        assert_eq!(rd_u32(&p, o + SM::PEND0_BELL), Some(10));
        assert_eq!(rd_i64(&p, o + SM::PEND0_DELTA), Some(1000));
        assert_eq!(rd_u32(&p, o + SM::PEND1_BELL), Some(SM::NO_BELL));
    }
    #[test]
    fn same_bell_merges_and_previous_unresolved_stays() {
        let mut p = image(100, [(10, 200), (9, 300)]);
        reinforce(&mut p, 0, 10, 9, 1000).unwrap();
        let o = PV::site(0);
        assert_eq!(rd_u32(&p, o + SM::PEND0_BELL), Some(9));
        assert_eq!(rd_i64(&p, o + SM::PEND1_DELTA), Some(1200));
    }
    #[test]
    fn cap_full_slots_lag_and_extreme_projection_fail_closed() {
        for (troops, pending, bell, rn) in [
            (CAP as u32, [(SM::NO_BELL, 0); 2], 10, 10),
            (0, [(9, 1), (11, 1)], 10, 9),
            (0, [(SM::NO_BELL, 0); 2], 10, 8),
            (0, [(10, i64::MIN), (SM::NO_BELL, 0)], 10, 9),
        ] {
            assert!(reinforce(&mut image(troops, pending), 0, bell, rn, 1000).is_err());
        }
    }
    #[test]
    fn exact_cap_and_empty_slot_normalization() {
        let mut p = image(CAP as u32 - 1000, [(7, 0), (SM::NO_BELL, 99)]);
        reinforce(&mut p, 0, 10, 10, 1000).unwrap();
        let o = PV::site(0);
        assert_eq!(rd_i64(&p, o + SM::PEND0_DELTA), Some(1000));
        assert_eq!(rd_i64(&p, o + SM::PEND1_DELTA), Some(0));
        assert!(reinforce(&mut p, 0, 10, 10, 1).is_err());
    }
}
