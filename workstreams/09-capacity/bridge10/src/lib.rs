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
//! * **No ownership decided.** Who owns the arms made from M's ore, and the
//!   ore left unused, is open. By default ([`Release::Hold`]) a job fed
//!   from a lot keeps its products and leftovers until that is decided;
//!   [`Release::ToUser`] (09's existing behaviour) is a comparison case.
//!
//! 09's custody (the job's hopper and output, places, the user's own lots)
//! is workstream 10's adapter, `wylls_custody_adapter_09::LotCustody`
//! (10's lot kernel behind 09's `Custody` trait): a user's own lot is a
//! vault place there, with room reserved for the goods' return. The lots
//! used under another owner's use order are kept here, beside it, and run
//! by 10's kernel functions, because the adapter has no use order yet
//! (10's request R6); the two sets of lots are to be one (CONNECT-10 §5.4).

use std::collections::BTreeMap;

use borsh::{BorshDeserialize, BorshSerialize};
use permutation_rules::fixed::MILLI;
use permutation_rules::frontier::holding::{Resource, RESOURCES};
use wylls_capacity::custody::{Custody, Key};
use wylls_capacity::ledger::{Harness, Op, Outcome};
use wylls_capacity::model::{Actor, JobId, Place};
use wylls_capacity::recipe::recipe;
use wylls_capacity::CapError;
use wylls_custody::layout::lot as LOT;
use wylls_custody::{consume, CustodyError, Lot, VaultView};
use wylls_custody_adapter_09::LotCustody;

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
    /// from (whole units through 10's inbound functions; the sub-unit rest
    /// is owed to the lot and credited once it makes whole units). If the
    /// lot cannot take it (frozen, no room), all of it stays owed.
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
    pub cap: Harness<LotCustody>,
    pub vaults: BTreeMap<(i16, i16, u8), VaultView>,
    pub lots: BTreeMap<LotId, Lot>,
    pub links: BTreeMap<(JobId, u64), Link>,
    pub release: Release,
    /// Ore given back into each lot, whole units (milli).
    pub returned: BTreeMap<LotId, i64>,
    /// Ore owed to each lot and not yet credited: sub-unit rests, and
    /// whole units the lot could not take (milli).
    pub owed: BTreeMap<LotId, i64>,
    /// Return caravans' sequence numbers (10's inbound slots need one).
    pub return_seq: u32,
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
/// Tag of the bridge's return caravans into a lot (top bit set, like 10's
/// adapter's `RETURN_TAG`, so never an S1 caravan's).
const RETURN_MARK: u64 = 1 << 63;

