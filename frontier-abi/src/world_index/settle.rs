//! **Experimental, opt-in** (`--features world-index-experimental`): the
//! **pure** part of a wide transit settlement — the quota over full
//! identities, the outcome of a march against the resolved final set and
//! the post-judgement payment plan — as functions of decoded records and
//! nothing else. No account is read here; the program's
//! `proc::wide::settle_transit` applies the plan, and a keeper predicts
//! from it. One table, called by both; nothing is duplicated.
//!
//! Moved here unchanged from `permutation-frontier/src/proc/wide.rs`
//! (the program re-exports every item under its old path and wraps
//! [`plan_settlement`]'s `None` into its `Overflow`), so the program's
//! own tests of these functions keep their meaning.

use super::arrival::{wide_arrival as AR, WideArrival};
use super::key::{ProvinceKey, WideHostRef};
use super::march::{wide_slot_key, WideTransit};
use crate::log::transit_outcome as TO;
use permutation_rules::frontier::clash::SlotRefusal;
use permutation_rules::frontier::host::{rout_survivors, DESTROYED_BELOW};

/// An arrival in the quota's terms: the full host reference, the owner
/// Citizen's key and the departure mass.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct WideSlotEntry {
    pub host: WideHostRef,
    pub citizen: [u8; 32],
    pub troops: u32,
}

/// Where a revealed wide arrival goes (the kernel's `SlotDecision` over
/// full identities).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WideSlotDecision {
    Fill { slot: u8 },
    Displace { slot: u8, displaced: WideSlotEntry },
    Refuse(SlotRefusal),
}

/// The kernel's `admit_arrival` (design §6.2, A3) over full identities:
/// one arrival per host (`AlreadyIn`); one per Citizen (a larger host of
/// the same Citizen displaces, a smaller is `CitizenHasLarger`); a free
/// slot fills; else the lowest-ranked present arrival is displaced when
/// outranked (`Full` otherwise). The rank is the deployed one with the
/// wide formulas in place of the legacy ones: more troops first, then
/// `march::wide_slot_key(dest, bell, host)` (the domain-separated
/// full-identity key, where the kernel hashes the dense id), then the host
/// reference bytes. No packed alias enters the rank.
pub fn wide_admit(
    dest: ProvinceKey,
    bell: u32,
    slots: &[Option<WideSlotEntry>; 4],
    x: WideSlotEntry,
) -> WideSlotDecision {
    use core::cmp::Reverse;
    if slots.iter().flatten().any(|e| e.host == x.host) {
        return WideSlotDecision::Refuse(SlotRefusal::AlreadyIn);
    }
    let rank = |e: &WideSlotEntry| {
        (
            Reverse(e.troops),
            wide_slot_key(dest, bell, &e.host),
            e.host.to_bytes(),
        )
    };
    if let Some((i, e)) = slots
        .iter()
        .enumerate()
        .find_map(|(i, e)| e.filter(|e| e.citizen == x.citizen).map(|e| (i, e)))
    {
        return if rank(&x) < rank(&e) {
            WideSlotDecision::Displace {
                slot: i as u8,
                displaced: e,
            }
        } else {
            WideSlotDecision::Refuse(SlotRefusal::CitizenHasLarger)
        };
    }
    if let Some(i) = slots.iter().position(Option::is_none) {
        return WideSlotDecision::Fill { slot: i as u8 };
    }
    let mut low: Option<(usize, WideSlotEntry)> = None;
    for (i, e) in slots.iter().enumerate() {
        if let Some(e) = e {
            if low.is_none_or(|(_, l)| rank(e) >= rank(&l)) {
                low = Some((i, *e));
            }
        }
    }
    match low {
        Some((i, e)) if rank(&x) < rank(&e) => WideSlotDecision::Displace {
            slot: i as u8,
            displaced: e,
        },
        _ => WideSlotDecision::Refuse(SlotRefusal::Full),
    }
}

/// How a wide transit ends (the deployed `transit::Outcome`, §5.11 D5).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WideOutcome {
    /// Codes 1, 2, 4, 5: the host is destroyed; `fate` is its final-set
    /// fate when it was in one (a Stays/Withdrew host is forfeited).
    BadSeal { code: u8, fate: Option<u8> },
    /// In the resolved final set with this fate (1–5).
    Fate(u8),
    /// Not in the final set and outranked by it: bounce, no loss.
    BounceUnranked,
    /// Not in the final set but it would have been admitted (not
    /// revealed), or no resolved inputs: routed.
    Routed { resolved: bool },
}

impl WideOutcome {
    /// The `TRANSIT_SETTLED.outcome` code, as deployed.
    pub const fn code(self) -> u8 {
        match self {
            WideOutcome::BadSeal { .. } => TO::BAD_SEAL,
            WideOutcome::Fate(f) => f,
            WideOutcome::BounceUnranked => TO::BOUNCED_UNRANKED,
            WideOutcome::Routed { .. } => TO::ROUTED,
        }
    }
}

