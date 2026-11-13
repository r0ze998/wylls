//! **Local-play resident bells**: once the watched Holding's host STANDS in
//! the wide destination (129, 0) (its arrival settled, its transit record
//! closed), keeps that province's QUIET bells resolved on the natural clock
//! with the program's REAL instructions, at most one transaction per step:
//! `PostAnchor` of the ended bell in the destination region (a public
//! Quicknet round verified against the pinned key), once its reveal window
//! closed `PostSeed`, then the wide `Resolve` of `resolved_next`.
//!
//! Why: the already-existing return path is OwnerDissolve (the player's own
//! signed resident Dissolve, NOT sent here) → the wide Resolve of the bell
//! that departs the row (ResolveVoluntaryLeave) → ReturnOriginalReserve,
//! which needs `resolved_next > pend_bell` (`wide_expedition_resident.rs`
//! `execute_return`). The keeper's FastForward serves only the home and the
//! destination driver ends at its member settlement, so without this nothing
//! resolves the destination after the arrival.
//!
//! Scope, stated: no new rule, no Gather, no march, no wallet signing, no
//! direct state write. It acts only when (a) a resident of the watched
//! Holding stands in (129, 0) — read from the program-owned WideRoster,
//! paired with the Province's entry table (`validate_paired`), its host's
//! canonical Holding being the watched one — and (b) NO transit record of the
//! watched Holding exists (a live march or arrival is the origin/destination
//! drivers'; this never races them). A bell with arrivals (a ClashInputs or
//! its ArrivalDay bit) is reported as blocked and NOT driven. A refusal of the
//! program (simulated first, or landed) or an unknown outcome stops it for
//! good (never resent).
use fclient::addr::Addresses;
use fclient::ix::{post_seed, BeaconArg};
use fclient::{AccountMeta, Address, Instruction, Keypair, Signer};
use frontier_abi::addr::{day_of, AddrCtx};
use frontier_abi::world_index::{
    arrival::{self as wa, arrival_day_address, clash_inputs_address},
    expedition::AccountResolver,
    land::{province_address, WideProvince},
    march::transit_address,
    roster::{roster_address, WideRoster},
    wide_ix as wix, ProvinceKey, WideCoord, WideHostRef, WorldId,
};
use localnet::server::{lock, Shared};
use localnet::Chain;

use crate::keeper_loop::{submit_and_wait, Sent};
use crate::local_keeper as lk;

/// The transit slots of a Holding (`holding::TRANSIT_N`).
const TRANSIT_SLOTS: u8 = 4;
/// The most ended bells ahead of `resolved_next` whose anchors are posted
/// early (one transaction per step): bounds the work and the scan.
pub const MAX_LEAD_ANCHORS: u32 = 144;

fn ctx_of(a: &Addresses) -> AddrCtx {
    AddrCtx { program: a.program.to_bytes(), season: a.season.to_bytes() }
}

/// The wide destination this local play generates (`wide_destination::DEST`).
pub fn dest_key(a: &Addresses) -> Result<ProvinceKey, String> {
    let ctx = ctx_of(a);
    let world = WorldId::derive_legacy_season(&ctx.season, &ctx.program).map_err(|e| format!("world: {e:?}"))?;
    let (p, q) = crate::wide_destination::DEST;
    Ok(ProvinceKey::new(world, WideCoord::checked(p, q).map_err(|e| format!("{e:?}"))?))
}

/// The residents of `holding` standing in `dest`: `(entry index, host,
/// entry state)` from the program-owned WideRoster, checked against the
/// Province's entry table (`WideRoster::validate_paired`). No roster: none.
pub fn residents_of(c: &Chain, a: &Addresses, dest: ProvinceKey, province: &[u8], holding: &Address) -> Result<Vec<(usize, WideHostRef, u8)>, String> {
    let ctx = ctx_of(a);
    let key = Address::new_from_array(roster_address(&ctx, dest));
    let Some(acc) = c.account(&key) else { return Ok(vec![]) };
    if acc.owner != a.program {
        return Err("the destination's WideRoster is not the program's".into());
    }
    let r = WideRoster::read(&acc.data).map_err(|e| format!("WideRoster: {e:?}"))?;
    if r.season_id != a.season_id || r.province != dest {
        return Err("the WideRoster is not this destination's".into());
    }
    let live = frontier_abi::world_index::resolve::live_ids(province).map_err(|e| format!("entry table: {e:?}"))?;
    r.validate_paired(&acc.data, &live).map_err(|e| format!("WideRoster pairing: {e:?}"))?;
    let resolver = AccountResolver::for_season(&ctx).map_err(|e| format!("{e:?}"))?;
    let mut out = vec![];
    for (i, _alias, host) in r.table(&acc.data).map_err(|e| format!("WideRoster: {e:?}"))? {
        let Ok(h) = resolver.holding_address(&host) else { continue };
        if h == holding.to_bytes() {
            let e = frontier_abi::entry::read_entry(province, i).map_err(|e| format!("entry {i}: {e:?}"))?;
            out.push((i, host, e.state));
        }
    }
    Ok(out)
}

/// Whether any transit record of `holding` exists (any state): a live march
/// or an unsettled arrival, the origin/destination drivers' business.
pub fn transit_live(c: &Chain, a: &Addresses, holding: &Address) -> bool {
    let ctx = ctx_of(a);
    (0..TRANSIT_SLOTS).any(|s| c.account(&Address::new_from_array(transit_address(&ctx, &holding.to_bytes(), s))).is_some())
}

/// What the destination's resolve cursor needs (read with identity checks).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct View {
    pub resolved_next: u32,
    pub region: u8,
    pub end_bell: u32,
    /// Residents of the watched Holding standing there.
    pub residents: usize,
    pub transit_live: bool,
    /// THE anchor's landing time of (resolved_next, region), if present.
    pub anchor: Option<i64>,
    /// The lowest ENDED bell in `resolved_next ..` (at most
    /// [`MAX_LEAD_ANCHORS`] ahead, below the Season's end) whose anchor is
    /// absent. A reveal window closes `reveal_window` after ITS anchor lands,
    /// so anchoring every ended bell as soon as it ends lets their windows run
    /// in parallel; anchoring only the cursor (one bell per window + seed
    /// margin, longer than a bell) never catches up.
    pub missing_anchor: Option<u32>,
    pub inputs: bool,
    pub arrival_bit: bool,
    pub seed: bool,
    /// The destination's conquest state (a plain Resolve cannot pass a live
    /// conquest table; site records without a table are not provable).
    pub conquest: Conquest,
    /// The program-owned conquest table still holds a live entry or a
    /// reservation record ([`conquest_open_of`]). While it does, the
    /// destination's bells keep being resolved even with NO resident standing
    /// (the host died, or left): a lost entry becomes settleable and a PENDING
    /// reservation is applied (or becomes NOT_APPLIED and owed) only through
    /// the bell's ResolveWithConquest. Without this the crank's debts could
    /// never fall due once the transit and the resident are gone.
    pub conquest_open: bool,
}

