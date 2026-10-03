//! A fixed MC herald world for the conquest tests of `frontier-agents` and
//! `frontier-bots` (MC contract v1.3 §8.6, §11 CQ2-F: "personas' expected
//! codes on recorded herald fixtures"; §4.4).
//!
//! **What it is.** The bytes a v2 herald would serve at bell [`BELL`] of a
//! Frontier-7 season (`MC_LOCAL_7D`, end bell [`END_BELL`]): the Province
//! v2 accounts of rings 0–4 (the land is the kernel's
//! `terrain::generate_province`, keeps on `keep_tile_symmetric`, genesis
//! Free Cities), the Citizens v2 and Holdings of a faction-0 fleet of
//! [`FLEET`] bot wallets, and a faction-1 border with one target of every
//! kind §8.6's personas need: a home to occupy, an outpost, a Free City, a
//! heartland home, a shielded home, a besieged holding, a keep in its
//! consolidation, a heartland keep, plus resident hosts on the target
//! hexes (a lead host, a smaller faction-mate, a Scout).
//!
//! **What it is not.** A recording: the v2 herald (CQ2-E) and the v2
//! program (CQ2-A/C) are built in the same wave; CQ3-E records the
//! conquest mini-season. The layout offsets are `frontier-abi`'s, the
//! records and the keep are written with `conquest_model`'s writers, and
//! the readers ([`crate::cqobs::world_from_herald`]) are tested on it.

use std::collections::BTreeMap;

use fclient::abi::layout::{h as hd, holding as lh};
use fclient::abi::magic;
use frontier_abi::conquest_model::{write_keep, write_no_keep, Record};
use frontier_abi::layout::province::entry as E;
use frontier_abi::v2::layout::player::{citizen as C2, holding as H2};
use frontier_abi::v2::layout::province::{conquest as CR, province as P2, site as S2};
use permutation_rules::frontier::geometry::{ring_provinces, ProvinceCoord};
use permutation_rules::frontier::keep::{self as kk, Keep, KeepParams};
use permutation_rules::frontier::terrain::{generate_province, ProvinceTerrain};
use permutation_rules::frontier::travel::BELL_SECS;

use crate::campaign::{Mission, Params};
use crate::cqobs::{hold_id, FleetMarch, FleetWallet, HeraldEpoch};
use crate::profile::Arch;

pub const SEASON_ID: u64 = 8;
pub const GENESIS_TS: i64 = 1_800_000_000;
/// The epoch: hour 50 (day 2), after the 24-h shields of day 0.
pub const BELL: u32 = 300;
pub const END_BELL: u32 = 1_008;
pub const RINGS: u32 = 4;
/// Fleet wallets (faction 0, `Arch::Bot`): agents `0..FLEET`.
pub const FLEET: u32 = 12;
/// A faction-0 fleet wallet whose slots 2 and 3 are full (capture_cap).
pub const FULL_WALLET: u32 = FLEET;
/// The faction-1 wallets the fleet runs too (victims for retire_foreign).
pub const VICTIM: u32 = FLEET + 1;

pub fn ring_seed(d: u32) -> [u8; 32] {
    [d as u8 + 11; 32]
}

/// Seconds of bell `b`.
pub fn ts(b: u32) -> i64 {
    GENESIS_TS + b as i64 * BELL_SECS
}

/// The named sites of the fixture (P, Q, site).
#[derive(Clone, Copy, Debug)]
pub struct Roles {
    /// Faction 1's border province (ring 4, wedge 1) and its keep.
    pub border: (i16, i16),
    /// Faction 0's province next to it (ring 4, wedge 0).
    pub front: (i16, i16),
    pub home: (i16, i16, u8),
    pub outpost: (i16, i16, u8),
    pub free_city: (i16, i16, u8),
    pub heartland: (i16, i16, u8),
    pub shielded: (i16, i16, u8),
    pub besieged: (i16, i16, u8),
    /// A Seat's site (ring 1, wedge 1, reserved).
    pub seat: (i16, i16, u8),
    /// A faction-1 keep inside its consolidation.
    pub consolidating: (i16, i16),
    /// A faction-1 heartland keep (ring 3, wedge 1).
    pub heartland_keep: (i16, i16),
    /// Faction 0's lead host and a smaller faction-mate on `home`'s hex.
    pub lead: u64,
    pub smaller: u64,
    /// A faction-0 Scout on `outpost`'s hex.
    pub scout: u64,
    /// The victim's (faction 1) host of a captured holding's previous
    /// generation, standing on the captor's hex.
    pub victim_host: u64,
    /// The captured holding (faction 0's since bell 280).
    pub captured: (i16, i16, u8),
}