impl Bridge {
    pub fn new(cap: Harness<LotCustody>, genesis: i64) -> Bridge {
        Bridge {
            cap,
            vaults: BTreeMap::new(),
            lots: BTreeMap::new(),
            links: BTreeMap::new(),
            release: Release::Decided,
            returned: BTreeMap::new(),
            owed: BTreeMap::new(),
            return_seq: 0,
            genesis,
        }
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
        // A replay is answered from the record, before 10 is called.
        if let Some(l) = self.links.get(&(job, deposit)) {
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
        // 10: the use order's grantee consumes from the lot.
        let l = self.lots.get_mut(&lot).ok_or(BridgeError::UnknownLot)?;
        let v = self
            .vaults
            .get(&(lot.p, lot.q, lot.tile))
            .ok_or(BridgeError::UnknownVault)?;
        consume(
            v,
            l,
            &actor10(user),
            slot,
            order,
            qty,
            PURPOSE_WORKSHOP_ARMS,
            bell,
        )
        .map_err(BridgeError::Custody)?;
        // 09: the released ore enters custody as the user's, then the job's
        // hopper by 09's own Deposit (which checks job, user, start, keys).
        let place = release_place(j.uid);
        self.cap
            .custody
            .import(
                Key {
                    scope: j.uid,
                    kind: K_FROM_LOT,
                    n: deposit,
                },
                place,
                user,
                res,
                qty,
            )
            .map_err(|_| BridgeError::Internal)?;
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
        // The ore leaves 09's custody for its lot.
        let ore = self.cap.custody.balance(t, Resource::Ore).1;
        if ore > 0 {
            let lot = self.lot_of(job).ok_or(BridgeError::Internal)?;
            self.cap
                .custody
                .export(
                    Key {
                        scope: j.uid,
                        kind: K_FROM_LOT + 2,
                        n: 0,
                    },
                    wylls_capacity::custody::By::Actor(user),
                    t,
                    Resource::Ore,
                    ore,
                )
                .map_err(|_| BridgeError::Internal)?;
            *self.owed.entry(lot).or_default() += ore;
            self.pay_owed(lot)?;
        }
        Ok(out)
    }

    /// Credit the whole units owed to `lot`, if it can take them (10's
    /// `begin_inbound` then `finish_inbound`, as a return caravan that
    /// arrives at once: the decided rule puts the vault in the facility's
    /// province). Whatever it cannot take stays owed.
    pub fn pay_owed(&mut self, lot: LotId) -> Result<(), BridgeError> {
        let due = self.owed.get(&lot).copied().unwrap_or(0) / MILLI * MILLI;
        if due == 0 {
            return Ok(());
        }
        let v = *self
            .vaults
            .get(&(lot.p, lot.q, lot.tile))
            .ok_or(BridgeError::UnknownVault)?;
        let l = self.lots.get_mut(&lot).ok_or(BridgeError::UnknownLot)?;
        let mut trial = *l;
        let caravan = (RETURN_MARK | lot.owner_tag >> 16, self.return_seq);
        let paid = wylls_custody::begin_inbound(&v, &mut trial, caravan, due)
            .and_then(|_| wylls_custody::finish_inbound(Some(&v), &mut trial, caravan, due));
        match paid {
            Ok(s) if s.delivered == due => {
                *l = trial;
                self.return_seq = self.return_seq.wrapping_add(1);
                *self.owed.get_mut(&lot).expect("owed") -= due;
                *self.returned.entry(lot).or_default() += due;
                Ok(())
            }
            // Frozen, full or no slot: it stays owed (nothing is lost).
            _ => Ok(()),
        }
    }

    /// The connection's invariants (each `Err` names the broken one):
    /// every lot balances (10's law); what went back to a lot or is owed to
    /// it never exceeds what was taken; every lot's `CONSUMED` equals the
    /// ore the bridge took from it; 09's custody balances; no ore waits in
    /// a release place; a job holds at least the lot ore it took and has
    /// not used.
    pub fn check(&self, now: i64) -> Result<(), String> {
        let bell = self.bell(now);
        for (id, l) in &self.lots {
            if !l.balanced(bell) {
                return Err(format!("10: lot {id:?} does not balance"));
            }
            let taken: i64 = self
                .links
                .values()
                .filter(|k| k.lot == *id)
                .map(|k| k.qty)
                .sum();
            let back = self.returned.get(id).copied().unwrap_or(0)
                + self.owed.get(id).copied().unwrap_or(0);
            if back < 0 || back > taken {
                return Err(format!(
                    "lot {id:?}: returned and owed {back} > taken {taken}"
                ));
            }
            if l.consumed != taken {
                return Err(format!(
                    "lot {id:?}: CONSUMED {} != taken by jobs {taken}",
                    l.consumed
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

    /// Bytes to restart from: 09's state by Borsh, every lot in 10's own
    /// account layout (576 B, 10's `Lot::encode`), the vaults' fields.
    pub fn save(&self) -> Vec<u8> {
        let lots: Vec<(LotId, Vec<u8>)> = self
            .lots
            .iter()
            .map(|(id, l)| {
                let mut d = vec![0u8; LOT::SIZE];
                d[..8].copy_from_slice(&LOT::MAGIC);
                l.encode(&mut d).expect("576 bytes");
                (*id, d)
            })
            .collect();
        let vaults: Vec<VaultRec> = self.vaults.values().map(VaultRec::of).collect();
        let s = Saved {
            cap: borsh::to_vec(&self.cap).expect("borsh"),
            lots,
            vaults,
            links: self.links.iter().map(|(k, v)| (*k, *v)).collect(),
            release: self.release,
            genesis: self.genesis,
            returned: self.returned.iter().map(|(k, v)| (*k, *v)).collect(),
            owed: self.owed.iter().map(|(k, v)| (*k, *v)).collect(),
            return_seq: self.return_seq,
        };
        borsh::to_vec(&s).expect("borsh")
    }

    pub fn load(bytes: &[u8]) -> Option<Bridge> {
        let s = Saved::try_from_slice(bytes).ok()?;
        let mut lots = BTreeMap::new();
        for (id, d) in s.lots {
            lots.insert(id, Lot::decode(&d)?);
        }
        Some(Bridge {
            cap: Harness::try_from_slice(&s.cap).ok()?,
            vaults: s
                .vaults
                .into_iter()
                .map(|v| {
                    let v = v.view();
                    ((v.p, v.q, v.tile), v)
                })
                .collect(),
            lots,
            links: s.links.into_iter().collect(),
            release: s.release,
            genesis: s.genesis,
            returned: s.returned.into_iter().collect(),
            owed: s.owed.into_iter().collect(),
            return_seq: s.return_seq,
        })
    }
}

#[derive(BorshSerialize, BorshDeserialize)]
struct Saved {
    cap: Vec<u8>,
    lots: Vec<(LotId, Vec<u8>)>,
    vaults: Vec<VaultRec>,
    links: Vec<((JobId, u64), Link)>,
    release: Release,
    genesis: i64,
    returned: Vec<(LotId, i64)>,
    owed: Vec<(LotId, i64)>,
    return_seq: u32,
}

/// The vault fields 10's kernel reads (its account is the core's).
#[derive(BorshSerialize, BorshDeserialize)]
struct VaultRec {
    p: i16,
    q: i16,
    tile: u8,
    gen: u8,
    live: bool,
    owner: [u8; 32],
    owner_tag: u64,
    stores: [i64; RESOURCES],
    cap: i64,
    quota: [i64; RESOURCES],
    lots: u16,
}

impl VaultRec {
    fn of(v: &VaultView) -> VaultRec {
        VaultRec {
            p: v.p,
            q: v.q,
            tile: v.tile,
            gen: v.gen,
            live: v.live,
            owner: v.owner,
            owner_tag: v.owner_tag,
            stores: v.stores,
            cap: v.cap,
            quota: v.quota,
            lots: v.lots,
        }
    }

    fn view(&self) -> VaultView {
        VaultView {
            p: self.p,
            q: self.q,
            tile: self.tile,
            gen: self.gen,
            live: self.live,
            owner: self.owner,
            owner_tag: self.owner_tag,
            stores: self.stores,
            cap: self.cap,
            quota: self.quota,
            lots: self.lots,
        }
    }
}
