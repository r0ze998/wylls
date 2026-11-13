//! **Local-play origin driver** (feature `localnet-expedition-play`): after a
//! Depart, the home Province's departure bell is no longer quiet (the host's
//! pending Spend), so FastForward is refused with NotQuiet. This drives that
//! bell to its resolution with the real instructions, in order, one per step:
//!
//! 1. THE anchor of the bell must exist and its reveal window be closed
//!    (`local_keeper`); otherwise: wait;
//! 2. quiet test: FastForward(b → b+1) is SIMULATED on the node; if it would
//!    succeed the bell is quiet and left to the keeper (`Quiet`); NotQuiet
//!    continues here; any other refusal stops;
//! 3. GatherClash(b, no slots): the program creates the bell's ClashInputs
//!    (no arrival at the home that day: `FLAG_NO_ARRIVALS`, all gathered);
//! 4. PostSeed(b, nonce 0) with the round `S(b, A)` of the anchor's landing
//!    time, once due, fetched from the public drand API and verified against
//!    the pinned Quicknet key (`local_keeper::fetch_round_at`);
//! 5. ResolveFromInputs(b): the program resolves the bell (`resolved_next`
//!    moves past it, the departed host's entry is settled by the kernel);
//! 6. ExpeditionSettleOrigin(slot) through the version-2 wrapper for each
//!    transit slot whose settlement the node's simulation accepts.
//!
//! Every transaction lands on the node's own ticker (natural clock, no block
//! produced here). An outcome not seen is `Unknown` with its signature and is
//! never resent; a refusal is returned as it is. No account is written
//! directly; nothing the player keeps secret (plaintext, salt) is read.
use fclient::addr::Addresses;
use fclient::ix::{gather_clash, post_seed, resolve_from_inputs, AnchorSource, BeaconArg, SeedSource};
use fclient::{AccountMeta, Address, Instruction, Keypair, Signer};
use frontier_abi::addr::AddrCtx;
use frontier_abi::world_index::{expedition_dispatch_ix as dx, wide_ix as wix};
use localnet::server::{lock, Shared};
use std::time::Duration;

use crate::keeper_loop::{submit_and_wait, Sent};
use crate::local_keeper::{self as lk, HomeView};

use crate::keeper_loop::HOME;
use crate::local_keeper::NOT_QUIET;

/// What one step did or why it waits / stopped.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Step {
    /// Nothing to do yet (the reason, e.g. a reveal window not closed).
    Wait(String),
    /// The home's next bell is quiet: FastForward (the keeper) can take it.
    Quiet(u32),
    /// One transaction landed: what it was, its signature.
    Landed(String, String),
    /// A transaction was sent but not seen landed: never resent.
    Unknown { signature: String, why: String },
    /// A refusal (as the program or the node gave it): the driver stops.
    Stopped(String),
}

pub struct OriginDriver {
    a: Addresses,
    holding: Address,
    /// The home province ([`HOME`] unless built with `new_at`).
    home: (i16, i16),
    payer: Keypair,
    stop: tokio::sync::watch::Receiver<bool>,
    pub land_timeout: Duration,
    /// Once `Unknown` or `Stopped`, every later step returns it (no resend).
    terminal: Option<Step>,
    pub log: Vec<String>,
}

fn simulate(state: &Shared, payer: &Keypair, ix: &Instruction) -> Result<fclient::ports::SimResult, String> {
    lk::simulate_ix(&lock(state), payer, ix)
}

impl OriginDriver {
    /// A driver for the player's `holding` with a funded fee payer (the
    /// caller's fresh in-memory key).
    pub fn new(holding: Address, payer: Keypair, stop: tokio::sync::watch::Receiver<bool>) -> OriginDriver {
        OriginDriver::new_at(holding, HOME, payer, stop)
    }

    /// As [`OriginDriver::new`], for the home province `home` (the province of the player's real PlaceHome).
    pub fn new_at(holding: Address, home: (i16, i16), payer: Keypair, stop: tokio::sync::watch::Receiver<bool>) -> OriginDriver {
        OriginDriver { a: Addresses::new(Address::new_from_array(crate::expedition_play::PROGRAM), crate::expedition_play::SEASON_ID),
            holding, home, payer, stop, land_timeout: crate::keeper_loop::LAND_TIMEOUT, terminal: None, log: vec![] }
    }

