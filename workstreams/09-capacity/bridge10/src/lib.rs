//! Workstream 09 ↔ 10: a workshop job's ore from a custody lot.
//!
//! Workstream 10 keeps goods in a **lot** (owner M, in custodian V's
//! vault) and lets M grant a **use order** to a user B, who may then
//! consume up to the order's quantity for a purpose (`wylls_custody::
//! consume`; 10's contract §7). Workstream 09 runs B's processing job on a
//! lent workshop. This crate is the connection: [`Bridge::deposit_from_lot`]
//! consumes ore from M's lot under B's use order and puts it into B's job
//! hopper, as one atomic step.
//!
//! What it holds to (CONNECT-10.ja.md):
//!
//! * **Once per deposit id.** 10's `consume` is not idempotent: each call
//!   spends from the order again. The bridge keys every call by 09's
//!   `(job, deposit id)` and answers a replay from its own record, before
//!   10 is called. On chain, the job account's deposit table is that key.
//! * **Whole units, at the deposit only.** 10 moves whole units (×1,000
//!   milli); 09 converts in milli over time. The lot is consumed once, when
//!   the ore enters the hopper; 09's settlements then use the hopper and
//!   never call 10, so a partial settlement cannot consume twice or be
//!   refused as a fraction.
//! * **Atomic.** If 09 refuses the deposit after 10 accepted the
//!   consumption (the job started, its deposit table is full, a key
//!   conflicts), everything is restored: nothing is consumed.
//! * **Ore only from lots.** 10 enables only ore. Wood comes by 09's own
//!   deposit; arms stay in 09's output place (10 has no entry for them).
//! * **The owner's decisions of 2026-11-06** ([`Release::Decided`], the
//!   default): the arms made from M's ore are B's; the ore left unused goes
//!   back to M's lot. [`Release::Hold`] (nothing handed out) and
//!   [`Release::ToUser`] (everything to B) stay for comparison. Mixing
//!   sources in one job (`MixedSource`) and the resources lots hold are
//!   not decided and not widened.
//!
//! 09's custody (the job's hopper and output, places, the user's own lots)
//! is workstream 10's adapter, `wylls_custody_adapter_09::LotCustody`
//! (10's lot kernel behind 09's `Custody` trait): a user's own lot is a
//! vault place there, with room reserved for the goods' return. The lots
//! used under another owner's use order are the same lots, in the same
//! table (10's `release_by_order` and `try_return_unused`; CONNECT-10 §5.4
//! T1, T3, T4): a use takes from the lot once (`CONSUMED`), unused ore goes
//! back un-consumed (not counted in again), and a sub-unit rest is owed in
//! 10's custody until it makes whole units.

use std::collections::BTreeMap;

use borsh::{BorshDeserialize, BorshSerialize};
use permutation_rules::fixed::MILLI;
use permutation_rules::frontier::holding::Resource;
use wylls_capacity::custody::{Custody, Key};
use wylls_capacity::ledger::{Harness, Op, Outcome};
use wylls_capacity::model::{Actor, JobId, Place};
use wylls_capacity::recipe::recipe;
use wylls_capacity::CapError;
use wylls_custody::{CustodyError, Lot, VaultView};
use wylls_custody_adapter_09::{use_place, vault_id, LotCustody, Refusal, UseLink};

/// The use-order purpose 09's workshop jobs present to 10 (10's contract
/// §7: "PURPOSE の番号は⑨が決める"). **Proposal**, not an assigned number:
/// ④ confirms it with the shared ABI (CONNECT-10.ja.md §5).
pub const PURPOSE_WORKSHOP_ARMS: u16 = 0x0901;

/// Seconds per bell (10's orders expire by bell). The core's season clock
/// gives the real conversion; this is its stand-in.
pub const BELL_SECS: i64 = 600;

/// Custody-key kind for the ore a lot releases into 09 (outside every kind
/// 09's kernel uses).
const K_FROM_LOT: u8 = 200;

