//! V26 (S2 stage 2a, `docs/frontier/stage2/S2-2A-CONTRACT.md` §4.2),
//! listed as `V26:tickets`: every landed ticket instruction re-judged from
//! the states before its transaction and the states it left, through the
//! ticket kernel (`permutation_rules::frontier::ticket`):
//!
//! - **IssueTickets:** the source the issuer's and live (a vault for a
//!   receipt; a final holding with a workshop for a use ticket), the terms
//!   (`ticket::check_terms`), fewer than `MAX_OPEN_ISSUES` live issues; the
//!   Issue and the issuer's first Lot as written (the whole amount, the
//!   source's generation, the Citizen's `ISSUES` and `LOTS` as seeds), the
//!   counters moved by one. The fee is V7's (the paying holding is an owner
//!   touch that pays `ticket::issue_fee`, and nothing is credited).
//! - **GiveLot:** the giver holds the lot, live and not in escrow; the issue
//!   valid now (live, its source live in the issue's generation); a gift to
//!   another citizen signed by the wallet (L7); the units moved exactly (a
//!   whole lot in place, a new lot seeded by the giver's `LOTS`, or added to
//!   the recipient's lot of the issue); the issue's supply unchanged.
//! - **CloseLot:** an empty or void lot of the closer's closed and its
//!   units taken from the supply; an issue closed by its issuer only when
//!   nothing valid is outstanding, `OPEN_ISSUES` lowered.
//!
//! - **Shares (2b, `S2-2B-CONTRACT.md`):** OpenShares writes the share
//!   Issue at the vault's value, the opener's deposit lot with all of it and
//!   the vault's shares; WithdrawShares burns from the holder's valid lot
//!   and the vault pays exactly `ticket::basket` (V23 judges the caravan);
//!   SettleDeposit mints `ticket::minted` into the caravan owner's deposit
//!   lot (V23 judges the delivery); a receipt on a shared vault, a deposit
//!   lot given in place and a share issue closed without clearing its vault
//!   fail.
//!
//! At the end, every Issue's `SUPPLY` is the sum of its lots' `AMOUNT`.
//! Code: `TicketMismatch`. Tamper classes T58–T63 (`crate::tamper`).

use frontier_abi::v2::ix as ix2;
use frontier_abi::v2::layout::player::{citizen as C2, holding as H2};
use frontier_abi::v2::layout::s1::{place as PL, vault as VA};
use frontier_abi::v2::layout::s2::{issue as IS, lot as LT};
use frontier_abi::v2::tags::Ix as V2Ix;
use permutation_rules::frontier::arms;
use permutation_rules::frontier::ticket::{
    self as kt, KIND_RECEIPT, KIND_SHARE, KIND_USE, MAX_OPEN_ISSUES, SRC_HOLDING, SRC_VAULT,
    STATE_CLOSED, STATE_LIVE,
};
use permutation_rules::frontier::travel::BELLS_PER_DAY;

use super::v23_caravans::{live_place, vault_shared, States, TxStates, Wrong};
use super::Ctx;
use crate::codes::TICKET_MISMATCH;
use crate::world::{le, Key};

const V: &str = "V26";

fn wrong(s: impl Into<String>) -> Wrong {
    (TICKET_MISMATCH, s.into())
}

fn short(what: &str) -> Wrong {
    wrong(format!("a short {what}"))
}
fn u32_of(d: &[u8], o: usize) -> Option<u32> {
    d.get(o..o + 4).map(|b| le(b) as u32)
}
fn u64_of(d: &[u8], o: usize) -> Option<u64> {
    d.get(o..o + 8).map(le)
}
fn key_of(d: &[u8], o: usize) -> Option<Key> {
    d.get(o..o + 32)?.try_into().ok()
}

/// An Issue as stored.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Issue {
    kind: u8,
    state: u8,
    src_kind: u8,
    src_gen: u8,
    p: i16,
    q: i16,
    at: u8,
    resource: u8,
    seq: u32,
    issuer: Key,
    issuer_tag: u64,
    supply: u64,
    per_unit: u64,
    until_day: u32,
    created_bell: u32,
}

impl Issue {
    fn decode(d: &[u8]) -> Result<Issue, Wrong> {
        if d.len() != IS::SIZE || d[..8] != IS::MAGIC {
            return Err(wrong("not an Issue"));
        }
        let e = || short("Issue");
        let i16_of = |o: usize| d.get(o..o + 2).map(|b| le(b) as u16 as i16).ok_or_else(e);
        Ok(Issue {
            kind: d[IS::KIND],
            state: d[IS::STATE],
            src_kind: d[IS::SRC_KIND],
            src_gen: d[IS::SRC_GEN],
            p: i16_of(IS::P)?,
            q: i16_of(IS::Q)?,
            at: d[IS::AT],
            resource: d[IS::RESOURCE],
            seq: u32_of(d, IS::SEQ).ok_or_else(e)?,
            issuer: key_of(d, IS::ISSUER_CITIZEN).ok_or_else(e)?,
            issuer_tag: u64_of(d, IS::ISSUER_TAG).ok_or_else(e)?,
            supply: u64_of(d, IS::SUPPLY).ok_or_else(e)?,
            per_unit: u64_of(d, IS::PER_UNIT).ok_or_else(e)?,
            until_day: u32_of(d, IS::UNTIL_DAY).ok_or_else(e)?,
            created_bell: u32_of(d, IS::CREATED_BELL).ok_or_else(e)?,
        })
    }
}

/// A Lot as stored.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Lot {
    issuer_tag: u64,
    issue_seq: u32,
    kind: u8,
    src_gen: u8,
    state: u8,
    holder: Key,
    holder_tag: u64,
    seed_tag: u64,
    seq: u32,
    amount: u64,
    escrow: u64,
}