/// The deployed `valid_outcome` over the wide records: the host's
/// final-set fate if it is in `set` (its faction's four positions); else,
/// against the present records, [`wide_admit`] refusing it is a bounce by
/// rank and anything it would have been admitted to is a rout; no resolved
/// final set is a rout nobody resolved.
pub fn wide_valid_outcome(
    dest: ProvinceKey,
    arrive: u32,
    me: WideSlotEntry,
    set: Option<&[Option<WideArrival>; 4]>,
) -> WideOutcome {
    let Some(set) = set else {
        return WideOutcome::Routed { resolved: false };
    };
    if let Some(a) = set
        .iter()
        .flatten()
        .find(|a| a.present && a.host == me.host)
    {
        return WideOutcome::Fate(a.fate);
    }
    let mut slots = [None; 4];
    for (s, a) in slots.iter_mut().zip(set.iter()) {
        if let Some(a) = a {
            if a.present {
                *s = Some(WideSlotEntry {
                    host: a.host,
                    citizen: a.citizen,
                    troops: a.dep_mass,
                });
            }
        }
    }
    match wide_admit(dest, arrive, &slots, me) {
        WideSlotDecision::Refuse(_) => WideOutcome::BounceUnranked,
        WideSlotDecision::Fill { .. } | WideSlotDecision::Displace { .. } => {
            WideOutcome::Routed { resolved: true }
        }
    }
}

/// A payment's recipient in a settlement plan.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PayTo {
    /// The host's own slot's beneficiary.
    SlotBeneficiary,
    /// The holding's immutable rent payer.
    RentPayer,
    /// The resolver the ClashInputs names.
    Resolver,
    /// The settler's beneficiary (the bad-seal reward).
    SettleBeneficiary,
    /// Kept in the holding as `pool_owed`.
    PoolOwed,
}

/// The pure post-judgement plan of a transit settlement (the deployed
/// outcome table of `proc::transit`, order-free): what each escrowed part
/// pays to whom, whether a Stays/Withdrew entry at the destination is
/// forfeited, whether the host stays, and the values a returning host
/// comes home with. Nothing here reads an account; the handler applies it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SettlementPlan {
    pub outcome: WideOutcome,
    /// `tip + fee + bond`, the escrow this march holds.
    pub total: u64,
    pub tip: (u64, PayTo),
    pub fee: (u64, PayTo),
    pub bond: (u64, PayTo),
    pub reward: (u64, PayTo),
    pub forfeit: bool,
    pub stays: bool,
    /// `(troops, stamina, routed)` of a host that comes home.
    pub returns: Option<(u32, u16, bool)>,
}

/// | branch | tip | march fee | bond |
/// |---|---|---|---|
/// | bad seal | reward (all three to the settle beneficiary); Stays/Withdrew forfeited | | |
/// | in the final set, fate 1–5 | its slot's beneficiary (`pool_owed` when its slot is gone) | resolver | rent payer |
/// | outranked (bounce) | rent payer | resolver | rent payer |
/// | would have been admitted (routed) | `pool_owed` | resolver | rent payer |
/// | no resolved inputs (routed) | `pool_owed` | `pool_owed` | rent payer |
///
/// Returning values: Bounced/Retreated from the record (`troops_after`,
/// its arrival stamina); an outranked bounce the transit's post-origin
/// values; a routed host `rout_survivors`, stamina 0; below
/// `DESTROYED_BELOW` nothing returns. `None` when `tip + fee + bond`
/// overflows (the program's `Overflow`).
pub fn plan_settlement(
    outcome: WideOutcome,
    t: &WideTransit,
    rec: Option<&WideArrival>,
    fee: u64,
    bond: u64,
    own_slot: bool,
) -> Option<SettlementPlan> {
    let total = t.tip.checked_add(fee)?.checked_add(bond)?;
    let zero = (0u64, PayTo::PoolOwed);
    match outcome {
        WideOutcome::BadSeal { fate, .. } => Some(SettlementPlan {
            outcome,
            total,
            tip: zero,
            fee: zero,
            bond: zero,
            reward: (total, PayTo::SettleBeneficiary),
            forfeit: matches!(fate, Some(AR::FATE_STAYS) | Some(AR::FATE_WITHDREW)),
            stays: false,
            returns: None,
        }),
        _ => {
            let resolved = matches!(
                outcome,
                WideOutcome::Fate(_)
                    | WideOutcome::BounceUnranked
                    | WideOutcome::Routed { resolved: true }
            );
            let tip_to = match outcome {
                WideOutcome::Fate(_) => {
                    if own_slot {
                        PayTo::SlotBeneficiary
                    } else {
                        PayTo::PoolOwed
                    }
                }
                WideOutcome::BounceUnranked => PayTo::RentPayer,
                _ => PayTo::PoolOwed,
            };
            let fee_to = if resolved {
                PayTo::Resolver
            } else {
                PayTo::PoolOwed
            };
            let returns = match outcome {
                WideOutcome::Fate(AR::FATE_BOUNCED) | WideOutcome::Fate(AR::FATE_RETREATED) => {
                    rec.map(|r| (r.troops_after, r.stamina, false))
                }
                WideOutcome::BounceUnranked => Some((t.troops_after, t.stamina_after, false)),
                WideOutcome::Routed { .. } => Some((rout_survivors(t.troops_after), 0, true)),
                _ => None,
            }
            .filter(|(troops, _, _)| *troops >= DESTROYED_BELOW);
            Some(SettlementPlan {
                outcome,
                total,
                tip: (t.tip, tip_to),
                fee: (fee, fee_to),
                bond: (bond, PayTo::RentPayer),
                reward: zero,
                forfeit: false,
                stays: matches!(
                    outcome,
                    WideOutcome::Fate(AR::FATE_STAYS) | WideOutcome::Fate(AR::FATE_WITHDREW)
                ),
                returns,
            })
        }
    }
}
