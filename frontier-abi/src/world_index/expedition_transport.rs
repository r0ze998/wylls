//! Closed, unfinalized expedition transport v2. No runtime admission or IO.
//! Existing v1 bridge/slot codecs remain unchanged and reject these bytes.
//! The full departure Citizen is immutable, not recovered from a short tag.
//! Pure constructors validate shape, not ownership, issuance or provenance.
//! Runtime must authenticate creation, all accounts and the exact slot history.

use super::{
    arrival::{wide_arrival_slot as S, WideArrivalSlot},
    expedition::{AccountFamily, AccountResolver},
    expedition_bridge::{self as bridge, BridgeTransit},
    march::{MarchEvent, MarchState, WideTransit},
};
use crate::addr::AddrCtx;
use permutation_rules::frontier::structure::{wear, TOWER_WEAR_CAP_BPS};

pub const OWNED_BRIDGE_VERSION: u8 = 2;
pub const OWNED_BRIDGE_LEN: usize = bridge::BRIDGE_LEN + 32;
pub const ORIGINAL_OWNER_OFFSET: usize = bridge::BRIDGE_LEN;
pub const EXPEDITION_SLOT_VERSION: u16 = 2;
pub const EXPEDITION_SLOT_LEN: usize = S::SIZE;
pub const WORN_BPS_OFFSET: usize = S::RSV_188;
const _: () = assert!(OWNED_BRIDGE_LEN == 336 && EXPEDITION_SLOT_LEN == 288);
const _: () = assert!(WORN_BPS_OFFSET == 188 && WORN_BPS_OFFSET + 4 == S::BENEFICIARY);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Error {
    Length,
    Version,
    Reserved,
    Bridge,
    Slot,
    Owner,
    Family,
    Wear,
    State,
    Pair,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct OwnedBridgeTransit {
    common: BridgeTransit,
    original_owner: [u8; 32],
}
impl OwnedBridgeTransit {
    /// Departure only. Caller authenticates the full current Holding owner and
    /// supplied Citizen before creating this record. This does not promote v1.
    pub fn new(
        ctx: &AddrCtx,
        slot: u8,
        transit: WideTransit,
        original_owner: [u8; 32],
    ) -> Result<Self, Error> {
        if transit.state != MarchState::Departed {
            return Err(Error::State);
        }
        Self::checked(ctx, slot, transit, original_owner)
    }
    fn checked(
        ctx: &AddrCtx,
        slot: u8,
        transit: WideTransit,
        original_owner: [u8; 32],
    ) -> Result<Self, Error> {
        if original_owner == [0; 32] {
            return Err(Error::Owner);
        }
        let common = BridgeTransit::new(ctx, slot, transit).map_err(|_| Error::Bridge)?;
        Ok(Self {
            common,
            original_owner,
        })
    }
    pub const fn original_owner(&self) -> [u8; 32] {
        self.original_owner
    }
    pub const fn slot(&self) -> u8 {
        self.common.slot()
    }
    pub const fn transit(&self) -> WideTransit {
        self.common.transit()
    }
    /// Common marker/pair validation only, not permission to serialize a v1
    /// replacement or discard this record's original_owner.
    pub const fn common(&self) -> &BridgeTransit {
        &self.common
    }

    pub fn to_bytes(&self) -> [u8; OWNED_BRIDGE_LEN] {
        let mut out = [0; OWNED_BRIDGE_LEN];
        out[..bridge::BRIDGE_LEN].copy_from_slice(&self.common.to_bytes());
        out[8] = OWNED_BRIDGE_VERSION;
        out[ORIGINAL_OWNER_OFFSET..].copy_from_slice(&self.original_owner);
        out
    }
    pub fn from_bytes(ctx: &AddrCtx, bytes: &[u8]) -> Result<Self, Error> {
        if bytes.len() != OWNED_BRIDGE_LEN {
            return Err(Error::Length);
        }
        if bytes[..8] != bridge::MAGIC || bytes[8] != OWNED_BRIDGE_VERSION {
            return Err(Error::Version);
        }
        if bytes[10..16].iter().any(|b| *b != 0) {
            return Err(Error::Reserved);
        }
        let original_owner = bytes[ORIGINAL_OWNER_OFFSET..].try_into().unwrap();
        if original_owner == [0; 32] {
            return Err(Error::Owner);
        }
        // Only after the complete v2 envelope is validated, reuse v1's strict
        // validation of every common field and inner reserved byte.
        let mut common = [0; bridge::BRIDGE_LEN];
        common.copy_from_slice(&bytes[..bridge::BRIDGE_LEN]);
        common[8] = bridge::VERSION;
        let common = BridgeTransit::from_bytes(ctx, &common).map_err(|_| Error::Bridge)?;
        Self::checked(ctx, common.slot(), common.transit(), original_owner)
    }
    /// Origin settlement never changes the departure owner.
    pub fn settle_origin(
        &self,
        ctx: &AddrCtx,
        destroyed: bool,
        settled: Option<(u32, u16, u16)>,
    ) -> Result<Self, Error> {
        let common = self
            .common
            .step(ctx, MarchEvent::SettleDeparture { destroyed }, settled)
            .map_err(|_| Error::State)?;
        Self::checked(ctx, common.slot(), common.transit(), self.original_owner)
    }
    /// The first destination gather applies existing legacy tower wear exactly
    /// once. A repeat at the same destination returns the already-worn state.
    /// Caller must authenticate the exact retained slot/history; this pure
    /// method does not establish that its wear originated in a valid Reveal.
    /// Caller also checks slot.season_id against the authenticated Season;
    /// AddrCtx binds the Season address/world, not its numeric ID. Gathered
    /// state/destination are authoritative, matching WideTransit::step; this
    /// does not invent a separate legacy FLAG_GATHERED write. This helper
    /// returns transport only: population/fate/stamina of a WideArrival must
    /// be derived consistently by the caller on both first and repeat Gather.
    /// Reveal must authenticate the committed stance and its doctrine-derived
    /// slot dealt_bps. That arrival multiplier may differ from the departure's
    /// Hold multiplier, so it is not an immutable transit-pair field.
    pub fn gather_worn(&self, ctx: &AddrCtx, slot: &ExpeditionArrivalSlot) -> Result<Self, Error> {
        slot.validate(ctx)?;
        let s = slot.common();
        let mut t = self.transit();
        if s.host != t.host
            || s.citizen != self.original_owner
            || s.transit_slot != self.slot()
            || s.bell != t.arrive_bell
            || s.unit != t.unit
            || s.faction != t.faction
            || s.dep_mass != t.dep_mass
            || s.flags & S::FLAG_SETTLED != 0
        {
            return Err(Error::Pair);
        }
        match t.state {
            MarchState::Gathered if t.dest == Some(s.dest) => return Ok(*self),
            MarchState::Settled => {
                t.troops_after = wear(t.troops_after as u64, slot.worn_bps) as u32;
            }
            MarchState::DestroyedAtOrigin => {}
            _ => return Err(Error::State),
        }
        let common = BridgeTransit::new(ctx, self.slot(), t)
            .map_err(|_| Error::Bridge)?
            .step(ctx, MarchEvent::Gather { dest: s.dest }, None)
            .map_err(|_| Error::State)?;
        Self::checked(ctx, common.slot(), common.transit(), self.original_owner)
    }
}

/// Same slot allocation and common field offsets as v1, but an explicit v2
/// discriminator and wear in formerly reserved bytes188..190. No defaulting.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ExpeditionArrivalSlot {
    common: WideArrivalSlot,
    worn_bps: u16,
}
impl ExpeditionArrivalSlot {
    pub fn new(ctx: &AddrCtx, common: WideArrivalSlot, worn_bps: u16) -> Result<Self, Error> {
        let result = Self { common, worn_bps };
        result.validate(ctx)?;
        Ok(result)
    }
    fn validate(&self, ctx: &AddrCtx) -> Result<(), Error> {
        if self.worn_bps > TOWER_WEAR_CAP_BPS {
            return Err(Error::Wear);
        }
        if self.common.citizen == [0; 32] {
            return Err(Error::Owner);
        }
        let resolver = AccountResolver::for_season(ctx).map_err(|_| Error::Family)?;
        if resolver
            .family(self.common.host.key())
            .map_err(|_| Error::Family)?
            != AccountFamily::Legacy
            || resolver
                .family(self.common.dest)
                .map_err(|_| Error::Family)?
                != AccountFamily::Wide
        {
            return Err(Error::Family);
        }
        resolver
            .legacy_host_id(&self.common.host)
            .map_err(|_| Error::Family)?;
        self.common
            .write(&mut [0; S::SIZE])
            .map_err(|_| Error::Slot)
    }
    pub const fn common(&self) -> &WideArrivalSlot {
        &self.common
    }
    pub const fn worn_bps(&self) -> u16 {
        self.worn_bps
    }
    /// Fixed-purpose rewrites preserve owner, wear and representation version.
    pub fn with_claimed(mut self, claimed: bool) -> Self {
        self.common.claimed = claimed;
        self
    }
    pub fn with_settled(mut self) -> Self {
        self.common.flags |= S::FLAG_SETTLED;
        self
    }
    pub fn to_bytes(&self, ctx: &AddrCtx) -> Result<[u8; EXPEDITION_SLOT_LEN], Error> {
        self.validate(ctx)?;
        let mut out = [0; EXPEDITION_SLOT_LEN];
        self.common.write(&mut out).map_err(|_| Error::Slot)?;
        out[S::FAMILY_VERSION..S::FAMILY_VERSION + 2]
            .copy_from_slice(&EXPEDITION_SLOT_VERSION.to_le_bytes());
        out[WORN_BPS_OFFSET..WORN_BPS_OFFSET + 2].copy_from_slice(&self.worn_bps.to_le_bytes());
        Ok(out)
    }
    pub fn read(ctx: &AddrCtx, bytes: &[u8]) -> Result<Self, Error> {
        if bytes.len() != EXPEDITION_SLOT_LEN {
            return Err(Error::Length);
        }
        if bytes[..8] != S::MAGIC
            || u16::from_le_bytes(
                bytes[S::FAMILY_VERSION..S::FAMILY_VERSION + 2]
                    .try_into()
                    .unwrap(),
            ) != EXPEDITION_SLOT_VERSION
        {
            return Err(Error::Version);
        }
        let worn_bps = u16::from_le_bytes(
            bytes[WORN_BPS_OFFSET..WORN_BPS_OFFSET + 2]
                .try_into()
                .unwrap(),
        );
        if worn_bps > TOWER_WEAR_CAP_BPS {
            return Err(Error::Wear);
        }
        for (at, len) in [
            (S::RSV_29, 3),
            (S::RSV_36, 4),
            (S::RSV_89, 7),
            (WORN_BPS_OFFSET + 2, 2),
            (S::RSV, 7),
        ] {
            if bytes[at..at + len].iter().any(|b| *b != 0) {
                return Err(Error::Reserved);
            }
        }
        // Explicit v2 validation above precedes sharing the unchanged v1
        // codec for common fields. The original v2 bytes never pass v1 read.
        let mut common = [0; S::SIZE];
        common.copy_from_slice(bytes);
        common[S::FAMILY_VERSION..S::FAMILY_VERSION + 2]
            .copy_from_slice(&super::land::WIDE_LAND_FAMILY_VERSION.to_le_bytes());
        common[WORN_BPS_OFFSET..WORN_BPS_OFFSET + 2].fill(0);
        let common = WideArrivalSlot::read(&common).map_err(|_| Error::Slot)?;
        Self::new(ctx, common, worn_bps)
    }
}

