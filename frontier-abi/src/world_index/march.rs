//! **Experimental, opt-in** (`--features world-index-experimental`): the
//! versioned march record of a wide host and its **complete lifecycle**,
//! gated on a host identity that is not yet allocated.
//!
//! A legacy march is one transit record of the origin Holding (96 B,
//! `layout::player::transit`) keyed by a `u64` host id, settled at the
//! origin (SettleDeparture), revealed into an ArrivalSlot at the
//! destination (Reveal), gathered (GatherClash), resolved and finally
//! settled back (SettleTransit, which frees the record and returns or
//! strands the host). Every one of those stages keys the host by the same
//! `u64`, whose 20-bit dense province field no wide province has.
//!
//! This module states the wide form of that record over a `WideHostRef`
//! and a `ProvinceKey`, with the same fields and the same stage order
//! ([`MarchState`], [`MarchEvent`], [`step`]), so that every future stage
//! handler shares one identity and one state table. It does **not** price,
//! time, resolve or settle anything: the clash kernel, `host::march_values`,
//! `travel::check_arrival_bell` and the seal remain the only rules, and
//! the legacy handlers remain the only code that runs them. What it adds
//! is the invariant the owner asked for: [`WideTransit::depart`] refuses
//! [`MarchError::HostIdentityUnallocated`] while
//! [`super::holding::HOST_IDENTITY_UNALLOCATED`] is the only identity
//! version, so **no wide march can be debited before the identity that
//! could settle it exists**, and [`step`] refuses every transition the
//! legacy lifecycle does not have.
//!
//! The one decision this leaves open is the shape of the wider host
//! identity (`UNBOUNDED-IDENTIFIERS.md` §3.2: a per-world alias slot inside
//! the `u64`, a 128-bit `world ‖ id`, or a hash) and the ABI version that
//! carries it; the record stores the version it was opened under so a
//! later allocation never reinterprets an earlier record.

use super::key::{KeyError, ProvinceKey, WideHostRef, HOST_REF_LEN, PROVINCE_KEY_LEN};
use super::tiles::{TileAddress, TileError};
use crate::bytes::{
    rd_arr, rd_i64, rd_u16, rd_u32, rd_u64, rd_u8, wr_arr, wr_i64, wr_u16, wr_u32, wr_u64, wr_u8,
};
use crate::layout::player::transit as T;
use permutation_rules::frontier::geometry::PROVINCE_TILES;

/// Layout version of the wide transit bytes.
pub const WIDE_TRANSIT_VERSION: u8 = 1;
/// Bytes of a wide transit record.
pub const WIDE_TRANSIT_LEN: usize = 256;

/// The stages of a march, in the legacy order. The legacy record keeps
/// the first four as its `state` byte and the fifth as `FLAG_GATHERED`;
/// the settle that frees the record is the return to `Free`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MarchState {
    /// No march (the record is free).
    Free,
    /// Departed; the origin's clash of the departure bell is not resolved.
    Departed,
    /// The departure settled: post-clash troops and stamina known.
    Settled,
    /// The departure settled and the host was destroyed at the origin.
    DestroyedAtOrigin,
    /// A gather at the destination recorded the transit (the legacy
    /// `FLAG_GATHERED`); it may now settle only against that destination.
    Gathered,
}

impl MarchState {
    const fn to_byte(self) -> u8 {
        match self {
            MarchState::Free => T::STATE_FREE,
            MarchState::Departed => T::STATE_DEPARTED,
            MarchState::Settled => T::STATE_SETTLED,
            MarchState::DestroyedAtOrigin => T::STATE_DESTROYED_AT_ORIGIN,
            MarchState::Gathered => 4,
        }
    }
    const fn from_byte(b: u8) -> Option<MarchState> {
        match b {
            T::STATE_FREE => Some(MarchState::Free),
            T::STATE_DEPARTED => Some(MarchState::Departed),
            T::STATE_SETTLED => Some(MarchState::Settled),
            T::STATE_DESTROYED_AT_ORIGIN => Some(MarchState::DestroyedAtOrigin),
            4 => Some(MarchState::Gathered),
            _ => None,
        }
    }
    /// The host may not act (the legacy `in_transit`).
    pub const fn in_transit(self) -> bool {
        !matches!(self, MarchState::Free)
    }
}

