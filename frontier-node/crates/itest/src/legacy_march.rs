//! **Local-play legacy march driver** (feature `localnet-expedition-play`): the
//! ORDINARY march of a legacy village (ring ≤ 128; the page's own page-signed
//! Depart, 0x50) driven to its settlement with the program's real legacy
//! instructions, at most one transaction per step, each simulated first and
//! landed on the node's own ticker. The keeper's anchors (every region at a
//! pending arrival bell, `keeper_loop::Keeper::watch_holding`) and the origin
//! driver's resolve of the departure bell come first; then, per transit of
//! the watched Holding (its inline record, `Holding::transit[slot]`):
//!
//! 1. **SettleDeparture** (0x52; the v2 form when the Season is v2): state 1
//!    (Departed) and the origin province resolved past `depart_bell`;
//! 2. **the Depart's own bytes**: the LANDED Depart naming this Holding whose
//!    host, arrival bell, slot and `sha256(commit ‖ sha256(seal))` are this
//!    transit's (two different matches: an error, never guessed between);
//! 3. **Decrypt**: once round `T(arrive)` is published, the public Quicknet
//!    signature (verified against the pinned key) opens the seal off chain
//!    (`fclient::play::open_march`, as SettleTransit judges it). Memory only;
//! 4. **Reveal** (0x51) of the opened plaintext, paid by this driver's payer
//!    (any payer may reveal), at the index `admit_arrival` gives, with the
//!    path provinces the program checks, once THE anchor of
//!    `(arrive, destination region)` exists and before its reveal window
//!    closes (a closed window unrevealed: stopped, reported — never forced);
//! 5. **destination catch-up**: the destination's quiet bells before the
//!    arrival by FastForward (≤ 16 per transaction), each bell's anchor of
//!    the destination region posted first when absent (public round);
//! 6. **GatherClash** of the arrival bell in parts (`play::gather_parts`),
//!    **PostSeed** and **ResolveFromInputs**, as the production keeper plans them;
//! 7. **SettleTransit** (0x54; v2 form) once `settle_after(arrive, A)` passed,
//!    with the Depart's own commitment and seal.
//!
//! A refusal (simulated or landed) stops the driver; an outcome not seen is
//! `Unknown` with its signature and is never resent. A seal that does not
//! open validly, a destination that is not open, or a missed reveal window
//! stops it with the reason named: their settlement is not driven here.
//! No account is written directly and no rule is changed: every write is a
//! program instruction the production keeper also sends.
use fclient::addr::Addresses;
use fclient::decode::{ArrivalDay, ArrivalSlot, ClashInputs, Holding, Season, Transit};
use fclient::ix::{self, v2 as ix2, AnchorSource, BeaconArg, DepartArgs, HoldingRef, RevealArgs, SeedSource, SettleTransitArgs};
use fclient::play::{self, Opened, Target};
use fclient::{Address, Instruction, Keypair, Signer};
use localnet::server::{lock, Shared};
use localnet::Chain;
use permutation_rules::frontier::clash::SlotEntry;
use std::time::Duration;

use crate::keeper_loop::{submit_and_wait, Sent};
use crate::local_keeper as lk;
use crate::origin_driver::Step;

/// The transit states of a legacy Holding record (frontier-abi layout `player::transit`).
pub const T_FREE: u8 = 0;
pub const T_DEPARTED: u8 = 1;
pub const T_SETTLED: u8 = 2;
pub const T_DESTROYED_AT_ORIGIN: u8 = 3;
/// The legacy Depart's data length with its tag (§5.11: 219 B).
pub const DEPART_DATA_LEN: usize = 1 + 8 + 32 + 165 + 4 + 8 + 1;
/// All 24 positions of a ClashInputs gathered.
pub const ALL_GATHERED: u32 = 0x00FF_FFFF;
/// The legacy seal (IBE 128 B + body 37 B).
pub const SEAL_LEN: usize = fclient::seal::SEAL_LEN;

// ------------------------------------------------------------------ pure helpers

/// The legacy village at `holding`: its Holding is program-owned, decodes as a LEGACY Holding at that very address
/// (a wide holding does not), and lies in the legacy disk (ring ≤ 128). → its `{p, q, site}`, or None.
pub fn legacy_village(c: &Chain, a: &Addresses, holding: &Address) -> Option<HoldingRef> {
    let acc = c.account(holding).filter(|acc| acc.owner == a.program)?;
    let h = Holding::decode(&acc.data).ok()?;
    let href = HoldingRef { p: h.p, q: h.q, site: h.site };
    if href.address(a) != *holding {
        return None;
    }
    let ring = permutation_rules::frontier::geometry::ProvinceCoord::new(h.p as i32, h.q as i32).ring();
    (ring <= 128).then_some(href)
}

/// The legacy transits of `h` that are not free, with their slot index.
pub fn live_transits(h: &Holding) -> Vec<(u8, Transit)> {
    h.transit.iter().enumerate().filter(|(_, t)| t.state != T_FREE).map(|(i, t)| (i as u8, t.clone())).collect()
}

/// Whether SettleDeparture is due for `t`: Departed, and its origin province resolved past its departure bell.
pub fn departure_due(t: &Transit, origin_resolved_next: u32) -> bool {
    t.state == T_DEPARTED && origin_resolved_next > t.depart_bell
}

/// The legacy seal root the program records: `sha256(commit ‖ sha256(seal))` (proc/host.rs `depart`).
pub fn legacy_seal_root(commit: &[u8; 32], seal: &[u8]) -> [u8; 32] {
    let ct = fclient::seal::ct_hash(seal);
    permutation_rules::hash::sha256(&[commit, &ct])
}

/// A legacy Depart's arguments from its instruction data (tag 0x50 and exactly 218 bytes after it), or None.
pub fn parse_depart(data: &[u8]) -> Option<DepartArgs> {
    if data.len() != DEPART_DATA_LEN || data[0] != fclient::abi::tag::DEPART {
        return None;
    }
    let mut o = 1;
    let mut take = |n: usize| { let s = &data[o..o + n]; o += n; s };
    let host_id = u64::from_le_bytes(take(8).try_into().ok()?);
    let commit: [u8; 32] = take(32).try_into().ok()?;
    let seal: [u8; 165] = take(165).try_into().ok()?;
    let arrive_bell = u32::from_le_bytes(take(4).try_into().ok()?);
    let tip = u64::from_le_bytes(take(8).try_into().ok()?);
    let transit_slot = take(1)[0];
    Some(DepartArgs { host_id, commit, seal, arrive_bell, tip, transit_slot })
}

/// Whether a landed Depart is THIS transit's: slot, host, arrival bell and seal root.
pub fn depart_is(d: &DepartArgs, t: &Transit, slot: u8) -> bool {
    d.transit_slot == slot && d.host_id == t.host_id && d.arrive_bell == t.arrive_bell && legacy_seal_root(&d.commit, &d.seal) == t.seal_root
}

/// The legacy Departs of `program` in one landed wire whose Holding account (index 3 of the player prefix … the
/// Depart's `[holding w]`) is `holding`: every instruction of the program whose data parses as a Depart and names
/// `holding` among its accounts.
pub fn departs_in(wire: &[u8], program: &Address, holding: &Address) -> Result<Vec<DepartArgs>, String> {
    let t = fclient::tx::from_wire(wire)?;
    let keys = &t.message.account_keys;
    let mut out = vec![];
    for ix in &t.message.instructions {
        if keys.get(ix.program_id_index as usize) != Some(program) {
            continue;
        }
        let Some(d) = parse_depart(&ix.data) else { continue };
        if ix.accounts.iter().any(|&i| keys.get(i as usize) == Some(holding)) {
            out.push(d);
        }
    }
    Ok(out)
}

/// The one landed Depart of THIS transit among the transactions naming `holding` (newest 256), or None; two
/// different matches are an error.
pub fn find_depart(c: &Chain, program: &Address, holding: &Address, t: &Transit, slot: u8) -> Result<Option<DepartArgs>, String> {
    let mut found: Option<DepartArgs> = None;
    for l in c.signatures_for(holding, 256, None, None) {
        if l.err.is_some() {
            continue;
        }
        for d in departs_in(&l.wire, program, holding)? {
            if depart_is(&d, t, slot) {
                if found.as_ref().is_some_and(|x| x.commit != d.commit || x.seal != d.seal || x.tip != d.tip) {
                    return Err("two different landed Departs match this transit".into());
                }
                found = Some(d);
            }
        }
    }
    Ok(found)
}

/// The slot entry of an arrival as the quota ranks it (the keeper's: host, citizen tag, departure mass).
pub fn entry_of(t: &Transit, owner_citizen: &Address) -> SlotEntry {
    SlotEntry { host_id: t.host_id, citizen: u64::from_le_bytes(owner_citizen.to_bytes()[..8].try_into().expect("8")), troops: t.dep_mass }
}

/// The Reveal of an opened march (pure): the target index from the slots as read, the path provinces, and whether
/// the ArrivalDay must be written. `Err` names why it cannot be revealed (the program would refuse it for good).
#[allow(clippy::too_many_arguments)]
pub fn reveal_args(href: HoldingRef, slot: u8, t: &Transit, faction: u8, owner_citizen: &Address, opened: &Opened, ct_hash: [u8; 32],
    slots: &[Option<SlotEntry>; 4], day_set: bool, beneficiary: Address) -> Result<RevealArgs, String> {
    let (Some(plain), Some(salt)) = (opened.plain, opened.salt) else { return Err(format!("the seal does not open validly (code {})", opened.code)) };
    let p = fclient::seal::unpack(&plain);
    let dest = (p.dest_p as i32, p.dest_q as i32);
    let path = play::path_provinces((t.origin_p as i32, t.origin_q as i32, t.origin_tile), &p).ok_or("the path is not revealable")?;
    let target = play::target(dest.0, dest.1, t.arrive_bell, slots, entry_of(t, owner_citizen));
    let target_i = match target {
        Target::Fill(i) | Target::Displace(i, _) => i,
        Target::Already => return Err("already revealed".into()),
        Target::Refused(r) => return Err(format!("refused by the quota ({r:?})")),
    };
    Ok(RevealArgs { holding: href, transit_slot: slot, target_i, plain, salt, ct_hash, beneficiary, dest, arrive: t.arrive_bell, faction,
        day_writable: !day_set, path_provinces: path })
}

/// The present positions of a province-bell (owner Holding of each present ArrivalSlot), for `play::gather_parts`.
pub fn present_positions(a: &Addresses, slots: &[Option<ArrivalSlot>; 24]) -> [Option<Address>; 24] {
    core::array::from_fn(|k| slots[k].as_ref().and_then(|s| a.holding_of_host(s.host_id).ok()))
}

/// The slot index `host` holds among a faction's four ArrivalSlots, with that slot's beneficiary.
pub fn slot_of(slots: &[Option<ArrivalSlot>; 4], host: u64) -> Option<(u8, Address)> {
    slots.iter().enumerate().find_map(|(i, s)| s.as_ref().filter(|s| s.host_id == host).map(|s| (i as u8, s.beneficiary)))
}

/// SettleTransit's arguments (pure), as the production keeper fills them: `mine` is the arrival's slot and its
/// beneficiary ([`slot_of`]), or None (the canonical absent index 0, this keeper as beneficiary).
#[allow(clippy::too_many_arguments)]
pub fn settle_args(href: HoldingRef, slot: u8, d: &DepartArgs, t: &Transit, faction: u8, dest: (i32, i32), owner_citizen: Address, rent_payer: Address,
    mine: Option<(u8, Address)>, inputs: Option<&ClashInputs>, anchor_present: bool, beneficiary: Address) -> SettleTransitArgs {
    let (slot_i, slot_beneficiary) = mine.unwrap_or((0, beneficiary));
    let resolved = inputs.filter(|c| c.resolved());
    let resolver = resolved.map_or(beneficiary, |c| c.resolver);
    let camp_citizen = resolved.and_then(|c| (0..4u8).find_map(|i| {
        let r = c.arrivals[faction as usize * 4 + i as usize];
        (r.present == 1 && r.host_id == t.host_id && ix::camp_winner(c.camp_mask, faction, i, r.fate)).then_some(owner_citizen)
    }));
    SettleTransitArgs { holding: href, transit_slot: slot, commit: d.commit, seal: d.seal, beneficiary, dest, arrive: t.arrive_bell, faction, slot_i,
        home: (href.p as i32, href.q as i32), anchor_present, slot_beneficiary, resolver, holding_rent_payer: rent_payer, camp_citizen }
}

