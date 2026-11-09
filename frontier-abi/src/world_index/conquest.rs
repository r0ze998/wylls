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
use permutation_rules::hash::sha256;

pub const CONQUEST_SIZE: usize = 1664;
pub const CAPTURE_ESCROW_SIZE: usize = 320;
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
    if b.len() != size {
        return Err(ConquestError::Length);
    }
    if &b[..8] != magic {
        return Err(ConquestError::Magic);
    }
    if u16_at(b, 16) != VERSION {
        return Err(ConquestError::Version);
    }
    zero(&b[18..32])
}
fn write_header(b: &mut [u8], magic: &[u8; 8], season: u64) {
    b[..8].copy_from_slice(magic);
    b[8..16].copy_from_slice(&season.to_le_bytes());
    b[16..18].copy_from_slice(&VERSION.to_le_bytes());
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
                || src.key().coord().ring() < super::land::FIRST_WIDE_RING
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

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WideConquest {
    season_id: u64,
    key: ProvinceKey,
    rent_payer: [u8; 32],
    entries: [Option<WideConquestEntry>; 12],
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
        write_header(&mut b, MAGIC, self.season_id);
        b[32..82].copy_from_slice(&self.key.to_bytes());
        b[88..120].copy_from_slice(&self.rent_payer);
        for (i, e) in self.entries.iter().enumerate() {
            if let Some(e) = e {
                e.write(&mut b[128 + i * 128..256 + i * 128]);
            }
        }
        b
    }
    pub fn read(b: &[u8], season_id: u64, key: ProvinceKey) -> R<Self> {
        header(b, CONQUEST_SIZE, MAGIC)?;
        zero(&b[82..88])?;
        zero(&b[120..128])?;
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
        Ok(out)
    }
    pub fn validate_paired(&self, site: u8, p: Record) -> R<()> {
        match self.entry(site)? {
            Some(e) if e.prefix() == p => Ok(()),
            None if p.kind == CR::KIND_NONE
                && (p.faction < 6
                    || p.faction == CR::BARRED_ALL
                    || p.faction == CR::BARRED_NONE)
                && p.flags == 0
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
        if self.entry(site)?.is_some()
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
    /// Citizen reservation pairs to authenticate and clear atomically, if the
    /// Citizen still exists. Terminal close does not need province/source data.
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
    /// Active bindings do not block terminal cleanup: authenticate and clear
    /// their Citizen markers when present in the same transaction as account
    /// closure. This never returns resource stake or requires a live province.
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
        if citizen.len() != C::SIZE {
            return Err(ConquestError::Length);
        }
        if self.season_id != conquest.season_id
            || self.world != conquest.key.world()
            || self.citizen != citizen_key
            || entry.citizen != citizen_key
            || u64_at(citizen, C::CITIZEN_TAG) != entry.actor_tag
        {
            return Err(ConquestError::Identity);
        }
        let slot = entry.reserved_slot;
        if wide_reservations(citizen[C::SLOTS])? != self.active_mask() {
            return Err(ConquestError::Marker);
        }
        for active in 2..=3 {
            if self.active_mask() & C::reserved_bit(active) != 0
                && (citizen[C::SLOTS] & C::SLOTS_TICKET_MASK == active
                    || !matches!(
                        super::holding::binding_of(citizen, active),
                        Ok(super::holding::SlotBinding::Empty)
                    ))
            {
                return Err(ConquestError::Marker);
            }
        }
        if wide_reservations(citizen[C::SLOTS])? & C::reserved_bit(slot) == 0
            || citizen[C::SLOTS] & C::SLOTS_TICKET_MASK == slot
            || !matches!(
                super::holding::binding_of(citizen, slot),
                Ok(super::holding::SlotBinding::Empty)
            )
            || matches!(
                super::ticket::pending(citizen),
                Ok(super::ticket::CitizenTicket::Wide { .. }) | Err(_)
            )
        {
            return Err(ConquestError::Marker);
        }
        let expected = CaptureBinding {
            key: conquest.key,
            site,
            gen: entry.original_target_gen,
            declaration_bell: entry.declaration_bell,
        };
        if self.binding(slot)? != Some(expected) {
            return Err(ConquestError::Stale);
        }
        for other_slot in 2..=3 {
            if let Some(binding) = self.binding(other_slot)? {
                if binding.key == conquest.key {
                    let other = conquest.entry(binding.site)?.ok_or(ConquestError::Stale)?;
                    if other.citizen != self.citizen
                        || other.reserved_slot != other_slot
                        || other.original_target_gen != binding.gen
                        || other.declaration_bell != binding.declaration_bell
                    {
                        return Err(ConquestError::Stale);
                    }
                }
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
