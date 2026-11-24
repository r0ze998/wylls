//! VWL, part 2 — the WIDE CLAIMS of a playable-lane season (Q16-1 = A
//! continued, 2026-11-19): the wide outpost ticket, re-run from the states
//! before it and compared byte for byte with what it wrote. The program's
//! handlers are `permutation-frontier` `proc/wide.rs` `claim_site_as`
//! (0xD9), `settle_ticket` (0xDC) and `finalize` (0xDF); the rules are the
//! shared models (`frontier_abi::world_index::{ticket, holding, land}`,
//! `frontier_abi::prologue`, `permutation_rules::frontier::holding`) and
//! this crate's own transcriptions of the program's helpers
//! (`proc/citizen.rs` `cohort_file`, `cohort_settle`,
//! `earlier_cohort_open`, `founded_outpost`, `write_holding`,
//! `shard_outposts`, `seed_of_bell`; `proc/holding.rs` the owner touch and
//! the `HARVEST` chain of the anchor; `proc/nation.rs` `mark_holding`).
//!
//! * **WideClaimSite (0xD9)** — the wallet form only (the NFT resident's
//!   form is WideResidentAct 0xDD, which the playable lane's program
//!   refuses for every Citizen: a V0 FAIL there, verifier-coverage):
//!   the player prologue (`frontier_abi::prologue::player_prologue`, steps
//!   1–2: the Season Running with the S1 ruleset, the Citizen at its
//!   address, the actor its wallet or session), this build's version, the
//!   end bell; the wide province present at its address, of this world;
//!   the record at the Citizen's ticket address absent or Settled (and the
//!   Citizen's, its lamports covering its escrow); no wide capture
//!   reservation; no wide marker; the marker's own refusals on a scratch
//!   copy; the slot the lowest free one; the anchor (slot 1, legacy, final,
//!   order 1, at the ref's generation, its province present and not
//!   capture-locked); for slot 3 the slot-2 holding final or due
//!   (`previous_final`); `may_found_outpost` with the program's inputs; the
//!   site below the count with a zero conquest record and readable
//!   terrain; the settler cost paid from the touched anchor. Written: the
//!   Citizen (bucket debit, `LAST_ACTION_TS`, the marker, the `HARVEST`
//!   link), the record (`WideTicket::file` / `refile`, its lamports the
//!   payer's top-up), the anchor (the touch, the cost, the `HARVEST`
//!   link), the wide province's cohort (`cohort_file`), and for slot 3 a
//!   due slot-2 flip.
//! * **WideSettleTicket (0xDC)**: the Season Running, this build's; the
//!   Citizen present at its address with its pending wide ticket
//!   (`pending_ticket`), `k = 0 = next`, the escrow covered; the province
//!   and holding at the ticket's addresses; the JoinShard canonical;
//!   expired at `bell + 24`; else the seed `S(bell, region)` from THE
//!   anchor's SeedCache (fields, address and round checked as the program
//!   does), the wide score, `final_ts`; fresh / displace / taken by the
//!   site's state and the held provisional holding of the same bell. A
//!   win: the holding founded from the record's escrow (a fresh one
//!   exactly one wide rent; a displacement rewritten in place at `gen + 1`,
//!   the rent paid to the displaced rent payer or diverted into its
//!   `pool_owed`), the site mirror, `n_sites_used`, `roster_epoch`, the
//!   JoinShard counters, the displaced Citizen unbound. Always: the
//!   Citizen's marker cleared (and the slot bound on a win), the cohort
//!   settled, the record Settled.
//! * **WideFinalize (0xDF)**: the Season Running, this build's; the wide
//!   holding at its address with its province present; provisional; due
//!   (`now ≥ final_ts` and the ticket's cohort closed). Written: the
//!   holding's state alone.
//!
//! What this part does **not** prove (beyond VWL's list): an archived bell
//! seed (`AnchorArchive`; `MissingData`), the payer's and the displaced
//! rent payer's lamports (not program accounts), the chain's rent rate
//! except from an exactly funded record (else `MissingData`), and the
//! season-end WideClose (VWL's for a ticket, a holding and a province,
//! `vwl_wide_close.rs`; VX's for the march records, verifier-coverage-2).

use frontier_abi::layout::beacon::{bell_anchor as BA, seed_cache as SC};
use frontier_abi::layout::player::{citizen as C, holding as H};
use frontier_abi::layout::province::{cohort as CO, province as PV, site as SM};
use frontier_abi::layout::{header as HDR, AccountKind};
use frontier_abi::log::{EntityKind, Kind};
use frontier_abi::v2::layout::player::{citizen as C2, holding as H2};
use frontier_abi::v2::layout::province::{conquest as CR, province as P2, site as SM2};
use frontier_abi::v2::layout::world::join_shard as JS2;
use frontier_abi::v2::layout::AccountKind as K2;
use frontier_abi::world_index::holding::{self as wh, SlotBinding, WideHolding};
use frontier_abi::world_index::land::Decision;
use frontier_abi::world_index::reach as wreach;
use frontier_abi::world_index::ticket::{
    self as wt, wide_ticket as WTL, CitizenTicket, TicketStatus, WideTicket,
};
use permutation_rules::frontier::beacon::{self as kb, WindowSchedule};
use permutation_rules::frontier::geometry::SITES_PER_PROVINCE;
use permutation_rules::frontier::holding::{may_found_outpost, OutpostCheck};
use permutation_rules::frontier::siege::held_since_hour_from;

use super::*;
use crate::holding as hr;

const T_SIZE: u64 = WTL::SIZE as u64;
const W_SIZE: u64 = wh::wide_holding::SIZE as u64;

pub(super) fn judged(cmd: &WideCommand) -> Option<&'static str> {
    match cmd {
        WideCommand::ClaimSite(_) => Some("WideClaimSite"),
        WideCommand::SettleTicket(_) => Some("WideSettleTicket"),
        WideCommand::Finalize(_) => Some("WideFinalize"),
        WideCommand::Close(x) => super::close::judged(x.what),
        c => super::economy::judged(c),
    }
}

// ------------------------------------------------------------ helpers

pub(super) fn rd_i64(d: &[u8], o: usize) -> i64 {
    le(d, o, 8) as i64
}

pub(super) fn arr32(d: &[u8], o: usize) -> [u8; 32] {
    d.get(o..o + 32)
        .and_then(|s| s.try_into().ok())
        .unwrap_or([0; 32])
}

pub(super) fn wr_i64(d: &mut [u8], o: usize, v: i64) {
    d[o..o + 8].copy_from_slice(&v.to_le_bytes());
}

fn wr_u16(d: &mut [u8], o: usize, v: u16) {
    d[o..o + 2].copy_from_slice(&v.to_le_bytes());
}

/// The chain's rent per byte, read from a record the program funded
/// exactly: a ticket record holds `rent(record) + escrow`; with an escrow
/// of one wide rent that is `(256 + 192 + 1344) × rate`, with none
/// `(128 + 192) × rate`.
pub(super) fn rate_of_record(lamports: u64, escrow: u64) -> Option<u64> {
    // `lamports = (128 + 192) × rate + escrow`, the escrow 0 or one wide
    // rent `(128 + 1344) × rate`.
    let own = 128 + T_SIZE;
    let rest = lamports.checked_sub(escrow)?;
    if !rest.is_multiple_of(own) {
        return None;
    }
    let r = rest / own;
    (escrow == 0 || escrow == r * (128 + W_SIZE)).then_some(r)
}

/// A wide record of this season before the transaction (the program's
/// `*_at`): `Ok(None)` absent (archive or witness shows it absent);
/// `MissingData` when nothing is known of it.
pub(super) fn wide_before(e: &Env, k: &Key, what: &str) -> Result<Option<Account>, Wrong> {
    match e.acct_before(k) {
        Some(a) if !a.data.is_empty() && a.owner.to_bytes() != e.ctx.program => Err(fail(
            WIDE_ACCOUNTS,
            format!("{what} is not owned by the program (the program refuses BadAccount)"),
        )),
        Some(a) if !a.data.is_empty() => Ok(Some(a)),
        _ if e.known_before(k) || (e.snapshot.is_none() && e.w.has_post) => Ok(None),
        _ => Err(Missing(format!("{what}: the archive has no state before"))),
    }
}

