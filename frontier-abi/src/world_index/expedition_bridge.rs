//! Closed, pure legacy expedition codecs. No account writer or runtime admission.
//! A marker reserves an original embedded slot and alone records financial
//! authority; its external envelope carries troop state and rent ownership.
//! These codecs do not repair legacy consumers: see the accompanying contract.

use super::{
    expedition::{AccountFamily, AccountResolver},
    march::{transit_address, MarchEvent, MarchState, WideTransit},
};
use crate::{addr::AddrCtx, layout::player::transit as T};

pub const MARKER_LEN: usize = 96;
pub const BRIDGE_LEN: usize = 304;
pub const MARKER_STATE: u8 = 4;
pub const VERSION: u8 = 1;
pub const MAGIC: [u8; 8] = *b"PSWLEXP1";
const MONEY_FLAGS: u8 = T::FLAG_FEE_ESCROWED | T::FLAG_BOND_ESCROWED;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BridgeError {
    Length,
    Version,
    Reserved,
    State,
    Identity,
    Family,
    Slot,
    Address,
    Departure,
    FinancialAuthority,
    Overflow,
    Escrow,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BridgeTransit {
    slot: u8,
    transit: WideTransit,
}

impl BridgeTransit {
    /// Validates a value, not evidence that any troops have been transferred.
    pub fn new(ctx: &AddrCtx, slot: u8, transit: WideTransit) -> Result<Self, BridgeError> {
        if slot >= 4 {
            return Err(BridgeError::Slot);
        }
        let resolver = AccountResolver::for_season(ctx).map_err(|_| BridgeError::Identity)?;
        if resolver
            .family(transit.host.key())
            .map_err(|_| BridgeError::Identity)?
            != AccountFamily::Legacy
            || resolver
                .family(transit.origin.key())
                .map_err(|_| BridgeError::Identity)?
                != AccountFamily::Legacy
        {
            return Err(BridgeError::Family);
        }
        resolver
            .legacy_host_id(&transit.host)
            .map_err(|_| BridgeError::Identity)?;
        if let Some(dest) = transit.dest {
            if resolver.family(dest).map_err(|_| BridgeError::Identity)? != AccountFamily::Wide {
                return Err(BridgeError::Family);
            }
        }
        if transit.tip != 0 || transit.flags & !T::FLAG_GATHERED != 0 {
            return Err(BridgeError::FinancialAuthority);
        }
        if transit.state == MarchState::Free {
            return Err(BridgeError::State);
        }
        if transit.state != MarchState::Gathered && transit.flags & T::FLAG_GATHERED != 0 {
            return Err(BridgeError::State);
        }
        // The existing constructor validates identity version, unit/faction,
        // origin world and arrival timing; decoding validates destination form.
        WideTransit::depart(
            transit.host_identity,
            transit.host,
            transit.unit,
            transit.faction,
            transit.origin,
            transit.depart_bell,
            transit.arrive_bell,
            transit.depart_ts,
            transit.dep_mass,
            transit.march_stamina,
            transit.dealt_bps,
            transit.seal_root,
            0,
            0,
            transit.rent_to,
        )
        .map_err(|_| BridgeError::Departure)?;
        if WideTransit::from_bytes(&transit.to_bytes()).map_err(|_| BridgeError::State)? != transit
        {
            return Err(BridgeError::State);
        }
        if transit.troops_after > transit.dep_mass
            || (transit.state == MarchState::Departed
                && (transit.troops_after != 0
                    || transit.stamina_after != 0
                    || transit.ready_bell_off != 0))
            || (transit.state == MarchState::DestroyedAtOrigin
                && (transit.troops_after != 0 || transit.stamina_after != 0))
        {
            return Err(BridgeError::State);
        }
        Ok(Self { slot, transit })
    }

    pub const fn slot(&self) -> u8 {
        self.slot
    }
    pub const fn transit(&self) -> WideTransit {
        self.transit
    }

    /// Pure transition preserving immutable departure metadata and rent owner.
    /// Final settlement closes the envelope instead of storing a Free record.
    pub fn step(
        &self,
        ctx: &AddrCtx,
        event: MarchEvent,
        settled: Option<(u32, u16, u16)>,
    ) -> Result<Self, BridgeError> {
        let transit = self
            .transit
            .step(event, settled)
            .map_err(|_| BridgeError::State)?;
        Self::new(ctx, self.slot, transit)
    }

    pub fn to_bytes(&self) -> [u8; BRIDGE_LEN] {
        let mut out = [0; BRIDGE_LEN];
        out[..8].copy_from_slice(&MAGIC);
        out[8] = VERSION;
        out[9] = self.slot;
        out[16..].copy_from_slice(&self.transit.to_bytes());
        out
    }

    pub fn from_bytes(ctx: &AddrCtx, bytes: &[u8]) -> Result<Self, BridgeError> {
        if bytes.len() != BRIDGE_LEN {
            return Err(BridgeError::Length);
        }
        if bytes[..8] != MAGIC || bytes[8] != VERSION {
            return Err(BridgeError::Version);
        }
        if bytes[10..16].iter().any(|b| *b != 0) {
            return Err(BridgeError::Reserved);
        }
        let transit = WideTransit::from_bytes(&bytes[16..]).map_err(|_| BridgeError::State)?;
        Self::new(ctx, bytes[9], transit)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BridgeMarker {
    bytes: [u8; MARKER_LEN],
}

impl BridgeMarker {
    /// Initial reservation, before the ordinary legacy Spend result is known.
    pub fn new(
        ctx: &AddrCtx,
        bridge: &BridgeTransit,
        tip: u64,
        flags: u8,
    ) -> Result<Self, BridgeError> {
        if bridge.transit.state != MarchState::Departed {
            return Err(BridgeError::State);
        }
        if flags & !MONEY_FLAGS != 0 {
            return Err(BridgeError::FinancialAuthority);
        }
        let resolver = AccountResolver::for_season(ctx).map_err(|_| BridgeError::Identity)?;
        BridgeTransit::new(ctx, bridge.slot, bridge.transit)?;
        let t = bridge.transit;
        let id = resolver
            .legacy_host_id(&t.host)
            .map_err(|_| BridgeError::Identity)?;
        let origin = resolver
            .adapter()
            .coord_of(&t.origin.key())
            .map_err(|_| BridgeError::Identity)?;
        let mut b = [0; MARKER_LEN];
        b[T::STATE] = MARKER_STATE;
        b[T::UNIT] = t.unit;
        b[T::FACTION] = t.faction;
        b[T::ORIGIN_TILE] = t.origin.local();
        b[T::ORIGIN_P..T::ORIGIN_P + 2].copy_from_slice(&(origin.p as i16).to_le_bytes());
        b[T::ORIGIN_Q..T::ORIGIN_Q + 2].copy_from_slice(&(origin.q as i16).to_le_bytes());
        b[T::HOST_ID..T::HOST_ID + 8].copy_from_slice(&id.to_le_bytes());
        b[T::DEPART_BELL..T::DEPART_BELL + 4].copy_from_slice(&t.depart_bell.to_le_bytes());
        b[T::ARRIVE_BELL..T::ARRIVE_BELL + 4].copy_from_slice(&t.arrive_bell.to_le_bytes());
        b[T::DEPART_TS..T::DEPART_TS + 8].copy_from_slice(&t.depart_ts.to_le_bytes());
        b[T::DEP_MASS..T::DEP_MASS + 4].copy_from_slice(&t.dep_mass.to_le_bytes());
        b[T::MARCH_STAMINA..T::MARCH_STAMINA + 2].copy_from_slice(&t.march_stamina.to_le_bytes());
        b[T::DEALT_BPS..T::DEALT_BPS + 2].copy_from_slice(&t.dealt_bps.to_le_bytes());
        b[T::SEAL_ROOT..T::SEAL_ROOT + 32].copy_from_slice(&t.seal_root);
        b[T::TIP..T::TIP + 8].copy_from_slice(&tip.to_le_bytes());
        b[T::FLAGS] = flags;
        b[T::RSV_93] = VERSION;
        Ok(Self { bytes: b })
    }

    pub const fn to_bytes(&self) -> [u8; MARKER_LEN] {
        self.bytes
    }
    pub fn tip(&self) -> u64 {
        u64::from_le_bytes(self.bytes[T::TIP..T::TIP + 8].try_into().unwrap())
    }
    pub const fn flags(&self) -> u8 {
        self.bytes[T::FLAGS]
    }

    /// Structural validation plus canonical legacy identity/origin and timing.
    /// Account ownership, generation and slot occupancy remain caller checks.
    pub fn from_bytes(ctx: &AddrCtx, bytes: &[u8]) -> Result<Self, BridgeError> {
        if bytes.len() != MARKER_LEN {
            return Err(BridgeError::Length);
        }
        if bytes[T::STATE] != MARKER_STATE {
            return Err(BridgeError::State);
        }
        if bytes[T::RSV_93] != VERSION {
            return Err(BridgeError::Version);
        }
        if bytes[94..96]
            .iter()
            .chain(bytes[T::TROOPS_AFTER..T::SEAL_ROOT].iter())
            .chain(bytes[T::DEST_P..T::RSV_93].iter())
            .any(|b| *b != 0)
        {
            return Err(BridgeError::Reserved);
        }
        if bytes[T::FLAGS] & !MONEY_FLAGS != 0 {
            return Err(BridgeError::FinancialAuthority);
        }
        let resolver = AccountResolver::for_season(ctx).map_err(|_| BridgeError::Identity)?;
        let u32_at = |o| u32::from_le_bytes(bytes[o..o + 4].try_into().unwrap());
        let u16_at = |o| u16::from_le_bytes(bytes[o..o + 2].try_into().unwrap());
        let id = u64::from_le_bytes(bytes[T::HOST_ID..T::HOST_ID + 8].try_into().unwrap());
        let host = resolver
            .legacy_host_ref(id)
            .map_err(|_| BridgeError::Identity)?;
        let p = i16::from_le_bytes(bytes[T::ORIGIN_P..T::ORIGIN_P + 2].try_into().unwrap());
        let q = i16::from_le_bytes(bytes[T::ORIGIN_Q..T::ORIGIN_Q + 2].try_into().unwrap());
        let key =
            resolver
                .adapter()
                .key_of(permutation_rules::frontier::geometry::ProvinceCoord::new(
                    p as i32, q as i32,
                ));
        let origin = super::TileAddress::new(key, bytes[T::ORIGIN_TILE])
            .map_err(|_| BridgeError::Departure)?;
        let t = WideTransit::depart(
            super::HOST_IDENTITY_FULL_REF_V1,
            host,
            bytes[T::UNIT],
            bytes[T::FACTION],
            origin,
            u32_at(T::DEPART_BELL),
            u32_at(T::ARRIVE_BELL),
            i64::from_le_bytes(bytes[T::DEPART_TS..T::DEPART_TS + 8].try_into().unwrap()),
            u32_at(T::DEP_MASS),
            u16_at(T::MARCH_STAMINA),
            u16_at(T::DEALT_BPS),
            bytes[T::SEAL_ROOT..T::SEAL_ROOT + 32].try_into().unwrap(),
            0,
            0,
            [0; 32],
        )
        .map_err(|_| BridgeError::Departure)?;
        BridgeTransit::new(ctx, 0, t)?;
        Ok(Self {
            bytes: bytes.try_into().unwrap(),
        })
    }

    /// Pure capture bookkeeping. Caller authenticates the captured Holding and
    /// victim rent payer, pays/diverts under legacy rules, and applies atomically.
    /// No external record is needed, so a missing pair cannot block capture.
    pub fn capture_bond_plan(
        &self,
        escrow: u64,
        seal_bond: u64,
    ) -> Result<CaptureBondPlan, BridgeError> {
        let refund = if self.flags() & T::FLAG_BOND_ESCROWED != 0 {
            seal_bond
        } else {
            0
        };
        let escrow_after = escrow.checked_sub(refund).ok_or(BridgeError::Escrow)?;
        let mut marker_after = *self;
        marker_after.bytes[T::FLAGS] &= !T::FLAG_BOND_ESCROWED;
        Ok(CaptureBondPlan {
            marker_after,
            escrow_after,
            refund,
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CaptureBondPlan {
    pub marker_after: BridgeMarker,
    pub escrow_after: u64,
    pub refund: u64,
}

/// A validated snapshot, not an authorization token or a live account lock.
pub struct PairedBridge {
    marker: BridgeMarker,
    bridge: BridgeTransit,
}

pub fn authenticate_pair(
    ctx: &AddrCtx,
    holding: &[u8; 32],
    slot: u8,
    external: &[u8; 32],
    marker: &BridgeMarker,
    bridge: &BridgeTransit,
) -> Result<PairedBridge, BridgeError> {
    if slot >= 4 || slot != bridge.slot {
        return Err(BridgeError::Slot);
    }
    BridgeTransit::new(ctx, slot, bridge.transit)?;
    BridgeMarker::from_bytes(ctx, &marker.bytes)?;
    let resolver = AccountResolver::for_season(ctx).map_err(|_| BridgeError::Identity)?;
    if resolver
        .holding_address(&bridge.transit.host)
        .map_err(|_| BridgeError::Identity)?
        != *holding
        || transit_address(ctx, holding, slot) != *external
    {
        return Err(BridgeError::Address);
    }
    let mut initial = bridge.transit;
    initial.state = MarchState::Departed;
    initial.dest = None;
    initial.flags = 0;
    initial.troops_after = 0;
    initial.stamina_after = 0;
    initial.ready_bell_off = 0;
    let initial = BridgeTransit::new(ctx, slot, initial)?;
    if BridgeMarker::new(ctx, &initial, marker.tip(), marker.flags())? != *marker {
        return Err(BridgeError::Departure);
    }
    Ok(PairedBridge {
        marker: *marker,
        bridge: *bridge,
    })
}

pub struct FinancialInput {
    /// Ephemeral settlement input only; never serialize as external authority.
    pub transit: WideTransit,
    pub fee: u64,
    pub bond: u64,
    pub total: u64,
}

impl PairedBridge {
    /// Prices are the authenticated Season's existing values, not new rules.
    /// Re-read and pair after capture; a saved plan cannot authorize payment.
    pub fn financial_input(
        &self,
        march_fee: u64,
        seal_bond: u64,
    ) -> Result<FinancialInput, BridgeError> {
        if self.bridge.transit.state == MarchState::Departed {
            return Err(BridgeError::State);
        }
        let mut transit = self.bridge.transit;
        transit.tip = self.marker.tip();
        let fee = if self.marker.flags() & T::FLAG_FEE_ESCROWED != 0 {
            march_fee
        } else {
            0
        };
        let bond = if self.marker.flags() & T::FLAG_BOND_ESCROWED != 0 {
            seal_bond
        } else {
            0
        };
        let total = transit
            .tip
            .checked_add(fee)
            .and_then(|n| n.checked_add(bond))
            .ok_or(BridgeError::Overflow)?;
        Ok(FinancialInput {
            transit,
            fee,
            bond,
            total,
        })
    }
}
