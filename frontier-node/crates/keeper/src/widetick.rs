//! **Read-only, opt-in** (feature `wide-world-experimental`): the bounded
//! per-tick review of wide candidates for the keeper's status.
//!
//! The keeper's read-only wide observer ([`crate::wideindex`]) names the
//! departures it has seen open and the dissolves it has seen pending.
//! Enabled by `Keeper::enable_wide_review` (which needs the observer and a
//! pinned deployment), this step takes at most [`CANDIDATES_PER_TICK`] of
//! those hints per tick — a **hard** cap, whatever the public
//! `candidates_per_tick` is set to — in a round-robin over the hint order
//! whose cursor advances by the positions inspected. Each hint is planned
//! with the tick's slot as the lower bound of every read, reviewed against
//! the engine's public state with the fee review bound to the reads it was
//! planned over ([`crate::widereview`]), and recorded for `/v1/status`.
//! Nothing is enqueued, signed, simulated or sent; `Engine::ensure` is not
//! reachable from here; the legacy PSW1 feed guard still stops game writes
//! as before (this step runs whether or not it has fired, before the keeper
//! publishes its status, and only reads).
//!
//! **Cooldowns.** A settle or return hint is not re-planned within
//! [`REFRESH_SLOTS`]. A reveal hint has its own rules: a transient outcome
//! ([`is_transient`]: the publication not served yet, THE anchor not
//! landed, no clock observed, the Season not yet started, a read or
//! snapshot failure) is retried at the **next slot**, at most
//! [`MAX_TRANSIENT_RETRIES`] times in a row
//! before it waits [`REVEAL_REFRESH_SLOTS`]; a candidate waits
//! [`REVEAL_REFRESH_SLOTS`]; any other block waits [`REFRESH_SLOTS`]; and a
//! **new proof** for the same march (a later feed sequence) invalidates the
//! ledger entry at once.
//!
//! **The snapshot, additive.** The keeper is generic over `ChainPort`; the
//! same-response snapshot is passed to the step as an optional
//! [`SnapshotSource`] — preferably the keeper's **own** read port through
//! [`crate::widesnapshot::PortSnapshot`] (`Keeper::enable_wide_snapshot_via_port`,
//! where `P: SnapshotPort` is known), or a separately attached source whose
//! relation to the read port is **not** verified here. With one, every plan
//! goes through [`crate::widesnapshot::snapshot_plan_with`]: the ordinary
//! reads learn the keys, **one** `getMultipleAccounts` at the plan's
//! minimum slot as `minContextSlot` supplies the bytes the plan is judged
//! over, and the candidate is coherent at that response's context slot
//! (never current; the sealed meta and the candidate's content digest
//! decide, as everywhere else). Without one, the ordinary read planners run
//! and every candidate is non-coherent. A snapshot that fails is a recorded
//! block, never patched from other reads.
//!
//! **Reveal, only from inputs that exist.** A Reveal needs a departure
//! proof, a seal opening and a public beacon. The tick holds none of them
//! by itself, so the step takes them explicitly:
//!
//! - the proof from a [`ProofStore`]: `DepartProof`s extracted by
//!   [`crate::wideproof`] from the **observer-accepted prefix** of the same
//!   feed pages the observer sees (`Keeper::refresh_discovery` offers every
//!   page with the observer's own `accepted_prefix` for it — nothing when
//!   the observer was blocked already or refused the page's order, the
//!   records before the one that blocked it otherwise; records past that,
//!   and records past [`MAX_EXTRACT_PER_PAGE`], are counted as dropped,
//!   never extracted), wire- and frame-bound, with their signatures
//!   **unverified** and labelled so — or supplied by an orchestrator
//!   through [`ProofStore::supply`], whose provenance is **normalised**
//!   (`signatures_verified = false`, method
//!   [`crate::wideproof::METHOD_SUPPLIED`]) whatever the caller claimed;
//! - the opening is always [`Opening::FromBeacon`]: the public round
//!   signature opens the IBE block. **No plaintext, salt or key is held or
//!   shown**; the ledger records the candidate's description only;
//! - the publication from a [`PublicationSource`]: a round the drand port
//!   serves, verified under the review's pinned public key before use
//!   ([`BeaconCache`], at most one ask per round per slot, bounded). The
//!   planner's own gate re-verifies it against the Season's pinned key hash
//!   and the computed `tlock_round(arrive)`; a round not served is
//!   `Block::PublicationMissing`.
//!
//! The minimum slot of a reveal's reads and snapshot is
//! `max(tick slot, proof slot)`: never bytes older than the departure the
//! proof came from. The runtime passes [`RevealInputs`] only when it has
//! read the Season and a publication source exists; otherwise reveal hints
//! are not listed, and the status names exactly what is missing. The
//! history before the applied records stays unknown (`HistoryUnknown`); the
//! proof source stays unproven (`SourceUnproven`); nothing here infers
//! authenticity.
//!
//! **The payer.** No key is drawn. The unsigned candidates name
//! [`WideReview::review_payer`] when an operator set a public address;
//! otherwise the all-zero placeholder (the System Program), which the fee
//! review reports as **no payer** (`Funding::Unknown`), never as a wallet's
//! balance.
//!
//! **Status.** Addresses, hex identities, counts, labels and typed block
//! codes only — no key material, no account bytes, no plaintext, and
//! **never** a raw RPC, read or snapshot error string (which may carry a URL
//! with credentials or arbitrary server text).
//!
//! **Bounds.** ≤ `CANDIDATES_PER_TICK` plans per tick, each ≤ 6 account
//! read rounds plus one clock read, plus at most one snapshot request and
//! (reveal) one beacon ask; ≤ [`MAX_EXTRACT_PER_PAGE`] proof extractions per
//! feed page; the proof store keeps ≤ [`MAX_PROOFS`] proofs, the beacon
//! cache ≤ [`MAX_BEACON_CACHE`] rounds, the review ledger ≤ [`MAX_LEDGER`]
//! entries (oldest dropped).

