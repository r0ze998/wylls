//! V11 — land (contract §5.9, §8.5; I-30, I-47, I-56, W3-A notes §4).
//!
//! - **Scores:** every SETTLE (fresh, displace, taken) recomputes `score =
//!   rng(S(ticket_bell, r_site), "site", P‖Q‖site‖citizen_tag)` with S the
//!   seed THE anchor's cache (or archive) gives; `final_ts = round_time(S) +
//!   600`.
//! - **Displacement** only inside the cohort (same `ticket_bell`) of the
//!   site's current holder, by a better ticket (`beats`), naming the holder;
//!   a `taken` of the holder's own cohort must not beat it; a fresh
//!   settlement needs a free site; `expired` only from `ticket_bell + 24`.
//! - **Cohort counters:** every Province post-state's cohort records equal
//!   the tallies of TICKET (filed, per distinct province) and of the
//!   SETTLEs that end a ticket (settled, in every province of the ticket).
//! - **Terrain:** PROVINCE_OPEN's digest = `sha256("PSF-TERRAIN-v1" ‖
//!   terrain block)` of `terrain::generate_province(ring_seed, P)` in the
//!   program's pinned encoding, with its ring, wedge, region and site count.
//! - **Camps:** the initial camp = `camp::place(ring seed, …, initial)`
//!   (a conquest season: `place_v2`, never on the keep tile; its day
//!   checks `camp_check_v2` likewise);
//!   every CAMP spawn = the program's day check (`camp_seed` from the
//!   Province's terrain block, v1.6 §22), a clear (`troops = 0`) a present
//!   camp gone.
//! - **Tickets (map growth):** every TICKET of a FileTicket is re-judged
//!   from the Citizen and the Frontier before its transaction as the
//!   program's `file_ticket` judges its sites ([`judge_ticket`]): no first
//!   holding and no open ticket, each site in an opened ring ≥ 2 within
//!   the effective `r_max`, no duplicate, and the season's placement rule
//!   ([`ticket_site_rule`]): inside a dispersed heartland (`placement` 1,
//!   rings `2..=heartland_max_ring`) the province's nation
//!   (`geometry::home_nation`, as PlaceHome), everywhere else the legacy
//!   wedge rule with its adjacent-wedge overflow unchanged; the record is
//!   the filing's and the Citizen after it carries the ticket. Missing
//!   evidence (no post-states, a conquest season without its block, a
//!   dispersed season without its GENESIS_SEED) is `MissingData`, never a
//!   wedge guess. **Attribution** ([`route_ticket`]): the archive holds
//!   states per transaction, so a TICKET is judged only when exactly one
//!   FileTicket of the transaction names the record's Citizen and no other
//!   instruction of the program in it may write that Citizen or the
//!   Frontier (`Ix::writes`); a record whose citizen's only filing is a
//!   FileOutpost is V22's (it logs TICKET too); two filings of one citizen,
//!   a FileTicket beside a FileOutpost of the same citizen, another writer
//!   of the Citizen or the Frontier in the transaction, or no top-level
//!   instruction at all (an inner call) are `MissingData`, never a silent
//!   skip; a TICKET no filing of its citizen accounts for is a FAIL. The
//!   season-side evidence (placement, heartland ring, `r_max`, the genesis
//!   seed) is CreateSeason's data and the GENESIS_SEED record, fields no
//!   later instruction rewrites, not a Season pre-state of the
//!   transaction, so a Season writer bundled with the filing does not
//!   disturb it.
//!
//! Codes: `TicketScoreMismatch`, `DisplacementRule`, `CohortMismatch`,
//! `TerrainMismatch`, `CampMismatch`, `HomePlacementMismatch`,
//! `TicketPlacementMismatch`.

use std::collections::{BTreeMap, BTreeSet};

use frontier_abi::ix as aix;
use frontier_abi::layout::province::province as PV;
use frontier_abi::log::{settle_outcome, Kind, NO_BELL};
use permutation_rules::fixed::BPS_ONE;
use permutation_rules::frontier::camp;
use permutation_rules::frontier::geometry::{region_of, ProvinceCoord, PROVINCE_TILES};
use permutation_rules::frontier::terrain::{generate_province, ProvinceTerrain};
use permutation_rules::hash::sha256;

use super::Ctx;
use crate::codes::*;
use crate::world::{le, Ix, Key};

const V: &str = "V11";
/// Bells a ticket cohort stays open (I-47).
pub const COHORT_BELLS: u32 = 24;
pub const TERRAIN_DOMAIN: &[u8] = b"PSF-TERRAIN-v1";
/// The Concord's stored wedge.
pub const NO_WEDGE: u8 = 6;

/// The program's pinned Province encoding of a terrain (W3-A notes §4,
/// `proc/map.rs::encode_terrain`) written into a Province-sized buffer.
pub fn encode_terrain(t: &ProvinceTerrain, d: &mut [u8]) {
    let mut passable = 0u64;
    let mut rough = 0u64;
    for i in 0..PROVINCE_TILES {
        let tr = t.terrain[i];
        d[PV::TERRAIN + i] = tr as u8;
        d[PV::RESOURCE + i] = match t.resource[i] {
            None => 0,
            Some(r) => 1 + r as u8,
        };
        if tr.is_passable() {
            passable |= 1 << i;
        }
        if tr.info().defense_bps < BPS_ONE {
            rough |= 1 << i;
        }
    }
    d[PV::SITES..PV::SITES + 12].copy_from_slice(&t.sites);
    d[PV::SITE_COUNT] = t.site_count;
    d[PV::PASSABLE_MASK..PV::PASSABLE_MASK + 8].copy_from_slice(&passable.to_le_bytes());
    d[PV::ROUGH_MASK..PV::ROUGH_MASK + 8].copy_from_slice(&rough.to_le_bytes());
    d[PV::ROAD_MASK..PV::ROAD_MASK + 8].copy_from_slice(&0u64.to_le_bytes());
    d[PV::EXPLORED_MASK..PV::EXPLORED_MASK + 8].copy_from_slice(&0u64.to_le_bytes());
}

/// PROVINCE_OPEN's terrain digest of a generated terrain.
pub fn terrain_digest(t: &ProvinceTerrain) -> [u8; 32] {
    let mut d = vec![0u8; PV::SIZE];
    encode_terrain(t, &mut d);
    sha256(&[TERRAIN_DOMAIN, &d[PV::TERRAIN..PV::SITE_MIRROR]])
}

/// The ticket of a citizen: `(TICKET record, distinct provinces, n sites)`.
struct Ticket {
    bell: u32,
    provinces: Vec<(i32, i32)>,
    n: u8,
}

fn ticket_of(r: &crate::world::Rec) -> Ticket {
    let n = r.pu8("n");
    let sites = r.p("sites");
    let mut provinces = vec![];
    for i in 0..(n as usize).min(3) {
        let p = le(&sites[5 * i..5 * i + 2]) as u16 as i16 as i32;
        let q = le(&sites[5 * i + 2..5 * i + 4]) as u16 as i16 as i32;
        if !provinces.contains(&(p, q)) {
            provinces.push((p, q));
        }
    }
    Ticket {
        bell: r.pu32("ticket_bell"),
        provinces,
        n,
    }
}

