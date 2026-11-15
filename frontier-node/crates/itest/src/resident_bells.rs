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
    pub inputs: bool,
    pub arrival_bit: bool,
    pub seed: bool,
}

/// The destination's view; `None` when the destination does not exist yet.
pub fn view(c: &Chain, a: &Addresses, holding: &Address) -> Result<Option<(ProvinceKey, Address, View)>, String> {
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
    Ok(Some((dest, key, View {
        resolved_next: rn,
        region: prov.region,
        end_bell,
        residents,
        transit_live: transit_live(c, a, holding),
        anchor: lk::anchor_landed(c, a, rn, prov.region)?,
        inputs,
        arrival_bit,
        seed: c.account(&a.seed_cache(rn, prov.region, 0)).is_some(),
    })))
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
}

pub fn plan(v: &View, now_bell: u32, window_closed: bool) -> Plan {
    let b = v.resolved_next;
    if v.residents == 0 {
        return Plan::Idle("no resident of the watched Holding stands in the destination".into());
    }
    if v.transit_live {
        return Plan::Idle("a transit record of the watched Holding is live (the origin/destination drivers')".into());
    }
    if b >= v.end_bell {
        return Plan::Idle(format!("bell {b} is at or past the Season's end bell {}", v.end_bell));
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
    Plan::Resolve(b)
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
                let Some((dest, key, v)) = view(&c, &self.a, &self.holding)? else { return Ok(None) };
                let clock = lk::season_clock(&c, &self.a)?;
                let now = c.unix_timestamp();
                let now_bell = clock.bell_at(now).ok_or("the chain's time is before the season")?;
                Ok(Some((dest, key, v, clock, now, now_bell)))
            })()
        };
        let (dest, key, v, clock, now, now_bell) = match read {
            Ok(Some(x)) => x,
            Ok(None) => return Step::Idle("the destination does not exist".into()),
            Err(e) => return Step::Stopped(e),
        };
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
        View { resolved_next: rn, region: 8, end_bell: 1008, residents: 1, transit_live: false, anchor: Some(1_000), inputs: false, arrival_bit: false, seed: true }
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
        assert_eq!(view(&c, &a, &holding), Ok(None), "no destination Province");
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
