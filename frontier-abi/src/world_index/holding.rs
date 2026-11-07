//! **Experimental, opt-in** (`--features world-index-experimental`):
//! ownership of a wide site under the **one inventory** rule, and the
//! versioned wide holding record.
//!
//! **One inventory.** A citizen owns at most three holdings, counted by
//! the three six-byte refs of its deployed Citizen account
//! (`Citizen.holding[3]`, slot `i` at `holding_of_slot(i)`), by its
//! `holdings_n`, and by the `slots` byte's ticket and capture-reservation
//! bits. Those three slots are the inventory; this module adds **no
//! fourth slot and no side inventory**. A wide holding takes one of the
//! same three slots:
//!
//! * the slot's deployed ref is set to the [`WIDE_SLOT_MARKER`], a value
//!   no legacy holding can have (`site` 12 is past `SITES_PER_PROVINCE`
//!   and `addr::host_id` refuses it; `gen` 0 is below every founded
//!   generation, which start at 1, and is not the empty marker 0xFF).
//!   Every deployed writer reads a slot as taken iff `gen ≠ 0xFF`
//!   (`lowest_free_slot`, `home_entitlement`, SettleTicket's empty-slot
//!   check), so none of them can fill the slot a second time; the deployed
//!   readers that turn a ref into a host id or a Holding address refuse
//!   the marker (`host_id` is `None`, no Holding exists at the legacy
//!   address of site 12), so none of them can act on it. The slot is
//!   therefore spent in exactly one representation at a time;
//! * the wide identity lives in the [`WideHolding`] record alone, which
//!   names the slot it occupies, and the Citizen's `holdings_n` counts it.
//!
//! **Slots 2 and 3 only.** A first home (slot 1) is placed by the deployed
//! heartland rules (`PlaceHome`, `FileTicket`), which name legacy land;
//! wide land can only ever be a second or third holding, as every province
//! past the heartland is today. So [`bind`] refuses slot 1, and slot 1's
//! flags (`FLAG_PROVISIONAL`, `FLAG_FIRST_HOLDING_FINAL`, `FLAG_HOME_GRANTED`)
//! keep their deployed meaning untouched.
//!
//! **Hosts.** The deployed `host_id` packs a 20-bit dense province index
//! that no wide province has, and no wider host identity is allocated
//! yet ([`HOST_IDENTITY_UNALLOCATED`]). A wide holding record therefore
//! carries the host identity version it was founded under, and
//! [`WideHolding::read`] refuses a record under version 0 that shows any
//! issued host (`host_seq ≠ 0`), any transit record or explore record in
//! use: no march can be debited from a wide holding before the identity
//! that could settle it exists. The record is the **whole Holding v2
//! layout** (1,280 B, every offset identical: stores, production, queue,
//! walls, reserve, transits, explore, escrow, capture fields) plus a
//! 64-byte wide trailer, so the deployed holding kernel codec
//! (`read_holding`, `write_holding`, the touch) applies unchanged.
//!
//! **Readiness.** Who may claim a wide site is the placement texture the
//! owner has not chosen, so [`WideHolding::found`] takes that rule as a
//! [`Decision`] and refuses [`HoldingError::NotReady`] while it is
//! undecided. The slot model itself is complete and tested: binding and
//! unbinding are each one deployed-field transition with the invariants
//! above.

use super::coord::{CoordError, WideCoord, SORT_KEY_LEN};
use super::key::{KeyError, WorldId};
use super::land::{self, Decision, FIRST_WIDE_RING, WIDE_LAND_FAMILY_VERSION, WIDE_LAYOUT_VERSION};
use crate::addr::{AddrCtx, Seed};
use crate::bytes::{rd_arr, rd_i16, rd_u16, rd_u32, rd_u64, rd_u8, wr_arr, wr_i16, wr_u16, wr_u8};
use crate::layout::header;
use crate::layout::player::{explore as X, holding_ref as HR, transit as T};
use crate::v2::layout::player::{citizen as C2, holding as H2};
use permutation_rules::frontier::geometry::SITES_PER_PROVINCE;
use permutation_rules::hash::sha256;

/// No wider host identity is allocated: the version every wide holding
/// is founded under today, and under which it may issue no host.
pub const HOST_IDENTITY_UNALLOCATED: u16 = 0;

/// Seed tag of a wide holding (**provisional**; not a kernel `SeedKind`).
pub const HOLDING_TAG: [u8; 2] = *b"wh";
/// Domain of the hashed raw key of a wide holding seed:
/// `sha256(HOLDING_SEED_DOMAIN ‖ sort key ‖ site)[..15]`.
pub const HOLDING_SEED_DOMAIN: &[u8] = b"PSF-WIDE-HOLDING-SEED-v1";

/// The deployed six-byte ref `{P i16, Q i16, site u8, gen u8}`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct HoldingRef {
    pub p: i16,
    pub q: i16,
    pub site: u8,
    pub gen: u8,
}

