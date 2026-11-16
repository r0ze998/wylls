//! **Land preview (opt-in feature `land-preview`)**: the bytes of the land
//! rule (`permutation_rules::frontier::land`, "Standing Ground" in reduced
//! form) and its reading of a real v2 Province.
//!
//! Off by default: with the feature off nothing here is compiled, so the
//! program, the vectors and every hash are built exactly as before. With it
//! on, nothing is written to any existing account either: the land lives
//! in its own record ([`land`], 256 bytes), never inside the Province (the
//! v2 Province has no free room: its last 4 reserved bytes are not enough).
//!
//! What the fold reads, all of it from the Province's own bytes:
//! * the sites (`SITES`, `SITE_COUNT`) and the site mirror (`STATE ==
//!   HOLDING`, `FACTION`, `TIER`): village land, which a SettleCapture
//!   (mirror faction flipped) carries to the captor;
//! * the roster (`ENTRIES`: state roster, no pending order, a fighting
//!   unit, troops, `FROM_BELL`): who stands where, since when;
//! * the keep (`KEEP`: tile and holder): a foothold for its holder;
//! * `PASSABLE_MASK`.
//!
//! The heartland (where strangers do nothing) is a season fact the caller
//! passes, as the keep's `heartland_safe` flag is set at opening.

use alloc::vec::Vec;

use crate::bytes::{rd_i16, rd_u16, rd_u32, rd_u64, wr_i16, wr_u16, wr_u32, wr_u64};
use crate::entry::{read_entry, EntryOp};
use crate::layout::province::entry as E;
use crate::v2::layout::province::{keep as KP, province as P, site as SM};
use permutation_rules::frontier::geometry::{locate, ProvinceCoord};
use permutation_rules::frontier::holding::{Tier, RESOURCES};
use permutation_rules::frontier::land::{
    self as kland, BellIn, Changes, HostIn, Land, LandError, LandParams, SiteIn,
};

/// Unit codes that never claim (`entry::UNITS`: Scout 6, Settler 7).
const UNIT_SCOUT: u8 = 6;
const UNIT_SETTLER: u8 = 7;
const TILES: usize = 61;

/// The land record (272 B), one per opened province: the program's short
/// header (magic, season id), so readers that filter accounts by season
/// (the herald) take it like any other account of the season.
pub mod land {
    /// `b"PSFLAND1"`.
    pub const MAGIC: [u8; 8] = *b"PSFLAND1";
    pub const MAGIC_AT: usize = 0;
    pub const SEASON_ID: usize = 8;
    pub const VERSION: usize = 16;
    pub const NEXT_BELL: usize = 20;
    pub const VILLAGE: usize = 24;
    pub const P: usize = 32;
    pub const Q: usize = 34;
    pub const OWNER: usize = 36;
    pub const BY: usize = OWNER + 61;
    pub const COUNT: usize = BY + 61;
    /// `[u32; 12]`: per site, the bell up to which its land yield was paid.
    pub const YIELD_BELL: usize = COUNT + 61;
    pub const SIZE: usize = 272;
    const _: () = assert!(YIELD_BELL + 48 <= SIZE);
}

/// The header fields of a land record: season id, province, and per site
/// the bell its land yield is paid up to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LandHeader {
    pub season_id: u64,
    pub p: i16,
    pub q: i16,
    pub yield_bell: [u32; 12],
}

/// Reads a land record's header.
pub fn read_header(d: &[u8]) -> Result<LandHeader, LandBytesError> {
    let d = d.get(..land::SIZE).ok_or(LandBytesError::Bad)?;
    if d[..8] != land::MAGIC {
        return Err(LandBytesError::Bad);
    }
    let mut yield_bell = [0u32; 12];
    for (i, y) in yield_bell.iter_mut().enumerate() {
        *y = rd_u32(d, land::YIELD_BELL + 4 * i).ok_or(LandBytesError::Bad)?;
    }
    Ok(LandHeader {
        season_id: rd_u64(d, land::SEASON_ID).ok_or(LandBytesError::Bad)?,
        p: rd_i16(d, land::P).ok_or(LandBytesError::Bad)?,
        q: rd_i16(d, land::Q).ok_or(LandBytesError::Bad)?,
        yield_bell,
    })
}

