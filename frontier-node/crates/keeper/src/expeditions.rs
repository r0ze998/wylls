//! Rim → wide expeditions on a devnet wide season (devnet runbook gap P13;
//! the playable lane 0x4804, feature `playable-lane`). Role `expeditions`:
//! the production form of the local TEST runner's origin and destination
//! drivers (`itest::origin_driver`, `itest::destination_driver`), with the
//! same instructions and checks ([`crate::expedition_steps`], one copy).
//!
//! After a player's ExpeditionDepart (the 0x4804 wrapper, kind 0) every later
//! step is permissionless (the fee payer is the only signer), and keeper A
//! sends it from its own pools:
//!
//! | step | who | when (read from the chain each scan) |
//! |---|---|---|
//! | the origin's departure bell: GatherClash (no arrivals), ResolveFromInputs | keeper A's `gather` / `resolve` roles | this role hands the bell to the play duty (`PlayDuty::expedition_bells`): the skip run stops before it and the bell is resolved as a clash bell (the Depart's pending Spend makes it NotQuiet) |
//! | anchors and seeds of every bell and region | keeper A's `beacon` role | as for every bell |
//! | **ExpeditionSettleOrigin** (kind 1) | this role | the bridge transit `Departed` and the home resolved past `depart_bell` |
//! | **ExpeditionReveal** (kind 2) | this role, class W | the transit origin-settled, no landed Reveal, `T(arrive)` published: the seal opened from that PUBLIC round (anyone can, once it is out), never at or after `A + W − 2` slots of THE anchor of `(arrive, region)`; a seal that does not open, a closed window or four taken slots: given up (the settlement judges it) |
//! | the destination's catch-up: quiet wide **Resolve** of each bell from its `resolved_next` | this role | THE anchor present, its window closed, the seed on chain (bounded: [`MAX_CATCH_UP_BELLS`]) |
//! | **ExpeditionGather** (kind 3) of the arrival bell (and of an earlier bell with arrivals) | this role | window closed, positions not all scanned; packet-sized batches |
//! | the wide **Resolve** of the arrival bell | this role | all positions gathered, the seed on chain |
//! | **SettleMember** (kind 6) | this role | resolved, `close + SETTLE_AFTER_CLOSE_SECS` passed, a member fate (Stays, Withdrew, Bounced, Retreated, Destroyed) |
//!
//! The evidence (the landed Depart and Reveal) comes from the transactions
//! the feed index saw with the transit's PS2 146 / 147 records
//! ([`crate::playindex::ExpTrack`], P10), checked against the chain's bridge
//! record (`expedition_steps::evidence_of`) before anything is planned.
//!
//! **Idempotent restarts.** Nothing is kept but the feed index (rebuilt from
//! cursor 0) and the engine's journal; every step is planned from fresh chain
//! reads and keyed by its object (`exp-origin:<transit>:<bell>`,
//! `exp-reveal:<transit>:<arrive>`, `exp-gather:<P>,<Q>:<bell>:<start>`,
//! `exp-resolve:<P>,<Q>:<bell>`, `exp-settle:<transit>:<arrive>`), so a
//! restarted keeper re-plans exactly what is still due. A step the program
//! refuses stops that transit for this process (never resent in a loop).
//!
//! **Who pays.** keeper A's pools (classes D and W), like every play role:
//! fees, the rent of the ArrivalSlot / ArrivalDay / ClashInputs this role
//! creates (returned to the payer by the settlement's rules). The player pays
//! only the Depart.
use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use fclient::abi::{status, Class};
use fclient::decode::{AnchorArchive, BellAnchor, Province};
use fclient::ix::SeedSource;
use fclient::ports::{Account, ChainPort, DrandPort, PortResult};
use frontier_abi::addr::day_of;
use frontier_abi::world_index::{
    arrival::{
        arrival_day_address, arrival_slot_address, clash_inputs_address, WideArrival,
        WideClashInputsHdr,
    },
    expedition_dispatch_ix::Kind,
    land::{province_address, WideProvince},
    march::MarchState,
    wide_ix as wix,
};
use serde_json::{json, Value};
use solana_address::Address;
use solana_instruction::Instruction;

use crate::beacon::AnchorInfo;
use crate::engine::{BuildCtx, Engine, Outcome, WriteSpec};
use crate::expedition_steps as steps;
use crate::play::PlayDuty;
use crate::rounds::Rounds;
use crate::seeds::SeedFinder;
use crate::Tick;