pub(super) fn province_of(
    e: &Env,
    k: &Key,
    coord: WideCoord,
    world: WorldId,
) -> Result<(WideProvince, Vec<u8>), Wrong> {
    if *k != wl::province_address(&e.ctx, coord) {
        return Err(fail(
            WIDE_ACCOUNTS,
            "the wide province is not at its address",
        ));
    }
    let a = wide_before(e, k, "the wide province")?.ok_or_else(|| {
        fail(
            WIDE_ACCOUNTS,
            "the wide province is absent (the program refuses BadAccount)",
        )
    })?;
    let p = WideProvince::read(&a.data)
        .map_err(|er| fail(WIDE_ACCOUNTS, format!("the wide province: {er:?}")))?;
    if p.season_id != e.sid || p.world != world || p.coord != coord {
        return Err(fail(
            WIDE_ACCOUNTS,
            "the wide province is of another season, world or coordinate",
        ));
    }
    Ok((p, a.data))
}

pub(super) fn holding_rec(e: &Env, d: &[u8]) -> Result<WideHolding, Wrong> {
    let h = WideHolding::read(d)
        .map_err(|er| fail(WIDE_ACCOUNTS, format!("the wide holding: {er:?}")))?;
    if h.season_id != e.sid {
        return Err(fail(WIDE_ACCOUNTS, "the wide holding is of another season"));
    }
    Ok(h)
}

/// `cohort_file` (`proc/citizen.rs`).
fn cohort_file(pd: &mut [u8], now_bell: u32) -> Result<(), Wrong> {
    let mut free = None;
    for i in 0..PV::COHORTS_N {
        let o = PV::cohort(i);
        let (b, f, s) = (
            le(pd, o + CO::BELL, 4) as u32,
            le(pd, o + CO::FILED, 2) as u16,
            le(pd, o + CO::SETTLED, 2) as u16,
        );
        if b == now_bell && f > 0 {
            let nf = f
                .checked_add(1)
                .ok_or_else(|| fail(WIDE_RULE, "a cohort counter overflows"))?;
            wr_u16(pd, o + CO::FILED, nf);
            return Ok(());
        }
        if free.is_none() && CO::is_free(b, f, s, now_bell) {
            free = Some(o);
        }
    }
    let o = free.ok_or_else(|| {
        fail(
            WIDE_RULE,
            "every cohort record is open (the program refuses CohortFull)",
        )
    })?;
    pd[o..o + CO::SIZE].fill(0);
    wr_u32(pd, o + CO::BELL, now_bell);
    wr_u16(pd, o + CO::FILED, 1);
    Ok(())
}

/// `cohort_settle`.
fn cohort_settle(pd: &mut [u8], ticket_bell: u32) {
    for i in 0..PV::COHORTS_N {
        let o = PV::cohort(i);
        let (b, f, s) = (
            le(pd, o + CO::BELL, 4) as u32,
            le(pd, o + CO::FILED, 2) as u16,
            le(pd, o + CO::SETTLED, 2) as u16,
        );
        if b == ticket_bell && f > 0 && s < f {
            wr_u16(pd, o + CO::SETTLED, s + 1);
            return;
        }
    }
}

/// `earlier_cohort_open` (K9).
fn earlier_cohort_open(pd: &[u8], ticket_bell: u32, now_bell: u32) -> bool {
    (0..PV::COHORTS_N).any(|i| {
        let o = PV::cohort(i);
        let (b, f, s) = (
            le(pd, o + CO::BELL, 4) as u32,
            le(pd, o + CO::FILED, 2) as u16,
            le(pd, o + CO::SETTLED, 2) as u16,
        );
        f > 0 && b < ticket_bell && !CO::is_free(b, f, s, now_bell)
    })
}

/// The capture lock of a live Holding over its own province's mirror.
pub(super) fn capture_locked(pd: &[u8], hd: &[u8]) -> Result<(), Wrong> {
    if matches!(hd[H::STATE], H::STATE_PROVISIONAL | H::STATE_FINAL) {
        match frontier_abi::v2::prologue::capture_locked(pd, hd[H::SITE], hd[H::GEN]) {
            Some(false) => {}
            Some(true) => {
                return Err(fail(
                    WIDE_RULE,
                    "the holding is capture-locked (the program refuses CapturePending)",
                ))
            }
            None => return Err(fail(WIDE_ACCOUNTS, "the province's mirror does not read")),
        }
    }
    Ok(())
}

fn record_is_zero(pd: &[u8], site: u8) -> Result<(), Wrong> {
    let o = P2::record(site as usize);
    match pd.get(o..o + CR::SIZE) {
        Some(r) if r.iter().all(|b| *b == 0) => Ok(()),
        Some(_) => Err(fail(
            WIDE_RULE,
            "the site's conquest record is not zero (the program refuses SiegeBusy)",
        )),
        None => Err(fail(WIDE_ACCOUNTS, "the province is short")),
    }
}

/// One event-chain link: `seq + 1`, `head = H(head ‖ seq ‖ body)`.
fn advance(d: &mut [u8], entity: EntityKind, body: &[u8]) -> Result<(), Wrong> {
    let seq = le(d, HDR::EVENT_SEQ, 8);
    let head = arr32(d, HDR::EVENT_HEAD);
    let l = frontier_abi::log::advance(entity, seq, &head, body)
        .ok_or_else(|| fail(WIDE_RULE, "an event chain overflows"))?;
    wr_u64(d, HDR::EVENT_SEQ, l.seq);
    d[HDR::EVENT_HEAD..HDR::EVENT_HEAD + 32].copy_from_slice(&l.head);
    Ok(())
}

fn pqs_key(p: i16, q: i16, site: u8) -> [u8; 9] {
    let mut k = [0u8; 9];
    k[..4].copy_from_slice(&(p as i32).to_le_bytes());
    k[4..8].copy_from_slice(&(q as i32).to_le_bytes());
    k[8] = site;
    k
}

/// The state (and due flip) of a wide holding over its province
/// (`wide_finality_due`).
pub(super) fn finality_due(hd: &[u8], pd: &[u8], now: i64, now_bell: u32) -> (u8, bool) {
    let hh = frontier_abi::prologue::HoldingHdr {
        p: 0,
        q: 0,
        site: hd[H::SITE],
        gen: hd[H::GEN],
        state: hd[H::STATE],
        ticket_bell: le(hd, H::TICKET_BELL, 4) as u32,
        final_ts: rd_i64(hd, H::FINAL_TS),
    };
    (
        hh.state,
        frontier_abi::prologue::finality_due(&hh, pd, now, now_bell),
    )
}

fn holding_tier(v: u8) -> Result<Tier, Wrong> {
    Ok(match v {
        0 => Tier::Hamlet,
        1 => Tier::Town,
        2 => Tier::City,
        3 => Tier::Stronghold,
        _ => return Err(fail(WIDE_ACCOUNTS, format!("tier byte {v}"))),
    })
}

fn tkt(er: wt::TicketError) -> Wrong {
    use wt::TicketError as E;
    match er {
        E::TicketOpen | E::NoWideTicket | E::SlotTaken(_) | E::SlotReserved(_) => fail(
            WIDE_RULE,
            format!("the ticket model refuses ({er:?}; the program refuses TicketState)"),
        ),
        _ => fail(WIDE_RULE, format!("the ticket model refuses ({er:?})")),
    }
}

fn hld(er: wh::HoldingError) -> Wrong {
    fail(WIDE_RULE, format!("the holding model refuses ({er:?})"))
}

fn h_err(er: String) -> Wrong {
    fail(WIDE_RULE, format!("the holding kernel refuses ({er})"))
}

// ------------------------------------------------------------ 0xD9