use std::collections::BTreeMap;
use std::future::Future;
use std::pin::Pin;

use fclient::beacon;
use fclient::clock::SeasonClock;
use fclient::decode::Season;
use fclient::ports::{ChainPort, DrandPort, TxRecord};
use frontier_abi::world_index::{ProvinceKey, WideHostRef};
use serde_json::{json, Value};
use solana_address::Address;

use crate::engine::Engine;
use crate::wideduty::Duty;
use crate::wideduty::{self, Block, Candidate, Deployment, Reads, Scope};
use crate::wideindex::{WideDiscovery, WideObserver};
use crate::wideproof::{depart_proof, DepartProof, ProofScope, METHOD_SUPPLIED};
use crate::widereconcile::{reconcile, Verdict};
use crate::widereveal::{self, Opening, Publication, RevealCandidate};
use crate::widereview::{review_candidate, review_reveal, EngineView, Subject};
use crate::widesnapshot::{snapshot_plan_with, Snapshot, SnapshotSource};
use frontier_abi::world_index::event::WideTarget;

/// Plans per tick: a hard cap.
pub const CANDIDATES_PER_TICK: usize = 2;
/// Slots before a settle/return hint (or a definitively blocked reveal) is
/// reviewed again.
pub const REFRESH_SLOTS: u64 = 64;
/// Slots before a reveal candidate is reviewed again, and the wait after
/// the transient retries are used up.
pub const REVEAL_REFRESH_SLOTS: u64 = 8;
/// Consecutive next-slot retries of a reveal whose outcome was transient.
pub const MAX_TRANSIENT_RETRIES: u32 = 8;
/// Review ledger entries kept.
pub const MAX_LEDGER: usize = 256;
/// Departure proofs kept (oldest sequence dropped).
pub const MAX_PROOFS: usize = 64;
/// Records of one feed page offered to the proof extractor; the rest are
/// counted as dropped.
pub const MAX_EXTRACT_PER_PAGE: usize = 64;
/// Verified beacon rounds kept by the review's cache.
pub const MAX_BEACON_CACHE: usize = 256;

/// The origin label of a proof extracted from a feed page.
pub const ORIGIN_FEED: &str = "feed page: the keeper's own discovery pull, observer-accepted prefix; wire and frame bound by wideproof; signatures unverified";
/// The origin label of a proof handed in by an orchestrator or a test.
pub const ORIGIN_SUPPLIED: &str =
    "supplied: handed to the store, not extracted from the keeper's feed pages; provenance normalised to unverified";

/// Label of the payer when none is set.
pub const PAYER_UNSET: &str =
    "unset: the unsigned candidates name the System Program address as a placeholder; funding is not reviewed";

// ------------------------------------------------------------ proofs

/// One stored proof and where it came from.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProofEntry {
    pub proof: DepartProof,
    /// The feed sequence of the record it was taken from (the proof's own
    /// provenance sequence for a supplied one).
    pub seq: u64,
    pub origin: &'static str,
}

/// The bounded store of departure proofs the reveal review may plan from:
/// one per `(host, transit slot)`, a later sequence superseding an earlier
/// one, at most [`MAX_PROOFS`]. A **hint** source: the planner decides
/// against the chain.
#[derive(Default)]
pub struct ProofStore {
    entries: BTreeMap<(WideHostRef, u8), ProofEntry>,
    pub records_seen: u64,
    /// Records offered to the extractor.
    pub records_offered: u64,
    /// Records past the observer's accepted prefix of their page (the
    /// observer was blocked already, refused the page's order, or blocked
    /// at that record or an earlier one): not offered.
    pub dropped_unaccepted: u64,
    /// Records past [`MAX_EXTRACT_PER_PAGE`] on their page: not offered.
    pub dropped_over_bound: u64,
    pub from_feed: u64,
    pub supplied: u64,
    pub superseded: u64,
    pub evicted: u64,
}

impl ProofStore {
    /// Offers the observer-accepted prefix of a feed page to
    /// [`depart_proof`]: the first `accepted` records — the observer's own
    /// `accepted_prefix` for that page (`0` when it was blocked already or
    /// refused the page's order, `k` when record `k` blocked it, the whole
    /// page otherwise; never a numeric sequence threshold) — at most
    /// [`MAX_EXTRACT_PER_PAGE`]; the rest are counted as dropped. The
    /// proofs that extract are stored with [`ORIGIN_FEED`]. Records that
    /// are not a committed WideDepart (most) are simply counted. Returns
    /// the number stored or superseded.
    pub fn observe_page(
        &mut self,
        page: &[TxRecord],
        scope: &ProofScope,
        accepted: usize,
    ) -> usize {
        let mut n = 0;
        let mut offered = 0usize;
        for (i, rec) in page.iter().enumerate() {
            self.records_seen += 1;
            if i >= accepted {
                self.dropped_unaccepted += 1;
                continue;
            }
            if offered >= MAX_EXTRACT_PER_PAGE {
                self.dropped_over_bound += 1;
                continue;
            }
            offered += 1;
            self.records_offered += 1;
            if let Ok(p) = depart_proof(rec, scope) {
                self.from_feed += 1;
                if self.offer(p, rec.seq, ORIGIN_FEED) {
                    n += 1;
                }
            }
        }
        n
    }