/// The most destination bells resolved before an arrival (a whole 7-day
/// Season of 10-minute turns, as the local wide world's driver).
pub const MAX_CATCH_UP_BELLS: u32 = 1008;
/// Transits planned per scan at most.
pub const PER_SCAN: usize = 32;
/// Slots between two scans.
pub const SCAN_SLOTS: u64 = 4;
/// Reveal safety margin (slots before `A + W`), as the legacy reveal.
pub const REVEAL_EPSILON_SLOTS: i64 = crate::play::REVEAL_EPSILON_SLOTS;
/// The packet bound of one transaction.
pub const PACKET_BYTES: usize = 1232;
/// CU limits per step (the pinned `.so`'s measured maxima in the verifier
/// recordings, about ×2: SettleOrigin 80,742; Reveal 340,627; Gather of a
/// full batch 516,503; SettleMember 195,583; the wide Resolve below 250,000).
pub const CU_ORIGIN: u32 = 200_000;
pub const CU_REVEAL: u32 = 700_000;
pub const CU_GATHER: u32 = 1_200_000;
pub const CU_RESOLVE: u32 = 600_000;
pub const CU_SETTLE: u32 = 500_000;

/// The role a write key of this duty belongs to.
pub fn is_key(key: &str) -> bool {
    key.starts_with("exp-")
}

#[derive(Default)]
pub struct ExpeditionDuty {
    last_scan: Option<u64>,
    /// Transits given up by this process (a program refusal, a seal that does
    /// not open, a reveal window closed unrevealed): transit → why.
    pub stopped: BTreeMap<Address, String>,
    /// The last decision per transit (status).
    pub last: BTreeMap<Address, String>,
    /// Landed writes `(key, slot)`.
    pub landed: Vec<(String, u64)>,
    /// Refused writes `(key, why)`.
    pub refused: Vec<(String, String)>,
    /// Verified public signatures by round (T(arrive)).
    sigs: BTreeMap<u64, [u8; 48]>,
}

fn adr(k: [u8; 32]) -> Address {
    Address::new_from_array(k)
}

/// The transit of a write key (`exp-<step>:<transit>:…`).
fn transit_of(key: &str) -> Option<Address> {
    let mut it = key.split(':');
    let step = it.next()?;
    if matches!(step, "exp-origin" | "exp-reveal" | "exp-settle") {
        it.next()?.parse().ok()
    } else {
        None
    }
}

async fn read_into<P: ChainPort>(
    port: &P,
    keys: &[Address],
    into: &mut BTreeMap<Address, Account>,
) -> PortResult<()> {
    let keys: Vec<Address> = keys
        .iter()
        .copied()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    for chunk in keys.chunks(100) {
        for (k, a) in chunk.iter().zip(port.accounts(chunk, 0).await?) {
            match a {
                Some(a) => {
                    into.insert(*k, a);
                }
                None => {
                    into.remove(k);
                }
            }
        }
    }
    Ok(())
}

/// THE anchor of `(bell, region)`: its landing time and whether it is only
/// in the archive (the play duty's read: the anchor account of this season,
/// bell and region, else the archive part's entry).
pub async fn anchor_of<P: ChainPort>(
    port: &P,
    t: &Tick<'_>,
    bell: u32,
    region: u8,
) -> PortResult<Option<(i64, bool)>> {
    let got = port
        .accounts(
            &[
                t.addrs.anchor(bell, region),
                t.addrs.archive(region, fclient::addr::archive_part(bell)),
            ],
            0,
        )
        .await?;
    if let Some(an) = got[0]
        .as_ref()
        .filter(|a| a.owner == t.addrs.program)
        .and_then(|a| BellAnchor::decode(&a.data).ok())
        .filter(|an| an.bell == bell && an.region == region && an.season_id == t.addrs.season_id)
    {
        return Ok(Some((an.a, false)));
    }
    if let Some(ar) = got[1]
        .as_ref()
        .filter(|a| a.owner == t.addrs.program)
        .and_then(|a| AnchorArchive::decode(&a.data).ok())
    {
        if ar.is_archived(bell) {
            let e = ar.entries[bell as usize % ar.entries.len()];
            return Ok(Some((
                t.clock.genesis_ts + (bell as i64 + 1) * fclient::abi::BELL_SECS + e.a_off as i64,
                true,
            )));
        }
    }
    Ok(None)
}

/// The fee payer of a size probe: build the probed instruction with its
/// address (a payer the probe's key does not sign is a build error).
pub fn size_signer() -> solana_keypair::Keypair {
    solana_keypair::Keypair::new_from_array([7; 32])
}

/// The encoded size of `ixs` with the keeper's largest budget prefix (a dummy
/// signer and blockhash: the size only).
pub fn encoded_len(ixs: &[Instruction]) -> Result<usize, String> {
    let k = size_signer();
    let budget = fclient::tx::TxBudget {
        cu_limit: fclient::abi::CU_MAX,
        cu_price: 1,
        loaded_limit: fclient::fees::RUNTIME_MAX_LOADED,
        heap: Some(fclient::abi::HEAP_FRAME_RETRY),
    };
    let t = fclient::tx::build(ixs, &budget, &[&k], &fclient::Hash::new_from_array([1; 32]))?;
    Ok(fclient::tx::wire(&t).len())
}

