//! Wide economy **preview** (`wide-world-experimental`): the S1 owner
//! actions Harvest, Build and Train staged over detached `Vec` copies of a
//! wide holding and its wide province. A host-only, detached preview: no
//! `AccountInfo`, no wire route, no event, no write to anything the caller
//! owns. The kernel diagnostic calls reached through the existing helpers
//! (`error.rs` 112-117) are no-ops on the native host, and the wide
//! feature is forbidden on the Solana target (`lib.rs` 49-50), so nothing
//! here runs on chain today; any future target support must revisit this
//! purity claim rather than inherit it.
//!
//! The wide holding's 1,280-byte prefix is the Holding v2 layout unchanged
//! (reviewed finding: the S1 economy reads and writes it through the same
//! offsets as a legacy holding), so the deployed `proc::holding` helpers
//! run over a copy of the whole record. Only what the deployed handlers
//! write changes in the staged bytes: the kernel block, the owner-action
//! and dormancy fields, the intro-build flag, the state on a due flip, the
//! reserve, and for walls and the tier-up the province's site mirror. The
//! trailer, chain header (seq, head), owner, generation, escrow, transits,
//! host identity, rent, pool debt and shield are copied untouched.
//!
//! **What a preview is not.** The inputs are byte snapshots with the
//! identity the caller expects, supplied separately from the bytes. A
//! snapshot that passes has met the identity and state checks listed on
//! [`preview`] and nothing more: not that every field of either record is
//! self-consistent, not that either account exists at its canonical
//! address, not that the snapshot is fresh, not that the named Citizen
//! owns anything now, not that anyone is authorised to act.
//! The outputs are **not instruction data and not authorised writes**:
//! nothing here may be copied into an account or sent anywhere. The checks
//! a handler runs and this module does **not** are listed on [`preview`].
//!
//! Numbers and rules come from the existing helpers only: costs and
//! seconds from `arms::building`, `catalog::tier_up_item` and
//! `holding::train_cost`; the pay-then-enqueue order, the mirror writes
//! and the finality predicate from `proc::holding` and
//! `frontier_abi::prologue`. No constant is restated here.

use alloc::vec::Vec;

use frontier_abi::prologue as ap;
use frontier_abi::world_index::{WideCoord, WideHolding, WideProvince, WorldId};
use permutation_rules::frontier::arms;
use permutation_rules::frontier::catalog::{self, Cost};
use permutation_rules::frontier::doctrine::of_faction_v3;
use permutation_rules::frontier::holding::{Effect, Tier, MAX_WALLS};

use crate::error::{kernel, BAD_ACCOUNT, OVERFLOW};
use crate::layout::{holding as H, province as P, site as SM, site2 as SM2, Ro, Rw};
use crate::proc::conquest::capture_lock;
use crate::proc::holding::{
    self as hold, copy_number, holding_err, read_holding, terrain_ore, touch, train_cost,
    write_holding, ITEM_TIER_UP,
};
use crate::{FrontierError, R};

// ------------------------------------------------------------ inputs

/// The owner action to stage (the S1 Harvest, Build and Train bodies).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Action {
    /// Settle and touch; the stores move, nothing is bought.
    Harvest,
    /// Build item: 0–5 the buildings, 6 walls, 7 the tier-up, 8 the
    /// workshop (`proc::holding` module note; `BadData` otherwise).
    Build { item: u8 },
    /// Train `n` whole troops of `unit` into the reserve, paid at once.
    Train { unit: u8, n: u32 },
}

/// The identity the caller expects both records to carry. Every field is
/// compared to what the bytes say; a mismatch is a refusal, never a
/// correction. These pins are the caller's assertion, not a proof.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Pins {
    pub season_id: u64,
    pub world: WorldId,
    pub coord: WideCoord,
    pub site: u8,
    pub gen: u8,
    /// The Citizen slot (2 or 3); also the holding's stored `order`.
    pub slot: u8,
    pub owner_citizen: [u8; 32],
}

/// The season clock the caller asserts: the genesis the bell is counted
/// from and the moment the action is previewed at. Neither is read from
/// any Season account here.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Clock {
    pub genesis_ts: i64,
    pub now_ts: i64,
}

// ------------------------------------------------------------ outputs

