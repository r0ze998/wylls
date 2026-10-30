//! **MOCK.** A simulated canonical world: places, the caravan seq rule,
//! caravans with raids and settlement, a facility under use rights, a
//! status history with blockhash validity, an event feed — and the faults
//! the tests inject. Nothing here is the chain or ②'s rights; success
//! against it is *模擬成功* only.
//!
//! What it copies from the real rules (so the executor is tested against
//! them, not against something easier):
//! - SendCaravan refuses a `seq` other than `Citizen.CARAVANS`
//!   (`permutation-frontier/src/proc/caravan.rs`), and a destination of
//!   another generation or not live; a send to another player's place needs
//!   the wallet (S1-1B §3.3).
//! - The cargo leaves after the towers' wear (`CARAVAN_SENT.worn_bps`),
//!   worn in milli-units (`structure::wear` on `units × 1000`); the logs
//!   carry it rounded down to whole units (`cargo_log`), and a holding is
//!   credited the milli amount (so it keeps up to one unit more per
//!   resource than the settle record states).
//! - SettleCaravan credits a vault up to `CAP` and silently drops the rest,
//!   and loses the cargo when the destination is gone or of another
//!   generation; it closes the caravan account (S1-1B §3.4).
//! - A take makes the caravan the raider's (same seed, new owner and
//!   destination); a burn empties it and it goes on (J2).
//! - A signature lands at most once and only until its validity slot.
//!
//! What it invents (proposals, `docs/CONTRACTS.ja.md`): the facility use
//! and its request-key uniqueness; rights with units and an expiry; a
//! settle record stating the credited amount (switchable off, as today).

use std::collections::{BTreeMap, VecDeque};
use std::sync::{Arc, Mutex};

use frontier_abi::v2::log::{caravan_outcome, raid_choice};

use crate::model::{
    res_add, res_ge, res_is_zero, res_sub, CaravanKey, FacilityRef, PlaceRef, Res, ZERO,
};
use crate::ports::*;

#[derive(Clone, Debug)]
pub struct SimPlace {
    pub owner: u64,
    pub live: bool,
    pub gen: u8,
    pub stores: Res,
    /// Milli-units below one whole unit a holding was credited (0..1000
    /// per resource; carried into `stores` at 1000).
    pub frac: Res,
    pub cap: Option<u64>,
    /// A capture-locked holding: SettleCaravan is refused
    /// (`CapturePending`) until SettleCapture; the caravan waits.
    pub capture_locked: bool,
}

#[derive(Clone, Debug)]
pub struct SimCaravan {
    pub owner_now: u64,
    pub src: PlaceRef,
    pub dst: PlaceRef,
    /// The cargo as the logs state it: whole units, rounded down.
    pub cargo: Res,
    /// The milli-units below `cargo` the caravan really carries (0..1000).
    pub frac: Res,
    pub arrive_slot: u64,
    pub raid_open: bool,
    /// Test bookkeeping only (not visible through `Chain`): the request
    /// key of the send that made it.
    pub sig: String,
}

#[derive(Clone, Debug)]
pub struct SimRight {
    pub units: u64,
    pub expires_slot: u64,
}

/// What `send` does with the next request (front of the queue).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SendFault {
    /// It lands and the answer is lost.
    LoseResponse,
    /// It never reaches the leader; the answer is a timeout.
    Timeout,
    /// It lands `n` slots later (if still valid); the answer is a timeout.
    LandLater(u64),
}

#[derive(Default, Debug)]
pub struct Faults {
    pub send: VecDeque<SendFault>,
    /// `status` answers `Unavailable` (no status history).
    pub status_unavailable: bool,
    /// `caravan_history` answers `None` (no entity index).
    pub history_unavailable: bool,
    /// Every read and send fails (RPC down).
    pub down: bool,
    /// Every read but the clock fails (a partial outage).
    pub reads_down: bool,
    /// The feed returns each record twice.
    pub feed_duplicates: bool,
    /// The feed returns each page in reverse order.
    pub feed_reversed: bool,
    /// The feed no longer holds records before this position.
    pub pruned_before: u64,
    /// Settle records omit the credited amount (today's chain).
    pub settle_without_credit: bool,
    /// Taken from a place just before the next send is processed: another
    /// player's action landing between our last check and our send.
    pub spend_before_send: Option<(PlaceRef, Res)>,
}

