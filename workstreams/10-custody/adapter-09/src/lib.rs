//! Workstream 10 ⇄ workstream 9: ⑨'s [`Custody`] trait implemented on ⑩'s
//! lot kernel (`wylls_custody::lot`), **unchanged on both sides**.
//!
//! ⑨'s kernel (`wylls_capacity::ledger::Harness`) calls custody for every
//! move of a job's goods: a user's deposit into the job's hopper, the use of
//! inputs and the making of outputs as the job is settled, the claim of
//! outputs and the refund of unused inputs, and the transfer to a captor on
//! a facility loss. ⑨ tests those calls against its own `MockCustody`. This
//! crate answers the same calls with ⑩'s semantics:
//!
//! * **Vault places are owner-separated.** `Place::Vault(v)` is not one pile
//!   with one owner: each owner's goods there are a ⑩ lot (`Lot`, the 576-byte
//!   account of `layout::lot`), opened by the vault's keeper with a quota. A
//!   move out of `Vault(v)` by actor `a` takes from `a`'s own lot and from
//!   nothing else: the keeper, another user or ⑨'s kernel cannot reach it.
//! * **Return room is reserved while goods are in a job.** When `a` puts
//!   goods from a lot into a job's hopper, the lot keeps their room as an
//!   inbound reservation (the same slot a custody caravan on its way uses,
//!   tagged [`RETURN_TAG`] ‖ the job's uid), so a refund can come back even if
//!   caravans arrive meanwhile. The reservation ends **exactly once**: when the
//!   goods come back into that lot ([`Note::Returned`]), or when the job's
//!   hopper of that resource is emptied by use, a refund elsewhere or a loss,
//!   or when ⑨ forgets the job ([`Note::Released`]).
//! * **Idempotency (⑨'s C6).** Every call carries a [`Key`]; the same key with
//!   the same call is done once, a different call under a used key is
//!   refused. ⑨'s `forget(scope)` drops a retired job's keys; the adapter
//!   then checks the job's places are empty and releases what is left of its
//!   reservations (a non-empty place is recorded as stranded and fails
//!   [`LotCustody::check`]).
//! * **Atomic.** Every call works on a copy and commits only on success, as
//!   ⑨ requires ("an error changes nothing"); ⑨'s `Harness::apply` also rolls
//!   the whole adapter back when a later call of the same operation fails, so
//!   the [`Note`] outbox only ever holds notifications of committed work.
//!
//! What this crate does **not** decide (open questions, see
//! `../08-adapter-09.ja.md`): who owns a job's output (the adapter puts it
//! where and to whom ⑨ says), more than one resource in lots (⑩'s kernel
//! enables ore only, so wood and arms never enter a lot), and what a vault
//! seizure does to the lots in it (they are frozen: no move in or out, and
//! the adapter never runs ⑩'s proposed `forfeit`).

use std::collections::BTreeMap;

use borsh::{BorshDeserialize, BorshSerialize};
use permutation_rules::fixed::MILLI;
use permutation_rules::frontier::holding::{Resource, RESOURCES};
use wylls_capacity::custody::{By, Custody, CustodyError, Key, Move};
use wylls_capacity::model::{Actor, JobId, Place};
use wylls_custody::layout;
use wylls_custody::lot::{self as L, CaravanSeen, CustodyError as LotError, Lot, VaultView};

/// High bit of an inbound tag: a return reservation of a job (S1 caravan
/// ids are 47-bit owner tag ‖ 16-bit sequence, so the bit is never theirs).
pub const RETURN_TAG: u64 = 1 << 63;
/// The inbound sequence of a job's return reservation.
pub const RETURN_SEQ: u32 = 0;
/// The inbound sequence used for one instant inside a call (a credit beyond
/// a reservation, an arrival): begun and finished in the same call.
const TRANSIENT_SEQ: u32 = u32::MAX;

/// Why a call was refused: ⑨'s own reason, or ⑩'s kernel's. The trait maps
/// it to ⑨'s `CustodyError` with [`to_nine`]; the inherent `try_*` methods
/// keep the precise reason (⑨'s error type has no room for it; see the I/O
/// table in `08-adapter-09.ja.md`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Refusal {
    Nine(CustodyError),
    Lot(LotError),
}

impl From<LotError> for Refusal {
    fn from(e: LotError) -> Refusal {
        Refusal::Lot(e)
    }
}

impl From<CustodyError> for Refusal {
    fn from(e: CustodyError) -> Refusal {
        Refusal::Nine(e)
    }
}

/// ⑩'s reasons as ⑨'s: not enough is `Insufficient`; everything else
/// (authority, frozen lot, resource not enabled, not whole units, no room,
/// no slot, overflow) is `Forbidden`.
pub fn to_nine(r: Refusal) -> CustodyError {
    match r {
        Refusal::Nine(e) => e,
        Refusal::Lot(LotError::Insufficient) => CustodyError::Insufficient,
        Refusal::Lot(_) => CustodyError::Forbidden,
    }
}

