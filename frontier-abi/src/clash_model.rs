//! The clash of one province-bell as a pure function of account bytes
//! (M1 contract §5.11, I-43, I-50, I-56): the `ClashInput` builder, the
//! write-back of an outcome, the settle of pending changes, the camp's
//! daily check, SkipQuiet's trivial quiet test and the CLASH/SKIP digests.
//!
//! **One copy (W4-A D8, integ-W5):** this is the program's
//! `proc::clash::model`, moved here unchanged in behaviour so the program
//! (`permutation-frontier`), the off-chain readers (`fclient::clash_model`,
//! used by the herald, the verifier's V7 and itest's G14) and the WASM
//! client share it. The rules it implements are pinned in the module note
//! of `permutation-frontier/src/proc/clash.rs` (W4-A, v1.6 §22, v1.7 §23).
//!
//! Errors are [`ModelError`]: the program maps them to its codes
//! (`BadAccount` 2, `Overflow` 19, `Kernel` 15 with the logged sub-code of
//! [`sub`]); off-chain callers print them. The program's heap-trace
//! checkpoints enter through [`Probe`] (a no-op for everyone else), so the
//! program's builds keep the byte-level behaviour they had.

/// `Kernel` (15) sub-codes of the clash area.
pub mod sub {
    /// `clash::ClashError` (the input breaks a kernel bound).
    pub const CLASH_INPUT: u64 = 0x30;
    /// A host or garrison with a change of an earlier bell still pending
    /// (`HostError::Unsettled`).
    pub const UNSETTLED: u64 = 0x31;
    /// A host settle the kernel refuses.
    pub const SETTLE: u64 = 0x32;
}

/// Why the model refused an account's bytes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ModelError {
    /// A short or malformed account (program code `BadAccount`).
    BadAccount,
    /// Checked arithmetic overflowed (program code `Overflow`).
    Overflow,
    /// The kernel refused a stored value; the [`sub`] code says why
    /// (program code `Kernel`).
    Kernel(u64),
}

impl core::fmt::Display for ModelError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            ModelError::BadAccount => f.write_str("BadAccount"),
            ModelError::Overflow => f.write_str("Overflow"),
            ModelError::Kernel(s) => write!(f, "Kernel(sub {s:#x})"),
        }
    }
}

/// The model's result.
pub type R<T> = Result<T, ModelError>;

const BAD_ACCOUNT: ModelError = ModelError::BadAccount;
const OVERFLOW: ModelError = ModelError::Overflow;

#[inline(always)]
const fn kernel(sub: u64) -> ModelError {
    ModelError::Kernel(sub)
}

/// Checkpoints inside [`build_probed`] and [`apply_probed`] (the program's
/// heap trace build logs its heap peak and CU there).
pub trait Probe {
    fn checkpoint(tag: u64);
}

/// No checkpoints.
pub struct NoProbe;

impl Probe for NoProbe {
    #[inline(always)]
    fn checkpoint(_tag: u64) {}
}

/// Bounds-checked reads over an account's bytes (the program's `layout::Ro`).
#[derive(Clone, Copy)]
struct Ro<'a>(&'a [u8]);

/// Bounds-checked writes (the program's `layout::Rw`).
struct Rw<'a>(&'a mut [u8]);

macro_rules! reads {
    ($($name:ident: $t:ty = $f:path;)*) => {$(
        #[allow(dead_code)]
        #[inline]
        fn $name(&self, off: usize) -> R<$t> {
            $f(self.bytes(), off).ok_or(BAD_ACCOUNT)
        }
    )*};
}

macro_rules! read_impl {
    ($t:ty) => {
        impl $t {
            #[allow(dead_code)]
            #[inline]
            fn bytes(&self) -> &[u8] {
                self.0
            }
            reads! {
                u8: u8 = crate::bytes::rd_u8;
                u16: u16 = crate::bytes::rd_u16;
                u32: u32 = crate::bytes::rd_u32;
                u64: u64 = crate::bytes::rd_u64;
                i16: i16 = crate::bytes::rd_i16;
                i64: i64 = crate::bytes::rd_i64;
            }
            #[allow(dead_code)]
            #[inline]
            fn arr<const N: usize>(&self, off: usize) -> R<[u8; N]> {
                crate::bytes::rd_arr(self.bytes(), off).ok_or(BAD_ACCOUNT)
            }
        }
    };
}

read_impl!(Ro<'_>);
read_impl!(Rw<'_>);

macro_rules! writes {
    ($($name:ident: $t:ty = $f:path;)*) => {$(
        #[allow(dead_code)]
        #[inline]
        fn $name(&mut self, off: usize, v: $t) -> R<()> {
            if $f(self.0, off, v) { Ok(()) } else { Err(BAD_ACCOUNT) }
        }
    )*};
}

impl Rw<'_> {
    writes! {
        set_u8: u8 = crate::bytes::wr_u8;
        set_u32: u32 = crate::bytes::wr_u32;
        set_i64: i64 = crate::bytes::wr_i64;
    }
}

use alloc::vec::Vec;

use crate::addr::host_id as mk_host_id;
use crate::entry::{read_entry, unit_from_u8, write_entry, Entry, EntryOp};
use crate::layout::clash::{arrival as AR, clash_inputs as CI};
use crate::layout::province::{camp as CP, entry as E, province as P, site as SM};
use permutation_rules::fixed::{Bps, MilliTroops, BPS_ONE, MILLI};
use permutation_rules::frontier::camp as kcamp;
use permutation_rules::frontier::clash::{
    self as kc, ClashInput, ClashOutcome, Fate, Fighter, Garrison, Occupancy, Relations,
    FACTION_LIMIT, MAX_GARRISONS, NEUTRAL,
};
use permutation_rules::frontier::doctrine::of_faction;
use permutation_rules::frontier::geometry::{ProvinceCoord, PROVINCE_TILES};
use permutation_rules::frontier::host::{
    self as kh, settle_merge, GarrisonState, Host, Stamina, MAX_HOST_TROOPS,
};
use permutation_rules::frontier::stance::{Posture, Stance};
use permutation_rules::frontier::terrain::ProvinceTerrain;
use permutation_rules::hash::sha256;
use permutation_rules::map::{Terrain, TileResource};

/// Domain of the camp seed.
pub const CAMP_DOMAIN: &[u8] = b"PSF-CAMP-v1";
/// Domain of CLASH's input digest.
pub const INPUT_DOMAIN: &[u8] = b"PSF-CLASH-INPUT-v1";
/// Domain of SKIP's quiet digest.
pub const QUIET_DOMAIN: &[u8] = b"PSF-QUIET-v1";
/// The Province's game state a clash reads and writes (site mirrors,
/// entries, resolve summary, camp).
pub const STATE_BLOCK: core::ops::Range<usize> = P::SITE_MIRROR..P::TICKET_COHORTS;
/// The ClashInputs arrival records.
pub const ARRIVALS_BLOCK: core::ops::Range<usize> = CI::ARRIVALS..CI::POSTURES;
/// `gar_site` of the camp.
pub const CAMP_SITE: u8 = 0xFF;
/// Bells per game day.
pub const DAY_BELLS: u32 = 144;

/// Terrain classes by their stored byte (declaration = borsh order).
pub const TERRAINS: [Terrain; 6] = [
    Terrain::Grassland,
    Terrain::Plains,
    Terrain::Forest,
    Terrain::Hills,
    Terrain::Mountain,
    Terrain::Water,
];
/// Tile resources by their stored byte − 1 (0 is none).
pub const RESOURCES: [TileResource; 3] = [
    TileResource::Wheat,
    TileResource::Iron,
    TileResource::Horses,
];

/// The kernel terrain of a Province (W3-A's pinned encoding).
pub fn terrain_of(pd: &[u8]) -> R<ProvinceTerrain> {
    let tb = pd
        .get(P::TERRAIN..P::TERRAIN + PROVINCE_TILES)
        .ok_or(BAD_ACCOUNT)?;
    let rb = pd
        .get(P::RESOURCE..P::RESOURCE + PROVINCE_TILES)
        .ok_or(BAD_ACCOUNT)?;
    let mut terrain = [Terrain::Grassland; PROVINCE_TILES];
    let mut resource = [None; PROVINCE_TILES];
    for i in 0..PROVINCE_TILES {
        terrain[i] = *TERRAINS.get(tb[i] as usize).ok_or(BAD_ACCOUNT)?;
        resource[i] = match rb[i] {
            0 => None,
            v => Some(*RESOURCES.get(v as usize - 1).ok_or(BAD_ACCOUNT)?),
        };
    }
    let r = Ro(pd);
    let sites: [u8; P::SITES_N] = r.arr(P::SITES)?;
    let site_count = r.u8(P::SITE_COUNT)?;
    if site_count as usize > P::SITES_N {
        return Err(BAD_ACCOUNT);
    }
    Ok(ProvinceTerrain {
        terrain,
        resource,
        sites,
        site_count,
    })
}

/// `(P, Q)` of a Province.
pub fn coord_of(pd: &[u8]) -> R<ProvinceCoord> {
    let r = Ro(pd);
    Ok(ProvinceCoord::new(r.i16(P::P)? as i32, r.i16(P::Q)? as i32))
}

/// The camp record (§5.3, I-56); `troops` are whole troops.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Camp {
    pub tile: u8,
    pub state: u8,
    pub troops: u32,
    pub next_check_day: u32,
    pub gen: u32,
}

impl Camp {
    pub fn read(pd: &[u8]) -> R<Camp> {
        let r = Ro(pd);
        Ok(Camp {
            tile: r.u8(P::CAMP + CP::TILE)?,
            state: r.u8(P::CAMP + CP::STATE)?,
            troops: r.u32(P::CAMP + CP::TROOPS)?,
            next_check_day: r.u32(P::CAMP + CP::NEXT_CHECK_DAY)?,
            gen: r.u32(P::CAMP + CP::GEN)?,
        })
    }
    pub fn write(&self, pd: &mut [u8]) -> R<()> {
        let mut w = Rw(pd);
        w.set_u8(P::CAMP + CP::TILE, self.tile)?;
        w.set_u8(P::CAMP + CP::STATE, self.state)?;
        w.set_u32(P::CAMP + CP::TROOPS, self.troops)?;
        w.set_u32(P::CAMP + CP::NEXT_CHECK_DAY, self.next_check_day)?;
        w.set_u32(P::CAMP + CP::GEN, self.gen)
    }
    pub const fn present(&self) -> bool {
        self.state == CP::STATE_PRESENT
    }
    /// The camp's garrison id.
    pub const fn id(&self) -> u64 {
        u64::MAX - self.gen as u64
    }
}

