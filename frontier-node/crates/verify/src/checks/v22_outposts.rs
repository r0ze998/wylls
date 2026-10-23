//! V22 (partial; conquest contract §8.5 "Land and neutral legality"),
//! listed as `V22:outpost-filing`: every FileOutpost re-judged from the
//! states before its transaction with the kernel's `may_found_outpost`
//! (MC §3.8), as the program's `file_outpost` does: no ticket open, the
//! anchor a final first holding of the citizen at the named generation,
//! the free slot (`lowest_free_slot`), the Town prerequisite on the
//! anchor's tier after the owner touch at the filing, slot 3 only over a
//! final slot 2, each named site in an opened ring ≥ 2 of a Province that
//! exists, above the heartland, within `outpost_range` of the anchor, the
//! faction's share of the target's strength weight (the program's
//! `province_weights`: holdings and Free Cities, a finished tier-up in
//! force) below `outpost_share_bps`, the land gate over the Frontier's
//! folded counts, the outpost close, and the site's conquest record zero.
//! `OutpostIllegal` names the first rule broken.
//!
//! Not judged: the order-2/3 SettleTicket's own tests (the settler-cost
//! escrow and refund), the genesis Free Cities, the keeps' placement,
//! the site-state invariants S1–S6 after every instruction.

use frontier_abi::addr::split_host_id;
use frontier_abi::layout::player::{citizen as C, holding as H, holding_ref as HR};
use frontier_abi::layout::province::{province as PV, site as SM};
use frontier_abi::layout::world::frontier as FR;
use frontier_abi::v2::ix::FileOutpost;
use frontier_abi::v2::layout::player::citizen as C2;
use frontier_abi::v2::layout::province::{conquest as CR, province as P2, site as SM2};
use frontier_abi::v2::tags::Ix as V2Ix;
use permutation_rules::frontier::geometry::ProvinceCoord;
use permutation_rules::frontier::holding::{may_found_outpost, OutpostCheck};
use permutation_rules::frontier::laurel::strength_weight;

use super::Ctx;
use crate::codes::OUTPOST_ILLEGAL;
use crate::holding as hr;
use crate::world::le;

const V: &str = "V22";

/// The strength weight of `faction` in a v2 Province and the Province's
/// total at bell `b` (the program's `province_weights`): holdings and Free
/// Cities, a finished tier-up in force, order 1 as the kernel's order 0.
pub fn province_weights(pd: &[u8], faction: u8, b: u32) -> Result<(u64, u64), String> {
    let n = (*pd.get(PV::SITE_COUNT).ok_or("short Province")? as usize).min(PV::SITES_N);
    let (mut mine, mut total) = (0u64, 0u64);
    for s in 0..n {
        let o = PV::site(s);
        let m = pd.get(o..o + SM::SIZE).ok_or("short Province")?;
        let state = m[SM::STATE];
        let order0 = match state {
            SM::STATE_HOLDING => m[SM::ORDER].saturating_sub(1),
            SM2::STATE_FREE_CITY => 0,
            _ => continue,
        };
        let mut tier = m[SM::TIER];
        let next = m[SM2::TIER_NEXT];
        if state == SM::STATE_HOLDING
            && next != SM2::NO_TIER_NEXT
            && le(&m[SM2::TIER_NEXT_BELL..SM2::TIER_NEXT_BELL + 4]) as u32 <= b
        {
            tier = next;
        }
        let t = frontier_abi::conquest_model::tier_of(tier).map_err(|e| format!("tier: {e:?}"))?;
        let w = strength_weight(t, le(&m[SM::GARRISON..SM::GARRISON + 4]) as u32, order0);
        total = total.saturating_add(w);
        if state == SM::STATE_HOLDING && m[SM::FACTION] == faction {
            mine = mine.saturating_add(w);
        }
    }
    Ok((mine, total))
}

