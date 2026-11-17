//! The owner's side: the facility Holding, the **real**
//! `permutation_rules::frontier::holding::Holding`, with its workshops'
//! continuous conversion (contract §1, the no-double-use rule 1).
//!
//! Lending takes workshop copies out of the holding's own conversion. Two
//! ways, chosen by the `core-patch-0001` feature:
//!
//! * **patched** (`Holding::lend_workshops` / `reclaim_workshops`, patch
//!   0001): the holding keeps its production and counts `lent_workshops`.
//!   This is the form the program needs (the next Build's copy number is
//!   read from `production`).
//! * **emulated** (unpatched rules crate): the lent copies' arms production
//!   is moved out of `production[ARMS]` and the rates are re-applied
//!   through the public `set_upkeep` (which settles, then applies rates at
//!   the same time). The holding's stores and rates are exactly the
//!   patched ones (`run.sh` checks this in a patched worktree,
//!   `tests/owner_side.rs`); only the copy count read from `production`
//!   would be wrong, which is why the program cannot do it this way.

use borsh::{BorshDeserialize, BorshSerialize};
use permutation_rules::frontier::arms::{ARMS, WORKSHOP_DELTA};
use permutation_rules::frontier::holding::{Holding, HoldingError, Resource};

use crate::model::{Actor, FacilityId, Site};

/// The facility Holding as the kernel sees it.
#[derive(Clone, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize)]
pub struct Facility {
    pub at: Site,
    pub gen: u8,
    pub owner: Actor,
    pub holding: Holding,
    /// Lent copies (the emulated form keeps the count here; the patched
    /// form mirrors `holding.lent_workshops`).
    pub lent: u32,
    /// When each earlier generation ended, and who took it (none: a
    /// release). Written by the core's capture or release.
    pub ended: Vec<(u8, i64, Option<Actor>)>,
}

impl Facility {
    pub fn new(at: Site, gen: u8, owner: Actor, holding: Holding) -> Facility {
        Facility {
            at,
            gen,
            owner,
            holding,
            lent: 0,
            ended: Vec::new(),
        }
    }

    pub fn id(&self) -> FacilityId {
        FacilityId {
            at: self.at,
            gen: self.gen,
        }
    }

    /// Workshop copies built, lent or not.
    pub fn workshops(&self) -> u32 {
        #[cfg(feature = "core-patch-0001")]
        {
            self.holding.workshops()
        }
        #[cfg(not(feature = "core-patch-0001"))]
        {
            (self.holding.production[ARMS as usize].max(0) / WORKSHOP_DELTA) as u32 + self.lent
        }
    }

    /// The owner's own arms rate now (milli per hour, net, as settled).
    pub fn own_arms_rate(&self) -> i64 {
        self.holding.stores[ARMS as usize].rate
    }

    /// The owner action that precedes a lend or a reclaim (the program's
    /// holding touch: settle, then active again).
    pub fn touch(&mut self, now: i64) -> Result<(), HoldingError> {
        self.holding.touch_owner(now)
    }

    /// Lend `n` more copies from `now`.
    pub fn lend(&mut self, now: i64, n: u32) -> Result<(), HoldingError> {
        if self
            .lent
            .checked_add(n)
            .is_none_or(|l| l > self.workshops())
        {
            return Err(HoldingError::Insufficient);
        }
        #[cfg(feature = "core-patch-0001")]
        self.holding.lend_workshops(now, n)?;
        #[cfg(not(feature = "core-patch-0001"))]
        emulated::shift(&mut self.holding, now, -(n as i64))?;
        self.lent += n;
        Ok(())
    }

    /// Take `n` lent copies back from `now`.
    pub fn reclaim(&mut self, now: i64, n: u32) -> Result<(), HoldingError> {
        if n > self.lent {
            return Err(HoldingError::Insufficient);
        }
        #[cfg(feature = "core-patch-0001")]
        self.holding.reclaim_workshops(now, n)?;
        #[cfg(not(feature = "core-patch-0001"))]
        emulated::shift(&mut self.holding, now, n as i64)?;
        self.lent -= n;
        Ok(())
    }

    /// Dormant at `now` (the holding's own rule).
    pub fn dormant(&self, now: i64) -> bool {
        self.holding.is_dormant(now)
    }

    /// The core captures the facility at `now`: a new generation and owner,
    /// the lending ends (patch 0001's `capture_effects`), stores as the
    /// core leaves them.
    pub fn capture(&mut self, now: i64, captor: Actor) -> Result<(), HoldingError> {
        self.holding.settle(now)?;
        let lent = self.lent;
        self.reclaim(now, lent)?;
        self.ended.push((self.gen, now, Some(captor)));
        self.gen = self.gen.wrapping_add(1);
        self.owner = captor;
        self.holding.touch_owner(now)
    }

    /// The core releases a dormant first holding at `at` (no captor).
    pub fn release(&mut self, at: i64) -> Result<(), HoldingError> {
        self.holding.settle(at)?;
        let lent = self.lent;
        self.reclaim(at, lent)?;
        self.ended.push((self.gen, at, None));
        self.gen = self.gen.wrapping_add(1);
        Ok(())
    }

    /// When generation `gen` ended, and its captor.
    pub fn end_of(&self, gen: u8) -> Option<(i64, Option<Actor>)> {
        self.ended
            .iter()
            .find(|(g, _, _)| *g == gen)
            .map(|(_, t, c)| (*t, *c))
    }
}

/// The emulated lending (module note). Public for the differential test.
pub mod emulated {
    use super::*;

    /// Move `copies` workshop copies into (positive) or out of (negative)
    /// the holding's own arms production at `now`.
    pub fn shift(h: &mut Holding, now: i64, copies: i64) -> Result<(), HoldingError> {
        h.settle(now)?;
        let p = &mut h.production[ARMS as usize];
        let next = p.saturating_add(copies.saturating_mul(WORKSHOP_DELTA));
        if next < 0 {
            return Err(HoldingError::Insufficient);
        }
        *p = next;
        // `set_upkeep` settles (a no-op at `now`) and applies the rates.
        let food = h.upkeep[Resource::Food as usize];
        h.set_upkeep(now, Resource::Food, food)
    }
}
