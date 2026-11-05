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

use std::collections::{BTreeMap, HashMap, HashSet};
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
        }
    }
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

struct Pending {
    spec: WriteSpec,
    first_slot: Option<u64>,
    versions: Vec<Version>,
    /// Versions whose status is known (failed ones stay in `versions` for
    /// the spend bound).
    settled: std::collections::HashSet<Signature>,
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
}

pub struct Engine {
    pending: BTreeMap<String, Pending>,
    backoff: HashMap<String, u64>,
    /// Consecutive program refusals per key (the backoff doubles with each).
    failures: HashMap<String, u32>,
    /// Versions whose write is gone (cancelled, adopted after a restart):
    /// polled until resolved so the journal is complete.
    orphans: Vec<(Signature, u64)>,
    /// A retry window may end with signatures still unresolved. Keep only
    /// those keys from starting a fresh fee budget until every old signature
    /// has a definitive status. Other writes continue normally.
    held_replans: HashMap<String, HashSet<Signature>>,
    adopted: HashMap<String, Vec<Version>>,
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
/// Slot-based retry horizon for a sent version. Passing it does not prove
/// non-landing (blockhash validity is measured in block heights).
pub const EXPIRY_SLOTS: u64 = 151;
/// Payer care uses plain System transfers. Unlike Frontier program writes,
/// two separately signed versions can both succeed and move funds twice.
pub const PAYER_CARE_KIND: &str = "payer-care";

impl Engine {
    pub fn new(budgets: Budgets, params: EngineParams) -> Engine {
        Engine {
            pending: BTreeMap::new(),
            backoff: HashMap::new(),
            failures: HashMap::new(),
            orphans: vec![],
            held_replans: HashMap::new(),
            adopted: HashMap::new(),
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
        if self.pending.contains_key(&spec.key)
            || self.backoff.get(&spec.key).is_some_and(|&s| slot < s)
            || self.held_replans.contains_key(&spec.key)
        {
            return false;
        }
        self.backoff.remove(&spec.key);
        let b = self.budgets.get(spec.tag);
        let adopted = self.adopted.remove(&spec.key).unwrap_or_default();
        self.stats.entry(spec.kind.into()).or_default().writes += 1;
        self.pending.insert(
            spec.key.clone(),
            Pending {
                first_slot: adopted.first().map(|v| v.sent_slot),
                versions: adopted,
                settled: Default::default(),
                cu_limit: b.cu_limit,
                heap: None,
                contested: false,
                bonus_milli: 0,
                spec,
            },
        );
        true
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

    /// Stops a write (its object is done on chain by another path). Versions
    /// already sent are kept as orphans for the journal.
    pub fn cancel(&mut self, key: &str) {
        if let Some(p) = self.pending.remove(key) {
            self.hold_unsettled(key, &p);
        }
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
        self.orphans.extend(unknown);
        true
    }

    /// Count a version only after its chain status is known. A failed
    /// transaction still pays its fee, including `AlreadyDone` versions.
    fn charge_fee(&mut self, sig: Signature) {
        if let Some((kind, fee)) = self.uncounted_fees.remove(&sig) {
            self.stats.entry(kind).or_default().fees_charged += fee;
        }
        self.held_replans.retain(|_, sigs| {
            sigs.remove(&sig);
            !sigs.is_empty()
        });
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
            self.uncounted_fees.insert(sig, (a.kind.clone(), a.fee));
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
        let status = |x: &str| {
            if let Some(j) = journal {
                let _ = j.set_status(&v.sig.to_string(), x, Some(st.slot), st.code);
            }
        };
        let first = p.first_slot.unwrap_or(st.slot);
        if st.err.is_none() || st.code.is_some_and(|c| err::is_done(p.spec.tag, c)) {
            status(if st.err.is_none() { "landed" } else { "done" });
            return Some(Outcome::Landed {
                slot: st.slot,
                sig: v.sig,
                payer: v.payer,
                versions: p.versions.len(),
                first_slot: first,
                already_done: st.err.is_some(),
            });
        }
        status("failed");
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
        let flat: Vec<Signature> = sigs.iter().map(|(_, v)| v.sig).collect();
        let sts = if flat.is_empty() {
            vec![]
        } else {
            port.statuses(&flat).await.unwrap_or_default()
        };
        let mut ended: Vec<(String, Outcome)> = vec![];
        for ((k, v), st) in sigs.iter().zip(sts.iter()) {
            let Some(st) = st else { continue };
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
            if let Some(p) = self.pending.get_mut(k) {
                p.settled.insert(v.sig);
            }
            if ended.iter().any(|(e, _)| e == k) {
                self.charge_fee(v.sig);
                if let Some(j) = journal {
                    let s = if st.err.is_none() { "landed" } else { "failed" };
                    let _ = j.set_status(&v.sig.to_string(), s, Some(st.slot), st.code);
                }
                continue;
            }
            if let Some(o) = self.classify(k, st, v, journal, &mut report) {
                ended.push((k.clone(), o));
            }
        }
        for (k, o) in ended {
            if let Some(p) = self.pending.remove(&k) {
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
                        let n = self.failures.entry(k.clone()).or_default();
                        *n = n.saturating_add(1);
                        // 2, 4, 8, … slots, at most 1,024 (≈ 7 min of slots).
                        let wait = BACKOFF_SLOTS << (*n - 1).min(9);
                        self.backoff.insert(k.clone(), slot + wait);
                    }
                    Outcome::Unresolved { .. } => {}
                    Outcome::Dead { .. } => s.dead += 1,
                }
                self.hold_unsettled(&k, &p);
                report.outcomes.push((k, o));
            }
        }
        // Orphans: retain unknown outcomes and predicted fees until a
        // definitive status arrives, even after the retry window.
        if !self.orphans.is_empty() {
            let orphans = std::mem::take(&mut self.orphans);
            let os: Vec<Signature> = orphans.iter().map(|o| o.0).collect();
            let sts = port.statuses(&os).await.unwrap_or_default();
            let mut keep = vec![];
            for (o, st) in orphans
                .into_iter()
                .zip(sts.iter().chain(std::iter::repeat(&None)))
            {
                match st {
                    Some(st) => {
                        if self
                            .uncounted_fees
                            .get(&o.0)
                            .is_some_and(|(kind, _)| kind == PAYER_CARE_KIND)
                        {
                            self.note_care_settled(st.slot);
                        }
                        self.charge_fee(o.0);
                        if let Some(j) = journal {
                            let s = if st.err.is_none() { "landed" } else { "failed" };
                            let _ = j.set_status(&o.0.to_string(), s, Some(st.slot), st.code);
                        }
                    }
                    None => keep.push(o),
                }
            }
            self.orphans = keep;
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
        let keys: Vec<String> = self
            .pending
            .iter()
            .filter(|(_, p)| kinds.is_none_or(|ks| ks.contains(&p.spec.kind)))
            .map(|(k, _)| k.clone())
            .collect();
        let mut blockhash: Option<Hash> = None;
        let mut last_valid_block_height: Option<u64> = None;
        let mut chain_slot: Option<u64> = None;
        for k in keys {
            let Some(p) = self.pending.get(&k) else {
                continue;
            };
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
                let p = self.pending.remove(&k).expect("pending");
                self.hold_unsettled(&k, &p);
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
                let p = self.pending.remove(&k).expect("pending");
                let unknown = self.hold_unsettled(&k, &p);
                if !unknown {
                    self.stats.entry(p.spec.kind.into()).or_default().failed += 1;
                    let n = self.failures.entry(k.clone()).or_default();
                    *n = n.saturating_add(1);
                    let wait = BACKOFF_SLOTS << (*n - 1).min(9);
                    self.backoff.insert(k.clone(), slot + wait);
                }
                let err = format!(
                    "{} versions unresolved after retry window (cap {} versions, {} lamports)",
                    p.versions.len(),
                    self.params.max_versions,
                    self.params.per_write_cap
                );
                if let Some(j) = journal {
                    // Keep the existing alert code consumed by itest/operator
                    // checks; its detail now says what is actually known.
                    let _ = j.alert(slot, "write-expired", &format!("{k}: {err}"));
                }
                let outcome = if !unknown {
                    Outcome::Failed {
                        code: None,
                        err,
                        slot,
                    }
                } else {
                    Outcome::Unresolved { err, slot }
                };
                report.outcomes.push((k, outcome));
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
            // Persist the signed version before calling RPC. A send error
            // can mean the network received it but the reply was lost, so
            // the signature must already be available for reconciliation.
            if let Some(j) = journal {
                let p = self.pending.get(&k).expect("pending");
                if let Err(e) = j.record_attempt(&Attempt {
                    sig: sig.to_string(),
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
            // Reserve the fee even if RPC returned an error: the chain may
            // have received the exact signature, and it can still land.
            payers.note_spend(&ctx.payer, fee);
            let p = self.pending.get_mut(&k).expect("pending");
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
        e.cancel("cancelled");
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
    async fn old_unknown_orphan_keeps_predicted_fee_until_finalized() {
        let port = Script::default();
        let mut payers = payers();
        payers.refresh(&port, 0).await.unwrap();
        let journal = Journal::open(std::path::Path::new(":memory:")).unwrap();
        let mut engine = Engine::new(Budgets::placeholder(), EngineParams::default());
        engine.ensure(spec("old", Class::D, abi::tag::POST_SEED), 10);
        engine.step(&port, &mut payers, Some(&journal), 10).await;
        let version = engine.pending["old"].versions[0].clone();
        engine.cancel("old");

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
        assert!(
            matches!(outcome.outcomes.as_slice(), [(key, Outcome::Failed { .. })] if key == "same")
        );
        assert_eq!(journal.in_flight().unwrap().len(), 1);
        assert!(!engine.ensure(spec("same", Class::D, abi::tag::POST_SEED), 15));
        assert!(engine.ensure(spec("other", Class::D, abi::tag::POST_SEED), 15));
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
        engine.poll(&port, Some(&journal), 16).await;
        assert_eq!(
            engine.stats["test"].fees_charged,
            versions[0].fee + versions[1].fee
        );
        assert!(engine.ensure(spec("same", Class::D, abi::tag::POST_SEED), 16));
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
        engine.cancel("cancel");
        assert!(!engine.ensure(spec("cancel", Class::D, abi::tag::POST_SEED), 11));

        let mut deadline = spec("deadline", Class::D, abi::tag::POST_SEED);
        deadline.deadline_slot = Some(12);
        assert!(engine.ensure(deadline, 10));
        engine.step(&port, &mut payers, None, 10).await;
        let late = engine.pending["deadline"].versions[0].sig;
        let result = engine.step(&port, &mut payers, None, 12).await;
        assert!(
            matches!(result.outcomes.as_slice(), [(key, Outcome::Dead { .. })] if key == "deadline")
        );
        assert!(!engine.ensure(spec("deadline", Class::D, abi::tag::POST_SEED), 13));

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
        drop(statuses);
        engine.poll(&port, None, 14).await;
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
        engine.cancel("rpc-error");
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
        assert!(after.held_replans.contains_key("old"));
        assert!(!after.ensure(spec("old", Class::D, abi::tag::POST_SEED), late + 1));
        assert!(after.ensure(spec("other", Class::D, abi::tag::POST_SEED), late + 1));
        assert_eq!(journal.in_flight().unwrap().len(), 1);
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

    /// A write held past its version cap leaves the pending queue, but an
    /// unknown old signature must keep its fee budget from being reset.
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
        assert!(!e.is_pending("a"));
        assert!(
            !e.ensure(spec("a", Class::D, abi::tag::POST_ANCHOR), end_slot),
            "unresolved old signatures hold this key"
        );
        assert!(e.held_replans.contains_key("a"));
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
        e.poll(&port, Some(&j), end_slot + 2).await;
        assert!(!e.held_replans.contains_key("a"));
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
        assert!(e.ensure(spec("a", Class::D, abi::tag::POST_ANCHOR), end_slot + 2));
        let mut landed = false;
        for s in end_slot + 2..end_slot + 6 {
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
}