/// Counters the invariants are checked against.
#[derive(Default, Debug, Clone)]
pub struct Ledger {
    /// Effects per request key (facility key or caravan key).
    pub effects: BTreeMap<String, u32>,
    pub fees: u64,
    pub sends_received: u64,
    /// Goods created by facilities / destroyed (raids, capacity, lost).
    pub produced: Res,
    pub consumed: Res,
    pub destroyed: Res,
    /// Milli-units destroyed (wear; fractions burned, lost or clipped).
    pub destroyed_milli: Res,
    /// Goods added or removed by the test driver itself.
    pub injected: Res,
    pub removed: Res,
}

struct SigRec {
    request: Request,
    valid_until: u64,
    /// `Some(slot, result)` once it landed (successfully or failed).
    landed: Option<(u64, Result<(), Reject>)>,
    land_at: Option<u64>,
}

pub struct SimWorld {
    pub slot: u64,
    pub places: BTreeMap<String, SimPlace>,
    pub seqs: BTreeMap<u64, u32>,
    pub caravans: BTreeMap<(u64, u32), SimCaravan>,
    pub uses: BTreeMap<String, FacilityUse>,
    pub rights: BTreeMap<(u64, FacilityRef), SimRight>,
    sigs: BTreeMap<String, SigRec>,
    log: Vec<EventRec>,
    pub faults: Faults,
    pub ledger: Ledger,
    /// Slots a caravan travels.
    pub travel_slots: u64,
    /// Bps of the cargo the towers take at send.
    pub wear_bps: u64,
    /// Slots a signature stays valid (151 on Solana).
    pub validity: u64,
    pub fee: u64,
    /// Counts `prepare` calls (signatures differ per attempt).
    nonce: u64,
}

impl SimWorld {
    pub fn new() -> SimWorld {
        SimWorld {
            slot: 1,
            places: BTreeMap::new(),
            seqs: BTreeMap::new(),
            caravans: BTreeMap::new(),
            uses: BTreeMap::new(),
            rights: BTreeMap::new(),
            sigs: BTreeMap::new(),
            log: vec![],
            faults: Faults::default(),
            ledger: Ledger::default(),
            travel_slots: 20,
            wear_bps: 0,
            validity: 10,
            fee: 5_000,
            nonce: 0,
        }
    }

    pub fn add_place(&mut self, p: PlaceRef, owner: u64, stores: Res, cap: Option<u64>) {
        self.ledger.injected = res_add(&self.ledger.injected, &stores);
        self.places.insert(
            p.slot_key(),
            SimPlace {
                owner,
                live: true,
                gen: p.gen,
                stores,
                frac: ZERO,
                cap,
                capture_locked: false,
            },
        );
    }

    pub fn grant(&mut self, holder: u64, f: FacilityRef, units: u64, expires_slot: u64) {
        self.rights.insert(
            (holder, f),
            SimRight {
                units,
                expires_slot,
            },
        );
    }

    pub fn revoke(&mut self, holder: u64, f: FacilityRef) {
        self.rights.remove(&(holder, f));
    }

    pub fn stores(&self, p: &PlaceRef) -> Res {
        self.places
            .get(&p.slot_key())
            .map(|x| x.stores)
            .unwrap_or(ZERO)
    }

    /// Someone else spends goods at a place (a player acting by hand).
    pub fn spend(&mut self, p: &PlaceRef, r: &Res) {
        let pl = self.places.get_mut(&p.slot_key()).expect("place");
        let take = crate::model::res_sub(&pl.stores, &res_sub(&pl.stores, r));
        pl.stores = res_sub(&pl.stores, &take);
        self.ledger.removed = res_add(&self.ledger.removed, &take);
    }

    /// Goods arrive by other means (a player's own delivery).
    pub fn deposit(&mut self, p: &PlaceRef, r: &Res) {
        let pl = self.places.get_mut(&p.slot_key()).expect("place");
        pl.stores = res_add(&pl.stores, r);
        self.ledger.injected = res_add(&self.ledger.injected, r);
    }