/// What the staged action did (costs in milli-units, as the kernel pays).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    Harvest,
    Build {
        item: u8,
        cost: Cost,
        /// When the queued item completes (seconds, the kernel's clock).
        done_at: i64,
    },
    Train {
        unit: u8,
        n: u32,
        cost: Cost,
        /// `reserve[unit]` after the credit.
        reserve: u32,
    },
}

/// The detached result of [`preview`]. Not instruction data; not an
/// authorised write; a scratch image a reader may inspect and must not
/// apply.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Preview {
    /// The whole wide holding record (prefix and trailer) after the action.
    pub holding: Vec<u8>,
    /// The whole wide province record after a walls or tier-up Build, which
    /// are the only actions that write the site mirror; `None` otherwise.
    pub province: Option<Vec<u8>>,
    pub outcome: Outcome,
    /// The lazy provisional → final flip was due and is staged in
    /// `holding` (the state byte alone, as a wide holding's flip is; no
    /// Citizen flag, no `HOLDING_FINAL` record).
    pub became_final: bool,
    /// `bell_at(genesis_ts, now_ts)`.
    pub now_bell: u32,
}

// ------------------------------------------------------------ preview

/// Stages `action` over copies of `holding` (exactly `wide_holding::SIZE`
/// bytes) and `province` (exactly the wide `province::SIZE`), both of the
/// identity in `pins`, at `clock`. The caller's slices are never written;
/// on any `Err` nothing is returned and nothing has changed.
///
/// Checked here, in this preview's own order (the deployed handlers
/// interleave account loading, authorisation and argument checks, so which
/// refusal wins for a given invalid input may differ from theirs): both
/// records decode (`WideHolding::read`, `WideProvince::read`: magic,
/// versions, status, reserved bytes, a wide coordinate, slot 2 or 3, no
/// debit without a host identity); every pin equals the record
/// (`BadAccount`; the owner pin `NotOwner`); the province names the same
/// season, world and coordinate; the prefix `order` equals the slot; the
/// holding is live (`NotFinal`); the v2 capture lock on the site mirror
/// (`CapturePending`); the mirror shows this holding at this generation
/// (`BadAccount`; the deployed Harvest and Train do not read the mirror, so
/// this one check is stricter than theirs, which does not make the preview
/// as a whole at least as strict as execution: the list below is omitted);
/// the bell exists (`WrongStatus` before genesis); then `finality_due` over
/// the staged bytes and the action body.
///
/// **Not checked here, and required before any execution:** the Season
/// account (PDA, status Running, ruleset hash, end bell, the wide season
/// marker and the world it binds); the actor's signature or session, or an
/// NFT resident's proof and holder generation; the payer; the canonical
/// addresses of the holding and the province and their program owner;
/// account writability; the Citizen account (that its slot binds this
/// holding, its action bucket, its flags and last action); the freshness
/// of both snapshots against the chain; the event chain (no HARVEST, BUILD,
/// TRAIN or HOLDING_FINAL record is produced and no chain head or sequence
/// moves). A passing preview authorises nothing.
pub fn preview(
    holding: &[u8],
    province: &[u8],
    pins: &Pins,
    clock: &Clock,
    action: Action,
) -> R<Preview> {
    let hh = checked_pair(holding, province, pins)?;
    let now = clock.now_ts;
    let now_bell = ap::bell_at(clock.genesis_ts, now).ok_or(FrontierError::WrongStatus)?;
    let mut hd = holding.to_vec();
    // The lazy flip, on the staged copy only (an outpost's: state alone).
    let became_final = ap::finality_due(&hh, province, now, now_bell);
    if became_final {
        Rw(&mut hd).set_u8(H::STATE, H::STATE_FINAL)?;
    }
    let (outcome, pd) = match action {
        Action::Harvest => {
            harvest(&mut hd, now)?;
            (Outcome::Harvest, None)
        }
        Action::Build { item } => build(&mut hd, province, &hh, clock, item)?,
        Action::Train { unit, n } => (train(&mut hd, now, unit, n)?, None),
    };
    Ok(Preview {
        holding: hd,
        province: pd,
        outcome,
        became_final,
        now_bell,
    })
}

