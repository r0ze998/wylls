//! A deterministic model of one board's life across the base layer, the
//! delegation program (DLP), one ER validator and its committor, with the
//! faults the reconciler must survive. **It is a model, not MagicBlock**:
//! it encodes the protocol as read from the delegation program's source
//! (`magicblock-labs/delegation-program` @ `41e3d1d3`, dlp v2.0.1 /
//! dlp-api 4.0.1) and the SDK (`ephemeral-rollups-sdk` 0.16.2 / 0.17.3), so
//! a test that passes here shows the reconciler's logic, not that the real
//! services behave so. What it encodes, and from where:
//!
//! | step | here | source |
//! |---|---|---|
//! | Delegate | base owner → DLP; record (validator, rent payer); once | `delegate_account` (SDK `cpi.rs`), DLP `delegate` |
//! | ER copy | the validator clones the base bytes; only it writes | ER docs, "accounts are cloned on first use" |
//! | Commit | `ScheduleCommit` → CommitState (pending diff on base) → Finalize (base bytes, nonce) | DLP `commit_state`, `finalize`; SDK `MagicIntentBundleBuilder` |
//! | Commit and undelegate | ER copy stops accepting writes at once; after Finalize, Undelegate → the owner's callback re-creates the account | DLP `undelegate`, SDK `undelegate_account` |
//! | Commit cap | without a delegated fee payer, commit 11 of a session fails; commit-and-undelegate is still allowed | DLP v2.0.1, `0xA0000000` (research note) |
//! | Escape | RequestUndelegation (rent payer + owner PDA sign) → validator has 9,000 slots → UndelegateWithRollbackAfterTimeout hands the account back **emptied**; the owner restores its saved bytes | DLP `request_undelegation.rs`, `DEFAULT_UNDELEGATION_REQUEST_TIMEOUT_SLOTS` |
//! | Nonce | Finalize with a nonce ≤ the last one is refused (a resent commit is a no-op) | DLP `commit_state` nonce check |
//!
//! Fees and rent are not modelled.

use std::collections::VecDeque;

use crate::board::{self, Write, WriteErr};

pub type Key = [u8; 32];

pub const REQUEST_TIMEOUT_SLOTS: u64 = 9_000;
pub const SPONSORED_COMMITS: u32 = 10;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Owner {
    Program,
    Dlp,
    /// Closed or never created.
    System,
}

/// Who asked to undelegate (DLP metadata `undelegation_requester`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Requester {
    None,
    Validator,
    Owner,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Record {
    pub validator: Key,
    pub rent_payer: Key,
    /// Nonce of the last finalized commit.
    pub nonce: u64,
    pub requester: Requester,
    /// Slot after which the owner may roll back (`Requester::Owner`).
    pub request_expires: Option<u64>,
    /// A CommitState not yet finalized: `(nonce, bytes)`.
    pub pending: Option<(u64, Vec<u8>)>,
    pub commits: u32,
}

#[derive(Clone, Debug)]
pub struct Base {
    pub slot: u64,
    /// Slots below this are finalized (the model finalizes `lag` slots back).
    pub lag: u64,
    pub owner: Owner,
    pub data: Vec<u8>,
    pub record: Option<Record>,
    /// Base-layer transaction log: what an indexer of the base sees.
    pub log: Vec<(u64, BaseEvent)>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum BaseEvent {
    Write(Write),
    Delegated(Key),
    Committed(u64),
    Undelegated,
    UndelegationRequested(u64),
    RolledBack { seq: u64 },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Intent {
    Commit,
    CommitAndUndelegate,
}

/// Where a committor stops when it crashes (fault injection).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CommitFault {
    None,
    /// CommitState landed, Finalize not sent.
    AfterCommitState,
    /// Finalize (and the undelegation) landed; the validator did not learn
    /// it, so it will resend.
    ResponseLost,
}

#[derive(Clone, Debug)]
pub struct Er {
    pub identity: Key,
    pub up: bool,
    pub slot: u64,
    /// The ER's copy and whether it still accepts writes.
    pub copy: Option<Vec<u8>>,
    pub writable: bool,
    pub intents: VecDeque<(u64, Intent, Vec<u8>)>,
    /// Commits whose Finalize the validator believes it still owes.
    pub unacked: Option<(u64, Intent, Vec<u8>)>,
    pub next_nonce: u64,
    /// ER transaction log (the writes it accepted, in order).
    pub log: Vec<Write>,
    /// Slot at which it last polled the base for undelegation requests.
    pub polled: u64,
}

#[derive(Debug, PartialEq, Eq)]
pub enum SimErr {
    /// The base program refuses: the account is not program-owned.
    NotProgramOwned,
    AlreadyDelegated,
    NotDelegated,
    WrongValidator,
    ErDown,
    ErNotWritable,
    MissingSignature,
    TooEarly,
    CommitCap,
    Board(WriteErr),
}

/// One board and one validator of a continuing world (no end, no periods).
#[derive(Clone, Debug)]
pub struct World {
    pub world_id: u64,
    pub base: Base,
    pub er: Er,
    /// The rent payer the operator keeps (the escape needs its signature).
    pub rent_payer: Key,
}

impl World {
    pub fn new(world_id: u64, validator: Key, rent_payer: Key) -> World {
        World {
            world_id,
            base: Base {
                slot: 100,
                lag: 32,
                owner: Owner::Program,
                data: board::new_board(world_id),
                record: None,
                log: vec![],
            },
            er: Er {
                identity: validator,
                up: true,
                slot: 0,
                copy: None,
                writable: false,
                intents: VecDeque::new(),
                unacked: None,
                next_nonce: 1,
                log: vec![],
                polled: 0,
            },
            rent_payer,
        }
    }