    fn emit(&mut self, id: String, event: Event) {
        let pos = self.log.len() as u64 + 1;
        self.log.push(EventRec { id, pos, event });
    }

    /// A seizure: the place changes hands and generation (SeizeVault).
    pub fn seize(&mut self, p: &PlaceRef, captor: u64) {
        let pl = self.places.get_mut(&p.slot_key()).expect("place");
        pl.gen = pl.gen.wrapping_add(1);
        pl.owner = captor;
        let (gen, slot) = (pl.gen, self.slot);
        self.emit(
            format!("seize:{}:{}", p.slot_key(), gen),
            Event::PlaceSeized {
                place: *p,
                new_gen: gen,
                slot,
            },
        );
    }

    /// A raid on a moving caravan: the clash opens it, the raider decides.
    pub fn raid(&mut self, key: CaravanKey, take: bool, raider: u64, raider_dst: PlaceRef) {
        let slot = self.slot;
        let c = self
            .caravans
            .get_mut(&(key.owner, key.seq))
            .expect("caravan");
        let taken = c.cargo;
        let frac = c.frac;
        if take {
            c.owner_now = raider;
            c.dst = raider_dst;
            c.arrive_slot = slot + 5;
        } else {
            c.cargo = ZERO;
            c.frac = ZERO;
            self.ledger.destroyed = res_add(&self.ledger.destroyed, &taken);
            self.ledger.destroyed_milli = res_add(&self.ledger.destroyed_milli, &frac);
        }
        c.raid_open = false;
        self.emit(
            format!("raid:{}:{slot}", key.text()),
            Event::CaravanRaided(Raid {
                key,
                choice: if take {
                    raid_choice::TAKE
                } else {
                    raid_choice::BURN
                },
                raider,
                taken,
                slot,
            }),
        );
    }

    /// Test hook: a raid record reaching the log on its own (a record the
    /// feed delivers late, after the settlement it explains). The world's
    /// goods do not change; only the record is added.
    pub fn log_raid_record(&mut self, raid: Raid) {
        self.emit(
            format!("raid:{}:{}", raid.key.text(), raid.slot),
            Event::CaravanRaided(raid),
        );
    }

    /// A player's own SendCaravan (takes the owner's next seq).
    pub fn manual_send(
        &mut self,
        owner: u64,
        src: PlaceRef,
        dst: PlaceRef,
        cargo: Res,
    ) -> CaravanKey {
        let seq = *self.seqs.get(&owner).unwrap_or(&0);
        let req = Request::SendCaravan {
            owner,
            seq,
            src,
            dst,
            cargo,
        };
        self.execute(&req, &format!("manual:{owner}:{seq}"))
            .expect("manual send");
        CaravanKey { owner, seq }
    }

    /// Moves the clock: late landings, then settlements.
    pub fn advance(&mut self, slots: u64) {
        for _ in 0..slots {
            self.slot += 1;
            let due: Vec<String> = self
                .sigs
                .iter()
                .filter(|(_, s)| s.landed.is_none() && s.land_at.is_some_and(|t| t <= self.slot))
                .map(|(k, _)| k.clone())
                .collect();
            for sig in due {
                let (req, valid) = {
                    let s = &self.sigs[&sig];
                    (s.request.clone(), s.valid_until)
                };
                self.sigs.get_mut(&sig).unwrap().land_at = None;
                if self.slot <= valid {
                    self.land(&sig, &req);
                }
            }
            let settle: Vec<(u64, u32)> = self
                .caravans
                .iter()
                .filter(|(_, c)| {
                    c.arrive_slot <= self.slot
                        && !c.raid_open
                        && !self
                            .places
                            .get(&c.dst.slot_key())
                            .is_some_and(|p| p.capture_locked && p.gen == c.dst.gen)
                })
                .map(|(k, _)| *k)
                .collect();
            for k in settle {
                self.settle(k);
            }
        }
    }

