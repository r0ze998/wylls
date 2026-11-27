//! The escalation engine (M1 contract §8.2 "Bid policy", I-21, I-49, I-50).
//!
//! A duty asks for a **write** (one object to create or advance, keyed
//! uniquely) with its class and an instruction builder. Every slot until
//! the write lands the engine sends **a new version**: a new signature from
//! a **newly drawn random payer** of the class's pool, at the class's bid
//! for that slot —
//!
//! - **W** (Reveal): from `p_start` (= `p_tip`, or `--peace-start f × p_tip`)
//!   doubling every slot to **P_def 2.0** (capped by the season's
//!   `defence_cap_milli`); never sent at or after its deadline slot;
//! - **D** (delay-only): from the low bid doubling to **P_delay 0.5**;
//! - **N**: the fixed low bid.
//!
//! Each version carries the per-kind CU limit and `L(kind)` from the budgets
//! table. **Retry ladder (I-50):** `ComputationalBudgetExceeded` → the next
//! version asks `min(2 × limit, 1.4M)`, then 1.4M; a program that fails to
//! complete (the heap access fault of a fill past 32 KiB) → the next
//! version adds `RequestHeapFrame(262,144)`. Each rung is journalled and
//! alerted: a breach is a gate failure to fix, never a stuck province.
//! **W6T-2:** the local chain reports running out of compute as
//! `ProgramFailedToComplete` too (log "exceeded CUs meter", units consumed
//! = the limit; 28,655 closes in the w6-s7 drain took the heap rung, then
//! ended Dead, and were planned again ≈ 270 times each). A failed version's
//! units and logs come from the transaction feed ([`Engine::note_tx_meta`]);
//! when the keeper reads the feed ([`Engine::expect_tx_meta`]) a
//! `ProgramFailedToComplete` waits up to [`META_WAIT_SLOTS`] for them, and
//! one that used its whole limit or logged the meter climbs the CU ladder.
//!
//! **One version per chain slot (W6T-2):** a W write gets a new version
//! every slot, but never a second one in the chain slot its last version
//! went out in (a tick that ran late sent its version in the next slot,
//! where the next tick's version joined it: two Reveals of one march in
//! one block, one `AlreadyDone`; 203 in w6-s7).
//!
//! **Contested:** a write not landed `contested_slots` (2) slots after a
//! version at a bid ≥ `p_tip` marks its `(bell, region)` contested; the
//! keeper alerts and its duties react (anchor fallbacks every slot).
//!
//! **Duplicates:** only one version can take effect; the others fail
//! (`AlreadyDone`, `OutOfOrder`) or no-op and still pay their fee. New
//! versions stop once the versions' fees could exceed `per_write_cap`
//! (§8.2's bound `resends × (base + fee) ≤ per_write_cap`); the write then
//! waits on the versions already sent.
//!
//! **Resend cadence of D and N writes (W6-C, amendment requested):** W
//! writes get a new version every slot. A D or N write whose earlier
//! version is still in flight (sent, status unknown, blockhash valid) gets
//! the next one only [`EngineParams::d_resend_slots`] (2) slots after the
//! last while its bid still rises, and only every
//! [`EngineParams::cap_resend_slots`] (16) slots once the bid is at the
//! class cap (D: P_delay; N: its fixed bid), since a version at the same
//! bid buys nothing but a fresh payer. A version whose status is known
//! (a failure the retry ladder answers) is followed at once. Measured
//! before (W5-B runs): a SkipQuiet held 24 slots by the `lag` hold sent 24
//! versions, and when the hold ended one landed and 23 failed `OutOfOrder`;
//! a keeper tick that ran past its slot sent a second version of writes
//! whose first landed one slot later (3 `OutOfOrder` in the smoke).
//!
//! **Refusal back-off (fix-keeper-backoff, D-dress-8):** a write that ended
//! `Failed` waits before its duty may plan it again. A *transient* refusal
//! ([`transient_refusal`]: "not yet" / "someone moved first", e.g.
//! `NoAnchor`, `TooEarly`, `NotQuiet`) keeps the short backoff: 2, 4, …
//! slots, at most 1,024. Every other refusal — a program code outside that
//! list, a chain error without a code (except a payer's
//! `InsufficientFunds…`), or a `Dead` end other than a deadline — is
//! deterministic for the same instruction and takes the **refusal hold**:
//! after the `n`-th refusal in a row with the same code the key
//! waits `2 << (n − 1)` slots (at most [`EngineParams::refusal_max_slots`])
//! **and** `2^(n − 1)` keeper passes (at most
//! [`EngineParams::refusal_max_passes`]; a pass on a paced public RPC spans
//! tens of slots). The hold ends when the write lands (the streak too),
//! and is lifted for one send when the duty plans a different instruction
//! for the key ([`spec_fingerprint`]: the chain state it read changed); the
//! streak goes on if that one is refused with the same code. The **group breaker**: once
//! [`EngineParams::refusal_group_min`] distinct keys of one duty kind were
//! refused with the same code and nothing of that kind landed since, the
//! kind sends one probe at a time at doubling gaps until one lands (W
//! writes, beacon kinds and payer care are exempt). Before this, the 1,024-slot
//! cap applied to every refusal (≈ 7 min: about 200 resends a day per key at
//! 1×) and a `Dead` write was planned again the next pass. Holds are in
//! memory: a restart starts them over. RPC errors (429, timeouts) are send
//! errors, not outcomes, and are untouched. `/v1/status.refusals` shows them.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::sync::Arc;

use solana_address::Address;
use solana_hash::Hash;
use solana_instruction::Instruction;
use solana_signature::Signature;
use solana_signer::Signer;

use fclient::abi::{self, err, Class};
use fclient::budgets::Budgets;
use fclient::ports::{ChainPort, Status};
use fclient::{fees, tx};

use crate::journal::{Attempt, Journal};
use crate::pools::Payers;

/// What a builder learns about the version it builds.
#[derive(Clone, Copy, Debug)]
pub struct BuildCtx {
    /// The fee payer drawn for this version (also `rent_to`, I-49).
    pub payer: Address,
    /// 0 for the first version.
    pub version: u32,
    /// Slots since the first version.
    pub slots_waiting: u64,
}

pub type Builder = Arc<dyn Fn(&BuildCtx) -> Vec<Instruction> + Send + Sync>;

/// One write a duty wants landed.
#[derive(Clone)]
pub struct WriteSpec {
    /// Unique object key (`anchor:<bell>:<region>`, …).
    pub key: String,
    /// Duty kind (journal, metrics).
    pub kind: &'static str,
    /// Frontier instruction tag (budgets).
    pub tag: u8,
    pub class: Class,
    pub bell: Option<u32>,
    pub region: Option<u8>,
    pub build: Builder,
    /// Never send a version in this slot or later (W writes: `A + W − 2 slots`).
    pub deadline_slot: Option<u64>,
    /// First slot a version may be sent (anchor fallbacks lag the combined form).
    pub not_before_slot: u64,
    /// A fixed fee payer (payer care: the transfer's source signs) instead
    /// of a draw from the class's pool.
    pub fixed_payer: Option<Address>,
}

/// Bid parameters of the fleet (milli-units of priority, §10.1).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct EngineParams {
    /// W writes start here (`p_tip`, or `peace_start × p_tip`).
    pub p_start_milli: u64,
    /// D writes start here (the low bid).
    pub d_start_milli: u64,
    pub p_low_milli: u64,
    /// `min(P_def, season defence cap)`.
    pub p_def_milli: u64,
    pub p_delay_milli: u64,
    /// The tip level: the contested threshold.
    pub p_tip_milli: u64,
    pub contested_slots: u64,
    pub per_write_cap: u64,
    /// Hard stop on versions of one write.
    pub max_versions: u32,
    /// D and N writes with a version in flight: slots between versions
    /// while the bid rises (W writes: every slot).
    pub d_resend_slots: u64,
    /// D and N writes with a version in flight: slots between versions at
    /// the class cap.
    pub cap_resend_slots: u64,
    /// W writes: at most this many versions whose status is unknown and
    /// whose blockhash can still land at once (⑱, owner decision
    /// 2026-11-05). Versions of one write are alternatives: once one
    /// lands, every other that lands later pays its fee for an
    /// `AlreadyDone`. A new version waits until an older one settles or
    /// expires. `0` keeps the old every-slot ladder.
    pub max_unknown_w_versions: u32,
    /// fix-keeper-backoff: a write the program refused deterministically
    /// (a code outside [`transient_refusal`], a chain error without a code,
    /// or a `Dead` end other than a deadline) is held for `2 << (n − 1)`
    /// slots after its `n`-th refusal in a row with one code, at most this many slots
    /// (the old cap, 1,024, stays for transient codes).
    pub refusal_max_slots: u64,
    /// … and also for `2^(n − 1)` keeper passes ([`Engine::begin_pass`]),
    /// at most this many. `0` (the engine's own default) turns the pass
    /// gate off; the keeper sets it from `keeper.toml` (default 64).
    pub refusal_max_passes: u64,
    /// The group breaker: once this many distinct keys of one duty kind
    /// were refused with the same code and nothing of that kind landed
    /// since, the whole kind waits for one probe at a time (W writes,
    /// beacon kinds and payer care are exempt). `0` turns it off.
    pub refusal_group_min: u32,
}

impl Default for EngineParams {
    fn default() -> Self {
        EngineParams {
            p_start_milli: 433,
            d_start_milli: crate::P_LOW_MILLI,
            p_low_milli: crate::P_LOW_MILLI,
            p_def_milli: crate::P_DEF_MILLI,
            p_delay_milli: crate::P_DELAY_MILLI,
            p_tip_milli: 433,
            contested_slots: 2,
            per_write_cap: 20_000_000,
            max_versions: 64,
            d_resend_slots: 2,
            cap_resend_slots: 16,
            // Off here (the engine's own tests keep the every-slot ladder);
            // the keeper sets it from `keeper.toml` (default 2).
            max_unknown_w_versions: 0,
            refusal_max_slots: REFUSAL_MAX_SLOTS,
            refusal_max_passes: 0,
            refusal_group_min: 0,
        }
    }
}

/// Versions that can still land: status unknown and sent within the
/// blockhash validity (`EXPIRY_SLOTS`) of `slot`. `versions` gives each
/// version's `sent_slot` and whether its status is known.
pub fn live_unknown_versions(versions: impl IntoIterator<Item = (u64, bool)>, slot: u64) -> usize {
    versions
        .into_iter()
        .filter(|&(sent, settled)| !settled && slot <= sent.saturating_add(EXPIRY_SLOTS))
        .count()
}

impl EngineParams {
    /// The bid of the version sent `slots` slots after the first.
    pub fn bid(&self, class: Class, slots: u64) -> u64 {
        let double = |start: u64, cap: u64| {
            start
                .max(1)
                .saturating_mul(1u64 << slots.min(20))
                .min(cap)
                .max(start.min(cap))
        };
        match class {
            Class::W => double(self.p_start_milli, self.p_def_milli),
            Class::D => double(self.d_start_milli, self.p_delay_milli),
            _ => self.p_low_milli,
        }
    }
}

/// One version as sent.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Version {
    pub sig: Signature,
    pub payer: Address,
    pub bid_milli: u64,
    pub cu_limit: u32,
    pub heap: Option<u32>,
    pub sent_slot: u64,
    /// Last valid block height of the signed blockhash. Old journal rows
    /// have no height, so `None` gives no expiry evidence.
    pub last_valid_block_height: Option<u64>,
    /// The chain's slot when the version actually went out (a Clock read
    /// in the same `send`; ≥ `sent_slot`, the tick's slot, when the tick ran
    /// late). The resend cadence counts from it (W6-C).
    pub chain_slot: u64,
    /// Fee if it lands (base + priority).
    pub fee: u64,
}

/// How a write ended.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Outcome {
    /// Landed (or a version found it already done, code 52).
    Landed {
        slot: u64,
        sig: Signature,
        payer: Address,
        versions: usize,
        first_slot: u64,
        already_done: bool,
    },
    /// The program refused it with this code: the duty re-plans (after a
    /// short backoff) or gives up.
    Failed {
        code: Option<u32>,
        err: String,
        slot: u64,
    },
    /// The retry window ended, but an old signature still has no definitive
    /// status. Its fee remains reserved and this key cannot re-plan yet.
    Unresolved { err: String, slot: u64 },
    /// Nothing more to do: window closed, not implemented, deadline passed.
    Dead { reason: String, code: Option<u32> },
}

/// Why a duty stopped watching a pending write. Only `ChainStateObserved`
/// means the duty has independently seen the object on chain.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CancelReason {
    ChainStateObserved,
    SupersededNonce,
    StaleBell,
}

/// A signature from a locally abandoned write later succeeded on chain.
/// This is an observation for the operator, never a duty `Outcome::Landed`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CancelledLanding {
    pub key: String,
    pub sig: Signature,
    pub slot: u64,
    pub reason: CancelReason,
}

struct Pending {
    spec: WriteSpec,
    /// Stable identity of this signed write across fee-bid variants. The
    /// first signature supplies the ID; it is persisted before the RPC send.
    write_id: Option<String>,
    first_slot: Option<u64>,
    versions: Vec<Version>,
    /// Versions whose status is known (failed ones stay in `versions` for
    /// the spend bound).
    settled: std::collections::HashSet<Signature>,
    /// Finality was observed but its journal write failed. Sending is
    /// stopped until the same signature can be durably reconciled.
    journal_blocked: std::collections::HashSet<Signature>,
    /// A terminal refusal is provisional while another signed version can
    /// still land. No new version is sent until that cohort is resolved.
    /// This is in-memory only; restart needs a durable cohort and outcome
    /// delivery record before it can recover the same duty notification.
    provisional: Option<Outcome>,
    cu_limit: u32,
    heap: Option<u32>,
    contested: bool,
    /// Added to every version's bid (milli): orders the Reveals of one
    /// group sent in the same slot so a block lands them in rank order (W4-C).
    bonus_milli: u64,
}

/// What one step did.
#[derive(Default, Debug)]
pub struct StepReport {
    pub outcomes: Vec<(String, Outcome)>,
    pub cancelled_landed: Vec<CancelledLanding>,
    pub sent: usize,
    /// Newly contested `(bell, region, key)`.
    pub contested: Vec<(Option<u32>, Option<u8>, String)>,
    /// Retry-ladder rungs taken `(key, cu_limit, heap)`.
    pub ladder: Vec<(String, u32, Option<u32>)>,
    pub send_errors: Vec<(String, String)>,
}

/// Counters per duty kind.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct KindStats {
    pub writes: u64,
    pub versions: u64,
    pub landed: u64,
    pub failed: u64,
    pub dead: u64,
    /// Slots from the first version to landing, one entry per landed write.
    pub latency_slots: Vec<u64>,
    /// Fees of landed-or-failed versions (charged).
    pub fees_charged: u64,
    /// fix-keeper-backoff: deterministic refusals recorded (each starts or
    /// extends a refusal hold).
    pub refused: u64,
    /// `ensure` calls turned away by a refusal hold or an open group.
    pub suppressed: u64,
}

pub struct Engine {
    /// keeper-landing-investigate: `getSignatureStatuses` reads of `poll`
    /// that failed as a whole (total, in a row, the last error). Before,
    /// a failed read was dropped silently and nothing ever landed.
    pub status_read_errors: (u64, u64, Option<String>),
    feed_block: Option<crate::feedguard::FeedBlock>,
    feed_ready: bool,
    pending: BTreeMap<String, Pending>,
    backoff: HashMap<String, u64>,
    /// Consecutive program refusals per key (the backoff doubles with each).
    failures: HashMap<String, u32>,
    /// fix-keeper-backoff: deterministic refusals per key (module docs,
    /// "Refusal back-off").
    refusals: BTreeMap<String, Refusal>,
    /// The group breaker per `(kind, code)`.
    refusal_groups: BTreeMap<(&'static str, Option<u32>), RefusalGroup>,
    /// Keeper passes so far ([`Self::begin_pass`]).
    pass: u64,
    /// Holds lifted early because the duty planned a different instruction.
    pub refusal_resets: u64,
    /// verify-pr192: keys an open group turned away this pass, per kind …
    refusal_asked: BTreeMap<&'static str, BTreeSet<String>>,
    /// … and the one chosen at the pass start to take the kind's next probe
    /// (a key outside the group first, else the one refused longest ago),
    /// so a refused key planned before healthy ones cannot take every probe.
    refusal_pick: BTreeMap<&'static str, String>,
    /// Versions whose write is gone (cancelled, adopted after a restart):
    /// polled until resolved so the journal is complete.
    orphans: Vec<(Signature, u64)>,
    /// `last_valid_block_height` of each orphan that has one (old journal
    /// rows do not): lets [`Self::poll`] settle an orphan that can no longer land.
    orphan_valid_height: HashMap<Signature, u64>,
    /// Versions settled as never landed ([`EXPIRED_MARGIN_BLOCKS`]).
    pub never_landed: u64,
    /// In-memory reason for an abandoned signature. The journal still owns
    /// its fee/status; durable notification recovery is a separate concern.
    cancelled_orphans: HashMap<Signature, (String, CancelReason)>,
    /// A retry window may end with signatures still unresolved. Keep only
    /// those keys from starting a fresh fee budget until every old signature
    /// has a definitive status. Other writes continue normally.
    held_replans: HashMap<String, HashSet<Signature>>,
    adopted: HashMap<String, Vec<Version>>,
    adopted_write_ids: HashMap<String, Option<String>>,
    /// Multiple recovered write generations share one object key. They
    /// cannot be folded into one retry budget, even by a direct Engine user.
    adopted_ambiguous: HashSet<String>,
    pub budgets: Budgets,
    pub params: EngineParams,
    pub stats: BTreeMap<String, KindStats>,
    /// Signed versions whose fee has not yet been accounted for. A version
    /// can be visible both as an adopted write and as an orphan after a
    /// restart; removing by signature makes either observation charge once.
    uncounted_fees: HashMap<Signature, (String, u64)>,
    /// The keeper reads the transaction feed, which gives a failed
    /// version's units and logs (W6T-2).
    pub expect_tx_meta: bool,
    /// Failed versions: `(units consumed, "exceeded CUs meter" logged)`.
    tx_meta: HashMap<Signature, (u64, bool)>,
    /// `ProgramFailedToComplete` statuses waiting for their meta: first slot seen.
    meta_wait: HashMap<Signature, u64>,
    /// The chain's slot at the last `send` that sent a version.
    pub last_send_chain_slot: Option<u64>,
    /// Finalized care attempt whose balance effects every later care plan
    /// must observe. A confirmed account snapshot may lag this slot.
    care_settled_slot: Option<u64>,
}

/// Slots a `ProgramFailedToComplete` waits for the feed's meta before it
/// is judged a heap fault (W6T-2).
pub const META_WAIT_SLOTS: u64 = 3;

/// `ComputationalBudgetExceeded` in any of its spellings.
pub fn is_cu_exceeded(e: &str) -> bool {
    e.contains("ComputationalBudgetExceeded")
        || e.contains("exceeded CUs meter")
        || e.contains("ComputeBudgetExceeded")
}

/// A program that did not complete (SBF access violation, e.g. the heap
/// fault of a fill past the default 32-KiB heap).
pub fn is_heap_fault(e: &str) -> bool {
    e.contains("ProgramFailedToComplete") || e.contains("Access violation in heap")
}

const BACKOFF_SLOTS: u64 = 2;
/// The text of a write that ran out of versions or fee cap with a
/// signature still unknown ([`Outcome::Failed`], code `None`).
const RETRY_WINDOW_UNRESOLVED: &str = "versions unresolved after retry window";
/// The default cap of a refusal hold in slots (≈ 1 h at 400 ms).
pub const REFUSAL_MAX_SLOTS: u64 = 9_000;
/// The keeper's default cap of a refusal hold in passes.
pub const REFUSAL_MAX_PASSES: u64 = 64;
/// The keeper's default group-breaker threshold.
pub const REFUSAL_GROUP_MIN: u32 = 4;
/// Refusal entries a status shows at most.
pub const REFUSAL_STATUS_KEYS: usize = 32;

/// A refusal that means "not yet" or "someone else moved first": the duty
/// re-plans it on the next chain read and it normally lands soon. These
/// keep the short backoff (2, 4, … 1,024 slots); every other program
/// refusal is deterministic for the same instruction and takes the refusal
/// hold. (The first ten are the codes `Keeper::note_step` never alerted
/// on; the rest wait on another write or on time.)
pub fn transient_refusal(code: u32) -> bool {
    matches!(
        code,
        err::NO_ANCHOR
            | err::SEED_NOT_READY
            | err::FOLD_STALE
            | err::TICKET_STATE
            | err::NOT_QUIET
            | err::SLOT_MOVED
            | err::QUOTA_REFUSED
            | err::TOO_EARLY
            | err::DEPARTURE_UNSETTLED
            | err::FOLD_TOO_EARLY
            | err::NOT_GATHERED
            | err::INPUTS_OPEN
            | err::NOT_DUE
            | err::HOST_IN_TRANSIT
            | err::NEED_ARRIVAL_DAY
            | err::CAPTURE_PENDING
            | err::STAKE_UNSETTLED
            | err::SIEGE_BUSY
    )
}

/// Kinds the group breaker never closes (time-critical or not a program write).
fn group_exempt(kind: &str, class: Class) -> bool {
    class == Class::W
        || matches!(
            kind,
            "anchor" | "anchor-multi" | "seed" | "beacon-log" | "genesis-seed" | PAYER_CARE_KIND
        )
}

/// What an ended write says for the refusal hold: `Some(code)` when the
/// program refused it deterministically, `None` otherwise.
fn refusal_of(o: &Outcome) -> Option<Option<u32>> {
    match o {
        Outcome::Failed { code: Some(c), .. } if transient_refusal(*c) => None,
        // A payer short of lamports is the payer's state (care tops it up and
        // the next version draws another payer), not the write's.
        Outcome::Failed {
            code: None, err, ..
        } if err.contains("InsufficientFunds") => None,
        // verify-pr192: a write that ran out of versions or fee cap while
        // signatures were unknown (congestion, a paced RPC) keeps this
        // provisional outcome even when a late status carries the real
        // code; it is not the program's refusal of the instruction.
        Outcome::Failed {
            code: None, err, ..
        } if err.contains(RETRY_WINDOW_UNRESOLVED) => None,
        Outcome::Failed { code, .. } => Some(*code),
        Outcome::Dead { reason, code } => {
            (reason != "deadline" && reason != "reveal cutoff").then_some(*code)
        }
        _ => None,
    }
}

/// A stable digest of the instructions a spec builds for a fixed payer:
/// the duty planned the same write again iff this is unchanged.
pub fn spec_fingerprint(spec: &WriteSpec) -> u64 {
    use std::hash::{Hash as _, Hasher};
    let ctx = BuildCtx {
        payer: Address::default(),
        version: 0,
        slots_waiting: 0,
    };
    let mut h = std::collections::hash_map::DefaultHasher::new();
    spec.tag.hash(&mut h);
    for ix in (spec.build)(&ctx) {
        ix.program_id.to_bytes().hash(&mut h);
        for a in &ix.accounts {
            (a.pubkey.to_bytes(), a.is_signer, a.is_writable).hash(&mut h);
        }
        ix.data.hash(&mut h);
    }
    h.finish()
}

/// One key's deterministic refusals (fix-keeper-backoff).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Refusal {
    pub kind: &'static str,
    pub code: Option<u32>,
    /// The refusal's text, shortened.
    pub err: String,
    /// Refusals in a row with the same code (a landing or another code
    /// starts over).
    pub count: u32,
    /// The digest of the instruction last refused or released.
    pub fingerprint: u64,
    pub first_slot: u64,
    pub last_slot: u64,
    /// No new write of this key before this slot …
    pub until_slot: u64,
    /// … and before this pass.
    pub until_pass: u64,
    /// `ensure` calls turned away while held.
    pub suppressed: u64,
}