impl ExpeditionDuty {
    pub fn on_outcome(&mut self, key: &str, o: &Outcome) {
        match o {
            Outcome::Landed { slot, .. } => {
                eprintln!("frontier-keeper: expeditions: {key} landed at slot {slot}");
                self.landed.push((key.to_string(), *slot))
            }
            Outcome::Failed { err, code, .. } | Outcome::Dead { reason: err, code } => {
                eprintln!("frontier-keeper: expeditions: {key} refused: {err} (code {code:?})");
                self.refused
                    .push((key.to_string(), format!("{err} (code {code:?})")));
                if let Some(x) = transit_of(key) {
                    self.stopped
                        .entry(x)
                        .or_insert_with(|| format!("{key} refused: {err} (code {code:?})"));
                }
            }
            Outcome::Unresolved { .. } => {}
        }
    }

    pub fn status(&self) -> Value {
        json!({
            "tracked": self.last.len(),
            "last": self.last.iter().map(|(k, v)| (k.to_string(), v.clone())).collect::<BTreeMap<_, _>>(),
            "stopped": self.stopped.iter().map(|(k, v)| (k.to_string(), v.clone())).collect::<BTreeMap<_, _>>(),
            "landed": self.landed.iter().map(|(k, s)| json!({"key": k, "slot": s})).collect::<Vec<_>>(),
            "refused": self.refused.iter().map(|(k, s)| json!({"key": k, "why": s})).collect::<Vec<_>>(),
        })
    }

    /// One scan (module doc). Reads the chain, plans at most one step per
    /// transit, and hands the departure bells to the play duty.
    #[allow(clippy::too_many_arguments)]
    pub async fn plan<P: ChainPort, D: DrandPort>(
        &mut self,
        t: &Tick<'_>,
        port: &P,
        drand: &D,
        rounds: &mut Rounds,
        engine: &mut Engine,
        play: &mut PlayDuty,
        seeds: &mut SeedFinder,
        anchors: &BTreeMap<(u32, u8), AnchorInfo>,
    ) -> PortResult<()> {
        if !t.cfg.has_role("expeditions") || t.season.effective_status(t.now) != status::RUNNING {
            return Ok(());
        }
        if self
            .last_scan
            .is_some_and(|s| t.slot < s.saturating_add(SCAN_SLOTS))
        {
            return Ok(());
        }
        self.last_scan = Some(t.slot);
        let mut bells = BTreeSet::new();
        let live: Vec<(Address, crate::playindex::ExpTrack)> = play
            .index
            .expeditions
            .iter()
            .filter(|(k, e)| !e.ended && !self.stopped.contains_key(k))
            .take(PER_SCAN)
            .map(|(k, e)| (*k, e.clone()))
            .collect();
        for (external, e) in live {
            let what = match self
                .one(
                    t, port, drand, rounds, engine, seeds, anchors, &external, &e, &mut bells,
                )
                .await?
            {
                Ok(w) => w,
                Err(stop) => {
                    self.stopped.insert(external, stop.clone());
                    format!("stopped: {stop}")
                }
            };
            if self.last.get(&external) != Some(&what) {
                // (one line per change of decision: the operator's log)
                eprintln!("frontier-keeper: expeditions: transit {external}: {what}");
            }
            self.last.insert(external, what);
        }
        for (k, e) in &play.index.expeditions {
            if e.ended {
                self.last
                    .entry(*k)
                    .and_modify(|w| {
                        if !w.starts_with("ended") {
                            *w = format!("ended ({w})")
                        }
                    })
                    .or_insert_with(|| "ended".into());
            }
        }
        play.expedition_bells = bells;
        Ok(())
    }