type R<T> = Result<T, Refusal>;

/// A vault: the S1 `Vault` fields the lot kernel reads, plus its keeper.
#[derive(Clone, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize)]
pub struct Vault {
    pub p: i16,
    pub q: i16,
    pub tile: u8,
    pub gen: u8,
    pub live: bool,
    /// The keeper (custodian): the vault's owner.
    pub owner: Actor,
    /// The keeper's general stock (`STORES`, milli).
    pub stores: [i64; RESOURCES],
    /// `CAP`, per resource (milli).
    pub cap: i64,
    /// `CUSTODY_QUOTA`: room committed to lots (milli).
    pub quota: [i64; RESOURCES],
    /// `CUSTODY_LOTS`.
    pub lots: u16,
}

impl Vault {
    fn view(&self) -> VaultView {
        VaultView {
            p: self.p,
            q: self.q,
            tile: self.tile,
            gen: self.gen,
            live: self.live,
            owner: self.owner.0,
            owner_tag: tag(self.owner),
            stores: self.stores,
            cap: self.cap,
            quota: self.quota,
            lots: self.lots,
        }
    }

    fn absorb(&mut self, v: &VaultView) {
        self.stores = v.stores;
        self.quota = v.quota;
        self.lots = v.lots;
    }
}

/// Why a return reservation ended without the goods coming back.
#[derive(Clone, Copy, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize)]
pub enum Why {
    /// The job's hopper of that resource is empty: used up, refunded to
    /// another place, or taken on a facility loss.
    Emptied,
    /// ⑨ forgot the job (`Retire`).
    Forgotten,
}

/// A notification of committed custody work, in order (the outbox the
/// keeper/indexer drains with [`LotCustody::take_notes`]).
#[derive(Clone, Copy, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize)]
pub enum Note {
    /// `owner`'s goods left their lot in `vault` for the job's hopper, and the
    /// lot now reserves `qty` more room for their return.
    Reserved {
        job: JobId,
        vault: u64,
        owner: Actor,
        r: u8,
        qty: i64,
    },
    /// Goods came from the job into the lot: `covered` of `qty` used the
    /// job's reservation in this lot and `released` is its unused part (now
    /// free); both are 0 when the goods had not come from this lot (a refund
    /// into another lot of the owner, with ordinary room).
    Returned {
        job: JobId,
        vault: u64,
        owner: Actor,
        r: u8,
        qty: i64,
        covered: i64,
        released: i64,
    },
    /// A reservation ended without a return.
    Released {
        job: JobId,
        vault: u64,
        owner: Actor,
        r: u8,
        qty: i64,
        why: Why,
    },
    /// A job's input used up (⑨'s `consume`).
    Consumed { job: JobId, r: u8, qty: i64 },
    /// A job's output made (⑨'s `produce`), owned by `owner` as ⑨ named.
    Produced {
        job: JobId,
        r: u8,
        qty: i64,
        owner: Actor,
    },
    /// ⑨ forgot a job whose hopper or output was not empty.
    Stranded { scope: u64 },
}

/// ⑨'s `Custody` on ⑩'s lots. See the module documentation.
#[derive(Clone, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize)]
pub struct LotCustody {
    pub vaults: BTreeMap<u64, Vault>,
    /// (vault, owner, resource) → the lot account's bytes (`layout::lot`).
    pub lots: BTreeMap<(u64, Actor, u8), Vec<u8>>,
    /// Places that are not lots: a Holding's custody pile, a caravan, a
    /// job's hopper and output. One owner per (place, resource), as ⑨'s C5.
    pub plain: BTreeMap<(Place, u8), (Actor, i64)>,
    /// Used idempotency keys and the call each was used for.
    pub keys: BTreeMap<Key, Move>,
    /// The uid (key scope) of each job seen.
    pub jobs: BTreeMap<JobId, u64>,
    /// Live return reservations: (job, resource) → the lots holding one.
    pub returns: BTreeMap<(JobId, u8), Vec<(u64, Actor)>>,
    pub imported: [i64; RESOURCES],
    pub exported: [i64; RESOURCES],
    pub consumed: [i64; RESOURCES],
    pub produced: [i64; RESOURCES],
    pub stranded: Vec<u64>,
    pub notes: Vec<Note>,
}

impl Default for LotCustody {
    fn default() -> Self {
        Self::new()
    }
}

/// A citizen's tag in the lot kernel (the program reads it from the
/// Citizen account; here: the key's first 8 bytes).
pub fn tag(a: Actor) -> u64 {
    u64::from_le_bytes(a.0[..8].try_into().expect("8 bytes"))
}