/// The group breaker of one `(kind, code)`.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RefusalGroup {
    /// Distinct keys refused since the kind last landed.
    pub keys: BTreeSet<String>,
    /// Refusals of the group while open (the probe interval doubles).
    pub probes_failed: u32,
    pub next_probe_slot: u64,
    pub next_probe_pass: u64,
    /// The key now probing (one at a time).
    pub probing: Option<String>,
}
/// Slot-based retry horizon for a sent version. Passing it does not prove
/// non-landing (blockhash validity is measured in block heights).
pub const EXPIRY_SLOTS: u64 = 151;
/// Blocks a `getLatestBlockhash` answer stays valid for: its
/// `lastValidBlockHeight` is the chain's block height plus this.
pub const BLOCKHASH_VALID_BLOCKS: u64 = 150;
/// keeper-stall-investigate: a version whose status is still unknown when
/// the chain is more than this many blocks past its `last_valid_block_height`
/// can never land any more. The engine settles it as never landed (journal
/// `superseded`, which a later finalized status may still overwrite) instead
/// of keeping it unknown forever. On devnet 11-26 93 such payer-care
/// transfers kept `care_unresolved` true for 20 h and drained the delay pool.
pub const EXPIRED_MARGIN_BLOCKS: u64 = 300;
/// A send pass fetches a fresh blockhash (and the chain slot) after this many
/// sends or [`BLOCKHASH_REFRESH_SECS`], whichever comes first. With one hash
/// per pass at a 400 ms RPC gap, only the first ≈ 40 sends could land
/// (devnet ≈ 0.24 s per slot, 150 blocks ≈ 36 s); the rest were dropped
/// silently (skipPreflight).
pub const BLOCKHASH_REFRESH_SENDS: u32 = 16;
pub const BLOCKHASH_REFRESH_SECS: u64 = 15;
/// Payer care uses plain System transfers. Unlike Frontier program writes,
/// two separately signed versions can both succeed and move funds twice.
pub const PAYER_CARE_KIND: &str = "payer-care";

impl Engine {
    pub fn new(budgets: Budgets, params: EngineParams) -> Engine {
        Engine {
            status_read_errors: (0, 0, None),
            feed_block: None,
            feed_ready: true,
            pending: BTreeMap::new(),
            backoff: HashMap::new(),
            failures: HashMap::new(),
            refusals: BTreeMap::new(),
            refusal_groups: BTreeMap::new(),
            pass: 0,
            refusal_resets: 0,
            refusal_asked: BTreeMap::new(),
            refusal_pick: BTreeMap::new(),
            orphans: vec![],
            orphan_valid_height: HashMap::new(),
            never_landed: 0,
            cancelled_orphans: HashMap::new(),
            held_replans: HashMap::new(),
            adopted: HashMap::new(),
            adopted_write_ids: HashMap::new(),
            adopted_ambiguous: HashSet::new(),
            budgets,
            params,
            stats: BTreeMap::new(),
            uncounted_fees: HashMap::new(),
            expect_tx_meta: false,
            tx_meta: HashMap::new(),
            meta_wait: HashMap::new(),
            last_send_chain_slot: None,
            care_settled_slot: None,
        }
    }

    /// A discovery failure pauses game writes, including already queued retries.
    /// Outstanding signatures are still polled: pausing is not chain cancellation.
    pub fn block_feed(&mut self, block: crate::feedguard::FeedBlock) {
        if self.feed_block.is_none() {
            self.feed_block = Some(block);
        }
    }

    pub fn set_feed_ready(&mut self, ready: bool) {
        self.feed_ready = ready;
    }
    pub fn feed_writes_allowed(&self) -> bool {
        self.feed_block.is_none() && self.feed_ready
    }
    pub fn feed_block(&self) -> Option<&crate::feedguard::FeedBlock> {
        self.feed_block.as_ref()
    }

    /// Only independent beacon publication and payer bookkeeping may continue.
    /// This same predicate protects enqueue and send, so old retries cannot leak.
    pub fn allows_write_kind(&self, kind: &str) -> bool {
        self.feed_writes_allowed()
            || matches!(
                kind,
                "anchor"
                    | "anchor-multi"
                    | "seed"
                    | "beacon-log"
                    | "genesis-seed"
                    | PAYER_CARE_KIND
            )
    }

    /// Feed/kind eligible queue entries; the send loop performs its usual
    /// timing, budget and payer checks only after this fail-safe filter.
    pub fn send_candidates(&self, kinds: Option<&[&str]>) -> Vec<String> {
        self.pending
            .iter()
            .filter(|(_, p)| self.allows_write_kind(p.spec.kind))
            .filter(|(_, p)| kinds.is_none_or(|ks| ks.contains(&p.spec.kind)))
            .map(|(k, _)| k.clone())
            .collect()
    }

    pub fn persist_feed_block(&self, journal: Option<&Journal>) -> Result<(), String> {
        if let (Some(block), Some(j)) = (&self.feed_block, journal) {
            block.save(j)?;
        }
        Ok(())
    }

    pub fn restore_feed_block(&mut self, journal: Option<&Journal>) -> Result<(), String> {
        if let Some(j) = journal {
            if let Some(block) = crate::feedguard::FeedBlock::restore(j)? {
                self.block_feed(block);
            }
        }
        Ok(())
    }

    /// `port.statuses`, counting a failed read (`None` for every signature:
    /// they stay pending).
    async fn read_statuses<P: ChainPort>(
        &mut self,
        port: &P,
        sigs: &[Signature],
    ) -> Vec<Option<Status>> {
        match port.statuses(sigs).await {
            Ok(v) => {
                self.status_read_errors.1 = 0;
                v
            }
            Err(e) => {
                let r = &mut self.status_read_errors;
                r.0 += 1;
                r.1 += 1;
                r.2 = Some(format!("{} signatures: {e}", sigs.len()));
                vec![]
            }
        }
    }

    /// An undecided care transfer blocks every new top-up and sweep. This
    /// includes attempts adopted as orphans on restart, not just pending keys.
    pub fn care_unresolved(&self) -> bool {
        self.pending
            .values()
            .any(|p| p.spec.kind == PAYER_CARE_KIND)
            || self
                .uncounted_fees
                .values()
                .any(|(kind, _)| kind == PAYER_CARE_KIND)
    }

    pub fn care_settled_slot(&self) -> Option<u64> {
        self.care_settled_slot
    }

    pub fn note_care_settled(&mut self, slot: u64) {
        self.care_settled_slot = Some(self.care_settled_slot.unwrap_or(0).max(slot));
    }

    pub fn is_pending(&self, key: &str) -> bool {
        self.pending.contains_key(key)
    }

    /// Slot of a pending write's first version (`None`: not sent yet or not pending).
    pub fn first_slot(&self, key: &str) -> Option<u64> {
        self.pending.get(key).and_then(|p| p.first_slot)
    }

    /// What the transaction feed says of a failed version: the compute
    /// units it consumed and whether its logs say the CU meter ran out
    /// (W6T-2; the error JSON of a status alone cannot tell).
    pub fn note_tx_meta(&mut self, sig: Signature, units: u64, meter: bool) {
        if self.tx_meta.len() >= 50_000 {
            // Bounded: the feed names every keeper's failures.
            self.tx_meta.clear();
        }
        self.tx_meta.insert(sig, (units, meter));
    }

    /// Whether a failed version ran out of compute: the error says so, or
    /// a `ProgramFailedToComplete` used its whole limit or logged the meter.
    fn cu_meter(&self, e: &str, v: &Version) -> bool {
        is_cu_exceeded(e)
            || (is_heap_fault(e)
                && self
                    .tx_meta
                    .get(&v.sig)
                    .is_some_and(|&(units, meter)| meter || units >= v.cu_limit as u64))
    }

    /// The instructions a pending write's first version would carry with
    /// fee payer `payer`, and its class and tag (tests and the operator's
    /// dry run; CQ2-D).
    pub fn preview(&self, key: &str, payer: Address) -> Option<(Class, u8, Vec<Instruction>)> {
        let p = self.pending.get(key)?;
        let ctx = BuildCtx {
            payer,
            version: 0,
            slots_waiting: 0,
        };
        Some((p.spec.class, p.spec.tag, (p.spec.build)(&ctx)))
    }

    pub fn pending_len(&self) -> usize {
        self.pending.len()
    }

    pub fn pending_keys(&self) -> Vec<String> {
        self.pending.keys().cloned().collect()
    }

    /// Adds a write unless it is already pending or in backoff. Returns
    /// whether it was added.
    pub fn ensure(&mut self, spec: WriteSpec, slot: u64) -> bool {
        if !self.allows_write_kind(spec.kind)
            || self.pending.contains_key(&spec.key)
            || self.backoff.get(&spec.key).is_some_and(|&s| slot < s)
            || self.held_replans.contains_key(&spec.key)
            || self.adopted_ambiguous.contains(&spec.key)
        {
            return false;
        }
        if !self.refusal_admits(&spec, slot) {
            self.stats.entry(spec.kind.into()).or_default().suppressed += 1;
            return false;
        }
        self.backoff.remove(&spec.key);
        let b = self.budgets.get(spec.tag);
        let adopted = self.adopted.remove(&spec.key).unwrap_or_default();
        let write_id = self.adopted_write_ids.remove(&spec.key).flatten();
        self.stats.entry(spec.kind.into()).or_default().writes += 1;
        self.pending.insert(
            spec.key.clone(),
            Pending {
                write_id,
                first_slot: adopted.first().map(|v| v.sent_slot),
                versions: adopted,
                settled: Default::default(),
                journal_blocked: Default::default(),
                provisional: None,
                cu_limit: b.cu_limit,
                heap: None,
                contested: false,
                bonus_milli: 0,
                spec,
            },
        );
        true
    }

    /// fix-keeper-backoff: one keeper pass begins (the refusal holds count
    /// passes as well as slots, so a slow pass on a paced public RPC still
    /// waits). Also forgets refusals the duties stopped planning.
    pub fn begin_pass(&mut self, slot: u64) {
        self.pass += 1;
        let horizon = self
            .params
            .refusal_max_slots
            .max(BACKOFF_SLOTS)
            .saturating_mul(4);
        let pass = self.pass;
        let gate = self.params.refusal_max_passes > 0;
        self.refusals.retain(|_, r| {
            slot < r.last_slot.saturating_add(horizon)
                || slot < r.until_slot
                || (gate && pass < r.until_pass)
        });
        self.refusal_groups.retain(|_, g| !g.keys.is_empty());
        // verify-pr192: choose each blocked kind's next probe from the keys
        // that asked last pass (duties re-plan every pass). Plan order would
        // otherwise hand every probe to the first key planned: a stuck
        // region-0 batch ahead of healthy ones closed the kind for good.
        self.refusal_pick.clear();
        let min = self.params.refusal_group_min as usize;
        for (kind, asked) in std::mem::take(&mut self.refusal_asked) {
            let members: BTreeSet<&String> = self
                .refusal_groups
                .iter()
                .filter(|(gk, g)| gk.0 == kind && min > 0 && g.keys.len() >= min)
                .flat_map(|(_, g)| g.keys.iter())
                .collect();
            let pick = asked.iter().find(|k| !members.contains(k)).or_else(|| {
                asked
                    .iter()
                    .min_by_key(|k| self.refusals.get(*k).map_or(0, |r| r.last_slot))
            });
            if let Some(k) = pick {
                self.refusal_pick.insert(kind, k.clone());
            }
        }
    }

    pub fn pass(&self) -> u64 {
        self.pass
    }

    /// Whether a refusal still holds its key at `slot`.
    pub fn refusal_held(&self, r: &Refusal, slot: u64) -> bool {
        slot < r.until_slot || (self.params.refusal_max_passes > 0 && self.pass < r.until_pass)
    }

    pub fn refusals(&self) -> &BTreeMap<String, Refusal> {
        &self.refusals
    }

    pub fn refusal_groups(&self) -> &BTreeMap<(&'static str, Option<u32>), RefusalGroup> {
        &self.refusal_groups
    }

    /// Whether a group is open (its kind waits for one probe at a time).
    pub fn group_open(&self, g: &RefusalGroup) -> bool {
        self.params.refusal_group_min > 0 && g.keys.len() >= self.params.refusal_group_min as usize
    }

    /// The refusal hold and the group breaker (`ensure`). A held key whose
    /// duty now plans a different instruction (the chain state it read
    /// changed) is released at once.
    fn refusal_admits(&mut self, spec: &WriteSpec, slot: u64) -> bool {
        if let Some(r) = self.refusals.get(&spec.key) {
            if self.refusal_held(r, slot) {
                let fp = spec_fingerprint(spec);
                let pass = self.pass;
                let r = self.refusals.get_mut(&spec.key).expect("refusal");
                if fp == r.fingerprint {
                    r.suppressed += 1;
                    return false;
                }
                // A different instruction (the chain state the duty read
                // changed): this one goes out now. The streak, and so the
                // next hold, continues if it is refused the same way again:
                // an archive batch that grows by one bell every bell would
                // otherwise restart at 2 slots every bell.
                r.until_slot = slot;
                r.until_pass = pass;
                r.fingerprint = fp;
                self.refusal_resets += 1;
            }
        }
        if self.params.refusal_group_min == 0 || group_exempt(spec.kind, spec.class) {
            return true;
        }
        let min = self.params.refusal_group_min as usize;
        let gate = self.params.refusal_max_passes > 0;
        let (pass, pending) = (self.pass, &self.pending);
        let mut blocked = false;
        let mut due = true;
        for (gk, g) in self.refusal_groups.iter_mut() {
            if gk.0 != spec.kind || g.keys.len() < min {
                continue;
            }
            blocked = true;
            // A probe that ended without a refusal (cancelled, unresolved).
            if g.probing.as_ref().is_some_and(|k| !pending.contains_key(k)) {
                g.probing = None;
            }
            if g.probing.is_some() || slot < g.next_probe_slot || (gate && pass < g.next_probe_pass)
            {
                due = false;
            }
        }
        if !blocked {
            return true;
        }
        // verify-pr192: only the key chosen at the pass start probes.
        if due && self.refusal_pick.get(spec.kind) == Some(&spec.key) {
            self.refusal_pick.remove(spec.kind);
            for (gk, g) in self.refusal_groups.iter_mut() {
                if gk.0 == spec.kind && g.keys.len() >= min {
                    g.probing = Some(spec.key.clone());
                }
            }
            return true;
        }
        self.refusal_asked
            .entry(spec.kind)
            .or_default()
            .insert(spec.key.clone());
        false
    }

    /// Records a deterministic refusal of `key` (the write just ended).
    fn note_refusal(
        &mut self,
        key: &str,
        spec: &WriteSpec,
        code: Option<u32>,
        err: &str,
        slot: u64,
    ) {
        let fp = spec_fingerprint(spec);
        // The same code again continues the streak, even for an instruction
        // released early as changed (`refusal_admits`).
        let prev = self.refusals.get(key).filter(|r| r.code == code).cloned();
        let n = prev.as_ref().map_or(1, |r| r.count.saturating_add(1));
        let sh = (n - 1).min(20);
        let max_s = self.params.refusal_max_slots.max(BACKOFF_SLOTS);
        let wait_s = (BACKOFF_SLOTS << sh).min(max_s);
        let wait_p = (1u64 << sh).min(self.params.refusal_max_passes);
        let mut text: String = err.chars().take(160).collect();
        if text.is_empty() {
            text = code.and_then(abi::error_name).unwrap_or("?").into();
        }
        self.refusals.insert(
            key.to_string(),
            Refusal {
                kind: spec.kind,
                code,
                err: text,
                count: n,
                fingerprint: fp,
                first_slot: prev.as_ref().map_or(slot, |r| r.first_slot),
                last_slot: slot,
                until_slot: slot + wait_s,
                until_pass: self.pass + wait_p,
                suppressed: prev.as_ref().map_or(0, |r| r.suppressed),
            },
        );
        self.stats.entry(spec.kind.into()).or_default().refused += 1;
        let min = self.params.refusal_group_min as usize;
        if min == 0 || group_exempt(spec.kind, spec.class) {
            return;
        }
        let max_p = self.params.refusal_max_passes;
        let pass = self.pass;
        let g = self.refusal_groups.entry((spec.kind, code)).or_default();
        let was_open = g.keys.len() >= min;
        g.keys.insert(key.to_string());
        if g.probing.as_deref() == Some(key) {
            // The probe was refused the same way: the next one waits longer.
            g.probing = None;
            g.probes_failed = g.probes_failed.saturating_add(1);
            let sh = g.probes_failed.min(20);
            g.next_probe_slot = slot + (BACKOFF_SLOTS << sh).min(max_s);
            g.next_probe_pass = pass + (1u64 << sh).min(max_p);
        } else if !was_open && g.keys.len() >= min {
            g.next_probe_slot = slot + BACKOFF_SLOTS;
            g.next_probe_pass = pass + 1.min(max_p);
        }
    }

    /// Requests the retry heap frame from the first version of a pending write (a duty that knows its write needs
    /// more than the default 32-KiB heap, e.g. P13's ExpeditionGather of a full batch); the ladder is unchanged.
    pub fn set_heap(&mut self, key: &str, heap: u32) {
        if let Some(p) = self.pending.get_mut(key) {
            p.heap = Some(heap);
        }
    }

    /// Sets the CU limit of a pending write (a duty that sizes its own,
    /// e.g. SkipQuiet's `90k + 30k` per recomputed bell, I-50, v1.7); the retry
    /// ladder continues from it.
    pub fn set_cu_limit(&mut self, key: &str, cu: u32) {
        if let Some(p) = self.pending.get_mut(key) {
            p.cu_limit = cu.min(abi::CU_MAX);
        }
    }

    /// Adds `milli` to every version's bid of a pending write (W4-C: the
    /// rank order of a reveal group sent in one slot).
    pub fn set_bid_bonus(&mut self, key: &str, milli: u64) {
        if let Some(p) = self.pending.get_mut(key) {
            p.bonus_milli = milli;
        }
    }

    /// Stops a write for an explicit reason. Signed, unsettled versions are
    /// still polled for fees and journal status. A late success of a locally
    /// abandoned write is reported separately from a duty landing.
    pub fn cancel(&mut self, key: &str, reason: CancelReason) {
        if let Some(p) = self.pending.remove(key) {
            if reason != CancelReason::ChainStateObserved {
                for v in p.versions.iter().filter(|v| !p.settled.contains(&v.sig)) {
                    self.cancelled_orphans.insert(v.sig, (key.into(), reason));
                }
            }
            self.hold_unsettled(key, &p);
        }
    }

    /// At a reveal cutoff, stop sending but keep a signed cohort until its
    /// unknown signatures settle. `false` means the duty must defer its
    /// missed notification; a late success still wins. A write with no
    /// unknown signature can be cancelled immediately.
    pub fn cancel_at_cutoff(&mut self, key: &str) -> bool {
        if let Some(p) = self.pending.get_mut(key) {
            if p.versions.iter().any(|v| !p.settled.contains(&v.sig)) {
                p.provisional = Some(Outcome::Dead {
                    reason: "reveal cutoff".into(),
                    code: None,
                });
                return false;
            }
        }
        self.cancel(key, CancelReason::StaleBell);
        true
    }

    /// Keep the old fee exposure when a write leaves the pending queue with
    /// signatures whose outcomes are still unknown. The orphan poll closes
    /// their journal rows; `charge_fee` releases the key only after all of
    /// those signatures have definitive statuses.
    fn hold_unsettled(&mut self, key: &str, p: &Pending) -> bool {
        let unknown: Vec<_> = p
            .versions
            .iter()
            .filter(|v| !p.settled.contains(&v.sig))
            .map(|v| (v.sig, v.sent_slot))
            .collect();
        if unknown.is_empty() {
            return false;
        }
        self.held_replans
            .entry(key.into())
            .or_default()
            .extend(unknown.iter().map(|(sig, _)| *sig));
        for v in p.versions.iter().filter(|v| !p.settled.contains(&v.sig)) {
            if let Some(h) = v.last_valid_block_height {
                self.orphan_valid_height.insert(v.sig, h);
            }
        }
        self.orphans.extend(unknown);
        true
    }

    /// Count a version only after its chain status is known. A failed
    /// transaction still pays its fee, including `AlreadyDone` versions.
    fn charge_fee(&mut self, sig: Signature) {
        if let Some((kind, fee)) = self.uncounted_fees.remove(&sig) {
            self.stats.entry(kind).or_default().fees_charged += fee;
        }
        self.release_hold(sig);
    }

    /// A version that can no longer land paid no fee: drop its reservation
    /// without charging it.
    fn release_unlanded(&mut self, sig: Signature) {
        self.uncounted_fees.remove(&sig);
        self.never_landed += 1;
        self.release_hold(sig);
    }

    fn release_hold(&mut self, sig: Signature) {
        self.orphan_valid_height.remove(&sig);
        self.held_replans.retain(|_, sigs| {
            sigs.remove(&sig);
            !sigs.is_empty()
        });
    }

