//! What a conquest bot sees (MC contract v1.3 §8.4, §8.6; unit CQ2-F):
//! the herald's MC files, decoded here independently of the herald (its
//! `cqfmt.rs` is the reference and `frontier-node/fixtures/cq/formats/`
//! the vectors both readers are tested on), and the planner's
//! [`World`] built from the herald's immutable files of one epoch.
//!
//! | reader | herald file |
//! |---|---|
//! | [`ControlFile`] | `GET /h/control/{bell}.bin` (`PSFCT1`) |
//! | [`Overview2`] | `GET /h/overview2/{ring}/{bell}.bin` (`PSFOV2`) |
//! | [`SiegesFile`] | `GET /h/sieges/{bell}.json` |
//! | [`world_from_herald`] | Province v2 accounts of `GET /h/province/{P},{Q}/{bell}`, the fleet's Citizens and Holdings (`GET /h/me/{wallet}`), the Season's `ConquestParams` |
//!
//! The herald is never a trust root: every account arrives as bytes and
//! is decoded here with `frontier-abi`'s v2 layouts and `conquest_model`'s
//! record readers.

use std::collections::{BTreeMap, BTreeSet};

use frontier_abi::conquest_model::{read_keep, Record};
use frontier_abi::layout::province::entry as E;
use frontier_abi::v2::layout::player::{citizen as C2, holding as H2};
use frontier_abi::v2::layout::province::{conquest as CR, province as P2, site as S2};
use frontier_abi::v2::presets::ConquestParams;
use permutation_rules::frontier::catalog;
use permutation_rules::frontier::doctrine::DOCTRINES;
use permutation_rules::frontier::geometry::{
    march_members, march_of, provinces_within, MarchCoord, ProvinceCoord,
};
use permutation_rules::frontier::holding::RESOURCES;
use permutation_rules::frontier::siege::Vigil;
use permutation_rules::frontier::travel::BELL_SECS;
use serde_json::Value;

use crate::campaign::{
    AgentView, HoldView, HostState, HostView, Mission, Params, ProvView, SiegeView, World,
    ALL_FACTIONS, NONE,
};
use crate::obs::ObsError;
use crate::profile::Arch;

fn bad<T>(m: impl Into<String>) -> Result<T, ObsError> {
    Err(ObsError(m.into()))
}

fn u16_at(b: &[u8], o: usize) -> u16 {
    u16::from_le_bytes([b[o], b[o + 1]])
}
fn u32_at(b: &[u8], o: usize) -> u32 {
    u32::from_le_bytes(b[o..o + 4].try_into().expect("4"))
}
fn i16_at(b: &[u8], o: usize) -> i16 {
    i16::from_le_bytes([b[o], b[o + 1]])
}
fn i64_at(b: &[u8], o: usize) -> i64 {
    i64::from_le_bytes(b[o..o + 8].try_into().expect("8"))
}
fn u64_at(b: &[u8], o: usize) -> u64 {
    u64::from_le_bytes(b[o..o + 8].try_into().expect("8"))
}

// ------------------------------------------------------------------ PSFCT1

pub const CONTROL_MAGIC: &[u8; 8] = b"PSFCT1\0\0";
const CONTROL_HEADER: usize = 32;
/// Largest ring a control file covers (CF-1).
pub const CONTROL_MAX_RING: u32 = 127;
/// `control`, `contender`, `points_lead`, `banner` when none.
pub const CODE_NONE: u8 = 7;

/// Province flags of `PSFCT1` (§8.4).
pub mod pflag {
    pub const CHANGED: u8 = 1;
    pub const CONSOLIDATING: u8 = 2;
    pub const HEARTLAND: u8 = 4;
    pub const SEAT_OR_CONCORD: u8 = 8;
    pub const KEEP_TAKEN: u8 = 16;
    pub const CONTEST_BROKEN: u8 = 32;
    pub const CLASH: u8 = 64;
}

