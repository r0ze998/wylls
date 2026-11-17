//! **Read-only** (feature `wide-world-experimental`): the observed PSW1
//! chain head of a province or holding against the account's own chain
//! fields in one coherent snapshot.
//!
//! **What is compared.** `proc/wide.rs::emit_wide` advances each chained
//! account's header (`layout::header::EVENT_SEQ`, `EVENT_HEAD`) with
//! `event::advance` and writes exactly that `(seq, head)` into the record's
//! link tail. So the last link the observer verified for an entity
//! ([`WideObserver::chain`]) and the header of that entity's account, read
//! in a response at or past the slot the record asserted, are the **same
//! two numbers if the records and the account describe one history**. This
//! module reads both and says which case holds: agree, the account ahead
//! of the observer (feed lag), the observer ahead of the account, a
//! different head at the same sequence, a response older than the record,
//! an account that is absent (closed if the observer saw the close, else
//! simply missing), a closed province whose account is still present, an
//! account that is not the identity asked for (owner, executable, shape,
//! season, world, coordinate, site, generation), an observer of another
//! scope, nothing observed, or reads that are not one coherent snapshot.
//!
//! **What agreement means, exactly.** Cross-input consistency: the records
//! this observer received and the account bytes this snapshot returned
//! agree on where the chain ends at that context slot. The two inputs may
//! come from independent sources (a feed, an RPC node); their relationship
//! is **unverified** here. Agreement is **not** history authenticity — the
//! observer's chain may be anchored on trust mid-history
//! (`ChainHead::from_genesis == false`, reported), the records' signatures
//! were never verified, the records' slots are the source's assertions,
//! and the source's coverage is unknown — and it is **not** completeness.
//! It permits nothing: no gate, denial or engine path reads a verdict; the
//! review keeps `HistoryUnknown` and `SourceUnproven` on every candidate
//! regardless. Diagnostics only.
//!
//! **What is never done.** No write, no cursor moved (the observer is
//! borrowed immutably), no account read of its own (the caller's `Reads`
//! are judged as they are), no genesis trust invented, no payment or
//! refund recipient inferred.

use fclient::ports::Account;
use frontier_abi::bytes::{rd_arr, rd_u64};
use frontier_abi::layout::header;
use frontier_abi::world_index::event::WideTarget;
use frontier_abi::world_index::{holding as wh, land as wl, WideHolding, WideProvince, WorldId};
use serde_json::{json, Value};
use solana_address::Address;

use crate::wideduty::{addr, ctx_of, presence, season_of, Block, Reads, Scope};
use crate::wideindex::{ChainHead, WideObserver};