    /// A pending version that can no longer land (status unknown, chain past
    /// its validity by [`EXPIRED_MARGIN_BLOCKS`]): settle it without a chain
    /// outcome so the normal send path may sign the next version. A payer-care
    /// transfer never gets a second version, so its write ends as failed and
    /// the next care pass plans again from fresh balances.
    fn settle_never_landed(
        &mut self,
        k: &str,
        v: &Version,
        journal: Option<&Journal>,
        slot: u64,
        ended: &mut Vec<(String, Outcome)>,
        report: &mut StepReport,
    ) {
        if let Some(j) = journal {
            if let Err(e) = j.set_status(&v.sig.to_string(), "superseded", None, None) {
                report
                    .send_errors
                    .push((k.to_string(), format!("journal status: {e}")));
                return;
            }
        }
        let Some(p) = self.pending.get_mut(k) else {
            return;
        };
        p.settled.insert(v.sig);
        let care_done =
            p.spec.kind == PAYER_CARE_KIND && p.versions.iter().all(|x| p.settled.contains(&x.sig));
        self.release_unlanded(v.sig);
        if care_done && !ended.iter().any(|(e, _)| e == k) {
            ended.push((
                k.to_string(),
                Outcome::Failed {
                    code: None,
                    err: "blockhash expired: transfer never landed".into(),
                    slot,
                },
            ));
        }
    }

    /// Startup reconciles already-landed journal attempts before adoption.
    /// These will not pass through [`Self::poll`] in the new process.
    pub fn charge_recovered(&mut self, attempt: &Attempt) {
        self.stats
            .entry(attempt.kind.clone())
            .or_default()
            .fees_charged += attempt.fee;
    }

    /// Adopts in-flight attempts from the journal after a restart: the next
    /// `ensure` of the same object continues from them (their landing ends
    /// the write) instead of starting over.
    pub fn adopt(&mut self, attempts: &[Attempt]) -> Result<(), String> {
        // Validate the whole batch before changing the engine. A malformed
        // journal entry must not be silently dropped and then resent.
        let parsed: Vec<_> = attempts
            .iter()
            .map(|a| {
                let sig = a.sig.parse().map_err(|_| "invalid journal signature")?;
                let payer = a.payer.parse().map_err(|_| "invalid journal payer")?;
                if a.fee == 0 {
                    return Err("journal attempt has no predicted fee");
                }
                Ok((a, sig, payer))
            })
            .collect::<Result<_, _>>()?;
        for (a, sig, payer) in parsed {
            self.orphans.push((sig, a.sent_slot));
            if let Some(h) = a.last_valid_block_height {
                self.orphan_valid_height.insert(sig, h);
            }
            self.uncounted_fees.insert(sig, (a.kind.clone(), a.fee));
            match self.adopted_write_ids.entry(a.object_key.clone()) {
                std::collections::hash_map::Entry::Occupied(mut existing) => {
                    if *existing.get() != a.write_id {
                        self.adopted_ambiguous.insert(a.object_key.clone());
                        existing.insert(None);
                    }
                }
                std::collections::hash_map::Entry::Vacant(empty) => {
                    empty.insert(a.write_id.clone());
                }
            }
            self.adopted
                .entry(a.object_key.clone())
                .or_default()
                .push(Version {
                    sig,
                    payer,
                    bid_milli: a.bid_milli,
                    cu_limit: a.cu_limit,
                    heap: a.heap,
                    sent_slot: a.sent_slot,
                    last_valid_block_height: a.last_valid_block_height,
                    chain_slot: a.sent_slot,
                    fee: a.fee,
                });
        }
        Ok(())
    }

    /// A restarted write with a still-unknown signature and a settled
    /// sibling cannot reconstruct its original fee cap from the in-flight
    /// journal rows alone. Keep polling the unknown signatures as orphans,
    /// but do not adopt them into a newly planned write with a fresh cap.
    pub fn hold_adopted_until_known(&mut self, key: &str) {
        self.adopted_write_ids.remove(key);
        self.adopted_ambiguous.remove(key);
        if let Some(versions) = self.adopted.remove(key) {
            self.held_replans
                .entry(key.into())
                .or_default()
                .extend(versions.iter().map(|v| v.sig));
        }
    }

    fn classify(
        &mut self,
        key: &str,
        st: &Status,
        v: &Version,
        journal: Option<&Journal>,
        report: &mut StepReport,
    ) -> Option<Outcome> {
        if self
            .pending
            .get(key)
            .is_some_and(|p| p.spec.kind == PAYER_CARE_KIND)
        {
            self.note_care_settled(st.slot);
        }
        let e = st.err.clone().unwrap_or_default();
        let cu_meter = self.cu_meter(&e, v);
        self.tx_meta.remove(&v.sig);
        self.meta_wait.remove(&v.sig);
        self.charge_fee(v.sig);
        let p = self.pending.get_mut(key)?;
        let first = p.first_slot.unwrap_or(st.slot);
        if st.err.is_none() || st.code.is_some_and(|c| err::is_done(p.spec.tag, c)) {
            return Some(Outcome::Landed {
                slot: st.slot,
                sig: v.sig,
                payer: v.payer,
                versions: p.versions.len(),
                first_slot: first,
                already_done: st.err.is_some(),
            });
        }
        if cu_meter && p.spec.tag == abi::tag::SKIP_QUIET {
            // v1.7 (wave-4 review): SkipQuiet within its gate formula
            // always finishes a quiet run (G1 rows, the kernel quiet test
            // included); running out means the first bell is not quiet
            // (the kernel ran a whole clash). It is `NotQuiet` for the
            // duty (gather and resolve), not a ladder step.
            if let Some(j) = journal {
                let _ = j.alert(
                    st.slot,
                    "skip-cu-not-quiet",
                    &format!("{key}: SkipQuiet used its gate: treated as NotQuiet"),
                );
            }
            return Some(Outcome::Failed {
                code: Some(err::NOT_QUIET),
                err: format!("{e} (SkipQuiet over its gate: not quiet)"),
                slot: st.slot,
            });
        }
        if cu_meter {
            if v.cu_limit >= p.cu_limit && p.cu_limit < abi::CU_MAX {
                p.cu_limit = Budgets::retry_cu(p.cu_limit);
                report.ladder.push((key.into(), p.cu_limit, p.heap));
                if let Some(j) = journal {
                    let _ = j.alert(
                        st.slot,
                        "cu-retry",
                        &format!("{key}: out of compute ({e}), next limit {}", p.cu_limit),
                    );
                }
            }
            return (v.cu_limit >= abi::CU_MAX).then(|| Outcome::Dead {
                reason: "compute budget exceeded at 1.4M".into(),
                code: None,
            });
        }
        if is_heap_fault(&e) {
            if p.heap.is_none() {
                p.heap = Some(abi::HEAP_FRAME_RETRY);
                report.ladder.push((key.into(), p.cu_limit, p.heap));
                if let Some(j) = journal {
                    let _ = j.alert(
                        st.slot,
                        "heap-retry",
                        &format!("{key}: {e}; next version requests a 256-KiB heap frame"),
                    );
                }
                return None;
            }
            // An older version without the frame: wait for the new one.
            v.heap?;
            return Some(Outcome::Dead {
                reason: format!("fails with a heap frame: {e}"),
                code: st.code,
            });
        }
        match st.code {
            Some(c) if err::stops_window(c) || c == err::NOT_IMPLEMENTED => Some(Outcome::Dead {
                reason: abi::error_name(c).unwrap_or("?").into(),
                code: Some(c),
            }),
            code => Some(Outcome::Failed {
                code,
                err: e,
                slot: st.slot,
            }),
        }
    }

    /// One slot: poll every version sent, settle the writes that ended, and
    /// send the next version of every write still waiting.
    pub async fn step<P: ChainPort>(
        &mut self,
        port: &P,
        payers: &mut Payers,
        journal: Option<&Journal>,
        slot: u64,
    ) -> StepReport {
        let mut report = self.poll(port, journal, slot).await;
        self.send(port, payers, journal, slot, &mut report).await;
        report
    }

    /// Polls every version sent and settles the writes that ended (the
    /// keeper polls before its duties plan, so a landing is an outcome, not
    /// a cancellation).
    pub async fn poll<P: ChainPort>(
        &mut self,
        port: &P,
        journal: Option<&Journal>,
        slot: u64,
    ) -> StepReport {
        let mut report = StepReport::default();
        let mut sigs: Vec<(String, Version)> = vec![];
        for (k, p) in &self.pending {
            for v in p.versions.iter().filter(|v| !p.settled.contains(&v.sig)) {
                sigs.push((k.clone(), v.clone()));
            }
        }
        // verify-pr259: one status read per poll for the pending versions
        // AND the orphans. `RpcPort::statuses` runs its capped history
        // search at most once per `history_every` across all calls; with two
        // reads per poll the first (pending writes, which nearly always has
        // an unknown fresh send) took every history turn and orphans older
        // than the status cache (restart-adopted attempts, payer care among
        // them) were never re-read, so `care_unresolved` could stay true.
        let mut flat: Vec<Signature> = sigs.iter().map(|(_, v)| v.sig).collect();
        let n_pending = flat.len();
        let n_orphans = self.orphans.len();
        flat.extend(self.orphans.iter().map(|o| o.0));
        let mut sts = if flat.is_empty() {
            vec![]
        } else {
            self.read_statuses(port, &flat).await
        };
        let read_ok = !flat.is_empty() && sts.len() == flat.len();
        // Orphan answers, in `self.orphans` order (orphans added below by
        // `hold_unsettled` are appended after them and wait for the next poll).
        let orphan_sts: Vec<Option<Status>> = if sts.len() == n_pending + n_orphans {
            sts.split_off(n_pending)
        } else {
            vec![]
        };
        // keeper-stall-investigate: the chain's block height, read only when
        // an unknown signature has a recorded validity height. A signature
        // still unknown more than EXPIRED_MARGIN_BLOCKS past it never landed.
        let height_now = if read_ok
            && (sigs
                .iter()
                .zip(sts.iter())
                .any(|((_, v), st)| st.is_none() && v.last_valid_block_height.is_some())
                || self
                    .orphans
                    .iter()
                    .zip(orphan_sts.iter())
                    .any(|(o, st)| st.is_none() && self.orphan_valid_height.contains_key(&o.0)))
        {
            match port.blockhash().await {
                Ok((_, h)) if h > BLOCKHASH_VALID_BLOCKS => Some(h - BLOCKHASH_VALID_BLOCKS),
                _ => None,
            }
        } else {
            None
        };
        let gone = |valid: Option<u64>| match (valid, height_now) {
            (Some(v), Some(h)) => h > v.saturating_add(EXPIRED_MARGIN_BLOCKS),
            _ => false,
        };
        let mut ended: Vec<(String, Outcome)> = vec![];
        for ((k, v), st) in sigs.iter().zip(sts.iter()) {
            let Some(st) = st else {
                if gone(v.last_valid_block_height) {
                    self.settle_never_landed(k, v, journal, slot, &mut ended, &mut report);
                }
                continue;
            };
            // A ProgramFailedToComplete waits a little for the feed to say
            // whether it ran out of compute (W6T-2).
            if self.expect_tx_meta
                && st
                    .err
                    .as_deref()
                    .is_some_and(|e| is_heap_fault(e) && !is_cu_exceeded(e))
                && !self.tx_meta.contains_key(&v.sig)
            {
                let first = *self.meta_wait.entry(v.sig).or_insert(slot);
                if slot < first + META_WAIT_SLOTS {
                    continue;
                }
            }
            // Persist finality before releasing fee holds, changing duty
            // state or emitting an outcome. A failed journal write is not a
            // successful reconciliation: keep the signature pending and
            // seal this write against another send until persistence works.
            if let Some(j) = journal {
                let success = self.pending.get(k).is_some_and(|p| {
                    st.err.is_none() || st.code.is_some_and(|code| err::is_done(p.spec.tag, code))
                });
                let status = if st.err.is_none() {
                    "landed"
                } else if success {
                    "done"
                } else {
                    "failed"
                };
                if let Err(e) = j.set_status(&v.sig.to_string(), status, Some(st.slot), st.code) {
                    report
                        .send_errors
                        .push((k.clone(), format!("journal status: {e}")));
                    if let Some(p) = self.pending.get_mut(k) {
                        p.journal_blocked.insert(v.sig);
                    }
                    continue;
                }
            }
            if let Some(p) = self.pending.get_mut(k) {
                p.journal_blocked.remove(&v.sig);
                p.settled.insert(v.sig);
            }
            if let Some((_, previous)) = ended.iter_mut().find(|(e, _)| e == k) {
                // Statuses for siblings can arrive in either order in one
                // RPC reply. A definitive success wins over an earlier
                // failure of another version of the same write.
                if matches!(previous, Outcome::Landed { .. }) {
                    self.charge_fee(v.sig);
                } else if let Some(current) = self.classify(k, st, v, journal, &mut report) {
                    if matches!(current, Outcome::Landed { .. })
                        || (matches!(previous, Outcome::Failed { .. })
                            && matches!(current, Outcome::Dead { .. }))
                    {
                        *previous = current;
                    }
                }
                continue;
            }
            if let Some(o) = self.classify(k, st, v, journal, &mut report) {
                ended.push((k.clone(), o));
            }
        }
        let mut finished = Vec::new();
        for (k, o) in ended {
            let Some(p) = self.pending.get_mut(&k) else {
                continue;
            };
            if matches!(o, Outcome::Landed { .. }) {
                finished.push((k, o));
            } else {
                // A failed variant does not prove the write failed while a
                // sibling is still unknown. Keep duty state intact so a
                // later success can be delivered exactly once.
                if p.provisional.is_none()
                    || (matches!(p.provisional, Some(Outcome::Failed { .. }))
                        && matches!(o, Outcome::Dead { .. }))
                {
                    p.provisional = Some(o);
                }
                if p.versions.iter().all(|v| p.settled.contains(&v.sig)) {
                    finished.push((k, p.provisional.take().expect("provisional outcome")));
                }
            }
        }
        // A provisional write may finish on a status that does not produce
        // a new terminal outcome (for example a CU-ladder failure).
        for (k, p) in &mut self.pending {
            if p.provisional.is_some()
                && p.versions.iter().all(|v| p.settled.contains(&v.sig))
                && !finished.iter().any(|(done, _)| done == k)
            {
                finished.push((
                    k.clone(),
                    p.provisional.take().expect("provisional outcome"),
                ));
            }
        }
        for (k, o) in finished {
            if let Some(p) = self.pending.remove(&k) {
                let refusal = refusal_of(&o);
                let s = self.stats.entry(p.spec.kind.into()).or_default();
                match &o {
                    Outcome::Landed {
                        slot: ls,
                        first_slot,
                        ..
                    } => {
                        self.failures.remove(&k);
                        s.landed += 1;
                        s.latency_slots.push(ls.saturating_sub(*first_slot));
                    }
                    Outcome::Failed { .. } => {
                        s.failed += 1;
                        // Transient refusals: 2, 4, 8, … slots, at most
                        // 1,024 (≈ 7 min of slots). Deterministic ones take
                        // the refusal hold below instead.
                        if refusal.is_none() {
                            let n = self.failures.entry(k.clone()).or_default();
                            *n = n.saturating_add(1);
                            let wait = BACKOFF_SLOTS << (*n - 1).min(9);
                            self.backoff.insert(k.clone(), slot + wait);
                        }
                    }
                    Outcome::Unresolved { .. } => {}
                    Outcome::Dead { .. } => s.dead += 1,
                }
                if matches!(o, Outcome::Landed { .. }) {
                    // Success ends the key's hold and closes every group of its kind.
                    self.refusals.remove(&k);
                    let kind = p.spec.kind;
                    self.refusal_groups.retain(|g, _| g.0 != kind);
                }
                if let Some(code) = refusal {
                    let text = match &o {
                        Outcome::Failed { err, .. } => err.clone(),
                        Outcome::Dead { reason, .. } => reason.clone(),
                        _ => String::new(),
                    };
                    self.note_refusal(&k, &p.spec, code, &text, slot);
                }
                self.hold_unsettled(&k, &p);
                report.outcomes.push((k, o));
            }
        }
        // Orphans: retain unknown outcomes and predicted fees until a
        // definitive status arrives, even after the retry window.
        if !self.orphans.is_empty() {
            let orphans = std::mem::take(&mut self.orphans);
            let mut keep = vec![];
            let mut resolved = HashSet::new();
            for (o, st) in orphans
                .into_iter()
                .zip(orphan_sts.iter().map(Some).chain(std::iter::repeat(None)))
            {
                // `None`: appended by `hold_unsettled` in this poll, not read yet.
                let read_now = st.is_some();
                let st = st.unwrap_or(&None);
                match st {
                    Some(st) => {
                        // An adopted signature may also have been settled
                        // above as part of a newly planned pending write.
                        // Its tag-aware status (including `done`) is already
                        // durable and its fee already charged in that case.
                        if let Some(j) = journal.filter(|_| self.uncounted_fees.contains_key(&o.0))
                        {
                            let s = if st.err.is_none() { "landed" } else { "failed" };
                            if let Err(e) =
                                j.set_status(&o.0.to_string(), s, Some(st.slot), st.code)
                            {
                                report
                                    .send_errors
                                    .push((o.0.to_string(), format!("journal orphan status: {e}")));
                                keep.push(o);
                                continue;
                            }
                        }
                        resolved.insert(o.0);
                        if let Some((key, reason)) = self.cancelled_orphans.remove(&o.0) {
                            if st.err.is_none() {
                                report.cancelled_landed.push(CancelledLanding {
                                    key,
                                    sig: o.0,
                                    slot: st.slot,
                                    reason,
                                });
                            }
                        }
                        if self
                            .uncounted_fees
                            .get(&o.0)
                            .is_some_and(|(kind, _)| kind == PAYER_CARE_KIND)
                        {
                            self.note_care_settled(st.slot);
                        }
                        self.charge_fee(o.0);
                    }
                    None if read_ok
                        && read_now
                        && gone(self.orphan_valid_height.get(&o.0).copied()) =>
                    {
                        if let Some(j) = journal.filter(|_| self.uncounted_fees.contains_key(&o.0))
                        {
                            if let Err(e) = j.set_status(&o.0.to_string(), "superseded", None, None)
                            {
                                report
                                    .send_errors
                                    .push((o.0.to_string(), format!("journal orphan status: {e}")));
                                keep.push(o);
                                continue;
                            }
                        }
                        resolved.insert(o.0);
                        self.cancelled_orphans.remove(&o.0);
                        self.release_unlanded(o.0);
                    }
                    None => keep.push(o),
                }
            }
            self.orphans = keep;
            // An in-flight write adopted at restart is also watched as an
            // orphan. If a version resolves before the duty calls `ensure`,
            // it must not be adopted again as an unsettled version. If a
            // sibling remains unknown, its old fee exposure blocks re-plan.
            let changed: Vec<_> = self
                .adopted
                .iter()
                .filter(|(_, versions)| versions.iter().any(|v| resolved.contains(&v.sig)))
                .map(|(key, _)| key.clone())
                .collect();
            for key in changed {
                let versions = self.adopted.get_mut(&key).expect("adopted key");
                versions.retain(|v| !resolved.contains(&v.sig));
                if versions.is_empty() {
                    self.adopted.remove(&key);
                    self.adopted_write_ids.remove(&key);
                    self.adopted_ambiguous.remove(&key);
                } else {
                    self.hold_adopted_until_known(&key);
                }
            }
        }
        report
    }

    /// Sends the next version of every write still waiting.
    pub async fn send<P: ChainPort>(
        &mut self,
        port: &P,
        payers: &mut Payers,
        journal: Option<&Journal>,
        slot: u64,
        report: &mut StepReport,
    ) {
        self.send_kinds(port, payers, journal, slot, report, None)
            .await
    }