pub fn run(cx: &mut Ctx) {
    let w = cx.w;
    let f = cx.f;
    // Terrain and initial camps.
    let mut terrains: BTreeMap<(i32, i32), ProvinceTerrain> = BTreeMap::new();
    for r in w.of(Kind::PROVINCE_OPEN) {
        let (p, q) = r.pq();
        let c = ProvinceCoord::new(p, q);
        let what = format!("province ({p}, {q})");
        let ring = c.ring() as u16;
        let Some(seed) = f.ring_seeds.get(&ring) else {
            cx.missing(
                V,
                what,
                r.bell,
                Some(r.tx),
                format!("no seed of ring {ring}"),
            );
            continue;
        };
        let t = generate_province(seed, c);
        if r.p32("terrain_digest") != terrain_digest(&t)
            || r.pu8("site_count") != t.site_count
            || r.pu16("ring") != ring
            || r.pu8("wedge") != c.wedge().unwrap_or(NO_WEDGE)
            || r.pu8("region") != region_of(c)
        {
            cx.fail(
                V,
                TERRAIN_MISMATCH,
                what.clone(),
                r.bell,
                Some(r.tx),
                "PROVINCE_OPEN is not generate_province(ring_seed, P) in the pinned encoding",
            );
        }
        let day = if r.bell == NO_BELL { 0 } else { r.bell / 144 };
        // A conquest season never places a camp on the keep tile (MC §3.2,
        // `camp::place_v2` with the symmetric keep tile of rings ≥ 2).
        let cmp = if cx.f.cq.is_some() {
            use frontier_abi::v2::kernel::keep as kkeep;
            let keep_tile = match c.wedge() {
                Some(wd) if c.ring() >= 2 => kkeep::keep_tile(&t, &t.sites, t.site_count, wd)
                    .filter(|&x| (x as usize) < PROVINCE_TILES),
                _ => None,
            };
            camp::place_v2(seed, c, &t, day, false, true, keep_tile)
        } else {
            camp::place(seed, c, &t, day, false, true)
        };
        let want = cmp.map_or((0xFF, 0), |x| (x.tile, x.troops));
        if (r.pu8("camp_tile"), r.pu32("camp_troops")) != want {
            cx.fail(
                V,
                CAMP_MISMATCH,
                what,
                r.bell,
                Some(r.tx),
                format!(
                    "initial camp {:?}, camp::place gives {want:?}",
                    (r.pu8("camp_tile"), r.pu32("camp_troops"))
                ),
            );
        }
        terrains.insert((p, q), t);
    }
    // CAMP records (v1.6 §22, W4-A D3): a spawn of the day's check at the
    // first resolve or skip of a day, drawn from `sha256("PSF-CAMP-v1" ‖
    // province[TERRAIN ..= SITE_COUNT])` with `has_holding` of the Province
    // then (the program's `camp_check`, `fclient::clash_model::camp_at`);
    // or a clear (`troops = 0`: the camp present at the clash, gone
    // after). The camp present at the clash is the Province's before the
    // transaction, or the one this transaction's day check spawned:
    // ResolveFromInputs logs CAMP (spawn), CAMP (clear), CLASH in one
    // transaction (`emit_camps`; W6T-3, the w6-s7 triage: V11 judged such a
    // clear against the pre-transaction camp, state 0).
    // Integ-W4 review: V11 read every CAMP as a ring-seed spawn.
    for (n, r) in w
        .recs
        .iter()
        .enumerate()
        .filter(|(_, r)| r.kind == Kind::CAMP)
    {
        let (p, q) = r.pq();
        let what = format!("camp ({p}, {q})");
        let pk = f.ctx.province(p, q);
        let Some(before) = w.state_before(&pk, r.tx) else {
            cx.missing(
                V,
                what,
                r.bell,
                Some(r.tx),
                "no Province state before the camp's record",
            );
            continue;
        };
        let got = (r.pu8("tile"), r.pu32("troops"));
        let camp_state = |d: &[u8]| {
            fclient::decode::Province::decode(d)
                .ok()
                .map(|pv| pv.camp.state)
        };
        if got.1 == 0 {
            // A spawn counts only if it is an earlier CAMP record of the
            // same (P, Q) in this transaction and its day is the day of the
            // bell this transaction's CLASH resolved (the day check runs at
            // the first resolve of a day).
            let recs = &w.txs[r.tx].recs;
            let clash_day = recs
                .iter()
                .map(|&m| &w.recs[m])
                .find(|x| x.kind == Kind::CLASH && x.pq() == (p, q))
                .map(|x| x.ku32("bell") / 144);
            let spawned_here = recs.iter().any(|&m| {
                let x = &w.recs[m];
                m < n
                    && x.kind == Kind::CAMP
                    && x.pq() == (p, q)
                    && x.pu32("troops") > 0
                    && Some(x.pu32("day")) == clash_day
            });
            let at_clash = if spawned_here {
                Some(1)
            } else {
                camp_state(before)
            };
            let after = w.txs[r.tx].post_data(&pk).and_then(camp_state);
            if at_clash != Some(1) || after != Some(0) {
                cx.fail(
                    V,
                    CAMP_MISMATCH,
                    what,
                    r.bell,
                    Some(r.tx),
                    format!("a clear (troops 0) of a camp in state {at_clash:?} → {after:?}"),
                );
            }
            continue;
        }
        let want = fclient::decode::Province::decode(before)
            .map_err(|e| format!("{e:?}"))
            .and_then(|pv| {
                let t = fclient::clash_model::terrain_of(&pv)?;
                let b = r.pu32("day") * 144;
                if f.cq.is_some() {
                    // A conquest Province's day check never spawns on the
                    // keep tile (`camp_check_v2`, MC §3.2), as the skip and
                    // clash replays run it.
                    let keep_tile = frontier_abi::conquest_model::read_keep(before)
                        .map_err(|e| format!("{e:?}"))?
                        .map(|k| k.tile);
                    frontier_abi::clash_model::camp_check_v2(before, &t, b, keep_tile)
                        .map_err(|e| format!("{e:?}"))
                        .map(|x| x.and_then(|(c, spawned)| spawned.then_some((c.tile, c.troops))))
                } else {
                    fclient::clash_model::camp_at(&pv, before, &t, b)
                        .map(|c| c.spawned.then_some((c.tile, c.troops)))
                }
            });
        let want = match want {
            Ok(x) => x,
            Err(e) => {
                cx.missing(V, what, r.bell, Some(r.tx), e);
                continue;
            }
        };
        if want != Some(got) {
            cx.fail(
                V,
                CAMP_MISMATCH,
                what,
                r.bell,
                Some(r.tx),
                format!(
                    "camp {got:?} on day {}, camp::place gives {want:?}",
                    r.pu32("day")
                ),
            );
        }
    }
    if !w.has_post && w.of(Kind::TICKET).next().is_some() {
        cx.missing(
            V,
            "cohorts",
            0,
            None,
            "no post-states: the Provinces' cohort counters cannot be compared",
        );
    }
    // Tickets and settlements, in order; cohort tallies per (P, Q, bell).
    let mut tickets: BTreeMap<[u8; 32], Ticket> = BTreeMap::new();
    let mut tally: BTreeMap<(i32, i32, u32), (u32, u32)> = BTreeMap::new();
    let mut checked_tx: BTreeSet<usize> = BTreeSet::new();
    for (n, r) in w.recs.iter().enumerate() {
        match r.kind {
            Kind::TICKET => {
                let tag15: [u8; 15] = r.k("citizen_tag15").try_into().unwrap_or([0; 15]);
                let t = ticket_of(r);
                for (p, q) in &t.provinces {
                    tally.entry((*p, *q, t.bell)).or_default().0 += 1;
                }
                tickets.insert(f.ctx.citizen_by_tag15(&tag15), t);
                filed_ticket(cx, r);
            }
            Kind::SETTLE => settle(cx, n, r, &mut tickets, &mut tally),
            Kind::HOME_PLACED => placed_home(cx, r),
            _ => {}
        }
        // Compare the Province post-states of this transaction once its
        // last record is applied.
        let tx = &w.txs[r.tx];
        if tx.recs.last() == Some(&n) && checked_tx.insert(r.tx) {
            cohorts_match(cx, r.tx, &tally);
        }
    }
}