/// A lot by the fields of its address seed (10's `cl‖P,Q,tile,gen,
/// owner_tag,resource`).
#[derive(
    Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, BorshSerialize, BorshDeserialize,
)]
pub struct LotId {
    pub p: i16,
    pub q: i16,
    pub tile: u8,
    pub gen: u8,
    pub owner_tag: u64,
    pub resource: u8,
}

impl LotId {
    pub fn of(l: &Lot) -> LotId {
        LotId {
            p: l.p,
            q: l.q,
            tile: l.tile,
            gen: l.vault_gen,
            owner_tag: l.owner_tag,
            resource: l.resource,
        }
    }
}

/// What a job fed from a lot may hand out (the open ownership question).
#[derive(Clone, Copy, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize)]
pub enum Release {
    /// [default; the owner's decisions of 2026-11-06] The products go to
    /// the job's user; the ore left unused goes back into the lot it came
    /// from, un-consumed (whole units through 10's `try_return_unused`; the
    /// sub-unit rest is owed in 10's custody and credited once it makes
    /// whole units). If the lot cannot take it (frozen, no room), all of it
    /// stays owed.
    Decided,
    /// Nothing: products and leftovers stay in the job's places (the rule
    /// before the decision; kept for comparison).
    Hold,
    /// Everything to the job's user, leftovers included (09's rule for its
    /// own materials; kept for comparison).
    ToUser,
}

/// One deposit fed from a lot.
#[derive(Clone, Copy, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize)]
pub struct Link {
    pub lot: LotId,
    pub slot: u8,
    pub order: u32,
    /// Milli (a whole number of units).
    pub qty: i64,
    pub bell: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BridgeError {
    /// 09 refused (its code).
    Capacity(CapError),
    /// 10 refused (its kernel's reason).
    Custody(CustodyError),
    UnknownLot,
    UnknownVault,
    /// The same deposit id with other terms.
    Conflict,
    /// The lot's resource is not an input of the job's recipe.
    Resource,
    /// A job fed from a lot cannot hand out its goods under [`Release::Hold`].
    OwnershipUndecided,
    /// A job's place used for lot ore was not empty after the move.
    Internal,
    /// The lot's vault is not in the facility's province (the owner's
    /// decision of 2026-11-06: same province is direct use; farther goods
    /// travel by caravan first).
    TooFar,
    /// The job already takes this resource from another source (the user's
    /// own goods or another lot): a job takes each resource from one
    /// source, so whose ore is left over is never ambiguous.
    MixedSource,
}

/// The two kernels side by side: 09's harness (facilities, pools, jobs,
/// its custody) and 10's vaults and lots.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Bridge {
    /// 09's harness over 10's custody: every lot (own or used under an
    /// order), what went back to each and what is owed to it are there.
    pub cap: Harness<LotCustody>,
    pub links: BTreeMap<(JobId, u64), Link>,
    pub release: Release,
    /// The clock's origin for bells.
    pub genesis: i64,
}

/// 10's signer for a 09 actor: the Citizen key, a tag derived from it (the
/// core's `citizen_tag` stands here), by wallet.
pub fn actor10(a: Actor) -> wylls_custody::Actor {
    wylls_custody::Actor {
        citizen: a.0,
        tag: tag_of(a),
        by_session: false,
    }
}

pub fn tag_of(a: Actor) -> u64 {
    u64::from_le_bytes(a.0[..8].try_into().expect("32 bytes"))
}

/// The transient place a lot's ore passes through on its way into a job
/// (one per job; empty after every step). Not a vault: in 10's adapter a
/// vault place is lots.
pub fn release_place(uid: u64) -> Place {
    Place::Caravan(RELEASE_MARK | (uid & 0x0000_FFFF_FFFF_FFFF))
}

const RELEASE_MARK: u64 = 0xF10A_0000_0000_0000;

impl Bridge {
    pub fn new(cap: Harness<LotCustody>, genesis: i64) -> Bridge {
        Bridge {
            cap,
            links: BTreeMap::new(),
            release: Release::Decided,
            genesis,
        }
    }

