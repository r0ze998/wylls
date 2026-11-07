//! **Read-only** (feature `wide-world-experimental`): what executing a wide
//! candidate would **require** of its fee payer, as far as trustworthy data
//! allows, with every assumption named and every unmet or unknown
//! requirement declared.
//!
//! **What the handler does.** `reveal` reads the fee evidence from the
//! instructions sysvar (`evidence::parse`): the `SetComputeUnitPrice`,
//! `SetComputeUnitLimit` and `SetLoadedAccountsDataSizeLimit` of the
//! transaction, **0 when absent** — a transaction without a ComputeBudget
//! prefix is accepted with default evidence (the legacy keeper's prefix is
//! policy, not a handler mandate). It creates the ArrivalSlot
//! (`wide_arrival_slot::SIZE`) when the arrival fills a free slot and the
//! ArrivalDay (`wide_arrival_day::SIZE`) when none exists, each created by
//! `init_with_seed` from the fee payer (`proc/wide.rs::reveal`, the
//! effects) with `init::rent(size)` — the Rent sysvar's **full** minimum
//! balance for the size — as the handler's **precondition**. The system
//! transfer the creation makes tops up only the shortfall when the address
//! already holds lamports; this review does **not** model that netting: it
//! requires the full minimum as the safe bound and labels the two
//! separately (`rent_rule`). WideSettleDeparture and WideReturn create
//! nothing.
//!
//! **Bound to one candidate and one verified snapshot.** The rent and the
//! payer bound are calculated only when the reads re-verify as the sealed
//! snapshot the **candidate itself** was planned over
//! (`Reads::coherent_snapshot` with the same digest as the candidate's):
//! reads of another response, edited reads, or a candidate planned
//! elsewhere yield `Unchecked` and `Unknown`, never a number. The base fee
//! is `LAMPORTS_PER_SIGNATURE × 1` **under the assumption of one
//! signature**, a modelled lower bound; the priority fee is unchecked (no
//! price is chosen here); the compute budget of a wide tag is unchecked
//! (no measured row; the engine would request its defaults). `Met` means
//! the payer's balance **at the snapshot's context slot** covers the
//! calculated lower bound and is never an assurance about the fee or the
//! balance at send time. Every sum is checked; an overflow is a refusal.

use fclient::abi::CU_MAX;
use fclient::budgets::Budget;
use fclient::fees::{DEFAULT_LOADED_LIMIT, LAMPORTS_PER_SIGNATURE};
use frontier_abi::world_index::arrival::{wide_arrival_day, wide_arrival_slot};
use serde_json::{json, Value};

use crate::wideduty::{Block, Candidate, Reads};
use crate::widereveal::RevealCandidate;
use crate::widesnapshot::SnapshotMeta;

/// A quantity the review either calculated from trustworthy data or did
/// not check (with the reason).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Known<T> {
    Known(T),
    Unchecked(&'static str),
}

impl<T: Copy> Known<T> {
    pub fn value(&self) -> Option<T> {
        match self {
            Known::Known(v) => Some(*v),
            Known::Unchecked(_) => None,
        }
    }
}

/// Whether the payer's balance in the snapshot covers the calculated
/// lower bound.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Funding {
    /// Covers the lower bound at the snapshot's context slot (nothing
    /// about later balances or the fee at send time).
    MetLowerBound { payer_lamports: u64, required: u64 },
    Unmet {
        payer_lamports: u64,
        required: u64,
        short: u64,
    },
    /// The payer's account or the requirement itself is not known.
    Unknown(&'static str),
}

/// The requirements of executing one candidate.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExecutionNeeds {
    /// The accounts the handler would create: `(name, ABI size)`.
    pub creates: Vec<(&'static str, usize)>,
    /// Σ **full** minimum balances of `creates`, from the snapshot's Rent.
    pub rent_lamports: Known<u64>,
    /// `LAMPORTS_PER_SIGNATURE × signatures_assumed`: a modelled lower
    /// bound; the network's fee at send time is not read.
    pub signatures_assumed: u8,
    pub base_fee_lamports: Known<u64>,
    /// No ComputeBudget price is chosen by the planners.
    pub priority_fee_lamports: Known<u64>,
    /// What the engine would request for a tag without a measured row.
    pub budget_default: Budget,
    pub budget_measured: bool,
    /// `rent + base fee`, when both are known.
    pub required_lower_bound: Known<u64>,
    pub funding: Funding,
    /// The evidence the handler stores is whatever the sent transaction
    /// carries; absent, the parser's defaults (zero) are accepted.
    pub fee_evidence: &'static str,
    /// The digest of the snapshot these needs were calculated over, when
    /// they were (the candidate's own).
    pub snapshot_digest: Option<[u8; 32]>,
}

impl ExecutionNeeds {
    pub fn describe(&self) -> Value {
        let known = |k: &Known<u64>| match k {
            Known::Known(v) => json!(v),
            Known::Unchecked(r) => json!({"unchecked": r}),
        };
        json!({
            "creates": self.creates.iter().map(|(n, s)| json!({"account": n, "size": s})).collect::<Vec<_>>(),
            "rent_lamports": known(&self.rent_lamports),
            "rent_rule": "handler precondition: the full minimum balance per created account (init::rent(size)); the creation's transfer tops up only a prefunded address's shortfall, which this review does not net",
            "signatures_assumed": self.signatures_assumed,
            "base_fee_lamports": known(&self.base_fee_lamports),
            "priority_fee_lamports": known(&self.priority_fee_lamports),
            "budget_default": {"cu_limit": self.budget_default.cu_limit, "loaded_limit": self.budget_default.loaded_limit, "measured": self.budget_measured},
            "required_lower_bound": known(&self.required_lower_bound),
            "funding": format!("{:?}", self.funding),
            "fee_evidence": self.fee_evidence,
            "snapshot_digest": self.snapshot_digest.map(hex::encode),
            "network_fee_at_send": "not read",
            "future_balance": "not proven",
            "live_fee_assurance": false,
        })
    }
}