/// The ref a slot carries while a wide holding occupies it. Impossible for
/// a legacy holding on two counts (site, gen) and taken for every deployed
/// writer (`gen ≠ 0xFF`).
pub const WIDE_SLOT_MARKER: HoldingRef = HoldingRef {
    p: 0,
    q: 0,
    site: SITES_PER_PROVINCE as u8,
    gen: 0,
};

/// The deployed empty ref (`gen` 0xFF, as `clear_holding_ref` writes it).
pub const EMPTY_REF: HoldingRef = HoldingRef {
    p: 0,
    q: 0,
    site: 0,
    gen: C2::EMPTY_GEN,
};

const _: () = {
    assert!(WIDE_SLOT_MARKER.site as usize >= SITES_PER_PROVINCE);
    assert!(WIDE_SLOT_MARKER.gen != C2::EMPTY_GEN);
    assert!(WIDE_SLOT_MARKER.gen == 0);
    assert!(HR::SIZE == 6);
};

/// What a Citizen slot holds.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SlotBinding {
    Empty,
    /// A legacy holding at `ho‖P,Q,site`.
    Legacy(HoldingRef),
    /// A wide holding; its identity is the wide holding record's.
    Wide,
}

/// Why a binding or a record is refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HoldingError {
    /// A slot outside 1..=3.
    BadSlot(u8),
    /// Slot 1 is the first home, placed by the deployed heartland rules.
    FirstHomeIsLegacy,
    /// The slot is not empty (a legacy holding or another wide one).
    SlotTaken(u8),
    /// The slot is not wide-bound.
    NotWideBound(u8),
    /// An open ticket names the slot.
    TicketOnSlot(u8),
    /// A capture siege reserves the slot.
    SlotReserved(u8),
    /// `holdings_n` would leave 0..=3.
    HoldingsCount(u8),
    /// A ref with an impossible site or generation that is not the marker.
    MalformedRef(HoldingRef),
    /// Citizen bytes too short.
    Citizen,
    Length {
        expected: usize,
        got: usize,
    },
    Magic,
    Version {
        expected: u16,
        got: u16,
    },
    Reserved,
    Status(u8),
    World(KeyError),
    Coord(CoordError),
    NotWide {
        ring: u64,
    },
    LegacyIdentityInPrefix,
    /// `site ≥ 12` or `gen` 0 or 0xFF in a wide holding.
    SiteOrGen {
        site: u8,
        gen: u8,
    },
    /// An issued host, a transit or an explore record under an
    /// unallocated host identity: a debit nothing could settle.
    DebitWithoutIdentity,
    /// The claim rule is undecided (the program decides it by the deployed
    /// outpost lottery at a wide settle; a test may pass `Undecided`).
    NotReady,
}

impl From<KeyError> for HoldingError {
    fn from(e: KeyError) -> Self {
        HoldingError::World(e)
    }
}

impl From<CoordError> for HoldingError {
    fn from(e: CoordError) -> Self {
        HoldingError::Coord(e)
    }
}

// ------------------------------------------------------------ slots

/// The ref of `slot` (1..=3) of a Citizen's bytes.
pub fn ref_of(citizen: &[u8], slot: u8) -> Result<HoldingRef, HoldingError> {
    if !(1..=3).contains(&slot) {
        return Err(HoldingError::BadSlot(slot));
    }
    let o = C2::holding_of_slot(slot);
    let c = HoldingError::Citizen;
    Ok(HoldingRef {
        p: rd_i16(citizen, o + HR::P).ok_or(c)?,
        q: rd_i16(citizen, o + HR::Q).ok_or(c)?,
        site: rd_u8(citizen, o + HR::SITE).ok_or(c)?,
        gen: rd_u8(citizen, o + HR::GEN).ok_or(c)?,
    })
}

fn write_ref(citizen: &mut [u8], slot: u8, r: HoldingRef) -> Result<(), HoldingError> {
    let o = C2::holding_of_slot(slot);
    let ok = wr_i16(citizen, o + HR::P, r.p)
        & wr_i16(citizen, o + HR::Q, r.q)
        & wr_u8(citizen, o + HR::SITE, r.site)
        & wr_u8(citizen, o + HR::GEN, r.gen);
    if ok {
        Ok(())
    } else {
        Err(HoldingError::Citizen)
    }
}

/// What `slot` holds: empty (`gen` 0xFF), the wide marker, a legacy ref,
/// or a malformed ref (an impossible site or generation that is not the
/// marker) which no caller may act on.
pub fn binding_of(citizen: &[u8], slot: u8) -> Result<SlotBinding, HoldingError> {
    let r = ref_of(citizen, slot)?;
    if r.gen == C2::EMPTY_GEN {
        return Ok(SlotBinding::Empty);
    }
    if r == WIDE_SLOT_MARKER {
        return Ok(SlotBinding::Wide);
    }
    if r.site as usize >= SITES_PER_PROVINCE || r.gen == 0 {
        return Err(HoldingError::MalformedRef(r));
    }
    Ok(SlotBinding::Legacy(r))
}