/// The camp's draws: `sha256("PSF-CAMP-v1" ‖ terrain ‖ resources ‖
/// sites ‖ site_count)` (fixed at OpenProvince).
pub fn camp_seed(pd: &[u8]) -> R<[u8; 32]> {
    let block = pd.get(P::TERRAIN..P::SITE_COUNT + 1).ok_or(BAD_ACCOUNT)?;
    Ok(sha256(&[CAMP_DOMAIN, block]))
}

/// Whether any site of the province holds a holding.
pub fn has_holding(pd: &[u8]) -> R<bool> {
    let r = Ro(pd);
    let n = (r.u8(P::SITE_COUNT)? as usize).min(P::SITES_N);
    for s in 0..n {
        if r.u8(P::site(s) + SM::STATE)? == SM::STATE_HOLDING {
            return Ok(true);
        }
    }
    Ok(false)
}

/// The camp after the day's check of bell `b` (I-56): `None` when the
/// check of `day(b)` already ran; else the new record and whether a
/// camp spawned.
pub fn camp_check(pd: &[u8], t: &ProvinceTerrain, b: u32) -> R<Option<(Camp, bool)>> {
    let c = Camp::read(pd)?;
    let day = b / DAY_BELLS;
    if day < c.next_check_day {
        return Ok(None);
    }
    let mut n = c;
    n.next_check_day = day.checked_add(1).ok_or(OVERFLOW)?;
    let spawn = kcamp::place(
        &camp_seed(pd)?,
        coord_of(pd)?,
        t,
        day,
        has_holding(pd)?,
        false,
    );
    if let Some(k) = spawn {
        n.tile = k.tile;
        n.state = CP::STATE_PRESENT;
        n.troops = k.troops;
        n.gen = c.gen.wrapping_add(1);
    }
    Ok(Some((n, spawn.is_some())))
}

/// The site mirror's garrison as the kernel's `GarrisonState` (an empty
/// pending slot is bell `NO_BELL` or a zero delta).
pub fn garrison_of(pd: &[u8], site: usize) -> R<GarrisonState> {
    let r = Ro(pd);
    let o = P::site(site);
    let slot = |b: usize, dl: usize| -> R<Option<(u32, i64)>> {
        let (bell, delta) = (r.u32(o + b)?, r.i64(o + dl)?);
        Ok((bell != SM::NO_BELL && delta != 0).then_some((bell, delta)))
    };
    Ok(GarrisonState {
        troops: r.u32(o + SM::GARRISON)?,
        pending: [
            slot(SM::PEND0_BELL, SM::PEND0_DELTA)?,
            slot(SM::PEND1_BELL, SM::PEND1_DELTA)?,
        ],
    })
}

/// Writes a garrison back into its site mirror.
pub fn put_garrison(pd: &mut [u8], site: usize, g: &GarrisonState) -> R<()> {
    let o = P::site(site);
    let mut w = Rw(pd);
    w.set_u32(o + SM::GARRISON, g.troops)?;
    for (k, (b, dl)) in [
        (SM::PEND0_BELL, SM::PEND0_DELTA),
        (SM::PEND1_BELL, SM::PEND1_DELTA),
    ]
    .into_iter()
    .enumerate()
    {
        let (bell, delta) = g.pending[k].unwrap_or((SM::NO_BELL, 0));
        w.set_u32(o + b, bell)?;
        w.set_i64(o + dl, delta)?;
    }
    Ok(())
}

