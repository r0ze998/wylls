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
//! balance for the size — as the handler's **precondition** (the reveal
//! guards the payer's balance against the full minimum before creating).
//! The system transfer the creation makes (`init::top_up`) moves only
//! `total − lamports already at the address` and refuses `Insufficient`
//! when the payer holds less than that. For the reveal this review keeps
//! the full minimum (the handler's guard, `RENT_RULE_FULL`); for the
//! **gather**, whose handler has no such guard, it nets the lamports the
//! plan's snapshot showed at the ClashInputs address (`RENT_RULE_TOP_UP`):
//! a fully prefunded address leaves the payer the fee alone. Each candidate
//! names its rule (`rent_rule`) and the netted amount
//! (`prefunded_lamports`). WideSettleDeparture and WideReturn create
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
use frontier_abi::world_index::arrival::{wide_arrival_day, wide_arrival_slot, wide_clash_inputs};
use frontier_abi::world_index::roster::wide_roster;
use serde_json::{json, Value};
use solana_instruction::Instruction;

use crate::wideduty::{Block, Candidate, Duty, Reads};
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
/// lower bound — for a payer that **can** pay: an ordinary System wallet
/// (System-owned, no data, not executable) that is not another account of
/// the instruction. A program-owned or executable account, or a conflicting state-account alias, is
/// [`Funding::Ineligible`]. System-owned data accounts need nonce/runtime
/// and transfer validation and remain [`Funding::Unknown`], never a
/// balance-based eligibility claim.
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
    /// The payer is known and cannot be this instruction's fee payer
    /// (named reason); its balance is not reported as funding.
    Ineligible(&'static str),
}

/// The payer names another account of the instruction (the Season, a
/// record): one address in two roles, one of them writable, is an invalid
/// transaction, not a funding question.
pub const PAYER_ALIASES: &str =
    "the payer is also another account of the instruction (role alias); not a fee payer";
/// An executable account.
pub const PAYER_EXECUTABLE: &str = "the payer account is executable: a program, not a wallet";
/// A program-owned account.
pub const PAYER_PROGRAM_OWNED: &str =
    "the payer account is not System-owned: a program's account cannot fund a System transfer";
/// A System-owned account carrying data.
pub const PAYER_SYSTEM_DATA: &str =
    "System account data needs nonce, rent-reserve and transfer validation; eligibility is unknown";

/// Why a present payer account cannot pay, if it cannot.
fn ineligible(a: &fclient::ports::Account) -> Option<&'static str> {
    if a.executable {
        Some(PAYER_EXECUTABLE)
    } else if a.owner != fclient::addr::system_program() {
        Some(PAYER_PROGRAM_OWNED)
    } else if !a.data.is_empty() {
        Some(PAYER_SYSTEM_DATA)
    } else {
        None
    }
}