pub(super) fn claim_site(e: &Env, ix: &Ix, x: &wix::ClaimSite) -> Result<Vec<(Key, Lam)>, Wrong> {
    // Twelve positions, or thirteen with the reach witness (expansion-
    // gameplay-1, `world_index::reach`).
    let witness = match ix.accounts.len() {
        12 => None,
        13 => {
            writable(ix, 12, "the reach witness", false)?;
            Some(ix.accounts[12].0)
        }
        n => {
            return Err(fail(
                UNDECODABLE,
                format!("WideClaimSite with {n} accounts (the program takes 12 or 13)"),
            ))
        }
    };
    let k = |i: usize| ix.accounts[i].0;
    let (citizen, frontier, province, record) = (k(3), k(4), k(5), k(6));
    let (anchor_k, anchor_prov, prev_k, prev_prov) = (k(7), k(8), k(9), k(10));
    for (i, w, what) in [
        (5, true, "the wide province"),
        (6, true, "the ticket record"),
        (7, true, "the anchor"),
        (9, true, "the previous holding"),
    ] {
        writable(ix, i, what, w)?;
    }
    // 1. the player prologue (steps 1–2), this build's Season, the end bell
    let sk = e.ctx.season;
    if k(2) != sk {
        return Err(fail(
            WIDE_ACCOUNTS,
            "the third account is not this season's Season",
        ));
    }
    let sd = e.before(&sk, "the Season")?.data;
    let mut cd = e.before(&citizen, "the Citizen")?.data;
    let start = {
        let (a0, a1) = (k(0), k(1));
        let views = [
            signed(e, &a0, &[], ix.accounts[0].1),
            signed(e, &a1, &[], ix.accounts[1].1),
            signed(e, &sk, &sd, ix.accounts[2].1),
            signed(e, &citizen, &cd, ix.accounts[3].1),
        ];
        frontier_abi::prologue::player_prologue(
            &views,
            &e.ctx.program,
            &RULESET_HASH_V3,
            e.now,
            true,
        )
        .map_err(|er| {
            fail(
                WIDE_ACCOUNTS,
                format!("the player prologue refuses ({er:?})"),
            )
        })?
    };
    e.season_at(ix, 2, &[S::STATUS_RUNNING])?;
    let hdr = start.season;
    let now_bell = hdr
        .bell(e.now)
        .ok_or_else(|| fail(WIDE_RULE, "before genesis"))?;
    if now_bell >= hdr.end_bell {
        return Err(fail(
            WIDE_RULE,
            "at or after the end bell (the program refuses WrongStatus)",
        ));
    }
    // 2. the land
    let coord =
        WideCoord::checked(x.p, x.q).map_err(|_| fail(WIDE_RULE, "not a canonical coordinate"))?;
    if coord.ring() < wl::FIRST_WIDE_RING {
        return Err(fail(WIDE_RULE, "the coordinate is not past the disk"));
    }
    let world = e.world()?;
    let (_prov, pd) = province_of(e, &province, coord, world)?;
    if x.site as usize >= SITES_PER_PROVINCE {
        return Err(fail(WIDE_RULE, "site ≥ 12"));
    }
    if record != wt::ticket_address(&e.ctx, &citizen) {
        return Err(fail(
            WIDE_ACCOUNTS,
            "the ticket record is not at the Citizen's address",
        ));
    }
    let rec_before = wide_before(e, &record, "the ticket record")?;
    let retained = match &rec_before {
        None => None,
        Some(a) => {
            let r = WideTicket::read(&a.data)
                .map_err(|er| fail(WIDE_ACCOUNTS, format!("the ticket record: {er:?}")))?;
            if r.season_id != e.sid || r.world != world {
                return Err(fail(
                    WIDE_ACCOUNTS,
                    "the ticket record is of another season or world",
                ));
            }
            if r.status == TicketStatus::Open {
                return Err(fail(
                    WIDE_RULE,
                    "a pending wide ticket (the program refuses TicketState)",
                ));
            }
            if r.citizen != citizen {
                return Err(fail(
                    WIDE_ACCOUNTS,
                    "the ticket record names another Citizen",
                ));
            }
            Some((r, a.lamports))
        }
    };
    // 3. the Citizen
    let slots = cd[C2::SLOTS];
    if frontier_abi::world_index::conquest::has_wide_reservations(slots)
        .map_err(|_| fail(WIDE_ACCOUNTS, "the Citizen's slots do not read"))?
    {
        return Err(fail(
            WIDE_RULE,
            "a wide capture reservation (the program refuses TicketState)",
        ));
    }
    if matches!(
        wt::pending(&cd).map_err(|_| fail(WIDE_ACCOUNTS, "the Citizen's ticket does not read"))?,
        CitizenTicket::Wide { .. }
    ) {
        return Err(fail(
            WIDE_ACCOUNTS,
            "a wide marker over an absent or Settled record",
        ));
    }
    let (faction, holdings_n, flags) = (cd[C::FACTION], cd[C::HOLDINGS_N], cd[C::FLAGS]);
    let bindings = wh::bindings_of(&cd).map_err(hld)?;
    let gen_of =
        |s: u8| cd[C2::holding_of_slot(s) + frontier_abi::layout::player::holding_ref::GEN];
    let (gen2, gen3) = (gen_of(2), gen_of(3));
    {
        let mut scratch = cd.clone();
        wt::mark(&mut scratch, now_bell, x.slot).map_err(tkt)?;
    }
    if C2::lowest_free_slot(slots, gen2, gen3) != Some(x.slot) {
        return Err(fail(
            WIDE_RULE,
            "not the lowest free slot (the program refuses TicketState)",
        ));
    }
    // 4. the anchor
    let SlotBinding::Legacy(home) = bindings[0] else {
        return Err(fail(
            WIDE_RULE,
            "no legacy first home (the program refuses OutpostRule)",
        ));
    };
    if anchor_k != e.ctx.holding(home.p as i32, home.q as i32, home.site) {
        return Err(fail(
            WIDE_ACCOUNTS,
            "the anchor is not the first home's address",
        ));
    }
    let ad = e.before(&anchor_k, "the anchor")?.data;
    let ah =
        frontier_abi::prologue::check_holding(&e.view(&anchor_k, &ad), &e.ctx, e.sid, &citizen)
            .map_err(|er| fail(WIDE_ACCOUNTS, format!("the anchor ({er:?})")))?;
    if ah.gen != home.gen {
        return Err(fail(WIDE_RULE, "the anchor's generation is not the ref's"));
    }
    if ah.state != H::STATE_FINAL {
        return Err(fail(
            WIDE_RULE,
            "the anchor is not final (the program refuses NotFinal)",
        ));
    }
    if ad[H::ORDER] != 1 {
        return Err(fail(
            WIDE_RULE,
            "the anchor is not order 1 (the program refuses OutpostRule)",
        ));
    }
    if anchor_prov != e.ctx.province(ah.p as i32, ah.q as i32) {
        return Err(fail(
            WIDE_ACCOUNTS,
            "the anchor's province is not at its address",
        ));
    }
    let apd = e.before(&anchor_prov, "the anchor's province")?.data;
    if frontier_abi::v2::prologue::check_present_v2(
        &e.view(&anchor_prov, &apd),
        &e.ctx.program,
        K2::Province,
        e.sid,
    )
    .is_err()
    {
        return Err(fail(
            WIDE_ACCOUNTS,
            "the anchor's province is not a v2 Province of this season",
        ));
    }
    capture_locked(&apd, &ad)?;
    let mut h = hr::read(&ad).map_err(h_err)?;
    hr::touch(&mut h, e.now, hr::terrain_ore(&ad).map_err(h_err)?).map_err(h_err)?;
    let cq = ConquestParams::of_season(&sd)
        .ok_or_else(|| fail(WIDE_ACCOUNTS, "the Season's conquest block does not decode"))?;
    let tier_min = holding_tier(cq.outpost_tier_min)?;
    let (slot2_final, flip_prev) = if x.slot == 3 {
        previous_final(
            e,
            world,
            &citizen,
            bindings[1],
            &prev_k,
            &prev_prov,
            now_bell,
        )?
    } else {
        if prev_k != anchor_k || prev_prov != anchor_prov {
            return Err(fail(
                WIDE_ACCOUNTS,
                "a slot-2 claim names a previous pair other than the anchor's",
            ));
        }
        (false, false)
    };
    // 5. the outpost entitlement
    let fd = e
        .legacy(
            &frontier,
            &e.ctx.frontier(),
            AccountKind::Frontier,
            "the Frontier",
        )?
        .data;
    let open_sites = le(&fd, FR::OPEN_SITES, 4);
    let occupied = le(&fd, FR::OCCUPIED_SITES, 4);
    let anchor_coord = WideCoord::checked(home.p as i64, home.q as i64)
        .map_err(|_| fail(WIDE_RULE, "the anchor's coordinate"))?;
    // T-6 (territory-impl, #209): in a territory world the 13th account is
    // the target's territory record (never a reach witness), the site's
    // tile must be the claimer's, and ownership is the reach: neither the
    // range nor #206's share rule applies (`proc/wide.rs` claim_site_as).
    let territory = wl::territory_rule_of(&pd).ok_or_else(|| {
        fail(
            WIDE_ACCOUNTS,
            "the wide province's territory byte (the program refuses BadAccount)",
        )
    })?;
    let (range, (mine, total)) = if territory.is_some() {
        let rk = witness.ok_or_else(|| {
            fail(
                UNDECODABLE,
                "WideClaimSite in a territory world without the territory record (the program refuses TooManyAccounts)",
            )
        })?;
        super::territory::require_own_site(e, world, coord, &rk, &pd, x.site, &cd)?;
        (0, (0, 0))
    } else {
        // The reach witness (`proc/wide.rs` reach_witness_distance): a wide
        // province of this season and world at its address, the claimer's
        // nation's land, else the program refuses (BadAccount / OutpostRule).
        let witness_distance = match witness {
            None => None,
            Some(wk) => Some(nation_land_witness(e, &wk, world, faction, now_bell)?.distance(coord)),
        };
        (
            u32::try_from(wreach::claim_range(
                anchor_coord.distance(coord),
                witness_distance,
            ))
            .unwrap_or(u32::MAX),
            crate::checks::v22_outposts::province_weights(&pd, faction, now_bell)
                .map_err(|er| fail(WIDE_ACCOUNTS, format!("the province's weights: {er}")))?,
        )
    };
    may_found_outpost(&OutpostCheck {
        slot: Some(x.slot),
        first_final: flags & C::FLAG_FIRST_HOLDING_FINAL != 0,
        first_tier: h.tier,
        tier_min,
        slot2_final,
        target_ring: u32::try_from(coord.ring()).unwrap_or(u32::MAX),
        heartland_max_ring: cq.heartland_max_ring,
        range,
        outpost_range: cq.outpost_range,
        faction_weight: mine,
        province_weight: total,
        outpost_share_bps: cq.outpost_share_bps,
        free_sites: open_sites.saturating_sub(occupied),
        open_sites,
        now_bell,
        end_bell: hdr.end_bell,
        outpost_close_bells: cq.outpost_close_bells,
    })
    .map_err(|er| fail(WIDE_RULE, format!("the outpost rule refuses ({er:?})")))?;
    // 6. the site, the settler cost, the rents
    if x.site >= pd[PV::SITE_COUNT] {
        return Err(fail(WIDE_RULE, "the site is past the province's count"));
    }
    record_is_zero(&pd, x.site)?;
    hr::site_terrain_ore(&pd, pd[PV::SITES + x.site as usize]).map_err(h_err)?;
    let cost = hr::settler_cost(holdings_n)
        .ok_or_else(|| fail(WIDE_RULE, "the settler cost overflows"))?;
    h.pay(e.now, &cost).map_err(|er| {
        fail(
            WIDE_RULE,
            format!(
                "the anchor cannot pay the settler cost ({er:?}; the program refuses Insufficient)"
            ),
        )
    })?;
    // The rent rate, from the record (a first filing: what it was funded
    // with; a refile: the retained record).
    let rec_after = e.after(&record, "the ticket record")?;
    let rate = match &retained {
        None => {
            let base = rec_before_lamports(e, &record);
            let full = 256 + T_SIZE + W_SIZE;
            (base == 0 && rec_after.lamports.is_multiple_of(full)).then(|| rec_after.lamports / full)
        }
        Some((r, l)) => rate_of_record(*l, r.escrow),
    }
    .ok_or_else(|| Missing("the chain's rent: the ticket record is not exactly funded, so its rent rate cannot be read".into()))?;
    let rent_record = rate * (128 + T_SIZE);
    let rent_w = rate * (128 + W_SIZE);
    let (rec, top) = match &retained {
        None => (
            WideTicket::file(
                world,
                e.sid,
                citizen,
                coord,
                x.site,
                x.slot,
                now_bell,
                k(1),
                rent_w,
            )
            .map_err(tkt)?,
            None,
        ),
        Some((kept, l)) => {
            if *l < rent_record + kept.escrow {
                return Err(fail(
                    WIDE_ACCOUNTS,
                    "the retained record does not cover its escrow",
                ));
            }
            let (r, top) = kept
                .refile(coord, x.site, x.slot, now_bell, k(1), rent_w)
                .map_err(tkt)?;
            (r, Some((*l, top)))
        }
    };
    // ---- the writes
    // The record.
    let mut rw = vec![0u8; WTL::SIZE];
    rec.write(&mut rw)
        .map_err(|er| fail(WIDE_ACCOUNTS, format!("the record's bytes: {er:?}")))?;
    let got = expect_after(e, &record, &rw, "the ticket record")?;
    let want_l = match top {
        None => rent_record + rent_w,
        Some((l, top)) => l + top,
    };
    lamports_are(got.lamports, want_l, "the ticket record")?;
    // The Citizen: the bucket, the action time, the marker.
    start
        .finish(&mut cd, e.now)
        .map_err(|er| fail(WIDE_RULE, format!("the bucket refuses ({er:?})")))?;
    wr_i64(&mut cd, C::LAST_ACTION_TS, e.now);
    wt::mark(&mut cd, now_bell, x.slot).map_err(tkt)?;
    // The anchor: the touch and the cost.
    let mut adw = ad.clone();
    hr::write(&mut adw, &h, e.now).map_err(h_err)?;
    let digest = hr::stores_digest(&adw).map_err(h_err)?;
    // The province's cohort.
    let mut pdw = pd.clone();
    cohort_file(&mut pdw, now_bell)?;
    // HARVEST, chaining the Citizen and the anchor.
    let mut body = [0u8; 800];
    let n = frontier_abi::log::write_body(
        Kind::HARVEST,
        now_bell,
        &pqs_key(ah.p, ah.q, ah.site),
        &digest,
        &mut body,
    )
    .ok_or_else(|| fail(WIDE_RULE, "the HARVEST record's widths"))?;
    advance(&mut cd, EntityKind::Citizen, &body[..n])?;
    advance(&mut adw, EntityKind::Holding, &body[..n])?;
    expect_after(e, &citizen, &cd, "the Citizen")?;
    expect_after(e, &anchor_k, &adw, "the anchor")?;
    expect_after(e, &province, &pdw, "the wide province")?;
    let mut wrote = vec![
        (record, Lam::Checked),
        (citizen, Lam::Same),
        (anchor_k, Lam::Same),
        (province, Lam::Same),
    ];
    if flip_prev {
        let mut p = e.before(&prev_k, "the slot-2 holding")?.data;
        p[H::STATE] = H::STATE_FINAL;
        expect_after(e, &prev_k, &p, "the slot-2 holding")?;
        wrote.push((prev_k, Lam::Same));
    }
    Ok(wrote)
}