/// Walls stand at bell `b`: committed, or an item effective by then.
pub fn walls_at(pd: &[u8], site: usize, b: u32) -> R<bool> {
    let r = Ro(pd);
    let o = P::site(site);
    if r.u32(o + SM::WALLS_COMMITTED)? > 0 {
        return Ok(true);
    }
    for (eb, dl) in [
        (SM::WALL_ITEM0_BELL, SM::WALL_ITEM0_DELTA),
        (SM::WALL_ITEM1_BELL, SM::WALL_ITEM1_DELTA),
    ] {
        if r.u32(o + dl)? > 0 && r.u32(o + eb)? <= b {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Entry `i`'s 48 bytes (fixed-offset reads without per-field bounds
/// checks: the hot loops of the resolve and the settle).
#[inline(always)]
fn ent(pd: &[u8], i: usize) -> R<&[u8; E::SIZE]> {
    let o = P::entry(i);
    pd.get(o..o + E::SIZE)
        .and_then(|s| s.try_into().ok())
        .ok_or(BAD_ACCOUNT)
}

#[inline(always)]
fn ent_mut(pd: &mut [u8], i: usize) -> R<&mut [u8; E::SIZE]> {
    let o = P::entry(i);
    pd.get_mut(o..o + E::SIZE)
        .and_then(|s| s.try_into().ok())
        .ok_or(BAD_ACCOUNT)
}

#[inline(always)]
fn g16(e: &[u8; E::SIZE], o: usize) -> u16 {
    u16::from_le_bytes([e[o], e[o + 1]])
}

#[inline(always)]
fn g32(e: &[u8; E::SIZE], o: usize) -> u32 {
    u32::from_le_bytes([e[o], e[o + 1], e[o + 2], e[o + 3]])
}

#[inline(always)]
fn g64(e: &[u8; E::SIZE], o: usize) -> u64 {
    let mut b = [0u8; 8];
    b.copy_from_slice(&e[o..o + 8]);
    u64::from_le_bytes(b)
}

#[inline(always)]
fn p16(e: &mut [u8; E::SIZE], o: usize, v: u16) {
    e[o..o + 2].copy_from_slice(&v.to_le_bytes());
}

#[inline(always)]
fn p32(e: &mut [u8; E::SIZE], o: usize, v: u32) {
    e[o..o + 4].copy_from_slice(&v.to_le_bytes());
}

/// Site mirror `s`'s 64 bytes.
#[inline(always)]
fn mirror(pd: &[u8], s: usize) -> R<&[u8; SM::SIZE]> {
    let o = P::site(s);
    pd.get(o..o + SM::SIZE)
        .and_then(|x| x.try_into().ok())
        .ok_or(BAD_ACCOUNT)
}

#[inline(always)]
fn m32(m: &[u8; SM::SIZE], o: usize) -> u32 {
    u32::from_le_bytes([m[o], m[o + 1], m[o + 2], m[o + 3]])
}

#[inline(always)]
fn m64(m: &[u8; SM::SIZE], o: usize) -> i64 {
    let mut b = [0u8; 8];
    b.copy_from_slice(&m[o..o + 8]);
    i64::from_le_bytes(b)
}

/// Sorts `(id, index)` pairs by id (≤ 48 items; no sort monomorph): a
/// binary search per item and one `memmove` of the tail.
fn insertion_sort(v: &mut [(u64, u8)]) {
    for i in 1..v.len() {
        let x = v[i];
        if v[i - 1].0 <= x.0 {
            continue;
        }
        let at = v[..i].partition_point(|y| y.0 <= x.0);
        v.copy_within(at..i, at + 1);
        v[at] = x;
    }
}

/// A kernel pending change (ops 1–4) of an entry, by its op byte.
#[inline(always)]
const fn kernel_op(op: u8) -> bool {
    op >= E::OP_SPEND && op <= E::OP_ABSORBED_INTO
}

/// `Occupancy` (I-43) from the entry states: musters pending per
/// faction, `56 − entries in states 1–3`.
pub fn occupancy_of(pd: &[u8]) -> R<Occupancy> {
    let r = Ro(pd);
    let mut pending = [0u8; FACTION_LIMIT as usize];
    let mut used = 0u8;
    for i in 0..P::ENTRIES_N {
        let o = P::entry(i);
        match r.u8(o + E::STATE)? {
            E::STATE_FREE => {}
            E::STATE_MUSTER_PENDING => {
                used += 1;
                let f = r.u8(o + E::FACTION)? as usize;
                let c = pending.get_mut(f).ok_or(BAD_ACCOUNT)?;
                *c = c.saturating_add(1);
            }
            _ => used += 1,
        }
    }
    Ok(Occupancy {
        pending,
        storage_free: Occupancy::STORAGE.saturating_sub(used),
    })
}

/// A doctrine multiplier as stored (0 reads as none).
fn bps(v: u16) -> Bps {
    if v == 0 {
        BPS_ONE
    } else {
        v as Bps
    }
}

/// The fighter of an arrival record (`present` checked by the caller).
pub fn arrival_fighter(rec: &[u8]) -> R<Fighter> {
    let r = Ro(rec);
    let retreat = r.u16(AR::RETREAT)?;
    Ok(Fighter {
        id: r.u64(AR::HOST_ID)?,
        faction: r.u8(AR::FACTION)?,
        unit: unit_from_u8(r.u8(AR::UNIT)?).ok_or(BAD_ACCOUNT)?,
        troops: r.u32(AR::TROOPS)?,
        stamina: r.u16(AR::STAMINA)?,
        tile: r.u8(AR::TILE)?,
        posture: Posture::Stance(Stance::from_u8(r.u8(AR::STANCE)?).ok_or(BAD_ACCOUNT)?),
        retreat_bps: (retreat != 0).then_some(retreat as Bps),
        dealt_bps: bps(r.u16(AR::DEALT)?),
    })
}

/// The owned parts of one clash's `ClashInput`, with where each part
/// came from.
pub struct Built {
    pub coord: ProvinceCoord,
    pub bell: u32,
    pub terrain: ProvinceTerrain,
    pub residents: Vec<Fighter>,
    /// Entry index of each resident.
    pub res_entry: Vec<u8>,
    pub garrisons: Vec<Garrison>,
    /// Site of each garrison ([`CAMP_SITE`] for the camp).
    pub gar_site: Vec<u8>,
    pub arrivals: Vec<Fighter>,
    /// ClashInputs position of each arrival.
    pub arr_pos: Vec<u8>,
    pub occupancy: Occupancy,
    pub relations: Relations,
    /// The camp this clash sees (after the day's check).
    pub camp: Camp,
    /// `Some(spawned)` when the day's check ran for this bell.
    pub camp_checked: Option<bool>,
}

impl Built {
    pub fn input(&self, seed: &[u8; 32]) -> ClashInput<'_> {
        ClashInput {
            province: self.coord,
            bell: self.bell,
            seed: *seed,
            terrain: &self.terrain,
            residents: &self.residents,
            garrisons: &self.garrisons,
            arrivals: &self.arrivals,
            relations: self.relations,
            occupancy: self.occupancy,
        }
    }
}

/// Builds the clash of bell `b` from the Province before the resolve
/// (or skip) and, for a resolve, the gathered ClashInputs (module note
/// of `proc::clash`). A kernel refusal of a stored value (an unsettled
/// change of an earlier bell) is `Kernel` with a sub-code.
pub fn build(pd: &[u8], inputs: Option<&[u8]>, b: u32) -> R<Built> {
    build_probed::<NoProbe>(pd, inputs, b)
}

/// [`build`] with the caller's checkpoints (the program's heap trace).
pub fn build_probed<Pr: Probe>(pd: &[u8], inputs: Option<&[u8]>, b: u32) -> R<Built> {
    let coord = coord_of(pd)?;
    let terrain = terrain_of(pd)?;
    Pr::checkpoint(0x6130);
    let (camp, camp_checked) = match camp_check(pd, &terrain, b)? {
        Some((c, spawned)) => (c, Some(spawned)),
        None => (Camp::read(pd)?, None),
    };
    let r = Ro(pd);
    // The roster in id order (the kernel sorts its hosts by id: a
    // sorted input makes that a merge, and the write-back walks the
    // outcome in step).
    let mut order = [(0u64, 0u8); P::ROSTER_CAP];
    let mut n = 0usize;
    let mut pending = [0u8; FACTION_LIMIT as usize];
    let mut used = 0u8;
    for i in 0..P::ENTRIES_N {
        let e = ent(pd, i)?;
        match e[E::STATE] {
            E::STATE_FREE => continue,
            E::STATE_ROSTER => used += 1,
            E::STATE_MUSTER_PENDING => {
                used += 1;
                let c = pending.get_mut(e[E::FACTION] as usize).ok_or(BAD_ACCOUNT)?;
                *c = c.saturating_add(1);
                continue;
            }
            E::STATE_DEPARTED => {
                used += 1;
                continue;
            }
            _ => return Err(BAD_ACCOUNT),
        }
        if g32(e, E::FROM_BELL) > b {
            continue;
        }
        let slot = order.get_mut(n).ok_or_else(|| kernel(sub::CLASH_INPUT))?;
        *slot = (g64(e, E::ID), i as u8);
        n += 1;
    }
    Pr::checkpoint(0x6140);
    let order = &mut order[..n];
    insertion_sort(order);
    Pr::checkpoint(0x6141);
    let mut residents = Vec::with_capacity(n);
    let mut res_entry = Vec::with_capacity(n);
    for &(id, i) in order.iter() {
        let e = ent(pd, i as usize)?;
        // `Host::values_at(b)`: a kernel change of an earlier bell
        // must have been settled.
        if kernel_op(e[E::PEND_OP]) && b > g32(e, E::PEND_BELL) {
            return Err(kernel(sub::UNSETTLED));
        }
        let stamina = Stamina {
            value: g16(e, E::STAMINA_VALUE),
            bell: g32(e, E::STAMINA_BELL),
        }
        .at(b);
        residents.push(Fighter {
            id,
            faction: e[E::FACTION],
            unit: unit_from_u8(e[E::UNIT]).ok_or(BAD_ACCOUNT)?,
            troops: g32(e, E::TROOPS),
            stamina,
            tile: e[E::TILE],
            posture: Posture::Stance(Stance::Hold),
            retreat_bps: None,
            dealt_bps: bps(g16(e, E::DEALT_BPS)),
        });
        res_entry.push(i);
    }
    let occupancy = Occupancy {
        pending,
        storage_free: Occupancy::STORAGE.saturating_sub(used),
    };
    Pr::checkpoint(0x6131);
    let n_sites = (terrain.site_count as usize).min(P::SITES_N);
    let mut garrisons = Vec::with_capacity(MAX_GARRISONS);
    let mut gar_site = Vec::with_capacity(MAX_GARRISONS);
    // The holding key of site s, generation g: this base | s << 40 | g << 32.
    let key_base = mk_host_id(coord.p, coord.q, 0, 0, 0).ok_or(BAD_ACCOUNT)?;
    for s in 0..n_sites {
        let m = mirror(pd, s)?;
        if m[SM::STATE] != SM::STATE_HOLDING {
            continue;
        }
        // `GarrisonState::at(b)`: a change of an earlier bell must have
        // been settled.
        for (pb, pd_) in [
            (SM::PEND0_BELL, SM::PEND0_DELTA),
            (SM::PEND1_BELL, SM::PEND1_DELTA),
        ] {
            let bell = m32(m, pb);
            if bell != SM::NO_BELL && m64(m, pd_) != 0 && bell < b {
                return Err(kernel(sub::UNSETTLED));
            }
        }
        let walls = m32(m, SM::WALLS_COMMITTED) > 0
            || (m32(m, SM::WALL_ITEM0_DELTA) > 0 && m32(m, SM::WALL_ITEM0_BELL) <= b)
            || (m32(m, SM::WALL_ITEM1_DELTA) > 0 && m32(m, SM::WALL_ITEM1_BELL) <= b);
        garrisons.push(Garrison {
            id: key_base | (s as u64) << 40 | (m[SM::GEN] as u64) << 32,
            faction: m[SM::FACTION],
            tile: terrain.sites[s],
            troops: m32(m, SM::GARRISON).min(MAX_HOST_TROOPS),
            walls,
            posture: Posture::Stance(Stance::Hold),
        });
        gar_site.push(s as u8);
    }
    if camp.present() && garrisons.len() < MAX_GARRISONS {
        let troops = (camp.troops as u64 * MILLI as u64).min(MAX_HOST_TROOPS as u64);
        garrisons.push(Garrison {
            id: camp.id(),
            faction: NEUTRAL,
            tile: camp.tile,
            troops: troops as MilliTroops,
            walls: false,
            posture: Posture::Stance(Stance::Hold),
        });
        gar_site.push(CAMP_SITE);
    }
    Pr::checkpoint(0x6132);
    let mut arrivals = Vec::with_capacity(kc::MAX_ARRIVALS);
    let mut arr_pos = Vec::with_capacity(kc::MAX_ARRIVALS);
    if let Some(ci) = inputs {
        let recs = ci.get(ARRIVALS_BLOCK).ok_or(BAD_ACCOUNT)?;
        let mut order = [(0u64, 0u8); CI::POSITIONS];
        let mut n = 0usize;
        for (k, rec) in recs.chunks_exact(AR::SIZE).enumerate() {
            if rec[AR::PRESENT] == 1 {
                let id = u64::from_le_bytes(
                    rec[AR::HOST_ID..AR::HOST_ID + 8]
                        .try_into()
                        .map_err(|_| BAD_ACCOUNT)?,
                );
                order[n] = (id, k as u8);
                n += 1;
            }
        }
        let order = &mut order[..n];
        insertion_sort(order);
        for &(_, k) in order.iter() {
            let o = k as usize * AR::SIZE;
            arrivals.push(arrival_fighter(&recs[o..o + AR::SIZE])?);
            arr_pos.push(k);
        }
    }
    Ok(Built {
        coord,
        bell: b,
        terrain,
        residents,
        res_entry,
        garrisons,
        gar_site,
        arrivals,
        arr_pos,
        occupancy,
        relations: Relations {
            peaceful: r.u64(P::RELATIONS)?,
        },
        camp,
        camp_checked,
    })
}

/// What a resolve wrote besides the Province.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Applied {
    /// Fate code per ClashInputs position (0 none).
    pub fates: [u8; CI::POSITIONS],
    pub troops_after: [u32; CI::POSITIONS],
    /// Positions that took the camp.
    pub camp_mask: u32,
    /// Whether the camp was cleared by this clash.
    pub camp_cleared: bool,
    pub destroyed: u8,
    pub bounced: u8,
    /// An entry, a garrison or the camp changed.
    pub changed: bool,
}

/// Fate codes of the arrival record (§5.3).
pub const fn fate_code(f: &Fate) -> u8 {
    match f {
        Fate::Stays { .. } => AR::FATE_STAYS,
        Fate::Withdrew { .. } => AR::FATE_WITHDREW,
        Fate::Bounced => AR::FATE_BOUNCED,
        Fate::Retreated => AR::FATE_RETREATED,
        Fate::Destroyed => AR::FATE_DESTROYED,
    }
}

fn fate_tile(f: &Fate) -> Option<u8> {
    match f {
        Fate::Stays { tile } | Fate::Withdrew { tile } => Some(*tile),
        _ => None,
    }
}

/// Writes the outcome back into the Province (module note of
/// `proc::clash`); the camp's daily check lands first.
pub fn apply(pd: &mut [u8], b: &Built, out: &ClashOutcome) -> R<Applied> {
    apply_probed::<NoProbe>(pd, b, out)
}

/// [`apply`] with the caller's checkpoints (the program's heap trace).
pub fn apply_probed<Pr: Probe>(pd: &mut [u8], b: &Built, out: &ClashOutcome) -> R<Applied> {
    let bell = b.bell;
    let mut ap = Applied {
        fates: [0; CI::POSITIONS],
        troops_after: [0; CI::POSITIONS],
        camp_mask: 0,
        camp_cleared: false,
        destroyed: 0,
        bounced: 0,
        changed: false,
    };
    let mut camp = b.camp;
    if b.camp_checked == Some(true) {
        ap.changed = true;
    }
    // Residents (fixed-offset writes of what `Host::apply_clash` and
    // the entry codec would write; an unchanged resident is not
    // rewritten, so its lazy stamina clock stays as it was).
    // The outcome lists the fighters by id, as `build` lists them.
    let mut res_out = out.fighters.iter().filter(|x| !x.arrival);
    for (f, &i) in b.residents.iter().zip(&b.res_entry) {
        let fr = res_out.next().filter(|x| x.id == f.id).ok_or(BAD_ACCOUNT)?;
        let i = i as usize;
        let e = ent_mut(pd, i)?;
        let op = e[E::PEND_OP];
        let tile = fate_tile(&fr.fate);
        match fr.fate {
            Fate::Destroyed => {
                ap.destroyed = ap.destroyed.saturating_add(1);
                let keeps = op == E::OP_SPEND || op == E::OP_LEAVE || op == E::OP_FORFEIT;
                if !keeps {
                    e.fill(0);
                    ap.changed = true;
                    continue;
                }
            }
            Fate::Bounced | Fate::Retreated => {
                ap.bounced = ap.bounced.saturating_add(1);
                if op == E::OP_NONE {
                    e[E::PEND_OP] = E::OP_LEAVE;
                    p32(e, E::PEND_BELL, bell);
                    ap.changed = true;
                }
            }
            Fate::Stays { .. } | Fate::Withdrew { .. } => {}
        }
        let same = fr.troops == f.troops
            && fr.stamina == f.stamina
            && !fr.engaged
            && tile.is_none_or(|t| t == e[E::TILE]);
        if same {
            continue;
        }
        // `Stamina::set(bell, v)` refuses a clock ahead of the bell.
        if g32(e, E::STAMINA_BELL) > bell {
            return Err(kernel(sub::UNSETTLED));
        }
        p32(e, E::TROOPS, fr.troops);
        p16(e, E::STAMINA_VALUE, fr.stamina.min(kh::STAMINA_CAP));
        p32(e, E::STAMINA_BELL, bell);
        if fr.engaged {
            let rb = g32(e, E::READY_BELL).max(kc::ready_bell_after(bell));
            p32(e, E::READY_BELL, rb);
        }
        if let Some(t) = tile {
            e[E::TILE] = t;
        }
        ap.changed = true;
    }
    Pr::checkpoint(0x6120);
    // Arrivals.
    let mut free = 0usize;
    let mut arr_out = out.fighters.iter().filter(|x| x.arrival);
    for (f, &k) in b.arrivals.iter().zip(&b.arr_pos) {
        let fr = arr_out.next().filter(|x| x.id == f.id).ok_or(BAD_ACCOUNT)?;
        let k = k as usize;
        ap.fates[k] = fate_code(&fr.fate);
        ap.troops_after[k] = fr.troops;
        match fr.fate {
            Fate::Destroyed => ap.destroyed = ap.destroyed.saturating_add(1),
            Fate::Bounced | Fate::Retreated => ap.bounced = ap.bounced.saturating_add(1),
            Fate::Stays { tile } | Fate::Withdrew { tile } => {
                while free < P::ENTRIES_N && ent(pd, free)?[E::STATE] != E::STATE_FREE {
                    free += 1;
                }
                if free >= P::ENTRIES_N {
                    // The room of I-43 makes this unreachable.
                    return Err(kernel(sub::CLASH_INPUT));
                }
                let dealt = of_faction(f.faction)
                    .ok_or(BAD_ACCOUNT)?
                    .dealt_bps(Posture::Stance(Stance::Hold), false);
                let e = Entry {
                    id: f.id,
                    faction: f.faction,
                    unit: crate::entry::unit_to_u8(f.unit),
                    tile,
                    state: E::STATE_ROSTER,
                    troops: fr.troops,
                    stamina_value: fr.stamina,
                    dealt_bps: u16::try_from(dealt).map_err(|_| OVERFLOW)?,
                    stamina_bell: bell,
                    ready_bell: if fr.engaged {
                        kc::ready_bell_after(bell)
                    } else {
                        bell.checked_add(1).ok_or(OVERFLOW)?
                    },
                    from_bell: bell.checked_add(1).ok_or(OVERFLOW)?,
                    pend_bell: 0,
                    op: EntryOp::None,
                };
                write_entry(pd, free, &e).map_err(|_| BAD_ACCOUNT)?;
                ap.changed = true;
            }
        }
    }
    Pr::checkpoint(0x6121);
    // Garrisons and the camp.
    for (g, &s) in b.garrisons.iter().zip(&b.gar_site) {
        let gr = out
            .garrisons
            .iter()
            .find(|x| x.id == g.id)
            .ok_or(BAD_ACCOUNT)?;
        if s == CAMP_SITE {
            let whole = gr.troops / MILLI as u32;
            if whole == 0 || gr.attackers_hold {
                for (f, &k) in b.arrivals.iter().zip(&b.arr_pos) {
                    let fr = out.fighter(f.id).ok_or(BAD_ACCOUNT)?;
                    let on = matches!(fr.fate, Fate::Stays { tile } if tile == camp.tile);
                    if on && gr.holders & (1 << f.faction) != 0 {
                        ap.camp_mask |= 1 << k;
                    }
                }
                camp.state = CP::STATE_NONE;
                camp.troops = 0;
                ap.camp_cleared = true;
                ap.changed = true;
            } else if whole != camp.troops {
                camp.troops = whole;
                ap.changed = true;
            }
            continue;
        }
        if gr.troops != g.troops {
            let mut st = garrison_of(pd, s as usize)?;
            st.apply_clash(bell, gr.troops)
                .map_err(|_| kernel(sub::UNSETTLED))?;
            put_garrison(pd, s as usize, &st)?;
            ap.changed = true;
        }
    }
    if b.camp_checked.is_some() || camp != b.camp {
        camp.write(pd)?;
    }
    Ok(ap)
}

/// Settles the pending changes of bell `b` (module note of
/// `proc::clash`); `true` when anything changed.
pub fn settle_bell(pd: &mut [u8], b: u32) -> R<bool> {
    let rn = b.checked_add(1).ok_or(OVERFLOW)?;
    let mut changed = false;
    for i in 0..P::ENTRIES_N {
        let e = ent_mut(pd, i)?;
        let st = e[E::STATE];
        if st == E::STATE_FREE || st == E::STATE_DEPARTED {
            continue;
        }
        let op = e[E::PEND_OP];
        let due = op != E::OP_NONE && g32(e, E::PEND_BELL) <= b;
        if due && op == E::OP_FORFEIT {
            e.fill(0);
            changed = true;
            continue;
        }
        if st == E::STATE_MUSTER_PENDING {
            if g32(e, E::FROM_BELL) <= rn {
                e[E::STATE] = E::STATE_ROSTER;
                changed = true;
            }
            continue;
        }
        if !due {
            continue;
        }
        match op {
            E::OP_LEAVE => e[E::STATE] = E::STATE_DEPARTED,
            E::OP_SPEND => {
                // `Host::settle`: the march stamina is paid at the
                // effective bell, the change cleared.
                let pb = g32(e, E::PEND_BELL);
                let eff = pb.saturating_add(1);
                let sb = g32(e, E::STAMINA_BELL);
                if sb > eff {
                    return Err(kernel(sub::SETTLE));
                }
                let cost = g16(e, E::OP_B);
                let v = Stamina {
                    value: g16(e, E::STAMINA_VALUE),
                    bell: sb,
                }
                .at(eff)
                .saturating_sub(cost);
                p16(e, E::STAMINA_VALUE, v);
                p32(e, E::STAMINA_BELL, eff);
                e[E::PEND_BELL..E::SIZE].fill(0);
                e[E::STATE] = E::STATE_DEPARTED;
            }
            E::OP_ABSORBED_INTO => continue,
            _ => {
                settle_kernel(pd, i, rn)?;
            }
        }
        changed = true;
    }
    let n = (Ro(pd).u8(P::SITE_COUNT)? as usize).min(P::SITES_N);
    for s in 0..n {
        let m = mirror(pd, s)?;
        let due = |pb: usize, dl: usize| {
            let bell = m32(m, pb);
            bell != SM::NO_BELL && bell <= b && m64(m, dl) != 0
        };
        if m[SM::STATE] != SM::STATE_HOLDING
            || !(due(SM::PEND0_BELL, SM::PEND0_DELTA) || due(SM::PEND1_BELL, SM::PEND1_DELTA))
        {
            continue;
        }
        let g0 = garrison_of(pd, s)?;
        if g0.pending.iter().flatten().any(|(pb, _)| *pb <= b) {
            let mut g = g0;
            g.settle(rn);
            put_garrison(pd, s, &g)?;
            changed = true;
        }
    }
    Ok(changed)
}

/// The settle of a split or a merge (no M1 instruction issues one; the
/// entry codec keeps their encoding): the kernel's `Host::settle` and
/// `settle_merge`.
fn settle_kernel(pd: &mut [u8], i: usize, rn: u32) -> R<()> {
    let mut e = read_entry(pd, i).map_err(|_| BAD_ACCOUNT)?;
    match e.op {
        EntryOp::Split { .. } => {
            let mut h = e.to_host().map_err(|_| BAD_ACCOUNT)?;
            let part = h.settle(rn).map_err(|_| kernel(sub::SETTLE))?;
            let slot =
                (0..P::ENTRIES_N).find(|&j| ent(pd, j).map(|x| x[E::STATE]) == Ok(E::STATE_FREE));
            match (part, slot) {
                (Some(nh), Some(j)) => {
                    let ne = Entry::from_host(&nh, e.tile, E::STATE_ROSTER, e.dealt_bps, rn);
                    write_entry(pd, j, &ne).map_err(|_| BAD_ACCOUNT)?;
                }
                // No room: the part stays with its parent.
                (Some(nh), None) => h.troops = h.troops.saturating_add(nh.troops),
                _ => {}
            }
            e.set_host(&h);
        }
        EntryOp::Absorb { from } => {
            let j = crate::entry::find_entry(pd, from).ok_or(BAD_ACCOUNT)?;
            let other = read_entry(pd, j).map_err(|_| BAD_ACCOUNT)?;
            let mut hi = e.to_host().map_err(|_| BAD_ACCOUNT)?;
            let mut hf = other.to_host().map_err(|_| BAD_ACCOUNT)?;
            settle_merge(&mut hi, &mut hf, rn).map_err(|_| kernel(sub::SETTLE))?;
            e.set_host(&hi);
            write_entry(pd, j, &Entry::FREE).map_err(|_| BAD_ACCOUNT)?;
        }
        _ => return Ok(()),
    }
    write_entry(pd, i, &e).map_err(|_| BAD_ACCOUNT)
}

/// The first bell whose settle changes something (`u32::MAX` if none):
/// a muster joining (`from_bell − 1`), a pending change (`pend_bell`),
/// a garrison change (its bell). SkipQuiet settles only from there.
pub fn next_due(pd: &[u8]) -> R<u32> {
    let mut due = u32::MAX;
    let block = pd
        .get(P::ENTRIES..P::ENTRIES + P::ENTRIES_N * E::SIZE)
        .ok_or(BAD_ACCOUNT)?;
    for e in block.chunks_exact(E::SIZE) {
        let st = e[E::STATE];
        if st != E::STATE_ROSTER && st != E::STATE_MUSTER_PENDING {
            continue;
        }
        let rd = |o: usize| u32::from_le_bytes([e[o], e[o + 1], e[o + 2], e[o + 3]]);
        if st == E::STATE_MUSTER_PENDING {
            due = due.min(rd(E::FROM_BELL).saturating_sub(1));
        }
        if e[E::PEND_OP] != E::OP_NONE {
            due = due.min(rd(E::PEND_BELL));
        }
    }
    let n = (Ro(pd).u8(P::SITE_COUNT)? as usize).min(P::SITES_N);
    for s in 0..n {
        let m = mirror(pd, s)?;
        if m[SM::STATE] != SM::STATE_HOLDING {
            continue;
        }
        for (pb, dl) in [
            (SM::PEND0_BELL, SM::PEND0_DELTA),
            (SM::PEND1_BELL, SM::PEND1_DELTA),
        ] {
            if m64(m, dl) != 0 {
                due = due.min(m32(m, pb));
            }
        }
    }
    Ok(due)
}

/// A roster whose clash at bell `b` is quiet for a reason the kernel
/// need not be asked about: every occupied hex holds one faction's
/// residents (at most `HEX_HOST_CAP`), its garrison of the same
/// faction or none, and no camp shares a hex with anyone; every faction
/// within 8 residents and the province within 48. Such a clash has no
/// engagement, no fair-share or cap bounce and no withdrawal, so
/// `clash::is_quiet` holds (host test
/// `trivially_quiet_rosters_are_quiet`); `false` means "ask the
/// kernel". Garrison changes or host changes of an earlier bell still
/// pending also answer `false` (the kernel refuses them).
pub fn trivially_quiet(pd: &[u8], b: u32) -> R<bool> {
    const NONE: u8 = 0xFF;
    let mut fac = [NONE; PROVINCE_TILES];
    let mut hosts = [0u8; PROVINCE_TILES];
    let mut per_f = [0u8; FACTION_LIMIT as usize];
    let mut total = 0usize;
    let block = pd
        .get(P::ENTRIES..P::ENTRIES + P::ENTRIES_N * E::SIZE)
        .ok_or(BAD_ACCOUNT)?;
    for e in block.chunks_exact(E::SIZE) {
        if e[E::STATE] != E::STATE_ROSTER {
            continue;
        }
        let rd = |o: usize| u32::from_le_bytes([e[o], e[o + 1], e[o + 2], e[o + 3]]);
        if rd(E::FROM_BELL) > b {
            continue;
        }
        if kernel_op(e[E::PEND_OP]) && b > rd(E::PEND_BELL) {
            return Ok(false);
        }
        let (t, f) = (e[E::TILE] as usize, e[E::FACTION]);
        if t >= PROVINCE_TILES || f >= NEUTRAL {
            return Ok(false);
        }
        if fac[t] == NONE {
            fac[t] = f;
        } else if fac[t] != f {
            return Ok(false);
        }
        hosts[t] += 1;
        per_f[f as usize] += 1;
        total += 1;
        if hosts[t] as usize > kh::HEX_HOST_CAP
            || per_f[f as usize] as usize > kh::FACTION_RESIDENT_CAP
            || total > kh::PROVINCE_HOST_CAP
        {
            return Ok(false);
        }
    }
    let r = Ro(pd);
    let n = (r.u8(P::SITE_COUNT)? as usize).min(P::SITES_N);
    let sites: [u8; P::SITES_N] = r.arr(P::SITES)?;
    let mut n_gar = 0usize;
    for (s, &tile) in sites.iter().enumerate().take(n) {
        let m = mirror(pd, s)?;
        if m[SM::STATE] != SM::STATE_HOLDING {
            continue;
        }
        n_gar += 1;
        for (pb, dl) in [
            (SM::PEND0_BELL, SM::PEND0_DELTA),
            (SM::PEND1_BELL, SM::PEND1_DELTA),
        ] {
            let bell = m32(m, pb);
            if bell != SM::NO_BELL && m64(m, dl) != 0 && bell < b {
                return Ok(false);
            }
        }
        let t = tile as usize;
        if t >= PROVINCE_TILES {
            return Ok(false);
        }
        let f = m[SM::FACTION];
        if fac[t] != NONE && fac[t] != f {
            return Ok(false);
        }
        fac[t] = f;
    }
    let camp = Camp::read(pd)?;
    if camp.present() && n_gar < MAX_GARRISONS {
        let t = camp.tile as usize;
        if t >= PROVINCE_TILES || fac[t] != NONE {
            return Ok(false);
        }
    }
    Ok(true)
}

/// Closes bell `b` in the Province: `resolved_next = b + 1`; when
/// anything changed, `roster_epoch += 1` and `n_entries` recounted.
pub fn finish_bell(pd: &mut [u8], b: u32, changed: bool) -> R<()> {
    let mut w = Rw(pd);
    w.set_u32(P::RESOLVED_NEXT, b.checked_add(1).ok_or(OVERFLOW)?)?;
    if changed {
        let e = w.u32(P::ROSTER_EPOCH)?.wrapping_add(1);
        w.set_u32(P::ROSTER_EPOCH, e)?;
        let block =
            w.0.get(P::ENTRIES..P::ENTRIES + P::ENTRIES_N * E::SIZE)
                .ok_or(BAD_ACCOUNT)?;
        let n = block
            .chunks_exact(E::SIZE)
            .filter(|e| e[E::STATE] != E::STATE_FREE)
            .count();
        w.set_u8(P::N_ENTRIES, n as u8)?;
    }
    Ok(())
}

/// The stamina an arrival brings (module note): the transit's
/// `stamina_after` refilled from `depart_bell + 1` to the arrival bell.
pub fn arrival_stamina(stamina_after: u16, depart_bell: u32, arrive: u32) -> u16 {
    Stamina {
        value: stamina_after,
        bell: depart_bell.saturating_add(1),
    }
    .at(arrive)
}

/// Most bytes of a borsh-encoded `ClashOutcome` (72 fighters, 12
/// garrisons).
pub const OUTCOME_MAX: usize = 8 + 4 + 4 + 72 * 18 + 4 + 12 * 15 + 4;

/// `ClashOutcome::digest` (`sha256("frontier/clash-outcome" ‖
/// borsh(outcome))`), encoded into a stack buffer instead of a growing
/// `Vec` (host test `outcome_digest_is_the_kernels`).
pub fn outcome_digest(out: &ClashOutcome) -> R<[u8; 32]> {
    let mut buf = [0u8; OUTCOME_MAX];
    let mut n = 0usize;
    let mut put = |b: &[u8]| -> R<()> {
        let d = buf.get_mut(n..n + b.len()).ok_or(OVERFLOW)?;
        d.copy_from_slice(b);
        n += b.len();
        Ok(())
    };
    put(&out.province.p.to_le_bytes())?;
    put(&out.province.q.to_le_bytes())?;
    put(&out.bell.to_le_bytes())?;
    put(&(out.fighters.len() as u32).to_le_bytes())?;
    for f in &out.fighters {
        put(&f.id.to_le_bytes())?;
        put(&[f.arrival as u8])?;
        put(&f.troops.to_le_bytes())?;
        put(&f.stamina.to_le_bytes())?;
        match f.fate {
            Fate::Stays { tile } => put(&[0, tile])?,
            Fate::Withdrew { tile } => put(&[1, tile])?,
            Fate::Bounced => put(&[2])?,
            Fate::Retreated => put(&[3])?,
            Fate::Destroyed => put(&[4])?,
        }
        put(&[f.engaged as u8])?;
    }
    put(&(out.garrisons.len() as u32).to_le_bytes())?;
    for g in &out.garrisons {
        put(&g.id.to_le_bytes())?;
        put(&g.troops.to_le_bytes())?;
        put(&[g.attackers_hold as u8, g.holders, g.defender_present as u8])?;
    }
    put(&out.engagements.to_le_bytes())?;
    Ok(sha256(&[b"frontier/clash-outcome", &buf[..n]]))
}

/// CLASH's input digest (module note).
pub fn input_digest(pd: &[u8], ci: &[u8], b: u32, seed: &[u8; 32]) -> R<[u8; 32]> {
    let st = pd.get(STATE_BLOCK).ok_or(BAD_ACCOUNT)?;
    let ar = ci.get(ARRIVALS_BLOCK).ok_or(BAD_ACCOUNT)?;
    Ok(sha256(&[INPUT_DOMAIN, &b.to_le_bytes(), seed, st, ar]))
}

/// SKIP's quiet digest (module note).
pub fn quiet_digest(pd: &[u8], b0: u32, n: u8) -> R<[u8; 32]> {
    let st = pd.get(STATE_BLOCK).ok_or(BAD_ACCOUNT)?;
    Ok(sha256(&[QUIET_DOMAIN, &b0.to_le_bytes(), &[n], st]))
}

/// The kernel's host of an entry, for tests and the settle.
pub fn host_of(e: &Entry) -> R<Host> {
    e.to_host().map_err(|_| BAD_ACCOUNT)
}

// ================================================================ ABI v2
//
// MC contract §5.6 (0x61, 0x63), §5.7, K-21: the clash of an MC Province
// (4,736 B). Beside the v1 functions above, which are unchanged: a v2
// Province's first 4,096 bytes are M1's, so `settle_bell`, `next_due`,
// `finish_bell` and the entry and mirror helpers serve both. What v2 adds:
//
// - **Free City garrisons** (site state 5, faction NEUTRAL, walls from the
//   mirror: 0 at genesis) beside the holdings', in site order;
// - the camp joins only while fewer than 12 *site* garrisons stand
//   (holdings and Free Cities), exactly as M1, and never on the keep tile
//   (camp v2);
// - **the keep** as the 13th garrison (id `u64::MAX − 0x1_0000 − gen`,
//   the holder's, walls on), pushed last;
// - CLASH's input digest over `province[SITE_MIRROR..TICKET_COHORTS] ‖
//   province[4,096..4,736]` (`PSF-CLASH-INPUT-v2`), SKIP's quiet digest
//   with the conquest block (`PSF-QUIET-v2`);
// - the skip's **tile-mask quiet model** ([`tile_masks`]): the per-tile
//   faction mask of non-civilian residents the conquest step reads in a
//   quiet bell instead of a clash outcome.
//
// [`BuiltV2::base`] lists the keep in `garrisons` but not in `gar_site`,
// so v1's [`apply`] (which walks `garrisons.zip(gar_site)`) writes back
// every site and the camp and [`apply_v2`] then writes the keep.
//
// **S1 caravans (stage 1c, `S1-1B-CONTRACT.md` §3.5).** Each live caravan
// slot standing in the Province at the bell's start (`CaravanSlot::
// tile_at(b)`) joins as a **0-troop garrison** of its faction on its tile,
// Hold, after the sites and the camp and before the keep, in slot order,
// while fewer than `MAX_GARRISONS` garrisons stand (so the worst case
// stays 12 plus the keep). A 0-troop garrison never fights; its escort is
// whoever of its faction stands on the tile (residents, J1, or arrivals).
// A caravan on a tile another garrison already holds (a site, the camp,
// the keep or an earlier caravan) is sheltered there and does not join:
// garrisons never share a tile. It is **raided** when the kernel reports
// `attackers_hold` for it; the slot then records the bell offset, the
// raider (the lowest id among the non-scout hosts of the holding factions
// that stay on the tile; a resident or an arrival) and the raider's
// ClashInputs position (0xFF for a resident). Slots are zero in an MC
// Province, so MC clashes and digests are unchanged: the digests append
// the slots only when one is in use.

use crate::v2::kernel::{camp2, keep as kkeep};
use crate::v2::layout::province::{caravan_slot as CS, province as P2, site as SM2};
use permutation_rules::frontier::caravan::{CaravanSlot, MAX_CARAVAN_SLOTS};

/// Domain of the caravan slots appended to the S1 digests.
pub const CARAVAN_DOMAIN: &[u8] = b"PSF-CARAVAN-v1";
/// `RAID_POS` of a raid by a resident (no ClashInputs position).
pub const RAID_POS_RESIDENT: u8 = 0xFF;
/// `RAID_POS` of a raid opened by RaidDomestic (S1 1e, decision K4): a
/// host of the caravan's own faction stood on its tile; never a clash's.
pub const RAID_POS_DOMESTIC: u8 = 0xFE;

/// The caravan slots of a v2 Province.
pub fn caravan_slots(pd: &[u8]) -> R<[CaravanSlot; MAX_CARAVAN_SLOTS]> {
    let mut out = [CaravanSlot::default(); MAX_CARAVAN_SLOTS];
    for (i, o) in out.iter_mut().enumerate() {
        *o = pd
            .get(CS::at(i)..CS::at(i) + CS::SIZE)
            .and_then(CaravanSlot::decode)
            .ok_or(BAD_ACCOUNT)?;
    }
    Ok(out)
}

/// The caravan slot block's bytes when a slot is in use (the S1 digests'
/// suffix), else `None`.
fn caravan_block(pd: &[u8]) -> R<Option<&[u8]>> {
    let b = pd
        .get(CS::at(0)..CS::at(0) + MAX_CARAVAN_SLOTS * CS::SIZE)
        .ok_or(BAD_ACCOUNT)?;
    let used = caravan_slots(pd)?.iter().any(|s| s.id != 0);
    Ok(used.then_some(b))
}

/// A caravan as the clash of one bell sees it: its slot index and its
/// garrison.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CaravanIn {
    pub slot: u8,
    pub id: u64,
    pub faction: u8,
    pub tile: u8,
}