/// Writes a land record's header (magic, season id, province, yield bells).
pub fn write_header(d: &mut [u8], h: &LandHeader) -> Result<(), LandBytesError> {
    let d = d.get_mut(..land::SIZE).ok_or(LandBytesError::Bad)?;
    d[..8].copy_from_slice(&land::MAGIC);
    let mut ok = wr_u64(d, land::SEASON_ID, h.season_id) && wr_i16(d, land::P, h.p) && wr_i16(d, land::Q, h.q);
    for (i, y) in h.yield_bell.iter().enumerate() {
        ok &= wr_u32(d, land::YIELD_BELL + 4 * i, *y);
    }
    ok.then_some(()).ok_or(LandBytesError::Bad)
}

// ------------------------------------------------------------ instructions

/// FoldLand (PROVISIONAL, not allocated: 0xCD, in the range ABI-ALLOCATION
/// rev 6 lists as free, 0xCD–0xCF, used by no branch on 2026-11-15; the
/// integrator, workstream 4, allocates tags): anyone folds the bells a Province
/// has resolved into its land record (created on the first fold, paid by
/// the fee payer). Data: `[tag, max_bells u8]`. Accounts:
/// `[fee_payer s,w] [season] [province] [land w] [system]` then up to six
/// neighbouring land records (read only; absent ones may be omitted).
pub const TAG_FOLD_LAND: u8 = 0xCD;
/// ClaimLandYield (PROVISIONAL 0xCE): anyone pays a holding its land yield up to the
/// land record's folded bell. Data: `[tag]`. Accounts:
/// `[fee_payer s,w] [season] [province] [land w] [holding w]`.
pub const TAG_CLAIM_LAND_YIELD: u8 = 0xCE;
/// The most bells one FoldLand folds.
pub const MAX_FOLD_BELLS: u8 = 8;
/// The fixed accounts of FoldLand before the neighbours.
pub const FOLD_FIXED: usize = 5;
/// Bells per hour (a bell is 600 s).
pub const BELLS_PER_HOUR: i64 = 6;

/// Is `t` one of the land preview's tags?
pub const fn is_land_tag(t: u8) -> bool {
    t == TAG_FOLD_LAND || t == TAG_CLAIM_LAND_YIELD
}

/// The land record's seed tag.
pub const SEED_TAG: [u8; 2] = *b"ld";

/// `ld‖hex(le16 p ‖ le16 q)`.
pub fn land_seed(p: i16, q: i16) -> crate::addr::Seed {
    let mut r = [0u8; 4];
    r[..2].copy_from_slice(&p.to_le_bytes());
    r[2..].copy_from_slice(&q.to_le_bytes());
    crate::addr::Seed::new(SEED_TAG, &r)
}

/// The land record of province `(p, q)`.
pub fn land_address(ctx: &crate::addr::AddrCtx, p: i16, q: i16) -> [u8; 32] {
    ctx.of(&land_seed(p, q))
}

/// The yield of one holding for `bells` bells: its production per hour
/// (milli) times `bonus_bps`, entry by entry, rounded down.
pub fn yield_for(production: [i64; RESOURCES], bonus_bps: u32, bells: u32) -> [i64; RESOURCES] {
    production.map(|v| {
        (v.max(0) as i128 * bonus_bps as i128 * bells as i128 / (10_000 * BELLS_PER_HOUR as i128)) as i64
    })
}