/// `reach_witness_distance`'s checks (`proc/wide.rs`): the reach witness
/// is a wide province of this season and world at its address, the
/// claimer's nation's land, else the program refuses (BadAccount /
/// OutpostRule). Returns its coordinate. (Read-only: the caller checks the
/// account's writability.)
pub(super) fn nation_land_witness(
    e: &Env,
    wk: &Key,
    world: WorldId,
    faction: u8,
    now_bell: u32,
) -> Result<WideCoord, Wrong> {
    let a = wide_before(e, wk, "the reach witness")?.ok_or_else(|| {
        fail(
            WIDE_ACCOUNTS,
            "the reach witness is absent (the program refuses BadAccount)",
        )
    })?;
    let wp = WideProvince::read(&a.data).map_err(|er| {
        fail(
            WIDE_ACCOUNTS,
            format!("the reach witness: {er:?} (the program refuses BadAccount)"),
        )
    })?;
    if wp.season_id != e.sid || wp.world != world || *wk != wl::province_address(&e.ctx, wp.coord)
    {
        return Err(fail(
            WIDE_ACCOUNTS,
            "the reach witness is not this world's wide province at its address",
        ));
    }
    let (w_mine, _) = crate::checks::v22_outposts::province_weights(&a.data, faction, now_bell)
        .map_err(|er| fail(WIDE_ACCOUNTS, format!("the reach witness's weights: {er}")))?;
    let keep = frontier_abi::conquest_model::read_keep(&a.data)
        .map_err(|_| fail(WIDE_ACCOUNTS, "the reach witness's keep"))?;
    if !wreach::is_nation_land(faction, w_mine, keep.as_ref()) {
        return Err(fail(
            WIDE_RULE,
            "the reach witness is not the nation's land (the program refuses OutpostRule)",
        ));
    }
    Ok(wp.coord)
}