    /// Puts a vault and a lot built by 10's kernel functions into 10's
    /// custody (its one lot table).
    pub fn add_lot(&mut self, v: VaultView, lot: Lot) -> LotId {
        self.cap.custody.adopt_lot(&v, &lot).expect("a new lot");
        LotId::of(&lot)
    }

    /// 10's key of a lot: its vault and its owner.
    fn key10(&self, lot: LotId) -> Option<(u64, Actor)> {
        let v = vault_id(lot.p, lot.q, lot.tile);
        self.cap
            .custody
            .find_lot(v, lot.owner_tag, lot.resource)
            .map(|(o, _)| (v, o))
    }

    /// The lot as 10 holds it.
    pub fn lot(&self, lot: LotId) -> Option<Lot> {
        let (v, o) = self.key10(lot)?;
        self.cap.custody.lot(v, o, lot.resource)
    }

    /// The lot's vault in 10's custody.
    pub fn vault_mut(&mut self, lot: LotId) -> Option<&mut wylls_custody_adapter_09::Vault> {
        self.cap
            .custody
            .vaults
            .get_mut(&vault_id(lot.p, lot.q, lot.tile))
    }

    /// Runs `f` on the lot as 10 holds it (10's kernel functions on the
    /// account, written back).
    pub fn edit_lot<T>(
        &mut self,
        lot: LotId,
        f: impl FnOnce(&VaultView, &mut Lot) -> T,
    ) -> Option<T> {
        let (v, o) = self.key10(lot)?;
        self.cap.custody.with_lot(v, o, lot.resource, f)
    }

    /// Ore given back into the lot (whole units, un-consumed).
    pub fn returned(&self, lot: LotId) -> i64 {
        self.key10(lot)
            .and_then(|k| self.cap.custody.returned_total.get(&k).copied())
            .unwrap_or(0)
    }

    /// Ore owed to the lot and not yet in it.
    pub fn owed(&self, lot: LotId) -> i64 {
        self.key10(lot)
            .and_then(|k| self.cap.custody.owed.get(&k).copied())
            .unwrap_or(0)
    }

    pub fn bell(&self, now: i64) -> u32 {
        ((now - self.genesis).max(0) / BELL_SECS) as u32
    }

    /// Whether a job took any ore from a lot.
    pub fn lot_fed(&self, job: JobId) -> bool {
        self.links.keys().any(|(j, _)| *j == job)
    }