/// The fixture: the epoch's herald inputs and the named roles.
#[derive(Clone, Debug)]
pub struct CqFixture {
    pub epoch: HeraldEpoch,
    pub roles: Roles,
    /// Raw site state per (P, Q, site) (for the oracle's step 3).
    pub site_state: BTreeMap<(i16, i16, u8), u8>,
}

struct Prov {
    pc: ProvinceCoord,
    t: ProvinceTerrain,
    bytes: Vec<u8>,
    entries: usize,
}

fn w8(b: &mut [u8], o: usize, v: u8) {
    b[o] = v;
}
fn w16(b: &mut [u8], o: usize, v: u16) {
    b[o..o + 2].copy_from_slice(&v.to_le_bytes());
}
fn w32(b: &mut [u8], o: usize, v: u32) {
    b[o..o + 4].copy_from_slice(&v.to_le_bytes());
}
fn w64(b: &mut [u8], o: usize, v: u64) {
    b[o..o + 8].copy_from_slice(&v.to_le_bytes());
}
fn wi64(b: &mut [u8], o: usize, v: i64) {
    b[o..o + 8].copy_from_slice(&v.to_le_bytes());
}

fn chained(b: &mut [u8], m: &[u8; 8], seq: u64) {
    b[hd::MAGIC..hd::MAGIC + 8].copy_from_slice(m);
    w64(b, hd::SEASON_ID, SEASON_ID);
    w16(b, hd::LAYOUT_VERSION, 2);
    w64(b, hd::EVENT_SEQ, seq);
}

fn keep_params() -> KeepParams {
    KeepParams {
        bells: 72,
        consolidate_bells: 288,
        home_guard: 100,
        garrison_bps: 5_000,
    }
}

impl Prov {
    fn new(pc: ProvinceCoord) -> Prov {
        let d = pc.ring();
        let t = generate_province(&ring_seed(d), pc);
        let mut b = vec![0u8; P2::SIZE];
        chained(&mut b, magic::PROVINCE, 9);
        w16(&mut b, P2::P, pc.p as u16);
        w16(&mut b, P2::Q, pc.q as u16);
        w16(&mut b, P2::RING, d as u16);
        w8(&mut b, P2::WEDGE, pc.wedge().unwrap_or(0));
        w32(&mut b, P2::RESOLVED_NEXT, BELL);
        for i in 0..61usize {
            w8(&mut b, P2::TERRAIN + i, t.terrain[i] as u8);
        }
        b[P2::SITES..P2::SITES + 12].copy_from_slice(&t.sites);
        w8(&mut b, P2::SITE_COUNT, t.site_count);
        for s in 0..12usize {
            let st = if s >= t.site_count as usize {
                0
            } else if d < 2 {
                S2::STATE_RESERVED
            } else {
                S2::STATE_FREE
            };
            w8(&mut b, P2::site(s) + S2::STATE, st);
        }
        let tile = if d < 2 {
            None
        } else {
            let bytes: [u8; 61] = core::array::from_fn(|i| t.terrain[i] as u8);
            kk::keep_tile_symmetric(&bytes, &t.sites, t.site_count, pc.wedge().unwrap_or(0))
        };
        match tile.and_then(|tile| {
            kk::try_open(pc, pc.wedge().unwrap_or(0), 3, tile, &keep_params(), 0)
                .ok()
                .flatten()
        }) {
            Some(k) => write_keep(&mut b, &k).expect("keep"),
            None => write_no_keep(&mut b).expect("no keep"),
        }
        // A genesis Free City from ring 4 (on the kernel's site).
        if d >= 4 {
            let s = permutation_rules::frontier::terrain::free_city_site(
                &ring_seed(d),
                pc,
                t.site_count,
            );
            let o = P2::site(s as usize);
            w8(&mut b, o + S2::STATE, S2::STATE_FREE_CITY);
            w8(&mut b, o + S2::FACTION, 6);
            w32(&mut b, o + S2::GARRISON, 300_000);
        }
        Prov {
            pc,
            t,
            bytes: b,
            entries: 0,
        }
    }