impl Lot {
    fn decode(d: &[u8]) -> Result<Lot, Wrong> {
        if d.len() != LT::SIZE || d[..8] != LT::MAGIC {
            return Err(wrong("not a Lot"));
        }
        let e = || short("Lot");
        Ok(Lot {
            issuer_tag: u64_of(d, LT::ISSUER_TAG).ok_or_else(e)?,
            issue_seq: u32_of(d, LT::ISSUE_SEQ).ok_or_else(e)?,
            kind: d[LT::KIND],
            src_gen: d[LT::SRC_GEN],
            state: d[LT::STATE],
            holder: key_of(d, LT::HOLDER_CITIZEN).ok_or_else(e)?,
            holder_tag: u64_of(d, LT::HOLDER_TAG).ok_or_else(e)?,
            seed_tag: u64_of(d, LT::SEED_TAG).ok_or_else(e)?,
            seq: u32_of(d, LT::SEQ).ok_or_else(e)?,
            amount: u64_of(d, LT::AMOUNT).ok_or_else(e)?,
            escrow: u64_of(d, LT::ESCROW).ok_or_else(e)?,
        })
    }
    fn of(&self, i: &Issue) -> bool {
        (self.issuer_tag, self.issue_seq) == (i.issuer_tag, i.seq)
    }
}

struct Seen<'a> {
    s: &'a dyn States,
}

impl Seen<'_> {
    fn before(&self, k: &Key, what: &str) -> Result<Vec<u8>, Wrong> {
        self.s
            .before(k)
            .ok_or_else(|| wrong(format!("no {what} before")))
    }
    fn after(&self, k: &Key, what: &str) -> Result<Vec<u8>, Wrong> {
        self.s
            .after(k)
            .ok_or_else(|| wrong(format!("no {what} after")))
    }
}

/// Whether an issue's tickets are valid with its source's state `sd`
/// (live, at the issue's place, in its generation).
fn valid_now(i: &Issue, sd: Option<&[u8]>) -> bool {
    let want_kind = match i.src_kind {
        SRC_VAULT => PL::KIND_VAULT,
        SRC_HOLDING => PL::KIND_HOLDING,
        _ => return false,
    };
    let Some((pl, _)) = sd.and_then(live_place) else {
        return false;
    };
    (pl.kind, pl.p, pl.q, pl.at) == (want_kind, i.p, i.q, i.at)
        && kt::valid(i.src_gen, pl.gen, i.state == STATE_LIVE)
}

/// Only the fields `ok` names may differ between a Citizen before and after
/// (the event chain's header aside).
fn citizen_counters(cb: &[u8], ca: &[u8], issues: u32, lots: u32, open: u8) -> Result<(), Wrong> {
    if u32_of(ca, C2::ISSUES) != Some(issues)
        || u32_of(ca, C2::LOTS) != Some(lots)
        || ca.get(C2::OPEN_ISSUES) != Some(&open)
    {
        return Err(wrong(format!(
            "the Citizen's ticket counters are not ({issues}, {lots}, {open})"
        )));
    }
    if cb.len() != ca.len() {
        return Err(short("Citizen"));
    }
    Ok(())
}

// ------------------------------------------------------------ IssueTickets

/// IssueTickets (accounts: 3 citizen, 4 holding, 6 source, 7 issue, 8 lot).
pub fn judge_issue(ix: &crate::world::Ix, s: &dyn States, bell: u32) -> Result<(), Wrong> {
    let x = ix2::IssueTickets::decode(&ix.data).map_err(|_| wrong("does not decode"))?;
    let (Some(citizen), Some(source), Some(issue), Some(lot)) =
        (ix.key(3), ix.key(6), ix.key(7), ix.key(8))
    else {
        return Err(wrong("the accounts are missing"));
    };
    let v = Seen { s };
    let cb = v.before(&citizen, "Citizen")?;
    let ca = v.after(&citizen, "Citizen")?;
    let sd = v.before(&source, "source")?;
    let (pl, owner) = live_place(&sd).ok_or_else(|| wrong("the source is not live"))?;
    if owner != citizen {
        return Err(wrong("the source is not the issuer's"));
    }
    if x.kind == KIND_RECEIPT && vault_shared(&sd) {
        return Err(wrong("a receipt on a shared vault"));
    }
    let (src_kind, cap) = match x.kind {
        KIND_RECEIPT if pl.kind == PL::KIND_VAULT => (
            SRC_VAULT,
            u64_of(&sd, VA::CAP).ok_or_else(|| short("Vault"))? as i64,
        ),
        KIND_USE if pl.kind == PL::KIND_HOLDING => {
            let o = H2::PRODUCTION + 8 * arms::ARMS as usize;
            let rate = u64_of(&sd, o).ok_or_else(|| short("Holding"))? as i64;
            if sd[H2::STATE] != H2::STATE_FINAL || rate < arms::WORKSHOP_DELTA {
                return Err(wrong("a use ticket of a holding without a workshop"));
            }
            (SRC_HOLDING, 0)
        }
        _ => return Err(wrong("a ticket kind its source cannot issue")),
    };
    kt::check_terms(
        x.kind,
        x.resource,
        x.amount,
        x.per_unit,
        x.until_day,
        cap,
        bell / BELLS_PER_DAY,
    )
    .map_err(|e| wrong(format!("terms the rules refuse ({e:?})")))?;
    let e = || short("Citizen");
    let seq = u32_of(&cb, C2::ISSUES).ok_or_else(e)?;
    let lots = u32_of(&cb, C2::LOTS).ok_or_else(e)?;
    let open = *cb.get(C2::OPEN_ISSUES).ok_or_else(e)?;
    if open >= MAX_OPEN_ISSUES {
        return Err(wrong("an issue beyond MAX_OPEN_ISSUES"));
    }
    let tag = u64_of(&cb, C2::CITIZEN_TAG).ok_or_else(e)?;
    let want = Issue {
        kind: x.kind,
        state: STATE_LIVE,
        src_kind,
        src_gen: pl.gen,
        p: pl.p,
        q: pl.q,
        at: pl.at,
        resource: x.resource,
        seq,
        issuer: citizen,
        issuer_tag: tag,
        supply: x.amount,
        per_unit: x.per_unit,
        until_day: x.until_day,
        created_bell: bell,
    };
    if s.before(&issue).is_some() {
        return Err(wrong("an Issue written over one"));
    }
    if Issue::decode(&v.after(&issue, "Issue")?)? != want {
        return Err(wrong("the Issue is not the rules' issue"));
    }
    let want_lot = Lot {
        issuer_tag: tag,
        issue_seq: seq,
        kind: x.kind,
        src_gen: pl.gen,
        state: STATE_LIVE,
        holder: citizen,
        holder_tag: tag,
        seed_tag: tag,
        seq: lots,
        amount: x.amount,
        escrow: 0,
    };
    if s.before(&lot).is_some() {
        return Err(wrong("a Lot written over one"));
    }
    if Lot::decode(&v.after(&lot, "Lot")?)? != want_lot {
        return Err(wrong("the first Lot is not the whole issue's"));
    }
    citizen_counters(&cb, &ca, seq + 1, lots + 1, open + 1)
}