    /// [`Self::send`] for the writes of `kinds` only (`None`: every write).
    /// The keeper sends the beacon duty's anchors and seed caches as soon as
    /// they are planned (W6T-2).
    pub async fn send_kinds<P: ChainPort>(
        &mut self,
        port: &P,
        payers: &mut Payers,
        journal: Option<&Journal>,
        slot: u64,
        report: &mut StepReport,
        kinds: Option<&[&str]>,
    ) {
        // Library callers may skip Keeper::start; durable refusal still applies.
        if let Err(reason) = self
            .restore_feed_block(journal)
            .and_then(|_| self.persist_feed_block(journal))
        {
            self.block_feed(crate::feedguard::FeedBlock {
                seq: 0,
                slot,
                signature: String::new(),
                reason,
            });
            return;
        }
        let keys = self.send_candidates(kinds);
        let mut blockhash: Option<Hash> = None;
        let mut last_valid_block_height: Option<u64> = None;
        let mut chain_slot: Option<u64> = None;
        // keeper-stall-investigate: sends signed with this blockhash, and when
        // it was fetched. A long pass refreshes both the hash and the slot.
        let mut sends_on_hash: u32 = 0;
        let mut hash_at = std::time::Instant::now();
        for k in keys {
            if blockhash.is_some()
                && (sends_on_hash >= BLOCKHASH_REFRESH_SENDS
                    || hash_at.elapsed().as_secs() >= BLOCKHASH_REFRESH_SECS)
            {
                blockhash = None;
                last_valid_block_height = None;
                chain_slot = None;
                sends_on_hash = 0;
            }
            let Some(p) = self.pending.get(&k) else {
                continue;
            };
            if p.provisional.is_some() || !p.journal_blocked.is_empty() {
                continue;
            }
            if slot < p.spec.not_before_slot
                || p.versions.last().is_some_and(|v| v.sent_slot >= slot)
            {
                continue;
            }
            // A System transfer has no on-chain idempotency key. Even when
            // the status is still None after many slots, a second signed
            // version could also land. Keep the first one for reconciliation.
            if p.spec.kind == PAYER_CARE_KIND && !p.versions.is_empty() {
                continue;
            }
            if p.spec.deadline_slot.is_some_and(|d| slot >= d) {
                if p.versions.iter().any(|v| !p.settled.contains(&v.sig)) {
                    self.pending.get_mut(&k).expect("pending").provisional = Some(Outcome::Dead {
                        reason: "deadline".into(),
                        code: None,
                    });
                    report.outcomes.push((
                        k,
                        Outcome::Unresolved {
                            err: "deadline passed with an unknown signature".into(),
                            slot,
                        },
                    ));
                    continue;
                }
                let p = self.pending.remove(&k).expect("pending");
                self.stats.entry(p.spec.kind.into()).or_default().dead += 1;
                report.outcomes.push((
                    k,
                    Outcome::Dead {
                        reason: "deadline".into(),
                        code: None,
                    },
                ));
                continue;
            }
            // After a long tick gap, an older version may be beyond the
            // retry horizon while this write still has room under its own
            // version and fee caps. Let the normal send path retry within
            // that same budget; re-planning would discard the old exposure.
            // Once the cap is exhausted, remove the pending write so
            // unrelated duties can continue, but hold this key until all
            // old signatures have a final status.
            if !p.versions.is_empty()
                && p.versions.iter().all(|v| slot > v.sent_slot + EXPIRY_SLOTS)
                && (p.versions.len() as u32 >= self.params.max_versions
                    || p.versions
                        .iter()
                        .map(|v| v.fee)
                        .sum::<u64>()
                        .saturating_add(fees::LAMPORTS_PER_SIGNATURE)
                        > self.params.per_write_cap)
            {
                let err = format!(
                    "{} {RETRY_WINDOW_UNRESOLVED} (cap {} versions, {} lamports)",
                    p.versions.len(),
                    self.params.max_versions,
                    self.params.per_write_cap
                );
                let unknown = p.versions.iter().any(|v| !p.settled.contains(&v.sig));
                if let Some(j) = journal {
                    // Keep the existing alert code consumed by itest/operator
                    // checks; its detail now says what is actually known.
                    let _ = j.alert(slot, "write-expired", &format!("{k}: {err}"));
                }
                if unknown {
                    self.pending.get_mut(&k).expect("pending").provisional =
                        Some(Outcome::Failed {
                            code: None,
                            err: err.clone(),
                            slot,
                        });
                    report.outcomes.push((k, Outcome::Unresolved { err, slot }));
                } else {
                    let p = self.pending.remove(&k).expect("pending");
                    self.stats.entry(p.spec.kind.into()).or_default().failed += 1;
                    let n = self.failures.entry(k.clone()).or_default();
                    *n = n.saturating_add(1);
                    let wait = BACKOFF_SLOTS << (*n - 1).min(9);
                    self.backoff.insert(k.clone(), slot + wait);
                    report.outcomes.push((
                        k,
                        Outcome::Failed {
                            code: None,
                            err,
                            slot,
                        },
                    ));
                }
                continue;
            }
            // One version per chain slot: a W write whose last version went
            // out in the chain's current slot (a late tick) waits (W6T-2).
            if p.spec.class == Class::W && !p.versions.is_empty() {
                if chain_slot.is_none() {
                    chain_slot = port.clock().await.ok().map(|c| c.slot);
                }
                if let (Some(c), Some(last)) = (chain_slot, p.versions.last()) {
                    if last.chain_slot >= c.max(slot) {
                        self.mark_contested(&k, slot, journal, report);
                        continue;
                    }
                }
            }
            let fees_out: u64 = p.versions.iter().map(|v| v.fee).sum();
            if p.versions.len() as u32 >= self.params.max_versions {
                self.mark_contested(&k, slot, journal, report);
                continue;
            }
            // ⑱: no new W version while `max_unknown_w_versions` older ones
            // can still land (each would end `AlreadyDone`, fee paid).
            let cap = self.params.max_unknown_w_versions;
            if p.spec.class == Class::W
                && cap > 0
                && live_unknown_versions(
                    p.versions
                        .iter()
                        .map(|v| (v.sent_slot, p.settled.contains(&v.sig))),
                    slot,
                ) >= cap as usize
            {
                self.mark_contested(&k, slot, journal, report);
                continue;
            }
            let slots_waiting = p.first_slot.map_or(0, |f| slot.saturating_sub(f));
            let bid = self.params.bid(p.spec.class, slots_waiting) + p.bonus_milli;
            if self.resend_waits(p, bid, slot) {
                self.mark_contested(&k, slot, journal, report);
                continue;
            }
            let payer = match p.spec.fixed_payer {
                Some(a) => match payers.keypair(&a) {
                    Some(k) => k.insecure_clone(),
                    None => {
                        report
                            .send_errors
                            .push((k.clone(), format!("no keypair for fixed payer {a}")));
                        continue;
                    }
                },
                None => payers.draw(p.spec.class).insecure_clone(),
            };
            let ctx = BuildCtx {
                payer: payer.pubkey(),
                version: p.versions.len() as u32,
                slots_waiting,
            };
            let ixs = (p.spec.build)(&ctx);
            let b = self.budgets.get(p.spec.tag);
            let mut budget = tx::TxBudget {
                cu_limit: p.cu_limit,
                cu_price: 0,
                loaded_limit: b.loaded_limit,
                heap: p.heap,
            };
            if blockhash.is_none() {
                // The chain's slot now (a late tick sends in a later slot
                // than it read at its start).
                if chain_slot.is_none() {
                    chain_slot = port.clock().await.ok().map(|c| c.slot);
                }
                match port.blockhash().await {
                    Ok((h, height)) if height > 0 => {
                        blockhash = Some(h);
                        last_valid_block_height = Some(height);
                        hash_at = std::time::Instant::now();
                    }
                    Ok((_, _)) => {
                        report
                            .send_errors
                            .push((k.clone(), "blockhash: no last valid block height".into()));
                        return;
                    }
                    Err(e) => {
                        report
                            .send_errors
                            .push((k.clone(), format!("blockhash: {e}")));
                        return;
                    }
                }
            }
            // `Hash` is `Copy` only under solana-hash's `copy` feature, which
            // this crate alone does not enable: rebuild it from its bytes.
            let bh = blockhash
                .as_ref()
                .map(|h| Hash::new_from_array(h.to_bytes()))
                .expect("blockhash");
            let shape = tx::shape(&tx::message(&ixs, &budget, &ctx.payer, &bh));
            let cost = fees::cost(
                budget.cu_limit,
                shape.sigs as u8,
                shape.writes as u8,
                budget.loaded_limit,
            );
            budget.cu_price = fees::cu_price_for(bid, cost, budget.cu_limit);
            let fee = fees::LAMPORTS_PER_SIGNATURE * shape.sigs as u64
                + fees::priority_fee(budget.cu_price, budget.cu_limit);
            if !p.versions.is_empty() && fees_out + fee > self.params.per_write_cap {
                continue; // wait on the versions already out (§8.2 duplicates bound)
            }
            let t = match tx::build(&ixs, &budget, &[&payer], &bh) {
                Ok(t) => t,
                Err(e) => {
                    report.send_errors.push((k.clone(), e));
                    continue;
                }
            };
            let wire = tx::wire(&t);
            let sig = tx::signature(&t);
            let write_id = p.write_id.clone().unwrap_or_else(|| sig.to_string());
            // Persist the signed version before calling RPC. A send error
            // can mean the network received it but the reply was lost, so
            // the signature must already be available for reconciliation.
            if let Some(j) = journal {
                let p = self.pending.get(&k).expect("pending");
                if let Err(e) = j.record_attempt(&Attempt {
                    sig: sig.to_string(),
                    write_id: Some(write_id.clone()),
                    tag: Some(p.spec.tag),
                    kind: p.spec.kind.into(),
                    object_key: k.clone(),
                    bell: p.spec.bell,
                    region: p.spec.region,
                    class: p.spec.class.letter().into(),
                    payer: ctx.payer.to_string(),
                    bid_milli: bid,
                    fee,
                    cu_limit: budget.cu_limit,
                    heap: budget.heap,
                    first_valid_slot: slot,
                    sent_slot: slot,
                    last_valid_block_height,
                    landed_slot: None,
                    status: "sent".into(),
                    code: None,
                }) {
                    report
                        .send_errors
                        .push((k.clone(), format!("journal before send: {e}")));
                    continue;
                }
            }
            let send_result = port.send(&wire).await;
            sends_on_hash += 1;
            // Reserve the fee even if RPC returned an error: the chain may
            // have received the exact signature, and it can still land.
            payers.note_spend(&ctx.payer, fee);
            let p = self.pending.get_mut(&k).expect("pending");
            p.write_id = Some(write_id);
            if p.first_slot.is_none() {
                p.first_slot = Some(slot);
            }
            let v = Version {
                sig,
                payer: ctx.payer,
                bid_milli: bid,
                cu_limit: budget.cu_limit,
                heap: budget.heap,
                sent_slot: slot,
                last_valid_block_height,
                chain_slot: chain_slot.unwrap_or(slot).max(slot),
                fee,
            };
            p.versions.push(v);
            self.uncounted_fees.insert(sig, (p.spec.kind.into(), fee));
            self.last_send_chain_slot = Some(chain_slot.unwrap_or(slot).max(slot));
            self.stats.entry(p.spec.kind.into()).or_default().versions += 1;
            match send_result {
                Ok(_) => report.sent += 1,
                Err(e) => report
                    .send_errors
                    .push((k.clone(), format!("send outcome unknown: {e}"))),
            }
            self.mark_contested(&k, slot, journal, report);
        }
    }

    /// Whether a D or N write waits for its version in flight instead of
    /// sending the next one now (module docs, "Resend cadence").
    fn resend_waits(&self, p: &Pending, bid: u64, slot: u64) -> bool {
        if p.spec.class == Class::W {
            return false;
        }
        let Some(last) = p.versions.last() else {
            return false;
        };
        // The retry ladder changed the limits: the next version goes now.
        if last.cu_limit != p.cu_limit || last.heap != p.heap {
            return false;
        }
        let in_flight = p
            .versions
            .iter()
            .any(|v| !p.settled.contains(&v.sig) && slot <= v.sent_slot + EXPIRY_SLOTS);
        if !in_flight {
            return false;
        }
        let gap = if bid > last.bid_milli {
            self.params.d_resend_slots
        } else {
            self.params.cap_resend_slots
        };
        // Counted from the slot the version really went out in: a keeper
        // tick that ran two slots late sent a version that could not land
        // before the next tick, and a second version went out (the W6-C
        // stack run with eager personas: 8 of 12 `OutOfOrder`).
        slot < last.chain_slot.max(last.sent_slot) + gap.max(1)
    }