fn settle(
    cx: &mut Ctx,
    n: usize,
    r: &crate::world::Rec,
    tickets: &mut BTreeMap<[u8; 32], Ticket>,
    tally: &mut BTreeMap<(i32, i32, u32), (u32, u32)>,
) {
    let w = cx.w;
    let f = cx.f;
    let (p, q, site) = r.pqs();
    let what = format!("site ({p}, {q}, {site})");
    let outcome = r.pu8("outcome");
    let tag = r.pu64("citizen_tag");
    let tb = r.pu32("ticket_bell");
    let citizen = f.by_tag8.get(&tag).copied();
    // Does this settlement end the ticket? (fresh, displace, expired, or
    // the last site taken: SettleTicket's k.)
    let k = w.txs[r.tx]
        .ix(frontier_abi::tags::Ix::SettleTicket.tag())
        .and_then(|i| aix::SettleTicket::decode(&i.data).ok())
        .map(|x| x.k);
    let ticket = citizen.and_then(|c| tickets.get(&c));
    let ends = match outcome {
        settle_outcome::TAKEN => match (k, ticket) {
            (Some(k), Some(t)) => k as usize + 1 >= t.n as usize,
            _ => false,
        },
        _ => true,
    };
    if ends {
        if let Some(t) = citizen.and_then(|c| tickets.remove(&c)) {
            for (pp, qq) in &t.provinces {
                tally.entry((*pp, *qq, t.bell)).or_default().1 += 1;
            }
        }
    }
    if outcome == settle_outcome::EXPIRED {
        if r.bell == NO_BELL || r.bell < tb.saturating_add(COHORT_BELLS) {
            cx.fail(
                V,
                COHORT_MISMATCH,
                what,
                r.bell,
                Some(r.tx),
                format!("a ticket of bell {tb} settled expired at bell {}", r.bell),
            );
        }
        return;
    }
    let region = region_of(ProvinceCoord::new(p, q));
    let (Some(seed), Some(an)) = (f.bell_seed(tb, region), f.anchor_a(tb, region)) else {
        cx.missing(
            V,
            what,
            r.bell,
            Some(r.tx),
            format!("no seed of ({tb}, {region})"),
        );
        return;
    };
    let score = fclient::land::ticket_score(&seed, p, q, site, tag);
    if score != r.pu64("score") {
        cx.fail(
            V,
            TICKET_SCORE_MISMATCH,
            what.clone(),
            r.bell,
            Some(r.tx),
            format!(
                "score {} but S({tb}, {region}) gives {score}",
                r.pu64("score")
            ),
        );
    }
    let holder = f
        .owner_at((p, q, site), n)
        .filter(|o| o.owner.is_some())
        .copied();
    let holder_tag = holder
        .and_then(|h| h.owner)
        .map(|o| u64::from_le_bytes(o[..8].try_into().unwrap_or([0; 8])));
    match outcome {
        settle_outcome::FRESH | settle_outcome::DISPLACE => {
            let want_final = f.round_time(f.seed_round(tb, an)) + 600;
            if r.pi64("final_ts") != want_final {
                cx.fail(
                    V,
                    COHORT_MISMATCH,
                    what.clone(),
                    r.bell,
                    Some(r.tx),
                    format!(
                        "final_ts {} but round_time(S) + 600 = {want_final}",
                        r.pi64("final_ts")
                    ),
                );
            }
        }
        _ => {}
    }
    let tx_time = w.txs[r.tx].time;
    // v1.6 §22 (K9, integ-W4 review): a fresh settlement waits while an
    // earlier ticket cohort of the same Province is open (filed > settled,
    // within its 24 bells), as the Province stood before.
    if outcome == settle_outcome::FRESH && r.bell != NO_BELL {
        if let Some(pv) = w
            .state_before(&f.ctx.province(p, q), r.tx)
            .and_then(|d| fclient::decode::Province::decode(d).ok())
        {
            let open = pv.cohorts.iter().any(|c| {
                c.bell < tb && c.filed > c.settled && r.bell < c.bell.saturating_add(COHORT_BELLS)
            });
            if open {
                cx.fail(
                    V,
                    COHORT_MISMATCH,
                    what.clone(),
                    r.bell,
                    Some(r.tx),
                    format!("a fresh settlement of cohort {tb} while an earlier cohort was open"),
                );
            }
        }
    }
    match (outcome, holder, holder_tag) {
        // §8.5: displacement only of a provisional holding (before its
        // `final_ts`; integ-W4 review).
        (settle_outcome::DISPLACE, Some(h), Some(_)) if tx_time >= h.final_ts => cx.fail(
            V,
            DISPLACEMENT_RULE,
            what,
            r.bell,
            Some(r.tx),
            format!(
                "displacement at {tx_time} of a holding final since {}",
                h.final_ts
            ),
        ),
        (settle_outcome::FRESH, Some(_), _) => cx.fail(
            V,
            DISPLACEMENT_RULE,
            what,
            r.bell,
            Some(r.tx),
            "a fresh settlement on a held site",
        ),
        (settle_outcome::DISPLACE, Some(h), Some(ht))
            if h.ticket_bell != tb
                || !fclient::land::beats(score, tag, h.score, ht)
                || r.pu64("displaced_tag") != ht =>
        {
            cx.fail(
                V,
                DISPLACEMENT_RULE,
                what,
                r.bell,
                Some(r.tx),
                format!(
                    "displacement of a holder of cohort {} (score {}) by cohort {tb} (score {score})",
                    h.ticket_bell, h.score
                ),
            );
        }
        (settle_outcome::DISPLACE, Some(_), Some(_)) => {}
        (settle_outcome::DISPLACE, _, _) => cx.fail(
            V,
            DISPLACEMENT_RULE,
            what,
            r.bell,
            Some(r.tx),
            "a displacement on a site with no holder",
        ),
        (settle_outcome::TAKEN, Some(h), Some(ht))
            if h.ticket_bell == tb && fclient::land::beats(score, tag, h.score, ht) =>
        {
            cx.fail(
                V,
                DISPLACEMENT_RULE,
                what,
                r.bell,
                Some(r.tx),
                "a better ticket of the holder's own cohort was turned away",
            );
        }
        _ => {}
    }
}

/// Every cohort record of every Province this transaction wrote equals
/// the tallies.
fn cohorts_match(cx: &mut Ctx, tx: usize, tally: &BTreeMap<(i32, i32, u32), (u32, u32)>) {
    let w = cx.w;
    let t = &w.txs[tx];
    let mut bad = vec![];
    for (k, a) in &t.post {
        let Some(a) = a else { continue };
        if a.owner.to_bytes() != w.program || a.data.get(..8) != Some(&PV::MAGIC[..]) {
            continue;
        }
        let Ok(pv) = fclient::decode::Province::decode(&a.data) else {
            continue;
        };
        for c in pv.cohorts.iter().filter(|c| c.filed > 0) {
            let want = tally
                .get(&(pv.p as i32, pv.q as i32, c.bell))
                .copied()
                .unwrap_or((0, 0));
            if (c.filed as u32, c.settled as u32) != want {
                bad.push((*k, pv.p, pv.q, c.bell, (c.filed, c.settled), want));
            }
        }
    }
    for (_, p, q, bell, got, want) in bad {
        cx.fail(
            V,
            COHORT_MISMATCH,
            format!("province ({p}, {q})"),
            bell,
            Some(tx),
            format!("cohort {bell}: (filed, settled) {got:?}, the records give {want:?}"),
        );
    }
}