    /// The next step of one transit: `Ok(what)` (planned or waiting) or
    /// `Err(why)` (stopped for this process).
    #[allow(clippy::too_many_arguments)]
    async fn one<P: ChainPort, D: DrandPort>(
        &mut self,
        t: &Tick<'_>,
        port: &P,
        drand: &D,
        rounds: &mut Rounds,
        engine: &mut Engine,
        seeds: &mut SeedFinder,
        anchors: &BTreeMap<(u32, u8), AnchorInfo>,
        external: &Address,
        e: &crate::playindex::ExpTrack,
        bells: &mut BTreeSet<(i16, i16, u32)>,
    ) -> PortResult<Result<String, String>> {
        let a = t.addrs;
        let program = a.program;
        let mut acc: BTreeMap<Address, Account> = BTreeMap::new();
        let home_key = a.province(e.home.0 as i32, e.home.1 as i32);
        read_into(port, &[*external, e.holding, home_key], &mut acc).await?;
        let read = |k: &Address| acc.get(k).cloned();
        let tr = match steps::bridge_transit(&read, a, &e.holding, e.slot) {
            Ok(Some((x, tr))) if x == *external => tr,
            Ok(Some(_)) => {
                return Ok(Err(
                    "the transit record is not at its canonical address".into()
                ))
            }
            Ok(None) => {
                return Ok(Ok(
                    "no bridge transit record (closed or not yet landed)".into()
                ))
            }
            Err(er) => return Ok(Err(er)),
        };
        match tr.state {
            MarchState::Departed => {
                let Some(pv) = acc
                    .get(&home_key)
                    .filter(|x| x.owner == program)
                    .and_then(|x| Province::decode(&x.data).ok())
                else {
                    return Ok(Err("the home province is absent".into()));
                };
                if pv.resolved_next > tr.depart_bell {
                    let key = format!("exp-origin:{external}:{}", tr.depart_bell);
                    let (aa, holding, slot, home) = (a.clone(), e.holding, e.slot, e.home);
                    if let Err(er) = steps::settle_origin_ix(
                        a,
                        &program,
                        (home.0 as i32, home.1 as i32),
                        &holding,
                        slot,
                    ) {
                        return Ok(Err(er));
                    }
                    if engine.ensure(
                        WriteSpec {
                            key: key.clone(),
                            kind: "exp-origin",
                            tag: Kind::SettleOrigin.tag(),
                            class: Class::D,
                            bell: Some(tr.depart_bell),
                            region: Some(pv.region),
                            build: Arc::new(move |c: &BuildCtx| {
                                steps::settle_origin_ix(
                                    &aa,
                                    &c.payer,
                                    (home.0 as i32, home.1 as i32),
                                    &holding,
                                    slot,
                                )
                                .map(|ix| vec![ix])
                                .unwrap_or_default()
                            }),
                            deadline_slot: None,
                            not_before_slot: 0,
                            fixed_payer: None,
                        },
                        t.slot,
                    ) {
                        engine.set_cu_limit(&key, CU_ORIGIN);
                    }
                    return Ok(Ok(format!(
                        "SettleOrigin (home resolved to {})",
                        pv.resolved_next
                    )));
                }
                bells.insert((e.home.0, e.home.1, tr.depart_bell));
                Ok(Ok(format!(
                    "origin bell {}: keeper A's gather/resolve (home at {})",
                    tr.depart_bell, pv.resolved_next
                )))
            }
            MarchState::Settled | MarchState::Gathered => {
                let ev = match steps::evidence_of(
                    e.wires.iter().map(|w| w.as_slice()),
                    &program,
                    &a.season,
                    &e.holding,
                    external,
                    &tr,
                    e.slot,
                ) {
                    Ok(ev) => ev,
                    Err(er) => return Ok(Err(er)),
                };
                if ev.depart.is_none() {
                    return Ok(Err("no landed Depart of this transit in the feed".into()));
                }
                if ev.reveal.is_none() {
                    if tr.state != MarchState::Settled {
                        return Ok(Ok(format!("state {:?} with no Reveal", tr.state)));
                    }
                    return self
                        .reveal(t, port, drand, rounds, engine, external, e, &tr, &ev)
                        .await;
                }
                self.destination(t, port, engine, seeds, anchors, e, &ev, &tr)
                    .await
            }
            other => Ok(Ok(format!("transit state {other:?}: nothing to send"))),
        }
    }