fn lot_actor(a: Actor) -> L::Actor {
    L::Actor {
        citizen: a.0,
        tag: tag(a),
        by_session: false,
    }
}

fn whole(q: i64) -> R<()> {
    if q <= 0 || q % MILLI != 0 {
        return Err(LotError::Quantity.into());
    }
    Ok(())
}

fn add(x: &mut i64, d: i64) -> R<()> {
    *x = x.checked_add(d).ok_or(LotError::Overflow)?;
    Ok(())
}

fn job_of(p: Place) -> Option<JobId> {
    match p {
        Place::Hopper(j) | Place::Output(j) => Some(j),
        _ => None,
    }
}

fn usable(v: &VaultView, l: &Lot) -> R<()> {
    if l.state != L::LOT_OPEN {
        return Err(LotError::State.into());
    }
    if !v.live || v.gen != l.vault_gen || (v.p, v.q, v.tile) != (l.p, l.q, l.tile) {
        return Err(LotError::Forfeited.into());
    }
    Ok(())
}

impl LotCustody {
    pub fn new() -> LotCustody {
        LotCustody {
            vaults: BTreeMap::new(),
            lots: BTreeMap::new(),
            plain: BTreeMap::new(),
            keys: BTreeMap::new(),
            jobs: BTreeMap::new(),
            returns: BTreeMap::new(),
            imported: [0; RESOURCES],
            exported: [0; RESOURCES],
            consumed: [0; RESOURCES],
            produced: [0; RESOURCES],
            stranded: Vec::new(),
            notes: Vec::new(),
        }
    }

    /// Hands over (and clears) the notifications of committed work.
    pub fn take_notes(&mut self) -> Vec<Note> {
        std::mem::take(&mut self.notes)
    }

    // ------------------------------------------------ ⑩'s side (not ⑨'s calls)

    /// A live vault `id` of `owner` (the keeper) on tile (p, q, tile).
    pub fn add_vault(&mut self, id: u64, p: i16, q: i16, tile: u8, owner: Actor, cap: i64) {
        self.vaults.insert(
            id,
            Vault {
                p,
                q,
                tile,
                gen: 1,
                live: true,
                owner,
                stores: [0; RESOURCES],
                cap,
                quota: [0; RESOURCES],
                lots: 0,
            },
        );
    }

    /// OpenLot: the keeper commits `quota` of vault `v` to `owner`'s goods
    /// of `r` (⑩'s `lot::open`).
    pub fn open_lot(
        &mut self,
        v: u64,
        keeper: Actor,
        owner: Actor,
        r: Resource,
        quota: i64,
    ) -> R<()> {
        let mut t = self.clone();
        let vault = t.vaults.get_mut(&v).ok_or(CustodyError::Insufficient)?;
        let mut view = vault.view();
        if t.lots.contains_key(&(v, owner, r as u8)) {
            return Err(LotError::State.into());
        }
        let lot = L::open(
            &mut view,
            &lot_actor(keeper),
            (owner.0, tag(owner)),
            r as u8,
            quota,
            0,
            keeper.0,
        )?;
        vault.absorb(&view);
        let mut d = vec![0u8; layout::lot::SIZE];
        lot.encode(&mut d).expect("a lot fits its account");
        t.lots.insert((v, owner, r as u8), d);
        *self = t;
        Ok(())
    }

    /// SetLotQuota (⑩'s `lot::set_quota`): refused below what the lot holds
    /// and expects, return reservations included.
    pub fn set_quota(&mut self, v: u64, keeper: Actor, owner: Actor, r: Resource, q: i64) -> R<()> {
        let mut t = self.clone();
        let mut lot = t.lot(v, owner, r as u8).ok_or(LotError::State)?;
        let vault = t.vaults.get_mut(&v).ok_or(CustodyError::Insufficient)?;
        let mut view = vault.view();
        L::set_quota(&mut view, &mut lot, &lot_actor(keeper), q)?;
        vault.absorb(&view);
        t.put_lot(v, owner, r as u8, &lot);
        *self = t;
        Ok(())
    }

    /// A custody caravan of ⑩ on its way to `owner`'s lot reserves room
    /// (⑩'s `lot::begin_inbound`); here only to test contention with return
    /// reservations.
    pub fn begin_inbound(
        &mut self,
        v: u64,
        owner: Actor,
        r: Resource,
        caravan: (u64, u32),
        qty: i64,
    ) -> R<()> {
        if caravan.0 & RETURN_TAG != 0 {
            return Err(LotError::Stale.into());
        }
        let mut t = self.clone();
        let view = t.vaults.get(&v).ok_or(CustodyError::Insufficient)?.view();
        let mut lot = t.lot(v, owner, r as u8).ok_or(LotError::State)?;
        L::begin_inbound(&view, &mut lot, caravan, qty)?;
        t.put_lot(v, owner, r as u8, &lot);
        *self = t;
        Ok(())
    }