/// The heartland a v2 Province lies in, as its keep records it (the keep's
/// `heartland_safe` flag, set at opening): `Some(holder)`, else `None`.
pub fn heartland_of(pd: &[u8]) -> Option<u8> {
    let kd = pd.get(P::KEEP..P::KEEP + KP::SIZE)?;
    (kd[KP::TILE] != KP::NO_TILE && kd[KP::FLAGS] & KP::FLAG_HEARTLAND_SAFE != 0 && kd[KP::HOLDER] <= 5)
        .then_some(kd[KP::HOLDER])
}

/// Why a land operation was refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LandBytesError {
    /// A record or the Province is too short, or the magic is wrong.
    Bad,
    /// The kernel refused (bell out of order, input out of range).
    Kernel(LandError),
}

fn tier_of(v: u8) -> Option<Tier> {
    [Tier::Hamlet, Tier::Town, Tier::City, Tier::Stronghold].get(v as usize).copied()
}

/// Decodes a land record.
pub fn read_land(d: &[u8]) -> Result<Land, LandBytesError> {
    let d = d.get(..land::SIZE).ok_or(LandBytesError::Bad)?;
    if d[..8] != land::MAGIC || rd_u16(d, land::VERSION) != Some(kland::LAND_VERSION) {
        return Err(LandBytesError::Bad);
    }
    let mut l = Land::new(rd_u32(d, land::NEXT_BELL).ok_or(LandBytesError::Bad)?);
    l.village = rd_u64(d, land::VILLAGE).ok_or(LandBytesError::Bad)?;
    l.owner.copy_from_slice(&d[land::OWNER..land::OWNER + TILES]);
    l.by.copy_from_slice(&d[land::BY..land::BY + TILES]);
    l.count.copy_from_slice(&d[land::COUNT..land::COUNT + TILES]);
    Ok(l)
}

/// Encodes a land record's land (the header — magic, season, province,
/// yield bells — is left as it is; the magic is written).
pub fn write_land(d: &mut [u8], l: &Land) -> Result<(), LandBytesError> {
    let d = d.get_mut(..land::SIZE).ok_or(LandBytesError::Bad)?;
    d[..8].copy_from_slice(&land::MAGIC);
    let ok = wr_u16(d, land::VERSION, kland::LAND_VERSION)
        && wr_u32(d, land::NEXT_BELL, l.next_bell)
        && wr_u64(d, land::VILLAGE, l.village);
    if !ok {
        return Err(LandBytesError::Bad);
    }
    d[land::OWNER..land::OWNER + TILES].copy_from_slice(&l.owner);
    d[land::BY..land::BY + TILES].copy_from_slice(&l.by);
    d[land::COUNT..land::COUNT + TILES].copy_from_slice(&l.count);
    Ok(())
}

/// The fold's inputs read from a v2 Province.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProvinceInputs {
    pub sites: [SiteIn; 12],
    pub hosts: Vec<HostIn>,
    pub keep: Option<(u8, u8)>,
    pub passable: u64,
}

/// Reads the sites, the standing roster, the keep and the passable mask of
/// a v2 Province (`pd`, at least `P::SIZE` bytes).
pub fn province_inputs(pd: &[u8]) -> Result<ProvinceInputs, LandBytesError> {
    if pd.len() < P::SIZE {
        return Err(LandBytesError::Bad);
    }
    let mut sites = [SiteIn::NONE; 12];
    let n = (pd[P::SITE_COUNT] as usize).min(P::SITES_N);
    for (s, slot) in sites.iter_mut().enumerate().take(n) {
        let tile = pd[P::SITES + s];
        let o = P::site(s);
        let holding = (pd[o + SM::STATE] == SM::STATE_HOLDING && pd[o + SM::FACTION] <= 5)
            .then(|| tier_of(pd[o + SM::TIER]).map(|t| (pd[o + SM::FACTION], t)))
            .flatten();
        *slot = SiteIn { tile, holding };
    }
    let mut hosts = Vec::new();
    for i in 0..P::ENTRIES_N {
        let e = read_entry(pd, i).map_err(|_| LandBytesError::Bad)?;
        if e.state == E::STATE_FREE || e.state == E::STATE_DEPARTED {
            continue;
        }
        hosts.push(HostIn {
            id: e.id,
            faction: e.faction,
            tile: e.tile,
            troops: e.troops,
            fights: e.unit != UNIT_SCOUT && e.unit != UNIT_SETTLER,
            resident: e.state == E::STATE_ROSTER && e.op == EntryOp::None,
            from_bell: e.from_bell,
        });
    }
    let kd = pd.get(P::KEEP..P::KEEP + KP::SIZE).ok_or(LandBytesError::Bad)?;
    let keep = (kd[KP::TILE] != KP::NO_TILE && kd[KP::HOLDER] <= 5).then_some((kd[KP::TILE], kd[KP::HOLDER]));
    let passable = rd_u64(pd, P::PASSABLE_MASK).ok_or(LandBytesError::Bad)?;
    Ok(ProvinceInputs { sites, hosts, keep, passable })
}