    #[allow(clippy::too_many_arguments)]
    async fn reveal<P: ChainPort, D: DrandPort>(
        &mut self,
        t: &Tick<'_>,
        port: &P,
        drand: &D,
        rounds: &mut Rounds,
        engine: &mut Engine,
        external: &Address,
        e: &crate::playindex::ExpTrack,
        tr: &frontier_abi::world_index::march::WideTransit,
        ev: &steps::Evidence,
    ) -> PortResult<Result<String, String>> {
        let a = t.addrs;
        let ctx = steps::ctx_of(a);
        let now_bell = t.clock.bell_at(t.now).unwrap_or(0);
        if tr.arrive_bell >= now_bell {
            return Ok(Ok(format!("arrival bell {} not ended", tr.arrive_bell)));
        }
        let round = t.clock.tlock_round(tr.arrive_bell);
        if t.clock.drand.round_time(round) > t.now {
            return Ok(Ok(format!("T(arrive) round {round} not published")));
        }
        let sig48 = match self.sigs.get(&round) {
            Some(s) => *s,
            None => match rounds.get(drand, round, t.slot).await {
                Some(b) => {
                    self.sigs.insert(round, b.sig48);
                    b.sig48
                }
                None => return Ok(Ok(format!("round {round} not served yet"))),
            },
        };
        let d = ev.depart.expect("checked");
        let o = match steps::open_departed(tr, &d, e.slot, &sig48) {
            Ok(o) => o,
            Err(er) => return Ok(Err(format!("not revealable: {er}"))),
        };
        let dest_key = adr(province_address(&ctx, o.dest.coord()));
        let mut acc = BTreeMap::new();
        let mut keys = vec![dest_key];
        keys.extend(
            (0..4u8).map(|i| adr(arrival_slot_address(&ctx, o.dest, o.arrive, o.faction, i))),
        );
        read_into(port, &keys, &mut acc).await?;
        let Some(prov) = acc
            .get(&dest_key)
            .filter(|x| x.owner == a.program)
            .and_then(|x| WideProvince::read(&x.data).ok())
        else {
            return Ok(Err("its destination province is not open".into()));
        };
        let eps = (REVEAL_EPSILON_SLOTS as f64 * 0.4).ceil() as i64;
        let deadline = match anchor_of(port, t, o.arrive, prov.region).await? {
            Some((a_ts, _)) => {
                let close = t.clock.reveal_close(o.arrive, a_ts);
                if t.now + eps >= close {
                    return Ok(Err(format!(
                        "the reveal window of bell {} closed unrevealed (closes at {close}, now {})",
                        o.arrive, t.now
                    )));
                }
                let slots_left = ((close - t.now) as f64 / 0.4).floor() as i64;
                Some(t.slot + (slots_left - REVEAL_EPSILON_SLOTS).max(0) as u64)
            }
            // (the program admits a reveal before THE anchor exists; the window closes only at A + W)
            None => None,
        };
        let Some(target) = (0..4u8).find(|i| !acc.contains_key(&keys[1 + *i as usize])) else {
            return Ok(Err(format!(
                "the nation's four arrival slots of bell {} are taken",
                o.arrive
            )));
        };
        let holding = e.holding;
        let region = prov.region;
        if let Err(er) = steps::self_reveal_ix(&ctx, &a.program, &holding, &o, region, target) {
            return Ok(Err(er));
        }
        let key = format!("exp-reveal:{external}:{}", o.arrive);
        let (arrive, dest) = (o.arrive, o.dest);
        if engine.ensure(
            WriteSpec {
                key: key.clone(),
                kind: "exp-reveal",
                tag: Kind::Reveal.tag(),
                class: Class::W,
                bell: Some(arrive),
                region: Some(region),
                build: Arc::new(move |c: &BuildCtx| {
                    steps::self_reveal_ix(&ctx, &c.payer, &holding, &o, region, target)
                        .map(|ix| vec![ix])
                        .unwrap_or_default()
                }),
                deadline_slot: deadline,
                not_before_slot: 0,
                fixed_payer: None,
            },
            t.slot,
        ) {
            engine.set_cu_limit(&key, CU_REVEAL);
        }
        Ok(Ok(format!(
            "ExpeditionReveal → ({}, {}) bell {arrive} slot {target}",
            dest.coord().p(),
            dest.coord().q()
        )))
    }

