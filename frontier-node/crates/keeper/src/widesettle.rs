//! **Read-only, opt-in** (feature `wide-world-experimental`): the
//! **unsigned** WideSettleTransit (0xDC op 5) candidate of a march whose
//! seal **opens publicly** and whose host is in the **resolved final set**
//! with a fate that does not come home — the smallest correct slice of the
//! destination-side settlement, planned from a stored departure proof, a
//! verified public round signature and current account reads.
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
//! **Said on the candidate, not verified.** The payments are the plan's
//! **nominal** allocations over the records as read; the payees' account
//! shapes are not read (the handler pays a wallet, diverts an undeliverable
//! recipient to `pool_owed`, and **aborts** on an arithmetic overflow, a
//! `pool_owed` overflow or a holding balance that cannot back a payment);
//! the two closes run under `Sink::Never` and abort when their
//! prerequisites fail; the fee payer's lower bound (`widefees`) covers the
//! **fee only** — every settled lamport is the holding's, so
//! `MetLowerBound` is not settlement funding; the slot's claim eligibility
//! (`wide_claim_eligible`: the defence refund rule lives in the program)
//! is **not** predicted — the slot is closed to its listed rent recipient,
//! kept for a claim, or flagged, all with the same instruction; the march's
//! history before the applied records is unknown; the proof's source is a
//! feed record bound by wire and frame, its signatures unverified; the
//! reads are coherent at a context slot only when they are one verified
//! snapshot. Nothing signs, simulates, sends or queues.

use frontier_abi::bytes::{rd_arr, rd_u32, rd_u64, rd_u8};
use frontier_abi::layout::player::transit as T;
use frontier_abi::layout::province::province as PV;
use frontier_abi::v2::layout::player::holding as H;
use frontier_abi::world_index::arrival::{self as wa, WideArrival, WideArrivalSlot};
use frontier_abi::world_index::seal as wseal;
use frontier_abi::world_index::settle::{
    plan_settlement, wide_valid_outcome, PayTo, SettlementPlan, WideOutcome, WideSlotEntry,
};
use frontier_abi::world_index::wide_ix::{self as wix, SettleTransit};
use frontier_abi::world_index::{
    holding as wh, land as wl, march as wm, roster as wro, MarchState, ProvinceKey, WideHostRef,
    WorldId,
};
use serde_json::{json, Value};
use solana_address::Address;
use solana_instruction::Instruction;

use crate::wideduty::{
    addr, anchor_read, candidate_with, capture_lock_of, chain_headroom, ctx_of, holding_at,
    march_state_byte, metas, missing, packet_len, presence, province_at, season_of, transit_at,
    Block, Candidate, Canon, Duty, Reads, Scope, Step, GATHER_PACKET_BYTES,
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
    "the payments are the plan's NOMINAL allocations (the shared plan_settlement over the records as read); the execution's recipients, backing and outcome were not verified",
    "a payee's account shape was not read: the handler pays a wallet, diverts an undeliverable recipient to the holding's pool_owed, and ABORTS the transaction on an arithmetic overflow, a pool_owed overflow, or a holding balance that cannot back a payment",
    "the closes (the transit record whole to its rent recipient; the slot when not kept) run under Sink::Never: a close whose prerequisites fail aborts the transaction; neither close was simulated",
    "the slot's claim eligibility was not predicted (the defence refund rule is the program's); the slot is closed to its listed rent recipient, kept for a claim, or flagged — the same instruction",
    "the march's history before the applied records is unknown",
    "the proof's source is a feed record bound by wire and frame; its signatures were not verified",
    "the coherence of the reads is a context slot, never currency",
];

/// What the fee review's lower bound means for a settlement: the fee
/// payer pays the transaction fee; every settled lamport is the holding's
/// (and the closed accounts' rent), none of it the payer's. A
/// `MetLowerBound` is **not** settlement funding.
pub const FUNDING_SCOPE: &str = crate::widefees::FUNDING_SCOPE_SETTLE_TRANSIT;

