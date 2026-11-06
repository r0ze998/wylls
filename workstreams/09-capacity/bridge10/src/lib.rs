//! Workstream 09 ↔ 10: a workshop job's ore from another owner's custody
//! lot, on workstream 10's one table of lots.
//!
//! Workstream 10 keeps goods in a **lot** (owner M, in keeper V's vault)
//! and lets M grant a **use order** to a user B. Workstream 09 runs B's
//! processing job on a lent workshop. Both sides' goods are in one custody:
//! 10's adapter `LotCustody` (10's lot kernel behind 09's `Custody` trait),
//! whose lot table is the **only** one. This crate is 09's side of the
//! connection: it calls 10's entries and 09's harness in one atomic step,
//! and applies the owner's decisions on what is handed out.
//!
//! * **Into a job** ([`Bridge::deposit_from_lot`]): 10's `release_by_order`
//!   consumes `units` from M's lot under B's order (once per `(job,
//!   deposit id)`; 10 keeps that record) and puts the ore in the job's
//!   transient place; 09's own `Deposit` takes it into the hopper. If 09
//!   refuses after 10 accepted, both are restored.
//! * **Whole units, at the deposit only.** 09's settlements use the hopper
//!   and never call 10, so a partial settlement cannot consume twice or be
//!   refused as a fraction.
//! * **Out of a job** ([`Release`], default [`Release::Decided`], the
//!   owner's decisions of 2026-11-06): the arms are B's; M's unused ore goes
//!   back to M's lot through 10's arrival entry (`import` into the lot,
//!   whole units, ordinary room), the sub-unit rest and anything the lot
//!   cannot take now being owed to it (see `owed`); a captor of the
//!   facility takes what is there (09's loss rule).
//! * **Not decided, not widened:** a job takes ore from one source only
//!   (`MixedSource`); lots hold ore only (10's `ENABLED_RESOURCES`).
//!
//! 10's entry for returns of use-order goods (T3) and the place for the
//! owed rests (T4) are 10's to make; this crate uses what 10 has now.

use std::collections::BTreeMap;

use borsh::{BorshDeserialize, BorshSerialize};
use permutation_rules::fixed::MILLI;
use permutation_rules::frontier::holding::Resource;
use wylls_capacity::custody::{By, Custody, Key};
use wylls_capacity::ledger::{Harness, Op, Outcome};
use wylls_capacity::model::{Actor, JobId, Place};
use wylls_capacity::recipe::recipe;
use wylls_capacity::CapError;
use wylls_custody::CustodyError;
use wylls_custody_adapter_09::{use_place, LotCustody, Refusal, UseLink};

/// The use-order purpose 09's workshop jobs present to 10 (10's contract
/// §7: "PURPOSE の番号は⑨が決める"). **Proposal**, not an assigned number:
/// ④ confirms it with the shared ABI.
pub const PURPOSE_WORKSHOP_ARMS: u16 = 0x0901;

/// Seconds per bell (10's orders expire by bell). The core's clock gives
/// the real conversion; this is its stand-in (10's adapter uses the same).
pub const BELL_SECS: i64 = 600;

/// Custody-key kinds of the bridge's own moves (outside 09's kernel's).
const K_WOOD_REST: u8 = 201;
const K_ORE_OUT: u8 = 202;
const K_RETURN: u8 = 203;

/// A lot in 10's table: vault and owner (ore only).
#[derive(
    Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, BorshSerialize, BorshDeserialize,
)]
pub struct LotKey {
    pub vault: u64,
    pub owner: Actor,
}