/// The coordinates of a v2 Province (`P`, `Q`).
pub fn province_coord(pd: &[u8]) -> Result<ProvinceCoord, LandBytesError> {
    let p = rd_i16(pd, P::P).ok_or(LandBytesError::Bad)?;
    let q = rd_i16(pd, P::Q).ok_or(LandBytesError::Bad)?;
    Ok(ProvinceCoord::new(p as i32, q as i32))
}

/// `outside[f]` of the province at `pc`: bit `t` set when tile `t` touches,
/// across the province's border, a tile of nation `f` in one of the land
/// records `next` (each `(coord, record)`; an absent or blank record holds
/// nothing). Records of provinces that are not neighbours are ignored.
pub fn outside_masks(pc: ProvinceCoord, next: &[(ProvinceCoord, &[u8])]) -> Result<[u64; 6], LandBytesError> {
    let mut lands: Vec<(ProvinceCoord, Land)> = Vec::new();
    for (c, d) in next {
        if *c == pc || !pc.neighbors().contains(c) {
            continue;
        }
        if d.get(..land::SIZE).is_some_and(|b| rd_u16(b, land::VERSION) == Some(0)) {
            continue;
        }
        lands.push((*c, read_land(d)?));
    }
    let mut out = [0u64; 6];
    for t in 0..TILES as u8 {
        let Some(h) = pc.tile(t) else { continue };
        for n in h.neighbors() {
            let (c, j) = locate(n);
            if c == pc {
                continue;
            }
            if let Some((_, l)) = lands.iter().find(|(lc, _)| *lc == c) {
                let o = l.owner[j as usize];
                if o <= 5 {
                    out[o as usize] |= 1 << t;
                }
            }
        }
    }
    Ok(out)
}

/// Folds bell `bell` of the Province `pd` into the land record `ld`
/// (its land begun at `bell` when the record has no land yet: magic and
/// header written, version 0), with the land records of
/// neighbouring provinces `next` (read only). Writes `ld` only on success.
pub fn fold_province(
    pd: &[u8],
    ld: &mut [u8],
    next: &[(ProvinceCoord, &[u8])],
    bell: u32,
    heartland_of: Option<u8>,
    p: &LandParams,
) -> Result<Changes, LandBytesError> {
    let d = ld.get(..land::SIZE).ok_or(LandBytesError::Bad)?;
    let fresh = rd_u16(d, land::VERSION) == Some(0);
    let mut l = if fresh { Land::new(bell) } else { read_land(ld)? };
    let x = province_inputs(pd)?;
    if !fresh || d[..8] == land::MAGIC {
        let h = read_header(ld)?;
        let pc = province_coord(pd)?;
        if (h.p as i32, h.q as i32) != (pc.p, pc.q) {
            return Err(LandBytesError::Bad);
        }
    }
    let outside = outside_masks(province_coord(pd)?, next)?;
    let ch = l
        .fold(bell, &BellIn { sites: &x.sites, hosts: &x.hosts, keep: x.keep, passable: x.passable, heartland_of, outside }, p)
        .map_err(LandBytesError::Kernel)?;
    write_land(ld, &l)?;
    if fresh {
        let pc = province_coord(pd)?;
        let ok = wr_i16(ld, land::P, pc.p as i16) && wr_i16(ld, land::Q, pc.q as i16);
        ok.then_some(()).ok_or(LandBytesError::Bad)?;
    }
    Ok(ch)
}