fn rec_before_lamports(e: &Env, k: &Key) -> u64 {
    e.acct_before(k).map(|a| a.lamports).unwrap_or(0)
}

/// A view of an account of the player prologue. Signatures are the
/// runtime's (a transaction that landed carried them), so every position
/// reads as signed; writability is the message's.
pub(super) fn signed<'b>(e: &'b Env, key: &'b Key, data: &'b [u8], w: bool) -> AccountView<'b> {
    AccountView {
        key,
        owner: &e.ctx.program,
        lamports: 1,
        data,
        is_signer: true,
        is_writable: w,
    }
}

/// `previous_final` (`proc/wide.rs`): `(final, flip)`.
fn previous_final(
    e: &Env,
    world: WorldId,
    citizen: &Key,
    binding: SlotBinding,
    prev: &Key,
    prev_prov: &Key,
    now_bell: u32,
) -> Result<(bool, bool), Wrong> {
    match binding {
        SlotBinding::Legacy(r) => {
            if *prev != e.ctx.holding(r.p as i32, r.q as i32, r.site) {
                return Err(fail(
                    WIDE_ACCOUNTS,
                    "the slot-2 holding is not at its ref's address",
                ));
            }
            let hd = e.before(prev, "the slot-2 holding")?.data;
            let ph =
                frontier_abi::prologue::check_holding(&e.view(prev, &hd), &e.ctx, e.sid, citizen)
                    .map_err(|er| fail(WIDE_ACCOUNTS, format!("the slot-2 holding ({er:?})")))?;
            if ph.gen != r.gen || hd[H::ORDER] != 2 {
                return Err(fail(
                    WIDE_RULE,
                    "the slot-2 holding is not the ref's (the program refuses NotOwner)",
                ));
            }
            if *prev_prov != e.ctx.province(ph.p as i32, ph.q as i32) {
                return Err(fail(
                    WIDE_ACCOUNTS,
                    "the slot-2 province is not at its address",
                ));
            }
            let pd = e.before(prev_prov, "the slot-2 province")?.data;
            if frontier_abi::v2::prologue::check_present_v2(
                &e.view(prev_prov, &pd),
                &e.ctx.program,
                K2::Province,
                e.sid,
            )
            .is_err()
            {
                return Err(fail(WIDE_ACCOUNTS, "the slot-2 province is not present"));
            }
            capture_locked(&pd, &hd)?;
            Ok((ph.state == H::STATE_FINAL, false))
        }
        SlotBinding::Wide => {
            let hd = wide_before(e, prev, "the slot-2 holding")?
                .ok_or_else(|| fail(WIDE_ACCOUNTS, "the slot-2 holding is absent"))?
                .data;
            let rec = holding_rec(e, &hd)?;
            if rec.world != world || rec.slot != 2 || rec.owner_citizen != *citizen {
                return Err(fail(
                    WIDE_RULE,
                    "the slot-2 holding is not this Citizen's (the program refuses NotOwner)",
                ));
            }
            if *prev != wh::holding_address(&e.ctx, rec.coord, rec.site) {
                return Err(fail(
                    WIDE_ACCOUNTS,
                    "the slot-2 holding is not at its address",
                ));
            }
            let (_p, pd) = province_of(e, prev_prov, rec.coord, world)?;
            capture_locked(&pd, &hd)?;
            let (state, due) = finality_due(&hd, &pd, e.now, now_bell);
            Ok((
                state == H::STATE_FINAL || due,
                due && state != H::STATE_FINAL,
            ))
        }
        SlotBinding::Empty => Ok((false, false)),
    }
}

// ------------------------------------------------------------ 0xDC

/// THE anchor's seed of `(bell, region)` and its round (`seed_of_bell`,
/// the SeedCache form; an archived seed is `MissingData`).
pub(super) fn seed_of_bell(
    e: &Env,
    sd: &[u8],
    seed_k: &Key,
    anchor_k: &Key,
    bell: u32,
    region: u8,
) -> Result<([u8; 32], u64), Wrong> {
    let part = frontier_abi::addr::archive_part_of(bell);
    if *seed_k == e.ctx.anchor_archive(region, part) {
        return Err(Missing(
            "the ticket bell's seed is read from an AnchorArchive, which this check does not model"
                .into(),
        ));
    }
    if *anchor_k != e.ctx.bell_anchor(bell, region) {
        return Err(fail(WIDE_ACCOUNTS, "the bell anchor is not at its address"));
    }
    let an = match e.acct_before(anchor_k) {
        Some(a)
            if a.owner.to_bytes() == e.ctx.program
                && e.present(anchor_k, &a.data, AccountKind::BellAnchor) =>
        {
            a.data
        }
        Some(_) => {
            return Err(fail(
                WIDE_ACCOUNTS,
                "the bell anchor is not a BellAnchor of this season",
            ))
        }
        None if e.known_before(anchor_k) => {
            return Err(fail(
                WIDE_RULE,
                "no bell anchor (the program refuses NoAnchor)",
            ))
        }
        None => {
            return Err(Missing(
                "the bell anchor: the archive has no state before".into(),
            ))
        }
    };
    if le(&an, BA::BELL, 4) as u32 != bell || an[BA::REGION] != region {
        return Err(fail(
            WIDE_ACCOUNTS,
            "the bell anchor is of another bell or region",
        ));
    }
    let a_ts = rd_i64(&an, BA::A);
    let cache = match e.acct_before(seed_k) {
        Some(a)
            if a.owner.to_bytes() == e.ctx.program
                && e.present(seed_k, &a.data, AccountKind::SeedCache) =>
        {
            a.data
        }
        Some(_) => {
            return Err(fail(
                WIDE_ACCOUNTS,
                "the seed account is not a SeedCache of this season",
            ))
        }
        None if e.known_before(seed_k) => {
            return Err(fail(
                WIDE_RULE,
                "no seed cache (the program refuses SeedNotReady)",
            ))
        }
        None => {
            return Err(Missing(
                "the seed cache: the archive has no state before".into(),
            ))
        }
    };
    if *seed_k != e.ctx.seed_cache(bell, region, cache[SC::NONCE]) {
        return Err(fail(WIDE_ACCOUNTS, "the seed cache is not at its address"));
    }
    let clock = BeaconClock {
        genesis: le(sd, S::DRAND_GENESIS, 8) as i64,
        period: le(sd, S::DRAND_PERIOD, 4) as i64,
    };
    let sched = WindowSchedule {
        reveal_window: le(sd, S::REVEAL_WINDOW, 4) as u32,
        window_next: le(sd, S::WINDOW_NEXT, 4) as u32,
        window_from_bell: le(sd, S::WINDOW_FROM_BELL, 4) as u32,
    };
    let round = kb::seed_round(
        &clock,
        kb::reveal_close(a_ts, kb::window(&sched, bell)),
        le(sd, S::SEED_MARGIN, 4) as u32,
    );
    if le(&cache, SC::BELL, 4) as u32 != bell
        || cache[SC::REGION] != region
        || arr32(&cache, SC::ANCHOR_KEY) != *anchor_k
        || rd_i64(&cache, SC::A) != a_ts
        || le(&cache, SC::ROUND, 8) != round
    {
        return Err(fail(
            WIDE_ACCOUNTS,
            "the seed cache does not agree with THE anchor",
        ));
    }
    Ok((arr32(&cache, SC::SEED), round))
}