/// Whether a conquest table still has anything the destination's bells must
/// carry: a live entry at any site, or any reservation record (pure; the
/// table's own accessors, no copy of its rules).
pub fn conquest_open_of(t: &frontier_abi::world_index::conquest::WideConquest) -> Result<bool, String> {
    for s in 0..12u8 {
        if t.entry(s).map_err(|e| format!("conquest entry {s}: {e:?}"))?.is_some() {
            return Ok(true);
        }
    }
    Ok(t.reservations().iter().any(|r| r.is_some()))
}

/// What the destination's conquest state allows the bell's Resolve to be.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Conquest {
    /// No conquest table and every site record zero: plain Resolve.
    #[default]
    None,
    /// The program-owned conquest table exists: only ResolveWithConquest.
    Table,
    /// Site records are set but no table exists: not provable, nothing sent.
    Unprovable,
}

/// The account at the destination's conquest-table address, accepted ONLY as
/// a valid table of this Season and this destination (pure, fail-closed,
/// before any plan): owned by the program, not executable, and read by the
/// program's own `WideConquest::read` (its size, magic, table version, zero
/// ranges, Season id, destination key and every entry/reservation). Anything
/// else is an error, never treated as a table.
pub fn checked_table(owner: &Address, executable: bool, data: &[u8], program: &Address, season_id: u64, dest: ProvinceKey)
    -> Result<frontier_abi::world_index::conquest::WideConquest, String> {
    if owner != program {
        return Err("the account at the conquest table address is not the program's".into());
    }
    if executable {
        return Err("the account at the conquest table address is executable".into());
    }
    frontier_abi::world_index::conquest::WideConquest::read(data, season_id, dest).map_err(|e| format!("conquest table: {e:?}"))
}

/// The destination's validated conquest table, if one exists ([`checked_table`]).
pub fn conquest_table(c: &Chain, a: &Addresses, dest: ProvinceKey) -> Result<Option<frontier_abi::world_index::conquest::WideConquest>, String> {
    let ctx = ctx_of(a);
    match c.account(&Address::new_from_array(frontier_abi::world_index::conquest::conquest_address(&ctx, dest))) {
        None => Ok(None),
        Some(x) => checked_table(&x.owner, x.executable, &x.data, &a.program, a.season_id, dest).map(Some),
    }
}

/// The destination's conquest state from its Province bytes and the table
/// account: `Table` only for a table that passes [`checked_table`] (an
/// invalid account is an error, so the caller stops and sends nothing).
pub fn conquest_of(c: &Chain, a: &Addresses, dest: ProvinceKey, pd: &[u8]) -> Result<Conquest, String> {
    use frontier_abi::conquest_model::Record;
    if conquest_table(c, a, dest)?.is_some() {
        return Ok(Conquest::Table);
    }
    let n = pd.get(frontier_abi::v2::layout::province::province::SITE_COUNT).copied().ok_or("province bytes")?.min(12);
    for s in 0..n {
        if Record::read(pd, s as usize).map_err(|e| format!("site record {s}: {e:?}"))? != Record::ZERO {
            return Ok(Conquest::Unprovable);
        }
    }
    Ok(Conquest::None)
}

/// The destination's view; `None` when the destination does not exist yet.
pub fn view(c: &Chain, a: &Addresses, holding: &Address, now_bell: u32) -> Result<Option<(ProvinceKey, Address, View)>, String> {
    use frontier_abi::v2::layout::{province::province as PV, world::season as S};
    let ctx = ctx_of(a);
    let dest = dest_key(a)?;
    let key = Address::new_from_array(province_address(&ctx, dest.coord()));
    let Some(pacc) = c.account(&key) else { return Ok(None) };
    if pacc.owner != a.program {
        return Err("the destination Province is not the program's".into());
    }
    let prov = WideProvince::read(&pacc.data).map_err(|e| format!("destination Province: {e:?}"))?;
    if prov.world != dest.world() || prov.coord != dest.coord() || prov.season_id != a.season_id {
        return Err("the destination Province is not this one".into());
    }
    let u32_at = |d: &[u8], o: usize| -> Result<u32, String> { Ok(u32::from_le_bytes(d.get(o..o + 4).ok_or("bytes")?.try_into().unwrap())) };
    let rn = u32_at(&pacc.data, PV::RESOLVED_NEXT)?;
    let sacc = c.account(&a.season).ok_or("no Season")?;
    if sacc.owner != a.program {
        return Err("the Season is not the program's".into());
    }
    let end_bell = u32_at(&sacc.data, S::END_BELL)?;
    let residents = residents_of(c, a, dest, &pacc.data, holding)?.len();
    let inputs = match c.account(&Address::new_from_array(clash_inputs_address(&ctx, dest, rn))) {
        None => false,
        Some(x) if x.owner == a.program => true,
        Some(_) => return Err("the ClashInputs is not the program's".into()),
    };
    let arrival_bit = match c.account(&Address::new_from_array(arrival_day_address(&ctx, dest, day_of(rn)))) {
        None => false,
        Some(d) if d.owner == a.program => {
            let rec = wa::WideArrivalDay::read(&d.data).map_err(|e| format!("ArrivalDay: {e:?}"))?;
            if rec.season_id != a.season_id || rec.dest != dest || rec.day != day_of(rn) {
                return Err("the ArrivalDay is not this destination's day".into());
            }
            rec.has(rn)
        }
        Some(_) => return Err("the ArrivalDay is not the program's".into()),
    };
    let conquest = conquest_of(c, a, dest, &pacc.data)?;
    let conquest_open = match conquest {
        Conquest::Table => conquest_open_of(&conquest_table(c, a, dest)?.ok_or("the conquest table vanished")?)?,
        Conquest::None | Conquest::Unprovable => false,
    };
    let mut missing_anchor = None;
    if let (Some(range), true) = (lead_range(rn, now_bell, end_bell), residents > 0 || conquest_open) {
        for b in range {
            if lk::anchor_landed(c, a, b, prov.region)?.is_none() {
                missing_anchor = Some(b);
                break;
            }
        }
    }
    Ok(Some((dest, key, View {
        resolved_next: rn,
        region: prov.region,
        end_bell,
        residents,
        transit_live: transit_live(c, a, holding),
        anchor: lk::anchor_landed(c, a, rn, prov.region)?,
        missing_anchor,
        conquest,
        conquest_open,
        inputs,
        arrival_bit,
        seed: c.account(&a.seed_cache(rn, prov.region, 0)).is_some(),
    })))
}