    /// Stores a proof an orchestrator holds, labelled [`ORIGIN_SUPPLIED`].
    /// The caller's provenance claims are **not** trusted: the stored
    /// proof says `signatures_verified = false` and method
    /// [`METHOD_SUPPLIED`] whatever came in. Its sequence is the proof's
    /// provenance sequence.
    pub fn supply(&mut self, mut proof: DepartProof) -> bool {
        self.supplied += 1;
        proof.provenance.signatures_verified = false;
        proof.provenance.method = METHOD_SUPPLIED;
        let seq = proof.provenance.seq;
        self.offer(proof, seq, ORIGIN_SUPPLIED)
    }

    fn offer(&mut self, proof: DepartProof, seq: u64, origin: &'static str) -> bool {
        let key = (proof.host, proof.transit_slot);
        if let Some(e) = self.entries.get(&key) {
            if e.seq >= seq {
                return false;
            }
            self.superseded += 1;
        }
        self.entries.insert(key, ProofEntry { proof, seq, origin });
        while self.entries.len() > MAX_PROOFS {
            let oldest = self
                .entries
                .iter()
                .min_by_key(|(_, e)| e.seq)
                .map(|(k, _)| *k);
            match oldest {
                Some(k) => {
                    self.entries.remove(&k);
                    self.evicted += 1;
                }
                None => break,
            }
        }
        true
    }

    pub fn get(&self, host: WideHostRef, transit_slot: u8) -> Option<&ProofEntry> {
        self.entries.get(&(host, transit_slot))
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// The `(host, transit slot)` pairs worth planning a reveal for: a
    /// stored proof whose march the model does not show revealed, settled
    /// or closed. A model that knows nothing of the host still yields the
    /// hint (the chain decides); a model whose latest march of the host is
    /// in another slot does not (the proof is superseded).
    pub fn hints(&self, model: &WideDiscovery) -> Vec<(WideHostRef, u8)> {
        self.entries
            .values()
            .filter(|e| match model.hosts.get(&e.proof.host) {
                None => true,
                Some(st) => match &st.transit {
                    None => true,
                    Some(t) if t.slot == e.proof.transit_slot => t.open() && t.reveal.is_none(),
                    Some(_) => false,
                },
            })
            .map(|e| (e.proof.host, e.proof.transit_slot))
            .collect()
    }

    pub fn status(&self) -> Value {
        json!({
            "held": self.entries.len(),
            "max": MAX_PROOFS,
            "records_seen": self.records_seen,
            "records_offered": self.records_offered,
            "dropped_unaccepted": self.dropped_unaccepted,
            "dropped_over_bound": self.dropped_over_bound,
            "extract_per_page": MAX_EXTRACT_PER_PAGE,
            "from_feed": self.from_feed,
            "supplied": self.supplied,
            "superseded": self.superseded,
            "evicted": self.evicted,
            "source": "signatures unverified; a proof is a hint, the chain decides",
        })
    }
}

// ------------------------------------------------------------ publications

/// A source of public beacon publications for the reveal review. Object
/// safe so the step takes `&mut dyn PublicationSource`.
pub trait PublicationSource: Send {
    /// The verified publication of `round` if served, asked at tick `slot`.
    fn publication<'a>(
        &'a mut self,
        round: u64,
        slot: u64,
    ) -> Pin<Box<dyn Future<Output = Option<Publication>> + Send + 'a>>;
    fn label(&self) -> &'static str;
}

/// Verified rounds for the review, separate from the beacon duty's
/// [`crate::rounds::Rounds`] so a review ask never changes what the beacon
/// duty asks or sends. A round is asked of the port at most once per slot;
/// a served round whose signature does not verify under the pinned key is
/// counted and dropped.
pub struct BeaconCache {
    pub pk96: [u8; 96],
    rounds: BTreeMap<u64, [u8; 48]>,
    asked: BTreeMap<u64, u64>,
    pub fetched: u64,
    pub bad: u64,
    pub asks: u64,
}

impl BeaconCache {
    pub fn new(pk96: [u8; 96]) -> BeaconCache {
        BeaconCache {
            pk96,
            rounds: BTreeMap::new(),
            asked: BTreeMap::new(),
            fetched: 0,
            bad: 0,
            asks: 0,
        }
    }

    pub fn pk_hash(&self) -> [u8; 32] {
        beacon::pk_hash(&self.pk96)
    }

    pub fn len(&self) -> usize {
        self.rounds.len()
    }

    pub fn is_empty(&self) -> bool {
        self.rounds.is_empty()
    }

    /// The verified publication of `round`, from the cache or the port.
    pub async fn publication<D: DrandPort>(
        &mut self,
        drand: &D,
        round: u64,
        slot: u64,
    ) -> Option<Publication> {
        if let Some(sig48) = self.rounds.get(&round) {
            return Some(Publication {
                round,
                sig48: *sig48,
                pk96: self.pk96,
            });
        }
        if self.asked.get(&round) == Some(&slot) {
            return None;
        }
        self.asked.insert(round, slot);
        self.asks += 1;
        while self.asked.len() > MAX_BEACON_CACHE {
            self.asked.pop_first();
        }
        let b = drand.round(round).await.ok().flatten()?;
        if b.round != round || !beacon::verify(round, &b.sig48, &self.pk96) {
            self.bad += 1;
            return None;
        }
        self.fetched += 1;
        self.asked.remove(&round);
        self.rounds.insert(round, b.sig48);
        while self.rounds.len() > MAX_BEACON_CACHE {
            self.rounds.pop_first();
        }
        Some(Publication {
            round,
            sig48: b.sig48,
            pk96: self.pk96,
        })
    }