    /// The terminal outcome, if the driver has stopped.
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

    fn ctx(&self) -> AddrCtx {
        AddrCtx { program: self.a.program.to_bytes(), season: self.a.season.to_bytes() }
    }

    fn external(&self, slot: u8) -> Address {
        Address::new_from_array(frontier_abi::world_index::march::transit_address(&self.ctx(), &self.holding.to_bytes(), slot))
    }

    fn settle_origin_ix(&self, slot: u8) -> Instruction {
        let home = self.a.province(self.home.0.into(), self.home.1.into());
        let data = dx::encode(dx::Kind::SettleOrigin, &wix::ExpeditionSettleOrigin { transit_slot: slot }.to_bytes()).expect("a SettleOrigin wire");
        Instruction {
            program_id: self.a.program,
            accounts: vec![
                AccountMeta::new(self.payer.pubkey(), true),
                AccountMeta::new_readonly(self.a.season, false),
                AccountMeta::new(home, false),
                AccountMeta::new(self.holding, false),
                AccountMeta::new(home, false),
                AccountMeta::new(self.external(slot), false),
            ],
            data,
        }
    }

    /// At most one transaction; see the module doc for the order. After an
    /// `Unknown` or `Stopped` outcome, every later call returns it.
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

    async fn step_inner(&mut self, state: &Shared) -> Step {
        let me = self.payer.pubkey();
        let (v, clock) = {
            let c = lock(state);
            match (lk::view(&c, &self.a, self.home.0, self.home.1), lk::season_clock(&c, &self.a)) {
                (Ok(v), Ok(k)) => (v, k),
                (Err(e), _) | (_, Err(e)) => return Step::Stopped(format!("cannot read the home: {e}")),
            }
        };
        // 1. origin settlements, from each transit record's REAL state: a
        //    Departed record whose departure bell the home has resolved is due;
        //    one whose bell is not resolved yet waits for steps 2-6
        for slot in 0..4u8 {
            let rec = lock(state).account(&self.external(slot));
            let Some(acc) = rec else { continue };
            if acc.owner != self.a.program {
                continue; // a free slot (no program record)
            }
            let bridge = match frontier_abi::world_index::expedition_transport::OwnedBridgeTransit::from_bytes(&self.ctx(), &acc.data) {
                Ok(b) => b,
                Err(e) => return Step::Stopped(format!("transit slot {slot}: unreadable bridge record ({e:?})")),
            };
            let t = bridge.transit();
            if t.state != frontier_abi::world_index::march::MarchState::Departed || v.resolved_next <= t.depart_bell {
                continue;
            }
            let ix = self.settle_origin_ix(slot);
            return match simulate(state, &self.payer, &ix) {
                Ok(sim) if sim.err.is_none() => self.send(state, ix, &format!("SettleOrigin(slot {slot})")).await,
                // resolved but refused: not a normal wait
                Ok(sim) => Step::Stopped(format!("SettleOrigin(slot {slot}) simulation: {:?} (code {:?})", sim.err, sim.code)),
                Err(e) => Step::Stopped(e),
            };
        }
        let b = v.resolved_next;
        if b >= v.bell_now {
            return Step::Wait(format!("bell {b} has not ended"));
        }
        let closed = { let c = lock(state); lk::closed_through(&c, &self.a, v.region, b, b + 1) };
        match closed {
            Ok(x) if x > b => {}
            Ok(_) => return Step::Wait(format!("the anchor of bell {b} is absent or its reveal window is open")),
            Err(e) => return Step::Stopped(e),
        }
        // 2. the quiet test, simulated
        let ff = match lk::fast_forward_ix(&self.a, &me, self.home.0, self.home.1, &HomeView { ..v }, b + 1) {
            Ok(ix) => ix,
            Err(e) => return Step::Stopped(e),
        };
        match simulate(state, &self.payer, &ff) {
            Ok(sim) if sim.err.is_none() => return Step::Quiet(b),
            Ok(sim) if sim.code == Some(NOT_QUIET) => {}
            Ok(sim) => return Step::Stopped(format!("FastForward(b {b}) simulation: {:?} (code {:?})", sim.err, sim.code)),
            Err(e) => return Step::Stopped(e),
        }
        let (p, q) = (self.home.0 as i32, self.home.1 as i32);
        let (form, seed, anchor_a) = {
            let c = lock(state);
            let a_ts = match lk::anchor_landed(&c, &self.a, b, v.region) {
                Ok(Some(t)) => t,
                Ok(None) => return Step::Wait(format!("no anchor of bell {b}")),
                Err(e) => return Step::Stopped(e),
            };
            (home_gather_form(&c, &self.a, (p, q), b), c.account(&self.a.seed_cache(b, v.region, 0)).is_some(), a_ts)
        };
        // (independent review, 2026-11-13: the gather is done only when ALL positions are — the mere existence of the
        //  ClashInputs is not. The form is the keeper's and the legacy march driver's: the one no-arrivals part while
        //  the ArrivalDay bit is clear, otherwise the parts over the REAL present arrival slots (an ordinary march
        //  arriving at the home province itself). Nothing is seeded or resolved over partly gathered inputs.)
        match form {
            Some(crate::legacy_march::GatherForm::NoArrivals) => {
                let ix = gather_clash(&self.a, me, (p, q), b, AnchorSource::Anchor, 0, &[(0, 0)], &[], 0, &me);
                return self.send(state, ix, &format!("GatherClash(bell {b})")).await;
            }
            Some(crate::legacy_march::GatherForm::Parts(parts)) => {
                let part = parts.into_iter().next().expect("non-empty");
                let ix = gather_clash(&self.a, me, (p, q), b, AnchorSource::Anchor, part.start, &part.slots, &part.holdings, part.bitmap, &me);
                return self.send(state, ix, &format!("GatherClash(bell {b}, from {})", part.start)).await;
            }
            None => {}
        }
        if !seed {
            let round = clock.seed_round(b, anchor_a);
            let now = lock(state).unix_timestamp();
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
            return self.send(state, ix, &format!("PostSeed(bell {b}, round {round})")).await;
        }
        let ix = resolve_from_inputs(&self.a, me, (p, q), b, SeedSource::Cache { nonce: 0 }, &me);
        self.send(state, ix, &format!("ResolveFromInputs(bell {b})")).await
    }
}