/// A program account's lamports after: the re-run's `want` from the
/// archived balance before. Lamports can reach any account by a system
/// transfer the archive (program transactions only) never shows, so more
/// than `want` is unknown (`MissingData`); fewer is a FAIL.
pub(super) fn lamports_are(got: u64, want: u64, what: &str) -> Result<(), Wrong> {
    match got.cmp(&want) {
        std::cmp::Ordering::Equal => Ok(()),
        std::cmp::Ordering::Less => Err(fail(
            WIDE_REPLAY_MISMATCH,
            format!("{what} holds {got} lamports, fewer than the re-run's {want}"),
        )),
        std::cmp::Ordering::Greater => Err(Missing(format!(
            "{what} holds {got} lamports, more than the re-run's {want}: lamports may have reached it outside program transactions"
        ))),
    }
}

const FRESH: u8 = 0;
const DISPLACE: u8 = 1;
const TAKEN: u8 = 2;
const EXPIRED: u8 = 3;

pub(super) fn settle_ticket(
    e: &Env,
    ix: &Ix,
    x: &wix::SettleTicket,
) -> Result<Vec<(Key, Lam)>, Wrong> {
    let n_disp = match ix.accounts.len() {
        10 => false,
        13 => true,
        n => {
            return Err(fail(
                UNDECODABLE,
                format!("WideSettleTicket with {n} accounts (the program takes 10 or 13)"),
            ))
        }
    };
    let k = |i: usize| ix.accounts[i].0;
    let (citizen, record, holding, province, shard, seed_k, anchor_k) =
        (k(2), k(3), k(4), k(5), k(6), k(7), k(8));
    for (i, what) in [
        (2, "the Citizen"),
        (3, "the ticket record"),
        (4, "the holding"),
        (5, "the wide province"),
        (6, "the JoinShard"),
    ] {
        writable(ix, i, what, true)?;
    }
    if *ix.accounts.last().map(|a| &a.0).unwrap_or(&[1; 32]) != SYSTEM {
        return Err(fail(
            WIDE_ACCOUNTS,
            "the last account is not the system program",
        ));
    }
    let sd = e.season(ix, &[S::STATUS_RUNNING])?;
    let genesis_ts = le(&sd, S::GENESIS_TS, 8) as i64;
    let now_bell = e.bell(&sd);
    let world = e.world()?;
    // The Citizen and its wide ticket.
    let mut cd = e.before(&citizen, "the Citizen")?.data;
    if !e.present(&citizen, &cd, AccountKind::Citizen) {
        return Err(fail(
            WIDE_ACCOUNTS,
            "the Citizen is not a Citizen of this season",
        ));
    }
    let tag15 = frontier_abi::resident_citizen::record_tag15(&cd)
        .ok_or_else(|| fail(WIDE_ACCOUNTS, "the Citizen's tag does not read"))?;
    if citizen != e.ctx.citizen_by_tag15(&tag15) {
        return Err(fail(WIDE_ACCOUNTS, "the Citizen is not at its address"));
    }
    let (bell_m, slot_m) = match wt::pending(&cd)
        .map_err(|_| fail(WIDE_ACCOUNTS, "the Citizen's ticket does not read"))?
    {
        CitizenTicket::None => {
            return Err(fail(WIDE_RULE, "no ticket (the program refuses NoTicket)"))
        }
        CitizenTicket::Legacy => {
            return Err(fail(
                WIDE_RULE,
                "a deployed ticket (the program refuses TicketState)",
            ))
        }
        CitizenTicket::Wide { bell, slot } => (bell, slot),
    };
    if record != wt::ticket_address(&e.ctx, &citizen) {
        return Err(fail(
            WIDE_ACCOUNTS,
            "the ticket record is not at the Citizen's address",
        ));
    }
    let ra = wide_before(e, &record, "the ticket record")?
        .ok_or_else(|| fail(WIDE_ACCOUNTS, "the ticket record is absent"))?;
    let rec = WideTicket::read(&ra.data)
        .map_err(|er| fail(WIDE_ACCOUNTS, format!("the ticket record: {er:?}")))?;
    if rec.season_id != e.sid
        || rec.world != world
        || rec.status != TicketStatus::Open
        || rec.citizen != citizen
        || rec.bell != bell_m
        || rec.slot != slot_m
    {
        return Err(fail(
            WIDE_ACCOUNTS,
            "the ticket record does not agree with the Citizen's marker",
        ));
    }
    let (faction, shard_i, my_tag) = (
        cd[C::FACTION],
        cd[C::JOIN_SHARD],
        le(&cd, C::CITIZEN_TAG, 8),
    );
    if x.k < rec.next {
        return Err(fail(
            WIDE_RULE,
            "k below the cursor (the program refuses AlreadyDone)",
        ));
    }
    if x.k != rec.next || x.k != 0 {
        return Err(fail(
            WIDE_RULE,
            "k is not the one site (the program refuses TicketState)",
        ));
    }
    let rate = rate_of_record(ra.lamports, rec.escrow).ok_or_else(|| {
        Missing("the chain's rent: the ticket record is not exactly funded, so its rent rate cannot be read".into())
    })?;
    let rent_w = rate * (128 + W_SIZE);
    let (coord, site, slot, ticket_bell) = (rec.coord, rec.site, rec.slot, rec.bell);
    let (prov, pd) = province_of(e, &province, coord, world)?;
    if holding != wh::holding_address(&e.ctx, coord, site) {
        return Err(fail(
            WIDE_ACCOUNTS,
            "the holding is not at the ticket's address",
        ));
    }
    let jd = e
        .legacy(
            &shard,
            &e.ctx.join_shard(faction, shard_i),
            AccountKind::JoinShard,
            "the JoinShard",
        )?
        .data;
    let cq = ConquestParams::of_season(&sd)
        .ok_or_else(|| fail(WIDE_ACCOUNTS, "the Season's conquest block does not decode"))?;
    let held_before = wide_before(e, &holding, "the holding")?;
    let expired = now_bell >= ticket_bell.saturating_add(PV::COHORT_BELLS);
    let (outcome, score, final_ts) = if expired {
        (EXPIRED, 0u64, 0i64)
    } else {
        let (seed, s_round) = seed_of_bell(e, &sd, &seed_k, &anchor_k, ticket_bell, prov.region)?;
        let score = wt::wide_ticket_score(&seed, coord, site, my_tag);
        let final_ts = kb::round_time(
            le(&sd, S::DRAND_GENESIS, 8) as i64,
            le(&sd, S::DRAND_PERIOD, 4) as u32,
            s_round,
        ) + 600;
        if site >= pd[PV::SITE_COUNT] {
            return Err(fail(
                WIDE_ACCOUNTS,
                "the ticket's site is past the province's count",
            ));
        }
        let state = pd[PV::site(site as usize) + SM::STATE];
        let free = matches!(state, SM::STATE_FREE | SM::STATE_RELEASED_FREE);
        if free && earlier_cohort_open(&pd, ticket_bell, now_bell) {
            return Err(fail(
                WIDE_RULE,
                "an earlier cohort is open (the program refuses TicketState)",
            ));
        }
        let outcome = if free {
            if held_before.is_some() {
                return Err(fail(
                    WIDE_ACCOUNTS,
                    "a free site with a holding record present",
                ));
            }
            FRESH
        } else if state == SM::STATE_HOLDING {
            let hd = held_before
                .as_ref()
                .ok_or_else(|| fail(WIDE_ACCOUNTS, "a held site without its holding record"))?;
            let held = holding_rec(e, &hd.data)?;
            if held.world != world || held.coord != coord || held.site != site {
                return Err(fail(
                    WIDE_ACCOUNTS,
                    "the holding is of another world or site",
                ));
            }
            let hdd = &hd.data;
            if hdd[H::STATE] == H::STATE_PROVISIONAL
                && le(hdd, H::TICKET_BELL, 4) as u32 == ticket_bell
                && displaces(
                    score,
                    my_tag,
                    le(hdd, H::TICKET_SCORE, 8),
                    frontier_abi::addr::citizen_tag(&held.owner_citizen),
                )
            {
                DISPLACE
            } else {
                TAKEN
            }
        } else {
            TAKEN
        };
        (outcome, score, final_ts)
    };
    if (outcome == DISPLACE) != n_disp {
        return Err(fail(UNDECODABLE, "the displacement accounts are listed exactly when it displaces (the program refuses TooManyAccounts)"));
    }
    let won = matches!(outcome, FRESH | DISPLACE);
    if won && rec.escrow < rent_w {
        return Err(fail(
            WIDE_RULE,
            "the escrow does not hold the wide rent (the program refuses Insufficient)",
        ));
    }
    let settled = rec.settle(if won { rent_w } else { 0 }).map_err(tkt)?;
    // The Citizen: the ticket bits cleared, then the slot bound on a win.
    wt::clear(&mut cd).map_err(tkt)?;
    if won {
        if cd[C2::SLOTS] & C2::reserved_bit(slot) != 0 {
            return Err(fail(WIDE_ACCOUNTS, "a reservation on the ticket's slot"));
        }
        wh::bind(&mut cd, slot).map_err(hld)?;
    }
    let mut pdw = pd.clone();
    let mut wrote = vec![
        (citizen, Lam::Same),
        (record, Lam::Checked),
        (province, Lam::Same),
    ];
    let mut rec_lamports = ra.lamports;
    let mut paid_to_program: Option<Key> = None;
    if won {
        record_is_zero(&pd, site)?;
        let o = PV::site(site as usize);
        let tile = pd[PV::SITES + site as usize];
        let was_free = pd[o + SM::STATE] != SM::STATE_HOLDING;
        let gen = pd[o + SM::GEN]
            .checked_add(1)
            .ok_or_else(|| fail(WIDE_RULE, "the site's generation overflows"))?;
        let ore = hr::site_terrain_ore(&pd, tile).map_err(h_err)?;
        let mut jdw = jd.clone();
        // The holding's bytes before the founding, and its lamports after.
        let (mut hdw, hold_lamports, pool_owed) = match outcome {
            FRESH => {
                let before = held_before.as_ref().map(|a| a.lamports).unwrap_or(0);
                (vec![0u8; wh::wide_holding::SIZE], before + rent_w, 0u64)
            }
            _ => {
                let old = held_before.as_ref().unwrap();
                let oldrec = holding_rec(e, &old.data)?;
                let (dp, dc, ds) = (k(9), k(10), k(11));
                if dp != arr32(&old.data, H::RENT_PAYER) {
                    return Err(fail(
                        WIDE_ACCOUNTS,
                        "the displaced rent payer is not the holding's",
                    ));
                }
                if dc != oldrec.owner_citizen {
                    return Err(fail(
                        WIDE_ACCOUNTS,
                        "the displaced Citizen is not the holding's owner",
                    ));
                }
                let mut dcd = e.before(&dc, "the displaced Citizen")?.data;
                if !e.present(&dc, &dcd, AccountKind::Citizen) {
                    return Err(fail(WIDE_ACCOUNTS, "the displaced Citizen is not present"));
                }
                let dsd = e
                    .legacy(
                        &ds,
                        &e.ctx.join_shard(dcd[C::FACTION], dcd[C::JOIN_SHARD]),
                        AccountKind::JoinShard,
                        "the displaced JoinShard",
                    )?
                    .data;
                wh::unbind(&mut dcd, oldrec.slot).map_err(hld)?;
                expect_after(e, &dc, &dcd, "the displaced Citizen")?;
                wrote.push((dc, Lam::Same));
                if ds == shard {
                    shard_outposts(&mut jdw, -1)?;
                } else {
                    let mut dsw = dsd.clone();
                    shard_outposts(&mut dsw, -1)?;
                    expect_after(e, &ds, &dsw, "the displaced JoinShard")?;
                    wrote.push((ds, Lam::Same));
                }
                // The record's wide rent: to the rent payer, or diverted
                // into the holding's pool_owed (`pay_or_divert`; the payer's
                // lamports are not in the archive, so the holding's own
                // `pool_owed` after tells which path ran, and its lamports
                // must follow).
                let got = e.after(&holding, "the holding")?;
                let owed0 = le(&old.data, H::POOL_OWED, 8);
                // A program-owned rent payer is in the archive: the
                // program never diverts to one (`pay_or_divert` diverts only
                // for a non-program recipient), so it must have received
                // exactly the wide rent.
                let dp_program = e
                    .acct_before(&dp)
                    .is_some_and(|a| a.owner.to_bytes() == e.ctx.program);
                let diverted = le(&got.data, H::POOL_OWED, 8) == owed0 + rent_w;
                if dp_program {
                    if diverted {
                        return Err(fail(
                            WIDE_REPLAY_MISMATCH,
                            "the rent was diverted although the displaced rent payer is a program account",
                        ));
                    }
                    let b = e.before(&dp, "the displaced rent payer")?.lamports;
                    let a = e.after(&dp, "the displaced rent payer")?.lamports;
                    lamports_are(a, b + rent_w, "the displaced rent payer")?;
                    if e.after(&dp, "the displaced rent payer")?.data
                        != e.before(&dp, "the displaced rent payer")?.data
                    {
                        return Err(fail(
                            WIDE_REPLAY_MISMATCH,
                            "the displaced rent payer's data changed",
                        ));
                    }
                    paid_to_program = Some(dp);
                }
                let (l, owed) = if diverted {
                    (old.lamports + rent_w, owed0 + rent_w)
                } else {
                    (old.lamports, owed0)
                };
                let mut d = old.data.clone();
                wr_u64(&mut d, H::POOL_OWED, owed);
                (d, l, owed)
            }
        };
        rec_lamports -= rent_w;
        let day = frontier_abi::addr::day_of(now_bell);
        let shield_until = hr::founding_shield(&cq, slot, e.now, genesis_ts)
            .ok_or_else(|| fail(WIDE_RULE, "the shield overflows"))?;
        // `founded_outpost` + `write_holding(Founding)`.
        let mut kh = permutation_rules::frontier::holding::Holding::found(e.now, day, slot);
        kh.production = hr::base_production(Tier::Hamlet, ore);
        kh.set_upkeep(
            e.now,
            permutation_rules::frontier::holding::Resource::Food,
            0,
        )
        .map_err(|er| fail(WIDE_RULE, format!("set_upkeep: {er:?}")))?;
        write_founding(
            &mut hdw,
            &kh,
            site,
            gen,
            tile,
            &citizen,
            score,
            faction,
            ticket_bell,
            &rec.funder,
            final_ts,
            pool_owed,
            shield_until,
            ore,
        );
        // S1 1e: an expelled village's holdings carry the flag.
        let f = hdw[H::FLAGS];
        hdw[H::FLAGS] = if le(&cd, C2::EXPELLED_SINCE, 8) != 0 {
            f | H2::FLAG_EXPELLED
        } else {
            f & !H2::FLAG_EXPELLED
        };
        WideHolding::found(
            world,
            e.sid,
            coord,
            site,
            gen,
            slot,
            citizen,
            &Decision::Decided(()),
        )
        .map_err(hld)?
        .write_identity(&mut hdw)
        .map_err(hld)?;
        let got = expect_after(e, &holding, &hdw, "the holding")?;
        lamports_are(got.lamports, hold_lamports, "the holding")?;
        // The site mirror and the province's counters.
        let shield_bell = bell_from(genesis_ts, shield_until);
        pdw[o..o + SM::SIZE].fill(0);
        pdw[o + SM::STATE] = SM::STATE_HOLDING;
        pdw[o + SM::FACTION] = faction;
        pdw[o + SM::ORDER] = slot;
        pdw[o + SM::TIER] = Tier::Hamlet as u8;
        pdw[o + SM::GEN] = gen;
        wr_u32(&mut pdw, o + SM::PEND0_BELL, SM::NO_BELL);
        wr_u32(&mut pdw, o + SM::PEND1_BELL, SM::NO_BELL);
        wr_u32(&mut pdw, o + SM::SHIELD_UNTIL_BELL, shield_bell);
        wr_u16(
            &mut pdw,
            o + SM2::HELD_SINCE_HOUR,
            held_since_hour_from(now_bell),
        );
        if was_free {
            pdw[PV::N_SITES_USED] = pdw[PV::N_SITES_USED]
                .checked_add(1)
                .ok_or_else(|| fail(WIDE_RULE, "n_sites_used overflows"))?;
        }
        let ep = le(&pdw, PV::ROSTER_EPOCH, 4) as u32;
        wr_u32(&mut pdw, PV::ROSTER_EPOCH, ep.wrapping_add(1));
        shard_outposts(&mut jdw, 1)?;
        expect_after(e, &shard, &jdw, "the JoinShard")?;
        wrote.push((holding, Lam::Checked));
        if let Some(dp) = paid_to_program {
            wrote.push((dp, Lam::Checked));
        }
        wrote.push((shard, Lam::Same));
    }
    cohort_settle(&mut pdw, ticket_bell);
    expect_after(e, &citizen, &cd, "the Citizen")?;
    expect_after(e, &province, &pdw, "the wide province")?;
    let mut tw = vec![0u8; WTL::SIZE];
    settled
        .write(&mut tw)
        .map_err(|er| fail(WIDE_ACCOUNTS, format!("the record's bytes: {er:?}")))?;
    let got = expect_after(e, &record, &tw, "the ticket record")?;
    lamports_are(got.lamports, rec_lamports, "the ticket record")?;
    Ok(wrote)
}