/// How one transit's step folds into the driver's step (independent review): a transit that only WAITS (a round
/// not published yet, a window open) never blocks another transit that is due — its reason is kept (the first) and
/// the next transit is looked at; any other step (a landed transaction, an unknown outcome, a stop) is the answer.
pub fn fold_step(first_wait: &mut Option<String>, s: Step) -> Option<Step> {
    match s {
        Step::Wait(w) => { first_wait.get_or_insert(w); None }
        other => Some(other),
    }
}

/// What a destination bell before the arrival needs, from FastForward's simulation over `span` bells (independent
/// review): the quiet bells are fast-forwarded; a NOT-QUIET range is narrowed to one bell, and a not-quiet single
/// bell is driven with the real GatherClash → PostSeed → ResolveFromInputs (as the origin driver does) — never
/// passed off as quiet. Any other refusal stops.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CatchUp { FastForward, Narrow, Gather, Stop }
pub fn catch_up(sim_ok: bool, code: Option<u32>, span: u32) -> CatchUp {
    match (sim_ok, code) {
        (true, _) => CatchUp::FastForward,
        (false, Some(c)) if c == lk::NOT_QUIET && span > 1 => CatchUp::Narrow,
        (false, Some(c)) if c == lk::NOT_QUIET => CatchUp::Gather,
        _ => CatchUp::Stop,
    }
}

/// What to do for a province where a settled host of this village stands (`entry` = its Province entry
/// `(state, pend_op, pend_bell)`, or None when it is no longer there):
/// * gone → `Forget`;
/// * a departed Leave (a keep's donor going home, `donor_handoff`) whose Leave turn is resolved
///   (`resolved_next > pend_bell`) → `Return` (the program's return settle credits its troops home);
/// * otherwise, a turn that has ended and is not resolved (`resolved_next < bell_now`) → `Drive`; else `Wait`.
///
/// The Season bounds it (`SeasonGate`), exactly as the program does: a turn is driven while the Season is effectively
/// Running OR Ended and the turn is before its `end_bell` (clash.rs `CLASH_STATUS` + `in_season`, beacon.rs
/// `ANCHOR_STATUS`: a late but legal turn after the Season ended is still resolved); the return settle is sent while
/// the Season is Running or Ended (what SettleReturn accepts). Past that the stand is forgotten: nothing more can happen
/// there and the host simply stays where it stands. The stand's turns are driven with `end_bell` as their bound, so no
/// anchor is posted early, and no FastForward reaches, at or past `end_bell`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StandAction { Forget, Return, Drive, Wait }
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SeasonGate { pub drive: bool, pub settle: bool }
impl SeasonGate {
    /// From the Season's stored status, genesis, end turn, the chain's time and the turn to resolve.
    pub fn of(stored: u8, genesis_ts: i64, end_bell: u32, now: i64, resolved_next: u32) -> SeasonGate {
        use frontier_abi::layout::world::season as SS;
        let st = SS::effective_status(stored, genesis_ts, now);
        let live = st == SS::STATUS_RUNNING || st == SS::STATUS_ENDED;
        SeasonGate { drive: live && resolved_next < end_bell, settle: live }
    }
}
pub fn stand_action(entry: Option<(u8, u8, u32)>, resolved_next: u32, bell_now: u32, season: SeasonGate) -> StandAction {
    use frontier_abi::layout::province::entry as E;
    let Some((state, pend_op, pend_bell)) = entry else { return StandAction::Forget };
    if state == E::STATE_DEPARTED && pend_op == E::OP_LEAVE && resolved_next > pend_bell {
        return if season.settle { StandAction::Return } else { StandAction::Forget };
    }
    if !season.drive { return StandAction::Forget; }
    if resolved_next < bell_now { StandAction::Drive } else { StandAction::Wait }
}

/// The next past anchor of an untouched destination to post EARLY (review of the page march trial: catching up one
/// bell at a time cost one whole reveal window per lagging bell): the first bell in `[b, b + MAX_FAST_FORWARD_BELLS)`
/// that has ended (`< bell_now`), comes before the arrival (`< arrive`; THE arrival anchor is the keeper's) and has no
/// landed anchor. Posting them back to back lets their reveal windows run side by side; nothing else changes — each
/// anchor's own window is still checked against its own landed time (`closed_through`, and the program's
/// `closed_through` in clash.rs), and the quiet proof / NotQuiet narrowing / real gather are as before.
pub fn anchor_to_post(b: u32, arrive: u32, bell_now: u32, landed: impl Fn(u32) -> bool) -> Option<u32> {
    let end = arrive.min(bell_now).min(b.saturating_add(lk::MAX_FAST_FORWARD_BELLS));
    (b..end).find(|x| !landed(*x))
}

/// The GatherClash form of a province-bell, as the production keeper plans it: None when all 24 positions are
/// gathered; the ONE no-arrivals part when the ArrivalDay bit of the bell is clear (the program records
/// `FLAG_NO_ARRIVALS`); otherwise the parts over the present positions (`play::gather_parts`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum GatherForm { NoArrivals, Parts(Vec<play::GatherPart>) }
pub fn gather_form(mask: u32, day_set: bool, present: &[Option<Address>; 24]) -> Option<GatherForm> {
    if mask == ALL_GATHERED {
        return None;
    }
    if !day_set && mask == 0 {
        return Some(GatherForm::NoArrivals);
    }
    let parts = play::gather_parts(mask, present);
    (!parts.is_empty()).then_some(GatherForm::Parts(parts))
}

// ------------------------------------------------------------------ the driver

/// What the driver remembers of one transit between steps (memory only).
#[derive(Clone, Debug, Default)]
struct Known {
    depart: Option<DepartArgs>,
    opened: Option<Opened>,
    revealed: bool,
}

pub struct LegacyMarchDriver {
    a: Addresses,
    holding: Address,
    href: HoldingRef,
    payer: Keypair,
    stop: tokio::sync::watch::Receiver<bool>,
    pub land_timeout: Duration,
    known: std::collections::BTreeMap<(u64, u32), Known>,
    terminal: Option<Step>,
    pub log: Vec<String>,
    /// The provinces where a settled march's host STANDS (`(dest, host_id)`, never the home: that is the origin
    /// driver's): their turns are this driver's to resolve while the host is there, and its return home is settled
    /// here (`stand_action`). Learned from this driver's own landed SettleTransit.
    pub stands: Vec<((i32, i32), u64)>,
}

impl LegacyMarchDriver {
    /// A driver for the player's legacy village `href` (its Holding address is derived) with a funded fee payer.
    pub fn new(href: HoldingRef, payer: Keypair, stop: tokio::sync::watch::Receiver<bool>) -> LegacyMarchDriver {
        let a = Addresses::new(Address::new_from_array(crate::expedition_play::PROGRAM), crate::expedition_play::SEASON_ID);
        let holding = href.address(&a);
        LegacyMarchDriver { a, holding, href, payer, stop, land_timeout: crate::keeper_loop::LAND_TIMEOUT, known: Default::default(), terminal: None, log: vec![], stands: vec![] }
    }

    pub fn terminal(&self) -> Option<&Step> {
        self.terminal.as_ref()
    }

    async fn send(&mut self, state: &Shared, ix: Instruction, what: &str) -> Step {
        if *self.stop.borrow() {
            return Step::Stopped("stopped by request".into());
        }
        let step = match submit_and_wait(state, &self.payer, ix, what, self.land_timeout, &mut self.stop).await {
            Sent::Landed(sig) => Step::Landed(what.to_string(), sig),
            Sent::Failed(e) => Step::Stopped(e),
            Sent::Unknown { signature, why } => Step::Unknown { signature, why },
        };
        self.log.push(format!("{step:?}"));
        step
    }

    /// Simulate first; send only what the node accepts. A simulated refusal stops the driver (never sent).
    async fn checked(&mut self, state: &Shared, ix: Instruction, what: &str) -> Step {
        // (the node's lock is released before any await: the simulation is read first)
        let sim = { let c = lock(state); lk::simulate_ix(&c, &self.payer, &ix) };
        match sim {
            Ok(sim) if sim.err.is_none() => self.send(state, ix, what).await,
            Ok(sim) => Step::Stopped(format!("{what} simulation: {:?} (code {:?})", sim.err, sim.code)),
            Err(e) => Step::Stopped(e),
        }
    }

    /// At most one transaction (module doc). After `Unknown` or `Stopped`, every later call returns it.
    pub async fn step(&mut self, state: &Shared) -> Step {
        if let Some(t) = &self.terminal {
            return t.clone();
        }
        let s = self.step_inner(state).await;
        if matches!(s, Step::Unknown { .. } | Step::Stopped(_)) {
            self.terminal = Some(s.clone());
        }
        s
    }

    fn read<T>(&self, c: &Chain, k: &Address, decode: impl Fn(&[u8]) -> Result<T, fclient::decode::DecodeError>) -> Option<T> {
        c.account(k).filter(|acc| acc.owner == self.a.program).and_then(|acc| decode(&acc.data).ok())
    }

    async fn step_inner(&mut self, state: &Shared) -> Step {
        let (h, season, clock) = {
            let c = lock(state);
            let Some(h) = self.read(&c, &self.holding, Holding::decode) else { return Step::Stopped("the village's Holding is not readable".into()) };
            let Some(season) = self.read(&c, &self.a.season, Season::decode) else { return Step::Stopped("the Season is not readable".into()) };
            match lk::season_clock(&c, &self.a) {
                Ok(k) => (h, season, k),
                Err(e) => return Step::Stopped(e),
            }
        };
        let v2 = season.is_v2();
        let transits = live_transits(&h);
        let mut first_wait: Option<String> = None;
        for (slot, t) in transits {
            let s = self.transit_step(state, &h, v2, &clock, slot, t).await;
            if let Some(answer) = fold_step(&mut first_wait, s) {
                return answer;
            }
        }
        // then the provinces where a settled host stands (a march's own steps always come first)
        let s = self.stand_step(state, v2, &clock, &season).await;
        if let Some(answer) = fold_step(&mut first_wait, s) {
            return answer;
        }
        Step::Wait(first_wait.unwrap_or_else(|| "no march of this village".into()))
    }

    /// One step for the provinces where this village's settled hosts stand: resolve their turns (the same
    /// `destination_bell`: anchors posted early and bounded, each window checked, FastForward only when its simulation
    /// accepts, a not-quiet turn gathered, seeded and resolved for real), and once a host's Leave turn (a keep's donor
    /// going home) is resolved, the program's own return settle (SettleDeparture with `RETURN_SLOT`). A host no longer
    /// in the province is forgotten.
    async fn stand_step(&mut self, state: &Shared, v2: bool, clock: &fclient::clock::SeasonClock, season: &Season) -> Step {
        let me = self.payer.pubkey();
        let mut first_wait: Option<String> = None;
        let mut gone = vec![];
        for (k, &(dest, host)) in self.stands.clone().iter().enumerate() {
            let (dv, entry) = {
                let c = lock(state);
                let dv = lk::view(&c, &self.a, dest.0 as i16, dest.1 as i16);
                let pv = self.read(&c, &self.a.province(dest.0, dest.1), fclient::decode::Province::decode);
                (dv, pv.and_then(|pv| pv.entries.into_iter().find(|e| e.id == host)))
            };
            let dv = match dv { Ok(v) => v, Err(e) => return Step::Stopped(format!("cannot read the stand province {dest:?}: {e}")) };
            let gate = SeasonGate::of(season.status, season.genesis_ts, season.end_bell, lock(state).unix_timestamp(), dv.resolved_next);
            let s = match stand_action(entry.as_ref().map(|e| (e.state, e.pend_op, e.pend_bell)), dv.resolved_next, dv.bell_now, gate) {
                StandAction::Forget => { gone.push(k); continue; }
                StandAction::Return => {
                    let ix = if v2 { ix2::settle_departure(&self.a, me, (dest.0 as i16, dest.1 as i16), self.href, ix::RETURN_SLOT) } else { ix::settle_return(&self.a, me, (dest.0 as i16, dest.1 as i16), self.href) };
                    self.checked(state, ix, &format!("SettleReturn({},{})", dest.0, dest.1)).await
                }
                // (bounded by end_bell: `destination_bell` posts early anchors and fast-forwards only below its bound, and a
                //  stand never reaches the bound itself — stand_action drives only turns before end_bell)
                StandAction::Drive => self.destination_bell(state, clock, dest, &dv, dv.resolved_next, season.end_bell).await,
                StandAction::Wait => Step::Wait(format!("the stand province {dest:?}: turn {} has not ended", dv.resolved_next)),
            };
            if let Some(answer) = fold_step(&mut first_wait, s) {
                for k in gone.into_iter().rev() { self.stands.remove(k); }
                return answer;
            }
        }
        for k in gone.into_iter().rev() { self.stands.remove(k); }
        Step::Wait(first_wait.unwrap_or_else(|| "no march of this village".into()))
    }