    /// Contested: not landed `contested_slots` after a bid ≥ p_tip (checked
    /// every slot, whether or not a version went out).
    fn mark_contested(
        &mut self,
        k: &str,
        slot: u64,
        journal: Option<&Journal>,
        report: &mut StepReport,
    ) {
        let Some(p) = self.pending.get_mut(k) else {
            return;
        };
        let Some(first) = p.first_slot else {
            return;
        };
        if !p.contested
            && slot.saturating_sub(first) >= self.params.contested_slots
            && p.versions.iter().any(|v| {
                v.bid_milli >= self.params.p_tip_milli
                    && v.sent_slot + self.params.contested_slots <= slot
            })
        {
            p.contested = true;
            report
                .contested
                .push((p.spec.bell, p.spec.region, k.to_string()));
            if let Some(j) = journal {
                let _ = j.alert(slot, "contested", k);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::KeeperConfig;
    use fclient::ports::{
        Account, ClockSysvar, Cursor, PortError, PortResult, SimResult, TxRecord,
    };
    use std::sync::Mutex;

    /// ⑱: the cap counts versions that can still land: status unknown and
    /// within the blockhash validity. Pure data, no key and no signature.
    #[test]
    fn live_unknown_versions_counts_only_what_can_still_land() {
        let at = 1_000u64;
        assert_eq!(live_unknown_versions([], at), 0);
        // Two unknown, recent: both can land.
        assert_eq!(live_unknown_versions([(990, false), (999, false)], at), 2);
        // A settled version never counts.
        assert_eq!(live_unknown_versions([(990, true), (999, false)], at), 1);
        // At the edge of validity it still counts; one slot past, it does not.
        assert_eq!(live_unknown_versions([(at - EXPIRY_SLOTS, false)], at), 1);
        assert_eq!(
            live_unknown_versions([(at - EXPIRY_SLOTS - 1, false)], at),
            0
        );
        // The keeper's default cap is 2 (`KeeperConfig`): two live unknown
        // versions block a third. The engine's own default is off.
        assert_eq!(EngineParams::default().max_unknown_w_versions, 0);
        let cap = 2usize;
        assert!(live_unknown_versions([(998, false), (999, false)], at) >= cap);
        assert!(live_unknown_versions([(998, false), (999, true)], at) < cap);
    }

    type Answer = Box<dyn FnMut(&fclient::Transaction) -> Option<Status> + Send>;

    /// A chain that records every send and answers statuses from a script.
    struct Script {
        sent: Mutex<Vec<fclient::Transaction>>,
        /// The status a transaction gets once sent (`None` = never lands).
        answer: Mutex<Answer>,
        statuses: Mutex<HashMap<Signature, Status>>,
        /// The Clock's slot (`send` reads it; 0 by default).
        clock_slot: std::sync::atomic::AtomicU64,
        blockhash_height: std::sync::atomic::AtomicU64,
        /// Simulates a timeout after the transaction reached the chain.
        fail_after_send: std::sync::atomic::AtomicBool,
        /// Simulates a status RPC failure after the transaction was sent.
        fail_status_lookup: std::sync::atomic::AtomicBool,
        /// Signature count of every `statuses` call (verify-pr259).
        status_calls: Mutex<Vec<usize>>,
        /// `blockhash` calls (keeper-stall-investigate).
        blockhash_calls: std::sync::atomic::AtomicU64,
    }

    impl Default for Script {
        fn default() -> Self {
            Script {
                sent: Mutex::new(vec![]),
                answer: Mutex::new(Box::new(|_| None)),
                statuses: Mutex::new(HashMap::new()),
                clock_slot: std::sync::atomic::AtomicU64::new(0),
                blockhash_height: std::sync::atomic::AtomicU64::new(150),
                fail_after_send: std::sync::atomic::AtomicBool::new(false),
                fail_status_lookup: std::sync::atomic::AtomicBool::new(false),
                status_calls: Mutex::new(vec![]),
                blockhash_calls: std::sync::atomic::AtomicU64::new(0),
            }
        }
    }

    impl ChainPort for Script {
        async fn clock(&self) -> PortResult<ClockSysvar> {
            Ok(ClockSysvar {
                slot: self.clock_slot.load(std::sync::atomic::Ordering::SeqCst),
                ..ClockSysvar::default()
            })
        }
        async fn accounts(&self, keys: &[Address], _: u64) -> PortResult<Vec<Option<Account>>> {
            Ok(keys
                .iter()
                .map(|_| {
                    Some(Account {
                        lamports: 10_000_000_000,
                        data: vec![],
                        owner: fclient::addr::system_program(),
                        executable: false,
                    })
                })
                .collect())
        }
        async fn simulate(&self, _: &[u8]) -> PortResult<SimResult> {
            Ok(SimResult::default())
        }
        async fn send(&self, w: &[u8]) -> PortResult<Signature> {
            let t = tx::from_wire(w).unwrap();
            let sig = tx::signature(&t);
            if let Some(st) = (self.answer.lock().unwrap())(&t) {
                self.statuses.lock().unwrap().insert(sig, st);
            }
            self.sent.lock().unwrap().push(t);
            if self
                .fail_after_send
                .load(std::sync::atomic::Ordering::SeqCst)
            {
                return Err(PortError::Io("reply lost after send".into()));
            }
            Ok(sig)
        }
        async fn statuses(&self, sigs: &[Signature]) -> PortResult<Vec<Option<Status>>> {
            self.status_calls.lock().unwrap().push(sigs.len());
            if self
                .fail_status_lookup
                .load(std::sync::atomic::Ordering::SeqCst)
            {
                return Err(PortError::Io("injected: status RPC down".into()));
            }
            let m = self.statuses.lock().unwrap();
            Ok(sigs.iter().map(|s| m.get(s).cloned()).collect())
        }
        async fn feed(&self, _: Cursor) -> PortResult<Vec<TxRecord>> {
            Ok(vec![])
        }
        async fn blockhash(&self) -> PortResult<(Hash, u64)> {
            self.blockhash_calls
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Ok((
                Hash::new_from_array([3; 32]),
                self.blockhash_height
                    .load(std::sync::atomic::Ordering::SeqCst),
            ))
        }
    }

    fn payers() -> Payers {
        let mut c = KeeperConfig::new(
            Address::new_from_array([1; 32]),
            1,
            Address::new_from_array([2; 32]),
        );
        c.delay_floor = 1;
        c.reveal_floor = Some(1);
        Payers::new(&[9u8; 32], &c).unwrap()
    }

    fn spec(key: &str, class: Class, tag: u8) -> WriteSpec {
        WriteSpec {
            key: key.into(),
            kind: "test",
            tag,
            class,
            bell: Some(3),
            region: Some(4),
            build: Arc::new(|c: &BuildCtx| {
                vec![Instruction {
                    program_id: Address::new_from_array([7; 32]),
                    accounts: vec![solana_instruction::AccountMeta::new(c.payer, true)],
                    data: vec![c.version as u8],
                }]
            }),
            deadline_slot: None,
            not_before_slot: 0,
            fixed_payer: None,
        }
    }

    fn priority_of(t: &fclient::Transaction) -> u64 {
        tx::priority(&t.message).0
    }

    #[tokio::test]
    async fn care_transfer_sends_one_version_while_program_n_keeps_its_cadence() {
        let port = Script::default();
        let mut payers = payers();
        payers.refresh(&port, 0).await.unwrap();
        let from = payers.delay.keys[0].pubkey();
        let to = payers.delay.keys[1].pubkey();
        let mut care = spec("care:from:to:1", Class::N, 0);
        care.kind = PAYER_CARE_KIND;
        care.fixed_payer = Some(from);
        care.build = Arc::new(move |_| vec![tx::transfer(from, to, 100_000)]);
        let mut e = Engine::new(Budgets::placeholder(), EngineParams::default());
        let j = Journal::open(std::path::Path::new(":memory:")).unwrap();
        e.ensure(care, 1);
        assert_eq!(e.step(&port, &mut payers, Some(&j), 1).await.sent, 1);
        for slot in 2..190 {
            assert_eq!(e.step(&port, &mut payers, Some(&j), slot).await.sent, 0);
        }
        assert_eq!(port.sent.lock().unwrap().len(), 1);
        assert!(e.care_unresolved());
        assert!(e.is_pending("care:from:to:1"));
        assert_eq!(j.in_flight().unwrap().len(), 1);

        let sig = tx::signature(&port.sent.lock().unwrap()[0]);
        port.statuses.lock().unwrap().insert(
            sig,
            Status {
                slot: 190,
                err: None,
                code: None,
            },
        );
        e.step(&port, &mut payers, Some(&j), 190).await;
        assert_eq!(e.care_settled_slot(), Some(190));
        assert!(!e.care_unresolved());
        assert_eq!(
            e.stats[PAYER_CARE_KIND].fees_charged,
            j.attempts_of("care:from:to:1").unwrap()[0].fee
        );

        let normal = Script::default();
        let mut e = Engine::new(Budgets::placeholder(), EngineParams::default());
        e.ensure(spec("normal-n", Class::N, abi::tag::CLOSE_ARRIVAL_DAY), 1);
        for slot in 1..=18 {
            e.step(&normal, &mut payers, None, slot).await;
        }
        assert!(
            normal.sent.lock().unwrap().len() >= 2,
            "normal N still resends"
        );
    }

    #[tokio::test]
    async fn adopted_unknown_care_is_not_discarded_by_slot_age() {
        let port = Script::default();
        let sig = Signature::default();
        let fee = 5_123;
        let j = Journal::open(std::path::Path::new(":memory:")).unwrap();
        j.record_attempt(&Attempt {
            sig: sig.to_string(),
            write_id: None,
            tag: None,
            kind: PAYER_CARE_KIND.into(),
            object_key: "care:old:transfer:1".into(),
            bell: None,
            region: None,
            class: "N".into(),
            payer: payers().delay.keys[0].pubkey().to_string(),
            bid_milli: 100,
            fee,
            cu_limit: 2_000,
            heap: None,
            first_valid_slot: 1,
            sent_slot: 1,
            last_valid_block_height: None,
            landed_slot: None,
            status: "sent".into(),
            code: None,
        })
        .unwrap();
        let mut e = Engine::new(Budgets::placeholder(), EngineParams::default());
        e.adopt(&j.in_flight().unwrap()).unwrap();
        e.poll(&port, Some(&j), 200).await;
        assert!(e.care_unresolved());
        assert_eq!(j.in_flight().unwrap().len(), 1);
        port.statuses.lock().unwrap().insert(
            sig,
            Status {
                slot: 201,
                err: None,
                code: None,
            },
        );
        e.poll(&port, Some(&j), 202).await;
        assert!(!e.care_unresolved());
        assert_eq!(e.care_settled_slot(), Some(201));
        assert_eq!(e.stats[PAYER_CARE_KIND].fees_charged, fee);
        e.poll(&port, Some(&j), 203).await;
        assert_eq!(e.stats[PAYER_CARE_KIND].fees_charged, fee);
    }

    /// keeper-stall-investigate: one blockhash per pass let only the first
    /// ≈ 40 sends of a long pass land on devnet. A pass now fetches a fresh
    /// hash every BLOCKHASH_REFRESH_SENDS sends, and every version records
    /// the validity height of the hash it was signed with.
    #[tokio::test]
    async fn long_send_pass_refreshes_the_blockhash() {
        use std::sync::atomic::Ordering::SeqCst;
        let port = Script::default();
        let mut payers = payers();
        payers.refresh(&port, 0).await.unwrap();
        let mut e = Engine::new(Budgets::placeholder(), EngineParams::default());
        for i in 0..40 {
            e.ensure(
                spec(&format!("w{i:02}"), Class::D, abi::tag::POST_ANCHOR),
                1,
            );
        }
        let j = Journal::open(std::path::Path::new(":memory:")).unwrap();
        let sent = e.step(&port, &mut payers, Some(&j), 1).await.sent as u64;
        assert!(sent > u64::from(BLOCKHASH_REFRESH_SENDS) * 2, "sent {sent}");
        let calls = port.blockhash_calls.load(SeqCst);
        let want = sent.div_ceil(u64::from(BLOCKHASH_REFRESH_SENDS));
        assert_eq!(calls, want, "{sent} sends → {want} blockhash fetches");
        assert!(j
            .in_flight()
            .unwrap()
            .iter()
            .all(|a| a.last_valid_block_height == Some(150)));
    }

    /// keeper-stall-investigate: devnet 11-26 15:04, 93 care transfers signed
    /// with an expired hash never landed; staying "unknown" forever they kept
    /// `care_unresolved` true and the delay pool drained to the rent floor.
    /// Once the chain is EXPIRED_MARGIN_BLOCKS past the version's validity
    /// height, the transfer ends as never landed (no fee charged).
    #[tokio::test]
    async fn expired_unknown_care_transfer_stops_blocking_care() {
        use std::sync::atomic::Ordering::SeqCst;
        let port = Script::default();
        let mut payers = payers();
        payers.refresh(&port, 0).await.unwrap();
        let from = payers.delay.keys[0].pubkey();
        let to = payers.delay.keys[1].pubkey();
        let mut care = spec("care:from:to:1", Class::N, 0);
        care.kind = PAYER_CARE_KIND;
        care.fixed_payer = Some(from);
        care.build = Arc::new(move |_| vec![tx::transfer(from, to, 100_000)]);
        let mut e = Engine::new(Budgets::placeholder(), EngineParams::default());
        let j = Journal::open(std::path::Path::new(":memory:")).unwrap();
        e.ensure(care, 1);
        assert_eq!(e.step(&port, &mut payers, Some(&j), 1).await.sent, 1);
        // Signed with validity height 150. Exactly at the margin: still unknown.
        port.blockhash_height
            .store(150 + EXPIRED_MARGIN_BLOCKS + BLOCKHASH_VALID_BLOCKS, SeqCst);
        e.step(&port, &mut payers, Some(&j), 200).await;
        assert!(e.care_unresolved());
        // A failed status read proves nothing.
        port.blockhash_height
            .store(151 + EXPIRED_MARGIN_BLOCKS + BLOCKHASH_VALID_BLOCKS, SeqCst);
        port.fail_status_lookup.store(true, SeqCst);
        e.step(&port, &mut payers, Some(&j), 201).await;
        assert!(e.care_unresolved());
        assert_eq!(e.never_landed, 0);
        // One block past the margin with a successful (null) read: settled.
        port.fail_status_lookup.store(false, SeqCst);
        let r = e.step(&port, &mut payers, Some(&j), 202).await;
        assert!(!e.care_unresolved());
        assert!(!e.is_pending("care:from:to:1"));
        assert_eq!(e.never_landed, 1);
        assert!(r
            .outcomes
            .iter()
            .any(|(k, o)| k == "care:from:to:1" && matches!(o, Outcome::Failed { .. })));
        assert_eq!(
            e.stats.get(PAYER_CARE_KIND).map_or(0, |s| s.fees_charged),
            0,
            "a transfer that never landed paid no fee"
        );
        assert!(j.in_flight().unwrap().is_empty());
        assert_eq!(
            j.attempts_of("care:from:to:1").unwrap()[0].status,
            "superseded"
        );
        // No second version of the old transfer.
        assert_eq!(port.sent.lock().unwrap().len(), 1);
    }

    /// An adopted orphan with a recorded validity height is settled the same
    /// way after a restart; one without (legacy row) still waits.
    #[tokio::test]
    async fn adopted_orphan_past_its_validity_settles_as_never_landed() {
        use std::sync::atomic::Ordering::SeqCst;
        let port = Script::default();
        let j = Journal::open(std::path::Path::new(":memory:")).unwrap();
        let row = |sig: Signature, key: &str, valid: Option<u64>| Attempt {
            sig: sig.to_string(),
            write_id: None,
            tag: None,
            kind: PAYER_CARE_KIND.into(),
            object_key: key.into(),
            bell: None,
            region: None,
            class: "N".into(),
            payer: payers().delay.keys[0].pubkey().to_string(),
            bid_milli: 100,
            fee: 5_000,
            cu_limit: 2_000,
            heap: None,
            first_valid_slot: 1,
            sent_slot: 1,
            last_valid_block_height: valid,
            landed_slot: None,
            status: "sent".into(),
            code: None,
        };
        let with = Signature::from([1u8; 64]);
        let legacy = Signature::from([2u8; 64]);
        j.record_attempt(&row(with, "care:a:b:1", Some(1_000)))
            .unwrap();
        j.record_attempt(&row(legacy, "care:a:c:1", None)).unwrap();
        let mut e = Engine::new(Budgets::placeholder(), EngineParams::default());
        e.adopt(&j.in_flight().unwrap()).unwrap();
        port.blockhash_height.store(
            1_001 + EXPIRED_MARGIN_BLOCKS + BLOCKHASH_VALID_BLOCKS,
            SeqCst,
        );
        e.poll(&port, Some(&j), 5_000).await;
        let left: Vec<String> = j.in_flight().unwrap().into_iter().map(|a| a.sig).collect();
        assert_eq!(left, vec![legacy.to_string()]);
        assert!(
            e.care_unresolved(),
            "the legacy row has no height to judge by"
        );
        assert_eq!(e.never_landed, 1);
        // A later finalized status still overwrites `superseded`.
        j.set_status(&with.to_string(), "landed", Some(42), None)
            .unwrap();
    }

    /// A program write whose old version can no longer land gets its next
    /// version from the normal send path.
    #[tokio::test]
    async fn program_write_resends_after_its_version_expires() {
        use std::sync::atomic::Ordering::SeqCst;
        let port = Script::default();
        let mut payers = payers();
        payers.refresh(&port, 0).await.unwrap();
        let mut e = Engine::new(Budgets::placeholder(), EngineParams::default());
        let j = Journal::open(std::path::Path::new(":memory:")).unwrap();
        e.ensure(spec("w", Class::D, abi::tag::POST_ANCHOR), 1);
        assert_eq!(e.step(&port, &mut payers, Some(&j), 1).await.sent, 1);
        port.blockhash_height
            .store(151 + EXPIRED_MARGIN_BLOCKS + BLOCKHASH_VALID_BLOCKS, SeqCst);
        let r = e.step(&port, &mut payers, Some(&j), 400).await;
        assert_eq!(r.sent, 1, "next version after the old one expired");
        assert!(e.is_pending("w"));
        assert_eq!(e.never_landed, 1);
        let rows = j.attempts_of("w").unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows.iter().filter(|a| a.status == "superseded").count(), 1);
    }

    #[tokio::test]
    async fn journal_failure_prevents_send_and_ambiguous_rpc_keeps_fee() {
        let port = Script::default();
        let mut payers = payers();
        payers.refresh(&port, 0).await.unwrap();
        let mut e = Engine::new(Budgets::placeholder(), EngineParams::default());
        e.ensure(spec("durable", Class::D, abi::tag::POST_ANCHOR), 10);
        let j = Journal::open(std::path::Path::new(":memory:")).unwrap();
        j.conn.execute_batch("DROP TABLE attempts").unwrap();
        let r = e.step(&port, &mut payers, Some(&j), 10).await;
        assert_eq!(r.sent, 0);
        assert!(r.send_errors[0].1.contains("journal before send"));
        assert!(
            port.sent.lock().unwrap().is_empty(),
            "no RPC before a durable record"
        );
        assert!(e.pending["durable"].versions.is_empty());

        // A second journal is healthy. The RPC sees the signed wire but its
        // reply is lost; the version and its fee remain in both memories.
        let j = Journal::open(std::path::Path::new(":memory:")).unwrap();
        port.fail_after_send
            .store(true, std::sync::atomic::Ordering::SeqCst);
        let r = e.step(&port, &mut payers, Some(&j), 11).await;
        assert_eq!(r.sent, 0, "RPC did not confirm the send");
        assert!(r.send_errors[0].1.contains("outcome unknown"));
        assert_eq!(port.sent.lock().unwrap().len(), 1);
        let inflight = j.in_flight().unwrap();
        assert_eq!(inflight.len(), 1);
        assert!(inflight[0].fee > 0);
        assert_eq!(inflight[0].last_valid_block_height, Some(150));
        assert_eq!(e.pending["durable"].versions[0].fee, inflight[0].fee);
        assert_eq!(
            e.pending["durable"].versions[0].last_valid_block_height,
            inflight[0].last_valid_block_height
        );

        let mut restarted = Engine::new(Budgets::placeholder(), EngineParams::default());
        restarted.adopt(&inflight).unwrap();
        restarted.ensure(spec("durable", Class::D, abi::tag::POST_ANCHOR), 12);
        assert_eq!(
            restarted.pending["durable"].versions[0].fee,
            inflight[0].fee
        );
        assert_eq!(
            restarted.pending["durable"].versions[0].last_valid_block_height,
            Some(150)
        );
        let mut capped = Engine::new(
            Budgets::placeholder(),
            EngineParams {
                per_write_cap: inflight[0].fee,
                ..EngineParams::default()
            },
        );
        capped.adopt(&inflight).unwrap();
        capped.ensure(spec("durable", Class::D, abi::tag::POST_ANCHOR), 12);
        let sends = port.sent.lock().unwrap().len();
        assert_eq!(capped.step(&port, &mut payers, Some(&j), 13).await.sent, 0);
        assert_eq!(
            port.sent.lock().unwrap().len(),
            sends,
            "restored fee counts against the cap"
        );
        let mut bad = inflight;
        bad[0].fee = 0;
        assert!(Engine::new(Budgets::placeholder(), EngineParams::default())
            .adopt(&bad)
            .is_err());
    }

    #[tokio::test]
    async fn missing_blockhash_validity_height_prevents_send() {
        let port = Script::default();
        port.blockhash_height
            .store(0, std::sync::atomic::Ordering::SeqCst);
        let mut payers = payers();
        payers.refresh(&port, 0).await.unwrap();
        let journal = Journal::open(std::path::Path::new(":memory:")).unwrap();
        let mut engine = Engine::new(Budgets::placeholder(), EngineParams::default());
        engine.ensure(spec("unknown-height", Class::D, abi::tag::POST_SEED), 10);

        let report = engine.step(&port, &mut payers, Some(&journal), 10).await;
        assert_eq!(report.sent, 0);
        assert!(report.send_errors[0]
            .1
            .contains("no last valid block height"));
        assert!(port.sent.lock().unwrap().is_empty());
        assert!(journal.in_flight().unwrap().is_empty());
        assert!(engine.pending["unknown-height"].versions.is_empty());
    }

    #[tokio::test]
    async fn every_landed_version_is_charged_once_after_a_write_ends() {
        let port = Script::default();
        let mut payers = payers();
        payers.refresh(&port, 0).await.unwrap();
        let mut e = Engine::new(Budgets::placeholder(), EngineParams::default());
        e.ensure(spec("fees", Class::W, abi::tag::REVEAL), 10);
        for slot in 10..13 {
            assert_eq!(e.step(&port, &mut payers, None, slot).await.sent, 1);
        }
        let versions = e.pending["fees"].versions.clone();
        assert_eq!(versions.len(), 3);
        {
            let mut statuses = port.statuses.lock().unwrap();
            statuses.insert(
                versions[0].sig,
                Status {
                    slot: 13,
                    err: None,
                    code: None,
                },
            );
            statuses.insert(
                versions[1].sig,
                Status {
                    slot: 13,
                    err: Some("AlreadyDone".into()),
                    code: Some(52),
                },
            );
            statuses.insert(
                versions[2].sig,
                Status {
                    slot: 13,
                    err: Some("OutOfOrder".into()),
                    code: Some(8),
                },
            );
        }
        assert_eq!(e.poll(&port, None, 13).await.outcomes.len(), 1);
        let want: u64 = versions.iter().map(|v| v.fee).sum();
        assert_eq!(e.stats["test"].fees_charged, want);
        e.poll(&port, None, 14).await;
        assert_eq!(e.stats["test"].fees_charged, want);
    }

    #[tokio::test]
    async fn same_batch_success_wins_regardless_of_sibling_status_order() {
        for success_first in [false, true] {
            let port = Script::default();
            let mut payers = payers();
            payers.refresh(&port, 0).await.unwrap();
            let journal = Journal::open(std::path::Path::new(":memory:")).unwrap();
            let mut engine = Engine::new(Budgets::placeholder(), EngineParams::default());
            assert!(engine.ensure(spec("race", Class::D, abi::tag::POST_SEED), 10));
            assert_eq!(
                engine
                    .step(&port, &mut payers, Some(&journal), 10)
                    .await
                    .sent,
                1
            );
            assert_eq!(
                engine
                    .step(&port, &mut payers, Some(&journal), 12)
                    .await
                    .sent,
                1
            );
            let versions = engine.pending["race"].versions.clone();
            let success_sig = versions[usize::from(!success_first)].sig;
            for (i, version) in versions.iter().enumerate() {
                let success = i == usize::from(!success_first);
                port.statuses.lock().unwrap().insert(
                    version.sig,
                    Status {
                        slot: 13,
                        err: (!success).then(|| "program rejected".into()),
                        code: (!success).then_some(8),
                    },
                );
            }
            let result = engine.poll(&port, Some(&journal), 13).await;
            assert!(matches!(
                result.outcomes.as_slice(),
                [(key, Outcome::Landed { sig, .. })] if key == "race" && *sig == success_sig
            ));
            assert_eq!(engine.stats["test"].landed, 1);
            assert_eq!(engine.stats["test"].failed, 0);
            assert_eq!(
                engine.stats["test"].fees_charged,
                versions.iter().map(|v| v.fee).sum::<u64>()
            );
            assert!(journal.in_flight().unwrap().is_empty());
        }
    }

    #[tokio::test]
    async fn same_batch_already_done_sibling_is_recorded_as_done_once() {
        let port = Script::default();
        let mut payers = payers();
        payers.refresh(&port, 0).await.unwrap();
        let journal = Journal::open(std::path::Path::new(":memory:")).unwrap();
        let mut engine = Engine::new(Budgets::placeholder(), EngineParams::default());
        assert!(engine.ensure(spec("done-pair", Class::D, abi::tag::POST_SEED), 10));
        assert_eq!(
            engine
                .step(&port, &mut payers, Some(&journal), 10)
                .await
                .sent,
            1
        );
        assert_eq!(
            engine
                .step(&port, &mut payers, Some(&journal), 12)
                .await
                .sent,
            1
        );
        let versions = engine.pending["done-pair"].versions.clone();
        port.statuses.lock().unwrap().insert(
            versions[0].sig,
            Status {
                slot: 13,
                err: None,
                code: None,
            },
        );
        port.statuses.lock().unwrap().insert(
            versions[1].sig,
            Status {
                slot: 13,
                err: Some("AlreadyDone".into()),
                code: Some(err::ALREADY_DONE),
            },
        );
        let result = engine.poll(&port, Some(&journal), 13).await;
        assert!(
            matches!(result.outcomes.as_slice(), [(key, Outcome::Landed { .. })]
            if key == "done-pair")
        );
        assert_eq!(engine.stats["test"].landed, 1);
        let attempts = journal.attempts_of("done-pair").unwrap();
        assert_eq!(
            attempts[0].write_id.as_deref(),
            Some(attempts[0].sig.as_str())
        );
        assert_eq!(attempts[1].write_id, attempts[0].write_id);
        assert_eq!(
            attempts
                .iter()
                .map(|a| a.status.as_str())
                .collect::<Vec<_>>(),
            vec!["landed", "done"]
        );
    }

    #[tokio::test]
    async fn failed_journal_status_keeps_fee_and_write_pending_without_resend() {
        let port = Script::default();
        let mut payers = payers();
        payers.refresh(&port, 0).await.unwrap();
        let journal = Journal::open(std::path::Path::new(":memory:")).unwrap();
        let mut engine = Engine::new(Budgets::placeholder(), EngineParams::default());
        assert!(engine.ensure(spec("status-write-fail", Class::D, abi::tag::POST_SEED), 10));
        assert_eq!(
            engine
                .step(&port, &mut payers, Some(&journal), 10)
                .await
                .sent,
            1
        );
        let sig = engine.pending["status-write-fail"].versions[0].sig;
        // A missing row is a deterministic stand-in for a failed journal
        // status write. The keeper must not emit Landed or reuse the cap.
        journal
            .conn
            .execute("DELETE FROM attempts WHERE sig = ?1", [sig.to_string()])
            .unwrap();
        port.statuses.lock().unwrap().insert(
            sig,
            Status {
                slot: 11,
                err: None,
                code: None,
            },
        );
        let observed = engine.poll(&port, Some(&journal), 11).await;
        assert!(observed.outcomes.is_empty());
        assert_eq!(observed.send_errors.len(), 1);
        assert!(engine.is_pending("status-write-fail"));
        assert_eq!(engine.stats["test"].fees_charged, 0);
        let next = engine.step(&port, &mut payers, Some(&journal), 12).await;
        assert_eq!(next.sent, 0);
        assert!(next.outcomes.is_empty());
        assert!(engine.is_pending("status-write-fail"));
    }

    #[tokio::test]
    async fn failed_variant_waits_for_late_sibling_success_before_notifying_duty() {
        let port = Script::default();
        let mut payers = payers();
        payers.refresh(&port, 0).await.unwrap();
        let journal = Journal::open(std::path::Path::new(":memory:")).unwrap();
        let mut engine = Engine::new(Budgets::placeholder(), EngineParams::default());
        assert!(engine.ensure(spec("late", Class::D, abi::tag::POST_SEED), 10));
        assert_eq!(
            engine
                .step(&port, &mut payers, Some(&journal), 10)
                .await
                .sent,
            1
        );
        assert_eq!(
            engine
                .step(&port, &mut payers, Some(&journal), 12)
                .await
                .sent,
            1
        );
        let versions = engine.pending["late"].versions.clone();
        port.statuses.lock().unwrap().insert(
            versions[0].sig,
            Status {
                slot: 13,
                err: Some("rejected".into()),
                code: Some(8),
            },
        );
        let first = engine.poll(&port, Some(&journal), 13).await;
        assert!(first.outcomes.is_empty(), "failure remains provisional");
        assert!(engine.is_pending("late"));
        assert!(!engine.ensure(spec("late", Class::D, abi::tag::POST_SEED), 15));
        assert_eq!(
            engine
                .step(&port, &mut payers, Some(&journal), 15)
                .await
                .sent,
            0
        );

        port.statuses.lock().unwrap().insert(
            versions[1].sig,
            Status {
                slot: 16,
                err: None,
                code: None,
            },
        );
        let late = engine.poll(&port, Some(&journal), 16).await;
        assert!(
            matches!(late.outcomes.as_slice(), [(key, Outcome::Landed { sig, .. })]
            if key == "late" && *sig == versions[1].sig)
        );
        assert!(engine
            .poll(&port, Some(&journal), 17)
            .await
            .outcomes
            .is_empty());
        assert_eq!(engine.stats["test"].landed, 1);
        assert_eq!(engine.stats["test"].failed, 0);
        assert_eq!(
            engine.stats["test"].fees_charged,
            versions.iter().map(|v| v.fee).sum::<u64>()
        );
        assert!(journal.in_flight().unwrap().is_empty());
    }

    #[tokio::test]
    async fn deadline_and_retry_cap_wait_for_possible_late_success() {
        for deadline_case in [true, false] {
            let port = Script::default();
            let mut payers = payers();
            payers.refresh(&port, 0).await.unwrap();
            let mut params = EngineParams::default();
            if !deadline_case {
                params.max_versions = 1;
            }
            let mut engine = Engine::new(Budgets::placeholder(), params);
            let mut write = spec("window", Class::D, abi::tag::POST_SEED);
            if deadline_case {
                write.deadline_slot = Some(12);
            }
            assert!(engine.ensure(write, 10));
            assert_eq!(engine.step(&port, &mut payers, None, 10).await.sent, 1);
            let sig = engine.pending["window"].versions[0].sig;
            let stop = if deadline_case {
                12
            } else {
                10 + EXPIRY_SLOTS + 1
            };
            let stopped = engine.step(&port, &mut payers, None, stop).await;
            assert!(
                matches!(stopped.outcomes.as_slice(), [(key, Outcome::Unresolved { .. })]
                if key == "window")
            );
            assert!(engine.is_pending("window"));
            assert_eq!(
                engine.step(&port, &mut payers, None, stop + 1).await.sent,
                0
            );
            port.statuses.lock().unwrap().insert(
                sig,
                Status {
                    slot: stop + 2,
                    err: None,
                    code: None,
                },
            );
            let result = engine.poll(&port, None, stop + 2).await;
            assert!(
                matches!(result.outcomes.as_slice(), [(key, Outcome::Landed { .. })]
                if key == "window")
            );
            assert_eq!(engine.stats["test"].landed, 1);
            assert_eq!(engine.stats["test"].failed, 0);
            assert_eq!(engine.stats["test"].dead, 0);
        }
    }

    #[tokio::test]
    async fn reveal_cutoff_keeps_unknown_signature_until_late_success() {
        let port = Script::default();
        let mut payers = payers();
        payers.refresh(&port, 0).await.unwrap();
        let mut engine = Engine::new(Budgets::placeholder(), EngineParams::default());
        assert!(engine.ensure(spec("reveal:8:105", Class::W, abi::tag::REVEAL), 10));
        assert_eq!(engine.step(&port, &mut payers, None, 10).await.sent, 1);
        let sig = engine.pending["reveal:8:105"].versions[0].sig;
        assert!(!engine.cancel_at_cutoff("reveal:8:105"));
        assert!(engine.is_pending("reveal:8:105"));
        assert_eq!(engine.step(&port, &mut payers, None, 11).await.sent, 0);
        port.statuses.lock().unwrap().insert(
            sig,
            Status {
                slot: 12,
                err: None,
                code: None,
            },
        );
        let result = engine.poll(&port, None, 12).await;
        assert!(
            matches!(result.outcomes.as_slice(), [(key, Outcome::Landed { .. })]
            if key == "reveal:8:105")
        );
        assert_eq!(engine.stats["test"].dead, 0);
    }

    #[tokio::test]
    async fn definitive_dead_sibling_wins_over_failed_in_either_order() {
        for dead_first in [false, true] {
            for same_batch in [false, true] {
                let port = Script::default();
                let mut payers = payers();
                payers.refresh(&port, 0).await.unwrap();
                let mut engine = Engine::new(Budgets::placeholder(), EngineParams::default());
                assert!(engine.ensure(spec("priority", Class::D, abi::tag::POST_SEED), 10));
                assert_eq!(engine.step(&port, &mut payers, None, 10).await.sent, 1);
                assert_eq!(engine.step(&port, &mut payers, None, 12).await.sent, 1);
                let versions = engine.pending["priority"].versions.clone();
                let mk_status = |dead: bool, slot| Status {
                    slot,
                    err: Some("refused".into()),
                    code: Some(if dead { err::NOT_IMPLEMENTED } else { 8 }),
                };
                port.statuses
                    .lock()
                    .unwrap()
                    .insert(versions[0].sig, mk_status(dead_first, 13));
                if same_batch {
                    port.statuses
                        .lock()
                        .unwrap()
                        .insert(versions[1].sig, mk_status(!dead_first, 13));
                } else {
                    assert!(engine.poll(&port, None, 13).await.outcomes.is_empty());
                    port.statuses
                        .lock()
                        .unwrap()
                        .insert(versions[1].sig, mk_status(!dead_first, 14));
                }
                let result = engine
                    .poll(&port, None, if same_batch { 13 } else { 14 })
                    .await;
                assert!(
                    matches!(result.outcomes.as_slice(), [(key, Outcome::Dead { .. })]
                    if key == "priority")
                );
                assert_eq!(engine.stats["test"].dead, 1);
                assert_eq!(engine.stats["test"].failed, 0);
            }
        }
    }

    #[tokio::test]
    async fn late_orphan_and_cancelled_write_fees_are_charged_once() {
        let port = Script::default();
        let mut payers = payers();
        payers.refresh(&port, 0).await.unwrap();
        let mut e = Engine::new(Budgets::placeholder(), EngineParams::default());
        e.ensure(spec("first", Class::W, abi::tag::REVEAL), 10);
        for slot in 10..12 {
            e.step(&port, &mut payers, None, slot).await;
        }
        let versions = e.pending["first"].versions.clone();
        port.statuses.lock().unwrap().insert(
            versions[0].sig,
            Status {
                slot: 12,
                err: None,
                code: None,
            },
        );
        e.poll(&port, None, 12).await;
        assert_eq!(e.stats["test"].fees_charged, versions[0].fee);
        port.statuses.lock().unwrap().insert(
            versions[1].sig,
            Status {
                slot: 13,
                err: Some("AlreadyDone".into()),
                code: Some(52),
            },
        );
        e.poll(&port, None, 13).await;
        let want = versions[0].fee + versions[1].fee;
        assert_eq!(e.stats["test"].fees_charged, want);
        e.poll(&port, None, 14).await;
        assert_eq!(e.stats["test"].fees_charged, want);

        e.ensure(spec("cancelled", Class::D, abi::tag::POST_SEED), 15);
        e.step(&port, &mut payers, None, 15).await;
        let cancelled = e.pending["cancelled"].versions[0].clone();
        e.cancel("cancelled", CancelReason::ChainStateObserved);
        port.statuses.lock().unwrap().insert(
            cancelled.sig,
            Status {
                slot: 16,
                err: Some("OutOfOrder".into()),
                code: Some(8),
            },
        );
        e.poll(&port, None, 16).await;
        assert_eq!(e.stats["test"].fees_charged, want + cancelled.fee);
    }

    #[tokio::test]
    async fn late_success_after_local_cancellation_is_not_a_duty_landing() {
        for reason in [CancelReason::SupersededNonce, CancelReason::StaleBell] {
            let port = Script::default();
            let mut payers = payers();
            payers.refresh(&port, 0).await.unwrap();
            let mut engine = Engine::new(Budgets::placeholder(), EngineParams::default());
            assert!(engine.ensure(spec("abandoned", Class::D, abi::tag::POST_SEED), 10));
            engine.step(&port, &mut payers, None, 10).await;
            let version = engine.pending["abandoned"].versions[0].clone();
            engine.cancel("abandoned", reason);
            port.statuses.lock().unwrap().insert(
                version.sig,
                Status {
                    slot: 11,
                    err: None,
                    code: None,
                },
            );

            let report = engine.poll(&port, None, 12).await;
            assert!(report.outcomes.is_empty());
            assert_eq!(
                report.cancelled_landed,
                vec![CancelledLanding {
                    key: "abandoned".into(),
                    sig: version.sig,
                    slot: 11,
                    reason,
                }]
            );
            assert_eq!(engine.stats["test"].landed, 0);
            assert_eq!(engine.stats["test"].fees_charged, version.fee);
            assert!(engine
                .poll(&port, None, 13)
                .await
                .cancelled_landed
                .is_empty());
        }
    }

    #[tokio::test]
    async fn cancelled_landing_waits_for_durable_status_before_alert_or_fee_release() {
        let port = Script::default();
        let mut payers = payers();
        payers.refresh(&port, 0).await.unwrap();
        let journal = Journal::open(std::path::Path::new(":memory:")).unwrap();
        let mut engine = Engine::new(Budgets::placeholder(), EngineParams::default());
        assert!(engine.ensure(spec("abandoned", Class::D, abi::tag::POST_SEED), 10));
        assert_eq!(
            engine
                .step(&port, &mut payers, Some(&journal), 10)
                .await
                .sent,
            1
        );
        let attempt = journal.attempts_of("abandoned").unwrap().remove(0);
        let sig: Signature = attempt.sig.parse().unwrap();
        engine.cancel("abandoned", CancelReason::StaleBell);
        journal
            .conn
            .execute("DELETE FROM attempts WHERE sig = ?1", [&attempt.sig])
            .unwrap();
        port.statuses.lock().unwrap().insert(
            sig,
            Status {
                slot: 11,
                err: None,
                code: None,
            },
        );
        let failed = engine.poll(&port, Some(&journal), 12).await;
        assert!(failed.cancelled_landed.is_empty());
        assert_eq!(failed.send_errors.len(), 1);
        assert_eq!(engine.orphans.len(), 1);
        assert_eq!(engine.stats["test"].fees_charged, 0);
        assert!(!engine.ensure(spec("abandoned", Class::D, abi::tag::POST_SEED), 12));

        journal.record_attempt(&attempt).unwrap();
        let repaired = engine.poll(&port, Some(&journal), 13).await;
        assert!(repaired.outcomes.is_empty());
        assert_eq!(repaired.cancelled_landed.len(), 1);
        assert_eq!(engine.stats["test"].fees_charged, attempt.fee);
        assert!(engine
            .poll(&port, Some(&journal), 14)
            .await
            .cancelled_landed
            .is_empty());
        assert_eq!(
            journal.attempts_of("abandoned").unwrap()[0].status,
            "landed"
        );
    }

    #[tokio::test]
    async fn chain_observed_and_failed_cancellations_do_not_emit_late_success() {
        for (reason, success) in [
            (CancelReason::ChainStateObserved, true),
            (CancelReason::StaleBell, false),
        ] {
            let port = Script::default();
            let mut payers = payers();
            payers.refresh(&port, 0).await.unwrap();
            let mut engine = Engine::new(Budgets::placeholder(), EngineParams::default());
            engine.ensure(spec("cancelled", Class::D, abi::tag::POST_SEED), 10);
            engine.step(&port, &mut payers, None, 10).await;
            let sig = engine.pending["cancelled"].versions[0].sig;
            engine.cancel("cancelled", reason);
            port.statuses.lock().unwrap().insert(
                sig,
                Status {
                    slot: 11,
                    err: (!success).then(|| "OutOfOrder".into()),
                    code: (!success).then_some(8),
                },
            );
            let report = engine.poll(&port, None, 12).await;
            assert!(report.outcomes.is_empty());
            assert!(report.cancelled_landed.is_empty());
        }
    }

    #[tokio::test]
    async fn old_unknown_orphan_keeps_predicted_fee_until_finalized() {
        let port = Script::default();
        let mut payers = payers();
        payers.refresh(&port, 0).await.unwrap();
        let journal = Journal::open(std::path::Path::new(":memory:")).unwrap();
        let mut engine = Engine::new(Budgets::placeholder(), EngineParams::default());
        engine.ensure(spec("old", Class::D, abi::tag::POST_SEED), 10);
        engine.step(&port, &mut payers, Some(&journal), 10).await;
        let version = engine.pending["old"].versions[0].clone();
        engine.cancel("old", CancelReason::ChainStateObserved);

        let late = 10 + EXPIRY_SLOTS + 1;
        engine.poll(&port, Some(&journal), late).await;
        assert_eq!(engine.orphans.len(), 1);
        assert!(engine.uncounted_fees.contains_key(&version.sig));
        assert_eq!(journal.in_flight().unwrap().len(), 1);
        assert_eq!(engine.stats["test"].fees_charged, 0);

        port.statuses.lock().unwrap().insert(
            version.sig,
            Status {
                slot: 11,
                err: None,
                code: None,
            },
        );
        engine.poll(&port, Some(&journal), late + 1).await;
        engine.poll(&port, Some(&journal), late + 2).await;
        assert!(engine.orphans.is_empty());
        assert!(engine.uncounted_fees.is_empty());
        assert!(journal.in_flight().unwrap().is_empty());
        assert_eq!(engine.stats["test"].fees_charged, version.fee);
    }

    #[tokio::test]
    async fn failed_sibling_holds_old_fee_exposure_until_other_signature_settles() {
        let port = Script::default();
        let mut payers = payers();
        payers.refresh(&port, 0).await.unwrap();
        let journal = Journal::open(std::path::Path::new(":memory:")).unwrap();
        let mut engine = Engine::new(Budgets::placeholder(), EngineParams::default());
        assert!(engine.ensure(spec("same", Class::D, abi::tag::POST_SEED), 10));
        assert_eq!(
            engine
                .step(&port, &mut payers, Some(&journal), 10)
                .await
                .sent,
            1
        );
        assert_eq!(
            engine
                .step(&port, &mut payers, Some(&journal), 12)
                .await
                .sent,
            1
        );
        let versions = engine.pending["same"].versions.clone();
        port.statuses.lock().unwrap().insert(
            versions[0].sig,
            Status {
                slot: 13,
                err: Some("program rejected".into()),
                code: Some(8),
            },
        );
        let outcome = engine.poll(&port, Some(&journal), 13).await;
        assert!(outcome.outcomes.is_empty(), "failure remains provisional");
        assert_eq!(journal.in_flight().unwrap().len(), 1);
        assert!(!engine.ensure(spec("same", Class::D, abi::tag::POST_SEED), 15));
        let mut other = spec("other", Class::D, abi::tag::POST_SEED);
        other.build = Arc::new(|c: &BuildCtx| {
            vec![Instruction {
                program_id: Address::new_from_array([7; 32]),
                accounts: vec![solana_instruction::AccountMeta::new(c.payer, true)],
                data: vec![99, c.version as u8],
            }]
        });
        assert!(engine.ensure(other, 15));
        assert_eq!(
            engine
                .step(&port, &mut payers, Some(&journal), 15)
                .await
                .sent,
            1
        );

        port.statuses.lock().unwrap().insert(
            versions[1].sig,
            Status {
                slot: 16,
                err: Some("program rejected".into()),
                code: Some(8),
            },
        );
        let final_result = engine.poll(&port, Some(&journal), 16).await;
        assert!(
            matches!(final_result.outcomes.as_slice(), [(key, Outcome::Failed { .. })]
            if key == "same")
        );
        assert_eq!(
            engine.stats["test"].fees_charged,
            versions[0].fee + versions[1].fee
        );
        assert!(!engine.ensure(spec("same", Class::D, abi::tag::POST_SEED), 16));
        assert!(engine.ensure(spec("same", Class::D, abi::tag::POST_SEED), 18));
    }

    #[tokio::test]
    async fn cancelled_and_deadline_writes_hold_unknown_signatures() {
        let port = Script::default();
        let mut payers = payers();
        payers.refresh(&port, 0).await.unwrap();
        let mut engine = Engine::new(Budgets::placeholder(), EngineParams::default());
        assert!(engine.ensure(spec("cancel", Class::D, abi::tag::POST_SEED), 10));
        engine.step(&port, &mut payers, None, 10).await;
        let cancelled = engine.pending["cancel"].versions[0].sig;
        engine.cancel("cancel", CancelReason::ChainStateObserved);
        assert!(!engine.ensure(spec("cancel", Class::D, abi::tag::POST_SEED), 11));

        let mut deadline = spec("deadline", Class::D, abi::tag::POST_SEED);
        deadline.deadline_slot = Some(12);
        assert!(engine.ensure(deadline, 10));
        engine.step(&port, &mut payers, None, 10).await;
        let late = engine.pending["deadline"].versions[0].sig;
        let result = engine.step(&port, &mut payers, None, 12).await;
        assert!(
            matches!(result.outcomes.as_slice(), [(key, Outcome::Unresolved { .. })]
            if key == "deadline")
        );
        assert!(!engine.ensure(spec("deadline", Class::D, abi::tag::POST_SEED), 13));

        {
            let mut statuses = port.statuses.lock().unwrap();
            for sig in [cancelled, late] {
                statuses.insert(
                    sig,
                    Status {
                        slot: 14,
                        err: Some("rejected".into()),
                        code: Some(8),
                    },
                );
            }
        }
        let settled = engine.poll(&port, None, 14).await;
        assert!(
            matches!(settled.outcomes.as_slice(), [(key, Outcome::Dead { .. })]
            if key == "deadline")
        );
        assert!(engine.ensure(spec("cancel", Class::D, abi::tag::POST_SEED), 14));
        assert!(engine.ensure(spec("deadline", Class::D, abi::tag::POST_SEED), 14));
    }

    #[tokio::test]
    async fn status_rpc_error_does_not_discard_old_orphan_fee() {
        let port = Script::default();
        let mut payers = payers();
        payers.refresh(&port, 0).await.unwrap();
        let journal = Journal::open(std::path::Path::new(":memory:")).unwrap();
        let mut engine = Engine::new(Budgets::placeholder(), EngineParams::default());
        engine.ensure(spec("rpc-error", Class::D, abi::tag::POST_SEED), 10);
        engine.step(&port, &mut payers, Some(&journal), 10).await;
        let version = engine.pending["rpc-error"].versions[0].clone();
        engine.cancel("rpc-error", CancelReason::ChainStateObserved);
        port.fail_status_lookup
            .store(true, std::sync::atomic::Ordering::SeqCst);

        engine
            .poll(&port, Some(&journal), 10 + EXPIRY_SLOTS + 1)
            .await;
        assert_eq!(engine.orphans.len(), 1);
        assert!(engine.uncounted_fees.contains_key(&version.sig));
        assert_eq!(journal.in_flight().unwrap().len(), 1);
        assert_eq!(engine.stats["test"].fees_charged, 0);
    }

    /// keeper-landing-investigate: a failed status read was dropped
    /// silently (devnet keeper A: no landing for hours, nothing in the log
    /// or `/v1/status`). It is counted now, and a good read clears the run.
    #[tokio::test]
    async fn failed_status_reads_are_counted_and_a_good_read_clears_the_run() {
        let port = Script::default();
        let mut payers = payers();
        payers.refresh(&port, 0).await.unwrap();
        let mut engine = Engine::new(Budgets::placeholder(), EngineParams::default());
        engine.ensure(spec("w", Class::D, abi::tag::POST_SEED), 10);
        engine.step(&port, &mut payers, None, 10).await;
        assert_eq!(engine.status_read_errors, (0, 0, None));
        port.fail_status_lookup
            .store(true, std::sync::atomic::Ordering::SeqCst);
        engine.poll(&port, None, 11).await;
        engine.poll(&port, None, 12).await;
        let (total, run, last) = engine.status_read_errors.clone();
        assert_eq!((total, run), (2, 2));
        assert!(last.unwrap().contains("status RPC down"));
        assert!(engine.pending.contains_key("w"), "unknown stays pending");
        port.fail_status_lookup
            .store(false, std::sync::atomic::Ordering::SeqCst);
        engine.poll(&port, None, 13).await;
        assert_eq!(
            (engine.status_read_errors.0, engine.status_read_errors.1),
            (2, 0)
        );
    }

    /// verify-pr259: pending versions and orphans share ONE status read per
    /// poll. `RpcPort` runs its capped history search at most once per
    /// `history_every` over all calls; with a second read for orphans, the
    /// pending read (a fresh unknown send nearly every tick) took every
    /// history turn and restart-adopted care orphans were never resolved.
    #[tokio::test]
    async fn pending_and_orphans_share_one_status_read_per_poll() {
        let port = Script::default();
        let mut payers = payers();
        payers.refresh(&port, 0).await.unwrap();
        let j = Journal::open(std::path::Path::new(":memory:")).unwrap();
        let care = Signature::from([9u8; 64]);
        j.record_attempt(&Attempt {
            sig: care.to_string(),
            write_id: None,
            tag: None,
            kind: PAYER_CARE_KIND.into(),
            object_key: "care:old:transfer:1".into(),
            bell: None,
            region: None,
            class: "N".into(),
            payer: payers.delay.keys[0].pubkey().to_string(),
            bid_milli: 100,
            fee: 5_000,
            cu_limit: 2_000,
            heap: None,
            first_valid_slot: 1,
            sent_slot: 1,
            last_valid_block_height: Some(151),
            landed_slot: None,
            status: "sent".into(),
            code: None,
        })
        .unwrap();
        let mut engine = Engine::new(Budgets::placeholder(), EngineParams::default());
        engine.adopt(&j.in_flight().unwrap()).unwrap();
        engine.ensure(spec("w", Class::D, abi::tag::POST_SEED), 10);
        engine.step(&port, &mut payers, Some(&j), 10).await;
        assert!(engine.pending.contains_key("w"));
        port.status_calls.lock().unwrap().clear();
        engine.poll(&port, Some(&j), 11).await;
        assert_eq!(
            *port.status_calls.lock().unwrap(),
            vec![2],
            "one read: the pending version and the orphan"
        );
        assert!(engine.care_unresolved());
        port.statuses.lock().unwrap().insert(
            care,
            Status {
                slot: 5,
                err: None,
                code: None,
            },
        );
        port.status_calls.lock().unwrap().clear();
        engine.poll(&port, Some(&j), 12).await;
        assert_eq!(*port.status_calls.lock().unwrap(), vec![2]);
        assert!(!engine.care_unresolved(), "the orphan's answer is used");
        assert!(engine.pending.contains_key("w"), "unknown stays pending");
        // A failed read is one error per poll, and nothing is resolved.
        port.fail_status_lookup
            .store(true, std::sync::atomic::Ordering::SeqCst);
        engine.poll(&port, Some(&j), 13).await;
        assert_eq!(engine.status_read_errors.1, 1);
        assert!(engine.pending.contains_key("w"));
    }

    #[tokio::test]
    async fn adopted_old_unknown_version_cannot_start_a_new_fee_budget() {
        let port = Script::default();
        let mut payers = payers();
        payers.refresh(&port, 0).await.unwrap();
        let journal = Journal::open(std::path::Path::new(":memory:")).unwrap();
        let mut before = Engine::new(Budgets::placeholder(), EngineParams::default());
        before.ensure(spec("old", Class::D, abi::tag::POST_SEED), 10);
        before.step(&port, &mut payers, Some(&journal), 10).await;
        let attempts = journal.in_flight().unwrap();
        assert_eq!(attempts.len(), 1);

        let late = 10 + EXPIRY_SLOTS + 1;
        let mut after = Engine::new(
            Budgets::placeholder(),
            EngineParams {
                max_versions: 1,
                ..EngineParams::default()
            },
        );
        after.adopt(&attempts).unwrap();
        assert!(after.ensure(spec("old", Class::D, abi::tag::POST_SEED), late));
        let report = after.step(&port, &mut payers, Some(&journal), late).await;
        assert_eq!(report.sent, 0);
        assert!(matches!(
            report.outcomes.as_slice(),
            [(key, Outcome::Unresolved { .. })] if key == "old"
        ));
        assert!(
            after.is_pending("old"),
            "the sealed write retains its budget"
        );
        assert!(!after.ensure(spec("old", Class::D, abi::tag::POST_SEED), late + 1));
        assert!(after.ensure(spec("other", Class::D, abi::tag::POST_SEED), late + 1));
        assert_eq!(journal.in_flight().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn adopted_different_write_ids_cannot_share_one_retry_budget() {
        let port = Script::default();
        let mut payers = payers();
        payers.refresh(&port, 0).await.unwrap();
        let journal = Journal::open(std::path::Path::new(":memory:")).unwrap();
        let mut before = Engine::new(Budgets::placeholder(), EngineParams::default());
        before.ensure(spec("same-key", Class::D, abi::tag::POST_SEED), 10);
        assert_eq!(
            before
                .step(&port, &mut payers, Some(&journal), 10)
                .await
                .sent,
            1
        );
        assert_eq!(
            before
                .step(&port, &mut payers, Some(&journal), 12)
                .await
                .sent,
            1
        );
        let mut attempts = journal.in_flight().unwrap();
        assert_eq!(attempts.len(), 2);
        attempts[1].write_id = Some("another-write".into());
        let mut after = Engine::new(Budgets::placeholder(), EngineParams::default());
        after.adopt(&attempts).unwrap();
        assert!(!after.ensure(spec("same-key", Class::D, abi::tag::POST_SEED), 13));
        assert!(after.ensure(spec("different-key", Class::D, abi::tag::POST_SEED), 13));
    }

    #[tokio::test]
    async fn adopted_old_unknown_version_retries_within_original_budget() {
        let port = Script::default();
        let mut payers = payers();
        payers.refresh(&port, 0).await.unwrap();
        let journal = Journal::open(std::path::Path::new(":memory:")).unwrap();
        let mut before = Engine::new(Budgets::placeholder(), EngineParams::default());
        before.ensure(spec("resume", Class::D, abi::tag::POST_SEED), 10);
        assert_eq!(
            before
                .step(&port, &mut payers, Some(&journal), 10)
                .await
                .sent,
            1
        );
        let attempts = journal.in_flight().unwrap();
        let first_fee = attempts[0].fee;

        let mut after = Engine::new(Budgets::placeholder(), EngineParams::default());
        after.adopt(&attempts).unwrap();
        let late = 10 + EXPIRY_SLOTS + 1;
        assert!(after.ensure(spec("resume", Class::D, abi::tag::POST_SEED), late));
        let result = after.step(&port, &mut payers, Some(&journal), late).await;
        assert_eq!(result.sent, 1);
        assert!(result.outcomes.is_empty());
        assert_eq!(after.pending["resume"].versions.len(), 2);
        assert_eq!(after.pending["resume"].versions[0].fee, first_fee);
        assert!(
            after.pending["resume"]
                .versions
                .iter()
                .map(|v| v.fee)
                .sum::<u64>()
                <= after.params.per_write_cap
        );
        assert_eq!(journal.in_flight().unwrap().len(), 2);
    }

    #[tokio::test]
    async fn orphan_status_before_first_plan_cannot_re_adopt_a_settled_signature() {
        let port = Script::default();
        let mut payers = payers();
        payers.refresh(&port, 0).await.unwrap();
        let journal = Journal::open(std::path::Path::new(":memory:")).unwrap();
        let mut before = Engine::new(Budgets::placeholder(), EngineParams::default());
        before.ensure(spec("restart", Class::W, abi::tag::REVEAL), 10);
        for slot in 10..12 {
            assert_eq!(
                before
                    .step(&port, &mut payers, Some(&journal), slot)
                    .await
                    .sent,
                1
            );
        }
        let versions = before.pending["restart"].versions.clone();
        let mut after = Engine::new(Budgets::placeholder(), EngineParams::default());
        after.adopt(&journal.in_flight().unwrap()).unwrap();

        port.statuses.lock().unwrap().insert(
            versions[0].sig,
            Status {
                slot: 12,
                err: Some("rejected".into()),
                code: Some(8),
            },
        );
        after.poll(&port, Some(&journal), 12).await;
        assert!(!after.ensure(spec("restart", Class::W, abi::tag::REVEAL), 12));
        assert!(after.held_replans.contains_key("restart"));

        port.statuses.lock().unwrap().insert(
            versions[1].sig,
            Status {
                slot: 13,
                err: Some("rejected".into()),
                code: Some(8),
            },
        );
        after.poll(&port, Some(&journal), 13).await;
        assert!(!after.held_replans.contains_key("restart"));
        assert!(after.ensure(spec("restart", Class::W, abi::tag::REVEAL), 13));
        assert!(after.pending["restart"].versions.is_empty());
        assert_eq!(
            after.stats["test"].fees_charged,
            versions.iter().map(|v| v.fee).sum::<u64>()
        );
    }

    #[tokio::test]
    async fn adopted_attempts_are_not_double_charged_as_orphans() {
        let port = Script::default();
        let mut payers = payers();
        payers.refresh(&port, 0).await.unwrap();
        let journal = Journal::open(std::path::Path::new(":memory:")).unwrap();
        let mut before = Engine::new(Budgets::placeholder(), EngineParams::default());
        before.ensure(spec("restarted", Class::W, abi::tag::REVEAL), 10);
        for slot in 10..12 {
            before.step(&port, &mut payers, Some(&journal), slot).await;
        }
        let attempts = journal.in_flight().unwrap();
        assert_eq!(attempts.len(), 2);
        let mut after = Engine::new(Budgets::placeholder(), EngineParams::default());
        after.adopt(&attempts).unwrap();
        after.ensure(spec("restarted", Class::W, abi::tag::REVEAL), 12);
        let versions = after.pending["restarted"].versions.clone();
        port.statuses.lock().unwrap().insert(
            versions[0].sig,
            Status {
                slot: 12,
                err: None,
                code: None,
            },
        );
        after.poll(&port, Some(&journal), 12).await;
        assert_eq!(after.stats["test"].fees_charged, versions[0].fee);
        port.statuses.lock().unwrap().insert(
            versions[1].sig,
            Status {
                slot: 13,
                err: Some("AlreadyDone".into()),
                code: Some(52),
            },
        );
        after.poll(&port, Some(&journal), 13).await;
        let want = versions[0].fee + versions[1].fee;
        assert_eq!(after.stats["test"].fees_charged, want);
        after.poll(&port, Some(&journal), 14).await;
        assert_eq!(after.stats["test"].fees_charged, want);

        // Keeper polls before its duties call ensure. An adopted signature
        // may therefore be observed as an orphan first, then as a write.
        let mut orphan_first = Engine::new(Budgets::placeholder(), EngineParams::default());
        orphan_first.adopt(&attempts).unwrap();
        orphan_first.poll(&port, None, 14).await;
        assert_eq!(orphan_first.stats["test"].fees_charged, want);
        orphan_first.ensure(spec("restarted", Class::W, abi::tag::REVEAL), 15);
        orphan_first.poll(&port, None, 15).await;
        assert_eq!(orphan_first.stats["test"].fees_charged, want);

        // A status found during Keeper::start is resolved before adoption.
        // It still belongs in this process's fee total.
        let mut startup = Engine::new(Budgets::placeholder(), EngineParams::default());
        startup.charge_recovered(&attempts[0]);
        assert_eq!(startup.stats["test"].fees_charged, attempts[0].fee);
    }

    #[test]
    fn bids_double_per_slot_to_the_class_cap() {
        let p = EngineParams::default();
        let w: Vec<u64> = (0..5).map(|s| p.bid(Class::W, s)).collect();
        assert_eq!(w, vec![433, 866, 1_732, 2_000, 2_000]);
        let d: Vec<u64> = (0..5).map(|s| p.bid(Class::D, s)).collect();
        assert_eq!(d, vec![100, 200, 400, 500, 500]);
        assert_eq!(p.bid(Class::N, 9), 100);
        let capped = EngineParams {
            p_def_milli: 1_500,
            ..p
        };
        assert_eq!(capped.bid(Class::W, 9), 1_500, "season defence cap");
    }

    /// Nothing lands: one version per slot, each from a newly drawn payer
    /// with a new signature, priorities ×2 per slot to P_def, contested
    /// after 2 slots at ≥ p_tip, then the spend cap stops new versions.
    #[tokio::test]
    async fn unlanded_w_write_escalates_with_new_payers() {
        let port = Script::default();
        let mut payers = payers();
        payers.refresh(&port, 0).await.unwrap();
        let mut e = Engine::new(Budgets::placeholder(), EngineParams::default());
        let j = Journal::open(std::path::Path::new(":memory:")).unwrap();
        assert!(e.ensure(spec("w", Class::W, abi::tag::REVEAL), 10));
        assert!(
            !e.ensure(spec("w", Class::W, abi::tag::REVEAL), 10),
            "deduplicated"
        );
        let mut contested = vec![];
        for s in 10..16 {
            let r = e.step(&port, &mut payers, Some(&j), s).await;
            assert_eq!(r.sent, 1, "one version per slot");
            contested.extend(r.contested);
            // A second step in the same slot sends nothing.
            assert_eq!(e.step(&port, &mut payers, Some(&j), s).await.sent, 0);
        }
        let sent = port.sent.lock().unwrap().clone();
        let pr: Vec<u64> = sent.iter().map(priority_of).collect();
        for w in pr.windows(2) {
            assert!(w[1] >= w[0], "never lower: {pr:?}");
        }
        assert!((430..=436).contains(&pr[0]), "starts at p_tip: {pr:?}");
        assert!((1_990..=2_010).contains(&pr[5]), "ends at P_def: {pr:?}");
        let sigs: std::collections::HashSet<_> = sent.iter().map(tx::signature).collect();
        assert_eq!(sigs.len(), 6, "a new signature per version");
        let pool = payers.reveal.addresses();
        assert!(sent
            .iter()
            .all(|t| pool.contains(&t.message.account_keys[0])));
        assert_eq!(contested.len(), 1, "contested once");
        assert_eq!(j.in_flight().unwrap().len(), 6);
        // Spend cap: a tiny cap stops new versions after the first.
        let mut e2 = Engine::new(
            Budgets::placeholder(),
            EngineParams {
                per_write_cap: 1,
                ..EngineParams::default()
            },
        );
        e2.ensure(spec("w2", Class::W, abi::tag::REVEAL), 0);
        let n: usize = {
            let mut n = 0;
            for s in 0..5 {
                n += e2.step(&port, &mut payers, None, s).await.sent;
            }
            n
        };
        assert_eq!(n, 1);
    }

    /// The first version fails ComputationalBudgetExceeded, the second a
    /// heap fault; the third (1.4M-limit rung ladder + heap frame) lands.
    #[tokio::test]
    async fn cu_and_heap_retry_ladder() {
        let port = Script::default();
        let calls = std::sync::atomic::AtomicU32::new(0);
        let calls = Arc::new(calls);
        let c2 = calls.clone();
        *port.answer.lock().unwrap() = Box::new(move |t| {
            let n = c2.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            let b = tx::parse_budget(&t.message);
            Some(match n {
                0 => {
                    // The table's ResolveFromInputs budget (290,000 with
                    // Phase B, W6-B; was 340,000).
                    assert_eq!(b.cu_limit, Some(290_000));
                    Status {
                        slot: 1,
                        err: Some("InstructionError(3, ComputationalBudgetExceeded)".into()),
                        code: None,
                    }
                }
                1 => {
                    assert_eq!(b.cu_limit, Some(580_000));
                    assert_eq!(b.heap, None);
                    Status {
                        slot: 2,
                        err: Some("InstructionError(3, ProgramFailedToComplete)".into()),
                        code: None,
                    }
                }
                _ => {
                    assert_eq!(b.cu_limit, Some(580_000));
                    assert_eq!(b.heap, Some(262_144));
                    Status {
                        slot: 3,
                        err: None,
                        code: None,
                    }
                }
            })
        });
        let mut payers = payers();
        payers.refresh(&port, 0).await.unwrap();
        let mut e = Engine::new(Budgets::placeholder(), EngineParams::default());
        e.ensure(spec("r", Class::D, abi::tag::RESOLVE_FROM_INPUTS), 0);
        let mut ladder = vec![];
        let mut landed = None;
        for s in 0..6 {
            let r = e.step(&port, &mut payers, None, s).await;
            ladder.extend(r.ladder);
            for (_, o) in r.outcomes {
                landed = Some(o);
            }
        }
        assert_eq!(
            ladder.iter().map(|l| (l.1, l.2)).collect::<Vec<_>>(),
            vec![(580_000, None), (580_000, Some(262_144))]
        );
        assert!(matches!(landed, Some(Outcome::Landed { versions: 3, .. })));
        assert_eq!(Budgets::retry_cu(680_000), 1_360_000);
        assert_eq!(Budgets::retry_cu(1_360_000), abi::CU_MAX);
    }

    /// v1.7 (wave-4 review): a SkipQuiet that runs out of CU within its
    /// gate is `NotQuiet` for the duty (one version, no ladder step), so the
    /// keeper gathers and resolves the bell instead.
    #[tokio::test]
    async fn skip_quiet_out_of_cu_is_not_quiet() {
        let port = Script::default();
        *port.answer.lock().unwrap() = Box::new(|_| {
            Some(Status {
                slot: 1,
                err: Some("InstructionError(2, ComputationalBudgetExceeded)".into()),
                code: None,
            })
        });
        let mut payers = payers();
        payers.refresh(&port, 0).await.unwrap();
        let mut e = Engine::new(Budgets::placeholder(), EngineParams::default());
        let j = Journal::open(std::path::Path::new(":memory:")).unwrap();
        e.ensure(spec("skip:3,0:10:24", Class::D, abi::tag::SKIP_QUIET), 0);
        let mut out = None;
        let mut ladder = vec![];
        for s in 0..4 {
            let r = e.step(&port, &mut payers, Some(&j), s).await;
            ladder.extend(r.ladder);
            if let Some((_, o)) = r.outcomes.into_iter().next() {
                out = Some(o);
                break;
            }
        }
        assert!(ladder.is_empty(), "no ladder step");
        assert!(
            matches!(out, Some(Outcome::Failed { code: Some(c), .. }) if c == err::NOT_QUIET),
            "{out:?}"
        );
    }

    /// A write held past its version cap stays sealed in the pending queue;
    /// an unknown old signature must keep its fee budget from being reset.
    /// Once all old outcomes become known, the key may re-plan.
    #[tokio::test]
    async fn capped_write_whose_versions_expired_ends_and_restarts() {
        let port = Script::default();
        let mut payers = payers();
        payers.refresh(&port, 0).await.unwrap();
        let mut e = Engine::new(
            Budgets::placeholder(),
            EngineParams {
                max_versions: 3,
                ..EngineParams::default()
            },
        );
        let j = Journal::open(std::path::Path::new(":memory:")).unwrap();
        assert!(e.ensure(spec("a", Class::D, abi::tag::POST_ANCHOR), 0));
        let mut ended = None;
        let mut sent = 0;
        let mut end_slot = 0;
        for s in 0..200 {
            let r = e.step(&port, &mut payers, Some(&j), s).await;
            sent += r.sent;
            if let Some((_, o)) = r.outcomes.into_iter().next() {
                ended = Some(o);
                end_slot = s;
                break;
            }
        }
        assert_eq!(sent, 3, "the version cap");
        // D versions at slots 0, 2 and 4 (the resend cadence, W6-C).
        assert_eq!(end_slot, 4 + EXPIRY_SLOTS + 1, "retry window ends");
        assert!(matches!(ended, Some(Outcome::Unresolved { .. })));
        assert_eq!(e.stats["test"].failed, 0);
        assert!(e.is_pending("a"));
        assert!(
            !e.ensure(spec("a", Class::D, abi::tag::POST_ANCHOR), end_slot),
            "unresolved old signatures hold this key"
        );
        assert!(e.pending["a"].provisional.is_some());
        assert!(
            !e.ensure(spec("a", Class::D, abi::tag::POST_ANCHOR), end_slot + 2),
            "unknown old versions must not reset the fee cap"
        );
        let old = j.in_flight().unwrap();
        assert_eq!(old.len(), 3);
        for attempt in &old {
            port.statuses.lock().unwrap().insert(
                attempt.sig.parse().unwrap(),
                Status {
                    slot: end_slot + 2,
                    err: Some("OutOfOrder".into()),
                    code: Some(8),
                },
            );
        }
        let final_result = e.poll(&port, Some(&j), end_slot + 2).await;
        assert!(
            matches!(final_result.outcomes.as_slice(), [(key, Outcome::Failed { .. })]
            if key == "a")
        );
        assert!(!e.is_pending("a"));
        assert!(j.in_flight().unwrap().is_empty());
        assert_eq!(
            e.stats["test"].fees_charged,
            old.iter().map(|a| a.fee).sum::<u64>()
        );
        // The hold ends: the next version lands, and the escalation restarts.
        *port.answer.lock().unwrap() = Box::new(|_| {
            Some(Status {
                slot: 400,
                err: None,
                code: None,
            })
        });
        assert!(e.ensure(spec("a", Class::D, abi::tag::POST_ANCHOR), end_slot + 4));
        let mut landed = false;
        for s in end_slot + 4..end_slot + 8 {
            for (_, o) in e.step(&port, &mut payers, Some(&j), s).await.outcomes {
                landed |= matches!(o, Outcome::Landed { versions: 1, .. });
            }
        }
        assert!(landed, "the re-planned write lands with its first version");
        let last = port.sent.lock().unwrap().last().map(priority_of).unwrap();
        assert!(
            (95..=105).contains(&last),
            "a fresh escalation starts low: {last}"
        );
    }

    /// A keeper may miss many slots while still below its existing spend
    /// and version caps. Slot age alone must not strand this idempotent
    /// program write or open a fresh budget: it can send another version
    /// in the same Pending after it resumes.
    #[tokio::test]
    async fn old_unknown_write_retries_within_its_existing_budget() {
        let port = Script::default();
        let mut payers = payers();
        payers.refresh(&port, 0).await.unwrap();
        let mut e = Engine::new(
            Budgets::placeholder(),
            EngineParams {
                max_versions: 3,
                ..EngineParams::default()
            },
        );
        let j = Journal::open(std::path::Path::new(":memory:")).unwrap();
        assert!(e.ensure(spec("gap", Class::D, abi::tag::POST_ANCHOR), 0));
        assert_eq!(e.step(&port, &mut payers, Some(&j), 0).await.sent, 1);
        let first_fee = e.pending["gap"].versions[0].fee;

        let later = e.step(&port, &mut payers, Some(&j), EXPIRY_SLOTS + 2).await;
        assert_eq!(later.sent, 1, "remaining budget permits another version");
        assert!(later.outcomes.is_empty());
        assert_eq!(e.pending["gap"].versions.len(), 2);
        assert_eq!(e.pending["gap"].versions[0].fee, first_fee);
        assert!(
            e.pending["gap"].versions.iter().map(|v| v.fee).sum::<u64>() <= e.params.per_write_cap
        );
        assert_eq!(j.in_flight().unwrap().len(), 2);
    }

    #[tokio::test]
    async fn old_unknown_write_does_not_retry_when_fee_budget_is_used() {
        let port = Script::default();
        let mut payers = payers();
        payers.refresh(&port, 0).await.unwrap();
        let mut e = Engine::new(Budgets::placeholder(), EngineParams::default());
        let j = Journal::open(std::path::Path::new(":memory:")).unwrap();
        assert!(e.ensure(spec("capped", Class::D, abi::tag::POST_ANCHOR), 0));
        assert_eq!(e.step(&port, &mut payers, Some(&j), 0).await.sent, 1);
        e.params.per_write_cap = e.pending["capped"].versions[0].fee;

        let later = e.step(&port, &mut payers, Some(&j), EXPIRY_SLOTS + 2).await;
        assert_eq!(later.sent, 0);
        assert!(matches!(
            later.outcomes.as_slice(),
            [(_, Outcome::Unresolved { .. })]
        ));
        assert_eq!(e.stats["test"].versions, 1);
        assert!(!e.ensure(
            spec("capped", Class::D, abi::tag::POST_ANCHOR),
            EXPIRY_SLOTS + 3
        ));
        assert_eq!(j.in_flight().unwrap().len(), 1);
    }

    /// W6-C (W5-B F4): a D write whose version is in flight gets the next
    /// one 2 slots later while its bid rises and every 16 slots at P_delay;
    /// an N write (fixed bid) every 16 slots; a W write every slot. A held
    /// SkipQuiet therefore leaves a handful of losing versions, not one per
    /// slot of the hold, and contested detection still runs every slot.
    #[tokio::test]
    async fn d_and_n_writes_resend_on_their_cadence() {
        let port = Script::default();
        let mut payers = payers();
        payers.refresh(&port, 0).await.unwrap();
        let mut e = Engine::new(Budgets::placeholder(), EngineParams::default());
        e.ensure(spec("skip:1,0:5:3", Class::D, abi::tag::SKIP_QUIET), 0);
        e.ensure(spec("close:x", Class::N, abi::tag::SKIP_QUIET), 0);
        e.ensure(spec("reveal:1:2", Class::W, abi::tag::REVEAL), 0);
        let mut at: BTreeMap<String, Vec<u64>> = BTreeMap::new();
        let mut contested = vec![];
        for s in 0..40 {
            let before = port.sent.lock().unwrap().len();
            let r = e.step(&port, &mut payers, None, s).await;
            contested.extend(r.contested.into_iter().map(|c| c.2));
            let sent = port.sent.lock().unwrap()[before..].to_vec();
            for t in sent {
                // W draws from the reveal pool; D and N share the delay pool.
                let payer = t.message.account_keys[0];
                let k = if payers.reveal.addresses().contains(&payer) {
                    "W"
                } else {
                    "DN"
                };
                at.entry(k.into()).or_default().push(s);
            }
        }
        assert_eq!(at["W"], (0..40).collect::<Vec<u64>>(), "W: every slot");
        let dn = &at["DN"];
        // D: 0, 2, 4 (bids 100, 400, 500), then 20, 36 at the cap;
        // N: 0, 16, 32.
        let mut want = vec![0, 0, 2, 4, 16, 20, 32, 36];
        want.sort_unstable();
        assert_eq!(dn, &want, "D and N versions on the cadence");
        assert!(
            contested.iter().any(|k| k == "skip:1,0:5:3"),
            "a D write at a bid ≥ p_tip is still marked contested: {contested:?}"
        );
    }

    /// W6-C: a keeper tick that runs late (the chain two slots past the
    /// slot the tick read) sends its version in a later slot; the cadence
    /// counts from that slot, so the next tick does not send a second
    /// version that the first would beat into the same block.
    #[tokio::test]
    async fn the_cadence_counts_from_the_slot_the_version_went_out_in() {
        use std::sync::atomic::Ordering;
        let port = Script::default();
        let mut payers = payers();
        payers.refresh(&port, 0).await.unwrap();
        let mut e = Engine::new(Budgets::placeholder(), EngineParams::default());
        e.ensure(spec("skip:1,0:5:3", Class::D, abi::tag::SKIP_QUIET), 10);
        let mut sent = vec![];
        for s in 10..40u64 {
            // Every tick reads slot s but sends when the chain is at s + 2.
            port.clock_slot.store(s + 2, Ordering::SeqCst);
            if e.step(&port, &mut payers, None, s).await.sent > 0 {
                sent.push(s);
            }
        }
        // Chain slots 12 (bid 100), 16 (bid 500, the cap), then 16 + 16;
        // counted from the tick's slot it would have been 10, 12, 14, 30.
        assert_eq!(
            sent,
            vec![10, 14, 32],
            "from the chain's slot, not the tick's"
        );
    }

    /// A D write whose version is known to have failed (a program refusal
    /// the ladder answers) is followed at once; the cadence only waits on
    /// versions in flight.
    #[tokio::test]
    async fn a_known_failure_is_followed_at_once() {
        let port = Script::default();
        *port.answer.lock().unwrap() = Box::new(|_| {
            Some(Status {
                slot: 1,
                err: Some("InstructionError(3, ComputationalBudgetExceeded)".into()),
                code: None,
            })
        });
        let mut payers = payers();
        payers.refresh(&port, 0).await.unwrap();
        let mut e = Engine::new(Budgets::placeholder(), EngineParams::default());
        e.ensure(spec("r", Class::D, abi::tag::RESOLVE_FROM_INPUTS), 0);
        let mut sent = vec![];
        for s in 0..3 {
            if e.step(&port, &mut payers, None, s).await.sent > 0 {
                sent.push(s);
            }
        }
        assert_eq!(
            sent,
            vec![0, 1, 2],
            "the ladder's next rung goes out at once"
        );
    }

    /// W6T-2 (w6-s7: 25,655 CloseArrivalDay and 3,000 CloseArrivalSlot
    /// versions failed in the drain): the localnet reports running out of
    /// compute as `ProgramFailedToComplete` ("exceeded CUs meter", units
    /// consumed = the limit). That is CU exhaustion: the next version climbs
    /// the CU ladder. Before, it took the heap rung (more CU spent, never
    /// enough) and then ended Dead. A fault below the limit with no meter
    /// log is still the heap rung.
    #[tokio::test]
    async fn cu_meter_pftc_climbs_cu_not_heap() {
        let budgets =
            Budgets::from_json(&serde_json::from_str(crate::CANONICAL_BUDGETS).unwrap()).unwrap();
        let limit = budgets.get(abi::tag::CLOSE_ARRIVAL_DAY).cu_limit;
        for ((units, meter), want) in [
            ((limit as u64, false), (Budgets::retry_cu(limit), None)),
            ((limit as u64 - 450, true), (Budgets::retry_cu(limit), None)),
            ((1_200, false), (limit, Some(abi::HEAP_FRAME_RETRY))),
        ] {
            let port = Script::default();
            let n = Arc::new(std::sync::atomic::AtomicU64::new(0));
            let n2 = n.clone();
            *port.answer.lock().unwrap() = Box::new(move |_| {
                let k = n2.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                Some(Status {
                    slot: 1 + k,
                    err: (k == 0)
                        .then(|| r#"{"InstructionError":[3,"ProgramFailedToComplete"]}"#.into()),
                    code: None,
                })
            });
            let mut payers = payers();
            payers.refresh(&port, 0).await.unwrap();
            let mut e = Engine::new(budgets.clone(), EngineParams::default());
            e.ensure(
                spec("close:day:1,2:6", Class::N, abi::tag::CLOSE_ARRIVAL_DAY),
                0,
            );
            e.step(&port, &mut payers, None, 0).await;
            let sig = tx::signature(&port.sent.lock().unwrap()[0]);
            e.note_tx_meta(sig, units, meter);
            let mut landed = false;
            for s in 1..4 {
                for (_, o) in e.step(&port, &mut payers, None, s).await.outcomes {
                    landed |= matches!(o, Outcome::Landed { .. });
                }
            }
            let sent = port.sent.lock().unwrap().clone();
            assert!(sent.len() >= 2, "a second version");
            let b = tx::parse_budget(&sent[1].message);
            assert_eq!(
                (b.cu_limit, b.heap),
                (Some(want.0), want.1),
                "units {units}, meter log {meter}"
            );
            assert!(landed);
        }
    }

    /// AlreadyDone (52) is success; WindowClosed and NotImplemented end the
    /// write; another code is a failure with a backoff.
    #[tokio::test]
    async fn codes_end_writes_as_the_keeper_mapping_says() {
        for (code, want) in [(52u32, "landed"), (12, "dead"), (99, "dead"), (8, "failed")] {
            let port = Script::default();
            *port.answer.lock().unwrap() = Box::new(move |_| {
                Some(Status {
                    slot: 5,
                    err: Some(format!("InstructionError(3, Custom({code}))")),
                    code: Some(code),
                })
            });
            let mut payers = payers();
            payers.refresh(&port, 0).await.unwrap();
            let mut e = Engine::new(Budgets::placeholder(), EngineParams::default());
            e.ensure(spec("x", Class::D, abi::tag::POST_SEED), 0);
            let mut out = None;
            for s in 0..3 {
                for (_, o) in e.step(&port, &mut payers, None, s).await.outcomes {
                    out = Some(o);
                }
            }
            let got = match out.unwrap() {
                Outcome::Landed { already_done, .. } => {
                    assert!(already_done);
                    "landed"
                }
                Outcome::Dead { .. } => "dead",
                Outcome::Failed { code, .. } => {
                    assert_eq!(code, Some(8));
                    assert!(
                        !e.ensure(spec("x", Class::D, abi::tag::POST_SEED), 2),
                        "backoff"
                    );
                    assert!(e.ensure(spec("x", Class::D, abi::tag::POST_SEED), 4));
                    "failed"
                }
                Outcome::Unresolved { .. } => panic!("a known refusal is not unresolved"),
            };
            assert_eq!(got, want, "code {code}");
        }
        // NoTicket (23) ends a SettleTicket as done, and only a SettleTicket.
        assert!(err::is_done(abi::tag::SETTLE_TICKET, 23));
        assert!(!err::is_done(abi::tag::POST_SEED, 23));
        assert!(err::is_done(abi::tag::POST_SEED, 52));
    }

    // ---- fix-keeper-backoff: the refusal hold and the group breaker ----

    const BAD_PROGRAM: [u8; 32] = [0xba; 32];
    const BAD_ACCOUNT: u32 = frontier_abi::error::FrontierError::BadAccount.code();

    /// A spec of `kind` whose instruction goes to `program` with `data`
    /// (the Script refuses every transaction naming [`BAD_PROGRAM`]).
    fn marked(key: &str, kind: &'static str, program: [u8; 32], data: u8) -> WriteSpec {
        WriteSpec {
            kind,
            build: Arc::new(move |c: &BuildCtx| {
                vec![Instruction {
                    program_id: Address::new_from_array(program),
                    accounts: vec![solana_instruction::AccountMeta::new(c.payer, true)],
                    data: vec![data],
                }]
            }),
            ..spec(key, Class::D, abi::tag::POST_SEED)
        }
    }

    fn names(t: &fclient::Transaction, program: [u8; 32]) -> bool {
        t.message
            .account_keys
            .contains(&Address::new_from_array(program))
    }

    /// The program refuses [`BAD_PROGRAM`] with `code` (`None`: lands).
    fn refusing(port: &Script, code: Arc<Mutex<Option<u32>>>) {
        *port.answer.lock().unwrap() = Box::new(move |t| {
            let c = *code.lock().unwrap();
            Some(match c.filter(|_| names(t, BAD_PROGRAM)) {
                Some(c) => Status {
                    slot: 1,
                    err: Some(format!("InstructionError(2, Custom({c}))")),
                    code: Some(c),
                },
                None => Status {
                    slot: 1,
                    err: None,
                    code: None,
                },
            })
        });
    }

    fn sends_naming(port: &Script, program: [u8; 32]) -> usize {
        port.sent
            .lock()
            .unwrap()
            .iter()
            .filter(|t| names(t, program))
            .count()
    }

    /// One keeper pass as `Keeper::tick` runs it: begin, poll, plan, send.
    async fn pass(
        e: &mut Engine,
        port: &Script,
        payers: &mut Payers,
        slot: u64,
        plan: &mut dyn FnMut(&mut Engine, u64),
    ) -> StepReport {
        e.begin_pass(slot);
        let mut r = e.poll(port, None, slot).await;
        plan(e, slot);
        e.send(port, payers, None, slot, &mut r).await;
        r
    }

    fn backoff_params(max_slots: u64, max_passes: u64, group_min: u32) -> EngineParams {
        EngineParams {
            refusal_max_slots: max_slots,
            refusal_max_passes: max_passes,
            refusal_group_min: group_min,
            ..EngineParams::default()
        }
    }

    /// D-dress-8: a write the program keeps refusing (BadAccount) goes out
    /// at gaps 3, 5, 9, 17, 33, then every `refusal_max_slots + 1`, while a
    /// healthy duty planning one new write every pass lands every pass.
    #[tokio::test]
    async fn refused_write_backs_off_while_healthy_writes_keep_cadence() {
        let port = Script::default();
        refusing(&port, Arc::new(Mutex::new(Some(BAD_ACCOUNT))));
        let mut payers = payers();
        payers.refresh(&port, 0).await.unwrap();
        let mut e = Engine::new(Budgets::placeholder(), backoff_params(64, 0, 0));
        let mut bad_slots = vec![];
        let mut healthy_landed = 0;
        for s in 0..400u64 {
            let before = sends_naming(&port, BAD_PROGRAM);
            let r = pass(&mut e, &port, &mut payers, s, &mut |e, s| {
                e.ensure(marked("archive:3:1:144", "archive", BAD_PROGRAM, 1), s);
                e.ensure(marked(&format!("ok:{s}"), "resolve", [7; 32], 1), s);
            })
            .await;
            if sends_naming(&port, BAD_PROGRAM) > before {
                bad_slots.push(s);
            }
            healthy_landed += r
                .outcomes
                .iter()
                .filter(|(k, o)| k.starts_with("ok:") && matches!(o, Outcome::Landed { .. }))
                .count();
        }
        let gaps: Vec<u64> = bad_slots.windows(2).map(|w| w[1] - w[0]).collect();
        assert_eq!(&gaps[..6], &[3, 5, 9, 17, 33, 65], "gaps {gaps:?}");
        assert!(gaps[5..].iter().all(|&g| g == 65), "capped: {gaps:?}");
        // (Before: the same doubling but capped at 1,024 slots for every
        // code; the cap is now `refusal_max_slots`, 9,000 by default, 64 here.)
        assert_eq!(bad_slots.len(), 11, "{bad_slots:?}");
        assert_eq!(
            healthy_landed, 399,
            "every pass's healthy write landed the next pass"
        );
        let r = &e.refusals()["archive:3:1:144"];
        assert_eq!((r.code, r.count), (Some(BAD_ACCOUNT), 11));
        assert!(r.suppressed > 300);
        assert_eq!(e.stats["archive"].refused, 11);
        assert_eq!(e.stats["archive"].suppressed, r.suppressed);
        assert_eq!(e.stats["resolve"].refused, 0);
        assert_eq!(e.stats["resolve"].suppressed, 0);
    }

    /// One devnet day of a permanently refused, unchanging write: 216,000
    /// slots, a keeper pass every 45 slots (devnet-dress-rehearsal run4's
    /// ticks). The old schedule (every code: at most 1,024 slots) resends
    /// it 208 times; the keeper.toml defaults (9,000 slots, 64 passes) 34
    /// (13 while the hold doubles, then one an hour).
    #[tokio::test]
    async fn a_devnet_day_of_one_refused_write() {
        let mut got = vec![];
        for params in [backoff_params(1_024, 0, 0), backoff_params(9_000, 64, 4)] {
            let port = Script::default();
            refusing(&port, Arc::new(Mutex::new(Some(BAD_ACCOUNT))));
            let mut payers = payers();
            payers.refresh(&port, 0).await.unwrap();
            let mut e = Engine::new(Budgets::placeholder(), params);
            for s in (0..216_000u64).step_by(45) {
                pass(&mut e, &port, &mut payers, s, &mut |e, s| {
                    e.ensure(marked("archive:0:0:0", "archive", BAD_PROGRAM, 1), s);
                })
                .await;
            }
            got.push(sends_naming(&port, BAD_PROGRAM));
        }
        println!("a devnet day, old schedule vs defaults: {got:?} sends");
        assert!((195..=215).contains(&got[0]), "old schedule: {got:?}");
        assert!((28..=40).contains(&got[1]), "defaults: {got:?}");
    }

    /// On a paced RPC one pass spans ~100 slots: the pass gate still
    /// doubles (1, 2, 4, 8 passes, capped).
    #[tokio::test]
    async fn pass_gate_holds_when_each_pass_spans_many_slots() {
        let port = Script::default();
        refusing(&port, Arc::new(Mutex::new(Some(BAD_ACCOUNT))));
        let mut payers = payers();
        payers.refresh(&port, 0).await.unwrap();
        let mut e = Engine::new(Budgets::placeholder(), backoff_params(9_000, 8, 0));
        let mut bad_passes = vec![];
        for n in 0..60u64 {
            let before = sends_naming(&port, BAD_PROGRAM);
            pass(&mut e, &port, &mut payers, n * 100, &mut |e, s| {
                e.ensure(marked("k", "archive", BAD_PROGRAM, 1), s);
            })
            .await;
            if sends_naming(&port, BAD_PROGRAM) > before {
                bad_passes.push(n);
            }
        }
        let gaps: Vec<u64> = bad_passes.windows(2).map(|w| w[1] - w[0]).collect();
        // Slot waits (2 << n, under 800 slots = 8 passes until n = 9) never
        // bind here: the pass gate alone gives 2, 3, 5, 9, then its cap 8 + 1.
        assert_eq!(&gaps[..4], &[2, 3, 5, 9], "gaps {gaps:?}");
        assert!(gaps.iter().skip(3).all(|&g| g == 9), "gaps {gaps:?}");
        assert_eq!(bad_passes.len(), 9, "{bad_passes:?}");
    }

    /// The duty planning a different instruction for the held key (the
    /// state it read changed) sends it at once (the streak goes on if it is
    /// refused the same way); a success ends hold and streak; the same
    /// instruction stays held.
    #[tokio::test]
    async fn state_change_or_success_ends_the_hold() {
        let port = Script::default();
        let code = Arc::new(Mutex::new(Some(BAD_ACCOUNT)));
        refusing(&port, code.clone());
        let mut payers = payers();
        payers.refresh(&port, 0).await.unwrap();
        let mut e = Engine::new(Budgets::placeholder(), backoff_params(9_000, 64, 0));
        for s in 0..40u64 {
            pass(&mut e, &port, &mut payers, s, &mut |e, s| {
                e.ensure(marked("k", "archive", BAD_PROGRAM, 1), s);
            })
            .await;
        }
        let held = e.refusals()["k"].clone();
        assert!(held.count >= 4 && e.refusal_held(&held, 40), "{held:?}");
        assert!(
            !e.ensure(marked("k", "archive", BAD_PROGRAM, 1), 40),
            "same write: held"
        );
        assert!(
            e.ensure(marked("k", "archive", BAD_PROGRAM, 2), 40),
            "new instruction: released"
        );
        assert_eq!(e.refusal_resets, 1);
        assert!(!e.refusal_held(&e.refusals()["k"], 40));
        // Refused the same way again: the streak goes on (no 2-slot ramp
        // per change), and the new instruction is held.
        let mut r = StepReport::default();
        e.send(&port, &mut payers, None, 40, &mut r).await;
        e.begin_pass(41);
        e.poll(&port, None, 41).await;
        let again = e.refusals()["k"].clone();
        assert_eq!(again.count, held.count + 1);
        assert!(e.refusal_held(&again, 41));
        assert!(!e.ensure(marked("k", "archive", BAD_PROGRAM, 2), 41));
        // The cause is fixed and the duty plans again (a changed instruction
        // goes out at once): the landing clears hold and streak.
        *code.lock().unwrap() = None;
        for s in 43..60u64 {
            pass(&mut e, &port, &mut payers, s, &mut |e, s| {
                e.ensure(marked("k", "archive", BAD_PROGRAM, 3), s);
            })
            .await;
        }
        assert!(!e.refusals().contains_key("k"));
        assert!(e.stats["archive"].landed >= 1);
    }

    /// Transient codes (NoAnchor …), a payer short of lamports and a
    /// deadline keep the old behaviour: no refusal hold.
    #[tokio::test]
    async fn transient_refusals_keep_the_short_backoff() {
        for (code, err_text) in [
            (
                Some(err::NO_ANCHOR),
                "InstructionError(2, Custom(NoAnchor))",
            ),
            (
                Some(err::NOT_GATHERED),
                "InstructionError(2, Custom(NotGathered))",
            ),
            (None, "InsufficientFundsForRent { account_index: 1 }"),
        ] {
            let port = Script::default();
            *port.answer.lock().unwrap() = Box::new(move |_| {
                Some(Status {
                    slot: 1,
                    err: Some(err_text.into()),
                    code,
                })
            });
            let mut payers = payers();
            payers.refresh(&port, 0).await.unwrap();
            let mut e = Engine::new(Budgets::placeholder(), backoff_params(9_000, 64, 1));
            for s in 0..20u64 {
                pass(&mut e, &port, &mut payers, s, &mut |e, s| {
                    e.ensure(spec("t", Class::D, abi::tag::POST_SEED), s);
                })
                .await;
            }
            assert!(e.refusals().is_empty(), "{code:?}");
            assert!(e.refusal_groups().is_empty(), "{code:?}");
            assert_eq!(e.stats["test"].refused, 0);
            // Old schedule: gaps 3, 5, 9 → sends at 0, 3, 8, 17.
            assert_eq!(port.sent.lock().unwrap().len(), 4, "{code:?}");
        }
        assert!(refusal_of(&Outcome::Dead {
            reason: "deadline".into(),
            code: None
        })
        .is_none());
        // verify-pr192: the version/fee cap's provisional outcome (it wins
        // over a late status's real code) is not a refusal.
        assert!(refusal_of(&Outcome::Failed {
            code: None,
            err: format!("3 {RETRY_WINDOW_UNRESOLVED} (cap 3 versions, 20000000 lamports)"),
            slot: 9
        })
        .is_none());
        assert_eq!(
            refusal_of(&Outcome::Dead {
                reason: "WindowClosed".into(),
                code: Some(err::WINDOW_CLOSED)
            }),
            Some(Some(err::WINDOW_CLOSED))
        );
        assert_eq!(
            refusal_of(&Outcome::Dead {
                reason: "compute budget exceeded at 1.4M".into(),
                code: None
            }),
            Some(None)
        );
    }

    /// A Dead end (WindowClosed) used to be re-planned at once, every pass;
    /// now it is held like a Failed refusal.
    #[tokio::test]
    async fn dead_writes_are_held_too() {
        let port = Script::default();
        refusing(&port, Arc::new(Mutex::new(Some(err::WINDOW_CLOSED))));
        let mut payers = payers();
        payers.refresh(&port, 0).await.unwrap();
        let mut e = Engine::new(Budgets::placeholder(), backoff_params(64, 0, 0));
        for s in 0..100u64 {
            pass(&mut e, &port, &mut payers, s, &mut |e, s| {
                e.ensure(marked("close:1:2", "close", BAD_PROGRAM, 1), s);
            })
            .await;
        }
        assert_eq!(
            sends_naming(&port, BAD_PROGRAM),
            6,
            "0, 3, 8, 17, 34, 67 (before: no hold on Dead, 100 = every pass)"
        );
        assert_eq!(e.stats["close"].dead, 6);
        assert_eq!(e.refusals()["close:1:2"].code, Some(err::WINDOW_CLOSED));
    }

    /// The group breaker: an archive duty planning a new batch every pass,
    /// every one refused BadAccount (the rehearsal's 2,489). After 4 keys
    /// the kind sends one probe at a time at doubling gaps; another kind
    /// keeps landing every pass; once the probe lands the kind flows again.
    #[tokio::test]
    async fn group_breaker_probes_one_key_and_reopens_on_success() {
        let port = Script::default();
        let code = Arc::new(Mutex::new(Some(BAD_ACCOUNT)));
        refusing(&port, code.clone());
        let mut payers = payers();
        payers.refresh(&port, 0).await.unwrap();
        let mut e = Engine::new(Budgets::placeholder(), backoff_params(256, 0, 4));
        let mut healthy = 0;
        let mut plan = |e: &mut Engine, s: u64| {
            // Every archive batch ever planned so far is re-planned.
            for b in 0..=s.min(300) {
                e.ensure(
                    marked(&format!("archive:{b}"), "archive", BAD_PROGRAM, b as u8),
                    s,
                );
            }
            e.ensure(marked(&format!("ok:{s}"), "resolve", [7; 32], 1), s);
        };
        for s in 0..300u64 {
            let r = pass(&mut e, &port, &mut payers, s, &mut plan).await;
            healthy += r
                .outcomes
                .iter()
                .filter(|(k, _)| k.starts_with("ok:"))
                .count();
        }
        let bad = sends_naming(&port, BAD_PROGRAM);
        // Without the breaker: 300 keys each at 3, 5, 9 … ≈ 1,900 sends.
        assert!(bad < 20, "group breaker: {bad} sends");
        assert_eq!(healthy, 299);
        let g = &e.refusal_groups()[&("archive", Some(BAD_ACCOUNT))];
        assert!(e.group_open(g) && g.probes_failed >= 3, "{g:?}");
        // The cause is fixed: the next probe lands and the kind reopens.
        *code.lock().unwrap() = None;
        for s in 300..700u64 {
            pass(&mut e, &port, &mut payers, s, &mut plan).await;
        }
        assert!(e.refusal_groups().is_empty());
        assert!(e.stats["archive"].landed >= 290, "{:?}", e.stats["archive"]);
    }

    /// verify-pr192: a stuck key planned *before* healthy keys of its kind
    /// (D-dress-8's region 0: `plan_archive` goes region by region) must
    /// not take every group probe. Backlog: six region-0 batches refused
    /// `BadAccount` together with nothing of the kind landing (a restart),
    /// so the archive group opens; then region 1 plans one new batch a bell
    /// (1,500 slots, a pass every 45 slots, keeper.toml defaults). Every
    /// healthy batch lands within the hold cap plus a few passes.
    #[tokio::test]
    async fn group_probe_does_not_starve_healthy_keys_behind_a_stuck_one() {
        let port = Script::default();
        refusing(&port, Arc::new(Mutex::new(Some(BAD_ACCOUNT))));
        let mut payers = payers();
        payers.refresh(&port, 0).await.unwrap();
        let mut e = Engine::new(
            Budgets::placeholder(),
            backoff_params(REFUSAL_MAX_SLOTS, REFUSAL_MAX_PASSES, REFUSAL_GROUP_MIN),
        );
        let mut planned_at: BTreeMap<u64, u64> = BTreeMap::new();
        let mut landed_at: BTreeMap<u64, u64> = BTreeMap::new();
        for s in (0..216_000u64).step_by(45) {
            let bell = s / 1_500;
            if bell >= 1 {
                planned_at.entry(bell).or_insert(s);
            }
            let open: Vec<u64> = planned_at
                .keys()
                .copied()
                .filter(|b| !landed_at.contains_key(b))
                .collect();
            let r = pass(&mut e, &port, &mut payers, s, &mut |e, s| {
                for b in 0..6u8 {
                    e.ensure(
                        marked(&format!("archive:0:{b}"), "archive", BAD_PROGRAM, b),
                        s,
                    );
                }
                for &b in &open {
                    e.ensure(marked(&format!("archive:1:{b}"), "archive", [7; 32], 1), s);
                }
            })
            .await;
            for (k, o) in &r.outcomes {
                if let (Some(b), Outcome::Landed { .. }) = (k.strip_prefix("archive:1:"), o) {
                    landed_at.insert(b.parse().unwrap(), s);
                }
            }
        }
        let worst = planned_at
            .iter()
            .filter(|(b, _)| **b < 140)
            .map(|(b, p)| landed_at.get(b).map_or(u64::MAX, |l| l - p))
            .max()
            .unwrap();
        println!(
            "healthy batches landed {}/{}, worst wait {worst} slots, stuck sends {}",
            landed_at.len(),
            planned_at.len(),
            sends_naming(&port, BAD_PROGRAM)
        );
        assert!(
            worst <= REFUSAL_MAX_SLOTS + 10 * 45,
            "a healthy archive batch waited {worst} slots behind the stuck region"
        );
        // Each healthy landing closes the group; the six stuck keys then
        // keep their own holds (≈ 34 sends a key a day, as in
        // `a_devnet_day_of_one_refused_write`; the old schedule: ≈ 6 × 208).
        assert!(sends_naming(&port, BAD_PROGRAM) <= 6 * 40);
    }
}