pub fn run(cx: &mut Ctx) {
    let w = cx.w;
    let f = cx.f;
    let Some(cq) = f.cq else { return };
    let tag = V2Ix::FileOutpost.tag();
    let filings: Vec<(usize, usize)> = w
        .txs
        .iter()
        .enumerate()
        .filter(|(_, tx)| tx.ok)
        .flat_map(|(t, tx)| {
            tx.ixs
                .iter()
                .enumerate()
                .filter(|(_, i)| i.tag() == Some(tag))
                .map(move |(i, _)| (t, i))
        })
        .collect();
    if filings.is_empty() {
        return;
    }
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
    if !w.has_post {
        cx.missing(
            V,
            "outposts",
            0,
            None,
            "no post-states: a FileOutpost cannot be re-judged",
        );
        return;
    }
    let mut bad: Vec<(usize, String, u32, String)> = vec![];
    let mut missing: Vec<(usize, String, u32, String)> = vec![];
    for (t, i) in filings {
        let tx = &w.txs[t];
        let ix = &tx.ixs[i];
        let bell = tx
            .recs
            .iter()
            .map(|&n| &w.recs[n])
            .find(|r| r.kind == frontier_abi::log::Kind::TICKET)
            .map(|r| r.pu32("ticket_bell"))
            .unwrap_or_else(|| frontier_abi::prologue::bell_at(f.genesis_ts, tx.time).unwrap_or(0));
        let what = |s: &str| format!("outpost filing {s}");
        let Ok(x) = FileOutpost::decode(&ix.data) else {
            bad.push((
                t,
                what("?"),
                bell,
                "the FileOutpost instruction does not decode".into(),
            ));
            continue;
        };
        let Some(ak) = split_host_id(x.anchor_site_key).filter(|a| a.seq == 0) else {
            bad.push((
                t,
                what("?"),
                bell,
                "the anchor is not a holding's site key".into(),
            ));
            continue;
        };
        let anchor = ProvinceCoord::new(ak.province.p, ak.province.q);
        let what = what(&format!(
            "from ({}, {}, {}) at bell {bell}",
            ak.province.p, ak.province.q, ak.site
        ));
        let (Some(citizen_k), Some(frontier_k)) = (ix.account("citizen"), ix.account("frontier"))
        else {
            bad.push((
                t,
                what,
                bell,
                "the instruction names no citizen or Frontier".into(),
            ));
            continue;
        };
        let (Some(cd), Some(fd)) = (
            w.state_before(&citizen_k, t),
            w.state_before(&frontier_k, t),
        ) else {
            missing.push((
                t,
                what,
                bell,
                "no state of the Citizen or the Frontier before the filing".into(),
            ));
            continue;
        };
        if cd.len() != C::SIZE || fd.len() < FR::OCCUPIED_SITES + 4 {
            bad.push((
                t,
                what,
                bell,
                "the Citizen or the Frontier before the filing is not that account".into(),
            ));
            continue;
        }
        if le(&cd[C::TICKET_BELL..C::TICKET_BELL + 4]) as u32 != C::NO_TICKET {
            bad.push((t, what, bell, "a ticket was already open".into()));
            continue;
        }
        let faction = cd[C::FACTION];
        let slots = cd[C2::SLOTS];
        let gen_of = |slot: u8| cd[C2::holding_of_slot(slot) + HR::GEN];
        let slot = C2::lowest_free_slot(slots, gen_of(2), gen_of(3));
        let ak_key = f.ctx.holding(ak.province.p, ak.province.q, ak.site);
        let Some(ah) = w.state_before(&ak_key, t) else {
            missing.push((
                t,
                what,
                bell,
                "no state of the anchor Holding before the filing".into(),
            ));
            continue;
        };
        if ah.len() != H::SIZE
            || ah[H::GEN] != ak.gen
            || ah[H::OWNER_CITIZEN..H::OWNER_CITIZEN + 32] != citizen_k[..]
        {
            bad.push((
                t,
                what,
                bell,
                "the anchor is not the citizen's holding at the named generation".into(),
            ));
            continue;
        }
        if ah[H::STATE] != H::STATE_FINAL || ah[H::ORDER] != 1 {
            bad.push((
                t,
                what,
                bell,
                "the anchor is not a final first holding".into(),
            ));
            continue;
        }
        let first_tier =
            match hr::read(ah).and_then(|mut h| hr::touch(&mut h, tx.time).map(|()| h.tier)) {
                Ok(x) => x,
                Err(e) => {
                    bad.push((t, what, bell, format!("the anchor's kernel state: {e}")));
                    continue;
                }
            };
        let tier_min = match hr::tier_of(cq.outpost_tier_min) {
            Ok(x) => x,
            Err(e) => {
                bad.push((t, what, bell, format!("outpost_tier_min: {e}")));
                continue;
            }
        };
        let slot2_final = slot == Some(3) && {
            let o = C2::holding_of_slot(2);
            let (p, q, s) = (
                le(&cd[o + HR::P..o + HR::P + 2]) as u16 as i16 as i32,
                le(&cd[o + HR::Q..o + HR::Q + 2]) as u16 as i16 as i32,
                cd[o + HR::SITE],
            );
            w.state_before(&f.ctx.holding(p, q, s), t).is_some_and(|d| {
                d.len() == H::SIZE && d[H::STATE] == H::STATE_FINAL && d[H::ORDER] == 2
            })
        };
        let rings_opened = le(&fd[FR::RINGS_OPENED..FR::RINGS_OPENED + 2]) as u32;
        let open_sites = le(&fd[FR::OPEN_SITES..FR::OPEN_SITES + 4]);
        let occupied = le(&fd[FR::OCCUPIED_SITES..FR::OCCUPIED_SITES + 4]);
        let base = OutpostCheck {
            slot,
            first_final: cd[C::FLAGS] & C::FLAG_FIRST_HOLDING_FINAL != 0,
            first_tier,
            tier_min,
            slot2_final,
            target_ring: cq.heartland_max_ring as u32 + 1,
            heartland_max_ring: cq.heartland_max_ring,
            range: 0,
            outpost_range: cq.outpost_range,
            faction_weight: 0,
            province_weight: 0,
            outpost_share_bps: cq.outpost_share_bps,
            free_sites: open_sites.saturating_sub(occupied),
            open_sites,
            now_bell: bell,
            end_bell: end,
            outpost_close_bells: cq.outpost_close_bells,
        };
        if let Err(e) = may_found_outpost(&base) {
            bad.push((
                t,
                what,
                bell,
                format!("the count or the prerequisite: {e:?}"),
            ));
            continue;
        }
        for s in x.sites.iter().take(x.n as usize) {
            let (p, q) = (s.p as i32, s.q as i32);
            let target = ProvinceCoord::new(p, q);
            let site_what = format!("{what} to ({p}, {q}, {})", s.site);
            if target.ring() < 2 || target.ring() >= rings_opened {
                bad.push((
                    t,
                    site_what,
                    bell,
                    format!(
                        "the target ring {} is reserved or not opened ({rings_opened} rings)",
                        target.ring()
                    ),
                ));
                continue;
            }
            let Some(pd) = w.state_before(&f.ctx.province(p, q), t) else {
                missing.push((
                    t,
                    site_what,
                    bell,
                    "no state of the target Province before the filing".into(),
                ));
                continue;
            };
            if pd.len() != P2::SIZE {
                bad.push((
                    t,
                    site_what,
                    bell,
                    "the target Province is not a conquest Province".into(),
                ));
                continue;
            }
            if s.site as usize >= (pd[PV::SITE_COUNT] as usize).min(PV::SITES_N) {
                bad.push((
                    t,
                    site_what,
                    bell,
                    "the site is not one of the Province's".into(),
                ));
                continue;
            }
            let (mine, total) = match province_weights(pd, faction, bell) {
                Ok(x) => x,
                Err(e) => {
                    bad.push((t, site_what, bell, e));
                    continue;
                }
            };
            if let Err(e) = may_found_outpost(&OutpostCheck {
                target_ring: target.ring(),
                range: anchor.distance(target),
                faction_weight: mine,
                province_weight: total,
                ..base
            }) {
                bad.push((
                    t,
                    site_what,
                    bell,
                    format!(
                        "{e:?} (range {}, share {mine} of {total})",
                        anchor.distance(target)
                    ),
                ));
                continue;
            }
            let o = P2::record(s.site as usize);
            if pd
                .get(o..o + CR::SIZE)
                .is_none_or(|r| r.iter().any(|&b| b != 0))
            {
                bad.push((
                    t,
                    site_what,
                    bell,
                    "the site's conquest record is not zero (a siege is busy)".into(),
                ));
            }
        }
    }
    for (t, what, bell, detail) in missing {
        cx.missing(V, what, bell, Some(t), detail);
    }
    for (t, what, bell, detail) in bad {
        cx.fail(V, OUTPOST_ILLEGAL, what, bell, Some(t), detail);
    }
}