    #[allow(clippy::too_many_arguments)]
    async fn destination<P: ChainPort>(
        &mut self,
        t: &Tick<'_>,
        port: &P,
        engine: &mut Engine,
        seeds: &mut SeedFinder,
        anchors: &BTreeMap<(u32, u8), AnchorInfo>,
        e: &crate::playindex::ExpTrack,
        ev: &steps::Evidence,
        tr: &frontier_abi::world_index::march::WideTransit,
    ) -> PortResult<Result<String, String>> {
        let a = t.addrs;
        let ctx = steps::ctx_of(a);
        // the arrival, verified (the destination Province and the admitted ArrivalSlot)
        let r = ev.reveal.expect("checked");
        let plain = match frontier_abi::world_index::seal::unpack(&r.plain) {
            Ok(p) => p,
            Err(er) => return Ok(Err(format!("plaintext: {er:?}"))),
        };
        let dest_key = adr(province_address(&ctx, plain.dest.coord()));
        let external = steps::external_of(a, &e.holding, e.slot);
        let mut acc: BTreeMap<Address, Account> = BTreeMap::new();
        let mut keys = vec![external, e.holding, dest_key, a.season];
        keys.extend((0..4u8).map(|i| {
            adr(arrival_slot_address(
                &ctx,
                plain.dest,
                tr.arrive_bell,
                tr.faction,
                i,
            ))
        }));
        read_into(port, &keys, &mut acc).await?;
        let arr = {
            let read = |k: &Address| acc.get(k).cloned();
            match steps::arrival_of(&read, a, &e.holding, e.slot, ev) {
                Ok(Some(x)) => x,
                Ok(None) => return Ok(Ok("the revealed arrival is not admitted yet".into())),
                Err(er) => return Ok(Err(er)),
            }
        };
        if let Err(er) = steps::check_end_bell(arr.arrive, t.season.end_bell) {
            return Ok(Err(er));
        }
        let rn = {
            let read = |k: &Address| acc.get(k).cloned();
            match steps::resolved_next_at(&read, a, &arr.dest_key) {
                Ok(x) => x,
                Err(er) => return Ok(Err(er)),
            }
        };
        let pk = format!("{},{}", arr.dest.coord().p(), arr.dest.coord().q());
        if rn > arr.arrive {
            return self.settle(t, port, engine, e, &arr, &mut acc).await;
        }
        if arr.arrive - rn > MAX_CATCH_UP_BELLS {
            return Ok(Err(format!(
                "the destination is {} bells behind the arrival (resolved_next {rn}); beyond {MAX_CATCH_UP_BELLS} not driven",
                arr.arrive - rn
            )));
        }
        let b = rn;
        let Some((a_ts, archived)) = anchor_of(port, t, b, arr.region).await? else {
            return Ok(Ok(format!(
                "destination bell {b}: THE anchor not posted yet (beacon role)"
            )));
        };
        let window_closed = t.now >= t.clock.reveal_close(b, a_ts);
        let ci = adr(clash_inputs_address(&ctx, arr.dest, b));
        let day = adr(arrival_day_address(&ctx, arr.dest, day_of(b)));
        read_into(port, &[ci, day], &mut acc).await?;
        let seed = if window_closed {
            seeds.find(port, a, anchors, b, arr.region, t.slot).await?
        } else {
            None
        };
        let v = {
            let read = |k: &Address| acc.get(k).cloned();
            let inputs = match steps::inputs_at(&read, a, &arr, b) {
                Ok(x) => x,
                Err(er) => return Ok(Err(er)),
            };
            let arrivals = match steps::arrival_bit(&read, a, &arr, b) {
                Ok(x) => x,
                Err(er) => return Ok(Err(er)),
            };
            steps::BellView {
                resolved_next: rn,
                bell: b,
                anchor: Some(a_ts),
                inputs,
                arrivals,
                seed: seed.is_some(),
                missing_anchor: None,
            }
        };
        let anchor_src = if archived {
            a.archive(arr.region, fclient::addr::archive_part(b))
        } else {
            a.anchor(b, arr.region)
        };
        match steps::plan(&arr, &v, window_closed) {
            Err(er) => Ok(Err(er)),
            Ok(steps::Plan::Anchor(x) | steps::Plan::WaitEnded(x)) => {
                Ok(Ok(format!("destination bell {x}: waiting for THE anchor")))
            }
            Ok(steps::Plan::WaitWindow(x)) => {
                Ok(Ok(format!("destination bell {x}: reveal window open")))
            }
            Ok(steps::Plan::Seed(x)) => Ok(Ok(format!(
                "destination bell {x}: waiting for the seed (beacon role)"
            ))),
            Ok(steps::Plan::Settle) => self.settle(t, port, engine, e, &arr, &mut acc).await,
            Ok(steps::Plan::Gather { bell, start }) => {
                read_into(port, &steps::position_slots(a, arr.dest, bell), &mut acc).await?;
                let read = |k: &Address| acc.get(k).cloned();
                let dummy = solana_signer::Signer::pubkey(&size_signer());
                let mut best = 0u8;
                for n in 1..=(steps::POSITIONS - start) {
                    let ix = match steps::gather_ix_with(
                        &read,
                        a,
                        &dummy,
                        &arr,
                        bell,
                        start,
                        n,
                        &anchor_src,
                    ) {
                        Ok(ix) => ix,
                        Err(er) => return Ok(Err(er)),
                    };
                    match encoded_len(std::slice::from_ref(&ix)) {
                        Ok(len) if len <= PACKET_BYTES => best = n,
                        _ => break,
                    }
                }
                if best == 0 {
                    return Ok(Err(format!(
                        "no Gather batch from position {start} fits the packet"
                    )));
                }
                // (the built instruction, its fee payer replaced at send time)
                let ix0 =
                    steps::gather_ix_with(&read, a, &dummy, &arr, bell, start, best, &anchor_src)
                        .expect("built above");
                let key = format!("exp-gather:{pk}:{bell}:{start}");
                if engine.ensure(
                    WriteSpec {
                        key: key.clone(),
                        kind: "exp-gather",
                        tag: Kind::Gather.tag(),
                        class: Class::D,
                        bell: Some(bell),
                        region: Some(arr.region),
                        build: Arc::new(move |c: &BuildCtx| {
                            let mut ix = ix0.clone();
                            ix.accounts[0].pubkey = c.payer;
                            vec![ix]
                        }),
                        deadline_slot: None,
                        not_before_slot: 0,
                        fixed_payer: None,
                    },
                    t.slot,
                ) {
                    engine.set_cu_limit(&key, CU_GATHER);
                    // (a full batch writes past the default 32-KiB heap: P10 run 2's first version faulted)
                    engine.set_heap(&key, fclient::abi::HEAP_FRAME_RETRY);
                }
                Ok(Ok(format!(
                    "ExpeditionGather(bell {bell}, from {start}, {best} positions)"
                )))
            }
            Ok(steps::Plan::Resolve { bell, quiet }) => {
                let Some(s) = seed else {
                    return Ok(Ok(format!("destination bell {bell}: waiting for the seed")));
                };
                let (seed_src, anchor_src) = match s.src {
                    SeedSource::Cache { nonce } => {
                        (a.seed_cache(bell, arr.region, nonce), anchor_src)
                    }
                    SeedSource::Archive => {
                        let ar = a.archive(arr.region, fclient::addr::archive_part(bell));
                        (ar, ar)
                    }
                };
                let key = format!("exp-resolve:{pk}:{bell}");
                let (aa, arr2) = (a.clone(), arr.clone());
                if engine.ensure(
                    WriteSpec {
                        key: key.clone(),
                        kind: "exp-resolve",
                        tag: wix::WideIx::SettleTicket.tag(), // (0xDC: the class tag of the wide Resolve, op 1)
                        class: Class::D,
                        bell: Some(bell),
                        region: Some(arr.region),
                        build: Arc::new(move |c: &BuildCtx| {
                            vec![steps::resolve_ix_with(
                                &aa,
                                &c.payer,
                                &arr2,
                                bell,
                                &seed_src,
                                &anchor_src,
                            )]
                        }),
                        deadline_slot: None,
                        not_before_slot: 0,
                        fixed_payer: None,
                    },
                    t.slot,
                ) {
                    engine.set_cu_limit(&key, CU_RESOLVE);
                }
                Ok(Ok(format!(
                    "wide Resolve({}bell {bell}) of ({pk})",
                    if quiet { "quiet " } else { "" }
                )))
            }
        }
    }