/// The production per hour of a holding of nation `faction` in the
/// Province `pd` with the land `ld` (`base`: its tier's base production).
pub fn production_with_land(
    pd: &[u8],
    ld: &[u8],
    faction: u8,
    base: [i64; RESOURCES],
    p: &LandParams,
) -> Result<[i64; RESOURCES], LandBytesError> {
    let l = read_land(ld)?;
    let x = province_inputs(pd)?;
    Ok(kland::production_with_land(base, kland::bonus_bps(&l, &x.sites, faction, p)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::entry::{write_entry, Entry};
    use permutation_rules::frontier::catalog;
    use permutation_rules::frontier::geometry::tile_index;
    use permutation_rules::hex::Hex;

    const PRM: LandParams = LandParams::TEST;

    fn t(q: i32, r: i32) -> u8 {
        tile_index(Hex::new(q, r)).unwrap()
    }
    fn host(id: u64, faction: u8, unit: u8, tile: u8, from: u32) -> Entry {
        Entry { id, faction, unit, tile, state: E::STATE_ROSTER, troops: 600_000, from_bell: from, ..Entry::FREE }
    }
    /// A v2 Province: one Hamlet of nation 1 at (−3,0), a keep of nation 1 at (0,−3), all passable.
    fn province() -> std::vec::Vec<u8> {
        let mut pd = std::vec![0u8; P::SIZE];
        pd[P::SITE_COUNT] = 2;
        pd[P::SITES] = t(-3, 0);
        pd[P::SITES + 1] = t(3, -1);
        pd[P::site(0) + SM::STATE] = SM::STATE_HOLDING;
        pd[P::site(0) + SM::FACTION] = 1;
        pd[P::site(0) + SM::TIER] = 0;
        pd[P::KEEP + KP::TILE] = t(0, -3);
        pd[P::KEEP + KP::HOLDER] = 1;
        wr_u64(&mut pd, P::PASSABLE_MASK, (1u64 << 61) - 1);
        pd
    }

    #[test]
    fn the_record_round_trips_and_refuses_a_bad_magic() {
        let mut l = Land::new(42);
        l.owner[3] = 2;
        l.village = 0b1011;
        l.by[5] = 4;
        l.count[5] = 9;
        let mut d = [0u8; land::SIZE];
        write_land(&mut d, &l).unwrap();
        assert_eq!(read_land(&d).unwrap(), l);
        d[0] ^= 1;
        assert_eq!(read_land(&d), Err(LandBytesError::Bad));
    }

    #[test]
    fn reads_the_real_province_fields() {
        let mut pd = province();
        write_entry(&mut pd, 0, &host(10, 1, 0, t(-1, 0), 4)).unwrap();
        write_entry(&mut pd, 1, &host(11, 2, 6, t(1, 0), 4)).unwrap(); // a Scout
        let mut busy = host(12, 2, 0, t(2, 0), 4);
        busy.op = EntryOp::Leave;
        write_entry(&mut pd, 2, &busy).unwrap();
        let x = province_inputs(&pd).unwrap();
        assert_eq!(x.sites[0], SiteIn { tile: t(-3, 0), holding: Some((1, Tier::Hamlet)) });
        assert_eq!(x.sites[1], SiteIn { tile: t(3, -1), holding: None });
        assert_eq!(x.keep, Some((t(0, -3), 1)));
        assert_eq!(x.hosts.len(), 3);
        assert!(x.hosts[0].fights && x.hosts[0].resident);
        assert!(!x.hosts[1].fights);
        assert!(!x.hosts[2].resident);
    }

    #[test]
    fn march_stand_claim_then_lose_to_a_hostile_host_then_production_follows() {
        let mut pd = province();
        let mut ld = [0u8; land::SIZE];
        // bell 0: only the village
        fold_province(&pd, &mut ld, &[], 0, None, &PRM).unwrap();
        let l = read_land(&ld).unwrap();
        assert_eq!(l.tiles_of(1), 7);
        let base = catalog::base_production(Tier::Hamlet);
        assert_eq!(production_with_land(&pd, &ld, 1, base, &PRM).unwrap(), base, "no claimed land: base only");
        // nation 1's host arrives at the land's edge at bell 1 and stands
        write_entry(&mut pd, 0, &host(10, 1, 0, t(-1, 0), 1)).unwrap();
        for b in 1..=3 {
            fold_province(&pd, &mut ld, &[], b, None, &PRM).unwrap();
        }
        let l = read_land(&ld).unwrap();
        let claimed = l.claimed_of(1);
        assert!(claimed >= 5, "{claimed}");
        let with = production_with_land(&pd, &ld, 1, base, &PRM).unwrap();
        assert!(with[0] > base[0], "land pays: {} > {}", with[0], base[0]);
        // it marches home; a host of nation 2 stands on the claimed land
        write_entry(&mut pd, 0, &host(10, 1, 0, t(-3, 0), 4)).unwrap();
        write_entry(&mut pd, 1, &host(20, 2, 0, t(0, 0), 4)).unwrap();
        let mut seized = 0;
        for b in 4..=8 {
            seized += fold_province(&pd, &mut ld, &[], b, None, &PRM).unwrap().seized;
        }
        let l = read_land(&ld).unwrap();
        assert!(seized >= 1);
        assert_eq!(l.owner[t(0, 0) as usize], 2);
        assert!(l.claimed_of(1) < claimed);
        let after = production_with_land(&pd, &ld, 1, base, &PRM).unwrap();
        assert!(after[0] < with[0], "losing land costs production: {} < {}", after[0], with[0]);
        // nation 2 has no village here: its land pays nothing in goods
        assert_eq!(production_with_land(&pd, &ld, 2, base, &PRM).unwrap(), base);
    }

    #[test]
    fn a_settle_capture_carries_the_village_land() {
        let mut pd = province();
        let mut ld = [0u8; land::SIZE];
        fold_province(&pd, &mut ld, &[], 0, None, &PRM).unwrap();
        pd[P::site(0) + SM::FACTION] = 3; // the mirror as SettleCapture leaves it
        fold_province(&pd, &mut ld, &[], 1, None, &PRM).unwrap();
        let l = read_land(&ld).unwrap();
        assert_eq!(l.tiles_of(1), 0);
        assert_eq!(l.tiles_of(3), 7);
    }

    #[test]
    fn a_neighbour_record_lets_land_cross_the_border() {
        let pc = ProvinceCoord::new(3, -1);
        // the province on the far side of our edge tile (4,0) holds its tiles next to it
        let our = pc.tile(t(4, 0)).unwrap();
        let east = our.neighbors().into_iter().map(|n| locate(n).0).find(|c| *c != pc).unwrap();
        assert!(pc.neighbors().contains(&east));
        let mut next_land = Land::new(0);
        for n in our.neighbors() {
            let (c, j) = locate(n);
            if c == east {
                next_land.owner[j as usize] = 2;
            }
        }
        let mut rec = [0u8; land::SIZE];
        write_land(&mut rec, &next_land).unwrap();
        let m = outside_masks(pc, &[(east, &rec)]).unwrap();
        assert!(m[2] >> t(4, 0) & 1 == 1);
        assert_eq!(m[1], 0);
        // a record of a province that is not a neighbour is ignored
        let far = ProvinceCoord::new(30, 0);
        assert_eq!(outside_masks(pc, &[(far, &rec)]).unwrap(), [0; 6]);
        // through the Province: a host of nation 2 standing at (4,0) claims
        let mut pd = province();
        crate::bytes::wr_i16(&mut pd, P::P, 3);
        crate::bytes::wr_i16(&mut pd, P::Q, -1);
        write_entry(&mut pd, 0, &host(30, 2, 0, t(4, 0), 0)).unwrap();
        let mut ld = [0u8; land::SIZE];
        for b in 0..4 {
            fold_province(&pd, &mut ld, &[(east, &rec)], b, None, &PRM).unwrap();
        }
        assert!(read_land(&ld).unwrap().tiles_of(2) >= 3);
    }

    #[test]
    fn yield_is_production_times_bonus_per_bell() {
        let base = catalog::base_production(Tier::Hamlet);
        let y = yield_for(base, 1_200, 6);
        for r in 0..RESOURCES {
            assert_eq!(y[r], base[r] * 1_200 / 10_000, "six bells = one hour");
        }
        assert_eq!(yield_for(base, 0, 100), [0; RESOURCES]);
        assert_eq!(yield_for(base, 3_000, 0), [0; RESOURCES]);
    }

    #[test]
    fn the_heartland_is_read_from_the_keep() {
        let mut pd = province();
        assert_eq!(heartland_of(&pd), None);
        pd[P::KEEP + KP::FLAGS] = KP::FLAG_HEARTLAND_SAFE;
        assert_eq!(heartland_of(&pd), Some(1));
        assert!(is_land_tag(0xCD) && is_land_tag(0xCE) && !is_land_tag(0xCC) && !is_land_tag(0xCF));
        // outside every band in use: v2 tags (to 0xCC), the resident band 0xE0–0xE7, the wide drafts 0xD6–0xDF and 0xEE
        assert!(!crate::resident_wire::is_resident_tag(0xCD) && !crate::resident_wire::is_resident_tag(0xCE));
        assert!(crate::v2::ix::tag_of(&[0xCD]).is_err() && crate::v2::ix::tag_of(&[0xCE]).is_err());
    }

    /// Tag audit (2026-11-16): the land preview's provisional tags against every first-byte band the program routes
    /// before the v2 table and the v2 table itself, over all 256 byte values. Workstream 09's capacity band and the
    /// wide draft band (+ reveal) exist only under their own features: run with `land-preview,capacity-preview,
    /// world-index-experimental` to compare them too. (Workstream 20's band is the assertion above, unchanged.)
    #[test]
    fn the_land_tags_collide_with_no_routed_band() {
        assert_eq!((0..=255u8).filter(|t| is_land_tag(*t)).count(), 2);
        for t in [TAG_FOLD_LAND, TAG_CLAIM_LAND_YIELD] {
            assert!(is_land_tag(t));
            assert!(crate::v2::ix::tag_of(&[t]).is_err(), "v2 table: {t:#x}");
            assert!(crate::v2::Ix::ALL.iter().all(|ix| ix.tag() != t), "v2 Ix::ALL: {t:#x}");
            assert!(!crate::v2::rights::is_rights_tag(t), "rights band: {t:#x}");
            #[cfg(feature = "capacity-preview")]
            assert!(!crate::capacity::is_capacity_tag(t), "capacity band: {t:#x}");
            #[cfg(feature = "world-index-experimental")]
            assert!(!crate::world_index::wide_ix::is_draft_tag(t), "wide draft band: {t:#x}");
        }
    }

    #[test]
    fn a_refused_fold_leaves_the_record_unchanged() {
        let pd = province();
        let mut ld = [0u8; land::SIZE];
        fold_province(&pd, &mut ld, &[], 5, None, &PRM).unwrap();
        let before = ld;
        assert_eq!(fold_province(&pd, &mut ld, &[], 9, None, &PRM), Err(LandBytesError::Kernel(LandError::OutOfOrder)));
        assert_eq!(ld, before);
    }
}