/// The identity checks of [`preview`]: both records against the pins and
/// each other, the live state, the capture lock, the site mirror. Returns
/// the header the finality predicate reads (`p`, `q` zero: wide).
fn checked_pair(hd: &[u8], pd: &[u8], pins: &Pins) -> R<ap::HoldingHdr> {
    let rec = WideHolding::read(hd).map_err(|_| BAD_ACCOUNT)?;
    let prov = WideProvince::read(pd).map_err(|_| BAD_ACCOUNT)?;
    if rec.season_id != pins.season_id
        || rec.world != pins.world
        || rec.coord != pins.coord
        || rec.site != pins.site
        || rec.gen != pins.gen
        || rec.slot != pins.slot
    {
        return Err(BAD_ACCOUNT);
    }
    if rec.owner_citizen != pins.owner_citizen {
        return Err(FrontierError::NotOwner.into());
    }
    if prov.season_id != rec.season_id || prov.world != rec.world || prov.coord != rec.coord {
        return Err(BAD_ACCOUNT);
    }
    let r = Ro(hd);
    if r.u8(H::ORDER)? != rec.slot {
        return Err(BAD_ACCOUNT);
    }
    let hh = ap::HoldingHdr {
        p: 0,
        q: 0,
        site: rec.site,
        gen: rec.gen,
        state: r.u8(H::STATE)?,
        ticket_bell: r.u32(H::TICKET_BELL)?,
        final_ts: r.i64(H::FINAL_TS)?,
    };
    if hh.state != H::STATE_PROVISIONAL && hh.state != H::STATE_FINAL {
        return Err(FrontierError::NotFinal.into());
    }
    capture_lock(pd, hh.site, hh.gen)?;
    hold::site_of(pd, &hh)?;
    Ok(hh)
}

// ------------------------------------------------------------ bodies

/// Harvest's body: the owner touch, written back.
fn harvest(hd: &mut [u8], now: i64) -> R<()> {
    let ore = terrain_ore(hd)?;
    let mut h = read_holding(hd)?;
    touch(&mut h, now, ore)?;
    write_holding(hd, &h, now)
}

/// Build's body, substep for substep as the deployed handler's (the
/// refusal that wins for an invalid argument may differ from the
/// handler's, which checks its arguments earlier): item range, the touch,
/// the faction's doctrine, cost and seconds (one tier-up at a time:
/// `QueueFull`; the intro-build timing for a building while the flag is
/// set, consumed by the write), pay, enqueue, the mirror item for walls or
/// the tier-up on a province copy, the holding written, the flag cleared.
fn build(
    hd: &mut [u8],
    province: &[u8],
    hh: &ap::HoldingHdr,
    clock: &Clock,
    item: u8,
) -> R<(Outcome, Option<Vec<u8>>)> {
    if item > ITEM_TIER_UP && item != arms::ITEM_WORKSHOP {
        return Err(FrontierError::BadData.into());
    }
    let walls = item == catalog::ITEM_WALLS;
    let tier_up = item == ITEM_TIER_UP;
    let now = clock.now_ts;
    let ore = terrain_ore(hd)?;
    let mut h = read_holding(hd)?;
    touch(&mut h, now, ore)?;
    let doctrine = of_faction_v3(Ro(hd).u8(H::FACTION)?).ok_or(BAD_ACCOUNT)?;
    let (cost, effect, secs) = if tier_up {
        if h.queue
            .iter()
            .flatten()
            .any(|q| matches!(q.effect, Effect::TierUp))
        {
            return Err(FrontierError::QueueFull.into());
        }
        catalog::tier_up_item(h.tier).ok_or_else(|| kernel(hold::sub::HOLDING_TOP_TIER))?
    } else {
        let n = if walls {
            1
        } else {
            copy_number(&h, item, ore)?
        };
        arms::building(item, n, doctrine).ok_or(FrontierError::BadData)?
    };
    let intro =
        item < catalog::ITEM_WALLS && Ro(hd).u8(H::FLAGS)? & H::FLAG_INTRO_BUILD_AVAILABLE != 0;
    let secs = if intro { H::INTRO_BUILD_SECS } else { secs };
    h.pay(now, &cost).map_err(holding_err)?;
    let done_at = h.enqueue(now, secs as i64, effect).map_err(holding_err)?;
    let pd = if walls || tier_up {
        let mut pd = province.to_vec();
        let eff = ap::bell_at(clock.genesis_ts, done_at)
            .and_then(|b| b.checked_add(1))
            .ok_or(OVERFLOW)?;
        if walls {
            wall_item(&mut pd, hh, eff, catalog::WALL_STEP)?;
        } else {
            tier_next_item(&mut pd, hh, tier_u8(h.tier), eff)?;
        }
        Some(pd)
    } else {
        None
    };
    write_holding(hd, &h, now)?;
    if intro {
        let flags = Ro(hd).u8(H::FLAGS)?;
        Rw(hd).set_u8(H::FLAGS, flags & !H::FLAG_INTRO_BUILD_AVAILABLE)?;
    }
    Ok((
        Outcome::Build {
            item,
            cost,
            done_at,
        },
        pd,
    ))
}