    fn key(&self) -> (i16, i16) {
        (self.pc.p as i16, self.pc.q as i16)
    }

    fn keep(&self) -> Option<Keep> {
        frontier_abi::conquest_model::read_keep(&self.bytes).expect("keep")
    }

    fn set_keep(&mut self, k: &Keep) {
        write_keep(&mut self.bytes, k).expect("keep");
    }

    /// A free (non-Free-City) site index.
    fn free_site(&self, skip: usize) -> u8 {
        (0..self.t.site_count as usize)
            .filter(|&s| self.bytes[P2::site(s) + S2::STATE] == S2::STATE_FREE)
            .nth(skip)
            .expect("a free site") as u8
    }

    #[allow(clippy::too_many_arguments)]
    fn holding(
        &mut self,
        s: u8,
        faction: u8,
        order: u8,
        tier: u8,
        garrison: u32,
        shield_bell: u32,
        walls: u32,
    ) {
        let o = P2::site(s as usize);
        w8(&mut self.bytes, o + S2::STATE, S2::STATE_HOLDING);
        w8(&mut self.bytes, o + S2::FACTION, faction);
        w8(&mut self.bytes, o + S2::ORDER, order - 1);
        w8(&mut self.bytes, o + S2::TIER, tier);
        w8(&mut self.bytes, o + S2::GEN, 1);
        w16(&mut self.bytes, o + S2::HELD_SINCE_HOUR, 4);
        w32(&mut self.bytes, o + S2::GARRISON, garrison);
        w32(&mut self.bytes, o + S2::WALLS_COMMITTED, walls);
        w32(&mut self.bytes, o + S2::SHIELD_UNTIL_BELL, shield_bell);
        let n = self.bytes[P2::N_SITES_USED];
        w8(&mut self.bytes, P2::N_SITES_USED, n + 1);
    }

    fn record(&mut self, s: u8, r: &Record) {
        r.write(&mut self.bytes, s as usize).expect("record");
    }

    /// A resident host (state 1 from bell `from`).
    fn host(&mut self, id: u64, faction: u8, unit: u8, tile: u8, troops: u32, from: u32) {
        let o = P2::entry(self.entries);
        let b = &mut self.bytes;
        w64(b, o + E::ID, id);
        w8(b, o + E::FACTION, faction);
        w8(b, o + E::UNIT, unit);
        w8(b, o + E::TILE, tile);
        w8(b, o + E::STATE, E::STATE_ROSTER);
        w32(b, o + E::TROOPS, troops);
        w32(b, o + E::FROM_BELL, from);
        w32(b, o + E::READY_BELL, from);
        self.entries += 1;
        w8(b, P2::N_ENTRIES, self.entries as u8);
    }

    fn tile(&self, s: u8) -> u8 {
        self.t.sites[s as usize]
    }
}

