//! **Read-only** (feature `wide-world-experimental`): the admission review
//! of a wide candidate against the engine's **public** state. It answers
//! "what would stand between this candidate and the engine today", with a
//! typed, stable, full-identity key, the kind, tag and class the engine
//! would file it under, and concrete denials. It never constructs a
//! [`crate::engine::WriteSpec`], never calls `Engine::ensure`, `poll` or
//! `send`, never opens the production debit gate, and is **not wired into
//! the keeper tick or status**: an orchestrator calls it explicitly.
//!
//! **Hard denials of this slice.** Six denials are present on every
//! review, whatever the candidate's own flags say: the departure proof's
//! source is unproven (a feed record bound by wire and frame, its
//! signatures unverified); no coherent, current snapshot exists (the
//! planners read at a lower bound and observe the clock separately); the
//! march's history before the applied records is unknown; the execution
//! evidence is unverified (fee evidence, rent, payer funding); no signer
//! is available to this path (nothing here holds or draws a key); and
//! this slice does not enqueue wide kinds (`SliceDoesNotEnqueue`). **The
//! engine itself would not refuse them**: `Engine::allows_write_kind`
//! accepts any kind while feed writes are allowed and refuses unknown
//! kinds only while the feed is paused, so the refusal is this review's,
//! not the engine's. A candidate whose `coherent`, `signed` or
//! `automatic_send` flags were set by a caller is reviewed exactly like
//! one whose flags are honest: the review does not read them to decide,
//! and `admitted` is always `false`.
//!
//! **Engine facts, read only.** `EngineView::of` reads the engine through
//! its public methods: `allows_write_kind`, `feed_writes_allowed`,
//! `is_pending`, `care_unresolved`. Those add denials when they apply.

use fclient::abi::Class;
use frontier_abi::world_index::wide_ix as wix;
use serde_json::{json, Value};

use crate::engine::Engine;
use crate::wideduty::{Candidate, Duty, Reads};
use crate::widefees::{ExecutionNeeds, Funding};
use crate::widereveal::RevealCandidate;
use crate::widesnapshot::SnapshotMeta;

/// The duty kinds the review files wide candidates under. The engine
/// accepts any kind while feed writes are allowed; none of these is in its
/// feed-paused allowlist, so a paused feed denies them all.
pub const KIND_SETTLE_DEPARTURE: &str = "wide-settle-departure";
pub const KIND_RETURN: &str = "wide-return";
pub const KIND_REVEAL: &str = "wide-reveal";

/// What is reviewed: a stable key by full identity, the engine's filing
/// facts, and the instruction's shape. No account bytes, no key material.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Subject {
    /// `wide-settle-departure:<world>:<host ref>:<slot>`,
    /// `wide-return:<world>:<standing key>:<holding ref>`,
    /// `wide-reveal:<world>:<host ref>:<slot>:<arrive bell>` (hex of the
    /// canonical bytes; never a `u64` alias).
    pub key: String,
    pub kind: &'static str,
    pub tag: u8,
    pub class: Class,
    pub accounts: usize,
    pub data_len: usize,
}

impl Subject {
    pub fn of_duty(c: &Candidate) -> Subject {
        let (key, kind) = match &c.duty {
            Duty::SettleDeparture(f) => (
                format!(
                    "{KIND_SETTLE_DEPARTURE}:{}:{}:{}",
                    hex::encode(f.host.key().world().as_bytes()),
                    hex::encode(f.host.to_bytes()),
                    f.transit_slot
                ),
                KIND_SETTLE_DEPARTURE,
            ),
            Duty::Return(f) => (
                format!(
                    "{KIND_RETURN}:{}:{}:{}",
                    hex::encode(f.standing.world().as_bytes()),
                    hex::encode(f.standing.to_bytes()),
                    hex::encode(f.holding.to_bytes())
                ),
                KIND_RETURN,
            ),
        };
        Subject {
            key,
            kind,
            tag: wix::TAG_SETTLE_TICKET,
            class: Class::D,
            accounts: c.instruction.accounts.len(),
            data_len: c.instruction.data.len(),
        }
    }