/// What the comparison found. Only `Agree` is agreement, and only in the
/// sense the module doc states.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Verdict {
    /// Same `(seq, head)` in the account as the last observed link, in a
    /// response at or past the slot the record asserted.
    Agree,
    /// The account's chain is past the last observed link: records this
    /// observer has not received yet. Feed **lag**, not a conflict.
    ObserverBehind { account_seq: u64 },
    /// The observed chain is past the account's although the response is
    /// at or past the record's asserted slot: the observed records and
    /// this account do not describe one history.
    AccountBehind { account_seq: u64 },
    /// Same sequence, another head: not one history.
    HeadMismatch,
    /// The observer saw the province's `ProvinceClosed`, yet the account is
    /// present: the close erases the account in the same transaction, so
    /// one of the two inputs is wrong about this province.
    ClosedButPresent,
    /// The response's context slot is before the slot the record asserted:
    /// the snapshot is older than the observation; nothing is concluded,
    /// neither about the head nor about presence.
    SnapshotBehindRecord { context_slot: u64, record_slot: u64 },
    /// The observer holds no chain for this entity.
    NotObserved,
    /// The account is absent and the observer saw its `ProvinceClosed`.
    AccountClosed,
    /// The account is absent and no close was observed: never created in
    /// this source's view, or closed unseen — unknown which.
    AccountMissing,
    /// The account at the canonical address is not the identity asked for
    /// (named: owner, executable, shape, season, world, coordinate, site,
    /// generation).
    Identity(&'static str),
    /// The observer's scope (program, season, world) is not the requested
    /// one, or the target is of another world: its heads do not apply.
    ScopeMismatch(&'static str),
    /// The reads are not one verified snapshot: no comparison.
    NoCoherentSnapshot,
    /// The canonical address is not in the reads.
    NotRead,
    /// The Season in the reads is not usable (the planner's refusal, named).
    Season(&'static str),
}

impl Verdict {
    /// The two inputs contradict each other, or the account is not what was
    /// asked for. Lag is not a disagreement.
    pub fn is_disagreement(&self) -> bool {
        matches!(
            self,
            Verdict::AccountBehind { .. }
                | Verdict::HeadMismatch
                | Verdict::ClosedButPresent
                | Verdict::Identity(_)
        )
    }
    /// The account is ahead of the observer: the ordinary gap between a
    /// chain and a feed reader, to be closed by later records.
    pub fn is_lag(&self) -> bool {
        matches!(self, Verdict::ObserverBehind { .. })
    }
    pub fn code(&self) -> String {
        format!("{self:?}")
    }
}

/// One comparison.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Reconciliation {
    pub target: WideTarget,
    /// The canonical address the identity resolves to.
    pub address: Address,
    pub observed: Option<ChainHead>,
    /// The account's `(EVENT_SEQ, EVENT_HEAD)` when it was readable.
    pub account: Option<(u64, [u8; 32])>,
    pub context_slot: Option<u64>,
    pub verdict: Verdict,
}

impl Reconciliation {
    pub fn describe(&self) -> Value {
        json!({
            "target": match self.target {
                WideTarget::Province(p) => json!({"province": hex::encode(p.to_bytes())}),
                WideTarget::Holding(h) => json!({"holding": hex::encode(h.holding_ref().to_bytes())}),
            },
            "address": self.address.to_string(),
            "verdict": self.verdict.code(),
            "disagreement": self.verdict.is_disagreement(),
            "lag": self.verdict.is_lag(),
            "observed": self.observed.map(|h| json!({
                "seq": h.seq,
                "head": hex::encode(h.head),
                "record_slot_asserted": h.slot,
                "terminal": h.terminal,
                "from_genesis": h.from_genesis,
                "anchor": if h.from_genesis { "verified from the zero head" } else { "taken on trust mid-history: unverified prefix" },
            })),
            "account": self.account.map(|(s, h)| json!({"seq": s, "head": hex::encode(h)})),
            "context_slot": self.context_slot,
            "meaning": "cross-input consistency of the observed records with the snapshot's account bytes",
            "source_relationship": "unverified: the records and the snapshot may come from independent sources",
            "history_authenticated": false,
            "source_complete": false,
            "permits": "nothing",
        })
    }
}

/// The account's chain fields.
fn chain_fields(d: &[u8]) -> Option<(u64, [u8; 32])> {
    Some((
        rd_u64(d, header::EVENT_SEQ)?,
        rd_arr::<32>(d, header::EVENT_HEAD)?,
    ))
}

/// The identity check of the account at the target's canonical address:
/// `Ok(chain fields)` when it is that province or holding of this season
/// and world, not executable; `Err(what)` otherwise.
fn identity(
    target: WideTarget,
    acc: &Account,
    season_id: u64,
    world: WorldId,
) -> Result<(u64, [u8; 32]), &'static str> {
    if acc.executable {
        return Err("executable");
    }
    match target {
        WideTarget::Province(p) => {
            let rec = WideProvince::read(&acc.data).map_err(|_| "shape")?;
            if rec.season_id != season_id {
                return Err("season");
            }
            if rec.world != world {
                return Err("world");
            }
            if rec.coord != p.coord() {
                return Err("coordinate");
            }
        }
        WideTarget::Holding(h) => {
            let rec = WideHolding::read(&acc.data).map_err(|_| "shape")?;
            if rec.season_id != season_id {
                return Err("season");
            }
            if rec.world != world {
                return Err("world");
            }
            if rec.coord != h.key().coord() {
                return Err("coordinate");
            }
            if rec.site != h.site() {
                return Err("site");
            }
            if rec.gen != h.gen() {
                return Err("generation");
            }
        }
    }
    chain_fields(&acc.data).ok_or("shape")
}

