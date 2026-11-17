//! **Experimental, opt-in** (`--features world-index-experimental`): the
//! **wide outpost ticket**: the record that carries a wide claim through
//! the deployed outpost lifecycle (FileOutpost → the beacon draw of
//! SettleTicket → a provisional holding → its finality), and the marker
//! that reserves the Citizen's one ticket while it is pending.
//!
//! **Why a record.** The deployed ticket lives inside the Citizen: three
//! `(i16 P, i16 Q, u8 site)` entries, a bell, a cursor, an escrow and a
//! funder. A wide coordinate does not fit an `i16` and must never be
//! narrowed into one, so the wide ticket's identity (world, exact
//! coordinate, site, slot, bell) lives in a [`WideTicket`] record at
//! `with_seed(season, wt ‖ hash(citizen), program)`: one per Citizen, as
//! the Citizen has one ticket.
//!
//! **The marker.** While a wide ticket is pending the Citizen's deployed
//! ticket fields hold [`mark`]: `TICKET_BELL` = the filing bell (so every
//! deployed path that asks "is a ticket open?" sees one and refuses:
//! FileTicket, FileOutpost, PlaceHome's entitlement), `TICKET_SITES` all
//! zero (no deployed ticket has zero sites: an all-zero entry is the
//! Concord's site 0, which no ticket may name, so the deployed
//! SettleTicket parses zero sites and refuses `TicketState` before its
//! expiry branch; the experimental program additionally refuses the marker
//! **explicitly** in SettleTicket, CloseCitizen and DeclareSiege before
//! any parsing), `TICKET_NEXT` 0, and the `slots` ticket bits naming the
//! slot (so the deployed lowest-free-slot rule and FileTicket's outpost
//! guard see it). The capture reservation bits are untouched, and a slot
//! that is reserved or occupied cannot be marked. Nothing else of the
//! Citizen is used: the NFT resident fields (348..380) and the escrow are
//! not touched.
//!
//! **Isolated escrow, the deployed retention.** The deployed escrow
//! (`TICKET_ESCROW`) is shared by the ticket and the capture reservations
//! and is sized in the deployed Holding's rent (1,280 B); a wide holding is
//! 1,344 B. So the wide ticket's rent is **not** in that escrow: the record
//! itself holds the wide Holding's rent above its own (`ESCROW`, the
//! record's `TICKET_ESCROW`), with two recipients kept apart exactly as the
//! deployed Citizen keeps them: `RENT_PAYER`, **immutable**, who paid the
//! record's own rent when it was created (the Citizen's `RENT_PAYER`), and
//! `FUNDER`, who last topped the escrow up (the Citizen's `TICKET_FUNDER`).
//! The record follows the deployed escrow's life exactly: the filing tops
//! the escrow up to one wide rent and the payer becomes the funder **only
//! when it tops up** (FileOutpost's rule, [`WideTicket::refile`]); a win
//! moves exactly one wide rent out of it (into the holding, or to a
//! displaced holding's funder); an expired or taken ticket **keeps** it;
//! the record then stays, [`TicketStatus::Settled`], holding the retained
//! rent for the next filing. Only at season end (WideClose(0), the shape
//! of CloseCitizen's refund) is it closed: the **escrow to the funder**
//! (listed exactly when the escrow is non-zero), then the **whole rest to
//! the rent payer** (the record's rent and any excess lamports, as the
//! Citizen's remainder goes to its rent payer), whether or not the Citizen
//! has already closed, with no redirect of either recipient by a Citizen
//! close, an NFT transfer or a later payer. Nothing is refunded while the
//! Season runs. DeclareSiege therefore never counts it, SettleSiege never
//! refunds it, SettleCapture never consumes it; and while a wide ticket is
//! pending the experimental program refuses a new capture reservation, so
//! the two escrow regimes never share a Citizen.
//!
//! **Codec identity.** The record is `PSFXWTK2`, 192 bytes. The first
//! draft's `PSFXWTK1` (160 bytes, a single mutable funder, eight reserved
//! bytes where the escrow now is, refunded whole at every settle) was never
//! committed or deployed and is refused by magic and by length: no reserved
//! byte of an old record is ever read as an escrow.
//!
//! **Score.** The deployed ticket score hashes `LE32(P) ‖ LE32(Q) ‖ site ‖
//! LE64(tag)` under the domain `site`. The wide score, [`wide_ticket_score`],
//! hashes the 17-byte canonical sort key instead, under its own domain
//! `site/wide-v1`: the same beacon seed, the same tag, a full-width
//! coordinate; a versioned formula, never a truncation.

use super::coord::{CoordError, WideCoord, SORT_KEY_LEN};
use super::holding::{binding_of, SlotBinding};
use super::key::{KeyError, WorldId};
use super::land::{self, FIRST_WIDE_RING, WIDE_LAND_FAMILY_VERSION};
use crate::addr::{AddrCtx, Seed};
use crate::bytes::{rd_arr, rd_u16, rd_u32, rd_u64, rd_u8, wr_arr, wr_u16, wr_u32, wr_u64, wr_u8};
use crate::layout::player::{citizen as C, ticket_site as TS};
use crate::v2::layout::player::citizen as C2;
use permutation_rules::frontier::geometry::SITES_PER_PROVINCE;
use permutation_rules::hash::sha256;
use permutation_rules::rng::rand;