/// The wall item of the site mirror, as `proc::holding::wall_item` writes
/// it: the items already in force (`effective_bell ≤ resolved_next`) fold
/// into `walls_committed` (saturating, capped at `MAX_WALLS`) and free
/// their slot; `{eff, delta}` goes into a free item; both busy →
/// `QueueFull`.
fn wall_item(pd: &mut [u8], hh: &ap::HoldingHdr, eff: u32, delta: u32) -> R<()> {
    let o = P::site(hold::site_of(pd, hh)?);
    let mut w = Rw(pd);
    let resolved_next = w.u32(P::RESOLVED_NEXT)?;
    let items = [
        (SM::WALL_ITEM0_BELL, SM::WALL_ITEM0_DELTA),
        (SM::WALL_ITEM1_BELL, SM::WALL_ITEM1_DELTA),
    ];
    let mut committed = w.u32(o + SM::WALLS_COMMITTED)?;
    for (b, dl) in items {
        let (ib, idl) = (w.u32(o + b)?, w.u32(o + dl)?);
        if idl > 0 && ib <= resolved_next {
            committed = committed.saturating_add(idl).min(MAX_WALLS);
            w.set_u32(o + b, 0)?;
            w.set_u32(o + dl, 0)?;
        }
    }
    w.set_u32(o + SM::WALLS_COMMITTED, committed)?;
    for (b, dl) in items {
        if w.u32(o + dl)? == 0 {
            w.set_u32(o + b, eff)?;
            w.set_u32(o + dl, delta)?;
            return Ok(());
        }
    }
    Err(FrontierError::QueueFull.into())
}

/// The tier-up's mirror item, as `proc::holding::tier_next_item` writes
/// it: `tier` = the kernel tier now (an earlier, finished tier-up folded),
/// `tier_next = tier + 1`, `tier_next_bell = bell_at(done_at) + 1`.
fn tier_next_item(pd: &mut [u8], hh: &ap::HoldingHdr, tier_now: u8, eff: u32) -> R<()> {
    let next = tier_now.checked_add(1).ok_or(OVERFLOW)?;
    let o = P::site(hold::site_of(pd, hh)?);
    let mut w = Rw(pd);
    w.set_u8(o + SM::TIER, tier_now)?;
    w.set_u8(o + SM2::TIER_NEXT, next)?;
    w.set_u32(o + SM2::TIER_NEXT_BELL, eff)
}

/// `Tier` as the Holding layout stores it (declaration order, pinned in
/// `proc::holding`; its own encoder is private to that file).
fn tier_u8(t: Tier) -> u8 {
    match t {
        Tier::Hamlet => 0,
        Tier::Town => 1,
        Tier::City => 2,
        Tier::Stronghold => 3,
    }
}

/// Train's body, substep for substep as the deployed handler's (refusal
/// precedence for an invalid unit or count may differ): the S1 cost
/// (`train_cost`, `BadData` for an unknown unit), the touch, pay, the
/// holding written, then the whole reserve credited by checked addition
/// (`Overflow`). All of it on the staged copy, so a refusal after the pay
/// leaves the caller's bytes as they were.
fn train(hd: &mut [u8], now: i64, unit: u8, n: u32) -> R<Outcome> {
    let cost = train_cost(unit, n).ok_or(FrontierError::BadData)?;
    if unit as usize >= H::RESERVE_N {
        return Err(FrontierError::BadData.into());
    }
    let ore = terrain_ore(hd)?;
    let mut h = read_holding(hd)?;
    touch(&mut h, now, ore)?;
    h.pay(now, &cost).map_err(holding_err)?;
    write_holding(hd, &h, now)?;
    let at = H::reserve(unit as usize);
    let mut w = Rw(hd);
    w.add_u32(at, n)?;
    let reserve = w.u32(at)?;
    Ok(Outcome::Train {
        unit,
        n,
        cost,
        reserve,
    })
}

#[cfg(test)]
#[path = "wide_economy_tests.rs"]
mod tests;