    /// SeizeVault (S1, as ⑩'s model does it): the captor becomes the keeper
    /// and the generation moves on. The lots in it are frozen (`Forfeited`
    /// on every move); whether and how they are forfeited is **not decided**
    /// and the adapter does nothing more.
    pub fn seize_vault(&mut self, v: u64, captor: Actor) -> R<()> {
        let vault = self.vaults.get_mut(&v).ok_or(CustodyError::Insufficient)?;
        if !vault.live || vault.owner == captor {
            return Err(LotError::State.into());
        }
        vault.gen = vault.gen.checked_add(1).ok_or(LotError::Overflow)?;
        vault.owner = captor;
        Ok(())
    }

    /// The lot of `owner` in `v`, decoded from its account bytes.
    pub fn lot(&self, v: u64, owner: Actor, r: u8) -> Option<Lot> {
        self.lots
            .get(&(v, owner, r))
            .map(|d| Lot::decode(d).expect("a lot account"))
    }

    /// Room `owner`'s lot reserves for the return of goods out in jobs.
    pub fn return_room(&self, v: u64, owner: Actor, r: Resource) -> i64 {
        self.lot(v, owner, r as u8)
            .map(|l| {
                l.inbound
                    .iter()
                    .filter(|i| i.live && i.caravan_tag & RETURN_TAG != 0)
                    .map(|i| i.qty)
                    .sum()
            })
            .unwrap_or(0)
    }

    fn put_lot(&mut self, v: u64, owner: Actor, r: u8, l: &Lot) {
        let d = self.lots.get_mut(&(v, owner, r)).expect("an open lot");
        l.encode(d).expect("a lot fits its account");
    }

    fn uid(&self, job: JobId) -> u64 {
        *self.jobs.get(&job).expect("a job seen with its key")
    }

    fn rtag(&self, job: JobId) -> (u64, u32) {
        (RETURN_TAG | (self.uid(job) & !RETURN_TAG), RETURN_SEQ)
    }

    fn see_job(&mut self, scope: u64, p: Place) {
        if let Some(j) = job_of(p) {
            self.jobs.entry(j).or_insert(scope);
        }
    }

    // ------------------------------------------------------------ plain places

    fn take_plain(&mut self, at: Place, r: u8, amount: i64, by: By) -> R<()> {
        let k = (at, r);
        let (owner, have) = *self.plain.get(&k).ok_or(CustodyError::Insufficient)?;
        if let By::Actor(a) = by {
            if a != owner {
                return Err(CustodyError::Forbidden.into());
            }
        }
        if have < amount {
            return Err(CustodyError::Insufficient.into());
        }
        if have == amount {
            self.plain.remove(&k);
        } else {
            self.plain.insert(k, (owner, have - amount));
        }
        Ok(())
    }

    fn put_plain(&mut self, at: Place, r: u8, owner: Actor, amount: i64) -> R<()> {
        let e = self.plain.entry((at, r)).or_insert((owner, 0));
        if e.0 != owner {
            return Err(CustodyError::OwnerMismatch.into());
        }
        add(&mut e.1, amount)
    }

    fn held_plain(&self, at: Place, r: u8) -> i64 {
        self.plain.get(&(at, r)).map(|x| x.1).unwrap_or(0)
    }

    // -------------------------------------------------------------- lot moves

    /// A vault place is reachable from a job only on the facility's
    /// province (S1 vaults stand on tiles; a job's hopper is at its
    /// facility). Provisional: ④ decides the geometry.
    fn beside(&self, v: u64, job: JobId) -> R<()> {
        let vault = self.vaults.get(&v).ok_or(CustodyError::Insufficient)?;
        let at = job.grant.facility.at;
        if (vault.p, vault.q) != (at.p, at.q) {
            return Err(CustodyError::Forbidden.into());
        }
        Ok(())
    }

    /// The owner moves `amount` out of their own lot (⑩'s `spend_ship` by
    /// the owner): whole units, never more than is held and not reserved.
    fn debit_lot(&mut self, v: u64, owner: Actor, r: u8, amount: i64) -> R<()> {
        let view = self
            .vaults
            .get(&v)
            .ok_or(CustodyError::Insufficient)?
            .view();
        let mut lot = self.lot(v, owner, r).ok_or(CustodyError::Insufficient)?;
        L::spend_ship(
            &view,
            &mut lot,
            &lot_actor(owner),
            L::By::Owner,
            amount,
            L::ShipTo::OwnPlace(view.place()),
            0,
        )?;
        self.put_lot(v, owner, r, &lot);
        Ok(())
    }