// ------------------------------------------------------------ GiveLot

/// GiveLot (accounts: 0 actor, 3 citizen, 4 lot, 5 issue, 6 source, 7
/// recipient, 8 to_lot).
pub fn judge_give(ix: &crate::world::Ix, s: &dyn States) -> Result<(), Wrong> {
    let x = ix2::GiveLot::decode(&ix.data).map_err(|_| wrong("does not decode"))?;
    let keys: Vec<Option<Key>> = (0..9).map(|i| ix.key(i)).collect();
    let [Some(actor), _, _, Some(citizen), Some(lot), Some(issue), Some(source), Some(recipient), Some(to_lot)] =
        keys[..]
    else {
        return Err(wrong("the accounts are missing"));
    };
    let v = Seen { s };
    let cb = v.before(&citizen, "Citizen")?;
    let ca = v.after(&citizen, "Citizen")?;
    let from = Lot::decode(&v.before(&lot, "Lot")?)?;
    let ib = Issue::decode(&v.before(&issue, "Issue")?)?;
    let ia = Issue::decode(&v.after(&issue, "Issue")?)?;
    if from.holder != citizen {
        return Err(wrong("a lot given by another than its holder"));
    }
    if from.state != STATE_LIVE || from.escrow != 0 || !from.of(&ib) {
        return Err(wrong("a lot that cannot be given"));
    }
    if !valid_now(&ib, s.before(&source).as_deref()) || from.src_gen != ib.src_gen {
        return Err(wrong("a void lot moved"));
    }
    if x.amount == 0 || x.amount > from.amount {
        return Err(wrong("an amount the lot does not hold"));
    }
    if ia != ib {
        return Err(wrong("the Issue changed in a gift"));
    }
    let rd = v.before(&recipient, "recipient")?;
    let rtag = u64_of(&rd, C2::CITIZEN_TAG).ok_or_else(|| short("recipient"))?;
    let to_self = recipient == citizen;
    if !to_self && key_of(&cb, C2::WALLET) != Some(actor) {
        return Err(wrong("a gift to another citizen without the wallet"));
    }
    let gtag = u64_of(&cb, C2::CITIZEN_TAG).ok_or_else(|| short("Citizen"))?;
    let lots = u32_of(&cb, C2::LOTS).ok_or_else(|| short("Citizen"))?;
    let issues = u32_of(&cb, C2::ISSUES).ok_or_else(|| short("Citizen"))?;
    let open = cb[C2::OPEN_ISSUES];
    let whole = x.amount == from.amount;
    let fa = Lot::decode(&v.after(&lot, "Lot")?)?;
    if to_lot == lot {
        if !whole || to_self || frontier_abi::v2::addr::is_deposit_seq(from.seq) {
            return Err(wrong("an in-place gift of part of a lot"));
        }
        let mut want = from;
        want.holder = recipient;
        want.holder_tag = rtag;
        if fa != want {
            return Err(wrong("the lot given whole is not the recipient's"));
        }
        return citizen_counters(&cb, &ca, issues, lots, open);
    }
    let mut left = from;
    left.amount = from.amount - x.amount;
    if fa != left {
        return Err(wrong("the giver's lot did not lose the amount"));
    }
    let ta = Lot::decode(&v.after(&to_lot, "recipient's Lot")?)?;
    match s.before(&to_lot) {
        None => {
            let want = Lot {
                holder: recipient,
                holder_tag: rtag,
                seed_tag: gtag,
                seq: lots,
                amount: x.amount,
                ..from
            };
            if ta != want {
                return Err(wrong("the new lot is not the gift's"));
            }
            citizen_counters(&cb, &ca, issues, lots + 1, open)
        }
        Some(tb) => {
            let tb = Lot::decode(&tb)?;
            if !tb.of(&ib)
                || tb.holder != recipient
                || tb.state != STATE_LIVE
                || tb.escrow != 0
                || tb.src_gen != ib.src_gen
            {
                return Err(wrong("units added to a lot that cannot take them"));
            }
            let mut want = tb;
            want.amount = tb
                .amount
                .checked_add(x.amount)
                .ok_or_else(|| wrong("overflow"))?;
            if ta != want {
                return Err(wrong("the recipient's lot did not gain the amount"));
            }
            citizen_counters(&cb, &ca, issues, lots, open)
        }
    }
}

// ------------------------------------------------------------ CloseLot