/// The requirements of executing one candidate.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExecutionNeeds {
    /// The accounts the handler would create: `(name, ABI size)`.
    pub creates: Vec<(&'static str, usize)>,
    /// Σ **full** minimum balances of `creates`, from the snapshot's Rent:
    /// the `total` the handler passes to the creation.
    pub rent_lamports: Known<u64>,
    /// Lamports already at the created address in the candidate's
    /// snapshot that the creation's top-up nets (`init::top_up`: the payer
    /// covers `total − held`), when the handler has no guard requiring the
    /// full minimum of the payer. 0 when nothing is netted.
    pub prefunded_lamports: u64,
    /// Which rule the requirement follows (per handler).
    pub rent_rule: &'static str,
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
            "prefunded_lamports": self.prefunded_lamports,
            "rent_rule": self.rent_rule,
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
/// The funding reason when the candidate names the all-zero placeholder.
pub const NO_PAYER: &str = "no fee payer set: the candidate names the System Program address as a placeholder, which is not a wallet";
const FEE_EVIDENCE_NOTE: &str = "the handler stores whatever ComputeBudget prefix the sent transaction carries; absent, the parser's defaults (zero) are accepted; the prefix is keeper policy, not a handler mandate";
/// The reveal: the handler guards the payer's balance against the full
/// minimum before creating; a prefunded address is not netted.
pub const RENT_RULE_FULL: &str = "handler precondition: the full minimum balance per created account (init::rent(size)) of the payer; the creation's top-up would net a prefunded address but the handler's guard does not";
/// The gather: no such guard; `init_with_seed` tops the address up to the
/// full minimum from the payer, so the payer needs only the shortfall.
pub const RENT_RULE_TOP_UP: &str = "handler creation: init_with_seed with init::rent(size) as the total; init::top_up transfers total − lamports already at the address (Insufficient when the payer holds less); the requirement is that shortfall";
/// Nothing is created.
pub const RENT_RULE_NONE: &str = "no account is created";

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
    prefunded_lamports: u64,
    rent_rule: &'static str,
    payer: &solana_address::Address,
    instruction: &Instruction,
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
    // The payer's part of the rent: the full minimum less what the created
    // address already holds (0 unless the handler nets it), then the fee.
    let required = match rent_lamports {
        Known::Known(r) => Known::Known(
            r.saturating_sub(prefunded_lamports)
                .checked_add(base_fee)
                .ok_or(Block::Overflow("required lamports"))?,
        ),
        Known::Unchecked(why) => Known::Unchecked(why),
    };
    // The payer in another role of the same instruction (position 0 is the
    // payer itself): an invalid transaction, judged from the candidate
    // alone.
    let aliases = instruction
        .accounts
        .iter()
        .skip(1)
        .any(|m| m.pubkey == *payer);
    let payer_account = reads.accounts.get(payer);
    // A present payer that cannot pay, by its shape (owner, data,
    // executable) — only from the bound snapshot's bytes.
    let shape = match (snap, payer_account) {
        (Some(_), Some(Some(a))) => ineligible(a),
        _ => None,
    };
    // The all-zero address is the System Program: a placeholder an
    // unsigned candidate names when no payer is set, never a wallet whose
    // balance could fund anything. Then the alias, then the shape: a
    // balance is reported only for an eligible payer.
    let early = if *payer == solana_address::Address::default() {
        Some(Funding::Unknown(NO_PAYER))
    } else if aliases {
        Some(Funding::Ineligible(PAYER_ALIASES))
    } else {
        shape.map(|reason| {
            if reason == PAYER_SYSTEM_DATA {
                Funding::Unknown(reason)
            } else {
                Funding::Ineligible(reason)
            }
        })
    };
    let funding = match (early, required, snap, payer_account) {
        (Some(f), _, _, _) => f,
        (None, Known::Unchecked(why), _, _) => Funding::Unknown(why),
        (None, Known::Known(_), None, _) => Funding::Unknown(NOT_BOUND),
        (None, Known::Known(_), Some(_), None) => {
            Funding::Unknown("the payer's account is not in the snapshot")
        }
        (None, Known::Known(req), Some(_), Some(acc)) => {
            // Absent: a wallet that holds nothing yet (ordinary, empty).
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
        prefunded_lamports,
        rent_rule,
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
    needs_of(
        creates,
        0,
        RENT_RULE_FULL,
        &c.fee_payer,
        &c.instruction,
        reads,
        c.snapshot(),
    )
}

/// The needs of a WideSettleDeparture or WideReturn candidate (no account
/// is created) or of a WideGather: the ClashInputs when the plan found
/// none, created with the full minimum as the total but **topped up** from
/// the payer only by the shortfall over what the address already held in
/// the plan's snapshot (`init::top_up`; the gather handler has no guard
/// requiring the payer to hold the full minimum, unlike the reveal).
pub fn duty_needs(c: &Candidate, reads: &Reads) -> Result<ExecutionNeeds, Block> {
    let (creates, prefunded, rule) = match &c.duty {
        Duty::Gather(f) if !f.inputs_present => (
            vec![("wide ClashInputs", wide_clash_inputs::SIZE)],
            f.inputs_prefunded_lamports,
            RENT_RULE_TOP_UP,
        ),
        // The resolve's roster: the handler requires the fee payer to hold
        // the full minimum (`fee_payer.lamports() < rent_r → Insufficient`)
        // before the creation tops the address up — the full rule, exact.
        Duty::Resolve(f) if f.roster_created => {
            (vec![("wide Roster", wide_roster::SIZE)], 0, RENT_RULE_FULL)
        }
        _ => (Vec::new(), 0, RENT_RULE_NONE),
    };
    needs_of(
        creates,
        prefunded,
        rule,
        &c.payer,
        &c.instruction,
        reads,
        c.snapshot(),
    )
}

/// A one-line summary of the assumptions, for status output.
pub const ASSUMPTIONS: [&str; 4] = [
    BASE_FEE_NOTE,
    PRIORITY_NOTE,
    "compute budget: no measured row for the draft band; the engine's defaults are unmeasured",
    FEE_EVIDENCE_NOTE,
];