/// Seed tag of a wide ticket (**provisional**; not a kernel `SeedKind`).
pub const TICKET_TAG: [u8; 2] = *b"wt";
/// Domain of the hashed raw key: `sha256(TICKET_SEED_DOMAIN ‖ citizen)[..15]`.
pub const TICKET_SEED_DOMAIN: &[u8] = b"PSF-WIDE-TICKET-SEED-v1";
/// `rng::rand` domain of [`wide_ticket_score`]. Distinct from the deployed
/// `site`.
pub const TICKET_SCORE_DOMAIN: &[u8] = b"site/wide-v1";
/// Bytes of the Citizen's three ticket-site entries.
pub const TICKET_SITES_LEN: usize = C::MAX_TICKET_SITES * TS::SIZE;

/// The wide ticket record (192 B, short header). **Provisional magic**,
/// the second of the draft (module doc, "codec identity").
pub mod wide_ticket {
    crate::layout::fields!(size = 192;
        HDR_MAGIC @ 0 : "[u8;8]" = 8;
        SEASON_ID @ 8 : "u64" = 8;
        FAMILY_VERSION @ 16 : "u16" = 2;
        STATUS @ 18 : "u8" = 1;
        SLOT @ 19 : "u8" = 1;
        SITE @ 20 : "u8" = 1;
        NEXT @ 21 : "u8" = 1;
        RSV_22 @ 22 : "rsv" = 2;
        BELL @ 24 : "u32" = 4;
        RSV_28 @ 28 : "rsv" = 4;
        WORLD @ 32 : "[u8;32]" = 32;
        SORT_KEY @ 64 : "[u8;17]" = 17;
        RSV_81 @ 81 : "rsv" = 7;
        CITIZEN @ 88 : "[u8;32]" = 32;
        FUNDER @ 120 : "[u8;32]" = 32;
        RENT_PAYER @ 152 : "[u8;32]" = 32;
        ESCROW @ 184 : "u64" = 8;
    );
    pub const MAGIC: [u8; 8] = *b"PSFXWTK2";
    /// The first draft's magic (160 B, no rent payer, no escrow field):
    /// refused, never written by any committed build.
    pub const MAGIC_V1_REFUSED: [u8; 8] = *b"PSFXWTK1";
    /// A ticket is pending: the Citizen carries the marker.
    pub const STATUS_OPEN: u8 = 1;
    /// The ticket ended (won, taken or expired): no marker; the record
    /// keeps the escrow it retained for the next filing or the season-end
    /// close.
    pub const STATUS_SETTLED: u8 = 2;
}

/// Why a record, a marker or a transition is refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TicketError {
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
    /// `site ≥ 12`, or a slot outside 2..=3.
    SiteOrSlot {
        site: u8,
        slot: u8,
    },
    /// The cursor past the one site.
    BadNext(u8),
    /// Citizen bytes too short.
    Citizen,
    /// A ticket (legacy or wide) is already open.
    TicketOpen,
    /// No wide ticket is pending.
    NoWideTicket,
    /// The slot is not empty.
    SlotTaken(u8),
    /// A capture siege reserves the slot.
    SlotReserved(u8),
    /// The marker's bytes are not a state the program writes (a wide bell
    /// with ticket bits outside 2..=3).
    Malformed,
    /// A settle would consume more than the record's escrow holds.
    Escrow,
}

impl From<KeyError> for TicketError {
    fn from(e: KeyError) -> Self {
        TicketError::World(e)
    }
}

impl From<CoordError> for TicketError {
    fn from(e: CoordError) -> Self {
        TicketError::Coord(e)
    }
}

// ------------------------------------------------------------ address

/// `wt ‖ hex(sha256(TICKET_SEED_DOMAIN ‖ citizen)[..15])`.
pub fn ticket_seed(citizen: &[u8; 32]) -> Seed {
    let h = sha256(&[TICKET_SEED_DOMAIN, citizen]);
    Seed::new(TICKET_TAG, &h[..15])
}

/// `with_seed(season, wt‖hash(citizen), program)`: one ticket per Citizen.
pub fn ticket_address(ctx: &AddrCtx, citizen: &[u8; 32]) -> [u8; 32] {
    ctx.of(&ticket_seed(citizen))
}

/// The wide ticket score: `rng::rand(seed, TICKET_SCORE_DOMAIN, sort key ‖
/// site ‖ LE64(tag))`; the deployed tie rule (`displaces`) applies to it
/// unchanged.
pub fn wide_ticket_score(seed: &[u8; 32], coord: WideCoord, site: u8, citizen_tag: u64) -> u64 {
    let mut id = [0u8; SORT_KEY_LEN + 1 + 8];
    id[..SORT_KEY_LEN].copy_from_slice(&coord.sort_key());
    id[SORT_KEY_LEN] = site;
    id[SORT_KEY_LEN + 1..].copy_from_slice(&citizen_tag.to_le_bytes());
    rand(seed, TICKET_SCORE_DOMAIN, &id)
}