/// CloseLot (accounts: 3 citizen, 4 issue, 5 source, 6 issue_rent_to, and
/// optionally 7 lot, 8 rent_to).
pub fn judge_close(ix: &crate::world::Ix, s: &dyn States) -> Result<(), Wrong> {
    let x = ix2::CloseLot::decode(&ix.data).map_err(|_| wrong("does not decode"))?;
    let (Some(citizen), Some(issue), Some(source)) = (ix.key(3), ix.key(4), ix.key(5)) else {
        return Err(wrong("the accounts are missing"));
    };
    let v = Seen { s };
    let cb = v.before(&citizen, "Citizen")?;
    let ca = v.after(&citizen, "Citizen")?;
    let ib = Issue::decode(&v.before(&issue, "Issue")?)?;
    if ib.state != STATE_LIVE {
        return Err(wrong("a close on a closed issue"));
    }
    let valid = valid_now(&ib, s.before(&source).as_deref());
    let mut supply = ib.supply;
    let mut closed_lot = false;
    if let Some(lot) = ix.key(7) {
        let lb = Lot::decode(&v.before(&lot, "Lot")?)?;
        if !lb.of(&ib) || lb.holder != citizen || lb.state != STATE_LIVE || lb.escrow != 0 {
            return Err(wrong("a lot closed by another than its holder"));
        }
        let void = !valid || lb.src_gen != ib.src_gen;
        if lb.amount > 0 && !void {
            return Err(wrong("a valid lot closed with units in it"));
        }
        if s.after(&lot).is_some() {
            return Err(wrong("the Lot is not closed"));
        }
        supply = supply.saturating_sub(lb.amount);
        closed_lot = true;
    }
    let e = || short("Citizen");
    let issues = u32_of(&cb, C2::ISSUES).ok_or_else(e)?;
    let lots = u32_of(&cb, C2::LOTS).ok_or_else(e)?;
    let open = *cb.get(C2::OPEN_ISSUES).ok_or_else(e)?;
    if x.close_issue != 0 {
        if ib.issuer != citizen {
            return Err(wrong("an issue closed by another than its issuer"));
        }
        if supply != 0 && valid {
            return Err(wrong("an issue closed with valid tickets outstanding"));
        }
        if s.after(&issue).is_some() {
            return Err(wrong("the Issue is not closed"));
        }
        // 2b: closing a share issue clears its vault's shares.
        if ib.kind == KIND_SHARE {
            let sb = s.before(&source).unwrap_or_default();
            if shares_of(&sb) == Some((ib.issuer_tag, ib.seq))
                && s.after(&source).is_some_and(|a| vault_shared(&a))
            {
                return Err(wrong("a share issue closed without clearing its vault"));
            }
        }
        return citizen_counters(&cb, &ca, issues, lots, open.saturating_sub(1));
    }
    if !closed_lot {
        return Err(wrong("a CloseLot that closes nothing"));
    }
    let mut want = ib;
    want.supply = supply;
    if Issue::decode(&v.after(&issue, "Issue")?)? != want {
        return Err(wrong("the supply is not the closed lot's"));
    }
    citizen_counters(&cb, &ca, issues, lots, open)
}

// ------------------------------------------------------------ shares (2b)

/// A vault's live share issue `(issuer_tag, seq)`.
fn shares_of(d: &[u8]) -> Option<(u64, u32)> {
    vault_shared(d).then(|| {
        (
            u64_of(d, VA::SHARES_ISSUER_TAG).unwrap_or(0),
            u32_of(d, VA::SHARES_SEQ).unwrap_or(0),
        )
    })
}

fn stores_of(d: &[u8]) -> Result<[i64; 8], Wrong> {
    let mut out = [0i64; 8];
    for (r, v) in out.iter_mut().enumerate() {
        *v = u64_of(d, VA::store(r)).ok_or_else(|| short("Vault"))? as i64;
    }
    Ok(out)
}

/// OpenShares (accounts: 3 citizen, 6 vault, 7 issue, 8 lot).
pub fn judge_open(ix: &crate::world::Ix, s: &dyn States, bell: u32) -> Result<(), Wrong> {
    let (Some(citizen), Some(vault), Some(issue), Some(lot)) =
        (ix.key(3), ix.key(6), ix.key(7), ix.key(8))
    else {
        return Err(wrong("the accounts are missing"));
    };
    let v = Seen { s };
    let cb = v.before(&citizen, "Citizen")?;
    let ca = v.after(&citizen, "Citizen")?;
    let vb = v.before(&vault, "Vault")?;
    let va = v.after(&vault, "Vault")?;
    let (pl, owner) = live_place(&vb).ok_or_else(|| wrong("the vault is not live"))?;
    if pl.kind != PL::KIND_VAULT || owner != citizen {
        return Err(wrong("shares opened on a vault not the citizen's"));
    }
    if vault_shared(&vb) {
        return Err(wrong("shares opened twice"));
    }
    let stores = stores_of(&vb)?;
    if stores_of(&va)? != stores {
        return Err(wrong("the vault's stores changed at the opening"));
    }
    let supply = kt::value_of(&stores).min(u64::MAX as u128) as u64;
    let e = || short("Citizen");
    let seq = u32_of(&cb, C2::ISSUES).ok_or_else(e)?;
    let lots = u32_of(&cb, C2::LOTS).ok_or_else(e)?;
    let open = *cb.get(C2::OPEN_ISSUES).ok_or_else(e)?;
    if open >= MAX_OPEN_ISSUES {
        return Err(wrong("shares beyond MAX_OPEN_ISSUES"));
    }
    let tag = u64_of(&cb, C2::CITIZEN_TAG).ok_or_else(e)?;
    let want = Issue {
        kind: KIND_SHARE,
        state: STATE_LIVE,
        src_kind: SRC_VAULT,
        src_gen: pl.gen,
        p: pl.p,
        q: pl.q,
        at: pl.at,
        resource: 0,
        seq,
        issuer: citizen,
        issuer_tag: tag,
        supply,
        per_unit: 0,
        until_day: kt::NO_END,
        created_bell: bell,
    };
    if s.before(&issue).is_some() || Issue::decode(&v.after(&issue, "Issue")?)? != want {
        return Err(wrong("the share Issue is not the vault's value"));
    }
    let want_lot = Lot {
        issuer_tag: tag,
        issue_seq: seq,
        kind: KIND_SHARE,
        src_gen: pl.gen,
        state: STATE_LIVE,
        holder: citizen,
        holder_tag: tag,
        seed_tag: tag,
        seq: frontier_abi::v2::addr::deposit_seq(tag, seq),
        amount: supply,
        escrow: 0,
    };
    if s.before(&lot).is_some() || Lot::decode(&v.after(&lot, "Lot")?)? != want_lot {
        return Err(wrong("the opener's deposit lot is not the whole supply"));
    }
    if shares_of(&va) != Some((tag, seq)) {
        return Err(wrong("the vault does not name its share issue"));
    }
    citizen_counters(&cb, &ca, seq + 1, lots, open + 1)
}