/// Independently validate the deterministic grant; it is not a ticket win
/// and must never be accepted by the random-score verifier as one.
fn placed_home(cx: &mut Ctx, r: &crate::world::Rec) {
    use fclient::decode::{Citizen, Frontier, Holding, JoinShard, Province, Season};
    use frontier_abi::layout::player::{citizen as C, holding as H};
    use frontier_abi::layout::province::{cohort as CO, site as SM};
    use frontier_abi::tags::Ix;
    use frontier_abi::v2::layout::player::{citizen as C2, holding as H2};
    let w = cx.w;
    let f = cx.f;
    let tx = &w.txs[r.tx];
    let (p, q, site) = r.pqs();
    let what = format!("home ({p}, {q}, {site})");
    let check = || -> Result<bool, String> {
        let ix = tx
            .ix(Ix::PlaceHome.tag())
            .ok_or("no PlaceHome instruction")?;
        let arg = aix::PlaceHome::decode(&ix.data).map_err(|_| "invalid PlaceHome data")?;
        let ck = ix.key(3).ok_or("no citizen account")?;
        let pk = f.ctx.province(p, q);
        let hk = f.ctx.holding(p, q, site);
        let decode_err = |_| "invalid account bytes".to_owned();
        let cbd = w.state_before(&ck, r.tx).ok_or("no citizen pre-state")?;
        let cb = Citizen::decode(cbd).map_err(decode_err)?;
        // S1 1e: an expelled citizen's home carries the expelled flag
        // (`nation::mark_holding`), beside the intro build.
        let expelled = cbd
            .get(C2::EXPELLED_SINCE..C2::EXPELLED_SINCE + 8)
            .is_some_and(|b| le(b) != 0);
        let want_flags =
            H::FLAG_INTRO_BUILD_AVAILABLE | if expelled { H2::FLAG_EXPELLED } else { 0 };
        let ca = Citizen::decode(tx.post_data(&ck).ok_or("no citizen post-state")?)
            .map_err(decode_err)?;
        let pb = Province::decode(w.state_before(&pk, r.tx).ok_or("no province pre-state")?)
            .map_err(decode_err)?;
        let pa = Province::decode(tx.post_data(&pk).ok_or("no province post-state")?)
            .map_err(decode_err)?;
        let h = Holding::decode(tx.post_data(&hk).ok_or("no holding post-state")?)
            .map_err(decode_err)?;
        let frontier = Frontier::decode(
            w.state_before(&f.ctx.frontier(), r.tx)
                .ok_or("no frontier pre-state")?,
        )
        .map_err(decode_err)?;
        let season = Season::decode(
            w.state_before(&f.ctx.season, r.tx)
                .ok_or("no season pre-state")?,
        )
        .map_err(decode_err)?;
        let sk = f.ctx.join_shard(cb.faction, cb.join_shard);
        let sb = JoinShard::decode(w.state_before(&sk, r.tx).ok_or("no shard pre-state")?)
            .map_err(decode_err)?;
        let sa = JoinShard::decode(tx.post_data(&sk).ok_or("no shard post-state")?)
            .map_err(decode_err)?;
        let coord = ProvinceCoord::new(p, q);
        if site as usize >= pb.site_count as usize || site as usize >= 12 {
            return Ok(false);
        }
        let b = &pb.site_mirror[site as usize];
        let a = &pa.site_mirror[site as usize];
        let gen = b.gen.checked_add(1).ok_or("generation overflow")?;
        let held = ca.holding[0];
        let now_bell = frontier_abi::prologue::bell_at(f.genesis_ts, tx.time).unwrap_or(0);
        let shield_bell = ((h.shield_until.saturating_sub(f.genesis_ts).max(0) + 599) / 600) as u32;
        let (home_nation, home_max_ring) =
            home_rule_of(f.cq.as_ref(), f.genesis_seed.as_ref(), coord)
                .ok_or("missing or unsupported placement evidence")?;
        // The program counts the home under the province's wedge (its
        // `holding_wedge`, the index SettleTicket and the release use), which
        // is the nation only under placement 0.
        let wedge = coord.wedge().ok_or("a home in the Concord")? as usize;
        let shard_counted = sa
            .holdings_by_wedge
            .iter()
            .zip(sb.holdings_by_wedge.iter())
            .enumerate()
            .all(|(i, (a, b))| if i == wedge { *a == b + 1 } else { a == b });
        Ok(ix.accounts.len() == 9
            && (arg.p as i32, arg.q as i32, arg.site) == (p, q, site)
            && ix.key(2) == Some(f.ctx.season)
            && ix.key(4) == Some(f.ctx.frontier())
            && ix.key(5) == Some(pk)
            && ix.key(6) == Some(hk)
            && ix.key(7) == Some(sk)
            && season.program_version >= 2
            && coord.ring() >= 2
            && coord.ring() <= home_max_ring as u32
            && coord.ring() < frontier.rings_opened as u32
            && home_nation == cb.faction
            && cb.flags
                & (C::FLAG_HOME_GRANTED
                    | C::FLAG_FIRST_HOLDING_FINAL
                    | C::FLAG_PROVISIONAL
                    | C::FLAG_REFUGEE)
                == 0
            && cb.holdings_n == 0
            && cb.ticket_bell == C::NO_TICKET
            && matches!(b.state, SM::STATE_FREE | SM::STATE_RELEASED_FREE)
            && pb
                .cohorts
                .iter()
                .all(|c| CO::is_free(c.bell, c.filed, c.settled, now_bell))
            && ca.flags == cb.flags | C::FLAG_HOME_GRANTED | C::FLAG_FIRST_HOLDING_FINAL
            && ca.holdings_n == 1
            && (held.p as i32, held.q as i32, held.site, held.gen) == (p, q, site, gen)
            && ca.ticket_bell == C::NO_TICKET
            && ca.ticket_escrow == cb.ticket_escrow
            && h.owner_citizen.to_bytes() == ck
            && h.state == H::STATE_FINAL
            && h.flags == want_flags
            && h.gen == gen
            && h.tile == pb.sites[site as usize]
            && h.faction == cb.faction
            && h.ticket_score == 0
            && h.ticket_bell == C::NO_TICKET
            && h.final_ts == tx.time
            && h.founded_ts == tx.time
            && Some(h.rent_payer.to_bytes()) == ix.key(1)
            && a.state == SM::STATE_HOLDING
            && a.faction == cb.faction
            && a.gen == gen
            && a.order == 1
            && a.tier == 0
            && a.garrison == 0
            && a.shield_until_bell == shield_bell
            && pa.n_sites_used == pb.n_sites_used + 1
            && pa.roster_epoch == pb.roster_epoch.wrapping_add(1)
            && pa.cohorts == pb.cohorts
            && sa.holdings == sb.holdings + 1
            && shard_counted
            && r.pu64("citizen_tag") == cb.citizen_tag
            && r.pu8("gen") == gen
            && r.pi64("final_ts") == tx.time
            && Some(r.p32("funder")) == ix.key(1))
    };
    match check() {
        Ok(true) => {}
        Ok(false) => cx.fail(
            V,
            HOME_PLACEMENT_MISMATCH,
            what,
            r.bell,
            Some(r.tx),
            "first-home entitlement, selected site, ownership or mirror mismatch",
        ),
        Err(e) => cx.missing(V, what, r.bell, Some(r.tx), e),
    }
}

/// The program's PlaceHome placement rule from the season's evidence: the
/// province's nation (`geometry::home_nation` with the conquest block's
/// `placement`) and the last heartland ring a home may take
/// (`heartland_max_ring`). Missing evidence (no conquest block, a dispersed
/// season without its GENESIS_SEED, an unknown placement) is `None`, never
/// a wedge fallback.
fn home_rule_of(
    cq: Option<&frontier_abi::v2::presets::ConquestParams>,
    genesis_seed: Option<&[u8; 32]>,
    coord: ProvinceCoord,
) -> Option<(u8, u8)> {
    use permutation_rules::frontier::geometry::{
        home_nation, PLACEMENT_DISPERSED, PLACEMENT_WEDGE,
    };
    let cq = cq?;
    let nation = match (cq.placement, genesis_seed) {
        (PLACEMENT_WEDGE, _) => coord.wedge()?,
        (PLACEMENT_DISPERSED, Some(seed)) => {
            home_nation(coord, cq.placement, cq.heartland_max_ring, seed)?
        }
        _ => return None,
    };
    Some((nation, cq.heartland_max_ring))
}

// ------------------------------------------------------------ tickets

/// What a check made of one instruction from its evidence: a PASS, a FAIL
/// with its detail, or evidence the archive does not hold (`MissingData`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Judgement {
    Pass,
    Fail(String),
    Missing(String),
}

/// The program's legacy FileTicket wedge rule (`proc/citizen.rs::
/// wedge_allowed`, pinned here byte for byte): the citizen's own wedge, or
/// (when the folded Frontier shows no free site left in it) the outermost
/// open ring of an adjacent wedge.
pub fn legacy_wedge_allowed(
    faction: u8,
    site_wedge: u8,
    site_ring: u32,
    own_open: u32,
    own_occupied: u32,
    rings_opened: u16,
) -> bool {
    if site_wedge == faction {
        return true;
    }
    let adjacent = site_wedge == (faction + 1) % 6 || site_wedge == (faction + 5) % 6;
    own_open.saturating_sub(own_occupied) == 0
        && adjacent
        && rings_opened > 0
        && site_ring == rings_opened as u32 - 1
}

/// The program's FileTicket site rule from the season's evidence (its
/// `ticket_nation_allowed` over `wedge_allowed`): inside a dispersed
/// heartland (`placement` 1, rings `2..=heartland_max_ring`) the site's
/// province must be the nation's (`home_nation`, the rule PlaceHome uses);
/// everywhere else — the wedge placement, an M1 season, the rings outside
/// the heartland — the legacy wedge rule with its adjacent-wedge overflow.
/// `None` when the evidence is missing: a conquest season (`v3`) without
/// its conquest block, a dispersed heartland site without the GENESIS_SEED,
/// an unknown placement. An M1 season has no conquest block by design and
/// runs the legacy rule. The Concord is never a ticket site.
#[allow(clippy::too_many_arguments)]
pub fn ticket_site_rule(
    v3: bool,
    cq: Option<&frontier_abi::v2::presets::ConquestParams>,
    genesis_seed: Option<&[u8; 32]>,
    coord: ProvinceCoord,
    faction: u8,
    own_open: u32,
    own_occupied: u32,
    rings_opened: u16,
) -> Option<bool> {
    use permutation_rules::frontier::geometry::{
        home_nation, PLACEMENT_DISPERSED, PLACEMENT_WEDGE,
    };
    let Some(wedge) = coord.wedge() else {
        return Some(false);
    };
    let legacy = legacy_wedge_allowed(
        faction,
        wedge,
        coord.ring(),
        own_open,
        own_occupied,
        rings_opened,
    );
    let Some(cq) = cq else {
        return if v3 { None } else { Some(legacy) };
    };
    match cq.placement {
        PLACEMENT_WEDGE => Some(legacy),
        PLACEMENT_DISPERSED => {
            let ring = coord.ring();
            if ring < 2 || ring > cq.heartland_max_ring as u32 {
                return Some(legacy);
            }
            let seed = genesis_seed?;
            Some(home_nation(coord, PLACEMENT_DISPERSED, cq.heartland_max_ring, seed)? == faction)
        }
        _ => None,
    }
}

/// The evidence a FileTicket is judged from.
pub struct TicketEvidence<'a> {
    /// A conquest season (program version ≥ 3): its conquest block is
    /// required evidence.
    pub v3: bool,
    pub cq: Option<&'a frontier_abi::v2::presets::ConquestParams>,
    pub genesis_seed: Option<&'a [u8; 32]>,
    /// The Season's `r_max` (CreateSeason's).
    pub r_max: Option<u16>,
    /// The FileTicket instruction data.
    pub data: &'a [u8],
    pub citizen_before: Option<&'a [u8]>,
    pub citizen_after: Option<&'a [u8]>,
    pub frontier_before: Option<&'a [u8]>,
    /// The TICKET record: its bell and payload fields.
    pub bell: u32,
    pub ticket_bell: u32,
    pub n: u8,
    pub sites: &'a [u8],
}