    /// B deposits `units` of ore from lot `lot` into its job `job`, under
    /// the use order `(slot, order)` of that lot, as deposit `deposit`.
    #[allow(clippy::too_many_arguments)]
    pub fn deposit_from_lot(
        &mut self,
        now: i64,
        user: Actor,
        job: JobId,
        deposit: u64,
        lot: LotId,
        slot: u8,
        order: u32,
        units: u32,
    ) -> Result<Outcome, BridgeError> {
        let qty = units as i64 * MILLI;
        // A replay is answered from the record, before 10 is called; only
        // to the job's user, as 09's kernel answers its own deposits.
        if let Some(l) = self.links.get(&(job, deposit)) {
            if self.cap.job(job).is_some_and(|j| j.user != user) {
                return Err(BridgeError::Capacity(CapError::NotUser));
            }
            return if (l.lot, l.slot, l.order, l.qty) == (lot, slot, order, qty) {
                Ok(Outcome::AlreadyApplied)
            } else {
                Err(BridgeError::Conflict)
            };
        }
        let saved = self.clone();
        let r = self.deposit_once(now, user, job, deposit, lot, slot, order, qty);
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
        lot: LotId,
        slot: u8,
        order: u32,
        qty: i64,
    ) -> Result<Outcome, BridgeError> {
        let j = self
            .cap
            .job(job)
            .ok_or(BridgeError::Capacity(CapError::UnknownJob))?
            .clone();
        let res = Resource::ALL
            .get(lot.resource as usize)
            .copied()
            .ok_or(BridgeError::Resource)?;
        let r = recipe(j.recipe).ok_or(BridgeError::Resource)?;
        let i = r.input_index(res).ok_or(BridgeError::Resource)?;
        let at = job.grant.facility.at;
        if (lot.p, lot.q) != (at.p, at.q) {
            return Err(BridgeError::TooFar);
        }
        // One source per resource: no other lot, no own goods before.
        let mine = self.lot_qty(job);
        if self
            .links
            .iter()
            .any(|((x, _), k)| *x == job && k.lot != lot)
            || j.hopper[i] != mine
        {
            return Err(BridgeError::MixedSource);
        }
        let bell = self.bell(now);
        // 10: the use order's grantee consumes from the lot, and the ore
        // waits as the user's in 10's transit place for the job.
        let (v, owner) = self.key10(lot).ok_or(BridgeError::UnknownLot)?;
        let link10 = UseLink {
            vault: v,
            owner,
            grantee: user,
            slot,
            order,
            qty,
            bell,
        };
        self.cap
            .custody
            .release_by_order(job, j.uid, deposit, link10, PURPOSE_WORKSHOP_ARMS)
            .map_err(|e| match e {
                Refusal::Lot(e) => BridgeError::Custody(e),
                Refusal::Nine(_) => BridgeError::Conflict,
            })?;
        let place = use_place(j.uid);
        let out = self
            .cap
            .apply(
                now,
                user,
                &Op::Deposit {
                    job,
                    deposit,
                    resource: res,
                    amount: qty,
                    from: place,
                },
            )
            .map_err(BridgeError::Capacity)?;
        if out == Outcome::AlreadyApplied {
            // The id was used by an own-goods deposit: not this one.
            return Err(BridgeError::Conflict);
        }
        if self.cap.custody.balance(place, res).1 != 0 {
            return Err(BridgeError::Internal);
        }
        self.links.insert(
            (job, deposit),
            Link {
                lot,
                slot,
                order,
                qty,
                bell,
            },
        );
        Ok(out)
    }

    /// Ore a job took from lots (milli).
    pub fn lot_qty(&self, job: JobId) -> i64 {
        self.links
            .iter()
            .filter(|((x, _), _)| *x == job)
            .map(|(_, k)| k.qty)
            .sum()
    }

    /// The lot a job took ore from, if any (one per job).
    pub fn lot_of(&self, job: JobId) -> Option<LotId> {
        self.links
            .iter()
            .find(|((x, _), _)| *x == job)
            .map(|(_, k)| k.lot)
    }

    /// Any of 09's operations. A deposit of the user's own ore into a job
    /// fed from a lot is refused (one source per resource). A claim of a
    /// job fed from a lot follows [`Release`]; everything else passes to 09
    /// unchanged.
    pub fn apply(&mut self, now: i64, signer: Actor, op: &Op) -> Result<Outcome, BridgeError> {
        // Own ore into a job fed from a lot (a lot's ore never comes this
        // way: it enters by `deposit_from_lot`). A replay of a deposit the
        // job already holds is 09's to answer.
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

    /// The decided claim of a job fed from a lot: products to the user,
    /// wood (the user's own) to the user's places, the ore left unused
    /// back to its lot.
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
        let t = release_place(j.uid);
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
        // The wood's sub-unit rest is the user's: on to where it asked.
        let wood = self.cap.custody.balance(t, Resource::Wood).1;
        if wood > 0 {
            self.cap
                .custody
                .transfer(
                    Key {
                        scope: j.uid,
                        kind: K_FROM_LOT + 1,
                        n: 0,
                    },
                    wylls_capacity::custody::By::Actor(user),
                    t,
                    wood_rest_to,
                    Resource::Wood,
                    wood,
                    user,
                )
                .map_err(|_| BridgeError::Internal)?;
        }
        // The ore goes back to its lot: whole units un-consumed, the rest
        // owed in 10's custody until it makes whole units.
        let ore = self.cap.custody.balance(t, Resource::Ore).1;
        if ore > 0 {
            let lot = self.lot_of(job).ok_or(BridgeError::Internal)?;
            let (v, owner) = self.key10(lot).ok_or(BridgeError::UnknownLot)?;
            self.cap
                .custody
                .try_return_unused(
                    Key {
                        scope: j.uid,
                        kind: K_FROM_LOT + 2,
                        n: 0,
                    },
                    t,
                    v,
                    owner,
                    ore,
                )
                .map_err(|_| BridgeError::Internal)?;
        }
        Ok(out)
    }