/// WithdrawShares (accounts: 3 citizen, 4 lot, 5 issue, 6 src): the burn
/// and the basket (V23 judges the caravan of what the vault paid).
pub fn judge_withdraw(ix: &crate::world::Ix, s: &dyn States) -> Result<(), Wrong> {
    let x = ix2::WithdrawShares::decode(&ix.data).map_err(|_| wrong("does not decode"))?;
    let (Some(citizen), Some(lot), Some(issue), Some(src)) =
        (ix.key(3), ix.key(4), ix.key(5), ix.key(6))
    else {
        return Err(wrong("the accounts are missing"));
    };
    let v = Seen { s };
    let lb = Lot::decode(&v.before(&lot, "Lot")?)?;
    let ib = Issue::decode(&v.before(&issue, "Issue")?)?;
    let vb = v.before(&src, "Vault")?;
    let va = v.after(&src, "Vault")?;
    if lb.holder != citizen || lb.state != STATE_LIVE || lb.escrow != 0 || !lb.of(&ib) {
        return Err(wrong("a withdrawal from a lot not the citizen's"));
    }
    if ib.kind != KIND_SHARE
        || !valid_now(&ib, Some(&vb))
        || lb.src_gen != ib.src_gen
        || shares_of(&vb) != Some((ib.issuer_tag, ib.seq))
    {
        return Err(wrong("a withdrawal of void shares"));
    }
    if x.amount == 0 || x.amount > lb.amount {
        return Err(wrong("an amount the lot does not hold"));
    }
    let basket = kt::basket(&stores_of(&vb)?, x.amount, ib.supply);
    let (b, a) = (stores_of(&vb)?, stores_of(&va)?);
    if (0..8).any(|r| b[r] - a[r] != basket[r]) {
        return Err(wrong("the vault paid other than the basket"));
    }
    let mut want = lb;
    want.amount -= x.amount;
    if Lot::decode(&v.after(&lot, "Lot")?)? != want {
        return Err(wrong("the lot did not burn the amount"));
    }
    let mut wi = ib;
    wi.supply -= x.amount;
    if Issue::decode(&v.after(&issue, "Issue")?)? != wi {
        return Err(wrong("the supply did not lose the amount"));
    }
    Ok(())
}

/// SettleDeposit (accounts: 2 caravan, 3 dst, 6 issue, 7 lot): the units
/// the delivery minted (V23 judges the delivery).
pub fn judge_deposit(ix: &crate::world::Ix, s: &dyn States) -> Result<(), Wrong> {
    use frontier_abi::v2::layout::s1::caravan as CV;
    let (Some(caravan), Some(dst), Some(issue), Some(lot)) =
        (ix.key(2), ix.key(3), ix.key(6), ix.key(7))
    else {
        return Err(wrong("the accounts are missing"));
    };
    let v = Seen { s };
    let cb = v.before(&caravan, "Caravan")?;
    let holder = key_of(&cb, CV::OWNER_CITIZEN).ok_or_else(|| short("Caravan"))?;
    let vb = v.before(&dst, "Vault")?;
    let va = v.after(&dst, "Vault")?;
    let ib = Issue::decode(&v.before(&issue, "Issue")?)?;
    if shares_of(&vb) != Some((ib.issuer_tag, ib.seq)) || ib.kind != KIND_SHARE {
        return Err(wrong("a deposit into another issue than the vault's"));
    }
    let (v0, v1) = (
        kt::value_of(&stores_of(&vb)?),
        kt::value_of(&stores_of(&va)?),
    );
    let tag = frontier_abi::addr::citizen_tag(&holder);
    let seq = frontier_abi::v2::addr::deposit_seq(ib.issuer_tag, ib.seq);
    let la = Lot::decode(&v.after(&lot, "Lot")?)?;
    let mut minted = kt::minted(v1.saturating_sub(v0), ib.supply, v0);
    let want = match s.before(&lot) {
        None => Lot {
            issuer_tag: ib.issuer_tag,
            issue_seq: ib.seq,
            kind: KIND_SHARE,
            src_gen: ib.src_gen,
            state: STATE_LIVE,
            holder,
            holder_tag: tag,
            seed_tag: tag,
            seq,
            amount: minted,
            escrow: 0,
        },
        Some(d) => {
            let lb = Lot::decode(&d)?;
            if (lb.seed_tag, lb.seq) != (tag, seq) {
                return Err(wrong("a deposit into a lot not the holder's deposit lot"));
            }
            let mut w = lb;
            if lb.of(&ib)
                && lb.holder == holder
                && lb.state == STATE_LIVE
                && lb.src_gen == ib.src_gen
            {
                w.amount = lb.amount.saturating_add(minted);
                minted = w.amount - lb.amount;
            } else {
                minted = 0;
            }
            w
        }
    };
    if la != want {
        return Err(wrong("the deposit lot is not the units the rule mints"));
    }
    let mut wi = ib;
    wi.supply = ib.supply.saturating_add(minted);
    if Issue::decode(&v.after(&issue, "Issue")?)? != wi {
        return Err(wrong("the supply is not the minted units'"));
    }
    Ok(())
}

// ------------------------------------------------------------ the check

/// Every final Issue's supply against its final lots: `(issue key, what)`.
fn supplies(finals: &[(Key, Vec<u8>)]) -> Vec<String> {
    use std::collections::BTreeMap;
    let mut issues: BTreeMap<(u64, u32), (Key, u64)> = BTreeMap::new();
    let mut held: BTreeMap<(u64, u32), u64> = BTreeMap::new();
    for (k, d) in finals {
        if let Ok(i) = Issue::decode(d) {
            if i.state == STATE_LIVE {
                issues.insert((i.issuer_tag, i.seq), (*k, i.supply));
            }
        } else if let Ok(l) = Lot::decode(d) {
            if l.state != STATE_CLOSED {
                *held.entry((l.issuer_tag, l.issue_seq)).or_default() += l.amount;
            }
        }
    }
    issues
        .into_iter()
        .filter_map(|(id, (k, supply))| {
            let sum = held.get(&id).copied().unwrap_or(0);
            (sum != supply).then(|| {
                format!(
                    "Issue {} supplies {supply} but its lots hold {sum}",
                    hex::encode(k)
                )
            })
        })
        .collect()
}

