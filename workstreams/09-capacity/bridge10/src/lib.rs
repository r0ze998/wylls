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
//! The vault and lot here are stand-ins for 10's accounts, run by 10's own
//! kernel functions; 09's hopper and output custody is still 09's mock.

use std::collections::BTreeMap;

use borsh::{BorshDeserialize, BorshSerialize};
use permutation_rules::fixed::MILLI;
use permutation_rules::frontier::holding::{Resource, RESOURCES};
use wylls_capacity::custody::{Custody, Key, MockCustody};
use wylls_capacity::ledger::{Harness, Op, Outcome};
use wylls_capacity::model::{Actor, JobId, Place};
use wylls_capacity::recipe::recipe;
use wylls_capacity::CapError;
use wylls_custody::layout::lot as LOT;
use wylls_custody::{consume, CustodyError, Lot, VaultView};

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
    /// [default] Nothing: products and leftovers stay in the job's places
    /// until the owner of goods made from another's lot is decided.
    Hold,
    /// The job's user claims them, as for its own materials (09's existing
    /// rule). A comparison case, not a decision.
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
}

/// The two kernels side by side: 09's harness (facilities, pools, jobs,
/// its custody) and 10's vaults and lots.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Bridge {
    pub cap: Harness<MockCustody>,
    pub vaults: BTreeMap<(i16, i16, u8), VaultView>,
    pub lots: BTreeMap<LotId, Lot>,
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
/// (one per job; empty after every step).
pub fn release_place(uid: u64) -> Place {
    Place::Vault(0xF10A_0000_0000_0000 | (uid & 0x0000_FFFF_FFFF_FFFF))
}

impl Bridge {
    pub fn new(cap: Harness<MockCustody>, genesis: i64) -> Bridge {
        Bridge {
            cap,
            vaults: BTreeMap::new(),
            lots: BTreeMap::new(),
            links: BTreeMap::new(),
            release: Release::Hold,
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
        if r.input_index(res).is_none() {
            return Err(BridgeError::Resource);
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

    /// Any of 09's operations. A claim of a job fed from a lot is held
    /// under [`Release::Hold`]; everything else passes to 09 unchanged.
    pub fn apply(&mut self, now: i64, signer: Actor, op: &Op) -> Result<Outcome, BridgeError> {
        if let Op::Claim { job, .. } = op {
            if self.release == Release::Hold && self.lot_fed(*job) {
                return Err(BridgeError::OwnershipUndecided);
            }
        }
        self.cap
            .apply(now, signer, op)
            .map_err(BridgeError::Capacity)
    }

    /// The connection's invariants (each `Err` names the broken one):
    /// every lot balances (10's law); every lot's `CONSUMED` equals the
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
            if l.consumed != taken {
                return Err(format!(
                    "lot {id:?}: CONSUMED {} != taken by jobs {taken}",
                    l.consumed
                ));
            }
        }
        self.cap.custody.check()?;
        for ((place, _), (_, a)) in &self.cap.custody.lots {
            if let Place::Vault(x) = place {
                if x >> 48 == 0xF10A && *a != 0 {
                    return Err(format!("ore left in a release place {place:?}"));
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