/// The events of the legacy lifecycle.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MarchEvent {
    /// SettleDeparture: the origin resolved the departure bell.
    SettleDeparture { destroyed: bool },
    /// GatherClash recorded the transit at `dest`.
    Gather { dest: ProvinceKey },
    /// SettleTransit: the march ends (returned, stayed, stranded or
    /// forfeited; the outcome is the settle's, not the record's).
    SettleTransit,
}

/// Why a record or a transition is refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MarchError {
    /// No wider host identity is allocated: a wide host cannot depart.
    HostIdentityUnallocated,
    UnknownHostIdentity(u16),
    Unit(u8),
    Faction(u8),
    /// The event is not a transition of the lifecycle from this state.
    InvalidTransition {
        from: MarchState,
        event: u8,
    },
    /// A gather names a destination of another world.
    WorldMismatch,
    /// An arrival bell outside `depart + 2 ..= depart + 72`.
    ArrivalBell {
        depart_bell: u32,
        arrive_bell: u32,
    },
    Length {
        expected: usize,
        got: usize,
    },
    Version {
        expected: u8,
        got: u8,
    },
    Reserved,
    State(u8),
    Key(KeyError),
    Tile(TileError),
    /// A `Gathered` record without a destination, or a destination on an
    /// ungathered record.
    Destination,
}

impl From<KeyError> for MarchError {
    fn from(e: KeyError) -> Self {
        MarchError::Key(e)
    }
}

impl From<TileError> for MarchError {
    fn from(e: TileError) -> Self {
        MarchError::Tile(e)
    }
}

/// The legacy bounds of a chosen arrival bell (`travel::MIN_ARRIVAL_LEAD_BELLS`,
/// `travel::MAX_ARRIVAL_LEAD_BELLS`), restated from the kernel.
pub const MIN_ARRIVAL_LEAD_BELLS: u32 = permutation_rules::frontier::travel::MIN_ARRIVAL_LEAD_BELLS;
pub const MAX_ARRIVAL_LEAD_BELLS: u32 = permutation_rules::frontier::travel::MAX_ARRIVAL_LEAD_BELLS;

/// One march of a wide host: the legacy transit fields over wide
/// identities.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct WideTransit {
    pub state: MarchState,
    /// The host identity version the march was opened under.
    pub host_identity: u16,
    pub host: WideHostRef,
    pub unit: u8,
    pub faction: u8,
    /// Where the host stood at the departure.
    pub origin: TileAddress,
    /// Set by the gather; `None` before.
    pub dest: Option<ProvinceKey>,
    pub depart_bell: u32,
    pub arrive_bell: u32,
    pub depart_ts: i64,
    pub dep_mass: u32,
    pub march_stamina: u16,
    pub dealt_bps: u16,
    pub troops_after: u32,
    pub stamina_after: u16,
    pub ready_bell_off: u16,
    pub seal_root: [u8; 32],
    pub tip: u64,
    pub flags: u8,
}

