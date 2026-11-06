//! What ⑨ needs from ⑩'s custody (contract §6), and a **mock** of it.
//!
//! ⑨ does not settle a general custody ledger: [`Custody`] is the narrow
//! set of calls the kernel makes, and [`MockCustody`] is a stand-in that
//! checks the invariants C1–C7 so the kernel's tests can rely on them.
//! When ⑩ publishes its ledger, it implements this trait (or the kernel's
//! calls are mapped onto ⑩'s), and the mock stays as the test double.

use std::collections::BTreeMap;

use borsh::{BorshDeserialize, BorshSerialize};
use permutation_rules::frontier::holding::{Resource, RESOURCES};

use crate::model::{Actor, Place};

/// Who asks for a move: the kernel (the job's authority, C4) or a player
/// moving their own goods.
#[derive(Clone, Copy, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize)]
pub enum By {
    Kernel,
    Actor(Actor),
}

/// An idempotency key (C6): the same key with the same call is done once.
#[derive(
    Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, BorshSerialize, BorshDeserialize,
)]
pub struct Key {
    pub scope: u64,
    pub kind: u8,
    pub n: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CustodyError {
    /// C1: not that much there.
    Insufficient,
    /// C4: this caller may not move goods out of that place.
    Forbidden,
    /// C5: the place holds another owner's goods of that resource.
    OwnerMismatch,
    /// C6: the key was used for a different call.
    KeyReused,
    Negative,
    /// The custody's own reason, as its code (⑩'s request R5: an
    /// implementation that knows more than the variants above, such as "no
    /// room", "frozen" or "not whole units", reports it here; the kernel
    /// passes it to the caller through `Harness::apply_detailed`).
    Refused(u16),
}

/// The calls the kernel makes (contract §6). Every call is atomic: an
/// error changes nothing.
pub trait Custody {
    /// Goods enter custody from the core (a Holding's stores paid for a
    /// caravan, a caravan's arrival), owned by `owner`.
    fn import(
        &mut self,
        key: Key,
        at: Place,
        owner: Actor,
        r: Resource,
        amount: i64,
    ) -> Result<(), CustodyError>;
    /// Move `amount` from `from` to `to`; `to` is owned by `owner` after.
    #[allow(clippy::too_many_arguments)]
    fn transfer(
        &mut self,
        key: Key,
        by: By,
        from: Place,
        to: Place,
        r: Resource,
        amount: i64,
        owner: Actor,
    ) -> Result<(), CustodyError>;
    /// A recipe's inputs used up at `at` (kernel only).
    fn consume(
        &mut self,
        key: Key,
        at: Place,
        r: Resource,
        amount: i64,
    ) -> Result<(), CustodyError>;
    /// A recipe's output made at `at`, owned by `owner` (kernel only).
    fn produce(
        &mut self,
        key: Key,
        at: Place,
        owner: Actor,
        r: Resource,
        amount: i64,
    ) -> Result<(), CustodyError>;
    /// Goods leave custody to the core (a Holding's stores).
    fn export(
        &mut self,
        key: Key,
        by: By,
        at: Place,
        r: Resource,
        amount: i64,
    ) -> Result<(), CustodyError>;
    /// The owner and amount at a place (no owner when empty).
    fn balance(&self, at: Place, r: Resource) -> (Option<Actor>, i64);
    /// Drop the idempotency keys of `scope` (a retired job's uid). Safe
    /// because the kernel refuses every operation on a retired job before
    /// it reaches custody; it keeps the key store bounded in a world that
    /// does not end.
    fn forget(&mut self, scope: u64);
}

/// One recorded movement (for the conservation re-check and the demo's
/// place-by-place view).
#[derive(Clone, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize)]
pub enum Move {
    Import {
        at: Place,
        owner: Actor,
        r: u8,
        amount: i64,
    },
    Transfer {
        from: Place,
        to: Place,
        owner: Actor,
        r: u8,
        amount: i64,
    },
    Consume {
        at: Place,
        r: u8,
        amount: i64,
    },
    Produce {
        at: Place,
        owner: Actor,
        r: u8,
        amount: i64,
    },
    Export {
        at: Place,
        r: u8,
        amount: i64,
    },
}

/// **Mock** custody (not ⑩'s): one owner per (place, resource), a set of
/// used keys, and totals for the conservation law (C2).
#[derive(Clone, Debug, Default, PartialEq, Eq, BorshSerialize, BorshDeserialize)]
pub struct MockCustody {
    pub lots: BTreeMap<(Place, u8), (Actor, i64)>,
    pub keys: BTreeMap<Key, Move>,
    pub imported: [i64; RESOURCES],
    pub exported: [i64; RESOURCES],
    pub consumed: [i64; RESOURCES],
    pub produced: [i64; RESOURCES],
    pub log: Vec<Move>,
}

impl MockCustody {
    /// `Ok(true)`: do it; `Ok(false)`: the same call was done (C6).
    fn fresh(&self, key: Key, m: &Move) -> Result<bool, CustodyError> {
        match self.keys.get(&key) {
            None => Ok(true),
            Some(x) if x == m => Ok(false),
            Some(_) => Err(CustodyError::KeyReused),
        }
    }

    fn take(&mut self, at: Place, r: Resource, amount: i64) -> Result<Actor, CustodyError> {
        let k = (at, r as u8);
        let (owner, have) = *self.lots.get(&k).ok_or(CustodyError::Insufficient)?;
        if have < amount {
            return Err(CustodyError::Insufficient);
        }
        if have == amount {
            self.lots.remove(&k);
        } else {
            self.lots.insert(k, (owner, have - amount));
        }
        Ok(owner)
    }