/// The ended bells whose anchors may be posted early: `rn ..= last` with
/// `last` the newest ENDED bell (`now_bell - 1`), below the Season's end and
/// at most [`MAX_LEAD_ANCHORS`] ahead; `None` when no bell has ended yet
/// (`now_bell == 0`) or the cursor is past all of them (pure).
pub fn lead_range(rn: u32, now_bell: u32, end_bell: u32) -> Option<core::ops::RangeInclusive<u32>> {
    if now_bell == 0 || end_bell == 0 {
        return None;
    }
    let last = (now_bell - 1).min(end_bell - 1).min(rn.saturating_add(MAX_LEAD_ANCHORS));
    (rn <= last).then_some(rn..=last)
}

/// The next action (pure).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Plan {
    /// Nothing of ours to do (no resident, a live transit, the season's end).
    Idle(String),
    /// The bell has not ended / its reveal window is open.
    Wait(String),
    /// A bell with arrivals: not a quiet bell, not driven here.
    Blocked(String),
    Anchor(u32),
    Seed(u32),
    Resolve(u32),
    /// The bell's ResolveWithConquest (kind 13; conquest runner only).
    ResolveWithConquest(u32),
}

pub fn plan(v: &View, now_bell: u32, window_closed: bool) -> Plan {
    let b = v.resolved_next;
    if v.residents == 0 && !v.conquest_open {
        return Plan::Idle("no resident of the watched Holding stands in the destination, and no conquest entry or reservation is open".into());
    }
    if v.transit_live {
        return Plan::Idle("a transit record of the watched Holding is live (the origin/destination drivers')".into());
    }
    if b >= v.end_bell {
        return Plan::Idle(format!("bell {b} is at or past the Season's end bell {}", v.end_bell));
    }
    // every ended bell's anchor first (lowest missing, bounded), the cursor's
    // included: their reveal windows then close in parallel
    // (an anchor only ever for an ENDED bell: a stale or wrong view is ignored)
    if let Some(m) = v.missing_anchor.filter(|m| *m < now_bell && *m >= b) {
        return Plan::Anchor(m);
    }
    if b >= now_bell {
        return Plan::Wait(format!("bell {b} has not ended"));
    }
    if v.anchor.is_none() {
        return Plan::Anchor(b);
    }
    if !window_closed {
        return Plan::Wait(format!("the reveal window of bell {b} is open"));
    }
    if v.inputs || v.arrival_bit {
        return Plan::Blocked(format!("bell {b} has arrivals (ClashInputs or ArrivalDay bit): not a quiet bell, not driven here"));
    }
    if !v.seed {
        return Plan::Seed(b);
    }
    match v.conquest {
        Conquest::None => Plan::Resolve(b),
        Conquest::Table if cfg!(feature = "localnet-conquest-play") => Plan::ResolveWithConquest(b),
        Conquest::Table => Plan::Blocked(format!("bell {b}: a conquest table is live; this runner has no ResolveWithConquest (plain Resolve not sent)")),
        Conquest::Unprovable => Plan::Blocked(format!("bell {b}: site records are set without a conquest table: not provable, nothing sent")),
    }
}

/// The quiet wide Resolve of `dest` at `bell` (`wide_ix::RESOLVE` order).
pub fn resolve_ix(a: &Addresses, payer: &Address, dest: ProvinceKey, dest_key: &Address, region: u8, bell: u32) -> Instruction {
    let ctx = ctx_of(a);
    let data = wix::Resolve { bell, beneficiary: payer.to_bytes() }.to_bytes().to_vec();
    Instruction { program_id: a.program, data, accounts: vec![
        AccountMeta::new(*payer, true),
        AccountMeta::new_readonly(a.season, false),
        AccountMeta::new(*dest_key, false),
        AccountMeta::new(Address::new_from_array(roster_address(&ctx, dest)), false),
        AccountMeta::new_readonly(a.seed_cache(bell, region, 0), false),
        AccountMeta::new_readonly(a.anchor(bell, region), false),
        AccountMeta::new(Address::new_from_array(clash_inputs_address(&ctx, dest, bell)), false),
        AccountMeta::new_readonly(Address::new_from_array(arrival_day_address(&ctx, dest, day_of(bell))), false),
        AccountMeta::new_readonly(fclient::addr::system_program(), false),
    ] }
}

/// One step's outcome.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Step {
    Landed(String, String),
    Idle(String),
    Wait(String),
    Blocked(String),
    Unknown { signature: String, why: String },
    Stopped(String),
}

pub struct ResidentBells {
    pub a: Addresses,
    holding: Address,
    payer: Keypair,
    stop: tokio::sync::watch::Receiver<bool>,
    pub land_timeout: std::time::Duration,
    terminal: Option<Step>,
    pub log: Vec<String>,
}

impl ResidentBells {
    pub fn new(holding: Address, payer: Keypair, stop: tokio::sync::watch::Receiver<bool>) -> ResidentBells {
        ResidentBells { a: Addresses::new(Address::new_from_array(crate::expedition_play::PROGRAM), crate::expedition_play::SEASON_ID),
            holding, payer, stop, land_timeout: crate::keeper_loop::LAND_TIMEOUT, terminal: None, log: vec![] }
    }

    pub fn terminal(&self) -> Option<&Step> {
        self.terminal.as_ref()
    }

    /// At most one transaction. After `Unknown` / `Stopped` every later call
    /// returns it (nothing is resent).
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

