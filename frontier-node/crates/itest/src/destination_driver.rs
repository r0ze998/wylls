//! **Local-play destination driver**: after the player's ExpeditionReveal
//! landed, drives the wide destination's REAL instructions, at most one
//! transaction per step, each landed on the node's own ticker:
//!
//! 0. **bounded catch-up**: a wide province resolves one bell at a time
//!    (`Resolve` needs `bell == resolved_next`, `OutOfOrder` otherwise), so
//!    the destination's bells from its `resolved_next` up to the arrival
//!    bell are resolved first, oldest first, with the same real
//!    instructions: `PostAnchor` of each ended bell in the destination
//!    region whose anchor is absent (a public Quicknet round verified
//!    against the pinned key; anchors that exist must pass the identity
//!    check), then per bell, once its window closed, `PostSeed` and a quiet
//!    `Resolve` (no ClashInputs and the ArrivalDay bit clear: the program
//!    resolves the residents alone). A bell before the arrival that HAS
//!    arrivals (a ClashInputs or its ArrivalDay bit) is gathered like the
//!    arrival bell; its settlement is not ours. More than
//!    [`MAX_CATCH_UP_BELLS`] bells behind stops the driver (reported, not
//!    driven); no state is written directly;
//! 1. wait for THE anchor of (arrival bell, destination region) — the
//!    keeper's destination anchors — and its reveal window to close;
//! 2. `ExpeditionGather` (version-2 dispatch, `Kind::Gather`) in
//!    packet-sized cursor batches until all 24 positions are scanned;
//! 3. `PostSeed` of (arrival bell, region, nonce 0) with the seed round's
//!    public Quicknet signature, verified against the pinned key;
//! 4. `Resolve` (the wide resolve) of the destination at the arrival bell;
//! 5. once `reveal_close + SETTLE_AFTER_CLOSE_SECS` has passed, the member
//!    settlement (`Kind::SettleMember`) of THIS transit when its resolved
//!    fate is one the program's member settlement accepts for a present
//!    final-set member (`stage_resolved_return`: Stays, Withdrew, Bounced,
//!    Retreated, Destroyed; the plan returns troops only for Bounced and
//!    Retreated, and none for Destroyed). A Stays that won the camp is the
//!    separate camp settlement (SettleCamp), and an absent row or no fate is
//!    not a member: both stop the driver with the fate named. A landed
//!    settlement is never reported here as an arrival success.
//!
//! The arrival is found and verified from public data only: the transit's
//! bridge record (program-owned, Settled or Gathered after SettleOrigin), the
//! LANDED Depart and Reveal transactions naming that transit (their wire
//! decoded through the version-2 dispatch parser), each checked against the
//! bridge's seal root (`seal_root(commit, ct_hash(seal))` and
//! `seal_root(commit(plain, salt), ct_hash)`), the plaintext's arrival bell
//! against the bridge's, the destination Province (program-owned, of this
//! world, at its canonical address) for the region, and the admitted
//! ArrivalSlot (this destination, bell, host and transit slot). Any mismatch
//! is an error and stops the driver; a refusal of the program (simulated
//! first, or landed) or an unknown outcome stops it for good (never resent).
//! Nothing is written directly, no fight or arrival is synthesized.
use fclient::addr::Addresses;
use fclient::ix::{post_seed, BeaconArg};
use fclient::{AccountMeta, Address, Instruction, Keypair, Signer};
use frontier_abi::addr::day_of;
use frontier_abi::world_index::{
    arrival::{
        self as wa, arrival_day_address, arrival_slot_address, WideArrival, WideClashInputsHdr,
    },
    expedition::AccountResolver,
    expedition_settlement_ix,
    expedition_transport::{ExpeditionArrivalSlot, OwnedBridgeTransit},
    land::{province_address, WideProvince},
    march::{transit_address, MarchState, WideTransit},
    ProvinceKey,
};
// (the tests' own names; the instructions are `keeper_core::expedition_steps`)
#[cfg(test)]
use frontier_abi::world_index::{
    arrival::clash_inputs_address,
    expedition_dispatch_ix::{self as dx, Kind},
    seal as wseal, wide_ix as wix, WideHostRef,
};
use localnet::server::{lock, Shared};
use localnet::Chain;

use crate::keeper_loop::{submit_and_wait, Sent};
use crate::local_keeper as lk;

/// The most destination bells the catch-up resolves before an arrival.
pub const MAX_CATCH_UP_BELLS: u32 = 144;
// The pure steps live in the keeper (`keeper_core::expedition_steps`, P13: keeper A's `expeditions` role sends the
// same instructions on devnet); this runner reads its in-process chain through them.
pub use keeper_core::expedition_steps::{
    check_end_bell, commands_in, ctx_of, depart_matches, next_position, open_departed, open_sealed,
    plan, resolve_ix, reveal_matches, self_reveal_ix, settle_decision, settle_member_ix,
    verify_evidence, Arrival, BellView, Evidence, Landed, Opened, Plan, Settle, POSITIONS,
    SETTLE_AFTER_CLOSE_SECS,
};

/// The landed (no error) Depart and Reveal of THIS transit among the
/// transactions naming its record (`expedition_steps::evidence_of` over the
/// chain's signatures for the transit record).
pub fn evidence(
    c: &Chain,
    program: &Address,
    season: &Address,
    holding: &Address,
    external: &Address,
    t: &WideTransit,
    slot: u8,
) -> Result<Evidence, String> {
    let landed: Vec<(Vec<u8>, fclient::vtx::LoadedAddresses)> = c
        .signatures_for(external, 256, None, None)
        .into_iter()
        .filter(|l| l.err.is_none())
        .map(|l| (l.wire.clone(), l.loaded.clone()))
        .collect();
    keeper_core::expedition_steps::evidence_of(
        landed.iter().map(|(w, l)| (w.as_slice(), l)),
        program,
        season,
        holding,
        external,
        t,
        slot,
    )
}

/// The revealed arrival of `holding`'s transit `slot`, verified; `None` when
/// the slot has no program record, is not past SettleOrigin (Departed, the
/// origin driver's), was destroyed at origin, or has no landed Reveal yet.
pub fn find_arrival(
    c: &Chain,
    a: &Addresses,
    holding: &Address,
    slot: u8,
) -> Result<Option<Arrival>, String> {
    let read = |k: &Address| c.account(k);
    let Some((external, t)) =
        keeper_core::expedition_steps::bridge_transit(&read, a, holding, slot)?
    else {
        return Ok(None);
    };
    if !matches!(t.state, MarchState::Settled | MarchState::Gathered) {
        return Ok(None);
    }
    let e = evidence(c, &a.program, &a.season, holding, &external, &t, slot)?;
    keeper_core::expedition_steps::arrival_of(&read, a, holding, slot, &e)
}

/// The accounts of one Gather position `k` (`expedition_steps::position_accounts` over this chain).
pub fn position_accounts(
    c: &Chain,
    a: &Addresses,
    dest: ProvinceKey,
    bell: u32,
    k: u8,
    filler: &Address,
) -> Result<[AccountMeta; 3], String> {
    keeper_core::expedition_steps::position_accounts(
        &|x: &Address| c.account(x),
        a,
        dest,
        bell,
        k,
        filler,
    )
}

/// The ExpeditionGather of `bell`'s positions `start..start + n` at the
/// arrival's destination (`expedition_steps::gather_ix` over this chain).
pub fn gather_ix(
    c: &Chain,
    a: &Addresses,
    payer: &Address,
    arr: &Arrival,
    bell: u32,
    start: u8,
    n: u8,
) -> Result<Instruction, String> {
    keeper_core::expedition_steps::gather_ix(
        &|x: &Address| c.account(x),
        a,
        payer,
        arr,
        bell,
        start,
        n,
    )
}

fn inputs_of(
    c: &Chain,
    a: &Addresses,
    arr: &Arrival,
    bell: u32,
) -> Result<Option<Vec<u8>>, String> {
    keeper_core::expedition_steps::inputs_at(&|x: &Address| c.account(x), a, arr, bell)
}

/// TEST-ONLY wide local world (`localnet-natural-play --wide-land`, wide-march-local): the catch-up bound in force.
/// [`MAX_CATCH_UP_BELLS`] everywhere else; the wide world sets [`WIDE_CATCH_UP_BELLS`] once at its start, because its
/// wide provinces are opened in the setup and nothing resolves them before the first march into one arrives.
pub static CATCH_UP_BELLS: std::sync::atomic::AtomicU32 =
    std::sync::atomic::AtomicU32::new(MAX_CATCH_UP_BELLS);
/// The wide world's bound: a whole 7-day Season of 10-minute turns.
pub const WIDE_CATCH_UP_BELLS: u32 = 1008;
/// TEST-ONLY wide local world: whether this runner reveals its villages' expeditions itself (off everywhere else,
/// where the player's page reveals). Any fee payer may send an ExpeditionReveal (`wide_ix::REVEAL`: only the fee
/// payer signs); the plaintext and salt come from the seal opened with the PUBLIC round `T(arrive)` (the salt is
/// `sha256("PS-SALT" ‖ k)` of the key the round opens), exactly what the program's settlement opens later.
pub static SELF_REVEAL: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
/// Turns the wide world's two switches on ([`CATCH_UP_BELLS`], [`SELF_REVEAL`]).
pub fn enable_wide_expeditions() {
    CATCH_UP_BELLS.store(WIDE_CATCH_UP_BELLS, std::sync::atomic::Ordering::SeqCst);
    SELF_REVEAL.store(true, std::sync::atomic::Ordering::SeqCst);
}
fn catch_up_bells() -> u32 {
    CATCH_UP_BELLS.load(std::sync::atomic::Ordering::SeqCst)
}