    pub fn status(&self) -> Value {
        json!({
            "pk_hash": hex::encode(self.pk_hash()),
            "verified_rounds": self.rounds.len(),
            "max": MAX_BEACON_CACHE,
            "asks": self.asks,
            "fetched": self.fetched,
            "bad": self.bad,
        })
    }
}

/// A [`PublicationSource`] over a drand port and a [`BeaconCache`].
pub struct DrandPublications<'a, D: DrandPort> {
    pub drand: &'a D,
    pub cache: &'a mut BeaconCache,
}

impl<D: DrandPort> PublicationSource for DrandPublications<'_, D> {
    fn publication<'a>(
        &'a mut self,
        round: u64,
        slot: u64,
    ) -> Pin<Box<dyn Future<Output = Option<Publication>> + Send + 'a>> {
        Box::pin(async move { self.cache.publication(self.drand, round, slot).await })
    }
    fn label(&self) -> &'static str {
        "drand port, verified under the review's pinned key, one ask per round per slot"
    }
}

/// What the reveal review needs beyond the chain reads, passed by the
/// runtime only when it has them.
pub struct RevealInputs<'a> {
    /// The Season as the runtime last read it: the beacon round is
    /// `SeasonClock::from_season(season).tlock_round(arrive)`. The planner
    /// re-reads the Season from the chain and gates against that one.
    pub season: &'a Season,
    pub beacon: &'a mut dyn PublicationSource,
    /// The public beneficiary address the candidate names (no key).
    pub beneficiary: Address,
}

// ------------------------------------------------------------ sanitised codes

/// A bounded, typed code for a block in status output. Variants carrying
/// free text from a port, an RPC or a library error (`Read`, `Snapshot`,
/// `SealOpen`, `BadPlaintext`, `MarchValues`) are reduced to their name
/// (the snapshot's own typed code is passed through when it is one of the
/// known codes); every other variant carries only static strings and
/// numbers and is printed as is.
pub fn block_code(b: &Block) -> String {
    const SNAPSHOT_CODES: [&str; 9] = [
        "Unsupported",
        "TooManyKeys",
        "DuplicateKey",
        "Rpc",
        "Malformed",
        "Partial",
        "Stale",
        "BadClock",
        "BadRent",
    ];
    match b {
        Block::Read(_) => "Read".into(),
        Block::Snapshot(code) => {
            let known = SNAPSHOT_CODES.iter().any(|c| code.starts_with(c))
                && code
                    .chars()
                    .all(|ch| ch.is_ascii_alphanumeric() || "(),_ -".contains(ch));
            if known {
                format!("Snapshot({code})")
            } else {
                "Snapshot(Other)".into()
            }
        }
        Block::SealOpen(_) => "SealOpen".into(),
        Block::BadPlaintext(_) => "BadPlaintext".into(),
        Block::MarchValues(_) => "MarchValues".into(),
        other => format!("{other:?}"),
    }
}

/// Whether a reveal outcome is worth a bounded next-slot retry: a
/// readiness the next slot may bring — the publication not served yet,
/// THE anchor not landed (or only its archive read so far), no clock
/// observed, the Season stored `Seeded` before its genesis or judged
/// without a clock — or a read, read loop or snapshot failure. A closed
/// window, an existing reveal, a key or commitment mismatch and every
/// other refusal are not: they wait the full refresh.
pub fn is_transient(b: &Block) -> bool {
    matches!(
        b,
        Block::PublicationMissing
            | Block::AnchorRequired(_)
            | Block::TimingNeedsClock
            | Block::SeasonNotStarted { .. }
            | Block::SeasonDependsOnClock
            | Block::Read(_)
            | Block::ReadLoop
            | Block::Snapshot(_)
            | Block::SnapshotIncomplete(_)
    )
}

// ------------------------------------------------------------ the review

/// One ledger entry: when the hint was last planned, when it may be
/// planned again, how many transient retries in a row, the proof sequence
/// (reveal) it was planned from, and the summary.
struct Entry {
    slot: u64,
    next: u64,
    transient: u32,
    proof_seq: Option<u64>,
    summary: Value,
}

/// The state of the per-tick review.
pub struct WideReview {
    pub deployment: Deployment,
    /// Plans per tick; clamped to [`CANDIDATES_PER_TICK`] at every step.
    pub candidates_per_tick: usize,
    review_payer: Option<Address>,
    /// The departure proofs the reveal review may plan from.
    pub proofs: ProofStore,
    ledger: BTreeMap<String, Entry>,
    cursor: usize,
    pub ticks: u64,
    pub plans: u64,
    pub candidates: u64,
    pub blocked: u64,
    pub read_errors: u64,
    /// Candidates coherent at a snapshot's context slot.
    pub coherent: u64,
    /// Plans blocked by the snapshot itself (unsupported, stale, partial,
    /// malformed, or a key the response did not hold).
    pub snapshot_blocked: u64,
    pub reveal_plans: u64,
    pub reveal_candidates: u64,
    /// Reveal plans whose publication the source did not serve.
    pub publications_missing: u64,
    /// Reveal plans retried at the next slot after a transient outcome.
    pub transient_retries: u64,
    /// Reveal ledger entries invalidated by a newer proof.
    pub proofs_renewed: u64,
    /// Reconciliations (observed chain head vs the snapshot's account
    /// chain fields; `crate::widereconcile`): agreements, lag (the account
    /// ahead of the observer), disagreements, and comparisons that
    /// concluded nothing. Diagnostics; no verdict is read by any denial.
    pub reconcile_agree: u64,
    pub reconcile_lag: u64,
    pub reconcile_disagree: u64,
    pub reconcile_unknown: u64,
    reveal_inputs_at_last_step: Option<bool>,
    snapshot_at_last_step: Option<&'static str>,
}