/// Compares the observer's chain head for `target` with the account at the
/// target's canonical address in `reads`. Reads nothing itself; moves
/// nothing. Order: the scope, the snapshot, the Season, the observed head
/// and its asserted slot against the context slot (a stale response
/// concludes nothing, presence included), then the account's presence,
/// identity and chain fields. See the module doc for each verdict.
pub fn reconcile(
    scope: &Scope,
    observer: &WideObserver,
    target: WideTarget,
    reads: &Reads,
) -> Reconciliation {
    let ctx = ctx_of(scope);
    let address = match target {
        WideTarget::Province(p) => addr(wl::province_address(&ctx, p.coord())),
        WideTarget::Holding(h) => addr(wh::holding_address(&ctx, h.key().coord(), h.site())),
    };
    let mut out = Reconciliation {
        target,
        address,
        observed: None,
        account: None,
        context_slot: None,
        verdict: Verdict::NoCoherentSnapshot,
    };
    // The observer must be this scope's: its heads mean nothing otherwise.
    let world = match WorldId::derive_legacy_season(&ctx.season, &ctx.program) {
        Ok(w) => w,
        Err(_) => {
            out.verdict = Verdict::Season("world");
            return out;
        }
    };
    let os = observer.model.scope();
    if os.program != scope.program {
        out.verdict = Verdict::ScopeMismatch("program");
        return out;
    }
    if os.season != scope.season {
        out.verdict = Verdict::ScopeMismatch("season");
        return out;
    }
    if os.world != world {
        out.verdict = Verdict::ScopeMismatch("world");
        return out;
    }
    let target_world = match target {
        WideTarget::Province(p) => p.world(),
        WideTarget::Holding(h) => h.key().world(),
    };
    if target_world != world {
        out.verdict = Verdict::ScopeMismatch("target world");
        return out;
    }
    out.observed = observer.chain(target);
    let Some(meta) = reads.coherent_snapshot() else {
        return out;
    };
    out.context_slot = Some(meta.context_slot());
    let season_id = match season_of(scope, reads) {
        Ok((s, _)) => s.h.season_id,
        Err(_) => {
            out.verdict = Verdict::Season("not usable");
            return out;
        }
    };
    // A response older than the record's asserted slot cannot confirm a
    // head, a presence or a close that the record is later than.
    if let Some(h) = out.observed {
        if meta.context_slot() < h.slot {
            out.verdict = Verdict::SnapshotBehindRecord {
                context_slot: meta.context_slot(),
                record_slot: h.slot,
            };
            return out;
        }
    }
    // Check executable before presence normalizes an empty System account
    // into absence; malformed executable responses cannot confirm a close.
    if reads
        .accounts
        .get(&address)
        .and_then(Option::as_ref)
        .is_some_and(|a| a.executable)
    {
        out.verdict = Verdict::Identity("executable");
        return out;
    }
    let acc = match presence(reads, &address, &scope.program, "reconcile") {
        Err(Block::ForeignOwner(_)) => {
            out.verdict = Verdict::Identity("owner");
            return out;
        }
        Err(_) => {
            out.verdict = Verdict::NotRead;
            return out;
        }
        Ok(None) => {
            out.verdict = match out.observed {
                Some(h) if h.terminal => Verdict::AccountClosed,
                _ => Verdict::AccountMissing,
            };
            return out;
        }
        Ok(Some(a)) => a,
    };
    let (seq, head) = match identity(target, acc, season_id, world) {
        Ok(f) => f,
        Err(what) => {
            out.verdict = Verdict::Identity(what);
            return out;
        }
    };
    out.account = Some((seq, head));
    let Some(h) = out.observed else {
        out.verdict = Verdict::NotObserved;
        return out;
    };
    if h.terminal {
        // The close erases the account in its own transaction.
        out.verdict = Verdict::ClosedButPresent;
        return out;
    }
    out.verdict = if seq > h.seq {
        Verdict::ObserverBehind { account_seq: seq }
    } else if seq < h.seq {
        Verdict::AccountBehind { account_seq: seq }
    } else if head != h.head {
        Verdict::HeadMismatch
    } else {
        Verdict::Agree
    };
    out
}