/// The GatherClash still due for the home's bell `b`, read from the chain: None once every position is gathered
/// (`legacy_march::gather_form` over the ClashInputs mask, the ArrivalDay bit and the present ArrivalSlots).
pub fn home_gather_form(c: &localnet::Chain, a: &Addresses, (p, q): (i32, i32), b: u32) -> Option<crate::legacy_march::GatherForm> {
    let owned = |k: &Address| c.account(k).filter(|acc| acc.owner == a.program);
    let mask = owned(&a.clash_inputs(p, q, b)).and_then(|acc| fclient::decode::ClashInputs::decode(&acc.data).ok()).map_or(0, |ci| ci.arrivals_mask);
    let day_set = owned(&a.arrival_day(p, q, frontier_abi::addr::day_of(b))).and_then(|acc| fclient::decode::ArrivalDay::decode(&acc.data).ok()).is_some_and(|d| d.has(b));
    let slots: [Option<fclient::decode::ArrivalSlot>; 24] = core::array::from_fn(|k| owned(&a.arrival_slot(p, q, b, (k / 4) as u8, (k % 4) as u8)).and_then(|acc| fclient::decode::ArrivalSlot::decode(&acc.data).ok()));
    crate::legacy_march::gather_form(mask, day_set, &crate::legacy_march::present_positions(a, &slots))
}

/// Real artifact + public drand: a REAL signed Depart (fresh in-memory test
/// wallet, real wide seal) on an isolated runner chain, then the keeper's
/// anchors and the origin driver's GatherClash → PostSeed → ResolveFromInputs
/// → SettleOrigin, until the departure bell is resolved and the home's next
/// bell is quiet again. The test chain's clock is moved with the node's scale
/// control (this chain only). Ignored without the artifact and
/// `WYLLS_PUBLIC_DRAND=1`.
#[cfg(test)]
pub(crate) mod real_origin {
    use super::*;
    use crate::expedition_play::{inspect, launch, PROGRAM, REFUSED_PORT};
    use crate::keeper_loop::Keeper;
    use fclient::experimental_expedition_message::{prepare_depart, Target, DEPART_HEAP_FRAME};
    use fclient::original_expedition_depart_draft::Draft;
    use fclient::tx::{self, TxBudget};
    use fclient::unsigned_message_preflight::{BlockhashObservation, Limits};
    use frontier_abi::world_index::{seal::WidePlain, ProvinceKey, WideCoord};
    use localnet::server;