impl WideReview {
    pub fn new(deployment: Deployment) -> WideReview {
        WideReview {
            deployment,
            candidates_per_tick: CANDIDATES_PER_TICK,
            review_payer: None,
            proofs: ProofStore::default(),
            ledger: BTreeMap::new(),
            cursor: 0,
            ticks: 0,
            plans: 0,
            candidates: 0,
            blocked: 0,
            read_errors: 0,
            coherent: 0,
            snapshot_blocked: 0,
            reveal_plans: 0,
            reveal_candidates: 0,
            publications_missing: 0,
            transient_retries: 0,
            proofs_renewed: 0,
            reconcile_agree: 0,
            reconcile_lag: 0,
            reconcile_disagree: 0,
            reconcile_unknown: 0,
            reveal_inputs_at_last_step: None,
            snapshot_at_last_step: None,
        }
    }

    /// The reconciliation diagnostics of a candidate's accounts against
    /// the reads it was planned over, when an observer is lent: each
    /// target's verdict, counted; the summaries carry them. Never read by
    /// a denial.
    fn reconcile_targets(
        &mut self,
        scope: &Scope,
        observer: Option<&WideObserver>,
        targets: &[WideTarget],
        reads: &Reads,
    ) -> Value {
        let Some(o) = observer else {
            return Value::Null;
        };
        let mut out = Vec::with_capacity(targets.len());
        for t in targets {
            let r = reconcile(scope, o, *t, reads);
            if r.verdict == Verdict::Agree {
                self.reconcile_agree += 1;
            } else if r.verdict.is_lag() {
                self.reconcile_lag += 1;
            } else if r.verdict.is_disagreement() {
                self.reconcile_disagree += 1;
            } else {
                self.reconcile_unknown += 1;
            }
            out.push(r.describe());
        }
        Value::Array(out)
    }

    /// The effective cap: never above the hard constant.
    pub fn cap(&self) -> usize {
        self.candidates_per_tick.min(CANDIDATES_PER_TICK)
    }