/// The widest Gather batch from `start` that fits the packet (at least one).
pub fn gather_batch(
    c: &Chain,
    a: &Addresses,
    payer: &Keypair,
    arr: &Arrival,
    bell: u32,
    start: u8,
) -> Result<Instruction, String> {
    let mut best = None;
    for n in 1..=(POSITIONS - start) {
        let ix = gather_ix(c, a, &payer.pubkey(), arr, bell, start, n)?;
        if lk::encoded_len(std::slice::from_ref(&ix), payer)? > lk::PACKET_BYTES {
            break;
        }
        best = Some(ix);
    }
    best.ok_or_else(|| format!("no Gather batch from position {start} fits the packet"))
}

/// Which resolve a destination bell takes, from the destination's conquest
/// state (pure; the same choice as `resident_bells::plan`): no conquest table
/// and no site record → the plain wide Resolve; a live program-owned conquest
/// table → ResolveWithConquest (kind 13), conquest runner only (a plain Resolve
/// cannot pass a live table); site records without a table → not provable.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ResolveChoice {
    Plain,
    WithConquest,
    /// Nothing sent: the reason is the caller's `Stopped`.
    Refused(&'static str),
}

pub fn resolve_choice(conquest: crate::resident_bells::Conquest) -> ResolveChoice {
    use crate::resident_bells::Conquest;
    match conquest {
        Conquest::None => ResolveChoice::Plain,
        Conquest::Table if cfg!(feature = "localnet-conquest-play") => ResolveChoice::WithConquest,
        Conquest::Table => ResolveChoice::Refused("a conquest table is live; this runner has no ResolveWithConquest (plain Resolve not sent)"),
        Conquest::Unprovable => ResolveChoice::Refused("site records are set without a conquest table: not provable, nothing sent"),
    }
}

/// The bell's resolve instruction by [`resolve_choice`] over the destination's
/// current state (read under the caller's lock, identity-checked).
pub fn resolve_for(
    c: &Chain,
    a: &Addresses,
    payer: &Address,
    arr: &Arrival,
    bell: u32,
) -> Result<(Instruction, &'static str), String> {
    let pd = c
        .account(&arr.dest_key)
        .ok_or("the destination Province is absent")?;
    if pd.owner != a.program {
        return Err("the destination Province is not the program's".into());
    }
    match resolve_choice(crate::resident_bells::conquest_of(
        c, a, arr.dest, &pd.data,
    )?) {
        ResolveChoice::Plain => Ok((resolve_ix(a, payer, arr, bell), "Resolve")),
        #[cfg(feature = "localnet-conquest-play")]
        ResolveChoice::WithConquest => Ok((
            crate::conquest_crank::resolve_with_conquest_ix(
                a,
                payer,
                arr.dest,
                &arr.dest_key,
                arr.region,
                bell,
            )?,
            "ResolveWithConquest",
        )),
        #[cfg(not(feature = "localnet-conquest-play"))]
        ResolveChoice::WithConquest => {
            Err("ResolveWithConquest chosen without the conquest runner".into())
        }
        ResolveChoice::Refused(w) => Err(format!("bell {bell}: {w}")),
    }
}

/// What the destination needs next for `arr` (pure over the chain).
///
/// Identity: `arr` must come from [`find_arrival`] read under the SAME chain
/// lock (the driver does so): that call authenticated the destination
/// Province (program-owned, canonical address, this world, coordinate and
/// season) and the ArrivalSlot; here the Province is re-read only for its
/// owner and `resolved_next`, every anchor through `anchor_landed`'s
/// identity check, the ArrivalDay and ClashInputs by owner, season,
/// destination and day/bell. A caller passing an `Arrival` from elsewhere
/// gets none of the Province checks.
///
/// Season boundary: an arrival at or past the Season's `end_bell` is refused
/// here, before any round is fetched or anchor posted (never left to the
/// program's later `WrongStatus`).
pub fn bell_view(
    c: &Chain,
    a: &Addresses,
    arr: &Arrival,
    now_bell: u32,
) -> Result<BellView, String> {
    let ctx = ctx_of(a);
    use frontier_abi::v2::layout::world::season as S;
    let sacc = c.account(&a.season).ok_or("no Season")?;
    if sacc.owner != a.program {
        return Err("the Season is not the program's".into());
    }
    let end_bell = u32::from_le_bytes(
        sacc.data
            .get(S::END_BELL..S::END_BELL + 4)
            .ok_or("season bytes")?
            .try_into()
            .unwrap(),
    );
    check_end_bell(arr.arrive, end_bell)?;
    let pacc = c
        .account(&arr.dest_key)
        .ok_or("the destination Province is absent")?;
    if pacc.owner != a.program {
        return Err("the destination Province is not the program's".into());
    }
    use frontier_abi::v2::layout::province::province as PV;
    let rn = u32::from_le_bytes(
        pacc.data
            .get(PV::RESOLVED_NEXT..PV::RESOLVED_NEXT + 4)
            .ok_or("province bytes")?
            .try_into()
            .unwrap(),
    );
    if rn > arr.arrive {
        // already resolved past the arrival: only the settlement remains
        return Ok(BellView {
            resolved_next: rn,
            bell: arr.arrive,
            anchor: lk::anchor_landed(c, a, arr.arrive, arr.region)?,
            inputs: inputs_of(c, a, arr, arr.arrive)?,
            arrivals: true,
            seed: true,
            missing_anchor: None,
        });
    }
    let max = catch_up_bells();
    if arr.arrive - rn > max {
        return Err(format!("the destination is {} bells behind the arrival (resolved_next {rn}); a catch-up beyond {max} bells is not driven", arr.arrive - rn));
    }
    let mut missing_anchor = None;
    for b in rn..=arr.arrive.min(now_bell.saturating_sub(1)) {
        if lk::anchor_landed(c, a, b, arr.region)?.is_none() {
            missing_anchor = Some(b);
            break;
        }
    }
    let day_key = Address::new_from_array(arrival_day_address(&ctx, arr.dest, day_of(rn)));
    let arrivals = match c.account(&day_key) {
        None => false,
        Some(d) if d.owner == a.program => {
            let rec =
                wa::WideArrivalDay::read(&d.data).map_err(|e| format!("ArrivalDay: {e:?}"))?;
            if rec.season_id != a.season_id || rec.dest != arr.dest || rec.day != day_of(rn) {
                return Err("the ArrivalDay is not this destination's day".into());
            }
            rec.has(rn)
        }
        Some(_) => return Err("the ArrivalDay is not the program's".into()),
    };
    Ok(BellView {
        resolved_next: rn,
        bell: rn,
        anchor: lk::anchor_landed(c, a, rn, arr.region)?,
        inputs: inputs_of(c, a, arr, rn)?,
        arrivals,
        seed: c.account(&a.seed_cache(rn, arr.region, 0)).is_some(),
        missing_anchor,
    })
}

/// The member settlement refuses ANY executable account among its roles
/// (`wide_expedition_settlement::snapshots`: `BadAccount`), e.g. a zero
/// `RENT_PAYER` naming the System Program: named here before anything is
/// simulated or sent (a stop, never a send).
pub fn executable_role(c: &Chain, ix: &Instruction) -> Option<(usize, Address)> {
    ix.accounts
        .iter()
        .enumerate()
        .find(|(_, m)| c.account(&m.pubkey).is_some_and(|x| x.executable))
        .map(|(i, m)| (i, m.pubkey))
}

/// One step's outcome.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Step {
    Landed(String, String),
    Wait(String),
    /// This arrival's member settlement has landed (or was already done),
    /// with the arrival's resolved `fate` (the program's row): a completed
    /// settlement is NOT an arrival or occupation success unless the fate is
    /// Stays ([`Step::arrival_stays`]).
    Settled {
        fate: u8,
    },
    Unknown {
        signature: String,
        why: String,
    },
    Stopped(String),
}

impl Step {
    /// Whether this is a completed settlement of an arrival that STAYS in the
    /// destination (the only fate after which the host is resident there and
    /// a declaration may be considered). Destroyed, Withdrew, Bounced,
    /// Retreated or any other step: false.
    pub fn arrival_stays(&self) -> bool {
        matches!(self, Step::Settled { fate } if *fate == wa::wide_arrival::FATE_STAYS)
    }
}

pub struct DestinationDriver {
    pub a: Addresses,
    holding: Address,
    payer: Keypair,
    stop: tokio::sync::watch::Receiver<bool>,
    pub land_timeout: std::time::Duration,
    terminal: Option<Step>,
    last: Option<Step>,
    pub log: Vec<String>,
    /// [`SELF_REVEAL`]: transits (slot, seal root) found not revealable (never tried again).
    unrevealable: Vec<(u8, [u8; 32])>,
    /// [`SELF_REVEAL`]: why the last of `unrevealable` was given up (kept in every later Wait, fix-wide-breaks BREAK-2).
    pub never_revealed: Option<String>,
    /// [`SELF_REVEAL`]: verified public signatures by round.
    rounds: std::collections::BTreeMap<u64, [u8; 48]>,
    /// A rim village's driver beside its legacy march driver (TEST-ONLY wide world): it reports in its own status field.
    pub beside_legacy: bool,
}