// ------------------------------------------------------------ the marker

/// What the Citizen's deployed ticket fields hold.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CitizenTicket {
    /// `TICKET_BELL == NO_TICKET`.
    None,
    /// A deployed ticket (at least one site named).
    Legacy,
    /// The wide marker: the filing bell and the slot it reserves.
    Wide { bell: u32, slot: u8 },
}

/// Reads the Citizen's ticket fields: no ticket, a deployed one, or the
/// wide marker. `Malformed` when the bell is set, the sites are zero and
/// the ticket bits are not 2 or 3 (no program writes that).
pub fn pending(citizen: &[u8]) -> Result<CitizenTicket, TicketError> {
    let c = TicketError::Citizen;
    let bell = rd_u32(citizen, C::TICKET_BELL).ok_or(c)?;
    if bell == C::NO_TICKET {
        return Ok(CitizenTicket::None);
    }
    let sites = citizen
        .get(C::TICKET_SITES..C::TICKET_SITES + TICKET_SITES_LEN)
        .ok_or(c)?;
    if sites.iter().any(|b| *b != 0) {
        return Ok(CitizenTicket::Legacy);
    }
    let slot = rd_u8(citizen, C2::SLOTS).ok_or(c)? & C2::SLOTS_TICKET_MASK;
    if !(2..=3).contains(&slot) {
        return Err(TicketError::Malformed);
    }
    Ok(CitizenTicket::Wide { bell, slot })
}

/// Marks the Citizen's one ticket as a pending wide ticket of `bell` for
/// `slot` (2 or 3): no ticket open, the slot empty and not reserved. Writes
/// `TICKET_BELL`, `TICKET_NEXT`, the zero sites and the ticket bits; the
/// escrow, the funder, the reservation bits and everything else are
/// untouched.
pub fn mark(citizen: &mut [u8], bell: u32, slot: u8) -> Result<(), TicketError> {
    if bell == C::NO_TICKET {
        return Err(TicketError::Malformed);
    }
    if !(2..=3).contains(&slot) {
        return Err(TicketError::SiteOrSlot { site: 0, slot });
    }
    if pending(citizen)? != CitizenTicket::None {
        return Err(TicketError::TicketOpen);
    }
    match binding_of(citizen, slot) {
        Ok(SlotBinding::Empty) => {}
        _ => return Err(TicketError::SlotTaken(slot)),
    }
    let c = TicketError::Citizen;
    let slots = rd_u8(citizen, C2::SLOTS).ok_or(c)?;
    if slots & C2::reserved_bit(slot) != 0 {
        return Err(TicketError::SlotReserved(slot));
    }
    let ok = wr_u32(citizen, C::TICKET_BELL, bell)
        & wr_u8(citizen, C::TICKET_NEXT, 0)
        & wr_arr(citizen, C::TICKET_SITES, &[0u8; TICKET_SITES_LEN])
        & wr_u8(
            citizen,
            C2::SLOTS,
            (slots & !C2::SLOTS_TICKET_MASK) | (slot & C2::SLOTS_TICKET_MASK),
        );
    if ok {
        Ok(())
    } else {
        Err(c)
    }
}

/// Clears a pending wide marker: `TICKET_BELL = NO_TICKET`, `TICKET_NEXT`
/// 0, the ticket bits 0. Returns the marker it cleared. The reservation
/// bits stay.
pub fn clear(citizen: &mut [u8]) -> Result<(u32, u8), TicketError> {
    let CitizenTicket::Wide { bell, slot } = pending(citizen)? else {
        return Err(TicketError::NoWideTicket);
    };
    let c = TicketError::Citizen;
    let slots = rd_u8(citizen, C2::SLOTS).ok_or(c)?;
    let ok = wr_u32(citizen, C::TICKET_BELL, C::NO_TICKET)
        & wr_u8(citizen, C::TICKET_NEXT, 0)
        & wr_u8(citizen, C2::SLOTS, slots & !C2::SLOTS_TICKET_MASK);
    if ok {
        Ok((bell, slot))
    } else {
        Err(c)
    }
}

// ------------------------------------------------------------ the record

/// Whether the record's ticket is pending or ended (module doc).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TicketStatus {
    /// Pending: the Citizen carries the marker of this bell and slot.
    Open,
    /// Ended (won, taken or expired): no marker; `coord`, `site`, `slot`,
    /// `bell` and `next` are the last ticket's as it ended, informational;
    /// `escrow` is what it retained.
    Settled,
}

