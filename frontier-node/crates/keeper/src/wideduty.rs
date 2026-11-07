//! **Read-only, opt-in** (feature `wide-world-experimental`): planning of
//! the two permissionless wide settlements the keeper could one day send —
//! WideSettleDeparture (0xDC op 3) and WideReturn (0xDC op 2) — and, since
//! the eighth slice, of the keeper's WideGather (0xDC op 4), as
//! **unsigned** instructions built from current account reads, with the
//! dispatcher's own account tables and refusals replayed over the decoded
//! state. Nothing here signs, simulates, sends or queues; the keeper's
//! engine never sees these instructions, the production debit gate stays
//! closed, and the legacy PSW1 feed guard is untouched.
//!
//! **Source of truth.** `permutation-frontier/src/proc/wide.rs`:
//! `settle_departure` (the exact six accounts `[payer s,w] [season r]
//! [origin_province w] [holding w] [roster w] [transit w]`) and
//! `settle_return` (`[payer s,w] [season r] [province w] [roster w]
//! [holding w] [transit r] ×4` and the optional `[holding_province r]`).
//! Each planner reproduces the handler's preconditions in the handler's
//! order and stops at the first one that fails, naming it ([`Block`]).
//! What the handler decides at execution it decides again then; a plan is
//! a prediction from a read, never a guarantee.
//!
//! **Permissionless means permissionless.** Neither planner compares the
//! holding's *current* generation or owner with the host's historical
//! reference: SettleDeparture settles the march the transit record names
//! whoever holds the holding now, and Return credits the holding record
//! when it is live at the reference's generation and **strands** the hosts
//! otherwise (a transferred Citizen, a re-founded site, an absent holding).
//! A plan says which.
//!
//! **Reads are not a context.** `ChainPort::accounts(keys, min_slot)`
//! promises a context slot at or after `min_slot` and nothing about which
//! slot, and the Clock is a separate call. A [`Candidate`] therefore
//! carries the requested lower bound and the separately observed clock and
//! marks itself `coherent: false`; it is not evidence the instruction would
//! succeed, only that the handler's refusals did not fire on these bytes.
//! A Season stored `Seeded` is promoted to `Running` by the handler's rule
//! (`now ≥ genesis_ts`) against that observed clock only, and the candidate
//! says so (`status_promoted_by_clock`).
//!
//! **The deployment is pinned, not guessed.** `settle_season` requires the
//! Season's exact `program_version` and ruleset hash. The caller pins both
//! in the [`Scope`] ([`Deployment`]); without a pin every plan blocks.
//!
//! **Stored values and chains.** A destroyed departure (kernel troops below
//! 500) stores zero troops and zero stamina; the facts say what the record
//! would hold, and the `ready_bell_off` the handler saturates. The event
//! chains of the province and the holding must have room for the records
//! the settle logs (one each for a settle; one per picked entry on the
//! province and one per credited entry on the holding for a return).
//!
//! **Boundaries.** A standing province that is not a wide province of this
//! world (a legacy Province at the position, another world's key) blocks;
//! the mixed legacy/wide movement stays refused as the program refuses it.
//! A return of hosts standing in a province other than their holding's own
//! needs the tenth account (the holding's own province, where the capture
//! lock is read); the planner adds it exactly then.
//!
//! **WideGather (0xDC op 4), eighth slice.** [`plan_gather`] plans the
//! destination's gather of revealed arrivals into the wide ClashInputs, the
//! deployed GatherClash over the wide records (`proc/wide.rs::gather`):
//! `[fee_payer s,w] [season r] [province r] [anchor|archive r] [inputs w]
//! [arrivalday r] [ix_sysvar r] [system]` then `n × [slot r] [transit
//! r|w]` (`wide_ix::GATHER`). The handler's rules replayed in its order:
//! the keeper prologue (Running or Ended, this build's), the destination a
//! wide province of this world at its canonical address, `bell ≥
//! resolved_next` (`LatchClosed`), `bell < end_bell` (`WrongStatus`), the
//! reveal window of the bell **closed** for the province's stored region
//! against THE anchor or its archive entry (`TooEarly`, `NoAnchor`), the
//! ClashInputs at its canonical address absent (created from the fee
//! payer; the creation tops up only the shortfall over what the address
//! holds, `init::top_up` — the fee review nets a prefunded address) or
//! this province's and bell's and not resolved (`AlreadyDone`), **the wide
//! ArrivalDay as the arrival evidence** — its bit clear, the handler
//! completes the mask without reading a slot: with no record that is a
//! complete empty record the resolve does not need (not planned,
//! `NoArrivals`, a policy), with a partial record it is the completing
//! gather the resolve requires (planned, one position, nothing written to
//! the positions); **never** is the absence of feed events read as "no
//! arrivals". The cursor is bounded **before** any slot is read: the first
//! ungathered position and the contiguous ungathered run after it, at most
//! [`GATHER_MAX_POSITIONS`] (every position present fits one packet under
//! the widest ComputeBudget prefix; [`packet_len`] against
//! [`GATHER_PACKET_BYTES`] guards the result). Every position's slot at
//! its canonical address, absent or this record's; a present slot's host
//! transit record at the slot's bound address, this host's and this
//! bell's; `Departed` at the first position refused (`DepartureUnsettled`:
//! the origin settles first), later in the cursor it **cuts** the cursor
//! before it (the ready prefix is a valid gather); `Settled` /
//! `DestroyedAtOrigin` stamped (writable); `Gathered` at this destination
//! left as is (read-only). An absent slot's transit position is the slot's
//! own address (any read-only account, the handler says; nothing is
//! invented). The facts predict the mask, the present count as the
//! handler's scan of **every** position of the written record (a position
//! that does not decode fails the handler), the completion and the
//! stamps; a resolve needs every position gathered (`remaining_after`).
//!
//! **WideResolve (0xDC op 1), ninth slice.** [`plan_resolve`] plans the
//! one-bell wide resolve of an observed province's **current**
//! `resolved_next` (`proc/wide.rs::resolve`, `wide_ix::RESOLVE`:
//! `[fee_payer s,w] [season r] [province w] [roster w] [seedcache|archive
//! r] [anchor|archive r] [clash_inputs r|w] [arrivalday r] [system]`). The
//! handler's rules in its order: the keeper prologue; the province
//! canonical and of this world; `bell = resolved_next` (the planner reads
//! it; the model's `NotDue` is `OutOfOrder`); `bell < end_bell`
//! (`SeasonEnded`); the reveal window closed against THE anchor or its
//! archive entry of the province's **stored** region; the bell seed as
//! `hold::bell_seed` takes it — a SeedCache of THE anchor at the address
//! its **stored nonce** recomputes, this season's, bell's and region's,
//! naming the anchor's key and `A` and the round `S(bell, A)`
//! (`SeedNotReady` otherwise), or, when THE anchor is archived, the
//! archive entry's seed with the **same archive account in both the seed
//! and the anchor positions**; the nonce is not derivable, so the planner
//! takes it from the caller and asks for a bounded probe when missing
//! ([`find_seed_nonce`]: the legacy keeper's 256 nonces, in chunks);
//! the ArrivalDay's bit as the arrival evidence — set, the ClashInputs
//! must be present, canonical, fully gathered and unresolved
//! (`NotGathered` / `AlreadyResolved`), absent with the bit clear the bell
//! runs over the residents alone; the Season's conquest block of this
//! build's version (`ConquestParams`); the roster present and canonical,
//! or absent while no entry is live. Then **the actual bell model on
//! scratch copies**: `world_index::resolve::resolve_bell` with
//! `frontier_ruleset()` and `StepParams::of_season`, the resolved
//! arrivals written back, the resolver and the resolve time (the observed
//! clock's) into the record, the summary into the province, so the plan
//! knows the engagements, the destroyed and bounced, whether the bell
//! **creates the roster from the fee payer** (an arrival that stays claims
//! an entry; the handler then requires the payer to hold the roster's
//! **full** minimum balance — `Insufficient` otherwise — before the
//! creation tops the address up: the fee review's `RENT_RULE_FULL`, exact
//! to the handler, not the gather's netting), the input digest and the
//! output digest **at the observed clock** (the landed record carries the
//! execution clock's `resolved_ts`). The model's refusals of unported
//! S1/S2 state (a live fort, a caravan, a conquest record, a packed
//! pending op) are kept as `Unported`; every other model refusal is
//! `ResolveModel` by name. The program applies its own model; the plan is
//! a prediction from a read.
//!
//! **Not planned here.** WideSettleTransit (the arrivals' settlement after
//! the resolve) is the next slice; a resolved bell has no planned
//! settlement yet. Arrival processing is **not** complete.

use std::collections::BTreeMap;

use fclient::abi::status;
use fclient::clock::SeasonClock;
use fclient::decode::{is_absent, AnchorArchive, BellAnchor, Season, SeedCache};
use fclient::ports::{Account, ChainPort, ClockSysvar};
use fclient::tx::TxBudget;
use fclient::{Hash, Transaction};
use frontier_abi::addr::{archive_part_of, AddrCtx};
use frontier_abi::bytes::{rd_u32, rd_u64, rd_u8, wr_arr, wr_u32, wr_u8};
use frontier_abi::clash_model::arrival_stamina;
use frontier_abi::conquest_model::StepParams;
use frontier_abi::entry::{find_entry, read_entry, EntryOp};
use frontier_abi::layout::beacon::anchor_archive as AA;
use frontier_abi::layout::header;
use frontier_abi::layout::province::entry as E;
use frontier_abi::layout::province::province as PV;
use frontier_abi::layout::province::summary as SU;
use frontier_abi::prologue::{Group, Wr};
use frontier_abi::v2::layout::player::holding as H;
use frontier_abi::v2::presets::CONQUEST_VERSION;
use frontier_abi::v2::prologue::capture_locked;
use frontier_abi::world_index::arrival as wa;
use frontier_abi::world_index::event as wev;
use frontier_abi::world_index::wide_ix::{self as wix, Gather, Resolve, Return, SettleDeparture};
use frontier_abi::world_index::{
    holding as wh, land as wl, march as wm, resolve as wres, roster as wro, wide_host_alias,
    MarchEvent, MarchState, ProvinceKey, WideHolding, WideHostRef, WideProvince, WideRoster,
    WideTransit, WorldId,
};
use permutation_rules::fixed::MILLI;
use permutation_rules::frontier::beacon::bell_end;
use permutation_rules::frontier::clash::frontier_ruleset;
use permutation_rules::frontier::host::DESTROYED_BELOW;
use serde_json::{json, Value};
use solana_address::Address;
use solana_instruction::{AccountMeta, Instruction};

use crate::wideindex::{Presence, WideDiscovery};
use crate::widesnapshot::{snapshot_plan, RentSysvar, Snapshot, SnapshotMeta, SnapshotPort};

/// The deployed program the caller **pins**: the exact `program_version`
/// the Season must carry and the exact ruleset hash (`settle_season`
/// requires both; the keeper crate cannot read them off the program, so it
/// does not guess them). Without a pin the planners block
/// ([`Block::DeploymentUnpinned`]) rather than accept any version with the
/// wide bit.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Deployment {
    pub program_version: u16,
    pub ruleset_hash: [u8; 32],
}

/// The program, Season and pinned deployment a plan is made under.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Scope {
    pub program: Address,
    pub season: Address,
    pub deployment: Option<Deployment>,
}

/// The most Leave entries one WideReturn settles
/// (`permutation_frontier::proc::clash::RETURN_MAX`, a program constant
/// the keeper crate cannot import; mirrored here for the prediction only —
/// the program applies its own).
pub const RETURN_MAX: usize = 3;

/// Never `true` in this module: no plan is signed, simulated, sent or
/// queued.
pub const AUTOMATIC_SEND: bool = false;

// ------------------------------------------------------------ reads

/// The accounts a planner was given, by address, with the lower bound they
/// were requested at and the clock observed **separately** (if at all) —
/// or, when built by [`crate::widesnapshot::Snapshot::reads`], the
/// accounts, the Clock and the Rent of **one** RPC response with its
/// context (`snapshot`). Only the snapshot module constructs a
/// [`SnapshotMeta`]; a caller cannot assert coherence by hand.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Reads {
    pub min_slot: u64,
    pub clock: Option<ClockSysvar>,
    /// `None` = the chain said absent; a missing key = not read yet.
    pub accounts: BTreeMap<Address, Option<Account>>,
    /// The one response these reads came from, if they did.
    pub snapshot: Option<SnapshotMeta>,
    /// The Rent sysvar of that response, when it was requested.
    pub rent: Option<RentSysvar>,
}

impl Reads {
    pub fn new(min_slot: u64) -> Reads {
        Reads {
            min_slot,
            ..Reads::default()
        }
    }

    /// The sealed snapshot these reads **still** are, if any: the meta's
    /// digest re-verified over the current `min_slot`, clock, rent and
    /// every account. A meta cloned onto other bytes, or reads edited
    /// after the snapshot, verify as nothing. Every planner and fee
    /// consumer decides coherence through this and nothing else.
    pub fn coherent_snapshot(&self) -> Option<&SnapshotMeta> {
        self.snapshot.as_ref().filter(|m| {
            m.verify(
                self.min_slot,
                self.clock.as_ref(),
                self.rent.as_ref(),
                &self.accounts,
            )
        })
    }
}

/// A planner's answer: more reads needed (the addresses, canonical, that
/// the next step depends on), or a decision.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Step<T> {
    Need(Vec<Address>),
    Done(Result<T, Block>),
}