    pub fn of_reveal(c: &RevealCandidate) -> Subject {
        let f = &c.facts;
        Subject {
            key: format!(
                "{KIND_REVEAL}:{}:{}:{}:{}",
                hex::encode(f.host.key().world().as_bytes()),
                hex::encode(f.host.to_bytes()),
                f.transit_slot,
                f.arrive_bell
            ),
            kind: KIND_REVEAL,
            tag: wix::TAG_REVEAL,
            class: Class::W,
            accounts: c.instruction.accounts.len(),
            data_len: c.instruction.data.len(),
        }
    }
}

/// Why the engine must not take the candidate.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Deny {
    /// The departure proof's source is a feed record bound by wire and
    /// frame; its signatures were not verified and the source is not
    /// authenticated.
    SourceUnproven,
    /// The reads are a lower-bound snapshot with a separately observed
    /// clock; no coherent, current context exists.
    NoCoherentSnapshot,
    /// The march's history before the applied records is unknown.
    HistoryUnknown,
    /// The execution evidence is unverified: fee evidence (ComputeBudget
    /// prefix), rent of created accounts, fee payer funding.
    ExecutionEvidenceUnverified,
    /// This path holds no key and draws none.
    SignerAbsent,
    /// This slice does not enqueue wide kinds. The engine would accept the
    /// kind while feed writes are allowed; the refusal is this review's.
    SliceDoesNotEnqueue,
    /// The engine's feed guard pauses game writes.
    FeedWritesPaused,
    /// The engine would refuse the kind now (`allows_write_kind`).
    KindNotAllowed,
    /// A write with this key is already pending in the engine.
    AlreadyPending,
    /// An undecided payer-care transfer blocks new writes.
    CareUnresolved,
    /// A same-response snapshot exists, so the accounts and the clock are
    /// coherent at its context slot — but that slot is not proven current.
    SnapshotCurrencyUnknown,
    /// The fee review could not bound the payer (no snapshot, no payer
    /// account in it, or no Rent sysvar for the accounts created).
    FundingUnknown,
    /// The payer's balance at the context slot does not cover the
    /// calculated lower bound (rent + base fee).
    FundingUnmet,
}

/// The engine facts the review reads, through public methods only.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct EngineView {
    pub feed_writes_allowed: bool,
    pub kind_allowed: bool,
    pub already_pending: bool,
    pub care_unresolved: bool,
}

impl EngineView {
    pub fn of(engine: &Engine, subject: &Subject) -> EngineView {
        EngineView {
            feed_writes_allowed: engine.feed_writes_allowed(),
            kind_allowed: engine.allows_write_kind(subject.kind),
            already_pending: engine.is_pending(&subject.key),
            care_unresolved: engine.care_unresolved(),
        }
    }
}

/// The outcome. `admitted` is `false` in this slice by construction.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Review {
    pub subject: Subject,
    pub denials: Vec<Deny>,
    pub admitted: bool,
}

impl Review {
    pub fn describe(&self) -> Value {
        json!({
            "key": self.subject.key,
            "kind": self.subject.kind,
            "tag": self.subject.tag,
            "class": format!("{:?}", self.subject.class),
            "accounts": self.subject.accounts,
            "data_len": self.subject.data_len,
            "denials": self.denials.iter().map(|d| format!("{d:?}")).collect::<Vec<_>>(),
            "admitted": self.admitted,
            "enqueued": false,
            "engine_refuses_wide_kinds": "only while the feed is paused; the gate is this review",
        })
    }
}

/// The hard denials of this slice, on every review.
pub const HARD_DENIALS: [Deny; 6] = [
    Deny::SourceUnproven,
    Deny::NoCoherentSnapshot,
    Deny::HistoryUnknown,
    Deny::ExecutionEvidenceUnverified,
    Deny::SignerAbsent,
    Deny::SliceDoesNotEnqueue,
];