    /// The lot of `owner` keeps `amount` more room for the job's return.
    fn reserve_return(&mut self, v: u64, owner: Actor, r: u8, job: JobId, amount: i64) -> R<()> {
        let view = self
            .vaults
            .get(&v)
            .ok_or(CustodyError::Insufficient)?
            .view();
        let mut lot = self.lot(v, owner, r).ok_or(CustodyError::Insufficient)?;
        let rt = self.rtag(job);
        let before = if lot.inbound.iter().any(|i| i.is(rt.0, rt.1)) {
            L::drop_inbound(&mut lot, rt, CaravanSeen::Absent)?
        } else {
            0
        };
        let total = before.checked_add(amount).ok_or(LotError::Overflow)?;
        L::begin_inbound(&view, &mut lot, rt, total)?;
        self.put_lot(v, owner, r, &lot);
        let list = self.returns.entry((job, r)).or_default();
        if !list.contains(&(v, owner)) {
            list.push((v, owner));
        }
        self.notes.push(Note::Reserved {
            job,
            vault: v,
            owner,
            r,
            qty: amount,
        });
        Ok(())
    }

    /// Goods enter `owner`'s lot in `v`: from `job` (a refund or a claim,
    /// using the job's reservation first) or from outside (an arrival).
    fn credit_lot(
        &mut self,
        v: u64,
        owner: Actor,
        r: u8,
        amount: i64,
        job: Option<JobId>,
    ) -> R<()> {
        if (r as usize) >= RESOURCES || L::ENABLED_RESOURCES & (1 << r) == 0 {
            return Err(LotError::Resource.into());
        }
        let view = self
            .vaults
            .get(&v)
            .ok_or(CustodyError::Insufficient)?
            .view();
        let mut lot = self.lot(v, owner, r).ok_or(LotError::State)?;
        whole(amount)?;
        // A refund into a seized vault's lot would be lost to the owner
        // (the kernel's finish_inbound books it as DestinationGone): refuse
        // it, so the goods stay in the job and can go elsewhere.
        usable(&view, &lot)?;
        let mut covered = 0;
        let mut released = 0;
        let rt = job.map(|j| self.rtag(j));
        if let Some(rt) = rt {
            if let Some(sent) = lot.inbound.iter().find(|i| i.is(rt.0, rt.1)).map(|i| i.qty) {
                covered = amount.min(sent);
                let s = L::finish_inbound(Some(&view), &mut lot, rt, covered)?;
                debug_assert_eq!(s.delivered, covered);
                released = s.burned;
            }
        }
        let rest = amount - covered;
        if rest > 0 {
            let tr = (rt.map(|x| x.0).unwrap_or(RETURN_TAG), TRANSIENT_SEQ);
            L::begin_inbound(&view, &mut lot, tr, rest)?;
            let s = L::finish_inbound(Some(&view), &mut lot, tr, rest)?;
            debug_assert_eq!(s.delivered, rest);
        }
        self.put_lot(v, owner, r, &lot);
        if let Some(j) = job {
            if let Some(list) = self.returns.get_mut(&(j, r)) {
                list.retain(|x| *x != (v, owner));
                if list.is_empty() {
                    self.returns.remove(&(j, r));
                }
            }
            self.notes.push(Note::Returned {
                job: j,
                vault: v,
                owner,
                r,
                qty: amount,
                covered,
                released,
            });
        }
        Ok(())
    }

    /// The job's hopper of `r` is empty: every reservation for it ends.
    fn release_if_empty(&mut self, job: JobId, r: u8) {
        if self.held_plain(Place::Hopper(job), r) == 0 {
            self.release_all(job, r, Why::Emptied);
        }
    }

    fn release_all(&mut self, job: JobId, r: u8, why: Why) {
        let Some(list) = self.returns.remove(&(job, r)) else {
            return;
        };
        let rt = self.rtag(job);
        for (v, owner) in list {
            let Some(mut lot) = self.lot(v, owner, r) else {
                continue; // check() reports the broken pairing
            };
            if let Ok(q) = L::drop_inbound(&mut lot, rt, CaravanSeen::Absent) {
                self.put_lot(v, owner, r, &lot);
                self.notes.push(Note::Released {
                    job,
                    vault: v,
                    owner,
                    r,
                    qty: q,
                    why,
                });
            }
        }
    }

    // ------------------------------------------------------------ ⑨'s calls

    fn fresh(&self, key: Key, m: &Move) -> R<bool> {
        match self.keys.get(&key) {
            None => Ok(true),
            Some(x) if x == m => Ok(false),
            Some(_) => Err(CustodyError::KeyReused.into()),
        }
    }

    fn commit(&mut self, mut t: LotCustody, key: Key, m: Move) {
        t.keys.insert(key, m);
        *self = t;
    }