    /// One transit's step (at most one transaction). A `Wait` here never blocks another transit ([`fold_step`]).
    async fn transit_step(&mut self, state: &Shared, h: &Holding, v2: bool, clock: &fclient::clock::SeasonClock, slot: u8, t: Transit) -> Step {
        let me = self.payer.pubkey();
        {
            let key = (t.host_id, t.depart_bell);
            // 1. SettleDeparture
            if t.state == T_DEPARTED {
                let origin = { let c = lock(state); lk::view(&c, &self.a, t.origin_p, t.origin_q) };
                let origin = match origin { Ok(v) => v, Err(e) => return Step::Stopped(format!("cannot read the origin: {e}")) };
                if !departure_due(&t, origin.resolved_next) {
                    return Step::Wait(format!("slot {slot}: the origin driver resolves departure bell {} first", t.depart_bell));
                }
                let ix = if v2 { ix2::settle_departure(&self.a, me, (t.origin_p, t.origin_q), self.href, slot) } else { ix::settle_departure(&self.a, me, (t.origin_p, t.origin_q), self.href, slot) };
                return self.checked(state, ix, &format!("SettleDeparture(slot {slot})")).await;
            }
            if t.state != T_SETTLED {
                return Step::Stopped(format!("transit slot {slot} is in state {} (destroyed at origin or unknown): not driven here", t.state));
            }
            // 2. the Depart's own bytes
            if self.known.get(&key).and_then(|k| k.depart.as_ref()).is_none() {
                let d = { let c = lock(state); find_depart(&c, &self.a.program, &self.holding, &t, slot) };
                match d {
                    Ok(Some(d)) => { self.known.entry(key).or_default().depart = Some(d); }
                    Ok(None) => return Step::Stopped(format!("no landed Depart matches transit slot {slot}")),
                    Err(e) => return Step::Stopped(e),
                }
            }
            let d = self.known[&key].depart.clone().expect("found");
            // 3. Decrypt at T(arrive)
            if self.known[&key].opened.is_none() {
                let round = clock.tlock_round(t.arrive_bell);
                let now = lock(state).unix_timestamp();
                if clock.drand.round_time(round) > now {
                    return Step::Wait(format!("round {round} (T of arrival bell {}) is not published yet", t.arrive_bell));
                }
                let fetched = tokio::select! {
                    r = lk::fetch_round_at(round) => r,
                    _ = crate::keeper_loop::stopped(&mut self.stop) => return Step::Stopped("stopped by request".into()),
                };
                let sig48 = match fetched { Ok(s) => s, Err(e) => return Step::Wait(format!("round {round}: {e}")) };
                let o = play::open_march(&d.seal, &d.commit, &sig48, t.host_id, t.arrive_bell);
                if !o.valid() {
                    return Step::Stopped(format!("the seal of transit slot {slot} does not open validly (code {}): its settlement is not driven here", o.code));
                }
                self.known.get_mut(&key).expect("known").opened = Some(o);
            }
            let opened = self.known[&key].opened.expect("opened");
            let plain = opened.plain().expect("valid");
            let dest = (plain.dest_p as i32, plain.dest_q as i32);
            let dv = { let c = lock(state); lk::view(&c, &self.a, plain.dest_p, plain.dest_q) };
            let dv = match dv { Ok(v) => v, Err(e) => return Step::Stopped(format!("the destination ({}, {}) is not open: {e}", dest.0, dest.1)) };
            let arrive = t.arrive_bell;
            // 4. Reveal
            let (slots4, inputs, day_set, anchor_a) = {
                let c = lock(state);
                let slots4: [Option<ArrivalSlot>; 4] = core::array::from_fn(|i| self.read(&c, &self.a.arrival_slot(dest.0, dest.1, arrive, h.faction, i as u8), ArrivalSlot::decode));
                let inputs = self.read(&c, &self.a.clash_inputs(dest.0, dest.1, arrive), ClashInputs::decode);
                let day = self.read(&c, &self.a.arrival_day(dest.0, dest.1, frontier_abi::addr::day_of(arrive)), ArrivalDay::decode);
                (slots4, inputs, day.is_some_and(|d| d.has(arrive)), lk::anchor_landed(&c, &self.a, arrive, dv.region))
            };
            let anchor_a = match anchor_a { Ok(x) => x, Err(e) => return Step::Stopped(e) };
            let mine = slots4.iter().any(|s| s.as_ref().is_some_and(|s| s.host_id == t.host_id));
            if mine {
                self.known.get_mut(&key).expect("known").revealed = true;
            }
            if !mine && inputs.is_none() && dv.resolved_next <= arrive {
                let Some(a_ts) = anchor_a else { return Step::Wait(format!("THE anchor of bell {arrive} in region {} is not posted yet", dv.region)) };
                let now = lock(state).unix_timestamp();
                if now >= clock.reveal_close(arrive, a_ts) {
                    return Step::Stopped(format!("the reveal window of bell {arrive} closed with transit slot {slot} unrevealed: not forced"));
                }
                let entries: [Option<SlotEntry>; 4] = core::array::from_fn(|i| slots4[i].as_ref().map(|s| SlotEntry { host_id: s.host_id, citizen: s.citizen_tag, troops: s.dep_mass }));
                let ct = fclient::seal::ct_hash(&d.seal);
                let args = match reveal_args(self.href, slot, &t, h.faction, &h.owner_citizen, &opened, ct, &entries, day_set, me) {
                    Ok(a) => a,
                    Err(e) => return Step::Stopped(format!("transit slot {slot}: {e}")),
                };
                let ix = ix::reveal(&self.a, me, &args);
                return self.checked(state, ix, &format!("Reveal(slot {slot}, bell {arrive})")).await;
            }
            // 5./6. the destination's bells up to and including the arrival, oldest first
            if dv.resolved_next <= arrive {
                return self.destination_bell(state, clock, dest, &dv, dv.resolved_next, arrive).await;
            }
            // 7. SettleTransit
            let Some(a_ts) = anchor_a else { return Step::Stopped(format!("the destination resolved past {arrive} without THE anchor present: archive settlement is not driven here")) };
            let now = lock(state).unix_timestamp();
            if now < clock.settle_after(arrive, a_ts) {
                return Step::Wait(format!("SettleTransit of slot {slot} is not due yet"));
            }
            let args = settle_args(self.href, slot, &d, &t, h.faction, dest, h.owner_citizen, h.rent_payer, slot_of(&slots4, t.host_id), inputs.as_ref(), true, me);
            let ix = if v2 { ix2::settle_transit(&self.a, me, &args, None) } else { ix::settle_transit(&self.a, me, &args) };
            let s = self.checked(state, ix, &format!("SettleTransit(slot {slot}, bell {arrive})")).await;
            // the host now stands at its destination (unless that is the home: the origin driver's)
            if matches!(s, Step::Landed(..)) && dest != (h.p as i32, h.q as i32) && !self.stands.contains(&(dest, t.host_id)) {
                self.stands.push((dest, t.host_id));
            }
            s
        }
    }

