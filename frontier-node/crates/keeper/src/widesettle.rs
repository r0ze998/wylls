//! **Read-only, opt-in** (feature `wide-world-experimental`): the
//! **unsigned** WideSettleTransit (0xDC op 5) candidate of a march whose
//! seal **opens publicly** and whose host is in the **resolved final set**
//! with a fate that does not come home — the smallest correct slice of the
//! destination-side settlement, planned from a stored departure proof, a
//! verified public round signature and current account reads. The tick
//! ([`crate::widetick`], eleventh slice) plans it from
//! [`crate::widetick::ProofStore::settle_hints`] with the reveal inputs,
//! under the shared per-tick cap, over one snapshot with the Rent sysvar.
//!
//! **Source of truth.** `permutation-frontier/src/proc/wide.rs::
//! settle_transit`: `[payer s,w] [season r] [holding w] [dest_province w]
//! [inputs w] [slot w] [home_province w] [anchor|archive r]
//! [slot_beneficiary w] [resolver w] [holding_rent_payer w]
//! [settle_beneficiary w] [transit w] [home_roster w] [system] [dest_roster
//! w] [transit_rent_to w]` then the optional `[citizen w]`
//! (`wide_ix::SETTLE_TRANSIT`, seventeen fixed positions). The outcome and
//! the payment plan are the **shared** pure functions
//! `frontier_abi::world_index::settle::{wide_valid_outcome,
//! plan_settlement}` the program itself calls — one table, no copy. The
//! handler's order is kept: the holding canonical and present, its wide
//! transit record of the proof's slot present, the host's holding's, at the
//! holding's generation (`HistoricalGeneration` otherwise, the handler's
//! `NotImplemented`), in state `Settled`, `DestroyedAtOrigin` or `Gathered`
//! (`OriginUnsettled` for `Departed`); the capture lock when the home
//! province is present; the destination the seal names **present** and
//! canonical (`DestinationAbsent` otherwise: the routed settlement of a
//! province never opened is not planned here); THE anchor or archive entry
//! of `(arrive, stored region)`; `now ≥ close + 600` and `resolved_next >
//! arrive` (`TooEarlyToSettle`); the committed seal root; **the proof**:
//! the handler decompresses the anchor's stored round signature with the
//! chain's BLS syscall and judges the seal under it — here the supplied
//! public signature must **be** the account's (`AnchorSignatureMismatch`
//! otherwise) and must verify under the Season's pinned key for
//! `T(arrive)` (the reveal's publication gate), and the IBE block must open
//! under it and the body reproduce the proof's commitment and validate
//! against the record's host and bell (the stock opener, `Crypto::
//! IbeOpened`); a seal that does not is the handler's **bad seal**
//! (confiscation), **not planned here** (`BadSealUnsupported`). Then the
//! ClashInputs of `(dest, arrive)` present and **resolved**
//! (`InputsUnresolved` otherwise: bounce/rout settlements are not planned),
//! the host **present in its faction's final set** (`NotInFinalSet`
//! otherwise), its own slot at that position (`SlotNotOwn` otherwise), its
//! fate `Stays`, `Withdrew` or `Destroyed` (`FateUnsupported` for Bounced /
//! Retreated: the home re-entry is not planned), no camp loot
//! (`CampLootUnsupported`). The plan: the tip to the slot's beneficiary,
//! the march fee (when escrowed) to the resolver, the bond (when escrowed)
//! to the holding's rent payer — every payee read from the accounts, none
//! chosen here — the escrow and the open-transit count checked as the
//! handler checks them, the event chains' headroom (the destination and
//! the holding), the slot's and the transit record's rent recipients
//! listed, the transaction sized against the packet with the 333-byte data
//! and seventeen accounts (`Overflow("packet")` when it does not fit;
//! nothing is dropped to make it fit).
//!
//! **The payees' shapes and the handler's effects, replayed (eleventh
//! slice).** The five wallet roles (the slot's beneficiary, the resolver,
//! the holding's rent payer, the settle beneficiary, the transit record's
//! rent recipient) are **read** from the same reads — lamports, owner,
//! data length; an account the chain does not hold is a zero-lamport
//! System address — and the handler's effects are replayed **in its
//! order** over the balances as they would run: the payments tip, march
//! fee, bond, reward (`pay_wide`: a program-owned recipient is owed in
//! `pool_owed` and no lamport moves; otherwise `init::pay_or_divert` with
//! the Rent sysvar's minimum for the recipient's data length — a wallet the
//! payment would leave below it is **diverted** to `pool_owed`, the
//! lamports staying in the holding; a wallet at or above it is paid from
//! the holding's lamports, `Insufficient` when they cannot back it
//! (`HoldingBackingShort`); `to + amount` and `pool_owed + amount`
//! overflows abort (`Overflow`)); then the slot: **kept** when
//! `wide_claim_eligible` (mirrored here line by line with the rules
//! crate's `defence_refund` and `min_tip_lamports`, the Season's
//! `lateness_slots`, `defence_cap_milli` and reveal limits, THE anchor's
//! landing slot, `CLAIM_GRACE_BELLS`), else **closed whole** to its
//! immutable `rent_to` when that is one of the six listed accounts
//! (`close_to` under `Sink::Never`: a recipient the whole balance would
//! leave below its minimum is the handler's `BadAccount`,
//! `CloseWouldDivert("slot")`), else **flagged** settled; then the transit
//! record closed whole to its `rent_to` the same way
//! (`CloseWouldDivert("transit")`). The same **wallet** in several roles
//! sees each effect on the balance the previous one left
//! (`predicted_balances`): a payment then a close, the slot's close then
//! the transit's. **Not modelled, refused** (`CloseRecipientAlias`, a
//! conservative refusal, not a handler rule): a close whose recipient is a
//! state account of the instruction or any program-owned account — the
//! slot closing to the transit record (which then closes enlarged), either
//! record closing to the holding (whose lamports the payments moved), a
//! self-close (whose transfer is a no-op), the System Program's account;
//! the handler pays such recipients directly, and their source/recipient
//! balance transitions are not replayed here. Payments to program-owned
//! recipients **are** exact (owed, no lamport moves). The runtime's own
//! invariant that a program account whose lamports changed must stay
//! rent-exempt is checked for the holding (`HoldingBelowRentExemption`):
//! a conservative refusal, not a handler line. The Rent sysvar must be
//! among the reads: the snapshot's (`snapshot_plan_with` reads it once
//! during key discovery when a planner says `RentSysvarMissing`, and the
//! final judgement is over the response's own Rent), or the live driver's
//! separate read; without it the divert rule cannot be reproduced and the
//! plan refuses (`RentSysvarMissing`). A fee payer among the payees is
//! read **before** the fee it pays (`payer_is_payee`): its routes are
//! conditional on the pre-fee shape; nothing here is an execution
//! guarantee, and every gate stays closed.
//!
//! **Said on the candidate, not verified.** Every payment line is the
//! plan's **nominal** allocation with its route **predicted over the
//! shapes as read at the context slot** — never an observed or successful
//! transfer: the program applies its own code later against the shapes of
//! that moment, and a payer that is also a payee pays the transaction fee
//! first. The fee payer's lower bound (`widefees`) covers the **fee only**
//! — every settled lamport is the holding's, so `MetLowerBound` is not
//! settlement funding. The march's history before the applied records is
//! unknown; the proof's source is a feed record bound by wire and frame,
//! its signatures unverified; the reads are coherent at a context slot
//! only when they are one verified snapshot. Nothing signs, simulates,
//! sends or queues.

use std::collections::{BTreeMap, BTreeSet};

use frontier_abi::bytes::{rd_arr, rd_u32, rd_u64, rd_u8};
use frontier_abi::entry::{unit_from_u8, write_entry, Entry};
use frontier_abi::layout::beacon::defence_claim::CLAIM_GRACE_BELLS;
use frontier_abi::layout::player::transit as T;
use frontier_abi::layout::province::entry as E;
use frontier_abi::layout::province::province as PV;
use frontier_abi::v2::layout::player::holding as H;
use frontier_abi::world_index::arrival::{self as wa, WideArrival, WideArrivalSlot};
use frontier_abi::world_index::seal as wseal;
use frontier_abi::world_index::settle::{
    plan_settlement, wide_valid_outcome, PayTo, SettlementPlan, WideOutcome, WideSlotEntry,
};
use frontier_abi::world_index::wide_ix::{self as wix, SettleTransit};
use frontier_abi::world_index::{
    holding as wh, land as wl, march as wm, resolve as wres, roster as wro, MarchState,
    ProvinceKey, WideHostRef, WorldId,
};
use permutation_rules::fixed::MILLI;
use permutation_rules::frontier::doctrine::of_faction_v3;
use permutation_rules::frontier::fees::{
    defence_refund, min_tip_lamports, DefenceParams, Evidence,
};
use permutation_rules::frontier::host::{effective_bell, Host, Stamina};
use permutation_rules::frontier::stance::{Posture, Stance};
use serde_json::{json, Value};
use solana_address::Address;
use solana_instruction::Instruction;