fn holding_bytes(
    p: (i16, i16),
    site: u8,
    tile: u8,
    faction: u8,
    order: u8,
    founded_bell: u32,
    gold: i64,
) -> Vec<u8> {
    let mut b = vec![0u8; H2::SIZE];
    chained(&mut b, magic::HOLDING, 5);
    w16(&mut b, H2::P, p.0 as u16);
    w16(&mut b, H2::Q, p.1 as u16);
    w8(&mut b, H2::SITE, site);
    w8(&mut b, H2::GEN, 1);
    w8(&mut b, H2::TILE, tile);
    w8(&mut b, H2::STATE, 1);
    w8(&mut b, H2::FACTION, faction);
    w8(&mut b, H2::ORDER, order);
    w8(&mut b, H2::TIER, 1);
    wi64(&mut b, H2::FOUNDED_TS, ts(founded_bell));
    wi64(&mut b, H2::LAST_OWNER_ACTION, ts(BELL) - 3_600);
    wi64(&mut b, H2::SHIELD_UNTIL, ts(founded_bell + 144));
    for r in 0..8usize {
        let o = lh::STORES + r * lh::ACCRUAL_STRIDE;
        wi64(&mut b, o, gold);
        wi64(&mut b, o + 16, 50_000_000);
        wi64(&mut b, o + 24, ts(BELL) - 60);
    }
    b
}

fn citizen_bytes(faction: u8, slots: u8, sieges_today: u8) -> Vec<u8> {
    let mut b = vec![0u8; C2::SIZE];
    chained(&mut b, magic::CITIZEN, 3);
    w8(&mut b, C2::FACTION, faction);
    w8(&mut b, C2::SLOTS, slots);
    w8(&mut b, C2::SIEGES_TODAY, sieges_today);
    w16(&mut b, C2::SIEGE_DAY, (BELL / 144) as u16);
    // Vigil 02:00–08:00 UTC from genesis.
    w16(&mut b, C2::VIGIL_START_MIN, 120);
    b
}

/// The province of `pc` in `provs`.
fn at(provs: &mut [Prov], pc: ProvinceCoord) -> &mut Prov {
    provs.iter_mut().find(|p| p.pc == pc).expect("province")
}