    fn rx() -> tokio::sync::watch::Receiver<bool> {
        let (tx, rx) = tokio::sync::watch::channel(false);
        std::mem::forget(tx);
        rx
    }
    fn advance(state: &Shared, to_unix: i64) {
        let mut c = lock(state);
        c.set_scale(1000.0);
        while c.unix_timestamp() < to_unix { c.produce_block(); }
        c.set_scale(1.0);
        c.produce_block();
    }


    /// A REAL signed Depart of the fixture's host by `player` (fresh in-memory
    /// test wallet, real wide seal, the canonical prepared message); the bell.
    pub(crate) fn real_depart(state: &Shared, f: &crate::expedition_play::Fixture, player: &Keypair) -> u32 {
        // (the origin-only fixture: its fixed route is never revealed)
        real_depart_routed(state, f, player, &[0], 30, |bell, _| bell + 5).0
    }

    /// As [`real_depart`] with the sealed route `dirs` (hex directions) to
    /// `dest_tile` of (129, 0) and the arrival bell `arrive_of(bell, now)`
    /// (`now` = the chain time the Depart executes at); also returns the
    /// arrival bell and the seal (the player's own secrets for its later
    /// Reveal; memory only, never printed). A Depart landing proves nothing
    /// of the route: only the Reveal checks it.
    pub(crate) fn real_depart_routed(state: &Shared, f: &crate::expedition_play::Fixture, player: &Keypair, dirs: &[u8], dest_tile: u8,
        arrive_of: impl FnOnce(u32, i64) -> u32) -> (u32, u32, fclient::wide_seal::WideSealed) {
        let program = Address::new_from_array(PROGRAM);

                let mut c = lock(state);
                let season = fclient::decode::Season::decode(&c.account(&f.season).unwrap().data).unwrap();
                let clock = fclient::clock::SeasonClock::from_season(&season);
                let bell = clock.bell_at(c.unix_timestamp()).unwrap();
                let arrive = arrive_of(bell, c.unix_timestamp());
                let tip = fclient::fees::min_tip_lamports(season.min_reveal_priority_milli, season.reveal_cu_limit, season.reveal_loaded_limit);
                let (path_len, path_bits) = permutation_rules::frontier::seal::encode_path(dirs).unwrap();
                let plain = WidePlain { version: frontier_abi::world_index::seal::WIDE_PLAIN_VERSION, host: f.host, arrive_bell: arrive,
                    dest: ProvinceKey::new(f.host.key().world(), WideCoord::checked(129, 0).unwrap()), dest_tile, stance: 0, retreat_bps: 0,
                    path_len, path: path_bits, reserved: [0; frontier_abi::world_index::seal::WIDE_RESERVED_BYTES] };
                let qn = fclient::beacon::quicknet_info();
                let sealed = fclient::wide_seal::seal_wide(&plain, &f.host, arrive, &qn.public_key, clock.tlock_round(arrive)).unwrap();
                let ctx = AddrCtx { program: program.to_bytes(), season: f.season.to_bytes() };
                let draft = Draft::for_wallet(&ctx, f.host, f.host.key(), player.pubkey(), player.pubkey(), 0, arrive, tip, sealed.commit, sealed.seal).unwrap();
                let (blockhash, last_valid) = c.latest_blockhash();
                let obs = BlockhashObservation { blockhash: blockhash.to_bytes(), context_slot: c.slot(), valid: true, block_height: last_valid.saturating_sub(100), last_valid_block_height: last_valid };
                let budget = TxBudget { cu_limit: 1_000_000, cu_price: 0, loaded_limit: fclient::fees::RUNTIME_MAX_LOADED, heap: Some(DEPART_HEAP_FRAME) };
                let limits = Limits { max_locks: 32, max_writes: 16, min_context_slot: 0, min_remaining_block_heights: 2 };
                let prepared = prepare_depart(&draft, Target { program, season: f.season, program_version: crate::expedition_play::PROGRAM_VERSION }, obs, budget, limits).unwrap();
                let t = tx::sign(prepared.message().clone(), &[&player]).unwrap();
                let sig = c.submit(&tx::wire(&t)).unwrap();
                c.produce_block();
                assert_eq!(c.transaction(&sig).unwrap().err, None, "the real Depart");
                (bell, arrive, sealed)
                }