    /// The public address the unsigned candidates name as fee payer, whose
    /// account the funding review bounds. The all-zero address (the System
    /// Program) is refused: it is the placeholder, not a wallet.
    pub fn set_review_payer(&mut self, payer: Address) -> Result<(), &'static str> {
        if payer == Address::default() {
            return Err("the all-zero address is the System Program placeholder, not a payer");
        }
        self.review_payer = Some(payer);
        Ok(())
    }

    pub fn review_payer(&self) -> Option<Address> {
        self.review_payer
    }

    /// The hints the model offers, as `(id, Hint)`: settles, returns, then
    /// (with reveal inputs) the stored proofs' marches.
    fn hints(&self, model: &WideDiscovery, with_reveal: bool) -> Vec<(String, Hint)> {
        let mut v: Vec<(String, Hint)> = wideduty::settle_candidates(model)
            .into_iter()
            .map(|(h, s)| {
                (
                    format!("settle:{}:{s}", hex::encode(h.to_bytes())),
                    Hint::Settle(h, s),
                )
            })
            .collect();
        v.extend(
            wideduty::return_candidates(model)
                .into_iter()
                .map(|(p, h)| {
                    (
                        format!(
                            "return:{}:{}",
                            hex::encode(p.to_bytes()),
                            hex::encode(h.to_bytes())
                        ),
                        Hint::Return(p, h),
                    )
                }),
        );
        if with_reveal {
            v.extend(self.proofs.hints(model).into_iter().map(|(h, s)| {
                (
                    format!("reveal:{}:{s}", hex::encode(h.to_bytes())),
                    Hint::Reveal(h, s),
                )
            }));
        }
        v
    }

    /// Whether `hint` waits: its ledger entry's `next` is past `slot` and,
    /// for a reveal, the stored proof is the one it was planned from.
    fn waits(&self, id: &str, hint: &Hint, slot: u64) -> bool {
        let Some(e) = self.ledger.get(id) else {
            return false;
        };
        if let Hint::Reveal(h, s) = hint {
            let current = self.proofs.get(*h, *s).map(|p| p.seq);
            if current != e.proof_seq {
                return false;
            }
        }
        slot < e.next
    }

    /// One bounded step at tick `slot` (the lower bound of every read and
    /// the `minContextSlot` of a snapshot). `snapshot`: the additive
    /// source, if any. `reveal`: the reveal inputs, if the runtime has
    /// them (reveal hints are listed only then). Returns the number of
    /// plans made (each a bounded number of reads).
    #[allow(clippy::too_many_arguments)]
    pub async fn step<P: ChainPort>(
        &mut self,
        port: &P,
        engine: &Engine,
        model: &WideDiscovery,
        program: Address,
        season: Address,
        slot: u64,
        snapshot: Option<&dyn SnapshotSource>,
        reveal: Option<RevealInputs<'_>>,
    ) -> u64 {
        self.step_observing(
            port, engine, model, program, season, slot, snapshot, reveal, None,
        )
        .await
    }

    /// [`WideReview::step`] with the observer lent **read-only** for the
    /// reconciliation diagnostics (`crate::widereconcile`): every
    /// candidate's province and holding chain heads, as observed, against
    /// the account chain fields in the reads the candidate was planned
    /// over. Nothing of the observer is moved; no verdict reaches a denial.
    #[allow(clippy::too_many_arguments)]
    pub async fn step_observing<P: ChainPort>(
        &mut self,
        port: &P,
        engine: &Engine,
        model: &WideDiscovery,
        program: Address,
        season: Address,
        slot: u64,
        snapshot: Option<&dyn SnapshotSource>,
        mut reveal: Option<RevealInputs<'_>>,
        observer: Option<&WideObserver>,
    ) -> u64 {
        self.ticks += 1;
        self.reveal_inputs_at_last_step = Some(reveal.is_some());
        self.snapshot_at_last_step = snapshot.map(SnapshotSource::label);
        let hints = self.hints(model, reveal.is_some());
        if hints.is_empty() {
            return 0;
        }
        let scope = Scope {
            program,
            season,
            deployment: Some(self.deployment),
        };
        // No payer is drawn on this path. The candidate names the review
        // payer, or the all-zero placeholder the fee review refuses to
        // call a wallet; only a set payer rides along in the snapshot.
        let payer = self.review_payer.unwrap_or_default();
        let extra: Vec<Address> = self.review_payer.into_iter().collect();
        let cap = self.cap();
        let n = hints.len();
        let mut made = 0usize;
        let mut inspected = 0usize;
        for k in 0..n {
            if made >= cap {
                break;
            }
            inspected = k + 1;
            let (id, hint) = &hints[(self.cursor + k) % n];
            if self.waits(id, hint, slot) {
                continue;
            }
            made += 1;
            self.plans += 1;
            let entry = match hint {
                Hint::Settle(h, s) => {
                    let planned = match snapshot {
                        Some(src) => snapshot_plan_with(port, src, slot, false, &extra, |r| {
                            wideduty::plan_settle_departure(&scope, payer, *h, *s, r)
                        })
                        .await
                        .map(|(c, snap)| (c, Some(snap))),
                        None => wideduty::settle_departure_via(port, &scope, payer, *h, *s, slot)
                            .await
                            .map(|c| (c, None)),
                    };
                    self.duty_entry(id, slot, engine, planned, &scope, observer)
                }
                Hint::Return(p, h) => {
                    let planned = match snapshot {
                        Some(src) => snapshot_plan_with(port, src, slot, false, &extra, |r| {
                            wideduty::plan_return(&scope, payer, *p, *h, r)
                        })
                        .await
                        .map(|(c, snap)| (c, Some(snap))),
                        None => wideduty::return_via(port, &scope, payer, *p, *h, slot)
                            .await
                            .map(|c| (c, None)),
                    };
                    self.duty_entry(id, slot, engine, planned, &scope, observer)
                }
                Hint::Reveal(h, s) => {
                    self.reveal_plans += 1;
                    let (proof, origin, proof_seq) = match self.proofs.get(*h, *s) {
                        Some(e) => (e.proof.clone(), e.origin, e.seq),
                        None => {
                            // A hint is listed only from a stored proof.
                            self.blocked += 1;
                            self.ledger.insert(
                                id.clone(),
                                Entry {
                                    slot,
                                    next: slot.saturating_add(REFRESH_SLOTS),
                                    transient: 0,
                                    proof_seq: None,
                                    summary: json!({"hint": id, "slot": slot, "outcome": "blocked", "block": "NoProof"}),
                                },
                            );
                            continue;
                        }
                    };
                    let prior = self.ledger.get(id.as_str());
                    let renewed = prior.is_some_and(|e| e.proof_seq != Some(proof_seq));
                    if renewed {
                        self.proofs_renewed += 1;
                    }
                    let prior_transient = prior.filter(|_| !renewed).map_or(0, |e| e.transient);
                    if prior_transient > 0 {
                        self.transient_retries += 1;
                    }
                    let inputs = reveal
                        .as_mut()
                        .expect("reveal hints are listed only with inputs");
                    let round =
                        SeasonClock::from_season(inputs.season).tlock_round(proof.arrive_bell);
                    let publication = inputs.beacon.publication(round, slot).await;
                    if publication.is_none() {
                        self.publications_missing += 1;
                    }
                    let opening = Opening::FromBeacon;
                    let beneficiary = inputs.beneficiary;
                    // Never bytes older than the departure the proof came from.
                    let min_slot = slot.max(proof.provenance.slot);
                    let planned = match snapshot {
                        Some(src) => snapshot_plan_with(port, src, min_slot, true, &extra, |r| {
                            widereveal::plan_reveal(
                                &scope,
                                payer,
                                beneficiary,
                                &proof,
                                Some(&opening),
                                publication.as_ref(),
                                r,
                            )
                        })
                        .await
                        .map(|(c, snap)| (c, Some(snap))),
                        None => widereveal::reveal_via(
                            port,
                            &scope,
                            payer,
                            beneficiary,
                            &proof,
                            Some(&opening),
                            publication.as_ref(),
                            min_slot,
                        )
                        .await
                        .map(|c| (c, None)),
                    };
                    self.reveal_entry(
                        id,
                        slot,
                        min_slot,
                        engine,
                        planned,
                        RevealMeta {
                            round,
                            publication_served: publication.is_some(),
                            origin,
                            proof_seq,
                            prior_transient,
                            renewed,
                        },
                        &scope,
                        observer,
                    )
                }
            };
            self.ledger.insert(id.clone(), entry);
        }
        // Advance by the positions inspected, so skipped hints are not
        // revisited first next tick.
        self.cursor = (self.cursor + inspected) % n.max(1);
        while self.ledger.len() > MAX_LEDGER {
            let oldest = self
                .ledger
                .iter()
                .min_by_key(|(_, e)| e.slot)
                .map(|(k, _)| k.clone());
            match oldest {
                Some(k) => {
                    self.ledger.remove(&k);
                }
                None => break,
            }
        }
        made as u64
    }

    fn note_block(&mut self, b: &Block) {
        self.blocked += 1;
        if matches!(b, Block::Read(_)) {
            self.read_errors += 1;
        }
        if matches!(b, Block::Snapshot(_) | Block::SnapshotIncomplete(_)) {
            self.snapshot_blocked += 1;
        }
    }

    fn duty_entry(
        &mut self,
        id: &str,
        slot: u64,
        engine: &Engine,
        planned: Result<(Candidate, Option<Snapshot>), Block>,
        scope: &Scope,
        observer: Option<&WideObserver>,
    ) -> Entry {
        let summary = match planned {
            Ok((c, snap)) => {
                self.candidates += 1;
                if c.coherent() {
                    self.coherent += 1;
                }
                // The reads the candidate was planned over: the snapshot's,
                // or ordinary reads (no snapshot verifies; the fee review
                // declares the requirement unknown and the review keeps
                // `NoCoherentSnapshot`).
                let reads = snap
                    .as_ref()
                    .map(Snapshot::reads)
                    .unwrap_or_else(|| Reads::new(slot));
                let view = EngineView::of(engine, &Subject::of_duty(&c));
                let a = review_candidate(&c, &reads, &view);
                // The accounts the duty names, reconciled (diagnostics).
                let targets: Vec<WideTarget> = match &c.duty {
                    Duty::SettleDeparture(f) => {
                        vec![WideTarget::Province(f.origin), WideTarget::Holding(f.host)]
                    }
                    Duty::Return(f) => {
                        let mut v = vec![
                            WideTarget::Province(f.standing),
                            WideTarget::Holding(f.holding),
                        ];
                        if f.foreign {
                            v.push(WideTarget::Province(f.holding.key()));
                        }
                        v
                    }
                };
                let reconcile = self.reconcile_targets(scope, observer, &targets, &reads);
                json!({
                    "hint": id,
                    "slot": slot,
                    "min_slot": slot,
                    "outcome": "candidate",
                    "candidate": c.describe(),
                    "snapshot": snap.as_ref().map(|s| s.meta().describe()),
                    "assessment": a.describe(),
                    "reconcile": reconcile,
                })
            }
            Err(b) => {
                self.note_block(&b);
                json!({
                    "hint": id,
                    "slot": slot,
                    "min_slot": slot,
                    "outcome": "blocked",
                    "block": block_code(&b),
                })
            }
        };
        Entry {
            slot,
            next: slot.saturating_add(REFRESH_SLOTS),
            transient: 0,
            proof_seq: None,
            summary,
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn reveal_entry(
        &mut self,
        id: &str,
        slot: u64,
        min_slot: u64,
        engine: &Engine,
        planned: Result<(RevealCandidate, Option<Snapshot>), Block>,
        meta: RevealMeta,
        scope: &Scope,
        observer: Option<&WideObserver>,
    ) -> Entry {
        let common = json!({
            "hint": id,
            "slot": slot,
            "min_slot": min_slot,
            "proof_origin": meta.origin,
            "proof_seq": meta.proof_seq,
            "proof_renewed": meta.renewed,
            "publication_round": meta.round,
            "publication_served": meta.publication_served,
            "opening": "FromBeacon",
            "retry": meta.prior_transient,
        });
        let (summary, next, transient) = match planned {
            Ok((c, snap)) => {
                self.candidates += 1;
                self.reveal_candidates += 1;
                if c.coherent() {
                    self.coherent += 1;
                }
                let reads = snap
                    .as_ref()
                    .map(Snapshot::reads)
                    .unwrap_or_else(|| Reads::new(min_slot));
                let view = EngineView::of(engine, &Subject::of_reveal(&c));
                let a = review_reveal(&c, &reads, &view);
                let targets = [
                    WideTarget::Holding(c.facts.host),
                    WideTarget::Province(c.facts.dest),
                ];
                let reconcile = self.reconcile_targets(scope, observer, &targets, &reads);
                // `describe` carries identities, counts and labels: not the
                // instruction data (the opened plaintext and salt).
                let mut s = common;
                s["outcome"] = json!("candidate");
                s["candidate"] = c.describe();
                s["snapshot"] = json!(snap.as_ref().map(|s| s.meta().describe()));
                s["assessment"] = a.describe();
                s["reconcile"] = reconcile;
                (s, slot.saturating_add(REVEAL_REFRESH_SLOTS), 0)
            }
            Err(b) => {
                self.note_block(&b);
                let mut s = common;
                s["outcome"] = json!("blocked");
                s["block"] = json!(block_code(&b));
                if is_transient(&b) {
                    let count = meta.prior_transient + 1;
                    if count <= MAX_TRANSIENT_RETRIES {
                        s["next"] = json!("next slot");
                        (s, slot.saturating_add(1), count)
                    } else {
                        s["next"] = json!("retries used; reveal refresh");
                        (s, slot.saturating_add(REVEAL_REFRESH_SLOTS), 0)
                    }
                } else {
                    (s, slot.saturating_add(REFRESH_SLOTS), 0)
                }
            }
        };
        Entry {
            slot,
            next,
            transient,
            proof_seq: Some(meta.proof_seq),
            summary,
        }
    }

    /// What the review covers as configured, in one line.
    fn covers(&self) -> String {
        let reads = match self.snapshot_at_last_step {
            Some(_) => {
                "one snapshot response per plan (coherent at its context slot, never current)"
            }
            None => "ordinary reads (no snapshot source: coherent false)",
        };
        let reveal = match self.reveal_inputs_at_last_step {
            Some(true) => "reveal hints from stored proofs with the runtime's reveal inputs",
            Some(false) => "no reveal hints (no reveal inputs at the last step)",
            None => "no reveal hints yet (no step)",
        };
        format!("settle and return hints over {reads}; {reveal}")
    }

    /// Exactly what the review lacks, if anything.
    fn missing(&self) -> Vec<&'static str> {
        let mut m = Vec::new();
        if self.snapshot_at_last_step.is_none() {
            m.push("snapshot source: none at the last step (enable_wide_snapshot_via_port or enable_wide_snapshot); candidates are non-coherent");
        }
        if self.reveal_inputs_at_last_step != Some(true) {
            m.push("reveal inputs: the runtime passes them only once the Season is read and a publication source exists (season clock for the beacon round, drand port, public beneficiary)");
        }
        if self.proofs.is_empty() {
            m.push("departure proofs: none extracted from a feed page or supplied; no reveal can be planned");
        }
        if self.review_payer.is_none() {
            m.push("payer: none set; funding is not reviewed (the candidates name the System Program placeholder)");
        }
        m
    }

    /// The status entry: counts, bounds and the most recent summaries.
    pub fn status(&self) -> Value {
        let mut recent: Vec<&Entry> = self.ledger.values().collect();
        recent.sort_by_key(|b| std::cmp::Reverse(b.slot));
        json!({
            "mode": "review-only",
            "automatic_writes": false,
            "enqueued": 0,
            "signed": false,
            "covers": self.covers(),
            "deployment": {
                "program_version": self.deployment.program_version,
                "ruleset_hash": hex::encode(self.deployment.ruleset_hash),
            },
            "payer": match self.review_payer {
                Some(p) => json!(p.to_string()),
                None => json!(PAYER_UNSET),
            },
            "candidates_per_tick": self.cap(),
            "hard_cap": CANDIDATES_PER_TICK,
            "refresh_slots": REFRESH_SLOTS,
            "reveal_refresh_slots": REVEAL_REFRESH_SLOTS,
            "max_transient_retries": MAX_TRANSIENT_RETRIES,
            "ticks": self.ticks,
            "plans": self.plans,
            "candidates": self.candidates,
            "blocked": self.blocked,
            "read_errors": self.read_errors,
            "ledger": self.ledger.len(),
            "cursor": self.cursor,
            "snapshot": match self.snapshot_at_last_step {
                Some(label) => json!({
                    "source": label,
                    "coherent_candidates": self.coherent,
                    "blocked": self.snapshot_blocked,
                    "note": "one getMultipleAccounts per plan at the plan's minimum slot as minContextSlot; coherence at the response's context slot, never currency or permission",
                }),
                None => json!({
                    "source": "absent",
                    "coherent_candidates": self.coherent,
                    "blocked": self.snapshot_blocked,
                    "note": "ChainPort reads only; every candidate non-coherent",
                }),
            },
            "reveal": {
                "inputs_at_last_step": self.reveal_inputs_at_last_step,
                "proofs": self.proofs.status(),
                "plans": self.reveal_plans,
                "candidates": self.reveal_candidates,
                "publications_missing": self.publications_missing,
                "transient_retries": self.transient_retries,
                "proofs_renewed": self.proofs_renewed,
                "min_slot": "max(tick slot, proof slot)",
                "opening": "FromBeacon: the public round signature opens the seal; no plaintext, salt or key is held or shown",
                "history": "unknown before the applied records; the proof's signatures are unverified",
            },
            "reconcile": {
                "agree": self.reconcile_agree,
                "lag": self.reconcile_lag,
                "disagree": self.reconcile_disagree,
                "unknown": self.reconcile_unknown,
                "meaning": "cross-input consistency of the observed chain head with the account's chain fields in the candidate's snapshot; the two inputs' source relationship is unverified; never history authenticity or completeness; read by no denial",
            },
            "missing": self.missing(),
            "recent": recent.into_iter().take(8).map(|e| e.summary.clone()).collect::<Vec<_>>(),
        })
    }
}

/// What a reveal entry records besides the plan.
struct RevealMeta {
    round: u64,
    publication_served: bool,
    origin: &'static str,
    proof_seq: u64,
    prior_transient: u32,
    renewed: bool,
}

#[derive(Clone, Copy, Debug)]
enum Hint {
    Settle(WideHostRef, u8),
    Return(ProvinceKey, WideHostRef),
    /// A stored proof's march, by `(host, transit slot)`.
    Reveal(WideHostRef, u8),
}