/// Domain of CLASH's input digest under ABI v2.
pub const INPUT_DOMAIN_V2: &[u8] = b"PSF-CLASH-INPUT-v2";
/// Domain of SKIP's quiet digest under ABI v2.
pub const QUIET_DOMAIN_V2: &[u8] = b"PSF-QUIET-v2";

/// A fort as the clash of one bell sees it (S1 1e, `S1-1E-CONTRACT` §2.6):
/// its record index and garrison, its troops at the bell (milli, the
/// pending troops folded when due) and whether that fold happened.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FortIn {
    pub idx: u8,
    pub id: u64,
    pub faction: u8,
    pub tile: u8,
    pub troops: u32,
    pub folded: bool,
}

/// The site field of a fort's garrison id: 12 + its record index (a value
/// no host id carries, so it never collides with a site's or a host's).
pub const FORT_ID_SITE_BASE: u64 = 12;

/// A live fort's record at one bell (see [`forts_at`]).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FortAt {
    pub idx: u8,
    pub tile: u8,
    pub faction: u8,
    pub gen: u8,
    /// Milli-troops, the due pending part folded.
    pub troops: u32,
    /// The pending part was due and is counted in `troops`.
    pub folded: bool,
}

/// The live forts of a v2 Province at bell `b` with their effective troops
/// (`troops + pend × 1,000` once `pend_bell ≤ b`). An MC Province's block
/// is zero (none).
pub fn forts_at(pd: &[u8], b: u32) -> R<Vec<FortAt>> {
    use crate::v2::layout::province::fort_record as FR;
    let mut out = Vec::new();
    for i in 0..FR::N {
        let o = FR::at(i);
        let r = pd.get(o..o + FR::SIZE).ok_or(BAD_ACCOUNT)?;
        if r[FR::STATE] != FR::STATE_LIVE {
            continue;
        }
        let u32_at = |k: usize| u32::from_le_bytes([r[k], r[k + 1], r[k + 2], r[k + 3]]);
        let (troops, pend_bell) = (u32_at(FR::TROOPS), u32_at(FR::PEND_BELL));
        let pend = u16::from_le_bytes([r[FR::PEND], r[FR::PEND + 1]]) as u32;
        let folded = pend > 0 && pend_bell <= b;
        let eff = if folded {
            troops
                .checked_add(pend.checked_mul(MILLI as u32).ok_or(OVERFLOW)?)
                .ok_or(OVERFLOW)?
        } else {
            troops
        };
        out.push(FortAt {
            idx: i as u8,
            tile: r[FR::TILE],
            faction: r[FR::FACTION],
            gen: r[FR::GEN],
            troops: eff,
            folded,
        });
    }
    Ok(out)
}

