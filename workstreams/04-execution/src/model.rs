//! The Run: its spec, its states, the transition table and what each state
//! owns (`docs/STATE-MACHINE.ja.md` is the prose of this file).
//!
//! A Run is "goods arrive at `stock` → a permitted facility turns `inputs`
//! into `outputs` there → a caravan carries `ship.cargo` to `ship.dst` →
//! its arrival is checked". It spans many bells; nothing here pretends the
//! whole of it can be rolled back. Each external step is fixed by a request
//! key before it is sent, confirmed only by a canonical read, and every
//! later step re-reads the canonical stock and rights first.

use permutation_rules::frontier::holding::RESOURCES;
use serde::{Deserialize, Serialize};

/// Whole units per resource (the PS2 logs' unit for cargo).
pub type Res = [u64; RESOURCES];

pub const ZERO: Res = [0; RESOURCES];

pub fn res_ge(a: &Res, b: &Res) -> bool {
    a.iter().zip(b).all(|(x, y)| x >= y)
}
pub fn res_sub(a: &Res, b: &Res) -> Res {
    let mut o = ZERO;
    for i in 0..RESOURCES {
        o[i] = a[i].saturating_sub(b[i]);
    }
    o
}
pub fn res_add(a: &Res, b: &Res) -> Res {
    let mut o = ZERO;
    for i in 0..RESOURCES {
        o[i] = a[i].saturating_add(b[i]);
    }
    o
}
pub fn res_is_zero(a: &Res) -> bool {
    a.iter().all(|&x| x == 0)
}

/// A holding or a vault, as the S1 `Place` record names it (kind, P, Q,
/// site or tile, generation). The generation is part of the identity: a
/// seized vault (`GEN + 1`) is another destination.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct PlaceRef {
    /// `frontier_abi::v2::layout::s1::place::KIND_HOLDING` / `KIND_VAULT`.
    pub kind: u8,
    pub p: i16,
    pub q: i16,
    pub at: u8,
    pub gen: u8,
}

impl PlaceRef {
    /// The place without its generation: where the stock is counted.
    pub fn slot_key(&self) -> String {
        format!("{}:{}:{}:{}", self.kind, self.p, self.q, self.at)
    }
}