impl DestinationDriver {
    pub fn new(
        holding: Address,
        payer: Keypair,
        stop: tokio::sync::watch::Receiver<bool>,
    ) -> DestinationDriver {
        DestinationDriver {
            a: Addresses::new(
                Address::new_from_array(crate::expedition_play::PROGRAM),
                crate::expedition_play::SEASON_ID,
            ),
            holding,
            payer,
            stop,
            land_timeout: crate::keeper_loop::LAND_TIMEOUT,
            terminal: None,
            last: None,
            log: vec![],
            unrevealable: vec![],
            never_revealed: None,
            rounds: Default::default(),
            beside_legacy: false,
        }
    }

    pub fn terminal(&self) -> Option<&Step> {
        self.terminal.as_ref()
    }

    /// The last step taken (e.g. `Settled { fate }`), for readers that must
    /// tell a staying arrival from a settled defeat.
    pub fn last_step(&self) -> Option<&Step> {
        self.last.as_ref()
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
        self.last = Some(s.clone());
        s
    }

    async fn send(&mut self, state: &Shared, ix: Instruction, what: String) -> Step {
        if *self.stop.borrow() {
            return Step::Stopped("stopped by request".into());
        }
        let sim = lk::simulate_ix(&lock(state), &self.payer, &ix);
        match sim {
            Ok(s) if s.err.is_none() => {}
            Ok(s) => {
                return Step::Stopped(format!(
                    "{what} simulation: {:?} (code {:?})",
                    s.err, s.code
                ))
            }
            Err(e) => return Step::Stopped(e),
        }
        let step = match submit_and_wait(
            state,
            &self.payer,
            ix,
            &what,
            self.land_timeout,
            &mut self.stop,
        )
        .await
        {
            Sent::Landed(sig) => Step::Landed(what, sig),
            Sent::Failed(e) => Step::Stopped(e),
            Sent::Unknown { signature, why } => Step::Unknown { signature, why },
        };
        self.log.push(format!("{step:?}"));
        step
    }

    /// TEST-ONLY wide world ([`SELF_REVEAL`], verify-pr96 BREAK-1): ONLY the due self-reveal of the watched holding's
    /// expedition, or `None` (nothing due, the switch off, or the driver already ended). The keeper loop calls it for
    /// every village at the START of each pass, before any keeper posts THE anchor of the bell that just ended: a pass
    /// of a many-village wide world is longer than a reveal window (A + W, 600 chain seconds — about 25 slots), so a
    /// reveal left to the village's own turn in the pass could still find the window closed. Ends the driver as `step`
    /// does on an Unknown or a Stop.
    pub async fn reveal_only(&mut self, state: &Shared) -> Option<Step> {
        if self.terminal.is_some() || !SELF_REVEAL.load(std::sync::atomic::Ordering::SeqCst) {
            return None;
        }
        let s = self.self_reveal(state).await?;
        if matches!(s, Step::Unknown { .. } | Step::Stopped(_)) {
            self.terminal = Some(s.clone());
        }
        self.last = Some(s.clone());
        Some(s)
    }

    async fn step_inner(&mut self, state: &Shared) -> Step {
        if SELF_REVEAL.load(std::sync::atomic::Ordering::SeqCst) {
            if let Some(s) = self.self_reveal(state).await {
                return s;
            }
        }
        let me = self.payer.pubkey();
        let read = {
            let c = lock(state);
            (|| -> Result<Option<(Arrival, fclient::clock::SeasonClock, i64, BellView)>, String> {
                let mut found = None;
                for slot in 0..4u8 {
                    if let Some(arr) = find_arrival(&c, &self.a, &self.holding, slot)? {
                        found = Some(arr);
                        break;
                    }
                }
                let Some(arr) = found else { return Ok(None) };
                let clock = lk::season_clock(&c, &self.a)?;
                let now = c.unix_timestamp();
                let now_bell = clock
                    .bell_at(now)
                    .ok_or("the chain's time is before the season")?;
                let v = bell_view(&c, &self.a, &arr, now_bell)?;
                Ok(Some((arr, clock, now, v)))
            })()
        };
        let (arr, clock, now, v) = match read {
            Ok(Some(x)) => x,
            Ok(None) => {
                return Step::Wait(match &self.never_revealed {
                    // (an expedition given up unrevealed: the program has no settlement for a never-revealed bridge
                    //  transit, so its host stays held; the line says why, every pass)
                    Some(why) => {
                        format!("no revealed arrival of the watched holding; never revealed: {why}")
                    }
                    None => "no revealed arrival of the watched holding".into(),
                });
            }
            Err(e) => return Step::Stopped(e),
        };
        let window_closed = v
            .anchor
            .is_some_and(|a_ts| now >= clock.reveal_close(v.bell, a_ts));
        let next = match plan(&arr, &v, window_closed) {
            Ok(p) => p,
            Err(e) => return Step::Stopped(e),
        };
        match next {
            Plan::Anchor(b) => {
                let fetched = tokio::select! {
                    r = lk::fetch_rounds(&clock, b..b + 1) => r,
                    _ = crate::keeper_loop::stopped(&mut self.stop) => return Step::Stopped("stopped by request".into()),
                };
                let r = match fetched {
                    Ok(rs) => match rs
                        .into_iter()
                        .find(|r| r.bell == b && r.round == clock.tlock_round(b))
                    {
                        Some(r) => r,
                        None => return Step::Wait(format!("round of bell {b} not served")),
                    },
                    Err(e) => return Step::Wait(format!("round of bell {b}: {e}")),
                };
                return match lk::post_anchor_ix(&self.a, &me, arr.region, &r) {
                    Ok(ix) => {
                        self.send(
                            state,
                            ix,
                            format!("PostAnchor(bell {b}, region {})", arr.region),
                        )
                        .await
                    }
                    Err(e) => Step::Stopped(e),
                };
            }
            Plan::WaitEnded(b) => return Step::Wait(format!("bell {b} has not ended")),
            Plan::WaitWindow(b) => {
                return Step::Wait(format!("the reveal window of bell {b} is open"))
            }
            Plan::Gather { bell, start } => {
                let ix = {
                    let c = lock(state);
                    gather_batch(&c, &self.a, &self.payer, &arr, bell, start)
                };
                return match ix {
                    Ok(ix) => {
                        self.send(
                            state,
                            ix,
                            format!("ExpeditionGather(bell {bell}, from {start})"),
                        )
                        .await
                    }
                    Err(e) => Step::Stopped(e),
                };
            }
            Plan::Seed(b) => {
                let a_ts = v.anchor.expect("planned with an anchor");
                let round = clock.seed_round(b, a_ts);
                if clock.drand.round_time(round) > now {
                    return Step::Wait(format!(
                        "the seed round {round} of bell {b} is not due yet"
                    ));
                }
                let fetched = tokio::select! {
                    r = lk::fetch_round_at(round) => r,
                    _ = crate::keeper_loop::stopped(&mut self.stop) => return Step::Stopped("stopped by request".into()),
                };
                let sig48 = match fetched {
                    Ok(s) => s,
                    Err(e) => return Step::Wait(format!("seed round {round}: {e}")),
                };
                let arg = BeaconArg {
                    round,
                    sig48,
                    hints: fclient::beacon::hints_bytes(round),
                };
                let ix = post_seed(&self.a, me, arr.region, b, 0, &arg, &me);
                return self
                    .send(
                        state,
                        ix,
                        format!("PostSeed(bell {b}, region {}, round {round})", arr.region),
                    )
                    .await;
            }
            Plan::Resolve { bell, quiet } => {
                // plain Resolve, or ResolveWithConquest under a live conquest table
                // (resolve_choice); anything unprovable stops, nothing sent
                let built = {
                    let c = lock(state);
                    resolve_for(&c, &self.a, &me, &arr, bell)
                };
                let (ix, name) = match built {
                    Ok(x) => x,
                    Err(e) => return Step::Stopped(e),
                };
                let what = if quiet {
                    format!("{name}(quiet bell {bell})")
                } else {
                    format!("{name}(bell {bell})")
                };
                return self.send(state, ix, what).await;
            }
            Plan::Settle => {}
        }
        // 5. the arrival bell is resolved: the member settlement of THIS arrival
        let Some(a_ts) = v.anchor else {
            return Step::Stopped("the arrival bell resolved without its anchor".into());
        };
        let close = clock.reveal_close(arr.arrive, a_ts);
        let Some(inputs) = v.inputs else {
            return Step::Stopped("the arrival bell resolved without its ClashInputs".into());
        };
        let h = match WideClashInputsHdr::read(&inputs) {
            Ok(h) => h,
            Err(e) => return Step::Stopped(format!("ClashInputs: {e:?}")),
        };
        let row = match WideArrival::read_at(&inputs, arr.position as usize) {
            Ok(r) => r,
            Err(e) => return Step::Stopped(format!("arrival row {}: {e:?}", arr.position)),
        };
        if let Some(r) = &row {
            if r.host != arr.host {
                return Step::Stopped("the resolved row is not this arrival's host".into());
            }
        }
        let fate = row.as_ref().map_or(wa::wide_arrival::FATE_NONE, |r| r.fate);
        match settle_decision(&h, row.as_ref(), arr.position, now, close + SETTLE_AFTER_CLOSE_SECS) {
            Settle::Done => Step::Settled { fate },
            Settle::Wait(w) => Step::Wait(w),
            Settle::Unsupported(f) => Step::Stopped(format!("resolved fate {f}: its terminal settlement is not driven here (not settled, not reported as an arrival success)")),
            Settle::Member => {
                let built = {
                    let c = lock(state);
                    (|| -> Result<Instruction, String> {
                        let ctx = ctx_of(&self.a);
                        let t = OwnedBridgeTransit::from_bytes(&ctx, &c.account(&arr.external).ok_or("no transit")?.data).map_err(|e| format!("{e:?}"))?.transit();
                        let sd = ExpeditionArrivalSlot::read(&ctx, &c.account(&arr.slot).ok_or("no slot")?.data).map_err(|e| format!("{e:?}"))?;
                        let hd = c.account(&self.holding).ok_or("no holding")?.data;
                        use frontier_abi::v2::layout::player::holding as H;
                        let rent_payer: [u8; 32] = hd.get(H::RENT_PAYER..H::RENT_PAYER + 32).ok_or("holding bytes")?.try_into().unwrap();
                        let home = Address::new_from_array(AccountResolver::for_season(&ctx).map_err(|e| format!("{e:?}"))?
                            .province_address(arr.host.key()).map_err(|e| format!("{e:?}"))?);
                        let ix = settle_member_ix(&self.a, &me, &arr, &self.holding, &home, &Address::new_from_array(t.rent_to),
                            &Address::new_from_array(sd.common().beneficiary), &Address::new_from_array(h.resolver), &Address::new_from_array(rent_payer))?;
                        if let Some((i, k)) = executable_role(&c, &ix) {
                            let role = expedition_settlement_ix::AccountLayout::Current.spec(i).map_or("?", |s| s.name);
                            return Err(format!("SettleMember role {i} ({role}) is the executable account {k}; the program refuses executable roles (not sent)"));
                        }
                        Ok(ix)
                    })()
                };
                match built {
                    Ok(ix) => match self.send(state, ix, format!("SettleMember(transit {})", arr.transit_slot)).await {
                        Step::Landed(..) => Step::Settled { fate },
                        other => other,
                    },
                    Err(e) => Step::Stopped(e),
                }
            }
        }
    }
}