    /// The conquest crank's one step, `None` when nothing is due (module
    /// `conquest_crank`). Every input is program-owned state read with
    /// identity checks under one lock; anything unprovable is `Blocked`.
    #[cfg(feature = "localnet-conquest-play")]
    #[allow(clippy::too_many_arguments)]
    async fn crank_step(&mut self, state: &Shared, dest: ProvinceKey, key: &Address, v: &View, clock: &fclient::clock::SeasonClock, now: i64, now_bell: u32)
        -> Option<Step> {
        use crate::conquest_crank as cc;
        use frontier_abi::v2::layout::world::season as S;
        let me = self.payer.pubkey();
        let built = {
            let c = lock(state);
            (|| -> Result<Option<(Instruction, String)>, String> {
                let pd = c.account(key).ok_or("the destination Province is absent")?.data;
                let player = cc::player(&c, &self.a, &self.holding)?;
                let sd = c.account(&self.a.season).ok_or("no Season")?.data;
                let status = *sd.get(S::STATUS).ok_or("season bytes")?;
                let ended = status == S::STATUS_ENDED || now_bell >= v.end_bell;
                let end_ts = permutation_rules::frontier::beacon::bell_start(clock.genesis_ts, v.end_bell);
                let closes_open = status == S::STATUS_ENDED && now >= end_ts.saturating_add(frontier_abi::presets::END_GRACE_SECS);
                let (f, table, escrow) = cc::facts(&c, &self.a, dest, &pd, &player, v.resolved_next, ended, v.end_bell, closes_open)?;
                let entry = |site: u8| -> Result<frontier_abi::world_index::conquest::WideConquestEntry, String> {
                    table.as_ref().and_then(|t| t.entry(site).ok().flatten()).ok_or_else(|| format!("site {site}: the entry vanished"))
                };
                Ok(match cc::crank(&f) {
                    cc::Crank::Nothing => None,
                    cc::Crank::Blocked(w) => return Err(format!("BLOCKED:{w}")),
                    cc::Crank::SettleCapture { site } => Some((cc::settle_capture_ix(&self.a, &me, dest, key, &player, site, &entry(site)?)?, format!("SettleCapture(site {site})"))),
                    cc::Crank::SettleSiege { site, .. } => {
                        let esc = escrow.as_ref().ok_or("SettleSiege without the capture escrow")?;
                        Some((cc::settle_siege_ix(&self.a, &me, dest, key, &player, site, &entry(site)?, esc)?, format!("SettleSiege(site {site})")))
                    }
                    cc::Crank::CloseConquest => Some((cc::close_conquest_ix(&self.a, &me, dest, table.as_ref().ok_or("no table")?)?, "CloseConquest".into())),
                    cc::Crank::CloseCaptureEscrow { .. } => {
                        Some((cc::close_capture_escrow_ix(&self.a, &me, &player, escrow.as_ref().ok_or("no escrow")?)?, "CloseCaptureEscrow".into()))
                    }
                    cc::Crank::SettleReservation { seq } => {
                        let t = table.as_ref().ok_or("SettleReservation without the table")?;
                        let (_, r) = t.reservation(seq).ok_or_else(|| format!("reservation {seq} vanished"))?;
                        Some((cc::settle_reservation_ix(&self.a, &me, dest, key, &r, escrow.as_ref())?, format!("SettleReservation(seq {seq})")))
                    }
                })
            })()
        };
        match built {
            Ok(None) => None,
            Ok(Some((ix, what))) => Some(self.send(state, ix, what).await),
            Err(e) => Some(match e.strip_prefix("BLOCKED:") {
                Some(w) => Step::Blocked(w.to_string()),
                None => Step::Stopped(e),
            }),
        }
    }

    async fn send(&mut self, state: &Shared, ix: Instruction, what: String) -> Step {
        if *self.stop.borrow() {
            return Step::Stopped("stopped by request".into());
        }
        match lk::simulate_ix(&lock(state), &self.payer, &ix) {
            Ok(s) if s.err.is_none() => {}
            Ok(s) => return Step::Stopped(format!("{what} simulation: {:?} (code {:?})", s.err, s.code)),
            Err(e) => return Step::Stopped(e),
        }
        let step = match submit_and_wait(state, &self.payer, ix, &what, self.land_timeout, &mut self.stop).await {
            Sent::Landed(sig) => Step::Landed(what, sig),
            Sent::Failed(e) => Step::Stopped(e),
            Sent::Unknown { signature, why } => Step::Unknown { signature, why },
        };
        self.log.push(format!("{step:?}"));
        step
    }