    pub fn advance(&mut self, slots: u64) {
        self.base.slot += slots;
        if self.er.up {
            self.er.slot += slots * 10;
        }
    }

    fn log(&mut self, e: BaseEvent) {
        let s = self.base.slot;
        self.base.log.push((s, e));
        self.base.slot += 1;
    }

    /// A write sent to the base program.
    pub fn base_write(&mut self, w: &Write) -> Result<u64, SimErr> {
        if self.base.owner != Owner::Program {
            return Err(SimErr::NotProgramOwned);
        }
        let (seq, _) =
            board::apply(&mut self.base.data, self.world_id, w).map_err(SimErr::Board)?;
        self.log(BaseEvent::Write(*w));
        Ok(seq)
    }

    /// Delegate (owner program CPI into the DLP, signed by the board PDA;
    /// the payer becomes the rent payer).
    pub fn delegate(&mut self, validator: Key, payer: Key) -> Result<(), SimErr> {
        if self.base.owner != Owner::Program {
            return Err(SimErr::AlreadyDelegated);
        }
        self.base.owner = Owner::Dlp;
        self.base.record = Some(Record {
            validator,
            rent_payer: payer,
            nonce: 0,
            requester: Requester::None,
            request_expires: None,
            pending: None,
            commits: 0,
        });
        self.log(BaseEvent::Delegated(validator));
        Ok(())
    }

    /// The ER clones the account on first use (only if delegated to it).
    fn er_clone(&mut self) -> Result<(), SimErr> {
        if !self.er.up {
            return Err(SimErr::ErDown);
        }
        if self.er.copy.is_none() {
            let rec = self.base.record.as_ref().ok_or(SimErr::NotDelegated)?;
            if self.base.owner != Owner::Dlp || rec.validator != self.er.identity {
                return Err(SimErr::WrongValidator);
            }
            self.er.copy = Some(self.base.data.clone());
            self.er.writable = true;
        }
        Ok(())
    }

    /// A write sent to the ER.
    pub fn er_write(&mut self, w: &Write) -> Result<u64, SimErr> {
        self.er_clone()?;
        if !self.er.writable {
            return Err(SimErr::ErNotWritable);
        }
        let world = self.world_id;
        let copy = self.er.copy.as_mut().ok_or(SimErr::NotDelegated)?;
        let (seq, _) = board::apply(copy, world, w).map_err(SimErr::Board)?;
        self.er.log.push(*w);
        self.er.slot += 1;
        Ok(seq)
    }

    /// `ScheduleCommit` / `ScheduleCommitAndUndelegate` on the ER (the
    /// program's commit instruction, sent by the keeper).
    pub fn er_schedule(&mut self, intent: Intent) -> Result<u64, SimErr> {
        self.er_clone()?;
        if !self.er.writable {
            return Err(SimErr::ErNotWritable);
        }
        let rec = self.base.record.as_ref().ok_or(SimErr::NotDelegated)?;
        let queued = self
            .er
            .intents
            .iter()
            .filter(|i| i.1 == Intent::Commit)
            .count() as u32;
        if intent == Intent::Commit && rec.commits + queued >= SPONSORED_COMMITS {
            return Err(SimErr::CommitCap);
        }
        let nonce = self.er.next_nonce;
        self.er.next_nonce += 1;
        let bytes = self.er.copy.clone().ok_or(SimErr::NotDelegated)?;
        if intent == Intent::CommitAndUndelegate {
            self.er.writable = false;
        }
        self.er.intents.push_back((nonce, intent, bytes));
        Ok(nonce)
    }