/// The three bindings.
pub fn bindings_of(citizen: &[u8]) -> Result<[SlotBinding; 3], HoldingError> {
    Ok([
        binding_of(citizen, 1)?,
        binding_of(citizen, 2)?,
        binding_of(citizen, 3)?,
    ])
}

/// Binds `slot` (2 or 3) of the Citizen to a wide holding: the slot empty,
/// no open ticket on it, no capture reservation of it, `holdings_n < 3`.
/// Writes the marker and `holdings_n + 1`, nothing else. The caller
/// creates the wide holding record in the same instruction.
pub fn bind(citizen: &mut [u8], slot: u8) -> Result<(), HoldingError> {
    if !(1..=3).contains(&slot) {
        return Err(HoldingError::BadSlot(slot));
    }
    if slot == 1 {
        return Err(HoldingError::FirstHomeIsLegacy);
    }
    match binding_of(citizen, slot)? {
        SlotBinding::Empty => {}
        _ => return Err(HoldingError::SlotTaken(slot)),
    }
    let c = HoldingError::Citizen;
    let slots = rd_u8(citizen, C2::SLOTS).ok_or(c)?;
    if slots & C2::SLOTS_TICKET_MASK == slot {
        return Err(HoldingError::TicketOnSlot(slot));
    }
    if slots & C2::reserved_bit(slot) != 0 {
        return Err(HoldingError::SlotReserved(slot));
    }
    let n = rd_u8(citizen, C2::HOLDINGS_N).ok_or(c)?;
    let actual = bindings_of(citizen)?
        .iter()
        .filter(|b| !matches!(b, SlotBinding::Empty))
        .count();
    if n as usize != actual {
        return Err(HoldingError::HoldingsCount(n));
    }
    if n as usize >= C2::MAX_HOLDINGS {
        return Err(HoldingError::HoldingsCount(n));
    }
    write_ref(citizen, slot, WIDE_SLOT_MARKER)?;
    if wr_u8(citizen, C2::HOLDINGS_N, n + 1) {
        Ok(())
    } else {
        Err(c)
    }
}

/// Unbinds a wide-bound `slot`: the marker becomes the empty ref and
/// `holdings_n − 1`. The caller closes the wide holding record in the same
/// instruction.
pub fn unbind(citizen: &mut [u8], slot: u8) -> Result<(), HoldingError> {
    if slot == 1 {
        return Err(HoldingError::FirstHomeIsLegacy);
    }
    match binding_of(citizen, slot)? {
        SlotBinding::Wide => {}
        _ => return Err(HoldingError::NotWideBound(slot)),
    }
    let c = HoldingError::Citizen;
    let n = rd_u8(citizen, C2::HOLDINGS_N).ok_or(c)?;
    let actual = bindings_of(citizen)?
        .iter()
        .filter(|b| !matches!(b, SlotBinding::Empty))
        .count();
    if n as usize != actual {
        return Err(HoldingError::HoldingsCount(n));
    }
    if n == 0 || n as usize > C2::MAX_HOLDINGS {
        return Err(HoldingError::HoldingsCount(n));
    }
    write_ref(citizen, slot, EMPTY_REF)?;
    if wr_u8(citizen, C2::HOLDINGS_N, n - 1) {
        Ok(())
    } else {
        Err(c)
    }
}

// ------------------------------------------------------------ record

/// The wide holding's trailer (64 B at 1,280, after the whole Holding v2
/// layout). **Provisional magic.**
pub mod wide_holding {
    pub const TRAILER: usize = crate::v2::layout::player::holding::SIZE;
    pub const SIZE: usize = TRAILER + 64;
    pub const MAGIC: [u8; 8] = *b"PSFXWHL1";
    pub const STATUS_FOUNDED: u8 = 1;

    pub const FAMILY_VERSION: usize = TRAILER;
    pub const STATUS: usize = TRAILER + 2;
    pub const SLOT: usize = TRAILER + 3;
    pub const HOST_IDENTITY: usize = TRAILER + 4;
    pub const RSV_6: usize = TRAILER + 6;
    pub const WORLD: usize = TRAILER + 8;
    pub const SORT_KEY: usize = TRAILER + 40;
    pub const RSV: usize = TRAILER + 57;
    pub const RSV_LEN: usize = 7;

    const _: () = {
        assert!(TRAILER == 1_280);
        assert!(SIZE == 1_344);
        assert!(RSV_6 + 2 == WORLD);
        assert!(WORLD + 32 == SORT_KEY);
        assert!(SORT_KEY + 17 == RSV);
        assert!(RSV + RSV_LEN == SIZE);
    };
}

/// `wh ‖ hex(sha256(HOLDING_SEED_DOMAIN ‖ sort key ‖ site)[..15])`.
pub fn holding_seed(coord: WideCoord, site: u8) -> Seed {
    let h = sha256(&[HOLDING_SEED_DOMAIN, &coord.sort_key(), &[site]]);
    Seed::new(HOLDING_TAG, &h[..15])
}

/// `with_seed(season, wh‖hash(coord, site), program)`.
pub fn holding_address(ctx: &AddrCtx, coord: WideCoord, site: u8) -> [u8; 32] {
    ctx.of(&holding_seed(coord, site))
}

