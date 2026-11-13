//! Provisional, pure Free City conquest storage. Existing commands use marker
//! guards only; no command creates or writes these conquest or escrow records.
//! Full references never enter the legacy packed `Record::src`. Plans return new
//! values; callers must authenticate accounts and atomically apply both mirrors.
use super::{ProvinceKey, WideHostRef, WorldId};
use crate::addr::{AddrCtx, Seed};
use crate::conquest_model::{
    self, Record, SiteRecordRules, SiteReport, SiteTransition, SiteTransitionMirror, StepParams,
};
use crate::v2::layout::{
    player::citizen as C,
    province::{conquest as CR, site as SM},
};
use alloc::vec::Vec;
use permutation_rules::hash::sha256;

/// Header and 12 site entries (1664 bytes, unchanged), then the siege
/// reservation region: `RESERVATIONS_N` records of 128 bytes
/// (`CLAUDE-CONQUEST-RESERVATION-SPEC-20261112.md` §4.1).
///
/// ISOLATION: the reservation region exists ONLY with `conquest-dispatch-experimental` (the conquest lane). Without
/// it the table codec is the original one byte for byte: 1664 bytes, table version 1, header bytes 120..128 zero,
/// no reservation records (`RESERVATIONS_N` = 0). With it the table is a DIFFERENT, version-2 layout of 2688 bytes;
/// a version-1 table is refused there (no migration), so the two never mix.
pub const CONQUEST_SIZE: usize = 1664 + RESERVATIONS_N * RESERVATION_LEN;
#[cfg(feature = "conquest-dispatch-experimental")]
pub const RESERVATIONS_N: usize = 8;
#[cfg(not(feature = "conquest-dispatch-experimental"))]
pub const RESERVATIONS_N: usize = 0;
/// The conquest TABLE's layout version: 2 with the reservation region, the original 1 without it.
#[cfg(feature = "conquest-dispatch-experimental")]
const TABLE_VERSION: u16 = 2;
#[cfg(not(feature = "conquest-dispatch-experimental"))]
const TABLE_VERSION: u16 = 1;
pub const RESERVATION_LEN: usize = 128;
const RESERVATION_OFF: usize = 1664;
pub const CAPTURE_ESCROW_SIZE: usize = 320;
/// Reservation status: waiting for its bell.
pub const RES_PENDING: u8 = 1;
/// Reservation status: did not apply; its full return is owed.
pub const RES_NOT_APPLIED: u8 = 2;
/// NOT_APPLIED part done: every recorded resource credited in full.
pub const RES_RESOURCES_RETURNED: u8 = 1 << 0;
/// NOT_APPLIED part done: escrow binding refunded and Citizen slot cleared.
pub const RES_SLOT_RENT_RELEASED: u8 = 1 << 1;
const RES_DONE_ALL: u8 = RES_RESOURCES_RETURNED | RES_SLOT_RENT_RELEASED;
const VERSION: u16 = 1;
const MAGIC: &[u8; 8] = b"PSFXWCQ1";
const ESCROW_MAGIC: &[u8; 8] = b"PSFXWCE1";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ConquestError {
    Length,
    Magic,
    Version,
    Reserved,
    Identity,
    Slot,
    Marker,
    Stale,
    State,
    TooEarly,
    Overflow,
    Escrow,
    Rules,
    /// Every reservation record of the province is in use.
    Full,
    /// No remaining part of a not-applied reservation's return can be made
    /// now; nothing changes and the return stays owed.
    Blocked,
    /// The reservation (by seq) does not exist (already fully returned).
    Absent,
}
type R<T> = Result<T, ConquestError>;
fn slot_index(slot: u8) -> R<usize> {
    match slot {
        2 | 3 => Ok((slot - 2) as usize),
        _ => Err(ConquestError::Slot),
    }
}
pub const fn wide_reserved_bit(slot: u8) -> u8 {
    match slot {
        2 => 1 << 4,
        3 => 1 << 5,
        _ => 0,
    }
}
pub fn wide_reservations(slots: u8) -> R<u8> {
    let low = (slots & 0x30) >> 2;
    if slots & low != low {
        return Err(ConquestError::Marker);
    }
    Ok(low)
}
pub fn legacy_reservations(slots: u8) -> R<u8> {
    Ok((slots & 0x0c) & !wide_reservations(slots)?)
}
pub fn has_wide_reservations(slots: u8) -> R<bool> {
    Ok(wide_reservations(slots)? != 0)
}
pub fn ensure_legacy_slot(slots: u8, slot: u8) -> R<()> {
    slot_index(slot)?;
    if wide_reservations(slots)? & C::reserved_bit(slot) != 0 {
        return Err(ConquestError::Marker);
    }
    Ok(())
}
/// Only the slots byte changes. Pending wide tickets remain unsupported.
pub fn mark(citizen: &mut [u8], slot: u8) -> R<()> {
    slot_index(slot)?;
    if citizen.len() != C::SIZE {
        return Err(ConquestError::Length);
    }
    let slots = citizen[C::SLOTS];
    wide_reservations(slots)?;
    if !matches!(
        super::holding::binding_of(citizen, slot),
        Ok(super::holding::SlotBinding::Empty)
    ) || slots & C::reserved_bit(slot) != 0
        || slots & C::SLOTS_TICKET_MASK == slot
        || matches!(
            super::ticket::pending(citizen),
            Ok(super::ticket::CitizenTicket::Wide { .. }) | Err(_)
        )
    {
        return Err(ConquestError::Slot);
    }
    citizen[C::SLOTS] = slots | C::reserved_bit(slot) | wide_reserved_bit(slot);
    Ok(())
}
pub fn clear(citizen: &mut [u8], slot: u8) -> R<()> {
    slot_index(slot)?;
    if citizen.len() != C::SIZE {
        return Err(ConquestError::Length);
    }
    let slots = citizen[C::SLOTS];
    if !matches!(
        super::holding::binding_of(citizen, slot),
        Ok(super::holding::SlotBinding::Empty)
    ) {
        return Err(ConquestError::Slot);
    }
    if wide_reservations(slots)? & C::reserved_bit(slot) == 0 {
        return Err(ConquestError::Marker);
    }
    citizen[C::SLOTS] = slots & !(C::reserved_bit(slot) | wide_reserved_bit(slot));
    Ok(())
}
pub fn conquest_seed(key: ProvinceKey) -> Seed {
    Seed::new(
        *b"wq",
        &sha256(&[b"PSF-WIDE-CONQUEST-SEED-v1", &key.to_bytes()])[..15],
    )
}
pub fn conquest_address(ctx: &AddrCtx, key: ProvinceKey) -> [u8; 32] {
    ctx.of(&conquest_seed(key))
}
pub fn capture_escrow_seed(citizen: &[u8; 32]) -> Seed {
    Seed::new(
        *b"we",
        &sha256(&[b"PSF-WIDE-CAPTURE-ESCROW-SEED-v1", citizen])[..15],
    )
}
pub fn capture_escrow_address(ctx: &AddrCtx, citizen: &[u8; 32]) -> [u8; 32] {
    ctx.of(&capture_escrow_seed(citizen))
}