use crate::wideduty::{
    addr, anchor_read, candidate_with, capture_lock_of, chain_headroom, ctx_of, holding_at,
    march_state_byte, metas, missing, packet_len, presence, province_at, roster_at, season_of,
    transit_at, Block, Candidate, Canon, Duty, Reads, Scope, Step, GATHER_PACKET_BYTES,
};
use crate::wideproof::DepartProof;
use crate::widereveal::{open, publication_gate, Crypto, Opening, Publication, PublicationFacts};

/// More reads needed: the addresses of `$want` not in `$reads` yet.
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

/// Lines every settle candidate carries as unverified.
pub const UNVERIFIED: [&str; 7] = [
    "the payments are the plan's NOMINAL allocations (the shared plan_settlement over the records as read); their routes are PREDICTED over the payees' shapes as read at the context slot, never observed or successful transfers; the program applies its own code against the shapes of its moment",
    "the handler pays a wallet, owes or diverts to the holding's pool_owed, and ABORTS the transaction on an arithmetic overflow, a pool_owed overflow, or a holding balance that cannot back a payment: each was replayed over the reads and none was executed; a payer that is also a payee pays the transaction fee first, which the replay does not see",
    "the closes (the transit record whole to its rent recipient; the slot when not kept) run under Sink::Never: a close whose recipient would stay below its rent minimum aborts the transaction; both were replayed over the reads for ordinary wallet recipients only (a state-account or program-owned recipient is refused, not modelled); neither was simulated by the runtime; a fee payer among the payees is read before the fee it pays",
    "the slot's claim eligibility is the program's rule mirrored (wide_claim_eligible with the rules crate's defence_refund); kept, closed or flagged is predicted at the observed clock and THE anchor as read, with the same instruction either way",
    "the march's history before the applied records is unknown",
    "the proof's source is a feed record bound by wire and frame; its signatures were not verified",
    "the coherence of the reads is a context slot, never currency",
];

/// What the fee review's lower bound means for a settlement: the fee
/// payer pays the transaction fee; every settled lamport is the holding's
/// (and the closed accounts' rent), none of it the payer's. A
/// `MetLowerBound` is **not** settlement funding.
pub const FUNDING_SCOPE: &str = crate::widefees::FUNDING_SCOPE_SETTLE_TRANSIT;

/// Where the handler's payment code would route one allocation, predicted
/// over the recipient's shape as read (module doc) — never an observed
/// transfer.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PayRoute {
    /// `pay_or_divert` moves the lamports from the holding to the wallet
    /// (the wallet at or above its rent minimum after the payment).
    Wallet,
    /// `pay_wide`: the recipient is owned by the program, so the amount is
    /// owed in `pool_owed` and no lamport moves.
    OwedProgramOwned,
    /// `pay_or_divert`: the wallet would stay below its rent minimum, so
    /// the amount stays in the holding and is owed in `pool_owed`.
    DivertedBelowRent,
    /// The plan's own `PayTo::PoolOwed`: owed in `pool_owed`.
    OwedPool,
}

impl PayRoute {
    pub fn code(self) -> &'static str {
        match self {
            PayRoute::Wallet => "wallet (predicted)",
            PayRoute::OwedProgramOwned => "pool_owed: program-owned recipient",
            PayRoute::DivertedBelowRent => "pool_owed: recipient below rent minimum",
            PayRoute::OwedPool => "pool_owed: the plan's",
        }
    }
    fn tag(self) -> u8 {
        match self {
            PayRoute::Wallet => 1,
            PayRoute::OwedProgramOwned => 2,
            PayRoute::DivertedBelowRent => 3,
            PayRoute::OwedPool => 4,
        }
    }
}

/// One **nominal** allocation of the plan, with the recipient the
/// accounts name — what the shared plan says the handler would pay, with
/// the route its payment code would take over the shape as read; not a
/// verified transfer.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Payment {
    pub what: &'static str,
    pub lamports: u64,
    pub to: &'static str,
    /// The recipient's address (the holding's for `pool_owed`).
    pub address: Address,
    pub route: PayRoute,
}

/// A payee's account as read: what `pay_or_divert` and `close_to` judge.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PayeeShape {
    pub address: Address,
    pub lamports: u64,
    pub program_owned: bool,
    pub data_len: usize,
    /// The Rent sysvar's minimum for `data_len` (the divert floor); not
    /// computed for a program-owned recipient (owed, never diverted).
    pub rent_floor: Option<u64>,
}

/// What the handler would do with the host's own slot.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SlotDisposition {
    /// `wide_claim_eligible`: untouched, kept for a defence claim.
    KeptForClaim,
    /// Closed whole to its `rent_to`, found at `position` among the six
    /// listed accounts; `lamports` the slot's whole balance as read.
    ClosedTo { position: u8, lamports: u64 },
    /// Not claim-eligible and its `rent_to` not listed: `FLAG_SETTLED`.
    FlaggedSettled,
    /// No slot of the host at the position (absent or another host's):
    /// the handler touches none; the tip of a final-set fate goes to
    /// `pool_owed` (not planned here), a bounce's or a rout's never names
    /// the slot.
    NotOwn,
}

/// The staged home re-entry of a returning host, replayed from
/// `proc/wide.rs::stage_return_home` over scratch copies of the home
/// province and its roster (module doc). Predicted, not executed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ReturnHome {
    /// The plan's `returns`: the troops and stamina the host comes home
    /// with, and whether it was routed.
    pub troops_milli: u32,
    pub stamina: u16,
    pub routed: bool,
    /// The bell the stamina is dated at: `now_bell` when routed, the
    /// arrival when the record holds the host, else `effective_bell(depart)`.
    pub stamina_bell: u32,
    pub now_bell: u32,
    /// `now_bell + 1`; `max(depart + ready_bell_off, from)`; the doctrine's
    /// Hold `dealt`.
    pub from_bell: u32,
    pub ready_bell: u32,
    pub dealt_bps: u16,
    pub home_roster_present: bool,
    /// Live entries (roster or muster-pending) and the faction's own, as
    /// read; the caps are 48 and 8.
    pub live_total: u8,
    pub live_own: u8,
    /// The muster-pending entry's index when the caps allow and the roster
    /// is present (its reference claimed there under the host's alias);
    /// `None` for the reserve.
    pub entry: Option<u8>,
    pub reserve_unit: u8,
    pub reserve_before: u32,
    pub reserve_after: u32,
    /// What the Return record logs: the troops when an entry is staged,
    /// else the whole units credited (`troops / 1,000 × 1,000`).
    pub credited_milli: u32,
    pub n_entries_after: u8,
    pub roster_epoch_after: u32,
}

/// The claim rule's inputs and verdict, mirrored from the program
/// (`wide_claim_eligible`; the refund from the rules crate).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ClaimRule {
    pub anchor_slot: Option<u64>,
    pub lateness_slots: u8,
    pub tip_min: u64,
    pub defence_cap_milli: u32,
    pub grace_end: i64,
    pub refund: u64,
    pub eligible: bool,
}