/// A wide holding's identity, decoded from its trailer and the identity
/// fields of its prefix. The holding's economy (stores, queue, reserve,
/// transits) is read and written by the program through the Holding v2
/// offsets, exactly as for a legacy holding.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct WideHolding {
    pub season_id: u64,
    pub world: WorldId,
    pub coord: WideCoord,
    pub site: u8,
    pub gen: u8,
    /// The Citizen slot it occupies (2 or 3).
    pub slot: u8,
    pub owner_citizen: [u8; 32],
    /// The host identity version it was founded under.
    pub host_identity: u16,
}

impl WideHolding {
    /// The founding of `site` of `coord` for `owner` in `slot`, under the
    /// claim rule: refused [`HoldingError::NotReady`] while the rule is
    /// undecided (the program passes `Decided` only from the wide settle,
    /// after the deployed outpost lottery); otherwise generation
    /// `gen` (the site mirror's next generation, the deployed rule) under
    /// the unallocated host identity.
    #[allow(clippy::too_many_arguments)]
    pub fn found(
        world: WorldId,
        season_id: u64,
        coord: WideCoord,
        site: u8,
        gen: u8,
        slot: u8,
        owner_citizen: [u8; 32],
        claim_rule: &Decision<()>,
    ) -> Result<WideHolding, HoldingError> {
        let ring = coord.ring();
        if ring < FIRST_WIDE_RING {
            return Err(HoldingError::NotWide { ring });
        }
        if !(2..=3).contains(&slot) {
            return Err(if slot == 1 {
                HoldingError::FirstHomeIsLegacy
            } else {
                HoldingError::BadSlot(slot)
            });
        }
        if site as usize >= SITES_PER_PROVINCE || gen == 0 || gen == C2::EMPTY_GEN {
            return Err(HoldingError::SiteOrGen { site, gen });
        }
        if !claim_rule.is_decided() {
            return Err(HoldingError::NotReady);
        }
        Ok(WideHolding {
            season_id,
            world,
            coord,
            site,
            gen,
            slot,
            owner_citizen,
            host_identity: HOST_IDENTITY_UNALLOCATED,
        })
    }

    /// Decodes the identity of exactly `wide_holding::SIZE` bytes, and
    /// refuses a record that shows a debit no identity could settle: under
    /// [`HOST_IDENTITY_UNALLOCATED`], `host_seq` must be 0, every transit
    /// record free and the explore record free.
    pub fn read(d: &[u8]) -> Result<WideHolding, HoldingError> {
        use wide_holding as L;
        if d.len() != L::SIZE {
            return Err(HoldingError::Length {
                expected: L::SIZE,
                got: d.len(),
            });
        }
        let t = HoldingError::Length {
            expected: L::SIZE,
            got: 0,
        };
        if rd_arr::<8>(d, header::MAGIC).ok_or(t)? != L::MAGIC {
            return Err(HoldingError::Magic);
        }
        let lv = rd_u16(d, header::LAYOUT_VERSION).ok_or(t)?;
        if lv != WIDE_LAYOUT_VERSION {
            return Err(HoldingError::Version {
                expected: WIDE_LAYOUT_VERSION,
                got: lv,
            });
        }
        let fv = rd_u16(d, L::FAMILY_VERSION).ok_or(t)?;
        if fv != WIDE_LAND_FAMILY_VERSION {
            return Err(HoldingError::Version {
                expected: WIDE_LAND_FAMILY_VERSION,
                got: fv,
            });
        }
        let sb = rd_u8(d, L::STATUS).ok_or(t)?;
        if sb != L::STATUS_FOUNDED {
            return Err(HoldingError::Status(sb));
        }
        land::zero(d, L::RSV_6, 2).map_err(|_| HoldingError::Reserved)?;
        land::zero(d, L::RSV, L::RSV_LEN).map_err(|_| HoldingError::Reserved)?;
        if rd_i16(d, H2::P).ok_or(t)? != 0 || rd_i16(d, H2::Q).ok_or(t)? != 0 {
            return Err(HoldingError::LegacyIdentityInPrefix);
        }
        let key: [u8; SORT_KEY_LEN] = rd_arr(d, L::SORT_KEY).ok_or(t)?;
        let coord = WideCoord::from_sort_key(&key)?;
        let ring = coord.ring();
        if ring < FIRST_WIDE_RING {
            return Err(HoldingError::NotWide { ring });
        }
        let site = rd_u8(d, H2::SITE).ok_or(t)?;
        let gen = rd_u8(d, H2::GEN).ok_or(t)?;
        if site as usize >= SITES_PER_PROVINCE || gen == 0 || gen == C2::EMPTY_GEN {
            return Err(HoldingError::SiteOrGen { site, gen });
        }
        let slot = rd_u8(d, L::SLOT).ok_or(t)?;
        if !(2..=3).contains(&slot) {
            return Err(if slot == 1 {
                HoldingError::FirstHomeIsLegacy
            } else {
                HoldingError::BadSlot(slot)
            });
        }
        let host_identity = rd_u16(d, L::HOST_IDENTITY).ok_or(t)?;
        if host_identity != HOST_IDENTITY_UNALLOCATED {
            return Err(HoldingError::Version {
                expected: HOST_IDENTITY_UNALLOCATED,
                got: host_identity,
            });
        }
        {
            let seq = rd_u32(d, H2::HOST_SEQ).ok_or(t)?;
            let any_transit = (0..H2::TRANSIT_N)
                .any(|i| rd_u8(d, H2::transit(i) + T::STATE).unwrap_or(1) != T::STATE_FREE);
            let explore = rd_u8(d, H2::EXPLORE + X::STATE).ok_or(t)?;
            if seq != 0 || any_transit || explore != X::STATE_FREE {
                return Err(HoldingError::DebitWithoutIdentity);
            }
        }
        Ok(WideHolding {
            season_id: rd_u64(d, header::SEASON_ID).ok_or(t)?,
            world: WorldId::new(rd_arr(d, L::WORLD).ok_or(t)?)?,
            coord,
            site,
            gen,
            slot,
            owner_citizen: rd_arr(d, H2::OWNER_CITIZEN).ok_or(t)?,
            host_identity,
        })
    }

