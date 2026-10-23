//! V17 (partial; conquest contract §8.5 "Capture bookkeeping"), listed as
//! `V17:capture-settlement`: every CAPTURE_SETTLED against the states
//! before and after its transaction, as the program's `settle_capture`
//! writes them (MC §3.6): the site's record was a capture due whose actor
//! is the captor and whose reserved slot the captor holds; the Holding
//! after is the captor's at the mirror's generation, of the slot's order,
//! final, captured at the completion bell, unshielded, with the walls the
//! captor's doctrine leaves and (a captured holding) its stores zeroed
//! unless the capture was credited, its reserve and delegate cleared; the
//! captor's Citizen holds the slot (`holdings_n` + 1, the reservation
//! consumed, the escrow less the rent moved) and its JoinShard counts the
//! holding in; a captured holding's victim loses the slot (`holdings_n` −
//! 1, its JoinShard counting it out); the stake returns to a live source
//! of the siege's generation (capped); the record after bars every
//! faction until `completion + 1 + immunity_bells`; the payload names
//! all of it (`CaptureBookkeeping`, `CaptureRule`). **The capture lock**:
//! between the CONQUEST record whose event made the capture due and the
//! settlement, no player instruction may write the captured Holding
//! (`CaptureLockBroken`, T41).
//!
//! Not judged: the seal-bond refunds' lamports, the rent swap's lamports,
//! RetireHost's legality and the `prev_gen` transit path, a double capture.

use frontier_abi::addr::split_host_id;
use frontier_abi::layout::player::{citizen as C, holding as H, holding_ref as HR};
use frontier_abi::layout::province::{province as PV, site as SM};
use frontier_abi::tags::Ix;
use frontier_abi::v2::layout::player::{citizen as C2, holding as H2};
use frontier_abi::v2::layout::province::{conquest as CR, province as P2};
use frontier_abi::v2::layout::world::join_shard as JS2;
use frontier_abi::v2::log::{capture_outcome, event, ConquestPayload, CqKind};
use frontier_abi::v2::tags::Ix as V2Ix;
use permutation_rules::fixed::MILLI;
use permutation_rules::frontier::holding::{Resource, MAX_WALLS};

use super::Ctx;
use crate::codes::{CAPTURE_BOOKKEEPING, CAPTURE_LOCK_BROKEN, CAPTURE_RULE};
use crate::holding as hr;
use crate::world::{le, CqRec};

const V: &str = "V17";

fn u32_at(d: &[u8], o: usize) -> u32 {
    le(d.get(o..o + 4).unwrap_or(&[])) as u32
}
fn u64_at(d: &[u8], o: usize) -> u64 {
    le(d.get(o..o + 8).unwrap_or(&[]))
}
fn holding_ref(cd: &[u8], slot: u8) -> (i16, i16, u8, u8) {
    let o = C2::holding_of_slot(slot);
    (
        le(&cd[o + HR::P..o + HR::P + 2]) as u16 as i16,
        le(&cd[o + HR::Q..o + HR::Q + 2]) as u16 as i16,
        cd[o + HR::SITE],
        cd[o + HR::GEN],
    )
}