/// What a WideSettleTransit plan established from the reads and the
/// shared settlement functions.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SettleTransitFacts {
    pub host: WideHostRef,
    pub transit_slot: u8,
    pub arrive_bell: u32,
    pub dest: ProvinceKey,
    pub home: ProvinceKey,
    pub home_present: bool,
    pub region: u8,
    pub transit_state: MarchState,
    /// The slot index the handler names: the host's position in its
    /// faction's resolved final set, or 0 when it is not in it.
    pub position: u8,
    pub in_final_set: bool,
    /// The host's own slot is at that index (present and the host's).
    pub own_slot: bool,
    /// The final-set fate (1–5) when in the set; 0 for a bounce or a rout.
    pub fate: u8,
    pub outcome_code: u8,
    pub stays: bool,
    /// The record's `troops_after` when the host is in the set, else the
    /// transit's post-origin value.
    pub troops_after_milli: u32,
    /// What the TransitSettled record logs as the host's troops: the
    /// record's when it stays, the returning troops when it comes home,
    /// else 0.
    pub troops_logged_milli: u32,
    /// The plan returned the host home but below `DESTROYED_BELOW`:
    /// nothing comes home, nothing is staged.
    pub destroyed_on_return: bool,
    /// The staged home re-entry when the host comes home.
    pub return_home: Option<ReturnHome>,
    pub tip: u64,
    pub fee: u64,
    pub bond: u64,
    pub total: u64,
    /// The plan's nominal allocations (module doc: not verified transfers).
    pub nominal_payments: Vec<Payment>,
    /// Nominal lamports by recipient address, summed over the allocations
    /// (a wallet in two roles).
    pub nominal_cumulative: Vec<(Address, u64)>,
    pub escrow_before: u64,
    pub escrow_after: u64,
    pub open_transits_before: u8,
    pub slot_beneficiary: Address,
    pub resolver: Address,
    pub holding_rent_payer: Address,
    pub settle_beneficiary: Address,
    pub transit_rent_to: Address,
    /// The slot's immutable rent recipient and, when it is one of the six
    /// listed wallets, which position of the instruction holds it (the
    /// slot would close to it unless kept for a claim).
    pub slot_rent_to: Address,
    pub slot_rent_to_position: Option<u8>,
    /// The payees as read (module doc): the shapes the routes were
    /// predicted over.
    pub payee_shapes: Vec<PayeeShape>,
    /// The holding's lamports as read and after the replayed payments
    /// (the closes move the closed accounts' lamports, not the holding's).
    pub holding_lamports_before: u64,
    pub holding_lamports_after: u64,
    /// The Rent sysvar's minimum for the holding's data length.
    pub holding_rent_floor: u64,
    pub pool_owed_before: u64,
    pub pool_owed_after: u64,
    /// Every listed wallet's lamports after the replayed payments and
    /// closes, in address order (a wallet in two roles once).
    pub predicted_balances: Vec<(Address, u64)>,
    /// The fee payer is one of the payees: its shape as read precedes the
    /// transaction fee it pays, so its predicted routes and balance are
    /// conditional on that (module doc).
    pub payer_is_payee: bool,
    pub slot_disposition: SlotDisposition,
    pub claim: ClaimRule,
    /// The transit record's whole balance as read, closed to
    /// `transit_rent_to`.
    pub transit_close_lamports: u64,
    pub camp_mask: u32,
    pub anchor_source: &'static str,
    pub a_ts: i64,
    pub reveal_close: i64,
    pub settle_at: i64,
    pub judged_at: i64,
    pub dest_resolved_next: u32,
    pub publication: PublicationFacts,
    pub crypto: Crypto,
    pub unverified: Vec<&'static str>,
}

impl SettleTransitFacts {
    pub(crate) fn canon(&self, c: &mut Canon) {
        c.host(&self.host);
        c.u8(self.transit_slot);
        c.u32(self.arrive_bell);
        c.province(&self.dest);
        c.province(&self.home);
        c.bool(self.home_present);
        c.u8(self.region);
        c.u8(march_state_byte(self.transit_state));
        c.u8(self.position);
        c.bool(self.in_final_set);
        c.bool(self.own_slot);
        c.u8(self.fate);
        c.u8(self.outcome_code);
        c.bool(self.stays);
        c.u32(self.troops_after_milli);
        c.u32(self.troops_logged_milli);
        c.bool(self.destroyed_on_return);
        c.option(self.return_home, |c, r| {
            c.u32(r.troops_milli);
            c.u16(r.stamina);
            c.bool(r.routed);
            c.u32(r.stamina_bell);
            c.u32(r.now_bell);
            c.u32(r.from_bell);
            c.u32(r.ready_bell);
            c.u16(r.dealt_bps);
            c.bool(r.home_roster_present);
            c.u8(r.live_total);
            c.u8(r.live_own);
            c.option(r.entry, Canon::u8);
            c.u8(r.reserve_unit);
            c.u32(r.reserve_before);
            c.u32(r.reserve_after);
            c.u32(r.credited_milli);
            c.u8(r.n_entries_after);
            c.u32(r.roster_epoch_after);
        });
        c.u64(self.tip);
        c.u64(self.fee);
        c.u64(self.bond);
        c.u64(self.total);
        c.len(self.nominal_payments.len());
        for p in &self.nominal_payments {
            c.str(p.what);
            c.u64(p.lamports);
            c.str(p.to);
            c.address(&p.address);
            c.u8(p.route.tag());
        }
        c.len(self.nominal_cumulative.len());
        for (a, l) in &self.nominal_cumulative {
            c.address(a);
            c.u64(*l);
        }
        c.u64(self.escrow_before);
        c.u64(self.escrow_after);
        c.u8(self.open_transits_before);
        c.address(&self.slot_beneficiary);
        c.address(&self.resolver);
        c.address(&self.holding_rent_payer);
        c.address(&self.settle_beneficiary);
        c.address(&self.transit_rent_to);
        c.address(&self.slot_rent_to);
        c.option(self.slot_rent_to_position, Canon::u8);
        c.len(self.payee_shapes.len());
        for s in &self.payee_shapes {
            c.address(&s.address);
            c.u64(s.lamports);
            c.bool(s.program_owned);
            c.usize(s.data_len);
            c.option(s.rent_floor, Canon::u64);
        }
        c.u64(self.holding_lamports_before);
        c.u64(self.holding_lamports_after);
        c.u64(self.holding_rent_floor);
        c.u64(self.pool_owed_before);
        c.u64(self.pool_owed_after);
        c.len(self.predicted_balances.len());
        for (a, l) in &self.predicted_balances {
            c.address(a);
            c.u64(*l);
        }
        c.bool(self.payer_is_payee);
        match self.slot_disposition {
            SlotDisposition::KeptForClaim => c.u8(1),
            SlotDisposition::ClosedTo { position, lamports } => {
                c.u8(2);
                c.u8(position);
                c.u64(lamports);
            }
            SlotDisposition::FlaggedSettled => c.u8(3),
            SlotDisposition::NotOwn => c.u8(4),
        }
        c.option(self.claim.anchor_slot, Canon::u64);
        c.u8(self.claim.lateness_slots);
        c.u64(self.claim.tip_min);
        c.u32(self.claim.defence_cap_milli);
        c.i64(self.claim.grace_end);
        c.u64(self.claim.refund);
        c.bool(self.claim.eligible);
        c.u64(self.transit_close_lamports);
        c.u32(self.camp_mask);
        c.str(self.anchor_source);
        c.i64(self.a_ts);
        c.i64(self.reveal_close);
        c.i64(self.settle_at);
        c.i64(self.judged_at);
        c.u32(self.dest_resolved_next);
        c.u64(self.publication.round);
        c.bytes(&self.publication.pk_hash);
        c.bool(self.publication.signature_verified);
        c.u8(match self.crypto {
            Crypto::CommitmentOnly => 1,
            Crypto::IbeOpened => 2,
        });
        c.len(self.unverified.len());
        for u in &self.unverified {
            c.str(u);
        }
    }