/// A wide ticket, decoded.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct WideTicket {
    pub season_id: u64,
    pub world: WorldId,
    pub status: TicketStatus,
    pub citizen: [u8; 32],
    pub coord: WideCoord,
    pub site: u8,
    /// The Citizen slot it would found into (2 or 3).
    pub slot: u8,
    /// The filing bell (the cohort).
    pub bell: u32,
    /// The deployed `ticket_next`: 0 while the one site is unsettled.
    pub next: u8,
    /// The deployed `TICKET_FUNDER`: who last topped the escrow up, and
    /// receives the **escrow** at the season-end close.
    pub funder: [u8; 32],
    /// The deployed Citizen `RENT_PAYER`: who paid the record's own rent at
    /// its creation. **Immutable**; receives the record's rent and any
    /// excess (everything but the escrow) at the season-end close.
    pub rent_payer: [u8; 32],
    /// The deployed `TICKET_ESCROW`: the wide Holding rent the record holds
    /// above its own, in lamports (the record's lamports are at least its
    /// own rent plus this).
    pub escrow: u64,
}

impl WideTicket {
    /// The first filing of a Citizen (no record yet): `site` of `coord`
    /// into `slot` at `bell`, the record created by `payer`, who is both
    /// its rent payer (for good) and its first funder, holding `escrow`
    /// (one wide Holding rent). The coordinate past the disk, the site
    /// below 12, the slot 2 or 3.
    #[allow(clippy::too_many_arguments)]
    pub fn file(
        world: WorldId,
        season_id: u64,
        citizen: [u8; 32],
        coord: WideCoord,
        site: u8,
        slot: u8,
        bell: u32,
        payer: [u8; 32],
        escrow: u64,
    ) -> Result<WideTicket, TicketError> {
        Self::check_site(coord, site, slot, bell)?;
        Ok(WideTicket {
            season_id,
            world,
            status: TicketStatus::Open,
            citizen,
            coord,
            site,
            slot,
            bell,
            next: 0,
            funder: payer,
            rent_payer: payer,
            escrow,
        })
    }

    fn check_site(coord: WideCoord, site: u8, slot: u8, bell: u32) -> Result<(), TicketError> {
        let ring = coord.ring();
        if ring < FIRST_WIDE_RING {
            return Err(TicketError::NotWide { ring });
        }
        if site as usize >= SITES_PER_PROVINCE || !(2..=3).contains(&slot) {
            return Err(TicketError::SiteOrSlot { site, slot });
        }
        if bell == C::NO_TICKET {
            return Err(TicketError::Malformed);
        }
        Ok(())
    }

    /// The end of the pending ticket (the deployed SettleTicket's ending):
    /// `consumed` lamports leave the escrow (one wide rent at a win, into
    /// the holding or to a displaced funder; nothing when expired or
    /// taken), the rest is retained; the record becomes `Settled`. `Status`
    /// unless `Open`; `Escrow` when `consumed` exceeds the escrow.
    pub fn settle(&self, consumed: u64) -> Result<WideTicket, TicketError> {
        if self.status != TicketStatus::Open {
            return Err(TicketError::Status(wide_ticket::STATUS_SETTLED));
        }
        let escrow = self
            .escrow
            .checked_sub(consumed)
            .ok_or(TicketError::Escrow)?;
        Ok(WideTicket {
            status: TicketStatus::Settled,
            escrow,
            ..*self
        })
    }

    /// A filing over a `Settled` record (the deployed FileOutpost's escrow
    /// rule over the retained escrow): the escrow must reach `need` (one
    /// wide Holding rent); the top-up is `need − escrow` (0 when the
    /// retained escrow covers it); `payer` becomes the funder **only when
    /// it tops up**, else the stored funder stays (its retained rent is
    /// never re-attributed); the escrow becomes `max(escrow, need)`.
    /// Returns the `Open` record and the top-up the payer owes. The rent
    /// payer never changes. `Status` unless `Settled`.
    #[allow(clippy::too_many_arguments)]
    pub fn refile(
        &self,
        coord: WideCoord,
        site: u8,
        slot: u8,
        bell: u32,
        payer: [u8; 32],
        need: u64,
    ) -> Result<(WideTicket, u64), TicketError> {
        if self.status != TicketStatus::Settled {
            return Err(TicketError::Status(wide_ticket::STATUS_OPEN));
        }
        Self::check_site(coord, site, slot, bell)?;
        let top = need.saturating_sub(self.escrow);
        let funder = if top > 0 { payer } else { self.funder };
        Ok((
            WideTicket {
                status: TicketStatus::Open,
                coord,
                site,
                slot,
                bell,
                next: 0,
                funder,
                escrow: self.escrow.max(need),
                ..*self
            },
            top,
        ))
    }