/// What a job fed from another owner's lot may hand out.
#[derive(Clone, Copy, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize)]
pub enum Release {
    /// [default; the owner's decisions of 2026-11-06] The products go to
    /// the job's user; the ore left unused goes back to the lot it came
    /// from (whole units by 10's arrival entry; the rest owed to the lot,
    /// credited once it makes whole units and the lot can take it).
    Decided,
    /// Nothing is handed out (the rule before the decision; comparison).
    Hold,
    /// Everything to the job's user (09's rule for own goods; comparison).
    ToUser,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BridgeError {
    /// 09 refused (its code).
    Capacity(CapError),
    /// 10's lot kernel refused (its reason).
    Custody(CustodyError),
    /// 10's adapter refused for 09's reason (a key reused, not there...).
    Adapter(wylls_capacity::custody::CustodyError),
    UnknownVault,
    /// The same deposit id with other terms.
    Conflict,
    /// A job fed from a lot cannot hand out its goods under [`Release::Hold`].
    OwnershipUndecided,
    /// A transient place was not empty after a move.
    Internal,
    /// The lot's vault is not in the facility's province (the owner's
    /// decision of 2026-11-06).
    TooFar,
    /// The job already takes ore from another source. Not decided: kept as
    /// a refusal, not widened (CONNECT-10 §6.3).
    MixedSource,
}

fn from_refusal(r: Refusal) -> BridgeError {
    match r {
        Refusal::Lot(e) => BridgeError::Custody(e),
        Refusal::Nine(wylls_capacity::custody::CustodyError::KeyReused) => BridgeError::Conflict,
        Refusal::Nine(e) => BridgeError::Adapter(e),
    }
}

/// 09's harness on 10's custody, and what the bridge owes to lots.
#[derive(Clone, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize)]
pub struct Bridge {
    pub cap: Harness<LotCustody>,
    pub release: Release,
    /// Ore given back into each lot (milli, whole units).
    pub returned: BTreeMap<LotKey, i64>,
    /// Ore owed to each lot and not yet credited: sub-unit rests, and
    /// whole units the lot could not take (milli). 10's place for it is
    /// open (T4).
    pub owed: BTreeMap<LotKey, i64>,
    /// Sequence of the bridge's credits into lots (custody keys).
    pub credits: u64,
    /// The clock's origin for bells.
    pub genesis: i64,
}

impl Bridge {
    pub fn new(cap: Harness<LotCustody>, genesis: i64) -> Bridge {
        Bridge {
            cap,
            release: Release::Decided,
            returned: BTreeMap::new(),
            owed: BTreeMap::new(),
            credits: 0,
            genesis,
        }
    }

    pub fn bell(&self, now: i64) -> u32 {
        ((now - self.genesis).max(0) / BELL_SECS) as u32
    }

    /// Whether a job took ore from another owner's lot (10's record).
    pub fn lot_fed(&self, job: JobId) -> bool {
        self.cap.custody.lot_fed(job)
    }

    /// The lot a job took ore from (one per job), and how much (milli).
    pub fn lot_of(&self, job: JobId) -> Option<(LotKey, i64)> {
        let mut found: Option<(LotKey, i64)> = None;
        for ((j, _), u) in &self.cap.custody.uses {
            if *j == job {
                let k = LotKey {
                    vault: u.vault,
                    owner: u.owner,
                };
                let q = found.map_or(0, |f| f.1) + u.qty;
                found = Some((k, q));
            }
        }
        found
    }

    /// B deposits `units` of ore from `owner`'s lot in `vault` into job
    /// `job`, under the use order `(slot, order)`, as deposit `deposit`.
    #[allow(clippy::too_many_arguments)]
    pub fn deposit_from_lot(
        &mut self,
        now: i64,
        user: Actor,
        job: JobId,
        deposit: u64,
        vault: u64,
        owner: Actor,
        slot: u8,
        order: u32,
        units: u32,
    ) -> Result<Outcome, BridgeError> {
        let saved = self.clone();
        let r = self.deposit_once(now, user, job, deposit, vault, owner, slot, order, units);
        if r.is_err() {
            *self = saved;
        }
        r
    }