    #[test]
    #[ignore]
    fn a_real_departure_bell_is_gathered_seeded_resolved_and_settled() {
        let need = |k: &str| std::env::var(k).unwrap_or_else(|_| panic!("{k} is not set"));
        assert_eq!(need("WYLLS_PUBLIC_DRAND"), "1");
        let path = std::path::PathBuf::from(need("WYLLS_EXPEDITION_SBF"));
        let art = inspect(path.clone(), std::fs::read(&path).unwrap(), &need("WYLLS_EXPEDITION_SBF_SHA256")).unwrap();
        let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap();
        rt.block_on(async {
            let p = (41_920..41_927u16).find(|p| *p != REFUSED_PORT && server::check_port(*p).is_ok()).unwrap();
            let q = (p + 1..41_928u16).find(|x| server::check_port(*x).is_ok()).unwrap();
            let player = Keypair::new();
            let play = launch(&art, player.pubkey(), p, q).await.unwrap();
            let state = play.running.state.clone();
            let f = &play.fixture;
            let b0 = real_depart(&state, f, &player);
            let mut keeper = Keeper::new(&state, crate::keeper_loop::public_quicknet(), rx()).await.unwrap();
            let payer = Keypair::new();
            lock(&state).airdrop(&payer.pubkey(), 20_000_000_000).unwrap();
            let mut driver = OriginDriver::new(f.holding, payer, rx());
            let clock = { let c = lock(&state); lk::season_clock(&c, &driver.a).unwrap() };
            advance(&state, clock.genesis_ts + 600 * (b0 as i64 + 1) + 5); // the departure bell has ended
            let mut landed: Vec<String> = vec![];
            for _ in 0..30 {
                // anchors are the keeper's; its FastForward is not reached while the bell is not quiet
                let _ = keeper.tick(&state).await;
                match driver.step(&state).await {
                    Step::Landed(what, _) => landed.push(what),
                    Step::Wait(why) => {
                        let now = lock(&state).unix_timestamp();
                        eprintln!("wait: {why}");
                        advance(&state, now + 120);
                    }
                    Step::Quiet(b) => { eprintln!("bell {b} quiet"); if landed.iter().any(|w| w.starts_with("SettleOrigin")) { break; } let now = lock(&state).unix_timestamp(); advance(&state, now + 120); }
                    other => panic!("{other:?}; landed {landed:?}; keeper {:?}", keeper.status),
                }
            }
            eprintln!("landed: {landed:?}");
            let kinds: Vec<&str> = landed.iter().map(|w| w.split('(').next().unwrap()).collect();
            for k in ["GatherClash", "PostSeed", "ResolveFromInputs", "SettleOrigin"] {
                assert!(kinds.contains(&k), "{k} in {landed:?}");
            }
            let v = { let c = lock(&state); lk::view(&c, &driver.a, 128, 0).unwrap() };
            assert!(v.resolved_next > b0, "the departure bell is resolved: {v:?}");
            // and the home's next bell really is quiet now (the keeper can FastForward it)
            let mut quiet = None;
            for _ in 0..10 {
                match driver.step(&state).await {
                    Step::Quiet(b) => { quiet = Some(b); break; }
                    Step::Wait(_) => { let _ = keeper.tick(&state).await; let now = lock(&state).unix_timestamp(); advance(&state, now + 120); }
                    other => panic!("{other:?}"),
                }
            }
            assert_eq!(quiet, Some(v.resolved_next), "the next bell is quiet");
            assert!(driver.terminal().is_none());
            play.running.stop();
        });
    }
}

/// An ordinary march arriving at the HOME province itself (independent review, 2026-11-13): the origin driver's
/// gather is the real one over the present arrival slots, and an existing but partly gathered ClashInputs is never
/// taken as done (no seed, no resolve over it). A plain in-memory chain (no program, no network, no port): the
/// accounts are the shapes the decoders read.
#[cfg(test)]
mod same_home_arrival {
    use super::*;
    use crate::legacy_march::{GatherForm, ALL_GATHERED};
    use frontier_abi::layout::clash::{arrival_day as AD, arrival_slot as AS, clash_inputs as CI};

    const HOME_P: i32 = 2;
    const B: u32 = 9;