/// `displaces`: a better score, or an equal one with a lower tag.
const fn displaces(score: u64, tag: u64, held_score: u64, held_tag: u64) -> bool {
    score > held_score || (score == held_score && tag < held_tag)
}

/// The first bell starting at or after `t` (`bell_from`).
fn bell_from(genesis_ts: i64, t: i64) -> u32 {
    let dt = t.saturating_sub(genesis_ts).max(0);
    u32::try_from((dt + 599) / 600).unwrap_or(u32::MAX)
}

/// `shard_outposts`: `extra_holdings` and `outposts` `+= delta`.
fn shard_outposts(js: &mut [u8], delta: i32) -> Result<(), Wrong> {
    for off in [JS2::EXTRA_HOLDINGS, JS2::OUTPOSTS] {
        let v = le(js, off, 4) as u32;
        let nv = if delta >= 0 {
            v.checked_add(delta as u32)
                .ok_or_else(|| fail(WIDE_RULE, "a JoinShard counter overflows"))?
        } else {
            v.saturating_sub(delta.unsigned_abs())
        };
        wr_u32(js, off, nv);
    }
    Ok(())
}

/// `write_holding(Founding)` (`proc/citizen.rs`): everything after the
/// header zeroed, then the founding's fields (the wide record's P, Q are
/// 0; its identity is written afterwards).
#[allow(clippy::too_many_arguments)]
fn write_founding(
    d: &mut [u8],
    h: &permutation_rules::frontier::holding::Holding,
    site: u8,
    gen: u8,
    tile: u8,
    owner: &Key,
    score: u64,
    faction: u8,
    ticket_bell: u32,
    rent_payer: &Key,
    final_ts: i64,
    pool_owed: u64,
    shield_until: i64,
    ore: i64,
) {
    use frontier_abi::layout::player::accrual as AC;
    d[64..H::SIZE].fill(0);
    wr_u16(d, H::P, 0);
    wr_u16(d, H::Q, 0);
    d[H::SITE] = site;
    d[H::GEN] = gen;
    d[H::TILE] = tile;
    d[H::STATE] = H::STATE_PROVISIONAL;
    d[H::OWNER_CITIZEN..H::OWNER_CITIZEN + 32].copy_from_slice(owner);
    wr_u64(d, H::TICKET_SCORE, score);
    d[H::FACTION] = faction;
    d[H::ORDER] = h.order;
    d[H::TIER] = h.tier as u8;
    wr_u32(d, H::TICKET_BELL, ticket_bell);
    wr_i64(d, H::FOUNDED_TS, h.founded_ts);
    wr_u32(d, H::FOUNDED_DAY, h.founded_day);
    wr_i64(d, H::LAST_OWNER_ACTION, h.last_owner_action);
    wr_i64(d, H::SHIELD_UNTIL, shield_until);
    for r in 0..permutation_rules::frontier::holding::RESOURCES {
        let s = &h.stores[r];
        let o = H::store(r);
        wr_i64(d, o + AC::VALUE, s.value);
        wr_i64(d, o + AC::RATE, s.rate);
        wr_i64(d, o + AC::CAP, s.cap);
        wr_i64(d, o + AC::T0, s.t0);
        wr_i64(d, o + AC::FRAC, s.frac);
        wr_i64(d, H::PRODUCTION + 8 * r, h.production[r]);
        wr_i64(d, H::UPKEEP + 8 * r, h.upkeep[r]);
    }
    wr_u32(d, H::WALLS, h.walls);
    wr_i64(d, H::WALLS_COMMITTED_BEFORE, h.walls_committed_before);
    wr_i64(d, H::FOOD_SHORTFALL, h.food_shortfall);
    d[H::RENT_PAYER..H::RENT_PAYER + 32].copy_from_slice(rent_payer);
    wr_i64(d, H::FINAL_TS, final_ts);
    wr_i64(d, H2::TERRAIN_ORE, ore);
    wr_u64(d, H::POOL_OWED, pool_owed);
}