/// The keep as the clash of one bell sees it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct KeepIn {
    pub keep: kkeep::Keep,
    /// Its garrison id (`u64::MAX − 0x1_0000 − gen`).
    pub id: u64,
}

/// [`Built`] of an MC Province: the base input (`garrisons` = the sites
/// and the camp as in `gar_site`, then the forts, then the caravans, then
/// the keep) and the forts, keep and caravans.
pub struct BuiltV2 {
    pub base: Built,
    pub keep: Option<KeepIn>,
    /// S1 1e: the manned forts in the clash (after `gar_site`).
    pub forts: Vec<FortIn>,
    /// S1: the caravans in the clash (after the forts).
    pub caravans: Vec<CaravanIn>,
}

impl BuiltV2 {
    pub fn input(&self, seed: &[u8; 32]) -> ClashInput<'_> {
        self.base.input(seed)
    }
}

/// [`Applied`] of an MC Province.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AppliedV2 {
    pub base: Applied,
    /// The keep's garrison changed in the clash.
    pub keep_changed: bool,
    /// S1: slots whose caravan was raided (bit = slot index).
    pub raided: u8,
    /// S1 1e: forts whose troops the clash changed (bit = record index).
    pub forts_changed: u8,
}

impl AppliedV2 {
    /// An entry, a garrison, the camp, the keep, a caravan or a fort
    /// changed.
    pub const fn changed(&self) -> bool {
        self.base.changed || self.keep_changed || self.raided != 0 || self.forts_changed != 0
    }
}