    pub fn describe(&self) -> Value {
        let mut out = json!({
            "host": hex::encode(self.host.to_bytes()),
            "transit_slot": self.transit_slot,
            "arrive_bell": self.arrive_bell,
            "dest": hex::encode(self.dest.to_bytes()),
            "home": hex::encode(self.home.to_bytes()),
            "home_present": self.home_present,
            "region": self.region,
            "transit_state": march_state_byte(self.transit_state),
            "position": self.position,
            "in_final_set": self.in_final_set,
            "own_slot": self.own_slot,
            "fate": self.fate,
            "outcome_code": self.outcome_code,
            "stays": self.stays,
            "troops_after_milli": self.troops_after_milli,
            "troops_logged_milli": self.troops_logged_milli,
            "destroyed_on_return": self.destroyed_on_return,
            "return_home": self.return_home.map(|r| json!({
                "troops_milli": r.troops_milli,
                "stamina": r.stamina,
                "routed": r.routed,
                "stamina_bell": r.stamina_bell,
                "now_bell": r.now_bell,
                "from_bell": r.from_bell,
                "ready_bell": r.ready_bell,
                "dealt_bps": r.dealt_bps,
                "home_roster_present": r.home_roster_present,
                "live_total": r.live_total,
                "live_own": r.live_own,
                "entry": r.entry,
                "reserve_unit": r.reserve_unit,
                "reserve_before": r.reserve_before,
                "reserve_after": r.reserve_after,
                "credited_milli": r.credited_milli,
                "n_entries_after": r.n_entries_after,
                "roster_epoch_after": r.roster_epoch_after,
                "meaning": "stage_return_home replayed over scratch copies of the home province and its roster as read: a muster-pending entry at the first free index under the caps when the roster is present, else the reserve in whole units; predicted, not executed",
            })),
            "tip": self.tip,
            "fee": self.fee,
            "bond": self.bond,
            "total": self.total,
            "nominal_payments": self.nominal_payments.iter().map(|p| json!({
                "what": p.what, "lamports": p.lamports, "to": p.to, "address": p.address.to_string(),
                "predicted_route": p.route.code(),
            })).collect::<Vec<_>>(),
            "nominal_cumulative": self.nominal_cumulative.iter().map(|(a, l)| json!({"address": a.to_string(), "lamports": l})).collect::<Vec<_>>(),
            "payments_meaning": "nominal allocations of the shared plan over the records as read, each with the route the handler's payment code would take over the payee's shape as read at the context slot (predicted, never an observed or successful transfer); the replay found no abort cause in the reads; the program applies its own code against the shapes of its moment",
            "funding_scope": FUNDING_SCOPE,
        });
        let rest = json!({
            "payee_shapes": self.payee_shapes.iter().map(|s| json!({
                "address": s.address.to_string(), "lamports": s.lamports, "program_owned": s.program_owned,
                "data_len": s.data_len, "rent_floor": s.rent_floor,
            })).collect::<Vec<_>>(),
            "holding_lamports_before": self.holding_lamports_before,
            "holding_lamports_after": self.holding_lamports_after,
            "holding_rent_floor": self.holding_rent_floor,
            "pool_owed_before": self.pool_owed_before,
            "pool_owed_after": self.pool_owed_after,
            "predicted_balances": self.predicted_balances.iter().map(|(a, l)| json!({"address": a.to_string(), "lamports": l})).collect::<Vec<_>>(),
            "payer_is_payee": self.payer_is_payee,
            "payer_note": "a fee payer among the payees is read BEFORE the transaction fee it pays; its routes and balance are conditional on the pre-fee shape; no execution outcome is guaranteed",
            "slot_disposition": match self.slot_disposition {
                SlotDisposition::KeptForClaim => json!({"kept_for_claim": true}),
                SlotDisposition::ClosedTo { position, lamports } => json!({"closed_to_position": position, "lamports": lamports}),
                SlotDisposition::FlaggedSettled => json!({"flagged_settled": true}),
                SlotDisposition::NotOwn => json!({"not_own": true}),
            },
            "claim_rule": {
                "anchor_slot": self.claim.anchor_slot,
                "lateness_slots": self.claim.lateness_slots,
                "tip_min": self.claim.tip_min,
                "defence_cap_milli": self.claim.defence_cap_milli,
                "grace_end": self.claim.grace_end,
                "refund": self.claim.refund,
                "eligible": self.claim.eligible,
                "source": "wide_claim_eligible mirrored; permutation_rules::frontier::fees::defence_refund",
            },
            "transit_close_lamports": self.transit_close_lamports,
            "effects_meaning": "the handler's payments and closes replayed in its order over the reads; predicted, not executed",
            "escrow_before": self.escrow_before,
            "escrow_after": self.escrow_after,
            "open_transits_before": self.open_transits_before,
            "slot_beneficiary": self.slot_beneficiary.to_string(),
            "resolver": self.resolver.to_string(),
            "holding_rent_payer": self.holding_rent_payer.to_string(),
            "settle_beneficiary": self.settle_beneficiary.to_string(),
            "transit_rent_to": self.transit_rent_to.to_string(),
            "slot_rent_to": self.slot_rent_to.to_string(),
            "slot_rent_to_position": self.slot_rent_to_position,
            "camp_mask": self.camp_mask,
            "anchor_source": self.anchor_source,
            "a_ts": self.a_ts,
            "reveal_close": self.reveal_close,
            "settle_at": self.settle_at,
            "judged_at": self.judged_at,
            "dest_resolved_next": self.dest_resolved_next,
            "publication_round": self.publication.round,
            "crypto": format!("{:?}", self.crypto),
            "unverified": self.unverified,
            "scope": "valid seal opened under the account's own round signature; destination present and its record resolved; the host in the resolved final set with its own slot (every fate: Stays, Withdrew and Destroyed; Bounced and Retreated coming home with the record's values), or outside it as the record's outranked bounce or rout (the transit's values; rout_survivors); the home re-entry replayed from stage_return_home; no camp loot; payees' shapes read and the handler's payments and closes replayed without an abort cause. Bad seals, absent destinations, unresolved records, the camp's loot, a return without the home province, an unpaired roster, a refused roster claim and any replay that would abort are refused, not planned.",
            "plan_source": "frontier_abi::world_index::settle (the program's own functions)",
        });
        out.as_object_mut()
            .expect("object literal")
            .extend(rest.as_object().expect("object literal").clone());
        out
    }
}

const PAYEE_POSITIONS: [(usize, &str); 6] = [
    (0, "payer"),
    (8, "slot_beneficiary"),
    (9, "resolver"),
    (10, "holding_rent_payer"),
    (11, "settle_beneficiary"),
    (16, "transit_rent_to"),
];