/// Offsets of the record.
mod off {
    pub const VERSION: usize = 0;
    pub const STATE: usize = 1;
    pub const UNIT: usize = 2;
    pub const FACTION: usize = 3;
    pub const HOST_IDENTITY: usize = 4;
    pub const FLAGS: usize = 6;
    pub const HAS_DEST: usize = 7;
    pub const HOST: usize = 8; // 56
    pub const ORIGIN_KEY: usize = 64; // 50
    pub const ORIGIN_TILE: usize = 114;
    pub const RSV_115: usize = 115;
    pub const DEST_KEY: usize = 116; // 50
    pub const RSV_166: usize = 166;
    pub const DEPART_BELL: usize = 168;
    pub const ARRIVE_BELL: usize = 172;
    pub const DEPART_TS: usize = 176;
    pub const DEP_MASS: usize = 184;
    pub const MARCH_STAMINA: usize = 188;
    pub const DEALT_BPS: usize = 190;
    pub const TROOPS_AFTER: usize = 192;
    pub const STAMINA_AFTER: usize = 196;
    pub const READY_BELL_OFF: usize = 198;
    pub const SEAL_ROOT: usize = 200; // 32
    pub const TIP: usize = 232;
    pub const RSV: usize = 240;
    pub const RSV_LEN: usize = 16;
    const _: () = {
        assert!(HOST + super::HOST_REF_LEN == ORIGIN_KEY);
        assert!(ORIGIN_KEY + super::PROVINCE_KEY_LEN == ORIGIN_TILE);
        assert!(DEST_KEY + super::PROVINCE_KEY_LEN == RSV_166);
        assert!(RSV + RSV_LEN == super::WIDE_TRANSIT_LEN);
    };
}

impl WideTransit {
    /// The departure of `host` from `origin` under `host_identity`: refused
    /// [`MarchError::HostIdentityUnallocated`] under version 0 (what the
    /// program knows), so the record can never be written and no debit
    /// can be taken; otherwise the legacy arrival-bell bounds. The seal
    /// root, tip, mass and doctrine values are the caller's (the legacy
    /// Depart computes them; nothing is priced here).
    #[allow(clippy::too_many_arguments)]
    pub fn depart(
        host_identity: u16,
        host: WideHostRef,
        unit: u8,
        faction: u8,
        origin: TileAddress,
        depart_bell: u32,
        arrive_bell: u32,
        depart_ts: i64,
        dep_mass: u32,
        march_stamina: u16,
        dealt_bps: u16,
        seal_root: [u8; 32],
        tip: u64,
        flags: u8,
    ) -> Result<WideTransit, MarchError> {
        if host_identity == super::holding::HOST_IDENTITY_UNALLOCATED {
            return Err(MarchError::HostIdentityUnallocated);
        }
        if host_identity != 1 {
            return Err(MarchError::UnknownHostIdentity(host_identity));
        }
        if unit >= 8 {
            return Err(MarchError::Unit(unit));
        }
        if faction >= 6 {
            return Err(MarchError::Faction(faction));
        }
        let err = MarchError::ArrivalBell {
            depart_bell,
            arrive_bell,
        };
        let lo = depart_bell.checked_add(MIN_ARRIVAL_LEAD_BELLS).ok_or(err)?;
        let hi = depart_bell.checked_add(MAX_ARRIVAL_LEAD_BELLS).ok_or(err)?;
        if arrive_bell < lo || arrive_bell > hi {
            return Err(MarchError::ArrivalBell {
                depart_bell,
                arrive_bell,
            });
        }
        if host.key().world() != origin.world() {
            return Err(MarchError::WorldMismatch);
        }
        Ok(WideTransit {
            state: MarchState::Departed,
            host_identity,
            host,
            unit,
            faction,
            origin,
            dest: None,
            depart_bell,
            arrive_bell,
            depart_ts,
            dep_mass,
            march_stamina,
            dealt_bps,
            troops_after: 0,
            stamina_after: 0,
            ready_bell_off: 0,
            seal_root,
            tip,
            flags,
        })
    }