/// Whether a site mirror state fights as a garrison under ABI v2.
const fn v2_garrison_state(st: u8) -> bool {
    st == SM2::STATE_HOLDING || st == SM2::STATE_FREE_CITY
}

/// The faction a v2 site's garrison fights for (a Free City: NEUTRAL).
fn v2_site_faction(m: &[u8; SM::SIZE]) -> u8 {
    if m[SM2::STATE] == SM2::STATE_FREE_CITY {
        NEUTRAL
    } else {
        m[SM2::FACTION]
    }
}

/// The camp after the day's check of bell `b` under camp v2 (never on
/// the keep tile).
pub fn camp_check_v2(
    pd: &[u8],
    t: &ProvinceTerrain,
    b: u32,
    keep_tile: Option<u8>,
) -> R<Option<(Camp, bool)>> {
    let c = Camp::read(pd)?;
    let day = b / DAY_BELLS;
    if day < c.next_check_day {
        return Ok(None);
    }
    let mut n = c;
    n.next_check_day = day.checked_add(1).ok_or(OVERFLOW)?;
    let spawn = camp2::place_v2(
        &camp_seed(pd)?,
        coord_of(pd)?,
        t,
        day,
        has_holding(pd)?,
        false,
        keep_tile,
    );
    if let Some(k) = spawn {
        n.tile = k.tile;
        n.state = CP::STATE_PRESENT;
        n.troops = k.troops;
        n.gen = c.gen.wrapping_add(1);
    }
    Ok(Some((n, spawn.is_some())))
}

/// The quiet test of an MC or S1 bell over its [`build_v2`]: the kernel's
/// `is_quiet`, and (S1) no caravan in the clash with a hostile non-civilian
/// host on its tile. The kernel ignores a 0-troop garrison, but such a host
/// raids it, so the bell is not quiet: SkipQuiet must not pass it.
pub fn is_quiet_v2(built: &BuiltV2) -> Result<bool, kc::ClashError> {
    let rel = built.base.relations;
    let threatened = built.caravans.iter().any(|c| {
        built
            .base
            .residents
            .iter()
            .chain(built.base.arrivals.iter())
            .any(|f| f.tile == c.tile && !f.unit.is_civilian() && rel.hostile(f.faction, c.faction))
    });
    if threatened {
        return Ok(false);
    }
    kc::is_quiet(&kc::frontier_ruleset(), &built.input(&[0; 32]))
}

/// [`build`] for an MC Province (module note above).
pub fn build_v2(pd: &[u8], inputs: Option<&[u8]>, b: u32) -> R<BuiltV2> {
    build_v2_probed::<NoProbe>(pd, inputs, b)
}