/// One **nominal** allocation of the plan, with the recipient the
/// accounts name — what the shared plan says the handler would pay, not a
/// verified transfer.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Payment {
    pub what: &'static str,
    pub lamports: u64,
    pub to: &'static str,
    /// The recipient's address (the holding's for `pool_owed`).
    pub address: Address,
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
    /// The host's position in its faction's resolved final set.
    pub position: u8,
    pub fate: u8,
    pub outcome_code: u8,
    pub stays: bool,
    pub troops_after_milli: u32,
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
        c.u8(self.fate);
        c.u8(self.outcome_code);
        c.bool(self.stays);
        c.u32(self.troops_after_milli);
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
            "fate": self.fate,
            "outcome_code": self.outcome_code,
            "stays": self.stays,
            "troops_after_milli": self.troops_after_milli,
            "tip": self.tip,
            "fee": self.fee,
            "bond": self.bond,
            "total": self.total,
            "nominal_payments": self.nominal_payments.iter().map(|p| json!({
                "what": p.what, "lamports": p.lamports, "to": p.to, "address": p.address.to_string(),
            })).collect::<Vec<_>>(),
            "nominal_cumulative": self.nominal_cumulative.iter().map(|(a, l)| json!({"address": a.to_string(), "lamports": l})).collect::<Vec<_>>(),
            "payments_meaning": "nominal allocations of the shared plan over the records as read; execution recipients, backing and close prerequisites unverified; an overflow, an unbacked payment or a failed close aborts the transaction",
            "funding_scope": FUNDING_SCOPE,
        });
        let rest = json!({
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
            "scope": "valid seal opened under the account's own round signature; destination present and resolved; host present in the resolved final set with its own slot; fate Stays, Withdrew or Destroyed; no camp loot. Bad seals, absent destinations, bounces, routs, returns home and the camp's loot are refused, not planned.",
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
/// public address). Reads in rounds: the Season, the holding and the
/// transit; the home province and its roster; the destination; the
/// anchor, the archive, the inputs and the destination's roster; the slot.
/// Module doc: the rules and what is refused.
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
    need!(reads, [scope.season, holding_addr, transit_addr]);
    let (season, promoted) = tri!(season_of(scope, reads));
    let sid = season.h.season_id;
    let clock = fclient::clock::SeasonClock::from_season(&season);
    // 1. the holding and its transit record; the proof rebound to it.
    let (h, hd) = tri!(
        tri!(holding_at(reads, scope, &ctx, &holding_addr, sid, world))
            .ok_or(Block::Absent("holding"))
    );
    let t = tri!(tri!(transit_at(reads, scope, &transit_addr)).ok_or(Block::NoMarch));
    let home = ProvinceKey::new(world, h.coord);
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
    let home_addr = addr(wl::province_address(&ctx, h.coord));
    let home_roster_addr = addr(wro::roster_address(&ctx, home));
    need!(reads, [home_addr, home_roster_addr]);
    let home_present = match tri!(province_at(
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
            true
        }
        None => false,
    };
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
    need!(
        reads,
        [anchor_addr, archive_addr, inputs_addr, dest_roster_addr]
    );
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
    // 6. the resolved final set of the host's faction, the host in it.
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
    let Some(position) = set
        .iter()
        .position(|a| a.is_some_and(|a| a.present && a.host == t.host))
    else {
        return Step::Done(Err(Block::NotInFinalSet));
    };
    let rec = set[position].expect("found above");
    // 7. the host's own slot at that position.
    let slot_addr = addr(wa::arrival_slot_address(
        &ctx,
        dest,
        arrive,
        t.faction,
        position as u8,
    ));
    need!(reads, [slot_addr]);
    let Some(slot_acc) = tri!(presence(reads, &slot_addr, &scope.program, "slot")) else {
        return Step::Done(Err(Block::SlotNotOwn));
    };
    let s: WideArrivalSlot =
        tri!(WideArrivalSlot::read(&slot_acc.data).map_err(|_| Block::Unreadable("slot")));
    if s.season_id != sid
        || s.dest != dest
        || s.bell != arrive
        || s.faction != t.faction
        || s.i != position as u8
    {
        return Step::Done(Err(Block::NotCanonical("slot")));
    }
    if s.host != t.host {
        return Step::Done(Err(Block::SlotNotOwn));
    }
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
        WideOutcome::Fate(f) => f,
        _ => return Step::Done(Err(Block::NotInFinalSet)),
    };
    match fate {
        wa::wide_arrival::FATE_STAYS
        | wa::wide_arrival::FATE_WITHDREW
        | wa::wide_arrival::FATE_DESTROYED => {}
        other => return Step::Done(Err(Block::FateUnsupported(other))),
    }
    if fate == wa::wide_arrival::FATE_STAYS
        && ih.camp_mask != 0
        && ih.camp_mask.trailing_zeros() as usize
            == wa::wide_clash_inputs::position(t.faction, position as u8)
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
    let plan: SettlementPlan = tri!(plan_settlement(outcome, &t, Some(&rec), fee, bond, true)
        .ok_or(Block::Overflow("escrow sum")));
    debug_assert!(!plan.forfeit && plan.returns.is_none());
    // 9. the payees, the escrow and the open count, the chains.
    let slot_beneficiary = addr(s.beneficiary);
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
    // The TRANSIT_SETTLED record chains the destination and the holding.
    tri!(chain_headroom(dpd, 1, "dest_province"));
    tri!(chain_headroom(hd, 1, "holding"));
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
    // 10. the instruction: the seventeen fixed accounts (no camp loot, so
    //     no Citizen), the ABI's data, sized against the packet.
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
    let slot_rent_to = addr(s.rent_to);
    let slot_rent_to_position = PAYEE_POSITIONS
        .iter()
        .find(|(i, _)| keys[*i] == slot_rent_to)
        .map(|(i, _)| *i as u8);
    let facts = SettleTransitFacts {
        host,
        transit_slot: proof.transit_slot,
        arrive_bell: arrive,
        dest,
        home,
        home_present,
        region,
        transit_state: t.state,
        position: position as u8,
        fate,
        outcome_code: outcome.code(),
        stays: plan.stays,
        troops_after_milli: rec.troops_after,
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

/// [`plan_settle_transit`] over one snapshot response (the fee payer's
/// account in it; nothing is created, so no Rent).
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
    crate::widesnapshot::snapshot_plan(port, min_slot, false, &[payer], |r| {
        plan_settle_transit(scope, payer, beneficiary, proof, publication, r)
    })
    .await
}

/// [`plan_settle_transit`] over live reads (at most
/// `wideduty::MAX_READ_ROUNDS` evaluations; the clock observed once).
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