    fn chain() -> (localnet::Chain, Addresses) {
        let mut c = localnet::Chain::new(localnet::Config::default());
        c.produce_block();
        (c, Addresses::new(Address::new_from_array(crate::expedition_play::PROGRAM), crate::expedition_play::SEASON_ID))
    }
    fn put(c: &mut localnet::Chain, a: &Addresses, k: Address, data: Vec<u8>) {
        c.set_account(k, fclient::ports::Account { lamports: 1_000_000, data, owner: a.program, executable: false }).unwrap();
    }
    fn inputs(c: &mut localnet::Chain, a: &Addresses, mask: u32) {
        let mut d = vec![0u8; CI::SIZE];
        d[..8].copy_from_slice(&CI::MAGIC);
        d[CI::ARRIVALS_MASK..CI::ARRIVALS_MASK + 4].copy_from_slice(&mask.to_le_bytes());
        put(c, a, a.clash_inputs(HOME_P, 0, B), d);
    }
    fn day_set(c: &mut localnet::Chain, a: &Addresses) {
        let mut d = vec![0u8; AD::SIZE];
        d[..8].copy_from_slice(&AD::MAGIC);
        let k = (B % fclient::abi::BELLS_PER_DAY) as usize;
        d[AD::BITS + k / 8] |= 1 << (k % 8);
        put(c, a, a.arrival_day(HOME_P, 0, frontier_abi::addr::day_of(B)), d);
    }
    fn arrival(c: &mut localnet::Chain, a: &Addresses, faction: u8, i: u8, host: u64) {
        let mut d = vec![0u8; AS::SIZE];
        d[..8].copy_from_slice(&AS::MAGIC);
        d[AS::HOST_ID..AS::HOST_ID + 8].copy_from_slice(&host.to_le_bytes());
        put(c, a, a.arrival_slot(HOME_P, 0, B, faction, i), d);
    }

    #[test]
    fn no_arrival_at_home_is_the_one_no_arrivals_part_as_before() {
        let (c, a) = chain();
        assert_eq!(home_gather_form(&c, &a, (HOME_P, 0), B), Some(GatherForm::NoArrivals));
    }

    #[test]
    fn a_march_arriving_at_home_is_gathered_over_its_real_slot_never_the_no_arrivals_form() {
        let (mut c, a) = chain();
        let host = fclient::addr::host_id(HOME_P, 0, 11, 2, 0).expect("a host id");
        day_set(&mut c, &a);
        arrival(&mut c, &a, 1, 0, host);
        match home_gather_form(&c, &a, (HOME_P, 0), B) {
            Some(GatherForm::Parts(parts)) => {
                let holding = a.holding_of_host(host).unwrap();
                assert!(parts.iter().any(|p| p.bitmap & (1 << 4) != 0 && p.holdings.contains(&holding)), "position 4 (faction 1, slot 0) with its Holding: {parts:?}");
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn partly_gathered_inputs_are_gathered_on_never_seeded_or_resolved() {
        let (mut c, a) = chain();
        let host = fclient::addr::host_id(HOME_P, 0, 11, 2, 0).expect("a host id");
        day_set(&mut c, &a);
        arrival(&mut c, &a, 1, 0, host);
        // the legacy driver landed its first part (positions 0..=9): the ClashInputs EXISTS, partly gathered
        inputs(&mut c, &a, 0x0000_03FF);
        match home_gather_form(&c, &a, (HOME_P, 0), B) {
            Some(GatherForm::Parts(parts)) => assert!(parts.iter().all(|p| p.start >= 10), "the next part, after the gathered positions: {parts:?}"),
            other => panic!("existing inputs are not a finished gather: {other:?}"),
        }
        // only once every position is gathered does the driver go on to the seed
        inputs(&mut c, &a, ALL_GATHERED);
        assert_eq!(home_gather_form(&c, &a, (HOME_P, 0), B), None);
    }

    #[test]
    fn the_driver_seeds_and_resolves_only_after_the_gather_form_is_none() {
        let src = include_str!("origin_driver.rs");
        let body = &src[src.find("async fn step_inner").unwrap()..src.find("/// The GatherClash still due for the home").unwrap()];
        let gather = body.find("match form {").unwrap();
        let seed = body.find("if !seed {").unwrap();
        assert!(gather < seed, "the gather decision comes before the seed");
        assert!(!body.contains("clash_inputs(p, q, b)).is_some()"), "the existence of the inputs is not taken as a finished gather");
    }
}