/// Plans WideSettleTransit of the march `proof` describes with
/// `beneficiary` as the settler's beneficiary (the data's; the caller's
/// public address). Reads in four rounds: the Season, the holding, the
/// transit, the home province and its roster; the destination; the
/// anchor, the archive, the inputs, the destination's roster and the
/// faction's four slots; the payees' wallets — then the Rent sysvar must
/// be in the reads (`RentSysvarMissing` tells a discovery driver to read
/// it), and the sixth evaluation at most decides. Module doc: the rules
/// and what is refused.
pub fn plan_settle_transit(
    scope: &Scope,
    payer: Address,
    beneficiary: Address,
    proof: &DepartProof,
    publication: Option<&Publication>,
    reads: &Reads,
) -> Step<Candidate> {
    let ctx = ctx_of(scope);
    let world =
        tri!(WorldId::derive_legacy_season(&ctx.season, &ctx.program).map_err(|_| Block::World));
    let host = proof.host;
    if host.key().world() != world {
        return Step::Done(Err(Block::World));
    }
    if proof.transit_slot as usize >= H::TRANSIT_N {
        return Step::Done(Err(Block::BadSlot(proof.transit_slot)));
    }
    let holding_key = wh::holding_address(&ctx, host.key().coord(), host.site());
    let holding_addr = addr(holding_key);
    let transit_addr = addr(wm::transit_address(&ctx, &holding_key, proof.transit_slot));
    if proof.holding != holding_addr || proof.transit != transit_addr {
        return Step::Done(Err(Block::ProofMismatch("holding or transit address")));
    }
    // The home province and its roster are the host reference's (the
    // holding at the canonical address has that coordinate, checked below):
    // asked in the first round so the plan decides within the shared bound.
    let home = host.key();
    let home_addr = addr(wl::province_address(&ctx, home.coord()));
    let home_roster_addr = addr(wro::roster_address(&ctx, home));
    need!(
        reads,
        [
            scope.season,
            holding_addr,
            transit_addr,
            home_addr,
            home_roster_addr
        ]
    );
    let (season, promoted) = tri!(season_of(scope, reads));
    let sid = season.h.season_id;
    let clock = fclient::clock::SeasonClock::from_season(&season);
    // 1. the holding and its transit record; the proof rebound to it.
    let (h, hd) = tri!(
        tri!(holding_at(reads, scope, &ctx, &holding_addr, sid, world))
            .ok_or(Block::Absent("holding"))
    );
    let t = tri!(tri!(transit_at(reads, scope, &transit_addr)).ok_or(Block::NoMarch));
    if ProvinceKey::new(world, h.coord) != home {
        return Step::Done(Err(Block::NotCanonical("holding")));
    }
    if t.host.key() != home || t.host.site() != h.site {
        return Step::Done(Err(Block::TransitOtherHost));
    }
    if t.host.gen() != h.gen {
        return Step::Done(Err(Block::HistoricalGeneration {
            host_gen: t.host.gen(),
            holding_gen: h.gen,
        }));
    }
    match t.state {
        MarchState::Settled | MarchState::DestroyedAtOrigin | MarchState::Gathered => {}
        MarchState::Departed => return Step::Done(Err(Block::OriginUnsettled)),
        MarchState::Free => return Step::Done(Err(Block::TransitState(t.state))),
    }
    if t.host != host {
        return Step::Done(Err(Block::ProofMismatch("host")));
    }
    if t.arrive_bell != proof.arrive_bell {
        return Step::Done(Err(Block::ProofMismatch("arrive_bell")));
    }
    if t.seal_root != proof.seal_root {
        return Step::Done(Err(Block::ProofMismatch("seal_root")));
    }
    if t.origin.key() != proof.standing {
        return Step::Done(Err(Block::ProofMismatch("standing")));
    }
    if t.depart_bell != proof.depart_bell {
        return Step::Done(Err(Block::ProofMismatch("depart_bell")));
    }
    if t.tip != proof.tip {
        return Step::Done(Err(Block::ProofMismatch("tip")));
    }
    if t.dep_mass != proof.dep_mass_milli {
        return Step::Done(Err(Block::ProofMismatch("dep_mass")));
    }
    if t.march_stamina != proof.march_stamina {
        return Step::Done(Err(Block::ProofMismatch("march_stamina")));
    }
    let arrive = t.arrive_bell;
    let holding_rent_payer = addr(tri!(
        rd_arr::<32>(hd, H::RENT_PAYER).ok_or(Block::Unreadable("holding"))
    ));
    // The home province (the capture lock when present) and its roster:
    // both listed; nothing of them is written for the fates planned here.
    let home_pd: Option<&[u8]> = match tri!(province_at(
        reads,
        scope,
        &ctx,
        &home_addr,
        sid,
        world,
        "home_province"
    )) {
        Some((hp, pd)) => {
            if hp.coord != h.coord {
                return Step::Done(Err(Block::NotCanonical("home_province")));
            }
            tri!(capture_lock_of(pd, hd));
            Some(pd)
        }
        None => None,
    };
    let home_present = home_pd.is_some();
    // 2. the proof: the public round signature verified for T(arrive) under
    //    the Season's pinned key, then the seal opened under it.
    let publication_facts = tri!(publication_gate(
        &clock,
        season.quicknet_pk_hash,
        arrive,
        publication
    ));
    let publication = publication.expect("the gate passed");
    let (plain_bytes, _salt, crypto) = match open(proof, &Opening::FromBeacon, publication) {
        Ok(v) => v,
        Err(Block::SealOpen(_)) => return Step::Done(Err(Block::BadSealUnsupported("ibe open"))),
        Err(Block::CommitMismatch) => {
            return Step::Done(Err(Block::BadSealUnsupported("body commitment")))
        }
        Err(b) => return Step::Done(Err(b)),
    };
    let plain = match wseal::unpack(&plain_bytes) {
        Ok(p) => p,
        Err(_) => return Step::Done(Err(Block::BadSealUnsupported("plaintext"))),
    };
    if wseal::validate(&plain, &t.host, arrive).is_err() {
        return Step::Done(Err(Block::BadSealUnsupported("validation")));
    }
    // 3. the committed pair is the record's.
    if wseal::seal_root(&proof.commit, &wseal::ct_hash(&proof.seal)) != t.seal_root {
        return Step::Done(Err(Block::CommitMismatch));
    }
    // 4. the destination the seal names: present, canonical, resolved past
    //    the arrival; a gathered record only against its own destination.
    let dest = plain.dest;
    if dest.world() != world {
        return Step::Done(Err(Block::World));
    }
    if let Some(g) = t.dest {
        if g != dest {
            return Step::Done(Err(Block::NotCanonical("transit destination")));
        }
    }
    let dest_addr = addr(wl::province_address(&ctx, dest.coord()));
    need!(reads, [dest_addr]);
    let Some((dprov, dpd)) = tri!(province_at(
        reads,
        scope,
        &ctx,
        &dest_addr,
        sid,
        world,
        "dest_province"
    )) else {
        return Step::Done(Err(Block::DestinationAbsent));
    };
    if dprov.coord != dest.coord() {
        return Step::Done(Err(Block::NotCanonical("dest_province")));
    }
    let region = dprov.region;
    let rn = tri!(rd_u32(dpd, PV::RESOLVED_NEXT).ok_or(Block::Unreadable("dest_province")));
    // 5. the window: THE anchor or archive entry of (arrive, region), its
    //    stored signature the verified one; the settle time.
    let anchor_addr = addr(ctx.bell_anchor(arrive, region));
    let archive_addr =
        addr(ctx.anchor_archive(region, frontier_abi::addr::archive_part_of(arrive)));
    let inputs_addr = addr(wa::clash_inputs_address(&ctx, dest, arrive));
    let dest_roster_addr = addr(wro::roster_address(&ctx, dest));
    // The faction's four slot addresses are asked in this round (the
    // host's position is known only once the record is read; one round
    // fewer than reading the one slot afterwards keeps the plan within
    // the shared read bound). The handler reads the one at the position.
    let slot_addrs: Vec<Address> = (0..4u8)
        .map(|i| addr(wa::arrival_slot_address(&ctx, dest, arrive, t.faction, i)))
        .collect();
    let mut wanted = vec![anchor_addr, archive_addr, inputs_addr, dest_roster_addr];
    wanted.extend(slot_addrs.iter().copied());
    need!(reads, wanted);
    let an = tri!(anchor_read(
        reads,
        scope,
        &ctx,
        sid,
        season.genesis_ts,
        arrive,
        region
    ));
    if an.sig48 != publication.sig48 {
        return Step::Done(Err(Block::AnchorSignatureMismatch));
    }
    let Some(now) = reads.clock else {
        return Step::Done(Err(Block::TimingNeedsClock));
    };
    let close = clock.reveal_close(arrive, an.a_ts);
    let settle_at = tri!(close.checked_add(600).ok_or(Block::Overflow("settle time")));
    if now.unix_timestamp < settle_at || rn <= arrive {
        return Step::Done(Err(Block::TooEarlyToSettle {
            settle_at,
            now: now.unix_timestamp,
            resolved_next: rn,
        }));
    }
    // The handler's `now_bell` (`hdr.bell(now.ts)`, `WrongStatus` before
    // genesis): the Return's record bell and the routed stamina's bell.
    let Some(now_bell) = clock.bell_at(now.unix_timestamp) else {
        return Step::Done(Err(Block::SeasonNotStarted {
            genesis_ts: season.genesis_ts,
            observed: now.unix_timestamp,
        }));
    };
    // 6. the record of (dest, arrive): present and **resolved**
    //    (`InputsUnresolved` otherwise: the handler settles an unresolved
    //    or absent record as routed with the tip and the fee owed and the
    //    resolver position unlisted — not planned here, no account is
    //    chosen for that position). The host's faction's four positions.
    let Some(inputs_acc) = tri!(presence(reads, &inputs_addr, &scope.program, "inputs")) else {
        return Step::Done(Err(Block::InputsUnresolved));
    };
    let ih = tri!(
        wa::WideClashInputsHdr::read(&inputs_acc.data).map_err(|_| Block::Unreadable("inputs"))
    );
    if ih.season_id != sid || ih.dest != dest || ih.bell != arrive {
        return Step::Done(Err(Block::NotCanonical("inputs")));
    }
    if ih.flags & wa::wide_clash_inputs::FLAG_RESOLVED == 0 {
        return Step::Done(Err(Block::InputsUnresolved));
    }
    let base = wa::wide_clash_inputs::position(t.faction, 0);
    let mut set: [Option<WideArrival>; 4] = [None; 4];
    for (i, s) in set.iter_mut().enumerate() {
        *s = tri!(WideArrival::read_at(&inputs_acc.data, base + i)
            .map_err(|_| Block::Unreadable("inputs position")));
    }
    // The host's position in the set, or 0 (the handler's `slot_i`).
    let position = set
        .iter()
        .position(|a| a.is_some_and(|a| a.present && a.host == t.host));
    let slot_i = position.unwrap_or(0);
    let rec: Option<WideArrival> = position.map(|k| set[k].expect("found above"));
    // 7. the slot at that index (read above): the host's **own** when
    //    present and its (`own_slot`), as the handler reads it; absent or
    //    another host's is no slot of this host.
    let slot_addr = slot_addrs[slot_i];
    let own_slot: Option<(WideArrivalSlot, u64)> =
        match tri!(presence(reads, &slot_addr, &scope.program, "slot")) {
            None => None,
            Some(slot_acc) => {
                let s: WideArrivalSlot =
                    tri!(WideArrivalSlot::read(&slot_acc.data)
                        .map_err(|_| Block::Unreadable("slot")));
                if s.season_id != sid
                    || s.dest != dest
                    || s.bell != arrive
                    || s.faction != t.faction
                    || s.i != slot_i as u8
                {
                    return Step::Done(Err(Block::NotCanonical("slot")));
                }
                (s.host == t.host).then_some((s, slot_acc.lamports))
            }
        };
    // 8. the outcome and the plan: the shared functions.
    let outcome = wide_valid_outcome(
        dest,
        arrive,
        WideSlotEntry {
            host: t.host,
            citizen: h.owner_citizen,
            troops: t.dep_mass,
        },
        Some(&set),
    );
    let fate = match outcome {
        WideOutcome::Fate(f) => {
            if !(wa::wide_arrival::FATE_STAYS..=wa::wide_arrival::FATE_DESTROYED).contains(&f) {
                // Not a fate code: the handler's `BadAccount`.
                return Step::Done(Err(Block::FateUnsupported(f)));
            }
            // A host in the set settles against its own slot; a slot that
            // is absent or another host's sends the tip to `pool_owed`,
            // which this slice does not plan.
            if own_slot.is_none() {
                return Step::Done(Err(Block::SlotNotOwn));
            }
            f
        }
        // Not in the set: the record's outranked bounce (the transit's
        // post-origin values come home) or its rout (`rout_survivors`,
        // stamina 0); both from the shared functions over the record.
        WideOutcome::BounceUnranked | WideOutcome::Routed { resolved: true } => 0,
        // A resolved record is in hand; a valid seal opened above.
        WideOutcome::Routed { resolved: false } | WideOutcome::BadSeal { .. } => {
            return Step::Done(Err(Block::InputsUnresolved))
        }
    };
    if fate == wa::wide_arrival::FATE_STAYS
        && ih.camp_mask != 0
        && ih.camp_mask.trailing_zeros() as usize
            == wa::wide_clash_inputs::position(t.faction, slot_i as u8)
    {
        return Step::Done(Err(Block::CampLootUnsupported));
    }
    let fee = if t.flags & T::FLAG_FEE_ESCROWED != 0 {
        season.march_fee
    } else {
        0
    };
    let bond = if t.flags & T::FLAG_BOND_ESCROWED != 0 {
        season.seal_bond
    } else {
        0
    };
    let plan: SettlementPlan =
        tri!(
            plan_settlement(outcome, &t, rec.as_ref(), fee, bond, own_slot.is_some())
                .ok_or(Block::Overflow("escrow sum"))
        );
    debug_assert!(!plan.forfeit);
    // 8b. the host: staying (logged), coming home (the handler's
    //     `stage_return_home`, replayed over scratch copies), or destroyed
    //     on the way (nothing staged).
    let (troops_logged, destroyed_on_return, return_home) = if plan.stays {
        (rec.map_or(0, |r| r.troops_after), false, None)
    } else if let Some((troops, stamina, routed)) = plan.returns {
        let stamina_bell = if routed {
            now_bell
        } else if rec.is_some() {
            arrive
        } else {
            effective_bell(t.depart_bell)
        };
        // The handler: a returning host needs the home province
        // (`BadAccount` without it); the roster at its canonical address,
        // paired when present, the reserve fallback when absent.
        let Some(home_pd) = home_pd else {
            return Step::Done(Err(Block::ReturnNeedsHome));
        };
        let home_roster = tri!(roster_at(reads, scope, &home_roster_addr, sid, home));
        if let Some((r, rd)) = &home_roster {
            let live = tri!(wres::live_ids(home_pd).map_err(|_| Block::RosterUnpaired));
            tri!(r
                .validate_paired(rd, &live)
                .map_err(|_| Block::RosterUnpaired));
        }
        let unit_i = t.unit as usize;
        if unit_i >= H::RESERVE_N {
            return Step::Done(Err(Block::BadUnit(t.unit)));
        }
        let reserve_before =
            tri!(rd_u32(hd, H::reserve(unit_i)).ok_or(Block::Unreadable("holding")));
        let tile = tri!(rd_u8(hd, H::TILE).ok_or(Block::Unreadable("holding")));
        let staged = tri!(stage_return_home(
            home_pd,
            home_roster.as_ref().map(|(r, rd)| (r, *rd)),
            reserve_before,
            &t,
            troops,
            stamina,
            routed,
            stamina_bell,
            tile,
            now_bell,
        ));
        (troops, false, Some(staged))
    } else {
        // `plan.returns` is `None` for a Destroyed fate and for a returning
        // host below `DESTROYED_BELOW`: nothing comes home.
        (
            0,
            !matches!(outcome, WideOutcome::Fate(wa::wide_arrival::FATE_DESTROYED)),
            None,
        )
    };
    // 9. the payees, the escrow and the open count, the chains.
    // Position 8 (the slot's beneficiary) is paid only when the host's own
    // slot exists (`PayTo::SlotBeneficiary`); without one the handler never
    // reads it, and the caller's beneficiary — already listed at position
    // 11 — fills the position. Nothing is paid there in that case.
    let slot_beneficiary = match &own_slot {
        Some((s, _)) => addr(s.beneficiary),
        None => beneficiary,
    };
    let resolver = addr(ih.resolver);
    let transit_rent_to = addr(t.rent_to);
    let escrow_before = tri!(rd_u64(hd, H::ESCROW).ok_or(Block::Unreadable("holding")));
    let Some(escrow_after) = escrow_before.checked_sub(plan.total) else {
        return Step::Done(Err(Block::EscrowShort {
            escrow: escrow_before,
            total: plan.total,
        }));
    };
    let open_transits =
        tri!(rd_u8(hd, wh::wide_holding::OPEN_TRANSITS).ok_or(Block::Unreadable("holding")));
    if open_transits == 0 {
        return Step::Done(Err(Block::NoOpenTransit));
    }
    // The TRANSIT_SETTLED record chains the destination and the holding;
    // a host coming home adds the RETURN record on the home and the
    // holding (the same account twice when the destination is the home).
    let returning = u64::from(return_home.is_some());
    if returning == 1 && dest == home {
        tri!(chain_headroom(dpd, 2, "dest_province"));
    } else {
        tri!(chain_headroom(dpd, 1, "dest_province"));
        if let (1, Some(home_pd)) = (returning, home_pd) {
            tri!(chain_headroom(home_pd, 1, "home_province"));
        }
    }
    tri!(chain_headroom(hd, 1 + returning, "holding"));
    let recipient = |to: PayTo| -> (&'static str, Address) {
        match to {
            PayTo::SlotBeneficiary => ("slot_beneficiary", slot_beneficiary),
            PayTo::Resolver => ("resolver", resolver),
            PayTo::RentPayer => ("holding_rent_payer", holding_rent_payer),
            PayTo::SettleBeneficiary => ("settle_beneficiary", beneficiary),
            PayTo::PoolOwed => ("pool_owed", holding_addr),
        }
    };
    let mut payments = Vec::new();
    for (what, (lamports, to)) in [
        ("tip", plan.tip),
        ("march_fee", plan.fee),
        ("bond", plan.bond),
        ("reward", plan.reward),
    ] {
        if lamports == 0 {
            continue;
        }
        let (name, address) = recipient(to);
        payments.push(Payment {
            what,
            lamports,
            to: name,
            address,
            // Set by the replay below.
            route: PayRoute::OwedPool,
        });
    }
    let mut cumulative: Vec<(Address, u64)> = Vec::new();
    for p in &payments {
        match cumulative.iter_mut().find(|(a, _)| *a == p.address) {
            Some((_, l)) => {
                *l = tri!(l
                    .checked_add(p.lamports)
                    .ok_or(Block::Overflow("cumulative")))
            }
            None => cumulative.push((p.address, p.lamports)),
        }
    }
    // 10. the seventeen fixed accounts (no camp loot, so no Citizen) and
    //     the slot's rent recipient among the six listed wallets.
    let keys = [
        payer,
        scope.season,
        holding_addr,
        dest_addr,
        inputs_addr,
        slot_addr,
        home_addr,
        an.key,
        slot_beneficiary,
        resolver,
        holding_rent_payer,
        beneficiary,
        transit_addr,
        home_roster_addr,
        fclient::addr::system_program(),
        dest_roster_addr,
        transit_rent_to,
    ];
    debug_assert_eq!(keys.len(), wix::SETTLE_TRANSIT_FIXED);
    // The slot's rent recipient and its listed position: only of the
    // host's own slot (none otherwise: nothing of another's slot is read
    // or closed).
    let slot_rent_to = match &own_slot {
        Some((s, _)) => addr(s.rent_to),
        None => Address::default(),
    };
    let slot_rent_to_position = own_slot.as_ref().and_then(|_| {
        PAYEE_POSITIONS
            .iter()
            .find(|(i, _)| keys[*i] == slot_rent_to)
            .map(|(i, _)| *i as u8)
    });
    // 11. the payees' shapes (module doc): the five wallet roles, and the
    //     fee payer only when the slot would close to it. The placeholder
    //     payer of the review is not a wallet whose close can be judged.
    let mut payee_set: BTreeSet<Address> = [
        slot_beneficiary,
        resolver,
        holding_rent_payer,
        beneficiary,
        transit_rent_to,
    ]
    .into_iter()
    .collect();
    if slot_rent_to_position == Some(0) {
        if payer == Address::default() {
            return Step::Done(Err(Block::PayerPlaceholder("slot rent recipient")));
        }
        payee_set.insert(payer);
    }
    let payee_addrs: Vec<Address> = payee_set.into_iter().collect();
    need!(reads, payee_addrs);
    let Some(rent) = reads.rent else {
        return Step::Done(Err(Block::RentSysvarMissing("payee divert rule")));
    };
    let floor = |space: usize| -> Result<u64, Block> {
        rent.minimum_balance(space)
            .ok_or(Block::Overflow("rent floor"))
    };
    let mut shapes: BTreeMap<Address, PayeeShape> = BTreeMap::new();
    for a in &payee_addrs {
        let (lamports, owner, data_len) = match reads.accounts.get(a) {
            None => return Step::Done(Err(Block::Read("payee not read".into()))),
            // Not held by the chain: a zero-lamport System address.
            Some(None) => (0, fclient::addr::system_program(), 0),
            Some(Some(acc)) => (acc.lamports, acc.owner, acc.data.len()),
        };
        let program_owned = owner == scope.program;
        let rent_floor = if program_owned {
            None
        } else {
            Some(tri!(floor(data_len)))
        };
        shapes.insert(
            *a,
            PayeeShape {
                address: *a,
                lamports,
                program_owned,
                data_len,
                rent_floor,
            },
        );
    }
    let payee_shapes: Vec<PayeeShape> = shapes.values().cloned().collect();
    // 12. the handler's effects replayed in its order over the running
    //     balances (module doc): the payments, the slot, the transit.
    let holding_acc = tri!(
        tri!(presence(reads, &holding_addr, &scope.program, "holding"))
            .ok_or(Block::Absent("holding"))
    );
    let holding_lamports_before = holding_acc.lamports;
    let holding_rent_floor = tri!(floor(hd.len()));
    let mut holding_lamports = holding_lamports_before;
    let pool_owed_before = tri!(rd_u64(hd, H::POOL_OWED).ok_or(Block::Unreadable("holding")));
    let mut pool_owed = pool_owed_before;
    for p in payments.iter_mut() {
        if p.to == "pool_owed" {
            // `owe_wide`: `Rw::add_u64(POOL_OWED)`.
            pool_owed = tri!(pool_owed
                .checked_add(p.lamports)
                .ok_or(Block::Overflow("pool_owed")));
            p.route = PayRoute::OwedPool;
            continue;
        }
        let sh = shapes.get_mut(&p.address).expect("read above");
        if sh.program_owned {
            // `pay_wide`: a program-owned recipient is owed, never paid.
            pool_owed = tri!(pool_owed
                .checked_add(p.lamports)
                .ok_or(Block::Overflow("pool_owed")));
            p.route = PayRoute::OwedProgramOwned;
            continue;
        }
        // `pay_or_divert`: `diverts(to.lamports, amount, rent(to.data_len))`,
        // `None` (the sum overflows) is the handler's `Overflow`.
        let after = tri!(sh
            .lamports
            .checked_add(p.lamports)
            .ok_or(Block::Overflow("payee balance")));
        let below = after < sh.rent_floor.expect("a wallet has a floor");
        if !below {
            // `move_lamports(holding, to, amount)`: `Insufficient` first.
            holding_lamports =
                tri!(holding_lamports
                    .checked_sub(p.lamports)
                    .ok_or(Block::HoldingBackingShort {
                        payment: p.what,
                        holding_lamports,
                        amount: p.lamports,
                    }));
            sh.lamports = after;
            p.route = PayRoute::Wallet;
        } else {
            // `Sink::PoolOwed(holding)`: `move_lamports(holding, holding)`
            // is a no-op; `pool_owed += amount`.
            pool_owed = tri!(pool_owed
                .checked_add(p.lamports)
                .ok_or(Block::Overflow("pool_owed")));
            p.route = PayRoute::DivertedBelowRent;
        }
    }
    // The runtime's invariant, not the handler's: a program account whose
    // lamports changed must still be rent-exempt (conservative refusal).
    if holding_lamports != holding_lamports_before && holding_lamports < holding_rent_floor {
        return Step::Done(Err(Block::HoldingBelowRentExemption {
            after: holding_lamports,
            floor: holding_rent_floor,
        }));
    }
    // `close_to(target, recipient, Sink::Never)`: the whole balance through
    // `pay_or_divert`; a recipient the whole would leave below its minimum
    // is `BadAccount`. Modelled for an ordinary **wallet** recipient only
    // (a wallet in several roles sees each close on the balance the
    // previous effect left). A recipient that is a state account of the
    // instruction (a close source, the holding whose lamports the payments
    // moved, a record, the System Program) or any program-owned account is
    // **refused** (`CloseRecipientAlias`): the handler pays such a
    // recipient directly and the balance transitions (an enlarged source
    // closed next, a self-close whose transfer is a no-op) are not
    // replayed here. A conservative refusal, not a handler rule.
    let state_keys: Vec<Address> = keys
        .iter()
        .enumerate()
        .filter(|(i, _)| !PAYEE_POSITIONS.iter().any(|(p, _)| p == i))
        .map(|(_, k)| *k)
        .collect();
    let close_whole = |shapes: &mut BTreeMap<Address, PayeeShape>,
                       lamports: u64,
                       to: &Address,
                       what: &'static str|
     -> Result<(), Block> {
        let sh = shapes.get_mut(to).expect("read above");
        if sh.program_owned || state_keys.contains(to) {
            return Err(Block::CloseRecipientAlias(what));
        }
        if lamports == 0 {
            return Ok(());
        }
        let after = lamports
            .checked_add(sh.lamports)
            .ok_or(Block::Overflow("close recipient balance"))?;
        if after < sh.rent_floor.expect("a wallet has a floor") {
            return Err(Block::CloseWouldDivert(what));
        }
        sh.lamports = after;
        Ok(())
    };
    // The slot: `wide_claim_eligible`, mirrored.
    let tip_min = min_tip_lamports(
        season.min_reveal_priority_milli,
        season.reveal_cu_limit,
        season.reveal_loaded_limit,
    );
    let params = DefenceParams {
        defence_cap_milli: season.defence_cap_milli,
        tip_min,
    };
    let grace_end = tri!(close
        .checked_add(CLAIM_GRACE_BELLS as i64 * 600)
        .ok_or(Block::Overflow("claim grace")));
    // The claim rule over the host's own slot; no slot, no claim.
    let (refund, eligible) = match (&own_slot, an.anchor_slot) {
        (Some((s, _)), Some(anchor_slot)) => {
            let refund = defence_refund(
                &Evidence {
                    price_micro: s.ev_price,
                    limit: s.ev_limit,
                    loaded: s.ev_loaded,
                    created_day: false,
                },
                &params,
            );
            let eligible = !s.claimed
                && now.unix_timestamp < grace_end
                && s.ev_slot.saturating_sub(anchor_slot) >= season.lateness_slots as u64
                && refund > 0;
            (refund, eligible)
        }
        (Some((s, _)), None) => (
            defence_refund(
                &Evidence {
                    price_micro: s.ev_price,
                    limit: s.ev_limit,
                    loaded: s.ev_loaded,
                    created_day: false,
                },
                &params,
            ),
            false,
        ),
        (None, _) => (0, false),
    };
    let claim = ClaimRule {
        anchor_slot: an.anchor_slot,
        lateness_slots: season.lateness_slots,
        tip_min,
        defence_cap_milli: season.defence_cap_milli,
        grace_end,
        refund,
        eligible,
    };
    let slot_disposition = match &own_slot {
        None => SlotDisposition::NotOwn,
        Some(_) if eligible => SlotDisposition::KeptForClaim,
        Some((_, slot_lamports)) => match slot_rent_to_position {
            Some(position) => {
                let lamports = *slot_lamports;
                tri!(close_whole(&mut shapes, lamports, &slot_rent_to, "slot"));
                SlotDisposition::ClosedTo { position, lamports }
            }
            None => SlotDisposition::FlaggedSettled,
        },
    };
    // The transit record, whole to its immutable recipient.
    let transit_acc =
        tri!(tri!(presence(reads, &transit_addr, &scope.program, "transit")).ok_or(Block::NoMarch));
    let transit_close_lamports = transit_acc.lamports;
    tri!(close_whole(
        &mut shapes,
        transit_close_lamports,
        &transit_rent_to,
        "transit"
    ));
    let predicted_balances: Vec<(Address, u64)> =
        shapes.values().map(|s| (s.address, s.lamports)).collect();
    // The fee payer among the payees: its shape as read is **before** the
    // transaction fee it pays; the routes predicted for it are conditional
    // on that (module doc).
    let payer_is_payee = payee_addrs.contains(&payer);
    // 13. the instruction: the ABI's data, sized against the packet.
    let accounts = metas(wix::SETTLE_TRANSIT, &keys);
    let data = SettleTransit {
        transit_slot: proof.transit_slot,
        commit: proof.commit,
        seal: proof.seal,
        beneficiary: beneficiary.to_bytes(),
    }
    .to_bytes()
    .to_vec();
    let ix = Instruction {
        program_id: scope.program,
        accounts,
        data,
    };
    if packet_len(&ix, &payer) > GATHER_PACKET_BYTES {
        return Step::Done(Err(Block::Overflow("packet")));
    }
    let facts = SettleTransitFacts {
        host,
        transit_slot: proof.transit_slot,
        arrive_bell: arrive,
        dest,
        home,
        home_present,
        region,
        transit_state: t.state,
        position: slot_i as u8,
        in_final_set: position.is_some(),
        own_slot: own_slot.is_some(),
        fate,
        outcome_code: outcome.code(),
        stays: plan.stays,
        troops_after_milli: rec.map_or(t.troops_after, |r| r.troops_after),
        troops_logged_milli: troops_logged,
        destroyed_on_return,
        return_home,
        tip: plan.tip.0,
        fee: plan.fee.0,
        bond: plan.bond.0,
        total: plan.total,
        nominal_payments: payments,
        nominal_cumulative: cumulative,
        escrow_before,
        escrow_after,
        open_transits_before: open_transits,
        slot_beneficiary,
        resolver,
        holding_rent_payer,
        settle_beneficiary: beneficiary,
        transit_rent_to,
        slot_rent_to,
        slot_rent_to_position,
        payee_shapes,
        holding_lamports_before,
        holding_lamports_after: holding_lamports,
        holding_rent_floor,
        pool_owed_before,
        pool_owed_after: pool_owed,
        predicted_balances,
        payer_is_payee,
        slot_disposition,
        claim,
        transit_close_lamports,
        camp_mask: ih.camp_mask,
        anchor_source: an.source,
        a_ts: an.a_ts,
        reveal_close: close,
        settle_at,
        judged_at: now.unix_timestamp,
        dest_resolved_next: rn,
        publication: publication_facts,
        crypto,
        unverified: UNVERIFIED.to_vec(),
    };
    let data = ix.data.clone();
    Step::Done(Ok(candidate_with(
        scope,
        reads,
        payer,
        Duty::SettleTransit(Box::new(facts)),
        ix.accounts,
        data,
        promoted,
    )))
}