/// [`build_v2`] with the caller's checkpoints.
pub fn build_v2_probed<Pr: Probe>(pd: &[u8], inputs: Option<&[u8]>, b: u32) -> R<BuiltV2> {
    if pd.len() < P2::SIZE {
        return Err(BAD_ACCOUNT);
    }
    let coord = coord_of(pd)?;
    let terrain = terrain_of(pd)?;
    let keep = crate::conquest_model::read_keep(pd)?;
    Pr::checkpoint(0x6130);
    let (camp, camp_checked) = match camp_check_v2(pd, &terrain, b, keep.map(|k| k.tile))? {
        Some((c, spawned)) => (c, Some(spawned)),
        None => (Camp::read(pd)?, None),
    };
    let r = Ro(pd);
    let mut order = [(0u64, 0u8); P::ROSTER_CAP];
    let mut n = 0usize;
    let mut pending = [0u8; FACTION_LIMIT as usize];
    let mut used = 0u8;
    for i in 0..P::ENTRIES_N {
        let e = ent(pd, i)?;
        match e[E::STATE] {
            E::STATE_FREE => continue,
            E::STATE_ROSTER => used += 1,
            E::STATE_MUSTER_PENDING => {
                used += 1;
                let c = pending.get_mut(e[E::FACTION] as usize).ok_or(BAD_ACCOUNT)?;
                *c = c.saturating_add(1);
                continue;
            }
            E::STATE_DEPARTED => {
                used += 1;
                continue;
            }
            _ => return Err(BAD_ACCOUNT),
        }
        if g32(e, E::FROM_BELL) > b {
            continue;
        }
        let slot = order.get_mut(n).ok_or_else(|| kernel(sub::CLASH_INPUT))?;
        *slot = (g64(e, E::ID), i as u8);
        n += 1;
    }
    let order = &mut order[..n];
    insertion_sort(order);
    let mut residents = Vec::with_capacity(n);
    let mut res_entry = Vec::with_capacity(n);
    for &(id, i) in order.iter() {
        let e = ent(pd, i as usize)?;
        if kernel_op(e[E::PEND_OP]) && b > g32(e, E::PEND_BELL) {
            return Err(kernel(sub::UNSETTLED));
        }
        let stamina = Stamina {
            value: g16(e, E::STAMINA_VALUE),
            bell: g32(e, E::STAMINA_BELL),
        }
        .at(b);
        residents.push(Fighter {
            id,
            faction: e[E::FACTION],
            unit: unit_from_u8(e[E::UNIT]).ok_or(BAD_ACCOUNT)?,
            troops: g32(e, E::TROOPS),
            stamina,
            tile: e[E::TILE],
            posture: Posture::Stance(Stance::Hold),
            retreat_bps: None,
            dealt_bps: bps(g16(e, E::DEALT_BPS)),
        });
        res_entry.push(i);
    }
    let occupancy = Occupancy {
        pending,
        storage_free: Occupancy::STORAGE.saturating_sub(used),
    };
    Pr::checkpoint(0x6131);
    let n_sites = (terrain.site_count as usize).min(P::SITES_N);
    let mut garrisons = Vec::with_capacity(crate::v2::kernel::MAX_GARRISONS_WITH_KEEP);
    let mut gar_site = Vec::with_capacity(MAX_GARRISONS);
    let key_base = mk_host_id(coord.p, coord.q, 0, 0, 0).ok_or(BAD_ACCOUNT)?;
    for s in 0..n_sites {
        let m = mirror(pd, s)?;
        if !v2_garrison_state(m[SM::STATE]) {
            continue;
        }
        for (pb, pd_) in [
            (SM::PEND0_BELL, SM::PEND0_DELTA),
            (SM::PEND1_BELL, SM::PEND1_DELTA),
        ] {
            let bell = m32(m, pb);
            if bell != SM::NO_BELL && m64(m, pd_) != 0 && bell < b {
                return Err(kernel(sub::UNSETTLED));
            }
        }
        let walls = m32(m, SM::WALLS_COMMITTED) > 0
            || (m32(m, SM::WALL_ITEM0_DELTA) > 0 && m32(m, SM::WALL_ITEM0_BELL) <= b)
            || (m32(m, SM::WALL_ITEM1_DELTA) > 0 && m32(m, SM::WALL_ITEM1_BELL) <= b);
        garrisons.push(Garrison {
            id: key_base | (s as u64) << 40 | (m[SM::GEN] as u64) << 32,
            faction: v2_site_faction(m),
            tile: terrain.sites[s],
            troops: m32(m, SM::GARRISON).min(MAX_HOST_TROOPS),
            walls,
            posture: Posture::Stance(Stance::Hold),
        });
        gar_site.push(s as u8);
    }
    if camp.present() && garrisons.len() < MAX_GARRISONS {
        let troops = (camp.troops as u64 * MILLI as u64).min(MAX_HOST_TROOPS as u64);
        garrisons.push(Garrison {
            id: camp.id(),
            faction: NEUTRAL,
            tile: camp.tile,
            troops: troops as MilliTroops,
            walls: false,
            posture: Posture::Stance(Stance::Hold),
        });
        gar_site.push(CAMP_SITE);
    }
    // S1 1e: the manned forts, after the sites and the camp, while there is
    // room (module note). A fort fights as a walled garrison of its
    // faction, every other faction on its tile (the clash has no
    // alliances, as for a site's garrison).
    let mut forts = Vec::new();
    for FortAt {
        idx,
        tile,
        faction,
        gen,
        troops,
        folded,
    } in forts_at(pd, b)?
    {
        if troops == 0 || garrisons.len() >= MAX_GARRISONS {
            continue;
        }
        let taken = garrisons.iter().any(|g| g.tile == tile)
            || keep.is_some_and(|k| k.tile == tile)
            || tile as usize >= PROVINCE_TILES;
        if taken {
            continue;
        }
        let id = key_base | (FORT_ID_SITE_BASE + idx as u64) << 40 | (gen as u64) << 32;
        garrisons.push(Garrison {
            id,
            faction,
            tile,
            troops: troops.min(MAX_HOST_TROOPS),
            walls: true,
            posture: Posture::Stance(Stance::Hold),
        });
        forts.push(FortIn {
            idx,
            id,
            faction,
            tile,
            troops: troops.min(MAX_HOST_TROOPS),
            folded,
        });
    }
    // S1: the caravans standing here at the bell's start (module note).
    let mut caravans = Vec::new();
    for (i, slot) in caravan_slots(pd)?.iter().enumerate() {
        let Some(tile) = slot.tile_at(b) else {
            continue;
        };
        if garrisons.len() >= MAX_GARRISONS {
            break;
        }
        let taken = garrisons.iter().any(|g| g.tile == tile || g.id == slot.id)
            || keep.is_some_and(|k| k.tile == tile)
            || tile as usize >= PROVINCE_TILES;
        if taken {
            continue;
        }
        garrisons.push(Garrison {
            id: slot.id,
            faction: slot.faction,
            tile,
            troops: 0,
            walls: false,
            posture: Posture::Stance(Stance::Hold),
        });
        caravans.push(CaravanIn {
            slot: i as u8,
            id: slot.id,
            faction: slot.faction,
            tile,
        });
    }
    let keep_in = match keep {
        Some(k) => {
            let g = kkeep::garrison(&k).map_err(|_| kernel(sub::CLASH_INPUT))?;
            if garrisons.iter().any(|x| x.id == g.id) {
                return Err(kernel(sub::CLASH_INPUT));
            }
            garrisons.push(g);
            Some(KeepIn { keep: k, id: g.id })
        }
        None => None,
    };
    Pr::checkpoint(0x6132);
    let mut arrivals = Vec::with_capacity(kc::MAX_ARRIVALS);
    let mut arr_pos = Vec::with_capacity(kc::MAX_ARRIVALS);
    if let Some(ci) = inputs {
        let recs = ci.get(ARRIVALS_BLOCK).ok_or(BAD_ACCOUNT)?;
        let mut order = [(0u64, 0u8); CI::POSITIONS];
        let mut n = 0usize;
        for (k, rec) in recs.chunks_exact(AR::SIZE).enumerate() {
            if rec[AR::PRESENT] == 1 {
                let id = u64::from_le_bytes(
                    rec[AR::HOST_ID..AR::HOST_ID + 8]
                        .try_into()
                        .map_err(|_| BAD_ACCOUNT)?,
                );
                order[n] = (id, k as u8);
                n += 1;
            }
        }
        let order = &mut order[..n];
        insertion_sort(order);
        for &(_, k) in order.iter() {
            let o = k as usize * AR::SIZE;
            arrivals.push(arrival_fighter(&recs[o..o + AR::SIZE])?);
            arr_pos.push(k);
        }
    }
    Ok(BuiltV2 {
        base: Built {
            coord,
            bell: b,
            terrain,
            residents,
            res_entry,
            garrisons,
            gar_site,
            arrivals,
            arr_pos,
            occupancy,
            relations: Relations {
                peaceful: r.u64(P::RELATIONS)?,
            },
            camp,
            camp_checked,
        },
        keep: keep_in,
        forts,
        caravans,
    })
}

/// Writes an MC outcome back: v1's [`apply`] for the entries, the site
/// garrisons (holdings and Free Cities) and the camp, then the keep's
/// garrison (whole troops, as the camp's).
pub fn apply_v2(pd: &mut [u8], b: &BuiltV2, out: &ClashOutcome) -> R<AppliedV2> {
    apply_v2_probed::<NoProbe>(pd, b, out)
}