    /// The validator's committor works through its queue (one intent per
    /// call), stopping at `fault`.
    pub fn committor_step(&mut self, fault: CommitFault) -> bool {
        if !self.er.up {
            return false;
        }
        let (nonce, intent, bytes) = match self.er.unacked.take() {
            Some(x) => x,
            None => match self.er.intents.pop_front() {
                Some(x) => x,
                None => return false,
            },
        };
        // The owner rolled the account back meanwhile: the DLP refuses
        // everything for it; the validator drops the intent.
        if self.base.owner != Owner::Dlp {
            return true;
        }
        // CommitState: refused for a nonce already finalized (a resend).
        let Some(rec) = self.base.record.as_mut() else {
            return true;
        };
        if nonce <= rec.nonce {
            return true;
        }
        rec.pending = Some((nonce, bytes.clone()));
        if fault == CommitFault::AfterCommitState {
            self.er.unacked = Some((nonce, intent, bytes));
            self.er.up = false;
            return true;
        }
        // Finalize.
        rec.nonce = nonce;
        rec.pending = None;
        rec.commits += 1;
        self.base.data = bytes.clone();
        self.log(BaseEvent::Committed(nonce));
        if intent == Intent::CommitAndUndelegate {
            // Undelegate + the owner's callback: the program re-creates the
            // account with the committed bytes (`undelegated_content_ok`).
            self.base.owner = Owner::Program;
            self.base.record = None;
            self.log(BaseEvent::Undelegated);
            self.er.copy = None;
            self.er.writable = false;
        }
        if fault == CommitFault::ResponseLost {
            self.er.unacked = Some((nonce, intent, bytes));
        }
        true
    }

    /// The validator's poll of undelegation requests (every 5 minutes on
    /// the real service): an owner request becomes a commit-and-undelegate.
    pub fn validator_poll(&mut self) {
        if !self.er.up {
            return;
        }
        self.er.polled = self.base.slot;
        let requested = matches!(
            self.base.record.as_ref().map(|r| r.requester),
            Some(Requester::Owner)
        );
        if requested && self.er.writable {
            let _ = self.er_schedule(Intent::CommitAndUndelegate);
        }
    }

    /// The ER's storage is wiped: on restart it clones the base copy again
    /// (measured on the local stack, ephemeral-validator 1.1.1).
    pub fn er_wipe(&mut self) {
        self.er.copy = None;
        self.er.intents.clear();
        self.er.unacked = None;
        self.er.log.clear();
        self.er.up = true;
    }

    pub fn er_crash(&mut self) {
        self.er.up = false;
    }

    /// A restarted validator keeps its ledger (copy, queue, log).
    pub fn er_restart(&mut self) {
        self.er.up = true;
    }

    /// RequestUndelegation: the operator's escape, first step. Needs the
    /// rent payer's signature (`signer`).
    pub fn request_undelegation(&mut self, signer: Key) -> Result<u64, SimErr> {
        if self.base.owner != Owner::Dlp {
            return Err(SimErr::NotDelegated);
        }
        let slot = self.base.slot;
        let rec = self.base.record.as_mut().ok_or(SimErr::NotDelegated)?;
        if signer != rec.rent_payer {
            return Err(SimErr::MissingSignature);
        }
        let exp = *rec
            .request_expires
            .get_or_insert(slot + REQUEST_TIMEOUT_SLOTS);
        rec.requester = Requester::Owner;
        self.log(BaseEvent::UndelegationRequested(exp));
        Ok(exp)
    }

    /// UndelegateWithRollbackAfterTimeout (permissionless once expired):
    /// the DLP hands the account back emptied; the owner program writes its
    /// saved base bytes (the last finalized commit) back and marks the board.
    pub fn rollback_after_timeout(&mut self) -> Result<(), SimErr> {
        if self.base.owner != Owner::Dlp {
            return Err(SimErr::NotDelegated);
        }
        let rec = self.base.record.as_ref().ok_or(SimErr::NotDelegated)?;
        match rec.request_expires {
            Some(e) if self.base.slot >= e => {}
            _ => return Err(SimErr::TooEarly),
        }
        let mut saved = self.base.data.clone();
        board::mark_rolled_back(&mut saved);
        self.base.data = saved;
        self.base.owner = Owner::Program;
        self.base.record = None;
        let seq = board::header(&self.base.data).map(|h| h.0).unwrap_or(0);
        self.log(BaseEvent::RolledBack { seq });
        Ok(())
    }

    /// Whether the base slot `s` is finalized now.
    pub fn finalized(&self, s: u64) -> bool {
        s + self.base.lag <= self.base.slot
    }
}

impl World {
    /// The world moves to another validator (an explicit rotation): a fresh
    /// ER with no copy. The old one's ledger is gone from the model; a
    /// target still delegated to it must come home through it first.
    pub fn switch_er(&mut self, identity: Key) {
        self.er = Er {
            identity,
            up: true,
            slot: 0,
            copy: None,
            writable: false,
            intents: VecDeque::new(),
            unacked: None,
            next_nonce: 1,
            log: vec![],
            polled: 0,
        };
    }
}