    /// The destination's bell `b` (≤ `arrive`): its anchor posted when absent; once its window closed, a bell before
    /// the arrival is fast-forwarded only when FastForward's simulation accepts it (a not-quiet range is narrowed to
    /// one bell, a not-quiet bell is gathered, seeded and resolved for real: [`catch_up`]); the arrival bell is always
    /// gathered, seeded and resolved.
    async fn destination_bell(&mut self, state: &Shared, clock: &fclient::clock::SeasonClock, dest: (i32, i32), dv: &lk::HomeView, b: u32, arrive: u32) -> Step {
        let me = self.payer.pubkey();
        let (dp, dq) = (dest.0 as i16, dest.1 as i16);
        // the lagging bells' anchors first, back to back and bounded (`anchor_to_post`); an unreadable one is not posted
        let early = { let c = lock(state); anchor_to_post(b, arrive, dv.bell_now, |x| !matches!(lk::anchor_landed(&c, &self.a, x, dv.region), Ok(None))) };
        if let Some(x) = early {
            let rounds = tokio::select! {
                r = lk::fetch_rounds(clock, x..x + 1) => r,
                _ = crate::keeper_loop::stopped(&mut self.stop) => return Step::Stopped("stopped by request".into()),
            };
            let r = match rounds { Ok(r) if r.len() == 1 => r.into_iter().next().expect("one"), Ok(_) => return Step::Wait(format!("anchor round of bell {x}")), Err(e) => return Step::Wait(e) };
            let ix = match lk::post_anchor_ix(&self.a, &me, dv.region, &r) { Ok(ix) => ix, Err(e) => return Step::Stopped(e) };
            return self.checked(state, ix, &format!("PostAnchor(bell {x}, region {})", dv.region)).await;
        }
        let anchor = { let c = lock(state); lk::anchor_landed(&c, &self.a, b, dv.region) };
        let a_ts = match anchor {
            Ok(Some(t)) => t,
            Ok(None) => {
                if b >= dv.bell_now {
                    return Step::Wait(format!("destination bell {b} has not ended"));
                }
                if b == arrive {
                    return Step::Wait(format!("THE anchor of bell {arrive} in region {} is not posted yet", dv.region));
                }
                let rounds = tokio::select! {
                    r = lk::fetch_rounds(clock, b..b + 1) => r,
                    _ = crate::keeper_loop::stopped(&mut self.stop) => return Step::Stopped("stopped by request".into()),
                };
                let r = match rounds { Ok(r) if r.len() == 1 => r.into_iter().next().expect("one"), Ok(_) => return Step::Wait(format!("anchor round of bell {b}")), Err(e) => return Step::Wait(e) };
                let ix = match lk::post_anchor_ix(&self.a, &me, dv.region, &r) { Ok(ix) => ix, Err(e) => return Step::Stopped(e) };
                return self.checked(state, ix, &format!("PostAnchor(bell {b}, region {})", dv.region)).await;
            }
            Err(e) => return Step::Stopped(e),
        };
        let now = lock(state).unix_timestamp();
        if now < clock.reveal_close(b, a_ts) {
            return Step::Wait(format!("the reveal window of destination bell {b} is open"));
        }
        if b < arrive {
            let end = { let c = lock(state); lk::closed_through(&c, &self.a, dv.region, b, arrive.min(b + lk::MAX_FAST_FORWARD_BELLS)) };
            let mut end = match end { Ok(x) => x.max(b + 1).min(arrive), Err(e) => return Step::Stopped(e) };
            loop {
                let ix = match lk::fast_forward_ix(&self.a, &me, dp, dq, dv, end) { Ok(ix) => ix, Err(e) => return Step::Stopped(e) };
                let sim = { let c = lock(state); lk::simulate_ix(&c, &self.payer, &ix) };
                let (ok, code) = match &sim { Ok(x) => (x.err.is_none(), x.code), Err(_) => (false, None) };
                match catch_up(ok, code, end - b) {
                    CatchUp::FastForward => return self.send(state, ix, &format!("FastForward(destination {b} → {end})")).await,
                    CatchUp::Narrow => { end = b + 1; continue; }
                    CatchUp::Gather => break,
                    CatchUp::Stop => return Step::Stopped(format!("FastForward(destination {b} → {end}) simulation: {sim:?}")),
                }
            }
        }
        // a not-quiet bell, or the arrival bell: the real gather, seed and resolve
        let (inputs, day_set, all) = {
            let c = lock(state);
            let inputs = self.read(&c, &self.a.clash_inputs(dest.0, dest.1, b), ClashInputs::decode);
            let day = self.read(&c, &self.a.arrival_day(dest.0, dest.1, frontier_abi::addr::day_of(b)), ArrivalDay::decode);
            let all: [Option<ArrivalSlot>; 24] = core::array::from_fn(|k| self.read(&c, &self.a.arrival_slot(dest.0, dest.1, b, (k / 4) as u8, (k % 4) as u8), ArrivalSlot::decode));
            (inputs, day.is_some_and(|d| d.has(b)), all)
        };
        let mask = inputs.as_ref().map_or(0, |c| c.arrivals_mask);
        match gather_form(mask, day_set, &present_positions(&self.a, &all)) {
            Some(GatherForm::NoArrivals) => {
                let ix = ix::gather_clash(&self.a, me, dest, b, AnchorSource::Anchor, 0, &[(0, 0)], &[], 0, &me);
                return self.checked(state, ix, &format!("GatherClash(destination bell {b}, no arrivals)")).await;
            }
            Some(GatherForm::Parts(parts)) => {
                let part = parts.into_iter().next().expect("non-empty");
                let ix = ix::gather_clash(&self.a, me, dest, b, AnchorSource::Anchor, part.start, &part.slots, &part.holdings, part.bitmap, &me);
                return self.checked(state, ix, &format!("GatherClash(destination bell {b}, from {})", part.start)).await;
            }
            None => {}
        }
        let seeded = lock(state).account(&self.a.seed_cache(b, dv.region, 0)).is_some();
        if !seeded {
            let round = clock.seed_round(b, a_ts);
            if clock.drand.round_time(round) > now {
                return Step::Wait(format!("the seed round {round} of destination bell {b} is not due yet"));
            }
            let fetched = tokio::select! {
                r = lk::fetch_round_at(round) => r,
                _ = crate::keeper_loop::stopped(&mut self.stop) => return Step::Stopped("stopped by request".into()),
            };
            let sig48 = match fetched { Ok(s) => s, Err(e) => return Step::Wait(format!("seed round {round}: {e}")) };
            let arg = BeaconArg { round, sig48, hints: fclient::beacon::hints_bytes(round) };
            let ix = ix::post_seed(&self.a, me, dv.region, b, 0, &arg, &me);
            return self.checked(state, ix, &format!("PostSeed(destination bell {b}, round {round})")).await;
        }
        let ix = ix::resolve_from_inputs(&self.a, me, dest, b, SeedSource::Cache { nonce: 0 }, &me);
        self.checked(state, ix, &format!("ResolveFromInputs(destination bell {b})")).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn transit(state: u8) -> Transit {
        let mut t = Transit::decode(&[0u8; 512]);
        t.state = state;
        t.host_id = 77;
        t.depart_bell = 5;
        t.arrive_bell = 9;
        t.origin_p = 2;
        t.dep_mass = 100;
        t
    }

    #[test]
    fn departure_is_due_only_when_departed_and_the_origin_resolved_past_its_bell() {
        assert!(!departure_due(&transit(T_DEPARTED), 5));
        assert!(departure_due(&transit(T_DEPARTED), 6));
        for s in [T_FREE, T_SETTLED, T_DESTROYED_AT_ORIGIN] {
            assert!(!departure_due(&transit(s), 100), "state {s}");
        }
    }

    #[test]
    fn the_depart_parses_from_the_games_own_builders_and_matches_only_its_transit() {
        let a = Addresses::new(Address::new_from_array(crate::expedition_play::PROGRAM), crate::expedition_play::SEASON_ID);
        let wallet = Keypair::new();
        let p = fclient::ix::Player { actor: wallet.pubkey(), payer: wallet.pubkey(), wallet: wallet.pubkey() };
        let href = HoldingRef { p: 2, q: 0, site: 11 };
        let mut seal = [0xabu8; 165];
        seal[0] = 0x80;
        let args = DepartArgs { host_id: 77, commit: [0xcd; 32], seal, arrive_bell: 9, tip: 1000, transit_slot: 1 };
        for ixn in [ix::depart(&a, &p, href, (2, 0), &args), ix2::depart(&a, &p, href, (2, 0), &args)] {
            let d = parse_depart(&ixn.data).expect("a Depart");
            assert_eq!((d.host_id, d.commit, d.seal, d.arrive_bell, d.tip, d.transit_slot), (77, [0xcd; 32], seal, 9, 1000, 1));
        }
        let mut t = transit(T_SETTLED);
        t.seal_root = legacy_seal_root(&args.commit, &args.seal);
        assert!(depart_is(&args, &t, 1));
        assert!(!depart_is(&args, &t, 0), "another slot");
        let mut other = args.clone();
        other.seal[5] ^= 1;
        assert!(!depart_is(&other, &t, 1), "another seal");
        let mut other = args.clone();
        other.arrive_bell = 10;
        assert!(!depart_is(&other, &t, 1), "another arrival");
        assert!(parse_depart(&ix::settle_departure(&a, wallet.pubkey(), (2, 0), href, 0).data).is_none(), "not a Depart");
        let mut long = ix::depart(&a, &p, href, (2, 0), &args).data;
        long.push(0);
        assert!(parse_depart(&long).is_none(), "a longer payload");
    }

    #[test]
    fn a_waiting_transit_never_blocks_a_due_one() {
        let mut first = None;
        assert_eq!(fold_step(&mut first, Step::Wait("slot 0: round 99 not published".into())), None, "a wait goes on to the next transit");
        let due = Step::Landed("Reveal(slot 1, bell 9)".into(), "sig".into());
        assert_eq!(fold_step(&mut first, due.clone()), Some(due), "the due transit's step is the answer");
        assert_eq!(first.as_deref(), Some("slot 0: round 99 not published"));
        let mut first = None;
        assert_eq!(fold_step(&mut first, Step::Wait("a".into())), None);
        assert_eq!(fold_step(&mut first, Step::Wait("b".into())), None);
        assert_eq!(first.as_deref(), Some("a"), "the first wait is kept");
        // an unknown outcome or a stop is never skipped over
        let mut first = None;
        assert!(matches!(fold_step(&mut first, Step::Unknown { signature: "s".into(), why: "w".into() }), Some(Step::Unknown { .. })));
        assert!(matches!(fold_step(&mut first, Step::Stopped("x".into())), Some(Step::Stopped(_))));
    }

    #[test]
    fn a_not_quiet_destination_bell_is_gathered_for_real_never_passed_off_as_quiet() {
        assert_eq!(catch_up(true, None, 5), CatchUp::FastForward);
        assert_eq!(catch_up(false, Some(lk::NOT_QUIET), 5), CatchUp::Narrow, "a not-quiet range: one bell");
        assert_eq!(catch_up(false, Some(lk::NOT_QUIET), 1), CatchUp::Gather, "a not-quiet bell: gather, seed, resolve");
        assert_eq!(catch_up(false, Some(lk::NOT_QUIET + 1), 1), CatchUp::Stop, "any other refusal stops");
        assert_eq!(catch_up(false, None, 3), CatchUp::Stop, "no answer stops");
    }

    #[test]
    fn the_gather_form_is_the_keepers() {
        let none: [Option<Address>; 24] = [None; 24];
        assert_eq!(gather_form(ALL_GATHERED, true, &none), None, "all gathered");
        assert_eq!(gather_form(0, false, &none), Some(GatherForm::NoArrivals), "a clear day bit: the one no-arrivals part");
        let mut present = none;
        present[5] = Some(Address::new_from_array([7; 32]));
        match gather_form(0, true, &present) {
            Some(GatherForm::Parts(parts)) => {
                assert!(parts.iter().any(|p| p.bitmap & (1 << 5) != 0 && p.holdings.contains(&Address::new_from_array([7; 32]))), "the present position is named with its Holding");
                let covered: u32 = parts.iter().map(|p| p.slots.len() as u32).sum();
                assert_eq!(covered, 24);
            }
            other => panic!("{other:?}"),
        }
        match gather_form(0x0000_000F, true, &present) {
            Some(GatherForm::Parts(parts)) => assert!(parts.iter().all(|p| p.start >= 4), "gathered positions are not gathered again"),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn the_legacy_seal_root_is_the_programs_shape() {
        let commit = [1u8; 32];
        let seal = [2u8; 165];
        let ct = fclient::seal::ct_hash(&seal);
        assert_eq!(legacy_seal_root(&commit, &seal), permutation_rules::hash::sha256(&[&commit, &ct]));
    }

    #[test]
    fn a_seal_that_does_not_open_is_never_revealed() {
        let t = transit(T_SETTLED);
        let o = Opened { code: 1, plain: None, salt: None };
        let e = reveal_args(HoldingRef { p: 2, q: 0, site: 11 }, 0, &t, 0, &Address::new_from_array([3; 32]), &o, [0; 32], &[None; 4], false, Address::new_from_array([4; 32]));
        assert!(e.unwrap_err().contains("does not open validly"));
    }

    #[test]
    fn settle_args_name_the_slot_its_beneficiary_and_the_resolver_as_the_keeper_does() {
        let t = transit(T_SETTLED);
        let d = DepartArgs { host_id: 77, commit: [5; 32], seal: [6; 165], arrive_bell: 9, tip: 1, transit_slot: 2 };
        let me = Address::new_from_array([9; 32]);
        let ben = Address::new_from_array([8; 32]);
        let a = settle_args(HoldingRef { p: 2, q: 0, site: 11 }, 2, &d, &t, 0, (3, 0), Address::new_from_array([1; 32]), Address::new_from_array([2; 32]), Some((2, ben)), None, true, me);
        assert_eq!((a.slot_i, a.slot_beneficiary, a.resolver, a.transit_slot, a.home, a.dest, a.arrive), (2, ben, me, 2, (2, 0), (3, 0), 9));
        assert_eq!((a.commit, a.seal), ([5; 32], [6; 165]), "the Depart's own commitment and seal");
        assert!(a.camp_citizen.is_none());
        let b = settle_args(HoldingRef { p: 2, q: 0, site: 11 }, 2, &d, &t, 0, (3, 0), Address::new_from_array([1; 32]), Address::new_from_array([2; 32]), None, None, true, me);
        assert_eq!((b.slot_i, b.slot_beneficiary), (0, me), "no slot: the canonical absent index, this keeper");
        assert!(slot_of(&[None, None, None, None], 77).is_none());
    }
}

#[cfg(test)]
mod stands {
    use super::{stand_action as sa, SeasonGate, StandAction};
    use frontier_abi::layout::province::entry as E;
    const OPEN: SeasonGate = SeasonGate { drive: true, settle: true };
    fn stand_action(e: Option<(u8, u8, u32)>, rn: u32, now: u32) -> StandAction { sa(e, rn, now, OPEN) }
    #[test]
    fn the_season_bounds_the_stand_driving_and_the_return() {
        use frontier_abi::layout::world::season as SS;
        // the gate from the Season: Running before end_bell drives; Ended settles only; Closed does neither
        assert_eq!(SeasonGate::of(SS::STATUS_SEEDED, 100, 50, 200, 49), SeasonGate { drive: true, settle: true });
        assert_eq!(SeasonGate::of(SS::STATUS_SEEDED, 100, 50, 200, 50), SeasonGate { drive: false, settle: true }, "end_bell is never resolved");
        assert_eq!(SeasonGate::of(SS::STATUS_SEEDED, 100, 50, 99, 10), SeasonGate { drive: false, settle: false }, "before genesis: not running");
        assert_eq!(SeasonGate::of(SS::STATUS_ENDED, 100, 50, 200, 10), SeasonGate { drive: true, settle: true }, "Ended: a late legal turn before end_bell is still resolved");
        assert_eq!(SeasonGate::of(SS::STATUS_ENDED, 100, 50, 200, 50), SeasonGate { drive: false, settle: true }, "Ended at end_bell: returns only");
        assert_eq!(SeasonGate::of(SS::STATUS_CLOSED, 100, 50, 200, 10), SeasonGate { drive: false, settle: false });
        let closed = SeasonGate { drive: false, settle: false };
        // Ended, end_bell 50: a LATE Leave at turn 20, not resolved yet (resolved_next 20) → drive it; once resolved → return
        let ended_before = SeasonGate::of(SS::STATUS_ENDED, 100, 50, 200, 20);
        assert_eq!(sa(Some((E::STATE_DEPARTED, E::OP_LEAVE, 20)), 20, 25, ended_before), StandAction::Drive, "Ended: the late Leave turn is still resolved");
        let ended_after = SeasonGate::of(SS::STATUS_ENDED, 100, 50, 200, 21);
        assert_eq!(sa(Some((E::STATE_DEPARTED, E::OP_LEAVE, 20)), 21, 25, ended_after), StandAction::Return, "then its return is settled");
        // at end_bell nothing more is resolved: a roster stand is forgotten (the host stays), a resolved Leave still returns
        let at_end = SeasonGate::of(SS::STATUS_ENDED, 100, 50, 200, 50);
        assert_eq!(sa(Some((E::STATE_ROSTER, E::OP_NONE, 0)), 50, 55, at_end), StandAction::Forget);
        assert_eq!(sa(Some((E::STATE_DEPARTED, E::OP_LEAVE, 49)), 50, 55, at_end), StandAction::Return);
        assert_eq!(sa(Some((E::STATE_DEPARTED, E::OP_LEAVE, 50)), 50, 55, at_end), StandAction::Forget, "a Leave at end_bell is never resolved");
        assert_eq!(sa(Some((E::STATE_DEPARTED, E::OP_LEAVE, 20)), 21, 25, closed), StandAction::Forget, "a closed season settles nothing");
    }
    #[test]
    fn a_standing_host_province_is_driven_and_its_donor_returned_only_after_its_leave_turn() {
        assert_eq!(stand_action(None, 9, 12), StandAction::Forget, "no longer there: forgotten");
        assert_eq!(stand_action(Some((E::STATE_ROSTER, E::OP_NONE, 0)), 9, 12), StandAction::Drive, "an ended turn: driven");
        assert_eq!(stand_action(Some((E::STATE_ROSTER, E::OP_NONE, 0)), 12, 12), StandAction::Wait, "the current turn: not yet");
        // the keep's donor: Leave at turn 20
        assert_eq!(stand_action(Some((E::STATE_DEPARTED, E::OP_LEAVE, 20)), 20, 25), StandAction::Drive, "its Leave turn is not resolved: drive it, no return yet");
        assert_eq!(stand_action(Some((E::STATE_DEPARTED, E::OP_LEAVE, 20)), 21, 25), StandAction::Return, "its Leave turn resolved: the return settle");
        assert_eq!(stand_action(Some((E::STATE_DEPARTED, E::OP_LEAVE, 20)), 21, 21), StandAction::Return, "the return needs no ended turn");
        assert_eq!(stand_action(Some((E::STATE_DEPARTED, E::OP_NONE, 20)), 21, 21), StandAction::Wait, "departed without a Leave: nothing of ours to settle");
    }
}

#[cfg(test)]
mod early_anchors {
    use super::{anchor_to_post, lk};
    #[test]
    fn the_lagging_anchors_are_posted_first_in_order_and_bounded() {
        let none = |_: u32| false;
        assert_eq!(anchor_to_post(1, 6, 20, none), Some(1), "the oldest missing first");
        assert_eq!(anchor_to_post(1, 6, 20, |x| x <= 3), Some(4), "then the next missing one, not waiting on bell 1's window");
        assert_eq!(anchor_to_post(1, 6, 20, |x| x < 6), None, "never THE arrival anchor (the keeper's): bells before 6 only");
        assert_eq!(anchor_to_post(1, 30, 4, |x| x < 4), None, "never a bell that has not ended");
        assert_eq!(anchor_to_post(1, 100, 100, |x| x < 1 + lk::MAX_FAST_FORWARD_BELLS), None, "bounded by one FastForward's reach");
        assert_eq!(anchor_to_post(1, 100, 100, |x| x < 1 + lk::MAX_FAST_FORWARD_BELLS - 1), Some(lk::MAX_FAST_FORWARD_BELLS));
        assert_eq!(anchor_to_post(u32::MAX - 1, u32::MAX, u32::MAX, none), Some(u32::MAX - 1), "no overflow at the top");
        assert_eq!(anchor_to_post(5, 5, 9, none), None, "the arrival bell itself is never early-posted");
        // a stand is driven with end_bell as the bound: no early anchor at or past it, even with 16 to spare
        let end = 50;
        assert_eq!(anchor_to_post(40, end, 100, |x| x < 49), Some(49), "the last turn before end_bell");
        assert_eq!(anchor_to_post(40, end, 100, |x| x < 50), None, "nothing at end_bell or past it");
        assert!((0..=end).all(|b| anchor_to_post(b, end, u32::MAX, none).map_or(true, |x| x < end)), "every early anchor is below end_bell");
    }
}

/// The order the real test asserts on its landed steps (`Landed("<label>", "<sig>")` as the Pilot reports them):
/// the departure bell's resolve → SettleDeparture → Reveal → the ARRIVAL bell's gather → the ARRIVAL bell's resolve
/// (exactly one, by the origin or the legacy driver) → SettleTransit. Labels are matched with their closing
/// punctuation, so bell 1 never matches bell 12, and the departure resolve can never stand in for the arrival's.
#[cfg(test)]
pub(crate) mod landed_order {
    fn at(seen: &[String], pats: &[String]) -> Vec<usize> {
        seen.iter().enumerate().filter(|(_, s)| pats.iter().any(|p| s.contains(p.as_str()))).map(|(i, _)| i).collect()
    }
    fn one(seen: &[String], what: &str, pats: &[String]) -> Result<usize, String> {
        match at(seen, pats).as_slice() {
            [i] => Ok(*i),
            [] => Err(format!("{what} did not land: {seen:?}")),
            many => Err(format!("{what} landed {} times: {seen:?}", many.len())),
        }
    }
    pub(crate) fn check(seen: &[String], slot: u8, depart_bell: u32, arrive: u32) -> Result<(), String> {
        if depart_bell >= arrive { return Err(format!("departure bell {depart_bell} is not before arrival bell {arrive}")); }
        let (d, a) = (depart_bell, arrive);
        // (the departure bell is resolved by the origin driver, or fast-forwarded by the keeper itself when quiet — that
        //  one is not in the drivers' reports; either way never twice, and never after SettleDeparture)
        let deps = at(seen, &[format!("\"ResolveFromInputs(bell {d})\"")]);
        if deps.len() > 1 { return Err(format!("the departure bell's resolve landed {} times: {seen:?}", deps.len())); }
        let sd = one(seen, "SettleDeparture", &[format!("\"SettleDeparture(slot {slot})\"")])?;
        let rv = one(seen, "Reveal", &[format!("\"Reveal(slot {slot}, bell {a})\"")])?;
        let gathers = at(seen, &[format!("\"GatherClash(bell {a})\""), format!("\"GatherClash(bell {a}, "), format!("\"GatherClash(destination bell {a}, ")]);
        let arr = one(seen, "the arrival bell's resolve", &[format!("\"ResolveFromInputs(bell {a})\""), format!("\"ResolveFromInputs(destination bell {a})\"")])?;
        let st = one(seen, "SettleTransit", &[format!("\"SettleTransit(slot {slot}, bell {a})\"")])?;
        if deps.iter().any(|dep| !(*dep < sd)) { return Err(format!("SettleDeparture before the departure bell's resolve: {seen:?}")); }
        if !(sd < rv) { return Err(format!("Reveal before SettleDeparture: {seen:?}")); }
        if gathers.is_empty() || !gathers.iter().all(|g| rv < *g && *g < arr) { return Err(format!("the arrival bell's gather is not between Reveal and its resolve: {seen:?}")); }
        if !(rv < arr && arr < st) { return Err(format!("the arrival bell's resolve is not after Reveal and before SettleTransit: {seen:?}")); }
        Ok(())
    }

    #[cfg(test)]
    mod tests {
        use super::check;
        fn l(x: &str) -> String { format!("Landed(\"{x}\", \"sig-{x}\")") }
        fn good() -> Vec<String> {
            ["ResolveFromInputs(bell 9)", "SettleDeparture(slot 0)", "PostSeed(bell 10, round 5)", "ResolveFromInputs(bell 10)", "ResolveFromInputs(bell 11)",
             "Reveal(slot 0, bell 12)", "GatherClash(bell 12, from 0)", "PostSeed(bell 12, round 9)", "ResolveFromInputs(bell 12)", "SettleTransit(slot 0, bell 12)"].map(l).to_vec()
        }
        #[test]
        fn the_whole_order_passes_by_either_driver() {
            assert_eq!(check(&good(), 0, 9, 12), Ok(()));
            let by_legacy: Vec<String> = good().into_iter().map(|s| s.replace("GatherClash(bell 12,", "GatherClash(destination bell 12,").replace("ResolveFromInputs(bell 12)", "ResolveFromInputs(destination bell 12)")).collect();
            assert_eq!(check(&by_legacy, 0, 9, 12), Ok(()));
        }
        #[test]
        fn the_departure_resolve_never_stands_in_for_the_arrival() {
            let mut s = good();
            s.retain(|x| !x.contains("ResolveFromInputs(bell 12)"));
            assert!(check(&s, 0, 9, 12).unwrap_err().contains("arrival bell's resolve did not land"));
            // bell 1 never matches bell 12: with departure bell 1, "ResolveFromInputs(bell 12)" still counts once, as the arrival's
            assert_eq!(check(&good(), 0, 1, 12), Ok(()));
            let mut s = good(); s.remove(0);       // the departure bell fast-forwarded by the keeper (not reported)
            assert_eq!(check(&s, 0, 9, 12), Ok(()));
            assert!(check(&good(), 0, 12, 12).is_err());
        }
        #[test]
        fn a_resolve_before_reveal_or_after_settle_or_twice_fails() {
            let mut s = good();
            let r = s.remove(8); s.insert(5, r);   // the arrival resolve before Reveal
            assert!(check(&s, 0, 9, 12).is_err());
            let mut s = good();
            let r = s.remove(8); s.push(r);        // after SettleTransit
            assert!(check(&s, 0, 9, 12).is_err());
            let mut s = good();
            s.insert(9, l("ResolveFromInputs(destination bell 12)"));   // both drivers resolved it
            assert!(check(&s, 0, 9, 12).unwrap_err().contains("2 times"));
            let mut s = good();
            s.retain(|x| !x.contains("GatherClash"));
            assert!(check(&s, 0, 9, 12).unwrap_err().contains("gather"));
            let mut s = good();
            s.swap(0, 1);                          // SettleDeparture before the departure resolve
            assert!(check(&s, 0, 9, 12).is_err());
        }
    }
}

/// **REAL artifact + public drand — NOT RUN without the user's approval** (`#[ignore]`; it refuses to start unless
/// `WYLLS_PUBLIC_DRAND=1`, `WYLLS_EXPEDITION_SBF`, `WYLLS_EXPEDITION_SBF_SHA256` and `WYLLS_LEGACY_MARCH_APPROVED=1`
/// are set). ONE new memory-only test chain (`natural_play::prepare`: a new Season by its own instructions; loopback
/// RPC/WS ports from 41940); ONE in-memory test wallet (`Keypair::new`, never written, dropped with the test) signs
/// the player's Join, PlaceHome, Train 100, Muster 100 and ONE ordinary Depart (sealed to its own home province, one
/// step: the same-home arrival); the keeper's in-memory payers send the rest (Pilot: anchors, the origin driver, the
/// legacy march driver). The test chain's clock is moved by the node's scale control AFTER genesis (`advance`, this
/// chain only, ≤ 2 h per call; the chain's dates stay months behind the real clock, so every drand round it asks
/// for is already published). Public drand: GETs only, each BLS-verified. Asserts the whole legacy pipeline landed,
/// in order, with no unknown outcome and no stop.
#[cfg(test)]
mod real_legacy {
    use super::*;
    use crate::keeper_loop::{public_quicknet, Pilot};
    use permutation_rules::frontier::geometry::{locate, tile_offset, ProvinceCoord};
    use permutation_rules::hex::{Hex, DIRECTIONS};

    fn rx() -> tokio::sync::watch::Receiver<bool> {
        let (tx, rx) = tokio::sync::watch::channel(false);
        std::mem::forget(tx);
        rx
    }
    async fn player_send(state: &Shared, k: &Keypair, ix: Instruction, what: &str) -> String {
        match submit_and_wait(state, k, ix, what, Duration::from_secs(60), &mut rx()).await {
            Sent::Landed(sig) => sig,
            other => panic!("{what}: {other:?}"),
        }
    }
    fn bytes(state: &Shared, k: &Address) -> Vec<u8> {
        lock(state).account(k).unwrap_or_else(|| panic!("account {k} absent")).data
    }
    /// One step from `tile` of `(p, q)` that stays in that province on a passable tile: `(dir, dest_tile)`.
    fn one_step_home(p: i32, q: i32, tile: u8, passable: u64) -> Option<(u8, u8)> {
        let c = ProvinceCoord::new(p, q).centre();
        let off = tile_offset(tile)?;
        let h = Hex::new(c.q + off.q, c.r + off.r);
        (0..6u8).find_map(|d| {
            let (dq, dr) = DIRECTIONS[d as usize];
            let (pc, t) = locate(Hex::new(h.q + dq, h.r + dr));
            ((pc.p, pc.q) == (p, q) && t < 61 && passable & (1u64 << t) != 0 && t != tile).then_some((d, t))
        })
    }

    /// One step from a passable tile of `(p, q)` into ANOTHER province that exists on this chain (`exists`), onto a
    /// tile passable there (`passable_of`): `(from_tile, dir, (p2, q2), dest_tile)`, the first found in tile order.
    fn one_step_out(p: i32, q: i32, passable: u64, exists: impl Fn(i32, i32) -> bool, passable_of: impl Fn(i32, i32) -> u64) -> Option<(u8, u8, (i32, i32), u8)> {
        let c = ProvinceCoord::new(p, q).centre();
        (0..61u8).filter(|t| passable & (1u64 << t) != 0).find_map(|tile| {
            let off = tile_offset(tile)?;
            let h = Hex::new(c.q + off.q, c.r + off.r);
            (0..6u8).find_map(|d| {
                let (dq, dr) = DIRECTIONS[d as usize];
                let (pc, t) = locate(Hex::new(h.q + dq, h.r + dr));
                ((pc.p, pc.q) != (p, q) && t < 61 && exists(pc.p, pc.q) && passable_of(pc.p, pc.q) & (1u64 << t) != 0).then_some((tile, d, (pc.p, pc.q), t))
            })
        })
    }

    /// FoldOccupancy parts 0, 1 and 2 (permissionless; the same turn).
    async fn fold_all(state: &Shared, a: &Addresses, k: &Keypair) {
        for part in 0..3u8 {
            player_send(state, k, ix::fold_occupancy(a, k.pubkey(), part), &format!("FoldOccupancy {part}")).await;
        }
    }

    /// The hex of tile `t` of province `(p, q)`.
    fn hex_of(p: i32, q: i32, t: u8) -> Option<Hex> {
        let c = ProvinceCoord::new(p, q).centre();
        let o = tile_offset(t)?;
        Some(Hex::new(c.q + o.q, c.r + o.r))
    }

    /// The shortest route (BFS over passable tiles of `home` and `target` only) from ANY passable tile of `home` to
    /// tile `goal` of `target`: `(start_tile, dirs)`, at most `MAX_PATH_STEPS`.
    fn route(home: (i32, i32), hp: u64, target: (i32, i32), tp: u64, goal: u8) -> Option<(u8, Vec<u8>)> {
        use std::collections::{HashMap, VecDeque};
        let ok = |pc: (i32, i32), t: u8| t < 61 && ((pc == home && hp & (1u64 << t) != 0) || (pc == target && tp & (1u64 << t) != 0));
        let mut prev: HashMap<(i32, i32), Option<((i32, i32), u8)>> = HashMap::new();
        let mut queue = VecDeque::new();
        for t in (0..61u8).filter(|t| hp & (1u64 << t) != 0) {
            let h = hex_of(home.0, home.1, t)?;
            prev.insert((h.q, h.r), None);
            queue.push_back(h);
        }
        while let Some(h) = queue.pop_front() {
            let (pc, t) = locate(h);
            if (pc.p, pc.q) == target && t == goal {
                let mut dirs = vec![];
                let mut cur = (h.q, h.r);
                while let Some(Some((from, d))) = prev.get(&cur) { dirs.push(*d); cur = *from; }
                dirs.reverse();
                let (spc, st) = locate(Hex::new(cur.0, cur.1));
                assert_eq!((spc.p, spc.q), home);
                return (dirs.len() <= permutation_rules::frontier::travel::MAX_PATH_STEPS).then_some((st, dirs));
            }
            for d in 0..6u8 {
                let (dq, dr) = DIRECTIONS[d as usize];
                let n = Hex::new(h.q + dq, h.r + dr);
                let (npc, nt) = locate(n);
                if ok((npc.p, npc.q), nt) && !prev.contains_key(&(n.q, n.r)) {
                    prev.insert((n.q, n.r), Some(((h.q, h.r), d)));
                    queue.push_back(n);
                }
            }
        }
        None
    }

    /// **REAL artifact — the keep (fort) of a province ONE RING PAST THE HEARTLAND, taken by an ordinary march**
    /// (`#[ignore]`; the same approval variables). The world is `natural_play::prepare`'s, then ONE more ring and the
    /// chosen neighbour province opened by the program's own OpenRing / OpenProvince (a funded test payer from the
    /// test chain's faucet). The player's in-memory key signs Join, PlaceHome, Train 400, Muster 400 and ONE Depart
    /// onto the keep tile; the keeper resolves everything else (the arrival's battle with the keep's garrison, every
    /// held turn, the donor's return settle). No account is written directly; no rule or parameter is changed.
    #[test]
    #[ignore]
    fn a_real_keep_beyond_the_heartland_is_taken_by_an_ordinary_march_and_its_donor_returns() {
        let need = |k: &str| std::env::var(k).unwrap_or_else(|_| panic!("{k} is not set"));
        assert_eq!(need("WYLLS_LEGACY_MARCH_APPROVED"), "1", "approval is required before this test runs");
        assert_eq!(need("WYLLS_PUBLIC_DRAND"), "1");
        let path = std::path::PathBuf::from(need("WYLLS_EXPEDITION_SBF"));
        let art = crate::expedition_play::inspect(path.clone(), std::fs::read(&path).unwrap(), &need("WYLLS_EXPEDITION_SBF_SHA256")).unwrap();
        let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap();
        rt.block_on(async {
            use frontier_abi::v2::presets::ConquestParams;
            let (rpc, ws) = crate::destination_real::ports(41_940);
            let player = Keypair::new();
            let w = player.pubkey();
            let world = crate::natural_play::prepare(&art, w, rpc, ws).await.expect("the natural world");
            let (state, a) = (world.state.clone(), world.a.clone());
            lock(&state).set_paused(false);
            let sd = bytes(&state, &a.season);
            let cq = ConquestParams::of_season(&sd).expect("the Season's conquest params");
            eprintln!("season keep params: bells {}, consolidate {}, home guard {}, garrison bps {}; heartland max ring {}", cq.keep_bells, cq.keep_consolidate_bells, cq.keep_home_guard, cq.keep_garrison_bps, cq.heartland_max_ring);
            // a test payer for the world's own instructions (the test chain's faucet, as `prepare` funds its payer)
            let opener = Keypair::new();
            lock(&state).airdrop(&opener.pubkey(), 500_000_000_000).expect("airdrop");
            for _ in 0..50 { if lock(&state).balance(&opener.pubkey()) > 0 { break; } tokio::time::sleep(Duration::from_millis(200)).await; }
            let frontier_u32x6 = |st: &Shared, off: usize| -> [u32; 6] { let d = bytes(st, &a.frontier()); core::array::from_fn(|i| u32::from_le_bytes(d[off + 4 * i..off + 4 * i + 4].try_into().unwrap())) };
            use frontier_abi::layout::world::frontier as FR;
            let rings = |st: &Shared| u16::from_le_bytes(bytes(st, &a.frontier())[FR::RINGS_OPENED..][..2].try_into().unwrap());
            let d = rings(&state);
            assert_eq!(d as u32, cq.heartland_max_ring as u32 + 1, "prepare opened the rings up to the heartland");
            let ring_next = cq.heartland_max_ring as u32 + 1;
            let wedge_of = |pp: i32, qq: i32| ProvinceCoord::new(pp, qq).wedge();
            // 1. by geometry: a heartland home province H and its next-ring neighbours T (a wedge other than H's nation)
            let mut cands: Vec<((i16, i16, u8), (i32, i32))> = vec![];
            for &(hp_, hq_, nation) in &world.homes {
                let (hp, hq) = (hp_ as i32, hq_ as i32);
                let pass = { let pd = bytes(&state, &a.province(hp, hq)); u64::from_le_bytes(pd[264..272].try_into().unwrap()) };
                for t in (0..61u8).filter(|t| pass & (1u64 << t) != 0) {
                    let Some(h) = hex_of(hp, hq, t) else { continue };
                    for (dq, dr) in DIRECTIONS {
                        let (pc, _) = locate(Hex::new(h.q + dq, h.r + dr));
                        if ProvinceCoord::new(pc.p, pc.q).ring() == ring_next && wedge_of(pc.p, pc.q) != Some(nation)
                            && !cands.iter().any(|c| c.0 .0 == hp_ && c.0 .1 == hq_ && c.1 == (pc.p, pc.q)) {
                            cands.push(((hp_, hq_, nation), (pc.p, pc.q)));
                        }
                    }
                }
            }
            let ((hp_, hq_, nation), _) = *cands.first().expect("a heartland province next to the next ring");
            let cands: Vec<(i32, i32)> = cands.into_iter().filter(|c| c.0 .0 == hp_ && c.0 .1 == hq_).map(|c| c.1).collect();
            // 2. the player: Join that nation and PlaceHome in H
            let me = fclient::ix::Player { actor: w, payer: w, wallet: w };
            let free_site = |st: &Shared, pp: i16, qq: i16| -> Option<u8> {
                use frontier_abi::v2::layout::province::{province as PV, site as SM};
                let pd = bytes(st, &a.province(pp as i32, qq as i32));
                (0..pd[PV::SITE_COUNT] as usize).find(|i| matches!(pd[PV::site(*i) + SM::STATE], SM::STATE_FREE | SM::STATE_RELEASED_FREE)).map(|i| i as u8)
            };
            let now = lock(&state).unix_timestamp();
            player_send(&state, &player, ix::join(&a, w, w, nation, &w, now + 3_600, None), "Join").await;
            let (faction, shard) = crate::natural_play::joined(&bytes(&state, &a.citizen(&w)), &w).expect("joined");
            assert_eq!(faction, nation, "joined the chosen nation");
            let site = (hp_, hq_, free_site(&state, hp_, hq_).expect("a free site in H"));
            player_send(&state, &player, ix::place_home(&a, &me, ix::Site { p: site.0, q: site.1, site: site.2 }, faction, shard), "PlaceHome").await;
            let href = HoldingRef { p: site.0, q: site.1, site: site.2 };
            let holding = href.address(&a);
            let (p, q) = (site.0 as i32, site.1 as i32);
            // 3. AREA EXPANSION by the program's own rule: temporary test players settle H's wedge (each joins the nation
            //    of the province it settles) until its folded occupancy passes θ (6,500 bps: the stricter of the two);
            //    then, at least a turn after the last opening, FoldOccupancy 0/1/2 and OpenRing
            let wh = wedge_of(p, q).expect("H has a wedge") as usize;
            let fill: Vec<(i16, i16, u8)> = world.homes.iter().copied().filter(|h| wedge_of(h.0 as i32, h.1 as i32) == Some(wh as u8)).collect();
            let mut fillers = 0u32;
            for round in 0..8 {
                fold_all(&state, &a, &opener).await;
                let (open, occ) = (frontier_u32x6(&state, FR::WEDGE_OPEN)[wh], frontier_u32x6(&state, FR::WEDGE_OCCUPIED)[wh]);
                eprintln!("wedge {wh}: occupied {occ} of {open} open sites (round {round}, fillers {fillers})");
                if occ as u64 * 10_000 >= 6_500 * open as u64 { break; }
                let need = ((6_500 * open as u64 + 9_999) / 10_000) as u32 - occ;
                for _ in 0..need {
                    let Some(&(fp, fq, fnation)) = fill.iter().find(|h| free_site(&state, h.0, h.1).is_some()) else { panic!("no free site left in wedge {wh}") };
                    let fk = Keypair::new();
                    let fw = fk.pubkey();
                    lock(&state).airdrop(&fw, 5_000_000_000).expect("airdrop");
                    for _ in 0..50 { if lock(&state).balance(&fw) > 0 { break; } tokio::time::sleep(Duration::from_millis(100)).await; }
                    let now = lock(&state).unix_timestamp();
                    player_send(&state, &fk, ix::join(&a, fw, fw, fnation, &fw, now + 3_600, None), "filler Join").await;
                    let (ff, fs) = crate::natural_play::joined(&bytes(&state, &a.citizen(&fw)), &fw).expect("filler joined");
                    let fsite = free_site(&state, fp, fq).unwrap();
                    player_send(&state, &fk, ix::place_home(&a, &fclient::ix::Player { actor: fw, payer: fw, wallet: fw }, ix::Site { p: fp, q: fq, site: fsite }, ff, fs), "filler PlaceHome").await;
                    fillers += 1;
                }
            }
            let last = u32::from_le_bytes(bytes(&state, &a.frontier())[FR::LAST_RING_OPEN_BELL..][..4].try_into().unwrap());
            let clock0 = { let c = lock(&state); lk::season_clock(&c, &a).unwrap() };
            while clock0.bell_at(lock(&state).unix_timestamp()).unwrap() < last + 1 {
                let t = lock(&state).unix_timestamp();
                crate::destination_real::advance(&state, t + 300);
            }
            fold_all(&state, &a, &opener).await;
            player_send(&state, &opener, ix::open_ring(&a, opener.pubkey(), d), "OpenRing (one past the heartland)").await;
            eprintln!("AREA EXPANDED: ring {d} opened after {fillers} test settlers (wedge {wh})");
            // the ring's seed, as the keeper does it (keeper/src/rings.rs): OpenRing leaves it REQUESTED with a recorded
            // round; once that round's time is reached (this test chain's clock only; the round is in the real past, so
            // published) the public Quicknet round, BLS-verified, is consumed ONCE. No BellAnchor is needed.
            {
                use frontier_abi::layout::world::ring_seed as RS;
                let rs = fclient::decode::RingSeed::decode(&bytes(&state, &a.ring_seed(d))).expect("the RingSeed");
                assert_eq!(rs.status, RS::STATUS_REQUESTED, "OpenRing left the ring seed requested");
                while clock0.drand.round_time(rs.round) > lock(&state).unix_timestamp() {
                    let t = lock(&state).unix_timestamp();
                    crate::destination_real::advance(&state, (t + 300).min(clock0.drand.round_time(rs.round) + 1).max(t + 1));
                }
                let sig48 = lk::fetch_round_at(rs.round).await.expect("the ring seed round (public Quicknet, BLS-verified)");
                let arg = BeaconArg { round: rs.round, sig48, hints: fclient::beacon::hints_bytes(rs.round) };
                player_send(&state, &opener, ix::consume_ring_seed(&a, opener.pubkey(), d, &arg), &format!("ConsumeRingSeed(ring {d}, round {})", rs.round)).await;
                let rs2 = fclient::decode::RingSeed::decode(&bytes(&state, &a.ring_seed(d))).expect("the RingSeed");
                assert_eq!(rs2.status, RS::STATUS_SEEDED, "the ring is seeded");
                eprintln!("RING SEEDED: ring {d}, round {}", rs.round);
            }
            // 4. a contestable keep in a neighbour province of the new ring, reachable from H
            let hpass = { let pd = bytes(&state, &a.province(p, q)); u64::from_le_bytes(pd[264..272].try_into().unwrap()) };
            let mut chosen = None;
            for tgt in cands.into_iter().take(12) {
                if lock(&state).account(&a.province(tgt.0, tgt.1)).is_none() {
                    player_send(&state, &opener, ix::open_province(&a, opener.pubkey(), tgt.0 as i16, tgt.1 as i16), &format!("OpenProvince {tgt:?}")).await;
                }
                let pv = fclient::decode::Province::decode(&bytes(&state, &a.province(tgt.0, tgt.1))).unwrap();
                let Some(k) = pv.cq.as_ref().and_then(|c| c.keep) else { continue };
                if k.heartland_safe || k.holder == nation || k.holder >= 6 { continue; }
                if let Some((start, dirs)) = route((p, q), hpass, tgt, pv.passable_mask, k.tile) {
                    chosen = Some((tgt, k, start, dirs));
                    break;
                }
            }
            let (tgt, keep0, start, dirs) = chosen.expect("a reachable, contestable keep one ring past the heartland");
            eprintln!("keep: province {tgt:?} tile {} holder {} troops {} (heartland_safe {}); home ({p},{q}) nation {nation}; route {} steps from tile {start}", keep0.tile, keep0.holder, keep0.troops, keep0.heartland_safe, dirs.len());
            assert_eq!(keep0.troops, cq.keep_home_guard, "the keep opens with the home guard");
            player_send(&state, &player, ix2::train(&a, &me, href, 0, 400), "Train 400").await;
            let h0 = Holding::decode(&bytes(&state, &holding)).unwrap();
            let host = fclient::addr::host_id(p, q, site.2, h0.gen, h0.host_seq).unwrap();
            // the keeper first: the expansion moved this chain's clock on, so the home province must be caught up to the
            // current turn (Muster needs `resident_ok`; on a live world the keeper is always running)
            let mut pilot = Pilot::new_at(&state, public_quicknet(), Some(holding), (site.0, site.1), rx()).await.expect("the pilot");
            for _ in 0..400 {
                let v = lk::view(&lock(&state), &a, site.0, site.1).unwrap();
                if frontier_abi::prologue::resident_ok(v.resolved_next, v.bell_now) { break; }
                assert!(pilot.tick(&state).await, "the keeper stopped: {:?}", pilot.keeper.status);
                let t = lock(&state).unix_timestamp();
                crate::destination_real::advance(&state, t + 60);
            }
            { let v = lk::view(&lock(&state), &a, site.0, site.1).unwrap(); assert!(frontier_abi::prologue::resident_ok(v.resolved_next, v.bell_now), "the home caught up: {v:?}"); }
            player_send(&state, &player, ix::muster(&a, &me, href, 0, 400, start), "Muster 400").await;
            let clock = { let c = lock(&state); lk::season_clock(&c, &a).unwrap() };
            let muster_bell = clock.bell_at(lock(&state).unix_timestamp()).unwrap();
            for _ in 0..80 {
                assert!(pilot.tick(&state).await, "the keeper stopped: {:?}", pilot.keeper.status);
                if lk::view(&lock(&state), &a, site.0, site.1).unwrap().resolved_next > muster_bell + 1 { break; }
                let t = lock(&state).unix_timestamp();
                crate::destination_real::advance(&state, t + 120);
            }
            // ONE ordinary Depart onto the keep tile (arrival: a generous bound over the route's travel time)
            let season = Season::decode(&bytes(&state, &a.season)).unwrap();
            let bell = clock.bell_at(lock(&state).unix_timestamp()).unwrap();
            let arrive = bell + 3 + ((dirs.len() as u32 * 180 + 599) / 600);
            let (path_len, path_bits) = permutation_rules::frontier::seal::encode_path(&dirs).unwrap();
            let plain = permutation_rules::frontier::seal::pack(&permutation_rules::frontier::seal::Plain { version: permutation_rules::frontier::seal::PLAIN_VERSION, host_id: host,
                arrive_bell: arrive, dest_p: tgt.0 as _, dest_q: tgt.1 as _, dest_tile: keep0.tile, stance: 0, retreat_bps: 0, path_len, path: path_bits, reserved: Default::default() });
            let sealed = fclient::seal::seal(&plain, &fclient::beacon::quicknet_info().public_key, clock.tlock_round(arrive)).unwrap();
            let tip = fclient::fees::min_tip_lamports(season.min_reveal_priority_milli, season.reveal_cu_limit, season.reveal_loaded_limit);
            let args = DepartArgs { host_id: host, commit: sealed.commit, seal: sealed.seal, arrive_bell: arrive, tip, transit_slot: 0 };
            player_send(&state, &player, ix2::depart(&a, &me, href, (site.0, site.1), &args), "Depart onto the keep").await;
            // the keeper: the march, the battle, every held turn, the capture, the donor's return
            let keep_of = |st: &Shared| fclient::decode::Province::decode(&bytes(st, &a.province(tgt.0, tgt.1))).unwrap().cq.and_then(|c| c.keep).unwrap();
            let mut seen: Vec<String> = vec![];
            let mut after_arrival: Option<permutation_rules::frontier::keep::Keep> = None;
            let mut taken: Option<(permutation_rules::frontier::keep::Keep, u32)> = None;
            // the donor's own record, read every tick: its troops (milli) in the keep's province before the capture,
            // its entry right after it, and the village's reserve around the tick in which the return settle lands
            let donor_of = |st: &Shared| fclient::decode::Province::decode(&bytes(st, &a.province(tgt.0, tgt.1))).unwrap().entries.into_iter().find(|e| e.id == host);
            let reserve_of = |st: &Shared| Holding::decode(&bytes(st, &holding)).unwrap().reserve[0];
            let mut pre_capture_milli: Option<u32> = None;
            let mut donor_after: Option<Option<fclient::decode::Entry>> = None;
            let mut return_diff: Option<(u32, u32)> = None;
            for i in 0..4000 {
                let reserve_before_tick = reserve_of(&state);
                let had_return = seen.iter().any(|s| s.contains("\"SettleReturn("));
                if taken.is_none() { if let Some(e) = donor_of(&state) { pre_capture_milli = Some(e.troops); } }
                assert!(pilot.tick(&state).await, "the keeper stopped: {:?}; seen {:?}", pilot.keeper.status, seen.len());
                for s in [pilot.keeper.status.destination_step.clone(), pilot.keeper.status.origin_step.clone()].into_iter().flatten() {
                    if s.starts_with("Landed") && !seen.contains(&s) { seen.push(s); }
                }
                assert!(pilot.keeper.status.unknown_signature.is_none(), "an unknown outcome: {:?}", pilot.keeper.status);
                if let Some(t) = pilot.legacy.as_ref().and_then(|d| d.terminal()) { panic!("the legacy driver stopped: {t:?}; last seen {:?}", seen.iter().rev().take(6).collect::<Vec<_>>()); }
                let k = keep_of(&state);
                let rn = lk::view(&lock(&state), &a, tgt.0 as i16, tgt.1 as i16).unwrap().resolved_next;
                if after_arrival.is_none() && rn > arrive { after_arrival = Some(k); eprintln!("after the arrival turn {arrive}: keep {k:?}"); }
                if taken.is_none() && k.holder == faction {
                    taken = Some((k, rn));
                    donor_after = Some(donor_of(&state));
                    eprintln!("TAKEN at resolved_next {rn}: {k:?} (tick {i}); donor before {pre_capture_milli:?} milli, after {:?}", donor_after);
                }
                // (a donor whose rest joined the garrison is removed: there is no return to settle)
                if matches!(donor_after, Some(None)) { eprintln!("the donor was removed at the capture: nothing to return"); break; }
                if !had_return && seen.iter().any(|s| s.contains("\"SettleReturn(")) {
                    return_diff = Some((reserve_before_tick, reserve_of(&state)));
                    eprintln!("RETURN: reserve {reserve_before_tick} → {}", reserve_of(&state));
                    break;
                }
                if i % 50 == 0 { eprintln!("tick {i}: dest resolved_next {rn}, keep holder {} contender {} progress {} troops {}", k.holder, k.contender, k.progress, k.troops); }
                let t = lock(&state).unix_timestamp();
                crate::destination_real::advance(&state, t + if after_arrival.is_some() { 300 } else { 60 });
            }
            let n = seen.len();
            eprintln!("landed {n} keeper steps; first: {:?}", seen.iter().take(14).collect::<Vec<_>>());
            eprintln!("last: {:?}", seen.iter().rev().take(8).collect::<Vec<_>>());
            // the march and the battle
            for k in ["SettleDeparture(slot 0)", &format!("Reveal(slot 0, bell {arrive})"), &format!("ResolveFromInputs(destination bell {arrive})"), &format!("SettleTransit(slot 0, bell {arrive})")] {
                assert!(seen.iter().any(|s| s.contains(k)), "{k} landed");
            }
            let k1 = after_arrival.expect("the arrival turn resolved");
            assert!(k1.troops < keep0.troops || k1.holder == faction || k1.contender == faction, "the battle: the garrison was beaten ({k1:?})");
            // the capture: owner change, garrison split, consolidation — by the Season's own parameters
            let (kt, rn_t) = taken.expect("the keep was taken");
            assert_eq!(kt.holder, faction, "the keep's holder is the player's nation");
            assert_eq!(kt.last_taken_from, keep0.holder, "taken from its wedge holder");
            assert_eq!(kt.gen, keep0.gen + 1, "the garrison generation +1");
            // the split, EXACTLY as the kernel computes it (keep.rs advance_with): from the donor's troops t (milli) at
            // the capture, garrison = ⌊t × bps / 10,000 / 1,000⌋ whole troops, rest = t − garrison × 1,000 (milli); a
            // rest under MIN_HOST_TROOPS (100 troops) joins the garrison and the donor's entry is removed
            let t = pre_capture_milli.expect("the donor's troops before the capture") as u64;
            let mut g = t * cq.keep_garrison_bps as u64 / 10_000 / 1_000;
            let mut rest = t - g * 1_000;
            let removed = rest < 100 * 1_000;
            if removed { g += rest / 1_000; rest = 0; }
            assert_eq!(kt.troops as u64, g, "the garrison is exactly the donor's share (t {t} milli)");
            match donor_after.clone().expect("read right after the capture") {
                Some(e) if !removed => {
                    use frontier_abi::layout::province::entry as E;
                    assert_eq!(e.troops as u64, rest, "the donor keeps exactly the rest (milli)");
                    assert_eq!((e.state, e.pend_op), (E::STATE_DEPARTED, E::OP_LEAVE), "the donor is going home");
                }
                None if removed => {}
                other => panic!("the donor after the capture: {other:?} (removed {removed}, rest {rest})"),
            }
            assert!(rn_t >= arrive + cq.keep_bells as u32, "not before {} counted turns: taken by {rn_t}", cq.keep_bells);
            assert_eq!(kt.consolidated_until_bell, kt.since_bell + cq.keep_consolidate_bells as u32, "consolidation (since {} + {})", kt.since_bell, cq.keep_consolidate_bells);
            let pv = fclient::decode::Province::decode(&bytes(&state, &a.province(tgt.0, tgt.1))).unwrap();
            assert_eq!(pv.cq.as_ref().unwrap().keeps_taken_by[faction as usize], 1, "the province records the capture");
            // the donor went home with the rest: the return settle credited it to the village's reserve
            let after = Holding::decode(&bytes(&state, &holding)).unwrap();
            // the WHOLE rest is home: the return settle credited exactly ⌊rest / 1,000⌋ troops, in the tick it landed
            if removed {
                // (keep.rs: a rest under 100 troops joins the garrison as ⌊rest / 1,000⌋ whole troops and the donor's
                //  entry is removed; the milli remainder below one troop is dropped by that floor, so the garrison is
                //  ⌊t / 1,000⌋ and there is NO return to settle — this branch is not a return)
                assert_eq!(g, t / 1_000, "removed: the whole host (in whole troops) is the garrison");
                assert!(return_diff.is_none(), "a removed donor has nothing to return");
            } else {
                let (r0, r1) = return_diff.expect("the return settle landed");
                assert_eq!(r1 as u64 - r0 as u64, rest / 1_000, "the reserve rose by exactly the donor's rest");
                assert_eq!(g * 1_000 + rest, t, "garrison + rest = the donor's troops: nothing lost or made");
            }
            assert!(!pv.entries.iter().any(|e| e.id == host), "the donor's entry is freed in the keep's province");
            assert!(removed || seen.iter().any(|s| s.contains("\"SettleReturn(")), "SettleReturn landed");
            if removed {
                eprintln!("RESULT (NO RETURN: the whole host joined the garrison): keep {tgt:?} taken by nation {faction} from {}; garrison {} = ⌊{t} / 1,000⌋; consolidated until {}", keep0.holder, kt.troops, kt.consolidated_until_bell);
            } else {
                eprintln!("RESULT (WITH RETURN): keep {tgt:?} taken by nation {faction} from {}; garrison {}; donor's rest {} milli → +{} troops home by SettleReturn; consolidated until {}", keep0.holder, kt.troops, rest, rest / 1_000, kt.consolidated_until_bell);
            }
            world.running.stop();
        });
    }

    #[test]
    #[ignore]
    fn a_real_ordinary_march_departs_arrives_at_home_and_settles() {
        run(false);
    }

    /// The same, with the ONE Depart going one step into a neighbouring province that exists on this chain (the
    /// arrival in another province: the legacy driver alone gathers, seeds and resolves it — never the origin driver).
    #[test]
    #[ignore]
    fn a_real_ordinary_march_departs_arrives_in_another_province_and_settles() {
        run(true);
    }

    fn run(other: bool) {
        let need = |k: &str| std::env::var(k).unwrap_or_else(|_| panic!("{k} is not set"));
        assert_eq!(need("WYLLS_LEGACY_MARCH_APPROVED"), "1", "approval is required before this test runs");
        assert_eq!(need("WYLLS_PUBLIC_DRAND"), "1");
        let path = std::path::PathBuf::from(need("WYLLS_EXPEDITION_SBF"));
        let art = crate::expedition_play::inspect(path.clone(), std::fs::read(&path).unwrap(), &need("WYLLS_EXPEDITION_SBF_SHA256")).unwrap();
        let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap();
        rt.block_on(async {
            let (rpc, ws) = crate::destination_real::ports(41_940);
            let player = Keypair::new();
            let w = player.pubkey();
            let world = crate::natural_play::prepare(&art, w, rpc, ws).await.expect("the natural world");
            let (state, a) = (world.state.clone(), world.a.clone());
            // `prepare` returns the chain PAUSED (its synthetic pre-genesis clock); the natural run unpauses it at
            // ready-for-join (`await_home`), and so does this test — nothing lands on a paused chain (first run: the
            // player's Join was unknown after 60 s, not resent)
            lock(&state).set_paused(false);
            let me = fclient::ix::Player { actor: w, payer: w, wallet: w };
            // the player's Join and PlaceHome (as the page signs them), then Train 100 and Muster 100
            let now = lock(&state).unix_timestamp();
            player_send(&state, &player, ix::join(&a, w, w, world.homes[0].2, &w, now + 3_600, None), "Join").await;
            let (faction, shard) = crate::natural_play::joined(&bytes(&state, &a.citizen(&w)), &w).expect("joined");
            let site = {
                use frontier_abi::v2::layout::province::{province as PV, site as SM};
                world.homes.iter().filter(|h| h.2 == faction).find_map(|(pp, qq, _)| {
                    let pd = bytes(&state, &a.province(*pp as i32, *qq as i32));
                    (0..pd[PV::SITE_COUNT] as usize).find(|i| matches!(pd[PV::site(*i) + SM::STATE], SM::STATE_FREE | SM::STATE_RELEASED_FREE)).map(|i| (*pp, *qq, i as u8))
                }).expect("a free heartland site")
            };
            player_send(&state, &player, ix::place_home(&a, &me, ix::Site { p: site.0, q: site.1, site: site.2 }, faction, shard), "PlaceHome").await;
            let href = HoldingRef { p: site.0, q: site.1, site: site.2 };
            let holding = href.address(&a);
            let (p, q) = (site.0 as i32, site.1 as i32);
            player_send(&state, &player, ix2::train(&a, &me, href, 0, 100), "Train").await;
            let passable_of = |pp: i32, qq: i32| lock(&state).account(&a.province(pp, qq)).map(|acc| u64::from_le_bytes(acc.data[264..272].try_into().unwrap())).unwrap_or(0);
            let exists = |pp: i32, qq: i32| lock(&state).account(&a.province(pp, qq)).is_some_and(|acc| acc.owner == a.program);
            let passable = passable_of(p, q);
            // the march: one step inside the home province (the same-home arrival), or one step out into a neighbour
            let (muster_tile, dir, dest, dest_tile) = if other {
                one_step_out(p, q, passable, exists, passable_of).expect("a passable tile with a neighbouring province on this chain")
            } else {
                let t = (0..61u8).find(|t| passable & (1u64 << t) != 0).expect("a passable tile");
                let (d, dt) = one_step_home(p, q, t, passable).expect("a one-step tile in the home province");
                (t, d, (p, q), dt)
            };
            eprintln!("march: from ({p},{q}) tile {muster_tile}, dir {dir}, to {dest:?} tile {dest_tile}");
            let h0 = Holding::decode(&bytes(&state, &holding)).unwrap();
            let host = fclient::addr::host_id(p, q, site.2, h0.gen, h0.host_seq).unwrap();
            player_send(&state, &player, ix::muster(&a, &me, href, 0, 100, muster_tile), "Muster").await;
            // the keeper forms the host (anchors, the origin driver's gather, seed and resolve)
            let mut pilot = Pilot::new_at(&state, public_quicknet(), Some(holding), (site.0, site.1), rx()).await.expect("the pilot");
            assert!(pilot.legacy.is_some() && pilot.destination.is_none(), "a legacy village gets the legacy march driver");
            let clock = { let c = lock(&state); lk::season_clock(&c, &a).unwrap() };
            let muster_bell = clock.bell_at(lock(&state).unix_timestamp()).unwrap();
            for _ in 0..60 {
                assert!(pilot.tick(&state).await, "the keeper stopped: {:?}", pilot.keeper.status);
                if lk::view(&lock(&state), &a, site.0, site.1).unwrap().resolved_next > muster_bell + 1 { break; }
                let t = lock(&state).unix_timestamp();
                crate::destination_real::advance(&state, t + 120);
            }
            // ONE ordinary Depart, one step (the destination chosen above)
            let season = Season::decode(&bytes(&state, &a.season)).unwrap();
            let bell = clock.bell_at(lock(&state).unix_timestamp()).unwrap();
            let arrive = bell + 3;
            let (path_len, path_bits) = permutation_rules::frontier::seal::encode_path(&[dir]).unwrap();
            let plain = permutation_rules::frontier::seal::pack(&permutation_rules::frontier::seal::Plain { version: permutation_rules::frontier::seal::PLAIN_VERSION, host_id: host,
                arrive_bell: arrive, dest_p: dest.0 as _, dest_q: dest.1 as _, dest_tile, stance: 0, retreat_bps: 0, path_len, path: path_bits, reserved: Default::default() });
            let sealed = fclient::seal::seal(&plain, &fclient::beacon::quicknet_info().public_key, clock.tlock_round(arrive)).unwrap();
            let tip = fclient::fees::min_tip_lamports(season.min_reveal_priority_milli, season.reveal_cu_limit, season.reveal_loaded_limit);
            let args = DepartArgs { host_id: host, commit: sealed.commit, seal: sealed.seal, arrive_bell: arrive, tip, transit_slot: 0 };
            player_send(&state, &player, ix2::depart(&a, &me, href, (site.0, site.1), &args), "Depart").await;
            // the departure bell as the chain recorded it (the order check tells its resolve from the arrival's)
            let depart_bell = Holding::decode(&bytes(&state, &holding)).unwrap().transit[0].depart_bell;
            // the keeper: origin resolve, SettleDeparture, Decrypt, Reveal, gather/seed/resolve at home, SettleTransit
            let mut seen: Vec<String> = vec![];
            let mut reveal_ts: Option<i64> = None;
            for _ in 0..240 {
                assert!(pilot.tick(&state).await, "the keeper stopped: {:?}; seen {seen:?}", pilot.keeper.status);
                // (in the order the Pilot ran them this tick: the legacy driver before the origin driver)
                for s in [pilot.keeper.status.destination_step.clone(), pilot.keeper.status.origin_step.clone()].into_iter().flatten() {
                    if s.starts_with("Landed") && !seen.contains(&s) { seen.push(s); }
                }
                assert!(pilot.keeper.status.unknown_signature.is_none(), "an unknown outcome: {:?}", pilot.keeper.status);
                if let Some(t) = pilot.legacy.as_ref().and_then(|d| d.terminal()) { panic!("the legacy driver stopped: {t:?}; seen {seen:?}"); }
                if reveal_ts.is_none() && seen.iter().any(|s| s.contains("\"Reveal(")) { reveal_ts = Some(lock(&state).unix_timestamp()); }
                if seen.iter().any(|s| s.contains("SettleTransit")) { break; }
                let t = lock(&state).unix_timestamp();
                crate::destination_real::advance(&state, t + 60);
            }
            eprintln!("landed: {seen:?}");
            // (chain seconds from the Reveal to the SettleTransit: the destination's catch-up and arrival turn)
            eprintln!("reveal→settle: {} chain-seconds", lock(&state).unix_timestamp() - reveal_ts.unwrap_or(0));
            // the plan's order: departure resolve → SettleDeparture → Reveal → arrival gather → ARRIVAL resolve → SettleTransit
            if let Err(e) = landed_order::check(&seen, 0, depart_bell, arrive) { panic!("{e}"); }
            if other {
                // another province's arrival bell is the legacy driver's alone: the origin driver never resolves it
                assert!(seen.iter().any(|s| s.contains(&format!("\"ResolveFromInputs(destination bell {arrive})\""))), "resolved by the legacy driver: {seen:?}");
                assert!(!seen.iter().any(|s| s.contains(&format!("\"ResolveFromInputs(bell {arrive})\"")) || s.contains(&format!("\"GatherClash(bell {arrive}"))), "the origin driver touched another province's bell: {seen:?}");
            }
            let after = Holding::decode(&bytes(&state, &holding)).unwrap();
            assert_eq!(after.transit[0].state, T_FREE, "the transit slot is free after SettleTransit");
            world.running.stop();
        });
    }
}