    async fn step_inner(&mut self, state: &Shared) -> Step {
        let me = self.payer.pubkey();
        let read = {
            let c = lock(state);
            (|| -> Result<Option<(ProvinceKey, Address, View, fclient::clock::SeasonClock, i64, u32)>, String> {
                let clock = lk::season_clock(&c, &self.a)?;
                let now = c.unix_timestamp();
                let now_bell = clock.bell_at(now).ok_or("the chain's time is before the season")?;
                let Some((dest, key, v)) = view(&c, &self.a, &self.holding, now_bell)? else { return Ok(None) };
                Ok(Some((dest, key, v, clock, now, now_bell)))
            })()
        };
        let (dest, key, v, clock, now, now_bell) = match read {
            Ok(Some(x)) => x,
            Ok(None) => return Step::Idle("the destination does not exist".into()),
            Err(e) => return Step::Stopped(e),
        };
        // the conquest crank first (its own facts, read under one lock): a due
        // capture, siege settlement or terminal close, or a fail-closed block
        #[cfg(feature = "localnet-conquest-play")]
        if let Some(s) = self.crank_step(state, dest, &key, &v, &clock, now, now_bell).await {
            return s;
        }
        let window_closed = v.anchor.is_some_and(|a_ts| now >= clock.reveal_close(v.resolved_next, a_ts));
        match plan(&v, now_bell, window_closed) {
            Plan::Idle(w) => Step::Idle(w),
            Plan::Wait(w) => Step::Wait(w),
            Plan::Blocked(w) => Step::Blocked(w),
            Plan::Anchor(b) => {
                let fetched = tokio::select! {
                    r = lk::fetch_rounds(&clock, b..b + 1) => r,
                    _ = crate::keeper_loop::stopped(&mut self.stop) => return Step::Stopped("stopped by request".into()),
                };
                let r = match fetched {
                    Ok(rs) => match rs.into_iter().find(|r| r.bell == b && r.round == clock.tlock_round(b)) {
                        Some(r) => r,
                        None => return Step::Wait(format!("round of bell {b} not served")),
                    },
                    Err(e) => return Step::Wait(format!("round of bell {b}: {e}")),
                };
                match lk::post_anchor_ix(&self.a, &me, v.region, &r) {
                    Ok(ix) => self.send(state, ix, format!("PostAnchor(resident bell {b}, region {})", v.region)).await,
                    Err(e) => Step::Stopped(e),
                }
            }
            Plan::Seed(b) => {
                let a_ts = v.anchor.expect("planned with an anchor");
                let round = clock.seed_round(b, a_ts);
                if clock.drand.round_time(round) > now {
                    return Step::Wait(format!("the seed round {round} of bell {b} is not due yet"));
                }
                let fetched = tokio::select! {
                    r = lk::fetch_round_at(round) => r,
                    _ = crate::keeper_loop::stopped(&mut self.stop) => return Step::Stopped("stopped by request".into()),
                };
                let sig48 = match fetched {
                    Ok(s) => s,
                    Err(e) => return Step::Wait(format!("seed round {round}: {e}")),
                };
                let arg = BeaconArg { round, sig48, hints: fclient::beacon::hints_bytes(round) };
                let ix = post_seed(&self.a, me, v.region, b, 0, &arg, &me);
                self.send(state, ix, format!("PostSeed(resident bell {b}, region {}, round {round})", v.region)).await
            }
            Plan::Resolve(b) => {
                let ix = resolve_ix(&self.a, &me, dest, &key, v.region, b);
                self.send(state, ix, format!("Resolve(resident bell {b})")).await
            }
            #[cfg(feature = "localnet-conquest-play")]
            Plan::ResolveWithConquest(b) => match crate::conquest_crank::resolve_with_conquest_ix(&self.a, &me, dest, &key, v.region, b) {
                Ok(ix) => self.send(state, ix, format!("ResolveWithConquest(resident bell {b})")).await,
                Err(e) => Step::Stopped(e),
            },
            #[cfg(not(feature = "localnet-conquest-play"))]
            Plan::ResolveWithConquest(b) => Step::Stopped(format!("bell {b}: ResolveWithConquest planned without the conquest runner")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::expedition_play::{PROGRAM, SEASON_ID};

    fn addrs() -> Addresses {
        Addresses::new(Address::new_from_array(PROGRAM), SEASON_ID)
    }
    fn v(rn: u32) -> View {
        View { resolved_next: rn, region: 8, end_bell: 1008, residents: 1, transit_live: false, anchor: Some(1_000), missing_anchor: None, inputs: false, arrival_bit: false, seed: true, conquest: Conquest::None, conquest_open: false }
    }

    /// PURE, fail-closed: only a program-owned, non-executable account that the
    /// program's own `WideConquest::read` accepts for THIS Season and THIS
    /// destination is a conquest table; every other account at that address is
    /// an error (never "Table", never left to simulation).
    #[test]
    fn only_a_valid_table_of_this_season_and_destination_counts() {
        let ctx = AddrCtx { program: PROGRAM, season: addrs().season.to_bytes() };
        let world = WorldId::derive_legacy_season(&ctx.season, &ctx.program).unwrap();
        let dest = ProvinceKey::new(world, WideCoord::checked(129, 0).unwrap());
        let other = ProvinceKey::new(world, WideCoord::checked(130, 0).unwrap());
        let program = Address::new_from_array(PROGRAM);
        let good = frontier_abi::world_index::conquest::WideConquest::new(SEASON_ID, dest, [0; 32]).unwrap().to_bytes().to_vec();
        assert!(checked_table(&program, false, &good, &program, SEASON_ID, dest).is_ok(), "the program's own table");
        let stranger = Address::new_from_array([0x77; 32]);
        assert!(checked_table(&stranger, false, &good, &program, SEASON_ID, dest).is_err(), "another owner");
        assert!(checked_table(&program, true, &good, &program, SEASON_ID, dest).is_err(), "executable");
        assert!(checked_table(&program, false, &good, &program, SEASON_ID + 1, dest).is_err(), "another Season");
        assert!(checked_table(&program, false, &good, &program, SEASON_ID, other).is_err(), "another destination");
        assert!(checked_table(&program, false, &good[..good.len() - 1], &program, SEASON_ID, dest).is_err(), "short (size)");
        let mut long = good.clone();
        long.push(0);
        assert!(checked_table(&program, false, &long, &program, SEASON_ID, dest).is_err(), "long (size)");
        let mut magic = good.clone();
        magic[0] ^= 0xFF;
        assert!(checked_table(&program, false, &magic, &program, SEASON_ID, dest).is_err(), "magic");
        let mut reserved = good.clone();
        reserved[82] = 1;
        assert!(checked_table(&program, false, &reserved, &program, SEASON_ID, dest).is_err(), "a reserved byte set");
        // the table version (u16 at 16): any other version is refused
        let v = u16::from_le_bytes([good[16], good[17]]);
        let mut version = good.clone();
        version[16..18].copy_from_slice(&v.wrapping_add(1).to_le_bytes());
        assert!(checked_table(&program, false, &version, &program, SEASON_ID, dest).is_err(), "another table version");
        // the header's reserved bytes 18..32 must be zero
        let mut pad = good.clone();
        pad[20] = 1;
        assert!(checked_table(&program, false, &pad, &program, SEASON_ID, dest).is_err(), "header padding set");
    }

    /// PURE, the continuation condition itself: tables built by the program's
    /// OWN codec (`reserve`, then `apply_reservation`), serialized and read
    /// back by `WideConquest::read`, are open in exactly the two cases that
    /// must keep the bells moving with no resident: (1) a live entry with no
    /// reservation left, (2) a reservation record with no entry. The empty
    /// table is not open (above).
    #[cfg(feature = "localnet-conquest-play")]
    #[test]
    fn tables_with_only_an_entry_or_only_a_reservation_are_open() {
        use frontier_abi::conquest_model::{Record, SiteRecordRules};
        use frontier_abi::v2::layout::province::conquest as CR;
        use frontier_abi::world_index::conquest::{Reservation, WideConquest, WideConquestEntry, RES_PENDING};
        let world = WorldId::new([0x77; 32]).unwrap();
        let dest = ProvinceKey::new(world, WideCoord::checked(129, 0).unwrap());
        let home = ProvinceKey::new(world, WideCoord::checked(130, 0).unwrap());
        let citizen = [5u8; 32];
        let r = Reservation {
            status: RES_PENDING, site: 1, entry: 5, reserved_slot: 2, faction: 2, done: 0, bell: 40, seq: 0, citizen,
            host: WideHostRef::new(home, 2, 1, 5).unwrap(), actor_tag: frontier_abi::addr::citizen_tag(&citizen),
            gold_milli: 25_000, arms_milli: 50_000,
        };
        let mut idle = Record::ZERO;
        idle.faction = CR::BARRED_NONE;
        let empty = WideConquest::new(SEASON_ID, dest, [9; 32]).unwrap();
        let roundtrip = |t: &WideConquest| WideConquest::read(&t.to_bytes(), SEASON_ID, dest).unwrap();
        // (2) a reservation record, no entry
        let (reserved, _prefix, r) = empty.reserve(idle, r).unwrap();
        let reserved = roundtrip(&reserved);
        assert!((0..12u8).all(|s| reserved.entry(s).unwrap().is_none()), "no entry");
        assert_eq!(reserved.reservations().iter().flatten().count(), 1, "one reservation record");
        assert_eq!(conquest_open_of(&reserved), Ok(true), "a reservation alone keeps the bells moving");
        // (1) the reservation applied as the site entry: a live entry, no reservation left
        let (i, _) = reserved.reservation(r.seq).unwrap();
        let e = WideConquestEntry {
            rules: SiteRecordRules {
                kind: CR::KIND_SIEGE, faction: r.faction, flags: CR::FLAG_HELD | CR::FLAG_NEUTRAL, progress: 0, required: 3,
                target: CR::target(CR::TARGET_FREE_CITY, r.reserved_slot), vigil_start: 0, vigil_next: 0, vigil_from_day: 0, bell: r.bell,
            },
            citizen: r.citizen, source: Some(r.source()), actor_tag: r.actor_tag, reserved_slot: r.reserved_slot,
            original_target_gen: 0, declaration_bell: r.bell,
        };
        let applied = roundtrip(&reserved.apply_reservation(i, e).unwrap().conquest);
        assert!(applied.reservations().iter().all(|x| x.is_none()), "no reservation left");
        assert!(applied.entry(1).unwrap().is_some(), "the live entry at site 1");
        assert_eq!(conquest_open_of(&applied), Ok(true), "a live entry alone keeps the bells moving");
        assert_eq!(conquest_open_of(&roundtrip(&empty)), Ok(false), "the empty table is not open");
    }

    /// PURE: an open conquest (a live entry or a reservation record in the
    /// program-owned table) keeps the destination's bells moving with NO
    /// resident (the host died or left), through ResolveWithConquest only; the
    /// transit, arrival, season-end and reveal rules still hold; with nothing
    /// open and no resident it stays idle as before.
    #[test]
    fn an_open_conquest_keeps_the_bells_moving_without_a_resident() {
        let open = View { residents: 0, conquest: Conquest::Table, conquest_open: true, ..v(20) };
        #[cfg(feature = "localnet-conquest-play")]
        assert_eq!(plan(&open, 21, true), Plan::ResolveWithConquest(20), "a lost or pending entry still needs its bells");
        #[cfg(not(feature = "localnet-conquest-play"))]
        assert!(matches!(plan(&open, 21, true), Plan::Blocked(_)));
        assert_eq!(plan(&View { anchor: None, ..open.clone() }, 21, false), Plan::Anchor(20));
        assert_eq!(plan(&View { seed: false, ..open.clone() }, 21, true), Plan::Seed(20));
        assert!(matches!(plan(&open, 21, false), Plan::Wait(_)), "reveal window open");
        assert!(matches!(plan(&View { transit_live: true, ..open.clone() }, 21, true), Plan::Idle(_)), "never races a live march or arrival");
        assert!(matches!(plan(&View { inputs: true, ..open.clone() }, 21, true), Plan::Blocked(_)), "arrival bells are not driven here");
        assert!(matches!(plan(&View { end_bell: 20, ..open.clone() }, 21, true), Plan::Idle(_)));
        // nothing open, no resident: idle exactly as before (a table with nothing left is not driven)
        assert!(matches!(plan(&View { conquest_open: false, ..open.clone() }, 21, true), Plan::Idle(_)));
        // an empty table (no entry, no reservation) is not open
        let ctx = AddrCtx { program: PROGRAM, season: addrs().season.to_bytes() };
        let world = WorldId::derive_legacy_season(&ctx.season, &ctx.program).unwrap();
        let dest = ProvinceKey::new(world, WideCoord::checked(129, 0).unwrap());
        let empty = frontier_abi::world_index::conquest::WideConquest::new(SEASON_ID, dest, [0; 32]).unwrap();
        assert_eq!(conquest_open_of(&empty), Ok(false));
    }

    /// PURE planning over hand-made views: which ONE action comes next. Not
    /// evidence that the program accepts it.
    #[test]
    fn only_quiet_ended_bells_of_a_settled_resident_are_driven() {
        // the voluntary-leave bell 20 resolves once ended, anchored, window closed and seeded
        assert_eq!(plan(&v(20), 21, true), Plan::Resolve(20));
        assert_eq!(plan(&View { seed: false, ..v(20) }, 21, true), Plan::Seed(20));
        assert_eq!(plan(&View { anchor: None, ..v(20) }, 21, false), Plan::Anchor(20));
        assert!(matches!(plan(&v(20), 21, false), Plan::Wait(_)), "reveal window open");
        assert!(matches!(plan(&v(21), 21, true), Plan::Wait(_)), "the bell has not ended");
        // nothing of ours: no resident, a live transit (the drivers'), the season's end
        assert!(matches!(plan(&View { residents: 0, ..v(20) }, 21, true), Plan::Idle(_)));
        assert!(matches!(plan(&View { transit_live: true, ..v(20) }, 21, true), Plan::Idle(_)), "never races a live march or arrival");
        assert!(matches!(plan(&View { end_bell: 20, ..v(20) }, 21, true), Plan::Idle(_)));
        // a bell with arrivals is reported, never gathered or resolved here
        assert!(matches!(plan(&View { inputs: true, ..v(20) }, 21, true), Plan::Blocked(_)));
        assert!(matches!(plan(&View { arrival_bit: true, ..v(20) }, 21, true), Plan::Blocked(_)));
        // priority: idle before anything; anchor before the window wait
        assert!(matches!(plan(&View { residents: 0, anchor: None, ..v(20) }, 21, false), Plan::Idle(_)));
    }

    /// PURE time model of the S1_LOCAL_7D clock at 1x (bell 600 s, reveal
    /// window 600 s after ITS anchor lands, seed due 60 s after the close,
    /// one action per 10 s Pilot tick, an anchor only once its bell ended):
    /// `plan` driven tick by tick. Returns `(final lag, ticks within one bell,
    /// ticks, transactions, transactions planned without a resident)` over the
    /// last two hours of a three-hour run.
    fn simulate(start_behind: u32, lead: bool, residents_until: Option<i64>) -> (u32, usize, usize, u32, u32, usize) {
        use std::collections::{HashMap, HashSet};
        let (bell, window, margin, tick) = (600i64, 600i64, 60i64, 10i64);
        let mut t = 20 * bell + 5;
        let mut rn = 20 - start_behind;
        let mut anchors: HashMap<u32, i64> = HashMap::new();
        let mut seeds: HashSet<u32> = HashSet::new();
        let (mut ok, mut n, mut sent, mut orphan, mut current) = (0usize, 0usize, 0u32, 0u32, 0usize);
        let end = t + 3 * 3600;
        while t < end {
            let now_bell = (t / bell) as u32;
            let residents = usize::from(residents_until.is_none_or(|u| t < u));
            let lead_bell = (rn..now_bell.min(rn + MAX_LEAD_ANCHORS + 1)).find(|b| !anchors.contains_key(b));
            let v = View { resolved_next: rn, region: 8, end_bell: 1008, residents, transit_live: false, anchor: anchors.get(&rn).copied(),
                missing_anchor: if lead && residents > 0 { lead_bell } else { None }, inputs: false, arrival_bit: false, seed: seeds.contains(&rn), conquest: Conquest::None, conquest_open: false };
            let window_closed = v.anchor.is_some_and(|a| t >= a + window);
            let planned = plan(&v, now_bell, window_closed);
            if residents == 0 && matches!(planned, Plan::Anchor(_) | Plan::Seed(_) | Plan::Resolve(_)) {
                orphan += 1;
            }
            match planned {
                Plan::Anchor(b) => {
                    assert!(b < now_bell, "only an ended bell is anchored");
                    anchors.insert(b, t);
                    sent += 1;
                }
                Plan::Seed(b) if t >= anchors[&b] + window + margin => {
                    seeds.insert(b);
                    sent += 1;
                }
                Plan::Resolve(b) => {
                    assert_eq!(b, rn);
                    rn += 1;
                    sent += 1;
                }
                _ => {}
            }
            if t >= end - 2 * 3600 {
                n += 1;
                ok += usize::from(rn + 1 >= now_bell);
                current += usize::from(rn >= now_bell);
            }
            t += tick;
        }
        ((t / bell) as u32 - rn, ok, n, sent, orphan, current)
    }

    #[test]
    fn lead_anchors_catch_a_behind_destination_up_at_1x_and_keep_pace() {
        // the QA case: six bells behind at a natural clock
        let (lag, ok, n, _, _, current) = simulate(6, true, None);
        assert!(lag <= 2, "caught up: final lag {lag}");
        // within one bell (the preview's rn + 1 >= nowBell) most of the time;
        // the rest is structural: a bell's anchor cannot exist before it ends,
        // and its window + seed margin (660 s) outlast the bell (600 s)
        assert!(ok * 100 >= n * 80, "within one bell {ok}/{n} ticks");
        // the old cursor-only anchoring falls further behind (the QA blocker)
        let (old_lag, old_ok, _, _, _, _) = simulate(6, false, None);
        std::eprintln!("simulated 1x from 6 behind: lead anchors final lag {lag}, within one bell {ok}/{n}; cursor-only final lag {old_lag}, within one bell {old_ok}/{n}");
        assert!(old_lag >= 6 && old_ok == 0, "old: lag {old_lag}, within one bell {old_ok}");
        // already current: stays current
        let (lag0, ok0, n0, _, _, current0) = simulate(0, true, None);
        assert!(lag0 <= 2 && ok0 * 100 >= n0 * 80);
        // FINDING (DeclareSiege's `RESOLVED_NEXT >= current bell`): at 1x
        // with this preset no tick ever has every earlier bell resolved: a
        // bell's anchor cannot exist before it ends, and its window + seed
        // margin (660 s) outlast the bell (600 s). Recorded, not changed here.
        std::eprintln!("resolved through the current bell (rn >= nowBell): {current}/{n} and {current0}/{n0} ticks");
        assert_eq!((current, current0), (0, 0), "the declaration precondition is never met at 1x under S1_LOCAL_7D timing");
    }

    /// A live conquest table: only ResolveWithConquest, and only in the
    /// conquest runner; the plain runner blocks (never a plain Resolve); site
    /// records without a table block in both. Earlier steps are unchanged.
    #[test]
    fn a_besieged_bell_never_gets_a_plain_resolve() {
        let t = View { conquest: Conquest::Table, ..v(20) };
        #[cfg(feature = "localnet-conquest-play")]
        assert_eq!(plan(&t, 21, true), Plan::ResolveWithConquest(20));
        #[cfg(not(feature = "localnet-conquest-play"))]
        assert!(matches!(plan(&t, 21, true), Plan::Blocked(_)), "the plain runner has no ResolveWithConquest");
        assert!(matches!(plan(&View { conquest: Conquest::Unprovable, ..v(20) }, 21, true), Plan::Blocked(_)));
        assert_eq!(plan(&View { conquest: Conquest::None, ..v(20) }, 21, true), Plan::Resolve(20), "no conquest: plain Resolve as before");
        // anchors and seeds come first exactly as before
        assert_eq!(plan(&View { seed: false, ..t.clone() }, 21, true), Plan::Seed(20));
        assert_eq!(plan(&View { missing_anchor: Some(20), anchor: None, ..t }, 21, false), Plan::Anchor(20));
    }

    /// The conquest state from chain bytes: a program-owned table, zero
    /// records, set records without a table, a foreign account at the table
    /// address (an error, never read as absent).
    #[test]
    fn the_conquest_state_is_read_from_the_table_and_the_records() {
        use frontier_abi::v2::layout::province::{conquest as CR, province as PV};
        let a = addrs();
        let dest = dest_key(&a).unwrap();
        let mut pd = vec![0u8; PV::SIZE];
        pd[PV::SITE_COUNT] = 2;
        let mut c = Chain::new(localnet::Config::default());
        c.produce_block();
        assert_eq!(conquest_of(&c, &a, dest, &pd), Ok(Conquest::None));
        let mut set = pd.clone();
        set[PV::record(1) + CR::KIND] = CR::KIND_SIEGE;
        assert_eq!(conquest_of(&c, &a, dest, &set), Ok(Conquest::Unprovable));
        let tk = Address::new_from_array(frontier_abi::world_index::conquest::conquest_address(&ctx_of(&a), dest));
        c.set_account(tk, fclient::ports::Account { lamports: 1_000_000, data: vec![0; 8], owner: Address::new_from_array([9; 32]), executable: false }).unwrap();
        assert!(conquest_of(&c, &a, dest, &pd).is_err(), "a foreign account at the table address");
        // program-owned but NOT a valid table (8 bytes): an error, never Table (checked_table)
        c.set_account(tk, fclient::ports::Account { lamports: 1_000_000, data: vec![0; 8], owner: a.program, executable: false }).unwrap();
        assert!(conquest_of(&c, &a, dest, &set).is_err(), "a program-owned account that is not a valid table");
        // (an executable account at the table address cannot even be stored by this chain
        // — set_account refuses it, IncorrectProgramId — so that case is covered by the pure
        // only_a_valid_table_of_this_season_and_destination_counts test)
        let table = frontier_abi::world_index::conquest::WideConquest::new(a.season_id, dest, [0; 32]).unwrap().to_bytes().to_vec();
        // the program's own valid table: Table (with set records and with zero records alike)
        c.set_account(tk, fclient::ports::Account { lamports: 1_000_000, data: table, owner: a.program, executable: false }).unwrap();
        assert_eq!(conquest_of(&c, &a, dest, &set), Ok(Conquest::Table));
        assert_eq!(conquest_of(&c, &a, dest, &pd), Ok(Conquest::Table));
    }

    #[test]
    fn no_bell_is_anchored_before_it_ends_even_at_bell_zero() {
        // nothing has ended at bell 0: no lead range, no anchor
        assert_eq!(lead_range(0, 0, 1008), None);
        assert_eq!(lead_range(5, 0, 1008), None);
        assert_eq!(lead_range(0, 1, 1008), Some(0..=0), "bell 0 ended once bell 1 began");
        assert_eq!(lead_range(3, 3, 1008), None, "the cursor's bell has not ended");
        assert_eq!(lead_range(0, 1008, 1008), Some(0..=MAX_LEAD_ANCHORS), "bounded ahead");
        assert_eq!(lead_range(0, 2000, 10), Some(0..=9), "below the Season's end");
        assert_eq!(lead_range(0, 5, 0), None);
        // plan refuses a lead anchor that is not of an ended bell at/after the cursor
        let zero = View { resolved_next: 0, anchor: None, missing_anchor: Some(0), ..v(0) };
        assert!(matches!(plan(&zero, 0, false), Plan::Wait(_)), "bell 0 has not ended: wait, not Anchor(0)");
        assert!(matches!(plan(&View { missing_anchor: Some(21), ..v(20) }, 21, true), Plan::Resolve(20)), "a future lead bell is ignored");
        assert!(matches!(plan(&View { missing_anchor: Some(19), ..v(20) }, 25, true), Plan::Resolve(20)), "a bell before the cursor is ignored");
        assert_eq!(plan(&View { missing_anchor: Some(24), ..v(20) }, 25, true), Plan::Anchor(24));
    }

    #[test]
    fn work_stops_when_the_resident_leaves_or_is_lost() {
        // the resident is gone (Return released it, or a defeat removed it)
        // after 30 minutes: no further anchor, seed or resolve is planned
        let (_, _, _, full, none, _) = simulate(6, true, None);
        let (_, _, _, cut, orphan, _) = simulate(6, true, Some(20 * 600 + 5 + 1800));
        // direct: zero transactions planned after the resident is gone
        assert_eq!((none, orphan), (0, 0), "nothing is planned once the resident is gone");
        let _ = (full, cut);
        // and a lead anchor is never planned without a resident, a live transit or past the end
        let ahead = View { missing_anchor: Some(21), ..v(20) };
        assert!(matches!(plan(&View { residents: 0, ..ahead.clone() }, 25, true), Plan::Idle(_)));
        assert!(matches!(plan(&View { transit_live: true, ..ahead.clone() }, 25, true), Plan::Idle(_)));
        assert!(matches!(plan(&View { end_bell: 20, ..ahead.clone() }, 25, true), Plan::Idle(_)));
        // with a resident, the missing lead anchor comes before the cursor's own steps
        assert_eq!(plan(&ahead, 25, true), Plan::Anchor(21));
    }

    #[test]
    fn the_resolve_has_the_wide_resolve_tables_shape() {
        let a = addrs();
        let dest = dest_key(&a).unwrap();
        let key = Address::new_from_array(province_address(&ctx_of(&a), dest.coord()));
        let payer = Address::new_from_array([0x51; 32]);
        let ix = resolve_ix(&a, &payer, dest, &key, 8, 20);
        let g = wix::RESOLVE;
        assert_eq!(ix.accounts.len(), frontier_abi::prologue::bounds_in(g).0);
        let at = |name: &str| frontier_abi::prologue::position_in(g, ix.accounts.len(), name, 0).unwrap();
        let ctx = ctx_of(&a);
        for (name, k) in [("fee_payer", payer), ("season", a.season), ("province", key), ("roster", Address::new_from_array(roster_address(&ctx, dest))),
            ("seed", a.seed_cache(20, 8, 0)), ("anchor", a.anchor(20, 8)), ("clash_inputs", Address::new_from_array(clash_inputs_address(&ctx, dest, 20))),
            ("arrivalday", Address::new_from_array(arrival_day_address(&ctx, dest, day_of(20))))] {
            assert_eq!(ix.accounts[at(name)].pubkey, k, "{name}");
        }
        assert!(ix.accounts[0].is_signer && ix.accounts[0].is_writable);
        for name in ["province", "roster"] {
            assert!(ix.accounts[at(name)].is_writable, "{name} writable");
        }
        assert!(matches!(wix::WideCommand::decode(&ix.data), Ok(wix::WideCommand::Resolve(x)) if x.bell == 20));
    }

    /// A resident is read from a WideRoster paired with the entry table (both
    /// written with the abi's own codecs, SYNTHETIC bytes on a test chain):
    /// counted only when its host's canonical Holding is the watched one; an
    /// unpaired table is refused.
    #[test]
    fn a_paired_roster_names_the_watched_holdings_resident_only() {
        use frontier_abi::entry::{write_entry, Entry};
        use frontier_abi::world_index::march::wide_host_alias;
        let a = addrs();
        let ctx = ctx_of(&a);
        let dest = dest_key(&a).unwrap();
        let resolver = AccountResolver::for_season(&ctx).unwrap();
        let mine = resolver.legacy_host_ref(frontier_abi::addr::host_id(128, 0, 1, 2, 0).unwrap()).unwrap();
        let other = resolver.legacy_host_ref(frontier_abi::addr::host_id(128, 0, 0, 2, 0).unwrap()).unwrap();
        let holding = Address::new_from_array(resolver.holding_address(&mine).unwrap());
        let mut pd = vec![0u8; frontier_abi::layout::province::province::SIZE];
        let mut rd = vec![0u8; frontier_abi::world_index::roster::wide_roster::SIZE];
        let r = WideRoster::new(SEASON_ID, dest, [7; 32]);
        r.write_header(&mut rd).unwrap();
        for (i, h) in [(3usize, mine), (5, other)] {
            let alias = r.claim(&mut rd, i, &h).unwrap();
            assert_eq!(alias, wide_host_alias(&h));
            write_entry(&mut pd, i, &Entry { id: alias, faction: 0, unit: 2, tile: 7, state: 1, troops: 12_000, ..Entry::FREE }).unwrap();
        }
        let mut c = Chain::new(localnet::Config::default());
        c.produce_block();
        let rk = Address::new_from_array(roster_address(&ctx, dest));
        c.set_account(rk, fclient::ports::Account { lamports: 1_000_000, data: rd.clone(), owner: a.program, executable: false }).unwrap();
        assert_eq!(residents_of(&c, &a, dest, &pd, &holding), Ok(vec![(3, mine, 1)]), "only the watched Holding's host");
        assert_eq!(residents_of(&c, &a, dest, &pd, &Address::new_from_array([5; 32])), Ok(vec![]));
        // the entry table no longer holds index 5's alias: unpaired, refused
        write_entry(&mut pd, 5, &Entry::FREE).unwrap();
        assert!(residents_of(&c, &a, dest, &pd, &holding).is_err());
    }

    #[test]
    fn no_destination_no_roster_and_no_transit_mean_idle() {
        let a = addrs();
        let mut c = Chain::new(localnet::Config::default());
        c.produce_block();
        crate::expedition_play::Base::new(c.unix_timestamp()).unwrap().install(&mut c).unwrap();
        let holding = Address::new_from_array([5; 32]);
        assert_eq!(view(&c, &a, &holding, 30), Ok(None), "no destination Province");
        assert!(!transit_live(&c, &a, &holding));
        // no WideRoster: no resident (whatever the Province bytes)
        assert_eq!(residents_of(&c, &a, dest_key(&a).unwrap(), &[], &holding), Ok(vec![]));
        // a foreign account at the roster address is refused, never read as empty
        let ctx = ctx_of(&a);
        let rk = Address::new_from_array(roster_address(&ctx, dest_key(&a).unwrap()));
        c.set_account(rk, fclient::ports::Account { lamports: 1_000_000, data: vec![0; 8], owner: Address::new_from_array([9; 32]), executable: false }).unwrap();
        assert!(residents_of(&c, &a, dest_key(&a).unwrap(), &[], &holding).is_err());
        // a transit record of the holding makes it live (any state, any owner)
        let tk = Address::new_from_array(transit_address(&ctx, &holding.to_bytes(), 2));
        c.set_account(tk, fclient::ports::Account { lamports: 1_000_000, data: vec![1], owner: Address::new_from_array(PROGRAM), executable: false }).unwrap();
        assert!(transit_live(&c, &a, &holding));
    }
}