/// Why no candidate exists: the handler's refusal the read state would
/// hit, or a read the planner could not get. Nothing in here is "retry
/// later" advice; the caller reads again and plans again.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Block {
    /// The port failed or returned the wrong shape.
    Read(String),
    /// The read loop did not converge (a planner kept asking).
    ReadLoop,
    /// The Season at the scope address is not usable (named).
    Season(&'static str),
    /// A stored status the settles refuse (`Running` or `Ended` pass).
    SeasonStatus(u8),
    /// Stored `Seeded` and no clock was observed: the effective status
    /// (`Running` once `now ≥ genesis_ts`) cannot be judged.
    SeasonDependsOnClock,
    /// Stored `Seeded` and the separately observed clock is before the
    /// genesis timestamp: not yet Running by that observation.
    SeasonNotStarted { genesis_ts: i64, observed: i64 },
    /// No deployment pinned in the scope: the exact program version and
    /// ruleset hash the handler requires are unknown to the planner.
    DeploymentUnpinned,
    /// The Season's `program_version` is not the pinned one.
    ProgramVersion { expected: u16, got: u16 },
    /// The Season's ruleset hash is not the pinned one.
    RulesetHash,
    /// The event chain of the named account cannot take the records the
    /// settle would log (`seq + n` overflows: the handler's `Overflow`).
    ChainOverflow(&'static str),
    /// A key is not of this Season's one world (the handler's `BadAddress`).
    World,
    /// The transit slot is not below `TRANSIT_N`.
    BadSlot(u8),
    /// A required account is absent (named).
    Absent(&'static str),
    /// An account at a canonical address is not owned by the program.
    ForeignOwner(&'static str),
    /// An account's bytes do not decode as the record expected there.
    Unreadable(&'static str),
    /// A record of another season, or not at its canonical address.
    NotCanonical(&'static str),
    /// No transit record at the slot (`TransitState`: no march).
    NoMarch,
    /// The transit record names another host.
    TransitOtherHost,
    /// The departure settled already (`AlreadyDone`).
    AlreadySettled(MarchState),
    /// The record is in a state the settle refuses (`TransitState`).
    TransitState(MarchState),
    /// The holding's own province capture-locks it (`CapturePending`).
    CapturePending,
    /// The origin has not resolved past the departure bell (`TooEarly`).
    TooEarly {
        resolved_next: u32,
        depart_bell: u32,
    },
    /// The province entry table and the roster disagree (`BadAccount`).
    RosterUnpaired,
    /// No entry carries the host's alias (`NotResident`).
    NotResident,
    /// The entry is not in the departed state (`NotResident`).
    EntryState(u8),
    /// The entry carries the alias but the roster does not vouch for it.
    EntryUnpaired,
    /// An entry does not decode.
    BadEntry,
    /// The kernel refuses the post-clash values (`Host::march_values`).
    MarchValues(String),
    /// Return: the standing province has no roster (`AlreadyDone`).
    NoRoster,
    /// Return: every returnable host has an open march (`HostInTransit`).
    HostInTransit,
    /// Return: no departed Leave entry names this holding (`AlreadyDone`).
    NothingToReturn,
    /// Return: a credit would overflow the reserve (`Overflow`).
    ReserveOverflow { unit: u8 },
    // ---- the reveal planner (`crate::widereveal`) ----
    /// Reveal: the Season is stored `Ended` and the arrival bell is at or
    /// past its end bell (`WrongStatus`).
    SeasonEnded,
    /// Reveal: the transit record and the supplied proof disagree (named
    /// field): the record moved on or the proof is another march's.
    ProofMismatch(&'static str),
    /// Reveal: the opening supplied does not reproduce the transit record's
    /// seal root (`CommitMismatch`).
    CommitMismatch,
    /// Reveal: the IBE block does not open under the supplied signature
    /// (the stock opener's refusal, named).
    SealOpen(String),
    /// Reveal: the plaintext does not validate against the record
    /// (`BadPlaintext`, the codec's reason).
    BadPlaintext(String),
    /// Reveal: no opening was supplied; the planner never derives one.
    NoOpening,
    /// Reveal: an anchor is present and the window test needs a clock,
    /// which was not observed.
    TimingNeedsClock,
    /// Reveal: the window is closed by the observed clock or by the beacon
    /// log (`WindowClosed`, named).
    WindowClosed(&'static str),
    /// Reveal: THE canonical BellAnchor of `(arrive, region)` is not
    /// present (`"absent"`, or `"archive-only"` when only its archive is).
    /// The handler would read the archive; the keeper does not publish a
    /// plaintext without THE anchor and the round's verified signature.
    AnchorRequired(&'static str),
    /// Reveal: no public drand beacon of `T(arrive)` was supplied; the
    /// planner never exports a destination-bearing candidate without one.
    PublicationMissing,
    /// Reveal: the supplied beacon is not of `SeasonClock::tlock_round(arrive)`.
    BeaconRound { expected: u64, got: u64 },
    /// Reveal: the supplied public key does not hash to the Season's
    /// `quicknet_pk_hash`.
    BeaconKey,
    /// Reveal: the supplied signature does not verify for the round under
    /// the supplied key (`fclient::beacon::verify`).
    BeaconSignatureInvalid,
    /// Reveal: the latch is closed (`LatchClosed`, named).
    LatchClosed(&'static str),
    /// Reveal: the committed path does not walk (`Path`, named step).
    Path(&'static str),
    /// Reveal: the arrival bell is outside the doctrine's travel bounds.
    ArrivalBell,
    /// Reveal: the destination site is shielded (`Shielded`).
    Shielded,
    /// Reveal: this host already holds a slot at the destination
    /// (`AlreadyDone`).
    AlreadyRevealed,
    /// Reveal: the quota refuses the arrival (`QuotaRefused`, named).
    QuotaRefused(&'static str),
    /// An arithmetic overflow the handler would refuse.
    Overflow(&'static str),
    // ---- the gather planner ----
    /// Gather: the wide ArrivalDay of the bell's day is absent or its bit
    /// is clear **and no ClashInputs exists**: the handler would create a
    /// complete, empty record the resolve does not need (it takes the
    /// residents alone when both are absent), so the planner does not
    /// propose it — a planner policy, not a handler refusal. With a partial
    /// record and a clear bit the completing gather **is** planned. Read
    /// from the accounts at their canonical addresses, never from the
    /// absence of feed events.
    NoArrivals,
    /// Gather: every position of the record is gathered already (the
    /// cursor is empty; the resolve may run).
    AlreadyGathered,
    /// Gather: the ClashInputs carries `FLAG_RESOLVED` (`AlreadyDone`).
    AlreadyResolved,
    /// Gather: the reveal window of the bell is still open by the observed
    /// clock (`TooEarly`).
    WindowOpen { reveal_close: i64, now: i64 },
    /// Gather: THE anchor of `(bell, region)` is absent and its archive
    /// does not hold the bell (`NoAnchor`), named.
    NoAnchor(&'static str),
    /// Gather: a present slot's transit record is still `Departed`: the
    /// origin must settle the departure first (`DepartureUnsettled`).
    DepartureUnsettled { position: u8 },
    // ---- the resolve planner ----
    /// Resolve: the bell model found `resolved_next` not the bell asked
    /// (`OutOfOrder`); the planner always plans the province's current one.
    OutOfOrder { resolved_next: u32, bell: u32 },
    /// Resolve: THE anchor is present and the SeedCache's nonce was not
    /// supplied: its canonical address depends on the nonce (256 possible),
    /// which a bounded probe finds (`find_seed_nonce`); nothing is planned
    /// without it.
    SeedNonceUnknown { bell: u32, region: u8 },
    /// Resolve: the bell seed is not on chain (`SeedNotReady`), named: the
    /// cache absent at the supplied nonce, or a cache that does not match
    /// THE anchor (its key, `A` or the seed round).
    SeedNotReady(&'static str),
    /// Resolve: the ArrivalDay says arrivals exist and the ClashInputs is
    /// absent or not fully gathered (`NotGathered`); a gather of this bell
    /// comes first.
    NotGathered { bell: u32 },
    /// Resolve: the Season carries no conquest block of this build's
    /// version (`BadAccount`): the step parameters are unknown.
    ConquestParams,
    /// Resolve: the bell model refuses S1/S2 state no wide handler writes
    /// (a live fort, a caravan, a conquest record, a packed pending op),
    /// named (`Unported`).
    Unported(&'static str),
    /// Resolve: the bell model (`world_index::resolve::resolve_bell`)
    /// refused, its reason by name.
    ResolveModel(String),
    // ---- the transit settlement planner (`crate::widesettle`) ----
    /// Settle: the transit record's host is of another generation than the
    /// holding (the handler's `NotImplemented`: no wide capture exists).
    HistoricalGeneration { host_gen: u8, holding_gen: u8 },
    /// Settle: the march is still `Departed` at the origin
    /// (`DepartureUnsettled`).
    OriginUnsettled,
    /// Settle: the sealed destination is not a present province; the
    /// routed settlement under the region's anchor is not planned here.
    DestinationAbsent,
    /// Settle: THE anchor's (or the archive entry's) stored round signature
    /// is not the verified public one supplied: the chain would open the
    /// seal under a signature this planner did not verify.
    AnchorSignatureMismatch,
    /// Settle: `now < close + 600` or the destination has not resolved past
    /// the arrival (`TooEarly`), with the times.
    TooEarlyToSettle {
        settle_at: i64,
        now: i64,
        resolved_next: u32,
    },
    /// Settle: the ClashInputs of the arrival is absent or not resolved;
    /// the routed/unresolved settlement is not planned here.
    InputsUnresolved,
    /// Settle: the host is not present in the resolved final set; the
    /// bounce/rout settlement is not planned here.
    NotInFinalSet,
    /// Settle: the slot at the host's final-set position is absent or
    /// another host's; the tip then goes to `pool_owed`, not planned here.
    SlotNotOwn,
    /// Settle: the host's fate is one that comes home (Bounced, Retreated)
    /// or not a fate code; the home re-entry is not planned here.
    FateUnsupported(u8),
    /// Settle: the host earns the camp's loot (the owner Citizen is a
    /// further account); not planned here.
    CampLootUnsupported,
    /// Settle: the seal did not open and validate under the verified public
    /// round signature; the handler would confiscate it as a bad seal,
    /// which is not planned here (named step).
    BadSealUnsupported(&'static str),
    /// Settle: the holding's escrow is below the plan's total (`BadAccount`).
    EscrowShort { escrow: u64, total: u64 },
    /// Settle: the holding counts no open transit (`BadAccount`).
    NoOpenTransit,
    /// Settle: the Rent sysvar is not among the reads: the handler's divert
    /// rule (`pay_or_divert`: a wallet the payment would leave below its
    /// rent-exempt minimum is diverted) cannot be reproduced; named.
    RentSysvarMissing(&'static str),
    /// Settle: the holding's lamports cannot back a payment the replay
    /// delivers to a wallet (`move_lamports`: `Insufficient`).
    HoldingBackingShort {
        payment: &'static str,
        holding_lamports: u64,
        amount: u64,
    },
    /// Settle: the runtime's invariant, not a handler line — the holding's
    /// lamports changed and would end below its rent-exempt minimum
    /// (conservative refusal).
    HoldingBelowRentExemption { after: u64, floor: u64 },
    /// Settle: a whole-account close under `Sink::Never` would divert (the
    /// recipient wallet would stay below its rent-exempt minimum): the
    /// handler's `BadAccount`; the target named (`"slot"`, `"transit"`).
    CloseWouldDivert(&'static str),
    /// Settle: a close's recipient is a state account of the instruction
    /// (a close source, the holding, a record, the System Program) or any
    /// program-owned account: the handler pays it directly, but the
    /// source/recipient balance transitions are not replayed here —
    /// a conservative refusal, not a handler rule; the target named.
    CloseRecipientAlias(&'static str),
    /// Settle: the slot's rent recipient is the fee payer's position and
    /// the review payer is the all-zero placeholder: that close cannot be
    /// judged against a wallet; named.
    PayerPlaceholder(&'static str),
    /// The same-response snapshot could not be taken (the port's reason).
    Snapshot(String),
    /// Planned over one response, the plan asked for keys the response
    /// does not hold (the state moved between learning the keys and the
    /// snapshot): not patched from another read.
    SnapshotIncomplete(usize),
}

// ------------------------------------------------------------ candidates

/// What a SettleDeparture plan established from the reads.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SettleFacts {
    pub host: WideHostRef,
    pub transit_slot: u8,
    pub origin: ProvinceKey,
    pub depart_bell: u32,
    pub resolved_next: u32,
    pub entry_index: usize,
    /// The kernel's post-clash values (`Host::march_values`).
    pub kernel_troops_milli: u32,
    pub kernel_stamina: u16,
    /// `kernel_troops < DESTROYED_BELOW` (the handler's `destroyed`).
    pub predicted_destroyed: bool,
    /// What the handler stores in the record: the kernel values, or
    /// **zero troops and zero stamina** when destroyed.
    pub troops_after_milli: u32,
    pub stamina_after: u16,
    /// `entry.ready_bell − depart_bell`, saturating at 0 and at `u16::MAX`.
    pub ready_bell_off: u16,
    /// The holding's own province is the origin (the capture lock was
    /// read there); otherwise no lock applies to this settle.
    pub origin_is_home: bool,
}

/// One entry a WideReturn would free.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReturnPick {
    pub entry_index: usize,
    pub host: WideHostRef,
    /// Credited to the holding's reserve (live at the reference's
    /// generation) or stranded (lost).
    pub credited: bool,
    pub unit: u8,
    pub whole_troops: u32,
}

/// What a Return plan established from the reads.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReturnFacts {
    pub standing: ProvinceKey,
    /// The holding by reference (site and generation of the caller's
    /// reference; the generation is **not** required to match the record).
    pub holding: WideHostRef,
    pub holding_present: bool,
    /// `Some(gen)` when the holding record is live (provisional or final)
    /// at its stored generation; the credit test is `live == Some(ref gen)`.
    pub live_gen: Option<u8>,
    /// The hosts return into a province other than the holding's own: the
    /// tenth account (the holding's own province) is in the instruction.
    pub foreign: bool,
    pub picks: Vec<ReturnPick>,
    pub skipped_in_transit: usize,
}

/// A present wide ArrivalSlot of a gather's cursor and what the handler
/// would make of it from the host's transit record.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GatherSlot {
    pub host: WideHostRef,
    /// The host's holding transit slot the arrival names (the record the
    /// handler reads: `transit_address(holding, transit_slot)`).
    pub transit_slot: u8,
    pub transit_state: MarchState,
    /// The transit record is stamped `Gathered` by this gather (it was
    /// `Settled` or `DestroyedAtOrigin`); its account is writable then.
    pub stamps: bool,
    /// The arrival record the handler writes: present when the troops
    /// after the origin's settle are at least `DESTROYED_BELOW`.
    pub predicted_present: bool,
    pub predicted_destroyed: bool,
    pub troops_milli: u32,
    pub stamina: u16,
}

/// One position of a gather's cursor.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GatherPosition {
    pub position: u8,
    pub faction: u8,
    pub i: u8,
    /// The slot at the position's canonical address, when present.
    pub slot: Option<GatherSlot>,
}

/// What a Gather plan established from the reads.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GatherFacts {
    pub dest: ProvinceKey,
    pub bell: u32,
    pub region: u8,
    pub resolved_next: u32,
    /// The cursor: positions `start..start + n` of the 24, at most
    /// [`GATHER_MAX_POSITIONS`], bounded before any slot was read.
    pub start: u8,
    pub n: u8,
    /// The ArrivalDay's bit of the bell is set: the cursor's slots were
    /// read and are written. Clear (only with a partial record): the
    /// handler completes the mask without reading a slot; the cursor is
    /// one position, its slot unread, nothing written to the positions.
    pub day_bit_set: bool,
    /// The cursor was cut before this position: its slot's host transit
    /// record is still `Departed` (the origin has not settled); the
    /// positions before it are gathered now, that one waits.
    pub cut_at_unsettled: Option<u8>,
    /// The ClashInputs exists (else the handler creates it from the fee
    /// payer with `init::rent(size)` as the total, topping up only the
    /// shortfall over what the address already holds).
    pub inputs_present: bool,
    /// Lamports already at the ClashInputs address when it is absent (a
    /// prefunded System account), netted by the creation's top-up; 0
    /// otherwise.
    pub inputs_prefunded_lamports: u64,
    pub arrivals_mask_before: u32,
    pub predicted_mask_after: u32,
    /// The handler's `n_present` after this gather: the present arrivals
    /// among the positions gathered before (read from the record) plus
    /// those this cursor finds present.
    pub predicted_n_present: u8,
    /// `predicted_mask_after == ALL_GATHERED`: the resolve may take it.
    pub predicted_complete: bool,
    /// Complete with no present arrival (`FLAG_NO_ARRIVALS` then).
    pub predicted_no_arrivals: bool,
    /// Positions still ungathered after this gather.
    pub remaining_after: u8,
    /// Transit records this gather stamps.
    pub stamps: u8,
    /// `"anchor"` (THE BellAnchor) or `"archive"` (its archive entry).
    pub anchor_source: &'static str,
    /// `A` of the anchor, the reveal close it fixes, and the observed clock
    /// the window was judged by.
    pub a_ts: i64,
    pub reveal_close: i64,
    pub judged_at: i64,
    pub positions: Vec<GatherPosition>,
}

/// What a Resolve plan established: the inputs the handler authenticates
/// and the bell model's outcome replayed on scratch copies of the bytes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ResolveFacts {
    pub province: ProvinceKey,
    /// The province's `resolved_next` as read: the one bell it resolves.
    pub bell: u32,
    pub region: u8,
    /// The resolver the data names (the caller's public address; written
    /// into the ClashInputs and the summary by the handler).
    pub beneficiary: Address,
    /// `"cache"` (a SeedCache of THE anchor) or `"archive"` (the archive
    /// entry, both the seed and the anchor positions).
    pub seed_source: &'static str,
    pub seed_nonce: Option<u8>,
    pub seed_round: u64,
    pub anchor_source: &'static str,
    pub a_ts: i64,
    pub reveal_close: i64,
    pub judged_at: i64,
    /// The ArrivalDay's bit: arrivals exist and the gathered record is
    /// required.
    pub arrivals_expected: bool,
    pub inputs_present: bool,
    /// The gathered record's `n_present` (0 without a record).
    pub n_arrivals: u8,
    pub roster_present: bool,
    /// The bell claims an entry in an absent roster: the handler creates it
    /// from the fee payer, who must hold its **full** minimum balance.
    pub roster_created: bool,
    pub live_entries_before: u8,
    pub engagements: u32,
    pub destroyed: u8,
    pub bounced: u8,
    pub settled: bool,
    /// `event::resolve_input_digest` over the bytes as read.
    pub input_digest: [u8; 32],
    /// `event::resolve_output_digest` over the scratch bytes **with the
    /// observed clock's `resolved_ts`**: the handler writes the execution
    /// clock there, so the landed record's digest equals this one only
    /// when executed at the same second.
    pub output_digest_at_observed_clock: [u8; 32],
    pub resolved_ts_at_observed_clock: u32,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Duty {
    SettleDeparture(SettleFacts),
    Return(ReturnFacts),
    Gather(GatherFacts),
    Resolve(ResolveFacts),
    /// WideSettleTransit, planned by `crate::widesettle` (its facts live
    /// there).
    SettleTransit(Box<crate::widesettle::SettleTransitFacts>),
}

/// A validated, **unsigned** instruction and the facts it rests on.
#[derive(Clone, Debug, PartialEq)]
pub struct Candidate {
    pub duty: Duty,
    pub instruction: Instruction,
    pub payer: Address,
    /// The lower bound the reads were requested at (not their context slot).
    pub min_slot: u64,
    /// The clock the plan was judged by: a separate call, or the Clock of
    /// the snapshot response when [`Candidate::snapshot`] is set.
    pub observed_clock: Option<ClockSysvar>,
    /// The verified same-response snapshot the plan ran over, bound to a
    /// digest of this candidate's content as the planner produced it
    /// (crate-private: no caller attaches one). Read through
    /// [`Candidate::snapshot`], which re-verifies the content first.
    pub(crate) bound: Option<Bound>,
    /// The Season was stored `Seeded` and judged `Running` only by the
    /// observed clock (`now ≥ genesis_ts`): the handler's
    /// `effective_status`, applied to an observation.
    pub status_promoted_by_clock: bool,
    /// Always `false`.
    pub signed: bool,
    /// Always [`AUTOMATIC_SEND`] (`false`).
    pub automatic_send: bool,
}

/// A verified snapshot meta bound to the digest of a candidate's content
/// (instruction, facts, payer, slot bound, observed clock, every flag) as
/// the planner produced it. The content digest never covers the bound
/// itself. A candidate whose public fields were changed afterwards no
/// longer matches and loses every coherence and funding claim.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Bound {
    pub meta: SnapshotMeta,
    pub content: [u8; 32],
}

/// A canonical, lossless byte encoding for a content digest: every scalar
/// little-endian at its full width, every byte string and sequence
/// length-prefixed, every option tagged, every identity by its full ABI
/// bytes (`WorldId` is 32 bytes; its `Debug` prints four). Fields are
/// written in declaration order by the `canon` methods below; **no
/// `Debug`/`Display` output is ever hashed**.
pub(crate) struct Canon {
    buf: Vec<u8>,
}

impl Canon {
    pub fn new(domain: &[u8]) -> Canon {
        let mut c = Canon {
            buf: Vec::with_capacity(1024),
        };
        c.bytes(domain);
        c
    }
    pub fn u8(&mut self, v: u8) {
        self.buf.push(v);
    }
    pub fn bool(&mut self, v: bool) {
        self.buf.push(v as u8);
    }
    pub fn u16(&mut self, v: u16) {
        self.buf.extend_from_slice(&v.to_le_bytes());
    }
    pub fn u32(&mut self, v: u32) {
        self.buf.extend_from_slice(&v.to_le_bytes());
    }
    pub fn u64(&mut self, v: u64) {
        self.buf.extend_from_slice(&v.to_le_bytes());
    }
    pub fn i64(&mut self, v: i64) {
        self.buf.extend_from_slice(&v.to_le_bytes());
    }
    pub fn usize(&mut self, v: usize) {
        self.u64(v as u64);
    }
    /// `le32(len) ‖ bytes`.
    pub fn bytes(&mut self, b: &[u8]) {
        self.u32(b.len() as u32);
        self.buf.extend_from_slice(b);
    }
    pub fn str(&mut self, s: &str) {
        self.bytes(s.as_bytes());
    }
    /// The count that precedes a sequence's elements.
    pub fn len(&mut self, n: usize) {
        self.u32(n as u32);
    }
    /// `0`, or `1 ‖ value`.
    pub fn option<T>(&mut self, v: Option<T>, f: impl FnOnce(&mut Canon, T)) {
        match v {
            None => self.u8(0),
            Some(x) => {
                self.u8(1);
                f(self, x)
            }
        }
    }
    pub fn address(&mut self, a: &Address) {
        self.bytes(&a.to_bytes());
    }
    /// The full 50 bytes (version, 32-byte world, sort key).
    pub fn province(&mut self, k: &ProvinceKey) {
        self.bytes(&k.to_bytes());
    }
    /// The full 56 bytes (version, 32-byte world, sort key, site, gen, seq).
    pub fn host(&mut self, h: &WideHostRef) {
        self.bytes(&h.to_bytes());
    }
    /// The instruction: program, every meta (key, signer, writable), data.
    pub fn instruction(&mut self, ix: &Instruction) {
        self.address(&ix.program_id);
        self.len(ix.accounts.len());
        for m in &ix.accounts {
            self.address(&m.pubkey);
            self.bool(m.is_signer);
            self.bool(m.is_writable);
        }
        self.bytes(&ix.data);
    }
    pub fn clock(&mut self, c: Option<ClockSysvar>) {
        self.option(c, |w, k| w.bytes(&k.encode()));
    }
    pub fn digest(self) -> [u8; 32] {
        use sha2::{Digest, Sha256};
        Sha256::digest(&self.buf).into()
    }
}

impl SettleFacts {
    pub(crate) fn canon(&self, c: &mut Canon) {
        c.host(&self.host);
        c.u8(self.transit_slot);
        c.province(&self.origin);
        c.u32(self.depart_bell);
        c.u32(self.resolved_next);
        c.usize(self.entry_index);
        c.u32(self.kernel_troops_milli);
        c.u16(self.kernel_stamina);
        c.bool(self.predicted_destroyed);
        c.u32(self.troops_after_milli);
        c.u16(self.stamina_after);
        c.u16(self.ready_bell_off);
        c.bool(self.origin_is_home);
    }
}

impl ReturnPick {
    pub(crate) fn canon(&self, c: &mut Canon) {
        c.usize(self.entry_index);
        c.host(&self.host);
        c.bool(self.credited);
        c.u8(self.unit);
        c.u32(self.whole_troops);
    }
}

impl ReturnFacts {
    pub(crate) fn canon(&self, c: &mut Canon) {
        c.province(&self.standing);
        c.host(&self.holding);
        c.bool(self.holding_present);
        c.option(self.live_gen, Canon::u8);
        c.bool(self.foreign);
        c.len(self.picks.len());
        for p in &self.picks {
            p.canon(c);
        }
        c.usize(self.skipped_in_transit);
    }
}

/// The ABI's state byte of a march state (`WideTransit`'s own encoding is
/// private; the numbers are the layout's: 0 free, 1 departed, 2 settled, 3
/// destroyed at origin, 4 gathered).
pub(crate) fn march_state_byte(s: MarchState) -> u8 {
    match s {
        MarchState::Free => 0,
        MarchState::Departed => 1,
        MarchState::Settled => 2,
        MarchState::DestroyedAtOrigin => 3,
        MarchState::Gathered => 4,
    }
}

impl GatherSlot {
    pub(crate) fn canon(&self, c: &mut Canon) {
        c.host(&self.host);
        c.u8(self.transit_slot);
        c.u8(march_state_byte(self.transit_state));
        c.bool(self.stamps);
        c.bool(self.predicted_present);
        c.bool(self.predicted_destroyed);
        c.u32(self.troops_milli);
        c.u16(self.stamina);
    }
}

impl GatherFacts {
    pub(crate) fn canon(&self, c: &mut Canon) {
        c.province(&self.dest);
        c.u32(self.bell);
        c.u8(self.region);
        c.u32(self.resolved_next);
        c.u8(self.start);
        c.u8(self.n);
        c.bool(self.day_bit_set);
        c.option(self.cut_at_unsettled, Canon::u8);
        c.bool(self.inputs_present);
        c.u64(self.inputs_prefunded_lamports);
        c.u32(self.arrivals_mask_before);
        c.u32(self.predicted_mask_after);
        c.u8(self.predicted_n_present);
        c.bool(self.predicted_complete);
        c.bool(self.predicted_no_arrivals);
        c.u8(self.remaining_after);
        c.u8(self.stamps);
        c.str(self.anchor_source);
        c.i64(self.a_ts);
        c.i64(self.reveal_close);
        c.i64(self.judged_at);
        c.len(self.positions.len());
        for p in &self.positions {
            c.u8(p.position);
            c.u8(p.faction);
            c.u8(p.i);
            c.option(p.slot.as_ref(), |w, s| s.canon(w));
        }
    }
}

impl ResolveFacts {
    pub(crate) fn canon(&self, c: &mut Canon) {
        c.province(&self.province);
        c.u32(self.bell);
        c.u8(self.region);
        c.address(&self.beneficiary);
        c.str(self.seed_source);
        c.option(self.seed_nonce, Canon::u8);
        c.u64(self.seed_round);
        c.str(self.anchor_source);
        c.i64(self.a_ts);
        c.i64(self.reveal_close);
        c.i64(self.judged_at);
        c.bool(self.arrivals_expected);
        c.bool(self.inputs_present);
        c.u8(self.n_arrivals);
        c.bool(self.roster_present);
        c.bool(self.roster_created);
        c.u8(self.live_entries_before);
        c.u32(self.engagements);
        c.u8(self.destroyed);
        c.u8(self.bounced);
        c.bool(self.settled);
        c.bytes(&self.input_digest);
        c.bytes(&self.output_digest_at_observed_clock);
        c.u32(self.resolved_ts_at_observed_clock);
    }
}

impl Duty {
    pub(crate) fn canon(&self, c: &mut Canon) {
        match self {
            Duty::SettleDeparture(f) => {
                c.u8(1);
                f.canon(c);
            }
            Duty::Return(f) => {
                c.u8(2);
                f.canon(c);
            }
            Duty::Gather(f) => {
                c.u8(3);
                f.canon(c);
            }
            Duty::Resolve(f) => {
                c.u8(4);
                f.canon(c);
            }
            Duty::SettleTransit(f) => {
                c.u8(5);
                f.canon(c);
            }
        }
    }
}

impl Candidate {
    /// The digest of everything the candidate exposes: the instruction,
    /// the duty's facts (full identity bytes), the payer, the slot bound,
    /// the observed clock, the status flag and the two always-false
    /// flags. Not the bound. Canonical bytes, never `Debug` output.
    fn content(&self) -> [u8; 32] {
        let mut c = Canon::new(b"PSF-KEEPER-WIDE-CANDIDATE-v2");
        c.instruction(&self.instruction);
        self.duty.canon(&mut c);
        c.address(&self.payer);
        c.u64(self.min_slot);
        c.clock(self.observed_clock);
        c.bool(self.status_promoted_by_clock);
        c.bool(self.signed);
        c.bool(self.automatic_send);
        c.digest()
    }

    /// `true` exactly when every account and the clock the plan used came
    /// from one verified `getMultipleAccounts` response **and** the
    /// candidate is still exactly what the planner produced: account/clock
    /// coherence at that response's context slot — not currency, not
    /// source completeness, not permission to execute.
    pub fn coherent(&self) -> bool {
        self.snapshot().is_some()
    }

    /// The sealed meta of the response the plan ran over, if any and if
    /// the candidate's content still matches the digest it was bound with.
    pub fn snapshot(&self) -> Option<&SnapshotMeta> {
        let content = self.content();
        self.bound
            .as_ref()
            .filter(|b| b.content == content)
            .map(|b| &b.meta)
    }

    /// An operator-facing summary (no account bytes, no key material).
    pub fn describe(&self) -> Value {
        let (kind, facts) = match &self.duty {
            Duty::SettleDeparture(f) => (
                "WideSettleDeparture",
                json!({
                    "host": hex::encode(f.host.to_bytes()),
                    "transit_slot": f.transit_slot,
                    "origin": hex::encode(f.origin.to_bytes()),
                    "depart_bell": f.depart_bell,
                    "resolved_next": f.resolved_next,
                    "entry": f.entry_index,
                    "kernel_troops_milli": f.kernel_troops_milli,
                    "kernel_stamina": f.kernel_stamina,
                    "predicted_destroyed": f.predicted_destroyed,
                    "troops_after_milli": f.troops_after_milli,
                    "stamina_after": f.stamina_after,
                    "ready_bell_off": f.ready_bell_off,
                    "origin_is_home": f.origin_is_home,
                }),
            ),
            Duty::Return(f) => (
                "WideReturn",
                json!({
                    "standing": hex::encode(f.standing.to_bytes()),
                    "holding": hex::encode(f.holding.to_bytes()),
                    "holding_present": f.holding_present,
                    "live_gen": f.live_gen,
                    "foreign": f.foreign,
                    "picks": f.picks.iter().map(|p| json!({
                        "entry": p.entry_index,
                        "host": hex::encode(p.host.to_bytes()),
                        "credited": p.credited,
                        "unit": p.unit,
                        "whole_troops": p.whole_troops,
                    })).collect::<Vec<_>>(),
                    "skipped_in_transit": f.skipped_in_transit,
                }),
            ),
            Duty::Gather(f) => (
                "WideGather",
                json!({
                    "dest": hex::encode(f.dest.to_bytes()),
                    "bell": f.bell,
                    "region": f.region,
                    "resolved_next": f.resolved_next,
                    "start": f.start,
                    "n": f.n,
                    "max_positions": GATHER_MAX_POSITIONS,
                    "day_bit_set": f.day_bit_set,
                    "cut_at_unsettled": f.cut_at_unsettled,
                    "inputs_present": f.inputs_present,
                    "inputs_prefunded_lamports": f.inputs_prefunded_lamports,
                    "arrivals_mask_before": f.arrivals_mask_before,
                    "predicted_mask_after": f.predicted_mask_after,
                    "predicted_n_present": f.predicted_n_present,
                    "predicted_complete": f.predicted_complete,
                    "predicted_no_arrivals": f.predicted_no_arrivals,
                    "remaining_after": f.remaining_after,
                    "stamps": f.stamps,
                    "anchor_source": f.anchor_source,
                    "a_ts": f.a_ts,
                    "reveal_close": f.reveal_close,
                    "judged_at": f.judged_at,
                    "positions": f.positions.iter().map(|p| json!({
                        "position": p.position,
                        "faction": p.faction,
                        "i": p.i,
                        "slot": p.slot.as_ref().map(|s| json!({
                            "host": hex::encode(s.host.to_bytes()),
                            "transit_slot": s.transit_slot,
                            "transit_state": march_state_byte(s.transit_state),
                            "stamps": s.stamps,
                            "predicted_present": s.predicted_present,
                            "predicted_destroyed": s.predicted_destroyed,
                            "troops_milli": s.troops_milli,
                            "stamina": s.stamina,
                        })),
                    })).collect::<Vec<_>>(),
                    "arrival_evidence": "the wide ArrivalDay at its canonical address; never the absence of feed events; a clear bit with a partial record is the completing gather (no slot read)",
                    "absent_slot_transit_position": "the slot's own address, read-only (any account, the handler says)",
                    "n_present_rule": "the handler's scan of every position after the cursor is written; a position that does not decode fails it",
                }),
            ),
            Duty::Resolve(f) => (
                "WideResolve",
                json!({
                    "province": hex::encode(f.province.to_bytes()),
                    "bell": f.bell,
                    "region": f.region,
                    "beneficiary": f.beneficiary.to_string(),
                    "seed_source": f.seed_source,
                    "seed_nonce": f.seed_nonce,
                    "seed_round": f.seed_round,
                    "anchor_source": f.anchor_source,
                    "a_ts": f.a_ts,
                    "reveal_close": f.reveal_close,
                    "judged_at": f.judged_at,
                    "arrivals_expected": f.arrivals_expected,
                    "inputs_present": f.inputs_present,
                    "n_arrivals": f.n_arrivals,
                    "roster_present": f.roster_present,
                    "roster_created": f.roster_created,
                    "live_entries_before": f.live_entries_before,
                    "engagements": f.engagements,
                    "destroyed": f.destroyed,
                    "bounced": f.bounced,
                    "settled": f.settled,
                    "input_digest": hex::encode(f.input_digest),
                    "output_digest_at_observed_clock": hex::encode(f.output_digest_at_observed_clock),
                    "resolved_ts_at_observed_clock": f.resolved_ts_at_observed_clock,
                    "model": "world_index::resolve::resolve_bell replayed on scratch copies; the program applies its own; the output digest depends on the execution clock",
                    "roster_rent_rule": "handler precondition when created: the fee payer holds the roster's full minimum balance (Insufficient otherwise); the creation then tops the address up",
                }),
            ),
            Duty::SettleTransit(f) => ("WideSettleTransit", f.describe()),
        };
        json!({
            "kind": kind,
            "facts": facts,
            "accounts": self.instruction.accounts.len(),
            "data_len": self.instruction.data.len(),
            "payer": self.payer.to_string(),
            "min_slot": self.min_slot,
            "observed_clock_slot": self.observed_clock.map(|c| c.slot),
            "coherent": self.coherent(),
            "snapshot": self.snapshot().map(SnapshotMeta::describe),
            "status_promoted_by_clock": self.status_promoted_by_clock,
            "signed": self.signed,
            "automatic_send": self.automatic_send,
        })
    }
}

// ------------------------------------------------------------ helpers

pub(crate) fn ctx_of(scope: &Scope) -> AddrCtx {
    AddrCtx {
        season: scope.season.to_bytes(),
        program: scope.program.to_bytes(),
    }
}

pub(crate) fn addr(b: [u8; 32]) -> Address {
    Address::new_from_array(b)
}

/// The addresses among `want` that `reads` does not hold yet.
pub(crate) fn missing(reads: &Reads, want: &[Address]) -> Vec<Address> {
    want.iter()
        .filter(|a| !reads.accounts.contains_key(a))
        .copied()
        .collect()
}

macro_rules! need {
    ($reads:expr, $want:expr) => {{
        let m = missing($reads, &$want);
        if !m.is_empty() {
            return Step::Need(m);
        }
    }};
}

macro_rules! tri {
    ($e:expr) => {
        match $e {
            Ok(v) => v,
            Err(b) => return Step::Done(Err(b)),
        }
    };
}

/// A read account at `a`: `None` when absent (System-owned, no data),
/// `Some` when present and program-owned (`ForeignOwner` otherwise).
pub(crate) fn presence<'a>(
    reads: &'a Reads,
    a: &Address,
    program: &Address,
    what: &'static str,
) -> Result<Option<&'a Account>, Block> {
    match reads.accounts.get(a) {
        None => Err(Block::Read(format!("{what} not read"))),
        Some(None) => Ok(None),
        Some(Some(acc)) => {
            if is_absent(&acc.owner, &acc.data) {
                return Ok(None);
            }
            if acc.owner != *program {
                return Err(Block::ForeignOwner(what));
            }
            Ok(Some(acc))
        }
    }
}

/// The Season of a settlement (`settle_season`): present, program-owned,
/// decodable, at the PDA of its stored id and bump; its effective status
/// `Running` or `Ended` — stored `Seeded` is promoted to `Running` exactly as
/// the handler's `effective_status` does, but only against the
/// **separately observed** clock (`SeasonDependsOnClock` without one,
/// `SeasonNotStarted` before genesis); the **pinned** exact program version
/// (which must also carry the wide bit) and ruleset hash. Returns the
/// Season and whether the status came from the clock.
pub(crate) fn season_of(scope: &Scope, reads: &Reads) -> Result<(Season, bool), Block> {
    let acc =
        presence(reads, &scope.season, &scope.program, "season")?.ok_or(Block::Absent("season"))?;
    let s = Season::decode(&acc.data).map_err(|_| Block::Unreadable("season"))?;
    let (pda, bump) = fclient::addr::season_pda(&scope.program, s.h.season_id);
    if pda != scope.season || bump != s.bump {
        return Err(Block::NotCanonical("season"));
    }
    let promoted = match s.status {
        status::RUNNING | status::ENDED => false,
        status::SEEDED => match reads.clock {
            None => return Err(Block::SeasonDependsOnClock),
            Some(c) if c.unix_timestamp >= s.genesis_ts => true,
            Some(c) => {
                return Err(Block::SeasonNotStarted {
                    genesis_ts: s.genesis_ts,
                    observed: c.unix_timestamp,
                })
            }
        },
        other => return Err(Block::SeasonStatus(other)),
    };
    let Some(dep) = scope.deployment else {
        return Err(Block::DeploymentUnpinned);
    };
    if s.program_version != dep.program_version {
        return Err(Block::ProgramVersion {
            expected: dep.program_version,
            got: s.program_version,
        });
    }
    if s.program_version & wix::WIDE_EXPERIMENTAL_VERSION_BIT == 0 {
        return Err(Block::Season(
            "pinned version is not a wide build (version bit clear)",
        ));
    }
    if s.ruleset_hash != dep.ruleset_hash {
        return Err(Block::RulesetHash);
    }
    Ok((s, promoted))
}

/// The event-chain headroom of a chained account: `seq + n` must not
/// overflow (`event::advance` → the handler's `Overflow`).
pub(crate) fn chain_headroom(d: &[u8], n: u64, what: &'static str) -> Result<(), Block> {
    let seq = rd_u64(d, header::EVENT_SEQ).ok_or(Block::Unreadable(what))?;
    seq.checked_add(n)
        .map(|_| ())
        .ok_or(Block::ChainOverflow(what))
}

/// A wide province of this season and world at `a`, canonical; `None`
/// when absent.
pub(crate) fn province_at<'a>(
    reads: &'a Reads,
    scope: &Scope,
    ctx: &AddrCtx,
    a: &Address,
    season_id: u64,
    world: WorldId,
    what: &'static str,
) -> Result<Option<(WideProvince, &'a [u8])>, Block> {
    let Some(acc) = presence(reads, a, &scope.program, what)? else {
        return Ok(None);
    };
    let p = WideProvince::read(&acc.data).map_err(|_| Block::Unreadable(what))?;
    if p.season_id != season_id {
        return Err(Block::NotCanonical(what));
    }
    if p.world != world {
        return Err(Block::World);
    }
    if wl::province_address(ctx, p.coord) != a.to_bytes() {
        return Err(Block::NotCanonical(what));
    }
    Ok(Some((p, acc.data.as_slice())))
}

pub(crate) fn holding_at<'a>(
    reads: &'a Reads,
    scope: &Scope,
    ctx: &AddrCtx,
    a: &Address,
    season_id: u64,
    world: WorldId,
) -> Result<Option<(WideHolding, &'a [u8])>, Block> {
    let Some(acc) = presence(reads, a, &scope.program, "holding")? else {
        return Ok(None);
    };
    let h = WideHolding::read(&acc.data).map_err(|_| Block::Unreadable("holding"))?;
    if h.season_id != season_id {
        return Err(Block::NotCanonical("holding"));
    }
    if h.world != world {
        return Err(Block::World);
    }
    if wh::holding_address(ctx, h.coord, h.site) != a.to_bytes() {
        return Err(Block::NotCanonical("holding"));
    }
    Ok(Some((h, acc.data.as_slice())))
}

pub(crate) fn roster_at<'a>(
    reads: &'a Reads,
    scope: &Scope,
    a: &Address,
    season_id: u64,
    province: ProvinceKey,
) -> Result<Option<(WideRoster, &'a [u8])>, Block> {
    let Some(acc) = presence(reads, a, &scope.program, "roster")? else {
        return Ok(None);
    };
    let r = WideRoster::read(&acc.data).map_err(|_| Block::Unreadable("roster"))?;
    if r.season_id != season_id || r.province != province {
        return Err(Block::NotCanonical("roster"));
    }
    Ok(Some((r, acc.data.as_slice())))
}

pub(crate) fn transit_at(
    reads: &Reads,
    scope: &Scope,
    a: &Address,
) -> Result<Option<WideTransit>, Block> {
    let Some(acc) = presence(reads, a, &scope.program, "transit")? else {
        return Ok(None);
    };
    WideTransit::from_bytes(&acc.data)
        .map(Some)
        .map_err(|_| Block::Unreadable("transit"))
}

/// The handler's `capture_lock_of`: a live holding (provisional or final)
/// whose site mirror in `pd` shows a completed, unsettled capture is
/// locked.
pub(crate) fn capture_lock_of(pd: &[u8], hd: &[u8]) -> Result<(), Block> {
    let state = rd_u8(hd, H::STATE).ok_or(Block::Unreadable("holding"))?;
    if matches!(state, H::STATE_PROVISIONAL | H::STATE_FINAL) {
        let site = rd_u8(hd, H::SITE).ok_or(Block::Unreadable("holding"))?;
        let gen = rd_u8(hd, H::GEN).ok_or(Block::Unreadable("holding"))?;
        match capture_locked(pd, site, gen) {
            Some(false) => {}
            Some(true) => return Err(Block::CapturePending),
            None => return Err(Block::Unreadable("province")),
        }
    }
    Ok(())
}

/// Account metas from an ABI table and the keys in table order. The
/// optional groups are filled as far as the keys go.
pub(crate) fn metas(table: &[Group], keys: &[Address]) -> Vec<AccountMeta> {
    let specs: Vec<_> = table.iter().flat_map(|g| g.specs.iter()).collect();
    keys.iter()
        .zip(specs)
        .map(|(k, s)| AccountMeta {
            pubkey: *k,
            is_signer: s.signer,
            is_writable: matches!(s.wr, Wr::W),
        })
        .collect()
}

#[allow(clippy::too_many_arguments)]
fn candidate(
    scope: &Scope,
    reads: &Reads,
    payer: Address,
    duty: Duty,
    table: &[Group],
    keys: &[Address],
    data: Vec<u8>,
    status_promoted_by_clock: bool,
) -> Candidate {
    candidate_with(
        scope,
        reads,
        payer,
        duty,
        metas(table, keys),
        data,
        status_promoted_by_clock,
    )
}

/// [`candidate`] over account metas the planner built itself (a repeated
/// group the table's flat zip cannot express).
pub(crate) fn candidate_with(
    scope: &Scope,
    reads: &Reads,
    payer: Address,
    duty: Duty,
    accounts: Vec<AccountMeta>,
    data: Vec<u8>,
    status_promoted_by_clock: bool,
) -> Candidate {
    let mut c = Candidate {
        duty,
        instruction: Instruction {
            program_id: scope.program,
            accounts,
            data,
        },
        payer,
        min_slot: reads.min_slot,
        observed_clock: reads.clock,
        bound: None,
        status_promoted_by_clock,
        signed: false,
        automatic_send: AUTOMATIC_SEND,
    };
    // Coherence is decided by re-verifying the sealed meta over the very
    // reads this plan used; a meta present but not verifying is dropped
    // (non-coherent), never carried. The meta is bound to the digest of
    // the content as produced here.
    c.bound = reads.coherent_snapshot().cloned().map(|meta| Bound {
        meta,
        content: c.content(),
    });
    c
}

// ------------------------------------------------------------ SettleDeparture

/// Plans WideSettleDeparture for `host`'s march in `transit_slot` from the
/// reads, in the handler's order. Asks for the Season, the holding and the
/// transit record first; then the origin province and its roster.
pub fn plan_settle_departure(
    scope: &Scope,
    payer: Address,
    host: WideHostRef,
    transit_slot: u8,
    reads: &Reads,
) -> Step<Candidate> {
    let ctx = ctx_of(scope);
    let world =
        tri!(WorldId::derive_legacy_season(&ctx.season, &ctx.program).map_err(|_| Block::World));
    if host.key().world() != world {
        return Step::Done(Err(Block::World));
    }
    if transit_slot as usize >= H::TRANSIT_N {
        return Step::Done(Err(Block::BadSlot(transit_slot)));
    }
    let holding_key = wh::holding_address(&ctx, host.key().coord(), host.site());
    let holding_addr = addr(holding_key);
    let transit_addr = addr(wm::transit_address(&ctx, &holding_key, transit_slot));
    need!(reads, [scope.season, holding_addr, transit_addr]);
    let (season, promoted) = tri!(season_of(scope, reads));
    let sid = season.h.season_id;
    // 1. the holding and its transit record.
    let (h, hd) = tri!(
        tri!(holding_at(reads, scope, &ctx, &holding_addr, sid, world))
            .ok_or(Block::Absent("holding"))
    );
    let t = tri!(tri!(transit_at(reads, scope, &transit_addr)).ok_or(Block::NoMarch));
    if t.host != host {
        return Step::Done(Err(Block::TransitOtherHost));
    }
    match t.state {
        MarchState::Departed => {}
        MarchState::Settled | MarchState::DestroyedAtOrigin => {
            return Step::Done(Err(Block::AlreadySettled(t.state)))
        }
        other => return Step::Done(Err(Block::TransitState(other))),
    }
    // 2. the origin province the record names, its roster, the entry.
    let okey = t.origin.key();
    if okey.world() != world {
        return Step::Done(Err(Block::World));
    }
    let origin_addr = addr(wl::province_address(&ctx, okey.coord()));
    let roster_addr = addr(wro::roster_address(&ctx, okey));
    need!(reads, [origin_addr, roster_addr]);
    let (oprov, pd) = tri!(tri!(province_at(
        reads,
        scope,
        &ctx,
        &origin_addr,
        sid,
        world,
        "origin_province"
    ))
    .ok_or(Block::Absent("origin_province")));
    if oprov.coord != okey.coord() {
        return Step::Done(Err(Block::NotCanonical("origin_province")));
    }
    let origin_is_home = okey.coord() == h.coord;
    if origin_is_home {
        tri!(capture_lock_of(pd, hd));
    }
    let rn = tri!(rd_u32(pd, PV::RESOLVED_NEXT).ok_or(Block::Unreadable("origin_province")));
    if rn <= t.depart_bell {
        return Step::Done(Err(Block::TooEarly {
            resolved_next: rn,
            depart_bell: t.depart_bell,
        }));
    }
    let (roster, rd) =
        tri!(tri!(roster_at(reads, scope, &roster_addr, sid, okey)).ok_or(Block::Absent("roster")));
    let live = tri!(wres::live_ids(pd).map_err(|_| Block::RosterUnpaired));
    tri!(roster
        .validate_paired(rd, &live)
        .map_err(|_| Block::RosterUnpaired));
    let alias = wide_host_alias(&host);
    let i = tri!(find_entry(pd, alias).ok_or(Block::NotResident));
    let e = tri!(read_entry(pd, i).map_err(|_| Block::BadEntry));
    if !roster.entry_matches(rd, i, e.id, &host) {
        return Step::Done(Err(Block::EntryUnpaired));
    }
    if e.state != E::STATE_DEPARTED {
        return Step::Done(Err(Block::EntryState(e.state)));
    }
    let kh = tri!(e.to_host().map_err(|_| Block::BadEntry));
    let (troops, stamina) = tri!(kh
        .march_values(t.depart_bell, rn)
        .map_err(|er| Block::MarchValues(format!("{er:?}"))));
    // The handler's values: destroyed → zero troops and zero stamina stored.
    let predicted_destroyed = troops < DESTROYED_BELOW;
    let (troops_after, stamina_after) = if predicted_destroyed {
        (0, 0)
    } else {
        (troops, stamina)
    };
    let ready_bell_off = e
        .ready_bell
        .saturating_sub(t.depart_bell)
        .min(u16::MAX as u32) as u16;
    // The DepartureSettled record chains the origin and the holding once each.
    tri!(chain_headroom(pd, 1, "origin_province"));
    tri!(chain_headroom(hd, 1, "holding"));
    let facts = SettleFacts {
        host,
        transit_slot,
        origin: okey,
        depart_bell: t.depart_bell,
        resolved_next: rn,
        entry_index: i,
        kernel_troops_milli: troops,
        kernel_stamina: stamina,
        predicted_destroyed,
        troops_after_milli: troops_after,
        stamina_after,
        ready_bell_off,
        origin_is_home,
    };
    let keys = [
        payer,
        scope.season,
        origin_addr,
        holding_addr,
        roster_addr,
        transit_addr,
    ];
    let data = SettleDeparture {
        host: host.to_bytes(),
        transit_slot,
    }
    .to_bytes()
    .to_vec();
    Step::Done(Ok(candidate(
        scope,
        reads,
        payer,
        Duty::SettleDeparture(facts),
        wix::SETTLE_DEPARTURE,
        &keys,
        data,
        promoted,
    )))
}

// ------------------------------------------------------------ Return

/// Plans WideReturn of the departed Leave entries of `holding` (a holding
/// reference: coordinate and site; its generation is the reference's and
/// decides the credit, not the record's validity) standing in `standing`.
/// Asks for the Season, the province, its roster, the holding and the four
/// transit records; then, for a holding in another province, its own
/// province.
pub fn plan_return(
    scope: &Scope,
    payer: Address,
    standing: ProvinceKey,
    holding: WideHostRef,
    reads: &Reads,
) -> Step<Candidate> {
    let ctx = ctx_of(scope);
    let world =
        tri!(WorldId::derive_legacy_season(&ctx.season, &ctx.program).map_err(|_| Block::World));
    if standing.world() != world || holding.key().world() != world {
        return Step::Done(Err(Block::World));
    }
    let province_addr = addr(wl::province_address(&ctx, standing.coord()));
    let roster_addr = addr(wro::roster_address(&ctx, standing));
    let holding_key = wh::holding_address(&ctx, holding.key().coord(), holding.site());
    let holding_addr = addr(holding_key);
    let transit_addrs: [Address; H::TRANSIT_N] =
        std::array::from_fn(|s| addr(wm::transit_address(&ctx, &holding_key, s as u8)));
    let mut want = vec![scope.season, province_addr, roster_addr, holding_addr];
    want.extend_from_slice(&transit_addrs);
    need!(reads, want);
    let (season, promoted) = tri!(season_of(scope, reads));
    let sid = season.h.season_id;
    let (prov, pd) = tri!(tri!(province_at(
        reads,
        scope,
        &ctx,
        &province_addr,
        sid,
        world,
        "province"
    ))
    .ok_or(Block::Absent("province")));
    if prov.coord != standing.coord() {
        return Step::Done(Err(Block::NotCanonical("province")));
    }
    let (roster, rd) =
        tri!(tri!(roster_at(reads, scope, &roster_addr, sid, standing)).ok_or(Block::NoRoster));
    let live_ids = tri!(wres::live_ids(pd).map_err(|_| Block::RosterUnpaired));
    tri!(roster
        .validate_paired(rd, &live_ids)
        .map_err(|_| Block::RosterUnpaired));
    // The holding: present (its live generation) or absent (its hosts
    // strand). The capture lock is read in the holding's **own** province.
    let held = tri!(holding_at(reads, scope, &ctx, &holding_addr, sid, world));
    let mut foreign = false;
    let mut own_addr: Option<Address> = None;
    let live = match &held {
        Some((h, hd)) => {
            if h.coord == standing.coord() {
                tri!(capture_lock_of(pd, hd));
            } else {
                let oa = addr(wl::province_address(&ctx, h.coord));
                need!(reads, [oa]);
                let (op, opd) = tri!(tri!(province_at(
                    reads,
                    scope,
                    &ctx,
                    &oa,
                    sid,
                    world,
                    "holding_province"
                ))
                .ok_or(Block::Absent("holding_province")));
                if op.coord != h.coord {
                    return Step::Done(Err(Block::NotCanonical("holding_province")));
                }
                tri!(capture_lock_of(opd, hd));
                foreign = true;
                own_addr = Some(oa);
            }
            let state = tri!(rd_u8(hd, H::STATE).ok_or(Block::Unreadable("holding")));
            matches!(state, H::STATE_PROVISIONAL | H::STATE_FINAL).then_some(h.gen)
        }
        None => None,
    };
    // The holding's four wide transit records, each absent or readable.
    let mut open: [Option<WideTransit>; H::TRANSIT_N] = [None; H::TRANSIT_N];
    for (s, a) in transit_addrs.iter().enumerate() {
        open[s] = tri!(transit_at(reads, scope, a));
    }
    // Selection, in entry order, by full identity.
    let mut picks: Vec<ReturnPick> = Vec::new();
    let mut skipped_in_transit = 0usize;
    for i in 0..PV::ENTRIES_N {
        let e = tri!(read_entry(pd, i).map_err(|_| Block::BadEntry));
        if e.state != E::STATE_DEPARTED || !matches!(e.op, EntryOp::Leave) {
            continue;
        }
        let r = tri!(
            tri!(roster.ref_at(rd, i).map_err(|_| Block::RosterUnpaired))
                .ok_or(Block::RosterUnpaired)
        );
        if wide_host_alias(&r) != e.id {
            return Step::Done(Err(Block::RosterUnpaired));
        }
        let mine = r.key().world() == world
            && wh::holding_address(&ctx, r.key().coord(), r.site()) == holding_key;
        if !mine {
            continue;
        }
        if open.iter().flatten().any(|t| t.host == r) {
            skipped_in_transit += 1;
            continue;
        }
        let credited = live == Some(r.gen());
        picks.push(ReturnPick {
            entry_index: i,
            host: r,
            credited,
            unit: e.unit,
            whole_troops: e.troops / MILLI as u32,
        });
        if picks.len() == RETURN_MAX {
            break;
        }
    }
    if picks.is_empty() {
        return Step::Done(Err(if skipped_in_transit > 0 {
            Block::HostInTransit
        } else {
            Block::NothingToReturn
        }));
    }
    // The reserve credit must fit (the handler's checked add).
    let credited = picks.iter().filter(|p| p.credited).count() as u64;
    if live.is_some() {
        let hd = held
            .as_ref()
            .map(|(_, d)| *d)
            .expect("live implies present");
        let mut reserve = [0u32; H::RESERVE_N];
        for (u, v) in reserve.iter_mut().enumerate() {
            *v = tri!(rd_u32(hd, H::reserve(u)).ok_or(Block::Unreadable("holding")));
        }
        for p in picks.iter().filter(|p| p.credited) {
            let slot = tri!(reserve.get_mut(p.unit as usize).ok_or(Block::BadEntry));
            *slot = tri!(slot
                .checked_add(p.whole_troops)
                .ok_or(Block::ReserveOverflow { unit: p.unit }));
        }
    }
    // The event chains: one record per picked entry on the province
    // (`Return` or `Stranded`), and the `Return` records also chain the
    // holding — one per credited entry.
    tri!(chain_headroom(pd, picks.len() as u64, "province"));
    if credited > 0 {
        let hd = held
            .as_ref()
            .map(|(_, d)| *d)
            .expect("credited implies present");
        tri!(chain_headroom(hd, credited, "holding"));
    }
    let facts = ReturnFacts {
        standing,
        holding: holding.holding_ref(),
        holding_present: held.is_some(),
        live_gen: live,
        foreign,
        picks,
        skipped_in_transit,
    };
    let mut keys = vec![
        payer,
        scope.season,
        province_addr,
        roster_addr,
        holding_addr,
    ];
    keys.extend_from_slice(&transit_addrs);
    if let Some(oa) = own_addr {
        keys.push(oa);
    }
    Step::Done(Ok(candidate(
        scope,
        reads,
        payer,
        Duty::Return(facts),
        wix::RETURN,
        &keys,
        Return.to_bytes().to_vec(),
        promoted,
    )))
}

// ------------------------------------------------------------ Gather

/// The packet one transaction must fit: the extractor's wire bound
/// (`crate::widefollow::MAX_RECORD_WIRE_BYTES`, 1,232 bytes).
pub const GATHER_PACKET_BYTES: usize = crate::widefollow::MAX_RECORD_WIRE_BYTES;

/// The positions of a gather (6 factions × 4 slots), the handler's.
pub const GATHER_POSITIONS: u8 = wix::GATHER_POSITIONS;

/// The most positions one planned gather takes, fixed **before** any slot
/// is read so that no position outside the cursor is ever judged. Sized
/// so that a cursor with every position present fits one packet under
/// the widest budget prefix: a legacy message with one signature is
/// `479 + 66·n` bytes when all `n` slots are present (10 fixed keys plus a
/// slot key and a transit key per position, two account indices per
/// position, the four ComputeBudget instructions at full width and the
/// 10-byte Gather data), plus 32 when the payer is also an instruction
/// key; `n = 8` gives at most 1,039 of the 1,232 (`n = 11` would not fit).
/// [`packet_len`] guards the built instruction regardless.
pub const GATHER_MAX_POSITIONS: usize = 8;

/// Read rounds a live-read plan may take before `ReadLoop`: the gather
/// asks in four waves (Season, destination, inputs and day; anchor and
/// archive; the cursor's slots; the present slots' transits) and decides
/// at the fifth evaluation; the settles and the return take fewer.
pub const MAX_READ_ROUNDS: usize = 6;

/// The widest ComputeBudget prefix the keeper's engine may put before an
/// instruction (limit, price, loaded-data limit and a heap frame: four
/// instructions at their full widths). The planner sizes the packet
/// against it; the engine chooses the actual values.
fn widest_budget() -> TxBudget {
    TxBudget {
        cu_limit: u32::MAX,
        cu_price: u64::MAX,
        loaded_limit: u32::MAX,
        heap: Some(u32::MAX),
    }
}

/// The wire length of `ix` alone as one unsigned legacy transaction paid
/// by `payer` under the widest budget prefix (one signature). When the
/// payer is also one of the instruction's keys (the all-zero review
/// placeholder is the System Program) the message holds it once; 32 bytes
/// are added so the bound also holds for a wallet that is not.
pub fn packet_len(ix: &Instruction, payer: &Address) -> usize {
    let msg = fclient::tx::message(
        std::slice::from_ref(ix),
        &widest_budget(),
        payer,
        &Hash::default(),
    );
    let t = Transaction::new_unsigned(msg);
    let collide = ix.accounts.iter().any(|m| m.pubkey == *payer);
    fclient::tx::wire(&t).len() + if collide { 32 } else { 0 }
}

/// `A` of THE anchor of `(bell, region)` as the handler's `anchor_time`
/// reads it from the account at its canonical address, or from the
/// region-half-day archive once the bell is archived (then also the
/// archive entry's seed, which `bell_seed` takes from the same account).
pub struct AnchorRead {
    /// The account the instruction names in the anchor position.
    pub key: Address,
    /// `"anchor"` or `"archive"`.
    pub source: &'static str,
    pub a_ts: i64,
    /// The archive entry's seed when the source is the archive.
    pub archive_seed: Option<[u8; 32]>,
    /// The round-`T(bell)` signature the account stores (THE anchor's
    /// `sig48`, or the archive entry's `sig`): the chain's, which the
    /// settle handler decompresses and opens the seal under.
    pub sig48: [u8; 48],
    /// THE anchor's landing slot; `None` once archived (the archive does
    /// not keep it).
    pub anchor_slot: Option<u64>,
}

/// Reads THE anchor or its archive entry from `reads` (both addresses
/// already requested by the caller). `NoAnchor` when neither holds the
/// bell; `NotCanonical` when the account at the address is another's.
pub(crate) fn anchor_read(
    reads: &Reads,
    scope: &Scope,
    ctx: &AddrCtx,
    sid: u64,
    genesis_ts: i64,
    bell: u32,
    region: u8,
) -> Result<AnchorRead, Block> {
    let anchor_addr = addr(ctx.bell_anchor(bell, region));
    let part = archive_part_of(bell);
    let archive_addr = addr(ctx.anchor_archive(region, part));
    match presence(reads, &anchor_addr, &scope.program, "anchor")? {
        Some(acc) => {
            let a = BellAnchor::decode(&acc.data).map_err(|_| Block::Unreadable("anchor"))?;
            if a.season_id != sid || a.bell != bell || a.region != region {
                return Err(Block::NotCanonical("anchor"));
            }
            Ok(AnchorRead {
                key: anchor_addr,
                source: "anchor",
                a_ts: a.a,
                archive_seed: None,
                sig48: a.sig48,
                anchor_slot: Some(a.slot),
            })
        }
        None => match presence(reads, &archive_addr, &scope.program, "archive")? {
            None => Err(Block::NoAnchor("absent")),
            Some(acc) => {
                let ar =
                    AnchorArchive::decode(&acc.data).map_err(|_| Block::Unreadable("archive"))?;
                if ar.season_id != sid || ar.region != region || ar.part != part {
                    return Err(Block::NotCanonical("archive"));
                }
                if !ar.is_archived(bell) {
                    return Err(Block::NoAnchor("archive without the bell"));
                }
                let e = ar
                    .entries
                    .get(bell as usize % AA::ENTRIES_N)
                    .ok_or(Block::Unreadable("archive"))?;
                let a = bell_end(genesis_ts, bell)
                    .checked_add(e.a_off as i64)
                    .ok_or(Block::Overflow("anchor time"))?;
                Ok(AnchorRead {
                    key: archive_addr,
                    source: "archive",
                    a_ts: a,
                    archive_seed: Some(e.seed),
                    sig48: e.sig,
                    anchor_slot: None,
                })
            }
        },
    }
}

/// A present slot of the cursor as read, before the instruction is sized.
struct SlotRead {
    position: u8,
    slot: wa::WideArrivalSlot,
    transit_addr: Address,
}

/// Plans WideGather of `(dest, bell)`: the first ungathered position and
/// the contiguous ungathered run after it, cut to what one packet carries.
/// Asks for the Season, the destination, the ClashInputs and the
/// ArrivalDay; then THE anchor and its archive; then the run's slots; then
/// the present slots' transit records. Module doc: the rules and their
/// order.
pub fn plan_gather(
    scope: &Scope,
    payer: Address,
    dest: ProvinceKey,
    bell: u32,
    reads: &Reads,
) -> Step<Candidate> {
    let ctx = ctx_of(scope);
    let world =
        tri!(WorldId::derive_legacy_season(&ctx.season, &ctx.program).map_err(|_| Block::World));
    if dest.world() != world {
        return Step::Done(Err(Block::World));
    }
    let dest_addr = addr(wl::province_address(&ctx, dest.coord()));
    let inputs_addr = addr(wa::clash_inputs_address(&ctx, dest, bell));
    let day = wa::day_of(bell);
    let day_addr = addr(wa::arrival_day_address(&ctx, dest, day));
    need!(reads, [scope.season, dest_addr, inputs_addr, day_addr]);
    let (season, promoted) = tri!(season_of(scope, reads));
    let sid = season.h.season_id;
    // 1. the destination, the latch, the end bell.
    let (prov, pd) = tri!(tri!(province_at(
        reads,
        scope,
        &ctx,
        &dest_addr,
        sid,
        world,
        "dest_province"
    ))
    .ok_or(Block::Absent("dest_province")));
    if prov.coord != dest.coord() {
        return Step::Done(Err(Block::NotCanonical("dest_province")));
    }
    let rn = tri!(rd_u32(pd, PV::RESOLVED_NEXT).ok_or(Block::Unreadable("dest_province")));
    if bell < rn {
        return Step::Done(Err(Block::LatchClosed(
            "destination resolved past the bell",
        )));
    }
    if bell >= season.end_bell {
        return Step::Done(Err(Block::SeasonEnded));
    }
    let region = prov.region;
    // 2. the window: THE anchor of (bell, region), or its archive entry.
    let anchor_addr = addr(ctx.bell_anchor(bell, region));
    let archive_addr = addr(ctx.anchor_archive(region, archive_part_of(bell)));
    need!(reads, [anchor_addr, archive_addr]);
    let an = tri!(anchor_read(
        reads,
        scope,
        &ctx,
        sid,
        season.genesis_ts,
        bell,
        region
    ));
    let (anchor_key, anchor_source, a_ts) = (an.key, an.source, an.a_ts);
    let Some(now) = reads.clock else {
        return Step::Done(Err(Block::TimingNeedsClock));
    };
    let clock = SeasonClock::from_season(&season);
    let close = clock.reveal_close(bell, a_ts);
    if now.unix_timestamp < close {
        return Step::Done(Err(Block::WindowOpen {
            reveal_close: close,
            now: now.unix_timestamp,
        }));
    }
    // 3. the ClashInputs: absent (created), or this record's, not resolved.
    //    Absent: the lamports already at the address (a prefunded System
    //    account, or nothing) are what the creation's top-up nets
    //    (`init::top_up`: the payer covers only the shortfall).
    let (inputs_present, mask_before, cd, inputs_prefunded_lamports) =
        match tri!(presence(reads, &inputs_addr, &scope.program, "inputs")) {
            None => {
                let held = reads
                    .accounts
                    .get(&inputs_addr)
                    .and_then(|a| a.as_ref())
                    .map_or(0, |a| a.lamports);
                (false, 0u32, None, held)
            }
            Some(acc) => {
                let ih = tri!(wa::WideClashInputsHdr::read(&acc.data)
                    .map_err(|_| Block::Unreadable("inputs")));
                if ih.season_id != sid || ih.dest != dest || ih.bell != bell {
                    return Step::Done(Err(Block::NotCanonical("inputs")));
                }
                if ih.flags & wa::wide_clash_inputs::FLAG_RESOLVED != 0 {
                    return Step::Done(Err(Block::AlreadyResolved));
                }
                (true, ih.arrivals_mask, Some(acc.data.as_slice()), 0)
            }
        };
    if mask_before == wa::wide_clash_inputs::ALL_GATHERED {
        return Step::Done(Err(Block::AlreadyGathered));
    }
    // 4. the arrival evidence: the ArrivalDay's bit. Clear, the handler
    //    completes the record without reading a slot: with no record that
    //    is a complete empty record the resolve does not need (not
    //    planned: `NoArrivals`, a policy); with a partial record it is the
    //    completing gather the resolve requires (planned, one position).
    let day_bit_set = match tri!(presence(reads, &day_addr, &scope.program, "arrivalday")) {
        None => false,
        Some(acc) => {
            let d =
                tri!(wa::WideArrivalDay::read(&acc.data)
                    .map_err(|_| Block::Unreadable("arrivalday")));
            if d.season_id != sid || d.dest != dest || d.day != day {
                return Step::Done(Err(Block::NotCanonical("arrivalday")));
            }
            d.has(bell)
        }
    };
    if !day_bit_set && !inputs_present {
        return Step::Done(Err(Block::NoArrivals));
    }
    // 5. the cursor, bounded **before** any slot is read: the first
    //    ungathered position and the contiguous ungathered run after it, at
    //    most `GATHER_MAX_POSITIONS` (every position present still fits one
    //    packet under the widest budget prefix); one position when the day
    //    bit is clear (the handler reads no slot then).
    let positions = GATHER_POSITIONS as usize;
    let start = (0..positions)
        .find(|k| mask_before & (1u32 << k) == 0)
        .expect("not every position is gathered");
    let mut run_end = start;
    while run_end < positions
        && run_end - start < GATHER_MAX_POSITIONS
        && mask_before & (1u32 << run_end) == 0
    {
        run_end += 1;
    }
    if !day_bit_set {
        run_end = start + 1;
    }
    let slot_addrs: Vec<Address> = (start..run_end)
        .map(|k| {
            addr(wa::arrival_slot_address(
                &ctx,
                dest,
                bell,
                (k / 4) as u8,
                (k % 4) as u8,
            ))
        })
        .collect();
    let mut n = run_end - start;
    let mut slots: BTreeMap<u8, (GatherSlot, Address)> = BTreeMap::new();
    let mut cut_at_unsettled: Option<u8> = None;
    if day_bit_set {
        need!(reads, slot_addrs.clone());
        // 6. the slots of the cursor, each absent or this record's position.
        let mut present: Vec<SlotRead> = Vec::new();
        for (j, k) in (start..run_end).enumerate() {
            let (f, i) = ((k / 4) as u8, (k % 4) as u8);
            let Some(acc) = tri!(presence(reads, &slot_addrs[j], &scope.program, "slot")) else {
                continue;
            };
            let s =
                tri!(wa::WideArrivalSlot::read(&acc.data).map_err(|_| Block::Unreadable("slot")));
            if s.season_id != sid || s.dest != dest || s.bell != bell || s.faction != f || s.i != i
            {
                return Step::Done(Err(Block::NotCanonical("slot")));
            }
            let hkey = wh::holding_address(&ctx, s.host.key().coord(), s.host.site());
            let transit_addr = addr(wm::transit_address(&ctx, &hkey, s.transit_slot));
            present.push(SlotRead {
                position: k as u8,
                slot: s,
                transit_addr,
            });
        }
        let transit_addrs: Vec<Address> = present.iter().map(|p| p.transit_addr).collect();
        need!(reads, transit_addrs);
        // 7. each present slot's transit record, as `gather_arrival` judges
        //    it, in position order. A `Departed` record (the origin has not
        //    settled) at the first position blocks; later in the cursor it
        //    cuts the cursor before it: the ready prefix is a valid gather
        //    and the handler never sees the unsettled position.
        for p in &present {
            if cut_at_unsettled.is_some() {
                break;
            }
            let s = &p.slot;
            let t = tri!(
                tri!(transit_at(reads, scope, &p.transit_addr)).ok_or(Block::Absent("transit"))
            );
            if t.host != s.host || t.arrive_bell != bell {
                return Step::Done(Err(Block::NotCanonical("transit")));
            }
            let stamps = match t.state {
                MarchState::Departed => {
                    if p.position as usize == start {
                        return Step::Done(Err(Block::DepartureUnsettled {
                            position: p.position,
                        }));
                    }
                    cut_at_unsettled = Some(p.position);
                    n = p.position as usize - start;
                    continue;
                }
                MarchState::Free => return Step::Done(Err(Block::TransitState(t.state))),
                MarchState::Gathered => {
                    if t.dest != Some(dest) {
                        return Step::Done(Err(Block::NotCanonical("transit")));
                    }
                    false
                }
                MarchState::Settled | MarchState::DestroyedAtOrigin => {
                    tri!(t
                        .step(MarchEvent::Gather { dest }, None)
                        .map_err(|_| Block::TransitState(t.state)));
                    true
                }
            };
            let (predicted_destroyed, troops, stamina) = if t.state == MarchState::DestroyedAtOrigin
            {
                (true, 0, 0)
            } else {
                let troops = t.troops_after;
                let stamina = arrival_stamina(t.stamina_after, t.depart_bell, bell);
                (troops < DESTROYED_BELOW, troops, stamina)
            };
            slots.insert(
                p.position,
                (
                    GatherSlot {
                        host: s.host,
                        transit_slot: s.transit_slot,
                        transit_state: t.state,
                        stamps,
                        predicted_present: !predicted_destroyed,
                        predicted_destroyed,
                        troops_milli: troops,
                        stamina,
                    },
                    p.transit_addr,
                ),
            );
        }
    }
    // 8. the instruction: the fixed eight, then one `[slot r] [transit
    //    r|w]` pair per position of the cursor; an absent (or unread) slot's
    //    transit position is the slot's own address, read-only. The packet
    //    bound is a guard here, never a trim: the cursor was bounded first.
    let fixed = [
        payer,
        scope.season,
        dest_addr,
        anchor_key,
        inputs_addr,
        day_addr,
        fclient::addr::instructions_sysvar(),
        fclient::addr::system_program(),
    ];
    let mut accounts = metas(wix::GATHER, &fixed);
    for (j, slot_addr) in slot_addrs.iter().take(n).enumerate() {
        let k = (start + j) as u8;
        accounts.push(AccountMeta::new_readonly(*slot_addr, false));
        match slots.get(&k) {
            Some((s, ta)) => accounts.push(AccountMeta {
                pubkey: *ta,
                is_signer: false,
                is_writable: s.stamps,
            }),
            None => accounts.push(AccountMeta::new_readonly(*slot_addr, false)),
        }
    }
    let ix = Instruction {
        program_id: scope.program,
        accounts,
        data: Gather {
            bell,
            start: start as u8,
            n: n as u8,
        }
        .to_bytes()
        .to_vec(),
    };
    if packet_len(&ix, &payer) > GATHER_PACKET_BYTES {
        return Step::Done(Err(Block::Overflow("packet")));
    }
    // 9. the prediction over the whole record, as the handler scans it:
    //    **every** position of the scratch after the cursor is written —
    //    the cursor's positions as this gather writes them (zeroed, then
    //    the present slots' arrivals; untouched when the day bit is clear),
    //    every other position as the record holds it, masked or not: a
    //    position that does not decode fails the handler (`BadAccount`),
    //    a present arrival anywhere counts.
    let mut mask_after = mask_before;
    if day_bit_set {
        for k in start..start + n {
            mask_after |= 1u32 << k;
        }
    } else {
        mask_after = wa::wide_clash_inputs::ALL_GATHERED;
    }
    let mut n_present: u32 = 0;
    for k in 0..positions {
        if day_bit_set && k >= start && k < start + n {
            if slots
                .get(&(k as u8))
                .is_some_and(|(s, _)| s.predicted_present)
            {
                n_present += 1;
            }
            continue;
        }
        if let Some(cd) = cd {
            let a =
                tri!(wa::WideArrival::read_at(cd, k)
                    .map_err(|_| Block::Unreadable("inputs position")));
            if a.is_some_and(|a| a.present) {
                n_present += 1;
            }
        }
    }
    let mut stamps: u8 = 0;
    let mut out_positions = Vec::with_capacity(n);
    for k in start..start + n {
        let slot = slots.get(&(k as u8)).map(|(s, _)| s.clone());
        if slot.as_ref().is_some_and(|s| s.stamps) {
            stamps += 1;
        }
        out_positions.push(GatherPosition {
            position: k as u8,
            faction: (k / 4) as u8,
            i: (k % 4) as u8,
            slot,
        });
    }
    let predicted_complete = mask_after == wa::wide_clash_inputs::ALL_GATHERED;
    let facts = GatherFacts {
        dest,
        bell,
        region,
        resolved_next: rn,
        start: start as u8,
        n: n as u8,
        day_bit_set,
        cut_at_unsettled,
        inputs_present,
        inputs_prefunded_lamports,
        arrivals_mask_before: mask_before,
        predicted_mask_after: mask_after,
        predicted_n_present: n_present.min(positions as u32) as u8,
        predicted_complete,
        predicted_no_arrivals: predicted_complete && n_present == 0,
        remaining_after: (positions as u32 - mask_after.count_ones()) as u8,
        stamps,
        anchor_source,
        a_ts,
        reveal_close: close,
        judged_at: now.unix_timestamp,
        positions: out_positions,
    };
    let data = ix.data.clone();
    Step::Done(Ok(candidate_with(
        scope,
        reads,
        payer,
        Duty::Gather(facts),
        ix.accounts,
        data,
        promoted,
    )))
}

/// [`plan_gather`] over live reads.
pub async fn gather_via<P: ChainPort>(
    port: &P,
    scope: &Scope,
    payer: Address,
    dest: ProvinceKey,
    bell: u32,
    min_slot: u64,
) -> Result<Candidate, Block> {
    drive(port, min_slot, |r| plan_gather(scope, payer, dest, bell, r)).await
}

/// [`plan_gather`] over one snapshot response, with the Rent sysvar (the
/// gather may create the ClashInputs) and the fee payer's account in it.
pub async fn gather_snapshot<P: ChainPort + SnapshotPort>(
    port: &P,
    scope: &Scope,
    payer: Address,
    dest: ProvinceKey,
    bell: u32,
    min_slot: u64,
) -> Result<(Candidate, Snapshot), Block> {
    snapshot_plan(port, min_slot, true, &[payer], |r| {
        plan_gather(scope, payer, dest, bell, r)
    })
    .await
}

/// From the model: `(destination, arrival bell)` pairs of open marches
/// whose `Revealed` was seen with an arrival bell in the applied history,
/// whose destination has no `Resolve` of that bell and whose ClashInputs
/// is not fully gathered or closed as the records say. A hint of what to
/// **read**: the plan decides from the ArrivalDay and the slots on the
/// chain, never from these records (a reveal the feed missed is still
/// gathered; a reveal the feed shows may be gathered already).
pub fn gather_candidates(d: &WideDiscovery) -> Vec<(ProvinceKey, u32)> {
    let mut out: Vec<(ProvinceKey, u32)> = d
        .hosts
        .values()
        .filter_map(|st| {
            let t = st.transit.as_ref()?;
            if !t.open() {
                return None;
            }
            let r = t.reveal.as_ref()?;
            let bell = r.arrive_bell?;
            let dest = r.dest;
            if d.provinces
                .get(&dest)
                .is_some_and(|p| p.resolved_bells.contains(&bell))
            {
                return None;
            }
            if d.inputs.get(&(dest, bell)).is_some_and(|g| {
                g.closed.is_some() || g.arrivals_mask == wa::wide_clash_inputs::ALL_GATHERED
            }) {
                return None;
            }
            Some((dest, bell))
        })
        .collect();
    out.sort();
    out.dedup();
    out
}

// ------------------------------------------------------------ Resolve

/// SeedCache nonces a bounded probe tries (the legacy `SeedFinder`'s 256:
/// the nonce is the poster's choice and is not derivable).
pub const SEED_NONCES: usize = 256;
/// Keys per `accounts` read of the probe.
const SEED_PROBE_CHUNK: usize = 64;
/// The position of the ClashInputs in [`wix::RESOLVE`] (`Wr::Either`:
/// writable exactly when present).
const RESOLVE_INPUTS: usize = 6;

/// The bell model's refusal as a block: `NotDue` is the handler's
/// `OutOfOrder`, the unported S1/S2 state by name, everything else the
/// ABI's error by name.
fn resolve_block(e: wres::ResolveError) -> Block {
    match e {
        wres::ResolveError::NotDue { next, bell } => Block::OutOfOrder {
            resolved_next: next,
            bell,
        },
        wres::ResolveError::Unported(u) => Block::Unported(match u {
            wres::Unported::Fort => "fort",
            wres::Unported::Caravan => "caravan",
            wres::Unported::ConquestRecord(_) => "conquest record",
            wres::Unported::PendingOp(_) => "pending op",
        }),
        other => Block::ResolveModel(format!("{other:?}")),
    }
}

/// Plans WideResolve of `province`'s current `resolved_next` with
/// `beneficiary` as the resolver the data names (the caller's public
/// address; never chosen here). `seed_nonce`: the SeedCache nonce when THE
/// anchor is present (`SeedNonceUnknown` asks for it; [`find_seed_nonce`]
/// finds it); unused on the archive path. Asks for the Season, the
/// province and the roster; then the anchor, the archive, the inputs and
/// the day; then the cache. Module doc: the rules and their order.
pub fn plan_resolve(
    scope: &Scope,
    payer: Address,
    beneficiary: Address,
    province: ProvinceKey,
    seed_nonce: Option<u8>,
    reads: &Reads,
) -> Step<Candidate> {
    let ctx = ctx_of(scope);
    let world =
        tri!(WorldId::derive_legacy_season(&ctx.season, &ctx.program).map_err(|_| Block::World));
    if province.world() != world {
        return Step::Done(Err(Block::World));
    }
    let province_addr = addr(wl::province_address(&ctx, province.coord()));
    let roster_addr = addr(wro::roster_address(&ctx, province));
    need!(reads, [scope.season, province_addr, roster_addr]);
    let (season, promoted) = tri!(season_of(scope, reads));
    let sid = season.h.season_id;
    let sd: &[u8] = tri!(
        tri!(presence(reads, &scope.season, &scope.program, "season"))
            .ok_or(Block::Absent("season"))
    )
    .data
    .as_slice();
    // 1. the province: canonical, its current bell, the end bell.
    let (prov, pd) = tri!(tri!(province_at(
        reads,
        scope,
        &ctx,
        &province_addr,
        sid,
        world,
        "province"
    ))
    .ok_or(Block::Absent("province")));
    if prov.coord != province.coord() {
        return Step::Done(Err(Block::NotCanonical("province")));
    }
    let bell = tri!(rd_u32(pd, PV::RESOLVED_NEXT).ok_or(Block::Unreadable("province")));
    if bell >= season.end_bell {
        return Step::Done(Err(Block::SeasonEnded));
    }
    let region = prov.region;
    // 2. the window: THE anchor of (bell, region), or its archive entry;
    //    the gathered record and the arrival evidence of the bell.
    let anchor_addr = addr(ctx.bell_anchor(bell, region));
    let archive_addr = addr(ctx.anchor_archive(region, archive_part_of(bell)));
    let inputs_addr = addr(wa::clash_inputs_address(&ctx, province, bell));
    let day = wa::day_of(bell);
    let day_addr = addr(wa::arrival_day_address(&ctx, province, day));
    need!(reads, [anchor_addr, archive_addr, inputs_addr, day_addr]);
    let an = tri!(anchor_read(
        reads,
        scope,
        &ctx,
        sid,
        season.genesis_ts,
        bell,
        region
    ));
    let Some(now) = reads.clock else {
        return Step::Done(Err(Block::TimingNeedsClock));
    };
    let clock = SeasonClock::from_season(&season);
    let close = clock.reveal_close(bell, an.a_ts);
    if now.unix_timestamp < close {
        return Step::Done(Err(Block::WindowOpen {
            reveal_close: close,
            now: now.unix_timestamp,
        }));
    }
    // 3. the bell seed, as `bell_seed` takes it.
    let seed_round = clock.seed_round(bell, an.a_ts);
    let (seed, seed_key, seed_source, seed_nonce_used) = match an.archive_seed {
        Some(s) => (s, an.key, "archive", None),
        None => {
            let Some(nonce) = seed_nonce else {
                return Step::Done(Err(Block::SeedNonceUnknown { bell, region }));
            };
            let cache_addr = addr(ctx.seed_cache(bell, region, nonce));
            need!(reads, [cache_addr]);
            let Some(acc) = tri!(presence(reads, &cache_addr, &scope.program, "seedcache")) else {
                return Step::Done(Err(Block::SeedNotReady("cache absent at the nonce")));
            };
            let c = tri!(SeedCache::decode(&acc.data).map_err(|_| Block::Unreadable("seedcache")));
            if c.season_id != sid || c.bell != bell || c.region != region {
                return Step::Done(Err(Block::NotCanonical("seedcache")));
            }
            if addr(ctx.seed_cache(bell, region, c.nonce)) != cache_addr {
                return Step::Done(Err(Block::NotCanonical("seedcache")));
            }
            if c.anchor_key != an.key || c.a != an.a_ts || c.round != seed_round {
                return Step::Done(Err(Block::SeedNotReady("cache does not match THE anchor")));
            }
            (c.seed, cache_addr, "cache", Some(c.nonce))
        }
    };
    // 4. the arrival evidence and the gathered record.
    let arrivals_expected = match tri!(presence(reads, &day_addr, &scope.program, "arrivalday")) {
        None => false,
        Some(acc) => {
            let d =
                tri!(wa::WideArrivalDay::read(&acc.data)
                    .map_err(|_| Block::Unreadable("arrivalday")));
            if d.season_id != sid || d.dest != province || d.day != day {
                return Step::Done(Err(Block::NotCanonical("arrivalday")));
            }
            d.has(bell)
        }
    };
    let (inputs_present, cd_before): (bool, Vec<u8>) =
        match tri!(presence(reads, &inputs_addr, &scope.program, "inputs")) {
            None => {
                if arrivals_expected {
                    return Step::Done(Err(Block::NotGathered { bell }));
                }
                (false, Vec::new())
            }
            Some(acc) => {
                let ih = tri!(wa::WideClashInputsHdr::read(&acc.data)
                    .map_err(|_| Block::Unreadable("inputs")));
                if ih.season_id != sid || ih.dest != province || ih.bell != bell {
                    return Step::Done(Err(Block::NotCanonical("inputs")));
                }
                if ih.arrivals_mask != wa::wide_clash_inputs::ALL_GATHERED {
                    return Step::Done(Err(Block::NotGathered { bell }));
                }
                if ih.flags & wa::wide_clash_inputs::FLAG_RESOLVED != 0 {
                    return Step::Done(Err(Block::AlreadyResolved));
                }
                (true, acc.data.clone())
            }
        };
    // 5. the step parameters: the Season's conquest block, this build's.
    let Some(prm) = StepParams::of_season(sd) else {
        return Step::Done(Err(Block::ConquestParams));
    };
    if prm.cq.conquest_version != CONQUEST_VERSION {
        return Step::Done(Err(Block::ConquestParams));
    }
    // 6. the roster: present and canonical, or absent while no entry is
    //    live (modelled as the empty table under its would-be header with
    //    the fee payer as rent recipient, as the handler does).
    let live = tri!(wres::live_ids(pd).map_err(|_| Block::RosterUnpaired));
    let live_count = live.iter().flatten().count();
    let (roster, rd_initial, roster_present) =
        match tri!(roster_at(reads, scope, &roster_addr, sid, province)) {
            Some((r, rd)) => (r, rd.to_vec(), true),
            None => {
                if live_count > 0 {
                    return Step::Done(Err(Block::Absent("roster")));
                }
                let r = WideRoster::new(sid, province, payer.to_bytes());
                let mut d = vec![0u8; wro::wide_roster::SIZE];
                tri!(r
                    .write_header(&mut d)
                    .map_err(|_| Block::Unreadable("roster")));
                (r, d, false)
            }
        };
    // The Resolve record chains the province once.
    tri!(chain_headroom(pd, 1, "province"));
    // 7. the input commitment, over the bytes as read.
    let input_digest =
        wev::resolve_input_digest(province, bell, &seed, sd, pd, &rd_initial, &cd_before);
    // 8. the bell model on scratch copies, then the handler's write-backs.
    let mut pd_s = pd.to_vec();
    let mut rd_s = rd_initial.clone();
    let mut cd_s = cd_before.clone();
    let out = tri!(wres::resolve_bell(
        &mut pd_s,
        &roster,
        &mut rd_s,
        (!cd_s.is_empty()).then_some(&cd_before[..]),
        bell,
        &seed,
        &frontier_ruleset(),
        &prm,
    )
    .map_err(resolve_block));
    let resolved_ts = now
        .unix_timestamp
        .saturating_sub(season.genesis_ts)
        .clamp(0, u32::MAX as i64) as u32;
    let n_arrivals = if cd_s.is_empty() {
        0
    } else {
        tri!(wres::write_resolved(&mut cd_s, &out.applied).map_err(resolve_block));
        let mut ih =
            tri!(wa::WideClashInputsHdr::read(&cd_s).map_err(|_| Block::Unreadable("inputs")));
        ih.resolver = beneficiary.to_bytes();
        ih.resolved_ts = resolved_ts;
        tri!(ih.write(&mut cd_s).map_err(|_| Block::Unreadable("inputs")));
        ih.n_present
    };
    {
        let o = PV::RESOLVE_SUMMARY;
        let mut r8 = [0u8; 8];
        r8.copy_from_slice(&beneficiary.to_bytes()[..8]);
        let ok = wr_u32(&mut pd_s, o + SU::BELL, bell)
            & wr_u32(&mut pd_s, o + SU::ENGAGEMENTS, out.clash.engagements)
            & wr_u8(&mut pd_s, o + SU::ARRIVALS, n_arrivals)
            & wr_u8(&mut pd_s, o + SU::DESTROYED, out.applied.destroyed)
            & wr_u8(&mut pd_s, o + SU::BOUNCED, out.applied.bounced)
            & wr_arr(&mut pd_s, o + SU::RESOLVER, &r8);
        if !ok {
            return Step::Done(Err(Block::Unreadable("province")));
        }
    }
    let output_digest = wev::resolve_output_digest(&out.clash.digest(), &pd_s, &rd_s, &cd_s);
    // 9. the roster the bell needed and the province had none of: created
    //    from the fee payer (the full minimum is the handler's guard; the
    //    fee review states it).
    let roster_created = !roster_present && rd_s != rd_initial;
    if roster_created
        && tri!(wres::live_ids(&pd_s).map_err(|_| Block::RosterUnpaired))
            .iter()
            .all(|e| e.is_none())
    {
        return Step::Done(Err(Block::RosterUnpaired));
    }
    // 10. the instruction: the table's nine, the inputs writable exactly
    //     when present (the handler requires it then).
    let keys = [
        payer,
        scope.season,
        province_addr,
        roster_addr,
        seed_key,
        an.key,
        inputs_addr,
        day_addr,
        fclient::addr::system_program(),
    ];
    let mut accounts = metas(wix::RESOLVE, &keys);
    accounts[RESOLVE_INPUTS].is_writable = inputs_present;
    let facts = ResolveFacts {
        province,
        bell,
        region,
        beneficiary,
        seed_source,
        seed_nonce: seed_nonce_used,
        seed_round,
        anchor_source: an.source,
        a_ts: an.a_ts,
        reveal_close: close,
        judged_at: now.unix_timestamp,
        arrivals_expected,
        inputs_present,
        n_arrivals,
        roster_present,
        roster_created,
        live_entries_before: live_count as u8,
        engagements: out.clash.engagements,
        destroyed: out.applied.destroyed,
        bounced: out.applied.bounced,
        settled: out.settled,
        input_digest,
        output_digest_at_observed_clock: output_digest,
        resolved_ts_at_observed_clock: resolved_ts,
    };
    Step::Done(Ok(candidate_with(
        scope,
        reads,
        payer,
        Duty::Resolve(facts),
        accounts,
        Resolve {
            bell,
            beneficiary: beneficiary.to_bytes(),
        }
        .to_bytes()
        .to_vec(),
        promoted,
    )))
}

/// [`plan_resolve`] over live reads.
#[allow(clippy::too_many_arguments)]
pub async fn resolve_via<P: ChainPort>(
    port: &P,
    scope: &Scope,
    payer: Address,
    beneficiary: Address,
    province: ProvinceKey,
    seed_nonce: Option<u8>,
    min_slot: u64,
) -> Result<Candidate, Block> {
    drive(port, min_slot, |r| {
        plan_resolve(scope, payer, beneficiary, province, seed_nonce, r)
    })
    .await
}

/// [`plan_resolve`] over one snapshot response, with the Rent sysvar (the
/// bell may create the roster) and the fee payer's account in it.
#[allow(clippy::too_many_arguments)]
pub async fn resolve_snapshot<P: ChainPort + SnapshotPort>(
    port: &P,
    scope: &Scope,
    payer: Address,
    beneficiary: Address,
    province: ProvinceKey,
    seed_nonce: Option<u8>,
    min_slot: u64,
) -> Result<(Candidate, Snapshot), Block> {
    snapshot_plan(port, min_slot, true, &[payer], |r| {
        plan_resolve(scope, payer, beneficiary, province, seed_nonce, r)
    })
    .await
}

/// The nonces of every SeedCache of `(bell, region)` on chain: the legacy
/// keeper's probe of the [`SEED_NONCES`] canonical addresses, in chunks,
/// through `accounts` alone (at least `min_slot`) — four reads, always.
/// Every present, program-owned, decodable cache whose stored bell, region
/// and nonce are the address's, in nonce order. Which of them agrees with
/// THE anchor is the planner's to judge: a caller that was refused one
/// nonce tries the next, never the same one again.
pub async fn find_seed_nonces<P: ChainPort>(
    port: &P,
    scope: &Scope,
    bell: u32,
    region: u8,
    min_slot: u64,
) -> Result<Vec<u8>, Block> {
    let ctx = ctx_of(scope);
    let keys: Vec<Address> = (0..SEED_NONCES)
        .map(|n| addr(ctx.seed_cache(bell, region, n as u8)))
        .collect();
    let mut found = Vec::new();
    for (i, chunk) in keys.chunks(SEED_PROBE_CHUNK).enumerate() {
        let got = port
            .accounts(chunk, min_slot)
            .await
            .map_err(|e| Block::Read(e.to_string()))?;
        if got.len() != chunk.len() {
            return Err(Block::Read("account count differs from the request".into()));
        }
        for (j, acc) in got.iter().enumerate() {
            let Some(a) = acc else { continue };
            if a.owner != scope.program {
                continue;
            }
            let Ok(c) = SeedCache::decode(&a.data) else {
                continue;
            };
            let nonce = (i * SEED_PROBE_CHUNK + j) as u8;
            if c.bell == bell && c.region == region && c.nonce == nonce {
                found.push(nonce);
            }
        }
    }
    Ok(found)
}

/// The first of [`find_seed_nonces`], if any.
pub async fn find_seed_nonce<P: ChainPort>(
    port: &P,
    scope: &Scope,
    bell: u32,
    region: u8,
    min_slot: u64,
) -> Result<Option<u8>, Block> {
    Ok(find_seed_nonces(port, scope, bell, region, min_slot)
        .await?
        .first()
        .copied())
}

/// From the model: **every** observed province not seen closed, in key
/// order — bounded by the observer's own province limit
/// (`Limits::max_provinces`), never cut here, so the tick's rotating
/// cursor reaches each of them in turn under its plan cap. A hint of what
/// to **read**: the plan takes the province's current `resolved_next`
/// from the chain, so bells without observed arrivals (resident-only
/// bells) are planned too and no intermediate bell is skipped.
pub fn resolve_candidates(d: &WideDiscovery) -> Vec<ProvinceKey> {
    d.provinces
        .iter()
        .filter(|(_, p)| p.closed.is_none())
        .map(|(k, _)| *k)
        .collect()
}

// ------------------------------------------------------------ the read driver

/// Reads at least `min_slot` through the port and plans; the Clock is read
/// once, separately, and recorded as observed (never as coherent). Calls
/// only `clock` and `accounts`; never `simulate` or `send`.
async fn drive<P, F>(port: &P, min_slot: u64, mut plan: F) -> Result<Candidate, Block>
where
    P: ChainPort,
    F: FnMut(&Reads) -> Step<Candidate>,
{
    let mut reads = Reads::new(min_slot);
    reads.clock = port.clock().await.ok();
    for _ in 0..MAX_READ_ROUNDS {
        match plan(&reads) {
            Step::Done(r) => return r,
            Step::Need(addrs) => {
                let got = port
                    .accounts(&addrs, min_slot)
                    .await
                    .map_err(|e| Block::Read(e.to_string()))?;
                if got.len() != addrs.len() {
                    return Err(Block::Read("account count differs from the request".into()));
                }
                for (a, acc) in addrs.iter().zip(got) {
                    reads.accounts.insert(*a, acc);
                }
            }
        }
    }
    Err(Block::ReadLoop)
}

/// [`plan_settle_departure`] over live reads.
pub async fn settle_departure_via<P: ChainPort>(
    port: &P,
    scope: &Scope,
    payer: Address,
    host: WideHostRef,
    transit_slot: u8,
    min_slot: u64,
) -> Result<Candidate, Block> {
    drive(port, min_slot, |r| {
        plan_settle_departure(scope, payer, host, transit_slot, r)
    })
    .await
}

/// [`plan_return`] over live reads.
pub async fn return_via<P: ChainPort>(
    port: &P,
    scope: &Scope,
    payer: Address,
    standing: ProvinceKey,
    holding: WideHostRef,
    min_slot: u64,
) -> Result<Candidate, Block> {
    drive(port, min_slot, |r| {
        plan_return(scope, payer, standing, holding, r)
    })
    .await
}

/// [`plan_settle_departure`] over **one** snapshot response
/// ([`crate::widesnapshot::snapshot_plan`]): the candidate is `coherent`
/// at the response's context slot; the payer's account is in the same
/// response for the fee review. Nothing else changes.
pub async fn settle_departure_snapshot<P: ChainPort + SnapshotPort>(
    port: &P,
    scope: &Scope,
    payer: Address,
    host: WideHostRef,
    transit_slot: u8,
    min_slot: u64,
) -> Result<(Candidate, Snapshot), Block> {
    snapshot_plan(port, min_slot, false, &[payer], |r| {
        plan_settle_departure(scope, payer, host, transit_slot, r)
    })
    .await
}

/// [`plan_return`] over one snapshot response.
pub async fn return_snapshot<P: ChainPort + SnapshotPort>(
    port: &P,
    scope: &Scope,
    payer: Address,
    standing: ProvinceKey,
    holding: WideHostRef,
    min_slot: u64,
) -> Result<(Candidate, Snapshot), Block> {
    snapshot_plan(port, min_slot, false, &[payer], |r| {
        plan_return(scope, payer, standing, holding, r)
    })
    .await
}

// ------------------------------------------------------------ the observer tie

/// From the read-only discovery model: the `(host, transit slot)` pairs
/// whose `Departed` was seen and whose `DepartureSettled` was not, with
/// the march still open. A hint of what to **read**, not a duty: the plan
/// decides from the chain.
pub fn settle_candidates(d: &WideDiscovery) -> Vec<(WideHostRef, u8)> {
    d.hosts
        .iter()
        .filter_map(|(h, st)| {
            let t = st.transit.as_ref()?;
            (t.departure.is_some() && t.departure_settled.is_none() && t.open())
                .then_some((*h, t.slot))
        })
        .collect()
}

/// From the model: `(standing province, holding reference)` pairs with a
/// host whose last presence record was a Dissolve (a Leave pending), the
/// shape [`plan_return`] takes. Deduplicated; a hint only.
pub fn return_candidates(d: &WideDiscovery) -> Vec<(ProvinceKey, WideHostRef)> {
    let mut out: Vec<(ProvinceKey, WideHostRef)> = d
        .hosts
        .iter()
        .filter_map(|(h, st)| {
            matches!(st.presence, Presence::Dissolving { .. })
                .then_some((st.standing, h.holding_ref()))
        })
        .collect();
    out.sort();
    out.dedup();
    out
}