    fn settle(&mut self, k: (u64, u32)) {
        let c = self.caravans.remove(&k).unwrap();
        let key = CaravanKey {
            owner: k.0,
            seq: k.1,
        };
        let slot = self.slot;
        let mut credited = ZERO;
        let outcome = match self.places.get_mut(&c.dst.slot_key()) {
            Some(pl) if pl.live && pl.gen == c.dst.gen => {
                for ((k, have), want) in credited.iter_mut().zip(pl.stores.iter_mut()).zip(c.cargo)
                {
                    let room = pl.cap.map_or(u64::MAX, |cap| cap.saturating_sub(*have));
                    *k = want.min(room);
                    *have += *k;
                }
                if pl.cap.is_none() {
                    // A holding: credited in milli-units, the fraction too.
                    for r in 0..c.frac.len() {
                        pl.frac[r] += c.frac[r];
                        pl.stores[r] += pl.frac[r] / 1000;
                        pl.frac[r] %= 1000;
                    }
                } else {
                    // MOCK simplification: a vault keeps whole units only.
                    self.ledger.destroyed_milli = res_add(&self.ledger.destroyed_milli, &c.frac);
                }
                caravan_outcome::DELIVERED
            }
            _ => {
                self.ledger.destroyed_milli = res_add(&self.ledger.destroyed_milli, &c.frac);
                caravan_outcome::LOST
            }
        };
        self.ledger.destroyed = res_add(&self.ledger.destroyed, &res_sub(&c.cargo, &credited));
        let credited_field = (!self.faults.settle_without_credit).then_some(credited);
        self.emit(
            format!("settle:{}", key.text()),
            Event::CaravanSettled(Settle {
                key,
                outcome,
                dst: c.dst,
                cargo: c.cargo,
                credited: credited_field,
                slot,
            }),
        );
    }

    /// The canonical effect of a request, atomically, or a refusal.
    fn execute(&mut self, req: &Request, sig: &str) -> Result<(), Reject> {
        match req {
            Request::UseFacility {
                key,
                holder,
                facility,
                stock,
                inputs,
                outputs,
                rights_units,
            } => {
                if self.uses.contains_key(key) {
                    return Err(Reject::AlreadyDone);
                }
                let fac_live = self
                    .places
                    .get(&facility.place.slot_key())
                    .is_some_and(|p| p.live && p.gen == facility.place.gen);
                if !fac_live {
                    return Err(Reject::FacilityGone);
                }
                match self.rights.get(&(*holder, *facility)) {
                    None => return Err(Reject::RightsExpired),
                    Some(r) if r.expires_slot <= self.slot => return Err(Reject::RightsExpired),
                    Some(r) if r.units < *rights_units => return Err(Reject::RightsInsufficient),
                    _ => {}
                }
                let st = self
                    .places
                    .get(&stock.slot_key())
                    .ok_or(Reject::Insufficient)?;
                if !st.live || st.owner != *holder || !res_ge(&st.stores, inputs) {
                    return Err(Reject::Insufficient);
                }
                let st = self.places.get_mut(&stock.slot_key()).unwrap();
                st.stores = res_add(&res_sub(&st.stores, inputs), outputs);
                self.rights.get_mut(&(*holder, *facility)).unwrap().units -= rights_units;
                self.ledger.consumed = res_add(&self.ledger.consumed, inputs);
                self.ledger.produced = res_add(&self.ledger.produced, outputs);
                *self.ledger.effects.entry(key.clone()).or_default() += 1;
                let u = FacilityUse {
                    key: key.clone(),
                    sig: sig.to_string(),
                    slot: self.slot,
                    consumed: *inputs,
                    produced: *outputs,
                    rights_units: *rights_units,
                };
                self.uses.insert(key.clone(), u.clone());
                self.emit(format!("{sig}:0"), Event::FacilityUsed(u));
                Ok(())
            }
            Request::SendCaravan {
                owner,
                seq,
                src,
                dst,
                cargo,
            } => {
                if *seq != *self.seqs.get(owner).unwrap_or(&0) {
                    return Err(Reject::SeqMismatch);
                }
                let s = self
                    .places
                    .get(&src.slot_key())
                    .ok_or(Reject::Insufficient)?;
                if !s.live || s.owner != *owner || res_is_zero(cargo) || !res_ge(&s.stores, cargo) {
                    return Err(Reject::Insufficient);
                }
                let d = self
                    .places
                    .get(&dst.slot_key())
                    .ok_or(Reject::DestinationChanged)?;
                if !d.live || d.gen != dst.gen {
                    return Err(Reject::DestinationChanged);
                }
                if d.owner != *owner {
                    return Err(Reject::WalletRequired);
                }
                let s = self.places.get_mut(&src.slot_key()).unwrap();
                s.stores = res_sub(&s.stores, cargo);
                // structure::wear on milli-units: v - floor(v × bps / 10_000).
                let (mut after, mut frac) = (ZERO, ZERO);
                for r in 0..cargo.len() {
                    let m = cargo[r] * 1000;
                    let worn = m - m * self.wear_bps.min(10_000) / 10_000;
                    after[r] = worn / 1000;
                    frac[r] = worn % 1000;
                    self.ledger.destroyed_milli[r] += m - worn;
                }
                self.seqs.insert(*owner, seq + 1);
                let key = CaravanKey {
                    owner: *owner,
                    seq: *seq,
                };
                *self.ledger.effects.entry(key.text()).or_default() += 1;
                let arrive_slot = self.slot + self.travel_slots;
                self.caravans.insert(
                    (*owner, *seq),
                    SimCaravan {
                        owner_now: *owner,
                        src: *src,
                        dst: *dst,
                        cargo: after,
                        frac,
                        arrive_slot,
                        raid_open: false,
                        sig: sig.to_string(),
                    },
                );
                self.emit(
                    format!("{sig}:0"),
                    Event::CaravanSent {
                        key,
                        sig: sig.to_string(),
                        src: *src,
                        dst: *dst,
                        cargo: after,
                        arrive_slot,
                    },
                );
                Ok(())
            }
        }
    }