    /// Credit the whole units owed to `lot`, if it can take them now
    /// (10's `pay_owed`). Whatever it cannot take stays owed.
    pub fn pay_owed(&mut self, lot: LotId) -> Result<(), BridgeError> {
        let (v, owner) = self.key10(lot).ok_or(BridgeError::UnknownLot)?;
        self.cap.custody.pay_owed(v, owner);
        Ok(())
    }

    /// The connection's invariants (each `Err` names the broken one):
    /// every lot balances (10's law); what went back to a lot or is owed to
    /// it never exceeds what was taken; every lot's `CONSUMED` equals the
    /// ore the bridge took from it; 09's custody balances; no ore waits in
    /// a release place; a job holds at least the lot ore it took and has
    /// not used.
    pub fn check(&self, now: i64) -> Result<(), String> {
        let _ = now;
        // Each lot's law, CONSUMED = taken − returned, returned + owed ≤
        // taken: 10's custody checks them on its one table.
        for id in self.links.values().map(|k| k.lot) {
            let taken: i64 = self
                .links
                .values()
                .filter(|k| k.lot == id)
                .map(|k| k.qty)
                .sum();
            let l = self.lot(id).ok_or("a linked lot is gone")?;
            if l.consumed != taken - self.returned(id) {
                return Err(format!(
                    "lot {id:?}: CONSUMED {} != taken {taken} - returned {}",
                    l.consumed,
                    self.returned(id)
                ));
            }
        }
        self.cap.custody.check()?;
        for (job, _) in self.links.keys() {
            if let Some(j) = self.cap.job(*job) {
                let at = release_place(j.uid);
                if self.cap.custody.balance(at, Resource::Ore).1 != 0 {
                    return Err(format!("ore left in a release place {at:?}"));
                }
            }
        }
        for p in self.cap.ledger.pools.values() {
            for j in &p.jobs {
                if !j.accounts().balanced() {
                    return Err(format!("job {:?}: accounts do not balance", j.id));
                }
            }
        }
        for (job, _) in self.links.keys() {
            if let Some(j) = self.cap.job(*job) {
                let from_lots: i64 = self
                    .links
                    .iter()
                    .filter(|((x, _), _)| x == job)
                    .map(|(_, k)| k.qty)
                    .sum();
                let i = recipe(j.recipe)
                    .and_then(|r| r.input_index(Resource::Ore))
                    .ok_or("no ore input")?;
                if j.hopper[i] < from_lots {
                    return Err(format!(
                        "job {job:?}: hopper ore {} < lot ore {from_lots}",
                        j.hopper[i]
                    ));
                }
            }
        }
        Ok(())
    }

    /// Bytes to restart from: 09's state and 10's custody (lots in 10's
    /// own 576-byte account layout) by Borsh, and the links.
    pub fn save(&self) -> Vec<u8> {
        let s = Saved {
            cap: borsh::to_vec(&self.cap).expect("borsh"),
            links: self.links.iter().map(|(k, v)| (*k, *v)).collect(),
            release: self.release,
            genesis: self.genesis,
        };
        borsh::to_vec(&s).expect("borsh")
    }

    pub fn load(bytes: &[u8]) -> Option<Bridge> {
        let s = Saved::try_from_slice(bytes).ok()?;
        Some(Bridge {
            cap: Harness::try_from_slice(&s.cap).ok()?,
            links: s.links.into_iter().collect(),
            release: s.release,
            genesis: s.genesis,
        })
    }
}

#[derive(BorshSerialize, BorshDeserialize)]
struct Saved {
    cap: Vec<u8>,
    links: Vec<((JobId, u64), Link)>,
    release: Release,
    genesis: i64,
}