    /// Writes the identity: the chained header (wide magic, season,
    /// `layout_version` 3, a fresh chain), the prefix identity fields
    /// (`P`, `Q` zero, `SITE`, `GEN`, `OWNER_CITIZEN`) and the trailer.
    /// Every other prefix byte is the program's, written through the
    /// Holding v2 offsets by the same code that founds a legacy holding.
    pub fn write_identity(&self, d: &mut [u8]) -> Result<(), HoldingError> {
        use wide_holding as L;
        if d.len() != L::SIZE {
            return Err(HoldingError::Length {
                expected: L::SIZE,
                got: d.len(),
            });
        }
        let ok = wr_arr(d, header::MAGIC, &L::MAGIC)
            & crate::bytes::wr_u64(d, header::SEASON_ID, self.season_id)
            & wr_u16(d, header::LAYOUT_VERSION, WIDE_LAYOUT_VERSION)
            & wr_arr(d, header::LAYOUT_VERSION + 2, &[0u8; 6])
            & crate::bytes::wr_u64(d, header::EVENT_SEQ, 0)
            & wr_arr(d, header::EVENT_HEAD, &[0u8; 32])
            & wr_i16(d, H2::P, 0)
            & wr_i16(d, H2::Q, 0)
            & wr_u8(d, H2::SITE, self.site)
            & wr_u8(d, H2::GEN, self.gen)
            & wr_arr(d, H2::OWNER_CITIZEN, &self.owner_citizen)
            & wr_u16(d, L::FAMILY_VERSION, WIDE_LAND_FAMILY_VERSION)
            & wr_u8(d, L::STATUS, L::STATUS_FOUNDED)
            & wr_u8(d, L::SLOT, self.slot)
            & wr_u16(d, L::HOST_IDENTITY, self.host_identity)
            & wr_arr(d, L::RSV_6, &[0u8; 2])
            & wr_arr(d, L::WORLD, self.world.as_bytes())
            & wr_arr(d, L::SORT_KEY, &self.coord.sort_key())
            & wr_arr(d, L::RSV, &[0u8; L::RSV_LEN]);
        if ok {
            Ok(())
        } else {
            Err(HoldingError::Length {
                expected: L::SIZE,
                got: 0,
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::layout::player::citizen as C;
    use permutation_rules::frontier::geometry::ring_provinces;

    fn world() -> WorldId {
        WorldId::new([0x77; 32]).unwrap()
    }

    fn c(p: i64, q: i64) -> WideCoord {
        WideCoord::checked(p, q).unwrap()
    }

    /// A joined Citizen with three empty slots, as Join leaves it.
    fn citizen() -> std::vec::Vec<u8> {
        let mut d = std::vec![0u8; C2::SIZE];
        for slot in 1..=3u8 {
            d[C2::holding_of_slot(slot) + HR::GEN] = C2::EMPTY_GEN;
        }
        d
    }

    fn set_ref(d: &mut [u8], slot: u8, r: HoldingRef) {
        write_ref(d, slot, r).unwrap();
    }

    /// The marker is impossible for a legacy holding, taken for every
    /// deployed slot rule, and refused by the deployed host-id codec.
    #[test]
    fn the_marker_is_impossible_taken_and_unusable_for_legacy_code() {
        assert_eq!(SITES_PER_PROVINCE, 12);
        assert_eq!(WIDE_SLOT_MARKER.site, 12);
        assert_eq!(WIDE_SLOT_MARKER.gen, 0);
        assert_ne!(WIDE_SLOT_MARKER, EMPTY_REF);
        // taken: the deployed free-slot rule skips it
        assert_eq!(
            C2::lowest_free_slot(0, WIDE_SLOT_MARKER.gen, C2::EMPTY_GEN),
            Some(3)
        );
        assert_eq!(
            C2::lowest_free_slot(0, C2::EMPTY_GEN, WIDE_SLOT_MARKER.gen),
            Some(2)
        );
        assert_eq!(
            C2::lowest_free_slot(0, WIDE_SLOT_MARKER.gen, WIDE_SLOT_MARKER.gen),
            None
        );
        // unusable: no host id, hence no Holding the deployed readers can name
        assert_eq!(
            crate::addr::host_id(
                WIDE_SLOT_MARKER.p as i32,
                WIDE_SLOT_MARKER.q as i32,
                WIDE_SLOT_MARKER.site,
                WIDE_SLOT_MARKER.gen,
                0
            ),
            None
        );
        // no legacy holding can equal it: every legacy site is below 12 and
        // every founded generation is at least 1
        for d in 0..=3u32 {
            for p in ring_provinces(d) {
                for site in 0..SITES_PER_PROVINCE as u8 {
                    for gen in 1..=254u8 {
                        let r = HoldingRef {
                            p: p.p as i16,
                            q: p.q as i16,
                            site,
                            gen,
                        };
                        assert_ne!(r, WIDE_SLOT_MARKER);
                    }
                }
            }
        }
        assert_eq!(HOST_IDENTITY_UNALLOCATED, 0);
    }

    /// Bind takes an empty slot 2 or 3 and nothing else; the deployed
    /// writers then see the slot as taken; unbind gives it back; slot 1,
    /// a taken slot, a ticketed slot, a reserved slot and a full count are
    /// refused, and a refusal writes nothing.
    #[test]
    fn bind_and_unbind_keep_one_inventory() {
        let mut d = citizen();
        assert_eq!(
            bindings_of(&d),
            Ok([SlotBinding::Empty, SlotBinding::Empty, SlotBinding::Empty])
        );
        assert_eq!(bind(&mut d, 1), Err(HoldingError::FirstHomeIsLegacy));
        assert_eq!(bind(&mut d, 0), Err(HoldingError::BadSlot(0)));
        assert_eq!(bind(&mut d, 4), Err(HoldingError::BadSlot(4)));
        assert_eq!(d, citizen(), "a refusal writes nothing");
        bind(&mut d, 2).unwrap();
        assert_eq!(binding_of(&d, 2), Ok(SlotBinding::Wide));
        assert_eq!(ref_of(&d, 2), Ok(WIDE_SLOT_MARKER));
        assert_eq!(d[C::HOLDINGS_N], 1);
        // the deployed rules now see slot 2 as taken, slot 3 as free
        let g2 = d[C2::holding_of_slot(2) + HR::GEN];
        let g3 = d[C2::holding_of_slot(3) + HR::GEN];
        assert_eq!(C2::lowest_free_slot(d[C2::SLOTS], g2, g3), Some(3));
        assert_ne!(g2, C2::EMPTY_GEN, "SettleTicket's empty-slot check refuses");
        assert_eq!(bind(&mut d, 2), Err(HoldingError::SlotTaken(2)));
        // a legacy outpost in slot 3 beside the wide one: both counted
        set_ref(
            &mut d,
            3,
            HoldingRef {
                p: 4,
                q: -1,
                site: 7,
                gen: 2,
            },
        );
        d[C::HOLDINGS_N] = 2;
        assert_eq!(
            bindings_of(&d),
            Ok([
                SlotBinding::Empty,
                SlotBinding::Wide,
                SlotBinding::Legacy(HoldingRef {
                    p: 4,
                    q: -1,
                    site: 7,
                    gen: 2
                })
            ])
        );
        assert_eq!(bind(&mut d, 3), Err(HoldingError::SlotTaken(3)));
        assert_eq!(unbind(&mut d, 3), Err(HoldingError::NotWideBound(3)));
        assert_eq!(unbind(&mut d, 1), Err(HoldingError::FirstHomeIsLegacy));
        unbind(&mut d, 2).unwrap();
        assert_eq!(binding_of(&d, 2), Ok(SlotBinding::Empty));
        assert_eq!(ref_of(&d, 2), Ok(EMPTY_REF));
        assert_eq!(d[C::HOLDINGS_N], 1);
        assert_eq!(unbind(&mut d, 2), Err(HoldingError::NotWideBound(2)));
        // a ticket on the slot, a capture reservation, a full count
        let mut t = citizen();
        t[C2::SLOTS] = 2;
        assert_eq!(bind(&mut t, 2), Err(HoldingError::TicketOnSlot(2)));
        bind(&mut t, 3).unwrap();
        let mut r = citizen();
        r[C2::SLOTS] = C2::SLOTS_RESERVED_3;
        assert_eq!(bind(&mut r, 3), Err(HoldingError::SlotReserved(3)));
        bind(&mut r, 2).unwrap();
        let mut f = citizen();
        f[C::HOLDINGS_N] = 3;
        assert_eq!(bind(&mut f, 2), Err(HoldingError::HoldingsCount(3)));
        let mut z = citizen();
        set_ref(&mut z, 2, WIDE_SLOT_MARKER);
        assert_eq!(unbind(&mut z, 2), Err(HoldingError::HoldingsCount(0)));
        // a malformed ref is neither empty nor wide nor legacy
        let mut m = citizen();
        set_ref(
            &mut m,
            2,
            HoldingRef {
                p: 1,
                q: 0,
                site: 12,
                gen: 3,
            },
        );
        assert!(matches!(
            binding_of(&m, 2),
            Err(HoldingError::MalformedRef(_))
        ));
        assert!(matches!(
            bind(&mut m, 2),
            Err(HoldingError::MalformedRef(_))
        ));
        let mut m = citizen();
        set_ref(
            &mut m,
            3,
            HoldingRef {
                p: 1,
                q: 0,
                site: 3,
                gen: 0,
            },
        );
        assert!(matches!(
            binding_of(&m, 3),
            Err(HoldingError::MalformedRef(_))
        ));
        assert!(matches!(ref_of(&[0u8; 10], 2), Err(HoldingError::Citizen)));
    }

    /// Founding is not ready while the claim rule is undecided; the
    /// identity refusals come first.
    #[test]
    fn founding_is_not_ready_until_the_claim_rule_is_decided() {
        let owner = [0xc1; 32];
        assert_eq!(
            WideHolding::found(world(), 11, c(129, 0), 3, 1, 2, owner, &Decision::Undecided),
            Err(HoldingError::NotReady)
        );
        assert_eq!(
            WideHolding::found(world(), 11, c(128, 0), 3, 1, 2, owner, &Decision::Undecided),
            Err(HoldingError::NotWide { ring: 128 })
        );
        assert_eq!(
            WideHolding::found(
                world(),
                11,
                c(129, 0),
                3,
                1,
                1,
                owner,
                &Decision::Decided(())
            ),
            Err(HoldingError::FirstHomeIsLegacy)
        );
        assert_eq!(
            WideHolding::found(
                world(),
                11,
                c(129, 0),
                3,
                1,
                4,
                owner,
                &Decision::Decided(())
            ),
            Err(HoldingError::BadSlot(4))
        );
        assert_eq!(
            WideHolding::found(
                world(),
                11,
                c(129, 0),
                12,
                1,
                2,
                owner,
                &Decision::Decided(())
            ),
            Err(HoldingError::SiteOrGen { site: 12, gen: 1 })
        );
        for gen in [0u8, 0xFF] {
            assert_eq!(
                WideHolding::found(
                    world(),
                    11,
                    c(129, 0),
                    3,
                    gen,
                    2,
                    owner,
                    &Decision::Decided(())
                ),
                Err(HoldingError::SiteOrGen { site: 3, gen })
            );
        }
        let h = WideHolding::found(
            world(),
            11,
            c(129, 0),
            3,
            1,
            2,
            owner,
            &Decision::Decided(()),
        )
        .unwrap();
        assert_eq!(h.host_identity, HOST_IDENTITY_UNALLOCATED);
        assert_eq!((h.site, h.gen, h.slot), (3, 1, 2));
    }

    /// The record (a model exercise under a decided claim rule) round-trips
    /// over the untouched Holding v2 prefix, refuses every malformed form,
    /// and refuses any debit under the unallocated host identity.
    #[test]
    fn holding_record_round_trips_and_refuses_debits_without_an_identity() {
        let owner = [0xc1; 32];
        let h = WideHolding::found(
            world(),
            11,
            c(-129, 129),
            5,
            2,
            3,
            owner,
            &Decision::Decided(()),
        )
        .unwrap();
        let mut d = std::vec![0u8; wide_holding::SIZE];
        for (i, b) in d[H2::TICKET_SCORE..H2::TRANSIT].iter_mut().enumerate() {
            *b = (i % 253) as u8;
        }
        // HOST_SEQ is inside this range, but is not an economy byte.
        crate::bytes::wr_u32(&mut d, H2::HOST_SEQ, 0);
        let state: std::vec::Vec<u8> = d[H2::TICKET_SCORE..H2::TRANSIT].to_vec();
        h.write_identity(&mut d).unwrap();
        assert_eq!(
            &d[H2::TICKET_SCORE..H2::TRANSIT],
            &state[..],
            "the economy is untouched"
        );
        assert_eq!(&d[..8], &wide_holding::MAGIC);
        assert_eq!(rd_u16(&d, header::LAYOUT_VERSION), Some(3));
        assert_eq!(rd_i16(&d, H2::P), Some(0));
        assert_eq!(rd_i16(&d, H2::Q), Some(0));
        assert_eq!(d[H2::SITE], 5);
        assert_eq!(d[H2::GEN], 2);
        assert_eq!(WideHolding::read(&d), Ok(h));
        assert_ne!(d.len(), H2::SIZE);
        assert_ne!(&d[..8], &H2::MAGIC);
        // addresses: distinct per site, never the legacy holding's
        let ctx = AddrCtx {
            season: [3; 32],
            program: [4; 32],
        };
        assert_ne!(
            holding_address(&ctx, c(-129, 129), 5),
            holding_address(&ctx, c(-129, 129), 6)
        );
        assert_ne!(
            holding_address(&ctx, c(-129, 129), 5),
            ctx.holding(-129, 129, 5)
        );
        assert_eq!(holding_seed(c(129, 0), 0).len(), 32);
        assert_eq!(&holding_seed(c(129, 0), 0).as_bytes()[..2], &HOLDING_TAG);
        assert_eq!(
            permutation_rules::frontier::addr::SeedKind::from_tag(&HOLDING_TAG),
            None
        );
        // refusals
        assert_eq!(
            WideHolding::read(&d[..H2::SIZE]),
            Err(HoldingError::Length {
                expected: wide_holding::SIZE,
                got: H2::SIZE
            })
        );
        let mut x = d.clone();
        x[0] ^= 1;
        assert_eq!(WideHolding::read(&x), Err(HoldingError::Magic));
        let mut x = d.clone();
        x[header::LAYOUT_VERSION] = 2;
        assert_eq!(
            WideHolding::read(&x),
            Err(HoldingError::Version {
                expected: 3,
                got: 2
            })
        );
        let mut x = d.clone();
        x[wide_holding::STATUS] = 0;
        assert_eq!(WideHolding::read(&x), Err(HoldingError::Status(0)));
        let mut x = d.clone();
        x[wide_holding::RSV] = 1;
        assert_eq!(WideHolding::read(&x), Err(HoldingError::Reserved));
        let mut x = d.clone();
        x[H2::P] = 1;
        assert_eq!(
            WideHolding::read(&x),
            Err(HoldingError::LegacyIdentityInPrefix)
        );
        let mut x = d.clone();
        x[wide_holding::SLOT] = 1;
        assert_eq!(WideHolding::read(&x), Err(HoldingError::FirstHomeIsLegacy));
        let mut x = d.clone();
        x[H2::SITE] = 12;
        assert_eq!(
            WideHolding::read(&x),
            Err(HoldingError::SiteOrGen { site: 12, gen: 2 })
        );
        let mut x = d.clone();
        x[H2::GEN] = 0;
        assert_eq!(
            WideHolding::read(&x),
            Err(HoldingError::SiteOrGen { site: 5, gen: 0 })
        );
        let mut x = d.clone();
        x[wide_holding::SORT_KEY..wide_holding::SORT_KEY + SORT_KEY_LEN]
            .copy_from_slice(&c(100, 0).sort_key());
        assert_eq!(
            WideHolding::read(&x),
            Err(HoldingError::NotWide { ring: 100 })
        );
        // no debit under the unallocated identity: an issued host, a transit
        // in any in-transit state, an explore in progress
        let mut x = d.clone();
        x[H2::HOST_SEQ] = 1;
        assert_eq!(
            WideHolding::read(&x),
            Err(HoldingError::DebitWithoutIdentity)
        );
        for st in [
            T::STATE_DEPARTED,
            T::STATE_SETTLED,
            T::STATE_DESTROYED_AT_ORIGIN,
        ] {
            for i in 0..H2::TRANSIT_N {
                let mut x = d.clone();
                x[H2::transit(i) + T::STATE] = st;
                assert_eq!(
                    WideHolding::read(&x),
                    Err(HoldingError::DebitWithoutIdentity)
                );
            }
        }
        let mut x = d.clone();
        x[H2::EXPLORE + X::STATE] = X::STATE_PENDING;
        assert_eq!(
            WideHolding::read(&x),
            Err(HoldingError::DebitWithoutIdentity)
        );
        // Unknown identity versions cannot bypass the no-debit gate.
        let mut x = d.clone();
        x[wide_holding::HOST_IDENTITY] = 1;
        x[H2::HOST_SEQ] = 1;
        assert_eq!(
            WideHolding::read(&x),
            Err(HoldingError::Version {
                expected: 0,
                got: 1
            })
        );
    }
    #[test]
    fn native_review_refuses_corrupt_slot_unbinding_without_mutation() {
        let mut d = citizen();
        set_ref(&mut d, 1, WIDE_SLOT_MARKER);
        wr_u8(&mut d, C2::HOLDINGS_N, 1);
        let before = d.clone();
        assert_eq!(unbind(&mut d, 1), Err(HoldingError::FirstHomeIsLegacy));
        assert_eq!(d, before);
        let mut d = citizen();
        bind(&mut d, 2).unwrap();
        wr_u8(&mut d, C2::HOLDINGS_N, 4);
        let before = d.clone();
        assert_eq!(unbind(&mut d, 2), Err(HoldingError::HoldingsCount(4)));
        assert_eq!(d, before);
    }
    #[test]
    fn native_review_refuses_inventory_count_mismatch() {
        let mut d = citizen();
        bind(&mut d, 2).unwrap();
        wr_u8(&mut d, C2::HOLDINGS_N, 0);
        let before = d.clone();
        assert_eq!(bind(&mut d, 3), Err(HoldingError::HoldingsCount(0)));
        assert_eq!(unbind(&mut d, 2), Err(HoldingError::HoldingsCount(0)));
        assert_eq!(d, before);
    }
}