    #[allow(clippy::too_many_arguments)]
    fn deposit_once(
        &mut self,
        now: i64,
        user: Actor,
        job: JobId,
        deposit: u64,
        vault: u64,
        owner: Actor,
        slot: u8,
        order: u32,
        units: u32,
    ) -> Result<Outcome, BridgeError> {
        let qty = units as i64 * MILLI;
        let link = UseLink {
            vault,
            owner,
            grantee: user,
            slot,
            order,
            qty,
            bell: self.bell(now),
        };
        // A replay is answered from 10's record, before anything moves.
        if let Some(l) = self.cap.custody.uses.get(&(job, deposit)) {
            let same = (l.vault, l.owner, l.grantee, l.slot, l.order, l.qty)
                == (vault, owner, user, slot, order, qty);
            return if same {
                Ok(Outcome::AlreadyApplied)
            } else {
                Err(BridgeError::Conflict)
            };
        }
        let j = self
            .cap
            .job(job)
            .ok_or(BridgeError::Capacity(CapError::UnknownJob))?
            .clone();
        let i = recipe(j.recipe)
            .and_then(|r| r.input_index(Resource::Ore))
            .ok_or(BridgeError::Capacity(CapError::WrongResource))?;
        let v = self
            .cap
            .custody
            .vaults
            .get(&vault)
            .ok_or(BridgeError::UnknownVault)?;
        let at = job.grant.facility.at;
        if (v.p, v.q) != (at.p, at.q) {
            return Err(BridgeError::TooFar);
        }
        // One source per job: no other lot, no own ore before.
        let mine = self.lot_of(job);
        if mine.is_some_and(|(k, _)| k != LotKey { vault, owner })
            || j.hopper[i] != mine.map_or(0, |m| m.1)
        {
            return Err(BridgeError::MixedSource);
        }
        // 10: the use order releases the ore into the job's transient place.
        self.cap
            .custody
            .release_by_order(job, j.uid, deposit, link, PURPOSE_WORKSHOP_ARMS)
            .map_err(from_refusal)?;
        // 09: its own Deposit takes it into the hopper.
        let place = use_place(j.uid);
        let out = self
            .cap
            .apply(
                now,
                user,
                &Op::Deposit {
                    job,
                    deposit,
                    resource: Resource::Ore,
                    amount: qty,
                    from: place,
                },
            )
            .map_err(BridgeError::Capacity)?;
        if out == Outcome::AlreadyApplied {
            // The id was used by an own-goods deposit: not this one.
            return Err(BridgeError::Capacity(CapError::Conflict));
        }
        if self.cap.custody.balance(place, Resource::Ore).1 != 0 {
            return Err(BridgeError::Internal);
        }
        Ok(out)
    }

    /// Any of 09's operations. Own ore into a job fed from a lot is refused
    /// (one source); a claim of such a job follows [`Release`]; everything
    /// else passes to 09 unchanged.
    pub fn apply(&mut self, now: i64, signer: Actor, op: &Op) -> Result<Outcome, BridgeError> {
        if let Op::Deposit {
            job,
            deposit,
            resource: Resource::Ore,
            ..
        } = *op
        {
            let held = self
                .cap
                .job(job)
                .is_some_and(|j| j.deposits.iter().any(|d| d.0 == deposit));
            if self.lot_fed(job) && !held {
                return Err(BridgeError::MixedSource);
            }
        }
        let (job, output_to, wood_to, wood_rest_to) = match *op {
            Op::Claim { job, to } => (job, to, to, to),
            Op::ClaimSplit {
                job,
                output_to,
                refund_to,
                remainder_to,
            } => (job, output_to, refund_to[1], remainder_to),
            _ => {
                return self
                    .cap
                    .apply(now, signer, op)
                    .map_err(BridgeError::Capacity)
            }
        };
        if !self.lot_fed(job) {
            return self
                .cap
                .apply(now, signer, op)
                .map_err(BridgeError::Capacity);
        }
        match self.release {
            Release::Hold => Err(BridgeError::OwnershipUndecided),
            Release::ToUser => self
                .cap
                .apply(now, signer, op)
                .map_err(BridgeError::Capacity),
            Release::Decided => {
                let saved = self.clone();
                let r = self.claim_decided(now, signer, job, output_to, wood_to, wood_rest_to);
                if r.is_err() {
                    *self = saved;
                }
                r
            }
        }
    }