fn prefix(r: SiteRecordRules, actor: u64) -> Record {
    Record {
        kind: r.kind,
        faction: r.faction,
        flags: r.flags,
        progress: r.progress,
        required: r.required,
        target: r.target,
        vigil_start: r.vigil_start,
        vigil_next: r.vigil_next,
        vigil_from_day: r.vigil_from_day,
        bell: r.bell,
        actor,
        src: 0,
    }
}
fn rules_write(r: SiteRecordRules, b: &mut [u8]) {
    b[..6].copy_from_slice(&[r.kind, r.faction, r.flags, r.progress, r.required, r.target]);
    b[6..8].copy_from_slice(&r.vigil_start.to_le_bytes());
    b[8..10].copy_from_slice(&r.vigil_next.to_le_bytes());
    b[10..12].copy_from_slice(&r.vigil_from_day.to_le_bytes());
    b[12..16].copy_from_slice(&r.bell.to_le_bytes());
}
fn u16_at(b: &[u8], o: usize) -> u16 {
    u16::from_le_bytes(b[o..o + 2].try_into().unwrap())
}
fn u32_at(b: &[u8], o: usize) -> u32 {
    u32::from_le_bytes(b[o..o + 4].try_into().unwrap())
}
fn u64_at(b: &[u8], o: usize) -> u64 {
    u64::from_le_bytes(b[o..o + 8].try_into().unwrap())
}
fn rules_read(b: &[u8]) -> SiteRecordRules {
    SiteRecordRules {
        kind: b[0],
        faction: b[1],
        flags: b[2],
        progress: b[3],
        required: b[4],
        target: b[5],
        vigil_start: u16_at(b, 6),
        vigil_next: u16_at(b, 8),
        vigil_from_day: u16_at(b, 10),
        bell: u32_at(b, 12),
    }
}
fn zero(b: &[u8]) -> R<()> {
    if b.iter().any(|x| *x != 0) {
        Err(ConquestError::Reserved)
    } else {
        Ok(())
    }
}
fn header(b: &[u8], size: usize, magic: &[u8; 8]) -> R<()> {
    header_v(b, size, magic, VERSION)
}
fn header_v(b: &[u8], size: usize, magic: &[u8; 8], version: u16) -> R<()> {
    if b.len() != size {
        return Err(ConquestError::Length);
    }
    if &b[..8] != magic {
        return Err(ConquestError::Magic);
    }
    if u16_at(b, 16) != version {
        return Err(ConquestError::Version);
    }
    zero(&b[18..32])
}
fn write_header(b: &mut [u8], magic: &[u8; 8], season: u64) {
    write_header_v(b, magic, season, VERSION)
}
fn write_header_v(b: &mut [u8], magic: &[u8; 8], season: u64, version: u16) {
    b[..8].copy_from_slice(magic);
    b[8..16].copy_from_slice(&season.to_le_bytes());
    b[16..18].copy_from_slice(&version.to_le_bytes());
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct WideConquestEntry {
    pub rules: SiteRecordRules,
    pub citizen: [u8; 32],
    pub source: Option<WideHostRef>,
    pub actor_tag: u64,
    pub reserved_slot: u8,
    pub original_target_gen: u8,
    /// Immutable, even after rules.bell becomes completion or immunity context.
    pub declaration_bell: u32,
}
impl WideConquestEntry {
    pub fn prefix(&self) -> Record {
        prefix(self.rules, self.actor_tag)
    }
    fn validate(&self, world: WorldId) -> R<()> {
        slot_index(self.reserved_slot)?;
        if self.citizen == [0; 32] || self.actor_tag != crate::addr::citizen_tag(&self.citizen) {
            return Err(ConquestError::Identity);
        }
        if let Some(src) = self.source {
            if src.key().world() != world
                || src.seq() != 0
                || (src.key().coord().ring() < super::land::FIRST_WIDE_RING
                    && super::LegacyAdapter::new(world).host_id(&src).is_err())
                || src.gen() == 0
                || src.gen() == u8::MAX
            {
                return Err(ConquestError::Identity);
            }
        }
        let r = self.rules;
        // Representability gate of the currently supported WideHolding codec,
        // not a change to the shared wrapping capture-generation rule.
        if self.original_target_gen >= 254 {
            return Err(ConquestError::State);
        }
        match r.kind {
            CR::KIND_SIEGE | CR::KIND_CAPTURE_DUE => {
                if self.source.is_none()
                    || r.target != CR::target(CR::TARGET_FREE_CITY, self.reserved_slot)
                    || r.faction >= 6
                {
                    return Err(ConquestError::State);
                }
                if r.kind == CR::KIND_SIEGE {
                    if r.bell != self.declaration_bell {
                        return Err(ConquestError::State);
                    }
                    if r.flags != (CR::FLAG_HELD | CR::FLAG_NEUTRAL)
                        || r.required == 0
                        || r.progress >= r.required
                    {
                        return Err(ConquestError::State);
                    }
                } else if r.flags != CR::FLAG_CREDITED
                    || r.progress != 0
                    || r.required != 0
                    || r.bell <= self.declaration_bell
                {
                    return Err(ConquestError::State);
                }
                if r.vigil_start != 0 || r.vigil_next != 0 || r.vigil_from_day != 0 {
                    return Err(ConquestError::State);
                }
            }
            CR::KIND_NONE => {
                if r.flags != CR::FLAG_SLOT_OWED
                    || r.required != self.reserved_slot
                    || self.source.is_some()
                    || r.target != 0
                    || r.progress != 0
                    || r.vigil_start != 0
                    || r.vigil_next != 0
                    || r.vigil_from_day != 0
                    || r.faction != CR::BARRED_NONE
                    || r.bell != 0
                {
                    return Err(ConquestError::State);
                }
            }
            _ => return Err(ConquestError::State),
        }
        Ok(())
    }
    fn write(&self, b: &mut [u8]) {
        rules_write(self.rules, b);
        b[16..48].copy_from_slice(&self.citizen);
        if let Some(s) = self.source {
            b[48..104].copy_from_slice(&s.to_bytes());
        }
        b[104..112].copy_from_slice(&self.actor_tag.to_le_bytes());
        b[112] = self.reserved_slot;
        b[113] = self.original_target_gen;
        b[114..118].copy_from_slice(&self.declaration_bell.to_le_bytes());
    }
    fn read(b: &[u8], world: WorldId) -> R<Self> {
        zero(&b[118..128])?;
        let source = if b[48..104].iter().all(|x| *x == 0) {
            None
        } else {
            Some(WideHostRef::from_bytes(&b[48..104]).map_err(|_| ConquestError::Identity)?)
        };
        let e = Self {
            rules: rules_read(b),
            citizen: b[16..48].try_into().unwrap(),
            source,
            actor_tag: u64_at(b, 104),
            reserved_slot: b[112],
            original_target_gen: b[113],
            declaration_bell: u32_at(b, 114),
        };
        e.validate(world)?;
        Ok(e)
    }
}

/// A siege declaration signed before its province resolved through the
/// declaring bell. It applies (becomes the site entry an immediate
/// declaration would have written) or does not apply when the resolver
/// reaches `bell`. Everything collected at signature is recorded here so a
/// not-applied reservation returns it exactly, never capped or burnt.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Reservation {
    pub status: u8,
    pub site: u8,
    /// The roster entry index named at signature.
    pub entry: u8,
    pub reserved_slot: u8,
    pub faction: u8,
    /// NOT_APPLIED return parts already done (`RES_*` bits).
    pub done: u8,
    /// The declaration bell it applies at.
    pub bell: u32,
    /// Reservation order (per-table counter).
    pub seq: u32,
    pub citizen: [u8; 32],
    /// The full host reference named at signature.
    pub host: WideHostRef,
    pub actor_tag: u64,
    pub gold_milli: u64,
    pub arms_milli: u64,
}
impl Reservation {
    /// The source Holding the collected resources came from.
    pub fn source(&self) -> WideHostRef {
        self.host.holding_ref()
    }
    /// The escrow binding: the one an immediate declaration at `bell` creates.
    pub fn binding(&self, key: ProvinceKey) -> CaptureBinding {
        CaptureBinding {
            key,
            site: self.site,
            gen: 0,
            declaration_bell: self.bell,
        }
    }
    /// Whether the Citizen slot and its escrow binding are still held.
    pub fn holds_slot(&self) -> bool {
        self.status == RES_PENDING || self.done & RES_SLOT_RENT_RELEASED == 0
    }
    fn validate(&self, world: WorldId) -> R<()> {
        slot_index(self.reserved_slot)?;
        if self.citizen == [0; 32] || self.actor_tag != crate::addr::citizen_tag(&self.citizen) {
            return Err(ConquestError::Identity);
        }
        let h = self.host;
        if h.key().world() != world
            || h.gen() == 0
            || h.gen() == u8::MAX
            || (h.key().coord().ring() < super::land::FIRST_WIDE_RING
                && super::LegacyAdapter::new(world).host_id(&h).is_err())
        {
            return Err(ConquestError::Identity);
        }
        let done_ok = match self.status {
            RES_PENDING => self.done == 0,
            RES_NOT_APPLIED => self.done & !RES_DONE_ALL == 0 && self.done != RES_DONE_ALL,
            _ => false,
        };
        if !done_ok || self.site as usize >= 12 || self.faction >= 6 || self.bell == 0 {
            return Err(ConquestError::State);
        }
        Ok(())
    }
    fn write(&self, b: &mut [u8]) {
        b[..6].copy_from_slice(&[
            self.status,
            self.site,
            self.entry,
            self.reserved_slot,
            self.faction,
            self.done,
        ]);
        b[8..12].copy_from_slice(&self.bell.to_le_bytes());
        b[12..16].copy_from_slice(&self.seq.to_le_bytes());
        b[16..48].copy_from_slice(&self.citizen);
        b[48..104].copy_from_slice(&self.host.to_bytes());
        b[104..112].copy_from_slice(&self.actor_tag.to_le_bytes());
        b[112..120].copy_from_slice(&self.gold_milli.to_le_bytes());
        b[120..128].copy_from_slice(&self.arms_milli.to_le_bytes());
    }
    fn read(b: &[u8], world: WorldId) -> R<Self> {
        zero(&b[6..8])?;
        let r = Self {
            status: b[0],
            site: b[1],
            entry: b[2],
            reserved_slot: b[3],
            faction: b[4],
            done: b[5],
            bell: u32_at(b, 8),
            seq: u32_at(b, 12),
            citizen: b[16..48].try_into().unwrap(),
            host: WideHostRef::from_bytes(&b[48..104]).map_err(|_| ConquestError::Identity)?,
            actor_tag: u64_at(b, 104),
            gold_milli: u64_at(b, 112),
            arms_milli: u64_at(b, 120),
        };
        r.validate(world)?;
        Ok(r)
    }
}

