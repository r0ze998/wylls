//! VWL, part 3 — the season-end **WideClose** (0xDE) of a playable-lane
//! season (Q16-1 = A continued, 2026-11-19): a wide ticket record
//! (`what = 0`), a wide holding (`what = 1`) and a wide province
//! (`what = 6`), re-run from the states before and compared with what the
//! transaction left. The program's handlers are `permutation-frontier`
//! `proc/wide.rs` `close_ticket`, `close_holding`, `close_province`, with
//! `season_end` / `map::season_end_close` and `init::{close_to,
//! move_lamports}`.
//!
//! * **The Season** (`season_end`): Ended with `now ≥ end + 72 h`
//!   (`TooEarly` before) or Aborted, the S1 ruleset, this build's version.
//!   The **Closed tombstone** (a 128-byte Season) is not modelled: a close
//!   over it is `MissingData`.
//! * **what = 0** `[any] [season] [citizen w] [wide_ticket w] [rent_payer
//!   w] ([funder w])`: the record at the ticket address of the Citizen
//!   position's key, present, of this season and world, naming that
//!   Citizen, its lamports covering its rent and escrow; the rent payer
//!   the record's; the funder listed exactly when the escrow is non-zero,
//!   and the record's. The Citizen position: absent (then the record must
//!   be Settled), or the Citizen present at its record address with either
//!   the wide marker of this Open record (cleared) or no wide marker
//!   beside a Settled record (unchanged). Written: the Citizen's marker
//!   when pending; the record **closed**.
//! * **what = 1** `[any] [season] [holding w] [rent_payer w] [dpool w]`:
//!   the wide holding at its address, of this season and world; the rent
//!   payer the holding's; the DefencePool at its address. Written: the
//!   DefencePool's lamports `+ pool_owed`, its data unchanged; the holding
//!   **closed**. A DefencePool that also took the holding's refund (the
//!   `pay_or_divert` divert for a rent payer left below rent exemption) is
//!   `MissingData`: the rent payer is not a program account, so its
//!   balance is not this check's to know.
//! * **what = 6** `[any] [season] [province w] [pfund w]`: the wide
//!   province at its address, of this season and world; the fund the one
//!   of the province's stored wedge, at its address. Written: the fund's
//!   lamports `+` the province's and `provinces_opened − 1` (saturating);
//!   the province **closed**.
//!
//! A closed account is absent after the transaction (no lamports, no
//! data). Where its lamports went is checked for program accounts only
//! (the DefencePool, the wedge fund); the rent payer's and the funder's
//! wallets are the runtime's (the transaction balanced, or it would not
//! have landed).
//!
//! **Not modelled** (still V0's `WideUnmodelled`): `what = 2..=5`, the
//! march records (arrival slot, arrival day, clash inputs, transit). They
//! exist only after a wide march, which this verifier does not judge.

use frontier_abi::layout::player::holding as H;
use frontier_abi::layout::world::defence_pool as DP;
use frontier_abi::layout::AccountKind;
use frontier_abi::world_index::holding as wh;
use frontier_abi::world_index::ticket::{self as wt, CitizenTicket, TicketStatus, WideTicket};

use super::claims::{arr32, holding_rec, lamports_are, rate_of_record, wide_before};
use super::*;

/// Seconds after the season's end before its closes (`map::END_GRACE_SECS`).
const END_GRACE_SECS: i64 = 72 * 3_600;

pub(super) fn judged(what: u8) -> Option<&'static str> {
    match what {
        wix::CLOSE_WHAT_TICKET => Some("WideClose(ticket)"),
        wix::CLOSE_WHAT_HOLDING => Some("WideClose(holding)"),
        wix::CLOSE_WHAT_PROVINCE => Some("WideClose(province)"),
        _ => None,
    }
}

pub(super) fn close(e: &Env, ix: &Ix, x: &wix::Close) -> Result<Vec<(Key, Lam)>, Wrong> {
    match x.what {
        wix::CLOSE_WHAT_TICKET => close_ticket(e, ix),
        wix::CLOSE_WHAT_HOLDING => close_holding(e, ix),
        wix::CLOSE_WHAT_PROVINCE => close_province(e, ix),
        _ => Ok(vec![]),
    }
}