impl DestinationDriver {
    /// TEST-ONLY wide world ([`SELF_REVEAL`]): the reveal of a departed, origin-settled expedition of the watched
    /// holding that has no landed Reveal yet, as soon as its arrival turn ended and `T(arrive)` is public — BEFORE THE
    /// anchor of `(arrive, destination region)` exists too (the program admits that; fix-wide-breaks BREAK-2), and
    /// while that anchor's window is open once it exists. `None` = nothing of ours to reveal (the ordinary steps
    /// follow). A window that closed unrevealed is reported, never forced; the program has no settlement of a
    /// never-revealed bridge transit, so its host stays held (`never_revealed` says why in every later step).
    async fn self_reveal(&mut self, state: &Shared) -> Option<Step> {
        let ctx = ctx_of(&self.a);
        let due = {
            let c = lock(state);
            let clock = match lk::season_clock(&c, &self.a) {
                Ok(x) => x,
                Err(e) => return Some(Step::Stopped(e)),
            };
            let now = c.unix_timestamp();
            let now_bell = clock.bell_at(now)?;
            let mut found = None;
            for slot in 0..4u8 {
                let external =
                    Address::new_from_array(transit_address(&ctx, &self.holding.to_bytes(), slot));
                let Some(acc) = c.account(&external).filter(|x| x.owner == self.a.program) else {
                    continue;
                };
                let Ok(b) = OwnedBridgeTransit::from_bytes(&ctx, &acc.data) else {
                    continue;
                };
                let t = b.transit();
                if t.state != MarchState::Settled
                    || t.arrive_bell >= now_bell
                    || self.unrevealable.contains(&(slot, t.seal_root))
                {
                    continue;
                }
                let e = match evidence(
                    &c,
                    &self.a.program,
                    &self.a.season,
                    &self.holding,
                    &external,
                    &t,
                    slot,
                ) {
                    Ok(e) => e,
                    Err(e) => return Some(Step::Stopped(e)),
                };
                if let (Some(d), None) = (e.depart, e.reveal) {
                    found = Some((slot, t, d, clock));
                    break;
                }
            }
            found
        };
        let (slot, t, d, clock) = due?;
        let round = clock.tlock_round(t.arrive_bell);
        let sig48 = match self.rounds.get(&round) {
            Some(s) => *s,
            None => {
                let fetched = tokio::select! {
                    r = lk::fetch_round_at(round) => r,
                    _ = crate::keeper_loop::stopped(&mut self.stop) => return Some(Step::Stopped("stopped by request".into())),
                };
                match fetched {
                    Ok(s) => {
                        self.rounds.insert(round, s);
                        s
                    }
                    Err(e) => {
                        return Some(Step::Wait(format!(
                            "round {round} of the arrival bell: {e}"
                        )))
                    }
                }
            }
        };
        let o = match open_departed(&t, &d, slot, &sig48) {
            Ok(o) => o,
            Err(e) => {
                // (a seal that does not open validly is the settlement's to judge: not revealed, never retried)
                self.unrevealable.push((slot, t.seal_root));
                self.log
                    .push(format!("transit {slot}: not revealable: {e}"));
                let why: String = format!("transit {slot}: not revealable: {e}");
                self.never_revealed = Some(why.clone());
                return Some(Step::Wait(why));
            }
        };
        let (ix, what) = {
            let c = lock(state);
            let dest_key = Address::new_from_array(province_address(&ctx, o.dest.coord()));
            let Some(pacc) = c.account(&dest_key).filter(|x| x.owner == self.a.program) else {
                self.unrevealable.push((slot, t.seal_root));
                let why: String = format!("transit {slot}: its destination province is not open");
                self.never_revealed = Some(why.clone());
                return Some(Step::Wait(why));
            };
            let prov = match WideProvince::read(&pacc.data) {
                Ok(p) => p,
                Err(e) => return Some(Step::Stopped(format!("destination Province: {e:?}"))),
            };
            let anchor = match lk::anchor_landed(&c, &self.a, o.arrive, prov.region) {
                Ok(x) => x,
                Err(e) => return Some(Step::Stopped(e)),
            };
            // (fix-wide-breaks BREAK-2: the reveal is NOT held for THE anchor. The program admits a reveal before the
            //  anchor exists (wide_expedition_reveal: an absent anchor and archive are no refusal) and its window closes
            //  only at A + W. Waiting for the anchor first left a ×60 world's 600-chain-second window — ten wall
            //  seconds — to the pace of a whole keeper pass over every village: a pass that ran past it marked the
            //  expedition unrevealable, and its host was held for good (the program has no settlement of a
            //  never-revealed bridge transit). Revealing as soon as T(arrive) is public removes that race.)
            if let Some(a_ts) =
                anchor.filter(|a_ts| c.unix_timestamp() >= clock.reveal_close(o.arrive, *a_ts))
            {
                self.unrevealable.push((slot, t.seal_root));
                let why: String = format!(
                    "transit {slot}: the reveal window of bell {} closed unrevealed (anchor at {a_ts}, closed at {}, first seen at {})",
                    o.arrive,
                    clock.reveal_close(o.arrive, a_ts),
                    c.unix_timestamp()
                );
                self.log.push(why.clone());
                self.never_revealed = Some(why.clone());
                return Some(Step::Wait(why));
            }
            let target = (0..4u8).find(|i| {
                c.account(&Address::new_from_array(arrival_slot_address(
                    &ctx, o.dest, o.arrive, o.faction, *i,
                )))
                .is_none()
            });
            let Some(target) = target else {
                self.unrevealable.push((slot, t.seal_root));
                let why: String = format!(
                    "transit {slot}: the nation's four arrival slots of bell {} are taken",
                    o.arrive
                );
                self.never_revealed = Some(why.clone());
                return Some(Step::Wait(why));
            };
            match self_reveal_ix(
                &ctx,
                &self.payer.pubkey(),
                &self.holding,
                &o,
                prov.region,
                target,
            ) {
                Ok(ix) => (
                    ix,
                    format!(
                        "ExpeditionReveal(transit {slot} → ({}, {}) bell {} slot {target})",
                        o.dest.coord().p(),
                        o.dest.coord().q(),
                        o.arrive
                    ),
                ),
                Err(e) => return Some(Step::Stopped(e)),
            }
        };
        // (a refusal of the reveal — a path the program does not accept, an arrival too early for the route — is the
        //  settlement's to judge: simulated first, never sent, never tried again, and the driver goes on)
        let sim = lk::simulate_ix(&lock(state), &self.payer, &ix);
        match sim {
            Ok(x) if x.err.is_none() => {}
            Ok(x) => {
                self.unrevealable.push((slot, t.seal_root));
                let why = format!(
                    "{what} refused in simulation: {:?} (code {:?}); left to the settlement",
                    x.err, x.code
                );
                self.log.push(why.clone());
                self.never_revealed = Some(why.clone());
                return Some(Step::Wait(why));
            }
            Err(e) => return Some(Step::Wait(format!("{what} simulation: {e}"))),
        }
        Some(self.send(state, ix, what).await)
    }
}