/// Opt-in discriminating reader. Native v1 slots are wide-issued and have the
/// original no-tower-wear semantics. Legacy-issued slots require explicit v2.
/// Existing v1 consumers are not redirected here automatically.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ArrivalSlot {
    Native(WideArrivalSlot),
    Expedition(ExpeditionArrivalSlot),
}
impl ArrivalSlot {
    pub fn read(ctx: &AddrCtx, bytes: &[u8]) -> Result<Self, Error> {
        if bytes.len() != S::SIZE {
            return Err(Error::Length);
        }
        match u16::from_le_bytes(
            bytes[S::FAMILY_VERSION..S::FAMILY_VERSION + 2]
                .try_into()
                .unwrap(),
        ) {
            EXPEDITION_SLOT_VERSION => {
                ExpeditionArrivalSlot::read(ctx, bytes).map(Self::Expedition)
            }
            super::land::WIDE_LAND_FAMILY_VERSION => {
                let common = WideArrivalSlot::read(bytes).map_err(|_| Error::Slot)?;
                Self::validate_native(ctx, &common)?;
                Ok(Self::Native(common))
            }
            _ => Err(Error::Version),
        }
    }
    fn validate_native(ctx: &AddrCtx, s: &WideArrivalSlot) -> Result<(), Error> {
        let resolver = AccountResolver::for_season(ctx).map_err(|_| Error::Family)?;
        if resolver.family(s.host.key()).map_err(|_| Error::Family)? != AccountFamily::Wide
            || resolver.family(s.dest).map_err(|_| Error::Family)? != AccountFamily::Wide
        {
            return Err(Error::Family);
        }
        Ok(())
    }
    pub const fn common(&self) -> &WideArrivalSlot {
        match self {
            Self::Native(s) => s,
            Self::Expedition(s) => s.common(),
        }
    }
    pub const fn worn_bps(&self) -> u16 {
        match self {
            Self::Native(_) => 0,
            Self::Expedition(s) => s.worn_bps(),
        }
    }
    pub fn with_claimed(self, claimed: bool) -> Self {
        match self {
            Self::Native(mut s) => {
                s.claimed = claimed;
                Self::Native(s)
            }
            Self::Expedition(s) => Self::Expedition(s.with_claimed(claimed)),
        }
    }
    pub fn with_settled(self) -> Self {
        match self {
            Self::Native(mut s) => {
                s.flags |= S::FLAG_SETTLED;
                Self::Native(s)
            }
            Self::Expedition(s) => Self::Expedition(s.with_settled()),
        }
    }
    pub fn to_bytes(&self, ctx: &AddrCtx) -> Result<[u8; S::SIZE], Error> {
        match self {
            Self::Native(s) => {
                Self::validate_native(ctx, s)?;
                let mut out = [0; S::SIZE];
                s.write(&mut out).map_err(|_| Error::Slot)?;
                Ok(out)
            }
            Self::Expedition(s) => s.to_bytes(ctx),
        }
    }
}