    pub fn try_import(
        &mut self,
        key: Key,
        at: Place,
        owner: Actor,
        r: Resource,
        amount: i64,
    ) -> R<()> {
        if amount < 0 {
            return Err(CustodyError::Negative.into());
        }
        let m = Move::Import {
            at,
            owner,
            r: r as u8,
            amount,
        };
        if !self.fresh(key, &m)? {
            return Ok(());
        }
        let mut t = self.clone();
        if amount > 0 {
            match at {
                // Into a job only by a deposit (transfer), never from outside.
                Place::Hopper(_) | Place::Output(_) => return Err(CustodyError::Forbidden.into()),
                // The settlement of an arrival into the owner's lot.
                Place::Vault(v) => t.credit_lot(v, owner, r as u8, amount, None)?,
                _ => t.put_plain(at, r as u8, owner, amount)?,
            }
            add(&mut t.imported[r as usize], amount)?;
        }
        self.commit(t, key, m);
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    pub fn try_transfer(
        &mut self,
        key: Key,
        by: By,
        from: Place,
        to: Place,
        r: Resource,
        amount: i64,
        owner: Actor,
    ) -> R<()> {
        if amount < 0 {
            return Err(CustodyError::Negative.into());
        }
        let m = Move::Transfer {
            from,
            to,
            owner,
            r: r as u8,
            amount,
        };
        if !self.fresh(key, &m)? {
            return Ok(());
        }
        let mut t = self.clone();
        t.see_job(key.scope, from);
        t.see_job(key.scope, to);
        if amount == 0 {
            self.commit(t, key, m);
            return Ok(());
        }
        let ri = r as u8;
        // Who may move goods out of `from` (⑨'s C4), and that an actor's
        // goods stay theirs (a transfer is not a gift).
        match by {
            By::Kernel if !from.kernel_only() => return Err(CustodyError::Forbidden.into()),
            By::Actor(_) if from.kernel_only() => return Err(CustodyError::Forbidden.into()),
            By::Actor(a) if a != owner => return Err(CustodyError::Forbidden.into()),
            _ => {}
        }
        // A lot is reached only from a job on the vault's province; a move
        // between a lot and a caravan, a Holding or another lot is ⑩'s own
        // instruction (a custody caravan with its travel), not this call.
        match (from, to) {
            (Place::Vault(v), Place::Hopper(j)) => t.beside(v, j)?,
            (Place::Vault(_), _) => return Err(CustodyError::Forbidden.into()),
            (Place::Hopper(j) | Place::Output(j), Place::Vault(v)) => t.beside(v, j)?,
            (_, Place::Vault(_)) => return Err(CustodyError::Forbidden.into()),
            _ => {}
        }
        match from {
            Place::Vault(v) => {
                let By::Actor(a) = by else {
                    unreachable!("checked above")
                };
                t.debit_lot(v, a, ri, amount)?;
            }
            _ => t.take_plain(from, ri, amount, by)?,
        }
        match to {
            Place::Vault(v) => t.credit_lot(v, owner, ri, amount, job_of(from))?,
            _ => t.put_plain(to, ri, owner, amount)?,
        }
        if let (Place::Vault(v), Place::Hopper(j)) = (from, to) {
            t.reserve_return(v, owner, ri, j, amount)?;
        }
        if let Place::Hopper(j) = from {
            t.release_if_empty(j, ri);
        }
        self.commit(t, key, m);
        Ok(())
    }

    pub fn try_consume(&mut self, key: Key, at: Place, r: Resource, amount: i64) -> R<()> {
        if amount < 0 {
            return Err(CustodyError::Negative.into());
        }
        let m = Move::Consume {
            at,
            r: r as u8,
            amount,
        };
        if !self.fresh(key, &m)? {
            return Ok(());
        }
        let mut t = self.clone();
        t.see_job(key.scope, at);
        if amount > 0 {
            let Place::Hopper(j) = at else {
                return Err(CustodyError::Forbidden.into());
            };
            t.take_plain(at, r as u8, amount, By::Kernel)?;
            add(&mut t.consumed[r as usize], amount)?;
            t.notes.push(Note::Consumed {
                job: j,
                r: r as u8,
                qty: amount,
            });
            t.release_if_empty(j, r as u8);
        }
        self.commit(t, key, m);
        Ok(())
    }

    pub fn try_produce(
        &mut self,
        key: Key,
        at: Place,
        owner: Actor,
        r: Resource,
        amount: i64,
    ) -> R<()> {
        if amount < 0 {
            return Err(CustodyError::Negative.into());
        }
        let m = Move::Produce {
            at,
            owner,
            r: r as u8,
            amount,
        };
        if !self.fresh(key, &m)? {
            return Ok(());
        }
        let mut t = self.clone();
        t.see_job(key.scope, at);
        if amount > 0 {
            let Place::Output(j) = at else {
                return Err(CustodyError::Forbidden.into());
            };
            t.put_plain(at, r as u8, owner, amount)?;
            add(&mut t.produced[r as usize], amount)?;
            t.notes.push(Note::Produced {
                job: j,
                r: r as u8,
                qty: amount,
                owner,
            });
        }
        self.commit(t, key, m);
        Ok(())
    }

    pub fn try_export(&mut self, key: Key, by: By, at: Place, r: Resource, amount: i64) -> R<()> {
        if amount < 0 {
            return Err(CustodyError::Negative.into());
        }
        let m = Move::Export {
            at,
            r: r as u8,
            amount,
        };
        if !self.fresh(key, &m)? {
            return Ok(());
        }
        let mut t = self.clone();
        t.see_job(key.scope, at);
        if amount > 0 {
            match (at, by) {
                // A lot is left by ⑩'s WithdrawLot (a caravan), not here.
                (Place::Vault(_), _) => return Err(CustodyError::Forbidden.into()),
                (p, By::Kernel) if !p.kernel_only() => return Err(CustodyError::Forbidden.into()),
                (p, By::Actor(_)) if p.kernel_only() => return Err(CustodyError::Forbidden.into()),
                _ => {}
            }
            t.take_plain(at, r as u8, amount, by)?;
            add(&mut t.exported[r as usize], amount)?;
            if let Place::Hopper(j) = at {
                t.release_if_empty(j, r as u8);
            }
        }
        self.commit(t, key, m);
        Ok(())
    }

    // ------------------------------------------------------------- invariants

    /// Total of `r` held in lots and plain places.
    pub fn held(&self, r: Resource) -> i64 {
        let plain: i64 = self
            .plain
            .iter()
            .filter(|((_, x), _)| *x == r as u8)
            .map(|(_, (_, a))| *a)
            .sum();
        let lots: i64 = self
            .lots
            .iter()
            .filter(|((_, _, x), _)| *x == r as u8)
            .map(|(_, d)| Lot::decode(d).map(|l| l.held).unwrap_or(0))
            .sum();
        plain + lots
    }

    /// Every invariant the adapter promises ⑨ (C1, C2, C4 by construction,
    /// C5, C6 by construction) and ⑩ (each lot's own law, the vault's
    /// capacity, reservations paired with jobs that still hold the goods).
    pub fn check(&self) -> Result<(), String> {
        for ((p, r), (_, a)) in &self.plain {
            if *a <= 0 {
                return Err(format!("C1: {p:?}/{r} holds {a}"));
            }
        }
        for res in Resource::ALL {
            let i = res as usize;
            let lhs = self.held(res) + self.consumed[i] + self.exported[i];
            let rhs = self.imported[i] + self.produced[i];
            if lhs != rhs {
                return Err(format!(
                    "C2: {res:?} held+consumed+exported {lhs} != imported+produced {rhs}"
                ));
            }
        }
        // Lots: their own law, their vault, the vault's count.
        let mut quota: BTreeMap<(u64, u8), (i64, u16)> = BTreeMap::new();
        for ((v, owner, r), d) in &self.lots {
            let l = Lot::decode(d).ok_or_else(|| format!("lot {v}/{owner:?}/{r}: bad account"))?;
            if !l.balanced(0) {
                return Err(format!("lot {v}/{owner:?}/{r}: unbalanced {l:?}"));
            }
            if l.owner != owner.0 || l.resource != *r {
                return Err(format!("lot {v}/{owner:?}/{r}: key and account differ"));
            }
            let vault = self
                .vaults
                .get(v)
                .ok_or(format!("lot in unknown vault {v}"))?;
            if (vault.p, vault.q, vault.tile) != (l.p, l.q, l.tile) {
                return Err(format!("lot {v}/{owner:?}/{r}: not where its vault is"));
            }
            if l.state == L::LOT_OPEN {
                let e = quota.entry((*v, *r)).or_insert((0, 0));
                e.0 += l.quota;
                e.1 += 1;
            }
            for i in l.inbound.iter().filter(|i| i.live) {
                if i.seq == TRANSIENT_SEQ {
                    return Err(format!("lot {v}/{owner:?}/{r}: a transient slot left live"));
                }
                if i.caravan_tag & RETURN_TAG == 0 {
                    continue; // a custody caravan of ⑩
                }
                let paired = self.returns.iter().any(|((j, rr), list)| {
                    rr == r
                        && list.contains(&(*v, *owner))
                        && self.jobs.get(j).map(|u| RETURN_TAG | (u & !RETURN_TAG))
                            == Some(i.caravan_tag)
                });
                if !paired {
                    return Err(format!(
                        "lot {v}/{owner:?}/{r}: unpaired return reservation {i:?}"
                    ));
                }
            }
        }
        for (id, vault) in &self.vaults {
            for r in 0..RESOURCES {
                let (q, _) = quota.get(&(*id, r as u8)).copied().unwrap_or((0, 0));
                if vault.quota[r] != q {
                    return Err(format!("vault {id}: quota {} != lots' {q}", vault.quota[r]));
                }
                if vault.live && vault.stores[r] + vault.quota[r] > vault.cap {
                    return Err(format!("vault {id}: stores + quota over CAP"));
                }
            }
            let n: u16 = quota
                .iter()
                .filter(|((v, _), _)| v == id)
                .map(|(_, (_, n))| *n)
                .sum();
            if vault.lots != n {
                return Err(format!("vault {id}: {} lots counted, {n} open", vault.lots));
            }
        }
        // Each reservation: its job still holds goods of that resource, and
        // its lot has exactly the slot.
        for ((j, r), list) in &self.returns {
            if list.is_empty() {
                return Err(format!("{j:?}/{r}: empty reservation list"));
            }
            if self.held_plain(Place::Hopper(*j), *r) == 0 {
                return Err(format!("{j:?}/{r}: reservation outlives the hopper"));
            }
            let rt = self.rtag(*j);
            for (v, owner) in list {
                let l = self
                    .lot(*v, *owner, *r)
                    .ok_or(format!("{j:?}: reservation in no lot"))?;
                if l.inbound.iter().filter(|i| i.is(rt.0, rt.1)).count() != 1 {
                    return Err(format!("{j:?}: lot {v}/{owner:?} lacks its slot"));
                }
            }
        }
        if let Some(s) = self.stranded.first() {
            return Err(format!("job scope {s} forgotten with goods in it"));
        }
        Ok(())
    }
}

impl Custody for LotCustody {
    fn import(
        &mut self,
        key: Key,
        at: Place,
        owner: Actor,
        r: Resource,
        amount: i64,
    ) -> Result<(), CustodyError> {
        self.try_import(key, at, owner, r, amount).map_err(to_nine)
    }