/// What one SettleReservation call does (all-or-nothing per part).
#[cfg(feature = "conquest-dispatch-experimental")]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReservationSettle {
    pub conquest: WideConquest,
    pub reservation: Reservation,
    /// Credit every recorded resource in full in this transaction.
    pub return_resources: bool,
    /// Refund the escrow binding and clear the Citizen slot in this transaction.
    pub release_slot_rent: bool,
    /// Both parts are now done and the record is freed.
    pub freed: bool,
    /// A PENDING reservation became NOT_APPLIED by the season's end or
    /// abort (the caller recomputes the site's PENDING flag if the province
    /// is still present). A lapse alone, with no part doable, still records
    /// the owed return.
    pub lapsed: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WideConquest {
    season_id: u64,
    key: ProvinceKey,
    rent_payer: [u8; 32],
    entries: [Option<WideConquestEntry>; 12],
    next_seq: u32,
    reservations: [Option<Reservation>; RESERVATIONS_N],
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConquestPlan {
    pub conquest: WideConquest,
    pub prefix: Record,
    pub transition: Option<SiteTransition>,
    pub return_stake_to: Option<WideHostRef>,
}
impl WideConquest {
    pub fn new(season_id: u64, key: ProvinceKey, rent_payer: [u8; 32]) -> R<Self> {
        if key.coord().ring() < super::land::FIRST_WIDE_RING {
            return Err(ConquestError::Identity);
        }
        Ok(Self {
            season_id,
            key,
            rent_payer,
            entries: [None; 12],
            next_seq: 0,
            reservations: [None; RESERVATIONS_N],
        })
    }
    pub fn reservations(&self) -> &[Option<Reservation>; RESERVATIONS_N] {
        &self.reservations
    }
    pub fn next_seq(&self) -> u32 {
        self.next_seq
    }
    /// Whether the table holds no entry and no reservation record.
    pub fn is_empty(&self) -> bool {
        self.entries.iter().all(Option::is_none) && self.reservations.iter().all(Option::is_none)
    }
    pub fn reservation(&self, seq: u32) -> Option<(usize, Reservation)> {
        self.reservations
            .iter()
            .enumerate()
            .find_map(|(i, r)| r.filter(|r| r.seq == seq).map(|r| (i, r)))
    }
    /// Whether a PENDING reservation names `site`.
    pub fn has_pending(&self, site: u8) -> bool {
        self.reservations
            .iter()
            .flatten()
            .any(|r| r.status == RES_PENDING && r.site == site)
    }
    /// Whether any PENDING reservation is older than bell `b`.
    pub fn stale_pending(&self, b: u32) -> bool {
        self.reservations
            .iter()
            .flatten()
            .any(|r| r.status == RES_PENDING && r.bell < b)
    }
    /// The PENDING reservations of (site, bell) in reservation order.
    pub fn pending_at(&self, site: u8, bell: u32) -> Vec<(usize, Reservation)> {
        let mut v: Vec<(usize, Reservation)> = self
            .reservations
            .iter()
            .enumerate()
            .filter_map(|(i, r)| {
                r.filter(|r| r.status == RES_PENDING && r.site == site && r.bell == bell)
                    .map(|r| (i, r))
            })
            .collect();
        v.sort_by_key(|(_, r)| r.seq);
        v
    }
    /// Whether (citizen, slot) is held by an entry or a slot-holding record.
    fn slot_taken(&self, citizen: &[u8; 32], slot: u8) -> bool {
        self.entries
            .iter()
            .flatten()
            .any(|e| e.citizen == *citizen && e.reserved_slot == slot)
            || self
                .reservations
                .iter()
                .flatten()
                .any(|r| r.holds_slot() && r.citizen == *citizen && r.reserved_slot == slot)
    }
    /// The canonical kind-zero prefix of an entry-less site with its
    /// PENDING flag recomputed from this table.
    pub fn idle_prefix(&self, site: u8, current: Record) -> R<Record> {
        if self.entry(site)?.is_some() || current.kind != CR::KIND_NONE {
            return Err(ConquestError::State);
        }
        let mut p = current;
        p.flags = if self.has_pending(site) {
            CR::FLAG_PENDING
        } else {
            0
        };
        Ok(p)
    }
    /// Record a reservation. Collection (stake, cost, cap, slot mark, escrow
    /// binding and rents) and every signature-time check remain the caller's,
    /// in the same transaction. `r.seq` is assigned here.
    #[cfg(feature = "conquest-dispatch-experimental")]
    pub fn reserve(&self, expected: Record, mut r: Reservation) -> R<(Self, Record, Reservation)> {
        self.validate_paired(r.site, expected)?;
        if r.status != RES_PENDING || r.done != 0 {
            return Err(ConquestError::State);
        }
        if self.entry(r.site)?.is_some()
            || expected.kind != CR::KIND_NONE
            || expected.flags & CR::OWED_MASK != 0
            || self.slot_taken(&r.citizen, r.reserved_slot)
        {
            return Err(ConquestError::State);
        }
        let i = self
            .reservations
            .iter()
            .position(Option::is_none)
            .ok_or(ConquestError::Full)?;
        r.seq = self.next_seq;
        r.validate(self.key.world())?;
        let mut next = self.clone();
        next.next_seq = self.next_seq.checked_add(1).ok_or(ConquestError::Overflow)?;
        next.reservations[i] = Some(r);
        let prefix = next.idle_prefix(r.site, expected)?;
        Ok((next, prefix, r))
    }
    /// Apply PENDING reservation record `i` as the site entry `e` (exactly
    /// the entry an immediate declaration at its bell writes). The caller has
    /// re-checked every state condition at that bell. The slot, escrow
    /// binding and collected stake carry over unchanged to the entry.
    #[cfg(feature = "conquest-dispatch-experimental")]
    pub fn apply_reservation(&self, i: usize, e: WideConquestEntry) -> R<ConquestPlan> {
        let r = self
            .reservations
            .get(i)
            .copied()
            .flatten()
            .ok_or(ConquestError::Absent)?;
        if r.status != RES_PENDING
            || self.entry(r.site)?.is_some()
            || e.rules.kind != CR::KIND_SIEGE
            || e.rules.progress != 0
            || e.citizen != r.citizen
            || e.actor_tag != r.actor_tag
            || e.reserved_slot != r.reserved_slot
            || e.declaration_bell != r.bell
            || e.rules.bell != r.bell
            || e.rules.faction != r.faction
            || e.rules.target != CR::target(CR::TARGET_FREE_CITY, r.reserved_slot)
            || e.source != Some(r.source())
            || e.original_target_gen != 0
        {
            return Err(ConquestError::State);
        }
        e.validate(self.key.world())?;
        let mut conquest = self.clone();
        conquest.reservations[i] = None;
        conquest.entries[r.site as usize] = Some(e);
        Ok(ConquestPlan {
            conquest,
            prefix: e.prefix(),
            transition: None,
            return_stake_to: None,
        })
    }
    /// PENDING record `i` does not apply: its full return becomes owed.
    #[cfg(feature = "conquest-dispatch-experimental")]
    pub fn not_apply(&self, i: usize) -> R<Self> {
        let mut r = self
            .reservations
            .get(i)
            .copied()
            .flatten()
            .ok_or(ConquestError::Absent)?;
        if r.status != RES_PENDING {
            return Err(ConquestError::State);
        }
        r.status = RES_NOT_APPLIED;
        let mut next = self.clone();
        next.reservations[i] = Some(r);
        Ok(next)
    }
    /// Plan the parts of a NOT_APPLIED reservation's return that can be done
    /// now. `resources_ok`: the caller verified every recorded amount fits the
    /// present, same-generation source Holding in full. `slot_rent_ok`: the
    /// caller authenticated the Citizen and the escrow binding. A part already
    /// done is never planned again; nothing doable is `Blocked`.
    ///
    /// `terminal_lapse`: the caller authenticated that this reservation can
    /// never be applied any more (the season Aborted or tombstoned, or Ended
    /// with the province closed), so a PENDING reservation does not apply,
    /// by the season's end or abort. Never an early cancellation: otherwise a
    /// PENDING reservation is `TooEarly`.
    #[cfg(feature = "conquest-dispatch-experimental")]
    pub fn settle_reservation(
        &self,
        seq: u32,
        resources_ok: bool,
        slot_rent_ok: bool,
        terminal_lapse: bool,
    ) -> R<ReservationSettle> {
        let (i, mut r) = self.reservation(seq).ok_or(ConquestError::Absent)?;
        let lapsed = r.status == RES_PENDING && terminal_lapse;
        if lapsed {
            r.status = RES_NOT_APPLIED;
        }
        if r.status != RES_NOT_APPLIED {
            return Err(ConquestError::TooEarly);
        }
        let return_resources = r.done & RES_RESOURCES_RETURNED == 0 && resources_ok;
        let release_slot_rent = r.done & RES_SLOT_RENT_RELEASED == 0 && slot_rent_ok;
        if !return_resources && !release_slot_rent && !lapsed {
            return Err(ConquestError::Blocked);
        }
        let mut next_r = r;
        if return_resources {
            next_r.done |= RES_RESOURCES_RETURNED;
        }
        if release_slot_rent {
            next_r.done |= RES_SLOT_RENT_RELEASED;
        }
        let freed = next_r.done == RES_DONE_ALL;
        let mut conquest = self.clone();
        conquest.reservations[i] = if freed { None } else { Some(next_r) };
        Ok(ReservationSettle {
            conquest,
            reservation: r,
            return_resources,
            release_slot_rent,
            freed,
            lapsed,
        })
    }
    pub fn key(&self) -> ProvinceKey {
        self.key
    }
    pub fn rent_payer(&self) -> [u8; 32] {
        self.rent_payer
    }
    pub fn entry(&self, site: u8) -> R<Option<WideConquestEntry>> {
        self.entries
            .get(site as usize)
            .copied()
            .ok_or(ConquestError::Identity)
    }
    pub fn to_bytes(&self) -> [u8; CONQUEST_SIZE] {
        let mut b = [0; CONQUEST_SIZE];
        write_header_v(&mut b, MAGIC, self.season_id, TABLE_VERSION);
        b[32..82].copy_from_slice(&self.key.to_bytes());
        b[88..120].copy_from_slice(&self.rent_payer);
        for (i, e) in self.entries.iter().enumerate() {
            if let Some(e) = e {
                e.write(&mut b[128 + i * 128..256 + i * 128]);
            }
        }
        // the reservation counter exists only in the version-2 (conquest lane) layout; v1 keeps 120..128 zero
        #[cfg(feature = "conquest-dispatch-experimental")]
        b[120..124].copy_from_slice(&self.next_seq.to_le_bytes());
        for (i, r) in self.reservations.iter().enumerate() {
            if let Some(r) = r {
                let o = RESERVATION_OFF + i * RESERVATION_LEN;
                r.write(&mut b[o..o + RESERVATION_LEN]);
            }
        }
        b
    }
    pub fn read(b: &[u8], season_id: u64, key: ProvinceKey) -> R<Self> {
        header_v(b, CONQUEST_SIZE, MAGIC, TABLE_VERSION)?;
        zero(&b[82..88])?;
        // v1 (no conquest lane): the original rule, 120..128 all zero. v2: 120..124 is the reservation counter.
        #[cfg(not(feature = "conquest-dispatch-experimental"))]
        zero(&b[120..128])?;
        #[cfg(feature = "conquest-dispatch-experimental")]
        zero(&b[124..128])?;
        if u64_at(b, 8) != season_id
            || ProvinceKey::from_bytes(&b[32..82]).map_err(|_| ConquestError::Identity)? != key
        {
            return Err(ConquestError::Identity);
        }
        let mut out = Self::new(season_id, key, b[88..120].try_into().unwrap())?;
        for i in 0..12 {
            let d = &b[128 + i * 128..256 + i * 128];
            if d.iter().any(|x| *x != 0) {
                let entry = WideConquestEntry::read(d, key.world())?;
                if out
                    .entries
                    .iter()
                    .flatten()
                    .any(|e| e.citizen == entry.citizen && e.reserved_slot == entry.reserved_slot)
                {
                    return Err(ConquestError::State);
                }
                out.entries[i] = Some(entry);
            }
        }
        #[cfg(feature = "conquest-dispatch-experimental")]
        {
            out.next_seq = u32_at(b, 120);
        }
        for i in 0..RESERVATIONS_N {
            let o = RESERVATION_OFF + i * RESERVATION_LEN;
            let d = &b[o..o + RESERVATION_LEN];
            if d.iter().any(|x| *x != 0) {
                let r = Reservation::read(d, key.world())?;
                if r.seq >= out.next_seq
                    || out.reservations.iter().flatten().any(|o| o.seq == r.seq)
                    || (r.holds_slot() && out.slot_taken(&r.citizen, r.reserved_slot))
                {
                    return Err(ConquestError::State);
                }
                out.reservations[i] = Some(r);
            }
        }
        Ok(out)
    }
    /// An entry-less site's prefix carries the PENDING flag exactly while a
    /// PENDING reservation names the site. A site entry's prefix is the
    /// entry's own (reservations for a later bell may still wait on it).
    pub fn validate_paired(&self, site: u8, p: Record) -> R<()> {
        let idle_flags = if self.has_pending(site) {
            CR::FLAG_PENDING
        } else {
            0
        };
        match self.entry(site)? {
            Some(e) if e.prefix() == p => Ok(()),
            None if p.kind == CR::KIND_NONE
                && (p.faction < 6
                    || p.faction == CR::BARRED_ALL
                    || p.faction == CR::BARRED_NONE)
                && p.flags == idle_flags
                && p.progress == 0
                && p.required == 0
                && p.target == 0
                && p.vigil_start == 0
                && p.vigil_next == 0
                && p.vigil_from_day == 0
                && p.actor == 0
                && p.src == 0 =>
            {
                Ok(())
            }
            _ => Err(ConquestError::Stale),
        }
    }
    /// Declaration prerequisites (authority, stake debit and presence)
    /// remain caller obligations. This boundary admits only an initial Free City.
    pub fn declare(
        &self,
        site: u8,
        expected: Record,
        mirror: SiteTransitionMirror,
        e: WideConquestEntry,
    ) -> R<ConquestPlan> {
        self.validate_paired(site, expected)?;
        e.validate(self.key.world())?;
        if self
            .entries
            .iter()
            .flatten()
            .any(|other| other.citizen == e.citizen && other.reserved_slot == e.reserved_slot)
        {
            return Err(ConquestError::State);
        }
        // A pending reservation on the site precedes any immediate declaration
        // (reservation order); the caller must reserve instead.
        if self.entry(site)?.is_some()
            || self.has_pending(site)
            || self.slot_taken(&e.citizen, e.reserved_slot)
            || e.rules.kind != CR::KIND_SIEGE
            || e.rules.progress != 0
            || mirror.state != SM::STATE_FREE_CITY
            || mirror.gen != e.original_target_gen
        {
            return Err(ConquestError::State);
        }
        let mut conquest = self.clone();
        conquest.entries[site as usize] = Some(e);
        Ok(ConquestPlan {
            conquest,
            prefix: e.prefix(),
            transition: None,
            return_stake_to: None,
        })
    }
    fn expected(&self, site: u8, p: Record, e: WideConquestEntry) -> R<()> {
        self.validate_paired(site, p)?;
        if self.entry(site)? != Some(e) {
            return Err(ConquestError::Stale);
        }
        Ok(())
    }
    /// The caller must pair this with the province's resolved-next cursor and
    /// advance that cursor atomically. A side table alone cannot prove bell order.
    pub fn step(
        &self,
        site: u8,
        p: Record,
        e: WideConquestEntry,
        mirror: SiteTransitionMirror,
        bell: u32,
        report: SiteReport,
        params: &StepParams,
    ) -> R<ConquestPlan> {
        self.expected(site, p, e)?;
        if bell >= params.end_bell {
            return Err(ConquestError::TooEarly);
        }
        if e.rules.kind == CR::KIND_SIEGE
            && (mirror.state != SM::STATE_FREE_CITY || mirror.gen != e.original_target_gen)
        {
            return Err(ConquestError::State);
        }
        let transition = conquest_model::site_transition(e.rules, mirror, bell, report, params)
            .map_err(|_| ConquestError::Rules)?;
        let mut conquest = self.clone();
        let mut next = e;
        if let Some(t) = transition {
            next.rules = t.record;
            if !t.retain_source {
                next.source = None;
            }
            if !t.retain_actor {
                return Err(ConquestError::State);
            }
            next.validate(self.key.world())?;
            conquest.entries[site as usize] = Some(next);
        }
        Ok(ConquestPlan {
            conquest,
            prefix: next.prefix(),
            transition,
            return_stake_to: None,
        })
    }
    /// No player cancellation. Only an unresolved active siege at a fully
    /// resolved season end returns its stake; failure has already burnt it.
    /// `ended` must come from the authenticated season status. CaptureDue also
    /// requires the caller to authenticate the target mirror's captured state
    /// and generation and actually fund/create its Holding in the same atomic
    /// transaction. Clearing this pure plan alone is not a successful capture.
    pub fn settle(
        &self,
        site: u8,
        p: Record,
        e: WideConquestEntry,
        resolved_next: u32,
        ended: bool,
        end_bell: u32,
        capture_immunity_bells: u16,
    ) -> R<ConquestPlan> {
        self.expected(site, p, e)?;
        let mut next = Record::ZERO;
        next.faction = CR::BARRED_NONE;
        let return_stake_to = match e.rules.kind {
            CR::KIND_SIEGE => {
                if !ended || resolved_next < end_bell {
                    return Err(ConquestError::TooEarly);
                }
                e.source
            }
            CR::KIND_NONE => None,
            CR::KIND_CAPTURE_DUE => {
                next.faction = CR::BARRED_ALL;
                next.bell = e
                    .rules
                    .bell
                    .saturating_add(1)
                    .saturating_add(capture_immunity_bells as u32);
                e.source
            }
            _ => return Err(ConquestError::State),
        };
        let mut conquest = self.clone();
        conquest.entries[site as usize] = None;
        // Reservations for a later bell of this site keep it flagged, so a
        // plain resolve still cannot skip their application.
        if conquest.has_pending(site) {
            next.flags = CR::FLAG_PENDING;
        }
        Ok(ConquestPlan {
            conquest,
            prefix: next,
            transition: None,
            return_stake_to,
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CaptureBinding {
    pub key: ProvinceKey,
    pub site: u8,
    pub gen: u8,
    pub declaration_bell: u32,
}
impl CaptureBinding {
    fn validate(&self, world: WorldId) -> R<()> {
        if self.key.world() != world
            || self.site >= 12
            || self.gen >= 254
            || self.key.coord().ring() < super::land::FIRST_WIDE_RING
        {
            Err(ConquestError::Identity)
        } else {
            Ok(())
        }
    }
    fn write(self, b: &mut [u8]) {
        b[..50].copy_from_slice(&self.key.to_bytes());
        b[50] = self.site;
        b[51] = self.gen;
        b[52..56].copy_from_slice(&self.declaration_bell.to_le_bytes());
    }
    fn read(b: &[u8], world: WorldId) -> R<Self> {
        let x = Self {
            key: ProvinceKey::from_bytes(&b[..50]).map_err(|_| ConquestError::Identity)?,
            site: b[50],
            gen: b[51],
            declaration_bell: u32_at(b, 52),
        };
        x.validate(world)?;
        Ok(x)
    }
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WideCaptureEscrow {
    season_id: u64,
    world: WorldId,
    citizen: [u8; 32],
    rent_payer: [u8; 32],
    funder: [u8; 32],
    escrow: u64,
    bindings: [Option<CaptureBinding>; 2],
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct EscrowClose {
    /// Citizen reservation pairs to authenticate and clear atomically. Active
    /// bindings require a present Citizen. No province/source data is needed.
    pub active_slots: u8,
    pub funder: [u8; 32],
    pub refund: u64,
    pub rent_payer: [u8; 32],
    pub remainder: u64,
}
impl WideCaptureEscrow {
    pub fn new(season_id: u64, world: WorldId, citizen: [u8; 32], rent_payer: [u8; 32]) -> R<Self> {
        if citizen == [0; 32] {
            return Err(ConquestError::Identity);
        }
        Ok(Self {
            season_id,
            world,
            citizen,
            rent_payer,
            funder: [0; 32],
            escrow: 0,
            bindings: [None; 2],
        })
    }
    pub fn escrow(&self) -> u64 {
        self.escrow
    }
    pub fn funder(&self) -> [u8; 32] {
        self.funder
    }
    pub fn rent_payer(&self) -> [u8; 32] {
        self.rent_payer
    }
    pub fn binding(&self, slot: u8) -> R<Option<CaptureBinding>> {
        Ok(self.bindings[slot_index(slot)?])
    }
    pub fn active_mask(&self) -> u8 {
        self.bindings.iter().enumerate().fold(0, |m, (i, b)| {
            m | if b.is_some() { 1 << (i + 2) } else { 0 }
        })
    }
    pub fn reserve(
        &self,
        slot: u8,
        binding: CaptureBinding,
        wide_rent: u64,
        payer: [u8; 32],
    ) -> R<(Self, u64)> {
        let i = slot_index(slot)?;
        binding.validate(self.world)?;
        if self
            .bindings
            .iter()
            .flatten()
            .any(|b| b.key == binding.key && b.site == binding.site)
        {
            return Err(ConquestError::State);
        }
        if self.bindings[i].is_some() || payer == [0; 32] {
            return Err(ConquestError::State);
        }
        let count = self.active_mask().count_ones() as u64 + 1;
        let want = wide_rent
            .checked_mul(count)
            .ok_or(ConquestError::Overflow)?;
        let topup = want.saturating_sub(self.escrow);
        let mut next = self.clone();
        next.bindings[i] = Some(binding);
        next.escrow = self
            .escrow
            .checked_add(topup)
            .ok_or(ConquestError::Overflow)?;
        if topup != 0 {
            next.funder = payer;
        }
        Ok((next, topup))
    }
    fn remove(&self, slot: u8, expected: CaptureBinding, amount: u64) -> R<Self> {
        let i = slot_index(slot)?;
        if self.bindings[i] != Some(expected) {
            return Err(ConquestError::Stale);
        }
        let mut next = self.clone();
        next.escrow = self
            .escrow
            .checked_sub(amount)
            .ok_or(ConquestError::Escrow)?;
        next.bindings[i] = None;
        Ok(next)
    }
    pub fn refund(&self, slot: u8, expected: CaptureBinding, wide_rent: u64) -> R<(Self, u64)> {
        let amount = wide_rent.min(self.escrow);
        Ok((self.remove(slot, expected, amount)?, amount))
    }
    /// Consume only the actual shortfall of a possibly pre-funded destination.
    pub fn capture(
        &self,
        slot: u8,
        expected: CaptureBinding,
        wide_rent: u64,
        destination_lamports: u64,
    ) -> R<(Self, u64)> {
        if wide_rent > self.escrow {
            return Err(ConquestError::Escrow);
        }
        let amount = wide_rent.saturating_sub(destination_lamports);
        Ok((self.remove(slot, expected, amount)?, amount))
    }
    /// Funds split only, not close eligibility. The caller must first pass the
    /// authenticated existing season-end close guard (including its grace period,
    /// abort or tombstone rules). No gold compensation is created here.
    /// Active bindings require a present authenticated Citizen and its checked
    /// `terminal_citizen_plan` applied in the same transaction as account closure.
    /// This never returns resource stake or requires a live province.
    pub fn close_refund_plan(&self, lamports: u64) -> R<EscrowClose> {
        Ok(EscrowClose {
            active_slots: self.active_mask(),
            funder: self.funder,
            refund: self.escrow,
            rent_payer: self.rent_payer,
            remainder: lamports
                .checked_sub(self.escrow)
                .ok_or(ConquestError::Escrow)?,
        })
    }
    /// Check the complete escrow-owned Citizen inventory without a province
    /// table, including an empty escrow before its first reservation. Expected
    /// season/world/key must come from authenticated caller context; this pure
    /// helper does not authenticate account owner/address or Citizen headers.
    /// Legacy reservations and unrelated holdings remain independent.
    pub fn validate_inventory(
        &self,
        season_id: u64,
        world: WorldId,
        citizen_key: [u8; 32],
        citizen: &[u8],
    ) -> R<()> {
        if citizen.len() != C::SIZE {
            return Err(ConquestError::Length);
        }
        if self.season_id != season_id
            || self.world != world
            || self.citizen != citizen_key
            || u64_at(citizen, C::CITIZEN_TAG) != crate::addr::citizen_tag(&citizen_key)
        {
            return Err(ConquestError::Identity);
        }
        let slots = citizen[C::SLOTS];
        let active_mask = self.active_mask();
        if wide_reservations(slots)? != active_mask
            || matches!(
                super::ticket::pending(citizen),
                Ok(super::ticket::CitizenTicket::Wide { .. }) | Err(_)
            )
        {
            return Err(ConquestError::Marker);
        }
        for slot in 2..=3 {
            if active_mask & C::reserved_bit(slot) != 0
                && (slots & C::SLOTS_TICKET_MASK == slot
                    || !matches!(
                        super::holding::binding_of(citizen, slot),
                        Ok(super::holding::SlotBinding::Empty)
                    ))
            {
                return Err(ConquestError::Marker);
            }
        }
        Ok(())
    }
    /// Return scratch bytes clearing only this escrow's reservation pairs.
    /// No input, escrow state, or lamports are changed, even on failure. Caller
    /// must authenticate account owner/address and terminal eligibility
    /// (Ended + 72h, Aborted, or tombstone) and atomically apply this with closure.
    /// Active bindings require a present authenticated Citizen; the empty-escrow
    /// absent-Citizen case belongs to the handler, never placeholder identities.
    pub fn terminal_citizen_plan(
        &self,
        season_id: u64,
        world: WorldId,
        citizen_key: [u8; 32],
        citizen: &[u8],
    ) -> R<[u8; C::SIZE]> {
        self.validate_inventory(season_id, world, citizen_key, citizen)?;
        let mut next = [0; C::SIZE];
        next.copy_from_slice(citizen);
        for slot in 2..=3 {
            if self.active_mask() & C::reserved_bit(slot) != 0 {
                clear(&mut next, slot)?;
            }
        }
        Ok(next)
    }
    /// Three-way identity check before any external effect. The caller must
    /// authenticate the supplied Citizen account address/owner separately.
    /// Bindings to this province all require matching entries. For another
    /// province only its Citizen marker/empty-slot is checked here; that
    /// province's table must be authenticated by the operation handling it.
    pub fn validate_paired(
        &self,
        conquest: &WideConquest,
        site: u8,
        prefix: Record,
        citizen_key: [u8; 32],
        citizen: &[u8],
    ) -> R<()> {
        conquest.validate_paired(site, prefix)?;
        let entry = conquest.entry(site)?.ok_or(ConquestError::Stale)?;
        if entry.citizen != citizen_key {
            return Err(ConquestError::Identity);
        }
        let expected = CaptureBinding {
            key: conquest.key,
            site,
            gen: entry.original_target_gen,
            declaration_bell: entry.declaration_bell,
        };
        self.validate_all_paired(conquest, citizen_key, citizen, entry.reserved_slot, expected)
    }
    /// The same three-way check for a slot-holding reservation (by seq):
    /// its binding is the one an immediate declaration at its bell creates.
    pub fn validate_paired_reservation(
        &self,
        conquest: &WideConquest,
        seq: u32,
        citizen_key: [u8; 32],
        citizen: &[u8],
    ) -> R<()> {
        let (_, r) = conquest.reservation(seq).ok_or(ConquestError::Absent)?;
        if r.citizen != citizen_key {
            return Err(ConquestError::Identity);
        }
        if !r.holds_slot() {
            self.validate_inventory(conquest.season_id, conquest.key.world(), citizen_key, citizen)?;
            return self.validate_bindings_of(conquest);
        }
        self.validate_all_paired(
            conquest,
            citizen_key,
            citizen,
            r.reserved_slot,
            r.binding(conquest.key),
        )
    }
    fn validate_all_paired(
        &self,
        conquest: &WideConquest,
        citizen_key: [u8; 32],
        citizen: &[u8],
        slot: u8,
        expected: CaptureBinding,
    ) -> R<()> {
        self.validate_inventory(
            conquest.season_id,
            conquest.key.world(),
            citizen_key,
            citizen,
        )?;
        if self.binding(slot)? != Some(expected) {
            return Err(ConquestError::Stale);
        }
        self.validate_bindings_of(conquest)
    }
    /// Every binding of this escrow to `conquest`'s province pairs with an
    /// entry or a slot-holding reservation of this Citizen, and back.
    fn validate_bindings_of(&self, conquest: &WideConquest) -> R<()> {
        for other_slot in 2..=3 {
            if let Some(binding) = self.binding(other_slot)? {
                if binding.key == conquest.key {
                    let by_entry = conquest.entry(binding.site)?.is_some_and(|other| {
                        other.citizen == self.citizen
                            && other.reserved_slot == other_slot
                            && other.original_target_gen == binding.gen
                            && other.declaration_bell == binding.declaration_bell
                    });
                    let by_reservation = conquest.reservations.iter().flatten().any(|r| {
                        r.holds_slot()
                            && r.citizen == self.citizen
                            && r.reserved_slot == other_slot
                            && r.binding(conquest.key) == binding
                    });
                    if !by_entry && !by_reservation {
                        return Err(ConquestError::Stale);
                    }
                }
            }
        }
        for r in conquest.reservations.iter().flatten() {
            if r.holds_slot()
                && r.citizen == self.citizen
                && self.binding(r.reserved_slot)? != Some(r.binding(conquest.key))
            {
                return Err(ConquestError::Stale);
            }
        }
        // Pair both directions: an entry cannot outlive its escrow binding
        // merely because another selected entry still has a valid binding.
        for (other_site, other) in conquest.entries.iter().enumerate() {
            if let Some(other) = other {
                if other.citizen == self.citizen {
                    let expected = CaptureBinding {
                        key: conquest.key,
                        site: other_site as u8,
                        gen: other.original_target_gen,
                        declaration_bell: other.declaration_bell,
                    };
                    if self.binding(other.reserved_slot)? != Some(expected) {
                        return Err(ConquestError::Stale);
                    }
                }
            }
        }
        Ok(())
    }
    pub fn to_bytes(&self) -> [u8; CAPTURE_ESCROW_SIZE] {
        let mut b = [0; CAPTURE_ESCROW_SIZE];
        write_header(&mut b, ESCROW_MAGIC, self.season_id);
        b[32..64].copy_from_slice(self.world.as_bytes());
        b[64..96].copy_from_slice(&self.citizen);
        b[96..128].copy_from_slice(&self.rent_payer);
        b[128..160].copy_from_slice(&self.funder);
        b[160..168].copy_from_slice(&self.escrow.to_le_bytes());
        b[168] = self.active_mask();
        for (i, x) in self.bindings.iter().enumerate() {
            if let Some(x) = x {
                x.write(&mut b[176 + i * 56..232 + i * 56]);
            }
        }
        b
    }
    pub fn read(b: &[u8], season_id: u64, world: WorldId, citizen: [u8; 32]) -> R<Self> {
        header(b, CAPTURE_ESCROW_SIZE, ESCROW_MAGIC)?;
        zero(&b[169..176])?;
        zero(&b[288..320])?;
        if u64_at(b, 8) != season_id
            || &b[32..64] != world.as_bytes()
            || b[64..96] != citizen
            || b[168] & !0x0c != 0
        {
            return Err(ConquestError::Identity);
        }
        let mut out = Self::new(season_id, world, citizen, b[96..128].try_into().unwrap())?;
        out.funder = b[128..160].try_into().unwrap();
        out.escrow = u64_at(b, 160);
        if out.escrow != 0 && out.funder == [0; 32] {
            return Err(ConquestError::Identity);
        }
        for i in 0..2 {
            let d = &b[176 + i * 56..232 + i * 56];
            if b[168] & (1 << (i + 2)) != 0 {
                out.bindings[i] = Some(CaptureBinding::read(d, world)?);
            } else {
                zero(d)?;
            }
        }
        if let [Some(a), Some(b)] = out.bindings {
            if a.key == b.key && a.site == b.site {
                return Err(ConquestError::State);
            }
        }
        Ok(out)
    }
}

#[cfg(all(test, feature = "conquest-dispatch-experimental"))]
#[path = "conquest_reservation_tests.rs"]
mod reservation_tests;

/// The table codec WITHOUT the conquest lane is the original one: version 1, 1664 bytes, header 120..128 zero, no
/// reservation region; a version-2 table is refused.
#[cfg(all(test, not(feature = "conquest-dispatch-experimental")))]
mod v1_codec_isolation_tests {
    use super::*;
    use crate::world_index::{WideCoord, WorldId};
    fn key() -> ProvinceKey {
        ProvinceKey::new(WorldId::new([0x77; 32]).unwrap(), WideCoord::checked(129, 0).unwrap())
    }
    #[test]
    fn without_the_conquest_lane_the_table_is_the_original_v1_codec() {
        assert_eq!(CONQUEST_SIZE, 1664);
        assert_eq!(RESERVATIONS_N, 0);
        let t = WideConquest::new(11, key(), [9; 32]).unwrap();
        let b = t.to_bytes();
        assert_eq!(b.len(), 1664);
        assert_eq!(u16_at(&b, 16), 1, "table layout version 1");
        assert!(b[120..128].iter().all(|x| *x == 0), "the original reserved header bytes stay zero");
        assert_eq!(WideConquest::read(&b, 11, key()).unwrap(), t);
        // a nonzero byte in the old reserved range is refused (no reservation counter in v1)
        let mut bad = b;
        bad[120] = 1;
        assert!(WideConquest::read(&bad, 11, key()).is_err());
        // a version-2 header is refused (no mixing, no migration)
        let mut v2 = b;
        v2[16..18].copy_from_slice(&2u16.to_le_bytes());
        assert_eq!(WideConquest::read(&v2, 11, key()), Err(ConquestError::Version));
        // a 2688-byte buffer is refused by length
        assert_eq!(WideConquest::read(&[0u8; 2688], 11, key()), Err(ConquestError::Length));
        // no pending state can exist: the original kind-zero prefix rule (flags must be 0) holds
        let mut p = Record::ZERO;
        p.faction = CR::BARRED_NONE;
        t.validate_paired(4, p).unwrap();
        p.flags = CR::FLAG_PENDING;
        assert!(t.validate_paired(4, p).is_err());
    }

    /// Existing-data preservation, independent of the codec's own writer: a v1 table with ALL 12 site entries is
    /// assembled by hand from the documented layout, decoded, and re-encoded byte for byte.
    #[test]
    fn a_full_v1_table_assembled_by_hand_round_trips_byte_for_byte() {
        let k = key();
        let mut b = [0u8; 1664];
        b[..8].copy_from_slice(b"PSFXWCQ1");
        b[8..16].copy_from_slice(&11u64.to_le_bytes());
        b[16..18].copy_from_slice(&1u16.to_le_bytes());
        b[32..82].copy_from_slice(&k.to_bytes());
        b[88..120].copy_from_slice(&[9u8; 32]);
        let home = ProvinceKey::new(k.world(), WideCoord::checked(130, 0).unwrap());
        for i in 0..12usize {
            let citizen = [0x10 + i as u8; 32];
            let o = 128 + i * 128;
            let e = &mut b[o..o + 128];
            let slot = 2 + (i % 2) as u8;
            if i % 3 == 0 {
                // kind NONE: a failed siege still owing its slot
                e[..6].copy_from_slice(&[CR::KIND_NONE, CR::BARRED_NONE, CR::FLAG_SLOT_OWED, 0, slot, 0]);
            } else {
                // kind SIEGE: an active siege declared at bell 20 + i, source host kept
                e[..6].copy_from_slice(&[CR::KIND_SIEGE, (i % 6) as u8, CR::FLAG_HELD | CR::FLAG_NEUTRAL, 1, 36, CR::target(CR::TARGET_FREE_CITY, slot)]);
                e[12..16].copy_from_slice(&(20 + i as u32).to_le_bytes());
                e[48..104].copy_from_slice(&WideHostRef::new(home, 0, 1, 0).unwrap().to_bytes());
                e[114..118].copy_from_slice(&(20 + i as u32).to_le_bytes());
            }
            e[16..48].copy_from_slice(&citizen);
            e[104..112].copy_from_slice(&crate::addr::citizen_tag(&citizen).to_le_bytes());
            e[112] = slot;
        }
        let t = WideConquest::read(&b, 11, k).expect("the hand-assembled full v1 table is accepted");
        for i in 0..12u8 {
            let e = t.entry(i).unwrap().expect("every site entry decoded");
            assert_eq!(e.citizen, [0x10 + i; 32]);
        }
        assert_eq!(t.to_bytes(), b, "decode -> encode is byte-identical for a full v1 table");
    }
}

/// Test-only read-path vectors for the map (written only with
/// `WYLLS_WRITE_VECTORS=<path>`).
#[cfg(all(test, feature = "conquest-dispatch-experimental"))]
#[path = "conquest_reservation_vectors_tests.rs"]
mod reservation_vectors_tests;