/// A FileTicket re-judged as the program's `file_ticket` judges it (module
/// doc). The accounts the instruction names are the caller's to check.
pub fn judge_ticket(e: &TicketEvidence) -> Judgement {
    use frontier_abi::layout::player::citizen as C;
    use frontier_abi::layout::world::frontier as FR;
    use Judgement::{Fail, Missing};
    let Ok(x) = aix::FileTicket::decode(e.data) else {
        return Fail("the FileTicket data does not decode".into());
    };
    let (Some(cd), Some(fd)) = (e.citizen_before, e.frontier_before) else {
        return Missing("no state of the Citizen or the Frontier before the filing".into());
    };
    if cd.len() < C::SIZE || fd.len() < FR::SIZE {
        return Fail("the Citizen or the Frontier before the filing is not that account".into());
    }
    let Some(r_max) = e.r_max else {
        return Missing("no CreateSeason parameters: r_max unknown".into());
    };
    if e.v3 && e.cq.is_none() {
        return Missing(
            "a conquest season without its conquest block: the placement is unknown".into(),
        );
    }
    let faction = cd[C::FACTION];
    if faction >= 6 {
        return Fail(format!("the citizen's faction is {faction}"));
    }
    if cd[C::FLAGS] & (C::FLAG_PROVISIONAL | C::FLAG_FIRST_HOLDING_FINAL) != 0
        || le(&cd[C::TICKET_BELL..C::TICKET_BELL + 4]) as u32 != C::NO_TICKET
    {
        return Fail("the citizen had a first holding or an open ticket".into());
    }
    let rings_opened = le(&fd[FR::RINGS_OPENED..FR::RINGS_OPENED + 2]) as u16;
    let r_max = r_max.max(le(&fd[FR::R_MAX_EXT..FR::R_MAX_EXT + 2]) as u16);
    let at =
        |base: usize| le(&fd[base + 4 * faction as usize..base + 4 * faction as usize + 4]) as u32;
    let (own_open, own_occ) = (at(FR::WEDGE_OPEN), at(FR::WEDGE_OCCUPIED));
    if e.ticket_bell != e.bell || e.n != x.n {
        return Fail("the TICKET record's bell or site count is not the filing's".into());
    }
    let n = x.n as usize;
    if e.sites.len() != 15 || n == 0 || n > 3 {
        return Fail("the TICKET record's sites are not three entries".into());
    }
    let mut seen: Vec<(i16, i16, u8)> = Vec::with_capacity(3);
    for (i, s) in x.sites.iter().take(n).enumerate() {
        let rec = (
            le(&e.sites[5 * i..5 * i + 2]) as u16 as i16,
            le(&e.sites[5 * i + 2..5 * i + 4]) as u16 as i16,
            e.sites[5 * i + 4],
        );
        let what = format!("site {i} ({}, {}, {})", s.p, s.q, s.site);
        if rec != (s.p, s.q, s.site) {
            return Fail(format!("{what} is not the record's {rec:?}"));
        }
        if seen.contains(&rec) {
            return Fail(format!("{what} is named twice"));
        }
        seen.push(rec);
        let Ok(coord) = ProvinceCoord::checked(s.p as i32, s.q as i32, r_max) else {
            return Fail(format!("{what} lies beyond the effective r_max {r_max}"));
        };
        let ring = coord.ring();
        if ring < 2 {
            return Fail(format!("{what} lies in a reserved ring"));
        }
        if ring >= rings_opened as u32 {
            return Fail(format!(
                "{what} lies in ring {ring}, not opened ({rings_opened} rings)"
            ));
        }
        if s.site as usize >= 12 {
            return Fail(format!("{what} is not a site index"));
        }
        match ticket_site_rule(
            e.v3,
            e.cq,
            e.genesis_seed,
            coord,
            faction,
            own_open,
            own_occ,
            rings_opened,
        ) {
            None => {
                return Missing(format!(
                    "missing or unsupported placement evidence for {what}"
                ))
            }
            Some(false) => {
                return Fail(format!(
                    "{what} is outside the placement rule of nation {faction} (own wedge {own_occ} of {own_open} occupied, {rings_opened} rings)"
                ))
            }
            Some(true) => {}
        }
    }
    if e.sites[5 * n..].iter().any(|b| *b != 0) {
        return Fail("the record's unused site entries are not zero".into());
    }
    let Some(ca) = e.citizen_after else {
        return Missing("no Citizen post-state".into());
    };
    if ca.len() < C::SIZE
        || le(&ca[C::TICKET_BELL..C::TICKET_BELL + 4]) as u32 != e.bell
        || ca[C::TICKET_SITES..C::TICKET_SITES + 15] != e.sites[..]
    {
        return Fail("the Citizen after the filing does not carry this ticket".into());
    }
    Judgement::Pass
}

/// Which instruction a TICKET record stands for (module doc,
/// "Attribution").
#[derive(Debug)]
pub enum TicketRoute<'a> {
    /// One FileTicket of the record's citizen, and nothing else in the
    /// transaction may write that Citizen or the Frontier: judge it from
    /// the transaction's states.
    Isolated(&'a Ix),
    /// The citizen's only filing in the transaction is a FileOutpost: V22's.
    Outpost,
    /// The record cannot be attributed to one instruction's states:
    /// `MissingData`.
    Mixed(String),
    /// No filing of this citizen accounts for the record: a FAIL.
    Fail(String),
}

/// The attribution of a TICKET record of `citizen` (its account) among the
/// transaction's top-level program instructions `ixs`; `n_records` the
/// TICKET records of that citizen in the transaction.
pub fn route_ticket<'a>(
    ixs: &'a [Ix],
    citizen: &Key,
    frontier: &Key,
    n_records: usize,
) -> TicketRoute<'a> {
    use frontier_abi::tags::Ix as V1Ix;
    let of_citizen = |tag: u8| -> Vec<&'a Ix> {
        ixs.iter()
            .filter(|i| i.tag() == Some(tag) && i.key(3) == Some(*citizen))
            .collect()
    };
    let tickets = of_citizen(V1Ix::FileTicket.tag());
    let outposts = of_citizen(frontier_abi::v2::tags::Ix::FileOutpost.tag());
    match (tickets.as_slice(), outposts.as_slice()) {
        ([], []) if ixs.is_empty() => TicketRoute::Mixed(
            "no top-level instruction of the program: the filing is an inner instruction the archive does not show (V0E reports it)".into(),
        ),
        ([], []) => TicketRoute::Fail(
            "no FileTicket or FileOutpost of the transaction names this citizen".into(),
        ),
        ([], [_]) => TicketRoute::Outpost,
        ([ix], []) => {
            let writers: Vec<usize> = ixs
                .iter()
                .filter(|i| i.index != ix.index && (i.writes(citizen) || i.writes(frontier)))
                .map(|i| i.index)
                .collect();
            if !writers.is_empty() {
                return TicketRoute::Mixed(format!(
                    "instruction(s) {writers:?} of the transaction may write this Citizen or the Frontier too: the states before and after the transaction cannot be attributed to the FileTicket alone"
                ));
            }
            if n_records != 1 {
                return TicketRoute::Fail(format!(
                    "{n_records} TICKET records of this citizen for one FileTicket"
                ));
            }
            TicketRoute::Isolated(ix)
        }
        (t, o) => TicketRoute::Mixed(format!(
            "{} FileTicket and {} FileOutpost of this citizen in one transaction: the record cannot be attributed to one of them",
            t.len(),
            o.len()
        )),
    }
}

