//! Read-only, opt-in planning of WideClaimDefence (0xDC op 6).
//!
//! The caller selects 1..=6 **full** wide slot identities and a claim day.
//! The day must be the observed Clock's current day, not the slots' day.
//! Every slot, live BellAnchor, shared DefencePool and shared keeper-day
//! DefenceClaim is read at its canonical address under a pinned Season.
//! No archive substitutes for a live anchor. The same deployed claim is
//! used by legacy and wide claims; its `claimed` counter is actual paid
//! lamports, not nominal refunds. The region cap applies per (bell,
//! region) **within this call only**, never globally.
//!
//! Source of truth: `proc/wide_defence_exec.rs::claim_defence`. The
//! refund uses the rules crate's `defence_refund` and the slot's own
//! `evidence()`, including FLAG_CREATED_DAY. The handler's caps and
//! checked counters are replayed without modifying the input bytes.
//! All selected slots become claimed even when caps or an empty pool
//! make payment zero. This operation neither closes slots nor refunds
//! their rent. Claim creation needs only its prefund shortfall, paid by
//! the keeper **before** the pool payment.
//!
//! [`required_keys`] bounds one read to at most sixteen distinct accounts
//! plus Clock and Rent. [`plan_snapshot`] judges only a sealed snapshot;
//! a missing key is an incomplete snapshot, never repaired from another
//! response. The lower-level [`plan_claim_defence`] also accepts ordinary
//! [`Reads`], whose predictions remain explicitly incoherent. A snapshot
//! attests same-response bytes at a context slot, not RPC authority,
//! freshness, signatures, or successful execution. A candidate's fields
//! are private and exposed only through immutable accessors, so its
//! provenance cannot be detached from its original instruction or facts.
//!
//! The keeper is conservatively restricted to a non-executable,
//! System-owned, data-less account, distinct from every state account.
//! This is a planner boundary, not an additional handler eligibility
//! rule. Fees, runtime rent transitions, allocation CPI and signatures
//! are not simulated. No keys, signing, admission, send or engine/tick
//! integration exists here; the existing gates remain closed.

use std::collections::{BTreeMap, BTreeSet};

use fclient::clock::SeasonClock;
use fclient::decode::{BellAnchor, DefenceClaim, DefencePool};
use fclient::ports::{Account, ClockSysvar};
use frontier_abi::addr::{day_of, defence_claim_seed, keeper_tag8};
use frontier_abi::layout::beacon::defence_claim as DC;
use frontier_abi::layout::world::{defence_pool as DP, season as S};
use frontier_abi::world_index::arrival::{self as wa, WideArrivalSlot};
use frontier_abi::world_index::rules::wide_region;
use frontier_abi::world_index::wide_ix::{self as wix, ClaimDefence};
use frontier_abi::world_index::{ProvinceKey, WorldId};
use permutation_rules::frontier::clash::FACTION_ARRIVAL_SLOTS;
use permutation_rules::frontier::fees::{
    defence_refund, min_tip_lamports, DefenceParams, Evidence,
};
use solana_address::Address;
use solana_instruction::Instruction;

use crate::wideduty::{
    addr, ctx_of, metas, missing, packet_len, presence, season_of, Block as DutyBlock, Reads,
    Scope, GATHER_PACKET_BYTES,
};
use crate::widesnapshot::{Snapshot, SnapshotMeta};

/// The selected identities require four shared accounts and two per slot.
/// Repeated live anchors are read once but remain repeated instruction metas.
pub const MAX_READ_KEYS: usize = 4 + 2 * DC::MAX_SLOTS;
pub const AUTOMATIC_SEND: bool = false;
pub const UNVERIFIED: [&str; 5] = [
    "Account ownership, layouts, identities and deployment pins are checked over the supplied bytes; neither RPC authority nor any signature is authenticated here.",
    "Snapshot coherence means one response at its context slot, never freshness or permission to execute. Ordinary or edited reads are incoherent.",
    "Refunds, caps, consumed slots, counters and balances are predictions, not observed transfers or successful transactions. Every selected slot is consumed even if paid is zero.",
    "The keeper funds claim creation before receiving the refund. Balances exclude transaction fees; no fee sufficiency, allocation CPI, runtime rent transition or transaction success is established.",
    "This candidate is unsigned and is not admitted, queued, simulated or sent. Existing production and legacy feed gates remain unchanged.",
];