pub fn run(cx: &mut Ctx) {
    if !cx.s2 {
        return;
    }
    let w = cx.w;
    let tags = [
        V2Ix::IssueTickets,
        V2Ix::GiveLot,
        V2Ix::CloseLot,
        V2Ix::OpenShares,
        V2Ix::WithdrawShares,
        V2Ix::SettleDeposit,
    ];
    if !w.has_post {
        let any = w.txs.iter().any(|tx| {
            tx.ok
                && tx
                    .ixs
                    .iter()
                    .any(|i| i.tag().is_some_and(|x| tags.iter().any(|t| t.tag() == x)))
        });
        if any {
            cx.missing(
                V,
                "tickets",
                0,
                None,
                "no post-states: the ticket instructions cannot be re-judged",
            );
        }
        return;
    }
    let genesis_ts = cx.f.genesis_ts;
    let mut found: Vec<(usize, u32, &'static str, String)> = vec![];
    for (t, tx) in w.txs.iter().enumerate().filter(|(_, tx)| tx.ok) {
        let bell = frontier_abi::prologue::bell_at(genesis_ts, tx.time).unwrap_or(0);
        let st = TxStates { w, tx, t };
        for ix in &tx.ixs {
            let Some(tag) = ix.tag() else { continue };
            let r = match V2Ix::from_tag(tag) {
                Some(V2Ix::IssueTickets) => judge_issue(ix, &st, bell),
                Some(V2Ix::GiveLot) => judge_give(ix, &st),
                Some(V2Ix::CloseLot) => judge_close(ix, &st),
                Some(V2Ix::OpenShares) => judge_open(ix, &st, bell),
                Some(V2Ix::WithdrawShares) => judge_withdraw(ix, &st),
                Some(V2Ix::SettleDeposit) => judge_deposit(ix, &st),
                _ => continue,
            };
            if let Err((code, detail)) = r {
                found.push((t, bell, code, detail));
            }
        }
    }
    let finals: Vec<(Key, Vec<u8>)> = cx
        .input
        .finals
        .iter()
        .filter_map(|(k, a)| Some((*k, a.as_ref()?.data.clone())))
        .collect();
    for detail in supplies(&finals) {
        found.push((usize::MAX, 0, TICKET_MISMATCH, detail));
    }
    for (t, bell, code, detail) in found {
        let at = (t != usize::MAX).then_some(t);
        cx.fail(V, code, "tickets", bell, at, detail);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    struct Mock {
        before: HashMap<Key, Vec<u8>>,
        after: HashMap<Key, Option<Vec<u8>>>,
    }

    impl States for Mock {
        fn before(&self, k: &Key) -> Option<Vec<u8>> {
            self.before.get(k).cloned()
        }
        fn after(&self, k: &Key) -> Option<Vec<u8>> {
            match self.after.get(k) {
                Some(a) => a.clone(),
                None => self.before.get(k).cloned(),
            }
        }
    }

    fn ix(data: Vec<u8>, keys: &[Key]) -> crate::world::Ix {
        crate::world::Ix {
            index: 0,
            data,
            accounts: keys.iter().map(|k| (*k, true)).collect(),
        }
    }

    const WALLET: Key = [1; 32];
    const SESSION: Key = [2; 32];
    const ME: Key = [3; 32];
    const YOU: Key = [4; 32];
    const VAULT: Key = [5; 32];
    const ISSUE: Key = [6; 32];
    const LOT: Key = [7; 32];
    const NEW_LOT: Key = [8; 32];
    const HOLDING: Key = [9; 32];

    fn citizen(tag: u64, wallet: Key, issues: u32, lots: u32, open: u8) -> Vec<u8> {
        let mut d = vec![0u8; C2::SIZE];
        d[C2::WALLET..C2::WALLET + 32].copy_from_slice(&wallet);
        d[C2::CITIZEN_TAG..C2::CITIZEN_TAG + 8].copy_from_slice(&tag.to_le_bytes());
        d[C2::ISSUES..C2::ISSUES + 4].copy_from_slice(&issues.to_le_bytes());
        d[C2::LOTS..C2::LOTS + 4].copy_from_slice(&lots.to_le_bytes());
        d[C2::OPEN_ISSUES] = open;
        d
    }

    fn vault(owner: Key, gen: u8) -> Vec<u8> {
        let mut d = vec![0u8; VA::SIZE];
        d[..8].copy_from_slice(&VA::MAGIC);
        d[VA::STATE] = VA::STATE_LIVE;
        d[VA::P..VA::P + 2].copy_from_slice(&3i16.to_le_bytes());
        d[VA::Q..VA::Q + 2].copy_from_slice(&(-2i16).to_le_bytes());
        d[VA::TILE] = 17;
        d[VA::GEN] = gen;
        d[VA::OWNER_CITIZEN..VA::OWNER_CITIZEN + 32].copy_from_slice(&owner);
        d[VA::CAP..VA::CAP + 8].copy_from_slice(&5_000_000i64.to_le_bytes());
        d
    }

    fn issue_bytes(i: &Issue) -> Vec<u8> {
        let mut d = vec![0u8; IS::SIZE];
        d[..8].copy_from_slice(&IS::MAGIC);
        d[IS::KIND] = i.kind;
        d[IS::STATE] = i.state;
        d[IS::SRC_KIND] = i.src_kind;
        d[IS::SRC_GEN] = i.src_gen;
        d[IS::P..IS::P + 2].copy_from_slice(&i.p.to_le_bytes());
        d[IS::Q..IS::Q + 2].copy_from_slice(&i.q.to_le_bytes());
        d[IS::AT] = i.at;
        d[IS::RESOURCE] = i.resource;
        d[IS::SEQ..IS::SEQ + 4].copy_from_slice(&i.seq.to_le_bytes());
        d[IS::ISSUER_CITIZEN..IS::ISSUER_CITIZEN + 32].copy_from_slice(&i.issuer);
        d[IS::ISSUER_TAG..IS::ISSUER_TAG + 8].copy_from_slice(&i.issuer_tag.to_le_bytes());
        d[IS::SUPPLY..IS::SUPPLY + 8].copy_from_slice(&i.supply.to_le_bytes());
        d[IS::PER_UNIT..IS::PER_UNIT + 8].copy_from_slice(&i.per_unit.to_le_bytes());
        d[IS::UNTIL_DAY..IS::UNTIL_DAY + 4].copy_from_slice(&i.until_day.to_le_bytes());
        d[IS::CREATED_BELL..IS::CREATED_BELL + 4].copy_from_slice(&i.created_bell.to_le_bytes());
        d
    }

    fn lot_bytes(l: &Lot) -> Vec<u8> {
        let mut d = vec![0u8; LT::SIZE];
        d[..8].copy_from_slice(&LT::MAGIC);
        d[LT::ISSUER_TAG..LT::ISSUER_TAG + 8].copy_from_slice(&l.issuer_tag.to_le_bytes());
        d[LT::ISSUE_SEQ..LT::ISSUE_SEQ + 4].copy_from_slice(&l.issue_seq.to_le_bytes());
        d[LT::KIND] = l.kind;
        d[LT::SRC_GEN] = l.src_gen;
        d[LT::STATE] = l.state;
        d[LT::HOLDER_CITIZEN..LT::HOLDER_CITIZEN + 32].copy_from_slice(&l.holder);
        d[LT::HOLDER_TAG..LT::HOLDER_TAG + 8].copy_from_slice(&l.holder_tag.to_le_bytes());
        d[LT::SEED_TAG..LT::SEED_TAG + 8].copy_from_slice(&l.seed_tag.to_le_bytes());
        d[LT::SEQ..LT::SEQ + 4].copy_from_slice(&l.seq.to_le_bytes());
        d[LT::AMOUNT..LT::AMOUNT + 8].copy_from_slice(&l.amount.to_le_bytes());
        d[LT::ESCROW..LT::ESCROW + 8].copy_from_slice(&l.escrow.to_le_bytes());
        d
    }

    fn the_issue() -> Issue {
        Issue {
            kind: KIND_RECEIPT,
            state: STATE_LIVE,
            src_kind: SRC_VAULT,
            src_gen: 1,
            p: 3,
            q: -2,
            at: 17,
            resource: 3,
            seq: 0,
            issuer: ME,
            issuer_tag: 11,
            supply: 10,
            per_unit: 2_000,
            until_day: kt::NO_END,
            created_bell: 50,
        }
    }

    fn the_lot() -> Lot {
        Lot {
            issuer_tag: 11,
            issue_seq: 0,
            kind: KIND_RECEIPT,
            src_gen: 1,
            state: STATE_LIVE,
            holder: ME,
            holder_tag: 11,
            seed_tag: 11,
            seq: 0,
            amount: 10,
            escrow: 0,
        }
    }

    /// An issue writes the rules' Issue, first Lot and counters; a supply
    /// other than the amount (T58's shape) fails, as does an issue past the
    /// limit or of another's vault.
    #[test]
    fn an_issue_is_the_rules() {
        let data = ix2::IssueTickets {
            kind: KIND_RECEIPT,
            resource: 3,
            amount: 10,
            per_unit: 2_000,
            until_day: kt::NO_END,
        }
        .to_bytes()
        .to_vec();
        let i = ix(
            data,
            &[
                SESSION, [0; 32], [0; 32], ME, HOLDING, [0; 32], VAULT, ISSUE, LOT,
            ],
        );
        let cb = citizen(11, WALLET, 0, 0, 0);
        let mut m = Mock {
            before: HashMap::from([(ME, cb.clone()), (VAULT, vault(ME, 1))]),
            after: HashMap::from([
                (ME, Some(citizen(11, WALLET, 1, 1, 1))),
                (ISSUE, Some(issue_bytes(&the_issue()))),
                (LOT, Some(lot_bytes(&the_lot()))),
            ]),
        };
        assert_eq!(judge_issue(&i, &m, 50), Ok(()));
        let mut more = the_issue();
        more.supply = 11;
        m.after.insert(ISSUE, Some(issue_bytes(&more)));
        assert!(judge_issue(&i, &m, 50).is_err());
        m.after.insert(ISSUE, Some(issue_bytes(&the_issue())));
        m.before
            .insert(ME, citizen(11, WALLET, 0, 0, MAX_OPEN_ISSUES));
        assert!(judge_issue(&i, &m, 50).is_err());
        m.before.insert(ME, cb);
        m.before.insert(VAULT, vault(YOU, 1));
        assert!(judge_issue(&i, &m, 50).is_err());
    }

    /// A split to another citizen needs the wallet (T59's shape: signed by
    /// the session); a lot of a seized vault cannot move (T60's shape).
    #[test]
    fn a_gift_needs_the_wallet_and_a_valid_lot() {
        let data = ix2::GiveLot { amount: 4 }.to_bytes().to_vec();
        let keys = |actor| [actor, [0; 32], [0; 32], ME, LOT, ISSUE, VAULT, YOU, NEW_LOT];
        let mut left = the_lot();
        left.amount = 6;
        let new = Lot {
            holder: YOU,
            holder_tag: 22,
            seed_tag: 11,
            seq: 1,
            amount: 4,
            ..the_lot()
        };
        let mut m = Mock {
            before: HashMap::from([
                (ME, citizen(11, WALLET, 1, 1, 1)),
                (YOU, citizen(22, [9; 32], 0, 0, 0)),
                (VAULT, vault(ME, 1)),
                (ISSUE, issue_bytes(&the_issue())),
                (LOT, lot_bytes(&the_lot())),
            ]),
            after: HashMap::from([
                (ME, Some(citizen(11, WALLET, 1, 2, 1))),
                (LOT, Some(lot_bytes(&left))),
                (NEW_LOT, Some(lot_bytes(&new))),
            ]),
        };
        assert_eq!(judge_give(&ix(data.clone(), &keys(WALLET)), &m), Ok(()));
        assert!(judge_give(&ix(data.clone(), &keys(SESSION)), &m).is_err());
        m.before.insert(VAULT, vault(YOU, 2));
        assert!(judge_give(&ix(data, &keys(WALLET)), &m).is_err());
    }

    /// A void lot may be closed with its units; a valid one only empty.
    #[test]
    fn a_void_lot_closes_with_its_units() {
        let data = ix2::CloseLot { close_issue: 0 }.to_bytes().to_vec();
        let i = ix(
            data,
            &[
                SESSION, [0; 32], [0; 32], ME, ISSUE, VAULT, [0; 32], LOT, [0; 32],
            ],
        );
        let mut freed = the_issue();
        freed.supply = 0;
        let mut m = Mock {
            before: HashMap::from([
                (ME, citizen(11, WALLET, 1, 1, 1)),
                (VAULT, vault(YOU, 2)),
                (ISSUE, issue_bytes(&the_issue())),
                (LOT, lot_bytes(&the_lot())),
            ]),
            after: HashMap::from([(LOT, None), (ISSUE, Some(issue_bytes(&freed)))]),
        };
        assert_eq!(judge_close(&i, &m), Ok(()));
        m.before.insert(VAULT, vault(ME, 1));
        assert!(judge_close(&i, &m).is_err());
    }

    #[test]
    fn supplies_match_the_lots() {
        let mut half = the_lot();
        half.amount = 5;
        let finals = vec![
            (ISSUE, issue_bytes(&the_issue())),
            (LOT, lot_bytes(&half)),
            (NEW_LOT, lot_bytes(&half)),
        ];
        assert!(supplies(&finals).is_empty());
        assert_eq!(supplies(&finals[..2]).len(), 1);
    }

    fn shared(mut d: Vec<u8>, wood: i64) -> Vec<u8> {
        d[VA::SHARES_ON] = 1;
        d[VA::SHARES_SEQ..VA::SHARES_SEQ + 4].copy_from_slice(&0u32.to_le_bytes());
        d[VA::SHARES_ISSUER_TAG..VA::SHARES_ISSUER_TAG + 8].copy_from_slice(&11u64.to_le_bytes());
        d[VA::store(1)..VA::store(1) + 8].copy_from_slice(&(wood * 1_000).to_le_bytes());
        d
    }

    fn share_issue(supply: u64) -> Issue {
        Issue {
            kind: KIND_SHARE,
            resource: 0,
            per_unit: 0,
            supply,
            ..the_issue()
        }
    }

    fn deposit_lot(holder: Key, amount: u64) -> Lot {
        let tag = frontier_abi::addr::citizen_tag(&holder);
        Lot {
            kind: KIND_SHARE,
            holder,
            holder_tag: tag,
            seed_tag: tag,
            seq: frontier_abi::v2::addr::deposit_seq(11, 0),
            amount,
            ..the_lot()
        }
    }

    /// A delivery of 50 wood into a 100-wood vault of 100 units mints 50
    /// into the holder's new deposit lot; one unit more (T62's shape) fails.
    #[test]
    fn a_deposit_mints_by_the_rule() {
        use frontier_abi::v2::layout::s1::caravan as CV;
        const CARAVAN: Key = [10; 32];
        let mut cb = vec![0u8; CV::SIZE];
        cb[CV::OWNER_CITIZEN..CV::OWNER_CITIZEN + 32].copy_from_slice(&YOU);
        let data = ix2::SettleDeposit {
            beneficiary: [0; 32],
        }
        .to_bytes()
        .to_vec();
        let i = ix(
            data,
            &[
                SESSION, [0; 32], CARAVAN, VAULT, [0; 32], [0; 32], ISSUE, NEW_LOT,
            ],
        );
        let mut m = Mock {
            before: HashMap::from([
                (CARAVAN, cb),
                (VAULT, shared(vault(ME, 1), 100)),
                (ISSUE, issue_bytes(&share_issue(100))),
            ]),
            after: HashMap::from([
                (CARAVAN, None),
                (VAULT, Some(shared(vault(ME, 1), 150))),
                (ISSUE, Some(issue_bytes(&share_issue(150)))),
                (NEW_LOT, Some(lot_bytes(&deposit_lot(YOU, 50)))),
            ]),
        };
        assert_eq!(judge_deposit(&i, &m), Ok(()));
        m.after
            .insert(NEW_LOT, Some(lot_bytes(&deposit_lot(YOU, 51))));
        assert!(judge_deposit(&i, &m).is_err());
    }

    /// 40 of 100 units take 40 of 100 wood; a vault that pays more (T63's
    /// shape) fails.
    #[test]
    fn a_withdrawal_pays_the_basket() {
        let data = ix2::WithdrawShares {
            seq: 0,
            amount: 40,
            dst_kind: 1,
            dst_p: 0,
            dst_q: 0,
            dst_at: 0,
            dst_gen: 1,
            steps: 0,
            path: [0; 12],
            fee: 0,
        }
        .to_bytes()
        .to_vec();
        let i = ix(data, &[SESSION, [0; 32], [0; 32], ME, LOT, ISSUE, VAULT]);
        let mine = deposit_lot(ME, 100);
        let mut m = Mock {
            before: HashMap::from([
                (VAULT, shared(vault(ME, 1), 100)),
                (ISSUE, issue_bytes(&share_issue(100))),
                (LOT, lot_bytes(&mine)),
            ]),
            after: HashMap::from([
                (VAULT, Some(shared(vault(ME, 1), 60))),
                (ISSUE, Some(issue_bytes(&share_issue(60)))),
                (LOT, Some(lot_bytes(&Lot { amount: 60, ..mine }))),
            ]),
        };
        assert_eq!(judge_withdraw(&i, &m), Ok(()));
        m.after.insert(VAULT, Some(shared(vault(ME, 1), 59)));
        assert!(judge_withdraw(&i, &m).is_err());
    }
}