/// A facility a holder may use under a right (workstream ②'s object; the
/// recipe is opaque here).
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct FacilityRef {
    pub place: PlaceRef,
    pub recipe: u16,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CaravanKey {
    pub owner: u64,
    pub seq: u32,
}

impl CaravanKey {
    /// The id the caravan's Province slots carry (kernel `caravan_id`).
    pub fn id(&self) -> u64 {
        permutation_rules::frontier::caravan::caravan_id(self.owner, self.seq)
    }
    pub fn text(&self) -> String {
        format!("cv:{:x}:{}", self.owner, self.seq)
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ShipSpec {
    pub dst: PlaceRef,
    pub cargo: Res,
}

/// Stop conditions: no run retries for ever or spends without bound.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Budget {
    /// Distinct signed attempts per external step (facility, ship).
    pub max_attempts: u32,
    /// Fees the run may commit to, counted pessimistically at signing.
    pub max_fee: u64,
    /// Consecutive port errors on this run before it is held for an operator.
    pub max_port_errors: u32,
}

impl Default for Budget {
    fn default() -> Self {
        Budget {
            max_attempts: 3,
            max_fee: 200_000,
            max_port_errors: 5,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RunSpec {
    /// Client-chosen idempotency key of the acceptance.
    pub run_id: String,
    /// `citizen_tag` of the actor (caravan seeds, rights holder).
    pub owner: u64,
    /// Where the inputs arrive and the outputs appear (the actor's place).
    pub stock: PlaceRef,
    /// The caravan bringing the inputs, if one is awaited.
    pub inbound: Option<CaravanKey>,
    pub facility: FacilityRef,
    pub inputs: Res,
    pub outputs: Res,
    /// Units of the use right one execution consumes.
    pub rights_units: u64,
    pub ship: ShipSpec,
    /// No new attempt is signed at or after this slot.
    pub deadline_slot: u64,
    pub budget: Budget,
}

impl RunSpec {
    /// A stable digest of the spec: a second acceptance with the same
    /// `run_id` and another spec is refused, not merged.
    pub fn digest(&self) -> String {
        use sha2::Digest;
        let j = serde_json::to_vec(self).expect("spec serialises");
        hex::encode(sha2::Sha256::digest(&j))
    }

    /// The facility request's key: one per run, fixed for every attempt.
    pub fn facility_key(&self) -> String {
        format!("fac:{}", self.run_id)
    }
}

/// The Run's states. `Held` is not a state: it is an overlay
/// (`runs.held_reason`) that stops automatic work in any state until an
/// operator resumes it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum RunState {
    /// 受付: stored; nothing reserved; waits for the inputs.
    Accepted,
    /// 予約: inputs and right units reserved locally (advisory).
    Reserved,
    /// 実行要求: facility request signed and journalled; may be in flight.
    FacilityRequested,
    /// 送信済み: the execution path acknowledged the facility request.
    FacilitySubmitted,
    /// 確定: the canonical record of the facility use was read.
    FacilityConfirmed,
    /// 実行要求 (ship): SendCaravan signed with a pinned seq; may be in flight.
    ShipRequested,
    /// 送信済み (ship): acknowledged; not yet seen on the canonical side.
    ShipSubmitted,
    /// 輸送中: the caravan exists, ours, moving.
    InTransit,
    /// 到着: the settlement was observed (outcome not yet judged).
    Arrived,
    /// 履行完了: delivered in full at the destination's generation.
    Fulfilled,
    /// 部分履行: a verified amount arrived, less than asked (wear, capacity).
    Partial,
    /// 到着量未検証: delivered, but the amount kept cannot be verified (a
    /// vault's settle record without the credited amount). Never counted
    /// as full or as a known partial.
    DeliveredUnverified,
    /// 失敗.
    Failed,
    /// 取消.
    Cancelled,
    /// 期限切れ.
    Expired,
}

use RunState::*;

impl RunState {
    pub const ALL: [RunState; 15] = [
        Accepted,
        Reserved,
        FacilityRequested,
        FacilitySubmitted,
        FacilityConfirmed,
        ShipRequested,
        ShipSubmitted,
        InTransit,
        Arrived,
        Fulfilled,
        Partial,
        DeliveredUnverified,
        Failed,
        Cancelled,
        Expired,
    ];

    pub fn terminal(self) -> bool {
        matches!(
            self,
            Fulfilled | Partial | DeliveredUnverified | Failed | Cancelled | Expired
        )
    }

    /// A request of this state may still take effect on the canonical side.
    pub fn in_flight(self) -> bool {
        matches!(
            self,
            FacilityRequested | FacilitySubmitted | ShipRequested | ShipSubmitted
        )
    }

    pub fn name(self) -> &'static str {
        match self {
            Accepted => "Accepted",
            Reserved => "Reserved",
            FacilityRequested => "FacilityRequested",
            FacilitySubmitted => "FacilitySubmitted",
            FacilityConfirmed => "FacilityConfirmed",
            ShipRequested => "ShipRequested",
            ShipSubmitted => "ShipSubmitted",
            InTransit => "InTransit",
            Arrived => "Arrived",
            Fulfilled => "Fulfilled",
            Partial => "Partial",
            DeliveredUnverified => "DeliveredUnverified",
            Failed => "Failed",
            Cancelled => "Cancelled",
            Expired => "Expired",
        }
    }

    pub fn parse(s: &str) -> Option<RunState> {
        RunState::ALL.into_iter().find(|x| x.name() == s)
    }
}

/// The transition table. Self-loops (a detail update) are always allowed on
/// a non-terminal state; nothing leaves a terminal state.
pub fn allowed(from: RunState, to: RunState) -> bool {
    if from == to {
        return !from.terminal();
    }
    match from {
        Accepted => matches!(to, Reserved | Failed | Cancelled | Expired),
        // Back to Accepted: the stock fell short at the last check.
        Reserved => matches!(
            to,
            FacilityRequested | Accepted | Failed | Cancelled | Expired
        ),
        // Back to Reserved: the attempt can no longer land and did not.
        FacilityRequested | FacilitySubmitted => matches!(
            to,
            FacilitySubmitted | FacilityConfirmed | Reserved | Failed | Cancelled | Expired
        ),
        // Cancelled / Expired here leave the outputs at `stock`.
        FacilityConfirmed => matches!(to, ShipRequested | Failed | Cancelled | Expired),
        // Back to FacilityConfirmed: not landed (or the seq was taken by
        // another send): a new attempt re-pins the seq after fresh checks.
        ShipRequested | ShipSubmitted => matches!(
            to,
            ShipSubmitted | InTransit | FacilityConfirmed | Failed | Cancelled | Expired
        ),
        // No recall exists: once moving, only the road decides.
        InTransit => matches!(to, Arrived | Failed),
        Arrived => matches!(to, Fulfilled | Partial | DeliveredUnverified | Failed),
        Fulfilled | Partial | DeliveredUnverified | Failed | Cancelled | Expired => false,
    }
}

/// Why a run failed (or was held).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Reason {
    RightsExpired,
    RightsInsufficient,
    /// The awaited inbound caravan was taken, burned or lost.
    InputLost,
    /// The canonical stock lacked the inputs at execution.
    InputShort,
    FacilityGone,
    FacilityRejected(String),
    /// The destination is gone or of another generation (before sending:
    /// the outputs stay at `stock`).
    DestinationChanged,
    /// The outputs were no longer at `stock` (spent by someone else).
    OutputShort,
    /// The caravan was taken by a raider (it is the raider's now).
    Raided,
    /// Delivered nothing: burned in a raid or the destination lost it.
    LostInTransit,
    AttemptsExhausted,
    BudgetExhausted,
    // Hold reasons (operator needed):
    /// A send to another player's place needs the wallet's signature.
    WalletRequired,
    /// Statuses, entity history and events all missing: cannot decide
    /// whether our request took effect.
    Indeterminate,
    PortUnavailable,
    /// A canonical read contradicted itself (a bug to look at).
    Inconsistent(String),
}

/// How the amount a destination kept is known.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Verification {
    /// The settle record states it (`credited`, proposal P1).
    Recorded,
    /// Follows from the rules for this destination: a holding credits the
    /// whole cargo (`Accrual::add` "may exceed the cap", holding.rs:296).
    RuleDerived,
    /// Known to be nothing: outcome LOST, an empty (burned) cargo, a take.
    KnownZero,
    /// Cannot be known (a vault's record without `credited`). Balances are
    /// never used to guess it: other deposits and withdrawals interleave.
    Unverifiable,
    /// Nothing was shipped (stopped before or at the facility).
    NotShipped,
}

/// What a terminal Run says about where the goods are.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Outcome {
    /// The amount verified to have been kept by the destination
    /// (`None`: unverifiable).
    pub delivered: Option<Res>,
    pub verification: Verification,
    /// The cargo the settle record logged: an upper bound, not an amount
    /// received.
    pub cargo_logged: Option<Res>,
    /// Canonical effects that took place before the run stopped (receipt
    /// kinds and subjects), so a cancel or expiry is never shown as "nothing
    /// happened" when something did.
    pub effects: Vec<String>,
    pub note: String,
}