/// TEST ONLY helper: the 24-position mask with positions `..k` scanned.
#[cfg(test)]
pub(crate) fn mask_through(k: u8) -> u32 {
    if k >= 32 {
        u32::MAX
    } else {
        (1u32 << k) - 1
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// PURE (a past, PUBLISHED Quicknet round and its real signature, `fclient/fixtures/tlock/q4-vector.json`: cryptographic
    /// consistency only): a sealed wide march from a rim tile into ring 129 opens from the public signature alone to
    /// exactly the plaintext and salt the sealer kept, its commitment is the Depart's, and the walk lists the provinces
    /// entered other than the destination; a wrong signature, a tampered seal or another host is refused.
    #[test]
    fn a_sealed_wide_march_opens_from_the_public_round_alone() {
        use frontier_abi::world_index::{seal::WidePlain, TileAddress, WideCoord, WorldId};
        let v: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(fclient::seal::fixture_dir().join("q4-vector.json")).unwrap(),
        )
        .unwrap();
        let round = v["round"].as_u64().unwrap();
        let sig: [u8; 48] = hex::decode(v["sig"].as_str().unwrap())
            .unwrap()
            .try_into()
            .unwrap();
        let world = WorldId::new([0x77; 32]).unwrap();
        let home = ProvinceKey::new(world, WideCoord::checked(128, 0).unwrap());
        let host = WideHostRef::new(home, 3, 0, 7).unwrap();
        // (from tile 0 of (128, 0) the walk eastward leaves the rim; find the first step count that enters ring 129)
        let origin = TileAddress::new(home, 0).unwrap();
        let mut dirs = vec![];
        let mut at = frontier_abi::world_index::tiles::WideTile::of(origin);
        while at.province().coord().ring() < 129 {
            dirs.push(0u8);
            at = at.neighbors()[0].unwrap();
        }
        let (path_len, path) = permutation_rules::frontier::seal::encode_path(&dirs).unwrap();
        let arrive = 40;
        let plain = WidePlain {
            version: frontier_abi::world_index::seal::WIDE_PLAIN_VERSION,
            host,
            arrive_bell: arrive,
            dest: at.province(),
            dest_tile: at.local(),
            stance: 0,
            retreat_bps: 0,
            path_len,
            path,
            reserved: [0; frontier_abi::world_index::seal::WIDE_RESERVED_BYTES],
        };
        let sealed = fclient::wide_seal::seal_wide(
            &plain,
            &host,
            arrive,
            &fclient::beacon::quicknet_info().public_key,
            round,
        )
        .unwrap();
        let d = wix::ExpeditionDepart {
            host: host.to_bytes(),
            transit_slot: 1,
            arrive_bell: arrive,
            tip: 0,
            commit: sealed.commit,
            seal: sealed.seal,
        };
        let o = open_sealed(origin, &host, 2, arrive, &d, 1, &sig).unwrap();
        assert_eq!(&o.plain, sealed.reveal.plain());
        assert_eq!(&o.salt, sealed.reveal.salt());
        assert_eq!(wseal::commit(&o.plain, &o.salt), d.commit);
        assert_eq!(o.ct_hash, sealed.ct_hash);
        assert_eq!(
            (o.dest, o.faction, o.arrive, o.slot),
            (at.province(), 2, arrive, 1)
        );
        assert!(
            o.path.iter().all(|k| *k != o.dest),
            "the destination is not a path province"
        );
        assert!(
            o.path.len() <= 1,
            "only the origin province can be entered before the destination: {:?}",
            o.path
        );
        // refusals
        let mut bad = sig;
        bad[5] ^= 1;
        assert!(
            open_sealed(origin, &host, 2, arrive, &d, 1, &bad).is_err(),
            "another signature"
        );
        let mut t = d;
        t.seal[200] ^= 1;
        assert!(
            open_sealed(origin, &host, 2, arrive, &t, 1, &sig).is_err(),
            "a tampered body"
        );
        let other = WideHostRef::new(home, 4, 0, 7).unwrap();
        assert!(
            open_sealed(origin, &other, 2, arrive, &d, 1, &sig).is_err(),
            "another host"
        );
        assert!(
            open_sealed(origin, &host, 2, arrive + 1, &d, 1, &sig).is_err(),
            "another arrival bell"
        );
    }

    /// PURE: the destination driver's resolve (catch-up bells and the arrival
    /// bell, after its Gather) follows the destination's conquest state exactly
    /// as the resident bells do: a live table takes ResolveWithConquest on the
    /// conquest runner and is refused otherwise; unprovable records are refused;
    /// no table keeps the plain Resolve (unchanged).
    #[test]
    fn the_resolve_follows_the_destinations_conquest_state() {
        use crate::resident_bells::Conquest;
        assert_eq!(resolve_choice(Conquest::None), ResolveChoice::Plain);
        #[cfg(feature = "localnet-conquest-play")]
        assert_eq!(resolve_choice(Conquest::Table), ResolveChoice::WithConquest);
        #[cfg(not(feature = "localnet-conquest-play"))]
        assert!(matches!(
            resolve_choice(Conquest::Table),
            ResolveChoice::Refused(_)
        ));
        assert!(matches!(
            resolve_choice(Conquest::Unprovable),
            ResolveChoice::Refused(_)
        ));
    }
    use crate::expedition_play::{PROGRAM, SEASON_ID};
    use frontier_abi::world_index::{
        seal::WidePlain, TileAddress, WideCoord, HOST_IDENTITY_FULL_REF_V1,
    };

    fn addrs() -> Addresses {
        Addresses::new(Address::new_from_array(PROGRAM), SEASON_ID)
    }

    /// A real wide seal of a plaintext to (129, 0) and the transit it would
    /// make (the same codecs the program uses; fixed public test values).
    fn sealed_transit() -> (WideTransit, wix::ExpeditionDepart, wix::ExpeditionReveal) {
        use permutation_rules::frontier::{
            doctrine::of_faction_v3,
            stance::{Posture, Stance},
            travel::{march_stamina, MAX_PATH_STEPS},
        };
        let a = addrs();
        let ctx = ctx_of(&a);
        let r = AccountResolver::for_season(&ctx).unwrap();
        let host = r
            .legacy_host_ref(frontier_abi::addr::host_id(128, 0, 1, 2, 0).unwrap())
            .unwrap();
        let arrive = 20;
        let (path_len, path) = permutation_rules::frontier::seal::encode_path(&[0]).unwrap();
        let plain = WidePlain {
            version: wseal::WIDE_PLAIN_VERSION,
            host,
            arrive_bell: arrive,
            dest: ProvinceKey::new(host.key().world(), WideCoord::checked(129, 0).unwrap()),
            dest_tile: 30,
            stance: 0,
            retreat_bps: 0,
            path_len,
            path,
            reserved: [0; wseal::WIDE_RESERVED_BYTES],
        };
        let qn = fclient::beacon::quicknet_info();
        let s = fclient::wide_seal::seal_wide(&plain, &host, arrive, &qn.public_key, 1_000_000)
            .unwrap();
        let doctrine = of_faction_v3(2).unwrap();
        let t = WideTransit::depart(
            HOST_IDENTITY_FULL_REF_V1,
            host,
            doctrine.unit as u8,
            2,
            TileAddress::new(host.key(), 3).unwrap(),
            arrive - 5,
            arrive,
            600,
            100_000,
            march_stamina(MAX_PATH_STEPS as u32),
            doctrine.dealt_bps(Posture::Stance(Stance::Hold), true) as u16,
            s.seal_root,
            0,
            0,
            [22; 32],
        )
        .unwrap();
        let d = wix::ExpeditionDepart {
            host: host.to_bytes(),
            transit_slot: 0,
            arrive_bell: arrive,
            tip: 0,
            commit: s.commit,
            seal: s.seal,
        };
        let rv = wix::ExpeditionReveal {
            transit_slot: 0,
            target_i: 1,
            plain: *s.reveal.plain(),
            salt: *s.reveal.salt(),
            ct_hash: s.ct_hash,
            beneficiary: [7; 32],
        };
        (t, d, rv)
    }

    #[test]
    fn the_arrival_is_proven_by_both_landed_commands_against_the_seal_root() {
        let (t, d, r) = sealed_transit();
        let ok = Evidence {
            depart: Some(d),
            reveal: Some(r),
        };
        let (dest, target, commit, seal) = verify_evidence(&t, &ok).unwrap();
        assert_eq!(((dest.coord().p(), dest.coord().q())), (129, 0));
        assert_eq!((target, commit, seal), (1, d.commit, d.seal));
        assert!(
            verify_evidence(
                &t,
                &Evidence {
                    depart: Some(d),
                    reveal: None
                }
            )
            .is_err(),
            "no Reveal"
        );
        assert!(
            verify_evidence(
                &t,
                &Evidence {
                    depart: None,
                    reveal: Some(r)
                }
            )
            .is_err(),
            "no Depart"
        );
        let bad_salt = wix::ExpeditionReveal { salt: [1; 32], ..r };
        assert!(verify_evidence(
            &t,
            &Evidence {
                depart: Some(d),
                reveal: Some(bad_salt)
            }
        )
        .is_err());
        let mut seal2 = d.seal;
        seal2[0] ^= 1;
        assert!(verify_evidence(
            &t,
            &Evidence {
                depart: Some(wix::ExpeditionDepart { seal: seal2, ..d }),
                reveal: Some(r)
            }
        )
        .is_err());
        assert!(verify_evidence(
            &t,
            &Evidence {
                depart: Some(wix::ExpeditionDepart {
                    arrive_bell: 21,
                    ..d
                }),
                reveal: Some(r)
            }
        )
        .is_err());
        assert!(
            verify_evidence(
                &WideTransit {
                    seal_root: [0; 32],
                    ..t
                },
                &ok
            )
            .is_err(),
            "another transit"
        );
        assert!(verify_evidence(
            &t,
            &Evidence {
                depart: Some(d),
                reveal: Some(wix::ExpeditionReveal { target_i: 4, ..r })
            }
        )
        .is_err());
    }

    #[test]
    fn the_dispatch_wire_of_a_landed_transaction_is_decoded_exactly() {
        let (_, d, r) = sealed_transit();
        let program = Address::new_from_array(PROGRAM);
        let payer = Keypair::new();
        // (legacy wires: no lookup table, so nothing loaded — herald-v0v1-decode's `commands_in` argument)
        let none = fclient::vtx::LoadedAddresses::default();
        let wire = |data: Vec<u8>, pid: Address| {
            let ix = Instruction {
                program_id: pid,
                accounts: vec![AccountMeta::new(payer.pubkey(), true)],
                data,
            };
            let t = fclient::tx::build(
                &[ix],
                &lk::budget(),
                &[&payer],
                &fclient::Hash::new_from_array([1; 32]),
            )
            .unwrap();
            fclient::tx::wire(&t)
        };
        let dep = dx::encode(Kind::Depart, &d.to_bytes()).unwrap();
        let rev = dx::encode(Kind::Reveal, &r.to_bytes()).unwrap();
        assert_eq!(
            commands_in(&wire(dep.clone(), program), &none, &program).unwrap(),
            vec![(Landed::Depart(d), vec![payer.pubkey()])]
        );
        assert_eq!(
            commands_in(&wire(rev, program), &none, &program).unwrap(),
            vec![(Landed::Reveal(r), vec![payer.pubkey()])]
        );
        // a Reveal kind wrapping a Depart's bytes is never taken as either
        // (refused by the wrapper or by the kind check)
        if let Ok(bytes) = dx::encode(Kind::Reveal, &d.to_bytes()) {
            let got = commands_in(&wire(bytes, program), &none, &program);
            assert!(
                !matches!(got, Ok(ref v) if !v.is_empty()),
                "kind and inner command differ: {got:?}"
            );
        }
        assert!(
            commands_in(
                &wire(dep, Address::new_from_array([9; 32])),
                &none,
                &program
            )
            .unwrap()
            .is_empty(),
            "another program"
        );
        assert!(
            commands_in(&wire(d.to_bytes().to_vec(), program), &none, &program)
                .unwrap()
                .is_empty(),
            "not the version-2 dispatch"
        );
    }

    /// An account list of the table's fewest accounts (a filler everywhere)
    /// with `roles` placed at their positions by the abi's `position_in`.
    fn keys_for(g: &[frontier_abi::prologue::Group], roles: &[(&str, Address)]) -> Vec<Address> {
        let n = frontier_abi::prologue::bounds_in(g).0;
        let mut k = vec![Address::new_from_array([0xee; 32]); n];
        for (name, key) in roles {
            k[frontier_abi::prologue::position_in(g, n, name, 0).expect("a role of the table")] =
                *key;
        }
        k
    }

    #[test]
    fn only_the_current_transits_commands_count_so_a_reused_slot_is_not_ambiguous() {
        let season = addrs().season;
        let holding = Address::new_from_array([5; 32]);
        let external = Address::new_from_array([6; 32]);
        let other = Address::new_from_array([9; 32]);
        let roles =
            |s: Address, h: Address, x: Address| [("season", s), ("holding", h), ("transit", x)];
        let dep = |s, h, x| keys_for(wix::EXPEDITION_DEPART, &roles(s, h, x));
        let rev = |s, h, x| keys_for(wix::REVEAL, &roles(s, h, x));
        let (dk, rk) = (
            dep(season, holding, external),
            rev(season, holding, external),
        );
        // three marches of the same slot (fresh seal randomness each): only the
        // CURRENT transit's Depart and Reveal match it, for the 2nd reuse too
        let marches = [sealed_transit(), sealed_transit(), sealed_transit()];
        for (i, (t, _, _)) in marches.iter().enumerate() {
            for (j, (_, d, r)) in marches.iter().enumerate() {
                assert_eq!(
                    depart_matches(d, &dk, t, 0, &season, &holding, &external),
                    i == j,
                    "Depart of march {j} for transit {i}"
                );
                assert_eq!(
                    reveal_matches(r, &rk, t, 0, &season, &holding, &external),
                    i == j,
                    "Reveal of march {j} for transit {i}"
                );
            }
        }
        let (t, d, r) = &marches[2];
        let ok_d = |k: &[Address]| depart_matches(d, k, t, 0, &season, &holding, &external);
        let ok_r = |k: &[Address]| reveal_matches(r, k, t, 0, &season, &holding, &external);
        // every key present but in ANOTHER role (a `contains` check would pass)
        assert!(
            !ok_d(&dep(holding, season, external)),
            "season and holding swapped"
        );
        assert!(
            !ok_d(&dep(season, external, holding)),
            "holding and transit swapped"
        );
        assert!(
            !ok_r(&rev(season, external, holding)),
            "REVEAL holding and transit swapped"
        );
        assert!(
            !ok_r(&rev(external, holding, season)),
            "REVEAL season and transit swapped"
        );
        let mut moved = keys_for(
            wix::EXPEDITION_DEPART,
            &[
                ("season", season),
                ("citizen", holding),
                ("transit", external),
            ],
        );
        assert!(
            moved.contains(&holding) && !ok_d(&moved),
            "the holding only in the citizen role"
        );
        let holding_at =
            frontier_abi::prologue::position_in(wix::EXPEDITION_DEPART, moved.len(), "holding", 0)
                .unwrap();
        moved[holding_at] = holding;
        assert!(
            ok_d(&moved),
            "the same pubkey also in another role does not hide the right one"
        );
        // another Season, holding or transit record in the role
        assert!(
            !ok_d(&dep(other, holding, external)) && !ok_r(&rev(other, holding, external)),
            "another Season"
        );
        assert!(
            !ok_d(&dep(season, other, external)) && !ok_r(&rev(season, other, external)),
            "another holding"
        );
        assert!(
            !ok_d(&dep(season, holding, other)) && !ok_r(&rev(season, holding, other)),
            "another transit record"
        );
        // a list that fits no table length has no roles
        assert!(
            !ok_d(&dk[..dk.len() - 1]) && !ok_r(&rk[..3]),
            "a truncated account list"
        );
        // the command's own fields
        assert!(
            !reveal_matches(r, &rk, t, 1, &season, &holding, &external),
            "another slot"
        );
        assert!(
            !depart_matches(
                &wix::ExpeditionDepart {
                    arrive_bell: t.arrive_bell + 1,
                    ..*d
                },
                &dk,
                t,
                0,
                &season,
                &holding,
                &external
            ),
            "another arrival"
        );
    }

    fn view(
        rn: u32,
        anchor: bool,
        inputs: Option<Vec<u8>>,
        arrivals: bool,
        seed: bool,
    ) -> BellView {
        BellView {
            resolved_next: rn,
            bell: rn,
            anchor: anchor.then_some(1_000),
            inputs,
            arrivals,
            seed,
            missing_anchor: None,
        }
    }
    fn inputs_with(arr: &Arrival, bell: u32, mask: u32) -> Vec<u8> {
        let mut h = WideClashInputsHdr::new(SEASON_ID, arr.dest, bell, [0; 32]);
        h.arrivals_mask = mask;
        let mut d = vec![0u8; wa::wide_clash_inputs::SIZE];
        h.write(&mut d).unwrap();
        d
    }

    /// PURE planning over hand-made views (no chain): which ONE action comes
    /// next. Not evidence that the program accepts it.
    #[test]
    fn quiet_bells_11_and_12_are_resolved_before_the_arrival_bell_13_is_gathered() {
        let arr = arrival_at(Address::new_from_array([0x29; 32]), 13, 8);
        let all = wa::wide_clash_inputs::ALL_GATHERED;
        // bell 11: anchored, window closed, no inputs, no ArrivalDay bit → seed, then a quiet resolve
        assert_eq!(
            plan(&arr, &view(11, true, None, false, false), true),
            Ok(Plan::Seed(11))
        );
        assert_eq!(
            plan(&arr, &view(11, true, None, false, true), true),
            Ok(Plan::Resolve {
                bell: 11,
                quiet: true
            })
        );
        // bell 12 likewise (the cursor moved by the landed Resolve, never by a write)
        assert_eq!(
            plan(&arr, &view(12, true, None, false, false), true),
            Ok(Plan::Seed(12))
        );
        assert_eq!(
            plan(&arr, &view(12, true, None, false, true), true),
            Ok(Plan::Resolve {
                bell: 12,
                quiet: true
            })
        );
        // bell 13 is the arrival: gathered from position 0 even before a ClashInputs exists
        assert_eq!(
            plan(&arr, &view(13, true, None, false, false), true),
            Ok(Plan::Gather { bell: 13, start: 0 })
        );
        // a partially gathered record continues at its next position
        assert_eq!(
            plan(
                &arr,
                &view(
                    13,
                    true,
                    Some(inputs_with(&arr, 13, mask_through(7))),
                    true,
                    false
                ),
                true
            ),
            Ok(Plan::Gather { bell: 13, start: 7 })
        );
        assert_eq!(
            plan(
                &arr,
                &view(13, true, Some(inputs_with(&arr, 13, all)), true, false),
                true
            ),
            Ok(Plan::Seed(13))
        );
        assert_eq!(
            plan(
                &arr,
                &view(13, true, Some(inputs_with(&arr, 13, all)), true, true),
                true
            ),
            Ok(Plan::Resolve {
                bell: 13,
                quiet: false
            })
        );
        // resolved past the arrival: the settlement step
        assert_eq!(
            plan(
                &arr,
                &BellView {
                    resolved_next: 14,
                    bell: 13,
                    ..view(13, true, None, true, true)
                },
                true
            ),
            Ok(Plan::Settle)
        );
        // waits: the bell has not ended / its reveal window is open
        assert_eq!(
            plan(&arr, &view(11, false, None, false, false), false),
            Ok(Plan::WaitEnded(11))
        );
        assert_eq!(
            plan(&arr, &view(11, true, None, false, false), false),
            Ok(Plan::WaitWindow(11))
        );
        // a missing anchor comes before everything, the settlement included
        assert_eq!(
            plan(
                &arr,
                &BellView {
                    missing_anchor: Some(12),
                    ..view(11, true, None, false, true)
                },
                true
            ),
            Ok(Plan::Anchor(12))
        );
        assert_eq!(
            plan(
                &arr,
                &BellView {
                    missing_anchor: Some(13),
                    resolved_next: 14,
                    ..view(13, true, None, true, true)
                },
                true
            ),
            Ok(Plan::Anchor(13))
        );
        // an unreadable ClashInputs stops (never treated as empty)
        assert!(plan(&arr, &view(13, true, Some(vec![0; 8]), true, false), true).is_err());
    }

    #[test]
    fn an_earlier_bell_with_arrivals_is_gathered_and_resolved_as_a_contested_bell() {
        let arr = arrival_at(Address::new_from_array([0x29; 32]), 13, 8);
        let all = wa::wide_clash_inputs::ALL_GATHERED;
        // bell 11 has someone else's ArrivalDay bit but no ClashInputs yet
        assert_eq!(
            plan(&arr, &view(11, true, None, true, false), true),
            Ok(Plan::Gather { bell: 11, start: 0 })
        );
        // or a ClashInputs without the bit being read: still gathered, never quiet
        assert_eq!(
            plan(
                &arr,
                &view(
                    11,
                    true,
                    Some(inputs_with(&arr, 11, mask_through(3))),
                    false,
                    false
                ),
                true
            ),
            Ok(Plan::Gather { bell: 11, start: 3 })
        );
        assert_eq!(
            plan(
                &arr,
                &view(11, true, Some(inputs_with(&arr, 11, all)), true, false),
                true
            ),
            Ok(Plan::Seed(11))
        );
        assert_eq!(
            plan(
                &arr,
                &view(11, true, Some(inputs_with(&arr, 11, all)), true, true),
                true
            ),
            Ok(Plan::Resolve {
                bell: 11,
                quiet: false
            })
        );
        // then the quiet bell 12 and the arrival 13 as before
        assert_eq!(
            plan(&arr, &view(12, true, None, false, true), true),
            Ok(Plan::Resolve {
                bell: 12,
                quiet: true
            })
        );
        assert_eq!(
            plan(&arr, &view(13, true, None, false, false), true),
            Ok(Plan::Gather { bell: 13, start: 0 })
        );
    }

    #[test]
    fn the_seasons_end_bell_bounds_the_arrival_before_any_fetch_or_post() {
        use frontier_abi::v2::layout::world::season as S;
        assert!(check_end_bell(99, 100).is_ok());
        assert!(check_end_bell(100, 100).unwrap_err().contains("end bell"));
        assert!(check_end_bell(101, 100).is_err());
        let a = addrs();
        let (c, key) = chain_with_dest(11);
        let d = c.account(&a.season).unwrap().data;
        let end = u32::from_le_bytes(d[S::END_BELL..S::END_BELL + 4].try_into().unwrap());
        assert!(end > 12, "the installed Season ends after bell 12");
        // no anchor exists, so a view would otherwise ask for one (an Anchor plan → a round fetch)
        let e = bell_view(&c, &a, &arrival_at(key, end, 8), end + 5).unwrap_err();
        assert!(
            e.contains("end bell") && e.contains("nothing posted"),
            "{e}"
        );
        assert!(bell_view(&c, &a, &arrival_at(key, end + 40, 8), end + 50).is_err());
        // the last bell before the end is still driven (its missing anchor first)
        let (c2, key2) = chain_with_dest(end - 10);
        assert_eq!(
            bell_view(&c2, &a, &arrival_at(key2, end - 1, 8), end)
                .unwrap()
                .missing_anchor,
            Some(end - 10)
        );
        // the end bell is checked before the catch-up cap (11 → end is both)
        assert!(bell_view(&c, &a, &arrival_at(key, end, 8), end)
            .unwrap_err()
            .contains("end bell"));
    }

    fn arrival_at(dest_key: Address, arrive: u32, region: u8) -> Arrival {
        let (t, d, _) = sealed_transit();
        Arrival {
            transit_slot: 0,
            external: Address::new_from_array([6; 32]),
            host: t.host,
            faction: 2,
            arrive,
            dest: t.dest.unwrap_or_else(|| {
                ProvinceKey::new(
                    t.host.key().world(),
                    frontier_abi::world_index::WideCoord::checked(129, 0).unwrap(),
                )
            }),
            dest_key,
            region,
            position: 9,
            slot: Address::new_from_array([8; 32]),
            commit: d.commit,
            seal: d.seal,
        }
    }

    fn chain_with_dest(rn: u32) -> (Chain, Address) {
        use frontier_abi::v2::layout::province::province as PV;
        let mut c = Chain::new(localnet::Config::default());
        c.produce_block();
        crate::expedition_play::Base::new(c.unix_timestamp())
            .unwrap()
            .install(&mut c)
            .unwrap();
        let key = Address::new_from_array([0x29; 32]);
        let mut d = vec![0u8; PV::RESOLVED_NEXT + 64];
        d[PV::RESOLVED_NEXT..PV::RESOLVED_NEXT + 4].copy_from_slice(&rn.to_le_bytes());
        c.set_account(
            key,
            fclient::ports::Account {
                lamports: 1_000_000,
                data: d,
                owner: Address::new_from_array(PROGRAM),
                executable: false,
            },
        )
        .unwrap();
        (c, key)
    }
    fn put_anchor(c: &mut Chain, a: &Addresses, bell: u32, region: u8, owner: Address) {
        use frontier_abi::layout::beacon::bell_anchor as BA;
        use frontier_abi::v2::layout::{write_header, AccountKind as K2};
        let mut d = vec![0u8; K2::BellAnchor.size()];
        assert!(write_header(&mut d, K2::BellAnchor, SEASON_ID));
        d[BA::BELL..BA::BELL + 4].copy_from_slice(&bell.to_le_bytes());
        d[BA::REGION] = region;
        c.set_account(
            a.anchor(bell, region),
            fclient::ports::Account {
                lamports: 1_000_000,
                data: d,
                owner,
                executable: false,
            },
        )
        .unwrap();
    }

    #[test]
    fn the_destination_is_caught_up_bell_by_bell_before_the_arrival() {
        let a = addrs();
        let program = Address::new_from_array(PROGRAM);
        // a newly opened 129 (resolved_next 11), an arrival at bell 20, the chain at bell 21
        let (mut c, key) = chain_with_dest(11);
        let arr = arrival_at(key, 20, 8);
        let v = bell_view(&c, &a, &arr, 21).unwrap();
        assert_eq!(
            (
                v.resolved_next,
                v.bell,
                v.missing_anchor,
                v.anchor,
                v.arrivals,
                v.seed,
                v.inputs.is_some()
            ),
            (11, 11, Some(11), None, false, false, false),
            "the oldest unresolved bell first, its anchor posted before anything else"
        );
        // anchors of 11..=20 in region 8 (identity-checked): the cursor stays on 11, a quiet bell
        for b in 11..=20 {
            put_anchor(&mut c, &a, b, 8, program);
        }
        let v = bell_view(&c, &a, &arr, 21).unwrap();
        assert_eq!(
            (v.bell, v.missing_anchor, v.arrivals, v.inputs.is_some()),
            (11, None, false, false)
        );
        assert!(v.anchor.is_some());
        // only ended bells are anchored: at bell 15, bells 15.. are not asked for
        let (mut c2, key2) = chain_with_dest(11);
        for b in 11..15 {
            put_anchor(&mut c2, &a, b, 8, program);
        }
        assert_eq!(
            bell_view(&c2, &a, &arrival_at(key2, 20, 8), 15)
                .unwrap()
                .missing_anchor,
            None
        );
        // a foreign account at an anchor address stops (never counted as anchored)
        put_anchor(&mut c2, &a, 12, 8, Address::new_from_array([9; 32]));
        assert!(bell_view(&c2, &a, &arrival_at(key2, 20, 8), 15).is_err());
        // too far behind: not driven
        let (c3, key3) = chain_with_dest(11);
        assert!(bell_view(
            &c3,
            &a,
            &arrival_at(key3, 11 + MAX_CATCH_UP_BELLS + 1, 8),
            400
        )
        .unwrap_err()
        .contains("bells behind"));
        // exactly the cap is still driven
        assert!(bell_view(&c3, &a, &arrival_at(key3, 11 + MAX_CATCH_UP_BELLS, 8), 400).is_ok());
        // resolved past the arrival: only the settlement remains
        let (c4, key4) = chain_with_dest(21);
        let v = bell_view(&c4, &a, &arrival_at(key4, 20, 8), 30).unwrap();
        assert_eq!((v.resolved_next, v.bell, v.missing_anchor), (21, 20, None));
        // the resolve of the cursor bell names THAT bell's anchor, seed and inputs
        let ix = resolve_ix(&a, &Address::new_from_array([1; 32]), &arr, 11);
        assert_eq!(ix.accounts[4].pubkey, a.seed_cache(11, 8, 0));
        assert_eq!(ix.accounts[5].pubkey, a.anchor(11, 8));
        assert!(
            matches!(wix::WideCommand::decode(&ix.data), Ok(wix::WideCommand::Resolve(x)) if x.bell == 11)
        );
    }

    #[test]
    fn gather_cursors_and_settlement_decisions() {
        assert_eq!(next_position(0), Some(0));
        assert_eq!(next_position(mask_through(5)), Some(5));
        assert_eq!(next_position(wa::wide_clash_inputs::ALL_GATHERED), None);
        let ctx = ctx_of(&addrs());
        let dest = ProvinceKey::new(
            frontier_abi::world_index::WorldId::derive_legacy_season(&ctx.season, &ctx.program)
                .unwrap(),
            WideCoord::checked(129, 0).unwrap(),
        );
        let mut h = WideClashInputsHdr::new(SEASON_ID, dest, 20, [0; 32]);
        let (_, d, _) = sealed_transit();
        let host = WideHostRef::from_bytes(&d.host).unwrap();
        let row = |fate: u8| WideArrival {
            host,
            citizen: [1; 32],
            dep_mass: 1,
            troops: 10,
            stamina: 1,
            retreat_bps: 0,
            dealt_bps: 0,
            faction: 2,
            unit: 2,
            tile: 30,
            stance: 0,
            present: true,
            fate,
            troops_after: 5,
        };
        assert!(
            matches!(
                settle_decision(&h, Some(&row(1)), 9, 100, 50),
                Settle::Wait(_)
            ),
            "not resolved"
        );
        h.flags |= wa::wide_clash_inputs::FLAG_RESOLVED;
        assert_eq!(
            settle_decision(&h, Some(&row(wa::wide_arrival::FATE_STAYS)), 9, 100, 50),
            Settle::Member
        );
        assert_eq!(
            settle_decision(&h, Some(&row(wa::wide_arrival::FATE_RETREATED)), 9, 100, 50),
            Settle::Member
        );
        assert!(
            matches!(
                settle_decision(&h, Some(&row(wa::wide_arrival::FATE_STAYS)), 9, 10, 50),
                Settle::Wait(_)
            ),
            "too early"
        );
        // every fate the program's member settlement accepts (1..=5), once open
        for f in [
            wa::wide_arrival::FATE_DESTROYED,
            wa::wide_arrival::FATE_WITHDREW,
            wa::wide_arrival::FATE_BOUNCED,
        ] {
            assert_eq!(
                settle_decision(&h, Some(&row(f)), 9, 100, 50),
                Settle::Member,
                "fate {f}"
            );
            assert!(
                matches!(
                    settle_decision(&h, Some(&row(f)), 9, 10, 50),
                    Settle::Wait(_)
                ),
                "fate {f} too early"
            );
        }
        // not a member path: no fate, a fate past the range, an absent row, the camp's winner
        assert_eq!(
            settle_decision(&h, Some(&row(wa::wide_arrival::FATE_NONE)), 9, 100, 50),
            Settle::Unsupported(wa::wide_arrival::FATE_NONE)
        );
        assert_eq!(
            settle_decision(&h, Some(&row(6)), 9, 100, 50),
            Settle::Unsupported(6)
        );
        assert_eq!(
            settle_decision(
                &h,
                Some(&WideArrival {
                    present: false,
                    ..row(wa::wide_arrival::FATE_DESTROYED)
                }),
                9,
                100,
                50
            ),
            Settle::Unsupported(wa::wide_arrival::FATE_DESTROYED)
        );
        let camp = WideClashInputsHdr {
            camp_mask: 1 << 9,
            ..h
        };
        assert_eq!(
            settle_decision(&camp, Some(&row(wa::wide_arrival::FATE_STAYS)), 9, 100, 50),
            Settle::Unsupported(wa::wide_arrival::FATE_STAYS),
            "the camp's winner is SettleCamp's"
        );
        assert_eq!(
            settle_decision(
                &camp,
                Some(&row(wa::wide_arrival::FATE_DESTROYED)),
                9,
                100,
                50
            ),
            Settle::Member,
            "only a staying winner is the camp's"
        );
        let lower = WideClashInputsHdr {
            camp_mask: (1 << 3) | (1 << 9),
            ..h
        };
        assert_eq!(
            settle_decision(&lower, Some(&row(wa::wide_arrival::FATE_STAYS)), 9, 100, 50),
            Settle::Member,
            "a lower position won the camp"
        );
        assert_eq!(
            settle_decision(&h, None, 9, 100, 50),
            Settle::Unsupported(wa::wide_arrival::FATE_NONE)
        );
        h.settled_mask |= 1 << 9;
        assert_eq!(
            settle_decision(&h, Some(&row(wa::wide_arrival::FATE_STAYS)), 9, 100, 50),
            Settle::Done
        );
    }

    /// The member settlement's shape against the abi's SETTLE_MEMBER table
    /// (Current layout, 14): each role's key in order, a signer exactly where
    /// the table has one, writable wherever it says W; an executable role is
    /// named before any simulation (the program's `snapshots` refuses it).
    /// Account shape only: not evidence the program accepts the settlement.
    #[test]
    fn the_member_settlement_has_the_settle_member_tables_shape() {
        use expedition_settlement_ix::AccountLayout;
        let a = addrs();
        let k = |b: u8| Address::new_from_array([b; 32]);
        let arr = arrival_at(k(0x29), 20, 8);
        let (payer, holding, home, rent_to, slot_ben, resolver, rent_payer) = (
            k(0x51),
            k(0x52),
            k(0x53),
            k(0x54),
            k(0x55),
            k(0x56),
            k(0x57),
        );
        let ix = settle_member_ix(
            &a,
            &payer,
            &arr,
            &holding,
            &home,
            &rent_to,
            &slot_ben,
            &resolver,
            &rent_payer,
        )
        .unwrap();
        let layout = AccountLayout::from_count(ix.accounts.len()).unwrap();
        assert_eq!(layout, AccountLayout::Current);
        let ctx = ctx_of(&a);
        let want: [(&str, Address); 14] = [
            ("season", a.season),
            ("holding", holding),
            ("external", arr.external),
            ("home", home),
            ("destination", arr.dest_key),
            (
                "inputs",
                Address::new_from_array(clash_inputs_address(&ctx, arr.dest, arr.arrive)),
            ),
            ("slot", arr.slot),
            ("external_rent_to", rent_to),
            ("anchor_or_archive", a.anchor(arr.arrive, arr.region)),
            ("payer", payer),
            ("slot_beneficiary", slot_ben),
            ("resolver", resolver),
            ("holding_rent_payer", rent_payer),
            ("settle_beneficiary", payer),
        ];
        for (i, (m, (name, key))) in ix.accounts.iter().zip(want).enumerate() {
            let spec = layout.spec(i).unwrap();
            assert_eq!((spec.name, m.pubkey), (name, key), "role {i}");
            assert_eq!(m.is_signer, spec.signer, "role {i} ({name}) signer");
            if spec.wr == frontier_abi::prologue::Wr::W {
                assert!(m.is_writable, "role {i} ({name}) must be writable");
            }
        }
        // the payer aliases only roles the program lets it alias
        assert!(layout.roles_may_alias(9, 13), "payer = settle beneficiary");
        // a zero rent payer is the executable System Program: named, not sent
        let mut c = Chain::new(localnet::Config::default());
        c.produce_block();
        // an executable account the node itself holds (its builtin programs;
        // the node refuses to create a synthetic executable account): the
        // zero key (an unset RENT_PAYER = the System Program) first
        let builtins = [
            "11111111111111111111111111111111",
            "BPFLoaderUpgradeab1e11111111111111111111111",
            "ComputeBudget111111111111111111111111111111",
            "NativeLoader1111111111111111111111111111111",
        ];
        let exe = builtins
            .iter()
            .map(|s| s.parse::<Address>().unwrap())
            .find(|k| c.account(k).is_some_and(|x| x.executable))
            .expect("the node holds an executable builtin account");
        let bad = settle_member_ix(
            &a, &payer, &arr, &holding, &home, &rent_to, &slot_ben, &resolver, &exe,
        )
        .unwrap();
        assert_eq!(executable_role(&c, &bad), Some((12, exe)));
        assert_eq!(layout.spec(12).unwrap().name, "holding_rent_payer");
        assert_eq!(executable_role(&c, &ix), None);
    }

    /// A completed settlement carries the fate; only Stays is an arrival that
    /// stays (a declaration may follow); a destroyed or departed host never is.
    #[test]
    fn a_completed_settlement_is_an_arrival_that_stays_only_for_stays() {
        use wa::wide_arrival as F;
        assert!(Step::Settled {
            fate: F::FATE_STAYS
        }
        .arrival_stays());
        for fate in [
            F::FATE_DESTROYED,
            F::FATE_WITHDREW,
            F::FATE_BOUNCED,
            F::FATE_RETREATED,
            F::FATE_NONE,
            6,
        ] {
            assert!(!Step::Settled { fate }.arrival_stays(), "fate {fate}");
        }
        assert!(!Step::Landed("SettleMember(transit 0)".into(), "s".into()).arrival_stays());
        assert!(
            !Step::Wait("w".into()).arrival_stays() && !Step::Stopped("x".into()).arrival_stays()
        );
        // the status string names the fate (the Pilot's `destination_step`)
        assert_eq!(
            format!(
                "{:?}",
                Step::Settled {
                    fate: F::FATE_DESTROYED
                }
            ),
            "Settled { fate: 5 }"
        );
    }

    #[test]
    fn no_transit_means_no_arrival_and_nothing_is_sent() {
        let mut c = Chain::new(localnet::Config::default());
        c.produce_block();
        crate::expedition_play::Base::new(c.unix_timestamp())
            .unwrap()
            .install(&mut c)
            .unwrap();
        assert_eq!(
            find_arrival(&c, &addrs(), &Address::new_from_array([5; 32]), 0),
            Ok(None)
        );
    }
}