/// Every component of a canonical wide slot address, including the full
/// world and wide coordinates. No shortened host aliases or feed hints.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SlotId {
    pub dest: ProvinceKey,
    pub bell: u32,
    pub faction: u8,
    pub i: u8,
}

impl SlotId {
    pub fn address(self, scope: &Scope) -> Address {
        addr(wa::arrival_slot_address(
            &ctx_of(scope),
            self.dest,
            self.bell,
            self.faction,
            self.i,
        ))
    }

    pub fn anchor(self, scope: &Scope) -> Address {
        addr(ctx_of(scope).bell_anchor(self.bell, wide_region(self.dest.coord())))
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Block {
    /// A reused pinned-season, ownership, read, or arithmetic check.
    Common(DutyBlock),
    SelectionCount(usize),
    SlotPosition {
        index: usize,
        faction: u8,
        i: u8,
    },
    DuplicateSlot {
        index: usize,
    },
    /// Conservative unsupported payer shape, not signature verification.
    KeeperShape,
    /// Conservative unsupported shared source/recipient identity.
    KeeperAlias,
    WrongDay {
        requested: u32,
        observed: u32,
    },
    ClaimIdentity,
    SlotIdentity {
        index: usize,
    },
    WrongBeneficiary {
        index: usize,
    },
    AlreadyClaimed {
        index: usize,
    },
    LiveAnchorRequired {
        index: usize,
    },
    AnchorIdentity {
        index: usize,
    },
    WindowClosed {
        index: usize,
        now: i64,
        grace_end: i64,
    },
    NotLate {
        index: usize,
        observed: u64,
        required: u8,
    },
    NoRefund {
        index: usize,
    },
    KeeperShortfall {
        balance: u64,
        needed: u64,
    },
    SnapshotRentRequired,
    SnapshotIncomplete(Vec<Address>),
    /// Conservative one-instruction wire-size bound under the existing
    /// widest budget prefix; no account or evidence is dropped to fit.
    PacketTooLarge {
        predicted: usize,
        max: usize,
    },
}

impl From<DutyBlock> for Block {
    fn from(b: DutyBlock) -> Self {
        Self::Common(b)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Step {
    Need(Vec<Address>),
    Done(Result<Candidate, Block>),
}

/// Evidence and cap admission for one slot, in the caller's order.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SlotFacts {
    pub identity: SlotId,
    pub address: Address,
    pub anchor: Address,
    pub region: u8,
    pub evidence: Evidence,
    pub evidence_slot: u64,
    pub anchor_slot: u64,
    pub anchor_ts: i64,
    pub reveal_close: i64,
    pub grace_end: i64,
    pub nominal_refund: u64,
    pub admitted_within_call: u64,
    /// True even when the eventual total payment is zero.
    pub predicted_claimed: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Balance {
    pub address: Address,
    pub before: u64,
    pub predicted_after: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ClaimFacts {
    pub day: u32,
    pub now_bell: u32,
    pub judged_at: i64,
    pub pool: Address,
    pub claim: Address,
    pub claim_present: bool,
    pub slots: Vec<SlotFacts>,
    pub per_bell_region_cap: u64,
    pub per_keeper_day_cap: u64,
    pub admitted_within_call: u64,
    pub day_room: u64,
    pub day_capped: u64,
    pub pool_rent_floor: u64,
    pub pool_available: u64,
    pub predicted_paid: u64,
    /// The event's partial bit: paid < day_capped. A day cap of zero
    /// makes this false, even when every nominal refund was positive.
    pub predicted_partial: bool,
    pub claimed_before: u64,
    pub predicted_claimed_after: u64,
    pub count_before: u32,
    pub predicted_count_after: u32,
    pub pool_paid_total_before: u64,
    pub predicted_pool_paid_total_after: u64,
    pub pool_claims_before: u64,
    pub predicted_pool_claims_after: u64,
    pub claim_rent_floor: u64,
    /// Zero for a present claim, else max(0, rent - prefunded lamports).
    pub creation_shortfall: u64,
    /// Keeper, pool, claim, in that order. Fees are not deducted.
    pub predicted_balances: [Balance; 3],
}

/// Immutable unsigned result. Cloning an instruction or facts does not
/// turn the changed clone into a candidate or preserve its provenance.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Candidate {
    instruction: Instruction,
    facts: ClaimFacts,
    keeper: Address,
    min_slot: u64,
    observed_clock: ClockSysvar,
    snapshot: Option<SnapshotMeta>,
    status_promoted_by_clock: bool,
    packet_bytes: usize,
}

impl Candidate {
    pub fn instruction(&self) -> &Instruction {
        &self.instruction
    }
    pub fn facts(&self) -> &ClaimFacts {
        &self.facts
    }
    pub fn keeper(&self) -> Address {
        self.keeper
    }
    pub fn min_slot(&self) -> u64 {
        self.min_slot
    }
    pub fn observed_clock(&self) -> ClockSysvar {
        self.observed_clock
    }
    pub fn snapshot(&self) -> Option<&SnapshotMeta> {
        self.snapshot.as_ref()
    }
    pub fn coherent(&self) -> bool {
        self.snapshot.is_some()
    }
    pub fn status_promoted_by_clock(&self) -> bool {
        self.status_promoted_by_clock
    }
    pub fn packet_bytes(&self) -> usize {
        self.packet_bytes
    }
    pub fn signed(&self) -> bool {
        false
    }
    pub fn automatic_send(&self) -> bool {
        AUTOMATIC_SEND
    }
    pub fn unverified(&self) -> &'static [&'static str] {
        &UNVERIFIED
    }
}

fn claim_address(scope: &Scope, keeper: Address, day: u32) -> Address {
    addr(ctx_of(scope).of(&defence_claim_seed(&keeper_tag8(&keeper.to_bytes()), day)))
}

/// Deterministic, deduplicated read set, bounded before scanning identities.
/// Supply this set plus Clock and Rent to the existing SnapshotPort. The
/// supplied claim day is checked again against that response's own Clock.
pub fn required_keys(
    scope: &Scope,
    keeper: Address,
    day: u32,
    selected: &[SlotId],
) -> Result<Vec<Address>, Block> {
    if selected.is_empty() || selected.len() > DC::MAX_SLOTS {
        return Err(Block::SelectionCount(selected.len()));
    }
    let ctx = ctx_of(scope);
    let world =
        WorldId::derive_legacy_season(&ctx.season, &ctx.program).map_err(|_| DutyBlock::World)?;
    let mut keys = vec![
        scope.season,
        addr(ctx.defence_pool()),
        claim_address(scope, keeper, day),
    ];
    let mut seen = BTreeSet::new();
    for (index, s) in selected.iter().enumerate() {
        if s.dest.world() != world {
            return Err(DutyBlock::World.into());
        }
        if s.faction >= 6 || s.i as usize >= FACTION_ARRIVAL_SLOTS {
            return Err(Block::SlotPosition {
                index,
                faction: s.faction,
                i: s.i,
            });
        }
        let slot = s.address(scope);
        if !seen.insert(slot) {
            return Err(Block::DuplicateSlot { index });
        }
        keys.push(slot);
        keys.push(s.anchor(scope));
    }
    if keeper == fclient::addr::system_program()
        || keeper == scope.program
        || keys.contains(&keeper)
    {
        return Err(Block::KeeperAlias);
    }
    keys.push(keeper);
    keys.sort_unstable();
    keys.dedup();
    Ok(keys)
}

fn lamports(reads: &Reads, address: &Address) -> u64 {
    reads
        .accounts
        .get(address)
        .and_then(Option::as_ref)
        .map_or(0, |a| a.lamports)
}

fn present<'a>(
    scope: &Scope,
    reads: &'a Reads,
    address: &Address,
    name: &'static str,
) -> Result<&'a Account, Block> {
    presence(reads, address, &scope.program, name)?.ok_or_else(|| DutyBlock::Absent(name).into())
}

fn overflow(name: &'static str) -> Block {
    DutyBlock::Overflow(name).into()
}

/// Plan over already supplied bytes. Need contains only canonical missing
/// keys, never keys taken from unchecked slot bytes. Input data is immutable.
pub fn plan_claim_defence(
    scope: &Scope,
    keeper: Address,
    day: u32,
    selected: &[SlotId],
    reads: &Reads,
) -> Step {
    let keys = match required_keys(scope, keeper, day, selected) {
        Ok(keys) => keys,
        Err(b) => return Step::Done(Err(b)),
    };
    let need = missing(reads, &keys);
    if !need.is_empty() {
        return Step::Need(need);
    }
    Step::Done(plan(scope, keeper, day, selected, reads))
}

/// The snapshot-only entry point. No I/O, retry, ordinary-read patching or
/// authentication is performed. Rent must be included in this same response.
pub fn plan_snapshot(
    scope: &Scope,
    keeper: Address,
    day: u32,
    selected: &[SlotId],
    snapshot: &Snapshot,
) -> Result<Candidate, Block> {
    if !snapshot.meta().rent_included() || snapshot.rent().is_none() {
        return Err(Block::SnapshotRentRequired);
    }
    match plan_claim_defence(scope, keeper, day, selected, &snapshot.reads()) {
        Step::Need(keys) => Err(Block::SnapshotIncomplete(keys)),
        Step::Done(result) => result,
    }
}

fn plan(
    scope: &Scope,
    keeper: Address,
    day: u32,
    selected: &[SlotId],
    reads: &Reads,
) -> Result<Candidate, Block> {
    // The shared decoder accepts the field prefix, but the deployed
    // prologue requires the full Season allocation (and permits longer).
    if present(scope, reads, &scope.season, "season")?.data.len() < S::SIZE {
        return Err(DutyBlock::Unreadable("season").into());
    }
    let (season, promoted) = season_of(scope, reads)?;
    let now = reads.clock.ok_or(DutyBlock::TimingNeedsClock)?;
    let clock = SeasonClock::from_season(&season);
    let now_bell = clock
        .bell_at(now.unix_timestamp)
        .ok_or(DutyBlock::Season("clock outside season bell range"))?;
    let observed = day_of(now_bell);
    if day != observed {
        return Err(Block::WrongDay {
            requested: day,
            observed,
        });
    }
    let ctx = ctx_of(scope);
    let pool_key = addr(ctx.defence_pool());
    let claim_key = claim_address(scope, keeper, day);
    let pool_acc = present(scope, reads, &pool_key, "defence pool")?;
    let pool =
        DefencePool::decode(&pool_acc.data).map_err(|_| DutyBlock::Unreadable("defence pool"))?;
    if pool.season_id != season.h.season_id {
        return Err(DutyBlock::NotCanonical("defence pool").into());
    }
    let claim_acc = presence(reads, &claim_key, &scope.program, "defence claim")?;
    let (claimed, count) = match claim_acc {
        Some(a) => {
            let c = DefenceClaim::decode(&a.data)
                .map_err(|_| DutyBlock::Unreadable("defence claim"))?;
            if c.season_id != season.h.season_id || c.beneficiary != keeper || c.day != day {
                return Err(Block::ClaimIdentity);
            }
            (c.claimed, c.count)
        }
        None => (0, 0),
    };
    if reads.accounts[&keeper].as_ref().is_some_and(|a| {
        a.owner != fclient::addr::system_program() || !a.data.is_empty() || a.executable
    }) {
        return Err(Block::KeeperShape);
    }
    let rent = reads
        .rent
        .as_ref()
        .ok_or(DutyBlock::RentSysvarMissing("defence claim"))?;
    let params = DefenceParams {
        defence_cap_milli: season.defence_cap_milli,
        tip_min: min_tip_lamports(
            season.min_reveal_priority_milli,
            season.reveal_cu_limit,
            season.reveal_loaded_limit,
        ),
    };
    let mut caps: BTreeMap<(u32, u8), u64> = BTreeMap::new();
    let mut total = 0u64;
    let mut slots = Vec::with_capacity(selected.len());
    for (index, id) in selected.iter().enumerate() {
        let slot_key = id.address(scope);
        let s = WideArrivalSlot::read(&present(scope, reads, &slot_key, "wide arrival slot")?.data)
            .map_err(|_| DutyBlock::Unreadable("wide arrival slot"))?;
        if s.season_id != season.h.season_id
            || s.dest != id.dest
            || s.bell != id.bell
            || s.faction != id.faction
            || s.i != id.i
        {
            return Err(Block::SlotIdentity { index });
        }
        if s.beneficiary != keeper.to_bytes() {
            return Err(Block::WrongBeneficiary { index });
        }
        if s.claimed {
            return Err(Block::AlreadyClaimed { index });
        }
        let region = wide_region(s.dest.coord());
        let anchor_key = id.anchor(scope);
        let anchor_acc = presence(reads, &anchor_key, &scope.program, "bell anchor")?
            .ok_or(Block::LiveAnchorRequired { index })?;
        let anchor = BellAnchor::decode(&anchor_acc.data)
            .map_err(|_| DutyBlock::Unreadable("bell anchor"))?;
        if anchor.season_id != season.h.season_id
            || anchor.bell != s.bell
            || anchor.region != region
        {
            return Err(Block::AnchorIdentity { index });
        }
        let close = clock.reveal_close(s.bell, anchor.a);
        let grace_end = close
            .checked_add(DC::CLAIM_GRACE_BELLS as i64 * 600)
            .ok_or_else(|| overflow("claim grace"))?;
        if now.unix_timestamp >= grace_end {
            return Err(Block::WindowClosed {
                index,
                now: now.unix_timestamp,
                grace_end,
            });
        }
        let late = s.ev_slot.saturating_sub(anchor.slot);
        if late < season.lateness_slots as u64 {
            return Err(Block::NotLate {
                index,
                observed: late,
                required: season.lateness_slots,
            });
        }
        let evidence = s.evidence();
        let refund = defence_refund(&evidence, &params);
        if refund == 0 {
            return Err(Block::NoRefund { index });
        }
        let used = caps.entry((s.bell, region)).or_default();
        let admitted = refund.min(pool.per_bell_region_cap.saturating_sub(*used));
        *used = used
            .checked_add(admitted)
            .ok_or_else(|| overflow("within-call region cap"))?;
        total = total
            .checked_add(admitted)
            .ok_or_else(|| overflow("claim refunds"))?;
        slots.push(SlotFacts {
            identity: *id,
            address: slot_key,
            anchor: anchor_key,
            region,
            evidence,
            evidence_slot: s.ev_slot,
            anchor_slot: anchor.slot,
            anchor_ts: anchor.a,
            reveal_close: close,
            grace_end,
            nominal_refund: refund,
            admitted_within_call: admitted,
            predicted_claimed: true,
        });
    }
    let day_room = pool.per_keeper_day_cap.saturating_sub(claimed);
    let capped = total.min(day_room);
    let pool_floor = rent
        .minimum_balance(DP::SIZE)
        .ok_or_else(|| overflow("pool rent"))?;
    let available = pool_acc.lamports.saturating_sub(pool_floor);
    let paid = capped.min(available);
    let claimed_after = claimed
        .checked_add(paid)
        .ok_or_else(|| overflow("claim claimed"))?;
    let count_after = count
        .checked_add(selected.len() as u32)
        .ok_or_else(|| overflow("claim count"))?;
    let pool_paid_after = pool
        .paid_total
        .checked_add(paid)
        .ok_or_else(|| overflow("pool paid total"))?;
    let pool_claims_after = pool
        .claims
        .checked_add(selected.len() as u64)
        .ok_or_else(|| overflow("pool claims"))?;
    let claim_floor = rent
        .minimum_balance(DC::SIZE)
        .ok_or_else(|| overflow("claim rent"))?;
    let claim_before = lamports(reads, &claim_key);
    let needed = if claim_acc.is_some() {
        0
    } else {
        claim_floor.saturating_sub(claim_before)
    };
    let keeper_before = lamports(reads, &keeper);
    let keeper_after = keeper_before
        .checked_sub(needed)
        .ok_or(Block::KeeperShortfall {
            balance: keeper_before,
            needed,
        })?
        .checked_add(paid)
        .ok_or_else(|| overflow("keeper balance"))?;
    let pool_after = pool_acc
        .lamports
        .checked_sub(paid)
        .ok_or_else(|| overflow("pool balance"))?;
    let claim_after = claim_before
        .checked_add(needed)
        .ok_or_else(|| overflow("claim balance"))?;
    let facts = ClaimFacts {
        day,
        now_bell,
        judged_at: now.unix_timestamp,
        pool: pool_key,
        claim: claim_key,
        claim_present: claim_acc.is_some(),
        slots,
        per_bell_region_cap: pool.per_bell_region_cap,
        per_keeper_day_cap: pool.per_keeper_day_cap,
        admitted_within_call: total,
        day_room,
        day_capped: capped,
        pool_rent_floor: pool_floor,
        pool_available: available,
        predicted_paid: paid,
        predicted_partial: paid < capped,
        claimed_before: claimed,
        predicted_claimed_after: claimed_after,
        count_before: count,
        predicted_count_after: count_after,
        pool_paid_total_before: pool.paid_total,
        predicted_pool_paid_total_after: pool_paid_after,
        pool_claims_before: pool.claims,
        predicted_pool_claims_after: pool_claims_after,
        claim_rent_floor: claim_floor,
        creation_shortfall: needed,
        predicted_balances: [
            Balance {
                address: keeper,
                before: keeper_before,
                predicted_after: keeper_after,
            },
            Balance {
                address: pool_key,
                before: pool_acc.lamports,
                predicted_after: pool_after,
            },
            Balance {
                address: claim_key,
                before: claim_before,
                predicted_after: claim_after,
            },
        ],
    };
    let fixed = [
        keeper,
        scope.season,
        pool_key,
        claim_key,
        fclient::addr::system_program(),
    ];
    let mut accounts = metas(&wix::CLAIM_DEFENCE[..1], &fixed);
    for s in &facts.slots {
        accounts.extend(metas(&wix::CLAIM_DEFENCE[1..], &[s.address, s.anchor]));
    }
    let data = ClaimDefence {
        day,
        n: selected.len() as u8,
    }
    .to_bytes()
    .ok_or(Block::SelectionCount(selected.len()))?
    .to_vec();
    let instruction = Instruction {
        program_id: scope.program,
        accounts,
        data,
    };
    let packet_bytes = packet_len(&instruction, &keeper);
    if packet_bytes > GATHER_PACKET_BYTES {
        return Err(Block::PacketTooLarge {
            predicted: packet_bytes,
            max: GATHER_PACKET_BYTES,
        });
    }
    Ok(Candidate {
        instruction,
        facts,
        keeper,
        min_slot: reads.min_slot,
        observed_clock: now,
        snapshot: reads.coherent_snapshot().cloned(),
        status_promoted_by_clock: promoted,
        packet_bytes,
    })
}