// ------------------------------------------------------------ 0xDF

pub(super) fn finalize(e: &Env, ix: &Ix) -> Result<Vec<(Key, Lam)>, Wrong> {
    n_accounts(ix, 4, "WideFinalize")?;
    let (holding, province) = (ix.accounts[2].0, ix.accounts[3].0);
    writable(ix, 2, "the holding", true)?;
    let sd = e.season(ix, &[S::STATUS_RUNNING])?;
    let now_bell = e.bell(&sd);
    let world = e.world()?;
    let hd = wide_before(e, &holding, "the holding")?
        .ok_or_else(|| {
            fail(
                WIDE_ACCOUNTS,
                "the holding is absent (the program refuses BadAccount)",
            )
        })?
        .data;
    let h = holding_rec(e, &hd)?;
    if h.world != world {
        return Err(fail(WIDE_ACCOUNTS, "the holding is of another world"));
    }
    if holding != wh::holding_address(&e.ctx, h.coord, h.site) {
        return Err(fail(WIDE_ACCOUNTS, "the holding is not at its address"));
    }
    let (_p, pd) = province_of(e, &province, h.coord, world)?;
    let (state, due) = finality_due(&hd, &pd, e.now, now_bell);
    if state != H::STATE_PROVISIONAL {
        return Err(fail(
            WIDE_RULE,
            "the holding is not provisional (the program refuses AlreadyDone)",
        ));
    }
    if !due {
        return Err(fail(
            WIDE_RULE,
            "finality is not due (the program refuses TooEarly)",
        ));
    }
    let mut w = hd.clone();
    w[H::STATE] = H::STATE_FINAL;
    expect_after(e, &holding, &w, "the holding")?;
    Ok(vec![(holding, Lam::Same)])
}