    fn land(&mut self, sig: &str, req: &Request) {
        let r = self.execute(req, sig);
        self.ledger.fees += self.fee;
        self.sigs.get_mut(sig).unwrap().landed = Some((self.slot, r));
    }

    /// Goods are neither created nor lost outside the ledger's accounts.
    pub fn audit(&self) -> Result<(), String> {
        // In milli-units: wear and a holding's credit keep fractions.
        let milli = |x: &Res| x.map(|v| v * 1000);
        let mut held = ZERO;
        for p in self.places.values() {
            held = res_add(&held, &res_add(&milli(&p.stores), &p.frac));
        }
        for c in self.caravans.values() {
            held = res_add(&held, &res_add(&milli(&c.cargo), &c.frac));
        }
        let mut expect = res_add(&self.ledger.injected, &self.ledger.produced);
        expect = res_sub(&expect, &self.ledger.consumed);
        expect = res_sub(&expect, &self.ledger.destroyed);
        expect = res_sub(&expect, &self.ledger.removed);
        let expect = res_sub(&milli(&expect), &self.ledger.destroyed_milli);
        if held != expect {
            return Err(format!("conservation: held {held:?} ≠ expected {expect:?}"));
        }
        if let Some((k, n)) = self.ledger.effects.iter().find(|(_, n)| **n > 1) {
            return Err(format!("request {k} took effect {n} times"));
        }
        Ok(())
    }

    /// A transaction someone else signed and sent (an agent gateway): it
    /// lands now with this signature, as the scripted chain behind the
    /// gateway confirmed it. The fee is the relay's, not the run owner's,
    /// so it is not added to `ledger.fees`. MOCK: the effect is this
    /// world's rule, applied to the request decoded from the signed bytes.
    pub fn land_external(
        &mut self,
        sig: &str,
        req: &Request,
        valid_until: u64,
    ) -> Result<(), Reject> {
        if let Some(SigRec {
            landed: Some((_, r)),
            ..
        }) = self.sigs.get(sig)
        {
            return r.clone();
        }
        self.sigs.insert(
            sig.to_string(),
            SigRec {
                request: req.clone(),
                valid_until,
                landed: None,
                land_at: None,
            },
        );
        let r = self.execute(req, sig);
        let slot = self.slot;
        self.sigs.get_mut(sig).unwrap().landed = Some((slot, r.clone()));
        r
    }