/// The denials of this slice: the six hard ones always, the engine's
/// when they apply. Nothing about the candidate's own flags is consulted.
pub fn review(subject: Subject, view: &EngineView) -> Review {
    let mut denials = HARD_DENIALS.to_vec();
    if !view.feed_writes_allowed {
        denials.push(Deny::FeedWritesPaused);
    }
    if !view.kind_allowed {
        denials.push(Deny::KindNotAllowed);
    }
    if view.already_pending {
        denials.push(Deny::AlreadyPending);
    }
    if view.care_unresolved {
        denials.push(Deny::CareUnresolved);
    }
    Review {
        subject,
        denials,
        admitted: false,
    }
}

/// A candidate reviewed together with the reads it was planned over: the
/// subject, the fee review's needs bound to that candidate and those reads
/// (`widefees`), and the review. Built only by [`review_candidate`] and
/// [`review_reveal`], which take the candidate and the reads themselves —
/// no caller attaches a snapshot meta or needs to an unrelated subject.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Assessment {
    pub review: Review,
    pub needs: Option<ExecutionNeeds>,
    /// The verified snapshot both the candidate and the reads are, if any.
    pub snapshot: Option<SnapshotMeta>,
}

impl Assessment {
    pub fn describe(&self) -> Value {
        json!({
            "review": self.review.describe(),
            "needs": self.needs.as_ref().map(ExecutionNeeds::describe),
            "snapshot": self.snapshot.as_ref().map(SnapshotMeta::describe),
        })
    }
}

/// The hard denials stay except `NoCoherentSnapshot`, which a verified
/// snapshot replaces with `SnapshotCurrencyUnknown`; the fee review adds
/// `FundingUnknown` or `FundingUnmet`. `ExecutionEvidenceUnverified` stays
/// in every case: the fee at send time and the stored evidence are the
/// sent transaction's. `admitted` is `false` by construction.
fn assess(
    subject: Subject,
    view: &EngineView,
    snapshot: Option<&SnapshotMeta>,
    needs: Result<ExecutionNeeds, crate::wideduty::Block>,
) -> Assessment {
    let mut r = review(subject, view);
    let needs = needs.ok();
    // The snapshot counts only when the fee review bound the same one to
    // the candidate (its digest equals the candidate's and the reads').
    let bound = match (&needs, snapshot) {
        (Some(n), Some(m)) if n.snapshot_digest == Some(m.digest()) => Some(m.clone()),
        _ => None,
    };
    if bound.is_some() {
        r.denials.retain(|d| *d != Deny::NoCoherentSnapshot);
        r.denials.push(Deny::SnapshotCurrencyUnknown);
    }
    match needs.as_ref().map(|n| n.funding) {
        None | Some(Funding::Unknown(_)) => r.denials.push(Deny::FundingUnknown),
        Some(Funding::Unmet { .. }) => r.denials.push(Deny::FundingUnmet),
        Some(Funding::MetLowerBound { .. }) => {}
    }
    r.denials.sort();
    r.denials.dedup();
    r.admitted = false;
    Assessment {
        review: r,
        needs,
        snapshot: bound,
    }
}

/// Reviews a settle or return candidate with the reads it was planned
/// over. The candidate's own flags are not consulted; its snapshot (set
/// only by the planner) must re-verify over `reads` for the snapshot
/// denial to change.
pub fn review_candidate(c: &Candidate, reads: &Reads, view: &EngineView) -> Assessment {
    assess(
        Subject::of_duty(c),
        view,
        c.snapshot(),
        crate::widefees::duty_needs(c, reads),
    )
}

/// Reviews a reveal candidate with the reads it was planned over.
pub fn review_reveal(c: &RevealCandidate, reads: &Reads, view: &EngineView) -> Assessment {
    assess(
        Subject::of_reveal(c),
        view,
        c.snapshot(),
        crate::widefees::reveal_needs(c, reads),
    )
}

/// [`review`] against a live engine, read only.
pub fn review_with_engine(engine: &Engine, subject: Subject) -> Review {
    let view = EngineView::of(engine, &subject);
    review(subject, &view)
}