/// One province record of a control file.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ControlProvince {
    pub index: u32,
    pub coord: ProvinceCoord,
    pub control: u8,
    pub contender: u8,
    pub progress: u8,
    pub required: u8,
    pub flags: u8,
    pub sieges: u8,
    pub occupations: u8,
    pub points_lead: u8,
    pub points_share: u8,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ControlMarch {
    pub march: MarchCoord,
    pub banner: u8,
    pub points_lead: u8,
    pub keeps: u8,
    pub flags: u8,
}

/// `/h/control/{bell}.bin`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ControlFile {
    pub season: u64,
    pub bell: u32,
    /// Rings 0..=`rings` (CF-1).
    pub rings: u32,
    pub provinces: Vec<ControlProvince>,
    pub marches: Vec<ControlMarch>,
}

/// The Marches of a control file of rings 0..=`rings`, in file order
/// (CF-2): every March with a member in those rings, by centre index.
pub fn march_order(rings: u32) -> Vec<MarchCoord> {
    let mut set = BTreeSet::new();
    for i in 0..provinces_within(rings.min(CONTROL_MAX_RING)) {
        let m = march_of(ProvinceCoord::from_index(i));
        set.insert((march_members(m)[0].index(), m.m, m.n));
    }
    set.into_iter()
        .map(|(_, m, n)| MarchCoord { m, n })
        .collect()
}

impl ControlFile {
    pub fn decode(b: &[u8]) -> Result<ControlFile, ObsError> {
        if b.len() < CONTROL_HEADER || &b[..8] != CONTROL_MAGIC {
            return bad("control: magic");
        }
        let n_prov = u16_at(b, 20) as u32;
        let n_march = u16_at(b, 22) as usize;
        if b[24..32].iter().any(|&x| x != 0) {
            return bad("control: reserved");
        }
        if b.len() != CONTROL_HEADER + 8 * n_prov as usize + 4 * n_march {
            return bad("control: length");
        }
        let Some(rings) = (0..=CONTROL_MAX_RING).find(|&d| provinces_within(d) == n_prov) else {
            return bad("control: province count");
        };
        let order = march_order(rings);
        if order.len() != n_march {
            return bad("control: march count");
        }
        let mut provinces = Vec::with_capacity(n_prov as usize);
        for i in 0..n_prov {
            let o = CONTROL_HEADER + 8 * i as usize;
            let r = &b[o..o + 8];
            if r[4] & 128 != 0 {
                return bad("control: province flag 128");
            }
            provinces.push(ControlProvince {
                index: i,
                coord: ProvinceCoord::from_index(i),
                control: r[0],
                contender: r[1],
                progress: r[2],
                required: r[3],
                flags: r[4],
                sieges: r[5] & 0x0F,
                occupations: r[5] >> 4,
                points_lead: r[6],
                points_share: r[7],
            });
        }
        let base = CONTROL_HEADER + 8 * n_prov as usize;
        let mut marches = Vec::with_capacity(n_march);
        for (j, m) in order.into_iter().enumerate() {
            let r = &b[base + 4 * j..base + 4 * j + 4];
            marches.push(ControlMarch {
                march: m,
                banner: r[0],
                points_lead: r[1],
                keeps: r[2],
                flags: r[3],
            });
        }
        Ok(ControlFile {
            season: u64_at(b, 8),
            bell: u32_at(b, 16),
            rings,
            provinces,
            marches,
        })
    }

    /// Opened provinces (control ≠ 7) of rings ≥ 2.
    pub fn opened(&self) -> impl Iterator<Item = &ControlProvince> {
        self.provinces
            .iter()
            .filter(|p| p.control != CODE_NONE && p.coord.ring() >= 2)
    }

    /// Provinces whose keep faction `f` holds.
    pub fn held_by(&self, f: u8) -> usize {
        self.provinces
            .iter()
            .filter(|p| p.coord.ring() >= 2 && p.control == f)
            .count()
    }
}

// ------------------------------------------------------------------ PSFOV2

pub const OVERVIEW2_MAGIC: &[u8; 8] = b"PSFOV2\0\0";
const OVERVIEW2_RECORD: usize = 40;

/// Site kinds of `PSFOV2` (bytes 32–34).
pub mod site_kind {
    pub const FIRST: u8 = 0;
    pub const OTHER: u8 = 1;
    pub const FREE_CITY: u8 = 2;
    pub const NONE: u8 = 3;
}