/// The fixture.
pub fn fixture() -> CqFixture {
    let mut provs: Vec<Prov> = (0..=RINGS)
        .flat_map(ring_provinces)
        .map(Prov::new)
        .collect();
    // A ring-4 border: faction 1's province next to faction 0's.
    let r4 = ring_provinces(4);
    let (front, border) = r4
        .iter()
        .flat_map(|&a| r4.iter().map(move |&b| (a, b)))
        .find(|(a, b)| a.wedge() == Some(0) && b.wedge() == Some(1) && a.distance(*b) == 1)
        .expect("a border");
    let heart = ring_provinces(3)
        .into_iter()
        .filter(|p| p.wedge() == Some(1))
        .min_by_key(|p| p.distance(front))
        .expect("heartland");
    let seat_pc = ring_provinces(1)
        .into_iter()
        .find(|p| p.wedge() == Some(1))
        .expect("seat");
    let near1: Vec<ProvinceCoord> = r4
        .iter()
        .copied()
        .filter(|p| p.wedge() == Some(1) && p.distance(front) <= 2 && *p != border)
        .collect();
    let near0: Vec<ProvinceCoord> = r4
        .iter()
        .copied()
        .chain(ring_provinces(3))
        .filter(|p| p.wedge() == Some(0) && p.distance(border) <= 3)
        .collect();
    // Keeps: holders as opened (their wedge); the border keep consolidated.
    // One faction-1 keep still consolidating (taken at bell 200).
    let cons_pc = near1.first().copied().unwrap_or(border);
    {
        let p = at(&mut provs, cons_pc);
        let mut k = p.keep().expect("ring-4 keep");
        k.holder = 1;
        k.since_bell = 200;
        k.consolidated_until_bell = 200 + 288;
        k.troops = 1_500;
        p.set_keep(&k);
    }
    let mut epoch = HeraldEpoch {
        bell: BELL,
        end_bell: END_BELL,
        genesis_ts: GENESIS_TS,
        params: Some(Params::FRONTIER_7),
        ..Default::default()
    };
    let mut wallets: Vec<FleetWallet> = Vec::new();
    // Faction 0's fleet: homes in front and its neighbours, Town, 4,000
    // troops, 2,000 of every good.
    let mut fleet_homes: Vec<(i16, i16, u8)> = Vec::new();
    for a in 0..FLEET {
        let pc = near0[a as usize % near0.len()];
        let p = at(&mut provs, pc);
        let s = p.free_site(0);
        p.holding(s, 0, 1, 1, 4_000_000, 144, 0);
        let tile = p.tile(s);
        let key = p.key();
        fleet_homes.push((key.0, key.1, s));
        wallets.push(FleetWallet {
            agent: a,
            arch: Arch::Bot,
            faction: 0,
            citizen: Some(citizen_bytes(0, 1, 0)),
            holdings: vec![holding_bytes(key, s, tile, 0, 1, 20, 2_000_000)],
        });
    }
    // The capture_cap wallet: slots 1–3 held.
    {
        let mut hs = vec![];
        for order in 1..=3u8 {
            let pc = near0[(order as usize + 3) % near0.len()];
            let p = at(&mut provs, pc);
            let s = p.free_site(0);
            p.holding(s, 0, order, 1, 2_000_000, 144, 0);
            let tile = p.tile(s);
            hs.push(holding_bytes(p.key(), s, tile, 0, order, 20, 2_000_000));
        }
        wallets.push(FleetWallet {
            agent: FULL_WALLET,
            arch: Arch::Bot,
            faction: 0,
            citizen: Some(citizen_bytes(0, 1, 0)),
            holdings: hs,
        });
    }
    // Faction 1's border.
    let bp = at(&mut provs, border);
    let home_s = bp.free_site(0);
    bp.holding(home_s, 1, 1, 0, 200_000, 144, 0);
    let out_s = bp.free_site(0);
    bp.holding(out_s, 1, 2, 0, 300_000, 20, 0);
    let sieged_s = bp.free_site(0);
    bp.holding(sieged_s, 1, 1, 0, 500_000, 144, 0);
    bp.record(
        sieged_s,
        &Record {
            kind: CR::KIND_SIEGE,
            faction: 0,
            flags: CR::FLAG_HELD,
            required: 36,
            bell: 290,
            ..Record::ZERO
        },
    );
    let shield_s = bp.free_site(0);
    bp.holding(shield_s, 1, 1, 0, 200_000, BELL + 100, 0);
    let border_key = bp.key();
    let home_tile = bp.tile(home_s);
    let out_tile = bp.tile(out_s);
    let fc_site = (0..12u8)
        .find(|&s| bp.bytes[P2::site(s as usize) + S2::STATE] == S2::STATE_FREE_CITY)
        .expect("a Free City at ring 4");
    // Faction 0's lead host and a smaller one on the home's hex; a Scout
    // on the outpost's hex. Host ids name the fleet's homes.
    let host_of = |k: (i16, i16, u8), seq: u32| -> u64 {
        frontier_abi::addr::host_id(k.0 as i32, k.1 as i32, k.2, 1, seq).expect("host id")
    };
    let lead = host_of(fleet_homes[0], 1);
    let smaller = host_of(fleet_homes[1], 1);
    let scout = host_of(fleet_homes[2], 1);
    bp.host(lead, 0, 0, home_tile, 2_000_000, BELL - 6);
    bp.host(smaller, 0, 0, home_tile, 500_000, BELL - 6);
    bp.host(scout, 0, crate::policy::SCOUT, out_tile, 100_000, BELL - 6);
    // The heartland home and a host of faction 0 on it.
    let hp = at(&mut provs, heart);
    let heart_s = hp.free_site(0);
    hp.holding(heart_s, 1, 1, 0, 200_000, 144, 0);
    let heart_tile = hp.tile(heart_s);
    let heart_key = hp.key();
    hp.host(
        host_of(fleet_homes[3], 1),
        0,
        0,
        heart_tile,
        1_000_000,
        BELL - 6,
    );
    // The shielded home: a host of faction 0 on it.
    {
        let bp = at(&mut provs, border);
        let t = bp.tile(shield_s);
        bp.host(host_of(fleet_homes[4], 1), 0, 0, t, 1_000_000, BELL - 6);
        // The capture_cap wallet's host on the outpost's hex.
        let full_home = {
            let h = &wallets[FULL_WALLET as usize].holdings[0];
            (
                i16::from_le_bytes([h[H2::P], h[H2::P + 1]]),
                i16::from_le_bytes([h[H2::Q], h[H2::Q + 1]]),
                h[H2::SITE],
            )
        };
        bp.host(host_of(full_home, 1), 0, 0, out_tile, 1_500_000, BELL - 6);
        // A host on the besieged holding's hex.
        let st = bp.tile(sieged_s);
        bp.host(host_of(fleet_homes[5], 1), 0, 0, st, 1_200_000, BELL - 6);
        // A host on the Free City's hex.
        let ft = bp.tile(fc_site);
        bp.host(host_of(fleet_homes[6], 1), 0, 0, ft, 1_200_000, BELL - 6);
    }
    // A captured holding: faction 0 took a faction-1 outpost in the front
    // province at bell 280 (gen 2); the victim's previous-generation host
    // still stands on the captor's home hex.
    let fp = at(&mut provs, front);
    let cap_s = fp.free_site(0);
    fp.holding(cap_s, 0, 2, 0, 0, 0, 0);
    w8(&mut fp.bytes, P2::site(cap_s as usize) + S2::GEN, 2);
    let front_key = fp.key();
    let victim_host =
        frontier_abi::addr::host_id(front_key.0 as i32, front_key.1 as i32, cap_s, 1, 3)
            .expect("host id");
    let captor_tile = fp.tile(fp.free_site(0));
    fp.host(victim_host, 1, 0, captor_tile, 800_000, BELL - 30);
    // The victim (faction 1), run by the fleet too: its home in the border.
    {
        let bp = at(&mut provs, border);
        let s = bp.free_site(0);
        bp.holding(s, 1, 1, 0, 300_000, 144, 0);
        let tile = bp.tile(s);
        wallets.push(FleetWallet {
            agent: VICTIM,
            arch: Arch::Bot,
            faction: 1,
            citizen: Some(citizen_bytes(1, 1, 0)),
            holdings: vec![holding_bytes(border_key, s, tile, 1, 1, 20, 2_000_000)],
        });
    }
    let heart_keep = ring_provinces(3)
        .into_iter()
        .find(|p| p.wedge() == Some(1) && p.distance(front) <= 3)
        .unwrap_or(heart);
    let mut site_state = BTreeMap::new();
    for p in &provs {
        for s in 0..12u8 {
            site_state.insert(
                (p.pc.p as i16, p.pc.q as i16, s),
                p.bytes[P2::site(s as usize) + S2::STATE],
            );
        }
        epoch
            .provinces
            .insert((p.pc.p as i16, p.pc.q as i16), p.bytes.clone());
    }
    epoch.wallets = wallets;
    epoch
        .missions
        .insert(lead, Mission::Siege(hold_id(border, home_s)));
    epoch.marches.push(FleetMarch {
        host_id: host_of(fleet_homes[7], 1),
        dest: border_key,
        tile: home_tile,
        arrive: BELL + 3,
        troops: 700_000,
        unit: 0,
        mission: Mission::Rally(hold_id(border, home_s)),
    });
    CqFixture {
        epoch,
        roles: Roles {
            border: border_key,
            front: front_key,
            home: (border_key.0, border_key.1, home_s),
            outpost: (border_key.0, border_key.1, out_s),
            free_city: (border_key.0, border_key.1, fc_site),
            heartland: (heart_key.0, heart_key.1, heart_s),
            shielded: (border_key.0, border_key.1, shield_s),
            besieged: (border_key.0, border_key.1, sieged_s),
            seat: (seat_pc.p as i16, seat_pc.q as i16, 0),
            consolidating: (cons_pc.p as i16, cons_pc.q as i16),
            heartland_keep: (heart_keep.p as i16, heart_keep.q as i16),
            lead,
            smaller,
            scout,
            victim_host,
            captured: (front_key.0, front_key.1, cap_s),
        },
        site_state,
    }
}