    /// Decodes exactly `wide_ticket::SIZE` bytes.
    pub fn read(d: &[u8]) -> Result<WideTicket, TicketError> {
        use wide_ticket as L;
        if d.len() != L::SIZE {
            return Err(TicketError::Length {
                expected: L::SIZE,
                got: d.len(),
            });
        }
        let t = TicketError::Length {
            expected: L::SIZE,
            got: 0,
        };
        if rd_arr::<8>(d, L::HDR_MAGIC).ok_or(t)? != L::MAGIC {
            return Err(TicketError::Magic);
        }
        let fv = rd_u16(d, L::FAMILY_VERSION).ok_or(t)?;
        if fv != WIDE_LAND_FAMILY_VERSION {
            return Err(TicketError::Version {
                expected: WIDE_LAND_FAMILY_VERSION,
                got: fv,
            });
        }
        let status = match rd_u8(d, L::STATUS).ok_or(t)? {
            L::STATUS_OPEN => TicketStatus::Open,
            L::STATUS_SETTLED => TicketStatus::Settled,
            sb => return Err(TicketError::Status(sb)),
        };
        for (o, n) in [(L::RSV_22, 2usize), (L::RSV_28, 4), (L::RSV_81, 7)] {
            land::zero(d, o, n).map_err(|_| TicketError::Reserved)?;
        }
        let key: [u8; SORT_KEY_LEN] = rd_arr(d, L::SORT_KEY).ok_or(t)?;
        let coord = WideCoord::from_sort_key(&key)?;
        let ring = coord.ring();
        if ring < FIRST_WIDE_RING {
            return Err(TicketError::NotWide { ring });
        }
        let site = rd_u8(d, L::SITE).ok_or(t)?;
        let slot = rd_u8(d, L::SLOT).ok_or(t)?;
        if site as usize >= SITES_PER_PROVINCE || !(2..=3).contains(&slot) {
            return Err(TicketError::SiteOrSlot { site, slot });
        }
        let next = rd_u8(d, L::NEXT).ok_or(t)?;
        if next > 1 {
            return Err(TicketError::BadNext(next));
        }
        let bell = rd_u32(d, L::BELL).ok_or(t)?;
        if bell == C::NO_TICKET {
            return Err(TicketError::Malformed);
        }
        Ok(WideTicket {
            season_id: rd_u64(d, L::SEASON_ID).ok_or(t)?,
            world: WorldId::new(rd_arr(d, L::WORLD).ok_or(t)?)?,
            status,
            citizen: rd_arr(d, L::CITIZEN).ok_or(t)?,
            coord,
            site,
            slot,
            bell,
            next,
            funder: rd_arr(d, L::FUNDER).ok_or(t)?,
            rent_payer: rd_arr(d, L::RENT_PAYER).ok_or(t)?,
            escrow: rd_u64(d, L::ESCROW).ok_or(t)?,
        })
    }