/// Siege states of `PSFOV2` (bytes 29–31).
pub mod siege_state {
    pub const NONE: u8 = 0;
    pub const PROGRESSING: u8 = 1;
    pub const PAUSED: u8 = 2;
    pub const CAPTURE_DUE: u8 = 3;
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Overview2Rec {
    /// Bytes 0–23: exactly the `PSFOV1` record.
    pub v1: crate::obs::OverviewRec,
    pub occupiers: [u8; 12],
    pub sieges: [u8; 12],
    pub kinds: [u8; 12],
    /// `None` without a keep (rings 0–1).
    pub keep_tile: Option<u8>,
    pub keep_troops: u16,
    pub immune: [bool; 12],
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Overview2 {
    pub season: u64,
    pub ring: u16,
    pub bell: u32,
    pub provinces: Vec<Overview2Rec>,
}

fn bits(b: &[u8], width: u32) -> [u8; 12] {
    let mut v = 0u64;
    for (i, x) in b.iter().enumerate() {
        v |= (*x as u64) << (8 * i);
    }
    core::array::from_fn(|s| ((v >> (width as usize * s)) & ((1 << width) - 1)) as u8)
}

impl Overview2 {
    pub fn decode(b: &[u8]) -> Result<Overview2, ObsError> {
        if b.len() < 32 || &b[..8] != OVERVIEW2_MAGIC {
            return bad("overview2: magic");
        }
        let n = u16_at(b, 18) as usize;
        if b.len() != 32 + n * OVERVIEW2_RECORD {
            return bad("overview2: length");
        }
        // The v1 record decoder reads bytes 0–23 of each record.
        let mut v1 = b[..32].to_vec();
        v1[..8].copy_from_slice(crate::obs::OVERVIEW_MAGIC);
        for i in 0..n {
            let o = 32 + i * OVERVIEW2_RECORD;
            v1.extend_from_slice(&b[o..o + 24]);
        }
        let ov1 = crate::obs::Overview::decode(&v1)?;
        let mut provinces = Vec::with_capacity(n);
        for (i, r1) in ov1.provinces.into_iter().enumerate() {
            let o = 32 + i * OVERVIEW2_RECORD;
            let r = &b[o..o + OVERVIEW2_RECORD];
            let occupiers = bits(&r[24..29], 3);
            if occupiers.contains(&6) {
                return bad("overview2: occupier 6");
            }
            if r[39] >> 4 != 0 {
                return bad("overview2: reserved");
            }
            let keep_tile = match r[35] {
                0xFF => None,
                t if t <= 60 => Some(t),
                _ => return bad("overview2: keep tile"),
            };
            let mask = r[38] as u16 | ((r[39] as u16 & 0x0F) << 8);
            provinces.push(Overview2Rec {
                v1: r1,
                occupiers,
                sieges: bits(&r[29..32], 2),
                kinds: bits(&r[32..35], 2),
                keep_tile,
                keep_troops: u16_at(r, 36),
                immune: core::array::from_fn(|s| mask & (1 << s) != 0),
            });
        }
        Ok(Overview2 {
            season: ov1.season,
            ring: ov1.ring,
            bell: ov1.bell,
            provinces,
        })
    }
}

// ------------------------------------------------------------------ sieges

/// One active holding siege of `/h/sieges/{bell}.json`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SiegeRow {
    pub p: i16,
    pub q: i16,
    pub site: u8,
    pub kind: String,
    pub owner_faction: u8,
    pub attacker_faction: u8,
    pub declared: u32,
    pub required: u32,
    pub progress: u32,
    pub paused: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct KeepRow {
    pub p: i16,
    pub q: i16,
    pub holder: u8,
    pub contender: u8,
    pub progress: u32,
    pub required: u32,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SiegesFile {
    pub bell: u32,
    pub sieges: Vec<SiegeRow>,
    pub keeps: Vec<KeepRow>,
}

fn int(v: &Value, k: &str) -> Result<i64, ObsError> {
    v.get(k)
        .and_then(|x| x.as_i64())
        .ok_or_else(|| ObsError(format!("sieges: `{k}`")))
}

impl SiegesFile {
    pub fn parse(v: &Value) -> Result<SiegesFile, ObsError> {
        if int(v, "v")? != 1 {
            return bad("sieges: v != 1");
        }
        let mut sieges = vec![];
        for s in v
            .get("sieges")
            .and_then(|x| x.as_array())
            .into_iter()
            .flatten()
        {
            sieges.push(SiegeRow {
                p: int(s, "p")? as i16,
                q: int(s, "q")? as i16,
                site: int(s, "site")? as u8,
                kind: s
                    .get("kind")
                    .and_then(|x| x.as_str())
                    .unwrap_or("")
                    .to_string(),
                owner_faction: int(s, "ownerFaction")? as u8,
                attacker_faction: int(s, "attackerFaction")? as u8,
                declared: int(s, "declared")? as u32,
                required: int(s, "required")? as u32,
                progress: int(s, "progress")? as u32,
                paused: s.get("status").and_then(|x| x.as_str()) == Some("paused"),
            });
        }
        let mut keeps = vec![];
        for k in v
            .get("keeps")
            .and_then(|x| x.as_array())
            .into_iter()
            .flatten()
        {
            keeps.push(KeepRow {
                p: int(k, "p")? as i16,
                q: int(k, "q")? as i16,
                holder: int(k, "holder")? as u8,
                contender: int(k, "contender")? as u8,
                progress: int(k, "progress")? as u32,
                required: int(k, "required")? as u32,
            });
        }
        Ok(SiegesFile {
            bell: int(v, "bell")? as u32,
            sieges,
            keeps,
        })
    }
}

// ------------------------------------------------------------------ world

/// The planner's season parameters from the Season's `ConquestParams`
/// (§5.2.5) and the planner package defaults (A-15).
pub fn params_of(cq: &ConquestParams) -> Params {
    Params {
        heartland_max_ring: cq.heartland_max_ring,
        sieges_per_day: cq.sieges_per_day as u32,
        siege_stake_gold: cq.siege_stake_gold as i64,
        dormant_after_secs: cq.dormant_after_secs as i64,
        frontier_protect_secs: cq.frontier_protect_secs as i64,
        frontier_protect_after_secs: cq.frontier_protect_after_secs as i64,
        outpost_range: cq.outpost_range,
        outpost_tier_min: cq.outpost_tier_min,
        outpost_share_bps: cq.outpost_share_bps,
        outpost_close_bells: cq.outpost_close_bells,
        ..Params::FRONTIER_7
    }
}

/// A fleet wallet the planner may assign: its archetype (from the
/// roster), Citizen v2 and Holdings (from `/h/me`).
#[derive(Clone, Debug)]
pub struct FleetWallet {
    /// The roster index (the planner's agent id).
    pub agent: u32,
    pub arch: Arch,
    pub faction: u8,
    pub citizen: Option<Vec<u8>>,
    pub holdings: Vec<Vec<u8>>,
}

/// A march of the fleet in transit (from the marchbook): the herald shows
/// only its source until it is revealed.
#[derive(Clone, Copy, Debug)]
pub struct FleetMarch {
    pub host_id: u64,
    pub dest: (i16, i16),
    pub tile: u8,
    pub arrive: u32,
    pub troops: u32,
    pub unit: u8,
    pub mission: Mission,
}

/// One epoch's herald inputs.
#[derive(Clone, Debug, Default)]
pub struct HeraldEpoch {
    /// The epoch: the last bell of the last completed game hour + 1.
    pub bell: u32,
    pub end_bell: u32,
    pub genesis_ts: i64,
    pub params: Option<Params>,
    /// Province v2 accounts of the epoch's bell, by (P, Q).
    pub provinces: BTreeMap<(i16, i16), Vec<u8>>,
    pub wallets: Vec<FleetWallet>,
    /// The fleet's own hosts' missions (marchbook), by chain host id.
    pub missions: BTreeMap<u64, Mission>,
    pub marches: Vec<FleetMarch>,
    /// The Herald's Call of the day (a March key per faction).
    pub call: Option<[u32; 6]>,
    /// The ids the planner already gave chain hosts (stable across epochs,
    /// so a campaign's attempt keeps naming its hosts); a host not named
    /// here gets a fresh id from `next_host` upward.
    pub host_ids: BTreeMap<u64, u32>,
    /// The first id never given to any host (planned or real).
    pub next_host: u32,
}

/// The chain names behind a herald world's ids.
#[derive(Clone, Debug, Default)]
pub struct WorldIds {
    /// Holding id → (P, Q, site).
    pub holds: BTreeMap<u32, (i16, i16, u8)>,
    /// Host id → chain host id.
    pub hosts: BTreeMap<u32, u64>,
    pub host_of_chain: BTreeMap<u64, u32>,
}

/// The holding id of `(P, Q, site)`: dense province index × 16 + site.
pub fn hold_id(c: ProvinceCoord, site: u8) -> u32 {
    c.index() * 16 + site as u32
}

/// A synthetic agent id for a holding whose owner the fleet does not run.
pub const FOREIGN_AGENT: u32 = 0x8000_0000;

fn tier_of(t: u8) -> permutation_rules::frontier::holding::Tier {
    crate::policy::tier_of(t)
}

/// The owner's vigil from a Citizen v2 (`VIGIL_START_MIN`,
/// `VIGIL_NEXT_MIN`, `VIGIL_FROM_TS`).
pub fn vigil_of_citizen(c: &[u8]) -> Vigil {
    let start = u16_at(c, C2::VIGIL_START_MIN) as u32 * 60;
    let next = u16_at(c, C2::VIGIL_NEXT_MIN) as u32 * 60;
    let from = i64_at(c, C2::VIGIL_FROM_TS);
    let mut v = Vigil {
        schedule: [(i64::MIN, start); 3],
        last_request: i64::MIN,
    };
    if from != 0 {
        v.schedule[2] = (from, next);
    }
    v
}

/// `(P, Q, site, gen)` of a holding.
type SiteGen = (i16, i16, u8, u8);

/// The planner's [`World`] at the epoch from the herald's files.
pub fn world_from_herald(e: &HeraldEpoch) -> Result<(World, WorldIds), ObsError> {
    let b = e.bell;
    let now = e.genesis_ts + b as i64 * BELL_SECS;
    let mut ids = WorldIds::default();
    let mut provs = BTreeMap::new();
    let mut holds = BTreeMap::new();
    let mut hosts = BTreeMap::new();
    let mut agents: BTreeMap<u32, AgentView> = BTreeMap::new();
    let mut keep_live = BTreeSet::new();
    let mut msieges = BTreeSet::new();
    let mut open_ring = 0u32;
    // Host ids: the epoch's stable ones, then fresh ones above every id
    // ever given.
    let mut next_id = e
        .next_host
        .max(e.host_ids.values().copied().max().map_or(0, |m| m + 1));
    let mut id_of = |chain: u64| -> u32 {
        e.host_ids.get(&chain).copied().unwrap_or_else(|| {
            let i = next_id;
            next_id += 1;
            i
        })
    };
    // The fleet's holdings by (P, Q, site, gen): owner, account bytes.
    let mut owned: BTreeMap<SiteGen, (u32, &[u8])> = BTreeMap::new();
    let mut vigil: BTreeMap<u32, Vigil> = BTreeMap::new();
    for w in &e.wallets {
        let (reserved, declares) = match &w.citizen {
            Some(c) if c.len() == C2::SIZE => {
                let slots = c[C2::SLOTS];
                let mut r = vec![];
                for s in [2u8, 3] {
                    if slots & C2::reserved_bit(s) != 0 {
                        r.push(s);
                    }
                }
                vigil.insert(w.agent, vigil_of_citizen(c));
                (
                    r,
                    (u16_at(c, C2::SIEGE_DAY) as u32, c[C2::SIEGES_TODAY] as u32),
                )
            }
            _ => (vec![], (0, 0)),
        };
        for h in &w.holdings {
            if h.len() != H2::SIZE {
                continue;
            }
            let key = (i16_at(h, H2::P), i16_at(h, H2::Q), h[H2::SITE], h[H2::GEN]);
            owned.insert(key, (w.agent, h.as_slice()));
        }
        agents.insert(
            w.agent,
            AgentView {
                faction: w.faction,
                arch: Some(w.arch),
                settled: false,
                declares,
                reserved,
                holdings: vec![],
            },
        );
    }
    for (&(p, q), pd) in &e.provinces {
        if pd.len() != P2::SIZE {
            return bad(format!("province {p},{q}: not a v2 Province"));
        }
        let c = ProvinceCoord::new(p as i32, q as i32);
        open_ring = open_ring.max(c.ring());
        let pi = c.index();
        let keep = read_keep(pd).map_err(|_| ObsError("keep record".into()))?;
        if keep.is_some_and(|k| k.contender != frontier_abi::v2::kernel::keep::NONE) {
            keep_live.insert(pi);
        }
        let mut sites = vec![NONE; pd[P2::SITE_COUNT].min(12) as usize];
        for (s, slot) in sites.iter_mut().enumerate() {
            let o = P2::site(s);
            let state = pd[o + S2::STATE];
            if state != S2::STATE_HOLDING && state != S2::STATE_FREE_CITY {
                continue;
            }
            let t = hold_id(c, s as u8);
            *slot = t;
            ids.holds.insert(t, (p, q, s as u8));
            let fc = state == S2::STATE_FREE_CITY;
            let gen = pd[o + S2::GEN];
            let rec = Record::read(pd, s).map_err(|_| ObsError("record".into()))?;
            let mut walls_now = u32_at(pd, o + S2::WALLS_COMMITTED);
            for (eb, dl) in [
                (S2::WALL_ITEM0_BELL, S2::WALL_ITEM0_DELTA),
                (S2::WALL_ITEM1_BELL, S2::WALL_ITEM1_DELTA),
            ] {
                if u32_at(pd, o + dl) > 0 && u32_at(pd, o + eb) <= b {
                    walls_now = walls_now.saturating_add(u32_at(pd, o + dl));
                }
            }
            let mine = owned.get(&(p, q, s as u8, gen));
            let owner = if fc {
                NONE
            } else {
                mine.map(|m| m.0).unwrap_or(FOREIGN_AGENT + t)
            };
            let (founded_ts, last_action, stock, shield) = match mine {
                Some((_, h)) => {
                    let hd = fclient::decode::Holding::decode(h)
                        .map_err(|_| ObsError("holding".into()))?;
                    (
                        hd.founded_ts,
                        hd.last_owner_action,
                        crate::policy::stores_at(&hd, now),
                        hd.shield_until,
                    )
                }
                None => {
                    // Not a fleet holding: the mirror's founding hour and
                    // shield; never dormant by the herald's view.
                    let hour = u16_at(pd, o + S2::HELD_SINCE_HOUR) as i64;
                    (
                        e.genesis_ts + hour * 6 * BELL_SECS,
                        now,
                        [0; RESOURCES],
                        e.genesis_ts + u32_at(pd, o + S2::SHIELD_UNTIL_BELL) as i64 * BELL_SECS,
                    )
                }
            };
            let (mut immune_until, mut barred) = (0u32, 0u8);
            let (mut siege, mut occupied, mut occ_faction, mut busy) = (None, false, 0u8, false);
            let mut owed = false;
            match rec.kind {
                CR::KIND_NONE => {
                    owed = rec.flags & CR::OWED_MASK != 0;
                    if rec.faction != CR::BARRED_NONE && rec.bell > b {
                        immune_until = rec.bell;
                        barred = if rec.faction == CR::BARRED_ALL {
                            ALL_FACTIONS
                        } else {
                            rec.faction
                        };
                    }
                }
                CR::KIND_SIEGE => {
                    siege = Some(SiegeView {
                        attacker_faction: rec.faction,
                        declared: rec.bell,
                        required: rec.required as u32,
                    });
                    msieges.insert(t);
                }
                CR::KIND_OCCUPATION => {
                    occupied = true;
                    occ_faction = rec.faction;
                }
                _ => busy = true,
            }
            holds.insert(
                t,
                HoldView {
                    owner,
                    faction: pd[o + S2::FACTION],
                    prov: pi,
                    tile: pd[P2::SITES + s],
                    // The mirror's ORDER is 1-based (a first holding 1, an
                    // outpost 2 and 3: SettleTicket writes `slot.max(1)`;
                    // the kernel weights use `ORDER - 1`); a Free City 0.
                    order: if fc { 0 } else { pd[o + S2::ORDER] },
                    tier: tier_of(pd[o + S2::TIER]),
                    garrison: u32_at(pd, o + S2::GARRISON),
                    walls: u32_at(pd, o + S2::WALLS_COMMITTED),
                    walls_now,
                    founded_ts,
                    last_owner_action: last_action,
                    alive: true,
                    shield_until: shield,
                    immune_until,
                    barred,
                    siege,
                    occupied,
                    occ_faction,
                    busy,
                    owed,
                    vigil: vigil.get(&owner).copied().unwrap_or(Vigil {
                        schedule: [(i64::MIN, 0); 3],
                        last_request: i64::MIN,
                    }),
                    stock,
                },
            );
            if owner != NONE {
                let a = agents.entry(owner).or_insert(AgentView {
                    faction: pd[o + S2::FACTION],
                    arch: None,
                    settled: false,
                    declares: (0, 0),
                    reserved: vec![],
                    holdings: vec![],
                });
                a.holdings.push(t);
                a.settled = true;
            }
        }
        // Hosts in the roster.
        let mut stationed = vec![];
        for i in 0..P2::ENTRIES_N {
            let o = P2::entry(i);
            let st = pd[o + E::STATE];
            if st != E::STATE_ROSTER && st != E::STATE_MUSTER_PENDING {
                continue;
            }
            let chain = u64_at(pd, o + E::ID);
            let id = id_of(chain);
            ids.hosts.insert(id, chain);
            ids.host_of_chain.insert(chain, id);
            let home_key = frontier_abi::addr::split_host_id(chain);
            let home = home_key
                .map(|h| hold_id(h.province, h.site))
                .unwrap_or(NONE);
            let unit = catalog::unit_of(pd[o + E::UNIT])
                .unwrap_or(permutation_rules::units::UnitType::Spearman);
            hosts.insert(
                id,
                HostView {
                    owner: NONE,
                    home,
                    faction: pd[o + E::FACTION],
                    unit,
                    troops: u32_at(pd, o + E::TROOPS),
                    state: HostState::Stationed {
                        from: u32_at(pd, o + E::FROM_BELL),
                    },
                    prov: pi,
                    tile: pd[o + E::TILE],
                    mission: e.missions.get(&chain).copied().unwrap_or(Mission::Other),
                    retreat: None,
                    chain: Some(chain),
                },
            );
            stationed.push(id);
        }
        provs.insert(
            pi,
            ProvView {
                coord: c,
                march: march_members(march_of(c))[0].index(),
                sites,
                stationed,
                keep,
            },
        );
    }
    // Hosts' owners: their home holding's owner.
    for h in hosts.values_mut() {
        h.owner = holds.get(&h.home).map(|x| x.owner).unwrap_or(NONE);
    }
    // The fleet's marches in transit.
    for m in &e.marches {
        let c = ProvinceCoord::new(m.dest.0 as i32, m.dest.1 as i32);
        if ids.host_of_chain.contains_key(&m.host_id) {
            continue;
        }
        let id = id_of(m.host_id);
        ids.hosts.insert(id, m.host_id);
        ids.host_of_chain.insert(m.host_id, id);
        let home = frontier_abi::addr::split_host_id(m.host_id)
            .map(|h| hold_id(h.province, h.site))
            .unwrap_or(NONE);
        let (owner, faction) = holds
            .get(&home)
            .map(|x| (x.owner, x.faction))
            .unwrap_or((NONE, 7));
        hosts.insert(
            id,
            HostView {
                owner,
                home,
                faction,
                unit: catalog::unit_of(m.unit)
                    .unwrap_or(permutation_rules::units::UnitType::Spearman),
                troops: m.troops,
                state: HostState::Marching { arrive: m.arrive },
                prov: c.index(),
                tile: m.tile,
                mission: m.mission,
                retreat: None,
                chain: Some(m.host_id),
            },
        );
    }
    let next_host = next_id;
    let mut w = World {
        bell: b,
        end_bell: e.end_bell,
        open_ring,
        genesis_ts: e.genesis_ts,
        params: e.params.unwrap_or(Params::FRONTIER_7),
        doctrine: core::array::from_fn(|f| DOCTRINES[f]),
        provs,
        holds,
        hosts,
        agents,
        keep_live,
        msieges,
        call: [NONE; 6],
        next_host,
    };
    w.call = e
        .call
        .unwrap_or_else(|| crate::campaign::herald_call(&w, b - b % 144));
    Ok((w, ids))
}

// ------------------------------------------------------------ helpers

/// The raw site state of every site of the province accounts (the
/// [`crate::cqbehave::SiteStates`] the local checks read: a Seat's
/// reserved sites, the free sites an outpost may take).
pub fn site_states(provinces: &BTreeMap<(i16, i16), Vec<u8>>) -> BTreeMap<(i16, i16, u8), u8> {
    let mut out = BTreeMap::new();
    for (&(p, q), pd) in provinces {
        if pd.len() != P2::SIZE {
            continue;
        }
        for s in 0..(pd[P2::SITE_COUNT] as usize).min(12) {
            out.insert((p, q, s as u8), pd[P2::site(s) + S2::STATE]);
        }
    }
    out
}

/// The roster index (the `entry` of DeclareSiege and RetireHost) of chain
/// host `id` in a Province v2 account.
pub fn entry_index(pd: &[u8], id: u64) -> Option<u8> {
    if pd.len() != P2::SIZE {
        return None;
    }
    (0..P2::ENTRIES_N).find_map(|i| {
        let o = P2::entry(i);
        let st = pd[o + E::STATE];
        ((st == E::STATE_ROSTER || st == E::STATE_MUSTER_PENDING) && u64_at(pd, o + E::ID) == id)
            .then_some(i as u8)
    })
}

/// The Herald's Call of `/h/call/{day}.json` (`{"calls":[{"faction":0,
/// "march":{"m":0,"n":0}|null,"rally":false}…]}`) as the planner's March
/// keys (the March's first member's province index; [`NONE`] none).
pub fn call_of_json(v: &Value) -> Result<[u32; 6], ObsError> {
    let mut call = [crate::campaign::NONE; 6];
    let Some(cs) = v.get("calls").and_then(|c| c.as_array()) else {
        return bad("call: no calls");
    };
    for c in cs {
        let f = c
            .get("faction")
            .and_then(|x| x.as_u64())
            .filter(|&f| f < 6)
            .ok_or_else(|| ObsError("call: faction".into()))? as usize;
        if let Some(m) = c.get("march").filter(|m| !m.is_null()) {
            let (Some(mm), Some(nn)) = (
                m.get("m").and_then(|x| x.as_i64()),
                m.get("n").and_then(|x| x.as_i64()),
            ) else {
                return bad("call: march");
            };
            call[f] = march_members(MarchCoord {
                m: mm as i32,
                n: nn as i32,
            })[0]
                .index();
        }
    }
    Ok(call)
}

/// One event of `/h/conquest/{day}.json` (§8.4).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConquestEvent {
    pub seq: u64,
    pub kind: String,
    pub bell: u32,
    pub p: Option<i16>,
    pub q: Option<i16>,
}

/// The events of a `/h/conquest/{day}.json` body.
pub fn conquest_events(v: &Value) -> Vec<ConquestEvent> {
    let Some(es) = v.get("events").and_then(|e| e.as_array()) else {
        return vec![];
    };
    es.iter()
        .filter_map(|e| {
            let seq = e.get("seq").and_then(|s| {
                s.as_u64()
                    .or_else(|| s.as_str().and_then(|x| x.parse().ok()))
            })?;
            Some(ConquestEvent {
                seq,
                kind: e.get("kind")?.as_str()?.to_string(),
                bell: e.get("bell").and_then(|b| b.as_u64()).unwrap_or(0) as u32,
                p: e.get("p").and_then(|x| x.as_i64()).map(|x| x as i16),
                q: e.get("q").and_then(|x| x.as_i64()).map(|x| x as i16),
            })
        })
        .collect()
}