/// `proc/wide.rs::stage_return_home`, replayed over **scratch copies** of
/// the home province (`pd`) and its roster (`rd`) as read — line for line:
/// the unit and the doctrine (`BadAccount` → `BadUnit` / `BadFaction`),
/// the doctrine's Hold `dealt` as `u16` (`Overflow`), `from = now_bell +
/// 1`, `ready = max(depart + ready_bell_off, from)`; with a roster, the
/// entry scan (states 1–2 counted in total and the faction's own, the
/// first free index) and the caps (48 total, 8 per faction) decide the
/// index; a claimed index has the roster claim the reference under the
/// host's alias (`BadAccount` → `RosterClaimRefused`) and the
/// muster-pending entry written (`BadAccount` → `BadEntry`), `n_entries`
/// saturating up and the epoch wrapping; else `reserve[unit] += troops /
/// 1,000` (`Overflow` → `ReserveOverflow`). Nothing here is written to
/// any account; the numbers are the facts a candidate carries.
#[allow(clippy::too_many_arguments)]
fn stage_return_home(
    pd: &[u8],
    roster: Option<(&wro::WideRoster, &[u8])>,
    reserve_before: u32,
    t: &wm::WideTransit,
    troops: u32,
    stamina: u16,
    routed: bool,
    stamina_bell: u32,
    tile: u8,
    now_bell: u32,
) -> Result<ReturnHome, Block> {
    let unit = unit_from_u8(t.unit).ok_or(Block::BadUnit(t.unit))?;
    let doctrine = of_faction_v3(t.faction).ok_or(Block::BadFaction(t.faction))?;
    let dealt = u16::try_from(doctrine.dealt_bps(Posture::Stance(Stance::Hold), false))
        .map_err(|_| Block::Overflow("dealt bps"))?;
    let from = now_bell
        .checked_add(1)
        .ok_or(Block::Overflow("from bell"))?;
    let ready = t
        .depart_bell
        .checked_add(t.ready_bell_off as u32)
        .ok_or(Block::Overflow("ready bell"))?
        .max(from);
    let (mut total, mut own, mut free) = (0usize, 0usize, None);
    for i in 0..PV::ENTRIES_N {
        let o = PV::entry(i);
        let state = rd_u8(pd, o + E::STATE).ok_or(Block::Unreadable("home_province"))?;
        match state {
            E::STATE_FREE if free.is_none() => {
                free = Some(i);
            }
            E::STATE_ROSTER | E::STATE_MUSTER_PENDING => {
                total += 1;
                if rd_u8(pd, o + E::FACTION).ok_or(Block::Unreadable("home_province"))? == t.faction
                {
                    own += 1;
                }
            }
            _ => {}
        }
    }
    let slot = if roster.is_some() {
        if total >= PV::ROSTER_CAP || own >= PV::FACTION_CAP {
            None
        } else {
            free
        }
    } else {
        None
    };
    let n_entries = rd_u8(pd, PV::N_ENTRIES).ok_or(Block::Unreadable("home_province"))?;
    let epoch = rd_u32(pd, PV::ROSTER_EPOCH).ok_or(Block::Unreadable("home_province"))?;
    let common =
        |entry: Option<u8>, reserve_after: u32, credited: u32, n: u8, ep: u32| ReturnHome {
            troops_milli: troops,
            stamina,
            routed,
            stamina_bell,
            now_bell,
            from_bell: from,
            ready_bell: ready,
            dealt_bps: dealt,
            home_roster_present: roster.is_some(),
            live_total: total.min(u8::MAX as usize) as u8,
            live_own: own.min(u8::MAX as usize) as u8,
            entry,
            reserve_unit: t.unit,
            reserve_before,
            reserve_after,
            credited_milli: credited,
            n_entries_after: n,
            roster_epoch_after: ep,
        };
    match (slot, roster) {
        (Some(i), Some((roster, rd))) => {
            let mut rd_s = rd.to_vec();
            let alias = roster
                .claim(&mut rd_s, i, &t.host)
                .map_err(|_| Block::RosterClaimRefused)?;
            let host = Host {
                id: alias,
                owner: alias,
                faction: t.faction,
                unit,
                troops,
                stamina: Stamina {
                    value: stamina,
                    bell: stamina_bell,
                },
                ready_bell: ready,
                pending: None,
            };
            let e = Entry::from_host(&host, tile, E::STATE_MUSTER_PENDING, dealt, from);
            let mut pd_s = pd.to_vec();
            write_entry(&mut pd_s, i, &e).map_err(|_| Block::BadEntry)?;
            Ok(common(
                Some(i as u8),
                reserve_before,
                troops,
                n_entries.saturating_add(1),
                epoch.wrapping_add(1),
            ))
        }
        _ => {
            let whole = troops / MILLI as u32;
            let reserve_after = reserve_before
                .checked_add(whole)
                .ok_or(Block::ReserveOverflow { unit: t.unit })?;
            Ok(common(
                None,
                reserve_after,
                whole.saturating_mul(MILLI as u32),
                n_entries,
                epoch,
            ))
        }
    }
}