    async fn settle<P: ChainPort>(
        &mut self,
        t: &Tick<'_>,
        port: &P,
        engine: &mut Engine,
        e: &crate::playindex::ExpTrack,
        arr: &steps::Arrival,
        acc: &mut BTreeMap<Address, Account>,
    ) -> PortResult<Result<String, String>> {
        let a = t.addrs;
        let ctx = steps::ctx_of(a);
        let Some((a_ts, _)) = anchor_of(port, t, arr.arrive, arr.region).await? else {
            return Ok(Err("the arrival bell resolved without its anchor".into()));
        };
        let close = t.clock.reveal_close(arr.arrive, a_ts);
        let ci = adr(clash_inputs_address(&ctx, arr.dest, arr.arrive));
        read_into(port, &[ci, arr.slot, arr.external, e.holding], acc).await?;
        let inputs = {
            let read = |k: &Address| acc.get(k).cloned();
            match steps::inputs_at(&read, a, arr, arr.arrive) {
                Ok(Some(x)) => x,
                Ok(None) => {
                    return Ok(Err(
                        "the arrival bell resolved without its ClashInputs".into()
                    ))
                }
                Err(er) => return Ok(Err(er)),
            }
        };
        let h = match WideClashInputsHdr::read(&inputs) {
            Ok(h) => h,
            Err(er) => return Ok(Err(format!("ClashInputs: {er:?}"))),
        };
        let row = match WideArrival::read_at(&inputs, arr.position as usize) {
            Ok(r) => r,
            Err(er) => return Ok(Err(format!("arrival row {}: {er:?}", arr.position))),
        };
        if row.as_ref().is_some_and(|r| r.host != arr.host) {
            return Ok(Err("the resolved row is not this arrival's host".into()));
        }
        let fate = row.as_ref().map_or(
            frontier_abi::world_index::arrival::wide_arrival::FATE_NONE,
            |r| r.fate,
        );
        match steps::settle_decision(
            &h,
            row.as_ref(),
            arr.position,
            t.now,
            close + steps::SETTLE_AFTER_CLOSE_SECS,
        ) {
            steps::Settle::Done => Ok(Ok(format!("settled (fate {fate})"))),
            steps::Settle::Wait(w) => Ok(Ok(format!("settlement: {w}"))),
            steps::Settle::Unsupported(f) => Ok(Err(format!(
                "resolved fate {f}: its terminal settlement is not driven here"
            ))),
            steps::Settle::Member => {
                let parties = {
                    let read = |k: &Address| acc.get(k).cloned();
                    steps::member_parties(&read, a, arr, &e.holding, &h)
                };
                let (home, rent_to, slot_ben, resolver, rent_payer) = match parties {
                    Ok(x) => x,
                    Err(er) => return Ok(Err(er)),
                };
                // (the probe's payer is a plain address: the keeper's pool payer is never executable, and the
                //  program's own address there would be — P10 run 4 refused its own probe)
                let probe_payer = solana_signer::Signer::pubkey(&size_signer());
                let probe = steps::settle_member_ix(
                    a,
                    &probe_payer,
                    arr,
                    &e.holding,
                    &home,
                    &rent_to,
                    &slot_ben,
                    &resolver,
                    &rent_payer,
                );
                let probe = match probe {
                    Ok(ix) => ix,
                    Err(er) => return Ok(Err(er)),
                };
                // (the member settlement refuses ANY executable role: named before anything is sent)
                let roles: Vec<Address> = probe.accounts.iter().map(|m| m.pubkey).collect();
                let got = port.accounts(&roles, 0).await?;
                if let Some((i, k)) = roles
                    .iter()
                    .zip(&got)
                    .enumerate()
                    .find(|(_, (k, x))| {
                        **k != probe_payer && x.as_ref().is_some_and(|x| x.executable)
                    })
                    .map(|(i, (k, _))| (i, *k))
                {
                    return Ok(Err(format!(
                        "SettleMember role {i} is the executable account {k}; not sent"
                    )));
                }
                let key = format!("exp-settle:{}:{}", arr.external, arr.arrive);
                let (aa, arr2, holding) = (a.clone(), arr.clone(), e.holding);
                if engine.ensure(
                    WriteSpec {
                        key: key.clone(),
                        kind: "exp-settle",
                        tag: Kind::SettleMember.tag(),
                        class: Class::D,
                        bell: Some(arr.arrive),
                        region: Some(arr.region),
                        build: Arc::new(move |c: &BuildCtx| {
                            steps::settle_member_ix(
                                &aa,
                                &c.payer,
                                &arr2,
                                &holding,
                                &home,
                                &rent_to,
                                &slot_ben,
                                &resolver,
                                &rent_payer,
                            )
                            .map(|ix| vec![ix])
                            .unwrap_or_default()
                        }),
                        deadline_slot: None,
                        not_before_slot: 0,
                        fixed_payer: None,
                    },
                    t.slot,
                ) {
                    engine.set_cu_limit(&key, CU_SETTLE);
                }
                Ok(Ok(format!("SettleMember (fate {fate})")))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use frontier_abi::world_index::{ProvinceKey, WideCoord, WideHostRef};

    /// P10 run 3: the Gather's batch was sized with a probe whose fee payer was not the probe's signer, so every size
    /// "failed" and the transit stopped ("no Gather batch from position 0 fits the packet"). The probe's payer is
    /// [`size_signer`]'s; a one-position batch fits and the widest one stays within the packet.
    #[test]
    fn a_gather_batch_is_sized_against_the_packet_with_the_probe_signer() {
        let a = fclient::addr::Addresses::new(Address::new_from_array([3; 32]), 1);
        let ctx = steps::ctx_of(&a);
        let resolver =
            frontier_abi::world_index::expedition::AccountResolver::for_season(&ctx).unwrap();
        let world = resolver
            .legacy_host_ref(fclient::addr::host_id(128, 0, 1, 0, 0).unwrap())
            .unwrap()
            .key()
            .world();
        let dest = ProvinceKey::new(world, WideCoord::checked(129, 0).unwrap());
        let host = WideHostRef::new(
            ProvinceKey::new(world, WideCoord::checked(128, 0).unwrap()),
            1,
            0,
            0,
        )
        .unwrap();
        let arr = steps::Arrival {
            transit_slot: 0,
            external: Address::new_from_array([4; 32]),
            host,
            faction: 1,
            arrive: 21,
            dest,
            dest_key: Address::new_from_array([5; 32]),
            region: 2,
            position: 4,
            slot: Address::new_from_array([6; 32]),
            commit: [0; 32],
            seal: [0; frontier_abi::world_index::seal::WIDE_SEAL_LEN],
        };
        let read = |_: &Address| None;
        let payer = solana_signer::Signer::pubkey(&size_signer());
        let len = |n: u8| {
            let ix =
                steps::gather_ix_with(&read, &a, &payer, &arr, 21, 0, n, &a.anchor(21, 2)).unwrap();
            encoded_len(std::slice::from_ref(&ix)).unwrap()
        };
        assert!(len(1) <= PACKET_BYTES, "one position fits: {}", len(1));
        let widest = (1..=steps::POSITIONS)
            .take_while(|&n| len(n) <= PACKET_BYTES)
            .last()
            .unwrap();
        assert!(widest >= 1 && len(widest) <= PACKET_BYTES);
        // a probe whose payer the key does not sign is an error, never a size
        let ix = steps::gather_ix_with(
            &read,
            &a,
            &Address::new_from_array([7; 32]),
            &arr,
            21,
            0,
            1,
            &a.anchor(21, 2),
        )
        .unwrap();
        assert!(encoded_len(std::slice::from_ref(&ix)).is_err());
    }
}
