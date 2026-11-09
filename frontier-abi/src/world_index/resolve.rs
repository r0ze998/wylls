//! **Experimental, opt-in** (`--features world-index-experimental`): the
//! **one-bell wide resolve** as a pure function of account bytes — the
//! deployed `clash_model::{build_v2, apply_v2, settle_bell, finish_bell}`
//! and `conquest_model::step` over a **wide** province, under the full
//! identity scheme (`march::WideCombatant`) instead of the dense `u64`.
//!
//! A wide province is the whole Province v2 layout plus a trailer
//! (`land::WideProvince`), so the deployed models *parse* it, but three of
//! their rules read the legacy identity and are wrong for it:
//!
//! | deployed rule | what it reads | here |
//! |---|---|---|
//! | the camp's daily check (`camp_check_v2`) | `coord_of(pd)` = the prefix `(P, Q)`, **zero** in a wide record | [`camp_check`]: `rules::wide_daily_camp` over the canonical coordinate, the same seed (`camp_seed(pd)`), day gate, ½ spawn, keep-tile exclusion and troop range |
//! | the clash's identities (`build_v2`) | the entry's `u64 id`, `host_id(P, Q, site, gen, 0)` for a holding, `u64::MAX − gen` for the camp, `KEEP_ID_BASE − gen` for the keep | [`build`]: the entry's alias is **looked up** in the authenticated roster side table (`roster::WideRoster`, `validate_paired` first) and the kernel sees the full `WideHostRef`; the holding is `Host(holding_ref)`, the camp `Camp { key, gen }`, the keep `Keep { key, gen }` |
//! | the keep donor's equal-troops tiebreak (`step` → `keep::advance`) | the lowest `u64 id` | [`step`]: `keep::advance_with` over the full identity (the kernel's own `WideCombatant` order), never the alias or the entry index |
//!
//! Everything else is the deployed rule, reused by call where it is
//! identity-free (`terrain_of`, `has_holding`, `camp_seed`, `settle_bell`,
//! `finish_bell`, `score_territory`, `write_snapshot`, `active_count`,
//! `garrison_of` / `put_garrison`, `read_keep` / `write_keep`) and copied
//! byte for byte where it is not (the entry write-back, the arrival entry,
//! the camp clear, the keep garrison, the donor hand-off). There is **no
//! SkipQuiet**: every bell of a wide province is a real resolve through the
//! kernel, quiet or not; the quiet model's `tile_masks` / `advance_quiet`
//! are not reached (the reviewer's ruling: their inputs are the legacy
//! identity).
//!
//! **The roster side table is written in step with the entry table.** An
//! arrival that stays is written as an entry whose `id` is the alias the
//! roster's authenticated `claim` returns for its full reference; a
//! destroyed resident, a forfeited entry and a donor whose rest joined the
//! keep are released from the table when their entry is zeroed
//! ([`settle`] diffs the live set around `settle_bell`). A live entry whose
//! `id` is a dense legacy id is refused ([`ResolveError::LegacyEntry`]):
//! no legacy host stands in a wide province and no wide host in a legacy
//! one.
//!
//! **Not ported, refused.** A live fort, a caravan in a slot or a conquest
//! record (siege, occupation, capture-due) is S1/S2 state no wide handler
//! writes; [`build`] refuses the province ([`Unported`]) rather than run
//! the deployed step over it with the wrong identity.
//!
//! **What this is not.** No handler calls it yet: no wide instruction
//! musters a host, gathers an arrival or resolves a bell, so no reserve is
//! debited and no bytes change on chain through this module. It is the
//! bell model a wide Resolve must run; the handler owes the canonical
//! anchor and window checks of the province's region, the beacon seed
//! `S(A)`, the resolve summary and the event record.

use super::arrival::{
    fate_byte, wide_clash_inputs as WCI, ArrivalError, WideArrival, WideClashInputsHdr,
};
use super::conquest::{ConquestError, WideConquest};
use super::key::{KeyError, ProvinceKey, WideHostRef};
use super::land::{LandError, WideProvince};
use super::march::{
    is_wide_alias, resolve_wide_clash, wide_host_alias, WideClashError, WideClashInput,
    WideClashOutcome, WideCombatant, WideFighter, WideGarrison,
};
use super::roster::{RosterError, WideRoster};
use super::rules::wide_daily_camp;
use crate::bytes::{rd_u16, rd_u32, rd_u64, wr_u16};
use crate::clash_model::{
    camp_seed, caravan_slots, finish_bell, forts_at, garrison_of, has_holding, put_garrison,
    settle_bell, sub, terrain_of, Camp, ModelError, CAMP_SITE, DAY_BELLS,
};
use crate::conquest_model::{
    active_count, apply_capture, read_keep, score_territory, write_keep, write_snapshot, Record,
    SiteReport, SiteTransitionMirror, StepParams, HOUR_BELLS,
};
use crate::entry::{unit_from_u8, unit_to_u8, write_entry, Entry, EntryOp};
use crate::layout::province::{camp as CP, entry as E, province as P, site as SM};
use crate::v2::entry::{MAX_CANDIDATES, RETIRE_OP_A};
use crate::v2::layout::province::{conquest as CR, province as P2, site as SM2};
use alloc::vec::Vec;
use permutation_rules::fixed::{Bps, MilliTroops, BPS_ONE, MILLI};
use permutation_rules::frontier::clash::{
    self as kc, Fate, Occupancy, Relations, FACTION_LIMIT, MAX_GARRISONS, NEUTRAL,
};
use permutation_rules::frontier::doctrine::of_faction;
use permutation_rules::frontier::host::{self as kh, Stamina, MAX_HOST_TROOPS};
use permutation_rules::frontier::keep::{
    self as kkeep, Keep, KeepError, KeepEvent, KeepReport, MAX_KEEP_TROOPS,
};
use permutation_rules::frontier::stance::{Posture, Stance};
use permutation_rules::frontier::terrain::ProvinceTerrain;
use permutation_rules::params::Ruleset;
use permutation_rules::rng::Seed;

/// `gar_site` of the keep (the camp's is `clash_model::CAMP_SITE`).
pub const KEEP_SITE: u8 = 0xFE;

/// S1/S2 state a wide province may not carry (no wide handler writes it).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Unported {
    /// A live fort record.
    Fort,
    /// A caravan in a slot.
    Caravan,
    /// A conquest record of this kind on a site (including kind-zero obligations).
    ConquestRecord(u8),
    /// An unported packed-identity split or merge operation.
    PendingOp(u8),
}

/// Why the model refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ResolveError {
    /// The deployed model's refusal (`BadAccount`, `Overflow`, `Kernel`).
    Model(ModelError),
    Land(LandError),
    Roster(RosterError),
    Arrival(ArrivalError),
    Key(KeyError),
    Clash(WideClashError),
    Keep(KeepError),
    Conquest(ConquestError),
    /// A live entry whose `id` is a dense legacy id: a legacy host in a
    /// wide province (no mixing).
    LegacyEntry(usize),
    /// A live alias at this index has no matching roster reference.
    Unpaired(usize),
    Unported(Unported),
    /// The ClashInputs are another province's, bell's or season's.
    InputsMismatch,
    /// The outcome is not the built clash's.
    OutcomeMismatch,
    /// The province has a keep but no report of its hex was given.
    MissingKeepReport,
    /// `resolved_next` is not this bell.
    NotDue {
        next: u32,
        bell: u32,
    },
    Overflow,
}

const BAD: ResolveError = ResolveError::Model(ModelError::BadAccount);

macro_rules! from_err {
    ($($t:ty => $v:ident;)*) => {$(
        impl From<$t> for ResolveError {
            fn from(e: $t) -> Self {
                ResolveError::$v(e)
            }
        }
    )*};
}

from_err! {
    ModelError => Model;
    LandError => Land;
    RosterError => Roster;
    ArrivalError => Arrival;
    KeyError => Key;
    WideClashError => Clash;
    KeepError => Keep;
    ConquestError => Conquest;
    Unported => Unported;
}

type R<T> = Result<T, ResolveError>;

// ------------------------------------------------------------ byte helpers
// (the deployed model's private accessors, copied so the offsets are read
// the same way)

fn ent(pd: &[u8], i: usize) -> R<&[u8; E::SIZE]> {
    let o = P::entry(i);
    pd.get(o..o + E::SIZE)
        .and_then(|s| s.try_into().ok())
        .ok_or(BAD)
}

fn ent_mut(pd: &mut [u8], i: usize) -> R<&mut [u8; E::SIZE]> {
    let o = P::entry(i);
    pd.get_mut(o..o + E::SIZE)
        .and_then(|s| s.try_into().ok())
        .ok_or(BAD)
}

fn g16(e: &[u8; E::SIZE], o: usize) -> u16 {
    u16::from_le_bytes([e[o], e[o + 1]])
}

fn g32(e: &[u8; E::SIZE], o: usize) -> u32 {
    u32::from_le_bytes([e[o], e[o + 1], e[o + 2], e[o + 3]])
}

fn g64(e: &[u8; E::SIZE], o: usize) -> u64 {
    let mut b = [0u8; 8];
    b.copy_from_slice(&e[o..o + 8]);
    u64::from_le_bytes(b)
}

fn p16(e: &mut [u8; E::SIZE], o: usize, v: u16) {
    e[o..o + 2].copy_from_slice(&v.to_le_bytes());
}

fn p32(e: &mut [u8; E::SIZE], o: usize, v: u32) {
    e[o..o + 4].copy_from_slice(&v.to_le_bytes());
}

fn mirror(pd: &[u8], s: usize) -> R<&[u8; SM::SIZE]> {
    let o = P::site(s);
    pd.get(o..o + SM::SIZE)
        .and_then(|x| x.try_into().ok())
        .ok_or(BAD)
}

fn m32(m: &[u8; SM::SIZE], o: usize) -> u32 {
    u32::from_le_bytes([m[o], m[o + 1], m[o + 2], m[o + 3]])
}

fn m64(m: &[u8; SM::SIZE], o: usize) -> i64 {
    let mut b = [0u8; 8];
    b.copy_from_slice(&m[o..o + 8]);
    i64::from_le_bytes(b)
}

/// A kernel pending change (ops 1–4) of an entry, by its op byte.
const fn kernel_op(op: u8) -> bool {
    op >= E::OP_SPEND && op <= E::OP_ABSORBED_INTO
}

/// A doctrine multiplier as stored (0 reads as none).
fn bps(v: u16) -> Bps {
    if v == 0 {
        BPS_ONE
    } else {
        v as Bps
    }
}