const BASE_FEE_NOTE: &str = "5,000 lamports × one signature assumed: a modelled lower bound; the network's base fee at send time is not read";
const PRIORITY_NOTE: &str = "no ComputeBudget price is chosen by the planners";
const RENT_NO_SYSVAR: &str = "the Rent sysvar was not in the candidate's snapshot";
const NOT_BOUND: &str = "the reads are not the verified snapshot this candidate was planned over";
const FEE_EVIDENCE_NOTE: &str = "the handler stores whatever ComputeBudget prefix the sent transaction carries; absent, the parser's defaults (zero) are accepted; the prefix is keeper policy, not a handler mandate";

/// What the engine would request for a wide tag: no measured row exists
/// for the draft band, so `Budgets::get` falls back to `CU_MAX` and the
/// default loaded limit. Reported as an unmeasured default.
pub fn budget_default_for_wide() -> Budget {
    Budget {
        cu_limit: CU_MAX,
        loaded_limit: DEFAULT_LOADED_LIMIT,
    }
}

/// The snapshot `reads` still are **and** the one `candidate_snapshot`
/// names, by digest; `None` otherwise.
fn bound<'a>(
    reads: &'a Reads,
    candidate_snapshot: Option<&SnapshotMeta>,
) -> Option<&'a SnapshotMeta> {
    let m = reads.coherent_snapshot()?;
    let c = candidate_snapshot?;
    (m.digest() == c.digest()).then_some(m)
}

fn needs_of(
    creates: Vec<(&'static str, usize)>,
    payer: &solana_address::Address,
    reads: &Reads,
    candidate_snapshot: Option<&SnapshotMeta>,
) -> Result<ExecutionNeeds, Block> {
    let snap = bound(reads, candidate_snapshot);
    let rent_lamports = match (snap, reads.rent) {
        (None, _) => Known::Unchecked(NOT_BOUND),
        (Some(_), Some(rent)) => {
            let mut sum = 0u64;
            for (_, size) in &creates {
                let m = rent.minimum_balance(*size).ok_or(Block::Overflow("rent"))?;
                sum = sum.checked_add(m).ok_or(Block::Overflow("rent"))?;
            }
            Known::Known(sum)
        }
        (Some(_), None) if creates.is_empty() => Known::Known(0),
        (Some(_), None) => Known::Unchecked(RENT_NO_SYSVAR),
    };
    let signatures_assumed: u8 = 1;
    let base_fee = LAMPORTS_PER_SIGNATURE
        .checked_mul(u64::from(signatures_assumed))
        .ok_or(Block::Overflow("base fee"))?;
    let required = match rent_lamports {
        Known::Known(r) => Known::Known(
            r.checked_add(base_fee)
                .ok_or(Block::Overflow("required lamports"))?,
        ),
        Known::Unchecked(why) => Known::Unchecked(why),
    };
    let funding = match (required, snap, reads.accounts.get(payer)) {
        (Known::Unchecked(why), _, _) => Funding::Unknown(why),
        (Known::Known(_), None, _) => Funding::Unknown(NOT_BOUND),
        (Known::Known(_), Some(_), None) => {
            Funding::Unknown("the payer's account is not in the snapshot")
        }
        (Known::Known(req), Some(_), Some(acc)) => {
            let lamports = acc.as_ref().map_or(0, |a| a.lamports);
            if lamports >= req {
                Funding::MetLowerBound {
                    payer_lamports: lamports,
                    required: req,
                }
            } else {
                Funding::Unmet {
                    payer_lamports: lamports,
                    required: req,
                    short: req - lamports,
                }
            }
        }
    };
    Ok(ExecutionNeeds {
        creates,
        rent_lamports,
        signatures_assumed,
        base_fee_lamports: Known::Known(base_fee),
        priority_fee_lamports: Known::Unchecked(PRIORITY_NOTE),
        budget_default: budget_default_for_wide(),
        budget_measured: false,
        required_lower_bound: required,
        funding,
        fee_evidence: FEE_EVIDENCE_NOTE,
        snapshot_digest: snap.map(SnapshotMeta::digest),
    })
}

/// The needs of a WideReveal candidate: the slot when the arrival fills a
/// free slot (a displacement reuses the displaced slot's account), the
/// ArrivalDay when none exists — each at its full minimum balance.
pub fn reveal_needs(c: &RevealCandidate, reads: &Reads) -> Result<ExecutionNeeds, Block> {
    let mut creates = Vec::new();
    if c.facts.displaced.is_none() {
        creates.push(("wide ArrivalSlot", wide_arrival_slot::SIZE));
    }
    if !c.facts.day_present {
        creates.push(("wide ArrivalDay", wide_arrival_day::SIZE));
    }
    needs_of(creates, &c.fee_payer, reads, c.snapshot())
}

/// The needs of a WideSettleDeparture or WideReturn candidate: no account
/// is created.
pub fn duty_needs(c: &Candidate, reads: &Reads) -> Result<ExecutionNeeds, Block> {
    needs_of(Vec::new(), &c.payer, reads, c.snapshot())
}

/// A one-line summary of the assumptions, for status output.
pub const ASSUMPTIONS: [&str; 4] = [
    BASE_FEE_NOTE,
    PRIORITY_NOTE,
    "compute budget: no measured row for the draft band; the engine's defaults are unmeasured",
    FEE_EVIDENCE_NOTE,
];