    /// Whether a signature landed and took effect (test bookkeeping).
    pub fn took_effect(&self, sig: &str) -> bool {
        matches!(
            self.sigs.get(sig),
            Some(SigRec {
                landed: Some((_, Ok(()))),
                ..
            })
        )
    }

    pub fn effects(&self, key: &str) -> u32 {
        self.ledger.effects.get(key).copied().unwrap_or(0)
    }

    pub fn log_len(&self) -> usize {
        self.log.len()
    }
}

impl Default for SimWorld {
    fn default() -> Self {
        SimWorld::new()
    }
}

/// A handle every executor and the test driver share.
#[derive(Clone)]
pub struct Sim(pub Arc<Mutex<SimWorld>>);

impl Sim {
    pub fn new(w: SimWorld) -> Sim {
        Sim(Arc::new(Mutex::new(w)))
    }
    pub fn with<T>(&self, f: impl FnOnce(&mut SimWorld) -> T) -> T {
        f(&mut self.0.lock().unwrap())
    }
}

fn down(w: &SimWorld) -> PortResult<()> {
    if w.faults.down || w.faults.reads_down {
        Err(PortError::Unavailable("sim: down".into()))
    } else {
        Ok(())
    }
}

impl Chain for Sim {
    fn slot(&self) -> PortResult<u64> {
        let w = self.0.lock().unwrap();
        if w.faults.down {
            return Err(PortError::Unavailable("sim: down".into()));
        }
        Ok(w.slot)
    }

    fn place(&self, p: &PlaceRef) -> PortResult<Option<PlaceView>> {
        let w = self.0.lock().unwrap();
        down(&w)?;
        Ok(w.places.get(&p.slot_key()).map(|x| PlaceView {
            live: x.live,
            gen: x.gen,
            owner: x.owner,
            stores: x.stores,
            cap: x.cap,
        }))
    }

    fn caravan_seq(&self, owner: u64) -> PortResult<u32> {
        let w = self.0.lock().unwrap();
        down(&w)?;
        Ok(*w.seqs.get(&owner).unwrap_or(&0))
    }

    fn caravan(&self, key: CaravanKey) -> PortResult<Option<CaravanView>> {
        let w = self.0.lock().unwrap();
        down(&w)?;
        Ok(w.caravans.get(&(key.owner, key.seq)).map(|c| CaravanView {
            owner_now: c.owner_now,
            src: c.src,
            dst: c.dst,
            cargo: c.cargo,
            arrive_slot: c.arrive_slot,
            raid_open: c.raid_open,
        }))
    }

    fn facility_use(&self, key: &str) -> PortResult<Option<FacilityUse>> {
        let w = self.0.lock().unwrap();
        down(&w)?;
        Ok(w.uses.get(key).cloned())
    }

    fn caravan_history(&self, key: CaravanKey) -> PortResult<Option<Vec<EventRec>>> {
        let w = self.0.lock().unwrap();
        down(&w)?;
        if w.faults.history_unavailable {
            return Ok(None);
        }
        Ok(Some(
            w.log
                .iter()
                .filter(|r| r.event.caravan() == Some(key))
                .cloned()
                .collect(),
        ))
    }

    fn events(&self, after: u64, limit: usize) -> PortResult<EventPage> {
        let w = self.0.lock().unwrap();
        down(&w)?;
        let start = after.max(w.faults.pruned_before.saturating_sub(1));
        let gap = after + 1 < w.faults.pruned_before;
        let mut events: Vec<EventRec> = w
            .log
            .iter()
            .filter(|r| r.pos > start)
            .take(limit)
            .cloned()
            .collect();
        // An empty page never moves the cursor past the end of the log.
        let next = events
            .last()
            .map_or(start.min(w.log.len() as u64).max(after), |r| r.pos);
        if w.faults.feed_duplicates {
            events = events.into_iter().flat_map(|r| [r.clone(), r]).collect();
        }
        if w.faults.feed_reversed {
            events.reverse();
        }
        Ok(EventPage { events, gap, next })
    }