fn fate_tile(f: Fate) -> Option<u8> {
    match f {
        Fate::Stays { tile } | Fate::Withdrew { tile } => Some(tile),
        _ => None,
    }
}

// ------------------------------------------------------------ the roster pairing

/// The `u64 id` of every live entry (states 1–3), `None` where free: the
/// shape `WideRoster::validate_paired` takes.
pub fn live_ids(pd: &[u8]) -> R<[Option<u64>; P::ENTRIES_N]> {
    let mut out = [None; P::ENTRIES_N];
    for (i, slot) in out.iter_mut().enumerate() {
        let e = ent(pd, i)?;
        if matches!(e[E::STATE], 1..=3) {
            *slot = Some(g64(e, E::ID));
        }
    }
    Ok(out)
}

/// The full reference behind entry `i` whose `id` is `id`: a wide alias
/// (`LegacyEntry` otherwise) whose reference is stored at `i` of the
/// roster's bytes and regenerates it (`Unpaired` otherwise).
fn host_of_entry(roster: &WideRoster, rd: &[u8], i: usize, id: u64) -> R<WideHostRef> {
    if !is_wide_alias(id) {
        return Err(ResolveError::LegacyEntry(i));
    }
    roster
        .ref_at(rd, i)?
        .filter(|h| wide_host_alias(h) == id)
        .ok_or(ResolveError::Unpaired(i))
}

/// Refuse unsupported identities and operations before any model writes.
fn validate_live_entries(pd: &[u8], roster: &WideRoster, rd: &[u8]) -> R<()> {
    roster.validate_paired(rd, &live_ids(pd)?)?;
    for i in 0..P::ENTRIES_N {
        let e = ent(pd, i)?;
        if e[E::STATE] == E::STATE_FREE {
            continue;
        }
        host_of_entry(roster, rd, i, g64(e, E::ID))?;
        if matches!(
            e[E::PEND_OP],
            E::OP_SPLIT | E::OP_ABSORB | E::OP_ABSORBED_INTO
        ) {
            return Err(Unported::PendingOp(e[E::PEND_OP]).into());
        }
    }
    Ok(())
}

/// Refuses the S1/S2 state no wide handler writes (module doc).
pub fn refuse_unported(pd: &[u8], b: u32) -> R<()> {
    if !forts_at(pd, b)?.is_empty() {
        return Err(Unported::Fort.into());
    }
    if caravan_slots(pd)?.iter().any(|s| s.id != 0) {
        return Err(Unported::Caravan.into());
    }
    for s in 0..P2::SITES_N {
        let r = Record::read(pd, s)?;
        // Kind zero is not necessarily empty: failed wide sieges still owe a
        // slot. Only canonical no-obligation immunity can use the old APIs.
        if r.kind != CR::KIND_NONE
            || !(r.faction < NEUTRAL || r.faction == CR::BARRED_ALL || r.faction == CR::BARRED_NONE)
            || r.flags != 0
            || r.progress != 0
            || r.required != 0
            || r.target != 0
            || r.vigil_start != 0
            || r.vigil_next != 0
            || r.vigil_from_day != 0
            || r.actor != 0
            || r.src != 0
        {
            return Err(Unported::ConquestRecord(r.kind).into());
        }
    }
    Ok(())
}

// ------------------------------------------------------------ the camp

