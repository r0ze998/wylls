//! V14 (conquest contract §8.5 "Siege legality"), listed as
//! `V14:siege-declaration`: every SIEGE_DECLARED re-judged from the states
//! before its transaction, in the program's order (`proc/conquest.rs`
//! `declare_siege`, MC §3.4 steps 1–10): the season running; the source a
//! final, live holding of the citizen; the target site a holding or a Free
//! City whose Holding is at the mirror's generation (`CapturePending`);
//! the target Province resident; the declaring entry on the target's tile
//! — the citizen's own host, a roster entry, non-civilian, with troops —
//! and the hex's lead host; the site's record free, owing nothing, its
//! immunity not barring the attacker; the day's declarations below
//! `sieges_per_day`; a capture target reserving a free slot; the kernel's
//! `may_besiege_v3` with the season's timers and the source unshielded (a
//! Free City: only the Seat test); the siege completable before the end
//! (`required_bells` over the walls in force, the owner's vigil snapshot);
//! the stake in the source's gold. The record's payload must be what the
//! program writes from those facts (the required bells, the vigil, the
//! stake, the source key, the owner's and the declarer's tags, the lead).
//! `SiegeIllegal` names the first rule broken; a declaration at or after
//! `end_bell` is `SiegeAfterEndRule`.

use frontier_abi::addr::{day_of, host_id, split_host_id};
use frontier_abi::entry::{read_entry, unit_from_u8};
use frontier_abi::layout::player::{citizen as C, holding as H};
use frontier_abi::layout::province::{entry as E, province as PV, site as SM};
use frontier_abi::v2::entry::lead_host;
use frontier_abi::v2::ix::DeclareSiege;
use frontier_abi::v2::kernel::siege3;
use frontier_abi::v2::layout::player::citizen as C2;
use frontier_abi::v2::layout::province::{conquest as CR, province as P2, site as SM2};
use frontier_abi::v2::log::CqKind;
use frontier_abi::v2::tags::Ix as V2Ix;
use permutation_rules::fixed::MILLI;
use permutation_rules::frontier::geometry::ProvinceCoord;
use permutation_rules::frontier::holding::{Resource, MAX_WALLS};
use permutation_rules::frontier::siege::{
    can_complete_before, immunity_bars, may_besiege_v3, required_bells, HoldingKind, Relation,
    SiegeCheckV3, FRONTIER_PROTECTION_RANGE,
};

use super::Ctx;
use crate::codes::{SIEGE_AFTER_END_RULE, SIEGE_ILLEGAL};
use crate::holding as hr;
use crate::world::{le, CqRec};

const V: &str = "V14";

/// The walls the clash of bell `b` reads at site `s` (the program's
/// `mirror_walls_at`): committed walls plus the wall items in force.
fn walls_at(pd: &[u8], s: usize, b: u32) -> u32 {
    let o = PV::site(s);
    let rd = |f: usize| le(pd.get(o + f..o + f + 4).unwrap_or(&[])) as u32;
    let mut w = rd(SM::WALLS_COMMITTED);
    for (eb, dl) in [
        (SM::WALL_ITEM0_BELL, SM::WALL_ITEM0_DELTA),
        (SM::WALL_ITEM1_BELL, SM::WALL_ITEM1_DELTA),
    ] {
        let delta = rd(dl);
        if delta > 0 && rd(eb) <= b {
            w = w.saturating_add(delta);
        }
    }
    w.min(MAX_WALLS)
}