/// One settlement judged: every rule it breaks.
fn judge(cx: &Ctx, r: &CqRec) -> Vec<(&'static str, String)> {
    let rules = cx.rules();
    let w = cx.w;
    let f = cx.f;
    let mut bad = vec![];
    let Some(cq) = f.cq.as_ref() else { return bad };
    let t = r.tx;
    let tx = &w.txs[t];
    let (p, q, site) = (
        le(r.field("p", false)) as u32 as i32,
        le(r.field("q", false)) as u32 as i32,
        r.field("site", false).first().copied().unwrap_or(0),
    );
    let pu8 = |n: &str| r.field(n, true).first().copied().unwrap_or(0);
    let pu = |n: &str| le(r.field(n, true));
    let tag = V2Ix::SettleCapture.tag();
    let Some(ix) = tx
        .ixs
        .iter()
        .find(|i| i.tag() == Some(tag) && i.accounts.len() >= 11)
    else {
        bad.push((
            CAPTURE_RULE,
            "no SettleCapture instruction in the transaction".into(),
        ));
        return bad;
    };
    let key = |i: usize| ix.key(i);
    let before = |i: usize| {
        ix.key(i)
            .and_then(|k| w.state_before(&k, t).map(|d| d.to_vec()))
    };
    let after = |i: usize| ix.key(i).and_then(|k| tx.post_data(&k).map(|d| d.to_vec()));
    let hk = f.ctx.holding(p, q, site);
    if key(2) != Some(hk) || key(3) != Some(f.ctx.province(p, q)) {
        bad.push((
            CAPTURE_RULE,
            "the instruction's Holding or Province is not the record's".into(),
        ));
        return bad;
    }
    let (Some(pd), Some(pd_after)) = (before(3), after(3)) else {
        bad.push((
            CAPTURE_RULE,
            "no Province state before or after the settlement".into(),
        ));
        return bad;
    };
    if pd.len() != P2::SIZE || pd_after.len() != P2::SIZE {
        bad.push((
            CAPTURE_RULE,
            "the Province is not a conquest Province".into(),
        ));
        return bad;
    }
    // 1. The record before: a capture due, the captor its actor.
    let ro = P2::record(site as usize);
    let rec = |fld: usize| pd[ro + fld];
    if rec(CR::KIND) != CR::KIND_CAPTURE_DUE {
        bad.push((
            CAPTURE_RULE,
            format!(
                "the site's record was kind {}, not a capture due",
                rec(CR::KIND)
            ),
        ));
        return bad;
    }
    let slot = CR::target_slot(rec(CR::TARGET));
    let free_city = CR::target_kind(rec(CR::TARGET)) == CR::TARGET_FREE_CITY;
    let credited = rec(CR::FLAGS) & CR::FLAG_CREDITED != 0;
    let due_bell = u32_at(&pd, ro + CR::BELL);
    let actor = u64_at(&pd, ro + CR::ACTOR);
    let src = u64_at(&pd, ro + CR::SRC);
    if !(2..=3).contains(&slot) {
        bad.push((CAPTURE_RULE, format!("the record's slot is {slot}")));
    }
    let mo = PV::site(site as usize);
    let (mgen, mtier) = (pd[mo + SM::GEN], pd[mo + SM::TIER]);
    // 2. The captor.
    let (Some(captor_k), Some(cd)) = (key(4), before(4)) else {
        bad.push((CAPTURE_RULE, "no captor Citizen before".into()));
        return bad;
    };
    if cd.len() != C::SIZE {
        bad.push((CAPTURE_RULE, "the captor is not a Citizen".into()));
        return bad;
    }
    let captor_tag = u64_at(&cd, C::CITIZEN_TAG);
    let captor_faction = cd[C::FACTION];
    if captor_tag != actor {
        bad.push((CAPTURE_RULE, "the captor is not the record's actor".into()));
    }
    if cd[C2::SLOTS] & C2::reserved_bit(slot) == 0 {
        bad.push((
            CAPTURE_RULE,
            format!("the captor had not reserved slot {slot}"),
        ));
    }
    // 3. The Holding after (and before, for a captured holding).
    let Some(hd) = after(2) else {
        bad.push((
            CAPTURE_BOOKKEEPING,
            "no Holding after the settlement".into(),
        ));
        return bad;
    };
    if hd.len() != H::SIZE {
        bad.push((
            CAPTURE_BOOKKEEPING,
            "the Holding after is not a Holding".into(),
        ));
        return bad;
    }
    let hb = before(2).filter(|d| d.len() == H::SIZE);
    let mut victim_tag = 0u64;
    let mut walls_want = 0u32;
    if free_city {
        if hb.is_some() {
            bad.push((
                CAPTURE_RULE,
                "a Free City capture over an existing Holding".into(),
            ));
        }
        if hd[H::TIER] != mtier {
            bad.push((
                CAPTURE_BOOKKEEPING,
                format!(
                    "the captured city's tier {} is not the mirror's {mtier}",
                    hd[H::TIER]
                ),
            ));
        }
        if hd[H2::PREV_GEN] != mgen.wrapping_sub(1) {
            bad.push((
                CAPTURE_BOOKKEEPING,
                "prev_gen is not the generation before".into(),
            ));
        }
        // S1: the city's base ore is its site's terrain ore.
        if cx.s1 {
            let tile = pd[PV::SITES + site as usize];
            match hr::site_terrain_ore(&pd, tile) {
                Ok(ore) => {
                    if hr::terrain_ore(&hd).ok() != Some(ore) {
                        bad.push((
                            CAPTURE_BOOKKEEPING,
                            format!("the captured city's terrain ore is not its site's ({ore})"),
                        ));
                    }
                    if let Ok(h) = hr::read(&hd) {
                        if h.production != hr::base_production(h.tier, ore) {
                            bad.push((
                                CAPTURE_BOOKKEEPING,
                                "the captured city's production is not its tier's base".into(),
                            ));
                        }
                    }
                }
                Err(e) => bad.push((CAPTURE_BOOKKEEPING, format!("the site's terrain: {e}"))),
            }
        }
    } else {
        let Some(hb) = hb else {
            bad.push((CAPTURE_RULE, "no Holding before a holding's capture".into()));
            return bad;
        };
        let (hgen, horder) = (hb[H::GEN], hb[H::ORDER]);
        if hgen.wrapping_add(1) != mgen || !(2..=3).contains(&horder) {
            bad.push((
                CAPTURE_RULE,
                format!("the Holding before (gen {hgen}, order {horder}) is not the captured one"),
            ));
        }
        let (Some(victim_k), Some(vd), Some(vd_after)) = (key(6), before(6), after(6)) else {
            bad.push((CAPTURE_RULE, "no victim Citizen before or after".into()));
            return bad;
        };
        if hb[H::OWNER_CITIZEN..H::OWNER_CITIZEN + 32] != victim_k[..] {
            bad.push((
                CAPTURE_RULE,
                "the victim named is not the Holding's owner".into(),
            ));
        }
        if vd.len() == C::SIZE && vd_after.len() == C::SIZE {
            victim_tag = u64_at(&vd, C::CITIZEN_TAG);
            if holding_ref(&vd, horder) != (p as i16, q as i16, site, hgen) {
                bad.push((
                    CAPTURE_RULE,
                    "the victim's slot did not hold the captured Holding".into(),
                ));
            }
            if holding_ref(&vd_after, horder).3 != C2::EMPTY_GEN {
                bad.push((
                    CAPTURE_BOOKKEEPING,
                    "the victim's slot is not emptied".into(),
                ));
            }
            if vd_after[C::HOLDINGS_N] != vd[C::HOLDINGS_N].saturating_sub(1) {
                bad.push((
                    CAPTURE_BOOKKEEPING,
                    "the victim's holdings_n did not drop by one".into(),
                ));
            }
        }
        if let (Some(jb), Some(ja)) = (before(7), after(7)) {
            if u32_at(&ja, JS2::EXTRA_HOLDINGS)
                != u32_at(&jb, JS2::EXTRA_HOLDINGS).saturating_sub(1)
                || u32_at(&ja, JS2::CAPTURED_OUT) != u32_at(&jb, JS2::CAPTURED_OUT) + 1
            {
                bad.push((
                    CAPTURE_BOOKKEEPING,
                    "the victim's JoinShard does not count the holding out".into(),
                ));
            }
        }
        // The walls the captor's doctrine leaves; stores zeroed unless credited; the reserve and delegate cleared.
        match hr::read_settled(&hb, tx.time) {
            Ok(h) => {
                let keeps = rules
                    .doctrine(captor_faction)
                    .is_some_and(|d| d.keeps_walls_on_capture);
                let walls = h.walls.min(MAX_WALLS);
                walls_want = if keeps { walls } else { walls / 2 };
                if hd[H2::PREV_GEN] != hgen {
                    bad.push((
                        CAPTURE_BOOKKEEPING,
                        "prev_gen is not the victim's generation".into(),
                    ));
                }
                if u64_at(&hd, H2::PREV_OWNER_TAG) != victim_tag {
                    bad.push((
                        CAPTURE_BOOKKEEPING,
                        "prev_owner_tag is not the victim's".into(),
                    ));
                }
            }
            Err(e) => bad.push((CAPTURE_BOOKKEEPING, format!("the Holding before: {e}"))),
        }
        if !credited {
            match hr::read(&hd) {
                Ok(h) => {
                    if h.stores.iter().any(|s| s.value != 0 || s.frac != 0) {
                        bad.push((
                            CAPTURE_BOOKKEEPING,
                            "an uncredited capture kept the stores".into(),
                        ));
                    }
                }
                Err(e) => bad.push((CAPTURE_BOOKKEEPING, format!("the Holding after: {e}"))),
            }
        }
        if (0..H::RESERVE_N).any(|u| u32_at(&hd, H::reserve(u)) != 0) {
            bad.push((CAPTURE_BOOKKEEPING, "the reserve is not cleared".into()));
        }
        if hd[H::DELEGATE..H::DELEGATE + 32].iter().any(|&b| b != 0) {
            bad.push((CAPTURE_BOOKKEEPING, "the delegate is not cleared".into()));
        }
    }
    if hd[H::OWNER_CITIZEN..H::OWNER_CITIZEN + 32] != captor_k[..] {
        bad.push((
            CAPTURE_BOOKKEEPING,
            "the Holding after is not the captor's".into(),
        ));
    }
    let checks: [(&str, bool); 7] = [
        ("gen = the mirror's", hd[H::GEN] == mgen),
        ("order = the slot", hd[H::ORDER] == slot),
        ("state final", hd[H::STATE] == H::STATE_FINAL),
        ("faction = the captor's", hd[H::FACTION] == captor_faction),
        (
            "captured flag",
            hd[H2::CAPTURE_FLAGS] & H2::CAPTURE_FLAG_CAPTURED != 0,
        ),
        (
            "captured_bell = the completion bell",
            u32_at(&hd, H2::CAPTURED_BELL) == due_bell,
        ),
        ("shield 0", u64_at(&hd, H::SHIELD_UNTIL) == 0),
    ];
    for (what, ok) in checks {
        if !ok {
            bad.push((
                CAPTURE_BOOKKEEPING,
                format!("the Holding after: {what} does not hold"),
            ));
        }
    }
    if !free_city && u32_at(&hd, H::WALLS) != walls_want {
        bad.push((
            CAPTURE_BOOKKEEPING,
            format!(
                "walls after {} differ from the doctrine's {walls_want}",
                u32_at(&hd, H::WALLS)
            ),
        ));
    }
    // 4. The captor's Citizen and JoinShard after.
    let rent_moved = pu("rent_moved");
    if let Some(ca) = after(4).filter(|d| d.len() == C::SIZE) {
        if holding_ref(&ca, slot) != (p as i16, q as i16, site, mgen) {
            bad.push((
                CAPTURE_BOOKKEEPING,
                format!("the captor's slot {slot} does not hold the captured Holding"),
            ));
        }
        if ca[C::HOLDINGS_N] != cd[C::HOLDINGS_N].wrapping_add(1) {
            bad.push((
                CAPTURE_BOOKKEEPING,
                "the captor's holdings_n did not rise by one".into(),
            ));
        }
        if ca[C2::SLOTS] & C2::reserved_bit(slot) != 0 {
            bad.push((
                CAPTURE_BOOKKEEPING,
                "the captor's reservation is not consumed".into(),
            ));
        }
        if u64_at(&ca, C::TICKET_ESCROW) != u64_at(&cd, C::TICKET_ESCROW).saturating_sub(rent_moved)
        {
            bad.push((
                CAPTURE_BOOKKEEPING,
                "the captor's escrow is not less the rent moved".into(),
            ));
        }
    }
    if let (Some(jb), Some(ja)) = (before(5), after(5)) {
        if u32_at(&ja, JS2::EXTRA_HOLDINGS) != u32_at(&jb, JS2::EXTRA_HOLDINGS) + 1
            || u32_at(&ja, JS2::CAPTURED_IN) != u32_at(&jb, JS2::CAPTURED_IN) + 1
        {
            bad.push((
                CAPTURE_BOOKKEEPING,
                "the captor's JoinShard does not count the holding in".into(),
            ));
        }
    }
    // 5. The stake back to a live source of the siege's generation (capped).
    if let Some(sp) = split_host_id(src) {
        let sk = f.ctx.holding(sp.province.p, sp.province.q, sp.site);
        if key(9) != Some(sk) {
            bad.push((
                CAPTURE_RULE,
                "the stake Holding named is not the siege's source".into(),
            ));
        } else if sk != hk {
            if let Some(sb) = w.state_before(&sk, t).filter(|d| d.len() == H::SIZE) {
                let live = sb[H::GEN] == sp.gen
                    && matches!(sb[H::STATE], H::STATE_PROVISIONAL | H::STATE_FINAL);
                if live {
                    if let (Ok(h), Some(sa)) = (hr::read_settled(sb, tx.time), tx.post_data(&sk)) {
                        {
                            let g = Resource::Gold as usize;
                            let want = h.stores[g]
                                .value
                                .saturating_add((cq.siege_stake_gold as i64).saturating_mul(MILLI))
                                .min(h.stores[g].cap);
                            let got = hr::read(sa).map(|x| x.stores[g].value).unwrap_or(i64::MIN);
                            if got != want {
                                bad.push((CAPTURE_BOOKKEEPING, format!("the source's gold after {got} is not the stake returned ({want})")));
                            }
                        }
                    }
                }
            }
        }
    }
    // 6. The record after: immunity against every faction from the completion.
    let ra = |fld: usize| pd_after[ro + fld];
    let want_bell = due_bell
        .saturating_add(1)
        .saturating_add(cq.immunity_bells as u32);
    if ra(CR::KIND) != CR::KIND_NONE
        || ra(CR::FACTION) != CR::BARRED_ALL
        || u32_at(&pd_after, ro + CR::BELL) != want_bell
        || ra(CR::FLAGS) != 0
    {
        bad.push((CAPTURE_BOOKKEEPING, format!(
            "the record after is (kind {}, faction {}, flags {}, bell {}), not the post-capture immunity (0, 254, 0, {want_bell})",
            ra(CR::KIND), ra(CR::FACTION), ra(CR::FLAGS), u32_at(&pd_after, ro + CR::BELL)
        )));
    }
    // 7. The payload.
    let outcome = if free_city {
        capture_outcome::FREE_CITY
    } else {
        capture_outcome::CAPTURE
    };
    let want: [(&str, u64, u64); 6] = [
        ("outcome", outcome as u64, pu8("outcome") as u64),
        ("credited", credited as u64, pu8("credited") as u64),
        ("captor_tag", captor_tag, pu("captor_tag")),
        ("victim_tag", victim_tag, pu("victim_tag")),
        ("new_gen", mgen as u64, pu8("new_gen") as u64),
        ("slot", slot as u64, pu8("slot") as u64),
    ];
    for (name, w_, g) in want {
        if w_ != g {
            bad.push((
                CAPTURE_BOOKKEEPING,
                format!("CAPTURE_SETTLED logs {name} {g}, the rules give {w_}"),
            ));
        }
    }
    if u32_at(&hd, H::WALLS) as u64 != pu("walls_after") {
        bad.push((
            CAPTURE_BOOKKEEPING,
            format!(
                "CAPTURE_SETTLED logs walls_after {}, the Holding has {}",
                pu("walls_after"),
                u32_at(&hd, H::WALLS)
            ),
        ));
    }
    // 8. The capture lock: no player instruction wrote the Holding between the due and the settlement.
    let due_tx = w.cq_recs.iter().find(|c| {
        c.kind == CqKind::CONQUEST
            && le(c.field("p", false)) as u32 as i32 == p
            && le(c.field("q", false)) as u32 as i32 == q
            && le(c.field("bell", false)) as u32 == due_bell
            && ConquestPayload::from_bytes(&c.payload).is_some_and(|pl| {
                pl.events
                    .iter()
                    .take(pl.n as usize)
                    .any(|e| e.site == site && e.code & !event::DETAIL == event::CAPTURE_DUE)
            })
    });
    if let Some(due) = due_tx {
        let player_tags = [
            Ix::Harvest.tag(),
            Ix::Build.tag(),
            Ix::Train.tag(),
            Ix::Explore.tag(),
            Ix::Muster.tag(),
            Ix::Dissolve.tag(),
            Ix::Garrison.tag(),
            Ix::Depart.tag(),
            V2Ix::FileOutpost.tag(),
            V2Ix::DeclareSiege.tag(),
        ];
        for (u, ux) in w
            .txs
            .iter()
            .enumerate()
            .skip(due.tx)
            .take(t.saturating_sub(due.tx))
        {
            if !ux.ok {
                continue;
            }
            if ux
                .ixs
                .iter()
                .any(|i| i.tag().is_some_and(|x| player_tags.contains(&x)) && i.writes(&hk))
            {
                bad.push((CAPTURE_LOCK_BROKEN, format!("transaction {u} wrote the captured Holding between the capture due (bell {due_bell}) and its settlement")));
            }
        }
    }
    bad
}

pub fn run(cx: &mut Ctx) {
    let w = cx.w;
    if !w.has_post {
        if w.cq_recs.iter().any(|r| r.kind == CqKind::CAPTURE_SETTLED) {
            cx.missing(
                V,
                "captures",
                0,
                None,
                "no post-states: a capture's settlement cannot be judged",
            );
        }
        return;
    }
    let mut out: Vec<(usize, String, u32, &'static str, String)> = vec![];
    for r in &w.cq_recs {
        if r.kind != CqKind::CAPTURE_SETTLED {
            continue;
        }
        let (p, q, s) = (
            le(r.field("p", false)) as u32 as i32,
            le(r.field("q", false)) as u32 as i32,
            r.field("site", false).first().copied().unwrap_or(0),
        );
        for (code, detail) in judge(cx, r) {
            out.push((
                r.tx,
                format!("holding ({p}, {q}, {s})"),
                r.bell,
                code,
                detail,
            ));
        }
    }
    for (t, what, bell, code, detail) in out {
        cx.fail(V, code, what, bell, Some(t), detail);
    }
}