/// The camp after the day's check of bell `b` (the deployed
/// `camp_check_v2`, with `rules::wide_daily_camp` over the canonical
/// coordinate in place of `camp::place_v2` over the zero prefix pair):
/// `None` when the check of `day(b)` already ran; else the new record and
/// whether a camp spawned. The seed is the deployed `camp_seed(pd)` (the
/// hash of the terrain block), as the deployed daily check draws.
pub fn camp_check(
    pd: &[u8],
    id: &WideProvince,
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
    n.next_check_day = day.checked_add(1).ok_or(ResolveError::Overflow)?;
    let spawn = wide_daily_camp(
        &camp_seed(pd)?,
        id.coord,
        t,
        day,
        has_holding(pd)?,
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

// ------------------------------------------------------------ build

/// The owned parts of one wide clash's input, with where each part came
/// from (the deployed `Built` / `BuiltV2` under the full identity).
pub struct WideBuilt {
    pub province: ProvinceKey,
    pub bell: u32,
    pub terrain: ProvinceTerrain,
    /// Sorted by identity (the kernel's order), so the write-back walks the
    /// outcome in step.
    pub residents: Vec<WideFighter>,
    /// Entry index of each resident.
    pub res_entry: Vec<u8>,
    /// The site garrisons (holdings and the Free City), then the camp, then
    /// the keep.
    pub garrisons: Vec<WideGarrison>,
    /// Site of each garrison ([`CAMP_SITE`] the camp, [`KEEP_SITE`] the keep).
    pub gar_site: Vec<u8>,
    /// Sorted by identity.
    pub arrivals: Vec<WideFighter>,
    /// ClashInputs position of each arrival.
    pub arr_pos: Vec<u8>,
    pub occupancy: Occupancy,
    pub relations: Relations,
    /// The camp this clash sees (after the day's check).
    pub camp: Camp,
    /// `Some(spawned)` when the day's check ran for this bell.
    pub camp_checked: Option<bool>,
    /// The keep as read (its garrison is the last of `garrisons`).
    pub keep: Option<Keep>,
}

impl WideBuilt {
    /// The kernel's input over the bell seed `S(b, r)` of the province's
    /// region (the kernel derives the wide clash seed from it).
    pub fn input(&self, seed: &Seed) -> WideClashInput<'_> {
        WideClashInput {
            province: self.province,
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

    /// The keep's combat identity in this clash.
    pub fn keep_id(&self) -> Option<WideCombatant> {
        self.keep.map(|k| WideCombatant::Keep {
            key: self.province,
            gen: k.gen,
        })
    }
}

/// Builds the clash of bell `b` of the wide province `pd` from its entry
/// table paired with the roster side table `rd` (of `roster`), and the
/// gathered wide ClashInputs when there are arrivals. The deployed
/// `build_v2`, identity for identity (module doc); a kernel refusal of a
/// stored value is `Model(Kernel(..))` with the deployed sub-code.
pub fn build(
    pd: &[u8],
    roster: &WideRoster,
    rd: &[u8],
    inputs: Option<&[u8]>,
    b: u32,
) -> R<WideBuilt> {
    refuse_unported(pd, b)?;
    build_supported(pd, roster, rd, inputs, b)
}

// Only the strict wrapper and the fully validated conquest bell call this.
fn build_supported(
    pd: &[u8],
    roster: &WideRoster,
    rd: &[u8],
    inputs: Option<&[u8]>,
    b: u32,
) -> R<WideBuilt> {
    let id = WideProvince::read(pd)?;
    let province = ProvinceKey::new(id.world, id.coord);
    if roster.province != province || roster.season_id != id.season_id {
        return Err(RosterError::Header.into());
    }
    let terrain = terrain_of(pd)?;
    let keep = read_keep(pd)?;
    let (camp, camp_checked) = match camp_check(pd, &id, &terrain, b, keep.map(|k| k.tile))? {
        Some((c, spawned)) => (c, Some(spawned)),
        None => (Camp::read(pd)?, None),
    };
    // Validate every live entry, including pending/departed/future entries.
    validate_live_entries(pd, roster, rd)?;
    let mut order: Vec<(WideCombatant, u8)> = Vec::new();
    let mut pending = [0u8; FACTION_LIMIT as usize];
    let mut used = 0u8;
    for i in 0..P::ENTRIES_N {
        let e = ent(pd, i)?;
        match e[E::STATE] {
            E::STATE_FREE => continue,
            E::STATE_ROSTER => used += 1,
            E::STATE_MUSTER_PENDING => {
                used += 1;
                let c = pending.get_mut(e[E::FACTION] as usize).ok_or(BAD)?;
                *c = c.saturating_add(1);
                continue;
            }
            E::STATE_DEPARTED => {
                used += 1;
                continue;
            }
            _ => return Err(BAD),
        }
        if g32(e, E::FROM_BELL) > b {
            continue;
        }
        if order.len() >= P::ROSTER_CAP {
            return Err(ModelError::Kernel(sub::CLASH_INPUT).into());
        }
        let host = host_of_entry(roster, rd, i, g64(e, E::ID))?;
        order.push((WideCombatant::Host(host), i as u8));
    }
    // The kernel sorts its hosts by identity (`sort_by_id`); the same
    // order here makes the write-back a walk in step.
    order.sort_by_key(|x| x.0);
    let mut residents = Vec::with_capacity(order.len());
    let mut res_entry = Vec::with_capacity(order.len());
    for &(cid, i) in order.iter() {
        let e = ent(pd, i as usize)?;
        // `Host::values_at(b)`: a kernel change of an earlier bell must
        // have been settled.
        if kernel_op(e[E::PEND_OP]) && b > g32(e, E::PEND_BELL) {
            return Err(ModelError::Kernel(sub::UNSETTLED).into());
        }
        let stamina = Stamina {
            value: g16(e, E::STAMINA_VALUE),
            bell: g32(e, E::STAMINA_BELL),
        }
        .at(b);
        residents.push(WideFighter {
            id: cid,
            faction: e[E::FACTION],
            unit: unit_from_u8(e[E::UNIT]).ok_or(BAD)?,
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
    // Garrisons: the sites (a holding's is `Host(holding_ref)`, a Free
    // City's NEUTRAL), then the camp while there is room, then the keep.
    let n_sites = (terrain.site_count as usize).min(P::SITES_N);
    let mut garrisons = Vec::with_capacity(MAX_GARRISONS + 1);
    let mut gar_site = Vec::with_capacity(MAX_GARRISONS + 1);
    for s in 0..n_sites {
        let m = mirror(pd, s)?;
        let st = m[SM::STATE];
        if st != SM::STATE_HOLDING && st != SM2::STATE_FREE_CITY {
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
                return Err(ModelError::Kernel(sub::UNSETTLED).into());
            }
        }
        let walls = m32(m, SM::WALLS_COMMITTED) > 0
            || (m32(m, SM::WALL_ITEM0_DELTA) > 0 && m32(m, SM::WALL_ITEM0_BELL) <= b)
            || (m32(m, SM::WALL_ITEM1_DELTA) > 0 && m32(m, SM::WALL_ITEM1_BELL) <= b);
        let faction = if st == SM2::STATE_FREE_CITY {
            NEUTRAL
        } else {
            m[SM::FACTION]
        };
        let holding = WideHostRef::new(province, s as u8, m[SM::GEN], 0)?;
        garrisons.push(WideGarrison {
            id: WideCombatant::Host(holding),
            faction,
            tile: terrain.sites[s],
            troops: m32(m, SM::GARRISON).min(MAX_HOST_TROOPS),
            walls,
            posture: Posture::Stance(Stance::Hold),
        });
        gar_site.push(s as u8);
    }
    if camp.present() && garrisons.len() < MAX_GARRISONS {
        let troops = (camp.troops as u64 * MILLI as u64).min(MAX_HOST_TROOPS as u64);
        garrisons.push(WideGarrison {
            id: WideCombatant::Camp {
                key: province,
                gen: camp.gen,
            },
            faction: NEUTRAL,
            tile: camp.tile,
            troops: troops as MilliTroops,
            walls: false,
            posture: Posture::Stance(Stance::Hold),
        });
        gar_site.push(CAMP_SITE);
    }
    if let Some(k) = keep {
        // `keep::garrison(&k)` under the tagged identity.
        if k.troops > MAX_KEEP_TROOPS {
            return Err(KeepError::TroopsAboveCap.into());
        }
        garrisons.push(WideGarrison {
            id: WideCombatant::Keep {
                key: province,
                gen: k.gen,
            },
            faction: k.holder,
            tile: k.tile,
            troops: k.troops * MILLI as u32,
            walls: true,
            posture: Posture::Stance(Stance::Hold),
        });
        gar_site.push(KEEP_SITE);
    }
    // Arrivals: the present positions of this province-bell's ClashInputs.
    let mut arrivals = Vec::with_capacity(kc::MAX_ARRIVALS);
    let mut arr_pos = Vec::with_capacity(kc::MAX_ARRIVALS);
    if let Some(ci) = inputs {
        let hdr = WideClashInputsHdr::read(ci)?;
        if hdr.dest != province || hdr.bell != b || hdr.season_id != id.season_id {
            return Err(ResolveError::InputsMismatch);
        }
        let mut arr: Vec<(WideFighter, u8)> = Vec::new();
        for k in 0..WCI::POSITIONS {
            if let Some(a) = WideArrival::read_at(ci, k)? {
                if a.present {
                    arr.push((a.to_fighter()?, k as u8));
                }
            }
        }
        arr.sort_by_key(|x| x.0.id);
        for (f, k) in arr {
            arrivals.push(f);
            arr_pos.push(k);
        }
    }
    Ok(WideBuilt {
        province,
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
            peaceful: rd_u64(pd, P::RELATIONS).ok_or(BAD)?,
        },
        camp,
        camp_checked,
        keep,
    })
}

/// The clash: the kernel's production body over the built input and the
/// region's bell seed.
pub fn resolve(rules: &Ruleset, built: &WideBuilt, seed: &Seed) -> R<WideClashOutcome> {
    Ok(resolve_wide_clash(rules, &built.input(seed))?)
}

// ------------------------------------------------------------ apply

/// What a resolve wrote besides the Province (the deployed `Applied` and
/// `AppliedV2::keep_changed`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct WideApplied {
    /// Fate code per ClashInputs position (`FATE_NONE` where no arrival).
    pub fates: [u8; WCI::POSITIONS],
    pub troops_after: [u32; WCI::POSITIONS],
    /// Positions that took the camp.
    pub camp_mask: u32,
    pub camp_cleared: bool,
    pub destroyed: u8,
    pub bounced: u8,
    /// An entry, a garrison or the camp changed.
    pub changed: bool,
    /// The keep's garrison changed in the clash.
    pub keep_changed: bool,
}

/// Writes the outcome back into the Province and the roster side table
/// (the deployed `apply_v2`, byte for byte, with the roster kept paired:
/// an arrival that stays is claimed, a destroyed resident whose entry is
/// zeroed is released). On `Err` the bytes may be partly written; the
/// caller discards them (the host executor's restore).
pub fn apply(
    pd: &mut [u8],
    roster: &WideRoster,
    rd: &mut [u8],
    b: &WideBuilt,
    out: &WideClashOutcome,
) -> R<WideApplied> {
    if out.province != b.province || out.bell != b.bell {
        return Err(ResolveError::OutcomeMismatch);
    }
    if b.gar_site.len() != b.garrisons.len() {
        return Err(BAD);
    }
    let bell = b.bell;
    let mut ap = WideApplied {
        fates: [0; WCI::POSITIONS],
        troops_after: [0; WCI::POSITIONS],
        camp_mask: 0,
        camp_cleared: false,
        destroyed: 0,
        bounced: 0,
        changed: false,
        keep_changed: false,
    };
    let mut camp = b.camp;
    if b.camp_checked == Some(true) {
        ap.changed = true;
    }
    // Residents, in the outcome's (= the build's) identity order.
    let mut res_out = out.fighters.iter().filter(|x| !x.arrival);
    for (f, &i) in b.residents.iter().zip(&b.res_entry) {
        let fr = res_out.next().filter(|x| x.id == f.id).ok_or(BAD)?;
        let i = i as usize;
        let e = ent_mut(pd, i)?;
        let op = e[E::PEND_OP];
        let tile = fate_tile(fr.fate);
        match fr.fate {
            Fate::Destroyed => {
                ap.destroyed = ap.destroyed.saturating_add(1);
                let keeps = op == E::OP_SPEND || op == E::OP_LEAVE || op == E::OP_FORFEIT;
                if !keeps {
                    e.fill(0);
                    roster.release(rd, i)?;
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
            return Err(ModelError::Kernel(sub::UNSETTLED).into());
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
    // Arrivals: a stay (or a withdraw onto another tile) becomes an entry
    // whose id is the alias the roster's authenticated claim returns.
    let mut free = 0usize;
    let mut arr_out = out.fighters.iter().filter(|x| x.arrival);
    for (f, &k) in b.arrivals.iter().zip(&b.arr_pos) {
        let fr = arr_out.next().filter(|x| x.id == f.id).ok_or(BAD)?;
        let k = k as usize;
        *ap.fates.get_mut(k).ok_or(BAD)? = fate_byte(fr.fate);
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
                    return Err(ModelError::Kernel(sub::CLASH_INPUT).into());
                }
                let host =
                    f.id.host()
                        .ok_or(ResolveError::Clash(WideClashError::SyntheticFighter(f.id)))?;
                let alias = roster.claim(rd, free, &host)?;
                let dealt = of_faction(f.faction)
                    .ok_or(BAD)?
                    .dealt_bps(Posture::Stance(Stance::Hold), false);
                let e = Entry {
                    id: alias,
                    faction: f.faction,
                    unit: unit_to_u8(f.unit),
                    tile,
                    state: E::STATE_ROSTER,
                    troops: fr.troops,
                    stamina_value: fr.stamina,
                    dealt_bps: u16::try_from(dealt).map_err(|_| ResolveError::Overflow)?,
                    stamina_bell: bell,
                    ready_bell: if fr.engaged {
                        kc::ready_bell_after(bell)
                    } else {
                        bell.checked_add(1).ok_or(ResolveError::Overflow)?
                    },
                    from_bell: bell.checked_add(1).ok_or(ResolveError::Overflow)?,
                    pend_bell: 0,
                    op: EntryOp::None,
                };
                write_entry(pd, free, &e).map_err(|_| BAD)?;
                ap.changed = true;
            }
        }
    }
    // Garrisons, the camp and the keep.
    for (g, &s) in b.garrisons.iter().zip(&b.gar_site) {
        let gr = out.garrisons.iter().find(|x| x.id == g.id).ok_or(BAD)?;
        if s == CAMP_SITE {
            let whole = gr.troops / MILLI as u32;
            if whole == 0 || gr.attackers_hold {
                for (f, &k) in b.arrivals.iter().zip(&b.arr_pos) {
                    let fr = out.fighter(&f.id).ok_or(BAD)?;
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
        if s == KEEP_SITE {
            let k = b.keep.ok_or(BAD)?;
            let whole = gr.troops / MILLI as u32;
            if whole != k.troops {
                let mut nk = k;
                nk.troops = whole;
                write_keep(pd, &nk)?;
                ap.keep_changed = true;
            }
            continue;
        }
        if gr.troops != g.troops {
            let mut st = garrison_of(pd, s as usize)?;
            st.apply_clash(bell, gr.troops)
                .map_err(|_| ModelError::Kernel(sub::UNSETTLED))?;
            put_garrison(pd, s as usize, &st)?;
            ap.changed = true;
        }
    }
    if b.camp_checked.is_some() || camp != b.camp {
        camp.write(pd)?;
    }
    Ok(ap)
}

/// Writes the resolve back into the wide ClashInputs: each present
/// position's fate and troops after, the camp mask, the resolved flag.
pub fn write_resolved(inputs: &mut [u8], ap: &WideApplied) -> R<()> {
    let mut hdr = WideClashInputsHdr::read(inputs)?;
    for k in 0..WCI::POSITIONS {
        if ap.fates[k] == 0 {
            continue;
        }
        let mut a = WideArrival::read_at(inputs, k)?.ok_or(BAD)?;
        a.fate = ap.fates[k];
        a.troops_after = ap.troops_after[k];
        a.write_at(inputs, k)?;
    }
    hdr.camp_mask = ap.camp_mask;
    hdr.flags |= WCI::FLAG_RESOLVED;
    hdr.write(inputs)?;
    Ok(())
}

// ------------------------------------------------------------ the step

/// The keep's hex report of this clash (`report_from_outcome` for the
/// keep): `None` when the province has no keep.
pub fn keep_report(b: &WideBuilt, out: &WideClashOutcome) -> R<Option<KeepReport>> {
    let Some(id) = b.keep_id() else {
        return Ok(None);
    };
    let gr = out.garrisons.iter().find(|x| x.id == id).ok_or(BAD)?;
    Ok(Some(KeepReport {
        holders: gr.holders,
        defender_present: gr.defender_present,
    }))
}

/// What the keep did in the bell (the deployed CONQUEST events, by name).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WideKeepEvent {
    Contest { faction: u8, progress: u8 },
    Broken { contender: u8, progress: u8 },
    Taken(WideKeepTaken),
}

/// A keep taken in this bell (the deployed `KeepTaken` with the donor by
/// full reference).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct WideKeepTaken {
    pub from: u8,
    pub to: u8,
    /// The new garrison, whole troops.
    pub garrison: u32,
    /// The donor (`None` without a capturer).
    pub donor: Option<WideHostRef>,
    /// The donor joined the keep entirely (its entry was removed).
    pub donor_removed: bool,
    /// MilliTroops the donor takes home (0 when removed).
    pub donor_rest: u32,
}

/// What one bell's step did (the deployed `StepOut` without the siege
/// records, which a wide province never carries).
#[derive(Clone, Debug, PartialEq, Eq, Default)]
pub struct WideStepOut {
    pub event: Option<WideKeepEvent>,
    pub keep_taken: Option<WideKeepTaken>,
    /// The hour snapshot written at `b = 6h`.
    pub snapshot: Option<[u16; P2::SIDES]>,
    /// A keep contest is running after the bell.
    pub active: bool,
    /// The donor's entry changed.
    pub roster_changed: bool,
    /// The Province changed.
    pub changed: bool,
}

/// The qualifying capturers of `faction` on `tile` at bell `b` (the
/// deployed `v2::entry::candidates`: roster state, `from_bell ≤ b`, no
/// pending op, a non-civilian unit, troops > 0, at most 8 in entry order),
/// each named by its **full identity** through the roster side table.
pub fn candidates(
    pd: &[u8],
    roster: &WideRoster,
    rd: &[u8],
    tile: u8,
    faction: u8,
    b: u32,
) -> R<Vec<(u8, WideCombatant, u32)>> {
    let mut out = Vec::new();
    for i in 0..P::ENTRIES_N {
        let e = ent(pd, i)?;
        if e[E::STATE] != E::STATE_ROSTER
            || e[E::TILE] != tile
            || e[E::FACTION] != faction
            || e[E::PEND_OP] != E::OP_NONE
            || g32(e, E::FROM_BELL) > b
        {
            continue;
        }
        let civilian = unit_from_u8(e[E::UNIT]).is_none_or(|u| u.is_civilian());
        let troops = g32(e, E::TROOPS);
        if civilian || troops == 0 {
            continue;
        }
        if out.len() < MAX_CANDIDATES {
            let host = host_of_entry(roster, rd, i, g64(e, E::ID))?;
            out.push((i as u8, WideCombatant::Host(host), troops));
        }
    }
    Ok(out)
}

/// The donor's entry after a keep is taken (the deployed `donor_handoff`,
/// byte for byte): home with the rest as a retire-style Leave settled at
/// once, or removed when the rest joined the keep.
fn donor_handoff(pd: &mut [u8], i: usize, rest: u32, removed: bool, b: u32) -> R<()> {
    let e = ent_mut(pd, i)?;
    if removed {
        e.fill(0);
        return Ok(());
    }
    p32(e, E::TROOPS, rest);
    e[E::PEND_OP] = E::OP_LEAVE;
    e[E::OP_A] = RETIRE_OP_A;
    p32(e, E::PEND_BELL, b);
    e[E::STATE] = E::STATE_DEPARTED;
    Ok(())
}

/// The step of bell `b` (the deployed `conquest_model::step` for a province
/// without siege records): the territory score, the keep's contest with
/// the donor chosen by full identity, the hour snapshot.
pub fn step(
    pd: &mut [u8],
    roster: &WideRoster,
    rd: &mut [u8],
    b: u32,
    report: Option<KeepReport>,
    prm: &StepParams,
) -> R<WideStepOut> {
    refuse_unported(pd, b)?;
    score_territory(pd, b, prm.end_bell)?;
    step_keep_snapshot(pd, roster, rd, b, report, prm)
}

// The conquest adapter has already scored starting ownership and advanced sites.
fn step_keep_snapshot(
    pd: &mut [u8],
    roster: &WideRoster,
    rd: &mut [u8],
    b: u32,
    report: Option<KeepReport>,
    prm: &StepParams,
) -> R<WideStepOut> {
    let mut out = WideStepOut::default();
    if let Some(before) = read_keep(pd)? {
        let kr = report.ok_or(ResolveError::MissingKeepReport)?;
        let mut k = before;
        let contender = (kr.holders.count_ones() == 1).then(|| kr.holders.trailing_zeros() as u8);
        let mut caps = match contender {
            Some(f) => candidates(pd, roster, rd, k.tile, f, b.saturating_add(1))?,
            None => Vec::new(),
        };
        let ev = kkeep::advance_with(&mut k, b, kr, &prm.cq.keep_params(), &mut caps)?;
        match ev {
            KeepEvent::None | KeepEvent::Paused => {}
            KeepEvent::Contest(f) => {
                out.event = Some(WideKeepEvent::Contest {
                    faction: f,
                    progress: k.progress,
                })
            }
            KeepEvent::Broken => {
                out.event = Some(WideKeepEvent::Broken {
                    contender: before.contender,
                    progress: before.progress,
                })
            }
            KeepEvent::Taken {
                from,
                to,
                garrison,
                donor,
                donor_removed,
            } => {
                let mut taken = WideKeepTaken {
                    from,
                    to,
                    garrison,
                    donor: None,
                    donor_removed,
                    donor_rest: 0,
                };
                if let Some(c) = caps.iter().find(|c| c.0 == donor) {
                    taken.donor = c.1.host();
                    taken.donor_rest = c.2;
                    donor_handoff(pd, c.0 as usize, c.2, donor_removed, b)?;
                    if donor_removed {
                        roster.release(rd, c.0 as usize)?;
                    }
                    out.roster_changed = true;
                }
                if (to as usize) < P2::FACTIONS {
                    let o = P2::keeps_taken_by(to as usize);
                    let v = rd_u16(pd, o).ok_or(BAD)?.saturating_add(1);
                    if !wr_u16(pd, o, v) {
                        return Err(BAD);
                    }
                }
                out.keep_taken = Some(taken);
                out.event = Some(WideKeepEvent::Taken(taken));
            }
        }
        if k != before {
            write_keep(pd, &k)?;
            out.changed = true;
        }
    }
    if b % HOUR_BELLS == 0 {
        out.snapshot = Some(write_snapshot(pd, b)?);
        out.changed = true;
    }
    out.active = active_count(pd)? > 0;
    Ok(out)
}

/// The deployed `settle_bell(b)` with the roster side table kept paired:
/// every entry the settle zeroed (a forfeit) is released. `true` when the
/// settle changed anything.
pub fn settle(pd: &mut [u8], roster: &WideRoster, rd: &mut [u8], b: u32) -> R<bool> {
    validate_live_entries(pd, roster, rd)?;
    let mut live = [false; P::ENTRIES_N];
    for (i, l) in live.iter_mut().enumerate() {
        *l = ent(pd, i)?[E::STATE] != E::STATE_FREE;
    }
    let changed = settle_bell(pd, b)?;
    for (i, was) in live.iter().enumerate() {
        if *was && ent(pd, i)?[E::STATE] == E::STATE_FREE {
            roster.release(rd, i)?;
        }
    }
    Ok(changed)
}

// ------------------------------------------------------------ the bell

/// Everything one wide bell did.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WideBellOutcome {
    pub clash: WideClashOutcome,
    pub applied: WideApplied,
    pub step: WideStepOut,
    pub settled: bool,
}

/// Opt-in model result, deliberately separate from existing Resolve receipts.
/// Future event commitments must bind the full table as well as `bell`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WideConquestBellOutcome {
    pub conquest: WideConquest,
    pub bell: WideBellOutcome,
    pub site_reports: [SiteReport; P::SITES_N],
    pub site_events: Vec<crate::v2::log::Event>,
    pub records_changed: bool,
    pub mirrors_changed: bool,
}

fn site_mirror(pd: &[u8], s: usize) -> R<SiteTransitionMirror> {
    let m = mirror(pd, s)?;
    Ok(SiteTransitionMirror {
        state: m[SM::STATE],
        gen: m[SM::GEN],
        order: m[SM::ORDER],
        held_since_hour: rd_u16(m, SM2::HELD_SINCE_HOUR).ok_or(BAD)?,
        walls_committed: m32(m, SM::WALLS_COMMITTED),
    })
}

// Validate every position, not just currently active sieges. This is the only
// admission to build_supported other than the strict no-conquest wrapper.
fn validate_conquest(pd: &[u8], table: &[u8], b: u32) -> R<WideConquest> {
    let id = WideProvince::read(pd)?;
    let key = ProvinceKey::new(id.world, id.coord);
    let conquest = WideConquest::read(table, id.season_id, key)?;
    if !forts_at(pd, b)?.is_empty() {
        return Err(Unported::Fort.into());
    }
    if caravan_slots(pd)?.iter().any(|s| s.id != 0) {
        return Err(Unported::Caravan.into());
    }
    let n = *pd.get(P::SITE_COUNT).ok_or(BAD)? as usize;
    if n > P::SITES_N {
        return Err(BAD);
    }
    for s in 0..P::SITES_N {
        let r = Record::read(pd, s)?;
        conquest.validate_paired(s as u8, r)?;
        let entry = conquest.entry(s as u8)?;
        if s >= n {
            if entry.is_some() || r != Record::ZERO {
                return Err(ConquestError::State.into());
            }
            continue;
        }
        let m = site_mirror(pd, s)?;
        let faction = mirror(pd, s)?[SM::FACTION];
        let canonical = match m.state {
            SM2::STATE_FREE_CITY => m.gen == 0 && m.order == 0 && faction == NEUTRAL,
            SM::STATE_HOLDING => {
                (1..=254).contains(&m.gen) && (1..=3).contains(&m.order) && faction < NEUTRAL
            }
            SM::STATE_FREE => m.gen == 0 && m.order == 0 && faction == NEUTRAL,
            SM::STATE_RELEASED_FREE => m.gen != 255 && faction == NEUTRAL,
            _ => false,
        };
        if !canonical {
            return Err(ConquestError::State.into());
        }
        if let Some(e) = entry {
            if e.declaration_bell > b || e.original_target_gen != 0 {
                return Err(ConquestError::State.into());
            }
            let matches = match e.rules.kind {
                CR::KIND_SIEGE | CR::KIND_NONE => {
                    m.state == SM2::STATE_FREE_CITY && m.gen == e.original_target_gen
                }
                CR::KIND_CAPTURE_DUE => {
                    m.state == SM::STATE_HOLDING
                        && m.gen == e.original_target_gen + 1
                        && m.order == e.reserved_slot
                        && faction == e.rules.faction
                        && e.rules.bell < b
                }
                _ => false,
            };
            if !matches {
                return Err(ConquestError::State.into());
            }
        }
    }
    Ok(conquest)
}

fn site_reports(built: &WideBuilt, out: &WideClashOutcome) -> R<[SiteReport; P::SITES_N]> {
    let mut reports = [SiteReport::default(); P::SITES_N];
    for (g, &s) in built.garrisons.iter().zip(&built.gar_site) {
        if s == CAMP_SITE || s == KEEP_SITE {
            continue;
        }
        let gr = out
            .garrisons
            .iter()
            .find(|r| r.id == g.id)
            .ok_or(ResolveError::OutcomeMismatch)?;
        *reports.get_mut(s as usize).ok_or(BAD)? = SiteReport {
            holders: gr.holders,
            defender_present: gr.defender_present,
        };
    }
    Ok(reports)
}

/// Explicit opt-in, model-only Free City conquest bell. No command calls this.
/// The caller authenticates account owners/addresses, season parameters and the
/// seed/window; future escrow settlement and event dispatch remain its duties.
/// This authenticates table contents against the full province/Season identity,
/// prefix records, mirrors and exact bell cursor. It resolves the real wide
/// clash, never supplied/fabricated site reports. All writes use scratch copies:
/// on ANY error neither caller buffer changes; on success commit both buffers
/// and the returned table atomically. `table` itself is never modified.
/// Existing build/step/resolve_bell retain their strict conquest refusal.
#[allow(clippy::too_many_arguments)]
pub fn resolve_bell_with_conquest(
    pd: &mut [u8],
    roster: &WideRoster,
    rd: &mut [u8],
    table: &[u8],
    inputs: Option<&[u8]>,
    b: u32,
    seed: &Seed,
    rules: &Ruleset,
    prm: &StepParams,
) -> R<WideConquestBellOutcome> {
    let next = rd_u32(pd, P::RESOLVED_NEXT).ok_or(BAD)?;
    if next != b {
        return Err(ResolveError::NotDue { next, bell: b });
    }
    if b >= prm.end_bell {
        return Err(ConquestError::TooEarly.into());
    }
    let mut conquest = validate_conquest(pd, table, b)?;
    let built = build_supported(pd, roster, rd, inputs, b)?;
    let mut scratch = pd.to_vec();
    let mut refs = rd.to_vec();
    let clash = resolve(rules, &built, seed)?;
    let applied = apply(&mut scratch, roster, &mut refs, &built, &clash)?;
    let reports = site_reports(&built, &clash)?;
    let keep = keep_report(&built, &clash)?;
    let settled = settle(&mut scratch, roster, &mut refs, b)?;
    // Original order: clash, reports, settle, score starting ownership, sites,
    // keep, hourly snapshot. Neither clash nor settle changes keep ownership.
    score_territory(&mut scratch, b, prm.end_bell)?;
    let mut site_events = Vec::new();
    let mut records_changed = false;
    let mut mirrors_changed = false;
    for (s, report) in reports.iter().enumerate() {
        if let Some(e) = conquest.entry(s as u8)? {
            let plan = conquest.step(
                s as u8,
                Record::read(&scratch, s)?,
                e,
                site_mirror(&scratch, s)?,
                b,
                *report,
                prm,
            )?;
            if let Some(t) = plan.transition {
                if let Some(capture) = t.capture {
                    apply_capture(&mut scratch, s, t.record.faction, capture)?;
                    mirrors_changed = true;
                }
                plan.prefix.write(&mut scratch, s)?;
                records_changed = true;
                if let Some((code, faction, progress)) = t.event {
                    site_events.push(crate::v2::log::Event {
                        site: s as u8,
                        code,
                        faction,
                        progress,
                    });
                }
            }
            conquest = plan.conquest;
        }
    }
    let step = step_keep_snapshot(&mut scratch, roster, &mut refs, b, keep, prm)?;
    finish_bell(
        &mut scratch,
        b,
        applied.changed
            || applied.keep_changed
            || step.roster_changed
            || settled
            || mirrors_changed,
    )?;
    validate_live_entries(&scratch, roster, &refs)?;
    // Recheck the paired result at its new cursor, including capture mirrors.
    validate_conquest(
        &scratch,
        &conquest.to_bytes(),
        b.checked_add(1).ok_or(ResolveError::Overflow)?,
    )?;
    pd.copy_from_slice(&scratch);
    rd.copy_from_slice(&refs);
    Ok(WideConquestBellOutcome {
        conquest,
        bell: WideBellOutcome {
            clash,
            applied,
            step,
            settled,
        },
        site_reports: reports,
        site_events,
        records_changed,
        mirrors_changed,
    })
}

/// The whole bell `b` of a wide province: due (`resolved_next == b`),
/// [`build`], [`resolve`] under the region's bell seed, [`apply`],
/// [`settle`], [`step`], `finish_bell`. The caller owes the anchor and
/// window checks that make `seed` the right one, the resolve summary and
/// the event record; on `Err` it discards the bytes.
#[allow(clippy::too_many_arguments)]
pub fn resolve_bell(
    pd: &mut [u8],
    roster: &WideRoster,
    rd: &mut [u8],
    inputs: Option<&[u8]>,
    b: u32,
    seed: &Seed,
    rules: &Ruleset,
    prm: &StepParams,
) -> R<WideBellOutcome> {
    let next = rd_u32(pd, P::RESOLVED_NEXT).ok_or(BAD)?;
    if next != b {
        return Err(ResolveError::NotDue { next, bell: b });
    }
    let built = build(pd, roster, rd, inputs, b)?;
    let clash = resolve(rules, &built, seed)?;
    let applied = apply(pd, roster, rd, &built, &clash)?;
    let report = keep_report(&built, &clash)?;
    let settled = settle(pd, roster, rd, b)?;
    let step = step(pd, roster, rd, b, report, prm)?;
    finish_bell(
        pd,
        b,
        applied.changed || applied.keep_changed || step.roster_changed || settled,
    )?;
    Ok(WideBellOutcome {
        clash,
        applied,
        step,
        settled,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::clash_model::{RESOURCES, TERRAINS};
    use crate::v2::layout::province::fort_record as FR;
    use crate::v2::presets::MC_LOCAL_7D;
    use crate::world_index::arrival::{wide_arrival as WA, wide_arrival_slot as WAS};
    use crate::world_index::coord::WideCoord;
    use crate::world_index::key::WorldId;
    use crate::world_index::land::{province as L, readiness};
    use crate::world_index::roster::wide_roster;
    use permutation_rules::frontier::clash::frontier_ruleset;
    use permutation_rules::frontier::geometry::{ProvinceCoord, PROVINCE_TILES};
    use permutation_rules::frontier::keep::NO_FACTION;
    use permutation_rules::frontier::terrain::generate_province;
    use permutation_rules::hash::sha256;
    use permutation_rules::units::UnitType;
    use std::vec;

    const SEED: [u8; 32] = [0x51; 32];
    const SEASON: u64 = 11;
    const RENT_TO: [u8; 32] = [0xd4; 32];
    const HOLDER: u8 = 4;

    fn world() -> WorldId {
        WorldId::new([0x77; 32]).unwrap()
    }

    fn coord() -> WideCoord {
        WideCoord::checked(129, 0).unwrap()
    }

    fn key() -> ProvinceKey {
        ProvinceKey::new(world(), coord())
    }

    fn terrain() -> ProvinceTerrain {
        generate_province(&SEED, ProvinceCoord::new(3, -1))
    }

    /// A passable non-site tile that is not `not`.
    fn free_tile(t: &ProvinceTerrain, not: Option<u8>) -> u8 {
        (1..PROVINCE_TILES as u8)
            .find(|&x| t.passable(x) && !t.is_site(x) && Some(x) != not)
            .unwrap()
    }

    fn prm(keep_bells: u16) -> StepParams {
        let mut cq = MC_LOCAL_7D.cq;
        cq.keep_bells = keep_bells;
        StepParams {
            genesis_ts: 0,
            end_bell: 100_000,
            cq,
        }
    }

    /// A wide province at bell `b0`: the identity, the terrain, free sites
    /// with the deployed empty pending slots, a keep of `HOLDER` with the
    /// default home guard, no camp with the day's check due at `day(b0)`.
    fn province(b0: u32, keep_bells: u16) -> (Vec<u8>, ProvinceTerrain, u8) {
        let mut pd = vec![0u8; L::SIZE];
        WideProvince {
            season_id: SEASON,
            world: world(),
            coord: coord(),
            wedge: coord().wedge().unwrap(),
            region: 3,
            opened_bell: b0,
            readiness: readiness::REQUIRED,
            seed_round: 1,
            ring_seed: SEED,
            funded_lamports: 0,
        }
        .write_identity(&mut pd)
        .unwrap();
        let t = terrain();
        for i in 0..PROVINCE_TILES {
            pd[P::TERRAIN + i] = TERRAINS.iter().position(|x| *x == t.terrain[i]).unwrap() as u8;
            pd[P::RESOURCE + i] = match t.resource[i] {
                None => 0,
                Some(r) => 1 + RESOURCES.iter().position(|x| *x == r).unwrap() as u8,
            };
        }
        pd[P::SITES..P::SITES + P::SITES_N].copy_from_slice(&t.sites);
        pd[P::SITE_COUNT] = t.site_count;
        pd[P::RESOLVED_NEXT..P::RESOLVED_NEXT + 4].copy_from_slice(&b0.to_le_bytes());
        pd[P2::SCORE_NEXT_BELL..P2::SCORE_NEXT_BELL + 4].copy_from_slice(&b0.to_le_bytes());
        for s in 0..P::SITES_N {
            let o = P::site(s);
            pd[o + SM::STATE] = SM::STATE_FREE;
            pd[o + SM::FACTION] = NEUTRAL;
            for pb in [SM::PEND0_BELL, SM::PEND1_BELL] {
                pd[o + pb..o + pb + 4].copy_from_slice(&SM::NO_BELL.to_le_bytes());
            }
        }
        let keep_tile = free_tile(&t, None);
        write_keep(
            &mut pd,
            &Keep {
                tile: keep_tile,
                holder: HOLDER,
                contender: NO_FACTION,
                progress: 0,
                required: keep_bells as u8,
                heartland_safe: false,
                paused: false,
                changes: 0,
                troops: 100,
                since_bell: b0,
                consolidated_until_bell: 0,
                contest_from_bell: 0,
                gen: 0,
                last_taken_from: NO_FACTION,
            },
        )
        .unwrap();
        Camp {
            tile: 0,
            state: CP::STATE_NONE,
            troops: 0,
            next_check_day: b0 / DAY_BELLS,
            gen: 0,
        }
        .write(&mut pd)
        .unwrap();
        (pd, t, keep_tile)
    }

    fn roster() -> (WideRoster, Vec<u8>) {
        let r = WideRoster::new(SEASON, key(), RENT_TO);
        let mut rd = vec![0u8; wide_roster::SIZE];
        r.write_header(&mut rd).unwrap();
        (r, rd)
    }

    fn host(site: u8, gen: u8, seq: u32) -> WideHostRef {
        WideHostRef::new(key(), site, gen, seq).unwrap()
    }

    /// A holding of `faction` at site `s` with `garrison` milli-troops.
    fn holding(pd: &mut [u8], s: usize, faction: u8, gen: u8, garrison: u32) {
        let o = P::site(s);
        pd[o + SM::STATE] = SM::STATE_HOLDING;
        pd[o + SM::FACTION] = faction;
        pd[o + SM::GEN] = gen;
        pd[o + SM::GARRISON..o + SM::GARRISON + 4].copy_from_slice(&garrison.to_le_bytes());
    }

    /// A resident host at entry `i`: the roster claim, then the entry with
    /// the alias the claim returned.
    #[allow(clippy::too_many_arguments)]
    fn resident(
        pd: &mut [u8],
        roster: &WideRoster,
        rd: &mut [u8],
        i: usize,
        h: WideHostRef,
        faction: u8,
        unit: UnitType,
        troops: u32,
        tile: u8,
    ) -> u64 {
        let alias = roster.claim(rd, i, &h).unwrap();
        write_entry(
            pd,
            i,
            &Entry {
                id: alias,
                faction,
                unit: unit_to_u8(unit),
                tile,
                state: E::STATE_ROSTER,
                troops,
                stamina_value: kh::STAMINA_CAP,
                dealt_bps: 0,
                stamina_bell: 0,
                ready_bell: 0,
                from_bell: 0,
                pend_bell: 0,
                op: EntryOp::None,
            },
        )
        .unwrap();
        alias
    }

    fn inputs_with(b: u32, arrivals: &[(usize, WideArrival)]) -> Vec<u8> {
        let mut ci = vec![0u8; WCI::SIZE];
        let mut hdr = WideClashInputsHdr::new(SEASON, key(), b, RENT_TO);
        for (k, _) in arrivals {
            hdr.arrivals_mask |= 1 << k;
            hdr.n_present += 1;
        }
        hdr.write(&mut ci).unwrap();
        for (k, a) in arrivals {
            a.write_at(&mut ci, *k).unwrap();
        }
        ci
    }

    fn arrival(h: WideHostRef, faction: u8, unit: UnitType, troops: u32, tile: u8) -> WideArrival {
        WideArrival {
            host: h,
            citizen: [0xc1; 32],
            dep_mass: troops,
            troops,
            stamina: kh::STAMINA_CAP,
            retreat_bps: WAS::RETREAT_NEVER,
            dealt_bps: BPS_ONE as u16,
            faction,
            unit: unit_to_u8(unit),
            tile,
            stance: 0,
            present: true,
            fate: WA::FATE_NONE,
            troops_after: 0,
        }
    }

    /// The build pairs every live entry with the roster, names the holding,
    /// the camp and the keep by their tagged identities, and orders the
    /// residents as the kernel does.
    #[test]
    fn build_pairs_entries_and_tags_garrisons() {
        let b = 300;
        let (mut pd, t, keep_tile) = province(b, 72);
        let (roster, mut rd) = roster();
        holding(&mut pd, 2, 0, 1, 4_000_000);
        let field = free_tile(&t, Some(keep_tile));
        let a = host(2, 1, 9);
        let c = host(2, 1, 2);
        // entry order a, c; identity order c, a (lower seq)
        let (sp, ar, pk) = (UnitType::Spearman, UnitType::Archer, UnitType::Pikeman);
        resident(&mut pd, &roster, &mut rd, 0, a, 0, sp, 9_000_000, field);
        resident(&mut pd, &roster, &mut rd, 5, c, 0, ar, 6_000_000, field);
        // a pending muster and a departed entry count in the occupancy only
        resident(
            &mut pd,
            &roster,
            &mut rd,
            7,
            host(2, 1, 3),
            1,
            pk,
            700_000,
            field,
        );
        pd[P::entry(7) + E::STATE] = E::STATE_MUSTER_PENDING;
        resident(
            &mut pd,
            &roster,
            &mut rd,
            8,
            host(2, 1, 4),
            1,
            pk,
            700_000,
            field,
        );
        pd[P::entry(8) + E::STATE] = E::STATE_DEPARTED;
        let built = build(&pd, &roster, &rd, None, b).unwrap();
        assert_eq!(built.province, key());
        assert_eq!(built.bell, b);
        assert_eq!(built.res_entry, vec![5, 0]);
        assert_eq!(built.residents[0].id, WideCombatant::Host(c));
        assert_eq!(built.residents[1].id, WideCombatant::Host(a));
        assert_eq!(built.residents[0].troops, 6_000_000);
        assert_eq!(built.residents[1].dealt_bps, BPS_ONE);
        assert_eq!(built.occupancy.pending[1], 1);
        assert_eq!(built.occupancy.storage_free, Occupancy::STORAGE - 4);
        // the day's check ran: a holding stands here, so the wide daily draw
        // decides (and the next check is tomorrow)
        let expect = wide_daily_camp(
            &camp_seed(&pd).unwrap(),
            coord(),
            &t,
            b / DAY_BELLS,
            true,
            Some(keep_tile),
        );
        assert_eq!(built.camp_checked, Some(expect.is_some()));
        assert_eq!(built.camp.next_check_day, b / DAY_BELLS + 1);
        // the holding's garrison is the holding's own reference, then the
        // camp when one spawned, then the keep
        let keep_at = match expect {
            Some(cmp) => {
                assert_eq!(built.gar_site, vec![2, CAMP_SITE, KEEP_SITE]);
                assert_eq!(built.camp.tile, cmp.tile);
                assert_eq!(built.camp.troops, cmp.troops);
                assert_eq!(built.camp.gen, 1);
                assert_eq!(
                    built.garrisons[1].id,
                    WideCombatant::Camp { key: key(), gen: 1 }
                );
                assert_eq!(built.garrisons[1].faction, NEUTRAL);
                assert_eq!(built.garrisons[1].tile, cmp.tile);
                2
            }
            None => {
                assert_eq!(built.gar_site, vec![2, KEEP_SITE]);
                1
            }
        };
        assert_eq!(built.garrisons[0].id, WideCombatant::Host(host(2, 1, 0)));
        assert_eq!(built.garrisons[0].id, WideCombatant::Host(a.holding_ref()));
        assert_eq!(built.garrisons[0].faction, 0);
        assert_eq!(built.garrisons[0].tile, t.sites[2]);
        assert_eq!(built.garrisons[0].troops, 4_000_000);
        let keep_g = &built.garrisons[keep_at];
        assert_eq!(keep_g.id, WideCombatant::Keep { key: key(), gen: 0 });
        assert_eq!(keep_g.faction, HOLDER);
        assert_eq!(keep_g.tile, keep_tile);
        assert_eq!(keep_g.troops, 100 * MILLI as u32);
        assert!(keep_g.walls);
        assert_eq!(built.keep_id(), Some(keep_g.id));
        // the kernel accepts the input
        let out = resolve(&frontier_ruleset(), &built, &sha256(&[b"bell"])).unwrap();
        assert_eq!(out.fighters.len(), 2);
    }

    /// A dense legacy id, an alias without its reference and a reference
    /// without its entry are each refused before anything is built.
    #[test]
    fn build_refuses_unpaired_and_legacy_entries() {
        let b = 300;
        let (pd0, t, keep_tile) = province(b, 72);
        let (roster, rd0) = roster();
        let field = free_tile(&t, Some(keep_tile));
        // a dense legacy id passes the pairing (no reference) and is refused
        // at the lookup
        let mut pd = pd0.clone();
        write_entry(
            &mut pd,
            3,
            &Entry {
                id: crate::addr::host_id(3, -1, 2, 1, 9).unwrap(),
                faction: 0,
                unit: unit_to_u8(UnitType::Spearman),
                tile: field,
                state: E::STATE_ROSTER,
                troops: 1_000_000,
                stamina_value: 120,
                dealt_bps: 0,
                stamina_bell: 0,
                ready_bell: 0,
                from_bell: 0,
                pend_bell: 0,
                op: EntryOp::None,
            },
        )
        .unwrap();
        assert_eq!(
            build(&pd, &roster, &rd0, None, b).err(),
            Some(ResolveError::LegacyEntry(3))
        );
        // Pending, departed and future entries must not bypass identity checks.
        for state in [E::STATE_MUSTER_PENDING, E::STATE_DEPARTED, E::STATE_ROSTER] {
            pd[P::entry(3) + E::STATE] = state;
            pd[P::entry(3) + E::FROM_BELL..P::entry(3) + E::FROM_BELL + 4]
                .copy_from_slice(&(b + 2).to_le_bytes());
            let before = pd.clone();
            let mut rd = rd0.clone();
            assert_eq!(
                build(&pd, &roster, &rd, None, b).err(),
                Some(ResolveError::LegacyEntry(3))
            );
            assert_eq!(
                settle(&mut pd, &roster, &mut rd, b).err(),
                Some(ResolveError::LegacyEntry(3))
            );
            assert_eq!(pd, before);
            assert_eq!(rd, rd0);
        }
        // an alias with no reference at its index
        let mut pd = pd0.clone();
        let mut rd = rd0.clone();
        let sp = UnitType::Spearman;
        let alias = resident(
            &mut pd,
            &roster,
            &mut rd,
            4,
            host(2, 1, 1),
            0,
            sp,
            1_000_000,
            field,
        );
        assert!(is_wide_alias(alias));
        let bare = rd0.clone();
        assert_eq!(
            build(&pd, &roster, &bare, None, b).err(),
            Some(ResolveError::Roster(RosterError::Paired { index: 4 }))
        );
        // a reference with no live entry
        assert_eq!(
            build(&pd0, &roster, &rd, None, b).err(),
            Some(ResolveError::Roster(RosterError::Paired { index: 4 }))
        );
        // another roster's record
        let other = WideRoster::new(SEASON + 1, key(), RENT_TO);
        assert_eq!(
            build(&pd, &other, &rd, None, b).err(),
            Some(ResolveError::Roster(RosterError::Header))
        );
        // the paired tables build
        assert!(build(&pd, &roster, &rd, None, b).is_ok());
    }

    /// S1/S2 state is refused, as are foreign ClashInputs and a bell that
    /// is not due.
    #[test]
    fn build_refuses_unported_state_and_foreign_inputs() {
        let b = 300;
        let (pd0, _, _) = province(b, 72);
        let (roster, rd) = roster();
        let mut pd = pd0.clone();
        pd[P2::record(1) + CR::KIND] = CR::KIND_SIEGE;
        assert_eq!(
            build(&pd, &roster, &rd, None, b).err(),
            Some(ResolveError::Unported(Unported::ConquestRecord(1)))
        );
        let mut pd = pd0.clone();
        pd[FR::at(0) + FR::STATE] = FR::STATE_LIVE;
        assert_eq!(
            build(&pd, &roster, &rd, None, b).err(),
            Some(ResolveError::Unported(Unported::Fort))
        );
        let mut pd = pd0.clone();
        let o = crate::v2::layout::province::caravan_slot::at(0);
        pd[o..o + 8].copy_from_slice(&7u64.to_le_bytes());
        assert_eq!(
            build(&pd, &roster, &rd, None, b).err(),
            Some(ResolveError::Unported(Unported::Caravan))
        );
        // ClashInputs of another bell
        let ci = inputs_with(b + 1, &[]);
        assert_eq!(
            build(&pd0, &roster, &rd, Some(&ci), b).err(),
            Some(ResolveError::InputsMismatch)
        );
        // the bell is not due
        let mut pd = pd0.clone();
        let mut rd2 = rd.clone();
        assert_eq!(
            resolve_bell(
                &mut pd,
                &roster,
                &mut rd2,
                None,
                b + 1,
                &[0; 32],
                &frontier_ruleset(),
                &prm(72),
            )
            .err(),
            Some(ResolveError::NotDue {
                next: b,
                bell: b + 1
            })
        );
    }

    /// A contested bell end to end: two hosts of one faction stand on the
    /// keep with equal troops; the keep falls at the first counted bell
    /// (`keep_bells` 1) and the donor is the host with the **lowest full
    /// identity**, not the first entry; the donor's hand-off is the
    /// deployed retire-Leave; the roster stays paired; the summary fields
    /// advance.
    #[test]
    fn resolve_bell_takes_the_keep_with_the_full_identity_donor() {
        let b = 600; // b % 6 == 0: the hour snapshot is written too
        let (mut pd, _t, keep_tile) = province(b, 1);
        let (roster, mut rd) = roster();
        holding(&mut pd, 2, 1, 1, 4_000_000);
        // entry 0 holds the higher identity, entry 1 the lower
        let hi = host(2, 1, 9);
        let lo = host(2, 1, 2);
        assert!(lo < hi);
        let troops = 9_000_000;
        let sp = UnitType::Spearman;
        resident(&mut pd, &roster, &mut rd, 0, hi, 1, sp, troops, keep_tile);
        resident(&mut pd, &roster, &mut rd, 1, lo, 1, sp, troops, keep_tile);
        let before = pd.clone();
        let out = resolve_bell(
            &mut pd,
            &roster,
            &mut rd,
            None,
            b,
            &sha256(&[b"bell-600"]),
            &frontier_ruleset(),
            &prm(1),
        )
        .unwrap();
        // the clash: the two hosts against the keep's garrison on its hex
        assert!(out.clash.engagements > 0, "{:?}", out.clash);
        let keep_gr = out
            .clash
            .garrisons
            .iter()
            .find(|g| g.id == WideCombatant::Keep { key: key(), gen: 0 })
            .unwrap();
        assert_eq!(keep_gr.holders, 1 << 1);
        assert!(!keep_gr.defender_present);
        assert!(keep_gr.attackers_hold);
        // Battle damage can break the starting tie: highest surviving troops,
        // then lowest full identity, is the deployed donor rule.
        let mut survivors = [lo, hi];
        survivors.sort_by(|a, b| {
            out.clash
                .fighter(&WideCombatant::Host(*b))
                .unwrap()
                .troops
                .cmp(&out.clash.fighter(&WideCombatant::Host(*a)).unwrap().troops)
                .then_with(|| a.cmp(b))
        });
        let donor = survivors[0];
        let donor_index = if donor == hi { 0 } else { 1 };
        let other_index = 1 - donor_index;
        let other = survivors[1];
        let taken = out.step.keep_taken.expect("taken");
        assert_eq!((taken.from, taken.to), (HOLDER, 1));
        assert_eq!(taken.donor, Some(donor));
        assert!(!taken.donor_removed);
        assert_eq!(out.step.event, Some(WideKeepEvent::Taken(taken)));
        assert!(out.step.roster_changed);
        assert!(out.step.snapshot.is_some());
        // the deployed split: ⌊troops × 5,000 / 10,000⌋ whole troops to the
        // keep, the rest home (the donor's post-clash troops, which the
        // keep's 100 did not reduce by a whole troop here or did: read them)
        let donor_after = out
            .clash
            .fighter(&WideCombatant::Host(donor))
            .unwrap()
            .troops as u64;
        let prm1 = prm(1).cq.keep_params();
        let whole = donor_after * prm1.garrison_bps as u64 / 10_000 / MILLI as u64;
        assert_eq!(taken.garrison as u64, whole);
        assert_eq!(taken.donor_rest as u64, donor_after - whole * MILLI as u64);
        let k = read_keep(&pd).unwrap().unwrap();
        assert_eq!(k.holder, 1);
        assert_eq!(k.troops, taken.garrison);
        assert_eq!(k.gen, 1);
        assert_eq!(k.changes, 1);
        assert_eq!(k.last_taken_from, HOLDER);
        assert_eq!(k.consolidated_until_bell, b + 1 + prm1.consolidate_bells);
        assert_eq!(rd_u16(&pd, P2::keeps_taken_by(1)), Some(1));
        // the donor's entry: the deployed retire-Leave hand-off
        let e = ent(&pd, donor_index).unwrap();
        assert_eq!(e[E::STATE], E::STATE_DEPARTED);
        assert_eq!(e[E::PEND_OP], E::OP_LEAVE);
        assert_eq!(e[E::OP_A], RETIRE_OP_A);
        assert_eq!(g32(e, E::PEND_BELL), b);
        assert_eq!(g32(e, E::TROOPS), taken.donor_rest);
        assert_eq!(g64(e, E::ID), wide_host_alias(&donor));
        // the other host stays, engaged, with the clash's troops
        let e0 = ent(&pd, other_index).unwrap();
        assert_eq!(e0[E::STATE], E::STATE_ROSTER);
        let hi_after = out.clash.fighter(&WideCombatant::Host(other)).unwrap();
        assert_eq!(g32(e0, E::TROOPS), hi_after.troops);
        assert_eq!(g32(e0, E::STAMINA_BELL), b);
        assert_eq!(g32(e0, E::READY_BELL), kc::ready_bell_after(b));
        // the roster is still paired (both entries live: states 1 and 3)
        roster
            .validate_paired(&rd, &live_ids(&pd).unwrap())
            .unwrap();
        assert_eq!(roster.ref_at(&rd, 0).unwrap(), Some(hi));
        assert_eq!(roster.ref_at(&rd, 1).unwrap(), Some(lo));
        // the bell is finished: resolved_next, the territory cursor, the
        // holder's bell scored before the capture took effect
        assert_eq!(rd_u32(&pd, P::RESOLVED_NEXT), Some(b + 1));
        assert_eq!(rd_u32(&pd, P2::SCORE_NEXT_BELL), Some(b + 1));
        assert_eq!(
            rd_u64(&pd, P2::TERRITORY_BELLS + 8 * HOLDER as usize),
            Some(1)
        );
        assert_eq!(rd_u8(&pd, P::N_ENTRIES), Some(2));
        // the identity trailer is untouched
        assert_eq!(
            WideProvince::read(&pd).unwrap(),
            WideProvince::read(&before).unwrap()
        );
        // the next bell builds (the departed donor is not a resident) and
        // settles the retire-Leave nothing further: still paired
        let built = build(&pd, &roster, &rd, None, b + 1).unwrap();
        assert_eq!(built.res_entry, vec![other_index as u8]);
    }

    #[test]
    fn equal_post_clash_donors_use_full_identity_not_entry_order() {
        let b = 600;
        for reverse in [false, true] {
            let (mut pd, _, tile) = province(b, 1);
            let (roster, mut rd) = roster();
            let mut keep = read_keep(&pd).unwrap().unwrap();
            keep.troops = 0;
            write_keep(&mut pd, &keep).unwrap();
            let lo = host(2, 1, 2);
            let hi = host(2, 1, 9);
            let ids = if reverse { [lo, hi] } else { [hi, lo] };
            for (i, id) in ids.into_iter().enumerate() {
                resident(
                    &mut pd,
                    &roster,
                    &mut rd,
                    i,
                    id,
                    1,
                    UnitType::Spearman,
                    9_000_000,
                    tile,
                );
            }
            let out = resolve_bell(
                &mut pd,
                &roster,
                &mut rd,
                None,
                b,
                &sha256(&[b"equal-donors"]),
                &frontier_ruleset(),
                &prm(1),
            )
            .unwrap();
            assert_eq!(
                out.clash.fighter(&WideCombatant::Host(lo)).unwrap().troops,
                out.clash.fighter(&WideCombatant::Host(hi)).unwrap().troops
            );
            assert_eq!(out.step.keep_taken.unwrap().donor, Some(lo));
            roster
                .validate_paired(&rd, &live_ids(&pd).unwrap())
                .unwrap();
        }
    }

    fn rd_u8(d: &[u8], o: usize) -> Option<u8> {
        d.get(o).copied()
    }

    /// An arrival that stays is written as an entry whose id is the alias
    /// of its full reference, claimed in the roster; the ClashInputs take
    /// its fate; a destroyed resident is released from the roster.
    #[test]
    fn arrivals_claim_and_destroyed_residents_release_roster_slots() {
        let b = 301;
        let (mut pd, t, keep_tile) = province(b, 72);
        let (roster, mut rd) = roster();
        let field = free_tile(&t, Some(keep_tile));
        let far = (1..PROVINCE_TILES as u8)
            .rev()
            .find(|&x| t.passable(x) && !t.is_site(x) && x != keep_tile && x != field)
            .unwrap();
        // a tiny resident of faction 2 on `field`; a large arrival of
        // faction 0 onto the same tile destroys it
        let weak = host(5, 1, 1);
        let sp = UnitType::Spearman;
        resident(&mut pd, &roster, &mut rd, 3, weak, 2, sp, 100_000, field);
        let strong = host(7, 2, 1);
        let quiet = host(7, 2, 2);
        let mut ci = inputs_with(
            b,
            &[
                (
                    WCI::position(0, 0),
                    arrival(strong, 0, UnitType::Knight, 20_000_000, field),
                ),
                (
                    WCI::position(3, 1),
                    arrival(quiet, 3, UnitType::Archer, 2_000_000, far),
                ),
            ],
        );
        let built = build(&pd, &roster, &rd, Some(&ci), b).unwrap();
        assert_eq!(built.arrivals.len(), 2);
        assert_eq!(built.arr_pos.len(), 2);
        let out = resolve(&frontier_ruleset(), &built, &sha256(&[b"bell-301"])).unwrap();
        let ap = apply(&mut pd, &roster, &mut rd, &built, &out).unwrap();
        let strong_fate = out.fighter(&WideCombatant::Host(strong)).unwrap().fate;
        let weak_fate = out.fighter(&WideCombatant::Host(weak)).unwrap().fate;
        assert_eq!(weak_fate, Fate::Destroyed, "{out:?}");
        assert_eq!(strong_fate, Fate::Stays { tile: field }, "{out:?}");
        assert_eq!(ap.destroyed, 1);
        assert_eq!(ap.fates[WCI::position(0, 0)], WA::FATE_STAYS);
        assert_eq!(ap.fates[WCI::position(3, 1)], WA::FATE_STAYS);
        assert_eq!(ap.fates[WCI::position(1, 0)], WA::FATE_NONE);
        // the destroyed resident's entry and roster slot are gone
        assert!(ent(&pd, 3).unwrap().iter().all(|x| *x == 0));
        assert_eq!(roster.ref_at(&rd, 3).unwrap(), None);
        // the arrivals took the first free entries, in identity order,
        // with claimed aliases
        let e0 = ent(&pd, 0).unwrap();
        let e1 = ent(&pd, 1).unwrap();
        assert_eq!(e0[E::STATE], E::STATE_ROSTER);
        assert_eq!(e1[E::STATE], E::STATE_ROSTER);
        assert_eq!(g64(e0, E::ID), wide_host_alias(&strong));
        assert_eq!(g64(e1, E::ID), wide_host_alias(&quiet));
        assert_eq!(roster.ref_at(&rd, 0).unwrap(), Some(strong));
        assert_eq!(roster.ref_at(&rd, 1).unwrap(), Some(quiet));
        assert_eq!(e0[E::FACTION], 0);
        assert_eq!(e0[E::TILE], field);
        assert_eq!(g32(e0, E::FROM_BELL), b + 1);
        assert_eq!(g32(e1, E::READY_BELL), b + 1);
        assert_eq!(g32(e0, E::READY_BELL), kc::ready_bell_after(b));
        roster
            .validate_paired(&rd, &live_ids(&pd).unwrap())
            .unwrap();
        // the ClashInputs take the fates
        write_resolved(&mut ci, &ap).unwrap();
        let hdr = WideClashInputsHdr::read(&ci).unwrap();
        assert_eq!(hdr.flags & WCI::FLAG_RESOLVED, WCI::FLAG_RESOLVED);
        let a = WideArrival::read_at(&ci, WCI::position(0, 0))
            .unwrap()
            .unwrap();
        assert_eq!(a.fate, WA::FATE_STAYS);
        assert_eq!(
            a.troops_after,
            out.fighter(&WideCombatant::Host(strong)).unwrap().troops
        );
        // the same arrival again is a duplicate the roster refuses
        let built2 = build(&pd, &roster, &rd, None, b + 1).unwrap();
        assert_eq!(built2.res_entry, vec![0, 1]);
    }

    /// `settle` releases what `settle_bell` zeroes (a forfeit) and keeps
    /// what it only re-states (a muster coming due).
    #[test]
    fn settle_keeps_the_roster_paired() {
        let b = 302;
        let (mut pd, t, keep_tile) = province(b, 72);
        let (roster, mut rd) = roster();
        let field = free_tile(&t, Some(keep_tile));
        let sp = UnitType::Spearman;
        resident(
            &mut pd,
            &roster,
            &mut rd,
            0,
            host(2, 1, 1),
            0,
            sp,
            1_000_000,
            field,
        );
        let e0 = P::entry(0);
        pd[e0 + E::PEND_OP] = E::OP_FORFEIT;
        pd[e0 + E::PEND_BELL..e0 + E::PEND_BELL + 4].copy_from_slice(&b.to_le_bytes());
        resident(
            &mut pd,
            &roster,
            &mut rd,
            1,
            host(2, 1, 2),
            0,
            sp,
            1_000_000,
            field,
        );
        let e1 = P::entry(1);
        pd[e1 + E::STATE] = E::STATE_MUSTER_PENDING;
        pd[e1 + E::FROM_BELL..e1 + E::FROM_BELL + 4].copy_from_slice(&(b + 1).to_le_bytes());
        assert!(settle(&mut pd, &roster, &mut rd, b).unwrap());
        assert!(ent(&pd, 0).unwrap().iter().all(|x| *x == 0));
        assert_eq!(roster.ref_at(&rd, 0).unwrap(), None);
        assert_eq!(ent(&pd, 1).unwrap()[E::STATE], E::STATE_ROSTER);
        assert_eq!(roster.ref_at(&rd, 1).unwrap(), Some(host(2, 1, 2)));
        roster
            .validate_paired(&rd, &live_ids(&pd).unwrap())
            .unwrap();
    }

    #[test]
    fn unported_packed_identity_operations_refuse_before_mutation() {
        let b = 302;
        let (mut pd, t, keep_tile) = province(b, 72);
        let (roster, mut rd) = roster();
        let field = free_tile(&t, Some(keep_tile));
        resident(
            &mut pd,
            &roster,
            &mut rd,
            0,
            host(2, 1, 1),
            0,
            UnitType::Spearman,
            1_000_000,
            field,
        );
        for op in [E::OP_SPLIT, E::OP_ABSORB, E::OP_ABSORBED_INTO] {
            pd[P::entry(0) + E::PEND_OP] = op;
            let before = pd.clone();
            let refs = rd.clone();
            let expected = Some(ResolveError::Unported(Unported::PendingOp(op)));
            assert_eq!(build(&pd, &roster, &rd, None, b).err(), expected);
            assert_eq!(settle(&mut pd, &roster, &mut rd, b).err(), expected);
            assert_eq!(pd, before);
            assert_eq!(rd, refs);
        }
    }

    #[test]
    fn pending_garrison_settles_before_hour_snapshot() {
        let b = 600;
        let (mut pd, _, _) = province(b, 72);
        let (roster, mut rd) = roster();
        let mut camp = Camp::read(&pd).unwrap();
        camp.next_check_day = b / DAY_BELLS + 1;
        camp.write(&mut pd).unwrap();
        holding(&mut pd, 2, 1, 1, 0);
        pd[P::site(2) + SM::ORDER] = 1;
        pd[P::site(2) + SM2::TIER_NEXT] = SM2::NO_TIER_NEXT;
        put_garrison(
            &mut pd,
            2,
            &permutation_rules::frontier::host::GarrisonState {
                troops: 0,
                pending: [Some((b, 1_000_000)), None],
            },
        )
        .unwrap();
        let out = resolve_bell(
            &mut pd,
            &roster,
            &mut rd,
            None,
            b,
            &sha256(&[b"garrison-snapshot"]),
            &frontier_ruleset(),
            &prm(72),
        )
        .unwrap();
        assert!(out.settled);
        let g = garrison_of(&pd, 2).unwrap();
        assert_eq!(g.troops, 1_000_000);
        assert_eq!(g.pending, [None, None]);
        assert_eq!(out.step.snapshot.unwrap()[1], 150);
        assert_eq!(
            crate::conquest_model::snapshot_slot(&pd, b / HOUR_BELLS)
                .unwrap()
                .unwrap()[1],
            150
        );
    }

    #[test]
    fn keep_only_damage_advances_roster_epoch() {
        let b = 601;
        let (mut pd, _, tile) = province(b, 72);
        let (roster, mut rd) = roster();
        let refs = rd.clone();
        let mut camp = Camp::read(&pd).unwrap();
        camp.next_check_day = b / DAY_BELLS + 1;
        camp.write(&mut pd).unwrap();
        pd[P::ROSTER_EPOCH..P::ROSTER_EPOCH + 4].copy_from_slice(&7u32.to_le_bytes());
        let a = arrival(host(2, 1, 1), 1, UnitType::Spearman, 1_000, tile);
        let ci = inputs_with(b, &[(WCI::position(1, 0), a)]);
        let out = resolve_bell(
            &mut pd,
            &roster,
            &mut rd,
            Some(&ci),
            b,
            &sha256(&[b"keep-only-damage"]),
            &frontier_ruleset(),
            &prm(72),
        )
        .unwrap();
        assert!(!out.applied.changed);
        assert!(out.applied.keep_changed);
        assert!(!out.settled && !out.step.roster_changed);
        assert_eq!(
            out.clash
                .fighter(&WideCombatant::Host(a.host))
                .unwrap()
                .fate,
            Fate::Destroyed
        );
        assert!(read_keep(&pd).unwrap().unwrap().troops < 100);
        assert_eq!(rd_u32(&pd, P::ROSTER_EPOCH), Some(8));
        assert_eq!(pd[P::N_ENTRIES], 0);
        assert_eq!(rd, refs);
    }

    /// A quiet province resolves as a real bell: no SkipQuiet, the camp's
    /// day check, the territory score, the snapshot and `resolved_next`
    /// all advance through the kernel.
    #[test]
    fn a_quiet_bell_is_a_real_resolve() {
        let b = 144 * 3; // a new day, an hour's first bell
        let (mut pd, _, _) = province(b, 72);
        let (roster, mut rd) = roster();
        let out = resolve_bell(
            &mut pd,
            &roster,
            &mut rd,
            None,
            b,
            &sha256(&[b"quiet"]),
            &frontier_ruleset(),
            &prm(72),
        )
        .unwrap();
        assert_eq!(out.clash.engagements, 0);
        assert_eq!(out.clash.fighters.len(), 0);
        assert_eq!(out.clash.garrisons.len(), 1);
        // the day's check ran and spawned nothing (no holding): as deployed,
        // only a spawn counts as a change, but the check's day advanced
        assert!(!out.applied.changed);
        assert!(!out.applied.keep_changed);
        assert_eq!(out.step.keep_taken, None);
        assert_eq!(out.step.event, None);
        assert!(out.step.snapshot.is_some());
        assert!(!out.step.active);
        assert!(!out.settled);
        assert_eq!(Camp::read(&pd).unwrap().next_check_day, b / DAY_BELLS + 1);
        // no holding: the deployed rule spawns nothing
        assert_eq!(Camp::read(&pd).unwrap().state, CP::STATE_NONE);
        assert_eq!(rd_u32(&pd, P::RESOLVED_NEXT), Some(b + 1));
        assert_eq!(
            rd_u64(&pd, P2::TERRITORY_BELLS + 8 * HOLDER as usize),
            Some(1)
        );
        // and again: the check does not run twice in a day
        let out2 = resolve_bell(
            &mut pd,
            &roster,
            &mut rd,
            None,
            b + 1,
            &sha256(&[b"quiet2"]),
            &frontier_ruleset(),
            &prm(72),
        )
        .unwrap();
        assert!(!out2.applied.changed);
        assert_eq!(out2.step.snapshot, None);
        assert_eq!(rd_u32(&pd, P::RESOLVED_NEXT), Some(b + 2));
    }
}