    fn can_put(&self, at: Place, r: Resource, owner: Actor) -> Result<(), CustodyError> {
        match self.lots.get(&(at, r as u8)) {
            Some((o, _)) if *o != owner => Err(CustodyError::OwnerMismatch),
            _ => Ok(()),
        }
    }

    fn put(&mut self, at: Place, r: Resource, owner: Actor, amount: i64) {
        if amount == 0 {
            return;
        }
        let e = self.lots.entry((at, r as u8)).or_insert((owner, 0));
        e.1 += amount;
    }

    fn record(&mut self, key: Key, m: Move) {
        self.keys.insert(key, m.clone());
        self.log.push(m);
    }

    fn may_move(&self, by: By, from: Place, r: Resource) -> Result<(), CustodyError> {
        if from.kernel_only() {
            return if by == By::Kernel {
                Ok(())
            } else {
                Err(CustodyError::Forbidden)
            };
        }
        match (by, self.lots.get(&(from, r as u8))) {
            (By::Kernel, _) => Err(CustodyError::Forbidden),
            (By::Actor(a), Some((o, _))) if a == *o => Ok(()),
            (By::Actor(_), Some(_)) => Err(CustodyError::Forbidden),
            (By::Actor(_), None) => Err(CustodyError::Insufficient),
        }
    }

    /// Total of `r` held at every place.
    pub fn held(&self, r: Resource) -> i64 {
        self.lots
            .iter()
            .filter(|((_, x), _)| *x == r as u8)
            .map(|(_, (_, a))| *a)
            .sum()
    }

    /// C1 and C2: no negative lot, and for every resource
    /// `held + consumed + exported = imported + produced`.
    pub fn check(&self) -> Result<(), String> {
        for ((p, r), (_, a)) in &self.lots {
            if *a <= 0 {
                return Err(format!("C1: lot {p:?}/{r} holds {a}"));
            }
        }
        for r in Resource::ALL {
            let i = r as usize;
            let lhs = self.held(r) + self.consumed[i] + self.exported[i];
            let rhs = self.imported[i] + self.produced[i];
            if lhs != rhs {
                return Err(format!(
                    "C2: {r:?} held+consumed+exported {lhs} != imported+produced {rhs}"
                ));
            }
        }
        Ok(())
    }
}

impl Custody for MockCustody {
    fn import(
        &mut self,
        key: Key,
        at: Place,
        owner: Actor,
        r: Resource,
        amount: i64,
    ) -> Result<(), CustodyError> {
        if amount < 0 {
            return Err(CustodyError::Negative);
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
        self.can_put(at, r, owner)?;
        self.put(at, r, owner, amount);
        self.imported[r as usize] += amount;
        self.record(key, m);
        Ok(())
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
        if amount < 0 {
            return Err(CustodyError::Negative);
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
        if amount == 0 {
            self.record(key, m);
            return Ok(());
        }
        self.may_move(by, from, r)?;
        self.can_put(to, r, owner)?;
        let mut trial = self.clone();
        trial.take(from, r, amount)?;
        trial.can_put(to, r, owner)?;
        trial.put(to, r, owner, amount);
        *self = trial;
        self.record(key, m);
        Ok(())
    }

    fn consume(
        &mut self,
        key: Key,
        at: Place,
        r: Resource,
        amount: i64,
    ) -> Result<(), CustodyError> {
        if amount < 0 {
            return Err(CustodyError::Negative);
        }
        let m = Move::Consume {
            at,
            r: r as u8,
            amount,
        };
        if !self.fresh(key, &m)? {
            return Ok(());
        }
        if amount > 0 {
            if !at.kernel_only() {
                return Err(CustodyError::Forbidden);
            }
            self.take(at, r, amount)?;
            self.consumed[r as usize] += amount;
        }
        self.record(key, m);
        Ok(())
    }

    fn produce(
        &mut self,
        key: Key,
        at: Place,
        owner: Actor,
        r: Resource,
        amount: i64,
    ) -> Result<(), CustodyError> {
        if amount < 0 {
            return Err(CustodyError::Negative);
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
        if amount > 0 {
            if !at.kernel_only() {
                return Err(CustodyError::Forbidden);
            }
            self.can_put(at, r, owner)?;
            self.put(at, r, owner, amount);
            self.produced[r as usize] += amount;
        }
        self.record(key, m);
        Ok(())
    }

    fn export(
        &mut self,
        key: Key,
        by: By,
        at: Place,
        r: Resource,
        amount: i64,
    ) -> Result<(), CustodyError> {
        if amount < 0 {
            return Err(CustodyError::Negative);
        }
        let m = Move::Export {
            at,
            r: r as u8,
            amount,
        };
        if !self.fresh(key, &m)? {
            return Ok(());
        }
        if amount > 0 {
            self.may_move(by, at, r)?;
            self.take(at, r, amount)?;
            self.exported[r as usize] += amount;
        }
        self.record(key, m);
        Ok(())
    }

    fn forget(&mut self, scope: u64) {
        self.keys.retain(|k, _| k.scope != scope);
    }

    fn balance(&self, at: Place, r: Resource) -> (Option<Actor>, i64) {
        match self.lots.get(&(at, r as u8)) {
            Some((o, a)) => (Some(*o), *a),
            None => (None, 0),
        }
    }
}