/// The owner's vigil as DeclareSiege snapshots it: `(start_min, next_min,
/// from_day)`.
fn vigil_snapshot(cd: &[u8]) -> (u16, u16, u16) {
    let from_ts = le(&cd[C::VIGIL_FROM_TS..C::VIGIL_FROM_TS + 8]) as i64;
    let from_day = if from_ts > 0 {
        u16::try_from(from_ts / 86_400).unwrap_or(u16::MAX)
    } else {
        0
    };
    (
        le(&cd[C::VIGIL_START_MIN..C::VIGIL_START_MIN + 2]) as u16,
        le(&cd[C::VIGIL_NEXT_MIN..C::VIGIL_NEXT_MIN + 2]) as u16,
        from_day,
    )
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Target {
    First,
    Other,
    FreeCity,
}

/// One declaration judged: `Ok(())`, or the rule broken.
fn judge(cx: &Ctx, r: &CqRec) -> Result<(), (&'static str, String)> {
    let w = cx.w;
    let f = cx.f;
    let cq =
        f.cq.as_ref()
            .ok_or((SIEGE_ILLEGAL, "no conquest block".to_string()))?;
    let end = f
        .params
        .as_ref()
        .map(|p| p.end_bell)
        .ok_or((SIEGE_ILLEGAL, "no end_bell".to_string()))?;
    let t = r.tx;
    let tx = &w.txs[t];
    let tag = V2Ix::DeclareSiege.tag();
    let ix = tx
        .ixs
        .iter()
        .find(|i| i.tag() == Some(tag) && i.accounts.len() >= 11)
        .ok_or((
            SIEGE_ILLEGAL,
            "no DeclareSiege instruction in the transaction".to_string(),
        ))?;
    let x = DeclareSiege::decode(&ix.data).map_err(|_| {
        (
            SIEGE_ILLEGAL,
            "the DeclareSiege instruction does not decode".to_string(),
        )
    })?;
    let (p, q, site) = (
        le(r.field("p", false)) as u32 as i32,
        le(r.field("q", false)) as u32 as i32,
        r.field("site", false).first().copied().unwrap_or(0),
    );
    if site != x.site {
        return Err((
            SIEGE_ILLEGAL,
            "the record's site is not the instruction's".into(),
        ));
    }
    let now = tx.time;
    let b = frontier_abi::prologue::bell_at(f.genesis_ts, now).unwrap_or(0);
    // 1. The season running, now_bell < end_bell.
    if b >= end {
        return Err((
            SIEGE_AFTER_END_RULE,
            format!("declared at bell {b}, at or after end_bell {end}"),
        ));
    }
    let before = |i: usize| {
        ix.key(i)
            .and_then(|k| w.state_before(&k, t).map(|d| (k, d.to_vec())))
    };
    let (citizen_k, cd) =
        before(3).ok_or((SIEGE_ILLEGAL, "no state of the Citizen before".to_string()))?;
    let (src_k, hd) = before(4).ok_or((
        SIEGE_ILLEGAL,
        "no state of the source Holding before".to_string(),
    ))?;
    let (province_k, pd) = before(5).ok_or((
        SIEGE_ILLEGAL,
        "no state of the target Province before".to_string(),
    ))?;
    if cd.len() != C::SIZE || hd.len() != H::SIZE || pd.len() != P2::SIZE {
        return Err((
            SIEGE_ILLEGAL,
            "the Citizen, the source Holding or the Province before is not that account".into(),
        ));
    }
    if province_k != f.ctx.province(p, q) {
        return Err((
            SIEGE_ILLEGAL,
            "the instruction's Province is not the record's".into(),
        ));
    }
    let attacker = cd[C::FACTION];
    let cslots = cd[C2::SLOTS];
    let gen_of =
        |slot: u8| cd[C2::holding_of_slot(slot) + frontier_abi::layout::player::holding_ref::GEN];
    let sieges_today = cd[C2::SIEGES_TODAY];
    let siege_day = le(&cd[C2::SIEGE_DAY..C2::SIEGE_DAY + 2]) as u16;
    let declarer_tag = le(&cd[C::CITIZEN_TAG..C::CITIZEN_TAG + 8]);
    // 2. The source: the citizen's, final, live.
    let src = (
        le(&hd[H::P..H::P + 2]) as u16 as i16,
        le(&hd[H::Q..H::Q + 2]) as u16 as i16,
        hd[H::SITE],
        hd[H::GEN],
    );
    if hd[H::OWNER_CITIZEN..H::OWNER_CITIZEN + 32] != citizen_k[..] {
        return Err((
            SIEGE_ILLEGAL,
            "the source Holding is not the citizen's".into(),
        ));
    }
    if src_k != f.ctx.holding(src.0 as i32, src.1 as i32, src.2) {
        return Err((
            SIEGE_ILLEGAL,
            "the source Holding account is not its own address".into(),
        ));
    }
    if hd[H::STATE] != H::STATE_FINAL {
        return Err((
            SIEGE_ILLEGAL,
            format!("the source Holding is not final (state {})", hd[H::STATE]),
        ));
    }
    // 3. The target site.
    let site_count = (pd[PV::SITE_COUNT] as usize).min(PV::SITES_N);
    if site as usize >= site_count {
        return Err((
            SIEGE_ILLEGAL,
            "the site is not one of the Province's".into(),
        ));
    }
    let tile = pd[PV::SITES + site as usize];
    let m = |fld: usize| pd[PV::site(site as usize) + fld];
    let (mstate, mfaction, morder, mgen) = (m(SM::STATE), m(SM::FACTION), m(SM::ORDER), m(SM::GEN));
    let target = match mstate {
        SM::STATE_HOLDING if morder == 1 => Target::First,
        SM::STATE_HOLDING => Target::Other,
        SM2::STATE_FREE_CITY => Target::FreeCity,
        _ => {
            return Err((
                SIEGE_ILLEGAL,
                format!("the site is not besiegeable (mirror state {mstate})"),
            ))
        }
    };
    if ix.key(6) != Some(f.ctx.holding(p, q, site)) {
        return Err((
            SIEGE_ILLEGAL,
            "the target Holding account is not the site's".into(),
        ));
    }
    // (owner tag, vigil, shield, founded, dormant)
    let owner = if target == Target::FreeCity {
        None
    } else {
        let (_, th) = before(6).ok_or((
            SIEGE_ILLEGAL,
            "no state of the target Holding before".to_string(),
        ))?;
        if th.len() != H::SIZE {
            return Err((
                SIEGE_ILLEGAL,
                "the target Holding before is not a Holding".into(),
            ));
        }
        if th[H::GEN] != mgen {
            return Err((
                SIEGE_ILLEGAL,
                "a capture of the target is pending (generations differ)".into(),
            ));
        }
        let owner_k = ix
            .key(7)
            .ok_or((SIEGE_ILLEGAL, "no owner Citizen named".to_string()))?;
        if th[H::OWNER_CITIZEN..H::OWNER_CITIZEN + 32] != owner_k[..] {
            return Err((
                SIEGE_ILLEGAL,
                "the owner Citizen named is not the target's owner".into(),
            ));
        }
        let (_, od) = before(7).ok_or((
            SIEGE_ILLEGAL,
            "no state of the owner Citizen before".to_string(),
        ))?;
        if od.len() != C::SIZE {
            return Err((
                SIEGE_ILLEGAL,
                "the owner Citizen before is not a Citizen".into(),
            ));
        }
        let last = le(&th[H::LAST_OWNER_ACTION..H::LAST_OWNER_ACTION + 8]) as i64;
        Some((
            le(&od[C::CITIZEN_TAG..C::CITIZEN_TAG + 8]),
            vigil_snapshot(&od),
            le(&th[H::SHIELD_UNTIL..H::SHIELD_UNTIL + 8]) as i64,
            le(&th[H::FOUNDED_TS..H::FOUNDED_TS + 8]) as i64,
            now >= last.saturating_add(cq.dormant_after_secs as i64),
        ))
    };
    // Resident: resolved through now_bell − 2.
    let rn = le(&pd[PV::RESOLVED_NEXT..PV::RESOLVED_NEXT + 4]) as u32;
    if !frontier_abi::prologue::resident_ok(rn, b) {
        return Err((
            SIEGE_ILLEGAL,
            format!("the target Province is not resident (resolved_next {rn}, bell {b})"),
        ));
    }
    // 4. On the hex: the declaring entry, the hex's lead host.
    let e = read_entry(&pd, x.entry as usize)
        .map_err(|_| (SIEGE_ILLEGAL, format!("entry {} does not read", x.entry)))?;
    let parts = split_host_id(e.id).ok_or((
        SIEGE_ILLEGAL,
        "the entry's host id is not a holding's".to_string(),
    ))?;
    let civilian = unit_from_u8(e.unit).is_none_or(|u| u.is_civilian());
    let on_hex = e.state == E::STATE_ROSTER
        && e.from_bell <= b
        && !e.busy()
        && !civilian
        && e.troops > 0
        && e.faction == attacker
        && e.tile == tile
        && (parts.province.p, parts.province.q, parts.site, parts.gen)
            == (src.0 as i32, src.1 as i32, src.2, src.3);
    if !on_hex {
        return Err((SIEGE_ILLEGAL, format!(
            "entry {} is not the citizen's own non-civilian roster host on the target's tile (state {}, from {}, tile {} vs {}, faction {} vs {}, troops {})",
            x.entry, e.state, e.from_bell, e.tile, tile, e.faction, attacker, e.troops
        )));
    }
    if lead_host(&pd, tile, attacker, b).map(|l| l.0) != Some(x.entry) {
        return Err((
            SIEGE_ILLEGAL,
            format!("entry {} is not the hex's lead host", x.entry),
        ));
    }
    // 5. The record: free and owing nothing; immunity for a holding.
    let ro = P2::record(site as usize);
    let rec = |fld: usize| pd[ro + fld];
    let (rkind, rfaction, rflags) = (rec(CR::KIND), rec(CR::FACTION), rec(CR::FLAGS));
    let rbell = le(&pd[ro + CR::BELL..ro + CR::BELL + 4]) as u32;
    if rkind != CR::KIND_NONE {
        return Err((
            SIEGE_ILLEGAL,
            format!("the site's record is busy (kind {rkind})"),
        ));
    }
    if rflags & CR::OWED_MASK != 0 {
        return Err((
            SIEGE_ILLEGAL,
            "the site's record owes a stake or a slot".into(),
        ));
    }
    if target != Target::FreeCity && immunity_bars(rfaction, rbell, attacker, b) {
        return Err((
            SIEGE_ILLEGAL,
            "the site's immunity bars the attacker".into(),
        ));
    }
    // 6. Today's declarations.
    let today = u16::try_from(day_of(b)).unwrap_or(u16::MAX);
    let used = if siege_day == today { sieges_today } else { 0 };
    if used >= cq.sieges_per_day {
        return Err((
            SIEGE_ILLEGAL,
            format!("the day's declarations ({used}) reached sieges_per_day"),
        ));
    }
    // 7. A capture target reserves the lowest free slot.
    let slot = match target {
        Target::First => 0,
        _ => C2::lowest_free_slot(cslots, gen_of(2), gen_of(3))
            .ok_or((SIEGE_ILLEGAL, "a capture with no free slot".to_string()))?,
    };
    // 8. may_besiege v3; the source unshielded unless dormant.
    let src_last = le(&hd[H::LAST_OWNER_ACTION..H::LAST_OWNER_ACTION + 8]) as i64;
    let src_shield = le(&hd[H::SHIELD_UNTIL..H::SHIELD_UNTIL + 8]) as i64;
    let src_shielded =
        now < src_shield && now < src_last.saturating_add(cq.dormant_after_secs as i64);
    let tp = ProvinceCoord::new(p, q);
    if let Some((_, _, shield, founded, dorm)) = owner {
        if src_shielded {
            return Err((SIEGE_ILLEGAL, "the source Holding is shielded".into()));
        }
        let attacker_nearby = before(8).is_some_and(|(nk, nd)| {
            nd.len() == P2::SIZE
                && f.provinces.get(&nk).is_some_and(|&(np, nq)| {
                    let ns = x.nearby_site as usize;
                    ProvinceCoord::new(np, nq).distance(tp) <= FRONTIER_PROTECTION_RANGE
                        && ns < (nd[PV::SITE_COUNT] as usize).min(PV::SITES_N)
                        && nd[PV::site(ns) + SM::STATE] == SM::STATE_HOLDING
                        && nd[PV::site(ns) + SM::FACTION] == attacker
                        && nd[PV::site(ns) + SM::ORDER] == 1
                })
        });
        let check = SiegeCheckV3 {
            province: tp,
            kind: match target {
                Target::First => HoldingKind::First,
                Target::Other => HoldingKind::Other,
                Target::FreeCity => HoldingKind::FreeCity,
            },
            owner_faction: mfaction,
            attacker_faction: attacker,
            relation: Relation::Rivalry,
            march_hostility: false,
            march_truce: false,
            founded_ts: founded,
            shield_until: shield,
            dormant: dorm,
            attacker_nearby,
            now,
            heartland_max_ring: cq.heartland_max_ring,
            frontier_protect_secs: cq.frontier_protect_secs as i64,
            frontier_protect_after_secs: cq.frontier_protect_after_secs as i64,
            genesis_ts: f.genesis_ts,
        };
        may_besiege_v3(&check).map_err(|e| (SIEGE_ILLEGAL, format!("may_besiege: {e:?}")))?;
    } else if tp.is_seat() || tp.is_concord() {
        return Err((
            SIEGE_ILLEGAL,
            "a Free City on the Seat or the Concord".into(),
        ));
    }
    // 9. Required bells and TooLate.
    let walls = walls_at(&pd, site as usize, b);
    let required = required_bells(walls, 0).min(u8::MAX as u32) as u8;
    let from = b + 1;
    let vig = owner.map(|o| o.1);
    let in_time = match vig {
        Some((s0, s1, fd)) => {
            let v = siege3::vigil_of_snapshot(s0, s1, fd);
            can_complete_before(required, Some(&v), from, end, f.genesis_ts)
        }
        None => end.saturating_sub(from) >= required as u32,
    };
    if !in_time {
        return Err((
            SIEGE_ILLEGAL,
            format!("too late: {required} bells needed from bell {from}, end_bell {end}"),
        ));
    }
    // 10. The stake from the source's gold (its stores settled at now).
    let stake = (cq.siege_stake_gold as i64).saturating_mul(MILLI);
    let gold = hr::read_touched(&hd, now)
        .map(|h| h.stores[Resource::Gold as usize].value)
        .map_err(|e| (SIEGE_ILLEGAL, format!("the source's kernel state: {e}")))?;
    if gold < stake {
        return Err((
            SIEGE_ILLEGAL,
            format!("the stake ({stake} milli gold) exceeds the source's gold ({gold})"),
        ));
    }
    // The record's payload is what the program writes from these facts.
    let pu8 = |n: &str| r.field(n, true).first().copied().unwrap_or(0);
    let pu = |n: &str| le(r.field(n, true));
    let code = match target {
        Target::First => CR::TARGET_FIRST,
        Target::Other => CR::TARGET_OTHER,
        Target::FreeCity => CR::TARGET_FREE_CITY,
    };
    let (vs, vn, vf) = vig.unwrap_or((0, 0, 0));
    let src_key = host_id(src.0 as i32, src.1 as i32, src.2, src.3, 0).unwrap_or(0);
    let want = [
        ("attacker", attacker as u64, pu8("attacker") as u64),
        (
            "owner_faction",
            mfaction as u64,
            pu8("owner_faction") as u64,
        ),
        (
            "target",
            CR::target(code, slot) as u64,
            pu8("target") as u64,
        ),
        ("declarer_tag", declarer_tag, pu("declarer_tag")),
        ("required", required as u64, pu8("required") as u64),
        ("vigil_start", vs as u64, pu("vigil_start")),
        ("vigil_next", vn as u64, pu("vigil_next")),
        ("vigil_from_day", vf as u64, pu("vigil_from_day")),
        ("stake", cq.siege_stake_gold as u64, pu("stake")),
        ("src_key", src_key, pu("src_key")),
        ("owner_tag", owner.map_or(0, |o| o.0), pu("owner_tag")),
        ("lead_host_id", e.id, pu("lead_host_id")),
    ];
    for (name, w_, g) in want {
        if w_ != g {
            return Err((
                SIEGE_ILLEGAL,
                format!("SIEGE_DECLARED logs {name} {g}, the rules give {w_}"),
            ));
        }
    }
    Ok(())
}

pub fn run(cx: &mut Ctx) {
    let w = cx.w;
    if !w.has_post {
        if w.cq_recs.iter().any(|r| r.kind == CqKind::SIEGE_DECLARED) {
            cx.missing(
                V,
                "sieges",
                0,
                None,
                "no post-states: a declaration cannot be re-judged",
            );
        }
        return;
    }
    let mut bad: Vec<(usize, String, u32, &'static str, String)> = vec![];
    for r in &w.cq_recs {
        if r.kind != CqKind::SIEGE_DECLARED {
            continue;
        }
        if let Err((code, detail)) = judge(cx, r) {
            let (p, q, s) = (
                le(r.field("p", false)) as u32 as i32,
                le(r.field("q", false)) as u32 as i32,
                r.field("site", false).first().copied().unwrap_or(0),
            );
            bad.push((r.tx, format!("siege ({p}, {q}, {s})"), r.bell, code, detail));
        }
    }
    for (t, what, bell, code, detail) in bad {
        cx.fail(V, code, what, bell, Some(t), detail);
    }
}