/// `season_end` / `map::season_end_close`: Ended ≥ 72 h or Aborted, this
/// build's. `tombstone_ok`: the handler also closes over the Closed
/// tombstone, which this check does not model.
fn season_end(e: &Env, ix: &Ix, tombstone_ok: bool) -> Result<(), Wrong> {
    let k = ix
        .key(1)
        .ok_or_else(|| fail(UNDECODABLE, "no Season account"))?;
    if tombstone_ok
        && k == e.ctx.season
        && e.acct_before(&k).is_some_and(|a| {
            a.owner.to_bytes() == e.ctx.program && a.data.len() == S::TOMBSTONE_SIZE
        })
    {
        return Err(Missing(
            "the Season is the Closed tombstone: a close over it is not modelled".into(),
        ));
    }
    let sd = e.season(ix, &[S::STATUS_ENDED, S::STATUS_ABORTED])?;
    let hdr = frontier_abi::prologue::read_season(&e.view(&k, &sd), &e.ctx.program, e.now)
        .map_err(|er| fail(WIDE_ACCOUNTS, format!("the Season does not read ({er:?})")))?;
    if hdr.status == S::STATUS_ENDED {
        let at = hdr
            .genesis_ts
            .checked_add(600 * hdr.end_bell as i64)
            .and_then(|end| end.checked_add(END_GRACE_SECS))
            .ok_or_else(|| fail(WIDE_RULE, "the season's end overflows"))?;
        if e.now < at {
            return Err(fail(
                WIDE_RULE,
                format!(
                    "{} s before the season's end + 72 h (the program refuses TooEarly)",
                    at - e.now
                ),
            ));
        }
    }
    Ok(())
}

/// The account `k` is gone after the transaction: `close_to` frees its
/// data, assigns it to System and moves every lamport out.
fn expect_closed(e: &Env, k: &Key, what: &str) -> Result<(), Wrong> {
    match e.w.txs[e.tx].post.get(k) {
        None => Err(Missing(format!("{what}: the archive has no post-state"))),
        Some(None) => Ok(()),
        Some(Some(a)) if a.lamports == 0 && a.data.is_empty() => Ok(()),
        Some(Some(a)) => Err(fail(
            WIDE_REPLAY_MISMATCH,
            format!(
                "{what} was not closed: {} lamports and {} bytes remain",
                a.lamports,
                a.data.len()
            ),
        )),
    }
}

// ------------------------------------------------------------ what = 0