    /// Writes every byte of the record (reserved ranges zeroed).
    pub fn write(&self, d: &mut [u8]) -> Result<(), TicketError> {
        use wide_ticket as L;
        if d.len() != L::SIZE {
            return Err(TicketError::Length {
                expected: L::SIZE,
                got: d.len(),
            });
        }
        let status = match self.status {
            TicketStatus::Open => L::STATUS_OPEN,
            TicketStatus::Settled => L::STATUS_SETTLED,
        };
        let ok = wr_arr(d, L::HDR_MAGIC, &L::MAGIC)
            & wr_u64(d, L::SEASON_ID, self.season_id)
            & wr_u16(d, L::FAMILY_VERSION, WIDE_LAND_FAMILY_VERSION)
            & wr_u8(d, L::STATUS, status)
            & wr_u8(d, L::SLOT, self.slot)
            & wr_u8(d, L::SITE, self.site)
            & wr_u8(d, L::NEXT, self.next)
            & wr_arr(d, L::RSV_22, &[0u8; 2])
            & wr_u32(d, L::BELL, self.bell)
            & wr_arr(d, L::RSV_28, &[0u8; 4])
            & wr_arr(d, L::WORLD, self.world.as_bytes())
            & wr_arr(d, L::SORT_KEY, &self.coord.sort_key())
            & wr_arr(d, L::RSV_81, &[0u8; 7])
            & wr_arr(d, L::CITIZEN, &self.citizen)
            & wr_arr(d, L::FUNDER, &self.funder)
            & wr_arr(d, L::RENT_PAYER, &self.rent_payer)
            & wr_u64(d, L::ESCROW, self.escrow);
        if ok {
            Ok(())
        } else {
            Err(TicketError::Length {
                expected: L::SIZE,
                got: 0,
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::layout::player::holding_ref as HR;
    use crate::layout::Field;

    fn world() -> WorldId {
        WorldId::new([0x77; 32]).unwrap()
    }

    fn c(p: i64, q: i64) -> WideCoord {
        WideCoord::checked(p, q).unwrap()
    }

    /// A joined Citizen with three empty slots and no ticket, as Join leaves it.
    fn citizen() -> std::vec::Vec<u8> {
        let mut d = std::vec![0u8; C2::SIZE];
        for slot in 1..=3u8 {
            d[C2::holding_of_slot(slot) + HR::GEN] = C2::EMPTY_GEN;
        }
        wr_u32(&mut d, C::TICKET_BELL, C::NO_TICKET);
        d
    }

    fn tiles(size: usize, fields: &[Field]) {
        let mut at = 0;
        for f in fields {
            assert_eq!(f.off, at, "{} at {} not {at}", f.name, f.off);
            at += f.len;
        }
        assert_eq!(at, size);
    }

    #[test]
    fn layout_tag_and_address_are_provisional_and_one_per_citizen() {
        tiles(wide_ticket::SIZE, wide_ticket::FIELDS);
        assert_eq!(wide_ticket::SIZE, 192);
        assert_eq!(&wide_ticket::MAGIC[..4], b"PSFX");
        assert_ne!(wide_ticket::MAGIC, wide_ticket::MAGIC_V1_REFUSED);
        assert_eq!(
            crate::layout::AccountKind::from_magic(&wide_ticket::MAGIC),
            None
        );
        assert_eq!(
            permutation_rules::frontier::addr::SeedKind::from_tag(&TICKET_TAG),
            None
        );
        assert_eq!(ticket_seed(&[1; 32]).len(), 32);
        let ctx = AddrCtx {
            season: [3; 32],
            program: [4; 32],
        };
        assert_eq!(
            ticket_address(&ctx, &[1; 32]),
            ticket_address(&ctx, &[1; 32])
        );
        assert_ne!(
            ticket_address(&ctx, &[1; 32]),
            ticket_address(&ctx, &[2; 32])
        );
        assert_ne!(
            ticket_address(&ctx, &[1; 32]),
            ctx.citizen_by_tag15(&[1; 15])
        );
        assert_eq!(TICKET_SITES_LEN, 15);
    }

    /// The marker: only onto an empty, unreserved slot 2 or 3 with no
    /// ticket open; read back as wide; the escrow, funder and reservation
    /// bits untouched; cleared back to no ticket; a deployed ticket is
    /// never mistaken for it and blocks it.
    #[test]
    fn marker_reserves_the_one_ticket_and_the_slot_and_nothing_else() {
        let mut d = citizen();
        assert_eq!(pending(&d), Ok(CitizenTicket::None));
        assert_eq!(
            mark(&mut d, 7, 1),
            Err(TicketError::SiteOrSlot { site: 0, slot: 1 })
        );
        assert_eq!(
            mark(&mut d, 7, 4),
            Err(TicketError::SiteOrSlot { site: 0, slot: 4 })
        );
        assert_eq!(mark(&mut d, C::NO_TICKET, 2), Err(TicketError::Malformed));
        assert_eq!(clear(&mut d), Err(TicketError::NoWideTicket));
        assert_eq!(d, citizen(), "a refusal writes nothing");
        // a reserved slot, a taken slot
        d[C2::SLOTS] = C2::SLOTS_RESERVED_2;
        assert_eq!(mark(&mut d, 7, 2), Err(TicketError::SlotReserved(2)));
        d[C2::SLOTS] = 0;
        d[C2::holding_of_slot(3) + HR::GEN] = 1;
        assert_eq!(mark(&mut d, 7, 3), Err(TicketError::SlotTaken(3)));
        d[C2::holding_of_slot(3) + HR::GEN] = C2::EMPTY_GEN;
        // the mark
        wr_u64(&mut d, C::TICKET_ESCROW, 999);
        d[C2::SLOTS] = C2::SLOTS_RESERVED_3;
        mark(&mut d, 7, 2).unwrap();
        assert_eq!(pending(&d), Ok(CitizenTicket::Wide { bell: 7, slot: 2 }));
        assert_eq!(rd_u32(&d, C::TICKET_BELL), Some(7));
        assert_eq!(
            d[C2::SLOTS],
            C2::SLOTS_RESERVED_3 | 2,
            "the reservation bit stays"
        );
        assert_eq!(
            rd_u64(&d, C::TICKET_ESCROW),
            Some(999),
            "the escrow is not the marker's"
        );
        assert_eq!(&d[C::TICKET_SITES..C::TICKET_SITES + 15], &[0u8; 15]);
        // the deployed lowest-free-slot rule sees slot 2 taken by the ticket
        assert_eq!(
            C2::lowest_free_slot(d[C2::SLOTS], C2::EMPTY_GEN, C2::EMPTY_GEN),
            None
        );
        assert_eq!(mark(&mut d, 8, 3), Err(TicketError::TicketOpen));
        assert_eq!(clear(&mut d), Ok((7, 2)));
        assert_eq!(pending(&d), Ok(CitizenTicket::None));
        assert_eq!(d[C2::SLOTS], C2::SLOTS_RESERVED_3);
        // a deployed ticket: one site named
        let mut l = citizen();
        wr_u32(&mut l, C::TICKET_BELL, 5);
        l[C::TICKET_SITES + TS::P] = 3;
        l[C2::SLOTS] = 1;
        assert_eq!(pending(&l), Ok(CitizenTicket::Legacy));
        assert_eq!(mark(&mut l, 7, 2), Err(TicketError::TicketOpen));
        assert_eq!(clear(&mut l), Err(TicketError::NoWideTicket));
        // a wide bell with ticket bits outside 2..=3 is no state the program writes
        let mut m = citizen();
        wr_u32(&mut m, C::TICKET_BELL, 5);
        assert_eq!(pending(&m), Err(TicketError::Malformed));
        m[C2::SLOTS] = 1;
        assert_eq!(pending(&m), Err(TicketError::Malformed));
        assert!(matches!(pending(&[0u8; 10]), Err(TicketError::Citizen)));
    }

    #[test]
    fn record_round_trips_and_refuses_bad_bytes() {
        let t = WideTicket::file(
            world(),
            11,
            [0xc1; 32],
            c(-129, 129),
            5,
            3,
            9,
            [0xd4; 32],
            1_000,
        )
        .unwrap();
        assert_eq!((t.next, t.status, t.escrow), (0, TicketStatus::Open, 1_000));
        assert_eq!((t.funder, t.rent_payer), ([0xd4; 32], [0xd4; 32]));
        let mut d = [0u8; wide_ticket::SIZE];
        t.write(&mut d).unwrap();
        assert_eq!(WideTicket::read(&d), Ok(t));
        assert_eq!(d[wide_ticket::STATUS], wide_ticket::STATUS_OPEN);
        assert_eq!(rd_u64(&d, wide_ticket::ESCROW), Some(1_000));
        assert_eq!(
            &d[wide_ticket::RENT_PAYER..wide_ticket::RENT_PAYER + 32],
            &[0xd4; 32]
        );
        // the first draft's codec is refused by length and by magic alike
        assert_eq!(
            WideTicket::read(&d[..160]),
            Err(TicketError::Length {
                expected: 192,
                got: 160
            })
        );
        let mut v1 = d;
        v1[..8].copy_from_slice(&wide_ticket::MAGIC_V1_REFUSED);
        assert_eq!(WideTicket::read(&v1), Err(TicketError::Magic));
        let s = t.settle(0).unwrap();
        let mut sd = [0u8; wide_ticket::SIZE];
        s.write(&mut sd).unwrap();
        assert_eq!(sd[wide_ticket::STATUS], wide_ticket::STATUS_SETTLED);
        assert_eq!(WideTicket::read(&sd), Ok(s));
        assert_eq!(
            WideTicket::file(world(), 11, [1; 32], c(128, 0), 5, 3, 9, [2; 32], 0),
            Err(TicketError::NotWide { ring: 128 })
        );
        assert_eq!(
            WideTicket::file(world(), 11, [1; 32], c(129, 0), 12, 3, 9, [2; 32], 0),
            Err(TicketError::SiteOrSlot { site: 12, slot: 3 })
        );
        assert_eq!(
            WideTicket::file(world(), 11, [1; 32], c(129, 0), 0, 1, 9, [2; 32], 0),
            Err(TicketError::SiteOrSlot { site: 0, slot: 1 })
        );
        assert_eq!(
            WideTicket::file(
                world(),
                11,
                [1; 32],
                c(129, 0),
                0,
                2,
                C::NO_TICKET,
                [2; 32],
                0
            ),
            Err(TicketError::Malformed)
        );
        assert_eq!(
            WideTicket::read(&d[..191]),
            Err(TicketError::Length {
                expected: 192,
                got: 191
            })
        );
        let mut x = d;
        x[1] ^= 1;
        assert_eq!(WideTicket::read(&x), Err(TicketError::Magic));
        let mut x = d;
        x[wide_ticket::FAMILY_VERSION] = 2;
        assert_eq!(
            WideTicket::read(&x),
            Err(TicketError::Version {
                expected: 1,
                got: 2
            })
        );
        for sb in [0u8, 3, 0xff] {
            let mut x = d;
            x[wide_ticket::STATUS] = sb;
            assert_eq!(WideTicket::read(&x), Err(TicketError::Status(sb)));
        }
        for off in [
            wide_ticket::RSV_22,
            wide_ticket::RSV_28 + 3,
            wide_ticket::RSV_81,
        ] {
            let mut x = d;
            x[off] = 1;
            assert_eq!(WideTicket::read(&x), Err(TicketError::Reserved), "{off}");
        }
        let mut x = d;
        x[wide_ticket::NEXT] = 2;
        assert_eq!(WideTicket::read(&x), Err(TicketError::BadNext(2)));
        let mut x = d;
        x[wide_ticket::SLOT] = 1;
        assert_eq!(
            WideTicket::read(&x),
            Err(TicketError::SiteOrSlot { site: 5, slot: 1 })
        );
        let mut x = d;
        x[wide_ticket::WORLD..wide_ticket::WORLD + 32].fill(0);
        assert_eq!(
            WideTicket::read(&x),
            Err(TicketError::World(KeyError::ReservedWorld))
        );
        let mut x = d;
        x[wide_ticket::SORT_KEY..wide_ticket::SORT_KEY + 17].copy_from_slice(&c(128, 0).sort_key());
        assert_eq!(
            WideTicket::read(&x),
            Err(TicketError::NotWide { ring: 128 })
        );
    }

    /// The escrow follows the deployed FileOutpost / SettleTicket /
    /// CloseCitizen rules: a win consumes exactly the rent and the record
    /// stays Settled with the rest; expired or taken consumes nothing; a
    /// refile over a Settled record tops the escrow up to the need and the
    /// payer becomes the funder only when it tops up, while the rent payer
    /// never changes; nothing settles twice or files over an Open record; a
    /// settle never consumes more than the escrow holds.
    #[test]
    fn escrow_is_retained_consumed_once_and_reattributed_only_by_a_top_up() {
        let rent = 1_000u64;
        let (payer, other) = ([0xd4; 32], [0xd5; 32]);
        let open =
            WideTicket::file(world(), 11, [0xc1; 32], c(129, 0), 5, 2, 9, payer, rent).unwrap();
        // expired or taken: nothing consumed, the rent retained
        let kept = open.settle(0).unwrap();
        assert_eq!(
            (kept.status, kept.escrow, kept.funder),
            (TicketStatus::Settled, rent, payer)
        );
        assert_eq!(
            (kept.coord, kept.site, kept.slot, kept.bell),
            (c(129, 0), 5, 2, 9)
        );
        assert_eq!(
            kept.settle(0),
            Err(TicketError::Status(wide_ticket::STATUS_SETTLED))
        );
        // a refile over the retained rent by another payer: no top-up, the
        // funder stays
        let (again, top) = kept.refile(c(129, -1), 2, 2, 40, other, rent).unwrap();
        assert_eq!(top, 0);
        assert_eq!(
            (again.status, again.escrow, again.funder),
            (TicketStatus::Open, rent, payer)
        );
        assert_eq!(
            (again.coord, again.site, again.slot, again.bell, again.next),
            (c(129, -1), 2, 2, 40, 0)
        );
        assert_eq!(
            (again.season_id, again.world, again.citizen),
            (11, world(), [0xc1; 32])
        );
        assert_eq!(
            again.refile(c(129, 0), 1, 2, 41, other, rent),
            Err(TicketError::Status(wide_ticket::STATUS_OPEN))
        );
        // a win consumes exactly the rent
        let won = again.settle(rent).unwrap();
        assert_eq!(
            (won.status, won.escrow, won.funder),
            (TicketStatus::Settled, 0, payer)
        );
        assert_eq!(again.settle(rent + 1), Err(TicketError::Escrow));
        // a refile over an empty escrow: the whole need is the top-up and
        // the payer who tops up becomes the funder
        let (third, top) = won.refile(c(129, 0), 6, 3, 50, other, rent).unwrap();
        assert_eq!(top, rent);
        assert_eq!((third.escrow, third.funder), (rent, other));
        assert_eq!(
            third.rent_payer, payer,
            "the record's rent stays the creator's"
        );
        assert_eq!(third.settle(rent).unwrap().rent_payer, payer);
        // a partial shortfall (the need grew): the top-up is the difference
        // and the payer of the difference becomes the funder
        let (grown, top) = kept.refile(c(129, 0), 6, 3, 50, other, rent + 10).unwrap();
        assert_eq!(top, 10);
        assert_eq!((grown.escrow, grown.funder), (rent + 10, other));
        // the site rules hold on a refile
        assert_eq!(
            kept.refile(c(128, 0), 6, 3, 50, other, rent),
            Err(TicketError::NotWide { ring: 128 })
        );
        assert_eq!(
            kept.refile(c(129, 0), 6, 1, 50, other, rent),
            Err(TicketError::SiteOrSlot { site: 6, slot: 1 })
        );
        assert_eq!(
            kept.refile(c(129, 0), 6, 3, C::NO_TICKET, other, rent),
            Err(TicketError::Malformed)
        );
    }

    /// The wide score is a full-width function of the coordinate (two
    /// coordinates that agree in their low 32 bits differ), the site, the
    /// tag and the seed; under its own domain it is never the deployed
    /// score of any `i32` pair.
    #[test]
    fn score_reads_the_whole_coordinate_under_its_own_domain() {
        let seed = [0x5a; 32];
        let a = c(129, 0);
        let b = c((1i64 << 32) + 129, -(1i64 << 32));
        assert_eq!(b.ring(), (1u64 << 32) + 129);
        assert_ne!(
            wide_ticket_score(&seed, a, 3, 9),
            wide_ticket_score(&seed, b, 3, 9)
        );
        assert_ne!(
            wide_ticket_score(&seed, a, 3, 9),
            wide_ticket_score(&seed, a, 4, 9)
        );
        assert_ne!(
            wide_ticket_score(&seed, a, 3, 9),
            wide_ticket_score(&seed, a, 3, 10)
        );
        assert_ne!(
            wide_ticket_score(&seed, a, 3, 9),
            wide_ticket_score(&[0x5b; 32], a, 3, 9)
        );
        assert_eq!(
            wide_ticket_score(&seed, a, 3, 9),
            wide_ticket_score(&seed, a, 3, 9)
        );
        // the deployed formula over the same numbers is another value
        let mut legacy = [0u8; 17];
        legacy[..4].copy_from_slice(&129i32.to_le_bytes());
        legacy[8] = 3;
        legacy[9..].copy_from_slice(&9u64.to_le_bytes());
        assert_ne!(
            wide_ticket_score(&seed, a, 3, 9),
            rand(&seed, b"site", &legacy)
        );
    }
}