    fn transfer(
        &mut self,
        key: Key,
        by: By,
        from: Place,
        to: Place,
        r: Resource,
        amount: i64,
        owner: Actor,
    ) -> Result<(), CustodyError> {
        self.try_transfer(key, by, from, to, r, amount, owner)
            .map_err(to_nine)
    }

    fn consume(
        &mut self,
        key: Key,
        at: Place,
        r: Resource,
        amount: i64,
    ) -> Result<(), CustodyError> {
        self.try_consume(key, at, r, amount).map_err(to_nine)
    }

    fn produce(
        &mut self,
        key: Key,
        at: Place,
        owner: Actor,
        r: Resource,
        amount: i64,
    ) -> Result<(), CustodyError> {
        self.try_produce(key, at, owner, r, amount).map_err(to_nine)
    }

    fn export(
        &mut self,
        key: Key,
        by: By,
        at: Place,
        r: Resource,
        amount: i64,
    ) -> Result<(), CustodyError> {
        self.try_export(key, by, at, r, amount).map_err(to_nine)
    }

    /// A vault holds many owners' lots: the owner is named only when one
    /// owner holds `r` there (else `None` with the total). ⑨ must not read
    /// ownership of a vault place from this (I/O table).
    fn balance(&self, at: Place, r: Resource) -> (Option<Actor>, i64) {
        match at {
            Place::Vault(v) => {
                let held: Vec<(Actor, i64)> = self
                    .lots
                    .iter()
                    .filter(|((x, _, rr), _)| *x == v && *rr == r as u8)
                    .filter_map(|((_, o, _), d)| Lot::decode(d).map(|l| (*o, l.held)))
                    .filter(|(_, h)| *h > 0)
                    .collect();
                let total = held.iter().map(|x| x.1).sum();
                match held.as_slice() {
                    [(o, _)] => (Some(*o), total),
                    _ => (None, total),
                }
            }
            _ => match self.plain.get(&(at, r as u8)) {
                Some((o, a)) => (Some(*o), *a),
                None => (None, 0),
            },
        }
    }

    /// Drops the retired job's keys; its places must be empty, and what is
    /// left of its reservations is released (exactly once: the list is
    /// removed with it).
    fn forget(&mut self, scope: u64) {
        self.keys.retain(|k, _| k.scope != scope);
        let jobs: Vec<JobId> = self
            .jobs
            .iter()
            .filter(|(_, u)| **u == scope)
            .map(|(j, _)| *j)
            .collect();
        for j in jobs {
            let mut left = false;
            for r in 0..RESOURCES as u8 {
                if self.held_plain(Place::Hopper(j), r) != 0
                    || self.held_plain(Place::Output(j), r) != 0
                {
                    left = true;
                }
                self.release_all(j, r, Why::Forgotten);
            }
            if left {
                self.stranded.push(scope);
                self.notes.push(Note::Stranded { scope });
            }
            self.jobs.remove(&j);
        }
    }
}