/// [`apply_v2`] with the caller's checkpoints.
pub fn apply_v2_probed<Pr: Probe>(pd: &mut [u8], b: &BuiltV2, out: &ClashOutcome) -> R<AppliedV2> {
    let keep_n = b.keep.is_some() as usize;
    if b.base.gar_site.len() + b.forts.len() + b.caravans.len() + keep_n != b.base.garrisons.len() {
        return Err(BAD_ACCOUNT);
    }
    let base = apply_probed::<Pr>(pd, &b.base, out)?;
    // S1: the raids (module note).
    let mut raided = 0u8;
    for c in &b.caravans {
        let gr = out
            .garrisons
            .iter()
            .find(|x| x.id == c.id)
            .ok_or(BAD_ACCOUNT)?;
        if !gr.attackers_hold {
            continue;
        }
        let units = b.base.residents.iter().chain(b.base.arrivals.iter());
        let raider = units
            .filter(|f| {
                !f.unit.is_civilian()
                    && gr.holders & (1u8 << f.faction.min(7)) != 0
                    && out
                        .fighter(f.id)
                        .is_some_and(|r| matches!(r.fate, Fate::Stays { tile } if tile == c.tile))
            })
            .map(|f| f.id)
            .min();
        let Some(raider) = raider else {
            continue;
        };
        let pos = b
            .base
            .arrivals
            .iter()
            .zip(&b.base.arr_pos)
            .find(|(f, _)| f.id == raider)
            .map_or(RAID_POS_RESIDENT, |(_, &k)| k);
        let i = c.slot as usize;
        let o = CS::at(i);
        let mut slot = pd
            .get(o..o + CS::SIZE)
            .and_then(CaravanSlot::decode)
            .ok_or(BAD_ACCOUNT)?;
        if slot.id != c.id || b.base.bell < slot.first_bell {
            return Err(BAD_ACCOUNT);
        }
        slot.raid_off = u8::try_from(b.base.bell - slot.first_bell).map_err(|_| OVERFLOW)?;
        slot.raid_pos = pos;
        slot.raider = raider;
        slot.encode(pd.get_mut(o..o + CS::SIZE).ok_or(BAD_ACCOUNT)?)
            .ok_or(BAD_ACCOUNT)?;
        raided |= 1 << i;
    }
    // S1 1e: a fort's troops after the clash (the pending part folded into
    // them); a fort the clash left as it was keeps its record (a due
    // pending part is folded again by the next build). At 0 it has fallen.
    let mut forts_changed = 0u8;
    for f in &b.forts {
        use crate::v2::layout::province::fort_record as FR;
        let gr = out
            .garrisons
            .iter()
            .find(|x| x.id == f.id)
            .ok_or(BAD_ACCOUNT)?;
        if gr.troops == f.troops {
            continue;
        }
        let o = FR::at(f.idx as usize);
        let r = pd.get_mut(o..o + FR::SIZE).ok_or(BAD_ACCOUNT)?;
        r[FR::TROOPS..FR::TROOPS + 4].copy_from_slice(&gr.troops.to_le_bytes());
        if f.folded {
            r[FR::PEND_BELL..FR::PEND_BELL + 4].copy_from_slice(&u32::MAX.to_le_bytes());
            r[FR::PEND..FR::PEND + 2].fill(0);
        }
        forts_changed |= 1 << f.idx;
    }
    let mut keep_changed = false;
    if let Some(k) = &b.keep {
        let gr = out
            .garrisons
            .iter()
            .find(|x| x.id == k.id)
            .ok_or(BAD_ACCOUNT)?;
        let whole = gr.troops / MILLI as u32;
        if whole != k.keep.troops {
            let mut nk = k.keep;
            nk.troops = whole;
            crate::conquest_model::write_keep(pd, &nk)?;
            keep_changed = true;
        }
    }
    Ok(AppliedV2 {
        base,
        keep_changed,
        raided,
        forts_changed,
    })
}

/// The quiet model's per-tile faction mask (§5.7 Skip): bit f of
/// `mask[tile]` is set when a non-civilian roster host of faction f stands
/// on the tile in the clash of bell `b` (`from_bell ≤ b`). Read it before
/// `settle_bell(b)`, as the clash would be built.
pub fn tile_masks(pd: &[u8], b: u32) -> R<[u8; PROVINCE_TILES]> {
    Ok(tile_masks_horizon(pd, b)?.0)
}

/// [`tile_masks`] and its horizon: the first bell after `b` at which a
/// roster entry not yet counted (`from_bell > b`) would join the mask
/// (`u32::MAX` when none). The mask holds for every bell before the
/// horizon while the entries do not change (SkipQuiet's per-transaction
/// cache, §5.7).
pub fn tile_masks_horizon(pd: &[u8], b: u32) -> R<([u8; PROVINCE_TILES], u32)> {
    let mut horizon = u32::MAX;
    let mut mask = [0u8; PROVINCE_TILES];
    let block = pd
        .get(P::ENTRIES..P::ENTRIES + P::ENTRIES_N * E::SIZE)
        .ok_or(BAD_ACCOUNT)?;
    for e in block.chunks_exact(E::SIZE) {
        if e[E::STATE] != E::STATE_ROSTER {
            continue;
        }
        let from = u32::from_le_bytes([
            e[E::FROM_BELL],
            e[E::FROM_BELL + 1],
            e[E::FROM_BELL + 2],
            e[E::FROM_BELL + 3],
        ]);
        if from > b {
            horizon = horizon.min(from);
            continue;
        }
        let civilian = unit_from_u8(e[E::UNIT]).is_none_or(|u| u.is_civilian());
        let (t, f) = (e[E::TILE] as usize, e[E::FACTION]);
        if civilian || f >= NEUTRAL || t >= PROVINCE_TILES {
            continue;
        }
        mask[t] |= 1 << f;
    }
    Ok((mask, horizon))
}

/// [`trivially_quiet`] for an MC Province: Free City garrisons (NEUTRAL,
/// hostile to every resident) and the keep (its holder's) join the
/// hex-faction test; the camp counts site garrisons of both kinds.
pub fn trivially_quiet_v2(pd: &[u8], b: u32) -> R<bool> {
    const NONE: u8 = 0xFF;
    let mut fac = [NONE; PROVINCE_TILES];
    let mut hosts = [0u8; PROVINCE_TILES];
    let mut per_f = [0u8; FACTION_LIMIT as usize];
    let mut total = 0usize;
    let block = pd
        .get(P::ENTRIES..P::ENTRIES + P::ENTRIES_N * E::SIZE)
        .ok_or(BAD_ACCOUNT)?;
    for e in block.chunks_exact(E::SIZE) {
        if e[E::STATE] != E::STATE_ROSTER {
            continue;
        }
        let rd = |o: usize| u32::from_le_bytes([e[o], e[o + 1], e[o + 2], e[o + 3]]);
        if rd(E::FROM_BELL) > b {
            continue;
        }
        if kernel_op(e[E::PEND_OP]) && b > rd(E::PEND_BELL) {
            return Ok(false);
        }
        let (t, f) = (e[E::TILE] as usize, e[E::FACTION]);
        if t >= PROVINCE_TILES || f >= NEUTRAL {
            return Ok(false);
        }
        if fac[t] == NONE {
            fac[t] = f;
        } else if fac[t] != f {
            return Ok(false);
        }
        hosts[t] += 1;
        per_f[f as usize] += 1;
        total += 1;
        if hosts[t] as usize > kh::HEX_HOST_CAP
            || per_f[f as usize] as usize > kh::FACTION_RESIDENT_CAP
            || total > kh::PROVINCE_HOST_CAP
        {
            return Ok(false);
        }
    }
    // S1: a caravan standing on a tile where a host of another faction
    // stands may be raided (the escort may lose): not quiet. A sheltered
    // caravan (a garrison's tile) is not in the clash, but the test stays
    // conservative and counts it too.
    for slot in caravan_slots(pd)?.iter() {
        if let Some(t) = slot.tile_at(b) {
            let t = t as usize;
            if t >= PROVINCE_TILES || (fac[t] != NONE && fac[t] != slot.faction) {
                return Ok(false);
            }
        }
    }
    let r = Ro(pd);
    let n = (r.u8(P::SITE_COUNT)? as usize).min(P::SITES_N);
    let sites: [u8; P::SITES_N] = r.arr(P::SITES)?;
    let mut n_gar = 0usize;
    for (s, &tile) in sites.iter().enumerate().take(n) {
        let m = mirror(pd, s)?;
        if !v2_garrison_state(m[SM::STATE]) {
            continue;
        }
        n_gar += 1;
        for (pb, dl) in [
            (SM::PEND0_BELL, SM::PEND0_DELTA),
            (SM::PEND1_BELL, SM::PEND1_DELTA),
        ] {
            let bell = m32(m, pb);
            if bell != SM::NO_BELL && m64(m, dl) != 0 && bell < b {
                return Ok(false);
            }
        }
        let t = tile as usize;
        if t >= PROVINCE_TILES {
            return Ok(false);
        }
        let f = v2_site_faction(m);
        if fac[t] != NONE && fac[t] != f {
            return Ok(false);
        }
        fac[t] = f;
    }
    let camp = Camp::read(pd)?;
    if camp.present() && n_gar < MAX_GARRISONS {
        let t = camp.tile as usize;
        if t >= PROVINCE_TILES || fac[t] != NONE {
            return Ok(false);
        }
        fac[t] = NEUTRAL;
    }
    // S1 1e: a manned fort is a garrison of its faction on its tile (the
    // test is conservative: it counts every manned fort, joined or not).
    for f in forts_at(pd, b)? {
        if f.troops == 0 {
            continue;
        }
        let t = f.tile as usize;
        if t >= PROVINCE_TILES || (fac[t] != NONE && fac[t] != f.faction) {
            return Ok(false);
        }
        fac[t] = f.faction;
    }
    if let Some(k) = crate::conquest_model::read_keep(pd)? {
        let t = k.tile as usize;
        if t >= PROVINCE_TILES || (fac[t] != NONE && fac[t] != k.holder) {
            return Ok(false);
        }
    }
    Ok(true)
}

/// CLASH's input digest under ABI v2: `sha256("PSF-CLASH-INPUT-v2" ‖ b ‖
/// seed ‖ province[SITE_MIRROR..TICKET_COHORTS] ‖ province[4,096..4,736] ‖
/// arrivals [‖ "PSF-CARAVAN-v1" ‖ CARAVANS[5]])`, the caravan suffix only
/// when a slot is in use (S1; an MC Province's slots are zero).
pub fn input_digest_v2(pd: &[u8], ci: &[u8], b: u32, seed: &[u8; 32]) -> R<[u8; 32]> {
    let st = pd.get(STATE_BLOCK).ok_or(BAD_ACCOUNT)?;
    let cq = pd.get(P2::CQ_BLOCK).ok_or(BAD_ACCOUNT)?;
    let ar = ci.get(ARRIVALS_BLOCK).ok_or(BAD_ACCOUNT)?;
    let bb = b.to_le_bytes();
    Ok(match caravan_block(pd)? {
        None => sha256(&[INPUT_DOMAIN_V2, &bb, seed, st, cq, ar]),
        Some(cv) => sha256(&[INPUT_DOMAIN_V2, &bb, seed, st, cq, ar, CARAVAN_DOMAIN, cv]),
    })
}

/// SKIP's quiet digest under ABI v2 (the conquest block added; S1: the
/// caravan suffix when a slot is in use).
pub fn quiet_digest_v2(pd: &[u8], b0: u32, n: u8) -> R<[u8; 32]> {
    let st = pd.get(STATE_BLOCK).ok_or(BAD_ACCOUNT)?;
    let cq = pd.get(P2::CQ_BLOCK).ok_or(BAD_ACCOUNT)?;
    let bb = b0.to_le_bytes();
    Ok(match caravan_block(pd)? {
        None => sha256(&[QUIET_DOMAIN_V2, &bb, &[n], st, cq]),
        Some(cv) => sha256(&[QUIET_DOMAIN_V2, &bb, &[n], st, cq, CARAVAN_DOMAIN, cv]),
    })
}