fn close_ticket(e: &Env, ix: &Ix) -> Result<Vec<(Key, Lam)>, Wrong> {
    let with_funder = match ix.accounts.len() {
        5 => false,
        6 => true,
        n => {
            return Err(fail(
                UNDECODABLE,
                format!("WideClose(ticket) with {n} accounts (the program takes 5 or 6)"),
            ))
        }
    };
    let k = |i: usize| ix.accounts[i].0;
    let (citizen, record, rent_payer) = (k(2), k(3), k(4));
    for (i, what) in [
        (2, "the Citizen position"),
        (3, "the ticket record"),
        (4, "the rent payer"),
    ] {
        writable(ix, i, what, true)?;
    }
    if with_funder {
        writable(ix, 5, "the funder", true)?;
    }
    season_end(e, ix, true)?;
    let world = e.world()?;
    if record != wt::ticket_address(&e.ctx, &citizen) {
        return Err(fail(
            WIDE_ACCOUNTS,
            "the ticket record is not at the Citizen position's ticket address",
        ));
    }
    let ra = wide_before(e, &record, "the ticket record")?
        .ok_or_else(|| fail(WIDE_RULE, "no ticket record (the program refuses NoTicket)"))?;
    let rec = WideTicket::read(&ra.data)
        .map_err(|er| fail(WIDE_ACCOUNTS, format!("the ticket record: {er:?}")))?;
    if rec.season_id != e.sid || rec.world != world {
        return Err(fail(
            WIDE_ACCOUNTS,
            "the ticket record is of another season or world",
        ));
    }
    if rec.citizen != citizen {
        return Err(fail(
            WIDE_ACCOUNTS,
            "the ticket record names another Citizen",
        ));
    }
    // `escrow_covered`: the record holds its own rent and its escrow. The
    // chain's rent is read from the record itself, when exactly funded.
    if rate_of_record(ra.lamports, rec.escrow).is_none() {
        if ra.lamports < rec.escrow {
            return Err(fail(
                WIDE_ACCOUNTS,
                "the record does not hold its escrow (the program refuses BadAccount)",
            ));
        }
        return Err(Missing(
            "the chain's rent: the ticket record is not exactly funded, so whether it covers its rent and escrow cannot be read".into(),
        ));
    }
    if rent_payer != rec.rent_payer {
        return Err(fail(
            WIDE_ACCOUNTS,
            "the rent payer is not the record's (the program refuses BadAddress)",
        ));
    }
    match (rec.escrow > 0, with_funder) {
        (true, true) => {
            if k(5) != rec.funder {
                return Err(fail(
                    WIDE_ACCOUNTS,
                    "the funder is not the record's (the program refuses BadAddress)",
                ));
            }
        }
        (false, false) => {}
        _ => {
            return Err(fail(
                UNDECODABLE,
                "the funder is listed exactly when the escrow is non-zero (the program refuses TooManyAccounts)",
            ))
        }
    }
    let mut wrote = vec![(record, Lam::Closed)];
    // The Citizen position: absent (closed by CloseCitizen), or present.
    match e.acct_before(&citizen) {
        Some(a) if !a.data.is_empty() => {
            if a.owner.to_bytes() != e.ctx.program {
                return Err(fail(
                    WIDE_ACCOUNTS,
                    "the Citizen position is not a program account",
                ));
            }
            let mut cd = a.data;
            if !e.present(&citizen, &cd, AccountKind::Citizen) {
                return Err(fail(
                    WIDE_ACCOUNTS,
                    "the Citizen position is not a Citizen of this season",
                ));
            }
            let tag15 = frontier_abi::resident_citizen::record_tag15(&cd)
                .ok_or_else(|| fail(WIDE_ACCOUNTS, "the Citizen's tag does not read"))?;
            if citizen != e.ctx.citizen_by_tag15(&tag15) {
                return Err(fail(WIDE_ACCOUNTS, "the Citizen is not at its address"));
            }
            let marker = wt::pending(&cd)
                .map_err(|_| fail(WIDE_ACCOUNTS, "the Citizen's ticket does not read"))?;
            match (marker, rec.status) {
                (CitizenTicket::Wide { bell, slot }, TicketStatus::Open) => {
                    if rec.bell != bell || rec.slot != slot {
                        return Err(fail(
                            WIDE_ACCOUNTS,
                            "the Citizen's marker is of another ticket",
                        ));
                    }
                    wt::clear(&mut cd).map_err(|er| {
                        fail(
                            WIDE_RULE,
                            format!("the ticket model refuses the clear ({er:?})"),
                        )
                    })?;
                    expect_after(e, &citizen, &cd, "the Citizen")?;
                    wrote.push((citizen, Lam::Same));
                }
                (CitizenTicket::None | CitizenTicket::Legacy, TicketStatus::Settled) => {}
                _ => {
                    return Err(fail(
                        WIDE_ACCOUNTS,
                        "the Citizen's marker and the record's status do not pair (the program refuses BadAccount)",
                    ))
                }
            }
        }
        _ if e.known_before(&citizen) || (e.snapshot.is_none() && e.w.has_post) => {
            if rec.status != TicketStatus::Settled {
                return Err(fail(
                    WIDE_ACCOUNTS,
                    "an Open record beside an absent Citizen (the program refuses BadAccount)",
                ));
            }
        }
        _ => {
            return Err(Missing(
                "the Citizen position: the archive has no state before".into(),
            ))
        }
    }
    expect_closed(e, &record, "the ticket record")?;
    Ok(wrote)
}

// ------------------------------------------------------------ what = 1