/// A TICKET record, attributed ([`route_ticket`]) and judged from the
/// states before its transaction ([`judge_ticket`]).
fn filed_ticket(cx: &mut Ctx, r: &crate::world::Rec) {
    let w = cx.w;
    let f = cx.f;
    let v3 = cx.v3;
    let tx = &w.txs[r.tx];
    let tag15: [u8; 15] = r.k("citizen_tag15").try_into().unwrap_or([0; 15]);
    let what = format!(
        "ticket of citizen {} at bell {}",
        hex::encode(tag15),
        r.bell
    );
    let ck = f.ctx.citizen_by_tag15(&tag15);
    let n_records = tx
        .recs
        .iter()
        .filter(|&&n| w.recs[n].kind == Kind::TICKET && w.recs[n].k("citizen_tag15") == &tag15[..])
        .count();
    let judged = (|| -> Judgement {
        let ix = match route_ticket(&tx.ixs, &ck, &f.ctx.frontier(), n_records) {
            TicketRoute::Isolated(ix) => ix,
            TicketRoute::Outpost => return Judgement::Pass,
            TicketRoute::Mixed(why) => return Judgement::Missing(why),
            TicketRoute::Fail(why) => return Judgement::Fail(why),
        };
        if ix.key(4) != Some(f.ctx.frontier()) {
            return Judgement::Fail("the instruction's Frontier is not the season's".into());
        }
        if !w.has_post {
            return Judgement::Missing(
                "no post-states: the Citizen and the Frontier before the filing are unknown".into(),
            );
        }
        judge_ticket(&TicketEvidence {
            v3,
            cq: f.cq.as_ref(),
            genesis_seed: f.genesis_seed.as_ref(),
            r_max: f.params.as_ref().map(|p| p.r_max),
            data: &ix.data,
            citizen_before: w.state_before(&ck, r.tx),
            citizen_after: tx.post_data(&ck),
            frontier_before: w.state_before(&f.ctx.frontier(), r.tx),
            bell: r.bell,
            ticket_bell: r.pu32("ticket_bell"),
            n: r.pu8("n"),
            sites: r.p("sites"),
        })
    })();
    match judged {
        Judgement::Pass => {}
        Judgement::Fail(why) => {
            cx.fail(V, TICKET_PLACEMENT_MISMATCH, what, r.bell, Some(r.tx), why)
        }
        Judgement::Missing(why) => cx.missing(V, what, r.bell, Some(r.tx), why),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use frontier_abi::v2::presets::{ConquestParams, FRONTIER_7, PLACEMENT_DISPERSED};
    use permutation_rules::frontier::geometry::{home_nation, ring_provinces};

    fn cq(placement: u8, hmr: u8) -> ConquestParams {
        let mut c = FRONTIER_7;
        c.placement = placement;
        c.heartland_max_ring = hmr;
        c
    }

    /// The placement evidence is read as the program reads it, and every
    /// gap in it is `None` (a MISSING finding), never the wedge.
    #[test]
    fn home_rule_follows_the_program_and_fails_closed_without_evidence() {
        let seed = [1u8; 32];
        let ring2 = ring_provinces(2);
        for c in &ring2 {
            // placement 0: the wedge, with or without a seed
            assert_eq!(
                home_rule_of(Some(&cq(0, 3)), None, *c),
                Some((c.wedge().unwrap(), 3))
            );
            assert_eq!(
                home_rule_of(Some(&cq(0, 4)), Some(&seed), *c),
                Some((c.wedge().unwrap(), 4))
            );
            // placement 1: the program's rule from the genesis seed
            assert_eq!(
                home_rule_of(Some(&cq(1, 3)), Some(&seed), *c),
                Some((home_nation(*c, PLACEMENT_DISPERSED, 3, &seed).unwrap(), 3))
            );
            // no conquest block, a dispersed season without its seed, an unknown placement
            assert_eq!(home_rule_of(None, Some(&seed), *c), None);
            assert_eq!(home_rule_of(Some(&cq(1, 3)), None, *c), None);
            assert_eq!(home_rule_of(Some(&cq(2, 3)), Some(&seed), *c), None);
        }
        // the Concord has no nation under either placement
        assert_eq!(
            home_rule_of(Some(&cq(0, 3)), Some(&seed), ProvinceCoord::CONCORD),
            None
        );
        assert_eq!(
            home_rule_of(Some(&cq(1, 3)), Some(&seed), ProvinceCoord::CONCORD),
            None
        );
        // the dispersed placement names a nation off its wedge somewhere
        assert!(ring2.iter().any(|c| {
            home_rule_of(Some(&cq(1, 3)), Some(&seed), *c).map(|(n, _)| n) != c.wedge()
        }));
    }

    /// The legacy wedge rule, pinned to the program's `wedge_allowed` with
    /// its own test vectors.
    #[test]
    fn legacy_wedge_rule_is_the_programs() {
        assert!(legacy_wedge_allowed(2, 2, 3, 10, 0, 4));
        assert!(!legacy_wedge_allowed(2, 3, 3, 10, 9, 4));
        assert!(legacy_wedge_allowed(2, 3, 3, 10, 10, 4));
        assert!(legacy_wedge_allowed(2, 1, 3, 10, 10, 4));
        assert!(!legacy_wedge_allowed(2, 4, 3, 10, 10, 4));
        assert!(!legacy_wedge_allowed(2, 3, 2, 10, 10, 4));
        assert!(legacy_wedge_allowed(0, 5, 3, 0, 0, 4));
        // no ring open: no overflow anywhere
        assert!(!legacy_wedge_allowed(0, 1, 0, 0, 0, 0));
    }

    /// The ticket site rule is the program's `ticket_nation_allowed` over
    /// `wedge_allowed`: the nation inside a dispersed heartland, the legacy
    /// wedge and overflow rule everywhere else, and `None` (MISSING) for
    /// every gap in the evidence, never the wedge.
    #[test]
    fn ticket_site_rule_follows_the_program_and_fails_closed_without_evidence() {
        let seed = [1u8; 32];
        let (open, occ, rings) = (10u32, 0u32, 4u16);
        let heart: Vec<ProvinceCoord> = ring_provinces(2)
            .into_iter()
            .chain(ring_provinces(3))
            .collect();
        let mut off_wedge = 0;
        for c in &heart {
            let wedge = c.wedge().unwrap();
            let nation = home_nation(*c, PLACEMENT_DISPERSED, 3, &seed).unwrap();
            off_wedge += usize::from(nation != wedge);
            for f in 0..6u8 {
                let legacy = legacy_wedge_allowed(f, wedge, c.ring(), open, occ, rings);
                // placement 0, and an M1 season (no block by design): the legacy rule
                assert_eq!(
                    ticket_site_rule(true, Some(&cq(0, 3)), None, *c, f, open, occ, rings),
                    Some(legacy)
                );
                assert_eq!(
                    ticket_site_rule(false, None, None, *c, f, open, occ, rings),
                    Some(legacy)
                );
                // placement 1 inside the heartland: the nation, whatever the
                // wedge rule or the overflow would say
                for occ in [occ, open] {
                    assert_eq!(
                        ticket_site_rule(
                            true,
                            Some(&cq(1, 3)),
                            Some(&seed),
                            *c,
                            f,
                            open,
                            occ,
                            rings
                        ),
                        Some(nation == f)
                    );
                }
                // a conquest season without its block, a dispersed heartland
                // site without the seed, an unknown placement: no answer
                assert_eq!(
                    ticket_site_rule(true, None, Some(&seed), *c, f, open, occ, rings),
                    None
                );
                assert_eq!(
                    ticket_site_rule(true, Some(&cq(1, 3)), None, *c, f, open, occ, rings),
                    None
                );
                assert_eq!(
                    ticket_site_rule(true, Some(&cq(2, 3)), Some(&seed), *c, f, open, occ, rings),
                    None
                );
            }
        }
        assert!(
            off_wedge > 0,
            "the dispersed placement puts homes off their wedge"
        );
        // Outside the heartland the dispersed season keeps the legacy
        // overflow rule, seed or not: a full own wedge may file in an
        // adjacent wedge's outermost open ring, an empty one may not.
        let out = ProvinceCoord::new(4, 0);
        assert_eq!(out.ring(), 4);
        let w4 = out.wedge().unwrap();
        for (open, occ) in [(10u32, 0u32), (10, 10)] {
            for f in 0..6u8 {
                let legacy = legacy_wedge_allowed(f, w4, 4, open, occ, 5);
                for seed in [Some(&seed), None] {
                    assert_eq!(
                        ticket_site_rule(true, Some(&cq(1, 3)), seed, out, f, open, occ, 5),
                        Some(legacy)
                    );
                }
            }
        }
        assert!(legacy_wedge_allowed((w4 + 1) % 6, w4, 4, 10, 10, 5));
        assert!(!legacy_wedge_allowed((w4 + 1) % 6, w4, 4, 10, 9, 5));
        // the Concord is never a ticket site
        assert_eq!(
            ticket_site_rule(
                true,
                Some(&cq(1, 3)),
                Some(&seed),
                ProvinceCoord::CONCORD,
                0,
                10,
                0,
                5
            ),
            Some(false)
        );
    }

    // --- the FileTicket judgement over literal account bytes (no key, no chain)

    #[derive(Clone)]
    struct Case {
        v3: bool,
        cq: Option<ConquestParams>,
        seed: Option<[u8; 32]>,
        r_max: Option<u16>,
        data: Vec<u8>,
        before: Option<Vec<u8>>,
        after: Option<Vec<u8>>,
        frontier: Option<Vec<u8>>,
        bell: u32,
        ticket_bell: u32,
        n: u8,
        sites: [u8; 15],
    }

    impl Case {
        fn judge(&self) -> Judgement {
            judge_ticket(&TicketEvidence {
                v3: self.v3,
                cq: self.cq.as_ref(),
                genesis_seed: self.seed.as_ref(),
                r_max: self.r_max,
                data: &self.data,
                citizen_before: self.before.as_deref(),
                citizen_after: self.after.as_deref(),
                frontier_before: self.frontier.as_deref(),
                bell: self.bell,
                ticket_bell: self.ticket_bell,
                n: self.n,
                sites: &self.sites,
            })
        }
        fn fails(&self) -> bool {
            matches!(self.judge(), Judgement::Fail(_))
        }
        fn missing(&self) -> bool {
            matches!(self.judge(), Judgement::Missing(_))
        }
    }

    fn citizen_bytes(faction: u8, flags: u8, ticket_bell: u32) -> Vec<u8> {
        use frontier_abi::layout::player::citizen as C;
        let mut d = vec![0u8; C::SIZE];
        d[C::FACTION] = faction;
        d[C::FLAGS] = flags;
        d[C::TICKET_BELL..C::TICKET_BELL + 4].copy_from_slice(&ticket_bell.to_le_bytes());
        d
    }

    fn frontier_bytes(rings_opened: u16, r_max_ext: u16, open: [u32; 6], occ: [u32; 6]) -> Vec<u8> {
        use frontier_abi::layout::world::frontier as FR;
        let mut d = vec![0u8; FR::SIZE];
        d[FR::RINGS_OPENED..FR::RINGS_OPENED + 2].copy_from_slice(&rings_opened.to_le_bytes());
        d[FR::R_MAX_EXT..FR::R_MAX_EXT + 2].copy_from_slice(&r_max_ext.to_le_bytes());
        for w in 0..6 {
            d[FR::WEDGE_OPEN + 4 * w..FR::WEDGE_OPEN + 4 * w + 4]
                .copy_from_slice(&open[w].to_le_bytes());
            d[FR::WEDGE_OCCUPIED + 4 * w..FR::WEDGE_OCCUPIED + 4 * w + 4]
                .copy_from_slice(&occ[w].to_le_bytes());
        }
        d
    }

    fn sites_payload(sites: &[(i16, i16, u8)]) -> [u8; 15] {
        let mut p = [0u8; 15];
        for (i, s) in sites.iter().enumerate() {
            p[5 * i..5 * i + 2].copy_from_slice(&s.0.to_le_bytes());
            p[5 * i + 2..5 * i + 4].copy_from_slice(&s.1.to_le_bytes());
            p[5 * i + 4] = s.2;
        }
        p
    }

    fn ticket_data(sites: &[(i16, i16, u8)]) -> Vec<u8> {
        use frontier_abi::ix::TicketSite;
        let mut x = aix::FileTicket {
            n: sites.len() as u8,
            sites: [TicketSite::default(); 3],
        };
        for (i, s) in sites.iter().enumerate() {
            x.sites[i] = TicketSite {
                p: s.0,
                q: s.1,
                site: s.2,
            };
        }
        let mut out = vec![0u8; x.data_len()];
        x.encode(&mut out).unwrap();
        out
    }

    /// A filing at bell 40 by a citizen of `faction` with no holding and no
    /// ticket, the Citizen after it carrying the ticket.
    fn case(
        faction: u8,
        sites: &[(i16, i16, u8)],
        cq: Option<ConquestParams>,
        seed: Option<[u8; 32]>,
        frontier: Vec<u8>,
    ) -> Case {
        use frontier_abi::layout::player::citizen as C;
        let before = citizen_bytes(faction, C::FLAG_JOINED, C::NO_TICKET);
        let payload = sites_payload(sites);
        let mut after = before.clone();
        after[C::TICKET_BELL..C::TICKET_BELL + 4].copy_from_slice(&40u32.to_le_bytes());
        after[C::TICKET_SITES..C::TICKET_SITES + 15].copy_from_slice(&payload);
        Case {
            v3: true,
            cq,
            seed,
            r_max: Some(8),
            data: ticket_data(sites),
            before: Some(before),
            after: Some(after),
            frontier: Some(frontier),
            bell: 40,
            ticket_bell: 40,
            n: sites.len() as u8,
            sites: payload,
        }
    }

    /// Valid, invalid and incomplete FileTicket evidence: the dispersed
    /// heartland's nation rule (PlaceHome's), the legacy wedge and overflow
    /// rule outside it, the effective `r_max` of map growth, and every
    /// missing piece of evidence reported as such.
    #[test]
    fn dispersed_ticket_judgement_follows_the_program_and_fails_closed() {
        use frontier_abi::layout::player::citizen as C;
        let seed = [1u8; 32];
        let c = ring_provinces(2)
            .into_iter()
            .chain(ring_provinces(3))
            .find(|c| home_nation(*c, PLACEMENT_DISPERSED, 3, &seed) != c.wedge())
            .expect("a heartland province off its nation's wedge");
        let nation = home_nation(c, PLACEMENT_DISPERSED, 3, &seed).unwrap();
        let wedge = c.wedge().unwrap();
        let site = (c.p as i16, c.q as i16, 0u8);
        let quiet = frontier_bytes(5, 0, [10; 6], [0; 6]);

        // Valid: the nation's own heartland province, off its wedge.
        let ok = case(nation, &[site], Some(cq(1, 3)), Some(seed), quiet.clone());
        assert_eq!(ok.judge(), Judgement::Pass);
        // Invalid: the wedge's nation (the wedge rule would allow it).
        assert!(case(wedge, &[site], Some(cq(1, 3)), Some(seed), quiet.clone()).fails());
        // The same filing under placement 0 is the wedge's and not the nation's.
        assert_eq!(
            case(wedge, &[site], Some(cq(0, 3)), None, quiet.clone()).judge(),
            Judgement::Pass
        );
        assert!(case(nation, &[site], Some(cq(0, 3)), None, quiet.clone()).fails());
        // An M1 season (no block): the legacy rule.
        let mut m1 = case(wedge, &[site], None, None, quiet.clone());
        m1.v3 = false;
        assert_eq!(m1.judge(), Judgement::Pass);

        // Outside the heartland the legacy overflow rule is preserved.
        let out = ProvinceCoord::new(4, 0);
        let w4 = out.wedge().unwrap();
        let adj = (w4 + 5) % 6; // `out` lies in adj's next wedge
        let s4 = (4i16, 0i16, 1u8);
        assert_eq!(
            case(w4, &[s4], Some(cq(1, 3)), Some(seed), quiet.clone()).judge(),
            Judgement::Pass
        );
        assert!(case(adj, &[s4], Some(cq(1, 3)), Some(seed), quiet.clone()).fails());
        let full = frontier_bytes(5, 0, [10; 6], [10; 6]);
        assert_eq!(
            case(adj, &[s4], Some(cq(1, 3)), Some(seed), full.clone()).judge(),
            Judgement::Pass
        );
        // the seed is not needed there
        assert_eq!(
            case(adj, &[s4], Some(cq(1, 3)), None, full.clone()).judge(),
            Judgement::Pass
        );
        // not the outermost open ring: no overflow
        assert!(case(
            adj,
            &[s4],
            Some(cq(1, 3)),
            Some(seed),
            frontier_bytes(6, 0, [10; 6], [10; 6])
        )
        .fails());

        // Map growth: the effective r_max is the larger of the Season's and
        // the Frontier's `r_max_ext`.
        let mut small = case(w4, &[s4], Some(cq(1, 3)), Some(seed), quiet.clone());
        small.r_max = Some(3);
        assert!(small.fails());
        small.frontier = Some(frontier_bytes(5, 4, [10; 6], [0; 6]));
        assert_eq!(small.judge(), Judgement::Pass);

        // Incomplete evidence: never a PASS, never a FAIL.
        let mut m = ok.clone();
        m.seed = None;
        assert!(m.missing(), "a dispersed heartland site without the seed");
        let mut m = ok.clone();
        m.cq = None;
        assert!(m.missing(), "a conquest season without its block");
        let mut m = ok.clone();
        m.frontier = None;
        assert!(m.missing());
        let mut m = ok.clone();
        m.before = None;
        assert!(m.missing());
        let mut m = ok.clone();
        m.after = None;
        assert!(m.missing());
        let mut m = ok.clone();
        m.r_max = None;
        assert!(m.missing());

        // Invalid evidence: the record, the citizen's state, the sites.
        let mut m = ok.clone();
        m.n = 2;
        assert!(m.fails(), "the record's site count");
        let mut m = ok.clone();
        m.ticket_bell = 41;
        assert!(m.fails(), "the record's ticket bell");
        let mut m = ok.clone();
        m.before = Some(citizen_bytes(
            nation,
            C::FLAG_JOINED | C::FLAG_FIRST_HOLDING_FINAL,
            C::NO_TICKET,
        ));
        assert!(m.fails(), "a first holding already");
        let mut m = ok.clone();
        m.before = Some(citizen_bytes(nation, C::FLAG_JOINED, 5));
        assert!(m.fails(), "an open ticket already");
        let mut m = ok.clone();
        m.after = m.before.clone();
        assert!(m.fails(), "the Citizen after it carries no ticket");
        let mut m = ok.clone();
        m.data = ticket_data(&[(c.p as i16, c.q as i16, 1)]);
        assert!(m.fails(), "the record is not the instruction's");
        assert!(case(
            nation,
            &[(c.p as i16, c.q as i16, 12)],
            Some(cq(1, 3)),
            Some(seed),
            quiet.clone()
        )
        .fails());
        assert!(case(
            nation,
            &[site, site],
            Some(cq(1, 3)),
            Some(seed),
            quiet.clone()
        )
        .fails());
        assert!(case(0, &[(1, 0, 0)], Some(cq(1, 3)), Some(seed), quiet.clone()).fails());
        assert!(case(
            w4,
            &[s4],
            Some(cq(1, 3)),
            Some(seed),
            frontier_bytes(4, 0, [10; 6], [0; 6])
        )
        .fails());
        let mut m = ok.clone();
        m.data = vec![frontier_abi::tags::Ix::FileTicket.tag(), 0];
        assert!(m.fails(), "undecodable data");
    }

    // --- the attribution of a TICKET record (literal keys and instruction bytes)

    const SEASON_K: Key = [0x22; 32];
    const FRONTIER_K: Key = [0x33; 32];
    const PAYER_K: Key = [0x44; 32];
    const CITIZEN_A: Key = [0xa1; 32];
    const CITIZEN_B: Key = [0xb2; 32];

    /// FileTicket of one site by `citizen`: `[actor] [payer] [season]
    /// [citizen w] [frontier r] [province w] [system]`.
    fn ticket_ix(index: usize, citizen: Key) -> Ix {
        Ix {
            index,
            data: ticket_data(&[(2, 0, 0)]),
            accounts: vec![
                ([0x77; 32], true),
                (PAYER_K, true),
                (SEASON_K, false),
                (citizen, true),
                (FRONTIER_K, false),
                ([0x78; 32], true),
                ([0; 32], false),
            ],
        }
    }

    /// FileOutpost by `citizen` (its data is not read here: the tag and the
    /// citizen position are the attribution): the player prologue, the
    /// Frontier read-only, a province, the system, the anchor and its
    /// province, the previous holding and its province.
    fn outpost_ix(index: usize, citizen: Key) -> Ix {
        Ix {
            index,
            data: vec![frontier_abi::v2::tags::Ix::FileOutpost.tag()],
            accounts: vec![
                ([0x77; 32], true),
                (PAYER_K, true),
                (SEASON_K, false),
                (citizen, true),
                (FRONTIER_K, false),
                ([0x78; 32], true),
                ([0; 32], false),
                ([0x79; 32], true),
                ([0x7a; 32], false),
                ([0x79; 32], true),
                ([0x7a; 32], false),
            ],
        }
    }

    /// SetVigil by `citizen`: writes the Citizen, names no Frontier.
    fn vigil_ix(index: usize, citizen: Key) -> Ix {
        Ix {
            index,
            data: vec![frontier_abi::tags::Ix::SetVigil.tag(), 0x58, 0x02],
            accounts: vec![
                ([0x77; 32], true),
                (PAYER_K, true),
                (SEASON_K, false),
                (citizen, true),
            ],
        }
    }

    /// OpenRing(5): writes the Frontier.
    fn open_ring_ix(index: usize) -> Ix {
        let mut accounts = vec![
            (PAYER_K, true),
            (SEASON_K, false),
            (FRONTIER_K, true),
            ([0x66; 32], true),
        ];
        accounts.extend((0..6u8).map(|w| ([0x70 + w; 32], false)));
        accounts.push(([0; 32], false));
        Ix {
            index,
            data: frontier_abi::ix::OpenRing { d: 5 }.to_bytes().to_vec(),
            accounts,
        }
    }

    fn isolated(r: &TicketRoute, index: usize) -> bool {
        matches!(r, TicketRoute::Isolated(ix) if ix.index == index)
    }
    fn mixed(r: &TicketRoute) -> bool {
        matches!(r, TicketRoute::Mixed(_))
    }

    /// A TICKET is judged only from the one FileTicket of its citizen that
    /// stands alone in the transaction; a FileOutpost beside it, a second
    /// FileTicket of the citizen, another writer of the Citizen or the
    /// Frontier, or no top-level instruction is `MissingData` (never a
    /// silent skip, never a PASS); an outpost's own TICKET is V22's; a
    /// TICKET no filing accounts for is a FAIL. Other citizens' filings in
    /// the same transaction do not disturb an isolated one.
    #[test]
    fn tickets_are_attributed_by_instruction_evidence_and_mixed_transactions_never_pass() {
        let route = |ixs: &[Ix], c: &Key, n: usize| -> String {
            let r = route_ticket(ixs, c, &FRONTIER_K, n);
            match r {
                TicketRoute::Isolated(ix) => format!("isolated {}", ix.index),
                TicketRoute::Outpost => "outpost".into(),
                TicketRoute::Mixed(_) => "mixed".into(),
                TicketRoute::Fail(_) => "fail".into(),
            }
        };
        // the plain case stays checked
        assert!(isolated(
            &route_ticket(&[ticket_ix(0, CITIZEN_A)], &CITIZEN_A, &FRONTIER_K, 1),
            0
        ));
        // FileTicket + FileOutpost of the same citizen: never judged from the transaction's states
        assert!(mixed(&route_ticket(
            &[ticket_ix(0, CITIZEN_A), outpost_ix(1, CITIZEN_A)],
            &CITIZEN_A,
            &FRONTIER_K,
            2
        )));
        assert!(mixed(&route_ticket(
            &[outpost_ix(0, CITIZEN_A), ticket_ix(1, CITIZEN_A)],
            &CITIZEN_A,
            &FRONTIER_K,
            2
        )));
        // two FileTicket of the same citizen
        assert!(mixed(&route_ticket(
            &[ticket_ix(0, CITIZEN_A), ticket_ix(1, CITIZEN_A)],
            &CITIZEN_A,
            &FRONTIER_K,
            2
        )));
        // another citizen's filings beside it: A's is isolated, B's is its own
        let mixed_citizens = [
            ticket_ix(0, CITIZEN_A),
            outpost_ix(1, CITIZEN_B),
            ticket_ix(2, CITIZEN_B),
        ];
        assert_eq!(route(&mixed_citizens, &CITIZEN_A, 1), "isolated 0");
        assert_eq!(route(&mixed_citizens, &CITIZEN_B, 2), "mixed");
        let two_citizens = [ticket_ix(0, CITIZEN_A), ticket_ix(1, CITIZEN_B)];
        assert_eq!(route(&two_citizens, &CITIZEN_A, 1), "isolated 0");
        assert_eq!(route(&two_citizens, &CITIZEN_B, 1), "isolated 1");
        let outpost_only = [outpost_ix(0, CITIZEN_B), ticket_ix(1, CITIZEN_A)];
        assert_eq!(route(&outpost_only, &CITIZEN_B, 1), "outpost");
        assert_eq!(route(&outpost_only, &CITIZEN_A, 1), "isolated 1");
        // another writer of the Citizen (SetVigil) or of the Frontier (OpenRing)
        assert_eq!(
            route(
                &[ticket_ix(0, CITIZEN_A), vigil_ix(1, CITIZEN_A)],
                &CITIZEN_A,
                1
            ),
            "mixed"
        );
        assert_eq!(
            route(
                &[vigil_ix(0, CITIZEN_A), ticket_ix(1, CITIZEN_A)],
                &CITIZEN_A,
                1
            ),
            "mixed"
        );
        assert_eq!(
            route(
                &[ticket_ix(0, CITIZEN_A), vigil_ix(1, CITIZEN_B)],
                &CITIZEN_A,
                1
            ),
            "isolated 0"
        );
        assert_eq!(
            route(&[open_ring_ix(0), ticket_ix(1, CITIZEN_A)], &CITIZEN_A, 1),
            "mixed"
        );
        // no top-level instruction (an inner call): unverifiable; a record no filing accounts for: a FAIL
        assert_eq!(route(&[], &CITIZEN_A, 1), "mixed");
        assert_eq!(route(&[vigil_ix(0, CITIZEN_A)], &CITIZEN_A, 1), "fail");
        assert_eq!(route(&[ticket_ix(0, CITIZEN_B)], &CITIZEN_A, 1), "fail");
        // two TICKET records of one citizen for one FileTicket: a FAIL
        assert_eq!(route(&[ticket_ix(0, CITIZEN_A)], &CITIZEN_A, 2), "fail");
    }
}