/// [`plan_settle_transit`] over one snapshot response (the fee payer's
/// account in it; nothing is created, but the **Rent sysvar is requested**:
/// the payees' divert rule needs it).
pub async fn settle_transit_snapshot<
    P: fclient::ports::ChainPort + crate::widesnapshot::SnapshotPort,
>(
    port: &P,
    scope: &Scope,
    payer: Address,
    beneficiary: Address,
    proof: &DepartProof,
    publication: Option<&Publication>,
    min_slot: u64,
) -> Result<(Candidate, crate::widesnapshot::Snapshot), Block> {
    crate::widesnapshot::snapshot_plan(port, min_slot, true, &[payer], |r| {
        plan_settle_transit(scope, payer, beneficiary, proof, publication, r)
    })
    .await
}

/// [`plan_settle_transit`] over live reads (at most
/// `wideduty::MAX_READ_ROUNDS` evaluations; the clock observed once; the
/// Rent sysvar read once, separately — these reads are never a coherent
/// snapshot).
pub async fn settle_transit_via<P: fclient::ports::ChainPort>(
    port: &P,
    scope: &Scope,
    payer: Address,
    beneficiary: Address,
    proof: &DepartProof,
    publication: Option<&Publication>,
    min_slot: u64,
) -> Result<Candidate, Block> {
    let mut reads = Reads::new(min_slot);
    reads.clock = port.clock().await.ok();
    let rent_addr = crate::widesnapshot::rent_sysvar();
    let got = port
        .accounts(&[rent_addr], min_slot)
        .await
        .map_err(|e| Block::Read(e.to_string()))?;
    reads.rent = match got.as_slice() {
        [Some(acc)] => crate::widesnapshot::RentSysvar::decode(&acc.data),
        _ => None,
    };
    for _ in 0..crate::wideduty::MAX_READ_ROUNDS {
        match plan_settle_transit(scope, payer, beneficiary, proof, publication, &reads) {
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

/// The addresses a plan still needs from `reads` (the planner's `need!`
/// in function form, for callers that drive reads themselves).
pub fn still_missing(reads: &Reads, want: &[Address]) -> Vec<Address> {
    missing(reads, want)
}