impl Outcome {
    pub fn stopped(effects: Vec<String>, note: impl Into<String>) -> Outcome {
        Outcome {
            delivered: None,
            verification: Verification::NotShipped,
            cargo_logged: None,
            effects,
            note: note.into(),
        }
    }
}

/// Where a cancel stands. A cancel never recalls a request already signed:
/// the chain cannot see this store, and signed bytes can land until their
/// blockhash expires (`valid_until`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum CancelPhase {
    /// 新規要求の停止: no new request will be signed or re-broadcast.
    StoppingNew,
    /// 署名済み要求の確認待ち: signed requests may still land until `until`.
    AwaitingSigned { until: u64 },
    /// 取消完了 (state Cancelled): nothing more can land; `effects` lists
    /// what did land before.
    Completed { effects: Vec<String> },
    /// Too late: the goods are on the road (no recall); the run goes on.
    Ineffective { at: String },
}

/// The Run's mutable detail (persisted as JSON beside the state).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Detail {
    /// The pinned caravan seq of the current ship attempt.
    pub ship_seq: Option<u32>,
    /// What actually left `stock` (after the towers' wear).
    pub sent_cargo: Option<Res>,
    pub fac_attempts: u32,
    pub ship_attempts: u32,
    pub port_errors: u32,
    /// A refusal (preflight or landed failure) that ends the step once every
    /// signed attempt is decided: the same bytes could still land until
    /// their validity ends, so the run does not report failure before then.
    #[serde(default)]
    pub pending: Option<Reason>,
    #[serde(default)]
    pub cancel: Option<CancelPhase>,
    /// Consecutive looks that could not decide (held at the port budget).
    #[serde(default)]
    pub unresolved: u32,
    pub reason: Option<Reason>,
    pub outcome: Option<Outcome>,
    /// The settlement as observed (event or entity history).
    pub settle: Option<crate::ports::Settle>,
    /// The raid as observed.
    pub raid: Option<crate::ports::Raid>,
}

/// What each state owns, reserves and can give back (the table the docs
/// print; kept here so a test can check every state has a row).
pub fn ownership(s: RunState) -> (&'static str, &'static str, &'static str) {
    match s {
        Accepted => (
            "owner: inputs (where they are)",
            "nothing",
            "everything (nothing moved)",
        ),
        Reserved => (
            "owner: inputs at stock",
            "inputs + right units (local, advisory)",
            "everything: release the reservation",
        ),
        FacilityRequested | FacilitySubmitted => (
            "owner: inputs at stock, unless the request lands",
            "inputs + right units; the request key is fixed",
            "nothing until the request is decided (landed or past its validity)",
        ),
        FacilityConfirmed => (
            "owner: outputs at stock (inputs and right units consumed)",
            "outputs (local, advisory)",
            "outputs stay at stock; inputs and right units are spent",
        ),
        ShipRequested | ShipSubmitted => (
            "owner: outputs at stock, unless the send lands",
            "outputs; the caravan seq is pinned",
            "nothing until the send is decided",
        ),
        InTransit => (
            "the caravan (owner's; a raid can make it the raider's)",
            "nothing: the cargo is escrowed in the caravan",
            "nothing (no recall instruction)",
        ),
        Arrived => (
            "destination's owner: what was credited",
            "nothing",
            "nothing",
        ),
        Fulfilled | Partial => ("destination's owner", "nothing", "nothing"),
        DeliveredUnverified => (
            "destination's owner: an unverified amount (at most the logged cargo)",
            "nothing",
            "nothing",
        ),
        Failed | Cancelled | Expired => (
            "as the last confirmed step left it (see outcome / reason)",
            "nothing (released)",
            "what stayed at stock",
        ),
    }
}