    /// The decided claim: products to the user, its wood where it asked,
    /// the ore left unused back to its lot.
    fn claim_decided(
        &mut self,
        now: i64,
        user: Actor,
        job: JobId,
        output_to: Place,
        wood_to: Place,
        wood_rest_to: Place,
    ) -> Result<Outcome, BridgeError> {
        let j = self
            .cap
            .job(job)
            .ok_or(BridgeError::Capacity(CapError::UnknownJob))?
            .clone();
        let (lot, _) = self.lot_of(job).ok_or(BridgeError::Internal)?;
        let t = use_place(j.uid);
        let op = Op::ClaimSplit {
            job,
            output_to,
            refund_to: [t, wood_to],
            remainder_to: t,
        };
        let out = self
            .cap
            .apply(now, user, &op)
            .map_err(BridgeError::Capacity)?;
        let wood = self.cap.custody.balance(t, Resource::Wood).1;
        if wood > 0 {
            let k = Key {
                scope: j.uid,
                kind: K_WOOD_REST,
                n: 0,
            };
            self.cap
                .custody
                .transfer(
                    k,
                    By::Actor(user),
                    t,
                    wood_rest_to,
                    Resource::Wood,
                    wood,
                    user,
                )
                .map_err(BridgeError::Adapter)?;
        }
        let ore = self.cap.custody.balance(t, Resource::Ore).1;
        if ore > 0 {
            let k = Key {
                scope: j.uid,
                kind: K_ORE_OUT,
                n: 0,
            };
            self.cap
                .custody
                .export(k, By::Actor(user), t, Resource::Ore, ore)
                .map_err(BridgeError::Adapter)?;
            *self.owed.entry(lot).or_default() += ore;
            self.pay_owed(lot, j.uid);
        }
        Ok(out)
    }

    /// Credit the whole units owed to `lot` by 10's arrival entry (`import`
    /// into the owner's lot). If 10 refuses (frozen, no room), all of it
    /// stays owed: nothing is lost.
    pub fn pay_owed(&mut self, lot: LotKey, scope: u64) {
        let due = self.owed.get(&lot).copied().unwrap_or(0) / MILLI * MILLI;
        if due == 0 {
            return;
        }
        let k = Key {
            scope,
            kind: K_RETURN,
            n: self.credits,
        };
        let place = Place::Vault(lot.vault);
        if self
            .cap
            .custody
            .import(k, place, lot.owner, Resource::Ore, due)
            .is_ok()
        {
            self.credits += 1;
            *self.owed.get_mut(&lot).expect("owed") -= due;
            *self.returned.entry(lot).or_default() += due;
        }
    }

    /// The connection's invariants (each `Err` names the broken one): 10's
    /// own check (its lots, the use orders' totals, conservation); what was
    /// returned to or is owed to a lot never exceeds what its use orders
    /// gave; every job's accounts balance; no transient place holds goods.
    pub fn check(&self) -> Result<(), String> {
        self.cap.custody.check()?;
        for (lot, back) in self
            .returned
            .iter()
            .map(|(k, v)| (k, *v))
            .chain(self.owed.iter().map(|(k, v)| (k, *v)))
        {
            if back < 0 {
                return Err(format!("lot {lot:?}: negative {back}"));
            }
        }
        let keys: std::collections::BTreeSet<LotKey> = self
            .returned
            .keys()
            .chain(self.owed.keys())
            .copied()
            .collect();
        for lot in keys {
            let given = self
                .cap
                .custody
                .used_total
                .get(&(lot.vault, lot.owner))
                .copied()
                .unwrap_or(0);
            let back = self.returned.get(&lot).copied().unwrap_or(0)
                + self.owed.get(&lot).copied().unwrap_or(0);
            if back > given {
                return Err(format!(
                    "lot {lot:?}: returned and owed {back} > given {given}"
                ));
            }
        }
        for p in self.cap.ledger.pools.values() {
            for j in &p.jobs {
                if !j.accounts().balanced() {
                    return Err(format!("job {:?}: accounts do not balance", j.id));
                }
                for r in [Resource::Ore, Resource::Wood] {
                    if self.cap.custody.balance(use_place(j.uid), r).1 != 0 {
                        return Err(format!("job {:?}: goods left in its transient place", j.id));
                    }
                }
            }
        }
        Ok(())
    }

    /// Bytes to restart from (Borsh: 09's harness with 10's custody, whose
    /// lots are 10's own 576-byte accounts, and the bridge's records).
    pub fn save(&self) -> Vec<u8> {
        borsh::to_vec(self).expect("borsh")
    }

    pub fn load(bytes: &[u8]) -> Option<Bridge> {
        Bridge::try_from_slice(bytes).ok()
    }
}