    /// The record after `event`, by the legacy lifecycle: a departure
    /// settles once (to `Settled` or `DestroyedAtOrigin`); a settled
    /// transit may be gathered once, at a destination of its world; a
    /// settled or gathered transit ends with the settle, which frees the
    /// record. Every other pair is refused. The settled values are the
    /// caller's (`host::march_values` in the legacy settle).
    pub fn step(
        self,
        event: MarchEvent,
        settled: Option<(u32, u16, u16)>,
    ) -> Result<WideTransit, MarchError> {
        let code = match event {
            MarchEvent::SettleDeparture { .. } => 1,
            MarchEvent::Gather { .. } => 2,
            MarchEvent::SettleTransit => 3,
        };
        let invalid = MarchError::InvalidTransition {
            from: self.state,
            event: code,
        };
        match (self.state, event) {
            (MarchState::Departed, MarchEvent::SettleDeparture { destroyed }) => {
                let (troops_after, stamina_after, ready_bell_off) = if destroyed {
                    (0, 0, settled.map_or(0, |s| s.2))
                } else {
                    settled.ok_or(invalid)?
                };
                Ok(WideTransit {
                    state: if destroyed {
                        MarchState::DestroyedAtOrigin
                    } else {
                        MarchState::Settled
                    },
                    troops_after,
                    stamina_after,
                    ready_bell_off,
                    ..self
                })
            }
            (MarchState::Settled | MarchState::DestroyedAtOrigin, MarchEvent::Gather { dest }) => {
                if dest.world() != self.origin.world() {
                    return Err(MarchError::WorldMismatch);
                }
                Ok(WideTransit {
                    state: MarchState::Gathered,
                    dest: Some(dest),
                    ..self
                })
            }
            (
                MarchState::Settled | MarchState::DestroyedAtOrigin | MarchState::Gathered,
                MarchEvent::SettleTransit,
            ) => Ok(WideTransit {
                state: MarchState::Free,
                dest: None,
                ..self
            }),
            _ => Err(invalid),
        }
    }

    /// `WIDE_TRANSIT_VERSION ‖ state ‖ unit ‖ faction ‖ identity ‖ flags ‖
    /// has_dest ‖ host ref ‖ origin key ‖ origin tile ‖ dest key ‖ bells,
    /// times, values ‖ seal root ‖ tip`, 256 bytes.
    pub fn to_bytes(&self) -> [u8; WIDE_TRANSIT_LEN] {
        let mut b = [0u8; WIDE_TRANSIT_LEN];
        let _ = wr_u8(&mut b, off::VERSION, WIDE_TRANSIT_VERSION)
            & wr_u8(&mut b, off::STATE, self.state.to_byte())
            & wr_u8(&mut b, off::UNIT, self.unit)
            & wr_u8(&mut b, off::FACTION, self.faction)
            & wr_u16(&mut b, off::HOST_IDENTITY, self.host_identity)
            & wr_u8(&mut b, off::FLAGS, self.flags)
            & wr_u8(&mut b, off::HAS_DEST, self.dest.is_some() as u8)
            & wr_arr(&mut b, off::HOST, &self.host.to_bytes())
            & wr_arr(&mut b, off::ORIGIN_KEY, &self.origin.key().to_bytes())
            & wr_u8(&mut b, off::ORIGIN_TILE, self.origin.local())
            & wr_arr(
                &mut b,
                off::DEST_KEY,
                &self.dest.map_or([0u8; PROVINCE_KEY_LEN], |k| k.to_bytes()),
            )
            & wr_u32(&mut b, off::DEPART_BELL, self.depart_bell)
            & wr_u32(&mut b, off::ARRIVE_BELL, self.arrive_bell)
            & wr_i64(&mut b, off::DEPART_TS, self.depart_ts)
            & wr_u32(&mut b, off::DEP_MASS, self.dep_mass)
            & wr_u16(&mut b, off::MARCH_STAMINA, self.march_stamina)
            & wr_u16(&mut b, off::DEALT_BPS, self.dealt_bps)
            & wr_u32(&mut b, off::TROOPS_AFTER, self.troops_after)
            & wr_u16(&mut b, off::STAMINA_AFTER, self.stamina_after)
            & wr_u16(&mut b, off::READY_BELL_OFF, self.ready_bell_off)
            & wr_arr(&mut b, off::SEAL_ROOT, &self.seal_root)
            & wr_u64(&mut b, off::TIP, self.tip);
        b
    }