fn close_holding(e: &Env, ix: &Ix) -> Result<Vec<(Key, Lam)>, Wrong> {
    n_accounts(ix, 5, "WideClose(holding)")?;
    let k = |i: usize| ix.accounts[i].0;
    let (holding, rent_payer, dpool) = (k(2), k(3), k(4));
    for (i, what) in [
        (2, "the holding"),
        (3, "the rent payer"),
        (4, "the DefencePool"),
    ] {
        writable(ix, i, what, true)?;
    }
    season_end(e, ix, true)?;
    let world = e.world()?;
    let ha = wide_before(e, &holding, "the holding")?.ok_or_else(|| {
        fail(
            WIDE_ACCOUNTS,
            "the holding is absent (the program refuses BadAccount)",
        )
    })?;
    let h = holding_rec(e, &ha.data)?;
    if h.world != world {
        return Err(fail(WIDE_ACCOUNTS, "the holding is of another world"));
    }
    if holding != wh::holding_address(&e.ctx, h.coord, h.site) {
        return Err(fail(WIDE_ACCOUNTS, "the holding is not at its address"));
    }
    if rent_payer != arr32(&ha.data, H::RENT_PAYER) {
        return Err(fail(
            WIDE_ACCOUNTS,
            "the rent payer is not the holding's (the program refuses BadAddress)",
        ));
    }
    let owed = le(&ha.data, H::POOL_OWED, 8);
    let pool = e.legacy(
        &dpool,
        &e.ctx.defence_pool(),
        AccountKind::DefencePool,
        "the DefencePool",
    )?;
    if ha.lamports < owed {
        return Err(fail(
            WIDE_RULE,
            "the holding does not hold its pool_owed (the program refuses Insufficient)",
        ));
    }
    let rest = ha.lamports - owed;
    let got = e.after(&dpool, "the DefencePool")?;
    if got.owner.to_bytes() != e.ctx.program {
        return Err(fail(
            WIDE_REPLAY_MISMATCH,
            "the DefencePool is not owned by the program after",
        ));
    }
    if got.data != pool.data {
        // `pay_or_divert`: a rent payer the refund would leave below rent
        // exemption is not paid; the pool takes the refund and counts it.
        let mut diverted = pool.data.clone();
        let total = le(&diverted, DP::DIVERTED_TOTAL, 8).checked_add(rest);
        if let Some(total) = total {
            wr_u64(&mut diverted, DP::DIVERTED_TOTAL, total);
        }
        if total.is_some() && got.data == diverted && rest > 0 {
            return Err(Missing(
                "the DefencePool took the holding's refund (a divert): whether the rent payer was below rent exemption is not in the archive".into(),
            ));
        }
        return Err(fail(
            WIDE_REPLAY_MISMATCH,
            format!(
                "the DefencePool is not the re-run's ({})",
                first_diff(&got.data, &pool.data)
            ),
        ));
    }
    let want = pool
        .lamports
        .checked_add(owed)
        .ok_or_else(|| fail(WIDE_RULE, "the DefencePool's lamports overflow"))?;
    lamports_are(got.lamports, want, "the DefencePool")?;
    expect_closed(e, &holding, "the holding")?;
    Ok(vec![(holding, Lam::Closed), (dpool, Lam::Checked)])
}

// ------------------------------------------------------------ what = 6

fn close_province(e: &Env, ix: &Ix) -> Result<Vec<(Key, Lam)>, Wrong> {
    n_accounts(ix, 4, "WideClose(province)")?;
    let (province, fund) = (ix.accounts[2].0, ix.accounts[3].0);
    writable(ix, 2, "the province", true)?;
    writable(ix, 3, "the wedge fund", true)?;
    // Never the tombstone: CloseSeason closed the funds.
    season_end(e, ix, false)?;
    let world = e.world()?;
    let pa = wide_before(e, &province, "the province")?.ok_or_else(|| {
        fail(
            WIDE_ACCOUNTS,
            "the province is absent (the program refuses BadAccount)",
        )
    })?;
    let prov = WideProvince::read(&pa.data)
        .map_err(|er| fail(WIDE_ACCOUNTS, format!("the province: {er:?}")))?;
    if prov.season_id != e.sid || prov.world != world {
        return Err(fail(
            WIDE_ACCOUNTS,
            "the province is of another season or world",
        ));
    }
    if province != wl::province_address(&e.ctx, prov.coord) {
        return Err(fail(WIDE_ACCOUNTS, "the province is not at its address"));
    }
    let fa = e.legacy(
        &fund,
        &e.ctx.province_fund(prov.wedge),
        AccountKind::ProvinceFund,
        "the wedge fund",
    )?;
    let mut fw = fa.data.clone();
    let opened = (le(&fw, PF::PROVINCES_OPENED, 4) as u32).saturating_sub(1);
    wr_u32(&mut fw, PF::PROVINCES_OPENED, opened);
    let got = expect_after(e, &fund, &fw, "the wedge fund")?;
    let want = fa
        .lamports
        .checked_add(pa.lamports)
        .ok_or_else(|| fail(WIDE_RULE, "the fund's lamports overflow"))?;
    lamports_are(got.lamports, want, "the wedge fund")?;
    expect_closed(e, &province, "the province")?;
    Ok(vec![(province, Lam::Closed), (fund, Lam::Checked)])
}