    fn prepare(&self, req: &Request, n: u32) -> PortResult<Prepared> {
        use sha2::Digest;
        let mut w = self.0.lock().unwrap();
        down(&w)?;
        w.nonce += 1;
        let h =
            sha2::Sha256::digest(format!("{}|{n}|{}|{}", req.key(), w.slot, w.nonce).as_bytes());
        Ok(Prepared {
            sig: hex::encode(&h[..20]),
            wire: serde_json::to_vec(req).unwrap_or_default(),
            request: req.clone(),
            valid_until: w.slot + w.validity,
            fee: w.fee,
        })
    }

    fn send(&self, p: &Prepared) -> SendResult {
        let mut w = self.0.lock().unwrap();
        if w.faults.down {
            return SendResult::Unknown("sim: down".into());
        }
        w.ledger.sends_received += 1;
        if let Some((place, r)) = w.faults.spend_before_send.take() {
            w.spend(&place, &r);
        }
        if let Some(s) = w.sigs.get(&p.sig) {
            // The same signed bytes again: a no-op (AlreadyProcessed).
            return match &s.landed {
                Some((_, Err(r))) => SendResult::Rejected(r.clone()),
                _ => SendResult::Accepted,
            };
        }
        if w.slot > p.valid_until {
            return SendResult::Rejected(Reject::Expired);
        }
        let fault = w.faults.send.pop_front();
        if fault == Some(SendFault::Timeout) {
            return SendResult::Unknown("sim: timeout before the leader".into());
        }
        w.sigs.insert(
            p.sig.clone(),
            SigRec {
                request: p.request.clone(),
                valid_until: p.valid_until,
                landed: None,
                land_at: None,
            },
        );
        if let Some(SendFault::LandLater(n)) = fault {
            let at = w.slot + n;
            w.sigs.get_mut(&p.sig).unwrap().land_at = Some(at);
            return SendResult::Unknown("sim: timeout (it is still on its way)".into());
        }
        // Preflight: a request the canonical state refuses is not forwarded
        // by this RPC. It is NOT dead: the same signed bytes sent again
        // (another executor, another RPC) may land while still valid, and
        // `status` answers Pending until `valid_until` as the chain would.
        let sig = p.sig.clone();
        let r = w.execute(&p.request, &sig);
        let slot = w.slot;
        match r {
            Ok(()) => {
                w.ledger.fees += w.fee;
                w.sigs.get_mut(&sig).unwrap().landed = Some((slot, Ok(())));
                if fault == Some(SendFault::LoseResponse) {
                    SendResult::Unknown("sim: response lost".into())
                } else {
                    SendResult::Accepted
                }
            }
            Err(rj) => {
                w.sigs.remove(&sig);
                SendResult::Rejected(rj)
            }
        }
    }

    fn status(&self, sig: &str, valid_until: u64) -> PortResult<SigStatus> {
        let w = self.0.lock().unwrap();
        down(&w)?;
        if w.faults.status_unavailable {
            return Ok(SigStatus::Unavailable);
        }
        Ok(match w.sigs.get(sig) {
            Some(SigRec {
                landed: Some((slot, Ok(()))),
                ..
            }) => SigStatus::Landed {
                slot: *slot,
                fee: Some(w.fee),
            },
            Some(SigRec {
                landed: Some((slot, Err(r))),
                ..
            }) => SigStatus::Failed {
                slot: *slot,
                fee: Some(w.fee),
                reject: r.clone(),
            },
            Some(s) if w.slot <= s.valid_until => SigStatus::Pending,
            None if w.slot <= valid_until => SigStatus::Pending,
            _ => SigStatus::Absent,
        })
    }
}

impl Rights for Sim {
    fn check(&self, holder: u64, facility: &FacilityRef, units: u64) -> PortResult<RightsVerdict> {
        let w = self.0.lock().unwrap();
        down(&w)?;
        Ok(match w.rights.get(&(holder, *facility)) {
            None => RightsVerdict::None,
            Some(r) if r.expires_slot <= w.slot => RightsVerdict::Expired,
            Some(r) if r.units < units => RightsVerdict::Insufficient { remaining: r.units },
            Some(r) => RightsVerdict::Allowed {
                remaining: r.units,
                expires_slot: r.expires_slot,
            },
        })
    }
}