    /// Inverse of [`WideTransit::to_bytes`]: exact length, this version, a
    /// known state, a destination exactly when gathered, zero reserved
    /// bytes, canonical keys.
    pub fn from_bytes(d: &[u8]) -> Result<WideTransit, MarchError> {
        if d.len() != WIDE_TRANSIT_LEN {
            return Err(MarchError::Length {
                expected: WIDE_TRANSIT_LEN,
                got: d.len(),
            });
        }
        let t = MarchError::Length {
            expected: WIDE_TRANSIT_LEN,
            got: 0,
        };
        let v = rd_u8(d, off::VERSION).ok_or(t)?;
        if v != WIDE_TRANSIT_VERSION {
            return Err(MarchError::Version {
                expected: WIDE_TRANSIT_VERSION,
                got: v,
            });
        }
        let sb = rd_u8(d, off::STATE).ok_or(t)?;
        let state = MarchState::from_byte(sb).ok_or(MarchError::State(sb))?;
        for (o, n) in [
            (off::RSV_115, 1usize),
            (off::RSV_166, 2),
            (off::RSV, off::RSV_LEN),
        ] {
            if d.get(o..o + n).is_none_or(|s| s.iter().any(|b| *b != 0)) {
                return Err(MarchError::Reserved);
            }
        }
        let host = WideHostRef::from_bytes(&d[off::HOST..off::HOST + HOST_REF_LEN])?;
        let origin_key =
            ProvinceKey::from_bytes(&d[off::ORIGIN_KEY..off::ORIGIN_KEY + PROVINCE_KEY_LEN])?;
        let tile = rd_u8(d, off::ORIGIN_TILE).ok_or(t)?;
        if tile as usize >= PROVINCE_TILES {
            return Err(MarchError::Tile(TileError::LocalIndex(tile)));
        }
        let origin = TileAddress::new(origin_key, tile)?;
        let has_dest = rd_u8(d, off::HAS_DEST).ok_or(t)?;
        let dest_bytes = &d[off::DEST_KEY..off::DEST_KEY + PROVINCE_KEY_LEN];
        let dest = match (state, has_dest) {
            (MarchState::Gathered, 1) => Some(ProvinceKey::from_bytes(dest_bytes)?),
            (MarchState::Gathered, _) => return Err(MarchError::Destination),
            (_, 0) if dest_bytes.iter().all(|b| *b == 0) => None,
            _ => return Err(MarchError::Destination),
        };
        let host_identity = rd_u16(d, off::HOST_IDENTITY).ok_or(t)?;
        if host_identity == 0 {
            return Err(MarchError::HostIdentityUnallocated);
        }
        if host_identity != 1 {
            return Err(MarchError::UnknownHostIdentity(host_identity));
        }
        if host.key().world() != origin.world() || dest.is_some_and(|d| d.world() != origin.world())
        {
            return Err(MarchError::WorldMismatch);
        }
        let unit = rd_u8(d, off::UNIT).ok_or(t)?;
        let faction = rd_u8(d, off::FACTION).ok_or(t)?;
        if unit >= 8 {
            return Err(MarchError::Unit(unit));
        }
        if faction >= 6 {
            return Err(MarchError::Faction(faction));
        }
        Ok(WideTransit {
            state,
            host_identity,
            host,
            unit,
            faction,
            origin,
            dest,
            depart_bell: rd_u32(d, off::DEPART_BELL).ok_or(t)?,
            arrive_bell: rd_u32(d, off::ARRIVE_BELL).ok_or(t)?,
            depart_ts: rd_i64(d, off::DEPART_TS).ok_or(t)?,
            dep_mass: rd_u32(d, off::DEP_MASS).ok_or(t)?,
            march_stamina: rd_u16(d, off::MARCH_STAMINA).ok_or(t)?,
            dealt_bps: rd_u16(d, off::DEALT_BPS).ok_or(t)?,
            troops_after: rd_u32(d, off::TROOPS_AFTER).ok_or(t)?,
            stamina_after: rd_u16(d, off::STAMINA_AFTER).ok_or(t)?,
            ready_bell_off: rd_u16(d, off::READY_BELL_OFF).ok_or(t)?,
            seal_root: rd_arr(d, off::SEAL_ROOT).ok_or(t)?,
            tip: rd_u64(d, off::TIP).ok_or(t)?,
            flags: rd_u8(d, off::FLAGS).ok_or(t)?,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::world_index::coord::WideCoord;
    use crate::world_index::holding::HOST_IDENTITY_UNALLOCATED;
    use crate::world_index::key::WorldId;

    fn world(b: u8) -> WorldId {
        WorldId::new([b; 32]).unwrap()
    }

    fn host(w: WorldId) -> WideHostRef {
        let key = ProvinceKey::new(w, WideCoord::checked(129, 0).unwrap());
        WideHostRef::new(key, 3, 1, 7).unwrap()
    }

    fn origin(w: WorldId) -> TileAddress {
        TileAddress::new(ProvinceKey::new(w, WideCoord::checked(129, 0).unwrap()), 30).unwrap()
    }

    /// A model exercise under a hypothetical allocated identity (1); the
    /// program passes 0 and gets the refusal below.
    fn departed() -> WideTransit {
        WideTransit::depart(
            1,
            host(world(1)),
            2,
            4,
            origin(world(1)),
            100,
            110,
            1_800_060_000,
            500_000,
            74,
            10_000,
            [0xab; 32],
            14_441,
            T::FLAG_FEE_ESCROWED | T::FLAG_BOND_ESCROWED,
        )
        .unwrap()
    }

    /// Under the only identity version the program has, no wide march can
    /// be opened: the first check, before any other.
    #[test]
    fn no_departure_under_an_unallocated_host_identity() {
        assert_eq!(
            WideTransit::depart(
                HOST_IDENTITY_UNALLOCATED,
                host(world(1)),
                2,
                4,
                origin(world(1)),
                100,
                110,
                0,
                500_000,
                74,
                10_000,
                [0; 32],
                0,
                0,
            ),
            Err(MarchError::HostIdentityUnallocated)
        );
        // even a malformed request is refused by the identity gate first
        assert_eq!(
            WideTransit::depart(
                HOST_IDENTITY_UNALLOCATED,
                host(world(1)),
                2,
                4,
                origin(world(2)),
                100,
                1,
                0,
                0,
                0,
                0,
                [0; 32],
                0,
                0,
            ),
            Err(MarchError::HostIdentityUnallocated)
        );
        assert_eq!(HOST_IDENTITY_UNALLOCATED, 0);
    }

    /// The lifecycle is the legacy one: departure settle once, gather once
    /// in the same world, the settle frees; nothing else; the arrival bell
    /// obeys the legacy lead bounds (restated from the kernel).
    #[test]
    fn lifecycle_is_the_legacy_order_and_nothing_else() {
        assert_eq!(MIN_ARRIVAL_LEAD_BELLS, 2);
        assert_eq!(MAX_ARRIVAL_LEAD_BELLS, 72);
        for arrive in [0u32, 99, 100, 101, 173, u32::MAX] {
            assert_eq!(
                WideTransit::depart(
                    1,
                    host(world(1)),
                    2,
                    4,
                    origin(world(1)),
                    100,
                    arrive,
                    0,
                    1,
                    1,
                    1,
                    [0; 32],
                    0,
                    0
                ),
                Err(MarchError::ArrivalBell {
                    depart_bell: 100,
                    arrive_bell: arrive
                })
            );
        }
        for arrive in [102u32, 110, 172] {
            assert!(WideTransit::depart(
                1,
                host(world(1)),
                2,
                4,
                origin(world(1)),
                100,
                arrive,
                0,
                1,
                1,
                1,
                [0; 32],
                0,
                0
            )
            .is_ok());
        }
        assert_eq!(
            WideTransit::depart(
                1,
                host(world(1)),
                2,
                4,
                origin(world(2)),
                100,
                110,
                0,
                1,
                1,
                1,
                [0; 32],
                0,
                0
            ),
            Err(MarchError::WorldMismatch)
        );
        let d = departed();
        assert_eq!(d.state, MarchState::Departed);
        assert!(d.state.in_transit());
        assert_eq!(d.dest, None);
        let dest = ProvinceKey::new(world(1), WideCoord::checked(130, 0).unwrap());
        let other = ProvinceKey::new(world(2), WideCoord::checked(130, 0).unwrap());
        // a departed march may only settle its departure
        assert!(matches!(
            d.step(MarchEvent::Gather { dest }, None),
            Err(MarchError::InvalidTransition {
                from: MarchState::Departed,
                event: 2
            })
        ));
        assert!(matches!(
            d.step(MarchEvent::SettleTransit, None),
            Err(MarchError::InvalidTransition {
                from: MarchState::Departed,
                event: 3
            })
        ));
        assert!(matches!(
            d.step(MarchEvent::SettleDeparture { destroyed: false }, None),
            Err(MarchError::InvalidTransition { .. })
        ));
        let s = d
            .step(
                MarchEvent::SettleDeparture { destroyed: false },
                Some((450_000, 40, 3)),
            )
            .unwrap();
        assert_eq!(s.state, MarchState::Settled);
        assert_eq!(
            (s.troops_after, s.stamina_after, s.ready_bell_off),
            (450_000, 40, 3)
        );
        let x = d
            .step(MarchEvent::SettleDeparture { destroyed: true }, None)
            .unwrap();
        assert_eq!(x.state, MarchState::DestroyedAtOrigin);
        assert_eq!((x.troops_after, x.stamina_after), (0, 0));
        // settled: gather once in the same world, or settle back
        assert!(matches!(
            s.step(
                MarchEvent::SettleDeparture { destroyed: false },
                Some((1, 1, 1))
            ),
            Err(MarchError::InvalidTransition {
                from: MarchState::Settled,
                event: 1
            })
        ));
        assert_eq!(
            s.step(MarchEvent::Gather { dest: other }, None),
            Err(MarchError::WorldMismatch)
        );
        let g = s.step(MarchEvent::Gather { dest }, None).unwrap();
        assert_eq!(g.state, MarchState::Gathered);
        assert_eq!(g.dest, Some(dest));
        assert!(matches!(
            g.step(MarchEvent::Gather { dest }, None),
            Err(MarchError::InvalidTransition {
                from: MarchState::Gathered,
                event: 2
            })
        ));
        let f = g.step(MarchEvent::SettleTransit, None).unwrap();
        assert_eq!(f.state, MarchState::Free);
        assert_eq!(f.dest, None);
        assert!(!f.state.in_transit());
        let f2 = s.step(MarchEvent::SettleTransit, None).unwrap();
        assert_eq!(f2.state, MarchState::Free);
        let f3 = x.step(MarchEvent::SettleTransit, None).unwrap();
        assert_eq!(f3.state, MarchState::Free);
        // a free record takes no event
        for ev in [
            MarchEvent::SettleDeparture { destroyed: false },
            MarchEvent::Gather { dest },
            MarchEvent::SettleTransit,
        ] {
            assert!(matches!(
                f.step(ev, Some((1, 1, 1))),
                Err(MarchError::InvalidTransition {
                    from: MarchState::Free,
                    ..
                })
            ));
        }
    }

    #[test]
    fn record_round_trips_at_every_stage_and_refuses_bad_bytes() {
        let d = departed();
        let dest = ProvinceKey::new(world(1), WideCoord::checked(1 << 40, -(1 << 41)).unwrap());
        let s = d
            .step(
                MarchEvent::SettleDeparture { destroyed: false },
                Some((450_000, 40, 3)),
            )
            .unwrap();
        let g = s.step(MarchEvent::Gather { dest }, None).unwrap();
        let f = g.step(MarchEvent::SettleTransit, None).unwrap();
        for r in [d, s, g, f] {
            let b = r.to_bytes();
            assert_eq!(b.len(), 256);
            assert_eq!(b[0], WIDE_TRANSIT_VERSION);
            assert_eq!(WideTransit::from_bytes(&b), Ok(r), "{:?}", r.state);
            assert_eq!(b[off::HAS_DEST], r.dest.is_some() as u8);
        }
        // the state bytes of the first four stages are the legacy transit's
        assert_eq!(MarchState::Free.to_byte(), T::STATE_FREE);
        assert_eq!(MarchState::Departed.to_byte(), T::STATE_DEPARTED);
        assert_eq!(MarchState::Settled.to_byte(), T::STATE_SETTLED);
        assert_eq!(
            MarchState::DestroyedAtOrigin.to_byte(),
            T::STATE_DESTROYED_AT_ORIGIN
        );
        for st in [1u8, 2, 3] {
            assert!(MarchState::from_byte(st).unwrap().in_transit());
            assert!(T::in_transit(st));
        }
        let b = g.to_bytes();
        assert_eq!(
            WideTransit::from_bytes(&b[..255]),
            Err(MarchError::Length {
                expected: 256,
                got: 255
            })
        );
        let mut x = b;
        x[off::VERSION] = 2;
        assert_eq!(
            WideTransit::from_bytes(&x),
            Err(MarchError::Version {
                expected: 1,
                got: 2
            })
        );
        let mut x = b;
        x[off::STATE] = 5;
        assert_eq!(WideTransit::from_bytes(&x), Err(MarchError::State(5)));
        for o in [off::RSV_115, off::RSV_166 + 1, off::RSV + off::RSV_LEN - 1] {
            let mut x = b;
            x[o] = 1;
            assert_eq!(WideTransit::from_bytes(&x), Err(MarchError::Reserved));
        }
        let mut x = b;
        x[off::ORIGIN_TILE] = 61;
        assert_eq!(
            WideTransit::from_bytes(&x),
            Err(MarchError::Tile(TileError::LocalIndex(61)))
        );
        // a gathered record without a destination, a settled one with one
        let mut x = b;
        x[off::HAS_DEST] = 0;
        assert_eq!(WideTransit::from_bytes(&x), Err(MarchError::Destination));
        let mut y = s.to_bytes();
        y[off::HAS_DEST] = 1;
        assert_eq!(WideTransit::from_bytes(&y), Err(MarchError::Destination));
        let mut y = s.to_bytes();
        y[off::DEST_KEY + 5] = 1;
        assert_eq!(WideTransit::from_bytes(&y), Err(MarchError::Destination));
        // a reserved world in the host ref
        let mut x = b;
        x[off::HOST + 1..off::HOST + 33].fill(0);
        assert_eq!(
            WideTransit::from_bytes(&x),
            Err(MarchError::Key(KeyError::ReservedWorld))
        );
    }
    #[test]
    fn native_review_refuses_unknown_identity_cross_world_and_clock_overflow() {
        let d = departed();
        let mut bad = d.to_bytes();
        bad[off::UNIT] = 255;
        assert_eq!(WideTransit::from_bytes(&bad), Err(MarchError::Unit(255)));
        let mut bad = d.to_bytes();
        bad[off::FACTION] = 255;
        assert_eq!(WideTransit::from_bytes(&bad), Err(MarchError::Faction(255)));
        let mut bytes = d.to_bytes();
        wr_u16(&mut bytes, off::HOST_IDENTITY, 2);
        assert_eq!(
            WideTransit::from_bytes(&bytes),
            Err(MarchError::UnknownHostIdentity(2))
        );
        let mut bytes = d.to_bytes();
        let other = origin(world(2));
        bytes[off::ORIGIN_KEY..off::ORIGIN_KEY + PROVINCE_KEY_LEN]
            .copy_from_slice(&other.key().to_bytes());
        assert_eq!(
            WideTransit::from_bytes(&bytes),
            Err(MarchError::WorldMismatch)
        );
        assert!(matches!(
            WideTransit::depart(
                1,
                d.host,
                d.unit,
                d.faction,
                d.origin,
                u32::MAX,
                u32::MAX,
                0,
                0,
                0,
                0,
                [0; 32],
                0,
                0
            ),
            Err(MarchError::ArrivalBell { .. })
        ));
    }
}
