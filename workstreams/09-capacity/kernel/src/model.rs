//! Identities, places and owners (contract §1, §3).

use borsh::{BorshDeserialize, BorshSerialize};

/// A player: the Citizen key (the owner, a user, a captor).
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, BorshSerialize, BorshDeserialize)]
pub struct Actor(pub [u8; 32]);

impl core::fmt::Debug for Actor {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        write!(f, "Actor({:02x}{:02x}…)", self.0[0], self.0[1])
    }
}

impl Actor {
    /// A test actor from one byte (demos and tests only).
    pub const fn test(b: u8) -> Actor {
        Actor([b; 32])
    }
}

/// A Holding's address (`ho‖P,Q,site`) without its generation.
#[derive(
    Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, BorshSerialize, BorshDeserialize,
)]
pub struct Site {
    pub p: i16,
    pub q: i16,
    pub site: u8,
}

/// A facility: a Holding's address and its generation (`Holding.GEN`). A
/// capture or a release changes the generation, and every pool, grant and
/// job of the old one is void (contract §1).
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, BorshSerialize, BorshDeserialize)]
pub struct FacilityId {
    pub at: Site,
    pub gen: u8,
}

/// A grant: the facility and the owner's grant number (its natural key,
/// the PDA seed on chain).
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, BorshSerialize, BorshDeserialize)]
pub struct GrantId {
    pub facility: FacilityId,
    pub seq: u32,
}

/// A job (reservation): the grant and the user's job number.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, BorshSerialize, BorshDeserialize)]
pub struct JobId {
    pub grant: GrantId,
    pub seq: u32,
}

impl JobId {
    /// A compact number for custody keys (not an address).
    pub fn tag(&self) -> u64 {
        let f = self.grant.facility;
        let a = ((f.at.p as u16 as u64) << 48)
            | ((f.at.q as u16 as u64) << 32)
            | ((f.at.site as u64) << 24)
            | ((f.gen as u64) << 16);
        a ^ ((self.grant.seq as u64) << 8).rotate_left(17) ^ (self.seq as u64).rotate_left(41)
    }
}

/// Where goods are (contract §3, the place table). Places outside the
/// kernel (a Holding's stores, a vault, a caravan) belong to the core and
/// to ⑩; `Hopper` and `Output` are a job's, at the facility's tile.
#[derive(
    Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, BorshSerialize, BorshDeserialize,
)]
pub enum Place {
    /// A Holding's stores (the core's `Holding.stores`).
    Holding(Site),
    /// A vault (S1 `Vault` account) by its id.
    Vault(u64),
    /// A caravan in transit by its id (`caravan::caravan_id`).
    Caravan(u64),
    /// A job's materials at the facility, owned by the job's user.
    Hopper(JobId),
    /// A job's products at the facility, owned by the job's user.
    Output(JobId),
}

impl Place {
    /// Goods here move only by the kernel (custody invariant C4).
    pub const fn kernel_only(&self) -> bool {
        matches!(self, Place::Hopper(_) | Place::Output(_))
    }
}

impl core::fmt::Debug for FacilityId {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        write!(
            f,
            "F({},{}/{} g{})",
            self.at.p, self.at.q, self.at.site, self.gen
        )
    }
}

impl core::fmt::Debug for GrantId {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        write!(f, "{:?}.G{}", self.facility, self.seq)
    }
}

impl core::fmt::Debug for JobId {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        write!(f, "{:?}.J{}", self.grant, self.seq)
    }
}
